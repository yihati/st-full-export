/**
 * 角色卡 ZIP 导出。
 *
 * 每张角色卡下载的是磁盘上的**原始 PNG 字节**（GET /characters/<avatar>），
 * 不做任何重写，因此 PNG 的 tEXt chunk（关键字 chara / ccv3）完整保留，
 * 导出的图片可以原样拖回 SillyTavern 导入。
 *
 * ZIP 使用自实现的 store-only 写入器（PNG 本身已是压缩格式），不依赖 JSZip。
 */

import { ZipWriter } from './zip.js';
import { runPool } from './pool.js';
import { NameAllocator, pngBaseName, sanitizeZipFileName } from './names.js';
import { describeError, isAbortError, isAuthFailure, throwIfAborted } from './util.js';
import { buildExportFileName, formatDateTime } from './format.js';
import { compareText } from './chats.js';

/** 角色卡图片下载并发数。 */
const CARD_DOWNLOAD_CONCURRENCY = 4;
/** ZIP 内固定文件名。 */
export const INDEX_FILE_NAME = 'index.json';
export const README_FILE_NAME = 'README.txt';

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

/**
 * 角色列表规范化：保留导出需要的 name / avatar 与 json_data，
 * 按 avatar 去重（与 ST 的 /api/characters/all 语义一致）。
 * 注意：不保留 character.data —— lazyLoadCharacters 下它是 shallow 数据。
 */
function pickCharacters(rawList) {
    if (!Array.isArray(rawList)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const raw of rawList) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
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
            json_data: raw.json_data,
        });
    }
    return result;
}

/**
 * 从角色对象里提取卡 JSON 文本。
 *
 * 只信任 `json_data`（ST /api/characters/all 返回的整张卡原始 JSON 字符串，
 * 或 /api/characters/get 的完整结果）。**不要**用 `character.data` 兜底：
 * 在 performance.lazyLoadCharacters 开启时它是 shallow 数据，序列化后会得到
 * 残缺的卡 JSON。
 */
export function extractCardJsonText(character) {
    const jsonData = character?.json_data;
    if (typeof jsonData === 'string' && jsonData.trim()) {
        return prettyJson(jsonData);
    }
    if (jsonData && typeof jsonData === 'object') {
        return JSON.stringify(jsonData, null, 2);
    }
    return null;
}

/** 尽可能格式化 JSON 文本；解析失败时原样返回（仍可读）。 */
function prettyJson(text) {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

/** 生成 ZIP 内的 README.txt（UTF-8 中文说明）。 */
export function buildCharactersReadme({ exportedAt, count }) {
    const time = formatDateTime(exportedAt);
    return `SillyTavern 全量导出 —— 角色卡备份
================================================================================

导出时间：${time}
角色卡数量：${count}

这些是角色卡的**原始 PNG 文件**，可以直接拖回 SillyTavern 导入。

为什么可以直接导入？
  SillyTavern 把角色卡数据以 base64 形式写在 PNG 的 tEXt 文本块里
  （V2 卡关键字为 chara，V3 卡关键字为 ccv3）。本扩展下载的是服务器磁盘上的
  原始图片字节，没有重写、没有清洗，所以卡片的名称、描述、性格、场景、开场白、
  示例对话、世界书等数据都在。把 .png 文件拖进 SillyTavern 角色管理页面即可恢复。

怎么用？
  1. 解压本压缩包（正常解压即可，文件名已做 UTF-8 标记）。
  2. 打开 SillyTavern，进入「角色管理」。
  3. 把需要的 .png 文件直接拖入页面，或用「导入角色卡」逐张选择。
  4. 如果只想打开 JSON 卡数据，见下方 index.json / json/ 说明。

index.json 是什么？
  它记录了本次导出的时间、数量、每张卡的原始文件名（avatar）、在压缩包内的文件名
  （file）、文件大小，以及导出失败清单（failures）。它不参与导入，只是元数据。

json/ 目录？
  只有导出时勾选了「同时附带 JSON 卡数据」才会存在。每张卡对应一个 .json 文本，
  可用于查看、编辑或二次处理。SillyTavern 也支持导入 JSON 角色卡，但 JSON 无卡面图
  （导入后没有头像图片）；不同版本的 JSON 导入支持度略有差异。若要完整备份
  （卡面图 + 卡数据），请使用本压缩包里的 PNG。

注意
  * 本备份包含完整角色卡内容（可能包含私有字段），请妥善保管，不要随意分享。
  * 原始 PNG 可能保留 fav（收藏）、chat（上次打开的聊天文件）等本地字段，分享前请注意。
  * 若某张卡出现在 index.json 的 failures 里：可能是 PNG 下载失败（压缩包里没有该 PNG），
    也可能是「附带 JSON 卡数据」获取失败（PNG 仍在包里，只是缺少 json/<卡名>.json）。
  * 群聊、聊天记录不在本压缩包里，请使用扩展的「导出全部对话」功能。
`;
}

/** 生成 ZIP 内的 index.json 文本。 */
export function buildCharactersIndex({ exportedAt, generator, entries, failures }) {
    const payload = {
        format: 'sillytavern-characters',
        format_version: 1,
        exported_at: new Date(exportedAt).toISOString(),
        generator,
        count: entries.length,
        characters: entries,
        failures,
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * 导出全部角色卡为单个 ZIP。
 *
 * @param {object} options
 * @param {object} options.api                createApi() 返回的 API 封装
 * @param {boolean} [options.includeCardJson=false]
 * @param {(p:{phase:string,current:number,total:number,message:string}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {() => Date | Date} [options.now]
 * @returns {Promise<{blob: Blob, fileName: string, stats: object, failures: Array}>}
 */
export async function exportCharactersZip({
    api,
    includeCardJson = false,
    onProgress,
    signal,
    now = () => new Date(),
    generator = 'st-full-export 1.0.0',
} = {}) {
    if (!api || typeof api.getCharacters !== 'function') {
        throw new Error('导出失败：缺少 SillyTavern API 封装');
    }
    throwIfAborted(signal);
    const exportedAt = typeof now === 'function' ? now() : now;
    const report = makeReporter(onProgress);

    report({ phase: 'cards', current: 0, total: 0, message: '正在读取角色列表…' });
    const characters = pickCharacters(await api.getCharacters({ signal }))
        .sort((a, b) => compareText(a.name, b.name) || compareText(a.avatar, b.avatar));
    const total = characters.length;
    const failures = [];

    // 1) 并发下载原始 PNG（并发 4），失败只记录不中断。
    const pngs = new Array(total).fill(null);
    let downloaded = 0;
    report({
        phase: 'cards',
        current: 0,
        total,
        message: total ? `正在下载角色卡图片（0/${total}）…` : '没有可导出的角色卡',
    });
    await runPool(characters, async (character, index) => {
        throwIfAborted(signal);
        try {
            pngs[index] = await api.fetchCharacterPng(character.avatar, { signal });
        } catch (error) {
            if (isAbortError(error) || isAuthFailure(error)) {
                // 登录 / CSRF 失效是全局问题：中止导出，避免“成功”导出残缺 ZIP。
                throw error;
            }
            failures.push({
                scope: 'card',
                name: character.name,
                file_name: character.avatar,
                reason: describeError(error),
            });
        }
        downloaded += 1;
        report({
            phase: 'cards',
            current: downloaded,
            total,
            message: `正在下载角色卡图片（${downloaded}/${total}）…`,
        });
    }, { concurrency: CARD_DOWNLOAD_CONCURRENCY, signal });

    // 2) 可选的卡 JSON。
    const jsonTexts = new Array(total).fill(null);
    if (includeCardJson) {
        let jsonDone = 0;
        const candidates = characters.filter((_, index) => pngs[index] !== null);
        report({
            phase: 'cards-json',
            current: 0,
            total: candidates.length,
            message: `正在收集角色卡 JSON（0/${candidates.length}）…`,
        });
        const tasks = characters
            .map((character, index) => ({ character, index }))
            .filter((task) => pngs[task.index] !== null);
        await runPool(tasks, async (task) => {
            throwIfAborted(signal);
            const { character, index } = task;
            try {
                // 只用 json_data；内存里的 character.data 在 lazyLoadCharacters 下是
                // shallow 数据，不能作为完整卡 JSON 的来源。
                let text = extractCardJsonText(character);
                if (!text) {
                    const fetched = await api.getCharacter(character.avatar, { signal });
                    text = extractCardJsonText(fetched);
                }
                if (!text) {
                    throw new Error('角色卡数据为空（json_data 缺失）');
                }
                jsonTexts[index] = text;
            } catch (error) {
                if (isAbortError(error) || isAuthFailure(error)) {
                    throw error;
                }
                failures.push({
                    scope: 'card',
                    name: character.name,
                    file_name: character.avatar,
                    reason: `读取角色卡 JSON 失败：${describeError(error)}`,
                });
            }
            jsonDone += 1;
            report({
                phase: 'cards-json',
                current: jsonDone,
                total: tasks.length,
                message: `正在收集角色卡 JSON（${jsonDone}/${tasks.length}）…`,
            });
        }, { concurrency: CARD_DOWNLOAD_CONCURRENCY, signal });
    }

    throwIfAborted(signal);
    report({ phase: 'zip', current: 0, total: 1, message: '正在打包 ZIP…' });

    // 3) 打包。先分配固定文件名，避免与角色卡文件名冲突。
    const rootNames = new NameAllocator();
    const readmeName = rootNames.allocate(README_FILE_NAME);
    const indexName = rootNames.allocate(INDEX_FILE_NAME);
    const jsonNames = new NameAllocator();

    const zip = new ZipWriter();
    const entries = [];
    const jsonAdditions = [];
    for (let index = 0; index < characters.length; index += 1) {
        const png = pngs[index];
        if (!png) {
            continue;
        }
        const character = characters[index];
        const zipName = rootNames.allocate(sanitizeZipFileName(character.avatar, { fallback: 'character.png' }));
        zip.addFile(zipName, png, { date: exportedAt });
        let jsonFile = null;
        if (jsonTexts[index]) {
            const jsonName = jsonNames.allocate(`${sanitizeZipFileName(pngBaseName(character.avatar), { fallback: 'character' })}.json`);
            jsonFile = `json/${jsonName}`;
            jsonAdditions.push({ name: jsonFile, text: jsonTexts[index] });
        }
        entries.push({
            avatar: character.avatar,
            name: character.name,
            file: zipName,
            size: png.byteLength,
            ...(jsonFile ? { json_file: jsonFile } : {}),
        });
    }

    // 最后护栏：一张都没成功时拒绝生成只有 index/README 的空 ZIP。
    // （部分失败仍正常打包；全部失败通常意味着登录页/网络问题。）
    if (characters.length > 0 && entries.length === 0) {
        throw new Error('所有角色卡图片都下载失败，已拒绝生成空 ZIP（请检查登录状态、网络或文件是否可访问）');
    }

    zip.addFile(indexName, buildCharactersIndex({
        exportedAt,
        generator,
        entries,
        failures: failures.slice().sort((a, b) => compareText(a.file_name, b.file_name)),
    }), { date: exportedAt });
    zip.addFile(readmeName, buildCharactersReadme({ exportedAt, count: entries.length }), { date: exportedAt });
    for (const addition of jsonAdditions) {
        zip.addFile(addition.name, addition.text, { date: exportedAt });
    }

    const blob = zip.buildBlob();
    report({
        phase: 'done',
        current: entries.length,
        total: entries.length,
        message: `角色卡打包完成：${entries.length} 张`,
    });

    return {
        blob,
        fileName: buildExportFileName('sillytavern-characters', 'zip', exportedAt),
        stats: {
            characters: entries.length,
            skipped: characters.length - entries.length,
            failures: failures.length,
            bytes: zip.totalBytes,
        },
        failures,
        exportedAt,
    };
}
