/**
 * Crossly for Google Sheets — Apps Script glue.
 *
 * Every Apps Script global is read in exactly one place, `crosslyEnv_()`, so
 * the tests can run this file in a sandbox with mocks. The token lives only in
 * the current user's UserProperties: it is never written to a cell, a note, a
 * document property or a log line.
 */
/* global CrosslyCore, SpreadsheetApp, UrlFetchApp, PropertiesService, Utilities */
/* exported onOpen, onInstall, crosslySetToken, crosslyClearToken, crosslyPullInventory,
   crosslyPullListings, crosslyPullOrders, crosslyPullSales, crosslyPushStock, crosslyPushPrices */

var CROSSLY_TOKEN_KEY = 'CROSSLY_PAT';
var CROSSLY_SNAPSHOT_PREFIX = '_crossly_snapshot_';

function crosslyEnv_() {
  return {
    spreadsheet: SpreadsheetApp.getActiveSpreadsheet(),
    ui: SpreadsheetApp.getUi(),
    fetch: function (url, params) {
      return UrlFetchApp.fetch(url, params);
    },
    userProps: PropertiesService.getUserProperties(),
    sleep: function (ms) {
      Utilities.sleep(ms);
    },
  };
}

// ── Menu ────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem('Set API token…', 'crosslySetToken')
    .addSeparator()
    .addItem('Pull inventory', 'crosslyPullInventory')
    .addItem('Pull listings', 'crosslyPullListings')
    .addItem('Pull orders', 'crosslyPullOrders')
    .addItem('Pull sales', 'crosslyPullSales')
    .addSeparator()
    .addItem('Push stock changes (Inventory)', 'crosslyPushStock')
    .addItem('Push price changes (Listings)', 'crosslyPushPrices')
    .addSeparator()
    .addItem('Clear API token', 'crosslyClearToken')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

// ── HTTP ────────────────────────────────────────────────────────────────

/**
 * One API call with backoff. Returns the parsed body; throws an Error whose
 * message is the API's own `error.message` + code + correlationId.
 */
function crosslyRequest_(env, token, method, path, options) {
  var opts = options || {};
  var url = CrosslyCore.buildUrl(path, opts.query);
  var params = {
    method: method.toLowerCase(),
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  };
  if (opts.body !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.body);
  }
  for (var attempt = 1; ; attempt += 1) {
    var res = env.fetch(url, params);
    var status = res.getResponseCode();
    var headers = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
    var text = res.getContentText();
    if (status >= 200 && status < 300) {
      var wait = CrosslyCore.throttleWaitMs(headers);
      if (wait > 0) env.sleep(wait);
      return CrosslyCore.safeJson(text);
    }
    var decision = CrosslyCore.retryDecision(status, headers, attempt, text);
    if (!decision.retry) {
      var err = new Error(CrosslyCore.formatError(CrosslyCore.parseError(status, text)));
      err.status = status;
      throw err;
    }
    env.sleep(decision.waitMs);
  }
}

function crosslyRequireToken_(env) {
  var token = env.userProps.getProperty(CROSSLY_TOKEN_KEY);
  if (!token) throw new Error('No Crossly API token yet. Open Crossly → Set API token… first.');
  return token;
}

// ── Token ───────────────────────────────────────────────────────────────

function crosslySetToken() {
  var env = crosslyEnv_();
  var ui = env.ui;
  var answer = ui.prompt(
    'Crossly API token',
    'Paste a Personal Access Token (crossly_pat_…) from Crossly → Settings → API & webhooks. ' +
      'It is stored only in your own Google account (UserProperties), never in this spreadsheet.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  var result = crosslySaveToken_(env, String(answer.getResponseText() || '').trim());
  ui.alert(result.message);
}

/** Validate with GET /v1/me before storing. Returns { ok, message }. */
function crosslySaveToken_(env, token) {
  if (!CrosslyCore.isValidTokenShape(token)) {
    return { ok: false, message: 'That does not look like a Crossly token (it should start with crossly_pat_).' };
  }
  var me;
  try {
    me = crosslyRequest_(env, token, 'GET', '/v1/me');
  } catch (e) {
    return { ok: false, message: 'Crossly rejected the token: ' + e.message };
  }
  env.userProps.setProperty(CROSSLY_TOKEN_KEY, token);
  var who = (me && (me.displayName || me.email)) || 'your account';
  var scopes = me && Array.isArray(me.scopes) && me.scopes.length ? ' Scopes: ' + me.scopes.join(', ') + '.' : '';
  return { ok: true, message: 'Connected to Crossly as ' + who + '.' + scopes };
}

function crosslyClearToken() {
  var env = crosslyEnv_();
  env.userProps.deleteProperty(CROSSLY_TOKEN_KEY);
  env.ui.alert('Your Crossly token was removed from this Google account.');
}

// ── Pull ────────────────────────────────────────────────────────────────

function crosslyPull_(env, key) {
  var spec = CrosslyCore.SHEETS[key];
  var token = crosslyRequireToken_(env);
  var result = CrosslyCore.paginate(function (page, limit) {
    return crosslyRequest_(env, token, 'GET', spec.path, { query: { page: page, limit: limit } });
  });
  var rows = CrosslyCore.toRows(result.items, spec.columns);
  var sheet = env.spreadsheet.getSheetByName(spec.title) || env.spreadsheet.insertSheet(spec.title);
  sheet.clearContents();
  var values = [spec.columns].concat(rows);
  var idRange = sheet.getRange(1, 1, values.length, 1);
  idRange.setNumberFormat('@'); // ids stay text
  sheet.getRange(1, 1, values.length, spec.columns.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, spec.columns.length).setFontWeight('bold');
  if (spec.editable) {
    var col = spec.columns.indexOf(spec.editable) + 1;
    sheet.getRange(1, col).setBackground('#fff2cc').setNote('Editable: change values here, then use Crossly → Push.');
    crosslyWriteSnapshot_(env, key, CrosslyCore.snapshotOf(result.items, spec.editable));
  }
  var msg = 'Pulled ' + rows.length + ' rows into "' + spec.title + '".';
  if (result.truncated) msg += ' Stopped at the safety limit; some rows were not pulled.';
  return { count: rows.length, truncated: result.truncated, message: msg };
}

function crosslyRunPull_(key) {
  var env = crosslyEnv_();
  try {
    var r = crosslyPull_(env, key);
    env.spreadsheet.toast(r.message, 'Crossly', 5);
  } catch (e) {
    env.ui.alert('Crossly: ' + e.message);
  }
}

function crosslyPullInventory() {
  crosslyRunPull_('inventory');
}
function crosslyPullListings() {
  crosslyRunPull_('listings');
}
function crosslyPullOrders() {
  crosslyRunPull_('orders');
}
function crosslyPullSales() {
  crosslyRunPull_('sales');
}

// ── Snapshot (hidden sheet of the values as pulled) ─────────────────────

function crosslyWriteSnapshot_(env, key, snap) {
  var name = CROSSLY_SNAPSHOT_PREFIX + key;
  var sheet = env.spreadsheet.getSheetByName(name) || env.spreadsheet.insertSheet(name);
  sheet.clearContents();
  var ids = Object.keys(snap);
  var values = [['id', 'value']].concat(
    ids.map(function (id) {
      return [id, CrosslyCore.toCell(snap[id])];
    }),
  );
  sheet.getRange(1, 1, values.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, values.length, 2).setValues(values);
  sheet.hideSheet();
}

function crosslyReadSnapshot_(env, key) {
  var sheet = env.spreadsheet.getSheetByName(CROSSLY_SNAPSHOT_PREFIX + key);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  var snap = {};
  for (var i = 1; i < values.length; i += 1) snap[String(values[i][0])] = values[i][1];
  return snap;
}

function crosslyLoadEdits_(env, key, kind) {
  var spec = CrosslyCore.SHEETS[key];
  var sheet = env.spreadsheet.getSheetByName(spec.title);
  var snap = crosslyReadSnapshot_(env, key);
  if (!sheet || !snap) throw new Error('Pull "' + spec.title + '" first, edit the highlighted column, then push.');
  return CrosslyCore.diffEdits(sheet.getDataRange().getValues(), snap, spec.editable, kind);
}

// ── Push ────────────────────────────────────────────────────────────────

/** Inventory.quantityAvailable → POST /v1/inventory/bulk-quantity, one write per 5,000 items. */
function crosslyPushStock_(env) {
  var token = crosslyRequireToken_(env);
  var diff = crosslyLoadEdits_(env, 'inventory', 'quantity');
  var affected = 0;
  var skipped = 0;
  CrosslyCore.stockPayloads(diff.edits).forEach(function (body) {
    var res = crosslyRequest_(env, token, 'POST', '/v1/inventory/bulk-quantity', { body: body });
    affected += (res && res.affected) || 0;
    skipped += (res && res.skipped) || 0;
  });
  if (diff.edits.length) crosslyPull_(env, 'inventory');
  return {
    changed: diff.edits.length,
    affected: affected,
    skipped: skipped,
    invalid: diff.invalid.length,
    message:
      diff.edits.length === 0
        ? 'No stock changes to push.'
        : 'Pushed ' + diff.edits.length + ' stock change(s): ' + affected + ' updated, ' + skipped + ' skipped. ' +
          'Live listings follow in the background.',
  };
}

/** Listings.price → PATCH /v1/listings/{id} per changed row, throttled by the quota headers. */
function crosslyPushPrices_(env) {
  var token = crosslyRequireToken_(env);
  var diff = crosslyLoadEdits_(env, 'listings', 'price');
  var ok = 0;
  var failed = [];
  diff.edits.forEach(function (edit) {
    try {
      crosslyRequest_(env, token, 'PATCH', '/v1/listings/' + encodeURIComponent(edit.id), {
        body: CrosslyCore.pricePayload(edit),
      });
      ok += 1;
    } catch (e) {
      failed.push('row ' + edit.row + ': ' + e.message);
    }
  });
  if (ok) crosslyPull_(env, 'listings');
  var message = diff.edits.length === 0 ? 'No price changes to push.' : 'Pushed ' + ok + ' of ' + diff.edits.length + ' price change(s).';
  if (failed.length) message += '\n\nFailed:\n' + failed.slice(0, 20).join('\n');
  return { changed: diff.edits.length, ok: ok, failed: failed, invalid: diff.invalid.length, message: message };
}

function crosslyRunPush_(fn) {
  var env = crosslyEnv_();
  try {
    var r = fn(env);
    var msg = r.message;
    if (r.invalid) msg += '\n\n' + r.invalid + ' row(s) had an invalid value and were left alone.';
    env.ui.alert('Crossly', msg, env.ui.ButtonSet.OK);
  } catch (e) {
    env.ui.alert('Crossly: ' + e.message);
  }
}

function crosslyPushStock() {
  crosslyRunPush_(crosslyPushStock_);
}
function crosslyPushPrices() {
  crosslyRunPush_(crosslyPushPrices_);
}
