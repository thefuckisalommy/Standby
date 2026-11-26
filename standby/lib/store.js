'use strict';
// Plain-file JSON storage, no database: DATA_DIR/state.json, plus append-
// only JSONL logs of check-ins and broadcast attempts.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const STATE_FILE = 'state.json';
const CHECKIN_LOG = 'checkins.jsonl';
const BROADCAST_LOG = 'broadcast.jsonl';
// The heartbeat file holds the live "I was online" stamp, so the tick need
// not rewrite state to record it. Tiny, atomic, no backup rotation.
const HEARTBEAT_FILE = 'heartbeat.json';
// At most one heartbeat write per 5 minutes per data dir (grace thresholds
// are hours, so this costs nothing).
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
      // Price agreement: the two price sources must agree within this %
      // (1–20, default 5). Tighter is safer but waits more during fast
      // moves.
      priceAgreementPct: 5,
      // Check cadence: how often the full tick evaluates every rule, in
      // seconds (10–3600, default 60). Faster reacts sooner; slower makes
      // fewer API calls.
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
      // Accept check-ins from other devices: a desktop or plain run opens
      // a check-in-only port (lib/remote-checkin.js). Off by default.
      acceptRemoteCheckins: false,
      // Start with this computer (standalone builds; lib/autostart.js). On
      // by default; setup shows it and can switch it off.
      startAtLogin: true,
      // Check for new versions (lib/updates.js): null means this install's
      // default (on for the downloads, off for Docker and plain Node).
      updateCheck: null,
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
    // Grace state: all null when none was set (or it was resumed or
    // expired); graceUntil null is an indefinite grace. See
    // lib/checkin.js.
    grace: { graceUntil: null, triggeredAt: null, offlineGapDays: null },
    // Fee history: the hourly economy-fee readings the peak comes from
    // (see sanitizeFeeHistory).
    feeHistory: [],
    // Check-in API keys, one per service allowed to check in. A key
    // authorizes only recording a check-in via the receiver; only its
    // SHA-256 hash is stored (the plaintext is shown once). key = { id,
    // label, hash, createdAt, lastUsedAt }
    checkinKeys: [],
    // First-open setup (the page-per-step walkthrough). done false shows
    // it; an install from before it existed loads as done.
    setup: { done: false },
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
// The history event types allowed (see lib/history.js). Transitions only.
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
  // Events already on the trail (same type and detail) are skipped by
  // count, so a re-attach never duplicates a line. The merged trail stays
  // chronological, capped at HISTORY_MAX.
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
      // An event already on the trail under the old bare-label tag counts
      // as the same event.
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
// No global threshold: each check-in rule has its own thresholdDays; 35 is
// the default and the fallback.
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

// Validate and normalize one rule: { trigger } or { error }, never throws.
// A check-in threshold is clamped to 1..3650; a non-number is an error.
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
      // Confirmations the spender needs: 0 fires on a mempool spend, N >=
      // 1 once it has N. Missing means 1 (confirmed only).
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
      // Fire when the chain tip reaches a height (a positive integer).
      // Judged fresh each evaluation, so a reorg below it un-fires it.
      const h = params.targetHeight;
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 10000000) {
        return { error: 'block-height trigger targetHeight must be an integer block height from 1 to 10,000,000' };
      }
      return { trigger: { type: 'blockheight', params: { targetHeight: h } } };
    }
    case 'setdate': {
      // Fire at a date and time, regardless of check-ins. Stored as an ISO
      // string.
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

// The tx's normalized rule set; missing or unusable means a 35-day check-
// in rule, so no transaction is lost to an unreadable trigger. Mirrored in
// public/app.js.
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

// The rule set as served: a one-rule set as its single rule, a multi-rule
// set as the set (stored form is always the set).
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
// Windows has no POSIX modes (only a read-only bit) and cannot fsync a
// directory; its folder permissions come from the user profile.
const IS_WINDOWS = process.platform === 'win32';

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
}

// At startup, tighten a data directory left 0755/0644 by an older version.
// Best effort (files this process does not own are reported by the
// writability check); subdirectories are left alone. Returns the count
// changed.
function secureDataDir(dataDir) {
  let changed = 0;
  if (IS_WINDOWS) return changed;
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

// Persistence warnings (a state recovery), kept for this process and
// served on GET /api/state; cleared when the state is replaced (restore or
// reset).
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

// Delete the state file and every local backup (missing files are fine).
// Returns the count removed.
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

// Rotate backups before the new state is written (saveState only).
// Failures are logged, never thrown: a backup must not block the save.
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

// Copy the state file before a migration rewrites it, so the migration can
// be undone by hand.
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

// The first backup candidate that parses as a Standby state: { parsed,
// file }, or null. Unreadable ones are skipped.
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
    try { renameReplacing(file, preserved); }
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

// The newest backup that still holds check-in keys (daily snapshots first,
// then the previous version): { file, count } or null.
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
    // A missing state file with backups present is recovered, like a
    // corrupt one; only no backups at all is a first boot.
    const recovered = recoverMissingState(dataDir);
    if (recovered) {
      saved = recovered;
    } else {
      const state = defaultState();
      saveState(dataDir, state);
      return state;
    }
  } else {
    // An unreadable or non-Standby state file is recovered from the newest
    // usable backup; if none loads this throws, never resetting to
    // defaults.
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
  if (!saved.setup || typeof saved.setup !== 'object') state.setup = { done: true };
  // Sanitize the fee history on load, so hand-edited or old state cannot
  // slip a bad, future or out-of-window entry into the peak.
  state.feeHistory = sanitizeFeeHistory(state.feeHistory);
  // Merge the heartbeat on every load: lastOnlineAt is max(heartbeat,
  // state), ignoring and capping future stamps (a forward clock would
  // otherwise hide a real outage). Read-only: writing it back would defeat
  // the save dedupe; it rides along on the next real save.
  mergeHeartbeat(state, dataDir);
  // paused is not a setting (Global Arm/Disarm is); prune it so a stale
  // paused: true never resurfaces.
  if (state.settings && typeof state.settings === 'object' && 'paused' in state.settings) {
    delete state.settings.paused;
  }
  // A legacy vacationUntil of '' means indefinite now —
  // normalize it to null so every reader sees one shape.
  if (state.settings && typeof state.settings === 'object' && state.settings.vacationUntil === '') {
    state.settings.vacationUntil = null;
  }
  // Old state with graceDurationDays 0 and no graceEnabled loads as off
  // (the 0 meant off). A saved flag always wins.
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
  // 0.3.0 migration: the message release is gone; prune what it left
  // (including any stored ciphertext). delivery.jsonl stays on disk but is
  // not read.
  let pruned = false;
  for (const k of ['recipient', 'channels', 'reminders']) {
    if (k in state) { delete state[k]; pruned = true; }
  }
  if (state.release && typeof state.release === 'object' && !('status' in state.release)) {
    state.release = null;
    pruned = true;
  }
  // 0.4.0 migration: a single stored tx becomes txs[0] with its own arm
  // and release record.
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
  // 0.8.0 migration: prune the global broadcast threshold (each check-in
  // rule has its own).
  if (state.settings && 'thresholdDays' in state.settings) { delete state.settings.thresholdDays; pruned = true; }
  // 0.5.2 migration: prune the check-in interval, warning levels and old
  // grace period (one threshold now).
  for (const k of ['checkinIntervalDays', 'warn1Days', 'warn2Days', 'graceDays']) {
    if (state.settings && k in state.settings) { delete state.settings[k]; pruned = true; }
  }
  // 0.5.4 migration: the RPC path is gone, with its config and stored
  // password; a custom endpoint from 0.5.3 becomes the primary.
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
      // A set from before the single-history change gets its members'
      // earlier histories backfilled. Idempotent.
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

// The last saveState write per state file: the comparison string plus the
// file's mtime and size, so an outside edit invalidates it.
const lastWritten = new Map();

// The state as written, minus fields that change every tick without
// meaning anything (see saveState). Everything that matters still
// compares.
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
  // The heartbeat's lastOnlineAt, or null when missing or malformed. Never
  // throws.
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, HEARTBEAT_FILE), 'utf8'));
    if (doc && typeof doc.lastOnlineAt === 'string') {
      const at = new Date(doc.lastOnlineAt);
      if (!Number.isNaN(at.getTime())) return doc.lastOnlineAt;
    }
  } catch (e) { /* missing/corrupt: fall back to state */ }
  return null;
}

// Last heartbeat write per data dir (empty in a fresh process, so the
// first touch writes).
const heartbeatLastWrite = new Map();

function writeHeartbeat(dataDir, isoNow) {
  // Unconditional heartbeat write (durable, no rotation); records it for
  // the throttle.
  ensureDir(dataDir);
  writeFileDurable(path.join(dataDir, HEARTBEAT_FILE), JSON.stringify({ lastOnlineAt: isoNow }) + '\n', DATA_FILE_MODE);
  heartbeatLastWrite.set(dataDir, Date.now());
}

function touchHeartbeat(dataDir, isoNow) {
  // Throttled heartbeat write (once per HEARTBEAT_INTERVAL_MS). A negative
  // elapsed time means the clock went back: write now rather than wait for
  // it to catch up. Returns true when it wrote.
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
  if (IS_WINDOWS) return; // NTFS commits the rename itself; a directory cannot be opened for fsync
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

// mode is set on the temp file before writing, so the final file never
// exists with looser permissions.
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
  renameReplacing(tmp, file);
  fsyncDir(path.dirname(file));
}

// Windows refuses to replace a file another process has open for a moment
// (an antivirus scan, the receiver reading keys.json): retry briefly.
function renameReplacing(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!IS_WINDOWS || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function appendJsonl(dataDir, file, entry) {
  // Logs are appended durably too (append, fsync). A lost line costs
  // history, not correctness, and these writes are rare.
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

// Replace a JSONL log with the given entries (restore); an empty array
// clears it.
function writeJsonl(dataDir, file, entries) {
  // Durable via the same tmp+rename+fsync as
  // state.json — a full rewrite, so the durable helper fits.
  ensureDir(dataDir);
  const lines = (entries || []).map((e) => JSON.stringify(e)).join('\n');
  writeFileDurable(path.join(dataDir, file), lines ? lines + '\n' : '', DATA_FILE_MODE);
}

module.exports = {
  loadState, saveState, writeFileDurable, renameReplacing, secureDataDir, LOG_KEEP_ENTRIES, LOG_COMPACT_BYTES, DATA_DIR_MODE, DATA_FILE_MODE, writeHeartbeat, touchHeartbeat, defaultState, newTxId, newSetId,
  appendCheckin, readCheckins, writeCheckins,
  appendBroadcastLog, readBroadcastLog, writeBroadcastLog,
  normalizeTrigger, normalizeRule, triggerOf, triggerRulesOf, triggerTypesOf, hasTriggerType,
  serveTrigger, serveTriggerState, normalizeTriggerState, defaultTrigger, defaultTriggerSet,
  FALLBACK_THRESHOLD_DAYS, MAX_RULES_PER_TX,
  TRIGGER_TYPES, HISTORY_TYPES, HISTORY_MAX,
  sanitizeFeeHistory, FEE_HISTORY_WINDOW_DAYS, FEE_HISTORY_MIN_OBSERVATIONS, FEE_HISTORY_MAX_ENTRIES,
  memberHistoryDetail, backfillSetHistory,
  // Persistence hardening: backup rotation, recovery warnings, the backup-
  // with-keys lookup.
  getStateWarnings, clearStateWarnings, resetStateFiles, findBackupWithKeys,
  BACKUP_FILE, PRE_MIGRATION_FILE, DAILY_BACKUP_PREFIX, DAILY_BACKUP_KEEP,
};
