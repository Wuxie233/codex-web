'use strict';
// Private transport browser controller. No HTTP UI or public CDP listener.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const { WebSocket } = require('ws');
const state = process.env.DOT_BROWSER_STATE;
if (!state || !process.env.DOT_SOURCE_AUTH) throw new Error('Private browser configuration required');
const targetUrl = 'https://chatgpt.com/backend-api/tbo/primary';
const sockets = new Set(); let stopping = false;
const status = { browserConnected: false, tokenAttached: false, responseStatus: null, cfMitigated: null };
function writeStatus() { fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify(status), {mode: 0o600}); }
function track(s) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); return s; }
writeStatus();
function allowed(host) {
  return ['chatgpt.com', 'ab.chatgpt.com', 'challenges.cloudflare.com', 'auth.openai.com', 'auth0.openai.com', 'chat.openai.com'].includes(host) || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:oaistatic|oaiusercontent)\.com$/.test(host);
}
const egressPath = path.join(state, 'egress.sock');
if (fs.existsSync(egressPath)) throw new Error('egress socket already exists');
const egress = net.createServer(client => {
  track(client); client.setTimeout(20000, () => client.destroy());
  let buffer = Buffer.alloc(0);
  function incoming(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if ((end < 0 && buffer.length > 8192) || (end >= 0 && end + 4 > 8192)) return client.destroy();
    if (end < 0) return;
    client.removeListener('data', incoming); client.setTimeout(0);
    const line = buffer.subarray(0, end).toString('ascii').split('\r\n')[0];
    const match = /^CONNECT ([a-zA-Z0-9.-]+):443 HTTP\/1\.[01]$/.exec(line);
    if (!match || !allowed(match[1].toLowerCase()) || net.isIP(match[1])) return client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    const host = match[1].toLowerCase();
    const upstream = track(net.connect(7897, '127.0.0.1'));
    upstream.setTimeout(20000, () => upstream.destroy());
    upstream.once('data', () => upstream.setTimeout(0));
    upstream.on('connect', () => { upstream.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`); if (buffer.length > end + 4) upstream.write(buffer.subarray(end + 4)); client.pipe(upstream); });
    upstream.pipe(client); upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  }
  client.on('data', incoming);
});
egress.listen(egressPath, () => fs.chmodSync(egressPath, 0o600));
function cdpPages() {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: path.join(state, 'cdp.sock'), path: '/json/list', timeout: 2000 }, res => { let body = ''; res.on('data', c => { body += c; if (body.length > 1048576) req.destroy(); }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } }); });
    req.on('timeout', () => req.destroy()); req.on('error', reject);
  });
}
let cdp;
let cdpBusy = false;
async function connectBrowser() {
  if (stopping || cdpBusy || cdp) return;
  cdpBusy = true;
  try {
    const pages = await cdpPages();
    const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
    if (!page) return;
    const wsPath = new URL(page.webSocketDebuggerUrl).pathname;
    cdp = new WebSocket('ws://localhost' + wsPath, { createConnection: () => track(net.connect(path.join(state, 'cdp.sock'))) });
    const active = cdp;
    let seq = 0; const pending = new Map();
    function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 10000); pending.set(id, { resolve, reject, timer }); active.send(JSON.stringify({ id, method, params })); }); }
    let auth = null; let mainFrame = null;
    active.on('message', async data => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); return msg.error ? p.reject(new Error('CDP command failed')) : p.resolve(msg.result); }
      try {
        if (msg.method === 'Fetch.requestPaused') {
          const p = msg.params;
          const params = { requestId: p.requestId };
          if (auth && p.request.url === targetUrl && p.request.method === 'GET' && p.resourceType === 'Document' && p.frameId === mainFrame) {
            params.headers = Object.entries(p.request.headers).filter(([k]) => !['authorization','chatgpt-account-id'].includes(k.toLowerCase())).map(([name, value]) => ({ name, value: String(value) }));
            params.headers.push({ name: 'Authorization', value: 'Bearer ' + auth.access_token }, { name: 'ChatGPT-Account-Id', value: auth.account_id });
            status.tokenAttached = true; writeStatus();
          }
          await send('Fetch.continueRequest', params);
        }
        if (msg.method === 'Network.responseReceived' && msg.params.response.url === targetUrl && msg.params.type === 'Document') {
          const r = msg.params.response; status.responseStatus = r.status;
          const cf = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'cf-mitigated');
          status.cfMitigated = cf ? (String(cf[1]).toLowerCase() === 'challenge' ? 'challenge' : 'present') : null; writeStatus();
        }
      } catch { active.close(); }
    });
    active.on('open', async () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(process.env.DOT_SOURCE_AUTH, 'utf8'));
        const tokens = parsed.tokens;
        if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.account_id !== 'string') throw new Error('no auth');
        const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
        if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) throw new Error('expired auth');
        auth = { access_token: tokens.access_token, account_id: tokens.account_id };
        await send('Page.enable'); await send('Network.enable');
        mainFrame = (await send('Page.getFrameTree')).frameTree.frame.id;
        await send('Fetch.enable', { patterns: [{ urlPattern: targetUrl, resourceType: 'Document', requestStage: 'Request' }] });
        status.browserConnected = true; writeStatus();
        await send('Page.navigate', { url: targetUrl });
      } catch { auth = null; active.close(); }
    });
    active.on('error', () => {});
    active.on('close', () => { auth = null; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP disconnected')); } pending.clear(); if (cdp === active) cdp = null; status.browserConnected = false; writeStatus(); });
  } catch {} finally { cdpBusy = false; }
}
const poll = setInterval(connectBrowser, 2000); connectBrowser();
function shutdown() { if(stopping)return; stopping=true; clearInterval(poll); cdp?.terminate(); for(const s of sockets)s.destroy(); egress.close(); try{fs.unlinkSync(egressPath)}catch{} setTimeout(()=>process.exit(0),200).unref(); }
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
