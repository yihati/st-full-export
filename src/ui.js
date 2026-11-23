/**
 * 设置面板 UI（原生 DOM，不依赖 jQuery）。
 *
 * 挂载到 ST 的 #extensions_settings2（找不到时退到 #extensions_settings）。
 * 所有动态文本（角色名 / 文件名 / 错误原因）一律用 textContent 写入，
 * 只有静态模板使用 innerHTML，避免 XSS。
 */

import { createApi } from './api.js';
import { exportAllChats } from './chats.js';
import { exportCharactersZip } from './characters.js';
import { CHAT_FORMATS } from './format.js';
import { describeError, formatBytes, isAbortError, saveBlob, throwIfAborted, truncateText } from './util.js';

/** 扩展设置的键名，必须与 README / 用户预期一致。 */
export const MODULE_NAME = 'st_full_export';

/** 默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
    chatFormat: 'json',
    includeGroupChats: true,
    includeCardJson: false,
});

/** 失败项 scope 的中文映射。 */
const SCOPE_LABELS = Object.freeze({
    character: '角色',
    group: '群聊',
    file: '文件',
    card: '角色卡',
    zip: '打包',
});

/** 静态模板：不包含任何用户数据。 */
const TEMPLATE = `
<div class="inline-drawer-toggle inline-drawer-header">
    <b>全量导出</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
    <div class="stfe-section">
        <div class="stfe-row">
            <label class="stfe-label" for="stfe-chat-format">对话格式</label>
            <select id="stfe-chat-format" class="text_pole stfe-select">
                <option value="json">JSON（完整数据，推荐备份）</option>
                <option value="jsonl">JSONL（每行一条聊天，适合大数据）</option>
                <option value="txt">TXT（纯文本阅读）</option>
            </select>
        </div>
        <div class="stfe-row stfe-check-row">
            <label class="checkbox_label">
                <input type="checkbox" id="stfe-include-group-chats" class="stfe-checkbox">
                <span>包含群聊</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="stfe-include-card-json" class="stfe-checkbox">
                <span>角色卡 ZIP 附带 JSON 卡数据</span>
            </label>
        </div>
        <div class="stfe-row stfe-button-group">
            <button type="button" class="menu_button stfe-button" id="stfe-export-chats">导出全部对话</button>
            <button type="button" class="menu_button stfe-button" id="stfe-export-cards">导出全部角色卡 ZIP</button>
        </div>
        <div class="stfe-hint stfe-privacy">隐私提示：导出的文件包含导出范围内的全部聊天内容与角色卡数据，只保存在本机浏览器下载目录，请妥善保管，不要随意分享。</div>
        <div class="stfe-hint stfe-scope" id="stfe-scope">导出范围：当前角色卡与群组关联的全部聊天；已删除角色卡遗留的孤儿聊天、根目录遗留聊天纯前端无法枚举，不包含在内。角色卡 ZIP 不受影响。</div>
        <div class="stfe-hint stfe-warning stfe-hidden" id="stfe-warning" role="status" aria-live="polite"></div>
        <div class="stfe-progress stfe-hidden" id="stfe-progress">
            <div class="stfe-progress-text" id="stfe-progress-text"></div>
            <div class="stfe-progress-track"><div class="stfe-progress-fill" id="stfe-progress-fill"></div></div>
        </div>
        <div class="stfe-row stfe-button-group stfe-hidden" id="stfe-running">
            <button type="button" class="menu_button stfe-button stfe-cancel" id="stfe-cancel">取消导出</button>
        </div>
        <div class="stfe-status" id="stfe-status" role="status" aria-live="polite"></div>
        <details class="stfe-failures stfe-hidden" id="stfe-failures">
            <summary>失败详情（<span id="stfe-failure-count">0</span> 项）</summary>
            <ul class="stfe-failure-list" id="stfe-failure-list"></ul>
            <button type="button" class="menu_button stfe-button stfe-small" id="stfe-copy-failures">复制失败详情</button>
        </details>
    </div>
</div>
`;

function normalizeFormat(value) {
    return CHAT_FORMATS.includes(value) ? value : 'json';
}

/**
 * 把当前设置解析成「持久化对象」。
 * ctx 可用时直接使用 extension_settings.st_full_export（同一引用，改动即持久化）；
 * ctx 不可用时退回内存对象，等上下文就绪后再合并。
 */
function resolveSettings(ctx, fallback) {
    const base = { ...DEFAULT_SETTINGS, ...(fallback ?? {}) };
    base.chatFormat = normalizeFormat(base.chatFormat);
    const store = ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object'
        ? ctx.extensionSettings
        : null;
    if (!store) {
        return base;
    }
    let current = store[MODULE_NAME];
    if (!current || typeof current !== 'object') {
        current = {};
        store[MODULE_NAME] = current;
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(current, key)) {
            current[key] = base[key];
        }
    }
    current.chatFormat = normalizeFormat(current.chatFormat);
    return current;
}

function failureLine(failure) {
    const scope = SCOPE_LABELS[failure?.scope] ?? failure?.scope ?? '未知';
    const name = failure?.name ?? '';
    const file = failure?.file_name ? `（${failure.file_name}）` : '';
    const reason = failure?.reason ?? '未知错误';
    return `[${scope}] ${name}${file}：${reason}`;
}

/**
 * 判断 ST 当前是否正在生成。
 * 1.15 的 getContext() 不暴露 generating，但会在 document.body 上写 data-generating；
 * 1.19 起可能暴露 ctx.generating / ctx.isGenerating()。三种方式都兼容。
 */
function isGenerationInProgress(ctx) {
    try {
        if (ctx?.generating === true) {
            return true;
        }
        if (typeof ctx?.isGenerating === 'function' && ctx.isGenerating() === true) {
            return true;
        }
    } catch (error) {
        console.debug('[全量导出] 读取生成状态失败', error);
    }
    const doc = globalThis.document;
    return doc?.body?.dataset?.generating === 'true';
}

/**
 * 挂载设置面板。
 *
 * @param {object} options
 * @param {HTMLElement} options.host              挂载容器（#extensions_settings2）
 * @param {() => Promise<object|null>} options.resolveContext  解析 ST 上下文
 * @returns {{refresh: () => void} | null}        已存在面板时返回 null
 */
export function mountUi({ host, resolveContext }) {
    if (!host) {
        throw new Error('缺少 UI 挂载容器');
    }
    const doc = host.ownerDocument ?? globalThis.document;
    if (!doc) {
        throw new Error('当前环境没有 document，无法挂载 UI');
    }
    if (host.querySelector('#stfe-root')) {
        return null;
    }

    const root = doc.createElement('div');
    root.id = 'stfe-root';
    root.className = 'stfe-panel inline-drawer';
    root.innerHTML = TEMPLATE;
    host.appendChild(root);

    // 注意：调用处传入完整选择器（带 #），这里不要再拼 #。
    const $ = (selector) => root.querySelector(selector);
    const formatSelect = $('#stfe-chat-format');
    const includeGroups = $('#stfe-include-group-chats');
    const includeCardJson = $('#stfe-include-card-json');
    const exportChatsButton = $('#stfe-export-chats');
    const exportCardsButton = $('#stfe-export-cards');
    const progressBox = $('#stfe-progress');
    const progressText = $('#stfe-progress-text');
    const progressFill = $('#stfe-progress-fill');
    const runningRow = $('#stfe-running');
    const cancelButton = $('#stfe-cancel');
    const statusBox = $('#stfe-status');
    const warningBox = $('#stfe-warning');
    const failuresBox = $('#stfe-failures');
    const failuresList = $('#stfe-failure-list');
    const failureCount = $('#stfe-failure-count');
    const copyFailures = $('#stfe-copy-failures');

    const state = {
        ctx: null,
        settings: { ...DEFAULT_SETTINGS },
        failures: [],
        busy: false,
        controller: null,
    };

    function setStatus(text, tone = '') {
        statusBox.textContent = text;
        statusBox.classList.toggle('stfe-status-error', tone === 'error');
        statusBox.classList.toggle('stfe-status-success', tone === 'success');
    }

    /** 常驻警告区：生成中 / 保存聊天失败等提示，不随进度覆盖。 */
    function showWarning(text) {
        warningBox.textContent = String(text ?? '');
        warningBox.classList.toggle('stfe-hidden', !text);
    }

    function hideWarning() {
        warningBox.textContent = '';
        warningBox.classList.add('stfe-hidden');
    }

    function setBusy(value) {
        state.busy = value;
        exportChatsButton.disabled = value;
        exportCardsButton.disabled = value;
        root.setAttribute('aria-busy', value ? 'true' : 'false');
        runningRow.classList.toggle('stfe-hidden', !value);
        if (value) {
            progressBox.classList.remove('stfe-hidden');
        }
    }

    function updateProgress(progress) {
        if (!progress) {
            return;
        }
        progressBox.classList.remove('stfe-hidden');
        const total = Number(progress.total) || 0;
        const current = Number(progress.current) || 0;
        let text = String(progress.message ?? progress.phase ?? '');
        if (total > 0 && !text.includes('/')) {
            text += `（${current}/${total}）`;
        }
        progressText.textContent = text;
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
        progressFill.style.width = `${percent}%`;
    }

    function renderFailures(failures) {
        state.failures = Array.isArray(failures) ? failures : [];
        failureCount.textContent = String(state.failures.length);
        failuresList.replaceChildren();
        for (const failure of state.failures) {
            const item = doc.createElement('li');
            item.textContent = truncateText(failureLine(failure), 500);
            item.title = failureLine(failure);
            failuresList.appendChild(item);
        }
        failuresBox.classList.toggle('stfe-hidden', state.failures.length === 0);
    }

    function syncControls(settings) {
        formatSelect.value = normalizeFormat(settings.chatFormat);
        includeGroups.checked = Boolean(settings.includeGroupChats);
        includeCardJson.checked = Boolean(settings.includeCardJson);
    }

    function persistSettings() {
        const ctx = state.ctx;
        if (ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
            ctx.extensionSettings[MODULE_NAME] = state.settings;
            try {
                ctx.saveSettingsDebounced?.();
            } catch (error) {
                console.error('[全量导出] 保存设置失败', error);
            }
        }
    }

    async function getContext() {
        let ctx = null;
        try {
            ctx = await resolveContext();
        } catch (error) {
            console.error('[全量导出] 获取 SillyTavern 上下文失败', error);
        }
        if (ctx) {
            state.ctx = ctx;
            state.settings = resolveSettings(ctx, state.settings);
            syncControls(state.settings);
        }
        return ctx;
    }

    async function handleExport(kind) {
        if (state.busy) {
            return;
        }
        // 在任何 await 之前占位 busy/controller：resolveContext 较慢时双击
        // 也不会同时启动两个导出，且取消按钮始终有对应的 controller。
        state.busy = true;
        const controller = new AbortController();
        state.controller = controller;
        setBusy(true);
        renderFailures([]);

        try {
            const ctx = await getContext();
            if (!ctx) {
                setStatus('无法获取 SillyTavern 上下文，请刷新页面后重试。', 'error');
                return;
            }
            throwIfAborted(controller.signal);

            const settings = state.settings;
            hideWarning();
            if (isGenerationInProgress(ctx)) {
                showWarning('当前有生成任务，导出可能不含最新消息。');
            }
            setStatus('正在保存当前聊天…');
            updateProgress({ message: kind === 'chats' ? '正在准备导出对话…' : '正在准备导出角色卡…', current: 0, total: 0 });

            // 先触发一次保存，尽量把最新消息落盘；失败不阻塞导出。
            try {
                if (typeof ctx.saveChat === 'function') {
                    await ctx.saveChat();
                }
            } catch (error) {
                console.warn('[全量导出] 保存当前聊天失败，导出继续', error);
                showWarning('保存当前聊天失败（导出可能不含最新消息），已继续导出。');
            }

            // 保存期间用户可能点了取消。
            throwIfAborted(controller.signal);
            setStatus(kind === 'chats' ? '正在导出全部对话…' : '正在导出全部角色卡…', '');
            if (kind === 'chats') {
                const result = await exportAllChats({
                    api: createApi({ ctx }),
                    format: normalizeFormat(settings.chatFormat),
                    includeGroupChats: Boolean(settings.includeGroupChats),
                    signal: controller.signal,
                    onProgress: updateProgress,
                });
                // 同步打包期间无法响应取消：让排队的点击先执行，再检查 abort。
                await new Promise((resolve) => setTimeout(resolve, 0));
                throwIfAborted(controller.signal);
                saveBlob(result.blob, result.fileName);
                const stats = result.stats;
                const skipped = Number(stats.skipped_empty) || 0;
                setStatus(
                    `完成：${stats.chats} 条聊天 / ${stats.messages} 条消息`
                    + `（角色 ${stats.characters} 个，群聊 ${stats.groups} 个）`
                    + `；失败 ${result.failures.length} 项`
                    + (skipped > 0 ? `；跳过空聊天 ${skipped} 条` : '')
                    + `；文件 ${result.fileName}`,
                    'success',
                );
                renderFailures(result.failures);
                console.info('[全量导出] 对话导出完成', result.stats, result.fileName);
            } else {
                const result = await exportCharactersZip({
                    api: createApi({ ctx }),
                    includeCardJson: Boolean(settings.includeCardJson),
                    signal: controller.signal,
                    onProgress: updateProgress,
                });
                await new Promise((resolve) => setTimeout(resolve, 0));
                throwIfAborted(controller.signal);
                saveBlob(result.blob, result.fileName);
                const stats = result.stats;
                setStatus(
                    `完成：${stats.characters} 张角色卡（${formatBytes(stats.bytes)}）`
                    + `；失败 ${result.failures.length} 项；文件 ${result.fileName}`,
                    'success',
                );
                renderFailures(result.failures);
                console.info('[全量导出] 角色卡导出完成', result.stats, result.fileName);
            }
        } catch (error) {
            if (isAbortError(error)) {
                setStatus('已取消导出，未生成文件。');
                console.info('[全量导出] 用户取消了导出');
            } else {
                setStatus(`导出失败：${describeError(error)}`, 'error');
                console.error('[全量导出] 导出失败', error);
            }
        } finally {
            state.controller = null;
            setBusy(false);
        }
    }

    formatSelect.addEventListener('change', () => {
        state.settings.chatFormat = normalizeFormat(formatSelect.value);
        persistSettings();
    });
    includeGroups.addEventListener('change', () => {
        state.settings.includeGroupChats = Boolean(includeGroups.checked);
        persistSettings();
    });
    includeCardJson.addEventListener('change', () => {
        state.settings.includeCardJson = Boolean(includeCardJson.checked);
        persistSettings();
    });
    exportChatsButton.addEventListener('click', () => {
        void handleExport('chats');
    });
    exportCardsButton.addEventListener('click', () => {
        void handleExport('cards');
    });
    cancelButton.addEventListener('click', () => {
        if (!state.controller) {
            return;
        }
        setStatus('正在取消…');
        state.controller.abort();
    });
    copyFailures.addEventListener('click', () => {
        const text = state.failures.map(failureLine).join('\n');
        const clipboard = globalThis.navigator?.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
            setStatus('当前浏览器不支持自动复制，请手动选择失败详情复制。', 'error');
            return;
        }
        clipboard.writeText(text).then(
            () => setStatus('失败详情已复制到剪贴板。', 'success'),
            (error) => {
                setStatus('复制失败，请手动选择失败详情复制。', 'error');
                console.error('[全量导出] 复制失败详情失败', error);
            },
        );
    });

    // 初始化：尝试立即拿到上下文与设置（拿不到也不影响面板显示）。
    const initial = resolveSettings(null, state.settings);
    state.settings = initial;
    syncControls(initial);
    void getContext();
    renderFailures([]);

    return {
        refresh: () => {
            void getContext();
        },
    };
}
