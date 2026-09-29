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
