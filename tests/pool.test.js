// src/pool.js 的单元测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../src/pool.js';
import { sleep } from '../src/util.js';

test('runPool 空数组立即返回 []', async () => {
  let calls = 0;
  const result = await runPool([], async () => {
    calls += 1;
    return '不应调用';
  }, { concurrency: 4 });
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test('runPool 观察到的并发不超过上限且能达到上限', async () => {
  const items = [1, 2, 3, 4, 5, 6];
  let active = 0;
  let maxActive = 0;
  const result = await runPool(items, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
    return item * 2;
  }, { concurrency: 2 });

  assert.ok(maxActive <= 2, `最大并发应 <= 2，实际 ${maxActive}`);
  assert.ok(maxActive >= 2, `最大并发应 >= 2，实际 ${maxActive}`);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});

test('runPool 结果顺序与 items 一致（与完成顺序无关）', async () => {
  const items = [40, 10, 30, 20];
  const result = await runPool(items, async (delay) => {
    await sleep(delay);
    return delay;
  }, { concurrency: 4 });
  assert.deepEqual(result, items);
});

test('runPool 非法并发按 1 处理', async () => {
  let active = 0;
  let maxActive = 0;
  await runPool([1, 2, 3], async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
  }, { concurrency: 0 });
  assert.equal(maxActive, 1);
});

test('runPool worker 抛错时整体 reject 且不产生 unhandled rejection', async () => {
  const boom = new Error('boom');
  // 等待一小段时间，让被丢弃的 promise 有机会触发 unhandledRejection
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runPool([1, 2, 3, 4, 5], async (item) => {
        if (item === 2) {
          throw boom;
        }
        return item;
      }, { concurrency: 2 }),
      (err) => err === boom,
    );
    await sleep(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('runPool 预取消时 worker 一次都不会被调用', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    runPool([1, 2, 3], async () => {
      calls += 1;
      return calls;
    }, { concurrency: 2, signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('runPool 中途取消：不再开始新任务并 reject AbortError', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    runPool([1, 2, 3, 4, 5], async (item) => {
      calls += 1;
      if (item === 1) {
        controller.abort();
      }
      return item;
    }, { concurrency: 1, signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(calls, 1);
});