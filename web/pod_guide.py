#!/usr/bin/env python3
"""In-pod programming guide — single source of truth + delivery.

Every group Pod mounts this guide **read-only** at ``/etc/yatterra/README.md``
(a ConfigMap named ``yatterra-pod-guide`` in the group namespace), and the
container init script additionally symlinks it into the pod home
(``~/README.md`` / ``~/AGENTS.md`` / ``~/CLAUDE.md``) so that both humans and AI
coding agents that scan the working directory pick it up automatically.

Keeping the text here means the platform can update the conventions in one place:
edit ``GUIDE`` and call ``apply_configmap()`` (or just redeploy a group — see
``groups.apply_group``), and every Pod that mounts the ConfigMap sees the new
content (kubelet refreshes mounted ConfigMap files in place).

The group Deployment that references the ConfigMap is generated in ``groups.py``
(``deployment_yaml``); this module owns the ConfigMap object and its content.
"""
import os
import subprocess
import tempfile

import audit

import siteconf

NS = siteconf.GROUP_NS
CONFIGMAP = "yatterra-pod-guide"
MOUNT_DIR = "/etc/yatterra"
GUIDE_KEY = "README.md"
GUIDE_PATH = f"{MOUNT_DIR}/{GUIDE_KEY}"


GUIDE = '''# YatTerra 容器（Pod）内编程规范

> 你正运行在一台 **YatTerra 组容器** 里。本文件是 **只读** 的（平台以 ConfigMap 挂载在
> `/etc/yatterra/README.md`），你的主目录里也放了一份软链（`~/README.md`、`~/AGENTS.md`、
> `~/CLAUDE.md`）。动手写代码前请先读一遍 —— 尤其是 **§2 持久化、§3 /shared、§5 MinIO**。

## 0. 环境速览
- 镜像 Ubuntu 24.04，登录用户 `cloud`（uid 1000），普通用户（`sudo` 可用但容器本身非特权）。
- 容器 = K3s Pod，命名空间 `clouds`，跑在 YatTerra 平台上。
- 机器可读的上下文（你的组、GPU、公网端口、服务端点、宿主机信息）都在 **`~/deploy/context.json`**。

## 1. 端口：对外只有一个 8080
- 服务绑到 **`0.0.0.0:8080`**（监听 `0.0.0.0`，不要只绑 `127.0.0.1`，否则外面连不到）。端口变量是 `$PORT`（= 8080）。
- 对外链路：Pod 8080 → Service(NodePort) → frps 中继 → 公网 `https://<PUBLIC_HOST>:<PUBLIC_PORT>`。
  中继侧的 nginx 终结 TLS，**你这边是明文 HTTP**，不要自己起 TLS。
- 22 端口 = SSH（平台已配好，用于登录这台容器）。
- 还想让 **集群内** 其它 Pod 访问别的端口：在平台“组”设置里声明 **内部端口**（internal_ports），
  会得到一个 ClusterIP Service：`group-<组名>-internal.clouds.svc.cluster.local:<port>`。
  **内部端口不对外**，公网只放 8080。不要试图把其它端口暴露到公网。
- 公网地址别硬编码，用 `$PUBLIC_URL` / `$PUBLIC_HOST` / `$PUBLIC_PORT`。

## 2. 数据持久化：只有 /home/cloud 会留下，其它都会丢
- **`/home/cloud`** 是持久化盘（hostPath），Pod 重建/重启后还在 —— 代码、配置、需要保留的产物放这里。
- **容器内其它路径（`/`、`/tmp`、`/var`…）都是临时的**，Pod 一重建就没了；别把重要数据只放这些地方。
- 受管部署（supervisor）的约定目录：
  - `~/deploy/<name>/`：代码 / 工作目录
  - `~/deploy/supervisord.conf`：进程守护配置（**平台维护，别手改**）
  - `~/deploy/<name>/logs/`、`~/logs/`：日志
  - `~/deploy/context.json`：平台注入的上下文
- 每个受管部署进程由 supervisor 自启 + 守护；写 `deploy.sh` 时把 **前台进程** 作为入口，别自己 daemonize。

## 3. /shared：只读共享盘 —— 模型权重放这里
- **`/shared`** 挂的是平台的大共享盘，**只读**（你在容器里写不进去，sudo 也不行）。
  内容由老师/管理员通过平台界面上传管理。
- 典型内容：`/shared/weights`、`/shared/datasets` …
- **约定：模型权重、公共数据集等大文件放 `/shared` 里**，代码按路径读取（如 `$SHARED_DIR/weights/xxx`）。
  **不要**把权重塞进自己的 home、也不要每次重新下载 —— home 是给每个组的小盘，共享盘才是放权重的地方。
- 需要往共享盘写东西 → 走平台界面，别在容器里改。

## 4. 环境变量（注入给受管部署进程）
平台在部署时把下面这些注入到你进程的环境（同时也写进 `~/deploy/context.json`）。
**注意**：SSH 进来的裸 shell 通常 **看不到** 这些变量（它们只给 supervisor 拉起的部署进程）——
要手动取就读 `~/deploy/context.json`，或把需要的写进 `~/.profile`。

| 变量 | 含义 |
|---|---|
| `PORT` | 对外 HTTP 端口，固定 `8080` |
| `LOG_DIR` | 日志目录 `/home/cloud/logs` |
| `SHARED_DIR` | `/shared` |
| `PUBLIC_URL` / `PUBLIC_HOST` / `PUBLIC_PORT` | 你的公网地址 |
| `PUBLIC_SSH_PORT` | 你的 SSH 公网端口 |
| `GROUP_NAME` / `GROUP_TYPE` | 组名 / `cpu` 或 `gpu` |
| `GPU_IDS` / `GPU_COUNT` | 分到的 GPU 序号 / 数量 |
| `CPU_LIMIT` / `MEM_LIMIT` | 资源上限 |
| `PLATFORM_URL` | 平台地址 |
| `HOST_NAME` / `HOST_KERNEL` / `HOST_CPU_COUNT` / `HOST_MEM_MB` | 宿主机信息 |
| `GPU_MODELS` / `GPU_MEM_TOTAL_MB` | 宿主机 GPU 型号 / 显存 |
| `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DB` | MySQL（见 §6）|
| `REDIS_HOST` `REDIS_PORT` `REDIS_USER` `REDIS_PASSWORD` `REDIS_PREFIX` | Redis |
| `QDRANT_ENDPOINT` `QDRANT_GRPC` `QDRANT_API_KEY` `QDRANT_PREFIX` | Qdrant |
| `MINIO_ENDPOINT` `MINIO_ACCESS_KEY` `MINIO_SECRET` `MINIO_BUCKET` | MinIO 对象存储 |

> 数据库 / 存储的密钥是 **按“标签 = 组名”自动匹配注入** 的。若 `$MYSQL_USER`、`$MINIO_ACCESS_KEY`
> 是空的，说明管理员还没给这个组名开凭证 → 去平台「数据库 / MinIO」页申请（标签填组名），再重部一次。

## 5. 对象存储 MinIO：重要数据存进你的桶
- 端点：`$MINIO_ENDPOINT`（集群内 `http://minio.platform-infra.svc.cluster.local:9000`），**S3 兼容**。
- 用 `$MINIO_ACCESS_KEY` / `$MINIO_SECRET` 访问，你（至少）对自己的 `$MINIO_BUCKET` 有读写权限。
- **约定：需要长期保存 / 想跨 Pod 重建保留的重要数据（模型 checkpoint、训练产出、用户上传、
  导出件……）写进 MinIO 桶**，不要只留在容器本地。
- Python 例子：
  ```python
  import os
  from minio import Minio
  cli = Minio(os.environ["MINIO_ENDPOINT"].replace("http://", ""),
              access_key=os.environ["MINIO_ACCESS_KEY"],
              secret_key=os.environ["MINIO_SECRET"], secure=False)
  b = os.environ["MINIO_BUCKET"]
  if not cli.bucket_exists(b):
      cli.make_bucket(b)
  cli.fput_object(b, "ckpt/epoch10.pt", "/home/cloud/epoch10.pt")
  ```
- 装包（容器 **连不上公网 PyPI**，用镜像）：
  ```bash
  pip install --break-system-packages -i https://mirrors.aliyun.com/pypi/simple minio boto3
  ```

## 6. 数据库（MySQL / Redis / Qdrant / Postgres）
都是集群内共享实例，但每个组一套 **隔离** 凭证（MySQL/Postgres 独立库 + 账号；Redis 独立 ACL 用户 + 键前缀；
Qdrant 用集合名前缀约定）。凭证按组名注入到环境变量（§4）。
- **MySQL**：`$MYSQL_HOST:$MYSQL_PORT`，库 `$MYSQL_DB`，账号 `$MYSQL_USER` / `$MYSQL_PASSWORD`。
- **Postgres**：`postgres.platform-infra.svc.cluster.local:5432`，按组标签注入（库/角色/密码）。
- **Redis**：`$REDIS_HOST:$REDIS_PORT`，`$REDIS_USER` / `$REDIS_PASSWORD`，**键必须以 `$REDIS_PREFIX:` 开头**
  （ACL 只放行你的前缀，别的键会 `NOPERM`）。
- **Qdrant**：`$QDRANT_ENDPOINT`（REST）/ `$QDRANT_GRPC`（gRPC），API key `$QDRANT_API_KEY`，
  **集合名以 `$QDRANT_PREFIX` 开头**（这是约定，务必遵守，别建无前缀的集合）。
- 不要跨组访问别人的库，也不要用 root 凭证。

## 7. GPU（仅 GPU 组）
- 可见 GPU 由 `NVIDIA_VISIBLE_DEVICES` / `$GPU_IDS` 决定；进程内再用 `CUDA_VISIBLE_DEVICES` 收敛到你要用的卡。
- `CUDA_HOME=/usr/local/cuda`（只读挂载了宿主机 toolkit，`nvcc` 和头文件可用，JIT 编译 kernel 没问题）。
- MPS 已开启：`/tmp/nvidia-mps`、`/var/log/nvidia-mps` 与宿主机共享（多进程共享 GPU）。显存紧张时请礼貌让出。

## 8. 负载感知：读 /shared/pressure/pressure.json
宿主机整体压力（CPU / GPU / 显存 / 内存 / 带宽）每 ~2s 刷新一次到 **`/shared/pressure/pressure.json`**（只读）。

```json
{"cpu":0.4,"gpu":0.2,"gpu_mem":0.3,"mem":0.5,"bw":0.1,
 "bw_rx_bps":0,"bw_tx_bps":0,
 "level":{"cpu":"low","gpu":"low","mem":"medium","bw":"low"},
 "ts":1699999999.0}
```

- 各指标是 0~1 的利用率；`level` 是 `low` / `medium` / `high`。
- **约定**：启动重活（大批训练 / 推理 / 下载 / 大规模 IO）前先看一眼；任一 `level == "high"` 就 **降级或退避**
  （减小并发 / 分片、拉长间隔、让出 GPU），等它回落再继续。别在别人满载时硬刚。

## 9. 其它约定与坑
- 受管部署用 **supervisor** 拉起：入口写成前台进程，日志写到 `$LOG_DIR` / `~/deploy/<name>/logs/`。
- `pip` 要加 `--break-system-packages`；公网 PyPI 不通，用 `-i https://mirrors.aliyun.com/pypi/simple`。
- 别依赖容器本地文件做持久化（见 §2）；要紧的东西进 `/home/cloud` 或 MinIO（§5）。
- 不要把密钥写进代码 / 提交进 git；它们在环境变量里（§4）。
- 需要新的对外端口 / 更大配额 / 往共享盘写 → 找管理员，别改集群 manifest。

---
_本文件由 YatTerra 平台生成并 **只读挂载**（`/etc/yatterra/README.md`）。请勿修改 —— 改了也会在下次挂载时还原；
最新规范以平台为准。_
'''


def _kubectl(*args, **kw):
    return subprocess.run(["kubectl", "-n", NS] + list(args), **kw)


def apply_configmap():
    """Create/update the read-only guide ConfigMap in the group namespace.

    Imperative `create --dry-run=client | apply` avoids hand-escaping the whole
    document into YAML. Idempotent. Raises on failure (callers decide whether a
    failure should abort a deploy).
    """
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, GUIDE_KEY)
        with open(p, "w") as f:
            f.write(GUIDE)
        gen = _kubectl("create", "configmap", CONFIGMAP,
                       f"--from-file={GUIDE_KEY}={p}",
                       "--dry-run=client", "-o", "yaml",
                       capture_output=True, text=True, timeout=30)
    if gen.returncode != 0:
        raise RuntimeError(f"生成 ConfigMap 失败: {gen.stderr.strip()}")
    app = _kubectl("apply", "-f", "-",
                   input=gen.stdout, capture_output=True, text=True, timeout=30)
    if app.returncode != 0:
        raise RuntimeError(f"应用 ConfigMap 失败: {app.stderr.strip()}")
    audit.record("pod_guide_configmap", detail=f"{NS}/{CONFIGMAP}", module="pod_guide")
    return app.stdout


if __name__ == "__main__":
    print(apply_configmap())
