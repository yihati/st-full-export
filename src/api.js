/**
 * ST 1.15.0 / 1.19.1 REST API 封装（SillyTavern 全量导出扩展）
 *
 * 设计目标：
 * - 零第三方依赖，Node 18+ 与浏览器通用（顶层不访问 window / document）；
 * - 所有业务接口统一走 POST + JSON body + X-CSRF-Token；
 * - 业务 POST 对网络错误与 5xx 做有限次重试（默认 2 次）；401 / 403 等鉴权错误
 *   立即失败，不重试；
 * - 角色卡图片用 GET 下载，只尝试一次，不做重试；
 * - 2xx 但返回 HTML（登录页 / 反向代理 / SSO）也按鉴权失败处理，避免静默导出空数据；
 * - 所有失败都以 ApiError 抛出，便于上层按 kind 区分处理。
 */

const JSON_CONTENT_TYPE = 'application/json';

/** PNG 文件头签名：89 50 4E 47 0D 0A 1A 0A */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 403 错误信息中附加的响应片段最大长度（字符） */
const SNIPPET_MAX_LENGTH = 200;

/**
 * 统一的 API 错误类型。
 */
export class ApiError extends Error {
  /**
   * @param {string} message 中文错误信息
   * @param {{ status?: number, kind?: 'auth'|'csrf'|'http'|'network'|'format'|'abort', cause?: unknown }} [options]
   */
  constructor(message, { status = 0, kind = 'http', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.cause = cause;
    // V8 环境下裁剪调用栈，保留真正抛错的位置
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, ApiError);
    }
  }
}

/** 构造统一的取消错误（不重试，name 固定为 AbortError） */
function createAbortError() {
  return Object.assign(new Error('已取消'), { name: 'AbortError', kind: 'abort' });
}

/** 判断是否为取消错误：兼容 name === 'AbortError' 与 kind === 'abort' 两种写法 */
function isAbortError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  return err.name === 'AbortError' || err.kind === 'abort';
}

/** 若 signal 已取消则立即抛出取消错误 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/** 可被 AbortSignal 打断的 sleep，用于重试间隔 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let timer = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 判断响应是否成功：优先用 ok，缺失时按状态码兜底 */
function isOkResponse(res) {
  if (!res) {
    return false;
  }
  if (typeof res.ok === 'boolean') {
    return res.ok;
  }
  const status = Number(res.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

/** 读取响应头（兼容 Headers 与普通对象） */
function getResponseHeader(res, name) {
  const headers = res?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  if (typeof headers === 'object') {
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  return null;
}

/** 读取响应文本；读取失败返回 null（与空 body 的 '' 区分）。 */
async function readResponseText(res) {
  if (typeof res?.text === 'function') {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 仅当响应体（去 BOM / 前导空白后）**以 HTML 文档标记开头**时才判定为 HTML 页面。
 *
 * 不能用全文 includes('<html')：合法聊天 JSON 里某条消息的正文可能包含
 * `<html>` / `<!doctype html>` 代码片段（用户聊前端时很常见），全文匹配会把
 * 正常数据误判成登录页，导致整次导出失败。
 */
const HTML_DOCUMENT_PATTERN = /^\uFEFF?\s*(?:<!doctype\s+html|<html(?:\s|>))/i;

function startsWithHtmlDocument(text) {
  return typeof text === 'string' && HTML_DOCUMENT_PATTERN.test(text);
}

/** 响应体是否包含 CSRF 失效证据（不区分大小写）。 */
function looksLikeCsrf(text) {
  return typeof text === 'string' && text.toLowerCase().includes('csrf');
}

/** 把二进制前缀解码成文本，用于识别 PNG 下载实际拿到的是不是 HTML 页面。 */
function decodeBytesPrefix(bytes, maxLength = 256) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxLength));
  } catch {
    return '';
  }
}

/** 截断提示片段，避免错误信息过长 */
function toSnippet(text) {
  return String(text ?? '').trim().slice(0, SNIPPET_MAX_LENGTH);
}

/** 把任意抛出的值转成可读信息 */
function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * 创建 API 客户端。
 *
 * @param {{
 *   ctx?: any,
 *   fetchImpl?: typeof fetch,
 *   headersProvider?: null | (() => Record<string, string> | Promise<Record<string, string>>),
 *   documentRef?: Document | null,
 *   retryDelay?: number,
 *   maxRetries?: number,
 * }} [options]
 * @returns {{
 *   post: (path: string, body?: unknown, init?: { signal?: AbortSignal }) => Promise<any>,
 *   getCharacters: () => Promise<any[]>,
 *   getGroups: () => Promise<any[]>,
 *   listCharacterChats: (avatar: string) => Promise<any[]|null>,
 *   getCharacterChat: (avatar: string, fileId: string, characterName?: string) => Promise<any>,
 *   getGroupChat: (chatId: string | number) => Promise<any>,
 *   getCharacter: (avatar: string) => Promise<any>,
 *   fetchCharacterPng: (avatar: string, init?: { signal?: AbortSignal }) => Promise<Uint8Array>,
 *   fetchImpl: typeof fetch | null,
 * }}
 */
export function createApi(options = {}) {
  const { ctx = null, headersProvider = null, retryDelay = 500, maxRetries = 2 } = options;

  // documentRef 仅在调用方显式传入时使用（传 null 表示禁用 meta 兜底）
  const documentRef = Object.prototype.hasOwnProperty.call(options, 'documentRef')
    ? options.documentRef
    : globalThis.document ?? null;

  // 默认 fetch 包一层，避免浏览器里解构后丢失 this 绑定
  const fetchImpl =
    options.fetchImpl ??
    (typeof globalThis.fetch === 'function' ? (...args) => globalThis.fetch(...args) : null);

  const retryDelayMs = Number.isFinite(retryDelay) && retryDelay > 0 ? retryDelay : 0;
  const maxRetryCount = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 0;

  /** 统一调用注入的 fetch */
  function doFetch(url, init) {
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new TypeError('当前环境不支持 fetch'));
    }
    return fetchImpl(url, init);
  }

  // ---------------- CSRF / 请求头 ----------------

  let csrfTokenPromise = null;

  /** 通过 GET /csrf-token 获取 token（结果缓存，失败返回 null 且不抛错） */
  function getCsrfToken() {
    if (!csrfTokenPromise) {
      csrfTokenPromise = (async () => {
        try {
          const res = await doFetch('/csrf-token', { method: 'GET', credentials: 'same-origin' });
          if (!isOkResponse(res)) {
            return null;
          }
          let data = null;
          try {
            data = await res.json();
          } catch {
            return null;
          }
          return data && typeof data.token === 'string' && data.token ? data.token : null;
        } catch {
          return null;
        }
      })();
    }
    return csrfTokenPromise;
  }

  /** 读取页面 <meta name="csrf-token"> 中的 token */
  function readMetaCsrfToken() {
    try {
      const element = documentRef?.querySelector?.('meta[name="csrf-token"]');
      if (!element) {
        return null;
      }
      let value = null;
      if (typeof element.getAttribute === 'function') {
        value = element.getAttribute('content');
      }
      // 真实 DOM 上也可以直接读 content 属性
      if (!value && element.content != null) {
        value = element.content;
      }
      return value == null || value === '' ? null : String(value);
    } catch {
      return null;
    }
  }

  /**
   * 解析请求头，顺序：
   * headersProvider → ctx.getRequestHeaders() → <meta> → GET /csrf-token → 仅 Content-Type
   */
  async function buildHeaders() {
    if (typeof headersProvider === 'function') {
      try {
        const provided = await headersProvider();
        if (provided && typeof provided === 'object') {
          return provided;
        }
      } catch {
        // headersProvider 自身出错时继续回退，不影响请求
      }
    }

    if (ctx) {
      try {
        const fromCtx =
          typeof ctx.getRequestHeaders === 'function' ? await ctx.getRequestHeaders() : null;
        if (fromCtx && typeof fromCtx === 'object' && Object.keys(fromCtx).length > 0) {
          return fromCtx;
        }
      } catch {
        // 忽略，继续用后续兜底
      }
    }

    const metaToken = readMetaCsrfToken();
    if (metaToken) {
      return { 'Content-Type': JSON_CONTENT_TYPE, 'X-CSRF-Token': metaToken };
    }

    const endpointToken = await getCsrfToken();
    if (endpointToken) {
      return { 'Content-Type': JSON_CONTENT_TYPE, 'X-CSRF-Token': endpointToken };
    }

    return { 'Content-Type': JSON_CONTENT_TYPE };
  }

  // ---------------- 响应处理 ----------------

  /**
   * 把非 2xx 响应转换成 ApiError。
   *
   * 只有 401 直接算鉴权失败；403 必须能在响应体里找到 CSRF 证据才算 csrf，
   * 否则按普通单文件失败处理（例如 1.19 的非法文件名 403、WAF 的 403）。
   * 其他状态码的 HTML 错误页归 http，不中止整次导出。
   */
  async function toHttpError(res) {
    const status = Number(res?.status) || 0;
    const statusText = res?.statusText ?? '';
    const text = await readResponseText(res);
    const bodyText = text ?? '';
    const contentType = String(getResponseHeader(res, 'content-type') ?? '').toLowerCase();
    const isHtml = contentType.includes('text/html') || startsWithHtmlDocument(bodyText);
    const snippet = isHtml ? '' : toSnippet(bodyText);

    if (status === 401) {
      return new ApiError('未登录或会话已过期，请刷新页面重新登录', {
        status: 401,
        kind: 'auth',
      });
    }

    if (status === 403) {
      if (looksLikeCsrf(bodyText)) {
        return new ApiError('请求被拒绝：CSRF 校验失败，请刷新页面后重试', {
          status,
          kind: 'csrf',
        });
      }
      const detail = snippet ? `：${snippet}` : '';
      return new ApiError(`请求被拒绝（HTTP 403），请稍后重试${detail}`, {
        status,
        kind: 'http',
      });
    }

    if (isHtml) {
      return new ApiError(`服务器返回了 HTML 错误页（HTTP ${status}），请稍后重试`, {
        status,
        kind: 'http',
      });
    }

    const label = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
    return new ApiError(snippet ? `${label}：${snippet}` : label, {
      status,
      kind: 'http',
    });
  }

  /**
   * 解析成功（2xx）响应：
   * - 读取失败 → format 错误（不静默当成空数据）；
   * - HTML（登录页 / SSO / 反向代理页面）→ auth 错误，避免静默导出空文件；
   * - 空/纯空白 body → null；
   * - 其余 body 一律先尝试 JSON.parse（不依赖 content-type，代理可能改写它），
   *   成功返回对象，失败抛 format 错误，绝不返回裸字符串当作正常数据。
   */
  async function parseResponseBody(res) {
    const status = Number(res?.status) || 0;
    const text = await readResponseText(res);
    if (text === null) {
      throw new ApiError('读取服务器响应失败（连接可能已中断）', { status, kind: 'format' });
    }
    const contentType = String(getResponseHeader(res, 'content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html') || startsWithHtmlDocument(text)) {
      throw new ApiError('会话已过期或服务器返回了登录页，请刷新页面重新登录', {
        status,
        kind: 'auth',
      });
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed.replace(/^\uFEFF/, ''));
    } catch {
      throw new ApiError('服务器返回了无法解析的响应（可能被代理改写或截断）', {
        status,
        kind: 'format',
      });
    }
  }

  // ---------------- 通用 POST ----------------

  /**
   * 发送 POST 请求（ST 所有业务接口的通用入口）。
   *
   * @param {string} path 接口路径，如 '/api/characters/all'
   * @param {unknown} [body] JSON body
   * @param {{ signal?: AbortSignal }} [init]
   * @returns {Promise<any>}
   */
  async function post(path, body, { signal } = {}) {
    throwIfAborted(signal);

    const headers = await buildHeaders();
    throwIfAborted(signal);

    const payload = JSON.stringify(body ?? {});
    let lastNetworkError = null;

    for (let attempt = 0; attempt <= maxRetryCount; attempt += 1) {
      throwIfAborted(signal);

      let res = null;
      try {
        res = await doFetch(path, {
          method: 'POST',
          headers,
          body: payload,
          credentials: 'same-origin',
          signal,
        });
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          throw createAbortError();
        }
        lastNetworkError = err;
        if (attempt < maxRetryCount) {
          await sleep(retryDelayMs, signal);
          continue;
        }
        throw new ApiError(`网络请求失败：${errorMessage(err)}`, {
          kind: 'network',
          cause: err,
        });
      }

      if (isOkResponse(res)) {
        return parseResponseBody(res);
      }

      // 仅 5xx 重试，4xx（401/403 等）立即失败
      if (Number(res?.status) >= 500 && attempt < maxRetryCount) {
        await readResponseText(res);
        await sleep(retryDelayMs, signal);
        continue;
      }

      throw await toHttpError(res);
    }

    // 理论上不可达，兜底给出网络错误
    throw new ApiError('网络请求失败：重试次数已用尽', {
      kind: 'network',
      cause: lastNetworkError,
    });
  }

  // ---------------- 角色 / 群组 ----------------

  /** 获取全部角色卡；优先使用 ST 上下文里已加载的数据 */
  async function getCharacters({ signal } = {}) {
    const fromCtx = ctx?.characters;
    if (Array.isArray(fromCtx) && fromCtx.length > 0) {
      return fromCtx.slice();
    }
    const data = await post('/api/characters/all', {}, { signal });
    return Array.isArray(data) ? data : [];
  }

  /** 获取全部群组；优先使用 ST 上下文里已加载的数据 */
  async function getGroups({ signal } = {}) {
    const fromCtx = ctx?.groups;
    if (Array.isArray(fromCtx) && fromCtx.length > 0) {
      return fromCtx.slice();
    }
    const data = await post('/api/groups/all', {}, { signal });
    return Array.isArray(data) ? data : [];
  }

  /**
   * 列出某个角色的聊天文件。
   *
   * @returns {Promise<any[]|null>} 正常返回数组；服务端返回 `{ error: true }`
   *   或其它非数组时返回 null，由调用方结合角色的 chat_size/date_last_chat
   *   判断是“本来就没有聊天”还是“接口异常”。
   */
  async function listCharacterChats(avatar, { signal } = {}) {
    const data = await post('/api/characters/chats', {
      avatar_url: avatar,
      metadata: true,
      simple: false,
    }, { signal });
    return Array.isArray(data) ? data : null;
  }

  /**
   * 读取单个角色的聊天文件。
   *
   * 服务端会自行拼接 '.jsonl'；调用方必须传 listing 的 file_id（已不含扩展名）。
   * 这里不再做二次剥离，否则主干以 .jsonl 结尾的聊天（a.jsonl.jsonl）会被读错。
   *
   * @returns {Promise<any>} 原始 payload（数组或对象），解析交给上层
   */
  async function getCharacterChat(avatar, fileId, characterName, { signal } = {}) {
    return post('/api/chats/get', {
      avatar_url: avatar,
      file_name: String(fileId ?? ''),
      ch_name: characterName || '',
    }, { signal });
  }

  /** 读取群聊文件，返回原始 payload */
  async function getGroupChat(chatId, { signal } = {}) {
    return post('/api/chats/group/get', { id: String(chatId) }, { signal });
  }

  /** 读取单个角色卡（含 json_data 字符串） */
  async function getCharacter(avatar, { signal } = {}) {
    const data = await post('/api/characters/get', { avatar_url: avatar }, { signal });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
      throw new ApiError('读取角色卡失败：' + avatar, { kind: 'http' });
    }
    return data;
  }

  // ---------------- 角色卡原图 ----------------

  /**
   * 下载角色卡原图并校验 PNG 签名。
   *
   * @param {string} avatar 角色头像文件名（如 'Momo.png'）
   * @param {{ signal?: AbortSignal }} [init]
   * @returns {Promise<Uint8Array>}
   */
  async function fetchCharacterPng(avatar, { signal } = {}) {
    throwIfAborted(signal);

    const url = '/characters/' + encodeURIComponent(avatar);
    let res = null;
    try {
      res = await doFetch(url, { method: 'GET', credentials: 'same-origin', signal });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw createAbortError();
      }
      throw new ApiError('下载角色卡图片失败：' + errorMessage(err), {
        kind: 'network',
        cause: err,
      });
    }

    if (!isOkResponse(res)) {
      throw new ApiError(`下载角色卡图片失败（HTTP ${res?.status}）：${avatar}`, {
        status: Number(res?.status) || 0,
        kind: 'http',
      });
    }

    // 反代 / SSO 常把未登录请求以 200 登录页返回：先看 content-type，
    // 再看字节前缀，避免落到“PNG 签名错误”而只记单卡失败。
    const contentType = String(getResponseHeader(res, 'content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new ApiError('角色卡图片下载返回了登录页，请刷新页面重新登录', {
        status: Number(res?.status) || 0,
        kind: 'auth',
      });
    }

    let buffer = null;
    try {
      buffer = await res.arrayBuffer();
    } catch (err) {
      throw new ApiError('读取角色卡图片数据失败：' + avatar, { kind: 'format', cause: err });
    }

    const bytes = new Uint8Array(buffer);
    if (startsWithHtmlDocument(decodeBytesPrefix(bytes))) {
      throw new ApiError('角色卡图片下载返回了登录页，请刷新页面重新登录', {
        status: Number(res?.status) || 0,
        kind: 'auth',
      });
    }

    const validSignature =
      bytes.length >= PNG_SIGNATURE.length &&
      PNG_SIGNATURE.every((expected, index) => bytes[index] === expected);

    if (!validSignature) {
      throw new ApiError('不是有效的 PNG 文件：' + avatar, { kind: 'format' });
    }

    return bytes;
  }

  return {
    post,
    getCharacters,
    getGroups,
    listCharacterChats,
    getCharacterChat,
    getGroupChat,
    getCharacter,
    fetchCharacterPng,
    fetchImpl,
  };
}
