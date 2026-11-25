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

  // POST /api/bitcoin/txs/arm-all — Global Arm/Disarm:
  // set `enabled` on EVERY staged transaction at once. Body
  // { enabled: true|false }. Applies to all triggers — check-in,
  // price, UTXO, manual. "Arm all" arms EVERYTHING, including
  // transactions individually disarmed before — the owner
  // re-disarms those after if needed. Each check-in tx's freeze
  // is re-synced, so disarming freezes its countdown at the day
  // count it was left at and re-arming resumes from there.
  // Arming a check-in tx in its danger zone resets the check-in
  // (the same guard as arming one tx), once, and the
  // response names it. Manual broadcasts still work while a tx
  // is disarmed — they never went through the armed toggle.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/arm-all') {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'enabled must be true or false');
    // The toggle + freeze sync + reset
    // ride into FRESH state: the request body was awaited above.
    let checkinReset = false;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const newlyArmed = [];
      for (const t of txs) {
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
      // Arm/disarm every set too — a set's arm is the
      // only arm its members have, so leaving sets out would
      // leave half the release armed after "Disarm all".
      const newlyArmedSets = [];
      for (const s of (f.bitcoin.sets || [])) {
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
    return sendJson(res, 200, { ok: true, enabled: body.enabled, count: freshTxs.length, checkinReset, txs: serveTxs(freshTxs), sets: serveSets(fresh.bitcoin.sets || []) });
  }

  // POST /api/bitcoin/txs/:id/broadcast — MANUAL broadcast, now. Same
  // path as the release (freshness gate, then primary with secondary
  // fallback) but on the owner's explicit say-so: it ignores the
  // check-in clock, the armed toggle, and vacation mode. The UI
  // asks first (a confirmation dialog). A tx already broadcast is
  // skipped, never re-sent.
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

  // POST /api/bitcoin/txs/:id/broadcast-public — the MANUAL escape
  // hatch for a slow MARA tx. A transaction
  // submitted to Slipstream and waiting on MARA is private until
  // MARA mines it; if the owner does not want to wait, this
  // broadcasts it via the PUBLIC route instead (mempool.space, then
  // blockstream.info), right now, on the owner's explicit say-so.
  // It applies ONLY to a Slipstream-pending tx (release status
  // 'submitted-slipstream') — a public-pending tx is already public,
  // and an active tx uses the route toggle. On success the
  // broadcasted fact is set, the stored route becomes 'public', and
  // the tx is public-pending (confirmed -> Archived, as usual). On
  // failure the error is surfaced and the tx STAYS Slipstream-pending
  // (no 'failed' record is written — MARA is still holding it).
  // MANUAL ONLY: it is not reachable from the release evaluation or
  // Broadcast Armed — only this endpoint calls broadcastOne with
  // forcePublic, and only for the one tx named here.
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

  // POST /api/broadcast/all — MANUAL broadcast of the transactions
  // that are NOT in the Archived Transactions card (broadcasted, or
  // already declared stale) — those are never attempted or counted.
  // The UI sends their ids (it knows the archived set). Without ids
  // (an older client or a direct API call) the same rule applies from
  // what the server can see: the broadcasted ones, and the ones
  // already declared stale — by a release, a manual broadcast, or a
  // dry-run, whose stale verdict is now recorded on the transaction.
  // Each is broadcast through the same path (freshness gate, then primary
  // with secondary fallback); a stale or failed tx does not stop the
  // others. The UI asks first (a confirmation dialog).
  // Body { armedOnly: true } sends only the armed
  // (enabled) transactions — a disarmed id in the list is skipped,
  // not sent. The broadcast guards are the same either way.
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req).catch(() => ({}));
    const armedOnly = !!(body && body.armedOnly);
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        // A transaction already submitted to Slipstream is not
        // re-submitted — it is waiting on MARA, and the
        // MARA-waiting refresh is what moves it on.
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

  // GET /api/bitcoin/confirmations — the confirmation count for every
  // broadcast transaction, refreshed from the network unless checked
  // less than a minute ago (the UI polls this; the hourly tick
  // refreshes it too). A failed lookup keeps the last known value.
  if (req.method === 'GET' && pathname === '/api/bitcoin/confirmations') {
    const refreshed = await refreshConfirmations(state, 60);
    return sendJson(res, 200, { confirmations: refreshed });
  }
  return NEXT;
};
