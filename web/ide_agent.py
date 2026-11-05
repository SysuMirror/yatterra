"""IDE AI 助手 harness(移植自 opencode 的 agent loop,轻量化)。

替代 ai_service.stream_agent 在 page='pod_ide' 上的通用循环,关键差异:

  - 循环预算: max_iterations 64(原 32),wall clock 默认 3600s(可 env 调);
  - /goal 目标模式: 问题以 "/goal " 开头时,模型每次停下都做完成度核查,
    未完成继续推进,确认完成(回复 GOAL_DONE)才结束;
    目标按会话落盘(.ide_agent_goals/<user>/<session>.json, 每会话只留最新一个),
    平台启动时自动重新拉起复核, 完成后删除; "/goal off" 可手动取消;
  - auto 权限模式(all/smart/none): 前端可切换确认策略——全部确认 /
    仅破坏性命令(rm/强推/卸载等)确认(edit 自动写入) / 全自动;
  - 工具面针对"在 Pod 家目录里改代码"重做:
      pod_bash  在 Pod 内以 cloud 执行命令(白名单只读自动放行,
                其余弹卡确认,支持"本次会话总是允许");输出增量
                流式回传(bash_output 事件,opencode bash.ts 风格);
      read      行号化读文件(叠加未落盘的暂存修改),找不到时给
                相似文件名建议(opencode read.ts 风格);
      edit      精确替换 + 模糊级联(行尾空白/块锚点/空白归一化,
                opencode edit.ts 的 replace 级联的轻量移植),
                空 old_string = 创建/覆盖,支持 replace_all;
                每次修改立即弹 diff 卡,用户当场接受(立即落盘)
                或拒绝(丢弃并回告模型)——对齐 opencode 的
                Permission.ask("edit") 即时确认流;
      grep/glob/list_dir  项目内检索(宿主侧 hostPath,路径 jail);
  - 会话连续性: 完整消息历史(含工具结果)按 session_id 落盘,
    追问时整段重载,不再只回放问答文本;
  - 坏工具调用不崩: 未知工具/参数错误作为错误结果回给模型自修;
  - doom-loop 守卫: 相同工具+参数连续 3 次直接拒绝;
  - 上下文两级管理: 旧 tool 输出机械裁剪(保最近 8 条),超限才裁。

事件流与 page_ai_runs 兼容(kind/data 二元组),新增事件类型:
  bash_confirm / edit_confirm / bash_output —— 前端 AiPanel 渲染对应卡片,
  结果仍走 POST /api/ai/page/action_result 的 rendezvous 槽。
"""
import difflib
import json
import os
import re
import shlex
import subprocess
import threading
import time
import uuid

import agent
import groups

# ── 预算 ────────────────────────────────────────────────────────
MAX_ITERATIONS = int(os.environ.get("YATTERRA_IDE_AGENT_MAX_ITER", "64"))
MAX_WALL = int(os.environ.get("YATTERRA_IDE_AGENT_MAX_WALL", "3600"))
GOAL_MAX_CHECKS = 6          # /goal 模式: 完成度核查最多轮数(防无限 ping-pong)
SUBAGENT_MAX_ITER = 12       # 子代理: 工具轮次上限
SUBAGENT_WALL = 300          # 子代理: wall clock 上限(秒)
SUBAGENT_SEM = None          # 子代理并发信号量(惰性建, 见 _subagent_sem)

# 轮内可并行执行的工具: 纯只读 + spawn_agent(子代理内部也只读)。
# pod_bash/edit 会弹用户确认卡(run.action_result 单槽 rendezvous),必须串行。
_PARALLEL_TOOLS = {"read", "grep", "glob", "list_dir", "spawn_agent"}


def _subagent_sem():
    global SUBAGENT_SEM
    if SUBAGENT_SEM is None:
        SUBAGENT_SEM = threading.Semaphore(3)
    return SUBAGENT_SEM
BASH_TIMEOUT = 60            # pod_bash 默认超时(秒)
BASH_OUT_MAX = 30000         # pod_bash 输出截断
READ_MAX_BYTES = 200_000     # read 单次上限
EDIT_MAX_BYTES = 512_000     # edit 目标/新内容上限
CONFIRM_TIMEOUT = 180        # 确认等待上限(超时明确告知, 不再静默丢弃)
KEEP_TOOL_MSGS = 8           # 上下文裁剪: 保留最近 N 条 tool 消息全文
PRUNE_THRESHOLD = 80_000     # 消息总字符数超过才触发裁剪

_READ_FILE_DENY = (
    "k3s.yaml", "/opt/yatterra/.env", "db.conf", "/etc/shadow",
    "/etc/rancher/", "id_rsa", "id_ed25519", ".ssh/", ".pem", ".key",
    "/opt/yatterra/llm.conf",
)

# pod_bash 白名单: 命令按 shell 操作符切段后, 每段首词都必须在这里才自动放行
_READONLY_CMDS = {
    "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "stat", "file",
    "pwd", "whoami", "echo", "printf", "which", "whereis", "env", "printenv",
    "du", "df", "ps", "tree", "diff", "date", "uname", "id", "hostname",
    "ip", "netstat", "ss", "python3", "node", "npm", "pip", "pip3", "java",
    "go", "cargo", "make", "cmake", "git", "svn", "lsb_release", "apt",
}
# 白名单首词里仍需二次判断的(只放行只读子命令)
_GIT_READONLY = {"diff", "log", "status", "show", "branch", "tag", "blame",
                 "shortlog", "describe", "remote", "rev-parse", "ls-files"}
_DANGEROUS_CHARS = re.compile(r"[`\$\(\{<>]")   # 命令替换/花括号展开/重定向 → 不自动放行

# auto=smart 模式下仍需确认的破坏性命令(删除/清盘/强推/卸载/杀进程)
_DANGEROUS_CMDS = re.compile(
    r"(?:^|[;&|]\s*)(?:rm|rmdir|unlink|shred|dd|mkfs(?:\.\w+)?|truncate|"
    r"shutdown|reboot|halt|poweroff|init\s|kill|pkill|killall|"
    r"git\s+(?:push|reset|clean|checkout\s+--|restore)|"
    r"apt(?:-get)?\s+(?:remove|purge|autoremove)|"
    r"pip3?\s+(?:uninstall|\-m\s+pip\s+uninstall)|npm\s+uninstall|"
    r"mv\s+\S+\s+/|>\s*/(?:etc|usr|bin|sbin|boot|dev))\b")

# auto 权限模式: all=全部确认(默认) / smart=仅破坏性操作确认 / none=全自动
AUTO_MODES = ("all", "smart", "none")


# ── 工具定义(OpenAI format)─────────────────────────────────────
def tool_definitions():
    return [
        {"type": "function", "function": {
            "name": "pod_bash",
            "description": "Executes a given shell command in the user's Pod as user "
                           "cloud, with /home/cloud as the working directory. Read-only "
                           "commands run automatically; commands with side effects will "
                           "ask the user for confirmation (this is normal — the user "
                           "just clicks allow). Output streams back live. Default "
                           "timeout 60s (max 120s), output truncated at 30k chars.\n"
                           "Avoid commands that produce very large outputs. Examples:\n"
                           "Input: ls\nOutput: Lists files in current directory\n\n"
                           "Input: git status\nOutput: Shows working tree status\n\n"
                           "Input: python3 app.py\nOutput: Runs the application",
            "parameters": {"type": "object", "properties": {
                "command": {"type": "string", "description": "The command to execute"},
                "timeout": {"type": "integer", "description": "Optional timeout in seconds (max 120)"},
                "description": {"type": "string", "description":
                                "Clear, concise description of what this command does "
                                "in 5-10 words, e.g. 'Lists files in current directory'"},
            }, "required": ["command"]},
        }},
        {"type": "function", "function": {
            "name": "read",
            "description": "Reads a file from the Pod home directory (paths are "
                           "relative to /home/cloud), returning the content with line "
                           "numbers. Use this before editing a file so old_string "
                           "matches exactly. If the file has more lines than shown, "
                           "pass offset to continue reading. If the file is not found, "
                           "similar filenames in the same directory are suggested.",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "The path to the file, relative to /home/cloud"},
                "offset": {"type": "integer", "description": "The line number to start reading from (1-based, optional)"},
                "limit": {"type": "integer", "description": "The number of lines to read (defaults to 2000)"},
            }, "required": ["path"]},
        }},
        {"type": "function", "function": {
            "name": "edit",
            "description": "Edits a file in the Pod home directory (paths are relative "
                           "to /home/cloud), replacing old_string with new_string. "
                           "old_string must match the file content exactly and be "
                           "unique — include enough surrounding lines to make it "
                           "unique. Leave old_string empty to create a new file (or "
                           "overwrite an existing one entirely). Each edit immediately "
                           "shows the user a diff card: if accepted it is written to "
                           "disk right away, if rejected it is discarded and you will "
                           "be told — then ask the user or try a different approach, "
                           "do not retry the identical edit.",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "The path to the file, relative to /home/cloud"},
                "old_string": {"type": "string", "description": "The text to replace (empty = create new file)"},
                "new_string": {"type": "string", "description": "The text to replace it with (must differ from old_string)"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences of old_string (default false)"},
                "reason": {"type": "string", "description": "One short sentence explaining why this change is made"},
            }, "required": ["path", "new_string"]},
        }},
        {"type": "function", "function": {
            "name": "grep",
            "description": "在项目内按内容检索(grep -rn,路径相对 /home/cloud)。",
            "parameters": {"type": "object", "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string", "description": "起始目录(默认 .)"},
                "glob": {"type": "string", "description": "文件名过滤,如 '*.py'"},
            }, "required": ["pattern"]},
        }},
        {"type": "function", "function": {
            "name": "glob",
            "description": "按通配符列出项目内文件路径。",
            "parameters": {"type": "object", "properties": {
                "pattern": {"type": "string", "description": "如 'src/**/*.ts'"},
                "path": {"type": "string", "description": "起始目录(默认 .)"},
            }, "required": ["pattern"]},
        }},
        {"type": "function", "function": {
            "name": "list_dir",
            "description": "列出目录内容(路径相对 /home/cloud)。",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "默认 ."},
            }, "required": []},
        }},
        {"type": "function", "function": {
            "name": "spawn_agent",
            "description": "Spawns a read-only research subagent that runs its "
                           "own agent loop (read/grep/glob/list_dir) in a "
                           "parallel thread and returns a concise final report "
                           "as the tool result. The subagent CANNOT see your "
                           "conversation — write the task self-contained "
                           "(background, what to find, which files/dirs). "
                           "Spawn multiple subagents in the same turn to "
                           "parallelize independent investigations. Subagents "
                           "cannot modify files or run commands; you (the "
                           "main agent) do all edits yourself, serially.",
            "parameters": {"type": "object", "properties": {
                "task": {"type": "string", "description":
                         "自包含的调研任务: 背景 + 要查什么 + 大致范围"
                         "(文件/目录), 子代理看不到当前对话"},
            }, "required": ["task"]},
        }},
    ]


def _project_tree(pod, limit=120):
    """opencode system.ts 的 <project> 块: 项目顶层文件树, 帮模型少走弯路。"""
    root = _pod_root(pod)
    lines = []
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            depth = dirpath[len(root):].count(os.sep)
            if depth >= 2:
                dirnames[:] = []
                continue
            dirnames[:] = sorted(d for d in dirnames
                                 if d not in (".git", "node_modules",
                                              "__pycache__", ".venv", "venv"))
            for f in sorted(filenames)[:40]:
                lines.append(os.path.relpath(os.path.join(dirpath, f), root))
            if len(lines) >= limit:
                break
    except OSError:
        pass
    return "\n".join(lines[:limit])


def harness_system(pod):
    import datetime
    tree = _project_tree(pod)
    env = f"""Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/cloud
  Platform: linux (Kubernetes Pod, user: cloud)
  Today's date: {datetime.date.today().isoformat()}
</env>
<project>
  {tree}
</project>"""
    return HARNESS_SYSTEM + "\n\n" + env


HARNESS_SYSTEM = """You are a coding assistant working inside the YatTerra Web IDE,
directly operating the project files of the user's Pod. Reply in 简体中文.

工作方式:
- 先用 read/grep/glob/list_dir/pod_bash(只读)弄清现状,再用 edit 修改。
  绝不在 read 之前凭空 edit。
- edit 的 old_string 必须与文件内容精确一致且唯一;带上足够上下文行保证唯一。
  不匹配时先 read 再重试,不要连续盲试。
- 每次 edit 会立即给用户看 diff 卡:接受则当场写入磁盘,拒绝则丢弃并回告你。
  被拒后询问用户原因或换方案,不要原样重试。
- 需要运行/构建/测试时用 pod_bash(有副作用的命令需用户确认,属正常流程,
  等待即可,不要因为需要确认就放弃执行)。
- 追求吞吐: 同一轮里尽量多发工具调用——调研阶段一次发 4-6 个
  read/grep(会自动并行执行);多处互不冲突的修改也可以一轮发多个 edit。
  大块的独立调研用 spawn_agent 派子代理并行做。
- 不要每轮输出进度汇报("我开始…"、"接下来…"),纯文本回合是浪费——
  直接连续调用工具,只在完成、被拒或需要用户决策时才说话。
- 改完的文件不要整文件重读验证,除非工具结果报错。
- 全部做完后,用简短中文总结改了什么、为什么。"""


# ── 会话状态(挂在 run 上)───────────────────────────────────────
class _Session:
    """一个 ide_agent run 的可变状态: 暂存修改 + bash 会话级放行 + doom-loop 计数。"""

    def __init__(self):
        self.staged = {}          # relpath -> {"old": str|None, "new": str, "reason": str}
        self.bash_always = False  # 用户点过"本次会话总是允许"
        self.allowed_prefixes = []  # 用户点过"总是允许该前缀"的命令前缀(前 2 词)
        self.call_counts = {}     # (name, canon_args) -> 次数
        self.auto = "all"         # 权限模式: all/smart/none(见 AUTO_MODES)
        self.goal_status = ""     # /goal 结局: ""=未跑完 / "done"=已完成 / "capped"=核查到顶


def _new_session(run):
    s = _Session()
    run.ide_session = s
    return s


def get_session(run):
    return getattr(run, "ide_session", None) or _new_session(run)


# ── 路径 jail ───────────────────────────────────────────────────
def _pod_root(pod):
    return os.path.realpath(os.path.join(groups.GROUP_DATA_ROOT, pod, "home"))


def _resolve_rel(pod, rel):
    """相对路径 -> (abs, error)。jail 在 /home/cloud 内,拒绝 deny 名单。

    家目录里平台放的软链(README.md/AGENTS.md → /shared/…)是合法目标,
    /shared 是只读挂载,放行;其余越界(指向宿主机其它路径)一律拒绝。
    """
    rel = (rel or "").strip().replace("\\", "/")
    if not rel:
        return None, "缺少 path 参数"
    root = _pod_root(pod)
    target = os.path.realpath(os.path.join(root, rel))
    try:
        import siteconf
        shared_root = os.path.realpath(siteconf.SHARED_ROOT)
        # 家目录软链指向容器内挂载点 /shared/…,宿主机上实际在 SHARED_ROOT
        if target == "/shared" or target.startswith("/shared/"):
            target = os.path.realpath(
                os.path.join(shared_root, target[len("/shared"):].lstrip("/")))
    except Exception:
        shared_root = None
    in_home = target == root or target.startswith(root + os.sep)
    in_shared = bool(shared_root) and target.startswith(shared_root + os.sep)
    if not (in_home or in_shared):
        return None, "安全限制: 路径越界(只允许 /home/cloud 与 /shared 内)"
    if any(d in target.lower() for d in _READ_FILE_DENY):
        return None, "安全限制: 该路径在禁止访问列表内"
    return target, None


# ── pod_bash 权限模型 ───────────────────────────────────────────
def _is_readonly(cmd):
    """白名单判定: 按 ; & | 段切分, 每段首词都只读且无危险字符才放行。"""
    if _DANGEROUS_CHARS.search(cmd):
        return False
    for seg in re.split(r"[;|&]+", cmd):
        seg = seg.strip()
        if not seg:
            continue
        words = seg.split()
        first = words[0]
        if first not in _READONLY_CMDS:
            return False
        if first == "git" and len(words) > 1 and words[1] not in _GIT_READONLY:
            return False
        if first in ("python3", "node", "npm", "pip", "pip3", "java", "go",
                     "cargo", "make", "cmake", "apt") and len(words) > 1:
            # 解释器/包管理器子命令难静态判定, 一律走确认
            sub = words[1]
            if first == "npm" and sub in ("ls", "list", "run", "test", "outdated"):
                pass
            elif first == "pip" and sub in ("list", "show", "freeze"):
                pass
            elif first == "apt" and sub in ("list", "show", "search"):
                pass
            else:
                return False
    return True


def _cmd_prefix(cmd):
    """命令前缀 = 前 2 个词; 第 2 个词含替换/引号等特殊字符时只取第 1 个词
    (echo $(date) → 'echo'; python3 -c "..." → 'python3 -c'; npm run build → 'npm run')。
    会话级「总是允许该前缀」白名单用它匹配。"""
    words = cmd.split()
    if len(words) >= 2 and re.fullmatch(r"[A-Za-z0-9_./=:-]+", words[1]):
        return " ".join(words[:2])
    return words[0] if words else ""


def _bash_confirm(run, command):
    """弹卡等用户确认。返回 (allowed, always, always_prefix)。"""
    action_id = uuid.uuid4().hex
    with run.cond:
        run.action_result = None
        run.action_event.clear()
    run.add({"type": "bash_confirm",
             "data": {"action_id": action_id, "command": command[:2000]}})
    waited = 0.0
    while waited < CONFIRM_TIMEOUT:
        if run.action_event.wait(timeout=min(5.0, CONFIRM_TIMEOUT - waited)):
            break
        waited += 5.0
        if run.stop_event.is_set():
            return False, False, False
    results = run.action_result
    if results is None:
        # 超时不再静默: 前端据此把卡片标记为已超时, 而不是永远挂着
        run.add({"type": "bash_confirm_result",
                 "data": {"action_id": action_id, "outcome": "timeout"}})
        return False, False, False
    allowed, always, always_prefix = False, False, False
    items = results if isinstance(results, list) else [results]
    for r in items:
        if isinstance(r, dict):
            allowed = allowed or r.get("allowed") is True
            always = always or r.get("always") is True
            always_prefix = always_prefix or r.get("always_prefix") is True
    return allowed, always, always_prefix


def _tool_pod_bash(args, run, pod, sess):
    """opencode bash.ts 风格: Popen + 增量读 stdout/stderr,
    边跑边发 bash_output 事件, 前端实时渲染控制台。"""
    cmd = str(args.get("command") or "").strip()
    if not cmd:
        return "缺少 command 参数"
    try:
        timeout = min(120, max(5, int(args.get("timeout") or BASH_TIMEOUT)))
    except (TypeError, ValueError):
        timeout = BASH_TIMEOUT
    if not sess.bash_always and not _is_readonly(cmd):
        # auto 权限模式: none=全自动放行; smart=仅破坏性命令(删除/强推/卸载/
        # 杀进程等)弹卡, 其余副作用命令放行; all=维持逐条确认
        if sess.auto == "none":
            pass
        elif sess.auto == "smart" and not _DANGEROUS_CMDS.search(cmd):
            pass
        else:
            # 会话级前缀白名单: 用户点过「总是允许该前缀」的命令直接放行
            # (_DANGEROUS_CHARS 里的 $/反引号/( 等会让 echo $(date)、python3 -c
            # 每次都弹卡, 这条白名单把重复点击去掉, 范围仍限于会话内)
            prefix = _cmd_prefix(cmd)
            whitelisted = any(
                cmd == ap or cmd.startswith(ap + " ")
                for ap in sess.allowed_prefixes)
            if not whitelisted:
                allowed, always, always_prefix = _bash_confirm(run, cmd)
                if always:
                    sess.bash_always = True
                if always_prefix and prefix and prefix not in sess.allowed_prefixes:
                    sess.allowed_prefixes.append(prefix)
                if not allowed:
                    return ("用户未允许执行该命令(拒绝或超时),未执行。"
                            "可以换只读方式,或向用户解释为什么需要这条命令。")
    if agent._ops_denied(cmd):
        return "【被安全策略拒绝:该命令在安全策略下禁用。换一种只读/安全的方式。】"
    pod_name = agent._resolve_pod(pod)
    if not pod_name:
        return f"Pod {pod} 不在运行,无法执行命令"

    action_id = uuid.uuid4().hex
    run.add({"type": "bash_output",
             "data": {"action_id": action_id, "command": cmd[:2000],
                      "output": "", "done": False}})
    try:
        proc = subprocess.Popen(
            ["kubectl", "-n", groups.NS, "exec", pod_name, "--",
             "su", "-l", "cloud", "-c", cmd],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace")
    except OSError as e:
        return f"执行失败: {e}"

    output = [""]

    def _emit(chunk):
        output[0] += chunk
        if len(output[0]) > BASH_OUT_MAX:
            return                      # 截断后不再刷屏
        # 增量 delta: 以前每个 chunk 都重发累计全文, 长输出的 jsonl 事件流
        # 是 O(n²); 前端按 delta 追加, done 事件仍带完整最终 output
        run.add({"type": "bash_output",
                 "data": {"action_id": action_id, "command": cmd[:2000],
                          "delta": chunk, "done": False}})

    timed_out = False
    try:
        # 逐块读, 边读边推(阻塞读 + 总超时由轮询线程实现)
        import selectors
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        buf = ""
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                timed_out = True
                break
            if run.stop_event.is_set():
                timed_out = True
                break
            events = sel.select(timeout=min(0.5, left))
            if not events:
                continue
            try:
                chunk = os.read(proc.stdout.fileno(), 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="replace")
            if len(buf) >= 200 or "\n" in buf[-200:]:
                _emit(buf)
                buf = ""
        if buf:
            _emit(buf)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        try:
            rest = proc.stdout.read() or ""
            if rest:
                _emit(rest)
        except Exception:
            pass
    exit_code = proc.returncode
    out = output[0]
    if len(out) > BASH_OUT_MAX:
        out = out[:BASH_OUT_MAX] + "\n\n(Output was truncated due to length limit)"
    if timed_out:
        out += f"\n\n(Command timed out after {timeout} s)"
    if exit_code not in (0, None):
        out += f"\n[exit={exit_code}]"
    run.add({"type": "bash_output",
             "data": {"action_id": action_id, "command": cmd[:2000],
                      "output": out, "done": True, "exit": exit_code}})
    return out or "(无输出)"


# ── read / edit / 检索 ──────────────────────────────────────────
def _current_text(pod, sess, rel):
    """文件当前文本 = 磁盘内容叠加暂存修改。返回 (text|None, is_new, error)。"""
    if rel in sess.staged:
        st = sess.staged[rel]
        return st["new"], st["old"] is None, None
    abs_p, err = _resolve_rel(pod, rel)
    if err:
        return None, False, err
    if not os.path.isfile(abs_p):
        return None, True, None      # 不存在 → 视为待创建
    if os.path.getsize(abs_p) > EDIT_MAX_BYTES:
        return None, False, f"文件过大(>{EDIT_MAX_BYTES//1000}KB)"
    with open(abs_p, "rb") as f:
        raw = f.read()
    if b"\x00" in raw:
        return None, False, "二进制文件,不支持文本读写"
    return raw.decode("utf-8", errors="replace"), False, None


def _tool_read(args, pod, sess):
    rel = (args.get("path") or "").strip()
    text, is_new, err = _current_text(pod, sess, rel)
    if err:
        return err
    if is_new:
        # opencode read.ts: 文件不存在时给同目录相似名建议
        base = os.path.basename(rel)
        parent = os.path.dirname(rel) or "."
        sugg = []
        try:
            abs_dir, derr = _resolve_rel(pod, parent)
            if not derr and os.path.isdir(abs_dir):
                low = base.lower()
                for e in sorted(os.listdir(abs_dir))[:200]:
                    el = e.lower()
                    if low in el or el in low:
                        sugg.append(os.path.join(parent, e))
                    if len(sugg) >= 3:
                        break
        except OSError:
            pass
        msg = f"文件不存在: {rel}"
        if sugg:
            msg += "\n\nDid you mean one of these?\n" + "\n".join(sugg)
        msg += "\n(创建新文件请用 edit 且 old_string 留空)"
        return msg
    try:
        offset = max(1, int(args.get("offset") or 1))
        limit = min(2000, max(1, int(args.get("limit") or 2000)))
    except (TypeError, ValueError):
        offset, limit = 1, 2000
    lines = text.splitlines()
    sel = lines[offset - 1:offset - 1 + limit]
    body = "\n".join(f"{offset + i}| {l}" for i, l in enumerate(sel))
    if len(body) > READ_MAX_BYTES:
        body = body[:READ_MAX_BYTES] + "\n…(已截断)"
    header = f"[{rel} 共 {len(lines)} 行, 显示 {offset}-{offset + len(sel) - 1}]"
    if offset + len(sel) - 1 < len(lines):
        header += "(未完,可用 offset 继续读)"
    return header + "\n" + body


def _fuzzy_replace(text, old, new, replace_all=False):
    """opencode edit.ts replace() 的轻量移植: 精确 → 行尾空白归一化 →
    块锚点(首尾行锚定+中间相似度) → 空白归一化。返回 (new_text|None, error)。"""
    n = text.count(old)
    if n > 0:
        if replace_all:
            return text.replace(old, new), None
        if n == 1:
            return text.replace(old, new, 1), None
        return None, f"old_string 出现 {n} 次,请带上更多上下文使其唯一(或 replace_all=true)"

    t_lines = text.splitlines()
    o_lines = old.splitlines()
    if o_lines and o_lines[-1] == "":
        o_lines.pop()

    def _line_hits(trim):
        """逐行匹配(trim 为每行的变换函数), 返回起始行号列表。"""
        hits = []
        for i in range(len(t_lines) - len(o_lines) + 1):
            if all(trim(t_lines[i + j]) == trim(o_lines[j])
                   for j in range(len(o_lines))):
                hits.append(i)
        return hits

    def _splice(hits):
        if len(hits) != 1:
            return None
        i = hits[0]
        merged = t_lines[:i] + new.splitlines() + t_lines[i + len(o_lines):]
        return "\n".join(merged), None

    # ① 行尾空白归一化
    hits = _line_hits(lambda l: l.rstrip())
    if hits:
        if len(hits) == 1:
            return _splice(hits)
        return None, (f"old_string 匹配到 {len(hits)} 处(行尾空白归一化后),"
                      "请带上更多上下文使其唯一")
    # ② 空白归一化(连续空白折叠, opencode WhitespaceNormalizedReplacer)
    import re as _re
    _ws = lambda l: _re.sub(r"\s+", " ", l).strip()
    hits = _line_hits(_ws)
    if hits:
        if len(hits) == 1:
            return _splice(hits)
        return None, (f"old_string 匹配到 {len(hits)} 处(空白归一化后),"
                      "请带上更多上下文使其唯一")
    # ③ 块锚点: 首尾行精确锚定, 中间行 50% 相似即接受(opencode BlockAnchorReplacer)
    if len(o_lines) >= 3:
        first, last = o_lines[0].strip(), o_lines[-1].strip()
        for i in range(len(t_lines)):
            if t_lines[i].strip() != first:
                continue
            for j in range(i + 2, len(t_lines)):
                if t_lines[j].strip() == last:
                    block = t_lines[i:j + 1]
                    if len(block) == len(o_lines):
                        mid_hit = sum(
                            1 for k in range(1, len(o_lines) - 1)
                            if block[k].strip() == o_lines[k].strip())
                        mid_all = len(o_lines) - 2
                        if mid_all == 0 or mid_hit / mid_all >= 0.5:
                            merged = (t_lines[:i] + new.splitlines()
                                      + t_lines[j + 1:])
                            return "\n".join(merged), None
                    break
    return None, ("old_string 未在文件中找到(精确/空白归一化/块锚点均未命中);"
                  "请先 read 再重试")


def _diff_summary(old, new, rel):
    diff_lines = list(difflib.unified_diff(
        (old or "").splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile=f"a/{rel}", tofile=f"b/{rel}"))
    added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))
    diff_text = "".join(diff_lines)
    if len(diff_text) > 8000:
        diff_text = diff_text[:8000] + "\n…(diff 过长已截断)"
    return diff_text, f"+{added} -{removed} 行"


def _tool_edit(args, run, pod, sess):
    rel = (args.get("path") or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        return "缺少 path 参数"
    if any(d in rel.lower() for d in (".ssh/", "id_rsa", "id_ed25519")):
        return "安全限制: 不允许修改密钥/SSH 相关文件"
    abs_check, cerr = _resolve_rel(pod, rel)
    if cerr:
        return cerr
    try:
        import siteconf
        if abs_check.startswith(os.path.realpath(siteconf.SHARED_ROOT) + os.sep):
            return "安全限制: /shared 是只读的,不能修改(家目录里的 README.md 等软链指向它)"
    except Exception:
        pass
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    if not isinstance(new_string, str):
        return "缺少 new_string 参数"
    if len(new_string.encode("utf-8", errors="ignore")) > EDIT_MAX_BYTES:
        return "新内容超过 512KB, 拒绝"
    reason = str(args.get("reason") or "")[:300]

    text, is_new, err = _current_text(pod, sess, rel)
    if err:
        return err
    replace_all = args.get("replace_all") is True
    if is_new:
        if old_string:
            return f"文件不存在: {rel}(创建新文件请把 old_string 留空)"
        new_text = new_string
    else:
        if not isinstance(old_string, str) or not old_string:
            new_text = new_string          # 空 old_string = 整体覆盖
        else:
            new_text, ferr = _fuzzy_replace(text, old_string, new_string,
                                            replace_all=replace_all)
            if ferr:
                return ferr
    if new_text == text:
        return "内容无变化(old_string 替换后与原文相同),未修改"

    # 先暂存(read 叠加用), 弹即时 diff 卡等用户裁决(opencode Permission.ask)
    sess.staged[rel] = {"old": None if is_new else text,
                        "new": new_text, "reason": reason}
    diff_text, summary = _diff_summary(None if is_new else text, new_text, rel)
    action_id = uuid.uuid4().hex
    auto_accept = sess.auto in ("smart", "none")
    if auto_accept:
        # smart/none 模式: 不等确认, 直接写入; 仍发 edit_confirm 卡片
        # (带 auto 标记)让用户看到改了什么, tool_result 会把它落定为已接受
        run.add({"type": "edit_confirm",
                 "data": {"action_id": action_id, "path": rel, "is_new": is_new,
                          "summary": summary, "reason": reason,
                          "diff": diff_text, "auto": True}})
    else:
        with run.cond:
            run.action_result = None
            run.action_event.clear()
        run.add({"type": "edit_confirm",
                 "data": {"action_id": action_id, "path": rel, "is_new": is_new,
                          "summary": summary, "reason": reason,
                          "diff": diff_text}})
        waited = 0.0
        while waited < CONFIRM_TIMEOUT:
            if run.action_event.wait(timeout=min(5.0, CONFIRM_TIMEOUT - waited)):
                break
            waited += 5.0
            if run.stop_event.is_set():
                break
        accepted = False
        results = run.action_result
        if results is not None:
            items = results if isinstance(results, list) else [results]
            for r in items:
                if isinstance(r, dict) and r.get("accepted") is True:
                    accepted = True
        if not accepted:
            sess.staged.pop(rel, None)
            return ("用户拒绝了对 " + rel + " 的这次修改(或确认超时),已丢弃。"
                    "请询问用户原因或换一种方案,不要原样重试。")
    written, failed = _write_staged(run, pod, sess, [rel])
    sess.staged.pop(rel, None)
    if failed:
        return f"写入 {rel} 失败: {failed[0][1]}"
    bak = written[0][1] if written else None
    return json.dumps({"ok": True, "path": rel, "is_new": is_new,
                       "diff_summary": summary,
                       "backup": bak,
                       "note": ("已按 auto 模式自动写入磁盘"
                                if auto_accept else "用户已接受,已写入磁盘")},
                      ensure_ascii=False)


def _tool_grep(args, pod, sess):
    pattern = str(args.get("pattern") or "")
    if not pattern:
        return "缺少 pattern 参数"
    rel = (args.get("path") or ".").strip()
    root, err = _resolve_rel(pod, rel)
    if err:
        return err
    cmd = ["grep", "-rn", "--color=never", "-I", pattern]
    if args.get("glob"):
        cmd += ["--include", str(args["glob"])]
    cmd.append(root)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return "[检索超时 30s]"
    out = (p.stdout or "") + (p.stderr or "")
    home = _pod_root(pod)
    out = out.replace(home + "/", "/home/cloud/")
    if len(out) > BASH_OUT_MAX:
        out = out[:BASH_OUT_MAX] + f"\n…[截断,共 {len(out)} 字节]"
    return out or "(无匹配)"


def _tool_glob(args, pod, sess):
    pattern = str(args.get("pattern") or "")
    if not pattern:
        return "缺少 pattern 参数"
    rel = (args.get("path") or ".").strip()
    root, err = _resolve_rel(pod, rel)
    if err:
        return err
    # 把 ** 折叠为 find 的 -name 匹配(够用, 不引依赖)
    import fnmatch
    names = pattern.split("/")
    base_pat = names[-1]
    try:
        hits = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames
                           if d not in (".git", "node_modules", "__pycache__",
                                        ".venv", "venv")]
            for fn in filenames:
                if fnmatch.fnmatch(fn, base_pat):
                    hits.append(os.path.join(dirpath, fn))
            if len(hits) > 500:
                break
    except OSError as e:
        return f"遍历失败: {e}"
    home = _pod_root(pod)
    out = "\n".join("/home/cloud/" + os.path.relpath(h, home)
                    for h in sorted(hits)[:500])
    return out or "(无匹配)"


def _tool_list_dir(args, pod, sess):
    rel = (args.get("path") or ".").strip()
    root, err = _resolve_rel(pod, rel)
    if err:
        return err
    if not os.path.isdir(root):
        return f"不是目录: {rel}"
    try:
        entries = sorted(os.listdir(root))
    except OSError as e:
        return f"列目录失败: {e}"
    home = _pod_root(pod)
    lines = []
    for e in entries[:500]:
        full = os.path.join(root, e)
        tag = "/" if os.path.isdir(full) else ""
        lines.append(e + tag)
    return f"[{rel} 共 {len(entries)} 项]\n" + "\n".join(lines)


def _batch_confirm(run, pod, sess):
    """(已废弃,保留占位避免旧引用)"""
    return [], list(sess.staged.keys())


# ── 子代理(spawn_agent): 只读调研, 独立循环, 报告作为工具结果返回 ──
SUBAGENT_SYSTEM = """You are a read-only research subagent inside the YatTerra Web IDE.
You cannot see the main conversation. Investigate exactly what your task
asks using read/grep/glob/list_dir, then reply with a concise,
information-dense report in 简体中文: findings first, file paths with line
numbers, short key code excerpts. No preamble, no follow-up questions —
if something is missing, state what you checked and what was not found."""


def _run_subagent(pod, user, task, stop_event=None):
    """子代理主循环: 只读工具面, 自带预算, 返回最终报告文本。"""
    import llm
    sess = _Session()
    tools = [t for t in tool_definitions()
             if t["function"]["name"] in ("read", "grep", "glob", "list_dir")]
    system = SUBAGENT_SYSTEM + "\n\n" + harness_system(pod)
    messages = [{"role": "user", "content": task[:4000]}]
    deadline = time.monotonic() + SUBAGENT_WALL
    last_text = ""

    def _exec_ro(name, args):
        canon = json.dumps(args, ensure_ascii=False, sort_keys=True)
        key = (name, canon)
        sess.call_counts[key] = sess.call_counts.get(key, 0) + 1
        if sess.call_counts[key] >= 3:
            return "同一工具相同参数重复调用,已拒绝,请换思路。"
        try:
            if name == "read":
                return _tool_read(args, pod, sess)
            if name == "grep":
                return _tool_grep(args, pod, sess)
            if name == "glob":
                return _tool_glob(args, pod, sess)
            if name == "list_dir":
                return _tool_list_dir(args, pod, sess)
            return f"未知工具 {name}"
        except Exception as e:
            return f"工具执行失败: {type(e).__name__}: {e}"

    for _ in range(SUBAGENT_MAX_ITER):
        if stop_event is not None and stop_event.is_set():
            return last_text or "[子代理被停止]"
        if time.monotonic() > deadline:
            break
        _prune(messages)
        try:
            stream = llm.stream_chat_with_tools(
                messages, system=system, max_tokens=4096,
                tools=tools, caller="ide_subagent", user=user)
        except llm.LLMError as e:
            return f"子代理 LLM 错误: {e}"
        calls, parts = [], []
        for kind, data in stream:
            if stop_event is not None and stop_event.is_set():
                return last_text or "[子代理被停止]"
            if kind == "content":
                parts.append(data)
            elif kind == "tool_call_done":
                calls.append(data)
        last_text = "".join(parts).strip()
        if not calls:
            return last_text or "(子代理无输出)"
        messages.append({"role": "assistant", "content": "".join(parts),
                         "tool_calls": [
                             {"id": tc["id"], "type": "function",
                              "function": {"name": tc["name"],
                                           "arguments": json.dumps(
                                               tc["arguments"],
                                               ensure_ascii=False)}}
                             for tc in calls]})
        for tc in calls:
            result = _exec_ro(tc["name"], tc["arguments"])
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": result})
    return (last_text or "[子代理达到轮次/时限上限,以上为最后输出]")


def _tool_spawn_agent(args, run, pod, user, sess):
    """spawn_agent 工具: 并发信号量限流(默认 3), 阻塞等子代理报告。"""
    task = str(args.get("task") or "").strip()
    if not task:
        return "缺少 task 参数(子代理看不到当前对话,任务必须自包含)"
    with _subagent_sem():
        if run.stop_event.is_set():
            return "[子代理未启动:任务已停止]"
        report = _run_subagent(pod, user, task, stop_event=run.stop_event)
    if not report:
        return "(子代理无输出)"
    return report[:20000]


# ── 会话持久化(opencode message-v2 的轻量等价)─────────────────
def _history_path(user, session_id):
    import siteconf
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[:64]
    if not safe:
        return None
    d = os.path.join(siteconf.path(".ide_agent_sessions"),
                     re.sub(r"[^A-Za-z0-9_-]", "", user or "anon")[:32])
    return os.path.join(d, safe + ".json")


def load_history(user, session_id):
    """读取完整历史(含工具结果)。返回 messages 列表或 None。"""
    p = _history_path(user, session_id)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        msgs = data.get("messages") if isinstance(data, dict) else None
        if isinstance(msgs, list) and msgs:
            return msgs
    except (OSError, ValueError):
        pass
    return None


def save_history(user, session_id, messages):
    p = _history_path(user, session_id)
    if not p:
        return
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + f".tmp-{uuid.uuid4().hex}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"messages": messages, "ts": time.time()},
                      f, ensure_ascii=False)
        os.replace(tmp, p)
    except OSError:
        pass


# ── /goal 目标持久化 ────────────────────────────────────────────
# 目标不再只活在内存里: 每个会话(session_id)只保留最新的一个目标,
# 平台启动时自动重新拉起复核 —— 已完成(模型写出 GOAL_DONE)就删除记录,
# 没完成就接着推进。这样后台 run 被重启杀掉后目标也不会丢。
GOAL_OFF_WORDS = {"off", "clear", "cancel", "stop", "done", "reset",
                  "取消", "停止", "清除", "已完成", "结束"}
GOAL_RESUME_DELAY = float(os.environ.get("YATTERRA_IDE_GOAL_RESUME_DELAY", "25"))
GOAL_RESUME_STAGGER = 4.0     # 多个目标逐个拉起, 别把 LLM 网关打满


def _goals_dir():
    import siteconf
    return siteconf.path(".ide_agent_goals")


def _goal_key(session_id, pod=""):
    """会话有 id 就用它; 没有(极端情况)退回按 Pod 存, 目标一样不会丢。"""
    sid = re.sub(r"[^A-Za-z0-9_-]", "", session_id or "")[:64]
    if sid:
        return "s-" + sid
    p = re.sub(r"[^A-Za-z0-9_-]", "", pod or "")[:64]
    return ("p-" + p) if p else ""


def _goal_path(user, session_id, pod=""):
    key = _goal_key(session_id, pod)
    if not key:
        return None
    d = os.path.join(_goals_dir(),
                     re.sub(r"[^A-Za-z0-9_-]", "", user or "anon")[:32])
    return os.path.join(d, key + ".json")


def _write_json_atomic(path, obj):
    tmp = path + f".tmp-{uuid.uuid4().hex}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def save_goal(user, session_id, pod, goal, auto="all"):
    """记下本会话最新的目标(同一会话只留一个, 覆盖旧目标)。"""
    p = _goal_path(user, session_id, pod)
    if not p or not (goal or "").strip():
        return
    try:
        prev = load_goal(user, session_id, pod) or {}
        os.makedirs(os.path.dirname(p), exist_ok=True)
        now = time.time()
        _write_json_atomic(p, {
            "user": user or "",
            "session_id": session_id or "",
            "pod": pod or "",
            "goal": goal.strip()[:4000],
            "auto": auto if auto in AUTO_MODES else "all",
            "created": prev.get("created") or now,
            "updated": now,
            "resumes": int(prev.get("resumes") or 0),
            "last_run": prev.get("last_run") or "",
        })
    except OSError:
        pass


def load_goal(user, session_id, pod=""):
    p = _goal_path(user, session_id, pod)
    if not p:
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) and rec.get("goal") else None


def clear_goal(user, session_id, pod=""):
    """目标完成 / 用户取消 / Pod 已删 → 移除记录。"""
    p = _goal_path(user, session_id, pod)
    if not p:
        return
    try:
        os.unlink(p)
    except OSError:
        pass
    try:
        os.rmdir(os.path.dirname(p))   # 目录空了顺手收掉, 不堆空壳
    except OSError:
        pass


def list_goals():
    """扫出所有持久化目标(跨用户)。"""
    out = []
    root = _goals_dir()
    try:
        users = os.listdir(root)
    except OSError:
        return out
    for u in users:
        d = os.path.join(root, u)
        if not os.path.isdir(d):
            continue
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8") as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(rec, dict) and rec.get("goal"):
                out.append(rec)
    return out


def _mark_goal_resumed(rec, run_id):
    p = _goal_path(rec.get("user"), rec.get("session_id"), rec.get("pod"))
    if not p:
        return
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        d["resumes"] = int(d.get("resumes") or 0) + 1
        d["last_run"] = run_id
        d["last_resume"] = time.time()
        _write_json_atomic(p, d)
    except (OSError, ValueError):
        pass


_GOALS_RESUME_STARTED = False


def resume_goals(delay=None):
    """平台启动时调一次: 延迟一小会儿(等 web 起稳、别和别的初始化抢资源),
    再把每个未完成的目标重新拉起复核。多 worker 下只有抢到锁的那个干活。"""
    global _GOALS_RESUME_STARTED
    if _GOALS_RESUME_STARTED:
        return
    _GOALS_RESUME_STARTED = True
    d = GOAL_RESUME_DELAY if delay is None else delay
    threading.Thread(target=_resume_goals_worker, args=(d,),
                     name="ide-goal-resume", daemon=True).start()


def _resume_goals_worker(delay):
    time.sleep(max(0.0, delay))
    lock = None
    try:
        import fcntl
        os.makedirs(_goals_dir(), exist_ok=True)
        lock = open(os.path.join(_goals_dir(), ".boot.lock"), "w")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        return                          # 别的 worker 在管 / 拿不到锁就算了
    try:
        recs = list_goals()
        if not recs:
            return
        import page_ai_runs
        first = True
        for rec in recs:
            pod = str(rec.get("pod") or "")
            home = os.path.join(groups.GROUP_DATA_ROOT, pod, "home")
            if not pod or not os.path.isdir(home):
                clear_goal(rec.get("user"), rec.get("session_id"), pod)
                continue                # Pod 已经不存在了, 目标作废
            if not first:
                time.sleep(GOAL_RESUME_STAGGER)
            first = False
            q = "/goal " + str(rec["goal"])
            try:
                rid = page_ai_runs.start(
                    str(rec.get("user") or ""), "pod_ide", q,
                    [{"role": "user", "content": q}], "",
                    session_id=str(rec.get("session_id") or ""),
                    route=f"/pods/{pod}/ide", pod=pod,
                    auto=str(rec.get("auto") or "all"))
            except Exception:
                continue
            _mark_goal_resumed(rec, rid)
    finally:
        try:
            lock.close()
        except Exception:
            pass


# ── 落盘 ────────────────────────────────────────────────────────
def _write_staged(run, pod, sess, accepted):
    """把用户接受的暂存修改写入磁盘(备份 + O_NOFOLLOW + 原子替换)。"""
    written, failed = [], []
    for rel in accepted:
        st = sess.staged.get(rel)
        if not st:
            continue
        abs_p, err = _resolve_rel(pod, rel)
        if err:
            failed.append((rel, err))
            continue
        backup_rel = None
        try:
            import shutil
            import stat as stat_mod
            if st["old"] is not None:
                if not os.path.isfile(abs_p):
                    failed.append((rel, "原文件已不存在(等待确认期间被删)"))
                    continue
                backup_rel = f"{rel}.bak-{int(time.time())}"
                backup_abs = os.path.join(_pod_root(pod), backup_rel)
                with open(os.open(abs_p, os.O_RDONLY | os.O_NOFOLLOW), "rb") as src:
                    st_f = os.fstat(src.fileno())
                    if not stat_mod.S_ISREG(st_f.st_mode):
                        raise OSError("目标已不是普通文件")
                    with open(os.open(
                            backup_abs,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o644), "wb") as dst:
                        shutil.copyfileobj(src, dst)
                mode = stat_mod.S_IMODE(st_f.st_mode)
            else:
                mode = 0o644
            tmp_abs = os.path.join(
                os.path.dirname(abs_p),
                f".{os.path.basename(abs_p)}.tmp-{uuid.uuid4().hex}")
            with open(os.open(
                    tmp_abs,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    mode), "w", encoding="utf-8") as f:
                f.write(st["new"])
            os.replace(tmp_abs, abs_p)
            written.append((rel, backup_rel))
        except OSError as e:
            failed.append((rel, str(e)))
            try:
                if os.path.lexists(tmp_abs):
                    os.unlink(tmp_abs)
            except (OSError, UnboundLocalError):
                pass
    return written, failed


# ── 上下文裁剪(机械级)────────────────────────────────────────
def _prune(messages):
    """旧 tool 输出替换为占位符。只动 role=tool 的消息, 保最近 KEEP_TOOL_MSGS 条。"""
    total = sum(len(str(m.get("content") or "")) for m in messages)
    if total <= PRUNE_THRESHOLD:
        return
    tool_idx = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    for i in tool_idx[:-KEEP_TOOL_MSGS]:
        c = str(messages[i].get("content") or "")
        if len(c) > 200:
            messages[i]["content"] = ("[旧工具输出已清理以节省上下文,"
                                      f"原 {len(c)} 字符。需要时请重新调用工具)")


# ── 主循环 ──────────────────────────────────────────────────────
def stream_agent(messages, system="", run=None, pod="", user=None,
                 max_tokens=4096, session_id="", auto="all"):
    """IDE 版 agentic loop。yield (kind, data), 与 page_ai_runs 兼容。

    session_id 非空时: 开跑前重载完整历史(含工具结果), 结束后整段落盘,
    追问不再丢工具上下文。

    auto: 权限模式 all/smart/none(见 AUTO_MODES)。
    本次问题以 "/goal " 开头时进入目标模式: 模型每次给出无工具调用的
    回复后, 注入完成度核查提示, 未完成则继续推进, 回复 GOAL_DONE 才结束。
    """
    import llm

    assert run is not None and pod, "ide_agent 需要后台 run 与 pod 名"
    sess = get_session(run)
    if auto in AUTO_MODES:
        sess.auto = auto
    tools = tool_definitions()
    system = (system + "\n\n" + harness_system(pod)).strip()

    # /goal 解析: 从最后一条用户消息剥离前缀, 得到目标文本
    goal = ""
    plan_mode = False
    for m in reversed(messages):
        if m.get("role") == "user":
            c = str(m.get("content") or "")
            if c.lstrip().startswith("/goal"):
                goal = c.lstrip()[len("/goal"):].strip()
                if goal:
                    m["content"] = goal
            elif c.lstrip().startswith("/plan"):
                plan_mode = True
                rest = c.lstrip()[len("/plan"):].strip()
                if rest:
                    m["content"] = rest
            break
    if goal and goal.strip().lower() in GOAL_OFF_WORDS:
        # /goal off|取消|停止 …: 撤掉本会话保存的目标, 不再自动拉起
        clear_goal(user, session_id, pod)
        yield ("content", "已清除本会话保存的目标。")
        return
    if goal:
        sess.goal_status = ""
        save_goal(user, session_id, pod, goal, auto=sess.auto)
        system += ("\n\n[目标模式] 用户给定了明确目标: " + goal[:2000] +
                   "\n持续工作直到目标完全达成。当你认为已全部完成时,"
                   "在最终回复的最后一行单独写 GOAL_DONE 表示结束;"
                   "未完成就继续使用工具推进,不要提前收尾。"
                   "系统会在你停下时核查完成度,未达标会被要求继续。\n"
                   "开跑时先把目标分解成子任务:相互独立的调研部分"
                   "(弄清某模块结构、找所有相关文件等)在同一轮里用 "
                   "spawn_agent 并行派出多个子代理同时做;"
                   "修改文件必须由你自己在主流程串行完成(子代理只读)。\n"
                   "注意: 纯文本回合会被系统当作'自认完成'触发核查——"
                   "没做完之前每轮都要带工具调用,不要只输出进度文字。")
    if plan_mode:
        # 计划模式(Claude Code plan mode 风格): 只调研不改文件。
        # 摘掉 edit 工具 + 系统提示, 模型给出计划后自然停下;
        # 用户下一条消息确认后(普通模式, 历史完整落盘)才真正执行。
        tools = [t for t in tools
                 if t["function"]["name"] not in ("edit",)]
        system += ("\n\n[计划模式] 现在只做调研和规划,禁止修改任何文件"
                   "(本次没有 edit 工具)。用 read/grep/glob/list_dir/"
                   "pod_bash(只读)弄清现状后,给出清晰的实施计划:"
                   "分步骤、每步改哪些文件、为什么。计划给完就停下,"
                   "等用户确认后再执行。")

    if session_id:
        saved = load_history(user, session_id)
        if saved:
            # 调用方 messages = 文本历史 + 本次新问题; 有完整历史时
            # 只保留最后一条(本次问题), 其余用落盘的完整版本
            last_user = None
            for m in reversed(messages):
                if m.get("role") == "user":
                    last_user = m
                    break
            messages = list(saved) + ([last_user] if last_user else [])
    start = time.monotonic()
    try:
        yield from _stream_loop(messages, system, run, pod, user, sess,
                                tools, max_tokens, start, goal=goal)
    finally:
        if session_id:
            save_history(user, session_id, messages)
        if goal and getattr(sess, "goal_status", "") == "done":
            clear_goal(user, session_id, pod)   # 目标已完成 → 移除记录


def _stream_loop(messages, system, run, pod, user, sess, tools,
                 max_tokens, start, goal=""):
    import llm

    def _wall_exceeded():
        return time.monotonic() - start > MAX_WALL

    def _exec(name, args):
        """单工具执行入口: doom-loop 守卫 + 坏调用修复。"""
        canon = json.dumps(args, ensure_ascii=False, sort_keys=True)
        key = (name, canon)
        sess.call_counts[key] = sess.call_counts.get(key, 0) + 1
        if sess.call_counts[key] >= 3:
            return ("检测到同一工具以相同参数重复调用 "
                    f"{sess.call_counts[key]} 次,已拒绝。请换思路或停止。")
        try:
            if name == "pod_bash":
                return _tool_pod_bash(args, run, pod, sess)
            if name == "read":
                return _tool_read(args, pod, sess)
            if name == "edit":
                return _tool_edit(args, run, pod, sess)
            if name == "grep":
                return _tool_grep(args, pod, sess)
            if name == "glob":
                return _tool_glob(args, pod, sess)
            if name == "list_dir":
                return _tool_list_dir(args, pod, sess)
            if name == "spawn_agent":
                return _tool_spawn_agent(args, run, pod, user, sess)
            return f"未知工具 {name},可用: pod_bash read edit grep glob list_dir spawn_agent"
        except Exception as e:
            return f"工具执行失败: {type(e).__name__}: {e}"

    # 工具轮次计数: MAX_ITERATIONS 以前是死代码(循环只受 MAX_WALL 约束,
    # 模型可以空转到 15 分钟)。到限后注入一条收尾指令并禁掉工具,
    # 逼模型基于已有信息给最终答复。
    iterations = 0
    goal_checks = 0
    empty_retries = 0
    while True:
        if _wall_exceeded():
            yield ("content", f"\n\n[已达到最大耗时 {MAX_WALL}s,自动停止。]")
            return
        if run.stop_event.is_set():
            return
        _prune(messages)
        try:
            stream = llm.stream_chat_with_tools(
                messages, system=system, max_tokens=max_tokens,
                tools=tools, caller="ide_agent", user=user)
        except llm.LLMError as e:
            yield ("content", f"LLM 错误: {e}")
            return

        tool_calls_pending = []
        content_parts = []
        has_tool_calls = False
        timed_out = False
        for kind, data in stream:
            if _wall_exceeded():
                timed_out = True
                break
            if run.stop_event.is_set():
                return
            if kind == "reasoning":
                yield ("reasoning", data)
            elif kind == "content":
                content_parts.append(data)
                yield ("content", data)
            elif kind == "tool_call_done":
                has_tool_calls = True
                tool_calls_pending.append(data)
                yield ("tool_call", data)
            elif kind == "truncated":
                # max_tokens 截断(llm.py 发的显式信号): 明确告知, 不再无声结束
                yield ("content",
                       "\n\n[⚠ 回答被 max_tokens 截断,内容可能不完整;"
                       "可以让我继续写完,或让我精简后重答。]")
        if timed_out:
            yield ("content", f"\n\n[已达到最大耗时 {MAX_WALL}s,自动停止。]")
            return

        if not has_tool_calls:
            body = "".join(content_parts).strip()
            # 空回合(既无正文也无工具调用)通常是上游抖动,或工具调用参数没解析出来。
            # 中途已经干过活时重试一次,避免"干到一半忽然静默收尾"——面板上就只剩
            # 最后一条工具输出吊在底部,看不到任何结论。
            if not body and iterations > 0 and empty_retries < 1:
                empty_retries += 1
                yield ("content", "\n\n[上一轮模型未返回内容,自动重试一次…]")
                continue
            # 模型认为做完了(edit 都是即时确认, 无批量收尾)
            if not goal:
                if not body and iterations > 0:
                    yield ("content",
                           "\n\n[模型未返回内容,任务已停止;"
                           "可继续发消息让它接着做。]")
                return
            # /goal 目标模式: 无工具调用的回复先核查完成度
            if "GOAL_DONE" in body:
                sess.goal_status = "done"   # 模型自认完成且带标记 → 结束
                return
            if goal_checks >= GOAL_MAX_CHECKS:
                sess.goal_status = "capped"
                yield ("content",
                       f"\n\n[目标核查已达上限({GOAL_MAX_CHECKS} 轮),自动停止。"
                       "目标可能尚未完全达成,请人工检查。]")
                return
            goal_checks += 1
            messages.append({"role": "assistant", "content": body})
            messages.append({"role": "user", "content":
                             "[目标核查] 你的目标是: " + goal[:2000] +
                             "\n请用工具实际验证(运行/检查文件),核实目标是否"
                             "已完全达成。未达成就继续推进剩余工作;"
                             "确认全部完成则在回复最后一行单独写 GOAL_DONE 并总结。"})
            yield ("content",
                   "\n\n[目标模式: AI 自认完成,正在核查目标达成情况"
                   f"({goal_checks}/{GOAL_MAX_CHECKS})…]")
            continue

        # 记录 assistant 消息 + 执行工具
        assistant_msg = {"role": "assistant", "content": "".join(content_parts)}
        assistant_msg["tool_calls"] = [
            {"id": tc["id"], "type": "function",
             "function": {"name": tc["name"],
                          "arguments": json.dumps(tc["arguments"],
                                                  ensure_ascii=False)}}
            for tc in tool_calls_pending]
        messages.append(assistant_msg)
        # 轮内并行: 只读工具与 spawn_agent 用线程池并发执行(一轮发多个
        # read/grep 不再串行等待); pod_bash/edit 涉及用户确认卡
        # (run.action_result 单槽 rendezvous),保持串行按序执行。
        results = {}
        parallel = [tc for tc in tool_calls_pending
                    if tc["name"] in _PARALLEL_TOOLS]
        if parallel:
            import concurrent.futures as cf
            pool = cf.ThreadPoolExecutor(
                max_workers=min(4, len(parallel)))
            try:
                futs = {pool.submit(_exec, tc["name"], tc["arguments"]): tc
                        for tc in parallel}
                for fut in cf.as_completed(futs):
                    tc = futs[fut]
                    try:
                        result = fut.result()
                    except Exception as e:
                        result = f"工具执行失败: {type(e).__name__}: {e}"
                    results[tc["id"]] = result
                    yield ("tool_result", {"tool_call_id": tc["id"],
                                           "name": tc["name"],
                                           "result": result})
            finally:
                pool.shutdown(wait=False)
        if run.stop_event.is_set():
            return
        for tc in tool_calls_pending:
            if run.stop_event.is_set():
                return
            if tc["id"] in results:
                result = results[tc["id"]]
            else:
                result = _exec(tc["name"], tc["arguments"])
                yield ("tool_result", {"tool_call_id": tc["id"],
                                       "name": tc["name"], "result": result})
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": result})
        iterations += 1
        if iterations >= MAX_ITERATIONS:
            yield ("content",
                   f"\n\n[已达到工具调用轮次上限({MAX_ITERATIONS} 轮),"
                   "下面基于已有信息给出最终答复。]")
            messages.append({"role": "user", "content":
                             "[系统提示] 已达到工具调用轮次上限,不能再调用工具。"
                             "请立即基于已收集的信息给出完整、可执行的最终答复。"})
            tools = None  # 后续请求不再带工具定义, 模型只能输出文本
