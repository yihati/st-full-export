// 通用工具函数：纯函数与浏览器/Node 通用辅助函数。
// 约束：模块顶层不得访问 window/document；浏览器相关访问只在函数体内做存在性检查。

/** 操作取消错误：统一通过 name === 'AbortError' 识别。 */
export class AbortError extends Error {
  constructor(message = '操作已取消') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 判断错误是否为取消错误（兼容跨模块/跨 realm 的同类错误）。 */
export function isAbortError(err) {
  return err instanceof AbortError || err?.name === 'AbortError';
}

/**
 * 判断错误是否属于登录 / CSRF 失效。
 *
 * 这类失败不能当作“单个文件失败”跳过：一旦会话失效，后续所有请求都会失败，
 * 若逐项记录成 failures，最终会“成功”导出一个空文件，掩盖真正的问题。
 * 导出流程遇到它必须中止并提示用户刷新页面重新登录。
 *
 * 注意：**不能**把裸 403 当鉴权失败。403 可能来自 1.19 的非法文件名校验或
 * WAF/CDN，只是单文件问题；只有明确带 kind:'csrf' 的 403 才中止整次导出。
 */
export function isAuthFailure(err) {
  return err?.kind === 'auth'
    || err?.kind === 'csrf'
    || err?.status === 401;
}

/** 若 signal 已取消则抛出 AbortError。 */
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AbortError('已取消');
  }
}

/**
 * 延时等待；传入 signal 时支持取消。
 * ms 非法（NaN/负数/非数字）按 0 处理。
 */
export function sleep(ms, signal) {
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError('已取消'));
      return;
    }

    let timer = null;
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const onAbort = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cleanup();
      reject(new AbortError('已取消'));
    };

    timer = setTimeout(() => {
      timer = null;
      cleanup();
      resolve();
    }, delay);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 转义 HTML 特殊字符（先处理 &，避免二次转义）。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 人类可读的字节数：0 B / N B / x.x KB|MB|GB|TB；非法输入返回 '0 B'。 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  const size = Math.floor(bytes);
  if (size === 0) {
    return '0 B';
  }
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** 保证返回数组：非数组一律返回空数组。 */
export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 是否为普通对象（非 null、非数组的对象）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 截断文本，超出 max（默认 80）时追加省略号；按 code point 截断，不会切断 emoji。 */
export function truncateText(text, max = 80) {
  const str = String(text ?? '');
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 80;
  const points = Array.from(str);
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : str;
}

/** 把任意错误转成可读文本，最长 500 字符。 */
export function describeError(err) {
  const message = err?.message;
  let text = typeof message === 'string' && message !== '' ? message : String(err);
  if (!text) {
    text = '未知错误';
  }
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/** 触发浏览器下载；非浏览器环境抛出明确错误。 */
export function saveBlob(blob, fileName) {
  const doc = globalThis.document;
  const urlApi = globalThis.URL;
  if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
    throw new Error('当前环境不支持文件下载');
  }
  if (!urlApi || typeof urlApi.createObjectURL !== 'function') {
    throw new Error('当前环境不支持文件下载');
  }

  const url = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 60 秒后再回收：超大 ZIP 下载在部分浏览器上需要更长时间读取 Blob URL，
  // 过早 revoke 可能导致下载中断。
  setTimeout(() => {
    try {
      urlApi.revokeObjectURL(url);
    } catch {
      // 忽略回收失败，不影响下载结果
    }
  }, 60000);
}