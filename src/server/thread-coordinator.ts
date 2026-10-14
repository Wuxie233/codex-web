import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ThreadCreations, UserCreationCommand } from "./thread-create.js";
import type { ThreadForks } from "./thread-fork.js";
import type { ThreadHandoffs } from "./thread-handoff.js";
import type { ThreadManagementService } from "./thread-management.js";

export type ThreadCoordinatorOptions = {
  recovery?: Pick<import("./quota-recovery.js").QuotaRecovery, "readTask">;
  forks?: ThreadForks;
  handoffs?: ThreadHandoffs;
  management?: ThreadManagementService;
};

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

class CoordinatorError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Shared command endpoint. The transport, not request parameters, owns identity. */
export class ThreadCoordinator {
  private server?: Server;
  private sockets = new Set<Socket>();
  private ready = false;

  constructor(private readonly creations: ThreadCreations, private readonly options: ThreadCoordinatorOptions = {}) {}

  async handle(clientIdentity: string, request: { method: string; params?: any }, signal = new AbortController().signal): Promise<any> {
    signal.throwIfAborted();
    if (clientIdentity !== "codex-web" && clientIdentity !== "codecarry")
      throw new CoordinatorError(-32600, "Unsupported coordinator client identity.");
    if (request.method === "codexWeb/capabilities") return {
      protocolVersion: 1, threadCreation: true, recoveryRead: !!this.options.recovery,
      threadFork: !!this.options.forks, threadHandoff: !!this.options.handoffs,
      threadArchive: !!this.options.management,
    };
    const methods = ["codexWeb/recovery/read", "codexWeb/thread/create", "codexWeb/thread/creation/read",
      "codexWeb/thread/fork", "codexWeb/thread/fork/read",
      "codexWeb/thread/handoff", "codexWeb/thread/handoff/read",
      "codexWeb/thread/archive", "codexWeb/thread/archive/read"];
    if (!methods.includes(request.method)) throw new CoordinatorError(-32601, "Unknown coordinator method.");
    const params = request.params;
    if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.hostId !== "string" || !params.hostId.trim())
      throw new CoordinatorError(-32602, "Coordinator requires a nonempty hostId.");
    if (request.method === "codexWeb/recovery/read") {
      if (!this.options.recovery) throw new CoordinatorError(-32601, "Recovery is unavailable.");
      if (typeof params.threadId !== "string" || !params.threadId.trim() ||
          typeof params.turnId !== "string" || !params.turnId.trim())
        throw new CoordinatorError(-32602, "Recovery requires threadId and turnId.");
      return this.options.recovery.readTask(params.hostId, params.threadId, params.turnId);
    }
    if (request.method === "codexWeb/thread/create") {
      // createUser owns validation, durable enqueue and subsequent recovery. A
      // disconnected client can read this requestId without resending a command.
      return this.creations.createUser(params.hostId, params.command as UserCreationCommand, signal, clientIdentity);
    }
    if (typeof params.requestId !== "string" || !params.requestId.trim())
      throw new CoordinatorError(-32602, "Coordinator requires requestId.");
    switch (request.method) {
      case "codexWeb/thread/creation/read":
        return this.creations.readUser(params.hostId, params.requestId, clientIdentity, params.includeMetadata === true);
      case "codexWeb/thread/fork":
      case "codexWeb/thread/fork/read": {
        const forks = this.options.forks;
        if (!forks) throw new CoordinatorError(-32601, "Thread fork coordinator is unavailable.");
        return request.method.endsWith("/read")
          ? forks.readUser(params.hostId, params.requestId, clientIdentity)
          : forks.forkUser(params.hostId, params.requestId, params.command, signal, clientIdentity);
      }
      case "codexWeb/thread/handoff":
      case "codexWeb/thread/handoff/read": {
        const handoffs = this.options.handoffs;
        if (!handoffs) throw new CoordinatorError(-32601, "Thread handoff coordinator is unavailable.");
        return request.method.endsWith("/read")
          ? handoffs.readUser(params.hostId, params.requestId, clientIdentity)
          : handoffs.handoffUser(params.hostId, params.requestId, params.command, signal, clientIdentity);
      }
      case "codexWeb/thread/archive":
      case "codexWeb/thread/archive/read": {
        const management = this.options.management;
        if (!management) throw new CoordinatorError(-32601, "Thread archive coordinator is unavailable.");
        if (request.method.endsWith("/read")) return management.readArchiveUser(params.hostId, params.requestId, clientIdentity);
        if (!params.command || typeof params.command !== "object" || Array.isArray(params.command))
          throw new CoordinatorError(-32602, "Archive command must be an object.");
        return management.archiveUser(params.hostId, { ...params.command, requestId: params.requestId }, signal, clientIdentity);
      }
    }
  }

  async listen(socketPath: string): Promise<void> {
    if (this.server) throw new Error("Thread coordinator is already listening.");
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await this.removeStaleSocket(socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", listening); reject(error); };
        const listening = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", listening);
        // Unix bind runs synchronously in listen(). Restrict the initial inode,
        // too, so other users cannot queue a connection before chmod completes.
        const previousMask = process.umask();
        try {
          process.umask(previousMask | 0o177);
          server.listen(socketPath);
        } finally { process.umask(previousMask); }
      });
      // Connections arriving before the permission change are rejected by accept.
      await chmod(socketPath, 0o600);
      this.ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async removeStaleSocket(socketPath: string): Promise<void> {
    let existing;
    try { existing = await lstat(socketPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!existing.isSocket()) throw new Error("Coordinator path exists and is not a socket.");
    if (process.getuid && existing.uid !== process.getuid()) throw new Error("Coordinator socket is owned by another user.");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); reject(new Error("Coordinator socket is already active.")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy();
        if (error.code === "ECONNREFUSED") resolve(); else reject(error);
      });
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Coordinator socket status could not be determined.")); });
    });
    const current = await lstat(socketPath);
    if (!current.isSocket() || current.dev !== existing.dev || current.ino !== existing.ino)
      throw new Error("Coordinator socket changed during stale socket inspection.");
    await unlink(socketPath);
  }

  private accept(socket: Socket): void {
    if (!this.ready) { socket.destroy(); return; }
    this.sockets.add(socket);
    const abort = new AbortController();
    let pending = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { abort.abort(); this.sockets.delete(socket); });
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) {
          if (pending.length > MAX_FRAME_BYTES) socket.destroy();
          return;
        }
        if (newline > MAX_FRAME_BYTES) { socket.destroy(); return; }
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        void this.respond(socket, frame, abort.signal);
      }
    });
  }

  private async respond(socket: Socket, frame: Buffer, signal: AbortSignal): Promise<void> {
    let id: string | number | null = null;
    let response: any;
    try {
      let request;
      try { request = JSON.parse(frame.toString("utf8")); }
      catch { throw new CoordinatorError(-32700, "Invalid JSON."); }
      if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" ||
          typeof request.method !== "string" || !(typeof request.id === "string" || typeof request.id === "number" || request.id === null))
        throw new CoordinatorError(-32600, "Invalid coordinator JSON-RPC request.");
      id = request.id;
      if (request.clientIdentity !== "codecarry")
        throw new CoordinatorError(-32600, "Unix coordinator requires the codecarry client identity.");
      response = { jsonrpc: "2.0", id, result: await this.handle("codecarry", request, signal) };
    } catch (error) {
      response = { jsonrpc: "2.0", id, error: {
        code: error instanceof CoordinatorError ? error.code : -32000,
        message: error instanceof Error ? error.message : "Coordinator command failed.",
      } };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }
}
