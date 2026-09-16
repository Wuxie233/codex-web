/** Desktop IPC shares a clock; browser IPC does not. Translate only RPC deadlines. */
export function rebaseRequestDeadlines(
  channel: string,
  args: unknown[],
  browserSentAtMs: unknown,
  receivedAtMs = Date.now(),
): unknown[] {
  if (channel !== "codex_desktop:message-from-view") return args;
  return args.map((value) => {
    if (value === null || typeof value !== "object") return value;
    const request = value as Record<string, unknown>;
    if (request.type !== "mcp-request" && request.type !== "thread-prewarm-start") return value;
    const timeout = request.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return value;
    let remaining = timeout;
    if (typeof browserSentAtMs === "number" && Number.isFinite(browserSentAtMs) &&
        typeof request.expiresAtMs === "number" && Number.isFinite(request.expiresAtMs)) {
      remaining = Math.max(0, Math.min(timeout, request.expiresAtMs - browserSentAtMs));
    }
    // Older cached clients lack the timestamp: use their relative timeout.
    return { ...request, expiresAtMs: receivedAtMs + remaining };
  });
}
