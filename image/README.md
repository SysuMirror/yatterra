# image/ — 组容器镜像

构建组容器用的 Ubuntu 24.04 镜像（`docker.io/sse/cloud-ubuntu:24.04`）。

## 文件

| 文件 | 说明 |
|---|---|
| `build.sh` | **实际使用的构建脚本**：debootstrap 出 rootfs → 配置 → `docker import` → 导入 k3s containerd |
| `Dockerfile.cpu` | 早期 Dockerfile 版本（CPU 基础镜像） |
| `Dockerfile.gpu` | 早期 Dockerfile 版本（CUDA 12.4 runtime 基础） |
| `entrypoint.sh` | 容器入口：设置密码、起 sshd |

## 镜像内容

- 基础：Ubuntu 24.04（GPU 版为 `nvidia/cuda:12.4.0-runtime-ubuntu24.04`）
- 用户：`cloud`（uid 1000），**NOPASSWD sudo**
- 软件：openssh-server、build-essential、python3/pip/venv、nodejs/npm、git、curl、wget、vim、tmux、htop、tini、iproute2
- sshd：允许密码登录、允许 TCP 转发 / X11 转发，禁止 root 登录
- 入口：`tini -- entrypoint.sh`，按 `CLOUD_PASSWORD` 环境变量设置 `cloud` 密码后前台跑 sshd

## 构建入口

**`build.sh` 是实际使用的构建脚本**（debootstrap → docker import → k3s ctr import）。
`Dockerfile.cpu` / `Dockerfile.gpu` 是等价的 Dockerfile 写法，保留作参考，
两者都已对齐到 `cloud` 用户 / uid 1000（与 `siteconf.CLOUD_UID` 默认值一致）。

> 注意：Pod manifest 里的 `command:` 会覆盖镜像的 `ENTRYPOINT`，实际生效的初始化
> 脚本是 `web/groups.py` 的 `INIT_SCRIPT`（由 `deployment_yaml()` 生成）。
> 改容器启动行为要改那里，不是 `image/entrypoint.sh`。

细节见 [SKILL.md](SKILL.md)。
