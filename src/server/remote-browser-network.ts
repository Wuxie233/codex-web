import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { Duplex } from "node:stream";

const HOP_HEADERS = new Set([
  "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate",
  "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
]);

function headersWithoutHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const excluded = new Set(HOP_HEADERS);
  for (const name of headers.connection?.split(",") ?? []) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function loopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    host === "0.0.0.0" || /^127\./.test(host);
}

function port(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function bypassesUpstream(target: URL): boolean {
  const host = hostname(target).toLowerCase();
  if (loopback(host)) return true;
  return (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").some((entry) => {
    entry = entry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && Number(match[2]) !== port(target))) return false;
    const name = match[1]!.replace(/^\[|\]$/g, "").replace(/^\*?\./, "");
    return host === name || host.endsWith(`.${name}`);
  });
}

function absoluteTarget(raw: string | undefined, upgrade = false): URL {
  if (!raw || /[\s\\]/.test(raw)) throw new Error("Malformed proxy URL");
  const target = new URL(raw);
  if (upgrade && target.protocol === "ws:") target.protocol = "http:";
  if (upgrade && target.protocol === "wss:") target.protocol = "https:";
  if (!/^https?:$/.test(target.protocol) || !target.hostname || target.username || target.password || target.hash)
    throw new Error("Malformed proxy URL");
  return target;
}

function connectTarget(raw: string | undefined): URL {
  if (!raw || !/^(?:\[[0-9a-fA-F:.]+\]|[^:/\\\s?#@]+):\d+$/.test(raw))
    throw new Error("Malformed CONNECT authority");
  const target = new URL(`https://${raw}`);
  if (port(target) < 1 || port(target) > 65535) throw new Error("Invalid CONNECT port");
  return target;
}

/** A browser-only loopback proxy. Each redirect reaches this gate as a new request. */
export class RemoteBrowserNetwork {
  private server?: http.Server;
  private starting?: Promise<string>;
  private disposing?: Promise<void>;
  private disposed = false;
  private listenPort?: number;
  private sockets = new Set<Duplex>();

  constructor(private readonly isBlocked: (url: string) => boolean) {}

  async start(): Promise<string> {
    if (this.disposed) throw new Error("Browser network is closed");
    if (this.starting) return this.starting;
    const server = http.createServer((request, response) => this.forward(request, response));
    this.server = server;
    server.on("connection", (socket) => this.track(socket));
    server.on("connect", (request, socket, head) => this.connect(request, socket, head));
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    server.on("clientError", (_error, socket) => this.rejectSocket(socket, 400));
    this.starting = new Promise<string>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string" || this.disposed) {
          reject(new Error("Browser network is closed"));
          return;
        }
        this.listenPort = address.port;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.starting;
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      await this.starting?.catch(() => undefined);
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.sockets.clear();
    })();
    return this.disposing;
  }

  private track(socket: Duplex): void {
    if (this.disposed) { socket.destroy(); return; }
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    // Individual forwarding operations handle errors; never leave detached sockets unhandled.
    socket.on("error", () => undefined);
  }

  private blocked(target: URL): boolean {
    if (this.disposed || (loopback(hostname(target)) && port(target) === this.listenPort)) return true;
    try { return this.isBlocked(target.origin); } catch { return true; }
  }

  private upstream(target: URL): URL | undefined {
    if (bypassesUpstream(target)) return;
    const configured = target.protocol === "https:"
      ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      : process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (!configured) return;
    const proxy = new URL(configured);
    if (!/^https?:$/.test(proxy.protocol)) throw new Error("Unsupported upstream proxy");
    if (loopback(hostname(proxy)) && port(proxy) === this.listenPort)
      throw new Error("Recursive upstream proxy");
    return proxy;
  }

  private proxyAuthorization(proxy: URL | undefined): http.OutgoingHttpHeaders {
    if (!proxy?.username && !proxy?.password) return {};
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
  }

  private request(target: URL, method: string, headers: http.OutgoingHttpHeaders): http.ClientRequest {
    const proxy = this.upstream(target);
    const destination = proxy ?? target;
    const transport = destination.protocol === "https:" ? https : http;
    const request = transport.request({
      hostname: hostname(destination), port: port(destination), method, agent: false,
      path: proxy ? target.href : `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host, ...this.proxyAuthorization(proxy) },
    });
    request.on("socket", (socket) => this.track(socket));
    request.setTimeout(30_000, () => request.destroy(new Error("Proxy response timed out")));
    return request;
  }

  private forward(request: http.IncomingMessage, response: http.ServerResponse): void {
    let target: URL;
    try { target = absoluteTarget(request.url); } catch { response.writeHead(400).end(); return; }
    if (this.blocked(target)) { response.writeHead(403).end(); return; }
    let outgoing: http.ClientRequest;
    try {
      outgoing = this.request(target, request.method ?? "GET", {
        ...headersWithoutHopHeaders(request.headers), "x-codex-remote-browser": "1",
      });
    } catch { response.writeHead(502).end(); return; }
    const fail = () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    };
    outgoing.on("error", fail);
    request.on("aborted", () => outgoing.destroy());
    request.on("error", () => outgoing.destroy());
    response.on("close", () => outgoing.destroy());
    outgoing.on("upgrade", (_incoming, upstream) => {
      upstream.destroy();
      fail();
    });
    outgoing.on("response", (incoming) => {
      outgoing.setTimeout(0);
      incoming.on("error", fail);
      response.writeHead(incoming.statusCode ?? 502, headersWithoutHopHeaders(incoming.headers));
      // Flush headers immediately: EventSource/fetch must not wait for a body or EOF.
      response.flushHeaders();
      incoming.pipe(response);
    });
    request.pipe(outgoing);
  }

  private connect(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;
    try { target = connectTarget(request.url); } catch { this.rejectSocket(socket, 400); return; }
    if (this.blocked(target)) { this.rejectSocket(socket, 403); return; }
    let proxy: URL | undefined;
    try { proxy = this.upstream(target); } catch { this.rejectSocket(socket, 502); return; }
    if (proxy) {
      const transport = proxy.protocol === "https:" ? https : http;
      const authority = `${target.hostname}:${port(target)}`;
      let outgoing: http.ClientRequest;
      try {
        outgoing = transport.request({
          hostname: hostname(proxy), port: port(proxy), method: "CONNECT", path: authority, agent: false,
          headers: { host: authority, ...this.proxyAuthorization(proxy) },
        });
      } catch { this.rejectSocket(socket, 502); return; }
      outgoing.on("socket", (upstreamSocket) => this.track(upstreamSocket));
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("Proxy connection timed out")));
      outgoing.on("error", () => this.rejectSocket(socket, 502));
      socket.once("close", () => outgoing.destroy());
      outgoing.on("connect", (incoming, upstreamSocket, upstreamHead) => {
        outgoing.setTimeout(0);
        if (incoming.statusCode !== 200) { upstreamSocket.destroy(); this.rejectSocket(socket, 502); return; }
        this.tunnel(socket, upstreamSocket, head, upstreamHead);
      });
      outgoing.end();
      return;
    }
    const upstreamSocket = net.connect({ host: hostname(target), port: port(target) });
    this.track(upstreamSocket);
    upstreamSocket.setTimeout(15_000, () => upstreamSocket.destroy(new Error("Connection timed out")));
    upstreamSocket.once("error", () => this.rejectSocket(socket, 502));
    socket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("connect", () => {
      upstreamSocket.setTimeout(0);
      this.tunnel(socket, upstreamSocket, head, Buffer.alloc(0));
    });
  }

  private tunnel(socket: Duplex, upstream: Duplex, head: Buffer, upstreamHead: Buffer): void {
    if (socket.destroyed || this.disposed) { upstream.destroy(); socket.destroy(); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    this.pipeSockets(socket, upstream, head, upstreamHead);
  }

  private pipeSockets(socket: Duplex, upstream: Duplex, head: Buffer, upstreamHead: Buffer): void {
    this.track(upstream);
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    if (head.length) upstream.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstream).pipe(socket);
  }

  private upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;
    try {
      target = absoluteTarget(request.url, true);
      if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket")
        throw new Error("Unsupported upgrade");
    } catch { this.rejectSocket(socket, 400); return; }
    if (this.blocked(target)) { this.rejectSocket(socket, 403); return; }
    let outgoing: http.ClientRequest;
    try {
      outgoing = this.request(target, "GET", {
        ...headersWithoutHopHeaders(request.headers), connection: "Upgrade", upgrade: "websocket",
        "x-codex-remote-browser": "1",
      });
    } catch { this.rejectSocket(socket, 502); return; }
    socket.once("close", () => outgoing.destroy());
    outgoing.on("error", () => this.rejectSocket(socket, 502));
    outgoing.on("response", (incoming) => {
      incoming.destroy();
      this.rejectSocket(socket, 502);
    });
    outgoing.on("upgrade", (incoming, upstream, upstreamHead) => {
      outgoing.setTimeout(0);
      if (socket.destroyed || this.disposed) { upstream.destroy(); return; }
      const headers = { ...headersWithoutHopHeaders(incoming.headers), connection: "Upgrade", upgrade: "websocket" };
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}\r\n`)).join("")}\r\n`);
      this.pipeSockets(socket, upstream, head, upstreamHead);
    });
    outgoing.end();
  }

  private rejectSocket(socket: Duplex, status: 400 | 403 | 502): void {
    if (socket.destroyed || !socket.writable) return;
    const reason = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }
}
