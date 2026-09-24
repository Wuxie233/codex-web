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
  const anchor = document.createElement("a");
  anchor.href = `/__backend/download?${new URLSearchParams({ path })}`;
  anchor.download = path.split("/").pop() ?? "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
