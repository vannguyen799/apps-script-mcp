'use strict';
// Script evaluation (DESIGN.md section 8): opt-in, owner-gated, audited by hash only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandbox } = require('./harness');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function setup({ enabled = true } = {}) {
  const sb = createSandbox();
  const client = sb.pairClient();
  if (enabled) sb.ctx.admin_setEvalEnabled(true);
  const run = (code, args) => client.call('script.eval', args === undefined ? { code } : { code, args });
  return { sb, client, run };
}

// ------------------------------------------------------------ off by default, owner-only toggle

test('disabled by default: EVAL_DISABLED and the code is not executed', () => {
  const { sb, run } = setup({ enabled: false });
  const r = run('globalThis.__ran = true; return 1;');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'EVAL_DISABLED');
  assert.equal(r.sigValid, true);
  assert.equal(sb.ctx.__ran, undefined);
  assert.equal(sb.props.has('asmcp.evalAudit'), false);
  // Disabled wins over a malformed request.
  assert.equal(setup({ enabled: false }).run(42).error.code, 'EVAL_DISABLED');
});

test('an explicit disable turns it off again; a corrupt property means disabled', () => {
  const { sb, run } = setup();
  assert.equal(run('return 1').ok, true);
  sb.ctx.admin_setEvalEnabled(false);
  assert.equal(run('return 1').error.code, 'EVAL_DISABLED');
  sb.props.set('asmcp.eval', '{"enabled":"true"}'); // not a literal true
  assert.equal(run('return 1').error.code, 'EVAL_DISABLED');
  sb.props.set('asmcp.eval', 'not json');
  assert.equal(run('return 1').error.code, 'EVAL_DISABLED');
});

test('admin_setEvalEnabled is owner-gated: anonymous and other accounts cannot toggle', () => {
  for (const activeEmail of ['', 'intruder@example.com']) {
    const sb = createSandbox({ activeEmail });
    assert.throws(() => sb.ctx.admin_setEvalEnabled(true), /ACCESS_DENIED/);
    assert.throws(() => sb.ctx.admin_getEvalAudit(), /ACCESS_DENIED/);
    assert.equal(sb.props.has('asmcp.eval'), false);
  }
  const sb = createSandbox();
  const res = sb.ctx.admin_setEvalEnabled(true);
  assert.equal(res.evalEnabled, true);
  assert.match(res.evalChangedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(JSON.parse(sb.props.get('asmcp.eval')), { enabled: true, changedAt: res.evalChangedAt });
  const st = sb.ctx.admin_getState();
  assert.equal(st.evalEnabled, true);
  assert.equal(st.evalChangedAt, res.evalChangedAt);
  assert.throws(() => sb.ctx.admin_setEvalEnabled('true'), /true hoặc false/);
  assert.throws(() => sb.ctx.admin_setEvalEnabled(undefined), /true hoặc false/);
});

test('the wire cannot enable eval: no action toggles it, and the HMAC client stays locked out', () => {
  const { sb, client } = setup({ enabled: false });
  for (const action of ['admin_setEvalEnabled', 'eval.enable', 'script.enable']) {
    assert.equal(client.call(action, { enabled: true }).error.code, 'UNKNOWN_ACTION');
  }
  assert.equal(client.call('script.eval', { code: 'return 1', enabled: true }).error.code, 'EVAL_DISABLED');
  assert.equal(sb.props.has('asmcp.eval'), false);
});

test('ping reports evalEnabled', () => {
  const { sb, client } = setup({ enabled: false });
  assert.equal(client.call('ping').result.evalEnabled, false);
  sb.ctx.admin_setEvalEnabled(true);
  assert.equal(client.call('ping').result.evalEnabled, true);
  sb.ctx.admin_setEvalEnabled(false);
  assert.equal(client.call('ping').result.evalEnabled, false);
});

test('the admin page has the eval section', () => {
  const html = createSandbox().ctx.doGet({}).getContent();
  assert.match(html, /Chạy Apps Script \(nâng cao\)/);
  assert.match(html, /admin_setEvalEnabled/);
  assert.match(html, /admin_getEvalAudit/);
  assert.match(html, /prompt injection/);
});

// ------------------------------------------------------------ running code

test('returns the value, passes args and log, and reports durationMs', () => {
  const { run } = setup();
  const r = run('return { sum: args.a + args.b, list: [1, "x", null], typeofLog: typeof log };', { a: 2, b: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.sigValid, true);
  assert.deepEqual(r.result.value, { sum: 42, list: [1, 'x', null], typeofLog: 'function' });
  assert.deepEqual(r.result.logs, []);
  assert.equal(typeof r.result.durationMs, 'number');
  assert.ok(r.result.durationMs >= 0);
  assert.equal(run('return args;').result.value, null); // args omitted -> undefined -> null
  assert.deepEqual(run('return args;', [1, { a: 2 }]).result.value, [1, { a: 2 }]);
});

test('undefined becomes null and Date becomes an ISO string', () => {
  const { run } = setup();
  assert.equal(run('return;').result.value, null);
  assert.equal(run('return undefined;').result.value, null);
  assert.equal(run('return function () {};').result.value, null);
  assert.equal(run('return new Date(0);').result.value, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(run('return { d: new Date(86400000), u: undefined, n: NaN };').result.value, { d: '1970-01-02T00:00:00.000Z', n: null });
});

test('evaluated code runs inside the sandbox context and sees the mocked services', () => {
  const { sb, run } = setup();
  const s = sb.addSpreadsheet({ name: 'Secret sheet', sheets: { Sheet1: [['a', 'b'], [1, 2]] } }); // NOT allowlisted: eval bypasses it
  const r = run(
    'var ss = SpreadsheetApp.openById(args.id);' +
    'return { name: ss.getName(), values: ss.getSheetByName("Sheet1").getRange("A1:B2").getValues(),' +
    ' hasProps: typeof PropertiesService, fnRealm: (function () {}).constructor === Function, arrRealm: [] instanceof Array };',
    { id: s.id });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result.value, { name: 'Secret sheet', values: [['a', 'b'], [1, 2]], hasProps: 'object', fnRealm: true, arrRealm: true });
  assert.deepEqual(sb.sheetsFake.opened, [s.id]);
  // The constructor `new Function` resolves to is the sandbox's own, not the test runner's.
  const sandboxFunction = vm.runInContext('Function', sb.ctx);
  assert.notEqual(sandboxFunction, Function);
  assert.equal(run('return 1;').ok, true);
  assert.equal(vm.runInContext('(function () {}).constructor', sb.ctx), sandboxFunction);
  // A global set by evaluated code lands in the sandbox, never in the test process.
  run('globalThis.__marker = 7; return 0;');
  assert.equal(sb.ctx.__marker, 7);
  assert.equal(globalThis.__marker, undefined);
  // Unknown globals fail inside the sandbox as an EVAL_ERROR, not as INTERNAL.
  assert.equal(run('return process.version;').error.code, 'EVAL_ERROR');
  assert.match(run('return require("fs");').error.message, /^ReferenceError: require is not defined/);
});

test('log(): parts are stringified, objects become JSON, lines and line length are capped', () => {
  const { run } = setup();
  const r = run(
    'log("a", 1, true, null, undefined, { k: [1, 2] });' +
    'var loop = {}; loop.self = loop; log("circular", loop);' +
    'log("x".repeat(5000));' +
    'log();' +
    'return 1;');
  assert.equal(r.ok, true);
  assert.equal(r.result.logs[0], 'a 1 true null undefined {"k":[1,2]}');
  assert.equal(r.result.logs[1], 'circular [object Object]');
  assert.equal(r.result.logs[2].length, 2000);
  assert.equal(r.result.logs[3], '');
  assert.equal(r.result.logs.length, 4);

  const many = run('for (var i = 0; i < 500; i++) log("line " + i); return i;');
  assert.equal(many.result.value, 500); // extra log calls are dropped, not errors
  assert.equal(many.result.logs.length, 200);
  assert.equal(many.result.logs[0], 'line 0');
  assert.equal(many.result.logs[199], 'line 199');
});

test('a thrown error gives EVAL_ERROR "Name: message" with the logs so far', () => {
  const { run } = setup();
  const r = run('log("before"); log({ a: 1 }); null.boom; log("never"); return 1;');
  assert.equal(r.ok, false);
  assert.equal(r.sigValid, true);
  assert.equal(r.error.code, 'EVAL_ERROR');
  assert.match(r.error.message, /^TypeError: /);
  assert.deepEqual(r.error.logs, ['before', '{"a":1}']);

  const custom = run('var e = new RangeError("out of " + args); throw e;', 'range');
  assert.equal(custom.error.message, 'RangeError: out of range');
  assert.deepEqual(custom.error.logs, []);

  assert.equal(run('throw "just a string";').error.message, 'Error: just a string');
  assert.equal(run('throw null;').error.message, 'Error: null');
  assert.equal(run('throw { message: "m", name: "Custom" };').error.message, 'Custom: m');

  const syntax = run('return (;');
  assert.equal(syntax.error.code, 'EVAL_ERROR');
  assert.match(syntax.error.message, /^SyntaxError: /);

  const long = run('throw new Error("y".repeat(9000));');
  assert.equal(long.error.message.length, 2000);

  // A thrown object cannot smuggle an error code or logs past the handler.
  const forged = run('var e = new Error("x"); e.asmcpCode = "UNAUTHENTICATED"; e.asmcpLogs = ["forged"]; throw e;');
  assert.equal(forged.error.code, 'EVAL_ERROR');
  assert.deepEqual(forged.error.logs, []);
});

test('a value that cannot be serialized gives EVAL_ERROR, keeping the logs', () => {
  const { run } = setup();
  const circular = run('log("hi"); var o = {}; o.o = o; return o;');
  assert.equal(circular.error.code, 'EVAL_ERROR');
  assert.equal(circular.error.message, 'Return value is not JSON-serializable');
  assert.deepEqual(circular.error.logs, ['hi']);
  assert.equal(run('return 10n;').error.message, 'Return value is not JSON-serializable');
  assert.equal(run('return { toJSON: function () { throw new Error("no"); } };').error.message, 'Return value is not JSON-serializable');
});

test('size limits: serialized value <= 4 MB, code <= 100000 chars', () => {
  const { run } = setup();
  const edge = 4 * 1024 * 1024 - 2; // + the two quotes = exactly 4 MB
  const atLimit = run('return "x".repeat(args);', edge);
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.result.value.length, edge);
  const over = run('log("kept"); return "x".repeat(args);', edge + 1);
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'LIMIT_EXCEEDED');
  assert.equal(over.error.logs, undefined); // only EVAL_ERROR carries logs

  const pad = 'return 1;';
  assert.equal(run(pad + ' '.repeat(100000 - pad.length)).ok, true);
  assert.equal(run(pad + ' '.repeat(100001 - pad.length)).error.code, 'LIMIT_EXCEEDED');
  for (const bad of [undefined, '', 5, null, ['return 1']]) {
    assert.equal(run(bad).error.code, 'BAD_REQUEST', String(bad));
  }
});

// ------------------------------------------------------------ audit

test('the audit entry holds a hash only: never code, args, results or messages', () => {
  const { sb, run } = setup();
  const code = 'log("LOG-SECRET"); return { leak: "RESULT-SECRET", arg: args };';
  run(code, 'ARG-SECRET');
  const bad = 'throw new Error("ERR-SECRET");';
  run(bad);
  const unserializable = 'var o = {}; o.o = o; return o;';
  run(unserializable);

  const audit = sb.ctx.admin_getEvalAudit();
  assert.equal(audit.length, 3);
  // newest first
  assert.equal(audit[2].codeSha256, sha256(code));
  assert.equal(audit[1].codeSha256, sha256(bad));
  assert.equal(audit[0].codeSha256, sha256(unserializable));
  assert.deepEqual(Object.keys(audit[2]).sort(), ['at', 'codeSha256', 'durationMs', 'ok']);
  assert.equal(audit[2].ok, true);
  assert.equal(audit[1].ok, false);
  assert.equal(audit[1].errorName, 'Error');
  assert.equal(audit[0].errorName, 'NotSerializable');
  assert.match(audit[2].at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(typeof audit[2].durationMs, 'number');

  const everything = JSON.stringify([...sb.props.entries()]) + JSON.stringify(sb.ctx.admin_getState()) + JSON.stringify(audit);
  for (const secret of ['LOG-SECRET', 'RESULT-SECRET', 'ARG-SECRET', 'ERR-SECRET', 'return {', 'throw new']) {
    assert.equal(everything.includes(secret), false, secret);
  }
  // Nothing about eval is written to the script log either.
  assert.equal(JSON.stringify(sb.logs).includes('SECRET'), false);
});

test('a hostile error name is sanitized and cannot grow the audit entry', () => {
  const { sb, run } = setup();
  const r = run('var e = new Error("m"); e.name = args; throw e;', '<b>evil name</b>' + 'Z'.repeat(500));
  assert.equal(r.error.code, 'EVAL_ERROR');
  const [entry] = sb.ctx.admin_getEvalAudit();
  assert.equal(entry.errorName, 'bevilnamebZ'.padEnd(32, 'Z'));
  assert.equal(entry.errorName.length, 32);
});

test('the audit ring buffer keeps the last 50 entries', () => {
  const { sb, run } = setup();
  for (let i = 0; i < 55; i++) assert.equal(run(`return ${i};`).ok, true);
  const audit = sb.ctx.admin_getEvalAudit();
  assert.equal(audit.length, 50);
  assert.equal(audit[0].codeSha256, sha256('return 54;')); // newest first
  assert.equal(audit[49].codeSha256, sha256('return 5;')); // 0..4 were dropped
  assert.equal(JSON.parse(sb.props.get('asmcp.evalAudit')).length, 50);
});

test('the audit buffer stays within the property size limit even when every run fails with a long name', () => {
  const { sb, run } = setup();
  for (let i = 0; i < 60; i++) {
    const r = run(`var e = new Error("m"); e.name = "N".repeat(100); throw e; // ${i}`);
    assert.equal(r.error.code, 'EVAL_ERROR'); // not INTERNAL: the audit write never breaks a run
  }
  const raw = sb.props.get('asmcp.evalAudit');
  assert.ok(raw.length <= 9000);
  const audit = sb.ctx.admin_getEvalAudit();
  assert.ok(audit.length <= 50 && audit.length >= 30);
  assert.equal(audit[0].codeSha256, sha256('var e = new Error("m"); e.name = "N".repeat(100); throw e; // 59'));
});

test('disabled and malformed calls leave no audit entry; replays are still rejected', () => {
  const { sb, client, run } = setup({ enabled: false });
  run('return 1');
  sb.ctx.admin_setEvalEnabled(true);
  run(42);
  assert.equal(sb.props.has('asmcp.evalAudit'), false);
  const nonce = 'A'.repeat(22);
  assert.equal(client.call('script.eval', { code: 'return 1' }, { nonce }).ok, true);
  assert.equal(client.call('script.eval', { code: 'return 1' }, { nonce }).error.code, 'REPLAYED');
  assert.equal(sb.ctx.admin_getEvalAudit().length, 1);
});

// ------------------------------------------------------------ manifests

test('manifests: the default one stays minimal, the full example is valid and a superset', () => {
  const root = path.join(__dirname, '..');
  const base = JSON.parse(fs.readFileSync(path.join(root, 'src', 'appsscript.json'), 'utf8'));
  const full = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.full.example.json'), 'utf8'));
  assert.deepEqual(base.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email'
  ]);
  for (const s of base.oauthScopes) assert.ok(full.oauthScopes.includes(s), s);
  for (const short of ['documents', 'drive', 'gmail.readonly', 'calendar', 'script.external_request']) {
    assert.ok(full.oauthScopes.includes(`https://www.googleapis.com/auth/${short}`), short);
  }
  assert.deepEqual({ ...full, oauthScopes: null }, { ...base, oauthScopes: null }); // same web app settings
});
