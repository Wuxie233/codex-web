const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  QuotaRecovery,
  CONTINUATION,
} = require("../src/server/quota-recovery.js");
const quota = { codexErrorInfo: "usageLimitExceeded" };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "entries.json");
  const recovery = new QuotaRecovery(file),
    threads = new Map(),
    sent = [],
    resumed = [];
  const archived = new Set();
  const adapter = {
    async readThread(id) {
      return threads.get(id) ?? null;
    },
    async listThreads(params) {
      return {
        data: [...threads.values()].filter(
          (x) => archived.has(x.id) === params.archived,
        ),
        nextCursor: null,
      };
    },
    async resumeThread(id) {
      resumed.push(id);
      threads.get(id).status = { type: "idle" };
    },
    async startTurn(params, beforeSend) {
      beforeSend();
      sent.push(params);
      return { turn: { id: "continued" } };
    },
  };
  recovery.registerHost("local", adapter);
  function fail(id = "one", turnId = "failed-one") {
    threads.set(id, {
      id,
      name: `Task ${id}`,
      status: { type: "idle" },
      turns: [{ id: turnId, status: "failed", error: quota, items: [] }],
    });
    recovery.observe("local", {
      method: "turn/completed",
      params: { threadId: id, turn: threads.get(id).turns[0] },
    });
    return recovery.snapshot().entries.find((e) => e.threadId === id).id;
  }
  return { recovery, threads, sent, resumed, archived, adapter, file, fail };
}
test("only terminal quota failures qualify and duplicate events remain one entry", (t) => {
  const f = fixture(t);
  for (const [willRetry, error] of [
    [true, quota],
    [false, { codexErrorInfo: "networkError" }],
  ])
    f.recovery.observe("local", {
      method: "error",
      params: { threadId: "one", turnId: "failed-one", willRetry, error },
    });
  assert.equal(f.recovery.snapshot().entries.length, 0);
  const id = f.fail();
  f.fail();
  f.recovery.observe("local", {
    method: "error",
    params: {
      threadId: "one",
      turnId: "failed-one",
      willRetry: false,
      error: quota,
    },
  });
  assert.deepEqual(
    f.recovery.snapshot().entries.map((e) => e.id),
    [id],
  );
});
test("new user turn and archive notifications invalidate pending continuations", (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.observe("local", {
    method: "turn/started",
    params: { threadId: "one", turn: { id: "new" } },
  });
  assert.equal(f.recovery.snapshot().entries[0].status, "skipped");
  f.fail("two", "failed-two");
  f.recovery.observe("local", {
    method: "thread/archived",
    params: { threadId: "two" },
  });
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.threadId === "two").status,
    "skipped",
  );
});
test("concurrent requests and duplicate selections dispatch exactly once with sticky settings", async (t) => {
  const f = fixture(t),
    id = f.fail();
  await Promise.all([f.recovery.resume([id, id]), f.recovery.resume([id])]);
  await f.recovery.resume([id]);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Object.keys(f.sent[0]).sort(), [
    "clientUserMessageId",
    "input",
    "threadId",
  ]);
  assert.equal(f.sent[0].input[0].text, CONTINUATION);
  assert.equal(f.recovery.snapshot().entries[0].status, "resumed");
  assert.equal(
    new QuotaRecovery(f.file).snapshot().entries[0].status,
    "resumed",
  );
});
test("live archived, running, changed and interrupted tasks are never sent", async (t) => {
  const f = fixture(t),
    ids = ["archived", "active", "changed", "stopped", "child"].map((id, i) =>
      f.fail(id, `fail-${i}`),
    );
  f.archived.add("archived");
  f.threads.get("child").canAcceptDirectInput = false;
  f.threads.get("active").status = { type: "active" };
  f.threads.get("changed").turns.push({ id: "later", status: "completed" });
  f.threads.get("stopped").turns[0].status = "interrupted";
  await f.recovery.resume(ids);
  assert.equal(f.sent.length, 0);
  assert.ok(f.recovery.snapshot().entries.every((e) => e.status === "skipped"));
});
test("unloaded task resumes and rechecks before starting", async (t) => {
  const f = fixture(t),
    id = f.fail();
  f.threads.get("one").status = { type: "notLoaded" };
  await f.recovery.resume([id]);
  assert.deepEqual(f.resumed, ["one"]);
  assert.equal(f.sent.length, 1);
});
test("state change while transport becomes ready cancels before dispatch", async (t) => {
  const f = fixture(t),
    id = f.fail();
  f.adapter.startTurn = async (_, beforeSend) => {
    f.recovery.observe("local", {
      method: "turn/started",
      params: { threadId: "one", turn: { id: "manual" } },
    });
    beforeSend();
    f.sent.push("must not send");
  };
  await f.recovery.resume([id]);
  assert.equal(f.sent.length, 0);
});
test("ambiguous send never retries, survives restart, then reconciles by client message id", async (t) => {
  const f = fixture(t),
    id = f.fail();
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    throw Error("connection lost after write");
  };
  await f.recovery.resume([id]);
  await f.recovery.resume([id]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.recovery.snapshot().entries[0].status, "unknown");
  const reloaded = new QuotaRecovery(f.file);
  reloaded.registerHost("local", f.adapter);
  await reloaded.resume([id]);
  assert.equal(f.sent.length, 1);
  f.threads
    .get("one")
    .turns.push({
      id: "continued",
      status: "inProgress",
      items: [{ type: "userMessage", id: f.sent[0].clientUserMessageId }],
    });
  await reloaded.list();
  assert.equal(reloaded.snapshot().entries[0].status, "resumed");
});
test("crash during persisted sending is loaded as unknown", (t) => {
  const f = fixture(t);
  f.fail();
  fs.writeFileSync(
    f.file,
    JSON.stringify(
      f.recovery.snapshot().entries.map((e) => ({ ...e, status: "sending" })),
    ),
  );
  assert.equal(
    new QuotaRecovery(f.file).snapshot().entries[0].status,
    "unknown",
  );
});
test("new quota failure pauses remaining selected tasks", async (t) => {
  const f = fixture(t),
    a = f.fail("a", "fa"),
    b = f.fail("b", "fb");
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    f.recovery.observe("local", {
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: "new-quota", status: "failed", error: quota },
      },
    });
    return { turn: { id: "new-quota" } };
  };
  await f.recovery.resume([a, b]);
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.id === b).status,
    "pending",
  );
});
test("history discovery finds only latest quota failures and preserves deduplication", async (t) => {
  const f = fixture(t);
  f.threads.set("old", {
    id: "old",
    name: "Recovered title",
    status: { type: "idle" },
    turns: [{ id: "old-failure", status: "failed", error: quota }],
  });
  f.threads.set("done", {
    id: "done",
    turns: [
      { id: "failure", status: "failed", error: quota },
      { id: "done", status: "completed" },
    ],
  });
  await f.recovery.list();
  await f.recovery.list();
  const entries = f.recovery.snapshot().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Recovered title");
});
test("timed out transport preparation cannot dispatch after the request expires", async (t) => {
  const f = fixture(t),
    id = f.fail();
  let lateBeforeSend;
  f.adapter.startTurn = async (_, beforeSend) => {
    lateBeforeSend = beforeSend;
    return new Promise(() => {});
  };
  const realSetTimeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 45000 ? 5 : delay, ...args),
  );
  await f.recovery.resume([id]);
  assert.equal(f.recovery.snapshot().entries[0].status, "failed");
  assert.throws(() => lateBeforeSend(), /已变化|超时|失效|结束/);
  assert.equal(f.recovery.snapshot().entries[0].status, "failed");
});

test("slow history reads return a scanning snapshot without blocking available tasks", async (t) => {
  const f = fixture(t);
  f.fail();
  let release;
  const original = f.adapter.listThreads;
  f.adapter.listThreads = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const realSetTimeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 1000 ? 5 : delay, ...args),
  );
  const result = await f.recovery.list();
  assert.equal(result.scanning, true);
  assert.equal(result.entries.length, 1);
  release(await original({ archived: false }));
  await f.recovery.list();
  assert.equal(f.recovery.snapshot().scanning, false);
});
test("unavailable host does not hide known records or another host's failures", async (t) => {
  const f = fixture(t);
  f.fail();
  f.adapter.listThreads = async () => {
    throw Error("host disconnected");
  };
  const thread = {
    id: "remote",
    turns: [{ id: "remote-fail", status: "failed", error: quota }],
  };
  f.recovery.registerHost("remote", {
    ...f.adapter,
    listThreads: async () => ({ data: [thread] }),
    readThread: async () => thread,
  });
  const result = await f.recovery.list();
  assert.equal(result.entries.length, 2);
  assert.equal(result.scanning, false);
  assert.match(result.scanError, /部分任务/);
});

test("poll reads the completed snapshot without restarting history scans", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const original = f.adapter.listThreads;
  f.adapter.listThreads = async (params) => { reads++; return original(params); };
  await f.recovery.list();
  await f.recovery.list(false);
  await f.recovery.list(false);
  assert.equal(reads, 1);
  assert.equal(f.recovery.snapshot().scanning, false);
});
