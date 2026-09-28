const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../src/browser/remote-browser.ts"),
  "utf8",
);
const moduleObject = { exports: {} };
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
vm.runInNewContext(compiled, {
  exports: moduleObject.exports,
  module: moduleObject,
  fetch,
  setTimeout,
  clearTimeout,
  Error,
  Promise,
  crypto: require("node:crypto").webcrypto,
});
const {
  createRemoteBrowserBridge,
  toNativeBrowserSnapshot,
  toNativeBrowserComment,
} = moduleObject.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const route = { conversationId: "task-one", browserTabId: "tab-one" };
const initial = {
  ...route,
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 1000,
  height: 700,
  closed: false,
};

function fixture(handler = () => ({})) {
  const events = [];
  const requests = [];
  const states = new Map();
  const bridge = createRemoteBrowserBridge({
    emitMessage: (event) => events.push(plain(event)),
    request: async (_, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const override = await handler(body);
      if (override.error)
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: override.error }),
        };
      const id = `${body.conversationId}:${body.browserTabId}`;
      const state = {
        ...initial,
        ...(states.get(id) ?? {}),
        conversationId: body.conversationId,
        browserTabId: body.browserTabId,
      };
      if (body.action === "navigate") {
        state.url = body.url;
        state.title = "Loaded page";
        state.canGoBack = true;
      }
      if (body.action === "close") state.closed = true;
      if (body.action === "transfer") {
        states.delete(id);
        state.conversationId = body.targetConversationId;
        state.browserTabId = body.targetBrowserTabId;
        states.set(`${state.conversationId}:${state.browserTabId}`, state);
        return { ok: true, json: async () => ({ state }) };
      }
      states.set(id, state);
      return { ok: true, json: async () => ({ state }) };
    },
  });
  return { bridge, events, requests };
}

test("real navigation drives Desktop's address, title, history and loading state", () => {
  const snapshot = plain(
    toNativeBrowserSnapshot({
      ...initial,
      url: "https://example.test/next",
      title: "Next page",
      loading: true,
      canGoBack: true,
    }),
  );
  assert.equal(snapshot.tabType, "web");
  assert.equal(snapshot.url, "https://example.test/next");
  assert.equal(snapshot.title, "Next page");
  assert.equal(snapshot.canGoBack, true);
  assert.equal(snapshot.isLoading, true);
  assert.equal(snapshot.interactionMode, "browse");
  assert.equal(plain(toNativeBrowserSnapshot(initial)).tabType, "new-tab-page");
});

test("browser annotations retain the selected page, scrolled region and image without a send event", () => {
  const comment = plain(
    toNativeBrowserComment(
      { ...initial, url: "https://example.test/details" },
      {
        x: 20,
        y: 40,
        width: 80,
        height: 60,
        value: {
          tagName: "BUTTON",
          label: "购买",
          selector: "#buy",
          role: "button",
          scrollY: 300,
          text: "购买商品",
        },
      },
      "把这个按钮移到右边",
      { mimeType: "image/png", data: "AA==" },
      "dark",
    ),
  );
  assert.equal(comment.anchor.pageUrl, "https://example.test/details");
  assert.equal(comment.anchor.selector, "#buy");
  assert.equal(comment.anchor.rect.y, 340);
  assert.equal(comment.screenshot.annotationViewportRect.y, 40);
  assert.equal(comment.screenshot.dataUrl, "data:image/png;base64,AA==");
  assert.equal(comment.body, "把这个按钮移到右边");
  const snapshot = plain(toNativeBrowserSnapshot(initial, "browse", [comment]));
  assert.equal(snapshot.comments[0].id, comment.id);
  assert.equal(snapshot.interactionMode, "browse");
});

test("native commands open once and preserve independent task/tab ownership", async () => {
  const { bridge, events, requests } = fixture();
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "navigate", url: "https://first.test" },
  });
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "reload" },
  });
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    browserTabId: "tab-two",
    command: { type: "navigate", url: "https://second.test" },
  });
  assert.deepEqual(
    requests.map((r) => r.action),
    ["open", "navigate", "reload", "open", "navigate"],
  );
  assert.equal(events.at(-1).browserTabId, "tab-two");
  assert.equal(events.at(-1).snapshot.url, "https://second.test");
  assert.equal(bridge.handleMessage({ type: "unrelated" }), undefined);
  bridge.dispose();
});

test("a failed navigation does not poison the page's subsequent action queue", async () => {
  const { bridge, events, requests } = fixture((body) =>
    body.action === "navigate" ? { error: "Navigation failed" } : {},
  );
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "navigate", url: "https://failure.test" },
  });
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "reload" },
  });
  assert.equal(requests.at(-1).action, "reload");
  assert.equal(events.at(-1).type, "browser-sidebar-state");
  bridge.dispose();
});

test("host registration rejects stale generations and unknown renderer sessions", async () => {
  const { bridge } = fixture();
  const args = { ...route, rendererInstanceId: "renderer", hostGeneration: 2 };
  assert.equal(await bridge.browserHost.registerWebviewHost(args), false);
  assert.equal(await bridge.browserHost.registerWebviewHostSession(args), true);
  assert.equal(await bridge.browserHost.registerWebviewHost(args), true);
  assert.equal(
    await bridge.browserHost.registerWebviewHost({
      ...args,
      hostGeneration: 1,
    }),
    false,
  );
  bridge.dispose();
  assert.equal(
    await bridge.browserHost.registerWebviewHostSession(args),
    false,
  );
});

test("draft transfer preserves the page and gates target registration until migration finishes", async () => {
  let finishTransfer;
  const { bridge, events, requests } = fixture((body) =>
    body.action === "transfer"
      ? new Promise((resolve) => {
          finishTransfer = () => resolve({});
        })
      : {},
  );
  const draft = { ...route, conversationId: "client-new-thread:draft" };
  const target = { conversationId: "saved-task", browserTabId: "saved-tab" };
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...draft,
    command: { type: "navigate", url: "https://existing-page.test" },
  });
  await bridge.browserHost.registerWebviewHostSession({
    rendererInstanceId: "renderer",
  });
  const transfer = bridge.handleMessage({
    type: "browser-sidebar-command",
    ...draft,
    command: {
      type: "transfer-conversation",
      targetConversationId: target.conversationId,
      targetBrowserTabId: target.browserTabId,
    },
  });
  const registration = bridge.browserHost.registerWebviewHost({
    ...target,
    rendererInstanceId: "renderer",
    hostGeneration: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    requests.map(({ action }) => action),
    ["open", "navigate", "transfer"],
  );
  finishTransfer();
  await transfer;
  assert.equal(await registration, true);
  assert.equal(events.at(-1).conversationId, target.conversationId);
  assert.equal(events.at(-1).snapshot.url, "https://existing-page.test");
  await bridge.handleMessage({
    type: "browser-sidebar-sync",
    payload: {
      ...target,
      transferSourceConversationId: draft.conversationId,
      transferSourceBrowserTabId: draft.browserTabId,
    },
  });
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...draft,
    command: { type: "reload" },
  });
  assert.equal(
    requests.filter(({ action }) => action === "transfer").length,
    1,
    "repeated native transfer sync is idempotent",
  );
  assert.deepEqual(
    requests.at(-1),
    { ...target, action: "reload" },
    "late source messages use the migrated page",
  );
  bridge.dispose();
});

test("closing a rejected migration releases the source; an unknown transfer is never replayed", async () => {
  for (const unknown of [false, true]) {
    const { bridge, events, requests } = fixture((body) => {
      if (body.action !== "transfer") return {};
      if (unknown) throw new TypeError("The transfer response was lost");
      return {
        error: "The target task already has a separate browser session",
      };
    });
    const draft = { ...route, conversationId: "client-new-thread:failed" };
    const target = { conversationId: "saved-task", browserTabId: "saved-tab" };
    await bridge.handleMessage({
      type: "browser-sidebar-command",
      ...draft,
      command: {
        type: "transfer-conversation",
        targetConversationId: target.conversationId,
        targetBrowserTabId: target.browserTabId,
      },
    });
    await bridge.handleMessage({
      type: "browser-sidebar-command",
      ...target,
      command: { type: "close-tab" },
    });
    assert.deepEqual(
      requests.map(({ action }) => action),
      unknown ? ["open", "transfer"] : ["open", "transfer", "close"],
    );
    if (!unknown)
      assert.equal(requests.at(-1).conversationId, draft.conversationId);
    const destroyed = events.filter(
      ({ type }) => type === "browser-sidebar-destroy-webview",
    );
    assert.equal(
      destroyed.length,
      1,
      "explicit close still tears down a failed migration",
    );
    assert.equal(
      destroyed[0].conversationId,
      target.conversationId,
      "the native host now belongs to the target route",
    );
    bridge.dispose();
  }
});

test("annotation mode reuses the native toolbar state and closing tears down its tab", async () => {
  const { bridge, events, requests } = fixture();
  await bridge.handleMessage({
    type: "browser-sidebar-sync",
    payload: { ...route, presented: true, mountGeneration: 7 },
  });
  assert.equal(events.at(-1).type, "browser-sidebar-webview-attached");
  assert.equal(events.at(-1).mountGeneration, 7);
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "set-interaction-mode", interactionMode: "comment" },
  });
  assert.equal(events.at(-1).snapshot.interactionMode, "comment");
  await bridge.handleMessage({
    type: "browser-sidebar-command",
    ...route,
    command: { type: "close-tab" },
  });
  assert.equal(requests.at(-1).action, "close");
  assert.equal(events.at(-1).type, "browser-sidebar-destroy-webview");
  bridge.dispose();
});

test(
  "viewport preserves annotations, keyboard state and page identity across lifecycle changes",
  { timeout: 30_000 },
  async (t) => {
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({
      executablePath:
        process.env.CODEX_WEB_BROWSER_EXECUTABLE || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("http://localhost/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("http://localhost/");
    await page.addScriptTag({ content: `window.exports = {};\n${compiled}` });
    await page.evaluate(
      ({ route, initial }) => {
        window.viewportStreams = [];
        window.WebSocket = class extends EventTarget {
          constructor(url) {
            super();
            window.viewportStreams.push(String(url));
          }
          close() {}
        };
        window.annotationEvents = [];
        window.viewportRequests = [];
        window.pendingAnnotations = {};
        window.annotationRoute = route;
        let state = { ...initial, url: "https://page-a.test" };
        window.annotationBridge = window.exports.createRemoteBrowserBridge({
          emitMessage: (event) => window.annotationEvents.push(event),
          request: async (_, options) => {
            const body = JSON.parse(options.body);
            window.viewportRequests.push(body);
            let value;
            if (body.action === "inspect" || body.action === "screenshot") {
              value = await new Promise((resolve) => {
                window.pendingAnnotations[body.action] = resolve;
              });
            }
            if (body.action === "navigate") state = { ...state, url: body.url };
            if (body.action === "transfer")
              state = {
                ...state,
                conversationId: body.targetConversationId,
                browserTabId: body.targetBrowserTabId,
              };
            return { ok: true, json: async () => ({ state, value }) };
          },
        });
        const view = window.annotationBridge.createWebview(route);
        window.originalViewport = view;
        Object.assign(view.style, { width: "800px", height: "600px" });
        document.body.append(view);
      },
      { route, initial },
    );

    const command = (value) =>
      page.evaluate(
        (command) =>
          window.annotationBridge.handleMessage({
            type: "browser-sidebar-command",
            ...window.annotationRoute,
            command,
          }),
        value,
      );
    const settle = async (action) => {
      await page.waitForFunction(
        (action) => Boolean(window.pendingAnnotations[action]),
        action,
      );
      await page.evaluate(async (action) => {
        const resolve = window.pendingAnnotations[action];
        delete window.pendingAnnotations[action];
        resolve(
          action === "inspect"
            ? {
                rect: { x: 20, y: 20, width: 100, height: 100 },
                selector: "#selected",
              }
            : { data: "AA==", mimeType: "image/png" },
        );
        await new Promise((done) => setTimeout(done, 0));
      }, action);
    };
    const select = async () => {
      await command({
        type: "set-interaction-mode",
        interactionMode: "comment",
      });
      await page.mouse.click(40, 40);
      await page.waitForFunction(() =>
        Boolean(window.pendingAnnotations.inspect),
      );
    };
    const submit = async () => {
      await select();
      await settle("inspect");
      await page
        .getByRole("textbox", { name: "网页备注", exact: true })
        .fill("修改这个区域");
      await page
        .getByRole("button", { name: "添加到对话", exact: true })
        .click();
      await page.waitForFunction(() =>
        Boolean(window.pendingAnnotations.screenshot),
      );
    };
    const commentCount = () =>
      page.evaluate(
        () =>
          window.annotationEvents.filter((event) => event.snapshot).at(-1)
            .snapshot.comments.length,
      );

    await select();
    await command({ type: "set-interaction-mode", interactionMode: "browse" });
    await settle("inspect");
    assert.equal(
      await page.locator("form").count(),
      0,
      "leaving comment mode cancels a pending inspection",
    );

    await submit();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await settle("screenshot");
    assert.equal(
      await commentCount(),
      0,
      "cancelled screenshots cannot add a composer attachment",
    );

    await submit();
    await command({ type: "clear-comments" });
    await settle("screenshot");
    assert.equal(
      await commentCount(),
      0,
      "clearing annotations also cancels in-flight additions",
    );

    await select();
    await page.evaluate(() => {
      void window.annotationBridge.handleMessage({
        type: "browser-sidebar-command",
        ...window.annotationRoute,
        command: { type: "navigate", url: "https://page-b.test" },
      });
    });
    await settle("inspect");
    await page.waitForFunction(() =>
      window.annotationEvents.some(
        (event) => event.snapshot?.url === "https://page-b.test",
      ),
    );
    assert.equal(
      await page.locator("form").count(),
      0,
      "navigation cancels the previous page's pending inspection",
    );

    await submit();
    await page.evaluate(() => {
      window.previousEmptyComments = window.annotationEvents
        .filter((event) => event.snapshot)
        .at(-1).snapshot.comments;
    });
    await settle("screenshot");
    assert.equal(
      await commentCount(),
      1,
      "a current completed annotation still reaches the composer",
    );
    assert.equal(await page.locator("form").count(), 0);
    assert.equal(
      await page.evaluate(() => window.previousEmptyComments.length),
      0,
      "adding an annotation cannot mutate a snapshot already held by native React",
    );
    await page.evaluate(() => {
      window.savedComments = window.annotationEvents
        .filter((event) => event.snapshot)
        .at(-1).snapshot.comments;
    });
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Outside viewport";
      document.body.append(button);
    });
    await page.mouse.click(40, 40);
    await page.keyboard.down("Control");
    await page.getByRole("button", { name: "Outside viewport" }).click();
    await page.keyboard.up("Control");
    await page.waitForFunction(() =>
      window.viewportRequests.some(
        (request) => request.action === "key" && request.eventType === "up",
      ),
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.viewportRequests
          .filter((request) => request.action === "key")
          .map(({ eventType, key }) => [eventType, key]),
      ),
      [
        ["down", "Control"],
        ["up", "Control"],
      ],
      "a modifier released outside the viewport cannot stay held in the remote page",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.savedComments ===
          window.annotationEvents.filter((event) => event.snapshot).at(-1)
            .snapshot.comments,
      ),
      true,
      "ordinary page state updates preserve comment identity for native synchronization",
    );
    await command({
      type: "transfer-conversation",
      targetConversationId: "saved-conversation",
      targetBrowserTabId: "saved-tab",
    });
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector("[data-remote-browser-viewport]") ===
          window.originalViewport,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() => {
        const url = new URL(window.viewportStreams.at(-1));
        return url.searchParams.get("conversationId");
      }),
      "saved-conversation",
      "the existing viewport reconnects its frame stream under the new owner",
    );
    await page.mouse.click(40, 40);
    await page.keyboard.insertText("迁移后输入");
    await page.waitForFunction(() =>
      window.viewportRequests.some((request) => request.action === "text"),
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.viewportRequests
          .filter((request) => request.action === "text")
          .at(-1),
      ),
      {
        conversationId: "saved-conversation",
        browserTabId: "saved-tab",
        action: "text",
        text: "迁移后输入",
      },
      "input from the same DOM view targets the migrated page",
    );
    await page.evaluate(() => window.annotationBridge.dispose());
  },
);
