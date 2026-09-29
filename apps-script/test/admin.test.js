'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox } = require('./harness');

const PUBLIC_OK = new Set(['doGet', 'doPost', 'admin_getState', 'admin_submitPairingCode', 'admin_unpair',
  'admin_addSpreadsheet', 'admin_updateSpreadsheet', 'admin_removeSpreadsheet']);

test('only doGet, doPost and the admin_* API are public (everything else ends with _)', () => {
  const { ctx } = createSandbox();
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');
  const fns = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)) fns.push(m[1]);
  }
  assert.ok(fns.length > 40);
  for (const name of fns) {
    assert.ok(PUBLIC_OK.has(name) || name.endsWith('_'), `${name} would be callable from google.script.run`);
  }
  for (const name of PUBLIC_OK) assert.equal(typeof ctx[name], 'function', name);
});

test('owner gate rejects an anonymous caller (empty active email) on every entry point', () => {
  const sb = createSandbox({ activeEmail: '' });
  const denied = (fn) => assert.throws(fn, /ACCESS_DENIED/);
  denied(() => sb.ctx.admin_getState());
  denied(() => sb.ctx.admin_submitPairingCode('ABCD-2345'));
  denied(() => sb.ctx.admin_unpair());
  denied(() => sb.ctx.admin_addSpreadsheet('x'.repeat(30), 'a', 'read'));
  denied(() => sb.ctx.admin_updateSpreadsheet('id', 'a', 'read'));
  denied(() => sb.ctx.admin_removeSpreadsheet('id'));
  const page = sb.ctx.doGet({});
  assert.match(page.getContent(), /Truy cập bị từ chối/);
  assert.equal(sb.props.size, 0);
});

test('owner gate rejects a different signed-in account', () => {
  const sb = createSandbox({ activeEmail: 'intruder@example.com' });
  assert.throws(() => sb.ctx.admin_getState(), /ACCESS_DENIED/);
  assert.match(sb.ctx.doGet({}).getContent(), /Truy cập bị từ chối/);
});

test('owner gate: email comparison ignores case; doGet serves the admin page to the owner', () => {
  const sb = createSandbox({ activeEmail: 'Owner@Example.com' });
  assert.equal(sb.ctx.admin_getState().paired, false);
  const page = sb.ctx.doGet({});
  assert.match(page.getContent(), /Quản trị/);
  assert.match(page.getContent(), /admin_addSpreadsheet/);
});

test('gate also rejects when Session throws', () => {
  const sb = createSandbox();
  sb.session.active = undefined;
  assert.throws(() => sb.ctx.admin_getState(), /ACCESS_DENIED/);
});

test('admin_getState reports pairing and never leaks the secret', () => {
  const sb = createSandbox({ webAppUrl: 'https://script.google.com/macros/s/AKx/exec' });
  assert.equal(sb.ctx.admin_getState().paired, false);
  sb.enterPairingCode('ABCD-2345');
  assert.ok(sb.ctx.admin_getState().pendingExpiresAt > sb.clock.now);
  const c = sb.pairClient('EFGH-2345');
  const st = sb.ctx.admin_getState();
  assert.equal(st.paired, true);
  assert.equal(st.pendingExpiresAt, null);
  assert.equal(st.webAppUrl, 'https://script.google.com/macros/s/AKx/exec');
  assert.equal(st.account, 'owner@example.com');
  assert.ok(st.pairedAt);
  assert.equal(JSON.stringify(st).includes(c.secret), false);
});

test('admin_unpair removes the pairing and any pending code; calls then fail', () => {
  const sb = createSandbox();
  const c = sb.pairClient();
  sb.enterPairingCode('EFGH-2345');
  sb.ctx.admin_unpair();
  assert.equal(sb.ctx.admin_getState().paired, false);
  assert.equal(sb.props.has('gsmcp.pairing.pending'), false);
  assert.equal(c.call('ping').error.code, 'UNAUTHENTICATED');
});

test('allowlist: add by URL and by ID, edit, remove', () => {
  const sb = createSandbox();
  const a = sb.addSpreadsheet({ id: 'AAAAAAAAAAAAAAAA1', name: 'Alpha', sheets: { S: [] } });
  const b = sb.addSpreadsheet({ id: 'BBBBBBBBBBBBBBBB2', name: 'Beta', sheets: { S: [] } });
  let r = sb.ctx.admin_addSpreadsheet(`https://docs.google.com/spreadsheets/d/${a.id}/edit#gid=0`, 'alpha', 'read');
  assert.equal(r.spreadsheets.length, 1);
  r = sb.ctx.admin_addSpreadsheet(b.id, '', 'write'); // alias defaults to the file name
  assert.deepEqual(JSON.parse(JSON.stringify(r.spreadsheets[1])), { id: b.id, name: 'Beta', alias: 'Beta', access: 'write' });
  r = sb.ctx.admin_updateSpreadsheet(a.id, 'alpha2', 'write');
  assert.equal(r.spreadsheets[0].alias, 'alpha2');
  assert.equal(r.spreadsheets[0].access, 'write');
  r = sb.ctx.admin_removeSpreadsheet(a.id);
  assert.equal(r.spreadsheets.length, 1);
  assert.equal(sb.ctx.admin_getState().spreadsheets[0].id, b.id);
});

test('allowlist validation: bad input, unopenable, duplicate id, duplicate alias, bad access', () => {
  const sb = createSandbox();
  const a = sb.addSpreadsheet({ id: 'AAAAAAAAAAAAAAAA1', name: 'Alpha', sheets: { S: [] } });
  const b = sb.addSpreadsheet({ id: 'BBBBBBBBBBBBBBBB2', name: 'Beta', sheets: { S: [] } });
  assert.throws(() => sb.ctx.admin_addSpreadsheet('', 'x', 'read'), /URL hoặc ID/);
  assert.throws(() => sb.ctx.admin_addSpreadsheet('bad id!', 'x', 'read'), /không hợp lệ/);
  assert.throws(() => sb.ctx.admin_addSpreadsheet('NOTEXISTNOTEXIST', 'x', 'read'), /Không mở được/);
  assert.throws(() => sb.ctx.admin_addSpreadsheet(a.id, 'x', 'admin'), /Quyền/);
  sb.ctx.admin_addSpreadsheet(a.id, 'same', 'read');
  assert.throws(() => sb.ctx.admin_addSpreadsheet(a.id, 'other', 'read'), /đã có/);
  assert.throws(() => sb.ctx.admin_addSpreadsheet(b.id, 'SAME', 'read'), /Alias/);
  assert.throws(() => sb.ctx.admin_updateSpreadsheet('missing', 'x', 'read'), /Không tìm thấy/);
  assert.throws(() => sb.ctx.admin_removeSpreadsheet('missing'), /Không tìm thấy/);
});

test('end-to-end: spreadsheet added via the admin API is usable by the paired server', () => {
  const sb = createSandbox();
  const client = sb.pairClient();
  const s = sb.addSpreadsheet({ id: 'AAAAAAAAAAAAAAAA1', name: 'Alpha', sheets: { S: [['hi']] } });
  assert.equal(client.call('range.read', { spreadsheetId: s.id, range: 'S!A1' }).error.code, 'SPREADSHEET_NOT_AUTHORIZED');
  sb.ctx.admin_addSpreadsheet(s.id, 'alpha', 'read');
  assert.deepEqual(client.call('range.read', { spreadsheetId: s.id, range: 'S!A1' }).result.values, [['hi']]);
  assert.equal(client.call('rows.append', { spreadsheetId: s.id, sheet: 'S', rows: [[1]] }).error.code, 'WRITE_NOT_ALLOWED');
  sb.ctx.admin_updateSpreadsheet(s.id, 'alpha', 'write');
  assert.equal(client.call('rows.append', { spreadsheetId: s.id, sheet: 'S', rows: [[1]] }).ok, true);
});

test('manifest matches the spec', () => {
  const m = require('../src/appsscript.json');
  assert.equal(m.timeZone, 'Etc/UTC');
  assert.equal(m.runtimeVersion, 'V8');
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.deepEqual(m.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
});
