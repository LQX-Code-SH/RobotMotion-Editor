#!/usr/bin/env bash
#
# 构建「robot-editor 管理器」：GUI + 远程运维（安装/启停/重启/状态/日志/自启/卸载）。
#
#   scripts/build-manager.sh                 # 增量更新产物目录（秒级，不重拷 deb）
#   scripts/build-manager.sh --tar           # 额外打整包 tar（仅分发/拷贝到别的电脑时用）
#   VERSION=1.6.0 scripts/build-manager.sh   # 指定版本
#
# 产物：
#   dist-manager/robot-manager_<version>_<arch>/        可直接运行（双击 run-manager.sh）
#   dist-manager/robot-manager_<version>_<arch>.tar     仅在 --tar 时生成
#
# 为什么不建议每次都打包：
#   - 改一行 Python 只需要 rsync 同步一个 30 KB 的文件；
#   - Release/*.deb 在产物里是硬链接，不复制、不额外占空间；
#   - tar 只在 --tar 时生成，避免每改一次代码就多出 113 MB。
#
# 目标机依赖：python3-tk、paramiko（Debian/Ubuntu：sudo apt install python3-tk python3-paramiko）
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${VERSION:-$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")}
ARCH=${ARCH:-$(dpkg --print-architecture)}
NAME="robot-manager_${VERSION}_${ARCH}"
OUT="$ROOT/dist-manager/$NAME"
WANT_TAR=0
for arg in "$@"; do
    case "$arg" in
        --tar) WANT_TAR=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    esac
done

if [ ! -f "$ROOT/manager/robot_manager.py" ]; then
    echo "[manager] 缺少 manager/robot_manager.py" >&2
    exit 1
fi

mkdir -p "$OUT/Release"

# ---- 程序文件：增量同步（改代码不需要重拷 113 MB）----
if command -v rsync >/dev/null 2>&1; then
    rsync -a --chmod=F755 "$ROOT/manager/robot_manager.py" "$OUT/robot_manager.py"
    rsync -a "$ROOT/bridge/deploy/manifest.json" "$OUT/manifest.json"
else
    install -m 755 "$ROOT/manager/robot_manager.py" "$OUT/robot_manager.py"
    install -m 644 "$ROOT/bridge/deploy/manifest.json" "$OUT/manifest.json"
fi

# ---- 安装包：硬链接，不复制 ----
shopt -s nullglob
DEBS=("$ROOT"/Release/*.deb)
shopt -u nullglob
if [ ${#DEBS[@]} -eq 0 ]; then
    echo "[manager] Release/ 下没有 .deb，先执行 scripts/build-deb.sh" >&2
    exit 1
fi

linked=0
for deb in "${DEBS[@]}"; do
    target="$OUT/Release/$(basename "$deb")"
    if [ -e "$target" ] && [ "$deb" -ef "$target" ]; then
        continue
    fi
    # 同文件系统建硬链接（瞬时）；跨设备时回退复制
    if ln -f "$deb" "$target" 2>/dev/null; then
        linked=$((linked + 1))
    else
        cp -f "$deb" "$target"
    fi
done

# 清理产物里已被删除的旧 deb
shopt -s nullglob
for old in "$OUT"/Release/*.deb; do
    [ -e "$ROOT/Release/$(basename "$old")" ] || rm -f "$old"
done
shopt -u nullglob

# ---- 启动脚本 / 桌面入口 / 说明 ----
cat > "$OUT/run-manager.sh" <<'EOF'
#!/bin/sh
# 启动 robot-editor 管理器
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
    echo "需要 python3" >&2
    exit 1
fi
if ! python3 -c "import tkinter" 2>/dev/null; then
    echo "缺少 tkinter：sudo apt install python3-tk" >&2
    exit 1
fi
if ! python3 -c "import paramiko" 2>/dev/null; then
    echo "缺少 paramiko：sudo apt install python3-paramiko（或 pip3 install paramiko）" >&2
    exit 1
fi

exec python3 ./robot_manager.py "$@"
EOF
chmod +x "$OUT/run-manager.sh"

cat > "$OUT/robot-manager.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=robot-editor 管理器
Comment=远程安装与运维机器人上的 robot-editor 服务
Exec=sh -c "cd $(dirname %k) && ./run-manager.sh"
Icon=utilities-terminal
Terminal=false
Categories=Utility;
EOF
chmod +x "$OUT/robot-manager.desktop"

cat > "$OUT/README.txt" <<EOF
robot-editor 管理器 ${VERSION}（${ARCH}）

启动：
    ./run-manager.sh            # 终端
    或双击 robot-manager.desktop（部分桌面需右键“允许启动”）

依赖（Debian/Ubuntu）：
    sudo apt install python3-tk python3-paramiko

功能：
    状态 / 安装 / 启动 / 停止 / 重启 / 日志 / 开机自启 / 卸载
    「更多」里可切换安装包目录（默认随包 Release/）与四路端口。

用法：
    1. 填机器人 IP / SSH 端口 / 用户名 / 登录密码；
    2. 选固件型号（默认 tienkung_dex，按型号匹配 .deb）；
    3. 点「状态」确认现状，点「安装」推送并安装；
    4. 装完点「启动」，浏览器访问 http://<机器人IP>:3000。
    「卸载…」默认 dpkg -r 保留 /etc/robot-editor 配置，可另选彻底删除。

无界面（脚本）：
    scripts/install-remote.sh install --host <机器人IP> --user <用户名> --enable
EOF

echo "[manager] 产物：$OUT（deb 硬链接 $linked 个）"
if ! python3 "$OUT/robot_manager.py" --list >/dev/null 2>&1; then
    echo "[manager] 警告：自检失败（缺 paramiko？），产物仍可用" >&2
fi

# ---- 整包：仅 --tar 时生成 ----
if [ "$WANT_TAR" -eq 1 ]; then
    tar -cf "$ROOT/dist-manager/${NAME}.tar" -C "$ROOT/dist-manager" "$NAME"
    echo "[manager] 整包：$ROOT/dist-manager/${NAME}.tar（$(du -h "$ROOT/dist-manager/${NAME}.tar" | cut -f1)）"
else
    echo "[manager] 跳过 tar（需要分发时加 --tar）"
fi
