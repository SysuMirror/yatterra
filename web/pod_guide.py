#!/usr/bin/env python3
"""In-pod programming guide — single source of truth.

The canonical text lives in ``GUIDE`` below and is published to the read-only
shared disk as ``/shared/README.md`` (host path ``siteconf.SHARED_ROOT``). Every
group Pod mounts that disk read-only at ``/shared``, and the container init
script additionally symlinks it into the pod home (``~/README.md`` /
``~/AGENTS.md`` / ``~/CLAUDE.md``) so that both humans and AI coding agents that
scan the working directory pick it up automatically.

To update the conventions: edit ``GUIDE`` and call ``publish()`` (the shared
root is root-owned, so this runs as root), then redeploy the affected groups
(``groups.apply_group``) so fresh pods relink against the new copy.
"""
import os

import audit

import siteconf

GUIDE_REL = "README.md"
GUIDE_PATH = os.path.join(siteconf.SHARED_ROOT, GUIDE_REL)


GUIDE = '''# YatTerra 容器（Pod）内编程规范

> 你正运行在一台 **YatTerra 组容器** 里。本文件是 **只读** 的（平台放在只读共享盘
> `/shared/README.md`），你的主目录里有软链（`~/README.md`、`~/AGENTS.md`、`~/CLAUDE.md`）
> 指向它。动手写代码前请先读一遍 —— 尤其是 **§2 持久化、§3 /shared、§5 MinIO**。

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
{"schema":3,
 "cpu":0.4,"gpu":0.2,"gpu_mem":0.3,"gpu_max":0.99,
 "gpu_cards":[{"index":0,"util":0.99,"mem":0.95,"temp":51,"power":229.4}],
 "gpu_temp_max":51,"mem":0.5,"swap":0.01,
 "psi":{"cpu":0.0,"mem":0.0,"io":0.0},
 "disk":{"/":0.63,"/mnt/sdb":0.41},
 "bw":0.1,"bw_rx_bps":0,"bw_tx_bps":0,
 "host_cores":64,"host_mem_gib":251.7,
 "stats":{"cpu":{"now":0.4,"avg":0.34,"peak":0.71,"n":15},
          "gpu_max":{"now":0.99,"avg":0.88,"peak":1.0,"n":15}, "...":{}},
 "level":{"cpu":"low","gpu":"high","gpu_mem":"med","gpu_temp":"low",
          "mem":"med","swap":"low","psi":"low","disk":"low","bw":"low"},
 "level_raw":{"cpu":"low","gpu":"med","mem":"med","bw":"low"},
 "tenants":{"n":41,"top":0.44,"shares":{"cpu":[0.44,0.12],"mem":[0.31]}},
 "ts":1699999999.0}
```

- 各指标是 0~1 的利用率；`level` 取值 `low` / `med` / `high`（**注意是 `med` 不是 `medium`**）。
- `gpu` / `gpu_mem` 是 **所有卡的均值**；单卡打满会被均值稀释。判断“有没有人在抢卡”用
  **`gpu_max`**（最忙那张卡的利用率）或 `gpu_cards`（逐卡 `util`/`mem`/`temp`/`power`）。
- **`level` 是 v3 的“稳定档”**：与 infra 驱逐层层同基准（GPU 看 `gpu_max` 逐卡最大，不是均值），
  且带滞回（热到阈值要持续几拍才升 high，回落要持续更久才降）。**自降级逻辑请读 `level`。**
- `level_raw` 是旧语义的**瞬时档**（GPU 用均值），保留给仪表盘/边沿检测；`stats.<指标>.avg/peak`
  是 ~30s 滑窗的均值与峰值。需要“抖动也立刻反应”时看 `level_raw` 或 `stats.*.peak`。
- `psi`（cpu/mem/io）是内核 PSI 的 `some avg10` 停顿占比（0~1），比单纯利用率更能反映
  “卡不卡”；`swap` 是交换分区占用比；`disk` 是各挂载点使用比。
- `level` 自 v3 起**有意重定义**（GPU 基准由均值改为逐卡最大，并加滞回），旧语义见 `level_raw`；
  其余字段只**追加**，不删改已有键。`level.gpu_mem` 用近 OOM 阈值（0.97/0.90）——共置 GPU 的常驻
  显存基线（~0.94）会读成 `med`，只有真·显存耗尽才 `high`；`level.gpu_temp` 用摄氏度阈值。
- 文件里 `ts` 是采样时刻；读到的内容超过 ~30 秒没刷新说明信号中断，按“压力未知”处理（保守起见当作 high）。

**算你自己占了多少**（`tenants` 是匿名分布，不含名字；你自己的份额本地自算）：
```python
import json, os
p = json.load(open("/shared/pressure/pressure.json"))
# 读自己的 cgroup(cgroup v2;容器内即本 Pod 的 slice)
cpu_usec = int(next(l.split()[1] for l in open("/sys/fs/cgroup/cpu.stat") if l.startswith("usage_usec")))
mem_b    = int(open("/sys/fs/cgroup/memory.current").read())
# 瞬时占比: 内存 = 自己/整机; CPU 用两次采样的 usage_usec 差分除以墙钟时间再除以 host_cores
mem_share = mem_b / (p["host_mem_gib"] * 1024**3)
```
`tenants.shares.cpu/mem` 是**降序**的匿名份额列表（最多 10 条），`tenants.top` 是最大单组 CPU 份额；
据此可判断“压力是不是别人造成的 / 集中度多高”（GPU 压力看 `gpu_cards`/`gpu_max`，本身已逐卡给出）。

### 8.1 Agent 降级手册（写给容器里的 AI agent / 长驻服务）

你的进程不是这台机器上唯一的租户。**把 pressure.json 当作环境信号，主动让路**，
而不是等平台 `priority_kill` 把你停掉（被驱逐 = 无警告丢进度）。

轮询建议：长驻服务每 10~30 秒读一次；交互式 agent 在**启动重活之前**读一次。

| 信号 | 动作 |
| --- | --- |
| 任一 `level == "high"`（或 `stats.<指标>.peak` 已达 high，或 `psi` 任一 > 0.2，或 `swap` > 0.5） | **立即降载**：并发减半、batch 拆小、限流请求；GPU 活暂停或让出 |
| `level == "med"` 持续 | **延后非紧急活动**：批量下载、索引重建、大文件拷贝、定时全量任务 → 排队等 low |
| `psi.cpu` 或 `psi.io` 高但利用率不高 | 你在和别人抢 CPU/IO 时间片：拉长轮询间隔、降低线程数 |
| `gpu_cards` 里你占的卡 `mem` > 0.9（或 `level.gpu_mem == "high"`） | 你快把这张卡挤爆了：减小模型 batch / KV cache，或换空闲卡（看 `util` 低的） |
| 全部 `low` 且 `psi` ≈ 0 | 放心跑；把之前排队延后的任务补上 |

具体手段（按优先级）：
1. **调并发**：worker 数 / 线程池 / `max_concurrent_requests` 这类旋钮做成可运行时改的（env 或配置文件），别写死。
2. **异步延后**：非关键任务（日志压缩、缓存预热、统计汇总、向 MinIO 归档）丢进队列，压力高时暂停消费。
3. **降质量**：推理换小 batch / 截断上下文；下载限速；视频/图片处理降分辨率。
4. **让出资源**：GPU 任务存 checkpoint 后主动退出，等 low 再由 supervisor 拉起续跑。

你的 `$PRIORITY`（`low` / `normal` / `high`）决定压力高时平台先驱逐谁：**low 优先级的进程必须实现降级逻辑**，
否则第一个被停的就是你；high 优先级也别无顾忌 —— 机器卡了对谁都没好处。

## 9. 其它约定与坑
- 受管部署用 **supervisor** 拉起：入口写成前台进程，日志写到 `$LOG_DIR` / `~/deploy/<name>/logs/`。
- `pip` 要加 `--break-system-packages`；公网 PyPI 不通，用 `-i https://mirrors.aliyun.com/pypi/simple`。
- 别依赖容器本地文件做持久化（见 §2）；要紧的东西进 `/home/cloud` 或 MinIO（§5）。
- 不要把密钥写进代码 / 提交进 git；它们在环境变量里（§4）。
- 需要新的对外端口 / 更大配额 / 往共享盘写 → 找管理员，别改集群 manifest。

---
_本文件由 YatTerra 平台维护，位于 **只读共享盘**（`/shared/README.md`，宿主机 `SHARED_ROOT`）。共享盘在容器里只读，
改了也不会生效；最新规范以平台为准。_
'''


def publish():
    """(Re)write the guide to ``<shared_root>/README.md`` (world-readable).

    The shared root is root-owned, so this must run as root — the platform's
    root systemd helpers, or an interactive admin via ``sudo``. Idempotent.
    Raises on failure (callers decide whether it should abort a deploy).
    """
    os.makedirs(siteconf.SHARED_ROOT, exist_ok=True)
    tmp = GUIDE_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(GUIDE)
    os.chmod(tmp, 0o644)
    os.replace(tmp, GUIDE_PATH)
    audit.record("pod_guide_publish", detail=GUIDE_PATH, module="pod_guide")
    return GUIDE_PATH


if __name__ == "__main__":
    print(publish())
