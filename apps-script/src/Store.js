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
