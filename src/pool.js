// 并发池：按固定并发数执行异步任务，支持取消与快速失败。
import { AbortError, throwIfAborted } from './util.js';

/**
 * 并发执行 items，返回与 items 顺序一致的结果数组。
 * @param {readonly any[]} items
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {{ concurrency?: number, signal?: AbortSignal }} [options]
 */
export async function runPool(items, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const signal = options.signal;
  const rawConcurrency = Number(options.concurrency);
  const concurrency = Number.isInteger(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 1;

  if (list.length === 0) {
    return [];
  }

  // 进入即检查取消：worker 一次都不会被调用
  throwIfAborted(signal);

  const results = new Array(list.length);
  let nextIndex = 0;
  let failure = null;
  let aborted = Boolean(signal?.aborted);

  const onAbort = () => {
    aborted = true;
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const runner = async () => {
    while (!failure && !aborted) {
      const index = nextIndex;
      if (index >= list.length) {
        return;
      }
      nextIndex += 1;
      try {
        results[index] = await worker(list[index], index);
      } catch (err) {
        failure = err;
        return;
      }
    }
  };

  try {
    const runnerCount = Math.min(concurrency, list.length);
    const runners = Array.from({ length: runnerCount }, () => runner());
    // 用 allSettled 收尾：runner 自身不会 reject，但保证任何异常都被收敛
    await Promise.allSettled(runners);
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }

  if (failure) {
    throw failure;
  }
  if (aborted || signal?.aborted) {
    throw new AbortError('已取消');
  }
  return results;
}