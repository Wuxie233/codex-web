// Run against the deployed service. Never sends a message or creates a task.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const paths = [];
  const pending = [];
  try {
    const credentials = Buffer.from(process.env.TEST_BASIC_AUTH || "", "base64").toString();
    const separator = credentials.indexOf(":");
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ...(process.env.TEST_BASIC_AUTH
        ? {
            httpCredentials: {
              username: credentials.slice(0, separator),
              password: credentials.slice(separator + 1),
            },
          }
        : {}),
    });
    const statuses = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname !== "/__backend/upload") return;
      statuses.push(r.status());
      pending.push(
        r
          .json()
          .then((body) =>
            paths.push(...(body.files || []).map((f) => f.fsPath)),
          ),
      );
    });
    await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/");
    await page
      .locator("[contenteditable=true]")
      .first()
      .waitFor({ timeout: 60000 });
    async function select(files) {
      await page
        .getByRole("button", { name: "添加文件等内容", exact: true })
        .tap();
      const chosen = page.waitForEvent("filechooser");
      await page.getByText("文件和文件夹", { exact: true }).click();
      const chooser = await chosen;
      assert.equal(chooser.isMultiple(), true);
      await chooser.setFiles(files);
    }
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII=",
      "base64",
    );
    await select([
      { name: "upload-probe-a.png", mimeType: "image/png", buffer: png },
      { name: "upload-probe-b.png", mimeType: "image/png", buffer: png },
      {
        name: "upload-probe.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("upload regression"),
      },
    ]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('img[src^="data:image/png"]').length === 2,
      {},
      { timeout: 20000 },
    );
    await page.getByText("upload-probe.txt", { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('img[src^="data:image/png"]')
        .evaluateAll((es) => es.every((e) => e.complete && e.naturalWidth > 0)),
      true,
    );
    await select(
      ["a", "b"].map((x) => ({
        name: `upload-large-${x}.bin`,
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(17 * 1024 * 1024),
      })),
    );
    await page
      .getByText("upload-large-a.bin", { exact: true })
      .waitFor({ timeout: 60000 });
    await page
      .getByText("upload-large-b.bin", { exact: true })
      .waitFor({ timeout: 60000 });
    await Promise.all(pending);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
    assert.equal(paths.length, 5);
    assert.equal(paths.filter((p) => p.endsWith(".png")).length, 2);
    console.log(
      "PASS: mobile multi-select renders two real image previews, one text file, and a 34 MiB two-file selection",
    );
  } finally {
    await browser.close();
    await Promise.allSettled(pending);
    // Cleanup only artifacts returned by this probe on this same machine.
    for (const p of paths)
      if (
        /^\/tmp\/codex-web-uploads-[^/]+\/[a-f0-9-]+(?:\.[a-z0-9]+)?$/.test(p)
      )
        await fs.rm(p, { force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
