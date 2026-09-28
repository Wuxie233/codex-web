export type BrowserRoute = { conversationId: string; browserTabId: string };

export type RemoteBrowserState = BrowserRoute & {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  height: number;
  closed: boolean;
  error?: string;
};

type Message = Record<string, unknown>;
type Frame = {
  type: "frame";
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sequence: number;
};
type Selection = {
  x: number;
  y: number;
  width: number;
  height: number;
  value: unknown;
};
type Options = {
  emitMessage: (message: Message) => void;
  onInspect?: (selection: BrowserRoute & Selection) => void;
  request?: typeof fetch;
};
type Page = {
  route: BrowserRoute;
  state?: RemoteBrowserState;
  opening?: Promise<void>;
  migration?: { target: BrowserRoute; promise: Promise<void> };
  queue: Promise<unknown>;
  socket?: WebSocket;
  reconnect?: ReturnType<typeof setTimeout>;
  disposed: boolean;
  mode: "browse" | "comment";
  comments: Message[];
  annotationGeneration: number;
  views: Set<View>;
};
type View = {
  element: HTMLElement & { destroy(): void };
  render(frame: Frame): void;
  update(): void;
  error(message: string): void;
  cancelAnnotation(): void;
};

class BrowserResponseError extends Error {}

function record(value: unknown): value is Message {
  return value !== null && typeof value === "object";
}
function routeOf(value: unknown): BrowserRoute | null {
  if (
    !record(value) ||
    typeof value.conversationId !== "string" ||
    typeof value.browserTabId !== "string"
  )
    return null;
  return {
    conversationId: value.conversationId,
    browserTabId: value.browserTabId,
  };
}

/** Keep Desktop's tab, toolbar and layout state; only the guest page is remote. */
export function toNativeBrowserSnapshot(
  state: RemoteBrowserState,
  mode: "browse" | "comment" = "browse",
  comments: Message[] = [],
): Message {
  const blank = !state.url || state.url === "about:blank";
  return {
    annotationFlow: "batch",
    annotationModeEntrySource: null,
    tabType: blank ? "new-tab-page" : "web",
    isSuspended: false,
    title: state.title || (blank ? "New tab" : state.url),
    url: blank ? "" : state.url,
    committedUrl: blank ? "" : state.url,
    faviconUrl: null,
    securityState: null,
    isAudible: false,
    isAudioMuted: false,
    isCapturingUserMedia: false,
    isCapturingCamera: false,
    isCapturingMicrophone: false,
    isLoading: state.loading,
    isWaitingForResponse: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    zoomPercent: 100,
    commentModeDisabledReason: null,
    interactionMode: mode,
    comments,
    annotationEditorMode: "comment",
    isAnnotationAddModifierPressed: false,
    isDesignModifierPressed: false,
    isOriginalViewEnabled: false,
    isTweaksEditorOpen: false,
    webMcpToolsAvailability: "unavailable",
    webMcpToolsRevision: 0,
    lastWebMcpToolCall: null,
  };
}

/** Native comments become composer attachments; this never submits a turn. */
export function toNativeBrowserComment(
  state: RemoteBrowserState,
  selection: Selection,
  body: string,
  screenshot: { data: string; mimeType: string },
  themeVariant: "dark" | "light",
): Message {
  const inspected = record(selection.value) ? selection.value : {};
  const rect = {
    x: selection.x,
    y: selection.y,
    width: Math.max(1, selection.width),
    height: Math.max(1, selection.height),
  };
  const scrollY = typeof inspected.scrollY === "number" ? inspected.scrollY : 0;
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    body,
    color: "blue",
    pageInitialComment: false,
    attachedImages: [],
    themeVariant,
    viewportSize: { width: state.width, height: state.height },
    markerViewportPoint: {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    },
    anchor: {
      kind: "region",
      pageUrl: state.url,
      frameUrl: null,
      title: String(
        inspected.label || inspected.tagName || "Selected browser region",
      ),
      elementPath: String(inspected.selector || "browser region"),
      point: {
        xPercent: ((rect.x + rect.width / 2) / state.width) * 100,
        y: rect.y + rect.height / 2 + scrollY,
      },
      rect: { ...rect, y: rect.y + scrollY },
      isFixed: false,
      role: inspected.role ?? null,
      name: inspected.label ?? null,
      selector: inspected.selector ?? null,
      framePath: [],
      nearbyText: inspected.text ?? null,
    },
    screenshot: {
      dataUrl: `data:${screenshot.mimeType};base64,${screenshot.data}`,
      width: state.width,
      height: state.height,
      annotationViewportRect: rect,
    },
  };
}

export function createRemoteBrowserBridge(options: Options) {
  const request = options.request ?? fetch;
  const pages = new Map<string, Page>();
  const rendererInstances = new Set<string>();
  const generations = new Map<string, number>();
  const key = (route: BrowserRoute) =>
    `${route.conversationId}\0${route.browserTabId}`;
  let disposed = false;

  function pageFor(route: BrowserRoute): Page {
    const id = key(route);
    let page = pages.get(id);
    if (!page || page.disposed) {
      page = {
        route,
        queue: Promise.resolve(),
        disposed: false,
        mode: "browse",
        comments: [],
        annotationGeneration: 0,
        views: new Set(),
      };
      pages.set(id, page);
    }
    return page;
  }
  function emit(page: Page, type: string, fields: Message = {}) {
    if (!disposed) options.emitMessage({ type, ...page.route, ...fields });
  }
  function publish(page: Page, state: RemoteBrowserState) {
    if (disposed || page.disposed || key(state) !== key(page.route)) return;
    if (page.state && page.state.url !== state.url) cancelAnnotation(page);
    page.state = state;
    emit(page, "browser-sidebar-state", {
      snapshot: toNativeBrowserSnapshot(state, page.mode, page.comments),
    });
    for (const view of page.views) view.update();
  }
  function cancelAnnotation(page: Page) {
    page.annotationGeneration++;
    for (const view of page.views) view.cancelAnnotation();
  }
  function report(page: Page, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const view of page.views) view.error(message);
  }
  function command(
    page: Page,
    action: string,
    fields: Message = {},
  ): Promise<{ state: RemoteBrowserState; value?: unknown }> {
    const operation = page.queue.then(async () => {
      if (disposed || page.disposed) throw new Error("Browser tab is closed");
      const response = await request("/__backend/remote-browser/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...page.route, action, ...fields }),
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok)
        throw new BrowserResponseError(
          result?.error ??
            result?.message ??
            `Browser request failed (${response.status})`,
        );
      if (!record(result) || !record(result.state))
        throw new Error("Invalid browser response");
      const value = result as { state: RemoteBrowserState; value?: unknown };
      publish(page, value.state);
      return value;
    });
    // A failed action must not poison subsequent navigation or keyboard input.
    page.queue = operation.catch((error) => report(page, error));
    return operation;
  }
  function connect(page: Page) {
    if (
      disposed ||
      page.disposed ||
      page.migration ||
      page.socket ||
      !page.views.size
    )
      return;
    const url = new URL("/__backend/remote-browser/stream", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("conversationId", page.route.conversationId);
    url.searchParams.set("browserTabId", page.route.browserTabId);
    const socket = new WebSocket(url);
    page.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      if (page.socket !== socket || page.disposed) return;
      try {
        const event = JSON.parse(String(data));
        if (event.type === "state") publish(page, event.state);
        else if (event.type === "frame")
          for (const view of page.views) view.render(event);
        else if (event.type === "error") report(page, event.message);
        else if (event.type === "closed") closeLocal(page);
      } catch (error) {
        report(page, error);
      }
    });
    socket.addEventListener("close", () => {
      if (page.socket !== socket) return;
      page.socket = undefined;
      if (!disposed && !page.disposed && page.views.size) {
        for (const view of page.views) view.error("连接已断开，正在重新连接…");
        page.reconnect = setTimeout(() => {
          page.reconnect = undefined;
          connect(page);
        }, 1000);
      }
    });
  }
  function disconnect(page: Page) {
    if (page.reconnect) clearTimeout(page.reconnect);
    page.reconnect = undefined;
    const socket = page.socket;
    page.socket = undefined;
    socket?.close();
  }
  function ensureOpen(page: Page) {
    if (page.migration) return page.migration.promise;
    return (page.opening ??= command(page, "open")
      .then(() => {
        connect(page);
      })
      .catch((error) => {
        page.opening = undefined;
        throw error;
      }));
  }
  function transferPage(page: Page, target: BrowserRoute): Promise<void> {
    if (key(page.route) === key(target)) return ensureOpen(page);
    if (page.migration) {
      if (key(page.migration.target) === key(target))
        return page.migration.promise;
      return Promise.reject(
        new Error("Browser tab is already being transferred"),
      );
    }
    const existing = pages.get(key(target));
    if (existing && existing !== page && !existing.disposed)
      return Promise.reject(new Error("Target browser tab already exists"));
    cancelAnnotation(page);
    disconnect(page);
    const opening = ensureOpen(page);
    // Native registers its reassociated host before the transfer request finishes.
    // Reserve that route now so registration cannot open a second browser context.
    pages.set(key(target), page);
    const promise = opening
      .then(() =>
        command(page, "transfer", {
          targetConversationId: target.conversationId,
          targetBrowserTabId: target.browserTabId,
        }),
      )
      .then(({ state }) => {
        if (disposed || page.disposed) return;
        page.route = target;
        page.migration = undefined;
        publish(page, state);
        connect(page);
      });
    page.migration = { target, promise };
    return promise;
  }
  function closeLocal(page: Page) {
    if (page.disposed) return;
    page.disposed = true;
    disconnect(page);
    for (const view of [...page.views]) view.element.destroy();
    for (const [id, candidate] of pages) {
      if (candidate !== page) continue;
      pages.delete(id);
      generations.delete(id);
    }
    emit(page, "browser-sidebar-destroy-webview", {
      ...page.migration?.target,
      reason: "closed",
      mountGeneration: 0,
    });
  }
  function safely(operation: Promise<unknown>, page: Page) {
    void operation.catch((error) => report(page, error));
  }

  function createWebview(route: BrowserRoute) {
    const page = pageFor(route);
    const element = Object.assign(document.createElement("div"), {
      destroy() {},
    });
    element.tabIndex = 0;
    element.setAttribute("role", "application");
    element.setAttribute("aria-label", "网页内容");
    element.dataset.remoteBrowserViewport = "true";
    Object.assign(element.style, {
      position: "relative",
      overflow: "hidden",
      outline: "none",
      touchAction: "none",
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      width: "100%",
      height: "100%",
      display: "block",
    });
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    Object.assign(status.style, {
      position: "absolute",
      inset: "auto 12px 12px",
      padding: "8px 12px",
      borderRadius: "8px",
      background: "var(--color-surface, #fff)",
      color: "var(--color-text-primary, #222)",
      font: "12px system-ui",
      display: "none",
    });
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "输入网页文字");
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    Object.assign(input.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      padding: "0",
      border: "0",
      opacity: "0.01",
      resize: "none",
    });
    const outline = document.createElement("div");
    Object.assign(outline.style, {
      position: "absolute",
      border: "2px solid #3485ff",
      background: "rgba(52,133,255,.12)",
      pointerEvents: "none",
      display: "none",
    });
    element.append(canvas, input, outline, status);
    const controller = new AbortController();
    const listeners = { signal: controller.signal };
    let destroyed = false;
    let renderedSequence = -1;
    let composing = false;
    let lastComposition = 0;
    let selectionStart: { x: number; y: number } | null = null;
    let commentEditor: HTMLFormElement | null = null;
    let moveFrame = 0;
    let pendingMove: Message | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSize = "";
    const pressedKeys = new Set<string>();
    const send = (action: string, fields: Message = {}) =>
      safely(
        ensureOpen(page).then(() => command(page, action, fields)),
        page,
      );
    const releasePressedKeys = () => {
      for (const key of pressedKeys) send("key", { eventType: "up", key });
      pressedKeys.clear();
    };
    const point = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: Math.max(
          0,
          Math.min(
            ((event.clientX - bounds.left) / bounds.width) *
              (page.state?.width ?? canvas.width),
            (page.state?.width ?? canvas.width) - 1,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            ((event.clientY - bounds.top) / bounds.height) *
              (page.state?.height ?? canvas.height),
            (page.state?.height ?? canvas.height) - 1,
          ),
        ),
      };
    };
    const mouseButton = (button: number) =>
      button === 2 ? "right" : button === 1 ? "middle" : "left";
    const showOutline = (selection: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => {
      const width = page.state?.width ?? canvas.width;
      const height = page.state?.height ?? canvas.height;
      Object.assign(outline.style, {
        display: "block",
        left: `${(selection.x / width) * 100}%`,
        top: `${(selection.y / height) * 100}%`,
        width: `${(Math.max(2, selection.width) / width) * 100}%`,
        height: `${(Math.max(2, selection.height) / height) * 100}%`,
      });
    };
    function showComment(selection: Selection, generation: number) {
      commentEditor?.remove();
      const form = document.createElement("form");
      commentEditor = form;
      Object.assign(form.style, {
        position: "absolute",
        left: "12px",
        right: "12px",
        bottom: "12px",
        padding: "12px",
        background: "var(--color-surface, #fff)",
        color: "var(--color-text-primary, #222)",
        border: "1px solid var(--color-border, #ddd)",
        borderRadius: "12px",
        boxShadow: "0 4px 20px #0002",
        display: "grid",
        gap: "8px",
      });
      const field = document.createElement("textarea");
      field.placeholder = "告诉 Codex 这里需要怎么改…";
      field.setAttribute("aria-label", "网页备注");
      field.rows = 3;
      Object.assign(field.style, {
        width: "100%",
        resize: "vertical",
        background: "transparent",
        color: "inherit",
        border: "0",
        font: "13px system-ui",
      });
      const actions = document.createElement("div");
      Object.assign(actions.style, {
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px",
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => cancelAnnotation(page), listeners);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "添加到对话";
      for (const button of [cancel, submit])
        Object.assign(button.style, {
          border: "1px solid var(--color-border, #ddd)",
          borderRadius: "6px",
          padding: "5px 10px",
          font: "12px system-ui",
          cursor: "pointer",
        });
      actions.append(cancel, submit);
      form.append(field, actions);
      element.append(form);
      form.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          const text = field.value.trim();
          if (!text || submit.disabled) return;
          submit.disabled = true;
          command(page, "screenshot")
            .then(({ state, value }) => {
              if (
                destroyed ||
                page.disposed ||
                page.annotationGeneration !== generation ||
                commentEditor !== form ||
                page.mode !== "comment"
              )
                return;
              if (!record(value) || typeof value.data !== "string")
                throw new Error("截图未返回图片数据");
              page.comments = [
                ...page.comments,
                toNativeBrowserComment(
                  state,
                  selection,
                  text,
                  {
                    data: value.data,
                    mimeType: String(value.mimeType || "image/png"),
                  },
                  document.documentElement.classList.contains("dark")
                    ? "dark"
                    : "light",
                ),
              ];
              page.mode = "browse";
              cancelAnnotation(page);
              publish(page, state);
            })
            .catch((error) => {
              if (
                destroyed ||
                page.disposed ||
                page.annotationGeneration !== generation
              )
                return;
              submit.disabled = false;
              report(page, error);
            });
        },
        listeners,
      );
      field.focus();
    }
    function webpageTarget(event: Event) {
      return (
        event.target === canvas ||
        event.target === element ||
        event.target === input
      );
    }
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (!webpageTarget(event)) return;
        event.preventDefault();
        emit(page, "browser-sidebar-web-contents-pointer-down");
        element.setPointerCapture(event.pointerId);
        const position = point(event);
        if (page.mode === "comment") {
          cancelAnnotation(page);
          selectionStart = position;
          showOutline({ ...position, width: 1, height: 1 });
          return;
        }
        input.focus({ preventScroll: true });
        send("mouse", {
          eventType: "down",
          ...position,
          button: mouseButton(event.button),
        });
      },
      listeners,
    );
    element.addEventListener(
      "pointermove",
      (event) => {
        if (
          !webpageTarget(event) &&
          !element.hasPointerCapture(event.pointerId)
        )
          return;
        const position = point(event);
        if (selectionStart) {
          showOutline({
            x: Math.min(selectionStart.x, position.x),
            y: Math.min(selectionStart.y, position.y),
            width: Math.abs(position.x - selectionStart.x),
            height: Math.abs(position.y - selectionStart.y),
          });
        } else if (page.mode === "browse") {
          pendingMove = {
            eventType: "move",
            ...position,
            button: mouseButton(event.button),
          };
          moveFrame ||= requestAnimationFrame(() => {
            moveFrame = 0;
            if (pendingMove) send("mouse", pendingMove);
            pendingMove = null;
          });
        }
      },
      listeners,
    );
    element.addEventListener(
      "pointerup",
      (event) => {
        if (
          !webpageTarget(event) &&
          !element.hasPointerCapture(event.pointerId)
        )
          return;
        if (element.hasPointerCapture(event.pointerId))
          element.releasePointerCapture(event.pointerId);
        const position = point(event);
        if (selectionStart) {
          const start = selectionStart;
          const generation = page.annotationGeneration;
          selectionStart = null;
          const bounds = {
            x: Math.min(start.x, position.x),
            y: Math.min(start.y, position.y),
            width: Math.abs(position.x - start.x),
            height: Math.abs(position.y - start.y),
          };
          safely(
            ensureOpen(page)
              .then(() =>
                command(page, "inspect", {
                  x: bounds.x + bounds.width / 2,
                  y: bounds.y + bounds.height / 2,
                }),
              )
              .then(({ value }) => {
                if (
                  destroyed ||
                  page.disposed ||
                  page.mode !== "comment" ||
                  page.annotationGeneration !== generation
                )
                  return;
                const elementRect =
                  record(value) && record(value.rect) ? value.rect : null;
                const selected =
                  bounds.width < 6 && bounds.height < 6 && elementRect
                    ? {
                        x: Number(elementRect.x),
                        y: Number(elementRect.y),
                        width: Number(elementRect.width),
                        height: Number(elementRect.height),
                      }
                    : bounds;
                const selection = { ...selected, value };
                showOutline(selection);
                options.onInspect?.({ ...page.route, ...selection });
                showComment(selection, generation);
              }),
            page,
          );
        } else if (page.mode === "browse")
          send("mouse", {
            eventType: "up",
            ...position,
            button: mouseButton(event.button),
          });
      },
      listeners,
    );
    element.addEventListener(
      "pointercancel",
      (event) => {
        selectionStart = null;
        outline.style.display = "none";
        if (page.mode === "browse")
          send("mouse", {
            eventType: "up",
            ...point(event),
            button: mouseButton(event.button),
          });
      },
      listeners,
    );
    element.addEventListener(
      "wheel",
      (event) => {
        if (!webpageTarget(event)) return;
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? (page.state?.height ?? 720)
              : 1;
        send("scroll", {
          deltaX: event.deltaX * unit,
          deltaY: event.deltaY * unit,
        });
      },
      { ...listeners, passive: false },
    );
    element.addEventListener(
      "contextmenu",
      (event) => {
        if (webpageTarget(event)) event.preventDefault();
      },
      listeners,
    );
    input.addEventListener(
      "compositionstart",
      () => {
        composing = true;
      },
      listeners,
    );
    input.addEventListener(
      "compositionend",
      (event) => {
        composing = false;
        lastComposition = performance.now();
        input.value = "";
        if (event.data) send("text", { text: event.data });
      },
      listeners,
    );
    input.addEventListener(
      "beforeinput",
      (event) => {
        if (composing || event.isComposing) return;
        event.preventDefault();
        if (
          event.inputType === "insertFromComposition" ||
          performance.now() - lastComposition < 30
        )
          return;
        if (event.data && event.inputType.startsWith("insert"))
          send("text", { text: event.data });
        input.value = "";
      },
      listeners,
    );
    input.addEventListener(
      "paste",
      (event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain");
        if (text) send("text", { text });
      },
      listeners,
    );
    for (const eventType of ["keydown", "keyup"] as const)
      input.addEventListener(
        eventType,
        (event) => {
          if (event.isComposing || composing || event.key === "Process") return;
          // Printable text goes through beforeinput so IME and keyboard layouts work.
          const printable =
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey;
          if (
            printable ||
            ((event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "v")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (eventType === "keydown") pressedKeys.add(event.key);
          else pressedKeys.delete(event.key);
          send("key", {
            eventType: eventType === "keydown" ? "down" : "up",
            key: event.key,
          });
        },
        listeners,
      );
    element.addEventListener(
      "focus",
      () => {
        if (page.mode === "browse") input.focus({ preventScroll: true });
      },
      listeners,
    );
    input.addEventListener(
      "focus",
      () => element.dispatchEvent(new FocusEvent("focus")),
      listeners,
    );
    input.addEventListener(
      "blur",
      () => {
        releasePressedKeys();
        element.dispatchEvent(new FocusEvent("blur"));
      },
      listeners,
    );
    window.addEventListener("blur", releasePressedKeys, listeners);
    const resize = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        const width = Math.round(element.clientWidth);
        const height = Math.round(element.clientHeight);
        if (width < 1 || height < 1 || `${width}:${height}` === lastSize)
          return;
        lastSize = `${width}:${height}`;
        send("resize", { width, height });
      }, 100);
    });
    resize.observe(element);
    const view: View = {
      element,
      render(frame) {
        if (destroyed || frame.sequence <= renderedSequence) return;
        const image = new Image();
        image.onload = () => {
          if (destroyed || frame.sequence <= renderedSequence) return;
          renderedSequence = frame.sequence;
          canvas.width = frame.width;
          canvas.height = frame.height;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          if (!page.state?.error) status.style.display = "none";
        };
        image.src = `data:${frame.mimeType};base64,${frame.data}`;
      },
      update() {
        canvas.style.cursor = page.mode === "comment" ? "crosshair" : "default";
        if (page.mode === "browse" && !commentEditor)
          outline.style.display = "none";
        if (page.state?.error) view.error(page.state.error);
      },
      error(message) {
        status.textContent = message;
        status.style.display = "block";
      },
      cancelAnnotation() {
        selectionStart = null;
        commentEditor?.remove();
        commentEditor = null;
        outline.style.display = "none";
      },
    };
    element.destroy = () => {
      if (destroyed) return;
      releasePressedKeys();
      destroyed = true;
      controller.abort();
      resize.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (moveFrame) cancelAnimationFrame(moveFrame);
      page.views.delete(view);
      element.remove();
      if (!page.views.size) disconnect(page);
    };
    page.views.add(view);
    safely(
      ensureOpen(page).then(() => connect(page)),
      page,
    );
    return element;
  }

  async function handleCommand(page: Page, message: Message) {
    const action = record(message.command) ? message.command : {};
    if (action.type === "transfer-conversation") {
      const target = routeOf({
        conversationId: action.targetConversationId,
        browserTabId: action.targetBrowserTabId,
      });
      if (!target) throw new Error("Invalid browser transfer target");
      await transferPage(page, target);
      return;
    }
    if (action.type === "close-tab") {
      cancelAnnotation(page);
      try {
        try {
          await ensureOpen(page);
        } catch (error) {
          // A rejected migration still owns its source page. A lost response
          // leaves ownership unknown, so only local cleanup is safe in that case.
          if (!page.migration || !(error instanceof BrowserResponseError))
            throw error;
        }
        await command(page, "close");
      } finally {
        closeLocal(page);
      }
      return;
    }
    if (action.type === "set-interaction-mode") {
      cancelAnnotation(page);
      page.mode = action.interactionMode === "comment" ? "comment" : "browse";
      if (page.state) publish(page, page.state);
      return;
    }
    if (action.type === "add-annotations-to-composer") {
      cancelAnnotation(page);
      page.mode = "browse";
      if (page.state) publish(page, page.state);
      return;
    }
    if (
      action.type === "clear-comments" ||
      action.type === "discard-pending-annotations"
    ) {
      cancelAnnotation(page);
      if (page.comments.length) page.comments = [];
      if (action.type === "clear-comments") page.mode = "browse";
      if (page.state) publish(page, page.state);
      return;
    }
    if (
      [
        "set-design-modifier-pressed",
        "refresh-cursor",
        "focus-address",
      ].includes(String(action.type))
    )
      return;
    if (
      ["navigate", "go-back", "go-forward", "reload", "reset"].includes(
        String(action.type),
      )
    )
      cancelAnnotation(page);
    await ensureOpen(page);
    const mapped: Record<string, string> = {
      navigate: "navigate",
      "go-back": "back",
      "go-forward": "forward",
      reload: "reload",
      stop: "stop",
      reset: "navigate",
    };
    if (typeof action.type === "string" && mapped[action.type]) {
      await command(
        page,
        mapped[action.type],
        action.type === "reset"
          ? { url: "about:blank" }
          : action.type === "navigate"
            ? { url: action.url }
            : {},
      );
      return;
    }
    if (action.type === "capture-screenshot") {
      try {
        const { value } = await command(page, "screenshot");
        if (!record(value) || typeof value.data !== "string")
          throw new Error("截图未返回图片数据");
        const mime =
          typeof value.mimeType === "string" ? value.mimeType : "image/png";
        const blob = await (
          await fetch(`data:${mime};base64,${value.data}`)
        ).blob();
        if (!navigator.clipboard?.write)
          throw new Error("当前浏览器不支持复制图片");
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
        emit(page, "browser-sidebar-screenshot-copied");
      } catch (error) {
        emit(page, "browser-sidebar-screenshot-copy-failed");
        throw error;
      }
      return;
    }
    throw new Error("此浏览器操作暂不支持");
  }

  function handleMessage(message: unknown): Promise<unknown> | undefined {
    if (!record(message) || typeof message.type !== "string") return;
    const supported = [
      "browser-sidebar-owner-sync",
      "browser-sidebar-sync",
      "browser-sidebar-command",
      "browser-sidebar-webview-destroyed",
    ];
    if (!supported.includes(message.type)) return;
    const payload =
      message.type === "browser-sidebar-sync" ? message.payload : message;
    const route = routeOf(payload);
    if (!route) return Promise.resolve();
    if (message.type === "browser-sidebar-webview-destroyed")
      return Promise.resolve();
    const source = record(payload)
      ? routeOf({
          conversationId: payload.transferSourceConversationId,
          browserTabId: payload.transferSourceBrowserTabId,
        })
      : null;
    const migration = source ? transferPage(pageFor(source), route) : undefined;
    const page = pageFor(route);
    if (message.type === "browser-sidebar-command")
      return handleCommand(page, message).catch((error) => {
        report(page, error);
      });
    return (migration ?? ensureOpen(page))
      .then(() => {
        if (record(payload) && payload.presented)
          emit(page, "browser-sidebar-webview-attached", {
            mountGeneration: payload.mountGeneration ?? 0,
          });
      })
      .catch((error) => report(page, error));
  }

  const browserHost = {
    async registerWebviewHostSession({
      rendererInstanceId,
    }: {
      rendererInstanceId: string;
    }) {
      if (disposed) return false;
      rendererInstances.add(rendererInstanceId);
      return true;
    },
    async registerWebviewHost(
      args: BrowserRoute & {
        rendererInstanceId: string;
        hostGeneration: number;
      },
    ) {
      if (disposed || !rendererInstances.has(args.rendererInstanceId))
        return false;
      const previous = generations.get(key(args)) ?? -1;
      if (args.hostGeneration < previous) return false;
      generations.set(key(args), args.hostGeneration);
      await ensureOpen(pageFor(args));
      return !disposed && generations.get(key(args)) === args.hostGeneration;
    },
    async syncView(
      args: BrowserRoute & { mountGeneration: number; presented: boolean },
    ) {
      const page = pageFor(args);
      await ensureOpen(page);
      if (args.presented)
        emit(page, "browser-sidebar-webview-attached", {
          mountGeneration: args.mountGeneration,
        });
    },
    async waitForViewportSize(
      args: BrowserRoute & { viewportSize: { width: number; height: number } },
    ) {
      const state = pages.get(key(args))?.state;
      return (
        state?.width === args.viewportSize.width &&
        state?.height === args.viewportSize.height
      );
    },
    async cancelViewportWait() {},
  };

  return {
    createWebview,
    browserHost,
    handleMessage,
    dispose() {
      disposed = true;
      for (const page of [...pages.values()]) closeLocal(page);
      pages.clear();
      rendererInstances.clear();
      generations.clear();
    },
  };
}
