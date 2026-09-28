// Exercise the prepared Desktop component and its real tooltip-disabled branch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const assets = 'scratch/asar/webview/assets/';
const primary = fs.readFileSync(assets + 'app-primary-6b28e06666ff.js', 'utf8');
const initial = fs.readFileSync(assets + 'app-initial-236e1501144c.js', 'utf8');
function extract(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert(start >= 0 && end > start, 'Review component extraction after Desktop updates');
  return source.slice(start, end);
}
function setup(touch) {
  const listeners = new Set();
  const media = {
    matches: touch,
    addEventListener: (type, f) => { assert.equal(type, 'change'); listeners.add(f); },
    removeEventListener: (type, f) => { assert.equal(type, 'change'); listeners.delete(f); },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  let update, cleanup, clicks = 0;
  const cache = Array(18).fill(Symbol.for('react.memo_cache_sentinel'));
  const context = {
    window: { matchMedia: query => {
      assert.equal(query, '(hover: none), (pointer: coarse)'); return media;
    } },
    UDr: {
      useSyncExternalStore: (subscribe, snapshot) => {
        cleanup ||= subscribe(() => update()); return snapshot();
      },
      useState: () => [false, () => {}],
    },
    HDr: { c: () => cache }, y5: { jsx, jsxs: jsx, Fragment: 'fragment' },
    VDr: 'diff-content', dT: 'tooltip', WDr: 800, GDr: 'width',
    I6r: { c: n => Array(n).fill(Symbol.for('react.memo_cache_sentinel')) },
    PV: { useContext: () => null }, q6r: {}, K6r: {}, R6r: 800,
    FV: { jsx, Fragment: 'fragment' }, S6r: 'interactive-tooltip',
  };
  vm.createContext(context);
  vm.runInContext(extract(primary, 'function browserDiffPreviewMedia()', 'function zDr(e) {') +
    extract(initial, 'function MV(e) {', 'function S6r('), context);
  const child = { type: 'button', props: { onClick: () => clicks++ } };
  const props = { children: child, diff: { metadata: {} }, displayPath: 'file.md' };
  let preview, rendered;
  update = () => {
    preview = context.RDr(props).props.children[1];
    rendered = context.MV(preview.props);
  };
  update();
  return {
    child, listeners, cleanup: () => cleanup(), clicks: () => clicks,
    preview: () => preview, rendered: () => rendered,
    change: touch => { media.matches = touch; for (const f of listeners) f(); },
    disable: () => { props.disabled = true; update(); },
  };
}
test('touch devices have no hover/focus tooltip handlers; original click survives', () => {
  const r = setup(true);
  assert.equal(r.rendered().type, 'fragment');
  assert.equal(r.rendered().props.children, r.child);
  r.rendered().props.children.props.onClick();
  assert.equal(r.clicks(), 1);
  r.cleanup(); assert.equal(r.listeners.size, 0);
});
test('mouse keeps the native delayed interactive preview', () => {
  const r = setup(false);
  assert.equal(r.rendered().type, 'interactive-tooltip');
  assert.equal(r.preview().props.delayDuration, 800);
  assert.equal(r.preview().props.interactive, true);
  assert.equal(r.preview().props.children, r.child);
  r.disable(); assert.equal(r.rendered().type, 'fragment');
  r.cleanup();
});
test('changing primary pointer removes the preview and restores it; listener cleans up', () => {
  const r = setup(false);
  r.change(true);
  assert.equal(r.rendered().type, 'fragment');
  assert.equal(r.preview().key, 'disabled');
  r.change(false);
  assert.equal(r.rendered().type, 'interactive-tooltip');
  assert.equal(r.preview().key, 'enabled');
  assert.equal(r.listeners.size, 1);
  r.cleanup(); assert.equal(r.listeners.size, 0);
});
