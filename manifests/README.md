# manifests/ — 组 K8s 清单（生成产物）

每个组一个 `group-<name>.yaml`，包含该组的 **Deployment + Service**。

## ⚠️ 这是生成产物

由 `web/groups.py` 的 `write_manifest(g)` 写出，在 `apply_group()` 里被
`kubectl apply`。**权威状态是 `/srv/yatterra/groups.json`**，不是这里的 YAML。

手改 YAML 会在下次 `create_group` / `resize` / 任何触发 `apply_group` 的操作时被覆盖。

## 每个文件包含

| 资源 | 内容 |
|---|---|
| `Deployment` | 1 副本，`app=group-<name>`，`runtimeClassName: nvidia`（GPU 组），容器 `ubuntu` 跑 `cloud-ubuntu:24.04` |
| `Service` | `NodePort`，`ssh` 22→`31000+idx`，`web` 8080→`32000+idx` |

容器内挂载：持久化 `/home/cloud`（hostPath）、共享目录、GPU 相关（`/dev/nvidia*`、
`/usr/local/cuda`、MPS 日志）。

## 端口分配（由 `groups.py` 常量决定）

| | NodePort（集群内） | 公网（经 frp） |
|---|---|---|
| SSH | `31000 + idx` | `22000 + idx` |
| Web | `32000 + idx` | `23000 + idx` |
| 平台 GUI | — | `24000` |

`idx` 来自 `groups.json` 里组的 `index` 字段。

## 常用

```bash
ls /srv/yatterra/manifests/
kubectl -n clouds get deploy,svc
kubectl -n clouds get deploy group-embedding -o yaml   # 看集群里的实际状态
```

细节见 [SKILL.md](SKILL.md)。
