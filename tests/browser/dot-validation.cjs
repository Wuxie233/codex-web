// Run only through scripts/dot-validation-sandbox.py; never start the app on host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (name, data) =>
  fs.writeFileSync(`/state/${name}`, JSON.stringify(data, null, 2));
async function inaccessible(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(1000);
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(true);
    });
  });
}
(async () => {
  assert(process.env.DOT_VALIDATION_NONCE, "Use sandbox launcher");
  assert(!fs.existsSync("/root/.codex"), "Production auth visible");
  assert(!fs.existsSync("/run/user"), "Production runtime sockets visible");
  assert(!fs.existsSync("/var/run"), "Production service sockets visible");
  assert(
    !fs.existsSync("/app/.local/protected-processes.json"),
    "Host .local visible",
  );
  assert.equal(
    fs.readdirSync(process.env.CODEX_HOME).length,
    0,
    "CODEX_HOME not fresh",
  );
  const routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n");
  assert.equal(routes.length, 1, "Network routes exist");
  assert(
    await inaccessible(Number(process.env.DOT_VALIDATION_HOST_PORT)),
    "Host listener reachable",
  );
  let readOnly = false;
  try {
    fs.writeFileSync("/app/.dot-validation-write-probe", "must fail");
  } catch (e) {
    readOnly = ["EROFS", "EACCES"].includes(e.code);
  }
  assert(readOnly, "Repository writable");
  write("isolation.json", {
    nonce: process.env.DOT_VALIDATION_NONCE,
    productionAuthVisible: false,
    productionSocketsVisible: false,
    hostListenerReachable: false,
    repoReadOnly: true,
    defaultRoute: false,
  });
  if (process.env.DOT_VALIDATION_MODE === "isolation") {
    console.log("Isolation checks passed");
    return;
  }
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const log = fs.openSync("/state/server.log", "w");
  const server = spawn(
    process.execPath,
    ["/app/src/server/main.js", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: "/state/workspace", stdio: ["ignore", log, log] },
  );
  let browser;
  const errors = [],
    consoleErrors = [],
    sockets = [],
    requestFailures = [],
    httpErrors = [];
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null)
        throw new Error(
          `Backend exited ${server.exitCode}; inspect server.log`,
        );
      try {
        const r = await fetch(url);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(200);
    }
    assert(ready, "Backend did not become ready");
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const states = [];
    function observe(page, label) {
      page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(`${label}: ${m.text()}`);
      });
      page.on("requestfailed", (r) =>
        requestFailures.push({
          tab: label,
          url: r.url().split("?")[0],
          error: r.failure()?.errorText,
        }),
      );
      page.on("response", (r) => {
        if (r.status() >= 400)
          httpErrors.push({
            tab: label,
            url: r.url().split("?")[0],
            status: r.status(),
          });
      });
      page.on("websocket", (ws) => {
        const entry = {
          tab: label,
          url: ws.url(),
          received: 0,
          sent: 0,
          appSent: 0,
          appReceived: 0,
          frames: [],
        };
        sockets.push(entry);
        function frame(direction, payload) {
          entry[direction]++;
          try {
            const raw = JSON.parse(String(payload));
            const v = raw.type === "bridge-frame" ? raw.payload : raw;
            if (v.type?.startsWith("ipc-"))
              entry[direction === "sent" ? "appSent" : "appReceived"]++;
            if (entry.frames.length < 40)
              entry.frames.push({
                direction,
                type: raw.type,
                appType: v.type,
                channel: v.channel,
                requestId: v.requestId,
                keys: Object.keys(v),
              });
          } catch {
            if (entry.frames.length < 40)
              entry.frames.push({ direction, bytes: String(payload).length });
          }
        }
        ws.on("framereceived", ({ payload }) => frame("received", payload));
        ws.on("framesent", ({ payload }) => frame("sent", payload));
      });
    }
    async function snapshot(page, label, socketStart) {
      write("browser-state.json", {
        label,
        navigatorOnline: await page.evaluate(() => navigator.onLine),
      });
      await delay(3000);
      await page
        .waitForFunction(
          () => document.body.innerText.trim().length > 0,
          {},
          { timeout: 15000 },
        )
        .catch(() => {});
      const body = await page.locator("body").innerText();
      states.push({
        label,
        title: await page.title(),
        url: page.url(),
        body,
        loginScreen: /sign in|log in|登录|登入/i.test(body),
        newSockets: sockets.slice(socketStart).map((s) => ({ ...s })),
        diagnostics: await page.evaluate(() => ({
          readyState: document.readyState,
          navigatorOnline: navigator.onLine,
          electronBridge: !!window.electronBridge,
          codexRoot: !!window.__codexRoot,
          scripts: [...document.scripts].map((s) => s.src.split("/").pop()),
          resources: performance.getEntriesByType("resource").map((r) => ({
            name: r.name.split("/").pop().split("?")[0],
            duration: r.duration,
            transferSize: r.transferSize,
          })),
        })),
      });
      write("smoke-progress.json", {
        states,
        errors,
        consoleErrors,
        requestFailures,
        httpErrors,
        sockets,
      });
      await page.screenshot({ path: `/state/${label}.png`, fullPage: true });
    }
    const page = await context.newPage();
    observe(page, "tab-1");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await snapshot(page, "smoke", 0);
    const second = await context.newPage();
    observe(second, "tab-2");
    const secondStart = sockets.length;
    await second.goto(url, { waitUntil: "domcontentloaded" });
    await snapshot(second, "tab-2", secondStart);
    const beforeReload = sockets.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await snapshot(page, "tab-1-reload", beforeReload);
    const afterReload = sockets.length;
    const returnStart = sockets.length;
    await second.goto("about:blank");
    await second.goto(url, { waitUntil: "domcontentloaded" });
    await snapshot(second, "tab-2-return", returnStart);
    write("smoke.json", {
      states,
      errors,
      consoleErrors,
      requestFailures,
      httpErrors,
      sockets,
      beforeReload,
      afterReload,
    });
    assert(
      states.every((s) => s.body.trim().length > 0),
      "Blank page",
    );
    assert.equal(errors.length, 0, "Renderer page errors; inspect smoke.json");
    for (const state of states)
      assert(
        state.newSockets.some((s) => s.appSent > 0 && s.appReceived > 0),
        `${state.label}: no new bidirectional application IPC traffic`,
      );
    assert(
      afterReload > beforeReload,
      "Reload did not recreate IPC connection",
    );
    console.log(
      "Offline browser smoke passed; inspect smoke.json and smoke.png",
    );
  } finally {
    if (browser) await browser.close();
    const exited = new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) resolve();
      else server.once("exit", resolve);
    });
    server.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
    fs.closeSync(log);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
