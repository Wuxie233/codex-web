const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { registerDownloadRoute } = require("../src/server/download.js");

test("downloads binary files with safe Chinese attachment names", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-download-test-"));
  const app = Fastify();
  registerDownloadRoute(app);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const filename = '作业 空格";\r\n测试.zip';
  const filePath = path.join(root, filename);
  const bytes = Buffer.from([0x50, 0x4b, 0, 255, 128, 13, 10]);
  await writeFile(filePath, bytes);
  const result = await app.inject({ method: "GET", url: "/__backend/download", query: { path: filePath } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.rawPayload, bytes);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.equal(result.headers["content-length"], String(bytes.length));
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  const disposition = result.headers["content-disposition"];
  assert.match(disposition, /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), filename);
});

test("HTML is an attachment and invalid, missing and directory paths fail", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-download-test-"));
  const app = Fastify();
  registerDownloadRoute(app);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const html = path.join(root, "page.html");
  await writeFile(html, "<script>alert(1)</script>");
  const result = await app.inject({ url: "/__backend/download", query: { path: html } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.match(result.headers["content-disposition"], /^attachment;/);
  for (const [query, status] of [
    [{}, 400], [{ path: "" }, 400], [{ path: "relative.zip" }, 400],
    [{ path: "/tmp/a\0b" }, 400], [{ path: root }, 400],
    [{ path: path.join(root, "missing.zip") }, 404],
    [{ path: path.join(html, "child") }, 404],
  ]) {
    const failure = await app.inject({ url: "/__backend/download", query });
    assert.equal(failure.statusCode, status, JSON.stringify(query));
    assert.equal(failure.headers["cache-control"], "no-store");
  }
  const duplicate = await app.inject({ url: `/__backend/download?path=${encodeURIComponent(html)}&path=${encodeURIComponent(html)}` });
  assert.equal(duplicate.statusCode, 400);
});
