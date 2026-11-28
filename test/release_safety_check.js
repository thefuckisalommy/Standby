'use strict';
// Release controls, recovery, key revocation and backup safety. No external requests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { Readable } = require('stream');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-release-safety-'));
process.env.DATA_DIR = data;
process.env.CHECKIN_DIR = path.join(data, 'checkin');
const mod = (p) => require(path.join(__dirname, '..', 'standby', 'lib', p));
mod('net').requestText = async () => { throw new Error('Outbound network forbidden in release safety tests'); };
const store = mod('store');
const bitcoin = mod('bitcoin');
const rules = mod('rules');
const release = mod('release');
const checkin = mod('checkin');
release.rearmFullTick = () => {};
mod('verdicts').dryRunAndRecord = async () => [];
mod('remote-checkin').sync = () => {};
mod('autostart').sync = () => {};
mod('updates').sync = () => {};
const broadcastRoute = mod('routes/broadcast');
const backupRoute = mod('routes/backup');
let sent = [];
bitcoin.checkInputsUnspent = async () => ({ spent: [], own: [], conflict: [], unknown: [], unspent: [{}], checked: 1 });
bitcoin.broadcastTx = async (_dir, tx) => { sent.push(tx.txid); return { txid: tx.txid, method: 'test' }; };
const hex = '0100000001' + 'aa'.repeat(32) + '0000000000ffffffff01a0860100000000001976a914' + '00'.repeat(20) + '88ac00000000';
const parsed = bitcoin.parseTx(hex);
const manual = { op: 'OR', rules: [{ type: 'manual', params: {} }] };
function seed() {
  sent = [];
  const s = store.defaultState();
  s.checkin.lastOnlineAt = new Date().toISOString();
  s.bitcoin.txs = [{ id: 'tx_test', txid: parsed.txid, hex, enabled: true, trigger: manual, triggerState: [null], history: [], release: null, broadcasted: null }];
  store.saveState(data, s);
  return store.loadState(data);
}
function request(text, method = 'POST') {
  const r = Readable.from([Buffer.from(text)]);
  r.method = method; r.headers = { host: 'localhost', 'content-type': 'application/json' };
  return r;
}
function response() {
  return { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
}
async function call(route, pathname, body, state, method) {
  const res = response();
  await route({ req: request(body, method), res, pathname, now: new Date(), state });
  return res;
}
let receiver;
(async () => {
  let s = seed();
  await assert.rejects(() => call(broadcastRoute, '/api/broadcast/all', '{"ids":', s), { statusCode: 400 });
  for (const body of ['null', '[]', '{"ids":"bad"}', '{"armedOnly":"false"}']) {
    assert.equal((await call(broadcastRoute, '/api/broadcast/all', body, s)).status, 400);
  }
  assert.equal(sent.length, 0);
  console.log('PASS malformed broadcast requests never send a transaction');

  const tx = s.bitcoin.txs[0];
  s.bitcoin.txs = [
    { ...tx, id: 'active' },
    { ...tx, id: 'pending', release: { status: 'submitted-slipstream' } },
    { ...tx, id: 'pending-sibling' },
    { ...tx, id: 'confirmed', broadcasted: { confirmations: 1 } },
    { ...tx, id: 'public-pending', broadcasted: { confirmations: 0 } },
    { ...tx, id: 'stale', release: { status: 'stale' } },
  ];
  s.bitcoin.sets = [
    { id: 'active-set', enabled: true, txIds: ['active'], trigger: manual },
    { id: 'pending-set', enabled: true, txIds: ['pending', 'pending-sibling'], trigger: manual },
    { id: 'archived-set', enabled: true, txIds: ['confirmed'], trigger: manual },
  ];
  store.saveState(data, s);
  await call(broadcastRoute, '/api/bitcoin/txs/arm-all', '{"enabled":false}', s);
  let fresh = store.loadState(data);
  assert.equal(fresh.bitcoin.txs[0].enabled, false);
  assert.ok(fresh.bitcoin.txs.slice(1).every((t) => t.enabled));
  assert.equal(fresh.bitcoin.sets[0].enabled, false);
  assert.ok(fresh.bitcoin.sets.slice(1).every((t) => t.enabled));
  // Reverse the saved flags to prove Arm all also leaves non-active entries alone.
  fresh.bitcoin.txs.forEach((t) => { t.enabled = false; });
  fresh.bitcoin.sets.forEach((t) => { t.enabled = false; });
  store.saveState(data, fresh);
  await call(broadcastRoute, '/api/bitcoin/txs/arm-all', '{"enabled":true}', fresh);
  fresh = store.loadState(data);
  assert.equal(fresh.bitcoin.txs[0].enabled, true);
  assert.ok(fresh.bitcoin.txs.slice(1).every((t) => !t.enabled));
  assert.ok(fresh.bitcoin.sets.slice(1).every((t) => !t.enabled));
  console.log('PASS global arm/disarm changes Active only, including whole pending sets');

  // Pending and archived sets are label-only on the server: trigger, arm
  // and member changes are rejected, label edits and identical-value
  // resends pass, and a pending tx's own arm flip is rejected too.
  const setsRoute = mod('routes/sets');
  const txsRoute = mod('routes/txs');
  const checkinTrig = { op: 'OR', rules: [{ type: 'checkin', params: { thresholdDays: 35 } }] };
  s = seed();
  s.bitcoin.txs = [
    { ...tx, id: 'pending', release: { status: 'submitted-slipstream' } },
    { ...tx, id: 'pending-sibling' },
    { ...tx, id: 'confirmed', broadcasted: { confirmations: 1 } },
  ];
  s.bitcoin.sets = [
    { id: 'pending-set', enabled: true, txIds: ['pending', 'pending-sibling'], trigger: manual },
    { id: 'archived-set', enabled: true, txIds: ['confirmed'], trigger: manual },
  ];
  store.saveState(data, s);
  let r = await call(setsRoute, '/api/bitcoin/sets/pending-set', JSON.stringify({ trigger: checkinTrig }), s, 'PUT');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /trigger cannot be changed/);
  r = await call(setsRoute, '/api/bitcoin/sets/pending-set', '{"enabled":false}', s, 'PUT');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /arm cannot be changed/);
  r = await call(setsRoute, '/api/bitcoin/sets/pending-set', '{"txIds":["pending"]}', s, 'PUT');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot be added to or removed/);
  r = await call(setsRoute, '/api/bitcoin/sets/archived-set', JSON.stringify({ trigger: checkinTrig }), s, 'PUT');
  assert.equal(r.status, 400);
  r = await call(setsRoute, '/api/bitcoin/sets/archived-set', '{"enabled":false}', s, 'PUT');
  assert.equal(r.status, 400);
  assert.equal((await call(setsRoute, '/api/bitcoin/sets/pending-set', '{"label":"Renamed"}', s, 'PUT')).status, 200);
  assert.equal((await call(setsRoute, '/api/bitcoin/sets/pending-set', JSON.stringify({ trigger: manual, enabled: true, txIds: ['pending', 'pending-sibling'] }), s, 'PUT')).status, 200);
  r = await call(txsRoute, '/api/bitcoin/txs/pending', '{"enabled":false}', s, 'PUT');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /arm cannot be changed/);
  assert.equal((await call(txsRoute, '/api/bitcoin/txs/pending', '{"label":"Tx renamed"}', s, 'PUT')).status, 200);
  fresh = store.loadState(data);
  assert.equal(fresh.bitcoin.sets.find((x) => x.id === 'pending-set').label, 'Renamed');
  assert.equal(fresh.bitcoin.sets.find((x) => x.id === 'pending-set').enabled, true);
  assert.equal(JSON.stringify(fresh.bitcoin.sets.find((x) => x.id === 'pending-set').trigger), JSON.stringify(manual));
  assert.equal(fresh.bitcoin.sets.find((x) => x.id === 'pending-set').txIds.length, 2);
  assert.equal(fresh.bitcoin.txs.find((x) => x.id === 'pending').enabled, true);
  assert.equal(fresh.bitcoin.txs.find((x) => x.id === 'pending').label, 'Tx renamed');
  console.log('PASS pending and archived sets are label-only on the server');

  for (const missing of [false, true]) {
    s = seed(); s.settings.graceEnabled = false;
    store.saveState(data, s); store.saveState(data, s);
    if (missing) fs.unlinkSync(path.join(data, 'state.json'));
    else fs.writeFileSync(path.join(data, 'state.json'), '{broken');
    fresh = store.loadState(data);
    assert.equal(checkin.graceStatus(fresh, new Date()).reason, 'recovery');
    assert.equal(Date.parse(fresh.grace.graceUntil) - Date.parse(fresh.grace.triggeredAt), 7 * 86400000);
    assert.equal(rules.preBroadcastCheck(fresh.bitcoin.txs[0], 'release', {}).ok, false);
    assert.equal(store.loadState(data).grace.reason, 'recovery');
    await call(mod('routes/checkin'), '/api/grace/resume', '{}', fresh);
    assert.equal(checkin.graceStatus(store.loadState(data), new Date()), null);
  }
  console.log('PASS missing/corrupt recovery holds releases with offline grace disabled; resume works');

  s = seed();
  Object.assign(s.bitcoin.txs[0], { broadcastVia: 'slipstream', publicFallbackDays: 1,
    release: { status: 'submitted-slipstream', txid: parsed.txid, submittedAt: new Date(Date.now() - 3 * 86400000).toISOString(), kind: 'release' } });
  s.bitcoin.sets = [{ id: 'set_pending', enabled: false, txIds: ['tx_test'], trigger: manual }];
  s.grace = { reason: 'recovery', triggeredAt: new Date().toISOString(), graceUntil: new Date(Date.now() + 86400000).toISOString() };
  store.saveState(data, s);
  bitcoin.getConfirmations = async () => ({ found: false });
  await release.refreshPublicFallbacks(store.loadState(data));
  assert.equal(sent.length, 1);
  console.log('PASS already-authorized Slipstream fallback remains available');

  s = seed();
  const plain = 'test-key-only';
  s.checkinKeys = [{ id: 'key_test', label: 'Test', hash: checkin.hashCheckinKey(plain) }];
  store.saveState(data, s); checkin.writeReceiverKeys(s);
  const durable = store.writeFileDurable;
  store.writeFileDurable = (file, ...args) => {
    if (file.endsWith('keys.json')) throw new Error('simulated publication failure');
    return durable(file, ...args);
  };
  let res;
  try { res = await call(mod('routes/checkin'), '/api/checkin-keys/key_test', '', s, 'DELETE'); }
  finally { store.writeFileDurable = durable; }
  assert.equal(res.status, 202); assert.equal(res.body.receiverConfirmed, false);
  receiver = mod('receiver').createReceiverServer(process.env.CHECKIN_DIR);
  const requestWithKey = () => ({ method: 'POST', url: '/checkin', headers: { host: 'localhost', authorization: 'Bearer ' + plain }, socket: { remoteAddress: '127.0.0.1' } });
  const oldResponse = response(); receiver.emit('request', requestWithKey(), oldResponse);
  assert.equal(oldResponse.status, 200); // Receiver still has old keys: main app must reject its receipt.
  fresh = store.loadState(data);
  assert.equal(checkin.mergeExternalCheckin(fresh, new Date()), false);
  assert.equal(checkin.receiverKeysConfirmed(fresh), false);
  assert.equal(checkin.writeReceiverKeys(fresh), true);
  assert.equal(checkin.receiverKeysConfirmed(fresh), false); // Old ack cannot confirm new publication.
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  assert.equal(await checkin.waitForReceiverKeys(fresh), true);
  const denied = response(); receiver.emit('request', requestWithKey(), denied);
  assert.equal(denied.status, 401);
  // A healthy deletion returns success only after the receiver acknowledges it.
  s = seed(); s.checkinKeys = [{ id: 'key_test', label: 'Test', hash: checkin.hashCheckinKey(plain) }];
  store.saveState(data, s); checkin.writeReceiverKeys(s);
  res = await call(mod('routes/checkin'), '/api/checkin-keys/key_test', '', s, 'DELETE');
  assert.equal(res.status, 200); assert.equal(res.body.receiverConfirmed, true);
  await new Promise((resolve) => receiver.close(resolve)); receiver = null;
  console.log('PASS failed publication cannot reset clock; stale ack rejected; receiver confirms healthy deletion');

  s = seed();
  s.settings.acceptRemoteCheckins = true; s.settings.startAtLogin = false; s.settings.updateCheck = false;
  const backup = (await call(backupRoute, '/api/backup', '{}', s)).body;
  const destination = store.defaultState();
  store.saveState(data, destination);
  res = await call(backupRoute, '/api/restore', JSON.stringify(backup), destination);
  assert.equal(res.status, 200);
  fresh = store.loadState(data);
  for (const key of ['acceptRemoteCheckins', 'startAtLogin', 'updateCheck']) assert.equal(fresh.settings[key], destination.settings[key]);
  assert.ok(res.body.settingsNotice.kept.includes('remote check-ins'));
  console.log('PASS restore preserves destination device preferences and explains exclusions');

  s = seed();
  s.bitcoin.txs = Array.from({ length: 1600 }, (_, i) => {
    const raw = Buffer.from(hex, 'hex'); raw.writeBigUInt64LE(100000n + BigInt(i), 47);
    const uniqueHex = raw.toString('hex');
    return { ...s.bitcoin.txs[0], id: 'tx_' + i, hex: uniqueHex, txid: bitcoin.parseTx(uniqueHex).txid, notes: 'x'.repeat(500) };
  });
  for (const password of ['', 'test password']) {
    const exported = await call(backupRoute, '/api/backup', JSON.stringify({ password }), s);
    assert.equal(exported.status, 200);
    if (!password) assert.ok(Buffer.byteLength(JSON.stringify(exported.body)) > 1024 * 1024);
    if (password) exported.body.password = password;
    res = await call(backupRoute, '/api/restore', JSON.stringify(exported.body), s);
    assert.equal(res.status, 200); assert.equal(res.body.restoredTxs, 1600);
  }
  s.bitcoin.txs[0].notes = 'x'.repeat(16 * 1024 * 1024);
  assert.equal((await call(backupRoute, '/api/backup', '{}', s)).status, 413);
  const limit = 16 * 1024 * 1024;
  assert.deepEqual(await mod('util').readBody(request('{}' + ' '.repeat(limit - 2)), limit), {});
  await assert.rejects(() => mod('util').readBody(request('{}' + ' '.repeat(limit - 1)), limit), { statusCode: 413 });
  console.log('PASS large plaintext/encrypted backups restore; oversized exports/imports fail without truncation');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (receiver) await new Promise((resolve) => receiver.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
});
