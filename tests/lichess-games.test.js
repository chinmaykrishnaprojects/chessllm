import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { MAX_BYTES, DEADLINE_MS } from '../api/lichess-games.js';

const validUrl = '/api/lichess-games?username=sampleplayer&speed=bullet';
function response() {
  return { statusCode: 0, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; } };
}
function mockFetch(t, fn) { return t.mock.method(globalThis, 'fetch', fn); }

test('success preserves exact NDJSON bytes, fixed URL and bounded cache', async t => {
  const bytes = Buffer.from('{"id":"sample01","note":"♟"}\r\n{"id":"sample02"}\n');
  let request;
  mockFetch(t, async (url, init) => { request = { url, init }; return new Response(bytes, { headers: { 'content-type': 'application/x-ndjson' } }); });
  const res = response();
  await handler({ method: 'GET', url: validUrl, headers: { cookie: 'private', authorization: 'secret' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, bytes);
  assert.match(res.headers['content-type'], /^application\/x-ndjson/);
  assert.equal(res.headers['cache-control'], 'public, max-age=60, s-maxage=300');
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://lichess.org');
  assert.equal(url.pathname, '/api/games/user/sampleplayer');
  assert.deepEqual(Object.fromEntries(url.searchParams), { perfType: 'bullet', max: '20', ongoing: 'false', finished: 'true', evals: 'true', clocks: 'true', opening: 'true', pgnInJson: 'true', moves: 'true', sort: 'dateDesc' });
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(request.init.headers.Cookie, undefined);
});

test('only GET is allowed; other methods never call upstream', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('must not run'); });
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const res = response(); await handler({ method, url: validUrl }, res);
    assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, 'GET');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('rejects username injection, invalid bounds, speeds and arbitrary URLs', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('must not run'); });
  for (const query of [
    'username=a&speed=bullet', `username=${'a'.repeat(31)}&speed=bullet`,
    'username=foo%2Fbar&speed=bullet', 'username=https%3A%2F%2Fevil.example&speed=bullet',
    'username=foo%0Abar&speed=bullet', 'username=foo&speed=correspondence',
    'username=foo&speed=bullet&max=0', 'username=foo&speed=bullet&max=21',
    'username=foo&speed=bullet&max=1.5', 'username=foo&speed=bullet&max=01',
    'username=foo&speed=bullet&max=', 'username=foo&speed=bullet&max=2&max=3',
    'username=foo&speed=bullet&url=https://evil.example', 'username=foo', 'speed=bullet',
  ]) {
    const res = response(); await handler({ method: 'GET', url: `/api/lichess-games?${query}` }, res);
    assert.equal(res.statusCode, 400, query); assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('supports all permitted speeds and boundary max/username values', async t => {
  const urls = [];
  mockFetch(t, async url => { urls.push(new URL(url)); return new Response(''); });
  for (const speed of ['bullet', 'blitz', 'rapid', 'classical']) {
    const res = response(); await handler({ method: 'GET', url: `/api/lichess-games?username=AB_-&speed=${speed}&max=1` }, res);
    assert.equal(res.statusCode, 200);
  }
  const res = response(); await handler({ method: 'GET', url: `/api/lichess-games?username=${'a'.repeat(30)}&speed=bullet&max=20` }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(urls[0].pathname, '/api/games/user/ab_-');
  assert.equal(urls[0].searchParams.get('max'), '1');
  assert.equal(urls.at(-1).searchParams.get('max'), '20');
});

test('preserves 429 with Retry-After 60 and no retries', async t => {
  const fetch = mockFetch(t, async () => new Response('upstream rate limit', { status: 429, headers: { 'retry-after': '3' } }));
  const res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 429); assert.equal(res.headers['retry-after'], '60');
  assert.equal(res.headers['cache-control'], 'no-store'); assert.equal(fetch.mock.callCount(), 1);
});

test('fetch rejection and upstream errors return bounded errors without retries', async t => {
  const fetch = mockFetch(t, async () => { throw new Error('network failed with private implementation details'); });
  let res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 502); assert.doesNotMatch(res.body, /private implementation/);
  fetch.mock.mockImplementation(async () => new Response('arbitrary upstream content', { status: 404 }));
  res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 502); assert.match(res.body, /404/); assert.doesNotMatch(res.body, /arbitrary upstream/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('enforces cap on declared and actual bytes, not character count', async t => {
  const fetch = mockFetch(t, async () => new Response('', { headers: { 'content-length': String(MAX_BYTES + 1) } }));
  let res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 502); assert.match(res.body, /response_too_large/);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array(MAX_BYTES)); c.enqueue(new Uint8Array(1)); c.close();
  } })));
  res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 502); assert.match(res.body, /response_too_large/);
});

test('accepts exactly the 4 MB byte boundary', async t => {
  const bytes = new Uint8Array(MAX_BYTES);
  mockFetch(t, async () => new Response(bytes));
  const res = response(); await handler({ method: 'GET', url: validUrl }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.byteLength, MAX_BYTES);
});

test('hard 20-second deadline applies even when mocked fetch ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const fetch = mockFetch(t, async (_, init) => { signal = init.signal; return new Promise(() => {}); });
  const res = response(), pending = handler({ method: 'GET', url: validUrl }, res);
  t.mock.timers.tick(DEADLINE_MS);
  await pending;
  assert.equal(res.statusCode, 504); assert.equal(signal.aborted, true); assert.equal(fetch.mock.callCount(), 1);
});

test('deadline also covers a stalled response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockFetch(t, async () => new Response(new ReadableStream({ start() {} })));
  const res = response(), pending = handler({ method: 'GET', url: validUrl }, res);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(DEADLINE_MS); await pending;
  assert.equal(res.statusCode, 504); assert.equal(res.headers['cache-control'], 'no-store');
});
