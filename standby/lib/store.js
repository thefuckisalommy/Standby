'use strict';
// Standby — plain-file JSON storage. No database server.
// All state lives in DATA_DIR/state.json; check-ins and broadcast attempts
// are append-only JSONL audit logs in the same directory.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const STATE_FILE = 'state.json';
const CHECKIN_LOG = 'checkins.jsonl';
const BROADCAST_LOG = 'broadcast.jsonl';

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 7,
    createdAt: now,
    updatedAt: now,
    settings: {
      primaryApiUrl: 'https://mempool.space', // the primary node: a mempool API endpoint (any mempool.space-compatible instance — another public one, or your own mempool on the LAN)
      secondaryApiUrl: 'https://blockstream.info/api', // the secondary node, tried only if the primary does not answer; blank = primary runs alone
      priceSources: { source1: 'coingecko', source2: 'coinbase' }, // the two BTC price feeds for price rules — each a provider id (see PRICE_PROVIDERS in lib/bitcoin.js) or a custom { id: 'custom', url, path } object (0.8.1); a reading is only trusted when the two agree within the configured agreement (Settings: Price agreement), and when they agree the primary source's price is the one that decides
      // Price agreement (0.8.0): the two BTC price sources must
      // agree within this % for a reading to count (Settings:
      // Price agreement; 1–20, default 5). Tighter is safer but
      // the rule waits ("unknown") more during fast moves; looser
      // fires more readily.
      priceAgreementPct: 5,
      // Check cadence (0.8.0): how often the fast tick evaluates
      // price + UTXO triggers, in seconds (Settings: Check
      // cadence; 10–3600, default 60). Faster catches an
      // unconfirmed spend and brief price spikes sooner; slower
      // means fewer API calls.
      checkCadenceSeconds: 60,
      // Fee verdict thresholds (0.8.0): the fee pill's Low and
      // Medium Risk thresholds, as multiples of the 90-day peak
      // (Settings: Fee verdict; Low 1–10 default 2, Medium
      // 0.5–5 default 1, Low must stay above Medium). A fee at
      // or above Low is Low Risk; at or above Medium is Medium
      // Risk; below Medium is High Risk. The Critical check (fee
      // below the current economy fee) is separate and unchanged.
      feeLowMultiplier: 2, feeMediumMultiplier: 1,
      // Grace period (0.8.0): when the app comes back after being
      // offline longer than graceOfflineDays, price and UTXO
      // triggers are paused for graceDurationDays (null =
      // indefinite, until the owner resumes) so they do not fire
      // on conditions that changed while the app was away.
      // Check-in triggers are not affected (they keep their own
      // heldUntil hold). See server.js applyGrace.
      graceOfflineDays: 7, graceDurationDays: 7,
      // Vacation mode (0.8.0): while it is on, the check-in
      // countdown is FROZEN — the days away never count toward a
      // release — and it applies to check-in rules only (price and
      // UTXO rules keep firing). vacationUntil is the last away
      // day ('YYYY-MM-DD'); null means indefinite, until the owner
      // says they are back. A legacy '' restores as null (see
      // loadState below).
      vacationMode: false,
      vacationUntil: null,
    },
    // Pre-signed Bitcoin transactions: a LIST, each with its own enable
    // and its own release record. The stored tx is raw signed hex ONLY —
    // the server never sees keys.
    // tx = { id, txid, hex, label, notes, createdAt, inputs, outputs,
    //   totalOutSats, feeSats, feeRateSatVb, locktime, segwit, enabled, broadcastVia,
    //   trigger, triggerState, history,
    //   release: null | { status: 'broadcast'|'failed'|'stale'|'submitted-slipstream', txid,
    //     method, broadcastedAt | lastAttemptAt, error?, mara? },
    //   broadcasted: null | { txid, broadcastedAt, method,
    //     confirmations, blockHeight, found, checkedAt } }
    // history (0.8.2) is the tx's own event trail — [{ ts, type,
    // detail }], oldest first, capped at 50 — only transitions
    // (added, fired, broadcast, confirmed, stale, failed, conflict,
    // edited, armed, disarmed, slipstream), never the hourly
    // release checks.
    // trigger (0.8.2) is the rule SET that fires this transaction —
    // { op: 'AND' | 'OR', rules: [...] } — one rule per entry, each
    // { type, params } (see normalizeTrigger below). triggerState is
    // the per-rule last evaluation — an array parallel to the rules
    // (index-keyed), each entry the slice that rule's evaluator
    // wrote ({ lastEvalAt, status, reason, lastPrice, lastOutspend,
    // ... } — the fields depend on the type) or null when that rule
    // has never been evaluated; the whole triggerState is null until
    // the release has evaluated any rule once. A one-rule set is
    // served to the API as its single rule (legacy shape — see
    // serveTrigger in server.js), so the 0.8.1 frontend keeps
    // working while the stored form is always the set.
    // release is the current cycle's record (a check-in clears it);
    // broadcasted is the permanent fact that the tx went out (a
    // check-in never clears it; replacing the hex does).
    // Connection is the last Test-connection result { ok, checkedAt,
    // detail } or { ok: null, ... } if untested. nodeCheckedAt is
    // each endpoint's own last-answered time { primary, secondary }
    // (0.8.5) — the tick asks the primary every time and the
    // secondary only on fallback, so the two stamps diverge; null
    // means that endpoint has never answered.
    // Shared trigger sets (0.8.7): one trigger set driving several
    // transactions — define the triggers once, attach the txs, and
    // when the set fires every attached tx broadcasts. A set is
    // { id, label, enabled, txIds, trigger, triggerState, history,
    //   createdAt, checkinOffsetMs, checkinInactiveSince } — the
    // same rule-set shape, triggerState, history, and check-in
    // freeze a transaction carries, at set level. A tx in a set
    // keeps its own trigger stored (it resumes when the tx leaves
    // the set); while attached, the set's trigger is the one
    // evaluated, once per tick for all members. Deleting a set
    // never deletes its txs — they return to standalone.
    // A state file from before 0.8.7 carries no sets: mergeDefaults
    // fills [] and the load-time sanitizer below normalizes any
    // hand-edited entry, so no version bump is needed.
    bitcoin: { txs: [], sets: [], connection: { ok: null, checkedAt: null, detail: '', nodeCheckedAt: { primary: null, secondary: null } } },
    // The check-in clock: lastCheckinAt is the last recorded
    // check-in, totalCheckins counts them. lastOnlineAt (0.7.22)
    // is the last time the app itself was alive — written on every
    // hourly release tick, so a long gap in it means the device was
    // off, not that the owner stopped checking in. heldUntil
    // (0.7.22) is the offline-gap grace: a persisted "broadcast no
    // earlier than" instant, set when the app comes back after a
    // long offline gap with the clock far along, cleared by a
    // check-in. Both are null until first used.
    checkin: { lastCheckinAt: null, totalCheckins: 0, lastOnlineAt: null, heldUntil: null },
    // Grace period state (0.8.0): nulls = no grace was ever set
    // (or it was resumed / expired). graceUntil null = an
    // indefinite grace, active until resumed. See server.js
    // graceStatus / applyGrace.
    grace: { graceUntil: null, triggeredAt: null, offlineGapDays: null },
    // Check-in API keys: one per service that may check in for the
    // owner (a bot, a shortcut, an AI assistant). A key is a bearer
    // token that authorizes exactly one thing — recording a check-in,
    // via the check-in receiver. Only the SHA-256 hash is stored; the
    // plaintext key is shown once, at creation, and never again.
    // key = { id, label, hash, createdAt, lastUsedAt }
    checkinKeys: [],
  };
}

function newTxId() {
  return 'tx_' + crypto.randomBytes(4).toString('hex');
}

function newSetId() {
  return 'set_' + crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Triggers (0.8.0, rule sets 0.8.2). Each transaction carries a rule
// SET — { op: 'AND' | 'OR', rules: [...] } — and the check-in clock
// is one rule type:
//   checkin { thresholdDays } — fire when the check-in clock is
//     release-due at this rule's own threshold.
//   price   { asset: 'BTC', op: '>=' | '<=', value } — fire when
//     the BTC price (USD) is at/above (or at/below) value and both
//     price sources agree (no sustained wait).
//   utxo    { outpoint: 'txid:vout', condition: 'spent' } — fire
//     when the outpoint is spent by a confirmed transaction.
//   manual  {} — never fires; the owner broadcasts it by hand.
// A tx with no trigger (an older state file) defaults to a one-rule
// OR set holding the check-in trigger at the 35-day fallback, so
// existing behaviour is unchanged. The price value is bounded (a
// trigger for $0 or $999,999,999 is a typo, not a rule); the outpoint
// must be a 64-hex txid, a colon, and an output index.
// (0.8.2) MAX_RULES_PER_TX caps the rules in one set — a proposed
// cap, not Ryan's decision (5 is enough for any real rule set and
// keeps the combine readable); raise it here if a set ever needs more.
// ---------------------------------------------------------------------------
const TRIGGER_TYPES = ['checkin', 'price', 'utxo', 'manual', 'blockheight', 'setdate', 'feemarket'];
const MAX_RULES_PER_TX = 5;
// (0.8.2) The per-transaction history event types — the only
// types a history entry may carry (see server.js pushHistory and
// the load-time backfill below). 'slipstream' is the MARA
// submission; 'conflict' is the dry-run's unconfirmed-spend
// warning. Only transitions are recorded — never the hourly
// release checks.
const HISTORY_TYPES = new Set(['added', 'fired', 'broadcast', 'slipstream', 'confirmed', 'stale', 'failed', 'conflict', 'edited', 'armed', 'disarmed']);
const HISTORY_MAX = 50;
// (0.8.7, round 9) Single history: a set's trail is the ONE
// history for the whole set — the card shows only it, and a
// member's own history (which keeps recording, so a tx that
// leaves the set still has its full trail) is copied in here,
// tagged with the member's label. memberHistoryDetail is the
// tagging the server's forwardMemberHistory uses for live
// events; backfillSetHistory is the copy-in used at set
// creation, on attach, and once on load for sets created
// before this change (see the set sanitizer below).
function memberHistoryDetail(tx, detail) {
  const label = (tx && tx.label) || 'Untitled transaction';
  return detail ? label + ': ' + detail : label;
}
function backfillSetHistory(set, txs) {
  // Events already on the trail (same type + detail — a live
  // forward, or an earlier backfill) are skipped by count, so
  // a re-attach never shows the same line twice; genuine
  // repeats inside one member's own trail are kept. The merged
  // trail stays chronological, capped at the newest HISTORY_MAX.
  const remaining = new Map();
  for (const e of (set.history || [])) {
    const key = e.type + '|' + e.detail;
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const incoming = [];
  for (const t of (txs || [])) {
    for (const e of (Array.isArray(t.history) ? t.history : [])) {
      const tagged = { ts: e.ts, type: e.type, detail: memberHistoryDetail(t, e.detail) };
      const key = tagged.type + '|' + tagged.detail;
      const n = remaining.get(key) || 0;
      if (n > 0) { remaining.set(key, n - 1); continue; }
      incoming.push(tagged);
    }
  }
  if (!incoming.length) return;
  set.history = (set.history || []).concat(incoming)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-HISTORY_MAX);
}
// (0.8.0) The check-in fallback: there is no global broadcast
// threshold any more — each check-in tx carries its own
// thresholdDays ("Days of silence"). A tx with no usable trigger
// defaults to check-in at 35 days, and a new check-in tx
// defaults to 35 days too.
const FALLBACK_THRESHOLD_DAYS = 35;
const PRICE_MIN_USD = 1;
const PRICE_MAX_USD = 100000000;

function clampThresholdDays(v, fallback) {
  const n = (typeof v === 'number' && Number.isFinite(v)) ? Math.floor(v) : fallback;
  return Math.max(1, Math.min(3650, n));
}

function defaultTrigger() {
  return { type: 'checkin', params: { thresholdDays: FALLBACK_THRESHOLD_DAYS } };
}

// The default rule set: one check-in rule at the 35-day fallback.
function defaultTriggerSet() {
  return { op: 'OR', rules: [defaultTrigger()] };
}

// Validate + normalize ONE rule (from a client, a backup, or a
// stored state file). Returns { trigger } (normalized) or
// { error: '...' } — never throws, so a bad rule is a
// validation error, not a crash. A check-in thresholdDays is
// clamped to 1..3650 (a range issue is not a rejection);
// a non-numeric one is.
function normalizeRule(input) {
  if (input === undefined || input === null) return { error: 'trigger is required' };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'trigger must be an object with a type' };
  const params = (input.params && typeof input.params === 'object' && !Array.isArray(input.params)) ? input.params : {};
  switch (input.type) {
    case 'checkin': {
      if (params.thresholdDays !== undefined && (typeof params.thresholdDays !== 'number' || !Number.isFinite(params.thresholdDays))) {
        return { error: 'check-in trigger thresholdDays must be a number of days' };
      }
      return { trigger: { type: 'checkin', params: { thresholdDays: clampThresholdDays(params.thresholdDays, FALLBACK_THRESHOLD_DAYS) } } };
    }
    case 'price': {
      if (params.op !== '>=' && params.op !== '<=') return { error: "price trigger op must be '>=' or '<='" };
      const v = params.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'price trigger value must be a number of US dollars' };
      if (v < PRICE_MIN_USD || v > PRICE_MAX_USD) return { error: 'price trigger value must be between $' + PRICE_MIN_USD.toLocaleString('en-US') + ' and $' + PRICE_MAX_USD.toLocaleString('en-US') };
      return { trigger: { type: 'price', params: { asset: 'BTC', op: params.op, value: v } } };
    }
    case 'utxo': {
      const outpoint = typeof params.outpoint === 'string' ? params.outpoint.trim() : '';
      if (!/^[0-9a-fA-F]{64}:[0-9]+$/.test(outpoint)) return { error: "utxo trigger outpoint must be 'txid:vout' — a 64-hex transaction id, a colon, and an output index" };
      // (0.8.0) How many confirmations the spending tx needs
      // before the rule fires: 0 = fire on an unconfirmed
      // (mempool) spend, N >= 1 = fire once the spend has N
      // confirmations. Omitted (legacy / migrated) means 1 —
      // confirmed-only, the 0.8.0 behaviour — so current rules
      // keep working unchanged.
      let confirmations = 1;
      if (params.confirmations !== undefined) {
        if (typeof params.confirmations !== 'number' || !Number.isInteger(params.confirmations) || params.confirmations < 0 || params.confirmations > 100) {
          return { error: 'utxo trigger confirmations must be an integer from 0 (unconfirmed) to 100' };
        }
        confirmations = params.confirmations;
      }
      return { trigger: { type: 'utxo', params: { outpoint: outpoint.toLowerCase(), condition: 'spent', confirmations } } };
    }
    case 'manual':
      return { trigger: { type: 'manual', params: {} } };
    case 'blockheight': {
      // (0.8.1) Fire when the chain tip reaches a height. The
      // height is a positive integer; a reorg cannot un-fire it
      // (once the tip has reached the height, the rule has fired).
      const h = params.targetHeight;
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 10000000) {
        return { error: 'block-height trigger targetHeight must be an integer block height from 1 to 10,000,000' };
      }
      return { trigger: { type: 'blockheight', params: { targetHeight: h } } };
    }
    case 'setdate': {
      // (0.8.1) Fire at a date/time, regardless of check-ins (a
      // pure deadline — the "fire unless I check in" snooze variant
      // is a later addition). Stored normalized as an ISO string.
      const raw = typeof params.fireAt === 'string' ? params.fireAt.trim() : '';
      const ms = raw ? Date.parse(raw) : NaN;
      if (!raw || !Number.isFinite(ms)) return { error: 'set-date trigger fireAt must be a valid date/time' };
      return { trigger: { type: 'setdate', params: { fireAt: new Date(ms).toISOString() } } };
    }
    case 'feemarket': {
      // (0.8.1) Fire when the economy fee rate crosses a threshold
      // the owner sets (sat/vB), in the direction they choose:
      // 'below' fires when the fee falls to or below it (cheap
      // fees — the original rule), 'above' fires when the fee
      // rises to or above it (expensive fees). The threshold is
      // user-set (not per-tx) — the tx's own fee rate is not
      // consulted; the rule fires on the market rate alone.
      // Direction defaults to 'below' so existing rules keep
      // their meaning.
      const r = params.maxFeeRate;
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0.1 || r > 10000) {
        return { error: 'fee-market trigger maxFeeRate must be a number of sat/vB from 0.1 to 10,000' };
      }
      const dir = params.direction === undefined || params.direction === null ? 'below' : params.direction;
      if (dir !== 'below' && dir !== 'above') {
        return { error: 'fee-market trigger direction must be "below" or "above"' };
      }
      return { trigger: { type: 'feemarket', params: { maxFeeRate: r, direction: dir } } };
    }
    default:
      return { error: 'unknown trigger type: ' + String(input.type) };
  }
}

// Validate + normalize a rule SET (from a client, a backup, or a
// stored state file). Accepts EITHER a single rule (normalized and
// wrapped as a one-rule OR set) or a set { op: 'AND' | 'OR', rules:
// [...] } — so the add / import / edit / check endpoints take both
// shapes. Returns { trigger: set } (normalized) or { error: '...' }
// — never throws. A set needs 1..MAX_RULES_PER_TX rules, each valid
// on its own; one bad rule rejects the whole set.
function normalizeTrigger(input) {
  if (input === undefined || input === null) return { error: 'trigger is required' };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'trigger must be an object with a type, or a rule set { op, rules }' };
  if (Array.isArray(input.rules)) {
    if (input.op !== 'AND' && input.op !== 'OR') return { error: "rule set op must be 'AND' or 'OR'" };
    if (input.rules.length < 1) return { error: 'rule set needs at least one rule' };
    if (input.rules.length > MAX_RULES_PER_TX) return { error: 'a transaction can have at most ' + MAX_RULES_PER_TX + ' rules' };
    const rules = [];
    for (let i = 0; i < input.rules.length; i++) {
      const r = normalizeRule(input.rules[i]);
      if (!r.trigger) return { error: 'rule ' + (i + 1) + ': ' + r.error };
      rules.push(r.trigger);
    }
    return { trigger: { op: input.op, rules } };
  }
  const r = normalizeRule(input);
  if (!r.trigger) return r;
  return { trigger: { op: 'OR', rules: [r.trigger] } };
}

// The tx's rule set, normalized — a missing or unusable trigger
// defaults to the one-rule check-in set at the 35-day fallback, so
// the release never loses a transaction to a trigger it cannot
// read. (The frontend mirrors this rule in public/app.js.)
function triggerOf(tx) {
  if (!tx || typeof tx !== 'object') return defaultTriggerSet();
  const r = normalizeTrigger(tx.trigger);
  return r.trigger || defaultTriggerSet();
}

// The set's rules, normalized (the same fallback as triggerOf).
function triggerRulesOf(tx) {
  return triggerOf(tx).rules;
}

// The set's rule types, in rule order (duplicates kept — a set can
// hold two check-in rules at different thresholds).
function triggerTypesOf(tx) {
  return triggerRulesOf(tx).map((r) => r.type);
}

// True when the tx's set holds at least one rule of this type.
function hasTriggerType(tx, type) {
  return triggerRulesOf(tx).some((r) => r.type === type);
}

// The rule set as the API serves it (0.8.2, interim dual-shape
// serving): a one-rule set is served as its single rule (the legacy
// shape — the 0.8.1 frontend and the 098 suites only ever see that
// for one-rule txs); a multi-rule set is served as the set. The
// stored form is always the set. Remove this when the UI build lands
// (the new frontend normalizes both shapes on read).
function serveTrigger(set) {
  if (!set || typeof set !== 'object' || !Array.isArray(set.rules)) return defaultTrigger();
  if (set.rules.length === 1) return set.rules[0];
  return set;
}

// The per-rule triggerState as the API serves it (same interim rule
// as serveTrigger): a one-rule set's state is served as its single
// slice (the legacy flat shape); a multi-rule set's as the array.
// `state` is the stored triggerState (null, a flat legacy object, or
// the per-rule array). A flat object serves as-is (a legacy state
// file the migration has not wrapped yet — defensive only, loadState
// wraps it on every load).
function serveTriggerState(set, state) {
  if (state === null || state === undefined) return null;
  if (!Array.isArray(state)) return state;
  if (!set || !Array.isArray(set.rules) || set.rules.length !== 1) return state;
  return (state.length ? state[0] : null);
}

// Normalize a stored triggerState to the per-rule array form —
// null stays null, a flat legacy object wraps to a one-element
// array, an array is sanitized entry by entry (an object stays,
// anything else becomes null) and sized to the rule count (padded
// with nulls, truncated past it). Used by loadState's migration and
// by restore, so a hand-edited state file or backup can never store
// a triggerState the evaluators cannot index by rule.
function normalizeTriggerState(input, ruleCount) {
  const n = (typeof ruleCount === 'number' && Number.isFinite(ruleCount) && ruleCount >= 1) ? Math.floor(ruleCount) : 1;
  if (input === null || input === undefined) return null;
  let arr;
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'object') arr = [input];
  else return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = arr[i];
    out.push((e && typeof e === 'object' && !Array.isArray(e)) ? e : null);
  }
  return out;
}

// Deep-merge saved state over defaults so older state files keep working
// when new fields are added.
function mergeDefaults(def, saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return saved === undefined ? def : saved;
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return saved;
  const out = {};
  for (const k of Object.keys(def)) out[k] = mergeDefaults(def[k], saved[k]);
  for (const k of Object.keys(saved)) if (!(k in out)) out[k] = saved[k];
  return out;
}

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// State backups (0.8.3). The Nov 19 key incident: the live app's
// checkinKeys vanished (cause undetermined — the 0.8.1 update or a
// Settings deletion) and there was NO backup file anywhere in
// /data to recover from, and no log line saying when it happened.
// Three files, all plain copies of state.json, in DATA_DIR:
//   state.json.bak — the previous version, rotated on every save.
//     Protects against a bad in-memory state being saved.
//   state.json.bak.YYYY-MM-DD — a daily snapshot, written on the
//     first save of a new day, last 7 days kept. This is the piece
//     that protects against a SLOW wipe like the key loss: a key
//     present yesterday is still in yesterday's snapshot even
//     though every save since the wipe is keyless. A rotation of
//     only the last few saves would NOT cover that case.
//   state.json.pre-migration — written before any migration
//     changes the state shape (see loadState below).
// Backups are never written by hand anywhere else; saveState is
// the single funnel, so rotation cannot be skipped by a caller.
// ---------------------------------------------------------------------------
const BACKUP_FILE = 'state.json.bak';
const PRE_MIGRATION_FILE = 'state.json.pre-migration';
const DAILY_BACKUP_PREFIX = 'state.json.bak.';
const DAILY_BACKUP_KEEP = 7;
const DAILY_BACKUP_RE = /^state\.json\.bak\.(\d{4}-\d{2}-\d{2})$/;
// Preserved corrupt files are named state.json.corrupt.<ISO stamp>
// (see recoverStateFromBackup below).
const CORRUPT_FILE_PREFIX = 'state.json.corrupt.';

// Warnings recorded by the persistence layer (0.8.3) — a state
// recovery, for now. Kept in memory for the life of the process
// and served on GET /api/state so the UI can show them (a later
// increment). Cleared only when the state they describe is
// replaced wholesale (a restore or a reset) — a recovery is
// otherwise a fact about this run.
const stateWarnings = [];
function addStateWarning(code, message) {
  if (stateWarnings.some((w) => w.code === code)) return;
  stateWarnings.push({ code, message, at: new Date().toISOString() });
}
function getStateWarnings() {
  return stateWarnings.slice();
}
function clearStateWarnings() {
  stateWarnings.length = 0;
}

// Delete the state file and every local backup (0.8.3, reset):
// the previous version, the daily snapshots, the pre-migration
// snapshot, and any preserved corrupt files. Missing files are
// fine — a reset from the missing-state failure has nothing to
// delete. Returns the number of files removed.
function resetStateFiles(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (name === STATE_FILE || name === BACKUP_FILE || name === PRE_MIGRATION_FILE
        || name.startsWith(DAILY_BACKUP_PREFIX) || name.startsWith(CORRUPT_FILE_PREFIX)) {
      try { fs.unlinkSync(path.join(dataDir, name)); removed++; } catch { /* already gone */ }
    }
  }
  return removed;
}

// Today's UTC date (YYYY-MM-DD) — the same clock the rest of the
// app uses (ISO strings are UTC everywhere).
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// The daily snapshots on disk, newest first.
function listDailyBackups(dataDir) {
  let out = [];
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return out; }
  for (const name of names) {
    const m = DAILY_BACKUP_RE.exec(name);
    if (m) out.push({ file: name, date: m[1] });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out.reverse();
}

function pruneDailyBackups(dataDir) {
  const dailies = listDailyBackups(dataDir);
  for (const old of dailies.slice(DAILY_BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(dataDir, old.file)); } catch { /* already gone */ }
  }
}

// Rotate the backups BEFORE the new state is written, while the
// current state.json is still the previous version. Called by
// saveState only. Failures are logged, never thrown — a backup
// that cannot be written must not take down the save itself.
function rotateStateBackups(dataDir) {
  const file = path.join(dataDir, STATE_FILE);
  if (!fs.existsSync(file)) return; // first save ever — nothing to back up
  try {
    fs.copyFileSync(file, path.join(dataDir, BACKUP_FILE));
  } catch (e) { console.error('Standby: state backup rotation failed:', e.message); }
  try {
    const daily = path.join(dataDir, DAILY_BACKUP_PREFIX + todayStamp());
    if (!fs.existsSync(daily)) {
      fs.copyFileSync(file, daily);
      pruneDailyBackups(dataDir);
    }
  } catch (e) { console.error('Standby: daily state snapshot failed:', e.message); }
}

// Snapshot the current state file before a migration rewrites it
// (called by loadState's migration branch). A plain copy — the
// migration can then be undone by hand if it ever goes wrong.
function snapshotPreMigration(dataDir) {
  const file = path.join(dataDir, STATE_FILE);
  if (!fs.existsSync(file)) return;
  try {
    fs.copyFileSync(file, path.join(dataDir, PRE_MIGRATION_FILE));
  } catch (e) { console.error('Standby: pre-migration state snapshot failed:', e.message); }
}

// Is this parsed document plausibly a Standby state file? Every
// state file the app has written since 0.4.0 carries a numeric
// version and a bitcoin object with a txs list (older ones carry
// the single-tx shape the migration still understands). A
// document that parses but fails this check is treated as corrupt
// — mergeDefaults would otherwise fill a `{}` up to a
// near-empty state and the transactions would be silently lost.
function isPlausibleState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (typeof parsed.version !== 'number') return false;
  if (!parsed.bitcoin || typeof parsed.bitcoin !== 'object' || Array.isArray(parsed.bitcoin)) return false;
  return Array.isArray(parsed.bitcoin.txs)
    || (parsed.bitcoin.tx && typeof parsed.bitcoin.tx === 'object');
}

// Backup candidates for recovery, in the order to try them: the
// previous version first, then the daily snapshots newest first.
function backupCandidates(dataDir) {
  const out = [];
  if (fs.existsSync(path.join(dataDir, BACKUP_FILE))) out.push(BACKUP_FILE);
  for (const d of listDailyBackups(dataDir)) out.push(d.file);
  return out;
}

// Try each backup candidate in order; return { parsed, file } for
// the first one that parses and looks like a Standby state, or
// null. A backup that cannot be read or parsed is skipped, never
// an error.
function tryBackupCandidates(dataDir, candidates) {
  for (const cand of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dataDir, cand), 'utf8'));
      if (!isPlausibleState(parsed)) continue;
    } catch { continue; }
    return { parsed, file: cand };
  }
  return null;
}

// Try to recover a corrupt state file from the backups. Returns
// the parsed backup document. On success the corrupt file is
// preserved (renamed, never deleted) and the recovered state is
// written back to state.json — otherwise the next loadState would
// find no state file at all and create a fresh default, which is
// exactly the silent reset this must never do. On failure it
// throws loudly; the caller must NOT fall back to defaults.
function recoverStateFromBackup(dataDir, file, err) {
  const candidates = backupCandidates(dataDir);
  const found = tryBackupCandidates(dataDir, candidates);
  if (found) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preserved = file + '.corrupt.' + stamp;
    try { fs.renameSync(file, preserved); }
    catch (e) { console.error('Standby: could not preserve corrupt state file:', e.message); }
    const msg = 'Standby: state.json was corrupt (' + err.message + '); recovered from ' + found.file
      + ' — the corrupt file was preserved as ' + path.basename(preserved);
    console.warn(msg);
    addStateWarning('state-recovered', msg);
    // The state file is gone (renamed above), so this save skips
    // rotation — there is no previous version left to rotate.
    saveState(dataDir, found.parsed);
    return found.parsed;
  }
  throw new Error('Standby: state.json is corrupt (' + err.message + ') and no usable backup was found'
    + ' (' + candidates.length + ' backup(s) tried: ' + (candidates.join(', ') || 'none') + ').'
    + ' The corrupt file was left in place — restore a backup manually; the state was NOT reset to defaults.');
}

// A missing state.json with backups on disk is a lost state file,
// not a fresh install: recover from the newest usable backup
// (previous version, then daily snapshots newest first), exactly
// like the corrupt-state path. Returns the recovered document, or
// null when there are no backups at all (a genuine first boot).
// When backups exist but none loads, throws loudly — the state is
// NEVER silently reset while historical data exists.
function recoverMissingState(dataDir) {
  const candidates = backupCandidates(dataDir);
  if (candidates.length === 0) return null;
  const found = tryBackupCandidates(dataDir, candidates);
  if (found) {
    const msg = 'Standby: state.json was missing; recovered from ' + found.file;
    console.warn(msg);
    addStateWarning('state-missing-recovered', msg);
    // The state file is missing, so this save skips rotation —
    // there is no previous version left to rotate.
    saveState(dataDir, found.parsed);
    return found.parsed;
  }
  throw new Error('Standby: state.json is missing and no usable backup was found'
    + ' (' + candidates.length + ' backup(s) tried: ' + candidates.join(', ') + ').'
    + ' No state file was created — restore a backup manually; the state was NOT reset to defaults.');
}

// Find the newest backup that still holds check-in keys (0.8.3,
// for the startup key-store check in server.js): daily snapshots
// newest first, then the previous version. Returns
// { file, count } or null. A backup that cannot be read or parsed
// simply does not count — it is skipped, never an error.
function findBackupWithKeys(dataDir) {
  const candidates = listDailyBackups(dataDir).map((d) => d.file);
  candidates.push(BACKUP_FILE);
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, cand), 'utf8'));
      if (!isPlausibleState(parsed)) continue;
      const keys = Array.isArray(parsed.checkinKeys) ? parsed.checkinKeys : [];
      if (keys.length > 0) return { file: cand, count: keys.length };
    } catch { continue; }
  }
  return null;
}

function loadState(dataDir) {
  ensureDir(dataDir);
  const file = path.join(dataDir, STATE_FILE);
  let saved;
  if (!fs.existsSync(file)) {
    // (0.8.3, finding 1) A missing state file is NOT a fresh
    // install when backups exist — recover from the newest usable
    // backup, exactly like the corrupt-state path. Only a data
    // directory with no backups at all is a genuine first boot.
    // recoverMissingState throws loudly when backups exist but
    // none loads, and returns null when there are none.
    const recovered = recoverMissingState(dataDir);
    if (recovered) {
      saved = recovered;
    } else {
      const state = defaultState();
      saveState(dataDir, state);
      return state;
    }
  } else {
    // (0.8.3) A state file that cannot be read no longer crashes
    // the app on startup with no fallback: recover from the newest
    // usable backup (previous version, then daily snapshots newest
    // first). A file that parses but is not a Standby state document
    // is treated the same way. If no backup loads, this throws
    // loudly — the state is NEVER silently reset to defaults.
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isPlausibleState(saved)) {
        throw new Error('state.json parsed but is not a Standby state document');
      }
    } catch (e) {
      saved = recoverStateFromBackup(dataDir, file, e);
    }
  }
  const state = mergeDefaults(defaultState(), saved);
  // (0.8.0) The `paused` setting is gone — Global Arm/Disarm
  // replaces it. Prune it from older state files so a stale
  // `paused: true` can never resurface through /api/state.
  if (state.settings && typeof state.settings === 'object' && 'paused' in state.settings) {
    delete state.settings.paused;
  }
  // (0.8.0) A legacy vacationUntil of '' means indefinite now —
  // normalize it to null so every reader sees one shape.
  if (state.settings && typeof state.settings === 'object' && state.settings.vacationUntil === '') {
    state.settings.vacationUntil = null;
  }
  // 0.3.0 migration: the message release is gone. Prune everything it
  // left behind — including any stored Part 2 ciphertext — so no message
  // data lingers unread in state.json. Old delivery.jsonl stays on disk
  // (audit history) but is no longer read.
  let pruned = false;
  for (const k of ['recipient', 'channels', 'reminders']) {
    if (k in state) { delete state[k]; pruned = true; }
  }
  if (state.release && typeof state.release === 'object' && !('status' in state.release)) {
    state.release = null;
    pruned = true;
  }
  // 0.4.0 migration: one transaction became a list. A stored single tx
  // (0.3.x shape: bitcoin.tx + bitcoin.enabled + top-level release)
  // becomes txs[0] with its own enable and its own release record.
  let migrated = false;
  if (state.bitcoin && state.bitcoin.tx && typeof state.bitcoin.tx === 'object') {
    const old = state.bitcoin.tx;
    const oldRelease = (state.release && typeof state.release === 'object' && state.release.txid === old.txid) ? state.release : null;
    state.bitcoin.txs = [{
      id: newTxId(),
      txid: old.txid,
      hex: old.hex,
      label: old.label || '',
      notes: '',
      createdAt: old.createdAt || state.updatedAt,
      inputs: old.inputs || 0,
      outputs: old.outputs || 0,
      totalOutSats: old.totalOutSats || '0',
      locktime: old.locktime || 0,
      segwit: !!old.segwit,
      enabled: !!state.bitcoin.enabled,
      release: oldRelease,
    }];
    delete state.bitcoin.tx;
    delete state.bitcoin.enabled;
    migrated = true;
  }
  if ('release' in state) { delete state.release; pruned = true; }
  // 0.8.0 migration: the global broadcast threshold is gone —
  // each check-in tx carries its own threshold now. Prune it
  // from settings so a state file written before 0.8.0 does not
  // keep serving it (a backup from before 0.8.0 restores the
  // same way — the restore builds settings fresh, without it).
  if (state.settings && 'thresholdDays' in state.settings) { delete state.settings.thresholdDays; pruned = true; }
  // 0.5.2 migration: the ladder is one number now. Prune the check-in
  // interval, both warning levels, and the grace period from settings —
  // the status is on-track until the broadcast threshold, then
  // release-due. Dropping the grace period moves the release 5 days
  // earlier for a cycle already in progress.
  for (const k of ['checkinIntervalDays', 'warn1Days', 'warn2Days', 'graceDays']) {
    if (state.settings && k in state.settings) { delete state.settings[k]; pruned = true; }
  }
  // 0.5.4 migration: the RPC path is gone — no broadcast method, no RPC
  // config, and the stored RPC password along with it. The two mempool
  // endpoints replace them. A custom public endpoint from 0.5.3 carries
  // over as the primary (an own-mempool-on-the-LAN install keeps it);
  // the default mempool.space just becomes the new default.
  if (state.settings && typeof state.settings.publicApiUrl === 'string'
      && state.settings.publicApiUrl && state.settings.publicApiUrl !== 'https://mempool.space') {
    state.settings.primaryApiUrl = state.settings.publicApiUrl;
  }
  for (const k of ['broadcastMethod', 'publicApiUrl', 'rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword']) {
    if (state.settings && k in state.settings) { delete state.settings[k]; pruned = true; }
  }
  if (state.version !== 7) state.version = 7;
  // 0.8.0 migration: every transaction carries its own trigger
  // and triggerState. A tx from before 0.8.0 carries neither: it
  // defaults to the check-in trigger at the 35-day fallback (so
  // existing behaviour is unchanged) and a null triggerState
  // ("not evaluated yet"). A trigger with an unknown type falls
  // back the same way — the release must never lose a transaction
  // to a trigger it cannot read. The migration is idempotent and
  // runs on every load (cheap), so a hand-edited state file is
  // normalized too.
  // 0.8.2 migration: the trigger is a RULE SET now, and the
  // triggerState is per-rule (an array parallel to the rules).
  // A single trigger wraps as a one-rule OR set; a flat
  // triggerState wraps as a one-element array (the seeded slice
  // keeps its fields — a price rule's lastPrice, a block-height
  // rule's latch — so the evaluators keep their baselines). A
  // triggerState that is not null, not an object, and not an array
  // is dropped (the evaluator overwrites it on the next evaluation
  // anyway).
  let triggerMigrated = false;
  for (const t of (state.bitcoin.txs || [])) {
    const trg = triggerOf(t);
    if (JSON.stringify(trg) !== JSON.stringify(t.trigger)) { t.trigger = trg; triggerMigrated = true; }
    const normState = normalizeTriggerState(t.triggerState, trg.rules.length);
    if (JSON.stringify(normState) !== JSON.stringify(t.triggerState)) {
      t.triggerState = normState; triggerMigrated = true;
    }
  }
  // 0.8.2 migration: every transaction carries its own event
  // history — [{ ts, type, detail }], oldest first (see
  // server.js pushHistory). A tx from before 0.8.2 carries none:
  // seed it from the facts the state already holds — added at
  // createdAt; broadcast / confirmed from the broadcasted fact;
  // stale from a stale release record — so an old card's history
  // starts true instead of empty. A present but malformed history
  // (a hand-edited state file) is sanitized the same way the
  // restore validates one: unknown types and unparseable entries
  // dropped, capped at HISTORY_MAX. Idempotent — runs on every
  // load, and a seeded history is never re-seeded.
  let historySeeded = false;
  for (const t of (state.bitcoin.txs || [])) {
    if (!Array.isArray(t.history)) {
      const seeded = [{ ts: (typeof t.createdAt === 'string' && t.createdAt) ? t.createdAt : state.updatedAt, type: 'added', detail: '' }];
      const b = (t.broadcasted && typeof t.broadcasted === 'object') ? t.broadcasted : null;
      if (b && typeof b.broadcastedAt === 'string' && b.broadcastedAt) {
        const btx = String(b.txid || t.txid || '');
        seeded.push({ ts: b.broadcastedAt, type: 'broadcast', detail: 'txid ' + btx.slice(0, 8) + '…' + btx.slice(-4) });
      }
      if (b && ((typeof b.confirmations === 'number' && b.confirmations >= 1) || (typeof b.blockHeight === 'number'))) {
        seeded.push({ ts: (typeof b.checkedAt === 'string' && b.checkedAt) ? b.checkedAt : b.broadcastedAt, type: 'confirmed', detail: (typeof b.blockHeight === 'number') ? 'Block ' + b.blockHeight.toLocaleString('en-US') : 'Confirmed' });
      }
      if (t.release && t.release.status === 'stale') {
        seeded.push({ ts: (typeof t.release.lastAttemptAt === 'string' && t.release.lastAttemptAt) ? t.release.lastAttemptAt : seeded[0].ts, type: 'stale', detail: (typeof t.release.error === 'string' ? t.release.error : '') });
      }
      seeded.sort((a, b2) => new Date(a.ts).getTime() - new Date(b2.ts).getTime());
      t.history = seeded.slice(-HISTORY_MAX);
      historySeeded = true;
    } else {
      const clean = t.history.filter((e) => e && typeof e === 'object' && HISTORY_TYPES.has(e.type)
        && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
        && typeof e.detail === 'string').slice(-HISTORY_MAX);
      if (clean.length !== t.history.length) { t.history = clean; historySeeded = true; }
    }
  }
  // 0.8.7 sanitizer: trigger sets. A state file from before 0.8.7
  // carries no sets (mergeDefaults filled []); a hand-edited one
  // is normalized the same way the tx migration normalizes txs —
  // dropped when it has no id or a duplicate id, its member list
  // pruned to stored txs (dangling ids go), its trigger and
  // triggerState normalized to the rule count, its history seeded
  // from the facts it holds (added at createdAt) or sanitized
  // like a tx's. A tx in two sets keeps only the first — a tx
  // belongs to at most one set. Idempotent, runs on every load.
  let setsNormalized = false;
  if (!Array.isArray(state.bitcoin.sets)) { state.bitcoin.sets = []; setsNormalized = true; }
  {
    const txIds = new Set((state.bitcoin.txs || []).map((t) => t.id));
    const seenSetIds = new Set();
    const seenMemberIds = new Set();
    const kept = [];
    for (const s of state.bitcoin.sets) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || seenSetIds.has(s.id)) { setsNormalized = true; continue; }
      seenSetIds.add(s.id);
      if (!Array.isArray(s.txIds)) { s.txIds = []; setsNormalized = true; }
      const before = s.txIds.length;
      s.txIds = [...new Set(s.txIds.filter((id) => typeof id === 'string' && txIds.has(id) && !seenMemberIds.has(id)))];
      for (const id of s.txIds) seenMemberIds.add(id);
      if (s.txIds.length !== before) setsNormalized = true;
      if (typeof s.label !== 'string') { s.label = ''; setsNormalized = true; }
      if (typeof s.enabled !== 'boolean') { s.enabled = true; setsNormalized = true; }
      if (typeof s.createdAt !== 'string' || !s.createdAt) { s.createdAt = state.updatedAt; setsNormalized = true; }
      const strg = triggerOf(s);
      if (JSON.stringify(strg) !== JSON.stringify(s.trigger)) { s.trigger = strg; setsNormalized = true; }
      const normSetState = normalizeTriggerState(s.triggerState, strg.rules.length);
      if (JSON.stringify(normSetState) !== JSON.stringify(s.triggerState)) { s.triggerState = normSetState; setsNormalized = true; }
      if (typeof s.checkinOffsetMs !== 'number' || !Number.isFinite(s.checkinOffsetMs) || s.checkinOffsetMs < 0) { s.checkinOffsetMs = 0; setsNormalized = true; }
      if (typeof s.checkinInactiveSince !== 'string' || !s.checkinInactiveSince) {
        if (s.checkinInactiveSince !== null && s.checkinInactiveSince !== undefined) setsNormalized = true;
        s.checkinInactiveSince = null;
      }
      if (!Array.isArray(s.history)) {
        s.history = [{ ts: s.createdAt, type: 'added', detail: 'Set created with ' + s.txIds.length + (s.txIds.length === 1 ? ' transaction' : ' transactions') }];
        setsNormalized = true;
      } else {
        const clean = s.history.filter((e) => e && typeof e === 'object' && HISTORY_TYPES.has(e.type)
          && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
          && typeof e.detail === 'string').slice(-HISTORY_MAX);
        if (clean.length !== s.history.length) { s.history = clean; setsNormalized = true; }
      }
      // (0.8.7, round 9) A set created before the single-history
      // change carries only its own creation event — its members'
      // earlier histories are backfilled now, so an old set's
      // trail starts true instead of thin. Idempotent: events
      // already on the trail are skipped, so a later load changes
      // nothing and this runs exactly once per set.
      const histBefore = s.history.length;
      backfillSetHistory(s, (state.bitcoin.txs || []).filter((t) => (s.txIds || []).includes(t.id)));
      if (s.history.length !== histBefore) setsNormalized = true;
      kept.push(s);
    }
    if (kept.length !== state.bitcoin.sets.length) setsNormalized = true;
    state.bitcoin.sets = kept;
  }
  if (pruned || migrated || triggerMigrated || historySeeded || setsNormalized) {
    if (migrated) console.log('Standby 0.4.0: migrated single transaction to the transactions list');
    if (pruned) console.log('Standby: pruned legacy state (recipient/channels/reminders/release)');
    if (triggerMigrated) console.log('Standby 0.8.2: migrated transactions to rule sets (AND/OR) with per-rule triggerState');
    if (historySeeded) console.log('Standby 0.8.1: seeded per-transaction history');
    if (setsNormalized) console.log('Standby 0.8.7: normalized trigger sets');
    // (0.8.3) Snapshot the pre-migration file before the
    // migrating save rewrites it.
    snapshotPreMigration(dataDir);
    saveState(dataDir, state);
  }
  return state;
}

function saveState(dataDir, state) {
  ensureDir(dataDir);
  state.updatedAt = new Date().toISOString();
  // (0.8.3) Rotate the backups while the current state.json is
  // still the previous version — see rotateStateBackups above.
  rotateStateBackups(dataDir);
  const file = path.join(dataDir, STATE_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return state;
}

function appendJsonl(dataDir, file, entry) {
  ensureDir(dataDir);
  fs.appendFileSync(path.join(dataDir, file), JSON.stringify(entry) + '\n', 'utf8');
}

function readJsonl(dataDir, file, limit) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return limit ? entries.slice(-limit) : entries;
}

function appendCheckin(dataDir, entry) { appendJsonl(dataDir, CHECKIN_LOG, entry); }
function readCheckins(dataDir, limit) { return readJsonl(dataDir, CHECKIN_LOG, limit); }
function writeCheckins(dataDir, entries) { writeJsonl(dataDir, CHECKIN_LOG, entries); }
function appendBroadcastLog(dataDir, entry) { appendJsonl(dataDir, BROADCAST_LOG, entry); }
function readBroadcastLog(dataDir, limit) { return readJsonl(dataDir, BROADCAST_LOG, limit); }
function writeBroadcastLog(dataDir, entries) { writeJsonl(dataDir, BROADCAST_LOG, entries); }

// Overwrite a JSONL audit log with an array of entries (used by
// restore, which replaces the logs with the backup's copies). An empty
// array clears the file.
function writeJsonl(dataDir, file, entries) {
  ensureDir(dataDir);
  const lines = (entries || []).map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dataDir, file), lines ? lines + '\n' : '', 'utf8');
}

module.exports = {
  loadState, saveState, defaultState, newTxId, newSetId,
  appendCheckin, readCheckins, writeCheckins,
  appendBroadcastLog, readBroadcastLog, writeBroadcastLog,
  normalizeTrigger, normalizeRule, triggerOf, triggerRulesOf, triggerTypesOf, hasTriggerType,
  serveTrigger, serveTriggerState, normalizeTriggerState, defaultTrigger, defaultTriggerSet,
  FALLBACK_THRESHOLD_DAYS, MAX_RULES_PER_TX,
  TRIGGER_TYPES, PRICE_MIN_USD, PRICE_MAX_USD, HISTORY_TYPES, HISTORY_MAX,
  memberHistoryDetail, backfillSetHistory,
  // (0.8.3) Persistence hardening: backup rotation, corrupt-state
  // recovery warnings, and the backup-with-keys lookup for the
  // startup key-store check.
  getStateWarnings, clearStateWarnings, resetStateFiles, findBackupWithKeys,
  BACKUP_FILE, PRE_MIGRATION_FILE, DAILY_BACKUP_PREFIX, DAILY_BACKUP_KEEP,
};
