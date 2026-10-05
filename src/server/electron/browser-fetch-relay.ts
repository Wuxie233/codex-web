import { request } from "node:http";
import { Readable } from "node:stream";

const STATSIG_BOOTSTRAP_URL =
  "https://chatgpt.com/backend-api/wham/statsig/bootstrap";
const MAX_BOOTSTRAP_BYTES = 1024 * 1024;

async function readBootstrapBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = () => {
    // Cancellation wakes a pending read; the signal reason remains authoritative.
    void reader.cancel(request.signal.reason).catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > MAX_BOOTSTRAP_BYTES) {
        await reader.cancel();
        throw new TypeError("Statsig bootstrap body exceeds 1 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Read-only experimental transport, including the upstream bootstrap read POST. */
export function isBrowserRelayTarget(input: string | URL | Request): boolean {
  const url = new URL(input instanceof Request ? input.url : input);
  return (
    url.origin === "https://chatgpt.com" &&
    (url.pathname === "/backend-api" ||
      url.pathname.startsWith("/backend-api/"))
  );
}

export async function fetchThroughBrowserRelay(
  socketPath: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const original = new Request(input, init);
  const suppliedUrl = input instanceof Request ? input.url : String(input);
  const bootstrapRead =
    original.method === "POST" &&
    suppliedUrl === STATSIG_BOOTSTRAP_URL &&
    original.url === STATSIG_BOOTSTRAP_URL;
  if (
    !isBrowserRelayTarget(original) ||
    (original.method !== "GET" && !bootstrapRead)
  ) {
    throw new TypeError(
      "Browser relay only permits backend GET or the exact Statsig bootstrap read POST",
    );
  }
  if (
    bootstrapRead &&
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"\r\n]+"|[^;\s]+))?\s*$/i.test(
      original.headers.get("content-type") ?? "",
    )
  ) {
    throw new TypeError("Statsig bootstrap requires application/json");
  }
  original.signal.throwIfAborted();
  const body = bootstrapRead ? await readBootstrapBody(original) : undefined;
  original.signal.throwIfAborted();
  const url = new URL(original.url);
  const headers = Object.fromEntries(original.headers);
  // Transport metadata is consumed by the Unix relay, never forwarded upstream.
  headers.host = "chatgpt.com";
  headers["x-codex-relay-redirect"] = original.redirect;
  return new Promise<Response>((resolve, reject) => {
    const outbound = request({
      socketPath,
      // Each request owns its Unix connection through response cancellation.
      // Avoid the Node 22 pooled-socket EPIPE race after a large POST completes.
      agent: false,
      method: original.method,
      path: `${url.pathname}${url.search}`,
      headers,
    });
    let incoming: import("node:http").IncomingMessage | undefined;
    const abort = () => {
      const reason = original.signal.reason;
      const error =
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted", "AbortError");
      incoming?.destroy(error);
      outbound.destroy(error);
      reject(reason);
    };
    const cleanup = () => original.signal.removeEventListener("abort", abort);
    original.signal.addEventListener("abort", abort, { once: true });
    outbound.on("error", (error) => {
      cleanup();
      reject(error);
    });
    outbound.on("response", (response) => {
      incoming = response;
      response.once("close", cleanup);
      response.once("error", reject);
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(
          response.rawHeaders[i]!,
          response.rawHeaders[i + 1]!,
        );
      }
      const status = response.statusCode!;
      const noBody = status === 204 || status === 205 || status === 304;
      try {
        const body = noBody
          ? null
          : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
        if (noBody) response.resume();
      } catch (error) {
        response.destroy();
        cleanup();
        reject(error);
      }
    });
    if (original.signal.aborted) abort();
    else outbound.end(body);
  });
}
