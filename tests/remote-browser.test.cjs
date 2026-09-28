const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { RemoteBrowser } = require("../src/server/remote-browser.js");
const { RemoteBrowserNetwork } = require("../src/server/remote-browser-network.js");

async function fixture(t, options = {}) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: options.redirectTo });
      response.end();
    } else if (request.url === "/next") {
      response.end("<!doctype html><title>Next page</title><h1>Next</h1>");
    } else {
      response.setHeader("Content-Type", "text/html;charset=utf-8");
      response.end(`<!doctype html><title>Browser fixture</title>
        <style>body{margin:0} input{position:absolute;left:20px;top:20px;width:200px;height:30px}button{position:absolute;left:20px;top:80px;width:100px;height:30px}h1{margin:0;position:absolute;left:20px;top:130px}body{height:2200px}</style>
        <form action="/next"><input id="name" name="name"><button type="button" id="change">Change</button></form>
        <h1 id="result">Ready</h1><script>window.clicks=0;document.querySelector('#change').onclick=()=>{window.clicks++;document.querySelector('#result').textContent=document.querySelector('#name').value;document.title='Changed '+window.clicks;};</script>`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = new RemoteBrowser(options.runtime);
  const target = { conversationId: "conversation-a", browserTabId: "main" };
  const url = `http://127.0.0.1:${server.address().port}`;
  const command = (action, input = {}, selected = target) =>
    runtime.command({ ...selected, action, ...input });
  t.after(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { runtime, target, url, hits, command };
}

test(
  "real Chromium supports mouse, text, JavaScript, DOM inspection, history, resize and screenshots",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, url, command } = await fixture(t);
    const opened = await command("open", { url });
    assert.equal(opened.state.title, "Browser fixture");
    await command("mouse", { eventType: "click", x: 60, y: 35 });
    await command("text", { text: "真实浏览器输入" });
    await command("mouse", { eventType: "click", x: 60, y: 95 });
    assert.equal(
      (
        await runtime.evaluate(
          target,
          "document.querySelector('#result').textContent",
        )
      ).value,
      "真实浏览器输入",
    );
    assert.equal(
      (await runtime.evaluate(target, "window.clicks")).value,
      1,
      "mutations execute once",
    );
    const inspected = await command("inspect", { x: 30, y: 150 });
    assert.equal(inspected.value.selector, "#result");
    assert.equal(inspected.value.text, "真实浏览器输入");
    await command("resize", { width: 820, height: 540 });
    const screenshot = await command("screenshot");
    const png = Buffer.from(screenshot.value.data, "base64");
    assert.equal(png.readUInt32BE(16), 820);
    assert.equal(png.readUInt32BE(20), 540);
    await command("navigate", { url: `${url}/next` });
    assert.equal((await command("state")).state.title, "Next page");
    assert.equal((await command("back")).state.url, `${url}/`);
    assert.equal((await command("state")).state.title, "Browser fixture");
    assert.equal((await command("state")).state.canGoForward, true);
    assert.equal((await command("forward")).state.title, "Next page");
    await command("reload");
    assert.equal((await command("state")).state.url, `${url}/next`);
    assert.equal((await command("close")).state.closed, true);
    assert.deepEqual(runtime.list(target.conversationId), []);
  },
);

test(
  "local HTML runs real scripts and file browser security stays enabled",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, command } = await fixture(t);
    const directory = await mkdtemp(path.join(tmpdir(), "codex-browser-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "页面.html");
    await writeFile(
      file,
      "<!doctype html><title>Local file</title><h1 id='value'>Before</h1><script>document.getElementById('value').textContent='After script';</script>",
    );
    await writeFile(
      path.join(directory, "private.txt"),
      "outside-origin-secret",
    );
    const opened = await command("open", { url: pathToFileURL(file).href });
    assert.equal(opened.state.title, "Local file");
    assert.equal(
      (
        await runtime.evaluate(
          target,
          "document.querySelector('h1').textContent",
        )
      ).value,
      "After script",
    );
    const blocked = await runtime.evaluate(
      target,
      "fetch('./private.txt').then(r=>r.text()).catch(()=> 'blocked')",
    );
    assert.equal(blocked.value, "blocked");
  },
);

test(
  "tabs share a task login while different tasks and closed sessions are isolated",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, url, command } = await fixture(t);
    await command("open", { url });
    await runtime.evaluate(
      target,
      "document.cookie='session=conversation-a;path=/';localStorage.setItem('user','a')",
    );
    const secondTab = { ...target, browserTabId: "second" };
    await command("open", { url }, secondTab);
    assert.match(
      (await runtime.evaluate(secondTab, "document.cookie")).value,
      /session=conversation-a/,
    );
    const other = { ...target, conversationId: "conversation-b" };
    await command("open", { url }, other);
    assert.equal((await runtime.evaluate(other, "document.cookie")).value, "");
    assert.equal(
      (await runtime.evaluate(other, "localStorage.getItem('user')")).value,
      null,
    );
    assert.equal(runtime.list(target.conversationId).length, 2);
    await command("close");
    assert.match(
      (await runtime.evaluate(secondTab, "document.cookie")).value,
      /session=conversation-a/,
    );
    await command("close", {}, secondTab);
    await command("open", { url });
    assert.equal((await runtime.evaluate(target, "document.cookie")).value, "");
  },
);

test(
  "JPEG streaming resumes with the same page and disconnection preserves login",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, url, command } = await fixture(t);
    await command("open", { url });
    await runtime.evaluate(target, "document.cookie='session=retained;path=/'");
    function frameOnce() {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("No screencast frame"));
        }, 5_000);
        let unsubscribe = () => {};
        unsubscribe = runtime.subscribe(
          target.conversationId,
          target.browserTabId,
          (event) => {
            if (event.type !== "frame") return;
            clearTimeout(timeout);
            // A reconnect can receive a cached frame synchronously.
            queueMicrotask(() => {
              unsubscribe();
              resolve(event);
            });
          },
        );
      });
    }
    const first = await frameOnce();
    assert.equal(first.mimeType, "image/jpeg");
    assert.equal(Buffer.from(first.data, "base64").readUInt16BE(0), 0xffd8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(runtime.list(target.conversationId).length, 1);
    assert.match(
      (await runtime.evaluate(target, "document.cookie")).value,
      /session=retained/,
    );
    const second = await frameOnce();
    assert.ok(second.sequence >= first.sequence);
  },
);

test(
  "application origin, redirected requests, backend aliases and invalid actions are blocked",
  { timeout: 30_000 },
  async (t) => {
    let protectedHits = 0;
    const protectedServer = http.createServer((_request, response) => {
      protectedHits++;
      response.end("control-secret");
    });
    await new Promise((resolve) =>
      protectedServer.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      protectedServer.closeAllConnections();
      await new Promise((resolve) => protectedServer.close(resolve));
    });
    const protectedUrl = `http://127.0.0.1:${protectedServer.address().port}`;
    const { runtime, target, url, command, hits } = await fixture(t, {
      redirectTo: `${protectedUrl}/__backend`,
    });
    runtime.setAppOrigin(protectedUrl);
    await assert.rejects(
      command("open", { url: `${protectedUrl}/__backend` }),
      /control application/,
    );
    await assert.rejects(
      command("open", {
        url: `http://localhost:${protectedServer.address().port}`,
      }),
      /control application/,
    );
    await command("open", { url });
    const fetchResult = await runtime.evaluate(
      target,
      `fetch(${JSON.stringify(`${protectedUrl}/__backend`)}).then(r=>r.text()).catch(()=> 'blocked')`,
    );
    assert.equal(fetchResult.value, "blocked");
    try {
      await command("navigate", { url: `${url}/redirect` });
    } catch {
      /* Chromium may expose the proxy's blocked response or an error. */
    }
    assert.equal(
      protectedHits,
      0,
      "redirect cannot contact the application server",
    );
    assert.equal(hits[0].headers["x-codex-remote-browser"], "1");
    for (const denied of [
      "javascript:alert(1)",
      "data:text/html,blocked",
      "chrome://version",
      "http://user:password@example.com/",
    ]) {
      await assert.rejects(command("navigate", { url: denied }));
    }
    await assert.rejects(
      command("evaluate", { expression: "1+1" }),
      /Unsupported browser command/,
    );
    await assert.rejects(
      command("mouse", { eventType: "click", x: Number.NaN, y: 0 }),
      /must be a number/,
    );
  },
);

test(
  "creation is deduplicated, quotas are enforced, idle views persist and evaluations expire explicitly",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, command } = await fixture(t, {
      runtime: {
        maxContexts: 1,
        maxTabsPerContext: 1,
        idleTimeoutMs: 300,
        evaluateTimeoutMs: 50,
      },
    });
    await Promise.all([command("open"), command("open"), command("open")]);
    assert.equal(runtime.list(target.conversationId).length, 1);
    await assert.rejects(
      command("open", {}, { ...target, browserTabId: "over-limit" }),
      /tab limit/,
    );
    await assert.rejects(
      command("open", {}, { ...target, conversationId: "over-limit" }),
      /session limit/,
    );
    await assert.rejects(
      runtime.evaluate(target, "new Promise(()=>{})"),
      /outcome is unknown and was not retried/,
    );
    const unsubscribe = runtime.subscribe(
      target.conversationId,
      target.browserTabId,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(
      runtime.list(target.conversationId).length,
      1,
      "subscribed pages are retained",
    );
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(
      runtime.list(target.conversationId).length,
      0,
      "unobserved idle pages eventually close",
    );
    await runtime.dispose();
    await assert.rejects(command("open"), /runtime is closed/);
  },
);

test(
  "cancelling a queued action prevents its later mutation without replay",
  { timeout: 30_000 },
  async (t) => {
    const { runtime, target, url, command } = await fixture(t);
    await command("open", { url });
    await command("mouse", { eventType: "click", x: 60, y: 35 });
    const blocker = runtime.evaluate(
      target,
      "new Promise(resolve => setTimeout(() => resolve('finished'), 100))",
    );
    const controller = new AbortController();
    const queued = runtime.command(
      { ...target, action: "text", text: "must not execute" },
      controller.signal,
    );
    const rejected = assert.rejects(queued, { name: "AbortError" });
    controller.abort();
    await blocker;
    await rejected;
    assert.equal(
      (await runtime.evaluate(target, "document.querySelector('#name').value"))
        .value,
      "",
    );
    await command("key", { key: "A", eventType: "press" });
    assert.equal(
      (await runtime.evaluate(target, "document.querySelector('#name').value"))
        .value,
      "A",
    );
    await assert.rejects(
      runtime.command(
        { conversationId: "cancelled", browserTabId: "new", action: "open" },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.deepEqual(runtime.list("cancelled"), []);
  },
);

test("popup links reach their destination once", { timeout: 30_000 }, async (t) => {
  const { runtime, target, url, hits, command } = await fixture(t);
  await command("open", { url });
  await runtime.evaluate(target, `window.open(${JSON.stringify(`${url}/next`)}); undefined`);
  const deadline = Date.now() + 5_000;
  while (runtime.list(target.conversationId)[0]?.title !== "Next page" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await command("state")).state.title, "Next page");
  assert.equal(hits.filter((hit) => hit.url === "/next").length, 1);
});

test("disconnect releases inputs accepted behind an active command", { timeout: 30_000 }, async (t) => {
  const { runtime, target, url, command } = await fixture(t);
  await command("open", { url });
  const unsubscribe = runtime.subscribe(target.conversationId, target.browserTabId, () => {});
  // Wait for the screencast to start before testing its teardown.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await runtime.evaluate(target, "window.keyEvents=[];onkeydown=e=>keyEvents.push('down:'+e.key);onkeyup=e=>keyEvents.push('up:'+e.key)");
  const blocker = runtime.evaluate(target, "new Promise(resolve=>setTimeout(resolve,150))");
  const press = command("key", { key: "Shift", eventType: "down" });
  unsubscribe();
  await blocker;
  await press;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual((await runtime.evaluate(target, "keyEvents")).value, ["down:Shift", "up:Shift"]);
});

test("a hung renderer has bounded reads and can be closed immediately", { timeout: 30_000 }, async (t) => {
  const { runtime, target, url, command } = await fixture(t, { runtime: { evaluateTimeoutMs: 300 } });
  await command("open", { url });
  await assert.rejects(runtime.evaluate(target, "while(true) {}"), /outcome is unknown/);
  await assert.rejects(command("inspect", { x: 20, y: 20 }), /page read timed out/);
  const inspecting = assert.rejects(command("inspect", { x: 20, y: 20 }));
  const closed = await command("close");
  assert.equal(closed.state.closed, true);
  await inspecting;
  assert.deepEqual(runtime.list(target.conversationId), []);
});

function proxyEnvironment(t, proxy) {
  const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.HTTP_PROXY = proxy;
  process.env.HTTPS_PROXY = proxy;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

async function proxySocket(address) {
  const url = new URL(address);
  const socket = net.connect(Number(url.port), url.hostname);
  await once(socket, "connect");
  return socket;
}

function socketResponse(socket, request, expected) {
  return new Promise((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), 3_000);
    const data = (chunk) => {
      received += chunk.toString();
      if (received.includes(expected)) finish();
    };
    const finish = (error) => {
      clearTimeout(timeout);
      socket.off("data", data);
      socket.off("error", finish);
      if (error) reject(error);
      else resolve(received);
    };
    socket.on("data", data);
    socket.once("error", finish);
    socket.write(request);
  });
}

test("HTTP, CONNECT and WebSocket proxy chains forward once and dispose active tunnels", { timeout: 15_000 }, async (t) => {
  const requests = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer((request, response) => {
    requests.push({ type: "http", url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    // Keep the body open to prove response headers are flushed immediately.
  });
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  upstream.on("connect", (request, socket, head) => {
    requests.push({ type: "connect", url: request.url, headers: request.headers });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\nupstream-head");
    if (head.length) socket.write(`echo:${head}`);
    socket.on("data", (data) => socket.write(`echo:${data}`));
  });
  upstream.on("upgrade", (request, socket, head) => {
    requests.push({ type: "websocket", url: request.url, headers: request.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupstream-ws-head");
    if (head.length) socket.write(`echo:${head}`);
    socket.on("data", (data) => socket.write(`echo:${data}`));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  proxyEnvironment(t, `http://browser:proxy-test@127.0.0.1:${upstream.address().port}`);
  const network = new RemoteBrowserNetwork((url) => new URL(url).hostname === "blocked.invalid");
  const address = await network.start();
  const clients = [];
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await network.dispose();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const client = async () => {
    const socket = await proxySocket(address);
    clients.push(socket);
    return socket;
  };
  const stream = await client();
  assert.match(await socketResponse(stream, "GET http://target.invalid/events HTTP/1.1\r\nHost: target.invalid\r\n\r\n", "\r\n\r\n"), /^HTTP\/1.1 200/);
  const connect = await client();
  const connected = await socketResponse(connect, "CONNECT target.invalid:443 HTTP/1.1\r\nHost: target.invalid:443\r\n\r\nclient-head", "echo:client-head");
  assert.match(connected, /^HTTP\/1.1 200/);
  assert.match(connected, /upstream-head/);
  const websocket = await client();
  const upgraded = await socketResponse(websocket, "GET ws://target.invalid/live HTTP/1.1\r\nHost: target.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nclient-ws-head", "echo:client-ws-head");
  assert.match(upgraded, /^HTTP\/1.1 101/);
  assert.match(upgraded, /upstream-ws-head/);
  assert.deepEqual(requests.map(({ type, url }) => ({ type, url })), [
    { type: "http", url: "http://target.invalid/events" },
    { type: "connect", url: "target.invalid:443" },
    { type: "websocket", url: "http://target.invalid/live" },
  ]);
  for (const request of requests)
    assert.equal(request.headers["proxy-authorization"], `Basic ${Buffer.from("browser:proxy-test").toString("base64")}`);
  const blocked = await client();
  assert.match(await socketResponse(blocked, "CONNECT blocked.invalid:443 HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n", "\r\n\r\n"), /^HTTP\/1.1 403/);
  const closed = [stream, connect, websocket].map((socket) => once(socket, "close"));
  await network.dispose();
  await Promise.all(closed);
  assert.equal(requests.length, 3);
  await assert.rejects(proxySocket(address), { code: "ECONNREFUSED" });
});

test("invalid proxy credentials reject CONNECT without an uncaught exception", { timeout: 5_000 }, async (t) => {
  proxyEnvironment(t, "http://browser:invalid%password@127.0.0.1:1");
  const network = new RemoteBrowserNetwork(() => false);
  const address = await network.start();
  t.after(() => network.dispose());
  const socket = await proxySocket(address);
  t.after(() => socket.destroy());
  assert.match(await socketResponse(socket, "CONNECT target.invalid:443 HTTP/1.1\r\nHost: target.invalid\r\n\r\n", "\r\n\r\n"), /^HTTP\/1.1 502/);
});

test("draft tabs transfer their existing pages and login into one task context", { timeout: 30_000 }, async (t) => {
  const { runtime, url, hits, command } = await fixture(t, { runtime: { maxContexts: 1 } });
  const draft = { conversationId: "client-new-thread:draft-a", browserTabId: "first" };
  const secondDraft = { ...draft, browserTabId: "second" };
  const first = { conversationId: "created-task", browserTabId: "moved-first" };
  const second = { ...first, browserTabId: "moved-second" };
  await command("open", { url }, draft);
  await command("open", { url }, secondDraft);
  await runtime.evaluate(draft, "window.existingPage=42;document.cookie='session=draft-login;path=/'");
  await runtime.evaluate(secondDraft, "window.existingPage=84");
  const initialHits = hits.length;
  const transfer = (source, destination) => command("transfer", {
    targetConversationId: destination.conversationId,
    targetBrowserTabId: destination.browserTabId,
  }, source);
  const events = [];
  const unsubscribe = runtime.subscribe(draft.conversationId, draft.browserTabId, (event) => events.push(event));
  t.after(unsubscribe);
  assert.equal((await transfer(draft, first)).state.conversationId, first.conversationId);
  assert.equal((await transfer(draft, first)).state.browserTabId, first.browserTabId, "duplicate transfer is idempotent");
  assert.equal((await runtime.evaluate(first, "existingPage")).value, 42);
  assert.match((await runtime.evaluate(first, "document.cookie")).value, /draft-login/);
  assert.deepEqual(runtime.list(draft.conversationId).map((tab) => tab.browserTabId), ["second"]);
  assert.deepEqual(runtime.list(first.conversationId).map((tab) => tab.browserTabId), ["moved-first"]);
  await assert.rejects(command("state", {}, draft), /not open/);
  await assert.rejects(command("open", {}, { ...draft, browserTabId: "new-draft-tab" }), /has moved/);
  await transfer(secondDraft, second);
  assert.equal((await runtime.evaluate(second, "existingPage")).value, 84);
  assert.equal(hits.length, initialHits, "transfer never reloads either document");
  assert.deepEqual(runtime.list(draft.conversationId), []);
  assert.ok(events.some((event) => event.type === "state" && event.state.conversationId === first.conversationId));
  const third = { ...first, browserTabId: "third" };
  await command("open", { url }, third);
  assert.match((await runtime.evaluate(third, "document.cookie")).value, /draft-login/);
  await command("close", {}, first);
  await command("close", {}, second);
  assert.match((await runtime.evaluate(third, "document.cookie")).value, /draft-login/);
  await command("close", {}, third);
  await command("open", { url }, first);
  assert.equal((await runtime.evaluate(first, "document.cookie")).value, "", "closing the transferred context clears its login");
});

test("draft transfers reject unrelated task contexts and conflicting queued moves", { timeout: 30_000 }, async (t) => {
  const { runtime, url, command } = await fixture(t);
  const draft = { conversationId: "client-new-thread:draft-b", browserTabId: "draft-tab" };
  const unrelated = { conversationId: "unrelated-task", browserTabId: "existing" };
  await command("open", { url }, draft);
  await command("open", { url }, unrelated);
  await runtime.evaluate(draft, "document.cookie='session=draft-b;path=/'");
  const move = (source, targetConversationId, targetBrowserTabId) => command("transfer", {
    targetConversationId, targetBrowserTabId,
  }, source);
  await assert.rejects(move(draft, unrelated.conversationId, "new-tab"), /separate browser session/);
  await assert.rejects(move(unrelated, "another-task", "new-tab"), /Only a draft browser/);
  assert.equal((await runtime.evaluate(unrelated, "document.cookie")).value, "");
  const outcomes = await Promise.allSettled([
    move(draft, "created-b", "one"),
    move(draft, "created-b", "two"),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.deepEqual(runtime.list("created-b").map((tab) => tab.browserTabId), ["one"]);
  assert.match((await runtime.evaluate({ conversationId: "created-b", browserTabId: "one" }, "document.cookie")).value, /draft-b/);
});

test("an old draft open cannot create a page after its context transfers", { timeout: 30_000 }, async (t) => {
  const { runtime, command } = await fixture(t, { runtime: { maxContexts: 1 } });
  const source = { conversationId: "client-new-thread:opening-race", browserTabId: "existing" };
  await command("open", {}, source);
  const session = runtime.session.bind(runtime);
  let reachedSession;
  let continueOpen;
  const reached = new Promise((resolve) => { reachedSession = resolve; });
  const resume = new Promise((resolve) => { continueOpen = resolve; });
  runtime.session = async (conversationId) => {
    const result = await session(conversationId);
    reachedSession();
    await resume;
    return result;
  };
  const staleOpen = command("open", {}, { ...source, browserTabId: "late" });
  try {
    await reached;
    await command("transfer", {
      targetConversationId: "created-after-race", targetBrowserTabId: "existing",
    }, source);
  } finally {
    runtime.session = session;
    continueOpen();
  }
  await assert.rejects(staleOpen, /has moved/);
  assert.deepEqual(runtime.list(source.conversationId), []);
  assert.deepEqual(runtime.list("created-after-race").map((tab) => tab.browserTabId), ["existing"]);
});
