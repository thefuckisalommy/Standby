'use strict';
// Standby — history + release records (split from server.js, 0.8.7.3).
const store = require('./store');
const { DATA_DIR } = require('./config');
const { setOfTx } = require('./triggers');

// Per-transaction history (0.8.2): the tx's own event trail —
// [{ ts, type, detail }], oldest first, capped at 50. Only
// transitions are recorded (added, fired, broadcast, confirmed,
// stale, failed, conflict, edited, armed, disarmed, slipstream)
// — never the hourly release checks, or a busy tx would flood.
// pushHistory REPLACES tx.history with a new array (it never
// pushes in place): the edit handler diffs tx against its
// snapshot, so an in-place push would be invisible to it.
// Callers pass the tx they are already saving — the event rides
// on the same save as the record that caused it, so a history
// entry can never land without its transition (and a concurrent
// save can never lose one to a stale snapshot, since every site
// below writes to fresh state).
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
// The 'fired' event's detail: what the rule saw when it fired.
// The evaluator's reason alone is too thin for price ('past
// threshold') — name the reading and the threshold. Every other
// type's reason already says it ('block 976,435 reached',
// 'spent — 1 confirmation', 'economy fee 1 sat/vB', 'Release
// due'), with the trailing ' — firing' stripped. One rule's detail
// reads exactly as a single rule's did; a multi-rule set names
// each fired rule, joined ' + ' — so the trail says which of the
// set's rules fired, and the ones that did not stay silent.
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

// (0.8.7, revised) The set-stale rule: a stale member does NOT
// archive its set. The set keeps evaluating and firing for its
// non-stale members; only when EVERY member is stale does the
// set read archived (see the all-terminal branch in
// evaluateReleaseInner and setStatus in public/app.js). A member
// going stale is still recorded on the set's ONE shared history,
// so the set card shows which member went stale and why. The
// caller saves `fresh`.
function noteSetMemberStale(fresh, tx, error) {
  const fset = setOfTx(fresh, tx.id);
  if (!fset) return;
  pushHistory(fset, 'stale', store.memberHistoryDetail(fset, tx, error));
}

// (0.8.7, round 9) Single history: the set card shows ONE
// history — the set's. A member's own history keeps recording
// (it resumes as the tx's trail if the tx ever leaves the set),
// but the card renders only the set's trail — so a member's
// events are forwarded here too, tagged with the member's
// label, on the same save as the member's own event. Callers
// pass the fresh state they are already saving, so the
// forwarded event can never land without its transition.
// FORWARD — the events a reader of the set card would miss:
//   edited, failed, broadcast, confirmed, conflict, slipstream.
// NEVER forwarded — the set logs its own, or the backfill covers it:
//   stale — noteSetMemberStale above already forwards it
//     (forwarding here would log it twice);
//   fired — the set logs its own 'fired' when ITS trigger fires;
//     a member never fires on its own while attached;
//   armed / disarmed — the set has its own arm, and arm-all flips
//     every member AND its set, so forwarding would log N flips
//     beside the set's one;
//   added — covered by the creation / attach backfill
//     (store.backfillSetHistory), never a live event.
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

// Release evaluation — the heart of the app. Each ARMED transaction
// carries its own rule set (0.8.2: AND / OR over check-in, price,
// UTXO, block-height, set-date, fee-market, manual rules), and the
// evaluation runs every set in list order: the ones whose combined
// condition holds fire, via broadcastOne() above. The check-in
// clock is one rule type now — a check-in rule fires when its own
// threshold is release-due; a price rule fires when the price has
// held past its threshold for an hour; a UTXO rule fires when its
// outpoint is spent by a confirmed transaction.
//   1. Skip if nothing armed. There is NO global skip any more
//      (0.8.0): pause is gone, and vacation is check-in-only —
//      the check-in evaluator holds a check-in tx while on
//      vacation, while price and UTXO evaluators never look at
//      it. A disarmed tx is skipped per-tx (the `enabled` filter
//      below), never by a global flag.
//   2. Evaluate each armed tx's trigger (once, in list order);
//      a trigger that cannot be read is 'unknown' and does not fire.
//   3. Skip a firing tx already broadcast (this cycle, or any cycle
//      — the broadcasted fact survives check-ins) or stale (a stale
//      verdict survives check-ins too — it is a fact about the
//      inputs, not the cycle).
//   4. Freshness gate + broadcast per firing tx (see broadcastOne).
//      One tx failing does not stop the others.
// All-or-none (0.7.10): the firing set is decided once, before any
// broadcast starts. A check-in that lands while the release is
// running is still recorded and resets the clock for the NEXT
// cycle, but it does not stop the txs still to broadcast — a release
// that started finishes. (The audit's finding 1 recommended
// re-evaluating the clock before each tx; the owner chose all-or-none
// instead.) What still stops a tx mid-run: it was deleted, replaced,
// or disabled — explicit owner actions.
// A check-in clears the CHECK-IN rules' cycle-scoped release records
// and starts a new cycle for them (0.8.0: a price or UTXO rule's
// record belongs to its own trigger, not the clock) — a stale record
// is not cycle-scoped and survives; but if a broadcast already went
// out, the funds have already moved; the broadcast log keeps the
// record, and the broadcasted fact keeps the card showing it.
// ---------------------------------------------------------------------------
// Single-flight: only one release evaluation runs at a time. The
// full tick and the manual release-check API both call
// evaluateRelease(); without this they can overlap, and two
// evaluations can broadcast the same transaction. A second caller gets

module.exports = { HISTORY_MAX, pushHistory, shortTxid, firedDetailForRule, firedDetail, noteSetMemberStale, FORWARD_HISTORY_TYPES, forwardMemberHistory, recordRelease };
