const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ...(process.env.TEST_AUTH_FILE
        ? {
            httpCredentials: {
              username: process.env.TEST_AUTH_USER || "codex",
              password: require("node:fs")
                .readFileSync(process.env.TEST_AUTH_FILE, "utf8")
                .trim(),
            },
          }
        : {}),
    });
    await p.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/");
    await p
      .locator("[contenteditable=true]")
      .first()
      .waitFor({ timeout: 60000 });
    await p.locator("[data-app-shell-sidebar-trigger]").first().tap();
    await p
      .locator(".app-shell-left-panel [role=listitem].touch-none")
      .first()
      .waitFor({ timeout: 60000 });
    await p.waitForTimeout(1000);
    const scroll = p.locator(".app-shell-left-panel .overflow-y-auto").first();
    await scroll.evaluate((el) => {
      el.style.setProperty("max-height", "220px", "important");
    });
    // Constrain only layout so this read-only check also works with a short catalog.
    const c = await p.context().newCDPSession(p);
    for (const hold of [0, 650]) {
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await p
        .locator(".app-shell-left-panel [role=listitem].touch-none")
        .first()
        .evaluate((el) =>
          el.scrollIntoView({ block: "center", behavior: "instant" }),
        );
      const before = await scroll.evaluate((el) => el.scrollTop);
      const box = await scroll.boundingBox();
      const xy = await p
        .locator(".app-shell-left-panel [role=listitem].touch-none")
        .evaluateAll((els, box) => {
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const top = Math.max(r.top, box.y);
            const bottom = Math.min(r.bottom, box.y + box.height);
            if (bottom - top > 40)
              return {
                x: r.x + 40,
                y: bottom - 25,
                ta: getComputedStyle(el).touchAction,
              };
          }
        }, box);
      assert(xy, "visible draggable row");
      console.log({ hold, touchAction: xy.ta });
      await c.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: xy.x, y: xy.y }],
      });
      await p.waitForTimeout(hold);
      for (let d = 10; d <= 120; d += 10) {
        await c.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: xy.x, y: xy.y - d }],
        });
        await p.waitForTimeout(20);
      }
      await c.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await p.waitForTimeout(300);
      const top = await scroll.evaluate((el) => el.scrollTop);
      console.log({
        hold,
        scrollTop: top,
        menus: await p.getByRole("menu").count(),
      });
      assert(
        top > before + 20,
        "swipe starting on sidebar row must scroll, including after hold",
      );
      assert.equal(
        await p.getByRole("menu").count(),
        0,
        "swipe must not open a menu",
      );
    }
    await p.setViewportSize({ width: 1280, height: 844 });
    assert.equal(
      await p
        .locator(".app-shell-left-panel [role=listitem].touch-none")
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      "none",
      "desktop drag styling is preserved",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
