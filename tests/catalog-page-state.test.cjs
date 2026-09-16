const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const dir=path.join(__dirname,'../scratch/asar/webview/assets');
const src=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>/^app-initial-.*\.js$/.test(n))),'utf8');
const start=src.indexOf('sAo = class {'), end=src.indexOf('\n      }));',start);
assert(start>0&&end>start);
function setup({failed=true,complete=false,cursor=null}={}) {
 const scope={key:'all'}; let syncs=0; let status={hosts:[{hostId:'local',isComplete:true,revision:1},{hostId:'chatgpt:test',isComplete:complete,syncFailed:failed,revision:1}]};
 const win={dispatchEvent(){}};
 const context={window:win,Event:class{},iAo:{hasMore:false,isLoading:false},aAo:{hasMore:true,isLoading:false},oAo:{hasMore:true,isLoading:true},tAo:e=>[e],eAo:e=>e.key,HP:(a,b)=>a+':'+b,rAo:{default:()=>false},ydr:()=>{},KP:{},nAo:()=>Promise.resolve()};
 vm.createContext(context);vm.runInContext('this.Catalog = '+src.slice(start+'sAo = '.length,end)+'\n}',context);
 const service={readPage:({hostId})=>({entries:hostId==='local'?[{hostId,threadId:'one'}]:cursor?[{hostId,threadId:'cached'}]:[],nextCursor:hostId==='local'?null:cursor}),readEntries:()=>[],requestSync:async()=>{syncs++;return status}};
 const c=new context.Catalog({get:()=>({entries:[]})},service,['local','chatgpt:test'],'updated_at');
 c.updateStatus(status);
 return {c,scope,win,service,load:()=>c.ensurePage(scope,1),syncs:()=>syncs,recover:()=>{status={hosts:status.hosts.map(h=>({...h,syncFailed:false,isComplete:true}))}}};
}
test('failed cloud plus exhausted local has no next page, local row stays',async()=>{const x=setup();await x.load();assert.equal(x.c.getPageState(x.scope).hasMore,false);assert.equal(x.c.getEntries(x.scope).length,1);assert.equal(x.win.__codexCatalogSyncNotice.failed,true);await x.c.loadMore(x.scope,10);assert.equal(x.syncs(),0)});
test('healthy incomplete sync still exposes potential pages',async()=>{const x=setup({failed:false});await x.load();assert.equal(x.c.getPageState(x.scope).hasMore,true)});
test('failed sync preserves a real cached cursor',async()=>{const x=setup({cursor:'next'});await x.load();assert.equal(x.c.getPageState(x.scope).hasMore,true)});
test('complete catalog can still show a refresh failure without inventing pages',async()=>{const x=setup({complete:true});await x.load();assert.equal(x.c.getPageState(x.scope).hasMore,false);assert.equal(x.win.__codexCatalogSyncNotice.failed,true)});
test('backoff receipt keeps failure; successful retry clears it',async()=>{const x=setup();await x.load();await x.c.retryFailedSync();assert.equal(x.win.__codexCatalogSyncNotice.failed,true);assert.equal(x.win.__codexCatalogSyncNotice.retrying,false);x.recover();await x.c.retryFailedSync();assert.equal(x.win.__codexCatalogSyncNotice.failed,false);assert.equal(x.syncs(),2)});
test('retry is single-flight and transport failure remains visible',async()=>{const x=setup();await x.load();let reject;x.service.requestSync=()=>new Promise((_,r)=>reject=r);const p=x.c.retryFailedSync();assert.equal(x.win.__codexCatalogSyncNotice.retrying,true);await x.c.retryFailedSync();reject(Error('offline'));await p;assert.equal(x.win.__codexCatalogSyncNotice.failed,true);assert.equal(x.win.__codexCatalogSyncNotice.retrying,false)});
test('disposed catalog clears its own notice but never a replacement owner',()=>{const x=setup();x.c.dispose();assert.equal(x.win.__codexCatalogSyncNotice,null);const y=setup();const other={owner:{},failed:true};y.win.__codexCatalogSyncNotice=other;y.c.dispose();assert.equal(y.win.__codexCatalogSyncNotice,other)});
