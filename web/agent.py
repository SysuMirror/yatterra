"""ReAct agent engine for the platform.

Two modes:
  - ops   : runs on the platform host (root). For the audit page.
  - build : runs inside a group's pod (as cloud). For the terminal page.

Protocol (prompted ReAct, model-agnostic):
  The assistant streams text. If it emits a line of the form
      ACTION: {"tool": "...", "args": {...}}
  we execute that tool, feed the result back as a user message, and loop.
  A response with no ACTION line is the final answer.

Harness features:
  - auto-compact: when prompt_tokens exceeds the configured threshold, the
    conversation is compressed into a structured summary and the loop
    continues (deepseek-v4-flash-spark has ~256K context).
  - fan-out/fan-in: a `spawn` tool runs N sub-agents in parallel (each its
    own ReAct loop) and merges their results.

Guardrails:
  - per-command timeout and output truncation (20 KB)
  - loop cap (iters / wall), sub-agent caps
  - ops denylist (catastrophic host commands) -> refused, fed back to the model
  - every tool call recorded via audit.record(...)
  - stop(run_id) aborts a running loop and its sub-agents
"""
import base64
import json
import queue
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import html as _html_mod

import audit
import groups
import siteconf
import remote_hosts
import llm
import agent_conf
import mcp_client
import users



_llm_tls = threading.local()

def _llm_user():
    """Get current username: thread-local (set by run_agent) > Flask session > system."""
    u = getattr(_llm_tls, 'user', None)
    if u:
        return u
    try:
        from flask import session
        return session.get("user", "system")
    except Exception:
        return "system"
OUT_MAX = 20 * 1024

# Agent mode → required global permission. Checked before running.
AGENT_MODE_PERM = {
    "ops":     "infra.host",     # host root commands
    "build":   "group.terminal",  # pod commands (also needs pod access)
    "db":      "infra.db",
    "storage": "infra.storage",
}


def agent_required_perm(agent_def):
    """Return the global permission required to use an agent.
    Built-in ids map via AGENT_MODE_PERM; custom agents derive from runner:
    pod → group.terminal, host → infra.host."""
    if not agent_def:
        return "infra.host"
    aid = agent_def.get("id", "")
    if aid in AGENT_MODE_PERM:
        return AGENT_MODE_PERM[aid]
    return "group.terminal" if agent_def.get("runner") == "pod" else "infra.host"

# --- active runs: run_id -> stop event ---
_RUNS = {}
_RUNS_LOCK = threading.Lock()

# --- live stats for the harness page ---
_STATS = {"active": 0, "peak_tokens": 0, "runs": 0}
_STATS_LOCK = threading.Lock()


def stats():
    with _STATS_LOCK:
        return dict(_STATS)


def stop(run_id):
    with _RUNS_LOCK:
        r = _RUNS.get(run_id)
    if r:
        r.set()


def _should_stop(run_id):
    with _RUNS_LOCK:
        r = _RUNS.get(run_id)
    return bool(r and r.is_set())


def _bump_peak(tokens):
    if not tokens:
        return
    with _STATS_LOCK:
        if tokens > _STATS["peak_tokens"]:
            _STATS["peak_tokens"] = tokens


# --- ops denylist ---
_DENY_PATTERNS = [
    r"\brm\s+-rf\s+/(?:\s|$)",
    r"\brm\s+-rf\s+/\*",
    # rm -rf on top-level system dirs (exact dir, not subpaths underneath)
    r"\brm\s+-rf\s+/(opt|home|etc|var|mnt|root|usr|boot|lib|lib64|bin|sbin|srv)(?:/?(?:\s|$))",
    r":\s*\(\)\s*\{\s*:\s*\|\s*&\s*\}",
    r"\b(reboot|shutdown|halt|poweroff|init\s+0)\b",
    r"\bmkfs(?:\.\w+)?\b",
    r"\bdd\b.*\bof=/dev/",
    # stop/restart/disable of the web UI itself (self-decapitation mid-run)
    r"\bsystemctl\s+(?:stop|restart|disable)\s+yatterra-web\b",
    # stop/disable of k3s / public backbone (restart left allowed for remediation)
    r"\bsystemctl\s+(?:stop|disable)\s+(?:k3s|frps|frpc)\b",
    r"\bkubectl\s+(delete|edit|apply|patch)\b",
    r">\s*/dev/sda",
]
_DENY_RE = [re.compile(p) for p in _DENY_PATTERNS]


def _ops_denied(cmd):
    for rx in _DENY_RE:
        if rx.search(cmd):
            return True
    return False


# --- tool execution ---
def _trunc(s, cap=OUT_MAX):
    if len(s) > cap:
        return s[:cap] + f"\n...[截断,共 {len(s)} 字节]"
    return s


def _run_host(cmd, timeout=30, out_max=OUT_MAX):
    """Run a command on the platform host as root."""
    if _ops_denied(cmd):
        return False, "【被安全策略拒绝:该命令在 ops 模式下禁用。换一种只读/安全的方式。】"
    try:
        p = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        out = (p.stdout or "") + (p.stderr or "")
        if p.returncode != 0:
            out += f"\n[exit={p.returncode}]"
        return True, _trunc(out, out_max)
    except subprocess.TimeoutExpired:
        return False, f"[命令超时 {timeout}s]"
    except Exception as e:
        return False, f"[执行异常: {e!r}]"


def _resolve_pod(name):
    r = groups.kubectl(
        "get", "pod", "-l", f"app=group-{name}",
        "-o", "jsonpath={.items[0].metadata.name}", check=False,
    )
    if r.returncode != 0 or not r.stdout:
        return None
    return r.stdout.strip()


def _run_in_pod(pod, cmd, timeout=30, out_max=OUT_MAX):
    """Run a command in the pod as cloud."""
    if _ops_denied(cmd):
        return False, "【被安全策略拒绝:该命令在安全策略下禁用。换一种只读/安全的方式。】"
    try:
        p = subprocess.run(
            ["kubectl", "-n", groups.NS, "exec", pod, "--", "su", "-l", "cloud", "-c", cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        out = (p.stdout or "") + (p.stderr or "")
        if p.returncode != 0:
            out += f"\n[exit={p.returncode}]"
        return True, _trunc(out, out_max)
    except subprocess.TimeoutExpired:
        return False, f"[命令超时 {timeout}s]"
    except Exception as e:
        return False, f"[执行异常: {e!r}]"


def _read_file_in_pod(pod, path, out_max=OUT_MAX):
    import shlex
    ok, out = _run_in_pod(pod, f"cat {shlex.quote(path)}", out_max=out_max)
    return ok, out


def _write_file_in_pod(pod, path, content, out_max=OUT_MAX):
    b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
    cmd = (
        f"python3 -c "
        f"\"import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))\" "
        f"{path} {b64}"
    )
    return _run_in_pod(pod, cmd, out_max=out_max)


# --- web search (Bing HTML scrape; no API key, works from datacenter IP) ---
_BING_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
_BING_BLOCK_RE = re.compile(
    r'<li class="b_algo"[^>]*>(.*?)</li>\s*(?=<li class="b_algo"|</ol>)', re.S)
_BING_LINK_RE = re.compile(
    r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_BING_SNIP_RE = re.compile(r'<p[^>]*>(.*?)</p>', re.S)


def _web_search(query, num=5, timeout=12, out_max=OUT_MAX):
    """Search Bing and return (ok, text). Text is a numbered result list.
    cn.bing.com serves real organic results to datacenter IPs without auth.
    """
    q = (query or "").strip()
    if not q:
        return False, "【空查询】"
    num = max(1, min(int(num or 5), 10))
    url = "https://cn.bing.com/search?" + urllib.parse.urlencode(
        {"q": q, "count": str(num)})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _BING_UA,
                                                   "Accept-Language": "zh-CN,en;q=0.8"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "ignore")
    except Exception as e:
        return False, f"【搜索请求失败: {e!r}】"

    def clean(s):
        return _html_mod.unescape(re.sub(r'<[^>]+>', '', s)).strip()

    rows = []
    for b in _BING_BLOCK_RE.findall(body):
        m = _BING_LINK_RE.search(b)
        if not m:
            continue
        link, title = m.group(1), clean(m.group(2))
        if not title:
            continue
        sn = _BING_SNIP_RE.search(b)
        snippet = clean(sn.group(1)) if sn else ""
        rows.append((title, link, snippet))
        if len(rows) >= num:
            break

    if not rows:
        return True, f"【无结果。查询: {q}】"
    out = f"查询: {q}（{len(rows)} 条）\n" + "\n".join(
        f"{i+1}. {t}\n   {u}\n   {s}" for i, (t, u, s) in enumerate(rows))
    return True, _trunc(out, out_max)


# --- fetch_url / edit_file / grep / list_dir ---
# fetch_url: pull a page, strip HTML -> plain text. Runs on host (pod may lack egress).
def _fetch_url(url, timeout=12, out_max=OUT_MAX):
    u = (url or "").strip()
    if not u:
        return False, "【空 URL】"
    if not re.match(r"^https?://", u, re.I):
        return False, "【URL 需以 http:// 或 https:// 开头】"
    try:
        req = urllib.request.Request(u, headers={"User-Agent": _BING_UA,
                                                  "Accept-Language": "zh-CN,en;q=0.8"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(2 * 1024 * 1024).decode("utf-8", "ignore")
    except Exception as e:
        return False, f"【请求失败: {e!r}】"
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S | re.I)
    body = re.sub(r"<[^>]+>", "", body)
    body = _html_mod.unescape(body)
    body = re.sub(r"[ \t]+", " ", body)
    body = re.sub(r"\n\s*\n+", "\n", body)
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    return True, _trunc("\n".join(lines), out_max)


# Embedded python scripts for grep/list_dir/edit_file. Run via a base64 bootstrap
# to avoid shell-quoting pain (scripts + args are all base64 on the argv).
_GREP_PY = """
import base64,sys,re,os,fnmatch
A=sys.argv
D=lambda i: base64.b64decode(A[i]).decode('utf-8','ignore') if len(A)>i and A[i] else ''
pat=D(2); root=D(3) or '.'; glob=D(4)
try: mx=int(D(5) or 200)
except ValueError: mx=200
try:
    rx=re.compile(pat)
except re.error as e:
    print('【正则错误: %s】'%e); sys.exit(0)
n=0
for dp,dirs,files in os.walk(root):
    try:
        dirs[:]=[d for d in dirs if not d.startswith('.')]
    except OSError:
        dirs[:]=[]
    for fn in files:
        if glob and not fnmatch.fnmatch(fn,glob): continue
        fp=os.path.join(dp,fn)
        try:
            with open(fp,'r',encoding='utf-8',errors='ignore') as f:
                for i,line in enumerate(f,1):
                    if rx.search(line):
                        s=line.rstrip()
                        if len(s)>300: s=s[:300]+' …'
                        print('%s:%d:%s'%(fp,i,s)); n+=1
                        if n>=mx: sys.exit(0)
        except OSError: pass
if n==0: print('【无匹配】')
"""

_LISTDIR_PY = """
import base64,sys,os
A=sys.argv
D=lambda i: base64.b64decode(A[i]).decode('utf-8','ignore') if len(A)>i and A[i] else ''
root=D(2) or '.'
try: md=int(D(3) or 2)
except ValueError: md=2
try: me=int(D(4) or 200)
except ValueError: me=200
n=[0]
def walk(p,d):
    if n[0]>=me: return
    try:
        es=sorted(os.listdir(p))
    except OSError as e:
        print('  '*d+'[错误: %s]'%e); return
    for e in es:
        if n[0]>=me: return
        n[0]+=1
        fp=os.path.join(p,e)
        isd=os.path.isdir(fp)
        sz=''
        if not isd:
            try: sz='  (%dB)'%os.path.getsize(fp)
            except OSError: pass
        print('  '*d+('[d] ' if isd else '    ')+e+sz)
        if isd and d<md and not e.startswith('.'):
            walk(fp,d+1)
if not os.path.exists(root):
    print('【路径不存在: %s】'%root); sys.exit(0)
print(root+'/'); walk(root,1)
if n[0]>=me: print('...[已达 %d 条上限]'%me)
"""

_EDIT_PY = """
import base64,sys
A=sys.argv
D=lambda i: base64.b64decode(A[i]).decode('utf-8','ignore') if len(A)>i and A[i] else ''
path=D(2); old=D(3); new=D(4)
if not path:
    print('【空 path】'); sys.exit(0)
try:
    with open(path,'r',encoding='utf-8') as f: c=f.read()
except OSError as e:
    print('【读失败: %s】'%e); sys.exit(0)
if old not in c:
    print('【未找到要替换的 old 片段。确认 path 与 old(注意缩进/空格)。】'); sys.exit(0)
cnt=c.count(old)
if cnt>1:
    print('【old 在文件中出现 %d 次,拒绝替换(避免改错)。请扩大 old 上下文使其唯一,或分多次改。】'%cnt); sys.exit(0)
c=c.replace(old,new,1)
try:
    with open(path,'w',encoding='utf-8') as f: f.write(c)
except OSError as e:
    print('【写失败: %s】'%e); sys.exit(0)
print('已替换 1 处')
"""


def _runner_for(runner, pod, timeout):
    """Return a callable(cmd, out_max) -> (ok, out) that runs in the runner's context.
    runner is 'host' (platform host, root) or 'pod' (group pod, cloud)."""
    if runner == "pod":
        return lambda cmd, out_max: _run_in_pod(pod, cmd, timeout, out_max)
    return lambda cmd, out_max: _run_host(cmd, timeout, out_max)


def _read_file_host(path, out_max=OUT_MAX):
    """Read a file on the host directly (no shell, no injection risk)."""
    path = (path or "").strip()
    if not path:
        return False, "空路径"
    if ".." in path or not path.startswith("/"):
        return False, "安全限制: 仅允许绝对路径且不含 .."
    try:
        with open(path, errors='replace') as f:
            content = f.read(out_max)
        return True, _trunc(content, out_max)
    except OSError as e:
        return False, f"读取失败: {e}"


def _write_file_host(path, content, out_max=OUT_MAX):
    b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
    cmd = (
        f"python3 -c "
        f"\"import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))\" "
        f"{path} {b64}"
    )
    return _run_host(cmd, 30, out_max)


def _pytool(script, args, runner, out_max):
    """Run an embedded python script via base64 bootstrap (no shell quoting issues).
    argv inside the script: [0]='-c' [1]=script_b64 [2:]=our base64 args.
    """
    parts = [base64.b64encode(script.encode("utf-8")).decode("ascii")]
    parts += [base64.b64encode(str(a).encode("utf-8")).decode("ascii") for a in args]
    cmd = ('python3 -c "import base64,sys;exec(base64.b64decode(sys.argv[1]).decode())" '
           + " ".join(parts))
    return runner(cmd, out_max)


def _grep(runner, pod, pattern, path, glob, max_lines, timeout, out_max):
    runner_fn = _runner_for(runner, pod, timeout)
    return _pytool(_GREP_PY, [pattern, path or ".", glob or "",
                              int(max_lines or 200)], runner_fn, out_max)


def _list_dir(runner, pod, path, depth, max_entries, timeout, out_max):
    runner_fn = _runner_for(runner, pod, timeout)
    return _pytool(_LISTDIR_PY, [path or ".", int(depth or 2),
                                 int(max_entries or 200)], runner_fn, out_max)


def _edit_file(runner, pod, path, old, new, timeout, out_max):
    runner_fn = _runner_for(runner, pod, timeout)
    return _pytool(_EDIT_PY, [path, old, new], runner_fn, out_max)


def _tool_enabled(agent_def, tool):
    """Check whether a tool is enabled for this agent (default True if unspecified)."""
    return (agent_def or {}).get("tools", {}).get(tool, True)


def _exec_mcp_tool(agent_def, tool, args, cfg, run_id, user=None):
    """Dispatch an mcp__<server>__<tool> call. Returns (ok, output)."""
    if not users.has_perm(user, "dev.mcp"):
        return False, "【无 dev.mcp 权限,不能调用 MCP 工具】"
    out_max = cfg["limits"]["out_max_kb"] * 1024
    parts = tool.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return False, f"非法 MCP 工具名: {tool}"
    _prefix, server, tool_name = parts
    attached = (agent_def or {}).get("mcp", []) or []
    if server not in attached:
        return False, f"【MCP 服务 {server} 未挂载到该 agent】"
    if run_id is None:
        return False, f"【MCP 工具 {tool} 无运行上下文(run_id)】"
    try:
        run = mcp_client.get_mcp_run(run_id)
        out = run.call(server, tool_name, args or {})
    except mcp_client.McpError as e:
        return False, f"【MCP {server}.{tool_name} 失败: {e}】"
    except Exception as e:
        return False, f"【MCP {server}.{tool_name} 异常: {e!r}】"
    if isinstance(out, str) and len(out) > out_max:
        out = out[:out_max] + f"\n…[截断,共 {len(out)} 字符]"
    return True, out


def _mcp_prompt_section(agent_def, run_id, user=None):
    """Build a doc section listing MCP tools attached to this agent.
    Connects (lazily) to each enabled attached server via the run's McpRun.
    Failures are noted but never block the run. Returns a string (possibly empty)."""
    if not users.has_perm(user, "dev.mcp"):
        return ""
    attached = (agent_def or {}).get("mcp", []) or []
    if not attached:
        return ""
    lines = ["", "## 可用 MCP 工具(工具名前缀 mcp__<服务>__)"]
    any_ok = False
    try:
        run = mcp_client.get_mcp_run(run_id)
    except Exception:
        return ""
    for name in attached:
        srv = mcp_client.get_server(name)
        if not srv:
            lines.append(f"- ⚠ MCP 服务 {name} 不存在(已从注册表移除?)")
            continue
        if not srv.get("enabled"):
            lines.append(f"- ⚠ MCP 服务 {name} 已禁用")
            continue
        try:
            tools = run.list_tools(name)
        except Exception as e:
            lines.append(f"- ⚠ MCP 服务 {name} 连接失败: {e}")
            continue
        any_ok = True
        for t in tools:
            tn = t.get("name", "?")
            desc = (t.get("description") or "").strip().splitlines()[0][:160]
            schema = t.get("inputSchema") or {}
            props = schema.get("properties", {}) if isinstance(schema, dict) else {}
            required = set(schema.get("required", []) if isinstance(schema, dict) else [])
            if props:
                argstr = ", ".join(
                    f"{p}{'*' if p in required else ''}"
                    for p in props.keys()
                )
                lines.append(f"- mcp__{name}__{tn}({argstr}): {desc}")
            else:
                lines.append(f"- mcp__{name}__{tn}: {desc}")
    if not any_ok:
        lines.append("(没有可用的 MCP 工具)")
    lines.append("调用方式同其他工具:ACTION: {\"tool\": \"mcp__服务__工具\", \"args\": {...}}")
    return "\n".join(lines)


# ----------------------------- harness optimize (shared by route + tool) -----------------------------
def optimize_harness(doc, agents, prompt, mode="optimize"):
    """AI harness generation/optimization. Returns (ok, result).
    ok=True -> result is new_doc dict; ok=False -> result is error string."""
    agent_ids = ", ".join(a.get("id", "") for a in agents)
    agent_blurb = "\n".join(
        f"- {a.get('id','')}: {a.get('label','')} (runner={a.get('runner','host')})"
        for a in agents)
    if mode == "design":
        sys_prompt = (
            "你是 harness 设计器。根据用户的需求描述,从零设计一个低代码编排 DAG(harness),选用合适的 agent 组成节点并连线。\n"
            "设计原则:能并行的检查拆成并行节点(无依赖),最后用 fan-in 汇总节点合并上游输出(其 goal 里用 {{upstream}} 引用上游结果);"
            "每个节点 goal 要具体、可执行(写清该 agent 该做什么);x/y 坐标分层布局(同层 y 相同,汇总节点在下方)。\n"
            "可用 agent:\n" + agent_blurb + "\n"
            "节点结构: {id, agent, goal, x, y, group?}; 边: {from, to}。pod runner 的 agent 才需要 group。\n"
            "节点可选字段: retry/on_fail/condition/fanout/output_key。多组巡检优先用 fanout=\"groups\"。\n"
            "**严格只输出一个 JSON 对象**(以 { 开头、} 结尾,不要 markdown 代码块、不要解释文字),形如:\n"
            '{"name":"...","nodes":[...],"edges":[...]}'
        )
        user_msg = "需求描述:\n" + (prompt or "(用户未填,请按平台常规巡检设计一个 db+storage 并行→ops 汇总的健康检查 harness)") + "\n\n可用 agent:\n" + json.dumps(agents, ensure_ascii=False, indent=2)
    else:
        sys_prompt = (
            "你是 harness 优化器。给定一个低代码编排 DAG(harness)和可用 agent 列表,产出一个**优化后**的 harness JSON。\n"
            "优化方向:增加并行度、补全易遗漏的检查项、改进各节点 goal 措辞、合理设置 fan-in 汇总节点。保持节点 id 稳定,x/y 坐标合理布局。\n"
            "可用 agent id: " + agent_ids + "\n"
            "节点结构: {id, agent, goal, x, y, group?}; 边: {from, to}。\n"
            "节点可选字段: retry/on_fail(continue|skip_downstream|abort)/condition/fanout(\"groups\"|[items])/output_key。\n"
            "**严格只输出一个 JSON 对象**(以 { 开头、} 结尾,不要 markdown 代码块、不要解释文字),形如:\n"
            '{"name":"...","nodes":[...],"edges":[...]}'
        )
        user_msg = "当前 harness:\n" + json.dumps(doc, ensure_ascii=False, indent=2) + "\n\n可用 agent:\n" + json.dumps(agents, ensure_ascii=False, indent=2)
        if prompt:
            user_msg += "\n\n额外要求: " + prompt
    try:
        raw = llm.chat([{"role": "user", "content": user_msg}], system=sys_prompt, max_tokens=3072, caller=f"optimize:{mode}", user=_llm_user())
    except llm.LLMError as e:
        return False, f"LLM 错误: {e}"
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[-1]
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    i = s.find("{")
    if i == -1:
        return False, "AI 未返回 JSON"
    depth = 0; j = i; in_str = False; esc = False; end = -1
    while j < len(s):
        c = s[j]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: end = j; break
        j += 1
    if end == -1:
        return False, "AI 返回的 JSON 不完整"
    try:
        return True, json.loads(s[i:end + 1])
    except json.JSONDecodeError as e:
        return False, f"JSON 解析失败: {e}"


_PLATFORM_TOOLS_DOC = """
## 平台管理工具(始终可用,用于编排/harness/MCP 管理)
- list_harnesses(): 列出所有 harness 名字。ACTION: {"tool":"list_harnesses","args":{}}
- read_harness(name): 读取一个 harness 的完整 JSON(节点/边)。ACTION: {"tool":"read_harness","args":{"name":"health"}}
- write_harness(name, doc): 保存 harness。doc 是完整 harness 对象(含 name/nodes/edges)。ACTION: {"tool":"write_harness","args":{"name":"x","doc":{...}}}
- optimize_harness(name, prompt?): 用 AI 优化已有 harness 并保存,返回摘要。ACTION: {"tool":"optimize_harness","args":{"name":"health","prompt":"增加并行度"}}
- list_agents(): 列出所有 agent 及其挂载的 MCP。ACTION: {"tool":"list_agents","args":{}}
- list_mcp(): 列出所有 MCP 服务。ACTION: {"tool":"list_mcp","args":{}}
- add_mcp(name, transport, command?, url?, env?, headers?, enabled?): 新增/更新一个 MCP 服务并保存。transport 为 "stdio" 或 "http"。ACTION: {"tool":"add_mcp","args":{"name":"fetch","transport":"stdio","command":["npx","-y","@modelcontextprotocol/server-everything"]}}
- attach_mcp(agent_id, mcp_name): 把一个 MCP 服务挂到某 agent(追加到其 mcp 列表)。ACTION: {"tool":"attach_mcp","args":{"agent_id":"build","mcp_name":"fetch"}}
"""


def _platform_tools_prompt(user=None):
    if not users.has_perm(user, "dev.harness"):
        return ""
    return _PLATFORM_TOOLS_DOC


def _exec_platform_tool(tool, args, cfg, user=None):
    """Dispatch a platform-management tool. Returns (ok, output)."""
    if not users.has_perm(user, "dev.harness"):
        return False, "【无 dev.harness 权限,不能调用平台管理工具】"
    out_max = cfg["limits"]["out_max_kb"] * 1024
    try:
        _uname = (user or {}).get("username", "")
        if tool == "list_harnesses":
            return True, json.dumps(agent_conf.list_harnesses(_uname), ensure_ascii=False)
        if tool == "read_harness":
            name = (args.get("name") or "").strip()
            doc = agent_conf.load_harness(name, _uname)
            if not doc:
                return False, f"harness {name} 不存在"
            return True, json.dumps(doc, ensure_ascii=False)
        if tool == "write_harness":
            name = (args.get("name") or "").strip()
            doc = args.get("doc")
            if isinstance(doc, str):
                doc = json.loads(doc)
            if not name or not isinstance(doc, dict):
                return False, "需要 name 和 doc(对象)"
            agent_conf.save_harness(name, doc, _uname)
            n = len(doc.get("nodes", []))
            return True, f"已保存 harness {name}({n} 节点)"
        if tool == "optimize_harness":
            name = (args.get("name") or "").strip()
            prompt = (args.get("prompt") or "").strip()
            doc = agent_conf.load_harness(name, _uname)
            if not doc:
                return False, f"harness {name} 不存在"
            agents = agent_conf.load_agents()
            ok, res = optimize_harness(doc, agents, prompt, "optimize")
            if not ok:
                return False, f"优化失败: {res}"
            agent_conf.save_harness(name, res, _uname)
            n = len(res.get("nodes", []))
            return True, f"已优化并保存 harness {name}({n} 节点)"
        if tool == "list_agents":
            return True, json.dumps([{"id": a["id"], "label": a["label"],
                     "runner": a["runner"], "mcp": a.get("mcp", [])}
                    for a in agent_conf.load_agents()], ensure_ascii=False)
        if tool == "list_mcp":
            return True, json.dumps([{"name": s["name"], "transport": s["transport"],
                     "enabled": s["enabled"]} for s in mcp_client.load_servers()], ensure_ascii=False)
        if tool == "add_mcp":
            srv = {"name": (args.get("name") or "").strip(),
                   "transport": args.get("transport", "stdio"),
                   "enabled": bool(args.get("enabled", True)),
                   "command": args.get("command") or [], "url": args.get("url") or "",
                   "env": args.get("env") or {}, "headers": args.get("headers") or {},
                   "init_timeout": args.get("init_timeout", 60),
                   "call_timeout": args.get("call_timeout", 60)}
            if not srv["name"]:
                return False, "name 必填"
            servers = [s for s in mcp_client.load_servers() if s["name"] != srv["name"]]
            servers.append(srv)
            mcp_client.save_servers(servers)
            return True, f"已保存 MCP 服务 {srv['name']}({srv['transport']})"
        if tool == "attach_mcp":
            aid = (args.get("agent_id") or "").strip()
            mname = (args.get("mcp_name") or "").strip()
            agents = agent_conf.load_agents()
            found = False
            for a in agents:
                if a["id"] == aid:
                    mcp = a.get("mcp", []) or []
                    if mname not in mcp:
                        mcp.append(mname)
                    a["mcp"] = mcp
                    found = True
                    break
            if not found:
                return False, f"agent {aid} 不存在"
            agent_conf.save_agents(agents)
            return True, f"已把 MCP {mname} 挂到 agent {aid}"
    except Exception as e:
        return False, f"【{tool} 异常: {e!r}】"
    return None  # not a platform tool


# set of platform tool names (for fast membership check)
_PLATFORM_TOOLS = {"list_harnesses", "read_harness", "write_harness", "optimize_harness",
                   "list_agents", "list_mcp", "add_mcp", "attach_mcp"}


def _exec_inspect(resource, name=None, namespace=None, filter_str=None, tail=50):
    """Structured k8s resource query. Returns (ok, output).
    resource: pods|services|events|logs|nodes|deployments
    name: specific resource name (omit for list)
    filter_str: grep pattern (case-insensitive)
    tail: max output lines (default 50)
    """
    resource = (resource or "").strip().lower()
    name = (name or "").strip()
    namespace = (namespace or siteconf.GROUP_NS).strip()
    filter_str = (filter_str or "").strip()
    tail = max(1, min(500, int(tail or 50)))

    # build kubectl command
    if resource == "pods":
        if name:
            cmd = f"kubectl describe pod {name} -n {namespace}"
        else:
            cmd = f"kubectl get pods -n {namespace} -o wide"
    elif resource == "services":
        if name:
            cmd = f"kubectl describe svc {name} -n {namespace}"
        else:
            cmd = f"kubectl get svc -n {namespace}"
    elif resource == "events":
        if filter_str and filter_str.lower() in ("warning", "warn", "normal"):
            cmd = f"kubectl get events -n {namespace} --field-selector type={filter_str.capitalize()}"
        else:
            cmd = f"kubectl get events -n {namespace} --sort-by=.lastTimestamp"
    elif resource == "logs":
        if not name:
            return False, "【inspect logs 需要指定 name(pod 名)】"
        # fetch more lines then filter, so filter hits more context
        fetch_lines = min(tail * 4, 2000)
        cmd = f"kubectl logs {name} -n {namespace} --tail={fetch_lines}"
    elif resource == "nodes":
        if name:
            cmd = f"kubectl describe node {name}"
        else:
            cmd = "kubectl get nodes -o wide"
    elif resource == "deployments":
        if name:
            cmd = f"kubectl describe deploy {name} -n {namespace}"
        else:
            cmd = f"kubectl get deploy -n {namespace}"
    else:
        return False, f"【inspect 不支持 resource={resource}，可用: pods/services/events/logs/nodes/deployments】"

    ok, out = _run_host(cmd, timeout=30, out_max=100 * 1024)
    if not ok:
        return ok, out

    # apply filter
    if filter_str and resource != "events":  # events filter applied via field-selector
        import re
        pattern = re.compile(filter_str, re.IGNORECASE)
        lines = [l for l in out.splitlines() if pattern.search(l)]
        out = "\n".join(lines)

    # apply tail
    lines = out.splitlines()
    if len(lines) > tail:
        out = "\n".join(lines[-tail:]) + f"\n... (共 {len(lines)} 行，显示最后 {tail} 行)"

    return True, out


def _exec_tool(agent_def, pod, tool, args, cfg, run_id=None, user=None):
    """Execute one tool for a parent/sub/node agent. Returns (ok, output)."""
    if tool.startswith("mcp__"):
        return _exec_mcp_tool(agent_def, tool, args, cfg, run_id, user=user)
    if tool in _PLATFORM_TOOLS:
        return _exec_platform_tool(tool, args or {}, cfg, user=user)
    if not _tool_enabled(agent_def, tool):
        return False, f"【{tool} 已在该 agent 配置中禁用】"
    out_max = cfg["limits"]["out_max_kb"] * 1024
    runner = (agent_def or {}).get("runner", "host")
    if tool == "run":
        cmd = args.get("command", "")
        if runner == "pod":
            return _run_in_pod(pod, cmd, cfg["limits"]["cmd_timeout"], out_max)
        return _run_host(cmd, cfg["limits"]["cmd_timeout"], out_max)
    if tool == "run_remote":
        if runner == "pod":
            return False, "【run_remote 仅限宿主机 agent(ops),pod agent 不可用】"
        if not users.has_perm(user, "infra.host"):
            return False, "【无 infra.host 权限,不能执行远程命令】"
        rname = args.get("host", "")
        cmd = args.get("command", "")
        if _ops_denied(cmd):
            return False, "【被安全策略拒绝:该命令在远程执行下禁用。换一种只读/安全的方式。】"
        ok, out = remote_hosts.run_remote(
            rname, cmd, sudo=bool(args.get("sudo", False)),
            timeout=cfg["limits"]["cmd_timeout"])
        return ok, _trunc(out, out_max)
    if tool == "read_file":
        if runner == "pod":
            return _read_file_in_pod(pod, args.get("path", ""), out_max)
        return _read_file_host(args.get("path", ""), out_max)
    if tool == "write_file":
        if runner == "pod":
            return _write_file_in_pod(pod, args.get("path", ""), args.get("content", ""), out_max)
        return _write_file_host(args.get("path", ""), args.get("content", ""), out_max)
    if tool == "web_search":
        return _web_search(args.get("query", ""), args.get("num", 5),
                           cfg["limits"]["cmd_timeout"], out_max)
    if tool == "fetch_url":
        return _fetch_url(args.get("url", ""), cfg["limits"]["cmd_timeout"], out_max)
    if tool == "edit_file":
        return _edit_file(runner, pod, args.get("path", ""), args.get("old", ""),
                          args.get("new", ""), cfg["limits"]["cmd_timeout"], out_max)
    if tool == "grep":
        return _grep(runner, pod, args.get("pattern", ""), args.get("path", "."),
                     args.get("glob", ""), args.get("max_lines", 200),
                     cfg["limits"]["cmd_timeout"], out_max)
    if tool == "list_dir":
        return _list_dir(runner, pod, args.get("path", "."), args.get("depth", 2),
                         args.get("max_entries", 200), cfg["limits"]["cmd_timeout"], out_max)
    if tool == "inspect":
        if runner == "pod":
            return False, "【inspect 仅限宿主机 agent,pod agent 请用 run+grep】"
        return _exec_inspect(
            resource=args.get("resource", ""),
            name=args.get("name"),
            namespace=args.get("namespace", siteconf.GROUP_NS),
            filter_str=args.get("filter"),
            tail=args.get("tail", 50),
        )
    if tool == "memory_save":
        try:
            import agent_memory
            ns = args.get("namespace", "") or (agent_def or {}).get("id", "default")
            agent_memory.save(ns, args.get("key", ""), args.get("value", ""))
            return True, "已保存"
        except Exception as e:
            return False, f"memory_save 失败: {e}"
    if tool == "memory_load":
        try:
            import agent_memory
            ns = args.get("namespace", "") or (agent_def or {}).get("id", "default")
            val = agent_memory.load(ns, args.get("key", ""))
            return (True, val) if val is not None else (True, "【无此记忆】")
        except Exception as e:
            return False, f"memory_load 失败: {e}"
    if tool == "memory_list":
        try:
            import agent_memory
            ns = args.get("namespace", "") or (agent_def or {}).get("id", "default")
            keys = agent_memory.list_keys(ns)
            if not keys:
                return True, "【无记忆】"
            lines = [f"{k['key']}  ({k['ts'][:16]})  {k['value'][:80]}" for k in keys]
            return True, "\n".join(lines)
        except Exception as e:
            return False, f"memory_list 失败: {e}"
    if tool == "vision":
        # Vision tool: analyze an image using Qwen's vision capability
        image_base64 = args.get("image", "")
        prompt = args.get("prompt", "请描述这张图片的内容")
        if not image_base64:
            return False, "【vision 需要提供 image (base64) 参数】"
        try:
            import ai_service
            result = ai_service.analyze_image(image_base64, prompt, user=_llm_user())
            return True, result
        except Exception as e:
            return False, f"【vision 失败: {e}】"
    if tool == "ai_chat":
        # Direct AI chat tool (for sub-questions, analysis, etc.)
        prompt = args.get("prompt", "")
        system = args.get("system", "")
        if not prompt:
            return False, "【ai_chat 需要提供 prompt 参数】"
        try:
            import ai_service
            result = ai_service.quick_chat(prompt, system=system, user=_llm_user())
            return True, result
        except Exception as e:
            return False, f"【ai_chat 失败: {e}】"
    if tool == "screenshot":
        # Take a screenshot via Playwright MCP (web-use)
        url = args.get("url", "")
        if not url:
            return False, "【screenshot 需要提供 url 参数】"
        try:
            import mcp_client
            run = mcp_client.get_mcp_run(run_id or "screenshot")
            # Navigate first
            run.call("playwright", "browser_navigate", {"url": url})
            # Take screenshot
            result = run.call("playwright", "browser_screenshot", {})
            return True, result
        except Exception as e:
            return False, f"【screenshot 失败: {e}】"
    # ── Web automation tools (Playwright MCP) ──
    if tool == "browser_navigate":
        url = args.get("url", "")
        if not url:
            return False, "【browser_navigate 需要提供 url 参数】"
        try:
            import mcp_client
            run = mcp_client.get_mcp_run(run_id or "browser")
            result = run.call("playwright", "browser_navigate", {"url": url})
            return True, f"已导航到 {url}" + (f"\n{result}" if result else "")
        except Exception as e:
            return False, f"【browser_navigate 失败: {e}】"
    if tool == "browser_click":
        selector = args.get("selector", "")
        if not selector:
            return False, "【browser_click 需要提供 selector 参数(CSS 选择器)】"
        try:
            import mcp_client
            run = mcp_client.get_mcp_run(run_id or "browser")
            result = run.call("playwright", "browser_click", {"selector": selector})
            return True, f"已点击 {selector}" + (f"\n{result}" if result else "")
        except Exception as e:
            return False, f"【browser_click 失败: {e}】"
    if tool == "browser_fill":
        selector = args.get("selector", "")
        value = args.get("value", "")
        if not selector:
            return False, "【browser_fill 需要提供 selector 参数(CSS 选择器)】"
        try:
            import mcp_client
            run = mcp_client.get_mcp_run(run_id or "browser")
            result = run.call("playwright", "browser_fill", {"selector": selector, "value": value})
            return True, f"已填写 {selector} = {value}" + (f"\n{result}" if result else "")
        except Exception as e:
            return False, f"【browser_fill 失败: {e}】"
    if tool == "browser_screenshot":
        # Standalone screenshot (no navigate first)
        try:
            import mcp_client
            run = mcp_client.get_mcp_run(run_id or "browser")
            result = run.call("playwright", "browser_screenshot", {})
            return True, result or "截图完成"
        except Exception as e:
            return False, f"【browser_screenshot 失败: {e}】"
    return False, f"未知工具: {tool}"


# --- system prompts ---
_PLATFORM_CTX = (f"平台背景:k3s 单节点(命名空间 {siteconf.GROUP_NS}),每组一个 ubuntu:24.04 容器,"
                 f"经 NodePort→frpc→{siteconf.DOMAIN} 公网。容器登录用户 "
                 f"{siteconf.CLOUD_USER}(uid {siteconf.CLOUD_UID},NOPASSWD sudo)。组索引 i:SSH 公网 "
                 f"{siteconf.SSH_PUBLIC_BASE}+i,web 公网 {siteconf.WEB_PUBLIC_BASE}+i,"
                 f"GUI {siteconf.PLATFORM_GUI_PORT}。状态文件 {siteconf.path('groups.json')},"
                 f"审计 {siteconf.path('audit.log')}。")

_SPAWN_DOC_OPS = """- spawn(tasks): 并行启动多个子 agent,每个子任务形如 {"goal":"...","context":"..."}。用于按组并行巡检、按关注点(网络/磁盘/GPU/审计)并行诊断。子 agent 各自跑命令并返回摘要,fan-in 后你整合成报告。"""

_SPAWN_DOC_BUILD = """- spawn(tasks): 并行启动多个子 agent,每个子任务形如 {"goal":"...","context":"..."}。用于按组件拆分(后端/前端/测试/文档各一个子 agent)、按文件并行写。子 agent 各自跑命令/改文件并返回摘要,fan-in 后你整合。"""

_SEARCH_DOC = """- web_search(query, num?): 用 Bing 联网搜索(无需 key),返回前 num(默认 5,最多 10)条结果(标题/URL/摘要)。用于查官方文档、报错信息、库用法、最新 API。注意:只读,返回的是结果列表,要读具体页面内容仍需自己用 run 拉取(如 curl)。"""

_FETCH_DOC = """- fetch_url(url): 抓取网页/API,去标签转纯文本返回(限 20KB)。用于读 web_search 找到的文档正文、报错页、API JSON 响应。只读,在宿主机侧发请求(容器可能无外网)。"""

_EDIT_DOC = """- edit_file(path, old, new): 在文件里把 old 精确替换成 new。要求 old 在文件中**唯一**出现,否则拒绝(避免改错)——多改几处就分多次调,或扩大 old 上下文使其唯一。改局部首选它,比 write_file 整文件覆写安全得多。"""

_GREP_DOC = """- grep(pattern, path?, glob?, max_lines?): 递归正则搜索文件,返回 path:line:内容 列表。pattern 是正则,path 默认当前目录,glob 限文件名(如 *.py),max_lines 默认 200。用于找定义/引用/报错关键字。只读。"""

_LISTDIR_DOC = """- list_dir(path?, depth?, max_entries?): 列目录树,path 默认当前目录,depth 默认 2,max_entries 默认 200。用于看项目结构。只读。"""

_REMOTE_DOC = """- run_remote(host, command, sudo?): 在已登记的远程主机(spark=ssedgx DGX 推理机, ssemarket=公网中继盒)上经 SSH 执行命令,返回 stdout+stderr。host 必须是 remote_hosts.json 里登记的名字。sudo=true 时以 root 提权(密码由平台注入,你不需要也不可见)。用于远程巡检(df/du/journalctl/docker ps/free)和远程处置(清日志、重启 frps、docker compose restart 等)。同样受 ops denylist 约束(reboot/rm -rf // /mkfs/dd 等会被拒)。远程主机是关键设施(spark 跑 vllm、ssemarket 是公网骨干),改前先只读观察,动作要小步可逆。"""

_INSPECT_DOC = """- inspect(resource, name?, namespace?, filter?, tail?): 结构化 k8s 资源查询,替代"全量加载再人肉 grep"。
  resource: pods|services|events|logs|nodes|deployments
  name: 具体资源名(如 pod 名),省略则列表
  namespace: 命名空间,默认组命名空间
  filter: grep 模式(大小写不敏感),只返回匹配行
  tail: 返回最后 N 行,默认 50(防止塞满上下文)
  示例: inspect("pods") → 概览表; inspect("pods",name="group-cpupod") → 详情; inspect("logs",name="group-cpupod",filter="error",tail=20) → 只看错误日志"""

_MEMORY_DOC = """- memory_save(key, value): 保存一条跨会话记忆(如上次巡检结论、项目结构)。namespace 自动取当前 agent id。
- memory_load(key): 读取一条记忆。无则返回"【无此记忆】"。
- memory_list(): 列出当前 agent 所有记忆 key+摘要。"""

_VISION_DOC = """- vision(image, prompt?): 用 Qwen 视觉模型分析图片。image 为 base64 编码(无 data: 前缀),prompt 为关于图片的问题(默认"描述内容")。用于分析截图、UI 界面、架构图等。"""
_AI_CHAT_DOC = """- ai_chat(prompt, system?): 直接调用 AI 进行分析/生成/翻译等,不经过 ReAct 循环。用于需要 AI 推理能力的子任务(如分析日志模式、生成配置、翻译文档)。"""
_SCREENSHOT_DOC = """- screenshot(url): 用 Playwright 浏览器访问 URL 并截图,返回页面截图描述。用于 web-use 场景:查看网页内容、操作 Web 界面。需要 playwright MCP 已启用。"""
_BROWSER_DOC = """- browser_navigate(url): 用 Playwright 浏览器导航到指定 URL。用于操作 Web 界面:打开平台页面、访问外部网站。需要 playwright MCP 已启用。
- browser_click(selector): 点击页面上匹配 CSS 选择器的元素。selector 为标准 CSS 选择器(如 "#btn-submit", ".pod-action-stop", "[data-testid='create-btn']")。用于自主操作界面:点击按钮、切换标签、确认对话框。
- browser_fill(selector, value): 在匹配 CSS 选择器的输入框中填写内容。用于自主填写表单:输入 Pod 名称、配置参数、搜索关键字。会先清空已有内容再填入新值。
- browser_screenshot(): 对当前浏览器页面截图,返回截图描述。用于确认操作结果、查看页面状态。"""

_QUERY_STRATEGY = """
【精准查询策略】禁止全量加载!遵循"先小后大":
1. 先用 inspect() 看概览(默认只返回 50 行)
2. 发现异常再用 inspect(name=具体资源) 看详情
3. 查日志先用 inspect("logs",name=pod,filter="error|warn|fail") 只看错误行
4. 只有确实需要完整上下文时才加大 tail(如 tail=200)
5. 用 memory_save 记住关键结论,下次不用重新查
6. 巡检结论用 memory_save 持久化,下次巡检可 memory_load 对比变化
"""

_EXTRA_TOOLS_DOC = _FETCH_DOC + "\n" + _EDIT_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC

OPS_SYS = """你是平台的运维审计助手(ops agent),在平台宿主机上以 root 执行命令。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在宿主机 shell 执行命令(root),返回 stdout+stderr。用于 kubectl get/describe/logs、frpc 状态、系统诊断等。
- done(summary): 你已完成,summary 是给用户的最终总结。
""" + _SPAWN_DOC_OPS + "\n" + _SEARCH_DOC + "\n" + _EXTRA_TOOLS_DOC + "\n" + _REMOTE_DOC + "\n" + _INSPECT_DOC + "\n" + _MEMORY_DOC + "\n" + _VISION_DOC + "\n" + _AI_CHAT_DOC + "\n" + _SCREENSHOT_DOC + "\n" + _BROWSER_DOC + "\n" + _QUERY_STRATEGY + """

输出协议:需要执行命令时,输出一行(可以前后有思考文字):
  ACTION: {"tool": "run", "args": {"command": "kubectl get pods -n <组命名空间>"}}
也接受简写 ACTION: {"run": {"command": "..."}}。inspect 示例:
  ACTION: {"tool": "inspect", "args": {"resource": "pods"}}
  ACTION: {"tool": "inspect", "args": {"resource": "logs", "name": "group-cpupod", "filter": "error", "tail": 20}}
memory 示例:
  ACTION: {"tool": "memory_save", "args": {"key": "last_check:异常", "value": "pod-xxx:OOMKilled"}}
  ACTION: {"tool": "memory_load", "args": {"key": "last_check:异常"}}
  ACTION: {"tool": "memory_list", "args": {}}
web_search 示例:
  ACTION: {"tool": "web_search", "args": {"query": "flask socketio threading", "num": 5}}
fetch_url / grep / list_dir / edit_file 示例:
  ACTION: {"tool": "fetch_url", "args": {"url": "https://flask.palletsprojects.com/en/stable/quickstart/"}}
  ACTION: {"tool": "grep", "args": {"pattern": "def index", "path": "/opt/yatterra/web", "glob": "*.py"}}
  ACTION: {"tool": "list_dir", "args": {"path": "/opt/yatterra/web", "depth": 1}}
  ACTION: {"tool": "edit_file", "args": {"path": "/etc/hosts", "old": "127.0.0.1 localhost", "new": "127.0.0.1 localhost myhost"}}
run_remote 示例(远程巡检/处置,host=spark|ssemarket):
  ACTION: {"tool": "run_remote", "args": {"host": "ssemarket", "command": "df -h / && du -sh /var/log/* | sort -h | tail"}}
  ACTION: {"tool": "run_remote", "args": {"host": "spark", "command": "docker ps --format '{{.Names}} {{.Status}}'", "sudo": true}}
spawn 示例:
  ACTION: {"tool": "spawn", "args": {"tasks": [{"goal": "诊断 group-cpupod: describe+logs", "context": ""}, {"goal": "诊断 group-tx: describe+logs", "context": ""}]}}
ACTION: 尽量独占一行。执行结果会作为下一轮输入返回给你。没有更多命令时,直接用自然语言回答(不要带 ACTION: 行),即为最终答案。

巡检工作流:
1. inspect("pods") → 看整体状态,记下异常 pod
2. 对每个异常 pod: inspect("pods",name=pod) → 看 Events 和 Status
3. inspect("logs",name=pod,filter="error|warn|fail",tail=30) → 只看错误日志
4. memory_save("last_check:异常","pod-xxx:OOMKilled, pod-yyy:CrashLoop") → 记住结论
5. 汇总报告

【并行优先策略】LLM 单次推理慢,用并发掩盖延迟:
- 任务可拆分时,第一轮就 spawn 并行子 agent,不要串行逐个查
- 巡检: spawn 每组/每类指标一个子任务,同时跑
- 诊断: spawn 网络/磁盘/GPU/进程 各一个子 agent 并行查
- 编程: spawn 后端/前端/测试 各一个子 agent 并行写
- 简单单步任务才直接 run,其余一律 spawn 优先
- 子 agent 结果 fan-in 后你整合,不要等一个完再启下一个

安全约束:禁止 reboot/shutdown/halt、rm -rf / 及 /opt /home /etc /var /mnt /root /usr /boot 等顶层系统目录、mkfs、dd 写块设备、systemctl stop/restart yatterra-web(会杀掉自己)、systemctl stop/disable k3s/frps/frpc、kubectl delete/edit/apply 等破坏性命令(会被策略拒绝)。优先只读命令。每步先观察再决定下一步。命令加超时和输出截断,别一次刷太多。

""" + _PLATFORM_CTX

BUILD_SYS = """你是组工作容器的编程助手(build agent),在用户的 Ubuntu 24.04 容器里以 cloud 用户执行命令。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在容器里以 cloud 执行 shell 命令,返回 stdout+stderr。装软件用 sudo apt-get/pip,写代码、编译、运行都靠它。
- read_file(path): 读容器内文件。
- write_file(path, content): 写容器内文件(content 是完整内容)。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SPAWN_DOC_BUILD + "\n" + _SEARCH_DOC + "\n" + _EXTRA_TOOLS_DOC + "\n" + _MEMORY_DOC + "\n" + _VISION_DOC + "\n" + _AI_CHAT_DOC + "\n" + _BROWSER_DOC + """

输出协议:需要执行时,输出一行(可前后有思考文字):
  ACTION: {"tool": "run", "args": {"command": "pip install --user requests"}}
或 {"tool": "write_file", "args": {"path": "hello.py", "content": "print('hi')"}}
也接受简写 ACTION: {"run": {"command": "..."}}。memory 示例:
  ACTION: {"tool": "memory_save", "args": {"key": "project_info", "value": "Python 3.12 + Flask, 入口 app.py, 测试 pytest"}}
  ACTION: {"tool": "memory_load", "args": {"key": "project_info"}}
  ACTION: {"tool": "memory_list", "args": {}}
web_search 示例:
  ACTION: {"tool": "web_search", "args": {"query": "flask socketio threading", "num": 5}}
fetch_url / grep / list_dir / edit_file 示例:
  ACTION: {"tool": "fetch_url", "args": {"url": "https://docs.python.org/3/library/socket.html"}}
  ACTION: {"tool": "grep", "args": {"pattern": "app.route", "glob": "*.py"}}
  ACTION: {"tool": "list_dir", "args": {"path": ".", "depth": 2}}
  ACTION: {"tool": "edit_file", "args": {"path": "app.py", "old": "return 'hi'", "new": "return 'hello'"}}
spawn 示例:
  ACTION: {"tool": "spawn", "args": {"tasks": [{"goal": "写后端 app.py 并跑通", "context": "Flask hello"}, {"goal": "写前端 index.html", "context": ""}, {"goal": "写测试 test_app.py 并通过", "context": ""}]}}
ACTION: 尽量独占一行。结果下一轮返回。没有更多动作时,直接自然语言回答(不带 ACTION: 行)即为最终答案。

编程工作流:
1. memory_load("project_info") → 看上次记住的项目结构
2. 如果没有: list_dir + grep("import|require|from",glob="*.{py,js,ts}") → 快速了解项目
3. memory_save("project_info","Python 3.12 + Flask, 入口 app.py, 测试 pytest") → 记住
4. 按需 read_file / edit_file / write_file 改代码

【并发写代码】涉及多个文件时优先用 spawn 并行写,每个子 agent 写一个或一组相关文件,最后 fan-in 整合验证。单文件小任务直接做。

【并行优先策略】LLM 单次推理慢,用并发掩盖延迟:
- 任务可拆分时,第一轮就 spawn 并行子 agent,不要串行逐个做
- 多文件: spawn 每个文件/组件一个子 agent 同时写
- 调试+搜索: spawn 一个查文档、一个跑测试、一个看日志,并行
- 简单单步任务才直接做,其余一律 spawn 优先
- 子 agent 结果 fan-in 后你整合,不要等一个完再启下一个

原则:先看环境(pwd/ls/python --version),再动手;改文件优先用 write_file 而不是 echo 重定向;命令有超时和输出截限。容器是用户自己的,可以装东西和改文件。安全约束:rm -rf / 及顶层目录、reboot/shutdown、mkfs、dd 写块设备等破坏性命令会被策略拒绝。

""" + _PLATFORM_CTX

# Sub-agent system prompts (leaner; no spawn doc unless depth allows, appended at runtime).
OPS_SUB_SYS = """你是运维子 agent(ops),在平台宿主机以 root 执行命令,完成父 agent 分配的一个子任务。
工具:run(command)、run_remote(host,command,sudo?)、inspect(resource,name?,namespace?,filter?,tail?)、memory_save(key,value)、memory_load(key)、memory_list()、web_search(query,num?)、fetch_url(url)、grep(pattern,path?,glob?,max_lines?)、list_dir(path?,depth?,max_entries?)、edit_file(path,old,new)、done(summary)。输出协议同主 agent(ACTION: {"tool":"run","args":{"command":"..."}} 或简写)。
""" + _QUERY_STRATEGY + """
只做分配给你的子任务,完成后**必须**用 done 返回**带实质内容的**结果摘要(把你查到的关键事实/数据/结论写进 summary,不要空)。优先只读命令,破坏性命令会被拒。
""" + _PLATFORM_CTX

BUILD_SUB_SYS = """你是编程子 agent(build),在 Ubuntu 24.04 容器里以 cloud 执行命令,完成父 agent 分配的一个子任务。
工具:run(command)、read_file(path)、write_file(path,content)、memory_save(key,value)、memory_load(key)、memory_list()、web_search(query,num?)、fetch_url(url)、grep(pattern,path?,glob?,max_lines?)、list_dir(path?,depth?,max_entries?)、edit_file(path,old,new)、done(summary)。输出协议同主 agent。
只做分配给你的子任务,完成后**必须**用 done 返回**带实质内容的**结果摘要(做了什么/结果如何/文件路径写进 summary,不要空)。改文件优先 write_file。
""" + _PLATFORM_CTX

DB_SYS = """你是平台的数据库助手(db agent),在平台宿主机上以 root 执行命令,负责 MySQL / Redis / Qdrant 的巡检、账号、库表管理。

服务端点(命名空间 platform-infra):
- MySQL: mysql.platform-infra.svc.cluster.local:3306(root 密码在 /opt/yatterra/db.conf)
- Redis: redis.platform-infra.svc.cluster.local:6379
- Qdrant: http://qdrant.platform-infra.svc.cluster.local:6333 (gRPC :6334)
每组有独立 MySQL 库 + 账号、Redis ACL 账号、Qdrant collection 前缀。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在宿主机 shell 执行(root)。进 MySQL pod 用 `kubectl -n platform-infra exec -it deploy/mysql -- mysql -uroot -p<pwd>`,或装 mysql 客户端直连。redis-cli / curl qdrant 同理。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _INSPECT_DOC + "\n" + _MEMORY_DOC + """
输出协议:同主 agent(ACTION: {"tool":"run","args":{"command":"..."}} 等)。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答(不带 ACTION: 行)即为最终答案。

原则:优先只读命令(SHOW、SELECT、INFO、PING、collections);改库/账号前先确认。破坏性命令(DROP/DELETE/FLUSHALL/truncate)会被 ops 安全策略拒绝。每组隔离,别串组。命令加超时和输出截断。

""" + _PLATFORM_CTX

STORAGE_SYS = """你是平台的存储助手(storage agent),在平台宿主机上以 root 执行命令,负责 MinIO 对象存储的桶、密钥、用量管理。

服务端点(命名空间 platform-infra):
- MinIO: http://minio.platform-infra.svc.cluster.local:9000(root 凭证在 /opt/yatterra/minio.conf)
- 用 `mc` 客户端或 `kubectl -n platform-infra exec deploy/minio -- mc ...` 操作。每组有独立桶 + IAM 子账号。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在宿主机 shell 执行(root)。`mc alias set ...`、`mc ls`、`mc du`、`mc admin policy` 等。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _INSPECT_DOC + "\n" + _MEMORY_DOC + """
输出协议:同主 agent。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答即为最终答案。

原则:优先只读(ls/du/stat/policy list);删桶/删对象前确认。破坏性命令会被 ops 安全策略拒绝。每组隔离。

""" + _PLATFORM_CTX

DB_SUB_SYS = """你是数据库子 agent(db),在平台宿主机以 root 执行命令,完成父 agent 分配的一个子任务。
工具:run(command)、inspect(resource,name?,namespace?,filter?,tail?)、memory_save(key,value)、memory_load(key)、memory_list()、web_search(query,num?)、fetch_url(url)、grep(pattern,path?,glob?,max_lines?)、list_dir(path?,depth?,max_entries?)、done(summary)。输出协议同主 agent。
只做分配给你的子任务,完成后**必须**用 done 返回**带实质内容的**结果摘要。优先只读命令,破坏性命令会被拒。
""" + _PLATFORM_CTX

STORAGE_SUB_SYS = """你是存储子 agent(storage),在平台宿主机以 root 执行命令,完成父 agent 分配的一个子任务。
工具:run(command)、inspect(resource,name?,namespace?,filter?,tail?)、memory_save(key,value)、memory_load(key)、memory_list()、web_search(query,num?)、fetch_url(url)、grep(pattern,path?,glob?,max_lines?)、list_dir(path?,depth?,max_entries?)、done(summary)。输出协议同主 agent。
只做分配给你的子任务,完成后**必须**用 done 返回**带实质内容的**结果摘要。优先只读命令,破坏性命令会被拒。
""" + _PLATFORM_CTX

# --- net/gpu/web/train 独立 prompt ---

NET_SYS = """你是平台的网络助手(net agent),在平台宿主机上以 root 执行命令,负责网络连通性、端口、frpc/frps、防火墙、DNS 诊断。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在宿主机 shell 执行命令(root),返回 stdout+stderr。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _INSPECT_DOC + "\n" + _MEMORY_DOC + "\n" + _QUERY_STRATEGY + """
输出协议:同主 agent。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答即为最终答案。

网络巡检工作流:
1. inspect("services") → 看 NodePort/ClusterIP 分配
2. inspect("pods",filter="frpc|frps") → 看 frpc 状态
3. run("ss -tlnp | grep -E ':(7[0-9]{3}|22[0-9]{2}|23[0-9]{2})'") → 看端口监听
4. run("kubectl -n <组命名空间> logs -l app=frpc --tail=20") → frpc 日志
5. memory_save("net:last_check","frpc:ok, nodeport:23000-23013 ok") → 记住

原则:优先只读命令(ss/netstat/kubectl get/iptables -L);改防火墙/路由前确认。破坏性命令会被拒。

""" + _PLATFORM_CTX

GPU_SYS = """你是平台的 GPU 助手(gpu agent),在平台宿主机上以 root 执行命令,负责 GPU 资源监控、分配、驱动、训练任务诊断。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在宿主机 shell 执行命令(root),返回 stdout+stderr。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _INSPECT_DOC + "\n" + _MEMORY_DOC + "\n" + _QUERY_STRATEGY + """
输出协议:同主 agent。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答即为最终答案。

GPU 巡检工作流:
1. run("nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv") → GPU 概览
2. inspect("pods",filter="gpu") → 看用 GPU 的 pod
3. run("kubectl top pods -n <组命名空间> --sort-by=memory") → 资源排行
4. memory_save("gpu:last_check","GPU0:80% util, 20GB/24GB mem") → 记住

原则:优先只读命令(nvidia-smi/kubectl top/describe);改 GPU 分配前确认。破坏性命令会被拒。

""" + _PLATFORM_CTX

WEB_SYS = """你是组容器的 Web 应用助手(web agent),在用户的 Ubuntu 24.04 容器里以 cloud 用户执行命令,专攻 Web 开发(Flask/Django/FastAPI/Node.js/前端)。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在容器里以 cloud 执行 shell 命令,返回 stdout+stderr。
- read_file(path): 读容器内文件。
- write_file(path, content): 写容器内文件(content 是完整内容)。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _EDIT_DOC + "\n" + _MEMORY_DOC + """
输出协议:同主 agent。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答即为最终答案。

Web 开发工作流:
1. memory_load("project_info") → 看上次记住的项目
2. 如果没有: list_dir + grep("import|require|from",glob="*.{py,js,ts}") → 快速了解
3. grep("app.route|router|@app",glob="*.{py,js,ts}") → 找路由/入口
4. memory_save("project_info","Flask + SQLAlchemy, 入口 app.py, 模板 templates/") → 记住
5. 按需 read_file / edit_file / write_file 改代码

原则:先看环境,再动手;改文件优先 edit_file;命令有超时和输出截限。容器是用户自己的。

""" + _PLATFORM_CTX

TRAIN_SYS = """你是组容器的训练助手(train agent),在用户的 Ubuntu 24.04 容器里以 cloud 用户执行命令,专攻模型训练(PyTorch/TF/HF Transformers)和推理部署。

可用工具(每轮要么调一个工具,要么直接回答结束):
- run(command): 在容器里以 cloud 执行 shell 命令,返回 stdout+stderr。
- read_file(path): 读容器内文件。
- write_file(path, content): 写容器内文件(content 是完整内容)。
- done(summary): 完成,summary 是给用户的最终总结。
""" + _SEARCH_DOC + "\n" + _FETCH_DOC + "\n" + _GREP_DOC + "\n" + _LISTDIR_DOC + "\n" + _EDIT_DOC + "\n" + _MEMORY_DOC + """
输出协议:同主 agent。ACTION 尽量独占一行,结果下一轮返回。没有更多动作时直接自然语言回答即为最终答案。

训练工作流:
1. memory_load("train:last_config") → 看上次训练配置
2. run("nvidia-smi") → 看 GPU 可用性
3. run("ps aux | grep python | grep -v grep") → 看正在跑的训练进程
4. grep("import torch|from transformers",glob="*.py") → 找训练脚本
5. memory_save("train:last_config","LLaMA-7B, lr=2e-5, batch=8, GPU:0") → 记住

原则:先看环境(GPU/磁盘/进程),再动手;训练命令加 nohup 或 tmux 防断;改文件优先 edit_file。

""" + _PLATFORM_CTX

_BUILTIN_SYS = {"ops": OPS_SYS, "build": BUILD_SYS, "db": DB_SYS, "storage": STORAGE_SYS,
                "net": NET_SYS, "gpu": GPU_SYS, "web": WEB_SYS, "train": TRAIN_SYS}
_BUILTIN_SUB_SYS = {"ops": OPS_SUB_SYS, "build": BUILD_SUB_SYS,
                    "db": DB_SUB_SYS, "storage": STORAGE_SUB_SYS}


def _tool_doc_for(agent_id):
    """Return the '可用工具…' tail of the built-in prompt for *agent_id*.

    Custom system prompts (agents.json) replace the whole built-in prompt,
    including the tool list and the ``ACTION:`` output protocol. Without that
    protocol the model answers in prose and the ReAct loop terminates on the
    first turn with an empty ``done``. So when a custom prompt is in use we
    append the built-in tool/protocol section after it.
    """
    builtin = _BUILTIN_SYS.get(agent_id or "", "")
    idx = builtin.find("可用工具")
    return builtin[idx:] if idx >= 0 else ""


def _system_prompt_for(agent_def):
    """Resolve an agent's main system prompt: custom override, else built-in by id."""
    sp = (agent_def or {}).get("system_prompt", "")
    if sp and sp.strip():
        doc = _tool_doc_for((agent_def or {}).get("id", ""))
        return sp + "\n\n" + doc if doc else sp
    return _BUILTIN_SYS.get((agent_def or {}).get("id", ""), OPS_SYS)


def _sub_prompt_for(agent_def):
    """Resolve an agent's sub-agent system prompt."""
    sp = (agent_def or {}).get("system_prompt", "")
    if sp and sp.strip():
        doc = _tool_doc_for((agent_def or {}).get("id", ""))
        base = sp + ("\n\n" + doc if doc else "")
        return base + "\n\n你是子 agent,只完成分配给你的子任务,完成后用 done(summary) 返回带实质内容的结果摘要。"
    return _BUILTIN_SUB_SYS.get((agent_def or {}).get("id", ""), OPS_SUB_SYS)


COMPACT_SYS = """你是对话压缩器。把给定的 agent 对话历史压缩成结构化摘要,严格保留:
1. 目标:用户最终想要什么
2. 已完成步骤:已执行的关键命令及其结论(保留命令本身和重要输出片段)
3. 关键事实/数据:已探明的环境、配置、状态
4. 待办:还没做的
5. 下一步计划
6. 最近的工具结果(原样保留最近 1-2 条)
用简洁中文,不要丢掉关键命令和输出,但去掉冗余思考。"""


# --- ACTION parsing ---
_ACTION_RE = re.compile(r"^\s*ACTION:\s*(\{.*\})\s*$", re.MULTILINE)


def _lenient_json_loads(s):
    """json.loads that tolerates invalid backslash escapes (e.g. `\\(`, `\\'`)
    that LLMs commonly emit inside shell commands. Returns parsed obj or None."""
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    fixed = re.sub(r'\\(?!["\\/bfnrtu])', '', s)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        return None


_BARE_ACTION_RE = re.compile(
    r"ACTION:\s*(?P<tool>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*(?P<arg>.*?)\s*\))?\s*$",
    re.DOTALL)


def _parse_bare_action(text):
    """Fallback for ``ACTION: run(<cmd>)`` / ``ACTION: <tool>`` (no JSON braces).

    Models occasionally emit the call-style shorthand instead of the documented
    JSON object. Without this the loop treats the turn as a final answer and
    silently stops. Only ``run``/``run_remote`` carry a positional argument
    (the command); every other bare tool call is dispatched with empty args.
    """
    m = _BARE_ACTION_RE.search(text)
    if not m:
        return None
    tool = m.group("tool")
    arg = (m.group("arg") or "").strip()
    if tool in ("run", "run_remote"):
        if not arg:
            return None
        # strip one layer of matching quotes if the model wrapped the command
        if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in ("'", '"'):
            arg = arg[1:-1]
        return {"tool": tool, "args": {"command": arg}}
    if arg:
        return None
    return {"tool": tool, "args": {}}


def _parse_action(text):
    """Return {'tool':..., 'args':...} or None.

    Tolerant: finds the last ``ACTION:`` anywhere (not just at line start),
    extracts a balanced {...} JSON object (respecting strings), and accepts
    both ``{"tool":"run","args":{...}}`` and the shorthand ``{"run":{...}}``.
    Falls back to the call-style shorthand ``ACTION: run(<cmd>)``.
    """
    idx = text.rfind("ACTION:")
    if idx == -1:
        return None
    j = idx + len("ACTION:")
    while j < len(text) and text[j].isspace():
        j += 1
    if j >= len(text) or text[j] != "{":
        return _parse_bare_action(text)
    depth = 0; k = j; in_str = False; esc = False; end = -1
    while k < len(text):
        c = text[k]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = k; break
        k += 1
    if end == -1:
        return None
    obj = _lenient_json_loads(text[j:end + 1])
    if obj is None:
        return None
    if not isinstance(obj, dict):
        return None
    if "tool" in obj:
        return {"tool": obj["tool"], "args": obj.get("args", {}) or {}}
    keys = list(obj.keys())
    if len(keys) == 1:
        v = obj[keys[0]]
        return {"tool": keys[0], "args": v if isinstance(v, dict) else {}}
    return None


_CJK_RE = re.compile(r'[一-鿿㐀-䶿぀-ヿ가-힯]')

def _est_tokens(messages):
    """Estimate token count, accounting for CJK characters being ~1.5 tokens each."""
    total = 0
    cjk = 0
    for m in messages:
        c = m.get("content", "")
        total += len(c)
        cjk += len(_CJK_RE.findall(c))
    return int(cjk * 1.5 + (total - cjk) * 0.25)


def _compact(messages, system, run_id, cfg, mode=""):
    """Return a compacted messages list (summary + last keep_last)."""
    transcript = "\n\n".join(f"[{m['role']}]\n{m.get('content','')}" for m in messages)
    if len(transcript) > 80000:
        transcript = "…(更早已截断)\n" + transcript[-80000:]
    comp_msg = [{"role": "user", "content":
                 "请把以下 agent 对话压缩成结构化摘要:\n\n" + transcript}]
    try:
        summary = llm.chat(comp_msg, system=COMPACT_SYS,
                           max_tokens=cfg["compact"]["max_tokens"], caller=f"compact:{mode}" if mode else "compact", user=_llm_user())
    except llm.LLMError:
        return messages
    keep = cfg["compact"]["keep_last"]
    new = [{"role": "user", "content":
            f"[上下文已自动压缩]\n{summary}\n\n[继续执行后续步骤]"}]
    new.extend(messages[-keep:])
    return new


# --- condition expression evaluator (small recursive descent; no eval) ---
_COND_TOKEN_RE = re.compile(r"""
    \s*(?:
      (?P<lp>\()|
      (?P<rp>\))|
      (?P<and>\band\b)|
      (?P<or>\bor\b)|
      (?P<not>\bnot\b)|
      (?P<contains>\bcontains\b)|
      (?P<op>==|!=|>=|<=|>|<)|
      (?P<true>\btrue\b)|
      (?P<false>\bfalse\b)|
      (?P<num>-?\d+(?:\.\d+)?)|
      (?P<str>"(?:[^"\\]|\\.)*")
    )""", re.VERBOSE)


def _cond_tokenize(s):
    toks = []
    pos = 0
    n = len(s)
    while pos < n:
        m = _COND_TOKEN_RE.match(s, pos)
        if not m or m.end() == pos:
            return None, f"无法识别: {s[pos:pos + 20]!r}"
        pos = m.end()
        kind = m.lastgroup
        val = m.group(kind)
        if kind == "str":
            try:
                val = json.loads(val)
            except Exception:
                return None, "字符串字面量非法"
        toks.append((kind, val))
    return toks, None


def _to_num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


class _CondParser:
    def __init__(self, toks):
        self.toks = toks
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def advance(self):
        t = self.peek()
        self.i += 1
        return t

    def parse(self):
        if not self.toks:
            return True, None
        v, err = self.p_or()
        if err:
            return None, err
        if self.i != len(self.toks):
            return None, "多余 token"
        return v, None

    def p_or(self):
        v, err = self.p_and()
        if err:
            return None, err
        while self.peek()[0] == "or":
            self.advance()
            r, err = self.p_and()
            if err:
                return None, err
            v = v or r
        return v, None

    def p_and(self):
        v, err = self.p_not()
        if err:
            return None, err
        while self.peek()[0] == "and":
            self.advance()
            r, err = self.p_not()
            if err:
                return None, err
            v = v and r
        return v, None

    def p_not(self):
        if self.peek()[0] == "not":
            self.advance()
            v, err = self.p_not()
            if err:
                return None, err
            return (not v), None
        return self.p_cmp()

    def p_cmp(self):
        v, err = self.p_atom()
        if err:
            return None, err
        k, val = self.peek()
        if k == "op":
            self.advance()
            r, err = self.p_atom()
            if err:
                return None, err
            return self._apply_op(val, v, r), None
        if k == "contains":
            self.advance()
            r, err = self.p_atom()
            if err:
                return None, err
            try:
                if isinstance(v, list):
                    return (r in v), None
                return (str(r) in str(v)), None
            except Exception:
                return None, "contains 类型错误"
        return v, None

    def p_atom(self):
        k, val = self.peek()
        if k == "lp":
            self.advance()
            v, err = self.p_or()
            if err:
                return None, err
            if self.peek()[0] != "rp":
                return None, "缺右括号"
            self.advance()
            return v, None
        if k == "true":
            self.advance()
            return True, None
        if k == "false":
            self.advance()
            return False, None
        if k == "num":
            self.advance()
            return (float(val) if "." in val else int(val)), None
        if k == "str":
            self.advance()
            return val, None
        return None, f"意外的 token {k}"

    @staticmethod
    def _apply_op(op, a, b):
        if op == "==":
            return a == b
        if op == "!=":
            return a != b
        fa, fb = _to_num(a), _to_num(b)
        if fa is None or fb is None:
            return False
        if op == ">":
            return fa > fb
        if op == "<":
            return fa < fb
        if op == ">=":
            return fa >= fb
        if op == "<=":
            return fa <= fb
        return False


def _eval_condition(expr):
    """Return (bool_value, error_str_or_None). Empty expr => True."""
    if not expr or not expr.strip():
        return True, None
    toks, err = _cond_tokenize(expr)
    if err:
        return False, err
    try:
        v, err = _CondParser(toks).parse()
    except Exception as e:
        return False, f"求值异常: {e}"
    if err:
        return False, err
    return bool(v), None


# --- template substitution for goals / conditions ---
_REF_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def _resolve_ref(ref, ctx):
    ref = ref.strip()
    if ref in ("upstream", "input"):
        return ctx.get("upstream", "")
    if ref in ("group", "item"):
        return ctx.get("item")
    if ref.startswith("var."):
        with ctx.get("vars_lock", _noop_lock):
            return ctx.get("vars", {}).get(ref[4:])
    if ref.startswith("node."):
        parts = ref.split(".")
        if len(parts) >= 3:
            nid, fld = parts[1], parts[2]
            r = ctx.get("results", {}).get(nid)
            if r is None:
                return None
            ok, summ = r
            if fld == "ok":
                return ok
            if fld == "summary":
                return summ
        return None
    return None


class _NoopLock:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_noop_lock = _NoopLock()


def _to_literal(v):
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v), ensure_ascii=False)


def _substitute(text, ctx, as_literal=False):
    if not text:
        return text

    def repl(m):
        v = _resolve_ref(m.group(1), ctx)
        if as_literal:
            return _to_literal(v)
        if v is None:
            return ""
        if v is True:
            return "true"
        if v is False:
            return "false"
        return str(v)

    return _REF_RE.sub(repl, text)


def _resolve_fanout(fanout):
    """Return a list of items to fan out over, or None if no fanout."""
    if fanout == "groups":
        try:
            return list(groups.load_state().get("groups", {}).keys())
        except Exception:
            return []
    if isinstance(fanout, list):
        return [str(x) for x in fanout]
    return None


# --- sub-agent (non-streaming ReAct) ---
def _subagent_run(agent_def, pod, goal, parent_ctx, run_id, depth, cfg, user=None):
    """Run one sub-agent to completion. Returns (ok, summary)."""
    base_sys = _sub_prompt_for(agent_def)
    if depth < cfg["fanout"]["max_depth"]:
        base_sys += "\n你也可以用 spawn 工具进一步并行拆分。"
    base_sys += _mcp_prompt_section(agent_def, run_id, user=user)
    base_sys += _platform_tools_prompt(user=user)
    messages = [{"role": "user", "content":
                 f"子任务: {goal}\n\n父任务背景:\n{parent_ctx}"}]
    started = time.time()
    sub_iters = cfg["fanout"]["sub_max_iters"]
    sub_wall = cfg["fanout"]["sub_max_wall"]
    audit_cat = f"agent_{(agent_def or {}).get('id', 'ops')}"
    empty_turns = 0
    for _ in range(sub_iters):
        if _should_stop(run_id):
            return False, "已停止"
        if time.time() - started > sub_wall:
            return False, "达时间上限"
        try:
            content_parts = []
            reasoning_parts = []
            for kind, piece in llm.stream_chat(messages, system=base_sys, max_tokens=16384, caller=f"subagent:{(agent_def or {}).get('id','?')}", user=_llm_user()):
                if kind == "reasoning":
                    reasoning_parts.append(piece)
                else:
                    content_parts.append(piece)
        except llm.LLMError as e:
            return False, f"LLM 错误: {e}"
        full_text = "".join(content_parts)
        asst_msg = {"role": "assistant", "content": full_text}
        if reasoning_parts:
            asst_msg["reasoning_content"] = "".join(reasoning_parts)
        messages.append(asst_msg)
        # Empty answer: nudge once instead of returning an empty summary up to
        # the parent (which then reports "子任务完成,无摘要").
        if not full_text.strip():
            empty_turns += 1
            if empty_turns <= 2:
                messages.append({
                    "role": "user",
                    "content": "你上一轮没有输出任何内容。请直接输出一行 "
                               'ACTION: {"tool": "...", "args": {...}} 或最终回答。',
                })
                continue
            return False, "模型连续多轮未输出内容"
        empty_turns = 0
        action = _parse_action(full_text)
        if not action:
            return True, full_text.strip()
        tool = action["tool"]
        args = action["args"] or {}
        if tool == "done":
            return True, (args.get("summary") or full_text.strip() or "(子任务完成,无摘要)")
        if tool == "spawn" and depth < cfg["fanout"]["max_depth"] and _tool_enabled(agent_def, "spawn"):
            tasks = (args.get("tasks") or [])[: cfg["fanout"]["max_parallel"]]
            merged = _subagent_spawn_blocking(agent_def, pod, tasks, parent_ctx, run_id, depth + 1, cfg, user=user)
            ok, out = True, merged
        elif tool == "spawn":
            ok, out = False, "【spawn 已禁用或超过最大递归深度】"
        else:
            ok, out = _exec_tool(agent_def, pod, tool, args, cfg, run_id, user=user)
        audit.record(
            audit_cat,
            detail=f"subagent tool={tool} args={json.dumps(args, ensure_ascii=False)[:200]} ok={ok} out={out[:200]}",
            actor="subagent",
        )
        messages.append({"role": "user", "content":
                         f"工具结果 [{tool}] ({'成功' if ok else '失败'}):\n{out}"})
    return False, "达迭代上限"


def _subagent_spawn_blocking(agent_def, pod, tasks, parent_ctx, run_id, depth, cfg, user=None):
    """Nested spawn inside a sub-agent (blocking, no UI events). Returns merged string."""
    if not tasks:
        return "无子任务"
    sem = threading.Semaphore(cfg["fanout"]["max_parallel"])
    results = [None] * len(tasks)

    def worker(i, t):
        with sem:
            if _should_stop(run_id):
                results[i] = (False, "已停止")
                return
            ok, summ = _subagent_run(agent_def, pod, t.get("goal", ""), parent_ctx, run_id, depth, cfg, user=user)
            results[i] = (ok, summ)

    ths = [threading.Thread(target=worker, args=(i, t), daemon=True) for i, t in enumerate(tasks)]
    for th in ths:
        th.start()
    for th in ths:
        th.join()
    return "\n\n".join(
        f"[子任务 {i+1}] {tasks[i].get('goal','')}\n结果: {results[i][1]}"
        for i in range(len(tasks))
    )


# --- main loop ---
def run_agent(mode, name, message, history, run_id, user=None):
    """Generator yielding event dicts. mode in {'ops','build'}.

    Events: {'type':'text','data':str}
            {'type':'tool_call','data':{'tool','args'}}
            {'type':'tool_result','data':{'tool','ok','output'}}
            {'type':'compact','data':{'before','after'}}
            {'type':'spawn_start','data':{'idx','goal'}}
            {'type':'spawn_done','data':{'idx','ok','summary'}}
            {'type':'done','data':str}
            {'type':'error','data':str}
    """
    # set thread-local username for _llm_user() in background thread
    _llm_tls.user = (user.get("username") if isinstance(user, dict) else str(user)) if user else None
    cfg = agent_conf.load()
    with _RUNS_LOCK:
        _RUNS[run_id] = threading.Event()
    with _STATS_LOCK:
        _STATS["active"] += 1
        _STATS["runs"] += 1

    audit_cat = f"agent_{mode}"
    started = time.time()
    try:
        agent_def = agent_conf.get_agent(mode)
        if agent_def is None:
            # compat fallback: full tools, built-in runner by mode
            agent_def = {
                "id": mode, "label": mode, "icon": "🤖",
                "runner": "pod" if mode == "build" else "host",
                "tools": {t: True for t in ("run", "read_file", "write_file", "spawn",
                                            "web_search", "fetch_url", "edit_file", "grep", "list_dir")},
                "system_prompt": "",
            }
        # mode-level permission check
        req_perm = agent_required_perm(agent_def)
        if not users.has_perm(user, req_perm):
            yield {"type": "error", "data": f"无权限使用该助手(需要 {req_perm})"}
            return
        runner = agent_def.get("runner", "host")

        if runner == "pod":
            state = groups.load_state()
            if not name or name not in state["groups"]:
                yield {"type": "error", "data": "组不存在"}
                return
            # pod access check: user must have member+ access
            pod_dict = state["groups"].get(name, {})
            if not users.can_pod(user, pod_dict, "member"):
                yield {"type": "error", "data": f"无权访问 Pod {name}"}
                return
            if groups.pod_status(name) != "Running":
                yield {"type": "error", "data": "Pod 未运行,无法启动该 agent"}
                return
            pod = _resolve_pod(name)
            if not pod:
                yield {"type": "error", "data": "找不到 Pod"}
                return
            system = _system_prompt_for(agent_def) + f"\n当前组: {name},Pod: {pod}。"
        else:
            pod = None
            system = _system_prompt_for(agent_def)
        system += _mcp_prompt_section(agent_def, run_id, user=user)
        system += _platform_tools_prompt(user=user)

        messages = []
        for h in (history or []):
            if isinstance(h, dict) and h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": message})
        parent_ctx = message

        max_iters = cfg["limits"]["max_iters"]
        max_wall = cfg["limits"]["max_wall"]
        fanout_enabled = cfg["fanout"]["enabled"]
        compact_enabled = cfg["compact"]["enabled"]
        compact_threshold = cfg["compact"]["threshold_tokens"]

        # Seed from loaded history so a reloaded long session compacts BEFORE
        # the first LLM call instead of blowing past the context window and
        # erroring out (compact only re-triggers after a successful turn).
        last_prompt_tokens = _est_tokens(messages)
        empty_turns = 0

        for _ in range(max_iters):
            if _should_stop(run_id):
                yield {"type": "done", "data": "已停止"}
                return
            if time.time() - started > max_wall:
                yield {"type": "done", "data": "已达时间上限,停止"}
                return

            # auto-compact before next LLM call if context is too hot
            if compact_enabled and last_prompt_tokens > compact_threshold:
                before = last_prompt_tokens
                yield {"type": "compact", "data": {"before": before, "after": None}}
                messages = _compact(messages, system, run_id, cfg, mode)
                after = _est_tokens(messages)
                last_prompt_tokens = after
                yield {"type": "compact", "data": {"before": before, "after": after}}

            full_content = []
            full_reasoning = []
            usage = {}

            def _on_usage(u, _usage=usage):
                _usage.update(u)

            try:
                for kind, piece in llm.stream_chat(messages, system=system, max_tokens=16384, on_usage=_on_usage, caller=f"agent:{mode}", user=_llm_user()):
                    if _should_stop(run_id):
                        yield {"type": "done", "data": "已停止"}
                        return
                    if kind == "reasoning":
                        full_reasoning.append(piece)
                        yield {"type": "reasoning", "data": piece}
                    else:
                        full_content.append(piece)
                        yield {"type": "text", "data": piece}
            except llm.LLMError as e:
                # If we got partial content, retry instead of dying
                if "".join(full_content).strip():
                    partial = "".join(full_content)
                    messages.append({"role": "assistant", "content": partial})
                    messages.append({"role": "user", "content": "【LLM 流中断，请继续完成你的回答】"})
                    yield {"type": "text", "data": "\n\n[LLM 流中断，自动重试…]\n"}
                    continue
                yield {"type": "error", "data": f"LLM 错误: {e}"}
                return

            assistant_text = "".join(full_content)
            assistant_msg = {"role": "assistant", "content": assistant_text}
            if full_reasoning:
                assistant_msg["reasoning_content"] = "".join(full_reasoning)
            messages.append(assistant_msg)
            last_prompt_tokens = usage.get("prompt_tokens") or _est_tokens(messages)
            _bump_peak(last_prompt_tokens)

            # Empty answer (model emitted only reasoning, or nothing at all):
            # nudge it once per occurrence instead of ending the run with a
            # blank "done" the user can't act on.
            if not assistant_text.strip():
                empty_turns += 1
                if empty_turns <= 2:
                    messages.append({
                        "role": "user",
                        "content": "你上一轮没有输出任何内容。请直接输出一行 "
                                   'ACTION: {"tool": "...", "args": {...}}(需要执行工具时),'
                                   "或直接给出最终回答。",
                    })
                    yield {"type": "text", "data": "\n\n[模型未输出内容，自动重试…]\n"}
                    continue
                yield {"type": "error", "data": "模型连续多轮未输出内容，已停止。请重试或换一种问法。"}
                return
            empty_turns = 0

            action = _parse_action(assistant_text)
            if not action:
                yield {"type": "done", "data": assistant_text}
                return

            tool = action["tool"]
            args = action["args"] or {}
            yield {"type": "tool_call", "data": {"tool": tool, "args": args}}

            try:
                if tool == "done":
                    yield {"type": "done", "data": args.get("summary", "")}
                    return
                elif tool == "spawn" and fanout_enabled and _tool_enabled(agent_def, "spawn"):
                    out = yield from _run_spawn(agent_def, pod, args, parent_ctx, run_id, 0, cfg, user=user)
                    ok = True
                elif tool == "spawn":
                    ok, out = False, "【spawn 已禁用(fan-out 开关或工具开关关闭)】"
                else:
                    ok, out = _exec_tool(agent_def, pod, tool, args, cfg, run_id, user=user)
            except Exception as e:
                ok, out = False, f"[工具异常: {e!r}]"

            yield {"type": "tool_result", "data": {"tool": tool, "ok": ok, "output": out}}

            audit.record(
                audit_cat,
                detail=f"tool={tool} args={json.dumps(args, ensure_ascii=False)[:300]} ok={ok} out={out[:300]}",
                actor="agent",
            )

            messages.append({
                "role": "user",
                "content": f"工具结果 [{tool}] ({'成功' if ok else '失败'}):\n{out}",
            })

        yield {"type": "done", "data": "已达迭代上限,停止"}
    finally:
        with _RUNS_LOCK:
            _RUNS.pop(run_id, None)
        mcp_client.cleanup_mcp(run_id)
        with _STATS_LOCK:
            _STATS["active"] = max(0, _STATS["active"] - 1)


def _run_spawn(agent_def, pod, args, parent_ctx, run_id, depth, cfg, user=None):
    """Yield spawn_start/spawn_done events for parallel sub-agents, return merged string.

    Uses `yield from` semantics: the caller does `out = yield from _run_spawn(...)`.
    """
    tasks = args.get("tasks") or []
    if not isinstance(tasks, list):
        tasks = []
    tasks = tasks[: cfg["fanout"]["max_parallel"] * 2]  # hard cap
    n = len(tasks)
    if n == 0:
        return "无子任务"

    sem = threading.Semaphore(cfg["fanout"]["max_parallel"])
    results = [None] * n
    evq = queue.Queue()

    def worker(i, t):
        with sem:
            if _should_stop(run_id):
                results[i] = (False, "已停止")
                evq.put((i, False, "已停止"))
                return
            ok, summ = _subagent_run(agent_def, pod, t.get("goal", ""), parent_ctx, run_id, depth, cfg, user=user)
            results[i] = (ok, summ)
            evq.put((i, ok, summ))

    for i, t in enumerate(tasks):
        yield {"type": "spawn_start", "data": {"idx": i, "goal": t.get("goal", "")}}
        threading.Thread(target=worker, args=(i, t), daemon=True).start()

    done = 0
    while done < n:
        if _should_stop(run_id):
            # drain: stop waiting, fill remaining as stopped
            for i in range(n):
                if results[i] is None:
                    results[i] = (False, "已停止")
            break
        try:
            i, ok, summ = evq.get(timeout=1)
        except queue.Empty:
            continue
        results[i] = (ok, summ)
        yield {"type": "spawn_done", "data": {"idx": i, "ok": ok, "summary": summ}}
        done += 1

    merged = "\n\n".join(
        f"[子任务 {i+1}] {tasks[i].get('goal','')}\n结果: {results[i][1]}"
        for i in range(n)
    )
    return merged


# --- harness execution (low-code DAG) ---
def _run_node_stream(agent_def, pod, goal, run_id, cfg, node_id, user=None):
    """Run one harness node's agent to completion, yielding node_text/node_tool events.

    Returns (ok, summary) via StopIteration.value (consumed by run_harness).
    Non-streaming LLM calls (llm.chat); each iteration's assistant text is emitted
    as one node_text event with ACTION lines stripped.
    """
    system = _system_prompt_for(agent_def)
    system += "\n\n你是 harness 编排中的一个节点 agent,只完成分配给你的子任务,完成后用 done(summary) 返回带实质内容的结果摘要(把关键事实/数据/结论写进 summary)。"
    system += _mcp_prompt_section(agent_def, run_id, user=user)
    system += _platform_tools_prompt(user=user)
    messages = [{"role": "user", "content": goal}]
    started = time.time()
    sub_iters = cfg["fanout"]["sub_max_iters"]
    sub_wall = cfg["fanout"]["sub_max_wall"]
    audit_cat = f"agent_{(agent_def or {}).get('id', 'ops')}"
    empty_turns = 0
    for _ in range(sub_iters):
        if _should_stop(run_id):
            return False, "已停止"
        if time.time() - started > sub_wall:
            return False, "达时间上限"
        try:
            content_parts = []
            reasoning_parts = []
            for kind, piece in llm.stream_chat(messages, system=system, max_tokens=16384, caller=f"harness:{(agent_def or {}).get('id','?')}", user=_llm_user()):
                if kind == "reasoning":
                    reasoning_parts.append(piece)
                else:
                    content_parts.append(piece)
        except llm.LLMError as e:
            return False, f"LLM 错误: {e}"
        full_text = "".join(content_parts)
        asst_msg = {"role": "assistant", "content": full_text}
        if reasoning_parts:
            asst_msg["reasoning_content"] = "".join(reasoning_parts)
        messages.append(asst_msg)
        shown = _strip_action_text(full_text)
        if shown.strip():
            yield {"type": "node_text", "data": {"node": node_id, "text": shown}}
        if not full_text.strip():
            empty_turns += 1
            if empty_turns <= 2:
                messages.append({
                    "role": "user",
                    "content": "你上一轮没有输出任何内容。请直接输出一行 "
                               'ACTION: {"tool": "...", "args": {...}} 或最终回答。',
                })
                continue
            return False, "模型连续多轮未输出内容"
        empty_turns = 0
        action = _parse_action(full_text)
        if not action:
            return True, full_text.strip()
        tool = action["tool"]
        args = action["args"] or {}
        if tool == "done":
            return True, (args.get("summary") or full_text.strip() or "(节点完成,无摘要)")
        yield {"type": "node_tool", "data": {"node": node_id, "tool": tool, "args": args}}
        if tool == "spawn" and _tool_enabled(agent_def, "spawn"):
            tasks = (args.get("tasks") or [])[: cfg["fanout"]["max_parallel"]]
            merged = _subagent_spawn_blocking(agent_def, pod, tasks, goal, run_id, 1, cfg, user=user)
            ok, out = True, merged
        elif tool == "spawn":
            ok, out = False, "【spawn 已禁用】"
        else:
            ok, out = _exec_tool(agent_def, pod, tool, args, cfg, run_id, user=user)
        yield {"type": "node_tool_result", "data": {"node": node_id, "tool": tool, "ok": ok, "output": out}}
        audit.record(
            audit_cat,
            detail=f"node={node_id} tool={tool} args={json.dumps(args, ensure_ascii=False)[:200]} ok={ok} out={out[:200]}",
            actor="harness",
        )
        messages.append({"role": "user", "content":
                         f"工具结果 [{tool}] ({'成功' if ok else '失败'}):\n{out}"})
    return False, "达迭代上限"


def _strip_action_text(text):
    """Remove ACTION: {...} lines from assistant text for display."""
    out = []
    for line in text.splitlines():
        if line.lstrip().startswith("ACTION:"):
            continue
        out.append(line)
    return "\n".join(out)


def _topo_order(nodes, edges):
    """Return node ids in topological order, or None if a cycle exists."""
    ids = [n["id"] for n in nodes]
    indeg = {i: 0 for i in ids}
    adj = {i: [] for i in ids}
    for e in edges:
        f, t = e.get("from"), e.get("to")
        if f in indeg and t in indeg:
            adj[f].append(t)
            indeg[t] += 1
    ready = [i for i in ids if indeg[i] == 0]
    order = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for t in adj[nid]:
            indeg[t] -= 1
            if indeg[t] == 0:
                ready.append(t)
    if len(order) != len(ids):
        return None
    return order


def run_harness(hname, run_id, user=None):
    """Execute a harness DAG. Yields events:
    harness_start, node_start, node_text, node_tool, node_tool_result, node_done,
    node_retry, node_skip, node_fanout_item, harness_done, error.

    Node optional fields: retry, on_fail (continue|skip_downstream|abort),
    condition (bool expr), fanout ("groups" | [items]), output_key.
    """
    cfg = agent_conf.load()
    with _RUNS_LOCK:
        _RUNS[run_id] = threading.Event()
    with _STATS_LOCK:
        _STATS["active"] += 1
        _STATS["runs"] += 1
    try:
        _uname = (user or {}).get("username", "")
        doc = agent_conf.load_harness(hname, _uname)
        if not doc:
            yield {"type": "error", "data": f"harness 不存在: {hname}"}
            return
        nodes = doc.get("nodes", [])
        edges = doc.get("edges", [])
        if not nodes:
            yield {"type": "error", "data": "harness 没有节点"}
            return
        node_map = {n["id"]: n for n in nodes}
        if _topo_order(nodes, edges) is None:
            yield {"type": "error", "data": "harness 存在环,无法执行"}
            return

        yield {"type": "harness_start", "data": {"name": hname, "nodes": nodes, "edges": edges}}

        results = {}          # node_id -> (ok, summary)
        vars_ = {}            # output_key -> value
        vars_lock = threading.Lock()
        done_set = set()
        remaining = set(node_map)
        started_nodes = set()
        aborted = False
        sem = threading.Semaphore(max(1, cfg["fanout"]["max_parallel"]))
        evq = queue.Queue()

        def upstream_text(nid):
            ups = [e["from"] for e in edges if e.get("to") == nid]
            parts = []
            for u in ups:
                r = results.get(u)
                parts.append(f"[节点 {u}] {r[1] if r else '(无结果)'}")
            return "\n\n".join(parts)

        def ctx_for(nid, item=None):
            return {"upstream": upstream_text(nid), "vars": vars_,
                    "vars_lock": vars_lock, "results": results, "item": item}

        def store_output(nid, summ):
            k = (node_map.get(nid) or {}).get("output_key")
            if k:
                with vars_lock:
                    vars_[k] = summ

        def pump_node(gen):
            """Forward a node generator's events to evq; return its (ok, summary)."""
            try:
                while True:
                    evq.put({"kind": "event", "ev": next(gen)})
            except StopIteration as si:
                return si.value if si.value else (False, "(无结果)")

        def drain_node(gen):
            """Run a node generator silently (discard events); return (ok, summary)."""
            try:
                while True:
                    next(gen)
            except StopIteration as si:
                return si.value if si.value else (False, "(无结果)")

        def run_with_retry(adef, n, goal, group, nid, forward):
            attempts = 1 + max(0, int(n.get("retry", 0) or 0))
            ok, summ = False, ""
            for a in range(attempts):
                if _should_stop(run_id):
                    return False, "已停止"
                if a > 0:
                    evq.put({"kind": "event", "ev": {"type": "node_retry",
                             "data": {"node": nid, "attempt": a}}})
                if adef.get("runner") == "pod":
                    grp = group or n.get("group")
                    if not grp:
                        return False, "pod 节点缺少 group"
                    if groups.pod_status(grp) != "Running":
                        return False, f"组 {grp} pod 未运行"
                    pod = _resolve_pod(grp)
                    if not pod:
                        return False, f"找不到 {grp} 的 pod"
                else:
                    pod = None
                gen = _run_node_stream(adef, pod, goal, run_id, cfg, nid, user=user)
                ok, summ = pump_node(gen) if forward else drain_node(gen)
                if ok:
                    return ok, summ
            return ok, summ

        def run_fanout(adef, n, goal_tmpl, items, nid):
            if not items:
                return True, "(fanout: 无项)"
            isub = threading.Semaphore(max(1, cfg["fanout"]["max_parallel"]))
            sub_res = [None] * len(items)
            subq = queue.Queue()
            is_groups = n.get("fanout") == "groups"

            def worker(i, item):
                with isub:
                    if _should_stop(run_id):
                        sub_res[i] = (False, "已停止")
                        subq.put(i)
                        return
                    ictx = ctx_for(nid, item=item)
                    goal_i = _substitute(goal_tmpl, ictx)
                    grp = item if is_groups else n.get("group")
                    ok, summ = run_with_retry(adef, n, goal_i, grp, nid, forward=False)
                    sub_res[i] = (ok, summ)
                    subq.put(i)

            for i, it in enumerate(items):
                threading.Thread(target=worker, args=(i, it), daemon=True).start()
            done = 0
            while done < len(items):
                if _should_stop(run_id):
                    for i in range(len(items)):
                        if sub_res[i] is None:
                            sub_res[i] = (False, "已停止")
                    break
                try:
                    i = subq.get(timeout=1)
                except queue.Empty:
                    continue
                evq.put({"kind": "event", "ev": {"type": "node_fanout_item", "data": {
                    "node": nid, "idx": i, "item": items[i],
                    "ok": sub_res[i][0], "summary": sub_res[i][1]}}})
                done += 1
            ok_all = all(r[0] for r in sub_res)
            merged = "\n\n".join(
                f"[{items[i]}] {'✓' if sub_res[i][0] else '✗'}\n{sub_res[i][1]}"
                for i in range(len(items)))
            return ok_all, merged

        def run_node(nid):
            n = node_map[nid]
            adef = agent_conf.get_agent(n.get("agent", ""))
            if not adef:
                evq.put({"kind": "node_done", "node": nid, "ok": False,
                         "summary": f"agent 不存在: {n.get('agent')}"})
                return
            with sem:
                if _should_stop(run_id):
                    evq.put({"kind": "node_done", "node": nid, "ok": False, "summary": "已停止"})
                    return
                evq.put({"kind": "node_start", "node": nid, "goal": n.get("goal", ""),
                         "agent": adef.get("id", "")})
                goal_tmpl = n.get("goal", "")
                items = _resolve_fanout(n.get("fanout"))
                if items is None:
                    goal = _substitute(goal_tmpl, ctx_for(nid))
                    ok, summ = run_with_retry(adef, n, goal, n.get("group"), nid, forward=True)
                else:
                    ok, summ = run_fanout(adef, n, goal_tmpl, items, nid)
                evq.put({"kind": "node_done", "node": nid, "ok": ok, "summary": summ})

        def transitive_downstream(nid):
            seen = set()
            stack = [e["to"] for e in edges if e.get("from") == nid]
            while stack:
                d = stack.pop()
                if d in seen or d == nid:
                    continue
                seen.add(d)
                stack.extend(e["to"] for e in edges if e.get("from") == d)
            return seen

        while remaining:
            if _should_stop(run_id) and not aborted:
                yield {"type": "harness_done", "data": {"stopped": True, "aborted": False,
                        "results": {nid: {"ok": r[0], "summary": r[1]} for nid, r in results.items()}}}
                return
            # launch runnable nodes (unless aborted)
            if not aborted:
                for nid in list(remaining):
                    if nid in started_nodes:
                        continue
                    deps = [e["from"] for e in edges if e.get("to") == nid]
                    if not all(d in done_set for d in deps):
                        continue
                    n = node_map[nid]
                    cond = (n.get("condition") or "").strip()
                    if cond:
                        expr = _substitute(cond, ctx_for(nid), as_literal=True)
                        val, err = _eval_condition(expr)
                        if err or not val:
                            reason = f"条件不满足({err or '求值为假'})"
                            yield {"type": "node_skip", "data": {"node": nid, "reason": reason}}
                            results[nid] = (True, f"(跳过: {reason})")
                            done_set.add(nid); remaining.discard(nid); started_nodes.add(nid)
                            store_output(nid, results[nid][1])
                            continue
                    started_nodes.add(nid)
                    threading.Thread(target=run_node, args=(nid,), daemon=True).start()
            try:
                msg = evq.get(timeout=1)
            except queue.Empty:
                continue
            k = msg["kind"]
            if k == "node_start":
                yield {"type": "node_start", "data": {"node": msg["node"], "goal": msg["goal"], "agent": msg["agent"]}}
            elif k == "event":
                yield msg["ev"]
            elif k == "node_done":
                nid = msg["node"]
                ok, summ = msg["ok"], msg["summary"]
                results[nid] = (ok, summ)
                done_set.add(nid)
                remaining.discard(nid)
                store_output(nid, summ)
                yield {"type": "node_done", "data": {"node": nid, "ok": ok, "summary": summ}}
                if not ok and not aborted:
                    on_fail = (node_map.get(nid) or {}).get("on_fail", "continue")
                    if on_fail == "skip_downstream":
                        for d in transitive_downstream(nid):
                            if d in done_set:
                                continue
                            yield {"type": "node_skip", "data": {"node": d, "reason": f"上游 {nid} 失败"}}
                            results[d] = (True, f"(跳过: 上游 {nid} 失败)")
                            done_set.add(d); remaining.discard(d); started_nodes.add(d)
                            store_output(d, results[d][1])
                    elif on_fail == "abort":
                        aborted = True
                        stop(run_id)
                        for d in list(remaining):
                            if d not in started_nodes:
                                yield {"type": "node_skip", "data": {"node": d, "reason": "已中止"}}
                                results[d] = (True, "(已中止)")
                                done_set.add(d); remaining.discard(d); started_nodes.add(d)

        yield {"type": "harness_done", "data": {"stopped": False, "aborted": aborted,
                "results": {nid: {"ok": r[0], "summary": r[1]} for nid, r in results.items()}}}
    finally:
        with _RUNS_LOCK:
            _RUNS.pop(run_id, None)
        mcp_client.cleanup_mcp(run_id)
        with _STATS_LOCK:
            _STATS["active"] = max(0, _STATS["active"] - 1)
