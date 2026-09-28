const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function hook() {
  // Exercise the shipped hook itself, without booting the app or real accounts.
  const source = fs
    .readFileSync(
      path.join(__dirname, "../patches/main-quota-recovery.patch"),
      "utf8",
    )
    .split(/^@@.*$/m)[1]
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const quotaReads = [],
    usage = [],
    updates = [],
    completions = [];
  const reads = [],
    changes = [],
    events = [];
  let notification, principal;
  const recovery = {
    registerHost() {},
    beginAccountUpdate(host) {
      const update = { host, id: updates.length };
      updates.push(update);
      return update;
    },
    accountRateLimitsRead(host, principal, response) {
      usage.push({ host, principal, response });
    },
    completeAccountUpdate(host, update, principal, response) {
      completions.push({ host, update, principal, response });
      return Promise.resolve();
    },
    observe(_host, event) {
      events.push(event);
    },
    accountChanged(host, value) {
      changes.push({ host, value });
      return Promise.resolve();
    },
  };
  const m = {
    sendAppServerRequest(method, params) {
      assert.equal(method, "account/rateLimits/read");
      assert.equal(params, undefined);
      return new Promise((resolve, reject) =>
        quotaReads.push({ resolve, reject }),
      );
    },
    registerInternalNotificationHandler(fn) {
      notification = fn;
    },
    registerArchiveSuccessHandler() {},
    registerInternalAuthenticatedPrincipalChangeHandler(fn) {
      principal = fn;
    },
    getAuthenticatedPrincipal() {
      return new Promise((resolve, reject) => reads.push({ resolve, reject }));
    },
  };
  vm.runInNewContext(source, {
    globalThis: { __codexQuotaRecovery: recovery },
    m,
    e: "local",
  });
  return {
    reads,
    quotaReads,
    usage,
    updates,
    completions,
    changes,
    events,
    notification: (event) => notification(event),
    principal: (value) => principal({ current: value }),
  };
}
const flush = () => new Promise(setImmediate);

test("account update actively reads a usable principal even without any UI token consumer", async () => {
  const h = hook();
  h.reads[0].resolve({ accountId: "a", userId: "u" });
  await flush();
  h.principal(null);
  h.notification({
    method: "account/updated",
    params: { authMode: "chatgpt" },
  });
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve({ accountId: "b", userId: "u" });
  await flush();
  assert.deepEqual(
    h.changes.map((x) => x.value?.accountId ?? null),
    ["a", null, "b"],
  );
});

test("stale principal reads and failed login refreshes cannot start automatic recovery", async () => {
  const h = hook();
  h.reads[0].resolve({ accountId: "a", userId: "u" });
  await flush();
  h.notification({ method: "account/updated" });
  h.notification({ method: "account/updated" });
  h.reads[2].resolve({ accountId: "c", userId: "u" });
  await flush();
  h.reads[1].resolve({ accountId: "b", userId: "u" });
  h.notification({ method: "account/updated" });
  h.reads[3].reject(Error("login failed"));
  await flush();
  assert.deepEqual(
    h.changes.map((x) => x.value.accountId),
    ["a", "c"],
  );
});

test("quota notifications refresh the baseline but only an account update completes authentication", async () => {
  const h = hook(),
    a = { accountId: "a", userId: "u" };
  h.reads[0].resolve(a);
  await flush();
  h.quotaReads[0].resolve({ accountId: "a", ordinaryUsageAllowed: false });
  await flush();
  h.notification({
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { usedPercent: 2 } } },
  });
  h.quotaReads[1].resolve({ accountId: "a", ordinaryUsageAllowed: true });
  await flush();
  assert.equal(h.usage.length, 2);
  assert.equal(h.completions.length, 0);
  h.principal(null);
  h.notification({
    method: "account/updated",
    params: { authMode: "chatgpt" },
  });
  // Rolling notifications cannot replace the captured pre-login evidence.
  h.notification({ method: "account/rateLimits/updated" });
  assert.equal(h.quotaReads.length, 2);
  h.principal(a);
  h.reads[1].resolve(a);
  await flush();
  h.quotaReads[2].resolve({ accountId: "a", ordinaryUsageAllowed: true });
  await flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].update, h.updates[0]);
  assert.equal(h.usage.length, 3);
});

test("old-account quota reads, stale auth results, and failed quota reads are never fresh usable evidence", async () => {
  const h = hook(),
    a = { accountId: "a", userId: "u" },
    b = { accountId: "b", userId: "u" };
  h.reads[0].resolve(a);
  await flush();
  h.principal(null);
  h.notification({
    method: "account/updated",
    params: { authMode: "chatgpt" },
  });
  h.reads[1].resolve(b);
  await flush();
  h.quotaReads[0].resolve({ accountId: "a", ordinaryUsageAllowed: true });
  h.quotaReads[1].reject(Error("offline"));
  await flush();
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0].principal.accountId, "b");
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].response, null);
  h.principal(null);
  h.notification({ method: "account/updated", params: { authMode: null } });
  assert.equal(
    h.updates.length,
    1,
    "logout preserves the prior baseline instead of starting a recovery check",
  );
});

test("a startup principal callback wins over the late initial principal promise without a login", async () => {
  const h = hook(),
    a = { accountId: "a", userId: "u" };
  h.principal(a);
  assert.equal(h.quotaReads.length, 1);
  h.reads[0].resolve({ accountId: "old", userId: "u" });
  await flush();
  h.quotaReads[0].resolve({ accountId: "a", ordinaryUsageAllowed: true });
  await flush();
  assert.deepEqual(
    h.changes.map((c) => c.value.accountId),
    ["a"],
  );
  assert.equal(h.usage.length, 1);
  assert.equal(h.completions.length, 0);
});

test("the current account quota baseline is recorded before completing a consumed switch ticket", async () => {
  const h = hook(),
    a = { accountId: "a", userId: "u" },
    b = { accountId: "b", userId: "u" };
  h.reads[0].resolve(a);
  await flush();
  h.quotaReads[0].resolve({ accountId: "a", ordinaryUsageAllowed: false });
  await flush();
  h.principal(null);
  h.notification({
    method: "account/updated",
    params: { authMode: "chatgpt" },
  });
  h.principal(b);
  h.reads[1].resolve(b);
  await flush();
  const exhausted = { accountId: "b", ordinaryUsageAllowed: false };
  h.quotaReads[1].resolve(exhausted);
  await flush();
  assert.equal(h.usage.at(-1).principal, b);
  assert.equal(h.usage.at(-1).response, exhausted);
  assert.equal(h.completions.at(-1).response, exhausted);
});
