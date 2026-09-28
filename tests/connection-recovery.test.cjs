const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function fixture() {
  let now = 0,
    id = 0,
    reloads = 0;
  const timers = new Map(),
    events = new Map(),
    sockets = [];
  const listen = (name, fn) => {
    const all = events.get(name) || [];
    all.push(fn);
    events.set(name, all);
  };
  const document = { visibilityState: "visible", addEventListener: listen };
  const window = {
    addEventListener: listen,
    location: {
      protocol: "https:",
      host: "example.test",
      reload: () => reloads++,
    },
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    listeners = new Map();
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(n, fn) {
      this.listeners.set(n, fn);
    }
    emit(n, arg) {
      this.listeners.get(n)?.(arg);
    }
    open() {
      this.readyState = 1;
      this.emit("open");
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    receive(data) {
      this.emit("message", { data: JSON.stringify(data) });
    }
  }
  const context = vm.createContext({
    window,
    document,
    navigator: { onLine: true },
    WebSocket: Socket,
    exports: {},
    console,
    URLSearchParams,
    realtimeToken: null,
    closeRealtimeWindows() {},
    disposeRealtimeMedia: null,
    RECONNECT_DELAY_MS: 1000,
  });
  const compile = (source) =>
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  vm.runInContext(
    compile(fs.readFileSync("src/browser/connection-health.ts", "utf8")),
    context,
  );
  context.installConnectionHealth = context.exports.installConnectionHealth;
  const source = fs.readFileSync("src/browser/shim.ts", "utf8");
  const fragment = source.slice(
    source.indexOf("let requestCounter"),
    source.indexOf("const themeMediaQuery"),
  );
  vm.runInContext(
    compile(fragment) + "\nensureSocket(); connectionHealth?.opened();",
    context,
  );
  return {
    sockets,
    document,
    context,
    get reloads() {
      return reloads;
    },
    event(n) {
      for (const f of events.get(n) || []) f();
    },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = until;
    },
  };
}
test("healthy foreground return keeps original socket without reload", () => {
  const f = fixture(),
    s = f.sockets[0];
  s.open();
  s.receive({ type: "bridge-pong", nonce: s.sent.at(-1).nonce });
  f.document.visibilityState = "hidden";
  f.event("visibilitychange");
  f.tick(60000);
  f.document.visibilityState = "visible";
  f.event("visibilitychange");
  s.receive({ type: "bridge-pong", nonce: s.sent.at(-1).nonce });
  f.tick(5000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.reloads, 0);
});
test("half-open socket is replaced within five seconds of return, recovery only reloads on ready", () => {
  const f = fixture(),
    s = f.sockets[0];
  s.open();
  f.document.visibilityState = "hidden";
  f.event("visibilitychange");
  f.tick(60000);
  f.document.visibilityState = "visible";
  f.event("visibilitychange");
  f.tick(5000);
  assert.equal(f.sockets.length, 2);
  const recovery = f.sockets[1];
  assert.match(recovery.url, /recoveryProbe=1/);
  recovery.open();
  assert.equal(f.reloads, 0);
  assert.equal(recovery.sent.length, 0);
  recovery.receive({ type: "bridge-recovery-ready" });
  assert.equal(f.reloads, 1);
});
test("background disconnect waits for foreground, stale events cannot damage replacement", () => {
  const f = fixture(),
    s = f.sockets[0];
  s.open();
  f.document.visibilityState = "hidden";
  f.event("visibilitychange");
  s.close();
  f.tick(60000);
  assert.equal(f.sockets.length, 1);
  f.document.visibilityState = "visible";
  f.event("visibilitychange");
  const replacement = f.sockets[1];
  s.emit("close");
  s.emit("error");
  s.receive({ type: "bridge-recovery-ready" });
  assert.equal(f.reloads, 0);
  assert.equal(replacement.readyState, 0);
  vm.runInContext(
    'enqueueMessage({type:"ipc-renderer-send",channel:"submit",args:[]})',
    f.context,
  );
  replacement.open();
  assert.equal(replacement.sent.length, 0);
});
test("connecting sockets have a bounded deadline and offline waits for online event", () => {
  const f = fixture();
  f.tick(9000);
  assert.equal(f.sockets.length, 2);
  f.context.navigator.onLine = false;
  f.sockets[1].close();
  f.tick(60000);
  assert.equal(f.sockets.length, 2);
  f.context.navigator.onLine = true;
  f.event("online");
  assert.equal(f.sockets.length, 3);
});

test("new requests during disconnection fail promptly rather than hanging or replaying", async () => {
  const f = fixture();
  f.sockets[0].close();
  await assert.rejects(
    vm.runInContext('invokeMain("submit", [])', f.context),
    /Connection to Codex was lost/,
  );
  await assert.rejects(
    vm.runInContext("requestWorkspaceDirectoryEntries(null)", f.context),
    /Connection to Codex was lost/,
  );
  assert.equal(
    vm.runInContext(
      "pendingInvokes.size + pendingDirectoryEntries.size + outboundQueue.length",
      f.context,
    ),
    0,
  );
});

test("online during a stale ping deadline immediately reconnects", () => {
  const f = fixture();
  f.sockets[0].open();
  f.context.navigator.onLine = false;
  f.sockets[0].close();
  f.tick(100);
  f.context.navigator.onLine = true;
  f.event("online");
  assert.equal(f.sockets.length, 2);
});

test('foreground observes CLOSING before its close event without losing cleanup', () => {
  const f = fixture(), old = f.sockets[0]; old.open();
  old.receive({type:'bridge-pong',nonce:old.sent.at(-1).nonce});
  old.readyState = 2; f.event('focus');
  assert.equal(f.sockets.length, 2); assert.match(f.sockets[1].url, /recoveryProbe=1/);
  old.emit('close'); f.sockets[1].open();
  assert.equal(f.sockets[1].sent.length, 0);
});
