'use strict';
// Standby — trigger rule evaluation + broadcast (split from server.js, 0.8.7.3).
const store = require('./store');
const bitcoin = require('./bitcoin');
const { caches } = require('./caches');
const { checkinClock, checkinLiveOffsetMs, isGraceActive } = require('./checkin');
const { DATA_DIR } = require('./config');
const { forwardMemberHistory, noteSetMemberStale, pushHistory, recordRelease, shortTxid } = require('./history');
const { PRICE_JUMP_WINDOW_MS, checkCadenceSecondsOf, fetchNodeFeesCached, fetchPriceCached, fetchTipHeightsCached, priceAgreementPctOf, priceSourcesOf } = require('./prices');
const { releaseTriggerFor, singleTriggerConditionText, toTriggerSet, triggerConditionText, triggerLabel } = require('./triggers');
const { days } = require('./util');

// The triggerState shape (0.8.0, per-rule 0.8.2): tx.triggerState
// is an array parallel to the rules (index-keyed); every evaluation
// writes one rule's slice, with all of these fields, null when a
// field does not apply to the type — so the shape is stable across
// types and the UI can read it blind.
//   lastEvalAt — when the rule was last evaluated (ISO)
//   status / reason — the status word + the human-readable state
//   lastPrice / lastPriceAt — the last GOOD price reading (price only)
//   lastOutspend — { spent, confirmed, txid, checkedAt } (UTXO only)
//   lastError — the last fetch failure, if any (else null)
// ruleTriggerState(tx, i) reads one slice (null when the rule was
// never evaluated); setRuleTriggerState(tx, i, slice) writes one,
// growing the array with nulls when a legacy flat state is being
// normalized (loadState wraps it first, so this is defensive).
function freshTriggerState(now, status, reason) {
  return {
    lastEvalAt: now.toISOString(), status, reason,
    lastPrice: null, lastPriceAt: null, lastOutspend: null, lastError: null,
  };
}
function ruleTriggerState(tx, i) {
  const arr = (tx && Array.isArray(tx.triggerState)) ? tx.triggerState : null;
  if (!arr) return null;
  const s = arr[i];
  return (s && typeof s === 'object') ? s : null;
}
function setRuleTriggerState(tx, i, slice) {
  if (!tx) return;
  if (!Array.isArray(tx.triggerState)) tx.triggerState = [];
  while (tx.triggerState.length <= i) tx.triggerState.push(null);
  tx.triggerState[i] = slice;
}

// The check-in rule: the same clock as checkinStatus, at this
// rule's own threshold (a rule with a 7-day threshold fires on its
// own 7-day window, not the global 35). Pure clock math — no
// vacation handling here (the evaluator holds it; the gate ignores
// it — see evaluateRule / checkTriggerNow). The clock is measured
// with the tx's live freeze offset, so a frozen clock is never
// release-due while inactive. The grace gate sits in
// evaluateRule, above this: during a grace this function is not
// called for a release evaluation at all, so a past-due clock
// here means the rule really is due.
function checkCheckinRule(state, rule, now, ctx) {
  const clock = checkinClock(state, now, rule.params.thresholdDays, ctx && ctx.liveOffsetMs);
  const detail = { daysSince: clock.daysSince, nextDue: clock.nextDue };
  if (clock.state === 'not-started') {
    return { fire: false, status: 'not-started', reason: 'No check-in recorded yet', slice: freshTriggerState(now, 'not-started', 'No check-in recorded yet'), detail, warning: null };
  }
  if (clock.state === 'release-due') {
    return { fire: true, status: 'release-due', reason: 'Release due', slice: freshTriggerState(now, 'release-due', 'Release due'), detail, warning: 'This condition is already satisfied — it would fire on the next evaluation.' };
  }
  return { fire: false, status: 'on-track', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', slice: freshTriggerState(now, 'on-track', clock.daysSince + ' of ' + clock.windowDays + ' days elapsed'), detail, warning: null };
}

// The price trigger (0.8.0, two-source 0.8.0). The price is read
// from TWO providers (Settings: priceSources) and combined by
// bitcoin.combinePriceReadings: the reading is only trusted when
// the two agree within the configured agreement (Settings: Price
// agreement); when they agree, the PRIMARY exchange's price is
// the one that decides (the secondary is only a fallback); when
// only one source answers, that price is used alone (no
// agreement check).
// Guards, in order:
//   (a) Immediate fire: the EFFECTIVE price crossing the
//       threshold (at/above, or at/below) fires at once — no
//       sustained wait. The protection against a bad reading is
//       the two-source agreement (below), not a time delay.
//   (b) Fail-safe: a reading that is not valid — the sources
//       disagree by more than the configured agreement, or
//       neither answers — does not fire, marks 'unknown', and
//       keeps the last good state (so a bad reading cannot
//       become the baseline for the jump
//       guard).
//   (c) Sanity bounds on the READING: a price outside
//       $1–$100,000,000 is bad data, not a market move — do not
//       fire on it, and do not let it become the baseline for the
//       jump guard (lastPrice keeps the last GOOD reading). The
//       provider fetch already refuses out-of-bounds prices; this
//       is the safety net on the effective price.
//   (d) The 10x-jump guard: a price that moved 10x since the last
//       GOOD reading is a bad feed, not a market move — but only
//       when the last reading is recent (within an hour). Over a
//       longer gap a real 10x move is possible (the app was off
//       for months), so an old baseline does not veto a new price.
async function checkPriceRule(state, rule, now, ctx) {
  const p = rule.params;
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // The last GOOD state, kept across unknown readings (fail-safe):
  // a disagreement or outage never fires the rule.
  const keepGood = {
    lastPrice: (typeof prev.lastPrice === 'number' && Number.isFinite(prev.lastPrice)) ? prev.lastPrice : null,
    lastPriceAt: (typeof prev.lastPriceAt === 'string' && prev.lastPriceAt) ? prev.lastPriceAt : null,
  };
  let readings;
  try { readings = await fetchPriceCached(priceSourcesOf(state.settings), checkCadenceSecondsOf(state.settings)); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'price unavailable — will retry',
      slice: {
        ...freshTriggerState(now, 'unknown', 'price unavailable — will retry'),
        ...keepGood, lastError: e.message, priceMode: 'none', priceNote: '',
      },
      detail: { error: e.message }, warning: null,
    };
  }
  const comb = bitcoin.combinePriceReadings(readings, priceAgreementPctOf(state.settings));
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: {
        ...freshTriggerState(now, 'unknown', comb.reason),
        ...keepGood, lastError: comb.reason, priceMode: comb.mode, priceNote: '',
      },
      detail: { mode: comb.mode, readings: comb.readings }, warning: null,
    };
  }
  const price = comb.price;
  if (price < store.PRICE_MIN_USD || price > store.PRICE_MAX_USD) {
    return {
      fire: false, status: 'unknown', reason: 'implausible price reading ($' + price.toLocaleString('en-US') + ') — ignored',
      slice: {
        ...freshTriggerState(now, 'unknown', 'implausible price reading ($' + price.toLocaleString('en-US') + ') — ignored'),
        ...keepGood, lastError: 'price out of bounds: $' + price.toLocaleString('en-US'), priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode }, warning: null,
    };
  }
  const lastPrice = keepGood.lastPrice;
  const lastAt = (typeof keepGood.lastPriceAt === 'string' && keepGood.lastPriceAt) ? new Date(keepGood.lastPriceAt).getTime() : NaN;
  if (lastPrice !== null && Number.isFinite(lastAt) && (now.getTime() - lastAt) <= PRICE_JUMP_WINDOW_MS
      && (price > lastPrice * 10 || price < lastPrice / 10)) {
    return {
      fire: false, status: 'unknown', reason: 'implausible price jump ($' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US') + ') — ignored',
      slice: {
        ...freshTriggerState(now, 'unknown', 'implausible price jump ($' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US') + ') — ignored'),
        ...keepGood, lastError: 'price jumped 10x since the last reading: $' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US'), priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode }, warning: null,
    };
  }
  // The reading is good: it becomes the new baseline.
  const holding = p.op === '>=' ? price >= p.value : price <= p.value;
  // The stored reason is trigger-only — the effective price, no
  // per-source note (that lives in priceNote as data, and in the
  // Exchange Status section and dry-run notes for display). The
  // GATE's reason (gateReason) keeps the note — the /api/triggers/check
  // answer names the sources it read ("currently $100,000 (Custom
  // $100,000, Coinbase $98,200)"), as it always has.
  const shown = '$' + price.toLocaleString('en-US');
  const gateShown = 'currently ' + shown + ' (' + comb.note + ')';
  if (!holding) {
    return {
      fire: false, status: 'watching', reason: 'currently ' + shown, gateReason: gateShown,
      slice: {
        ...freshTriggerState(now, 'watching', 'currently ' + shown),
        lastPrice: price, lastPriceAt: now.toISOString(), lastError: null, priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode, note: comb.note }, warning: null,
    };
  }
  // Holding: the effective price is past the threshold and both
  // sources agree — fire at once, no sustained wait.
  return {
    fire: true, status: 'due', reason: 'past threshold — firing', gateReason: gateShown,
    slice: {
      ...freshTriggerState(now, 'due', 'past threshold — firing'),
      lastPrice: price, lastPriceAt: now.toISOString(), lastError: null, priceMode: comb.mode, priceNote: comb.note,
    },
    detail: { price, mode: comb.mode, note: comb.note },
    warning: 'This condition is already satisfied — it would fire on the next evaluation.',
  };
}

// The UTXO trigger (0.8.0). The confirmation mode is per-rule
// (params.confirmations): 0 = fire on an unconfirmed (mempool)
// spend; N >= 1 = fire once the spending tx has N confirmations
// (default 1 — confirmed-only, the original behaviour). Guards:
//   (a) Unconfirmed mode fires on ANY spend — confirmed or not.
//       N-confirmation mode only watches an unconfirmed spend
//       (it may still be evicted or replaced).
//   (b) Confirmations are counted from the tip (tip - spend
//       block height + 1). If the tip cannot be fetched, or the
//       spend's block height is unknown, the trigger is 'unknown'
//       — it never fires on data it cannot count.
//   (c) Fail-safe on fetch failure: an outpoint no endpoint can
//       say about (unknown parent, or no endpoint answering) does
//       not fire, and is marked 'unknown'.
//   (d) The already-spent guard at creation is the add-time gate
//       (see POST /api/bitcoin/txs) and the /api/triggers/check
//       endpoint — not this evaluator.
async function checkUtxoRule(state, rule, now, ctx) {
  const needConfs = (rule.params.confirmations === 0) ? 0 : (rule.params.confirmations || 1);
  const endpoints = bitcoin.endpointsFor(state.settings);
  // (0.8.6) The outspend lookup is cache-backed (shared outpoint
  // cache, TTL = the check cadence) and batch-aware: when this
  // evaluation watches ≥2 outputs of the same funding tx, the
  // evaluation's batch (ctx.utxoBatch, built by
  // evaluateReleaseInner) answers them with one /outspends fetch.
  // Callers without a batch (the single-trigger check endpoint)
  // take the singular path.
  let res;
  try {
    res = await bitcoin.checkOutspend(rule.params.outpoint, endpoints, {
      ttlMs: checkCadenceSecondsOf(state.settings) * 1000,
      batch: (ctx && ctx.utxoBatch) || null,
    });
  }
  catch (e) { res = { unknown: true, error: e.message }; }
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  if (res.unknown) {
    return {
      fire: false, status: 'unknown', reason: 'could not check the outpoint — will retry',
      slice: {
        ...freshTriggerState(now, 'unknown', 'could not check the outpoint — will retry'),
        lastOutspend: (prev.lastOutspend && typeof prev.lastOutspend === 'object') ? prev.lastOutspend : null,
        lastError: res.error || 'outpoint could not be checked',
      },
      detail: { error: res.error || null }, warning: null,
    };
  }
  const lastOutspend = { spent: res.spent, confirmed: res.confirmed, txid: res.txid || null, blockHeight: (res.blockHeight === undefined ? null : res.blockHeight), confirmations: null, checkedAt: now.toISOString() };
  if (!res.spent) {
    return {
      fire: false, status: 'watching', reason: 'still unspent',
      slice: { ...freshTriggerState(now, 'watching', 'still unspent'), lastOutspend, lastError: null },
      detail: { spent: false, confirmed: false }, warning: null,
    };
  }
  // Spent. Unconfirmed mode (0) fires on any spend, confirmed or
  // not — the owner chose the mempool as the trigger.
  if (needConfs === 0) {
    return {
      fire: true, status: 'due', reason: 'spent — firing',
      slice: { ...freshTriggerState(now, 'due', 'spent — firing'), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: res.confirmed, txid: res.txid, confirmations: 0 },
      warning: 'This UTXO is already spent — it would fire on the next evaluation.',
    };
  }
  // N-confirmation mode: an unconfirmed spend only watches.
  if (!res.confirmed) {
    lastOutspend.confirmations = 0;
    const noun = needConfs === 1 ? ' confirmation' : ' confirmations';
    return {
      fire: false, status: 'watching', reason: 'spend unconfirmed — waiting for ' + needConfs + noun,
      slice: { ...freshTriggerState(now, 'watching', 'spend unconfirmed — waiting for ' + needConfs + noun), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: false, txid: res.txid, confirmations: 0 },
      warning: 'This UTXO is already spent (unconfirmed) — it would fire once the spend reaches ' + needConfs + noun + '.',
    };
  }
  // A confirmed spend: count its confirmations from the tip.
  if (res.blockHeight === null || res.blockHeight === undefined || !Number.isFinite(res.blockHeight)) {
    return {
      fire: false, status: 'unknown', reason: 'spend confirmed but its block height is unknown — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'spend confirmed but its block height is unknown — will retry'), lastOutspend, lastError: 'spend block height unknown' },
      detail: { spent: true, confirmed: true, txid: res.txid }, warning: null,
    };
  }
  // (0.8.6) The tip comes from the SHARED per-tick tip cache
  // (fetchTipHeightsCached, same as the block-height rule) — the
  // old direct getTipHeight call cost a second, uncached tip fetch
  // on every confirmed-spend evaluation.
  let tip;
  try {
    const comb = bitcoin.combineTipHeights(await fetchTipHeightsCached(bitcoin.endpointsFor(state.settings), checkCadenceSecondsOf(state.settings)));
    if (!comb.valid) throw new Error(comb.reason);
    tip = comb.tip;
  }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'could not fetch the tip height — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'could not fetch the tip height — will retry'), lastOutspend, lastError: e.message },
      detail: { spent: true, confirmed: true, txid: res.txid, error: e.message }, warning: null,
    };
  }
  const confs = Math.max(0, tip - res.blockHeight + 1);
  lastOutspend.confirmations = confs;
  if (confs >= needConfs) {
    return {
      fire: true, status: 'due', reason: 'spent — ' + confs + (confs === 1 ? ' confirmation' : ' confirmations') + ' — firing',
      slice: { ...freshTriggerState(now, 'due', 'spent — ' + confs + (confs === 1 ? ' confirmation' : ' confirmations') + ' — firing'), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight },
      warning: 'This UTXO is already spent (' + confs + ' confirmations) — it would fire on the next evaluation.',
    };
  }
  return {
    fire: false, status: 'watching', reason: 'spent — ' + confs + ' of ' + needConfs + ' confirmations',
    slice: { ...freshTriggerState(now, 'watching', 'spent — ' + confs + ' of ' + needConfs + ' confirmations'), lastOutspend, lastError: null },
    detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight }, warning: null,
  };
}

// The block-height trigger (0.8.1). Fires when the chain tip
// reaches params.targetHeight — the PRIMARY node's tip is the one
// that counts (the secondary is only a fallback if the primary
// does not answer; a node a block or two ahead is normal
// propagation lag). Judged fresh every evaluation, like every
// other rule (0.8.4: the one-way latch is gone at Ryan's call —
// a reorg that drops the tip below the target un-fires the rule
// again, so a height reached while disarmed, in backoff, or while
// an AND set waits on another rule can be missed). A broadcast
// that already happened is one-shot and never retracted.
// Fail-safe: if neither node answers, the trigger is 'unknown' —
// it never fires on data it cannot read. The grace hold is
// applied one level up, in evaluateRule — this check still
// answers the raw condition (a height reached while the app was
// offline genuinely was reached; the grace only delays firing on
// it until the pause ends).
async function checkBlockHeightRule(state, rule, now, ctx) {
  const target = rule.params.targetHeight;
  let comb;
  try { comb = bitcoin.combineTipHeights(await fetchTipHeightsCached(bitcoin.endpointsFor(state.settings), checkCadenceSecondsOf(state.settings))); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'could not fetch the tip height — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'could not fetch the tip height — will retry'), lastError: e.message, tipMode: 'none', tipNote: '' },
      detail: { error: e.message }, warning: null,
    };
  }
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: { ...freshTriggerState(now, 'unknown', comb.reason), lastError: comb.reason, tipMode: comb.mode, tipNote: '' },
      detail: { error: comb.reason }, warning: null,
    };
  }
  const tip = comb.tip;
  if (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0) {
    return {
      fire: false, status: 'unknown', reason: 'tip height unreadable — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'tip height unreadable — will retry'), lastError: 'tip height is not a number: ' + String(tip), tipMode: comb.mode, tipNote: comb.note },
      detail: { tip: String(tip) }, warning: null,
    };
  }
  if (tip >= target) {
    return {
      fire: true, status: 'due', reason: 'block ' + tip.toLocaleString('en-US') + ' reached — firing',
      slice: { ...freshTriggerState(now, 'due', 'block ' + tip.toLocaleString('en-US') + ' reached — firing'), lastTipHeight: tip, lastError: null, tipMode: comb.mode, tipNote: comb.note },
      detail: { tip, targetHeight: target },
      warning: 'This height has already been reached — it would fire on the next evaluation.',
    };
  }
  return {
    fire: false, status: 'watching', reason: 'block ' + tip.toLocaleString('en-US') + ' of ' + target.toLocaleString('en-US'),
    slice: { ...freshTriggerState(now, 'watching', 'block ' + tip.toLocaleString('en-US') + ' of ' + target.toLocaleString('en-US')), lastTipHeight: tip, lastError: null, tipMode: comb.mode, tipNote: comb.note },
    detail: { tip, targetHeight: target }, warning: null,
  };
}

// The set-date trigger (0.8.1). Fires when the wall clock
// reaches params.fireAt — a pure deadline, regardless of
// check-ins. No network call, so it cannot be 'unknown' except
// on a malformed date (which validation prevents). The grace
// hold is applied one level up, in evaluateRule — this check
// still answers the raw condition (a date passed while the app
// was offline genuinely passed; the grace only delays firing
// on it until the pause ends). The
// "fire unless I check in" snooze variant is a later addition,
// not this rule.
function checkSetDateRule(state, rule, now, ctx) {
  const fireMs = Date.parse(rule.params.fireAt);
  if (!Number.isFinite(fireMs)) {
    return {
      fire: false, status: 'unknown', reason: 'set date is not a valid date — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'set date is not a valid date — will retry'), lastError: 'fireAt is not a valid date: ' + String(rule.params.fireAt) },
      detail: { fireAt: String(rule.params.fireAt) }, warning: null,
    };
  }
  if (now.getTime() >= fireMs) {
    return {
      fire: true, status: 'due', reason: 'date reached — firing',
      slice: { ...freshTriggerState(now, 'due', 'date reached — firing'), lastError: null },
      detail: { fireAt: rule.params.fireAt },
      warning: 'This date has already passed — it would fire on the next evaluation.',
    };
  }
  const d = new Date(fireMs);
  const shown = d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return {
    fire: false, status: 'watching', reason: 'fires on ' + shown,
    slice: { ...freshTriggerState(now, 'watching', 'fires on ' + shown), lastError: null },
    detail: { fireAt: rule.params.fireAt }, warning: null,
  };
}

// The fee-market trigger (0.8.1). Fires when the economy fee
// rate crosses params.maxFeeRate (sat/vB) in the direction the
// owner chose: 'below' fires when the fee falls to or below it,
// 'above' fires when it rises to or above it. The threshold is
// user-set; the tx's own fee rate is not consulted — the rule
// fires on the market rate alone. The fee comes from BOTH
// configured nodes (combineFeeReadings) but NO agreement check:
// the PRIMARY node's fee is the one that counts — the secondary
// is only a fallback if the primary is down. One node down means
// the other is used alone, with no agreement check. No 10x-jump
// guard: fee spikes are real and are exactly what an 'above' rule
// is for — the guard would block the trigger from doing its job.
// The fee comes from the cached fetch (TTL = 5 minutes),
// so the trigger may see a move up to 5 minutes late. Fail-safe: if no
// usable fee can be read, the trigger is 'unknown' — it never
// fires on data it cannot read. The grace hold is applied one
// level up, in evaluateRule — this check still answers the raw
// condition (a fee move while the app was offline genuinely
// happened; the grace only delays firing on it until the pause
// ends).
async function checkFeeMarketRule(state, rule, now, ctx) {
  const maxRate = rule.params.maxFeeRate;
  const dir = rule.params.direction === 'above' ? 'above' : 'below';
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // The last GOOD fee, kept across unknown readings (fail-safe):
  // a disagreement or outage never fires the rule, and the
  // subcard keeps showing the last fee it could trust.
  const keepGood = {
    lastEconomyFee: (typeof prev.lastEconomyFee === 'number' && Number.isFinite(prev.lastEconomyFee)) ? prev.lastEconomyFee : null,
  };
  let readings;
  try { readings = await fetchNodeFeesCached(bitcoin.endpointsFor(state.settings)); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'fee unavailable — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'fee unavailable — will retry'), ...keepGood, lastError: e.message, feeMode: 'none', feeNote: '' },
      detail: { error: e.message }, warning: null,
    };
  }
  const comb = bitcoin.combineFeeReadings(readings);
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: { ...freshTriggerState(now, 'unknown', comb.reason), ...keepGood, lastError: comb.reason, feeMode: comb.mode, feeNote: '' },
      detail: { mode: comb.mode, error: comb.reason }, warning: null,
    };
  }
  const econ = comb.fee;
  const fired = dir === 'above' ? econ >= maxRate : econ <= maxRate;
  if (fired) {
    return {
      fire: true, status: 'due', reason: 'economy fee ' + econ + ' sat/vB — firing',
      slice: { ...freshTriggerState(now, 'due', 'economy fee ' + econ + ' sat/vB — firing'), lastEconomyFee: econ, lastError: null, feeMode: comb.mode, feeNote: comb.note },
      detail: { economyFee: econ, maxFeeRate: maxRate, direction: dir },
      warning: 'The economy fee is already at or ' + dir + ' your threshold — it would fire on the next evaluation.',
    };
  }
  const side = dir === 'above' ? 'below ' : 'above ';
  return {
    fire: false, status: 'watching', reason: 'economy fee ' + econ + ' sat/vB (' + side + maxRate + ')',
    slice: { ...freshTriggerState(now, 'watching', 'economy fee ' + econ + ' sat/vB (' + side + maxRate + ')'), lastEconomyFee: econ, lastError: null, feeMode: comb.mode, feeNote: comb.note },
    detail: { economyFee: econ, maxFeeRate: maxRate, direction: dir }, warning: null,
  };
}

// Dispatch by rule type. Returns the check function's result
// { fire, status, reason, slice, detail, warning } — no state is
// written here (the caller stores the slice). The manual rule never
// fires — the owner broadcasts it by hand.
async function checkRule(state, rule, now, ctx) {
  switch (rule.type) {
    case 'checkin': return checkCheckinRule(state, rule, now, ctx);
    case 'price': return await checkPriceRule(state, rule, now, ctx);
    case 'utxo': return await checkUtxoRule(state, rule, now, ctx);
    case 'blockheight': return await checkBlockHeightRule(state, rule, now, ctx);
    case 'setdate': return checkSetDateRule(state, rule, now, ctx);
    case 'feemarket': return await checkFeeMarketRule(state, rule, now, ctx);
    case 'manual': return checkManualRule(state, rule, now, ctx);
    default: return checkCheckinRule(state, rule, now, ctx);
  }
}

function checkManualRule(state, rule, now, ctx) {
  return {
    fire: false, status: 'manual', reason: 'Waiting for manual broadcast',
    slice: freshTriggerState(now, 'manual', 'Waiting for manual broadcast'),
    detail: {}, warning: null,
  };
}

// Evaluate ONE rule of a tx, applying the evaluator-only holds,
// and write the rule's triggerState slice when the check produces
// one. Returns { rule, fire, status, reason, held, slice } — held
// is null | 'grace' | 'vacation'.
//   Grace (0.8.0, extended 0.8.8, unified 0.8.8): while it is
//     active, a price, UTXO, block-height, set-date, fee-market,
//     or check-in rule is not evaluated at all — it cannot fire,
//     and its stored slice keeps the last real evaluation (so
//     the subcard's current-state line still shows the live
//     condition; only the pill says Grace). No network calls
//     happen for it during the grace. The release-check result
//     carries status 'grace' so the hold is named there. Grace
//     is PER RULE: in an OR set a non-held rule can still fire
//     during a grace; in an AND set a held rule is not
//     satisfied, so the set cannot fire. Check-in rules are
//     held by the same grace as everything else now — the old
//     separate offline-gap hold is gone, and the due date is
//     NOT pushed out (the bar reads the plain clock; the
//     grace state, not a past-due reading, is what the bar
//     shows while held — see checkinStatus). Manual rules
//     never fire anyway.
//   Vacation (0.8.0): while it is on, a check-in rule does not
//     fire — its slice records 'vacation', and the release holds
//     it. Vacation touches check-in rules only; price, UTXO and
//     the other rules keep firing. Vacation is PER RULE too: an OR
//     set can still fire via a non-check-in rule while on vacation.
async function evaluateRule(state, tx, ruleIndex, now, utxoBatch) {
  const set = store.triggerOf(tx);
  const rule = set.rules[ruleIndex];
  const prevSlice = ruleTriggerState(tx, ruleIndex);
  if ((rule.type === 'checkin' || rule.type === 'price' || rule.type === 'utxo' || rule.type === 'blockheight' || rule.type === 'setdate' || rule.type === 'feemarket') && isGraceActive(state, now)) {
    return { rule, fire: false, status: 'grace', reason: 'grace period active — will evaluate when it ends', held: 'grace', slice: null };
  }
  if (rule.type === 'checkin' && state.settings.vacationMode) {
    const slice = freshTriggerState(now, 'vacation', 'Vacation mode is on');
    setRuleTriggerState(tx, ruleIndex, slice);
    return { rule, fire: false, status: 'vacation', reason: 'Vacation mode is on', held: 'vacation', slice };
  }
  const r = await checkRule(state, rule, now, {
    prevSlice,
    liveOffsetMs: checkinLiveOffsetMs(tx, now),
    utxoBatch: utxoBatch || null,
  });
  if (r.slice) setRuleTriggerState(tx, ruleIndex, r.slice);
  return { rule, fire: r.fire, status: r.status, reason: r.reason, held: null, slice: r.slice || null };
}

// Combine the per-rule outcomes by the set's op. Each outcome is
// { index, fire, status, reason, held, skipped, cls } — cls is the
// outcome class: 'satisfied' (the rule fired), 'not' (it did not,
// and was read), 'unknown' (it could not be read — fail-safe), or
// 'held' (grace / vacation / offline-hold — read, but held back).
// `skipped` means the rule was not evaluated this tick. No caller
// skips any more (0.8.2 — the type filter is gone, the full tick
// evaluates everything); the class is kept as a defensive reading:
// a skipped rule is not satisfied, so an AND set cannot fire on a
// tick that did not evaluate all of it, while an OR set only needs
// one evaluated rule to fire.
//   OR: fire iff any evaluated rule is SATISFIED; unknowns are
//     ignored — a setdate rule still fires while its sibling price
//     rule cannot be read.
//   AND: fire iff EVERY rule is SATISFIED at this same tick —
//     "all at once" (Ryan, Nov 18), no per-rule latching.
//     Any UNKNOWN, HELD, or SKIPPED rule blocks it.
// The combined status is the tx-level word: a one-rule set reads
// exactly as its single rule did ('on-track', 'grace', 'due',
// ...); a multi-rule set reads 'due' | 'unknown' | 'grace' |
// 'vacation' | 'held' | 'watching' (unknown beats held — a rule
// that cannot be read is the more urgent fact).
// Returns { fire, status, reason, firedIndexes } — firedIndexes
// are the rule indexes that fired, so the history event can name
// them.
function combineOutcomes(set, outcomes) {
  const evaluated = outcomes.filter((o) => !o.skipped);
  const fired = evaluated.filter((o) => o.cls === 'satisfied');
  const firedIndexes = fired.map((o) => o.index);
  let fire = false;
  if (set.op === 'OR') fire = fired.length > 0;
  else fire = evaluated.length === set.rules.length && evaluated.every((o) => o.cls === 'satisfied');
  if (set.rules.length === 1) {
    const o = outcomes[0];
    return { fire: o.fire, status: o.status, reason: o.reason, firedIndexes: o.fire ? [0] : [] };
  }
  let status, reason;
  if (fire) {
    status = 'due';
    reason = fired.map((o) => o.reason).join(' + ');
  } else if (evaluated.some((o) => o.cls === 'unknown')) {
    const u = evaluated.find((o) => o.cls === 'unknown');
    status = 'unknown';
    reason = u.reason;
  } else if (evaluated.some((o) => o.held === 'grace')) {
    status = 'grace';
    reason = 'grace period active — will evaluate when it ends';
  } else if (evaluated.some((o) => o.held === 'vacation')) {
    status = 'vacation';
    reason = 'Vacation mode is on';
  } else if (evaluated.some((o) => o.held === 'held')) {
    const h = evaluated.find((o) => o.held === 'held');
    status = 'held';
    reason = h.reason;
  } else {
    status = 'watching';
    reason = evaluated.map((o) => o.reason).join('; ');
  }
  return { fire, status, reason, firedIndexes };
}

// The outcome class of one evaluated rule: 'satisfied' when it
// fired, 'unknown' when it could not be read, 'held' when a hold
// kept it from firing, else 'not'.
function outcomeClass(r) {
  if (r.fire) return 'satisfied';
  if (r.status === 'unknown') return 'unknown';
  if (r.held) return 'held';
  return 'not';
}

// Evaluate a tx's whole rule set (0.8.2). Returns { fire, status,
// reason, ruleResults, firedIndexes } and writes each evaluated
// rule's triggerState slice (the caller saves). Every rule is
// evaluated, every time — there is no type filter any more
// (0.8.2): the full tick judges all types together, so an AND
// set spanning domains (check-in AND price) fires on the tick,
// not only on a manual check. That is what "all at once" needs:
// a tick that did not evaluate a rule cannot claim it held, and
// now every tick evaluates every rule.
async function evaluateTrigger(state, tx, now, utxoBatch) {
  const set = store.triggerOf(tx);
  const ruleResults = [];
  for (let i = 0; i < set.rules.length; i++) {
    const rule = set.rules[i];
    const r = await evaluateRule(state, tx, i, now, utxoBatch);
    ruleResults.push({ index: i, rule, fire: r.fire, status: r.status, reason: r.reason, held: r.held, skipped: false, cls: outcomeClass(r), slice: r.slice });
  }
  const combined = combineOutcomes(set, ruleResults);
  return {
    fire: combined.fire, status: combined.status, reason: combined.reason,
    ruleResults, firedIndexes: combined.firedIndexes,
    firedRuleTypes: combined.firedIndexes.map((i) => set.rules[i].type),
  };
}

// One rule's UI-facing status, computed from its STORED slice (no
// network) — except the check-in rule, whose state is live clock
// math. Returns { type, label, condition, status, reason,
// ...type-specific fields }. The price's "currently $X" line uses
// the cached price when one is available (it is fresher than the
// stored reading). `slice` is the rule's triggerState slice (null
// when it has never been evaluated).
function ruleStatusFor(state, tx, rule, slice, now) {
  const trg = rule;
  const st = slice;
  const base = { type: trg.type, label: triggerLabel(trg), condition: singleTriggerConditionText(trg) };
  if (trg.type === 'checkin') {
    const clock = checkinClock(state, now, trg.params.thresholdDays, checkinLiveOffsetMs(tx, now));
    if (clock.state === 'not-started') return { ...base, status: 'not-started', reason: 'No check-in recorded yet' };
    // Vacation is check-in-only (0.8.0): it freezes this tx's
    // clock and holds its release, and nothing else's.
    if (state.settings.vacationMode) return { ...base, status: 'vacation', reason: 'Vacation mode is on — the countdown is frozen' };
    // (0.8.8) A past-due clock while a grace is active reads
    // 'grace', not 'release-due' — the rule is held, it cannot
    // fire; an on-track clock keeps its countdown (the grace
    // card explains the hold). Mirrors checkinStatus.
    if (isGraceActive(state, now) && clock.state === 'release-due') return { ...base, status: 'grace', reason: 'Grace period active — will evaluate when it ends', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
    if (clock.state === 'release-due') return { ...base, status: 'release-due', reason: 'Release due', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
    return { ...base, status: 'on-track', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
  }
  if (trg.type === 'manual') {
    return { ...base, status: 'manual', reason: 'Waiting for manual broadcast' };
  }
  if (trg.type === 'price') {
    // The cached readings (when they are for the currently
    // configured sources) give the live effective price + source
    // note; otherwise the stored last evaluation carries the
    // price and its note.
    const src = priceSourcesOf(state.settings);
    const cacheOk = caches.price.readings && Object.keys(caches.price.readings).length
      && caches.price.source1Key === bitcoin.priceSourceKey(src.source1) && caches.price.source2Key === bitcoin.priceSourceKey(src.source2);
    let price = null, note = '', mode = null;
    if (cacheOk) {
      const comb = bitcoin.combinePriceReadings(caches.price.readings, priceAgreementPctOf(state.settings));
      if (comb.valid) { price = comb.price; note = comb.note; mode = comb.mode; }
      else {
        // The latest fetch says the reading is not valid (the
        // sources disagree, or neither answers) — the card shows
        // unknown, whatever the last evaluation said. The reason
        // stays generic ('price feed unknown'): the source detail
        // lives in the Exchange Status section and the dry-run
        // notes, not on a per-tx line.
        return { ...base, status: 'unknown', reason: 'price feed unknown', lastPrice: null, priceMode: comb.mode, priceNote: '' };
      }
    }
    const stored = (st && typeof st.lastPrice === 'number' && Number.isFinite(st.lastPrice)) ? st.lastPrice : null;
    const storedNote = (st && typeof st.priceNote === 'string' && st.priceNote) ? st.priceNote : '';
    if (price === null) {
      if (stored === null) {
        if (st && st.status === 'unknown') return { ...base, status: 'unknown', reason: 'price feed unknown', lastPrice: null, priceMode: (st && st.priceMode) || null, priceNote: storedNote };
        return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastPrice: null };
      }
      price = stored; note = storedNote; mode = (st && st.priceMode) || null;
    }
    // The reason is trigger-only — the effective price, no
    // per-source note. The source detail lives in the Exchange
    // Status section (readiness card) and the dry-run notes, not
    // on a per-tx line. The subcard reads lastPrice directly.
    // A holding price is due at once — no sustained wait (the
    // two-source agreement is the guard, not a time delay).
    const shown = '$' + price.toLocaleString('en-US');
    const holding = trg.params.op === '>=' ? price >= trg.params.value : price <= trg.params.value;
    if (!holding) return { ...base, status: 'watching', reason: 'currently ' + shown, lastPrice: price, priceMode: mode, priceNote: note };
    return { ...base, status: 'due', reason: 'past threshold — firing', lastPrice: price, priceMode: mode, priceNote: note };
  }
  if (trg.type === 'utxo') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastOutspend: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'still unspent', lastOutspend: st.lastOutspend || null };
  }
  if (trg.type === 'blockheight') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastTipHeight: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for the height', lastTipHeight: (typeof st.lastTipHeight === 'number' ? st.lastTipHeight : null) };
  }
  if (trg.type === 'setdate') {
    // Pure clock math — no cache, no network — so a set-date
    // rule reads live even when never evaluated or disarmed,
    // like the price rule below. Mirrors checkSetDateRule's
    // reasons exactly; the stored slice is never consulted.
    const fireMs = Date.parse(trg.params.fireAt);
    if (!Number.isFinite(fireMs)) return { ...base, status: 'unknown', reason: 'set date is not a valid date — will retry' };
    if (now.getTime() >= fireMs) return { ...base, status: 'due', reason: 'date reached — firing' };
    const d = new Date(fireMs);
    const shown = d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { ...base, status: 'watching', reason: 'fires on ' + shown };
  }
  if (trg.type === 'feemarket') {
    // Like price, the fee rule reads the live in-memory
    // node-fee cache when it is warm (same endpoints) — so the
    // pill reflects the market even for a tx that was never
    // evaluated or is disarmed. There is NO age check here, like
    // price: the last known fee is trusted until a fresh reading
    // arrives. (0.8.4: the old cadence-age check expired the
    // cache after one tick, so the pill fell back to Unknown
    // between the hourly refreshes.) Otherwise the stored last
    // evaluation carries it; with neither, the rule is
    // not-evaluated (Unknown), as before.
    const maxRate = trg.params.maxFeeRate;
    const dir = trg.params.direction === 'above' ? 'above' : 'below';
    const eps = bitcoin.endpointsFor(state.settings);
    const feeCacheOk = caches.nodeFee.readings && Object.keys(caches.nodeFee.readings).length
      && caches.nodeFee.primary === (eps[0] ? eps[0].base : null)
      && caches.nodeFee.secondary === (eps[1] ? eps[1].base : null);
    if (feeCacheOk) {
      const comb = bitcoin.combineFeeReadings(caches.nodeFee.readings);
      if (comb.valid) {
        const econ = comb.fee;
        const fired = dir === 'above' ? econ >= maxRate : econ <= maxRate;
        if (fired) return { ...base, status: 'due', reason: 'economy fee ' + econ + ' sat/vB — firing', lastEconomyFee: econ, feeMode: comb.mode, feeNote: comb.note };
        const side = dir === 'above' ? 'below ' : 'above ';
        return { ...base, status: 'watching', reason: 'economy fee ' + econ + ' sat/vB (' + side + maxRate + ')', lastEconomyFee: econ, feeMode: comb.mode, feeNote: comb.note };
      }
      // The latest fetch says no usable reading — the card shows
      // unknown, whatever the last evaluation said (same fail-safe
      // as the price branch above).
      return { ...base, status: 'unknown', reason: comb.reason || 'fee unavailable — will retry', lastEconomyFee: null, feeMode: comb.mode, feeNote: '' };
    }
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastEconomyFee: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for fees to fall', lastEconomyFee: (typeof st.lastEconomyFee === 'number' ? st.lastEconomyFee : null), feeMode: (typeof st.feeMode === 'string' ? st.feeMode : null), feeNote: (typeof st.feeNote === 'string' ? st.feeNote : '') };
  }
  return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet' };
}

// The tx-level trigger status for the UI (0.8.2): a one-rule set
// reads exactly as its single rule did (the object above); a
// multi-rule set reads the same combine as the evaluator — 'due'
// when the set would fire, 'unknown' when a rule cannot be read,
// 'grace' / 'vacation' / 'held' when a hold is the thing stopping
// it, else 'watching' — with one status object per rule under
// `rules`, so the card can list them. A rule never evaluated reads
// 'not-evaluated', which the combine treats as unknown (fail-safe:
// the set cannot be proven satisfied or not).
function triggerStatusFor(state, tx, now) {
  const set = store.triggerOf(tx);
  const statuses = set.rules.map((rule, i) => ruleStatusFor(state, tx, rule, ruleTriggerState(tx, i), now));
  if (set.rules.length === 1) return statuses[0];
  const outcomes = statuses.map((s, i) => {
    const held = s.status === 'grace' ? 'grace' : s.status === 'vacation' ? 'vacation' : s.status === 'held' ? 'held' : null;
    const cls = (s.status === 'due' || s.status === 'release-due') ? 'satisfied'
      : (s.status === 'unknown' || s.status === 'not-evaluated') ? 'unknown'
      : held ? 'held' : 'not';
    return { index: i, rule: set.rules[i], fire: cls === 'satisfied', status: s.status, reason: s.reason, held, skipped: false, cls };
  });
  const combined = combineOutcomes(set, outcomes);
  return {
    type: 'ruleset', op: set.op,
    label: set.op === 'AND' ? 'AND rules' : 'OR rules',
    condition: triggerConditionText(set),
    status: combined.status, reason: combined.reason,
    rules: statuses,
  };
}

// Evaluate a rule set ONCE, live, without changing any state
// (0.8.0, unified 0.8.2): the POST /api/triggers/check endpoint
// (the UI's already-true guard) and the add-time warning use this.
// `trgSet` is a NORMALIZED rule set (the caller validates first —
// a single rule is already wrapped as a one-rule set).
// Returns { valid, fire, status, reason, warning, detail } —
// `warning` is a human-readable string when the set is already
// satisfied (it would fire on the next evaluation), else the first
// per-rule warning (an unconfirmed UTXO spend warns without
// firing), else null. A price rule reports fire=true when both
// sources agree the price is already past the threshold — there is
// no sustained wait, so a single live sample that both sources
// agree on proves the condition. The 10x-jump guard does not apply
// here (it needs a stored baseline — the evaluator owns it); only
// the absolute bounds are checked.
// The gate answers the RAW condition: no grace, no vacation, no
// disarm. A price rule that is past its threshold during a grace,
// or a check-in rule that is due during vacation, still reports
// fire=true — the hold is temporary and the condition itself is
// already met, so adding the rule would fire on the next evaluation
// once the hold lifts. That is the gate's conservative block, and
// it is deliberate: the evaluator (evaluateRule) is the only path
// that applies the holds. `ctx` is { liveOffsetMs }: the tx's
// frozen time for a check-in rule (a txId the caller passes).
// A one-rule set answers exactly as its single rule did (same status / reason / warning / detail); a multi-rule set
// answers the combined fire with the per-rule results in
// detail.rules.
async function checkTriggerNow(trgSet, state, now, ctx) {
  const set = toTriggerSet(trgSet);
  const liveOff = (ctx && typeof ctx.liveOffsetMs === 'number' && Number.isFinite(ctx.liveOffsetMs)) ? ctx.liveOffsetMs : 0;
  const ruleResults = [];
  for (let i = 0; i < set.rules.length; i++) {
    const rule = set.rules[i];
    const r = await checkRule(state, rule, now, {
      prevSlice: null,
      liveOffsetMs: liveOff,
    });
    ruleResults.push({
      index: i, rule, fire: r.fire, status: r.status,
      reason: (typeof r.gateReason === 'string' && r.gateReason) ? r.gateReason : r.reason,
      detail: r.detail || {}, warning: r.warning || null,
      held: null, skipped: false, cls: r.fire ? 'satisfied' : (r.status === 'unknown' ? 'unknown' : 'not'),
    });
  }
  const combined = combineOutcomes(set, ruleResults);
  let warning = null;
  if (set.rules.length === 1) {
    warning = ruleResults[0].warning;
  } else if (combined.fire) {
    warning = 'This rule set is already satisfied — it would fire on the next evaluation.';
  } else {
    const w = ruleResults.find((r) => r.warning);
    warning = w ? w.warning : null;
  }
  const detail = set.rules.length === 1
    ? ruleResults[0].detail
    : { rules: ruleResults.map((r) => ({ fire: r.fire, status: r.status, reason: r.reason, detail: r.detail })) };
  return { valid: true, fire: combined.fire, status: combined.status, reason: combined.reason, warning, detail };
}

// Re-verify, against freshly loaded state, that a broadcast is still
// wanted — right before the real broadcast. This closes the race where
// a check-in, a disable, or a replacement lands while the
// input check is waiting on the network, and the original evaluation
// would otherwise broadcast anyway using its stale state. For the
// automatic release it re-checks the armed toggle, vacation
// (check-in txs only), and that the clock is still release-due; a
// manual broadcast (the owner's explicit say-so) ignores the clock,
// the armed toggle, and vacation, exactly as the endpoints do. Both
// kinds re-check that the transaction still exists, is still the same
// hex, and is neither broadcast nor stale. Returns { ok, reason, state,
// tx } — the fresh state and tx to broadcast from. The broadcast record
// itself is NOT written to this snapshot: broadcastOne reloads fresh
// state again after the network call and merges only the record in
// (see below), so a check-in that lands mid-broadcast survives.
// The clock is NOT re-checked here: the release decision was made
// once, above — all-or-none, 0.7.10 — while the other guards
// above still apply.
function preBroadcastCheck(tx, logKind, opts) {
  const fresh = store.loadState(DATA_DIR);
  const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
  if (!ftx) return { ok: false, reason: 'transaction was deleted' };
  if (ftx.hex !== tx.hex) return { ok: false, reason: 'transaction was replaced' };
  if (ftx.broadcasted || (ftx.release && ftx.release.status === 'broadcast')) return { ok: false, reason: 'already broadcast' };
  if (ftx.release && ftx.release.status === 'stale') return { ok: false, reason: 'transaction is stale — replace it to re-arm' };
  // A transaction already submitted to Slipstream is waiting on
  // MARA — it is not re-submitted (0.7.16). The hourly MARA-waiting
  // refresh (refreshMaraWaiting) is what moves it on: to 'broadcast'
  // once the public nodes see it, or back to 'failed' if MARA drops
  // it, and only then is it attempted again. The ONE exception is
  // the manual "Broadcast publicly" escape hatch (opts.forcePublic):
  // the owner explicitly chose to give up the Slipstream privacy
  // and put this tx in the public mempool, so the wait is over.
  if (ftx.release && ftx.release.status === 'submitted-slipstream' && !(opts && opts.forcePublic)) return { ok: false, reason: 'already submitted to Slipstream — waiting on MARA' };
  if (logKind === 'release') {
    // (0.8.7) A set member broadcasts on the SET's arm, not its
    // own toggle: the set's enabled gates every member, and a
    // member's own enabled is ignored while it is attached.
    // opts.setId names the set the caller is broadcasting for.
    if (opts && opts.setId) {
      const fset = (fresh.bitcoin.sets || []).find((s) => s.id === opts.setId);
      if (!fset || !(fset.txIds || []).includes(tx.id)) return { ok: false, reason: 'transaction is not in its trigger set' };
      if (!fset.enabled) return { ok: false, reason: 'trigger set was disabled' };
    } else if (!ftx.enabled) {
      return { ok: false, reason: 'transaction was disabled' };
    }
    // Vacation is check-in-only (0.8.0): it holds a check-in
    // tx's automatic release, and nothing else's — a price or
    // UTXO tx broadcasts on schedule while the owner is away.
    // Manual broadcasts never enter this branch (logKind
    // 'broadcast'), so they bypass disarm and vacation entirely.
    // (0.8.2) Only a FIRED check-in rule is held: a set that fired
    // on a price rule broadcasts during vacation. When the caller
    // did not name the fired rules (the public-fallback path), a
    // tx that HAS a check-in rule is held, as before.
    const firedTypes = (opts && Array.isArray(opts.firedRuleTypes)) ? opts.firedRuleTypes : null;
    const holdsOnCheckin = firedTypes ? firedTypes.includes('checkin') : store.hasTriggerType(ftx, 'checkin');
    if (fresh.settings.vacationMode && holdsOnCheckin) return { ok: false, reason: 'vacation mode' };
    // All-or-none release (0.7.10): once a release evaluation has
    // decided the clock is due, the whole armed set broadcasts even
    // if a check-in lands mid-run. A check-in is still recorded —
    // the merge-only broadcast write preserves it — and resets the
    // clock for the next cycle; it just does not stop a release that
    // already started. So inside a decided release run the clock is
    // NOT re-checked here; the guards above (disabled, vacation)
    // still apply, because those are explicit owner actions on the
    // transaction or the switch, not the clock.
  }
  return { ok: true, state: fresh, tx: ftx };
}

// ---------------------------------------------------------------------------
// Broadcast ONE transaction for real — the shared path the release and
// the manual buttons (Broadcast Now, Broadcast Armed) both use.
//   1. Freshness gate: re-check every input right before broadcasting.
//      A spent input is three things (0.7.12, third-audit finding 1):
//      our OWN txid as the spender means the transaction is already
//      out there — record 'broadcast' and do NOT re-broadcast it
//      (recognition, not a re-send — the same as a node answering
//      'already in mempool'); a confirmed spend by another tx means
//      the tx is stale — record 'stale' and do NOT broadcast (a stale
//      tx can never broadcast); an unconfirmed spend by another tx is
//      a warning only — it does NOT block the broadcast below, the
//      node is the arbiter.
//   2. Broadcast via the transaction's selected route (0.7.16):
//      'public' broadcasts via the primary node, falling back to
//      the secondary if the primary does not answer; 'slipstream'
//      submits to MARA Slipstream ONLY — no fallback to the public
//      nodes. A successful Slipstream submission records status
//      'submitted-slipstream' (not 'broadcast') and no broadcasted
//      fact: the transaction is in MARA's private mempool, invisible
//      to the public nodes, until refreshMaraWaiting sees it publicly
//      (then 'broadcast') or MARA drops it (then 'failed', retried
//      next tick via Slipstream). Success is recorded once per tx
//      and never repeated, with the endpoint that actually broadcast;
//      failure is recorded as 'failed' and retried on the next tick
//      (a transient network failure must not lose the moment).
// A broadcast records BOTH the cycle release record (tx.release) and
// the permanent broadcasted fact (tx.broadcasted). A check-in clears
// the cycle record and starts a new cycle — but the broadcasted fact
// stays: a broadcast is an on-chain fact, and the card keeps showing
// it (with its confirmation count) until the transaction is replaced.
// `logKind` is 'release' for the automatic release and 'broadcast' for
// a manual broadcast, so the broadcast log distinguishes them.
// Returns the per-tx result { id, txid, label, action, method?, error? }.
// Callers skip already-broadcast and stale txs themselves.
// ---------------------------------------------------------------------------
// Broadcasts in flight, by transaction id — a manual Broadcast Now /
// Broadcast Armed and the automatic release must never broadcast the
// same transaction twice at once (audit finding 6). Only the release
// evaluation has a single-flight lock (0.7.6); the manual endpoints
// call broadcastOne directly, so a double-click or a manual call
// landing during a release could overlap it. broadcastOne claims the
// id for its whole run (freshness gate + network + write); a second
// attempt for the same id is skipped, not queued. The claim is a
// check-and-set with no await in between, so it is atomic on Node's
// single thread, and the finally releases it even if the inner run
// throws.
const broadcastingTxIds = new Set();
async function broadcastOne(state, tx, endpoints, now, logKind, opts) {
  if (broadcastingTxIds.has(tx.id)) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'broadcast already in progress' };
  }
  broadcastingTxIds.add(tx.id);
  try {
    return await broadcastOneInner(state, tx, endpoints, now, logKind, opts);
  } finally {
    broadcastingTxIds.delete(tx.id);
  }
}

async function broadcastOneInner(state, tx, endpoints, now, logKind, opts) {
  const failNote = logKind === 'release'
    ? 'Release check failed before broadcast: '
    : 'Broadcast check failed before broadcast: ';
  // (0.8.0) The trigger type stamped on every release record this
  // broadcast writes — the rule that fired it (or the tx's current
  // trigger, for a manual broadcast). (0.8.2) The caller names the
  // fired rules when it knows them (the release path does); a
  // manual broadcast and the fallback paths name none, so the
  // record carries all of the tx's rule types.
  const trigType = releaseTriggerFor(state, tx, opts && opts.firedRuleTypes);
  let check;
  try {
    check = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints, checkCadenceSecondsOf(state.settings) * 1000);
  } catch (e) {
    // The manual "Broadcast publicly" escape hatch (forcePublic)
    // does NOT write a 'failed' record: the tx stays
    // Slipstream-pending if the public attempt cannot even check
    // its inputs — the failure is surfaced to the owner, and MARA
    // is still holding the tx.
    if (!(opts && opts.forcePublic)) {
      const record = { status: 'failed', kind: logKind, trigger: trigType, txid: tx.txid, method: 'primary', lastAttemptAt: now.toISOString(), error: 'input check failed: ' + e.message };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        pushHistory(ftx, 'failed', ('input check failed: ' + e.message).slice(0, 120));
        forwardMemberHistory(fresh, ftx, 'failed', ('input check failed: ' + e.message).slice(0, 120));
        recordRelease(fresh, ftx, record, {
          ts: now.toISOString(), kind: logKind, status: 'failed', method: 'primary', txid: tx.txid,
          hexPreview: tx.hex.slice(0, 64), note: failNote + e.message,
        });
      }
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: 'input check failed: ' + e.message };
  }
  // Our own txid is the spender (0.7.12, third-audit finding 1):
  // this transaction is already out there — in the mempool or a
  // block — so there is nothing to send. Record it broadcast and
  // report broadcast, never stale, never a warning, regardless of
  // confirmations. The write is merge-only, like the success path
  // below: the broadcasted fact takes precedence over any cycle
  // record, and the hourly confirmation refresh fills in the
  // confirmation count from the block height the outspend reported.
  if (check.own && check.own.length) {
    const own = check.own[0];
    const record = { status: 'broadcast', kind: logKind, trigger: trigType, txid: tx.txid, method: check.checkedVia, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex && !ftx.broadcasted) {
      ftx.broadcasted = {
        txid: tx.txid, broadcastedAt: now.toISOString(), method: check.checkedVia,
        confirmations: null, blockHeight: own.blockHeight != null ? own.blockHeight : null, found: true, checkedAt: now.toISOString(),
      };
      // (0.8.2) The tx is out there — log the broadcast, and the
      // confirmation too when the outspend already names the block.
      pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(tx.txid));
      forwardMemberHistory(fresh, ftx, 'broadcast', 'txid ' + shortTxid(tx.txid));
      if (own.blockHeight != null) {
        pushHistory(ftx, 'confirmed', 'Block ' + own.blockHeight.toLocaleString('en-US'));
        forwardMemberHistory(fresh, ftx, 'confirmed', 'Block ' + own.blockHeight.toLocaleString('en-US'));
      }
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'broadcast', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is already out there — the node reports its own txid as the spending transaction. Recorded as broadcast; nothing was sent.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'broadcast', method: check.checkedVia, alreadyOut: true };
  }
  if (check.spent.length) {
    const spentDesc = check.spent.map((i) => i.prevTxid.slice(0, 12) + ':' + i.prevVout).join(', ');
    // The record survives check-ins: spent inputs are a fact about
    // the transaction, not the cycle (only replacing the hex clears
    // it — a stale transaction can never broadcast).
    const record = { status: 'stale', kind: logKind, trigger: trigType, txid: tx.txid, method: check.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent: ' + spentDesc };
    // Record the stale verdict on the CURRENT transaction only if it
    // is still the same hex; a replacement in the meantime means the
    // old tx is gone and there is nothing to mark stale.
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      pushHistory(ftx, 'stale', record.error);
      // (0.8.7, revised) The set-stale rule: a stale member does
      // NOT archive its set — only itself is marked stale. The
      // set keeps firing for its non-stale members; the stale
      // verdict is noted on the set's shared history.
      noteSetMemberStale(fresh, ftx, record.error);
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'stale', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is stale (inputs spent: ' + spentDesc + ') — broadcast not attempted.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'stale', error: record.error };
  }

  // Broadcast for real — but only after re-verifying against fresh
  // state (see preBroadcastCheck above): a check-in, disable,
  // or replacement that landed while the input check was on the
  // network must stop the broadcast. The route is the transaction's
  // own broadcastVia (0.7.16): 'public' broadcasts via the mempool
  // nodes (primary, then secondary); 'slipstream' submits to MARA
  // Slipstream ONLY. There is no cross-route fallback — if the
  // selected route fails, the transaction is 'failed' and the next
  // evaluation retries that same route. The manual "Broadcast
  // publicly" escape hatch (opts.forcePublic) overrides the route:
  // it always goes public, whatever the stored route says.
  const pre = preBroadcastCheck(tx, logKind, opts);
  if (!pre.ok) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: pre.reason };
  }
  const via = (opts && opts.forcePublic) ? 'public' : (pre.tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public');
  // (0.7.17) The first Slipstream attempt — success or fail — is the
  // deadline anchor for a transaction whose submit keeps failing
  // (case (b) of fallbackDeadline). Record it once, before the
  // network call, so it is set even if the attempt itself throws;
  // never overwrite it after. The success and failure branches below
  // reload fresh state, so this write survives them.
  if (via === 'slipstream') {
    const fresh0 = store.loadState(DATA_DIR);
    const ftx0 = (fresh0.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx0 && ftx0.hex === tx.hex && !ftx0.slipstreamFirstAttemptAt) {
      ftx0.slipstreamFirstAttemptAt = now.toISOString();
      store.saveState(DATA_DIR, fresh0);
    }
  }
  // (0.7.17) The public fallback (refreshPublicFallbacks) passes
  // fallbackDays: its presence means this public broadcast is the
  // automatic fallback for a Slipstream transaction that ran out its
  // timer — the broadcast log must say why it went public, so the
  // note is prefixed onto the broadcast entry broadcastTx writes.
  const fallbackNote = (opts && typeof opts.fallbackDays === 'number')
    ? 'Public fallback: this Slipstream transaction was not publicly visible within ' + opts.fallbackDays + (opts.fallbackDays === 1 ? ' day' : ' days') + ', so Standby broadcast it publicly instead.'
    : null;
  try {
    if (via === 'slipstream') {
      // A successful Slipstream submission is NOT a broadcast yet:
      // the transaction is in MARA's private mempool, invisible to
      // the public nodes. It gets its own release status,
      // 'submitted-slipstream' — a pseudo-pending-but-success state
      // — and NO broadcasted fact (that fact is written only once
      // the public nodes see it, by refreshMaraWaiting). The release
      // is not complete while any transaction is in this state.
      const out = await bitcoin.broadcastViaSlipstream(pre.tx.hex, pre.tx.txid);
      const record = { status: 'submitted-slipstream', kind: logKind, trigger: trigType, txid: out.txid, method: 'slipstream', submittedAt: now.toISOString() };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        ftx.release = record;
        pushHistory(ftx, 'slipstream', 'txid ' + shortTxid(out.txid));
        forwardMemberHistory(fresh, ftx, 'slipstream', 'txid ' + shortTxid(out.txid));
        store.saveState(DATA_DIR, fresh);
      }
      store.appendBroadcastLog(DATA_DIR, {
        ts: now.toISOString(), kind: logKind, status: 'submitted-slipstream', method: 'slipstream', txid: out.txid,
        hexPreview: pre.tx.hex.slice(0, 64),
        note: 'Submitted to MARA Slipstream — waiting for MARA to mine it. Not visible in the public mempool yet.',
      });
      return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'submitted-slipstream', method: 'slipstream' };
    }
    const out = await bitcoin.broadcastTx(DATA_DIR, { hex: pre.tx.hex, txid: pre.tx.txid, endpoints, notePrefix: fallbackNote });
    // Merge-only write (audit finding 1): the broadcast itself was
    // just on the network, and anything may have landed while it was
    // out there — a check-in, a settings change, a disable. Saving
    // pre.state here would overwrite those newer changes (and a lost
    // check-in is exactly how a release could outlive the owner
    // checking in). So reload FRESH state and write only the
    // broadcast record onto the matching transaction. If the tx was
    // deleted or replaced mid-broadcast, there is no record left to
    // mark — the broadcast already went out on-chain and is in the
    // broadcast log — and the deleted/replaced record must NOT be
    // resurrected by saving the old snapshot.
    const record = { status: 'broadcast', kind: logKind, trigger: trigType, txid: out.txid, method: out.method, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      // The escape hatch went public: the stored route follows the
      // tx — it is a public tx now, and if it ever drops back to
      // 'release-due' it retries via the public route.
      if (opts && opts.forcePublic) ftx.broadcastVia = 'public';
      ftx.release = record;
      ftx.broadcasted = {
        txid: out.txid, broadcastedAt: now.toISOString(), method: out.method,
        confirmations: null, blockHeight: null, found: true, checkedAt: null,
      };
      pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(out.txid));
      forwardMemberHistory(fresh, ftx, 'broadcast', 'txid ' + shortTxid(out.txid));
      store.saveState(DATA_DIR, fresh);
    }
    return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'broadcast', method: out.method };
  } catch (e) {
    // A failed attempt (either route) is 'failed' and retried on
    // the next evaluation via the SAME selected route (0.7.14 retry
    // rule). For Slipstream the error carries Slipstream's own
    // rejection reason (a fee below the floor, a sanctions
    // rejection, an invalid tx). The method names the route that
    // failed: 'slipstream' for Slipstream, 'primary' for the public
    // route (the first endpoint tried — the pre-0.7.16 convention).
    // EXCEPT the manual "Broadcast publicly" escape hatch
    // (forcePublic): a failed public attempt does NOT write a
    // 'failed' record — the tx stays Slipstream-pending, still in
    // MARA's queue, and the error is surfaced to the owner instead.
    const record = { status: 'failed', kind: logKind, trigger: trigType, txid: tx.txid, method: via === 'slipstream' ? 'slipstream' : 'primary', lastAttemptAt: now.toISOString(), error: e.message };
    if (!(opts && opts.forcePublic)) {
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        pushHistory(ftx, 'failed', String(e.message || '').slice(0, 120));
        forwardMemberHistory(fresh, ftx, 'failed', String(e.message || '').slice(0, 120));
        recordRelease(fresh, ftx, record, null); // broadcastTx already logged the failure
      }
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: e.message };
  }
}

module.exports = { freshTriggerState, ruleTriggerState, setRuleTriggerState, checkCheckinRule, checkPriceRule, checkUtxoRule, checkBlockHeightRule, checkSetDateRule, checkFeeMarketRule, checkRule, checkManualRule, evaluateRule, combineOutcomes, outcomeClass, evaluateTrigger, ruleStatusFor, triggerStatusFor, checkTriggerNow, preBroadcastCheck, broadcastingTxIds, broadcastOne, broadcastOneInner };
