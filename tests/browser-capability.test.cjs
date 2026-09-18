const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.resolve(
    __dirname,
    "../scratch/asar/webview/assets/app-initial-236e1501144c.js",
  ),
  "utf8",
);
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert(a >= 0 && b > a, "Review the capability seam after Desktop updates");
  return source.slice(a, b);
}
const body = section(
  "          let n = FTa[e.name];",
  "\n        },\n        { isEqual: PTa }",
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const ready = { isLoading: false, isError: false, isCapable: true };
const unavailable = { ...ready, isCapable: false };

function fixture(state = "enabled") {
  const calls = [];
  const capability = {
    accessPolicies: ["workspace-in-app-browser"],
    statsig: [],
    settings: [],
    configFeatures: [{ key: "in_app_browser", host: "default" }],
  };
  const evaluate = vm.runInNewContext(`(e, t) => {${body}\n}`, {
    FTa: {
      "browser.in-app": capability,
      local: { ...capability, accessPolicies: [], configFeatures: [] },
    },
    NTa: () => true,
    CTa: { "workspace-in-app-browser": "policy" },
    fX: "features",
    oE: "default-host",
  });
  const get = (key) => {
    calls.push(key);
    return key === "policy"
      ? ready
      : {
          isLoading: state === "loading",
          isError: state === "error",
          data:
            state === "enabled"
              ? [{ name: "in_app_browser", enabled: true }]
              : undefined,
        };
  };
  return { check: (name) => plain(evaluate({ name }, get)), calls };
}

test("native browser is unavailable before daemon policy/config reads", () => {
  for (const state of ["enabled", "loading", "error"]) {
    const f = fixture(state);
    assert.deepEqual(f.check("browser.in-app"), unavailable);
    assert.deepEqual(
      f.calls,
      [],
      "unsupported browser must not wait on daemon config",
    );
    assert.deepEqual(
      f.check("local"),
      ready,
      "other capabilities remain available",
    );
  }
});

test("saved native browser tabs are unavailable once capability resolves", () => {
  const f = fixture();
  const c = vm.runInNewContext(
    section("function BFs(e)", "\nvar HFs,") +
      "; ({available: BFs, inApp: VFs})",
    { yX: "capability" },
  );
  const store = { get: (_, { name }) => f.check(name) };
  assert.equal(c.available(store), false);
  assert.equal(c.inApp(store), false);
});

test("web links fall back externally even with a saved in-app preference", () => {
  const route = vm.runInNewContext(
    section("function ETt({", "\nfunction OTt(") + "; DTt",
    { gg: "external-browser", S_: () => false, kTt: () => true },
  );
  const browserPaneEnabled = fixture().check("browser.in-app").isCapable;
  for (const openTarget of [undefined, "in-app-browser", "external-browser"]) {
    assert.equal(
      route({
        browserPaneEnabled,
        url: "https://example.com/",
        openLinkInTargetPreference: "in-app-browser",
        openTarget,
      }),
      "external-browser",
    );
  }
});
