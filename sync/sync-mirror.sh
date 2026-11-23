#!/bin/sh
# mirror 正式→测试单向同步：SQLite 库从 mirror 组 pod 拷到 mirror-dev 组 pod。
# 正式库: group-mirror pod /home/cloud/deploy/programs/mirror-unisso-20260908/mirror.db
# 测试库: group-mirror-dev pod /home/cloud/mirror/mirror.db（develop 分支 python server.py 的库）
# 用 python sqlite3 backup API 取一致性快照，不碰正式库写路径。
# 日志: /opt/yatterra/sync/logs/mirror-db-sync.log
set -eu
LOGDIR=/opt/yatterra/sync/logs
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/mirror-db-sync.log" 2>&1
NS=clouds
SRC=$(kubectl -n $NS get pods --no-headers 2>/dev/null | awk '$1 ~ /^group-mirror-[0-9a-f]/ && $3=="Running" {print $1; exit}')
DST=$(kubectl -n $NS get pods --no-headers 2>/dev/null | awk '$1 ~ /^group-mirror-dev-[0-9a-f]/ && $3=="Running" {print $1; exit}')
[ -n "$SRC" ] || { echo "mirror prod pod not found"; exit 1; }
[ -n "$DST" ] || { echo "mirror-dev pod not found"; exit 1; }
echo "=== $(date '+%F %T') mirror-db-sync start ($SRC -> $DST)"

SRCDIR=/home/cloud/deploy/programs/mirror-unisso-20260908
DSTDIR=/home/cloud/mirror
for db in mirror.db mirror_notes.db mirror_stats.db; do
  # 正式侧一致性快照（库不存在则跳过）
  if ! kubectl -n $NS exec "$SRC" -- sh -c "test -f $SRCDIR/$db" 2>/dev/null; then
    echo "skip $db (not in prod)"; continue
  fi
  kubectl -n $NS exec "$SRC" -- python3 -c "
import sqlite3
src = sqlite3.connect('$SRCDIR/$db')
dst = sqlite3.connect('/tmp/sync-$db')
src.backup(dst)
dst.close(); src.close()
print('snapshotted $db')
" 2>/dev/null
  SNAPSZ=$(kubectl -n $NS exec "$SRC" -- sh -c "wc -c < /tmp/sync-$db")
  echo "$db snapshot bytes: $SNAPSZ"
  kubectl -n $NS exec "$SRC" -- sh -c "cat /tmp/sync-$db" | kubectl -n $NS exec -i "$DST" -- sh -c "cat > $DSTDIR/.$db.sync && mv $DSTDIR/.$db.sync $DSTDIR/$db && chown cloud:cloud $DSTDIR/$db 2>/dev/null || true"
  kubectl -n $NS exec "$SRC" -- rm -f "/tmp/sync-$db"
  echo "$db synced"
done
echo "=== $(date '+%F %T') mirror-db-sync done"
