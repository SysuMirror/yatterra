# 新增节点

用 `scripts/install-node.sh` 规划一台新机器。脚本只做登记计划。`--check` 打印计划后退出，不打开 SSH，不加入 k3s，也不写 `remote_hosts.json`。

三种架构，命令里的 `--kind` 用其中一个：

| kind | 含义 |
|---|---|
| `cpu` | cpu node。不宣告 NVIDIA GPU，不安装 NVIDIA device plugin，不设置 unified memory。 |
| `gpu` | gpu node。独立加速器（discrete accelerator）。安装 NVIDIA 驱动和 device plugin，让节点宣告 `nvidia.com/gpu`。不设置 unified memory，不在 profile 里填写独立显存容量。 |
| `unified-memory` | unified memory。`unified_memory` 为真，系统内存和加速器内存是同一块。独立显存容量留空（`discrete_vram_bytes` 为 null）。不要抄另一台机器的磁盘列表。 |

NPU 不是第四种安装架构，它仍是平台节点上的放置别名。

## 操作者要提供的内容

- `name`：节点名。profile 的键、`ssh_host`、`remote_hosts.json` 里的 `name` 必须是这同一个名字。
- `--ssh`：SSH 目标（主机名或地址）。
- `--mount`：这台机器自己的磁盘挂载，可重复。只采样这些路径。
- `--kind`：上面三种架构之一。
- 可选 `--arch amd64|arm64`。不写时 cpu node 和 gpu node 默认 `amd64`，unified memory 默认 `arm64`。
- 可选 `--user`、`--port`。SSH 凭据不要写进命令行，登记远程主机时另行提供。

## 检查

```bash
scripts/install-node.sh --check --kind cpu --name newcpu --ssh newcpu.example --mount / --mount /data
scripts/install-node.sh --check --kind gpu --name newgpu --ssh newgpu.example --mount /
scripts/install-node.sh --check --kind unified-memory --name newum --ssh newum.example --mount /
```

同一组参数打印的计划应当一致。cpu node、gpu node、unified memory 的计划在这几项上不同：是否宣告 NVIDIA GPU、是否 `unified_memory`、加速器是 `none` / `discrete` / `unified`。三种计划的 `discrete_vram_bytes` 都是 null。

## 登记之后采样自动跟上

计划里的 `registry_profile` 写进节点 registry（`nodes.py` 或 `YATTERRA_NODES_JSON`）。同名条目写进 `remote_hosts.json`。`yatterra-fleet-sampler` 通过 `fleet_monitor.collect_host` 调用共享探针 `fleet_probe.collect`。驱动版本、按 Pod 的显存、网络速率和磁盘 IO 都在这支探针里，不为新主机再写一支采集脚本。

K3s 节点列表、FRP、MinIO、数据库和反向代理是平台服务，不由这个脚本安装。
