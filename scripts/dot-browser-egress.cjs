#!/usr/bin/env node
'use strict';
// CONNECT-only validation egress. TLS payloads remain opaque and unmodified.
const fs = require('node:fs');
const net = require('node:net');
const HOSTS = new Set(['ws.chatgpt.com', 'persistent.oaistatic.com', 'cdn.auth0.com', 'sdmntprwestus.oaiusercontent.com']);
function parseConnect(header, allowedHosts = HOSTS) {
  const lines = header.toString('latin1').split('\r\n');
  const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines.shift());
  if (!match || !allowedHosts.has(match[1])) throw new Error('Denied CONNECT authority');
  let hostSeen = false;
  for (const line of lines) {
    if (!line) continue;
    const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!field) throw new Error('Invalid CONNECT header');
    const name = field[1].toLowerCase();
    if (['authorization', 'proxy-authorization', 'transfer-encoding', 'content-length'].includes(name)) throw new Error('Unsupported CONNECT header');
    if (name === 'host') {
      if (hostSeen || field[2] !== match[1] + ':443') throw new Error('Invalid CONNECT host');
      hostSeen = true;
    }
  }
  return match[1];
}
function readHeader(socket, callback, failure) {
  let buffered = Buffer.alloc(0);
  const timeout = setTimeout(() => finish(new Error('Header timeout')), 20000);
  const cleanup = () => { clearTimeout(timeout); socket.removeListener('data', data); socket.removeListener('error', error); socket.removeListener('close', close); };
  function finish(err, header, remainder) { cleanup(); if (err) failure(err); else callback(header, remainder); }
  const error = err => finish(err);
  const close = () => finish(new Error('Socket closed'));
  function data(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    const boundary = buffered.indexOf('\r\n\r\n');
    if ((boundary < 0 && buffered.length > 8192) || boundary + 4 > 8192) return finish(new Error('Header too large'));
    if (boundary < 0) return;
    socket.pause();
    finish(null, buffered.subarray(0, boundary), buffered.subarray(boundary + 4));
  }
  socket.on('data', data); socket.once('error', error); socket.once('close', close);
}
function createEgress(connectUpstream = () => net.connect(7897, '127.0.0.1'), allowedHosts = HOSTS) {
  const active = new Set();
  const server = net.createServer(client => {
    active.add(client); let upstream; let established = false; let rejected = false;
    const closeBoth = () => { client.destroy(); upstream?.destroy(); };
    client.on('error', closeBoth);
    client.on('close', () => { active.delete(client); upstream?.destroy(); });
    const reject = status => { if (established) return closeBoth(); if (rejected) return; rejected = true; if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, () => client.destroy()); upstream?.destroy(); };
    readHeader(client, (header, remainder) => {
      let host;
      try { host = parseConnect(header, allowedHosts); } catch { return reject('403 Forbidden'); }
      try { upstream = connectUpstream(); } catch { return reject('502 Bad Gateway'); }
      active.add(upstream);
      upstream.on('error', () => reject('502 Bad Gateway'));
      upstream.on('close', () => { active.delete(upstream); if (!rejected) client.destroy(); });
      readHeader(upstream, (response, upstreamRemainder) => {
        const statusLine = response.toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 200(?: |$)/.test(statusLine)) return reject('502 Bad Gateway');
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (upstreamRemainder.length) client.write(upstreamRemainder);
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream); upstream.pipe(client); client.resume(); upstream.resume();
      }, () => reject('502 Bad Gateway'));
      upstream.once('connect', () => upstream.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    }, () => reject('400 Bad Request'));
  });
  return { server, active, close() { for (const socket of active) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--listen-socket' || !argv[1]) throw new Error('Expected --listen-socket PATH');
  const socket = argv[1];
  if (fs.existsSync(socket)) throw new Error('Listen socket already exists');
  const directory = require('node:path').dirname(socket);
  if ((fs.statSync(directory).mode & 0o777) !== 0o700) throw new Error('Socket directory must have mode 0700');
  const egress = createEgress();
  await new Promise((resolve, reject) => { egress.server.once('error', reject); egress.server.listen(socket, () => { fs.chmodSync(socket, 0o600); resolve(); }); });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await egress.close(); try { fs.unlinkSync(socket); } catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
module.exports = { parseConnect, createEgress };
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Browser egress startup failed'); process.exit(1); });
