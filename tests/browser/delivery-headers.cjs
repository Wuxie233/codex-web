const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
(async () => {
  const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8214";
  for (const file of [
    "index.html",
    "assets/app-initial-236e1501144c.js",
    "assets/app-primary-6b28e06666ff.js",
  ]) {
    const expected = await fs.readFile(
      "scratch/webview-delivery/" + file,
      "utf8",
    );
    for (const encoding of ["identity", "gzip", "br, gzip"]) {
      const response = await fetch(base + "/" + file, {
        headers: { "Accept-Encoding": encoding },
      });
      assert.equal(response.status, 200);
      assert.equal(
        await response.text(),
        expected,
        `${file}: optimized bytes must be served for ${encoding}`,
      );
      const cached = await fetch(base + "/" + file, {
        headers: {
          "Accept-Encoding": encoding,
          "If-None-Match": response.headers.get("etag"),
          "Cache-Control": "max-age=0",
        },
      });
      assert.equal(cached.status, 304);
    }
  }
  console.log(
    "PASS: optimized HTML/JS for identity, gzip and Brotli; conditional requests return 304",
  );
})().catch((error) => {
  console.error(error.message.slice(0, 200));
  process.exitCode = 1;
});
