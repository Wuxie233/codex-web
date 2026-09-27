const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, mkdir, symlink, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const {
  registerBrowserPreviewRoutes,
} = require("../src/server/browser-preview.js");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-preview-"));
  const directory = path.join(root, "site");
  await mkdir(directory);
  const htmlPath = path.join(directory, "页面 one.html");
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><title>Preview</title></head><body><h1>Rendered</h1><a href="next.html">Next</a></body></html>',
  );
  const app = Fastify();
  registerBrowserPreviewRoutes(app);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = (file = htmlPath) =>
    app.inject({
      method: "POST",
      url: "/__backend/browser-preview",
      payload: { path: file },
    });
  return { root, directory, htmlPath, app, create };
}

test("HTML preview preserves doctype, adds navigation, and serves scoped assets with correct types", async (t) => {
  const { directory, htmlPath, app, create } = await fixture(t);
  const created = await create();
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().path, htmlPath);
  const url = created.json().url;
  assert.match(url, /^\/__backend\/browser-preview\/[a-f0-9]{48}\//);
  const page = await app.inject(url);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.ok(page.body.startsWith("<!doctype html>"));
  assert.match(page.body, /<h1>Rendered<\/h1>/);
  assert.match(page.body, /codex-preview-navigate/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["access-control-allow-origin"], "*");
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /sandbox allow-scripts;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.ok(
    csp.includes(
      `http://localhost:80${url.substring(0, url.lastIndexOf("/") + 1)}`,
    ) ||
      csp.includes(
        `http://localhost${url.substring(0, url.lastIndexOf("/") + 1)}`,
      ),
  );
  const prefix = url.substring(0, url.lastIndexOf("/") + 1);
  for (const [filename, body, type] of [
    ["style.css", "h1 { color: red; }", "text/css"],
    ["module.mjs", "export const value = 7;", "text/javascript"],
    ["data.json", '{"ok":true}', "application/json"],
    ["icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"],
    ["next.html", "<h1>Next page</h1>", "text/html"],
  ]) {
    await writeFile(path.join(directory, filename), body);
    const result = await app.inject(prefix + filename);
    assert.equal(result.statusCode, 200, filename);
    assert.ok(result.headers["content-type"].startsWith(type), filename);
    assert.ok(result.body.includes(body), filename);
    assert.equal(result.headers["content-security-policy"], csp);
  }
  const head = await app.inject({ method: "HEAD", url });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
});

test("invalid paths, missing files, directories and escapes fail without leaking filesystem details", async (t) => {
  const { root, directory, app, create } = await fixture(t);
  for (const [file, status] of [
    ["relative.html", 400],
    ["https://example.com/a.html", 400],
    ["/tmp/a\0.html", 400],
    [path.join(directory, "missing.html"), 404],
    [path.join(directory, "a.txt"), 400],
  ]) {
    const result = await create(file);
    assert.equal(result.statusCode, status);
    assert.ok(!result.body.includes(root));
  }
  await mkdir(path.join(directory, "dir.html"));
  assert.equal(
    (await create(path.join(directory, "dir.html"))).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/__backend/browser-preview",
        payload: {},
      })
    ).statusCode,
    400,
  );
  const url = (await create()).json().url;
  const prefix = url.substring(0, url.lastIndexOf("/") + 1);
  await writeFile(path.join(root, "private.html"), "outside-secret");
  await symlink(
    path.join(root, "private.html"),
    path.join(directory, "escape.html"),
  );
  await symlink(root, path.join(directory, "outside"));
  await mkdir(path.join(directory, "folder"));
  for (const [suffix, status] of [
    ["%2e%2e%2fprivate.html", 403],
    ["%2fetc%2fpasswd", 403],
    ["a%00b", 403],
    ["escape.html", 403],
    ["outside/private.html", 403],
    ["folder", 404],
    ["missing.css", 404],
    ["%5c..%5cprivate.html", 403],
  ]) {
    const response = await app.inject(prefix + suffix);
    assert.equal(response.statusCode, status, suffix);
    assert.ok(!response.body.includes("outside-secret"));
    assert.ok(!response.body.includes(root));
  }
  const unknown = await app.inject(
    "/__backend/browser-preview/unknown/file.html",
  );
  assert.equal(unknown.statusCode, 404);
});

test("navigation injection does not mistake comments or JavaScript strings for the document head", async (t) => {
  const { htmlPath, app, create } = await fixture(t);
  for (const preamble of [
    "<!doctype html>",
    "<!-- <head> example -->\n<!doctype html>",
  ]) {
    const originalScript = '<script>const template="<head>";</script>';
    await writeFile(
      htmlPath,
      preamble + originalScript + "<main>Still rendered</main>",
    );
    const page = await app.inject((await create()).json().url);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.startsWith(preamble + "<script>"));
    assert.ok(page.body.includes(originalScript));
    assert.ok(
      page.body.indexOf("codex-preview-navigate") <
        page.body.indexOf(originalScript),
    );
  }
});

test("capabilities expire after thirty minutes and only 128 are retained", async (t) => {
  const { app, create } = await fixture(t);
  const first = (await create()).json().url;
  let latest;
  for (let i = 0; i < 128; i++) latest = (await create()).json().url;
  assert.equal((await app.inject(first)).statusCode, 404);
  assert.equal((await app.inject(latest)).statusCode, 200);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 30 * 60 * 1000 + 100;
    assert.equal((await app.inject(latest)).statusCode, 410);
  } finally {
    Date.now = originalNow;
  }
});
