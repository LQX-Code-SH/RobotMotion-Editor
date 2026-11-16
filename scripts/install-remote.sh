#!/usr/bin/env bash
#
# 从操作站把 Release 下的 robot-editor .deb 安装到机器人本体（远程安装服务）。
#
#   scripts/install-remote.sh list
#   scripts/install-remote.sh install --host 192.168.41.2 --user nvidia --enable
#   scripts/install-remote.sh status  --host 192.168.41.2 --user nvidia
#   scripts/install-remote.sh start|stop|logs --host 192.168.41.2 --user nvidia
#
# 密码：交互输入（不回显）；自动化时可预设 ROBOT_SSH_PASSWORD。
# 型号：--firmware <tienkung_dex|tienkung_pro|walker_c1|walker_s2>，默认 tienkung_dex。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="$ROOT/bridge/deploy/cli.js"
COMMAND=${1:-}

case "$COMMAND" in
    ""|-h|--help|help)
        exec node "$CLI" help
        ;;
esac

if ! command -v node >/dev/null 2>&1; then
    echo "需要 Node.js 18+（在操作站上运行本脚本）" >&2
    exit 1
fi

if [ ! -d "$ROOT/bridge/node_modules/ssh2" ]; then
    echo "缺少部署依赖，先执行：cd $ROOT/bridge && pnpm install --prod" >&2
    exit 1
fi

if [ "$COMMAND" != "list" ] && [ -z "${ROBOT_SSH_PASSWORD:-}" ]; then
    read -rsp "机器人登录密码: " ROBOT_SSH_PASSWORD
    echo
    export ROBOT_SSH_PASSWORD
fi

exec node "$CLI" "$@"
