/**
 * apps-script-mcp - Google Apps Script (single-file build)
 * https://github.com/vannguyen799/apps-script-mcp  (MIT)
 *
 * Paste this whole file into Code.gs of a new Apps Script project, then Deploy > New deployment > Web app:
 *   Execute as: Me    Who has access: Anyone
 * Generated from apps-script/src by scripts/bundle.js - do not edit by hand.
 */

// ===== Setup.js =====
// One-paste setup block (DESIGN.md section 9.3). The MCP server replaces the next line, as a whole, with
// an object literal {"server":...,"token":...,"expiresAt":...}. Keep it on its own line and do not repeat it in any comment.
var ASMCP_SETUP_ = null;

// ===== Code.js =====
/**
 * Code.js - web app entry points and the owner-gated admin API.
 *
 * Public surface (callable from outside): doGet, doPost, and the admin_* functions used by
 * google.script.run. Every admin_* function calls assertOwner_() first. All other helpers end
 * with "_" so google.script.run cannot call them.
 */

var MAX_BODY_CHARS_ = 6 * 1024 * 1024;

function doPost(e) {
  var envelope;
  try {
    var text = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : null;
    if (text === null || text.length > MAX_BODY_CHARS_) {
      envelope = unsignedError_('BAD_REQUEST', 'Missing or oversized body');
    } else {
      envelope = processRequest_(text);
    }
  } catch (err) {
    envelope = unsignedError_('INTERNAL', 'Internal error');
  }
  return ContentService.createTextOutput(JSON.stringify(envelope)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    assertOwner_();
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8"><title>Truy cập bị từ chối</title>' +
      '<p style="font-family:sans-serif;margin:2rem">Truy cập bị từ chối. ' +
      'Hãy mở trang này khi đã đăng nhập bằng tài khoản Google sở hữu script.</p>');
  }
  return adminPage_()
    .setTitle('apps-script-mcp - Quản trị')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** The single-file bundle (Code.gs) inlines Admin.html as ADMIN_HTML_; the multi-file layout reads the file. */
function adminPage_() {
  return typeof ADMIN_HTML_ === 'string'
    ? HtmlService.createHtmlOutput(ADMIN_HTML_)
    : HtmlService.createHtmlOutputFromFile('Admin');
}

/** Owner gate (section 5.1): active user must be signed in and equal the effective (deploying) user. */
function assertOwner_() {
  var active = '';
  var effective = '';
  try {
    active = Session.getActiveUser().getEmail();
    effective = Session.getEffectiveUser().getEmail();
  } catch (e) {
    throw new Error('ACCESS_DENIED');
  }
  if (!active || !effective || String(active).toLowerCase() !== String(effective).toLowerCase()) {
    throw new Error('ACCESS_DENIED');
  }
}

// ---------- admin API (google.script.run) ----------

/** Everything the admin page renders. Never includes the secret or code hash. */
function admin_getState() {
  assertOwner_();
  var pairings = listPairings_();
  var pending = getPending_();
  var now = Date.now();
  return {
    account: Session.getEffectiveUser().getEmail(),
    webAppUrl: ScriptApp.getService().getUrl(),
    paired: pairings.length > 0,
    pairings: pairings,
    setup: setupState_(now),
    pendingExpiresAt: pending && pending.expiresAt > now ? pending.expiresAt : null,
    spreadsheets: getAllowlist_(),
    evalEnabled: isEvalEnabled_(),
    evalChangedAt: getEvalConfig_().changedAt
  };
}

/** Stores a pending pairing (section 4.2 step 2). */
function admin_submitPairingCode(code) {
  assertOwner_();
  var normalized = normalizePairingCode_(code === undefined || code === null ? '' : code);
  if (!isValidCode_(normalized)) {
    throw new Error('Mã ghép nối không hợp lệ: cần 8 ký tự (dạng XXXX-XXXX).');
  }
  var expiresAt = Date.now() + PAIR_TTL_MS_;
  withLock_(function () {
    setPending_({ codeHash: pairingCodeHash_(normalized), expiresAt: expiresAt, attempts: 0 });
  });
  return { ok: true, expiresAt: expiresAt };
}

/** Removes one paired server (by instanceId); other pairings keep working. Returns the remaining list. */
function admin_unpair(instanceId) {
  assertOwner_();
  if (typeof instanceId !== 'string' || !instanceId) throw new Error('Thiếu mã định danh của kết nối cần hủy.');
  return withLock_(function () {
    if (!removePairing_(instanceId)) throw new Error('Không tìm thấy kết nối này.');
    return { ok: true, pairings: listPairings_() };
  });
}

/** Adds a spreadsheet by URL or ID; validated by opening it. */
function admin_addSpreadsheet(input, alias, access) {
  assertOwner_();
  var id = extractSpreadsheetId_(input);
  var acc = normalizeAccess_(access);
  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('Không mở được bảng tính này. Kiểm tra lại URL/ID và quyền truy cập của tài khoản.');
  }
  var name = ss.getName();
  var finalAlias = normalizeAlias_(alias, name);
  return withLock_(function () {
    var list = getAllowlist_();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) throw new Error('Bảng tính này đã có trong danh sách.');
    }
    assertAliasFree_(list, finalAlias, null);
    list.push({ id: id, name: name, alias: finalAlias, access: acc });
    saveAllowlist_(list);
    return { ok: true, spreadsheets: list };
  });
}

function admin_updateSpreadsheet(id, alias, access) {
  assertOwner_();
  var acc = normalizeAccess_(access);
  return withLock_(function () {
    var list = getAllowlist_();
    var entry = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) entry = list[i];
    if (!entry) throw new Error('Không tìm thấy bảng tính.');
    var finalAlias = normalizeAlias_(alias, entry.name);
    assertAliasFree_(list, finalAlias, id);
    entry.alias = finalAlias;
    entry.access = acc;
    saveAllowlist_(list);
    return { ok: true, spreadsheets: list };
  });
}

function admin_removeSpreadsheet(id) {
  assertOwner_();
  return withLock_(function () {
    var list = getAllowlist_();
    var next = [];
    for (var i = 0; i < list.length; i++) if (list[i].id !== id) next.push(list[i]);
    if (next.length === list.length) throw new Error('Không tìm thấy bảng tính.');
    saveAllowlist_(next);
    return { ok: true, spreadsheets: next };
  });
}

/** Turns script evaluation (DESIGN.md section 8) on or off. Only the owner can; the MCP server cannot. */
function admin_setEvalEnabled(enabled) {
  assertOwner_();
  if (typeof enabled !== 'boolean') throw new Error('Giá trị bật/tắt phải là true hoặc false.');
  return withLock_(function () {
    var config = { enabled: enabled, changedAt: new Date(Date.now()).toISOString() };
    writeJson_(STORE_EVAL_KEY_, config);
    return { ok: true, evalEnabled: config.enabled, evalChangedAt: config.changedAt };
  });
}

/** The last 50 script.eval runs, newest first: {at, codeSha256, ok, durationMs, errorName?}. Never code. */
function admin_getEvalAudit() {
  assertOwner_();
  return getEvalAudit_().slice().reverse();
}

// ---------- admin helpers ----------

/**
 * Setup-block status for the admin page (section 9.3), never the token itself:
 * null (no block) | {status: 'ready'|'connected'|'burned'|'expired', server, expiresAt}.
 */
function setupState_(now) {
  var block = getSetupBlock_();
  if (!block) return null;
  var hash = setupTokenHash_(block.token);
  var status = 'ready';
  if (getSetupConsumed_().indexOf(hash) >= 0) {
    status = getSetupAttempts_(hash) >= PAIR_MAX_ATTEMPTS_ ? 'burned' : 'connected';
  } else if (typeof block.expiresAt !== 'number' || !(now < block.expiresAt)) {
    status = 'expired';
  }
  return {
    status: status,
    server: typeof block.server === 'string' ? block.server.slice(0, 200) : '',
    expiresAt: typeof block.expiresAt === 'number' ? block.expiresAt : null
  };
}

function extractSpreadsheetId_(input) {
  var s = typeof input === 'string' ? input.trim() : '';
  if (!s) throw new Error('Hãy nhập URL hoặc ID của bảng tính.');
  var m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,200}$/.test(s)) return s;
  throw new Error('URL hoặc ID bảng tính không hợp lệ.');
}

function normalizeAccess_(access) {
  if (access !== 'read' && access !== 'write') throw new Error('Quyền phải là "read" hoặc "write".');
  return access;
}

function normalizeAlias_(alias, fallbackName) {
  var a = typeof alias === 'string' ? alias.trim() : '';
  if (!a) a = String(fallbackName || '').trim();
  if (!a) throw new Error('Alias không được để trống.');
  if (a.length > 64) throw new Error('Alias tối đa 64 ký tự.');
  return a;
}

function assertAliasFree_(list, alias, exceptId) {
  var lower = alias.toLowerCase();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id !== exceptId && list[i].alias.toLowerCase() === lower) {
      throw new Error('Alias "' + alias + '" đã được dùng cho bảng tính khác.');
    }
  }
}

// ===== Auth.js =====
/**
 * Auth.js - HMAC primitives, pairing, call verification, replay cache, response signing.
 * Wire protocol: docs/DESIGN.md section 4. Nothing here logs secrets, codes or cell values.
 */

var AUTH_MAX_PAYLOAD_CHARS_ = 5 * 1024 * 1024;
var AUTH_MAX_SKEW_MS_ = 300000;
var AUTH_NONCE_TTL_S_ = 600;
var PAIR_MAX_ATTEMPTS_ = 5;
var PAIR_TTL_MS_ = 10 * 60 * 1000;
var PAIR_ALPHABET_RE_ = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/** Throws a coded error understood by the request handler. */
function fail_(code, message) {
  var e = new Error(message);
  e.asmcpCode = code;
  throw e;
}

function isPlainObject_(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Signed Java bytes -> lowercase hex. */
function bytesToHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

/** HMAC-SHA256 hex; the key is the UTF-8 bytes of the secret string. */
function hmacHex_(secret, message) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8));
}

function sha256Hex_(text) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

/** Constant-time string equality (no early exit on length or content). */
function constantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Uppercase and drop every char outside [A-Z0-9]. */
function normalizePairingCode_(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pairingCodeHash_(normalizedCode) {
  return sha256Hex_('asmcp-pair-v1:' + normalizedCode);
}

function isValidCode_(normalized) {
  return PAIR_ALPHABET_RE_.test(normalized);
}

/** {body, sig:null} error envelope (used before the caller is authenticated). */
function unsignedError_(code, message) {
  return { body: JSON.stringify({ ok: false, error: { code: code, message: message } }), sig: null };
}

/** Signed envelope: sig = HMAC(secret, "v1\nresp\n" + nonce + "\n" + body). */
function signedEnvelope_(secret, nonce, bodyObj) {
  var body = JSON.stringify(bodyObj);
  return { body: body, sig: hmacHex_(secret, 'v1\nresp\n' + nonce + '\n' + body) };
}

function isIntegerNumber_(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
}

/** Entry point used by doPost: text -> envelope object. Never throws. */
function processRequest_(text) {
  try {
    var req;
    try {
      req = JSON.parse(text);
    } catch (e) {
      return unsignedError_('BAD_REQUEST', 'Body is not valid JSON');
    }
    if (!isPlainObject_(req) || req.v !== 1) return unsignedError_('BAD_REQUEST', 'Unsupported request');
    if (req.kind === 'pair') return handlePair_(req);
    if (req.kind === 'call') return handleCall_(req);
    return unsignedError_('BAD_REQUEST', 'Unknown request kind');
  } catch (err) {
    if (err && err.asmcpCode) return unsignedError_(err.asmcpCode, err.message);
    return unsignedError_('INTERNAL', 'Internal error');
  }
}

var ID_RE_ = /^[A-Za-z0-9_-]{1,64}$/;
var SECRET_RE_ = /^[A-Za-z0-9_-]{43}$/;
var NONCE_RE_ = /^[A-Za-z0-9_-]{16,64}$/;

/** ScriptApp.getScriptId(), or null if unavailable. */
function getScriptId_() {
  try {
    var id = ScriptApp.getScriptId();
    return typeof id === 'string' && id ? id : null;
  } catch (e) {
    return null;
  }
}

/**
 * Success body shared by code pairing and setup pairing (section 4.2 step 4): {account, scriptId, scriptName, proof}.
 * scriptName is always null: Apps Script has no scope-free way to read the project name (that needs Drive).
 */
function pairAck_(secret, instanceId, ts) {
  var proof = hmacHex_(secret, 'v1\npair-ack\n' + instanceId + '\n' + ts);
  var account = Session.getEffectiveUser().getEmail();
  return {
    body: JSON.stringify({ ok: true, result: { account: account, scriptId: getScriptId_(), scriptName: null, proof: proof } }),
    sig: null
  };
}

/** Pairing (section 4.2 steps 3-4; setup mode: section 9.3). */
function handlePair_(req) {
  var setup = req.mode === 'setup';
  if (req.mode !== undefined && !setup) return unsignedError_('BAD_REQUEST', 'Malformed pairing request');
  if (typeof req.instanceId !== 'string' || !ID_RE_.test(req.instanceId) ||
      typeof req.instanceLabel !== 'string' || req.instanceLabel.length > 64 ||
      typeof req.secret !== 'string' || !SECRET_RE_.test(req.secret) ||
      !isIntegerNumber_(req.ts) ||
      (setup ? (typeof req.setupProof !== 'string' || req.setupProof.length !== 64)
             : (typeof req.pairingCode !== 'string' || req.pairingCode.length > 64))) {
    return unsignedError_('BAD_REQUEST', 'Malformed pairing request');
  }
  if (setup) return handleSetupPair_(req);
  var code = normalizePairingCode_(req.pairingCode);
  var hash = pairingCodeHash_(code);
  return withLock_(function () {
    var now = Date.now();
    var pending = getPending_();
    if (!pending || !(pending.expiresAt > now)) {
      if (pending) clearPending_();
      return unsignedError_('PAIRING_NOT_READY', 'No pairing code is waiting');
    }
    if (!constantTimeEqual_(hash, pending.codeHash)) {
      var attempts = (typeof pending.attempts === 'number' ? pending.attempts : 0) + 1;
      if (attempts >= PAIR_MAX_ATTEMPTS_) {
        clearPending_();
      } else {
        pending.attempts = attempts;
        setPending_(pending);
      }
      return unsignedError_('PAIRING_INVALID', 'Pairing code is invalid');
    }
    // Adds to the map; the same instanceId replaces its own entry. LIMIT_EXCEEDED keeps the code pending.
    addPairing_({
      instanceId: req.instanceId,
      instanceLabel: req.instanceLabel,
      secret: req.secret,
      pairedAt: new Date(now).toISOString()
    });
    clearPending_();
    return pairAck_(req.secret, req.instanceId, req.ts);
  });
}

/** The installed setup block when it is a well-formed object with a 43-char token, else null. */
function getSetupBlock_() {
  var s = typeof ASMCP_SETUP_ === 'undefined' ? null : ASMCP_SETUP_;
  if (!isPlainObject_(s) || typeof s.token !== 'string' || !SECRET_RE_.test(s.token)) return null;
  return s;
}

function setupTokenHash_(token) {
  return sha256Hex_('asmcp-setup-v1:' + token);
}

/**
 * Setup pair (section 9.3): proof = HMAC(token, "v1\nsetup\n" + instanceId + "\n" + ts + "\n" + secret).
 * Errors: PAIRING_NOT_READY (no block / expired), PAIRING_INVALID (bad proof / consumed; the 5th bad proof burns
 * the token), REQUEST_EXPIRED (ts outside the skew window; not counted), LIMIT_EXCEEDED (20 pairings; token kept).
 */
function handleSetupPair_(req) {
  return withLock_(function () {
    var now = Date.now();
    var block = getSetupBlock_();
    if (!block || typeof block.expiresAt !== 'number' || !(now < block.expiresAt)) {
      return unsignedError_('PAIRING_NOT_READY', 'No setup is waiting');
    }
    var hash = setupTokenHash_(block.token);
    if (getSetupConsumed_().indexOf(hash) >= 0) {
      return unsignedError_('PAIRING_INVALID', 'Setup token is invalid');
    }
    if (Math.abs(now - req.ts) > AUTH_MAX_SKEW_MS_) {
      return unsignedError_('REQUEST_EXPIRED', 'Request timestamp is outside the allowed window');
    }
    var expected = hmacHex_(block.token, 'v1\nsetup\n' + req.instanceId + '\n' + req.ts + '\n' + req.secret);
    if (!constantTimeEqual_(expected, req.setupProof)) {
      var n = getSetupAttempts_(hash) + 1;
      setSetupAttempts_(hash, n);
      if (n >= PAIR_MAX_ATTEMPTS_) addSetupConsumed_(hash); // burned
      return unsignedError_('PAIRING_INVALID', 'Setup token is invalid');
    }
    addPairing_({
      instanceId: req.instanceId,
      instanceLabel: req.instanceLabel,
      secret: req.secret,
      pairedAt: new Date(now).toISOString()
    });
    addSetupConsumed_(hash);
    clearSetupAttempts_();
    return pairAck_(req.secret, req.instanceId, req.ts);
  });
}

/** Authenticated call (section 4.3, in the mandated order). */
function handleCall_(req) {
  // 1. shape
  if (typeof req.instanceId !== 'string' || !ID_RE_.test(req.instanceId) ||
      !isIntegerNumber_(req.ts) ||
      typeof req.nonce !== 'string' || !NONCE_RE_.test(req.nonce) ||
      typeof req.payload !== 'string' || req.payload.length > AUTH_MAX_PAYLOAD_CHARS_ ||
      typeof req.sig !== 'string' || req.sig.length !== 64) {
    return unsignedError_('BAD_REQUEST', 'Malformed request');
  }
  // 2. pairing exists and instanceId matches
  var pairing = getPairing_(req.instanceId);
  if (!pairing) {
    return unsignedError_('UNAUTHENTICATED', 'Authentication failed');
  }
  // 3. freshness
  if (Math.abs(Date.now() - req.ts) > AUTH_MAX_SKEW_MS_) {
    return unsignedError_('REQUEST_EXPIRED', 'Request timestamp is outside the allowed window');
  }
  // 4. signature
  var expected = hmacHex_(pairing.secret,
    'v1\ncall\n' + req.instanceId + '\n' + req.ts + '\n' + req.nonce + '\n' + req.payload);
  if (!constantTimeEqual_(expected, req.sig)) {
    return unsignedError_('UNAUTHENTICATED', 'Authentication failed');
  }
  var secret = pairing.secret;
  var nonce = req.nonce;
  var reply = function (obj) { return signedEnvelope_(secret, nonce, obj); };
  var replyError = function (code, message, logs) {
    var error = { code: code, message: message };
    if (logs) error.logs = logs; // only script.eval errors carry logs
    return reply({ ok: false, error: error });
  };
  try {
    // 5. replay
    var replayed = withLock_(function () {
      var cache = CacheService.getScriptCache();
      var key = 'n:' + nonce;
      if (cache.get(key) !== null) return true;
      cache.put(key, '1', AUTH_NONCE_TTL_S_);
      return false;
    });
    if (replayed) return replyError('REPLAYED', 'Nonce already used');
    // 6. payload + whitelist
    var payload;
    try {
      payload = JSON.parse(req.payload);
    } catch (e) {
      return replyError('BAD_REQUEST', 'Payload is not valid JSON');
    }
    if (!isPlainObject_(payload) || typeof payload.action !== 'string') {
      return replyError('BAD_REQUEST', 'Payload must contain an action');
    }
    if (!isAction_(payload.action)) return replyError('UNKNOWN_ACTION', 'Unknown action');
    var params = payload.params === undefined ? {} : payload.params;
    if (!isPlainObject_(params)) return replyError('BAD_REQUEST', 'params must be an object');
    var result = runAction_(payload.action, params);
    return reply({ ok: true, result: result });
  } catch (err) {
    if (err && err.asmcpCode) return replyError(err.asmcpCode, err.message, err.asmcpLogs);
    // No stack, no cell data: a fixed message only.
    return replyError('INTERNAL', 'Internal error');
  }
}

// ===== Actions.js =====
/**
 * Actions.js - the fixed action whitelist and the Sheets operations (DESIGN.md section 4.5).
 * Every action re-validates its input; the allowlist is enforced before SpreadsheetApp.openById.
 * Error messages never contain cell data.
 */

var SCRIPT_VERSION_ = '1.0.0';
var LIMITS_ = {
  READ_CELLS: 100000,
  WRITE_CELLS: 20000,
  BATCH_CELLS: 50000,
  BATCH_OPS: 50,
  SEARCH: 500,
  SEARCH_DEFAULT: 100,
  CELL_CHARS: 50000
};

var ACTIONS_ = {
  'ping': { write: false, run: actionPing_ },
  'spreadsheets.list': { write: false, run: actionSpreadsheetsList_ },
  'spreadsheet.metadata': { write: false, run: actionMetadata_ },
  'range.read': { write: false, run: actionRangeRead_ },
  'range.write': { write: true, run: actionRangeWrite_ },
  'rows.append': { write: true, run: actionRowsAppend_ },
  'search': { write: false, run: actionSearch_ },
  'batch.update': { write: true, run: actionBatchUpdate_ },
  // Lazy: with the multi-file layout Eval.js is loaded after this file. Opt-in and owner-gated (DESIGN.md section 8).
  'script.eval': { write: true, run: function (params) { return actionEval_(params); } }
};

function isAction_(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS_, name);
}

function runAction_(name, params) {
  return ACTIONS_[name].run(params);
}

// ---------- shared helpers ----------

/** Allowlist check (before opening the file) + write gate. Returns the allowlist entry. */
function authorize_(params, needWrite) {
  var id = params.spreadsheetId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
    fail_('BAD_REQUEST', 'spreadsheetId is required');
  }
  var entry = findAllowed_(id);
  if (!entry) fail_('SPREADSHEET_NOT_AUTHORIZED', 'Spreadsheet is not in the allowlist');
  if (needWrite && entry.access !== 'write') {
    fail_('WRITE_NOT_ALLOWED', 'Spreadsheet is read-only in the allowlist');
  }
  return entry;
}

function openAuthorized_(entry) {
  return SpreadsheetApp.openById(entry.id);
}

function getSheet_(ss, name) {
  if (typeof name !== 'string' || name.length === 0) fail_('BAD_REQUEST', 'Sheet name is required');
  var sheet = ss.getSheetByName(name);
  if (!sheet) fail_('SHEET_NOT_FOUND', 'Sheet not found: ' + name);
  return sheet;
}

function parseAllowFormulas_(params) {
  if (params.allowFormulas === undefined) return false;
  if (typeof params.allowFormulas !== 'boolean') fail_('BAD_REQUEST', 'allowFormulas must be a boolean');
  return params.allowFormulas;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/** Validates a values matrix. Returns {rows, cols}. */
function validateMatrix_(values, allowFormulas, maxCells) {
  if (!Array.isArray(values) || values.length === 0) {
    fail_('INVALID_VALUE', 'values must be a non-empty 2D array');
  }
  var width = -1;
  var i;
  var j;
  for (i = 0; i < values.length; i++) {
    var row = values[i];
    if (!Array.isArray(row) || row.length === 0) fail_('INVALID_VALUE', 'Every row must be a non-empty array');
    if (width === -1) width = row.length;
    else if (row.length !== width) fail_('INVALID_VALUE', 'Rows must all have the same length (no ragged rows)');
  }
  if (values.length * width > maxCells) {
    fail_('LIMIT_EXCEEDED', 'Too many cells (max ' + maxCells + ' per operation)');
  }
  for (i = 0; i < values.length; i++) {
    for (j = 0; j < width; j++) {
      var v = values[i][j];
      if (v === null) continue;
      if (typeof v === 'string') {
        if (v.length > LIMITS_.CELL_CHARS) fail_('LIMIT_EXCEEDED', 'A string exceeds ' + LIMITS_.CELL_CHARS + ' characters');
        if (!allowFormulas && looksLikeFormula_(v)) {
          fail_('FORMULA_NOT_ALLOWED', 'Formulas are not allowed unless allowFormulas is true');
        }
      } else if (typeof v === 'number') {
        if (!isFinite(v)) fail_('INVALID_VALUE', 'Numbers must be finite');
      } else if (typeof v !== 'boolean') {
        fail_('INVALID_VALUE', 'Cell values must be string, number, boolean or null');
      }
    }
  }
  return { rows: values.length, cols: width };
}

// Sheets may parse a leading '=', or a non-numeric leading '+', '-', '@', as a formula.
function looksLikeFormula_(s) {
  var c = s.charAt(0);
  if (c === '=') return true;
  if (c === '+' || c === '-' || c === '@') return isNaN(Number(s.trim()));
  return false;
}

/** null -> '' (empty cell). Returns a fresh matrix. */
function toSheetValues_(values) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = [];
    for (var j = 0; j < values[i].length; j++) row.push(values[i][j] === null ? '' : values[i][j]);
    out.push(row);
  }
  return out;
}

/** Grows the sheet grid when a write lands outside it. */
function ensureGrid_(sheet, lastRow, lastCol) {
  var mr = sheet.getMaxRows();
  if (lastRow > mr) sheet.insertRowsAfter(mr, lastRow - mr);
  var mc = sheet.getMaxColumns();
  if (lastCol > mc) sheet.insertColumnsAfter(mc, lastCol - mc);
}

/**
 * Concrete bounds of a parsed range within a sheet.
 * clipToData: unbounded dimensions stop at the data extent (reads); otherwise at the grid (clear).
 * Explicit dimensions are clipped to the grid. Returns {r1,c1,r2,c2,empty}.
 */
function resolveBounds_(sheet, ref, clipToData) {
  var maxR = sheet.getMaxRows();
  var maxC = sheet.getMaxColumns();
  var dataR = clipToData ? sheet.getLastRow() : maxR;
  var dataC = clipToData ? sheet.getLastColumn() : maxC;
  var r1 = ref.r1;
  var c1 = ref.c1;
  var r2 = ref.r2 === null ? dataR : Math.min(ref.r2, maxR);
  var c2 = ref.c2 === null ? dataC : Math.min(ref.c2, maxC);
  return { r1: r1, c1: c1, r2: r2, c2: c2, empty: r1 > r2 || c1 > c2 };
}

function cellValueOut_(v) {
  return isDate_(v) ? v.toISOString() : v;
}

// ---------- read-only actions ----------

function actionPing_() {
  return {
    account: Session.getEffectiveUser().getEmail(),
    scriptId: getScriptId_(),
    scriptVersion: SCRIPT_VERSION_,
    spreadsheetCount: getAllowlist_().length,
    evalEnabled: isEvalEnabled_()
  };
}

function actionSpreadsheetsList_() {
  var list = getAllowlist_();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var name = e.name;
    var url = 'https://docs.google.com/spreadsheets/d/' + e.id + '/edit';
    try {
      var ss = SpreadsheetApp.openById(e.id);
      name = ss.getName();
      url = ss.getUrl();
    } catch (err) {
      // file deleted / unshared: fall back to stored values
    }
    out.push({ id: e.id, name: name, alias: e.alias, access: e.access, url: url });
  }
  return { spreadsheets: out };
}

function actionMetadata_(p) {
  var entry = authorize_(p, false);
  var ss = openAuthorized_(entry);
  var sheets = ss.getSheets();
  var out = [];
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    out.push({
      sheetId: s.getSheetId(),
      name: s.getName(),
      index: s.getIndex() - 1, // Apps Script is 1-based; exposed 0-based like the Sheets REST API
      rowCount: s.getMaxRows(),
      columnCount: s.getMaxColumns(),
      lastRow: s.getLastRow(),
      lastColumn: s.getLastColumn(),
      frozenRows: s.getFrozenRows(),
      frozenColumns: s.getFrozenColumns(),
      hidden: s.isSheetHidden()
    });
  }
  return {
    id: ss.getId(),
    name: ss.getName(),
    url: ss.getUrl(),
    locale: ss.getSpreadsheetLocale(),
    timeZone: ss.getSpreadsheetTimeZone(),
    sheets: out
  };
}

function actionRangeRead_(p) {
  var entry = authorize_(p, false);
  var render = p.render === undefined ? 'FORMATTED' : p.render;
  if (render !== 'FORMATTED' && render !== 'UNFORMATTED' && render !== 'FORMULA') {
    fail_('BAD_REQUEST', 'render must be FORMATTED, UNFORMATTED or FORMULA');
  }
  var ref = parseA1_(p.range);
  var ss = openAuthorized_(entry);
  var sheet = getSheet_(ss, ref.sheet);
  var b = resolveBounds_(sheet, ref, true);
  if (b.empty) {
    return { range: ref.kind === 'cols' || ref.kind === 'rows' ? p.range : formatA1_(ref.sheet, ref.r1, ref.c1, ref.r1, ref.c1), values: [] };
  }
  var nr = b.r2 - b.r1 + 1;
  var nc = b.c2 - b.c1 + 1;
  if (nr * nc > LIMITS_.READ_CELLS) {
    fail_('LIMIT_EXCEEDED', 'Range covers more than ' + LIMITS_.READ_CELLS + ' cells');
  }
  var range = sheet.getRange(b.r1, b.c1, nr, nc);
  var values;
  if (render === 'FORMATTED') {
    values = range.getDisplayValues();
  } else if (render === 'UNFORMATTED') {
    values = range.getValues();
  } else {
    var formulas = range.getFormulas();
    var raw = range.getValues();
    values = [];
    for (var i = 0; i < nr; i++) {
      var row = [];
      for (var j = 0; j < nc; j++) row.push(formulas[i][j] !== '' ? formulas[i][j] : raw[i][j]);
      values.push(row);
    }
  }
  var out = [];
  for (var a = 0; a < values.length; a++) {
    var r = [];
    for (var c = 0; c < values[a].length; c++) r.push(cellValueOut_(values[a][c]));
    out.push(r);
  }
  return { range: formatA1_(ref.sheet, b.r1, b.c1, b.r2, b.c2), values: out };
}

function actionSearch_(p) {
  var entry = authorize_(p, false);
  if (typeof p.query !== 'string' || p.query.length === 0 || p.query.length > LIMITS_.CELL_CHARS) {
    fail_('BAD_REQUEST', 'query must be a non-empty string');
  }
  var flags = ['matchCase', 'matchEntireCell'];
  for (var f = 0; f < flags.length; f++) {
    if (p[flags[f]] !== undefined && typeof p[flags[f]] !== 'boolean') fail_('BAD_REQUEST', flags[f] + ' must be a boolean');
  }
  var limit = LIMITS_.SEARCH_DEFAULT;
  if (p.limit !== undefined) {
    if (!isIntegerNumber_(p.limit) || p.limit < 1) fail_('BAD_REQUEST', 'limit must be a positive integer');
    if (p.limit > LIMITS_.SEARCH) fail_('LIMIT_EXCEEDED', 'limit must be <= ' + LIMITS_.SEARCH);
    limit = p.limit;
  }
  if (p.sheet !== undefined && typeof p.sheet !== 'string') fail_('BAD_REQUEST', 'sheet must be a string');
  var ss = openAuthorized_(entry);
  var sheets = p.sheet !== undefined ? [getSheet_(ss, p.sheet)] : ss.getSheets();
  var matchCase = p.matchCase === true;
  var entire = p.matchEntireCell === true;
  var needle = matchCase ? p.query : p.query.toLowerCase();
  var matches = [];
  var truncated = false;
  outer:
  for (var s = 0; s < sheets.length; s++) {
    var name = sheets[s].getName();
    var vals = sheets[s].getDataRange().getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      for (var c = 0; c < vals[r].length; c++) {
        var cell = String(vals[r][c]);
        if (cell === '') continue;
        var hay = matchCase ? cell : cell.toLowerCase();
        var hit = entire ? hay === needle : hay.indexOf(needle) >= 0;
        if (!hit) continue;
        if (matches.length >= limit) {
          truncated = true;
          break outer;
        }
        matches.push({ sheet: name, range: formatA1_(name, r + 1, c + 1, r + 1, c + 1), row: r + 1, column: c + 1, value: cell });
      }
    }
  }
  return { matches: matches, truncated: truncated };
}

// ---------- write planning (validation only, no mutation) ----------

function planWrite_(ss, op, allowFormulas) {
  var ref = parseA1_(op.range);
  if (ref.kind === 'cols' || ref.kind === 'rows') {
    fail_('INVALID_RANGE', 'Writes need a cell (A1) or a bounded range (A1:B2)');
  }
  var m = validateMatrix_(op.values, allowFormulas, LIMITS_.WRITE_CELLS);
  var sheet = getSheet_(ss, ref.sheet);
  var r2 = ref.r2;
  var c2 = ref.c2;
  if (ref.kind === 'cell') {
    r2 = ref.r1 + m.rows - 1;
    c2 = ref.c1 + m.cols - 1;
    if (r2 > A1_MAX_ROW_ || c2 > A1_MAX_COL_) fail_('INVALID_RANGE', 'Values do not fit inside the sheet limits');
  } else if (ref.r2 - ref.r1 + 1 !== m.rows || ref.c2 - ref.c1 + 1 !== m.cols) {
    fail_('RANGE_SIZE_MISMATCH', 'Range is ' + (ref.r2 - ref.r1 + 1) + 'x' + (ref.c2 - ref.c1 + 1) +
      ' but values are ' + m.rows + 'x' + m.cols);
  }
  return { type: 'write', sheet: sheet, sheetName: ref.sheet, r1: ref.r1, c1: ref.c1, r2: r2, c2: c2, values: op.values, cells: m.rows * m.cols };
}

function planAppend_(ss, op, allowFormulas) {
  var sheet = getSheet_(ss, op.sheet);
  var m = validateMatrix_(op.rows, allowFormulas, LIMITS_.WRITE_CELLS);
  return { type: 'append', sheet: sheet, sheetName: op.sheet, values: op.rows, rows: m.rows, cols: m.cols, cells: m.rows * m.cols };
}

function planClear_(ss, op) {
  var ref = parseA1_(op.range);
  var sheet = getSheet_(ss, ref.sheet);
  return { type: 'clear', sheet: sheet, sheetName: ref.sheet, ref: ref, cells: 0 };
}

// ---------- write execution ----------

function execWrite_(plan) {
  ensureGrid_(plan.sheet, plan.r2, plan.c2);
  var nr = plan.r2 - plan.r1 + 1;
  var nc = plan.c2 - plan.c1 + 1;
  plan.sheet.getRange(plan.r1, plan.c1, nr, nc).setValues(toSheetValues_(plan.values));
  return {
    updatedRange: formatA1_(plan.sheetName, plan.r1, plan.c1, plan.r2, plan.c2),
    updatedRows: nr,
    updatedColumns: nc,
    updatedCells: nr * nc
  };
}

function execAppend_(plan) {
  var start = plan.sheet.getLastRow() + 1;
  var end = start + plan.rows - 1;
  ensureGrid_(plan.sheet, end, plan.cols);
  plan.sheet.getRange(start, 1, plan.rows, plan.cols).setValues(toSheetValues_(plan.values));
  return { updatedRange: formatA1_(plan.sheetName, start, 1, end, plan.cols), appendedRows: plan.rows };
}

function execClear_(plan) {
  var b = resolveBounds_(plan.sheet, plan.ref, false);
  if (!b.empty) {
    plan.sheet.getRange(b.r1, b.c1, b.r2 - b.r1 + 1, b.c2 - b.c1 + 1).clear({ contentsOnly: true });
  }
  var label = (plan.ref.kind === 'cols' || plan.ref.kind === 'rows' || b.empty)
    ? quoteSheet_(plan.sheetName) + '!' + rawRefText_(plan.ref)
    : formatA1_(plan.sheetName, b.r1, b.c1, b.r2, b.c2);
  return { clearedRange: label };
}

function rawRefText_(ref) {
  if (ref.kind === 'cols') return numToCol_(ref.c1) + ':' + numToCol_(ref.c2);
  if (ref.kind === 'rows') return ref.r1 + ':' + ref.r2;
  return numToCol_(ref.c1) + ref.r1 + (ref.kind === 'range' ? ':' + numToCol_(ref.c2) + ref.r2 : '');
}

function execPlan_(plan) {
  if (plan.type === 'write') return execWrite_(plan);
  if (plan.type === 'append') return execAppend_(plan);
  return execClear_(plan);
}

// ---------- write actions ----------

function actionRangeWrite_(p) {
  var entry = authorize_(p, true);
  var allowFormulas = parseAllowFormulas_(p);
  var ss = openAuthorized_(entry);
  var plan = planWrite_(ss, { range: p.range, values: p.values }, allowFormulas);
  return withLock_(function () { return execWrite_(plan); });
}

function actionRowsAppend_(p) {
  var entry = authorize_(p, true);
  var allowFormulas = parseAllowFormulas_(p);
  var ss = openAuthorized_(entry);
  var plan = planAppend_(ss, { sheet: p.sheet, rows: p.rows }, allowFormulas);
  return withLock_(function () { return execAppend_(plan); });
}

function actionBatchUpdate_(p) {
  var entry = authorize_(p, true);
  var allowFormulas = parseAllowFormulas_(p);
  var ops = p.operations;
  if (!Array.isArray(ops) || ops.length === 0) fail_('BAD_REQUEST', 'operations must be a non-empty array');
  if (ops.length > LIMITS_.BATCH_OPS) fail_('LIMIT_EXCEEDED', 'At most ' + LIMITS_.BATCH_OPS + ' operations per batch');
  var ss = openAuthorized_(entry);
  // Phase 1: validate everything, mutate nothing.
  var plans = [];
  var total = 0;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (!isPlainObject_(op) || typeof op.type !== 'string') fail_('BAD_REQUEST', 'Operation ' + i + ' is malformed');
    var plan;
    if (op.type === 'write') plan = planWrite_(ss, op, allowFormulas);
    else if (op.type === 'append') plan = planAppend_(ss, op, allowFormulas);
    else if (op.type === 'clear') plan = planClear_(ss, op);
    else fail_('BAD_REQUEST', 'Operation ' + i + ' has an unknown type');
    total += plan.cells;
    if (total > LIMITS_.BATCH_CELLS) fail_('LIMIT_EXCEEDED', 'Batch exceeds ' + LIMITS_.BATCH_CELLS + ' cells');
    plans.push(plan);
  }
  // Phase 2: execute (Sheets has no transactions).
  return withLock_(function () {
    var results = [];
    for (var k = 0; k < plans.length; k++) {
      var res = execPlan_(plans[k]);
      res.type = plans[k].type;
      results.push(res);
    }
    return { results: results };
  });
}

// ===== Eval.js =====
/**
 * Eval.js - opt-in script evaluation (DESIGN.md section 8).
 * OFF by default. The spreadsheet allowlist does NOT apply to evaluated code: the only capability
 * boundary is the OAuth scopes declared in appsscript.json. Only the owner admin page can turn it on
 * (admin_setEvalEnabled); the MCP server cannot. The audit trail stores a SHA-256 of the code, never the code,
 * the args or the results.
 */

var STORE_EVAL_KEY_ = 'asmcp.eval';
var STORE_EVAL_AUDIT_KEY_ = 'asmcp.evalAudit';
var EVAL_LIMITS_ = {
  CODE_CHARS: 100000,
  LOG_LINE_CHARS: 2000,
  LOG_LINES: 200,
  VALUE_CHARS: 4 * 1024 * 1024,
  MESSAGE_CHARS: 2000,
  AUDIT_ENTRIES: 50,
  AUDIT_NAME_CHARS: 32
};

/** {enabled, changedAt}. Anything other than a literal true is "disabled". */
function getEvalConfig_() {
  var c = readJson_(STORE_EVAL_KEY_);
  if (!isPlainObject_(c)) return { enabled: false, changedAt: null };
  return { enabled: c.enabled === true, changedAt: typeof c.changedAt === 'string' ? c.changedAt : null };
}

function isEvalEnabled_() {
  return getEvalConfig_().enabled;
}

function getEvalAudit_() {
  var list = readJson_(STORE_EVAL_AUDIT_KEY_);
  return Array.isArray(list) ? list : [];
}

/** Appends an audit entry: newest last, at most 50 entries (and never more than one ScriptProperties value holds). */
function appendEvalAudit_(entry) {
  withLock_(function () {
    var list = getEvalAudit_();
    list.push(entry);
    while (list.length > EVAL_LIMITS_.AUDIT_ENTRIES) list.shift();
    while (list.length > 1 && JSON.stringify(list).length > STORE_MAX_VALUE_CHARS_) list.shift();
    writeJson_(STORE_EVAL_AUDIT_KEY_, list);
  });
}

/** Text of one log() part: strings as is, everything else JSON, falling back to String(). */
function evalLogPart_(v) {
  if (typeof v === 'string') return v;
  try {
    var j = JSON.stringify(v);
    if (typeof j === 'string') return j;
  } catch (e) { /* fall through */ }
  try {
    return String(v);
  } catch (e2) {
    return '[unprintable]';
  }
}

/** Only letters, digits, '_', '$', '.' survive: the name is caller-controlled and must stay small. */
function evalErrorName_(err) {
  var raw = 'Error';
  try {
    if (err && typeof err.name === 'string' && err.name) raw = err.name;
  } catch (e) { /* keep default */ }
  return raw.replace(/[^A-Za-z0-9_$.]/g, '').slice(0, EVAL_LIMITS_.AUDIT_NAME_CHARS) || 'Error';
}

/** "Name: message" (<= 2000 chars). This is the one error that may contain data: the owner asked for it. */
function evalErrorMessage_(err) {
  var name = 'Error';
  var message = '';
  try {
    if (err && typeof err.name === 'string' && err.name) name = err.name;
    message = err && err.message !== undefined ? String(err.message) : String(err);
  } catch (e) {
    message = '[unprintable error]';
  }
  return (name + ': ' + message).slice(0, EVAL_LIMITS_.MESSAGE_CHARS);
}

/** Action script.eval: {code, args?} -> {value, logs, durationMs}. */
function actionEval_(params) {
  if (!isEvalEnabled_()) {
    fail_('EVAL_DISABLED', 'Script evaluation is disabled. The owner must enable it on the Apps Script admin page.');
  }
  var code = params.code;
  if (typeof code !== 'string' || code.length === 0) fail_('BAD_REQUEST', 'code must be a non-empty string');
  if (code.length > EVAL_LIMITS_.CODE_CHARS) {
    fail_('LIMIT_EXCEEDED', 'code exceeds ' + EVAL_LIMITS_.CODE_CHARS + ' characters');
  }
  var codeSha256 = sha256Hex_(code);

  var logs = [];
  var log = function () {
    if (logs.length >= EVAL_LIMITS_.LOG_LINES) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(evalLogPart_(arguments[i]));
    logs.push(parts.join(' ').slice(0, EVAL_LIMITS_.LOG_LINE_CHARS));
  };

  var started = Date.now();
  var audit = function (ok, errorName) {
    var entry = { at: new Date(Date.now()).toISOString(), codeSha256: codeSha256, ok: ok, durationMs: Date.now() - started };
    if (errorName) entry.errorName = errorName;
    try {
      appendEvalAudit_(entry);
    } catch (e) {
      // The code has already run: do not lose its result because the audit write failed.
      console.error('eval audit write failed');
    }
  };
  var failEval = function (errorCode, message, name) {
    audit(false, name);
    var e = new Error(message);
    e.asmcpCode = errorCode;
    if (errorCode === 'EVAL_ERROR') e.asmcpLogs = logs; // logs travel with EVAL_ERROR only
    throw e;
  };

  var value;
  try {
    value = new Function('args', 'log', code)(params.args, log);
  } catch (err) {
    failEval('EVAL_ERROR', evalErrorMessage_(err), evalErrorName_(err));
  }

  var text;
  try {
    text = JSON.stringify(value);
  } catch (err2) {
    failEval('EVAL_ERROR', 'Return value is not JSON-serializable', 'NotSerializable');
  }
  // undefined (also functions and symbols) serialize to nothing: the value is null.
  if (text === undefined) text = 'null';
  if (text.length > EVAL_LIMITS_.VALUE_CHARS) {
    failEval('LIMIT_EXCEEDED', 'Return value exceeds ' + EVAL_LIMITS_.VALUE_CHARS + ' characters', 'ValueTooLarge');
  }
  audit(true);
  return { value: JSON.parse(text), logs: logs, durationMs: Date.now() - started };
}

// ===== A1.js =====
/**
 * A1.js - A1 notation parsing / formatting (sheet-qualified ranges only).
 *
 * Accepted forms after the sheet prefix: A1, A1:B2, A:C, 2:5.
 * Sheet prefix: Sheet1!  or  'My Sheet'!  ('' escapes a quote inside a quoted name).
 * All helpers are internal (trailing underscore).
 */

var A1_MAX_ROW_ = 1000000;
var A1_MAX_COL_ = 18278; // ZZZ

/** Column letters -> 1-based number ("A"=1, "AA"=27). */
function colToNum_(letters) {
  if (typeof letters !== 'string' || !/^[A-Za-z]{1,3}$/.test(letters)) {
    fail_('INVALID_RANGE', 'Invalid column reference');
  }
  var s = letters.toUpperCase();
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  if (n < 1 || n > A1_MAX_COL_) fail_('INVALID_RANGE', 'Column out of bounds');
  return n;
}

/** 1-based number -> column letters. */
function numToCol_(n) {
  if (typeof n !== 'number' || n % 1 !== 0 || n < 1 || n > A1_MAX_COL_) {
    fail_('INVALID_RANGE', 'Column out of bounds');
  }
  var s = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Splits "'My Sheet'!A1:B2" into {sheet: "My Sheet", rest: "A1:B2"}. The sheet name is mandatory. */
function splitSheetRef_(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 300) {
    fail_('INVALID_RANGE', 'Range must be a non-empty string that includes the sheet name');
  }
  var sheet;
  var rest;
  if (text.charAt(0) === "'") {
    var i = 1;
    var name = '';
    for (;;) {
      if (i >= text.length) fail_('INVALID_RANGE', 'Unterminated quoted sheet name');
      var ch = text.charAt(i);
      if (ch === "'") {
        if (text.charAt(i + 1) === "'") {
          name += "'";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      name += ch;
      i++;
    }
    if (text.charAt(i) !== '!') fail_('INVALID_RANGE', 'Range must include the sheet name followed by "!"');
    sheet = name;
    rest = text.substring(i + 1);
  } else {
    var bang = text.indexOf('!');
    if (bang <= 0) fail_('INVALID_RANGE', 'Range must include the sheet name, e.g. Sheet1!A1:B2');
    sheet = text.substring(0, bang);
    if (sheet.indexOf("'") >= 0) fail_('INVALID_RANGE', 'Sheet names containing quotes must be quoted');
    rest = text.substring(bang + 1);
  }
  if (sheet.length === 0 || sheet.length > 100) fail_('INVALID_RANGE', 'Invalid sheet name');
  return { sheet: sheet, rest: rest };
}

function parseRow_(digits) {
  var n = parseInt(digits, 10);
  if (!(n >= 1) || n > A1_MAX_ROW_) fail_('INVALID_RANGE', 'Row out of bounds');
  return n;
}

/**
 * Parses a sheet-qualified range.
 * Returns {sheet, kind, r1, c1, r2, c2}; kind is 'cell' | 'range' | 'cols' | 'rows'.
 * For 'cols' r2 is null (unbounded rows, r1 = 1); for 'rows' c2 is null (unbounded columns, c1 = 1).
 * Reversed corners are normalised.
 */
function parseA1_(text) {
  var parts = splitSheetRef_(text);
  var rest = parts.rest;
  var m;
  var cellRe = '\\$?([A-Za-z]{1,3})\\$?([0-9]{1,7})';
  if ((m = new RegExp('^' + cellRe + '$').exec(rest))) {
    var c = colToNum_(m[1]);
    var r = parseRow_(m[2]);
    return { sheet: parts.sheet, kind: 'cell', r1: r, c1: c, r2: r, c2: c };
  }
  if ((m = new RegExp('^' + cellRe + ':' + cellRe + '$').exec(rest))) {
    var ca = colToNum_(m[1]);
    var ra = parseRow_(m[2]);
    var cb = colToNum_(m[3]);
    var rb = parseRow_(m[4]);
    return {
      sheet: parts.sheet, kind: 'range',
      r1: Math.min(ra, rb), c1: Math.min(ca, cb), r2: Math.max(ra, rb), c2: Math.max(ca, cb)
    };
  }
  if ((m = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(rest))) {
    var x = colToNum_(m[1]);
    var y = colToNum_(m[2]);
    return { sheet: parts.sheet, kind: 'cols', r1: 1, c1: Math.min(x, y), r2: null, c2: Math.max(x, y) };
  }
  if ((m = /^\$?([0-9]{1,7}):\$?([0-9]{1,7})$/.exec(rest))) {
    var p = parseRow_(m[1]);
    var q = parseRow_(m[2]);
    return { sheet: parts.sheet, kind: 'rows', r1: Math.min(p, q), c1: 1, r2: Math.max(p, q), c2: null };
  }
  fail_('INVALID_RANGE', 'Unsupported range syntax (use A1, A1:B2, A:C or 2:5)');
}

/** Quotes a sheet name only when needed. */
function quoteSheet_(name) {
  var simple = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^[A-Za-z]{1,3}[0-9]+$/.test(name) &&
    !/^[Rr][0-9]*[Cc][0-9]*$/.test(name) &&
    !/^(true|false)$/i.test(name);
  if (simple) return name;
  return "'" + name.replace(/'/g, "''") + "'";
}

/** Formats a bounded rectangle as "Sheet!A1" or "Sheet!A1:B2". */
function formatA1_(sheet, r1, c1, r2, c2) {
  var a = numToCol_(c1) + r1;
  if (r1 === r2 && c1 === c2) return quoteSheet_(sheet) + '!' + a;
  return quoteSheet_(sheet) + '!' + a + ':' + numToCol_(c2) + r2;
}

// ===== Store.js =====
/**
 * Store.js - persistence in ScriptProperties.
 * Keys (DESIGN.md sections 5.2, 9.3): asmcp.pairings (legacy: asmcp.pairing), asmcp.pairing.pending,
 * asmcp.setupConsumed, asmcp.setupAttempts, asmcp.spreadsheets (JSON).
 * The pairing record holds the HMAC secret: it must never be returned to the admin page or logged.
 */

var STORE_PAIRING_KEY_ = 'asmcp.pairing';
var STORE_PAIRINGS_KEY_ = 'asmcp.pairings';
var STORE_MAX_PAIRINGS_ = 20;
var STORE_SETUP_CONSUMED_KEY_ = 'asmcp.setupConsumed';
var STORE_SETUP_CONSUMED_MAX_ = 20;
var STORE_SETUP_ATTEMPTS_KEY_ = 'asmcp.setupAttempts';
var STORE_PENDING_KEY_ = 'asmcp.pairing.pending';
var STORE_SHEETS_KEY_ = 'asmcp.spreadsheets';
var STORE_MAX_VALUE_CHARS_ = 9000; // ScriptProperties limit is 9 KB per value

function readJson_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeJson_(key, value) {
  var text = JSON.stringify(value);
  if (text.length > STORE_MAX_VALUE_CHARS_) throw new Error('Dữ liệu vượt giới hạn lưu trữ (9 KB).');
  PropertiesService.getScriptProperties().setProperty(key, text);
}

/** Runs fn while holding the script lock (non-reentrant: never nest). */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Pairings (DESIGN.md section 9.3): asmcp.pairings = {<instanceId>: {instanceLabel, secret, pairedAt}}, max 20.
 * A legacy single asmcp.pairing is merged in on read (an entry already in the map wins) and is removed the next
 * time the map is written, which always happens under the script lock.
 * The map is null-prototype so an instanceId such as "__proto__" is an ordinary key.
 */
function getPairings_() {
  var map = Object.create(null);
  var stored = readJson_(STORE_PAIRINGS_KEY_);
  if (isPlainObject_(stored)) {
    var ids = Object.keys(stored);
    for (var i = 0; i < ids.length; i++) {
      var e = stored[ids[i]];
      if (isPlainObject_(e) && typeof e.secret === 'string') map[ids[i]] = e;
    }
  }
  var legacy = readJson_(STORE_PAIRING_KEY_);
  if (isPlainObject_(legacy) && typeof legacy.instanceId === 'string' && typeof legacy.secret === 'string' &&
      !(legacy.instanceId in map)) {
    map[legacy.instanceId] = {
      instanceLabel: typeof legacy.instanceLabel === 'string' ? legacy.instanceLabel : '',
      secret: legacy.secret,
      pairedAt: legacy.pairedAt
    };
  }
  return map;
}

/** One pairing as {instanceId, instanceLabel, secret, pairedAt}, or null. */
function getPairing_(instanceId) {
  var map = getPairings_();
  if (!(instanceId in map)) return null;
  var e = map[instanceId];
  return { instanceId: instanceId, instanceLabel: e.instanceLabel, secret: e.secret, pairedAt: e.pairedAt };
}

/** Pairings for the admin page: no secrets, oldest first. */
function listPairings_() {
  var map = getPairings_();
  var out = Object.keys(map).map(function (id) {
    return { instanceId: id, instanceLabel: String(map[id].instanceLabel || ''), pairedAt: map[id].pairedAt || null };
  });
  out.sort(function (a, b) { return String(a.pairedAt).localeCompare(String(b.pairedAt)); });
  return out;
}

function savePairings_(map) {
  writeJson_(STORE_PAIRINGS_KEY_, map);
  PropertiesService.getScriptProperties().deleteProperty(STORE_PAIRING_KEY_);
}

/** Adds or replaces (same instanceId) a pairing. Call under the script lock. A 21st instance -> LIMIT_EXCEEDED. */
function addPairing_(p) {
  var map = getPairings_();
  if (!(p.instanceId in map) && Object.keys(map).length >= STORE_MAX_PAIRINGS_) {
    fail_('LIMIT_EXCEEDED', 'Too many paired servers (max ' + STORE_MAX_PAIRINGS_ + ')');
  }
  map[p.instanceId] = {
    instanceLabel: String(p.instanceLabel).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64),
    secret: p.secret,
    pairedAt: p.pairedAt
  };
  savePairings_(map);
}

/** Removes one pairing; false when it did not exist. Call under the script lock. */
function removePairing_(instanceId) {
  var map = getPairings_();
  if (!(instanceId in map)) return false;
  delete map[instanceId];
  savePairings_(map);
  return true;
}

/** Setup-token bookkeeping (section 9.3): hashes of consumed/burned tokens (last 20) and invalid-attempt counter. */
function getSetupConsumed_() {
  var l = readJson_(STORE_SETUP_CONSUMED_KEY_);
  return Array.isArray(l) ? l.filter(function (h) { return typeof h === 'string'; }) : [];
}
function addSetupConsumed_(hash) {
  var l = getSetupConsumed_();
  if (l.indexOf(hash) < 0) l.push(hash);
  writeJson_(STORE_SETUP_CONSUMED_KEY_, l.slice(-STORE_SETUP_CONSUMED_MAX_));
}
/** {hash, n} for the token being attempted; a different token starts at 0. */
function getSetupAttempts_(hash) {
  var a = readJson_(STORE_SETUP_ATTEMPTS_KEY_);
  return isPlainObject_(a) && a.hash === hash && typeof a.n === 'number' ? a.n : 0;
}
function setSetupAttempts_(hash, n) { writeJson_(STORE_SETUP_ATTEMPTS_KEY_, { hash: hash, n: n }); }
function clearSetupAttempts_() { PropertiesService.getScriptProperties().deleteProperty(STORE_SETUP_ATTEMPTS_KEY_); }

function getPending_() {
  var p = readJson_(STORE_PENDING_KEY_);
  if (!p || typeof p.codeHash !== 'string' || typeof p.expiresAt !== 'number') return null;
  return p;
}
function setPending_(p) { writeJson_(STORE_PENDING_KEY_, p); }
function clearPending_() { PropertiesService.getScriptProperties().deleteProperty(STORE_PENDING_KEY_); }

/** Allowlist entries: {id, name, alias, access: 'read'|'write'}. */
function getAllowlist_() {
  var list = readJson_(STORE_SHEETS_KEY_);
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || typeof e.id !== 'string') continue;
    out.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : '',
      alias: typeof e.alias === 'string' ? e.alias : '',
      access: e.access === 'write' ? 'write' : 'read'
    });
  }
  return out;
}
function saveAllowlist_(list) { writeJson_(STORE_SHEETS_KEY_, list); }

/** Exact-match lookup; returns the entry or null. */
function findAllowed_(id) {
  var list = getAllowlist_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// ===== Admin.html =====
var ADMIN_HTML_ = "<!DOCTYPE html>\n<html lang=\"vi\">\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<style>\n  :root { --bg:#f6f7f9; --card:#fff; --text:#1f2933; --muted:#667085; --line:#e4e7ec; --accent:#1a73e8; --danger:#c5221f; --ok:#137333; }\n  * { box-sizing: border-box; }\n  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif; }\n  main { max-width:820px; margin:0 auto; }\n  h1 { font-size:20px; margin:0 0 16px; }\n  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }\n  h2 { font-size:15px; margin:0 0 12px; }\n  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }\n  input[type=text], select { padding:7px 9px; border:1px solid var(--line); border-radius:6px; font:inherit; background:#fff; color:inherit; }\n  input[type=text] { flex:1; min-width:160px; }\n  button { padding:7px 12px; border:1px solid var(--line); border-radius:6px; background:#fff; color:inherit; font:inherit; cursor:pointer; }\n  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }\n  button.danger { color:var(--danger); }\n  button:disabled { opacity:.5; cursor:default; }\n  table { width:100%; border-collapse:collapse; margin-top:12px; }\n  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }\n  th { color:var(--muted); font-weight:600; font-size:12px; }\n  td.actions { white-space:nowrap; text-align:right; }\n  .muted { color:var(--muted); }\n  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; word-break:break-all; }\n  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; background:#eef1f5; }\n  .badge.ok { background:#e6f4ea; color:var(--ok); }\n  #msg { min-height:20px; margin-bottom:12px; }\n  #msg.err { color:var(--danger); }\n  #msg.ok { color:var(--ok); }\n  .table-wrap { overflow-x:auto; }\n  .warn { border:1px solid var(--danger); background:#fdecea; color:var(--danger); border-radius:6px; padding:10px 12px; margin:0 0 12px; }\n</style>\n</head>\n<body>\n<main>\n  <h1>apps-script-mcp - Quản trị Apps Script</h1>\n  <div id=\"msg\" role=\"status\"></div>\n\n  <section id=\"setupNotice\" style=\"display:none\">\n    <h2 id=\"setupTitle\"></h2>\n    <div id=\"setupBody\"></div>\n    <div class=\"row\" id=\"setupUrlRow\" style=\"margin-top:8px;display:none\">\n      <input type=\"text\" id=\"setupUrl\" readonly>\n      <button id=\"setupCopyBtn\">Sao chép</button>\n    </div>\n  </section>\n\n  <section>\n    <h2>Máy chủ MCP đã ghép nối</h2>\n    <div id=\"pairStatus\" class=\"muted\">Đang tải...</div>\n    <div class=\"table-wrap\">\n      <table id=\"pairTable\" style=\"display:none\">\n        <thead><tr><th>Máy chủ</th><th>Ghép nối lúc</th><th></th></tr></thead>\n        <tbody id=\"pairRows\"></tbody>\n      </table>\n    </div>\n    <p class=\"muted\" style=\"margin:8px 0 0\">Một script có thể ghép nối với tối đa 20 máy chủ. Hủy một kết nối không ảnh hưởng các kết nối khác.</p>\n  </section>\n\n  <section>\n    <h2>Nhập mã ghép nối</h2>\n    <p class=\"muted\" style=\"margin-top:0\">Dùng khi script đã cài sẵn và bạn muốn kết nối thêm một máy chủ MCP khác: nhập mã hiển thị trong trang quản trị của máy chủ đó (dạng XXXX-XXXX). Mã có hiệu lực 10 phút.</p>\n    <div class=\"row\">\n      <input type=\"text\" id=\"codeInput\" placeholder=\"XXXX-XXXX\" maxlength=\"12\" autocomplete=\"off\" spellcheck=\"false\">\n      <button id=\"codeBtn\" class=\"primary\">Xác nhận mã</button>\n    </div>\n    <div id=\"pendingInfo\" class=\"muted\" style=\"margin-top:8px\"></div>\n  </section>\n\n  <section>\n    <h2>Bảng tính được phép</h2>\n    <div class=\"row\">\n      <input type=\"text\" id=\"addInput\" placeholder=\"URL hoặc ID bảng tính\" autocomplete=\"off\">\n      <input type=\"text\" id=\"addAlias\" placeholder=\"Alias (tùy chọn)\" style=\"max-width:200px\" maxlength=\"64\">\n      <select id=\"addAccess\">\n        <option value=\"read\">Chỉ đọc</option>\n        <option value=\"write\">Đọc và ghi</option>\n      </select>\n      <button id=\"addBtn\" class=\"primary\">Thêm</button>\n    </div>\n    <div class=\"table-wrap\">\n      <table>\n        <thead><tr><th>Alias</th><th>Tên tệp</th><th>Quyền</th><th></th></tr></thead>\n        <tbody id=\"sheetRows\"></tbody>\n      </table>\n    </div>\n    <div id=\"emptyInfo\" class=\"muted\" style=\"margin-top:8px;display:none\">Chưa có bảng tính nào. Máy chủ MCP chỉ truy cập được các bảng tính trong danh sách này.</div>\n  </section>\n\n  <section>\n    <h2>Chạy Apps Script (nâng cao)</h2>\n    <div class=\"warn\" role=\"alert\">\n      <strong>Cảnh báo.</strong> Khi bật, Claude có thể chạy mã tùy ý bằng tài khoản Google của bạn. Nội dung bảng tính, email hay tệp\n      mà Claude đọc có thể chứa lệnh ẩn (prompt injection) khiến nó chạy mã ngoài ý muốn. Danh sách bảng tính được phép\n      <strong>không</strong> áp dụng cho mã này. Ranh giới thật sự là các scope OAuth khai báo trong <code>appsscript.json</code>:\n      hãy xóa những scope bạn không muốn cấp (nhất là <code>script.external_request</code> và Gmail vì chúng cho phép đưa dữ liệu ra ngoài).\n    </div>\n    <div class=\"row\">\n      <span id=\"evalBadge\" class=\"badge\">Đang tải...</span>\n      <button id=\"evalBtn\" class=\"danger\" disabled>...</button>\n    </div>\n    <div id=\"evalInfo\" class=\"muted\" style=\"margin-top:8px\"></div>\n    <div class=\"row\" style=\"margin-top:12px\">\n      <strong>Nhật ký 50 lần chạy gần nhất</strong>\n      <button id=\"auditBtn\">Tải lại</button>\n    </div>\n    <p class=\"muted\" style=\"margin:4px 0 0\">Chỉ lưu mã băm SHA-256 của mã, không lưu nội dung mã, tham số hay kết quả.</p>\n    <div class=\"table-wrap\">\n      <table>\n        <thead><tr><th>Thời gian</th><th>SHA-256 của mã</th><th>Kết quả</th><th>Thời lượng</th></tr></thead>\n        <tbody id=\"auditRows\"></tbody>\n      </table>\n    </div>\n    <div id=\"auditEmpty\" class=\"muted\" style=\"margin-top:8px;display:none\">Chưa có lần chạy nào.</div>\n  </section>\n\n  <section>\n    <h2>URL ứng dụng web</h2>\n    <p class=\"muted\" style=\"margin-top:0\">Dán URL này vào trang quản trị của máy chủ MCP.</p>\n    <div class=\"row\">\n      <input type=\"text\" id=\"urlInput\" readonly>\n      <button id=\"copyBtn\">Sao chép</button>\n    </div>\n  </section>\n</main>\n\n<script>\n(function () {\n  var state = null;\n  var editingId = null;\n  var $ = function (id) { return document.getElementById(id); };\n\n  function msg(text, kind) {\n    var el = $('msg');\n    el.textContent = text || '';\n    el.className = kind || '';\n  }\n  function run(fnName, args, onOk, onFail) {\n    msg('');\n    var r = google.script.run\n      .withSuccessHandler(function (res) { onOk && onOk(res); })\n      .withFailureHandler(function (err) {\n        var m = err && err.message ? String(err.message).replace(/^Error:\\s*/, '') : 'Đã xảy ra lỗi.';\n        msg(m === 'ACCESS_DENIED' ? 'Truy cập bị từ chối.' : m, 'err');\n        onFail && onFail();\n      });\n    r[fnName].apply(r, args);\n  }\n  function fmtTime(v) {\n    var d = new Date(v);\n    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('vi-VN');\n  }\n  function el(tag, text, cls) {\n    var e = document.createElement(tag);\n    if (text !== undefined && text !== null) e.textContent = text;\n    if (cls) e.className = cls;\n    return e;\n  }\n  function accessLabel(a) { return a === 'write' ? 'Đọc và ghi' : 'Chỉ đọc'; }\n\n  function load() {\n    run('admin_getState', [], function (s) { state = s; render(); });\n  }\n\n  function render() {\n    renderPairings();\n    renderSetup();\n    $('pendingInfo').textContent = state.pendingExpiresAt\n      ? 'Đang chờ máy chủ xác nhận mã (hết hạn lúc ' + fmtTime(state.pendingExpiresAt) + ').' : '';\n    $('urlInput').value = state.webAppUrl || '';\n    renderSheets();\n    renderEval();\n  }\n\n  function renderPairings() {\n    var list = state.pairings || [];\n    var ps = $('pairStatus');\n    ps.textContent = '';\n    ps.appendChild(el('span', list.length ? 'Đã ghép nối (' + list.length + ')' : 'Chưa ghép nối', 'badge' + (list.length ? ' ok' : '')));\n    if (list.length) ps.appendChild(el('div', 'Tài khoản Google: ' + state.account, 'muted'));\n    $('pairTable').style.display = list.length ? '' : 'none';\n    var body = $('pairRows');\n    body.textContent = '';\n    list.forEach(function (p) {\n      var tr = document.createElement('tr');\n      var name = el('td');\n      name.appendChild(el('div', p.instanceLabel || '(không tên)'));\n      name.appendChild(el('div', p.instanceId, 'mono muted'));\n      var when = el('td', fmtTime(p.pairedAt));\n      var act = el('td', null, 'actions');\n      var btn = el('button', 'Hủy ghép nối', 'danger');\n      btn.onclick = function () {\n        if (!confirm('Hủy ghép nối \"' + (p.instanceLabel || p.instanceId) + '\"? Máy chủ đó sẽ không truy cập được nữa cho đến khi ghép nối lại.')) return;\n        run('admin_unpair', [p.instanceId], function (res) {\n          state.pairings = res.pairings; state.paired = res.pairings.length > 0; renderPairings(); msg('Đã hủy ghép nối.', 'ok');\n        });\n      };\n      act.appendChild(btn);\n      tr.appendChild(name); tr.appendChild(when); tr.appendChild(act);\n      body.appendChild(tr);\n    });\n  }\n\n  function renderSetup() {\n    var s = state.setup;\n    var box = $('setupNotice');\n    if (!s || s.status === 'expired') { box.style.display = 'none'; return; }\n    box.style.display = '';\n    var ready = s.status === 'ready';\n    $('setupTitle').textContent = ready ? 'Sẵn sàng kết nối' : (s.status === 'connected' ? 'Đã kết nối' : 'Mã cài đặt đã bị hủy');\n    var body = $('setupBody');\n    body.textContent = '';\n    if (ready) {\n      body.appendChild(el('p', 'Script này đã sẵn sàng kết nối với ' + (s.server || 'máy chủ MCP') +\n        '. Quay lại trang MCP và dán URL web app.', null));\n      $('setupUrl').value = state.webAppUrl || '';\n    } else if (s.status === 'connected') {\n      body.appendChild(el('p', 'Đã kết nối', 'muted'));\n    } else {\n      body.appendChild(el('p', 'Có quá nhiều lần thử sai. Hãy tạo Code.gs mới từ trang MCP.', 'muted'));\n    }\n    $('setupUrlRow').style.display = ready ? '' : 'none';\n  }\n\n  function renderEval() {\n    var on = !!state.evalEnabled;\n    var badge = $('evalBadge');\n    badge.textContent = on ? 'Đang bật' : 'Đang tắt';\n    badge.className = 'badge' + (on ? ' ok' : '');\n    var btn = $('evalBtn');\n    btn.disabled = false;\n    btn.textContent = on ? 'Tắt chạy script' : 'Bật chạy script';\n    btn.className = on ? '' : 'danger';\n    $('evalInfo').textContent = state.evalChangedAt ? 'Thay đổi lần cuối: ' + fmtTime(state.evalChangedAt) : '';\n  }\n\n  function loadAudit() {\n    run('admin_getEvalAudit', [], function (list) {\n      var body = $('auditRows');\n      body.textContent = '';\n      $('auditEmpty').style.display = list.length ? 'none' : '';\n      list.forEach(function (e) {\n        var tr = document.createElement('tr');\n        var td = function (node) { var c = el('td'); c.appendChild(node); tr.appendChild(c); };\n        td(document.createTextNode(fmtTime(e.at)));\n        td(el('span', String(e.codeSha256).slice(0, 16) + '...', 'mono'));\n        td(el('span', e.ok ? 'Thành công' : 'Lỗi' + (e.errorName ? ': ' + e.errorName : ''), 'badge' + (e.ok ? ' ok' : '')));\n        td(document.createTextNode(e.durationMs + ' ms'));\n        body.appendChild(tr);\n      });\n    });\n  }\n\n  function renderSheets() {\n    var body = $('sheetRows');\n    body.textContent = '';\n    var list = state.spreadsheets || [];\n    $('emptyInfo').style.display = list.length ? 'none' : '';\n    list.forEach(function (s) {\n      var tr = document.createElement('tr');\n      var editing = editingId === s.id;\n      var aliasCell = el('td');\n      var accessCell = el('td');\n      var actCell = el('td', null, 'actions');\n      var aliasInput, accessSel;\n      if (editing) {\n        aliasInput = el('input'); aliasInput.type = 'text'; aliasInput.value = s.alias; aliasInput.maxLength = 64;\n        aliasCell.appendChild(aliasInput);\n        accessSel = document.createElement('select');\n        [['read', 'Chỉ đọc'], ['write', 'Đọc và ghi']].forEach(function (o) {\n          var opt = el('option', o[1]); opt.value = o[0]; accessSel.appendChild(opt);\n        });\n        accessSel.value = s.access;\n        accessCell.appendChild(accessSel);\n        var save = el('button', 'Lưu', 'primary');\n        save.onclick = function () {\n          run('admin_updateSpreadsheet', [s.id, aliasInput.value, accessSel.value], function (res) {\n            editingId = null; state.spreadsheets = res.spreadsheets; renderSheets(); msg('Đã cập nhật.', 'ok');\n          });\n        };\n        var cancel = el('button', 'Hủy');\n        cancel.onclick = function () { editingId = null; renderSheets(); };\n        actCell.appendChild(save); actCell.appendChild(document.createTextNode(' ')); actCell.appendChild(cancel);\n      } else {\n        aliasCell.appendChild(el('strong', s.alias));\n        accessCell.appendChild(el('span', accessLabel(s.access), 'badge' + (s.access === 'write' ? ' ok' : '')));\n        var edit = el('button', 'Sửa');\n        edit.onclick = function () { editingId = s.id; renderSheets(); };\n        var del = el('button', 'Xóa', 'danger');\n        del.onclick = function () {\n          if (!confirm('Xóa \"' + s.alias + '\" khỏi danh sách?')) return;\n          run('admin_removeSpreadsheet', [s.id], function (res) {\n            state.spreadsheets = res.spreadsheets; renderSheets(); msg('Đã xóa.', 'ok');\n          });\n        };\n        actCell.appendChild(edit); actCell.appendChild(document.createTextNode(' ')); actCell.appendChild(del);\n      }\n      var nameCell = el('td');\n      nameCell.appendChild(el('div', s.name));\n      nameCell.appendChild(el('div', s.id, 'mono muted'));\n      tr.appendChild(aliasCell); tr.appendChild(nameCell); tr.appendChild(accessCell); tr.appendChild(actCell);\n      body.appendChild(tr);\n    });\n  }\n\n  $('codeBtn').onclick = function () {\n    var v = $('codeInput').value;\n    run('admin_submitPairingCode', [v], function () {\n      $('codeInput').value = '';\n      msg('Đã lưu mã. Máy chủ MCP sẽ xác nhận trong vài giây.', 'ok');\n      load();\n    });\n  };\n  $('addBtn').onclick = function () {\n    run('admin_addSpreadsheet', [$('addInput').value, $('addAlias').value, $('addAccess').value], function (res) {\n      $('addInput').value = ''; $('addAlias').value = '';\n      state.spreadsheets = res.spreadsheets; renderSheets(); msg('Đã thêm bảng tính.', 'ok');\n    });\n  };\n  $('evalBtn').onclick = function () {\n    var enable = !state.evalEnabled;\n    if (enable && !confirm('Bật chạy script? Claude sẽ chạy được mã tùy ý bằng tài khoản Google của bạn, trong phạm vi các scope trong appsscript.json.')) return;\n    $('evalBtn').disabled = true;\n    run('admin_setEvalEnabled', [enable], function (res) {\n      state.evalEnabled = res.evalEnabled; state.evalChangedAt = res.evalChangedAt; renderEval();\n      msg(enable ? 'Đã bật chạy script.' : 'Đã tắt chạy script.', 'ok');\n    }, renderEval);\n  };\n  $('auditBtn').onclick = loadAudit;\n  function copyFrom(input) {\n    var done = function () { msg('Đã sao chép URL.', 'ok'); };\n    if (navigator.clipboard && navigator.clipboard.writeText) {\n      navigator.clipboard.writeText(input.value).then(done, function () { input.select(); document.execCommand('copy'); done(); });\n    } else {\n      input.select(); document.execCommand('copy'); done();\n    }\n  }\n  $('copyBtn').onclick = function () { copyFrom($('urlInput')); };\n  $('setupCopyBtn').onclick = function () { copyFrom($('setupUrl')); };\n  load();\n  loadAudit();\n})();\n</script>\n</body>\n</html>\n";
