'use strict';
// Standby — trigger rule evaluation + broadcast.
const store = require('./store');
const bitcoin = require('./bitcoin');
const { caches } = require('./caches');
const { checkinClock, checkinLiveOffsetMs, isGraceActive } = require('./checkin');
const { DATA_DIR } = require('./config');
const deviceClock = require('./clock');
const { forwardMemberHistory, noteSetMemberStale, pushHistory, recordRelease, shortTxid } = require('./history');
const { checkCadenceSecondsOf, fetchNodeFeesCached, fetchPriceCached, fetchTipHeightsCached, priceAgreementPctOf, priceSourcesOf } = require('./prices');
const { releaseTriggerFor, singleTriggerConditionText, toTriggerSet, triggerConditionText, triggerLabel } = require('./triggers');

// tx.triggerState is an array parallel to the rules. Every slice has the
// same fields (null when not applicable), so the UI can read it blind:
// lastEvalAt, status, reason, lastPrice/lastPriceAt (last good price),
// lastOutspend { spent, confirmed, txid, checkedAt }, lastError.
// ruleTriggerState / setRuleTriggerState read and write one slice.
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

// Check-in rule: the check-in clock at this rule's own threshold, with the
// tx's freeze offset (a frozen clock is never due). Pure clock math;
// vacation and grace are applied in evaluateRule, so a past-due clock here
// really is due.
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

// Price rule: two sources combined by combinePriceReadings (agreeing
// within the configured percentage; the primary's price decides; one
// answering source is used alone).
// (a) Crossing the threshold fires at once; the two-source agreement, not
// a delay, guards against bad readings.
// (b) An invalid reading (disagreement or no answer) is unknown, never
// fires, and keeps lastPrice.
// No range check: a large move both sources agree on fires.
async function checkPriceRule(state, rule, now, ctx) {
  const p = rule.params;
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // Keep the last good state across unknown readings: an outage or
  // disagreement never fires, and the card keeps the last trusted price.
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
  const holding = p.op === '>=' ? price >= p.value : price <= p.value;
  // The stored reason is trigger-only (the effective price); the gate's
  // reason (gateReason) also names the sources it read.
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

// UTXO rule. params.confirmations: 0 fires on any spend, including
// mempool; N >= 1 (default 1) once the spender has N confirmations (an
// unconfirmed spend only watches).
// Confirmations are tip - spend height + 1; without a tip or height the
// rule is unknown. An outpoint no endpoint can say about is unknown. The
// already-spent check at creation is the add gate's job, not this
// evaluator's.
async function checkUtxoRule(state, rule, now, ctx) {
  const needConfs = (rule.params.confirmations === 0) ? 0 : (rule.params.confirmations || 1);
  const endpoints = bitcoin.endpointsFor(state.settings);
  // The lookup is cached (TTL = check cadence) and uses the evaluation's
  // batch (ctx.utxoBatch) when one exists.
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
    // An unverified bare spend (the node could not say whether it is
    // confirmed) is treated like an unconfirmed one, but not called one.
    const what = res.unverified ? 'spend not confirmed by the node' : 'spend unconfirmed';
    return {
      fire: false, status: 'watching', reason: what + ' — waiting for ' + needConfs + noun,
      slice: { ...freshTriggerState(now, 'watching', what + ' — waiting for ' + needConfs + noun), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: false, txid: res.txid, confirmations: 0 },
      warning: res.unverified
        ? 'This UTXO is already spent, but the node cannot say whether the spend is confirmed — it would fire once the spend is confirmed with ' + needConfs + noun + '.'
        : 'This UTXO is already spent (unconfirmed) — it would fire once the spend reaches ' + needConfs + noun + '.',
    };
  }
  // A confirmed spend: count from the tip. A bare answer (lib/bitcoin.js
  // resolveBareSpends) proves confirmation but not the block, so the count
  // runs from the tip when this rule first saw it confirmed
  // (lastOutspend.firstSeenConfirmedHeight): never early, exact while
  // watching, late only for spends confirmed before the rule existed or
  // while offline. A spend reading unconfirmed again (reorg) drops the
  // stamp.
  const bareCount = res.bare === true
    && (res.blockHeight === null || res.blockHeight === undefined || !Number.isFinite(res.blockHeight));
  if (!bareCount && (res.blockHeight === null || res.blockHeight === undefined || !Number.isFinite(res.blockHeight))) {
    return {
      fire: false, status: 'unknown', reason: 'spend confirmed but its block height is unknown — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'spend confirmed but its block height is unknown — will retry'), lastOutspend, lastError: 'spend block height unknown' },
      detail: { spent: true, confirmed: true, txid: res.txid }, warning: null,
    };
  }
  // The tip comes from the shared per-tick tip cache, like the block-
  // height rule.
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
  let countFrom = res.blockHeight;
  if (bareCount) {
    const seen = prev.lastOutspend && Number.isFinite(prev.lastOutspend.firstSeenConfirmedHeight)
      ? prev.lastOutspend.firstSeenConfirmedHeight : tip;
    lastOutspend.firstSeenConfirmedHeight = seen;
    countFrom = seen;
  }
  const confs = Math.max(0, tip - countFrom + 1);
  lastOutspend.confirmations = confs;
  // Counted from first sighting, the number is a minimum — the spend
  // may have confirmed earlier — so the wording says "at least".
  const atLeast = bareCount ? 'at least ' : '';
  const seenNote = bareCount ? ' (counted from when Standby first saw the confirmed spend)' : '';
  const confWord = confs === 1 ? ' confirmation' : ' confirmations';
  if (confs >= needConfs) {
    return {
      fire: true, status: 'due', reason: 'spent — ' + atLeast + confs + confWord + ' — firing',
      slice: { ...freshTriggerState(now, 'due', 'spent — ' + atLeast + confs + confWord + ' — firing'), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight },
      warning: 'This UTXO is already spent (' + atLeast + confs + confWord + seenNote + ') — it would fire on the next evaluation.',
    };
  }
  return {
    fire: false, status: 'watching', reason: 'spent — ' + atLeast + confs + ' of ' + needConfs + ' confirmations' + seenNote,
    slice: { ...freshTriggerState(now, 'watching', 'spent — ' + atLeast + confs + ' of ' + needConfs + ' confirmations' + seenNote), lastOutspend, lastError: null },
    detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight }, warning: null,
  };
}

// Block-height rule: fires when the primary's tip reaches
// params.targetHeight (the secondary only as fallback). Judged fresh every
// time with no latch, so a reorg below the target un-fires it. Neither
// node answering is unknown. Grace is applied in evaluateRule; this
// answers the raw condition.
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

// Set-date rule: fires when the clock reaches params.fireAt, regardless of
// check-ins. No network, so never unknown on a valid date. Grace is
// applied in evaluateRule.
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

// Fee-market rule: the economy fee crossing params.maxFeeRate, 'below' or
// 'above' (the tx's own fee is not consulted). The primary's fee counts,
// the secondary is a fallback, no agreement check. Cached up to 5 minutes.
// No usable fee is unknown. Grace is applied in evaluateRule.
async function checkFeeMarketRule(state, rule, now, ctx) {
  const maxRate = rule.params.maxFeeRate;
  const dir = rule.params.direction === 'above' ? 'above' : 'below';
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // Keep the last good fee across unknown readings (fail-safe).
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

// Dispatch by rule type; returns the check's result without writing state.
// Manual never fires.
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

// Evaluate one rule with the evaluator-only holds and write its slice.
// Returns { rule, fire, status, reason, held, slice }; held is null,
// 'grace' or 'vacation'.
// - Grace: every non-manual rule is held without being evaluated (no
//   network); its slice keeps the last real evaluation. Per rule: an OR
//   set can still fire on an unheld rule; a held rule blocks AND. A check-
//   in's due date is not pushed out.
// - Vacation: holds check-in rules only, also per rule.
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
  // Date-based rules trust this device's clock: held while it disagrees
  // with the servers' (lib/clock.js).
  const clockOff = (rule.type === 'checkin' || rule.type === 'setdate') ? deviceClock.problem() : null;
  if (clockOff) {
    const slice = freshTriggerState(now, 'held', clockOff);
    setRuleTriggerState(tx, ruleIndex, slice);
    return { rule, fire: false, status: 'held', reason: clockOff, held: 'held', slice };
  }
  const r = await checkRule(state, rule, now, {
    prevSlice,
    liveOffsetMs: checkinLiveOffsetMs(tx, now),
    utxoBatch: utxoBatch || null,
  });
  if (r.slice) setRuleTriggerState(tx, ruleIndex, r.slice);
  return { rule, fire: r.fire, status: r.status, reason: r.reason, held: null, slice: r.slice || null };
}

// Combine rule outcomes ({ index, fire, status, reason, held, skipped, cls
// }, cls one of satisfied / not / unknown / held) by the set's op:
// - OR: any satisfied rule fires; unknowns are ignored.
// - AND: every rule satisfied on this same tick (no latching); any
//   unknown, held or skipped rule blocks it.
// A one-rule set reads as its rule; a multi-rule set reads due, unknown,
// grace, vacation, held or watching (unknown beats held). Returns { fire,
// status, reason, firedIndexes }.
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

// Outcome class of a rule: 'satisfied', 'unknown', 'held' or 'not'.
function outcomeClass(r) {
  if (r.fire) return 'satisfied';
  if (r.status === 'unknown') return 'unknown';
  if (r.held) return 'held';
  return 'not';
}

// Evaluate a whole rule set and write each evaluated slice (the caller
// saves). Every rule, every time, so an AND set spanning domains fires on
// the tick.
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

// One rule's UI status from its stored slice (no network), except check-in
// (live clock). The price line prefers the cached price when one is
// available.
function ruleStatusFor(state, tx, rule, slice, now) {
  const trg = rule;
  const st = slice;
  const base = { type: trg.type, label: triggerLabel(trg), condition: singleTriggerConditionText(trg) };
  if (trg.type === 'checkin') {
    const clock2 = checkinClock(state, now, trg.params.thresholdDays, checkinLiveOffsetMs(tx, now));
    if (clock2.state === 'not-started') return { ...base, status: 'not-started', reason: 'No check-in recorded yet' };
    // Vacation is check-in-only: it freezes this tx's
    // clock and holds its release, and nothing else's.
    if (state.settings.vacationMode) return { ...base, status: 'vacation', reason: 'Vacation mode is on — the countdown is frozen' };
    if (deviceClock.problem()) return { ...base, status: 'held', reason: deviceClock.problem(), daysSince: clock2.daysSince, windowDays: clock2.windowDays, nextDue: clock2.nextDue };
    // Past due during a grace reads 'grace', not 'release-due' (held,
    // cannot fire); an on-track clock keeps counting. Mirrors
    // checkinStatus.
    if (isGraceActive(state, now) && clock2.state === 'release-due') return { ...base, status: 'grace', reason: 'Grace period active — will evaluate when it ends', daysSince: clock2.daysSince, windowDays: clock2.windowDays, nextDue: clock2.nextDue };
    if (clock2.state === 'release-due') return { ...base, status: 'release-due', reason: 'Release due', daysSince: clock2.daysSince, windowDays: clock2.windowDays, nextDue: clock2.nextDue };
    return { ...base, status: 'on-track', reason: clock2.daysSince + ' of ' + clock2.windowDays + ' days elapsed', daysSince: clock2.daysSince, windowDays: clock2.windowDays, nextDue: clock2.nextDue };
  }
  if (trg.type === 'manual') {
    return { ...base, status: 'manual', reason: 'Waiting for manual broadcast' };
  }
  if (trg.type === 'price') {
    // Cached readings for the configured sources give the live price;
    // otherwise the stored evaluation.
    const src = priceSourcesOf(state.settings);
    const cacheOk = caches.price.readings && Object.keys(caches.price.readings).length
      && caches.price.source1Key === bitcoin.priceSourceKey(src.source1) && caches.price.source2Key === bitcoin.priceSourceKey(src.source2);
    let price = null, note = '', mode = null;
    if (cacheOk) {
      const comb = bitcoin.combinePriceReadings(caches.price.readings, priceAgreementPctOf(state.settings));
      if (comb.valid) { price = comb.price; note = comb.note; mode = comb.mode; }
      else {
        // The latest fetch is invalid (disagreement or no answer):
        // unknown, whatever the last evaluation said. The reason stays
        // generic.
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
    // Trigger-only reason (no per-source note). A holding price is due at
    // once (agreement, not a delay, is the protection).
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
    if (deviceClock.problem()) return { ...base, status: 'held', reason: deviceClock.problem() };
    // Set-date is pure clock math, so it reads live even when never
    // evaluated or disarmed. Same reasons as checkSetDateRule.
    const fireMs = Date.parse(trg.params.fireAt);
    if (!Number.isFinite(fireMs)) return { ...base, status: 'unknown', reason: 'set date is not a valid date — will retry' };
    if (now.getTime() >= fireMs) return { ...base, status: 'due', reason: 'date reached — firing' };
    const d = new Date(fireMs);
    const shown = d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { ...base, status: 'watching', reason: 'fires on ' + shown };
  }
  if (trg.type === 'feemarket') {
    // The fee rule reads the warm node-fee cache like price, with no age
    // check (the last known fee holds until a fresh one arrives);
    // otherwise the stored evaluation; with neither, not evaluated.
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
      // No usable reading in the latest fetch: unknown (same fail-safe as
      // price).
      return { ...base, status: 'unknown', reason: comb.reason || 'fee unavailable — will retry', lastEconomyFee: null, feeMode: comb.mode, feeNote: '' };
    }
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastEconomyFee: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for fees to fall', lastEconomyFee: (typeof st.lastEconomyFee === 'number' ? st.lastEconomyFee : null), feeMode: (typeof st.feeMode === 'string' ? st.feeMode : null), feeNote: (typeof st.feeNote === 'string' ? st.feeNote : '') };
  }
  return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet' };
}

// The cached tip, or null; no age check. Never fetches: the grace card
// must not defeat the grace it reports on.
function tipFromCache(state) {
  const eps = bitcoin.endpointsFor(state.settings);
  const primary = eps[0] ? eps[0].base : null;
  const secondary = eps[1] ? eps[1].base : null;
  if (!caches.nodeTip.readings || !Object.keys(caches.nodeTip.readings).length) return null;
  if (caches.nodeTip.primary !== primary || caches.nodeTip.secondary !== secondary) return null;
  const comb = bitcoin.combineTipHeights(caches.nodeTip.readings);
  return comb.valid ? comb.tip : null;
}

// Would this tx or set fire if the grace lifted? Each rule's raw condition
// without any network call (the grace suspends evaluation):
// - check-in: the live clock (with the vacation freeze)
// - set-date: the clock
// - price, fee-market: served status (warm caches or the stored
//   evaluation)
// - block-height: the cached tip, else the stored slice
// - UTXO: the stored slice only (stale during a grace, by design)
// - manual, unknown, not evaluated: never
// Combined by the set's op.
function wouldFireFor(state, tx, set, statuses, now) {
  const met = set.rules.map((rule, i) => {
    const s = statuses[i];
    if (rule.type === 'manual') return false;
    if (rule.type === 'checkin') {
      const clock = checkinClock(state, now, rule.params.thresholdDays, checkinLiveOffsetMs(tx, now));
      return clock.state === 'release-due';
    }
    if (rule.type === 'blockheight') {
      const tip = tipFromCache(state);
      if (typeof tip === 'number') return tip >= rule.params.targetHeight;
      return s.status === 'due';
    }
    return s.status === 'due';
  });
  if (set.op === 'OR') return met.some(Boolean);
  return met.length === set.rules.length && met.every(Boolean);
}

// Tx-level status for the UI: a one-rule set reads as its rule; a multi-
// rule set uses the evaluator's combine and lists each rule under rules.
// Never-evaluated rules count as unknown.
function triggerStatusFor(state, tx, now) {
  const set = store.triggerOf(tx);
  const statuses = set.rules.map((rule, i) => ruleStatusFor(state, tx, rule, ruleTriggerState(tx, i), now));
  const wouldFire = wouldFireFor(state, tx, set, statuses, now);
  if (set.rules.length === 1) return { ...statuses[0], wouldFire };
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
    rules: statuses, wouldFire,
  };
}

// Evaluate a rule set once, live, without changing state: the add gate and
// POST /api/triggers/check. Returns { valid, fire, status, reason,
// warning, detail }; warning says the set is already satisfied, else the
// first per-rule warning. It answers the raw condition (no grace, vacation
// or disarm): a condition met during a hold would still fire once the hold
// lifts, so the gate blocks it. ctx is { liveOffsetMs } for check-in
// rules. A one-rule set answers as its rule; a multi-rule set lists per-
// rule results in detail.rules.
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

// Re-verify against fresh state right before a real broadcast, so a check-
// in, disarm or replacement during the input check stops it. Automatic:
// re-checks arm and vacation (check-in txs). Manual: ignores clock, arm
// and vacation. Both: the tx still exists with the same hex, not broadcast
// or stale. The clock is not re-checked (the release decision is all-or-
// none). The record is written later, merged into fresh state.
function preBroadcastCheck(tx, logKind, opts) {
  const fresh = store.loadState(DATA_DIR);
  const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
  if (!ftx) return { ok: false, reason: 'transaction was deleted' };
  if (ftx.hex !== tx.hex) return { ok: false, reason: 'transaction was replaced' };
  if (ftx.broadcasted || (ftx.release && ftx.release.status === 'broadcast')) return { ok: false, reason: 'already broadcast' };
  if (ftx.release && ftx.release.status === 'stale') return { ok: false, reason: 'transaction is stale — replace it to re-arm' };
  // A tx already submitted to Slipstream is not re-submitted;
  // refreshMaraWaiting moves it on. The exception is the manual "Broadcast
  // publicly" escape hatch (forcePublic).
  if (ftx.release && ftx.release.status === 'submitted-slipstream' && !(opts && opts.forcePublic)) return { ok: false, reason: 'already submitted to Slipstream — waiting on MARA' };
  if (logKind === 'release') {
    // A set member broadcasts on the set's arm, not its own (opts.setId
    // names the set).
    if (opts && opts.setId) {
      const fset = (fresh.bitcoin.sets || []).find((s) => s.id === opts.setId);
      if (!fset || !(fset.txIds || []).includes(tx.id)) return { ok: false, reason: 'transaction is not in its trigger set' };
      if (!fset.enabled) return { ok: false, reason: 'trigger set was disabled' };
    } else if (!ftx.enabled) {
      return { ok: false, reason: 'transaction was disabled' };
    }
    // Vacation holds only the automatic release of a fired check-in rule
    // (a set that fired on price still broadcasts); manual broadcasts
    // bypass it. Without named fired rules (the fallback path), a tx with
    // any check-in rule is held.
    const firedTypes = (opts && Array.isArray(opts.firedRuleTypes)) ? opts.firedRuleTypes : null;
    const holdsOnCheckin = firedTypes ? firedTypes.includes('checkin') : store.hasTriggerType(ftx, 'checkin');
    if (fresh.settings.vacationMode && holdsOnCheckin) return { ok: false, reason: 'vacation mode' };
    // All-or-none: once a release run has decided, a check-in landing mid-
    // run is recorded (and resets the next cycle) but does not stop it.
    // Disarm and vacation still apply: they are explicit owner actions.
  }
  return { ok: true, state: fresh, tx: ftx };
}

// Broadcast one transaction: the shared path for the release and the
// manual buttons.
// 1. Freshness gate, right before sending: our own txid as spender means
// already out (record broadcast, send nothing); a confirmed foreign spend
// means stale (never sent); an unconfirmed one is only a warning.
// 2. Send via the tx's route: 'public' (primary, then secondary) or
// 'slipstream' (MARA only, no fallback; success records 'submitted-
// slipstream' without a broadcasted fact until the public nodes see it).
// Failure records 'failed' and retries next tick.
// A broadcast records both the cycle record (a check-in clears it) and the
// permanent broadcasted fact. logKind is 'release' or 'broadcast'. Callers
// skip already-broadcast and stale txs.
// In-flight claims: a tx id is claimed for the whole run, so a double
// click or a manual call during a release can never send it twice; a
// second attempt is skipped. The check-and-set has no await, so it is
// atomic.
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
  // The trigger types stamped on this broadcast's records: the fired rules
  // when the caller names them, else all of the tx's types.
  const trigType = releaseTriggerFor(state, tx, opts && opts.firedRuleTypes);
  let check;
  try {
    check = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints, checkCadenceSecondsOf(state.settings) * 1000);
  } catch (e) {
    // forcePublic writes no 'failed' record if the inputs cannot be
    // checked: the tx stays Slipstream-pending and the owner sees the
    // error.
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
  // Our own txid is the spender: already out there. Record broadcast
  // (merge-only) and report it; the hourly refresh fills in confirmations.
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
      // The tx is out there — log the broadcast, and the
      // confirmation too when the outspend already names the block.
      pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(tx.txid));
      forwardMemberHistory(fresh, ftx, 'broadcast', 'txid ' + shortTxid(tx.txid));
      if (own.blockHeight != null) {
        pushHistory(ftx, 'confirmed', 'Block ' + own.blockHeight.toLocaleString('en-US'));
        forwardMemberHistory(fresh, ftx, 'confirmed', 'Block ' + own.blockHeight.toLocaleString('en-US'));
      }
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'broadcast', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is already out there — the node knows its txid, in the mempool or a block. Recorded as broadcast; nothing was sent.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'broadcast', method: check.checkedVia, alreadyOut: true };
  }
  if (check.spent.length) {
    const spentDesc = check.spent.map((i) => i.prevTxid.slice(0, 12) + ':' + i.prevVout).join(', ');
    // A stale record survives check-ins: spent inputs are a fact (only
    // replacing the hex clears it).
    const record = { status: 'stale', kind: logKind, trigger: trigType, txid: tx.txid, method: check.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent: ' + spentDesc };
    // Record stale only if the tx still has the same hex (a replaced tx
    // has nothing to mark).
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      pushHistory(ftx, 'stale', record.error);
      // A stale member does not archive its set; the verdict is noted on
      // the set's history.
      noteSetMemberStale(fresh, ftx, record.error);
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'stale', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is stale (inputs spent: ' + spentDesc + ') — broadcast not attempted.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'stale', error: record.error };
  }

  // Re-verify against fresh state (preBroadcastCheck), then send via the
  // tx's own route with no cross-route fallback; a failure retries the
  // same route. forcePublic (the manual escape hatch) always goes public.
  const pre = preBroadcastCheck(tx, logKind, opts);
  if (!pre.ok) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: pre.reason };
  }
  const via = (opts && opts.forcePublic) ? 'public' : (pre.tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public');
  // Record the first Slipstream attempt once, before the network call
  // (fallbackDeadline's anchor for a submit that keeps failing). Later
  // branches reload fresh state, so it survives.
  if (via === 'slipstream') {
    const fresh0 = store.loadState(DATA_DIR);
    const ftx0 = (fresh0.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx0 && ftx0.hex === tx.hex && !ftx0.slipstreamFirstAttemptAt) {
      ftx0.slipstreamFirstAttemptAt = now.toISOString();
      store.saveState(DATA_DIR, fresh0);
    }
  }
  // From the public fallback: prefix the broadcast log entry with why it
  // went public.
  const fallbackNote = (opts && typeof opts.fallbackDays === 'number')
    ? 'Public fallback: this Slipstream transaction was not publicly visible within ' + opts.fallbackDays + (opts.fallbackDays === 1 ? ' day' : ' days') + ', so Standby broadcast it publicly instead.'
    : null;
  try {
    if (via === 'slipstream') {
      // A successful Slipstream submission is not a broadcast yet (MARA's
      // mempool is private): status 'submitted-slipstream', no broadcasted
      // fact until refreshMaraWaiting sees it publicly.
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
    // Merge-only write into fresh state: anything may have landed while
    // the broadcast was out (a lost check-in could let a release outlive
    // the owner). A tx deleted or replaced meanwhile is not resurrected;
    // the broadcast is in the log.
    const record = { status: 'broadcast', kind: logKind, trigger: trigType, txid: out.txid, method: out.method, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      // Gone public via the escape hatch: the stored route becomes public,
      // so any retry uses it.
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
    // A failed attempt is 'failed' and retried via the same route, with
    // Slipstream's own reason when that route failed; method names the
    // route. Except forcePublic: no 'failed' record (the tx stays
    // Slipstream-pending) and the error goes to the owner.
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
