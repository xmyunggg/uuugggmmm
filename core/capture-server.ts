export {};
/**
 * 抓包服务 CLI 入口（独立模式）
 *
 * 启动后提供：
 * - REST API：默认 http://127.0.0.1:8450（bot 管理面板的“抓包登录”使用）
 * - MITM 代理端口：默认 18000，绑定全部网卡 IP（局域网 / Tailscale）
 *
 * 配置见 <core>/data/capture/config.json，或使用 CAPTURE_* 环境变量。
 * 注意：bot 内嵌模式下不需要本入口，抓包内核由 admin 路由直接调用。
 */
const path = require('node:path');
const fs = require('node:fs');

// 与 client.ts 相同的加载约定：tsx/bun 直接跑 .ts 时用 src，node 跑产物时用 dist
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const { startCaptureServer } = require(`${baseDir}/capture/index`);
const { resolveAdvertiseAddresses } = require(`${baseDir}/capture/ip-utils`);

async function main() {
    const { config, stop, log } = await startCaptureServer();
    const advertise = resolveAdvertiseAddresses(config);

    log('info', '抓包服务启动完成');
    log('info', `API: http://${config.apiHost}:${config.apiPort}`);
    log('info', `代理端口: ${config.proxyPortFrom}`);
    log('info', `代理绑定 IP: ${(config.proxyBind || []).join(', ')}`);
    log('info', `对外代理地址（手机 Wi-Fi 代理填写）: ${advertise.addresses.length
        ? advertise.addresses.map(item => `${item.address}:<代理端口> (${item.kind})`).join(', ')
        : '未检测到可用地址，请检查 CAPTURE_ADVERTISE_IPS 配置'}`);

    const shutdown = async (signal) => {
        log('info', `收到 ${signal}，正在关闭...`);
        await stop();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    console.error('[capture] 启动失败:', error && error.message ? error.message : error);
    process.exit(1);
});
