---
name: yatterra-systemd
description: 改 YatTerra 后台服务（unit 文件、环境变量、重启）时使用。
---

# systemd/ — 服务操作指南

## 改 unit 的正确流程

```bash
# 1. 改 /etc/systemd/system/yatterra-xxx.service（生效位置）
sudo systemctl daemon-reload
sudo systemctl restart yatterra-xxx
systemctl status yatterra-xxx --no-pager
# 2. 同步副本到这里，保持版本库有记录
sudo cp /etc/systemd/system/yatterra-xxx.service /opt/yatterra/systemd/
```

**只改 `systemd/` 里的副本是无效的。**

## 常用

```bash
systemctl status yatterra-web yatterra-fleet-sampler yatterra-req-estimator --no-pager
sudo journalctl -u yatterra-web -n 50 --no-pager
sudo systemctl restart yatterra-web
```

## 环境变量

- `yatterra-web` 的密钥来自 `/opt/yatterra/.env`（`EnvironmentFile`）。
- 覆盖单个变量用 drop-in，别改主 unit：

```bash
sudo systemctl edit yatterra-web       # 生成 /etc/systemd/system/yatterra-web.service.d/override.conf
```

现有 drop-in：`llm-concurrency.conf` → `LLM_MAX_CONCURRENCY=6` `LLM_MAX_RETRIES=4`。

## 加一个新服务

1. 写 unit 放 `/etc/systemd/system/`，`WorkingDirectory=/opt/yatterra/web`。
2. `daemon-reload` + `enable --now`。
3. 复制一份到 `systemd/`，并在 `README.md` 的表里登记。

## 坑

- **重启 `yatterra-web` 会杀掉正在跑的 AI 会话**（Agent 运行在 web 进程的线程里）。
  有用户在用助手时别重启。
- `yatterra-web` 的 `workers=1` 是刻意的（SocketIO 需要粘性），别改成多 worker。
- `preload_app=False` 是刻意的（后台线程必须在 worker 内启动），别改成 True。
- fleet-sampler 用 `flock` 保证单实例；手动跑 `--once` 时若服务在跑会拿不到锁。
- 三个服务都以 root 或 `sse` 运行；unit 里的 `User=` 别乱改，很多模块依赖 root 读
  `groups.json`、调 `kubectl`。
