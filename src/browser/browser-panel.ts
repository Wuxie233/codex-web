import { fetchDownload, type LocalFileOpenRequest } from "./downloads";

export type HtmlPreviewRequest = LocalFileOpenRequest & {
  onViewSource?: (path?: string) => void;
};
type Page = {
  url: string;
  label: string;
  path?: string;
  onViewSource?: (path?: string) => void;
  prefix?: string;
  root?: string;
  downloadPath?: string;
};
let panel: ReturnType<typeof createPanel> | undefined;

export function localHtmlPath(request: HtmlPreviewRequest): string | null {
  if (
    request.openMode === "workspace" ||
    (request.hostId != null && request.hostId !== "local")
  )
    return null;
  let file = request.path;
  try {
    if (file.startsWith("file:")) {
      const url = new URL(file);
      if (url.hostname && url.hostname !== "localhost") return null;
      file = decodeURIComponent(url.pathname);
    } else if (!file.startsWith("/") && request.cwd?.startsWith("/"))
      file = `${request.cwd}/${file}`;
  } catch {
    return null;
  }
  return file.startsWith("/") &&
    !file.startsWith("//") &&
    !file.includes("\0") &&
    /\.html?$/i.test(file)
    ? file
    : null;
}

export function openLocalHtml(request: HtmlPreviewRequest): boolean {
  const path = localHtmlPath(request);
  if (!path) return false;
  const view = (panel ??= createPanel());
  view.openLocal(path, request.onViewSource);
  return true;
}

export function openBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.origin === location.origin ||
      parsed.username ||
      parsed.password
    )
      return false;
    (panel ??= createPanel()).navigate({
      url: parsed.href,
      label: parsed.href,
    });
    return true;
  } catch {
    return false;
  }
}

function createPanel() {
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "浏览器");
  dialog.dataset.codexBrowser = "";
  const style = document.createElement("style");
  style.textContent = `dialog[data-codex-browser]{width:min(1200px,96vw);height:90dvh;max-height:96dvh;padding:0;border:1px solid #8886;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 20px 70px #0005;overflow:hidden}dialog[data-codex-browser]::backdrop{background:#0006}[data-codex-browser] .cb-layout{height:100%;display:flex;flex-direction:column}[data-codex-browser] .cb-toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px;border-bottom:1px solid #8885}[data-codex-browser] button,[data-codex-browser] input{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:7px 10px;min-height:36px}[data-codex-browser] button{white-space:nowrap;flex-shrink:0}[data-codex-browser] button:disabled{opacity:.4}[data-codex-browser] form{display:flex;flex:1;min-width:160px;gap:6px}[data-codex-browser] input{width:100%;min-width:80px}[data-codex-browser] .cb-status{margin:0;padding:8px 12px;font-size:12px;border-bottom:1px solid #8884}[data-codex-browser] iframe{flex:1;width:100%;border:0;background:white;min-height:0}[data-codex-browser] [hidden]{display:none!important}`;
  const layout = document.createElement("div");
  layout.className = "cb-layout";
  const toolbar = document.createElement("div");
  toolbar.className = "cb-toolbar";
  function button(label: string, action: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", action);
    toolbar.append(b);
    return b;
  }
  const back = button("返回", () => move(-1));
  const forward = button("前进", () => move(1));
  const reload = button("刷新", () => {
    const p = pages[index];
    if (p?.path && !p.url) void openLocal(p.path, p.onViewSource);
    else if (p) void load(p);
  });
  const form = document.createElement("form");
  const address = document.createElement("input");
  address.setAttribute("aria-label", "网页地址");
  address.placeholder = "https://example.com";
  const go = document.createElement("button");
  go.type = "submit";
  go.textContent = "前往";
  form.append(address, go);
  toolbar.append(form);
  const source = button("查看源码", () => {
    const page = pages[index];
    close();
    page?.onViewSource?.(page.path);
  });
  const download = button("下载", () => {
    const path = pages[index]?.downloadPath;
    if (path)
      void fetchDownload(path).catch((e) => {
        status.textContent = `下载失败：${e instanceof Error ? e.message : "请重试"}`;
      });
  });
  const external = button("在新标签页打开", () => {
    const p = pages[index];
    if (p && !p.path) window.open(p.url, "_blank", "noopener,noreferrer");
  });
  button("关闭", close);
  const status = document.createElement("p");
  status.className = "cb-status";
  status.setAttribute("role", "status");
  const frame = document.createElement("iframe");
  frame.title = "网页预览";
  frame.referrerPolicy = "no-referrer";
  layout.append(toolbar, status, frame);
  dialog.append(style, layout);
  document.body.append(dialog);
  dialog.showModal();
  const pages: Page[] = [];
  let index = -1;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close() {
    generation++;
    clearTimeout(timer);
    window.removeEventListener("message", receive);
    dialog.close();
    dialog.remove();
    panel = undefined;
    previousFocus?.focus();
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  function controls(page: Page) {
    address.value = page.label;
    back.disabled = index <= 0;
    forward.disabled = index >= pages.length - 1;
    reload.disabled = false;
    source.hidden = !page.onViewSource;
    download.hidden = !page.downloadPath;
    external.hidden = !!page.path;
  }
  async function load(page: Page) {
    const current = ++generation;
    clearTimeout(timer);
    controls(page);
    frame.removeAttribute("src");
    frame.hidden = true;
    status.textContent = page.path
      ? "正在读取 HTML…"
      : "正在打开网页。部分网站禁止嵌入，若未显示请在新标签页打开。";
    frame.setAttribute("sandbox", "allow-scripts");
    if (page.path) {
      try {
        const result = await fetch(page.url, {
          method: "HEAD",
          credentials: "include",
        });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
      } catch (error) {
        if (current === generation)
          status.textContent = `无法读取 HTML（${error instanceof Error ? error.message : "网络错误"}）。可重试、查看源码或下载。`;
        return;
      }
    }
    if (current !== generation) return;
    frame.hidden = false;
    frame.onload = () => {
      if (current !== generation) return;
      clearTimeout(timer);
      status.textContent = page.path
        ? "HTML 预览 · 仅支持当前目录内的资源和页面；远程资源与网络请求已禁用。"
        : "部分网站禁止嵌入或要求单独登录；若页面未显示，请在新标签页打开。";
    };
    frame.onerror = () => {
      if (current === generation)
        status.textContent = "页面加载失败，请重试或在新标签页打开。";
    };
    frame.src = page.url;
    timer = setTimeout(() => {
      if (current === generation)
        status.textContent =
          "页面仍未响应。可刷新；外部网站也可在新标签页打开。";
    }, 15000);
  }
  function navigate(page: Page) {
    pages.splice(index + 1);
    pages.push(page);
    index = pages.length - 1;
    void load(page);
  }
  function move(delta: number) {
    const next = index + delta;
    if (next < 0 || next >= pages.length) return;
    index = next;
    void load(pages[index]!);
  }
  async function openLocal(
    path: string,
    onViewSource?: (path?: string) => void,
  ) {
    const current = ++generation;
    clearTimeout(timer);
    frame.removeAttribute("src");
    frame.hidden = true;
    status.textContent = "正在读取 HTML…";
    address.value = path;
    source.hidden = true;
    back.disabled = true;
    forward.disabled = true;
    reload.disabled = true;
    download.hidden = true;
    external.hidden = true;
    try {
      const result = await fetch("/__backend/browser-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        credentials: "include",
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const data = (await result.json()) as { url: string; path: string };
      if (current !== generation) return;
      const url = new URL(data.url, location.origin);
      const prefix = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
      navigate({
        url: url.href,
        label: path,
        path: data.path,
        downloadPath: data.path,
        onViewSource,
        prefix,
        root: data.path.slice(0, data.path.lastIndexOf("/") + 1),
      });
    } catch (error) {
      if (current !== generation) return;
      pages.splice(index + 1);
      pages.push({
        url: "",
        label: path,
        path,
        downloadPath: path,
        onViewSource,
      });
      index = pages.length - 1;
      controls(pages[index]!);
      status.textContent = `无法读取 HTML（${error instanceof Error ? error.message : "网络错误"}）。可查看源码或下载。`;
    }
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!openBrowserUrl(address.value.trim()))
      status.textContent = "请输入完整的 http:// 或 https:// 网页地址。";
  });
  function receive(event: MessageEvent) {
    if (
      event.source !== frame.contentWindow ||
      event.data?.type !== "codex-preview-navigate" ||
      typeof event.data.url !== "string"
    )
      return;
    const page = pages[index];
    if (!page?.prefix || !page.path) return;
    try {
      const url = new URL(event.data.url);
      if (
        url.origin === location.origin &&
        url.pathname.startsWith(page.prefix)
      ) {
        const suffix = decodeURIComponent(
          url.pathname.slice(page.prefix.length),
        );
        if (
          !suffix ||
          suffix.startsWith("/") ||
          suffix.includes("\\") ||
          suffix.includes("\0") ||
          suffix.split("/").some((part) => part === ".." || part === ".") ||
          !/\.html?$/i.test(suffix)
        )
          return;
        const root = page.root!;
        navigate({
          ...page,
          url: url.href,
          label: root + suffix,
          path: root + suffix,
          onViewSource: undefined,
          downloadPath: undefined,
        });
      } else if (url.origin !== location.origin) openBrowserUrl(url.href);
    } catch {
      /* Ignore malformed or out-of-scope navigation. */
    }
  }
  window.addEventListener("message", receive);
  address.focus();
  return { navigate, openLocal };
}
