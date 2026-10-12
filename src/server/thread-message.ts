import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

type Adapter = {
  readThread(id: string): Promise<any>;
  resumeThread(id: string, options: any): Promise<any>;
  request(method: string, params: any): Promise<any>;
};
type Result = { success: boolean; contentItems: any[] };
type Call = {
  threadId: string;
  turnId?: string;
  callId: string;
  arguments: any;
};
type Delivery = {
  fingerprint: string;
  hostId: string;
  threadId: string;
  sourceThreadId: string;
  status: "unknown" | "sent";
  result?: Result;
};
const failure = (text: string): Result => ({
  success: false,
  contentItems: [{ type: "inputText", text }],
});
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Browser-independent delivery. The daemon owns both routing and receipts. */
export class ThreadMessages {
  private hosts = new Map<string, Adapter>();
  private deliveries: Record<string, Delivery> = {};
  private targets = new Map<string, Promise<unknown>>();

  constructor(private statePath: string) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.version !== 1 || !state.deliveries || typeof state.deliveries !== "object")
        throw new Error("Invalid thread message delivery state");
      this.deliveries = state.deliveries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  registerHost(hostId: string, adapter: Adapter): void {
    this.hosts.set(hostId, adapter);
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, deliveries: this.deliveries }), {
      mode: 0o600,
    });
    renameSync(temporary, this.statePath);
  }

  private async bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (callback: (value: any) => void, value: any) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        callback(value);
      };
      const aborted = () => finish(reject, new Error("Thread message call cancelled"));
      const timer = setTimeout(() => finish(reject, new Error("Thread message request timed out")), 30000);
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async send(sourceHostId: string, params: Call, signal: AbortSignal): Promise<Result> {
    try {
      const args = typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          typeof args.threadId !== "string" || !args.threadId.trim() ||
          typeof args.prompt !== "string" || !args.prompt.trim() ||
          typeof params.threadId !== "string" || !params.threadId.trim() ||
          typeof params.callId !== "string" || !params.callId.trim() ||
          (args.hostId != null && (typeof args.hostId !== "string" || !args.hostId.trim())))
        return failure("send_message_to_thread requires threadId, a nonempty prompt, and trusted calling task identity.");
      if (Object.keys(args).some((key) => !["threadId", "prompt", "hostId", "model", "thinking"].includes(key)))
        return failure("send_message_to_thread received unsupported arguments.");
      if ((args.model != null && (typeof args.model !== "string" || !args.model.trim())) ||
          (args.thinking != null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(args.thinking)))
        return failure("send_message_to_thread received an invalid model or reasoning effort.");
      const key = JSON.stringify([sourceHostId, params.threadId, params.callId]);
      const digest = (host: string) => createHash("sha256").update(JSON.stringify([
        host, args.threadId, args.prompt, args.model ?? null, args.thinking ?? null,
      ])).digest("hex");
      const receipt = this.deliveries[key];
      if (receipt) {
        if ((args.hostId != null && args.hostId !== receipt.hostId) || receipt.fingerprint !== digest(receipt.hostId))
          return failure("This tool call identity already belongs to a different message.");
        return receipt.result ?? failure("This message was already dispatched; its outcome is unknown. It was not replayed. Read the target task before deciding what to do next.");
      }
      let hostId = args.hostId ?? sourceHostId;
      if (args.hostId == null) {
        const matches = async (id: string, host: Adapter) => {
          try {
            const thread = await this.bounded(() => host.readThread(args.threadId), signal);
            return thread?.id === args.threadId ? id : null;
          } catch { signal.throwIfAborted(); return null; }
        };
        const preferred = this.hosts.get(sourceHostId);
        if (!preferred || await matches(sourceHostId, preferred) == null) {
          const found = (await Promise.all([...this.hosts.entries()]
            .filter(([id]) => id !== sourceHostId)
            .map(([id, host]) => matches(id, host)))).filter((id): id is string => id != null);
          if (found.length !== 1)
            return failure(found.length ? "Ambiguous target task host. Specify hostId." : "No readable target task was found. Specify its hostId.");
          hostId = found[0]!;
        }
      }
      const adapter = this.hosts.get(hostId);
      if (!adapter) return failure(`No connected task host: ${hostId}. Specify the target's hostId.`);
      if (hostId === sourceHostId && args.threadId === params.threadId)
        return failure("send_message_to_thread cannot message the calling task.");
      const fingerprint = digest(hostId);
      const targetKey = JSON.stringify([hostId, args.threadId]);
      const previous = this.targets.get(targetKey) ?? Promise.resolve();
      const work = previous.catch(() => undefined).then(async (): Promise<Result> => {
        signal.throwIfAborted();
        const existing = this.deliveries[key];
        if (existing) {
          if (existing.fingerprint !== fingerprint) return failure("This tool call identity already belongs to a different message.");
          return existing.result ?? failure("This message was already dispatched; its outcome is unknown. It was not replayed. Read the target task before deciding what to do next.");
        }
        const read = () => this.bounded(() => adapter.readThread(args.threadId), signal);
        let thread = await read();
        if (!thread || thread.id !== args.threadId) return failure("The target task was not found on the selected host.");
        if (thread.parentThreadId != null || thread.source?.subAgent != null || thread.canAcceptDirectInput === false)
          return failure("The target is a subagent or cannot accept direct messages. Use its owning task.");
        // thread/read does not expose archive state. Query the authoritative archive catalog.
        let cursor: string | null = null;
        do {
          const page = await this.bounded(() => adapter.request("thread/list", {
            archived: true, cursor, limit: 100, sourceKinds: [], modelProviders: [],
          }), signal);
          if (!Array.isArray(page.data)) throw new Error("Unable to verify target archive state");
          if (page.data.some((entry: any) => entry.id === args.threadId))
            return failure("The target task is archived. Unarchive it before sending a message.");
          cursor = page.nextCursor ?? null;
        } while (cursor != null);
        if (thread.status?.type === "notLoaded") {
          await this.bounded(() => adapter.resumeThread(args.threadId, { cwd: thread.cwd, path: thread.path }), signal);
          thread = await read();
        }
        if (!["idle", "active"].includes(thread?.status?.type))
          return failure("The target task is not ready to receive a message.");
        signal.throwIfAborted();
        const delivery: Delivery = { fingerprint, hostId, threadId: args.threadId,
          sourceThreadId: params.threadId, status: "unknown" };
        this.deliveries[key] = delivery;
        try { this.save(); } catch (error) { delete this.deliveries[key]; throw error; }
        // Native tool-output follow-ups use turn/start for idle AND active tasks.
        // turn/steer accepts user input only (Codex app-server >= 0.151.0-alpha.4).
        const output = `<codex_delegation>\n  <source_thread_id>${escapeXml(params.threadId)}</source_thread_id>\n  <input>${escapeXml(args.prompt)}</input>\n</codex_delegation>`;
        try {
          const response = await this.bounded(() => adapter.request("turn/start", {
            threadId: args.threadId, input: [],
            toolOutput: { name: "send_message_to_thread", namespace: "codex_app", output },
            turnTrigger: "app_tool_send_message",
            ...(args.model == null ? {} : { model: args.model }),
            ...(args.thinking == null ? {} : { effort: args.thinking }),
          }), signal);
          if (typeof response?.turn?.id !== "string") throw new Error("Message acknowledgement did not contain a turn id");
          const result: Result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({
            threadId: args.threadId, hostId, turnId: response.turn.id,
          }) }] };
          delivery.status = "sent";
          delivery.result = result;
          try { this.save(); } catch (error) {
            delivery.status = "unknown";
            delete delivery.result;
            throw error;
          }
          return result;
        } catch {
          return failure("Message dispatch did not produce a durable acknowledgement; its outcome may be unknown. Do not automatically retry. Read the target task to check delivery.");
        }
      });
      this.targets.set(targetKey, work);
      try { return await work; } finally {
        if (this.targets.get(targetKey) === work) this.targets.delete(targetKey);
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}
