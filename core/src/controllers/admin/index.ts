import type { AdminContext } from './context';
export {};

/**
 * Admin panel HTTP server orchestrator.
 * Thin wrapper that wires up Express, routes, Socket.IO, and shared context.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { CONFIG } = require('../../config/config');
const { getResourcePath } = require('../../config/runtime-paths');
const { createModuleLogger } = require('../../services/logger');
const { createScheduler } = require('../../services/scheduler');
const userStore = require('../../models/user-store');
const store = require('../../models/store');

const { createAdminContext } = require('./context');
const { createSessionManager, createRouteHelpers } = require('./session');
const { mountAuthRoutes } = require('./auth-routes');
const { mountCardRoutes } = require('./card-routes');
const { mountUserRoutes } = require('./user-routes');
const { mountAgentRoutes } = require('./agent-routes');
const { mountSystemRoutes } = require('./system-routes');
const { mountAccountRoutes } = require('./account-routes');
const { mountFarmRoutes } = require('./farm-routes');
const { mountFriendRoutes } = require('./friend-routes');
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
const { mountWxLoginRoutes } = require('./wx-login-routes');
const { mountQqLoginRoutes } = require('./qq-login-routes');
const { mountCaptureRoutes, setEmbeddedCapture } = require('./capture-routes');
const {
    setupSocketIO,
    emitRealtimeStatus: _emitStatus,
    emitRealtimeLog: _emitLog,
    emitRealtimeAccountLog: _emitAccountLog,
} = require('./socket');

const adminLogger = createModuleLogger('admin');

/** 会话/账号兜底清理周期：到期或封禁后最多 1 分钟就下线并停账号 */
const ADMIN_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;

const adminScheduler = createScheduler('admin');

let ctx: AdminContext | null = null;

/**
 * 嵌入本进程的抓包服务核心。
 * 需要生成 CA 与加载 proto，均由 core.ready 在后台完成，不阻塞面板启动。
 */
let embeddedCaptureCore: any = null;

function startEmbeddedCaptureService(): any {
    try {
        const captureConfig = store.getCaptureConfig();
        if (captureConfig.enabled !== true) {
            adminLogger.info('抓包服务未启动（enabled=false）');
            return null;
        }
        if (captureConfig.embedded === false) {
            adminLogger.info('抓包服务未嵌入本进程（embedded=false，使用独立服务）');
            return null;
        }
        if (embeddedCaptureCore) return embeddedCaptureCore;
        const captureLog = (level: string, message: string, extra?: any) => {
            const fn = (adminLogger as any)[level] || adminLogger.info;
            fn.call(adminLogger, message, extra);
        };
        const { createCaptureCore } = require('../../capture/index');
        const core = createCaptureCore({ log: captureLog });
        embeddedCaptureCore = core;
        setEmbeddedCapture(core);
        core.ready.catch((error: any) => {
            adminLogger.warn('抓包服务嵌入初始化失败', { error: error.message });
        });
        adminLogger.info('抓包服务已嵌入本进程：手机代理端口 18000');
        return core;
    }
    catch (error: any) {
        adminLogger.warn('抓包服务嵌入启动失败', { error: error.message });
        return null;
    }
}

function ensureEmbeddedCaptureService(): any {
    return startEmbeddedCaptureService();
}

async function stopEmbeddedCaptureService(): Promise<void> {
    const core = embeddedCaptureCore;
    embeddedCaptureCore = null;
    setEmbeddedCapture(null);
    if (!core || typeof core.stop !== 'function') return;
    try {
        await core.stop();
    }
    catch (error: any) {
        adminLogger.warn('抓包服务嵌入停止失败', { error: error.message });
    }
}

function startAdminServer(dataProvider: any): void {
    if (ctx) return;

    ctx = createAdminContext(dataProvider);

    const sessionManager = createSessionManager(ctx);
    ctx.sessionManager = sessionManager;
    const routeHelpers = createRouteHelpers({ userStore });
    const { requireAdminRole, requireDangerConfirmation } = routeHelpers;
    const {
        requireAdminToken,
        requirePasswordChanged,
        invalidateAdminSessions,
        updateAdminSessions,
        cleanupInvalidAdminSessions,
        enforceBlockedUsers,
    } = sessionManager;

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());

    ctx.app = app;

    app.use((req: any, res: any, next: any) => {
        const allowedOrigins: string[] = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = req.headers.origin;

        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = path.join(__dirname, '../../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // 默认密码未改前，除改密/登出等自助端点外一律拒绝（含直接调接口的情况）
    app.use(requirePasswordChanged);

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountCardRoutes(app, ctx, { requireAdminToken, ...routeHelpers });
    mountUserRoutes(app, ctx, {
        requireAdminToken,
        ...routeHelpers,
        invalidateAdminSessions,
        updateAdminSessions,
    });
    mountAgentRoutes(app, ctx, {
        requireAdminToken,
        ...routeHelpers,
        invalidateAdminSessions,
        updateAdminSessions,
    });
    mountSystemRoutes(app, ctx, {
        requireAdminToken,
        ...routeHelpers,
    });
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);
    mountCaptureRoutes(app, ctx, {
        requireAdminRole,
        requireDangerConfirmation,
        ensureEmbeddedCaptureService,
        stopEmbeddedCaptureService,
    });

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const port: number = CONFIG.adminPort || 3007;
    const host: string = CONFIG.adminHost || '0.0.0.0';
    ctx.server = app.listen(port, host, () => {
        adminLogger.info('admin panel started', { url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`, host, port });
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

    // 恢复启用状态的抓包服务（配置存在 store.json，重启后自动生效）
    ensureEmbeddedCaptureService();

    // 定时兜底清理失效会话：卡密被封禁/过期后，即使该用户不再发请求，也会被踢下线并断开 Socket。
    // requireAdminToken 只在请求到达时被动失效，这里补上主动清理，避免失效会话长期驻留。
    // 另外按用户记录再扫一遍：踢掉会话之外还要停掉他名下正在跑的账号自动化（到期/封禁即下线）。
    adminScheduler.setIntervalTask(
        'session_cleanup',
        ADMIN_SESSION_CLEANUP_INTERVAL_MS,
        () => {
            cleanupInvalidAdminSessions();
            enforceBlockedUsers();
        },
        { preventOverlap: true },
    );

}

function emitRealtimeStatus(accountId: string, status: any): void {
    if (!ctx) return;
    _emitStatus(ctx, accountId, status);
}

function emitRealtimeLog(entry: any): void {
    if (!ctx) return;
    _emitLog(ctx, entry);
}

function emitRealtimeAccountLog(entry: any): void {
    if (!ctx) return;
    _emitAccountLog(ctx, entry);
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
