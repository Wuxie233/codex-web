// Execute the pinned Desktop method with the lifecycle patch applied in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, getEventListeners } = require('node:events');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
let source = fs.readFileSync(process.env.APP_TOOL_ASSET || path.join(root, 'scratch/asar/.vite/build/main-C5K7o1Hr.js'), 'utf8');
if (!source.includes('const responseTimeout =')) {
  const patch = fs.readFileSync(path.join(root, 'patches/main-app-tool-lifecycle.patch'), 'utf8');
  const lines = patch.split('\n');
  const hunks = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('@@')) continue;
    const before = [], after = [];
    for (++index; index < lines.length && !lines[index].startsWith('@@'); index++) {
      const line = lines[index];
      if (line.startsWith(' ') || line.startsWith('-')) before.push(line.slice(1));
      if (line.startsWith(' ') || line.startsWith('+')) after.push(line.slice(1));
    }
    index--;
    hunks.push([before.join('\n') + '\n', after.join('\n') + '\n']);
  }
  for (const [before, after] of hunks) {
    assert(source.includes(before), 'Pinned main bundle must match the lifecycle patch');
    source = source.replace(before, after);
  }
}
const start = source.indexOf('  async callDynamicAppTool(e, t) {');
const end = source.indexOf('  async handleMessage(e, t) {', start);
assert(start >= 0 && end > start);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(configs = [{}], params = {}) {
  const timers = new Map(), contents = new Map(), calls = [], pending = new Map();
  let sequence = 0;
  const context = vm.createContext({
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    l: { webContents: { fromId: id => contents.get(id) } },
    r: { Ct: () => ({ u: value => value, e: null, d() { if (this.e) throw this.e; } }) },
    A5: { warning() {} },
  });
  vm.runInContext('this.method = ({' + source.slice(start, end) + '}).callDynamicAppTool;', context);
  const host = {
    options: { windowManager: { getPrimaryWindow: () => ({ webContents: { id: 1 } }) } },
    readyAppViewWebContentsIds: new Set(), appViewsByWebContentsId: new Map(),
    messageHandler: {
      waitForDynamicAppToolResponse(id) { const entry = deferred(); pending.set(id, entry); return entry.promise; },
      discardDynamicAppToolResponse(id) { pending.delete(id); },
      cancelDynamicAppToolResponse(id) { calls.push('cancel-response'); pending.get(id)?.reject(Error('cancelled')); pending.delete(id); },
    },
  };
  configs.forEach((config, index) => {
    const id = index + 1, wc = new EventEmitter();
    wc.dead = false; wc.isDestroyed = () => wc.dead;
    wc.destroy = () => { wc.dead = true; wc.emit('destroyed'); };
    contents.set(id, wc); host.readyAppViewWebContentsIds.add(id);
    const tools = {
      canCallTool() { calls.push(`can:${id}`); return config.capability ?? true; },
      dispatchToolCall() { calls.push(`dispatch:${id}`); return config.dispatch ?? true; },
      cancelToolCall() { calls.push(`cancel:${id}`); return config.cancel; },
    };
    host.appViewsByWebContentsId.set(id, { services: config.services ?? Promise.resolve({ dynamicAppTools: tools }) });
  });
  const controller = new AbortController();
  const result = context.method.call(host, { params: { callId: 'call', tool: 'create_thread', ...params } }, controller.signal);
  // Rejections are asserted later after advancing our deterministic clock.
  result.catch(() => {});
  return { result, controller, contents, calls, timers, pending,
    async tick(delay) { await flush(); const entry = [...timers.values()].find(timer => timer.delay === delay); assert(entry, `Expected ${delay}ms timer`); entry.fn(); await flush(); },
    async ready() { await flush(); },
    resolve(value) { pending.get('call').resolve(value); },
    clean() { assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(timers.size, 0); assert.equal(pending.size, 0); for (const wc of contents.values()) assert.equal(wc.listenerCount('destroyed'), 0); },
  };
}
test('normal response returns and cleans listeners and pending state', async () => {
  const f = fixture(); await f.ready(); f.resolve({ threadId: 'created' });
  assert.deepEqual(await f.result, { threadId: 'created' }); f.clean();
});
test('unresponsive capability query falls through to another renderer', async () => {
  const f = fixture([{ capability: deferred().promise }, {}]);
  await f.tick(5000); f.resolve('ok'); assert.equal(await f.result, 'ok');
  assert.deepEqual(f.calls, ['can:1', 'can:2', 'dispatch:2']); f.clean();
});
test('unresolved services are bounded before selecting a renderer', async () => {
  const f = fixture([{ services: deferred().promise }, {}]);
  await f.tick(5000); f.resolve('ok'); assert.equal(await f.result, 'ok'); f.clean();
});
test('destroyed renderer rejects an in-flight response without replaying', async () => {
  const f = fixture([{}, {}]); await f.ready(); f.contents.get(1).destroy();
  await assert.rejects(f.result, /disconnected/); await f.ready();
  assert(!f.calls.includes('dispatch:2')); assert(f.calls.includes('cancel:1')); f.clean();
});
test('abort settles even when dispatch and cancellation never acknowledge', async () => {
  const f = fixture([{ dispatch: deferred().promise, cancel: deferred().promise }, {}]);
  await f.ready(); f.controller.abort(Error('caller cancelled'));
  await assert.rejects(f.result, /caller cancelled/); await f.ready();
  assert(!f.calls.includes('dispatch:2')); f.clean();
});
test('dispatch timeout has unknown outcome and never retries another page', async () => {
  const f = fixture([{ dispatch: deferred().promise }, {}]); await f.tick(300000);
  await assert.rejects(f.result, /timed out during dispatch/);
  assert(!f.calls.includes('dispatch:2')); f.clean();
});
test('silent renderer response eventually fails with no automatic replay', async () => {
  const f = fixture([{}, {}]); await f.tick(300000);
  await assert.rejects(f.result, /timed out during response/);
  assert(!f.calls.includes('dispatch:2')); f.clean();
});
test('long wait_threads retains its requested hour plus response grace', async () => {
  const f = fixture([{}], { tool: 'wait_threads', arguments: { timeoutMs: 3600000 } });
  await f.ready(); assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [3630000]);
  f.resolve('done'); assert.equal(await f.result, 'done'); f.clean();
});
test('explicitly declined dispatch may select another renderer', async () => {
  const f = fixture([{ dispatch: false }, {}]); await f.ready(); f.resolve('ok');
  assert.equal(await f.result, 'ok'); assert(f.calls.includes('dispatch:2')); f.clean();
});

test('abort during the response wait clears the pending call immediately', async () => {
  const f = fixture([{ cancel: deferred().promise }]); await f.ready();
  f.controller.abort(Error('response cancelled'));
  await assert.rejects(f.result, /response cancelled/); await f.ready(); f.clean();
});
test('abort before a queued bridge operation does not dispatch the tool', async () => {
  const f = fixture(); f.controller.abort(Error('early cancellation'));
  await assert.rejects(f.result, /early cancellation/); await f.ready();
  assert(!f.calls.some(call => call.startsWith('dispatch:'))); f.clean();
});

test('long wait_threads also permits execution inside dispatchToolCall', async () => {
  const execution = deferred();
  const f = fixture([{ dispatch: execution.promise }], { tool: 'wait_threads', arguments: { timeoutMs: 3600000 } });
  await f.ready(); assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [3630000]);
  f.resolve('done'); execution.resolve(true);
  assert.equal(await f.result, 'done'); f.clean();
});
