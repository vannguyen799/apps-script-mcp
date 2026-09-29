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
