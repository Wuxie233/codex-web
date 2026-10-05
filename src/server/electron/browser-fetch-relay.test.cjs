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
