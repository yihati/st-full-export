/**
 * SillyTavern 全量导出 —— 导出格式模块
 *
 * 负责把 chats.js 收集到的聊天记录序列化为 JSON / JSONL / TXT 三种格式，
 * 并以 Blob 形式返回（浏览器可直接下载，Node 18+ 可交给 fs 写盘）。
 *
 * 设计约束：
 * - 纯 ESM、零第三方依赖；
 * - 顶层只引用 Blob / TextEncoder 等 Node 与浏览器都提供的全局量；
 * - 不访问 window / document，便于在 Node 中直接做单元测试。
 */

/** 生成器标识，写入 JSON 的 generator 字段 */
export const GENERATOR = 'st-full-export 1.0.0';

/** 支持的单文件对话导出格式 */
export const CHAT_FORMATS = Object.freeze(['json', 'jsonl', 'txt']);

/** 80 个短横线：聊天块内消息区与头部之间的分隔线 */
const DASH_LINE = '-'.repeat(80);
/** 80 个等号：头部与聊天块之间、聊天块之间、失败汇总之前的分隔线 */
const EQUALS_LINE = '='.repeat(80);

/** 失败项 scope 到中文的映射 */
const FAILURE_SCOPE_LABELS = Object.freeze({
  character: '角色',
  group: '群聊',
  file: '文件',
  card: '角色卡',
  zip: '打包',
});

/** 两位数补零（例：3 -> '03'） */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把任意可解析的时间值转成合法 Date，无法解析时返回 null。
 * 空字符串、null、undefined、NaN、非法字符串都会得到 null。
 */
function toValidDate(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 安全计数：仅接受有限数值，其余按 0 处理 */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 安全取字符串，用于标题等展示字段 */
function textOf(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * 本地时间格式化：'YYYY-MM-DD HH:mm:ss'
 * 非法日期返回空字符串。
 */
export function formatDateTime(date = new Date()) {
  const parsed = toValidDate(date);
  if (!parsed) {
    return '';
  }
  return [
    `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`,
    `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}:${pad2(parsed.getSeconds())}`,
  ].join(' ');
}

/**
 * 文件名时间戳：本地时间 'YYYYMMDD-HHmmss'
 * 非法日期抛 Error('无效的导出时间')。
 */
export function buildFileStamp(date = new Date()) {
  const parsed = toValidDate(date);
  if (!parsed) {
    throw new Error('无效的导出时间');
  }
  return [
    `${parsed.getFullYear()}${pad2(parsed.getMonth() + 1)}${pad2(parsed.getDate())}`,
    `${pad2(parsed.getHours())}${pad2(parsed.getMinutes())}${pad2(parsed.getSeconds())}`,
  ].join('-');
}

/**
 * 生成导出文件名：`${prefix}-${时间戳}.${ext}`
 * 例：sillytavern-chats-20240102-030405.json
 */
export function buildExportFileName(prefix, ext, date = new Date()) {
  return `${prefix}-${buildFileStamp(date)}.${ext}`;
}

/**
 * 格式化消息时间：支持 ISO 字符串、毫秒数、Date 以及 send_date 语义的值。
 * 返回本地时间 'YYYY-MM-DD HH:mm:ss'；
 * 无法解析但本身是非空字符串时原样返回（旧版 humanized 时间戳，如
 * '2024-1-1@12h00m00s123ms'，保持原样不转换）；其余返回 ''。
 */
export function formatMessageTime(value) {
  const parsed = toValidDate(value);
  if (parsed) {
    return formatDateTime(parsed);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return '';
}

/** 群聊标题：[群聊] 群名（3 名成员） */
function formatGroupTitle(record) {
  const group = record?.group ?? {};
  const members = Array.isArray(group.members) ? group.members.length : 0;
  return `[群聊] ${textOf(group.name, '未知群聊')}（${members} 名成员）`;
}

/** 角色标题：[角色] 名字（avatar.png） */
function formatCharacterTitle(record) {
  const character = record?.character ?? {};
  return `[角色] ${textOf(character.name, '未知角色')}（${textOf(character.avatar, '未知头像')}）`;
}

/** 单条消息的发送者名称 */
function formatSender(message) {
  if (message && typeof message.name === 'string' && message.name !== '') {
    return message.name;
  }
  return message?.is_user ? '用户' : '未知';
}

/**
 * TXT 头部：标题、导出时间、统计、说明，最后以 80 个等号与空行收尾。
 * 参数：{ exportedAt = new Date(), stats = {} }
 */
export function formatTxtHeader({ exportedAt = new Date(), stats = {} } = {}) {
  const characters = countOf(stats.characters);
  const groups = countOf(stats.groups);
  const chats = countOf(stats.chats);
  const messages = countOf(stats.messages);
  const failures = countOf(stats.failures);
  const skippedEmpty = countOf(stats.skipped_empty);
  const exportedText = formatDateTime(exportedAt) || '未知时间';
  const skippedText = skippedEmpty > 0 ? `，空聊天跳过 ${skippedEmpty} 条` : '';
  return [
    'SillyTavern 全量对话导出',
    `导出时间：${exportedText}`,
    `统计：角色 ${characters} 个，群聊 ${groups} 个，聊天 ${chats} 条，消息 ${messages} 条，失败 ${failures} 项${skippedText}`,
    '说明：每条消息仅包含当前 swipe 的内容；完整数据（含全部 swipe/extra 字段）请使用 JSON 格式导出。',
    EQUALS_LINE,
  ].join('\n') + '\n\n';
}

/**
 * TXT 单条聊天记录块：标题、聊天文件、消息数、短横线、逐条消息。
 * 消息格式：`[本地时间] 发送者：` + 换行 + 正文 + 空行。
 * 时间无法解析时写 `[未知时间]`，保持格式稳定。
 * 返回值以换行结尾（有消息时以空行结尾）。
 */
export function formatTxtRecord(record) {
  const isGroup = record?.kind === 'group';
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const messageCount = Number.isFinite(record?.message_count) ? record.message_count : messages.length;
  const lines = [
    isGroup ? formatGroupTitle(record) : formatCharacterTitle(record),
    `聊天文件：${textOf(record?.file_name, '未知文件')}`,
    `消息数：${messageCount}`,
  ];
  if (record?.header_only) {
    lines.push('（仅有聊天元数据，没有消息）');
  }
  lines.push(DASH_LINE);
  for (const message of messages) {
    const time = formatMessageTime(message?.send_date) || '未知时间';
    const sender = formatSender(message);
    const body = String(message?.mes ?? '');
    lines.push(`[${time}] ${sender}：`, body, '');
  }
  return lines.join('\n') + '\n';
}

/**
 * TXT 失败汇总段。失败为空时返回空字符串（不输出该段）。
 * 非空时形如：
 * ================================================================================
 * 失败汇总（2 项）
 * - [角色] Bad.png（file.jsonl）：HTTP 500
 */
export function formatTxtFooter(failures = []) {
  const list = Array.isArray(failures) ? failures : [];
  if (list.length === 0) {
    return '';
  }
  const lines = [EQUALS_LINE, `失败汇总（${list.length} 项）`];
  for (const failure of list) {
    const scope = FAILURE_SCOPE_LABELS[failure?.scope] ?? '未知';
    const filePart = typeof failure?.file_name === 'string' && failure.file_name !== '' ? `（${failure.file_name}）` : '';
    lines.push(`- [${scope}] ${textOf(failure?.name, '未知')}${filePart}：${textOf(failure?.reason, '未知错误')}`);
  }
  return lines.join('\n') + '\n';
}

/** 构造 JSON 导出 Blob：逐条记录 JSON.stringify，避免合成超大对象 */
function buildJsonBlob(records, failures, exportedAtIso, generator, statsSnapshot) {
  const chunks = [
    '{"format":"sillytavern-all-chats","format_version":1,',
    `"exported_at":${JSON.stringify(exportedAtIso)},`,
    `"generator":${JSON.stringify(generator)},`,
    `"stats":${JSON.stringify(statsSnapshot)},`,
    '"chats":[',
  ];
  for (let index = 0; index < records.length; index += 1) {
    if (index > 0) {
      chunks.push(',\n');
    }
    chunks.push(JSON.stringify(records[index]));
  }
  chunks.push('],');
  chunks.push(`"failures":${JSON.stringify(failures)}`);
  chunks.push('}\n');
  return new Blob(chunks, { type: 'application/json;charset=utf-8' });
}

/** 构造 JSONL 导出 Blob：每条记录一行，无外层包装，不写入失败项 */
function buildJsonlBlob(records) {
  const chunks = records.map((record) => `${JSON.stringify(record)}\n`);
  return new Blob(chunks, { type: 'application/x-ndjson;charset=utf-8' });
}

/** 构造 TXT 导出 Blob */
function buildTxtBlob(records, failures, exportedAt, statsSnapshot) {
  const chunks = [formatTxtHeader({ exportedAt, stats: statsSnapshot })];
  records.forEach((record, index) => {
    if (index > 0) {
      chunks.push(`${EQUALS_LINE}\n\n`);
    }
    chunks.push(`${formatTxtRecord(record).replace(/\n+$/, '')}\n\n`);
  });
  const footer = formatTxtFooter(failures);
  if (footer) {
    chunks.push(footer);
  }
  // 顶层文本统一以单个换行结尾，内部空行不受影响
  const text = chunks.join('').replace(/\n+$/, '') + '\n';
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

/**
 * 创建对话导出器（sink）。
 *
 * @param {object} options
 * @param {'json'|'jsonl'|'txt'} options.format 导出格式（必填）
 * @param {Date} [options.exportedAt] 导出时间，仅 JSON / TXT 使用
 * @param {string} [options.generator] 生成器标识
 * @param {object} [options.stats] 统计对象，会被原地更新；调用方预先设置 characters / groups
 * @returns {{ format: string, addRecord: (record: object) => void, finish: (failures?: object[]) => Blob }}
 */
export function createChatSink({ format, exportedAt = new Date(), generator = GENERATOR, stats = {} } = {}) {
  if (!CHAT_FORMATS.includes(format)) {
    throw new Error(`不支持的对话导出格式：${String(format)}`);
  }

  const counters = stats ?? {};
  counters.chats = countOf(counters.chats);
  counters.messages = countOf(counters.messages);
  counters.failures = countOf(counters.failures);
  counters.skipped_empty = countOf(counters.skipped_empty);

  const records = [];
  let finished = false;

  /** 累积一条聊天记录，并更新聊天数 / 消息数统计 */
  function addRecord(record) {
    records.push(record);
    counters.chats += 1;
    const messages = Array.isArray(record?.messages) ? record.messages : null;
    counters.messages += messages ? messages.length : countOf(record?.message_count);
  }

  /**
   * 结束导出并返回 Blob；只能调用一次，第二次调用抛 Error('导出器已结束')。
   * @param {object[]} [failures] 失败项列表
   */
  function finish(failures = []) {
    if (finished) {
      throw new Error('导出器已结束');
    }
    finished = true;

    const failureList = Array.isArray(failures) ? failures : [];
    counters.failures = failureList.length;

    const statsSnapshot = {
      characters: countOf(counters.characters),
      groups: countOf(counters.groups),
      chats: counters.chats,
      messages: counters.messages,
      failures: counters.failures,
      skipped_empty: counters.skipped_empty,
    };

    if (format === 'jsonl') {
      return buildJsonlBlob(records);
    }

    const exportedDate = toValidDate(exportedAt);
    if (!exportedDate) {
      throw new Error('无效的导出时间');
    }

    if (format === 'json') {
      return buildJsonBlob(records, failureList, exportedDate.toISOString(), generator, statsSnapshot);
    }

    return buildTxtBlob(records, failureList, exportedDate, statsSnapshot);
  }

  return { format, addRecord, finish };
}
