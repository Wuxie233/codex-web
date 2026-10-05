const { test } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const {
  parseDotEmbedParentOrigin,
  isDotEmbedNavigation,
  registerDotEmbed,
} = require("../src/server/dot-embed.js");
const {
  isIsolatedBrowserRequest,
  isUserAppNavigation,
} = require("../src/server/browser-isolation.js");
const parent = "https://codex.example";
const headers = {
  referer: parent + "/work",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "iframe",
};
function app(origin) {
  const app = Fastify();
  registerDotEmbed(
    app,
    origin,
    async () => "<html><head></head><body>native</body></html>",
  );
  app.addHook("onRequest", async (req, reply) => {
    if (
      isIsolatedBrowserRequest(req.headers) &&
      !isUserAppNavigation(req.method, req.url, req.headers)
    )
      return reply.code(403).send("blocked");
  });
  app.get("/*", async (req, reply) =>
    req.url === "/asset.js"
      ? "asset"
      : reply
          .type("text/html")
          .header("content-security-policy", "script-src 'self'")
          .send("<html><head></head><body>normal</body></html>"),
  );
  return app;
}
test("configuration requires one exact origin", () => {
  assert.equal(parseDotEmbedParentOrigin(undefined), undefined);
  assert.equal(parseDotEmbedParentOrigin(parent), parent);
  for (const value of [
    "",
    parent + "/",
    parent + "/path",
    parent + "?x",
    parent + "#x",
    "https://a@codex.example",
    "file:///tmp",
    "https://a https://b",
  ])
    assert.throws(() => parseDotEmbedParentOrigin(value));
});
test("embed grant only exact Dot iframe document from selected parent", () => {
  for (const url of ["/dots", "/dots/home", "/dots/dot_123"])
    assert.equal(isDotEmbedNavigation(parent, "GET", url, headers), true);
  for (const url of [
    "/",
    "/thread/a",
    "/o/a",
    "/dots/home?x",
    "/dots/home/",
    "/dots/../home",
    "/dots/%68ome",
    "/__backend/ipc",
    "/asset.js",
  ])
    assert.equal(isDotEmbedNavigation(parent, "GET", url, headers), false);
  for (const patch of [
    { referer: "https://evil.example/" },
    { origin: "null" },
    { origin: "https://evil.example" },
    { "sec-fetch-dest": "document" },
    { "sec-fetch-mode": "cors" },
    { "x-codex-remote-browser": "1" },
  ])
    assert.equal(
      isDotEmbedNavigation(parent, "GET", "/dots/home", {
        ...headers,
        ...patch,
      }),
      false,
    );
  assert.equal(
    isDotEmbedNavigation(parent, "POST", "/dots/home", headers),
    false,
  );
});
test("real hooks grant HTML only and keep API/assets isolated; own origin is unchanged", async () => {
  const server = app(parent);
  try {
    const granted = await server.inject({ url: "/dots/home", headers });
    assert.equal(granted.statusCode, 200);
    assert.match(granted.body, /codex-dot-embed/);
    assert.equal(granted.headers["cache-control"], "no-store");
    assert.match(
      String(granted.headers["content-security-policy"]),
      /frame-ancestors 'self' https:\/\/codex.example/,
    );
    for (const url of ["/asset.js", "/__backend/ipc", "/__backend/config"])
      assert.equal((await server.inject({ url, headers })).statusCode, 403);
    const own = await server.inject({
      url: "/asset.js",
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(own.statusCode, 200);
    assert.equal(own.body, "asset");
    const normal = await server.inject({
      url: "/dots/home",
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.doesNotMatch(normal.body, /codex-dot-embed/);
    assert.match(
      String(normal.headers["content-security-policy"]),
      /script-src 'self'/,
    );
    assert.match(
      String(normal.headers["content-security-policy"]),
      /frame-ancestors/,
    );
  } finally {
    await server.close();
  }
});
test("unset opt-in leaves original isolation and HTML untouched", async () => {
  const server = app(undefined);
  try {
    assert.equal(
      (await server.inject({ url: "/dots/home", headers })).statusCode,
      403,
    );
    const own = await server.inject({ url: "/dots/home" });
    assert.doesNotMatch(own.body, /codex-dot-embed/);
    assert.equal(own.headers["content-security-policy"], "script-src 'self'");
  } finally {
    await server.close();
  }
});

test("nested own-origin HTML permits self and selected parent while retaining existing CSP", async () => {
  const server = app(parent);
  try {
    const nested = await server.inject({
      url: "/orbit/frame.html",
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
      },
    });
    assert.equal(nested.statusCode, 200);
    assert.deepEqual(nested.headers["content-security-policy"], [
      "script-src 'self'",
      "frame-ancestors 'self' https://codex.example",
    ]);
    assert.doesNotMatch(nested.body, /codex-dot-embed/);
    assert.equal(
      (await server.inject({ url: "/orbit/frame.html", headers })).statusCode,
      403,
    );
  } finally {
    await server.close();
  }
});
