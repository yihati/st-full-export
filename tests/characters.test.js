/**
 * 角色卡 ZIP 导出测试：mock 角色列表与 PNG 字节，验证 ZIP 内容、index.json、
 * README.txt、可选 JSON 卡数据、重名去重、失败记录、取消与空库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportCharactersZip, extractCardJsonText } from '../src/characters.js';
import { textOf, unzip } from './helpers/unzip.js';

const FIXED_DATE = new Date(2024, 0, 2, 3, 4, 5);
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakePng(seed) {
    const body = new Uint8Array(64);
    for (let i = 0; i < body.length; i += 1) {
        body[i] = (seed * 37 + i * 11) % 256;
    }
    const out = new Uint8Array(PNG_SIGNATURE.length + body.length);
    out.set(PNG_SIGNATURE);
    out.set(body, PNG_SIGNATURE.length);
    return out;
}

function createApiMock(spec = {}) {
    const calls = { characters: 0, png: [], card: [] };
    return {
        calls,
        async getCharacters() {
            calls.characters += 1;
            if (spec.charactersError) {
                throw spec.charactersError;
            }
            return spec.characters ?? [];
        },
        async fetchCharacterPng(avatar) {
            calls.png.push(avatar);
            if (spec.pngErrors?.[avatar]) {
                throw spec.pngErrors[avatar];
            }
            return spec.pngs?.[avatar] ?? fakePng(1);
        },
        async getCharacter(avatar) {
            calls.card.push(avatar);
            if (spec.cardErrors?.[avatar]) {
                throw spec.cardErrors[avatar];
            }
            return spec.cards?.[avatar] ?? {};
        },
    };
}

function byName(zip) {
    return zip.byName;
}

test('基本导出：PNG 字节一致、index.json 元数据正确、README 含说明、文件名规范', async () => {
    const pngs = { 'Momo.png': fakePng(2), 'Zed.png': fakePng(3) };
    const api = createApiMock({
        characters: [
            { name: 'Zed', avatar: 'Zed.png' },
            { name: 'Momo', avatar: 'Momo.png', json_data: '{"spec":"chara_card_v2","data":{"name":"Momo"}}' },
        ],
        pngs,
    });

    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    assert.equal(result.fileName, 'sillytavern-characters-20240102-030405.zip');
    assert.equal(result.blob.type, 'application/zip');
    assert.equal(result.stats.characters, 2);
    assert.equal(result.stats.failures, 0);
    assert.ok(result.stats.bytes > 0);

    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    // 角色按名字排序（Momo 在 Zed 前），之后是 index.json 与 README.txt。
    assert.deepEqual(zip.names, ['Momo.png', 'Zed.png', 'index.json', 'README.txt']);

    const momo = zip.byName.get('Momo.png');
    assert.equal(momo.method, 0);
    assert.equal(momo.flags & 0x0800, 0x0800, 'UTF-8 标记应存在');
    assert.deepEqual(new Uint8Array(momo.data), pngs['Momo.png']);
    assert.deepEqual(new Uint8Array(zip.byName.get('Zed.png').data), pngs['Zed.png']);

    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.format, 'sillytavern-characters');
    assert.equal(index.format_version, 1);
    assert.equal(index.exported_at, FIXED_DATE.toISOString());
    assert.equal(index.count, 2);
    assert.deepEqual(index.failures, []);
    assert.deepEqual(index.characters.map((entry) => entry.avatar), ['Momo.png', 'Zed.png']);
    const momoEntry = index.characters[0];
    assert.equal(momoEntry.file, 'Momo.png');
    assert.equal(momoEntry.name, 'Momo');
    assert.equal(momoEntry.size, pngs['Momo.png'].byteLength);

    const readme = textOf(zip.byName.get('README.txt'));
    assert.match(readme, /原始 PNG/);
    assert.match(readme, /chara/);
    assert.match(readme, /ccv3/);
    assert.match(readme, /index\.json/);
    assert.match(readme, /2024-01-02 03:04:05/);
    assert.match(readme, /角色卡数量：2/);
    // JSON 也是 ST 支持的导入格式（无卡面图），不能被描述成“不是导入格式”。
    assert.match(readme, /无卡面图/);
    assert.match(readme, /fav/);
});

test('可选 JSON 卡数据：优先 json_data，缺失时调用 /api/characters/get', async () => {
    const api = createApiMock({
        characters: [
            { name: 'Momo', avatar: 'Momo.png', json_data: '{"data":{"name":"Momo"},"spec":"chara_card_v2"}' },
            { name: 'Zed', avatar: 'Zed.png' },
        ],
        cards: {
            'Zed.png': { json_data: '{"data":{"name":"Zed"},"spec":"chara_card_v3"}' },
        },
    });

    const result = await exportCharactersZip({ api, includeCardJson: true, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.deepEqual(zip.names, ['Momo.png', 'Zed.png', 'index.json', 'README.txt', 'json/Momo.json', 'json/Zed.json']);

    assert.deepEqual(JSON.parse(textOf(zip.byName.get('json/Momo.json'))), {
        data: { name: 'Momo' },
        spec: 'chara_card_v2',
    });
    assert.deepEqual(JSON.parse(textOf(zip.byName.get('json/Zed.json'))), {
        data: { name: 'Zed' },
        spec: 'chara_card_v3',
    });
    assert.deepEqual(api.calls.card, ['Zed.png'], '只有缺少 json_data 的卡才应额外请求');

    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.characters[0].json_file, 'json/Momo.json');
    assert.equal(index.characters[1].json_file, 'json/Zed.json');
});

test('shallow 角色数据不会被当作完整卡 JSON：缺 json_data 时必须请求 /api/characters/get', async () => {
    const fullCard = { spec: 'chara_card_v2', data: { name: 'Momo', description: '完整描述' } };
    const api = createApiMock({
        characters: [{
            name: 'Momo',
            avatar: 'Momo.png',
            // performance.lazyLoadCharacters 开启时的典型形态：shallow + 残缺 data。
            shallow: true,
            data: { name: 'Momo', description: '' },
        }],
        cards: {
            'Momo.png': { name: 'Momo', shallow: false, json_data: JSON.stringify(fullCard) },
        },
    });

    const result = await exportCharactersZip({ api, includeCardJson: true, now: () => FIXED_DATE });
    assert.deepEqual(api.calls.card, ['Momo.png'], '缺少 json_data 时必须请求完整角色卡');
    assert.equal(result.failures.length, 0);

    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.deepEqual(JSON.parse(textOf(zip.byName.get('json/Momo.json'))), fullCard);
});

test('完整角色卡返回里仍无 json_data 时记 failure，不写残缺 JSON', async () => {
    const api = createApiMock({
        characters: [{ name: 'Zed', avatar: 'Zed.png', shallow: true, data: { name: 'Zed' } }],
        cards: { 'Zed.png': { name: 'Zed', shallow: false } },
    });

    const result = await exportCharactersZip({ api, includeCardJson: true, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.ok(zip.byName.has('Zed.png'), 'PNG 仍应存在');
    assert.equal(zip.byName.has('json/Zed.json'), false, '不能写出残缺 JSON');
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].reason, /json_data 缺失/);
});

test('extractCardJsonText 只信任 json_data，不序列化 character.data', () => {
    assert.equal(extractCardJsonText({ data: { name: 'shallow' } }), null);
    assert.equal(extractCardJsonText({ json_data: '   ' }), null);
    assert.deepEqual(JSON.parse(extractCardJsonText({ json_data: '{"a":1}' })), { a: 1 });
    assert.deepEqual(JSON.parse(extractCardJsonText({ json_data: { b: 2 } })), { b: 2 });
});

test('JSON 卡数据失败只记录 failures，不影响 PNG 与其他卡', async () => {    const api = createApiMock({
        characters: [
            { name: 'Momo', avatar: 'Momo.png', json_data: '{"a":1}' },
            { name: 'Zed', avatar: 'Zed.png' },
        ],
        cardErrors: { 'Zed.png': new Error('HTTP 500：读取失败') },
    });

    const result = await exportCharactersZip({ api, includeCardJson: true, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.ok(zip.byName.has('Zed.png'), 'PNG 仍应存在');
    assert.equal(zip.byName.has('json/Zed.json'), false);
    assert.ok(zip.byName.has('json/Momo.json'));
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, 'card');
    assert.match(result.failures[0].reason, /读取角色卡 JSON 失败/);
    assert.match(result.failures[0].reason, /HTTP 500/);

    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.failures.length, 1);
    assert.equal(index.characters.length, 2);
    assert.equal(index.characters[1].json_file, undefined);
});

test('PNG 下载失败：跳过该卡、记录 failures、其余卡与元数据仍完整', async () => {
    const pngs = { 'Momo.png': fakePng(5) };
    const api = createApiMock({
        characters: [
            { name: 'Momo', avatar: 'Momo.png' },
            { name: 'Bad', avatar: 'Bad.png' },
        ],
        pngs,
        pngErrors: { 'Bad.png': new Error('HTTP 404：文件不存在') },
    });

    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    assert.equal(result.stats.characters, 1);
    assert.equal(result.stats.skipped, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, 'card');
    assert.equal(result.failures[0].file_name, 'Bad.png');
    assert.match(result.failures[0].reason, /HTTP 404/);

    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.equal(zip.byName.has('Bad.png'), false);
    assert.ok(zip.byName.has('Momo.png'));
    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.count, 1);
    assert.equal(index.failures[0].file_name, 'Bad.png');
    assert.match(textOf(zip.byName.get('README.txt')), /角色卡数量：1/);
});

test('所有角色卡 PNG 都失败 → reject，拒绝生成空 ZIP', async () => {
    const api = createApiMock({
        characters: [
            { name: 'A', avatar: 'A.png' },
            { name: 'B', avatar: 'B.png' },
        ],
        pngErrors: {
            'A.png': Object.assign(new Error('HTTP 404：文件不存在'), { status: 404, kind: 'http' }),
            'B.png': Object.assign(new Error('HTTP 404：文件不存在'), { status: 404, kind: 'http' }),
        },
    });
    await assert.rejects(
        () => exportCharactersZip({ api, now: () => FIXED_DATE }),
        /所有角色卡图片都下载失败/,
    );
});

test('大小写不同的卡名在 ZIP 中去重，不会互相覆盖', async () => {
    const api = createApiMock({
        characters: [
            { name: 'A', avatar: 'Momo.png' },
            { name: 'B', avatar: 'momo.png' },
        ],
        pngs: { 'Momo.png': fakePng(1), 'momo.png': fakePng(2) },
    });
    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    const pngNames = zip.names.filter((name) => name.endsWith('.png'));
    assert.equal(pngNames.length, 2);
    assert.equal(pngNames.some((name) => name.endsWith(' (2).png')), true);
    assert.notEqual(pngNames[0].toLowerCase(), pngNames[1].toLowerCase(), '小写后也必须唯一');
    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.count, 2);
});

test('文件名清洗与重名去重：非法字符替换、同名追加序号、扩展名保留', async () => {
    const api = createApiMock({
        characters: [
            { name: 'A', avatar: 'Ba:d.png' },
            { name: 'B', avatar: 'Ba_d.png' },
            { name: 'C', avatar: 'Trail.png' },
        ],
        pngs: {
            'Ba:d.png': fakePng(1),
            'Ba_d.png': fakePng(2),
            'Trail.png': fakePng(3),
        },
    });
    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.deepEqual(zip.names.filter((name) => name.endsWith('.png')), [
        'Ba_d.png',
        'Ba_d (2).png',
        'Trail.png',
    ]);
    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.deepEqual(index.characters.map((entry) => entry.avatar), ['Ba:d.png', 'Ba_d.png', 'Trail.png']);
    assert.deepEqual(index.characters.map((entry) => entry.file), ['Ba_d.png', 'Ba_d (2).png', 'Trail.png']);
    // 原始文件名记录在 index.json 里，便于溯源。
    assert.ok(zip.byName.has('Ba_d.png'));
});

test('重复 avatar 会被去重，不会重复写入 ZIP', async () => {
    const api = createApiMock({
        characters: [
            { name: 'Momo', avatar: 'Momo.png' },
            { name: 'Momo 副本', avatar: 'Momo.png' },
        ],
        pngs: { 'Momo.png': fakePng(7) },
    });
    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.equal(zip.names.filter((name) => name === 'Momo.png').length, 1);
    assert.equal(result.stats.characters, 1);
});

test('预取消：抛出 AbortError 且不读取角色列表', async () => {
    const api = createApiMock({ characters: [{ name: 'Momo', avatar: 'Momo.png' }] });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => exportCharactersZip({ api, signal: controller.signal, now: () => FIXED_DATE }),
        (error) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(api.calls.characters, 0);
    assert.equal(api.calls.png.length, 0);
});

test('空角色库：ZIP 只有 index.json 与 README.txt，count 为 0', async () => {
    const api = createApiMock({ characters: [] });
    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    const zip = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    assert.deepEqual(zip.names, ['index.json', 'README.txt']);
    const index = JSON.parse(textOf(zip.byName.get('index.json')));
    assert.equal(index.count, 0);
    assert.deepEqual(index.characters, []);
    assert.deepEqual(index.failures, []);
});

test('进度回调覆盖下载、JSON、打包阶段并最终 done', async () => {
    const events = [];
    const api = createApiMock({
        characters: [
            { name: 'Momo', avatar: 'Momo.png', json_data: '{"a":1}' },
            { name: 'Zed', avatar: 'Zed.png', json_data: '{"b":2}' },
        ],
    });
    await exportCharactersZip({
        api,
        includeCardJson: true,
        now: () => FIXED_DATE,
        onProgress: (event) => events.push(event),
    });
    const phases = events.map((event) => event.phase);
    assert.ok(phases.includes('cards'));
    assert.ok(phases.includes('cards-json'));
    assert.ok(phases.includes('zip'));
    assert.equal(phases.at(-1), 'done');
    const cardEvents = events.filter((event) => event.phase === 'cards' && event.current > 0);
    assert.equal(cardEvents.at(-1).current, 2);
    assert.equal(cardEvents.at(-1).total, 2);
});

test('缺少 api 时给出中文错误', async () => {
    await assert.rejects(() => exportCharactersZip({}), /缺少 SillyTavern API 封装/);
});

test('PNG 下载返回 auth（401）→ 整体 reject，不产出残缺 ZIP', async () => {
    const api = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        pngErrors: {
            'Momo.png': Object.assign(new Error('未登录'), { kind: 'auth', status: 401 }),
        },
    });
    await assert.rejects(
        () => exportCharactersZip({ api, now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth' && error.status === 401,
    );
});

test('可选 JSON 获取返回 auth / csrf → 整体 reject', async () => {
    const authApi = createApiMock({
        characters: [{ name: 'Momo', avatar: 'Momo.png' }],
        cardErrors: {
            'Momo.png': Object.assign(new Error('未登录'), { kind: 'auth', status: 401 }),
        },
    });
    await assert.rejects(
        () => exportCharactersZip({ api: authApi, includeCardJson: true, now: () => FIXED_DATE }),
        (error) => error?.kind === 'auth',
    );

    const csrfApi = createApiMock({
        characters: [{ name: 'Zed', avatar: 'Zed.png' }],
        cardErrors: {
            'Zed.png': Object.assign(new Error('CSRF'), { kind: 'csrf', status: 403 }),
        },
    });
    await assert.rejects(
        () => exportCharactersZip({ api: csrfApi, includeCardJson: true, now: () => FIXED_DATE }),
        (error) => error?.kind === 'csrf',
    );
});

test('Python zipfile 交叉校验：中文卡名与 PNG 字节可正常解压', async (t) => {
    const python = process.env.STFE_PYTHON || 'python';
    const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
        t.skip('未找到可用的 Python，跳过 zipfile 交叉校验');
        return;
    }

    const png = fakePng(11);
    const api = createApiMock({
        characters: [{ name: '莫莫', avatar: '莫莫.png', json_data: '{"data":{"name":"莫莫"}}' }],
        pngs: { '莫莫.png': png },
    });
    const result = await exportCharactersZip({ api, now: () => FIXED_DATE });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stfe-characters-'));
    const zipPath = path.join(dir, 'characters.zip');
    try {
        fs.writeFileSync(zipPath, bytes);
        const script = [
            'import zipfile, json, hashlib, sys',
            'p = sys.argv[1]',
            'with zipfile.ZipFile(p) as z:',
            '    bad = z.testzip()',
            '    names = z.namelist()',
            '    files = {}',
            '    for n in names:',
            '        b = z.read(n)',
            '        files[n] = {"sha256": hashlib.sha256(b).hexdigest(), "size": z.getinfo(n).file_size}',
            '    print(json.dumps({"bad": bad, "names": names, "files": files}))',
        ].join('\n');
        const run = spawnSync(python, ['-c', script, zipPath], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, `Python 校验失败：${run.stderr}`);
        const parsed = JSON.parse(run.stdout);
        assert.equal(parsed.bad, null, 'zipfile.testzip() 应返回 None');
        assert.deepEqual(parsed.names, ['莫莫.png', 'index.json', 'README.txt']);
        const expectedSha = createHash('sha256').update(png).digest('hex');
        assert.equal(parsed.files['莫莫.png'].sha256, expectedSha);
        assert.equal(parsed.files['莫莫.png'].size, png.byteLength);
        assert.ok(parsed.files['index.json'].size > 0);
        assert.ok(parsed.files['README.txt'].size > 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
