import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Native task management, with no dependency on an attached renderer. */
type Value = Record<string, any>;
export type ThreadManagementHost = {
  request(method: string, params: Value, signal?: AbortSignal): Promise<any>;
  readThread(id: string, signal?: AbortSignal): Promise<any>;
};
export type ThreadManagementAdapter = {
  setArchived(hostId: string, thread: Value, archived: boolean, options?: { cleanupWorktree?: boolean; restorePin?: boolean }): Promise<void>;
  setTitle(hostId: string, threadId: string, title: string): Promise<void>;
  setPinned(hostId: string, threadId: string, pinned: boolean): Promise<void>;
  threadProjectId(threadId: string): string | null;
};
const names = new Set([
  "list_archived_threads",
  "set_thread_archived",
  "set_thread_title",
  "set_thread_pinned",
]);
const result = (value: unknown, success = true) => ({
  success,
  contentItems: [
    {
      type: "inputText",
      text: success ? JSON.stringify(value) : String(value),
    },
  ],
});
/** Bound native calls even when their transport cannot cancel an in-flight request. */
function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  signal.throwIfAborted();
  if (Date.now() >= deadline)
    return Promise.reject(Error("Task management request timed out."));
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => {
      controller.abort(signal.reason);
      finish(reject, signal.reason ?? Error("Task management cancelled."));
    };
    const timer = setTimeout(
      () => {
        const error = Error("Task management request timed out.");
        controller.abort(error);
        finish(reject, error);
      },
      Math.max(1, deadline - Date.now()),
    );
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}
export class ThreadManagementService {
  private receipts: Record<string, { fingerprint: string; status: "unknown" | "complete"; result?: Value }> = {};
  private running = new Map<string, { fingerprint: string; promise: Promise<Value> }>();
  constructor(private readonly statePath: string) {
    try { this.receipts = JSON.parse(readFileSync(statePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.receipts), { mode: 0o600 });
    renameSync(`${this.statePath}.tmp`, this.statePath);
  }
  private async once(key: string, args: Value, operation: (dispatch: () => void) => Promise<Value>): Promise<Value> {
    const fingerprint = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const existing = this.receipts[key];
    if (existing && existing.fingerprint !== fingerprint)
      return result("Mutation request ID was reused with different arguments.", false);
    const pending = this.running.get(key);
    if (pending) return pending.fingerprint === fingerprint ? pending.promise : result("Mutation request ID was reused with different arguments.", false);
    if (existing) return existing.result ?? result("Mutation outcome unknown. This request will not be replayed; inspect the target state before issuing a new command.", false);
    const work = operation(() => {
      this.receipts[key] = { fingerprint, status: "unknown" };
      this.save();
    }).then((response) => {
      const receipt = this.receipts[key];
      if (receipt) {
        receipt.result = response;
        if (response.success) receipt.status = "complete";
        this.save();
      }
      return response;
    }).finally(() => this.running.delete(key));
    this.running.set(key, { fingerprint, promise: work });
    return work;
  }
  async handle(sourceHostId: string, params: Value, signal: AbortSignal): Promise<Value | null> {
    if (params.namespace !== "codex_app" || !names.has(params.tool)) return null;
    if (params.tool === "list_archived_threads") return this.execute(sourceHostId, params, signal);
    if (!params.threadId || !params.callId) return result("Mutation requires trusted calling thread and call IDs.", false);
    let args;
    try { args = typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments; }
    catch { return result("Invalid task management arguments.", false); }
    const key = JSON.stringify(["agent", sourceHostId, params.threadId, params.turnId ?? null, params.callId]);
    return this.once(key, { tool: params.tool, args }, (dispatch) => this.execute(sourceHostId, params, signal, dispatch));
  }
  async archiveUser(hostId: string, command: { requestId: string; threadId: string; archived: boolean; cleanupWorktree?: boolean; restorePin?: boolean }, signal: AbortSignal, clientIdentity: string): Promise<Value> {
    if (!command || typeof command.requestId !== "string" || !command.requestId.trim() ||
        Object.keys(command).some((key) => !["requestId", "threadId", "archived", "cleanupWorktree", "restorePin"].includes(key)) ||
        [command.cleanupWorktree, command.restorePin].some((value) => value != null && typeof value !== "boolean"))
      throw Error("Invalid archive command.");
    const key = JSON.stringify(["user", clientIdentity, hostId, command.requestId]);
    const response = await this.once(key, command, (dispatch) => this.execute(hostId, {
      namespace: "codex_app", tool: "set_thread_archived", threadId: command.threadId,
      arguments: { hostId, threadId: command.threadId, archived: command.archived },
    }, signal, dispatch, { cleanupWorktree: command.cleanupWorktree ?? false, restorePin: command.restorePin ?? false }));
    const receipt = this.receipts[key];
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    if (receipt && receipt.fingerprint !== fingerprint) return { status: "failed", result: response };
    return this.readArchiveUser(hostId, command.requestId, clientIdentity) ?? { status: "failed", result: response };
  }
  readArchiveUser(hostId: string, requestId: string, clientIdentity: string): Value | null {
    const receipt = this.receipts[JSON.stringify(["user", clientIdentity, hostId, requestId])];
    return receipt ? { status: receipt.status === "complete" ? "completed" : "outcome-unknown", result: receipt.result ?? null } : null;
  }
  private hosts = new Map<string, ThreadManagementHost>();
  private adapter: ThreadManagementAdapter | null = null;
  registerHost(hostId: string, host: ThreadManagementHost) {
    this.hosts.set(hostId, host);
  }

  unregisterHost(hostId: string): void {
    this.hosts.delete(hostId);
  }
  registerAdapter(adapter: ThreadManagementAdapter) {
    this.adapter = adapter;
  }
  private async execute(
    sourceHostId: string,
    params: Value,
    signal: AbortSignal,
    markDispatched: () => void = () => {},
    archiveOptions?: { cleanupWorktree?: boolean; restorePin?: boolean },
  ): Promise<Value> {
    if (params.namespace !== "codex_app" || !names.has(params.tool))
      return result("Unknown task management tool.", false);
    const deadline = Date.now() + 30000;
    let dispatched = false;
    try {
      signal.throwIfAborted();
      const adapter = this.adapter;
      if (!adapter) throw Error("Task management is not initialized.");
      const args =
        typeof params.arguments === "string"
          ? JSON.parse(params.arguments)
          : (params.arguments ?? {});
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw Error("Expected tool arguments object.");
      const allowed: Record<string, string[]> = {
        list_archived_threads: ["hostId", "limit", "cursor"],
        set_thread_archived: ["hostId", "threadId", "archived"],
        set_thread_title: ["threadId", "title"],
        set_thread_pinned: ["threadId", "pinned"],
      };
      if (Object.keys(args).some((key) => !allowed[params.tool]!.includes(key)))
        throw Error("Unexpected task management argument.");
      for (const key of ["threadId", "hostId", "cursor"])
        if (args[key] != null && (typeof args[key] !== "string" || !args[key]))
          throw Error(`${key} must be a nonempty string.`);
      if (params.tool === "list_archived_threads") {
        const hostId = args.hostId ?? sourceHostId;
        const host = this.hosts.get(hostId);
        if (!host)
          throw Error(
            `No connected Codex thread host found for hostId: ${hostId}`,
          );
        const limit = args.limit ?? 10;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50)
          throw Error("limit must be an integer between 1 and 50.");
        const page = await bounded(
          (readSignal) =>
            host.request(
              "thread/list",
              {
                archived: true,
                cursor: args.cursor ?? null,
                limit,
                modelProviders: null,
                sortKey: "updated_at",
                useStateDbOnly: true,
              },
              readSignal,
            ),
          signal,
          deadline,
        );
        return result({
          threads: page.data.map((thread: Value) => {
            const title =
              thread.name?.trim() || thread.preview?.trim() || thread.id;
            const summary =
              thread.preview?.trim() === title
                ? null
                : (thread.preview?.trim() ?? null);
            const entry: Value = {
              id: thread.id,
              kind: "codex",
              projectId: adapter.threadProjectId(thread.id),
              hostId,
              status: thread.status?.type ?? "notLoaded",
              cwd: thread.cwd ?? null,
              updatedAt: thread.updatedAt ?? null,
              title: title.slice(0, 2000),
              summary: summary?.slice(0, 300) ?? null,
            };
            for (const [key, value, max] of [
              ["title", title, 2000],
              ["summary", summary, 300],
            ] as const)
              if (value && value.length > max) {
                entry[`${key}Truncated`] = true;
                entry[`${key}OriginalChars`] = value.length;
              }
            return entry;
          }),
          nextCursor: page.nextCursor,
        });
      }
      const threadId =
        args.threadId ??
        (params.tool === "set_thread_pinned" ? undefined : params.threadId);
      if (typeof threadId !== "string" || !threadId)
        throw Error("Missing thread id.");
      if (
        params.tool === "set_thread_title" &&
        (typeof args.title !== "string" || !args.title.trim())
      )
        throw Error("title must be a nonempty string.");
      if (
        params.tool === "set_thread_archived" &&
        typeof args.archived !== "boolean"
      )
        throw Error("archived must be a boolean.");
      if (
        params.tool === "set_thread_pinned" &&
        typeof args.pinned !== "boolean"
      )
        throw Error("pinned must be a boolean.");
      const selectedHost =
        args.hostId ??
        (threadId === params.threadId ? sourceHostId : undefined);
      const candidates = selectedHost
        ? [...this.hosts].filter(([id]) => id === selectedHost)
        : [...this.hosts];
      if (!candidates.length)
        throw Error("No connected host available for this task.");
      const outcomes = await Promise.all(
        candidates.map(async ([hostId, host]) => {
          try {
            const thread = await bounded(
              (s) => host.readThread(threadId, s),
              signal,
              deadline,
            );
            return {
              hostId,
              thread: thread?.id === threadId ? thread : null,
              unavailable: false,
            };
          } catch (error) {
            signal.throwIfAborted();
            return {
              hostId,
              thread: null,
              unavailable: !/not found|no rollout found|does not exist/i.test(
                String(error),
              ),
            };
          }
        }),
      );
      const matches = outcomes.filter((entry) => entry.thread != null);
      const unavailable = outcomes
        .filter((entry) => entry.unavailable)
        .map((entry) => entry.hostId);
      if (unavailable.length)
        throw Error(
          `Cannot verify unique task host; unavailable hosts: ${unavailable.join(", ")}; matching hosts: ${matches.map((entry) => entry.hostId).join(", ") || "none"}. No mutation was dispatched. Use an explicit host for archiving or reconnect unavailable hosts.`,
        );
      if (matches.length !== 1)
        throw Error(
          matches.length
            ? "Task exists on multiple hosts; supply an unambiguous host."
            : "Task was not found on the selected hosts.",
        );
      signal.throwIfAborted();
      const { hostId, thread } = matches[0]!;
      if (params.tool === "set_thread_archived") {
        await bounded(
          async () => {
            markDispatched();
            dispatched = true;
            await adapter.setArchived(hostId, thread, args.archived, archiveOptions);
          },
          signal,
          deadline,
        );
        return result({ threadId, archived: args.archived });
      }
      if (params.tool === "set_thread_title") {
        await bounded(
          async () => {
            markDispatched();
            dispatched = true;
            await adapter.setTitle(hostId, threadId, args.title);
          },
          signal,
          deadline,
        );
        return result({ threadId, title: args.title });
      }
      await bounded(
        async () => {
          markDispatched();
          dispatched = true;
          await adapter.setPinned(hostId, threadId, args.pinned);
        },
        signal,
        deadline,
      );
      return result({ threadId, pinned: args.pinned });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return result(
        dispatched
          ? `Mutation outcome unknown: ${message}. The native operation may still finish. Read the target task and pinned/archive state to verify before retrying; do not replay automatically.`
          : message,
        false,
      );
    }
  }
}
