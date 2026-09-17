const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const patch=fs.readFileSync('patches/workspace-directory-groups.patch','utf8');
const source=patch.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1)).join('\n');
const fn=source.slice(source.indexOf('function codexWebDirectoryGroups'),source.indexOf('function CodexWebDirectoryThreads'));
const group=vm.runInNewContext(fn+';codexWebDirectoryGroups');
const key=id=>'codex:thread:local:'+id;
const task=(id,cwd,hostId='local')=>({key:'local:'+id,kind:'local',conversation:{cwd,hostId}});
test('preserves every key and within-directory order',()=>{
 const input=[key('1'),key('2'),key('3'),key('4')];
 const result=JSON.parse(JSON.stringify(group(input,[task('1','/a'),task('2','/b'),task('3','/a')])));
 assert.deepEqual(result.map(g=>g.keys),[[key('1'),key('3')],[key('2')],[key('4')]]);
});
test('separates exact paths, trailing spaces and hosts',()=>{
 const result=group([key('1'),key('2'),key('3')],[task('1','/a'),task('2','/a '),task('3','/a','remote')]);
 assert.equal(result.length,3);
});
test('late metadata moves unknown items into the correct directory',()=>{
 assert.equal(group([key('1')],[])[0].path,'');
 assert.equal(group([key('1')],[task('1','/a')])[0].path,'/a');
});
