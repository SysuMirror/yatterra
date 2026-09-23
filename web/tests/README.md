# web/tests/ — 后端单元测试

标准库 `unittest`，无 pytest 依赖。

## 文件

| 文件 | 覆盖 |
|---|---|
| `test_fleet.py` | `fleet_monitor` 的 SQLite 存储/保留期/校验、`fleet_probe` 的解析、错误处理、`Store` 只读访问 |

## 运行

```bash
# 在项目根目录统一发现，无需设置 PYTHONPATH
python3 -m unittest discover -s web/tests -v
# 或单个文件
python3 web/tests/test_fleet.py
python3 web/tests/test_member_picker.py
```

测试通过自身文件路径定位 `web/` 下的扁平模块，不依赖工作目录或测试加载顺序。
在 `web/` 目录中也可使用 `python3 -m unittest discover -s tests -v`。

细节见 [SKILL.md](SKILL.md)。
