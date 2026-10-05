import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";

export function parseDotEmbedParentOrigin(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid CODEX_DOT_EMBED_PARENT_ORIGIN");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "CODEX_DOT_EMBED_PARENT_ORIGIN must be one absolute HTTP(S) origin without a path",
    );
  }
  return url.origin;
}

export function isDotEmbedNavigation(
  parentOrigin: string | undefined,
  method: string,
  requestUrl: string,
  headers: IncomingHttpHeaders,
): boolean {
  if (
    !parentOrigin ||
    method !== "GET" ||
    !/^\/dots(?:\/[A-Za-z0-9_-]+)?$/.test(requestUrl) ||
    headers["x-codex-remote-browser"] != null ||
    headers["sec-fetch-dest"] !== "iframe" ||
    headers["sec-fetch-mode"] !== "navigate" ||
    (headers.origin !== undefined && headers.origin !== parentOrigin) ||
    typeof headers.referer !== "string"
  )
    return false;
  try {
    const referer = new URL(headers.referer);
    return (
      referer.origin === parentOrigin && !referer.username && !referer.password
    );
  } catch {
    return false;
  }
}

export function renderDotEmbedDocument(html: string): string {
  // These are native app-shell semantic attributes, not localized labels or
  // generated CSS classes. Hide the navigation panel and its toggle together.
  return html.replace(
    "<head>",
    `<head><meta name="codex-dot-embed" content="true"><style id="codex-dot-embed-style">
[role="menubar"]:has([id^="application-menu-trigger-"]), #application-menu-content,
[data-app-shell-left-panel-appearance]:has(#app-shell-sidebar), [data-app-shell-sidebar-trigger], #app-shell-sidebar { display: none !important; }
[data-app-shell-frame] { --app-shell-navigation-rail-width: 0px !important; }
</style>`,
  );
}

export function registerDotEmbed(
  app: FastifyInstance,
  parentOrigin: string | undefined,
  loadDocument: () => Promise<string>,
): void {
  if (!parentOrigin) return;
  app.addHook("onRequest", async (request, reply) => {
    if (
      !isDotEmbedNavigation(
        parentOrigin,
        request.method,
        request.url,
        request.headers,
      )
    )
      return;
    reply.header("cache-control", "no-store");
    return reply
      .type("text/html; charset=utf-8")
      .send(renderDotEmbedDocument(await loadDocument()));
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
      const existing = reply.getHeader("content-security-policy");
      const policies = (Array.isArray(existing) ? existing : [existing])
        .filter((value) => value != null)
        .map(String);
      reply.header("content-security-policy", [
        ...policies,
        `frame-ancestors 'self' ${parentOrigin}`,
      ]);
    }
    return payload;
  });
}
