'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox } = require('./harness');

const { ctx } = createSandbox();
const code = (fn) => { try { fn(); } catch (e) { return e.asmcpCode; } return null; };

test('column letter <-> number', () => {
  assert.equal(ctx.colToNum_('A'), 1);
  assert.equal(ctx.colToNum_('Z'), 26);
  assert.equal(ctx.colToNum_('aa'), 27);
  assert.equal(ctx.colToNum_('ZZZ'), 18278);
  assert.equal(ctx.numToCol_(1), 'A');
  assert.equal(ctx.numToCol_(26), 'Z');
  assert.equal(ctx.numToCol_(27), 'AA');
  assert.equal(ctx.numToCol_(702), 'ZZ');
  assert.equal(ctx.numToCol_(703), 'AAA');
  for (let n = 1; n <= 18278; n += 37) assert.equal(ctx.colToNum_(ctx.numToCol_(n)), n);
  assert.equal(code(() => ctx.numToCol_(0)), 'INVALID_RANGE');
  assert.equal(code(() => ctx.colToNum_('AAAA')), 'INVALID_RANGE');
});

test('parse all four range forms', () => {
  const p = (s) => JSON.parse(JSON.stringify(ctx.parseA1_(s)));
  assert.deepEqual(p('Sheet1!A1'), { sheet: 'Sheet1', kind: 'cell', r1: 1, c1: 1, r2: 1, c2: 1 });
  assert.deepEqual(p('Sheet1!B2:D5'), { sheet: 'Sheet1', kind: 'range', r1: 2, c1: 2, r2: 5, c2: 4 });
  assert.deepEqual(p('Sheet1!D5:B2'), { sheet: 'Sheet1', kind: 'range', r1: 2, c1: 2, r2: 5, c2: 4 });
  assert.deepEqual(p('Sheet1!A:C'), { sheet: 'Sheet1', kind: 'cols', r1: 1, c1: 1, r2: null, c2: 3 });
  assert.deepEqual(p('Sheet1!2:5'), { sheet: 'Sheet1', kind: 'rows', r1: 2, c1: 1, r2: 5, c2: null });
});

test('quoted sheet names with escaped quotes', () => {
  assert.equal(ctx.parseA1_("'My Sheet'!A:C").sheet, 'My Sheet');
  assert.equal(ctx.parseA1_("'Bob''s data'!A1:B2").sheet, "Bob's data");
  assert.equal(ctx.parseA1_("'A!B'!A1").sheet, 'A!B');
  assert.equal(ctx.formatA1_("Bob's data", 1, 1, 2, 2), "'Bob''s data'!A1:B2");
  assert.equal(ctx.formatA1_('Sheet1', 3, 2, 3, 2), 'Sheet1!B3');
  assert.equal(ctx.formatA1_('A1', 1, 1, 1, 1), "'A1'!A1");
});

test('rejects malformed ranges', () => {
  for (const bad of ['A1:B2', 'Sheet1!', 'Sheet1!A', 'Sheet1!A1:B', 'Sheet1!0:3', 'Sheet1!A0', "'Open!A1", "'x'A1", 'Sheet1!A1:B2:C3', '', 'Sheet1!1A', "it's!A1"]) {
    assert.equal(code(() => ctx.parseA1_(bad)), 'INVALID_RANGE', bad);
  }
  assert.equal(code(() => ctx.parseA1_(42)), 'INVALID_RANGE');
});
