# web/tests/ — 后端单元测试

标准库 `unittest`，无 pytest 依赖。

## 文件

| 文件 | 覆盖 |
|---|---|
| `test_fleet.py` | `fleet_monitor` 的 SQLite 存储/保留期/校验、`fleet_probe` 的解析、错误处理、`Store` 只读访问 |

## 运行

```bash
cd /srv/yatterra/web
PYTHONPATH=/srv/yatterra/web python3 -m unittest discover -s tests -v
# 或单个文件
PYTHONPATH=/srv/yatterra/web python3 tests/test_fleet.py
```

注意：**必须**设 `PYTHONPATH`（模块是扁平的，不在包内）。
不要用 `python3 -m unittest tests.test_fleet`——`tests/` 没有 `__init__.py`。

细节见 [SKILL.md](SKILL.md)。
