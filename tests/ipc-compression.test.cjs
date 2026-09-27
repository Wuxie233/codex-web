const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');

// Exercise the server's actual transport configuration without starting Desktop.
const source = fs.readFileSync(path.join(__dirname, '../src/server/main.ts'), 'utf8');
const expression = source.match(/const websocketServer = (new WebSocketServer\([\s\S]*?\));/);
assert(expression, 'Locate the IPC WebSocket server configuration after refactors');

for (const compression of [true, false]) {
  test(`IPC preserves large messages and ordering with compression=${compression}`, async () => {
    const wss = vm.runInNewContext(expression[1], { WebSocketServer });
    const server = http.createServer();
    let client;
    try {
      server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
      });
      wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, {
        perMessageDeflate: compression,
      });
      await once(client, 'open');
      assert.equal(client.extensions.includes('permessage-deflate'), compression);
      if (compression) {
        const extension = client._extensions['permessage-deflate'];
        assert.equal(extension.params.server_no_context_takeover, true);
        assert.equal(extension.params.client_no_context_takeover, true);
      }
      const payloads = [
        JSON.stringify({ type: 'message-port-message', data: 'native RPC snapshot '.repeat(100000) }),
        JSON.stringify({ type: 'ipc-renderer-invoke-result', ok: true, result: 'ready' }),
        JSON.stringify({ type: 'message-port-message', data: 'another independent snapshot '.repeat(100000) }),
      ];
      const before = client._socket.bytesRead;
      const received = [];
      const done = new Promise((resolve, reject) => {
        client.on('error', reject);
        client.on('message', (data, binary) => {
          try {
            assert.equal(binary, false);
            received.push(data.toString());
            if (received.length === payloads.length) resolve();
          } catch (error) { reject(error); }
        });
      });
      for (const payload of payloads) client.send(payload);
      await done;
      assert.deepEqual(received, payloads);
      const rawBytes = payloads.reduce((total, payload) => total + Buffer.byteLength(payload), 0);
      const wireBytes = client._socket.bytesRead - before;
      if (compression) assert(wireBytes < rawBytes / 10, 'Large repetitive RPC frames should compress');
      else assert(wireBytes >= rawBytes, 'Clients without the extension must still work');
    } finally {
      client?.terminate();
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  });
}
