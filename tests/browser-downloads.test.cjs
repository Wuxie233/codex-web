const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function fixture({status = 200, failure} = {}) {
  const downloads = [], requests = [], alerts = [], blobs = [], revoked = [], timers = [];
  class ObjectURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:https://example.com/archive'; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const source = ts.transpileModule(fs.readFileSync('src/browser/downloads.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL: ObjectURL, URLSearchParams,
    fetch: async (url, options) => {
      requests.push({url, options});
      if (failure) throw failure;
      return { ok: status >= 200 && status < 300, status, blob: async () => ({bytes:'archive'}) };
    },
    window: { alert: message => alerts.push(message), setTimeout: callback => timers.push(callback) },
    document: {
      createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }),
      body: { appendChild() {} },
    },
  });
  return { ...exports, downloads, requests, alerts, blobs, revoked, timers };
}

test('a local archive downloads once with its Unicode filename', async () => {
  const f = fixture();
  const path = '/root/Documents/作业 #1.zip';
  assert.equal(f.downloadLocalFile({path, hostId:'local'}), true);
  await new Promise(setImmediate);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.requests[0].options.credentials, 'include');
  const url = new URL(f.requests[0].url, 'https://example.com');
  assert.equal(url.pathname, '/__backend/download');
  assert.equal(url.searchParams.get('path'), path);
  assert.equal(f.downloads[0].name, '作业 #1.zip');
  assert.equal(f.downloads[0].href, 'blob:https://example.com/archive');
  assert.equal(f.revoked.length, 0);
  f.timers.forEach(callback => callback());
  assert.deepEqual(f.revoked, ['blob:https://example.com/archive']);
});

test('remote hosts and non-download previews keep their native behavior', () => {
  const f = fixture();
  for (const request of [
    {path:'/tmp/report.zip',hostId:'ssh:server'},
    {path:'https://example.com/report.zip'},
    {path:'file://server/tmp/report.zip'},
    {path:'//server/report.zip'},
    {path:'report.zip'},
    {path:'/tmp/project.zip',openMode:'workspace'},
    {path:'/tmp/code.ts'},
    {path:'/tmp/report.pdf'},
    {path:'/tmp/report.docx'},
    {path:'/tmp/image.png'},
    {path:'file:///tmp/bad%00.zip'},
  ]) assert.equal(f.downloadLocalFile(request), false, JSON.stringify(request));
  assert.equal(f.downloads.length, 0);
});

test('local file URLs and cwd-relative archives resolve to server paths', () => {
  const f = fixture();
  assert.equal(f.localDownloadPath({path:'file:///tmp/hello%20world.zip'}), '/tmp/hello world.zip');
  assert.equal(f.localDownloadPath({path:'out/data.tar.gz',cwd:'/tmp/project/'}), '/tmp/project/out/data.tar.gz');
});

for (const status of [401, 403, 404, 500]) {
  test(`HTTP ${status} is reported rather than saved as an archive`, async () => {
    const f = fixture({status});
    assert.equal(f.downloadLocalFile({path:'/tmp/report.zip',hostId:'local'}), true);
    await new Promise(setImmediate);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.blobs.length, 0);
    assert.equal(f.alerts.length, 1);
    assert.match(f.alerts[0], status === 401 ? /重新登录/ : new RegExp(String(status)));
  });
}

test('network failures are visible and create no download', async () => {
  const f = fixture({failure: new Error('network unavailable')});
  assert.equal(f.downloadLocalFile({path:'/tmp/report.zip'}), true);
  await new Promise(setImmediate);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.blobs.length, 0);
  assert.equal(f.alerts.length, 1);
});

test('explicit download accepts documents and source while preserving path and host boundaries', async () => {
  const f = fixture();
  for (const path of ['/tmp/报告.pdf', '/tmp/report.docx', '/tmp/code.ts']) {
    assert.equal(f.downloadLocalFile({path, openMode:'download'}), true);
  }
  for (const request of [
    {path:'/tmp/report.pdf', hostId:'ssh:server'},
    {path:'https://example.com/report.pdf'},
    {path:'file://server/tmp/report.pdf'},
    {path:'//server/report.pdf'},
    {path:'report.pdf'},
    {path:'file:///tmp/bad%00.pdf'},
  ]) assert.equal(f.downloadLocalFile({...request, openMode:'download'}), false);
  await new Promise(setImmediate);
  assert.equal(f.downloads.length, 3);
});

test('actual file menu offers download first and dispatches the selected file once', () => {
  const source = fs.readFileSync('scratch/asar/webview/assets/app-initial-236e1501144c.js', 'utf8');
  const start = source.indexOf('function yBi(');
  const end = source.indexOf('\nfunction bBi(', start);
  assert(start > 0 && end > start, 'native menu anchors exist');
  const f = fixture(), selected = [];
  const context = {
    window: {__ELECTRON_SHIM__: {
      canDownloadLocalFile: request => f.localDownloadPath(request) !== null,
      downloadLocalFile: request => selected.push(request),
    }},
    WD: 'host', yX: 'capability', KW: 'query', xA:'platform',
    gBi: () => ({primaryTarget:null, visibleTargets:[]}),
    K_: () => false, x_: () => false, hx: (cwd, path) => `${cwd}/${path}`,
    iX: {}, XW: {}, ns: value => value, bBi: () => ({}),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const scope = {get: () => ({}), query:{getData: () => ({})}};
  const menu = context.yBi(scope, {path:'报告.pdf', cwd:'/tmp', hostId:'local'});
  assert.equal(menu[0].id, 'workspace-file-download');
  assert.equal(menu[0].message.id, 'browserArtifact.download');
  menu[0].onSelect();
  assert.equal(selected.length, 1);
  assert.equal(f.localDownloadPath(selected[0]), '/tmp/报告.pdf');
  for (const request of [
    {path:'/tmp/project', openMode:'workspace'},
    {path:'/tmp/report.zip', hostId:'ssh:server'},
    {path:'https://example.com/report.zip'},
  ]) assert(!context.yBi(scope, request).some(item => item.id === 'workspace-file-download'));
});
