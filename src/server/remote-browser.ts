import { chromium } from "playwright-core";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";
import { RemoteBrowserNetwork } from "./remote-browser-network.js";

export interface RemoteBrowserTarget {
  conversationId: string;
  browserTabId: string;
}

export interface RemoteBrowserState extends RemoteBrowserTarget {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  height: number;
  closed: boolean;
  error?: string;
}

export const REMOTE_BROWSER_ACTIONS = [
  "open",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "state",
  "resize",
  "mouse",
  "scroll",
  "key",
  "text",
  "inspect",
  "screenshot",
  "close",
  "transfer",
] as const;

export interface RemoteBrowserCommand extends RemoteBrowserTarget {
  action: (typeof REMOTE_BROWSER_ACTIONS)[number];
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  eventType?: "move" | "down" | "up" | "click" | "press";
  deltaX?: number;
  deltaY?: number;
  key?: string;
  text?: string;
  targetConversationId?: string;
  targetBrowserTabId?: string;
}

export type RemoteBrowserEvent =
  | { type: "state"; state: RemoteBrowserState }
  | {
      type: "frame";
      data: string;
      mimeType: "image/jpeg";
      width: number;
      height: number;
      sequence: number;
    }
  | { type: "error"; message: string }
  | { type: "closed" };

export interface RemoteBrowserResult {
  state: RemoteBrowserState;
  value?: unknown;
}

export interface RemoteBrowserOptions {
  executablePath?: string;
  maxContexts?: number;
  maxTabsPerContext?: number;
  maxTabs?: number;
  idleTimeoutMs?: number;
  evaluateTimeoutMs?: number;
}

type Listener = (event: RemoteBrowserEvent) => void;
interface Tab {
  page: Page;
  cdp: CDPSession;
  state: RemoteBrowserState;
  listeners: Set<Listener>;
  tail: Promise<unknown>;
  streamTail: Promise<void>;
  streaming: boolean;
  sequence: number;
  lastUsed: number;
  activeCommands: number;
  lastFrame?: Extract<RemoteBrowserEvent, { type: "frame" }>;
  pressedKeys: Set<string>;
  pressedButtons: Set<"left" | "middle" | "right">;
  transferredFrom?: RemoteBrowserTarget;
}
interface Session {
  ownerId: string;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  pendingTabs: Map<string, Promise<Tab>>;
  lastUsed: number;
}

function identifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new Error(`Invalid ${name}`);
  }
}

function number(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be a number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength)
    throw new Error(`Invalid ${name}`);
  return value;
}

/** A process-owned browser. Page JavaScript never receives its control channel. */
export class RemoteBrowser {
  private readonly sessions = new Map<string, Session>();
  // Only unfinished draft tabs retain an old route into the transferred context.
  private readonly draftAliases = new Map<string, Session>();
  private readonly pendingSessions = new Map<string, Promise<Session>>();
  private readonly appOrigins = new Set<string>();
  private readonly appAuthorities = new Set<string>();
  private readonly appPorts = new Set<string>();
  private readonly network = new RemoteBrowserNetwork((url) =>
    this.isAppUrl(url),
  );
  private browserPromise: Promise<Browser> | undefined;
  private disposed = false;
  private sweeping = false;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly options: Required<RemoteBrowserOptions>;

  constructor(options: RemoteBrowserOptions = {}) {
    this.options = {
      executablePath:
        options.executablePath ??
        process.env.CODEX_WEB_BROWSER_EXECUTABLE ??
        "/usr/bin/google-chrome",
      maxContexts: options.maxContexts ?? 8,
      maxTabsPerContext: options.maxTabsPerContext ?? 8,
      maxTabs: options.maxTabs ?? 24,
      idleTimeoutMs: options.idleTimeoutMs ?? 30 * 60 * 1000,
      evaluateTimeoutMs: options.evaluateTimeoutMs ?? 20_000,
    };
    this.cleanupTimer = setInterval(
      () => {
        void this.sweepIdle();
      },
      Math.min(this.options.idleTimeoutMs, 60_000),
    );
    this.cleanupTimer.unref();
  }

  /** Register both the public app origin and any local listener aliases. */
  setAppOrigin(origin: string): void {
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol))
      throw new Error("App origin must use HTTP or HTTPS");
    this.appOrigins.add(url.origin);
    this.appAuthorities.add(
      `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`,
    );
    // Protect local listener aliases and DNS rebinding to the application port.
    // Public HTTPS/HTTP default ports remain available for normal browsing.
    if (url.port && !["80", "443"].includes(url.port))
      this.appPorts.add(url.port);
  }

  private isAppUrl(input: string): boolean {
    try {
      const url = new URL(input);
      if (url.protocol === "ws:") url.protocol = "http:";
      if (url.protocol === "wss:") url.protocol = "https:";
      const authority = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
      return (
        this.appOrigins.has(url.origin) ||
        this.appAuthorities.has(authority) ||
        this.appPorts.has(url.port)
      );
    } catch {
      return false;
    }
  }

  private navigationUrl(input: unknown): string {
    const raw = text(input, "url", 16_384);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("An absolute browser URL is required");
    }
    if (
      !["http:", "https:", "file:"].includes(url.protocol) &&
      url.href !== "about:blank"
    ) {
      throw new Error(
        "Only HTTP, HTTPS, local files, and about:blank can be opened",
      );
    }
    if (url.username || url.password)
      throw new Error("Credentials in browser URLs are not supported");
    if (this.isAppUrl(url.href))
      throw new Error(
        "The Codex control application cannot be opened inside its browser",
      );
    return url.href;
  }

  private async browser(): Promise<Browser> {
    if (this.disposed) throw new Error("Browser runtime is closed");
    if (!this.browserPromise) {
      const launch = this.network.start().then((server) =>
        chromium.launch({
          executablePath: this.options.executablePath,
          headless: true,
          proxy: { server, bypass: "<-loopback>" },
          args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
        }),
      );
      this.browserPromise = launch;
      try {
        const browser = await launch;
        browser.on("disconnected", () => {
          if (this.browserPromise !== launch) return;
          this.browserPromise = undefined;
          for (const session of this.sessions.values()) {
            for (const tab of session.tabs.values()) this.markClosed(tab);
          }
          this.sessions.clear();
          this.draftAliases.clear();
        });
      } catch (error) {
        if (this.browserPromise === launch) this.browserPromise = undefined;
        throw new Error(
          `Unable to launch Chromium: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const browser = await this.browserPromise;
    if (!browser || this.disposed) throw new Error("Browser runtime is closed");
    return browser;
  }

  private async session(conversationId: string): Promise<Session> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const pending = this.pendingSessions.get(conversationId);
    if (pending) return pending;
    if (
      this.sessions.size + this.pendingSessions.size >=
      this.options.maxContexts
    ) {
      throw new Error(
        "Browser session limit reached; close unused browser tabs first",
      );
    }
    const creation = (async () => {
      const browser = await this.browser();
      if (this.disposed) throw new Error("Browser runtime is closed");
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        serviceWorkers: "block",
        extraHTTPHeaders: { "X-Codex-Remote-Browser": "1" },
      });
      try {
        // The network proxy also checks redirects and TLS/WS connections.
        // Playwright route alone only intercepts the first hop of a redirect.
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (this.isAppUrl(request.url()))
            return route.abort("blockedbyclient");
          if (request.isNavigationRequest()) {
            let popup = false;
            try {
              const frame = request.frame();
              popup = frame === frame.page().mainFrame() && !!(await frame.page().opener());
            } catch {
              // Chromium requests a new popup's first document before creating
              // its frame. Hold that URL for the visible tab without visiting it.
              popup = true;
            }
            if (popup) {
              // Replaying a form submission as GET would change its meaning.
              if (request.method() !== "GET") return route.abort("blockedbyclient");
              return route.fulfill({
                status: 200,
                contentType: "text/html",
                headers: { "cache-control": "no-store" },
                body: "<!doctype html>",
              });
            }
          }
          return route.continue({
            headers: { ...request.headers(), "x-codex-remote-browser": "1" },
          });
        });
        await context.routeWebSocket(/.*/, (socket) => {
          if (this.isAppUrl(socket.url()))
            void socket.close({
              code: 1008,
              reason: "Application control endpoints are unavailable",
            });
          else socket.connectToServer();
        });
        if (this.disposed) throw new Error("Browser runtime is closed");
        const session: Session = {
          ownerId: conversationId,
          context,
          tabs: new Map(),
          pendingTabs: new Map(),
          lastUsed: Date.now(),
        };
        this.sessions.set(conversationId, session);
        return session;
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    })();
    this.pendingSessions.set(conversationId, creation);
    try {
      return await creation;
    } finally {
      this.pendingSessions.delete(conversationId);
    }
  }

  private getTab(target: RemoteBrowserTarget): Tab {
    const tab = this.findSession(target.conversationId)
      ?.tabs.get(target.browserTabId);
    if (!tab || tab.state.closed || tab.state.conversationId !== target.conversationId)
      throw new Error("Browser tab is not open");
    return tab;
  }

  private findSession(conversationId: string): Session | undefined {
    return this.sessions.get(conversationId) ?? this.draftAliases.get(conversationId);
  }

  private async openTab(target: RemoteBrowserTarget): Promise<Tab> {
    const aliased = this.draftAliases.get(target.conversationId);
    if (aliased) {
      const tab = aliased.tabs.get(target.browserTabId);
      if (tab && !tab.state.closed && tab.state.conversationId === target.conversationId)
        return tab;
      throw new Error("The draft browser session has moved to its task");
    }
    const session = await this.session(target.conversationId);
    const existing = session.tabs.get(target.browserTabId);
    if (existing && !existing.state.closed) {
      if (existing.state.conversationId !== target.conversationId)
        throw new Error("Browser tab ID is reserved by an unfinished draft transfer");
      return existing;
    }
    // The context may have moved while session() yielded to a queued transfer.
    if (session.ownerId !== target.conversationId)
      throw new Error("The draft browser session has moved to its task");
    const pending = session.pendingTabs.get(target.browserTabId);
    if (pending) return pending;
    const tabCount = [...this.sessions.values()].reduce(
      (sum, item) => sum + item.tabs.size + item.pendingTabs.size,
      0,
    );
    if (
      session.tabs.size + session.pendingTabs.size >=
        this.options.maxTabsPerContext ||
      tabCount >= this.options.maxTabs
    ) {
      throw new Error("Browser tab limit reached; close an unused tab first");
    }
    const creation = (async () => {
      const page = await session.context.newPage();
      try {
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(20_000);
        const cdp = await session.context.newCDPSession(page);
        await cdp.send("Page.enable");
        const tab: Tab = {
          page,
          cdp,
          listeners: new Set(),
          tail: Promise.resolve(),
          streamTail: Promise.resolve(),
          streaming: false,
          sequence: 0,
          lastUsed: Date.now(),
          activeCommands: 0,
          pressedKeys: new Set(),
          pressedButtons: new Set(),
          state: {
            ...target,
            url: page.url(),
            title: "",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            width: 1280,
            height: 800,
            closed: false,
          },
        };
        session.tabs.set(target.browserTabId, tab);
        page.on("close", () => {
          this.markClosed(tab);
          if (session.tabs.get(tab.state.browserTabId) === tab)
            session.tabs.delete(tab.state.browserTabId);
        });
        page.on("crash", () =>
          this.fail(tab, "Browser page crashed; close and reopen this tab"),
        );
        page.on("request", (request) => {
          if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame()
          ) {
            tab.state.loading = true;
            delete tab.state.error;
            this.emit(tab, { type: "state", state: { ...tab.state } });
          }
        });
        page.on("requestfailed", (request) => {
          if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame()
          ) {
            tab.state.loading = false;
            this.fail(
              tab,
              request.failure()?.errorText ?? "Browser navigation failed",
            );
          }
        });
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame())
            void this.refresh(tab).catch(() => {});
        });
        const loaded = () => {
          tab.state.loading = false;
          void this.refresh(tab).catch(() => {});
        };
        page.on("domcontentloaded", loaded);
        page.on("load", loaded);
        page.on("dialog", (dialog) => {
          void dialog.dismiss().catch(() => {});
          this.emit(tab, {
            type: "error",
            message: `Page dialog dismissed: ${dialog.message().slice(0, 500)}`,
          });
        });
        page.on("download", (download) => {
          void download.cancel().catch(() => {});
          this.emit(tab, {
            type: "error",
            message: "Downloads are not available in the embedded browser yet",
          });
        });
        page.on("filechooser", () => {
          this.emit(tab, {
            type: "error",
            message:
              "File uploads are not available in the embedded browser yet",
          });
        });
        page.on("popup", (popup) => {
          // The context route holds popup requests before they reach the server.
          // Ordinary target=_blank links therefore load once, in the visible tab.
          void (async () => {
            try {
              await popup.waitForURL((url) => url.href !== "about:blank", {
                timeout: 5_000,
              });
              const url = this.navigationUrl(popup.url());
              await this.enqueue(tab, () => this.navigate(tab, url));
            } catch (error) {
              this.fail(tab, error);
            } finally {
              await popup.close().catch(() => {});
            }
          })();
        });
        cdp.on("Page.screencastFrame", (frame) => {
          void cdp
            .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
            .catch(() => {});
          if (!tab.listeners.size || tab.state.closed) return;
          tab.lastFrame = {
            type: "frame",
            data: frame.data,
            mimeType: "image/jpeg",
            width: tab.state.width,
            height: tab.state.height,
            sequence: ++tab.sequence,
          };
          this.emit(tab, tab.lastFrame);
        });
        await this.refresh(tab);
        return tab;
      } catch (error) {
        await page.close().catch(() => {});
        throw error;
      }
    })();
    session.pendingTabs.set(target.browserTabId, creation);
    try {
      return await creation;
    } finally {
      session.pendingTabs.delete(target.browserTabId);
    }
  }

  private emit(tab: Tab, event: RemoteBrowserEvent): void {
    for (const listener of tab.listeners) {
      try {
        listener(event);
      } catch {
        /* One disconnected view cannot affect another. */
      }
    }
  }

  private fail(tab: Tab, error: unknown): void {
    if (tab.state.closed) return;
    tab.state.error = error instanceof Error ? error.message : String(error);
    this.emit(tab, { type: "error", message: tab.state.error });
    this.emit(tab, { type: "state", state: { ...tab.state } });
  }

  private markClosed(tab: Tab): void {
    if (tab.state.closed) return;
    tab.state.closed = true;
    tab.state.loading = false;
    tab.streaming = false;
    this.emit(tab, { type: "closed" });
    tab.listeners.clear();
  }

  private touch(tab: Tab): void {
    tab.lastUsed = Date.now();
    const session = this.findSession(tab.state.conversationId);
    if (session) session.lastUsed = tab.lastUsed;
  }

  private enqueue<T>(
    tab: Tab,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.touch(tab);
    tab.activeCommands++;
    const result = tab.tail
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        if (tab.state.closed || this.disposed)
          throw new Error("Browser tab is closed");
        return operation();
      });
    tab.tail = result;
    return result.finally(() => {
      tab.activeCommands--;
      this.touch(tab);
    });
  }

  private async refresh(tab: Tab): Promise<RemoteBrowserState> {
    if (!tab.state.closed) {
      const [title, history] = await Promise.all([
        // Input can start a navigation before its resulting document is ready.
        // Keep the last title until the next document event updates it.
        this.withReadTimeout(tab.page.title()).catch(() => tab.state.title),
        tab.cdp.send("Page.getNavigationHistory"),
      ]);
      if (!tab.state.closed) {
        tab.state.url = tab.page.url();
        tab.state.title = title;
        tab.state.canGoBack = history.currentIndex > 0;
        tab.state.canGoForward =
          history.currentIndex < history.entries.length - 1;
      }
    }
    const state = { ...tab.state };
    this.emit(tab, { type: "state", state });
    return state;
  }

  private async navigate(tab: Tab, url: string): Promise<void> {
    tab.state.loading = true;
    this.emit(tab, { type: "state", state: { ...tab.state } });
    try {
      await tab.page.goto(url, { waitUntil: "domcontentloaded" });
    } finally {
      tab.state.loading = false;
    }
  }

  /** UI allowlist only. Arbitrary evaluation intentionally has no command action. */
  async command(
    input: RemoteBrowserCommand,
    signal?: AbortSignal,
  ): Promise<RemoteBrowserResult> {
    signal?.throwIfAborted();
    if (!input || typeof input !== "object")
      throw new Error("A browser command is required");
    identifier(input.conversationId, "conversationId");
    identifier(input.browserTabId, "browserTabId");
    if (!REMOTE_BROWSER_ACTIONS.includes(input.action))
      throw new Error("Unsupported browser command");
    if (input.action === "transfer") return this.transfer(input, signal);
    // Validate navigation before allocating a process or creating a tab.
    const url =
      input.action === "navigate" ||
      (input.action === "open" && input.url !== undefined)
        ? this.navigationUrl(input.url)
        : undefined;
    const target = {
      conversationId: input.conversationId,
      browserTabId: input.browserTabId,
    };
    const tab =
      input.action === "open"
        ? await this.openTab(target)
        : this.getTab(target);
    signal?.throwIfAborted();
    const execute = async (): Promise<RemoteBrowserResult> => {
      let value: unknown;
      if (!["state", "inspect", "screenshot"].includes(input.action))
        delete tab.state.error;
      try {
        switch (input.action) {
          case "open":
            if (input.width !== undefined || input.height !== undefined)
              await this.resize(tab, input);
            if (url && tab.page.url() !== url) await this.navigate(tab, url);
            break;
          case "navigate":
            await this.navigate(tab, url!);
            break;
          case "back":
            await tab.page.goBack({ waitUntil: "domcontentloaded" });
            break;
          case "forward":
            await tab.page.goForward({ waitUntil: "domcontentloaded" });
            break;
          case "reload":
            await tab.page.reload({ waitUntil: "domcontentloaded" });
            break;
          case "stop":
            await tab.cdp.send("Page.stopLoading");
            tab.state.loading = false;
            break;
          case "resize":
            await this.resize(tab, input);
            break;
          case "mouse": {
            const x = number(input.x, "x", 0, tab.state.width);
            const y = number(input.y, "y", 0, tab.state.height);
            const button = input.button ?? "left";
            if (!["left", "middle", "right"].includes(button))
              throw new Error("Invalid mouse button");
            if (
              !["move", "down", "up", "click"].includes(input.eventType ?? "")
            )
              throw new Error("Invalid mouse eventType");
            await tab.page.mouse.move(x, y);
            if (input.eventType === "down") {
              await tab.page.mouse.down({ button });
              tab.pressedButtons.add(button);
            }
            if (input.eventType === "up") {
              await tab.page.mouse.up({ button });
              tab.pressedButtons.delete(button);
            }
            if (input.eventType === "click")
              await tab.page.mouse.click(x, y, { button });
            break;
          }
          case "scroll":
            await tab.page.mouse.wheel(
              number(input.deltaX, "deltaX", -10_000, 10_000),
              number(input.deltaY, "deltaY", -10_000, 10_000),
            );
            break;
          case "key": {
            const key = text(input.key, "key", 100);
            if (!key) throw new Error("A key is required");
            if (input.eventType === "down") {
              await tab.page.keyboard.down(key);
              tab.pressedKeys.add(key);
            } else if (input.eventType === "up") {
              await tab.page.keyboard.up(key);
              tab.pressedKeys.delete(key);
            } else if (
              input.eventType === "press" ||
              input.eventType === undefined
            )
              await tab.page.keyboard.press(key);
            else throw new Error("Invalid keyboard eventType");
            break;
          }
          case "text":
            await tab.page.keyboard.insertText(
              text(input.text, "text", 100_000),
            );
            break;
          case "inspect":
            value = await this.inspect(
              tab,
              number(input.x, "x", 0, tab.state.width),
              number(input.y, "y", 0, tab.state.height),
            );
            break;
          case "screenshot":
            value = {
              mimeType: "image/png",
              data: (
                await tab.page.screenshot({ type: "png", timeout: 10_000 })
              ).toString("base64"),
            };
            break;
          case "close":
            await this.closeTab(tab);
            break;
          case "state":
            break;
        }
        return {
          state: await this.refresh(tab),
          ...(value === undefined ? {} : { value }),
        };
      } catch (error) {
        tab.state.loading = false;
        this.fail(tab, error);
        throw error;
      }
    };
    // Closing also needs to interrupt a hung renderer or evaluation.
    if (input.action === "stop" || input.action === "close") {
      this.touch(tab);
      return execute();
    }
    return this.enqueue(tab, execute, signal);
  }

  private async transfer(
    input: RemoteBrowserCommand,
    signal?: AbortSignal,
  ): Promise<RemoteBrowserResult> {
    identifier(input.targetConversationId, "targetConversationId");
    identifier(input.targetBrowserTabId, "targetBrowserTabId");
    if (!input.conversationId.startsWith("client-new-thread:") ||
        input.targetConversationId.startsWith("client-new-thread:"))
      throw new Error("Only a draft browser can move to its created task");
    const target = {
      conversationId: input.targetConversationId,
      browserTabId: input.targetBrowserTabId,
    };
    const source = { conversationId: input.conversationId, browserTabId: input.browserTabId };
    const session = this.findSession(source.conversationId);
    const previous = this.findSession(target.conversationId)?.tabs.get(target.browserTabId);
    if (previous && !previous.state.closed && previous.state.conversationId === target.conversationId &&
        previous.transferredFrom?.conversationId === source.conversationId &&
        previous.transferredFrom.browserTabId === source.browserTabId)
      return { state: { ...previous.state } };
    const tab = this.getTab(source);
    return this.enqueue(tab, async () => {
      if (tab.state.conversationId !== source.conversationId || tab.state.browserTabId !== source.browserTabId) {
        if (tab.state.conversationId === target.conversationId && tab.state.browserTabId === target.browserTabId)
          return { state: { ...tab.state } };
        throw new Error("The draft browser tab has already moved");
      }
      if (!session || this.findSession(source.conversationId) !== session)
        throw new Error("The draft browser session is no longer available");
      const destination = this.sessions.get(target.conversationId);
      if ((destination && destination !== session) || this.pendingSessions.has(target.conversationId))
        throw new Error("The target task already has a separate browser session");
      if (session.ownerId !== source.conversationId && session.ownerId !== target.conversationId)
        throw new Error("The draft browser belongs to a different task");
      const conflict = session.tabs.get(target.browserTabId);
      if ((conflict && conflict !== tab) || session.pendingTabs.has(target.browserTabId))
        throw new Error("The target browser tab is already open");
      if (session.ownerId === source.conversationId) {
        this.sessions.delete(source.conversationId);
        session.ownerId = target.conversationId;
        this.sessions.set(target.conversationId, session);
        this.draftAliases.set(source.conversationId, session);
      }
      session.tabs.delete(source.browserTabId);
      tab.transferredFrom = source;
      tab.state.conversationId = target.conversationId;
      tab.state.browserTabId = target.browserTabId;
      session.tabs.set(target.browserTabId, tab);
      this.touch(tab);
      const state = { ...tab.state };
      this.emit(tab, { type: "state", state });
      return { state };
    }, signal);
  }

  private async resize(
    tab: Tab,
    input: Pick<RemoteBrowserCommand, "width" | "height">,
  ): Promise<void> {
    const width = Math.round(
      number(input.width ?? tab.state.width, "width", 240, 2560),
    );
    const height = Math.round(
      number(input.height ?? tab.state.height, "height", 160, 1600),
    );
    await tab.page.setViewportSize({ width, height });
    tab.state.width = width;
    tab.state.height = height;
  }

  private async inspect(tab: Tab, x: number, y: number): Promise<unknown> {
    return this.withReadTimeout(tab.page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const path: string[] = [];
        let current: Element | null = element;
        for (
          let depth = 0;
          current && depth < 6;
          depth++, current = current.parentElement
        ) {
          if (current.id) {
            path.unshift(`#${CSS.escape(current.id)}`);
            break;
          }
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter(
                (item) => item.tagName === current!.tagName,
              )
            : [];
          if (siblings.length > 1)
            part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          path.unshift(part);
        }
        return {
          tagName: element.tagName.toLowerCase(),
          selector: path.join(" > "),
          text: (element.textContent ?? "").trim().slice(0, 2000),
          role: element.getAttribute("role"),
          label: element.getAttribute("aria-label"),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          url: location.href,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      },
      { x, y },
    ));
  }

  private async withReadTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Browser page read timed out")),
            this.options.evaluateTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Trusted server/agent API only; never dispatch untrusted UI strings here. */
  async evaluate(
    target: RemoteBrowserTarget,
    expression: string,
    signal?: AbortSignal,
  ): Promise<RemoteBrowserResult> {
    signal?.throwIfAborted();
    identifier(target.conversationId, "conversationId");
    identifier(target.browserTabId, "browserTabId");
    text(expression, "expression", 100_000);
    const tab = this.getTab(target);
    return this.enqueue(
      tab,
      async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([
            tab.page.evaluate(expression),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Browser evaluation timed out; the outcome is unknown and was not retried",
                    ),
                  ),
                this.options.evaluateTimeoutMs,
              );
            }),
          ]);
          return { state: await this.refresh(tab), value };
        } catch (error) {
          this.fail(tab, error);
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      },
      signal,
    );
  }

  list(conversationId: string): RemoteBrowserState[] {
    identifier(conversationId, "conversationId");
    return [...(this.findSession(conversationId)?.tabs.values() ?? [])]
      .filter((tab) => !tab.state.closed && tab.state.conversationId === conversationId)
      .map((tab) => ({ ...tab.state }));
  }

  subscribe(
    conversationId: string,
    browserTabId: string,
    listener: Listener,
  ): () => void {
    const tab = this.getTab({ conversationId, browserTabId });
    tab.listeners.add(listener);
    this.touch(tab);
    listener({ type: "state", state: { ...tab.state } });
    if (tab.lastFrame) listener(tab.lastFrame);
    this.updateStreaming(tab);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      tab.listeners.delete(listener);
      this.touch(tab);
      this.updateStreaming(tab);
    };
  }

  private updateStreaming(tab: Tab): void {
    tab.streamTail = tab.streamTail
      .catch(() => {})
      .then(async () => {
        if (tab.state.closed) return;
        const needed = tab.listeners.size > 0;
        if (needed === tab.streaming) return;
        if (needed) {
          await tab.page.bringToFront();
          await tab.cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: 75,
            everyNthFrame: 1,
          });
        } else {
          await tab.cdp.send("Page.stopScreencast");
          // Release after accepted inputs, including those still in the queue.
          await this.enqueue(tab, async () => {
            for (const button of tab.pressedButtons)
              await tab.page.mouse.up({ button }).catch(() => {});
            for (const key of tab.pressedKeys)
              await tab.page.keyboard.up(key).catch(() => {});
            tab.pressedButtons.clear();
            tab.pressedKeys.clear();
          });
        }
        tab.streaming = needed;
      })
      .catch((error) => this.fail(tab, error));
  }

  private async closeTab(tab: Tab): Promise<void> {
    this.markClosed(tab);
    const session = this.findSession(tab.state.conversationId);
    session?.tabs.delete(tab.state.browserTabId);
    await tab.page.close();
    if (session && !session.tabs.size && !session.pendingTabs.size) {
      this.removeSession(session);
      await session.context.close();
    }
  }

  private removeSession(session: Session): void {
    if (this.sessions.get(session.ownerId) === session)
      this.sessions.delete(session.ownerId);
    for (const [draftId, candidate] of this.draftAliases)
      if (candidate === session) this.draftAliases.delete(draftId);
  }

  private async sweepIdle(): Promise<void> {
    if (this.disposed || this.sweeping) return;
    this.sweeping = true;
    try {
      const cutoff = Date.now() - this.options.idleTimeoutMs;
      for (const session of this.sessions.values()) {
        for (const tab of session.tabs.values()) {
          if (
            !tab.listeners.size &&
            !tab.activeCommands &&
            tab.lastUsed < cutoff
          )
            await this.closeTab(tab).catch(() => {});
        }
        if (
          !session.tabs.size &&
          !session.pendingTabs.size &&
          session.lastUsed < cutoff
        ) {
          this.removeSession(session);
          await session.context.close().catch(() => {});
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values())
      for (const tab of session.tabs.values()) this.markClosed(tab);
    const browser = await this.browserPromise?.catch(() => undefined);
    try {
      await browser?.close();
    } finally {
      await Promise.allSettled([...this.pendingSessions.values()]);
      this.sessions.clear();
      this.draftAliases.clear();
      this.pendingSessions.clear();
      this.browserPromise = undefined;
      await this.network.dispose();
    }
  }
}
