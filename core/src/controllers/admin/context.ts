import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface SessionUser {
    username: string;
    role: 'user' | 'agent' | 'admin' | 'super_admin';
    card?: any;
    accountLimit?: number;
    mustChangePassword?: boolean;
    agent?: any;
}

export interface AdminContext {
    tokens: Set<string>;
    sessions: Map<string, SessionUser>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
    sessionManager?: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = new Set<string>();
    const sessions = new Map<string, SessionUser>();
    return {
        tokens,
        sessions,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
