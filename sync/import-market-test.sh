#!/bin/sh
# mysql pod 内部执行：从 /tmp/market-sync.sql.gz 导入测试库 db_5ce46d43
# 成功 touch /tmp/market-sync.done，失败 touch /tmp/market-sync.err
set -u
M() { mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$@" 2>/dev/null; }
rm -f /tmp/market-sync.done /tmp/market-sync.err
M -e "DROP DATABASE IF EXISTS db_5ce46d43; CREATE DATABASE db_5ce46d43 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci" || { touch /tmp/market-sync.err; exit 1; }
gunzip -c /tmp/market-sync.sql.gz | mysql -uroot -p"$MYSQL_ROOT_PASSWORD" db_5ce46d43 || { touch /tmp/market-sync.err; exit 1; }
M -e 'CREATE TABLE IF NOT EXISTS db_5ce46d43.refresh_tokens (id int NOT NULL AUTO_INCREMENT, user_id int NOT NULL, token varchar(255) NOT NULL UNIQUE, expires_at datetime NOT NULL, is_used tinyint(1) NOT NULL DEFAULT 0, created_at datetime NOT NULL, successor_token varchar(255) NULL, used_at datetime NULL, PRIMARY KEY (id), KEY idx_refresh_tokens_user_id (user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
touch /tmp/market-sync.done
