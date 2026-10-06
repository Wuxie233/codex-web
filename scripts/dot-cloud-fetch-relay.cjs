#!/usr/bin/env node
'use strict';
// Independent, fixed-thread, read-only official cloud browser transport.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { parseArgs, requestHeaders, responseHeaders } = require('./dot-browser-fetch-relay.cjs');
const ORIGIN = 'https://codex-cloud-backend.chatgpt.com';
function configuredThread(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Fixed cloud thread required');
  return value;
}
function allowedPath(value, thread) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(thread || '') || /[\\\x00-\x20\x7f#]/.test(value)) return false;
  const pathname = value.split('?')[0];
  const paths = [`/v1/threads/${thread}`, `/v2/threads/${thread}/turns`, `/v2/threads/${thread}/items`, '/v2/models', '/v2/collaboration-modes', '/v2/account/rate-limits', '/v2/realtime/voices'];
  try { const url = new URL(value, ORIGIN); return paths.includes(pathname) && url.origin === ORIGIN && url.pathname === pathname; } catch { return false; }
}
// Serialized into the fixed metadata document; no cross-origin or write support.
function startBrowserFetch(p) {
  const origin = 'https://codex-cloud-backend.chatgpt.com';
  const paths = [`/v1/threads/${p.thread}`, `/v2/threads/${p.thread}/turns`, `/v2/threads/${p.thread}/items`, '/v2/models', '/v2/collaboration-modes', '/v2/account/rate-limits', '/v2/realtime/voices'];
  const url = new URL(p.url);
  if (!/^[A-Za-z0-9_-]+$/.test(p.thread) || location.origin !== origin || location.href !== origin + '/v1/threads/' + p.thread || p.method !== 'GET' || url.origin !== origin || !paths.includes(url.pathname) || url.hash || url.username || url.password || p.url !== origin + url.pathname + url.search) throw new Error('Unsupported cloud browser read');
  const controller = new AbortController();
  let reader = null;
  let leaseTimer;
  let finished = false;
  const cleanup = () => {
    clearInterval(leaseTimer);
    globalThis[p.registry]?.delete(p.id);
  };
  const entry = {
    ack: null,
    expires: Date.now() + p.leaseMs,
    renew() { this.expires = Date.now() + p.leaseMs; },
    abort() {
      if (finished) return;
      finished = true;
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
      this.ack?.();
      cleanup();
      try { globalThis[p.binding](JSON.stringify({ id: p.id, type: 'error', reason: 'aborted' })); } catch {}
    },
  };
  globalThis[p.registry].set(p.id, entry);
  // Independent of CDP and body progress: covers fetch headers, idle SSE reads,
  // and chunks waiting for the Node consumer's backpressure acknowledgment.
  leaseTimer = setInterval(() => {
    if (Date.now() >= entry.expires) entry.abort();
  }, Math.min(1000, p.leaseMs));
  const emit = value => {
    try { globalThis[p.binding](JSON.stringify({ id: p.id, ...value })); }
    catch { entry.abort(); }
  };
  const emitWait = value => new Promise(resolve => {
    if (controller.signal.aborted) return resolve();
    entry.ack = () => { entry.ack = null; resolve(); };
    emit(value);
  });
  (async () => {
    try {
      const response = await fetch(p.url, { method: 'GET', headers: p.headers, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (response.type === 'opaqueredirect') { emit({ type: 'error', reason: 'redirect' }); return; }
      if (response.body) reader = response.body.getReader();
      await emitWait({ type: 'headers', status: response.status, headers: [...response.headers] });
      if (reader) {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read(); if (done) break;
          let binary = ''; for (let i = 0; i < value.length; i += 16384) binary += String.fromCharCode(...value.subarray(i, i + 16384));
          await emitWait({ type: 'chunk', data: btoa(binary) });
        }
      }
      if (!controller.signal.aborted) emit({ type: 'done' });
    } catch { emit({ type: 'error', reason: 'fetch' }); }
    finally { finished = true; cleanup(); }
  })();
  return true;
}
async function main(argv) {
  const options = parseArgs(argv);
  const thread = configuredThread(process.env.CODEX_CLOUD_READ_THREAD_ID);
  const PAGE = ORIGIN + '/v1/threads/' + thread;
  const socketPath = options['cdp-socket'];
  const listenPath = options['listen-socket'];
  if (fs.existsSync(listenPath)) throw new Error('Listen socket already exists');
  const pages = await new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/json/list', timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(new Error('CDP listing too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid CDP page listing')); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP listing timeout'))); req.on('error', reject);
  });
  const page = pages.find(item => item.type === 'page' && item.url === PAGE && item.webSocketDebuggerUrl);
  if (!page) throw new Error('Required browser page is not open');
  const ws = new WebSocket('ws://localhost' + new URL(page.webSocketDebuggerUrl).pathname, { createConnection: () => net.connect(socketPath) });
  const binding = '__dotRelay_' + crypto.randomBytes(16).toString('hex');
  const registry = '__dotRequests_' + crypto.randomBytes(16).toString('hex');
  const commands = new Map(); const requests = new Map(); const contexts = new Map(); const connections = new Set();
  let serial = 0, frameId, contextId, ready = false, stopping = false, listening = false;
  let heartbeat; let heartbeatBusy = false;
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Browser disconnected'));
      const id = ++serial;
      const timeout = setTimeout(() => { commands.delete(id); reject(new Error('Browser command timed out')); }, 10000);
      commands.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  function evaluate(expression) { return command('Runtime.evaluate', { expression, contextId, returnByValue: true }).then(result => { if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result; }); }
  function failResponse(res, status, message) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(message);
  }
  function failAll() { clearInterval(heartbeat); ready = false; for (const { res, isMessage } of requests.values()) failResponse(res, 502, isMessage ? 'Dot message outcome unknown; check history and do not replay' : 'Browser context unavailable'); requests.clear(); }
  function browserAbort(id) { if (ready) evaluate(`globalThis[${JSON.stringify(registry)}]?.get(${JSON.stringify(id)})?.abort()`).catch(() => {}); }
  function acknowledge(id) { if (ready && requests.has(id)) evaluate(`globalThis[${JSON.stringify(registry)}]?.get(${JSON.stringify(id)})?.ack?.()`).catch(() => { const req = requests.get(id); if (req) failResponse(req.res, 502, 'Browser acknowledgment failed'); browserAbort(id); requests.delete(id); }); }
  ws.on('message', data => {
    let event; try { event = JSON.parse(data); } catch { return; }
    if (event.id && commands.has(event.id)) {
      const pending = commands.get(event.id); commands.delete(event.id); clearTimeout(pending.timeout);
      return event.error ? pending.reject(new Error('Browser command rejected')) : pending.resolve(event.result);
    }
    if (event.method === 'Runtime.executionContextCreated') { const context = event.params.context; contexts.set(context.id, context); }
    if (event.method === 'Runtime.executionContextDestroyed' && event.params.executionContextId === contextId) failAll();
    if (event.method === 'Runtime.executionContextsCleared' || event.method === 'Inspector.detached') failAll();
    if (event.method !== 'Runtime.bindingCalled' || event.params.name !== binding || event.params.executionContextId !== contextId) return;
    let message; try { message = JSON.parse(event.params.payload); } catch { return; }
    const request = requests.get(message.id); if (!request) return;
    const { res } = request;
    try {
      if (message.type === 'headers') {
        if (res.headersSent || !Number.isInteger(message.status) || message.status < 200 || message.status > 599 || !Array.isArray(message.headers)) throw new Error('Invalid browser response');
        res.writeHead(message.status, responseHeaders(message.headers)); res.flushHeaders(); acknowledge(message.id);
      } else if (message.type === 'chunk') {
        if (!res.headersSent || typeof message.data !== 'string') throw new Error('Invalid browser chunk');
        const chunk = Buffer.from(message.data, 'base64');
        if (res.write(chunk)) acknowledge(message.id); else res.once('drain', () => acknowledge(message.id));
      } else if (message.type === 'done') { requests.delete(message.id); res.end(); }
      else if (message.type === 'error') { requests.delete(message.id); failResponse(res, 502, request.isMessage ? 'Dot message outcome unknown; check history and do not replay' : message.reason === 'redirect' ? 'Browser relay refuses redirects' : 'Browser fetch failed (redirects are refused)'); }
    } catch { browserAbort(message.id); requests.delete(message.id); failResponse(res, 502, 'Invalid browser response'); }
  });
  ws.on('error', () => {});
  ws.on('close', () => { failAll(); for (const pending of commands.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Browser disconnected')); } commands.clear(); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Browser connection failed'))); });
  frameId = (await command('Page.getFrameTree')).frameTree.frame.id;
  await command('Runtime.enable');
  const context = [...contexts.values()].find(item => item.auxData?.frameId === frameId && item.auxData?.isDefault && item.origin === ORIGIN);
  if (!context) throw new Error('Expected main-frame execution context unavailable');
  contextId = context.id;
  await command('Runtime.addBinding', { name: binding, executionContextId: contextId });
  await evaluate(`globalThis[${JSON.stringify(registry)}] = new Map()`);
  ready = true;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !allowedPath(req.url, thread)) return failResponse(res, 405, 'Only fixed-thread cloud reads are permitted');
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return failResponse(res, 400, 'Cloud reads cannot contain a body');
    if (!ready) return failResponse(res, 503, 'Browser context unavailable');
    if (req.headers['x-codex-relay-redirect'] && req.headers['x-codex-relay-redirect'] !== 'error') return failResponse(res, 400, 'Cloud redirects are forbidden');
    const id = crypto.randomBytes(24).toString('hex');
    const isMessage = false;
    requests.set(id, { res, isMessage });
    const cancel = () => { if (requests.delete(id)) browserAbort(id); };
    req.on('aborted', cancel); res.on('close', cancel);
    const input = JSON.stringify({ id, url: ORIGIN + req.url, method: req.method, thread, headers: requestHeaders(req.headers), binding, registry, leaseMs: 15000 });
    evaluate(`(${startBrowserFetch.toString()})(${input})`).catch(() => { browserAbort(id); requests.delete(id); failResponse(res, 502, isMessage ? 'Dot message outcome unknown; check history and do not replay' : 'Browser request could not start'); });
  });
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPath, () => { listening = true; fs.chmodSync(listenPath, 0o600); resolve(); }); });
  heartbeat = setInterval(() => {
    if (!ready || heartbeatBusy || requests.size === 0) return;
    heartbeatBusy = true;
    evaluate(`(() => { const m = globalThis[${JSON.stringify(registry)}]; if (m) for (const id of ${JSON.stringify([...requests.keys()])}) m.get(id)?.renew(); })()`)
      .catch(() => failAll()).finally(() => { heartbeatBusy = false; });
  }, 4000);
  async function stop() {
    if (stopping) return; stopping = true;
    // Abort fetches before closing CDP; no authentication or browser navigation changes.
    if (ready) await evaluate(`(() => { const m = globalThis[${JSON.stringify(registry)}]; if(m) { for(const r of m.values()) r.abort(); m.clear(); } delete globalThis[${JSON.stringify(registry)}]; })()`).catch(() => {});
    await command('Runtime.removeBinding', { name: binding }).catch(() => {});
    failAll(); for (const socket of connections) socket.destroy(); server.close();
    if (listening) { try { fs.unlinkSync(listenPath); } catch {} }
    ws.terminate();
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
module.exports = { configuredThread, allowedPath, startBrowserFetch };
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Cloud read relay startup failed'); process.exit(1); });
