#!/bin/sh
# 正式→测试单向同步：unisso 库 -> db_2383f441（unisso-test 组的测试库）
# 只读正式库；只在测试库上 DROP/CREATE/导入。任何情况下不写正式库。
# 日志: /opt/yatterra/sync/logs/unisso-db-sync.log
set -eu
# .env 含带空格的值，不能整体 source；只取所需键（值不含空格）
MYSQL_ROOT_PASSWORD=$(grep -E '^MYSQL_ROOT_PASSWORD=' /opt/yatterra/.env | head -1 | cut -d= -f2-)
: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD missing}"
LOGDIR=/opt/yatterra/sync/logs
mkdir -p "$LOGDIR"
exec >>"$LOGDIR/unisso-db-sync.log" 2>&1
NS=platform-infra
POD=$(kubectl -n $NS get pod -l app=mysql -o jsonpath='{.items[0].metadata.name}')
echo "=== $(date '+%F %T') unisso-db-sync start (pod=$POD)"
TMP=$(mktemp /tmp/unisso-sync.XXXXXX.sql)
trap 'rm -f "$TMP"' EXIT
# 1. 只读导出正式库（先导后删，导出失败不动测试库）
kubectl -n $NS exec "$POD" -- sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --add-drop-table --no-create-db unisso' > "$TMP"
[ -s "$TMP" ] || { echo "EMPTY DUMP, abort"; exit 1; }
echo "dump bytes: $(wc -c < "$TMP")"
# 2. 重建测试库并导入
kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS db_2383f441; CREATE DATABASE db_2383f441 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"'
kubectl -n $NS exec -i "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" db_2383f441' < "$TMP"
# 3. 结果行
TABLES=$(kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='"'"'db_2383f441'"'"'"' 2>/dev/null || echo '?')
USERS=$(kubectl -n $NS exec "$POD" -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM db_2383f441.users"' 2>/dev/null || echo '?')
echo "=== $(date '+%F %T') done: tables=$TABLES users=$USERS"
