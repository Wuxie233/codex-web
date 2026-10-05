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
