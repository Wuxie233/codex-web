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
};
type Turn = {
  id: string;
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
  constructor(private file: string) {
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
    };
  }
  async list() {
    if (!this.scanning && !this.busy)
      this.scanning = this.discover().finally(() => {
        this.scanning = undefined;
      });
    if (this.scanning) await this.scanning;
    return this.snapshot();
  }
  private async discover() {
    for (const [host, adapter] of this.hosts) {
      if (this.discovered.has(host)) continue;
      const page = await bounded(
        adapter.listThreads({
          archived: false,
          cursor: null,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
        }),
      );
      const candidates = [...page.data];
      let incomplete = false;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (candidates.length && !this.busy) {
            const item = candidates.shift()!;
            if (item.canAcceptDirectInput === false) continue;
            try {
              const thread = await bounded(adapter.readThread(item.id), 5000);
              const last = thread?.turns?.at(-1);
              if (
                thread?.canAcceptDirectInput !== false &&
                last?.status === "failed" &&
                quota(last.error)
              )
                this.add(
                  host,
                  item.id,
                  last.id,
                  thread?.name || thread?.preview?.slice(0, 100) || item.id,
                  (thread?.updatedAt ?? Date.now() / 1000) * 1000,
                );
            } catch {
              incomplete = true;
            }
          }
        }),
      );
      if (incomplete || candidates.length) continue;
      this.discovered.add(host);
    }
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
  private async archived(adapter: Adapter, threadId: string) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { data: Thread[]; nextCursor?: string | null } =
        await bounded(
          adapter.listThreads({
            archived: true,
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
      thread.canAcceptDirectInput !== false &&
      ["idle", "notLoaded", "systemError"].includes(
        thread.status?.type ?? "",
      ) &&
      last?.id === entry.turnId &&
      last.status === "failed" &&
      quota(last.error)
    );
  }
  async resume(ids: unknown) {
    if (
      !Array.isArray(ids) ||
      !ids.every((i) => typeof i === "string")
    )
      throw Error("无效的任务列表");
    if (this.busy) return this.snapshot();
    this.busy = true;
    const quotaRevision = this.quotaRevision;
    try {
      for (const id of new Set<string>(ids)) {
        if (this.quotaRevision !== quotaRevision) break;
        const entry = this.entries.get(id);
        if (!entry || !["pending", "failed"].includes(entry.status)) continue;
        const adapter = this.hosts.get(entry.hostId);
        if (!adapter) {
          entry.status = "failed";
          entry.detail = "任务所在主机未连接";
          continue;
        }
        let dispatched = false;
        let attemptOpen = true;
        const key = this.key(entry.hostId, entry.threadId);
        let revision = this.revisions.get(key) ?? 0;
        try {
          if (await this.archived(adapter, entry.threadId)) {
            entry.status = "skipped";
            entry.detail = "任务已归档";
            continue;
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
                  this.quotaRevision !== quotaRevision
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
            : "未发送，请检查连接后重试";
          this.save();
          if (dispatched) break;
        } finally {
          attemptOpen = false;
        }
      }
      this.save();
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }
}
