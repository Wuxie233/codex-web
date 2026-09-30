const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync('scratch/asar/webview/assets/app-primary-6b28e06666ff.js', 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness(upload, host = 'local', forward) {
  const generation = { current: 0 }, canceled = new Set(), errors = [], requests = [];
  let pending = [], attachments = [], added = 0;
  const context = vm.createContext({ window: { electronBridge: { uploadBrowserFiles: upload } },
    qC: (() => { let id = 0; return () => String(++id); })(), Ex: 'toast',
    DC: () => ({ uploadLocalFileAttachments: async ({attachments}) => { requests.push(attachments); return forward ? forward(attachments) : attachments; } }),
    OMe: () => false, Rze: () => false, yb: () => ({succeed(){}, fail(){}}), WPr(){}, qe: 'local',
  });
  vm.runInContext(extract('function QYt(', 'function eXt(') + extract('function rFr({', '\nvar iFr'), context);
  const api = context.rFr({ scope: {get: () => ({danger: e => errors.push(e)})},
    attachmentGeneration: generation, canceledPendingFileAttachmentIds: canceled,
    executionHostId: host, intl: {formatMessage: x => x.defaultMessage},
    setPendingFileAttachments: fn => { pending = fn(pending); },
    setFileAttachments: fn => { attachments = fn(attachments); },
  });
  return { paste: (files, transfer = null) => api.addFileMentionsFromFiles(files, transfer, () => added++), generation, canceled, errors,
    pending: () => pending, attachments: () => attachments, added: () => added };
}
const flush = () => new Promise(r => setImmediate(r));
test('multiple ordinary files, including empty files, become attachments', async () => {
  const files = [{name:'notes.txt',size:4},{name:'archive.zip',size:2},{name:'empty.csv',size:0}];
  let received;
  const h = harness(async value => { received = value; return value.map(f => ({label:f.name,fsPath:'/tmp/'+f.name})); });
  h.paste(files); assert.equal(h.pending().length, 3); await flush();
  assert.equal(received, files); assert.equal(h.attachments().length, 3); assert.equal(h.pending().length, 0); assert.equal(h.added(), 1);
});
test('switching task while uploading does not attach to the new task', async () => {
  let resolve; const h = harness(() => new Promise(r => {resolve=r;}));
  h.paste([{name:'a.txt'}]); h.generation.current++;
  resolve([{label:'a.txt',fsPath:'/tmp/a'}]); await flush();
  assert.equal(h.attachments().length, 0); assert.equal(h.pending().length, 0);
});
test('upload failure clears pending and shows an error', async () => {
  const h = harness(async () => {throw Error('offline');}); h.paste([{name:'a.txt'}]); await flush();
  assert.equal(h.errors.length, 1); assert.equal(h.pending().length, 0); assert.equal(h.attachments().length, 0);
});
test('removed pending attachment is not restored on completion', async () => {
  let resolve; const h = harness(() => new Promise(r => {resolve=r;})); h.paste([{name:'a.txt'}]);
  h.canceled.add(h.pending()[0].id); resolve([{label:'a.txt',fsPath:'/tmp/a'}]); await flush();
  assert.equal(h.attachments().length, 0); assert.equal(h.pending().length, 0);
});
test('clipboard classification preserves images, empty ordinary files, and text-only pastes', () => {
  const ctx = vm.createContext({window:{electronBridge:{uploadBrowserFiles(){}}},ig: f => f.type.startsWith('image/')});
  vm.runInContext(extract('function xH(', 'function SH(')+extract('function QYt(', 'function eXt('),ctx);
  const files = [{name:'a.png',size:1,type:'image/png'},{name:'empty.txt',size:0,type:'text/plain'},{name:'data.bin',size:3,type:''}];
  const result = ctx.xH({files,items:[]});
  assert.equal(result.imageFiles.length,1); assert.equal(result.otherFiles.length,2);
  assert.equal(ctx.xH({files:[],items:[]}).otherFiles.length,0);
});

test('remote forwarding uses one pending set and honors cancellation', async () => {
  let resolve;
  const h = harness(async () => [{label:'a.txt',fsPath:'/tmp/a'}], 'remote', () => new Promise(r => {resolve=r;}));
  h.paste([{name:'a.txt'}]); await flush();
  assert.equal(h.pending().length, 1);
  h.canceled.add(h.pending()[0].id);
  resolve([{label:'a.txt',fsPath:'/remote/a'}]); await flush();
  assert.equal(h.attachments().length, 0); assert.equal(h.pending().length, 0);
});
test('directories are not silently uploaded as empty files', async () => {
  let uploads = 0; const h = harness(async () => { uploads++; return []; });
  const file = {name:'folder',size:0};
  h.paste([file], {files:[file],items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]});
  await flush(); assert.equal(uploads,0); assert.equal(h.errors.length,1);
});
