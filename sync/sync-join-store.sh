#!/bin/sh
# join 正式→测试单向同步：join-store.json 从 sdpy-join-p pod 拷到 sdpy-test-join-p pod。
# 正式端写入是 tmp+rename 原子写，可直接读；推送前在本机校验 JSON 合法性，
# 失败即中止（不把坏数据推进测试）。uploads/（简历等 PII）不同步。
# 日志: /opt/yatterra/sync/logs/join-store-sync.log
set -eu
LOGDIR=/opt/yatterra/sync/logs
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/join-store-sync.log" 2>&1
NS=clouds
SRC=$(kubectl -n $NS get pods --no-headers 2>/dev/null | awk '$1 ~ /^group-sdpy-join-p-[0-9a-f]/ && $3=="Running" {print $1; exit}')
DST=$(kubectl -n $NS get pods --no-headers 2>/dev/null | awk '$1 ~ /^group-sdpy-test-join-p-[0-9a-f]/ && $3=="Running" {print $1; exit}')
[ -n "$SRC" ] || { echo "join prod pod not found"; exit 1; }
[ -n "$DST" ] || { echo "join test pod not found"; exit 1; }
echo "=== $(date '+%F %T') join-store-sync start ($SRC -> $DST)"

TMP=$(mktemp /tmp/join-store.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT
kubectl -n $NS exec "$SRC" -- cat /home/cloud/data/join-store.json > "$TMP"
[ -s "$TMP" ] || { echo "EMPTY store from prod, abort"; exit 1; }
# JSON 合法性校验（三次重试，避开恰好撞上正式端写盘瞬间）
ok=0
for i in 1 2 3; do
  if python3 -c "import json,sys; json.load(open('$TMP'))" 2>/dev/null; then ok=1; break; fi
  sleep 2
  kubectl -n $NS exec "$SRC" -- cat /home/cloud/data/join-store.json > "$TMP"
done
[ "$ok" = "1" ] || { echo "prod store JSON invalid after 3 reads, abort"; exit 1; }
echo "store bytes: $(wc -c < "$TMP")"
kubectl -n $NS exec -i "$DST" -- sh -c 'cat > /home/cloud/data/.join-store.json.sync && mv /home/cloud/data/.join-store.json.sync /home/cloud/data/join-store.json && chown cloud:cloud /home/cloud/data/join-store.json' < "$TMP"
# app 把 store 缓存在内存，重启才能加载同步后的数据（测试 pod 内只有 deploy-* 程序）
kubectl -n $NS exec "$DST" -- su -l cloud -c '
for c in ~/deploy/programs/*.conf; do
  p=$(basename "$c" .conf)
  ~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf restart "$p" >/dev/null 2>&1 || true
  echo "restarted $p"
done'
echo "=== $(date '+%F %T') join-store-sync done"
