import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { createModuleLogger } = require('../../services/logger');

/** 清空全部卡密时必须原样输入的确认短语（前端弹窗同步这份文案）。 */
const CLEAR_ALL_CARDS_CONFIRM_TEXT = '清空所有卡密';

/**
 * Card management routes (mounted after the per-user auth payload is attached).
 */

function mountCardRoutes(
    app: Application,
    ctx: AdminContext,
    { requireAdminToken, requireAdminRole, requireDangerConfirmation }: any,
): void {
    const userStore = require('../../models/user-store');
    const cardLogger = createModuleLogger('admin');

    app.get('/api/admin/cards', requireAdminToken, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getAllCards() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            const { count } = req.body || {};
            const confirmation = count && Number.parseInt(count, 10) > 1 ? 'CREATE_CARDS_BATCH' : 'CREATE_CARD';
            if (!requireDangerConfirmation(req, res, confirmation)) return;

            const { description, days, type, durationValue, durationUnit, isPermanent, value, accountLimit } = req.body || {};
            if (!description || (days === undefined && durationValue === undefined && value === undefined && !isPermanent)) {
                return res.status(400).json({ ok: false, error: '请提供描述和时长' });
            }

            const cardType = type === 'quota' ? 'quota' : 'time';
            const permanentRequested = isPermanent === true || Number(days) === -1 || Number(durationValue) === -1;
            const requestedValue = Number(cardType === 'quota' ? (value ?? days) : (durationValue ?? days));
            if (cardType === 'time' && !permanentRequested && (!Number.isFinite(requestedValue) || requestedValue <= 0)) {
                return res.status(400).json({ ok: false, error: '时间卡时长必须大于 0，永久卡请使用 -1' });
            }
            if (cardType === 'quota' && (!Number.isFinite(requestedValue) || requestedValue <= 0)) {
                return res.status(400).json({ ok: false, error: '额度卡数量必须大于 0' });
            }
            if (cardType === 'time' && accountLimit !== undefined && accountLimit !== null && accountLimit !== '') {
                const limit = Number(accountLimit);
                if (!Number.isFinite(limit) || limit <= 0) {
                    return res.status(400).json({ ok: false, error: '时间卡额度数量必须大于 0' });
                }
            }

            const durationOptions = { durationValue, durationUnit, isPermanent, value, accountLimit };
            if (count && Number.parseInt(count, 10) > 1) {
                const cards = userStore.createCardsBatch(description, days, count, cardType, durationOptions);
                return res.json({ ok: true, data: cards, batch: true, count: cards.length });
            }

            const card = userStore.createCard(description, days, cardType, durationOptions);
            res.json({ ok: true, data: card });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/batch-delete', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_CARDS_BATCH')) return;
            const { codes } = req.body || {};
            if (!Array.isArray(codes) || codes.length === 0) {
                return res.status(400).json({ ok: false, error: '请提供要删除的卡密列表' });
            }
            res.json(userStore.deleteCardsBatch(codes));
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/clear-used', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'CLEAR_USED_CARDS')) return;
            const result = userStore.clearCards('used');
            if (result.ok) cardLogger.info('清空已使用卡密', { deletedCount: result.deletedCount, remainingCount: result.remainingCount });
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/clear-all', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'CLEAR_ALL_CARDS')) return;
            const confirmedText = String((req.body || {}).confirmText || '').trim();
            if (confirmedText !== CLEAR_ALL_CARDS_CONFIRM_TEXT) {
                return res.status(400).json({
                    ok: false,
                    error: `清空全部卡密需要输入「${CLEAR_ALL_CARDS_CONFIRM_TEXT}」确认`,
                    requiredConfirmation: 'CLEAR_ALL_CARDS',
                    requiredConfirmText: CLEAR_ALL_CARDS_CONFIRM_TEXT,
                });
            }
            const result = userStore.clearCards('all');
            if (result.ok) cardLogger.warn('清空全部卡密', { deletedCount: result.deletedCount });
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/cards/:code', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_CARD_STATUS')) return;
            const card = userStore.updateCard(req.params.code, req.body || {});
            if (!card) return res.status(404).json({ ok: false, error: '卡密不存在' });
            res.json({ ok: true, data: card });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.delete('/api/admin/cards/:code', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'DELETE_CARD')) return;
            const deleted = userStore.deleteCard(req.params.code);
            if (!deleted) return res.status(404).json({ ok: false, error: '卡密不存在' });
            res.json({ ok: true });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/card-claim/status', (_req: Request, res: Response) => {
        try {
            const status = userStore.getCardClaimStatus();
            res.json({ ok: true, enabled: status.enabled, availableTimeCards: userStore.getAvailableTimeCardCount() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/card-claim/status', requireAdminToken, requireAdminRole, (req: Request, res: Response) => {
        try {
            if (!requireDangerConfirmation(req, res, 'UPDATE_CARD_CLAIM_STATUS')) return;
            const { enabled } = req.body;
            const availableTimeCards = userStore.getAvailableTimeCardCount();
            if (enabled && availableTimeCards <= 0) {
                return res.status(400).json({ ok: false, error: '可领取时间卡密库存不足，无法开启卡密领取功能', availableTimeCards });
            }
            const status = userStore.setCardClaimStatus(enabled);
            res.json({ ok: true, enabled: status.enabled, availableTimeCards });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/card-claim/claim', (req: Request, res: Response) => {
        try {
            const userAgent = String(req.headers['user-agent'] || '');
            const username = (req.body && req.body.username) || null;
            userStore.clearExpiredClaimRecords();
            const claim = userStore.claimCardByUA(userAgent, username);
            if (!claim.ok) {
                const payload: any = { ok: false, error: claim.error };
                if (claim.remainingMs) payload.remainingMs = claim.remainingMs;
                return res.status(400).json(payload);
            }
            res.json({
                ok: true,
                cardCode: claim.cardCode,
                days: claim.days,
                durationValue: claim.durationValue,
                durationUnit: claim.durationUnit,
                durationMs: claim.durationMs,
                isPermanent: claim.isPermanent === true,
                description: claim.description,
            });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/admin/card-claim/records', requireAdminToken, requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: userStore.getCardClaimRecords() });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountCardRoutes };
