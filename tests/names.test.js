// src/names.js 的单元测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZIP_INVALID_CHARS,
  sanitizeZipFileName,
  splitExtension,
  allocateUniqueName,
  NameAllocator,
  pngBaseName,
} from '../src/names.js';

// 孤立代理项（UTF-16 半个 emoji）检测
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('ZIP_INVALID_CHARS 覆盖 Windows 非法字符', () => {
  assert.ok(ZIP_INVALID_CHARS instanceof RegExp);
  for (const char of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    ZIP_INVALID_CHARS.lastIndex = 0;
    assert.ok(ZIP_INVALID_CHARS.test(char), `应匹配 ${char}`);
  }
  ZIP_INVALID_CHARS.lastIndex = 0;
});

test('sanitizeZipFileName 替换控制字符与非法字符', () => {
  assert.equal(sanitizeZipFileName('a\u0000b\u001Fc\u007Fd'), 'a_b_c_d');
  assert.equal(sanitizeZipFileName('a\\b/c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeZipFileName 去掉结尾空格与点', () => {
  assert.equal(sanitizeZipFileName('a . . '), 'a');
  assert.equal(sanitizeZipFileName('file...'), 'file');
  assert.equal(sanitizeZipFileName('name.png'), 'name.png');
});

test('sanitizeZipFileName 空名与点号使用 fallback', () => {
  assert.equal(sanitizeZipFileName(''), 'file');
  assert.equal(sanitizeZipFileName(' . '), 'file');
  assert.equal(sanitizeZipFileName('.'), 'file');
  assert.equal(sanitizeZipFileName('..'), 'file');
  assert.equal(sanitizeZipFileName(null), 'file');
  assert.equal(sanitizeZipFileName('', { fallback: '报告' }), '报告');
  assert.equal(sanitizeZipFileName('', { fallback: '?' }), '_');
  assert.equal(sanitizeZipFileName('', { fallback: '..' }), 'file');
  assert.equal(sanitizeZipFileName('...', { fallback: '' }), 'file');
});

test('sanitizeZipFileName 保留 .png 扩展名', () => {
  assert.equal(sanitizeZipFileName('Momo.png'), 'Momo.png');
  assert.equal(sanitizeZipFileName('Momo.PNG'), 'Momo.PNG');
  assert.equal(sanitizeZipFileName('测试🎉 角色卡.png'), '测试🎉 角色卡.png');
});

test('sanitizeZipFileName 规避 Windows 保留设备名', () => {
  assert.equal(sanitizeZipFileName('con.png'), '_con.png');
  assert.equal(sanitizeZipFileName('NUL.txt'), '_NUL.txt');
  assert.equal(sanitizeZipFileName('COM1'), '_COM1');
  assert.equal(sanitizeZipFileName('aux'), '_aux');
  assert.equal(sanitizeZipFileName('prn.png'), '_prn.png');
  assert.equal(sanitizeZipFileName('lpt9.tar.gz'), '_lpt9.tar.gz');
  // 形似但非保留名不应被改。
  assert.equal(sanitizeZipFileName('console.png'), 'console.png');
  assert.equal(sanitizeZipFileName('con artist.png'), 'con artist.png');
  // fallback 同样要走保留名检查。
  assert.equal(sanitizeZipFileName('', { fallback: 'CON.txt' }), '_CON.txt');
});

test('sanitizeZipFileName 超长名截断且保留扩展名', () => {
  const longName = `${'名'.repeat(200)}.png`;
  const result = sanitizeZipFileName(longName);
  assert.ok(result.length <= 120, `长度应 <= 120，实际 ${result.length}`);
  assert.ok(result.endsWith('.png'));
});

test('sanitizeZipFileName 超长扩展名不保留', () => {
  const longName = `${'a'.repeat(200)}.verylongext`;
  const result = sanitizeZipFileName(longName);
  assert.ok(result.length <= 120);
});

test('sanitizeZipFileName 中文与 emoji 原样保留', () => {
  assert.equal(sanitizeZipFileName('中文名称🎉.txt'), '中文名称🎉.txt');
});

test('sanitizeZipFileName 截断不会切断 emoji 代理对', () => {
  const name = `${'😀'.repeat(100)}.png`;
  const result = sanitizeZipFileName(name);
  assert.ok(result.length <= 120, `长度应 <= 120，实际 ${result.length}`);
  assert.ok(result.endsWith('.png'));
  assert.ok(!LONE_SURROGATE.test(result), '不应留下孤立代理项');
  assert.equal(result.includes('\uFFFD'), false);
});

test('allocateUniqueName 按 NFC + 小写去重，保留原拼写', () => {
  const used = new Set();
  assert.equal(allocateUniqueName('Momo.png', used), 'Momo.png');
  assert.equal(allocateUniqueName('momo.png', used), 'momo (2).png');
  assert.equal(allocateUniqueName('MOMO.PNG', used), 'MOMO (3).PNG');

  const nfc = 'é.png';
  const nfd = 'e\u0301.png';
  const used2 = new Set();
  assert.equal(allocateUniqueName(nfc, used2), nfc);
  assert.equal(allocateUniqueName(nfd, used2), 'e\u0301 (2).png');
});

test('NameAllocator 同样按 NFC + 小写判重（PNG 与 json/ 子目录）', () => {
  const allocator = new NameAllocator(['Momo.png']);
  assert.equal(allocator.has('momo.png'), true);
  assert.equal(allocator.has('MOMO.PNG'), true);
  assert.equal(allocator.allocate('momo.png'), 'momo (2).png');

  const jsonAllocator = new NameAllocator();
  assert.equal(jsonAllocator.allocate('Momo.json'), 'Momo.json');
  assert.equal(jsonAllocator.allocate('momo.json'), 'momo (2).json');
});

test('splitExtension 拆分扩展名', () => {
  assert.deepEqual(splitExtension('Momo.png'), { base: 'Momo', ext: '.png' });
  assert.deepEqual(splitExtension('a.b.png'), { base: 'a.b', ext: '.png' });
  assert.deepEqual(splitExtension('Momo'), { base: 'Momo', ext: '' });
  assert.deepEqual(splitExtension('Momo.'), { base: 'Momo.', ext: '' });
  assert.deepEqual(splitExtension('.'), { base: '.', ext: '' });
  assert.deepEqual(splitExtension('..'), { base: '..', ext: '' });
  assert.deepEqual(splitExtension('.png'), { base: '.png', ext: '' });
});

test('allocateUniqueName 连续分配同名文件', () => {
  const used = new Set();
  assert.equal(allocateUniqueName('Momo.png', used), 'Momo.png');
  assert.equal(allocateUniqueName('Momo.png', used), 'Momo (2).png');
  assert.equal(allocateUniqueName('Momo.png', used), 'Momo (3).png');
  assert.ok(used.has('Momo (3).png'));
  assert.equal(used.size, 3);
});

test('allocateUniqueName 无扩展名与空名', () => {
  const used = new Set();
  assert.equal(allocateUniqueName('Momo', used), 'Momo');
  assert.equal(allocateUniqueName('Momo', used), 'Momo (2)');
  assert.equal(allocateUniqueName('', used), 'file');
  assert.equal(allocateUniqueName(null, used), 'file (2)');
});

test('NameAllocator 维护初始集合', () => {
  const allocator = new NameAllocator(['a.txt', 'b.txt']);
  assert.equal(allocator.size, 2);
  assert.equal(allocator.has('a.txt'), true);
  assert.equal(allocator.has('c.txt'), false);
  assert.equal(allocator.allocate('a.txt'), 'a (2).txt');
  assert.equal(allocator.size, 3);
  assert.equal(new NameAllocator().size, 0);
});

test('pngBaseName 去掉一层 .png（大小写不敏感）', () => {
  assert.equal(pngBaseName('Momo.png'), 'Momo');
  assert.equal(pngBaseName('Momo.PNG'), 'Momo');
  assert.equal(pngBaseName('a.b.png'), 'a.b');
  assert.equal(pngBaseName('Momo'), 'Momo');
  assert.equal(pngBaseName('x.png.png'), 'x.png');
});