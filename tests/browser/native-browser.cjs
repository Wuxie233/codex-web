// Exercise Desktop's real BrowserThreadPanelTab against an isolated running server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);

async function eventually(action, predicate, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(description);
}

(async () => {
  assert(
    process.env.TEST_THREAD_NAME,
    "Set TEST_THREAD_NAME to an existing test chat title",
  );
  const fixture = http.createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Native browser test</title>
      <style>body{margin:0;font:18px sans-serif}button,input,output{position:absolute;left:20px;width:250px;height:40px;box-sizing:border-box}button{top:20px}input{top:80px}output{top:140px}</style>
      <button id="increment">点击计数</button><input id="name" aria-label="名字"><output id="result">0:</output>
      <script>let count=0;const update=()=>result.textContent=count+':'+document.querySelector('#name').value;increment.onclick=()=>{count++;update()};document.querySelector('#name').oninput=update</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  let route;
  let context;
  let annotationStarted = false;
  let annotationCleared = false;
  const errors = [];
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...(process.env.TEST_AUTH_FILE
        ? {
            httpCredentials: {
              username: process.env.TEST_AUTH_USER || "codex",
              password: fs
                .readFileSync(process.env.TEST_AUTH_FILE, "utf8")
                .trim(),
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const sentTurns = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        if (String(payload).includes('"turn/start"'))
          sentTurns.push(String(payload));
      }),
    );
    page.on("request", (request) => {
      if (!request.url().endsWith("/__backend/remote-browser/command")) return;
      const body = request.postDataJSON();
      if (body.action === "navigate" && body.url === fixtureUrl)
        route = {
          conversationId: body.conversationId,
          browserTabId: body.browserTabId,
        };
    });
    await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const sidebar = page.locator("[data-app-shell-sidebar-trigger]");
    await sidebar.waitFor({ timeout: 60000 });
    if ((await sidebar.getAttribute("aria-expanded")) === "false")
      await sidebar.click();
    await page
      .getByRole("button", { name: process.env.TEST_THREAD_NAME, exact: true })
      .click();
    await page.waitForURL(/\/thread\//);
    await page
      .getByText(process.env.TEST_THREAD_NAME, { exact: true })
      .nth(1)
      .waitFor();
    await page
      .getByRole("button", { name: /^(显示\/隐藏侧边面板|Toggle side panel)$/ })
      .click();
    await page.getByRole("button", { name: /^(浏览器|Browser)(\s|$)/ }).click();
    const address = page
      .getByPlaceholder(/搜索或输入网址|Search or enter URL/i)
      .last();
    await address.fill(fixtureUrl);
    await address.press("Enter");
    const viewport = page
      .locator('[data-remote-browser-viewport="true"]:visible')
      .last();
    await viewport.waitFor({ timeout: 30000 });
    await eventually(
      () => route,
      Boolean,
      "native navigation did not reach its backend tab",
    );
    async function command(action, fields = {}) {
      const response = await context.request.post(
        new URL("/__backend/remote-browser/command", page.url()).href,
        {
          data: { ...route, action, ...fields },
        },
      );
      assert(response.ok(), `backend ${action}: ${response.status()}`);
      return response.json();
    }
    await eventually(
      () => command("state"),
      ({ state }) => state.url === fixtureUrl && !state.loading,
      "fixture never finished loading in the native tab",
    );
    await eventually(
      () => viewport.locator("canvas").evaluate((canvas) => canvas.width),
      (width) => width > 300,
      "native viewport did not receive a frame",
    );
    async function clickRemote(x, y) {
      const { state } = await command("state");
      const bounds = await viewport.boundingBox();
      await page.mouse.click(
        bounds.x + (x / state.width) * bounds.width,
        bounds.y + (y / state.height) * bounds.height,
      );
    }
    await clickRemote(60, 40);
    await clickRemote(60, 100);
    await page.keyboard.insertText("中文输入成功");
    await eventually(
      () => command("inspect", { x: 80, y: 160 }),
      ({ value }) => value?.text === "1:中文输入成功",
      "native click/Chinese input did not change the same backend page",
    );
    assert.equal(
      await page.getByRole("dialog", { name: "浏览器", exact: true }).count(),
      0,
      "browser must remain a native sidebar, not a replacement dialog",
    );
    assert.equal(await page.locator('iframe[title="网页预览"]').count(), 0);

    async function nativeCommentCounts() {
      return page.evaluate((fixtureUrl) => {
        const groups =
          window.electronBridge.getSharedObjectSnapshotValue("diff_comments") ||
          {};
        const comments = Object.values(groups).flatMap((value) =>
          Array.isArray(value) ? value : [],
        );
        return {
          own: comments.filter(
            (comment) => comment.localBrowserContext?.pageUrl === fixtureUrl,
          ).length,
          browser: comments.filter((comment) => comment.localBrowserContext)
            .length,
        };
      }, fixtureUrl);
    }
    assert.equal(
      (await nativeCommentCounts()).browser,
      0,
      "Use a test task with no existing browser annotations; preserve user attachments",
    );
    await page.evaluate((fixtureUrl) => {
      window.__nativeBrowserCommentStates = [];
      window.__nativeBrowserCommentAcks = [];
      window.addEventListener("message", ({ data }) => {
        if (
          data?.type === "shared-object-updated" &&
          data.key === "diff_comments"
        )
          window.__nativeBrowserCommentAcks.push(
            Object.values(data.value || {})
              .flatMap((value) => (Array.isArray(value) ? value : []))
              .filter(
                (comment) =>
                  comment.localBrowserContext?.pageUrl === fixtureUrl,
              ).length,
          );
        if (data?.type === "browser-sidebar-state")
          window.__nativeBrowserCommentStates.push({
            conversationId: data.conversationId,
            browserTabId: data.browserTabId,
            count: data.snapshot?.comments?.length,
          });
      });
    }, fixtureUrl);

    await page
      .getByRole("button", { name: /^(Annotate|注释|添加注释|标注)$/ })
      .click();
    await clickRemote(60, 40);
    const comment = page.getByRole("textbox", {
      name: "网页备注",
      exact: true,
    });
    await comment.fill("请把这个按钮移到右边");
    annotationStarted = true;
    await page.getByRole("button", { name: "添加到对话", exact: true }).click();
    await comment.waitFor({ state: "detached" });
    const removeAnnotation = page.getByRole("button", {
      name: /^(移除注释附件|Remove annotations attachment)$/,
    });
    await removeAnnotation.waitFor({ timeout: 15000 });
    await eventually(
      nativeCommentCounts,
      ({ own }) => own === 1,
      "one annotation must create exactly one native composer attachment",
    );
    await page
      .getByText(/^(\d+ 条注释|\d+ annotations?)$/)
      .last()
      .hover();
    const annotationBody = page.getByText("请把这个按钮移到右边", {
      exact: true,
    });
    await annotationBody.waitFor({ timeout: 15000 });
    if (process.env.TEST_ANNOTATION_SCREENSHOT_PATH)
      await annotationBody
        .locator('xpath=ancestor::*[@role="dialog"][1]')
        .screenshot({
          path: process.env.TEST_ANNOTATION_SCREENSHOT_PATH,
        });
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      window.__nativeBrowserCommentStates = [];
      window.__nativeBrowserCommentAcks = [];
    });
    await removeAnnotation.click();
    await removeAnnotation.waitFor({ state: "detached" });
    await page.waitForFunction(
      (route) =>
        window.__nativeBrowserCommentStates.some(
          (state) =>
            state.conversationId === route.conversationId &&
            state.browserTabId === route.browserTabId &&
            state.count === 0,
        ),
      route,
    );
    await eventually(
      nativeCommentCounts,
      ({ own, browser }) => own === 0 && browser === 0,
      "removing the native attachment must clear its browser comments",
    );
    await page.waitForFunction(() =>
      window.__nativeBrowserCommentAcks.includes(0),
    );
    annotationCleared = true;
    assert.equal(
      sentTurns.length,
      0,
      "adding a browser annotation must never submit a chat turn",
    );
    assert.deepEqual(
      errors,
      [],
      "native sidebar must not throw renderer errors",
    );
    if (process.env.TEST_SCREENSHOT_PATH)
      await page.screenshot({ path: process.env.TEST_SCREENSHOT_PATH });
    console.log(
      "PASS: native sidebar URL navigation, real page click, Chinese input, same-tab readback, one unsent native annotation preview and reverse-clear",
    );
  } catch (error) {
    if (errors.length) console.error("Renderer errors:", errors);
    if (process.env.TEST_SCREENSHOT_PATH && context?.pages()[0])
      await context
        .pages()[0]
        .screenshot({ path: process.env.TEST_SCREENSHOT_PATH });
    throw error;
  } finally {
    if (
      annotationStarted &&
      !annotationCleared &&
      route &&
      context?.pages()[0]
    ) {
      const page = context.pages()[0];
      const needsAck = await page
        .evaluate(
          ({ route, fixtureUrl }) => {
            const groups =
              window.electronBridge.getSharedObjectSnapshotValue(
                "diff_comments",
              ) || {};
            const needsAck =
              window.__nativeBrowserCommentAcks?.at(-1) > 0 ||
              Object.values(groups).some(
                (value) =>
                  Array.isArray(value) &&
                  value.some(
                    (comment) =>
                      comment.localBrowserContext?.pageUrl === fixtureUrl,
                  ),
              );
            window.__nativeBrowserCommentAcks = [];
            window.electronBridge.sendMessageFromView({
              type: "browser-sidebar-command",
              ...route,
              command: { type: "clear-comments" },
            });
            return needsAck;
          },
          { route, fixtureUrl },
        )
        .catch(() => false);
      await page
        .waitForFunction(
          ({ fixtureUrl, needsAck }) => {
            const groups =
              window.electronBridge.getSharedObjectSnapshotValue(
                "diff_comments",
              ) || {};
            return (
              (!needsAck || window.__nativeBrowserCommentAcks.includes(0)) &&
              !Object.values(groups).some(
                (value) =>
                  Array.isArray(value) &&
                  value.some(
                    (comment) =>
                      comment.localBrowserContext?.pageUrl === fixtureUrl,
                  ),
              )
            );
          },
          { fixtureUrl, needsAck },
          { timeout: 10000 },
        )
        .catch((error) => {
          console.error("Test annotation cleanup failed:", error.message);
          process.exitCode = 1;
        });
    }
    if (context && route) {
      await context.request
        .post(
          new URL(
            "/__backend/remote-browser/command",
            process.env.TEST_BASE_URL || "http://127.0.0.1:8214/",
          ).href,
          { data: { ...route, action: "close" } },
        )
        .catch(() => {});
    }
    await browser.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
