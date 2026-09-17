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
- 用户：`cloud`（uid 1001），**NOPASSWD sudo**
- 软件：openssh-server、build-essential、python3/pip/venv、nodejs/npm、git、curl、wget、vim、tmux、htop、tini、iproute2
- sshd：允许密码登录、允许 TCP 转发 / X11 转发，禁止 root 登录
- 入口：`tini -- entrypoint.sh`，按 `STUDENT_PASSWORD` 环境变量设置 `cloud` 密码后前台跑 sshd

## ⚠️ 两份来源不一致

`build.sh` 创建的用户是 **`cloud`**（与 `web/groups.py`、平台全部代码一致），
而 `Dockerfile.cpu` / `Dockerfile.gpu` 里写的是 **`student`**。

**以 `build.sh` 为准** —— 镜像里实际存在的是 `cloud`。改镜像请改 `build.sh`，
或先把 Dockerfile 对齐。

细节见 [SKILL.md](SKILL.md)。
