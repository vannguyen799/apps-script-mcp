'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox } = require('./harness');

function setup(access = 'write', sheets) {
  const sb = createSandbox();
  const client = sb.pairClient();
  const s = sb.addSpreadsheet({
    name: 'Budget', alias: 'budget', access,
    sheets: sheets || {
      Sheet1: [['name', 'qty', 'note'], ['apple', 3, 'Red'], ['pear', 5, 'green'], ['Apple pie', 1, '']],
      "Bob's data": [['x'], ['apple']]
    }
  });
  const call = (action, params) => client.call(action, { spreadsheetId: s.id, ...params });
  return { sb, client, s, call, sheet: (n) => sb.sheetsFake.get(s.id).getSheetByName(n) };
}

// ------------------------------------------------------------ authorization

test('unauthorized spreadsheet is rejected BEFORE openById', () => {
  const { sb, client } = setup();
  const other = sb.addSpreadsheet({ name: 'Other', sheets: { Sheet1: [['x']] } }); // not allowlisted
  sb.sheetsFake.opened.length = 0;
  for (const action of ['spreadsheet.metadata', 'range.read', 'search', 'range.write', 'rows.append', 'batch.update']) {
    const r = client.call(action, { spreadsheetId: other.id, range: 'Sheet1!A1', query: 'x', values: [[1]], rows: [[1]], sheet: 'Sheet1', operations: [] });
    assert.equal(r.error.code, 'SPREADSHEET_NOT_AUTHORIZED', action);
  }
  assert.equal(client.call('range.read', { spreadsheetId: 'nope', range: 'Sheet1!A1' }).error.code, 'SPREADSHEET_NOT_AUTHORIZED');
  assert.equal(client.call('range.read', { range: 'Sheet1!A1' }).error.code, 'BAD_REQUEST');
  assert.equal(client.call('range.read', { spreadsheetId: 5, range: 'Sheet1!A1' }).error.code, 'BAD_REQUEST');
  assert.deepEqual(sb.sheetsFake.opened, []);
});

test('read-only entries reject every write action with WRITE_NOT_ALLOWED and change nothing', () => {
  const { sb, call, sheet } = setup('read');
  const before = JSON.stringify(sheet('Sheet1').data);
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [['z']] }).error.code, 'WRITE_NOT_ALLOWED');
  assert.equal(call('rows.append', { sheet: 'Sheet1', rows: [['z']] }).error.code, 'WRITE_NOT_ALLOWED');
  assert.equal(call('batch.update', { operations: [{ type: 'clear', range: 'Sheet1!A1' }] }).error.code, 'WRITE_NOT_ALLOWED');
  assert.equal(JSON.stringify(sheet('Sheet1').data), before);
  assert.equal(sb.sheetsFake.writes, 0);
  assert.equal(call('range.read', { range: 'Sheet1!A1' }).ok, true);
});

// ------------------------------------------------------------ read actions

test('spreadsheets.list uses the live name and falls back to the stored one', () => {
  const { sb, client, s } = setup();
  sb.sheetsFake.get(s.id).name = 'Budget 2026';
  const ghost = { id: 'ghostghostghost', name: 'Stored', alias: 'ghost', access: 'read' };
  const list = JSON.parse(sb.props.get('asmcp.spreadsheets'));
  list.push(ghost);
  sb.props.set('asmcp.spreadsheets', JSON.stringify(list));
  const r = client.call('spreadsheets.list');
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.spreadsheets, [
    { id: s.id, name: 'Budget 2026', alias: 'budget', access: 'write', url: `https://docs.google.com/spreadsheets/d/${s.id}/edit` },
    { id: 'ghostghostghost', name: 'Stored', alias: 'ghost', access: 'read', url: 'https://docs.google.com/spreadsheets/d/ghostghostghost/edit' }
  ]);
  assert.equal(client.call('ping').result.spreadsheetCount, 2);
});

test('spreadsheet.metadata', () => {
  const { sb, call, s } = setup('read', {
    Sheet1: { values: [['a', 'b'], [1, 2], [3, 4]], frozenRows: 1, maxRows: 50, maxColumns: 10 },
    Hidden: { values: [], hidden: true }
  });
  const r = call('spreadsheet.metadata');
  assert.equal(r.ok, true);
  assert.equal(r.result.id, s.id);
  assert.equal(r.result.name, 'Budget');
  assert.equal(r.result.locale, 'en_US');
  assert.equal(r.result.timeZone, 'Etc/UTC');
  assert.deepEqual(r.result.sheets[0], {
    sheetId: 0, name: 'Sheet1', index: 0, rowCount: 50, columnCount: 10, lastRow: 3, lastColumn: 2,
    frozenRows: 1, frozenColumns: 0, hidden: false
  });
  assert.equal(r.result.sheets[1].hidden, true);
  assert.equal(r.result.sheets[1].index, 1);
  assert.equal(r.result.sheets[1].lastRow, 0);
  void sb;
});

test('range.read: A1, A1:B2, formatted default, quoted sheet', () => {
  const { call } = setup('read');
  assert.deepEqual(call('range.read', { range: 'Sheet1!B2' }).result, { range: 'Sheet1!B2', values: [['3']] });
  assert.deepEqual(call('range.read', { range: 'Sheet1!A1:B2' }).result, { range: 'Sheet1!A1:B2', values: [['name', 'qty'], ['apple', '3']] });
  assert.deepEqual(call('range.read', { range: "'Bob''s data'!A:A" }).result, { range: "'Bob''s data'!A1:A2", values: [['x'], ['apple']] });
});

test('range.read: unbounded ranges are clipped to the data extent', () => {
  const { call } = setup('read');
  assert.deepEqual(call('range.read', { range: 'Sheet1!A:B' }).result, {
    range: 'Sheet1!A1:B4', values: [['name', 'qty'], ['apple', '3'], ['pear', '5'], ['Apple pie', '1']]
  });
  const rows = call('range.read', { range: 'Sheet1!2:3' }).result;
  assert.equal(rows.range, 'Sheet1!A2:C3');
  assert.deepEqual(rows.values, [['apple', '3', 'Red'], ['pear', '5', 'green']]);
  const empty = call('range.read', { range: "'Bob''s data'!C:D" });
  assert.equal(empty.ok, true);
  const blank = setup('read', { Empty: [] }).call('range.read', { range: 'Empty!A:Z' });
  assert.deepEqual(blank.result.values, []);
});

test('range.read: render modes', () => {
  const { call } = setup('write', { Sheet1: [[1.5, '=2+3', true]] });
  assert.deepEqual(call('range.read', { range: 'Sheet1!A1:C1' }).result.values, [['1.5', '5', 'TRUE']]);
  assert.deepEqual(call('range.read', { range: 'Sheet1!A1:C1', render: 'UNFORMATTED' }).result.values, [[1.5, 5, true]]);
  assert.deepEqual(call('range.read', { range: 'Sheet1!A1:C1', render: 'FORMULA' }).result.values, [[1.5, '=2+3', true]]);
  assert.equal(call('range.read', { range: 'Sheet1!A1', render: 'RAW' }).error.code, 'BAD_REQUEST');
});

test('range.read: errors', () => {
  const { call } = setup('read');
  assert.equal(call('range.read', { range: 'Nope!A1' }).error.code, 'SHEET_NOT_FOUND');
  assert.equal(call('range.read', { range: 'A1:B2' }).error.code, 'INVALID_RANGE');
  assert.equal(call('range.read', { range: 'Sheet1!ZZZZ1' }).error.code, 'INVALID_RANGE');
  assert.equal(call('range.read', {}).error.code, 'INVALID_RANGE');
});

test('range.read: 100000 cell limit', () => {
  const { call } = setup('read', { Big: { values: [[1]], maxRows: 20000, maxColumns: 26 } });
  assert.equal(call('range.read', { range: 'Big!A1:E20000' }).ok, true); // exactly 100 000
  assert.equal(call('range.read', { range: 'Big!A1:F20000' }).error.code, 'LIMIT_EXCEEDED');
});

test('search: cases, entire cell, sheet filter, all sheets', () => {
  const { call } = setup('read');
  const all = call('search', { query: 'apple' }).result;
  assert.equal(all.truncated, false);
  assert.deepEqual(all.matches.map((m) => `${m.sheet}|${m.range}|${m.value}`), [
    'Sheet1|Sheet1!A2|apple', 'Sheet1|Sheet1!A4|Apple pie', "Bob's data|'Bob''s data'!A2|apple"
  ]);
  assert.deepEqual(call('search', { query: 'apple' }).result.matches[0], { sheet: 'Sheet1', range: 'Sheet1!A2', row: 2, column: 1, value: 'apple' });
  assert.equal(call('search', { query: 'apple', matchCase: true }).result.matches.length, 2);
  assert.equal(call('search', { query: 'apple', matchEntireCell: true, matchCase: true, sheet: 'Sheet1' }).result.matches.length, 1);
  assert.equal(call('search', { query: 'APPLE', matchEntireCell: true }).result.matches.length, 2);
  assert.equal(call('search', { query: 'red', sheet: 'Sheet1' }).result.matches[0].range, 'Sheet1!C2');
  assert.equal(call('search', { query: 'apple', sheet: 'Nope' }).error.code, 'SHEET_NOT_FOUND');
  assert.equal(call('search', { query: '' }).error.code, 'BAD_REQUEST');
});

test('search: limit truncates and sets truncated; max 500', () => {
  const rows = Array.from({ length: 30 }, () => ['hit']);
  const { call } = setup('read', { S: rows });
  const r = call('search', { query: 'hit', limit: 10 }).result;
  assert.equal(r.matches.length, 10);
  assert.equal(r.truncated, true);
  const exact = call('search', { query: 'hit', limit: 30 }).result;
  assert.equal(exact.matches.length, 30);
  assert.equal(exact.truncated, false);
  assert.equal(call('search', { query: 'hit', limit: 501 }).error.code, 'LIMIT_EXCEEDED');
  assert.equal(call('search', { query: 'hit', limit: 0 }).error.code, 'BAD_REQUEST');
  assert.equal(call('search', { query: 'hit', limit: 'x' }).error.code, 'BAD_REQUEST');
});

// ------------------------------------------------------------ write actions

test('range.write happy path (exact size)', () => {
  const { call, sheet } = setup();
  const r = call('range.write', { range: 'Sheet1!A2:B3', values: [['kiwi', 9], ['plum', null]] });
  assert.deepEqual(r.result, { updatedRange: 'Sheet1!A2:B3', updatedRows: 2, updatedColumns: 2, updatedCells: 4 });
  assert.deepEqual(sheet('Sheet1').getRange('A2:B3').getValues(), [['kiwi', 9], ['plum', '']]);
  assert.equal(sheet('Sheet1').getRange('C2').getValues()[0][0], 'Red'); // untouched neighbour
});

test('range.write: single-cell anchor expands to the values size', () => {
  const { call, sheet } = setup();
  const r = call('range.write', { range: 'Sheet1!E5', values: [[1, 2, 3], [4, 5, 6]] });
  assert.deepEqual(r.result, { updatedRange: 'Sheet1!E5:G6', updatedRows: 2, updatedColumns: 3, updatedCells: 6 });
  assert.deepEqual(sheet('Sheet1').getRange('E5:G6').getValues(), [[1, 2, 3], [4, 5, 6]]);
  const one = call('range.write', { range: 'Sheet1!A10', values: [['solo']] });
  assert.equal(one.result.updatedRange, 'Sheet1!A10');
});

test('range.write: writing past the grid grows the sheet', () => {
  const { call, sheet } = setup('write', { S: { values: [['a']], maxRows: 3, maxColumns: 2 } });
  const r = call('range.write', { range: 'S!B3', values: [['x', 'y'], ['z', 'w']] });
  assert.equal(r.ok, true);
  assert.equal(sheet('S').getMaxRows(), 4);
  assert.equal(sheet('S').getMaxColumns(), 3);
  assert.deepEqual(sheet('S').getRange('B3:C4').getValues(), [['x', 'y'], ['z', 'w']]);
});

test('range.write: RANGE_SIZE_MISMATCH for multi-cell ranges (incl. A1:A1 vs 2x1) and no write', () => {
  const { sb, call } = setup();
  assert.equal(call('range.write', { range: 'Sheet1!A1:B2', values: [[1, 2, 3], [4, 5, 6]] }).error.code, 'RANGE_SIZE_MISMATCH');
  assert.equal(call('range.write', { range: 'Sheet1!A1:B2', values: [[1, 2]] }).error.code, 'RANGE_SIZE_MISMATCH');
  assert.equal(call('range.write', { range: 'Sheet1!A1:A1', values: [[1], [2]] }).error.code, 'RANGE_SIZE_MISMATCH');
  assert.equal(sb.sheetsFake.writes, 0);
});

test('range.write: unbounded targets are INVALID_RANGE', () => {
  const { call } = setup();
  assert.equal(call('range.write', { range: 'Sheet1!A:B', values: [[1, 2]] }).error.code, 'INVALID_RANGE');
  assert.equal(call('range.write', { range: 'Sheet1!2:3', values: [[1, 2]] }).error.code, 'INVALID_RANGE');
});

test('range.write: formulas rejected by default, accepted with allowFormulas, leading space is not a formula', () => {
  const { sb, call, sheet } = setup();
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [['=SUM(1,2)']] }).error.code, 'FORMULA_NOT_ALLOWED');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[1, '=1+1']] }).error.code, 'FORMULA_NOT_ALLOWED');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [['=1+1']], allowFormulas: false }).error.code, 'FORMULA_NOT_ALLOWED');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [['=1+1']], allowFormulas: 'yes' }).error.code, 'BAD_REQUEST');
  assert.equal(sb.sheetsFake.writes, 0);
  const ok = call('range.write', { range: 'Sheet1!A1', values: [['=1+1']], allowFormulas: true });
  assert.equal(ok.ok, true);
  assert.equal(sheet('Sheet1').getRange('A1').getFormulas()[0][0], '=1+1');
  assert.equal(call('rows.append', { sheet: 'Sheet1', rows: [['=2+2']] }).error.code, 'FORMULA_NOT_ALLOWED');
});

test('range.write: ragged rows, empty arrays and bad value types are INVALID_VALUE', () => {
  const { sb, call } = setup();
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[1, 2], [3]] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[1], [2, 3]] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[]] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: 'x' }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: ['x'] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[{ a: 1 }]] }).error.code, 'INVALID_VALUE');
  assert.equal(call('range.write', { range: 'Sheet1!A1', values: [[[1]]] }).error.code, 'INVALID_VALUE');
  assert.equal(sb.sheetsFake.writes, 0);
});

test('range.write: limits (20 000 cells, 50 000 chars per string)', () => {
  const { call } = setup('write', { S: { values: [[1]], maxRows: 30000, maxColumns: 2 } });
  const mk = (n) => Array.from({ length: n }, (_, i) => [i]);
  assert.equal(call('range.write', { range: 'S!A1', values: mk(20000) }).ok, true);
  assert.equal(call('range.write', { range: 'S!A1', values: Array.from({ length: 10001 }, () => [1, 2]) }).error.code, 'LIMIT_EXCEEDED');
  assert.equal(call('range.write', { range: 'S!A1', values: [['x'.repeat(50001)]] }).error.code, 'LIMIT_EXCEEDED');
  assert.equal(call('range.write', { range: 'S!A1', values: [['x'.repeat(50000)]] }).ok, true);
});

test('rows.append happy path appends after the last row', () => {
  const { call, sheet } = setup();
  const r = call('rows.append', { sheet: 'Sheet1', rows: [['fig', 2, 'x'], ['lime', true, null]] });
  assert.deepEqual(r.result, { updatedRange: 'Sheet1!A5:C6', appendedRows: 2 });
  assert.deepEqual(sheet('Sheet1').getRange('A5:C6').getValues(), [['fig', 2, 'x'], ['lime', true, '']]);
  assert.equal(call('rows.append', { sheet: 'Nope', rows: [[1]] }).error.code, 'SHEET_NOT_FOUND');
  assert.equal(call('rows.append', { sheet: 'Sheet1', rows: [[1], [1, 2]] }).error.code, 'INVALID_VALUE');
  assert.equal(call('rows.append', { sheet: 'Sheet1' }).error.code, 'INVALID_VALUE');
});

test('rows.append grows the grid when the sheet is full', () => {
  const { call, sheet } = setup('write', { S: { values: [['a'], ['b']], maxRows: 2, maxColumns: 1 } });
  const r = call('rows.append', { sheet: 'S', rows: [['c', 'd']] });
  assert.equal(r.result.updatedRange, 'S!A3:B3');
  assert.equal(sheet('S').getMaxRows(), 3);
  assert.equal(sheet('S').getMaxColumns(), 2);
});

// ------------------------------------------------------------ batch

test('batch.update happy path: write + append + clear', () => {
  const { call, sheet } = setup();
  const r = call('batch.update', {
    operations: [
      { type: 'write', range: 'Sheet1!E1', values: [[1, 2]] },
      { type: 'append', sheet: 'Sheet1', rows: [['new', 1, 'x']] },
      { type: 'clear', range: 'Sheet1!B2:B3' },
      { type: 'clear', range: 'Sheet1!C:C' }
    ]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.results, [
    { type: 'write', updatedRange: 'Sheet1!E1:F1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 },
    { type: 'append', updatedRange: 'Sheet1!A5:C5', appendedRows: 1 },
    { type: 'clear', clearedRange: 'Sheet1!B2:B3' },
    { type: 'clear', clearedRange: 'Sheet1!C:C' }
  ]);
  assert.deepEqual(sheet('Sheet1').getRange('E1:F1').getValues(), [[1, 2]]);
  assert.equal(sheet('Sheet1').getRange('B2').getValues()[0][0], '');
  assert.equal(sheet('Sheet1').getRange('C5').getValues()[0][0], ''); // column C cleared after the append
  assert.equal(sheet('Sheet1').getRange('A5').getValues()[0][0], 'new');
});

test('batch.update validates ALL operations before executing any', () => {
  const { sb, call, sheet } = setup();
  const before = JSON.stringify(sheet('Sheet1').data);
  const bad = [
    { type: 'write', range: 'Sheet1!A1', values: [['ok']] },
    { type: 'clear', range: 'Sheet1!B2' },
    { type: 'append', sheet: 'Sheet1', rows: [['=BAD()']] }
  ];
  assert.equal(call('batch.update', { operations: bad }).error.code, 'FORMULA_NOT_ALLOWED');
  assert.equal(JSON.stringify(sheet('Sheet1').data), before);
  const cases = [
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, { type: 'write', range: 'Sheet1!A1:B2', values: [[1]] }, 'RANGE_SIZE_MISMATCH'],
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, { type: 'write', range: 'Nope!A1', values: [[1]] }, 'SHEET_NOT_FOUND'],
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, { type: 'append', sheet: 'Sheet1', rows: [[1], [1, 2]] }, 'INVALID_VALUE'],
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, { type: 'clear', range: 'bogus' }, 'INVALID_RANGE'],
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, { type: 'explode' }, 'BAD_REQUEST'],
    [{ type: 'write', range: 'Sheet1!A1', values: [[1]] }, 'str', 'BAD_REQUEST']
  ];
  for (const [a, b, code] of cases) {
    assert.equal(call('batch.update', { operations: [a, b] }).error.code, code, code);
  }
  assert.equal(JSON.stringify(sheet('Sheet1').data), before);
  assert.equal(sb.sheetsFake.writes, 0);
});

test('batch.update: limits (50 ops, 50 000 cells) and allowFormulas applies to all ops', () => {
  const { sb, call, sheet } = setup('write', { S: { values: [[1]], maxRows: 40000, maxColumns: 4 } });
  const op = { type: 'clear', range: 'S!A1' };
  assert.equal(call('batch.update', { operations: Array(50).fill(op) }).ok, true);
  assert.equal(call('batch.update', { operations: Array(51).fill(op) }).error.code, 'LIMIT_EXCEEDED');
  assert.equal(call('batch.update', { operations: [] }).error.code, 'BAD_REQUEST');
  const big = (r) => ({ type: 'write', range: `S!A${r}`, values: Array.from({ length: 10000 }, () => [1, 2]) });
  assert.equal(call('batch.update', { operations: [big(1), big(1), big(1)] }).error.code, 'LIMIT_EXCEEDED'); // 60 000
  assert.equal(call('batch.update', { operations: [big(1), big(1)] }).ok, true); // 40 000
  const writesBefore = sb.sheetsFake.writes;
  const f = call('batch.update', { operations: [{ type: 'write', range: 'S!C1', values: [['=1+2']] }], allowFormulas: true });
  assert.equal(f.ok, true);
  assert.equal(sheet('S').getRange('C1').getValues()[0][0], 3);
  assert.equal(sb.sheetsFake.writes, writesBefore + 1);
});

test('formula rule: leading +, -, @ rejected unless numeric', () => {
  const f = createSandbox().ctx.looksLikeFormula_;
  assert.equal(f('=SUM(A1)'), true);
  assert.equal(f('+SUM(A1)'), true);
  assert.equal(f('-cmd'), true);
  assert.equal(f('@x'), true);
  assert.equal(f('-5'), false);
  assert.equal(f('+1.5'), false);
  assert.equal(f('hello'), false);
});
