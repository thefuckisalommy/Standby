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
    // Judge the grace on reads too, so a page load shows it before any
    // tick has run. Reads never refresh the stamp, so the gap stays
    // honest.
    try {
      let changed = false;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('grace apply failed:', e); }
    const served = sanitizeState(state);
    // The raw fee history is never served (the peak and its window
    // describe it).
    delete served.feeHistory;
    served.bitcoin.nodeBases = bitcoin.nodeBases(state.settings);
    // Persistence and startup warnings (empty on a healthy run).
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
    // Current fees with fetchedAt, or null (then the frontend skips the
    // Critical check).
    const cf = currentFeesForState();
    served.bitcoin.currentFees = cf.fees;
    served.bitcoin.currentFeesAt = cf.fetchedAt;
    // Cached price and per-source readings (nulls before the first fetch),
    // plus the provider list for the Settings selects.
    const pc = priceCacheForState(priceAgreementPctOf(state.settings));
    served.bitcoin.currentPrice = pc.price;
    served.bitcoin.currentPriceAt = pc.fetchedAt;
    served.bitcoin.currentPrices = pc.prices;
    served.bitcoin.priceProviders = bitcoin.PRICE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })).concat([{ id: 'custom', label: 'Custom' }]);
    // One exchange status for the readiness card.
    served.bitcoin.exchangeStatus = exchangeStatusFor(pc, priceSourcesOf(state.settings), priceAgreementPctOf(state.settings));
    // Inputs/outputs detail derived from the hex on every read (never
    // stored); none for an unparseable hex.
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
    // Sets are served like txs (dual-shape trigger, status from the stored
    // evaluation); members stay in bitcoin.txs, joined by txIds.
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
      // Whether the receiver's check-in file is unreadable (missing is
      // fine); while it is, releases are withheld.
      checkinReadError: merged === 'error',
      bitcoinEnabled: txs.some((t) => t.enabled),
      bitcoinTxStored: txs.length > 0,
      primaryApiUrl: state.settings.primaryApiUrl,
      secondaryApiUrl: state.settings.secondaryApiUrl,
      nodeBases: bitcoin.nodeBases(state.settings),
      // Release records per tx (a check-in clears cycle records; stale
      // ones stay).
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

  // POST /api/release/check: run the release evaluation now (the full tick
  // runs the same on its cadence); a receiver check-in is merged first.
  if (req.method === 'POST' && pathname === '/api/release/check') {
    const r = await evaluateRelease();
    // Refresh MARA-waiting txs after the evaluation, so a dropped tx
    // retries next time; the response reads fresh state.
    try { await refreshMaraWaiting(store.loadState(DATA_DIR)); } catch (e) { console.error('MARA-waiting refresh failed:', e); }
    // Then the public fallback (after the MARA refresh), whatever the
    // clock.
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
    // The edited tx's frozen time, used only by check-in rules.
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
      // checkTriggerNow already answers unknown on fetch failures; a throw
      // is a bug, still answered as unknown.
      return sendJson(res, 200, { valid: true, fire: false, status: 'unknown', reason: 'could not check the trigger — will retry', warning: null, detail: { error: e.message }, trigger: store.serveTrigger(v.trigger) });
    }
  }
  return NEXT;
};
