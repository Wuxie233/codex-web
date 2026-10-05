#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { ResumableBridge } from "./resumable-bridge";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import { parseDotEmbedParentOrigin, registerDotEmbed } from "./dot-embed";
import { rebaseRequestDeadlines } from "./request-deadline";
import { isIsolatedBrowserRequest, isUserAppNavigation } from "./browser-isolation";
import { registerBrowserPreviewRoutes } from "./browser-preview";
import { registerDownloadRoute } from "./download";
import { registerUploadRoutes } from "./uploads";
import { RemoteBrowser } from "./remote-browser";
import { registerRemoteBrowserRoutes } from "./remote-browser-routes";
import { QuotaRecovery } from "./quota-recovery";
import { ipcMain } from "./electron/index";
import { RealtimeWindows, type RealtimeWindow } from "./realtime-windows";

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly pendingMessages: unknown[] = [];
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    if (event === "message") {
      for (const data of this.pendingMessages.splice(0)) {
        this.receiveMessage(data);
      }
    }

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      this.pendingMessages.push(data);
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.pendingMessages.length = 0;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type RendererWindow = RealtimeWindow & {
  webContents: { id: number; emit(event: string): unknown };
  emit(event: string): unknown;
};

type IpcMainBridgeState = {
  setRendererWindowFactory?: (factory: () => Promise<RendererWindow>) => void;
  attachRealtimeWindow?: (window: RendererWindow, owner: number) => void;
  closeRealtimeWindow?: (id: number) => boolean;
  getRealtimeOwnerId?: (id: number) => number | undefined;
  canAttachRealtimeWindow?: (id: number, owner: number) => boolean;
  sendToRenderer?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  registerDotEmbed(app, parseDotEmbedParentOrigin(process.env.CODEX_DOT_EMBED_PARENT_ORIGIN), async () => {
    const delivery = path.resolve(__dirname, "../../scratch/webview-delivery/index.html");
    try { return await fs.readFile(delivery, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return fs.readFile(path.resolve(__dirname, "../../scratch/asar/webview/index.html"), "utf8");
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (
      isIsolatedBrowserRequest(request.headers) &&
      !isUserAppNavigation(request.method, request.url, request.headers) &&
      !(request.method === "GET" || request.method === "HEAD"
        ? request.url.startsWith("/__backend/browser-preview/")
        : false)
    ) {
      return reply
        .code(403)
        .send({ error: "Isolated previews cannot access the application" });
    }
  });
  registerBrowserPreviewRoutes(app);
  registerDownloadRoute(app);
  const remoteBrowser = new RemoteBrowser();
  Object.assign(globalThis, { __codexRemoteBrowser: remoteBrowser });
  const browserAppHost = options.host.includes(":")
    ? `[${options.host}]`
    : options.host;
  remoteBrowser.setAppOrigin(`http://${browserAppHost}:${options.port}`);
  remoteBrowser.setAppOrigin(`http://localhost:${options.port}`);
  const upgradeRemoteBrowser = registerRemoteBrowserRoutes(app, remoteBrowser);
  // Only this web process owns these Chromium children. The shared app-server
  // remains untouched when the web service exits or reloads.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void remoteBrowser.dispose().finally(() => process.exit(0));
    });
  }
  const websocketServer = new WebSocketServer({
    noServer: true,
    // Native initialization includes large RPC snapshots; keep them off the wire
    // uncompressed without retaining a compression dictionary between messages.
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 3 },
      threshold: 1024,
    },
  });

  await registerUploadRoutes(app);

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
    setHeaders(response) {
      // Uploaded suffixes can select active document MIME types, not only HTML.
      response.setHeader(
        "Content-Security-Policy",
        "sandbox allow-scripts; connect-src 'none'; form-action 'none'",
      );
    },
  });

  await app.register(fastifyStatic, {
    root: [
      path.resolve(__dirname, "../../scratch/webview-delivery"),
      path.resolve(__dirname, "../../scratch/asar/webview"),
    ],
    preCompressed: true,
    prefix: "/",
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    if (upgradeRemoteBrowser(request, socket, head)) return;
    if (isIsolatedBrowserRequest(request.headers)) {
      socket.destroy();
      return;
    }
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const rendererSockets = new Map<number, WebSocket | ResumableBridge>();
  const resumableBridges = new Map<string, ResumableBridge>();
  const realtimeWindows = new RealtimeWindows((owner, message) => {
    const socket = rendererSockets.get(owner);
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  });
  bridgeState.attachRealtimeWindow = (window, owner) =>
    realtimeWindows.attach(window, owner);
  bridgeState.closeRealtimeWindow = (id) => realtimeWindows.close(id);
  bridgeState.getRealtimeOwnerId = (id) => realtimeWindows.getOwner(id);
  bridgeState.canAttachRealtimeWindow = (id, owner) =>
    realtimeWindows.canAttach(id, owner);
  const rendererWindowFactory = new Promise<() => Promise<RendererWindow>>(
    (resolve) => {
      bridgeState.setRendererWindowFactory = resolve;
    },
  );
  bridgeState.sendToRenderer = (webContentsId, message): void => {
    const socket = rendererSockets.get(webContentsId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  websocketServer.on("connection", (transport, request) => {
    let socket: WebSocket | ResumableBridge = transport;
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    // Recovery checks must not allocate a throwaway Desktop renderer just before
    // the browser reloads and creates its actual renderer.
    if (params.get("recoveryProbe") === "1" && !params.has("realtimeToken")) {
      void rendererWindowFactory.then(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "bridge-recovery-ready" }));
        }
      });
      return;
    }
    if (!params.has("realtimeToken") && params.has("resumeToken")) {
      const bridge = resumableBridges.get(params.get("resumeToken")!);
      if (!bridge || !params.has("after") || !bridge.attach(transport, Number(params.get("after")))) {
        transport.send(JSON.stringify({ type: "bridge-recovery-ready" }));
        transport.close(1000, "Session unavailable");
      }
      return;
    }
    if (!params.has("realtimeToken") && params.get("resumable") === "1") {
      const bridge = new ResumableBridge(() => resumableBridges.delete(bridge.token));
      resumableBridges.set(bridge.token, bridge);
      bridge.attach(transport);
      socket = bridge;
    }
    const token = new URL(
      request.url ?? "/",
      "http://localhost",
    ).searchParams.get("realtimeToken");
    let rendererWindow: RendererWindow | undefined;
    if (socket instanceof ResumableBridge) {
      socket.on("detached", () => {
        if (rendererWindow) realtimeWindows.closeOwner(rendererWindow.webContents.id);
      });
    }
    const messagePorts = new Map<string, WebSocketMessagePort>();
    const disconnectMessagePorts = (): void => {
      for (const port of messagePorts.values()) port.disconnect();
      messagePorts.clear();
    };
    // Each tab is a real registered app view, with its own IPC client and ownership.
    const rendererReady = rendererWindowFactory
      .then(async (createWindow) => {
        if (socket.readyState !== WebSocket.OPEN) return undefined;
        const window =
          token === null
            ? await createWindow()
            : (realtimeWindows.claim(token) as RendererWindow | undefined);
        if (!window) {
          socket.close(1008, "Invalid or expired voice renderer");
          return undefined;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          window.destroy();
          return undefined;
        }
        rendererWindow = window;
        rendererSockets.set(window.webContents.id, socket);
        window.once("closed", () => {
          disconnectMessagePorts();
          rendererSockets.delete(window.webContents.id);
          socket.close(1000, "Renderer closed");
        });
        if (token !== null) {
          window.webContents.emit("did-finish-load");
          window.emit("ready-to-show");
        }
        return window;
      })
      .catch((error) => {
        console.error("[ipc-bridge] failed to create renderer window", error);
        socket.close(1011, "Renderer initialization failed");
        return undefined;
      });

    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      windowId: number,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, windowId);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("close", () => {
      disconnectMessagePorts();
      if (rendererWindow) {
        realtimeWindows.closeOwner(rendererWindow.webContents.id);
        realtimeWindows.close(rendererWindow.webContents.id);
        rendererSockets.delete(rendererWindow.webContents.id);
        rendererWindow.destroy();
      }
    });

    socket.on("message", async (rawData: unknown) => {
      // Transport health is independent of slow app-view initialization.
      try {
        const probe = JSON.parse(String(rawData));
        if (
          probe?.type === "bridge-ping" &&
          Number.isSafeInteger(probe.nonce)
        ) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({ type: "bridge-pong", nonce: probe.nonce }),
            );
          }
          return;
        }
      } catch {
        /* Normal dispatch below reports malformed input. */
      }
      const receivedAtMs = Date.now();
      const window = await rendererReady;
      if (!window || socket.readyState !== WebSocket.OPEN) return;
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "ipc-renderer-send" || message.type === "ipc-renderer-invoke") {
        message.args = rebaseRequestDeadlines(
          message.channel, message.args,
          (message as unknown as { bridgeSentAtMs?: unknown }).bridgeSentAtMs,
          receivedAtMs,
        );
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          window.id,
        );
        return;
      }

      if (message.type === "ipc-renderer-post-message") {
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
          return;
        }

        const ports = message.portIds.map((portId) => {
          const existingPort = messagePorts.get(portId);
          if (existingPort) {
            existingPort.disconnect();
          }
          const port = new WebSocketMessagePort(
            portId,
            (message) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
              }
            },
            () => messagePorts.delete(portId),
          );
          messagePorts.set(portId, port);
          return port;
        });

        dispatchPostMessage(message.channel, message.message, ports, window.id);
        return;
      }

      if (message.type === "message-port-message") {
        messagePorts.get(message.portId)?.receiveMessage(message.data);
        return;
      }

      if (message.type === "message-port-close") {
        messagePorts.get(message.portId)?.disconnect();
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args, window.id) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const recovery = new QuotaRecovery(
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "codex-web-quota-recovery.json",
    ),
  );
  Object.assign(globalThis, { __codexQuotaRecovery: recovery });
  ipcMain.handle("quota-recovery:list", (_event, options) =>
    recovery.list(
      !(options !== null && typeof options === "object" &&
        "refresh" in options && options.refresh === false),
    ),
  );
  ipcMain.handle("quota-recovery:resume", (_event, ids) => recovery.resume(ids));
  ipcMain.handle("quota-recovery:set-auto-resume", (_event, value) =>
    recovery.setAutoResume(value),
  );

  ipcMain.handle("quota-recovery:set-auto-resume-429", (_event, value) =>
    recovery.setAutoResume429(value),
  );

  ipcMain.handle("quota-recovery:set-rate-limit-max-retries", (_event, value) =>
    recovery.setRateLimitMaxRetries(value),
  );

  if (
    packageJson.version === "26.930.41038" &&
    packageJson.main === ".vite/build/early-bootstrap.js"
  ) {
    // This desktop build owns startup in the official bootstrap. Importing
    // main and calling it ourselves races the bootstrap's asynchronous handoff.
    require(path.resolve(__dirname, "../../scratch/asar", packageJson.main));
  } else {
    // The pinned 26.901 main bundle does not import its bootstrap; preserve
    // its existing explicit startup path.
    const module = require(matches[0]!);
    module.runMainAppStartup();
  }
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
