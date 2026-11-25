'use strict';
const store = require('../store');
const crypto = require('crypto');
const { checkinStatus, graceStatus, hashCheckinKey, mergeExternalCheckin, newCheckinKeyId, publicCheckinKey, syncCheckinFreeze, writeReceiverKeys } = require('../checkin');
const { DATA_DIR } = require('../config');
const { saveMutation } = require('../http');
const { asStr, readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function checkinRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/checkin: starts a new cycle for check-in rules by clearing
  // their cycle records. Price and UTXO records belong to their own
  // triggers and stay; stale records stay (spent inputs are a fact). A
  // 'submitted-slipstream' record is cleared too, but the tx is still with
  // MARA: if mined it is recognised as broadcast, if dropped the next
  // release re-submits it.
  if (req.method === 'POST' && pathname === '/api/checkin') {
    const body = await readBody(req).catch(() => ({}));
    const method = body.method === 'telegram' ? 'telegram' : 'app';
    const fresh = saveMutation((f) => {
      f.checkin.lastCheckinAt = now.toISOString();
      f.checkin.totalCheckins += 1;
      for (const t of (f.bitcoin.txs || [])) {
        if (!store.hasTriggerType(t, 'checkin')) continue;
        if (t.release && t.release.status === 'stale') continue;
        t.release = null;
        // The clock restarts at this check-in: any frozen time is
        // wiped, then a tx that is still inactive (disarmed, or on
        // vacation) is re-marked inactive from now — it stays frozen
        // at 0 instead of counting while inactive. Checking in does
        // NOT re-arm anything: there is no global pause to
        // auto-resume.
        t.checkinOffsetMs = 0;
        t.checkinInactiveSince = null;
      }
      for (const t of (f.bitcoin.txs || [])) syncCheckinFreeze(t, f, now);
    });
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method });
    return sendJson(res, 200, { ok: true, status: checkinStatus(fresh, now) });
  }

  // POST /api/grace/resume: end the grace now (the only way, other than
  // expiry; idempotent). Also refreshes lastOnlineAt, so the next read
  // does not re-set a grace on the same old gap. Returns the grace state.
  if (req.method === 'POST' && pathname === '/api/grace/resume') {
    const fresh = saveMutation((f) => {
      f.grace = { graceUntil: null, triggeredAt: null, offlineGapDays: null };
      f.checkin.lastOnlineAt = now.toISOString();
    });
    return sendJson(res, 200, { ok: true, grace: graceStatus(fresh, now) });
  }

  // Check-in API keys, used by the receiver. The plaintext is returned
  // once on creation; only the hash is kept and published to the receiver
  // on every change. The list never carries hashes; revoking takes effect
  // on the next check-in.
  // GET /api/checkin-keys: list { id, label, createdAt, lastUsedAt }
  // POST /api/checkin-keys { label }: 201 { key, plain }
  // DELETE /api/checkin-keys/:id: revoke
  if (req.method === 'GET' && pathname === '/api/checkin-keys') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, (state.checkinKeys || []).map(publicCheckinKey));
  }
  if (req.method === 'POST' && pathname === '/api/checkin-keys') {
    const body = await readBody(req).catch(() => ({}));
    const label = asStr(typeof body.label === 'string' ? body.label.trim() : '', 80) || 'Untitled key';
    const plain = crypto.randomBytes(32).toString('base64url');
    const key = {
      id: newCheckinKeyId(), label, hash: hashCheckinKey(plain),
      createdAt: now.toISOString(), lastUsedAt: null,
    };
    const fresh = saveMutation((f) => {
      f.checkinKeys = f.checkinKeys || [];
      f.checkinKeys.push(key);
    });
    writeReceiverKeys(fresh);
    // Key creates are logged (id + label only — never the
    // hash or plaintext), so a lost key can be traced to when it
    // was created or revoked.
    console.log('Standby: check-in key created: ' + key.id + ' (' + key.label + ')');
    return sendJson(res, 201, { key: publicCheckinKey(key), plain });
  }
  const keyMatch = pathname.match(/^\/api\/checkin-keys\/([^/]+)$/);
  if (req.method === 'DELETE' && keyMatch) {
    const fresh = saveMutation((f) => {
      const keys = f.checkinKeys || [];
      const idx = keys.findIndex((k) => k.id === keyMatch[1]);
      if (idx === -1) return false;
      keys.splice(idx, 1);
    });
    if (!fresh) return sendError(res, 404, 'no such key');
    writeReceiverKeys(fresh);
    // Key revokes are logged too — same reason as creates.
    console.log('Standby: check-in key revoked: ' + keyMatch[1]);
    return sendJson(res, 200, { ok: true, removed: keyMatch[1] });
  }
  return NEXT;
};
