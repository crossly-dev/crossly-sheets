'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, plain } = require('./harness.js');

const TOKEN = 'crossly_pat_live_a3b1c2d4_8x7yqo2nf3kl9d1mv6jr8b0teucp4hs2';
const API = 'https://crossly.net/api';

function inventoryItem(i, q) {
  return { id: 'inv-' + i, sku: 'SKU-' + i, defaultTitle: 'Item ' + i, status: 'active', quantity: q, quantityAvailable: q, quantityReserved: 0, quantitySold: 0, updatedAt: '2026-11-01T00:00:00.000Z' };
}

test('onOpen builds the Crossly menu with every command wired to a real function', () => {
  const env = makeEnv();
  env.context.onOpen({});
  const labels = env.menu.map((m) => m[0]);
  assert.deepEqual(labels, [
    'Set API token…',
    'Pull inventory',
    'Pull listings',
    'Pull orders',
    'Pull sales',
    'Push stock changes (Inventory)',
    'Push price changes (Listings)',
    'Clear API token',
  ]);
  for (const [, fn] of env.menu) assert.equal(typeof env.context[fn], 'function', fn);
});

test('set token: validated with GET /v1/me, stored in UserProperties only, never written to a sheet', () => {
  const env = makeEnv({
    routes: [{ method: 'get', match: API + '/v1/me', respond: () => ({ body: { displayName: 'Shop', scopes: ['inventory:read'] } }) }],
  });
  env.prompts.push({ getSelectedButton: () => 'OK', getResponseText: () => '  ' + TOKEN + '  ' });
  env.context.crosslySetToken();
  assert.equal(env.props.get('CROSSLY_PAT'), TOKEN);
  assert.equal(env.calls[0].headers.Authorization, 'Bearer ' + TOKEN);
  assert.match(env.alerts[0], /Connected to Crossly as Shop\. Scopes: inventory:read\./);
  assert.ok(!env.alerts[0].includes(TOKEN));
  assert.equal(env.sheets.size, 0);
});

test('set token: a rejected token is not stored and the API message is shown', () => {
  const env = makeEnv({
    routes: [{ method: 'get', match: API + '/v1/me', respond: () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Token revoked.' }, correlationId: 'k1' } }) }],
  });
  env.prompts.push({ getSelectedButton: () => 'OK', getResponseText: () => TOKEN });
  env.context.crosslySetToken();
  assert.equal(env.props.has('CROSSLY_PAT'), false);
  assert.match(env.alerts[0], /Token revoked\. \(unauthorized, HTTP 401\) correlationId k1/);
});

test('set token: malformed input never reaches the network', () => {
  const env = makeEnv();
  env.prompts.push({ getSelectedButton: () => 'OK', getResponseText: () => 'hello' });
  env.context.crosslySetToken();
  assert.equal(env.calls.length, 0);
  assert.match(env.alerts[0], /crossly_pat_/);
});

test('clear token removes it', () => {
  const env = makeEnv({ token: TOKEN });
  env.context.crosslyClearToken();
  assert.equal(env.props.has('CROSSLY_PAT'), false);
});

test('pull without a token explains what to do', () => {
  const env = makeEnv();
  env.context.crosslyPullOrders();
  assert.match(env.alerts[0], /Set API token/);
  assert.equal(env.calls.length, 0);
});

test('pull inventory pages with limit=100 to a short page, writes the sheet and a hidden snapshot', () => {
  const env = makeEnv({
    token: TOKEN,
    routes: [
      {
        method: 'get',
        match: /\/v1\/inventory\?page=\d+&limit=100$/,
        respond: (url) => {
          const page = Number(/page=(\d+)/.exec(url)[1]);
          const n = page === 1 ? 100 : 3;
          return { body: { data: Array.from({ length: n }, (_, i) => inventoryItem((page - 1) * 100 + i, 2)), pagination: { page, limit: 100 } } };
        },
      },
    ],
  });
  env.context.crosslyPullInventory();
  assert.deepEqual(
    env.calls.map((c) => c.url),
    [API + '/v1/inventory?page=1&limit=100', API + '/v1/inventory?page=2&limit=100'],
  );
  const sheet = env.sheets.get('Crossly Inventory');
  assert.equal(sheet.cells.length, 104);
  assert.equal(sheet.cells[0][0], 'id');
  assert.equal(sheet.cells[1][0], 'inv-0');
  const snap = env.sheets.get('_crossly_snapshot_inventory');
  assert.equal(snap.hidden, true);
  assert.equal(snap.cells.length, 104);
  assert.match(env.toasts[0], /Pulled 103 rows/);
});

test('429 is retried after Retry-After; X-Quota-Remaining 0 pauses before the next call', () => {
  const env = makeEnv({
    token: TOKEN,
    routes: [
      {
        method: 'get',
        match: /\/v1\/sales\?/,
        respond: (url, p, n) =>
          n === 1
            ? { status: 429, headers: { 'Retry-After': '3' }, body: { error: { code: 'rate_limited', message: 'slow down' } } }
            : { headers: { 'X-Quota-Remaining': '0', 'X-Quota-Reset': '9' }, body: { data: [{ id: 's1', platform: 'ebay', salePrice: '10.00' }] } },
      },
    ],
  });
  env.context.crosslyPullSales();
  assert.equal(env.calls.length, 2);
  assert.deepEqual(env.sleeps, [3250, 9250]);
  assert.equal(env.sheets.get('Crossly Sales').cells[1][0], 's1');
});

test('push stock: only edited rows go out as one bulk-quantity "set" call, then the sheet is re-pulled', () => {
  let stock = [inventoryItem(1, 2), inventoryItem(2, 5), inventoryItem(3, 1)];
  const env = makeEnv({
    token: TOKEN,
    routes: [
      { method: 'get', match: /\/v1\/inventory\?/, respond: () => ({ body: { data: stock } }) },
      {
        method: 'post',
        match: API + '/v1/inventory/bulk-quantity',
        respond: (url, params) => {
          const body = JSON.parse(params.payload);
          stock = stock.map((s) => {
            const hit = body.items.find((i) => i.id === s.id);
            return hit ? { ...s, quantityAvailable: hit.quantity } : s;
          });
          return { body: { affected: body.items.length, skipped: 0, bulkJobId: 'bj1' } };
        },
      },
    ],
  });
  env.context.crosslyPullInventory();
  const sheet = env.sheets.get('Crossly Inventory');
  const col = sheet.cells[0].indexOf('quantityAvailable');
  sheet.cells[1][col] = 7; // inv-1: 2 -> 7
  sheet.cells[3][col] = -4; // inv-3: invalid
  env.context.crosslyPushStock();
  const post = env.calls.find((c) => c.method === 'post');
  assert.deepEqual(plain(post.body), { mode: 'set', items: [{ id: 'inv-1', quantity: 7 }] });
  assert.equal(env.calls.filter((c) => c.method === 'post').length, 1);
  assert.match(env.alerts[0], /Pushed 1 stock change\(s\): 1 updated, 0 skipped/);
  assert.match(env.alerts[0], /1 row\(s\) had an invalid value/);
  // re-pulled: snapshot now holds 7, so a second push sends nothing
  env.context.crosslyPushStock();
  assert.equal(env.calls.filter((c) => c.method === 'post').length, 1);
  assert.match(env.alerts[1], /No stock changes/);
});

test('push prices: PATCH /v1/listings/{id} with {changes:{price}} per edited row; failures are reported per row', () => {
  const listings = [
    { id: 'l-1', sku: 'A', title: 'A', price: '84.00', currency: 'USD', status: 'active' },
    { id: 'l-2', sku: 'B', title: 'B', price: '20.00', currency: 'USD', status: 'active' },
    { id: 'l-3', sku: 'C', title: 'C', price: '30.00', currency: 'USD', status: 'active' },
  ];
  const env = makeEnv({
    token: TOKEN,
    routes: [
      { method: 'get', match: /\/v1\/listings\?/, respond: () => ({ body: { data: listings } }) },
      {
        method: 'patch',
        match: /\/v1\/listings\/l-\d$/,
        respond: (url) =>
          url.endsWith('l-3')
            ? { status: 409, body: { error: { code: 'listing_locked', message: 'Listing is being edited.' } } }
            : { body: { jobs: [] } },
      },
    ],
  });
  env.context.crosslyPullListings();
  const sheet = env.sheets.get('Crossly Listings');
  const col = sheet.cells[0].indexOf('price');
  assert.equal(sheet.cells[1][col], 84); // Sheets made "84.00" a number; must not count as an edit
  sheet.cells[2][col] = '24.99';
  sheet.cells[3][col] = 35;
  env.context.crosslyPushPrices();
  const patches = env.calls.filter((c) => c.method === 'patch');
  assert.deepEqual(
    plain(patches.map((p) => [p.url, p.body])),
    [
      [API + '/v1/listings/l-2', { changes: { price: 24.99 } }],
      [API + '/v1/listings/l-3', { changes: { price: 35 } }],
    ],
  );
  assert.match(env.alerts[0], /Pushed 1 of 2 price change\(s\)/);
  assert.match(env.alerts[0], /row 4: Listing is being edited\. \(listing_locked, HTTP 409\)/);
});

test('push before pull asks for a pull', () => {
  const env = makeEnv({ token: TOKEN });
  env.context.crosslyPushPrices();
  assert.match(env.alerts[0], /Pull "Crossly Listings" first/);
});
