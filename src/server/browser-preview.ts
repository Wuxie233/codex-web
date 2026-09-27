import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const PREFIX = "/__backend/browser-preview";
const TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 128;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

function headers(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function fileError(reply: FastifyReply, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return reply.code(404).send({ error: "Preview file not found" });
  }
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
    return reply.code(403).send({ error: "Preview file is not readable" });
  }
  return reply.code(500).send({ error: "Unable to read preview file" });
}

function previewPolicy(host: string | undefined, token: string): string | null {
  // Sources are limited to this capability, never the whole app origin. Accept
  // either scheme because the authenticated reverse proxy may terminate TLS.
  if (!host || !/^[a-zA-Z0-9.\-\[\]:]+$/.test(host)) return null;
  let authority: string;
  try {
    authority = new URL(`http://${host}`).host;
  } catch {
    return null;
  }
  const sources = ["http", "https"]
    .map((scheme) => `${scheme}://${authority}${PREFIX}/${token}/`)
    .join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${sources}`,
    `style-src 'unsafe-inline' ${sources}`,
    `img-src data: blob: ${sources}`,
    `font-src data: ${sources}`,
    `media-src blob: ${sources}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "sandbox allow-scripts",
    "frame-ancestors 'self'",
  ].join("; ");
}

function navigationBridge(html: string, token: string): string {
  const script = `<script>(()=>{const prefix=${JSON.stringify(`${PREFIX}/${token}/`)};document.addEventListener('click',event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor||anchor.hasAttribute('download'))return;let url;try{url=new URL(anchor.getAttribute('href'),location.href)}catch{return}if(!/^https?:$/.test(url.protocol))return;if(url.origin===location.origin&&!url.pathname.startsWith(prefix))return;event.preventDefault();parent.postMessage({type:'codex-preview-navigate',url:url.href},'*')},true)})();</script>`;
  // Keep the preamble/doctype first so adding the bridge does not change layout
  // mode. Searching for <head> can instead match a comment or script string.
  const preamble =
    /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>)?/i.exec(
      html,
    );
  const offset = preamble?.[0].length ?? 0;
  return html.slice(0, offset) + script + html.slice(offset);
}

export function registerBrowserPreviewRoutes(app: FastifyInstance): void {
  const previews = new Map<string, { root: string; expiresAt: number }>();
  app.post<{ Body: { path?: unknown } }>(PREFIX, async (request, reply) => {
    headers(reply);
    const input = request.body?.path;
    if (
      typeof input !== "string" ||
      !path.isAbsolute(input) ||
      input.includes("\0") ||
      !/\.html?$/i.test(input)
    ) {
      return reply
        .code(400)
        .send({ error: "An absolute HTML file path is required" });
    }
    let file;
    try {
      const canonical = await realpath(input);
      file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await file.stat()).isFile()) {
        return reply
          .code(400)
          .send({ error: "Only regular HTML files can be previewed" });
      }
      const now = Date.now();
      for (const [key, entry] of previews) {
        if (entry.expiresAt <= now) previews.delete(key);
      }
      while (previews.size >= MAX_PREVIEWS)
        previews.delete(previews.keys().next().value!);
      const token = randomBytes(24).toString("hex");
      previews.set(token, {
        root: path.dirname(canonical),
        expiresAt: now + TTL_MS,
      });
      return {
        url: `${PREFIX}/${token}/${encodeURIComponent(path.basename(canonical))}`,
        path: canonical,
      };
    } catch (error) {
      return fileError(reply, error);
    } finally {
      await file?.close().catch(() => {});
    }
  });

  app.get<{ Params: { token: string; "*": string } }>(
    `${PREFIX}/:token/*`,
    async (request, reply) => {
      headers(reply);
      const { token } = request.params;
      const entry = previews.get(token);
      if (!entry)
        return reply.code(404).send({ error: "Preview not found or expired" });
      if (entry.expiresAt <= Date.now()) {
        previews.delete(token);
        return reply
          .code(410)
          .send({ error: "Preview expired; reopen the HTML file" });
      }
      const resource = request.params["*"];
      if (
        !resource ||
        resource.includes("\0") ||
        resource.includes("\\") ||
        resource.split("/").includes("..")
      ) {
        return reply
          .code(403)
          .send({ error: "Preview path is outside its directory" });
      }
      const target = path.resolve(entry.root, resource);
      if (!inside(entry.root, target))
        return reply
          .code(403)
          .send({ error: "Preview path is outside its directory" });
      const policy = previewPolicy(request.headers.host, token);
      if (!policy)
        return reply.code(400).send({ error: "Invalid preview host" });
      let file;
      try {
        const canonical = await realpath(target);
        if (!inside(entry.root, canonical))
          return reply
            .code(403)
            .send({ error: "Preview path is outside its directory" });
        file = await open(
          canonical,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        // On Linux, validate the opened descriptor too: directory symlinks can be
        // changed between resolving a path and opening it.
        if (
          process.platform === "linux" &&
          !inside(entry.root, await realpath(`/proc/self/fd/${file.fd}`))
        ) {
          return reply
            .code(403)
            .send({ error: "Preview path is outside its directory" });
        }
        if (!(await file.stat()).isFile())
          return reply.code(404).send({ error: "Preview file not found" });
        const extension = path.extname(canonical).toLowerCase();
        reply.header("Content-Security-Policy", policy);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.type(MIME[extension] ?? "application/octet-stream");
        if (extension === ".html" || extension === ".htm") {
          return reply.send(
            navigationBridge(await file.readFile("utf8"), token),
          );
        }
        const stream = file.createReadStream();
        file = undefined; // The stream owns and closes its descriptor.
        return reply.send(stream);
      } catch (error) {
        return fileError(reply, error);
      } finally {
        await file?.close().catch(() => {});
      }
    },
  );
}
