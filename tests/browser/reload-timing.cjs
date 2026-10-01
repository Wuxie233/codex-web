// Measure the real composer, without sending a turn or disabling HTTP cache.
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    const page = await context.newPage();
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/", {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator("[contenteditable=true]")
        .first()
        .waitFor({ timeout: 60000 });
      const result = await page.evaluate(() => ({
        readyMs: Math.round(performance.now()),
        firstPaintMs: Math.round(
          performance.getEntriesByName("first-contentful-paint")[0]
            ?.startTime || 0,
        ),
        bootstrapCacheChars:
          sessionStorage.getItem("codex-web:statsig-bootstrap:v1")?.length || 0,
      }));
      console.log(
        JSON.stringify({ load: attempt === 0 ? "cold" : "warm", ...result }),
      );
      if (
        attempt &&
        process.env.MAX_WARM_READY_MS &&
        result.readyMs > Number(process.env.MAX_WARM_READY_MS)
      ) {
        throw new Error(
          `Warm composer readiness ${result.readyMs}ms exceeds ${process.env.MAX_WARM_READY_MS}ms`,
        );
      }
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
