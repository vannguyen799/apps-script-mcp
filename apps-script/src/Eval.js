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
