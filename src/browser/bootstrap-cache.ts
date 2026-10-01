const KEY = "codex-web:statsig-bootstrap:v1";
const TTL = 5 * 60 * 1000;

type Bootstrap = { statsigPayload: string; user: unknown };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const refreshGenerations = new WeakMap<Storage, number>();

function isAuthorizationError(error: unknown): boolean {
  // The native bootstrap wraps the HTTP error in Error.cause.
  for (
    let depth = 0;
    depth < 5 && error && typeof error === "object";
    depth++
  ) {
    if ("status" in error && (error.status === 401 || error.status === 403))
      return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

// Real bootstrap payloads can exceed the browser's 5 MiB Web Storage quota.
// Compress the complete record; older browsers safely retain the network path.
async function encode(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  if (typeof CompressionStream === "undefined") return json;
  const bytes = new Uint8Array(
    await new Response(
      new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return "gzip:" + btoa(binary);
}

async function decode(serialized: string | null) {
  if (!serialized?.startsWith("gzip:")) return JSON.parse(serialized ?? "null");
  const binary = atob(serialized.slice(5));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return JSON.parse(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );
}

// Cache evaluations only. Authentication is resolved before this helper is called.
export async function cachedStatsigBootstrap<T extends Bootstrap>(
  identity: string,
  load: () => Promise<T>,
  storage?: Storage,
  now: () => number = Date.now,
): Promise<T> {
  try {
    storage ??= window.sessionStorage;
  } catch {
    return load();
  }
  const cache = storage;
  const generation = (refreshGenerations.get(cache) ?? 0) + 1;
  refreshGenerations.set(cache, generation);
  const refresh = async () => {
    const value = await load();
    try {
      const serialized = await encode({ identity, savedAt: now(), value });
      if (refreshGenerations.get(cache) === generation)
        cache.setItem(KEY, serialized);
    } catch {
      /* Storage may be disabled or full. */
    }
    return value;
  };
  try {
    const serialized = cache.getItem(KEY);
    const entry = await decode(serialized);
    if (
      entry?.identity === identity &&
      typeof entry.savedAt === "number" &&
      now() >= entry.savedAt &&
      now() - entry.savedAt < TTL &&
      typeof entry.value?.statsigPayload === "string" &&
      entry.value?.user &&
      typeof entry.value.user === "object" &&
      !Array.isArray(entry.value.user) &&
      JSON.stringify(JSON.parse(entry.value.statsigPayload).user) ===
        JSON.stringify(entry.value.user)
    ) {
      // The provider retains its native live refresh. Revalidate the reload cache
      // separately so a remote round-trip never blocks a warm render.
      // A transient background failure must not turn the next reload cold.
      // Keep the original timestamp: failures never extend its five-minute TTL.
      void refresh().catch((error) => {
        if (!isAuthorizationError(error)) return;
        try {
          if (
            refreshGenerations.get(cache) === generation &&
            cache.getItem(KEY) === serialized
          )
            cache.removeItem(KEY);
        } catch {
          /* Storage may be unavailable. */
        }
      });
      return entry.value;
    }
    cache.removeItem(KEY);
  } catch {
    /* Invalid or unavailable storage must fall back to the network. */
  }
  return refresh();
}
