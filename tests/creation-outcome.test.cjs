const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('scratch/asar/webview/assets/app-primary-6b28e06666ff.js', 'utf8');
const helper = source.slice(source.indexOf('async function codexWebCreateTask('), source.indexOf('\nfunction a$r('));
async function run(navigate) {
  const storage = new Map();
  let creates = 0, settled = 0;
  const receipt = { status: 'created', threadId: 'real', turnId: 'turn' };
  const window = { location: { pathname: '/thread/draft' }, addEventListener() {}, removeEventListener() {},
    electronBridge: { async serverCoordinatorRequest({ method }) {
      if (method === 'codexWeb/thread/create') { creates++; return { status: 'queued' }; }
      if (navigate === 'read') window.location.pathname = '/thread/real';
      return receipt;
    } },
    async codexWebApplyCreationMetadata() { if (navigate === 'metadata') window.location.pathname = '/thread/real'; }
  };
  const context = vm.createContext({ window, crypto: { randomUUID: () => 'request' },
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1000 ? 0 : ms), clearTimeout, ql: { warning() {} } });
  vm.runInContext(helper, context);
  const result = await context.codexWebCreateTask({ hostId: 'local', target: {}, nativeParams: { input: [] }, clientThreadId: 'draft', onSettled() { settled++; } });
  return { result, creates, settled };
}
for (const where of ['read', 'metadata']) test(`accepted creation stays successful when recovery navigates during ${where}`, async () => {
  const { result, creates } = await run(where);
  assert.equal(result.status, 'created');
  assert.equal(result.conversationId, 'real');
  assert.equal(creates, 1);
});
