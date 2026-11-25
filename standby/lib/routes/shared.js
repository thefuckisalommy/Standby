'use strict';
const { checkTriggerNow } = require('../rules');

// A route module returns NEXT when no route of its own matched.
const NEXT = Symbol('next');

// The already-satisfied gate for a rule set: evaluates
// the WHOLE set with the combined semantics — an OR set is blocked
// when any rule is satisfied now, an AND set when all are.
// Unknown rules never block (satisfaction cannot be proven).
// Check-in-only sets never reach this gate: a due check-in rule
// resets the clock instead (the danger-zone reset below), exactly
// as a single check-in rule does today — so the gate only runs
// when the set holds a price, UTXO, block-height, set-date, or
// fee-market rule. `verb` is 'add' | 'import' | 'save' (the
// handler's word for the action being confirmed). Returns
// { chk, blocked, message } — chk is the checkTriggerNow answer
// (its warning rides on the 201 when the set is not already
// satisfied, so the UI can say what it found).
async function setGateCheck(trgSet, state, now, verb) {
  const hasGatedRule = trgSet.rules.some((r) => r.type === 'price' || r.type === 'utxo' || r.type === 'blockheight' || r.type === 'setdate' || r.type === 'feemarket');
  if (!hasGatedRule) return { chk: null, blocked: false, message: null };
  const chk = await checkTriggerNow(trgSet, state, now, null);
  if (!chk.fire) return { chk, blocked: false, message: null };
  return { chk, blocked: true, message: alreadySatisfiedMessage(trgSet, verb) };
}
function alreadySatisfiedMessage(trgSet, verb) {
  const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
  const tail = cap + ' it with triggerConfirmed to ' + verb + ' it anyway.';
  if (trgSet.rules.length === 1) {
    const r = trgSet.rules[0];
    switch (r.type) {
      case 'utxo': return 'That UTXO is already spent — this rule would fire on the next evaluation. ' + tail;
      case 'price': {
        const dir = r.params.op === '>=' ? 'above' : 'below';
        return 'The price is already ' + dir + ' $' + Number(r.params.value).toLocaleString('en-US') + ' — this rule would fire on the next evaluation. ' + tail;
      }
      case 'blockheight': return 'That block height has already been reached — this rule would fire on the next evaluation. ' + tail;
      case 'setdate': return 'That date has already passed — this rule would fire on the next evaluation. ' + tail;
      case 'feemarket': {
        const fdir = r.params.direction === 'above' ? 'at or above' : 'at or below';
        return 'The economy fee is already ' + fdir + ' ' + Number(r.params.maxFeeRate).toLocaleString('en-US') + ' sat/vB — this rule would fire on the next evaluation. ' + tail;
      }
      default: return 'This rule is already satisfied — it would fire on the next evaluation. ' + tail;
    }
  }
  return 'This rule set is already satisfied — it would fire on the next evaluation. ' + tail;
}

module.exports = { NEXT, setGateCheck };
