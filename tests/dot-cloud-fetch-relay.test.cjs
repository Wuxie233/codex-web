const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {allowedPath,configuredThread,startBrowserFetch}=require('../scripts/dot-cloud-fetch-relay.cjs');
const thread='existing-thread-1';
const origin='https://codex-cloud-backend.chatgpt.com';
test('cloud policy preserves read queries but excludes aliases, different threads, and hosts',()=>{
 for(const path of [`/v1/threads/${thread}`,`/v2/threads/${thread}/turns?cursor=a%2Fb&limit=20`,`/v2/threads/${thread}/items`, '/v2/models','/v2/collaboration-modes','/v2/account/rate-limits','/v2/realtime/voices'])assert.equal(allowedPath(path,thread),true,path);
 for(const path of ['/v1/threads/other',`/v1/threads/${thread}/`,`/v1/threads/${thread}%2f`, `/v1/threads/x/../${thread}`, `/v1/threads/${thread}#x`, '/v2/%6dodels', '//evil/v2/models',origin+'/v2/models','/v2/models\\x','/v2/models\n','/v2/models?x=\r','/v2/threads/'+thread+'/resume'])assert.equal(allowedPath(path,thread),false,path);
 assert.throws(()=>configuredThread(''));assert.throws(()=>configuredThread('../x'));
});
test('serialized browser boundary rejects methods, wrong document, credentials and cross origin',()=>{
 const invoke=(p,href=origin+'/v1/threads/'+thread)=>vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify(p)})`,{URL,location:{origin,href}});
 const p={thread,method:'GET',url:origin+'/v2/models'};
 for(const patch of [{method:'POST'},{method:'HEAD'},{url:'https://chatgpt.com/v2/models'},{url:'https://user@codex-cloud-backend.chatgpt.com/v2/models'},{url:origin+'/v1/threads/other'},{url:origin+'/v2/models#x'}])assert.throws(()=>invoke({...p,...patch}),/Unsupported cloud browser read/);
 assert.throws(()=>invoke(p,origin+'/v2/models'),/Unsupported cloud browser read/);
});
test('valid browser read refuses redirects and finishes after response acknowledgment',async()=>{
 const calls=[],events=[];const context={URL,AbortController,Date,setInterval,clearInterval,location:{origin,href:origin+'/v1/threads/'+thread},registry:new Map(),fetch:async(url,options)=>{calls.push({url,options});return {status:200,headers:[],body:null};}};
 context.binding=text=>{const event=JSON.parse(text);events.push(event);if(event.type==='headers')queueMicrotask(()=>context.registry.get(event.id).ack());};
 vm.runInNewContext(`(${startBrowserFetch.toString()})(${JSON.stringify({thread,method:'GET',url:origin+'/v2/models',headers:{},id:'one',registry:'registry',binding:'binding',leaseMs:1000,redirect:'follow'})})`,context);
 await new Promise(r=>setTimeout(r,20));
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.method,'GET');assert.equal('body' in calls[0].options,false);assert.deepEqual(events.map(x=>x.type),['headers','done']);assert.equal(context.registry.size,0);
});
