const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness() {
  const listeners = {};
  const messages = [];
  const window = {
    location: { pathname: "/", search: "", hash: "" },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    dispatchEvent: (event) => { messages.push(event.data); },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(
    fs.readFileSync("src/browser/routes.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText, { exports, window, URLSearchParams, MessageEvent });
  return { api: exports, window, listeners, messages };
}

test("native Dot, cloud, and settings links survive reload with query and hash", () => {
  const { api } = harness();
  for (const path of ["/dots/home", "/dots/new", "/dots/abc", "/o/abc", "/remote/task-1", "/cloud-environments/new", "/settings/computers"]) {
    const initial = api.mapBrowserPathToInitialRoute(path, "?tab=computer", "#permission");
    assert.equal(initial.memoryPath, `${path}?tab=computer#permission`);
    assert.equal(api.mapMemoryPathToBrowserPath(path, "?tab=computer", "#permission").path, initial.memoryPath);
  }
});

test("legacy local links and share target preserve existing behavior", () => {
  const { api } = harness();
  assert.equal(api.mapBrowserPathToInitialRoute("/thread/abc", "").memoryPath, "/local/abc");
  assert.equal(api.mapMemoryPathToBrowserPath("/local/abc").path, "/thread/abc");
  assert.equal(api.mapBrowserPathToInitialRoute("/thread/%ZZ", "").memoryPath, "/");
  const shared = api.mapBrowserPathToInitialRoute("/share/receive", "?text=hello");
  assert.equal(new URLSearchParams(shared.memoryPath.split("?")[1]).get("prompt"), "text: hello");
  assert.equal(shared.browserPath, "/");
});

test("browser back navigation sends the full native route to the official router", () => {
  const { window, listeners, messages } = harness();
  Object.assign(window.location, { pathname: "/dots/abc", search: "?tab=computer", hash: "#permission" });
  listeners.popstate();
  assert.equal(messages[0].type, "navigate-to-route");
  assert.equal(messages[0].path, "/dots/abc?tab=computer#permission");
});
