import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type CreationPlan = {
  hostId: string;
  cwd: string;
  workspaceRoots: string[];
  projectId?: string;
  worktree?: Record<string, any>;
  threadParams: Record<string, any>;
  turnParams: Record<string, any>;
  [key: string]: any;
};
export type CreationSource =
  | { kind?: "agent"; hostId: string; threadId: string }
  | { kind: "user"; hostId: string; clientId: string };
export type UserCreationCommand = {
  requestId: string;
  target: Record<string, any>;
  input: Record<string, any>[];
  title?: string;
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  permissions?: Record<string, any>;
  nativeParams?: Record<string, any>;
};
export type UserCreationStatus = {
  requestId: string;
  clientThreadId: string;
  status: "queued" | "created" | "failed" | "outcome-unknown";
  phase: Phase;
  hostId?: string;
  threadId?: string;
  turnId?: string;
  error?: string;
  uiMetadata?: Record<string, any>;
};
export type CreationNotification = {
  operationId: string;
  notificationId: string;
  hostId?: string;
  threadId?: string;
  status: "created" | "failed" | "outcome-unknown";
  error?: string;
};
export type CreationAdapter = {
  /** Read-only preparation: resolve project, configuration, permissions and tools. */
  prepare(args: any, source: CreationSource, operationId: string): Promise<CreationPlan>;
  createWorktree(plan: CreationPlan, operationId: string): Promise<{ cwd: string; workspaceRoots: string[] }>;
  startThread(plan: CreationPlan, operationId: string): Promise<{ threadId: string }>;
  /** Idempotent metadata assignment, including source-task relationship. */
  bindThread(plan: CreationPlan, threadId: string, source: CreationSource): Promise<void>;
  injectItems?(plan: CreationPlan, threadId: string): Promise<void>;
  reconcileInjectedItems?(plan: CreationPlan, threadId: string): Promise<boolean>;
  /** Readiness checks must finish before recording a possibly dispatched turn. */
  prepareTurn?(plan: CreationPlan, threadId: string): Promise<void>;
  startTurn(plan: CreationPlan, threadId: string, operationId: string): Promise<{ turnId: string }>;
  setGoal?(plan: CreationPlan, threadId: string): Promise<void>;
  reconcileGoal?(plan: CreationPlan, threadId: string): Promise<boolean>;
  notify?(source: CreationSource, summary: CreationNotification): Promise<{ turnId: string }>;
  reconcileNotification?(source: CreationSource, summary: CreationNotification): Promise<{ turnId: string } | null>;
  reconcileWorktree?(plan: CreationPlan, operationId: string): Promise<{ cwd: string; workspaceRoots: string[] } | null>;
  reconcileThread?(plan: CreationPlan, operationId: string): Promise<{ threadId: string } | null>;
  reconcileTurn?(plan: CreationPlan, threadId: string, operationId: string): Promise<{ turnId: string } | null>;
};
type Result = { success: boolean; contentItems: any[] };
type Phase = "queued" | "prepared" | "worktree-pending" | "workspace-ready" | "thread-pending" | "thread-ready" | "bound" | "items-pending" | "items-ready" | "turn-pending" | "turn-ready" | "goal-pending" | "goal-ready" | "complete" | "failed";
type Creation = {
  operationId: string;
  fingerprint: string;
  source: CreationSource;
  args: any;
  phase: Phase;
  plan?: CreationPlan;
  threadId?: string;
  turnId?: string;
  error?: string;
  requestId?: string;
  queuedReturned?: boolean;
  notifications?: Record<string, { status: "pending" | "sent" | "unknown"; summary: CreationNotification; turnId?: string; error?: string }>;
};
const result = (success: boolean, value: unknown): Result => ({
  success, contentItems: [{ type: "inputText", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** Owns creation receipts and the SPEC-to-ticket relation independently of windows. */
export class ThreadCreations {
  private adapter?: CreationAdapter;
  private creations: Record<string, Creation> = {};
  private running = new Map<string, Promise<void>>();

  constructor(private statePath: string) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.version !== 1 || !state.creations || typeof state.creations !== "object")
        throw new Error("Invalid thread creation state");
      this.creations = state.creations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  registerAdapter(adapter: CreationAdapter): void {
    this.adapter = adapter;
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, creations: this.creations }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  resolve(clientThreadId: string): { threadId?: string; hostId?: string; status: Phase; error?: string; notifications?: Creation["notifications"] } | null {
    const record = Object.values(this.creations).find((entry) => entry.operationId === clientThreadId);
    return record ? { threadId: record.threadId, hostId: record.plan?.hostId, status: record.phase, error: record.error, notifications: record.notifications } : null;
  }

  /** Resolve durable queued IDs before forwarding to the normal thread query handler. */
  async handleQuery(sourceHostId: string, params: any, signal: AbortSignal): Promise<{ params: any } | { result: Result }> {
    try {
      signal.throwIfAborted();
      if (params.tool !== "read_thread" && params.tool !== "wait_threads") return { params };
      const args = typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments;
      const targets = params.tool === "read_thread" ? [args] : args?.targets;
      if (!Array.isArray(targets) || !targets.some((target: any) => typeof target?.threadId === "string" && target.threadId.startsWith("pending-create-")))
        return { params };
      if (targets.length < 1 || targets.length > 8) throw new Error("wait_threads requires 1 to 8 targets.");
      const timeout = params.tool === "read_thread" ? 0 : args.timeoutMs ?? 120000;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 120000) throw new Error("Invalid wait_threads timeoutMs.");
      const deadline = Date.now() + timeout;
      for (;;) {
        signal.throwIfAborted();
        const creations = targets.filter((target: any) => target.threadId?.startsWith("pending-create-")).map((target: any) => {
          const creation = this.resolve(target.threadId);
          if (!creation) throw new Error(`Unknown queued creation: ${target.threadId}`);
          if (target.hostId != null && creation.hostId != null && target.hostId !== creation.hostId)
            throw new Error(`Queued creation host mismatch: ${target.threadId}`);
          return { clientThreadId: target.threadId, ...creation };
        });
        if (creations.every((creation: any) => creation.status === "complete")) {
          const mapped = targets.map((target: any) => {
            const creation = creations.find((entry: any) => entry.clientThreadId === target.threadId);
            return creation ? { ...target, threadId: creation.threadId, hostId: creation.hostId } : target;
          });
          return { params: { ...params, arguments: params.tool === "read_thread" ? mapped[0] : {
            ...args, targets: mapped, timeoutMs: Math.max(0, deadline - Date.now()),
          } } };
        }
        const attention = creations.find((creation: any) => creation.error || creation.status === "failed");
        // A mixed batch must return its mapping promptly so a ready task is never hidden
        // behind another task's workspace setup. The caller can continue waiting with it.
        const mixed = creations.length !== targets.length || creations.some((creation: any) => creation.status === "complete");
        if (attention || mixed || Date.now() >= deadline) return { result: result(true, {
          timedOut: !attention && !mixed && params.tool === "wait_threads",
          wake: attention ? { reason: "creationNeedsAttention", clientThreadId: attention.clientThreadId } : mixed ? { reason: "creationProgress" } : null,
          creations,
          targets: targets.map((target: any) => {
            const creation = creations.find((entry: any) => entry.clientThreadId === target.threadId);
            return creation?.status === "complete" ? { ...target, threadId: creation.threadId, hostId: creation.hostId } : target;
          }),
        }) };
        await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    } catch (error) {
      return { result: result(false, error instanceof Error ? error.message : String(error)) };
    }
  }

  private response(record: Creation): Result {
    const common = { clientThreadId: record.operationId, hostId: record.plan?.hostId, threadId: record.threadId };
    if (record.phase === "complete") return result(true, { ...common, status: "created", turnId: record.turnId });
    if (record.phase === "failed") return result(false, { ...common, status: "failed", error: record.error });
    if (record.error) return result(false, { ...common, status: "outcome-unknown", error: record.error,
      message: "Creation may have taken effect. Do not repeat with a new call ID; inspect this operation before dispatching again." });
    return result(true, { ...common, status: "queued" });
  }

  async create(sourceHostId: string, params: { threadId: string; callId: string; arguments: any }, signal: AbortSignal): Promise<Result> {
    try {
      signal.throwIfAborted();
      const args = typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments;
      if (!args || typeof args !== "object" || typeof args.prompt !== "string" || !args.prompt.trim() ||
          !args.target || typeof args.target !== "object" || !params.threadId || !params.callId)
        return result(false, "create_thread requires a nonempty prompt, target and trusted calling task identity.");
      if (!this.adapter) return result(false, "Server thread creation adapter is not ready.");
      const key = JSON.stringify([sourceHostId, params.threadId, params.callId]);
      const fingerprint = createHash("sha256").update(JSON.stringify(args)).digest("hex");
      let record = this.creations[key];
      if (record && record.fingerprint !== fingerprint) return result(false, "create_thread call ID was reused with different arguments.");
      if (!record) {
        record = { operationId: `pending-create-${randomUUID()}`, fingerprint,
          source: { kind: "agent", hostId: sourceHostId, threadId: params.threadId }, args, phase: "queued" };
        this.creations[key] = record;
        this.save();
      }
      await this.dispatch(record);
      if (record.phase !== "complete" && record.phase !== "failed" && !record.error) {
        record.queuedReturned = true;
        this.save();
      }
      return this.response(record);
    } catch (error) {
      return result(false, error instanceof Error ? error.message : String(error));
    }
  }

  private async dispatch(record: Creation): Promise<void> {
    const pending = this.launch(record);
    // Creation belongs to the daemon after durable enqueue, even if its caller disconnects.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private userStatus(record: Creation, includeMetadata = false): UserCreationStatus {
    return {
      requestId: record.requestId!,
      clientThreadId: record.operationId,
      status: record.phase === "complete" ? "created" : record.phase === "failed" ? "failed" : record.error ? "outcome-unknown" : "queued",
      phase: record.phase,
      hostId: record.plan?.hostId,
      threadId: record.threadId,
      turnId: record.turnId,
      error: record.error,
      ...(includeMetadata && record.source.kind === "user" ? { uiMetadata: Object.fromEntries(
        ["attachments", "commentAttachments", "localTurnMetadata", "mcpAppModelContextAttachments"]
          .filter((key) => Object.prototype.hasOwnProperty.call(record.args.nativeParams ?? {}, key))
          .map((key) => [key, record.args.nativeParams[key]]),
      ) } : {}),
    };
  }

  /** clientId is assigned by the authenticated transport, never accepted from command data. */
  async createUser(sourceHostId: string, command: UserCreationCommand, signal: AbortSignal, clientId = "codex-web"): Promise<UserCreationStatus> {
    signal.throwIfAborted();
    if (!this.adapter) throw new Error("Server thread creation adapter is not ready.");
    if (!command || typeof command.requestId !== "string" || !command.requestId.trim() ||
        !command.target || typeof command.target !== "object" || Array.isArray(command.target) ||
        !Array.isArray(command.input) || (command.input.length === 0 &&
          command.nativeParams?.toolOutput == null && !(Array.isArray(command.nativeParams?.responseItems) && command.nativeParams.responseItems.length > 0)))
      throw new Error("Thread creation requires requestId, target and native input, tool output or response items.");
    const supported = new Set(["requestId", "target", "input", "title", "model", "effort", "serviceTier", "permissions", "nativeParams"]);
    if (Object.keys(command).some((key) => !supported.has(key)))
      throw new Error("Unsupported user thread creation field.");
    const { requestId, ...args } = command;
    const key = JSON.stringify(["user", clientId, sourceHostId, requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    let record = this.creations[key];
    if (record && record.fingerprint !== fingerprint)
      throw new Error("Thread creation requestId was reused with different arguments.");
    if (!record) {
      record = { operationId: `pending-create-${randomUUID()}`, requestId, fingerprint,
        source: { kind: "user", hostId: sourceHostId, clientId }, args, phase: "queued" };
      this.creations[key] = record;
      this.save();
    }
    await this.dispatch(record);
    return this.userStatus(record);
  }

  readUser(sourceHostId: string, requestId: string, clientId = "codex-web", includeMetadata = false): UserCreationStatus | null {
    const record = this.creations[JSON.stringify(["user", clientId, sourceHostId, requestId])];
    return record ? this.userStatus(record, includeMetadata) : null;
  }

  async recover(): Promise<void> {
    if (!this.adapter) throw new Error("Server thread creation adapter is not ready.");
    await Promise.all(Object.values(this.creations).map((record) => this.launch(record)));
  }

  private launch(record: Creation): Promise<void> {
    const existing = this.running.get(record.operationId);
    if (existing) return existing;
    const work = this.advance(record).then(() => this.notify(record)).finally(() => this.running.delete(record.operationId));
    this.running.set(record.operationId, work);
    return work;
  }

  private async notify(record: Creation): Promise<void> {
    if (record.source.kind === "user" || !record.queuedReturned || !this.adapter?.notify) return;
    const status = record.phase === "complete" ? "created" : record.phase === "failed" ? "failed" : record.error ? "outcome-unknown" : null;
    if (!status) return;
    const notifications = record.notifications ??= {};
    let receipt = notifications[status];
    if (!receipt) {
      receipt = notifications[status] = { status: "pending", summary: {
        operationId: record.operationId,
        notificationId: `${record.operationId}:${status}`,
        hostId: record.plan?.hostId,
        threadId: record.threadId,
        status,
        ...(record.error ? { error: record.error } : {}),
      } };
      this.save();
    }
    if (receipt.status === "sent") return;
    try {
      if (receipt.status === "unknown") {
        const found = await this.adapter.reconcileNotification?.(record.source, receipt.summary);
        if (!found) return;
        receipt.turnId = found.turnId;
      } else {
        // Persist ambiguity before dispatch. A restart may only read back this send.
        receipt.status = "unknown";
        this.save();
        receipt.turnId = (await this.adapter.notify(record.source, receipt.summary)).turnId;
      }
      receipt.status = "sent";
      delete receipt.error;
      this.save();
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      this.save();
    }
  }

  private async advance(record: Creation): Promise<void> {
    const adapter = this.adapter!;
    try {
      if (record.phase === "queued") {
        record.plan = await adapter.prepare(record.args, record.source, record.operationId);
        record.phase = "prepared";
        this.save();
      }
      const plan = record.plan!;
      if (record.phase === "worktree-pending") {
        const found = await adapter.reconcileWorktree?.(plan, record.operationId);
        if (!found) throw new Error("Worktree creation outcome is unknown; automatic recreation is blocked.");
        Object.assign(plan, found);
        record.phase = "workspace-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "prepared") {
        if (plan.worktree) {
          record.phase = "worktree-pending";
          this.save();
          Object.assign(plan, await adapter.createWorktree(plan, record.operationId));
        }
        record.phase = "workspace-ready";
        this.save();
      }
      if (record.phase === "thread-pending") {
        const found = await adapter.reconcileThread?.(plan, record.operationId);
        if (!found) throw new Error("Thread creation outcome is unknown; automatic recreation is blocked.");
        record.threadId = found.threadId;
        record.phase = "thread-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "workspace-ready") {
        record.phase = "thread-pending";
        this.save();
        record.threadId = (await adapter.startThread(plan, record.operationId)).threadId;
        record.phase = "thread-ready";
        this.save();
      }
      if (record.phase === "thread-ready") {
        await adapter.bindThread(plan, record.threadId!, record.source);
        record.phase = "bound";
        this.save();
      }
      if (record.phase === "items-pending") {
        const confirmed = await adapter.reconcileInjectedItems?.(plan, record.threadId!);
        if (!confirmed) throw new Error("Response item injection outcome is unknown; automatic reinjection is blocked.");
        record.phase = "items-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "bound") {
        if (plan.nativeParams?.responseItems?.length) {
          if (!adapter.injectItems) throw new Error("Server response item injection adapter is not ready.");
          record.phase = "items-pending";
          this.save();
          await adapter.injectItems(plan, record.threadId!);
        }
        record.phase = "items-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "turn-pending") {
        const found = await adapter.reconcileTurn?.(plan, record.threadId!, record.operationId);
        if (!found) throw new Error("First turn outcome is unknown; automatic resend is blocked.");
        record.turnId = found.turnId;
        record.phase = "turn-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "items-ready") {
        await adapter.prepareTurn?.(plan, record.threadId!);
        delete record.error;
        record.phase = "turn-pending";
        this.save();
        record.turnId = (await adapter.startTurn(plan, record.threadId!, record.operationId)).turnId;
        record.phase = "turn-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "goal-pending") {
        const confirmed = await adapter.reconcileGoal?.(plan, record.threadId!);
        if (!confirmed) throw new Error("Goal setup outcome is unknown; the first turn was accepted and automatic goal replay is blocked.");
        record.phase = "goal-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "turn-ready") {
        if (plan.nativeParams?.goal != null) {
          if (!adapter.setGoal) throw new Error("Server goal setup adapter is not ready; the first turn was accepted.");
          record.phase = "goal-pending";
          this.save();
          await adapter.setGoal(plan, record.threadId!);
        }
        record.phase = "goal-ready";
        delete record.error;
        this.save();
      }
      if (record.phase === "goal-ready") {
        record.phase = "complete";
        this.save();
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      // Only read-only preparation can fail definitively without an unknown side effect.
      if (record.phase === "queued") record.phase = "failed";
      this.save();
    }
  }
}
