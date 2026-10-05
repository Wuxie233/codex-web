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
  const { createInterface } = require("node:readline");
  const requests = [],
    rejectedRequests = [],
    errors = [],
    children = [];
  let browser;
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
  const relay = require("node:https").createServer(
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
  process.env.DOT_AUTH_BASE_URL = `https://127.0.0.1:${relay.address().port}/backend-api`;
  const transportCheck = await new Promise((resolve, reject) => {
    const probe = require("node:https").request(
      {
        hostname: "chatgpt.com",
        port: 443,
        path: "/backend-api/tbo/primary",
        method: "POST",
        ca: fs.readFileSync("/state/relay-cert.pem"),
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            officialHostTLS: true,
            rejectedMethod: "POST",
            rejectedPath: "/backend-api/tbo/primary",
            permittedPost: "/backend-api/wham/statsig/bootstrap",
            status: response.statusCode,
            upstreamRequests: requests.length,
          }),
        );
      },
    );
    probe.on("error", reject);
    probe.end();
  });
  assert.equal(transportCheck.status, 403);
  assert.equal(transportCheck.upstreamRequests, 0);
  transportCheck.boundaries = [];
  for (const check of [
    {
      path: "/backend-api/wham/statsig/bootstrap?extra=1",
      contentType: "application/json",
      expected: 403,
    },
    {
      path: "/backend-api/wham/statsig/%62ootstrap",
      contentType: "application/json",
      expected: 403,
    },
    {
      path: "/backend-api/wham/statsig/bootstrap",
      contentType: "text/plain",
      expected: 415,
    },
    {
      path: "/backend-api/wham/statsig/bootstrap",
      contentType: "application/json",
      body: Buffer.alloc(1024 * 1024 + 1, 32),
      expected: 413,
    },
  ]) {
    const status = await new Promise((resolve, reject) => {
      const probe = require("node:https").request(
        {
          hostname: "chatgpt.com",
          port: 443,
          path: check.path,
          method: "POST",
          headers: { "content-type": check.contentType },
          ca: fs.readFileSync("/state/relay-cert.pem"),
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      probe.on("error", reject);
      probe.end(check.body || "{}");
    });
    assert.equal(status, check.expected);
    assert.equal(requests.length, 0);
    transportCheck.boundaries.push({
      path: check.path,
      contentType: check.contentType,
      requestBytes: check.body?.length ?? 2,
      status,
      upstreamRequests: requests.length,
    });
  }
  const evidence = {
    requests,
    rejectedRequests,
    errors,
    transportCheck,
    authenticated: null,
  };
  const stop = async (child) => {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) return;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exit, delay(2000)]);
    if (!exited()) {
      child.kill("SIGKILL");
      await exit;
    }
  };
  try {
    if (process.env.DOT_SKIP_ACCOUNT_PREFLIGHT !== "1") {
      const cli = spawn(process.env.CODEX_CLI_PATH, ["app-server"], {
        cwd: "/state/workspace",
        stdio: ["pipe", "pipe", "ignore"],
      });
      children.push(cli);
      const pending = new Map();
      let id = 0;
      createInterface({ input: cli.stdout }).on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        const task = pending.get(message.id);
        if (task) {
          pending.delete(message.id);
          clearTimeout(task.timeout);
          message.error
            ? task.reject(
                new Error(
                  "Native RPC rejected: " +
                    String(message.error.message).replace(
                      /eyJ[A-Za-z0-9_.-]+/g,
                      "[redacted]",
                    ),
                ),
              )
            : task.resolve(message.result);
        }
      });
      const rpc = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const key = ++id;
          pending.set(key, {
            resolve,
            reject,
            timeout: setTimeout(() => {
              pending.delete(key);
              reject(new Error(`RPC timeout: ${method}`));
            }, 20000),
          });
          cli.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
        });
      await rpc("initialize", {
        clientInfo: { name: "dot-validation", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      const account = await rpc("account/read", { refreshToken: false });
      const authStatus = await rpc("getAuthStatus", {
        includeToken: false,
        refreshToken: false,
      });
      evidence.account = {
        type: account.account?.type,
        planType: account.account?.planType,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
      };
      evidence.authStatus = {
        authMethod: authStatus.authMethod,
        requiresOpenaiAuth: authStatus.requiresOpenaiAuth,
        tokenReturned: Boolean(authStatus.authToken),
      };
      assert.equal(
        account.account?.type,
        "chatgpt",
        "Native account not ChatGPT",
      );
      assert(
        ["chatgpt", "chatgptAuthTokens"].includes(authStatus.authMethod),
        "Native authentication not ready",
      );
      assert(!authStatus.authToken, "includeToken:false returned a token");
      evidence.authenticated = true;
      await stop(cli);
    } else {
      evidence.accountPreflight =
        "skipped; reuse prior verified native account read";
    }
    write("cloud-progress.json", evidence);
    const portServer = net.createServer();
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const authForRedaction = await new Promise((resolve, reject) => {
      const request = http.get(
        {
          socketPath: "/run/dot/auth.sock",
          path: "/external-auth",
          timeout: 10000,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536)
              request.destroy(new Error("Auth redaction response too large"));
          });
          response.on("end", () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("Cannot initialize secret redaction"));
            }
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Auth redaction timeout")),
      );
      request.on("error", reject);
    });
    assert.equal(typeof authForRedaction.accessToken, "string");
    const redact = (value) =>
      String(value)
        .split(authForRedaction.accessToken)
        .join("[redacted]")
        .replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]")
        .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
    const logLines = (stream) => {
      let buffered = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf("\n")) !== -1) {
          fs.appendFileSync(
            "/state/server-redacted.log",
            redact(buffered.slice(0, end)) + "\n",
          );
          buffered = buffered.slice(end + 1);
        }
      });
      stream.on("end", () => {
        if (buffered)
          fs.appendFileSync(
            "/state/server-redacted.log",
            redact(buffered) + "\n",
          );
      });
    };
    const server = spawn(
      process.execPath,
      [
        "/app/src/server/main.js",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: "/state/workspace", stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(server);
    logLines(server.stdout);
    logLines(server.stderr);
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error("Backend exited");
      try {
        if ((await fetch(url)).ok) {
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
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const resources = [],
      sockets = [],
      consoleDiagnostics = [];
    let uiPhase = "initial";
    const requestPhases = new WeakMap();
    const safeDiagnostic = (value) =>
      redact(value).replace(
        /https?:\/\/[^\s"'<>]+/g,
        (url) => url.split(/[?#]/)[0],
      );
    page.on("request", (request) => requestPhases.set(request, uiPhase));
    evidence.consoleDiagnostics = consoleDiagnostics;
    evidence.resources = resources;
    evidence.sockets = sockets;
    page.on("response", (response) =>
      resources.push({
        path: new URL(response.url()).pathname,
        origin: new URL(response.url()).origin,
        phase: requestPhases.get(response.request()),
        resourceType: response.request().resourceType(),
        status: response.status(),
        type: response.headers()["content-type"],
      }),
    );
    page.on("requestfailed", (request) =>
      errors.push({
        type: "requestfailed",
        path: new URL(request.url()).pathname,
        origin: new URL(request.url()).origin,
        phase: requestPhases.get(request),
        failure: safeDiagnostic(request.failure()?.errorText || "unknown"),
      }),
    );
    page.on("websocket", (socket) => {
      const item = {
        path: new URL(socket.url()).pathname,
        sent: 0,
        received: 0,
        types: {},
        frames: [],
      };
      sockets.push(item);
      for (const [event, field] of [
        ["framesent", "sent"],
        ["framereceived", "received"],
      ])
        socket.on(event, (frame) => {
          item[field]++;
          try {
            const message = JSON.parse(String(frame.payload));
            const value =
              message.type === "bridge-frame" ? message.payload : message;
            if (item.frames.length < 600)
              item.frames.push({
                direction: field,
                type: value.type,
                channel: value.channel,
                requestId: value.requestId,
                ok: value.ok,
                keys: Object.keys(value),
                dataKeys:
                  value.data && typeof value.data === "object"
                    ? Object.keys(value.data)
                    : [],
              });
            const key = String(value.type || "unknown");
            item.types[key] = (item.types[key] || 0) + 1;
          } catch {}
        });
    });
    page.on("pageerror", (e) =>
      errors.push({
        type: "pageerror",
        name: e.name,
        message: redact(e.message),
      }),
    );
    let consoleErrorCount = 0;
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrorCount++;
      if (
        ["error", "warning"].includes(message.type()) &&
        consoleDiagnostics.length < 120
      ) {
        const text = safeDiagnostic(message.text()).slice(0, 2000);
        consoleDiagnostics.push({
          type: message.type(),
          phase: uiPhase,
          category: /orbit|character|webassembly|wasm|worker/i.test(text)
            ? "orbit-runtime"
            : /statsig/i.test(text)
              ? "statsig"
              : "other",
          text,
        });
      }
    });
    await page.goto(url + "/dots/home", { waitUntil: "domcontentloaded" });
    const renderStartedAt = Date.now();
    const waitForStablePage = async (timeout = 45000) => {
      try {
        await page.waitForFunction(
          () => {
            const text = document.body.innerText.trim();
            if (!text || /^Loading(?:…|\.\.\.)?$/i.test(text)) {
              window.__dotValidationStable = null;
              return false;
            }
            const signature = location.pathname + "\n" + text;
            if (window.__dotValidationStable?.signature !== signature) {
              window.__dotValidationStable = { signature, since: Date.now() };
              return false;
            }
            return Date.now() - window.__dotValidationStable.since >= 2000;
          },
          {},
          { timeout },
        );
      } catch {}
    };
    await waitForStablePage(90000);
    if (new URL(page.url()).pathname === "/welcome") {
      evidence.onboarding = {
        initialPath: "/welcome",
        action: "Skip",
        cloudWritesAllowed: false,
      };
      await page.screenshot({
        path: "/state/onboarding-before-skip.png",
        fullPage: true,
      });
      const skip = page.getByRole("button", { name: "Skip", exact: true });
      if (await skip.isVisible()) {
        await skip.click();
      } else {
        evidence.onboarding.action =
          "Something else; disable personalized suggestions; Continue";
        await page
          .getByRole("button", { name: "Something else", exact: true })
          .click();
        const toggle = page.getByLabel("Enable personalized suggestions", {
          exact: true,
        });
        const toggleState = () =>
          toggle.evaluate((element) => ({
            ariaChecked: element.getAttribute("aria-checked"),
            checked: element.checked,
          }));
        evidence.onboarding.personalizedBefore = await toggleState();
        if (
          evidence.onboarding.personalizedBefore.ariaChecked === "true" ||
          evidence.onboarding.personalizedBefore.checked === true
        )
          await toggle.click();
        evidence.onboarding.personalizedAfter = await toggleState();
        assert(
          evidence.onboarding.personalizedAfter.ariaChecked === "false" ||
            evidence.onboarding.personalizedAfter.checked === false,
          "Personalized suggestions still enabled",
        );
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await waitForStablePage(15000);
        if (new URL(page.url()).pathname === "/welcome") {
          const migrationSkip = page.getByRole("button", {
            name: /^(Skip|Not now)$/,
          });
          if (await migrationSkip.first().isVisible()) {
            evidence.onboarding.followupAction = await migrationSkip
              .first()
              .innerText();
            await migrationSkip.first().click();
          }
        }
      }
      try {
        await page.waitForURL((location) => location.pathname !== "/welcome", {
          timeout: 30000,
        });
      } catch {}
      evidence.onboarding.afterSkipPath = new URL(page.url()).pathname;
      evidence.onboarding.localFlowContinued =
        evidence.onboarding.afterSkipPath !== "/welcome";
      await page.screenshot({
        path: "/state/onboarding-after-skip.png",
        fullPage: true,
      });
      if (evidence.onboarding.localFlowContinued) {
        uiPhase = "dot";
        await page.goto(url + "/dots/home", { waitUntil: "domcontentloaded" });
        await waitForStablePage();
      }
    }
    if (new URL(page.url()).pathname.startsWith("/dots/"))
      await page.waitForTimeout(4000);
    evidence.renderWaitMs = Date.now() - renderStartedAt;
    evidence.ui = await page.evaluate(() => ({
      path: location.pathname,
      text: document.body.innerText.slice(0, 18000),
      online: navigator.onLine,
      dom: [...document.body.querySelectorAll("*")]
        .slice(0, 50)
        .map((element) => ({
          tag: element.tagName,
          id: element.id,
          class: typeof element.className === "string" ? element.className : "",
          children: element.children.length,
          display: getComputedStyle(element).display,
          opacity: getComputedStyle(element).opacity,
          visibility: getComputedStyle(element).visibility,
        })),
      bridge: Boolean(window.electronBridge),
      root: Boolean(window.__codexRoot),
      scripts: [...document.scripts].map(
        (script) => new URL(script.src || location.href).pathname,
      ),
    }));
    evidence.ui.nonempty =
      evidence.ui.text.trim().length > 0 &&
      !/^Loading(?:…|\.\.\.)?$/i.test(evidence.ui.text.trim());
    evidence.consoleErrorCount = consoleErrorCount;
    await page.screenshot({ path: "/state/dots-home.png", fullPage: true });
    const startupLog = fs.readFileSync("/state/server-redacted.log", "utf8");
    evidence.blockedBackendRequests = startupLog
      .split("\n")
      .filter(
        (line) =>
          line.includes("sa_server_request_failed") &&
          line.includes("Browser relay only permits"),
      )
      .map((line) => ({
        method: /method=([^ ]+)/.exec(line)?.[1],
        path: /routePattern=([^ ]+)/.exec(line)?.[1],
        reason: "Rejected by browser relay read-only policy",
        upstream: false,
      }));
    if (evidence.onboarding)
      evidence.onboarding.rejectedCompletion =
        evidence.blockedBackendRequests.some(
          (item) => item.path === "/wham/onboarding/desktop/complete",
        );
    evidence.startup = {
      launches: (startupLog.match(/Launching app agentRunId=/g) || []).length,
      bootstrapFailure: startupLog.includes(
        "Desktop bootstrap failed to start the main app",
      ),
    };
    write("cloud.json", evidence);
    assert.equal(
      evidence.startup.launches,
      1,
      "Desktop must launch exactly once",
    );
    assert(!evidence.startup.bootstrapFailure, "Desktop bootstrap failed");
    assert(evidence.ui.nonempty, "Dot page has no rendered text");
    assert(evidence.ui.path.startsWith("/dots/"), "Did not reach Dot route");
  } finally {
    await browser?.close();
    for (const child of children.reverse()) await stop(child);
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
    evidence.authFilePersisted = fs.existsSync("/state/codex/auth.json");
    write("cloud.json", evidence);
    assert(!evidence.authFilePersisted, "Native CLI persisted auth.json");
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
