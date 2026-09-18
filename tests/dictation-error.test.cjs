const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const dir = path.join(__dirname, "../scratch/asar/webview/assets");
const source = fs.readFileSync(
  path.join(
    dir,
    fs.readdirSync(dir).find((n) => /^app-initial-.*\.js$/.test(n)),
  ),
  "utf8",
);
const start = source.indexOf("function aBs(e, t, n) {");
const end = source.indexOf("\nvar ", start);
assert(start >= 0 && end > start, "Desktop dictation error formatter anchor");
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const context = {
  hD: HttpError,
  Error,
  navigator: { language: "zh-CN" },
  Qds: () => null,
  t9: { transcribeError: "generic", connectionError: "network" },
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const format = (error) =>
  context.aBs(
    { locale: "zh-CN", formatMessage: (x) => x },
    "transcription",
    error,
  );
test("Cloudflare challenge explains upstream verification failure", () => {
  const result = format(
    new HttpError(
      403,
      "<html>Enable JavaScript and cookies to continue<script>window._cf_chl_opt={}</script></html>",
    ),
  );
  assert.match(result.message, /验证/);
  assert.equal(result.canRetry, true);
});
test("ordinary permission denial remains generic", () =>
  assert.equal(
    format(new HttpError(403, "Permission denied")).message,
    "generic",
  ));
test("network failure retains existing recovery", () =>
  assert.equal(format(new HttpError(0, "fetch failed")).message, "network"));
