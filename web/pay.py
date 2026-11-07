"""学人汇「通用开放支付」客户端 + 订单/回调结算(预付费充值)。

移植自 sysudate pod 的 ``api/pay.js``,但**只保留充值入账**这条主干:它不再发放
"权益"(entitlement),支付的产物是**组账户余额**——`billing_store.credit_topup`。

配置读取顺序:环境变量 → ``<platform root>/pay.json``(``{app_id, app_secret,
api_base, notify_url, return_url}``)。密钥只从这里来,绝不写死、绝不入日志。

对外两条链路:

* **出**:后端→学人汇 `POST /orders` 下单,拿到小程序支付入口(short_url/scheme_url);
  用户在小程序内完成微信支付。请求用 HMAC 签名(X-App-Id/X-Timestamp/X-Nonce/
  X-Signature,见 ``pay_sign``)。
* **入**:学人汇签名回调 `POST {notify_url}` → ``settle_paid`` 把订单置 paid 并给组
  充值。回调幂等:订单状态与台账 ``UNIQUE(out_trade_no)`` 双保险。
"""
import json
import os
import time
from pathlib import Path

import siteconf
import pay_sign

try:
    import requests
except Exception:  # pragma: no cover - requests is a hard dep elsewhere, kept optional here
    requests = None

users = None  # lazy: import_module("users") at first DB touch (keeps import order safe)


def _users():
    global users
    if users is None:
        from importlib import import_module
        users = import_module("users")
    return users


# ── config ───────────────────────────────────────────────────────
_DEFAULT_API_BASE = "https://fhapi.thinkerhui.top/api/v1/pay/open"
CREATE_PATH = "/api/v1/pay/open/orders"


def _file_cfg():
    try:
        with open(siteconf.path("pay.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def config():
    """Resolved payment config (env wins over pay.json; never logs the secret)."""
    fc = _file_cfg()
    return {
        "api_base": (os.environ.get("PAY_API_BASE") or fc.get("api_base") or _DEFAULT_API_BASE).rstrip("/"),
        "app_id": os.environ.get("PAY_APP_ID") or fc.get("app_id") or "yatterra",
        "app_secret": os.environ.get("PAY_APP_SECRET") or fc.get("app_secret") or "",
        "notify_url": os.environ.get("PAY_NOTIFY_URL") or fc.get("notify_url") or "",
        "return_url": os.environ.get("PAY_RETURN_URL") or fc.get("return_url") or "",
    }


def notify_path():
    """Path component of the configured notify URL (what the gateway signs)."""
    url = config()["notify_url"]
    try:
        from urllib.parse import urlsplit
        p = urlsplit(url).path
        return p or "/api/billing/pay/notify"
    except Exception:
        return "/api/billing/pay/notify"


def configured():
    """True when an app secret is present (gateway calls are possible)."""
    return bool(config()["app_secret"])


# ── gateway client ───────────────────────────────────────────────
def signed_headers(method, path, body=b"", cfg=None):
    cfg = cfg or config()
    ts = str(int(time.time()))
    nonce = os.urandom(8).hex()
    return {
        "Content-Type": "application/json",
        "X-App-Id": cfg["app_id"],
        "X-Timestamp": ts,
        "X-Nonce": nonce,
        "X-Signature": pay_sign.sign(cfg["app_secret"], method, path, ts, nonce, body),
    }


def _http(method, url, headers, body):
    """Single HTTP call: requests if available, else urllib.  10s timeout."""
    if requests is not None:
        resp = requests.request(method, url, headers=headers, data=body or None, timeout=10)
        text = resp.text
        status = resp.status_code
    else:  # pragma: no cover - fallback path
        import urllib.request
        import urllib.error
        req = urllib.request.Request(url, data=body or None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                status = r.status
                text = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status = e.code
            text = e.read().decode("utf-8", "replace")
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = None
    return status, parsed, text


def call_open_api(method, path, payload=None):
    """Signed server-to-server call.  Raises ``PayError`` on transport/API error."""
    cfg = config()
    if not cfg["app_secret"]:
        raise PayError("未配置 PAY_APP_SECRET", status=503)
    body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    # api_base already ends at .../open, and path is the full signed path — strip
    # the duplicated prefix exactly like the JS reference.
    url = cfg["api_base"] + path.replace("/api/v1/pay/open", "")
    try:
        status, parsed, text = _http(method, url, signed_headers(method, path, body, cfg), body)
    except Exception as exc:
        raise PayError(f"开放支付接口不可达: {exc}", status=502)
    if status < 200 or status >= 300:
        msg = None
        if isinstance(parsed, dict):
            msg = parsed.get("detail") or parsed.get("msg")
        raise PayError(str(msg or f"开放支付接口错误 {status}"), status=status)
    return parsed


class PayError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def create_order(*, amount_cents, subject, out_trade_no, resource_id=None,
                 return_url=None, extra=None):
    """Create a gateway order; returns the raw gateway dict."""
    payload = {
        "amount_cents": int(amount_cents),
        "subject": subject,
        "out_trade_no": out_trade_no,
    }
    if resource_id:
        payload["resource_id"] = resource_id
    if return_url:
        payload["return_url"] = return_url
    if extra:
        payload["extra"] = extra
    return call_open_api("POST", CREATE_PATH, payload)


def query_order(out_trade_no):
    """Query gateway order state (used by the 4s poller / reconcile)."""
    from urllib.parse import quote
    path = CREATE_PATH + "/" + quote(str(out_trade_no), safe="")
    return call_open_api("GET", path)


# ── schema (MySQL, same db as billing_store) ─────────────────────
_INIT = False
_DDL = (
    """
    CREATE TABLE IF NOT EXISTS pay_items (
        item_key     VARCHAR(64)   PRIMARY KEY,
        title        VARCHAR(128)  NOT NULL,
        amount_cents BIGINT        NOT NULL,
        credit_cents BIGINT        NOT NULL DEFAULT 0,
        description  VARCHAR(255)  NULL,
        sort_order   INT           NOT NULL DEFAULT 0,
        is_active    TINYINT(1)    NOT NULL DEFAULT 1,
        created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS pay_orders (
        id             BIGINT       AUTO_INCREMENT PRIMARY KEY,
        out_trade_no   VARCHAR(64)  NOT NULL UNIQUE,
        fs_order_no    VARCHAR(64)  NULL,
        item_key       VARCHAR(64)  NOT NULL,
        subject        VARCHAR(128) NULL,
        amount_cents   BIGINT       NOT NULL,
        credit_cents   BIGINT       NOT NULL DEFAULT 0,
        group_name     VARCHAR(64)  NOT NULL,
        username       VARCHAR(64)  NULL,
        status         VARCHAR(16)  NOT NULL DEFAULT 'pending',
        transaction_id VARCHAR(64)  NULL,
        paid_at        TIMESTAMP    NULL,
        raw_notify     TEXT         NULL,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_group (group_name, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
)


def ensure_schema():
    """Create pay_items / pay_orders once (piggybacks on users' DB bootstrap)."""
    global _INIT
    if _INIT:
        return
    u = _users()
    u._ensure_init()
    with u._conn() as cn, cn.cursor() as cur:
        for ddl in _DDL:
            cur.execute(ddl)
    _INIT = True


# ── items / orders ───────────────────────────────────────────────
def list_items(active_only=True):
    ensure_schema()
    u = _users()
    where = "WHERE is_active=1" if active_only else ""
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute(
            f"""SELECT item_key, title, amount_cents, credit_cents, description,
                       sort_order, is_active
                FROM pay_items {where}
                ORDER BY sort_order ASC, amount_cents ASC""")
        return cur.fetchall() or []


def upsert_item(item_key, title, amount_cents, credit_cents=None, description=None,
                sort_order=0, is_active=1):
    ensure_schema()
    u = _users()
    cents = int(amount_cents)
    credit = int(credit_cents) if credit_cents is not None else cents
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT INTO pay_items
                   (item_key, title, amount_cents, credit_cents, description, sort_order, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE title=VALUES(title), amount_cents=VALUES(amount_cents),
                                       credit_cents=VALUES(credit_cents),
                                       description=VALUES(description),
                                       sort_order=VALUES(sort_order), is_active=VALUES(is_active)""",
            (item_key, title, cents, credit, description, int(sort_order), 1 if is_active else 0))


def get_item(item_key):
    ensure_schema()
    u = _users()
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM pay_items WHERE item_key=%s", (item_key,))
        return cur.fetchone()


def set_item_active(item_key, active):
    ensure_schema()
    u = _users()
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute("UPDATE pay_items SET is_active=%s WHERE item_key=%s",
                    (1 if active else 0, item_key))


def get_order(out_trade_no):
    ensure_schema()
    u = _users()
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM pay_orders WHERE out_trade_no=%s", (out_trade_no,))
        return cur.fetchone()


def record_order(*, out_trade_no, fs_order_no, item_key, subject, amount_cents,
                 credit_cents, group_name, username=None, status="pending"):
    ensure_schema()
    u = _users()
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT INTO pay_orders
                   (out_trade_no, fs_order_no, item_key, subject, amount_cents,
                    credit_cents, group_name, username, status)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (out_trade_no, fs_order_no, item_key, subject, int(amount_cents),
             int(credit_cents), group_name, username, status))


def list_orders(group_name=None, limit=50, offset=0):
    ensure_schema()
    u = _users()
    where, args = "", []
    if group_name:
        where = "WHERE group_name=%s"
        args.append(group_name)
    args += [int(limit), int(offset)]
    with u._conn() as cn, cn.cursor() as cur:
        cur.execute(
            f"""SELECT out_trade_no, fs_order_no, item_key, subject, amount_cents,
                       credit_cents, group_name, username, status, transaction_id,
                       paid_at, created_at
                FROM pay_orders {where} ORDER BY id DESC LIMIT %s OFFSET %s""",
            args)
        return cur.fetchall() or []


def order_stats():
    """Rough totals for the admin dashboard."""
    ensure_schema()
    u = _users()
    with u._conn() as cn, cn.cursor() as cur:
        def agg(where):
            cur.execute(
                f"""SELECT COUNT(*) AS n,
                           COALESCE(SUM(status='paid'),0) AS paid,
                           COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) AS amount,
                           COALESCE(SUM(CASE WHEN status='paid' THEN credit_cents ELSE 0 END),0) AS credit
                    FROM pay_orders {where}""")
            r = cur.fetchone() or {}
            return {"orders": int(r.get("n") or 0), "paid": int(r.get("paid") or 0),
                    "amount_cents": int(r.get("amount") or 0), "credit_cents": int(r.get("credit") or 0)}
        total = agg("")
        today = agg("WHERE created_at >= CURDATE()")
        cur.execute("SELECT COUNT(*) AS c FROM pay_items WHERE is_active=1")
        active_items = int((cur.fetchone() or {}).get("c") or 0)
    return {"total": total, "today": today, "active_items": active_items}


# ── settlement ───────────────────────────────────────────────────
def settle_paid(out_trade_no, transaction_id=None, raw=None):
    """Mark an order paid and credit its group's balance — exactly once.

    Idempotent on both sides: the ledger's ``UNIQUE(out_trade_no)`` absorbs a
    replayed callback (``credit_topup`` returns None), and the order status
    update is a no-op once already ``paid``.  Returns the credited cents (0 when
    it was already settled / order unknown).
    """
    import billing_store

    order = get_order(out_trade_no)
    if not order:
        return 0
    already = order.get("status") == "paid"

    credit = int(order.get("credit_cents") or 0)
    group = order.get("group_name")
    credited = 0
    if group and credit > 0:
        # credit first: a crash between the two steps is repaired by the next
        # callback (credit_topup dedupes on out_trade_no, then we mark paid).
        bal = billing_store.credit_topup(
            group, credit, out_trade_no,
            note=f"微信充值 · {order.get('subject') or order.get('item_key') or ''}",
            actor="pay",
        )
        if bal is not None:
            credited = credit

    if not already:
        u = _users()
        body = json.dumps(raw, ensure_ascii=False) if raw is not None else None
        with u._conn() as cn, cn.cursor() as cur:
            cur.execute(
                """UPDATE pay_orders
                       SET status='paid', transaction_id=%s, paid_at=NOW(), raw_notify=%s
                   WHERE out_trade_no=%s AND status<>'paid'""",
                (transaction_id, body, out_trade_no))
    return credited
