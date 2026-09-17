# systemd/ — 后台守护 unit 副本

平台三个 systemd 服务的 unit 文件**副本**，方便版本管理与对照。

## ⚠️ 这里是副本，不是生效位置

生效的是 `/etc/systemd/system/`。改这里**不会**改变服务行为。

```bash
# 生效位置
ls /etc/systemd/system/yatterra*
systemctl cat yatterra-web
```

## 三个服务

| unit | 入口 | 作用 | 副本在这里？ |
|---|---|---|---|
| `yatterra-web` | `web/app.py`（gunicorn） | 管理 GUI + REST API + 后台线程 | ❌ 只在 `/etc/systemd/system/` |
| `yatterra-fleet-sampler` | `web/fleet_sampler.py --interval 15` | 多主机指标采集 → SQLite | ✅ `yatterra-fleet-sampler.service` |
| `yatterra-req-estimator` | `web/req_loop.py` | EWMA 估算 k8s requests | ❌ 只在 `/etc/systemd/system/` |

`yatterra-web` 还有一个 drop-in：`/etc/systemd/system/yatterra-web.service.d/llm-concurrency.conf`
（设 `LLM_MAX_CONCURRENCY=6`、`LLM_MAX_RETRIES=4`）。

细节见 [SKILL.md](SKILL.md)。
