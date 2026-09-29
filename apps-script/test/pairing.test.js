'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSandbox, buildPairRequest, parseBody, newSecret } = require('./harness');

const pairReq = (sb, over = {}) => buildPairRequest({
  instanceId: crypto.randomUUID(), pairingCode: 'ABCD2345', secret: newSecret(), ts: sb.clock.now, ...over
});

test('pairing success returns a proof verifiable with Node crypto and stores the pairing', () => {
  const sb = createSandbox();
  sb.enterPairingCode('abcd-2345'); // owner types it lowercase with a dash
  const instanceId = crypto.randomUUID();
  const secret = newSecret();
  const ts = sb.clock.now;
  const env = sb.doPost(buildPairRequest({ instanceId, instanceLabel: 'My Docker', pairingCode: 'ABCD2345', secret, ts }));
  const body = parseBody(env);
  assert.equal(body.ok, true);
  assert.equal(body.result.account, 'owner@example.com');
  const proof = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`v1\npair-ack\n${instanceId}\n${ts}`).digest('hex');
  assert.equal(body.result.proof, proof);
  const stored = JSON.parse(sb.props.get('asmcp.pairing'));
  assert.equal(stored.instanceId, instanceId);
  assert.equal(stored.instanceLabel, 'My Docker');
  assert.equal(stored.secret, secret);
  assert.ok(stored.pairedAt);
  assert.equal(sb.props.has('asmcp.pairing.pending'), false);
  // the code is single use
  assert.equal(parseBody(sb.doPost(pairReq(sb))).error.code, 'PAIRING_NOT_READY');
});

test('pending record stores only the salted hash and 10 minute expiry', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD-2345');
  const pending = JSON.parse(sb.props.get('asmcp.pairing.pending'));
  assert.equal(pending.codeHash, crypto.createHash('sha256').update('asmcp-pair-v1:ABCD2345').digest('hex'));
  assert.equal(pending.expiresAt, sb.clock.now + 600000);
  assert.equal(pending.attempts, 0);
  assert.equal(JSON.stringify(pending).includes('ABCD'), false);
});

test('PAIRING_NOT_READY when nothing is pending, and no attempt is counted', () => {
  const sb = createSandbox();
  const env = sb.doPost(pairReq(sb));
  assert.equal(parseBody(env).error.code, 'PAIRING_NOT_READY');
  assert.equal(env.sig, null);
  assert.equal(sb.props.has('asmcp.pairing'), false);
});

test('expired pending code is PAIRING_NOT_READY', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD-2345');
  sb.clock.advance(600001);
  assert.equal(parseBody(sb.doPost(pairReq(sb))).error.code, 'PAIRING_NOT_READY');
  assert.equal(sb.props.has('asmcp.pairing.pending'), false);
});

test('wrong code: PAIRING_INVALID x5 then pending is deleted (even the right code fails)', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD-2345');
  for (let i = 1; i <= 5; i++) {
    assert.equal(parseBody(sb.doPost(pairReq(sb, { pairingCode: 'ZZZZ2222' }))).error.code, 'PAIRING_INVALID');
    if (i < 5) assert.equal(JSON.parse(sb.props.get('asmcp.pairing.pending')).attempts, i);
  }
  assert.equal(sb.props.has('asmcp.pairing.pending'), false);
  assert.equal(parseBody(sb.doPost(pairReq(sb))).error.code, 'PAIRING_NOT_READY');
  assert.equal(sb.props.has('asmcp.pairing'), false);
});

test('4 wrong attempts then the right code still succeeds', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD-2345');
  for (let i = 0; i < 4; i++) sb.doPost(pairReq(sb, { pairingCode: 'ZZZZ2222' }));
  assert.equal(parseBody(sb.doPost(pairReq(sb))).ok, true);
});

test('code normalization: server may send dashes/lowercase', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD2345');
  assert.equal(parseBody(sb.doPost(pairReq(sb, { pairingCode: ' abcd-2345 ' }))).ok, true);
});

test('a new pairing replaces the previous one', () => {
  const sb = createSandbox();
  const first = sb.pairClient('ABCD-2345');
  const second = sb.pairClient('EFGH-2345');
  assert.equal(first.call('ping').error.code, 'UNAUTHENTICATED');
  assert.equal(second.call('ping').ok, true);
});

test('malformed pairing requests are BAD_REQUEST', () => {
  const sb = createSandbox();
  sb.enterPairingCode('ABCD-2345');
  for (const over of [{ secret: 'short' }, { instanceId: 'a\nb' }, { ts: 'x' }, { instanceLabel: 'x'.repeat(65) }]) {
    assert.equal(parseBody(sb.doPost(pairReq(sb, over))).error.code, 'BAD_REQUEST');
  }
  assert.equal(parseBody(sb.doPost('not json')).error.code, 'BAD_REQUEST');
  assert.equal(parseBody(sb.doPost('{"v":2,"kind":"pair"}')).error.code, 'BAD_REQUEST');
  assert.equal(parseBody(sb.doPost('{"v":1,"kind":"nope"}')).error.code, 'BAD_REQUEST');
  assert.equal(sb.props.has('asmcp.pairing'), false);
});

test('admin rejects invalid code formats', () => {
  const sb = createSandbox();
  for (const bad of ['', 'ABC', 'ABCD-0O1I', 'ABCD-23456', null]) {
    assert.throws(() => sb.enterPairingCode(bad), /Mã ghép nối/);
  }
});

test('nothing sensitive is logged', () => {
  const sb = createSandbox();
  const c = sb.pairClient('ABCD-2345');
  c.call('ping');
  assert.equal(JSON.stringify(sb.logs).includes(c.secret), false);
  assert.equal(sb.logs.length, 0);
});
