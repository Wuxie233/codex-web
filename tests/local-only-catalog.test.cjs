const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=fs.readFileSync('scratch/asar/webview/assets/app-initial-236e1501144c.js','utf8');
const main=fs.readFileSync('scratch/asar/.vite/build/main-C5K7o1Hr.js','utf8');
test('ChatGPT capabilities and inherited cloud tools are disabled before policy reads',()=>{
 const start=ui.indexOf('          let n = FTa[e.name];');
 const end=ui.indexOf('          let r = [',start);
 const check=vm.runInNewContext('(e => {'+ui.slice(start,end)+'return {isCapable:true};})',{FTa:{cloud:{accessPolicies:['chatgpt']},child:{accessPolicies:['chatgpt','cloud-automations']},local:{accessPolicies:['local-automations']}},NTa:()=>true});
 assert.equal(check({name:'cloud'}).isCapable,false);
 assert.equal(check({name:'child'}).isCapable,false);
 assert.equal(check({name:'local'}).isCapable,true);
});
test('old clients cannot enable cloud catalog; local population still opens and closes',async()=>{
 const start=main.indexOf('    async setSourceEnabled(e, t) {');
 const end=main.indexOf('    async notifyThread(',start);
 const C=vm.runInNewContext('(class {'+main.slice(start,end)+'#i(){} #r(){this.cloudAcquired=true;}})');
 const c=new C();let opened=0,closed=0;
 c.manager={acquirePopulation(){opened++;return {dispose(){closed++}}}};
 c.principal={async getPrincipal(){throw Error('Cloud principal must not be requested')}};
 await c.setSourceEnabled({kind:'chatgpt',accountId:'a'},true);
 assert.equal(c.cloudAcquired,undefined);
 await c.setSourceEnabled({kind:'app-server'},true);
 await c.setSourceEnabled({kind:'app-server'},true);
 await c.setSourceEnabled({kind:'app-server'},false);
 assert.equal(opened,1);assert.equal(closed,1);
});
