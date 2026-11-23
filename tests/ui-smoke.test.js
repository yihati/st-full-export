/**
 * UI 冒烟测试：用最小化的假 DOM 挂载设置面板，点击真实按钮走完整导出链路
 * （真实 api.js + 编排层 + 假 fetch），验证按钮禁用/恢复、状态文字、失败详情
 * 与最终下载的 Blob。无需 jsdom。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mountUi } from '../src/ui.js';
import { textOf, unzip } from './helpers/unzip.js';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakePng(seed) {
    const out = new Uint8Array(PNG_SIGNATURE.length + 24);
    out.set(PNG_SIGNATURE);
    for (let i = PNG_SIGNATURE.length; i < out.length; i += 1) {
        out[i] = (seed + i) % 256;
    }
    return out;
}

function parseIds(html) {
    const ids = new Set();
    for (const match of String(html).matchAll(/id="([^"]+)"/g)) {
        ids.add(match[1]);
    }
    return ids;
}

function createFakeElement(tagName = 'div') {
    const listeners = new Map();
    const classes = new Set();
    const element = {
        tagName: String(tagName).toUpperCase(),
        children: [],
        style: {},
        dataset: {},
        attributes: {},
        disabled: false,
        value: '',
        checked: false,
        textContent: '',
        title: '',
        _innerHTML: '',
        _ids: new Set(),
        _elements: new Map(),
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !classes.has(name) : Boolean(force);
                if (on) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
                return on;
            },
        },
        get innerHTML() {
            return element._innerHTML;
        },
        set innerHTML(value) {
            element._innerHTML = String(value);
            element._ids = parseIds(element._innerHTML);
        },
        querySelector(selector) {
            if (typeof selector === 'string' && selector.startsWith('#')) {
                const id = selector.slice(1);
                if (!element._elements.has(id) && element._ids.has(id)) {
                    element._elements.set(id, createFakeElement('div'));
                }
                return element._elements.get(id) ?? null;
            }
            return null;
        },
        appendChild(child) {
            element.children.push(child);
            return child;
        },
        append(...nodes) {
            element.children.push(...nodes);
        },
        remove() {},
        replaceChildren(...nodes) {
            element.children = nodes;
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) {
                listeners.set(type, []);
            }
            listeners.get(type).push(handler);
        },
        removeEventListener() {},
        setAttribute(name, value) {
            element.attributes[name] = value;
        },
        getAttribute(name) {
            return element.attributes[name] ?? null;
        },
        click() {},
        listeners,
    };
    return element;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createFakeFetch(state) {
    return async (url, options = {}) => {
        const path = String(url);
        const body = options.body ? JSON.parse(options.body) : null;
        switch (path) {
            case '/api/characters/all':
                return jsonResponse(state.characters ?? []);
            case '/api/groups/all':
                return jsonResponse(state.groups ?? []);
            case '/api/characters/chats':
                return jsonResponse(state.chatsByAvatar?.[body?.avatar_url] ?? []);
            case '/api/chats/get':
                return jsonResponse(state.payloads?.[body?.file_name] ?? {});
            case '/api/chats/group/get':
                return jsonResponse(state.groupPayloads?.[body?.id] ?? {});
            default:
                break;
        }
        if (path.startsWith('/characters/')) {
            const avatar = decodeURIComponent(path.slice('/characters/'.length));
            const png = state.pngs?.[avatar];
            return png
                ? new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } })
                : new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
    };
}

function setupEnvironment(state) {
    const previous = {
        document: globalThis.document,
        URL: globalThis.URL,
        fetch: globalThis.fetch,
        setTimeout: globalThis.setTimeout,
        console: { log: console.log, info: console.info, error: console.error, debug: console.debug },
    };
    const downloads = [];
    const documentRef = {
        readyState: 'complete',
        body: createFakeElement('body'),
        createElement: (tag) => createFakeElement(tag),
        querySelector: () => null,
        addEventListener() {},
    };
    globalThis.document = documentRef;
    globalThis.URL = {
        createObjectURL: (blob) => {
            downloads.push(blob);
            return `blob:fake-${downloads.length}`;
        },
        revokeObjectURL: () => {},
    };
    globalThis.fetch = createFakeFetch(state);
    // saveBlob 里的 10s revoke 定时器会拖慢测试：立即执行（revoke 在假 URL 上是空操作）。
    const realSetTimeout = previous.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
        if (Number(ms) >= 5000) {
            fn(...args);
            return 0;
        }
        return realSetTimeout(fn, ms, ...args);
    };
    // 导出成功/失败会打日志，测试期间静音，保持输出干净。
    console.log = console.info = console.error = console.debug = () => {};

    const host = createFakeElement('div');
    host.ownerDocument = documentRef;
    const ctx = {
        characters: [],
        groups: [],
        extensionSettings: {},
        saved: 0,
        savedChat: 0,
        generating: false,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'ui-token' }),
        saveSettingsDebounced() {
            this.saved += 1;
        },
        async saveChat() {
            this.savedChat += 1;
        },
    };
    const mounted = mountUi({ host, resolveContext: async () => ctx });
    const root = host.children[0];
    return {
        host,
        root,
        ctx,
        mounted,
        document: documentRef,
        downloads,
        restore() {
            globalThis.document = previous.document;
            globalThis.URL = previous.URL;
            globalThis.fetch = previous.fetch;
            globalThis.setTimeout = previous.setTimeout;
            Object.assign(console, previous.console);
        },
    };
}

async function waitFor(predicate, timeoutMs = 4000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
}

function click(element) {
    const handlers = element.listeners.get('click') ?? [];
    assert.ok(handlers.length > 0, '按钮应绑定 click 处理器');
    handlers[0]();
}

test('UI 冒烟：挂载面板、设置持久化、导出全部对话并下载 Blob', async () => {
    const env = setupEnvironment({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        groups: [],
        chatsByAvatar: {
            'Momo.png': [{
                file_name: 'Momo A.jsonl',
                file_id: 'Momo A',
                chat_items: 1,
                mes: '',
                last_mes: '2024-01-01T00:00:00.000Z',
                chat_metadata: { m: 1 },
            }],
        },
        payloads: {
            'Momo A': [
                { user_name: 'user', character_name: 'Momo', chat_metadata: { m: 1 } },
                { name: 'Momo', is_user: false, mes: '你好', send_date: '2024-01-01T00:00:00.000Z' },
            ],
        },
    });
    try {
        const root = env.root;
        // 等待 mountUi 内部的 getContext() 完成（异步微任务）。
        assert.ok(await waitFor(() => Boolean(env.ctx.extensionSettings.st_full_export)), '设置对象应写入 extensionSettings');
        const status = root.querySelector('#stfe-status');
        const formatSelect = root.querySelector('#stfe-chat-format');
        const includeGroups = root.querySelector('#stfe-include-group-chats');
        const includeCardJson = root.querySelector('#stfe-include-card-json');
        const exportChats = root.querySelector('#stfe-export-chats');
        const exportCards = root.querySelector('#stfe-export-cards');
        const failuresBox = root.querySelector('#stfe-failures');

        assert.equal(formatSelect.value, 'json');
        assert.equal(includeGroups.checked, true);
        assert.equal(includeCardJson.checked, false);

        // 设置变更写回 extension_settings.st_full_export。
        formatSelect.value = 'jsonl';
        formatSelect.listeners.get('change')[0]();
        assert.equal(env.ctx.extensionSettings.st_full_export.chatFormat, 'jsonl');
        assert.equal(env.ctx.saved, 1);
        formatSelect.value = 'json';
        formatSelect.listeners.get('change')[0]();

        click(exportChats);
        const finished = await waitFor(() => status.textContent.includes('完成') || status.textContent.includes('失败'));
        assert.ok(finished, `导出应结束，当前状态：${status.textContent}`);
        assert.match(status.textContent, /完成：1 条聊天/);
        assert.match(status.textContent, /sillytavern-chats-\d{8}-\d{6}\.json/);
        assert.equal(exportChats.disabled, false, '结束后按钮应恢复');
        assert.equal(exportCards.disabled, false);
        assert.equal(failuresBox.classList.contains('stfe-hidden'), true, '无失败时隐藏失败详情');

        assert.equal(env.downloads.length, 1);
        const payload = JSON.parse(await env.downloads[0].text());
        assert.equal(payload.format, 'sillytavern-all-chats');
        assert.equal(payload.chats[0].file_id, 'Momo A');
        assert.equal(payload.chats[0].messages[0].mes, '你好');
        // 导出前调用过一次 ctx.saveChat()。
        assert.equal(env.ctx.savedChat, 1);
        // 常驻范围提示存在。
        assert.ok(root.querySelector('#stfe-scope'), '应有常驻的导出范围提示');
    } finally {
        env.restore();
    }
});

test('UI 冒烟：生成中提示（ctx.generating 与 body.dataset 回退）', async () => {
    const env = setupEnvironment({ characters: [], groups: [] });
    try {
        const root = env.root;
        assert.ok(await waitFor(() => Boolean(env.ctx.extensionSettings.st_full_export)));
        const status = root.querySelector('#stfe-status');
        const warning = root.querySelector('#stfe-warning');
        const exportChats = root.querySelector('#stfe-export-chats');

        // 路径一：ctx.generating === true（1.19 可能提供）。
        env.ctx.generating = true;
        click(exportChats);
        assert.ok(await waitFor(() => status.textContent.includes('完成') || status.textContent.includes('失败')));
        assert.match(warning.textContent, /当前有生成任务/);
        assert.equal(warning.classList.contains('stfe-hidden'), false);
        assert.equal(env.ctx.savedChat, 1);

        // 路径二：1.15 的 getContext 没有 generating，回退到 body.dataset.generating。
        env.ctx.generating = false;
        env.document.body.dataset.generating = 'true';
        status.textContent = '';
        warning.textContent = '';
        click(exportChats);
        assert.ok(await waitFor(() => warning.textContent.includes('当前有生成任务') && status.textContent.includes('完成')));
        env.document.body.dataset.generating = 'false';
    } finally {
        env.restore();
    }
});

test('UI 冒烟：导出角色卡 ZIP 并下载', async () => {
    const png = fakePng(3);
    const env = setupEnvironment({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        groups: [],
        pngs: { 'Momo.png': png },
    });
    try {
        const root = env.root;
        assert.ok(await waitFor(() => Boolean(env.ctx.extensionSettings.st_full_export)), '设置对象应写入 extensionSettings');
        const status = root.querySelector('#stfe-status');
        const includeCardJson = root.querySelector('#stfe-include-card-json');
        const exportCards = root.querySelector('#stfe-export-cards');

        includeCardJson.checked = true;
        includeCardJson.listeners.get('change')[0]();
        assert.equal(env.ctx.extensionSettings.st_full_export.includeCardJson, true);

        click(exportCards);
        const finished = await waitFor(() => status.textContent.includes('完成') || status.textContent.includes('失败'));
        assert.ok(finished, `导出应结束，当前状态：${status.textContent}`);
        assert.match(status.textContent, /完成：1 张角色卡/);
        assert.match(status.textContent, /sillytavern-characters-\d{8}-\d{6}\.zip/);

        assert.equal(env.downloads.length, 1);
        const zip = unzip(new Uint8Array(await env.downloads[0].arrayBuffer()));
        assert.ok(zip.byName.has('Momo.png'));
        assert.deepEqual(new Uint8Array(zip.byName.get('Momo.png').data), png);
        const index = JSON.parse(textOf(zip.byName.get('index.json')));
        assert.equal(index.count, 1);
    } finally {
        env.restore();
    }
});

test('UI 冒烟：ctx.saveChat 失败不阻塞导出，并给出提示', async () => {
    const env = setupEnvironment({ characters: [], groups: [] });
    try {
        const root = env.root;
        assert.ok(await waitFor(() => Boolean(env.ctx.extensionSettings.st_full_export)));
        env.ctx.saveChat = async () => {
            throw new Error('保存失败');
        };
        const status = root.querySelector('#stfe-status');
        const warning = root.querySelector('#stfe-warning');
        const exportChats = root.querySelector('#stfe-export-chats');

        click(exportChats);
        assert.ok(await waitFor(() => status.textContent.includes('完成') || status.textContent.includes('失败')));
        assert.match(status.textContent, /完成：0 条聊天/);
        assert.match(warning.textContent, /保存当前聊天失败/);
    } finally {
        env.restore();
    }
});

test('UI 冒烟：导出失败时状态为错误样式并输出中文信息', async () => {
    const env = setupEnvironment({ characters: [] });
    try {
        globalThis.fetch = async () => new Response('<html>login</html>', { status: 401 });
        const root = env.root;
        const status = root.querySelector('#stfe-status');
        const exportChats = root.querySelector('#stfe-export-chats');

        click(exportChats);
        const finished = await waitFor(() => status.textContent.includes('导出失败'));
        assert.ok(finished, `应显示失败状态，当前：${status.textContent}`);
        assert.match(status.textContent, /未登录或会话已过期/);
        assert.equal(status.classList.contains('stfe-status-error'), true);
    } finally {
        env.restore();
    }
});

test('UI 冒烟：取消导出后不产生下载', async () => {
    const env = setupEnvironment({ characters: [], groups: [] });
    try {
        const root = env.root;
        assert.ok(await waitFor(() => Boolean(env.ctx.extensionSettings.st_full_export)));

        // 让请求卡住，保证取消发生在导出进行中。
        let release = () => {};
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        globalThis.fetch = async () => {
            await gate;
            return jsonResponse([]);
        };

        const status = root.querySelector('#stfe-status');
        const exportChats = root.querySelector('#stfe-export-chats');
        const cancel = root.querySelector('#stfe-cancel');

        click(exportChats);
        assert.ok(await waitFor(() => exportChats.disabled === true), '导出应进入运行状态');
        click(cancel);
        release();
        assert.ok(
            await waitFor(() => status.textContent.includes('已取消')),
            `应提示已取消，当前：${status.textContent}`,
        );
        assert.equal(env.downloads.length, 0, '取消后不应触发下载');
        assert.equal(exportChats.disabled, false, '取消后按钮应恢复');
    } finally {
        env.restore();
    }
});
