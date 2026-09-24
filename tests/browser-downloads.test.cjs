const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function fixture() {
  const downloads = [];
  const source = ts.transpileModule(fs.readFileSync('src/browser/downloads.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL, URLSearchParams,
    document: {
      createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }),
      body: { appendChild() {} },
    },
  });
  return { ...exports, downloads };
}

test('a local archive downloads once with its Unicode filename', () => {
  const f = fixture();
  const path = '/root/Documents/作业 #1.zip';
  assert.equal(f.downloadLocalFile({path, hostId:'local'}), true);
  assert.equal(f.downloads.length, 1);
  const url = new URL(f.downloads[0].href, 'https://example.com');
  assert.equal(url.pathname, '/__backend/download');
  assert.equal(url.searchParams.get('path'), path);
  assert.equal(f.downloads[0].name, '作业 #1.zip');
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
