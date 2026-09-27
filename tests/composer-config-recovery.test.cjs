const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../scratch/asar/webview/assets/app-primary-6b28e06666ff.js'), 'utf8');
const start = source.indexOf('function TXr(e) {');
const end = source.indexOf('\nvar EXr,', start);
assert(start >= 0 && end > start, 'Review composer queue after Desktop updates');
function harness(fetch) {
  const slots = [], effects = [], timers = new Map(), sent = [], errors = [];
  const cache = Array(26).fill(Symbol.for('react.memo_cache_sentinel'));
  let cursor = 0, nextTimer = 0, state;
  const props = { isLocalConfigPending: true, localConfigTargetKey: 'local:/project',
    submitTargetKey: 'thread-a', onSubmitQueued: fetch,
    submitComposer: options => sent.push(options), submitDirectComment: message => sent.push(message) };
  const hook = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value;
      return [slots[index], v => { slots[index] = v; }]; },
    useEffect(fn, deps) { const index = cursor++, old = slots[index];
      if (!old || deps.some((v, i) => v !== old.deps[i])) {
        slots[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); });
      }
    },
    useEffectEvent(fn) { return fn; },
  };
  const ctx = vm.createContext({ EXr: { c: () => cache }, A9: hook, uD: f => f,
    kXr: e => errors.push(e), setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(source.slice(start, end), ctx);
  function render(update = {}) { Object.assign(props, update); cursor = 0; state = ctx.TXr(props);
    while (effects.length) effects.shift()(); return state; }
  return { render, sent, errors, timers, queue: () => state.queueSubmit({ type: 'composer', options: { draft: 'keep me' } }),
    expire: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('failed configuration unlocks this composer and permits manual retry', async () => {
  let calls = 0;
  const h = harness(() => { calls++; return Promise.reject(new Error('offline')); });
  h.render(); assert.equal(h.queue(), true); assert.equal(h.render().hasPendingSubmit, true);
  await flush(); assert.equal(h.render().hasPendingSubmit, false);
  assert.equal(h.sent.length, 0); assert.equal(h.errors.length, 1);
  h.queue(); await flush(); assert.equal(calls, 2);
});
test('hung configuration releases pending submit without sending or later replay', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  h.render(); h.queue(); h.render(); await flush();
  assert.equal([...h.timers.values()][0].ms, 20000);
  h.expire(); assert.equal(h.render().hasPendingSubmit, false);
  resolve(); await flush(); h.render({ isLocalConfigPending: false });
  assert.equal(h.sent.length, 0);
});
test('successful configuration submits exactly once and clears timeout', async () => {
  const h = harness(() => Promise.resolve());
  h.render(); h.queue(); h.render(); await flush();
  h.render({ isLocalConfigPending: false }); h.render();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].draft, 'keep me');
  assert.equal(h.timers.size, 0); h.expire(); assert.equal(h.errors.length, 0);
});
test('switching conversations cancels old queued send and old failure cannot clear new send', async () => {
  let reject;
  const h = harness(() => new Promise((_, r) => { reject = r; }));
  h.render(); h.queue(); h.render(); await flush();
  h.render({ submitTargetKey: 'thread-b', localConfigTargetKey: 'local:/other' }); h.render();
  h.queue(); h.render(); reject(new Error('old request')); await flush();
  assert.equal(h.render().hasPendingSubmit, true); assert.equal(h.sent.length, 0);
});

test('manual retry after timeout starts a fresh read and ignores an older late failure', async () => {
  const rejects = [];
  const h = harness(() => new Promise((_, reject) => rejects.push(reject)));
  h.render(); h.queue(); h.render(); await flush();
  h.expire(); h.render(); h.queue(); h.render(); await flush();
  assert.equal(rejects.length, 2);
  rejects[0](new Error('old failure')); await flush();
  assert.equal(h.render().hasPendingSubmit, true);
  h.render({ isLocalConfigPending: false }); h.render();
  assert.equal(h.sent.length, 1);
});

test('switching threads in the same directory does not inherit a hung read lock', async () => {
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(() => {}); });
  h.render(); h.queue(); h.render(); await flush();
  h.render({ submitTargetKey: 'thread-b' }); h.render();
  h.queue(); h.render(); await flush();
  assert.equal(calls, 2);
  h.expire(); h.render(); h.queue(); h.render(); await flush();
  assert.equal(calls, 3); assert.equal(h.sent.length, 0);
});
