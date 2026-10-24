#!/usr/bin/env bash
#
# 宝塔面板部署脚本（源码路线）
#   用法: bash deploy-bt.sh [端口]        # 默认 3007
#
# 前提: 已在宝塔「软件商店 -> Node.js 版本管理器」安装 Node 20
#
# 说明: 本项目后端 (core) 启动时会把 web/dist 作为静态站点托管，
#       因此只需运行一个进程，无需单独部署前端。
#       监听端口由环境变量 ADMIN_PORT 决定（不是根目录 .env 的 PORT）。
#       监听地址由 ADMIN_HOST 决定，默认 127.0.0.1（仅本机，配合 Nginx 反代）；
#       需要局域网直连时用 ADMIN_HOST=0.0.0.0 bash deploy-bt.sh。
#
set -Eeuo pipefail

PORT="${1:-3007}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

echo "==> 项目目录: $ROOT"
echo "==> 监听端口: $PORT (ADMIN_PORT)"

# 1) Node
if ! command -v node >/dev/null 2>&1; then
  echo "!! 未找到 node。请先在宝塔「软件商店 -> Node.js 版本管理器」安装 Node 20，并让当前终端可用。" >&2
  exit 1
fi
echo "==> node $(node -v)"

# 2) pnpm (项目锁定 pnpm@10.30.2)
if command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  echo "!! 未找到 pnpm/corepack。可执行: npm i -g pnpm@10.30.2" >&2
  exit 1
fi
echo "==> 包管理器: $PNPM"

# 3) 依赖
echo "==> 安装依赖: $PNPM install --frozen-lockfile"
$PNPM install --frozen-lockfile

# 4) 构建（前端 web/dist + 后端 core/dist、core/client.js）
echo "==> 构建: $PNPM build"
$PNPM build

# 5) 运行数据目录（必须可写；账号/配置/日志都在这里）
mkdir -p "$ROOT/core/data"
echo "==> 数据目录: $ROOT/core/data"
# 若计划以 www 用户运行，取消下一行注释
# chown -R www:www "$ROOT/core/data"

# 6) 启动
export ADMIN_PORT="$PORT"
# 默认只监听回环：宝塔上的 Nginx 反代与面板同机，走 127.0.0.1 即可，
# 这样 3007 端口不会直接暴露到公网（安全审计 P0 要求）。
# 需要在局域网/公网直接用 IP:端口 调试时，改为 0.0.0.0。
export ADMIN_HOST="${ADMIN_HOST:-127.0.0.1}"
export TZ="${TZ:-Asia/Shanghai}"
export NODE_ENV=production
echo "==> 监听地址: $ADMIN_HOST:$PORT"

if command -v pm2 >/dev/null 2>&1; then
  echo "==> 使用 PM2 启动"
  pm2 delete qq-farm-bot >/dev/null 2>&1 || true
  ADMIN_HOST="$ADMIN_HOST" ADMIN_PORT="$PORT" TZ="$TZ" NODE_ENV=production \
      pm2 start "$ROOT/core/client.js" --name qq-farm-bot --update-env
  pm2 save
  echo "==> 查看状态: pm2 status | 日志: pm2 logs qq-farm-bot"
  echo "==> 开机自启: 执行 pm2 startup 并按其提示运行输出的那条命令"
else
  echo "==> 未检测到 PM2，改用项目自带 start.sh 后台启动"
  bash "$ROOT/start.sh"
  echo "==> 日志: $ROOT/app_dev.log"
fi

echo
echo "==> 部署完成。后续请在 Nginx 反向代理指向 http://127.0.0.1:$PORT"
echo "    并务必开启「WebSocket 支持」，否则面板实时状态无法连接。"
echo "    不要将 $PORT 直接暴露到公网；首次登录 admin / admin，登录后立即改密码。"
