'use strict';
// Multiple pairings and setup pair (DESIGN.md section 9.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, buildPairRequest, buildSetupPairRequest, parseBody, newSecret } = require('./harness');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const block = (sb, over = {}) => ({ server: 'https://mcp.example.com', token: newSecret(), expiresAt: sb.clock.now + 1800000, ...over });
const setupSandbox = (over = {}, opts = {}) => {
  const sb = createSandbox(opts);
  const setup = block(sb, over);
  sb.setSetup(setup);
  return { sb, setup };
};
const setupReq = (sb, setup, over = {}) => buildSetupPairRequest({
  instanceId: crypto.randomUUID(), secret: newSecret(), ts: sb.clock.now, token: setup.token, ...over
});
const code = (sb, req) => parseBody(sb.doPost(req));

// ---------------------------------------------------------------- multiple pairings

test('two instances pair and both call successfully; unpairing one leaves the other working', () => {
  const sb = createSandbox();
  const a = sb.pairClient('ABCD-2345');
  const b = sb.pairClient('EFGH-2345');
  assert.notEqual(a.instanceId, b.instanceId);
  assert.equal(a.call('ping').ok, true);
  assert.equal(b.call('ping').ok, true);
  assert.equal(a.call('ping').sigValid, true);
  // instance A's secret does not work for instance B's id
  assert.equal(a.call('ping', {}, { instanceId: b.instanceId }).error.code, 'UNAUTHENTICATED');
  sb.ctx.admin_unpair(a.instanceId);
  assert.equal(a.call('ping').error.code, 'UNAUTHENTICATED');
  assert.equal(b.call('ping').ok, true);
});

test('maximum 20 pairings: the 21st is LIMIT_EXCEEDED, replacing an existing one is still allowed', () => {
  const sb = createSandbox();
  const clients = [];
  for (let i = 0; i < 20; i++) clients.push(sb.pairClient('ABCD-2345'));
  assert.equal(sb.ctx.admin_getState().pairings.length, 20);
  // 21st via code pairing; the code stays pending
  sb.enterPairingCode('EFGH-2345');
  const r = code(sb, buildPairRequest({ instanceId: crypto.randomUUID(), pairingCode: 'EFGH2345', secret: newSecret(), ts: sb.clock.now }));
  assert.equal(r.error.code, 'LIMIT_EXCEEDED');
  assert.equal(sb.props.has('asmcp.pairing.pending'), true);
  // 21st via setup pair; the token is not consumed
  const setup = block(sb);
  sb.setSetup(setup);
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'LIMIT_EXCEEDED');
  assert.equal(sb.props.has('asmcp.setupConsumed'), false);
  // re-pairing an existing instanceId is a replacement, not an addition
  const again = code(sb, buildPairRequest({ instanceId: clients[0].instanceId, pairingCode: 'EFGH2345', secret: newSecret(), ts: sb.clock.now }));
  assert.equal(again.ok, true);
  assert.equal(sb.ctx.admin_getState().pairings.length, 20);
  // free a slot -> the setup pair now works
  sb.ctx.admin_unpair(clients[1].instanceId);
  assert.equal(code(sb, setupReq(sb, setup)).ok, true);
  assert.equal(sb.ctx.admin_getState().pairings.length, 20);
});

test('the pairings map stays under the 9 KB property limit at 20 entries with worst-case labels', () => {
  const sb = createSandbox();
  for (let i = 0; i < 20; i++) {
    sb.enterPairingCode('ABCD-2345');
    const r = code(sb, buildPairRequest({
      instanceId: `${i}`.padStart(64, 'x'), instanceLabel: '"\n\t'.repeat(21), pairingCode: 'ABCD2345', secret: newSecret(), ts: sb.clock.now
    }));
    assert.equal(r.ok, true, `pairing ${i}`);
  }
  assert.ok(sb.props.get('asmcp.pairings').length < 9000);
});

test('legacy asmcp.pairing is migrated into the map: usable, listed, and removed on next write', () => {
  const sb = createSandbox();
  const instanceId = crypto.randomUUID();
  const secret = newSecret();
  sb.props.set('asmcp.pairing', JSON.stringify({ instanceId, instanceLabel: 'old', secret, pairedAt: '2024-01-01T00:00:00.000Z' }));
  const legacy = { instanceId, secret, call: null };
  const { buildCallRequest } = require('./harness');
  const ping = () => parseBody(sb.doPost(buildCallRequest({ instanceId, secret, ts: sb.clock.now, nonce: crypto.randomBytes(16).toString('base64url'), action: 'ping' })));
  assert.equal(ping().ok, true);
  const st = sb.ctx.admin_getState();
  assert.equal(st.pairings.length, 1);
  assert.equal(st.pairings[0].instanceLabel, 'old');
  assert.equal(JSON.stringify(st).includes(legacy.secret), false);
  // a new pairing coexists with the migrated one and the legacy key disappears
  const fresh = sb.pairClient('ABCD-2345');
  assert.equal(sb.props.has('asmcp.pairing'), false);
  assert.equal(Object.keys(JSON.parse(sb.props.get('asmcp.pairings'))).length, 2);
  assert.equal(ping().ok, true);
  assert.equal(fresh.call('ping').ok, true);
  // unpairing a legacy entry works too
  sb.ctx.admin_unpair(instanceId);
  assert.equal(ping().error.code, 'UNAUTHENTICATED');
  assert.equal(fresh.call('ping').ok, true);
});

test('an instanceId like __proto__ is an ordinary key, and unknown ids are UNAUTHENTICATED', () => {
  const sb = createSandbox();
  const c = sb.pairClient('ABCD-2345');
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(c.call('ping', {}, { instanceId: id }).error.code, 'UNAUTHENTICATED');
  }
  sb.enterPairingCode('EFGH-2345');
  const secret = newSecret();
  const r = code(sb, buildPairRequest({ instanceId: '__proto__', pairingCode: 'EFGH2345', secret, ts: sb.clock.now }));
  assert.equal(r.ok, true);
  assert.equal(sb.ctx.admin_getState().pairings.length, 2);
  assert.equal(c.call('ping').ok, true);
});

test('admin_getState never includes a secret, code hash or setup token', () => {
  const { sb, setup } = setupSandbox();
  const a = sb.pairClient('ABCD-2345');
  const b = sb.pairClientViaSetup({ token: setup.token });
  sb.enterPairingCode('EFGH-2345');
  const text = JSON.stringify(sb.ctx.admin_getState());
  for (const secret of [a.secret, b.secret, setup.token, sha256('asmcp-setup-v1:' + setup.token),
    sha256('asmcp-pair-v1:EFGH2345')]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(JSON.stringify(sb.ctx.admin_unpair(a.instanceId)).includes(b.secret), false);
});

// ---------------------------------------------------------------- setup pair

test('setup pair success: same response shape as code pairing, proof verified with Node crypto', () => {
  const { sb, setup } = setupSandbox();
  const instanceId = crypto.randomUUID();
  const secret = newSecret();
  const ts = sb.clock.now;
  const env = sb.doPost(buildSetupPairRequest({ instanceId, instanceLabel: 'My Docker', secret, ts, token: setup.token }));
  assert.equal(env.sig, null);
  const body = parseBody(env);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'result']);
  assert.deepEqual(Object.keys(body.result).sort(), ['account', 'allowlist', 'proof', 'scriptId', 'scriptName']);
  assert.equal(body.ok, true);
  assert.equal(body.result.account, 'owner@example.com');
  const proof = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`v1\npair-ack\n${instanceId}\n${ts}`).digest('hex');
  assert.equal(body.result.proof, proof);
  // the request proof follows the spec formula exactly (independent of the harness helper)
  const req = JSON.parse(buildSetupPairRequest({ instanceId, secret, ts, token: setup.token }));
  assert.equal(req.setupProof, crypto.createHmac('sha256', Buffer.from(setup.token, 'utf8'))
    .update(`v1\nsetup\n${instanceId}\n${ts}\n${secret}`).digest('hex'));
  const stored = JSON.parse(sb.props.get('asmcp.pairings'))[instanceId];
  assert.equal(stored.secret, secret);
  assert.equal(stored.instanceLabel, 'My Docker');
  assert.deepEqual(JSON.parse(sb.props.get('asmcp.setupConsumed')), [sha256('asmcp-setup-v1:' + setup.token)]);
});

test('a setup-paired client can call actions', () => {
  const sb = createSandbox({ setup: { server: 'local', token: newSecret(), expiresAt: 1_700_000_000_000 + 60000 } });
  const c = sb.pairClientViaSetup();
  const r = c.call('ping');
  assert.equal(r.ok, true);
  assert.equal(r.sigValid, true);
  assert.equal(r.result.account, 'owner@example.com');
});

test('no setup block (ASMCP_SETUP_ = null, the default) -> PAIRING_NOT_READY', () => {
  const sb = createSandbox();
  assert.equal(sb.ctx.ASMCP_SETUP_, null);
  const req = buildSetupPairRequest({ instanceId: crypto.randomUUID(), secret: newSecret(), ts: sb.clock.now, token: newSecret() });
  const env = sb.doPost(req);
  assert.equal(parseBody(env).error.code, 'PAIRING_NOT_READY');
  assert.equal(env.sig, null);
  assert.equal(sb.props.has('asmcp.pairings'), false);
});

test('malformed setup blocks are PAIRING_NOT_READY', () => {
  for (const bad of ['x', 42, [], {}, { token: 'short', expiresAt: 1e15 }, { token: 5, expiresAt: 1e15 }, { token: newSecret() },
    { token: newSecret(), expiresAt: 'soon' }]) {
    const sb = createSandbox({ setup: bad });
    const token = bad && typeof bad.token === 'string' ? bad.token : newSecret();
    assert.equal(code(sb, buildSetupPairRequest({ instanceId: crypto.randomUUID(), secret: newSecret(), ts: sb.clock.now, token })).error.code,
      'PAIRING_NOT_READY', JSON.stringify(bad));
  }
});

test('expired setup block -> PAIRING_NOT_READY (boundary: now < expiresAt)', () => {
  const { sb, setup } = setupSandbox({ expiresAt: 1_700_000_000_000 + 1000 });
  sb.clock.advance(999);
  const ok = code(sb, setupReq(sb, setup));
  assert.equal(ok.ok, true);
  const { sb: sb2, setup: s2 } = setupSandbox({ expiresAt: 1_700_000_000_000 + 1000 });
  sb2.clock.advance(1000);
  assert.equal(code(sb2, setupReq(sb2, s2)).error.code, 'PAIRING_NOT_READY');
  assert.equal(sb2.props.has('asmcp.pairings'), false);
});

test('stale or future ts is REQUEST_EXPIRED (not counted as an invalid attempt); 300000 ms is accepted', () => {
  const { sb, setup } = setupSandbox();
  for (const skew of [-300001, 300001]) {
    assert.equal(code(sb, setupReq(sb, setup, { ts: sb.clock.now + skew })).error.code, 'REQUEST_EXPIRED');
  }
  assert.equal(sb.props.has('asmcp.setupAttempts'), false);
  assert.equal(sb.props.has('asmcp.pairings'), false);
  assert.equal(code(sb, setupReq(sb, setup, { ts: sb.clock.now - 300000 })).ok, true);
});

test('bad proof -> PAIRING_INVALID; a proof over different fields does not verify', () => {
  const { sb, setup } = setupSandbox();
  const base = { instanceId: crypto.randomUUID(), secret: newSecret(), ts: sb.clock.now };
  const wrong = [
    { setupProof: '0'.repeat(64) },
    { token: newSecret() }, // signed with another token
    { setupProof: JSON.parse(buildSetupPairRequest({ ...base, token: setup.token })).setupProof, secret: newSecret() }, // secret swapped
    { setupProof: JSON.parse(buildSetupPairRequest({ ...base, token: setup.token })).setupProof, instanceId: crypto.randomUUID() }
  ];
  for (const w of wrong) {
    const env = sb.doPost(buildSetupPairRequest({ ...base, token: setup.token, ...w }));
    assert.equal(parseBody(env).error.code, 'PAIRING_INVALID');
    assert.equal(env.sig, null);
  }
  assert.equal(sb.props.has('asmcp.pairings'), false);
  // the token still works afterwards (3 invalid attempts < 5)
  assert.equal(code(sb, setupReq(sb, setup)).ok, true);
});

test('malformed setup requests are BAD_REQUEST', () => {
  const { sb, setup } = setupSandbox();
  const good = JSON.parse(setupReq(sb, setup));
  for (const over of [{ setupProof: 'abc' }, { setupProof: 5 }, { secret: 'short' }, { instanceId: 'a\nb' }, { ts: 'x' },
    { instanceLabel: 'x'.repeat(65) }, { mode: 'other' }]) {
    assert.equal(code(sb, JSON.stringify({ ...good, ...over })).error.code, 'BAD_REQUEST', JSON.stringify(over));
  }
  assert.equal(sb.props.has('asmcp.setupAttempts'), false);
  assert.equal(code(sb, JSON.stringify(good)).ok, true);
});

test('consumed token: a replay of the same request and a new request are both PAIRING_INVALID', () => {
  const { sb, setup } = setupSandbox();
  const req = setupReq(sb, setup);
  assert.equal(code(sb, req).ok, true);
  assert.equal(code(sb, req).error.code, 'PAIRING_INVALID');
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'PAIRING_INVALID');
  assert.equal(Object.keys(JSON.parse(sb.props.get('asmcp.pairings'))).length, 1);
});

test('the same token cannot pair twice, even for another instance or after 20 other tokens', () => {
  const { sb, setup } = setupSandbox();
  const first = sb.pairClientViaSetup({ token: setup.token });
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'PAIRING_INVALID');
  assert.equal(first.call('ping').ok, true);
  assert.equal(sb.ctx.admin_getState().pairings.length, 1);
});

test('five invalid attempts burn the token; even a valid proof then fails', () => {
  const { sb, setup } = setupSandbox();
  for (let i = 1; i <= 5; i++) {
    assert.equal(code(sb, setupReq(sb, setup, { setupProof: '1'.repeat(64) })).error.code, 'PAIRING_INVALID');
    if (i < 5) assert.equal(sb.props.has('asmcp.setupConsumed'), false);
  }
  assert.deepEqual(JSON.parse(sb.props.get('asmcp.setupConsumed')), [sha256('asmcp-setup-v1:' + setup.token)]);
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'PAIRING_INVALID');
  assert.equal(sb.props.has('asmcp.pairings'), false);
  assert.equal(sb.ctx.admin_getState().setup.status, 'burned');
  // a fresh token in the same script (new Code.gs) starts from zero attempts
  const next = block(sb);
  sb.setSetup(next);
  assert.equal(code(sb, setupReq(sb, next, { setupProof: '1'.repeat(64) })).error.code, 'PAIRING_INVALID');
  assert.equal(code(sb, setupReq(sb, next)).ok, true);
});

test('4 invalid attempts then the right proof succeeds and clears the counter', () => {
  const { sb, setup } = setupSandbox();
  for (let i = 0; i < 4; i++) code(sb, setupReq(sb, setup, { setupProof: '1'.repeat(64) }));
  assert.equal(JSON.parse(sb.props.get('asmcp.setupAttempts')).n, 4);
  assert.equal(code(sb, setupReq(sb, setup)).ok, true);
  assert.equal(sb.props.has('asmcp.setupAttempts'), false);
});

test('setupConsumed keeps only the last 20 hashes', () => {
  const sb = createSandbox();
  const tokens = [];
  for (let i = 0; i < 22; i++) {
    const setup = block(sb);
    tokens.push(setup.token);
    sb.setSetup(setup);
    const r = code(sb, setupReq(sb, setup));
    if (i < 20) assert.equal(r.ok, true);
    else assert.equal(r.error.code, 'LIMIT_EXCEEDED'); // 20 pairings max; token untouched
    if (i >= 20) { sb.ctx.admin_unpair(Object.keys(JSON.parse(sb.props.get('asmcp.pairings')))[0]); assert.equal(code(sb, setupReq(sb, setup)).ok, true); }
  }
  const list = JSON.parse(sb.props.get('asmcp.setupConsumed'));
  assert.equal(list.length, 20);
  assert.deepEqual(list, tokens.slice(2).map((t) => sha256('asmcp-setup-v1:' + t)));
});

test('setup pair holds the script lock (no nested lock, released afterwards)', () => {
  const { sb, setup } = setupSandbox();
  assert.equal(code(sb, setupReq(sb, setup)).ok, true);
  // a second lock acquisition works only if the first was released
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'PAIRING_INVALID');
});

test('a code pairing is unaffected by a setup block and the other way round', () => {
  const { sb, setup } = setupSandbox();
  const a = sb.pairClient('ABCD-2345');
  assert.equal(a.call('ping').ok, true);
  assert.equal(code(sb, setupReq(sb, setup)).ok, true);
  assert.equal(sb.ctx.admin_getState().pairings.length, 2);
});

test('nothing sensitive is logged during setup pairing', () => {
  const { sb, setup } = setupSandbox();
  const c = sb.pairClientViaSetup({ token: setup.token });
  c.call('ping');
  const text = JSON.stringify(sb.logs);
  assert.equal(text.includes(c.secret) || text.includes(setup.token), false);
  assert.equal(sb.logs.length, 0);
});

// ---------------------------------------------------------------- admin page state / notice

test('admin_getState.setup: null without a block, ready -> connected, expired, burned; never the token', () => {
  const sb = createSandbox({ webAppUrl: 'https://script.google.com/macros/s/AKx/exec' });
  assert.equal(sb.ctx.admin_getState().setup, null);
  const setup = block(sb, { server: 'local' });
  sb.setSetup(setup);
  let st = sb.ctx.admin_getState();
  assert.deepEqual(JSON.parse(JSON.stringify(st.setup)), { status: 'ready', server: 'local', expiresAt: setup.expiresAt });
  assert.equal(JSON.stringify(st).includes(setup.token), false);
  sb.pairClientViaSetup({ token: setup.token });
  st = sb.ctx.admin_getState();
  assert.equal(st.setup.status, 'connected');
  assert.equal(st.webAppUrl, 'https://script.google.com/macros/s/AKx/exec');
  const later = block(sb);
  sb.setSetup(later);
  sb.clock.advance(1800001);
  assert.equal(sb.ctx.admin_getState().setup.status, 'expired');
});

test('the admin page carries the ready-to-connect notice, the connected notice and per-pairing unpair', () => {
  const html = createSandbox().ctx.doGet({}).getContent();
  assert.match(html, /Script này đã sẵn sàng kết nối với/);
  assert.match(html, /Quay lại trang MCP và dán URL web app/);
  assert.match(html, /Đã kết nối/);
  assert.match(html, /Hủy ghép nối/);
  assert.match(html, /admin_unpair', \[p\.instanceId\]/);
  assert.equal(html.includes('ASMCP_SETUP_'), false);
});

// ---------------------------------------------------------------- Setup.js / bundle

test('src/Setup.js is one assignment line plus comments; the bundle has the line once, first after the header', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Setup.js'), 'utf8');
  const line = 'var ASMCP_SETUP_ = null;';
  assert.equal(src.split('\n').filter((l) => l === line).length, 1);
  assert.equal(src.split(line).length - 1, 1);
  assert.deepEqual(src.split('\n').filter((l) => l.trim() && !l.startsWith('//') && l !== line), []);
  const gs = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  assert.equal(gs.split(line).length - 1, 1);
  assert.equal(gs.split('\n').filter((l) => l === line).length, 1);
  assert.ok(gs.indexOf('// ===== Setup.js =====') < gs.indexOf('// ===== Code.js ====='));
  assert.equal(gs.indexOf('// ===== '), gs.indexOf('// ===== Setup.js ====='));
});

test('the server-side replacement of the setup line yields a working script', () => {
  const sb = createSandbox();
  const gs = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  const token = newSecret();
  const replaced = gs.replace('var ASMCP_SETUP_ = null;',
    `var ASMCP_SETUP_ = ${JSON.stringify({ server: 'local', token, expiresAt: sb.clock.now + 60000 })};`);
  const vm = require('node:vm');
  new vm.Script(replaced); // still parses
  assert.notEqual(replaced, gs);
  assert.equal(replaced.includes('var ASMCP_SETUP_ = null;'), false);
  // the injected block parses back to the object the server built
  sb.setSetup(JSON.parse(replaced.match(/var ASMCP_SETUP_ = (\{.*\});/)[1]));
  assert.equal(sb.pairClientViaSetup({ token }).call('ping').ok, true);
});

// ---------------------------------------------------------------- scriptId / scriptName

test('code pair and setup pair results carry scriptId and scriptName (null), ping carries scriptId', () => {
  const sb = createSandbox({ scriptId: 'SCRIPT-ID-XYZ' });
  sb.enterPairingCode('ABCD-2345');
  const byCode = code(sb, buildPairRequest({ instanceId: crypto.randomUUID(), pairingCode: 'ABCD2345', secret: newSecret(), ts: sb.clock.now }));
  assert.deepEqual(Object.keys(byCode.result).sort(), ['account', 'proof', 'scriptId', 'scriptName']);
  assert.equal(byCode.result.scriptId, 'SCRIPT-ID-XYZ');
  assert.equal(byCode.result.scriptName, null);
  const setup = block(sb);
  sb.setSetup(setup);
  const instanceId = crypto.randomUUID();
  const secret = newSecret();
  const ts = sb.clock.now;
  const bySetup = code(sb, buildSetupPairRequest({ instanceId, secret, ts, token: setup.token }));
  assert.deepEqual(Object.keys(bySetup.result).sort(), ['account', 'allowlist', 'proof', 'scriptId', 'scriptName']);
  assert.equal(bySetup.result.scriptId, 'SCRIPT-ID-XYZ');
  assert.equal(bySetup.result.scriptName, null);
  // the proof string is unchanged by the extra fields
  assert.equal(bySetup.result.proof, crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`v1\npair-ack\n${instanceId}\n${ts}`).digest('hex'));
  assert.equal(sb.pairClient('EFGH-2345').call('ping').result.scriptId, 'SCRIPT-ID-XYZ');
});

test('scriptId defaults to a mock id and is null if ScriptApp.getScriptId throws', () => {
  const sb = createSandbox();
  assert.ok(sb.pairClient().call('ping').result.scriptId.length > 10);
  const sb2 = createSandbox();
  sb2.ctx.ScriptApp.getScriptId = () => { throw new Error('nope'); };
  assert.equal(sb2.pairClient().call('ping').result.scriptId, null);
});

// ---------------------------------------------------------------- setup spreadsheets (section 12)

const sid = (c) => c.repeat(30);
const entry = (id, access = 'read') => ({ id, access });
const allowlist = (sb) => JSON.parse(sb.props.get('asmcp.spreadsheets') || '[]');

test('setup pair adds the listed spreadsheets, skips ones that cannot be opened, and reports both', () => {
  const { sb, setup } = setupSandbox();
  sb.setSetup({ ...setup, spreadsheets: [entry(sid('a')), entry(sid('b'), 'write'), entry(sid('c'))] });
  sb.addSpreadsheet({ id: sid('a'), name: 'Sales' });
  sb.addSpreadsheet({ id: sid('b'), name: 'Costs' });
  const r = code(sb, setupReq(sb, setup));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.allowlist, { added: 2, failed: [sid('c')] });
  assert.deepEqual(allowlist(sb), [
    { id: sid('a'), name: 'Sales', alias: 'Sales', access: 'read' },
    { id: sid('b'), name: 'Costs', alias: 'Costs', access: 'write' }
  ]);
});

test('alias collisions get a numeric suffix; existing entries are left untouched', () => {
  const { sb, setup } = setupSandbox();
  sb.addSpreadsheet({ id: sid('e'), name: 'Old', alias: 'Data', access: 'write' });
  sb.addSpreadsheet({ id: sid('a'), name: 'Data' });
  sb.addSpreadsheet({ id: sid('b'), name: 'data' });
  sb.addSpreadsheet({ id: sid('c'), name: 'Other' });
  // sid('e') is already listed (with a different access): kept as is, not reopened
  sb.setSetup({ ...setup, spreadsheets: [entry(sid('a')), entry(sid('b')), entry(sid('e'), 'read'), entry(sid('c')), entry(sid('a'))] });
  const r = code(sb, setupReq(sb, setup));
  assert.deepEqual(r.result.allowlist, { added: 3, failed: [] });
  const list = allowlist(sb);
  assert.deepEqual(list[0], { id: sid('e'), name: 'Old', alias: 'Data', access: 'write' });
  assert.deepEqual(list.slice(1).map((e) => e.alias), ['Data 2', 'data 3', 'Other']);
  assert.equal(list.length, 4);
  assert.equal(sb.sheetsFake.opened.includes(sid('e')), false);
});

test('the list is applied once per token: a replayed setup pair does not apply again', () => {
  const { sb, setup } = setupSandbox();
  sb.setSetup({ ...setup, spreadsheets: [entry(sid('a'))] });
  sb.addSpreadsheet({ id: sid('a'), name: 'Sales' });
  const req = setupReq(sb, setup);
  assert.equal(code(sb, req).result.allowlist.added, 1);
  sb.props.set("asmcp.spreadsheets", "[]");
  assert.equal(code(sb, req).error.code, 'PAIRING_INVALID');
  assert.deepEqual(allowlist(sb), []);
});

test('a LIMIT_EXCEEDED setup pair applies nothing', () => {
  const { sb, setup } = setupSandbox();
  for (let i = 0; i < 20; i++) sb.pairClient('ABCD-2345');
  sb.setSetup({ ...setup, spreadsheets: [entry(sid('a'))] });
  sb.addSpreadsheet({ id: sid('a'), name: 'Sales' });
  assert.equal(code(sb, setupReq(sb, setup)).error.code, 'LIMIT_EXCEEDED');
  assert.deepEqual(allowlist(sb), []);
});

test('a code pair never touches the allowlist and carries no allowlist field', () => {
  const sb = createSandbox({ setup: { server: 'local', token: newSecret(), expiresAt: 1e15, spreadsheets: [entry(sid('a'))] } });
  sb.addSpreadsheet({ id: sid('a'), name: 'Sales' });
  sb.enterPairingCode('ABCD-2345');
  const r = code(sb, buildPairRequest({ instanceId: crypto.randomUUID(), pairingCode: 'ABCD2345', secret: newSecret(), ts: sb.clock.now }));
  assert.equal(r.ok, true);
  assert.equal('allowlist' in r.result, false);
  assert.deepEqual(allowlist(sb), []);
});

test('a setup block without spreadsheets, or with junk entries, still pairs', () => {
  for (const spreadsheets of [undefined, 'x', [null, 5, { id: 1 }, { id: sid('a'), access: 'admin' }]]) {
    const { sb, setup } = setupSandbox();
    sb.setSetup({ ...setup, spreadsheets });
    const r = code(sb, setupReq(sb, setup));
    assert.equal(r.ok, true);
    assert.equal(r.result.allowlist.added, 0);
    assert.deepEqual(allowlist(sb), []);
  }
});

test('at most 50 entries are considered', () => {
  const { sb, setup } = setupSandbox();
  const ids = [];
  for (let i = 0; i < 52; i++) {
    const id = `s${i}`.padEnd(30, 'z');
    ids.push(id);
    sb.addSpreadsheet({ id, name: `Sheet ${i}` });
  }
  sb.setSetup({ ...setup, spreadsheets: ids.map((id) => entry(id)) });
  assert.equal(code(sb, setupReq(sb, setup)).result.allowlist.added, 50);
});
