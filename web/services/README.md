# web/services/ — 可独立运行的服务模块

与 `web/` 顶层扁平模块不同，这里的代码设计成**可以脱离 Flask 进程单独跑**，
通常由 systemd unit 拉起。

## 文件

| 文件 | 说明 |
|---|---|
| `fleet_monitor.py` | 主机清单 + 受限 SSH 采集 + SQLite 时序存储（库，无导入即启动的线程） |
| `__init__.py` | 包标记 |

## ⚠️ 关于 `fleet_monitor.py` 的重复

`fleet_monitor.py` 在 `web/` 顶层和这里各有一份，**内容不同**：

| | `web/fleet_monitor.py`（**生效**） | `web/services/fleet_monitor.py`（旧副本） |
|---|---|---|
| 被谁用 | `web/fleet_sampler.py`、`web/api/infra.py`、`web/insight.py` | 无人 import |
| 保留期 | 7 天 | 30 天 |
| 配置路径 | 支持 `YATTERRA_FLEET_CONFIG` 环境变量 | 硬编码 |
| 输入校验 | 严格（host/user/port/mounts 正则校验） | 宽松 |

**改监控逻辑请改 `web/fleet_monitor.py`。** 这里的副本是历史遗留，
未被任何代码 import，也未纳入 git。

确认当前生效的是哪份：

```bash
cd /opt/yatterra/web && python3 -c "import fleet_monitor; print(fleet_monitor.__file__)"
grep -rn "from fleet_monitor\|import fleet_monitor" /opt/yatterra/web/ --include=*.py | grep -v __pycache__
```

细节见 [SKILL.md](SKILL.md)。
