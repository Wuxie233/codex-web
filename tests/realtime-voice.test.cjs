const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const ts = require('typescript');
const { RealtimeWindows } = require('../src/server/realtime-windows.js');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'scratch/asar/.vite/build/main-C5K7o1Hr.js'), 'utf8');
const start = main.indexOf('  Gae = class {');
const end = main.indexOf('\nfunction Kae(', start);
assert(start >= 0 && end > start, 'Review the pinned native realtime controller after Desktop upgrades');

function registry() {
  const messages = [];
  const manager = new RealtimeWindows((owner, message) => { messages.push({ owner, ...message }); return owner !== -1; });
  function window(id) {
    const result = new EventEmitter();
    Object.assign(result, { id, webContents: { id: id * 1000 + 1 }, destroyed: false, destroyCount: 0,
      destroy() { if (this.destroyed) return; this.destroyed = true; this.destroyCount++; this.emit('closed'); } });
    return result;
  }
  return { manager, messages, window };
}

test('voice renderer token is single-use; ownership and parent cleanup stay isolated', () => {
  const f = registry(), a = f.window(2), b = f.window(3);
  f.manager.attach(a, 1001); f.manager.attach(b, 4001);
  const token = f.messages[0].token;
  assert.equal(f.manager.claim('1001'), undefined);
  assert.equal(f.manager.claim(token), a);
  assert.equal(f.manager.claim(token), undefined);
  assert.equal(f.manager.canAttach(a.webContents.id, 4001), false);
  assert.throws(() => f.manager.attach(a, 4001), /another tab/);
  f.manager.closeOwner(1001);
  assert.equal(a.destroyCount, 1); assert.equal(b.destroyCount, 0);
  assert.equal(f.messages.at(-1).type, 'realtime-window-close');
  assert.equal(f.messages.at(-1).owner, 1001);
  assert.equal(f.manager.claim(token), undefined);
  f.manager.closeOwner(4001);
});

test('native window closure and missing parent invalidate pending tokens', () => {
  const f = registry(), a = f.window(2), b = f.window(3);
  f.manager.attach(a, 1001); const token = f.messages[0].token;
  a.destroy(); assert.equal(f.manager.claim(token), undefined);
  assert.equal(a.destroyCount, 1);
  assert.throws(() => f.manager.attach(b, -1), /disconnected/);
  assert.equal(b.destroyCount, 1);
});

function controllerFixture({ web = true } = {}) {
  const f = registry(), overlay = f.window(2), timers = new Map(), states = [];
  const context = vm.createContext({
    Symbol,
    i: { i: () => () => ({ warning() {}, error() {} }) },
    n: { to: String, es: () => Promise.withResolvers() }, Uae: 30000, Wae: 10000,
    setTimeout(fn, delay) { const token = {}; timers.set(token, { fn, delay }); return token; },
    clearTimeout(token) { timers.delete(token); },
    __codexElectronIpcBridge: web ? {
      attachRealtimeWindow: (window, owner) => f.manager.attach(window, owner),
      closeRealtimeWindow: (id) => f.manager.close(id),
      canAttachRealtimeWindow: (id, owner) => f.manager.canAttach(id, owner),
    } : undefined,
  });
  vm.runInContext(main.slice(start, end) + ';this.Controller = Gae;', context);
  let rendererId = overlay.webContents.id;
  const controller = new context.Controller({
    getRendererId: () => rendererId, isOpening: () => false, isOpen: () => true,
    isPresentationPending: () => false, clearPresentation() {},
    publishLaunchState(origin, state) { states.push({ owner: origin.id, state }); },
    async preparePresentation(origin) { f.manager.attach(overlay, origin.id); },
  });
  overlay.on('closed', () => { rendererId = null; controller.handleWindowClosed(overlay.webContents.id); });
  return { ...f, overlay, controller, states, timers, context };
}

function rpcCallback(fn) {
  fn.dup = () => fn;
  fn.onRpcBroken = () => {};
  fn[Symbol.dispose] = () => {};
  return fn;
}

for (const web of [true, false]) {
  test(`voice startup keeps preparation at 30s and uses ${web ? 30 : 10}s for ${web ? 'Web' : 'native'} connection`, async () => {
    const f = controllerFixture({ web }), pending = Promise.withResolvers();
    await f.controller.requestStart({ id: 1001 }, { source: 'composer_button_new_thread' }, 'launch');
    assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [30000]);
    f.controller.registerStarter(f.overlay.webContents.id,
      rpcCallback(() => pending.promise), rpcCallback(async () => {}), true);
    assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [web ? 30000 : 10000]);
    const started = f.controller.startInFlight;
    pending.resolve(); await started;
    assert.equal(f.states.at(-1).state, 'connected');
    assert.equal(f.timers.size, 0);
    f.manager.closeOwner(1001);
  });
}

test('Web startup timeout closes its renderer and ignores late connection success', async () => {
  const f = controllerFixture(), pending = Promise.withResolvers();
  let cancelCalls = 0;
  // The bridge may be installed after module evaluation and controller creation.
  const bridge = f.context.__codexElectronIpcBridge;
  f.context.__codexElectronIpcBridge = undefined;
  await f.controller.requestStart({ id: 1001 }, { source: 'composer_button_new_thread' }, 'launch');
  f.context.__codexElectronIpcBridge = bridge;
  const token = f.messages[0].token;
  f.controller.registerStarter(f.overlay.webContents.id,
    rpcCallback(() => pending.promise), rpcCallback(async () => { cancelCalls++; }), true);
  const started = f.controller.startInFlight;
  assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [30000]);
  [...f.timers.values()][0].fn();
  assert.equal(f.overlay.destroyCount, 1);
  assert.equal(f.manager.claim(token), undefined);
  assert.equal(f.controller.isSessionReserved(), false);
  assert.equal(f.states.at(-1).state, 'failed');
  assert.equal(f.timers.size, 0);
  assert.equal(cancelCalls, 0);
  pending.resolve(); await started;
  assert.equal(f.states.at(-1).state, 'failed');
  assert.equal(f.timers.size, 0);
});

test('native launch timeout destroys child and expires its token immediately', async () => {
  const f = controllerFixture();
  await f.controller.requestStart({ id: 1001 }, { source: 'composer_button_new_thread' }, 'launch');
  const token = f.messages[0].token;
  const timer = [...f.timers.values()].find(timer => timer.delay === 30000);
  assert(timer); timer.fn();
  assert.equal(f.overlay.destroyCount, 1);
  assert.equal(f.manager.claim(token), undefined);
  assert.equal(f.controller.isSessionReserved(), false);
  assert.equal(f.states.at(-1).state, 'failed');
  assert.equal(f.timers.size, 0);
});

test('native cancel closes the child without calling its now-disposed RPC', async () => {
  const f = controllerFixture();
  await f.controller.requestStart({ id: 1001 }, { source: 'composer_button_new_thread' }, 'launch');
  let cancelCalls = 0;
  const noop = () => {}; noop[Symbol.dispose] = () => {};
  const cancel = () => { cancelCalls++; throw Error('disposed RPC'); }; cancel[Symbol.dispose] = () => {};
  f.controller.starter = { rendererId: f.overlay.webContents.id, start: noop, cancelStart: cancel };
  await f.controller.cancelStart({ id: 1001 });
  assert.equal(cancelCalls, 0); assert.equal(f.overlay.destroyCount, 1);
  assert.equal(f.controller.isSessionReserved(), false);
});

test('another tab cannot reset an existing native voice session', async () => {
  const f = controllerFixture(); f.manager.attach(f.overlay, 1001);
  f.controller.hasSession = true;
  await f.controller.requestStart({ id: 4001 }, { source: 'composer_button_new_thread' }, 'other');
  assert.equal(f.controller.hasSession, true); assert.equal(f.overlay.destroyCount, 0);
  assert.deepEqual(f.states, [{ owner: 4001, state: 'failed' }]);
  f.manager.closeOwner(1001);
});

test('another tab cannot replace a launch while the native window is still opening', async () => {
  const f = controllerFixture(), pending = Promise.withResolvers();
  let presentations = 0;
  f.controller.options.getRendererId = () => null;
  f.controller.options.isOpening = () => true;
  f.controller.options.preparePresentation = () => { presentations++; return pending.promise; };
  const first = f.controller.requestStart({ id: 1001 }, { source: 'composer_button_new_thread' }, 'first');
  const generation = f.controller.sessionGeneration;
  await f.controller.requestStart({ id: 4001 }, { source: 'composer_button_existing_thread', threadId: 'other' }, 'second');
  assert.equal(f.controller.launch.origin.id, 1001);
  assert.equal(f.controller.pendingStart.source, 'composer_button_new_thread');
  assert.equal(f.controller.sessionGeneration, generation);
  assert.equal(presentations, 1);
  assert.deepEqual(f.states, [{ owner: 1001, state: 'starting' }, { owner: 4001, state: 'failed' }]);
  f.controller.resetSession(); pending.resolve(); await first;
});

test('cancel while native window creation is pending cannot create a late voice frame', async () => {
  const f = registry(), overlay = f.window(2);
  const a = main.indexOf('    async prepareRealtimePresentation(e, t) {');
  const b = main.indexOf('    async restoreOpenState(e) {', a);
  const pending = Promise.withResolvers();
  let reserved = true;
  const method = vm.runInNewContext('({' + main.slice(a, b) + '}).prepareRealtimePresentation', {
    __codexElectronIpcBridge: { attachRealtimeWindow: (window, owner) => f.manager.attach(window, owner) },
  });
  const host = { windowVisibilitySequence: 0,
    realtimeController: { isSessionReserved: () => reserved }, ensureWindow: () => pending.promise };
  const result = method.call(host, { id: 1001 }, false);
  reserved = false; pending.resolve(overlay); await result;
  assert.equal(overlay.destroyCount, 1); assert.equal(f.messages.length, 0);
});

test('voice renderer cleanup stops both current and late microphone streams', async () => {
  const source = fs.readFileSync(path.join(root, 'src/browser/realtime.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = [], exports = {}, listeners = {};
  const media = { getUserMedia: () => new Promise(resolve => pending.push(resolve)) };
  vm.runInNewContext(js, { exports, URLSearchParams, DOMException,
    navigator: { mediaDevices: media }, window: { location: { pathname: '/' }, addEventListener: (name, fn) => listeners[name] = fn } });
  const dispose = exports.installRealtimeMediaCleanup();
  let stops = 0; const stream = { getTracks: () => [{ stop: () => stops++ }] };
  const active = media.getUserMedia({ audio: true }); pending.shift()(stream); await active;
  const late = media.getUserMedia({ audio: true }); dispose();
  assert.equal(stops, 1);
  pending.shift()(stream); await assert.rejects(late, { name: 'AbortError' });
  assert.equal(stops, 2); listeners.pagehide(); assert.equal(stops, 2);
});

function navigationFixture({ web = true } = {}) {
  const f = registry(), overlay = f.window(7), actions = [];
  f.manager.attach(overlay, 6001);
  const owner = { webContents: { id: 6001 }, isDestroyed: () => false,
    isMinimized: () => false, isVisible: () => true, isFocused: () => false,
    show: () => actions.push('owner-show'), focus: () => actions.push('owner-focus') };
  const other = { ...owner, webContents: { id: 9001 } };
  const windows = [owner, other];
  const a = main.indexOf('function mFe(e) {');
  const b = main.indexOf('function ', a + 10);
  assert(a >= 0 && b > a, 'Review the pinned native navigation handler after Desktop upgrades');
  let handler;
  const context = vm.createContext({
    HPe() {}, l: { BrowserWindow: { getAllWindows: () => windows },
      ipcMain: { handle: (channel, callback) => { if (channel === 'message') handler = callback; }, on() {} } },
    r: { tt: 'message' }, n: { ja: route => route.startsWith('/') },
    __codexElectronIpcBridge: web ? { getRealtimeOwnerId: id => f.manager.getOwner(id) } : undefined,
  });
  vm.runInContext(main.slice(a, b) + ';this.install = mFe;', context);
  context.install({
    hotkeyWindowLifecycleManager: { hide: () => actions.push('hide') },
    getPrimaryWindow: () => { actions.push('primary'); return other; },
    showPrimaryWindow: () => actions.push('show-primary'),
    ensureWindow: async () => other, createFreshWindow: async () => other,
    navigateToRoute: (window, route) => actions.push(['navigate', window.webContents.id, route]),
    isTrustedIpcEvent: event => !event.sender.isDestroyed(),
  });
  const sender = { id: overlay.webContents.id, isDestroyed: () => overlay.destroyed };
  return { ...f, overlay, actions, windows, sender,
    send: (message, origin = sender) => handler({ sender: origin }, message) };
}

test('native navigation handler sends voice handoff to its owner despite another primary tab', async () => {
  const f = navigationFixture();
  await f.send({ type: 'open-in-main-window', path: '/thread/voice' });
  assert.deepEqual(f.actions, ['hide', 'owner-show', 'owner-focus', ['navigate', 6001, '/thread/voice']]);
});

test('voice navigation validates paths and never falls back when its owner is missing', async () => {
  const f = navigationFixture();
  await f.send({ type: 'open-in-main-window', path: 'https://untrusted.example/' });
  assert.deepEqual(f.actions, []);
  f.windows.shift();
  await f.send({ type: 'open-in-main-window', path: '/thread/voice' });
  await f.send({ type: 'open-current-main-window' });
  assert.deepEqual(f.actions, []);
  f.manager.closeOwner(6001);
  assert.equal(f.manager.getOwner(f.sender.id), undefined);
  await f.send({ type: 'open-in-main-window', path: '/thread/voice' });
  assert.deepEqual(f.actions, []);
});

for (const web of [true, false]) {
  test(`${web ? 'non-voice browser' : 'native'} navigation retains primary-window routing`, async () => {
    const f = navigationFixture({ web });
    await f.send({ type: 'open-in-main-window', path: '/thread/regular' },
      { id: 10001, isDestroyed: () => false });
    assert.deepEqual(f.actions, ['hide', 'primary', 'show-primary', ['navigate', 9001, '/thread/regular']]);
  });
}


test('closed voice senders are rejected before native IPC routing after their binding is removed', () => {
  const source = fs.readFileSync(path.join(root, 'src/server/electron/index.ts'), 'utf8');
  const a = source.indexOf('function createIpcMainEvent(');
  const b = source.indexOf('function createIpcMainStub()', a);
  assert(a >= 0 && b > a);
  const js = ts.transpileModule(source.slice(a, b), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const f = registry(), overlay = f.window(7);
  overlay.isDestroyed = () => overlay.destroyed;
  f.manager.attach(overlay, 6001);
  const makeEvent = vm.runInNewContext(js + ';createIpcMainEvent', {
    BrowserWindow: { fromId: id => id === overlay.id ? overlay : undefined }
  });
  assert.equal(makeEvent(overlay.id).sender.id, overlay.webContents.id);
  f.manager.closeOwner(6001);
  assert.equal(f.manager.getOwner(overlay.webContents.id), undefined);
  assert.throws(() => makeEvent(overlay.id), /Renderer window 7 is closed/);
});

test('native avatar layout can read and update browser content bounds across launches', () => {
  const { BrowserWindow } = require('../src/server/electron/index.js');
  const a = main.indexOf('    setWindowBounds(e, t, n) {');
  const b = main.indexOf('    sendLayoutToRenderer(e)', a);
  const c = main.indexOf('function km(e, t) {');
  const d = main.indexOf('\nvar Am', c);
  assert(a >= 0 && b > a && c >= 0 && d > c);
  const manager = vm.runInNewContext(main.slice(c, d) + '\n({' + main.slice(a, b) + '})');
  const window = new BrowserWindow({ width: 1200, height: 800 });
  try {
    for (const bounds of [{ x: 60, y: 30, width: 360, height: 240 }, { x: 80, y: 90, width: 280, height: 220 }]) {
      manager.setWindowBounds(window, bounds, false);
      assert.deepEqual(window.getContentBounds(), bounds);
      assert.deepEqual(window.getBounds(), bounds);
      assert.equal(manager.isSettingWindowBounds, false);
      const snapshot = window.getContentBounds(); snapshot.x = -999;
      assert.deepEqual(window.getContentBounds(), bounds);
      manager.setWindowBounds(window, bounds, false);
    }
  } finally { window.destroy(); }
});
