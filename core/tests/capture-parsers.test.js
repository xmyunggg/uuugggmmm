const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const protobuf = require('protobufjs');

const CODEC = '../dist/capture/code-extractor';
const PROXY = '../dist/capture/mitm-proxy';
const WS = '../dist/capture/ws-parser';
const FRIEND = '../dist/capture/friend-extractor';

function fresh(modulePath) {
    const id = require.resolve(modulePath);
    delete require.cache[id];
    return require(id);
}

// ---------- CONNECT 行 ----------

test('parseConnectLine 解析 host:port 与 IPv6 方括号', () => {
    const { parseConnectLine } = fresh(PROXY);
    assert.deepEqual(parseConnectLine('CONNECT gate-obt.nqf.qq.com:443 HTTP/1.1'), { host: 'gate-obt.nqf.qq.com', port: 443 });
    assert.deepEqual(parseConnectLine('connect EXAMPLE.com:8443 HTTP/1.0'), { host: 'EXAMPLE.com', port: 8443 });
    assert.deepEqual(parseConnectLine('CONNECT [::1]:8080 HTTP/1.1'), { host: '::1', port: 8080 });
    assert.deepEqual(parseConnectLine('CONNECT user@host:443 HTTP/1.1'), { host: 'host', port: 443 });
});

test('parseConnectLine 拒绝非法输入', () => {
    const { parseConnectLine } = fresh(PROXY);
    for (const line of ['GET / HTTP/1.1', 'CONNECT', 'CONNECT host HTTP/1.1', 'CONNECT host: HTTP/1.1', 'CONNECT host:0 HTTP/1.1', 'CONNECT host:70000 HTTP/1.1', '']) {
        assert.equal(parseConnectLine(line), null, `不应解析: ${line}`);
    }
});

test('findHeadEnd 支持 CRLF 与 LF，未结束时返回 -1', () => {
    const { findHeadEnd } = fresh(PROXY);
    assert.equal(findHeadEnd(Buffer.from('GET / HTTP/1.1\r\nHost: a\r\n\r\n')), 27);
    assert.equal(findHeadEnd(Buffer.from('GET / HTTP/1.1\nHost: a\n\n')), 24);
    assert.equal(findHeadEnd(Buffer.from('GET / HTTP/1.1\r\nHost: a\r\n')), -1);
});

test('parseAbsoluteUrl 支持明文 HTTP 代理形式', () => {
    const { parseAbsoluteUrl } = fresh(PROXY);
    assert.deepEqual(parseAbsoluteUrl('http://example.com/a?b=1'), { host: 'example.com', port: 80, path: '/a?b=1', isHttps: false });
    assert.deepEqual(parseAbsoluteUrl('https://example.com:8443/x'), { host: 'example.com', port: 8443, path: '/x', isHttps: true });
    assert.equal(parseAbsoluteUrl('/api/v1'), null);
    assert.equal(parseAbsoluteUrl(''), null);
});

// ---------- 域名匹配与 code 提取 ----------

test('matchesHostPattern 支持通配与裸域', () => {
    const { matchesHostPattern, isCaptureHost } = fresh(CODEC);
    const patterns = ['*.nqf.qq.com', 'q.qq.com'];
    assert.equal(matchesHostPattern('gate-obt.nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('evil-nqf.qq.com', '*.nqf.qq.com'), false);
    assert.equal(matchesHostPattern('GATE-OBT.NQF.QQ.COM', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('q.qq.com.', 'q.qq.com'), true);
    assert.equal(isCaptureHost('gate-obt.nqf.qq.com', { captureHosts: patterns }), true);
    assert.equal(isCaptureHost('other.example.com', { captureHosts: patterns }), false);
    assert.equal(isCaptureHost('gate-obt.nqf.qq.com', {}), false, '未配置时不应抓取任何域名');
});

test('isValidCode 依据网关/升级/长度过滤噪声', () => {
    const { isValidCode } = fresh(CODEC);
    assert.equal(isValidCode('shortcode', { gatewayHost: true }), true, '网关域名放宽长度');
    assert.equal(isValidCode('shortcode', {}), false);
    assert.equal(isValidCode('0123456789abcdef', {}), true);
    assert.equal(isValidCode('true', { gatewayHost: true }), false);
    assert.equal(isValidCode('0', { gatewayHost: true }), false);
    assert.equal(isValidCode('abc', { isUpgrade: true }), false);
});

test('extractLoginInfo 从网关注入的 WS 地址提取 code/openID', () => {
    const { extractLoginInfo } = fresh(CODEC);
    const target = '/prod/ws?platform=qqplay&code=ABC123XYZ&openID=OPENID-1';
    const info = extractLoginInfo({
        host: 'gate-obt.nqf.qq.com',
        parsedHead: { target, headers: { upgrade: 'websocket' }, isUpgrade: true },
        config: { captureHosts: ['*.nqf.qq.com'] },
    });
    assert.equal(info.code, 'ABC123XYZ');
    assert.equal(info.openId, 'OPENID-1');
    assert.equal(info.matched, true);
});

test('extractLoginInfo 从 JSON 请求体提取 code/openid', () => {
    const { extractLoginInfo } = fresh(CODEC);
    const body = Buffer.from(JSON.stringify({ data: { code: 'BODYCODE1234567890', open_id: 'OPENID-2' } }));
    const info = extractLoginInfo({
        host: 'other.example.com',
        parsedHead: { target: '/x', headers: {}, isUpgrade: false },
        body,
    });
    assert.equal(info.code, 'BODYCODE1234567890');
    assert.equal(info.openId, 'OPENID-2');
});

// ---------- WebSocket 帧解析 ----------

function frame(opcode, payload, { fin = true, mask = null } = {}) {
    const head = [];
    head.push((fin ? 0x80 : 0) | opcode);
    const useExtended = payload.length >= 126;
    head.push((mask ? 0x80 : 0) | (useExtended ? 126 : payload.length));
    if (useExtended) head.push(payload.length >> 8, payload.length & 0xFF);
    if (mask) head.push(...mask);
    const body = Buffer.from(payload);
    if (mask) {
        for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
    }
    return Buffer.concat([Buffer.from(head), body]);
}

test('WsFrameParser 输出完整二进制消息', () => {
    const { WsFrameParser } = fresh(WS);
    const messages = [];
    const parser = new WsFrameParser({ onMessage: m => messages.push(m) });
    parser.push(frame(0x2, Buffer.from([1, 2, 3])));
    assert.equal(messages.length, 1);
    assert.deepEqual([...messages[0]], [1, 2, 3]);
});

test('WsFrameParser 跨分片（TCP 分包）重组', () => {
    const { WsFrameParser } = fresh(WS);
    const messages = [];
    const parser = new WsFrameParser({ onMessage: m => messages.push(m) });
    const raw = frame(0x2, Buffer.from([9, 8, 7, 6, 5]));
    parser.push(raw.subarray(0, 3));
    parser.push(raw.subarray(3));
    assert.equal(messages.length, 1);
    assert.deepEqual([...messages[0]], [9, 8, 7, 6, 5]);
});

test('WsFrameParser 重组 WebSocket 分片帧（FIN=0 + 续帧）', () => {
    const { WsFrameParser } = fresh(WS);
    const messages = [];
    const parser = new WsFrameParser({ onMessage: m => messages.push(m) });
    parser.push(frame(0x2, Buffer.from([1, 2]), { fin: false }));
    assert.equal(messages.length, 0, '未收齐不应回调');
    parser.push(frame(0x0, Buffer.from([3, 4]), { fin: false }));
    parser.push(frame(0x0, Buffer.from([5]), { fin: true }));
    assert.equal(messages.length, 1);
    assert.deepEqual([...messages[0]], [1, 2, 3, 4, 5]);
});

test('WsFrameParser 解掩码并忽略 ping/pong/text', () => {
    const { WsFrameParser } = fresh(WS);
    const messages = [];
    const parser = new WsFrameParser({ onMessage: m => messages.push(m) });
    parser.push(frame(0x9, Buffer.from([0])));
    parser.push(frame(0x2, Buffer.from([7, 7]), { mask: [0xAA, 0xBB, 0xCC, 0xDD] }));
    parser.push(frame(0x1, Buffer.from('text-frame')));
    assert.equal(messages.length, 1);
    assert.deepEqual([...messages[0]], [7, 7]);
});

test('WsFrameParser 关闭帧与超限保护', () => {
    const { WsFrameParser } = fresh(WS);
    const events = [];
    const parser = new WsFrameParser({
        maxPayload: 8,
        onMessage: () => events.push('message'),
        onClose: () => events.push('close'),
        onError: () => events.push('error'),
    });
    parser.push(frame(0x8, Buffer.from([0x03, 0xE8])));
    assert.deepEqual(events, ['close']);
    parser.push(frame(0x2, Buffer.from('ignored-after-close')));
    assert.deepEqual(events, ['close'], '关闭后不再解析');

    const overflow = new WsFrameParser({ maxPayload: 8, onError: () => events.push('overflow') });
    overflow.push(frame(0x2, Buffer.alloc(16)));
    assert.ok(events.includes('overflow'));
});

test('WsFrameParser 支持 126 扩展长度', () => {
    const { WsFrameParser } = fresh(WS);
    const messages = [];
    const parser = new WsFrameParser({ onMessage: m => messages.push(m) });
    const payload = Buffer.alloc(300, 0x5A);
    parser.push(frame(0x2, payload));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].length, 300);
});

// ---------- 好友 GID 提取 ----------

async function buildGateMessage({ service, method, gids }) {
    const root = new protobuf.Root();
    await root.load([
        path.join(__dirname, '../src/proto/game.proto'),
        path.join(__dirname, '../src/proto/friendpb.proto'),
    ], { keepCase: true });
    const GateMessage = root.lookupType('gatepb.Message');
    const replyName = method === 'GetGameFriends' ? 'GetGameFriendsReply' : `${method}Reply`;
    const Reply = root.lookupType(`gamepb.friendpb.${replyName}`);
    const body = Reply.encode(Reply.create({ game_friends: gids.map(gid => ({ gid })) })).finish();
    return GateMessage.encode(GateMessage.create({
        meta: { service_name: service, method_name: method },
        body,
    })).finish();
}

test('好友 GID 提取器从 GetAllReply 解析完整好友列表', async () => {
    const { createFriendExtractor, getProtoPaths } = fresh(FRIEND);
    const errors = [];
    const extractor = await createFriendExtractor().catch((error) => {
        errors.push(error);
        return null;
    });
    assert.deepEqual(errors, [], `提取器初始化失败: ${errors[0] && errors[0].message}`);
    assert.deepEqual(extractor && Object.keys(extractor), ['handleMessage']);

    // proto 路径必须指向 core/src/proto（dev 与 dist 运行都要能找到）
    for (const protoPath of getProtoPaths()) {
        assert.ok(fs.existsSync(protoPath), `proto 不存在: ${protoPath}`);
    }

    const packet = await buildGateMessage({
        service: 'gamepb.friendpb.FriendService',
        method: 'GetAll',
        gids: [10001, 10002],
    });
    const result = extractor.handleMessage(Buffer.from(packet));
    assert.deepEqual(result, { gids: [10001, 10002], source: 'gamepb.friendpb.FriendService.GetAll', complete: true });

    const partial = await buildGateMessage({
        service: 'gamepb.friendpb.FriendService',
        method: 'GetGameFriends',
        gids: [10003],
    });
    const partialResult = extractor.handleMessage(Buffer.from(partial));
    assert.deepEqual(partialResult.gids, [10003]);
    assert.equal(partialResult.complete, false, '分批接口不应标记为完整列表');
});

test('好友 GID 提取器忽略非好友 RPC 与损坏数据', async () => {
    const { createFriendExtractor } = fresh(FRIEND);
    const extractor = await createFriendExtractor();

    const other = await buildGateMessage({
        service: 'gamepb.plantpb.PlantService',
        method: 'GetAll',
        gids: [1],
    });
    assert.equal(extractor.handleMessage(Buffer.from(other)), null);
    assert.equal(extractor.handleMessage(Buffer.alloc(0)), null);
    assert.equal(extractor.handleMessage(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])), null);
});
