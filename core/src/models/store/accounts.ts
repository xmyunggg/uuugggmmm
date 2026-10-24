import type { Account, AccountsData } from '../../types/account';
export {};

const fs = require('node:fs');
const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../../services/json-db');

const { ACCOUNTS_FILE } = require('./shared-state');

function loadAccounts(): AccountsData {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    return normalizeAccountsData(data);
}

function saveAccounts(data: AccountsData): void {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}

function getAccounts(): AccountsData {
    return loadAccounts();
}

function normalizeAccountsData(raw: unknown): AccountsData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const accounts: Account[] = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m: number, a: any) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

/** 微信长期凭证字段：只用于服务端换发登录 code，不得出现在任何 API 响应里 */
const ACCOUNT_SECRET_FIELDS = ['loginBuffer', 'accesstoken', 'refreshtoken', 'refreshToken', 'accessToken', 'wxid'];

function normalizeAccount(raw: any): Account {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account: Account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick) account.nick = nick;
    const username = String(source.username || '').trim();
    if (username) account.username = username;
    const wxid = String(source.wxid || '').trim();
    if (wxid) account.wxid = wxid;
    for (const field of ['loginBuffer', 'accesstoken', 'refreshtoken']) {
        const value = String(source[field] || '');
        if (value) (account as any)[field] = value;
    }
    const credentialUpdatedAt = Number(source.credentialUpdatedAt) || 0;
    if (credentialUpdatedAt > 0) account.credentialUpdatedAt = credentialUpdatedAt;
    return account;
}

/** 去掉账号对象里的微信长期凭证（用于所有对外响应） */
function stripAccountSecrets<T>(source: T): T {
    if (!source || typeof source !== 'object') return source;
    const result: any = { ...(source as any) };
    for (const field of ACCOUNT_SECRET_FIELDS) delete result[field];
    return result;
}

function stripAccountsDataSecrets(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const accounts = Array.isArray(data.accounts) ? data.accounts.map(account => stripAccountSecrets(account)) : [];
    return { ...data, accounts };
}

/**
 * 认领扫码流程暂存的微信凭证并合并进待写入的账号数据。
 * 只在新增/重登（payload 带 code 且平台为 wx）时生效，凭证按 code 一次性消费。
 */
function claimWxCredentials(cleanAccount: any): void {
    if (String(cleanAccount.platform || '') !== 'wx') return;
    const code = String(cleanAccount.code || '').trim();
    if (!code) return;
    let pending: any = null;
    try {
        const { takeLoginCredentials } = require('../../services/wx-login/pending-credentials');
        pending = takeLoginCredentials(code);
    } catch {
        return;
    }
    if (!pending) return;
    if (pending.openid) cleanAccount.wxid = String(pending.openid);
    if (pending.loginBuffer) cleanAccount.loginBuffer = String(pending.loginBuffer);
    if (pending.accesstoken) cleanAccount.accesstoken = String(pending.accesstoken);
    if (pending.refreshtoken) cleanAccount.refreshtoken = String(pending.refreshtoken);
    cleanAccount.credentialUpdatedAt = Date.now();
    if (!cleanAccount.avatar && pending.avatar) cleanAccount.avatar = String(pending.avatar);
}

function addOrUpdateAccount(acc: Partial<Account> & { avatarUrl?: string }): AccountsData {
    const { ensureAccountConfig, removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    const source: any = acc || {};
    const cleanAccount: any = {};
    for (const key of ['id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'username', 'wxid', 'loginBuffer', 'accesstoken', 'refreshtoken', 'credentialUpdatedAt']) {
        if (source[key] !== undefined) cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    claimWxCredentials(acc);
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            ...(acc.username ? { username: String(acc.username) } : {}),
            ...(acc.wxid ? { wxid: String(acc.wxid) } : {}),
            ...(acc.loginBuffer ? { loginBuffer: String(acc.loginBuffer) } : {}),
            ...(acc.accesstoken ? { accesstoken: String(acc.accesstoken) } : {}),
            ...(acc.refreshtoken ? { refreshtoken: String(acc.refreshtoken) } : {}),
            ...(acc.credentialUpdatedAt ? { credentialUpdatedAt: Number(acc.credentialUpdatedAt) } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return stripAccountsDataSecrets(data);
}

function deleteAccount(id: unknown): AccountsData {
    const { removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return stripAccountsDataSecrets(data);
}

/** 取账号归属的登录用户名；无归属（管理员直接创建/历史账号）返回空字符串 */
function getAccountOwnerUsername(accountId: unknown): string {
    const id = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (!id) return '';
    const account = loadAccounts().accounts.find((item: any) => String(item.id) === id);
    return account ? String(account.username || '').trim() : '';
}

module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    getAccountOwnerUsername,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
    stripAccountSecrets,
    stripAccountsDataSecrets,
};
