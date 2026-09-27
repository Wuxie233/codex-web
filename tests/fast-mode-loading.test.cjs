const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.FAST_MODE_SOURCE || 'scratch/asar/webview/assets/app-initial-236e1501144c.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `Missing bundle anchor: ${start}`);
  return source.slice(from, to);
}
const reads = [];
const context = {
  Skn: () => ['requirements'],
  pD: { FIVE_MINUTES: 300000 },
  wkn: (...args) => reads.push({ method: 'configRequirements/read', options: args[2] }),
  Eb: () => ({ sendRequest: (method, params, options) => reads.push({ method, options }) }),
  a: false, u: {}, d: {}, r: 'local', o: 100,
};
const requirements = vm.runInNewContext(section('function Ckn(', '\nasync function wkn(') + '\nCkn;', context);
const modelQuery = section('      (z$a = ab(', '\nfunction V$a()');
const modelQueryFn = modelQuery.slice(modelQuery.indexOf('queryFn: () => (') + 'queryFn: '.length, modelQuery.indexOf('\n            select:')).trim().replace(/,$/, '');
requirements({ scope: {}, authMethod: 'chatgpt', hostId: 'local' }).queryFn();
vm.runInNewContext(`(${modelQueryFn})()`, context);
const scheduler = vm.runInNewContext('({' + section('        getNextRequestIndex() {', '\n        startRequest(e) {') + '})', {
  _Cn: 6, vCn: 5, yCn: 3, SCn: 4,
});
for (const read of reads) {
  test(`${read.method} needed by composer bypasses saturated background slots`, () => {
    const state = { useHostRequestScheduler: false, inFlightRequestCount: 3, noncriticalRequestCount: 3, backgroundRequestCount: 3, backgroundYieldsInProgress: 0, interactiveDispatchesSinceBackground: 0, queuedRequests: [{ priority: read.options?.priority || 'background' }] };
    assert.equal(scheduler.getNextRequestIndex.call(state), 0);
    assert.equal(read.options.timeoutMs, 10000);
  });
}
test('requirements query preserves fail-closed retry behavior', () => {
  assert.equal(requirements({ failClosed: true }).retry, false);
  assert.equal(requirements({ failClosed: false }).retry, undefined);
});
function eligibility(auth, result) {
  return vm.runInNewContext(section('function M1a(e) {', '\nvar N1a,') + '\nM1a({hostId:"local"});', {
    N1a: { c: () => [] }, db: () => 'local', PI: {}, WR: () => auth, mb: () => result, nO: {},
  });
}
test('Fast stays unavailable while requirements are pending or denied', () => {
  assert.equal(eligibility({authMethod:'chatgpt'}, {isPending:true}).isServiceTierAllowed, false);
  assert.equal(eligibility({authMethod:'chatgpt'}, {isPending:false}).isServiceTierAllowed, false);
  assert.equal(eligibility({authMethod:'chatgpt'}, {isPending:false,data:{requirements:{featureRequirements:{fast_mode:false}}}}).isServiceTierAllowed, false);
  assert.equal(eligibility({authMethod:'apiKey'}, {isPending:false,data:{requirements:null}}).isServiceTierAllowed, false);
});
test('Fast becomes available after an eligible requirements response', () => {
  const state=eligibility({authMethod:'chatgpt',isLoading:false}, {isPending:false,data:{requirements:null}});
  assert.equal(state.isServiceTierAllowed,true);
  assert.equal(state.isLoading,false);
});
