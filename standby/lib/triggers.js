'use strict';
// Standby — trigger text + serve shaping (split from server.js, 0.8.7.3).
const store = require('./store');
const bitcoin = require('./bitcoin');
const { days, validPublicFallbackDays } = require('./util');

// Triggers (0.8.0). Each transaction carries its own trigger — see
// lib/store.js for the shapes and normalizeTrigger/triggerOf. These
// are the server-side presentation helpers; the evaluator lives
// below, next to evaluateRelease.
// ---------------------------------------------------------------------------

// The short label for a trigger type, as shown in the readiness
// pills and the trigger subcard ("TRIGGER · BTC price").
function triggerLabel(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'Check-in';
  switch (trigger.type) {
    case 'checkin': return 'Check-in';
    case 'price': return 'BTC price';
    case 'utxo': return 'UTXO';
    case 'manual': return 'Manual';
    case 'blockheight': return 'Block height';
    case 'setdate': return 'Set date';
    case 'feemarket': return 'Fee market';
    default: return 'Check-in';
  }
}

// The condition in plain words, as shown in the trigger subcard:
// "Fires when you don't check in for 35 days",
// "Fires when BTC price ≥ $150,000", "Fires when UTXO 4a74…:0 is spent",
// "Never fires — manual only". `trigger` is a normalized rule SET
// (see triggerOf) — a one-rule set reads exactly as its single rule
// did; a multi-rule set joins its rules with AND / OR. The
// single-rule text is unchanged, so a one-rule tx's 'added' history
// detail and subcard read exactly as before.
function triggerConditionText(trigger) {
  const set = toTriggerSet(trigger);
  if (set.rules.length === 1) return singleTriggerConditionText(set.rules[0]);
  const joiner = set.op === 'AND' ? ' AND ' : ' OR ';
  return 'Fires when ' + set.rules.map(ruleConditionShort).join(joiner);
}

// A rule set from a single rule or a set (both accepted everywhere
// a trigger is): a set passes through, a single rule wraps as a
// one-rule OR set, anything else falls back to the default set.
function toTriggerSet(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.rules)
      && (input.op === 'AND' || input.op === 'OR')) return input;
  const r = store.normalizeRule(input);
  return r.trigger ? { op: 'OR', rules: [r.trigger] } : store.defaultTriggerSet();
}

// One rule's condition without the "Fires when" lead — the piece a
// multi-rule condition joins with AND / OR.
function ruleConditionShort(rule) {
  const t = (rule && rule.type) ? rule : store.defaultTrigger();
  switch (t.type) {
    case 'checkin':
      return "you don't check in for " + t.params.thresholdDays + (t.params.thresholdDays === 1 ? ' day' : ' days');
    case 'price':
      return 'BTC price ' + (t.params.op === '>=' ? '≥' : '≤') + ' $' + t.params.value.toLocaleString('en-US');
    case 'utxo': {
      const parts = String(t.params.outpoint || '').split(':');
      const confs = (t.params.confirmations === 0) ? 0 : (t.params.confirmations || 1);
      const suffix = confs === 0 ? ' (unconfirmed)' : (confs === 1 ? '' : ' (' + confs + ' confirmations)');
      return 'UTXO ' + (parts[0] || '').slice(0, 4) + '…:' + (parts[1] || '') + ' is spent' + suffix;
    }
    case 'manual':
      return 'never — manual only';
    case 'blockheight':
      return 'the chain reaches block ' + Number(t.params.targetHeight).toLocaleString('en-US');
    case 'setdate': {
      const d = new Date(t.params.fireAt);
      const shown = Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : String(t.params.fireAt);
      return 'the date ' + shown + ' is reached';
    }
    case 'feemarket':
      return 'tx fees are ' + (t.params.direction === 'above' ? '>= ' : '<= ') + Number(t.params.maxFeeRate).toLocaleString('en-US') + ' sat/vB';
    default:
      return '';
  }
}

// One rule's condition in full — the 0.8.0/0.8.1 text, unchanged.
function singleTriggerConditionText(trigger) {
  const t = (trigger && trigger.type) ? trigger : store.defaultTrigger();
  switch (t.type) {
    case 'checkin':
      return "Fires when you don't check in for " + t.params.thresholdDays + (t.params.thresholdDays === 1 ? ' day' : ' days');
    case 'price':
      return 'Fires when BTC price ' + (t.params.op === '>=' ? '≥' : '≤') + ' $' + t.params.value.toLocaleString('en-US');
    case 'utxo': {
      const parts = String(t.params.outpoint || '').split(':');
      // (0.8.0) The confirmation mode rides on the condition:
      // the default (1 confirmation) reads as before — "is spent"
      // already meant confirmed — while unconfirmed and N > 1 say
      // so explicitly, so the subcard names the rule.
      const confs = (t.params.confirmations === 0) ? 0 : (t.params.confirmations || 1);
      const suffix = confs === 0 ? ' (unconfirmed)' : (confs === 1 ? '' : ' (' + confs + ' confirmations)');
      return 'Fires when UTXO ' + (parts[0] || '').slice(0, 4) + '…:' + (parts[1] || '') + ' is spent' + suffix;
    }
    case 'manual':
      return 'Never fires — manual only';
    case 'blockheight':
      return 'Fires when the chain reaches block ' + Number(t.params.targetHeight).toLocaleString('en-US');
    case 'setdate': {
      const d = new Date(t.params.fireAt);
      const shown = Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : String(t.params.fireAt);
      return 'Fires on ' + shown;
    }
    case 'feemarket':
      return 'Fires when tx fees are ' + (t.params.direction === 'above' ? '>= ' : '<= ') + Number(t.params.maxFeeRate).toLocaleString('en-US') + ' sat/vB';
    default:
      return '';
  }
}

// The rule types that fired this broadcast, joined — the type
// stamped on a release record (0.8.0): the rule(s) that fired it,
// or the tx's current rule types when nothing fired it (a manual
// broadcast, a dry-run verdict, a confirmation refresh). One rule
// reads as its type, exactly as before ('price', 'checkin'); several
// join with '+' ('price+setdate'), so the record still says which
// rules it came from.
function releaseTriggerFor(state, tx, firedRuleTypes) {
  const types = (Array.isArray(firedRuleTypes) && firedRuleTypes.length)
    ? firedRuleTypes
    : store.triggerTypesOf(tx);
  return types.join('+');
}

// The tx's rule types, joined — the per-result `trigger` field on a
// release check (one rule reads as its type, as before).
function triggerTypesLabel(tx) {
  return store.triggerTypesOf(tx).join('+');
}

// Trigger sets (0.8.7). setOfTx finds the set a transaction
// belongs to (at most one — the load-time sanitizer enforces it);
// setMembers returns a set's transactions, in the set's own order.
function setOfTx(state, txId) {
  return ((state.bitcoin.sets || []).find((s) => (s.txIds || []).includes(txId))) || null;
}
function setMembers(state, set) {
  const txs = state.bitcoin.txs || [];
  return (set.txIds || []).map((id) => txs.find((t) => t.id === id)).filter(Boolean);
}

// The deadline a Slipstream transaction's public fallback fires at —
// or null when there is none. Two anchors, by the transaction's
// state (the owner's rule):
//   (a) 'submitted-slipstream' (MARA accepted it): the deadline runs
//       from when MARA first accepted it — release.submittedAt. A
//       change of duration while pending re-times the deadline from
//       that same submittedAt; it does NOT restart the clock.
//   (b) still 'release-due' because the submit keeps failing (never
//       got the 200+success): the deadline runs from the FIRST
//       Slipstream broadcast attempt — slipstreamFirstAttemptAt,
//       set on the first attempt whether it succeeds or fails, never
//       overwritten after. If no attempt has been made yet, there is
//       no deadline (nothing to fall back from).
// A tx that succeeded on the first try has firstAttemptAt ==
// submittedAt, so the two anchors agree there; a tx that failed
// first and succeeded later anchors on (a), the acceptance — the
// fallback is about MARA holding it, not about our first try.
function fallbackDeadline(tx) {
  if (!tx || tx.broadcastVia !== 'slipstream') return null;
  const days = validPublicFallbackDays(tx.publicFallbackDays);
  if (days === null) return null;
  let anchor = null;
  if (tx.release && tx.release.status === 'submitted-slipstream' && tx.release.submittedAt) {
    anchor = tx.release.submittedAt;
  } else if (tx.slipstreamFirstAttemptAt) {
    anchor = tx.slipstreamFirstAttemptAt;
  } else {
    return null;
  }
  const at = new Date(anchor).getTime();
  if (Number.isNaN(at)) return null;
  return new Date(at + days * 86400000);
}

// The tx as the API serves it (0.8.2, interim dual-shape serving):
// a one-rule set is served as its single rule with its triggerState
// as the single slice (the legacy shape — the 0.8.1 frontend and the
// 098 suites only ever see that for one-rule txs); a multi-rule set
// is served as the set, with the per-rule state array. The stored
// form is always the set — this only shapes what leaves the server.
// A shallow copy: the stored record keeps its set. Remove this when
// the UI build lands (the new frontend normalizes both shapes on
// read).
function serveTx(tx) {
  if (!tx || typeof tx !== 'object') return tx;
  const set = store.triggerOf(tx);
  return {
    ...tx,
    trigger: store.serveTrigger(set),
    triggerState: store.serveTriggerState(set, tx.triggerState),
  };
}
function serveTxs(txs) {
  return (txs || []).map(serveTx);
}

// The set as the API serves it (0.8.7): the same dual-shape
// serving as serveTx — a one-rule set as its single rule with a
// flat triggerState, a multi-rule set as the set with the
// per-rule array. The stored form is always the set.
function serveSet(set) {
  if (!set || typeof set !== 'object') return set;
  const trg = store.triggerOf(set);
  return {
    ...set,
    trigger: store.serveTrigger(trg),
    triggerState: store.serveTriggerState(trg, set.triggerState),
  };
}
function serveSets(sets) {
  return (sets || []).map(serveSet);
}

module.exports = { triggerLabel, triggerConditionText, toTriggerSet, ruleConditionShort, singleTriggerConditionText, releaseTriggerFor, triggerTypesLabel, setOfTx, setMembers, fallbackDeadline, serveTx, serveTxs, serveSet, serveSets };
