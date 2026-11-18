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
    version: 6,
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
    //   trigger, triggerState,
    //   release: null | { status: 'broadcast'|'failed'|'stale'|'submitted-slipstream', txid,
    //     method, broadcastedAt | lastAttemptAt, error?, mara? },
    //   broadcasted: null | { txid, broadcastedAt, method,
    //     confirmations, blockHeight, found, checkedAt } }
    // trigger (0.8.0) is the rule that fires this transaction —
    // { type, params } — one of checkin / price / utxo / manual
    // (see normalizeTrigger below). triggerState is the trigger's
    // last evaluation ({ lastEvalAt, status, reason,
    // lastPrice, lastOutspend } — the fields depend on the type) or
    // null when it has never been evaluated.
    // release is the current cycle's record (a check-in clears it);
    // broadcasted is the permanent fact that the tx went out (a
    // check-in never clears it; replacing the hex does).
    // Connection is the last Test-connection result { ok, checkedAt,
    // detail } or { ok: null, ... } if untested.
    bitcoin: { txs: [], connection: { ok: null, checkedAt: null, detail: '' } },
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

// ---------------------------------------------------------------------------
// Triggers (0.8.0). Each transaction carries its own trigger —
// { type, params } — and the check-in clock is one trigger type:
//   checkin { thresholdDays } — fire when the check-in clock is
//     release-due at this tx's own threshold.
//   price   { asset: 'BTC', op: '>=' | '<=', value } — fire when
//     the BTC price (USD) is at/above (or at/below) value and both
//     price sources agree (no sustained wait).
//   utxo    { outpoint: 'txid:vout', condition: 'spent' } — fire
//     when the outpoint is spent by a confirmed transaction.
//   manual  {} — never fires; the owner broadcasts it by hand.
// A tx with no trigger (an older state file) defaults to the
// check-in trigger at the 35-day fallback, so existing behaviour
// is unchanged. The price value is bounded (a trigger for $0 or
// $999,999,999 is a typo, not a rule); the outpoint must be a
// 64-hex txid, a colon, and an output index.
// ---------------------------------------------------------------------------
const TRIGGER_TYPES = ['checkin', 'price', 'utxo', 'manual', 'blockheight', 'setdate', 'feemarket'];
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

// Validate + normalize a trigger (from a client, a backup, or a
// stored state file). Returns { trigger } (normalized) or
// { error: '...' } — never throws, so a bad trigger is a
// validation error, not a crash. A check-in thresholdDays is
// clamped to 1..3650 (a range issue is not a rejection);
// a non-numeric one is.
function normalizeTrigger(input) {
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

// The tx's trigger, normalized — a missing or unusable trigger
// defaults to the check-in trigger at the 35-day fallback, so
// the release never loses a transaction to a trigger it cannot
// read. (The frontend mirrors this rule in public/app.js.)
function triggerOf(tx) {
  if (!tx || typeof tx !== 'object') return defaultTrigger();
  const r = normalizeTrigger(tx.trigger);
  return r.trigger || defaultTrigger();
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

function loadState(dataDir) {
  ensureDir(dataDir);
  const file = path.join(dataDir, STATE_FILE);
  if (!fs.existsSync(file)) {
    const state = defaultState();
    saveState(dataDir, state);
    return state;
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  if (state.version !== 6) state.version = 6;
  // 0.8.0 migration: every transaction carries its own trigger
  // and triggerState. A tx from before 0.8.0 carries neither: it
  // defaults to the check-in trigger at the 35-day fallback (so
  // existing behaviour is unchanged) and a null triggerState
  // ("not evaluated yet"). A trigger with an unknown type falls
  // back the same way — the release must never lose a transaction
  // to a trigger it cannot read. The migration is idempotent and
  // runs on every load (cheap), so a hand-edited state file is
  // normalized too. A triggerState that is not null and not an
  // object is dropped (the evaluator overwrites it on the next
  // evaluation anyway).
  let triggerMigrated = false;
  for (const t of (state.bitcoin.txs || [])) {
    const trg = triggerOf(t);
    if (JSON.stringify(trg) !== JSON.stringify(t.trigger)) { t.trigger = trg; triggerMigrated = true; }
    if (t.triggerState === undefined || (t.triggerState !== null && typeof t.triggerState !== 'object') || Array.isArray(t.triggerState)) {
      t.triggerState = null; triggerMigrated = true;
    }
  }
  if (pruned || migrated || triggerMigrated) {
    if (migrated) console.log('Standby 0.4.0: migrated single transaction to the transactions list');
    if (pruned) console.log('Standby: pruned legacy state (recipient/channels/reminders/release)');
    if (triggerMigrated) console.log('Standby 0.8.0: migrated transactions to per-transaction triggers');
    saveState(dataDir, state);
  }
  return state;
}

function saveState(dataDir, state) {
  ensureDir(dataDir);
  state.updatedAt = new Date().toISOString();
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
  loadState, saveState, defaultState, newTxId,
  appendCheckin, readCheckins, writeCheckins,
  appendBroadcastLog, readBroadcastLog, writeBroadcastLog,
  normalizeTrigger, triggerOf, defaultTrigger, FALLBACK_THRESHOLD_DAYS,
  TRIGGER_TYPES, PRICE_MIN_USD, PRICE_MAX_USD,
};
