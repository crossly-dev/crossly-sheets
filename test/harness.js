'use strict';
/**
 * Runs src/*.js the way Apps Script does (one shared global scope) inside a
 * node:vm context whose SpreadsheetApp / UrlFetchApp / PropertiesService /
 * Utilities are in-memory fakes.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((r) => r.length !== this.cols)) {
      throw new Error('setValues: dimensions do not match the range');
    }
    values.forEach((r, i) =>
      r.forEach((v, j) => {
        const rr = this.row - 1 + i;
        while (this.sheet.cells.length <= rr) this.sheet.cells.push([]);
        // Sheets turns numeric-looking text into numbers, except in '@' (text) columns.
        const textCol = this.sheet.textCols.has(this.col + j);
        this.sheet.cells[rr][this.col - 1 + j] = !textCol && typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : v;
      }),
    );
    return this;
  }
  setNumberFormat(f) {
    if (f === '@') for (let c = this.col; c < this.col + this.cols; c += 1) this.sheet.textCols.add(c);
    return this;
  }
  setFontWeight() {
    return this;
  }
  setBackground() {
    return this;
  }
  setNote() {
    return this;
  }
  getValues() {
    const width = Math.max(0, ...this.sheet.cells.map((r) => r.length));
    return this.sheet.cells.map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined ? '' : r[i])));
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = [];
    this.textCols = new Set();
    this.hidden = false;
  }
  getRange(row, col, rows = 1, cols = 1) {
    return new FakeRange(this, row, col, rows, cols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, this.cells.length, 0);
  }
  clearContents() {
    this.cells = [];
    return this;
  }
  setFrozenRows() {}
  hideSheet() {
    this.hidden = true;
  }
}

function makeEnv({ routes = [], token } = {}) {
  const sheets = new Map();
  const props = new Map();
  if (token) props.set('CROSSLY_PAT', token);
  const calls = [];
  const sleeps = [];
  const alerts = [];
  const toasts = [];
  const prompts = [];
  const menu = [];

  const spreadsheet = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => {
      const s = new FakeSheet(n);
      sheets.set(n, s);
      return s;
    },
    toast: (m) => toasts.push(m),
  };
  const ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL' },
    alert: (...a) => alerts.push(a.length === 1 ? a[0] : a[1]),
    prompt: () => prompts.shift() || { getSelectedButton: () => 'CANCEL', getResponseText: () => '' },
    createAddonMenu: () => {
      const m = {
        addItem: (label, fn) => {
          menu.push([label, fn]);
          return m;
        },
        addSeparator: () => m,
        addToUi: () => undefined,
      };
      return m;
    },
  };

  /** routes: [{ method, match: RegExp|string, respond: (url, params, n) => ({ status, body, headers }) }] */
  const UrlFetchApp = {
    fetch(url, params) {
      calls.push({ url, method: params.method, headers: params.headers, body: params.payload ? JSON.parse(params.payload) : undefined });
      const route = routes.find((r) => r.method === params.method && (typeof r.match === 'string' ? url === r.match : r.match.test(url)));
      if (!route) throw new Error('unrouted ' + params.method + ' ' + url);
      route.n = (route.n || 0) + 1;
      const out = route.respond(url, params, route.n);
      const text = out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return {
        getResponseCode: () => out.status || 200,
        getAllHeaders: () => out.headers || {},
        getContentText: () => text,
      };
    },
  };

  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi: () => ui },
    UrlFetchApp,
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    Utilities: { sleep: (ms) => sleeps.push(ms) },
    console,
  });
  for (const f of ['core.js', 'main.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context, { filename: f });
  }
  return { context, sheets, props, calls, sleeps, alerts, toasts, prompts, menu };
}

/** Cross-realm safe copy for deepStrictEqual. */
const plain = (v) => JSON.parse(JSON.stringify(v));

module.exports = { makeEnv, plain };
