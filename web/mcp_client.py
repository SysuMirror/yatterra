"""MCP (Model Context Protocol) client + server registry + per-run management.

Self-contained, no external MCP SDK. Supports:
  - stdio transport (spawn a local server, e.g. npx -y @playwright/mcp)
  - http transport (streamable HTTP / SSE, JSON-RPC 2.0)

Registry: /opt/yatterra/mcp_servers.json
  [{name, transport:"stdio"|"http", command:[...]|url, env:{}, headers:{},
    enabled, init_timeout, call_timeout}, ...]

Per agent: agent_def["mcp"] = ["server_name", ...]. At run time a McpRun
(keyed by run_id, shared across nodes/sub-agents) lazily connects attached
servers, caches clients, and is torn down at run end. Tool names exposed to
the model are namespaced: mcp__<server>__<tool>.
"""
import json
import os
import subprocess
import threading
import time

import requests

import siteconf

SERVERS_FILE = siteconf.path("mcp_servers.json")

_MCP_LOCK = threading.Lock()
_RUN_MCP = {}

PROTO_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "sseinfra-agent", "version": "1.0"}


class McpError(Exception):
    pass


# ----------------------------- registry -----------------------------
def _normalize_server(s):
    s = dict(s)
    s["name"] = str(s.get("name", "")).strip()
    s["transport"] = "http" if s.get("transport") == "http" else "stdio"
    s["enabled"] = bool(s.get("enabled", True))
    cmd = s.get("command")
    if isinstance(cmd, str):
        cmd = [cmd]
    s["command"] = [str(x) for x in (cmd or [])]
    s["url"] = str(s.get("url", "") or "")
    s["env"] = {str(k): str(v) for k, v in (s.get("env") or {}).items()}
    s["headers"] = {str(k): str(v) for k, v in (s.get("headers") or {}).items()}
    try:
        s["init_timeout"] = int(s.get("init_timeout", 60) or 60)
    except (TypeError, ValueError):
        s["init_timeout"] = 60
    try:
        s["call_timeout"] = int(s.get("call_timeout", 60) or 60)
    except (TypeError, ValueError):
        s["call_timeout"] = 60
    return s


def load_servers():
    """Return list of server defs (normalized). Never raises."""
    try:
        with open(SERVERS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return [_normalize_server(s) for s in (data.get("servers") or [])]
    except Exception:
        return []


def save_servers(servers):
    data = {"servers": [_normalize_server(s) for s in servers]}
    with open(SERVERS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(SERVERS_FILE, 0o600)
    except OSError:
        pass


def get_server(name):
    for s in load_servers():
        if s["name"] == name:
            return s
    return None


# ----------------------------- content rendering -----------------------------
def _render_content(result):
    """Render a tools/call result into a string."""
    if not result:
        return ""
    parts = []
    for c in (result.get("content") or []):
        if not isinstance(c, dict):
            parts.append(str(c))
            continue
        if c.get("type") == "text":
            parts.append(c.get("text", ""))
        else:
            parts.append(json.dumps(c, ensure_ascii=False))
    text = "\n".join(parts).strip()
    if result.get("isError"):
        text = "【MCP 工具报错】\n" + text
    return text


# ----------------------------- clients -----------------------------
class McpClient:
    def initialize(self):
        raise NotImplementedError

    def list_tools(self):
        raise NotImplementedError

    def call_tool(self, name, arguments):
        raise NotImplementedError

    def close(self):
        pass


class StdioMcpClient(McpClient):
    def __init__(self, command, env, init_timeout=60, call_timeout=60):
        self.command = command
        self.env = env
        self.init_timeout = init_timeout
        self.call_timeout = call_timeout
        self._proc = None
        self._next_id = 1
        self._pending = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._reader = None

    def _start(self):
        if not self.command:
            raise McpError("stdio MCP 服务未配置 command")
        env = dict(os.environ)
        for k, v in self.env.items():
            env[str(k)] = str(v)
        try:
            self._proc = subprocess.Popen(
                self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=env,
            )
        except Exception as e:
            raise McpError(f"启动 stdio MCP 失败: {e}")
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        try:
            for line in self._proc.stdout:
                line = line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                mid = msg.get("id")
                if mid is None:
                    continue  # notification, ignore
                with self._lock:
                    p = self._pending.get(mid)
                    if p is not None:
                        p["resp"] = msg
                        p["event"].set()
        except Exception:
            pass

    def _send(self, method, params=None, timeout=None):
        if self._proc is None or self._proc.poll() is not None:
            raise McpError(f"MCP 进程已退出({method})")
        with self._lock:
            mid = self._next_id
            self._next_id += 1
        req = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            req["params"] = params
        ev = threading.Event()
        with self._lock:
            self._pending[mid] = {"resp": None, "event": ev}
        try:
            with self._write_lock:
                self._proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
                self._proc.stdin.flush()
        except Exception as e:
            with self._lock:
                self._pending.pop(mid, None)
            raise McpError(f"发送 {method} 失败: {e}")
        if not ev.wait(timeout or self.call_timeout):
            with self._lock:
                self._pending.pop(mid, None)
            raise McpError(f"{method} 超时")
        with self._lock:
            p = self._pending.pop(mid, None)
        resp = (p or {}).get("resp")
        if resp is None:
            raise McpError(f"{method} 无响应")
        if "error" in resp:
            err = resp["error"]
            raise McpError(f"{method} 错误: {err.get('message', err)}")
        return resp.get("result")

    def _notify(self, method, params=None):
        req = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            req["params"] = params
        try:
            with self._write_lock:
                self._proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
                self._proc.stdin.flush()
        except Exception:
            pass

    def initialize(self):
        self._start()
        self._send("initialize", {"protocolVersion": PROTO_VERSION,
                                  "capabilities": {}, "clientInfo": CLIENT_INFO},
                   self.init_timeout)
        self._notify("notifications/initialized")

    def list_tools(self):
        result = self._send("tools/list", {}, self.call_timeout)
        return (result or {}).get("tools", []) if isinstance(result, dict) else []

    def call_tool(self, name, arguments):
        result = self._send("tools/call", {"name": name, "arguments": arguments or {}},
                            self.call_timeout)
        return _render_content(result)

    def close(self):
        try:
            if self._proc and self._proc.poll() is None:
                try:
                    self._proc.stdin.close()
                except Exception:
                    pass
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except Exception:
                    self._proc.kill()
        except Exception:
            pass


class HttpMcpClient(McpClient):
    def __init__(self, url, headers, init_timeout=60, call_timeout=60):
        self.url = url
        self.headers = headers or {}
        self.session_id = None
        self._next_id = 1
        self.init_timeout = init_timeout
        self.call_timeout = call_timeout

    def _headers(self):
        h = dict(self.headers)
        h["Content-Type"] = "application/json"
        h["Accept"] = "application/json, text/event-stream"
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _post(self, req, timeout):
        if not self.url:
            raise McpError("http MCP 服务未配置 url")
        r = requests.post(self.url, json=req, headers=self._headers(), timeout=timeout)
        sid = r.headers.get("Mcp-Session-Id")
        if sid:
            self.session_id = sid
        ct = r.headers.get("Content-Type", "")
        if "text/event-stream" in ct:
            return self._parse_sse(r.text, req.get("id"))
        try:
            return json.loads(r.text)
        except Exception as e:
            raise McpError(f"http MCP 响应非 JSON: {e}")

    def _parse_sse(self, text, expected_id):
        for block in text.split("\n\n"):
            data_lines = []
            for line in block.splitlines():
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
            if not data_lines:
                continue
            try:
                msg = json.loads("".join(data_lines))
            except json.JSONDecodeError:
                continue
            if msg.get("id") == expected_id or "result" in msg or "error" in msg:
                return msg
        raise McpError("SSE 流中无匹配响应")

    def _send(self, method, params=None, timeout=None):
        mid = self._next_id
        self._next_id += 1
        req = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            req["params"] = params
        resp = self._post(req, timeout or self.call_timeout)
        if "error" in resp:
            err = resp["error"]
            raise McpError(f"{method} 错误: {err.get('message', err)}")
        return resp.get("result")

    def initialize(self):
        self._send("initialize", {"protocolVersion": PROTO_VERSION,
                                  "capabilities": {}, "clientInfo": CLIENT_INFO},
                   self.init_timeout)
        # notifications/initialized over HTTP: POST without id, ignore response
        try:
            requests.post(self.url, json={"jsonrpc": "2.0",
                         "method": "notifications/initialized"}, headers=self._headers(),
                         timeout=self.call_timeout)
        except Exception:
            pass

    def list_tools(self):
        result = self._send("tools/list", {}, self.call_timeout)
        return (result or {}).get("tools", []) if isinstance(result, dict) else []

    def call_tool(self, name, arguments):
        result = self._send("tools/call", {"name": name, "arguments": arguments or {}},
                            self.call_timeout)
        return _render_content(result)

    def close(self):
        try:
            if self.session_id:
                requests.delete(self.url, headers=self._headers(), timeout=5)
        except Exception:
            pass


def _build_client(srv):
    if srv["transport"] == "http":
        return HttpMcpClient(srv["url"], srv["headers"], srv["init_timeout"], srv["call_timeout"])
    return StdioMcpClient(srv["command"], srv["env"], srv["init_timeout"], srv["call_timeout"])


# ----------------------------- per-run management -----------------------------
class McpRun:
    def __init__(self, run_id):
        self.run_id = run_id
        self._clients = {}
        self._lock = threading.Lock()

    def client(self, name):
        with self._lock:
            entry = self._clients.get(name)
        if entry is not None:
            return entry
        srv = get_server(name)
        if not srv:
            raise McpError(f"MCP 服务 {name} 不存在")
        if not srv["enabled"]:
            raise McpError(f"MCP 服务 {name} 已禁用")
        c = _build_client(srv)
        c.initialize()
        with self._lock:
            # another thread may have built it meanwhile
            entry = self._clients.get(name)
            if entry is None:
                self._clients[name] = c
                entry = c
            else:
                try:
                    c.close()
                except Exception:
                    pass
        return entry

    def list_tools(self, name):
        return self.client(name).list_tools()

    def call(self, name, tool, args):
        return self.client(name).call_tool(tool, args)

    def close_all(self):
        with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for c in clients:
            try:
                c.close()
            except Exception:
                pass


def get_mcp_run(run_id):
    with _MCP_LOCK:
        r = _RUN_MCP.get(run_id)
        if r is None:
            r = McpRun(run_id)
            _RUN_MCP[run_id] = r
        return r


def cleanup_mcp(run_id):
    with _MCP_LOCK:
        r = _RUN_MCP.pop(run_id, None)
    if r:
        r.close_all()


# ----------------------------- one-shot test (for /mcp/test) -----------------------------
def test_server(srv):
    """Build a client, initialize, list_tools, close. Returns list of tool dicts.
    Raises McpError on failure."""
    srv = _normalize_server(srv)
    c = _build_client(srv)
    try:
        c.initialize()
        tools = c.list_tools()
        return [{"name": t.get("name"),
                 "description": (t.get("description") or "")[:300],
                 "inputSchema": t.get("inputSchema")}
                for t in tools]
    finally:
        try:
            c.close()
        except Exception:
            pass
