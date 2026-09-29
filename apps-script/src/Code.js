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
    .setTitle('gsheets-mcp - Quản trị')
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
  var pairing = getPairing_();
  var pending = getPending_();
  var now = Date.now();
  return {
    account: Session.getEffectiveUser().getEmail(),
    webAppUrl: ScriptApp.getService().getUrl(),
    paired: !!pairing,
    instanceLabel: pairing ? pairing.instanceLabel : null,
    pairedAt: pairing ? pairing.pairedAt : null,
    pendingExpiresAt: pending && pending.expiresAt > now ? pending.expiresAt : null,
    spreadsheets: getAllowlist_()
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

function admin_unpair() {
  assertOwner_();
  withLock_(function () {
    clearPairing_();
    clearPending_();
  });
  return { ok: true };
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

// ---------- admin helpers ----------

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
