---
name: yatterra-services
description: 改 YatTerra 独立后台服务（主机监控采集、SQLite 时序存储）时使用。
---

# web/services/ — 服务模块操作指南

## 先确认你改的是生效的那份

`fleet_monitor.py` 有两份，**生效的是 `web/fleet_monitor.py`**（顶层）。
`web/services/fleet_monitor.py` 是未被 import 的旧副本。

```bash
cd /opt/yatterra/web && python3 -c "import fleet_monitor; print(fleet_monitor.__file__)"
# → /opt/yatterra/web/fleet_monitor.py
```

改监控逻辑 → 改顶层那份。若确认 `services/` 副本确实无人使用，可以删除，
但删除前先跑上面的 grep 确认。

## 独立运行的服务

目前只有 fleet 采样：

```bash
systemctl status yatterra-fleet-sampler
sudo journalctl -u yatterra-fleet-sampler -n 30 --no-pager
python3 /opt/yatterra/web/fleet_sampler.py --once    # 手动跑一轮
```

- 单写者：`fleet_sampler.py` 用 `flock` 保证只有一个实例写 SQLite。
- 数据库：`/opt/yatterra/web/fleet_metrics.db`（WAL 模式），保留 7 天。
- 采集：本机直接读 `/proc`；远程经 SSH 把 `fleet_probe.py` 源码喂给远端 `python3 -`。
- 采集失败**不落原始异常字符串**（可能含密钥），只记 `Collection failed`。

## 加一个新的独立服务

1. 模块放这里（或 `web/` 顶层，看是否需要被 Flask import）。
2. 入口脚本写 `if __name__ == "__main__": main()`。
3. 在 `systemd/` 放 unit 副本，并 `sudo cp` 到 `/etc/systemd/system/` + `daemon-reload` + `enable --now`。
4. 在 `systemd/README.md` 的表里登记。

## 坑

- 别在模块顶层起线程（`fleet_monitor.py` 的 docstring 特意强调 "No import threads"）——
  它会被 Flask 进程 import，顶层线程会和 web 的后台线程打架。
- SQLite 读要用只读 URI（`file:...?mode=ro`），避免和采样写者抢锁。
- 改完重启对应 unit，不是 `yatterra-web`。
