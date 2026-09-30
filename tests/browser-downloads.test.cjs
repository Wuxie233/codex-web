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

test('explicit downloads save documents without changing default previews', async () => {
  const f = fixture();
  for (const name of ['方案.md', 'report.pdf', 'image.png', 'code.ts', 'LICENSE']) {
    const request = {path: name, cwd: '/tmp/project', hostId: 'local'};
    assert.equal(f.downloadLocalFile(request), false);
    assert.equal(f.downloadLocalFile(request, true), true);
    await new Promise(setImmediate);
    assert.equal(f.downloads.at(-1).name, name);
    assert.equal(new URL(f.requests.at(-1).url, 'https://example.com').searchParams.get('path'), `/tmp/project/${name}`);
  }
});

test('explicit downloads still reject remote hosts, invalid paths and workspaces', () => {
  const f = fixture();
  for (const request of [
    {path: '/tmp/report.md', hostId: 'ssh:server'},
    {path: 'https://example.com/report.md'},
    {path: 'file://server/tmp/report.md'},
    {path: '//server/report.md'},
    {path: 'report.md'},
    {path: '/tmp/project', openMode: 'workspace'},
    {path: 'file:///tmp/bad%00.md'},
  ]) assert.equal(f.downloadLocalFile(request, true), false);
  assert.equal(f.requests.length, 0);
});
