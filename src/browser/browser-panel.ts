import type { LocalFileOpenRequest } from "./downloads";

export type HtmlPreviewRequest = LocalFileOpenRequest & {
  onViewSource?: (path?: string) => void;
};

let openNativeTab: ((message: Record<string, unknown>) => void) | undefined;
export function installBrowserOpener(
  emit: (message: Record<string, unknown>) => void,
): void {
  openNativeTab = emit;
}

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

function open(url: string): boolean {
  if (!openNativeTab) return false;
  openNativeTab({
    type: "open-browser-tab",
    initialUrl: url,
    source: "manual",
    initiator: "side_panel_menu",
  });
  return true;
}

export function openLocalHtml(request: HtmlPreviewRequest): boolean {
  const path = localHtmlPath(request);
  if (!path) return false;
  const url = new URL("file:///");
  url.pathname = path;
  return open(url.href);
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
    return open(parsed.href);
  } catch {
    return false;
  }
}
