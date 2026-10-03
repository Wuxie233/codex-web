import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RATE_LIMIT_CONTINUATION,
  RATE_LIMIT_DELAYS,
  recoveryReason,
  recoveryClock,
  type RecoveryReason,
  type RecoveryClock,
  type RateLimitChain,
} from "./rate-limit-recovery";
export { RATE_LIMIT_CONTINUATION } from "./rate-limit-recovery";

export const CONTINUATION =
  "刚刚因账号额度不足而中断，现在账号已更新或额度已恢复，请直接从中断处正常继续。这条消息仅用于恢复执行，不是新任务，无需为此整理或汇报当前内容。若有中断的子 agent，请优先向原子 agent 续发消息，让它从原上下文继续，不要仅因这次中断新建替代 agent。";
const RATE_SCAN_INTERVAL = 30000;
const RATE_SCAN_OVERLAP = 60;
const RATE_FULL_SCAN_INTERVAL = 300000;
type Status =
  | "pending"
  | "sending"
  | "resumed"
  | "skipped"
  | "failed"
  | "unknown";
type Principal = { accountId: string; userId: string } | null;
type UsageState = "exhausted" | "available" | "unknown";
type AccountUpdate = {
  identity: string | undefined;
  exhausted: boolean;
  generation: number;
  quotaRevision: number;
};
function identityOf(principal: NonNullable<Principal>) {
  return JSON.stringify([principal.accountId, principal.userId]);
}
function usageState(
  principal: NonNullable<Principal>,
  value: unknown,
): UsageState {
  if (!value || typeof value !== "object") return "unknown";
  const response = value as Record<string, any>;
  if (response.accountId !== principal.accountId) return "unknown";
  const limits = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (!limits || (limits.limitId != null && limits.limitId !== "codex"))
    return "unknown";
  const windows = [limits.primary, limits.secondary].filter((w) => w != null);
  if (
    !windows.length ||
    windows.some(
      (w) =>
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0 ||
        w.usedPercent > 100,
    )
  )
    return "unknown";
  const exhausted = windows.some((w) => w.usedPercent === 100);
  if (response.ordinaryUsageAllowed === false && exhausted) return "exhausted";
  if (
    response.ordinaryUsageAllowed === true &&
    !exhausted &&
    limits.spendControlReached !== true
  )
    return "available";
  return "unknown";
}
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
  reason?: RecoveryReason;
  retryAt?: number;
  autoRetryCount?: number;
};
type Turn = {
  id: string;
  startedAt?: number | null;
  completedAt?: number | null;
  status: string;
  error?: {
    codexErrorInfo?: unknown;
    message?: string;
    [key: string]: unknown;
  };
  items?: Array<{
    type: string;
    id?: string;
    clientId?: string | null;
    clientUserMessageId?: string;
  }>;
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
  private accountUsage = new Map<string, UsageState>();
  private preAuthUsage = new Map<string, UsageState>();
  private accountUpdates = new Map<string, AccountUpdate>();
  private accountGenerations = new Map<string, number>();
  private autoQueue = new Map<string, AutoAttempt>();
  private autoRunning: Promise<void> | undefined;
  private idleWaiters = new Set<() => void>();
  private autoResumeOn429 = false;
  private rateLimitMaxRetries = 3;
  private rateGeneration = 0;
  private disposed = false;
  private rateChains = new Map<string, RateLimitChain>();
  private rateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rateInFlight = new Set<string>();
  private rateScanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rateScanSince = new Map<string, number>();
  private rateFullScanAt = new Map<string, number>();
  constructor(
    private file: string,
    private clock: RecoveryClock = recoveryClock,
  ) {
    try {
      const settings = JSON.parse(
        readFileSync(file + ".settings.json", "utf8"),
      );
      this.autoResumeOnAccountSwitch =
        settings.autoResumeOnAccountSwitch === true;
      this.autoResumeOn429 = settings.autoResumeOn429 === true;
      if (settings.rateLimitMaxRetries !== undefined) {
        this.validateRateLimitMaxRetries(settings.rateLimitMaxRetries);
        this.rateLimitMaxRetries = settings.rateLimitMaxRetries;
      }
      for (const [key, chain] of Object.entries(
        settings.rateLimitChains ?? {},
      )) {
        const value = chain as RateLimitChain;
        if (
          !Number.isSafeInteger(value.count) ||
          value.count < 0 ||
          typeof value.failedTurnId !== "string"
        )
          throw Error("限流恢复记录格式错误");
        this.rateChains.set(key, value);
      }
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
        if (entry.reason === "rateLimit" && entry.status === "unknown") {
          const chain = this.rateChains.get(
            this.key(entry.hostId, entry.threadId),
          );
          if (chain && chain.clientUserMessageId === entry.clientUserMessageId)
            chain.blocked = true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  registerHost(host: string, adapter: Adapter) {
    this.unregisterHost(host);
    this.hosts.set(host, adapter);
    if (this.autoResumeOn429) {
      this.scheduleRateEntries();
      this.startRateScan(host);
    }
  }
  unregisterHost(host: string) {
    this.hosts.delete(host);
    this.discovered.delete(host);
    this.rateScanSince.delete(host);
    this.rateFullScanAt.delete(host);
    const scanTimer = this.rateScanTimers.get(host);
    if (scanTimer) this.clock.clearTimeout(scanTimer);
    this.rateScanTimers.delete(host);
    for (const [id, timer] of this.rateTimers) {
      if (this.entries.get(id)?.hostId !== host) continue;
      this.clock.clearTimeout(timer);
      this.rateTimers.delete(id);
    }
  }
  setAutoResume(value: unknown) {
    this.setPreference(value);
    if (!value) {
      this.autoQueue.clear();
      this.accountUpdates.clear();
      for (const [host, generation] of this.accountGenerations)
        this.accountGenerations.set(host, generation + 1);
    }
    return this.visibleSnapshot();
  }
  private persistSettings(
    account = this.autoResumeOnAccountSwitch,
    rate = this.autoResumeOn429,
    maxRetries = this.rateLimitMaxRetries,
  ) {
    const settings = {
      autoResumeOnAccountSwitch: account,
      autoResumeOn429: rate,
      rateLimitMaxRetries: maxRetries,
      rateLimitChains: Object.fromEntries(this.rateChains),
    };
    const file = this.file + ".settings.json";
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file + ".tmp", JSON.stringify(settings), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  private setPreference(value: unknown) {
    if (typeof value !== "boolean") throw Error("无效的自动继续设置");
    this.persistSettings(value);
    this.autoResumeOnAccountSwitch = value;
  }
  setAutoResume429(value: unknown) {
    if (typeof value !== "boolean") throw Error("无效的自动继续设置");
    this.persistSettings(this.autoResumeOnAccountSwitch, value);
    if (value !== this.autoResumeOn429) {
      this.autoResumeOn429 = value;
      this.rateGeneration++;
      this.cancelRateTimers();
      this.cancelRateScans();
      if (value) {
        this.scheduleRateEntries();
        for (const host of this.hosts.keys()) this.startRateScan(host);
      }
    }
    return this.visibleSnapshot();
  }
  private validateRateLimitMaxRetries(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw Error("重试次数必须为非负整数（0 表示无限）");
  }
  private rateBudgetAvailable(count: number) {
    return this.rateLimitMaxRetries === 0 || count < this.rateLimitMaxRetries;
  }
  private rateDelay(count: number) {
    return RATE_LIMIT_DELAYS[Math.min(count, RATE_LIMIT_DELAYS.length - 1)]!;
  }
  setRateLimitMaxRetries(value: unknown) {
    this.validateRateLimitMaxRetries(value);
    this.persistSettings(
      this.autoResumeOnAccountSwitch,
      this.autoResumeOn429,
      value,
    );
    if (value !== this.rateLimitMaxRetries) {
      this.rateLimitMaxRetries = value;
      this.rateGeneration++;
      this.cancelRateTimers();
      this.cancelRateScans();
      for (const entry of this.entries.values()) {
        if (entry.reason !== "rateLimit" || entry.status !== "pending")
          continue;
        const chain = this.rateChains.get(
          this.key(entry.hostId, entry.threadId),
        );
        if (!chain || chain.blocked || chain.failedTurnId !== entry.turnId)
          continue;
        if (this.rateBudgetAvailable(chain.count)) {
          entry.retryAt ??= this.clock.now() + this.rateDelay(chain.count);
          delete entry.detail;
        } else {
          delete entry.retryAt;
          entry.detail = `已达到连续自动重试上限（${value}次）`;
        }
      }
      this.save();
      this.scheduleRateEntries();
      if (this.autoResumeOn429)
        for (const host of this.hosts.keys()) this.startRateScan(host);
    }
    return this.visibleSnapshot();
  }
  private cancelRateTimers() {
    for (const timer of this.rateTimers.values())
      this.clock.clearTimeout(timer);
    this.rateTimers.clear();
  }
  private cancelRateScans() {
    for (const timer of this.rateScanTimers.values())
      this.clock.clearTimeout(timer);
    this.rateScanTimers.clear();
    this.rateScanSince.clear();
    this.rateFullScanAt.clear();
  }
  // Explicit cleanup is useful to embedders; timers never keep the server alive.
  dispose() {
    this.disposed = true;
    this.rateGeneration++;
    this.cancelRateTimers();
    this.cancelRateScans();
  }
  private startRateScan(host: string) {
    const generation = this.rateGeneration;
    const adapter = this.hosts.get(host);
    const allowed = () =>
      !this.disposed &&
      this.autoResumeOn429 &&
      generation === this.rateGeneration &&
      this.hosts.get(host) === adapter;
    if (!adapter || !allowed()) return;
    const startedAt = this.clock.now();
    const full =
      startedAt - (this.rateFullScanAt.get(host) ?? -Infinity) >=
      RATE_FULL_SCAN_INTERVAL;
    const since = full ? undefined : this.rateScanSince.get(host);
    let newest = since ?? -Infinity;
    void (async () => {
      let cursor: string | null = null;
      let complete = true;
      const seen = new Set<string>();
      do {
        await this.waitUntilIdle();
        if (!allowed()) return;
        while (this.busy || this.scanning) await this.waitUntilIdle();
        if (!allowed()) return;
        this.scanning = (async () => {
          await this.resolveEntries();
          if (!allowed()) return;
          const page = await bounded(
            adapter.listThreads(this.historyParams(cursor)),
          );
          if (!allowed()) return;
          // Use host timestamps to avoid clock skew; periodic full scans cover late indexing.
          for (const thread of page.data) {
            if (
              typeof thread.updatedAt === "number" &&
              Number.isFinite(thread.updatedAt)
            )
              newest = Math.max(newest, thread.updatedAt);
          }
          // History is sorted newest first. Overlap covers second-resolution timestamps.
          const candidates =
            since === undefined
              ? page.data
              : page.data.filter(
                  (thread) =>
                    typeof thread.updatedAt !== "number" ||
                    !Number.isFinite(thread.updatedAt) ||
                    thread.updatedAt >= since - RATE_SCAN_OVERLAP,
                );
          cursor =
            candidates.length < page.data.length &&
            page.data.every(
              (thread) =>
                typeof thread.updatedAt === "number" &&
                Number.isFinite(thread.updatedAt),
            )
              ? null
              : (page.nextCursor ?? null);
          if (
            !(await this.discoverCandidates(
              host,
              adapter,
              candidates,
              () => allowed() && !this.busy,
            ))
          )
            complete = false;
          if (allowed()) await this.resolveEntries();
        })().finally(() => {
          this.scanning = undefined;
        });
        await this.scanning;
        if (!allowed()) return;
        this.scheduleRateEntries();
        if (cursor && seen.has(cursor)) throw Error("重复的历史分页游标");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (complete && allowed()) {
        if (Number.isFinite(newest)) this.rateScanSince.set(host, newest);
        if (full) this.rateFullScanAt.set(host, startedAt);
      }
    })()
      .catch(() => {
        if (allowed())
          this.scanError = "部分任务暂时无法读取，后台将自动重试。";
      })
      .finally(() => {
        if (!allowed()) return;
        const timer = this.clock.setTimeout(() => {
          this.rateScanTimers.delete(host);
          this.startRateScan(host);
        }, RATE_SCAN_INTERVAL);
        timer.unref?.();
        this.rateScanTimers.set(host, timer);
      });
  }
  private scheduleRateEntries() {
    if (!this.autoResumeOn429 || this.disposed) return;
    for (const entry of this.entries.values()) {
      if (
        entry.reason !== "rateLimit" ||
        entry.status !== "pending" ||
        entry.retryAt === undefined ||
        this.rateTimers.has(entry.id) ||
        !this.hosts.has(entry.hostId)
      )
        continue;
      const chain = this.rateChains.get(this.key(entry.hostId, entry.threadId));
      if (!chain || chain.blocked || !this.rateBudgetAvailable(chain.count))
        continue;
      const generation = this.rateGeneration;
      const quotaRevision = this.quotaRevision;
      const timer = this.clock.setTimeout(
        () => {
          this.rateTimers.delete(entry.id);
          void (async () => {
            await this.waitUntilIdle(false);
            if (!this.rateAllowed(entry, generation, quotaRevision)) return;
            await this.resume([entry.id], undefined, {
              generation,
              quotaRevision,
            });
          })().catch(() => {
            this.scanError = "限流任务暂时无法继续，请刷新后检查。";
          });
        },
        Math.max(0, entry.retryAt - this.clock.now()),
      );
      timer.unref?.();
      this.rateTimers.set(entry.id, timer);
    }
  }
  private rateAllowed(entry: Entry, generation: number, quotaRevision: number) {
    const chain = this.rateChains.get(this.key(entry.hostId, entry.threadId));
    return (
      !this.disposed &&
      this.hosts.has(entry.hostId) &&
      this.autoResumeOn429 &&
      generation === this.rateGeneration &&
      quotaRevision === this.quotaRevision &&
      entry.reason === "rateLimit" &&
      entry.status === "pending" &&
      entry.retryAt !== undefined &&
      entry.retryAt <= this.clock.now() &&
      !!chain &&
      !chain.blocked &&
      this.rateBudgetAvailable(chain.count)
    );
  }
  // Called only after the connection has read its usable authenticated principal.
  // Token refreshes and initial connection are baselines, not account switches.
  accountChanged(host: string, principal: Principal) {
    if (!principal) {
      // Principal refresh can read the new quota before account/updated arrives.
      this.preAuthUsage.set(host, this.accountUsage.get(host) ?? "unknown");
      this.accountUpdates.delete(host);
      this.accountGenerations.set(
        host,
        (this.accountGenerations.get(host) ?? 0) + 1,
      );
      this.autoQueue.delete(host);
      return this.autoRunning ?? Promise.resolve();
    }
    const identity = identityOf(principal);
    const previous = this.accounts.get(host);
    this.accounts.set(host, identity);
    if (!previous || previous === identity)
      return this.autoRunning ?? Promise.resolve();
    this.accountUsage.delete(host);
    this.preAuthUsage.delete(host);
    this.accountUpdates.delete(host);
    return this.queueAccountRecovery(host);
  }
  // Usage reads alone never start work, including a periodic zero-to-positive update.
  accountRateLimitsRead(host: string, principal: Principal, response: unknown) {
    if (!principal || this.accounts.get(host) !== identityOf(principal)) return;
    this.accountUsage.set(host, usageState(principal, response));
  }
  // Native account/updated invalidates its principal cache before notifying us.
  // Keep the prior usage baseline across that temporary null principal.
  beginAccountUpdate(host: string): AccountUpdate {
    const update: AccountUpdate = {
      identity: this.accounts.get(host),
      exhausted:
        (this.preAuthUsage.get(host) ?? this.accountUsage.get(host)) === "exhausted",
      generation: this.accountGenerations.get(host) ?? 0,
      quotaRevision: this.quotaRevision,
    };
    this.accountUpdates.set(host, update);
    this.preAuthUsage.delete(host);
    this.accountUsage.delete(host);
    return update;
  }
  completeAccountUpdate(
    host: string,
    update: AccountUpdate,
    principal: Principal,
    response: unknown,
  ) {
    if (this.accountUpdates.get(host) !== update)
      return this.autoRunning ?? Promise.resolve();
    this.accountUpdates.delete(host);
    this.accountRateLimitsRead(host, principal, response);
    if (
      !principal ||
      update.identity !== identityOf(principal) ||
      !update.exhausted ||
      this.accountUsage.get(host) !== "available" ||
      update.generation !== (this.accountGenerations.get(host) ?? 0) ||
      update.quotaRevision !== this.quotaRevision
    )
      return this.autoRunning ?? Promise.resolve();
    return this.queueAccountRecovery(host);
  }
  private queueAccountRecovery(host: string) {
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
  private async waitUntilIdle(includeScanning = true) {
    while (this.busy || (includeScanning && this.scanning)) {
      if (this.busy)
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
      if (includeScanning && this.scanning) await this.scanning;
    }
  }
  private async drainAutoQueue() {
    while (this.autoQueue.size) {
      const [host, attempt] = this.autoQueue.entries().next().value!;
      this.autoQueue.delete(host);
      try {
        await this.waitUntilIdle(false);
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
            await this.discoverCandidates(
              host,
              adapter,
              page.data,
              () => this.autoAllowed(attempt) && !this.busy,
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
    await this.waitUntilIdle(false);
    if (!this.autoAllowed(attempt)) return;
    const ids = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.hostId === attempt.host &&
          entry.reason !== "rateLimit" &&
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
    time = this.clock.now(),
    reason: RecoveryReason = "quota",
  ) {
    const id = JSON.stringify([host, thread, turn]);
    const previous = this.entries.get(id);
    if (previous) {
      if (
        reason === "quota" &&
        previous.reason === "rateLimit" &&
        !["sending", "unknown", "resumed"].includes(previous.status)
      ) {
        previous.reason = "quota";
        previous.status = "pending";
        delete previous.retryAt;
        delete previous.autoRetryCount;
        this.save();
      }
      return;
    }
    const key = this.key(host, thread);
    let chain = this.rateChains.get(key);
    if (reason === "rateLimit") {
      if (!chain) {
        chain = { count: 0, failedTurnId: turn };
        this.rateChains.set(key, chain);
      }
      chain.failedTurnId = turn;
      this.persistSettings();
    }
    this.entries.set(id, {
      id,
      hostId: host,
      threadId: thread,
      turnId: turn,
      title,
      interruptedAt: time,
      status: "pending",
      reason,
      ...(reason === "rateLimit"
        ? {
            autoRetryCount: chain!.count,
            retryAt:
              !chain!.blocked && this.rateBudgetAvailable(chain!.count)
                ? Math.max(time, this.clock.now()) +
                  this.rateDelay(chain!.count)
                : undefined,
            detail: !this.rateBudgetAvailable(chain!.count)
              ? `已达到连续自动重试上限（${this.rateLimitMaxRetries}次）`
              : undefined,
          }
        : {}),
    });
    this.save();
    this.scheduleRateEntries();
  }
  private ownMessage(host: string, thread: string, turn?: Turn) {
    return (
      turn?.items?.some(
        (item) =>
          item.type === "userMessage" &&
          [...this.entries.values()].some(
            (entry) =>
              entry.hostId === host &&
              entry.threadId === thread &&
              !!entry.clientUserMessageId &&
              (item.clientId === entry.clientUserMessageId ||
                item.clientUserMessageId === entry.clientUserMessageId ||
                item.id === entry.clientUserMessageId),
          ),
      ) ?? false
    );
  }
  private manualMessage(host: string, thread: string, turn?: Turn) {
    return (
      !!turn?.items?.some(
        (item) =>
          item.type === "userMessage" &&
          (item.clientId || item.clientUserMessageId || item.id),
      ) && !this.ownMessage(host, thread, turn)
    );
  }
  private reconcileRateChain(host: string, thread: Thread) {
    const key = this.key(host, thread.id);
    const chain = this.rateChains.get(key);
    const last = thread.turns?.at(-1);
    if (!chain || !last || this.rateInFlight.has(key)) return;
    if (
      last.status === "completed" ||
      (last.id !== chain.failedTurnId &&
        last.id !== chain.continuationTurnId &&
        this.manualMessage(host, thread.id, last))
    ) {
      this.rateChains.delete(key);
      this.persistSettings();
    }
  }
  observe(host: string, event: { method: string; params?: any }) {
    const p = event.params;
    if (!p?.threadId) return;
    const key = this.key(host, p.threadId);
    const turnId = p.turn?.id ?? p.turnId;
    const reason = recoveryReason(p.turn?.error ?? p.error);
    const terminal =
      (event.method === "turn/completed" && p.turn?.status === "failed") ||
      (event.method === "error" && p.willRetry === false);
    if (event.method === "error" && terminal)
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    const chain = this.rateChains.get(key);
    if (chain) {
      if (
        event.method === "turn/started" &&
        this.rateInFlight.has(key) &&
        turnId
      ) {
        chain.continuationTurnId = turnId;
        this.persistSettings();
      }
      const ownTurn =
        turnId === chain.continuationTurnId ||
        this.ownMessage(host, p.threadId, p.turn);
      const uncertain =
        !!chain.blocked &&
        [...this.entries.values()].some(
          (entry) =>
            entry.hostId === host &&
            entry.threadId === p.threadId &&
            entry.status === "unknown" &&
            entry.clientUserMessageId === chain.clientUserMessageId,
        );
      const confirmedManual = this.manualMessage(host, p.threadId, p.turn);
      if (
        event.method === "turn/started" &&
        !ownTurn &&
        !this.rateInFlight.has(key) &&
        (!uncertain || confirmedManual)
      ) {
        this.rateChains.delete(key); // A confirmed human/new non-recovery turn resets the chain.
        this.persistSettings();
      } else if (
        event.method === "turn/completed" &&
        p.turn?.status === "completed" &&
        (ownTurn || turnId === chain.failedTurnId)
      ) {
        this.rateChains.delete(key);
        this.persistSettings();
      } else if (
        event.method === "thread/archived" ||
        event.method === "thread/deleted" ||
        (event.method === "turn/completed" && p.turn?.status === "interrupted")
      ) {
        chain.blocked = true;
        this.persistSettings();
      }
    }
    if (
      [
        "turn/started",
        "turn/completed",
        "thread/archived",
        "thread/deleted",
      ].includes(event.method)
    ) {
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      for (const entry of this.entries.values()) {
        if (
          entry.hostId !== host ||
          entry.threadId !== p.threadId ||
          !["pending", "failed"].includes(entry.status)
        )
          continue;
        if (
          terminal &&
          turnId === entry.turnId &&
          reason === (entry.reason ?? "quota")
        )
          continue;
        entry.status = "skipped";
        delete entry.retryAt;
        entry.detail = "任务状态已变化";
        const timer = this.rateTimers.get(entry.id);
        if (timer) this.clock.clearTimeout(timer);
        this.rateTimers.delete(entry.id);
      }
      this.save();
    }
    if (!terminal || !reason || !turnId) return;
    if (reason === "quota") {
      this.quotaRevision++;
      this.cancelRateTimers();
      for (const [chainKey, state] of this.rateChains) {
        state.blocked = true;
        for (const entry of this.entries.values())
          if (
            entry.reason === "rateLimit" &&
            this.key(entry.hostId, entry.threadId) === chainKey
          )
            delete entry.retryAt;
      }
      this.persistSettings();
    }
    this.add(host, p.threadId, turnId, p.threadId, this.clock.now(), reason);
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
      autoResumeOn429: this.autoResumeOn429,
      rateLimitMaxRetries: this.rateLimitMaxRetries,
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
  private async resolveEntries(
    ids?: string[],
    proceed: () => boolean = () => !this.busy,
  ) {
    const aliases = new Map<string, string>();
    const entries = ids
      ? ids.map((id) => this.entries.get(id)).filter((e): e is Entry => !!e)
      : [...this.entries.values()];
    for (const entry of entries) {
      if (!proceed()) break;
      if (entry.resolved) continue;
      const adapter = this.hosts.get(entry.hostId);
      if (!adapter) continue;
      const status = entry.status;
      const revisions = new Map<string, number>();
      const current = () =>
        proceed() &&
        this.hosts.get(entry.hostId) === adapter &&
        this.entries.get(entry.id) === entry &&
        !entry.resolved &&
        entry.status === status &&
        [...revisions].every(
          ([key, revision]) => revision === (this.revisions.get(key) ?? 0),
        );
      const read = (id: string) => {
        const key = this.key(entry.hostId, id);
        revisions.set(key, this.revisions.get(key) ?? 0);
        return bounded(adapter.readThread(id)).catch(() => null);
      };
      let thread = await read(entry.threadId);
      if (!thread || !current()) continue;
      const seen = new Set<string>();
      while (this.isChild(thread)) {
        const parent = this.parent(thread);
        if (!parent || seen.has(parent) || seen.size >= 32) {
          entry.status = "skipped";
          entry.detail = "无法确认父任务";
          break;
        }
        seen.add(thread.id);
        const next = await read(parent);
        if (!next || !current()) break;
        thread = next;
      }
      if (!current() || this.isChild(thread)) continue;
      entry.title =
        thread.name || thread.preview?.slice(0, 100) || "未命名任务";
      if (thread.id === entry.threadId) {
        entry.resolved = true;
        continue;
      }
      if (["unknown", "sending", "resumed", "skipped"].includes(entry.status))
        continue;
      const last = thread.turns?.at(-1);
      if (
        !last ||
        (entry.reason === "rateLimit" &&
          (last.status !== "failed" ||
            recoveryReason(last.error) !== "rateLimit"))
      ) {
        entry.status = "skipped";
        entry.detail = "父任务没有可恢复的回合";
        continue;
      }
      const continued = (last.startedAt ?? 0) * 1000 > entry.interruptedAt;
      if (entry.reason === "rateLimit" && !continued) {
        this.reconcileRateChain(entry.hostId, thread);
        const rootKey = this.key(entry.hostId, thread.id);
        // The directly writable root owns the budget. Child-local metadata must
        // not revive an old chain or lower the root's backoff.
        const rootChain = this.rateChains.get(rootKey) ?? {
          count: 0,
          failedTurnId: last.id,
        };
        rootChain.failedTurnId = last.id;
        this.rateChains.set(rootKey, rootChain);
        const sourceDelay = this.rateDelay(entry.autoRetryCount ?? 0);
        const retryBase =
          entry.retryAt !== undefined && sourceDelay !== undefined
            ? entry.retryAt - sourceDelay
            : this.clock.now();
        entry.autoRetryCount = rootChain.count;
        entry.retryAt =
          !rootChain.blocked && this.rateBudgetAvailable(rootChain.count)
            ? Math.max(
                entry.retryAt ?? 0,
                retryBase + this.rateDelay(rootChain.count),
              )
            : undefined;
        this.persistSettings();
      }
      const oldId = entry.id;
      const id = JSON.stringify([entry.hostId, thread.id, last.id]);
      aliases.set(oldId, id);
      const existing = this.entries.get(id);
      this.entries.delete(oldId);
      if (existing) continue;
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
      if (this.busy) break;
      if (!["pending", "failed", "unknown"].includes(entry.status)) continue;
      const adapter = this.hosts.get(entry.hostId);
      if (!adapter) continue;
      const key = this.key(entry.hostId, entry.threadId);
      const revision = this.revisions.get(key) ?? 0;
      const status = entry.status;
      const thread = await bounded(adapter.readThread(entry.threadId)).catch(
        () => null,
      );
      if (
        this.busy ||
        this.hosts.get(entry.hostId) !== adapter ||
        this.entries.get(entry.id) !== entry ||
        entry.status !== status ||
        revision !== (this.revisions.get(key) ?? 0)
      )
        continue;
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
                i.clientId === entry.clientUserMessageId ||
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
          const key = this.key(host, item.id);
          const revision = this.revisions.get(key) ?? 0;
          try {
            const thread = await bounded(adapter.readThread(item.id), 5000);
            if (
              !thread ||
              this.hosts.get(host) !== adapter ||
              !proceed() ||
              revision !== (this.revisions.get(key) ?? 0)
            ) {
              complete = false;
              continue;
            }
            if (thread) this.reconcileRateChain(host, thread);
            const last = thread?.turns?.at(-1);
            const reason = recoveryReason(last?.error);
            if (thread && last?.status === "failed" && reason)
              this.add(
                host,
                item.id,
                last.id,
                thread.name || thread.preview?.slice(0, 100) || item.id,
                (last.completedAt ??
                  thread.updatedAt ??
                  this.clock.now() / 1000) * 1000,
                reason,
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
      (entry.sourceThreadId && entry.reason !== "rateLimit"
        ? ["failed", "completed"].includes(last.status)
        : last.status === "failed" &&
          recoveryReason(last.error) === (entry.reason ?? "quota"))
    );
  }
  async resume(
    ids: unknown,
    automatic?: AutoAttempt,
    rateAttempt?: { generation: number; quotaRevision: number },
  ) {
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string"))
      throw Error("无效的任务列表");
    if (this.busy) return this.visibleSnapshot();
    this.busy = true;
    const quotaRevision = this.quotaRevision;
    try {
      // History discovery must never hold up an explicitly selected continuation.
      const aliases = await this.resolveEntries(ids, () => true);
      for (const id of new Set<string>(
        ids.map((id) => aliases.get(id) ?? id),
      )) {
        if (this.quotaRevision !== quotaRevision) break;
        if (automatic && !this.autoAllowed(automatic)) break;
        const entry = this.entries.get(id);
        if (!entry || !["pending", "failed"].includes(entry.status)) continue;
        if (automatic && entry.reason === "rateLimit") continue;
        if (
          rateAttempt &&
          !this.rateAllowed(
            entry,
            rateAttempt.generation,
            rateAttempt.quotaRevision,
          )
        )
          continue;
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
        let cancelledByRatePreference = false;
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
              recoveryReason(last.error) !== (entry.reason ?? "quota")
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
          const result = await bounded(
            adapter.startTurn(
              {
                threadId: entry.threadId,
                input: [
                  {
                    type: "text",
                    text:
                      entry.reason === "rateLimit"
                        ? RATE_LIMIT_CONTINUATION
                        : CONTINUATION,
                    text_elements: [],
                  },
                ],
                clientUserMessageId: messageId,
              },
              () => {
                if (
                  rateAttempt &&
                  (this.disposed || this.hosts.get(entry.hostId) !== adapter)
                ) {
                  cancelledByRatePreference = true;
                  throw Error("任务所在主机未连接");
                }
                if (
                  !attemptOpen ||
                  this.hosts.get(entry.hostId) !== adapter ||
                  revision !== (this.revisions.get(key) ?? 0) ||
                  sourceRevision !== (this.revisions.get(sourceKey) ?? 0) ||
                  this.quotaRevision !== quotaRevision ||
                  (automatic && !this.autoAllowed(automatic)) ||
                  !["pending", "failed"].includes(entry.status)
                )
                  throw Error("任务状态已变化，请刷新列表");
                if (
                  rateAttempt &&
                  !this.rateAllowed(
                    entry,
                    rateAttempt.generation,
                    rateAttempt.quotaRevision,
                  )
                ) {
                  cancelledByRatePreference =
                    !this.autoResumeOn429 ||
                    rateAttempt.generation !== this.rateGeneration;
                  throw Error("自动继续设置已变化");
                }
                if (!automatic && !rateAttempt && this.rateChains.has(key)) {
                  this.rateChains.set(key, {
                    count: 0,
                    failedTurnId: entry.turnId,
                  });
                  entry.autoRetryCount = 0;
                  this.persistSettings();
                }
                if (rateAttempt) {
                  const chain = this.rateChains.get(key)!;
                  chain.count++;
                  chain.clientUserMessageId = messageId;
                  delete chain.continuationTurnId;
                  entry.autoRetryCount = chain.count;
                  this.persistSettings(); // Consume budget before any possible write to the transport.
                }
                const chain = this.rateChains.get(key);
                if (chain) {
                  chain.clientUserMessageId = messageId;
                  this.persistSettings();
                  this.rateInFlight.add(key);
                }
                entry.status = "sending";
                delete entry.retryAt;
                entry.clientUserMessageId = messageId;
                delete entry.detail;
                this.save(); // Persist before dispatch. A crash or timeout must never cause an automatic replay.
                dispatched = true;
              },
            ),
            45000,
          );
          if (this.rateChains.has(key)) {
            const chain = this.rateChains.get(key);
            if (chain) {
              chain.continuationTurnId = result.turn.id;
              this.persistSettings();
            }
          }
          entry.status = "resumed";
          entry.detail = "已开始继续";
          this.save();
          // Give immediate quota failures time to arrive before dispatching the next task.
          if (!rateAttempt)
            await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch (error) {
          attemptOpen = false;
          if (
            !dispatched &&
            cancelledByRatePreference &&
            entry.status === "pending" &&
            revision === (this.revisions.get(key) ?? 0) &&
            sourceRevision === (this.revisions.get(sourceKey) ?? 0) &&
            this.quotaRevision === quotaRevision
          ) {
            // A preference cancellation did not attempt delivery. Keep its
            // original deadline and budget so enabling can resume the wait.
            entry.detail = !this.autoResumeOn429
              ? "自动继续已暂停"
              : !this.rateBudgetAvailable(entry.autoRetryCount ?? 0)
                ? `已达到连续自动重试上限（${this.rateLimitMaxRetries}次）`
                : undefined;
            this.save();
            continue;
          }
          entry.status = dispatched ? "unknown" : "failed";
          delete entry.retryAt;
          if (dispatched) {
            const chain = this.rateChains.get(key);
            if (chain) {
              chain.blocked = true;
              this.persistSettings();
            }
          }
          entry.detail = dispatched
            ? "发送结果不明，刷新列表核对；不会自动重发"
            : `未发送：${stage}失败，请刷新后重试`;
          this.save();
          if (dispatched) break;
        } finally {
          this.rateInFlight.delete(key);
          attemptOpen = false;
        }
      }
      this.save();
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
      this.scheduleRateEntries();
    }
    return this.visibleSnapshot();
  }
}
