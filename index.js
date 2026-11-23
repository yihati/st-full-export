/**
 * 扩展入口。
 *
 * 不静态 import 任何 SillyTavern 内部模块：
 *  - 优先用 globalThis.SillyTavern.getContext()；
 *  - 暂时没有时动态 import('../../../extensions.js') 兜底（路径相对
 *    /scripts/extensions/third-party/st-full-export/），失败也只打印日志，不抛出；
 *  - 每 250ms 轮询一次，最多 60 秒。
 */

import { mountUi } from './src/ui.js';

const LOG_PREFIX = '[全量导出]';
const HOST_SELECTORS = ['#extensions_settings2', '#extensions_settings'];
const WAIT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 250;

let cachedContext = null;
let contextImportAttempted = false;

function isContextLike(value) {
    return Boolean(value) && typeof value === 'object';
}

/** 读取全局 SillyTavern.getContext()。 */
function readGlobalContext() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (isContextLike(ctx)) {
            return ctx;
        }
    } catch (error) {
        console.debug(LOG_PREFIX, 'globalThis.SillyTavern.getContext() 调用失败', error);
    }
    return null;
}

/** 动态 import('../../../extensions.js') 兜底，结果缓存在模块里。 */
async function readImportedContext() {
    if (cachedContext) {
        return cachedContext;
    }
    if (contextImportAttempted) {
        return null;
    }
    contextImportAttempted = true;
    try {
        const modules = await import('../../../extensions.js');
        const ctx = modules?.getContext?.();
        if (isContextLike(ctx)) {
            cachedContext = ctx;
            return ctx;
        }
        console.debug(LOG_PREFIX, 'extensions.js 未导出可用的 getContext()');
    } catch (error) {
        console.debug(LOG_PREFIX, '无法从 extensions.js 获取上下文，将只使用全局 getContext', error);
    }
    return null;
}

/** 供 UI 调用的上下文解析函数：全局优先，动态 import 兜底。 */
async function resolveContext() {
    const direct = readGlobalContext();
    if (direct) {
        cachedContext = direct;
        return direct;
    }
    const imported = await readImportedContext();
    if (imported) {
        return imported;
    }
    return readGlobalContext();
}

/** 轮询等待扩展设置容器出现。 */
function waitForHost(timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const find = () => {
            for (const selector of HOST_SELECTORS) {
                const element = document.querySelector(selector);
                if (element) {
                    return element;
                }
            }
            return null;
        };
        const immediate = find();
        if (immediate) {
            resolve(immediate);
            return;
        }
        const timer = setInterval(() => {
            const element = find();
            if (element) {
                clearInterval(timer);
                resolve(element);
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(timer);
                resolve(null);
            }
        }, POLL_INTERVAL_MS);
    });
}

async function bootstrap() {
    if (globalThis.__stFullExportMounted) {
        console.debug(LOG_PREFIX, '扩展入口已执行过，跳过重复挂载');
        return;
    }
    const host = await waitForHost();
    if (!host) {
        console.error(LOG_PREFIX, `等待 ${HOST_SELECTORS.join(' / ')} 超时（${WAIT_TIMEOUT_MS / 1000}s），扩展 UI 未挂载`);
        return;
    }
    try {
        const mounted = mountUi({ host, resolveContext });
        if (mounted) {
            globalThis.__stFullExportMounted = true;
            console.info(LOG_PREFIX, '设置面板已挂载');
        }
    } catch (error) {
        console.error(LOG_PREFIX, '挂载设置面板失败', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void bootstrap();
    }, { once: true });
} else {
    void bootstrap();
}
