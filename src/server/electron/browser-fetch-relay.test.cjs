const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const {
  fetchThroughBrowserRelay,
  isBrowserRelayTarget,
} = require("./browser-fetch-relay.js");

async function relay(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dot-relay-test-"));
  const socket = `${dir}/relay.sock`;
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return socket;
}

test("relay targets exact backend origin and rejects mutations before opening socket", async () => {
  assert.equal(
    isBrowserRelayTarget("https://chatgpt.com/backend-api/tbo/primary"),
    true,
  );
  for (const url of [
    "https://chatgpt.com.evil/backend-api/x",
    "http://chatgpt.com/backend-api/x",
    "https://chatgpt.com/backend-api-other",
  ])
    assert.equal(isBrowserRelayTarget(url), false);
  await assert.rejects(
    fetchThroughBrowserRelay(
      "/nonexistent",
      "https://chatgpt.com/backend-api/x",
      { method: "POST" },
    ),
    /only permits/,
  );
});

test("relay preserves request headers, status and streaming without buffering completion", async (t) => {
  let finish;
  const socket = await relay(t, (req, res) => {
    assert.equal(req.url, "/backend-api/tbo/primary?view=full");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer test-secret");
    assert.equal(req.headers["x-codex-relay-redirect"], "error");
    assert.equal(req.headers.host, "chatgpt.com");
    res.writeHead(206, {
      "content-type": "text/event-stream",
      "x-source": "browser",
    });
    res.write("first");
    finish = () => res.end("second");
  });
  const response = await fetchThroughBrowserRelay(
    socket,
    "https://chatgpt.com/backend-api/tbo/primary?view=full",
    {
      headers: { Authorization: "Bearer test-secret" },
      redirect: "error",
    },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("x-source"), "browser");
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  finish();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
  assert.equal((await reader.read()).done, true);
});

test("abort cancels in-flight response and closes relay connection", async (t) => {
  let closed;
  const peerClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const socket = await relay(t, (req, res) => {
    res.writeHead(200);
    res.write("first");
    res.on("close", closed);
  });
  const controller = new AbortController();
  const response = await fetchThroughBrowserRelay(
    socket,
    "https://chatgpt.com/backend-api/x",
    { signal: controller.signal },
  );
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), /abort/i);
  await peerClosed;
});

test("response cancellation closes socket and empty HTTP response is valid", async (t) => {
  let closed;
  const peerClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const socket = await relay(t, (req, res) => {
    if (req.url.endsWith("/empty")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200);
    res.write("first");
    res.on("close", closed);
  });
  const response = await fetchThroughBrowserRelay(
    socket,
    "https://chatgpt.com/backend-api/x",
  );
  await response.body.cancel();
  await peerClosed;
  const empty = await fetchThroughBrowserRelay(
    socket,
    "https://chatgpt.com/backend-api/empty",
  );
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});

test("Electron fetch routes only when opted in and retains other origins", async (t) => {
  const { net } = require("./index.js");
  const previousSocket = process.env.CODEX_BROWSER_FETCH_RELAY_SOCKET;
  const previousFetch = globalThis.fetch;
  const direct = [];
  globalThis.fetch = async (input, init) => {
    direct.push(String(input));
    return new Response("direct");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousSocket === undefined)
      delete process.env.CODEX_BROWSER_FETCH_RELAY_SOCKET;
    else process.env.CODEX_BROWSER_FETCH_RELAY_SOCKET = previousSocket;
  });
  delete process.env.CODEX_BROWSER_FETCH_RELAY_SOCKET;
  assert.equal(
    await (await net.fetch("https://chatgpt.com/backend-api/x")).text(),
    "direct",
  );
  const socket = await relay(t, (_req, res) => res.end("browser"));
  process.env.CODEX_BROWSER_FETCH_RELAY_SOCKET = socket;
  assert.equal(
    await (await net.fetch("https://chatgpt.com/backend-api/x")).text(),
    "browser",
  );
  assert.equal(
    await (await net.fetch("https://example.com/api")).text(),
    "direct",
  );
  await assert.rejects(
    net.fetch("https://chatgpt.com/backend-api/x", { method: "DELETE" }),
    /only permits/,
  );
  assert.deepEqual(direct, [
    "https://chatgpt.com/backend-api/x",
    "https://example.com/api",
  ]);
});

test("exact Statsig read POST preserves JSON body bytes and response values", async (t) => {
  const payload = Buffer.from(' {"locale":"中文","context":{"v":1}}\n', "utf8");
  const socket = await relay(t, async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/backend-api/wham/statsig/bootstrap");
    assert.equal(
      req.headers["content-type"],
      "application/json; charset=utf-8",
    );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"statsigPayload":{"feature_gates":{"sample":{"value":false}}}}');
  });
  const response = await fetchThroughBrowserRelay(
    socket,
    "https://chatgpt.com/backend-api/wham/statsig/bootstrap",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: payload,
    },
  );
  assert.equal(
    (await response.json()).statsigPayload.feature_gates.sample.value,
    false,
  );
});

test("Statsig POST rejects URL aliases, other writes, media types and oversized bodies before transport", async () => {
  const exact = "https://chatgpt.com/backend-api/wham/statsig/bootstrap";
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  for (const url of [
    exact + "/",
    exact + "?x=1",
    exact + "?",
    exact + "#x",
    exact.replace("/bootstrap", "/%62ootstrap"),
    exact.replace("/bootstrap", "/x/../bootstrap"),
    exact.replace("/bootstrap", "/other"),
    exact.replace("chatgpt.com", "chatgpt.com.evil"),
  ])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", url, init),
      /only permits/,
      url,
    );
  for (const method of ["PUT", "PATCH", "DELETE"])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", exact, { ...init, method }),
      /only permits/,
    );
  for (const media of ["text/plain", "application/json-patch+json", ""])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", exact, {
        ...init,
        headers: { "content-type": media },
      }),
      /requires application\/json/,
    );
  await assert.rejects(
    fetchThroughBrowserRelay("/nonexistent", exact, {
      ...init,
      body: Buffer.alloc(1024 * 1024 + 1, 32),
    }),
    /exceeds 1 MiB/,
  );
});

test("Statsig read accepts the 1 MiB boundary and aborts a pending body read", async (t) => {
  const exact = "https://chatgpt.com/backend-api/wham/statsig/bootstrap";
  const socket = await relay(t, async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    assert.equal(bytes, 1024 * 1024);
    res.end("{}");
  });
  const response = await fetchThroughBrowserRelay(socket, exact, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.concat([Buffer.from("{}"), Buffer.alloc(1024 * 1024 - 2, 32)]),
  });
  await response.text();
  const controller = new AbortController();
  let canceled = false;
  const input = new Request(exact, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    duplex: "half",
    signal: controller.signal,
  });
  const pending = fetchThroughBrowserRelay("/nonexistent", input);
  const rejected = assert.rejects(pending, /abort/i);
  controller.abort();
  await rejected;
  assert.equal(canceled, true);
});

function optInRoom(t) {
  const previous = process.env.CODEX_DOT_MESSAGE_ROOM_ID;
  process.env.CODEX_DOT_MESSAGE_ROOM_ID = "room-test";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_DOT_MESSAGE_ROOM_ID;
    else process.env.CODEX_DOT_MESSAGE_ROOM_ID = previous;
  });
}
const roomUrl = "https://chatgpt.com/backend-api/messaging/rooms/room-test";
const textPayload = {
  content: { text: "仅回复验证成功" },
  request_id: "request-test",
  idempotency_token: "request-test",
};

test("room text opt-in preserves raw JSON and security headers, never retries a lost response", async (t) => {
  optInRoom(t);
  let calls = 0;
  const bytes = Buffer.from(
    JSON.stringify(
      {
        ...textPayload,
        app_attest_challenge: "test-challenge",
        page_context: { page_id: null },
      },
      null,
      2,
    ),
  );
  const socket = await relay(t, async (req, res) => {
    calls++;
    assert.equal(req.url, "/backend-api/messaging/rooms/room-test/messages");
    assert.equal(
      req.headers["openai-sentinel-chat-requirements-token"],
      "test-security",
    );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    req.socket.destroy();
  });
  await assert.rejects(
    fetchThroughBrowserRelay(socket, `${roomUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "openai-sentinel-chat-requirements-token": "test-security",
      },
      body: bytes,
    }),
  );
  assert.equal(calls, 1);
});

test("room opt-in rejects unrelated writes, URL aliases, and non-text fields before transport", async (t) => {
  optInRoom(t);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(textPayload),
  };
  for (const suffix of ["/messages?", "/messages/", "/%6dessages", "/files"]) {
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", roomUrl + suffix, init),
      /only permits/,
    );
  }
  await assert.rejects(
    fetchThroughBrowserRelay(
      "/nonexistent",
      roomUrl.replace("room-test", "other") + "/messages",
      init,
    ),
    /only permits/,
  );
  for (const payload of [
    {
      ...textPayload,
      content: { text: "x", attachments: [{ file_id: "file" }] },
    },
    { ...textPayload, content: { text: "x", tool: "execute" } },
    { ...textPayload, page_context: {} },
    {
      ...textPayload,
      page_context: { page_id: "native-page", extra: "reject" },
    },
    { ...textPayload, page_context: { page_id: 42 } },
    { ...textPayload, app_attest_challenge: {} },
    { ...textPayload, reply_to: { message_id: "x" } },
    { ...textPayload, client_message_id: "x" },
    { ...textPayload, idempotency_token: "different" },
    { ...textPayload, content: { text: " " } },
  ])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", `${roomUrl}/messages`, {
        ...init,
        body: JSON.stringify(payload),
      }),
      /Dot /,
    );
  delete process.env.CODEX_DOT_MESSAGE_ROOM_ID;
  await assert.rejects(
    fetchThroughBrowserRelay("/nonexistent", `${roomUrl}/messages`, init),
    /only permits/,
  );
});

test("room live accepts empty POST and streams until cancellation without requiring JSON", async (t) => {
  optInRoom(t);
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const socket = await relay(t, async (req, res) => {
    assert.equal(req.method, "POST");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 0);
    res.on("close", close);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ready\n\n");
  });
  const response = await fetchThroughBrowserRelay(socket, `${roomUrl}/live`, {
    method: "POST",
  });
  const reader = response.body.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: ready\n\n",
  );
  await reader.cancel();
  await closed;
  await assert.rejects(
    fetchThroughBrowserRelay("/nonexistent", `${roomUrl}/live`, {
      method: "POST",
      body: "{}",
    }),
    /empty body/,
  );
});

test("native page context permits null and page identifiers, with fixed private rejection reasons", async (t) => {
  optInRoom(t);
  const socket = await relay(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.ok(
      body.page_context.page_id === null ||
        body.page_context.page_id === "native-page",
    );
    res.end("{}");
  });
  for (const page_id of [null, "native-page"]) {
    const response = await fetchThroughBrowserRelay(
      socket,
      `${roomUrl}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...textPayload, page_context: { page_id } }),
      },
    );
    assert.equal(response.status, 200);
    await response.text();
  }
  await assert.rejects(
    fetchThroughBrowserRelay("/nonexistent", `${roomUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...textPayload,
        page_context: { page_id: null, private: "do-not-log" },
      }),
    }),
    (error) =>
      error.message === "Dot text message rejected: page_context_shape",
  );
});

test("fixed room read receipt preserves timestamp bytes and heartbeat is empty", async (t) => {
  optInRoom(t);
  const bytes = ' {"last_read_at":"2026-10-06T01:02:03.123456+00:00"}\n';
  const seen = [];
  const socket = await relay(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push([req.url, Buffer.concat(chunks).toString()]);
    res.writeHead(204);
    res.end();
  });
  assert.equal(
    (
      await fetchThroughBrowserRelay(socket, roomUrl + "/read", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: bytes,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetchThroughBrowserRelay(
        socket,
        roomUrl + "/responding_heartbeat",
        { method: "POST" },
      )
    ).status,
    204,
  );
  assert.deepEqual(seen, [
    [new URL(roomUrl).pathname + "/read", bytes],
    [new URL(roomUrl).pathname + "/responding_heartbeat", ""],
  ]);
  for (const value of [
    { last_read_at: 123 },
    { last_read_at: null },
    { last_read_at: "" },
    { last_read_at: "invalid" },
    { last_read_at: "2026-10-06T00:00:00Z", extra: true },
    [],
    {},
  ])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", roomUrl + "/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
  await assert.rejects(
    fetchThroughBrowserRelay(
      "/nonexistent",
      roomUrl + "/responding_heartbeat",
      { method: "POST", body: "{}" },
    ),
    /empty body/,
  );
  for (const suffix of [
    "/read?x=1",
    "/read/",
    "/responding_heartbeat?",
    "/responding_heartbeat/",
  ])
    await assert.rejects(
      fetchThroughBrowserRelay("/nonexistent", roomUrl + suffix, {
        method: "POST",
      }),
      /only permits/,
    );
  await assert.rejects(
    fetchThroughBrowserRelay(
      "/nonexistent",
      roomUrl.replace("room-test", "other") + "/read",
      { method: "POST" },
    ),
    /only permits/,
  );
  delete process.env.CODEX_DOT_MESSAGE_ROOM_ID;
  await assert.rejects(
    fetchThroughBrowserRelay(
      "/nonexistent",
      roomUrl + "/responding_heartbeat",
      { method: "POST" },
    ),
    /only permits/,
  );
});
