// Only scripts/dot-shell-validation.py may run this harness. No message sending.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (file, data) =>
  fs.writeFileSync("/state/" + file, JSON.stringify(data, null, 2));
const children = [];
const evidence = {
  oldPort: 8214,
  dotPort: 8215,
  sendAttemptCount: 0,
  errors: [],
  requests: [],
  rejectedRequests: [],
};
let browser, relay, bridge, page, dotSetup;
const connections = new Set();
const stage = (value) => {
  evidence.stage = value;
  write("shell.json", evidence);
};
function nested(name, command, extra = {}) {
  const args = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--clearenv",
  ];
  for (const [src, dst] of [
    ["/usr", "/usr"],
    ["/lib", "/lib"],
    ["/lib64", "/lib64"],
    [name === "old" ? "/old" : "/dot", "/app"],
    ["/deps", "/deps"],
    ["/bin/codex-real", "/bin/codex-real"],
    ["/usr/bin/sh", "/bin/sh"],
    ["/usr/bin/bash", "/bin/bash"],
    ["/dot/scripts/dot-external-auth-cli.cjs", "/adapter/cli.cjs"],
    ["/etc/hosts", "/etc/hosts"],
  ])
    args.push("--ro-bind", src, dst);
  const modules = (name === "old" ? "/old" : "/dot") + "/node_modules";
  args.push(
    "--ro-bind",
    "/deps",
    fs.lstatSync(modules).isSymbolicLink()
      ? fs.realpathSync(modules)
      : "/app/node_modules",
  );
  if (process.env.DOT_CHECK !== "1") {
    for (const socket of ["auth", "fetch"])
      args.push(
        "--ro-bind",
        `/run/dot/${socket}.sock`,
        `/run/dot/${socket}.sock`,
      );
  }
  args.push(
    "--tmpfs",
    "/app/.local",
    "--bind",
    "/state/" + name,
    "/state",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/state/workspace",
  );
  if (fs.existsSync("/state/relay-cert.pem"))
    args.push("--ro-bind", "/state/relay-cert.pem", "/state/relay-cert.pem");
  const env = {
    PATH: "/bin:/usr/local/bin:/usr/bin",
    NODE_PATH: "/deps",
    HOME: "/state/home",
    CODEX_HOME: "/state/codex",
    XDG_CONFIG_HOME: "/state/config",
    XDG_DATA_HOME: "/state/data",
    XDG_CACHE_HOME: "/state/cache",
    CODEX_CLI_PATH: "/adapter/cli.cjs",
    CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH: "/bin/codex-real",
    CODEX_BROWSER_FETCH_RELAY_SOCKET: "/run/dot/fetch.sock",
    DOT_AUTH_BASE_URL: "https://127.0.0.1:443/backend-api",
    SSL_CERT_FILE: "/state/relay-cert.pem",
    NODE_EXTRA_CA_CERTS: "/state/relay-cert.pem",
    ...extra,
  };
  for (const [key, value] of Object.entries(env))
    args.push("--setenv", key, value);
  args.push("--", ...command);
  const child = spawn("/usr/bin/bwrap", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    assert(
      child.exitCode === null && child.signalCode === null,
      "Application exited before HTTP ready",
    );
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("Application HTTP startup timed out");
}
(async () => {
  assert(process.env.DOT_VALIDATION_NONCE, "Use namespace launcher");
  assert(!fs.existsSync("/root/.codex"));
  assert.equal(
    fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").length,
    1,
  );
  const inaccessible = await new Promise((resolve) => {
    const s = net.connect({
      host: "127.0.0.1",
      port: Number(process.env.DOT_VALIDATION_HOST_PORT),
    });
    s.setTimeout(1000);
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
    s.once("timeout", () => {
      s.destroy();
      resolve(true);
    });
  });
  assert(inaccessible, "Host listener reachable");
  for (const name of ["old", "new"]) {
    const probe = nested(name, [
      "/usr/local/bin/node",
      "-e",
      `const fs=require('fs'),a=require('assert/strict');a(!fs.existsSync('/root/.codex'));a(!fs.existsSync('/old'));a(!fs.existsSync('/dot'));a(!fs.existsSync('/state/${name === "old" ? "new" : "old"}'));a.equal(fs.readdirSync(process.env.CODEX_HOME).length,0);let ro=false;try{fs.writeFileSync('/app/.isolation-probe','x')}catch(e){ro=e.code==='EROFS'||e.code==='EACCES'}a(ro);fs.writeFileSync('/state/isolation.json',JSON.stringify({independentHome:true,otherApplicationInvisible:true,sourceReadOnly:true}));`,
    ]);
    let diagnostic = "";
    probe.stderr.on("data", (c) => (diagnostic += c));
    const code = await new Promise((resolve) => probe.once("exit", resolve));
    assert.equal(code, 0, "Nested isolation failed: " + diagnostic);
  }
  write("isolation.json", {
    nonce: process.env.DOT_VALIDATION_NONCE,
    hostListenerReachable: false,
    independentApplications: true,
  });
  if (process.env.DOT_CHECK === "1") return;
  const requests = evidence.requests,
    rejectedRequests = evidence.rejectedRequests;
  const certificate = require("node:child_process").spawnSync(
    "/usr/bin/openssl",
    [
      "req",
      "-config",
      "/dev/null",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "/state/relay-key.pem",
      "-out",
      "/state/relay-cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:chatgpt.com",
    ],
    { stdio: "ignore" },
  );
  assert.equal(
    certificate.status,
    0,
    "Temporary relay certificate generation failed",
  );
  process.env.SSL_CERT_FILE = "/state/relay-cert.pem";
  process.env.NODE_EXTRA_CA_CERTS = "/state/relay-cert.pem";
  relay = require("node:https").createServer(
    {
      key: fs.readFileSync("/state/relay-key.pem"),
      cert: fs.readFileSync("/state/relay-cert.pem"),
    },
    async (req, res) => {
      const reject = (status) => {
        rejectedRequests.push({
          method: req.method,
          path: req.url.split("?")[0],
          status,
          upstream: false,
        });
        res.writeHead(status);
        res.end();
      };
      const statsigEvaluation =
        req.method === "POST" &&
        req.url === "/backend-api/wham/statsig/bootstrap";
      if (
        !statsigEvaluation &&
        (req.method !== "GET" || !req.url.startsWith("/backend-api/"))
      ) {
        reject(403);
        return;
      }
      let body;
      if (statsigEvaluation) {
        const contentType = req.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"]+"|[^;\s]+))?\s*$/i.test(
            contentType,
          )
        ) {
          reject(415);
          return;
        }
        try {
          body = await new Promise((resolve, rejectBody) => {
            let size = 0,
              exceeded = false;
            const chunks = [];
            req.on("data", (chunk) => {
              if (exceeded) return;
              size += chunk.length;
              if (size > 1024 * 1024) {
                exceeded = true;
                chunks.length = 0;
                resolve(null);
                return;
              }
              chunks.push(chunk);
            });
            req.on("end", () =>
              resolve(exceeded ? null : Buffer.concat(chunks)),
            );
            req.on("error", rejectBody);
            req.once("aborted", () =>
              rejectBody(new Error("Client aborted request")),
            );
          });
        } catch {
          if (req.aborted || res.destroyed) return;
          reject(400);
          return;
        }
        if (req.aborted || res.destroyed) return;
        if (body === null) {
          reject(413);
          return;
        }
      }
      const entry = {
        path: req.url.split("?")[0],
        method: req.method,
        requestBytes: body?.length ?? 0,
        origin:
          req.headers.host === "chatgpt.com" ? "official" : "namespace-local",
        status: null,
        bytes: 0,
      };
      requests.push(entry);
      const upstream = http.request(
        {
          socketPath: "/run/dot/fetch.sock",
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "chatgpt.com" },
        },
        (incoming) => {
          entry.status = incoming.statusCode;
          entry.contentType = incoming.headers["content-type"];
          res.writeHead(incoming.statusCode, incoming.headers);
          incoming.on("data", (chunk) => {
            entry.bytes += chunk.length;
          });
          incoming.pipe(res);
          res.on("close", () => incoming.destroy());
        },
      );
      upstream.on("error", (error) => {
        entry.error = error.code || error.name;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => upstream.destroy());
      upstream.end(body);
    },
  );
  await new Promise((resolve) => relay.listen(443, "127.0.0.1", resolve));
  const auth = await new Promise((resolve, reject) => {
    const r = http.get(
      {
        socketPath: "/run/dot/auth.sock",
        path: "/external-auth",
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
          if (data.length > 65536)
            r.destroy(new Error("Auth response too large"));
        });
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Auth unavailable"));
          }
        });
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("Auth timeout")));
  });
  assert(typeof auth.accessToken === "string" && auth.accessToken.length > 0);
  const redact = (value) =>
    String(value)
      .split(auth.accessToken)
      .join("[redacted]")
      .replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (s) => {
        try {
          let u = new URL(s);
          return u.origin + u.pathname;
        } catch {
          return "[url]";
        }
      });
  const log = (stream, file) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        fs.appendFileSync(
          "/state/" + file,
          redact(buffer.slice(0, end)) + "\n",
        );
        buffer = buffer.slice(end + 1);
      }
    });
    stream.on("end", () => {
      if (buffer) fs.appendFileSync("/state/" + file, redact(buffer) + "\n");
    });
  };
  const old = nested("old", [
    "/usr/local/bin/node",
    "/app/src/server/main.js",
    "--host",
    "127.0.0.1",
    "--port",
    "8214",
  ]);
  const dot = nested(
    "new",
    [
      "/usr/local/bin/node",
      "/app/src/server/main.js",
      "--host",
      "127.0.0.1",
      "--port",
      "8215",
    ],
    {
      CODEX_DOT_MESSAGE_ROOM_ID: process.env.DOT_ROOM,
      CODEX_DOT_EMBED_PARENT_ORIGIN: "http://127.0.0.1:8214",
    },
  );
  for (const [child, name] of [
    [old, "old"],
    [dot, "new"],
  ]) {
    log(child.stdout, name + "-server-redacted.log");
    log(child.stderr, name + "-server-redacted.log");
  }
  await Promise.all([
    ready("http://127.0.0.1:8214", old),
    ready("http://127.0.0.1:8215", dot),
  ]);
  bridge = net.createServer((client) => {
    const upstream = net.connect("/run/dot/browser-egress.sock");
    connections.add(client);
    connections.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      connections.delete(client);
      connections.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--proxy-server=http://127.0.0.1:" + bridge.address().port,
      "--proxy-bypass-list=127.0.0.1;localhost",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  page.on("pageerror", (error) =>
    evidence.errors.push({ type: "pageerror", message: redact(error.message) }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      evidence.errors.push({
        type: "console",
        message: redact(message.text()),
      });
  });
  // Prepare only the new application's local onboarding; every cloud mutation remains denied.
  dotSetup = await context.newPage();
  stage("new-dot-onboarding");
  await dotSetup.goto("http://127.0.0.1:8215/dots/home");
  await Promise.race([
    dotSetup
      .getByRole("button", { name: "Something else", exact: true })
      .waitFor({ timeout: 90000 }),
    dotSetup
      .getByText(process.env.DOT_MARKER, { exact: true })
      .last()
      .waitFor({ timeout: 90000 }),
  ]);
  if (new URL(dotSetup.url()).pathname === "/welcome") {
    await dotSetup
      .getByRole("button", { name: "Something else", exact: true })
      .click();
    const toggle = dotSetup.getByLabel("Enable personalized suggestions", {
      exact: true,
    });
    if ((await toggle.getAttribute("aria-checked")) === "true")
      await toggle.click();
    await dotSetup
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await dotSetup.waitForURL((u) => u.pathname !== "/welcome", {
      timeout: 30000,
    });
    await dotSetup.goto("http://127.0.0.1:8215/dots/home");
  }
  await dotSetup
    .getByText(process.env.DOT_MARKER, { exact: true })
    .last()
    .waitFor({ timeout: 90000 });
  await dotSetup.close();
  stage("old-shell-navigation");
  await page.goto("http://127.0.0.1:8214");
  const dotButton = page.getByRole("button", { name: "Dot", exact: true });
  await Promise.race([
    dotButton.waitFor({ timeout: 90000 }),
    page.getByRole("button", { name: "Something else", exact: true }).waitFor({ timeout: 90000 }),
  ]);
  await page.screenshot({ path: "/state/old-initial.png", fullPage: true });
  if (await page.getByRole("button", { name: "Something else", exact: true }).isVisible()) {
    stage("old-shell-onboarding");
    await page.getByRole("button", { name: "Something else", exact: true }).click();
    const toggle = page.getByLabel("Enable personalized suggestions", { exact: true });
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await dotButton.waitFor({ timeout: 90000 });
  const composer = page
    .locator('[contenteditable="true"], textarea')
    .filter({ visible: true })
    .first();
  await composer.waitFor({ timeout: 30000 });
  const draft = "DOT-SHELL-DRAFT-NOT-SENT";
  await composer.fill(draft);
  await delay(500);
  const oldPath = new URL(page.url()).pathname;
  const draftHandle = await composer.elementHandle();
  await page.screenshot({ path: "/state/old-before-dot.png", fullPage: true });
  stage("embedded-dot-readback");
  await dotButton.click();
  await delay(500);
  evidence.dotClick = await page.evaluate(() => ({
    pathname: location.pathname,
    shimAvailable: Boolean(window.__ELECTRON_SHIM__?.dotPanel),
    originals: document.querySelectorAll("[data-dot-original-content]").length,
    frames: [...document.querySelectorAll("iframe[data-dot-panel]")].map((frame) => ({
      hidden: frame.hidden, width: frame.getBoundingClientRect().width,
      height: frame.getBoundingClientRect().height,
    })),
    buttons: [...document.querySelectorAll('button[aria-label="Dot"]')].map((button) => ({
      pressed: button.getAttribute("aria-pressed"), connected: button.isConnected,
    })),
  }));
  write("shell.json", evidence);
  const frameElement = page.locator("iframe[data-dot-panel]");
  await frameElement.waitFor();
  const frame = await (await frameElement.elementHandle()).contentFrame();
  assert(frame);
  const reply = frame.getByText(process.env.DOT_MARKER, { exact: true }).last();
  await reply.waitFor({ timeout: 90000 });
  await delay(2000);
  assert(await reply.isVisible());
  assert.equal(new URL(frame.url()).origin, "http://127.0.0.1:8215");
  const opaque = await frameElement.evaluate((element) => {
    try {
      return element.contentWindow.document === undefined;
    } catch (error) {
      return error.name === "SecurityError";
    }
  });
  assert(opaque, "Frame DOM accessible across origins");
  assert.equal(
    await frame.locator('meta[name="codex-dot-embed"]').getAttribute("content"),
    "true",
  );
  const sidebar = frame.locator("#app-shell-sidebar");
  assert.equal(
    await sidebar.count(),
    1,
    "Native sidebar semantic anchor absent",
  );
  assert(await sidebar.isHidden(), "Embedded native sidebar remains visible");
  evidence.embedded = {
    markerVisible: true,
    embedMeta: true,
    nativeSidebarHidden: true,
    crossOriginDOMBlocked: true,
    hostOrigin: new URL(page.url()).origin,
    frameOrigin: new URL(frame.url()).origin,
  };
  await page.screenshot({
    path: "/state/old-shell-with-dot.png",
    fullPage: true,
  });
  await dotButton.click();
  assert(await frameElement.isHidden());
  assert(await draftHandle.evaluate((element) => element.isConnected));
  const text = await composer.evaluate((element) =>
    "value" in element ? element.value : element.textContent,
  );
  assert.equal(text, draft);
  assert.equal(new URL(page.url()).pathname, oldPath);
  evidence.oldPreserved = {
    draftUnchanged: true,
    originalNodeConnected: true,
    pathUnchanged: true,
  };
  await page.screenshot({ path: "/state/old-after-dot.png", fullPage: true });
  await dotButton.click();
  await reply.waitFor({ state: "visible" });
  evidence.reopened = true;
  await dotButton.click();
  await page.setViewportSize({ width: 390, height: 844 });
  stage("phone-dot-navigation");
  const trigger = page
    .locator("[data-app-shell-sidebar-trigger]")
    .filter({ visible: true })
    .first();
  await trigger.click();
  await page.getByRole("button", { name: "Dot", exact: true }).click();
  const phoneFrameElement = page
    .locator("iframe[data-dot-panel]")
    .filter({ visible: true });
  await phoneFrameElement.waitFor({ state: "visible" });
  const phoneFrame = await (
    await phoneFrameElement.elementHandle()
  ).contentFrame();
  await phoneFrame
    .getByText(process.env.DOT_MARKER, { exact: true })
    .last()
    .waitFor({ state: "visible", timeout: 90000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#app-shell-sidebar")].every((element) => {
        const r = element.getBoundingClientRect();
        return (
          getComputedStyle(element).display === "none" ||
          getComputedStyle(element).visibility === "hidden" ||
          r.width === 0 ||
          r.right <= 0 ||
          r.left >= innerWidth
        );
      }),
    {},
    { timeout: 10000 },
  );
  evidence.phone = {
    width: 390,
    height: 844,
    originalSidebarClosed: true,
    markerVisible: true,
  };
  await page.screenshot({
    path: "/state/phone-shell-with-dot.png",
    fullPage: true,
  });
  stage("complete");
  write("shell.json", evidence);
})()
  .catch(async (error) => {
    if (page && !page.isClosed())
      await page
        .screenshot({ path: "/state/failure-old.png", fullPage: true })
        .catch(() => {});
    if (dotSetup && !dotSetup.isClosed())
      await dotSetup
        .screenshot({ path: "/state/failure-dot.png", fullPage: true })
        .catch(() => {});
    evidence.failure = String(error.message).replace(
      /(?:https?|wss?):\/\/[^\s"'<>]+/gi,
      (s) => s.split(/[?#]/)[0],
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    for (const child of children.reverse()) await stop(child);
    for (const socket of connections) socket.destroy();
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    if (relay) {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
    }
    write("shell.json", evidence);
  });
