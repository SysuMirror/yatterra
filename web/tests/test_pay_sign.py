"""pay_sign: canonical 串格式 + 固定 HMAC 向量 + 篡改/大小写拒绝。

固定向量与 sysudate pod 的 ``api/pay.js`` 用同一输入对拍得到(node 独立实现),
保证两边签名逐字节一致。
"""
import unittest

import pay_sign


BODY = b'{"event":"payment.succeeded","out_trade_no":"YT123"}'
TS = "1700000000"
NONCE = "abcdef0123456789"
PATH = "/api/billing/pay/notify"
SECRET = "s3cr3t"
# node: hmac(sha256, canon) over ["POST", PATH, TS, NONCE, sha256hex(BODY)]
EXPECTED_CANON = "\n".join([
    "POST", PATH, TS, NONCE,
    "99d0b617f0be3bd637257bce4cd48a06d6937ecc54c75105242a464ea29854de",
])
EXPECTED_SIG = "8de148abca993c9b37de60b87fb000223121bbfcbc6d67f91b1cc02e10149680"


class Canonical(unittest.TestCase):
    def test_format(self):
        self.assertEqual(pay_sign.canonical("POST", PATH, TS, NONCE, BODY), EXPECTED_CANON)

    def test_method_upper(self):
        self.assertEqual(pay_sign.canonical("post", PATH, TS, NONCE, BODY), EXPECTED_CANON)

    def test_empty_body_digest(self):
        canon = pay_sign.canonical("GET", "/x", "1", "n", b"")
        self.assertTrue(canon.endswith("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))

    def test_body_digest_accepts_str(self):
        self.assertEqual(pay_sign.body_digest(BODY), pay_sign.body_digest(BODY.decode()))


class SignVerify(unittest.TestCase):
    def test_fixed_vector(self):
        self.assertEqual(pay_sign.sign(SECRET, "POST", PATH, TS, NONCE, BODY), EXPECTED_SIG)

    def test_verify_ok(self):
        self.assertTrue(pay_sign.verify(SECRET, "POST", PATH, TS, NONCE, BODY, EXPECTED_SIG))

    def test_verify_uppercase_sig(self):
        self.assertTrue(pay_sign.verify(SECRET, "POST", PATH, TS, NONCE, BODY, EXPECTED_SIG.upper()))

    def test_verify_wrong_secret(self):
        self.assertFalse(pay_sign.verify("nope", "POST", PATH, TS, NONCE, BODY, EXPECTED_SIG))

    def test_verify_tampered_body(self):
        self.assertFalse(pay_sign.verify(
            SECRET, "POST", PATH, TS, NONCE,
            b'{"event":"payment.succeeded","out_trade_no":"YT123","x":1}', EXPECTED_SIG))

    def test_verify_reserialized_body_rejected(self):
        # 键序/空格变了 → 摘要变 → 拒绝(说明必须用原始字节验签)
        reser = b'{"out_trade_no":"YT123","event":"payment.succeeded"}'
        self.assertFalse(pay_sign.verify(SECRET, "POST", PATH, TS, NONCE, reser, EXPECTED_SIG))

    def test_verify_missing_sig(self):
        self.assertFalse(pay_sign.verify(SECRET, "POST", PATH, TS, NONCE, BODY, None))


if __name__ == "__main__":
    unittest.main()
