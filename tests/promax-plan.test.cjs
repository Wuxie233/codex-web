const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync('scratch/asar/webview/assets/app-initial-236e1501144c.js', 'utf8');
const list = ui.match(/\(eMn = (\[[^\]]+\])\)/)[1];
const AO = Object.fromEntries(['FREE', 'GO', 'PLUS', 'PROLITE', 'PRO'].map(k => [k, k.toLowerCase()]));
const code = ui.slice(ui.indexOf('function qjn('), ui.indexOf('function Zjn('));
const { access, needsSettings } = vm.runInNewContext(`${code}; ({access:qjn,needsSettings:Yjn})`, {
  eMn: vm.runInNewContext(list, { AO }), $jn: 'free',
});
const account = { accountId: 'test', accountInfoError: false, accountInfoLoading: false,
  authLoading: false, authMethod: 'chatgpt', plan: 'promax', supportedSurface: true };
test('promax local access does not depend on enterprise workspace settings', () => {
  assert.equal(needsSettings(account), false);
  for (const settings of [undefined, { isLoading: true }, { isError: true }]) {
    assert.equal(access(account, settings, undefined, { freePlanAllowed: true }).status, 'allowed');
  }
});
test('enterprise and unknown plans still require workspace approval', () => {
  for (const plan of ['business', 'enterprise', 'unknown']) {
    const a = { ...account, plan };
    assert.equal(needsSettings(a), true);
    assert.equal(access(a, { isError: true }, undefined, { freePlanAllowed: true }).status, 'error');
    assert.equal(access(a, {}, false, { freePlanAllowed: true }).reason, 'workspace-disabled');
    assert.equal(access(a, {}, true, { freePlanAllowed: true }).status, 'allowed');
  }
});
test('account failures and free-plan restrictions remain enforced', () => {
  assert.equal(access({...account, accountInfoError:true}, {}, true, {freePlanAllowed:true}).source, 'account-info');
  assert.equal(access({...account, plan:'free'}, {}, true, {freePlanAllowed:false}).reason, 'free-plan');
});
