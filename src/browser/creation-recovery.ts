import { dispatchNavigateToRoute } from "./routes";

type CoordinatorRequest = (request: {
  method: string;
  params: Record<string, unknown>;
}) => Promise<unknown>;

type CreationReceipt = {
  status: "queued" | "created" | "failed" | "outcome-unknown";
  threadId?: string;
  turnId?: string;
  uiMetadata?: Record<string, unknown>;
  error?: string;
};

/** Recover only the creation displayed by this page; the daemon owns execution. */
export function installCreationRecovery(request: CoordinatorRequest): () => void {
  const originalPath = window.location.pathname;
  const match = originalPath.match(/^\/thread\/([^/]+)$/);
  if (!match) return () => {};
  let clientThreadId: string;
  try {
    clientThreadId = decodeURIComponent(match[1]);
  } catch {
    return () => {};
  }
  const prefix = "codex-web-creation:";
  const suffix = `:${clientThreadId}`;
  let key: string | null = null;
  for (let index = 0; index < localStorage.length; index++) {
    const candidate = localStorage.key(index);
    if (candidate?.startsWith(prefix) && candidate.endsWith(suffix)) {
      key = candidate;
      break;
    }
  }
  if (!key) return () => {};
  const requestId = localStorage.getItem(key);
  if (!requestId) return () => {};
  const hostId = key.slice(prefix.length, -suffix.length);
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notice: HTMLDivElement | undefined;
  const active = () => !stopped && window.location.pathname === originalPath;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    notice?.remove();
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("popstate", routeChanged);
    window.removeEventListener("codex-web:navigation", routeChanged);
    window.removeEventListener("message", routeMessage);
  };
  const routeChanged = () => {
    if (!active()) stop();
  };
  const routeMessage = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== "navigate-to-route") return;
    if (event.data.path !== `/local/${clientThreadId}`) stop();
  };
  const show = (message: string, refresh: boolean) => {
    if (!active()) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:min(560px,90vw);padding:12px 16px;border:1px solid #7776;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 4px 20px #0003;font:14px/1.5 system-ui;overflow-wrap:anywhere";
      document.body.append(notice);
    }
    notice.replaceChildren(document.createTextNode(message));
    if (refresh) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "查看状态";
      button.style.cssText = "display:block;margin-top:8px;padding:4px 10px;cursor:pointer";
      button.addEventListener("click", () => void read());
      notice.append(button);
    }
  };
  const read = async () => {
    if (!active()) return stop();
    if (pending) return;
    pending = true;
    try {
      const receipt = await request({
        method: "codexWeb/thread/creation/read",
        params: { hostId, requestId },
      }) as CreationReceipt | null;
      if (!active()) return stop();
      if (receipt?.threadId && (receipt.status === "created" || receipt.status === "failed")) {
        const threadId = receipt.threadId;
        const detailed = await request({
          method: "codexWeb/thread/creation/read",
          params: { hostId, requestId, includeMetadata: true },
        }) as CreationReceipt | null;
        if (!active()) return stop();
        const creationWindow = window as Window & {
          __codexWebCreationMetadata?: Record<string, CreationReceipt>;
          codexWebApplyCreationMetadata?: (hostId: string, threadId: string) => void | Promise<void>;
        };
        if (detailed?.turnId && detailed.uiMetadata) {
          (creationWindow.__codexWebCreationMetadata ??= {})[
            JSON.stringify([hostId, threadId])
          ] = detailed;
          try {
            await creationWindow.codexWebApplyCreationMetadata?.(hostId, threadId);
          } catch {
            console.warn("Created task metadata could not refresh the current view.");
          }
        }
        localStorage.setItem(`${prefix}${hostId}:${threadId}`, requestId);
        stop();
        dispatchNavigateToRoute(`/local/${threadId}`);
        return;
      }
      if (receipt?.status === "queued") {
        show("任务已提交，服务器正在创建。关闭页面不会中止创建。", false);
        timer = setTimeout(() => void read(), 1000);
      } else if (receipt?.status === "failed") {
        show(`创建失败：${receipt.error ?? "服务器未提供错误详情"}。请求：${requestId}`, true);
      } else {
        show(`提交结果尚未确认，请勿重复发送。请求：${requestId}`, true);
      }
    } catch {
      if (active()) show(`暂时无法查询创建结果，请勿重复发送。请求：${requestId}`, true);
    } finally {
      pending = false;
    }
  };
  window.addEventListener("pagehide", stop);
  window.addEventListener("popstate", routeChanged);
  window.addEventListener("codex-web:navigation", routeChanged);
  window.addEventListener("message", routeMessage);
  timer = setTimeout(() => void read(), 0);
  return stop;
}
