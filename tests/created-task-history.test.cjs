// Exercise the patched Desktop's history reader and mount/auth lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const file = process.env.CREATED_TASK_ASSET || path.resolve(__dirname, '../scratch/asar/webview/assets/local-conversation-thread-9a0a61c5e076.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('function createdTaskFromCall(');
const end = source.indexOf('function cx(', start);
assert(start >= 0 && end > start, 'Review created task history patch after Desktop updates');
const key = source.slice(source.indexOf('function ux('), source.indexOf('function dx('));
// Match the native receipt schema's field stripping: status/error must be
// rejected before ua(), because qNt/dPt intentionally removes those fields.
const context = { v: value => value, vx: 5, ua: text => {
  try {
    const value = JSON.parse(text);
    if (!value || typeof (value.threadId ?? value.clientThreadId) !== 'string') return null;
    return Object.fromEntries(Object.entries(value).filter(([key]) => ['kind', 'threadId', 'clientThreadId', 'hostId'].includes(key)));
  } catch { return null; }
} };
vm.createContext(context);
vm.runInContext(source.slice(start, end) + key, context);
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function call(id, overrides = {}) {
  return {
    id: `call-${id}`, type: 'dynamicToolCall', namespace: 'codex_app', tool: 'create_thread',
    status: 'completed', success: true, arguments: { target: { environment: { type: 'local' } }, title: `Title ${id}` },
    contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: id, hostId: 'local' }) }], ...overrides,
  };
}
function fixture(turns, hostId = 'local') {
  const calls = [], auth = new Set();
  const manager = {
    getHostId: () => hostId,
    addAuthStatusCallback: callback => auth.add(callback),
    removeAuthStatusCallback: callback => auth.delete(callback),
    async sendRequest(method, params, options) {
      calls.push({ method, ...params, options });
      const offset = Number(params.cursor ?? 0);
      if (method === 'thread/turns/list') {
        // Deliberately paginate turns even below requested limit.
        return { data: turns.slice(offset, offset + 1).map(turn => ({ id: turn.id })), nextCursor: offset + 1 < turns.length ? String(offset + 1) : null };
      }
      assert.equal(method, 'thread/items/list');
      const turn = turns.find(turn => turn.id === params.turnId);
      const items = turn.items.slice(offset, offset + params.limit);
      return { data: items.map(item => ({ turnId: turn.id, item })), nextCursor: offset + items.length < turn.items.length ? String(offset + items.length) : null };
    },
  };
  return { manager, calls, auth };
}
test('reload independently reads receipt older than the 50 item preview and older turn pages', async () => {
  const f = fixture([
    { id: 'new', items: [...Array.from({ length: 205 }, (_, i) => ({ type: 'agentMessage', id: `msg${i}` })), call('one')] },
    { id: 'older', items: [call('two'), call('three'), call('four')] },
  ]);
  const initial = await context.loadCreatedTaskHistory(f.manager, 'parent', () => true);
  assert.deepEqual(plain(initial.map(task => task.id)), ['one', 'two', 'three', 'four']);
  assert.equal(f.calls.filter(c => c.method === 'thread/items/list').length, 4);
  assert(f.calls.every(c => c.threadId === 'parent' && c.options.priority === 'background'));
  assert(f.calls.filter(c => c.method === 'thread/turns/list').every(c => c.itemsView === 'notLoaded'));
  const freshMount = await context.loadCreatedTaskHistory(f.manager, 'parent', () => true);
  assert.deepEqual(plain(freshMount), plain(initial), 'No previous browser state needed to recover links');
});
test('only completed successful native create_thread receipts appear; subagents and errors do not', async () => {
  const f = fixture([{ id: 'turn', items: [call('ok'), call('failed', { success: false }), call('working', { status: 'inProgress' }), call('agent', { tool: 'spawn_agent' }), call('foreign', { namespace: 'other' }), call('malformed', { contentItems: [{ type: 'inputText', text: '{broken' }] })] }]);
  assert.deepEqual(plain((await context.loadCreatedTaskHistory(f.manager, 'parent', () => true)).map(t => t.id)), ['ok']);
});
test('merge deduplicates by host and keeps native queued client IDs and five task limit', () => {
  const queued = call('queued', { contentItems: [{ type: 'inputText', text: JSON.stringify({ clientThreadId: 'client:pending', hostId: 'remote' }) }] });
  const history = [context.createdTaskFromCall(call('same'), 'local'), context.createdTaskFromCall(call('same', { contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: 'same', hostId: 'remote' }) }] }), 'remote')];
  const tasks = context.mergeCreatedTasks({ turn: [call('same'), queued] }, history, 'local');
  assert.deepEqual(plain(tasks.map(t => [t.id, t.hostId])), [['client:pending', 'remote'], ['same', 'local'], ['same', 'remote']]);
  assert.equal(context.mergeCreatedTasks({}, Array.from({ length: 8 }, (_, i) => ({ id: String(i), kind: 'codex', hostId: 'local' })), 'local').length, 5);
});
test('logout clears visible history and late pre-logout responses cannot repopulate it', async () => {
  const f = fixture([{ id: 'turn', items: [call('before')] }]);
  let resolve;
  const original = f.manager.sendRequest;
  f.manager.sendRequest = () => new Promise(r => { resolve = r; });
  const states = [];
  const stop = context.watchCreatedTaskHistory(f.manager, 'parent', value => states.push(plain(value)));
  [...f.auth][0]({ authMethod: null });
  resolve({ data: [{ id: 'turn' }], nextCursor: null });
  await tick();
  assert.deepEqual(states.at(-1), { tasks: [], enabled: false, blockedLiveTasks: [] });
  f.manager.sendRequest = original;
  [...f.auth][0]({ authMethod: 'chatgpt' });
  await tick();
  assert.deepEqual(states.at(-1).tasks.map(t => t.id), ['before']);
  stop();
  assert.equal(f.auth.size, 0);
  assert.deepEqual(states.at(-1), { tasks: [], enabled: false, blockedLiveTasks: [] });
});
test('unmount stops further page requests and ignores delayed response', async () => {
  const f = fixture([]), states = [];
  let resolve, requests = 0;
  f.manager.sendRequest = () => { ++requests; return new Promise(r => { resolve = r; }); };
  const stop = context.watchCreatedTaskHistory(f.manager, 'parent-a', value => states.push(plain(value)));
  stop();
  resolve({ data: [{ id: 'turn' }], nextCursor: 'older' });
  await tick();
  assert.equal(requests, 1);
  assert.deepEqual(states.at(-1), { tasks: [], enabled: false, blockedLiveTasks: [] });
});
test('host and parent changes use fresh managers without retained relation state', async () => {
  for (const [hostId, parent, child] of [['host-a', 'parent-a', 'child-a'], ['host-b', 'parent-b', 'child-b']]) {
    const f = fixture([{ id: 'turn', items: [call(child, { contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: child }) }] })] }], hostId);
    let value;
    const stop = context.watchCreatedTaskHistory(f.manager, parent, next => { value = plain(next); });
    await tick();
    assert.deepEqual(value.tasks.map(t => [t.hostId, t.id]), [[hostId, child]]);
    assert(f.calls.every(c => c.threadId === parent));
    stop();
  }
});
test('RPC errors remain recoverable on the next authentication event', async () => {
  const f = fixture([{ id: 'turn', items: [call('ok')] }]), original = f.manager.sendRequest;
  let value;
  f.manager.sendRequest = async () => { throw new Error('temporarily disconnected'); };
  const stop = context.watchCreatedTaskHistory(f.manager, 'parent', next => { value = plain(next); });
  await tick();
  assert.deepEqual(value.tasks, []);
  f.manager.sendRequest = original;
  [...f.auth][0]({ authMethod: 'chatgpt' });
  await tick();
  assert.deepEqual(value.tasks.map(t => t.id), ['ok']);
  stop();
});
test('repeated cursors and wrong-turn responses fail instead of looping or accepting unrelated receipts', async () => {
  const f = fixture([]);
  f.manager.sendRequest = async method => method === 'thread/turns/list'
    ? { data: [], nextCursor: 'same' } : assert.fail('unexpected items request');
  await assert.rejects(context.loadCreatedTaskHistory(f.manager, 'parent', () => true), /repeated turn cursor/);
  f.manager.sendRequest = async method => method === 'thread/turns/list'
    ? { data: [{ id: 'turn' }], nextCursor: null }
    : { data: [], nextCursor: 'same' };
  await assert.rejects(context.loadCreatedTaskHistory(f.manager, 'parent', () => true), /repeated item cursor/);
  f.manager.sendRequest = async method => method === 'thread/turns/list'
    ? { data: [{ id: 'turn' }], nextCursor: null }
    : { data: [{ turnId: 'foreign', item: call('foreign') }], nextCursor: null };
  await assert.rejects(context.loadCreatedTaskHistory(f.manager, 'parent', () => true), /unexpected turn/);
});

test('history keeps server recency when newer receipts were outside the live preview', () => {
  const history = ['newest', 'old'].map(id => context.createdTaskFromCall(call(id), 'local'));
  const tasks = context.mergeCreatedTasks({ turn: [call('old')] }, history, 'local');
  assert.deepEqual(plain(tasks.map(t => t.id)), ['newest', 'old']);
  const newer = context.mergeCreatedTasks({ turn: [call('old'), call('brand-new')] }, history, 'local');
  assert.deepEqual(plain(newer.map(t => t.id)), ['brand-new', 'newest', 'old']);
});
test('auth changes fence old live receipts even when new history is empty or fails', async () => {
  const f = fixture([{ id: 'turn', items: [call('old')] }]);
  const live = { turn: [call('old')] };
  let value;
  const stop = context.watchCreatedTaskHistory(f.manager, 'parent', next => { value = plain(next); }, () => live);
  await tick();
  assert.deepEqual(value.tasks.map(t => t.id), ['old']);
  let resolve;
  f.manager.sendRequest = () => new Promise(r => { resolve = r; });
  [...f.auth][0]({ authMethod: 'chatgpt' });
  assert.equal(value.enabled, false);
  resolve({ data: [], nextCursor: null });
  await tick();
  assert.equal(value.enabled, true);
  assert.deepEqual(plain(context.mergeCreatedTasks(live, value.tasks, 'local', value.blockedLiveTasks)), []);
  live.turn.push(call('new'));
  assert.deepEqual(plain(context.mergeCreatedTasks(live, value.tasks, 'local', value.blockedLiveTasks).map(t => t.id)), ['new']);
  f.manager.sendRequest = async () => { throw Error('permission denied'); };
  [...f.auth][0]({ authMethod: 'chatgpt' });
  await tick();
  assert.equal(value.enabled, false);
  stop();
});

test('unknown and failed result envelopes are rejected before native schema strips their status', () => {
  for (const extra of [{ status: 'unknown' }, { status: 'failed' }, { status: 'error' }, { error: 'delivery failed' }, { success: false }]) {
    const receipt = call('unconfirmed', { contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: 'unconfirmed', ...extra }) }] });
    assert.equal(context.createdTaskFromCall(receipt, 'local'), null);
  }
  for (const text of ['null', '42', '"string"', '[]', '{}', '{"threadId":null}'])
    assert.equal(context.createdTaskFromCall(call('bad', { contentItems: [{ type: 'inputText', text }] }), 'local'), null);
});

test('opening a recovered task installs its native host mapping before navigation', () => {
  const events = [];
  context.Te = 'resolved'; context.pt = 'queued';
  context.ms = (_scope, id, hostId) => events.push({ id, hostId });
  context.kr = { dispatchHostMessage: event => events.push(plain(event)) };
  const scope = { get: (key, id) => key === 'resolved' ? (id.startsWith('client:') ? null : id) : id === 'client:ready' ? 'real-id' : null };
  context.openCreatedTask({ kind: 'codex', id: 'child', hostId: 'remote' }, '/local/child', scope);
  assert.deepEqual(events.splice(0), [{ id: 'child', hostId: 'remote' }, { type: 'navigate-to-route', path: '/local/child' }]);
  context.openCreatedTask({ kind: 'codex', id: 'client:ready', hostId: 'remote' }, '/local/real-id', scope);
  assert.deepEqual(events.splice(0), [{ id: 'real-id', hostId: 'remote' }, { type: 'navigate-to-route', path: '/local/real-id' }]);
  context.openCreatedTask({ kind: 'codex', id: 'client:pending', hostId: 'remote' }, '/local/client:pending', scope);
  assert.deepEqual(events.splice(0), [{ type: 'navigate-to-route', path: '/local/client:pending' }]);
});
test('native unconfirmed create result envelopes do not become task relations', () => {
  for (const result of [
    { status: 'outcome-unknown', requestId: 'request' },
    { status: 'created', conversationId: 'child', firstTurn: { status: 'outcome-unknown' } },
    { status: 'created', conversationId: 'child', firstTurn: { status: 'rejected' } },
  ]) assert.equal(context.createdTaskFromCall(call('ignored', { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }), 'local'), null);
});

test('fresh route mounts validate and fence cached live receipts after auth changed elsewhere', async () => {
  for (const denied of [false, true]) {
    const f = fixture([]), live = { turn: [call('previous-account')] };
    let value, resolve;
    f.manager.sendRequest = () => denied ? Promise.reject(Error('permission denied')) : new Promise(r => { resolve = r; });
    const stop = context.watchCreatedTaskHistory(f.manager, 'parent', next => { value = plain(next); }, () => live);
    assert.equal(value.enabled, false, 'cached live data must not flash before validation');
    if (!denied) resolve({ data: [], nextCursor: null });
    await tick();
    assert.equal(value.enabled, !denied);
    assert.deepEqual(plain(context.mergeCreatedTasks(live, value.tasks, 'local', value.blockedLiveTasks)), []);
    stop();
  }
});
