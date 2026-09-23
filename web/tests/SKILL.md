---
name: yatterra-tests
description: 跑或扩展 YatTerra 后端测试时使用。
---

# web/tests/ — 测试操作指南

## 跑测试

```bash
# 在项目根目录运行
python3 -m unittest discover -s web/tests -v
```

无需设置 `PYTHONPATH`：测试通过 `Path(__file__).resolve().parents[1]`
把 `web/` 加入模块搜索路径，兼容根目录 discovery、单文件运行和不同加载顺序。
在 `web/` 中也可运行 `python3 -m unittest discover -s tests -v`。

## 加测试

- 文件名 `test_<模块>.py`，类继承 `unittest.TestCase`。
- 用 `tempfile.TemporaryDirectory()` + `addCleanup` 管理临时状态。
- 需要隔离外部依赖时用 `unittest.mock.patch.object`（见 `test_fleet.py` 里 patch `inventory`）。

**不要** import `app.py` 或任何会启动后台线程的模块 —— 那会在测试进程里拉起
metrics/insight 线程并连生产 Redis。`test_fleet.py` 顶部注释专门说明了这点。

## 前端测试

在 `web/frontend/tests/test_publish_spa.py`，用同样的 unittest 风格：

```bash
cd /srv/yatterra/web/frontend && python3 -m unittest discover -s tests -v
```

`npm test` 是占位符，别用。

## 坑

- 测试直接读写 `/srv/yatterra/*.json` 的模块要 mock 掉，否则会污染生产状态。
- `fleet_probe.py` 是「既当库又当 SSH 脚本」的，测试时注意它是从 stdin 读 JSON 参数的。
