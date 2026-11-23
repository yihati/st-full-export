/**
 * 聊天编排测试：用 mock API 验证聚合、排序、群聊开关、metadata 剥离、
 * 失败不中断、进度回调、取消（预 abort）与三种格式的集成输出。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectGroupChatIds,
    compareChatEntries,
    compareGroupChatIds,
    exportAllChats,
    isMetadataLine,
    parseChatPayload,
} from '../src/chats.js';

const FIXED_DATE = new Date(2024, 0, 2, 3, 4, 5);

function metaLine(metadata = {}) {
    return {
        user_name: 'user',
        character_name: 'Momo',
        create_date: '2024-01-01T10:00:00.000Z',
        chat_metadata: metadata,
    };
}

function message(name, mes, options = {}) {
    return {
        name,
        is_user: name === '用户',
        is_system: false,
        send_date: options.send_date ?? '2024-01-01T10:00:00.000Z',
        mes,
        extra: options.extra ?? {},
        swipes: options.swipes ?? [mes],
        swipe_id: 0,
    };
}

function listing(fileName, lastMes, metadata = {}) {
    const fileId = String(fileName).replace(/\.jsonl$/i, '');
    return {
        file_name: fileName,
        file_id: fileId,
        chat_items: 1,
        mes: '',
        last_mes: lastMes,
        chat_metadata: metadata,
    };
}

function createApiMock(spec = {}) {
    const calls = { characters: 0, groups: 0, list: [], chat: [], groupChat: [] };
    return {
        calls,
        async getCharacters() {
            calls.characters += 1;
            if (spec.charactersError) {
                throw spec.charactersError;
            }
            return spec.characters ?? [];
        },
        async getGroups() {
            calls.groups += 1;
            if (spec.groupsError) {
                throw spec.groupsError;
            }
            return spec.groups ?? [];
        },
        async listCharacterChats(avatar) {
            calls.list.push(avatar);
            if (spec.listErrors?.[avatar]) {
                throw spec.listErrors[avatar];
            }
            if (spec.listNull?.includes(avatar)) {
                return null;
            }
            return spec.chatsByAvatar?.[avatar] ?? [];
        },
        async getCharacterChat(avatar, fileId, name) {
            calls.chat.push({ avatar, fileId, name });
            if (spec.chatErrors?.[fileId]) {
                throw spec.chatErrors[fileId];
            }
            return spec.payloads?.[fileId] ?? [];
        },
        async getGroupChat(id) {
            calls.groupChat.push(id);
            if (spec.groupErrors?.[id]) {
                throw spec.groupErrors[id];
            }
            return spec.groupPayloads?.[id] ?? [];
        },
    };
}

function baseSpec() {
    return {
        characters: [
            { name: 'Zed', avatar: 'Zed.png' },
            { name: 'Momo', avatar: 'Momo.png' },
        ],
        chatsByAvatar: {
            'Momo.png': [
                listing('Momo - old.jsonl', '2024-01-01T00:00:00.000Z', { integrity: 'old' }),
                listing('Momo - new.jsonl', '2024-02-01T00:00:00.000Z', { integrity: 'new' }),
            ],
            'Zed.png': [],
        },
        payloads: {
            'Momo - old': [metaLine({ integrity: 'old', note: 'n1' }), message('Momo', 'old hello')],
            'Momo - new': [metaLine({ integrity: 'new' }), message('Momo', 'new hello', { swipes: ['a', 'b'] })],
        },
    };
}

test('parseChatPayload 剥离 metadata 首行并保留消息原字段', () => {
    const payload = [metaLine({ integrity: 'x' }), message('Momo', 'hi', { extra: { k: 1 } })];
    const parsed = parseChatPayload(payload);
    assert.deepEqual(parsed.chat_metadata, { integrity: 'x' });
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].mes, 'hi');
    assert.deepEqual(parsed.messages[0].extra, { k: 1 });
    assert.equal(parsed.messages[0], payload[1], '消息对象应原样保留（同一引用）');
});

test('parseChatPayload 区分 invalid 与合法空聊天', () => {
    // 非数组、非 {messages} 结构 → invalid（调用方必须记失败）
    for (const payload of [{}, null, 'text', 42, { error: true }]) {
        const parsed = parseChatPayload(payload);
        assert.deepEqual(parsed.messages, []);
        assert.equal(parsed.invalid, true, `payload ${JSON.stringify(payload)} 应为 invalid`);
    }
    // 合法空结构 → invalid:false
    const emptyArray = parseChatPayload([]);
    assert.deepEqual(emptyArray.messages, []);
    assert.equal(emptyArray.invalid, false);

    const emptyWrapped = parseChatPayload({ chat_metadata: { a: 1 }, messages: [] });
    assert.deepEqual(emptyWrapped.messages, []);
    assert.equal(emptyWrapped.invalid, false);
    assert.equal(emptyWrapped.hasMetadataBlock, true);
});

test('parseChatPayload 兼容 { messages: [...] } 结构与顶层 chat_metadata', () => {
    const payload = {
        messages: [metaLine({ integrity: 'm' }), message('Momo', 'wrapped')],
    };
    const parsed = parseChatPayload(payload);
    assert.equal(parsed.hasHeader, true);
    assert.equal(parsed.invalid, false);
    assert.deepEqual(parsed.chat_metadata, { integrity: 'm' });
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].mes, 'wrapped');

    const withMeta = parseChatPayload({
        chat_metadata: { top: true },
        messages: [{ name: 'Momo', mes: '只有消息' }],
    });
    assert.deepEqual(withMeta.chat_metadata, { top: true });
    assert.equal(withMeta.messages.length, 1);
    assert.equal(withMeta.hasMetadataBlock, true);

    const emptyWrapped = parseChatPayload({ chat_metadata: { only: true }, messages: [] });
    assert.deepEqual(emptyWrapped.messages, []);
    assert.equal(emptyWrapped.hasHeader, false);
    assert.equal(emptyWrapped.hasMetadataBlock, true);
});

test('旧聊天没有 header 时不能丢失第一条消息', () => {
    const oldChat = [
        { name: 'Momo', is_user: false, send_date: '2024-1-1@12h00m00s123ms', mes: '第一条' },
        { name: '用户', is_user: true, send_date: '2024-1-1@12h00m10s000ms', mes: '第二条' },
    ];
    const parsed = parseChatPayload(oldChat);
    assert.equal(parsed.hasHeader, false);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].mes, '第一条');
    assert.equal(parsed.messages[1].mes, '第二条');
});

test('metadata 行识别宽容但不会把带 mes 的消息误判', () => {
    assert.equal(isMetadataLine(metaLine()), true);
    assert.equal(isMetadataLine({ chat_metadata: { a: 1 } }), true);
    assert.equal(isMetadataLine({ user_name: 'u', character_name: 'c' }), true);
    assert.equal(isMetadataLine({ create_date: '2024-01-01T00:00:00.000Z' }), true);
    assert.equal(isMetadataLine({ mes: 'hello', chat_metadata: { a: 1 } }), false);
    assert.equal(isMetadataLine({ name: 'Momo', mes: 'x' }), false);
    assert.equal(isMetadataLine({ name: 'Momo' }), false);
    assert.equal(isMetadataLine(null), false);

    const both = [message('Momo', 'first'), metaLine({ late: true })];
    const parsed = parseChatPayload(both);
    assert.equal(parsed.messages.length, 2, '首项不是 metadata 时不能剥离');
    assert.deepEqual(parsed.chat_metadata, {});
});

test('collectGroupChatIds 合并 chats 与 chat_id 并去重', () => {
    assert.deepEqual(
        collectGroupChatIds({ chats: ['1', '2'], chat_id: '2' }),
        ['1', '2'],
    );
    assert.deepEqual(collectGroupChatIds({ chats: ['1'], chat_id: '3' }), ['1', '3']);
    assert.deepEqual(collectGroupChatIds({}), []);
    assert.deepEqual(collectGroupChatIds({ chats: ['', null, '4'] }), ['4']);
});

test('collectGroupChatIds 兼容 chats 元素为对象，并剥离 .jsonl 后缀', () => {
    assert.deepEqual(
        collectGroupChatIds({
            chats: [
                { file_name: '1700000000001.jsonl' },
                { file_id: '1700000000002' },
                { id: '1700000000003' },
                { chat_id: '1700000000004' },
                '1700000000005.jsonl',
                1700000000005,
                null,
                {},
            ],
            chat_id: '1700000000006',
        }),
        [
            '1700000000001',
            '1700000000002',
            '1700000000003',
            '1700000000004',
            '1700000000005',
            '1700000000006',
        ],
    );
    // 对象完全没有可用字段时不能被转成 "[object Object]"。
    assert.deepEqual(collectGroupChatIds({ chats: [{ foo: 'bar' }], chat_id: '7' }), ['7']);
    // 1.15 的 /api/groups/all 是原始 group JSON，可能两者都没有：退回 group.id。
    assert.deepEqual(collectGroupChatIds({ id: 123, name: 'G' }), ['123']);
    assert.deepEqual(collectGroupChatIds({ id: 'G', chats: [] }), ['G']);
    assert.deepEqual(collectGroupChatIds({ id: 'G', chats: [{}], chat_id: null }), ['G']);
    // 有 chats 时不应再额外加 group.id。
    assert.deepEqual(collectGroupChatIds({ id: 'G', chats: ['c1'] }), ['c1']);
});

test('群组只有 id（无 chats/chat_id）时按 group.id 读取群聊', async () => {
    const api = createApiMock({
        characters: [],
        groups: [{ id: 123, name: 'G' }],
        groupPayloads: {
            123: [metaLine({ only: 'id' }), message('a', 'hello from group id')],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });

    assert.deepEqual(api.calls.groupChat, ['123'], '应按 group.id 请求 /api/chats/group/get');
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].kind, 'group');
    assert.equal(payload.chats[0].file_id, '123');
    assert.equal(payload.chats[0].file_name, '123.jsonl');
    assert.equal(payload.chats[0].group.id, '123');
    assert.equal(payload.chats[0].messages[0].mes, 'hello from group id');
    assert.equal(payload.stats.groups, 1);
});

test('群聊 chats 元素为对象时仍能正确读取群聊', async () => {
    const api = createApiMock({
        characters: [],
        groups: [{
            id: 'g1',
            name: '对象聊天',
            members: [],
            chats: [
                { file_name: '1700000000011.jsonl' },
                { id: '1700000000012' },
            ],
            chat_id: '1700000000013',
        }],
        groupPayloads: {
            1700000000011: [metaLine({ g: 11 }), message('a', 'one')],
            1700000000012: [metaLine({ g: 12 }), message('b', 'two')],
            1700000000013: [metaLine({ g: 13 }), message('c', 'three')],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    assert.deepEqual(api.calls.groupChat, ['1700000000013', '1700000000012', '1700000000011']);
    const payload = JSON.parse(await result.blob.text());
    assert.deepEqual(payload.chats.map((chat) => chat.file_id), [
        '1700000000013',
        '1700000000012',
        '1700000000011',
    ]);
    assert.equal(payload.stats.chats, 3);
});

test('compareChatEntries：last_mes 倒序，无效时间排后，再按文件名', () => {
    const newer = { file_name: 'b.jsonl', last_mes: '2024-02-01T00:00:00.000Z' };
    const older = { file_name: 'a.jsonl', last_mes: '2024-01-01T00:00:00.000Z' };
    const invalidA = { file_name: 'no-a.jsonl', last_mes: 'not-a-date' };
    const invalidB = { file_name: 'no-b.jsonl', last_mes: null };
    const sorted = [invalidB, older, invalidA, newer].sort(compareChatEntries);
    assert.deepEqual(sorted.map((entry) => entry.file_name), [
        'b.jsonl',
        'a.jsonl',
        'no-a.jsonl',
        'no-b.jsonl',
    ]);
});

test('导出聚合：metadata 剥离、消息不丢字段、排序稳定、stats 正确', async () => {
    const api = createApiMock(baseSpec());
    const result = await exportAllChats({
        api,
        format: 'json',
        now: () => FIXED_DATE,
    });

    assert.equal(result.fileName, 'sillytavern-chats-20240102-030405.json');
    assert.equal(result.blob.type, 'application/json;charset=utf-8');

    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.format, 'sillytavern-all-chats');
    assert.equal(payload.format_version, 1);
    assert.equal(payload.exported_at, FIXED_DATE.toISOString());
    assert.deepEqual(payload.stats, {
        characters: 2,
        groups: 0,
        chats: 2,
        messages: 2,
        failures: 0,
        skipped_empty: 0,
    });
    assert.equal(payload.chats.length, 2);

    // 角色按名字排序（Momo 在 Zed 前），同一角色内 last_mes 倒序（new 在 old 前）。
    assert.deepEqual(payload.chats.map((chat) => chat.file_id), ['Momo - new', 'Momo - old']);
    const first = payload.chats[0];
    assert.equal(first.kind, 'character');
    assert.deepEqual(first.character, { name: 'Momo', avatar: 'Momo.png' });
    assert.equal(first.group, null);
    assert.equal(first.file_name, 'Momo - new.jsonl');
    assert.deepEqual(first.chat_metadata, { integrity: 'new' });
    assert.equal(first.message_count, 1);
    assert.equal(first.last_message, 'new hello');
    assert.deepEqual(first.messages[0].swipes, ['a', 'b']);
    assert.equal(first.messages[0].swipe_id, 0);
    assert.equal(payload.failures.length, 0);

    // 读取聊天时传入的是 file_id（不带 .jsonl）和角色名。
    assert.deepEqual(api.calls.chat[0].fileId, 'Momo - new');
    assert.equal(api.calls.chat[0].name, 'Momo');
});

test('聊天列表项缺少 file_id 时用 file_name 去掉 .jsonl 兜底', async () => {
    const api = createApiMock({
        characters: [{ name: 'Solo', avatar: 'Solo.png' }],
        chatsByAvatar: {
            'Solo.png': [{ file_name: 'No Id.jsonl', chat_items: 1, last_mes: null }],
        },
        payloads: { 'No Id': [metaLine(), message('Solo', 'x')] },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    assert.equal(api.calls.chat[0].fileId, 'No Id');
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats[0].file_id, 'No Id');
    assert.equal(payload.chats[0].file_name, 'No Id.jsonl');
});

test('空聊天（0 消息且无 metadata）被跳过并计入 skipped_empty', async () => {
    const emptyEntry = (fileName, lastMes) => ({
        file_name: fileName,
        file_id: fileName.replace(/\.jsonl$/, ''),
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: lastMes,
        chat_metadata: {},
    });
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [
                emptyEntry('Empty Chat.jsonl', '2024-03-01T00:00:00.000Z'),
                emptyEntry('Empty Array.jsonl', '2024-02-01T00:00:00.000Z'),
            ],
        },
        payloads: {
            'Empty Chat': [],
            'Empty Array': [],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 0);
    assert.equal(payload.stats.chats, 0);
    assert.equal(payload.stats.skipped_empty, 2);
    assert.equal(payload.stats.failures, 0);
});

test('只有 header 且 metadata 非空：保留为 header_only 记录', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [{
                file_name: 'Header Only.jsonl',
                file_id: 'Header Only',
                chat_items: 0,
                mes: '[The message is empty]',
                last_mes: '2024-03-01T00:00:00.000Z',
                chat_metadata: { note: '只有元数据' },
            }],
        },
        payloads: {
            'Header Only': [{
                chat_metadata: { note: '只有元数据' },
                user_name: 'unused',
                character_name: 'unused',
            }],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].header_only, true);
    assert.deepEqual(payload.chats[0].messages, []);
    assert.equal(payload.chats[0].message_count, 0);
    assert.deepEqual(payload.chats[0].chat_metadata, { note: '只有元数据' });
    assert.equal(payload.stats.skipped_empty, 0);
    assert.equal(payload.stats.failures, 0);
});

test('异常空响应（{}）不能被当成空聊天跳过', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [{
                file_name: 'Broken.jsonl',
                file_id: 'Broken',
                chat_items: 0,
                mes: '',
                last_mes: '2024-03-01T00:00:00.000Z',
                chat_metadata: {},
            }],
        },
        payloads: { Broken: {} },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 0);
    assert.equal(payload.stats.skipped_empty, 0, 'invalid 不能计入 skipped_empty');
    assert.equal(payload.failures.length, 1);
    assert.match(payload.failures[0].reason, /异常响应/);
});

test('列表 chat_items 显示有消息但读取为空 → 记失败，不计入 skipped_empty', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [{
                file_name: 'Lost.jsonl',
                file_id: 'Lost',
                chat_items: 5,
                mes: '',
                last_mes: '2024-03-01T00:00:00.000Z',
                chat_metadata: {},
            }],
        },
        payloads: { Lost: [] },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 0);
    assert.equal(payload.stats.skipped_empty, 0);
    assert.equal(payload.failures.length, 1);
    assert.match(payload.failures[0].reason, /索引显示有消息但读取为空/);
});

test('列表 mes 预览证明有消息但读取为空 → 记失败；占位符不算证据', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [
                {
                    file_name: 'Preview Evidence.jsonl',
                    file_id: 'Preview Evidence',
                    chat_items: 0,
                    mes: 'last words',
                    last_mes: '2024-03-01T00:00:00.000Z',
                    chat_metadata: {},
                },
                {
                    file_name: 'Placeholder.jsonl',
                    file_id: 'Placeholder',
                    chat_items: 0,
                    mes: '[The message is empty]',
                    last_mes: '2024-02-01T00:00:00.000Z',
                    chat_metadata: {},
                },
            ],
        },
        payloads: {
            'Preview Evidence': [],
            Placeholder: [],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].file_name, 'Preview Evidence.jsonl');
    assert.equal(payload.stats.skipped_empty, 1, '占位符聊天应计入 skipped_empty');
});

test('{messages:[...]} 结构与合法 JSON 文本正常导出', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [{
                file_name: 'Wrapped.jsonl',
                file_id: 'Wrapped',
                chat_items: 1,
                mes: '',
                last_mes: '2024-03-01T00:00:00.000Z',
                chat_metadata: {},
            }],
        },
        payloads: {
            Wrapped: { messages: [message('Momo', '嵌套消息')] },
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].messages[0].mes, '嵌套消息');
});

test('聊天列表返回 null：有聊天证据记 failure，无证据静默当无聊天', async () => {
    const api = createApiMock({
        characters: [
            { name: 'HasChats', avatar: 'HasChats.png', chat_size: 12345, date_last_chat: 1700000000000 },
            { name: 'NoChats', avatar: 'NoChats.png', chat_size: 0, date_last_chat: 0 },
        ],
        listNull: ['HasChats.png', 'NoChats.png'],
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].file_name, 'HasChats.png');
    assert.match(payload.failures[0].reason, /聊天列表失败/);
    assert.equal(payload.stats.chats, 0);
});

test('群聊 id 按时间从新到旧排序（humanized / 数字）', () => {
    const ids = [
        '2024-1-1@12h00m00s000ms',
        '2023-12-31@10h00m00s000ms',
        '2024-7-12@01h31m37s',
    ];
    assert.deepEqual([...ids].sort(compareGroupChatIds), [
        '2024-7-12@01h31m37s',
        '2024-1-1@12h00m00s000ms',
        '2023-12-31@10h00m00s000ms',
    ]);
    assert.deepEqual(
        ['1700000000001', '1700000000003', '1700000000002'].sort(compareGroupChatIds),
        ['1700000000003', '1700000000002', '1700000000001'],
    );
});

test('旧格式聊天（无 header）首条消息保留，mixed send_date 原样导出', async () => {
    const api = createApiMock({
        characters: [{ name: 'Old', avatar: 'Old.png' }],
        chatsByAvatar: {
            'Old.png': [listing('Old Chat.jsonl', '2024-1-1@12h00m00s123ms')],
        },
        payloads: {
            'Old Chat': [
                { name: 'Old', is_user: false, send_date: '2024-1-1@12h00m00s123ms', mes: '旧消息一' },
                { name: '用户', is_user: true, send_date: '2024-05-01T10:00:00.000Z', mes: '新消息二' },
            ],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 1);
    assert.equal(payload.chats[0].messages.length, 2);
    assert.equal(payload.chats[0].messages[0].mes, '旧消息一');
    assert.equal(payload.chats[0].messages[0].send_date, '2024-1-1@12h00m00s123ms');
    assert.equal(payload.chats[0].messages[1].send_date, '2024-05-01T10:00:00.000Z');
    assert.equal(payload.chats[0].message_count, 2);
});

test('humanized last_mes 也能正确参与排序', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: {
            'Momo.png': [
                listing('Old.jsonl', '2024-1-1@12h00m00s000ms'),
                listing('New.jsonl', '2024-2-1@09h30m00s000ms'),
            ],
        },
        payloads: {
            'Old': [message('Momo', 'old')],
            'New': [message('Momo', 'new')],
        },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.deepEqual(payload.chats.map((chat) => chat.file_id), ['New', 'Old']);
});

test('群聊：chats + chat_id 合并、按 id 倒序、记录结构正确；includeGroupChats=false 时不请求', async () => {
    const groups = [{
        id: 'g1',
        name: 'Beta',
        members: ['a.png', 'b.png'],
        chats: ['1700000000001', '1700000000002'],
        chat_id: '1700000000003',
    }];
    const groupPayloads = {
        1700000000001: [metaLine({ g: 1 }), message('a', 'one')],
        1700000000002: [metaLine({ g: 2 }), message('b', 'two')],
        1700000000003: [metaLine({ g: 3 }), message('c', 'three')],
    };
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        chatsByAvatar: { 'Momo.png': [] },
        groups,
        groupPayloads,
    });

    const result = await exportAllChats({ api, format: 'json', includeGroupChats: true, now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.stats.groups, 1);
    assert.equal(payload.chats.length, 3);
    assert.deepEqual(payload.chats.map((chat) => chat.file_id), [
        '1700000000003',
        '1700000000002',
        '1700000000001',
    ]);
    const record = payload.chats[0];
    assert.equal(record.kind, 'group');
    assert.equal(record.character, null);
    assert.deepEqual(record.group, { id: 'g1', name: 'Beta', members: ['a.png', 'b.png'] });
    assert.equal(record.file_name, '1700000000003.jsonl');
    assert.deepEqual(record.chat_metadata, { g: 3 });
    assert.equal(record.messages[0].mes, 'three');

    const withoutGroups = createApiMock({
        ...baseSpec(),
        groups,
        groupPayloads,
    });
    const resultWithout = await exportAllChats({
        api: withoutGroups,
        format: 'json',
        includeGroupChats: false,
        now: () => FIXED_DATE,
    });
    const payloadWithout = JSON.parse(await resultWithout.blob.text());
    assert.equal(withoutGroups.calls.groups, 0);
    assert.equal(payloadWithout.stats.groups, 0);
    assert.equal(payloadWithout.chats.every((chat) => chat.kind === 'character'), true);
});

test('角色列表为空但有群聊时仍能导出群聊', async () => {
    const api = createApiMock({
        characters: [],
        groups: [{ id: 'g9', name: '空角色群', members: [], chats: ['99'] }],
        groupPayloads: { 99: [metaLine(), message('x', 'group only')] },
    });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.stats.characters, 0);
    assert.equal(payload.stats.chats, 1);
    assert.equal(payload.chats[0].group.name, '空角色群');
});

test('单条聊天失败只记入 failures，不中断其他聊天', async () => {
    const spec = baseSpec();
    spec.chatErrors = { 'Momo - old': new Error('HTTP 500：服务器错误') };
    const api = createApiMock(spec);
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });

    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 1, '失败的那条应被跳过');
    assert.equal(payload.chats[0].file_id, 'Momo - new');
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].scope, 'character');
    assert.equal(payload.failures[0].name, 'Momo');
    assert.equal(payload.failures[0].file_name, 'Momo - old.jsonl');
    assert.match(payload.failures[0].reason, /HTTP 500/);
    assert.equal(payload.stats.failures, 1);
});

function authFailure(message = '会话已过期') {
    return Object.assign(new Error(message), { kind: 'auth', status: 401 });
}

test('ctx.characters 非空但聊天列表返回 auth → 整体 reject（不再产出空文件）', async () => {
    const spec = baseSpec();
    spec.listErrors = { 'Momo.png': authFailure() };
    const api = createApiMock(spec);
    await assert.rejects(
        () => exportAllChats({ api, format: 'json', now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth' && error.status === 401,
    );
});

test('单条聊天读取返回 auth → 整体 reject', async () => {
    const spec = baseSpec();
    spec.chatErrors = { 'Momo - new': authFailure() };
    const api = createApiMock(spec);
    await assert.rejects(
        () => exportAllChats({ api, format: 'json', now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth',
    );
});

test('群组列表 / 聊天列表返回 csrf → 整体 reject', async () => {
    const groupsSpec = baseSpec();
    groupsSpec.groupsError = authFailure();
    await assert.rejects(
        () => exportAllChats({ api: createApiMock(groupsSpec), format: 'json', now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth',
    );

    const csrfSpec = baseSpec();
    csrfSpec.listErrors = {
        'Momo.png': Object.assign(new Error('CSRF'), { kind: 'csrf', status: 403 }),
    };
    await assert.rejects(
        () => exportAllChats({ api: createApiMock(csrfSpec), format: 'json', now: () => FIXED_DATE }),
        (error) => error?.kind === 'csrf' && error.status === 403,
    );
});

test('非 CSRF 的 403（如 1.19 非法文件名）只记 failure，不中止整次导出', async () => {
    const spec = baseSpec();
    spec.listErrors = {
        'Zed.png': Object.assign(new Error('Forbidden'), { status: 403, kind: 'http' }),
    };
    const result = await exportAllChats({ api: createApiMock(spec), format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 2, '其他角色应继续导出');
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].file_name, 'Zed.png');
});

test('普通 500 单项失败仍只记 failure，整体继续', async () => {
    const spec = baseSpec();
    spec.listErrors = { 'Zed.png': Object.assign(new Error('HTTP 500'), { status: 500 }) };
    const result = await exportAllChats({ api: createApiMock(spec), format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 2);
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.stats.failures, 1);
});

test('聊天列表读取失败记入 failures 且不影响其他角色', async () => {
    const spec = baseSpec();
    spec.listErrors = { 'Zed.png': new Error('HTTP 500：服务器错误') };
    const api = createApiMock(spec);
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 2);
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].scope, 'character');
    assert.equal(payload.failures[0].file_name, 'Zed.png');
    assert.match(payload.failures[0].reason, /聊天列表失败/);
});

test('群组列表读取失败记入 failures，角色聊天照常导出', async () => {
    const spec = baseSpec();
    spec.groupsError = new Error('HTTP 500：服务器错误');
    const api = createApiMock(spec);
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.equal(payload.chats.length, 2);
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].scope, 'group');
    assert.match(payload.failures[0].reason, /群组列表失败/);
});

test('角色列表读取失败直接抛出中文错误（这是致命错误）', async () => {
    const api = createApiMock({ charactersError: new Error('HTTP 500') });
    await assert.rejects(
        () => exportAllChats({ api, format: 'json', now: () => FIXED_DATE }),
        /读取角色列表失败/,
    );
});

test('进度回调：先角色列表、再聊天列表/内容，最后 done', async () => {
    const events = [];
    const api = createApiMock(baseSpec());
    await exportAllChats({
        api,
        format: 'json',
        now: () => FIXED_DATE,
        onProgress: (event) => events.push(event),
    });
    assert.ok(events.length > 0);
    assert.equal(events[0].phase, 'characters');
    const phases = events.map((event) => event.phase);
    assert.ok(phases.includes('chats'));
    assert.equal(phases.at(-1), 'done');
    const readEvents = events.filter((event) => event.phase === 'chats' && event.total === 2);
    assert.ok(readEvents.length >= 2, '读取聊天内容阶段应逐条上报进度');
    const currents = readEvents.map((event) => event.current).filter((value) => value > 0);
    assert.deepEqual(currents, [...currents].sort((a, b) => a - b), 'current 应单调递增');
});

test('预取消：抛出 AbortError 且不发起任何请求', async () => {
    const api = createApiMock(baseSpec());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => exportAllChats({ api, format: 'json', signal: controller.signal, now: () => FIXED_DATE }),
        (error) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(api.calls.characters, 0);
    assert.equal(api.calls.list.length, 0);
});

test('JSONL 输出：行数 = 聊天数且每行可解析；TXT 含角色名与统计', async () => {
    const jsonlApi = createApiMock(baseSpec());
    const jsonlResult = await exportAllChats({ api: jsonlApi, format: 'jsonl', now: () => FIXED_DATE });
    assert.equal(jsonlResult.fileName, 'sillytavern-chats-20240102-030405.jsonl');
    const lines = (await jsonlResult.blob.text()).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(parsed.map((chat) => chat.file_id), ['Momo - new', 'Momo - old']);

    const txtApi = createApiMock(baseSpec());
    const txtResult = await exportAllChats({ api: txtApi, format: 'txt', now: () => FIXED_DATE });
    assert.equal(txtResult.fileName, 'sillytavern-chats-20240102-030405.txt');
    const text = await txtResult.blob.text();
    assert.match(text, /\[角色\] Momo（Momo\.png）/);
    assert.match(text, /new hello/);
    assert.match(text, /消息数：1/);
    assert.match(text, /统计：角色 2 个，群聊 0 个，聊天 2 条，消息 2 条，失败 0 项/);
});

test('空库导出：chats 为空数组、stats 全 0、仍生成合法文件', async () => {
    const api = createApiMock({ characters: [], groups: [] });
    const result = await exportAllChats({ api, format: 'json', now: () => FIXED_DATE });
    const payload = JSON.parse(await result.blob.text());
    assert.deepEqual(payload.chats, []);
    assert.deepEqual(payload.failures, []);
    assert.deepEqual(payload.stats, {
        characters: 0,
        groups: 0,
        chats: 0,
        messages: 0,
        failures: 0,
        skipped_empty: 0,
    });
});
