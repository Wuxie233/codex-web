import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Value = Record<string, any>;
export type HandoffPlan = Value & {
  sourceHostId: string;
  sourceThreadId: string;
  destinationHostId: string;
  direction: "to-local" | "to-worktree" | "to-host-worktree";
  gitRoot: string;
};
export type ThreadHandoffAdapter = {
  /** Reads only; verifies source eligibility and all permission/input guards. */
  prepare(sourceHostId: string, args: Value): Promise<HandoffPlan>;
  interrupt(plan: HandoffPlan): Promise<void>;
  workspace(plan: HandoffPlan, operationId: string): Promise<Value>;
  move(plan: HandoffPlan, operationId: string): Promise<Value>;
  fork(plan: HandoffPlan, operationId: string): Promise<{ threadId: string; hostId: string }>;
  synchronize(plan: HandoffPlan, destinationThreadId: string): Promise<void>;
  archive(plan: HandoffPlan): Promise<void>;
  followUp(plan: HandoffPlan, destinationThreadId: string, prompt: string, operationId: string): Promise<void>;
};
type Phase = "queued" | "prepared" | "interrupt-pending" | "interrupted" | "workspace-pending" | "workspace-ready" | "move-pending" | "moved" | "fork-pending" | "forked" | "sync-pending" | "synced" | "archive-pending" | "archived" | "follow-up-pending" | "complete";
type Operation = {
  operationId: string;
  fingerprint: string;
  callerHostId: string;
  callerThreadId: string;
  clientIdentity?: string;
  requestId?: string;
  args: Value;
  phase: Phase;
  status: "queued" | "running" | "success" | "error" | "outcome-unknown";
  revision: number;
  plan?: HandoffPlan;
  destinationThreadId?: string;
  errorMessage?: string;
};
const result = (value: unknown, success = true) => ({ success, contentItems: [{ type: "inputText", text: success ? JSON.stringify(value) : String(value) }] });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Durable handoff commands. An interrupted write is evidence to inspect, never to replay. */
export class ThreadHandoffs {
  private adapter?: ThreadHandoffAdapter;
  private operations: Record<string, Operation> = {};
  private running = new Set<string>();

  constructor(private readonly statePath: string) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.version !== 1 || !state.operations || typeof state.operations !== "object" || Array.isArray(state.operations))
        throw Error("Invalid thread handoff state.");
      this.operations = state.operations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let changed = false;
    for (const operation of Object.values(this.operations)) {
      if (!["queued", "running"].includes(operation.status)) continue;
      if (operation.phase.endsWith("-pending")) {
        operation.status = "outcome-unknown";
        operation.errorMessage = `Service restarted during ${operation.phase}. Inspect Git and destination state; do not replay this handoff.`;
        operation.revision++;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  registerAdapter(adapter: ThreadHandoffAdapter) {
    this.adapter = adapter;
    for (const operation of Object.values(this.operations)) {
      if (["queued", "running"].includes(operation.status)) this.start(operation);
    }
  }

  assertInputWritable(hostId: string, threadId: string): void {
    if (Object.values(this.operations).some((entry) => (entry.plan?.sourceHostId ?? entry.callerHostId) === hostId && entry.args.threadId === threadId && ["queued", "running", "outcome-unknown"].includes(entry.status)))
      throw Error("This task has a pending or unresolved handoff; input changes are blocked until it is resolved.");
  }

  async handoffUser(hostId: string, requestId: string, command: Value, signal: AbortSignal, clientIdentity = "codex-web"): Promise<Value> {
    signal.throwIfAborted();
    if (!this.adapter) throw Error("Thread handoff is not initialized.");
    if (!requestId || typeof requestId !== "string" || !["codex-web", "codecarry"].includes(clientIdentity)) throw Error("Invalid trusted handoff request identity.");
    const allowed = ["threadId", "direction", "worktreeBranch", "localBranch", "sourceBranch", "cwd", "defaultBranch", "localGitRoot", "localWorkspaceRoot", "worktreeRoot", "destinationHostId", "destinationWorkspaceRoot"];
    if (!command || typeof command !== "object" || Array.isArray(command) || Object.keys(command).some((key) => !allowed.includes(key))) throw Error("Invalid handoff command fields.");
    if (typeof command.threadId !== "string" || !command.threadId.trim() || !["to-local", "to-worktree", "to-host-worktree"].includes(command.direction)) throw Error("Handoff requires a source thread and direction.");
    for (const [key, value] of Object.entries(command)) if (value != null && (typeof value !== "string" || !value.trim())) throw Error(`Invalid handoff ${key}.`);
    const operationId = this.userOperationId(hostId, requestId, clientIdentity);
    const args = Object.fromEntries(allowed.filter((key) => command[key] !== undefined).map((key) => [key, command[key]]));
    const fingerprint = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const previous = this.operations[operationId];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error("Handoff requestId was reused with a different command.");
      return this.summary(previous);
    }
    this.assertInputWritable(hostId, args.threadId);
    const operation: Operation = { operationId, fingerprint, callerHostId: hostId, callerThreadId: "", clientIdentity, requestId, args,
      phase: "queued", status: "queued", revision: 0 };
    this.operations[operationId] = operation;
    this.save();
    this.start(operation);
    return this.summary(operation);
  }

  readUser(hostId: string, requestId: string, clientIdentity = "codex-web"): Value | null {
    const operation = this.operations[this.userOperationId(hostId, requestId, clientIdentity)];
    return operation ? this.summary(operation) : null;
  }

  private userOperationId(hostId: string, requestId: string, clientIdentity: string) {
    return createHash("sha256").update(JSON.stringify(["user", clientIdentity, hostId, requestId])).digest("hex");
  }

  async handle(sourceHostId: string, params: Value, signal: AbortSignal): Promise<Value | null> {
    if (params.namespace !== "codex_app" || !["handoff_thread", "get_handoff_status"].includes(params.tool)) return null;
    try {
      signal.throwIfAborted();
      const args = typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Expected handoff arguments object.");
      const allowed = params.tool === "handoff_thread" ? ["threadId", "destinationHostId", "followUpPrompt"] : ["operationId", "afterRevision", "waitMs"];
      if (Object.keys(args).some((key) => !allowed.includes(key))) throw Error("Unexpected handoff argument.");
      if (params.tool === "get_handoff_status") {
        if (typeof args.operationId !== "string" || !args.operationId) throw Error("operationId is required.");
        for (const key of ["afterRevision", "waitMs"]) {
          if (args[key] != null && (!Number.isInteger(args[key]) || args[key] < 0 || (key === "waitMs" && args[key] > 60000)))
            throw Error(`${key} is outside the supported range.`);
        }
        const operation = this.operations[args.operationId];
        if (!operation || operation.callerHostId !== sourceHostId || operation.callerThreadId !== params.threadId)
          throw Error(`No handoff found for operationId ${args.operationId}.`);
        const deadline = Date.now() + (args.waitMs ?? 0);
        while (args.afterRevision != null && operation.revision <= args.afterRevision && Date.now() < deadline && ["queued", "running"].includes(operation.status))
          await delay(Math.min(200, deadline - Date.now()), undefined, { signal });
        return result(this.summary(operation));
      }
      if (!this.adapter) throw Error("Thread handoff is not initialized.");
      if (typeof args.threadId !== "string" || !args.threadId.trim()) throw Error("threadId is required.");
      if (args.threadId === params.threadId) throw Error("A thread cannot hand itself off. Choose another thread.");
      for (const key of ["destinationHostId", "followUpPrompt"])
        if (args[key] != null && (typeof args[key] !== "string" || !args[key].trim())) throw Error(`${key} must be a nonempty string.`);
      if (typeof params.callId !== "string" || !params.callId || typeof params.threadId !== "string" || !params.threadId)
        throw Error("Handoff requires a durable tool call and calling thread identity.");
      const operationId = createHash("sha256").update(JSON.stringify([sourceHostId, params.threadId, params.callId])).digest("hex");
      const normalized = { threadId: args.threadId, destinationHostId: args.destinationHostId ?? null, followUpPrompt: args.followUpPrompt ?? null };
      const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      const previous = this.operations[operationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Error("Handoff call identity was reused with different arguments.");
        return result(this.summary(previous));
      }
      if (Object.values(this.operations).some((entry) => entry.callerHostId === sourceHostId && entry.args.threadId === args.threadId && ["queued", "running", "outcome-unknown"].includes(entry.status)))
        throw Error("This thread already has a pending or unresolved handoff. Read its existing operation status.");
      const operation: Operation = { operationId, fingerprint, callerHostId: sourceHostId, callerThreadId: params.threadId, args: normalized, phase: "queued", status: "queued", revision: 0 };
      this.operations[operationId] = operation;
      this.save();
      this.start(operation);
      return result(this.summary(operation));
    } catch (error) {
      return result(message(error), false);
    }
  }

  private summary(operation: Operation): Value {
    return {
      operationId: operation.operationId, requestId: operation.requestId, revision: operation.revision, status: operation.status, phase: operation.phase,
      sourceThreadId: operation.args.threadId, destinationThreadId: operation.destinationThreadId,
      destinationHostId: operation.plan?.destinationHostId, destinationCwd: operation.plan?.destinationCwd,
      direction: operation.plan?.direction, threadTitle: operation.plan?.threadTitle,
      warnings: operation.plan?.warnings, errorMessage: operation.errorMessage,
      retryable: false,
    };
  }

  private save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, operations: this.operations }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  private update(operation: Operation, values: Partial<Operation>) {
    Object.assign(operation, values, { revision: operation.revision + 1 });
    this.save();
  }

  private start(operation: Operation) {
    if (!this.adapter || this.running.has(operation.operationId)) return;
    this.running.add(operation.operationId);
    void this.run(operation).catch((error) => {
      this.update(operation, { status: operation.phase.endsWith("-pending") ? "outcome-unknown" : "error", errorMessage: message(error),
        ...(typeof error?.destinationThreadId === "string" ? { destinationThreadId: error.destinationThreadId } : {}) });
    }).finally(() => this.running.delete(operation.operationId));
  }

  private async run(operation: Operation) {
    const adapter = this.adapter!;
    this.update(operation, { status: "running" });
    if (operation.phase === "queued") {
      const plan = await adapter.prepare(operation.callerHostId, operation.args);
      if (Object.values(this.operations).some((other) => other !== operation && other.plan?.sourceHostId === plan.sourceHostId && other.plan.gitRoot === plan.gitRoot && ["running", "outcome-unknown"].includes(other.status)))
        throw Error("Another handoff is changing this repository. Resolve that operation first.");
      this.update(operation, { plan, phase: "prepared" });
    }
    const plan = operation.plan!;
    const step = async (from: Phase, pending: Phase, next: Phase, action: () => Promise<Partial<Operation> | void>) => {
      if (operation.phase !== from) return;
      this.update(operation, { phase: pending });
      // Native transports may continue after timeout: retain the pending receipt, never replay.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let accepted: Partial<Operation> | void;
      try {
        accepted = await Promise.race([action(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(`Handoff timed out during ${pending}; outcome unknown. Inspect state before further changes.`)), 600000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      this.update(operation, { ...accepted, phase: next });
    };
    await step("prepared", "interrupt-pending", "interrupted", () => adapter.interrupt(plan));
    await step("interrupted", "workspace-pending", "workspace-ready", async () => ({ plan: { ...operation.plan!, ...await adapter.workspace(operation.plan!, operation.operationId) } }));
    await step("workspace-ready", "move-pending", "moved", async () => ({ plan: { ...operation.plan!, ...await adapter.move(operation.plan!, operation.operationId) } }));
    await step("moved", "fork-pending", "forked", async () => {
      const fork = await adapter.fork(operation.plan!, `${operation.operationId}:fork`);
      if (!fork.threadId || fork.threadId === plan.sourceThreadId) throw Error("Git moved, but destination thread creation was not confirmed.");
      return { destinationThreadId: fork.threadId };
    });
    await step("forked", "sync-pending", "synced", () => adapter.synchronize(operation.plan!, operation.destinationThreadId!));
    await step("synced", "archive-pending", "archived", () => adapter.archive(operation.plan!));
    await step("archived", "follow-up-pending", "complete", async () => {
      if (operation.args.followUpPrompt) await adapter.followUp(operation.plan!, operation.destinationThreadId!, operation.args.followUpPrompt, `${operation.operationId}:follow-up`);
    });
    this.update(operation, { status: "success" });
  }
}
