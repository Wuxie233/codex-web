import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

// A page owns the renderer; a TCP/WebSocket connection is only its transport.
// Keep a bounded replay log until the page acknowledges delivery.
export class ResumableBridge extends EventEmitter {
  readonly token = randomBytes(32).toString("hex");
  private socket: WebSocket | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private acknowledged = 0;
  private clientSequence = 0;
  private bytes = 0;
  private closed = false;
  private readonly backlog = new Map<number, string>();
  private readonly pendingRequests = new Set<string>();

  constructor(private readonly dispose: () => void) {
    super();
  }

  get readyState(): number {
    return this.closed ? WebSocket.CLOSED : WebSocket.OPEN;
  }

  attach(socket: WebSocket, after?: number): boolean {
    if (
      this.closed ||
      (after !== undefined &&
        (!Number.isSafeInteger(after) ||
          after < this.acknowledged ||
          after > this.sequence))
    )
      return false;
    const previous = this.socket;
    this.socket = socket;
    clearTimeout(this.expiry);
    previous?.close(1000, "Transport replaced");
    if (after !== undefined) this.acknowledge(after);
    socket.on("message", (data) => {
      if (this.socket !== socket || this.closed) return;
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        this.emit("message", data);
        return;
      }
      if (message?.type === "bridge-dispose") {
        this.close();
        return;
      }
      if (message?.type === "bridge-ack") {
        if (
          Number.isSafeInteger(message.sequence) &&
          message.sequence >= this.acknowledged &&
          message.sequence <= this.sequence
        )
          this.acknowledge(message.sequence);
        return;
      }
      if (message?.type === "bridge-ping") {
        socket.send(
          JSON.stringify({ type: "bridge-pong", nonce: message.nonce }),
        );
        return;
      }
      if (message?.bridgeClientSequence !== undefined) {
        const sequence = message.bridgeClientSequence;
        if (!Number.isSafeInteger(sequence) || sequence < 1 ||
            sequence > this.clientSequence + 1) {
          this.close(1008, "Invalid client sequence");
          return;
        }
        if (sequence <= this.clientSequence) {
          socket.send(JSON.stringify({ type: "bridge-client-ack", sequence: this.clientSequence }));
          return;
        }
        // Record receipt before dispatch. Replaced transports can then retry a
        // missing acknowledgement without repeating an accepted operation.
        this.clientSequence = sequence;
      }
      if (message?.type === "ipc-renderer-invoke" ||
          message?.type === "workspace-directory-entries-request") {
        this.pendingRequests.add(message.requestId);
      }
      this.emit("message", data);
      if (message?.bridgeClientSequence !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "bridge-client-ack", sequence: this.clientSequence }));
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket || this.closed) return;
      this.socket = undefined;
      this.emit("detached");
      this.expiry = setTimeout(
        () => this.close(1000, "Resume window expired"),
        60 * 60_000,
      );
      this.expiry.unref();
    });
    socket.on("error", () => socket.close());
    if (after === undefined) {
      socket.send(
        JSON.stringify({ type: "bridge-session", token: this.token, clientSequence: this.clientSequence }),
      );
    } else {
      for (const frame of this.backlog.values()) socket.send(frame);
      socket.send(JSON.stringify({ type: "bridge-resumed", pendingRequests: [...this.pendingRequests], clientSequence: this.clientSequence }));
    }
    return true;
  }

  send(payload: string): void {
    if (this.closed) return;
    const message = JSON.parse(payload);
    if (message.type === "ipc-renderer-invoke-result" ||
        message.type === "workspace-directory-entries-result") {
      this.pendingRequests.delete(message.requestId);
    }
    const frame = JSON.stringify({
      type: "bridge-frame",
      sequence: ++this.sequence,
      payload: message,
    });
    this.bytes += Buffer.byteLength(frame);
    // Missing history must cause a clean cold start, never silent event loss.
    if (this.bytes > 16 * 1024 * 1024 || this.backlog.size >= 50_000) {
      this.close(1000, "Resume history limit exceeded");
      return;
    }
    this.backlog.set(this.sequence, frame);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  close(code = 1000, reason = "Renderer closed"): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiry);
    this.backlog.clear();
    this.pendingRequests.clear();
    this.bytes = 0;
    this.dispose();
    this.socket?.close(code, reason);
    this.socket = undefined;
    this.emit("close");
  }

  private acknowledge(sequence: number): void {
    this.acknowledged = sequence;
    for (const [id, frame] of this.backlog) {
      if (id > sequence) break;
      this.bytes -= Buffer.byteLength(frame);
      this.backlog.delete(id);
    }
  }
}
