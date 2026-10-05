const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isIsolatedBrowserRequest,
  isUserAppNavigation,
} = require("../src/server/browser-isolation.js");
test("opaque and cross-site previews cannot access application HTTP or WebSocket routes", () => {
  for (const headers of [
    { "x-codex-remote-browser": "1", "sec-fetch-site": "none" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { host: "app.example", origin: "https://evil.example" },
    { host: "app.example", origin: "data:text/html,x" },
  ])
    assert.equal(
      isIsolatedBrowserRequest(headers),
      true,
      JSON.stringify(headers),
    );
  for (const headers of [
    {},
    { "sec-fetch-site": "none" },
    { "sec-fetch-site": "same-origin" },
    { host: "app.example", origin: "https://app.example" },
    { host: "127.0.0.1:18214", origin: "http://127.0.0.1:18214" },
  ])
    assert.equal(
      isIsolatedBrowserRequest(headers),
      false,
      JSON.stringify(headers),
    );
});

test("external app entry only permits intentional top-level known app routes", () => {
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
  };
  for (const url of ["/", "/?prompt=x", "/thread/abc-123"])
    assert.equal(isUserAppNavigation("GET", url, headers), true);
  assert.equal(isUserAppNavigation("GET", "/", { ...headers, "x-codex-remote-browser": "1" }), false);
  for (const url of [
    "/@fs/evil.html",
    "/__backend/download",
    "/assets/a.js",
    "/thread/../@fs/x",
    "/thread/%2e%2e",
    "/unknown",
  ])
    assert.equal(isUserAppNavigation("GET", url, headers), false);
  for (const overrides of [
    { origin: "null" },
    { "sec-fetch-dest": "iframe" },
    { "sec-fetch-mode": "cors" },
    { "sec-fetch-user": undefined },
  ])
    assert.equal(
      isUserAppNavigation("GET", "/", { ...headers, ...overrides }),
      false,
    );
  assert.equal(isUserAppNavigation("POST", "/", headers), false);
});


test("Dot deep links preserve the top-level-only navigation boundary", () => {
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
  };
  for (const url of [
    "/dots", "/dots/home", "/dots/new", "/dots/dot_123?view=chat",
    "/o", "/o/dot-123", "/o/approve", "/o/claim-email",
  ]) {
    assert.equal(isUserAppNavigation("GET", url, headers), true, url);
    for (const override of [
      { origin: "null" },
      { "sec-fetch-dest": "iframe" },
      { "sec-fetch-mode": "websocket" },
      { "sec-fetch-user": undefined },
      { "x-codex-remote-browser": "1" },
    ])
      assert.equal(isUserAppNavigation("GET", url, { ...headers, ...override }), false, url);
    assert.equal(isUserAppNavigation("POST", url, headers), false, url);
    assert.equal(isIsolatedBrowserRequest(headers), true);
  }
  for (const url of [
    "/dots/../__backend/ipc", "/dots/%2e%2e", "/dots/a/b",
    "/dots/%2f__backend", "/o/a/b", "/dots-extra/home",
    "/__backend/ipc", "/dots/", "/o//dot-123",
  ])
    assert.equal(isUserAppNavigation("GET", url, headers), false, url);
});
