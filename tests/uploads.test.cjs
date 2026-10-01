const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { registerUploadRoutes } = require("../src/server/uploads.js");

async function setup(t, maxFileBytes) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "codex-upload-test-"));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await registerUploadRoutes(app, { root, maxFileBytes });
  return { root, app };
}

function multipart(files, complete = true) {
  const boundary = "codex-upload-test-boundary";
  const parts = files.flatMap(
    ({ name, bytes, type = "application/octet-stream" }) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from("\r\n"),
    ],
  );
  if (complete) parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    method: "POST",
    url: "/__backend/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

test("mixed image and document batch retains ordered labels, suffixes and exact bytes", async (t) => {
  const { app, root } = await setup(t);
  const input = [
    {
      name: "照片.PNG",
      type: "image/png",
      bytes: Buffer.from([137, 80, 78, 71, 0, 255]),
    },
    { name: "报告.pdf", bytes: "%PDF-fixture" },
    { name: "照片.PNG", type: "image/png", bytes: "second-image" },
    { name: "README", bytes: "extensionless file" },
  ];
  const response = await app.inject(multipart(input));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const { files } = response.json();
  assert.equal(files.length, input.length);
  assert.equal(new Set(files.map((f) => f.path)).size, input.length);
  for (const [i, file] of files.entries()) {
    assert.equal(file.label, input[i].name);
    assert.equal(file.path, file.fsPath);
    assert.equal(path.dirname(file.path), root);
    assert.equal(
      path.extname(file.path),
      path.extname(input[i].name).toLowerCase(),
    );
    assert.deepEqual(await fs.readFile(file.path), Buffer.from(input[i].bytes));
  }
});

test("size limit rejects oversized second file and removes all request files", async (t) => {
  const { app, root } = await setup(t, 16);
  await fs.writeFile(path.join(root, "existing.txt"), "keep");
  const result = await app.inject(
    multipart([
      { name: "first.png", bytes: "ok" },
      { name: "large.pdf", bytes: Buffer.alloc(17) },
    ]),
  );
  assert.equal(result.statusCode, 413, result.body);
  assert.deepEqual(await fs.readdir(root), ["existing.txt"]);
});

test("malformed multipart removes completed and partial files", async (t) => {
  const { app, root } = await setup(t);
  const result = await app.inject(
    multipart(
      [
        { name: "first.png", bytes: "ok" },
        { name: "partial.pdf", bytes: "unfinished" },
      ],
      false,
    ),
  );
  assert.ok(result.statusCode >= 400, result.body);
  assert.deepEqual(await fs.readdir(root), []);
});

test("untrusted names stay under upload root and unsafe extensions are dropped", async (t) => {
  const { app, root } = await setup(t);
  const result = await app.inject(
    multipart([
      { name: "../../image.jpg", bytes: "image" },
      { name: "strange.bad suffix", bytes: "file" },
    ]),
  );
  assert.equal(result.statusCode, 200);
  const { files } = result.json();
  assert.equal(path.extname(files[0].path), ".jpg");
  assert.equal(path.extname(files[1].path), "");
  for (const file of files) assert.equal(path.dirname(file.path), root);
});

test("non-multipart body is rejected without writing files", async (t) => {
  const { app, root } = await setup(t);
  const result = await app.inject({
    method: "POST",
    url: "/__backend/upload",
    payload: { files: [] },
  });
  assert.equal(result.statusCode, 400);
  assert.deepEqual(await fs.readdir(root), []);
});
