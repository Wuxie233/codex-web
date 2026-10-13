import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type Value = Record<string, any>;
export type ThreadQueryHost = {
  readThread(id: string): Promise<any>;
  request(method: string, params: any): Promise<any>;
};

const result = (value: unknown, success = true) => ({
  success,
  contentItems: [
    {
      type: "inputText",
      text: success ? JSON.stringify(value) : String(value),
    },
  ],
});
const clipped = (text: string, limit: number) => ({
  text: text.slice(0, limit),
  truncated: text.length > limit,
  ...(text.length > limit ? { originalChars: text.length } : {}),
});
const select = (value: Value, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
function itemSummary(item: Value, outputs: boolean, limit: number): Value {
  const base = select(item, ["type", "id"]);
  const fields: Record<string, string[]> = {
    userMessage: ["content"],
    agentMessage: ["text", "phase"],
    plan: ["text"],
    commandExecution: ["command", "cwd", "status", "exitCode", "durationMs"],
    mcpToolCall: ["server", "tool", "arguments", "status", "durationMs"],
    dynamicToolCall: ["tool", "arguments", "status", "success", "durationMs"],
    collabAgentToolCall: [
      "tool",
      "status",
      "senderThreadId",
      "receiverThreadIds",
      "prompt",
      "model",
      "reasoningEffort",
    ],
    subAgentActivity: ["kind", "agentThreadId", "agentPath"],
    functionCallOutput: ["name", "namespace"],
    webSearch: ["query", "action"],
    imageView: ["path"],
    sleep: ["durationMs"],
    imageGeneration: ["status", "revisedPrompt", "result", "savedPath"],
    enteredReviewMode: ["review"],
    exitedReviewMode: ["review"],
  };
  Object.assign(base, select(item, fields[item.type] ?? []));
  // Reasoning payloads are deliberately not expanded by coordination tools.
  if (item.type === "reasoning") base.summary = item.summary;
  if (item.type === "hookPrompt") base.fragmentCount = item.fragments.length;
  if (item.type === "fileChange") {
    base.status = item.status;
    base.changes = item.changes.map((change: Value) => ({
      path: change.path,
      kind: change.kind,
      ...(outputs ? { diff: clipped(change.diff, limit) } : {}),
    }));
  }
  if (
    outputs &&
    item.type === "commandExecution" &&
    item.aggregatedOutput != null
  )
    base.output = clipped(item.aggregatedOutput, limit);
  if (outputs && item.type === "functionCallOutput")
    base.output = clipped(
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output),
      limit,
    );
  return base;
}
function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw Error(`Expected an integer between ${min} and ${max}.`);
  return Number(value);
}
function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw Error("Expected a nonempty thread or host id.");
  return value;
}

/** Browser-independent projections of the native Codex coordination tools. */
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? Error("Thread query cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}
function wakeReason(poll: Value): string | null {
  const status = poll.thread.status;
  if (status.type === "notLoaded" || status.type === "systemError") return "inactiveStatus";
  if (status.type === "active" && status.activeFlags.length > 0 && poll.changed) return "actionableStatus";
  if (status.type === "idle" && poll.changed)
    return poll.latestTurn == null ? "inactiveStatus" : poll.latestTurn.status !== "inProgress" ? "turnCompleted" : null;
  return null;
}

export class ThreadQueries {
  private hosts = new Map<string, ThreadQueryHost>();

  registerHost(hostId: string, adapter: ThreadQueryHost): void {
    this.hosts.set(hostId, adapter);
  }

  unregisterHost(hostId: string): void {
    this.hosts.delete(hostId);
  }

  private host(hostId: string, signal: AbortSignal): ThreadQueryHost {
    const host = this.hosts.get(hostId);
    if (!host) throw Error(`Unknown Codex host: ${hostId}`);
    return {
      readThread: (id) => bounded(() => host.readThread(id), signal),
      request: (method, params) => bounded(() => host.request(method, params), signal),
    };
  }

  private async page(
    host: ThreadQueryHost,
    id: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const page = await host.request("thread/turns/list", {
      threadId: id,
      cursor: cursor ?? null,
      limit,
      itemsView: "full",
      sortDirection: "desc",
    });
    if (cursor != null && page.nextCursor === cursor)
      throw Error("thread/turns/list returned an unchanged cursor");
    for (const turn of page.data) {
      if (turn.itemsView === "notLoaded") {
        // Match the native coordination preview: the most recent 50 items.
        const response = await host.request("thread/items/list", {
          threadId: id,
          turnId: turn.id,
          cursor: null,
          limit: 50,
          sortDirection: "desc",
        });
        turn.items = response.data
          .map((entry: Value) => {
            if (entry.turnId !== turn.id)
              throw Error("thread/items/list returned an unexpected turn");
            return entry.item;
          })
          .reverse();
      }
    }
    return page;
  }

  private async read(hostId: string, args: Value, signal: AbortSignal) {
    const id = nonempty(args.threadId);
    let response: any;
    if (args.hostId !== undefined) response = await this.host(hostId, signal).readThread(id);
    else {
      try { response = await this.host(hostId, signal).readThread(id); }
      catch { signal.throwIfAborted(); }
      if ((response?.thread ?? response)?.id !== id) {
        const matches = await Promise.all([...this.hosts.keys()].filter((key) => key !== hostId).map(async (key) => {
          try {
            const value = await this.host(key, signal).readThread(id);
            return (value?.thread ?? value)?.id === id ? { key, value } : null;
          } catch { signal.throwIfAborted(); return null; }
        }));
        const found = matches.filter((entry) => entry != null);
        if (found.length !== 1) throw Error(found.length ? "Ambiguous target task host. Specify hostId." : "No readable target task was found. Specify its hostId.");
        hostId = found[0]!.key;
        response = found[0]!.value;
      }
    }
    const host = this.host(hostId, signal);
    const limit = integer(args.turnLimit, 1, 1, 10);
    const maxChars = integer(args.maxOutputCharsPerItem, 2000, 0, 20000);
    if (
      args.includeOutputs !== undefined &&
      typeof args.includeOutputs !== "boolean"
    )
      throw Error("includeOutputs must be boolean.");
    if (args.cursor !== undefined) nonempty(args.cursor);
    const thread = response.thread ?? response;
    const page = await this.page(host, id, args.cursor, limit);
    return {
      schemaVersion: 1,
      thread: {
        ...select(thread, [
          "id",
          "preview",
          "status",
          "cwd",
          "createdAt",
          "updatedAt",
        ]),
        kind: "codex",
        hostId,
        title: thread.name,
      },
      page: {
        order: "newest_first",
        limit,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor != null,
      },
      turns: page.data.map((turn: Value) => ({
        ...select(turn, [
          "id",
          "status",
          "startedAt",
          "completedAt",
          "durationMs",
        ]),
        error:
          turn.error == null
            ? null
            : select(turn.error, ["message", "additionalDetails"]),
        items: turn.items.map((item: Value) =>
          itemSummary(item, args.includeOutputs ?? false, maxChars),
        ),
      })),
    };
  }

  private async poll(hostId: string, id: string, afterCursor: string | undefined, signal: AbortSignal) {
    const host = this.host(hostId, signal);
    const [response, page] = await Promise.all([
      host.readThread(id),
      this.page(host, id, undefined, 1),
    ]);
    const thread = response.thread ?? response,
      turn = page.data[0];
    const items: Value[] = turn?.items ?? [];
    const assistant = items.findLast(
      (item) => item.type === "agentMessage" && item.text.trim().length > 0,
    );
    const tool = items.findLast((item) =>
      [
        "commandExecution",
        "fileChange",
        "imageGeneration",
        "collabAgentToolCall",
        "dynamicToolCall",
        "mcpToolCall",
        "sleep",
        "webSearch",
      ].includes(item.type),
    );
    const projection = {
      thread: { id: thread.id, hostId, status: thread.status },
      latestTurn:
        turn == null
          ? null
          : {
              id: turn.id,
              status: turn.status,
              ...select(turn, ["startedAt", "completedAt", "durationMs"]),
              error:
                turn.error == null
                  ? null
                  : { message: turn.error.message.slice(0, 2000) },
            },
      latestAssistantMessage:
        assistant == null
          ? null
          : {
              id: assistant.id,
              turnId: turn.id,
              phase: assistant.phase,
              ...clipped(assistant.text, 2000),
            },
      latestToolMarker:
        tool == null
          ? null
          : {
              id: tool.id,
              turnId: turn.id,
              type: tool.type,
              name: tool.tool ?? tool.type,
              status: tool.status ?? null,
            },
    };
    // Content-addressed cursors survive both renderer and service restarts.
    const cursor = `server-v1:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`;
    const changed = afterCursor !== cursor;
    return {
      schemaVersion: 1,
      cursor,
      revision: 1,
      changed,
      ...(afterCursor != null && !afterCursor.startsWith("server-v1:")
        ? { cursorReset: true }
        : {}),
      ...projection,
      latestAssistantMessageId: assistant?.id ?? null,
      latestToolMarkerId: tool?.id ?? null,
      latestAssistantMessage: changed
        ? projection.latestAssistantMessage
        : null,
      latestToolMarker: changed ? projection.latestToolMarker : null,
    };
  }

  private async wait(
    hostId: string,
    sourceId: string,
    args: Value,
    signal?: AbortSignal,
  ) {
    if (
      !Array.isArray(args.targets) ||
      args.targets.length < 1 ||
      args.targets.length > 8
    )
      throw Error("wait_threads requires 1 to 8 targets.");
    const timeout = integer(args.timeoutMs, 120000, 0, 3600000);
    const targets = args.targets.map((target: Value) => ({
      threadId: nonempty(target.threadId),
      hostId: nonempty(target.hostId ?? hostId),
      afterCursor:
        target.afterCursor === undefined
          ? undefined
          : nonempty(target.afterCursor),
    }));
    if (
      targets.some(
        (target) => target.threadId === sourceId && target.hostId === hostId,
      )
    )
      throw Error("wait_threads cannot wait on the calling thread.");
    if (
      new Set(
        targets.map((target) =>
          JSON.stringify([target.hostId, target.threadId]),
        ),
      ).size !== targets.length
    )
      throw Error("wait_threads received duplicate targets.");
    const deadline = Date.now() + timeout;
    for (;;) {
      signal?.throwIfAborted();
      const round = new AbortController();
      const roundSignal = signal ? AbortSignal.any([signal, round.signal]) : round.signal;
      // Even an immediate snapshot needs a bounded opportunity to read the daemon.
      const timer = setTimeout(() => round.abort(Error("Thread snapshot timed out")),
        timeout === 0 ? 5000 : Math.max(1, Math.min(5000, deadline - Date.now())));
      let reads: PromiseSettledResult<Value>[];
      try {
        reads = await Promise.allSettled(targets.map(async (target) => {
          const poll = await this.poll(target.hostId, target.threadId, target.afterCursor, roundSignal);
          if (wakeReason(poll) != null) round.abort(Error("Snapshot ended after another task became actionable"));
          return poll;
        }));
      } finally { clearTimeout(timer); }
      signal?.throwIfAborted();
      const polls = reads.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value] : [],
      );
      const errors = reads.flatMap((entry, index) =>
        entry.status === "rejected"
          ? [
              {
                ...targets[index],
                message: String(entry.reason?.message ?? entry.reason).slice(
                  0,
                  2000,
                ),
              },
            ]
          : [],
      );
      let wake: Value | null = null;
      for (const poll of polls) {
        const reason = wakeReason(poll);
        if (reason != null) {
          wake = {
            reason,
            threadId: poll.thread.id,
            hostId: poll.thread.hostId,
            ...(reason === "turnCompleted"
              ? { turnId: poll.latestTurn!.id }
              : {}),
          };
          break;
        }
      }
      const unchangedTerminal =
        polls.length > 0 &&
        polls.every(
          (poll) =>
            !poll.changed &&
            poll.thread.status.type === "idle" &&
            poll.latestTurn?.status !== "inProgress",
        );
      if (
        wake ||
        Date.now() >= deadline ||
        polls.length === 0 ||
        unchangedTerminal
      )
        return {
          timedOut: wake == null && !unchangedTerminal && polls.length > 0,
          wake,
          polls,
          ...(errors.length ? { errors } : {}),
        };
      await delay(
        Math.min(5000, Math.max(0, deadline - Date.now())),
        undefined,
        { signal },
      );
    }
  }

  async handle(hostId: string, params: Value, signal?: AbortSignal) {
    if (params.tool !== "read_thread" && params.tool !== "wait_threads")
      return null;
    try {
      signal?.throwIfAborted();
      const args = params.arguments;
      if (args == null || typeof args !== "object")
        throw Error("Invalid tool arguments.");
      const readSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
      const value =
        params.tool === "read_thread"
          ? await bounded(() => this.read(nonempty(args.hostId ?? hostId), args, readSignal), readSignal)
          : await this.wait(hostId, params.threadId, args, signal);
      signal?.throwIfAborted();
      return result(value);
    } catch (error) {
      return result(
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
  }
}
