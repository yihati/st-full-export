/**
 * zip.js —— 纯 JavaScript 实现的 store-only（仅存储、不压缩）ZIP 写入器。
 *
 * 设计要点：
 * - 零第三方依赖、无任何 import，不使用 zlib / CompressionStream；
 * - 只用 local file header + central directory header + EOCD，
 *   不使用 data descriptor（所以大小与 CRC 必须提前写入头部）；
 * - 文件名统一按 UTF-8 编码，general purpose bit flag 固定为 0x0800（EFS）；
 * - CRC-32 在 addFile 时立即计算并缓存，buildParts() 直接复用数据引用；
 * - 顶层不访问 window / document，可在浏览器与 Node 18+ 中运行。
 */

/** 经典 ZIP 的 32 位无符号上限（单文件大小 / 累计数据量上限 4 GiB - 1）。 */
const MAX_UINT32 = 0xFFFFFFFF;

/** General purpose bit flag：文件名为 UTF-8（EFS）。 */
const FLAG_UTF8 = 0x0800;

/** 256 项 CRC-32 查表（反射多项式 0xEDB88320），模块加载时构建一次。 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 模块级共享的 UTF-8 编码器。 */
const UTF8_ENCODER = new TextEncoder();

/**
 * 计算标准 ZIP CRC-32（多项式 0xEDB88320 反射版，初值与终值均异或 0xFFFFFFFF）。
 * @param {Uint8Array|ArrayBuffer} bytes 待计算的数据
 * @returns {number} 无符号 32 位整数
 */
export function crc32(bytes) {
  const data = normalizeCrcInput(bytes);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 把 crc32 的输入统一成 Uint8Array 视图（ArrayBuffer 不复制内容）。 */
function normalizeCrcInput(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  throw new TypeError('crc32 只接受 Uint8Array 或 ArrayBuffer');
}

/**
 * 把字符串编码为 UTF-8 字节。
 * @param {string} str 任意字符串（含中文、emoji 等）
 * @returns {Uint8Array} UTF-8 字节
 */
export function encodeUtf8(str) {
  if (typeof str !== 'string') throw new TypeError('encodeUtf8 只接受字符串');
  return UTF8_ENCODER.encode(str);
}

/**
 * 生成 MS-DOS 格式的日期与时间整数（ZIP 头部使用）。
 * time = (hour << 11) | (minute << 5) | (second >> 1)
 * date = ((year - 1980) << 9) | ((month + 1) << 5) | day
 * 年份会被钳制到 [1980, 2107]。
 * @param {Date} [date] 默认当前时间
 * @returns {{time: number, date: number}}
 */
export function dosDateTime(date = new Date()) {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;
  if (year > 2107) year = 2107;
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/** 把 addFile 的内容参数统一成 Uint8Array（字符串编码，ArrayBuffer 仅包装）。 */
function toBytes(data) {
  if (typeof data === 'string') return encodeUtf8(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('文件内容必须是 string、Uint8Array 或 ArrayBuffer');
}

/**
 * store-only ZIP 写入器：按添加顺序收集文件，最终一次性生成完整字节流。
 */
export class ZipWriter {
  #entries = [];

  #maxEntries;

  #maxTotalBytes;

  #now;

  /** 所有条目数据字节数之和（不含头部），即 get totalBytes 的含义。 */
  #totalBytes = 0;

  /** 已累计的 local 区字节数（local header + 文件名 + 数据）。 */
  #localBytes = 0;

  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries=65535] 条目数上限
   * @param {number} [options.maxTotalBytes=4294967295] 数据总字节数上限
   * @param {() => Date} [options.now] 默认时间来源（便于测试注入）
   */
  constructor(options = {}) {
    const {
      maxEntries = 0xFFFF,
      maxTotalBytes = MAX_UINT32,
      now = () => new Date(),
    } = options;
    this.#maxEntries = maxEntries;
    this.#maxTotalBytes = maxTotalBytes;
    this.#now = now;
  }

  /** 当前条目数。 */
  get entryCount() {
    return this.#entries.length;
  }

  /** 当前所有条目数据字节数之和（不含 ZIP 头部）。 */
  get totalBytes() {
    return this.#totalBytes;
  }

  /**
   * 添加一个文件条目。
   * @param {string} name 条目路径名（非空字符串）
   * @param {string|Uint8Array|ArrayBuffer} data 文件内容
   * @param {{date?: Date}} [options]
   * @returns {{name: string, size: number, crc: number, offset: number}}
   */
  addFile(name, data, options = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('文件名必须是非空字符串');
    }
    const nameBytes = encodeUtf8(name);
    if (nameBytes.length > 0xFFFF) {
      throw new Error(
        `文件名 UTF-8 编码后为 ${nameBytes.length} 字节，超过 65535，ZIP 格式无法表示`,
      );
    }
    if (this.#entries.length >= this.#maxEntries) {
      throw new Error(`ZIP 条目数超过上限 ${this.#maxEntries}，请分批导出`);
    }
    const bytes = toBytes(data);
    const size = bytes.length;
    if (size > MAX_UINT32) {
      throw new Error('单个文件大小超过 0xFFFFFFFF（4 GiB - 1 字节），ZIP 格式无法表示');
    }
    if (this.#totalBytes + size > this.#maxTotalBytes) {
      throw new Error(
        `ZIP 累计数据总字节数超过 4 GiB 上限（${this.#maxTotalBytes} 字节），请分批导出`,
      );
    }
    const when = options.date === undefined ? this.#now() : options.date;
    if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
      throw new Error('date 必须是有效的 Date 实例');
    }
    const nextLocalBytes = this.#localBytes + 30 + nameBytes.length + size;
    if (nextLocalBytes > MAX_UINT32) {
      throw new Error('ZIP 文件总字节数超过 4 GiB 上限，请分批导出');
    }
    const { time, date } = dosDateTime(when);
    const entry = {
      name,
      nameBytes,
      size,
      crc: crc32(bytes),
      time,
      date,
      offset: this.#localBytes,
      data: bytes,
    };
    this.#entries.push(entry);
    this.#localBytes = nextLocalBytes;
    this.#totalBytes += size;
    return { name, size, crc: entry.crc, offset: entry.offset };
  }

  /** 返回条目元数据副本（顺序与添加顺序一致）。 */
  listEntries() {
    return this.#entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      crc: entry.crc,
      offset: entry.offset,
    }));
  }

  /**
   * 生成完整 ZIP 字节流的分片数组（顺序：各 local 区、中央目录、EOCD）。
   * 数据分片复用 addFile 时保存的 Uint8Array 引用，不做复制。
   * @returns {Uint8Array[]}
   */
  buildParts() {
    const parts = [];
    const centralParts = [];
    let localOffset = 0;
    let centralSize = 0;

    for (const entry of this.#entries) {
      const nameLen = entry.nameBytes.length;
      // ---- local file header（30 字节 + 文件名 + 数据）----
      const local = new Uint8Array(30 + nameLen);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // 签名
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, FLAG_UTF8, true); // general purpose bit flag
      lv.setUint16(8, 0, true); // 压缩方法：0 = STORE
      lv.setUint16(10, entry.time, true); // DOS 时间
      lv.setUint16(12, entry.date, true); // DOS 日期
      lv.setUint32(14, entry.crc, true); // CRC-32
      lv.setUint32(18, entry.size, true); // 压缩后大小
      lv.setUint32(22, entry.size, true); // 原始大小
      lv.setUint16(26, nameLen, true); // 文件名长度
      lv.setUint16(28, 0, true); // extra 长度
      local.set(entry.nameBytes, 30);
      parts.push(local, entry.data);

      // ---- central directory header（46 字节 + 文件名）----
      const central = new Uint8Array(46 + nameLen);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // 签名
      cv.setUint16(4, 0x0014, true); // version made by（3.0）
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, FLAG_UTF8, true); // general purpose bit flag
      cv.setUint16(10, 0, true); // 压缩方法：STORE
      cv.setUint16(12, entry.time, true); // DOS 时间
      cv.setUint16(14, entry.date, true); // DOS 日期
      cv.setUint32(16, entry.crc, true); // CRC-32
      cv.setUint32(20, entry.size, true); // 压缩后大小
      cv.setUint32(24, entry.size, true); // 原始大小
      cv.setUint16(28, nameLen, true); // 文件名长度
      cv.setUint16(30, 0, true); // extra 长度
      cv.setUint16(32, 0, true); // comment 长度
      cv.setUint16(34, 0, true); // 起始磁盘号
      cv.setUint16(36, 0, true); // internal attributes
      cv.setUint32(38, 0, true); // external attributes
      cv.setUint32(42, entry.offset, true); // local header 偏移
      central.set(entry.nameBytes, 46);
      centralParts.push(central);

      centralSize += central.length;
      localOffset += local.length + entry.size;
    }

    const cdOffset = localOffset;
    // ---- EOCD（22 字节，无注释）----
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // 签名
    ev.setUint16(4, 0, true); // 本磁盘号
    ev.setUint16(6, 0, true); // 中央目录所在磁盘号
    ev.setUint16(8, this.#entries.length, true); // 本磁盘条目数
    ev.setUint16(10, this.#entries.length, true); // 总条目数
    ev.setUint32(12, centralSize, true); // 中央目录大小
    ev.setUint32(16, cdOffset, true); // 中央目录偏移
    ev.setUint16(20, 0, true); // 注释长度

    return [...parts, ...centralParts, eocd];
  }

  /**
   * 生成完整 ZIP 字节流（把所有分片拼成一个 Uint8Array）。
   * @returns {Uint8Array}
   */
  buildBytes() {
    const parts = this.buildParts();
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /**
   * 生成 ZIP Blob（仅在调用时引用全局 Blob，避免顶层副作用）。
   * @returns {Blob}
   */
  buildBlob() {
    return new Blob(this.buildParts(), { type: 'application/zip' });
  }
}
