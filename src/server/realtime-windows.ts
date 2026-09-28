import { randomUUID } from "node:crypto";

export type RealtimeWindow = {
  id: number;
  webContents: { id: number };
  destroy(): void;
  once(event: string, listener: () => void): unknown;
};

export type RealtimeWindowMessage =
  | { type: "realtime-window-open"; token: string }
  | { type: "realtime-window-close"; token: string };

/** Bind a native overlay to its launching tab, without trusting renderer IDs. */
export class RealtimeWindows {
  private windows = new Map<
    number,
    { window: RealtimeWindow; owner: number; token: string; claimed: boolean }
  >();

  constructor(
    private send: (owner: number, message: RealtimeWindowMessage) => boolean,
  ) {}

  attach(window: RealtimeWindow, owner: number): void {
    const previous = this.windows.get(window.webContents.id);
    if (previous) {
      if (previous.owner !== owner)
        throw new Error("Voice is already open in another tab");
      return;
    }
    const token = randomUUID();
    this.windows.set(window.webContents.id, {
      window,
      owner,
      token,
      claimed: false,
    });
    window.once("closed", () => this.close(window.webContents.id));
    if (!this.send(owner, { type: "realtime-window-open", token })) {
      this.close(window.webContents.id);
      throw new Error("The tab starting voice has disconnected");
    }
  }

  claim(token: string): RealtimeWindow | undefined {
    const entry = [...this.windows.values()].find(
      (entry) => entry.token === token,
    );
    if (!entry || entry.claimed) return undefined;
    entry.claimed = true;
    return entry.window;
  }

  getOwner(id: number): number | undefined {
    return this.windows.get(id)?.owner;
  }

  canAttach(id: number, owner: number): boolean {
    const entry = this.windows.get(id);
    return !entry || entry.owner === owner;
  }

  close(id: number): boolean {
    const entry = this.windows.get(id);
    if (!entry) return false;
    // Remove first: native closed listeners also reset the voice controller.
    this.windows.delete(id);
    this.send(entry.owner, {
      type: "realtime-window-close",
      token: entry.token,
    });
    entry.window.destroy();
    return true;
  }

  closeOwner(owner: number): void {
    for (const [id, entry] of this.windows)
      if (entry.owner === owner) this.close(id);
  }
}
