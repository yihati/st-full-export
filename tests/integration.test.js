/**
 * 集成测试：真实 api.js + 编排层（chats.js / characters.js）走假 fetch，
 * 覆盖从端点请求到最终文件的完整链路（单元测试里的 mock 在更上层，无法发现
 * api 与编排层之间的签名/字段错配）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';
import { exportAllChats } from '../src/chats.js';
import { exportCharactersZip } from '../src/characters.js';
import { textOf, unzip } from './helpers/unzip.js';

const FIXED_DATE = new Date(2024, 5, 7, 8, 9, 10);
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function fakePng(seed) {
    const out = new Uint8Array(PNG_SIGNATURE.length + 32);
    out.set(PNG_SIGNATURE);
    for (let i = PNG_SIGNATURE.length; i < out.length; i += 1) {
        out[i] = (seed * 13 + i) % 256;
    }
    return out;
}

function createServer(state) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        const path = String(url);
        calls.push({
            path,
            method: options.method ?? 'GET',
            body: options.body ? JSON.parse(options.body) : null,
            headers: options.headers ?? null,
        });
        switch (path) {
            case '/api/characters/all':
                return jsonResponse(state.characters ?? []);
            case '/api/groups/all':
                return jsonResponse(state.groups ?? []);
            case '/api/characters/chats':
                return jsonResponse(state.chatsByAvatar?.[options.body ? JSON.parse(options.body).avatar_url : ''] ?? []);
            case '/api/chats/get': {
                const body = JSON.parse(options.body);
                return jsonResponse(state.payloads?.[body.file_name] ?? {});
            }
            case '/api/chats/group/get': {
                const body = JSON.parse(options.body);
                return jsonResponse(state.groupPayloads?.[body.id] ?? {});
            }
            case '/api/characters/get': {
                const body = JSON.parse(options.body);
                return jsonResponse(state.cards?.[body.avatar_url] ?? { error: true });
            }
            default:
                break;
        }
        if (path.startsWith('/characters/')) {
            const avatar = decodeURIComponent(path.slice('/characters/'.length));
            const png = state.pngs?.[avatar];
            if (!png) {
                return new Response('not found', { status: 404 });
            }
            return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
        }
        return new Response('not found', { status: 404 });
    };
    return { fetchImpl, calls };
}

function makeContext() {
    return {
        // 故意留空，让 api 走 HTTP 端点而不是 ctx 缓存
        characters: [],
        groups: [],
        extensionSettings: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }),
        saveSettingsDebounced: () => {},
    };
}

test('集成：全部对话导出的完整链路（真实 api + 假 fetch）', async () => {
    const server = createServer({
        characters: [{ name: '莫莫', avatar: '莫莫.png' }],
        groups: [{ id: 'g1', name: '测试群', members: ['莫莫.png'], chats: ['1700000000001'], chat_id: '1700000000001' }],
        chatsByAvatar: {
            '莫莫.png': [{
                file_name: '莫莫 - 2024-1-1 @12h00m00s 123ms.jsonl',
                file_id: '莫莫 - 2024-1-1 @12h00m00s 123ms',
                chat_items: 2,
                mes: '',
                last_mes: '2024-01-01T10:00:00.000Z',
                chat_metadata: { integrity: 'abc' },
            }],
        },
        payloads: {
            '莫莫 - 2024-1-1 @12h00m00s 123ms': [
                { user_name: 'user', character_name: '莫莫', chat_metadata: { integrity: 'abc', note: 'x' } },
                { name: '莫莫', is_user: false, mes: '你好', send_date: '2024-01-01T10:00:00.000Z', extra: {}, swipes: ['你好', 'hi'], swipe_id: 1 },
                { name: '用户', is_user: true, mes: '在吗', send_date: '2024-01-01T10:00:05.000Z' },
            ],
        },
        groupPayloads: {
            1700000000001: [
                { user_name: 'user', character_name: 'group', chat_metadata: { g: true } },
                { name: '莫莫', is_user: false, mes: '群消息', send_date: '2024-01-02T10:00:00.000Z' },
            ],
        },
    });

    const api = createApi({ ctx: makeContext(), fetchImpl: server.fetchImpl, retryDelay: 0 });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());

    assert.equal(result.fileName, 'sillytavern-chats-20240607-080910.json');
    assert.equal(payload.stats.characters, 1);
    assert.equal(payload.stats.groups, 1);
    assert.equal(payload.stats.chats, 2);
    assert.equal(payload.stats.messages, 3);
    assert.deepEqual(payload.chats.map((chat) => chat.kind), ['character', 'group']);

    const [characterChat, groupChat] = payload.chats;
    assert.equal(characterChat.file_id, '莫莫 - 2024-1-1 @12h00m00s 123ms');
    assert.deepEqual(characterChat.character, { name: '莫莫', avatar: '莫莫.png' });
    assert.deepEqual(characterChat.chat_metadata, { integrity: 'abc', note: 'x' });
    assert.equal(characterChat.messages.length, 2);
    assert.deepEqual(characterChat.messages[0].swipes, ['你好', 'hi']);
    assert.equal(groupChat.group.name, '测试群');
    assert.deepEqual(groupChat.chat_metadata, { g: true });

    // 每个 POST 都带 CSRF 头，且请求 body 符合 ST 端点约定。
    const posts = server.calls.filter((call) => call.method === 'POST');
    assert.ok(posts.length >= 4);
    for (const call of posts) {
        assert.equal(call.headers['X-CSRF-Token'], 'test-token');
    }
    const chatsGet = posts.find((call) => call.path === '/api/chats/get');
    assert.deepEqual(chatsGet.body, {
        avatar_url: '莫莫.png',
        file_name: '莫莫 - 2024-1-1 @12h00m00s 123ms',
        ch_name: '莫莫',
    });
});

test('集成：角色卡 ZIP 的完整链路（真实 api + 假 fetch，含中文文件名）', async () => {
    const png = fakePng(9);
    const server = createServer({
        characters: [
            { name: '莫莫', avatar: '莫莫.png', json_data: '{"spec":"chara_card_v2","data":{"name":"莫莫"}}' },
            { name: 'Zed', avatar: 'Zed.png' },
        ],
        cards: {
            'Zed.png': { json_data: '{"spec":"chara_card_v2","data":{"name":"Zed"}}' },
        },
        pngs: { '莫莫.png': png, 'Zed.png': fakePng(10) },
    });

    const api = createApi({ ctx: makeContext(), fetchImpl: server.fetchImpl, retryDelay: 0 });
    const result = await exportCharactersZip({ api, includeCardJson: true, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));

    // 角色名按 localeCompare('zh') 排序（本 ICU 下中文排在拉丁字母前）。
    assert.deepEqual(zip.names, [
        '莫莫.png',
        'Zed.png',
        'index.json',
        'README.txt',
        'json/莫莫.json',
        'json/Zed.json',
    ]);
    assert.deepEqual(new Uint8Array(zip.byName.get('莫莫.png').data), png);

    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.count, 2);
    assert.deepEqual(index.characters.map((entry) => entry.avatar), ['莫莫.png', 'Zed.png']);
    assert.equal(index.characters[0].json_file, 'json/莫莫.json');
    assert.equal(index.characters[1].json_file, 'json/Zed.json');

    // 静态 PNG 请求必须对文件名做 encodeURIComponent。
    const pngCalls = server.calls.filter((call) => call.path.startsWith('/characters/'));
    assert.ok(pngCalls.some((call) => call.path === `/characters/${encodeURIComponent('莫莫.png')}`));
    // 有 json_data 的卡不需要再请求 /api/characters/get。
    const cardCalls = server.calls.filter((call) => call.path === '/api/characters/get');
    assert.deepEqual(cardCalls.map((call) => call.body.avatar_url), ['Zed.png']);
});

test('集成：401 会以中文错误中断对话导出', async () => {
    const fetchImpl = async () => new Response('<html>login</html>', { status: 401 });
    const api = createApi({ ctx: makeContext(), fetchImpl, retryDelay: 0 });
    await assert.rejects(
        () => exportAllChats({ api, format: 'json', now: () => FIXED_DATE }),
        /未登录或会话已过期/,
    );
});

test('集成：聊天消息正文含 HTML 片段时正常导出（不误判登录页）', async () => {
    const server = createServer({
        characters: [{ name: 'Dev', avatar: 'Dev.png' }],
        chatsByAvatar: {
            'Dev.png': [{
                file_name: 'Dev Chat.jsonl',
                file_id: 'Dev Chat',
                chat_items: 2,
                mes: '',
                last_mes: '2024-01-01T00:00:00.000Z',
                chat_metadata: {},
            }],
        },
        payloads: {
            'Dev Chat': [
                { user_name: 'user', character_name: 'Dev', chat_metadata: { html: true } },
                {
                    name: 'Dev',
                    is_user: false,
                    mes: '看这段代码：<html><body>...</body></html>',
                    send_date: '2024-01-01T00:00:00.000Z',
                },
                {
                    name: '用户',
                    is_user: true,
                    mes: '<!doctype html>\n<html>hello</html>',
                    send_date: '2024-01-01T00:00:05.000Z',
                },
            ],
        },
    });

    const api = createApi({ ctx: makeContext(), fetchImpl: server.fetchImpl, retryDelay: 0 });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());

    assert.equal(payload.stats.failures, 0);
    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].messages[0].mes, '看这段代码：<html><body>...</body></html>');
    assert.equal(payload.chats[0].messages[1].mes, '<!doctype html>\n<html>hello</html>');
    assert.equal(payload.chats[0].message_count, 2);
});

test('集成：角色卡 PNG 返回 200 HTML 登录页 → auth reject，不生成空 ZIP', async () => {
    const server = createServer({
        characters: [{ name: 'Bad', avatar: 'Bad.png' }],
        pngs: {},
    });
    // 让 /characters/Bad.png 返回 200 + HTML，模拟登录页 / 反向代理页面。
    const fetchImpl = async (url, options) => {
        if (String(url).startsWith('/characters/')) {
            return new Response('<!doctype html><html>oops</html>', {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        return server.fetchImpl(url, options);
    };
    const api = createApi({ ctx: makeContext(), fetchImpl, retryDelay: 0 });
    await assert.rejects(
        () => exportCharactersZip({ api, now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth',
    );
});

test('集成：某个角色聊天列表 502 HTML 只记 failure，不中止整次导出', async () => {
    const server = createServer({
        characters: [
            { name: 'Bad', avatar: 'Bad.png' },
            { name: 'Good', avatar: 'Good.png' },
        ],
        chatsByAvatar: {
            'Bad.png': [],
            'Good.png': [{
                file_name: 'Good Chat.jsonl',
                file_id: 'Good Chat',
                chat_items: 1,
                mes: '',
                last_mes: '2024-01-01T00:00:00.000Z',
                chat_metadata: {},
            }],
        },
        payloads: {
            'Good Chat': [
                { user_name: 'user', character_name: 'Good', chat_metadata: {} },
                { name: 'Good', is_user: false, mes: 'ok', send_date: '2024-01-01T00:00:00.000Z' },
            ],
        },
    });
    const fetchImpl = async (url, options) => {
        if (String(url) === '/api/characters/chats') {
            const body = JSON.parse(options.body);
            if (body.avatar_url === 'Bad.png') {
                return new Response('<!doctype html><html>bad gateway</html>', {
                    status: 502,
                    headers: { 'Content-Type': 'text/html' },
                });
            }
        }
        return server.fetchImpl(url, options);
    };
    const api = createApi({ ctx: makeContext(), fetchImpl, retryDelay: 0, maxRetries: 0 });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());

    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].file_id, 'Good Chat');
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].file_name, 'Bad.png');
    assert.match(payload.failures[0].reason, /HTTP 502/);
    assert.ok(!payload.failures[0].reason.includes('<'));
});

test('集成：1.15 旧数据兼容（无 header、混合 send_date、空聊天、header_only）', async () => {
    const server = createServer({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        groups: [{
            id: 'g1',
            name: '旧群',
            members: [],
            chats: ['1700000000001'],
            chat_id: '1700000000001',
        }],
        chatsByAvatar: {
            'Momo.png': [
                { file_name: 'Old.jsonl', file_id: 'Old', chat_items: 2, mes: '', last_mes: '2024-1-2@12h00m00s000ms', chat_metadata: {} },
                // 1.15 的 getChatInfo 在文件为空/刚创建时可能给出数字 mtime。
                { file_name: 'Empty.jsonl', file_id: 'Empty', chat_items: 0, mes: '[The chat is empty]', last_mes: 1700000000000 },
                {
                    file_name: 'Header only.jsonl',
                    file_id: 'Header only',
                    chat_items: 0,
                    mes: '',
                    last_mes: '2024-1-3@12h00m00s000ms',
                    chat_metadata: { note: '仅元数据' },
                },
            ],
        },
        payloads: {
            // 旧聊天：首行就是普通消息，没有 header。
            Old: [
                { name: 'Momo', is_user: false, send_date: '2024-1-1@12h00m00s123ms', mes: '旧消息' },
                { name: '用户', is_user: true, send_date: '2024-05-01T10:00:00.000Z', mes: '新消息' },
            ],
            Empty: [],
            'Header only': [{ chat_metadata: { note: '仅元数据' }, user_name: 'unused', character_name: 'unused' }],
        },
        groupPayloads: { 1700000000001: [] },
    });

    const api = createApi({ ctx: makeContext(), fetchImpl: server.fetchImpl, retryDelay: 0 });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());

    // 群聊文件为空 + 角色空聊天 → skipped_empty 2；header_only 与旧聊天各 1 条。
    assert.equal(payload.stats.chats, 2);
    assert.equal(payload.stats.skipped_empty, 2);
    assert.equal(payload.stats.messages, 2);
    assert.deepEqual(payload.chats.map((chat) => chat.file_id), ['Header only', 'Old']);

    assert.equal(payload.chats[0].header_only, true);
    assert.deepEqual(payload.chats[0].messages, []);
    assert.deepEqual(payload.chats[0].chat_metadata, { note: '仅元数据' });

    // 旧聊天第一条消息未丢失，混合 send_date 原样保留。
    assert.equal(payload.chats[1].messages.length, 2);
    assert.equal(payload.chats[1].messages[0].mes, '旧消息');
    assert.equal(payload.chats[1].messages[0].send_date, '2024-1-1@12h00m00s123ms');
    assert.equal(payload.chats[1].messages[1].send_date, '2024-05-01T10:00:00.000Z');
});
