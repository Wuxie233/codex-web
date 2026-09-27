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
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const reads = [],
    changes = [],
    events = [];
  let notification, principal;
  const recovery = {
    registerHost() {},
    observe(_host, event) {
      events.push(event);
    },
    accountChanged(host, value) {
      changes.push({ host, value });
      return Promise.resolve();
    },
  };
  const m = {
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
