#!/usr/bin/env bash
#
# 一键把前端切换到 nginx 托管（3000 端口），幂等，可重复执行。
#
#   scripts/install-web.sh                 # 装/更新 nginx 站点 + 构建 + 发布
#   SKIP_BUILD=1 scripts/install-web.sh    # 复用现有 dist/
#   WEB_ROOT=/srv/robot-editor scripts/install-web.sh
#
# 做的事：
#   1. 停掉 Node 版前端（robot-editor），让出 3000；
#   2. nginx 未安装则 apt 安装；
#   3. 安装站点配置到 sites-available/enabled，移除默认站点；
#   4. 构建 dist 并发布到 /var/www/robot-editor；
#   5. nginx -t 校验后 reload。
#
# 需要 root：脚本会自行调用 sudo（只需输入一次密码）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WEB_ROOT=${WEB_ROOT:-/var/www/robot-editor}
cd "$ROOT"

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

echo "[1/5] 停止 Node 版前端（旧 robot-web / robot-editor 用户单元）并让出 3000…"
systemctl --user disable --now robot-web >/dev/null 2>&1 || true
systemctl --user disable --now robot-editor >/dev/null 2>&1 || true

echo "[2/5] 检查 nginx…"
if command -v nginx >/dev/null 2>&1; then
    echo "      nginx 已安装：$(nginx -v 2>&1)"
else
    echo "      未安装，执行 apt 安装…"
    $SUDO apt update
    $SUDO apt install -y nginx
fi

echo "[3/5] 安装站点配置…"
$SUDO install -m 644 packaging/nginx-robot-editor.conf /etc/nginx/sites-available/robot-editor.conf
$SUDO ln -sf /etc/nginx/sites-available/robot-editor.conf /etc/nginx/sites-enabled/robot-editor.conf
# 默认站点监听 80，与本项目无关，去掉以免混淆（不存在则忽略）
$SUDO rm -f /etc/nginx/sites-enabled/default

echo "[4/5] 构建并发布前端到 $WEB_ROOT…"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
    node node_modules/vite/bin/vite.js build
fi
[ -f dist/index.html ] || { echo "dist/index.html 不存在（构建失败？）" >&2; exit 1; }
$SUDO mkdir -p "$WEB_ROOT"
$SUDO rsync -a --delete --chown=www-data:www-data "$ROOT/dist/" "$WEB_ROOT/"

echo "[5/5] 校验并启动 nginx…"
$SUDO nginx -t
$SUDO systemctl enable nginx
$SUDO systemctl restart nginx

sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true)
if [ "$code" = "200" ]; then
    echo
    echo "完成：http://<本机IP>:3000（HTTP $code）"
    curl -sI --max-time 5 http://127.0.0.1:3000/ | grep -iE '^(HTTP|Cross-Origin|Content-Type)' || true
    echo
    echo "日常发布：scripts/deploy-web.sh"
    echo "查看状态：systemctl status nginx"
else
    echo
    echo "启动后探测 3000 返回 HTTP ${code:-000}，请检查：sudo nginx -t / sudo journalctl -u nginx -n 30" >&2
    exit 1
fi
