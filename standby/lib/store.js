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
// The heartbeat file: the live "I was online"
// stamp, kept out of state.json so the every-minute tick does not
// have to rewrite the whole state to record it. A few bytes,
// tmp+rename for atomicity, NO backup rotation.
const HEARTBEAT_FILE = 'heartbeat.json';
// Throttle: at most one heartbeat write per 5 minutes per data
// dir. Grace thresholds are 7 days flat / T/4 with a 6-hour
// minimum, so 5 minutes of staleness costs nothing.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 7,
    createdAt: now,
    updatedAt: now,
    settings: {
      primaryApiUrl: 'https://mempool.space', // the primary node: a mempool API endpoint (any mempool.space-compatible instance — another public one, or your own mempool on the LAN)
      secondaryApiUrl: 'https://blockstream.info/api', // the secondary node, tried only if the primary does not answer; blank = primary runs alone
      secondaryEnabled: true, // the secondary node is on by default — off means primary only, no fallback anywhere (see endpointsFor in lib/bitcoin.js); a missing flag in old state means enabled
      priceSources: { source1: 'coingecko', source2: 'coinbase' }, // the two BTC price feeds for price rules — each a provider id (see PRICE_PROVIDERS in lib/bitcoin.js) or a custom { id: 'custom', url, path } object; a reading is only trusted when the two agree within the configured agreement (Settings: Price agreement), and when they agree the primary source's price is the one that decides
      // Price agreement: the two BTC price sources must
      // agree within this % for a reading to count (Settings:
      // Price agreement; 1–20, default 5). Tighter is safer but
      // the rule waits ("unknown") more during fast moves; looser
      // fires more readily.
      priceAgreementPct: 5,
      // Check cadence: how often the fast tick evaluates
      // price + UTXO triggers, in seconds (Settings: Check
      // cadence; 10–3600, default 60). Faster catches an
      // unconfirmed spend and brief price spikes sooner; slower
      // means fewer API calls.
      checkCadenceSeconds: 60,
      // Fee verdict thresholds as multiples of the 90-day peak: Low (1–10,
      // default 2) must stay above Medium (0.5–5, default 1). Critical
      // (below the current economy fee) is separate.
      feeLowMultiplier: 2, feeMediumMultiplier: 1,
      // Grace period: back online after more than graceOfflineDays, every
      // trigger type is paused for graceDurationDays (null = until
      // resumed), so nothing fires on conditions that changed while away.
      // Check-in rules are held the same way; their due date is not pushed
      // out. graceEnabled false means no grace at all. A stored duration
      // of 0 (the old off switch) still reads as off.
      graceEnabled: true,
      graceOfflineDays: 7, graceDurationDays: 7,
      // Vacation: the check-in countdown freezes (check-in rules only).
      // vacationUntil is the last day away ('YYYY-MM-DD'); null means
      // until the owner returns; a legacy '' loads as null.
      vacationMode: false,
      vacationUntil: null,
    },
    // Transactions: a list, each with its own arm and release record. Only
    // signed hex is stored; the server never sees keys.
    // tx = { id, txid, hex, label, notes, createdAt, inputs, outputs,
    // totalOutSats, feeSats, feeRateSatVb, locktime, segwit, enabled,
    // broadcastVia, trigger, triggerState, history, release, broadcasted }
    // - trigger: a rule set { op: 'AND' | 'OR', rules: [{ type, params }]
    //   }; triggerState: each rule's last evaluation slice, parallel to
    //   the rules (null until evaluated). A one-rule set is served as its
    //   single rule.
    // - history: transitions only, oldest first, capped at 50.
    // - release: this cycle's record (a check-in clears it); broadcasted:
    //   the permanent fact it went out (only replacing the hex clears it).
    // connection: the last node test; nodeCheckedAt: each endpoint's own
    // last answer (the secondary is only asked on fallback).
    // Trigger sets: { id, label, enabled, txIds, trigger, triggerState,
    // history, createdAt, checkinOffsetMs, checkinInactiveSince }. While
    // attached, the set's trigger is evaluated once per tick for all
    // members; a member keeps its own trigger for when it leaves. Deleting
    // a set never deletes its txs.
    bitcoin: { txs: [], sets: [], connection: { ok: null, checkedAt: null, detail: '', nodeCheckedAt: { primary: null, secondary: null } } },
    // The check-in clock. lastOnlineAt is the app's own liveness (written
    // by the tick), so a gap means the device was off. A stored heldUntil
    // becomes a grace on load if unexpired, else is dropped.
    checkin: { lastCheckinAt: null, totalCheckins: 0, lastOnlineAt: null },
    // Grace period state: nulls = no grace was ever set
    // (or it was resumed / expired). graceUntil null = an
    // indefinite grace, active until resumed. See server.js
    // graceStatus / applyGrace.
    grace: { graceUntil: null, triggeredAt: null, offlineGapDays: null },
    // Fee history: the hourly economy-fee observations
    // the peak is computed from — [{ t, fee }] — see
    // sanitizeFeeHistory above. Empty until the hourly tick
    // records the first observation; the peak is served only
    // once 24 observations (a day) have accumulated.
    feeHistory: [],
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

// Triggers: each tx has a rule set { op, rules }. Rule types:
// - checkin { thresholdDays }: release-due at its own threshold
// - price { asset: 'BTC', op: '>=' | '<=', value }: both price sources
//   agree past value
// - utxo { outpoint: 'txid:vout', condition: 'spent' }: spent by a
//   confirmed transaction
// - manual {}: never fires; broadcast by hand
// (plus blockheight, setdate and feemarket below). No trigger means a
// 35-day check-in rule. Values are bounded so a typo cannot become a rule.
// MAX_RULES_PER_TX caps a set's rules.
const TRIGGER_TYPES = ['checkin', 'price', 'utxo', 'manual', 'blockheight', 'setdate', 'feemarket'];
const MAX_RULES_PER_TX = 5;
// The per-transaction history event types — the only
// types a history entry may carry (see lib/history.js pushHistory and
// the load-time backfill below). 'slipstream' is the MARA
// submission; 'conflict' is the dry-run's unconfirmed-spend
// warning. Only transitions are recorded — never the hourly
// release checks.
const HISTORY_TYPES = new Set(['added', 'fired', 'broadcast', 'slipstream', 'confirmed', 'stale', 'failed', 'conflict', 'edited', 'armed', 'disarmed']);
const HISTORY_MAX = 50;

// Fee history: the peak comes from Standby's own hourly economy-fee
// readings { t, fee } (lib/release.js), one consistent day-scale measure
// whichever node answered. Kept in state.json, so it survives restarts and
// restores. Bounded by FEE_HISTORY_WINDOW_DAYS and
// FEE_HISTORY_MAX_ENTRIES; no peak before FEE_HISTORY_MIN_OBSERVATIONS
// readings span a full day.
const FEE_HISTORY_WINDOW_DAYS = 90;
const FEE_HISTORY_MIN_OBSERVATIONS = 24;
const FEE_HISTORY_MAX_ENTRIES = FEE_HISTORY_WINDOW_DAYS * 24;

// Canonical fee history: valid { t, fee } entries only (no future times),
// ascending, pruned and capped. Pure.
function sanitizeFeeHistory(raw, nowMs) {
  if (!Array.isArray(raw)) return [];
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const cutoff = now - FEE_HISTORY_WINDOW_DAYS * 86400000;
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const t = (typeof e.t === 'string' && e.t) ? new Date(e.t).getTime() : NaN;
    const fee = e.fee;
    if (!Number.isFinite(t) || t <= cutoff || t > now + 60000) continue;
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) continue;
    out.push({ t: new Date(t).toISOString(), fee });
  }
  out.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  return out.slice(-FEE_HISTORY_MAX_ENTRIES);
}
// How a tx is named in a set's history tags (mirrors txDisplayName in
// public/app.js): a member as '"<set label>" - Tx N', a standalone by its
// label, else its short txid.
function shortTxid16(txid) {
  const s = String(txid || '');
  return s ? s.slice(0, 16) + (s.length > 16 ? '…' : '') : '';
}
function memberTag(set, tx) {
  if (!tx) return 'Untitled transaction';
  if (set) {
    const idx = (set.txIds || []).indexOf(tx.id);
    if (idx !== -1) return '"' + (set.label || 'Untitled set') + '" - Tx ' + (idx + 1);
  }
  return tx.label || shortTxid16(tx.txid) || 'Untitled transaction';
}
function memberHistoryDetail(set, tx, detail) {
  const tag = memberTag(set, tx);
  return detail ? tag + ': ' + detail : tag;
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
      const tagged = { ts: e.ts, type: e.type, detail: memberHistoryDetail(set, t, e.detail) };
      const key = tagged.type + '|' + tagged.detail;
      // The tag format changed from the bare
      // member label to '"<set label>" - Tx N': an event already
      // on the trail under the OLD tag still counts as the same
      // event, so a load across the format change does not copy
      // it in a second time under the new tag.
      const legacy = (t.label || 'Untitled transaction');
      const legacyDetail = e.detail ? legacy + ': ' + e.detail : legacy;
      const legacyKey = e.type + '|' + legacyDetail;
      const n = remaining.get(key) || 0;
      if (n > 0) { remaining.set(key, n - 1); continue; }
      const ln = remaining.get(legacyKey) || 0;
      if (ln > 0) { remaining.set(legacyKey, ln - 1); continue; }
      incoming.push(tagged);
    }
  }
  if (!incoming.length) return;
  set.history = (set.history || []).concat(incoming)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-HISTORY_MAX);
}
// The check-in fallback: there is no global broadcast
// threshold — each check-in tx carries its own
// thresholdDays ("Days of silence"). A tx with no usable trigger
// defaults to check-in at 35 days, and a new check-in tx
// defaults to 35 days too.
const FALLBACK_THRESHOLD_DAYS = 35;

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
      return { trigger: { type: 'price', params: { asset: 'BTC', op: params.op, value: v } } };
    }
    case 'utxo': {
      const outpoint = typeof params.outpoint === 'string' ? params.outpoint.trim() : '';
      if (!/^[0-9a-fA-F]{64}:[0-9]+$/.test(outpoint)) return { error: "utxo trigger outpoint must be 'txid:vout' — a 64-hex transaction id, a colon, and an output index" };
      // How many confirmations the spending tx needs
      // before the rule fires: 0 = fire on an unconfirmed
      // (mempool) spend, N >= 1 = fire once the spend has N
      // confirmations. Omitted (older / migrated rules) means 1 —
      // confirmed-only — so those rules keep their meaning.
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
      // Fire when the chain tip reaches a height. The
      // height is a positive integer; a reorg cannot un-fire it
      // (once the tip has reached the height, the rule has fired).
      const h = params.targetHeight;
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 10000000) {
        return { error: 'block-height trigger targetHeight must be an integer block height from 1 to 10,000,000' };
      }
      return { trigger: { type: 'blockheight', params: { targetHeight: h } } };
    }
    case 'setdate': {
      // Fire at a date/time, regardless of check-ins (a
      // pure deadline — the "fire unless I check in" snooze variant
      // is a later addition). Stored normalized as an ISO string.
      const raw = typeof params.fireAt === 'string' ? params.fireAt.trim() : '';
      const ms = raw ? Date.parse(raw) : NaN;
      if (!raw || !Number.isFinite(ms)) return { error: 'set-date trigger fireAt must be a valid date/time' };
      return { trigger: { type: 'setdate', params: { fireAt: new Date(ms).toISOString() } } };
    }
    case 'feemarket': {
      // Fee-market rule: fires when the economy fee reaches the owner's
      // threshold (sat/vB), 'below' (cheap, the default) or 'above'. The
      // tx's own fee is not consulted.
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

// Validate a rule set from a client, backup or state file: a single rule
// becomes a one-rule OR set. Needs 1..MAX_RULES_PER_TX valid rules; one
// bad rule rejects the set. Returns { trigger } or { error }, never
// throws.
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

// The rule set as the API serves it (dual-shape serving): a
// one-rule set is served as its single rule (the single-rule shape
// clients and tests expect for one-rule txs); a multi-rule set is
// served as the set. The stored form is always the set. This can go
// once every client normalizes both shapes on read.
function serveTrigger(set) {
  if (!set || typeof set !== 'object' || !Array.isArray(set.rules)) return defaultTrigger();
  if (set.rules.length === 1) return set.rules[0];
  return set;
}

// triggerState as served: a one-rule set's single slice, a multi-rule
// set's array.
function serveTriggerState(set, state) {
  if (state === null || state === undefined) return null;
  if (!Array.isArray(state)) return state;
  if (!set || !Array.isArray(set.rules) || set.rules.length !== 1) return state;
  return (state.length ? state[0] : null);
}

// Normalize a stored triggerState to a per-rule array sized to the rule
// count (a flat legacy object wraps). Used on load and restore.
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

// The data directory holds bearer transactions, so it is 0700 and every
// file 0600. The check-in directory holds only key hashes and a timestamp
// and is shared with the receiver.
const DATA_DIR_MODE = 0o700;
const DATA_FILE_MODE = 0o600;

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
}

// Startup pass: tighten an existing data directory
// written by an older version (0755 / 0644). Best effort — a file
// this process does not own cannot be chmod-ed, and the startup
// writability check reports that separately. Subdirectories are
// left alone (on Umbrel the shared check-in directory lives in
// here). Returns the number of entries changed.
function secureDataDir(dataDir) {
  let changed = 0;
  try {
    const st = fs.statSync(dataDir);
    if ((st.mode & 0o777) !== DATA_DIR_MODE) { fs.chmodSync(dataDir, DATA_DIR_MODE); changed++; }
  } catch (e) { return changed; }
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch (e) { return changed; }
  for (const name of names) {
    const file = path.join(dataDir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      if ((st.mode & 0o777) !== DATA_FILE_MODE) { fs.chmodSync(file, DATA_FILE_MODE); changed++; }
    } catch (e) { /* not ours, or gone — skip */ }
  }
  return changed;
}

// State backups, all plain copies in DATA_DIR:
// - state.json.bak: the previous version, on every save
// - state.json.bak.YYYY-MM-DD: the first save of each day, 7 kept (this
//   covers a slow loss that later saves would overwrite)
// - state.json.pre-migration: before a migration
// saveState is the only writer, so rotation cannot be skipped.
const BACKUP_FILE = 'state.json.bak';
const PRE_MIGRATION_FILE = 'state.json.pre-migration';
const DAILY_BACKUP_PREFIX = 'state.json.bak.';
const DAILY_BACKUP_KEEP = 7;
const DAILY_BACKUP_RE = /^state\.json\.bak\.(\d{4}-\d{2}-\d{2})$/;
// Preserved corrupt files are named state.json.corrupt.<ISO stamp>
// (see recoverStateFromBackup below).
const CORRUPT_FILE_PREFIX = 'state.json.corrupt.';

// Warnings recorded by the persistence layer — a state
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

// Delete the state file and every local backup:
// the previous version, the daily snapshots, the pre-migration
// snapshot, and any preserved corrupt files. Missing files are
// fine — a reset from the missing-state failure has nothing to
// delete. Returns the number of files removed.
function resetStateFiles(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (name === STATE_FILE || name === BACKUP_FILE || name === PRE_MIGRATION_FILE || name === HEARTBEAT_FILE
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

// Plausibly a state file: a numeric version and bitcoin.txs (or the old
// single-tx shape). Anything else is corrupt, rather than filled up with
// defaults (which would silently lose the transactions).
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

// Recover a corrupt state file from the backups: keep the corrupt file
// (renamed) and write the recovered state back. Throws if nothing loads;
// never fall back to defaults.
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

// Missing state.json with backups present is a lost file, not a fresh
// install: recover from the newest usable backup. null when there are no
// backups; throws if none loads.
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

// Find the newest backup that still holds check-in keys (for the
// startup key-store check in lib/checkin.js): daily snapshots
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
    // A missing state file is NOT a fresh
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
    // A state file that cannot be read must not crash
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
  // The fee history is sanitized on load — a hand-edited
  // or older state file cannot smuggle a bad entry, a future
  // timestamp, or a series older than the window into the peak.
  // mergeDefaults already keeps a stored array; this pass drops
  // anything malformed and prunes past the 90-day window.
  state.feeHistory = sanitizeFeeHistory(state.feeHistory);
  // Merge the heartbeat on every load: lastOnlineAt is max(heartbeat,
  // state), ignoring and capping future stamps (a forward clock would
  // otherwise hide a real outage). Read-only: writing it back would defeat
  // the save dedupe; it rides along on the next real save.
  mergeHeartbeat(state, dataDir);
  // `paused` is not a setting — Global Arm/Disarm is the
  // control. Prune it from older state files so a stale
  // `paused: true` can never resurface through /api/state.
  if (state.settings && typeof state.settings === 'object' && 'paused' in state.settings) {
    delete state.settings.paused;
  }
  // A legacy vacationUntil of '' means indefinite now —
  // normalize it to null so every reader sees one shape.
  if (state.settings && typeof state.settings === 'object' && state.settings.vacationUntil === '') {
    state.settings.vacationUntil = null;
  }
  // Grace on/off toggle replaces the "No grace period"
  // duration: old state with graceDurationDays 0 and no
  // graceEnabled field loads as grace OFF, not on — the 0 meant
  // off, and the default (on) must not resurrect it. A saved
  // flag always wins; this only covers state written before
  // the toggle existed.
  if (state.settings && typeof state.settings === 'object'
    && saved && saved.settings && typeof saved.settings === 'object'
    && !('graceEnabled' in saved.settings) && saved.settings.graceDurationDays === 0) {
    state.settings.graceEnabled = false;
  }
  // An old heldUntil becomes an active grace ending then if unexpired
  // (dropping it could let a due check-in broadcast after an upgrade);
  // expired ones are dropped, and an active grace is never overwritten.
  if (state.checkin && typeof state.checkin === 'object' && 'heldUntil' in state.checkin) {
    const heldRaw = state.checkin.heldUntil;
    const heldMs = (typeof heldRaw === 'string' && heldRaw) ? new Date(heldRaw).getTime() : NaN;
    const nowMs = Date.now();
    const g = state.grace;
    const graceActive = g && typeof g === 'object' && g.triggeredAt
      && (!g.graceUntil || new Date(g.graceUntil).getTime() > nowMs);
    if (Number.isFinite(heldMs) && heldMs > nowMs && !graceActive) {
      const onlineRaw = state.checkin.lastOnlineAt;
      const onlineMs = (typeof onlineRaw === 'string' && onlineRaw) ? new Date(onlineRaw).getTime() : NaN;
      state.grace = {
        graceUntil: new Date(heldMs).toISOString(),
        triggeredAt: new Date(nowMs).toISOString(),
        offlineGapDays: Number.isFinite(onlineMs) ? Math.max(0, Math.floor((nowMs - onlineMs) / 86400000)) : null,
      };
    }
    delete state.checkin.heldUntil;
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
  // Every tx has a rule-set trigger and a per-rule triggerState. Missing
  // or unreadable triggers become a 35-day check-in rule (never lose a
  // transaction); a single trigger wraps as a one-rule OR set and a flat
  // triggerState as a one-element array, keeping its fields. Idempotent;
  // runs on every load.
  let triggerMigrated = false;
  for (const t of (state.bitcoin.txs || [])) {
    const trg = triggerOf(t);
    if (JSON.stringify(trg) !== JSON.stringify(t.trigger)) { t.trigger = trg; triggerMigrated = true; }
    const normState = normalizeTriggerState(t.triggerState, trg.rules.length);
    if (JSON.stringify(normState) !== JSON.stringify(t.triggerState)) {
      t.triggerState = normState; triggerMigrated = true;
    }
  }
  // Every tx has a history. A missing one is seeded from the facts in
  // state (added, broadcast, confirmed, stale); a malformed one is
  // sanitized like a restore. Idempotent.
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
  // Trigger sets, normalized on every load: drop entries without an id or
  // with a duplicate, prune members to stored txs (a tx belongs to at most
  // one set), normalize trigger and triggerState, seed or sanitize the
  // history.
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
      // A set created before the single-history
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
    // Snapshot the pre-migration file before the
    // migrating save rewrites it.
    snapshotPreMigration(dataDir);
    saveState(dataDir, state);
  }
  return state;
}

function saveState(dataDir, state) {
  ensureDir(dataDir);
  state.updatedAt = new Date().toISOString();
  // Write only when something meaningful changed. The comparison ignores
  // updatedAt, lastOnlineAt (the heartbeat merge moves it every load) and
  // the slices' evaluation timestamps (stamped every evaluation, never
  // shown); otherwise every tick would rewrite the file. A skipped save
  // writes nothing and rotates nothing, and still returns the state.
  // The cache is per process and file, and trusted only while the file's
  // mtime and size match what was last written: an outside write (hand
  // edit, restore, test seeding) would otherwise make a real change look
  // like a no-op.
  const comparable = comparableState(state);
  const file = path.join(dataDir, STATE_FILE);
  const last = lastWritten.get(file);
  if (last && last.comparable === comparable) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === last.mtimeMs && st.size === last.size) return state;
    } catch (e) { /* missing/unreadable: fall through and write */ }
  }
  // Rotate the backups while the current state.json is
  // still the previous version — see rotateStateBackups above.
  rotateStateBackups(dataDir);
  writeFileDurable(file, JSON.stringify(state, null, 2) + '\n', DATA_FILE_MODE);
  const written = fs.statSync(file);
  lastWritten.set(file, { comparable, mtimeMs: written.mtimeMs, size: written.size });
  return state;
}

// The last saveState write, per state file: the comparison
// string plus the file's mtime+size as written, so an
// out-of-band edit invalidates the cache (see saveState above).
const lastWritten = new Map();

// The saveState comparison: the state as it
// would be written, minus the fields that advance on every tick
// without meaning anything changed. See saveState for why each
// field is excluded. Values that matter — statuses, reasons,
// prices, tips, fees, outspends, grace, connection stamps —
// all still compare, so any real change still writes.
function comparableState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.updatedAt;
  if (copy.checkin && typeof copy.checkin === 'object') delete copy.checkin.lastOnlineAt;
  for (const tx of (copy.bitcoin && copy.bitcoin.txs) || []) {
    for (const s of (Array.isArray(tx.triggerState) ? tx.triggerState : [])) {
      if (s && typeof s === 'object') { delete s.lastEvalAt; delete s.lastPriceAt; if (s.lastOutspend && typeof s.lastOutspend === 'object') delete s.lastOutspend.checkedAt; }
    }
  }
  for (const s of (copy.bitcoin && copy.bitcoin.sets) || []) {
    for (const sl of (Array.isArray(s.triggerState) ? s.triggerState : [])) {
      if (sl && typeof sl === 'object') { delete sl.lastEvalAt; delete sl.lastPriceAt; if (sl.lastOutspend && typeof sl.lastOutspend === 'object') delete sl.lastOutspend.checkedAt; }
    }
  }
  return JSON.stringify(copy, null, 2);
}

// Heartbeat: the live "I was online" stamp in its own small file, so the
// tick can record liveness without rewriting state. touchHeartbeat
// (throttled) from the tick, writeHeartbeat on shutdown, merged on load.
function readHeartbeat(dataDir) {
  // The heartbeat's lastOnlineAt ISO string, or null when the
  // file is missing, unreadable, or malformed. Never throws —
  // a bad heartbeat is a fallback, not an error.
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, HEARTBEAT_FILE), 'utf8'));
    if (doc && typeof doc.lastOnlineAt === 'string') {
      const at = new Date(doc.lastOnlineAt);
      if (!Number.isNaN(at.getTime())) return doc.lastOnlineAt;
    }
  } catch (e) { /* missing/corrupt: fall back to state */ }
  return null;
}

// In-memory throttle record: last heartbeat write per data dir
// (ms since epoch). A fresh process starts empty, so its first
// touchHeartbeat always writes.
const heartbeatLastWrite = new Map();

function writeHeartbeat(dataDir, isoNow) {
  // Unconditional write (tmp+rename via writeFileDurable, NO
  // backup rotation — the file is a few bytes and is rewritten
  // every few minutes). Records the write for the throttle.
  ensureDir(dataDir);
  writeFileDurable(path.join(dataDir, HEARTBEAT_FILE), JSON.stringify({ lastOnlineAt: isoNow }) + '\n', DATA_FILE_MODE);
  heartbeatLastWrite.set(dataDir, Date.now());
}

function touchHeartbeat(dataDir, isoNow) {
  // Throttled write: at most once per HEARTBEAT_INTERVAL_MS per
  // data dir. Returns true when it wrote. A negative elapsed time
  // means the clock went BACKWARD since the last write (an NTP
  // correction after a forward jump) — the throttle is expired,
  // not extended: write now instead of blocking writes until the
  // clock catches up.
  const last = heartbeatLastWrite.get(dataDir) || 0;
  const elapsed = Date.now() - last;
  if (elapsed >= 0 && elapsed < HEARTBEAT_INTERVAL_MS) return false;
  writeHeartbeat(dataDir, isoNow);
  return true;
}

function mergeHeartbeat(state, dataDir) {
  // The newer stamp wins, but a stamp later than now plus the heartbeat
  // interval is a wrong-clock artefact: ignored, and the result capped. If
  // both are future-dated the cap holds until the heartbeat is rewritten
  // (within 5 minutes of a corrected clock).
  if (!state.checkin || typeof state.checkin !== 'object') return;
  const capMs = Date.now() + HEARTBEAT_INTERVAL_MS;
  const hb = readHeartbeat(dataDir);
  if (hb) {
    const hbMs = Date.parse(hb);
    if (!Number.isNaN(hbMs) && hbMs <= capMs) {
      const cur = state.checkin.lastOnlineAt;
      if (typeof cur !== 'string' || !cur || hb > cur) state.checkin.lastOnlineAt = hb;
    }
  }
  const merged = state.checkin.lastOnlineAt;
  if (typeof merged === 'string' && merged) {
    const mergedMs = Date.parse(merged);
    if (!Number.isNaN(mergedMs) && mergedMs > capMs) state.checkin.lastOnlineAt = new Date(capMs).toISOString();
  }
}

// Durable writes: write a temp file, fsync it, rename, then fsync the
// directory, so a power cut cannot lose the latest save. A failed file
// fsync fails the save; the directory fsync is best-effort.
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    console.warn('Standby: could not fsync directory ' + dir + ': ' + e.message);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

// `mode`: the file's permission bits. Set on
// the tmp file before the content is written, so the final file
// never exists with looser permissions — even when a leftover .tmp
// from a crash already existed with other bits.
function writeFileDurable(file, content, mode) {
  const tmp = file + '.tmp';
  const fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode);
  try {
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function appendJsonl(dataDir, file, entry) {
  // Durable like state.json: open, append,
  // fsync, close. These are audit logs — a lost line costs
  // history, not correctness (the authoritative check-in and
  // broadcast state lives in the fsynced state.json, and the
  // reader skips a torn line) — but check-ins and broadcasts
  // are rare, so the fsync costs nothing.
  ensureDir(dataDir);
  const full = path.join(dataDir, file);
  const fd = fs.openSync(full, 'a', DATA_FILE_MODE);
  let size = 0;
  try {
    fs.writeFileSync(fd, JSON.stringify(entry) + '\n', 'utf8');
    fs.fsyncSync(fd);
    size = fs.fstatSync(fd).size;
  } finally {
    fs.closeSync(fd);
  }
  if (size > LOG_COMPACT_BYTES) compactJsonl(dataDir, file);
}

// Logs are compacted to their newest LOG_KEEP_ENTRIES once past
// LOG_COMPACT_BYTES (readers need at most 200), so they never grow without
// bound.
const LOG_KEEP_ENTRIES = 1000;
const LOG_COMPACT_BYTES = 512 * 1024;
function compactJsonl(dataDir, file) {
  try {
    writeJsonl(dataDir, file, readJsonl(dataDir, file, LOG_KEEP_ENTRIES));
  } catch (e) {
    console.error('Standby: could not compact ' + file + ': ' + e.message);
  }
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
  // Durable via the same tmp+rename+fsync as
  // state.json — a full rewrite, so the durable helper fits.
  ensureDir(dataDir);
  const lines = (entries || []).map((e) => JSON.stringify(e)).join('\n');
  writeFileDurable(path.join(dataDir, file), lines ? lines + '\n' : '', DATA_FILE_MODE);
}

module.exports = {
  loadState, saveState, writeFileDurable, secureDataDir, LOG_KEEP_ENTRIES, LOG_COMPACT_BYTES, DATA_DIR_MODE, DATA_FILE_MODE, writeHeartbeat, touchHeartbeat, defaultState, newTxId, newSetId,
  appendCheckin, readCheckins, writeCheckins,
  appendBroadcastLog, readBroadcastLog, writeBroadcastLog,
  normalizeTrigger, normalizeRule, triggerOf, triggerRulesOf, triggerTypesOf, hasTriggerType,
  serveTrigger, serveTriggerState, normalizeTriggerState, defaultTrigger, defaultTriggerSet,
  FALLBACK_THRESHOLD_DAYS, MAX_RULES_PER_TX,
  TRIGGER_TYPES, HISTORY_TYPES, HISTORY_MAX,
  sanitizeFeeHistory, FEE_HISTORY_WINDOW_DAYS, FEE_HISTORY_MIN_OBSERVATIONS, FEE_HISTORY_MAX_ENTRIES,
  memberHistoryDetail, backfillSetHistory,
  // Persistence hardening: backup rotation, corrupt-state
  // recovery warnings, and the backup-with-keys lookup for the
  // startup key-store check.
  getStateWarnings, clearStateWarnings, resetStateFiles, findBackupWithKeys,
  BACKUP_FILE, PRE_MIGRATION_FILE, DAILY_BACKUP_PREFIX, DAILY_BACKUP_KEEP,
};
