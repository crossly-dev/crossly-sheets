/**
 * Crossly for Google Sheets — pure logic.
 *
 * Nothing in this file touches an Apps Script global (SpreadsheetApp,
 * UrlFetchApp, PropertiesService, Utilities…). Everything that needs I/O takes
 * it as a parameter, so the same file runs unchanged in Apps Script (where all
 * files share one global scope) and under `node --test`.
 *
 * Every endpoint, parameter and field name below comes from the public OpenAPI
 * spec at https://crossly.net/openapi/seller.json.
 */
/* exported CrosslyCore */
var CrosslyCore = (function () {
  'use strict';

  var BASE_URL = 'https://crossly.net/api';
  var TOKEN_PREFIX = 'crossly_pat_';
  var PAGE_LIMIT = 100; // the API's maximum; larger values are clamped server-side
  var MAX_PAGES = 1000; // safety stop: 100,000 rows
  var STOCK_CHUNK = 5000; // POST /v1/inventory/bulk-quantity accepts 1-5000 items per call
  var MAX_ATTEMPTS = 5;

  /**
   * One spec per data sheet. `columns` are response field names of the list
   * endpoint's items, in sheet order. `editable` is the one column whose edits
   * can be pushed back.
   */
  var SHEETS = {
    inventory: {
      title: 'Crossly Inventory',
      path: '/v1/inventory',
      operationId: 'listInventory',
      columns: [
        'id', 'sku', 'defaultTitle', 'brand', 'size', 'condition', 'status',
        'quantity', 'quantityAvailable', 'quantityReserved', 'quantitySold',
        'originalPrice', 'costBasisCents', 'warehouseLocation', 'updatedAt',
      ],
      editable: 'quantityAvailable',
    },
    listings: {
      title: 'Crossly Listings',
      path: '/v1/listings',
      operationId: 'listListings',
      columns: [
        'id', 'sku', 'title', 'price', 'currency', 'status', 'quantity',
        'quantityAvailable', 'brand', 'size', 'condition', 'updatedAt',
      ],
      editable: 'price',
    },
    orders: {
      title: 'Crossly Orders',
      path: '/v1/orders',
      operationId: 'listOrders',
      columns: [
        'id', 'platform', 'platformOrderId', 'status', 'channel', 'salePrice',
        'platformFee', 'sku', 'quantity', 'buyerUsername', 'trackingNumber',
        'carrier', 'shippedAt', 'deliveredAt', 'createdAt',
      ],
      editable: null,
    },
    sales: {
      title: 'Crossly Sales',
      path: '/v1/sales',
      operationId: 'listSales',
      columns: [
        'id', 'platform', 'platformOrderId', 'salePrice', 'platformFee',
        'shippingCost', 'costOfGoods', 'netProfit', 'currency', 'detectedBy',
        'detectedAt', 'orderId',
      ],
      editable: null,
    },
  };

  function isValidTokenShape(token) {
    return typeof token === 'string' && token.indexOf(TOKEN_PREFIX) === 0 && token.length > TOKEN_PREFIX.length + 8 && !/\s/.test(token);
  }

  function buildUrl(path, query) {
    var url = BASE_URL + path;
    var parts = [];
    if (query) {
      Object.keys(query).forEach(function (key) {
        var value = query[key];
        if (value === undefined || value === null || value === '') return;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      });
    }
    return parts.length ? url + '?' + parts.join('&') : url;
  }

  /** Case-insensitive header read (Apps Script and fetch differ in casing). */
  function header(headers, name) {
    if (!headers) return undefined;
    var wanted = name.toLowerCase();
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i].toLowerCase() === wanted) {
        var v = headers[keys[i]];
        return Array.isArray(v) ? v[0] : v;
      }
    }
    return undefined;
  }

  function safeJson(text) {
    if (text === undefined || text === null || text === '') return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /** `{ error: { code, message, details }, correlationId }` → a flat object. */
  function parseError(status, text) {
    var body = safeJson(text);
    var err = body && body.error && typeof body.error === 'object' ? body.error : {};
    return {
      status: status,
      code: err.code || 'http_' + status,
      message: err.message || 'Crossly answered HTTP ' + status + '.',
      details: err.details,
      correlationId: (body && body.correlationId) || undefined,
    };
  }

  function formatError(e) {
    var msg = e.message + ' (' + e.code + ', HTTP ' + e.status + ')';
    if (e.correlationId) msg += ' correlationId ' + e.correlationId;
    return msg;
  }

  /**
   * Whether to retry a response, and how long to wait first.
   * 429 → Retry-After seconds (default 5); 502/503/504 → exponential backoff.
   * A `retry_storm` 429 is not retried: the API says the request itself is wrong.
   */
  function retryDecision(status, headers, attempt, text) {
    if (attempt >= MAX_ATTEMPTS) return { retry: false, waitMs: 0 };
    if (status === 429) {
      var parsed = parseError(status, text);
      if (parsed.code === 'retry_storm') return { retry: false, waitMs: 0 };
      var ra = Number(header(headers, 'Retry-After'));
      var secs = Number.isFinite(ra) && ra >= 0 ? ra : 5;
      return { retry: true, waitMs: Math.min(secs, 120) * 1000 + 250 };
    }
    if (status === 502 || status === 503 || status === 504) {
      return { retry: true, waitMs: Math.min(1000 * Math.pow(2, attempt - 1), 30000) };
    }
    return { retry: false, waitMs: 0 };
  }

  /**
   * Proactive throttle: when the window is spent (`X-Quota-Remaining: 0`),
   * wait `X-Quota-Reset` seconds before the next call instead of earning a 429.
   */
  function throttleWaitMs(headers) {
    var remaining = Number(header(headers, 'X-Quota-Remaining'));
    if (!Number.isFinite(remaining) || remaining > 0) return 0;
    var reset = Number(header(headers, 'X-Quota-Reset'));
    return (Number.isFinite(reset) && reset > 0 ? Math.min(reset, 120) : 5) * 1000 + 250;
  }

  /** Items of a list response: `{ data: [...] }` (or `{ offers: [...] }`). */
  function listItems(body, listKey) {
    if (!body) return [];
    var key = listKey || 'data';
    return Array.isArray(body[key]) ? body[key] : [];
  }

  /**
   * Walk a page/limit list to the end. `fetchPage(page, limit)` returns the
   * parsed body. Stops when a page comes back shorter than `limit` (some list
   * endpoints omit `total`, so that is the only reliable end marker).
   */
  function paginate(fetchPage, options) {
    var opts = options || {};
    var limit = opts.limit || PAGE_LIMIT;
    var maxPages = opts.maxPages || MAX_PAGES;
    var out = [];
    for (var page = 1; page <= maxPages; page += 1) {
      var items = listItems(fetchPage(page, limit), opts.listKey);
      for (var i = 0; i < items.length; i += 1) out.push(items[i]);
      if (items.length < limit) return { items: out, truncated: false };
    }
    return { items: out, truncated: true };
  }

  /** A response value → a cell value. Objects/arrays become JSON text. */
  function toCell(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  function toRows(items, columns) {
    return items.map(function (item) {
      return columns.map(function (c) {
        return toCell(item[c]);
      });
    });
  }

  function indexOfHeader(headerRow, name) {
    for (var i = 0; i < headerRow.length; i += 1) {
      if (String(headerRow[i]).trim() === name) return i;
    }
    return -1;
  }

  function normalise(kind, value) {
    if (value === '' || value === null || value === undefined) return { ok: false, empty: true };
    var n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) return { ok: false };
    if (kind === 'quantity') {
      if (n < 0 || Math.floor(n) !== n) return { ok: false };
      return { ok: true, value: n };
    }
    if (n <= 0) return { ok: false };
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  /**
   * Compare the edited sheet with the snapshot taken at pull time.
   *
   * @param values    sheet values, row 0 = header
   * @param snapshot  { [id]: originalValue } for the editable column
   * @param column    editable column name
   * @param kind      'quantity' (integer ≥ 0) | 'price' (number > 0, cents)
   * @returns { edits: [{ id, row, value, previous }], invalid: [{ id, row, value }] }
   */
  function diffEdits(values, snapshot, column, kind) {
    var result = { edits: [], invalid: [] };
    if (!values || values.length < 2) return result;
    var idCol = indexOfHeader(values[0], 'id');
    var editCol = indexOfHeader(values[0], column);
    if (idCol === -1 || editCol === -1) {
      throw new Error('The sheet has no "id" or "' + column + '" header. Pull it again from the Crossly menu.');
    }
    var seen = {};
    for (var r = 1; r < values.length; r += 1) {
      var id = String(values[r][idCol] || '').trim();
      if (!id || seen[id] || !Object.prototype.hasOwnProperty.call(snapshot, id)) continue;
      seen[id] = true;
      var current = normalise(kind, values[r][editCol]);
      var before = normalise(kind, snapshot[id]);
      if (!current.ok) {
        if (!(current.empty && before.empty)) result.invalid.push({ id: id, row: r + 1, value: values[r][editCol] });
        continue;
      }
      if (before.ok && before.value === current.value) continue;
      result.edits.push({ id: id, row: r + 1, value: current.value, previous: before.ok ? before.value : null });
    }
    return result;
  }

  /** Snapshot of the editable column, keyed by id. */
  function snapshotOf(items, column) {
    var snap = {};
    items.forEach(function (item) {
      if (item && item.id) snap[item.id] = item[column] === undefined || item[column] === null ? '' : item[column];
    });
    return snap;
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /** Stock edits → POST /v1/inventory/bulk-quantity bodies (per-item "set" shape). */
  function stockPayloads(edits) {
    return chunk(edits, STOCK_CHUNK).map(function (part) {
      return {
        mode: 'set',
        items: part.map(function (e) {
          return { id: e.id, quantity: e.value };
        }),
      };
    });
  }

  /** A price edit → PATCH /v1/listings/{id} body. Omitting `platforms` pushes everywhere live. */
  function pricePayload(edit) {
    return { changes: { price: edit.value } };
  }

  return {
    BASE_URL: BASE_URL,
    PAGE_LIMIT: PAGE_LIMIT,
    STOCK_CHUNK: STOCK_CHUNK,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    SHEETS: SHEETS,
    isValidTokenShape: isValidTokenShape,
    buildUrl: buildUrl,
    header: header,
    safeJson: safeJson,
    parseError: parseError,
    formatError: formatError,
    retryDecision: retryDecision,
    throttleWaitMs: throttleWaitMs,
    listItems: listItems,
    paginate: paginate,
    toCell: toCell,
    toRows: toRows,
    indexOfHeader: indexOfHeader,
    normalise: normalise,
    diffEdits: diffEdits,
    snapshotOf: snapshotOf,
    chunk: chunk,
    stockPayloads: stockPayloads,
    pricePayload: pricePayload,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CrosslyCore;
