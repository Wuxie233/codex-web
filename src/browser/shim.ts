import { installDotPanel, type DotPanelHooks } from "./dot-panel";
import { cachedStatsigBootstrap } from "./bootstrap-cache";
import { connectVisualizationSandbox } from "./visualization-sandbox";
import { installConnectionHealth } from "./connection-health";
import {
  openBrowserUrl,
  openLocalHtml,
  installBrowserOpener,
  type HtmlPreviewRequest,
} from "./browser-panel";
import { createRemoteBrowserBridge } from "./remote-browser";
import "./mobile-sidebar-actions";
import {
  realtimeToken,
  handleRealtimeWindowMessage,
  closeRealtimeWindows,
  installRealtimeMediaCleanup,
  type RealtimeWindowMessage,
} from "./realtime";
import { installQuotaRecovery } from "./quota-recovery";
import { downloadLocalFile, localDownloadPath } from "./downloads";
import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  uploadFiles,
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
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
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | RealtimeWindowMessage
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

const RECONNECT_DELAY_MS = 1_000;
const disposeRealtimeMedia = realtimeToken
  ? installRealtimeMediaCleanup()
  : null;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  dotPanel?: DotPanelHooks;
  connectVisualizationSandbox?: typeof connectVisualizationSandbox;
  cachedStatsigBootstrap?: typeof cachedStatsigBootstrap;
  createRemoteBrowserWebview?: ReturnType<
    typeof createRemoteBrowserBridge
  >["createWebview"];
  remoteBrowserHost?: ReturnType<
    typeof createRemoteBrowserBridge
  >["browserHost"];
  openLocalHtml?: (request: HtmlPreviewRequest) => boolean;
  preferLightweightVoiceRenderer?: boolean;
  downloadLocalFile?: typeof downloadLocalFile;
  localDownloadPath?: typeof localDownloadPath;
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;
declare const __CODEX_DOT_PANEL_URL__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let needsReload = false;
let resumeToken: string | null = null;
let receivedSequence = 0;
let clientSequence = 0;
let clientAcknowledgedSequence = 0;
let clientDeliverySupported: boolean | null = realtimeToken ? false : null;
const unacknowledgedMessages = new Map<number, string>();
const interruptedRequests = new Set<string>();
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (
    message.type === "realtime-window-open" ||
    message.type === "realtime-window-close"
  ) {
    handleRealtimeWindowMessage(message);
    return;
  }
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (needsReload || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    // Retain initial messages as well: they may leave before bridge-session.
    const sequence = clientDeliverySupported !== false ? ++clientSequence : undefined;
    const payload = JSON.stringify({ ...message, bridgeSentAtMs: Date.now(), bridgeClientSequence: sequence });
    if (sequence !== undefined) unacknowledgedMessages.set(sequence, payload);
    socket.send(payload);
  }
}

function acknowledgeClientMessages(sequence: unknown): boolean {
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) ||
      sequence < clientAcknowledgedSequence || sequence > clientSequence) {
    window.location.reload();
    return false;
  }
  clientAcknowledgedSequence = sequence;
  for (const id of unacknowledgedMessages.keys()) {
    if (id > sequence) break;
    unacknowledgedMessages.delete(id);
  }
  return true;
}

function scheduleReconnect(): void {
  if (realtimeToken) return;
  if (reconnectTimeoutId !== null) {
    return;
  }
  if (document.visibilityState === "hidden" || navigator.onLine === false)
    return;
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
    connectionHealth?.opened();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  // A delayed close event must not bypass port cleanup during foreground recovery.
  if (socket) disconnectSocket(socket);
  const current = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc${realtimeToken ? `?${new URLSearchParams({ realtimeToken })}` : resumeToken ? `?${new URLSearchParams({ resumeToken, after: String(receivedSequence) })}` : needsReload ? "?recoveryProbe=1" : "?resumable=1"}`,
  );
  socket = current;
  current.addEventListener("open", () => {
    if (socket !== current) return;
    // Resume must finish replaying server events before sending new requests.
    if (needsReload && !resumeToken) return;
    connectionHealth?.opened();
    if (needsReload) return;
    flushOutboundQueue();
  });
  current.addEventListener("message", (event) => {
    if (socket !== current) return;
    try {
      let message = JSON.parse(String(event.data));
      if (message.type === "bridge-session") {
        resumeToken = message.token;
        clientDeliverySupported = message.clientSequence !== undefined;
        if (clientDeliverySupported) acknowledgeClientMessages(message.clientSequence);
        else unacknowledgedMessages.clear();
        return;
      }
      if (message.type === "bridge-client-ack") {
        if (clientDeliverySupported) acknowledgeClientMessages(message.sequence);
        return;
      }
      if (message.type === "bridge-resumed") {
        if (clientDeliverySupported) {
          if (!acknowledgeClientMessages(message.clientSequence)) return;
          // Resume confirms the exact receipt boundary. Send only operations
          // absent from this renderer, in their original order and with IDs.
          for (const payload of unacknowledgedMessages.values()) {
            current.send(JSON.stringify({ ...JSON.parse(payload), bridgeSentAtMs: Date.now() }));
          }
        } else {
          // Older servers cannot distinguish lost requests from accepted work.
          const stillRunning = new Set<string>(message.pendingRequests);
          for (const id of interruptedRequests) {
            if (!stillRunning.has(id) &&
                (pendingInvokes.has(id) || pendingDirectoryEntries.has(id))) {
              window.location.reload();
              return;
            }
          }
        }
        interruptedRequests.clear();
        needsReload = false;
        flushOutboundQueue();
        return;
      }
      if (message.type === "bridge-frame") {
        if (message.sequence === receivedSequence + 1) {
          handleIncomingMessage(message.payload);
          receivedSequence = message.sequence;
        } else if (message.sequence > receivedSequence) {
          // A gap cannot be repaired by applying later events out of order.
          window.location.reload();
          return;
        }
        current.send(JSON.stringify({ type: "bridge-ack", sequence: receivedSequence }));
        return;
      }
      if (connectionHealth?.received(message)) return;
      if (
        (message as { type: string }).type === "bridge-recovery-ready" &&
        needsReload
      ) {
        window.location.reload();
        return;
      }
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    disconnectSocket(current);
    scheduleReconnect();
  });
  current.addEventListener("error", () => {
    if (socket !== current) return;
    disconnectSocket(current);
    scheduleReconnect();
  });
}

function disconnectSocket(current: WebSocket): void {
  if (socket !== current) return;
  socket = null;
  connectionHealth?.disconnected();
  closeRealtimeWindows();
  disposeRealtimeMedia?.();
  needsReload = true;
  if (resumeToken && !clientDeliverySupported) {
    const unsent = new Set(outboundQueue.flatMap((message) =>
      "requestId" in message ? [message.requestId] : []));
    for (const id of pendingInvokes.keys()) if (!unsent.has(id)) interruptedRequests.add(id);
    for (const id of pendingDirectoryEntries.keys()) if (!unsent.has(id)) interruptedRequests.add(id);
  }
  if (!resumeToken) {
    const error = new Error("Connection to Codex was lost");
    for (const pending of pendingInvokes.values()) pending.reject(error);
    pendingInvokes.clear();
    for (const pending of pendingDirectoryEntries.values()) pending.reject(error);
    pendingDirectoryEntries.clear();
    outboundQueue.length = 0;
    unacknowledgedMessages.clear();
    for (const port of messagePorts.values()) port.close();
    messagePorts.clear();
  }
  current.close();
}

const connectionHealth = realtimeToken
  ? null
  : installConnectionHealth({
      getSocket: () => socket,
      reconnect: () => {
        if (navigator.onLine === false) return;
        if (reconnectTimeoutId !== null) {
          window.clearTimeout(reconnectTimeoutId);
          reconnectTimeoutId = null;
        }
        ensureSocket();
      },
      invalidate: (current) => {
        disconnectSocket(current);
        scheduleReconnect();
      },
    });

function enqueueMessage(message: RendererToMainMessage): void {
  if (needsReload && !resumeToken) return;
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  if (needsReload && !resumeToken)
    return Promise.reject(
      new Error(
        realtimeToken
          ? "Voice renderer closed"
          : "Connection to Codex was lost",
      ),
    );
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
  useExternalBrowser?: boolean;
  openTargetIntent?: string;
  openTarget?: string;
  disposition?: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  if (needsReload && !resumeToken)
    return Promise.reject(new Error("Connection to Codex was lost"));
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

window.addEventListener("online", flushOutboundQueue);

window.addEventListener("pagehide", (event) => {
  if (!event.persisted && resumeToken && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "bridge-dispose" }));
  }
});

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
if (__CODEX_DOT_PANEL_URL__) {
  try {
    electronShim.dotPanel = installDotPanel({
      url: __CODEX_DOT_PANEL_URL__,
      onOpen: () => {
        if (mobileMediaQuery.matches) electronShim.closeSidebar?.();
      },
    });
  } catch {
    console.error("Dot panel configuration is invalid");
  }
}
electronShim.connectVisualizationSandbox = connectVisualizationSandbox;
electronShim.cachedStatsigBootstrap = cachedStatsigBootstrap;
const remoteBrowser = createRemoteBrowserBridge({
  emitMessage: (message) =>
    emitRendererEvent("codex_desktop:message-for-view", [message]),
});
installBrowserOpener((message) =>
  emitRendererEvent("codex_desktop:message-for-view", [message]),
);
electronShim.createRemoteBrowserWebview = remoteBrowser.createWebview;
electronShim.remoteBrowserHost = remoteBrowser.browserHost;
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) remoteBrowser.dispose();
});
electronShim.preferLightweightVoiceRenderer = true;
electronShim.downloadLocalFile = downloadLocalFile;
electronShim.localDownloadPath = localDownloadPath;
electronShim.openLocalHtml = openLocalHtml;
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = realtimeToken
  ? "/avatar-overlay"
  : initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  electronShim.dotPanel?.onHostNavigation();
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      const handled = remoteBrowser.handleMessage(args[0]);
      if (handled) return handled;
      if (isOpenInBrowserMessage(args[0])) {
        const message = args[0];
        const external =
          message.useExternalBrowser === true ||
          message.openTargetIntent === "external" ||
          message.openTarget === "external-browser" ||
          message.disposition === "new-tab" ||
          message.disposition === "new-background-tab";
        if (external || !openBrowserUrl(message.url))
          window.open(message.url, "_blank", "noopener,noreferrer");
        // The renderer owns web links; do not also dispatch to Electron's host.
        if (/^https?:\/\//i.test(args[0].url)) return Promise.resolve();
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (
        isRecord(args[0]) &&
        args[0].type === "electron-pick-workspace-root-option"
      ) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (root) {
            emitRendererEvent("codex_desktop:message-for-view", [
              {
                type: "workspace-root-option-picked",
                root,
              },
            ]);
          }
        });
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      const handled = remoteBrowser.handleMessage(args[0]);
      if (handled) {
        void handled.catch((error) =>
          console.error("Browser command failed", error),
        );
        return;
      }
    }
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();
connectionHealth?.opened();
installQuotaRecovery((channel, ...args) => ipcRenderer.invoke(channel, ...args));

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    if (_key === "electronBridge" && isRecord(_api)) {
      // No native window exists for Menu.popup on the web host. Omitting this
      // capability lets Desktop render its existing accessible browser menus.
      const browserApi = { ..._api };
      delete browserApi.showContextMenu;
      browserApi.uploadBrowserFiles = uploadFiles;
      Reflect.set(window, _key, browserApi);
      return;
    }
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    // Browser File objects do not carry a server-side filesystem path.
    return null;
  },
};

// The Desktop shell uses inline 100vh, which can extend behind browser chrome
// or the keyboard. Keep its existing CSS zoom, but size it to the visible area.
const browserViewportStyle = document.createElement("style");
browserViewportStyle.textContent = `
#root > .relative.flex.flex-col {
  height: calc(var(--codex-web-visible-height, 100dvh) / var(--codex-window-zoom, 1)) !important;
}
`;
document.head.appendChild(browserViewportStyle);
const updateBrowserViewport = () => {
  const viewport = window.visualViewport;
  // Pinch zoom should magnify/pan the page, not reflow the entire application.
  if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
  const height = viewport?.height ?? window.innerHeight;
  if (Number.isFinite(height) && height > 0) {
    document.documentElement.style.setProperty("--codex-web-visible-height", `${height}px`);
    requestAnimationFrame(() => {
      const editor = document.activeElement;
      if (!(editor instanceof HTMLElement) || !editor.isContentEditable) return;
      const composer = editor.closest<HTMLElement>('[class*="_ComposerLayoutRoot_"]') ?? editor;
      if (composer.getBoundingClientRect().bottom > height) {
        composer.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }
};
updateBrowserViewport();
window.visualViewport?.addEventListener("resize", updateBrowserViewport);
window.addEventListener("resize", updateBrowserViewport);
window.addEventListener("pageshow", updateBrowserViewport);

// Mobile navigation overlays the conversation instead of consuming its width.
const mobileNavigationStyle = document.createElement("style");
mobileNavigationStyle.textContent = `
.codex-web-close-sidebar { display: none; }
@media (max-width: 768px) {
  .app-shell-left-panel { position: absolute !important; inset-block: 0; inset-inline-start: 0; z-index: 40; background: #fff !important; }
  html.electron-dark .app-shell-left-panel { background: #181818 !important; }
  body:not(:has([data-app-shell-sidebar-trigger][aria-expanded="true"])) .app-shell-left-panel,
  body:not(:has([data-app-shell-sidebar-trigger][aria-expanded="true"])) .app-shell-left-panel * {
    visibility: hidden !important; pointer-events: none !important;
  }
  body:has([data-app-shell-sidebar-trigger][aria-expanded="true"]) .codex-web-close-sidebar {
    display: grid; place-items: center; position: fixed; top: 8px; right: 8px;
    width: 44px; height: 44px; z-index: 100; border: 1px solid #888;
    border-radius: 12px; background: #fff; color: #181818; font: 28px/1 sans-serif;
    cursor: pointer; touch-action: manipulation;
  }
  html.electron-dark .codex-web-close-sidebar { background: #242424 !important; color: #fff !important; }

  body:has([data-app-shell-sidebar-trigger][aria-expanded="true"]) .app-shell-left-panel::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 100%; width: 100vw;
    background: rgba(0,0,0,.35); pointer-events: auto;
  }
}
`;
document.head.appendChild(mobileNavigationStyle);
const sidebarCloseButton = document.createElement("button");
sidebarCloseButton.type = "button";
sidebarCloseButton.className = "codex-web-close-sidebar";
sidebarCloseButton.textContent = "×";
sidebarCloseButton.setAttribute("aria-label", navigator.language.startsWith("zh") ? "关闭侧边栏" : "Close sidebar");
sidebarCloseButton.addEventListener("click", () => {
  electronShim.closeSidebar?.();
  document.querySelector<HTMLElement>("[data-app-shell-sidebar-trigger]")?.focus();
});
const mountSidebarCloseButton = () => document.body.appendChild(sidebarCloseButton);
if (document.body) mountSidebarCloseButton();
else document.addEventListener("DOMContentLoaded", mountSidebarCloseButton, { once: true });

document.addEventListener("click", (event) => {
  if (!mobileMediaQuery.matches || !(event.target instanceof Element)) return;
  const panel = event.target.closest(".app-shell-left-panel");
  if (panel && event.clientX > panel.getBoundingClientRect().right) {
    event.preventDefault();
    event.stopPropagation();
    electronShim.closeSidebar?.();
  }
}, true);
document.addEventListener("keydown", (event) => {
  if (mobileMediaQuery.matches && event.key === "Escape") electronShim.closeSidebar?.();
});
mobileMediaQuery.addEventListener("change", (event) => {
  if (event.matches) electronShim.closeSidebar?.();
});
