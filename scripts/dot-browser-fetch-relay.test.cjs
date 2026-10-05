'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedPath, requestHeaders, responseHeaders, parseArgs } = require('./dot-browser-fetch-relay.cjs');
test('allows same-origin API paths and query values without reinterpreting query as path', () => {
  assert.equal(allowedPath('/backend-api/tbo/primary'), true);
  assert.equal(allowedPath('/backend-api/events?cursor=a%2Fb&url=https%3A%2F%2Fexample.com'), true);
});
test('rejects path normalization, ambiguous encodings, foreign origins and non-API paths', () => {
  for (const value of ['https://evil.test/backend-api/x', '//evil.test/backend-api/x', '/backend-api/../x', '/backend-api/%2e%2e/x', '/backend-api/a%2fb', '/backend-api/a%5cb', '/backend-api/%252e%252e/x', '/backend-api/x#fragment', '/backend-api/x\\y', '/backend-api/%00x', '/backend-api/%zz', '/backend-api']) {
    assert.equal(allowedPath(value), false, value);
  }
});
test('forwards per-request credentials and official metadata without browser or relay headers', () => {
  assert.deepEqual(requestHeaders({ authorization: 'Bearer in-memory-only', 'chatgpt-account-id': 'test-account', 'x-codex-version': 'test', accept: 'text/event-stream', 'x-codex-relay-redirect': 'manual', cookie: 'secret', host: 'evil.test', connection: 'close', 'content-length': '4', 'sec-fetch-site': 'same-origin', 'user-agent': 'override', 'x-arbitrary': 'omit' }), {
    authorization: 'Bearer in-memory-only', 'chatgpt-account-id': 'test-account', 'x-codex-version': 'test', accept: 'text/event-stream',
  });
});
test('response framing describes decoded bytes and never returns cookies', () => {
  assert.deepEqual(responseHeaders([['content-type', 'application/octet-stream'], ['content-encoding', 'gzip'], ['Content-Length', '99'], ['transfer-encoding', 'chunked'], ['set-cookie', 'secret'], ['connection', 'keep-alive'], ['cache-control', 'public'], ['x-request-id', 'safe']]), {
    'content-type': 'application/octet-stream', 'x-request-id': 'safe', 'cache-control': 'no-store',
  });
});
test('requires both explicit socket paths', () => {
  assert.deepEqual(parseArgs(['--cdp-socket', '/private/cdp.sock', '--listen-socket', '/private/relay.sock']), { 'cdp-socket': '/private/cdp.sock', 'listen-socket': '/private/relay.sock' });
  assert.throws(() => parseArgs(['--cdp-socket', '/private/cdp.sock']));
  assert.throws(() => parseArgs(['--unexpected', 'value']));
});

const vm = require('node:vm');
const { startBrowserFetch } = require('./dot-browser-fetch-relay.cjs');
async function detachedOwnerCase(stage) {
  let signal, cancelled = false, fetchSettled = false, waitingRead = false, settleRead;
  const events = [];
  const registry = new Map();
  const context = {
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/backend-api/tbo/primary' },
    AbortController, setInterval, clearInterval, Date, Map,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    registry,
    binding(payload) {
      const event = JSON.parse(payload); events.push(event);
      if (stage === 'read' && event.type === 'headers') registry.get('request').ack();
    },
    fetch(_url, options) {
      signal = options.signal;
      if (stage === 'headers') return new Promise((_, reject) => signal.addEventListener('abort', () => { fetchSettled = true; reject(new Error('aborted')); }, { once: true }));
      return Promise.resolve({ type: 'basic', status: 200, headers: [], body: {
        getReader() { return {
          read() { waitingRead = true; return new Promise(resolve => { settleRead = resolve; }); },
          cancel() { cancelled = true; waitingRead = false; settleRead?.({ done: true }); return Promise.resolve(); },
        }; },
      } });
    },
  };
  vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify({ id: 'request', url: 'https://chatgpt.com/backend-api/events', headers: {}, redirect: 'error', binding: 'binding', registry: 'registry', leaseMs: 30 })})`, context);
  // No owner renewals or ACKs: simulates CDP disappearing while the page survives.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(signal.aborted, true, stage);
  assert.equal(registry.size, 0, stage);
  assert.equal(waitingRead, false, stage);
  if (stage === 'headers') assert.equal(fetchSettled, true);
  else assert.equal(cancelled, true);
  assert.ok(events.some(event => event.type === 'error'));
}
test('browser owner lease aborts a fetch still waiting for headers after CDP loss', () => detachedOwnerCase('headers'));
test('browser owner lease cancels idle SSE reader after CDP loss', () => detachedOwnerCase('read'));
test('browser owner lease resolves unacknowledged response and cancels reader after CDP loss', () => detachedOwnerCase('ack'));

const { allowedMethod, jsonContentType, readBootstrapBody } = require('./dot-browser-fetch-relay.cjs');
const { Readable } = require('node:stream');
test('POST exception is exactly the Statsig bootstrap endpoint, GET policy remains unchanged', () => {
  assert.equal(allowedMethod('POST', '/backend-api/wham/statsig/bootstrap'), true);
  for (const path of ['/backend-api/wham/statsig/bootstrap/', '/backend-api/wham/statsig/bootstrap?x=1', '/backend-api/wham/statsig/%62ootstrap', '/backend-api/wham/statsig/other', '/backend-api/tbo/primary']) assert.equal(allowedMethod('POST', path), false, path);
  assert.equal(allowedMethod('PUT', '/backend-api/wham/statsig/bootstrap'), false);
  assert.equal(allowedMethod('GET', '/backend-api/tbo/primary'), true);
  assert.equal(allowedMethod('GET', '/backend-api/events?cursor=1'), true);
});
test('bootstrap requires JSON content type and accepts charset parameters', () => {
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; charset="UTF-8"']) assert.equal(jsonContentType(type), true, type);
  for (const type of [undefined, 'text/plain', 'application/jsonp', 'application/json; boundary=x']) assert.equal(jsonContentType(type), false);
});
test('bootstrap body preserves exact bytes and caps both announced and chunked bodies', async () => {
  const bytes = Buffer.from(' { "locale": "中文", "n": 1 }\n');
  const input = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]); input.headers = { 'content-type': 'application/json' };
  assert.deepEqual(Buffer.from(await readBootstrapBody(input), 'base64'), bytes);
  const announced = Readable.from([]); announced.headers = { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) };
  await assert.rejects(readBootstrapBody(announced), { status: 413 });
  const chunked = Readable.from([Buffer.alloc(1024 * 1024), Buffer.from('x')]); chunked.headers = { 'content-type': 'application/json' };
  await assert.rejects(readBootstrapBody(chunked), { status: 413 });
  const wrongType = Readable.from([]); wrongType.headers = { 'content-type': 'text/plain' };
  await assert.rejects(readBootstrapBody(wrongType), { status: 415 });
});
test('browser fetch transmits POST original bytes and rejects other POST targets', async () => {
  const bytes = Buffer.from(' {"locale":"中文"}\n');
  const registry = new Map(); let captured;
  const context = {
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/backend-api/tbo/primary' },
    AbortController, setInterval, clearInterval, Date, Map, Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'), registry,
    binding(payload) { const event = JSON.parse(payload); if (event.type === 'headers') registry.get('post').ack(); },
    fetch(url, options) { captured = { url, options }; return Promise.resolve({ type: 'basic', status: 200, headers: [], body: null }); },
  };
  const input = { id: 'post', url: 'https://chatgpt.com/backend-api/wham/statsig/bootstrap', method: 'POST', bodyBase64: bytes.toString('base64'), headers: { 'content-type': 'application/json' }, redirect: 'error', binding: 'binding', registry: 'registry', leaseMs: 100 };
  vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify(input)})`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(Buffer.from(captured.options.body), bytes);
  assert.equal(registry.size, 0);
  input.url += '?alias=1';
  assert.throws(() => vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify(input)})`, context), /Unsupported browser method/);
});

const { configuredRoom, validateMessageBody, consumeRequestId } = require('./dot-browser-fetch-relay.cjs');
const plainMessage = () => ({ content: { text: 'hello', attachments: [] }, request_id: 'one-id', idempotency_token: 'one-id', page_context: null, reply_to: null });
const encodedMessage = body => Buffer.from(JSON.stringify(body)).toString('base64');
test('Dot writes are opt-in and fixed to exact single-segment room paths', () => {
  assert.equal(configuredRoom(undefined), null); assert.equal(configuredRoom(''), null);
  for (const room of ['../room', 'room/a', 'room?x', 'room%2fa', 'room a']) assert.throws(() => configuredRoom(room));
  const room = configuredRoom('room_1-A');
  for (const suffix of ['messages', 'live']) {
    const path = `/backend-api/messaging/rooms/${room}/${suffix}`;
    assert.equal(allowedMethod('POST', path), false);
    assert.equal(allowedMethod('POST', path, room), true);
    for (const altered of [path + '/', path + '?x=1', path.replace(room, 'other'), path.replace(room, 'room%5f1-A')]) assert.equal(allowedMethod('POST', altered, room), false);
  }
  for (const path of ['/backend-api/messaging/rooms', '/backend-api/tbo/runtime/resume', '/backend-api/messaging/rooms/room_1-A/authorize']) assert.equal(allowedMethod('POST', path, room), false);
});
test('Dot message validation rejects attachments, context, references, unknown fields and invalid UTF-8', () => {
  assert.equal(validateMessageBody(encodedMessage(plainMessage())), 'one-id');
  for (const mutate of [b => { b.content.text = ' '; }, b => { b.content.attachments = [{}]; }, b => { b.content.extra = true; }, b => { b.reply_to = 'id'; }, b => { b.page_context = {}; }, b => { b.unknown = 1; }, b => { b.idempotency_token = 'different'; }, b => { b.app_attest_challenge = ''; }]) {
    const body = plainMessage(); mutate(body); assert.throws(() => validateMessageBody(encodedMessage(body)));
  }
  const badUtf8 = Buffer.concat([Buffer.from('{"content":{"text":"'), Buffer.from([0xff]), Buffer.from('"},"request_id":"i","idempotency_token":"i"}')]);
  assert.throws(() => validateMessageBody(badUtf8.toString('base64')));
});
test('live subscription accepts absent content type with zero bytes', async () => {
  const req = Readable.from([]); req.headers = {};
  assert.equal(await readBootstrapBody(req, false), '');
});
test('concurrent duplicate message IDs cause exactly one browser fetch, including failed-send replay', async () => {
  const consumed = new Set(), registry = new Map(); let fetches = 0;
  const context = {
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/backend-api/tbo/primary' },
    AbortController, setInterval, clearInterval, Date, Map, Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'), registry,
    binding() {}, fetch() { fetches++; return Promise.reject(new Error('uncertain disconnect')); },
  };
  const input = { id: 'request', url: 'https://chatgpt.com/backend-api/messaging/rooms/room-1/messages', dotRoomId: 'room-1', method: 'POST', bodyBase64: encodedMessage(plainMessage()), headers: { 'content-type': 'application/json' }, redirect: 'error', binding: 'binding', registry: 'registry', leaseMs: 100 };
  const dispatch = async () => {
    const id = validateMessageBody(input.bodyBase64);
    consumeRequestId(consumed, id);
    vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify(input)})`, context);
  };
  const results = await Promise.allSettled([dispatch(), dispatch()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1); assert.equal(registry.size, 0);
  await assert.rejects(dispatch(), { status: 409 }); assert.equal(fetches, 1);
});

test('native page context accepts only a single null or nonempty page_id and preserves the input bytes', async () => {
  const body = plainMessage(); body.page_context = { page_id: 'native-page-id' };
  const bytes = Buffer.from('  ' + JSON.stringify(body) + '\n');
  const stream = Readable.from([bytes]); stream.headers = { 'content-type': 'application/json' };
  const encoded = await readBootstrapBody(stream);
  assert.equal(validateMessageBody(encoded), body.request_id);
  assert.deepEqual(Buffer.from(encoded, 'base64'), bytes);
  body.page_context = { page_id: null };
  assert.equal(validateMessageBody(encodedMessage(body)), body.request_id);
  for (const context of [{}, { page_id: '' }, { page_id: ' ' }, { page_id: 1 }, { page_id: 'id', extra: true }, { other: 'id' }, ['id'], 'private-value']) {
    body.page_context = context;
    assert.throws(() => validateMessageBody(encodedMessage(body)), error => error.status === 400 && error.message === 'Unsupported Dot page_context shape');
  }
});
