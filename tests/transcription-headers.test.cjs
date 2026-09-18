const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  withTranscriptionHeaders,
} = require("../src/server/electron/transcription-headers.js");
const endpoint = "https://chatgpt.com/backend-api/transcribe";

test("only the exact HTTPS transcription POST receives browser headers", () => {
  const init = { method: "POST", headers: { accept: "custom" } };
  for (const url of [
    "http://chatgpt.com/backend-api/transcribe",
    endpoint + "?x=1",
    endpoint + "/",
    endpoint + "#fragment",
    "https://chatgpt.com/backend-api/other",
    "https://example.com/backend-api/transcribe",
    "https://chatgpt.com.evil.test/backend-api/transcribe",
  ]) {
    assert.equal(withTranscriptionHeaders(url, init), init, url);
  }
  for (const method of ["GET", "PUT", "DELETE", undefined]) {
    const options = { method };
    assert.equal(withTranscriptionHeaders(endpoint, options), options);
  }
  assert.equal(withTranscriptionHeaders(endpoint), undefined);
  assert.equal(
    withTranscriptionHeaders(new URL(endpoint), { method: "post" }).headers.get(
      "origin",
    ),
    "https://chatgpt.com",
  );
});

for (const kind of ["record", "tuples", "Headers"]) {
  test(`preserves authentication, multipart body and cancellation with ${kind} headers`, () => {
    const entries = [
      ["Authorization", "Bearer fixture"],
      ["ChatGPT-Account-Id", "fixture-account"],
      ["Content-Type", "multipart/form-data; boundary=fixture"],
      ["X-Existing", "keep"],
      ["User-Agent", "old"],
    ];
    const headers =
      kind === "record"
        ? Object.fromEntries(entries)
        : kind === "Headers"
          ? new Headers(entries)
          : entries;
    const before = [...new Headers(headers)];
    const body = new Uint8Array([0, 1, 255]);
    const signal = new AbortController().signal;
    const init = { method: "POST", headers, body, signal, redirect: "error" };
    const result = withTranscriptionHeaders(endpoint, init);
    assert.notEqual(result, init);
    assert.notEqual(result.headers, headers);
    assert.equal(result.body, body);
    assert.equal(result.signal, signal);
    assert.equal(result.redirect, "error");
    for (const [name, value] of entries.slice(0, 4))
      assert.equal(result.headers.get(name), value);
    assert.deepEqual([...new Headers(headers)], before);
    assert.equal(init.headers, headers);
    assert.equal(result.headers.get("accept"), "application/json");
    assert.equal(result.headers.get("origin"), "https://chatgpt.com");
    assert.equal(result.headers.get("referer"), "https://chatgpt.com/");
    assert.equal(result.headers.get("sec-fetch-mode"), "cors");
    assert.equal(result.headers.get("sec-fetch-site"), "same-origin");
    assert.equal(result.headers.get("sec-fetch-dest"), "empty");
    assert.equal(result.headers.get("accept-language"), "en-US,en;q=0.9");
    assert.match(result.headers.get("user-agent"), /Chrome\/133\.0\.0\.0/);
    assert.match(result.headers.get("sec-ch-ua"), /"Chromium";v="133"/);
  });
}
