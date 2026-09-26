const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scratch/asar/webview/assets/app-initial-236e1501144c.js'), 'utf8');
const start = source.indexOf('function sYn({');
const end = source.indexOf('\nfunction cYn(', start);
assert(start >= 0 && end > start, 'Review thread initial input after Desktop updates');
function input(toolName, modern = true) {
  const ctx = vm.createContext({ Ig: () => modern, oYn: ({ sourceThreadId, input }) => `${sourceThreadId}: ${input}` });
  vm.runInContext(source.slice(start, end), ctx);
  return ctx.sYn({ appServerVersion: 'current', sourceThreadId: 'parent', input: 'hello', toolName });
}
test('explicit create_thread emits a user message so the task is listable', () => {
  const result = input('create_thread');
  assert.equal(result.input[0].type, 'text');
  assert.equal(result.input[0].text, 'parent: hello');
  assert.equal(result.toolOutput, undefined);
});
test('other modern tool handoffs retain tool-output semantics', () => {
  const result = input('fork_thread');
  assert.equal(result.input.length, 0);
  assert.equal(result.toolOutput.output, 'parent: hello');
});
test('older servers retain text input', () => {
  assert.equal(input('create_thread', false).input[0].text, 'parent: hello');
});
