type InputOperation = {
  operationId: string;
  hostId: string;
  threadId: string;
  draftKey: string;
  input: Record<string, unknown>;
};
type InputAdapter = {
  assertInputWritable(hostId: string, threadId: string): void;
  readState(): Record<string, InputOperation>;
  writeState(state: Record<string, InputOperation>): void;
  readGlobal(key: string): any;
  writeGlobal(key: string, value: any): void;
  publishAtom(key: string, value: unknown): void;
  readQueue(threadId: string): Promise<{ messages: unknown[]; activeDispatch?: boolean }>;
  transferBrowser(sourceId: string, targetId: string): void;
};

/** Client preparation is recorded before work begins; disconnects do not erase it. */
export class ThreadInputState {
  private adapter?: InputAdapter;
  registerAdapter(adapter: InputAdapter): void { this.adapter = adapter; }
  private requireAdapter(): InputAdapter {
    if (!this.adapter) throw Error("Thread input state is not initialized.");
    return this.adapter;
  }
  async handle(params: any): Promise<any> {
    const adapter = this.requireAdapter();
    if (!params || typeof params.hostId !== "string" || typeof params.threadId !== "string")
      throw Error("Input state requires hostId and threadId.");
    const state = structuredClone(adapter.readState());
    if (params.phase === "read") return { pending: Object.values(state).filter((row) =>
      row.hostId === params.hostId && row.threadId === params.threadId) };
    if (typeof params.operationId !== "string" || !params.operationId)
      throw Error("Input state requires operationId.");
    if (params.phase === "begin") {
      adapter.assertInputWritable(params.hostId, params.threadId);
      if (!params.input || typeof params.input !== "object" || typeof params.draftKey !== "string")
        throw Error("Pending input requires its original input and draft key.");
      const row: InputOperation = { operationId: params.operationId, hostId: params.hostId,
        threadId: params.threadId, draftKey: params.draftKey, input: params.input };
      const existing = state[params.operationId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(row))
        throw Error("Input operationId was already used for different input.");
      state[params.operationId] = row;
    } else if (params.phase === "complete") {
      const row = state[params.operationId];
      if (row && (row.hostId !== params.hostId || row.threadId !== params.threadId))
        throw Error("Input operation belongs to another task.");
      delete state[params.operationId];
    } else throw Error("Unsupported input-state phase.");
    adapter.writeState(state);
    return { accepted: true };
  }
  async assertHandoffReady(hostId: string, threadId: string): Promise<void> {
    const adapter = this.requireAdapter();
    const pending = Object.values(adapter.readState()).filter((row) => row.hostId === hostId && row.threadId === threadId);
    if (pending.length) throw Error(`Thread ${threadId} has unfinished pasted-text preparation. Its original input remains saved on the server; finish or recover it before handoff.`);
    const queue = await adapter.readQueue(threadId);
    if (queue.messages.length || queue.activeDispatch)
      throw Error(`Thread ${threadId} has queued or dispatching input. Send or remove it before handoff.`);
  }
  async transferHandoffState(sourceHostId: string, sourceThreadId: string, destinationHostId: string, threadId: string): Promise<void> {
    const adapter = this.requireAdapter();
    if (sourceHostId === destinationHostId && sourceThreadId === threadId) return;
    const atoms = structuredClone(adapter.readGlobal("electron-persisted-atom-state") ?? {});
    const sourceBrowserId = atoms[`thread-client-id-v1:${encodeURIComponent(`local:${sourceThreadId}`)}`] ?? sourceThreadId;
    const targetBrowserId = atoms[`thread-client-id-v1:${encodeURIComponent(`local:${threadId}`)}`] ?? threadId;
    // Native pages are server-owned, so moving their routes does not require a renderer.
    adapter.transferBrowser(sourceBrowserId, targetBrowserId);
    const changed: string[] = [];
    const move = (source: string, target: string) => {
      if (source === target || atoms[source] === undefined) return;
      atoms[target] = atoms[source]; delete atoms[source]; changed.push(source, target);
    };
    const comments = atoms.diff_comments;
    if (comments?.[sourceThreadId] !== undefined) {
      comments[threadId] = comments[sourceThreadId]; delete comments[sourceThreadId]; changed.push("diff_comments");
    }
    move(`thread-browser-tabs-v1:${encodeURIComponent(sourceBrowserId)}`, `thread-browser-tabs-v1:${encodeURIComponent(targetBrowserId)}`);
    move(`thread-tab-routes-v1:${encodeURIComponent(sourceThreadId)}`, `thread-tab-routes-v1:${encodeURIComponent(threadId)}`);
    adapter.writeGlobal("electron-persisted-atom-state", atoms);
    for (const key of changed) adapter.publishAtom(key, atoms[key]);
  }
  async cloneForkState({ sourceHostId, sourceThreadId, destinationHostId, threadId }: {
    sourceHostId: string; sourceThreadId: string; destinationHostId: string; threadId: string;
  }): Promise<void> {
    const adapter = this.requireAdapter();
    const atoms = structuredClone(adapter.readGlobal("electron-persisted-atom-state") ?? {});
    const pairs: Array<[string, string]> = [
      [`thread-reference-capability:${sourceThreadId}`, `thread-reference-capability:${threadId}`],
      [`token-budget-thread:${JSON.stringify([sourceHostId, sourceThreadId])}`, `token-budget-thread:${JSON.stringify([destinationHostId, threadId])}`],
    ];
    for (const [source, target] of pairs) if (atoms[source] !== undefined) atoms[target] = structuredClone(atoms[source]);
    adapter.writeGlobal("electron-persisted-atom-state", atoms);
    for (const [source, target] of pairs) if (atoms[source] !== undefined) adapter.publishAtom(target, atoms[target]);
    const mode = atoms["codex-sidebar-sort-mode-v1"] ?? atoms["flat-project-sidebar-preferences-v1"]?.projectSortMode;
    if (mode === "manual") {
      const projectId = adapter.readGlobal("thread-project-assignments")?.[threadId]?.projectId;
      if (projectId) {
        const orders = structuredClone(adapter.readGlobal("sidebar-project-thread-orders") ?? {});
        const order = orders[projectId] ?? {};
        orders[projectId] = { ...order, threadIds: [threadId, ...(order.threadIds ?? []).filter((id: string) => id !== threadId)] };
        adapter.writeGlobal("sidebar-project-thread-orders", orders);
      }
    }
  }
}
