const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('scratch/asar/.vite/build/main-C5K7o1Hr.js', 'utf8');
function fixture() {
  const titles = [], threads = new Map();
  const host = { async updateThreadTitle(id, title) { titles.push(title); threads.set(id, { name: title }); }, async startTurn() { return { turn: { id: 'turn' } }; }, async readThread(id) { return threads.get(id); } };
  const ctx = vm.createContext({ connection: () => host, fetch: {}, console, yPe: class { async generateTitle() { return { title: '修复创建确认与任务标题' }; } } });
  const begin = source.indexOf('function codexWebCreationTitle(');
  if (begin >= 0) vm.runInContext(source.slice(begin, source.indexOf('globalThis.__codexThreadCreations.registerAdapter({', begin)), ctx);
  const start = source.indexOf('bindThread: async (plan, threadId) => {');
  const end = source.indexOf('\n        setGoal:', start);
  vm.runInContext('globalThis.adapter = {' + source.slice(start, end) + '};', ctx);
  return { ctx, titles, threads };
}
test('server creation assigns a prompt title before the first turn', async () => {
  const { ctx, titles } = fixture();
  await ctx.adapter.bindThread({ turnParams: { input: [{ type: 'text', text: '修复任务创建失败' }] } }, 'thread');
  assert.equal(titles[0], '修复任务创建失败');
});
test('title uses actual request rather than attachment boilerplate', async () => {
  const { ctx, titles } = fixture();
  await ctx.adapter.bindThread({ turnParams: { input: [{ type: 'text', text: '# Files mentioned by the user:\n## screenshot.png: /tmp/screenshot.png\n\n## My request:\n最近怎么老有这种问题 去诊断修复上线' }] } }, 'thread');
  assert.equal(titles[0], '最近怎么老有这种问题 去诊断修复上线');
});
test('explicit task titles are preserved', async () => {
  const { ctx, titles } = fixture();
  await ctx.adapter.bindThread({ title: '用户指定标题' }, 'thread');
  assert.deepEqual(titles, ['用户指定标题']);
});
test('generated title replaces only the provisional title', async () => {
  const { ctx, titles } = fixture();
  const plan = { turnParams: { input: [{ type: 'text', text: '修复创建' }] } };
  await ctx.adapter.bindThread(plan, 'thread');
  await ctx.codexWebGenerateCreationTitle(plan, 'thread', {});
  assert.deepEqual(titles, ['修复创建', '修复创建确认与任务标题']);
});
test('generation preserves a manual rename', async () => {
  const { ctx, titles, threads } = fixture();
  const plan = { turnParams: { input: [{ type: 'text', text: '修复创建' }] } };
  await ctx.adapter.bindThread(plan, 'thread');
  threads.set('thread', { name: '手动改名' });
  await ctx.codexWebGenerateCreationTitle(plan, 'thread', {});
  assert.deepEqual(titles, ['修复创建']);
});
test('image-only input has a useful title without a filesystem path', async () => {
  const { ctx, titles } = fixture();
  await ctx.adapter.bindThread({ turnParams: { input: [{ type: 'localImage', path: '/tmp/image.png' }] } }, 'thread');
  assert.equal(titles[0], '新任务');
});
