const assert = require("node:assert/strict");
const threadRows = ".app-shell-left-panel [data-app-action-sidebar-thread-row]";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const touchOptions = {
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
    };
    for (const width of [390, 820, 1280]) {
      const p = await b.newPage({
        ...touchOptions,
        viewport: { width, height: 844 },
      });
      await p.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/", {
        waitUntil: "domcontentloaded",
      });
      await p
        .locator("[contenteditable=true]")
        .first()
        .waitFor({ timeout: 60000 });
      if (width <= 768)
        await p.locator("[data-app-shell-sidebar-trigger]").first().tap();
      await p
        .locator('.app-shell-left-panel [class~="group/folder-row"]')
        .first()
        .waitFor({ timeout: 60000 });
      // Expand the first project with loaded chats; never mistake project rows for chats.
      if ((await p.locator(threadRows).count()) === 0) {
        const projects = p.locator(
          '.app-shell-left-panel [class~="group/folder-row"]',
        );
        for (let index = 0; index < (await projects.count()); index++) {
          await projects.nth(index).tap({ position: { x: 40, y: 22 } });
          try {
            await p.locator(threadRows).first().waitFor({ timeout: 4000 });
            break;
          } catch {}
        }
      }
      await p.locator(threadRows).first().waitFor({ timeout: 60000 });
      await p.waitForTimeout(1000);
      const scroll = p
        .locator(".app-shell-left-panel .overflow-y-auto")
        .first();
      await scroll.evaluate((el) => {
        el.style.setProperty("max-height", "220px", "important");
      });
      // Constrain only layout so this read-only check also works with a short catalog.
      const c = await p.context().newCDPSession(p);
      for (const hold of [0, 650, 850]) {
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
        });
        await p
          .locator(threadRows)
          .first()
          .evaluate((el) =>
            el.scrollIntoView({ block: "center", behavior: "instant" }),
          );
        const before = await scroll.evaluate((el) => el.scrollTop);
        const box = await scroll.boundingBox();
        const xy = await p.locator(threadRows).evaluateAll((els, box) => {
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const top = Math.max(r.top, box.y);
            const bottom = Math.min(r.bottom, box.y + box.height);
            if (bottom - top > 40)
              return {
                x: r.x + 40,
                y: bottom - 25,
                ta: getComputedStyle(el.closest(".touch-none") || el)
                  .touchAction,
              };
          }
        }, box);
        assert(xy, "visible draggable row");
        assert.equal(
          xy.ta,
          "pan-y pinch-zoom",
          "touch rows allow native scrolling at every width",
        );
        console.log({ width, hold, touchAction: xy.ta });
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
      const more = p
        .locator(
          '.app-shell-left-panel .sidebar-item .absolute button[aria-haspopup="menu"]',
        )
        .first();
      await more.waitFor({ timeout: 60000 });
      await more.tap();
      await p.getByRole("menu").first().waitFor();
      if (process.env.TEST_ARTIFACT_DIR) {
        require("node:fs").mkdirSync(process.env.TEST_ARTIFACT_DIR, {
          recursive: true,
        });
        await p.screenshot({
          path: `${process.env.TEST_ARTIFACT_DIR}/sidebar-menu-${width}.png`,
        });
      }
      await p.keyboard.press("Escape");
      await p.getByRole("menu").first().waitFor({ state: "hidden" });
      await c.detach();
      await p.close();
    }
    const p = await b.newPage({
      ...touchOptions,
      viewport: { width: 1280, height: 844 },
      isMobile: false,
      hasTouch: false,
    });
    await p.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/", {
      waitUntil: "domcontentloaded",
    });
    await p
      .locator(".app-shell-left-panel [role=listitem].touch-none")
      .first()
      .waitFor({ timeout: 60000 });
    assert.equal(
      await p
        .locator(".app-shell-left-panel [role=listitem].touch-none")
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      "none",
      "mouse-only desktop drag styling is preserved",
    );
    assert.equal(
      await p.evaluate(() => {
        const button = document.createElement("button");
        button.className = "codex-web-sidebar-more";
        document.querySelector(".app-shell-left-panel").append(button);
        const display = getComputedStyle(button).display;
        button.remove();
        return display;
      }),
      "none",
      "touch-only fallback menu stays hidden on desktop",
    );
    const hiddenTitleActions = p
      .locator(
        '.app-shell-left-panel [class~="group/nav-section-title"] .pointer-events-none:has(button)',
      )
      .first();
    assert.equal(
      await hiddenTitleActions.evaluate((el) => getComputedStyle(el).opacity),
      "0",
      "desktop title actions remain hover-only",
    );
    await p
      .locator(".app-shell-left-panel [role=listitem].touch-none")
      .first()
      .click({ button: "right" });
    await p.getByRole("menu").first().waitFor();
    await p.keyboard.press("Escape");
    await p.getByRole("menu").first().waitFor({ state: "hidden" });
    await p.close();
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
