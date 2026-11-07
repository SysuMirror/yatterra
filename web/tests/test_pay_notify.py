"""pay_bp /notify: HMAC 验签闸门 + 幂等结算(裸 Flask,不 import app.py)。

stub 掉 ``pay_mod.settle_paid`` / ``pay_mod.config``,只验证 blueprint 自身:
坏签/过期/app_id 不符 → 401;好签 → 结算一次;重放 → 交给 settle_paid 幂等(此处
用计数模拟:第二次仍会调用,但真实层靠 UNIQUE(out_trade_no) 兜底 —— 故这里断言
"好签一定到达 settle_paid",而非"只到达一次")。
"""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flask import Flask  # noqa: E402

import pay_sign  # noqa: E402
import pay as pay_mod  # noqa: E402
import api.pay as api_pay  # noqa: E402
from api.pay import pay_bp  # noqa: E402

SECRET = "topsecret"
APP_ID = "yatterra"
NOTIFY_URL = "https://cloud.example.com/api/billing/pay/notify"
PATH = "/api/billing/pay/notify"


class NotifyTest(unittest.TestCase):
    def setUp(self):
        self.settled = []
        self._orig_config = pay_mod.config
        self._orig_settle = pay_mod.settle_paid
        self._orig_path = pay_mod.notify_path
        self._orig_audit = api_pay._audit
        api_pay._audit = lambda *a, **k: None  # don't write real audit rows from tests

        pay_mod.config = lambda: {
            "api_base": "https://x", "app_id": APP_ID, "app_secret": SECRET,
            "notify_url": NOTIFY_URL, "return_url": "",
        }
        pay_mod.notify_path = lambda: PATH

        def fake_settle(no, txid=None, raw=None):
            self.settled.append((no, txid))
            return 100
        pay_mod.settle_paid = fake_settle

        app = Flask(__name__)
        app.register_blueprint(pay_bp)
        self.client = app.test_client()

    def tearDown(self):
        pay_mod.config = self._orig_config
        pay_mod.settle_paid = self._orig_settle
        pay_mod.notify_path = self._orig_path
        api_pay._audit = self._orig_audit

    def _post(self, body_bytes, *, ts=None, nonce="n1", sig=None, app_id=APP_ID, event=None):
        ts = ts if ts is not None else str(int(time.time()))
        if sig is None:
            sig = pay_sign.sign(SECRET, "POST", PATH, ts, nonce, body_bytes)
        headers = {"X-App-Id": app_id, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig}
        return self.client.post(PATH, data=body_bytes, headers=headers, content_type="application/json")

    def _body(self, event="payment.succeeded", no="YT1"):
        return json.dumps({"event": event, "out_trade_no": no, "transaction_id": "tx1"}).encode()

    def test_bad_signature_401(self):
        r = self._post(self._body(), sig="deadbeef")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.settled, [])

    def test_wrong_app_id_401(self):
        r = self._post(self._body(), app_id="other")
        self.assertEqual(r.status_code, 401)

    def test_expired_ts_401(self):
        old = str(int(time.time()) - 10_000)
        r = self._post(self._body(), ts=old)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.settled, [])

    def test_good_signature_settles(self):
        r = self._post(self._body(no="YT9"))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])
        self.assertEqual(self.settled, [("YT9", "tx1")])

    def test_ignored_event(self):
        r = self._post(self._body(event="payment.created"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["msg"], "ignored")
        self.assertEqual(self.settled, [])

    def test_replay_still_reaches_settle(self):
        body = self._body(no="YT7")
        self._post(body)
        self._post(body)
        # 幂等由 settle_paid / UNIQUE(out_trade_no) 保证;blueprint 不做去重
        self.assertEqual([s[0] for s in self.settled], ["YT7", "YT7"])


if __name__ == "__main__":
    unittest.main()
