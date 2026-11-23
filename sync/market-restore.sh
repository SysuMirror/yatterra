#!/bin/sh
# SSEMarket 测试库恢复端（WZ8）：stdin 收 gzip 的 mysqldump，恢复进 db_5ce46d43。
# 由 A 机 /opt/ssemarket-db-sync/sync-market-db.sh 通过 ssh 调用。
# 只写测试库 db_5ce46d43（market-test 组），不碰任何正式库。
# 大导入不走 kubectl exec 交互流（websocket 会超时）：
#   先把 dump 推进 pod，再在 pod 内 nohup 后台导入，轮询完成标记。
# 日志: /opt/yatterra/sync/logs/market-db-restore.log
set -eu
LOGDIR=/opt/yatterra/sync/logs
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/market-db-restore.log" 2>&1
NS=platform-infra
POD=$(kubectl -n $NS get pod -l app=mysql -o jsonpath='{.items[0].metadata.name}')
echo "=== $(date '+%F %T') market-db-restore start (pod=$POD)"
TMP=$(mktemp /tmp/market-sync.XXXXXX.sql.gz)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP"
[ -s "$TMP" ] || { echo "EMPTY INPUT, abort"; exit 1; }
echo "gz bytes: $(wc -c < "$TMP")"

# 0. 备份测试库现有 refresh_tokens（测试端 publisher 轮换的 token 要跨同步存活）
# 备份失败重试 3 次；仍失败则整体中止，绝不裸删测试库
RTBAK=$(mktemp /tmp/market-sync-rt.XXXXXX.sql)
rtok=0
i=1
while [ $i -le 3 ]; do
  if kubectl -n $NS exec "$POD" -- sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --no-create-info --skip-add-drop-table db_5ce46d43 refresh_tokens 2>/dev/null' > "$RTBAK"; then rtok=1; break; fi
  echo "RTBAK dump attempt $i failed"; i=$((i+1)); sleep 5
done
[ "$rtok" = "1" ] || { echo "RTBAK dump failed x3, ABORT restore (test DB kept)"; exit 1; }

# 1. 推送导入脚本与 dump 到 pod（各重试 3 次）
PUSH() { # PUSH <local> <remote>
  i=1
  while [ $i -le 3 ]; do
    if kubectl -n $NS exec -i "$POD" -- sh -c "cat > $2" < "$1" 2>/dev/null; then return 0; fi
    echo "push $2 attempt $i failed"; i=$((i+1)); sleep 5
  done
  return 1
}
kubectl -n $NS exec "$POD" -- sh -c 'rm -f /tmp/market-sync.done /tmp/market-sync.err /tmp/market-sync.log /tmp/market-sync.sql.gz'
PUSH /opt/yatterra/sync/import-market-test.sh /tmp/import-market-test.sh || { echo "push import script failed"; exit 1; }
PUSH "$TMP" /tmp/market-sync.sql.gz || { echo "push dump failed"; exit 1; }
PODSZ=$(kubectl -n $NS exec "$POD" -- sh -c 'wc -c < /tmp/market-sync.sql.gz' 2>/dev/null || echo ?)
echo "pod copy bytes: $PODSZ"

# 2. pod 内后台导入（立即返回，不受长连接影响）
kubectl -n $NS exec "$POD" -- sh -c 'nohup sh /tmp/import-market-test.sh > /tmp/market-sync.log 2>&1 &'

# 3. 轮询完成标记（最长 10 分钟）
i=0
while [ $i -lt 120 ]; do
  if kubectl -n $NS exec "$POD" -- sh -c 'test -f /tmp/market-sync.done' 2>/dev/null; then
    break
  fi
  if kubectl -n $NS exec "$POD" -- sh -c 'test -f /tmp/market-sync.err' 2>/dev/null; then
    echo "import FAILED:"
    kubectl -n $NS exec "$POD" -- sh -c 'tail -5 /tmp/market-sync.log' 2>/dev/null || true
    exit 1
  fi
  i=$((i+1)); sleep 5
done
[ $i -lt 120 ] || { echo "import TIMEOUT (10min)"; exit 1; }
echo "import done"

# 4. 回灌测试端自持的 refresh token
if [ -s "$RTBAK" ] && grep -q '^INSERT' "$RTBAK"; then
  kubectl -n $NS exec -i "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" db_5ce46d43 2>/dev/null' < "$RTBAK" \
    && echo "refresh_tokens re-seeded"
fi
rm -f "$RTBAK"

# 5. 清理 pod 内临时文件并输出结果行
kubectl -n $NS exec "$POD" -- sh -c 'rm -f /tmp/market-sync.sql.gz /tmp/import-market-test.sh /tmp/market-sync.done /tmp/market-sync.err /tmp/market-sync.log'
TABLES=$(kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"db_5ce46d43\"" 2>/dev/null' || echo '?')
USERS=$(kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM db_5ce46d43.users" 2>/dev/null' || echo '?')
RT=$(kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM db_5ce46d43.refresh_tokens" 2>/dev/null' || echo '?')
echo "=== $(date '+%F %T') restore done: tables=$TABLES users=$USERS refresh_tokens=$RT"
