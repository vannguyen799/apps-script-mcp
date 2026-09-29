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
