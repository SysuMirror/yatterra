---
name: yatterra-tests
description: 跑或扩展 YatTerra 后端测试时使用。
---

# web/tests/ — 测试操作指南

## 跑测试

```bash
cd /srv/yatterra/web
PYTHONPATH=/srv/yatterra/web python3 -m unittest discover -s tests -v
```

`PYTHONPATH` 是**必需**的：`web/` 下的模块是扁平的（`import fleet_monitor`），
不在任何包里。`tests/` 也没有 `__init__.py`，所以别用 `tests.test_fleet` 这种写法。

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
