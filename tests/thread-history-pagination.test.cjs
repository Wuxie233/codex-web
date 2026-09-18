// Exercise the pinned Desktop history loader with synthetic protocol pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const file = process.env.HISTORY_ASSET || path.resolve(__dirname, '../scratch/asar/webview/assets/app-initial-236e1501144c.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('async function FS(');
const end = source.indexOf('\nvar IS =', start);
assert(start >= 0 && end > start, 'Desktop history loader must be reviewed after bundle updates');
const context = vm.createContext({ Gg: value => value, wS: () => null });
vm.runInContext(source.slice(start, end) + '\nthis.load = Z4t; this.page = FS;', context);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(counts) {
  const calls = [];
  const turns = counts.map((count, turn) => ({
    id: `turn-${turn}`, status: 'completed',
    items: Array.from({ length: count }, (_, item) => ({
      id: `turn-${turn}-item-${item}`,
      type: item === 0 ? 'userMessage' : 'commandExecution',
      ...(item === 0 ? { content: [{ type: 'text', text: 'Synthetic opening input' }] } : { aggregatedOutput: `synthetic output ${item}` }),
    })),
  }));
  const client = {
    getConversation: () => null,
    async sendRequest(method, params) {
      calls.push({ method, ...params });
      if (method.startsWith('thread/turns/')) {
        return { data: turns.map(({ items, ...turn }) => ({ ...turn, items: [], itemsView: 'notLoaded' })), nextCursor: 'older-turns' };
      }
      assert.equal(method, 'thread/items/list');
      const turn = turns.find(turn => turn.id === params.turnId);
      const ordered = params.sortDirection === 'asc' ? turn.items : turn.items.slice().reverse();
      const offset = params.cursor == null ? 0 : Number(params.cursor);
      const next = offset + params.limit;
      return {
        data: ordered.slice(offset, next).map(item => ({ turnId: turn.id, item })),
        nextCursor: next < ordered.length ? String(next) : null,
      };
    },
  };
  return {
    calls, turns, client,
    load: ({ limit = Infinity, view, cursor = null, method = 'thread/turns/list' } = {}) =>
      context.load(client, limit, null, 'synthetic-thread', null, cursor, 5, undefined, undefined, view, method),
  };
}

test('long turn opens with its latest 50 complete items and retains older history', async () => {
  const f = fixture([620]);
  const result = await f.load();
  const turn = result.response.data[0];
  const pagination = result.itemsPaginationByTurnId[turn.id];
  assert.equal(turn.items.length, 50, 'opening a long turn must not wait for five sequential item pages');
  assert.deepEqual(plain(turn.items), f.turns[0].items.slice(-50));
  assert.equal(turn.itemsView, 'summary');
  assert.equal(result.response.nextCursor, 'older-turns');
  assert.equal(pagination.olderCursor, '50');
  assert.equal(pagination.hasLoadedOldest, false);
  assert.equal(pagination.openingUserMessageId, f.turns[0].items[0].id);
  assert.deepEqual(plain(pagination.oldestUserInput), f.turns[0].items[0].content);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/items/list').map(call => [call.limit, call.sortDirection]), [[50, 'desc'], [2, 'asc']]);

  let cursor = pagination.olderCursor;
  let all = plain(turn.items);
  while (cursor != null) {
    const page = await context.page(f.client.sendRequest.bind(f.client), 'synthetic-thread', turn.id, cursor, undefined);
    all = plain(page.items).concat(all);
    cursor = page.nextCursor;
  }
  assert.deepEqual(all, f.turns[0].items, 'following the retained cursor recovers complete outputs in order without duplicates');
});

test('five long turns each receive their latest page without starving older turns', async () => {
  const f = fixture([200, 200, 200, 200, 200]);
  const result = await f.load();
  assert.deepEqual(plain(result.response.data.map(turn => turn.items.length)), [50, 50, 50, 50, 50]);
  for (const [index, turn] of result.response.data.entries()) {
    assert.deepEqual(plain(turn.items), f.turns[index].items.slice(-50));
    assert.equal(result.itemsPaginationByTurnId[turn.id].olderCursor, '50');
  }
});

test('short conversations stay complete without opening-input round trips', async () => {
  const f = fixture([3, 0, 50]);
  const result = await f.load();
  for (const [index, turn] of result.response.data.entries()) {
    assert.deepEqual(plain(turn.items), f.turns[index].items);
    assert.equal(turn.itemsView, 'full');
    assert.equal(result.itemsPaginationByTurnId[turn.id].hasLoadedOldest, true);
  }
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 3);
});

test('metadata-only calls do not request items', async () => {
  const f = fixture([200]);
  const result = await f.load({ view: 'notLoaded' });
  assert.equal(f.calls.length, 1);
  assert.equal(result.itemsPaginationByTurnId, undefined);
});

test('an existing smaller per-turn limit remains effective', async () => {
  const f = fixture([200]);
  const result = await f.load({ limit: 20 });
  assert.equal(result.response.data[0].items.length, 20);
  assert.equal(result.itemsPaginationByTurnId['turn-0'].olderCursor, '20');
});

test('live history preserves its caller limit and full item hydration', async () => {
  const f = fixture([120, 120]);
  const result = await f.load({ limit: 150, method: 'thread/turns/listLive' });
  for (const [index, turn] of result.response.data.entries()) {
    assert.deepEqual(plain(turn.items), f.turns[index].items);
    assert.equal(turn.itemsView, 'full');
  }
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/items/list').map(call => call.limit), [150, 150]);
});

test('resume continues from an existing item cursor without rereading its tail', async () => {
  const f = fixture([620]);
  const result = await f.load({ cursor: '100' });
  const turn = result.response.data[0];
  assert.deepEqual(plain(turn.items), f.turns[0].items.slice(470, 520));
  assert.equal(result.itemsPaginationByTurnId[turn.id].olderCursor, '150');
  assert.equal(f.calls[1].cursor, '100');
});
