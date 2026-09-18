---
name: yatterra-kb
description: 往 YatTerra RAG 知识库加/改知识，或排查助手检索不到内容时使用。
---

# kb/ — 知识库操作指南

## 加知识

1. 写 `.md`，放对目录：
   - `kb/uploads/` → `kb_ops`（仅管理员可检索）
   - `kb/uploads-public/` → `kb_public`（全员）
   - `kb/` **根目录** → `kb_ops`（本 README/SKILL 也在此列，会被一起入库）
2. 重建索引：

```bash
cd /srv/yatterra/web
set -a; . env.sh; set +a          # 手动跑必须加载 .env，否则读到占位域名/路径
python3 -c "import kb_service; print(kb_service.ingest_all())"
```

3. 验证：

```bash
curl --noproxy '*' -s http://127.0.0.1:8090/api/ai/kb/status -H "Authorization: Bearer <token>"
```

## 排查「助手检索不到」

| 检查 | 命令/位置 |
|---|---|
| 文件在不在对的目录 | `ls /srv/yatterra/kb/uploads*` |
| 索引重建过没 | `kb_state.json` 的 mtime；`GET /api/ai/kb/status` 的 last_ingest |
| 权限对不对 | `kb_ops` 只有 `infra.*`/`ops.*` 用户能检索（`kb_service.retrieve` 里判断） |
| 相似度阈值 | `DEFAULT_THRESHOLD = 0.35`，太低会召回噪声，太高召不回 |
| 嵌入服务通不通 | `llm.conf` 的 `embedding_base_url` / `embedding_model`（bge-m3, 1024 维） |

## 坑

- **嵌入网关拒绝单元素 `input` 列表** —— `kb_service` 每次请求都垫一条 dummy 文本再取
  `data[0]`。改嵌入调用时别把这个补丁删了。
- 集合名带前缀 `yatterra_`（`COLL_PREFIX`），直接查 Qdrant 时别漏。
- `docs.tsx` 是**只读解析**的来源：改平台文档要改 `web/frontend/src/routes/docs.tsx`，
  然后重建索引，不要在 `kb/` 里复制一份。
- 上传目录里的文件名带短 hash 后缀（如 `Nginx-502-排障-9987b1.md`），重命名会导致
  重新入库产生重复条目；要改内容就改文件内容，别改文件名。
- 段落 <300 字或 >800 字会被切块/合并，检索质量下降。按 300–800 字一段写。
