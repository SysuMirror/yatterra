"""Pod Web 兜底页 (pod_offline.py): 服务没起来 → 404 页; 欠费停机 → 资源已冻结。

不需要 DB / app.py: billing_store / siteconf 全部 stub。三件事必须钉住:

1. 默认文案就是「页面未找到」的 404 页(需求: 没起 web 服务就跳 404 页);
2. 该 Pod 的计费账户被停用(欠费)时, 页面写明「资源已冻结」并给出充值/分配入口;
3. 读计费状态失败时**回退**到通用文案, 绝不把用户甩到一个报错页。
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PodOffline(unittest.TestCase):
    def setUp(self):
        self.bs = MagicMock()
        self.bs.is_blocked.return_value = False
        self.sc = MagicMock()
        self.sc.PLATFORM_URL = "https://cloud.ssemarket.cn"
        self.mods = patch.dict(sys.modules, {"billing_store": self.bs, "siteconf": self.sc})
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.po = load("pod_offline_under_test", "pod_offline.py")

    def test_default_is_the_404_page(self):
        html = self.po.render("pod1")
        self.assertIn("404", html)
        self.assertIn("页面未找到", html)
        self.assertNotIn("资源已冻结", html)
        self.assertIn("pod1", html)

    def test_frozen_when_account_blocked(self):
        self.bs.is_blocked.return_value = True
        html = self.po.render("pod1")
        self.assertIn("资源已冻结", html)
        self.assertIn("https://cloud.ssemarket.cn/billing", html)
        self.bs.is_blocked.assert_called_with("pod1")

    def test_billing_probe_failure_falls_back(self):
        self.bs.is_blocked.side_effect = RuntimeError("db down")
        html = self.po.render("pod1")          # must not raise
        self.assertIn("页面未找到", html)
        self.assertNotIn("资源已冻结", html)

    def test_blank_group_is_generic_and_unlabelled(self):
        html = self.po.render("")
        self.assertIn("页面未找到", html)
        self.bs.is_blocked.assert_not_called()

    def test_group_name_is_html_escaped(self):
        html = self.po.render('"><script>alert(1)</script>')
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)


if __name__ == "__main__":
    unittest.main()
