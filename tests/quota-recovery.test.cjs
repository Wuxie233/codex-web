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
  f.threads.get("one").turns.push({
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
test("refresh reveals an unresolved unknown send without replaying it", async (t) => {
  const f = fixture(t),
    id = f.fail();
  const readThread = f.adapter.readThread;
  let firstRead = true;
  f.adapter.readThread = async (threadId) => {
    if (firstRead) {
      firstRead = false;
      return null;
    }
    return readThread(threadId);
  };
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    throw Error("connection lost after write");
  };
  await f.recovery.resume([id]);
  assert.equal(f.recovery.snapshot().entries[0].status, "unknown");
  assert.equal(f.recovery.snapshot().entries[0].resolved, undefined);

  const reloaded = new QuotaRecovery(f.file);
  t.after(() => reloaded.dispose());
  reloaded.registerHost("local", f.adapter);
  const refreshed = await reloaded.list();
  assert.equal(refreshed.entries.length, 1);
  assert.equal(refreshed.entries[0].id, id);
  assert.equal(refreshed.entries[0].status, "unknown");
  assert.equal(refreshed.entries[0].resolved, true);
  await reloaded.resume([id]);
  assert.equal(f.sent.length, 1);
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
  f.adapter.listThreads = async (params) => {
    reads++;
    return original(params);
  };
  await f.recovery.list();
  await f.recovery.list(false);
  await f.recovery.list(false);
  assert.equal(reads, 1);
  assert.equal(f.recovery.snapshot().scanning, false);
});

test("nested quota failures collapse to the root and continue a completed parent once", async (t) => {
  const f = fixture(t);
  f.threads.set("root", {
    id: "root",
    name: "Root task",
    status: { type: "idle" },
    turns: [{ id: "root-turn", status: "completed" }],
  });
  f.threads.set("middle", { id: "middle", parentThreadId: "root" });
  f.fail("child");
  f.threads.get("child").parentThreadId = "middle";
  f.fail("sibling");
  f.threads.get("sibling").source = {
    subagent: { thread_spawn: { parent_thread_id: "root" } },
  };
  const listed = await f.recovery.list();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].threadId, "root");
  assert.equal(listed.entries[0].title, "Root task");
  await f.recovery.resume(listed.entries.map((e) => e.id));
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["root"],
  );
});

test("an ordinary fork stays independent and unknown subagent ancestry is hidden", async (t) => {
  const f = fixture(t);
  f.fail("fork");
  f.threads.get("fork").forkedFromId = "unrelated";
  f.fail("unresolved");
  f.threads.get("unresolved").source = { subagent: "review" };
  f.fail("cycle");
  f.threads.get("cycle").parentThreadId = "cycle";
  const listed = await f.recovery.list();
  assert.deepEqual(
    listed.entries.map((e) => e.threadId),
    ["fork"],
  );
  await f.recovery.resume(f.recovery.snapshot().entries.map((e) => e.id));
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["fork"],
  );
});

test("all recovery list requests avoid slow rollout backfill", async (t) => {
  const f = fixture(t);
  f.fail();
  const original = f.adapter.listThreads;
  f.adapter.listThreads = async (params) => {
    assert.equal(params.useStateDbOnly, true);
    return original(params);
  };
  const listed = await f.recovery.list();
  await f.recovery.resume(listed.entries.map((e) => e.id));
  assert.equal(f.sent.length, 1);
});

test("late child state changes cancel a parent continuation before dispatch", async (t) => {
  const f = fixture(t);
  f.threads.set("root", {
    id: "root",
    status: { type: "idle" },
    turns: [{ id: "root-turn", status: "completed" }],
  });
  f.fail("child");
  f.threads.get("child").parentThreadId = "root";
  f.adapter.startTurn = async (_params, beforeSend) => {
    f.recovery.observe("local", {
      method: "turn/started",
      params: { threadId: "child", turn: { id: "new" } },
    });
    beforeSend();
    assert.fail("must not dispatch");
  };
  const listed = await f.recovery.list();
  const result = await f.recovery.resume(listed.entries.map((e) => e.id));
  assert.equal(result.entries[0].status, "failed");
  assert.equal(f.sent.length, 0);
});

test("parent metadata updates do not count as continuation but a newer turn does", async (t) => {
  for (const newerTurn of [false, true]) {
    const f = fixture(t);
    f.threads.set("root", {
      id: "root",
      updatedAt: Date.now() / 1000 + 10,
      status: { type: "idle" },
      turns: [
        {
          id: "root-turn",
          status: "completed",
          startedAt: Date.now() / 1000 + (newerTurn ? 10 : -100),
        },
      ],
    });
    f.fail("child");
    f.threads.get("child").parentThreadId = "root";
    const listed = await f.recovery.list();
    assert.equal(listed.entries[0].status, newerTurn ? "skipped" : "pending");
  }
});

const principal = (id) => ({ accountId: id, userId: `user-${id}` });
function fastRecovery(t) {
  const real = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
    real(callback, delay === 1500 ? 0 : delay, ...args),
  );
}

test("auto settings default off, persist separately from legacy entries and reject invalid values", (t) => {
  const f = fixture(t);
  f.fail();
  assert.equal(f.recovery.snapshot().autoResumeOnAccountSwitch, false);
  assert.equal(f.recovery.setAutoResume(true).autoResumeOnAccountSwitch, true);
  assert.throws(() => f.recovery.setAutoResume("true"), /设置/);
  const reloaded = new QuotaRecovery(f.file);
  assert.equal(reloaded.snapshot().entries.length, 1);
  assert.equal(reloaded.snapshot().autoResumeOnAccountSwitch, true);
  fs.mkdirSync(f.file + ".settings.json.tmp");
  assert.throws(() => f.recovery.setAutoResume(false));
  assert.equal(f.recovery.snapshot().autoResumeOnAccountSwitch, true);
});

test("account baseline, refresh, disabled switches and enabling alone never dispatch", async (t) => {
  const f = fixture(t);
  f.fail();
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("b"));
  await f.recovery.accountChanged("local", null);
  await f.recovery.accountChanged("local", principal("b"));
  assert.equal(f.sent.length, 0);
});

test("a usable new principal resumes once without any list or opened dialog", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", null);
  await Promise.all([
    f.recovery.accountChanged("local", principal("b")),
    f.recovery.accountChanged("local", principal("b")),
  ]);
  assert.equal(f.sent.length, 1);
  await f.recovery.accountChanged("local", principal("c"));
  assert.equal(f.sent.length, 1);
});

test("automatic history discovery continues past page 100 without relying on a manual scan", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    id: `done-${i}`,
    turns: [],
  }));
  const last = {
    id: "unopened",
    status: { type: "notLoaded" },
    turns: [{ id: "quota", status: "failed", error: quota }],
  };
  for (const thread of [...firstPage, last]) f.threads.set(thread.id, thread);
  const cursors = [];
  f.adapter.listThreads = async (params) => {
    if (params.archived) return { data: [] };
    cursors.push(params.cursor);
    return params.cursor
      ? { data: [last] }
      : { data: firstPage, nextCursor: "page-2" };
  };
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(f.resumed, ["unopened"]);
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["unopened"],
  );
});

test("disabling automatic recovery during transport preparation prevents dispatch", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume(true);
  f.adapter.startTurn = async (_params, beforeSend) => {
    f.recovery.setAutoResume(false);
    beforeSend();
    assert.fail("disabled automation dispatched");
  };
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  assert.equal(f.sent.length, 0);
});

test("automatic recovery waits for manual sends and cannot duplicate the same entry", async (t) => {
  fastRecovery(t);
  const f = fixture(t),
    id = f.fail();
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await Promise.all([
    f.recovery.resume([id]),
    f.recovery.accountChanged("local", principal("b")),
  ]);
  assert.equal(f.sent.length, 1);
});

test("an automatic batch stops when the new account also hits quota", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.fail("a", "fa");
  f.fail("b", "fb");
  const start = f.adapter.startTurn;
  f.adapter.startTurn = async (...args) => {
    const result = await start(...args);
    f.recovery.observe("local", {
      method: "turn/completed",
      params: {
        threadId: args[0].threadId,
        turn: { id: "new-quota", status: "failed", error: quota },
      },
    });
    return result;
  };
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.recovery.snapshot().entries.find((x) => x.threadId === "b").status,
    "pending",
  );
});

test("unknown, manually stopped and running entries are excluded from automatic continuation", async (t) => {
  const f = fixture(t);
  const unknown = f.fail("unknown");
  f.adapter.startTurn = async (_params, beforeSend) => {
    beforeSend();
    throw Error("unknown delivery");
  };
  await f.recovery.resume([unknown]);
  f.fail("stopped");
  f.threads.get("stopped").turns[0].status = "interrupted";
  f.fail("running");
  f.threads.get("running").status = { type: "active" };
  f.adapter.startTurn = async () =>
    assert.fail("unsafe automatic continuation");
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  assert.equal(
    f.recovery.snapshot().entries.find((x) => x.id === unknown).status,
    "unknown",
  );
});

test("an account switch affects only the host using that account", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.fail();
  f.recovery.registerHost("remote", {
    ...f.adapter,
    listThreads: async () => ({ data: [] }),
  });
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("remote", principal("a"));
  await f.recovery.accountChanged("remote", principal("b"));
  assert.equal(f.sent.length, 0);
});

test("pre-dispatch failures are attempted only once per account switch, including paginated history", async (t) => {
  const f = fixture(t);
  f.fail();
  let attempts = 0;
  f.adapter.startTurn = async () => {
    attempts++;
    throw Error("transport not ready");
  };
  const list = f.adapter.listThreads;
  f.adapter.listThreads = async (params) =>
    params.archived
      ? list(params)
      : {
          data: [...f.threads.values()],
          nextCursor: params.cursor ? null : "second",
        };
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.accountChanged("local", principal("b"));
  assert.equal(attempts, 1);
  await f.recovery.accountChanged("local", principal("c"));
  assert.equal(attempts, 2);
});

const usage = (
  accountId,
  primary,
  secondary = 20,
  allowed = primary < 100 && secondary < 100,
) => ({
  accountId,
  ordinaryUsageAllowed: allowed,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: primary },
    secondary: { usedPercent: secondary },
  },
});

test("same-account authentication resumes only a confirmed exhausted-to-available transition", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  // Native cache invalidation precedes account/updated, including logout/login.
  await f.recovery.accountChanged("local", null);
  const update = f.recovery.beginAccountUpdate("local");
  await f.recovery.accountChanged("local", principal("a"));
  await f.recovery.completeAccountUpdate(
    "local",
    update,
    principal("a"),
    usage("a", 10),
  );
  await f.recovery.completeAccountUpdate(
    "local",
    update,
    principal("a"),
    usage("a", 10),
  );
  assert.equal(f.sent.length, 1);
});

test("same-account recovery rejects unknown, unavailable, stale, and disabled evidence", async (t) => {
  const cases = [
    ["still exhausted", usage("a", 100), usage("a", 100)],
    ["secondary exhausted", usage("a", 100), usage("a", 5, 100, true)],
    ["unknown before", null, usage("a", 5)],
    ["unknown permission before", usage("a", 100, 20, null), usage("a", 5)],
    ["unknown after", usage("a", 100), null],
    ["unknown permission after", usage("a", 100), usage("a", 5, 20, null)],
    ["mismatched response account", usage("a", 100), usage("b", 5)],
    [
      "no windows",
      usage("a", 100),
      { accountId: "a", ordinaryUsageAllowed: true, rateLimits: {} },
    ],
    ["malformed window", usage("a", 100), usage("a", "5", 20, true)],
    ["off", usage("a", 100), usage("a", 5), "off"],
    ["disabled while reading", usage("a", 100), usage("a", 5), "disable"],
    ["newer authentication", usage("a", 100), usage("a", 5), "newer"],
    ["new quota failure", usage("a", 100), usage("a", 5), "failure"],
  ];
  for (const [name, before, after, action] of cases)
    await t.test(name, async (t) => {
      const f = fixture(t);
      f.fail();
      if (action !== "off") f.recovery.setAutoResume(true);
      await f.recovery.accountChanged("local", principal("a"));
      f.recovery.accountRateLimitsRead("local", principal("a"), before);
      const update = f.recovery.beginAccountUpdate("local");
      if (action === "disable") {
        f.recovery.setAutoResume(false);
        f.recovery.setAutoResume(true);
      }
      if (action === "newer") f.recovery.beginAccountUpdate("local");
      if (action === "failure") f.fail("two", "new-failure");
      await f.recovery.completeAccountUpdate(
        "local",
        update,
        principal("a"),
        after,
      );
      assert.equal(f.sent.length, 0);
    });
});

test("periodic quota recovery, principal refresh, and startup never act as reauthentication", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 10));
  await f.recovery.accountChanged("local", null);
  await f.recovery.accountChanged("local", principal("a"));
  const update = f.recovery.beginAccountUpdate("local");
  await f.recovery.completeAccountUpdate(
    "local",
    update,
    principal("a"),
    usage("a", 10),
  );
  assert.equal(f.sent.length, 0);
});

test("late usage from a previous principal cannot become the new account baseline", async (t) => {
  const f = fixture(t);
  f.fail();
  await f.recovery.accountChanged("local", principal("a"));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  const stale = f.recovery.beginAccountUpdate("local");
  await f.recovery.accountChanged("local", principal("b"));
  f.recovery.setAutoResume(true);
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  await f.recovery.completeAccountUpdate(
    "local",
    stale,
    principal("a"),
    usage("a", 10),
  );
  const update = f.recovery.beginAccountUpdate("local");
  await f.recovery.completeAccountUpdate(
    "local",
    update,
    principal("b"),
    usage("b", 10),
  );
  assert.equal(f.sent.length, 0);
});

test("a switched-to exhausted account retains its baseline for the next same-account login", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  await f.recovery.accountChanged("local", null);
  const switchUpdate = f.recovery.beginAccountUpdate("local");
  await f.recovery.accountChanged("local", principal("b"));
  // The hook records every fresh response, even when a switch consumed its ticket.
  f.recovery.accountRateLimitsRead("local", principal("b"), usage("b", 100));
  await f.recovery.completeAccountUpdate(
    "local",
    switchUpdate,
    principal("b"),
    usage("b", 100),
  );
  f.fail();
  await f.recovery.accountChanged("local", null);
  const sameUpdate = f.recovery.beginAccountUpdate("local");
  await f.recovery.accountChanged("local", principal("b"));
  await f.recovery.completeAccountUpdate(
    "local",
    sameUpdate,
    principal("b"),
    usage("b", 10),
  );
  assert.equal(f.sent.length, 1);
});

test("same-account quota recovery leaves 429 entries and retry budgets untouched", async (t) => {
  fastRecovery(t);
  const f = fixture(t);
  f.fail();
  const rate = {
    id: "rate-turn",
    status: "failed",
    error: {
      codexErrorInfo: "rateLimitExceeded",
      message: "429 Too Many Requests",
    },
    items: [],
  };
  f.threads.set("limited", {
    id: "limited",
    status: { type: "idle" },
    turns: [rate],
  });
  f.recovery.observe("local", {
    method: "turn/completed",
    params: { threadId: "limited", turn: rate },
  });
  const before = f.recovery
    .snapshot()
    .entries.find((e) => e.threadId === "limited");
  assert.equal(before.reason, "rateLimit");
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", principal("a"));
  f.recovery.accountRateLimitsRead("local", principal("a"), usage("a", 100));
  const update = f.recovery.beginAccountUpdate("local");
  await f.recovery.completeAccountUpdate(
    "local",
    update,
    principal("a"),
    usage("a", 10),
  );
  assert.deepEqual(
    f.sent.map((s) => s.threadId),
    ["one"],
  );
  const after = f.recovery
    .snapshot()
    .entries.find((e) => e.threadId === "limited");
  for (const field of ["status", "reason", "autoRetryCount", "retryAt"])
    assert.equal(after[field], before[field]);
});
