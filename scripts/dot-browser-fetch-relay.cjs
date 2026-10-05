#!/usr/bin/env node
'use strict';
// Isolated, read-only HTTP transport through an already authenticated browser page.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const PAGE = 'https://chatgpt.com/backend-api/tbo/primary';
const ORIGIN = 'https://chatgpt.com';
const BOOTSTRAP = '/backend-api/wham/statsig/bootstrap';
const MAX_BODY = 1024 * 1024;
function allowedMethod(method, pathname) { return method === 'GET' || (method === 'POST' && pathname === BOOTSTRAP); }
function jsonContentType(value) { return typeof value === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*(?:[a-z0-9._-]+|"[a-z0-9._-]+"))?\s*$/i.test(value); }
async function readBootstrapBody(req) {
  if (!jsonContentType(req.headers['content-type'])) throw Object.assign(new Error('JSON content type required'), { status: 415 });
  if (Number(req.headers['content-length']) > MAX_BODY) throw Object.assign(new Error('Request body exceeds 1 MiB'), { status: 413 });
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); req.removeListener('aborted', aborted); };
    const error = err => { cleanup(); reject(err); };
    const aborted = () => error(new Error('Request body aborted'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('base64')); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { cleanup(); req.resume(); reject(Object.assign(new Error('Request body exceeds 1 MiB'), { status: 413 })); return; }
      chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--cdp-socket', '--listen-socket'].includes(argv[i]) || !argv[i + 1]) throw new Error('Expected --cdp-socket PATH --listen-socket PATH');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options['cdp-socket'] || !options['listen-socket']) throw new Error('Both socket paths are required');
  return options;
}
function allowedPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/backend-api/') || /[\\\x00-\x20\x7f#]/.test(value)) return false;
  try {
    const rawPath = value.split('?')[0];
    // Reject encoded separators, nested escapes and dot segments before URL normalization.
    if (/%(?:2f|5c|25)/i.test(rawPath)) return false;
    const decoded = decodeURIComponent(rawPath);
    if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x20\x7f]/.test(decoded)) return false;
    const url = new URL(value, ORIGIN);
    return url.origin === ORIGIN && url.pathname === rawPath;
  } catch { return false; }
}
function requestHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => {
    const lower = name.toLowerCase();
    return typeof value === 'string' && lower !== 'x-codex-relay-redirect' && (/^(authorization|chatgpt-account-id|chatgpt-workspace-id|accept|accept-language|content-type|originator|version)$/.test(lower) || /^(x-codex-|x-openai-|oai-|openai-|codex-)/.test(lower));
  }));
}
function responseHeaders(headers) {
  return Object.fromEntries(headers.filter(([name]) => !/^(content-encoding|content-length|transfer-encoding|set-cookie|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|upgrade|cache-control)$/i.test(name)).concat([['cache-control', 'no-store']]));
}
// This function is serialized into the page; keep it self-contained.
function startBrowserFetch(p) {
  if (location.origin !== 'https://chatgpt.com' || location.href !== 'https://chatgpt.com/backend-api/tbo/primary') throw new Error('Unexpected page');
  const method = p.method || 'GET';
  if (method !== 'GET' && !(method === 'POST' && p.url === 'https://chatgpt.com/backend-api/wham/statsig/bootstrap')) throw new Error('Unsupported browser method');
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
      const body = method === 'POST' ? Uint8Array.from(atob(p.bodyBase64), c => c.charCodeAt(0)) : undefined;
      const response = await fetch(p.url, { method, body, headers: p.headers, credentials: 'include', redirect: p.redirect, cache: 'no-store', signal: controller.signal });
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
  function failAll() { clearInterval(heartbeat); ready = false; for (const { res } of requests.values()) failResponse(res, 502, 'Browser context unavailable'); requests.clear(); }
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
      else if (message.type === 'error') { requests.delete(message.id); failResponse(res, 502, message.reason === 'redirect' ? 'Browser relay refuses redirects' : 'Browser fetch failed (redirects are refused)'); }
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
    if (!allowedMethod(req.method, req.url)) return failResponse(res, 405, 'Only GET and exact Statsig bootstrap POST are supported');
    if (!allowedPath(req.url)) return failResponse(res, 400, 'Unsupported API path');
    if (!ready) return failResponse(res, 503, 'Browser context unavailable');
    const redirect = req.headers['x-codex-relay-redirect'];
    if (redirect && !['follow', 'error', 'manual'].includes(redirect)) return failResponse(res, 400, 'Invalid redirect mode');
    let bodyBase64;
    if (req.method === 'POST') {
      try { bodyBase64 = await readBootstrapBody(req); }
      catch (error) { return failResponse(res, error.status || 400, error.status ? error.message : 'Request body unavailable'); }
      if (req.aborted || res.destroyed) return;
      if (!ready) return failResponse(res, 503, 'Browser context unavailable');
    }
    const id = crypto.randomBytes(24).toString('hex');
    requests.set(id, { res });
    const cancel = () => { if (requests.delete(id)) browserAbort(id); };
    req.on('aborted', cancel); res.on('close', cancel);
    const input = JSON.stringify({ id, url: ORIGIN + req.url, method: req.method, bodyBase64, headers: requestHeaders(req.headers), redirect: redirect === 'manual' ? 'manual' : 'error', binding, registry, leaseMs: 15000 });
    evaluate(`(${startBrowserFetch.toString()})(${input})`).catch(() => { browserAbort(id); requests.delete(id); failResponse(res, 502, 'Browser request could not start'); });
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
module.exports = { allowedPath, requestHeaders, responseHeaders, parseArgs, startBrowserFetch, allowedMethod, jsonContentType, readBootstrapBody };
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Browser relay startup failed'); process.exit(1); });
