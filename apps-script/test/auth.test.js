'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, buildCallRequest, parseBody, newNonce, hmacHex } = require('./harness');

function setup() {
  const sb = createSandbox();
  const client = sb.pairClient();
  return { sb, client };
}

test('unit: hmac hex, digest and constant-time compare match Node', () => {
  const { ctx } = createSandbox();
  assert.equal(ctx.hmacHex_('k', 'v1\nx'), hmacHex('k', 'v1\nx'));
  assert.equal(ctx.hmacHex_('k', 'x').length, 64);
  assert.equal(ctx.sha256Hex_('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(ctx.constantTimeEqual_('abc', 'abc'), true);
  assert.equal(ctx.constantTimeEqual_('abc', 'abd'), false);
  assert.equal(ctx.constantTimeEqual_('abc', 'abcd'), false);
  assert.equal(ctx.constantTimeEqual_('', ''), true);
  assert.equal(ctx.constantTimeEqual_('a', null), false);
});

test('bytesToHex_ handles negative Java bytes and zero padding', () => {
  const { ctx } = createSandbox();
  assert.equal(ctx.bytesToHex_([-1, 0, 1, 15, -128, 127]), 'ff00010f807f');
});

test('not paired -> UNAUTHENTICATED, unsigned', () => {
  const sb = createSandbox();
  const env = sb.doPost(buildCallRequest({ instanceId: 'abc', secret: 'x'.repeat(43), ts: sb.clock.now, nonce: newNonce(), action: 'ping' }));
  assert.equal(parseBody(env).error.code, 'UNAUTHENTICATED');
  assert.equal(env.sig, null);
});

test('valid call: signed response verifies', () => {
  const { client } = setup();
  const r = client.call('ping');
  assert.equal(r.ok, true);
  assert.equal(r.sigValid, true);
  assert.equal(r.result.account, 'owner@example.com');
  assert.equal(r.result.spreadsheetCount, 0);
  assert.match(r.result.scriptVersion, /^\d+\.\d+\.\d+$/);
});

test('wrong instanceId -> UNAUTHENTICATED (unsigned)', () => {
  const { client } = setup();
  const r = client.call('ping', {}, { instanceId: 'other-instance' });
  assert.equal(r.error.code, 'UNAUTHENTICATED');
  assert.equal(r.envelope.sig, null);
});

test('expired timestamp -> REQUEST_EXPIRED (past and future), boundary accepted', () => {
  const { sb, client } = setup();
  assert.equal(client.call('ping', {}, { ts: sb.clock.now - 300001 }).error.code, 'REQUEST_EXPIRED');
  assert.equal(client.call('ping', {}, { ts: sb.clock.now + 300001 }).error.code, 'REQUEST_EXPIRED');
  assert.equal(client.call('ping', {}, { ts: sb.clock.now - 300000 }).ok, true);
  assert.equal(client.call('ping', {}, { ts: sb.clock.now + 300000 }).ok, true);
});

test('bad signature -> UNAUTHENTICATED, unsigned, nonce not consumed', () => {
  const { client } = setup();
  const nonce = newNonce();
  const bad = client.call('ping', {}, { nonce, sig: '0'.repeat(64) });
  assert.equal(bad.error.code, 'UNAUTHENTICATED');
  assert.equal(bad.envelope.sig, null);
  assert.equal(client.call('ping', {}, { nonce }).ok, true); // same nonce still usable
});

test('tampered payload -> UNAUTHENTICATED', () => {
  const { sb, client } = setup();
  const nonce = newNonce();
  const good = JSON.parse(buildCallRequest({ instanceId: client.instanceId, secret: client.secret, ts: sb.clock.now, nonce, action: 'ping' }));
  good.payload = JSON.stringify({ action: 'spreadsheets.list', params: {} });
  const env = sb.doPost(JSON.stringify(good));
  assert.equal(parseBody(env).error.code, 'UNAUTHENTICATED');
});

test('replay -> REPLAYED (signed); allowed again after 600 s TTL', () => {
  const { sb, client } = setup();
  const nonce = newNonce();
  assert.equal(client.call('ping', {}, { nonce }).ok, true);
  const again = client.call('ping', {}, { nonce });
  assert.equal(again.error.code, 'REPLAYED');
  assert.equal(again.sigValid, true);
  assert.equal(sb.cache.has(`n:${nonce}`), true);
  sb.clock.advance(601000);
  assert.equal(client.call('ping', {}, { nonce, ts: sb.clock.now }).ok, true);
});

test('unknown action -> UNKNOWN_ACTION (signed); prototype names are not actions', () => {
  const { client } = setup();
  for (const a of ['drop.everything', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = client.call(a, {});
    assert.equal(r.error.code, 'UNKNOWN_ACTION', a);
    assert.equal(r.sigValid, true);
  }
});

test('shape errors -> BAD_REQUEST before any auth work', () => {
  const { sb, client } = setup();
  const base = { v: 1, kind: 'call', instanceId: client.instanceId, ts: sb.clock.now, nonce: newNonce(), payload: '{}', sig: 'a'.repeat(64) };
  for (const over of [{ nonce: 'short' }, { ts: 'x' }, { ts: 1.5 }, { payload: 5 }, { sig: 'abc' }, { instanceId: 7 }, { nonce: 'bad nonce!!!!!!!!!!' }]) {
    assert.equal(parseBody(sb.doPost(JSON.stringify({ ...base, ...over }))).error.code, 'BAD_REQUEST', JSON.stringify(over));
  }
  assert.equal(parseBody(sb.doPost('[]')).error.code, 'BAD_REQUEST');
});

test('oversized payload (>5 MB) -> BAD_REQUEST', () => {
  const { sb, client } = setup();
  const payload = 'x'.repeat(5 * 1024 * 1024 + 1);
  const env = sb.doPost(buildCallRequest({ instanceId: client.instanceId, secret: client.secret, ts: sb.clock.now, nonce: newNonce(), payload }));
  assert.equal(parseBody(env).error.code, 'BAD_REQUEST');
});

test('signed payload that is not an action object -> BAD_REQUEST (signed)', () => {
  const { client } = setup();
  for (const payload of ['not json', '[]', '{"params":{}}', '{"action":"ping","params":[]}']) {
    const r = client.call(null, null, { payload });
    assert.equal(r.error.code, 'BAD_REQUEST', payload);
    assert.equal(r.sigValid, true);
  }
});

test('order: expiry is checked before signature, auth before replay', () => {
  const { sb, client } = setup();
  const r = client.call('ping', {}, { ts: sb.clock.now - 400000, sig: '0'.repeat(64) });
  assert.equal(r.error.code, 'REQUEST_EXPIRED');
  const nonce = newNonce();
  client.call('ping', {}, { nonce });
  assert.equal(client.call('ping', {}, { nonce, sig: '0'.repeat(64) }).error.code, 'UNAUTHENTICATED');
});

test('INTERNAL errors carry no stack or data', () => {
  const { sb, client } = setup();
  const s = sb.addSpreadsheet({ name: 'S', sheets: { Sheet1: [['secret-cell']] }, access: 'read' });
  const orig = sb.sheetsFake.get(s.id).getSheets;
  sb.sheetsFake.get(s.id).getSheets = () => { throw new Error('boom secret-cell at Foo.bar (Code.gs:12)'); };
  const r = client.call('spreadsheet.metadata', { spreadsheetId: s.id });
  sb.sheetsFake.get(s.id).getSheets = orig;
  assert.equal(r.error.code, 'INTERNAL');
  assert.equal(r.error.message, 'Internal error');
  assert.equal(r.sigValid, true);
  assert.equal(r.envelope.body.includes('secret-cell'), false);
  assert.equal(r.envelope.body.includes('Code.gs'), false);
});

test('doPost with missing body is BAD_REQUEST and returns JSON mime', () => {
  const sb = createSandbox();
  const out = sb.ctx.doPost({});
  assert.equal(out.getMimeType(), 'JSON');
  assert.equal(JSON.parse(JSON.parse(out.getContent()).body).error.code, 'BAD_REQUEST');
});
