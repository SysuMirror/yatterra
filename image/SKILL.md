---
name: yatterra-image
description: 改组容器镜像（加软件、改用户、改 sshd 配置）或重建镜像时使用。
---

# image/ — 镜像操作指南

## 重建镜像

```bash
cd /srv/yatterra/image && sudo bash build.sh
```

流程：debootstrap noble → 配 apt 源 → chroot 装包/建用户/配 sshd → 写 entrypoint
→ `docker import` → `docker save | k3s ctr images import`。

需要 root（debootstrap + docker + k3s ctr）。耗时较长（debootstrap 拉基础包）。

## 改镜像

**改 `build.sh`**（Dockerfile 只是等价参考写法，两边要对齐）。

- 加软件：在 `build.sh` 的 apt install 列表里加。
- 改用户/权限：`useradd -m -s /bin/bash -G sudo cloud` 那段。
- 改 sshd：`sed -i` 那几行。
- 改**容器启动行为**：改 `web/groups.py` 的 `INIT_SCRIPT`，**不是**这里的
  `entrypoint.sh` —— Pod manifest 的 `command:` 会覆盖镜像 ENTRYPOINT。

## 生效方式

镜像 tag 是 `sse/cloud-ubuntu:24.04`，Pod manifest 里 `imagePullPolicy: IfNotPresent`。

**重建镜像后已有 Pod 不会自动更新**，需要重建 Pod（删了重加，或 `kubectl rollout restart`）。
注意：`/home/cloud` 是 hostPath 持久化的，重建 Pod 不丢数据。

```bash
kubectl -n clouds rollout restart deploy/group-<name>
```

## 坑

- 用户必须是 **`cloud`**，uid 1001。平台代码（`groups.py` 的 hostPath chown、
  `agent.py` 的 `su -l cloud`、SSH 凭证）全都硬编码这个名字。名字/uid 可通过
  `YATTERRA_CLOUD_USER` / `YATTERRA_CLOUD_UID` 覆盖，但镜像里也得同步改。
- 密码环境变量是 **`CLOUD_PASSWORD`**（由 `groups.py` 注入，名可经 `YATTERRA_PASSWORD_ENV` 覆盖）。
- `entrypoint.sh` 里 `set -e` + 前台 `sshd -D`：sshd 挂了容器就退出，
  这正是 Pod 自愈依赖的信号。
- 镜像导入 k3s 用的是 `k3s ctr images import`（containerd），不是 docker daemon。
  只 `docker build` 不 import，Pod 会 ImagePullBackOff。
- GPU 版基础镜像不同（CUDA runtime），但 `build.sh` 只有一份 CPU 流程；
  要 GPU 基础镜像得自己改 `MIRROR`/基础 rootfs 那段。
