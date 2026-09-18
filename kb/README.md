# kb/ — RAG 知识库源文件

喂给平台 AI 助手的知识库。放入 `.md` 文件后重建索引，助手就能检索到。

## 结构

```
kb/
├── README.md              # 本文件（也会被当作 kb_ops 知识入库）
├── SKILL.md               # 操作指南（同样会被入库）
├── uploads/               # → kb_ops 集合（需 infra.* / ops.* 权限才能检索）
└── uploads-public/        # → kb_public 集合（全员可见）
```

> ⚠️ `kb/` 根目录下**所有** `.md`（含本 README 和 SKILL.md）都会进 `kb_ops`。
> 不想被检索的内容别放这里。

## 两个集合

| 集合 | 来源 | 可见性 |
|---|---|---|
| `<prefix>kb_public` | `docs.tsx` 解析出的平台文档 + `uploads-public/` | 所有登录用户 |
| `<prefix>kb_ops` | `kb/` 根目录 + `uploads/` 下的排障手册/SOP | 需 `infra.*` / `ops.*` 权限；**游客角色被显式排除** |

`docs.tsx` 里标了 `staffOnly` 的章节会被路由到 `kb_ops`。

## 格式约定

- 标准 Markdown，用 `#`/`##`/`###` 分节 —— 标题层级会作为检索上下文前缀。
- 每段 300–800 字（`CHUNK_MIN`/`CHUNK_MAX`），过长自动切块。
- 适合放：排障手册、连接方式、常见故障、部署运维 SOP、端口/凭证说明。

## 生效

```bash
# 平台 API（需管理员）
curl -X POST http://127.0.0.1:8090/api/ai/kb/ingest -H "Authorization: Bearer <token>"
# 或直接跑（手动跑必须加载 .env，否则读到占位域名/路径）
cd /srv/yatterra/web && set -a && . env.sh && set +a && python3 -c "import kb_service; print(kb_service.ingest_all())"
```

状态：`GET /api/ai/kb/status`

实现见 `web/kb_service.py`。细节见 [SKILL.md](SKILL.md)。
