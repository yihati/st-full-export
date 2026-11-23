/**
 * 导出格式模块单元测试
 *
 * 运行：node --test tests/format.test.js
 * 使用 Node 内置 node:test + node:assert/strict，不依赖第三方库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERATOR,
  CHAT_FORMATS,
  pad2,
  formatDateTime,
  buildFileStamp,
  buildExportFileName,
  formatMessageTime,
  createChatSink,
  formatTxtHeader,
  formatTxtRecord,
  formatTxtFooter,
} from '../src/format.js';

/** 用本地时间构造 Date 再取 ISO 字符串，避免测试机器时区影响 */
function localIso(year, monthIndex, day, hour, minute, second) {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString();
}

/** 输出中的固定导出时间 */
const EXPORTED_AT = new Date(2024, 0, 2, 3, 4, 5);
const EXPORTED_AT_ISO = EXPORTED_AT.toISOString();

/** 角色聊天记录样例 */
function makeCharacterRecord() {
  return {
    kind: 'character',
    character: { name: 'Momo', avatar: 'Momo.png' },
    group: null,
    file_name: 'Momo - 2024-1-1 @12h00m00s 123ms.jsonl',
    file_id: 'Momo - 2024-1-1 @12h00m00s 123ms',
    chat_metadata: { note: '测试元数据' },
    messages: [
      {
        name: 'Momo',
        is_user: false,
        is_system: false,
        send_date: localIso(2024, 0, 1, 10, 0, 0),
        mes: '你好',
      },
      {
        name: '用户',
        is_user: true,
        is_system: false,
        send_date: localIso(2024, 0, 1, 10, 0, 5),
        mes: '你好呀',
      },
    ],
    message_count: 42,
    last_message: '你好呀',
  };
}

/** 群聊聊天记录样例（第三条消息时间无法解析） */
function makeGroupRecord() {
  return {
    kind: 'group',
    character: null,
    group: { id: '1700000000000', name: '群名', members: ['a.png', 'b.png'] },
    file_name: '群名 - 2024-1-1 @12h00m00s 123ms.jsonl',
    file_id: '群名 - 2024-1-1 @12h00m00s 123ms',
    chat_metadata: {},
    messages: [
      {
        name: 'Alice',
        is_user: false,
        is_system: false,
        send_date: localIso(2024, 0, 1, 11, 0, 0),
        mes: '群消息一',
      },
      {
        name: 'Bob',
        is_user: false,
        is_system: false,
        send_date: localIso(2024, 0, 1, 11, 0, 5),
        mes: '群消息二',
      },
      {
        name: 'Bob',
        is_user: false,
        is_system: false,
        send_date: 'not-a-date',
        mes: '未知时间消息',
      },
    ],
    message_count: 3,
    last_message: '未知时间消息',
  };
}

test('导出常量与 pad2', () => {
  assert.equal(GENERATOR, 'st-full-export 1.0.0');
  assert.deepEqual([...CHAT_FORMATS], ['json', 'jsonl', 'txt']);
  assert.ok(Object.isFrozen(CHAT_FORMATS));
  assert.equal(pad2(3), '03');
  assert.equal(pad2(12), '12');
  assert.equal(pad2(0), '00');
});

test('formatDateTime / buildFileStamp / buildExportFileName', () => {
  assert.equal(formatDateTime(EXPORTED_AT), '2024-01-02 03:04:05');
  assert.equal(buildFileStamp(EXPORTED_AT), '20240102-030405');
  assert.equal(
    buildExportFileName('sillytavern-chats', 'json', EXPORTED_AT),
    'sillytavern-chats-20240102-030405.json',
  );
  assert.equal(buildFileStamp(new Date(2024, 11, 31, 23, 59, 59)), '20241231-235959');

  // 非法日期：formatDateTime 返回空串，buildFileStamp 抛错
  assert.equal(formatDateTime(new Date('无效日期')), '');
  assert.equal(formatDateTime('not-a-date'), '');
  assert.throws(() => buildFileStamp(new Date('无效日期')), /无效的导出时间/);
  assert.throws(() => buildExportFileName('x', 'json', new Date(NaN)), /无效的导出时间/);
});

test('formatMessageTime 解析 ISO / 毫秒数 / Date / 非法值', () => {
  const local = new Date(2024, 0, 2, 3, 4, 5);
  assert.equal(formatMessageTime(local.toISOString()), '2024-01-02 03:04:05');
  assert.equal(formatMessageTime(local.getTime()), '2024-01-02 03:04:05');
  assert.equal(formatMessageTime(local), '2024-01-02 03:04:05');

  assert.equal(formatMessageTime(''), '');
  assert.equal(formatMessageTime(undefined), '');
  assert.equal(formatMessageTime(null), '');
  assert.equal(formatMessageTime(Number.NaN), '');
  // 旧版 humanized 时间戳无法被 Date 解析，原样保留（不转换）。
  assert.equal(formatMessageTime('2024-1-1@12h00m00s123ms'), '2024-1-1@12h00m00s123ms');
  assert.equal(formatMessageTime('not-a-date'), 'not-a-date');
});

test('JSON 导出：结构、键顺序、统计与失败项', async () => {
  const stats = { characters: 1, groups: 1 };
  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT, stats });
  const chatA = makeCharacterRecord();
  const chatB = makeGroupRecord();
  sink.addRecord(chatA);
  sink.addRecord(chatB);

  assert.equal(stats.chats, 2);
  assert.equal(stats.messages, 5); // 角色 2 条 + 群聊 3 条

  const failures = [
    { scope: 'character', name: 'Bad.png', file_name: 'bad.jsonl', reason: 'HTTP 500' },
  ];
  const blob = sink.finish(failures);
  assert.equal(stats.failures, 1);
  assert.equal(blob.type, 'application/json;charset=utf-8');
  assert.ok(blob.type.includes('application/json'));

  const text = await blob.text();
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes('undefined'), 'JSON 文本中不应出现 undefined');

  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'sillytavern-all-chats');
  assert.equal(parsed.format_version, 1);
  assert.equal(parsed.generator, GENERATOR);
  assert.equal(parsed.exported_at, EXPORTED_AT_ISO);
  assert.deepEqual(parsed.stats, {
    characters: 1,
    groups: 1,
    chats: 2,
    messages: 5,
    failures: 1,
    skipped_empty: 0,
  });
  assert.deepEqual(parsed.chats, [chatA, chatB]);
  assert.deepEqual(parsed.failures, failures);

  // 顶层键顺序固定
  const keys = ['"format"', '"format_version"', '"exported_at"', '"generator"', '"stats"', '"chats"', '"failures"'];
  for (let index = 1; index < keys.length; index += 1) {
    assert.ok(
      text.indexOf(keys[index - 1]) < text.indexOf(keys[index]),
      `键顺序错误：${keys[index - 1]} 应在 ${keys[index]} 之前`,
    );
  }
  // 记录之间使用 ",\n" 分隔，逐条 stringify
  assert.ok(text.includes('},\n{'));
  assert.ok(text.startsWith('{"format":"sillytavern-all-chats","format_version":1,'));
});

test('JSON 导出：空 chats 输出空数组', async () => {
  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT });
  const blob = sink.finish([]);
  const text = await blob.text();
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.chats, []);
  assert.deepEqual(parsed.failures, []);
  assert.deepEqual(parsed.stats, {
    characters: 0,
    groups: 0,
    chats: 0,
    messages: 0,
    failures: 0,
    skipped_empty: 0,
  });
  assert.ok(text.includes('"chats":[]'));
});

test('JSONL 导出：每条记录一行、末尾换行、忽略失败项', async () => {
  const sink = createChatSink({ format: 'jsonl', exportedAt: EXPORTED_AT });
  const chatA = makeCharacterRecord();
  const chatB = makeGroupRecord();
  sink.addRecord(chatA);
  sink.addRecord(chatB);
  const blob = sink.finish([{ scope: 'file', name: 'x.jsonl', reason: '不应写入 JSONL' }]);

  assert.equal(blob.type, 'application/x-ndjson;charset=utf-8');
  assert.ok(blob.type.includes('ndjson'));

  const text = await blob.text();
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes('\r'));
  assert.ok(!text.includes('不应写入 JSONL'));

  const lines = text.split('\n');
  assert.equal(lines.at(-1), '');
  const records = lines.filter((line) => line !== '');
  assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(records[0]), chatA);
  assert.deepEqual(JSON.parse(records[1]), chatB);
});

test('JSONL 导出：空记录输出空字符串', async () => {
  const blob = createChatSink({ format: 'jsonl', exportedAt: EXPORTED_AT }).finish([]);
  assert.equal(await blob.text(), '');
  assert.ok(blob.type.includes('ndjson'));
});

test('TXT 导出：头部、聊天块、消息顺序与失败汇总', async () => {
  const stats = { characters: 2, groups: 1 };
  const sink = createChatSink({ format: 'txt', exportedAt: EXPORTED_AT, stats });
  const chatA = makeCharacterRecord();
  const chatB = makeGroupRecord();
  sink.addRecord(chatA);
  sink.addRecord(chatB);

  const failures = [
    { scope: 'character', name: 'Bad.png', file_name: 'file.jsonl', reason: 'HTTP 500' },
    { scope: 'zip', name: 'cards.zip', reason: '压缩失败' },
  ];
  const blob = sink.finish(failures);
  assert.equal(blob.type, 'text/plain;charset=utf-8');

  const text = await blob.text();
  assert.ok(text.startsWith('SillyTavern 全量对话导出\n'));
  assert.ok(text.includes('导出时间：2024-01-02 03:04:05'));
  assert.ok(text.includes('统计：角色 2 个，群聊 1 个，聊天 2 条，消息 5 条，失败 2 项'));
  assert.ok(text.includes('说明：每条消息仅包含当前 swipe 的内容；'));
  assert.ok(text.includes('='.repeat(80)));
  assert.ok(text.includes('-'.repeat(80)));

  // 角色块
  assert.ok(text.includes('[角色] Momo（Momo.png）'));
  assert.ok(text.includes('聊天文件：Momo - 2024-1-1 @12h00m00s 123ms.jsonl'));
  assert.ok(text.includes('消息数：42'));
  assert.ok(text.includes('[2024-01-01 10:00:00] Momo：\n你好'));
  assert.ok(text.includes('[2024-01-01 10:00:05] 用户：\n你好呀'));

  // 群聊块
  assert.ok(text.includes('[群聊] 群名（2 名成员）'));
  assert.ok(text.includes('消息数：3'));
  assert.ok(text.includes('[2024-01-01 11:00:00] Alice：\n群消息一'));
  // 无法解析的 send_date 原样显示，不强行转成本地时间。
  assert.ok(text.includes('[not-a-date] Bob：\n未知时间消息'));

  // 消息按传入顺序出现
  const positions = [
    text.indexOf('你好\n'),
    text.indexOf('你好呀'),
    text.indexOf('群消息一'),
    text.indexOf('群消息二'),
    text.indexOf('未知时间消息'),
  ];
  for (const position of positions) {
    assert.ok(position >= 0, 'TXT 中应包含全部消息正文');
  }
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index], '消息顺序应与传入顺序一致');
  }

  // 失败汇总
  assert.ok(text.includes('失败汇总（2 项）'));
  assert.ok(text.includes('- [角色] Bad.png（file.jsonl）：HTTP 500'));
  assert.ok(text.includes('- [打包] cards.zip：压缩失败'));

  // 顶层以单个换行结尾
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
  assert.ok(!text.includes('undefined'));
});

test('TXT 辅助函数与空失败汇总', async () => {
  const header = formatTxtHeader({
    exportedAt: EXPORTED_AT,
    stats: { characters: 0, groups: 0, chats: 0, messages: 0, failures: 0 },
  });
  assert.ok(header.startsWith('SillyTavern 全量对话导出\n'));
  assert.ok(header.endsWith(`${'='.repeat(80)}\n\n`));

  const block = formatTxtRecord(makeCharacterRecord());
  assert.ok(block.startsWith('[角色] Momo（Momo.png）\n'));
  assert.ok(block.includes(`${'-'.repeat(80)}\n`));
  assert.ok(block.endsWith('你好呀\n\n'));

  assert.equal(formatTxtFooter([]), '');

  // 失败为空时 TXT 不输出失败汇总段
  const sink = createChatSink({ format: 'txt', exportedAt: EXPORTED_AT });
  sink.addRecord(makeCharacterRecord());
  const text = await sink.finish([]).text();
  assert.ok(!text.includes('失败汇总'));
  assert.ok(text.endsWith('\n'));
});

test('stats 原地更新、重复结束与不支持的格式', async () => {
  const stats = { characters: 2, groups: 1 };
  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT, stats });
  sink.addRecord(makeGroupRecord());
  const blob = sink.finish([]);

  assert.equal(stats.characters, 2);
  assert.equal(stats.groups, 1);
  assert.equal(stats.chats, 1);
  assert.equal(stats.messages, 3);
  assert.equal(stats.failures, 0);

  const parsed = JSON.parse(await blob.text());
  assert.deepEqual(parsed.stats, {
    characters: 2,
    groups: 1,
    chats: 1,
    messages: 3,
    failures: 0,
    skipped_empty: 0,
  });

  // 同一 sink 只能结束一次
  assert.throws(() => sink.finish([]), /导出器已结束/);
  assert.throws(() => sink.finish([]), /导出器已结束/);

  // 不支持的格式在创建 sink 时立即抛错
  assert.throws(() => createChatSink({ format: 'xml' }), /不支持的对话导出格式：xml/);
  assert.throws(() => createChatSink({ format: 'JSON' }), /不支持的对话导出格式：JSON/);
  assert.throws(() => createChatSink(), /不支持的对话导出格式：undefined/);

  // 无 messages 字段时按 message_count 累计
  const noMessagesStats = { characters: 0, groups: 0 };
  const noMessagesSink = createChatSink({ format: 'jsonl', exportedAt: EXPORTED_AT, stats: noMessagesStats });
  const { messages, ...recordWithoutMessages } = makeCharacterRecord();
  assert.equal(messages.length, 2);
  noMessagesSink.addRecord({ ...recordWithoutMessages, message_count: 7 });
  assert.equal(noMessagesStats.messages, 7);
  const lines = (await noMessagesSink.finish([]).text()).trim().split('\n');
  assert.equal(lines.length, 1);
});

test('exported_at 是合法 ISO 字符串', async () => {
  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT });
  const parsed = JSON.parse(await sink.finish([]).text());
  assert.equal(parsed.exported_at, EXPORTED_AT_ISO);
  assert.equal(new Date(parsed.exported_at).toISOString(), parsed.exported_at);
  assert.ok(!Number.isNaN(Date.parse(parsed.exported_at)));
});

test('skipped_empty 统计：JSON stats 与 TXT 头部', async () => {
  const stats = { characters: 1, groups: 0, skipped_empty: 3 };
  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT, stats });
  const parsed = JSON.parse(await sink.finish([]).text());
  assert.equal(parsed.stats.skipped_empty, 3);
  assert.equal(parsed.stats.chats, 0);

  const txt = await createChatSink({ format: 'txt', exportedAt: EXPORTED_AT, stats: { characters: 1, groups: 0, skipped_empty: 2 } })
    .finish([])
    .text();
  assert.ok(txt.includes('统计：角色 1 个，群聊 0 个，聊天 0 条，消息 0 条，失败 0 项，空聊天跳过 2 条'));
});

test('header_only 记录：TXT 标注且 JSON 保留标记', async () => {
  const record = {
    ...makeCharacterRecord(),
    messages: [],
    message_count: 0,
    last_message: '',
    header_only: true,
  };
  const block = formatTxtRecord(record);
  assert.ok(block.includes('消息数：0'));
  assert.ok(block.includes('（仅有聊天元数据，没有消息）'));

  const sink = createChatSink({ format: 'json', exportedAt: EXPORTED_AT });
  sink.addRecord(record);
  const parsed = JSON.parse(await sink.finish([]).text());
  assert.equal(parsed.chats[0].header_only, true);
  assert.deepEqual(parsed.chats[0].messages, []);
});

test('TXT 中旧版 humanized send_date 原样显示', async () => {
  const record = {
    ...makeCharacterRecord(),
    messages: [
      {
        name: 'Momo',
        is_user: false,
        send_date: '2024-1-1@12h00m00s123ms',
        mes: '旧版消息',
      },
    ],
    message_count: 1,
  };
  const sink = createChatSink({ format: 'txt', exportedAt: EXPORTED_AT });
  sink.addRecord(record);
  const text = await sink.finish([]).text();
  assert.ok(text.includes('[2024-1-1@12h00m00s123ms] Momo：\n旧版消息'));
});
