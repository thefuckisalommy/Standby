'use strict';
// Standby — history + release records.
const store = require('./store');
const { DATA_DIR } = require('./config');
const { setOfTx } = require('./triggers');

// Per-transaction history: [{ ts, type, detail }], oldest first, capped at
// 50, transitions only (never routine checks). pushHistory replaces
// tx.history rather than pushing in place (the edit handler diffs against
// its snapshot). It rides on the same save as the change that caused it.
const HISTORY_MAX = 50;
function pushHistory(tx, type, detail, ts) {
  const prev = Array.isArray(tx.history) ? tx.history : [];
  const ev = { ts: (typeof ts === 'string' && ts) ? ts : new Date().toISOString(), type, detail: (typeof detail === 'string' ? detail : '') };
  tx.history = prev.concat([ev]).slice(-HISTORY_MAX);
  return tx.history;
}
function shortTxid(txid) {
  const s = String(txid || '');
  return s.slice(0, 8) + '…' + s.slice(-4);
}
// The 'fired' detail: what the rule saw. Price names the reading and
// threshold; other types reuse their reason without the trailing ' —
// firing'. A multi-rule set joins the fired rules with ' + '.
function firedDetailForRule(rule, reason, slice) {
  if (rule && rule.type === 'price' && slice && typeof slice.lastPrice === 'number') {
    const op = rule.params.op === '>=' ? '≥' : '≤';
    return 'BTC $' + slice.lastPrice.toLocaleString('en-US') + ' ' + op + ' $' + Number(rule.params.value).toLocaleString('en-US');
  }
  return (typeof reason === 'string' ? reason : '').replace(/ — firing$/, '');
}
function firedDetail(set, ruleResults, firedIndexes) {
  if (set.rules.length === 1) {
    const r = ruleResults[0];
    return firedDetailForRule(r.rule, r.reason, r.slice || null);
  }
  return firedIndexes
    .map((i) => firedDetailForRule(ruleResults[i].rule, ruleResults[i].reason, ruleResults[i].slice || null))
    .join(' + ');
}

// A stale member does not archive its set (only all-stale does); it is
// noted on the set's shared history. The caller saves fresh.
function noteSetMemberStale(fresh, tx, error) {
  const fset = setOfTx(fresh, tx.id);
  if (!fset) return;
  pushHistory(fset, 'stale', store.memberHistoryDetail(fset, tx, error));
}

// The set card shows only the set's history, so member events are
// forwarded there, tagged with the member, on the same save.
// Forwarded: edited, failed, broadcast, confirmed, conflict, slipstream.
// Not forwarded: stale (noteSetMemberStale does it), fired (the set logs
// its own), armed/disarmed (the set has its own arm), added (covered by
// the backfill).
const FORWARD_HISTORY_TYPES = new Set(['edited', 'failed', 'broadcast', 'confirmed', 'conflict', 'slipstream']);
function forwardMemberHistory(state, tx, type, detail) {
  if (!FORWARD_HISTORY_TYPES.has(type)) return;
  const set = setOfTx(state, tx.id);
  if (!set) return;
  pushHistory(set, type, store.memberHistoryDetail(set, tx, detail));
}

function recordRelease(state, tx, record, logEntry) {
  tx.release = record;
  store.saveState(DATA_DIR, state);
  if (logEntry) store.appendBroadcastLog(DATA_DIR, logEntry);
}


module.exports = { HISTORY_MAX, pushHistory, shortTxid, firedDetailForRule, firedDetail, noteSetMemberStale, FORWARD_HISTORY_TYPES, forwardMemberHistory, recordRelease };
