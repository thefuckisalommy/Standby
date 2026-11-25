'use strict';
// Standby — release evaluation, refreshes, ticks.
const store = require('./store');
const bitcoin = require('./bitcoin');
const { caches } = require('./caches');
const { applyGrace, expireVacation, mergeExternalCheckin } = require('./checkin');
const { DATA_DIR } = require('./config');
const { firedDetail, forwardMemberHistory, noteSetMemberStale, pushHistory, shortTxid } = require('./history');
const { checkCadenceSecondsOf, fetchTipHeightsCached, refreshPriceIfStale } = require('./prices');
const rules = require('./rules');
const { fallbackDeadline, releaseTriggerFor, setMembers, triggerTypesLabel } = require('./triggers');
const { validPublicFallbackDays } = require('./util');
const { findingFor, recordFindings } = require('./verdicts');

// a plain 'already in progress' skip. The flag is set and cleared
// synchronously around the awaited work, in a finally, so it can never
// stick — and Node's single thread makes the check-and-set atomic.
let releaseEvaluationInFlight = false;
// Broadcast backoff: an automatic evaluation does not
// re-attempt a broadcast for a tx within an hour of its last
// failed broadcast attempt (see the guard in
// evaluateReleaseInner). One hour, hard-coded — the retry
// cadence is a safety property, not a user setting.
const BROADCAST_BACKOFF_MS = 60 * 60 * 1000;
// Archived confirmations: a broadcast
// transaction at this many confirmations is done — its count is
// final, so the hourly confirmation refresh never re-queries it,
// and the tick never evaluates it (see terminalSkipReason below).
const ARCHIVED_CONFIRMATIONS = 6;
// A transaction that can no longer broadcast is never
// evaluated on the tick: its rules make no node requests and its
// triggerState slice freezes at its last value. Broadcasted
// (confirmed, unconfirmed, or not-found), stale, submitted to
// Slipstream, or a broadcast release record with no broadcasted
// fact. Still evaluated: staged txs (armed or disarmed — every
// staged tx is evaluated), conflict txs (they can
// still broadcast; the node is the arbiter), and failed txs (they
// retry after the 1h backoff). Returns the skip reason, or null
// when the tx is still evaluable.
function terminalSkipReason(tx) {
  if (tx.broadcasted) return 'already broadcast';
  const st = tx.release && tx.release.status;
  if (st === 'broadcast') return 'already broadcast';
  if (st === 'stale') return 'transaction is stale — replace it to re-arm';
  if (st === 'submitted-slipstream') return 'submitted to Slipstream — waiting on MARA';
  return null;
}
// `options.automatic` (optional) marks a tick-driven evaluation —
// the full tick passes { automatic: true }; the manual release
// check passes nothing. The backoff guard in evaluateReleaseInner
// applies only to automatic evaluations (a manual check or
// broadcast is explicit user action and always attempts).
// There is no type filter: the full tick
// evaluates every rule type together, so the check-in merge below
// is always a gate — an unreadable receiver state withholds the
// whole evaluation, because the clock may hold a check-in that
// would clear a due state.
async function evaluateRelease(options) {
  const automatic = !!(options && options.automatic);
  if (releaseEvaluationInFlight) {
    return { action: 'skipped', reason: 'release evaluation already in progress', results: [] };
  }
  releaseEvaluationInFlight = true;
  try {
    // A receiver check-in that landed since the last read is merged
    // before the clock is judged — the manual release check (POST
    // /api/release/check) is otherwise the only evaluation path that
    // skips it (the hourly tick merges first, and the status/key
    // endpoints merge on read). Merging twice is harmless:
    // mergeExternalCheckin only applies a timestamp newer than the
    // clock, so a second merge is a no-op.
    // An unreadable receiver state
    // withholds the whole evaluation: the file may hold a check-in
    // that would clear the due state, and broadcasting on a clock
    // that may be wrong is the worst failure this app has. Skip this
    // evaluation — mark nothing, retry next tick — and say so loudly
    // (the owner sees it in GET /api/status as checkinReadError).
    // A missing file is not an error: it just means no receiver is
    // installed, and releases proceed as before. A merge that throws
    // is treated the same way: if the merged check-in cannot be
    // applied reliably, do not broadcast on the unmerged clock.
    let merged;
    try { merged = mergeExternalCheckin(store.loadState(DATA_DIR), new Date()); }
    catch (e) { console.error('external check-in merge failed:', e); merged = 'error'; }
    if (merged === 'error') {
      console.error('release withheld: external check-in state is unreadable — not broadcasting until it can be read (see GET /api/status checkinReadError)');
      return { action: 'skipped', reason: 'check-in state unreadable', results: [] };
    }
    // The grace: judged on the stored "I was
    // online" stamp (the tick refreshes it; a manual release check
    // does not). Sets + saves a grace when the gap is past the
    // threshold and none is active, so the evaluation below sees
    // the held rules. Best-effort — a failure here must not block
    // the evaluation (the grace is a hold, not a gate).
    try {
      const stH = store.loadState(DATA_DIR);
      let changed = false;
      if (applyGrace(stH, new Date())) changed = true;
      if (expireVacation(stH, new Date())) changed = true;
      if (changed) store.saveState(DATA_DIR, stH);
    } catch (e) { console.error('grace apply failed:', e); }
    const _r = await evaluateReleaseInner(automatic);
    return _r;
  } finally {
    releaseEvaluationInFlight = false;
  }
}

// The set's combined outcome from its STORED slices only (no
// network) — what the set read as the last time it was evaluated.
// A rule never evaluated reads 'not-evaluated', which maps to
// unknown (fail-safe). Used for the 'fired' history transition:
// the set was already due before this tick.
function storedRuleOutcomes(tx) {
  const set = store.triggerOf(tx);
  return set.rules.map((rule, i) => {
    const s = rules.ruleTriggerState(tx, i);
    const status = s ? (s.status || 'not-evaluated') : 'not-evaluated';
    const held = status === 'grace' ? 'grace' : status === 'vacation' ? 'vacation' : status === 'held' ? 'held' : null;
    const cls = (status === 'due' || status === 'release-due') ? 'satisfied'
      : (status === 'unknown' || status === 'not-evaluated') ? 'unknown'
      : held ? 'held' : 'not';
    return { index: i, rule, fire: cls === 'satisfied', status, reason: s ? (s.reason || '') : '', held, skipped: false, cls };
  });
}
function storedCombinedDue(tx) {
  return rules.combineOutcomes(store.triggerOf(tx), storedRuleOutcomes(tx)).fire;
}

async function evaluateReleaseInner(automatic) {
  const state = store.loadState(DATA_DIR);
  const now = new Date();
  const s = state.settings;
  // `automatic` marks a tick-driven evaluation (the full tick
  // passes true; the manual release check passes nothing). It
  // only changes one thing: the broadcast backoff guard in the
  // firing loop below. Every rule type is evaluated, every time —
  // there is no type filter.
  // Every tx is evaluated — armed or not — so a disarmed
  // tx's triggerStatus stays live for display. Only ARMED txs can
  // enter the firing set below: unarmed means "will not broadcast
  // even if the conditions are met" (the owner's definition).
  const all = state.bitcoin.txs || [];
  if (!all.length) return { action: 'skipped', reason: 'no transactions', results: [] };

  // Endpoints: the primary node first, the secondary if the primary
  // does not answer. (The MEMPOOL_* env vars can override the primary
  // — see lib/bitcoin.js.)
  const endpoints = bitcoin.endpointsFor(s);
  const results = [];

  // One evaluation's UTXO batch plan:
  // every watched outpoint in this run, grouped by funding tx.
  // A funding tx with ≥2 watched outputs is answered with ONE
  // /outspends fetch, shared by its rules. The plan is built from
  // every tx's UTXO rules up front — the fetch itself is LAZY
  // (only when a rule for that funding tx is actually evaluated),
  // so a plan entry whose rule is never evaluated (terminal tx,
  // grace hold) costs nothing, and a funding tx with exactly one
  // watched output keeps the singular endpoint.
  const utxoPlan = new Map(); // txid -> Set<vout>
  for (const tx of all) {
    const set = store.triggerOf(tx);
    for (const rule of (set.rules || [])) {
      if (rule.type !== 'utxo' || !rule.params || typeof rule.params.outpoint !== 'string') continue;
      const parts = rule.params.outpoint.split(':');
      const vout = parseInt(parts[1], 10);
      if (!parts[0] || !Number.isFinite(vout) || vout < 0) continue;
      if (!utxoPlan.has(parts[0])) utxoPlan.set(parts[0], new Set());
      utxoPlan.get(parts[0]).add(vout);
    }
  }
  // A set's UTXO rules ride the same batch plan as a tx's —
  // the set is evaluated once, so its outpoints are planned once.
  for (const set of (state.bitcoin.sets || [])) {
    const sset = store.triggerOf(set);
    for (const rule of (sset.rules || [])) {
      if (rule.type !== 'utxo' || !rule.params || typeof rule.params.outpoint !== 'string') continue;
      const parts = rule.params.outpoint.split(':');
      const vout = parseInt(parts[1], 10);
      if (!parts[0] || !Number.isFinite(vout) || vout < 0) continue;
      if (!utxoPlan.has(parts[0])) utxoPlan.set(parts[0], new Set());
      utxoPlan.get(parts[0]).add(vout);
    }
  }
  const utxoBatch = bitcoin.createOutspendBatch(utxoPlan, endpoints, checkCadenceSecondsOf(s) * 1000);

  // Each tx's own trigger decides whether its conditions
  // hold — armed or not; there is no global release clock. The
  // triggers are evaluated ONCE, in list order, and the
  // firing set (armed txs only) is decided before any
  // broadcast starts (all-or-none: a check-in landing
  // mid-run is recorded but does not stop the txs still to
  // broadcast). A trigger that cannot be read (a feed outage, an
  // outpoint no node can say about) is 'unknown' and does not fire.
  // The evaluations are persisted even when nothing fires — the
  // price trigger's last price and the UTXO trigger's
  // last outspend live in triggerState, and the next evaluation
  // builds on them.
  const firing = [];
  // Whether any DISARMED tx's conditions held — so the
  // top-level reason says so instead of 'no trigger fired' when
  // nothing else happened.
  // The 'fired' history event is logged once, on the
  // transition into due — so each evaluation records whether the
  // set was already due before it ran (from the STORED slices,
  // combined the same way), and the full evaluation result (which
  // rules fired) for the detail. 'release-due' counts as due here
  // — the old code only checked 'due', so a check-in tx whose
  // broadcast failed re-logged 'fired' on every hourly retry;
  // the new reading matches the "logged once" intent.
  let disarmedFired = false;
  const wasDueById = new Map();
  const evById = new Map();
  // A set member is never evaluated on its own trigger:
  // the set's trigger is evaluated once for all its members, in
  // the set loop below. A member's own triggerState freezes while
  // it is attached, and resumes when it leaves the set.
  const setByTxId = new Map();
  for (const set of (state.bitcoin.sets || [])) {
    for (const id of (set.txIds || [])) setByTxId.set(id, set);
  }
  const wasDueBySetId = new Map();
  const evBySetId = new Map();
  const firingSets = [];
  for (const tx of all) {
    if (setByTxId.has(tx.id)) continue;
    // Terminal first: a tx that can no longer broadcast
    // is not evaluated at all — no tip fetch, no outspend check,
    // no fee/price evaluation attributable to it. Its slice
    // freezes; its card still reads its settled state from the
    // broadcasted/release facts (txStatus), not the frozen slice.
    const terminalReason = terminalSkipReason(tx);
    if (terminalReason) {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: terminalReason, trigger: triggerTypesLabel(tx) });
      continue;
    }
    wasDueById.set(tx.id, storedCombinedDue(tx));
    let ev;
    try { ev = await rules.evaluateTrigger(state, tx, now, utxoBatch); }
    catch (e) {
      // An evaluator must never take the whole run down with it:
      // a throw is the same as 'unknown' — do not fire, and say so.
      // Every rule gets an unknown slice (the ones already
      // evaluated keep theirs).
      console.error('trigger evaluation failed for ' + (tx.label || tx.id) + ':', e);
      const set = store.triggerOf(tx);
      set.rules.forEach((rule, i) => {
        rules.setRuleTriggerState(tx, i, { ...rules.freshTriggerState(now, 'unknown', 'evaluation failed — will retry'), lastError: e.message });
      });
      ev = { fire: false, status: 'unknown', reason: 'evaluation failed — will retry', ruleResults: [], firedIndexes: [], firedRuleTypes: [] };
    }
    evById.set(tx.id, ev);
    if (!tx.enabled) {
      // Evaluated for display only — never broadcast, and
      // no 'fired' history event (nothing fired in the release
      // sense). The slice is still written below, so the pill
      // reads the live status.
      if (ev.fire) disarmedFired = true;
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'disarmed — ' + ev.reason, trigger: triggerTypesLabel(tx), triggerStatus: ev.status });
      continue;
    }
    if (!ev.fire) {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: ev.reason, trigger: triggerTypesLabel(tx), triggerStatus: ev.status });
      continue;
    }
    firing.push(tx);
  }
  // Trigger sets: each set's trigger set is evaluated
  // ONCE per tick, shared across all its members — that is the
  // point of a set. A firing set broadcasts every live member (the
  // firing loop below); a disarmed set is evaluated for display
  // only, like a disarmed tx.
  for (const set of (state.bitcoin.sets || [])) {
    const members = setMembers(state, set);
    if (!members.length) continue;
    // A stale member is ordinary now, not a
    // reason to skip the set: it is excluded from firing by the
    // live-member filter in the firing loop below, and the set
    // keeps evaluating and firing for its non-stale members.
    // Every member terminal (broadcast, submitted to Slipstream,
    // or stale) — the set is settled, nothing left to evaluate.
    // When every member is stale the set reads archived.
    if (members.every((m) => terminalSkipReason(m))) {
      const allStale = members.every((m) => m.release && m.release.status === 'stale');
      results.push({ id: set.id, kind: 'set', txid: '', label: set.label || '', action: 'skipped', reason: allStale ? 'all members are stale — the set is archived' : 'all members are broadcast or submitted', trigger: triggerTypesLabel(set) });
      continue;
    }
    wasDueBySetId.set(set.id, storedCombinedDue(set));
    let sev;
    try { sev = await rules.evaluateTrigger(state, set, now, utxoBatch); }
    catch (e) {
      // Same as a tx: a throw is 'unknown' — do not fire, say so.
      console.error('trigger evaluation failed for set ' + (set.label || set.id) + ':', e);
      const sset = store.triggerOf(set);
      sset.rules.forEach((rule, i) => {
        rules.setRuleTriggerState(set, i, { ...rules.freshTriggerState(now, 'unknown', 'evaluation failed — will retry'), lastError: e.message });
      });
      sev = { fire: false, status: 'unknown', reason: 'evaluation failed — will retry', ruleResults: [], firedIndexes: [], firedRuleTypes: [] };
    }
    evBySetId.set(set.id, sev);
    if (!set.enabled) {
      // Evaluated for display only — never broadcast, and no
      // 'fired' history event (nothing fired in the release sense).
      if (sev.fire) disarmedFired = true;
      results.push({ id: set.id, kind: 'set', txid: '', label: set.label || '', action: 'skipped', reason: 'disarmed — ' + sev.reason, trigger: triggerTypesLabel(set), triggerStatus: sev.status });
      continue;
    }
    if (!sev.fire) {
      results.push({ id: set.id, kind: 'set', txid: '', label: set.label || '', action: 'skipped', reason: sev.reason, trigger: triggerTypesLabel(set), triggerStatus: sev.status });
      continue;
    }
    firingSets.push({ set, ev: sev });
  }
  const firingIds = new Set(firing.map((f) => f.id));
  // Whether any firing tx was held back by the broadcast
  // backoff below — so the top-level reason says so instead of
  // 'no trigger fired' when nothing else happened.
  let backedOff = false;
  // Persist the triggerState updates by merging them into FRESH
  // state (see refreshConfirmations): the evaluations waited on the
  // network, so a user edit landing mid-loop — disable, delete, or
  // change a transaction — must not be clobbered by saving the stale
  // snapshot. The broadcast path below reloads fresh state per tx
  // and merges only its own record, so these evaluations survive
  // the broadcasts. The slice is persisted for every
  // evaluated tx, armed or not; the 'fired' event below stays
  // armed-only (firingIds).
  try {
    const fresh = store.loadState(DATA_DIR);
    for (const tx of all) {
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && tx.triggerState) ftx.triggerState = tx.triggerState;
      // The 'fired' history event, on the transition into
      // due only (see wasDueById above) — it rides on this same
      // save as the triggerState, so the event and the state that
      // caused it can never part ways.
      // A tx whose conditions held while DISARMED reaches
      // the firing set with a stored due slice but no 'fired'
      // event (nothing fired while disarmed) — log it now, on the
      // first armed tick that fires it. Without this the trail
      // would read added → disarmed → armed → broadcast with no
      // 'fired' step.
      if (ftx && firingIds.has(tx.id)
        && (!wasDueById.get(tx.id) || !(ftx.history || []).some((e) => e.type === 'fired'))) {
        const ev = evById.get(tx.id);
        pushHistory(ftx, 'fired', firedDetail(store.triggerOf(tx), ev.ruleResults, ev.firedIndexes));
      }
    }
    // The same merge for sets: each set's triggerState
    // rides into fresh state, and the 'fired' event logs on the
    // transition into due only — armed sets only (a disarmed set
    // never reaches the firing set, so it never logs one here).
    const firingSetIds = new Set(firingSets.map((fs) => fs.set.id));
    for (const set of (state.bitcoin.sets || [])) {
      const fset = (fresh.bitcoin.sets || []).find((s) => s.id === set.id);
      if (fset && set.triggerState) fset.triggerState = set.triggerState;
      if (fset && firingSetIds.has(set.id)
        && (!wasDueBySetId.get(set.id) || !(fset.history || []).some((e) => e.type === 'fired'))) {
        const sev = evBySetId.get(set.id);
        pushHistory(fset, 'fired', firedDetail(store.triggerOf(set), sev.ruleResults, sev.firedIndexes));
      }
    }
    mergeNodeStamps(fresh);
    store.saveState(DATA_DIR, fresh);
  } catch (e) { console.error('trigger state save failed:', e); }

  for (const tx of firing) {
    if (tx.broadcasted) {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
      continue;
    }
    if (tx.release && tx.release.status === 'broadcast') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
      continue;
    }
    if (tx.release && tx.release.status === 'stale') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'transaction is stale — replace it to re-arm' });
      continue;
    }
    // Already submitted to Slipstream and waiting on MARA:
    // it is not re-submitted. refreshMaraWaiting (run after this
    // evaluation, on the tick and on the manual release check) is
    // what moves it on — to 'broadcast' once the public nodes see
    // it, or back to 'failed' if MARA drops it.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'submitted to Slipstream — waiting on MARA' });
      continue;
    }
    // Broadcast backoff — automatic evaluations only. A
    // tx whose last broadcast attempt failed is not re-attempted
    // until an hour has passed since that attempt. The timestamp
    // is the release record's lastAttemptAt, written by
    // broadcastOneInner on every failed attempt (either route,
    // and the input-check failure too — and by refreshMaraWaiting
    // when MARA drops a submission). The tx stays due — the next
    // automatic attempt waits out the hour — and the guard never
    // re-logs 'fired' (that event fired once, on the transition
    // into due). Manual broadcasts bypass it: they call
    // broadcastOne directly, never through this loop. The record
    // is read from the snapshot loaded at the start of this
    // evaluation (the same snapshot the already-broadcast /
    // stale checks above read) — a manual failure landing
    // mid-evaluation is caught on the next tick at the latest,
    // so the worst case is one extra attempt, never a skipped
    // first one. A missing or unparseable lastAttemptAt means no
    // backoff: a timestamp that cannot
    // be read cannot prove recency.
    if (automatic && tx.release && tx.release.status === 'failed'
        && typeof tx.release.lastAttemptAt === 'string') {
      const last = Date.parse(tx.release.lastAttemptAt);
      if (Number.isFinite(last) && (now - last) < BROADCAST_BACKOFF_MS) {
        backedOff = true;
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'broadcast backoff — last failed attempt was less than an hour ago' });
        continue;
      }
    }
    // The release decision was made once, above — a check-in landing
    // mid-run is recorded but does not stop the remaining
    // transactions (all-or-none). The fired rules ride along
    // so the broadcast path knows which of the set's rules fired
    // (the vacation guard only blocks a firing CHECK-IN rule; a
    // price rule firing during vacation broadcasts).
    const firedRuleTypes = (evById.get(tx.id) || {}).firedRuleTypes || store.triggerTypesOf(tx);
    results.push(await rules.broadcastOne(state, tx, endpoints, now, 'release', { firedRuleTypes }));
  }

  // Firing sets: every live member broadcasts, through
  // the same per-tx broadcast path as a standalone firing tx.
  for (const fs of firingSets) {
    const set = fs.set;
    const members = setMembers(state, set);
    const live = members.filter((m) => !terminalSkipReason(m));
    // The set-stale pre-check: every live
    // member's inputs are re-checked BEFORE any member
    // broadcasts — but a stale member only excludes ITSELF. It
    // is marked stale (release record + history on the member,
    // a note on the set's shared history) and skipped, and the
    // non-stale members still broadcast. Only when EVERY member
    // is stale does nothing go out — and the set reads archived
    // from then on, because every member is stale (see the
    // all-terminal branch above and setStatus).
    const staleFound = [];
    for (const m of live) {
      let chk = null;
      try { chk = await bitcoin.checkInputsUnspent(bitcoin.parseTx(m.hex), endpoints, checkCadenceSecondsOf(state.settings) * 1000); }
      catch (e) { chk = null; } // unknown: rules.broadcastOne decides below
      const f = chk && findingFor(m.id, chk, { staleOnly: true });
      if (f) staleFound.push({ member: m, f });
    }
    if (staleFound.length) {
      try { recordFindings(staleFound.map((sf) => sf.f), now, 'release'); }
      catch (e) { console.error('set stale marking failed:', e); }
      for (const sf of staleFound) {
        results.push({ id: sf.member.id, txid: sf.member.txid, label: sf.member.label || '', action: 'stale', error: sf.f.stale.error, trigger: triggerTypesLabel(sf.member) });
      }
    }
    const staleIds = new Set(staleFound.map((sf) => sf.member.id));
    for (const m of live) {
      if (staleIds.has(m.id)) continue;
      // The broadcast backoff, per member — the same guard
      // as the standalone firing loop above.
      if (automatic && m.release && m.release.status === 'failed'
          && typeof m.release.lastAttemptAt === 'string') {
        const last = Date.parse(m.release.lastAttemptAt);
        if (Number.isFinite(last) && (now - last) < BROADCAST_BACKOFF_MS) {
          backedOff = true;
          results.push({ id: m.id, txid: m.txid, label: m.label || '', action: 'skipped', reason: 'broadcast backoff — last failed attempt was less than an hour ago' });
          continue;
        }
      }
      const r = await rules.broadcastOne(state, m, endpoints, now, 'release', { firedRuleTypes: fs.ev.firedRuleTypes, setId: set.id });
      results.push(r);
      // A member that went stale mid-run is marked stale inside
      // broadcastOne — but only itself. The remaining members
      // are still broadcastable, so the loop carries on (the old
      // any-stale-archives rule broke here; the revised rule
      // does not).
    }
  }

  const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
    : results.some((r) => r.action === 'failed') ? 'failed'
    : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
  const out = { action, results };
  if (action === 'skipped') out.reason = backedOff ? 'broadcast backoff — retry after an hour' : disarmedFired ? 'trigger fired — transaction disarmed' : 'no trigger fired';
  return out;
}

// Refresh the confirmation count for every broadcast transaction.
// `maxAgeSec`: only re-query a tx whose last check is older than this
// (0 = always re-query). Returns [{ id, txid, confirmations,
// blockHeight, found, checkedAt }]. Best-effort per tx: a failed
// lookup keeps the last known value, and the checkedAt stays old so the
// UI can tell the number is stale.
async function refreshConfirmations(state, maxAgeSec) {
  // Collect the network results first, then merge ONLY the
  // confirmation fields into FRESH state before saving. Mutating
  // this (stale) state object while the lookups are on the network
  // and saving it would clobber a user edit landing during the
  // hourly tick — disable, delete, or change a transaction.
  const endpoints = bitcoin.endpointsFor(state.settings);
  const nowMs = Date.now();
  const out = [];
  const updates = [];
  // The current tip for deriving archived counts, resolved
  // lazily on the first archived tx that needs it — one shared
  // lookup for the whole refresh, and none at all when no archived
  // tx carries a block height. A cache hit costs no request; a miss
  // costs one primary-first tip fetch through the same shared
  // per-tick cache the block-height rule uses (and warms it for the
  // tick). Null when the tip cannot be read — the stored snapshot
  // is returned instead, exactly as before.
  let derivedTip = undefined; // undefined = not yet resolved, null = unavailable
  async function tipForDerived() {
    if (derivedTip !== undefined) return derivedTip;
    derivedTip = null;
    try {
      const comb = bitcoin.combineTipHeights(await fetchTipHeightsCached(endpoints, checkCadenceSecondsOf(state.settings)));
      if (comb.valid && typeof comb.tip === 'number') derivedTip = comb.tip;
    } catch (e) { /* tip unavailable — fall back to the stored count */ }
    return derivedTip;
  }
  for (const tx of (state.bitcoin.txs || []).filter((t) => t.broadcasted)) {
    const b = tx.broadcasted;
    // A broadcast tx at ARCHIVED_CONFIRMATIONS is done —
    // its count is final, so it is never re-queried. Below 6
    // (pending, unconfirmed, not-found) it still refreshes
    // hourly: 2 requests each (tx status + tip height,
    // primary-first).
    // "Never re-queried" must not freeze the DISPLAYED count
    // at the last stored snapshot. The stored snapshot is
    // the >= 6 gate and is never overwritten — but what the
    // endpoint returns, and the card shows, is derived from the
    // settled confirming block height + the current tip. The
    // height is only trusted once 6-deep (a single sighting would
    // bake in reorg risk), and the count never goes backwards:
    // the stored snapshot is the floor.
    if (typeof b.confirmations === 'number' && b.confirmations >= ARCHIVED_CONFIRMATIONS) {
      let shown = b.confirmations;
      if (typeof b.blockHeight === 'number') {
        const tip = await tipForDerived();
        if (typeof tip === 'number') shown = Math.max(b.confirmations, tip - b.blockHeight + 1);
      }
      out.push({ id: tx.id, txid: tx.txid, confirmations: shown, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt, staleInput: b.staleInput || null, conflictInput: b.conflictInput || null });
      continue;
    }
    const ageSec = b.checkedAt ? (nowMs - new Date(b.checkedAt).getTime()) / 1000 : Infinity;
    if (ageSec < maxAgeSec && b.confirmations !== null) {
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt, staleInput: b.staleInput || null, conflictInput: b.conflictInput || null });
      continue;
    }
    try {
      const c = await bitcoin.getConfirmations(tx.txid, endpoints);
      const checkedAt = new Date().toISOString();
      // Not found on the network: ask whether the inputs
      // are already spent — a not-found tx whose input is
      // spent-confirmed is stale by the app's own taxonomy, not
      // "dropped from the mempool". One outspend check per missing
      // tx, only on this path; a tx already recorded stale never
      // re-checks (a confirmed spend is a chain fact), and a
      // failed check leaves the tx plain not-found for the next
      // refresh to retry.
      let staleInput = b.staleInput || null;
      let conflictInput = b.conflictInput || null;
      let staleError = null;
      if (c.found === false && !staleInput) {
        try {
          const chk = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints, checkCadenceSecondsOf(state.settings) * 1000);
          if (chk.spent.length) {
            const first = chk.spent[0];
            staleInput = { spentBy: first.spentBy || null, blockHeight: (typeof first.blockHeight === 'number' ? first.blockHeight : null) };
            conflictInput = null;
            staleError = 'inputs spent: ' + chk.spent.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ');
          } else if (chk.conflict.length) {
            conflictInput = { spentBy: chk.conflict[0].spentBy || null, unverified: !!chk.conflict[0].unverified };
          } else {
            conflictInput = null;
          }
        } catch (e) {
          console.error('stale check failed for', tx.txid.slice(0, 12), e.message);
        }
      }
      const update = { id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight, found: c.found, checkedAt, staleInput, conflictInput };
      if (staleError) update.staleError = staleError;
      updates.push(update);
      out.push({ id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight ?? null, found: c.found !== false, checkedAt, staleInput, conflictInput });
    } catch (e) {
      console.error('confirmations check failed for', tx.txid.slice(0, 12), e.message);
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt, staleInput: b.staleInput || null, conflictInput: b.conflictInput || null });
    }
  }
  if (updates.length) {
    const fresh = store.loadState(DATA_DIR);
    let changed = false;
    for (const u of updates) {
      // Only apply to the same transaction, still broadcasted — a
      // tx deleted or replaced in the meantime gets no update.
      const tx = (fresh.bitcoin.txs || []).find((t) => t.id === u.id && t.broadcasted && t.broadcasted.txid === u.txid);
      if (tx) {
        // The confirmation is a transition — log it once,
        // on the crossing into confirmed. A tx already confirmed
        // (by the already-out path's block height, or an earlier
        // refresh) does not re-log. Confirmed means the node reports
        // it in a block (a count, or a height) — or confirmed with
        // the height unknown (confirmations null + found). An
        // unconfirmed tx reports a count of 0; a missing tx
        // reports found === false.
        const wasConfirmed = (typeof tx.broadcasted.confirmations === 'number' && tx.broadcasted.confirmations >= 1)
          || (typeof tx.broadcasted.blockHeight === 'number');
        const nowConfirmed = !!u.found && (u.confirmations === null || (typeof u.confirmations === 'number' && u.confirmations >= 1));
        if (!wasConfirmed && nowConfirmed) {
          pushHistory(tx, 'confirmed', (typeof u.blockHeight === 'number') ? 'Block ' + u.blockHeight.toLocaleString('en-US') : 'Confirmed');
          forwardMemberHistory(fresh, tx, 'confirmed', (typeof u.blockHeight === 'number') ? 'Block ' + u.blockHeight.toLocaleString('en-US') : 'Confirmed');
        }
        // The not-found verdict: a missing tx whose
        // input is spent-confirmed is stale — record it once, on
        // the transition, with the history event (forwarded to
        // the set's trail like every other member stale). A
        // conflict (an unconfirmed spend) is recorded, not
        // logged: it may still resolve either way, and a later
        // clean check clears it. A tx the network knows again
        // has its verdict cleared — a confirmed spend cannot
        // un-happen except by reorg, and then the tx is back
        // in play.
        if (u.found) {
          delete tx.broadcasted.staleInput;
          delete tx.broadcasted.conflictInput;
        } else if (u.staleInput) {
          if (!tx.broadcasted.staleInput) {
            tx.broadcasted.staleInput = u.staleInput;
            const err = u.staleError || 'inputs spent';
            pushHistory(tx, 'stale', err);
            noteSetMemberStale(fresh, tx, err);
          }
          delete tx.broadcasted.conflictInput;
        } else if (u.conflictInput) {
          tx.broadcasted.conflictInput = u.conflictInput;
        } else {
          delete tx.broadcasted.conflictInput;
        }
        tx.broadcasted.confirmations = u.confirmations;
        tx.broadcasted.blockHeight = u.blockHeight;
        tx.broadcasted.found = u.found;
        tx.broadcasted.checkedAt = u.checkedAt;
        changed = true;
      }
    }
    if (changed) { mergeNodeStamps(fresh); store.saveState(DATA_DIR, fresh); }
  }
  return out;
}

// Staged-transaction freshness. Without this, a staged tx whose
// inputs were spent elsewhere would go unnoticed until a dry run or
// the broadcast-time gate: refreshConfirmations only looks at
// broadcasted txs, and the tick only evaluates trigger rules —
// a UTXO rule watches the outpoint the owner named, not the tx's
// own inputs. So the hourly tick re-checks every live staged tx's
// inputs through the same shared per-outpoint cache as the other
// paths. A confirmed spend by another tx marks it stale — the same
// record + history + set note as the release-time set-stale path
// (kind 'release'; an already-stale tx is never re-checked, a
// confirmed spend is a chain fact). An unconfirmed spend changes
// nothing: it is a warning only, and the broadcast-time gate is
// the arbiter — same as the release path. A tx whose own txid is
// the spender is likewise left alone here (the dry run /
// broadcast-time recognition owns that case). No live staged txs
// → zero network requests. Returns [{ id, txid, action: 'stale',
// error }] for the txs it marked.
async function refreshStagedFreshness(state) {
  const endpoints = bitcoin.endpointsFor(state.settings);
  const now = new Date();
  // Live staged txs only: never broadcast, not terminal (a stale
  // record is terminal — see terminalSkipReason), and armed — a
  // standalone tx's own enabled, or its set's enabled for a
  // member (the set's arm gates every member). Disarmed txs are
  // not checked: they cannot broadcast, and the next hourly tick
  // after re-arming picks them up.
  const setByTxId = new Map();
  for (const set of (state.bitcoin.sets || [])) {
    for (const id of (set.txIds || [])) setByTxId.set(id, set);
  }
  const live = (state.bitcoin.txs || []).filter((tx) => {
    if (tx.broadcasted) return false;
    if (terminalSkipReason(tx)) return false;
    const set = setByTxId.get(tx.id);
    if (set) return !!set.enabled;
    return !!tx.enabled;
  });
  if (!live.length) return [];
  const findings = [];
  for (const tx of live) {
    let chk = null;
    try { chk = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints, checkCadenceSecondsOf(state.settings) * 1000); }
    catch (e) { console.error('staged freshness check failed for', (tx.label || tx.id) + ':', e.message); continue; }
    const f = chk && findingFor(tx.id, chk, { staleOnly: true });
    if (f) findings.push({ f, txid: tx.txid });
  }
  recordFindings(findings.map((x) => x.f), now, 'release');
  return findings.map((x) => ({ id: x.f.id, txid: x.txid, action: 'stale', error: x.f.stale.error }));
}

// Refresh the MARA-waiting transactions. For every tx
// whose release status is 'submitted-slipstream' — submitted to MARA
// Slipstream, not yet visible in the public mempool — check BOTH:
//   (a) the public node lookup: if the tx is now visible (in the
//       public mempool, unconfirmed, or confirmed) it is out there —
//       mined or relayed — so it becomes 'broadcast', with the
//       permanent broadcasted fact (method 'slipstream', since that
//       is how it went out). The release is then complete for it.
//   (b) Slipstream's own status endpoint: if it reports the tx as
//       failed/dropped (MARA no longer lists it), the tx is 'failed'
//       — the standard failure path — and the next evaluation retries
//       it via Slipstream. If Slipstream
//       still shows it queued, the queue info (position, next-block
//       likelihood) is refreshed on the record and the tx stays
//       'submitted-slipstream'.
// A status check that itself fails (endpoint down, unparseable)
// changes nothing — the tx stays waiting and is checked again next
// tick. This is a status refresh, not a broadcast: it runs on the
// hourly tick and on the manual release check regardless of the
// check-in clock (a MARA-waiting tx needs its status kept current
// even while the clock is on-track), and it is NOT withheld by an
// unreadable receiver check-in state (it writes no broadcast, only
// status). Returns [{ id, txid, action }] — 'broadcast', 'failed',
// 'still-waiting', or 'unchanged' (the status check failed).
async function refreshMaraWaiting(state) {
  const endpoints = bitcoin.endpointsFor(state.settings);
  const now = new Date();
  const out = [];
  const updates = [];
  for (const tx of (state.bitcoin.txs || []).filter((t) => t.release && t.release.status === 'submitted-slipstream')) {
    // (a) Public visibility first: if the public nodes see it, it
    // is out there and the release is done for this tx.
    let conf = null;
    try { conf = await bitcoin.getConfirmations(tx.txid, endpoints); } catch (e) { conf = null; }
    if (conf && conf.found) {
      updates.push({ id: tx.id, txid: tx.txid, kind: 'broadcast', confirmations: conf.confirmations, blockHeight: conf.blockHeight, checkedAt: new Date().toISOString() });
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast' });
      continue;
    }
    // (b) Not visible publicly — ask Slipstream whether it still
    // has it.
    const ms = await bitcoin.getSlipstreamTxStatus(tx.txid);
    if (ms.state === 'confirmed') {
      // MARA mined it (the public nodes have not caught up yet).
      updates.push({ id: tx.id, txid: tx.txid, kind: 'broadcast', confirmations: null, blockHeight: ms.blockHeight, checkedAt: new Date().toISOString() });
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast' });
      continue;
    }
    if (ms.state === 'failed') {
      updates.push({ id: tx.id, txid: tx.txid, kind: 'failed', error: 'Slipstream no longer lists this transaction — dropped from MARA\u2019s queue' });
      out.push({ id: tx.id, txid: tx.txid, action: 'failed' });
      continue;
    }
    if (ms.state === 'queued') {
      updates.push({
        id: tx.id, txid: tx.txid, kind: 'queue',
        mara: { position: ms.position, isNextBlock: ms.isNextBlock, last24hOdds: ms.last24hOdds, last7dOdds: ms.last7dOdds, checkedAt: new Date().toISOString() },
      });
      out.push({ id: tx.id, txid: tx.txid, action: 'still-waiting' });
      continue;
    }
    // 'unknown': the status check itself failed — leave the tx
    // waiting, check again next tick.
    out.push({ id: tx.id, txid: tx.txid, action: 'unchanged' });
  }
  if (updates.length) {
    // Merge into FRESH state (see refreshConfirmations): an edit
    // landing while the lookups were on the network would otherwise
    // be clobbered by the save of this stale copy.
    const fresh = store.loadState(DATA_DIR);
    let changed = false;
    for (const u of updates) {
      const tx = (fresh.bitcoin.txs || []).find((t) => t.id === u.id && t.release && t.release.status === 'submitted-slipstream');
      if (!tx) continue;
      if (u.kind === 'broadcast') {
        // Keep the record's kind ('release' vs 'broadcast'): the
        // check-in status turns 'broadcasted' only for a release
        // kind, exactly as for a public broadcast.
        const kind = tx.release.kind || 'release';
        tx.release = { status: 'broadcast', kind, trigger: releaseTriggerFor(fresh, tx), txid: u.txid, method: 'slipstream', broadcastedAt: now.toISOString() };
        tx.broadcasted = {
          txid: u.txid, broadcastedAt: now.toISOString(), method: 'slipstream',
          confirmations: u.confirmations, blockHeight: u.blockHeight, found: true, checkedAt: u.checkedAt,
        };
        // MARA's tx is out there now — log the broadcast,
        // and the confirmation when it is already in a block.
        pushHistory(tx, 'broadcast', 'txid ' + shortTxid(u.txid));
        forwardMemberHistory(fresh, tx, 'broadcast', 'txid ' + shortTxid(u.txid));
        if ((typeof u.confirmations === 'number' && u.confirmations >= 1) || (typeof u.blockHeight === 'number')) {
          pushHistory(tx, 'confirmed', (typeof u.blockHeight === 'number') ? 'Block ' + u.blockHeight.toLocaleString('en-US') : 'Confirmed');
          forwardMemberHistory(fresh, tx, 'confirmed', (typeof u.blockHeight === 'number') ? 'Block ' + u.blockHeight.toLocaleString('en-US') : 'Confirmed');
        }
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'broadcast', method: 'slipstream', txid: u.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: 'A Slipstream-submitted transaction is now visible via the public nodes — recorded as broadcast.',
        });
        changed = true;
      } else if (u.kind === 'failed') {
        tx.release = { status: 'failed', kind: tx.release.kind || 'release', trigger: releaseTriggerFor(fresh, tx), txid: u.txid, method: 'slipstream', lastAttemptAt: now.toISOString(), error: u.error };
        pushHistory(tx, 'failed', String(u.error || '').slice(0, 120));
        forwardMemberHistory(fresh, tx, 'failed', String(u.error || '').slice(0, 120));
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'failed', method: 'slipstream', txid: u.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: u.error + '. It will be retried via Slipstream on the next hourly check.',
        });
        changed = true;
      } else if (u.kind === 'queue') {
        tx.release.mara = u.mara;
        changed = true;
      }
    }
    if (changed) store.saveState(DATA_DIR, fresh);
  }
  return out;
}

// Public fallback: the automatic version of the manual
// "Broadcast publicly" escape hatch. For each Slipstream-route tx
// whose fallback deadline (fallbackDeadline) has passed, that is not
// publicly visible and not stale: broadcast it publicly via the
// existing broadcastTx (primary, then secondary). On success the
// stored route becomes 'public' (broadcastOne with forcePublic does
// that), the broadcasted fact is set, and the broadcast-log entry
// names the fallback (notePrefix via opts.fallbackDays). On failure
// the tx is left as-is — still Slipstream-pending or release-due —
// and the next tick re-attempts it (the deadline has passed, so every
// tick re-attempts until it succeeds or the tx resolves). NO 'failed'
// release record is written for a fallback failure (forcePublic
// skips it): the fallback re-attempt is its own cadence, and a
// 'failed' record would confuse the retry rule — exactly the manual
// escape hatch's reasoning.
// Guards — the fallback does NOT fire when: the duration is Never
// (null); the route is not slipstream; the tx is disarmed (the owner
// said don't broadcast it); the tx is already
// broadcasted or carries a 'broadcast' release record (settled — a
// restore can carry the record without the fact); the tx is stale
// (the freshness gate inside broadcastOne marks it stale and never
// broadcasts it). There is deliberately NO pause or vacation guard
// here: the fallback is post-broadcast bookkeeping — a tx
// already broadcast via Slipstream waiting to go public — not a
// trigger firing, and vacation is check-in-only (a disarmed tx
// is already excluded above). Public visibility is checked FIRST: if the public
// nodes already see the tx, it is marked broadcast (the normal
// recognition path — method is the node that reported it) and no
// fallback broadcast happens.
// A check-in does NOT cancel a due fallback: the fallback is not
// part of the release evaluation's clock gate (it runs alongside
// refreshMaraWaiting, regardless of the clock), and its deadline is
// anchored on submittedAt / firstAttemptAt, not on the cycle — a
// check-in clears the cycle record, but the next tick re-evaluates
// the same past deadline and fires. This is the point of the timer:
// the tx goes public even when nobody is watching.
// Runs on the hourly tick and on the manual release check, AFTER
// refreshMaraWaiting, so a tx MARA just confirmed as visible is not
// also fallback-broadcast. It is NOT reachable from Broadcast Armed
// (that path never calls it) and NOT triggered by the manual escape
// hatch (a separate, immediate path). Returns [{ id, txid, action,
// ... }] — 'broadcast', 'failed', or 'stale' per tx.
async function refreshPublicFallbacks(state) {
  const out = [];
  const endpoints = bitcoin.endpointsFor(state.settings);
  const now = new Date();
  for (const tx of (state.bitcoin.txs || [])) {
    if (tx.broadcastVia !== 'slipstream') continue;
    if (!tx.enabled) continue;
    if (validPublicFallbackDays(tx.publicFallbackDays) === null) continue;
    if (tx.broadcasted) continue;
    if (tx.release && (tx.release.status === 'stale' || tx.release.status === 'broadcast')) continue;
    const deadline = fallbackDeadline(tx);
    if (!deadline || now.getTime() < deadline.getTime()) continue;
    // Public visibility first: if the nodes already see it, it is
    // out there — mark it broadcast, do not send it again. (For a
    // submitted-slipstream tx refreshMaraWaiting normally gets here
    // first; this branch is mostly for a release-due tx whose submit
    // kept failing but which is visible anyway — someone else sent
    // it, or MARA mined it without the status endpoint knowing.)
    let conf = null;
    try { conf = await bitcoin.getConfirmations(tx.txid, endpoints); } catch (e) { conf = null; }
    if (conf && conf.found) {
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id && t.hex === tx.hex && !t.broadcasted);
      if (ftx) {
        const kind = (ftx.release && ftx.release.kind) || 'release';
        ftx.release = { status: 'broadcast', kind, trigger: releaseTriggerFor(fresh, ftx), txid: tx.txid, method: conf.checkedVia || 'slipstream', broadcastedAt: now.toISOString() };
        ftx.broadcasted = {
          txid: tx.txid, broadcastedAt: now.toISOString(), method: conf.checkedVia || 'slipstream',
          confirmations: conf.confirmations, blockHeight: conf.blockHeight, found: true, checkedAt: new Date().toISOString(),
        };
        store.appendBroadcastLog(DATA_DIR, {
          ts: now.toISOString(), kind: 'release', status: 'broadcast', method: conf.checkedVia || 'slipstream', txid: tx.txid,
          hexPreview: tx.hex.slice(0, 64),
          note: 'A Slipstream transaction whose public-fallback deadline had passed is already visible via the public nodes — recorded as broadcast; nothing was sent.',
        });
        store.saveState(DATA_DIR, fresh);
      }
      out.push({ id: tx.id, txid: tx.txid, action: 'broadcast', alreadyVisible: true });
      continue;
    }
    // Not visible: broadcast it publicly. The fallback's own deadline
    // is the trigger, not the check-in clock; forcePublic forces the
    // public route past the 'submitted-slipstream' block, sets the
    // stored route to 'public' on success, and skips the 'failed'
    // record on failure. fallbackDays marks the log entry.
    const r = await rules.broadcastOne(state, tx, endpoints, now, 'release', { forcePublic: true, fallbackDays: tx.publicFallbackDays });
    out.push({ id: tx.id, txid: tx.txid, action: r.action, method: r.method, error: r.error, reason: r.reason });
  }
  return out;
}

// One release tick: load fresh state, evaluate. Runs hourly and once
// shortly after startup (see the bottom of this file). The tick also
// re-tests the nodes, so the Dashboard status is fresh even when the
// owner has not opened the app — they can see it when they go to check
// in — and refreshes the confirmation count for any broadcast
// transaction, so the stored number stays accurate even when the UI is
// closed. Best-effort: a node test or a confirmations refresh never
// breaks the tick.
// Fee verdict: the peak is the
// 90th percentile of the hourly economy-fee observations Standby
// records from its own nodes — one observation per hourly tick,
// from the primary node, falling back to the secondary when the
// primary cannot answer. The history lives in state.json (see
// lib/store.js FEE_HISTORY_*), so it survives restarts and rides
// the backup; the peak itself is DERIVED from it on every read
// (feePeakForState below), never cached and never stored
// separately. An hour when both nodes fail records nothing and
// leaves the peak unchanged. The peak is served only once 24
// observations spanning a full day have accumulated — before that
// the historical check is skipped. A failed recording never breaks
// the tick.
async function recordFeeHistoryObservation(state) {
  const endpoints = bitcoin.endpointsFor(state.settings);
  const readings = await bitcoin.fetchNodeFeeReadings(endpoints);
  const combined = bitcoin.combineFeeReadings(readings);
  if (!combined.valid) {
    console.error('fee-history observation skipped (no usable economy fee):', combined.reason || 'no reading');
    return false;
  }
  // Merge into FRESH state (see testNodes, refreshConfirmations):
  // an edit landing while the node fetch was on the network — a
  // disarm, a trigger change — would otherwise be clobbered by
  // saving the pre-fetch copy this function was handed. The
  // passed-in state is used only for the endpoints/settings read.
  const fresh = store.loadState(DATA_DIR);
  fresh.feeHistory = bitcoin.appendFeeHistoryObservation(fresh.feeHistory, combined.fee, Date.now());
  store.saveState(DATA_DIR, fresh);
  return true;
}

// The current recommended fees: the
// configured nodes' /fees/recommended (mempool) or /fee-estimates
// (Esplora, mapped) — the primary first, the secondary on
// failure — NEVER a public base. Cached in memory and refreshed
// once an hour: on the hourly tick when the cached value is older
// than 1h, and once shortly after startup. The current fee moves
// fast, so a value older than 2h is served as null — the Critical
// check is then skipped and the verdict falls back to the
// historical ladder, rather than judging a live fee against a
// stale one. Like the peak, the current fees are derived, never
// stored in state.json.
const FEE_CURRENT_REFRESH_MS = 60 * 60 * 1000; // refresh once an hour
const FEE_CURRENT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // older than this: no Critical check

async function refreshCurrentFeesIfStale() {
  if (caches.currentFees.fetchedAt && (Date.now() - caches.currentFees.fetchedAt) < FEE_CURRENT_REFRESH_MS) return;
  try {
    const st = store.loadState(DATA_DIR);
    const endpoints = bitcoin.endpointsFor(st.settings);
    const fees = await bitcoin.fetchCurrentFeesFromEndpoints(endpoints);
    caches.currentFees = { fees, fetchedAt: Date.now() };
  } catch (e) {
    console.error('current-fees refresh failed (keeping last cached value):', e.message);
  }
}

// The current recommended fees to serve with the state: the cached
// object, or null when there is nothing cached or the cached value
// is too old to present as current. The fetched-at timestamp rides
// along so the value is clearly labelled, never silently stale.
function currentFeesForState() {
  if (!caches.currentFees.fees || !caches.currentFees.fetchedAt) return { fees: null, fetchedAt: null };
  if ((Date.now() - caches.currentFees.fetchedAt) > FEE_CURRENT_MAX_AGE_MS) return { fees: null, fetchedAt: null };
  return { fees: caches.currentFees.fees, fetchedAt: new Date(caches.currentFees.fetchedAt).toISOString() };
}

// The peak to serve with the state: computed from the
// recorded fee history in the given state — the 90th percentile
// of the hourly economy-fee observations, the window they span,
// how many there are, and the latest observation's timestamp.
// The basis is always fee estimates (one consistent day-scale
// measurement across mempool, Esplora, and RPC modes). Null peak
// until 24 observations have accumulated; the fetchedAt rides
// along so the value is clearly labelled, never silently stale.
function feePeakForState(state) {
  const res = bitcoin.feePeakFromObservations(state && state.feeHistory, Date.now());
  return { peak: res.peak, windowDays: res.windowDays, observations: res.observations, fetchedAt: res.fetchedAt, basis: 'fee-estimates' };
}

// The full-evaluation tick: ONE tick evaluates every rule
// type together, on the check cadence (Settings: Check cadence,
// default 60 s). It replaces the two-tick split (an hourly tick
// for check-in only, a fast tick for the five fast types): an AND
// set spanning the two domains — check-in AND price, say — can
// only fire when both rules are judged at the same tick, and the
// split ticks never did that (only a manual release check did).
// The cadence is a fast-trigger cadence: a setup with no
// non-manual rule never runs this tick, so a manual-only setup
// makes no extra API calls, and a check-in-only setup costs only
// the clock math (a timestamp compare — no network). The
// evaluation is the same single-flight evaluateRelease() the
// manual check uses, with no type filter — so every rule is
// judged together, every tick.
//   The stamp block (grace, vacation expiry, the
//   "I was online" stamp) runs here, before the evaluation, on
//   the same reasoning as before: the grace is judged on the stamp
//   as it stands BEFORE this tick refreshes it. Refreshing it
//   every minute instead of hourly changes nothing — while the
//   app runs the stamp stays fresh, and only real downtime
//   grows the gap. A dated vacation now expires within a minute
//   of its end instead of within an hour.
//   Housekeeping (node tests, confirmation / MARA / fallback
//   refreshes, fee caches) is NOT here — it stays hourly in
//   runHourlyTick below, on its own cadence, so the merge does
//   not re-time it.
async function runFullTick() {
  const now = new Date();
  // The grace: judged on the "I was
  // online" stamp as it stands BEFORE this tick refreshes it —
  // refreshing first would shrink the gap to zero and the grace
  // could never be set. The stamp is then refreshed (so the gap is
  // measured from this tick onward) and recorded even when the
  // evaluation below is skipped.
  try {
    const st0 = store.loadState(DATA_DIR);
    mergeExternalCheckin(st0, now);
    applyGrace(st0, now); // the grace for all triggers — judged on the same stale stamp, before it is refreshed; the save below persists it when it sets one
    // Vacation expiry: a dated vacation ends at the end
    // of its last day — the clock resumes from its frozen count.
    // Judged here on the full tick (and on every release
    // evaluation, see evaluateRelease), so a lapsed vacation
    // never lingers past the next tick.
    expireVacation(st0, now);
    // The "I was online" stamp does not
    // live in state.json: the tick records liveness in the
    // heartbeat file instead (throttled to one write per 5
    // minutes), and loadState merges it back on every read — so
    // the stamp applyGrace judged on above is at most 5 minutes
    // old, far below any grace threshold, and an expired grace
    // cannot re-set on the next read. The save below still runs,
    // but saveState's dedupe skips the write when nothing
    // meaningful changed (a grace activation, a vacation expiry,
    // a merged check-in, or a node-stamp change still writes).
    store.touchHeartbeat(DATA_DIR, now.toISOString());
    mergeNodeStamps(st0);
    store.saveState(DATA_DIR, st0);
  } catch (e) { console.error('grace / lastOnlineAt update failed:', e); }
  // A receiver check-in lands in the clock before the release is
  // evaluated, so a check-in that arrived between ticks is honoured
  // even if nobody opened the app.
  // The price cache refresh runs first, so the price rule's
  // "currently $X" line stays fresh even while its trigger is held
  // by a grace.
  try {
    await refreshPriceIfStale();
    const st = store.loadState(DATA_DIR);
    // Any tx with a non-manual rule keeps the tick
    // evaluating — armed or not — so disarmed txs' statuses stay
    // live. A manual-only setup still makes no extra API calls.
    // A set with a non-manual rule keeps it evaluating
    // too — a set's triggers are evaluated once per tick, like a
    // tx's.
    const hasWork = (st.bitcoin.txs || []).some((t) => store.triggerTypesOf(t).some((ty) => ty !== 'manual'))
      || (st.bitcoin.sets || []).some((s) => store.triggerOf(s).rules.some((r) => r.type !== 'manual'));
    if (!hasWork) return;
    const r = await evaluateRelease({ automatic: true });
    if (r.action !== 'skipped') {
      const sum = (r.results || []).map((x) => x.action + ':' + (x.txid || '').slice(0, 8)).join(', ');
      console.log('full tick:', r.action, sum || r.reason || '');
    }
  } catch (e) { console.error('full tick failed:', e); }
}

// The hourly tick: housekeeping only — release evaluation is
// runFullTick above. This tick runs the work that is genuinely
// hourly — node
// capability tests, confirmation counts, MARA-waiting and public
// fallback refreshes, the fee-peak / current-fee caches (each
// with its own TTL, so they refresh at most once per their own
// period). Nothing here broadcasts.
async function runHourlyTick() {
  try {
    await testNodes();
  } catch (e) { console.error('node check failed:', e); }
  try {
    const st = store.loadState(DATA_DIR);
    await refreshConfirmations(st, 0);
  } catch (e) { console.error('confirmations refresh failed:', e); }
  // Staged freshness: a staged tx whose inputs were
  // spent elsewhere reads stale on its own now, instead of
  // waiting for a dry run or a firing trigger to notice.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshStagedFreshness(st);
  } catch (e) { console.error('staged freshness refresh failed:', e); }
  // MARA-waiting transactions: a Slipstream submission
  // that is not yet visible publicly needs its status kept current
  // even while the clock is on-track — the refresh runs regardless
  // of the clock.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshMaraWaiting(st);
  } catch (e) { console.error('MARA-waiting refresh failed:', e); }
  // Public fallback: a Slipstream transaction whose
  // fallback deadline has passed goes public — after the MARA
  // refresh above, so a tx MARA just confirmed as visible is not
  // also fallback-broadcast. Runs regardless of the clock, like
  // the MARA refresh.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshPublicFallbacks(st);
  } catch (e) { console.error('public-fallback refresh failed:', e); }
  // Fee verdict: record one hourly economy-fee
  // observation, so the peak keeps building from the nodes'
  // own readings. Best-effort — a failed recording never breaks
  // the tick (an hour with no usable fee simply adds no
  // observation and leaves the peak unchanged).
  try {
    const st = store.loadState(DATA_DIR);
    await recordFeeHistoryObservation(st);
  } catch (e) { console.error('fee-history observation failed:', e); }
  // Fee verdict: refresh the current recommended fees when
  // they are older than an hour, so the Critical Risk check judges
  // a live fee against a live market. Best-effort — a failed
  // refresh never breaks the tick (the Critical check is skipped
  // until the fees come back).
  try { await refreshCurrentFeesIfStale(); } catch (e) { console.error('current-fees refresh failed:', e); }
}

// Per-endpoint "last checked" stamps: the tick asks the
// primary every time and the secondary only on fallback, so the
// two node rows need their own times. bitcoin.js stamps each
// endpoint base whenever it answers a request; this folds the
// live stamps into the stored connection object (keyed by
// endpoint label) before a save. A stamp the live map doesn't
// have yet keeps its stored value — a fresh boot never wipes a
// recorded check, and an endpoint never asked stays null (its
// row shows no time rather than an invented one). Call before
// an existing save; it never saves by itself.
function mergeNodeStamps(state) {
  if (!state.bitcoin || typeof state.bitcoin !== 'object') state.bitcoin = {};
  if (!state.bitcoin.connection || typeof state.bitcoin.connection !== 'object') {
    state.bitcoin.connection = { ok: null, checkedAt: null, detail: '' };
  }
  const conn = state.bitcoin.connection;
  const cur = (conn.nodeCheckedAt && typeof conn.nodeCheckedAt === 'object') ? conn.nodeCheckedAt : null;
  conn.nodeCheckedAt = {
    primary: (cur && cur.primary) || null,
    secondary: (cur && cur.secondary) || null,
  };
  const stamps = bitcoin.nodeCheckedAt ? bitcoin.nodeCheckedAt() : {};
  for (const ep of bitcoin.endpointsFor(state.settings)) {
    const at = stamps[ep.base];
    if (at) conn.nodeCheckedAt[ep.label] = at;
  }
}

// Test both nodes and save the per-endpoint results, so the Dashboard
// can show each node's own status. The full result (endpoint, base,
// ok, detail) is stored — the Dashboard only trusts a result measured
// against the endpoint as currently configured.
async function testNodes() {
  const state = store.loadState(DATA_DIR);
  // The hourly tick does NOT probe output lookup (see
  // testConnection): it reuses the last probed check for each
  // endpoint, from the stored connection results, so the tick
  // costs no outspend request and never warms the negotiation's
  // shape record. A fresh probe happens on the Test connection
  // button instead.
  const prevResults = (state.bitcoin.connection && Array.isArray(state.bitcoin.connection.results)) ? state.bitcoin.connection.results : [];
  const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings), { probeOutputLookup: false, prevResults });
  // Merge into FRESH state (see refreshConfirmations): an edit landing
  // while the node test was on the network would otherwise be
  // clobbered by the save of this stale copy. The Dashboard only
  // trusts a result measured against the endpoints as currently
  // configured, so a result measured against just-replaced endpoints
  // is ignored, not misattributed.
  const fresh = store.loadState(DATA_DIR);
  // A Test connection that finished while this tick was on the
  // network saved a newer result — with a fresh Output lookup
  // probe this tick does not have. Keep it; this tick's result is
  // the older one.
  const startedFrom = state.bitcoin.connection ? state.bitcoin.connection.checkedAt : null;
  const current = fresh.bitcoin.connection ? fresh.bitcoin.connection.checkedAt : null;
  if (current !== startedFrom) return;
  // The connection object is rebuilt, so the per-endpoint
  // stamps ride over explicitly — a test that could not reach an
  // endpoint keeps that endpoint's last-answered time instead of
  // losing it. The live stamps (the test just asked both
  // endpoints) overwrite them below.
  const prevStamps = (fresh.bitcoin.connection && fresh.bitcoin.connection.nodeCheckedAt) || null;
  fresh.bitcoin.connection = { ok: r.ok, checkedAt: new Date().toISOString(), detail: r.detail, results: r.results };
  if (prevStamps) fresh.bitcoin.connection.nodeCheckedAt = { primary: prevStamps.primary || null, secondary: prevStamps.secondary || null };
  mergeNodeStamps(fresh);
  store.saveState(DATA_DIR, fresh);
}

// Stored fees self-correct at startup: a
// fee stored wrong — e.g. by the pre-fix code, which read the
// parent vout value as BTC and multiplied by 1e8 — is recomputed
// from the node and overwritten, so a wrong fee displays correct
// after the next restart with nobody re-adding the tx. A fee the
// node cannot recompute (unknown parent, unreachable node) is left
// alone: null means "unknown", never "zero", so a failed lookup
// must not wipe a stored fee — and a stored fee is only overwritten
// when the recompute returns a value. Runs in the background
// shortly after startup; never throws; saves only when something
// changed. The fresh state is reloaded just before saving, so a
// release tick that saved in the meantime is not clobbered.
async function recomputeStoredFees() {
  try {
    const st = store.loadState(DATA_DIR);
    const txs = st.bitcoin.txs || [];
    if (!txs.length) return;
    const endpoints = bitcoin.endpointsFor(st.settings);
    const fresh = await Promise.all(txs.map(async (tx) => {
      try {
        const fee = await bitcoin.computeFee(bitcoin.parseTx(tx.hex), endpoints);
        return { id: tx.id, fee };
      } catch { return { id: tx.id, fee: null }; }
    }));
    const computed = fresh.filter((f) => f.fee && typeof f.fee.feeSats === 'number');
    if (!computed.length) return;
    const st2 = store.loadState(DATA_DIR);
    let any = false;
    for (const f of computed) {
      const tx = (st2.bitcoin.txs || []).find((t) => t.id === f.id);
      if (!tx) continue;
      if (tx.feeSats !== f.fee.feeSats || tx.feeRateSatVb !== f.fee.feeRateSatVb) {
        tx.feeSats = f.fee.feeSats;
        tx.feeRateSatVb = (typeof f.fee.feeRateSatVb === 'number') ? f.fee.feeRateSatVb : null;
        any = true;
      }
    }
    if (any) {
      store.saveState(DATA_DIR, st2);
      console.log('startup fee recompute: corrected stored fee(s)');
    }
  } catch (e) { console.error('startup fee recompute failed:', e); }
}
// The full tick: every rule type is evaluated every
// checkCadenceSeconds (Settings: Check cadence; default 60) while
// one non-manual rule is armed. The interval is re-armed from the
// saved setting whenever the setting changes (PUT /api/settings,
// restore), so a new cadence takes effect without a restart — the
// old interval is cleared first, so there is never more than one
// full tick running.
let fullTickTimer = null;
function rearmFullTick() {
  if (fullTickTimer) clearInterval(fullTickTimer);
  // loadState throws when state.json is corrupt and no
  // backup loads — a loud failure by design, but it must not kill
  // the process here at startup: fall back to the default cadence
  // and keep answering (the API reports the corruption as a 500)
  // until the owner restores a backup. Without this, a corrupt
  // state would crash-loop the server instead of staying up to
  // say what is wrong.
  let seconds = 60;
  try {
    seconds = checkCadenceSecondsOf(store.loadState(DATA_DIR).settings);
  } catch (e) { console.error('Standby: could not read check cadence, using 60 s:', e.message); }
  fullTickTimer = setInterval(runFullTick, seconds * 1000);
}

module.exports = { releaseEvaluationInFlight, BROADCAST_BACKOFF_MS, ARCHIVED_CONFIRMATIONS, terminalSkipReason, evaluateRelease, storedRuleOutcomes, storedCombinedDue, evaluateReleaseInner, refreshConfirmations, refreshStagedFreshness, refreshMaraWaiting, refreshPublicFallbacks, recordFeeHistoryObservation, FEE_CURRENT_REFRESH_MS, FEE_CURRENT_MAX_AGE_MS, refreshCurrentFeesIfStale, currentFeesForState, feePeakForState, runFullTick, runHourlyTick, mergeNodeStamps, testNodes, recomputeStoredFees, fullTickTimer, rearmFullTick };
