type RecoveryEntry = {
  id: string;
  hostId: string;
  threadId: string;
  turnId: string;
  title: string;
  interruptedAt: number | string;
  status: "pending" | "sending" | "resumed" | "skipped" | "failed" | "unknown";
  detail?: string;
  reason?: "quota" | "rateLimit";
  retryAt?: number;
  autoRetryCount?: number;
};
type RecoverySnapshot = {
  entries: RecoveryEntry[];
  busy: boolean;
  autoResumeOnAccountSwitch: boolean;
  autoResumeOn429: boolean;
  scanning?: boolean;
  scanError?: string;
};
type RecoverySetting = "autoResumeOnAccountSwitch" | "autoResumeOn429";
const settings: {
  key: RecoverySetting;
  channel: string;
  label: string;
  description: string;
}[] = [
  {
    key: "autoResumeOnAccountSwitch",
    channel: "quota-recovery:set-auto-resume",
    label: "换号后自动继续中断任务",
    description:
      "换号成功，或原账号重新登录后额度从 0% 恢复时，自动继续因额度不足中断的任务。",
  },
  {
    key: "autoResumeOn429",
    channel: "quota-recovery:set-auto-resume-429",
    label: "429 后自动继续",
    description:
      "遇到 429 限流中断后，等待一段时间自动补发一条继续消息；连续中断最多自动继续 3 次。",
  },
];
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

const statusLabels: Record<RecoveryEntry["status"], string> = {
  pending: "待继续",
  sending: "正在发送",
  resumed: "已开始继续",
  skipped: "已跳过",
  failed: "发送失败",
  unknown: "结果待核对",
};
const selectable = (entry: RecoveryEntry) =>
  entry.status === "pending" || entry.status === "failed";

/** Install once for the lifetime of the browser shim. */
export function installQuotaRecovery(invoke: Invoke): void {
  if (customElements.get("codex-quota-recovery-label")) return;
  let snapshot: RecoverySnapshot = {
    entries: [],
    busy: false,
    autoResumeOnAccountSwitch: false,
    autoResumeOn429: false,
  };
  let known = false;
  let settingKnown = false;
  let savingSetting = false;
  let settingError = "";
  let loading = false;
  let submitting = false;
  let uncertain = false;
  let error = "";
  let selected = new Set<string>();
  let dialog: HTMLDialogElement | null = null;
  let rows: HTMLDivElement;
  let notice: HTMLParagraphElement;
  let submit: HTMLButtonElement;
  let refresh: HTMLButtonElement;
  const settingInputs = new Map<RecoverySetting, HTMLInputElement>();
  let settingNotice: HTMLSpanElement;
  let renderedRowsState = "";
  let poll: ReturnType<typeof setTimeout> | undefined;
  let listRequest: Promise<void> | undefined;

  function updateLabels() {
    const count = snapshot.entries.filter(selectable).length;
    for (const label of document.querySelectorAll(
      "codex-quota-recovery-label",
    )) {
      label.textContent = `继续中断任务${known ? ` · ${count}` : ""}`;
    }
  }
  function apply(value: unknown) {
    const next = value as RecoverySnapshot;
    if (
      !next ||
      !Array.isArray(next.entries) ||
      typeof next.busy !== "boolean" ||
      typeof next.autoResumeOnAccountSwitch !== "boolean" ||
      typeof next.autoResumeOn429 !== "boolean"
    ) {
      throw new Error("Invalid quota recovery response");
    }
    const previous = new Set(snapshot.entries.map((entry) => entry.id));
    // Keep completed records in the server ledger for deduplication, not the UI.
    snapshot = {
      ...next,
      entries: next.entries.filter(
        (entry) => entry.status !== "resumed" && entry.status !== "skipped",
      ),
    };
    selected = new Set(
      snapshot.entries
        .filter(
          (entry) =>
            selectable(entry) &&
            (selected.has(entry.id) || !previous.has(entry.id)),
        )
        .map((entry) => entry.id),
    );
    known = true;
    settingKnown = true;
    updateLabels();
  }
  function schedulePoll() {
    clearTimeout(poll);
    // Other pages can change the setting or start recovery while this is open.
    if (dialog?.open && !settingError) {
      poll = setTimeout(() => {
        void load(true);
      }, 2000);
    }
  }
  function render() {
    if (!dialog) return;
    const busy = submitting || savingSetting || snapshot.busy;
    for (const [key, input] of settingInputs) {
      input.checked = snapshot[key];
      input.indeterminate = !settingKnown;
      input.disabled = !settingKnown || savingSetting || submitting || loading;
    }
    settingNotice.textContent =
      settingError ||
      (savingSetting
        ? "正在保存设置…"
        : !settingKnown
          ? "正在读取设置，读取成功后可修改。"
          : "");
    settingNotice.hidden = !settingNotice.textContent;
    settingNotice.setAttribute("role", settingError ? "alert" : "status");
    const totals = Object.entries(statusLabels)
      .map(([status, label]) => {
        const count = snapshot.entries.filter(
          (entry) => entry.status === status,
        ).length;
        return count ? `${label} ${count} 个` : "";
      })
      .filter(Boolean);
    notice.textContent =
      error ||
      snapshot.scanError ||
      (snapshot.scanning ? "正在检查中断任务，已找到的任务会陆续显示…" : "") ||
      (loading && !known
        ? "正在读取中断任务…"
        : totals.join("，") || "没有因额度不足或 429 限流中断的任务。");
    notice.setAttribute("role", error ? "alert" : "status");
    const rowsState = JSON.stringify([
      snapshot.entries,
      snapshot.autoResumeOn429,
      busy,
      loading,
      uncertain,
    ]);
    // Quiet polling must not replace focused task checkboxes every two seconds.
    if (rowsState !== renderedRowsState) {
      renderedRowsState = rowsState;
      rows.replaceChildren();
      for (const entry of snapshot.entries) {
        const row = document.createElement("label");
        row.className = "quota-recovery-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(entry.id);
        checkbox.disabled = busy || loading || uncertain || !selectable(entry);
        checkbox.setAttribute(
          "aria-label",
          `继续 ${entry.title || "未命名任务"}`,
        );
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(entry.id);
          else selected.delete(entry.id);
          updateSubmit();
        };
        const content = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = entry.title || "未命名任务";
        const meta = document.createElement("span");
        meta.className = "quota-recovery-meta";
        const date = new Date(entry.interruptedAt);
        meta.textContent = `${Number.isNaN(date.getTime()) ? "中断时间未知" : date.toLocaleString()} · ${statusLabels[entry.status] || entry.status}`;
        if (entry.reason === "rateLimit") {
          meta.textContent += " · 429 限流";
          if (typeof entry.autoRetryCount === "number") {
            meta.textContent += ` · 已自动尝试 ${entry.autoRetryCount}/3 次`;
          }
          if (
            snapshot.autoResumeOn429 &&
            entry.status === "pending" &&
            entry.retryAt !== undefined
          ) {
            const retryAt = new Date(entry.retryAt);
            if (!Number.isNaN(retryAt.getTime())) {
              meta.textContent += ` · 预计 ${retryAt.toLocaleString()} 后自动继续`;
            }
          }
        }
        content.append(title, meta);
        if (entry.detail || entry.status === "unknown") {
          const detail = document.createElement("span");
          detail.className = "quota-recovery-meta";
          detail.textContent = entry.detail || "发送结果待核对，暂不重复发送。";
          content.append(detail);
        }
        row.append(checkbox, content);
        rows.append(row);
      }
    }
    refresh.disabled = loading || submitting || savingSetting;
    refresh.textContent = loading ? "正在刷新…" : "刷新";
    updateSubmit();
    schedulePoll();
  }
  function updateSubmit() {
    if (!submit) return;
    submit.disabled =
      !known ||
      loading ||
      submitting ||
      savingSetting ||
      snapshot.busy ||
      uncertain ||
      selected.size === 0;
    submit.textContent =
      submitting || snapshot.busy
        ? "正在继续…"
        : `继续选中任务${selected.size ? ` · ${selected.size}` : ""}`;
  }
  function load(pollOnly = false): Promise<void> {
    if (listRequest) return listRequest;
    // A pre-send list response must never replace the newer send result.
    if (submitting || savingSetting) return Promise.resolve();
    loading = !pollOnly;
    render();
    listRequest = (async () => {
      try {
        apply(await invoke("quota-recovery:list", { refresh: !pollOnly }));
        uncertain = false;
        settingError = "";
        error = "";
      } catch {
        settingKnown = false;
        settingError = "未能读取设置，请点击刷新重试。";
        error = "未能读取中断任务，请点击刷新重试。";
      } finally {
        loading = false;
        listRequest = undefined;
        render();
      }
    })();
    return listRequest;
  }
  async function saveSetting(
    key: RecoverySetting,
    channel: string,
    enabled: boolean,
  ) {
    const input = settingInputs.get(key);
    if (!input || input.disabled) return;
    const restoreFocus = document.activeElement === input;
    savingSetting = true;
    settingError = "";
    render();
    // Finish any older read before saving, so its response cannot undo the UI.
    await listRequest;
    try {
      apply(await invoke(channel, enabled));
      settingError = "";
    } catch {
      settingKnown = false;
      settingError = "未能确认设置是否保存，请刷新核对后再操作。";
    } finally {
      savingSetting = false;
      render();
      if (
        restoreFocus &&
        dialog?.open &&
        document.activeElement === document.body
      ) {
        if (!input.disabled) input.focus();
        else refresh.focus();
      }
    }
  }
  async function resume() {
    if (submit.disabled) return;
    const ids = snapshot.entries
      .filter((entry) => selected.has(entry.id) && selectable(entry))
      .map((entry) => entry.id);
    if (!ids.length) return;
    submitting = true;
    error = "";
    render();
    await listRequest;
    try {
      apply(await invoke("quota-recovery:resume", ids));
    } catch {
      // Never infer a failed send from a lost response. Read back before retrying.
      uncertain = true;
      error = "发送结果暂时无法确认，请刷新核对后再操作。";
    } finally {
      submitting = false;
      render();
    }
  }
  function open() {
    if (dialog?.open) return;
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog = document.createElement("dialog");
    dialog.className = "codex-quota-recovery";
    dialog.setAttribute("aria-labelledby", "quota-recovery-title");
    const title = document.createElement("h2");
    title.id = "quota-recovery-title";
    title.textContent = "继续中断任务";
    const description = document.createElement("p");
    description.textContent =
      "选择因额度不足或 429 限流中断的任务，统一发送继续消息。额度不足时，请先换好账号。";
    const settingRows = document.createElement("div");
    settingInputs.clear();
    for (const { key, channel, label, description } of settings) {
      const setting = document.createElement("label");
      setting.className = "quota-recovery-row quota-recovery-setting";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-labelledby", `quota-recovery-${key}-title`);
      input.setAttribute(
        "aria-describedby",
        `quota-recovery-${key}-description quota-recovery-setting-notice`,
      );
      input.onchange = () => {
        void saveSetting(key, channel, input.checked);
      };
      settingInputs.set(key, input);
      const content = document.createElement("span");
      const title = document.createElement("strong");
      title.id = `quota-recovery-${key}-title`;
      title.textContent = label;
      const detail = document.createElement("span");
      detail.id = `quota-recovery-${key}-description`;
      detail.className = "quota-recovery-meta";
      detail.textContent = description;
      content.append(title, detail);
      setting.append(input, content);
      settingRows.append(setting);
    }
    settingNotice = document.createElement("span");
    settingNotice.id = "quota-recovery-setting-notice";
    settingNotice.className = "quota-recovery-setting-notice";
    settingNotice.setAttribute("aria-live", "polite");
    settingRows.append(settingNotice);
    notice = document.createElement("p");
    notice.setAttribute("aria-live", "polite");
    rows = document.createElement("div");
    rows.className = "quota-recovery-rows";
    renderedRowsState = "";
    const footer = document.createElement("footer");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.onclick = () => dialog?.close();
    refresh = document.createElement("button");
    refresh.type = "button";
    refresh.onclick = () => {
      void load();
    };
    submit = document.createElement("button");
    submit.type = "button";
    submit.className = "quota-recovery-submit";
    submit.onclick = () => {
      void resume();
    };
    footer.append(close, refresh, submit);
    dialog.append(title, description, settingRows, notice, rows, footer);
    const current = dialog;
    current.addEventListener(
      "close",
      () => {
        clearTimeout(poll);
        current.remove();
        if (dialog === current) dialog = null;
        if (returnFocus?.isConnected) returnFocus.focus();
      },
      { once: true },
    );
    document.body.append(current);
    current.showModal();
    render();
    close.focus();
    void load();
  }

  const style = document.createElement("style");
  style.textContent = `
.codex-quota-recovery { margin:auto; box-sizing:border-box; width:min(560px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); padding:24px; border:1px solid var(--color-border, #8886); border-radius:16px; color:var(--color-text-primary,#181818); background:var(--color-background-elevated-primary,#fff); font:inherit; overflow:auto; }
html.electron-dark .codex-quota-recovery { color:var(--color-text-primary,#eee); background:var(--color-background-elevated-primary,#242424); }
.codex-quota-recovery::backdrop { background:#0008; }
.codex-quota-recovery h2 { font-size:18px; font-weight:600; margin:0 0 12px; }
.codex-quota-recovery p { font-size:13px; line-height:1.5; margin:0 0 16px; }
.quota-recovery-rows { display:flex; flex-direction:column; gap:8px; max-height:48dvh; overflow:auto; }
.quota-recovery-row { display:flex; gap:12px; align-items:flex-start; padding:12px; border:1px solid #8884; border-radius:8px; font-size:13px; }
.quota-recovery-row input { flex:none; width:18px; height:18px; margin-top:2px; accent-color:currentColor; }
.quota-recovery-row > span { min-width:0; overflow-wrap:anywhere; }
.quota-recovery-row strong { display:block; font-weight:500; }
.quota-recovery-setting { margin-bottom:16px; }
.quota-recovery-setting-notice:not([hidden]) { display:block; margin-bottom:16px; font-size:13px; }
.quota-recovery-meta { display:block; margin-top:4px; opacity:.7; font-size:12px; }
.codex-quota-recovery footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:20px; }
.codex-quota-recovery button { color:inherit; background:transparent; min-height:44px; padding:8px 14px; border:1px solid #8886; border-radius:8px; font:inherit; font-size:13px; cursor:pointer; }
.codex-quota-recovery button:hover:not(:disabled) { background:#8882; }
.codex-quota-recovery button:disabled { opacity:.45; cursor:default; }
.codex-quota-recovery :focus-visible { outline:2px solid currentColor; outline-offset:2px; }
`;
  document.head.append(style);
  customElements.define(
    "codex-quota-recovery-label",
    class extends HTMLElement {
      connectedCallback() {
        updateLabels();
        void load();
      }
    },
  );
  window.addEventListener("codex-quota-recovery-open", () => {
    // Let the account menu close and release its focus trap first.
    setTimeout(open, 0);
  });
  window.addEventListener("focus", () => {
    if (dialog?.open) void load(true);
  });
}
