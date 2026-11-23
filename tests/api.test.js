/**
 * src/api.js 的单元测试（node:test + node:assert/strict，零第三方依赖）。
 *
 * 用 mock fetch 工厂记录每次调用的 url / method / headers / 解析后的 body，
 * 覆盖请求构造、重试、鉴权、CSRF 回退、PNG 校验与取消等场景。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, createApi } from '../src/api.js';
import { collectAllChatRecords, exportAllChats } from '../src/chats.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 创建 mock fetch：调用记录写入返回函数的 calls 数组。
 *
 * @param {(call: { url: string, options: any, method: string, headers: any, body: any, bodyJson: any }, calls: any[]) => any} handler
 */
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const call = {
      url: String(url),
      options,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      bodyJson: undefined,
    };
    if (typeof options.body === 'string') {
      try {
        call.bodyJson = JSON.parse(options.body);
      } catch {
        call.bodyJson = undefined;
      }
    }
    calls.push(call);
    return handler(call, calls);
  };
  fn.calls = calls;
  return fn;
}

/** 构造 JSON 响应 */
function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

/** 构造文本响应 */
function textResponse(text, init = {}) {
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': init.contentType || 'text/plain' },
  });
}

/** 构造带 getRequestHeaders 的 ST 上下文 */
function makeCtx({ characters = [], groups = [], token = 'csrf-token-123' } = {}) {
  return {
    characters,
    groups,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': token }),
  };
}

const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------
// 1. 正常请求构造
// ---------------------------------------------------------------------------

test('getCharacters：ctx 有角色时不发请求，返回浅拷贝', async () => {
  const ctx = makeCtx({ characters: [{ name: 'A', avatar: 'a.png' }] });
  const fetchMock = mockFetch(() => jsonResponse([]));
  const api = createApi({ ctx, fetchImpl: fetchMock });

  const characters = await api.getCharacters();

  assert.equal(fetchMock.calls.length, 0);
  assert.deepEqual(characters, [{ name: 'A', avatar: 'a.png' }]);
  assert.notEqual(characters, ctx.characters, '应返回浅拷贝而不是原数组');
  assert.equal(typeof api.fetchImpl, 'function');
  assert.equal(api.fetchImpl, fetchMock);
});

test('getCharacters：ctx 为空时 POST /api/characters/all 且 headers 来自 ctx', async () => {
  const ctx = makeCtx();
  const fetchMock = mockFetch(() => jsonResponse([{ name: 'B' }]));
  const api = createApi({ ctx, fetchImpl: fetchMock });

  const characters = await api.getCharacters();

  assert.deepEqual(characters, [{ name: 'B' }]);
  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, '/api/characters/all');
  assert.equal(call.method, 'POST');
  assert.equal(call.options.credentials, 'same-origin');
  assert.deepEqual(call.bodyJson, {});
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['X-CSRF-Token'], 'csrf-token-123');
});

test('getGroups：ctx.groups 为空时 POST /api/groups/all', async () => {
  const fetchMock = mockFetch(() => jsonResponse([{ id: 1, name: '群' }]));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  const groups = await api.getGroups();

  assert.deepEqual(groups, [{ id: 1, name: '群' }]);
  assert.equal(fetchMock.calls[0].url, '/api/groups/all');
  assert.deepEqual(fetchMock.calls[0].bodyJson, {});
});

// ---------------------------------------------------------------------------
// 2. 非数组响应
// ---------------------------------------------------------------------------

test('非数组响应：角色/群组归一为空数组，聊天列表返回 null 交上层判断', async () => {
  const fetchMock = mockFetch(() => jsonResponse({ error: true }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  assert.deepEqual(await api.getCharacters(), []);
  assert.deepEqual(await api.getGroups(), []);
  assert.equal(await api.listCharacterChats('Momo.png'), null);
});

// ---------------------------------------------------------------------------
// 3 / 4. 聊天读取的请求体
// ---------------------------------------------------------------------------

test('getCharacterChat：原样传 file_id，不二次剥离 .jsonl', async () => {
  const fetchMock = mockFetch(() => jsonResponse([]));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await api.getCharacterChat('Momo.png', 'x.jsonl', 'Momo');

  const call = fetchMock.calls[0];
  assert.equal(call.url, '/api/chats/get');
  assert.deepEqual(call.bodyJson, {
    avatar_url: 'Momo.png',
    file_name: 'x.jsonl',
    ch_name: 'Momo',
  });
});

test('getCharacterChat：主干以 .jsonl 结尾时也必须原值传递', async () => {
  const fetchMock = mockFetch(() => jsonResponse({}));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  const payload = await api.getCharacterChat('Momo.png', 'a.jsonl');

  assert.deepEqual(payload, {}, '应原样返回服务端的 {}');
  assert.deepEqual(fetchMock.calls[0].bodyJson, {
    avatar_url: 'Momo.png',
    file_name: 'a.jsonl',
    ch_name: '',
  });
});

test('getGroupChat：id 转为字符串', async () => {
  const fetchMock = mockFetch(() => jsonResponse([]));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await api.getGroupChat(123);

  assert.equal(fetchMock.calls[0].url, '/api/chats/group/get');
  assert.deepEqual(fetchMock.calls[0].bodyJson, { id: '123' });
});

// ---------------------------------------------------------------------------
// 5. 401 不重试
// ---------------------------------------------------------------------------

test('401：抛 auth 错误且不重试', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>login</body></html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.post('/api/characters/all', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
    assert.match(err.message, /未登录/);
    return true;
  });

  assert.equal(fetchMock.calls.length, 1, '401 不应重试');
});

// ---------------------------------------------------------------------------
// 6. 5xx 重试
// ---------------------------------------------------------------------------

test('500：默认重试 2 次（共 3 次）后抛 http 错误', async () => {
  const fetchMock = mockFetch(
    () => new Response('server boom', { status: 500, statusText: 'Internal Server Error' }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.kind, 'http');
    return true;
  });

  assert.equal(fetchMock.calls.length, 3);
  assert.deepEqual(
    fetchMock.calls.map((call) => call.url),
    ['/api/groups/all', '/api/groups/all', '/api/groups/all'],
  );
});

test('500：第二次成功时正常返回数据', async () => {
  let attempt = 0;
  const fetchMock = mockFetch(() => {
    attempt += 1;
    return attempt === 1
      ? new Response('boom', { status: 500 })
      : jsonResponse([{ name: 'G' }]);
  });
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  assert.deepEqual(await api.getGroups(), [{ name: 'G' }]);
  assert.equal(fetchMock.calls.length, 2);
});

// ---------------------------------------------------------------------------
// 7. 网络错误重试
// ---------------------------------------------------------------------------

test('网络错误：前两次失败、第三次成功 → 调用 3 次并返回数据', async () => {
  let attempt = 0;
  const fetchMock = mockFetch(() => {
    attempt += 1;
    if (attempt <= 2) {
      throw new TypeError('fetch failed');
    }
    return jsonResponse([{ name: 'C' }]);
  });
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  assert.deepEqual(await api.getCharacters(), [{ name: 'C' }]);
  assert.equal(fetchMock.calls.length, 3);
});

test('网络错误：重试耗尽后抛 network 错误', async () => {
  const fetchMock = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'network');
    assert.match(err.message, /fetch failed/);
    return true;
  });
  assert.equal(fetchMock.calls.length, 3);
});

test('maxRetries: 0 时 500 只请求一次', async () => {
  const fetchMock = mockFetch(() => new Response('boom', { status: 500 }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1, maxRetries: 0 });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    return true;
  });
  assert.equal(fetchMock.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 7.1 2xx 但返回 HTML（登录页 / 反向代理 / SSO）
// ---------------------------------------------------------------------------

test('200 HTML：post() 抛 auth 错误且不重试', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.post('/api/characters/all', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 200);
    assert.match(err.message, /登录页/);
    assert.ok(!err.message.includes('<'), 'message 不应包含 HTML 标签');
    return true;
  });
  assert.equal(fetchMock.calls.length, 1, '2xx HTML 不应重试');
});

test('200 text/html 空 body 也按登录页处理', async () => {
  const fetchMock = mockFetch(
    () => new Response('', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.post('/api/characters/all', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    return true;
  });
  assert.equal(fetchMock.calls.length, 1);
});

test('200 JSON 消息正文包含 <html> / <!doctype html> 时不会被误判为登录页', async () => {
  const payload = [
    { name: 'Momo', mes: '看这段代码：<html><body>...</body></html>', send_date: '2024-01-01T00:00:00.000Z' },
    { name: '用户', mes: '<!doctype html>\n<html><body>hello</body></html>' },
    { name: 'Momo', mes: '普通消息' },
  ];
  const fetchMock = mockFetch(() => jsonResponse(payload));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  assert.deepEqual(await api.getCharacterChat('Momo.png', 'chat', 'Momo'), payload);
  assert.deepEqual(await api.post('/api/chats/get', { avatar_url: 'Momo.png', file_name: 'chat' }), payload);
  assert.equal(fetchMock.calls.length, 2);
});

test('200 HTML 伪装成 application/json 也会被识别', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.getCharacters(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    return true;
  });
  assert.equal(fetchMock.calls.length, 1);
});

test('200 HTML：collectAllChatRecords 与 exportAllChats 都会 reject（不再静默导出空文件）', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(
    () => collectAllChatRecords({ api }),
    /会话已过期或服务器返回了登录页|登录页/,
  );
  await assert.rejects(
    () => exportAllChats({ api, format: 'json', now: () => new Date() }),
    /会话已过期或服务器返回了登录页|登录页/,
  );
});

test('500 HTML 错误页：kind http，message 不含 HTML 标签', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>internal error</body></html>', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'http', '500 HTML 不是鉴权失败，不能中止整次导出');
    assert.equal(err.status, 500);
    assert.ok(!err.message.includes('<'), 'message 不应包含 <');
    assert.ok(!err.message.includes('internal error'));
    return true;
  });
  assert.equal(fetchMock.calls.length, 3, '5xx 仍会按既有逻辑重试');
});

test('502/504/404 HTML 错误页：kind http，message 无标签', async () => {
  for (const status of [502, 504, 404]) {
    const fetchMock = mockFetch(
      () => new Response('<!doctype html><html><body>gateway error</body></html>', {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1, maxRetries: 0 });
    await assert.rejects(api.getGroups(), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, 'http', `HTTP ${status} HTML 不应算 auth`);
      assert.equal(err.status, status);
      assert.ok(!err.message.includes('<'));
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// 8. 403
// ---------------------------------------------------------------------------

test('403 带 HTML body（无 CSRF 证据）→ kind http，不拼接 HTML 片段', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<html><body>Forbidden</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'http', '非 CSRF 的 403 只算单文件失败');
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('<'), 'message 不应包含 <');
    assert.ok(!err.message.includes('Forbidden'));
    return true;
  });
  assert.equal(fetchMock.calls.length, 1);
});

test('403 纯文本但没有 CSRF 证据 → kind http', async () => {
  const fetchMock = mockFetch(
    () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 403);
    return true;
  });
});

test('403 响应体含 CSRF 证据 → kind csrf', async () => {
  const fetchMock = mockFetch(
    () => new Response('Invalid CSRF token.', { status: 403, headers: { 'content-type': 'text/plain' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'csrf');
    assert.equal(err.status, 403);
    assert.match(err.message, /CSRF/);
    return true;
  });
  assert.equal(fetchMock.calls.length, 1);
});

test('其他 4xx 纯文本：HTTP 状态与片段保留', async () => {
  const fetchMock = mockFetch(
    () => new Response('not found', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.getGroups(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 404);
    assert.match(err.message, /HTTP 404/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 9. headers 回退链
// ---------------------------------------------------------------------------

test('headers 回退：headersProvider 优先', async () => {
  const fetchMock = mockFetch(() => jsonResponse([{ name: 'P' }]));
  const api = createApi({
    fetchImpl: fetchMock,
    headersProvider: () => ({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'provider-token',
    }),
  });

  await api.getCharacters();

  assert.equal(fetchMock.calls.length, 1, '不应额外请求 /csrf-token');
  assert.equal(fetchMock.calls[0].headers['X-CSRF-Token'], 'provider-token');
});

test('headers 回退：documentRef 的 meta csrf-token', async () => {
  const fetchMock = mockFetch(() => jsonResponse([]));
  const documentRef = {
    querySelector: (selector) =>
      selector === 'meta[name="csrf-token"]'
        ? { getAttribute: () => 'meta-token' }
        : null,
  };
  const api = createApi({ fetchImpl: fetchMock, documentRef });

  await api.getGroups();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].headers['X-CSRF-Token'], 'meta-token');
});

test('headers 回退：GET /csrf-token 获取并缓存 token', async () => {
  const fetchMock = mockFetch((call) => {
    if (call.url === '/csrf-token') {
      return jsonResponse({ token: 'abc' });
    }
    return jsonResponse([]);
  });
  const api = createApi({ fetchImpl: fetchMock });

  await api.getGroups();
  await api.listCharacterChats('Momo.png');

  const tokenCalls = fetchMock.calls.filter((call) => call.url === '/csrf-token');
  assert.equal(tokenCalls.length, 1, 'token 端点只请求一次（缓存）');
  assert.equal(tokenCalls[0].method, 'GET');

  const postCalls = fetchMock.calls.filter((call) => call.url !== '/csrf-token');
  assert.equal(postCalls.length, 2);
  for (const call of postCalls) {
    assert.equal(call.headers['X-CSRF-Token'], 'abc');
  }
});

test('headers 回退：/csrf-token 失败时仅带 Content-Type', async () => {
  const fetchMock = mockFetch((call) => {
    if (call.url === '/csrf-token') {
      return new Response('nope', { status: 500 });
    }
    return jsonResponse([]);
  });
  const api = createApi({ fetchImpl: fetchMock, retryDelay: 1 });

  await api.getGroups();
  await api.getGroups();

  const tokenCalls = fetchMock.calls.filter((call) => call.url === '/csrf-token');
  assert.equal(tokenCalls.length, 1, '失败结果同样缓存');
  const postCalls = fetchMock.calls.filter((call) => call.url !== '/csrf-token');
  for (const call of postCalls) {
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json' });
  }
});

// ---------------------------------------------------------------------------
// 10. 角色卡 PNG
// ---------------------------------------------------------------------------

test('fetchCharacterPng：返回正确的 PNG 字节', async () => {
  const bytes = new Uint8Array([...PNG_SIGNATURE_BYTES, 0x00, 0x01, 0x02, 0x03]);
  const fetchMock = mockFetch(
    () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  const png = await api.fetchCharacterPng('Momo.png');

  assert.ok(png instanceof Uint8Array);
  assert.deepEqual(Array.from(png), Array.from(bytes));
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].url, '/characters/Momo.png');
  assert.equal(fetchMock.calls[0].method, 'GET');
  assert.equal(fetchMock.calls[0].options.credentials, 'same-origin');
});

test('fetchCharacterPng：text/html 登录页 → auth 错误（不是 PNG 签名错误）', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.fetchCharacterPng('Momo.png'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    assert.match(err.message, /登录页/);
    return true;
  });
});

test('fetchCharacterPng：content-type 伪装 image/png 但 body 是 HTML → auth 错误', async () => {
  const fetchMock = mockFetch(
    () =>
      new Response('<!doctype html><html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.fetchCharacterPng('Momo.png'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'auth');
    return true;
  });
});

test('fetchCharacterPng：既非 HTML 也非 PNG → format 错误', async () => {
  const fetchMock = mockFetch(
    () => new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.fetchCharacterPng('Momo.png'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'format');
    assert.match(err.message, /PNG/);
    return true;
  });
});

test('fetchCharacterPng：HTTP 404 → status 为 404 的 http 错误', async () => {
  const fetchMock = mockFetch(() => new Response('not found', { status: 404 }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.fetchCharacterPng('Momo.png'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.kind, 'http');
    assert.match(err.message, /404/);
    return true;
  });
});

test('fetchCharacterPng：URL 中的中文 / 空格 / # 会被 encodeURIComponent', async () => {
  const fetchMock = mockFetch(
    () => new Response(new Uint8Array(PNG_SIGNATURE_BYTES), { status: 200 }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await api.fetchCharacterPng('Momo #1.png');

  assert.equal(fetchMock.calls[0].url, '/characters/Momo%20%231.png');
});

// ---------------------------------------------------------------------------
// 11. 单个角色卡
// ---------------------------------------------------------------------------

test('getCharacter：返回角色对象；{ error: true } 抛错', async () => {
  const fetchMock = mockFetch(() => jsonResponse({ name: 'Momo', json_data: '{}' }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  const character = await api.getCharacter('Momo.png');
  assert.deepEqual(character, { name: 'Momo', json_data: '{}' });
  assert.equal(fetchMock.calls[0].url, '/api/characters/get');
  assert.deepEqual(fetchMock.calls[0].bodyJson, { avatar_url: 'Momo.png' });

  const errorFetch = mockFetch(() => jsonResponse({ error: true }));
  const errorApi = createApi({ ctx: makeCtx(), fetchImpl: errorFetch });
  await assert.rejects(errorApi.getCharacter('Momo.png'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /读取角色卡失败/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 12. 取消
// ---------------------------------------------------------------------------

test('已 abort 的 signal：立即抛 AbortError 且不发请求', async () => {
  const fetchMock = mockFetch(() => jsonResponse([]));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    api.post('/api/characters/all', {}, { signal: controller.signal }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      assert.ok(err.kind === 'abort' || err.name === 'AbortError');
      return true;
    },
  );

  assert.equal(fetchMock.calls.length, 0);
});

test('请求中途 abort：不重试且抛 AbortError', async () => {
  const controller = new AbortController();
  const fetchMock = mockFetch(() => {
    controller.abort();
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock, retryDelay: 1 });

  await assert.rejects(
    api.post('/api/groups/all', {}, { signal: controller.signal }),
    (err) => {
      assert.equal(err.name, 'AbortError');
      return true;
    },
  );
  assert.equal(fetchMock.calls.length, 1, 'abort 不应重试');
});

// ---------------------------------------------------------------------------
// 13. 响应体解析
// ---------------------------------------------------------------------------

test('text/plain 但 body 是合法 JSON → 正常解析对象', async () => {
  const fetchMock = mockFetch(() => textResponse('{"ok":true}', { contentType: 'text/plain; charset=utf-8' }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  assert.deepEqual(await api.post('/api/chats/get', {}), { ok: true });
});

test('text/plain 非 JSON → format 错误（不再返回裸字符串）', async () => {
  const fetchMock = mockFetch(() => textResponse('纯文本', { contentType: 'text/plain; charset=utf-8' }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.post('/api/chats/get', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'format');
    return true;
  });
});

test('纯空白 body → null', async () => {
  const fetchMock = mockFetch(() => textResponse('   \n\t', { contentType: 'text/plain' }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  assert.equal(await api.post('/api/chats/get', {}), null);
});

test('content-type 声明 JSON 但解析失败 → format 错误', async () => {
  const fetchMock = mockFetch(
    () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.post('/api/chats/get', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'format');
    return true;
  });
});

test('读取响应体失败 → format 错误（不静默当空数据）', async () => {
  const fetchMock = mockFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => {
      throw new Error('stream closed');
    },
  }));
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  await assert.rejects(api.post('/api/chats/get', {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.kind, 'format');
    return true;
  });
});

test('空 body → 返回 null', async () => {
  const fetchMock = mockFetch(
    () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const api = createApi({ ctx: makeCtx(), fetchImpl: fetchMock });

  assert.equal(await api.post('/api/chats/get', {}), null);
});
