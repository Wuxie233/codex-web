type HostHandlers = Record<string, (...args: unknown[]) => unknown>;

type SandboxOptions = {
  hostApiHandlers: HostHandlers;
  signal: AbortSignal;
  webview: HTMLIFrameElement;
};

// This function is serialized into the opaque-origin frame before its content.
function initializeFrame() {
  let port: MessagePort | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const queue: unknown[] = [];
  const send = (message: unknown) =>
    port ? port.postMessage(message) : queue.push(message);
  const call = (method: string, ...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ id, method, args });
    });
  const api: Record<string, unknown> = {
    callTool: (name: string, args: unknown) => call("callTool", name, args),
    openExternal: (args: unknown) => call("openExternal", args),
    sendFollowUpMessage: (args: unknown) => call("sendFollowUpMessage", args),
    requestDisplayMode: (args: unknown) => call("requestDisplayMode", args),
  };
  Object.assign(globalThis, { openai: api });
  addEventListener(
    "message",
    function initialize(event: MessageEvent) {
      if (
        event.source !== parent ||
        event.data?.type !== "codex-visualization-connect" ||
        event.ports.length !== 1 ||
        port
      )
        return;
      event.stopImmediatePropagation();
      port = event.ports[0];
      port.onmessage = ({ data }) => {
        if (data.type === "globals") {
          Object.assign(api, data.globals);
          dispatchEvent(
            new CustomEvent("openai:set_globals", { detail: { globals: api } }),
          );
          return;
        }
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.result);
      };
      for (const message of queue.splice(0)) port.postMessage(message);
      removeEventListener("message", initialize, true);
    },
    true,
  );
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      send({ type: "ready" });
    },
    { once: true },
  );
  document.addEventListener("click", (event) => {
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || event.defaultPrevented || link.hasAttribute("download"))
      return;
    const href = link.getAttribute("href")!;
    if (href.startsWith("#")) return;
    event.preventDefault();
    if (event.isTrusted)
      void call("openExternal", { href: new URL(href, location.href).href });
  });
  parent.postMessage({ type: "codex-visualization-ready" }, "*");
}

export function connectVisualizationSandbox({
  hostApiHandlers,
  signal,
  webview,
}: SandboxOptions) {
  const channel = new MessageChannel();
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finish = (error?: Error) => {
    clearTimeout(timer);
    if (error) rejectReady?.(error);
    else resolveReady?.();
    resolveReady = undefined;
    rejectReady = undefined;
  };
  const initialize = (event: MessageEvent) => {
    if (
      event.source !== webview.contentWindow ||
      event.origin !== "null" ||
      event.data?.type !== "codex-visualization-ready"
    )
      return;
    window.removeEventListener("message", initialize);
    webview.contentWindow!.postMessage(
      { type: "codex-visualization-connect" },
      "*",
      [channel.port2],
    );
  };
  const dispose = () => {
    finish(new DOMException("Visualization was closed", "AbortError"));
    window.removeEventListener("message", initialize);
    signal.removeEventListener("abort", dispose);
    channel.port1.close();
    channel.port2.close();
    webview.removeAttribute("srcdoc");
  };
  channel.port1.onmessage = async ({ data }) => {
    if (signal.aborted) return;
    if (data.type === "ready") {
      finish();
      return;
    }
    const allowed = [
      "callTool",
      "openExternal",
      "sendFollowUpMessage",
      "requestDisplayMode",
    ];
    if (!allowed.includes(data.method) || !Array.isArray(data.args)) return;
    try {
      const result = await hostApiHandlers[data.method](...data.args);
      if (!signal.aborted) channel.port1.postMessage({ id: data.id, result });
    } catch (error) {
      if (!signal.aborted)
        channel.port1.postMessage({
          id: data.id,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  };
  const globals = (value: Record<string, unknown>) => {
    if (!signal.aborted)
      channel.port1.postMessage({ type: "globals", globals: value });
    return Promise.resolve();
  };
  return {
    async *runWidgetCode(options: {
      html: string;
      theme: string;
      maxHeight: number;
      maxWidth: number;
      csp: { resourceDomains: string[] };
    }) {
      if (signal.aborted)
        throw new DOMException("Visualization was closed", "AbortError");
      const resources = options.csp.resourceDomains.join(" ");
      const policy = [
        "default-src 'none'",
        `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${resources}`,
        `style-src 'unsafe-inline' ${resources}`,
        `img-src ${resources}`,
        `font-src ${resources}`,
        `media-src ${resources}`,
        "worker-src blob:",
        "connect-src blob: data:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      window.addEventListener("message", initialize);
      signal.addEventListener("abort", dispose, { once: true });
      timer = setTimeout(
        () =>
          finish(
            new DOMException(
              "Visualization initialization timed out",
              "TimeoutError",
            ),
          ),
        30_000,
      );
      webview.setAttribute("sandbox", "allow-scripts");
      webview.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}"><script>(${initializeFrame.toString()})();</script></head><body>${options.html}</body></html>`;
      try {
        await ready;
        await globals({
          theme: options.theme,
          maxHeight: options.maxHeight,
          maxWidth: options.maxWidth,
        });
        yield { type: "environment_status", status: 2 };
      } catch (error) {
        dispose();
        throw error;
      }
    },
    setTheme: ({ theme }: { theme: string }) => globals({ theme }),
    setAdditionalGlobals: ({
      additionalGlobals,
    }: {
      additionalGlobals: Record<string, unknown>;
    }) => globals(additionalGlobals),
    notifyMcpAppsHostContext: ({
      hostContext,
    }: {
      hostContext: Record<string, unknown>;
    }) => globals(hostContext),
    requestMcpAppsResourceTeardown: async () => dispose(),
  };
}
