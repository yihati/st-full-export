// ZIP 文件名与文件名分配相关工具（唯一化、扩展名处理）。

/** ZIP/Windows 非法字符集合（导出给调用方复用）。 */
export const ZIP_INVALID_CHARS = /[\\/:*?"<>|]/g;

// 控制字符：0x00-0x1F 与 0x7F
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

// Windows 保留设备名（大小写不敏感；带扩展名（如 CON.txt）同样保留）。
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 若文件名主干（第一个点之前）命中 Windows 保留设备名，则加 `_` 前缀，
 * 否则 Windows 解压/写入时可能失败或行为异常（如 con.png → _con.png）。
 */
function avoidWindowsReservedName(name) {
  const dotIndex = name.indexOf('.');
  const stem = dotIndex === -1 ? name : name.slice(0, dotIndex);
  return WINDOWS_RESERVED_NAME.test(stem) ? `_${name}` : name;
}

/** 清理单个文件名片段：替换非法字符与控制字符，并去掉结尾空格与点。 */
function cleanName(value) {
  const replaced = String(value ?? '')
    .replace(CONTROL_CHARS, '_')
    .replace(ZIP_INVALID_CHARS, '_');
  let result = replaced;
  while (result.endsWith(' ') || result.endsWith('.')) {
    result = result.slice(0, -1);
  }
  return result;
}

/** 名字的占用键：NFC 归一化 + 小写，避免大小写/NFC/NFD 变体互相覆盖。 */
function nameKey(name) {
  return String(name ?? '').normalize('NFC').toLowerCase();
}

/**
 * 按 UTF-16 长度上限截断，但只整段保留 code point（不会切断 emoji 的代理对）。
 */
function sliceCodePoints(text, maxUnits) {
  if (maxUnits <= 0) {
    return '';
  }
  let result = '';
  for (const char of text) {
    if (result.length + char.length > maxUnits) {
      break;
    }
    result += char;
  }
  return result;
}

/** 把清洗后的名字裁剪到 maxLength，尽量保留扩展名。 */
function fitLength(name, maxLength) {
  if (name.length <= maxLength) {
    return name;
  }
  const { base, ext } = splitExtension(name);
  const keepExt = ext !== '' && ext.length <= 10 && ext.length < maxLength ? ext : '';
  const source = keepExt !== '' ? base : name;
  const room = maxLength - keepExt.length;
  let head = sliceCodePoints(source, room);
  // 截断位置可能落在空格/点之前，再次清理尾部，避免清单里出现异常结尾
  while (head.endsWith(' ') || head.endsWith('.')) {
    head = head.slice(0, -1);
  }
  if (head === '') {
    head = sliceCodePoints(source, room);
  }
  return `${head}${keepExt}`;
}

/**
 * 清洗为安全的 ZIP 文件名（不含路径）。
 * @param {unknown} name 原始文件名
 * @param {{ fallback?: string, maxLength?: number }} [options]
 */
export function sanitizeZipFileName(name, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) && options.maxLength > 0
    ? Math.floor(options.maxLength)
    : 120;
  const cleaned = cleanName(String(name ?? ''));
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    const fallback = cleanName(String(options.fallback ?? 'file'));
    if (fallback === '' || fallback === '.' || fallback === '..') {
      return 'file';
    }
    return avoidWindowsReservedName(fallback);
  }
  return avoidWindowsReservedName(fitLength(cleaned, maxLength));
}

/**
 * 拆分扩展名（ext 含点；无扩展名时 ext 为 ''）。
 * 结尾点与 . / .. 均视为无扩展名，'.png' 这类隐藏文件同样视为无扩展名。
 */
export function splitExtension(name) {
  const text = String(name ?? '');
  const index = text.lastIndexOf('.');
  if (index <= 0 || index === text.length - 1) {
    return { base: text, ext: '' };
  }
  return { base: text.slice(0, index), ext: text.slice(index) };
}

/**
 * 在扩展名前插入序号，保证 desiredName 唯一（会原地修改 usedSet）。
 * 唯一性按 NFC + 小写判断：Momo.png / momo.png / NFD 变体不会互相覆盖；
 * 返回值保留调用方原拼写（只对重名者加 ` (2)` 之类的后缀）。
 */
export function allocateUniqueName(desiredName, usedSet) {
  const used = usedSet instanceof Set ? usedSet : new Set();
  const taken = new Set([...used].map(nameKey));
  const wanted = String(desiredName ?? '') || 'file';
  if (!taken.has(nameKey(wanted))) {
    used.add(wanted);
    return wanted;
  }

  const { base, ext } = splitExtension(wanted);
  let counter = 2;
  let candidate = `${base} (${counter})${ext}`;
  while (taken.has(nameKey(candidate))) {
    counter += 1;
    candidate = `${base} (${counter})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/** 文件名分配器：内部维护已占用集合（按 NFC + 小写判重）。 */
export class NameAllocator {
  constructor(initialNames = []) {
    this.usedNames = new Set(initialNames);
    this.usedKeys = new Set([...this.usedNames].map(nameKey));
  }

  has(name) {
    return this.usedKeys.has(nameKey(name));
  }

  get size() {
    return this.usedNames.size;
  }

  allocate(desiredName) {
    const wanted = String(desiredName ?? '') || 'file';
    const { base, ext } = splitExtension(wanted);
    let candidate = wanted;
    let counter = 2;
    while (this.usedKeys.has(nameKey(candidate))) {
      candidate = `${base} (${counter})${ext}`;
      counter += 1;
    }
    this.usedNames.add(candidate);
    this.usedKeys.add(nameKey(candidate));
    return candidate;
  }
}

/** 头像文件名去掉一层 .png 后缀（大小写不敏感）。 */
export function pngBaseName(avatar) {
  const name = String(avatar ?? '');
  return name.replace(/\.png$/i, '');
}