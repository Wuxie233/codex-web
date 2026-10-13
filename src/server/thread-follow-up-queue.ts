import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

type Message = { id: string; pausedReason?: string; serverSubmission?: any; [key: string]: any };
type Receipt = { phase: "items-pending" | "items-ready" | "send-pending" | "sent"; message: Message; turnId?: string };
type State = { version: 1; queues: Record<string, Message[]>; receipts: Record<string, Receipt> };
export type FollowUpQueueAdapter = {
  readLegacy(): Record<string, Message[]>;
  publish(queues: Record<string, Message[]>): void;
  inspect(hostId: string, threadId: string): Promise<{ activeTurnId?: string; lastTurnId?: string; interrupted: boolean }>;
  inject(hostId: string, threadId: string, items: any[]): Promise<void>;
  send(hostId: string, threadId: string, submission: any, activeTurnId?: string): Promise<{ turnId: string }>;
  settle(threadId: string, submission: any): Promise<void>;
};

/** Durable ownership begins only after the client has materialized native input. */
export class ThreadFollowUpQueue {
  private state: State;
  private hasState = false;
  private adapter?: FollowUpQueueAdapter;
  private running = new Map<string, Promise<any>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly statePath: string) {
    this.state = { version: 1, queues: {}, receipts: {} };
    try {
      this.state = JSON.parse(readFileSync(statePath, "utf8"));
      if (this.state.version !== 1 || !this.state.queues || !this.state.receipts) throw new Error("Invalid follow-up queue state.");
      this.hasState = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  registerAdapter(adapter: FollowUpQueueAdapter): void {
    this.adapter = adapter;
    if (!this.hasState) this.state.queues = structuredClone(adapter.readLegacy());
    for (const [threadId, messages] of Object.entries(this.state.queues)) {
      for (const message of messages) {
        const receipt = this.state.receipts[this.key(threadId, message.id)];
        if (receipt?.phase === "sent") delete message.pausedReason;
        else if (receipt && receipt.phase !== "items-ready")
          message.pausedReason = "Server delivery outcome is unknown. Inspect the task before resending.";
        else if (!message.serverSubmission && !message.pausedReason)
          message.pausedReason = "Waiting for a connected client to prepare the original queued message.";
      }
    }
    this.persist();
    this.timer = setInterval(() => this.wake(), 2000);
    this.timer.unref();
    this.wake();
  }

  close(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  async handle(request: { method: string; params?: any }): Promise<any> {
    const { method, params } = request;
    const threadId = params?.conversationId;
    if (typeof threadId !== "string" || !threadId) throw new Error("Queue requires conversationId.");
    if (method === "read") return { activeDispatch: this.running.has(threadId), messages: structuredClone(this.state.queues[threadId] ?? []),
      deliveries: Object.entries(this.state.receipts).filter(([key, receipt]) => JSON.parse(key)[0] === threadId && receipt.phase === "sent")
        .map(([, receipt]) => ({ hostId: receipt.message.serverSubmission.hostId, threadId, turnId: receipt.turnId,
          uiMetadata: receipt.message.serverSubmission.uiMetadata,
          workspaceCommit: receipt.message.serverSubmission.workspaceCommit,
          pendingWorkspace: receipt.message.serverSubmission.pendingWorkspace })) };
    if (!this.adapter || this.stopped) throw new Error("Server queue is unavailable.");
    if (method === "replace") {
      if (!Array.isArray(params.before) || !Array.isArray(params.messages)) throw new Error("Invalid queue replacement.");
      const messages = this.state.queues[threadId] ?? [];
      if (JSON.stringify(messages) !== JSON.stringify(params.before)) return { conflict: true, messages: structuredClone(messages) };
      if (this.running.has(threadId)) throw new Error("The server is dispatching this queue. Retry the queue edit after dispatch settles.");
      const ids = new Set<string>();
      for (const message of params.messages) {
        if (!message || typeof message.id !== "string" || !message.id || ids.has(message.id)) throw new Error("Invalid queued message ID.");
        ids.add(message.id);
        const receipt = this.state.receipts[this.key(threadId, message.id)];
        if (receipt?.phase === "sent") throw new Error("This queued message was already sent.");
        if (receipt && receipt.phase !== "items-ready") throw new Error("An unknown delivery cannot be edited or replayed.");
        if (message.serverSubmission) this.validate(threadId, message);
        if (receipt?.phase === "items-ready") {
          const { interruptedAcknowledged: _beforeAcknowledged, ...beforeSubmission } = receipt.message.serverSubmission;
          const { interruptedAcknowledged: _afterAcknowledged, ...afterSubmission } = message.serverSubmission ?? {};
          if (JSON.stringify(beforeSubmission) !== JSON.stringify(afterSubmission))
            throw new Error("This message already injected its context. Restore the original prepared message before sending.");
        }
        const previous = messages.find((entry) => entry.id === message.id);
        if (previous?.pausedReason === "Interrupted before the steer was accepted." && !message.pausedReason && message.serverSubmission)
          message.serverSubmission.interruptedAcknowledged = true;
      }
      this.state.queues[threadId] = structuredClone(params.messages);
      this.persist();
      this.wake();
      return { messages: structuredClone(this.state.queues[threadId]) };
    }
    if (method === "sendNow") {
      if (typeof params.messageId !== "string") throw new Error("sendNow requires messageId.");
      if (this.running.has(threadId)) throw new Error("This queue is already being dispatched.");
      return this.launch(threadId, params.messageId);
    }
    throw new Error("Unknown follow-up queue method.");
  }

  private validate(threadId: string, message: Message): void {
    const submission = message.serverSubmission;
    if (!submission || typeof submission.hostId !== "string" || !submission.hostId ||
        submission.request?.threadId !== threadId || submission.request?.clientUserMessageId !== message.id ||
        !Array.isArray(submission.request.input) || submission.request.input.length === 0 ||
        !Array.isArray(submission.responseItems)) throw new Error("Queued input must be fully prepared for its task and message ID.");
  }

  private key(threadId: string, messageId: string): string { return JSON.stringify([threadId, messageId]); }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.statePath);
    this.hasState = true;
    this.adapter?.publish(structuredClone(this.state.queues));
  }

  private wake(): void {
    if (this.stopped || !this.adapter) return;
    for (const [threadId, messages] of Object.entries(this.state.queues)) {
      const head = messages[0];
      if (head?.serverSubmission && !head.pausedReason && !this.running.has(threadId))
        void this.launch(threadId).catch(() => {}); // Failure is persisted on the queue entry.
    }
  }

  private launch(threadId: string, messageId?: string): Promise<any> {
    const pending = this.consume(threadId, messageId).finally(() => this.running.delete(threadId));
    this.running.set(threadId, pending);
    return pending;
  }

  private async consume(threadId: string, messageId?: string): Promise<any> {
    const message = messageId == null ? this.state.queues[threadId]?.[0] : this.state.queues[threadId]?.find((entry) => entry.id === messageId);
    if (!message) return null;
    const key = this.key(threadId, message.id);
    try {
      this.validate(threadId, message);
      const adapter = this.adapter!;
      const submission = message.serverSubmission;
      const receipt = this.state.receipts[key];
      if (receipt?.phase === "sent") {
        await adapter.settle(threadId, receipt.message.serverSubmission);
        this.state.queues[threadId] = (this.state.queues[threadId] ?? []).filter((entry) => entry.id !== message.id);
        this.persist();
        return { status: "sent", messageId: message.id, turnId: receipt.turnId };
      }
      if (receipt && receipt.phase !== "items-ready") throw new Error("This delivery cannot be replayed; inspect its recorded outcome.");
      const status = await adapter.inspect(submission.hostId, threadId);
      if (messageId == null && status.activeTurnId) return null;
      if (messageId == null && status.interrupted && status.lastTurnId === submission.queuedDuringTurnId && !submission.interruptedAcknowledged)
        throw new Error("Interrupted before the steer was accepted.");
      if (status.activeTurnId && submission.responseItems.length > 0)
        throw new Error("App context must wait until the current turn finishes.");
      if (this.stopped) return null;
      if (submission.responseItems.length > 0 && receipt?.phase !== "items-ready") {
        this.state.receipts[key] = { phase: "items-pending", message: structuredClone(message) };
        this.persist();
        await adapter.inject(submission.hostId, threadId, submission.responseItems);
        this.state.receipts[key]!.phase = "items-ready";
        this.persist();
      }
      this.state.receipts[key] = { phase: "send-pending", message: structuredClone(message) };
      this.persist();
      const sent = await adapter.send(submission.hostId, threadId, submission, status.activeTurnId);
      this.state.receipts[key] = { phase: "sent", message: structuredClone(message), turnId: sent.turnId };
      this.persist();
      await adapter.settle(threadId, submission);
      this.state.queues[threadId] = (this.state.queues[threadId] ?? []).filter((entry) => entry.id !== message.id);
      this.persist();
      return { status: "sent", messageId: message.id, turnId: sent.turnId };
    } catch (error) {
      if ((error as { queueDeliveryRejected?: boolean })?.queueDeliveryRejected === true) {
        // A native steer rejection proves no input was accepted. Keep the original
        // message paused; transport failures retain send-pending and never replay.
        if (message.serverSubmission.responseItems.length > 0)
          this.state.receipts[key] = { phase: "items-ready", message: structuredClone(message) };
        else delete this.state.receipts[key];
      }
      message.pausedReason = error instanceof Error ? error.message : String(error);
      this.persist();
      throw error;
    }
  }
}
