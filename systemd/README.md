# systemd/ — 后台守护 unit 副本

平台全部 systemd 服务的 unit 文件**副本**，方便版本管理与对照。

## ⚠️ 这里是副本，不是生效位置

生效的是 `/etc/systemd/system/`。改这里**不会**改变服务行为。

```bash
# 生效位置
ls /etc/systemd/system/yatterra* /etc/systemd/system/sse-* /etc/systemd/system/gpu-scheduler*
systemctl cat yatterra-web
```

## ⚠️ 路径是占位符

源码与 unit 里的路径用通用占位符 **`/srv/yatterra`**，不是任何真实部署的路径。
部署时把 `WorkingDirectory=` / `ExecStart=` / `EnvironmentFile=` 改成实际路径。

## 服务清单

| unit | 入口 | 作用 |
|---|---|---|
| `yatterra-web` | `web/app.py`（gunicorn） | 管理 GUI + REST API + 后台线程 |
| `yatterra-fleet-sampler` | `web/fleet_sampler.py --interval 15` | 多主机指标采集 → SQLite |
| `yatterra-req-estimator` | `web/req_loop.py` | EWMA 估算 k8s requests |
| `gpu-scheduler` | `web/gpu_loop.py` | GPU 压力迁移 / 驱逐 |
| `sse-pressure-writer` | `web/pressure_writer.py` | 写主机压力信号（root） |
| `sse-priority-kill` | `web/priority_kill.py` | 按 PRIORITY 驱逐（root） |
| `yatterra-pwa-alert-monitor` | `web/pwa_alerts.py` | Pod 告警 → PWA 推送 |
| `yatterra-pwa-alert-queue` | `web/pwa_alerts.py` | 推送队列 worker |

`yatterra-web` 还有一个 drop-in 副本：`yatterra-web.service.d/llm-concurrency.conf`
（设 `LLM_MAX_CONCURRENCY`、`LLM_MAX_RETRIES`）。

## 环境变量

所有 unit 都通过 `EnvironmentFile` 读 `<平台根目录>/.env`。源码里的默认值是
通用占位符，**真实部署的域名/路径必须写在 `.env` 里**，否则守护进程会读到
占位值（压力文件写错目录、驱逐循环读不到信号等，且不会报错）。

覆盖单个变量用 drop-in，别改主 unit：

```bash
sudo systemctl edit yatterra-web       # 生成 /etc/systemd/system/yatterra-web.service.d/override.conf
```

细节见 [SKILL.md](SKILL.md)。
