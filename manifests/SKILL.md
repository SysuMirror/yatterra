---
name: yatterra-manifests
description: 排查或修改组 K8s 清单（Deployment/Service、端口、挂载）时使用。
---

# manifests/ — 清单操作指南

## 铁律

**不要手改这里的 YAML。** 它是 `web/groups.py` 的生成产物，权威状态在
`/opt/yatterra/groups.json`。手改会在下次 `apply_group()` 时被覆盖，
且造成「文件与集群不一致」的假象。

要改清单内容 → 改 `web/groups.py` 里生成 YAML 的模板 → 触发重建：

```python
import groups
g = groups.load_state()["groups"]["<name>"]
groups.apply_group(g)          # 重新生成 + kubectl apply
```

## 排查

```bash
# 集群实际状态（权威）
kubectl -n students get deploy,svc,pod -l app=group-<name>
kubectl -n students describe deploy group-<name>
kubectl -n students logs deploy/group-<name> --tail=50

# 生成的文件
cat /opt/yatterra/manifests/group-<name>.yaml

# 权威状态
sudo python3 -c "import json;print(json.load(open('/opt/yatterra/groups.json'))['groups']['<name>'])"
```

## 常见问题

| 现象 | 原因 |
|---|---|
| Pod `ImagePullBackOff` | 镜像没 `k3s ctr images import`（见 `image/SKILL.md`） |
| Pod `Pending` | 资源不足（CPU requests 被占满）→ 看 `yatterra-req-estimator` 的 EWMA 是否跑偏 |
| 端口不通 | NodePort 与 `groups.json` 的 `index` 不匹配；或 frpc 隧道没 reload |
| 文件存在但集群没有 | 上次 `kubectl apply` 失败，留下了孤儿 YAML |
| 组名被拒 | 组名必须小写 RFC1123（大写自动转小写、下划线转连字符） |

## 删除组

```python
import groups; groups.remove_group("<name>")
```

会同时删 K8s 资源、manifest 文件、hostPath 数据目录，并清理
`deploys.json` / DB / MinIO 里该组的凭证。**不可逆**。

## 坑

- `groups.json` 是 root 600，以 `sse` 读会 `PermissionError`；用 `sudo` 或走 API。
- 改端口基址常量（`SSH_PUBLIC_BASE` 等）会影响**所有**组，且要同步改公网 nginx
  和 frpc —— 别轻易动。
- `MAX_GROUPS = 50` 限制公网端口范围 22001–22050 / 23001–23050。
