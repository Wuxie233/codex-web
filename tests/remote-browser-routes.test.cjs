const { test } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const { WebSocket } = require("ws");
const {
  registerRemoteBrowserRoutes,
} = require("../src/server/remote-browser-routes.js");

test("browser transport preserves the target and rejects page-origin or evaluation commands", async () => {
  const calls = [];
  let callback,
    stopped = 0,
    disposed = false;
  const runtime = {
    setAppOrigin() {},
    async command(input) {
      calls.push(input);
      return { state: input };
    },
    subscribe(conversationId, browserTabId, listener) {
      calls.push({ conversationId, browserTabId });
      callback = listener;
      return () => stopped++;
    },
    async dispose() {
      disposed = true;
    },
  };
  const app = Fastify();
  const upgrade = registerRemoteBrowserRoutes(app, runtime);
  app.server.on("upgrade", (request, socket, head) => {
    if (!upgrade(request, socket, head)) socket.destroy();
  });
  let socket;
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const payload = {
      conversationId: "thread-a",
      browserTabId: "tab-a",
      action: "text",
      text: "中文",
    };
    let response = await app.inject({
      method: "POST",
      url: "/__backend/remote-browser/command",
      payload,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [payload]);
    response = await app.inject({
      method: "POST",
      url: "/__backend/remote-browser/command",
      payload: {
        ...payload,
        action: "open",
        conversationId: "client-new-thread:draft-a",
      },
    });
    assert.equal(
      response.statusCode,
      200,
      "native draft tasks have a prefixed conversation ID",
    );
    for (const headers of [
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "x-codex-remote-browser": "1" },
    ]) {
      response = await app.inject({
        method: "POST",
        url: "/__backend/remote-browser/command",
        payload,
        headers,
      });
      assert.equal(response.statusCode, 403);
    }
    for (const mutation of [
      { action: "evaluate", expression: "document.cookie" },
      { conversationId: "../escape" },
    ]) {
      response = await app.inject({
        method: "POST",
        url: "/__backend/remote-browser/command",
        payload: { ...payload, ...mutation },
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.length, 2, "rejected input must never execute");
    socket = new WebSocket(
      base.replace("http:", "ws:") +
        "/__backend/remote-browser/stream?conversationId=thread-a&browserTabId=tab-a",
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const next = new Promise((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data))),
    );
    callback({ type: "frame", data: "frame", sequence: 1 });
    assert.deepEqual(await next, { type: "frame", data: "frame", sequence: 1 });
    socket.send(JSON.stringify({ action: "text", text: "must not execute" }));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("active stream blocked shutdown")),
          2000,
        );
        timer.unref();
      }),
    ]);
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, 1);
    assert.equal(disposed, true);
    assert.equal(
      calls.length,
      3,
      "stream is receive-only and must not replay commands",
    );
  } finally {
    socket?.terminate();
    await app.close();
  }
});
