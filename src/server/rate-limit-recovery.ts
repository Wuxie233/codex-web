export const RATE_LIMIT_CONTINUATION =
  "上一轮因请求限流（HTTP 429）而中断，请继续之前未完成的工作。先核对当前进度和已有执行结果，再从中断处接着处理，避免重复执行已完成的操作。";
export const RATE_LIMIT_DELAYS = [30000, 60000, 120000] as const;
export type RecoveryReason = "quota" | "rateLimit";
// Walk structured protocol errors and their textual HTTP diagnostics. Quota wins
// even when an upstream provider also labels the response HTTP 429.
export function recoveryReason(error: unknown): RecoveryReason | undefined {
  const strings: string[] = [];
  let status429 = false;
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object")
      for (const [key, nested] of Object.entries(value)) {
        if (
          /^(httpStatusCode|http_status_code|statusCode|status_code|status)$/i.test(
            key,
          ) &&
          (nested === 429 || nested === "429")
        )
          status429 = true;
        visit(nested, depth + 1);
      }
  };
  visit(error, 0);
  if (
    strings.some((s) =>
      /usageLimitExceeded|usage_limit_reached|insufficient_quota|insufficientQuota/.test(
        s,
      ),
    )
  )
    return "quota";
  const info =
    error && typeof error === "object" && "codexErrorInfo" in error
      ? error.codexErrorInfo
      : undefined;
  if (info === "rateLimitExceeded") return "rateLimit";
  if (status429) return "rateLimit";
  if (info !== undefined && info !== null && info !== "other") return undefined;
  if (
    strings.some((s) =>
      /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*(?:status(?:\s+code)?\s*[:=]?\s*)?|status(?:\s+code)?\s*[:=]?\s*)429\b/i.test(
        s,
      ),
    )
  )
    return "rateLimit";
  return undefined;
}
export type RecoveryClock = {
  now(): number;
  setTimeout(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};
export const recoveryClock: RecoveryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
export type RateLimitChain = {
  count: number;
  failedTurnId: string;
  continuationTurnId?: string;
  clientUserMessageId?: string;
  blocked?: boolean;
};
