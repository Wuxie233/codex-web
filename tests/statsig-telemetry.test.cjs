const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  "scratch/asar/webview/assets/app-initial-236e1501144c.js",
  "utf8",
);
const start = source.indexOf("    e.EventLogger = class e {");
const end = source.indexOf("\n    };", start);
assert(start >= 0 && end > start, "Statsig EventLogger anchor");
const { EventLogger } = vm.runInNewContext(
  source.slice(start, end + 7) + "\ne;",
  {
    e: {},
    f: {
      LoggingEnabledOption: {
        disabled: "disabled",
        browserOnly: "browser-only",
      },
    },
    m: { UrlConfiguration: class {} },
    c: { Endpoint: { _rgstr: "rgstr" } },
    u: { _isServerEnv: () => false },
    d: { _isExposureEvent: () => false },
    s: { Log: { warn() {} } },
  },
);
function logger(mode) {
  return new EventLogger(
    "test-key",
    () => {},
    {},
    { loggingEnabled: mode },
    {},
  );
}
test("disabled telemetry drops events before storage or batching", () => {
  const l = logger("disabled");
  l._normalizeEvent = (e) => e;
  l._storeEventToStorage = () =>
    assert.fail("disabled events must not accumulate in storage");
  l._initFlushCoordinator = () =>
    assert.fail("disabled events must not create a sender");
  l.enqueue({ eventName: "test-event" });
  l.incrementNonExposureCount("test-gate");
  assert.equal(Object.keys(l._nonExposedChecks).length, 0);
});
test("disabled startup does not replay old events or schedule flushes", () => {
  const l = logger("disabled");
  l._initFlushCoordinator = () =>
    assert.fail("disabled startup must not load/retry saved batches");
  l.start();
});
test("enabled logging still enqueues normally", () => {
  const l = logger("browser-only");
  let sent = 0;
  l._normalizeEvent = (e) => e;
  l._initFlushCoordinator = () => ({
    addEvent() {
      sent++;
    },
  });
  l.enqueue({ eventName: "test-event" });
  l.incrementNonExposureCount("test-gate");
  assert.equal(sent, 1);
  assert.equal(l._nonExposedChecks["test-gate"], 1);
});
test("Web client disables event telemetry and retains configuration transport and overrides", () => {
  const from = source.indexOf("      (mWo = {");
  const to = source.indexOf("      (hWo =", from);
  assert(from >= 0 && to > from);
  const options = vm.runInNewContext(
    source.slice(from, to).trim().replace(/,$/, "") + "; mWo;",
    {
      window: { __ELECTRON_SHIM__: { overrideAdapter: "adapter" } },
      lWo: "config-url",
      mzo: "events-url",
      uWo: "exceptions-url",
      LUo: "transport",
    },
  );
  assert.equal(options.loggingEnabled, "disabled");
  assert.equal(options.overrideAdapter, "adapter");
  assert.equal(options.enableLiveValuesAutoRefresh, true);
  assert.equal(options.networkConfig.api, "config-url");
  assert.equal(options.networkConfig.networkOverrideFunc, "transport");
});
