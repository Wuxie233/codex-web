'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { parseConnect, createEgress } = require('./dot-browser-egress.cjs');
const hosts = ['ws.chatgpt.com', 'persistent.oaistatic.com', 'cdn.auth0.com', 'sdmntprwestus.oaiusercontent.com'];
test('only the four exact authorities on 443 are admitted', () => {
  for (const host of hosts) assert.equal(parseConnect(Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443`)), host);
  for (const target of ['chatgpt.com:443', 'ws.chatgpt.com:80', 'WS.chatgpt.com:443', 'ws.chatgpt.com.:443', 'ws.chatgpt.com:443/path', 'user@ws.chatgpt.com:443', '127.0.0.1:443', 'ws%2echatgpt.com:443', 'evil.test:443']) assert.throws(() => parseConnect(Buffer.from(`CONNECT ${target} HTTP/1.1`)));
  for (const header of ['GET https://ws.chatgpt.com/ HTTP/1.1', 'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\nAuthorization: secret', 'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\nProxy-Authorization: secret', 'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443', 'CONNECT ws.chatgpt.com:443 HTTP/1.1\r\nContent-Length: 1']) assert.throws(() => parseConnect(Buffer.from(header)));
});
async function setup(t, reply, allowedHosts) {
  const upstreamSockets = new Set(); let upstreamRequests = 0;
  const upstream = net.createServer(socket => {
    upstreamSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => upstreamSockets.delete(socket));
    socket.once('data', data => { upstreamRequests++; assert.match(data.toString(), /^CONNECT (?:codex-cloud-backend.chatgpt.com|ws.chatgpt.com|persistent.oaistatic.com|cdn.auth0.com|sdmntprwestus.oaiusercontent.com):443 HTTP\/1.1/); reply(socket); });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = createEgress(() => net.connect(upstream.address().port, '127.0.0.1'), allowedHosts);
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(async () => { await relay.close(); for (const s of upstreamSockets) s.destroy(); await new Promise(resolve => upstream.close(resolve)); });
  return { relay, upstreamSockets, upstreamRequests: () => upstreamRequests, connect: () => net.connect(relay.server.address().port, '127.0.0.1') };
}
async function header(socket) {
  let received = Buffer.alloc(0);
  while (!received.includes('\r\n\r\n')) { const [data] = await once(socket, 'data'); received = Buffer.concat([received, data]); }
  return received;
}
test('allowed CONNECT waits for proxy success then preserves binary payload bidirectionally', async t => {
  const env = await setup(t, socket => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.on('data', bytes => socket.write(bytes)); });
  for (const host of hosts) {
    const client = env.connect(); client.on('error', () => {});
    client.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    assert.match((await header(client)).toString(), /^HTTP\/1.1 200 /);
    const binary = Buffer.from([0, 255, 128, 22, 3, 3, 0]);
    const received = once(client, 'data'); client.write(binary); assert.deepEqual((await received)[0], binary);
    client.destroy(); await once(client, 'close');
  }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(env.relay.active.size, 0); assert.equal(env.upstreamSockets.size, 0);
});
test('forbidden host never reaches upstream', async t => {
  const env = await setup(t, () => assert.fail('must not connect'));
  const client = env.connect(); client.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');
  assert.match((await header(client)).toString(), /^HTTP\/1.1 403 /); client.destroy();
  assert.equal(env.upstreamRequests(), 0);
});
test('failed upstream handshake returns 502 and closes both ends', async t => {
  const env = await setup(t, socket => socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
  const client = env.connect(); client.write('CONNECT ws.chatgpt.com:443 HTTP/1.1\r\n\r\n');
  assert.match((await header(client)).toString(), /^HTTP\/1.1 502 /); client.destroy();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(env.relay.active.size, 0); assert.equal(env.upstreamSockets.size, 0);
});
test('upstream disconnect closes downstream without residual sockets', async t => {
  const env = await setup(t, socket => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); setTimeout(() => socket.destroy(), 20); });
  const client = env.connect(); client.write('CONNECT ws.chatgpt.com:443 HTTP/1.1\r\n\r\n');
  await header(client); await once(client, 'close');
  for (let i = 0; i < 50 && env.relay.active.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(env.relay.active.size, 0);
});

test('cloud authority is opt-in, exact, and excludes prior browser destinations', () => {
 const hosts=new Set(['codex-cloud-backend.chatgpt.com']);
 const header=host=>Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
 assert.equal(parseConnect(header('codex-cloud-backend.chatgpt.com'),hosts),'codex-cloud-backend.chatgpt.com');
 assert.throws(()=>parseConnect(header('codex-cloud-backend.chatgpt.com')));
 for(const host of ['ws.chatgpt.com','127.0.0.1','codex-cloud-backend.chatgpt.com.evil']) assert.throws(()=>parseConnect(header(host),hosts));
});

test('cloud CONNECT transmits TLS bytes and rejects mismatched Host before upstream', async t => {
 const env=await setup(t, socket=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',bytes=>socket.write(bytes));},new Set(['codex-cloud-backend.chatgpt.com']));
 const denied=env.connect();denied.write('CONNECT codex-cloud-backend.chatgpt.com:443 HTTP/1.1\r\nHost: ws.chatgpt.com:443\r\n\r\n');
 assert.match((await header(denied)).toString(),/^HTTP\/1.1 403 /);denied.destroy();assert.equal(env.upstreamRequests(),0);
 const client=env.connect();client.write('CONNECT codex-cloud-backend.chatgpt.com:443 HTTP/1.1\r\nHost: codex-cloud-backend.chatgpt.com:443\r\n\r\n');
 assert.match((await header(client)).toString(),/^HTTP\/1.1 200 /);
 const bytes=Buffer.from([22,3,3,0,255]);const reply=once(client,'data');client.write(bytes);assert.deepEqual((await reply)[0],bytes);client.destroy();
});
