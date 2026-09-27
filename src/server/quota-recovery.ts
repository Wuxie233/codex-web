import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const CONTINUATION =
  "上一轮因账号额度不足而中断，现在已切换账号，请继续之前未完成的工作。先核对当前进度和已有执行结果，再从中断处接着处理，避免重复执行已完成的操作。";
type Status =
  | "pending"
  | "sending"
  | "resumed"
  | "skipped"
  | "failed"
  | "unknown";
type Principal = { accountId: string; userId: string } | null;
type AutoAttempt = {
  host: string;
  generation: number;
  quotaRevision: number;
  attempted: Set<string>;
};
export type Entry = {
  id: string;
  hostId: string;
  threadId: string;
  turnId: string;
  title: string;
  interruptedAt: number;
  status: Status;
  detail?: string;
  clientUserMessageId?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  resolved?: boolean;
};
type Turn = {
  id: string;
  startedAt?: number | null;
  completedAt?: number | null;
  status: string;
  error?: { codexErrorInfo?: unknown };
  items?: Array<{ type: string; id?: string; clientUserMessageId?: string }>;
};
type Thread = {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  path?: string;
  updatedAt?: number;
  parentThreadId?: string | null;
  source?:
    | string
    | { subagent?: string | { thread_spawn?: { parent_thread_id?: string } } };
  canAcceptDirectInput?: boolean;
  status?: { type: string };
  turns?: Turn[];
};
export type Adapter = {
  readThread(id: string): Promise<Thread | null>;
  listThreads(
    params: Record<string, unknown>,
  ): Promise<{ data: Thread[]; nextCursor?: string | null }>;
  resumeThread(
    id: string,
    options: { cwd?: string; path?: string },
  ): Promise<unknown>;
  startTurn(
    params: Record<string, unknown>,
    beforeSend: () => void,
  ): Promise<{ turn: { id: string } }>;
};
function quota(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "codexErrorInfo" in error &&
    error.codexErrorInfo === "usageLimitExceeded"
  );
}
async function bounded<T>(promise: Promise<T>, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("请求超时")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export class QuotaRecovery {
  private entries = new Map<string, Entry>();
  private hosts = new Map<string, Adapter>();
  private revisions = new Map<string, number>();
  private quotaRevision = 0;
  private busy = false;
  private discovered = new Set<string>();
  private scanning: Promise<void> | undefined;
  private scanError: string | undefined;
  private autoResumeOnAccountSwitch = false;
  private accounts = new Map<string, string>();
  private accountGenerations = new Map<string, number>();
  private autoQueue = new Map<string, AutoAttempt>();
  private autoRunning: Promise<void> | undefined;
  private idleWaiters = new Set<() => void>();
  constructor(private file: string) {
    try {
      const settings = JSON.parse(
        readFileSync(file + ".settings.json", "utf8"),
      );
      this.autoResumeOnAccountSwitch =
        settings.autoResumeOnAccountSwitch === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const data: Entry[] = JSON.parse(readFileSync(file, "utf8"));
      for (const entry of data) {
        if (!entry.id || !entry.threadId || !entry.hostId || !entry.turnId)
          throw Error("恢复记录格式错误");
        if (entry.status === "sending") {
          entry.status = "unknown";
          entry.detail = "服务已重启，需核对发送结果";
        }
        this.entries.set(entry.id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  registerHost(host: string, adapter: Adapter) {
    this.hosts.set(host, adapter);
  }
  setAutoResume(value: unknown) {
    this.setPreference(value);
    if (!value) {
      this.autoQueue.clear();
      for (const [host, generation] of this.accountGenerations)
        this.accountGenerations.set(host, generation + 1);
    }
    return this.visibleSnapshot();
  }
  private setPreference(value: unknown) {
    if (typeof value !== "boolean") throw Error("无效的自动继续设置");
    const settings = {
      autoResumeOnAccountSwitch: value,
    };
    const file = this.file + ".settings.json";
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file + ".tmp", JSON.stringify(settings), { mode: 0o600 });
    renameSync(file + ".tmp", file);
    this.autoResumeOnAccountSwitch = value;
  }
  // Called only after the connection has read its usable authenticated principal.
  // Token refreshes and initial connection are baselines, not account switches.
  accountChanged(host: string, principal: Principal) {
    if (!principal) {
      this.accountGenerations.set(
        host,
        (this.accountGenerations.get(host) ?? 0) + 1,
      );
      this.autoQueue.delete(host);
      return this.autoRunning ?? Promise.resolve();
    }
    const identity = JSON.stringify([principal.accountId, principal.userId]);
    const previous = this.accounts.get(host);
    this.accounts.set(host, identity);
    if (!previous || previous === identity)
      return this.autoRunning ?? Promise.resolve();
    const generation = (this.accountGenerations.get(host) ?? 0) + 1;
    this.accountGenerations.set(host, generation);
    if (this.autoResumeOnAccountSwitch) {
      this.autoQueue.set(host, {
        host,
        generation,
        quotaRevision: this.quotaRevision,
        attempted: new Set(),
      });
      this.autoRunning ??= Promise.resolve()
        .then(() => this.drainAutoQueue())
        .finally(() => {
          this.autoRunning = undefined;
        });
    }
    return this.autoRunning ?? Promise.resolve();
  }
  private autoAllowed(attempt: AutoAttempt) {
    return (
      this.autoResumeOnAccountSwitch &&
      this.accountGenerations.get(attempt.host) === attempt.generation &&
      this.quotaRevision === attempt.quotaRevision
    );
  }
  private async waitUntilIdle() {
    while (this.busy || this.scanning) {
      if (this.busy)
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
      if (this.scanning) await this.scanning;
    }
  }
  private async drainAutoQueue() {
    while (this.autoQueue.size) {
      const [host, attempt] = this.autoQueue.entries().next().value!;
      this.autoQueue.delete(host);
      try {
        await this.waitUntilIdle();
        if (!this.autoAllowed(attempt)) continue;
        // Known failures can resume immediately; unopened history follows one page at a time.
        await this.resumeAutomatic(attempt);
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          await this.waitUntilIdle();
          if (!this.autoAllowed(attempt)) break;
          const adapter = this.hosts.get(host);
          if (!adapter) break;
          let next: string | null = null;
          this.scanning = (async () => {
            const page = await bounded(
              adapter.listThreads(this.historyParams(cursor)),
            );
            next = page.nextCursor ?? null;
            await this.discoverCandidates(host, adapter, page.data, () =>
              this.autoAllowed(attempt),
            );
            await this.resolveEntries();
          })().finally(() => {
            this.scanning = undefined;
          });
          await this.scanning;
          await this.resumeAutomatic(attempt);
          cursor = next;
          if (cursor && seen.has(cursor)) throw Error("重复的历史分页游标");
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch {
        this.scanError = "部分任务暂时无法读取，请检查连接后刷新。";
      }
    }
  }
  private async resumeAutomatic(attempt: AutoAttempt) {
    await this.waitUntilIdle();
    if (!this.autoAllowed(attempt)) return;
    const ids = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.hostId === attempt.host &&
          ["pending", "failed"].includes(entry.status),
      )
      .map((entry) => entry.id);
    await this.resume(ids, attempt);
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.file + ".tmp",
      JSON.stringify([...this.entries.values()]),
      { mode: 0o600 },
    );
    renameSync(this.file + ".tmp", this.file);
  }
  private key(host: string, thread: string) {
    return JSON.stringify([host, thread]);
  }
  private add(
    host: string,
    thread: string,
    turn: string,
    title = thread,
    time = Date.now(),
  ) {
    const id = JSON.stringify([host, thread, turn]);
    if (this.entries.has(id)) return;
    this.entries.set(id, {
      id,
      hostId: host,
      threadId: thread,
      turnId: turn,
      title,
      interruptedAt: time,
      status: "pending",
    });
    this.save();
  }
  observe(host: string, event: { method: string; params?: any }) {
    const p = event.params;
    if (!p?.threadId) return;
    const key = this.key(host, p.threadId);
    if (
      [
        "turn/started",
        "turn/completed",
        "thread/archived",
        "thread/deleted",
      ].includes(event.method)
    ) {
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      let changed = false;
      for (const entry of this.entries.values()) {
        if (
          entry.hostId !== host ||
          entry.threadId !== p.threadId ||
          !["pending", "failed"].includes(entry.status)
        )
          continue;
        if (
          event.method === "turn/completed" &&
          p.turn?.id === entry.turnId &&
          p.turn?.status === "failed" &&
          quota(p.turn?.error)
        )
          continue;
        entry.status = "skipped";
        changed = true;
        entry.detail = "任务状态已变化";
      }
      if (changed) this.save();
    }
    // Only terminal quota failures qualify; transient retries never enter the queue.
    if (
      event.method === "turn/completed" &&
      p.turn?.status === "failed" &&
      quota(p.turn.error)
    ) {
      this.quotaRevision++;
      this.add(host, p.threadId, p.turn.id);
    }
    if (
      event.method === "error" &&
      p.willRetry === false &&
      quota(p.error) &&
      p.turnId
    ) {
      this.quotaRevision++;
      this.add(host, p.threadId, p.turnId);
    }
  }
  snapshot() {
    return {
      entries: [...this.entries.values()]
        .sort((a, b) => b.interruptedAt - a.interruptedAt)
        .map((e) => ({ ...e })),
      busy: this.busy,
      scanning: !!this.scanning,
      scanError: this.scanError,
      autoResumeOnAccountSwitch: this.autoResumeOnAccountSwitch,
    };
  }
  async list(refresh = true) {
    if (refresh && !this.scanning && !this.busy) {
      this.scanError = undefined;
      this.scanning = this.discover()
        .catch(() => {
          this.scanError = "部分任务暂时无法读取，请检查连接后刷新。";
        })
        .finally(() => {
          this.scanning = undefined;
        });
    }
    // Return available records promptly while history discovery continues.
    if (this.scanning) await bounded(this.scanning, 1000).catch(() => {});
    return this.visibleSnapshot();
  }
  private visibleSnapshot() {
    const snapshot = this.snapshot();
    const seen = new Set<string>();
    snapshot.entries = snapshot.entries.filter((entry) => {
      const key = this.key(entry.hostId, entry.threadId);
      if (!entry.resolved || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return snapshot;
  }
  private parent(thread: Thread): string | undefined {
    if (thread.parentThreadId) return thread.parentThreadId;
    const source = thread.source;
    if (
      source &&
      typeof source === "object" &&
      typeof source.subagent === "object"
    )
      return source.subagent.thread_spawn?.parent_thread_id;
    return undefined;
  }
  private isChild(thread: Thread) {
    return (
      !!this.parent(thread) ||
      (typeof thread.source === "object" && !!thread.source?.subagent) ||
      thread.source === "subagent"
    );
  }
  private async resolveEntries() {
    const aliases = new Map<string, string>();
    for (const entry of [...this.entries.values()]) {
      if (entry.resolved) continue;
      const adapter = this.hosts.get(entry.hostId);
      if (!adapter) continue;
      let thread = await bounded(adapter.readThread(entry.threadId)).catch(
        () => null,
      );
      if (!thread) continue;
      const seen = new Set<string>();
      while (this.isChild(thread)) {
        const parent = this.parent(thread);
        if (!parent || seen.has(parent) || seen.size >= 32) {
          entry.status = "skipped";
          entry.detail = "无法确认父任务";
          break;
        }
        seen.add(thread.id);
        const next = await bounded(adapter.readThread(parent)).catch(
          () => null,
        );
        if (!next) break;
        thread = next;
      }
      if (this.isChild(thread)) continue;
      entry.title =
        thread.name || thread.preview?.slice(0, 100) || "未命名任务";
      if (thread.id === entry.threadId) {
        entry.resolved = true;
        continue;
      }
      if (["unknown", "sending", "resumed"].includes(entry.status)) continue;
      const last = thread.turns?.at(-1);
      if (!last) {
        entry.status = "skipped";
        entry.detail = "父任务没有可恢复的回合";
        continue;
      }
      const oldId = entry.id;
      const id = JSON.stringify([entry.hostId, thread.id, last.id]);
      aliases.set(oldId, id);
      const existing = this.entries.get(id);
      this.entries.delete(oldId);
      if (existing) continue;
      const continued = (last.startedAt ?? 0) * 1000 > entry.interruptedAt;
      this.entries.set(id, {
        ...entry,
        resolved: true,
        id,
        threadId: thread.id,
        turnId: last.id,
        sourceThreadId: entry.sourceThreadId ?? entry.threadId,
        sourceTurnId: entry.sourceTurnId ?? entry.turnId,
        // A later parent turn means the user has already continued this task.
        status: continued ? "skipped" : entry.status,
        detail: continued ? "父任务已继续" : entry.detail,
      });
    }
    this.save();
    return aliases;
  }
  private async discover() {
    await this.resolveEntries();
    for (const [host, adapter] of this.hosts) {
      if (this.discovered.has(host)) continue;
      const page = await bounded(
        adapter.listThreads(this.historyParams(null)),
      ).catch(() => null);
      if (!page) {
        this.scanError = "部分任务暂时无法读取，请检查连接后刷新。";
        continue;
      }
      if (
        !(await this.discoverCandidates(
          host,
          adapter,
          page.data,
          () => !this.busy,
        ))
      ) {
        this.scanError = "部分任务暂时无法读取，请检查连接后刷新。";
        continue;
      }
      this.discovered.add(host);
    }
    await this.resolveEntries();
    // Update titles and reconcile uncertain sends by their unique client message id.
    for (const entry of this.entries.values()) {
      if (!["pending", "failed", "unknown"].includes(entry.status)) continue;
      const adapter = this.hosts.get(entry.hostId);
      if (!adapter) continue;
      const thread = await bounded(adapter.readThread(entry.threadId)).catch(
        () => null,
      );
      if (thread)
        entry.title =
          thread.name || thread.preview?.slice(0, 100) || entry.title;
      if (
        entry.status === "unknown" &&
        entry.clientUserMessageId &&
        thread?.turns?.some((t) =>
          t.items?.some(
            (i) =>
              i.type === "userMessage" &&
              (i.id === entry.clientUserMessageId ||
                i.clientUserMessageId === entry.clientUserMessageId),
          ),
        )
      ) {
        entry.status = "resumed";
        entry.detail = "已核对到继续消息";
      }
    }
    this.save();
  }
  private historyParams(cursor: string | null) {
    return {
      archived: false,
      sourceKinds: [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgentThreadSpawn",
      ],
      useStateDbOnly: true,
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: [],
    };
  }
  private async discoverCandidates(
    host: string,
    adapter: Adapter,
    items: Thread[],
    proceed: () => boolean,
  ) {
    const candidates = [...items];
    let complete = true;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (candidates.length && proceed()) {
          const item = candidates.shift()!;
          try {
            const thread = await bounded(adapter.readThread(item.id), 5000);
            const last = thread?.turns?.at(-1);
            if (thread && last?.status === "failed" && quota(last.error))
              this.add(
                host,
                item.id,
                last.id,
                thread.name || thread.preview?.slice(0, 100) || item.id,
                (last.completedAt ?? thread.updatedAt ?? Date.now() / 1000) *
                  1000,
              );
          } catch {
            complete = false;
          }
        }
      }),
    );
    if (!complete) this.scanError = "部分任务暂时无法读取，请检查连接后刷新。";
    return complete && !candidates.length;
  }
  private async archived(adapter: Adapter, threadId: string) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { data: Thread[]; nextCursor?: string | null } =
        await bounded(
          adapter.listThreads({
            archived: true,
            // Avoid JSONL backfill: even one archive page can exceed the RPC timeout.
            useStateDbOnly: true,
            cursor,
            limit: 200,
            modelProviders: [],
          }),
        );
      if (page.data.some((t) => t.id === threadId)) return true;
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw Error("无法确认归档状态");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return false;
  }
  private eligible(thread: Thread | null, entry: Entry) {
    const last = thread?.turns?.at(-1);
    return (
      !!thread &&
      !this.isChild(thread) &&
      thread.canAcceptDirectInput !== false &&
      ["idle", "notLoaded", "systemError"].includes(
        thread.status?.type ?? "",
      ) &&
      last?.id === entry.turnId &&
      (entry.sourceThreadId
        ? ["failed", "completed"].includes(last.status)
        : last.status === "failed" && quota(last.error))
    );
  }
  async resume(ids: unknown, automatic?: AutoAttempt) {
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string"))
      throw Error("无效的任务列表");
    if (this.busy) return this.visibleSnapshot();
    this.busy = true;
    const quotaRevision = this.quotaRevision;
    try {
      if (this.scanning) await this.scanning;
      const aliases = await this.resolveEntries();
      for (const id of new Set<string>(
        ids.map((id) => aliases.get(id) ?? id),
      )) {
        if (this.quotaRevision !== quotaRevision) break;
        if (automatic && !this.autoAllowed(automatic)) break;
        const entry = this.entries.get(id);
        if (!entry || !["pending", "failed"].includes(entry.status)) continue;
        if (automatic?.attempted.has(entry.id)) continue;
        automatic?.attempted.add(entry.id);
        const adapter = this.hosts.get(entry.hostId);
        if (!adapter) {
          entry.status = "failed";
          entry.detail = "任务所在主机未连接";
          continue;
        }
        let stage = "检查归档状态";
        let dispatched = false;
        let attemptOpen = true;
        const key = this.key(entry.hostId, entry.threadId);
        const revision = this.revisions.get(key) ?? 0;
        const sourceKey = entry.sourceThreadId
          ? this.key(entry.hostId, entry.sourceThreadId)
          : key;
        const sourceRevision = this.revisions.get(sourceKey) ?? 0;
        try {
          if (await this.archived(adapter, entry.threadId)) {
            entry.status = "skipped";
            entry.detail = "任务已归档";
            continue;
          }
          stage = "读取任务";
          if (entry.sourceThreadId) {
            const source = await bounded(
              adapter.readThread(entry.sourceThreadId),
            );
            const last = source?.turns?.at(-1);
            if (
              !last ||
              last.id !== entry.sourceTurnId ||
              last.status !== "failed" ||
              !quota(last.error)
            ) {
              entry.status = "skipped";
              entry.detail = "子任务状态已变化";
              continue;
            }
          }
          let thread = await bounded(adapter.readThread(entry.threadId));
          if (!this.eligible(thread, entry)) {
            entry.status = "skipped";
            entry.detail = "任务已继续、停止或完成";
            continue;
          }
          entry.title =
            thread!.name || thread!.preview?.slice(0, 100) || entry.title;
          if (thread!.status?.type === "notLoaded") {
            stage = "加载任务";
            await bounded(
              adapter.resumeThread(entry.threadId, {
                cwd: thread!.cwd,
                path: thread!.path,
              }),
            );
            thread = await bounded(adapter.readThread(entry.threadId));
          }
          if (
            !this.eligible(thread, entry) ||
            revision !== (this.revisions.get(key) ?? 0) ||
            !["pending", "failed"].includes(entry.status)
          ) {
            entry.status = "skipped";
            entry.detail = "任务状态已变化";
            continue;
          }
          stage = "准备发送";
          const messageId = randomUUID();
          await bounded(
            adapter.startTurn(
              {
                threadId: entry.threadId,
                input: [
                  { type: "text", text: CONTINUATION, text_elements: [] },
                ],
                clientUserMessageId: messageId,
              },
              () => {
                if (
                  !attemptOpen ||
                  revision !== (this.revisions.get(key) ?? 0) ||
                  sourceRevision !== (this.revisions.get(sourceKey) ?? 0) ||
                  this.quotaRevision !== quotaRevision ||
                  (automatic && !this.autoAllowed(automatic))
                )
                  throw Error("任务状态已变化，请刷新列表");
                entry.status = "sending";
                entry.clientUserMessageId = messageId;
                delete entry.detail;
                this.save(); // Persist before dispatch. A crash or timeout must never cause an automatic replay.
                dispatched = true;
              },
            ),
            45000,
          );
          entry.status = "resumed";
          entry.detail = "已开始继续";
          this.save();
          // Give immediate quota failures time to arrive before dispatching the next task.
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch (error) {
          attemptOpen = false;
          entry.status = dispatched ? "unknown" : "failed";
          entry.detail = dispatched
            ? "发送结果不明，刷新列表核对；不会自动重发"
            : `未发送：${stage}失败，请刷新后重试`;
          this.save();
          if (dispatched) break;
        } finally {
          attemptOpen = false;
        }
      }
      this.save();
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
    return this.visibleSnapshot();
  }
}
