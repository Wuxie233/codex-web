// Evaluation payloads can exceed localStorage's quota. Keep the SDK's small
// identity/session records there, but persist evaluations in IndexedDB.
export function createStatsigStorage() {
  const evaluations = new Map<string, string>();
  const isEvaluation = (key: string) => key.startsWith("statsig.cached.");
  let database: IDBDatabase | null = null;
  let ready = false;
  let initialized: Promise<void> | null = null;
  function initialize() {
    return (initialized ??= new Promise<void>((resolve) => {
      const finish = () => {
        ready = true;
        resolve();
      };
      const fail = () => {
        console.warn("Startup configuration cache unavailable; using memory.");
        database?.close();
        database = null;
        finish();
      };
      try {
        const request = indexedDB.open("codex-web-statsig", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("evaluations");
        };
        request.onerror = fail;
        request.onblocked = fail;
        request.onsuccess = () => {
          if (ready) {
            request.result.close();
            return;
          }
          database = request.result;
          database.onversionchange = () => {
            database?.close();
            database = null;
          };
          try {
            const transaction = database.transaction("evaluations", "readonly");
            const cursor = transaction.objectStore("evaluations").openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (entry) {
                evaluations.set(String(entry.key), entry.value as string);
                entry.continue();
              }
            };
            transaction.oncomplete = finish;
            transaction.onabort = fail;
          } catch {
            fail();
          }
        };
      } catch {
        fail();
      }
    }));
  }

  function persist(key: string, value: string | null) {
    if (!database) return;
    try {
      const transaction = database.transaction("evaluations", "readwrite");
      const store = transaction.objectStore("evaluations");
      if (value === null) store.delete(key);
      else store.put(value, key);
      transaction.onabort = () => {
        console.warn("Could not persist startup configuration cache.");
      };
    } catch {
      console.warn("Could not persist startup configuration cache.");
    }
  }

  return {
    isReady: () => ready,
    isReadyResolver: initialize,
    getProviderName: () => "IndexedDB",
    getItem: (key: string) =>
      isEvaluation(key)
        ? (evaluations.get(key) ?? null)
        : localStorage.getItem(key),
    setItem(key: string, value: string) {
      if (!isEvaluation(key)) {
        localStorage.setItem(key, value);
        return;
      }
      evaluations.set(key, value);
      persist(key, value);
    },
    removeItem(key: string) {
      if (!isEvaluation(key)) {
        localStorage.removeItem(key);
        return;
      }
      evaluations.delete(key);
      persist(key, null);
    },
    getAllKeys: () => [
      ...new Set([...Object.keys(localStorage), ...evaluations.keys()]),
    ],
  };
}
