"""学人汇「通用开放支付」HMAC-SHA256 签名 — 纯函数,无副作用,可直接单测。

签名口径(必须与学人汇 ``open_pay_sign.py`` 逐字节一致,也与 sysudate pod 的
``api/pay.js`` 同构):

    canonical = "\n".join([METHOD, path, str(ts), nonce, sha256hex(body)])
    signature = HMAC_SHA256(secret, canonical).hexdigest()

其中 ``body`` 是**原始请求字节**(GET/无体则为空字节);``sha256hex`` 是小写十六
进制。回调验签必须使用原始 body 字节,绝不能先解析 JSON 再重序列化 —— 键序/空格
任何差异都会让摘要对不上。

本模块刻意不 import 任何本项目模块,可脱离 Flask / MySQL 测试。
"""
import hashlib
import hmac


def body_digest(body=b""):
    """SHA-256 hex of the raw request body (empty body → digest of b"")."""
    if body is None:
        body = b""
    if isinstance(body, str):
        body = body.encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def canonical(method, path, ts, nonce, body=b""):
    """Build the canonical signing string (no trailing newline)."""
    return "\n".join([
        str(method).upper(),
        str(path),
        str(ts),
        str(nonce),
        body_digest(body),
    ])


def sign(secret, method, path, ts, nonce, body=b""):
    """HMAC-SHA256 hex digest over the canonical string."""
    canon = canonical(method, path, ts, nonce, body)
    return hmac.new(
        (secret or "").encode("utf-8"), canon.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def verify(secret, method, path, ts, nonce, body, signature):
    """Constant-time check of ``signature``; tolerant of upper/lower case."""
    expected = sign(secret, method, path, ts, nonce, body)
    got = str(signature or "").strip().lower()
    return hmac.compare_digest(expected, got)
