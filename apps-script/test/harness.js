'use strict';
/**
 * harness.js - loads apps-script/src/*.js into a node:vm context with faithful Apps Script mocks.
 * No dependencies. Intended to be reused by the Node-server contract test.
 *
 *   const { createSandbox } = require('./harness');
 *   const sb = createSandbox({ activeEmail, effectiveEmail, now, webAppUrl });
 *
 * createSandbox(opts) returns:
 *   ctx                 the vm context (all src/*.js globals, e.g. ctx.admin_getState)
 *   doPost(bodyText)    calls the real doPost with a fake event; returns the parsed envelope {body, sig}
 *                       (body is still a JSON string, exactly as on the wire)
 *   enterPairingCode(c) owner side of pairing: calls the real admin_submitPairingCode(c)
 *   addSpreadsheet({id?, name, sheets, alias?, access?})
 *                       creates an in-memory spreadsheet. sheets = {SheetName: [[...rows]]} or
 *                       {SheetName: {values, hidden, frozenRows, frozenColumns, maxRows, maxColumns}}.
 *                       access 'read'|'write' also puts it on the allowlist (ScriptProperties, like the
 *                       admin page would); omit access to leave it un-allowlisted. Returns {id,...}.
 *   sheetsFake          {spreadsheets: Map, opened: [ids passed to openById], get(id)}
 *   pairClient(code?)   full happy-path pairing; returns a client {instanceId, secret, account, call(...)}
 *   clock               {now, advance(ms)}   (Date.now() inside the sandbox follows it)
 *   session             {active, effective}  emails returned by Session (set active = '' for anonymous)
 *   props / cache       backing stores (props: Map, cache: Map) for white-box assertions
 *   logs                every console.* call made by the script (tests assert no secrets are logged)
 *
 * Also exported (pure Node, independent implementation of DESIGN.md section 4 for clients):
 *   hmacHex, newSecret, newNonce, buildPairRequest, buildCallRequest, parseBody, verifyEnvelope.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SRC_DIR = path.join(__dirname, '..', 'src');
// GSMCP_BUNDLE=1 runs the whole suite against the single-file build (apps-script/Code.gs) instead of src/.
const BUNDLE = process.env.GSMCP_BUNDLE === '1';
const BUNDLE_FILE = path.join(__dirname, '..', 'Code.gs');

// ---------------------------------------------------------------- client-side crypto (spec section 4)

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmacHex = (secret, message) =>
  crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
const newSecret = () => b64url(crypto.randomBytes(32));
const newNonce = () => b64url(crypto.randomBytes(16));

function buildPairRequest({ instanceId, instanceLabel = 'test', pairingCode, secret, ts }) {
  return JSON.stringify({ v: 1, kind: 'pair', instanceId, instanceLabel, pairingCode, secret, ts });
}

function buildCallRequest({ instanceId, secret, ts, nonce, action, params, payload, sig }) {
  const pl = payload !== undefined ? payload : JSON.stringify({ action, params: params === undefined ? {} : params });
  const s = sig !== undefined ? sig : hmacHex(secret, `v1\ncall\n${instanceId}\n${ts}\n${nonce}\n${pl}`);
  return JSON.stringify({ v: 1, kind: 'call', instanceId, ts, nonce, payload: pl, sig: s });
}

const parseBody = (envelope) => JSON.parse(envelope.body);

function verifyEnvelope(envelope, secret, nonce) {
  if (typeof envelope.sig !== 'string') return false;
  const expected = hmacHex(secret, `v1\nresp\n${nonce}\n${envelope.body}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(envelope.sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- byte helpers

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const fromBytes = (bytes) => Buffer.from(bytes.map((b) => b & 0xff));
const asBuffer = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : fromBytes(v));

// ---------------------------------------------------------------- in-memory Sheets

function parseFakeA1(a1, sheet) {
  const ref = a1.includes('!') ? a1.slice(a1.lastIndexOf('!') + 1) : a1;
  const col = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  let m;
  if ((m = /^([A-Za-z]+)(\d+)$/.exec(ref))) return [+m[2], col(m[1]), 1, 1];
  if ((m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(ref))) {
    return [+m[2], col(m[1]), +m[4] - +m[2] + 1, col(m[3]) - col(m[1]) + 1];
  }
  if ((m = /^([A-Za-z]+):([A-Za-z]+)$/.exec(ref))) return [1, col(m[1]), sheet.maxRows, col(m[2]) - col(m[1]) + 1];
  if ((m = /^(\d+):(\d+)$/.exec(ref))) return [+m[1], 1, +m[2] - +m[1] + 1, sheet.maxCols];
  throw new Error(`Unable to parse range: ${a1}`);
}

const EMPTY = Object.freeze({ v: '', f: null });
const isEmptyCell = (c) => c.v === '' && !c.f;

/** USER_ENTERED-like coercion performed by setValues. */
function coerce(input) {
  if (input === null || input === undefined || input === '') return { v: '', f: null };
  if (typeof input === 'string') {
    if (input.startsWith('=')) {
      const m = /^=\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
      let v = '#NAME?';
      if (m) v = { '+': +m[1] + +m[3], '-': +m[1] - +m[3], '*': +m[1] * +m[3], '/': +m[1] / +m[3] }[m[2]];
      return { v, f: input };
    }
    if (/^-?\d+(\.\d+)?$/.test(input)) return { v: Number(input), f: null };
    return { v: input, f: null };
  }
  return { v: input, f: null };
}

const display = (c) => (typeof c.v === 'boolean' ? (c.v ? 'TRUE' : 'FALSE') : String(c.v));

class FakeRange {
  constructor(sheet, row, col, nr, nc) {
    if (![row, col, nr, nc].every(Number.isInteger) || row < 1 || col < 1 || nr < 1 || nc < 1) {
      throw new Error('The coordinates or dimensions of the range are invalid.');
    }
    Object.assign(this, { sheet, row, col, nr, nc });
  }
  _check() {
    if (this.row + this.nr - 1 > this.sheet.maxRows || this.col + this.nc - 1 > this.sheet.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
  }
  _map(fn) {
    this._check();
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const r = [];
      for (let j = 0; j < this.nc; j++) r.push(fn(this.sheet._cell(this.row + i, this.col + j)));
      out.push(r);
    }
    return out;
  }
  getValues() { return this._map((c) => c.v); }
  getDisplayValues() { return this._map(display); }
  getFormulas() { return this._map((c) => c.f || ''); }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getSheet() { return this.sheet; }
  setValues(values) {
    this._check();
    if (!Array.isArray(values) || values.length !== this.nr) {
      throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values && values.length} but the range has ${this.nr}.`);
    }
    for (const r of values) {
      if (!Array.isArray(r) || r.length !== this.nc) {
        throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${r && r.length} but the range has ${this.nc}.`);
      }
    }
    values.forEach((r, i) => r.forEach((v, j) => {
      if (v !== null && v !== undefined && !['string', 'number', 'boolean'].includes(typeof v) && !(v instanceof Date)) {
        throw new Error('Cannot convert value to a cell value.');
      }
      this.sheet._set(this.row + i, this.col + j, coerce(v));
    }));
    this.sheet.ss.fake.writes++;
    return this;
  }
  clear(options) {
    this._check();
    void options; // contentsOnly: the fake has no formatting to keep
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._set(this.row + i, this.col + j, EMPTY);
    return this;
  }
  clearContent() { return this.clear({ contentsOnly: true }); }
}

class FakeSheet {
  constructor(ss, name, id, index, spec) {
    const values = Array.isArray(spec) ? spec : spec.values || [];
    const opts = Array.isArray(spec) ? {} : spec;
    this.ss = ss; this.name = name; this.id = id; this.index = index;
    this.data = [];
    this.hidden = !!opts.hidden;
    this.frozenRows = opts.frozenRows || 0;
    this.frozenCols = opts.frozenColumns || 0;
    const w = values.reduce((m, r) => Math.max(m, r.length), 0);
    this.maxRows = opts.maxRows || Math.max(1000, values.length);
    this.maxCols = opts.maxColumns || Math.max(26, w);
    values.forEach((r, i) => r.forEach((v, j) => this._set(i + 1, j + 1, coerce(v))));
  }
  _cell(r, c) { return (this.data[r - 1] && this.data[r - 1][c - 1]) || EMPTY; }
  _set(r, c, cell) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push(EMPTY);
    row[c - 1] = cell;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getIndex() { return this.index + 1; } // real API is 1-based
  isSheetHidden() { return this.hidden; }
  getFrozenRows() { return this.frozenRows; }
  getFrozenColumns() { return this.frozenCols; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) if (this.data[r - 1].some((c) => !isEmptyCell(c))) return r;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.data) for (let c = row.length; c > last; c--) if (!isEmptyCell(row[c - 1])) { last = c; break; }
    return last;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const [r, col, nr, nc] = parseFakeA1(a, this); return new FakeRange(this, r, col, nr, nc); }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  appendRow(arr) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.insertRowsAfter(this.maxRows, r - this.maxRows);
    if (arr.length > this.maxCols) this.insertColumnsAfter(this.maxCols, arr.length - this.maxCols);
    this.getRange(r, 1, 1, arr.length).setValues([arr]);
    return this;
  }
  insertRowsAfter(pos, n) {
    if (pos < 0 || pos > this.maxRows || n < 1) throw new Error('Invalid insertRowsAfter arguments');
    this.data.splice(pos, 0, ...Array.from({ length: n }, () => []));
    this.maxRows += n;
    return this;
  }
  insertColumnsAfter(pos, n) {
    if (pos < 0 || pos > this.maxCols || n < 1) throw new Error('Invalid insertColumnsAfter arguments');
    this.maxCols += n;
    return this;
  }
}

class FakeSpreadsheet {
  constructor(fake, id, name, sheetsSpec) {
    this.fake = fake; this.id = id; this.name = name;
    this.locale = 'en_US'; this.tz = 'Etc/UTC';
    this.sheets = Object.entries(sheetsSpec || { Sheet1: [] }).map(([n, spec], i) => new FakeSheet(this, n, i === 0 ? 0 : 1000 + i, i, spec));
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSpreadsheetLocale() { return this.locale; }
  getSpreadsheetTimeZone() { return this.tz; }
}

// ---------------------------------------------------------------- sandbox

function createSandbox(opts = {}) {
  const clock = { now: opts.now === undefined ? 1_700_000_000_000 : opts.now, advance(ms) { this.now += ms; } };
  const session = {
    active: opts.activeEmail === undefined ? 'owner@example.com' : opts.activeEmail,
    effective: opts.effectiveEmail === undefined ? 'owner@example.com' : opts.effectiveEmail
  };
  const logs = [];
  const props = new Map();
  const cache = new Map(); // key -> {value, expires}
  const sheetsFake = {
    spreadsheets: new Map(), opened: [], writes: 0,
    get(id) { return this.spreadsheets.get(id); }
  };

  const Utilities = {
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
    DigestAlgorithm: { MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256', SHA_384: 'SHA_384', SHA_512: 'SHA_512' },
    computeHmacSha256Signature(value, key /*, charset */) {
      if (value === undefined || key === undefined) throw new Error('Missing argument');
      return toSigned(crypto.createHmac('sha256', asBuffer(key)).update(asBuffer(value)).digest());
    },
    computeDigest(algorithm, value /*, charset */) {
      const algo = { MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' }[algorithm];
      if (!algo) throw new Error('Invalid digest algorithm');
      return toSigned(crypto.createHash(algo).update(asBuffer(value)).digest());
    },
    base64Encode(v) { return asBuffer(v).toString('base64'); },
    base64EncodeWebSafe(v) { return asBuffer(v).toString('base64url') + ''; },
    base64Decode(s) { return toSigned(Buffer.from(s, 'base64')); },
    base64DecodeWebSafe(s) { return toSigned(Buffer.from(s, 'base64url')); },
    getUuid() { return crypto.randomUUID(); },
    sleep() {}
  };

  const propsService = {
    getScriptProperties() {
      return {
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty(k, v) {
          if (String(v).length > 9 * 1024) throw new Error('Exception: The value is too large for property storage');
          props.set(k, String(v));
        },
        deleteProperty: (k) => { props.delete(k); },
        getProperties: () => Object.fromEntries(props),
        getKeys: () => [...props.keys()],
        deleteAllProperties: () => props.clear()
      };
    }
  };

  const cacheService = {
    getScriptCache() {
      const live = (k) => {
        const e = cache.get(k);
        if (!e) return null;
        if (e.expires <= clock.now) { cache.delete(k); return null; }
        return e;
      };
      return {
        get: (k) => { const e = live(k); return e ? e.value : null; },
        put(k, v, ttl = 600) {
          if (String(k).length > 250) throw new Error('Exception: Argument too large: key');
          if (String(v).length > 100 * 1024) throw new Error('Exception: Argument too large: value');
          if (ttl > 21600) ttl = 21600;
          cache.set(k, { value: String(v), expires: clock.now + ttl * 1000 });
        },
        remove: (k) => { cache.delete(k); }
      };
    }
  };

  let lockHeld = false;
  const lockService = {
    getScriptLock() {
      return {
        waitLock() {
          if (lockHeld) throw new Error('Exception: Lock timeout (nested waitLock would deadlock)');
          lockHeld = true;
        },
        tryLock() { if (lockHeld) return false; lockHeld = true; return true; },
        releaseLock() { lockHeld = false; },
        hasLock: () => lockHeld
      };
    }
  };

  const SessionMock = {
    getActiveUser: () => ({ getEmail: () => session.active }),
    getEffectiveUser: () => ({ getEmail: () => session.effective })
  };

  const ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput(text) {
      const out = { content: text === undefined ? '' : text, mime: 'TEXT' };
      out.setMimeType = (m) => { out.mime = m; return out; };
      out.getMimeType = () => out.mime;
      out.getContent = () => out.content;
      out.append = (t) => { out.content += t; return out; };
      out.setContent = (t) => { out.content = t; return out; };
      return out;
    }
  };

  const htmlOutput = (content) => {
    const o = { content, title: '', meta: {} };
    o.getContent = () => o.content;
    o.setTitle = (t) => { o.title = t; return o; };
    o.getTitle = () => o.title;
    o.addMetaTag = (k, v) => { o.meta[k] = v; return o; };
    o.setXFrameOptionsMode = () => o;
    return o;
  };
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createHtmlOutput: (html) => htmlOutput(html),
    createHtmlOutputFromFile: (name) => {
      if (BUNDLE) throw new Error('The single-file bundle must not read HTML files');
      return htmlOutput(fs.readFileSync(path.join(SRC_DIR, `${name}.html`), 'utf8'));
    }
  };

  const SpreadsheetApp = {
    openById(id) {
      sheetsFake.opened.push(id);
      const ss = sheetsFake.spreadsheets.get(id);
      if (!ss) throw new Error(`Exception: Unable to open spreadsheet with id ${id}`);
      return ss;
    },
    flush() {}
  };

  const record = (level) => (...a) => { logs.push({ level, args: a.map(String) }); };
  const consoleMock = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };

  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }

  const ctx = vm.createContext({
    Utilities, PropertiesService: propsService, CacheService: cacheService, LockService: lockService,
    Session: SessionMock, ContentService, HtmlService, SpreadsheetApp,
    ScriptApp: { getService: () => ({ getUrl: () => opts.webAppUrl || 'https://script.google.com/macros/s/AKfycbTEST/exec' }) },
    console: consoleMock, Logger: { log: record('log') }, Date: FakeDate
  });
  if (BUNDLE) {
    new vm.Script(fs.readFileSync(BUNDLE_FILE, 'utf8'), { filename: 'Code.gs' }).runInContext(ctx);
  } else {
    for (const f of fs.readdirSync(SRC_DIR).filter((n) => n.endsWith('.js')).sort()) {
      new vm.Script(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), { filename: f }).runInContext(ctx);
    }
  }

  const sb = {
    ctx, clock, session, logs, props, cache, sheetsFake,
    doPost(bodyText) {
      const out = ctx.doPost({ postData: { contents: bodyText, type: 'text/plain' } });
      return JSON.parse(out.getContent());
    },
    enterPairingCode(code) { return ctx.admin_submitPairingCode(code); },
    addSpreadsheet({ id, name = 'Test sheet', sheets, alias, access } = {}) {
      id = id || `1${crypto.randomBytes(20).toString('base64url')}`;
      sheetsFake.spreadsheets.set(id, new FakeSpreadsheet(sheetsFake, id, name, sheets));
      if (access) {
        const list = JSON.parse(props.get('gsmcp.spreadsheets') || '[]');
        list.push({ id, name, alias: alias || name, access });
        props.set('gsmcp.spreadsheets', JSON.stringify(list));
      }
      return { id, name, alias: alias || name, access: access || null };
    },
    /** Full happy-path pairing; returns a client that signs calls and verifies responses. */
    pairClient(code = 'ABCD-2345') {
      const instanceId = crypto.randomUUID();
      const secret = newSecret();
      sb.enterPairingCode(code);
      const ts = clock.now;
      const env = sb.doPost(buildPairRequest({ instanceId, pairingCode: code.replace('-', ''), secret, ts }));
      const body = parseBody(env);
      if (!body.ok) throw new Error(`pairing failed: ${body.error.code}`);
      const client = {
        instanceId, secret, account: body.result.account,
        /** Sends a signed call. overrides: {ts, nonce, payload, sig, instanceId}. */
        call(action, params, overrides = {}) {
          const nonce = overrides.nonce || newNonce();
          const req = buildCallRequest({
            instanceId: overrides.instanceId || instanceId, secret, ts: overrides.ts === undefined ? clock.now : overrides.ts,
            nonce, action, params, payload: overrides.payload, sig: overrides.sig
          });
          const envelope = sb.doPost(req);
          const parsed = parseBody(envelope);
          return { envelope, nonce, ...parsed, sigValid: verifyEnvelope(envelope, secret, nonce) };
        }
      };
      return client;
    }
  };
  return sb;
}

module.exports = { createSandbox, hmacHex, newSecret, newNonce, buildPairRequest, buildCallRequest, parseBody, verifyEnvelope };
