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

  // POST /api/checkin — clears the CHECK-IN rules' cycle-scoped release records:
  // a new cycle starts for them. A price or UTXO rule's record belongs
  // to its own trigger's cycle, not the check-in clock, so a check-in does
  // not clear it — and does not reset its trigger. A stale record is NOT
  // cleared: spent inputs are a fact about the transaction, not the cycle, so
  // a stale transaction stays stale (and archived) across check-ins — only
  // replacing the hex re-arms it. (If a broadcast already went out, the funds
  // have already moved.) A 'submitted-slipstream' record IS
  // cleared, like any other non-stale cycle record: the check-in ends
  // the cycle, and the card goes back to Ready — but the transaction
  // is still sitting in MARA's private mempool, and a check-in cannot
  // recall it. If MARA mines it, the public-node lookup (or a fresh
  // dry-run) recognises the tx's own txid out there and records it
  // broadcast; if MARA drops it, the next release re-submits it.
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

  // POST /api/grace/resume — end the grace period
  // immediately. The dashboard's Grace period card
  // offers this while a grace is active; an indefinite grace
  // can only end this way (saving new grace settings never
  // changes an active one). Idempotent: resuming with no grace
  // active is a 200 no-op. Returns the grace state after the
  // resume (null when no grace is active). A check-in does NOT
  // clear the grace — this endpoint is the only way.
  // The resume also refreshes lastOnlineAt to now: the owner
  // just used the live app, so it is online now, and the next
  // read / tick must not re-set a grace on the same stale gap
  // (without this, resuming while the stamp is still stale
  // re-sets the grace on the very next read).
  if (req.method === 'POST' && pathname === '/api/grace/resume') {
    const fresh = saveMutation((f) => {
      f.grace = { graceUntil: null, triggeredAt: null, offlineGapDays: null };
      f.checkin.lastOnlineAt = now.toISOString();
    });
    return sendJson(res, 200, { ok: true, grace: graceStatus(fresh, now) });
  }

  // Check-in API keys — managed here, used by the check-in
  // receiver. A key is created with a label; the plaintext is returned
  // ONCE in the response and never stored — only its hash is kept, and
  // the hashes are published to the receiver (keys.json) on every
  // change. The list never carries the hash (the UI has no use for
  // it). Revoking a key removes it from state and from the receiver's
  // list, so the next check-in with it is refused.
  //
  // GET    /api/checkin-keys     — list { id, label, createdAt, lastUsedAt }
  // POST   /api/checkin-keys     — create { label } -> 201 { key, plain }
  // DELETE /api/checkin-keys/:id — revoke
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
