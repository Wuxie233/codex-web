const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ThreadCoordinator } = require('../src/server/thread-coordinator.js');
test('recovery read validates identity and exact turn without requiring a write request ID', async () => {
  const calls = [];
  const coordinator = new ThreadCoordinator({}, { recovery: { readTask: async (...args) => {
    calls.push(args); return { status: 'waiting', enabled: true };
  } } });
  const request = { method: 'codexWeb/recovery/read', params: { hostId:'local', threadId:'thread', turnId:'root' } };
  assert.equal((await coordinator.handle('codecarry', request)).status, 'waiting');
  assert.deepEqual(calls, [['local','thread','root']]);
  await assert.rejects(coordinator.handle('untrusted', request), /identity/);
  await assert.rejects(coordinator.handle('codecarry', { ...request, params: {...request.params,turnId:''} }), /turnId/);
  assert.equal(calls.length, 1);
});
