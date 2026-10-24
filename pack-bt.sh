#!/usr/bin/env bash
#
# 宝塔部署打包脚本
#   用法: bash pack-bt.sh [--no-build]     # 预构建包（本地编译+装依赖）
#         bash pack-bt.sh --source         # 源码包（服务器上现场 install+build）
#
# 产出:
#   预构建包 dist-packages/qq-farm-bot-<版本>-bt.tar.gz
#   源码包   dist-packages/qq-farm-bot-<版本>-src.tar.gz
#
# 【源码包】与仓库官方发布包结构一致：整个仓库源码 + docs/tools + 全部脚本，
#   不含 node_modules / dist / data。服务器上用 deploy-bt.sh 现装现编译：
#     tar -xzf qq-farm-bot-<版本>-src.tar.gz -C /www/wwwroot
#     cd /www/wwwroot/qq-farm-bot && bash deploy-bt.sh 3007
#   依赖在服务器原地安装，不涉及跨机搬运 node_modules，因此没有符号链接问题。
#
# 【预构建包】在本地完成 Web/Core 构建与生产依赖安装，服务器只需 Node 运行时：
#     tar -xzf qq-farm-bot-<版本>-bt.tar.gz -C /www/wwwroot
#     cd /www/wwwroot/qq-farm-bot && bash start.sh
#   注意：node_modules 必须是 npm 扁平实体目录（无符号链接），否则部分解压工具
#   会丢失 pnpm 的软链导致 Cannot find module。
#
# 预构建包内目录结构必须保持下面这样，后端按相对路径定位前端与资源：
#   qq-farm-bot/
#     core/{client.js,dist,src/{gameConfig,proto,utils/tsdk.wasm},node_modules}
#     web/dist
#     start.sh / ecosystem.config.cjs
#   （core/src/controllers/admin/index.ts 里 webDist = __dirname/../../../../web/dist）
#
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

OUT_DIR="$ROOT/dist-packages"
STAGE="$OUT_DIR/qq-farm-bot"
# 版本号一律用相对路径读取：Windows(Git Bash) 下 $ROOT 是 /c/... 形式的 MSYS 路径，
# 原生 node 无法解析，会静默回退成 dev。脚本开头已 cd 到 $ROOT，因此 ./package.json 可用。
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo dev)"
ARCHIVE="$OUT_DIR/qq-farm-bot-${VERSION}-bt.tar.gz"
DO_BUILD=1
PACK_MODE=prebuilt

for arg in "$@"; do
    case "$arg" in
        --no-build) DO_BUILD=0 ;;
        --source) PACK_MODE=source ;;
        -h|--help)
            echo "Usage: bash pack-bt.sh [--no-build] | bash pack-bt.sh --source"
            exit 0
            ;;
        *) echo "pack-bt.sh: unknown option: $arg" >&2; exit 1 ;;
    esac
done

if [[ "$PACK_MODE" == "source" ]]; then
    SRC_ARCHIVE="$OUT_DIR/qq-farm-bot-${VERSION}-src.tar.gz"
    echo "==> 打包源码包: $SRC_ARCHIVE"
    mkdir -p "$OUT_DIR"
    rm -f "$SRC_ARCHIVE"
    # 顶层目录名与仓库一致，与官方 qq-farm-bot-custom-*.tar.gz 同构：
    # 含源码 + docs/tools + 全部脚本 + 已构建的 dist，不含 node_modules 与运行数据
    #
    # 归档内顶层目录统一改名为 qq-farm-bot：本机克隆目录可能带随机后缀
    # （如 qq-farm-bot_3n5Tj），而所有文档与脚本都按 /www/wwwroot/qq-farm-bot 操作，
    # 不改名会导致解压后 cd 直接失败。
    tar -czf "$SRC_ARCHIVE" \
        --transform="s,^$(basename -- "$ROOT"),qq-farm-bot," \
        --exclude='*/node_modules' \
        --exclude='node_modules' \
        --exclude='core/data' \
        --exclude='dist-packages' \
        --exclude='*.log' \
        --exclude='*.tsbuildinfo' \
        --exclude='*coverage*' \
        --exclude='.git' \
        --exclude='app_dev.pid' \
        --exclude='app_dev.pid.lock' \
        --exclude='*.pid' \
        --exclude='*.tgz' \
        --exclude='.dsh-tmp' \
        --exclude='.monkeycode' \
        --exclude='output' \
        --exclude='protocol-captures' \
        --exclude='core/share.txt' \
        --exclude='*.DS_Store' \
        --exclude='Thumbs.db' \
        -C "$(dirname -- "$ROOT")" "$(basename -- "$ROOT")"
    echo
    echo "完成: $SRC_ARCHIVE"
    echo "大小: $(du -h "$SRC_ARCHIVE" | cut -f1)"
    echo
    echo "服务器上执行:"
    echo "  tar -xzf $(basename -- "$SRC_ARCHIVE") -C /www/wwwroot"
    echo "  cd /www/wwwroot/qq-farm-bot && bash deploy-bt.sh 3007"
    exit 0
fi

run_pnpm() {
    if command -v corepack >/dev/null 2>&1; then
        corepack pnpm "$@"
    elif command -v pnpm >/dev/null 2>&1; then
        pnpm "$@"
    else
        echo "pack-bt.sh: pnpm/corepack is required." >&2
        exit 1
    fi
}

if [[ "$DO_BUILD" -eq 1 ]]; then
    echo "==> 构建 Web + Core"
    run_pnpm build
else
    echo "==> 跳过构建 (--no-build)"
fi

for f in "$ROOT/web/dist/index.html" "$ROOT/core/client.js" "$ROOT/core/dist/runtime/runtime-engine.js"; do
    [[ -f "$f" ]] || { echo "pack-bt.sh: 缺少构建产物 $f，请先执行 pnpm build" >&2; exit 1; }
done

echo "==> 清理旧产物"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> 组装 Core 运行时文件"
mkdir -p "$STAGE/core"
cp "$ROOT/core/package.json" "$STAGE/core/package.json"
cp "$ROOT/core/client.js" "$STAGE/core/client.js"
cp -r "$ROOT/core/dist" "$STAGE/core/dist"
mkdir -p "$STAGE/core/src"
cp -r "$ROOT/core/src/gameConfig" "$STAGE/core/src/gameConfig"
cp -r "$ROOT/core/src/proto" "$STAGE/core/src/proto"
mkdir -p "$STAGE/core/src/utils"
cp "$ROOT/core/src/utils/tsdk.wasm" "$STAGE/core/src/utils/tsdk.wasm"

# 生产依赖必须用「扁平实体目录」而不是 pnpm 的链接式布局。
# 宝塔/部分解压工具会丢失符号链接，而 pnpm 的 node_modules 完全依赖 .pnpm 下的
# 符号链接串联，一旦丢失就报 Cannot find module 'xxx'。npm 扁平布局零符号链接。
echo "==> 安装生产依赖 (npm 扁平布局，无符号链接)"
(
    cd "$STAGE/core"
    npm install --omit=dev --no-audit --no-fund --install-strategy=hoisted
)
rm -f "$STAGE/core/package-lock.json"
# .bin 里是符号链接；运行时用 `node core/client.js`，不需要 bin
rm -rf "$STAGE/core/node_modules/.bin"

link_left="$(find "$STAGE/core/node_modules" -type l | wc -l | tr -d '[:space:]')"
if [[ "$link_left" != "0" ]]; then
    echo "pack-bt.sh: node_modules 中仍存在 $link_left 个符号链接，包不具备可移植性" >&2
    exit 1
fi

echo "==> 裁剪 Core 至运行时所需文件"
rm -rf \
    "$STAGE/core/tests" \
    "$STAGE/core/data" \
    "$STAGE/core/Dockerfile" \
    "$STAGE/core/eslint.config.mjs" \
    "$STAGE/core/tsconfig.json" \
    "$STAGE/core/tsconfig.client.json" \
    "$STAGE/core/capture-server.js" \
    "$STAGE/core/capture-server.ts" \
    "$STAGE/core/client.ts" \
    "$STAGE/core/.gitignore" \
    "$STAGE/core/README.md"


echo "==> 拷贝前端产物 web/dist"
mkdir -p "$STAGE/web"
cp -r "$ROOT/web/dist" "$STAGE/web/dist"

echo "==> 写入运行脚本"
mkdir -p "$STAGE/core/data/logs"
# 宝塔 Node 项目常用 www 用户运行，而解压文件属主是 root。
# 把运行数据目录预设为任意用户可写，避免 www 写 core/data 时 EACCES 启动失败。
chmod 777 "$STAGE/core/data" "$STAGE/core/data/logs"

# 宝塔「Node 项目」向导要求项目根目录存在 package.json，并提供 start 脚本
cat > "$STAGE/package.json" <<EOF
{
  "name": "qq-farm-bot",
  "version": "${VERSION}",
  "private": true,
  "description": "qq-farm-bot prebuilt bundle for BaoTa",
  "scripts": {
    "start": "node core/client.js"
  }
}
EOF

cat > "$STAGE/start.sh" <<'EOF'
#!/usr/bin/env bash
# 生产启动脚本（宝塔 Node 项目 / PM2 / 计划任务均可用）
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# 宝塔 Node 项目端口以 PORT 注入，本应用读 ADMIN_PORT，这里做兼容
export ADMIN_PORT="${ADMIN_PORT:-${PORT:-3007}}"
export TZ="${TZ:-Asia/Shanghai}"
export NODE_ENV=production
mkdir -p "$ROOT/core/data/logs"
exec node "$ROOT/core/client.js"
EOF
chmod +x "$STAGE/start.sh"

cat > "$STAGE/ecosystem.config.cjs" <<'EOF'
// PM2 配置: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
    apps: [
        {
            name: 'qq-farm-bot',
            script: './core/client.js',
            cwd: __dirname,
            node_args: '--max-old-space-size=2048',
            env: {
                NODE_ENV: 'production',
                ADMIN_PORT: 3007,
                TZ: 'Asia/Shanghai',
            },
            max_restarts: 10,
            autorestart: true,
        },
    ],
}
EOF

cat > "$STAGE/部署说明.txt" <<'EOF'
qq-farm-bot 宝塔部署包（预构建）
================================

本包含已编译的前端与后端及生产依赖，服务器只需 Node 18/20，无需安装 pnpm 或构建。

一、上传解压
  将 tar.gz 上传到宝塔「文件」，解压到例如 /www/wwwroot/qq-farm-bot
  （很重要：必须保持目录结构，core/ 与 web/ 同级）
  本包 node_modules 为扁平实体目录，不含任何符号链接，任何解压方式都能还原。
  若发现报 Cannot find module 'xxx'，说明解压不完整，改用：
      tar -xzf qq-farm-bot-*-bt.tar.gz -C /www/wwwroot
  并运行 bash 诊断.sh 核对依赖完整性。

二、启动（二选一）
  1. 宝塔「网站 -> Node 项目」新建（按下表填）：
       - 项目目录   : /www/wwwroot/qq-farm-bot
       - 项目名称   : qq_farm_bot
       - 启动选项   : node core/client.js   （或保留自动识别的 start 脚本）
       - Node 版本  : v20.x（已验证 v22，避免用 v24 等过新版本）
       - 包管理器   : 勾选「不安装 node_module」
                      —— 生产依赖已随包提供，服务器无 lockfile，重新 install 只会徒增失败点
       - 运行用户   : www
       - 项目端口   : 3007（务必填写，留空宝塔不会注入 PORT，无法探活）
       - 绑定域名   : 你的域名（可选，也可后续用 Nginx 反代）
     权限: 包内 core/data 已预设为 777，www 可直接写入；
           若仍报 EACCES，执行 chown -R www:www /www/wwwroot/qq-farm-bot
     端口: 宝塔注入的是 PORT，应用读 ADMIN_PORT。start.sh 已自动映射；
           若宝塔直接启动 core/client.js（不经 start.sh），请在「环境变量」里
           手动加一条 ADMIN_PORT = 你配置的端口，否则会固定监听 3007。
  2. 命令行 / PM2（最易排查，推荐先用它确认能起来）：
       cd /www/wwwroot/qq-farm-bot
       npm i -g pm2            # 若未安装
       pm2 start ecosystem.config.cjs && pm2 save
       pm2 logs qq-farm-bot    # 看日志

三、Nginx 反向代理
  新建站点绑定域名，反向代理到 http://127.0.0.1:<端口>，并务必开启「WebSocket 支持」，
  否则面板实时状态与日志无法推送。不要把端口直接暴露公网。

四、首次登录
  浏览器打开域名，默认管理员 admin / admin，登录后立即改密码。

五、运行数据
  全部保存在 core/data/（账号、配置、卡密、日志等）。
  升级时只需替换 core/dist、core/client.js、web/dist，并保留 core/data。
  重新部署前建议先停止服务并备份 core/data。

六、换端口
  修改 start.sh / ecosystem.config.cjs 里的 ADMIN_PORT，或启动时 export ADMIN_PORT=xxxx。

七、启动失败时
  执行 bash 诊断.sh 收集环境信息与前台启动日志，定位原因。
EOF

cat > "$STAGE/诊断.sh" <<'EOF'
#!/usr/bin/env bash
# 宝塔部署诊断脚本：无副作用，只读取信息并做一次 15 秒前台启动
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
PORT="${ADMIN_PORT:-${PORT:-3007}}"

echo "===== 1. 运行时 ====="
echo "whoami : $(id -un 2>/dev/null || echo '?')"
echo "node   : $(command -v node 2>/dev/null || echo '未安装') $(node -v 2>/dev/null)"
echo "系统   : $(uname -sr)"

echo
echo "===== 2. 目录结构 ====="
for p in core/client.js core/dist/runtime/runtime-engine.js \
         core/src/gameConfig core/src/proto core/src/utils/tsdk.wasm \
         web/dist/index.html core/node_modules core/data; do
    if [[ -e "$p" ]]; then echo "[ OK ] $p"; else echo "[MISS] $p"; fi
done

echo
echo "===== 3. 依赖完整性（解压丢符号链接会在这里暴露）====="
broken=0
for m in express body-parser axios winston socket.io ws; do
    if (cd core && node -e "require.resolve('$m')" >/dev/null 2>&1); then
        echo "[ OK ] $m"
    else
        echo "[FAIL] $m 解析失败"; broken=1
    fi
done
echo "符号链接数量: $(find core/node_modules -type l 2>/dev/null | wc -l)"
if [[ "$broken" == "1" ]]; then
    echo ">> 依赖损坏：请用 tar 重新解压整个包（宝塔「解压」若丢链接，改用命令行 tar -xzf）"
fi

echo
echo "===== 4. 权限 ====="
ls -ld core core/data 2>&1
echo "core/data 可写: $([[ -w core/data ]] && echo yes || echo no)"

echo
echo "===== 5. 端口 ====="
echo "使用端口: $PORT"
(command -v ss >/dev/null && ss -ltnp 2>/dev/null | grep -E ":$PORT\b") || echo "端口 $PORT 未被占用"

echo
echo "===== 6. 前台启动 15 秒 ====="
mkdir -p core/data/logs
ADMIN_PORT="$PORT" TZ="${TZ:-Asia/Shanghai}" NODE_ENV=production \
    timeout 15 node core/client.js 2>&1 | tail -n 50
echo "(退出码: ${PIPESTATUS[0]})"
EOF
chmod +x "$STAGE/诊断.sh"

echo "==> 打包"
tar -czf "$ARCHIVE" -C "$OUT_DIR" qq-farm-bot

echo
echo "完成: $ARCHIVE"
echo "大小: $(du -h "$ARCHIVE" | cut -f1)"
echo "解压后: $STAGE ($(du -sh "$STAGE" | cut -f1))"
