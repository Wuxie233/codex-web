const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  assert(
    process.env.TEST_THREAD_NAME,
    "Set TEST_THREAD_NAME to an existing chat title",
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .locator("[data-app-shell-sidebar-trigger]")
      .waitFor({ timeout: 60000 });
    await page
      .getByRole("button", { name: process.env.TEST_THREAD_NAME, exact: true })
      .click();
    const sidePanel = page.getByRole("button", {
      name: /^(显示\/隐藏侧边面板|Toggle side panel)$/,
    });
    await sidePanel.click();
    await page.getByRole("button", { name: /^(终端|Terminal)/ }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: /^(浏览器|Browser)(\s|$)/ })
        .count(),
      0,
      "native browser launcher must not be offered",
    );
    assert.equal(
      await page
        .getByPlaceholder(/搜索或输入网址|Search or enter URL/i)
        .count(),
      0,
      "saved native browser tabs must not mount",
    );
    await sidePanel.click();

    // Exercise the real preload IPC bridge under user activation, without relying
    // on third-party site availability or changing the conversation contents.
    await context.route("https://example.com/", (route) =>
      route.fulfill({ body: "external-link fixture" }),
    );
    let popups = 0;
    page.on("popup", () => popups++);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "external-browser-test";
      button.textContent = "External browser test";
      Object.assign(button.style, {
        position: "fixed",
        top: "0",
        left: "0",
        zIndex: "2147483647",
      });
      button.onclick = () =>
        window.electronBridge.sendMessageFromView({
          type: "open-in-browser",
          url: "https://example.com/",
        });
      document.body.append(button);
    });
    const popupPromise = page.waitForEvent("popup");
    await page.locator("#external-browser-test").click();
    const popup = await popupPromise;
    await popup.waitForURL("https://example.com/");
    await page.waitForTimeout(1500);
    assert.equal(popups, 1, "one activation should open one external tab");
    assert.equal(
      await page
        .getByPlaceholder(/搜索或输入网址|Search or enter URL/i)
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
    await page.evaluate(() =>
      document.querySelector("#external-browser-test").remove(),
    );
    console.log(
      "PASS: native launcher absent, no restored native surface, external tab opens once, no page errors",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
