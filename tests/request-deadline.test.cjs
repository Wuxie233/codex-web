const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rebaseRequestDeadlines:rebase}=require('../src/server/request-deadline.js');
const channel='codex_desktop:message-from-view';
for (const skew of [-86400000,0,86400000]) test(`clock skew ${skew} preserves remaining queue budget`,()=>{
 const now=100000000, sent=now+skew;
 for (const type of ['mcp-request','thread-prewarm-start']) {
  const req={type,timeoutMs:30000,expiresAtMs:sent+25000,request:{method:'thread/start'}};
  const [out]=rebase(channel,[req],sent,now);
  assert.equal(out.expiresAtMs,now+25000);assert.equal(req.expiresAtMs,sent+25000);
  assert.equal(out.request,req.request);
 }
});
test('expired browser queue stays expired; excessive deadline cannot extend timeout',()=>{
 for(const [deadline,expected] of [[99,1000],[100000,31000]]) assert.equal(rebase(channel,[{type:'mcp-request',timeoutMs:30000,expiresAtMs:deadline}],100,1000)[0].expiresAtMs,expected);
});
test('cached clients receive a bounded server-clock deadline',()=>{
 assert.equal(rebase(channel,[{type:'mcp-request',timeoutMs:30000,expiresAtMs:1}],undefined,1000)[0].expiresAtMs,31000);
});
test('non-RPC content and untimed requests are unchanged',()=>{
 const req={type:'turn/start',timeoutMs:30000,expiresAtMs:1};
 assert.equal(rebase(channel,[req],100,1000)[0],req);
 assert.equal(rebase('other',[req],100,1000)[0],req);
 const untimed={type:'mcp-request'};assert.equal(rebase(channel,[untimed],100,1000)[0],untimed);
});
