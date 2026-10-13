import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type Value = Record<string, any>;
export type ForkInput = {
  sourceHostId: string;
  sourceThreadId: string;
  destinationHostId?: string;
  cwd?: string;
  workspaceRoots?: string[];
  rolloutPath?: string;
  threadSource?: string;
  environment?: "same-directory" | "worktree";
  discoverHost?: boolean;
  userOperation?: boolean;
  projectAssignment?: Value | null;
};
export type ForkPlan = ForkInput & {
  hostId: string;
  cwd: string;
  workspaceRoots: string[];
  [key: string]: any;
};
export type ForkAdapter = {
  prepare(input: ForkInput): Promise<ForkPlan>;
  createWorktree(plan: ForkPlan, operationId: string): Promise<Value>;
  fork(plan: ForkPlan): Promise<{ threadId: string; forkResponse?: Value }>;
  injectItems?(plan: ForkPlan, threadId: string): Promise<void>;
  synchronize(plan: ForkPlan, threadId: string): Promise<void>;
};
type Receipt = {
  operationId: string;
  fingerprint: string;
  input: ForkInput;
  phase:
    | "preparing"
    | "prepared"
    | "worktree-pending"
    | "ready"
    | "fork-pending"
    | "forked"
    | "inject-pending"
    | "synchronizing"
    | "complete"
    | "failed";
  plan?: ForkPlan;
  threadId?: string;
  error?: string;
  forkResponse?: Value;
  userCommand?: Value;
};
const output = (value: unknown, success = true) => ({
  success,
  contentItems: [
    {
      type: "inputText",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});

/** Fork receipts survive renderer and server restarts; uncertain dispatches are never replayed. */
export class ThreadForks {
  private adapter?: ForkAdapter;
  private records: Record<string, Receipt> = {};
  private running = new Map<string, Promise<Value>>();
  constructor(private statePath: string) {
    try {
      this.records = JSON.parse(readFileSync(statePath, "utf8")).forks;
      if (!this.records || typeof this.records !== "object")
        throw Error("Invalid fork state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, forks: this.records }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.statePath);
  }
  registerAdapter(adapter: ForkAdapter) {
    this.adapter = adapter;
    for (const record of Object.values(this.records)) {
      if (
        ["fork-pending", "worktree-pending", "inject-pending"].includes(
          record.phase,
        )
      ) {
        record.error =
          "Operation outcome unknown after restart. Inspect the recorded host and workspace before retrying; do not replay automatically.";
      } else if (!["failed", "complete"].includes(record.phase))
        void this.run(record).catch(() => {});
    }
    this.save();
  }
  resolve(operationId: string): Value | null {
    const record = this.records[operationId];
    return record
      ? {
          clientThreadId: operationId,
          hostId: record.plan?.hostId,
          threadId: record.threadId ?? null,
          ...(record.forkResponse ? { forkResponse: record.forkResponse } : {}),
          sourceThreadId: record.input.sourceThreadId,
          status:
            record.phase === "complete"
              ? "created"
              : record.phase === "failed"
                ? "failed"
                : record.error
                  ? "outcome-unknown"
                  : "queued",
          synchronization: {
            status:
              record.phase === "complete"
                ? "complete"
                : record.error
                  ? "failed"
                  : "pending",
            ...(record.error ? { message: record.error } : {}),
          },
          phase: record.phase,
          ...(record.error ? { error: record.error } : {}),
          continuation:
            record.phase === "complete"
              ? "The fork contains completed history only. Send a follow-up only if work should continue in the child."
              : "Wait for this receipt to complete. Do not fork again or send a follow-up while setup is incomplete.",
        }
      : null;
  }
  private ensure(
    operationId: string,
    input: ForkInput,
    suppliedFingerprint?: string,
    userCommand?: Value,
  ) {
    if (!this.adapter) throw Error("Task fork adapter is not initialized.");
    const fingerprint =
      suppliedFingerprint ??
      createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let record = this.records[operationId];
    if (record && record.fingerprint !== fingerprint)
      throw Error("Fork operation id was reused with different arguments.");
    if (!record) {
      record = {
        operationId,
        fingerprint,
        input,
        phase: "preparing",
        ...(userCommand ? { userCommand } : {}),
      };
      this.records[operationId] = record;
      this.save();
    }
    return record;
  }
  private userId(sourceHostId: string, requestId: string, clientId: string) {
    if (!sourceHostId || !requestId || !clientId)
      throw Error("Fork host, request id, and client identity are required.");
    return `user-fork-${createHash("sha256")
      .update(JSON.stringify([clientId, sourceHostId, requestId]))
      .digest("hex")}`;
  }
  readUser(
    sourceHostId: string,
    requestId: string,
    clientId = "codex-web",
  ): Value | null {
    return this.resolve(this.userId(sourceHostId, requestId, clientId));
  }
  async forkUser(
    sourceHostId: string,
    requestId: string,
    command: Value,
    signal: AbortSignal,
    clientId = "codex-web",
  ): Promise<Value> {
    signal.throwIfAborted();
    if (
      !command ||
      typeof command.sourceThreadId !== "string" ||
      !command.sourceThreadId
    )
      throw Error("Fork sourceThreadId is required.");
    if (
      !command.nativeParams ||
      command.nativeParams.threadId !== command.sourceThreadId
    )
      throw Error("Native fork source identity does not match.");
    const operationId = this.userId(sourceHostId, requestId, clientId);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const record = this.ensure(
      operationId,
      {
        sourceHostId,
        sourceThreadId: command.sourceThreadId,
        userOperation: true,
        cwd: command.nativeParams.cwd,
        workspaceRoots: command.nativeParams.runtimeWorkspaceRoots,
        threadSource: command.nativeParams.threadSource ?? "user",
      },
      fingerprint,
      { nativeParams: command.nativeParams, metadata: command.metadata ?? {} },
    );
    const task = this.run(record);
    void task.catch(() => {});
    const deadline = Date.now() + 30000;
    while (
      this.running.has(operationId) &&
      Date.now() < deadline &&
      !signal.aborted
    )
      await delay(40);
    return this.resolve(operationId)!;
  }
  async forkTo(operationId: string, input: ForkInput): Promise<Value> {
    const record = this.ensure(operationId, input);
    await this.run(record);
    const status = this.resolve(operationId)!;
    if (status.status !== "created") throw Error(JSON.stringify(status));
    return status;
  }
  private run(record: Receipt): Promise<Value> {
    const active = this.running.get(record.operationId);
    if (active) return active;
    const task = this.execute(record).finally(() =>
      this.running.delete(record.operationId),
    );
    this.running.set(record.operationId, task);
    return task;
  }
  private async execute(record: Receipt): Promise<Value> {
    const adapter = this.adapter!;
    if (
      record.error ||
      record.phase === "failed" ||
      record.phase === "complete"
    )
      return this.resolve(record.operationId)!;
    try {
      if (record.phase === "preparing") {
        record.plan = await adapter.prepare(record.input);
        record.phase = "prepared";
        this.save();
      }
      const plan = record.input.userOperation
        ? {
            ...record.plan!,
            ...record.userCommand,
            forkResponse: record.forkResponse,
          }
        : record.plan!;
      if (record.phase === "prepared") {
        if (record.input.environment === "worktree") {
          record.phase = "worktree-pending";
          this.save();
          Object.assign(
            plan,
            await adapter.createWorktree(plan, record.operationId),
          );
        }
        record.phase = "ready";
        this.save();
      }
      if (record.phase === "ready") {
        record.phase = "fork-pending";
        this.save();
        const accepted = await adapter.fork(plan);
        record.threadId = accepted.threadId;
        record.forkResponse = accepted.forkResponse;
        record.phase = "forked";
        this.save();
      }
      plan.forkResponse = record.forkResponse;
      if (record.phase === "forked") {
        if (
          record.userCommand?.metadata?.sideConversationBoundaryItems?.length
        ) {
          if (!adapter.injectItems)
            throw Error("Fork boundary item adapter is unavailable.");
          record.phase = "inject-pending";
          this.save();
          await adapter.injectItems(plan, record.threadId!);
        }
        record.phase = "synchronizing";
        this.save();
      }
      if (record.phase === "synchronizing") {
        await adapter.synchronize(plan, record.threadId!);
        record.phase = "complete";
        this.save();
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      if (record.phase === "preparing") record.phase = "failed";
      else
        record.error = `Operation outcome unknown or setup incomplete: ${record.error}. Do not fork again; inspect this receipt and child thread.`;
      this.save();
    }
    return this.resolve(record.operationId)!;
  }
  async handle(
    sourceHostId: string,
    params: Value,
    signal: AbortSignal,
  ): Promise<Value | null> {
    if (params.namespace !== "codex_app" || params.tool !== "fork_thread")
      return null;
    let acceptedOperationId: string | undefined;
    try {
      signal.throwIfAborted();
      const args =
        typeof params.arguments === "string"
          ? JSON.parse(params.arguments)
          : (params.arguments ?? {});
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).some(
          (key) => !["threadId", "environment"].includes(key),
        )
      )
        throw Error("Invalid fork_thread arguments.");
      const sourceThreadId = args.threadId ?? params.threadId;
      if (typeof sourceThreadId !== "string" || !sourceThreadId.trim())
        throw Error("Missing source thread id.");
      const environment = args.environment?.type ?? "same-directory";
      if (
        args.environment != null &&
        (typeof args.environment !== "object" ||
          Object.keys(args.environment).some((key) => key !== "type") ||
          !["same-directory", "worktree"].includes(args.environment.type))
      )
        throw Error("Invalid fork environment.");
      if (typeof params.callId !== "string" || !params.callId)
        throw Error("Missing durable fork call id.");
      const operationId = `pending-fork-${createHash("sha256")
        .update(JSON.stringify([sourceHostId, params.threadId, params.callId]))
        .digest("hex")
        .slice(0, 32)}`;
      const record = this.ensure(operationId, {
        sourceHostId,
        sourceThreadId,
        environment,
        discoverHost: sourceThreadId !== params.threadId,
      });
      acceptedOperationId = operationId;
      const operation = this.run(record);
      void operation.catch(() => {});
      // Worktree setup is asynchronous; same-directory calls return immediately when the fork completes.
      if (environment === "same-directory") {
        const deadline = Date.now() + 30000;
        while (this.running.has(operationId) && Date.now() < deadline)
          await delay(Math.min(100, deadline - Date.now()), undefined, {
            signal,
          });
      }
      void operation.catch(() => {});
      return output(this.resolve(operationId));
    } catch (error) {
      return acceptedOperationId
        ? output({
            ...this.resolve(acceptedOperationId),
            message:
              "Caller stopped waiting; the accepted fork operation may still finish. Continue with this receipt; do not fork again.",
          })
        : output(error instanceof Error ? error.message : String(error), false);
    }
  }
  async handleQuery(
    params: Value,
    signal: AbortSignal,
  ): Promise<{ params: Value } | { result: Value }> {
    if (!["read_thread", "wait_threads"].includes(params.tool))
      return { params };
    try {
      const args =
        typeof params.arguments === "string"
          ? JSON.parse(params.arguments)
          : params.arguments;
      const targets = params.tool === "read_thread" ? [args] : args?.targets;
      if (
        !Array.isArray(targets) ||
        !targets.some((target: Value) =>
          target?.threadId?.startsWith("pending-fork-"),
        )
      )
        return { params };
      const timeout =
        params.tool === "read_thread" ? 0 : (args.timeoutMs ?? 120000);
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 120000)
        throw Error("Invalid fork wait timeout.");
      const deadline = Date.now() + timeout;
      for (;;) {
        signal.throwIfAborted();
        const receipts = targets
          .filter((target: Value) =>
            target.threadId?.startsWith("pending-fork-"),
          )
          .map((target: Value) => {
            const record = this.resolve(target.threadId);
            if (!record)
              throw Error(`Unknown fork receipt: ${target.threadId}`);
            if (
              target.hostId &&
              record.hostId &&
              target.hostId !== record.hostId
            )
              throw Error("Fork receipt host mismatch.");
            return record;
          });
        if (receipts.every((receipt: Value) => receipt.status === "created")) {
          const mapped = targets.map((target: Value) => {
            const receipt = receipts.find(
              (entry: Value) => entry.clientThreadId === target.threadId,
            );
            return receipt
              ? {
                  ...target,
                  threadId: receipt.threadId,
                  hostId: receipt.hostId,
                }
              : target;
          });
          return {
            params: {
              ...params,
              arguments:
                params.tool === "read_thread"
                  ? mapped[0]
                  : {
                      ...args,
                      targets: mapped,
                      timeoutMs: Math.max(0, deadline - Date.now()),
                    },
            },
          };
        }
        if (
          receipts.some(
            (receipt: Value) => receipt.error || receipt.status === "created",
          ) ||
          receipts.length !== targets.length ||
          Date.now() >= deadline
        )
          return {
            result: output({
              forks: receipts,
              timedOut: Date.now() >= deadline,
            }),
          };
        await delay(Math.min(200, deadline - Date.now()), undefined, {
          signal,
        });
      }
    } catch (error) {
      return {
        result: output(
          error instanceof Error ? error.message : String(error),
          false,
        ),
      };
    }
  }
}
