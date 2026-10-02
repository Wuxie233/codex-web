import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isIsolatedBrowserRequest } from "./browser-isolation";
import { RemoteBrowser, type RemoteBrowserEvent } from "./remote-browser";

const PREFIX = "/__backend/remote-browser";
const ACTIONS = new Set([
  "open",
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "state",
  "resize",
  "mouse",
  "scroll",
  "key",
  "text",
  "inspect",
  "screenshot",
  "close",
  "transfer",
]);

function route(input: unknown): {
  conversationId: string;
  browserTabId: string;
} {
  if (!input || typeof input !== "object")
    throw new Error("Browser route is required");
  const { conversationId, browserTabId } = input as Record<string, unknown>;
  for (const value of [conversationId, browserTabId]) {
    if (
      typeof value !== "string" ||
      !/^(?:client-new-thread:)?[a-zA-Z0-9_-]{1,160}$/.test(value)
    )
      throw new Error("Invalid browser route");
  }
  return {
    conversationId: conversationId as string,
    browserTabId: browserTabId as string,
  };
}

// Authentication belongs to the existing reverse proxy, just like IPC and /@fs.
// Fetch Metadata and Origin still prevent a visited page from controlling the app.
export function registerRemoteBrowserRoutes(
  app: FastifyInstance,
  browser: RemoteBrowser,
) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
  });
  app.post(
    `${PREFIX}/command`,
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (isIsolatedBrowserRequest(request.headers))
        return reply.code(403).send({ error: "Forbidden" });
      try {
        const input = request.body as Record<string, unknown>;
        const target = route(input);
        if (typeof input.action !== "string" || !ACTIONS.has(input.action))
          return reply.code(400).send({ error: "Unsupported browser command" });
        // Register both schemes: the reverse proxy may terminate TLS.
        for (const scheme of ["http", "https"])
          browser.setAppOrigin(`${scheme}://${request.headers.host}`);
        return await browser.command({ ...input, ...target } as Parameters<
          RemoteBrowser["command"]
        >[0]);
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error ? error.message : "Browser command failed",
        });
      }
    },
  );

  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url!, "http://localhost");
    let unsubscribe: (() => void) | undefined;
    const acknowledgeFrames = url.searchParams.get("frameAck") === "1";
    const frames = new Map<number, { sentAt: number; bytes: number }>();
    let frameWindow = 3;
    let minimumFrameRtt = Infinity;
    let frameBytes = 0;
    let latestFrame: Extract<RemoteBrowserEvent, { type: "frame" }> | undefined;
    const pendingInputs: (
      | Parameters<RemoteBrowser["command"]>[0]
      | { action: "flush"; id: number }
    )[] = [];
    let draining = false;
    const inputController = new AbortController();
    const send = (event: RemoteBrowserEvent) => {
      if (acknowledgeFrames && event.type === "frame") {
        latestFrame = event;
        const bytes = Buffer.byteLength(event.data);
        if (
          frames.size >= frameWindow ||
          (frames.size > 0 && frameBytes + bytes > 512 * 1024) ||
          socket.readyState !== WebSocket.OPEN
        )
          return;
        latestFrame = undefined;
        frames.set(event.sequence, { sentAt: performance.now(), bytes });
        frameBytes += bytes;
      }
      // Drop stale frames under pressure, never the final navigation/closed state.
      if (
        socket.readyState === WebSocket.OPEN &&
        (event.type !== "frame" ||
          acknowledgeFrames ||
          socket.bufferedAmount < 1024 * 1024)
      )
        socket.send(JSON.stringify(event));
    };
    try {
      const target = route(Object.fromEntries(url.searchParams));
      const drain = async () => {
        if (pendingInputs.length > 256) {
          pendingInputs.length = 0;
          send({
            type: "error",
            message: "Browser input queue is full; pending input was cancelled",
          });
          inputController.abort();
          socket.close(1008);
          return;
        }
        if (draining) return;
        draining = true;
        try {
          while (pendingInputs.length && socket.readyState === WebSocket.OPEN) {
            const input = pendingInputs.shift()!;
            if (input.action === "flush") {
              socket.send(
                JSON.stringify({ type: "input-flushed", id: input.id }),
              );
              continue;
            }
            try {
              await browser.command(input, inputController.signal, false);
            } catch (error) {
              send({
                type: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Browser input failed",
              });
            }
          }
        } finally {
          draining = false;
        }
      };
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "frame-ack") {
            const frame = frames.get(message.sequence);
            if (frame) {
              frames.delete(message.sequence);
              frameBytes -= frame.bytes;
              // Fill the network flight time without growing a slow-link backlog.
              minimumFrameRtt = Math.min(
                minimumFrameRtt,
                performance.now() - frame.sentAt,
              );
              frameWindow = Math.min(
                16,
                Math.max(3, Math.ceil((minimumFrameRtt * 60) / 1000) + 1),
              );
              if (latestFrame) send(latestFrame);
            }
            return;
          }
          if (
            message.type === "input-flush" &&
            Number.isSafeInteger(message.id)
          ) {
            pendingInputs.push({ action: "flush", id: message.id });
            void drain();
            return;
          }
          if (
            message.type !== "input" ||
            !["mouse", "scroll", "key", "text"].includes(message.action)
          )
            throw new Error("Unsupported browser input");
          const input = { ...message, ...target };
          const previous = pendingInputs.at(-1);
          // Replace only adjacent moves; button/key transitions retain ordering.
          if (
            input.action === "mouse" &&
            input.eventType === "move" &&
            previous?.action === "mouse" &&
            previous.eventType === "move"
          )
            pendingInputs[pendingInputs.length - 1] = input;
          else if (
            input.action === "scroll" &&
            previous?.action === "scroll" &&
            Number.isFinite(input.deltaX) &&
            Number.isFinite(input.deltaY) &&
            Number.isFinite(previous.deltaX) &&
            Number.isFinite(previous.deltaY) &&
            Math.abs(input.deltaX + previous.deltaX!) <= 10_000 &&
            Math.abs(input.deltaY + previous.deltaY!) <= 10_000
          ) {
            previous.deltaX! += input.deltaX;
            previous.deltaY! += input.deltaY;
          } else pendingInputs.push(input);
          void drain();
        } catch (error) {
          send({
            type: "error",
            message:
              error instanceof Error ? error.message : "Invalid browser input",
          });
        }
      });
      socket.send(JSON.stringify({ type: "input-ready" }));
      unsubscribe = browser.subscribe(
        target.conversationId,
        target.browserTabId,
        send,
      );
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Browser unavailable",
      });
      socket.close(1008);
    }
    socket.once("close", () => {
      inputController.abort();
      pendingInputs.length = 0;
      latestFrame = undefined;
      frames.clear();
      unsubscribe?.();
    });
    socket.on("error", () => socket.close());
  });
  // Upgraded connections must close before Fastify waits for server.close().
  app.addHook("preClose", async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  app.addHook("onClose", async () => browser.dispose());
  return (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (request.url?.split("?", 1)[0] !== `${PREFIX}/stream`) return false;
    if (isIsolatedBrowserRequest(request.headers)) {
      socket.destroy();
      return true;
    }
    try {
      route(
        Object.fromEntries(
          new URL(request.url, "http://localhost").searchParams,
        ),
      );
    } catch {
      socket.destroy();
      return true;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws, request),
    );
    return true;
  };
}
