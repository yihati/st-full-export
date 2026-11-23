/**
 * 聊天枚举与聚合。
 *
 * 设计要点（基于 SillyTavern 1.15.0 与 1.19.1 源码核对，见 README「兼容性」）：
 *  - 角色列表优先用 ctx.characters，空则 POST /api/characters/all；
 *  - 每个角色用 POST /api/characters/chats 列聊天，再用 POST /api/chats/get 逐条读取；
 *  - 群聊用 ctx.groups（空则 POST /api/groups/all），对 group.chats[] 逐个
 *    POST /api/chats/group/get；
 *  - .jsonl 的第一行是 metadata（chat_metadata），服务端不剥离，这里统一剥离；
 *  - 单条聊天失败只记录 failures，不中断整体导出；
 *  - 所有排序都是显式的、稳定的，保证同一份数据多次导出结果可复现。
 */

import { runPool } from './pool.js';
import { describeError, isAbortError, isAuthFailure, isPlainObject, throwIfAborted, truncateText } from './util.js';
import { buildExportFileName, createChatSink } from './format.js';

/** 聊天内容读取并发数。 */
const CHAT_READ_CONCURRENCY = 4;
/** last_message 预览截断长度。 */
const LAST_MESSAGE_PREVIEW = 300;

/**
 * 判断接口返回的某一项是否是聊天文件的 metadata（header）行。
 *
 * ST 1.15.0 起保存聊天时会在首行写入：
 *   { chat_metadata, user_name: 'unused', character_name: 'unused' }
 * 但旧版本（以及旧版本创建、从未被 1.15 重写过的聊天文件）没有这一行，
 * 首行就是普通消息。因此这里按内容探测，且带 mes 的一律当消息，绝不盲删首行。
 */
export function isMetadataLine(item) {
    if (!isPlainObject(item)) {
        return false;
    }
    // 普通消息一定带 mes（可能是空字符串），有 mes 就不是 header。
    if (Object.hasOwn(item, 'mes')) {
        return false;
    }
    if (isPlainObject(item.chat_metadata)) {
        return true;
    }
    return Object.hasOwn(item, 'create_date')
        || Object.hasOwn(item, 'user_name')
        || Object.hasOwn(item, 'character_name');
}

/**
 * 统一聊天接口返回结构。/api/chats/get 与 /api/chats/group/get 在 1.15/1.19
 * 正常返回数组；这里同时兼容 { messages: [...] }、{}、null 等形态，便于跨版本。
 *
 * `invalid` 为 true 表示响应既不是数组、也不是 { messages: [...] }：
 * 调用方必须把它记为失败，而不能当成“空聊天”跳过，否则会静默丢数据。
 *
 * @returns {{chat_metadata: object, messages: object[], hasHeader: boolean, hasMetadataBlock: boolean, invalid: boolean}}
 */
export function parseChatPayload(payload) {
    const payloadMetadata = isPlainObject(payload) && isPlainObject(payload.chat_metadata)
        ? payload.chat_metadata
        : null;
    const isMessagesObject = isPlainObject(payload) && Array.isArray(payload.messages);
    const rawMessages = Array.isArray(payload)
        ? payload
        : (isMessagesObject ? payload.messages : null);

    if (!rawMessages) {
        return {
            chat_metadata: payloadMetadata ?? {},
            messages: [],
            hasHeader: false,
            hasMetadataBlock: payloadMetadata !== null,
            invalid: true,
        };
    }

    const items = rawMessages.filter((item) => isPlainObject(item));
    if (items.length === 0) {
        return {
            chat_metadata: payloadMetadata ?? {},
            messages: [],
            hasHeader: false,
            hasMetadataBlock: payloadMetadata !== null,
            invalid: false,
        };
    }

    if (isMetadataLine(items[0])) {
        const headerMetadata = isPlainObject(items[0].chat_metadata) ? items[0].chat_metadata : {};
        return {
            chat_metadata: payloadMetadata ?? headerMetadata,
            messages: items.slice(1),
            hasHeader: true,
            hasMetadataBlock: payloadMetadata !== null,
            invalid: false,
        };
    }

    return {
        chat_metadata: payloadMetadata ?? {},
        messages: items,
        hasHeader: false,
        hasMetadataBlock: payloadMetadata !== null,
        invalid: false,
    };
}

/** 把 /api/characters/chats 的返回数组规范化为内部条目。 */
export function normalizeChatEntries(rawList) {
    if (!Array.isArray(rawList)) {
        return [];
    }
    const seen = new Set();
    const entries = [];
    for (const raw of rawList) {
        if (!isPlainObject(raw)) {
            continue;
        }
        let fileName = typeof raw.file_name === 'string' ? raw.file_name : '';
        let fileId = typeof raw.file_id === 'string' ? raw.file_id : '';
        if (!fileId && fileName) {
            fileId = fileName.replace(/\.jsonl$/i, '');
        }
        if (!fileName && fileId) {
            fileName = `${fileId}.jsonl`;
        }
        if (!fileId) {
            continue;
        }
        if (seen.has(fileId)) {
            continue;
        }
        seen.add(fileId);
        entries.push({
            file_name: fileName,
            file_id: fileId,
            chat_items: Number.isFinite(raw.chat_items) ? raw.chat_items : null,
            mes: typeof raw.mes === 'string' ? raw.mes : '',
            last_mes: raw.last_mes ?? null,
            chat_metadata: isPlainObject(raw.chat_metadata) ? raw.chat_metadata : {},
        });
    }
    return entries;
}

/** 角色对象规范化：保留导出需要的 name / avatar，以及判断“是否本来就有聊天”的统计字段。 */
export function normalizeCharacters(rawList) {
    if (!Array.isArray(rawList)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const raw of rawList) {
        if (!isPlainObject(raw)) {
            continue;
        }
        const avatar = typeof raw.avatar === 'string' ? raw.avatar.trim() : '';
        if (!avatar || seen.has(avatar)) {
            continue;
        }
        seen.add(avatar);
        result.push({
            name: typeof raw.name === 'string' && raw.name ? raw.name : avatar.replace(/\.png$/i, ''),
            avatar,
            // 用于区分“这个角色本来就没有聊天”和“列表接口异常”。
            chat_size: Number.isFinite(raw.chat_size) ? raw.chat_size : 0,
            date_last_chat: raw.date_last_chat ?? null,
        });
    }
    return result;
}

/** 角色是否有聊天证据（列表接口异常时决定记 failure 还是静默当无聊天）。 */
function characterHasChatEvidence(character) {
    if (!character) {
        return false;
    }
    if (Number.isFinite(character.chat_size) && character.chat_size > 0) {
        return true;
    }
    const last = character.date_last_chat;
    if (typeof last === 'number') {
        return Number.isFinite(last) && last > 0;
    }
    return typeof last === 'string' && last.trim() !== '';
}

/** 群组对象规范化。 */
export function normalizeGroups(rawList) {
    if (!Array.isArray(rawList)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const raw of rawList) {
        if (!isPlainObject(raw)) {
            continue;
        }
        const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        const members = Array.isArray(raw.members) ? raw.members.filter((m) => typeof m === 'string') : [];
        result.push({
            id,
            name: typeof raw.name === 'string' && raw.name ? raw.name : `群组 ${id}`,
            members,
            // 群聊 id 列表必须保留：/api/groups/all 里 chats 与 chat_id 都可能存在。
            chats: Array.isArray(raw.chats) ? raw.chats.slice() : [],
            chat_id: raw.chat_id ?? null,
        });
    }
    return result;
}

/**
 * 群聊 id 列表：group.chats 并上 group.chat_id（去重）；两者都没有时退回 group.id。
 * 群聊文件名就是 `${chatId}.jsonl`。
 *
 * group.chats 的元素常见是字符串，但某些版本/数据里可能是对象
 * （如 { file_name, file_id, id, chat_id }），这里统一提取成 id 字符串，
 * 避免 String(object) 变成 "[object Object]" 导致读取失败。
 */
export function collectGroupChatIds(group) {
    const ids = [];
    const seen = new Set();

    /** 把字符串/数字/对象统一成候选 id 字符串。 */
    const toIdCandidate = (value) => {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string' || typeof value === 'number') {
            return String(value).trim();
        }
        if (isPlainObject(value)) {
            for (const key of ['file_name', 'file_id', 'id', 'chat_id']) {
                const candidate = value[key];
                if (typeof candidate === 'string' && candidate.trim()) {
                    return candidate.trim();
                }
                if (typeof candidate === 'number' && Number.isFinite(candidate)) {
                    return String(candidate);
                }
            }
        }
        return '';
    };

    const push = (value) => {
        let id = toIdCandidate(value);
        if (!id) {
            return;
        }
        // 群聊文件名带 .jsonl；统一成不带后缀的 chat id。
        id = id.replace(/\.jsonl$/i, '').trim();
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        ids.push(id);
    };
    if (Array.isArray(group?.chats)) {
        group.chats.forEach(push);
    }
    push(group?.chat_id);
    // 1.15 的前端 getGroups() 会给每个 group 补 chat_id / chats，
    // 但 /api/groups/all 返回的原始 group JSON 可能两者都没有；
    // 此时退回 group.id（聊天文件名默认就是 `${group.id}.jsonl`）。
    if (ids.length === 0) {
        push(group?.id);
    }
    return ids;
}

/** 字符串比较：中文按拼音/笔画排序（localeCompare('zh')），再退回码点比较保证稳定。 */
export function compareText(a, b) {
    const left = String(a ?? '');
    const right = String(b ?? '');
    const primary = left.localeCompare(right, 'zh');
    if (primary !== 0) {
        return primary;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

// 旧版 SillyTavern 的 humanized 时间戳：2024-1-1@12h00m00s123ms（毫秒部分可省略）
const HUMANIZED_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(?:(\d{1,3})ms)?$/;

/**
 * 解析时间戳（仅用于排序，不会修改导出的原始数据）；无效返回 null。
 * 支持毫秒数、ISO 字符串、1.15 之前的 humanized 字符串（含无 ms 形式）、
 * 数字字符串时间戳，以及 /api/characters/chats 返回的数字 mtime。
 */
function parseTime(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    const text = String(value).trim();
    if (!text) {
        return null;
    }
    // 纯数字字符串：长度达到毫秒时间戳量级才按数字时间处理，避免把年份当毫秒。
    if (/^\d{11,}$/.test(text)) {
        return Number(text);
    }
    const isoTime = Date.parse(text);
    if (Number.isFinite(isoTime)) {
        return isoTime;
    }
    const match = text.match(HUMANIZED_DATE_PATTERN);
    if (match) {
        const [, year, month, day, hour, minute, second, millisecond] = match;
        const time = new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
            Number(millisecond ?? 0),
        ).getTime();
        return Number.isFinite(time) ? time : null;
    }
    return null;
}

/**
 * 聊天条目排序：last_mes 倒序（新的在前）；时间无效的排在有效之后；
 * 时间相同时按 file_name 升序，保证稳定可复现。
 */
export function compareChatEntries(a, b) {
    const left = parseTime(a?.last_mes);
    const right = parseTime(b?.last_mes);
    if (left !== right) {
        if (left === null) {
            return 1;
        }
        if (right === null) {
            return -1;
        }
        return right - left;
    }
    return compareText(a?.file_name, b?.file_name);
}

/**
 * 群聊 id 排序：按可解析的时间戳倒序（新的在前），其余按字符串倒序。
 * 1.15 的群聊 id 是 humanizedDateTime()（如 2024-1-1@12h00m00s123ms），
 * 早期版本是毫秒时间戳数字；两者都按“从新到旧”排列。
 */
export function compareGroupChatIds(a, b) {
    const left = parseTime(a);
    const right = parseTime(b);
    if (left !== right) {
        if (left === null) {
            return 1;
        }
        if (right === null) {
            return -1;
        }
        return right - left;
    }
    if (left === null) {
        return compareText(b, a);
    }
    return compareText(String(b ?? ''), String(a ?? ''));
}

/** ST 在空聊天/空消息时使用的占位符，不算“列表证明有内容”。 */
const EMPTY_MES_PLACEHOLDERS = new Set(['[The chat is empty]', '[The message is empty]']);

function isPlaceholderMes(value) {
    return typeof value === 'string' && EMPTY_MES_PLACEHOLDERS.has(value.trim());
}

/** 取最后一条消息的文本预览。 */
function computeLastMessage(messages, fallback) {    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (isPlainObject(message) && typeof message.mes === 'string' && message.mes.trim()) {
            return truncateText(message.mes, LAST_MESSAGE_PREVIEW);
        }
    }
    if (typeof fallback === 'string' && fallback.trim()) {
        return truncateText(fallback, LAST_MESSAGE_PREVIEW);
    }
    return '';
}

/** 安全调用进度回调：UI 出错不应影响导出。 */
function makeReporter(onProgress) {
    return (payload) => {
        if (typeof onProgress !== 'function') {
            return;
        }
        try {
            onProgress(payload);
        } catch (error) {
            console.error('[全量导出] 进度回调异常', error);
        }
    };
}

/** 失败项排序，保证输出稳定。 */
function sortFailures(failures) {
    return failures.slice().sort((a, b) => {
        const scope = compareText(a.scope, b.scope);
        if (scope !== 0) {
            return scope;
        }
        const name = compareText(a.name, b.name);
        if (name !== 0) {
            return name;
        }
        return compareText(a.file_name, b.file_name);
    });
}

/**
 * 枚举并读取全部聊天，返回按稳定顺序排列的记录数组与失败清单。
 *
 * @param {object} options
 * @param {object} options.api              createApi() 返回的 API 封装
 * @param {boolean} [options.includeGroupChats=true]
 * @param {(p:{phase:string,current:number,total:number,message:string}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function collectAllChatRecords({ api, includeGroupChats = true, onProgress, signal } = {}) {
    throwIfAborted(signal);
    const report = makeReporter(onProgress);
    const failures = [];

    report({ phase: 'characters', current: 0, total: 0, message: '正在读取角色列表…' });

    let characters;
    try {
        characters = normalizeCharacters(await api.getCharacters({ signal }));
    } catch (error) {
        if (isAbortError(error) || isAuthFailure(error)) {
            // 登录 / CSRF 失效直接抛出原始错误（保留 kind/status 供 UI 提示）。
            throw error;
        }
        throw new Error(`读取角色列表失败：${describeError(error)}`);
    }

    // 1) 逐个角色列出聊天文件（角色多时并发 4 个请求）。
    const chatEntriesByIndex = new Array(characters.length).fill(null);
    let listed = 0;
    report({
        phase: 'chat-list',
        current: 0,
        total: characters.length,
        message: `正在读取角色聊天列表（0/${characters.length}）…`,
    });
    await runPool(characters, async (character, index) => {
        throwIfAborted(signal);
        try {
            const list = await api.listCharacterChats(character.avatar, { signal });
            if (list === null) {
                // 服务端返回 { error: true } 或非数组：目录不存在是正常情况，
                // 但角色统计显示确实有聊天时就是异常，必须留下失败记录。
                if (characterHasChatEvidence(character)) {
                    failures.push({
                        scope: 'character',
                        name: character.name,
                        file_name: character.avatar,
                        reason: '读取聊天列表失败：服务端返回异常数据（error: true）',
                    });
                }
                chatEntriesByIndex[index] = [];
            } else {
                chatEntriesByIndex[index] = normalizeChatEntries(list);
            }
        } catch (error) {
            if (isAbortError(error) || isAuthFailure(error)) {
                // 会话失效不能降级成单角色失败，否则会导出空文件。
                throw error;
            }
            chatEntriesByIndex[index] = [];
            failures.push({
                scope: 'character',
                name: character.name,
                file_name: character.avatar,
                reason: `读取聊天列表失败：${describeError(error)}`,
            });
        }
        listed += 1;
        report({
            phase: 'chat-list',
            current: listed,
            total: characters.length,
            message: `正在读取角色聊天列表（${listed}/${characters.length}）…`,
        });
    }, { concurrency: CHAT_READ_CONCURRENCY, signal });

    // 2) 群组列表（可选）。
    let groups = [];
    if (includeGroupChats) {
        try {
            groups = normalizeGroups(await api.getGroups({ signal }));
        } catch (error) {
            if (isAbortError(error) || isAuthFailure(error)) {
                throw error;
            }
            failures.push({
                scope: 'group',
                name: '群组列表',
                file_name: '',
                reason: `读取群组列表失败：${describeError(error)}`,
            });
        }
    }

    // 3) 按稳定顺序构造读取任务。
    const tasks = [];
    const characterUnits = characters
        .map((character, index) => ({ character, entries: (chatEntriesByIndex[index] ?? []).slice() }))
        .sort((a, b) => compareText(a.character.name, b.character.name));
    for (const unit of characterUnits) {
        unit.entries.sort(compareChatEntries);
        for (const entry of unit.entries) {
            tasks.push({
                kind: 'character',
                character: unit.character,
                file_name: entry.file_name,
                file_id: entry.file_id,
                chat_metadata: entry.chat_metadata,
                chat_items: entry.chat_items,
                mes: entry.mes,
            });
        }
    }
    const groupUnits = groups
        .map((group) => ({ group, chatIds: collectGroupChatIds(group).sort(compareGroupChatIds) }))
        .sort((a, b) => compareText(a.group.name, b.group.name) || compareText(a.group.id, b.group.id));
    for (const unit of groupUnits) {
        for (const chatId of unit.chatIds) {
            tasks.push({
                kind: 'group',
                group: unit.group,
                file_name: `${chatId}.jsonl`,
                file_id: chatId,
                chat_metadata: {},
                mes: '',
            });
        }
    }

    // 4) 逐条读取聊天内容。
    const records = new Array(tasks.length).fill(null);
    let read = 0;
    let skippedEmpty = 0;
    report({
        phase: 'chats',
        current: 0,
        total: tasks.length,
        message: tasks.length ? `正在读取聊天内容（0/${tasks.length}）…` : '没有需要读取的聊天',
    });
    await runPool(tasks, async (task, index) => {
        throwIfAborted(signal);
        try {
            const payload = task.kind === 'character'
                ? await api.getCharacterChat(task.character.avatar, task.file_id, task.character.name, { signal })
                : await api.getGroupChat(task.file_id, { signal });
            const parsed = parseChatPayload(payload);
            if (parsed.invalid) {
                // 非数组、也不是 { messages: [...] }（如 200 {}、HTML 被代理改写、
                // 连接截断）：绝不能当成空聊天静默跳过。
                throw new Error('读取聊天返回异常响应（非数组且缺少 messages），可能是代理改写或连接中断');
            }
            const metadataFromPayload = isPlainObject(parsed.chat_metadata) ? parsed.chat_metadata : {};
            const listingMetadata = isPlainObject(task.chat_metadata) ? task.chat_metadata : {};
            const chatMetadata = Object.keys(metadataFromPayload).length > 0
                ? metadataFromPayload
                : listingMetadata;
            const hasMetadata = Object.keys(chatMetadata).length > 0;
            const messages = parsed.messages;
            const baseRecord = {
                kind: task.kind,
                character: task.kind === 'character'
                    ? { name: task.character.name, avatar: task.character.avatar }
                    : null,
                group: task.kind === 'group'
                    ? { id: task.group.id, name: task.group.name, members: task.group.members.slice() }
                    : null,
                file_name: task.file_name,
                file_id: task.file_id,
                chat_metadata: chatMetadata,
            };

            if (messages.length === 0) {
                // 聊天列表已证明有内容（chat_items>0，或最后消息预览非空且不是占位符），
                // 但读取结果为空：必须记失败，不能计入 skipped_empty。
                const hasListingEvidence = Number(task.chat_items) > 0
                    || (typeof task.mes === 'string'
                        && task.mes.trim() !== ''
                        && !isPlaceholderMes(task.mes));
                if (hasListingEvidence) {
                    throw new Error('索引显示有消息但读取为空（可能被代理改写或文件损坏）');
                }
                // 空聊天：0 消息且没有可保留的 metadata → 跳过并计数；
                // 只有 header（或 {messages:[], chat_metadata} 结构）且 metadata 非空
                // → 保留为 header_only 记录，不丢聊天元数据。
                const keepHeaderOnly = hasMetadata && (parsed.hasHeader || parsed.hasMetadataBlock);
                if (keepHeaderOnly) {
                    records[index] = {
                        ...baseRecord,
                        messages: [],
                        message_count: 0,
                        last_message: '',
                        header_only: true,
                    };
                } else {
                    records[index] = null;
                    skippedEmpty += 1;
                }
            } else {
                records[index] = {
                    ...baseRecord,
                    messages,
                    message_count: messages.length,
                    last_message: computeLastMessage(messages, task.mes),
                };
            }
        } catch (error) {
            if (isAbortError(error) || isAuthFailure(error)) {
                throw error;
            }
            records[index] = null;
            failures.push({
                scope: task.kind,
                name: task.kind === 'character' ? task.character.name : task.group.name,
                file_name: task.file_name,
                reason: describeError(error),
            });
        }
        read += 1;
        report({
            phase: 'chats',
            current: read,
            total: tasks.length,
            message: `正在读取聊天内容（${read}/${tasks.length}）…`,
        });
    }, { concurrency: CHAT_READ_CONCURRENCY, signal });

    throwIfAborted(signal);

    const finalFailures = sortFailures(failures);
    return {
        records: records.filter(Boolean),
        failures: finalFailures,
        stats: {
            characters: characters.length,
            groups: groups.length,
            skipped_empty: skippedEmpty,
        },
    };
}

/**
 * 一键导出全部对话：产出单个文件（JSON / JSONL / TXT）。
 *
 * @returns {Promise<{blob: Blob, fileName: string, stats: object, failures: Array}>}
 */
export async function exportAllChats({
    api,
    format = 'json',
    includeGroupChats = true,
    onProgress,
    signal,
    now = () => new Date(),
} = {}) {
    if (!api || typeof api.getCharacters !== 'function') {
        throw new Error('导出失败：缺少 SillyTavern API 封装');
    }
    const exportedAt = typeof now === 'function' ? now() : now;
    const report = makeReporter(onProgress);

    const { records, failures, stats: baseStats } = await collectAllChatRecords({
        api,
        includeGroupChats,
        onProgress,
        signal,
    });

    const sinkStats = {
        characters: baseStats.characters,
        groups: baseStats.groups,
        skipped_empty: baseStats.skipped_empty ?? 0,
    };
    const sink = createChatSink({ format, exportedAt, stats: sinkStats });
    for (const record of records) {
        sink.addRecord(record);
    }
    const blob = sink.finish(failures);
    const skippedText = sinkStats.skipped_empty > 0 ? `，跳过空聊天 ${sinkStats.skipped_empty} 条` : '';
    report({
        phase: 'done',
        current: records.length,
        total: records.length,
        message: `聊天导出完成：${sinkStats.chats} 条聊天，${sinkStats.messages} 条消息${skippedText}`,
    });

    return {
        blob,
        fileName: buildExportFileName('sillytavern-chats', format, exportedAt),
        stats: sinkStats,
        failures,
        exportedAt,
    };
}
