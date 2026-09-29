/**
 * Store.js - persistence in ScriptProperties.
 * Keys (DESIGN.md section 5.2): gsmcp.pairing, gsmcp.pairing.pending, gsmcp.spreadsheets (JSON).
 * The pairing record holds the HMAC secret: it must never be returned to the admin page or logged.
 */

var STORE_PAIRING_KEY_ = 'gsmcp.pairing';
var STORE_PENDING_KEY_ = 'gsmcp.pairing.pending';
var STORE_SHEETS_KEY_ = 'gsmcp.spreadsheets';
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

function getPairing_() {
  var p = readJson_(STORE_PAIRING_KEY_);
  if (!p || typeof p.instanceId !== 'string' || typeof p.secret !== 'string') return null;
  return p;
}
function setPairing_(p) { writeJson_(STORE_PAIRING_KEY_, p); }
function clearPairing_() { PropertiesService.getScriptProperties().deleteProperty(STORE_PAIRING_KEY_); }

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
