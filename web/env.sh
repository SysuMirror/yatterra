#!/bin/sh
# 手动跑平台模块时加载部署配置。
#
# 源码里的默认值是通用占位符（example.com / /srv/yatterra），真实值只在
# systemd 的 EnvironmentFile（<平台根目录>/.env）里。systemd 拉起的服务自动
# 读得到；手动 `python3 -c "import xxx"` 读不到，会拿到占位符 —— 用这个脚本。
#
#   set -a; . web/env.sh; set +a
#   python3 -c "import kb_service; print(kb_service.ingest_all())"
#
# 路径按实际部署改（或设 YATTERRA_ENV_FILE 覆盖）。
ENV_FILE="${YATTERRA_ENV_FILE:-/srv/yatterra/.env}"
if [ -f "$ENV_FILE" ]; then
    . "$ENV_FILE"
else
    echo "env.sh: $ENV_FILE 不存在，将使用源码里的占位默认值" >&2
fi
