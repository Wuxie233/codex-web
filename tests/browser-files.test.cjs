const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function harness(fetch) {
  const events = [];
  const exports = {};
  const context = vm.createContext({
    exports,
    require: () => ({
      isRecord: (x) => x && typeof x === "object",
      emitRendererEvent: (...args) => events.push(args),
    }),
    fetch,
    FormData,
    File,
    URL,
    AbortController,
    console,
    window: { location: { href: "https://example.test/" } },
  });
  vm.runInContext(
    ts.transpileModule(fs.readFileSync("src/browser/files.ts", "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return { api: exports, events };
}
const response = (name) => ({
  ok: true,
  json: async () => ({
    files: [{ label: name, path: "/tmp/" + name, fsPath: "/tmp/" + name }],
  }),
});
test("uploads a selection above 32 MiB in bounded individual requests and preserves order", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const { api } = harness(async (url, init) => {
    calls++;
    peak = Math.max(peak, ++active);
    const files = init.body.getAll("files");
    assert.equal(files.length, 1);
    await new Promise((r) => setTimeout(r, files[0].name === "a.png" ? 20 : 2));
    active--;
    return response(files[0].name);
  });
  const result = await api.uploadFiles([
    new File([new Uint8Array(17 * 1024 * 1024)], "a.png"),
    new File([new Uint8Array(17 * 1024 * 1024)], "b.png"),
    new File([], "empty.txt"),
  ]);
  assert.deepEqual(
    Array.from(result, (x) => x.label),
    ["a.png", "b.png", "empty.txt"],
  );
  assert.equal(calls, 3);
  assert.equal(peak, 2);
});
test("failure aborts in-flight upload and never starts the remaining selection", async () => {
  let calls = 0,
    aborted = false;
  const { api } = harness(async (url, { signal }) => {
    if (++calls === 1) {
      await new Promise((r) => setImmediate(r));
      return { ok: false, status: 413 };
    }
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Error("aborted"));
      }),
    );
  });
  await assert.rejects(
    api.uploadFiles(["a", "b", "c"].map((x) => new File(["x"], x))),
    /413/,
  );
  assert.equal(calls, 2);
  assert.equal(aborted, true);
});
test("validates the whole selection before uploading and accepts empty selection", async () => {
  let calls = 0;
  const { api } = harness(async () => {
    calls++;
    return response("x");
  });
  await assert.rejects(
    api.uploadFiles([
      { name: "small", size: 1 },
      { name: "large", size: 129 * 1024 * 1024 },
    ]),
    /128 MiB/,
  );
  assert.equal((await api.uploadFiles([])).length, 0);
  assert.equal(calls, 0);
});
test("malformed success cannot silently lose an attachment", async () => {
  const { api } = harness(async () => ({
    ok: true,
    json: async () => ({ files: [] }),
  }));
  await assert.rejects(
    api.uploadFiles([new File(["x"], "x")]),
    /invalid upload response/,
  );
});
