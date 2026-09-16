// Exercise the actual Desktop component after prepare_asar, without a daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assets = path.resolve(__dirname, '../scratch/asar/webview/assets');
const file = process.env.SIDEBAR_ASSET || path.join(assets, fs.readdirSync(assets).find(n => /^app-primary-.*\.js$/.test(n)));
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('function YTt(e) {');
const end = source.indexOf('\nvar ', start);
assert(start >= 0 && end > start, 'Desktop pagination component must be reviewed after bundle updates');
const component = source.slice(start, end);
function render(props, observe = true) {
  const effects = [], observers = [], refs = [];
  let refIndex = 0;
  let loads = 0;
  const jsx = (type, props) => ({ type, props });
  const context = {
    ZTt: { c: n => Array(n).fill(Symbol.for('react.memo_cache_sentinel')) },
    fL: { useRef: initial => refs[refIndex++] ||= ({ current: initial === null ? {} : initial }), useEffectEvent: f => f, useEffect: f => effects.push(f) },
    pL: { jsx, jsxs: jsx, Fragment: 'fragment' }, Ym: 'spinner', Y: 'translation',
    ...(observe ? { IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    }} : {}),
  };
  vm.createContext(context);
  vm.runInContext(component + '\nthis.render = YTt;', context);
  const node = context.render({ ...props, onLoadNextPage: () => loads++ });
  const cleanups = effects.map(f => f());
  const find = (n, type) => n && typeof n === 'object' && (n.type === type ? n : [n.props?.children].flat().map(c => find(c, type)).find(Boolean));
  return { node, observers, find: type => find(node, type), loads: () => loads, cleanup: () => cleanups.forEach(f => f?.()), rerender: next => { refIndex = 0; effects.length = 0; context.render({ ...props, ...next, onLoadNextPage: () => loads++ }); effects.forEach(f => f()); } };
}
test('idle next page offers a button rather than an endless spinner', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: false });
  assert(!r.find('spinner'), 'Idle pagination must not claim a request is in flight');
  assert(r.find('button'), 'Users can request the next page even if observation fails');
  r.find('button').props.onClick();
  assert.equal(r.loads(), 1);
});
test('intersection still requests a real next page and disconnects', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: false });
  assert.equal(r.observers.length, 1);
  r.observers[0].callback([{ isIntersecting: false }]); assert.equal(r.loads(), 0);
  r.observers[0].callback([{ isIntersecting: true }]); assert.equal(r.loads(), 1);
  assert(r.observers[0].disconnected); r.cleanup();
});
test('only pending requests show the loading indicator', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: true });
  assert(r.find('spinner')); assert(!r.find('button')); assert.equal(r.observers.length, 0);
});
test('exhausted pages render nothing and do not fetch', () => {
  const r = render({ hasNextPage: false, isFetchingNextPage: false });
  assert.equal(r.node, null); assert.equal(r.loads(), 0); assert.equal(r.observers.length, 0);
});
test('browsers without IntersectionObserver keep the existing fetch fallback', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: false }, false);
  assert.equal(r.loads(), 1);
});

test('a failed or no-progress page does not automatically retry on every idle transition', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: false });
  r.observers[0].callback([{ isIntersecting: true }]);
  r.rerender({ isFetchingNextPage: true });
  r.rerender({ isFetchingNextPage: false });
  assert.equal(r.observers.length, 1, 'unchanged page must not rearm automatic loading');
  assert.equal(r.loads(), 1);
  r.find('button').props.onClick();
  assert.equal(r.loads(), 2, 'manual retry remains available');
  const nextPage = render({ hasNextPage: true, isFetchingNextPage: false });
  assert.equal(nextPage.observers.length, 1, 'newly keyed rows rearm pagination');
});

test('manual loading before intersection does not double-submit the automatic request', () => {
  const r = render({ hasNextPage: true, isFetchingNextPage: false });
  r.find('button').props.onClick();
  r.observers[0].callback([{ isIntersecting: true }]);
  assert.equal(r.loads(), 1);
});

test('both Desktop pagination call sites remount when visible rows advance', () => {
  // The per-mount attempt fence relies on these real React keys, not on a
  // synthetic rerender. Fail loudly when a future bundle changes the wiring.
  assert.match(source, /YTt,\s*\{\s*browserLoadingPlaceholder: T,\s*hasNextPage: De,\s*isFetchingNextPage: B,\s*onLoadNextPage: Ae,\s*\},\s*ue\.length,/);
  assert.match(source, /YTt,\s*\{\s*browserLoadingPlaceholder:[\s\S]{0,400}?onLoadNextPage: \(\) => \{\s*vve\(u, o\)\.catch\(Onr\);\s*\},\s*\},\s*K,/);
  assert.match(source, /\(t\[131\] = ue\.length\)/);
  assert.match(source, /t\[111\] !== K/);
});
