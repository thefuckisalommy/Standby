'use strict';
const store = require('../store');
const bitcoin = require('../bitcoin');
const { checkinLiveOffsetMs, inDangerZone, resetCheckin, syncCheckinFreeze } = require('../checkin');
const { DATA_DIR } = require('../config');
const { pushHistory } = require('../history');
const { saveMutation } = require('../http');
const { refreshConfirmations } = require('../release');
const { broadcastOne } = require('../rules');
const { serveSets, serveTx, serveTxs } = require('../triggers');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function broadcastRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/bitcoin/txs/arm-all { enabled }: toggle Active entries only.
  // Re-sync freezes and reset check-in when arming inside the danger zone.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/arm-all') {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'enabled must be true or false');
    // The toggle + freeze sync + reset
    // ride into FRESH state: the request body was awaited above.
    let checkinReset = false;
    let count = 0;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      // Match the Active/Pending/Archived categories in transactions.js.
      // A pending member makes the entire set pending, including unsent siblings.
      const category = (t) => {
        if (t.broadcasted || (t.release && t.release.status === 'broadcast')) {
          const b = t.broadcasted;
          return !b || b.found === false || b.confirmations > 0 || b.blockHeight != null ? 'archived' : 'pending';
        }
        if (t.release && t.release.status === 'stale') return 'archived';
        return t.release && t.release.status === 'submitted-slipstream' ? 'pending' : 'active';
      };
      const sets = f.bitcoin.sets || [];
      const activeSets = sets.filter((s) => {
        const members = txs.filter((t) => (s.txIds || []).includes(t.id));
        return !members.length || (!members.some((t) => category(t) === 'pending')
          && !members.every((t) => category(t) === 'archived'));
      });
      const inactiveMemberIds = new Set(sets.filter((s) => !activeSets.includes(s)).flatMap((s) => s.txIds || []));
      const newlyArmed = [];
      for (const t of txs) {
        if (category(t) !== 'active' || inactiveMemberIds.has(t.id)) continue;
        count++;
        const wasEnabled = t.enabled;
        t.enabled = body.enabled;
        // An arm/disarm flip logs on the tx it flipped —
        // a no-op toggle (already in that state) logs nothing.
        if (wasEnabled !== body.enabled) pushHistory(t, body.enabled ? 'armed' : 'disarmed', '');
        syncCheckinFreeze(t, f, now);
        if (body.enabled === true && wasEnabled === false) newlyArmed.push(t);
      }
      for (const t of newlyArmed) {
        const checkinThresholds = store.triggerOf(t).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
        if (checkinThresholds.length === 0) continue;
        if (t.broadcasted || (t.release && t.release.status === 'stale')) continue;
        if (inDangerZone(f, now, Math.min(...checkinThresholds), checkinLiveOffsetMs(t, now))) {
          resetCheckin(f, now, 'arm-all-reset');
          checkinReset = true;
          break;
        }
      }
      // A set's arm is its members' only arm; only Active sets can change.
      const newlyArmedSets = [];
      for (const s of activeSets) {
        const wasEnabled = s.enabled;
        s.enabled = body.enabled;
        if (wasEnabled !== body.enabled) pushHistory(s, body.enabled ? 'armed' : 'disarmed', '');
        syncCheckinFreeze(s, f, now);
        if (body.enabled === true && wasEnabled === false) newlyArmedSets.push(s);
      }
      for (const s of newlyArmedSets) {
        const checkinThresholds = store.triggerOf(s).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
        if (checkinThresholds.length === 0) continue;
        const members = (f.bitcoin.txs || []).filter((t) => (s.txIds || []).includes(t.id));
        if (members.length && members.every((t) => t.broadcasted || (t.release && t.release.status === 'stale'))) continue;
        if (inDangerZone(f, now, Math.min(...checkinThresholds), checkinLiveOffsetMs(s, now))) {
          resetCheckin(f, now, 'arm-all-reset');
          checkinReset = true;
          break;
        }
      }
    });
    const freshTxs = fresh.bitcoin.txs || [];
    return sendJson(res, 200, { ok: true, enabled: body.enabled, count, checkinReset, txs: serveTxs(freshTxs), sets: serveSets(fresh.bitcoin.sets || []) });
  }

  // POST /api/bitcoin/txs/:id/broadcast: manual broadcast now, through the
  // release path, ignoring clock, arm and vacation. Already broadcast is
  // skipped.
  const txBroadcastMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && txBroadcastMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (tx.broadcasted) {
      return sendJson(res, 200, { ok: true, id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast', tx: serveTx(tx) });
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast');
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/bitcoin/txs/:id/broadcast-public: the manual escape hatch
  // for a Slipstream-pending tx, broadcasting it publicly now. On success
  // the route becomes public and it is public-pending; on failure it stays
  // Slipstream-pending with no 'failed' record (MARA still holds it). Only
  // this endpoint uses forcePublic.
  const txBroadcastPublicMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast-public$/);
  if (req.method === 'POST' && txBroadcastPublicMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastPublicMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (!(tx.release && tx.release.status === 'submitted-slipstream')) {
      return sendError(res, 400, 'only a transaction waiting on MARA (Slipstream-pending) can be broadcast publicly');
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast', { forcePublic: true });
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/broadcast/all: manual broadcast of every tx not archived
  // (the UI sends the ids; without them the server applies the same rule).
  // Each goes through the normal path; one failing does not stop the rest.
  // { armedOnly: true } skips disarmed ids.
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'body must be an object');
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || !id))) {
      return sendError(res, 400, 'ids must be an array of transaction IDs');
    }
    if (body.armedOnly !== undefined && typeof body.armedOnly !== 'boolean') return sendError(res, 400, 'armedOnly must be true or false');
    const armedOnly = !!(body && body.armedOnly);
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        // Already with MARA: not re-submitted.
        if (!tx.broadcasted && !(tx.release && tx.release.status === 'submitted-slipstream')) targets.push(tx);
      }
    } else {
      targets = txs.filter((t) => !t.broadcasted && !(t.release && t.release.status === 'stale')
        && !(t.release && t.release.status === 'submitted-slipstream'));
    }
    if (armedOnly) targets = targets.filter((t) => t.enabled);
    if (!targets.length) return sendError(res, 400, armedOnly ? 'nothing to broadcast — no armed transactions to broadcast' : 'nothing to broadcast — every transaction is already archived or pending');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of targets) {
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast'));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }

  // GET /api/bitcoin/confirmations: counts for broadcast txs, refreshed
  // unless checked within a minute. A failure keeps the last value.
  if (req.method === 'GET' && pathname === '/api/bitcoin/confirmations') {
    const refreshed = await refreshConfirmations(state, 60);
    return sendJson(res, 200, { confirmations: refreshed });
  }
  return NEXT;
};
