const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scratch/asar/webview/assets/app-initial-236e1501144c.js'), 'utf8');
const start = source.indexOf('async function uRi(');
const end = source.indexOf('\nasync function dRi(', start);
assert(start >= 0 && end > start, 'Review worktree resolver after Desktop updates');
function resolver(replies) {
  const calls = [];
  const context = vm.createContext({ WD: {}, U_: x => x, jk: () => ({ request: async ({ method, params }) => {
    calls.push({ method, params });
    assert(Object.hasOwn(replies, method), `Unexpected Git operation ${method}`);
    return replies[method];
  } }) });
  vm.runInContext(source.slice(start, end), context);
  return { calls, run: state => context.uRi({ get: () => ({}) }, 'local', '/project', state) };
}
test('unborn repository fails before an invalid main branch can be queued', async () => {
  const r = resolver({ 'stable-metadata': { root: '/project' }, 'default-branch': { branch: null } });
  await assert.rejects(r.run(), /no resolvable default branch.*local/);
});
test('non-repository gives an actionable local-environment error', async () => {
  await assert.rejects(resolver({ 'stable-metadata': null }).run(), /not a Git repository.*local/);
});
test('default branch must actually resolve to a commit', async () => {
  await assert.rejects(resolver({ 'stable-metadata': { root: '/project' }, 'default-branch': { branch: 'main' }, 'resolve-worktree-starting-ref': null }).run(), /does not resolve to a commit/);
});
test('resolved default preserves remote-ref information', async () => {
  const r = resolver({ 'stable-metadata': { root: '/project' }, 'default-branch': { branch: 'trunk' }, 'resolve-worktree-starting-ref': { ref: 'abc', remoteRef: 'origin/trunk' } });
  const result = await r.run();
  assert.equal(result.branchName, 'trunk');
  assert.equal(result.remoteRef, 'origin/trunk');
  assert.equal(r.calls[2].params.ref, 'trunk');
});
test('explicit working-tree state remains unchanged without Git operations', async () => {
  const r = resolver({});
  const state = { type: 'working-tree' };
  assert.equal(await r.run(state), state);
  assert.equal(r.calls.length, 0);
});
test('existing explicit branch retains its validation path', async () => {
  const r = resolver({ 'stable-metadata': { root: '/project' }, 'resolve-worktree-starting-ref': { ref: 'abc' } });
  assert.equal((await r.run({ type: 'branch', branchName: 'feature' })).branchName, 'feature');
});
