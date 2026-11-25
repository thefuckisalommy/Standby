'use strict';
// Standby — trigger text + serve shaping.
const store = require('./store');
const { validPublicFallbackDays } = require('./util');

// Triggers. Each transaction carries its own trigger — see
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

// The condition in plain words ("Fires when BTC price ≥ $150,000"). A one-
// rule set reads as its rule; a multi-rule set joins them with AND / OR.
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

// One rule's condition in full.
function singleTriggerConditionText(trigger) {
  const t = (trigger && trigger.type) ? trigger : store.defaultTrigger();
  switch (t.type) {
    case 'checkin':
      return "Fires when you don't check in for " + t.params.thresholdDays + (t.params.thresholdDays === 1 ? ' day' : ' days');
    case 'price':
      return 'Fires when BTC price ' + (t.params.op === '>=' ? '≥' : '≤') + ' $' + t.params.value.toLocaleString('en-US');
    case 'utxo': {
      const parts = String(t.params.outpoint || '').split(':');
      // The confirmation mode rides on the condition:
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

// The rule types stamped on a release record: those that fired, or the
// tx's current types when nothing fired (manual broadcast, dry run,
// refresh); several join with '+'.
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

// Trigger sets. setOfTx finds the set a transaction
// belongs to (at most one — the load-time sanitizer enforces it);
// setMembers returns a set's transactions, in the set's own order.
function setOfTx(state, txId) {
  return ((state.bitcoin.sets || []).find((s) => (s.txIds || []).includes(txId))) || null;
}
function setMembers(state, set) {
  const txs = state.bitcoin.txs || [];
  return (set.txIds || []).map((id) => txs.find((t) => t.id === id)).filter(Boolean);
}

// When a Slipstream tx's public fallback fires, or null:
// (a) accepted by MARA: from release.submittedAt (changing the duration
// re-times from it)
// (b) still release-due because submits keep failing: from
// slipstreamFirstAttemptAt (no attempt yet, no deadline)
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

// The tx as served: a one-rule set as its single rule with a flat slice, a
// multi-rule set as the set with the per-rule array. The stored form is
// always the set.
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

// The set as the API serves it: the same dual-shape
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
