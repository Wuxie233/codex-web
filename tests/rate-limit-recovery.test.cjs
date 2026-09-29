const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  QuotaRecovery,
  RATE_LIMIT_CONTINUATION,
} = require("../src/server/quota-recovery.js");
const { recoveryReason } = require("../src/server/rate-limit-recovery.js");
const rate = {
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
};
const quota = { codexErrorInfo: "usageLimitExceeded" };
async function flush() {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rate-"));
  const file = path.join(dir, "entries.json");
  let now = 1000000;
  const timers = new Set();
  const clock = {
    now: () => now,
    setTimeout(callback, delay) {
      const timer = {
        callback,
        due: now + delay,
        unref() {
          this.unreferenced = true;
        },
      };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  const threads = new Map(),
    sent = [],
    archived = new Set();
  const f = { file, clock, threads, sent, archived, timers };
  const adapter = {
    async readThread(id) {
      return threads.get(id) ?? null;
    },
    async listThreads(params) {
      return {
        data: [...threads.values()].filter(
          (x) => archived.has(x.id) === params.archived,
        ),
      };
    },
    async resumeThread(id) {
      threads.get(id).status = { type: "idle" };
    },
    async startTurn(params, beforeSend) {
      beforeSend();
      sent.push(params);
      const turn = {
        id: `auto-${sent.length}`,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: `server-item-${sent.length}`,
            clientId: params.clientUserMessageId,
          },
        ],
      };
      threads.get(params.threadId).turns.push(turn);
      f.recovery.observe("local", {
        method: "turn/started",
        params: { threadId: params.threadId, turn },
      });
      return { turn };
    },
  };
  f.adapter = adapter;
  f.recovery = new QuotaRecovery(file, clock);
  f.recovery.registerHost("local", adapter);
  f.fail = (id = "one", turnId = "initial", error = rate) => {
    let thread = threads.get(id);
    const turn = { id: turnId, status: "failed", error, items: [] };
    if (!thread) {
      thread = { id, status: { type: "idle" }, turns: [] };
      threads.set(id, thread);
    }
    const existing = thread.turns.find((x) => x.id === turnId);
    if (existing) {
      turn.items = existing.items;
      Object.assign(existing, turn);
    } else thread.turns.push(turn);
    thread.status = { type: "idle" };
    f.recovery.observe("local", {
      method: "turn/completed",
      params: { threadId: id, turn },
    });
    return f.recovery
      .snapshot()
      .entries.find((x) => x.threadId === id && x.turnId === turnId);
  };
  f.advance = async (ms) => {
    now += ms;
    for (const timer of [...timers])
      if (timer.due <= now) {
        timers.delete(timer);
        timer.callback();
      }
    await flush();
  };
  f.reload = () => {
    f.recovery.dispose();
    f.recovery = new QuotaRecovery(file, clock);
    f.recovery.registerHost("local", adapter);
    return f.recovery;
  };
  t.after(async () => {
    f.recovery.dispose();
    await flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

test("429 classification follows structured protocol and gives quota precedence", () => {
  for (const variant of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    assert.equal(
      recoveryReason({
        codexErrorInfo: { [variant]: { httpStatusCode: 429 } },
      }),
      "rateLimit",
    );
    assert.equal(
      recoveryReason({
        codexErrorInfo: { [variant]: { httpStatusCode: 503 } },
        message: "HTTP 429 earlier",
      }),
      undefined,
    );
  }
  assert.equal(
    recoveryReason({ codexErrorInfo: "rateLimitExceeded" }),
    "rateLimit",
  );
  assert.equal(
    recoveryReason({ message: "unexpected status 429 Too Many Requests" }),
    "rateLimit",
  );
  assert.equal(
    recoveryReason({ message: "HTTP 429 insufficient_quota" }),
    "quota",
  );
  assert.equal(
    recoveryReason({ message: "HTTP 429 usage_limit_reached" }),
    "quota",
  );
  assert.equal(recoveryReason({ ...quota, message: "HTTP 429" }), "quota");
  assert.equal(
    recoveryReason({
      codexErrorInfo: "unauthorized",
      message: "HTTP 429 earlier",
    }),
    undefined,
  );
  assert.equal(
    recoveryReason({ message: "task number 429 failed" }),
    undefined,
  );
});

test("default off, independent durable toggles, invalid setting is rejected", async (t) => {
  const f = fixture(t);
  f.fail();
  assert.equal(f.recovery.snapshot().autoResumeOn429, false);
  await f.advance(600000);
  assert.equal(f.sent.length, 0);
  f.recovery.setAutoResume(true);
  f.recovery.setAutoResume429(true);
  f.recovery.setAutoResume(false);
  assert.throws(() => f.recovery.setAutoResume429("true"), /设置/);
  f.reload();
  assert.equal(f.recovery.snapshot().autoResumeOn429, true);
  assert.equal(f.recovery.snapshot().autoResumeOnAccountSwitch, false);
  await flush();
});

test("only terminal 429 enters queue, duplicate error and completion schedule once", async (t) => {
  const f = fixture(t);
  f.recovery.setAutoResume429(true);
  await flush();
  f.recovery.observe("local", {
    method: "error",
    params: {
      threadId: "one",
      turnId: "initial",
      error: rate,
      willRetry: true,
    },
  });
  assert.equal(f.recovery.snapshot().entries.length, 0);
  f.fail();
  f.recovery.observe("local", {
    method: "error",
    params: {
      threadId: "one",
      turnId: "initial",
      error: rate,
      willRetry: false,
    },
  });
  f.fail();
  assert.equal(f.recovery.snapshot().entries.length, 1);
  assert.equal(f.timers.size, 2); // One discovery timer and one continuation.
  assert.ok([...f.timers].every((timer) => timer.unreferenced));
  await f.advance(29999);
  assert.equal(f.sent.length, 0);
  await f.advance(1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].input[0].text, RATE_LIMIT_CONTINUATION);
  assert.doesNotMatch(f.sent[0].input[0].text, /切换账号/);
});

test("30/60/120 seconds and max three persist across rapid started/completed, restart and toggles", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    const turn = {
      id: `auto-${f.sent.length}`,
      status: "inProgress",
      items: [],
    };
    f.threads.get("one").turns.push(turn);
    f.recovery.observe("local", {
      method: "turn/started",
      params: { threadId: "one", turn },
    });
    f.fail("one", turn.id); // Notification arrives before the start response.
    return { turn };
  };
  await f.advance(30000);
  assert.equal(f.sent.length, 1);
  f.recovery.setAutoResume429(false);
  assert.equal(f.timers.size, 0);
  f.recovery.setAutoResume429(true);
  await flush();
  f.reload();
  await flush();
  await f.advance(59999);
  assert.equal(f.sent.length, 1);
  await f.advance(1);
  assert.equal(f.sent.length, 2);
  await f.advance(119999);
  assert.equal(f.sent.length, 2);
  await f.advance(1);
  assert.equal(f.sent.length, 3);
  f.reload();
  await flush();
  f.recovery.setAutoResume429(false);
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(999999);
  assert.equal(f.sent.length, 3);
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-3")
      .autoRetryCount,
    3,
  );
});

test("manual new turn and successful completion reset the consecutive budget", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  const afterStartReceipt = f.fail("one", "auto-1");
  assert.equal(afterStartReceipt.autoRetryCount, 1); // A start receipt is not a successful completion.
  const manual = {
    id: "manual",
    status: "inProgress",
    items: [{ type: "userMessage", id: "human-message" }],
  };
  f.threads.get("one").turns.push(manual);
  f.recovery.observe("local", {
    method: "turn/started",
    params: { threadId: "one", turn: manual },
  });
  const next = f.fail("one", "manual");
  assert.equal(next.autoRetryCount, 0);
  await f.advance(30000);
  assert.equal(f.sent.length, 2);
  f.recovery.observe("local", {
    method: "turn/completed",
    params: { threadId: "one", turn: { id: "auto-2", status: "completed" } },
  });
  const afterSuccess = f.fail("one", "later");
  assert.equal(afterSuccess.autoRetryCount, 0);
  assert.equal(afterSuccess.retryAt - f.clock.now(), 30000);
  await f.advance(29999);
  assert.equal(f.sent.length, 2);
  await f.advance(1);
  assert.equal(f.sent.length, 3);
});

test("unknown delivery blocks later automatic turns and survives restart", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    throw Error("connection lost after write");
  };
  await f.advance(30000);
  assert.equal(f.recovery.snapshot().entries[0].status, "unknown");
  f.recovery.observe("local", {
    method: "turn/started",
    params: {
      threadId: "one",
      turn: {
        id: "late",
        items: [
          {
            type: "userMessage",
            id: "server-late",
            clientId: f.sent[0].clientUserMessageId,
          },
        ],
      },
    },
  });
  f.fail("one", "late");
  f.reload();
  await flush();
  await f.advance(999999);
  assert.equal(f.sent.length, 1);
});

test("archive, active, stopped, new turn and new quota block dispatch", async (t) => {
  for (const state of ["archive", "active", "stopped", "new-turn", "quota"]) {
    const f = fixture(t);
    f.fail();
    f.recovery.setAutoResume429(true);
    await flush();
    if (state === "archive") f.archived.add("one");
    if (state === "active") f.threads.get("one").status.type = "active";
    if (state === "stopped")
      f.threads.get("one").turns[0].status = "interrupted";
    if (state === "new-turn")
      f.threads.get("one").turns.push({ id: "new", status: "completed" });
    if (state === "quota") f.fail("other", "quota", quota);
    await f.advance(30000);
    assert.equal(f.sent.length, 0, state);
  }
});

test("disable during preparation preserves the pending deadline and resumes after enabling", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  const originalStart = f.adapter.startTurn;
  const deadline = f.recovery.snapshot().entries[0].retryAt;
  f.adapter.startTurn = async (_, beforeSend) => {
    f.recovery.setAutoResume429(false);
    beforeSend();
    assert.fail("disabled dispatch");
  };
  await f.advance(30000);
  assert.equal(f.sent.length, 0);
  assert.equal(f.recovery.snapshot().entries[0].autoRetryCount, 0);
  assert.equal(f.recovery.snapshot().entries[0].status, "pending");
  assert.equal(f.recovery.snapshot().entries[0].retryAt, deadline);
  f.adapter.startTurn = originalStart;
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.recovery.snapshot().entries[0].autoRetryCount, 1);
});

test("enabling scans unopened paginated history without touching completed parents", async (t) => {
  const f = fixture(t);
  f.threads.set("history", {
    id: "history",
    status: { type: "notLoaded" },
    turns: [{ id: "old429", status: "failed", error: rate }],
  });
  f.threads.set("root", {
    id: "root",
    status: { type: "idle" },
    turns: [{ id: "done", status: "completed" }],
  });
  f.threads.set("child", {
    id: "child",
    parentThreadId: "root",
    status: { type: "idle" },
    turns: [{ id: "child429", status: "failed", error: rate }],
  });
  const cursors = [];
  f.adapter.listThreads = async (params) => {
    if (params.archived) return { data: [] };
    cursors.push(params.cursor);
    return params.cursor
      ? { data: [...f.threads.values()] }
      : { data: [], nextCursor: "page2" };
  };
  f.recovery.setAutoResume429(true);
  await flush();
  assert.deepEqual(cursors, [null, "page2"]);
  await f.advance(30000);
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["history"],
  );
});

test("account auto continuation never dispatches 429 and quota replaces ambiguous 429 classification", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume(true);
  await f.recovery.accountChanged("local", { accountId: "a", userId: "a" });
  await f.recovery.accountChanged("local", { accountId: "b", userId: "b" });
  assert.equal(f.sent.length, 0);
  f.fail("one", "initial", quota);
  assert.equal(f.recovery.snapshot().entries[0].reason, "quota");
  assert.equal(f.recovery.snapshot().entries[0].status, "pending");
});

test("manual menu continuation resets an exhausted budget only when dispatched", async (t) => {
  const real = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
    real(callback, delay === 1500 ? 0 : delay, ...args),
  );
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  for (const delay of [30000, 60000, 120000]) {
    await f.advance(delay);
    f.fail("one", `auto-${f.sent.length}`);
  }
  const exhausted = f.recovery
    .snapshot()
    .entries.find((e) => e.turnId === "auto-3");
  assert.equal(exhausted.autoRetryCount, 3);
  await f.recovery.resume([exhausted.id]);
  f.fail("one", "auto-4");
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-4")
      .autoRetryCount,
    0,
  );
  await f.advance(30000);
  assert.equal(f.sent.length, 5);
});

test("offline human turn starts a fresh budget, but offline automatic failure preserves it", async (t) => {
  for (const human of [true, false]) {
    const f = fixture(t);
    f.fail();
    f.recovery.setAutoResume429(true);
    await flush();
    for (const delay of [30000, 60000, 120000]) {
      await f.advance(delay);
      f.fail("one", `auto-${f.sent.length}`);
    }
    if (human)
      f.threads.get("one").turns.push({
        id: "offline-human",
        status: "failed",
        error: rate,
        items: [
          {
            type: "userMessage",
            id: "server-human",
            clientId: "human-client",
          },
        ],
      });
    f.reload();
    await flush();
    await f.advance(30000);
    assert.equal(f.sent.length, human ? 4 : 3);
  }
});

test("old unknown ledger does not block a confirmed new human chain after restart", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  const originalStart = f.adapter.startTurn;
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    throw Error("unknown");
  };
  await f.advance(30000);
  const human = {
    id: "new-human",
    status: "inProgress",
    items: [
      { type: "userMessage", id: "server-human", clientId: "human-client" },
    ],
  };
  f.threads.get("one").turns.push(human);
  f.recovery.observe("local", {
    method: "turn/started",
    params: { threadId: "one", turn: human },
  });
  f.fail("one", human.id);
  f.adapter.startTurn = originalStart;
  f.reload();
  await flush();
  await f.advance(30000);
  assert.equal(f.sent.length, 2);
});

test("child mapping uses root budget and backoff, excludes stale skipped children", async (t) => {
  const f = fixture(t);
  f.fail("root", "initial");
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  f.fail("root", "auto-1");
  await f.advance(60000);
  const root = f.threads.get("root");
  root.turns.at(-1).status = "failed";
  root.turns.at(-1).error = rate;
  f.fail("child", "child-fail");
  f.threads.get("child").parentThreadId = "root";
  await f.recovery.list();
  const mapped = f.recovery
    .snapshot()
    .entries.find((e) => e.threadId === "root" && e.turnId === "auto-2");
  assert.equal(mapped.autoRetryCount, 2);
  await f.advance(30000);
  assert.equal(f.sent.length, 2);
  await f.advance(90000);
  assert.equal(f.sent.length, 3);
});

test("quota during sending permanently pauses the automatic 429 chain without resetting count", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  const start = f.adapter.startTurn;
  f.adapter.startTurn = async (...args) => {
    const result = await start(...args);
    f.fail("other", "quota", quota);
    f.fail("one", result.turn.id);
    return result;
  };
  await f.advance(30000);
  f.reload();
  await flush();
  await f.advance(999999);
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-1")
      .autoRetryCount,
    1,
  );
});

test("late state changes during transport preparation prevent a 429 continuation", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  f.adapter.startTurn = async (_, beforeSend) => {
    f.recovery.observe("local", {
      method: "turn/started",
      params: { threadId: "one", turn: { id: "human", items: [] } },
    });
    beforeSend();
    assert.fail("must not send");
  };
  await f.advance(30000);
  assert.equal(f.sent.length, 0);
});

test("a child timer remapped during dispatch cannot bypass the root 120-second delay", async (t) => {
  const f = fixture(t);
  f.fail("root", "initial");
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  f.fail("root", "auto-1");
  await f.advance(60000);
  f.threads.get("root").turns.at(-1).status = "failed";
  f.threads.get("root").turns.at(-1).error = rate;
  f.fail("child", "child-fail");
  f.threads.get("child").parentThreadId = "root";
  await f.advance(30000);
  assert.equal(f.sent.length, 2);
  await f.advance(90000);
  assert.equal(f.sent.length, 3);
});

for (const limit of [1, 5, 0]) {
  test(`custom retry limit ${limit} survives restart and caps backoff`, async (t) => {
    const f = fixture(t);
    assert.equal(f.recovery.snapshot().rateLimitMaxRetries, 3);
    f.recovery.setRateLimitMaxRetries(limit);
    f.fail();
    f.recovery.setAutoResume429(true);
    await flush();
    const attempts = limit || 7;
    for (let i = 0; i < attempts; i++) {
      const delay = [30000, 60000, 120000][Math.min(i, 2)];
      await f.advance(delay - 1);
      assert.equal(f.sent.length, i);
      await f.advance(1);
      assert.equal(f.sent.length, i + 1);
      f.fail("one", `auto-${i + 1}`);
      f.reload();
      await flush();
      assert.equal(f.recovery.snapshot().rateLimitMaxRetries, limit);
    }
    if (limit) {
      await f.advance(1000000);
      assert.equal(f.sent.length, limit);
      const entry = f.recovery
        .snapshot()
        .entries.find((e) => e.turnId === `auto-${limit}`);
      assert.equal(entry.retryAt, undefined);
      assert.match(entry.detail, new RegExp(`${limit}次`));
    } else {
      f.recovery.setAutoResume429(false);
      await f.advance(1000000);
      assert.equal(f.sent.length, attempts);
    }
  });
}

test("retry setting rejects invalid values without changing persisted settings", (t) => {
  const f = fixture(t);
  f.recovery.setRateLimitMaxRetries(5);
  for (const value of [
    -1,
    1.5,
    "0",
    null,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => f.recovery.setRateLimitMaxRetries(value), /非负整数/);
  f.reload();
  assert.equal(f.recovery.snapshot().rateLimitMaxRetries, 5);
});

test("raising an exhausted limit resumes waiting and lowering preserves consumed count", async (t) => {
  const f = fixture(t);
  f.recovery.setRateLimitMaxRetries(1);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  f.fail("one", "auto-1");
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-1").retryAt,
    undefined,
  );
  f.recovery.setRateLimitMaxRetries(0);
  await f.advance(59999);
  assert.equal(f.sent.length, 1);
  await f.advance(1);
  assert.equal(f.sent.length, 2);
  f.fail("one", "auto-2");
  f.recovery.setRateLimitMaxRetries(1);
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-2").retryAt,
    undefined,
  );
  f.reload();
  await flush();
  await f.advance(1000000);
  assert.equal(f.sent.length, 2);
  assert.equal(
    f.recovery.snapshot().entries.find((e) => e.turnId === "auto-2")
      .autoRetryCount,
    2,
  );
});

test("changing retry limit cancels a prepared send without consuming budget", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  f.fail("one", "auto-1");
  const start = f.adapter.startTurn;
  f.adapter.startTurn = async (params, beforeSend) => {
    f.recovery.setRateLimitMaxRetries(1);
    return start(params, beforeSend);
  };
  await f.advance(60000);
  assert.equal(f.sent.length, 1);
  const entry = f.recovery
    .snapshot()
    .entries.find((e) => e.turnId === "auto-1");
  assert.equal(entry.status, "pending");
  assert.equal(entry.autoRetryCount, 1);
  assert.equal(entry.retryAt, undefined);
});

test("unlimited setting never replays an uncertain delivery", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  f.adapter.startTurn = async (params, beforeSend) => {
    beforeSend();
    f.sent.push(params);
    throw Error("lost receipt");
  };
  await f.advance(30000);
  f.recovery.setRateLimitMaxRetries(0);
  f.reload();
  await flush();
  await f.advance(1000000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.recovery.snapshot().entries[0].status, "unknown");
});

test("changing retry limit restarts an interrupted paginated history scan", async (t) => {
  const f = fixture(t);
  f.threads.set("history", {
    id: "history",
    status: { type: "idle" },
    turns: [{ id: "old429", status: "failed", error: rate }],
  });
  let releaseFirstPage;
  const firstPage = new Promise((resolve) => {
    releaseFirstPage = resolve;
  });
  const cursors = [];
  f.adapter.listThreads = async (params) => {
    if (params.archived) return { data: [] };
    cursors.push(params.cursor);
    if (cursors.length === 1) await firstPage;
    return params.cursor
      ? { data: [...f.threads.values()] }
      : { data: [], nextCursor: "page2" };
  };
  f.recovery.setAutoResume429(true);
  await flush();
  assert.deepEqual(cursors, [null]);
  f.recovery.setRateLimitMaxRetries(0);
  releaseFirstPage();
  await flush();
  assert.deepEqual(cursors, [null, null, "page2"]);
  await f.advance(29999);
  assert.equal(f.sent.length, 0);
  await f.advance(1);
  assert.deepEqual(
    f.sent.map((entry) => entry.threadId),
    ["history"],
  );
});

test("raising the limit resumes an exhausted root failure discovered through a child", async (t) => {
  const f = fixture(t);
  f.recovery.setRateLimitMaxRetries(2);
  f.fail("root", "initial");
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  f.fail("root", "auto-1");
  await f.advance(60000);
  // The root's completion notification was missed; child resolution reads it.
  const root = f.threads.get("root");
  root.turns.at(-1).status = "failed";
  root.turns.at(-1).error = rate;
  f.fail("child", "child-fail");
  f.threads.get("child").parentThreadId = "root";
  await f.recovery.list();
  const mapped = f.recovery
    .snapshot()
    .entries.find(
      (entry) => entry.threadId === "root" && entry.turnId === "auto-2",
    );
  assert.equal(mapped.autoRetryCount, 2);
  assert.equal(mapped.retryAt, undefined);
  f.recovery.setRateLimitMaxRetries(0);
  await flush();
  await f.advance(119999);
  assert.equal(f.sent.length, 2);
  await f.advance(1);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].threadId, "root");
});

test("background scan discovers failures without a renderer, list call or notification", async (t) => {
  const f = fixture(t);
  f.recovery.setAutoResume429(true);
  await flush();
  f.reload(); // Persisted preference starts discovery without opening a browser.
  await flush();
  f.threads.set("offline", {
    id: "offline",
    status: { type: "idle" },
    updatedAt: 1000,
    turns: [{ id: "missed-event", status: "failed", error: rate }],
  });
  await f.advance(30000);
  assert.equal(f.sent.length, 0);
  await f.advance(30000);
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["offline"],
  );
  await f.advance(30000);
  assert.equal(f.sent.length, 1);
});

test("background scans retry failed reads and do not overlap slow scans", async (t) => {
  const f = fixture(t);
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.adapter.listThreads = async (params) => {
    if (params.archived) return { data: [] };
    calls++;
    if (calls === 1) await gate;
    if (calls === 2) throw Error("temporarily offline");
    return { data: [] };
  };
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(90000);
  assert.equal(calls, 1);
  release();
  await flush();
  await f.advance(30000);
  assert.equal(calls, 2);
  await f.advance(30000);
  assert.equal(calls, 3);
  f.recovery.setAutoResume429(false);
  assert.equal(f.timers.size, 0);
  await f.advance(300000);
  assert.equal(calls, 3);
});

test("disconnect or dispose during discovery prevents late entries and future scans", async (t) => {
  for (const stop of ["unregisterHost", "dispose"])
    await t.test(stop, async (t) => {
      const f = fixture(t);
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      f.adapter.listThreads = async () => ({ data: [{ id: "late" }] });
      f.adapter.readThread = async () => pending;
      f.recovery.setAutoResume429(true);
      await flush();
      f.recovery[stop]("local");
      release({
        id: "late",
        turns: [{ id: "bad", status: "failed", error: rate }],
      });
      await flush();
      assert.equal(f.recovery.snapshot().entries.length, 0);
      assert.equal(f.timers.size, 0);
      await f.advance(300000);
      assert.equal(f.sent.length, 0);
    });
});

test("periodic full scan catches delayed old timestamps while recent scans stay bounded", async (t) => {
  const f = fixture(t);
  let oldReads = 0;
  f.threads.set("recent", {
    id: "recent",
    updatedAt: 900,
    turns: [{ id: "done", status: "completed" }],
  });
  f.threads.set("old", {
    id: "old",
    status: { type: "idle" },
    updatedAt: 800,
    turns: [{ id: "done", status: "completed" }],
  });
  const read = f.adapter.readThread;
  f.adapter.readThread = async (id) => {
    if (id === "old") oldReads++;
    return read(id);
  };
  f.recovery.setAutoResume429(true);
  await flush();
  assert.equal(oldReads, 1);
  f.threads
    .get("old")
    .turns.push({ id: "delayed", status: "failed", error: rate });
  await f.advance(30000);
  assert.equal(oldReads, 1);
  assert.equal(f.sent.length, 0);
  await f.advance(270000);
  assert.ok(f.recovery.snapshot().entries.some((x) => x.turnId === "delayed"));
  await f.advance(30000);
  assert.equal(f.sent.length, 1);
});

test("failed candidate reads retain the scan watermark for the next background pass", async (t) => {
  const f = fixture(t);
  let fail = true;
  f.threads.set("missed", {
    id: "missed",
    updatedAt: 1,
    status: { type: "idle" },
    turns: [{ id: "failed", status: "failed", error: rate }],
  });
  f.threads.set("newer", {
    id: "newer",
    updatedAt: 1000,
    turns: [{ id: "ok", status: "completed" }],
  });
  const read = f.adapter.readThread;
  f.adapter.readThread = async (id) =>
    id === "missed" && fail ? null : read(id);
  f.recovery.setAutoResume429(true);
  await flush();
  assert.equal(f.recovery.snapshot().entries.length, 0);
  fail = false;
  await f.advance(30000);
  assert.ok(f.recovery.snapshot().entries.some((x) => x.threadId === "missed"));
});

test("late history reads cannot erase the budget of a newer terminal error", async (t) => {
  const f = fixture(t);
  f.fail();
  f.recovery.setAutoResume429(true);
  await flush();
  await f.advance(30000);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const read = f.adapter.readThread;
  let held = false;
  f.adapter.readThread = async (id) => {
    if (!held) {
      held = true;
      return pending;
    }
    return read(id);
  };
  await f.advance(30000);
  const turn = f.threads.get("one").turns.at(-1);
  Object.assign(turn, { status: "failed", error: rate });
  f.recovery.observe("local", {
    method: "error",
    params: { threadId: "one", turnId: turn.id, error: rate, willRetry: false },
  });
  release({ id: "one", turns: [{ id: "stale-success", status: "completed" }] });
  await flush();
  const settings = JSON.parse(
    fs.readFileSync(f.file + ".settings.json", "utf8"),
  );
  assert.equal(Object.values(settings.rateLimitChains)[0].count, 1);
});

test("quota exhaustion blocks existing retries without stopping background discovery", async (t) => {
  const f = fixture(t);
  f.recovery.setAutoResume429(true);
  await flush();
  f.fail("blocked");
  f.fail("quota", "exhausted", quota);
  f.threads.set("fresh", {
    id: "fresh",
    status: { type: "idle" },
    turns: [{ id: "new-failure", status: "failed", error: rate }],
  });
  await f.advance(30000);
  assert.ok(f.recovery.snapshot().entries.some((x) => x.threadId === "fresh"));
  await f.advance(30000);
  assert.deepEqual(
    f.sent.map((x) => x.threadId),
    ["fresh"],
  );
});

test("mixed missing timestamps do not stop incremental discovery before later pages", async (t) => {
  const f = fixture(t);
  f.threads.set("recent", { id: "recent", updatedAt: 1000, turns: [] });
  f.recovery.setAutoResume429(true);
  await flush();
  f.threads.set("missing", { id: "missing", turns: [] });
  f.threads.set("later", {
    id: "later",
    status: { type: "idle" },
    turns: [{ id: "failed", status: "failed", error: rate }],
  });
  f.adapter.listThreads = async (params) =>
    params.archived
      ? { data: [] }
      : params.cursor
        ? { data: [f.threads.get("later")] }
        : {
            data: [
              { ...f.threads.get("recent"), updatedAt: 1 },
              f.threads.get("missing"),
            ],
            nextCursor: "page2",
          };
  await f.advance(30000);
  assert.ok(
    f.recovery.snapshot().entries.some((entry) => entry.threadId === "later"),
  );
});

test("slow history scans do not delay known automatic or manual continuations", async (t) => {
  for (const mode of ["list", "read"])
    for (const automatic of [true, false])
      await t.test(
        `${mode}, ${automatic ? "429" : "manual quota"}`,
        async (t) => {
          const real = global.setTimeout;
          t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
            real(callback, delay === 1500 ? 0 : delay, ...args),
          );
          const f = fixture(t);
          const entry = f.fail("ready", "failed", automatic ? rate : quota);
          await f.recovery.list();
          f.reload();
          f.threads.set("history", {
            id: "history",
            status: { type: "idle" },
            turns: [{ id: "done", status: "completed" }],
          });
          let release,
            held = false;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          const list = f.adapter.listThreads;
          const read = f.adapter.readThread;
          f.adapter.listThreads = async (params) => {
            if (mode === "list" && !params.archived) {
              held = true;
              await gate;
            }
            return list(params);
          };
          f.adapter.readThread = async (id) => {
            if (mode === "read" && id === "history") {
              held = true;
              await gate;
            }
            return read(id);
          };
          let scan, resume;
          try {
            if (automatic) f.recovery.setAutoResume429(true);
            else scan = f.recovery.list();
            await flush();
            assert.equal(held, true);
            if (automatic) await f.advance(30000);
            else {
              resume = f.recovery.resume([entry.id]);
              await flush();
            }
            assert.deepEqual(
              f.sent.map((x) => x.threadId),
              ["ready"],
            );
          } finally {
            release();
            await flush();
            await scan;
            await resume;
          }
          assert.equal(f.sent.length, 1);
        },
      );
});

test("unrelated unresolved records do not block a selected continuation", async (t) => {
  const real = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) =>
    real(callback, delay === 1500 ? 0 : delay, ...args),
  );
  const f = fixture(t);
  f.fail("unavailable", "old", quota);
  const entry = f.fail("ready", "failed", quota);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const read = f.adapter.readThread;
  f.adapter.readThread = async (id) => {
    if (id === "unavailable") await gate;
    return read(id);
  };
  const resume = f.recovery.resume([entry.id]);
  try {
    await flush();
    assert.deepEqual(
      f.sent.map((x) => x.threadId),
      ["ready"],
    );
  } finally {
    release();
    await resume;
  }
});

test("enabling or reconnecting schedules known 429 records before history completes", async (t) => {
  for (const reconnect of [false, true])
    await t.test(reconnect ? "reconnect" : "enable", async (t) => {
      const f = fixture(t);
      f.fail();
      await f.recovery.list();
      if (reconnect) {
        f.recovery.setAutoResume429(true);
        await flush();
        f.recovery.unregisterHost("local");
      }
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const list = f.adapter.listThreads;
      f.adapter.listThreads = async (params) => {
        if (!params.archived) await gate;
        return list(params);
      };
      try {
        if (reconnect) f.recovery.registerHost("local", f.adapter);
        else f.recovery.setAutoResume429(true);
        await flush();
        await f.advance(30000);
        assert.equal(f.sent.length, 1);
        assert.equal(f.recovery.snapshot().entries[0].autoRetryCount, 1);
      } finally {
        release();
        await flush();
      }
      assert.equal(f.sent.length, 1);
    });
});

test("late child resolution cannot revive an old root failure or reset a dispatched budget", async (t) => {
  const f = fixture(t);
  f.fail("root", "old-human");
  f.threads.get("root").turns.at(-1).items = [
    { type: "userMessage", id: "old-human-message" },
  ];
  f.fail("child", "child-failure");
  f.threads.get("child").parentThreadId = "root";
  const staleRoot = structuredClone(f.threads.get("root"));
  const read = f.adapter.readThread;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let rootReads = 0;
  f.adapter.readThread = async (id) => {
    // Initial root resolution completes; the child's parent read stays in flight.
    if (id === "root" && ++rootReads === 2) return gate;
    return read(id);
  };
  try {
    f.recovery.setAutoResume429(true);
    await flush();
    assert.equal(rootReads, 2);
    const manual = {
      id: "new-human",
      status: "inProgress",
      items: [{ type: "userMessage", id: "new-human-message" }],
    };
    f.threads.get("root").turns.push(manual);
    f.recovery.observe("local", {
      method: "turn/started",
      params: { threadId: "root", turn: manual },
    });
    f.fail("root", "new-human");
    await f.advance(30000);
    assert.deepEqual(
      f.sent.map((entry) => entry.threadId),
      ["root"],
    );
  } finally {
    release(staleRoot);
    await flush();
  }
  const entries = f.recovery.snapshot().entries;
  const dispatched = entries.find(
    (entry) => entry.threadId === "root" && entry.turnId === "new-human",
  );
  assert.equal(dispatched.status, "resumed");
  assert.equal(dispatched.autoRetryCount, 1);
  const settings = JSON.parse(
    fs.readFileSync(f.file + ".settings.json", "utf8"),
  );
  assert.equal(
    settings.rateLimitChains[JSON.stringify(["local", "root"])].count,
    1,
  );
  await f.advance(30000);
  assert.equal(f.sent.length, 1);
});
