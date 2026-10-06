import { request } from "node:http";
import { Readable } from "node:stream";

const STATSIG_BOOTSTRAP_URL =
  "https://chatgpt.com/backend-api/wham/statsig/bootstrap";
const MAX_BODY_BYTES = 1024 * 1024;

async function readRelayBody(request: Request): Promise<Buffer> {
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
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new TypeError("Browser relay body exceeds 1 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function validateTextMessage(body: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new TypeError("Dot message requires valid UTF-8 JSON");
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "content",
          "request_id",
          "idempotency_token",
          "app_attest_challenge",
          "page_context",
          "reply_to",
        ].includes(key),
    )
  ) {
    throw new TypeError("Dot message contains unsupported fields");
  }
  function fail(reason: string): never {
    // Fixed reason codes only: never include message, identifier, or token values.
    throw new TypeError(`Dot text message rejected: ${reason}`);
  }
  const content = value.content;
  if (!object(content)) return fail("content_type");
  if (
    Object.keys(content).some((key) => !["text", "attachments"].includes(key))
  )
    fail("content_fields");
  if (typeof content.text !== "string" || content.text.trim().length === 0)
    fail("text_type_or_empty");
  if (
    content.attachments !== undefined &&
    (!Array.isArray(content.attachments) || content.attachments.length !== 0)
  )
    fail("attachments_not_empty");
  if (
    typeof value.request_id !== "string" ||
    value.request_id.trim().length === 0
  )
    fail("request_id_type_or_empty");
  if (value.idempotency_token !== value.request_id)
    fail("idempotency_mismatch");
  // The native Dot page supplies its current page identifier automatically.
  if (
    value.page_context != null &&
    (!object(value.page_context) ||
      Object.keys(value.page_context).length !== 1 ||
      (value.page_context.page_id !== null &&
        (typeof value.page_context.page_id !== "string" ||
          value.page_context.page_id.trim().length === 0)))
  )
    fail("page_context_shape");
  if (value.reply_to != null) fail("reply_to_not_supported");
  if (
    value.app_attest_challenge !== undefined &&
    (typeof value.app_attest_challenge !== "string" ||
      value.app_attest_challenge.length === 0)
  )
    fail("attestation_type_or_empty");
}

function validateReadReceipt(body: Buffer): void {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(body),
  );
  // Native latestMessage.createdAt is a server timestamp string, not epoch ms.
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.last_read_at !== "string" ||
    !value.last_read_at.trim() ||
    !Number.isFinite(Date.parse(value.last_read_at))
  )
    throw new TypeError(
      "Dot read receipt requires only a valid last_read_at timestamp string",
    );
}

/** Read-only by default; one existing room can explicitly opt into text messaging. */
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
  const roomId = process.env.CODEX_DOT_MESSAGE_ROOM_ID;
  const roomBase =
    roomId && /^[A-Za-z0-9_-]+$/.test(roomId)
      ? `https://chatgpt.com/backend-api/messaging/rooms/${roomId}`
      : null;
  const exactRoomPost = (suffix: string) =>
    roomBase !== null &&
    original.method === "POST" &&
    suppliedUrl === `${roomBase}/${suffix}` &&
    original.url === suppliedUrl;
  const textMessage = exactRoomPost("messages");
  const roomLive = exactRoomPost("live");
  const roomRead = exactRoomPost("read");
  const roomHeartbeat = exactRoomPost("responding_heartbeat");
  if (
    !isBrowserRelayTarget(original) ||
    (original.method !== "GET" &&
      !bootstrapRead &&
      !textMessage &&
      !roomLive &&
      !roomRead &&
      !roomHeartbeat)
  ) {
    throw new TypeError(
      "Browser relay only permits backend GET, exact Statsig bootstrap, or opted-in room text/live/read/heartbeat POST",
    );
  }
  if (
    (bootstrapRead || textMessage || roomRead) &&
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"\r\n]+"|[^;\s]+))?\s*$/i.test(
      original.headers.get("content-type") ?? "",
    )
  ) {
    throw new TypeError("Browser relay JSON POST requires application/json");
  }
  original.signal.throwIfAborted();
  const body =
    original.method === "POST" ? await readRelayBody(original) : undefined;
  if (textMessage) validateTextMessage(body!);
  if (roomRead) validateReadReceipt(body!);
  if ((roomLive || roomHeartbeat) && body!.length !== 0)
    throw new TypeError(
      "Dot live subscription or responding heartbeat requires an empty body",
    );
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
