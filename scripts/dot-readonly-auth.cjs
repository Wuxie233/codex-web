#!/usr/bin/env node
'use strict';
// Supplies an externally managed token to an isolated CLI without copying its auth file.
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--auth-file' || args[2] !== '--listen-socket') {
  console.error('Expected --auth-file PATH --listen-socket PATH'); process.exit(1);
}
const source = args[1], socket = args[3];
if (fs.existsSync(socket)) { console.error('Listen socket already exists'); process.exit(1); }
let value, expiry;
try {
  const tokens = JSON.parse(fs.readFileSync(source, 'utf8')).tokens;
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
  if (typeof tokens.account_id !== 'string' || !tokens.account_id || !Number.isFinite(claims.exp)) throw new Error();
  expiry = claims.exp * 1000;
  if (expiry <= Date.now()) throw new Error();
  value = JSON.stringify({ accessToken: tokens.access_token, chatgptAccountId: tokens.account_id });
} catch { console.error('A valid existing external token is required; no login or refresh attempted'); process.exit(1); }
const sockets = new Set();
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || req.url !== '/external-auth') { res.writeHead(404); return res.end(); }
  if (Date.now() >= expiry) { res.writeHead(503); return res.end('External token expired'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(value);
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
server.on('clientError', (_, s) => s.destroy());
server.listen(socket, () => fs.chmodSync(socket, 0o600));
function stop() { value = null; for (const s of sockets) s.destroy(); server.close(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
