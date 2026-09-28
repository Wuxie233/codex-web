// Exercise the injected tool handler against the pinned Desktop bundle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const asar = process.env.BROWSER_TOOLS_ASAR_DIR || path.join(root, 'scratch/asar');

function patchedAsset(asset, patchName, marker) {
  let source = fs.readFileSync(path.join(asar, asset), 'utf8');
  const alreadyApplied = source.includes(marker);
  const lines = fs.readFileSync(path.join(root, 'patches', patchName), 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('@@')) continue;
    const before = [], after = [];
    for (++index; index < lines.length && !lines[index].startsWith('@@'); index++) {
      if (lines[index].startsWith(' ') || lines[index].startsWith('-')) before.push(lines[index].slice(1));
      if (lines[index].startsWith(' ') || lines[index].startsWith('+')) after.push(lines[index].slice(1));
    }
    index--;
    const old = before.join('\n') + '\n';
    const updated = after.join('\n') + '\n';
    if (alreadyApplied) {
      assert.equal(source.split(updated).length, 2, `${patchName} must match the applied bundle; rebuild stale staged assets`);
      continue;
    }
    assert.equal(source.split(old).length, 2, `${patchName} must match its pinned source exactly once`);
    source = source.replace(old, updated);
  }
  return source;
}
const main = patchedAsset('.vite/build/main-C5K7o1Hr.js', 'main-remote-browser-tools.patch', 'function codexWebInstallRemoteBrowserTools(');
const webview = patchedAsset('webview/assets/app-initial-236e1501144c.js', 'webview-remote-browser-tools.patch', 'function codexWebRemoteBrowserToolSpecs(');
const helper = main.slice(main.indexOf('function codexWebInstallRemoteBrowserTools('), main.indexOf('// End Codex Web remote browser tools.'));
const catalog = webview.slice(webview.indexOf('function codexWebRemoteBrowserToolSpecs('), webview.indexOf('// End Codex Web browser tool catalog.'));
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(overrides = {}, hostId = 'local') {
  const calls = [], revealed = [], timers = new Map();
  let handler, notify, sequence = 0;
  const state = { conversationId: 'trusted-thread', browserTabId: 'visible-tab', url: 'https://example.com/', title: 'Example', closed: false };
  const runtime = {
    list(threadId) { calls.push(['list', threadId]); return [{ ...state, conversationId: threadId }]; },
    async command(input) { calls.push(['command', plain(input)]); return { state: { ...state, conversationId: input.conversationId, browserTabId: input.browserTabId } }; },
    async evaluate(route, expression) { calls.push(['evaluate', plain(route), expression]); return { state, value: 'page value' }; },
    ...overrides,
  };
  const context = vm.createContext({
    AbortController, __codexRemoteBrowser: runtime,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(helper + '\nthis.install = codexWebInstallRemoteBrowserTools;', context);
  context.install({
    registerInternalServerRequestHandler(spec) { assert.deepEqual(plain(spec.methods), ['item/tool/call']); handler = spec.handler; },
    registerInternalNotificationHandler(callback) { notify = callback; },
  }, hostId, message => revealed.push(plain(message)));
  const request = (tool, args = {}, params = {}) => handler({ method: 'item/tool/call', params: {
    namespace: 'codex_app', threadId: 'trusted-thread', turnId: 'turn-1', callId: `call-${++sequence}`, tool, arguments: args, ...params,
  } });
  return { request, notify, calls, revealed, timers, state,
    timeout() { assert.equal(timers.size, 1); const timer = [...timers.values()][0]; assert.equal(timer.delay, 60000); timer.fn(); },
    clean() { assert.equal(timers.size, 0); },
  };
}

test('catalog exposes shared task tools without client-supplied task identity', () => {
  const context = vm.createContext({});
  vm.runInContext(catalog + '\nthis.specs = codexWebRemoteBrowserToolSpecs();', context);
  assert.deepEqual(plain(context.specs.map(tool => tool.name)), ['browser_tabs', 'browser_open', 'browser_action', 'browser_evaluate']);
  for (const tool of context.specs) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const forbidden of ['threadId', 'conversationId', 'hostId']) assert(!Object.hasOwn(tool.inputSchema.properties, forbidden));
  }
});

test('open uses the trusted request task and reuses the tab visible to the user', async () => {
  const f = fixture();
  const result = await f.request('browser_open', { url: 'https://example.com/new' });
  assert.equal(result.success, true);
  assert.deepEqual(f.calls, [['list', 'trusted-thread'], ['command', { conversationId: 'trusted-thread', browserTabId: 'visible-tab', action: 'open', url: 'https://example.com/new' }]]);
  assert.deepEqual(f.revealed[0], { type: 'open-browser-tab', conversationId: 'trusted-thread', browserTabId: 'visible-tab', initialUrl: f.state.url, source: 'manual', initiator: 'window_open' });
  f.clean();
});

test('arguments cannot redirect a call to another task or host', async () => {
  const f = fixture();
  for (const field of ['threadId', 'conversationId', 'hostId']) {
    const result = await f.request('browser_open', { [field]: 'other-thread' });
    assert.equal(result.success, false);
    assert.match(result.contentItems[0].text, /identity is supplied by the runtime/);
  }
  assert.equal(f.calls.length, 0);
  f.clean();
});

test('browser_tabs reads only the requesting task and does not create a page', async () => {
  const f = fixture();
  const result = await f.request('browser_tabs');
  assert.equal(result.success, true);
  assert.deepEqual(f.calls, [['list', 'trusted-thread']]);
  assert.equal(JSON.parse(result.contentItems[0].text).tabs[0].browserTabId, 'visible-tab');
  f.clean();
});

test('screenshot includes an inputImage, without duplicating image bytes in text', async () => {
  const f = fixture({ async command() { return { state: f.state, value: { mimeType: 'image/png', data: 'iVBORw0KGgoAAA==' } }; } });
  const result = await f.request('browser_action', { action: 'screenshot' });
  assert.equal(result.success, true);
  assert.deepEqual(plain(result.contentItems[1]), { type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgoAAA==' });
  assert(!result.contentItems[0].text.includes('iVBOR'));
  f.clean();
});

test('evaluation uses the same owned tab and parses JSON arguments', async () => {
  const f = fixture();
  const result = await f.request('browser_evaluate', JSON.stringify({ browserTabId: 'chosen-tab', expression: 'document.title' }));
  assert.equal(result.success, true);
  assert.deepEqual(f.calls[1], ['evaluate', { conversationId: 'trusted-thread', browserTabId: 'chosen-tab' }, 'document.title']);
  f.clean();
});

test('duplicate requests share one execution including an unknown error outcome', async () => {
  let attempts = 0;
  const f = fixture({ async command() { attempts++; throw new Error('connection lost after click'); } });
  const params = { callId: 'same-call' };
  const first = f.request('browser_action', { action: 'mouse', eventType: 'click', x: 4, y: 9 }, params);
  const second = f.request('browser_action', { action: 'mouse', eventType: 'click', x: 4, y: 9 }, params);
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /Do not automatically retry/);
  assert.equal(attempts, 1);
  assert.equal(await f.request('browser_action', { action: 'reload' }, params), result);
  assert.equal(attempts, 1);
  f.clean();
});

test('evicting a cached response never replays an earlier unknown write', async () => {
  let attempts = 0;
  const f = fixture({ async command() { attempts++; throw new Error('dispatched then transport lost'); } });
  const args = { action: 'text', text: 'send once' };
  const first = await f.request('browser_action', args, { callId: 'old-unknown-call' });
  assert.equal(first.success, false);
  for (let i = 0; i < 130; i++) await f.request('browser_tabs');
  const duplicate = await f.request('browser_action', args, { callId: 'old-unknown-call' });
  assert.equal(duplicate.success, false);
  assert.match(duplicate.contentItems[0].text, /not replayed/);
  assert.equal(attempts, 1);
  f.clean();
});

test('interrupted turn fails a pending call and never reports late success', async () => {
  const wait = deferred();
  let operationSignal;
  const f = fixture({ command(input, signal) { operationSignal = signal; return wait.promise; } });
  const resultPromise = f.request('browser_open');
  assert.equal(operationSignal.aborted, false);
  f.notify({ method: 'turn/completed', params: { threadId: 'another-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.equal(f.timers.size, 1);
  f.notify({ method: 'turn/completed', params: { threadId: 'trusted-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
  const result = await resultPromise;
  assert.equal(result.success, false);
  assert.equal(operationSignal.aborted, true);
  assert.match(result.contentItems[0].text, /cancelled.*may have executed/);
  wait.resolve({ state: f.state });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.revealed.length, 0);
  f.clean();
});

test('evaluate receives cancellation before its queued page operation is dispatched', async () => {
  const gate = deferred();
  let writes = 0;
  const f = fixture({ async evaluate(route, expression, signal) {
    await gate.promise;
    signal.throwIfAborted();
    writes++;
    return { state: f.state, value: writes };
  } });
  const pending = f.request('browser_evaluate', { expression: 'window.sideEffect = 1' });
  f.notify({ method: 'turn/completed', params: { threadId: 'trusted-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.equal((await pending).success, false);
  gate.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(writes, 0);
  f.clean();
});

test('timeout reports unknown outcome once without replaying the operation', async () => {
  let attempts = 0;
  const f = fixture({ command() { attempts++; return new Promise(() => {}); } });
  const pending = f.request('browser_action', { action: 'text', text: 'hello' }, { callId: 'timeout-call' });
  f.timeout();
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /timed out.*unknown/);
  assert.equal(await f.request('browser_action', { action: 'reload' }, { callId: 'timeout-call' }), result);
  assert.equal(attempts, 1);
  f.clean();
});

test('unrelated namespaces pass through and remote hosts cannot use the local browser', async () => {
  const f = fixture();
  assert.equal(f.request('read_thread_terminal'), null);
  assert.equal(f.request('browser_open', {}, { namespace: 'other' }), null);
  assert.equal((await f.request('browser_open', {}, { threadId: '' })).success, false);
  const remote = fixture({}, 'remote-host');
  assert.equal((await remote.request('browser_open')).success, false);
  assert.equal(remote.calls.length, 0);
  f.clean(); remote.clean();
});

test('HTTP user input and native browser tools share one real Chromium page', { timeout: 45_000 }, async (t) => {
  const http = require('node:http');
  const Fastify = require('fastify');
  const serverDirectory = process.env.BROWSER_TOOLS_SERVER_DIR || path.join(root, 'src/server');
  const { RemoteBrowser } = require(path.join(serverDirectory, 'remote-browser.js'));
  const { registerRemoteBrowserRoutes } = require(path.join(serverDirectory, 'remote-browser-routes.js'));
  const browser = new RemoteBrowser();
  const app = Fastify();
  const fixtureServer = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html;charset=utf-8');
    response.end(`<!doctype html><title>Shared browser integration</title>
      <style>body{margin:0}input{position:absolute;left:20px;top:20px;width:240px;height:30px}
      #result{position:absolute;left:20px;top:80px;width:400px;height:40px;margin:0}</style>
      <input id="entry"><div id="result">Ready</div>`);
  });
  const target = { conversationId: 'shared-tool-integration', browserTabId: 'visible-tab' };
  t.after(async () => {
    try {
      await app.close();
    } finally {
      try {
        await browser.dispose();
      } finally {
        fixtureServer.closeAllConnections();
        await new Promise((resolve) => fixtureServer.close(resolve));
      }
    }
    assert.equal(app.server.listening, false);
    assert.equal(fixtureServer.listening, false);
    assert.deepEqual(browser.list(target.conversationId), []);
  });
  registerRemoteBrowserRoutes(app, browser);
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const uiCommand = async (action, input = {}) => {
    const response = await fetch(`${base}/__backend/remote-browser/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ ...target, action, ...input }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };

  let handler, callId = 0;
  const revealed = [];
  const context = vm.createContext({ __codexRemoteBrowser: browser, AbortController, setTimeout, clearTimeout });
  vm.runInContext(helper + '\nthis.install = codexWebInstallRemoteBrowserTools;', context);
  context.install({
    registerInternalServerRequestHandler(spec) { handler = spec.handler; },
    registerInternalNotificationHandler() {},
  }, 'local', message => revealed.push(plain(message)));
  const tool = async (name, args = {}) => {
    const result = await handler({ method: 'item/tool/call', params: {
      namespace: 'codex_app', threadId: target.conversationId, turnId: 'integration-turn',
      callId: `integration-call-${++callId}`, tool: name, arguments: args,
    } });
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
  };
  const toolValue = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);

  const opened = await uiCommand('open', { url: fixtureUrl, width: 640, height: 360 });
  assert.equal(opened.state.title, 'Shared browser integration');
  const tabs = toolValue(await tool('browser_tabs')).tabs;
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].conversationId, target.conversationId);
  assert.equal(tabs[0].browserTabId, target.browserTabId);
  await tool('browser_open');
  assert.equal(revealed[0].browserTabId, target.browserTabId);
  assert.equal(revealed[0].conversationId, target.conversationId);
  await uiCommand('mouse', { eventType: 'click', x: 60, y: 35 });
  await uiCommand('text', { text: '来自用户 UI' });
  const read = toolValue(await tool('browser_evaluate', { expression: "document.getElementById('entry').value" }));
  assert.equal(read.value, '来自用户 UI');
  assert.equal(read.state.browserTabId, target.browserTabId);
  assert.equal(read.state.conversationId, target.conversationId);

  const write = toolValue(await tool('browser_evaluate', { expression: "(() => { document.getElementById('result').textContent = '来自 Codex 工具'; window.toolWrites = (window.toolWrites || 0) + 1; return window.toolWrites; })()" }));
  assert.equal(write.value, 1);
  const inspected = await uiCommand('inspect', { x: 30, y: 95 });
  assert.equal(inspected.value.selector, '#result');
  assert.equal(inspected.value.text, '来自 Codex 工具');
  assert.equal(inspected.value.url, fixtureUrl);

  const screenshot = await tool('browser_action', { action: 'screenshot' });
  const image = screenshot.contentItems.find(item => item.type === 'inputImage');
  assert.match(image.imageUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(image.imageUrl.split(',')[1], 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 360);
  assert.equal(toolValue(screenshot).state.browserTabId, target.browserTabId);
  assert(!screenshot.contentItems[0].text.includes(image.imageUrl.split(',')[1]));
});
