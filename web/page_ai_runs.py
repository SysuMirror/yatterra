"""页面 AI 助手后台 run —— 把 stream_agent 从 HTTP 请求中解耦。

参考 browser_assistant.py 的 Run/线程/offset-stream 骨架:
- POST 方起 daemon 线程跑 ai_service.stream_agent, 事件逐个进内存缓冲;
- 每个事件同时 append 落盘 ``.page_ai_runs/<run_id>.jsonl``, run 元数据写
  index.json —— 刷新页面/换页后凭 run_id 重接, 服务重启后也能回放历史;
- run 结束(成功/失败/停止)把最终 assistant 消息写回 MySQL 会话
  (ai_chat_store.append_turn), 并无论成败、无论时长都推送发起人;
- 协作式停止: 消费生成器的循环里检查 stop_event, 命中即 close 生成器。

注意: 按用户明确要求, 这里不做任何配额检查、不加每用户并发限制,
只保留全局 MAX_RUNS 兜底(淘汰已结束的, 不够再停最老的)。
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Any, Iterator

import siteconf

RUNS_DIR = siteconf.path(".page_ai_runs")
INDEX_FILE = os.path.join(RUNS_DIR, "index.json")
MAX_RUNS = 64            # 全局兜底上限(非限流: 淘汰已结束的, 不够再停最老的)
MAX_WALL = 1800          # 本类 run 的墙钟上限放宽到 30 分钟
MAX_ITERATIONS = 40      # agentic 迭代上限放宽
JSONL_TTL = 24 * 3600    # run 结束 24h 后由下一次进程启动时顺手清理

_LOCK = threading.RLock()
_RUNS: dict[str, "Run"] = {}
_INDEX: dict[str, dict[str, Any]] = {}


# ── index / 落盘 ───────────────────────────────────────────────
def _load_index() -> dict[str, dict[str, Any]]:
    try:
        with open(INDEX_FILE, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_index() -> None:
    os.makedirs(RUNS_DIR, exist_ok=True)
    tmp = INDEX_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_INDEX, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, INDEX_FILE)
    try:
        os.chmod(INDEX_FILE, 0o600)
    except OSError:
        pass


def _jsonl_path(run_id: str) -> str:
    return os.path.join(RUNS_DIR, f"{run_id}.jsonl")


def _boot_cleanup() -> None:
    """进程启动时: 上次未跑完的 run 标记为 interrupted; 清掉过期 jsonl。"""
    global _INDEX
    os.makedirs(RUNS_DIR, exist_ok=True)
    _INDEX = _load_index()
    now = time.time()
    changed = False
    for rid in list(_INDEX):
        meta = _INDEX[rid]
        if meta.get("status") == "running":
            # 服务重启后 worker 线程已不存在, 不能继续标 running
            meta["status"] = "interrupted"
            meta["finished"] = now
            changed = True
        path = _jsonl_path(rid)
        try:
            if not os.path.exists(path) or now - os.path.getmtime(path) > JSONL_TTL:
                os.unlink(path)
                _INDEX.pop(rid, None)
                changed = True
        except OSError:
            pass
    if changed:
        _save_index()


_boot_cleanup()


# ── Run ────────────────────────────────────────────────────────
class Run:
    def __init__(self, run_id: str, username: str, page: str, question: str,
                 session_id: str, route: str):
        self.id, self.username = run_id, username
        self.page, self.question = page, question
        self.session_id, self.route = session_id, route
        self.events: list[dict[str, Any]] = []
        self.cond = threading.Condition()
        self.done = False
        self.stop_event = threading.Event()
        # browser_control rendezvous: 工具发 page_action 事件后在这等
        # 前端 POST /api/ai/page/action_result 的回传(action_ids 去重防重放)。
        self.action_event = threading.Event()
        self.action_result: Any = None
        self.action_ids: set[str] = set()

    def add(self, event: dict[str, Any]) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()
        # 落盘 best-effort: 磁盘故障不能打断生成
        try:
            with open(_jsonl_path(self.id), "a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False,
                                   separators=(",", ":")) + "\n")
        except OSError:
            pass

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.cond.notify_all()


def _evict() -> None:
    """全局 MAX_RUNS 兜底: 先淘汰已结束的, 不够再停最老的(非限流)。"""
    while len(_RUNS) > MAX_RUNS:
        victim = next((k for k, r in _RUNS.items() if r.done), None)
        if victim is None:
            victim = next(iter(_RUNS))
            _RUNS[victim].stop_event.set()
        _RUNS.pop(victim, None)


def start(username: str, page: str, question: str, messages: list,
          system: str, session_id: str = "", route: str = "",
          perms: Any = None) -> str:
    """起一个后台 run, 立即返回 run_id。messages/system 由调用方
    (api/ai.py 的页面助手入口)按页面权限校验后构建好传入。"""
    import ai_service

    run_id = secrets.token_hex(12)
    run = Run(run_id, username, page, question, session_id, route)
    now = time.time()
    with _LOCK:
        _RUNS[run_id] = run
        _evict()
        _INDEX[run_id] = {"run_id": run_id, "username": username,
                          "page": page, "question": question[:200],
                          "session_id": session_id, "route": route,
                          "status": "running", "created": now}
        _save_index()

    def worker() -> None:
        parts: list[str] = []
        status = "done"
        error_brief = ""
        gen = None
        try:
            gen = ai_service.stream_agent(
                messages, system=system, max_tokens=4096,
                max_iterations=MAX_ITERATIONS, caller="page_ai_run",
                user=username, perms=perms, max_wall=MAX_WALL)
            # 登记 run 上下文: browser_control 工具(串行执行, 同一线程)
            # 通过它拿到本 run 发事件/等结果。生成器体在本线程迭代执行。
            ai_service.set_browser_run(run)
            for kind, data in gen:
                if run.stop_event.is_set():
                    run.add({"type": "done", "data": "已停止", "cancelled": True})
                    status = "stopped"
                    return
                if kind == "content" and isinstance(data, str):
                    parts.append(data)
                run.add({"type": kind, "data": data})
            run.add({"type": "done", "data": ""})
        except Exception as exc:  # 生成器内部已兜底, 这里防御线程级异常
            error_brief = f"{type(exc).__name__}: {exc}"[:300]
            run.add({"type": "error", "data": f"AI 任务失败: {error_brief}"})
            status = "error"
        finally:
            try:
                if run.stop_event.is_set() and status == "done":
                    status = "stopped"
                if gen is not None:
                    gen.close()
            except Exception:
                pass
            run.finish()
            answer = "".join(parts)
            # 写回 MySQL 会话(与旧同步 /ai/page 相同逻辑, 失败不影响 run)
            if session_id:
                try:
                    import ai_chat_store
                    ai_chat_store.append_turn(session_id, username,
                                              question, answer)
                except Exception:
                    pass
            with _LOCK:
                meta = _INDEX.get(run_id)
                if meta:
                    meta["status"] = status
                    meta["finished"] = time.time()
                    _save_index()
            # 无论成败、无论时长都推送发起人(best-effort, 不抛异常)
            try:
                threading.Thread(target=_notify, daemon=True,
                                 args=(username, run_id, status, question,
                                       route, error_brief)).start()
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()
    return run_id


def _notify(username: str, run_id: str, status: str, question: str,
            route: str, error_brief: str) -> None:
    """run 结束推送: 成功 normal / 失败 high; url 回发起页并带 ?ai=1
    自动打开助手面板。走 cert_alerts.notify_user(去重留痕 + Web Push)。"""
    try:
        import cert_alerts
        brief = " ".join(str(question or "").split())[:60] or "页面助手任务"
        url = route if isinstance(route, str) and route.startswith("/") else "/console"
        url += "&ai=1" if "?" in url else "?ai=1"
        if status == "error":
            cert_alerts.notify_user(
                username, f"page-ai-fail:{run_id}", "agent-done",
                "AI 任务失败",
                (f"「{brief}」执行失败" + (f": {error_brief[:120]}" if error_brief else "")),
                url=url, urgency="high")
        else:
            cert_alerts.notify_user(
                username, f"page-ai-done:{run_id}", "agent-done",
                "AI 任务完成", f"「{brief}」已完成, 点击查看结果",
                url=url, urgency="normal")
    except Exception:
        pass


def get_run(run_id: str, username: str) -> Run | None:
    with _LOCK:
        run = _RUNS.get(run_id)
    return run if run and run.username == username else None


def owns(run_id: str, username: str) -> bool:
    """run 是否归属 username(含已不在内存的: 查 index)。"""
    with _LOCK:
        meta = _INDEX.get(run_id)
    return bool(meta and meta.get("username") == username)


def stop(run_id: str, username: str) -> bool:
    run = get_run(run_id, username)
    if not run:
        return False
    run.stop_event.set()
    return True


def submit_action_result(run_id: str, username: str, results: Any,
                         action_id: str = "") -> bool:
    """前端回传一批页面动作/文件修改的执行结果, 唤醒等待中的工具。

    结果槽是通用的: browser_control 回传 [{target_id, ok, detail}],
    pod_edit_file(diff 卡片) 回传 [{accepted: bool, detail}] —— 本函数
    原样透传, 由工具侧自行解释, 无需改动即可承载接受/拒绝。

    action_id 去重: 断线重连后事件重放可能让前端重复提交同一批动作,
    已回传过的直接忽略(工具早已拿到结果继续跑了)。run 不在内存(已结束/
    被淘汰)时静默返回 True —— 工具侧早已超时, 无需报错。
    """
    run = get_run(run_id, username)
    if not run:
        return True
    with run.cond:
        if action_id and action_id in run.action_ids:
            return True
        if action_id:
            run.action_ids.add(action_id)
        run.action_result = results
    run.action_event.set()
    return True


def _file_events(run_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with open(_jsonl_path(run_id), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def stream(run_id: str, username: str, after: int = 0) -> Iterator[tuple[int, dict[str, Any]] | None]:
    """从 offset 起回放事件(先补历史再跟随), run 结束后自然终止。
    空闲时 yield None 作为 keepalive 心跳。鉴权: run 必须归属 username。"""
    run = get_run(run_id, username)
    i = max(0, after)
    if run:
        while True:
            with run.cond:
                if len(run.events) > i:
                    batch = [(j, run.events[j]) for j in range(i, len(run.events))]
                    i = len(run.events)
                elif run.done:
                    return
                else:
                    run.cond.wait(timeout=10)
                    batch = []
            if batch:
                yield from batch
            else:
                yield None
        return
    # 不在内存(服务重启后/已被淘汰): 从 jsonl 静态回放
    if not owns(run_id, username):
        return
    events = _file_events(run_id)
    for j in range(i, len(events)):
        yield j, events[j]
    with _LOCK:
        status = (_INDEX.get(run_id) or {}).get("status", "")
    # 历史里没有终止帧时补一个, 让前端循环能正常收尾
    if not events or events[-1].get("type") not in ("done", "error"):
        if status == "interrupted":
            yield len(events), {"type": "done", "data": "服务重启, 任务已中断"}
        else:
            yield len(events), {"type": "done", "data": ""}


def list_runs(username: str, active_only: bool = False) -> list[dict[str, Any]]:
    """当前用户的 run 列表(active_only=1 时只看进行中的)。"""
    with _LOCK:
        items = [dict(m) for m in _INDEX.values()
                 if m.get("username") == username]
    if active_only:
        items = [m for m in items if m.get("status") == "running"]
    items.sort(key=lambda m: m.get("created", 0), reverse=True)
    return items
