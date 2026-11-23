// src/util.js 的单元测试（Node 内置 test runner + assert/strict）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AbortError,
  isAbortError,
  throwIfAborted,
  sleep,
  escapeHtml,
  formatBytes,
  toArray,
  isPlainObject,
  truncateText,
  describeError,
  saveBlob,
} from '../src/util.js';

test('AbortError 与 isAbortError', () => {
  const err = new AbortError();
  assert.equal(err.name, 'AbortError');
  assert.equal(err.message, '操作已取消');
  assert.ok(err instanceof Error);
  assert.ok(isAbortError(err));
  assert.ok(isAbortError({ name: 'AbortError' }));
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(null), false);
});

test('throwIfAborted 仅在已取消时抛错', () => {
  assert.doesNotThrow(() => throwIfAborted(undefined));
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), (err) => err.name === 'AbortError');
});

test('sleep 正常等待并 resolve', async () => {
  const start = Date.now();
  await sleep(30);
  assert.ok(Date.now() - start >= 20);
  // 非法时长按 0 处理，应立即 resolve
  await sleep(Number.NaN);
  await sleep(-100);
});

test('sleep 预取消立即 reject', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(1000, controller.signal), (err) => err.name === 'AbortError');
});

test('sleep 中途取消 reject 并清理定时器', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const pending = sleep(500, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.ok(Date.now() - start < 400);
});

test('escapeHtml 转义全部特殊字符', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('<a href="x">\' &</a>'), '&lt;a href=&quot;x&quot;&gt;&#39; &amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('formatBytes 边界', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), '0 B');
  assert.equal(formatBytes('1024'), '0 B');
});

test('toArray 仅保留数组', () => {
  const arr = [1, 2];
  assert.equal(toArray(arr), arr);
  assert.deepEqual(toArray('abc'), []);
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray({ length: 1 }), []);
});

test('isPlainObject 判断', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject('x'), false);
  assert.equal(isPlainObject(undefined), false);
});

test('truncateText 截断并追加省略号', () => {
  assert.equal(truncateText('hello'), 'hello');
  assert.equal(truncateText('abcdef', 3), 'abc…');
  assert.equal(truncateText('a'.repeat(100)).length, 81);
  assert.ok(truncateText('a'.repeat(100)).endsWith('…'));
  assert.equal(truncateText(null), '');
  assert.equal(truncateText(123, 2), '12…');
});

test('truncateText 按 code point 截断，不切断 emoji 代理对', () => {
  const text = '😀'.repeat(10);
  const result = truncateText(text, 3);
  assert.equal(result, '😀😀😀…');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result), '不应留下孤立高位代理');
  assert.equal(truncateText('😀😀', 2), '😀😀');
  assert.equal(truncateText('😀😀😀', 2), '😀😀…');
});

test('describeError 生成可读错误文本', () => {
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError({ message: '自定义' }), '自定义');
  assert.equal(describeError({ message: '' }), '[object Object]');
  assert.equal(describeError(''), '未知错误');
  assert.equal(describeError(null), 'null');
  const long = describeError(new Error('x'.repeat(600)));
  assert.equal(long.length, 500);
  assert.ok(long.endsWith('…'));
});

test('saveBlob 在无 document 的 Node 环境抛错', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.throws(() => saveBlob(new Blob(['x']), 'a.txt'), /当前环境不支持文件下载/);
});