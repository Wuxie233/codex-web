const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// Execute the real invoke dispatch seam without starting a daemon or a browser.
const source = fs.readFileSync('src/browser/shim.ts', 'utf8');
const guard = source.slice(source.indexOf('function isOpenInBrowserMessage('), source.indexOf('\nfunction requestWorkspaceDirectoryEntries('));
const invoke = source.slice(source.indexOf('  invoke(channel:'), source.indexOf('\n  on(channel:'));
function fixture() {
  const opened = [], forwarded = [];
  const js = ts.transpileModule(`${guard}\nconst ipc = {${invoke}}; ipc;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const ipc = vm.runInNewContext(js, {
    isRecord: value => value !== null && typeof value === 'object',
    isLocalFilePickerMessage: () => false,
    isUnhandledAddWorkspaceRootOptionMessage: () => false,
    window: { open: (...args) => { opened.push(args); return null; } },
    invokeMain: (...args) => { forwarded.push(args); return Promise.resolve('main'); },
  });
  return { ipc, opened, forwarded };
}
for (const flags of [{}, {openTargetIntent:'default', initiator:'markdown_link_click'}, {disposition:'new-tab',openTarget:'in-app-browser'}, {useExternalBrowser:true}]) {
  test(`web link is consumed once, including blocked popup: ${JSON.stringify(flags)}`, async () => {
    const f = fixture();
    const result = await f.ipc.invoke('codex_desktop:message-from-view', {type:'open-in-browser', url:'https://example.com/', ...flags});
    assert.equal(result, undefined);
    assert.deepEqual(f.opened, [['https://example.com/', '_blank', 'noopener,noreferrer']]);
    assert.equal(f.forwarded.length, 0, 'must not enter unsupported native browser routing');
  });
}
test('non-web protocols retain their existing dispatch', async () => {
  for (const url of ['codex://settings', 'mailto:test@example.com']) {
    const f = fixture();
    assert.equal(await f.ipc.invoke('codex_desktop:message-from-view', {type:'open-in-browser',url}), 'main');
    assert.equal(f.opened.length, 1);
    assert.equal(f.forwarded.length, 1);
  }
});
test('unrelated IPC retains its main process dispatch', async () => {
  const f = fixture();
  assert.equal(await f.ipc.invoke('other-channel', {type:'open-in-browser',url:'https://example.com/'}), 'main');
  assert.equal(f.opened.length, 0);
  assert.equal(f.forwarded.length, 1);
});
