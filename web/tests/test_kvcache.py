"""kvcache: Redis discovery is bounded and self-heals.

No Redis needed — we exercise the failure path (dead endpoint) and the retry
gate directly. Module globals are saved/restored so this never affects other
tests.
"""
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import kvcache


class TcpProbe(unittest.TestCase):
    def test_dead_endpoint_is_bounded_by_timeout(self):
        t = time.monotonic()
        self.assertFalse(
            kvcache._tcp_reachable("10.255.255.1", 6379, timeout=1.0)
        )
        self.assertLess(time.monotonic() - t, 2.5)   # not redis-py's tens of s

    def test_nothing_listening_on_loopback_port(self):
        self.assertFalse(kvcache._tcp_reachable("127.0.0.1", 1, timeout=1.0))


class RetryGate(unittest.TestCase):
    def setUp(self):
        self._saved = (kvcache._redis, kvcache._retry_at, dict(os.environ))
        self.addCleanup(self._restore)

    def _restore(self):
        redis_, retry, env = self._saved
        kvcache._redis, kvcache._retry_at = redis_, retry
        os.environ.clear()
        os.environ.update(env)

    def test_failure_arms_a_cooldown_instead_of_latching(self):
        os.environ["REDIS_HOST"] = "127.0.0.1"
        os.environ["REDIS_PORT"] = "1"
        os.environ["REDIS_PASSWORD"] = "x"
        kvcache.reset()
        self.assertIsNone(kvcache.get("kvcache-test-key"))
        self.assertIs(kvcache._redis, kvcache._SENTINEL)
        self.assertGreater(kvcache._retry_at, time.time())  # cooldown armed

    def test_reset_clears_the_cooldown(self):
        kvcache._redis = kvcache._SENTINEL
        kvcache._retry_at = time.time() + 999
        kvcache.reset()
        self.assertIsNone(kvcache._redis)
        self.assertEqual(kvcache._retry_at, 0.0)


if __name__ == "__main__":
    unittest.main()
