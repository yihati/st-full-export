import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { ZipWriter, crc32, dosDateTime, encodeUtf8 } from '../src/zip.js';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 从 Uint8Array 中按小端读取 16 位无符号整数。 */
function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** 从 Uint8Array 中按小端读取 32 位无符号整数。 */
function u32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** 逐字节比较两个 Uint8Array 是否完全一致。 */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 计算内容的 SHA-256（hex），用于和 Python 侧对照。 */
function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** 随机二进制数据（返回独立的 Uint8Array）。 */
function randomBytes(size) {
  return new Uint8Array(crypto.randomBytes(size));
}

/** 测试用的朴素逐位 CRC-32（独立于实现里的查表，用于交叉验证）。 */
function naiveCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) !== 0) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc >>>= 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 在 JS 侧完整解析并校验一个 store-only ZIP 结构。
 * @param {Uint8Array} bytes ZIP 字节流
 * @returns {{count:number, cdOffset:number, cdSize:number, eocdOffset:number,
 *            central:Array<object>}}
 */
function inspectZip(bytes) {
  assert.ok(bytes.length >= 22, 'ZIP 至少应包含 22 字节的 EOCD');
  const eocdOffset = bytes.length - 22;
  assert.equal(u32(bytes, eocdOffset), 0x06054b50, 'EOCD 签名应为 0x06054b50');
  assert.equal(u16(bytes, eocdOffset + 4), 0, 'EOCD 本磁盘号应为 0');
  assert.equal(u16(bytes, eocdOffset + 6), 0, 'EOCD 中央目录磁盘号应为 0');
  const count = u16(bytes, eocdOffset + 8);
  assert.equal(u16(bytes, eocdOffset + 10), count, 'EOCD 总条目数应与本盘条目数一致');
  const cdSize = u32(bytes, eocdOffset + 12);
  const cdOffset = u32(bytes, eocdOffset + 16);
  assert.equal(u16(bytes, eocdOffset + 20), 0, 'EOCD 注释长度应为 0');
  assert.equal(cdOffset + cdSize, eocdOffset, '中央目录应紧邻 EOCD（无注释）');

  const central = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(u32(bytes, p), 0x02014b50, `第 ${i + 1} 项中央目录签名错误`);
    const item = {
      versionMadeBy: u16(bytes, p + 4),
      versionNeeded: u16(bytes, p + 6),
      flags: u16(bytes, p + 8),
      method: u16(bytes, p + 10),
      time: u16(bytes, p + 12),
      date: u16(bytes, p + 14),
      crc: u32(bytes, p + 16),
      compressedSize: u32(bytes, p + 20),
      size: u32(bytes, p + 24),
      nameLen: u16(bytes, p + 28),
      extraLen: u16(bytes, p + 30),
      commentLen: u16(bytes, p + 32),
      diskStart: u16(bytes, p + 34),
      internalAttrs: u16(bytes, p + 36),
      externalAttrs: u32(bytes, p + 38),
      localOffset: u32(bytes, p + 42),
      nameBytes: bytes.subarray(p + 46, p + 46 + u16(bytes, p + 28)),
    };
    item.name = new TextDecoder('utf-8', { fatal: true }).decode(item.nameBytes);
    p += 46 + item.nameLen + item.extraLen + item.commentLen;
    central.push(item);
  }
  assert.equal(p, eocdOffset, '解析完中央目录后应正好到达 EOCD');
  return { count, cdSize, cdOffset, eocdOffset, central };
}

// ---------------------------------------------------------------------------
// Python 探测与 zipfile 交叉校验
// ---------------------------------------------------------------------------

const PYTHON_SCRIPT = [
  'import hashlib, json, sys, zipfile',
  '',
  'path = sys.argv[1]',
  'with zipfile.ZipFile(path) as zf:',
  '    bad = zf.testzip()',
  '    entries = []',
  '    for info in zf.infolist():',
  '        data = zf.read(info)',
  '        entries.append({',
  '            "name": info.filename,',
  '            "size": len(data),',
  '            "sha256": hashlib.sha256(data).hexdigest(),',
  '        })',
  '    result = {"bad": bad, "names": zf.namelist(), "entries": entries}',
  'print(json.dumps(result))',
].join('\n');

const PYTHON_FALLBACK =
  'C:\\Users\\Selig\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

let pythonCommand;
let pythonResolved = false;

/** 探测可用的 Python 解释器；找不到返回 null（相关用例会 skip 而不是失败）。 */
function getPython() {
  if (pythonResolved) return pythonCommand;
  pythonResolved = true;
  const candidates = [];
  if (process.env.STFE_PYTHON) candidates.push(process.env.STFE_PYTHON);
  candidates.push('python');
  if (!candidates.includes(PYTHON_FALLBACK)) candidates.push(PYTHON_FALLBACK);
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 20000 });
      if (!res.error && res.status === 0) {
        pythonCommand = cmd;
        return cmd;
      }
    } catch {
      // 忽略，继续尝试下一个候选
    }
  }
  pythonCommand = null;
  return null;
}

/** 用 Python 的 zipfile 打开并全面校验 ZIP，返回解析后的 JSON。 */
function runPythonZipCheck(python, zipPath) {
  const res = spawnSync(python, ['-c', PYTHON_SCRIPT, zipPath], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(
    res.error,
    undefined,
    `无法启动 Python：${res.error ? res.error.message : ''}`,
  );
  assert.equal(res.status, 0, `Python 退出码为 ${res.status}\nstderr: ${res.stderr}`);
  const lines = String(res.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  assert.ok(lines.length > 0, `Python 没有输出 JSON\nstderr: ${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    assert.fail(`无法解析 Python 输出：\n${res.stdout}`);
  }
  assert.equal(parsed.bad, null, `zipfile.testzip() 报告损坏条目：${parsed.bad}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// 1 + 2：多文件基本正确性 与 JS 侧结构校验
// ---------------------------------------------------------------------------

test('多文件 ZIP：结构、顺序、时间戳与数据逐字节正确', () => {
  const fixedNow = new Date(2024, 0, 2, 3, 4, 5);
  const writer = new ZipWriter({ now: () => fixedNow });

  const specs = [
    { name: '莫莫.png', data: randomBytes(1024) },
    { name: 'emoji-😀-🚀.txt', data: '带 emoji 的文本内容 😀🚀' },
    { name: 'empty.bin', data: new Uint8Array(0) },
    {
      name: 'binary-null-ff.dat',
      data: Uint8Array.from([0x00, 0xFF, 0x00, 0xFF, 0x7F, 0x80, 0x00, 0x01]),
    },
    { name: 'big-300k.bin', data: randomBytes(300 * 1024) },
    { name: 'readme.txt', data: '纯字符串内容\n第二行\n' },
    { name: 'dated.txt', data: 'dated', date: new Date(2020, 5, 6, 7, 8, 9) },
  ];

  const expected = [];
  for (const spec of specs) {
    const bytes = typeof spec.data === 'string' ? encodeUtf8(spec.data) : spec.data;
    const info = writer.addFile(spec.name, spec.data, spec.date ? { date: spec.date } : {});
    assert.equal(info.name, spec.name);
    assert.equal(info.size, bytes.length);
    assert.equal(info.crc, crc32(bytes));
    expected.push({ ...spec, bytes, info });
  }

  // 偏移应等于前面所有 local header + 数据的大小之和
  let expectedOffset = 0;
  for (const item of expected) {
    assert.equal(item.info.offset, expectedOffset, `条目 ${item.name} 的 local 偏移错误`);
    expectedOffset += 30 + encodeUtf8(item.name).length + item.bytes.length;
  }
  assert.equal(writer.entryCount, specs.length);
  assert.equal(
    writer.totalBytes,
    expected.reduce((sum, item) => sum + item.bytes.length, 0),
  );

  // listEntries 返回副本，外部改动不影响内部状态
  const listed = writer.listEntries();
  assert.deepEqual(
    listed,
    expected.map((item) => item.info),
  );
  listed[0].name = '被修改';
  listed.push({ name: 'x', size: 0, crc: 0, offset: 0 });
  assert.equal(writer.listEntries()[0].name, specs[0].name);
  assert.equal(writer.listEntries().length, specs.length);

  const bytes = writer.buildBytes();
  const zip = inspectZip(bytes);
  assert.equal(zip.count, specs.length, 'EOCD 条目数应与添加数量一致');
  assert.deepEqual(
    zip.central.map((item) => item.name),
    specs.map((spec) => spec.name),
    '中央目录顺序应与添加顺序一致',
  );

  // buildParts 的分片必须都是 Uint8Array，拼接后与 buildBytes 完全一致
  const parts = writer.buildParts();
  assert.ok(Array.isArray(parts) && parts.length > 0);
  for (const part of parts) assert.ok(part instanceof Uint8Array, '分片必须是 Uint8Array');
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let joinOffset = 0;
  for (const part of parts) {
    joined.set(part, joinOffset);
    joinOffset += part.length;
  }
  assert.ok(sameBytes(joined, bytes), 'buildParts 拼接结果应与 buildBytes 一致');

  // Blob 接口
  const blob = writer.buildBlob();
  assert.equal(blob.type, 'application/zip');
  assert.equal(blob.size, bytes.length);

  // 逐个校验 local header 与 central directory
  let localOffset = 0;
  for (let i = 0; i < zip.central.length; i += 1) {
    const item = zip.central[i];
    const expect = expected[i];
    const expectedDos = dosDateTime(expect.date ?? fixedNow);

    // central directory 字段
    assert.equal(item.method, 0, '压缩方法必须是 STORE(0)');
    assert.equal(item.flags, 0x0800, 'flags 应为 0x0800（UTF-8 文件名）');
    assert.equal(item.versionNeeded, 20);
    assert.equal(item.versionMadeBy, 0x0014);
    assert.equal(item.extraLen, 0, '不应有 extra 字段');
    assert.equal(item.commentLen, 0, '不应有 comment 字段');
    assert.equal(item.diskStart, 0);
    assert.equal(item.internalAttrs, 0);
    assert.equal(item.externalAttrs, 0);
    assert.equal(item.compressedSize, expect.bytes.length);
    assert.equal(item.size, expect.bytes.length);
    assert.equal(item.crc, crc32(expect.bytes));
    assert.equal(item.time, expectedDos.time);
    assert.equal(item.date, expectedDos.date);
    assert.equal(item.localOffset, localOffset, 'central 记录的 local 偏移应正确');
    assert.deepEqual(
      Array.from(item.nameBytes),
      Array.from(encodeUtf8(expect.name)),
      '文件名 UTF-8 字节应一致',
    );

    // local file header 字段
    const lo = item.localOffset;
    assert.equal(u32(bytes, lo), 0x04034b50, 'local header 签名应为 0x04034b50');
    assert.equal(u16(bytes, lo + 4), 20, 'local version needed 应为 20');
    assert.equal(u16(bytes, lo + 6), 0x0800, 'local flags 应为 0x0800');
    assert.equal(u16(bytes, lo + 8), 0, 'local 压缩方法应为 STORE(0)');
    assert.equal(u16(bytes, lo + 10), expectedDos.time, 'local DOS 时间应与 central 一致');
    assert.equal(u16(bytes, lo + 12), expectedDos.date, 'local DOS 日期应与 central 一致');
    assert.equal(u32(bytes, lo + 14), item.crc, 'local CRC 应与 central 一致');
    assert.equal(u32(bytes, lo + 18), expect.bytes.length, 'local 压缩后大小错误');
    assert.equal(u32(bytes, lo + 22), expect.bytes.length, 'local 原始大小错误');
    assert.equal(u16(bytes, lo + 26), item.nameLen, 'local 文件名长度错误');
    assert.equal(u16(bytes, lo + 28), 0, 'local extra 长度应为 0');
    const dataStart = lo + 30 + item.nameLen;
    const stored = bytes.subarray(dataStart, dataStart + item.size);
    assert.ok(sameBytes(stored, expect.bytes), `条目 ${expect.name} 解出的数据应逐字节一致`);

    localOffset = dataStart + item.size;
  }
  assert.equal(localOffset, zip.cdOffset, 'local 区总长度应等于中央目录偏移');
});

// ---------------------------------------------------------------------------
// 3：CRC 独立验证
// ---------------------------------------------------------------------------

test('CRC32 标准向量、空数据与朴素逐位实现一致', () => {
  assert.equal(crc32(encodeUtf8('123456789')), 0xCBF43926, '标准校验向量 CRC 错误');
  assert.equal(crc32(new Uint8Array(0)), 0, '空数据 CRC 应为 0');

  const samples = [
    randomBytes(4096),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    Uint8Array.from([0x00, 0xFF, 0x00, 0xFF, 0x80, 0x7F]),
  ];
  for (const sample of samples) {
    assert.equal(crc32(sample), naiveCrc32(sample), '查表实现与朴素实现结果不一致');
  }

  const sample = randomBytes(1024);
  assert.equal(crc32(sample.buffer), crc32(sample), 'ArrayBuffer 输入应等价于 Uint8Array');
});

// ---------------------------------------------------------------------------
// 4：DOS 日期时间
// ---------------------------------------------------------------------------

test('dosDateTime 精确编码并正确钳制年份', () => {
  const d = new Date(2024, 0, 2, 3, 4, 5);
  assert.deepEqual(dosDateTime(d), {
    time: (3 << 11) | (4 << 5) | 2,
    date: ((2024 - 1980) << 9) | (1 << 5) | 2,
  });

  // 1980 年之前钳制为 1980
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1, 0, 0, 0)), {
    time: 0,
    date: 0 << 9 | (1 << 5) | 1,
  });

  // 2107 年之后钳制为 2107
  assert.deepEqual(dosDateTime(new Date(2200, 5, 15, 23, 59, 59)), {
    time: (23 << 11) | (59 << 5) | (59 >> 1),
    date: (127 << 9) | (6 << 5) | 15,
  });

  // 默认参数应返回整数
  const now = dosDateTime();
  assert.ok(Number.isInteger(now.time) && Number.isInteger(now.date));
});

// ---------------------------------------------------------------------------
// 5：上限与参数错误
// ---------------------------------------------------------------------------

test('条目数上限：maxEntries=1 时第二个文件抛错', () => {
  const writer = new ZipWriter({ maxEntries: 1 });
  writer.addFile('a.txt', 'a');
  assert.throws(
    () => writer.addFile('b.txt', 'b'),
    /ZIP 条目数超过上限 1，请分批导出/,
  );
  assert.equal(writer.entryCount, 1, '失败后条目数不应变化');
});

test('默认条目数上限信息包含 65535', () => {
  const writer = new ZipWriter();
  for (let i = 0; i < 65535; i += 1) writer.addFile(`f${i}`, '');
  assert.throws(
    () => writer.addFile('overflow.txt', ''),
    /ZIP 条目数超过上限 65535，请分批导出/,
  );
});

test('累计数据量上限：maxTotalBytes=4 时超限抛错', () => {
  const writer = new ZipWriter({ maxTotalBytes: 4 });
  assert.throws(() => writer.addFile('big.bin', new Uint8Array(5)), /超过 4 GiB/);
  assert.equal(writer.entryCount, 0, '失败后不应写入条目');
  assert.equal(writer.totalBytes, 0, '失败后累计字节数不应变化');
  writer.addFile('ok.bin', new Uint8Array(4));
  assert.equal(writer.totalBytes, 4);
});

test('文件名与数据参数校验', () => {
  const writer = new ZipWriter();
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.throws(() => writer.addFile(bad, 'x'), /文件名必须是非空字符串/);
  }
  assert.throws(() => writer.addFile('   ', 42), /文件内容必须是 string、Uint8Array 或 ArrayBuffer/);
  assert.throws(
    () => writer.addFile('big-name.txt', 'x', { date: '2024-01-01' }),
    /date 必须是有效的 Date 实例/,
  );

  // 文件名 UTF-8 字节长度 > 65535
  const tooLong = '中'.repeat(21846); // 3 * 21846 = 65538 字节
  assert.throws(() => writer.addFile(tooLong, 'x'), /超过 65535/);
  assert.equal(writer.entryCount, 0);

  // 恰好 65535 字节的文件名是合法的
  writer.addFile('a'.repeat(65535), '');
  assert.equal(writer.entryCount, 1);
});

// ---------------------------------------------------------------------------
// 6：Python zipfile 交叉校验（关键）
// ---------------------------------------------------------------------------

test('Python zipfile 交叉校验：testzip、文件名与逐项 sha256', (t) => {
  const python = getPython();
  if (!python) {
    t.skip('未找到 Python');
    return;
  }

  const specs = [
    { name: '中文目录/莫莫.png', data: randomBytes(2048) },
    { name: '表情😀🚀.txt', data: '你好，世界！🌍 SillyTavern 导出' },
    { name: 'empty.bin', data: new Uint8Array(0) },
    { name: 'random.bin', data: randomBytes(300 * 1024) },
    { name: 'zero-ff.bin', data: Uint8Array.from([0x00, 0xFF, 0x00, 0xFF, 0x00]) },
  ];
  const writer = new ZipWriter({ now: () => new Date(2024, 0, 2, 3, 4, 5) });
  const expected = specs.map((spec) => {
    const bytes = typeof spec.data === 'string' ? encodeUtf8(spec.data) : spec.data;
    writer.addFile(spec.name, spec.data);
    return { name: spec.name, bytes };
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stfe-zip-'));
  try {
    const zipPath = path.join(dir, 'export.zip');
    fs.writeFileSync(zipPath, writer.buildBytes());

    const result = runPythonZipCheck(python, zipPath);
    assert.deepEqual(
      result.names,
      expected.map((item) => item.name),
      'Python 解析出的条目名（含中文/emoji 解码）应与写入顺序一致',
    );
    assert.equal(result.entries.length, expected.length);
    for (const item of expected) {
      const got = result.entries.find((entry) => entry.name === item.name);
      assert.ok(got, `Python 输出中缺少条目 ${item.name}`);
      assert.equal(got.size, item.bytes.length, `条目 ${item.name} 的字节长度不一致`);
      assert.equal(got.sha256, sha256Hex(item.bytes), `条目 ${item.name} 的 sha256 不一致`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7：空 ZIP 边界
// ---------------------------------------------------------------------------

test('空 writer 生成合法空 ZIP（EOCD 条目数 0）', (t) => {
  const writer = new ZipWriter();
  assert.equal(writer.entryCount, 0);
  assert.equal(writer.totalBytes, 0);
  assert.deepEqual(writer.listEntries(), []);

  const parts = writer.buildParts();
  assert.equal(parts.length, 1, '空 ZIP 只应包含一个 EOCD 分片');
  const bytes = writer.buildBytes();
  assert.equal(bytes.length, 22, '空 ZIP 长度应为 22 字节');
  assert.equal(u32(bytes, 0), 0x06054b50, 'EOCD 签名错误');
  assert.equal(u16(bytes, 4), 0);
  assert.equal(u16(bytes, 6), 0);
  assert.equal(u16(bytes, 8), 0, 'EOCD 条目数应为 0');
  assert.equal(u16(bytes, 10), 0);
  assert.equal(u32(bytes, 12), 0, '中央目录大小应为 0');
  assert.equal(u32(bytes, 16), 0, '中央目录偏移应为 0');
  assert.equal(u16(bytes, 20), 0);

  const zip = inspectZip(bytes);
  assert.equal(zip.count, 0);

  const python = getPython();
  if (!python) {
    t.skip('未找到 Python');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stfe-zip-empty-'));
  try {
    const zipPath = path.join(dir, 'empty.zip');
    fs.writeFileSync(zipPath, bytes);
    const result = runPythonZipCheck(python, zipPath);
    assert.deepEqual(result.names, []);
    assert.deepEqual(result.entries, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
