#!/usr/bin/env bash
#
# 构建自包含安装包：robot-editor_<version>_<arch>.deb → Release/
#
#   scripts/build-deb.sh                    # 默认：桥接 + nginx 站点 + 完整前端产物
#   WITH_DIST=0 scripts/build-deb.sh        # 只放站点配置（开发用，产物另行发布）
#   VERSION=1.6.0 scripts/build-deb.sh      # 指定版本号
#   ROBOT_USER=nvidia scripts/build-deb.sh  # 指定桥接服务运行用户
#
# 安装（nginx / python3 / python3-websockets 由 apt 自动装好）：
#   sudo apt install ./Release/robot-editor_<version>_<arch>.deb
#
# 安装位置：
#   /opt/robot-editor                             桥接代码
#   /etc/robot-editor/bridge.conf                 桥接配置（conffile）
#   /usr/bin/robot-editor                         start/stop/status/logs/config/check
#   /usr/lib/systemd/system/robot-editor.service  systemd 单元
#   /etc/nginx/sites-available/robot-editor.conf  nginx 站点（conffile）
#   /var/www/robot-editor                         前端产物（含模型）
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${VERSION:-$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")}
ARCH=${ARCH:-$(dpkg --print-architecture)}
RUN_USER=${ROBOT_USER:-$(id -un)}
WITH_DIST=${WITH_DIST:-1}
OUT_DIR="$ROOT/Release"
PKG="robot-editor_${VERSION}_${ARCH}.deb"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
chmod 755 "$STAGE"

echo "[build] robot-editor ${VERSION} / ${ARCH} / 运行用户 ${RUN_USER} / dist=${WITH_DIST}"

# ---- 桥接代码 ----
install -d -m 755 "$STAGE/opt/robot-editor/dex"
install -m 644 "$ROOT"/bridge/dex/*.py "$STAGE/opt/robot-editor/dex/"
install -m 644 "$ROOT"/bridge/dex/requirements.txt "$STAGE/opt/robot-editor/dex/" 2>/dev/null || true
install -m 644 "$ROOT"/bridge/dex/README.md "$STAGE/opt/robot-editor/dex/README.md" 2>/dev/null || true

# ---- 配置 / 命令 / 服务 ----
install -d -m 755 "$STAGE/etc/robot-editor" "$STAGE/usr/bin" \
    "$STAGE/usr/lib/systemd/system" "$STAGE/usr/share/doc/robot-editor"
install -m 644 "$ROOT/packaging/robot-editor.conf" "$STAGE/etc/robot-editor/bridge.conf"
install -m 755 "$ROOT/packaging/robot-editor" "$STAGE/usr/bin/robot-editor"
install -m 644 "$ROOT/packaging/USAGE.md" "$STAGE/usr/share/doc/robot-editor/USAGE.md"
sed "s|@RUN_USER@|${RUN_USER}|g" "$ROOT/packaging/robot-editor.service" \
    > "$STAGE/usr/lib/systemd/system/robot-editor.service"
chmod 644 "$STAGE/usr/lib/systemd/system/robot-editor.service"

# ---- 前端站点 ----
install -d -m 755 "$STAGE/etc/nginx/sites-available" "$STAGE/var/www/robot-editor"
install -m 644 "$ROOT/packaging/nginx-robot-editor.conf" \
    "$STAGE/etc/nginx/sites-available/robot-editor.conf"
COMPRESS="-Zxz"
if [ "$WITH_DIST" = "1" ]; then
    if [ ! -f "$ROOT/dist/index.html" ]; then
        echo "[build] dist/ 不存在，请先构建前端：node node_modules/vite/bin/vite.js build" >&2
        exit 1
    fi
    cp -a "$ROOT/dist/." "$STAGE/var/www/robot-editor/"
    # 归属由 dpkg-deb --root-owner-group 统一改成 root:root
    COMPRESS="-Zzstd -z10"
fi

# ---- DEBIAN 元数据 ----
mkdir -p "$STAGE/DEBIAN"
install -m 755 "$ROOT/packaging/deb/postinst" "$ROOT/packaging/deb/prerm" \
    "$ROOT/packaging/deb/postrm" "$STAGE/DEBIAN/"
SIZE=$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)
sed -e "s|@VERSION@|${VERSION}|g" -e "s|@ARCH@|${ARCH}|g" \
    -e "s|@INSTALLED_SIZE@|${SIZE}|g" \
    "$ROOT/packaging/deb/control.in" > "$STAGE/DEBIAN/control"
chmod 644 "$STAGE/DEBIAN/control"
printf '/etc/robot-editor/bridge.conf\n/etc/nginx/sites-available/robot-editor.conf\n' \
    > "$STAGE/DEBIAN/conffiles"
chmod 644 "$STAGE/DEBIAN/conffiles"

# ---- 打包 ----
mkdir -p "$OUT_DIR"
# shellcheck disable=SC2086
dpkg-deb --root-owner-group $COMPRESS --build "$STAGE" "$OUT_DIR/$PKG" >/dev/null

# Release 只保留这一版自包含包
find "$OUT_DIR" -maxdepth 1 -name '*.deb' ! -name "$PKG" -delete

echo "[build] 产物：$OUT_DIR/$PKG（$(du -h "$OUT_DIR/$PKG" | cut -f1)）"
dpkg-deb -f "$OUT_DIR/$PKG" Package Version Architecture Depends
