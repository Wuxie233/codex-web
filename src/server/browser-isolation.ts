import type { IncomingHttpHeaders } from "node:http";

// Missing Fetch Metadata remains compatible with non-browser clients. Browsers
// cannot forge these headers; an opaque preview sends null/cross-site metadata.
export function isIsolatedBrowserRequest(
  headers: IncomingHttpHeaders,
): boolean {
  if (headers["x-codex-remote-browser"] != null) return true;
  const site = headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  const origin = headers.origin;
  if (!origin) return false;
  if (origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return !/^https?:$/.test(parsed.protocol) || parsed.host !== headers.host;
  } catch {
    return true;
  }
}

// Only intentional top-level entry to known app pages bypasses Fetch Metadata.
// Embedded documents, assets, filesystem and API paths never receive this grant.
export function isUserAppNavigation(
  method: string,
  requestUrl: string,
  headers: IncomingHttpHeaders,
): boolean {
  if (
    headers["x-codex-remote-browser"] != null ||
    method !== "GET" ||
    headers.origin ||
    headers["sec-fetch-dest"] !== "document" ||
    headers["sec-fetch-mode"] !== "navigate" ||
    headers["sec-fetch-user"] !== "?1"
  )
    return false;
  const pathname = requestUrl.split("?", 1)[0] ?? "";
  return (
    pathname === "/" ||
    /^\/thread\/[A-Za-z0-9_-]+$/.test(pathname) ||
    /^\/(?:dots|o)(?:\/[A-Za-z0-9_-]+)?$/.test(pathname)
  );
}
