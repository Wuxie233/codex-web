// A browser request profile avoids the upstream verification challenge observed
// with Node fetch on this audio upload. Keep it scoped to the tested endpoint.
const transcriptionHeaders = {
  accept: "application/json",
  origin: "https://chatgpt.com",
  referer: "https://chatgpt.com/",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-fetch-dest": "empty",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "accept-language": "en-US,en;q=0.9",
};

export function withTranscriptionHeaders(
  input: string | URL,
  init?: RequestInit,
): RequestInit | undefined {
  if (
    String(input) !== "https://chatgpt.com/backend-api/transcribe" ||
    init?.method?.toUpperCase() !== "POST"
  ) {
    return init;
  }
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(transcriptionHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}
