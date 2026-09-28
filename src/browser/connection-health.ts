// Browser timers can be suspended in the background. Probe the transport again
// on resume instead of trusting WebSocket.OPEN after a network change.
export function installConnectionHealth(options: {
  getSocket: () => WebSocket | null;
  reconnect: () => void;
  invalidate: (socket: WebSocket) => void;
}): { opened: () => void; received: (data: unknown) => boolean; disconnected: () => void } {
  let deadline: number | undefined;
  let interval: number | undefined;
  let nonce = 0;
  let pending: number | undefined;
  let watched: WebSocket | null = null;
  const clear = () => {
    window.clearTimeout(deadline);
    window.clearTimeout(interval);
    deadline = interval = undefined;
    pending = undefined;
  };
  const check = () => {
    if (document.visibilityState === "hidden" || deadline !== undefined) return;
    window.clearTimeout(interval);
    options.reconnect();
    const socket = options.getSocket();
    if (!socket) return;
    watched = socket;
    if (socket.readyState === WebSocket.OPEN) {
      pending = ++nonce;
      try {
        socket.send(JSON.stringify({ type: "bridge-ping", nonce: pending }));
      } catch {
        clear();
        options.invalidate(socket);
        return;
      }
    }
    deadline = window.setTimeout(
      () => {
        clear();
        if (options.getSocket() === socket) options.invalidate(socket);
      },
      socket.readyState === WebSocket.CONNECTING ? 8_000 : 4_000,
    );
  };
  document.addEventListener("visibilitychange", () => {
    clear();
    if (document.visibilityState !== "hidden") check();
  });
  for (const event of ["pageshow", "online", "focus"]) {
    window.addEventListener(event, check);
  }
  document.addEventListener("freeze", clear);
  document.addEventListener("resume", check);
  window.addEventListener("pagehide", clear);
  return {
    disconnected: clear,
    opened() {
      clear();
      check();
    },
    received(data) {
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== "bridge-pong"
      )
        return false;
      if (
        "nonce" in data &&
        data.nonce === pending &&
        watched === options.getSocket()
      ) {
        clear();
        interval = window.setTimeout(check, 25_000);
      }
      return true;
    },
  };
}
