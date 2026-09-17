#!/usr/bin/env python3
"""YatTerra CLI — manage the platform from the command line.

Config: ~/.yatterra/config (INI) or env vars YATTERRA_URL + YATTERRA_TOKEN.

Usage:
  yatterra help [command]
  yatterra config set --url URL --token TOKEN
  yatterra config show
  yatterra users list
  yatterra users create NAME --password P [--role R]
  yatterra users delete NAME
  yatterra users role NAME ROLE
  yatterra users password NAME PASSWORD
  yatterra groups list
  yatterra groups create NAME [--gpu 0,1] [--cpu N] [--mem M]
  yatterra groups delete NAME
  yatterra groups start|stop|restart NAME
  yatterra groups logs NAME [--lines N]
  yatterra deploy list GROUP
  yatterra deploy add GROUP --repo URL [--branch B] [--name N]
  yatterra deploy run|stop|delete GROUP ID
  yatterra deploy status GROUP ID
  yatterra deploy logs GROUP ID [--lines N]
  yatterra storage list
  yatterra storage create-bucket NAME
  yatterra storage delete-bucket NAME
  yatterra storage create-key --label L --bucket B [--perm rw|ro]
  yatterra storage delete-key ID
  yatterra db list
  yatterra db create-cred SERVICE LABEL
  yatterra db delete-cred ID
  yatterra host health
  yatterra audit [--limit N]
  yatterra token list
  yatterra token create [--name N]
  yatterra token delete ID
"""
import argparse, configparser, json, os, sys
import requests

CONFIG_FILE = os.path.expanduser("~/.yatterra/config")
_PARSER = None


# ── config ────────────────────────────────────────────────────
def load_config():
    cp = configparser.ConfigParser()
    cp.read(CONFIG_FILE)
    url = os.environ.get("YATTERRA_URL", cp.get("default", "url", fallback=""))
    token = os.environ.get("YATTERRA_TOKEN", cp.get("default", "token", fallback=""))
    return url, token


def save_config(url, token):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    cp = configparser.ConfigParser()
    cp["default"] = {"url": url or "", "token": token or ""}
    with open(CONFIG_FILE, "w") as f:
        cp.write(f)
    os.chmod(CONFIG_FILE, 0o600)
    print(f"配置已保存到 {CONFIG_FILE}")


# ── API client ────────────────────────────────────────────────
class API:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def _headers(self):
        if not self.token:
            die("未配置 token，请先运行: yatterra config set --url URL --token TOKEN")
        return {"Authorization": f"Bearer {self.token}"}

    def get(self, path, **params):
        r = requests.get(f"{self.url}/api/v1{path}", headers=self._headers(),
                         params=params, timeout=30)
        return self._resp(r)

    def post(self, path, body=None):
        r = requests.post(f"{self.url}/api/v1{path}", headers=self._headers(),
                          json=body or {}, timeout=60)
        return self._resp(r)

    def put(self, path, body=None):
        r = requests.put(f"{self.url}/api/v1{path}", headers=self._headers(),
                         json=body or {}, timeout=30)
        return self._resp(r)

    def delete(self, path):
        r = requests.delete(f"{self.url}/api/v1{path}", headers=self._headers(),
                            timeout=30)
        return self._resp(r)

    @staticmethod
    def _resp(r):
        if r.status_code == 401:
            die("认证失败：token 无效或已过期")
        if r.status_code == 403:
            try:
                die(f"无权限: {r.json().get('error', '')}")
            except Exception:
                die("无权限")
        try:
            return r.json()
        except Exception:
            die(f"服务器返回非 JSON ({r.status_code}): {r.text[:200]}")


def die(msg):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(1)


def get_api():
    url, token = load_config()
    if not url:
        die("未配置 URL，请先运行: yatterra config set --url URL --token TOKEN")
    return API(url, token)


# ── output helpers ────────────────────────────────────────────
def print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def print_table(rows, cols):
    if not rows:
        print("(空)")
        return
    widths = [max(len(h), max(len(str(r.get(k, ""))) for r in rows)) for k, h in cols]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*[h for _, h in cols]))
    print(fmt.format(*["-" * w for w in widths]))
    for r in rows:
        print(fmt.format(*[str(r.get(k, "")) for k, _ in cols]))


def ok(data, msg):
    print(f"✓ {msg}" if data.get("ok") else f"✗ {data.get('error', data)}")


# ── command handlers ──────────────────────────────────────────
def cmd_config(args):
    if args.action == "set":
        url, token = load_config()
        save_config(args.url or url, args.token or token)
    elif args.action == "show":
        url, token = load_config()
        print(f"url   = {url}")
        print(f"token = {token[:20]}..." if token else "token = (未设置)")


def cmd_users(args):
    api = get_api()
    if args.action == "list":
        data = api.get("/users")
        if args.json:
            print_json(data)
        else:
            print_table(data["users"], [("username", "用户名"), ("role", "角色")])
    elif args.action == "create":
        data = api.post("/users", {"username": args.name, "password": args.password,
                                    "role": args.role or "user"})
        ok(data, f"已创建用户 {args.name}")
    elif args.action == "delete":
        ok(api.delete(f"/users/{args.name}"), f"已删除用户 {args.name}")
    elif args.action == "role":
        ok(api.put(f"/users/{args.name}/role", {"role": args.role}),
           f"已设置 {args.name} 角色为 {args.role}")
    elif args.action == "password":
        ok(api.put(f"/users/{args.name}/password", {"password": args.password}),
           f"已修改 {args.name} 密码")


def cmd_groups(args):
    api = get_api()
    if args.action == "list":
        data = api.get("/groups")
        if args.json:
            print_json(data)
        else:
            print_table(data["groups"],
                        [("name", "名称"), ("type", "类型"), ("status", "状态"),
                         ("cpu", "CPU"), ("mem", "内存"), ("my_role", "我的角色")])
    elif args.action == "create":
        body = {"name": args.name}
        for k in ("gpu", "cpu", "mem", "storage"):
            v = getattr(args, k, None)
            if v:
                body[k if k != "gpu" else "gpus"] = v
        data = api.post("/groups", body)
        ok(data, f"已创建 Pod {data.get('name', args.name)}")
    elif args.action == "delete":
        ok(api.delete(f"/groups/{args.name}"), f"已删除 Pod {args.name}")
    elif args.action in ("start", "stop", "restart"):
        ok(api.post(f"/groups/{args.name}/{args.action}"), f"{args.action} {args.name}")
    elif args.action == "logs":
        data = api.get(f"/groups/{args.name}/logs", lines=args.lines)
        if args.json:
            print_json(data)
        else:
            logs = data.get("logs", {})
            print(logs.get("logs", logs) if isinstance(logs, dict) else logs or "(无日志)")


def cmd_deploy(args):
    api = get_api()
    g, act = args.group, args.action
    if act == "list":
        data = api.get(f"/groups/{g}/deploys")
        if args.json:
            print_json(data)
        else:
            print_table(data["deploys"],
                        [("id", "ID"), ("name", "名称"), ("state", "状态"),
                         ("kind", "类型"), ("branch", "分支"), ("auto_deploy", "自动部署")])
    elif act == "add":
        body = {"repo": args.repo}
        for k in ("name", "branch", "subdir", "token", "kind", "gpu", "health"):
            v = getattr(args, k, None)
            if v:
                body[k] = v
        if args.auto_deploy:
            body["auto_deploy"] = True
        data = api.post(f"/groups/{g}/deploys", body)
        if data.get("ok"):
            print(f"✓ 已添加部署 {data.get('name')} (id={data.get('id')})")
        else:
            print(f"✗ {data.get('error', data)}")
    elif act == "run":
        data = api.post(f"/groups/{g}/deploys/{args.id}/run")
        print(f"✓ 部署完成: {data.get('msg', '')}" if data.get("ok")
              else f"✗ 部署失败: {data.get('msg', data.get('error', ''))}")
    elif act == "stop":
        ok(api.post(f"/groups/{g}/deploys/{args.id}/stop"), f"已停止 {args.id}")
    elif act == "status":
        data = api.get(f"/groups/{g}/deploys/{args.id}/status")
        if args.json:
            print_json(data)
        else:
            print(f"名称: {data.get('name', '?')}")
            print(f"状态: {data.get('state', '?')}")
            print(f"自动部署: {'是' if data.get('auto_deploy') else '否'}")
            print(f"最后提交: {data.get('last_ref', '—')}")
    elif act == "logs":
        data = api.get(f"/groups/{g}/deploys/{args.id}/logs", lines=args.lines)
        if args.json:
            print_json(data)
        else:
            print(data.get("logs", "(无日志)"))
    elif act == "delete":
        ok(api.delete(f"/groups/{g}/deploys/{args.id}"), f"已删除部署 {args.id}")


def cmd_host(args):
    api = get_api()
    data = api.get("/host/health")
    if args.json:
        print_json(data)
    else:
        up = data.get("uptime", {})
        load = data.get("load", {})
        print(f"主机: {data.get('hostname', '?')}")
        print(f"运行: {up.get('human', '?')}")
        print(f"负载: {load.get('load1', '?')} {load.get('load5', '?')} {load.get('load15', '?')}")
        mem = data.get("memory", {})
        if mem:
            print(f"内存: {mem.get('used', '?')}/{mem.get('total', '?')} ({mem.get('percent', '?')}%)")


def cmd_storage(args):
    api = get_api()
    act = args.action
    if act == "list":
        data = api.get("/storage")
        if args.json:
            print_json(data)
        else:
            st = data.get("status", {})
            print(f"MinIO: {'就绪' if st.get('ready') else '未就绪'}")
            buckets = data.get("buckets", [])
            if buckets:
                print("\n存储桶:")
                for b in buckets:
                    print(f"  {b}")
            keys = data.get("keys", [])
            if keys:
                print("\n访问密钥:")
                print_table(keys, [("label", "标签"), ("bucket", "桶"), ("perm", "权限")])
    elif act == "create-bucket":
        ok(api.post("/storage/buckets", {"name": args.name}), f"已创建桶 {args.name}")
    elif act == "delete-bucket":
        ok(api.delete(f"/storage/buckets/{args.name}"), f"已删除桶 {args.name}")
    elif act == "create-key":
        data = api.post("/storage/keys", {"label": args.label, "bucket": args.bucket,
                                           "perm": args.perm or "readwrite"})
        if data.get("ok"):
            k = data.get("key", {})
            print(f"✓ 已创建密钥 {k.get('label', '')}")
            print(f"  access_key: {k.get('access_key', '')}")
            print(f"  secret_key: {k.get('secret_key', '')}")
        else:
            print(f"✗ {data.get('error', data)}")
    elif act == "delete-key":
        ok(api.delete(f"/storage/keys/{args.id}"), f"已删除密钥 {args.id}")


def cmd_db(args):
    api = get_api()
    act = args.action
    if act == "list":
        data = api.get("/databases")
        if args.json:
            print_json(data)
        else:
            st = data.get("status", {})
            for svc in ("mysql", "redis", "qdrant"):
                s = st.get(svc, {})
                print(f"{svc}: {'就绪' if s.get('ready') else '未就绪'}")
            creds = data.get("creds", [])
            if creds:
                print("\n凭证:")
                print_table(creds, [("service", "服务"), ("label", "标签"), ("id", "ID")])
    elif act == "create-cred":
        data = api.post("/databases/creds", {"service": args.service, "label": args.label})
        if data.get("ok"):
            c = data.get("cred", {})
            print(f"✓ 已创建 {args.service} 凭证 {c.get('label', '')}")
            for k, v in c.items():
                if k not in ("id", "label") and v:
                    print(f"  {k}: {v}")
        else:
            print(f"✗ {data.get('error', data)}")
    elif act == "delete-cred":
        ok(api.delete(f"/databases/creds/{args.id}"), f"已删除凭证 {args.id}")


def cmd_audit(args):
    api = get_api()
    data = api.get("/audit", limit=args.limit)
    if args.json:
        print_json(data)
    else:
        print_table(data["entries"],
                    [("ts", "时间"), ("actor", "操作者"), ("action", "动作"), ("detail", "详情")])


def cmd_token(args):
    api = get_api()
    if args.action == "list":
        data = api.get("/tokens")
        if args.json:
            print_json(data)
        else:
            print_table(data["tokens"],
                        [("id", "ID"), ("name", "名称"),
                         ("created_at", "创建时间"), ("last_used_at", "最后使用")])
    elif args.action == "create":
        data = api.post("/tokens", {"name": args.name or ""})
        print("✓ 已创建 token (仅显示一次，请妥善保存):")
        print(f"  {data.get('token', '')}")
    elif args.action == "delete":
        ok(api.delete(f"/tokens/{args.id}"), f"已删除 token {args.id}")


def cmd_help(args):
    if not args.command:
        print("""YatTerra CLI — 平台管理命令行工具

用法: yatterra <命令> [子命令] [参数]

命令:
  config    配置连接        config set --url URL --token T | config show
  users     用户管理        users list | create NAME --password P | delete NAME | role NAME R | password NAME P
  groups    Pod 管理         groups list | create NAME | delete NAME | start|stop|restart NAME | logs NAME
  deploy    部署管理        deploy list GROUP | add GROUP --repo URL | run|stop|delete GROUP ID | status GROUP ID | logs GROUP ID
  storage   存储管理        storage list | create-bucket NAME | delete-bucket NAME | create-key ... | delete-key ID
  db        数据库管理       db list | create-cred SERVICE LABEL | delete-cred ID
  host      主机健康        host health
  audit     审计日志        audit [--limit N]
  token     API token       token list | create [--name N] | delete ID
  help      查看帮助        help [command]

选项:
  --json    输出原始 JSON

示例:
  yatterra config set --url http://127.0.0.1:8090 --token yt_xxx
  yatterra groups list
  yatterra groups start mypod
  yatterra deploy add mypod --repo https://github.com/me/app.git
  yatterra deploy run mypod abc123
  yatterra storage create-bucket mydata
  yatterra db create-cred mysql mylabel
  yatterra help groups""")
    else:
        if _PARSER and args.command in _PARSER._subparsers._group_actions[0].choices:
            _PARSER._subparsers._group_actions[0].choices[args.command].print_help()
        else:
            print(f"未知命令: {args.command}")
            print("运行 'yatterra help' 查看所有命令")


# ── help-aware parser ─────────────────────────────────────────
class HelpParser(argparse.ArgumentParser):
    def error(self, message):
        print(f"错误: {message}\n", file=sys.stderr)
        self.print_help()
        sys.exit(2)


# ── argparse setup ────────────────────────────────────────────
def build_parser():
    global _PARSER
    p = HelpParser(prog="yatterra", description="YatTerra CLI — 平台管理命令行工具")
    sub = p.add_subparsers(dest="cmd", required=True)
    jp = argparse.ArgumentParser(add_help=False)
    jp.add_argument("--json", action="store_true", help="输出原始 JSON")

    # help
    sp = sub.add_parser("help", help="查看帮助")
    sp.add_argument("command", nargs="?")
    sp.set_defaults(func=cmd_help)

    # config
    sp = sub.add_parser("config", help="配置")
    s = sp.add_subparsers(dest="action", required=True)
    s_set = s.add_parser("set", help="设置 URL 和 token")
    s_set.add_argument("--url")
    s_set.add_argument("--token")
    s.add_parser("show", help="显示当前配置")
    sp.set_defaults(func=cmd_config)

    # users — positional NAME
    sp = sub.add_parser("users", help="用户管理")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("list", help="列出用户", parents=[jp])
    sp_c = s.add_parser("create", help="创建用户")
    sp_c.add_argument("name", help="用户名")
    sp_c.add_argument("--password", required=True)
    sp_c.add_argument("--role", choices=["super", "admin", "user", "guest"])
    sp_d = s.add_parser("delete", help="删除用户")
    sp_d.add_argument("name")
    sp_r = s.add_parser("role", help="设置角色")
    sp_r.add_argument("name")
    sp_r.add_argument("role", choices=["super", "admin", "user", "guest"])
    sp_p = s.add_parser("password", help="修改密码")
    sp_p.add_argument("name")
    sp_p.add_argument("password")
    sp.set_defaults(func=cmd_users)

    # groups — positional NAME
    sp = sub.add_parser("groups", help="Pod 管理")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("list", help="列出 Pod", parents=[jp])
    sp_c = s.add_parser("create", help="创建 Pod")
    sp_c.add_argument("name")
    sp_c.add_argument("--gpu", help="GPU 编号，逗号分隔 (如 0,1)")
    sp_c.add_argument("--cpu")
    sp_c.add_argument("--mem")
    sp_c.add_argument("--storage")
    sp_d = s.add_parser("delete", help="删除 Pod")
    sp_d.add_argument("name")
    for act in ("start", "stop", "restart"):
        sp_a = s.add_parser(act, help=f"{act} Pod")
        sp_a.add_argument("name")
    sp_l = s.add_parser("logs", help="查看日志", parents=[jp])
    sp_l.add_argument("name")
    sp_l.add_argument("--lines", type=int, default=100)
    sp.set_defaults(func=cmd_groups)

    # deploy — positional GROUP [ID]
    sp = sub.add_parser("deploy", help="部署管理")
    s = sp.add_subparsers(dest="action", required=True)
    sp_l = s.add_parser("list", help="列出部署", parents=[jp])
    sp_l.add_argument("group", help="Pod 名称")
    sp_a = s.add_parser("add", help="添加部署")
    sp_a.add_argument("group", help="Pod 名称")
    sp_a.add_argument("--repo", required=True, help="Git 仓库 URL")
    sp_a.add_argument("--name", help="部署名称 (默认从 repo 推断)")
    sp_a.add_argument("--branch", help="分支 (默认 main/master)")
    sp_a.add_argument("--subdir", help="子目录")
    sp_a.add_argument("--token", help="Git 私有仓库 token")
    sp_a.add_argument("--kind", choices=["serve", "train"], default="serve")
    sp_a.add_argument("--gpu", help="绑定 GPU id (serve 模式)")
    sp_a.add_argument("--auto-deploy", action="store_true", help="webhook 自动部署")
    sp_a.add_argument("--health", help="健康检查路径")
    for act in ("run", "stop"):
        sp_x = s.add_parser(act, help=f"{act} 部署")
        sp_x.add_argument("group", help="Pod 名称")
        sp_x.add_argument("id", help="部署 ID")
    sp_s = s.add_parser("status", help="部署状态", parents=[jp])
    sp_s.add_argument("group")
    sp_s.add_argument("id")
    sp_lg = s.add_parser("logs", help="部署日志", parents=[jp])
    sp_lg.add_argument("group")
    sp_lg.add_argument("id")
    sp_lg.add_argument("--lines", type=int, default=200)
    sp_d = s.add_parser("delete", help="删除部署")
    sp_d.add_argument("group")
    sp_d.add_argument("id")
    sp.set_defaults(func=cmd_deploy)

    # storage — flattened: create-bucket, delete-bucket, create-key, delete-key
    sp = sub.add_parser("storage", help="存储管理")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("list", help="列出桶和密钥", parents=[jp])
    sp_cb = s.add_parser("create-bucket", help="创建桶")
    sp_cb.add_argument("name")
    sp_db = s.add_parser("delete-bucket", help="删除桶")
    sp_db.add_argument("name")
    sp_ck = s.add_parser("create-key", help="创建密钥")
    sp_ck.add_argument("--label", required=True)
    sp_ck.add_argument("--bucket", required=True)
    sp_ck.add_argument("--perm", choices=["readwrite", "readonly"], default="readwrite")
    sp_dk = s.add_parser("delete-key", help="删除密钥")
    sp_dk.add_argument("id")
    sp.set_defaults(func=cmd_storage)

    # db — flattened: create-cred, delete-cred
    sp = sub.add_parser("db", help="数据库管理")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("list", help="列出数据库和凭证", parents=[jp])
    sp_cc = s.add_parser("create-cred", help="创建凭证")
    sp_cc.add_argument("service", choices=["mysql", "redis", "qdrant"])
    sp_cc.add_argument("label")
    sp_dc = s.add_parser("delete-cred", help="删除凭证")
    sp_dc.add_argument("id")
    sp.set_defaults(func=cmd_db)

    # host
    sp = sub.add_parser("host", help="主机")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("health", help="主机健康", parents=[jp])
    sp.set_defaults(func=cmd_host)

    # audit
    sp = sub.add_parser("audit", help="审计日志", parents=[jp])
    sp.add_argument("--limit", type=int, default=50)
    sp.set_defaults(func=cmd_audit)

    # token
    sp = sub.add_parser("token", help="API token 管理")
    s = sp.add_subparsers(dest="action", required=True)
    s.add_parser("list", help="列出 token", parents=[jp])
    sp_c = s.add_parser("create", help="创建 token")
    sp_c.add_argument("--name", help="token 标签")
    sp_d = s.add_parser("delete", help="删除 token")
    sp_d.add_argument("id")
    sp.set_defaults(func=cmd_token)

    _PARSER = p
    return p


def main():
    p = build_parser()
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
