const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
test("delivery compaction preserves legal notices and observable execution", async () => {
  const { compactModule } = await import("../scripts/delivery-module.mjs");
  const source = `/*! Example MIT license */
 const output = [];
 function retainedName(value) { output.push(value); }
 retainedName("two  spaces");
 retainedName(/a  b/.test("a  b"));
 globalThis.result = [output, retainedName.name];
 `;
  const compact = await compactModule("example.js", source);
  assert(compact.includes("Example MIT license"));
  const before = {},
    after = {};
  vm.runInNewContext(source, before);
  vm.runInNewContext(compact, after);
  assert.equal(JSON.stringify(after.result), JSON.stringify(before.result));
  assert(compact.length < source.length);
});
test("invalid input fails the build", async () => {
  const { compactModule } = await import("../scripts/delivery-module.mjs");
  await assert.rejects(compactModule("bad.js", "export const = ;"));
});
