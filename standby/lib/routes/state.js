'use strict';
const store = require('../store');
const bitcoin = require('../bitcoin');
const { applyGrace, checkinLiveOffsetMs, checkinStatus, graceStatus, mergeExternalCheckin, sanitizeState, startupWarnings } = require('../checkin');
const { DATA_DIR } = require('../config');
const { exchangeStatusFor, priceAgreementPctOf, priceCacheForState, priceSourcesOf } = require('../prices');
const { currentFeesForState, evaluateRelease, feePeakForState, refreshMaraWaiting, refreshPublicFallbacks } = require('../release');
const { checkTriggerNow, triggerStatusFor } = require('../rules');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function stateRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // GET /api/state: the full state (it holds no secrets), plus derived
  // values such as the shared inputs (parsed from the stored hexes, no
  // network), so warnings persist and clear without being stored.
  if (req.method === 'GET' && pathname === '/api/state') {
    // A receiver check-in that landed since the last read is merged
    // first, so the state served is current.
    mergeExternalCheckin(state, now);
    // The grace: judged here too, so a
    // page load reflects it even if no release tick has run since
    // the device came back — held rules cannot fire before the
    // grace is noticed. The stamp is NOT refreshed on a read
    // (only the tick does that), so the gap stays honest.
    try {
      let changed = false;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('grace apply failed:', e); }
    const served = sanitizeState(state);
    // The fee history is state-internal — the raw hourly
    // observations (~2,160 entries) are never served; the peak,
    // window, count, and basis below describe them. Serving the
    // series would bloat every state read for data the UI never
    // renders.
    delete served.feeHistory;
    // Persistence / startup warnings for the UI (a later
    // increment renders them): a state recovery that happened in
    // this process, a receiver key list rewritten at startup, keys
    // orphaned in the receiver, or keys found in a backup. Empty
    // on a healthy run.
    served.warnings = startupWarnings.concat(store.getStateWarnings());
    served.grace = graceStatus(state, now); // the grace: null when none is active, else { active, indefinite, graceUntil, triggeredAt, offlineGapDays }
    served.bitcoin.overlaps = bitcoin.findSharedInputs(state.bitcoin.txs || []);
    // The fee peak, derived from the stored readings on every read (never
    // stored). Null while fewer than 24 readings exist: no verdict
    // anywhere.
    const fp = feePeakForState(state);
    served.bitcoin.feePeak = fp.peak;
    served.bitcoin.feePeakWindowDays = fp.windowDays;
    served.bitcoin.feePeakObservations = fp.observations;
    served.bitcoin.feePeakBasis = fp.basis;
    served.bitcoin.feePeakAt = fp.fetchedAt;
    // The current recommended fees: the cached object (or
    // null when there is no usable current-fee data), with the
    // fetched-at timestamp. The frontend compares each active tx's
    // own fee rate to the economy fee for the Critical Risk check;
    // a null object means the check is skipped and only the
    // historical ladder runs.
    const cf = currentFeesForState();
    served.bitcoin.currentFees = cf.fees;
    served.bitcoin.currentFeesAt = cf.fetchedAt;
    // The BTC price: the cached price (or nulls when
    // nothing has been fetched yet), so a price rule's "currently
    // $X" line is live on the card. currentPrices is the
    // per-source readings map (for the Settings display); the
    // provider list is served so the Settings selects always
    // match the registry.
    const pc = priceCacheForState(priceAgreementPctOf(state.settings));
    served.bitcoin.currentPrice = pc.price;
    served.bitcoin.currentPriceAt = pc.fetchedAt;
    served.bitcoin.currentPrices = pc.prices;
    served.bitcoin.priceProviders = bitcoin.PRICE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })).concat([{ id: 'custom', label: 'Custom' }]);
    // The consolidated exchange status: one status for
    // the configured price sources, shown once on the readiness
    // card (like Node Status) instead of repeated per price tx.
    served.bitcoin.exchangeStatus = exchangeStatusFor(pc, priceSourcesOf(state.settings), priceAgreementPctOf(state.settings));
    // The inputs/outputs detail: derived from
    // the stored hexes on every read, like the overlaps — never
    // stored, so no migration and no restore change. An unparseable
    // hex (defensive only — adds and restores validate) gets no
    // detail, and the card falls back to the plain counts.
    for (const t of served.bitcoin.txs || []) {
      try { t.detail = bitcoin.txIoDetail(bitcoin.parseTx(t.hex)); }
      catch { t.detail = null; }
      // The trigger, normalized (a legacy tx reads as check-in), with its
      // status from the stored evaluation (no network; check-in is live
      // clock math). A one-rule set is served as its single rule, with a
      // flat slice.
      t.triggerStatus = triggerStatusFor(state, t, now);
      const servedSet = store.triggerOf(t);
      t.trigger = store.serveTrigger(servedSet);
      t.triggerState = store.serveTriggerState(servedSet, t.triggerState);
    }
    // Trigger sets are served the same way as txs: the
    // trigger in the dual shape, its current status computed from
    // the stored evaluation (no network on a read). The members
    // ride in served.bitcoin.txs as usual — the frontend joins
    // them by the set's txIds.
    for (const s of served.bitcoin.sets || []) {
      s.triggerStatus = triggerStatusFor(state, s, now);
      const servedSetT = store.triggerOf(s);
      s.trigger = store.serveTrigger(servedSetT);
      s.triggerState = store.serveTriggerState(servedSetT, s.triggerState);
    }
    return sendJson(res, 200, served);
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    const merged = mergeExternalCheckin(state, now);
    // The grace: see GET /api/state — the
    // card reads this endpoint, so the grace must be judged here too.
    try {
      let changed = false;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('grace apply failed:', e); }
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...checkinStatus(state, now),
      lastCheckinAt: state.checkin.lastCheckinAt,
      totalCheckins: state.checkin.totalCheckins,
      // Whether the receiver's
      // check-in file could not be read. A missing file is NOT an
      // error (no receiver installed); an unreadable one means the
      // release evaluation is withheld until it can be read again.
      checkinReadError: merged === 'error',
      bitcoinEnabled: txs.some((t) => t.enabled),
      bitcoinTxStored: txs.length > 0,
      primaryApiUrl: state.settings.primaryApiUrl,
      secondaryApiUrl: state.settings.secondaryApiUrl,
      // Per-tx release records (only txs with one) — the cycle-scoped
      // ones are cleared by a check-in, but a stale record survives
      // (it is a fact about the inputs, not the cycle).
      releases: txs.filter((t) => t.release).map((t) => ({
        id: t.id, txid: t.txid, label: t.label || '', ...t.release,
      })),
    });
  }

  // GET /api/checkins
  if (req.method === 'GET' && pathname === '/api/checkins') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, store.readCheckins(DATA_DIR, 50).reverse());
  }

  // GET /api/broadcast/log — dry-runs, broadcasts, release attempts.
  if (req.method === 'GET' && pathname === '/api/broadcast/log') {
    return sendJson(res, 200, store.readBroadcastLog(DATA_DIR, 50).reverse());
  }

  // POST /api/release/check — run the release evaluation now (the full tick runs the same evaluation on the cadence).
  // A receiver check-in is merged inside evaluateRelease first,
  // so a check-in that arrived since the last read is honoured here too.
  if (req.method === 'POST' && pathname === '/api/release/check') {
    const r = await evaluateRelease();
    // MARA-waiting transactions: refresh after the
    // evaluation, so a tx MARA just dropped is retried on the next
    // evaluation, not in this one. The response below is read from
    // fresh state, so it already reflects the refresh.
    try { await refreshMaraWaiting(store.loadState(DATA_DIR)); } catch (e) { console.error('MARA-waiting refresh failed:', e); }
    // Public fallback: after the MARA refresh, so a tx
    // MARA just confirmed as visible is not also fallback-broadcast.
    // Runs regardless of the check-in clock — a due fallback fires
    // even while the clock is on-track.
    let fallbacks = [];
    try { fallbacks = await refreshPublicFallbacks(store.loadState(DATA_DIR)); } catch (e) { console.error('public-fallback refresh failed:', e); }
    state = store.loadState(DATA_DIR);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...r,
      fallbacks,
      status: checkinStatus(state, now),
      releases: txs.filter((t) => t.release).map((t) => ({ id: t.id, txid: t.txid, label: t.label || '', ...t.release })),
    });
  }

  // POST /api/triggers/check { trigger, txId? }: evaluate once, live,
  // without changing state, so the form can warn that a condition is
  // already satisfied. txId makes a check-in rule use that tx's frozen
  // time. Invalid triggers are a 400; unreadable ones are unknown, never a
  // fire.
  if (req.method === 'POST' && pathname === '/api/triggers/check') {
    const body = await readBody(req).catch(() => ({}));
    const v = store.normalizeTrigger(body.trigger);
    if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
    // The frozen time for the tx being edited, if any — only a
    // check-in rule reads it (checkTriggerNow takes it as the
    // clock's live offset); a price or UTXO rule ignores it.
    let liveOff = 0;
    if (typeof body.txId === 'string' && body.txId) {
      const etx = (state.bitcoin.txs || []).find((t) => t.id === body.txId);
      if (etx) {
        liveOff = checkinLiveOffsetMs(etx, now);
      }
    }
    try {
      const r = await checkTriggerNow(v.trigger, state, now, { liveOffsetMs: liveOff });
      return sendJson(res, 200, { ...r, trigger: store.serveTrigger(v.trigger) });
    } catch (e) {
      // Belt-and-braces: checkTriggerNow already answers 'unknown'
      // on a fetch failure, so a throw here is a bug — but it must
      // still answer 'unknown', never crash the check.
      return sendJson(res, 200, { valid: true, fire: false, status: 'unknown', reason: 'could not check the trigger — will retry', warning: null, detail: { error: e.message }, trigger: store.serveTrigger(v.trigger) });
    }
  }
  return NEXT;
};
