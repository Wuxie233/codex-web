// Run the prepared Desktop coordinator itself; no daemon or cloud credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const build = path.resolve(__dirname, '../scratch/asar/.vite/build');
const file = process.env.CATALOG_MAIN_ASSET || path.join(build, fs.readdirSync(build).find(n => /^main-.*\.js$/.test(n)));
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('  nPe = class {');
const end = source.indexOf('\nfunction rPe(', start);
assert(start >= 0 && end > start, 'Review coordinator extraction when Desktop changes');
const context = vm.createContext({ Set, Map, Promise, AbortController, setTimeout, clearTimeout, setImmediate, y5: 100, b5: 1000, QNe: 1000, rPe: () => null, x5: () => new Map() });
vm.runInContext('this.Coordinator = ' + source.slice(start, end).replace(/^  nPe = /, ''), context);
function fixture({ complete = false, checkpointFailure = null } = {}) {
  let state = { isComplete: complete, catalogRevision: 1, sourceUpdatedAtWatermark: null, lastFullReconciliationAt: complete ? 1 : null };
  let fail = true;
  let time = 10_000;
  let duplicateCursor = false;
  const store = {
    readSyncState: () => ({ ...state }),
    readScanCheckpoint: () => checkpointFailure == null ? null : ({ failedAt: checkpointFailure, attempt: { mode: 'other' } }),
    beginScan: () => 'scan', abortScan() {}, pauseScan() {},
    applyScanPage: () => ({ changedThreadIds: [], removedThreadIds: [] }),
    completeScan: () => { state.isComplete = true; },
  };
  const coordinator = new context.Coordinator({ listPage: async () => {
    if (fail) throw new Error('403 sensitive response');
    return { items: [], nextCursor: duplicateCursor ? 'same-cursor' : null };
  }}, store, { now: () => time, resumeOffsetPagination: checkpointFailure != null, failureBackoffMs: 1000, yieldBetweenPages: async () => {} });
  coordinator.syncEnabled = true;
  const notices = [];
  coordinator.subscribe(() => notices.push(coordinator.readSyncState()));
  return { coordinator, notices, succeed: () => { fail = false; time += 2000; }, repeat: () => { fail = false; duplicateCursor = true; }, advance: () => time += 2000 };
}
test('first page failure publishes status despite zero catalog mutations', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.runSync(0, 'full'), 'failed');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].syncFailed, true);
  assert.equal(f.notices[0].isComplete, false);
  assert(!JSON.stringify(f.notices).includes('sensitive'));
});
test('failure backoff remains a failure until a successful retry', async () => {
  const f = fixture();
  await f.coordinator.runSync(0, 'full');
  assert.equal(await f.coordinator.requestRun(null, false, false), 'backoff');
  assert.equal(f.coordinator.readSyncState().syncFailed, true);
  f.succeed();
  assert.equal(await f.coordinator.runSync(0, 'full'), 'completed');
  assert.equal(f.notices.at(-1).syncFailed, false);
  assert.equal(f.notices.at(-1).isComplete, true);
});
test('already complete catalogs report refresh failure and zero-change recovery', async () => {
  const f = fixture({ complete: true });
  await f.coordinator.runSync(0, 'incremental');
  assert.equal(f.notices.at(-1).isComplete, true);
  assert.equal(f.notices.at(-1).syncFailed, true);
  f.succeed();
  const before = f.notices.length;
  await f.coordinator.runSync(0, 'incremental');
  assert.equal(f.notices.length, before + 1);
  assert.equal(f.notices.at(-1).syncFailed, false);
});
test('restored cloud checkpoint retains failure without claiming completion', () => {
  const f = fixture({ checkpointFailure: 9000 });
  assert.equal(f.coordinator.readSyncState().syncFailed, true);
  assert.equal(f.coordinator.readSyncState().isComplete, false);
});
test('repeated cursor failure also publishes without changed entries', async () => {
  const f = fixture(); f.repeat();
  assert.equal(await f.coordinator.runSync(0, 'full'), 'failed');
  assert.equal(f.notices.at(-1).syncFailed, true);
});
test('obsolete generation failures do not overwrite current status', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.runSync(-1, 'full'), 'aborted');
  assert.equal(f.notices.length, 0);
  assert.equal(f.coordinator.readSyncState().syncFailed, false);
});
test('manager wire status includes boolean failure for local and owned cloud hosts', () => {
  const managerStart = source.indexOf('  lPe = class {');
  const methodStart = source.indexOf('    readStatus() {', managerStart);
  const methodEnd = source.indexOf('\n    subscribeStatus(', methodStart);
  assert(managerStart >= 0 && methodStart > managerStart && methodEnd > methodStart);
  const Manager = vm.runInNewContext('(class {' + source.slice(methodStart, methodEnd) + '})');
  const manager = new Manager();
  manager.syncEnabled = true;
  manager.getRegistry = () => ({ listHostIds: kind => kind === 'local' ? ['local'] : [] });
  manager.hosts = new Map([
    ['local', { ownerCount: 0, revision: 2, coordinator: { readSyncState: () => ({ isComplete: true, catalogRevision: 2, syncFailed: false }) } }],
    ['chatgpt:account', { ownerCount: 1, revision: 0, coordinator: { readSyncState: () => ({ isComplete: false, catalogRevision: 0, syncFailed: true }) } }],
  ]);
  const status = manager.readStatus();
  assert.equal(status.hosts.find(h => h.hostId === 'local').syncFailed, false);
  assert.equal(status.hosts.find(h => h.hostId.startsWith('chatgpt:')).syncFailed, true);
  assert.equal(status.hosts.find(h => h.hostId.startsWith('chatgpt:')).isComplete, false);
});
