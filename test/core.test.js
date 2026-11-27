'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

test('token shape', () => {
  assert.equal(core.isValidTokenShape('crossly_pat_live_a3b1c2d4_8x7yqo2nf3kl9d1mv6jr8b0teucp4hs2'), true);
  assert.equal(core.isValidTokenShape('sk_live_123'), false);
  assert.equal(core.isValidTokenShape('crossly_pat_'), false);
  assert.equal(core.isValidTokenShape('crossly_pat_live_abc def12345'), false);
  assert.equal(core.isValidTokenShape(undefined), false);
});

test('buildUrl encodes and skips empty params', () => {
  assert.equal(core.buildUrl('/v1/inventory'), 'https://crossly.net/api/v1/inventory');
  assert.equal(
    core.buildUrl('/v1/inventory', { page: 2, limit: 100, status: '', sku: 'A B&C', x: null }),
    'https://crossly.net/api/v1/inventory?page=2&limit=100&sku=A%20B%26C',
  );
});

test('header lookup is case-insensitive and unwraps arrays', () => {
  assert.equal(core.header({ 'retry-after': '7' }, 'Retry-After'), '7');
  assert.equal(core.header({ 'X-Quota-Remaining': ['0'] }, 'x-quota-remaining'), '0');
  assert.equal(core.header(undefined, 'a'), undefined);
});

test('parseError reads the envelope and falls back', () => {
  const e = core.parseError(404, JSON.stringify({ error: { code: 'not_found', message: 'Listing not found.' }, correlationId: 'c-1' }));
  assert.deepEqual([e.code, e.message, e.correlationId, e.status], ['not_found', 'Listing not found.', 'c-1', 404]);
  const f = core.parseError(500, '<html>');
  assert.equal(f.code, 'http_500');
  assert.match(core.formatError(e), /Listing not found\. \(not_found, HTTP 404\) correlationId c-1/);
});

test('retryDecision: 429 honours Retry-After, retry_storm is final, 5xx backs off, 4xx never', () => {
  assert.deepEqual(core.retryDecision(429, { 'Retry-After': '12' }, 1, ''), { retry: true, waitMs: 12250 });
  assert.deepEqual(core.retryDecision(429, {}, 1, ''), { retry: true, waitMs: 5250 });
  const storm = JSON.stringify({ error: { code: 'retry_storm', message: 'x' } });
  assert.equal(core.retryDecision(429, { 'Retry-After': '60' }, 1, storm).retry, false);
  assert.deepEqual(core.retryDecision(503, {}, 3, ''), { retry: true, waitMs: 4000 });
  assert.equal(core.retryDecision(400, {}, 1, '').retry, false);
  assert.equal(core.retryDecision(429, {}, core.MAX_ATTEMPTS, '').retry, false);
});

test('throttleWaitMs waits out a spent window only', () => {
  assert.equal(core.throttleWaitMs({ 'X-Quota-Remaining': '3', 'X-Quota-Reset': '40' }), 0);
  assert.equal(core.throttleWaitMs({ 'X-Quota-Remaining': '0', 'X-Quota-Reset': '40' }), 40250);
  assert.equal(core.throttleWaitMs({}), 0);
});

test('paginate stops on a short page and passes page/limit', () => {
  const calls = [];
  const pages = { 1: 100, 2: 100, 3: 7 };
  const r = core.paginate((page, limit) => {
    calls.push([page, limit]);
    return { data: Array.from({ length: pages[page] }, (_, i) => ({ id: page + '-' + i })) };
  });
  assert.equal(r.items.length, 207);
  assert.equal(r.truncated, false);
  assert.deepEqual(calls, [[1, 100], [2, 100], [3, 100]]);
});

test('paginate handles an exact multiple and the safety stop', () => {
  let n = 0;
  const r = core.paginate((page) => {
    n += 1;
    return { data: page === 1 ? Array(100).fill({}) : [] };
  });
  assert.equal(r.items.length, 100);
  assert.equal(n, 2);
  const t = core.paginate(() => ({ data: Array(2).fill({}) }), { limit: 2, maxPages: 3 });
  assert.equal(t.truncated, true);
  assert.equal(t.items.length, 6);
  assert.equal(core.paginate(() => null).items.length, 0);
  assert.equal(core.paginate(() => ({ offers: [{}] }), { listKey: 'offers' }).items.length, 1);
});

test('toRows maps columns, blanks nulls, JSON-encodes objects', () => {
  const rows = core.toRows([{ id: 'a', tags: ['x'], price: null, n: 0 }], ['id', 'tags', 'price', 'n', 'missing']);
  assert.deepEqual(rows, [['a', '["x"]', '', 0, '']]);
});

test('every sheet spec has an id column and its editable column', () => {
  for (const [key, spec] of Object.entries(core.SHEETS)) {
    assert.equal(spec.columns[0], 'id', key);
    assert.match(spec.path, /^\/v1\//);
    if (spec.editable) assert.ok(spec.columns.includes(spec.editable), key);
  }
  assert.equal(core.SHEETS.inventory.editable, 'quantityAvailable');
  assert.equal(core.SHEETS.listings.editable, 'price');
});

test('diffEdits finds changed quantities and rejects bad values', () => {
  const values = [
    ['id', 'sku', 'quantityAvailable'],
    ['a', 's1', 3], // unchanged
    ['b', 's2', 5], // changed from 2
    ['c', 's3', -1], // invalid
    ['d', 's4', 1.5], // invalid
    ['e', 's5', '0'], // changed from 4, as text
    ['zz', 's6', 9], // not in snapshot: ignored
    ['b', 's2', 8], // duplicate id: first wins
    ['', '', ''], // blank row
  ];
  const snap = { a: 3, b: 2, c: 1, d: 1, e: '4' };
  const r = core.diffEdits(values, snap, 'quantityAvailable', 'quantity');
  assert.deepEqual(r.edits, [
    { id: 'b', row: 3, value: 5, previous: 2 },
    { id: 'e', row: 6, value: 0, previous: 4 },
  ]);
  assert.deepEqual(
    r.invalid.map((x) => x.id),
    ['c', 'd'],
  );
});

test('diffEdits prices: string vs number equality, cents rounding, column found by header', () => {
  const values = [
    ['title', 'price', 'id'],
    ['t', 84, 'a'], // "84.00" pulled, Sheets made it 84: unchanged
    ['t', '$42.499', 'b'], // -> 42.5
    ['t', 0, 'c'], // invalid
    ['t', '', 'd'], // empty and was empty: ignored
  ];
  const r = core.diffEdits(values, { a: '84.00', b: '48.00', c: '10', d: '' }, 'price', 'price');
  assert.deepEqual(r.edits, [{ id: 'b', row: 3, value: 42.5, previous: 48 }]);
  assert.deepEqual(
    r.invalid.map((x) => x.id),
    ['c'],
  );
  assert.throws(() => core.diffEdits([['sku'], ['x']], {}, 'price', 'price'), /no "id"/);
  assert.deepEqual(core.diffEdits([['id']], {}, 'price', 'price'), { edits: [], invalid: [] });
});

test('stockPayloads chunks at 5000 in the per-item set shape', () => {
  const edits = Array.from({ length: 5001 }, (_, i) => ({ id: 'i' + i, value: i }));
  const bodies = core.stockPayloads(edits);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].mode, 'set');
  assert.equal(bodies[0].items.length, 5000);
  assert.deepEqual(bodies[1].items, [{ id: 'i5000', quantity: 5000 }]);
  assert.deepEqual(core.stockPayloads([]), []);
});

test('pricePayload and snapshotOf', () => {
  assert.deepEqual(core.pricePayload({ id: 'a', value: 24.99 }), { changes: { price: 24.99 } });
  assert.deepEqual(core.snapshotOf([{ id: 'a', price: '1.00' }, { id: 'b' }, {}], 'price'), { a: '1.00', b: '' });
});
