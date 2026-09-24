// Keep native source/image/document previews intact. These packaged files need
// a browser download instead of the desktop's OS file-manager operation.
const downloadableArchive = /\.(?:zip|7z|rar|tar|gz|bz2|xz|tgz|tbz2|txz|zst|apk|aab|dmg|pkg|deb|rpm|msi|exe)$/i;

export type LocalFileOpenRequest = {
  path: string;
  openMode?: string;
  cwd?: string | null;
  hostId?: string | null;
};

export function localDownloadPath(request: LocalFileOpenRequest): string | null {
  if (request.openMode === "workspace") return null;
  if (request.hostId != null && request.hostId !== "local") return null;
  let path = request.path;
  if (typeof path !== "string" || path.includes("\0")) return null;
  if (path.startsWith("file:")) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (!path.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    if (!request.cwd?.startsWith("/") || request.cwd.startsWith("//")) return null;
    path = `${request.cwd.replace(/\/$/, "")}/${path}`;
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\0")) return null;
  return downloadableArchive.test(path) ? path : null;
}

export function downloadLocalFile(request: LocalFileOpenRequest): boolean {
  const path = localDownloadPath(request);
  if (!path) return false;
  void fetchDownload(path).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "网络连接失败，请重试。";
    window.alert(`下载失败：${message}`);
  });
  return true;
}

async function fetchDownload(path: string): Promise<void> {
  // Fetch in the authenticated page context. Browser download managers may
  // start a separate unauthenticated request when given this endpoint directly.
  const response = await fetch(`/__backend/download?${new URLSearchParams({ path })}`, {
    credentials: "include",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已失效，请刷新页面并重新登录后重试。");
    throw new Error(`服务器返回 HTTP ${response.status}，请稍后重试。`);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop() ?? "download";
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Allow the browser to acquire the Blob before releasing its backing data.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
