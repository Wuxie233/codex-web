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
        return reply
          .code(400)
          .send({
            error:
              error instanceof Error ? error.message : "Browser command failed",
          });
      }
    },
  );

  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url!, "http://localhost");
    let unsubscribe: (() => void) | undefined;
    const send = (event: RemoteBrowserEvent) => {
      // Drop stale frames under pressure, never the final navigation/closed state.
      if (
        socket.readyState === WebSocket.OPEN &&
        (event.type !== "frame" || socket.bufferedAmount < 1024 * 1024)
      )
        socket.send(JSON.stringify(event));
    };
    try {
      const target = route(Object.fromEntries(url.searchParams));
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
    socket.once("close", () => unsubscribe?.());
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
