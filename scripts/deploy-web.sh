#!/usr/bin/env bash
#
# 构建前端并发布到 nginx 站点根目录，然后重载 nginx。
#
#   scripts/deploy-web.sh                      # 构建 + 发布 + reload
#   SKIP_BUILD=1 scripts/deploy-web.sh         # 只同步现有 dist/
#   WEB_ROOT=/srv/robot-editor scripts/deploy-web.sh
#
# 需要 sudo（写 /var/www 与 reload nginx）。前端统一使用 3000 端口，
# 对应配置见 packaging/nginx-robot-editor.conf。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WEB_ROOT=${WEB_ROOT:-/var/www/robot-editor}
cd "$ROOT"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "[web] 构建（dist/）…"
    node node_modules/vite/bin/vite.js build
fi

[ -f dist/index.html ] || { echo "[web] dist/index.html 不存在，请先构建" >&2; exit 1; }

echo "[web] 同步到 $WEB_ROOT（删除旧文件）…"
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete --chown=www-data:www-data "$ROOT/dist/" "$WEB_ROOT/"

echo "[web] 校验并重载 nginx…"
sudo nginx -t
sudo systemctl reload nginx

echo "[web] 已发布：http://<本机IP>:3000"
