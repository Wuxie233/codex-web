#!/usr/bin/env node
"use strict";
// Temporary external-auth adapter. Secrets live only in process memory and pipes.
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const http = require("node:http");
const args = process.argv.slice(2);
const audit = (event, method, details = {}) =>
  require("node:fs").appendFileSync(
    "/state/protocol-events.jsonl",
    JSON.stringify({
      event,
      pid: process.pid,
      ...details,
      method: String(method)
        .replace(/[^a-zA-Z0-9_/-]/g, "")
        .slice(0, 100),
    }) + "\n",
  );
if (!args.includes("app-server")) {
  if (
    !args.every((arg) => ["--version", "--help"].includes(arg)) ||
    !args.length
  )
    process.exit(64);
  const child = spawn("/bin/codex-real", args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  if (
    !/^https:\/\/127\.0\.0\.1:\d+\/backend-api$/.test(
      process.env.DOT_AUTH_BASE_URL || "",
    )
  )
    throw new Error("Missing private relay URL");
  require("node:fs").appendFileSync(
    "/state/wrapper-environment.jsonl",
    JSON.stringify({
      pid: process.pid,
      sslCertFile: Boolean(process.env.SSL_CERT_FILE),
      sslCertFileExpected:
        process.env.SSL_CERT_FILE === "/state/relay-cert.pem",
      extraCACertsExpected:
        process.env.NODE_EXTRA_CA_CERTS === "/state/relay-cert.pem",
      proxyVariablesPresent: [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
      ].filter((key) => Boolean(process.env[key])),
      caReadable: require("node:fs").existsSync("/state/relay-cert.pem"),
      extraCACerts: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      relayURL: Boolean(process.env.DOT_AUTH_BASE_URL),
      laterBaseURLConfig: args.some((arg) => /^chatgpt_base_url\s*=/.test(arg)),
      configKeys: args
        .filter((arg) => /^[a-zA-Z_][a-zA-Z0-9_.]*=/.test(arg))
        .map((arg) => arg.split("=")[0]),
    }) + "\n",
  );
  const child = spawn(
    "/bin/codex-real",
    [
      "-c",
      `chatgpt_base_url=${JSON.stringify(process.env.DOT_AUTH_BASE_URL)}`,
      ...args,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const requestMethods = new Map();
  const send = (message) => {
    if (message.method && message.id !== undefined)
      requestMethods.set(message.id, message.method);
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const output = (message) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const deny = (message, reason) => {
    audit("denied", message.method);
    if (message.id !== undefined)
      output({ id: message.id, error: { code: -32000, message: reason } });
  };
  let initializeId,
    initializeResponse,
    ready = false;
  const secrets = [];
  const safeError = (error) =>
    secrets
      .reduce(
        (text, secret) => text.split(secret).join("[redacted]"),
        String(error?.message || "Unknown native error"),
      )
      .replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]")
      .slice(0, 500);
  createInterface({ input: child.stderr }).on("line", (line) =>
    require("node:fs").appendFileSync(
      "/state/native-redacted.log",
      JSON.stringify({
        pid: process.pid,
        line: safeError({ message: line }).replace(
          /Bearer\s+[^\s"']+/gi,
          "Bearer [redacted]",
        ),
      }) + "\n",
    ),
  );
  const loginId = "__dot_validation_external_login";
  const allowed =
    /^(initialize|getAuthStatus|getConfig|getUserAgent|getConversationSummary|config\/(read|batchWrite)|project\/list|remoteControl\/status\/read|fs\/readFile|configRequirements\/read|account\/read|account\/gatewayOAuth\/read|account\/rateLimits\/read|thread\/(list|read|loaded\/list)|model\/list|skills\/list|app\/list|mcpServerStatus\/list|experimentalFeature\/(list|enablement\/set)|collaborationMode\/list|plugin\/list)$/;
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "initialize") initializeId = message.id;
    if (!allowed.test(message.method || ""))
      return deny(message, "Read-only cloud validation forbids this operation");
    if (message.params?.refreshToken === true)
      return deny(message, "Shared credential refresh is forbidden");
    if (!ready && message.method !== "initialize")
      return deny(message, "External authentication not ready");
    audit("forwarded", message.method);
    send(message);
  });
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message.method && requestMethods.has(message.id)) {
      const method = requestMethods.get(message.id);
      requestMethods.delete(message.id);
      if (["account/read", "getAuthStatus"].includes(method)) {
        const origins = [];
        const findOrigins = (value, depth = 0) => {
          if (!value || typeof value !== "object" || depth > 6) return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "backendOrigin" && typeof child === "string") {
              try {
                const host = new URL(child).hostname;
                origins.push(
                  host === "chatgpt.com"
                    ? "chatgpt"
                    : host === "127.0.0.1"
                      ? "local"
                      : "other",
                );
              } catch {}
            } else findOrigins(child, depth + 1);
          }
        };
        findOrigins(message.result);
        audit("response", method, {
          success: !message.error,
          errorCode: message.error?.code,
          accountType: message.result?.account?.type,
          authMethod: message.result?.authMethod,
          routingOrigins: origins,
        });
      }
    }
    if (message.method && message.id !== undefined) {
      send({
        id: message.id,
        error: {
          code: -32000,
          message: "Validation refuses server requests and credential refresh",
        },
      });
      return;
    }
    if (message.id === loginId) {
      if (message.error) {
        output({
          id: initializeId,
          error: {
            code: -32000,
            message:
              "Native external auth rejected: " + safeError(message.error),
          },
        });
        child.kill();
        return;
      }
      ready = true;
      output(initializeResponse);
      return;
    }
    if (initializeId !== undefined && message.id === initializeId && !ready) {
      if (message.error) return output(message);
      initializeResponse = message;
      send({ method: "initialized" });
      try {
        const auth = await new Promise((resolve, reject) => {
          const req = http.get(
            {
              socketPath: "/run/dot/auth.sock",
              path: "/external-auth",
              timeout: 10000,
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
                if (body.length > 65536)
                  req.destroy(new Error("Auth response too large"));
              });
              res.on("end", () => {
                try {
                  if (res.statusCode !== 200)
                    throw new Error("Auth unavailable");
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error("Invalid external auth response"));
                }
              });
            },
          );
          req.on("timeout", () => req.destroy(new Error("Auth timeout")));
          req.on("error", reject);
        });
        if (
          typeof auth.accessToken !== "string" ||
          typeof auth.chatgptAccountId !== "string"
        )
          throw new Error("Incomplete external auth");
        secrets.push(auth.accessToken, auth.chatgptAccountId);
        send({
          id: loginId,
          method: "account/login/start",
          params: {
            type: "chatgptAuthTokens",
            accessToken: auth.accessToken,
            chatgptAccountId: auth.chatgptAccountId,
            ...(auth.chatgptPlanType
              ? { chatgptPlanType: auth.chatgptPlanType }
              : {}),
          },
        });
      } catch {
        output({
          id: initializeId,
          error: { code: -32000, message: "External auth bootstrap failed" },
        });
        child.kill();
      }
      return;
    }
    if (ready) output(message);
  });
  process.stdin.on("end", () => child.kill());
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}
