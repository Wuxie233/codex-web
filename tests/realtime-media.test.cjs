const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/browser/realtime.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const pending = [], listeners = new Map(), exports = {};
  class Peer {
    static generateCertificate() { return 'certificate'; }
    constructor(options) { this.options = options; this.closes = 0; }
    close() { this.closes++; this.onClose?.(); }
  }
  class Context {
    constructor(options) { this.options = options; this.closes = 0; }
    close() { this.closes++; return this.onClose?.() ?? Promise.resolve(); }
  }
  const media = { getUserMedia: () => new Promise(resolve => pending.push(resolve)) };
  const window = {
    location: { pathname: '/' },
    RTCPeerConnection: Peer, AudioContext: Context, webkitAudioContext: Context,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  vm.runInNewContext(js, { exports, URLSearchParams, DOMException,
    navigator: { mediaDevices: media }, window });
  const dispose = exports.installRealtimeMediaCleanup();
  return { window, media, pending, listeners, dispose, Peer, Context };
}

test('tracked constructors preserve native identity, options, statics and subclassing', () => {
  const f = fixture(), options = { sampleRate: 24000 };
  class DerivedPeer extends f.window.RTCPeerConnection {}
  const peer = new DerivedPeer(options);
  const audio = new f.window.AudioContext(options);
  const legacy = new f.window.webkitAudioContext();
  assert(peer instanceof f.Peer);
  assert(peer instanceof f.window.RTCPeerConnection);
  assert(peer instanceof DerivedPeer);
  assert(audio instanceof f.Context);
  assert(audio instanceof f.window.AudioContext);
  assert.equal(peer.options, options);
  assert.equal(audio.options, options);
  assert.equal(f.window.RTCPeerConnection.generateCertificate(), 'certificate');
  f.dispose(); f.dispose();
  assert.deepEqual([peer.closes, audio.closes, legacy.closes], [1, 1, 1]);
});

test('cancel closes allocated contexts before pending permission resolves and rejects late capture', async () => {
  const f = fixture(), context = new f.window.AudioContext();
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => stops++ }] };
  const active = f.media.getUserMedia({ audio: true });
  f.pending.shift()(stream); await active;
  const late = f.media.getUserMedia({ audio: true });
  f.dispose();
  assert.equal(context.closes, 1);
  assert.equal(stops, 1);
  for (const name of ['RTCPeerConnection', 'AudioContext', 'webkitAudioContext']) {
    assert.throws(() => new f.window[name](), { name: 'AbortError' });
  }
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'AbortError' });
  assert.equal(f.pending.length, 1, 'closed capture must not call the underlying API');
  f.pending.shift()(stream);
  await assert.rejects(late, { name: 'AbortError' });
  assert.equal(stops, 2);
});

test('throwing close, rejected close and reentrant teardown cannot skip sibling cleanup', async () => {
  const f = fixture();
  const first = new f.window.RTCPeerConnection();
  const rejected = new f.window.AudioContext();
  const last = new f.window.AudioContext();
  first.onClose = () => { f.dispose(); throw Error('already disposed'); };
  rejected.onClose = () => Promise.reject(Error('close rejected'));
  let stops = 0;
  const capture = f.media.getUserMedia({ audio: true });
  f.pending.shift()({ getTracks: () => [
    { stop() { throw Error('stop failed'); } }, { stop() { stops++; } },
  ] });
  await capture;
  assert.doesNotThrow(f.dispose);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([first.closes, rejected.closes, last.closes, stops], [1, 1, 1, 1]);
});

for (const event of ['pagehide', 'unload', 'codex-realtime-dispose']) {
  test(`${event} closes all registered native resources`, () => {
    const f = fixture();
    const peer = new f.window.RTCPeerConnection(), context = new f.window.AudioContext();
    f.listeners.get(event)();
    assert.deepEqual([peer.closes, context.closes], [1, 1]);
    f.dispose();
    assert.deepEqual([peer.closes, context.closes], [1, 1]);
  });
}
