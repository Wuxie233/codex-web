const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const key = "codex-web:statsig-bootstrap:v1";
function harness(compressed = false) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("src/browser/bootstrap-cache.ts", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports,
      ...(compressed
        ? { CompressionStream, DecompressionStream, Response, Blob, btoa, atob }
        : {}),
    },
  );
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  return { run: exports.cachedStatsigBootstrap, storage, data };
}
const value = (id) => ({
  user: { userID: id },
  statsigPayload: JSON.stringify({ user: { userID: id }, feature_gates: {} }),
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("cold bootstrap loads; warm reload resolves before network and revalidates", async () => {
  const { run, storage } = harness();
  const first = value("a");
  assert.equal(
    await run(
      "account-a/version1/en",
      async () => first,
      storage,
      () => 100,
    ),
    first,
  );
  let resolve,
    calls = 0;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const warm = await run(
    "account-a/version1/en",
    () => {
      calls++;
      return pending;
    },
    storage,
    () => 200,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(warm)), first);
  assert.equal(calls, 1);
  resolve(value("updated"));
  await tick();
  assert.equal(JSON.parse(storage.getItem(key)).value.user.userID, "updated");
});
test("account, version and locale changes never reuse previous evaluations", async () => {
  for (const next of ["b/v1/en", "a/v2/en", "a/v1/zh"]) {
    const { run, storage } = harness();
    await run(
      "a/v1/en",
      async () => value("old"),
      storage,
      () => 100,
    );
    assert.equal(
      (
        await run(
          next,
          async () => value("new"),
          storage,
          () => 200,
        )
      ).user.userID,
      "new",
    );
  }
});
test("expired, future-dated, malformed and inconsistent entries require network", async () => {
  for (const saved of [
    { identity: "a", savedAt: 100, value: value("old") },
    { identity: "a", savedAt: 400000, value: value("old") },
    {
      identity: "a",
      savedAt: 300000,
      value: { user: {}, statsigPayload: "invalid" },
    },
    {
      identity: "a",
      savedAt: 300000,
      value: { ...value("old"), user: { userID: "other" } },
    },
    null,
  ]) {
    const { run, storage } = harness();
    storage.setItem(key, JSON.stringify(saved));
    assert.equal(
      (
        await run(
          "a",
          async () => value("new"),
          storage,
          () => 300100,
        )
      ).user.userID,
      "new",
    );
  }
});
test("network failures retain native rejection; warm refresh failure retains valid cache", async () => {
  const { run, storage } = harness();
  await assert.rejects(
    run(
      "a",
      async () => {
        throw Error("offline");
      },
      storage,
    ),
    /offline/,
  );
  await run(
    "a",
    async () => value("a"),
    storage,
    () => 100,
  );
  let reject;
  await run(
    "a",
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
    storage,
    () => 200,
  );
  await run(
    "b",
    async () => value("b"),
    storage,
    () => 200,
  );
  reject(Error("old request failed"));
  await tick();
  assert.equal(JSON.parse(storage.getItem(key)).identity, "b");
  await run(
    "b",
    async () => {
      throw Error("expired session");
    },
    storage,
    () => 300,
  );
  await tick();
  assert.equal(JSON.parse(storage.getItem(key)).identity, "b");
  assert.equal(JSON.parse(storage.getItem(key)).savedAt, 200);
});
test("disabled or full storage leaves successful network bootstrap usable", async () => {
  const { run } = harness();
  const blocked = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("full");
    },
    removeItem() {},
  };
  assert.equal(
    (await run("a", async () => value("a"), blocked)).user.userID,
    "a",
  );
  assert.equal((await run("a", async () => value("a"))).user.userID, "a");
});

test("realistic oversized bootstrap fits storage and warm refresh does not wait for network", async () => {
  const { run, storage } = harness(true);
  const large = {
    ...value("a"),
    statsigPayload: JSON.stringify({
      user: { userID: "a" },
      feature_gates: "x".repeat(8 * 1024 * 1024),
    }),
  };
  const limited = {
    ...storage,
    setItem(k, v) {
      assert.ok(v.length < 5 * 1024 * 1024);
      storage.setItem(k, v);
    },
  };
  await run(
    "a",
    async () => large,
    limited,
    () => 100,
  );
  assert.ok(storage.getItem(key).startsWith("gzip:"));
  const warm = await run(
    "a",
    () => new Promise(() => {}),
    limited,
    () => 200,
  );
  assert.equal(warm.statsigPayload, large.statsigPayload);
});

test("a late old-account refresh cannot overwrite the newest successful account", async () => {
  const { run, storage } = harness();
  await run(
    "a",
    async () => value("a"),
    storage,
    () => 100,
  );
  let resolve;
  await run(
    "a",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    storage,
    () => 200,
  );
  await run(
    "b",
    async () => value("b"),
    storage,
    () => 300,
  );
  resolve(value("late-a"));
  await tick();
  assert.equal(JSON.parse(storage.getItem(key)).identity, "b");
});

test("authorization rejection evicts cached evaluations, including wrapped HTTP errors", async () => {
  for (const status of [401, 403]) {
    const { run, storage } = harness();
    await run(
      "a",
      async () => value("a"),
      storage,
      () => 100,
    );
    await run(
      "a",
      async () => {
        throw new Error("native bootstrap failed", { cause: { status } });
      },
      storage,
      () => 200,
    );
    await tick();
    assert.equal(storage.getItem(key), null);
  }
});
