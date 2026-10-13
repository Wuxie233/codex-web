import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

type Value = Record<string, any>;
export const automationToolSpec: Value = JSON.parse(
  readFileSync(join(__dirname, "automation-tool-schema.json"), "utf8"),
);
export type AutomationAdapter = {
  capability(): Promise<boolean>;
  request(method: string, params: Value): Promise<any>;
};
const result = (value: unknown, success = true) => ({
  success,
  contentItems: [{ type: "inputText", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

// Mirrors native fWn validation and RUn/zUn mapping. Native CRUD owns storage,
// schedule validation, duplicate heartbeat detection and project compatibility.
function argumentsForTool(input: unknown): Value {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Expected automation arguments object.");
  const args = { ...input } as Value;
  const modes = ["view", "delete", "create", "update", "suggested_create", "suggested_update"];
  if (!modes.includes(args.mode)) throw Error("Invalid automation mode.");
  const text = (key: string) => {
    if (typeof args[key] !== "string" || !args[key].trim()) throw Error(`Invalid ${key}.`);
    args[key] = args[key].trim();
  };
  if (["view", "delete", "update", "suggested_update"].includes(args.mode)) text("id");
  const branch = automationToolSpec.inputSchema.anyOf.find((branch: Value) =>
    (branch.properties.mode.const === args.mode || branch.properties.mode.enum?.includes(args.mode)) &&
    (!branch.properties.kind || branch.properties.kind.const === args.kind));
  if (!branch || Object.keys(args).some((key) => !(key in branch.properties))) throw Error("Unexpected automation argument.");
  if (args.mode === "view" || args.mode === "delete") return args;
  if (!["cron", "heartbeat"].includes(args.kind)) throw Error("Invalid automation kind.");
  for (const key of ["name", "prompt", "rrule"]) text(key);
  if (!["ACTIVE", "PAUSED"].includes(args.status)) throw Error("Invalid automation status.");
  if (args.notificationPolicy != null && args.notificationPolicy !== "failed_runs_only") throw Error("Invalid notificationPolicy.");
  if (args.mode === "create" && /(^|[;\n])\s*DTSTART\b/i.test(args.rrule))
    throw Error("Immediate automation creates cannot include DTSTART. Omit DTSTART, or use suggested_create for review.");
  if (args.kind === "heartbeat") {
    if (args.destination != null && !["local", "thread"].includes(args.destination)) throw Error("Invalid heartbeat destination.");
    if (args.targetThreadId == null && args.destination !== "thread") throw Error("Missing targetThreadId or destination=thread.");
    if (args.targetThreadId != null) {
      text("targetThreadId");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.targetThreadId)) throw Error("Invalid targetThreadId UUID.");
    }
  } else {
    if (args.projectId !== null) text("projectId");
    text("model");
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(args.reasoningEffort)) throw Error("Invalid reasoningEffort.");
    const creating = args.mode === "create" || args.mode === "suggested_create";
    if (!(creating ? ["local"] : ["local", "worktree"]).includes(args.executionEnvironment)) throw Error("Invalid executionEnvironment.");
    if (args.destination != null && !(creating ? ["local"] : ["local", "worktree"]).includes(args.destination)) throw Error("Invalid cron destination.");
    if (args.localEnvironmentConfigPath != null) text("localEnvironmentConfigPath");
    if (args.mode === "update" && args.executionEnvironment === "worktree" && args.localEnvironmentConfigPath !== null)
      throw Error("For safety, the model cannot immediately update a worktree automation that may run a local environment setup script. Use suggested_update so the user can review it, or set localEnvironmentConfigPath to null.");
  }
  return args;
}
function mutationParams(args: Value, sourceThreadId: string): Value {
  const updating = args.mode === "update";
  const common: Value = {
    ...(updating ? { id: args.id } : {}),
    kind: args.kind, name: args.name, prompt: args.prompt, status: args.status,
    rrule: args.rrule,
    ...(args.notificationPolicy === undefined || (!updating && args.notificationPolicy === null)
      ? {} : { notificationPolicy: args.notificationPolicy }),
  };
  return args.kind === "heartbeat" ? {
    ...common, targetThreadId: args.targetThreadId ?? sourceThreadId,
    model: null, reasoningEffort: null,
  } : {
    ...common, projectId: args.projectId, executionEnvironment: updating ? args.executionEnvironment : "local",
    localEnvironmentConfigPath: updating ? args.localEnvironmentConfigPath : null,
    model: args.model, reasoningEffort: args.reasoningEffort,
  };
}
export class AutomationAuthority {
  private adapter?: AutomationAdapter;
  private receipts: Record<string, { fingerprint: string; result?: ReturnType<typeof result> }> = {};
  constructor(private statePath: string) {
    try { this.receipts = JSON.parse(readFileSync(statePath, "utf8")).receipts; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, receipts: this.receipts }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
  private receiptKey(hostId: string, params: Value) {
    if (!params.callId || !params.threadId) throw Error("Automation mutation requires source thread and call identity.");
    return JSON.stringify([hostId, params.threadId, params.turnId ?? null, params.callId]);
  }
  private fingerprint(args: Value) {
    return createHash("sha256").update(JSON.stringify(args, Object.keys(args).sort())).digest("hex");
  }
  private prior(key: string, fingerprint: string) {
    const entry = this.receipts[key];
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) throw Error("Automation call identity was reused with different arguments.");
    return entry.result ?? result("This automation mutation was already dispatched; its outcome is unknown. It was not replayed. Inspect existing automations before deciding what to do next.", false);
  }
  private async mutate(key: string, fingerprint: string, operation: () => Promise<ReturnType<typeof result>>) {
    const prior = this.prior(key, fingerprint);
    if (prior) return prior;
    this.receipts[key] = { fingerprint };
    this.save();
    try {
      const response = await operation();
      this.receipts[key]!.result = response;
      this.save();
      return response;
    } catch (error) {
      // Native CRUD may have committed before throwing; leave durable UNKNOWN.
      return result(`Automation mutation outcome is unknown and will not be replayed. Inspect existing automations. ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }
  configure(adapter: AutomationAdapter) { this.adapter = adapter; }
  async handle(hostId: string, params: Value, signal: AbortSignal) {
    if (params.tool !== "automation_update") return null;
    try {
      signal.throwIfAborted();
      if (hostId !== "local") throw Error("Automations are only supported for local threads.");
      const adapter = this.adapter;
      if (!adapter) throw Error("Automation authority is not ready.");
      const args = argumentsForTool(typeof params.arguments === "string" ? JSON.parse(params.arguments) : params.arguments);
      if (args.mode === "view") {
        const { items } = await adapter.request("list-automations", {});
        const item = items.find((item: Value) => item.id === args.id);
        if (!item) throw Error("Automation does not exist in the app.");
        return result({ mode: "view", item });
      }
      if (args.mode === "suggested_create" || args.mode === "suggested_update")
        return result({ mode: args.mode, proposal: args, saved: false, message: "Proposed automation changes require user review before saving." });
      const key = this.receiptKey(hostId, params);
      const fingerprint = this.fingerprint(args);
      const prior = this.prior(key, fingerprint);
      if (prior) return prior;
      // Users can still remove or pause existing work when capability is revoked.
      if (args.mode === "create" || (args.mode === "update" && args.status !== "PAUSED")) {
        if (!(await adapter.capability())) throw Error("Local automations are unavailable for this account or configuration.");
      }
      signal.throwIfAborted();
      if (args.mode === "delete") return this.mutate(key, fingerprint, async () => {
        const deleted = await adapter.request("automation-delete", { id: args.id });
        if (!deleted.success) throw Error(`Automation delete failed: ${deleted.status}.`);
        return result({ automationId: args.id, mode: "delete", deleteStatus: deleted.status,
          snapshot: deleted.item == null ? null : { kind: deleted.item.kind, name: deleted.item.name, rrule: deleted.item.rrule } });
      });
      if (args.kind === "heartbeat" && args.targetThreadId == null && !params.threadId)
        throw Error("Source thread is required for destination=thread.");
      return this.mutate(key, fingerprint, async () => {
        const { item } = await adapter.request(`automation-${args.mode}`, mutationParams(args, params.threadId));
        return result({ automationId: item.id, mode: args.mode, status: item.status });
      });
    } catch (error) {
      return result(error instanceof Error ? error.message : String(error), false);
    }
  }
}
