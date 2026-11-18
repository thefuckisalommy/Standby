'use strict';
// Standby — single-container Node app. ZERO runtime dependencies.
// Serves the static UI and a JSON API backed by plain files in DATA_DIR.
// Run:  PORT=3100 DATA_DIR=./data node server.js
//
// What this app is (0.7.22): a dead man's switch that does ONE thing —
// broadcast the owner's pre-signed Bitcoin transactions if they stop
// checking in past the broadcast threshold — or immediately, on the
// owner's say-so (Broadcast Now on a transaction's own card, or
// Broadcast Armed for the armed ones). There is no message delivery any more: no Part 1 /
// Part 2, no recipient, no channels, no reminders. Each transaction is
// signed in the owner's own wallet and pasted as raw hex; the app never
// sees keys. Each has its own enable toggle and its own release
// record. New transactions are armed by default. The broadcast is REAL,
// via the mempool API — a primary node and a secondary node (both
// user-chosen mempool endpoints, default mempool.space and
// blockstream.info/api), primary first, secondary if the primary does
// not answer. There is no Bitcoin Core RPC path any more (removed in
// 0.5.4). The "test" buttons are dry-runs that check the inputs are
// still unspent and never broadcast. A dry-run that finds spent inputs
// records the transaction stale on the spot: staleness is a durable
// fact about the inputs, not a cycle record and not page memory, so it
// survives refreshes and check-ins — only replacing the hex re-arms
// it. Settings has a data backup card:
// download a JSON backup of the whole setup, or restore one.
// The shared-input warning is derived from the stored transactions
// on every state read, so it persists across refreshes and clears the
// moment a transaction is edited away from the shared input.
// The check-in status turns 'broadcasted' once a release has gone
// out (a manual broadcast does not count) and a check-in resets it
// to 'on-track'. Broadcast Armed only attempts the armed transactions
// that are not archived (broadcasted or stale).
// 0.6.6 adds check-in API keys: a key lets a service or app check in
// for the owner, and it can only record a check-in — it cannot read
// transactions or broadcast. Each service gets its own labelled key
// (shown once, stored as a hash, revocable on its own), and the
// check-in log records which key checked in. The key is presented to
// the check-in receiver (a separate service, checkin-receiver/,
// LAN port 3101), which holds no transaction data and writes only a
// timestamp the app merges — so a holder of a key has no route to the
// transactions at all. The receiver reads the key hashes the app
// publishes to the shared CHECKIN_DIR (keys.json); the app merges a
// newer timestamp from CHECKIN_DIR/last.json on every status read and
// on the hourly tick.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const bitcoin = require('./lib/bitcoin');

const PORT = parseInt(process.env.PORT || '3100', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// The directory shared with the check-in receiver (mounted as a
// volume in docker-compose.yml). The app publishes the key hashes
// there (keys.json) and reads the receiver's check-in timestamps
// (last.json). Absent on a plain `node server.js` run — the key
// feature is dormant then; every file access is guarded.
const CHECKIN_DIR = process.env.CHECKIN_DIR || '/checkin';
const VERSION = '0.8.2';
const MAX_BODY = 1024 * 1024; // 1 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function asStr(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

// Broadcast route (0.7.16): which network a transaction goes out
// on. 'public' is the mempool nodes (primary, then secondary);
// 'slipstream' is MARA Slipstream (direct to MARA Pool's private
// mempool). Per transaction, chosen when it is added and changeable
// on its card — the two routes are never a fallback chain: only the
// selected route is attempted, and the hourly retry re-attempts that
// same route. Anything else (including a missing value on an older
// record or backup) is 'public'.
function validBroadcastVia(v) {
  return v === 'slipstream' ? 'slipstream' : 'public';
}

// Public fallback (0.7.17): a per-transaction OPT-IN timer on a
// Slipstream-route transaction. If the transaction is not publicly
// visible within the chosen number of days, Standby broadcasts it
// publicly instead — the automatic version of the manual "Broadcast
// publicly" escape hatch, for when nobody is watching. The allowed
// durations are the seven the UI offers; anything else (including a
// missing value on an older record or backup) is null — Never, no
// automatic fallback. The fallback only applies while the route is
// 'slipstream'; the value is stored (and kept) when the route is
// 'public', but ignored. It is deliberately lenient, like
// validBroadcastVia above: an invalid value becomes Never, never a
// 400.
const PUBLIC_FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
function validPublicFallbackDays(v) {
  return (typeof v === 'number' && PUBLIC_FALLBACK_DAYS.includes(v)) ? v : null;
}

// Grace period (0.8.0): when the app comes back after being
// offline, price and UTXO triggers are paused for a grace
// period so they do not fire on conditions that changed while
// the app was away. graceOfflineDays is the offline gap that
// triggers it; graceDurationDays is how long it lasts, or null
// = indefinite (until the owner resumes from the dashboard
// card). The allowed values are exactly the ones the Settings
// dropdowns offer; anything else is a 400 at PUT /api/settings
// — a bad grace setting must not silently become a different
// one (unlike the lenient per-tx fallback above, where a
// missing value becomes Never at serve time).
const GRACE_OFFLINE_DAYS = [1, 3, 7, 14, 30];
const GRACE_DURATION_DAYS = [1, 3, 7, 14, 30];

// User controls (0.8.0): the Settings cards for price agreement,
// check cadence, and fee verdict. Each is a number input with a
// min/max bound — anything outside is a 400 at PUT /api/settings
// and at restore, never a silent clamp (a bad value must not
// silently become a different one).
const PRICE_AGREEMENT_PCT_MIN = 1, PRICE_AGREEMENT_PCT_MAX = 20, PRICE_AGREEMENT_PCT_DEFAULT = 5;
const CHECK_CADENCE_SECONDS_MIN = 10, CHECK_CADENCE_SECONDS_MAX = 3600, CHECK_CADENCE_SECONDS_DEFAULT = 60;
const FEE_LOW_MULT_MIN = 1, FEE_LOW_MULT_MAX = 10, FEE_LOW_MULT_DEFAULT = 2;
const FEE_MED_MULT_MIN = 0.5, FEE_MED_MULT_MAX = 5, FEE_MED_MULT_DEFAULT = 1;

// ---------------------------------------------------------------------------
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

// State as served to the UI: a plain deep copy, except the check-in key
// hashes are stripped — the UI never needs them (the /api/checkin-keys
// list omits them too). The hashes are SHA-256 of the keys, which cannot
// be turned back into a key, but there is no reason to send them to the
// browser on every state read. The BACKUP is the only document that
// carries the hashes (a restore needs them so the keys keep working) —
// it takes its own full copy below, not sanitizeState.
function sanitizeState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  if (Array.isArray(copy.checkinKeys)) copy.checkinKeys = copy.checkinKeys.map(publicCheckinKey);
  return copy;
}

// ---------------------------------------------------------------------------
// Check-in API keys (0.6.6). A key is a bearer token that authorizes
// exactly one thing: recording a check-in, via the check-in receiver.
// It cannot read state, list transactions, broadcast, or change
// settings — and the receiver has no route to the transactions at
// all, so a key holder has no path to them either.
//   - The plaintext key is generated here, returned ONCE (at creation),
//     and never stored. Only its SHA-256 hash is kept.
//   - The hashes are published to the receiver through the shared
//     CHECKIN_DIR (keys.json, rewritten whenever keys change). The
//     receiver reads that file fresh on every request, so a revocation
//     takes effect immediately.
//   - The receiver writes a check-in as CHECKIN_DIR/last.json
//     ({ lastCheckinAt, keyId, label, sourceIp }); mergeExternalCheckin()
//     below folds a newer timestamp into the check-in clock, the same
//     way POST /api/checkin does (clears the cycle-scoped release
//     records, never a stale one; logs which key
//     checked in). Idempotent: the same file merged twice changes
//     nothing the second time, because its timestamp is no longer
//     newer than the clock.
// ---------------------------------------------------------------------------
function hashCheckinKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

function newCheckinKeyId() {
  return 'key_' + crypto.randomBytes(4).toString('hex');
}

// The key as listed to the UI: everything except the hash.
function publicCheckinKey(k) {
  return { id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null };
}

function writeReceiverKeys(state) {
  try {
    fs.mkdirSync(CHECKIN_DIR, { recursive: true });
    const doc = {
      keys: (state.checkinKeys || []).map((k) => ({ id: k.id, label: k.label, hash: k.hash })),
    };
    const file = path.join(CHECKIN_DIR, 'keys.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    // No shared directory (a plain `node server.js` run, or the
    // receiver is not installed) — the keys are inert until it is.
  }
}

// Read the receiver's last check-in (CHECKIN_DIR/last.json) —
// tri-state (0.7.13, fourth-audit finding 7). Returns { status }:
//   'missing' — no file. There is no receiver, or it has never
//     recorded a check-in. Nothing to merge; this is NOT an error.
//   'ok' — a valid check-in record (plus the record's fields).
//   'error' — the file exists but cannot be read or parsed. A
//     check-in may be sitting there that we cannot see, so a
//     release must NOT go out while this stands (see
//     evaluateRelease). "Missing" is decided from the read error's
//     code (ENOENT), never from fs.existsSync — existsSync returns
//     false on EACCES too, so an unreadable file would otherwise
//     be mistaken for a missing one.
function readExternalCheckin() {
  const file = path.join(CHECKIN_DIR, 'last.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', error: e.message };
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || typeof doc.lastCheckinAt !== 'string') {
      return { status: 'error', error: 'last.json is not a check-in record' };
    }
    const at = new Date(doc.lastCheckinAt);
    if (Number.isNaN(at.getTime())) return { status: 'error', error: 'last.json check-in time is not a valid date' };
    return {
      status: 'ok',
      at,
      raw: doc.lastCheckinAt,
      keyId: typeof doc.keyId === 'string' ? doc.keyId : null,
      keyLabel: typeof doc.label === 'string' ? doc.label : null,
      sourceIp: typeof doc.sourceIp === 'string' ? doc.sourceIp : null,
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// Fold a newer receiver check-in into the clock. Returns true when a
// check-in was applied (and saved + logged), false when there was
// nothing to apply — a missing file, a timestamp in the future (the
// receiver writes "now"; anything more than 5 minutes ahead is a
// skewed clock, not a check-in), or one no newer than the clock —
// and the string 'error' when the receiver state could not be read
// (see readExternalCheckin). Callers that decide a release MUST treat
// 'error' as "do not proceed": an unreadable check-in file is not the
// same as no check-in (0.7.13, fourth-audit finding 7). Callers that
// only display state treat it as "nothing applied".
function mergeExternalCheckin(state, now) {
  const ext = readExternalCheckin();
  if (ext.status === 'error') return 'error';
  if (ext.status === 'missing') return false;
  if (ext.at.getTime() > now.getTime() + 5 * 60 * 1000) return false;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (last && ext.at.getTime() <= last.getTime()) return false;
  state.checkin.lastCheckinAt = ext.raw;
  state.checkin.totalCheckins += 1;
  // A check-in clears an offline-gap hold (0.7.22): the owner is
  // alive, the clock resets, and there is nothing to hold back.
  state.checkin.heldUntil = null;
  // (0.8.0) A check-in clears the cycle-scoped release records of
  // the CHECK-IN rules only — a price or UTXO rule's record belongs
  // to its own trigger's cycle, not the check-in clock, so a
  // check-in must not clear it (and must not reset its trigger).
  // A stale record survives either way, as before.
  for (const t of (state.bitcoin.txs || [])) {
    if (!store.hasTriggerType(t, 'checkin')) continue;
    if (t.release && t.release.status === 'stale') continue;
    t.release = null;
    // The clock restarts at this check-in: any frozen time is
    // wiped, then a tx that is still inactive (disarmed, or on
    // vacation) is re-marked inactive from now — it stays frozen
    // at 0 instead of counting while inactive.
    t.checkinOffsetMs = 0;
    t.checkinInactiveSince = null;
  }
  for (const t of (state.bitcoin.txs || [])) syncCheckinFreeze(t, state, now);
  if (ext.keyId) {
    const k = (state.checkinKeys || []).find((x) => x.id === ext.keyId);
    if (k) k.lastUsedAt = ext.raw;
  }
  store.saveState(DATA_DIR, state);
  store.appendCheckin(DATA_DIR, { ts: ext.raw, method: 'api-key', keyId: ext.keyId, keyLabel: ext.keyLabel, sourceIp: ext.sourceIp || null });
  return true;
}

// Offline-gap grace (0.7.22). The release clock cannot tell "the
// device was off" from "the owner stopped checking in" — both look
// like a last check-in months ago, and the app would broadcast ~5s
// after powering back on. The guard is a persisted hold on the
// broadcast date, granted only when BOTH of these hold:
//   1. Offline gap: the "I was online" stamp (state.checkin.
//      lastOnlineAt, written on every hourly release tick) is more
//      than a quarter of the threshold stale — the device was off
//      for a meaningful chunk of the window.
//   2. Clock far along: more than half the threshold has elapsed
//      since the last check-in — the owner is in the danger zone,
//      or already past due (past due implies more than half).
// The hold is heldUntil = now + half the threshold, measured from
// the moment the app notices — NOT added to the original due date.
// Adding it to the original due leaves it in the past after a
// months-long outage, so the release would still fire on boot;
// measured from now, the owner gets a real grace window after
// powering back on. Only set when there is no active hold: a
// reboot during the grace window must not re-extend it (once the
// app is running again it keeps updating lastOnlineAt, so a fresh
// gap check would miss it — the persisted heldUntil is what
// carries it). Returns true when it set a new hold (caller
// saves); a check-in clears it (see both check-in paths).
// There is no global threshold any more: the fallback is the
// 35-day default, used only when no check-in rule is armed.
function applyOfflineHold(state, now) {
  const s = state.settings;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  const online = state.checkin.lastOnlineAt ? new Date(state.checkin.lastOnlineAt) : null;
  if (!last || !online) return false;
  // (0.8.0) The hold protects the EARLIEST-firing check-in rule:
  // the threshold that measures both conditions is the smallest
  // thresholdDays among the ARMED check-in rules — a tx with a
  // 7-day rule must not fire the moment the device comes back
  // just because the 35-day fallback is longer. With no armed
  // check-in rule the fallback is the threshold (the hold is
  // inert then anyway — nothing fires on the check-in clock).
  // (0.8.2) A tx may carry several check-in rules; every one of
  // them is measured.
  const ckThresholds = (state.bitcoin.txs || [])
    .filter((t) => t.enabled && store.hasTriggerType(t, 'checkin'))
    .flatMap((t) => store.triggerOf(t).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays));
  const thresholdDays = ckThresholds.length ? Math.min.apply(null, ckThresholds) : store.FALLBACK_THRESHOLD_DAYS;
  const thresholdMs = thresholdDays * 86400000;
  if (now.getTime() - online.getTime() <= thresholdMs / 4) return false;
  if (now.getTime() - last.getTime() <= thresholdMs / 2) return false;
  const heldRaw = state.checkin.heldUntil;
  const heldMs = (typeof heldRaw === 'string' && heldRaw) ? new Date(heldRaw).getTime() : NaN;
  if (Number.isFinite(heldMs) && heldMs > now.getTime()) return false;
  state.checkin.heldUntil = new Date(now.getTime() + thresholdMs / 2).toISOString();
  return true;
}

// --- Grace period for price/UTXO triggers (0.8.0) ---
// state.grace = { graceUntil, triggeredAt, offlineGapDays }.
// graceUntil is an ISO timestamp, or null for an indefinite
// grace (until the owner resumes). triggeredAt is when the
// grace was set; offlineGapDays is how many days the app had
// been offline when it was set (the dashboard card explains
// the pause with that number). The grace is app-level state:
// it is set when the app notices an offline gap longer than
// settings.graceOfflineDays, whatever txs exist at the time.
// It is NOT set while one is already active (an active grace
// never re-extends itself), and it is NOT cleared by a
// check-in — only by expiry (now past graceUntil) or by
// POST /api/grace/resume. Check-in triggers are not affected
// by it at all: they keep their own heldUntil hold above,
// which is a separate mechanism with its own thresholds.
function graceStatus(state, now) {
  const g = (state && state.grace && typeof state.grace === 'object') ? state.grace : null;
  if (!g || !g.triggeredAt) return null;
  if (g.graceUntil && now.getTime() > new Date(g.graceUntil).getTime()) return null;
  return {
    active: true,
    indefinite: !g.graceUntil,
    graceUntil: g.graceUntil || null,
    triggeredAt: g.triggeredAt,
    offlineGapDays: (typeof g.offlineGapDays === 'number') ? g.offlineGapDays : null,
  };
}
function isGraceActive(state, now) {
  return graceStatus(state, now) !== null;
}
// Notice an offline gap and start a grace period for the
// price/UTXO triggers, if the gap is longer than the
// configured threshold. Runs next to applyOfflineHold in
// evaluateRelease and on the GET /api/state and /api/status
// reads, and on the hourly tick — so a returning app notices
// the gap promptly, before any price/UTXO rule can fire.
// Returns true when it set a grace. (The hourly tick refreshes
// lastOnlineAt right after this runs, so an expired grace is
// not re-set on the same stale stamp — a fresh gap after the
// app returns is what sets the next one.)
function applyGrace(state, now) {
  if (isGraceActive(state, now)) return false;
  const online = state.checkin && state.checkin.lastOnlineAt ? new Date(state.checkin.lastOnlineAt) : null;
  if (!online || Number.isNaN(online.getTime())) return false;
  const s = state.settings || {};
  const offlineDays = (typeof s.graceOfflineDays === 'number' && GRACE_OFFLINE_DAYS.includes(s.graceOfflineDays)) ? s.graceOfflineDays : 7;
  const gapMs = now.getTime() - online.getTime();
  if (gapMs <= offlineDays * 86400000) return false;
  const durationDays = (s.graceDurationDays === null) ? null
    : ((typeof s.graceDurationDays === 'number' && GRACE_DURATION_DAYS.includes(s.graceDurationDays)) ? s.graceDurationDays : 7);
  state.grace = {
    graceUntil: durationDays === null ? null : new Date(now.getTime() + durationDays * 86400000).toISOString(),
    triggeredAt: now.toISOString(),
    offlineGapDays: Math.floor(gapMs / 86400000),
  };
  return true;
}

// Derived check-in status from state + now. Each armed check-in
// tx has its own threshold: check in before the soonest runs out
// and the clock resets; past it, the release is due. There are no
// warning levels and no grace period shown.
// Once a release has actually broadcast (a threshold was exceeded
// and a release went out), the status is 'broadcasted' — a manual
// broadcast does not count, only a release does (the release record
// carries kind 'release'). But 'broadcasted' means the release is
// DONE: every armed transaction has reached a terminal state
// (broadcasted or stale). A failed attempt is not terminal — an
// unknown-reason failure (a node rejection, a network error, a
// not-yet-final timelocked transaction) is retried on the next
// hourly tick (0.7.14) — so while any ARMED transaction still
// The danger zone (0.7.22): the last 25% of the check-in window —
// the time remaining until the due date is a quarter of the
// threshold or less (already past due is inside the zone).
// Actions that would arm a transaction or shorten the window
// while the clock is here reset the check-in instead of letting
// a due release fire. thresholdDays is the threshold to measure
// against (the check-in tx's own threshold for arming/adding/
// editing) — never hardcoded. liveOffsetMs is the tx's frozen
// time (0.8.0): the due is measured from the EFFECTIVE last
// check-in (last + frozen), so a frozen clock is never in the
// danger zone for time that never counted.
function inDangerZone(state, now, thresholdDays, liveOffsetMs) {
  if (!state.checkin.lastCheckinAt || !thresholdDays || thresholdDays <= 0) return false;
  const thresholdMs = thresholdDays * 86400000;
  const off = (typeof liveOffsetMs === 'number' && Number.isFinite(liveOffsetMs) && liveOffsetMs >= 0) ? liveOffsetMs : 0;
  const dueMs = new Date(state.checkin.lastCheckinAt).getTime() + off + thresholdMs;
  return (dueMs - now.getTime()) <= 0.25 * thresholdMs;
}

// Reset the check-in clock (0.7.22): the owner is present and
// doing something in the app that would otherwise let a due
// release fire soon — shortening the threshold into the danger
// zone, arming a transaction in the danger zone, or adding one
// in the danger zone. The clock restarts at now (count +1, hold
// cleared, "I was online" now) and the reset is recorded in the
// check-in history under the given method, so the displayed last
// check-in matches. It only touches the clock — never a release
// record.
function resetCheckin(state, now, method) {
  state.checkin.lastCheckinAt = now.toISOString();
  state.checkin.totalCheckins += 1;
  state.checkin.heldUntil = null;
  state.checkin.lastOnlineAt = now.toISOString();
  // The clock restarts at now: any frozen time is wiped (the
  // effective last check-in is now, so a carried offset would
  // push it into the future). A tx that is still inactive is
  // re-marked inactive from now, so it stays frozen at 0.
  for (const t of (state.bitcoin.txs || [])) {
    if (!store.hasTriggerType(t, 'checkin')) continue;
    t.checkinOffsetMs = 0;
    t.checkinInactiveSince = null;
  }
  for (const t of (state.bitcoin.txs || [])) syncCheckinFreeze(t, state, now);
  store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method });
}

// The check-in freeze (0.8.0): inactive time does not count
// toward the check-in countdown. A check-in tx is INACTIVE when
// it is disarmed (enabled=false) or vacation mode is on —
// Global Arm/Disarm sets enabled=false on every tx, so it is
// covered by the disarmed cause, and there is no separate
// global-disarm flag. ONE per-tx offset carries all three causes
// (vacation, global disarm, per-tx disarm): lastCheckinAt is
// never shifted, so a period where a tx was BOTH disarmed and on
// vacation is counted once, never twice.
//   checkinOffsetMs — accumulated inactive milliseconds, frozen
//     into the clock when an inactive period ends.
//   checkinInactiveSince — ISO timestamp of when the current
//     inactive period started, or null while the tx is active.
// checkinLiveOffsetMs(tx, now) is the total frozen time RIGHT
// NOW: the banked offset plus the open inactive period, if any.
// syncCheckinFreeze(tx, state, now) is called on every transition
// that can change a tx's active/inactive state (arm/disarm,
// vacation on/off, check-in, vacation expiry, arm-all, reset).
// The `if (!tx.checkinInactiveSince)` guard is what prevents
// double-counting: a second cause starting while the tx is
// already inactive does not restart the period, it just extends
// the same one.
function checkinLiveOffsetMs(tx, now) {
  const base = (typeof tx.checkinOffsetMs === 'number' && Number.isFinite(tx.checkinOffsetMs) && tx.checkinOffsetMs >= 0) ? tx.checkinOffsetMs : 0;
  if (typeof tx.checkinInactiveSince === 'string' && tx.checkinInactiveSince) {
    const since = new Date(tx.checkinInactiveSince).getTime();
    if (Number.isFinite(since)) return base + Math.max(0, now.getTime() - since);
  }
  return base;
}
function syncCheckinFreeze(tx, state, now) {
  if (!store.hasTriggerType(tx, 'checkin')) return;
  const inactive = !tx.enabled || !!state.settings.vacationMode;
  if (inactive) {
    if (!tx.checkinInactiveSince) tx.checkinInactiveSince = now.toISOString();
  } else if (tx.checkinInactiveSince) {
    const since = new Date(tx.checkinInactiveSince).getTime();
    if (Number.isFinite(since)) {
      tx.checkinOffsetMs = checkinLiveOffsetMs(tx, now);
    }
    tx.checkinInactiveSince = null;
  }
}

// Vacation expiry (0.8.0): a dated vacation ends at the END of
// vacationUntil — the owner is away THROUGH that date, so the
// clock resumes at the start of the next day, local time. An
// indefinite vacation (vacationUntil null) never expires on its
// own. On expiry the freeze is locked in (syncCheckinFreeze) so
// the days away never count, and the clock resumes from the
// frozen count. Returns true when it ended a vacation (caller
// saves). Called from the hourly tick and from evaluateRelease,
// so a lapsed vacation ends on the next evaluation of any kind,
// not only on the next hourly tick.
function vacationEndMs(vacationUntil) {
  if (typeof vacationUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(vacationUntil)) return null;
  const y = Number(vacationUntil.slice(0, 4));
  const m = Number(vacationUntil.slice(5, 7));
  const d = Number(vacationUntil.slice(8, 10));
  const end = new Date(y, m - 1, d + 1); // local midnight starting the day after the last away day
  return Number.isNaN(end.getTime()) ? null : end.getTime();
}
function expireVacation(state, now) {
  const s = state.settings;
  if (!s.vacationMode) return false;
  const endMs = vacationEndMs(s.vacationUntil);
  if (endMs === null) return false; // indefinite — holds until the owner says they're back
  if (now.getTime() < endMs) return false;
  s.vacationMode = false;
  s.vacationUntil = null;
  for (const t of (state.bitcoin.txs || [])) syncCheckinFreeze(t, state, now);
  return true;
}

// The check-in clock, pure (0.8.0): the due instant for a given
// threshold, the offline-gap hold's effect on it, and the clock
// state — ignoring vacation / broadcast records (those
// are checkinStatus's layer, below). Extracted from checkinStatus
// so the per-transaction check-in trigger evaluates the same clock
// at its own threshold instead of duplicating the math.
//   state: 'not-started' (no check-in yet), 'on-track',
//     'held' (an offline-gap grace is active and is the thing
//     pushing the due out), 'release-due'.
//   windowDays: the effective window in whole days (the threshold
//     on-track, the longer held window while a grace is active) —
//     the countdown bar and caption measure against it.
//   daysSince: whole days since the last check-in (display only).
// The release decision compares real timestamps (now vs. the due
// instant), not the floored day count — otherwise the release
// lands up to a whole day after the displayed bar
// (0.7.5 and earlier only released once the floored day count
// passed the threshold).
function checkinClock(state, now, thresholdDays, liveOffsetMs) {
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (!last || !thresholdDays || thresholdDays <= 0) {
    return { dueMs: null, heldMs: null, heldActive: false, effectiveDueMs: null, nextDue: null, windowDays: null, daysSince: null, state: 'not-started' };
  }
  // The freeze (0.8.0): inactive time does not count, so the
  // clock is measured from the EFFECTIVE last check-in — the
  // real one plus the frozen time. The due and the window shift
  // together by the same offset, so the window stays the
  // threshold on-track and daysSince reads the frozen count.
  const off = (typeof liveOffsetMs === 'number' && Number.isFinite(liveOffsetMs) && liveOffsetMs >= 0) ? liveOffsetMs : 0;
  const effLast = new Date(last.getTime() + off);
  const d = Math.max(0, days(effLast, now));
  const dueMs = effLast.getTime() + thresholdDays * 86400000;
  // Offline-gap grace (0.7.22): a hold pushes the effective due
  // out. heldUntil is a persisted "broadcast no earlier than"
  // instant; the effective due is the later of the original due and
  // the hold. When the hold is active it IS the effective due (a
  // hold is only set when the clock is more than halfway along,
  // so heldUntil = now + threshold/2 is always past the original
  // due at set time) — unless the owner changed the threshold
  // after the hold was set, in which case the later date wins.
  const heldRaw = state.checkin.heldUntil;
  const heldMs = (typeof heldRaw === 'string' && heldRaw) ? new Date(heldRaw).getTime() : NaN;
  const heldActive = Number.isFinite(heldMs) && heldMs > now.getTime();
  const effectiveDueMs = Number.isFinite(heldMs) ? Math.max(dueMs, heldMs) : dueMs;
  const nextDue = new Date(effectiveDueMs).toISOString();
  // Effective window, whole days, for the countdown bar + caption:
  // last check-in to the effective due. On-track it is the
  // threshold; while held it is the longer held window. Measured
  // from the EFFECTIVE last check-in (see the freeze above), so
  // a frozen bar's window stays its threshold.
  const windowDays = Math.max(1, Math.round((effectiveDueMs - effLast.getTime()) / 86400000));
  // A hold is in force only when it is active AND it is the thing
  // pushing the due out (heldUntil past the original due). A hold
  // left over from before a threshold increase does not hold
  // anything back — the original due is later, so on-track.
  const st = now.getTime() < effectiveDueMs
    ? ((heldActive && heldMs >= dueMs) ? 'held' : 'on-track')
    : 'release-due';
  return { dueMs, heldMs, heldActive, effectiveDueMs, nextDue, windowDays, daysSince: d, state: st };
}

// carries a 'failed' release record, the status stays 'release-due'
// and the release keeps running. A stale transaction does not keep
// it due (stale is terminal: skip it), and a transaction that has
// never been attempted does not either — one added after a release
// still waits for the next cycle. A check-in clears the
// cycle-scoped release records — a stale record survives, it is a
// fact about the inputs — so checking in after a broadcast resets
// the status to 'on-track'.
// Derived check-in status (0.8.0, per-tx bars): there is no
// global broadcast threshold any more — each check-in tx
// has its own countdown, measured at ITS OWN threshold with
// checkinClock, and served as checkinTxs (one entry per ACTIVE
// check-in tx: { id, label, thresholdDays, daysSince,
// windowDays, nextDue, state, enabled }). A settled or pending tx gets no
// bar — its fate is decided, so there is nothing to count down
// to (see txSettledOrPending below, which mirrors the frontend
// txStatus settled / pending split for the stored-state cases).
// The bar's window is the EFFECTIVE one — the
// tx's threshold on-track, the longer held window while an
// offline-gap grace is active — so a held bar just counts to the
// held date. A tx with no check-in yet reads 0 of its threshold.
// A DISARMED check-in tx keeps its bar, frozen at the day count
// it was left at (enabled: false, muted in the UI) — inactive
// time does not count, so its count never advances while it is
// disarmed or on vacation, and re-arming resumes from the frozen
// count. The top-level state, nextDue and windowDays come from
// the ARMED entries only: a disarmed tx cannot fire, so its due
// date must not drive the overall due and a frozen past-due
// disarmed tx must not read as 'release-due'. The top-level
// daysSince is the soonest armed entry's count (or the first
// disarmed entry's frozen count when nothing is armed).
// A tx whose fate is decided — broadcasted (settled or pending)
// or recorded stale / slipstream-pending / broadcast — is done
// counting down: it gets no check-in bar. This mirrors the
// frontend txStatus settled / pending split for the stored-state
// cases (the dry-run-only signals are not visible here).
// 'failed' and 'conflict' are NOT settled: the tx is still owed
// a broadcast, so it keeps its bar.
function txSettledOrPending(t) {
  if (t.broadcasted) return true;
  const rs = t.release && t.release.status;
  return rs === 'stale' || rs === 'submitted-slipstream' || rs === 'broadcast';
}
function checkinStatus(state, now) {
  const s = state.settings;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  const txs = state.bitcoin.txs || [];
  const isCheckinTx = (t) => store.hasTriggerType(t, 'checkin');
  // (0.8.2) One entry PER check-in RULE: a tx with two check-in
  // rules (different thresholds) appears once per rule, each entry
  // carrying its ruleIndex — the bar is per rule, the clock is
  // global, and the smallest threshold is the one that fires
  // first. The DOM suite and the old frontend read these entries
  // the same way: a one-rule tx yields exactly one entry, as
  // before.
  const checkinTxs = txs
    .filter((t) => isCheckinTx(t) && !txSettledOrPending(t))
    .flatMap((t) => store.triggerOf(t).rules
      .map((r, i) => ({ rule: r, ruleIndex: i }))
      .filter((x) => x.rule.type === 'checkin')
      .map(({ rule, ruleIndex }) => {
        const th = rule.params.thresholdDays;
        const off = checkinLiveOffsetMs(t, now);
        if (!last) return { id: t.id, label: t.label || '', ruleIndex, thresholdDays: th, daysSince: 0, windowDays: th, nextDue: null, state: 'not-started', enabled: !!t.enabled };
        const clock = checkinClock(state, now, th, off);
        return { id: t.id, label: t.label || '', ruleIndex, thresholdDays: th, daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue, state: clock.state, enabled: !!t.enabled };
      }));
  // The top level is driven by the ARMED entries only — a
  // disarmed tx cannot fire (see the comment above). When
  // nothing is armed the soonest due is null, and daysSince
  // falls back to the first disarmed entry's frozen count.
  const armedEntries = checkinTxs.filter((c) => c.enabled);
  const nextDue = armedEntries.reduce((acc, c) => (!c.nextDue ? acc : (!acc || c.nextDue < acc ? c.nextDue : acc)), null);
  const soonest = armedEntries.find((c) => c.nextDue === nextDue);
  const base = {
    daysSince: soonest ? soonest.daysSince : (checkinTxs.length ? checkinTxs[0].daysSince : (last ? days(last, now) : null)),
    nextDue,
    windowDays: soonest ? soonest.windowDays : null,
    checkinTxs,
  };
  if (s.vacationMode) {
    return { ...base, state: 'vacation', label: 'Vacation mode', vacationUntil: s.vacationUntil || null };
  }
  if (!last) {
    return { ...base, state: 'not-started', label: 'Not started' };
  }
  // A 'failed' record on an ARMED transaction means the release is
  // not done: that transaction is still owed a broadcast, and the
  // next hourly tick retries it (0.7.14). Only armed transactions
  // count — a disabled transaction's 'failed' record is inert (the
  // release never attempts a disabled transaction), and a stale one
  // is terminal, so neither keeps the status 'release-due'. A
  // transaction that has never been attempted does not keep it due
  // either — one added after a release still waits for the next cycle.
  // (0.8.0) These checks are about the CHECK-IN trigger only: a
  // price or UTXO broadcast (or failure) must not move the
  // check-in card — that rule has its own trigger and its own
  // state. A tx with no trigger field is a legacy check-in tx
  // (see triggerOf), so it counts.
  const anyFailed = txs.some((t) => t.enabled && isCheckinTx(t) && t.release && t.release.status === 'failed');
  // A transaction waiting on MARA (0.7.16) means the release is not
  // done: it still needs to become visible publicly or be declared
  // failed, so the status is not 'broadcasted' while one is waiting
  // — even if another transaction already broadcast. Only armed
  // transactions count (a disabled one's record is inert, like its
  // 'failed' record).
  const anyWaitingMara = txs.some((t) => t.enabled && isCheckinTx(t) && t.release && t.release.status === 'submitted-slipstream');
  if (!anyFailed && !anyWaitingMara && txs.some((t) => isCheckinTx(t) && t.release && t.release.status === 'broadcast' && t.release.kind === 'release')) {
    return { ...base, state: 'broadcasted', label: 'Broadcasted' };
  }
  // (0.8.0) Only ARMED check-in txs can make the card
  // 'release-due' — a disarmed tx frozen past its due cannot fire,
  // so it must not drive the overall state either.
  if (armedEntries.some((c) => c.state === 'release-due')) return { ...base, state: 'release-due', label: 'Release due' };
  return { ...base, state: 'on-track', label: 'On track' };
}

// ---------------------------------------------------------------------------
// Trigger evaluation (0.8.0, unified 0.8.2). One pure condition
// function per rule type — checkXRule(state, rule, now, ctx) —
// shared by BOTH paths: the evaluator (evaluateRule /
// evaluateTrigger, which writes the rule's triggerState slice and
// applies the evaluator-only holds) and the gate (checkTriggerNow,
// which answers the raw condition without writing anything and
// without grace / vacation / disarm — the gate blocks an add when
// satisfaction is definite, even while a hold would stop the
// release). A check function returns { fire, status, reason, slice,
// detail, warning }: `slice` is the triggerState slice to store for
// this rule (null = keep the stored slice — a held rule writes
// nothing); `detail` is the extra facts the gate answers with;
// `warning` is the already-satisfied warning (the gate's text —
// the evaluator ignores it). ctx is { prevSlice, liveOffsetMs,
// latchedTarget }: the rule's stored slice (the price jump guard's
// baseline, the block-height latch), the tx's frozen time (check-in
// rules only), and a latched block height for the gate.
// evaluateTrigger(state, tx, now) evaluates each rule
// and combines by the set's op (see combineOutcomes). triggerStatusFor
// (state, tx, now) is the UI-facing status, computed from the STORED
// triggerState (no network) — except the check-in trigger, whose
// state is live clock math so the card's "3 of 35 days elapsed" line
// is current on every page load.
// ---------------------------------------------------------------------------
const PRICE_JUMP_WINDOW_MS = 60 * 60 * 1000; // the 10x-jump guard (below) only applies when the last good reading is recent — over a longer gap a real 10x move is possible

// The configured price sources (Settings: priceSources
// {source1, source2}). Each slot is either a provider id string
// ('kraken', ...) or a custom object { id: 'custom', url, path }
// (0.8.1). An unusable value or two identical sources fall back
// to the defaults — the settings validator (PUT /api/settings)
// rejects those, but a hand-edited or restored state must never
// break the fetch.
function priceSourcesOf(settings) {
  const s = (settings && settings.priceSources && typeof settings.priceSources === 'object') ? settings.priceSources : {};
  const s1 = bitcoin.normalizePriceSourceValue(s.source1);
  const s2 = bitcoin.normalizePriceSourceValue(s.source2);
  const v1 = (s1 === null) ? 'coingecko' : s1;
  const v2 = (s2 === null) ? 'coinbase' : s2;
  if (bitcoin.priceSourceKey(v1) === bitcoin.priceSourceKey(v2)) return { source1: 'coingecko', source2: 'coinbase' };
  return { source1: v1, source2: v2 };
}

// The 400 message for a price-source value the validator
// rejects: an unknown provider id, or a custom object without a
// valid http(s) URL and a well-formed JSON path.
function priceSourceError(v) {
  if (v && typeof v === 'object') return 'custom price source needs a valid http(s) URL and a JSON path to the price (e.g. data.amount)';
  return 'unknown price provider: ' + v;
}

// The user controls (0.8.0), read defensively like
// priceSourcesOf above: the settings validator (PUT
// /api/settings, restore) rejects out-of-range values, but a
// hand-edited or restored state must never break an evaluation
// — an unusable value falls back to its default.
function priceAgreementPctOf(settings) {
  const v = settings && settings.priceAgreementPct;
  return (typeof v === 'number' && Number.isFinite(v) && v >= PRICE_AGREEMENT_PCT_MIN && v <= PRICE_AGREEMENT_PCT_MAX) ? v : PRICE_AGREEMENT_PCT_DEFAULT;
}
function checkCadenceSecondsOf(settings) {
  const v = settings && settings.checkCadenceSeconds;
  return (typeof v === 'number' && Number.isFinite(v) && v >= CHECK_CADENCE_SECONDS_MIN && v <= CHECK_CADENCE_SECONDS_MAX) ? v : CHECK_CADENCE_SECONDS_DEFAULT;
}

// The price cache holds BOTH readings (per source, TTL = the
// check cadence — Settings: Check cadence, default 60 seconds)
// plus which sources they were fetched for — a settings change
// makes the cache stale, so the next read fetches the new
// sources instead of serving the old ones. readings is
// { [sourceId]: { provider, price|null, error|null } }.
let priceCache = { readings: {}, fetchedAt: null, source1: null, source2: null };

// The current BTC price readings (per source), from the cache
// when fresh, else a live fetch of both sources in parallel.
// Returns the readings map — the caller combines them (the
// configured agreement rule + the directional extreme) via
// bitcoin.combinePriceReadings. `cadenceSeconds` is the cache
// TTL (Settings: Check cadence): the cache is fresh for exactly
// one tick, so a faster cadence fetches fresher prices and a
// slower cadence does not refetch on every read. A fetched
// reading is cached even when the evaluator later judges it
// implausible (the evaluator keeps lastPrice separately — see
// checkPriceRule — so a bad reading never becomes the
// baseline for the next one).
async function fetchPriceCached(sources, cadenceSeconds) {
  const src = (sources && sources.source1 && sources.source2) ? sources : { source1: 'coingecko', source2: 'coinbase' };
  const ttlMs = ((typeof cadenceSeconds === 'number' && Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) ? cadenceSeconds : CHECK_CADENCE_SECONDS_DEFAULT) * 1000;
  const nowMs = Date.now();
  const k1 = bitcoin.priceSourceKey(src.source1), k2 = bitcoin.priceSourceKey(src.source2);
  if (priceCache.fetchedAt && priceCache.source1Key === k1 && priceCache.source2Key === k2
      && priceCache.readings && Object.keys(priceCache.readings).length
      && (nowMs - new Date(priceCache.fetchedAt).getTime()) < ttlMs) {
    return priceCache.readings;
  }
  const readings = await bitcoin.fetchPriceReadings(src.source1, src.source2);
  priceCache = { readings, fetchedAt: new Date(nowMs).toISOString(), source1: src.source1, source2: src.source2, source1Key: k1, source2Key: k2 };
  return readings;
}

// The fee cache for the fee-market trigger (0.8.1): the economy
// fee from BOTH configured nodes (per endpoint, TTL = the check
// cadence — Settings: Check cadence, default 60 seconds) — the
// same cadence as the price cache, so the fee trigger is
// evaluated on data no older than one tick. This is separate
// from the hourly currentFeesCache (used by the fee verdict):
// the verdict only needs an hourly fee, but a trigger that
// should fire when fees drop needs to see the drop within a
// tick. The cache is keyed by the endpoint URLs — a settings
// change makes it stale, so the next read fetches the new nodes
// instead of serving the old ones. readings is
// { [label]: { endpoint, fee|null, source|null, error|null } }.
// A failed fetch does NOT throw — the readings carry the error
// per node, and the caller combines them (the primary node's
// fee decides, the secondary is only a fallback) via
// bitcoin.combineFeeReadings; no usable reading means 'unknown',
// never a fire.
let nodeFeeCache = { readings: null, fetchedAt: null, primary: null, secondary: null };

async function fetchNodeFeesCached(endpoints, cadenceSeconds) {
  const eps = (endpoints && endpoints.length) ? endpoints : bitcoin.endpointsFor({ primaryApiUrl: 'https://mempool.space', secondaryApiUrl: 'https://blockstream.info/api' });
  const primary = eps[0] ? eps[0].base : null;
  const secondary = eps[1] ? eps[1].base : null;
  const ttlMs = ((typeof cadenceSeconds === 'number' && Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) ? cadenceSeconds : CHECK_CADENCE_SECONDS_DEFAULT) * 1000;
  const nowMs = Date.now();
  if (nodeFeeCache.fetchedAt && nodeFeeCache.primary === primary && nodeFeeCache.secondary === secondary
      && nodeFeeCache.readings && Object.keys(nodeFeeCache.readings).length
      && (nowMs - new Date(nodeFeeCache.fetchedAt).getTime()) < ttlMs) {
    return nodeFeeCache.readings;
  }
  const readings = await bitcoin.fetchNodeFeeReadings(eps);
  nodeFeeCache = { readings, fetchedAt: new Date(nowMs).toISOString(), primary, secondary };
  return readings;
}

// The cached prices as served to the UI (GET /api/state) — the
// per-source readings, the consensus price (a single display
// number: the primary exchange's price when the two agree, the
// single valid one, or null), and the fetched-at timestamp.
// `agreementPct` is the configured agreement (Settings: Price
// agreement), so the displayed consensus uses the same rule as
// the trigger.
function priceCacheForState(agreementPct) {
  return {
    price: bitcoin.priceConsensus(priceCache.readings || {}, agreementPct),
    prices: priceCache.readings || {},
    fetchedAt: priceCache.fetchedAt,
    source1: priceCache.source1, source2: priceCache.source2,
  };
}

// The consolidated exchange status for the readiness card
// (0.8.0): one status for the configured price sources, so the
// readiness card shows it once instead of repeating it per
// price tx. OK = both responding and agreeing within the
// configured agreement; degraded = one source down
// (single-source mode); error = they disagree by more than the
// configured agreement or neither responds; not-tested = no
// readings yet (cache cold, or for different sources). Returns
// {status, detail, sources} — the detail is generic (no
// per-source prices); `sources` is one row per configured
// source, in configured order, each with its own status and
// last price (or error), so the readiness card can list them
// like the node rows. `pc` is the priceCacheForState() shape.
function exchangeStatusFor(pc, sources, agreementPct) {
  const ok = pc && pc.prices && Object.keys(pc.prices).length
    && bitcoin.priceSourceKey(pc.source1) === bitcoin.priceSourceKey(sources.source1)
    && bitcoin.priceSourceKey(pc.source2) === bitcoin.priceSourceKey(sources.source2);
  // One row per configured price source (in configured order).
  // A row is 'ok' when it has a price, 'error' when it has an
  // error (or no reading at all), and 'not-tested' while the
  // cache is cold or for different sources. Readings are keyed
  // by slot (source1/source2), and a custom source's label is
  // 'Custom' — the URL itself is never shown on the readiness
  // card.
  const rows = ['source1', 'source2'].map((slot) => {
    const src = sources[slot];
    const isCustom = src && typeof src === 'object' && src.id === 'custom';
    const label = isCustom ? 'Custom' : (bitcoin.priceProviderById(src) ? bitcoin.priceProviderById(src).label : String(src));
    const provider = isCustom ? 'custom' : String(src);
    if (!ok) return { provider, label, price: null, error: null, status: 'not-tested' };
    const r = pc.prices[slot] || null;
    if (!r) return { provider, label, price: null, error: 'No reading', status: 'error' };
    const price = typeof r.price === 'number' ? r.price : null;
    const error = r.error ? String(r.error) : null;
    return { provider, label, price, error, status: price != null ? 'ok' : 'error' };
  });
  if (!ok) return { status: 'not-tested', detail: 'No price readings yet', sources: rows };
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct : PRICE_AGREEMENT_PCT_DEFAULT;
  const comb = bitcoin.combinePriceReadings(pc.prices, agree);
  if (comb.mode === 'dual') return { status: 'ok', detail: 'Both price sources agree', sources: rows };
  if (comb.mode === 'single') return { status: 'degraded', detail: 'One price source down — running on a single source', sources: rows };
  if (comb.mode === 'disagree') return { status: 'error', detail: 'Price sources disagree by more than ' + agree + '%', sources: rows };
  return { status: 'error', detail: 'No price source responding', sources: rows };
}

// Refresh the price cache when it is stale and a price rule is
// armed (0.8.0): the 1-minute fast tick and the startup refresh
// call this, so a price rule's "currently $X" line stays fresh.
// Best-effort — a failed refresh never throws here; the cache just
// stays cold until the next tick, and the evaluator reports the
// trigger 'unknown' in the meantime.
async function refreshPriceIfStale() {
  try {
    const st = store.loadState(DATA_DIR);
    const hasPrice = (st.bitcoin.txs || []).some((t) => t.enabled && store.hasTriggerType(t, 'price'));
    if (!hasPrice) return;
    await fetchPriceCached(priceSourcesOf(st.settings), checkCadenceSecondsOf(st.settings));
  } catch (e) { console.error('price refresh failed:', e); }
}

// The triggerState shape (0.8.0, per-rule 0.8.2): tx.triggerState
// is an array parallel to the rules (index-keyed); every evaluation
// writes one rule's slice, with all of these fields, null when a
// field does not apply to the type — so the shape is stable across
// types and the UI can read it blind.
//   lastEvalAt — when the rule was last evaluated (ISO)
//   status / reason — the status word + the human-readable state
//   lastPrice / lastPriceAt — the last GOOD price reading (price only)
//   lastOutspend — { spent, confirmed, txid, checkedAt } (UTXO only)
//   lastError — the last fetch failure, if any (else null)
// ruleTriggerState(tx, i) reads one slice (null when the rule was
// never evaluated); setRuleTriggerState(tx, i, slice) writes one,
// growing the array with nulls when a legacy flat state is being
// normalized (loadState wraps it first, so this is defensive).
function freshTriggerState(now, status, reason) {
  return {
    lastEvalAt: now.toISOString(), status, reason,
    lastPrice: null, lastPriceAt: null, lastOutspend: null, lastError: null,
  };
}
function ruleTriggerState(tx, i) {
  const arr = (tx && Array.isArray(tx.triggerState)) ? tx.triggerState : null;
  if (!arr) return null;
  const s = arr[i];
  return (s && typeof s === 'object') ? s : null;
}
function setRuleTriggerState(tx, i, slice) {
  if (!tx) return;
  if (!Array.isArray(tx.triggerState)) tx.triggerState = [];
  while (tx.triggerState.length <= i) tx.triggerState.push(null);
  tx.triggerState[i] = slice;
}

// The check-in rule: the same clock as checkinStatus, at this
// rule's own threshold (a rule with a 7-day threshold fires on its
// own 7-day window, not the global 35). Pure clock math — no
// vacation handling here (the evaluator holds it; the gate ignores
// it — see evaluateRule / checkTriggerNow). The clock is measured
// with the tx's live freeze offset, so a frozen clock is never
// release-due while inactive.
function checkCheckinRule(state, rule, now, ctx) {
  const clock = checkinClock(state, now, rule.params.thresholdDays, ctx && ctx.liveOffsetMs);
  const detail = { daysSince: clock.daysSince, nextDue: clock.nextDue };
  if (clock.state === 'not-started') {
    return { fire: false, status: 'not-started', reason: 'No check-in recorded yet', slice: freshTriggerState(now, 'not-started', 'No check-in recorded yet'), detail, warning: null };
  }
  if (clock.state === 'held') {
    // No special grace display: the bar just shows the longer
    // held window ("40 of 52 days elapsed"), and the reason
    // reads the same — the hold still gates the release (no fire
    // while held), it just is not named on the card.
    return { fire: false, status: 'held', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', slice: freshTriggerState(now, 'held', clock.daysSince + ' of ' + clock.windowDays + ' days elapsed'), detail, warning: null };
  }
  if (clock.state === 'release-due') {
    return { fire: true, status: 'release-due', reason: 'Release due', slice: freshTriggerState(now, 'release-due', 'Release due'), detail, warning: 'This condition is already satisfied — it would fire on the next evaluation.' };
  }
  return { fire: false, status: 'on-track', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', slice: freshTriggerState(now, 'on-track', clock.daysSince + ' of ' + clock.windowDays + ' days elapsed'), detail, warning: null };
}

// The price trigger (0.8.0, two-source 0.8.0). The price is read
// from TWO providers (Settings: priceSources) and combined by
// bitcoin.combinePriceReadings: the reading is only trusted when
// the two agree within the configured agreement (Settings: Price
// agreement); when they agree, the PRIMARY exchange's price is
// the one that decides (the secondary is only a fallback); when
// only one source answers, that price is used alone (no
// agreement check).
// Guards, in order:
//   (a) Immediate fire: the EFFECTIVE price crossing the
//       threshold (at/above, or at/below) fires at once — no
//       sustained wait. The protection against a bad reading is
//       the two-source agreement (below), not a time delay.
//   (b) Fail-safe: a reading that is not valid — the sources
//       disagree by more than the configured agreement, or
//       neither answers — does not fire, marks 'unknown', and
//       keeps the last good state (so a bad reading cannot
//       become the baseline for the jump
//       guard).
//   (c) Sanity bounds on the READING: a price outside
//       $1–$100,000,000 is bad data, not a market move — do not
//       fire on it, and do not let it become the baseline for the
//       jump guard (lastPrice keeps the last GOOD reading). The
//       provider fetch already refuses out-of-bounds prices; this
//       is the safety net on the effective price.
//   (d) The 10x-jump guard: a price that moved 10x since the last
//       GOOD reading is a bad feed, not a market move — but only
//       when the last reading is recent (within an hour). Over a
//       longer gap a real 10x move is possible (the app was off
//       for months), so an old baseline does not veto a new price.
async function checkPriceRule(state, rule, now, ctx) {
  const p = rule.params;
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // The last GOOD state, kept across unknown readings (fail-safe):
  // a disagreement or outage never fires the rule.
  const keepGood = {
    lastPrice: (typeof prev.lastPrice === 'number' && Number.isFinite(prev.lastPrice)) ? prev.lastPrice : null,
    lastPriceAt: (typeof prev.lastPriceAt === 'string' && prev.lastPriceAt) ? prev.lastPriceAt : null,
  };
  let readings;
  try { readings = await fetchPriceCached(priceSourcesOf(state.settings), checkCadenceSecondsOf(state.settings)); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'price unavailable — will retry',
      slice: {
        ...freshTriggerState(now, 'unknown', 'price unavailable — will retry'),
        ...keepGood, lastError: e.message, priceMode: 'none', priceNote: '',
      },
      detail: { error: e.message }, warning: null,
    };
  }
  const comb = bitcoin.combinePriceReadings(readings, priceAgreementPctOf(state.settings));
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: {
        ...freshTriggerState(now, 'unknown', comb.reason),
        ...keepGood, lastError: comb.reason, priceMode: comb.mode, priceNote: '',
      },
      detail: { mode: comb.mode, readings: comb.readings }, warning: null,
    };
  }
  const price = comb.price;
  if (price < store.PRICE_MIN_USD || price > store.PRICE_MAX_USD) {
    return {
      fire: false, status: 'unknown', reason: 'implausible price reading ($' + price.toLocaleString('en-US') + ') — ignored',
      slice: {
        ...freshTriggerState(now, 'unknown', 'implausible price reading ($' + price.toLocaleString('en-US') + ') — ignored'),
        ...keepGood, lastError: 'price out of bounds: $' + price.toLocaleString('en-US'), priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode }, warning: null,
    };
  }
  const lastPrice = keepGood.lastPrice;
  const lastAt = (typeof keepGood.lastPriceAt === 'string' && keepGood.lastPriceAt) ? new Date(keepGood.lastPriceAt).getTime() : NaN;
  if (lastPrice !== null && Number.isFinite(lastAt) && (now.getTime() - lastAt) <= PRICE_JUMP_WINDOW_MS
      && (price > lastPrice * 10 || price < lastPrice / 10)) {
    return {
      fire: false, status: 'unknown', reason: 'implausible price jump ($' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US') + ') — ignored',
      slice: {
        ...freshTriggerState(now, 'unknown', 'implausible price jump ($' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US') + ') — ignored'),
        ...keepGood, lastError: 'price jumped 10x since the last reading: $' + lastPrice.toLocaleString('en-US') + ' → $' + price.toLocaleString('en-US'), priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode }, warning: null,
    };
  }
  // The reading is good: it becomes the new baseline.
  const holding = p.op === '>=' ? price >= p.value : price <= p.value;
  // The stored reason is trigger-only — the effective price, no
  // per-source note (that lives in priceNote as data, and in the
  // Exchange Status section and dry-run notes for display). The
  // GATE's reason (gateReason) keeps the note — the /api/triggers/check
  // answer names the sources it read ("currently $100,000 (Custom
  // $100,000, Coinbase $98,200)"), as it always has.
  const shown = '$' + price.toLocaleString('en-US');
  const gateShown = 'currently ' + shown + ' (' + comb.note + ')';
  if (!holding) {
    return {
      fire: false, status: 'watching', reason: 'currently ' + shown, gateReason: gateShown,
      slice: {
        ...freshTriggerState(now, 'watching', 'currently ' + shown),
        lastPrice: price, lastPriceAt: now.toISOString(), lastError: null, priceMode: comb.mode, priceNote: comb.note,
      },
      detail: { price, mode: comb.mode, note: comb.note }, warning: null,
    };
  }
  // Holding: the effective price is past the threshold and both
  // sources agree — fire at once, no sustained wait.
  return {
    fire: true, status: 'due', reason: 'past threshold — firing', gateReason: gateShown,
    slice: {
      ...freshTriggerState(now, 'due', 'past threshold — firing'),
      lastPrice: price, lastPriceAt: now.toISOString(), lastError: null, priceMode: comb.mode, priceNote: comb.note,
    },
    detail: { price, mode: comb.mode, note: comb.note },
    warning: 'This condition is already satisfied — it would fire on the next evaluation.',
  };
}

// The UTXO trigger (0.8.0). The confirmation mode is per-rule
// (params.confirmations): 0 = fire on an unconfirmed (mempool)
// spend; N >= 1 = fire once the spending tx has N confirmations
// (default 1 — confirmed-only, the original behaviour). Guards:
//   (a) Unconfirmed mode fires on ANY spend — confirmed or not.
//       N-confirmation mode only watches an unconfirmed spend
//       (it may still be evicted or replaced).
//   (b) Confirmations are counted from the tip (tip - spend
//       block height + 1). If the tip cannot be fetched, or the
//       spend's block height is unknown, the trigger is 'unknown'
//       — it never fires on data it cannot count.
//   (c) Fail-safe on fetch failure: an outpoint no endpoint can
//       say about (unknown parent, or no endpoint answering) does
//       not fire, and is marked 'unknown'.
//   (d) The already-spent guard at creation is the add-time gate
//       (see POST /api/bitcoin/txs) and the /api/triggers/check
//       endpoint — not this evaluator.
async function checkUtxoRule(state, rule, now, ctx) {
  const needConfs = (rule.params.confirmations === 0) ? 0 : (rule.params.confirmations || 1);
  const endpoints = bitcoin.endpointsFor(state.settings);
  let res;
  try { res = await bitcoin.checkOutspend(rule.params.outpoint, endpoints); }
  catch (e) { res = { unknown: true, error: e.message }; }
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  if (res.unknown) {
    return {
      fire: false, status: 'unknown', reason: 'could not check the outpoint — will retry',
      slice: {
        ...freshTriggerState(now, 'unknown', 'could not check the outpoint — will retry'),
        lastOutspend: (prev.lastOutspend && typeof prev.lastOutspend === 'object') ? prev.lastOutspend : null,
        lastError: res.error || 'outpoint could not be checked',
      },
      detail: { error: res.error || null }, warning: null,
    };
  }
  const lastOutspend = { spent: res.spent, confirmed: res.confirmed, txid: res.txid || null, blockHeight: (res.blockHeight === undefined ? null : res.blockHeight), confirmations: null, checkedAt: now.toISOString() };
  if (!res.spent) {
    return {
      fire: false, status: 'watching', reason: 'still unspent',
      slice: { ...freshTriggerState(now, 'watching', 'still unspent'), lastOutspend, lastError: null },
      detail: { spent: false, confirmed: false }, warning: null,
    };
  }
  // Spent. Unconfirmed mode (0) fires on any spend, confirmed or
  // not — the owner chose the mempool as the trigger.
  if (needConfs === 0) {
    return {
      fire: true, status: 'due', reason: 'spent — firing',
      slice: { ...freshTriggerState(now, 'due', 'spent — firing'), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: res.confirmed, txid: res.txid, confirmations: 0 },
      warning: 'This UTXO is already spent — it would fire on the next evaluation.',
    };
  }
  // N-confirmation mode: an unconfirmed spend only watches.
  if (!res.confirmed) {
    lastOutspend.confirmations = 0;
    const noun = needConfs === 1 ? ' confirmation' : ' confirmations';
    return {
      fire: false, status: 'watching', reason: 'spend unconfirmed — waiting for ' + needConfs + noun,
      slice: { ...freshTriggerState(now, 'watching', 'spend unconfirmed — waiting for ' + needConfs + noun), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: false, txid: res.txid, confirmations: 0 },
      warning: 'This UTXO is already spent (unconfirmed) — it would fire once the spend reaches ' + needConfs + noun + '.',
    };
  }
  // A confirmed spend: count its confirmations from the tip.
  if (res.blockHeight === null || res.blockHeight === undefined || !Number.isFinite(res.blockHeight)) {
    return {
      fire: false, status: 'unknown', reason: 'spend confirmed but its block height is unknown — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'spend confirmed but its block height is unknown — will retry'), lastOutspend, lastError: 'spend block height unknown' },
      detail: { spent: true, confirmed: true, txid: res.txid }, warning: null,
    };
  }
  let tip;
  try { tip = await bitcoin.getTipHeight(endpoints); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'could not fetch the tip height — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'could not fetch the tip height — will retry'), lastOutspend, lastError: e.message },
      detail: { spent: true, confirmed: true, txid: res.txid, error: e.message }, warning: null,
    };
  }
  const confs = Math.max(0, tip - res.blockHeight + 1);
  lastOutspend.confirmations = confs;
  if (confs >= needConfs) {
    return {
      fire: true, status: 'due', reason: 'spent — ' + confs + (confs === 1 ? ' confirmation' : ' confirmations') + ' — firing',
      slice: { ...freshTriggerState(now, 'due', 'spent — ' + confs + (confs === 1 ? ' confirmation' : ' confirmations') + ' — firing'), lastOutspend, lastError: null },
      detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight },
      warning: 'This UTXO is already spent (' + confs + ' confirmations) — it would fire on the next evaluation.',
    };
  }
  return {
    fire: false, status: 'watching', reason: 'spent — ' + confs + ' of ' + needConfs + ' confirmations',
    slice: { ...freshTriggerState(now, 'watching', 'spent — ' + confs + ' of ' + needConfs + ' confirmations'), lastOutspend, lastError: null },
    detail: { spent: true, confirmed: true, txid: res.txid, confirmations: confs, blockHeight: res.blockHeight }, warning: null,
  };
}

// The block-height trigger (0.8.1). Fires when the chain tip
// reaches params.targetHeight — the PRIMARY node's tip is the one
// that counts (the secondary is only a fallback if the primary
// does not answer; a node a block or two ahead is normal
// propagation lag). Deterministic: the tip height comes from
// the nodes' own chains, and a reorg cannot un-fire it — once the
// tip has reached the height, the rule has fired (the release is
// one-shot; a later reorg does not retract a broadcast). Fail-safe:
// if neither node answers, the trigger is 'unknown' — it never
// fires on data it cannot read. No grace period: the tip height is
// the chain's own state, not a feed that can go stale — an offline
// gap that ends past the height means the height was genuinely reached.
async function checkBlockHeightRule(state, rule, now, ctx) {
  const target = rule.params.targetHeight;
  // (0.8.1, audit finding 1) One-way latch: once the chain has been
  // observed at or past the target, the rule has fired — a later
  // reorg that drops the tip below the target, or a node outage,
  // cannot un-fire it. Without this, a broadcast that failed while
  // the tip was past the target would never be retried after a
  // reorg, because the next evaluation would say 'watching'. The
  // latch is keyed to the target height, so editing the rule to a
  // different height starts fresh (the edit path also clears
  // triggerState on a trigger change). The latch arrives in
  // ctx.latchedTarget — the evaluator reads it from the rule's
  // stored slice, the gate from the tx being edited.
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  const latchedTarget = (ctx && typeof ctx.latchedTarget === 'number') ? ctx.latchedTarget : null;
  if (latchedTarget === target) {
    return {
      fire: true, status: 'due', reason: 'block ' + target.toLocaleString('en-US') + ' reached — firing',
      slice: { ...freshTriggerState(now, 'due', 'block ' + target.toLocaleString('en-US') + ' reached — firing'), lastTipHeight: (typeof prev.lastTipHeight === 'number' ? prev.lastTipHeight : target), lastError: null, heightReachedFor: target },
      detail: { tip: null, targetHeight: target, latched: true },
      warning: 'This height has already been reached — it would fire on the next evaluation.',
    };
  }
  const endpoints = bitcoin.endpointsFor(state.settings);
  let comb;
  try { comb = bitcoin.combineTipHeights(await bitcoin.fetchTipHeights(endpoints)); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'could not fetch the tip height — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'could not fetch the tip height — will retry'), lastError: e.message },
      detail: { error: e.message }, warning: null,
    };
  }
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: { ...freshTriggerState(now, 'unknown', comb.reason), lastError: comb.reason },
      detail: { error: comb.reason }, warning: null,
    };
  }
  const tip = comb.tip;
  if (typeof tip !== 'number' || !Number.isFinite(tip) || tip < 0) {
    return {
      fire: false, status: 'unknown', reason: 'tip height unreadable — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'tip height unreadable — will retry'), lastError: 'tip height is not a number: ' + String(tip) },
      detail: { tip: String(tip) }, warning: null,
    };
  }
  if (tip >= target) {
    return {
      fire: true, status: 'due', reason: 'block ' + tip.toLocaleString('en-US') + ' reached — firing',
      slice: { ...freshTriggerState(now, 'due', 'block ' + tip.toLocaleString('en-US') + ' reached — firing'), lastTipHeight: tip, lastError: null, heightReachedFor: target },
      detail: { tip, targetHeight: target },
      warning: 'This height has already been reached — it would fire on the next evaluation.',
    };
  }
  return {
    fire: false, status: 'watching', reason: 'block ' + tip.toLocaleString('en-US') + ' of ' + target.toLocaleString('en-US'),
    slice: { ...freshTriggerState(now, 'watching', 'block ' + tip.toLocaleString('en-US') + ' of ' + target.toLocaleString('en-US')), lastTipHeight: tip, lastError: null },
    detail: { tip, targetHeight: target }, warning: null,
  };
}

// The set-date trigger (0.8.1). Fires when the wall clock
// reaches params.fireAt — a pure deadline, regardless of
// check-ins. No network call, so it cannot be 'unknown' except
// on a malformed date (which validation prevents). No grace
// period: the clock is the clock — an offline gap that ends
// past the date means the date genuinely passed. The
// "fire unless I check in" snooze variant is a later addition,
// not this rule.
function checkSetDateRule(state, rule, now, ctx) {
  const fireMs = Date.parse(rule.params.fireAt);
  if (!Number.isFinite(fireMs)) {
    return {
      fire: false, status: 'unknown', reason: 'set date is not a valid date — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'set date is not a valid date — will retry'), lastError: 'fireAt is not a valid date: ' + String(rule.params.fireAt) },
      detail: { fireAt: String(rule.params.fireAt) }, warning: null,
    };
  }
  if (now.getTime() >= fireMs) {
    return {
      fire: true, status: 'due', reason: 'date reached — firing',
      slice: { ...freshTriggerState(now, 'due', 'date reached — firing'), lastError: null },
      detail: { fireAt: rule.params.fireAt },
      warning: 'This date has already passed — it would fire on the next evaluation.',
    };
  }
  const d = new Date(fireMs);
  const shown = d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return {
    fire: false, status: 'watching', reason: 'fires on ' + shown,
    slice: { ...freshTriggerState(now, 'watching', 'fires on ' + shown), lastError: null },
    detail: { fireAt: rule.params.fireAt }, warning: null,
  };
}

// The fee-market trigger (0.8.1). Fires when the economy fee
// rate crosses params.maxFeeRate (sat/vB) in the direction the
// owner chose: 'below' fires when the fee falls to or below it,
// 'above' fires when it rises to or above it. The threshold is
// user-set; the tx's own fee rate is not consulted — the rule
// fires on the market rate alone. The fee comes from BOTH
// configured nodes (combineFeeReadings) but NO agreement check:
// the PRIMARY node's fee is the one that counts — the secondary
// is only a fallback if the primary is down. One node down means
// the other is used alone, with no agreement check. No 10x-jump
// guard: fee spikes are real and are exactly what an 'above' rule
// is for — the guard would block the trigger from doing its job.
// The fee comes from the cached fetch (TTL = the check cadence),
// so the trigger sees a move within a tick. Fail-safe: if no
// usable fee can be read, the trigger is 'unknown' — it never
// fires on data it cannot read. No grace period: the fee is a
// live market reading, not a feed that can go stale in the
// price-trigger sense — an offline gap that ends in a low-fee
// market means fees genuinely are low.
async function checkFeeMarketRule(state, rule, now, ctx) {
  const maxRate = rule.params.maxFeeRate;
  const dir = rule.params.direction === 'above' ? 'above' : 'below';
  const prev = (ctx && ctx.prevSlice && typeof ctx.prevSlice === 'object') ? ctx.prevSlice : {};
  // The last GOOD fee, kept across unknown readings (fail-safe):
  // a disagreement or outage never fires the rule, and the
  // subcard keeps showing the last fee it could trust.
  const keepGood = {
    lastEconomyFee: (typeof prev.lastEconomyFee === 'number' && Number.isFinite(prev.lastEconomyFee)) ? prev.lastEconomyFee : null,
  };
  let readings;
  try { readings = await fetchNodeFeesCached(bitcoin.endpointsFor(state.settings), checkCadenceSecondsOf(state.settings)); }
  catch (e) {
    return {
      fire: false, status: 'unknown', reason: 'fee unavailable — will retry',
      slice: { ...freshTriggerState(now, 'unknown', 'fee unavailable — will retry'), ...keepGood, lastError: e.message, feeMode: 'none', feeNote: '' },
      detail: { error: e.message }, warning: null,
    };
  }
  const comb = bitcoin.combineFeeReadings(readings);
  if (!comb.valid) {
    return {
      fire: false, status: 'unknown', reason: comb.reason,
      slice: { ...freshTriggerState(now, 'unknown', comb.reason), ...keepGood, lastError: comb.reason, feeMode: comb.mode, feeNote: '' },
      detail: { mode: comb.mode, error: comb.reason }, warning: null,
    };
  }
  const econ = comb.fee;
  const fired = dir === 'above' ? econ >= maxRate : econ <= maxRate;
  if (fired) {
    return {
      fire: true, status: 'due', reason: 'economy fee ' + econ + ' sat/vB — firing',
      slice: { ...freshTriggerState(now, 'due', 'economy fee ' + econ + ' sat/vB — firing'), lastEconomyFee: econ, lastError: null, feeMode: comb.mode, feeNote: comb.note },
      detail: { economyFee: econ, maxFeeRate: maxRate, direction: dir },
      warning: 'The economy fee is already at or ' + dir + ' your threshold — it would fire on the next evaluation.',
    };
  }
  const side = dir === 'above' ? 'below ' : 'above ';
  return {
    fire: false, status: 'watching', reason: 'economy fee ' + econ + ' sat/vB (' + side + maxRate + ')',
    slice: { ...freshTriggerState(now, 'watching', 'economy fee ' + econ + ' sat/vB (' + side + maxRate + ')'), lastEconomyFee: econ, lastError: null, feeMode: comb.mode, feeNote: comb.note },
    detail: { economyFee: econ, maxFeeRate: maxRate, direction: dir }, warning: null,
  };
}

// Dispatch by rule type. Returns the check function's result
// { fire, status, reason, slice, detail, warning } — no state is
// written here (the caller stores the slice). The manual rule never
// fires — the owner broadcasts it by hand.
async function checkRule(state, rule, now, ctx) {
  switch (rule.type) {
    case 'checkin': return checkCheckinRule(state, rule, now, ctx);
    case 'price': return await checkPriceRule(state, rule, now, ctx);
    case 'utxo': return await checkUtxoRule(state, rule, now, ctx);
    case 'blockheight': return await checkBlockHeightRule(state, rule, now, ctx);
    case 'setdate': return checkSetDateRule(state, rule, now, ctx);
    case 'feemarket': return await checkFeeMarketRule(state, rule, now, ctx);
    case 'manual': return checkManualRule(state, rule, now, ctx);
    default: return checkCheckinRule(state, rule, now, ctx);
  }
}

function checkManualRule(state, rule, now, ctx) {
  return {
    fire: false, status: 'manual', reason: 'Waiting for manual broadcast',
    slice: freshTriggerState(now, 'manual', 'Waiting for manual broadcast'),
    detail: {}, warning: null,
  };
}

// Evaluate ONE rule of a tx, applying the evaluator-only holds,
// and write the rule's triggerState slice when the check produces
// one. Returns { rule, fire, status, reason, held, slice } — held
// is null | 'grace' | 'vacation'.
//   Grace (0.8.0): while it is active, a price or UTXO rule is not
//     evaluated at all — it cannot fire, and its stored slice keeps
//     the last real evaluation (so the subcard's current-state line
//     still shows the live condition; only the pill says Grace).
//     No network calls happen for it during the grace. The
//     release-check result carries status 'grace' so the hold is
//     named there. Grace is PER RULE: in an OR set a non-held rule
//     can still fire during a grace; in an AND set a held rule is
//     not satisfied, so the set cannot fire.
//   Vacation (0.8.0): while it is on, a check-in rule does not
//     fire — its slice records 'vacation', and the release holds
//     it. Vacation touches check-in rules only; price, UTXO and
//     the other rules keep firing. Vacation is PER RULE too: an OR
//     set can still fire via a non-check-in rule while on vacation.
async function evaluateRule(state, tx, ruleIndex, now) {
  const set = store.triggerOf(tx);
  const rule = set.rules[ruleIndex];
  const prevSlice = ruleTriggerState(tx, ruleIndex);
  if ((rule.type === 'price' || rule.type === 'utxo') && isGraceActive(state, now)) {
    return { rule, fire: false, status: 'grace', reason: 'grace period active — will evaluate when it ends', held: 'grace', slice: null };
  }
  if (rule.type === 'checkin' && state.settings.vacationMode) {
    const slice = freshTriggerState(now, 'vacation', 'Vacation mode is on');
    setRuleTriggerState(tx, ruleIndex, slice);
    return { rule, fire: false, status: 'vacation', reason: 'Vacation mode is on', held: 'vacation', slice };
  }
  const r = await checkRule(state, rule, now, {
    prevSlice,
    liveOffsetMs: checkinLiveOffsetMs(tx, now),
    latchedTarget: (prevSlice && typeof prevSlice.heightReachedFor === 'number') ? prevSlice.heightReachedFor : null,
  });
  if (r.slice) setRuleTriggerState(tx, ruleIndex, r.slice);
  return { rule, fire: r.fire, status: r.status, reason: r.reason, held: null, slice: r.slice || null };
}

// Combine the per-rule outcomes by the set's op. Each outcome is
// { index, fire, status, reason, held, skipped, cls } — cls is the
// outcome class: 'satisfied' (the rule fired), 'not' (it did not,
// and was read), 'unknown' (it could not be read — fail-safe), or
// 'held' (grace / vacation / offline-hold — read, but held back).
// `skipped` means the rule was not evaluated this tick. No caller
// skips any more (0.8.2 — the type filter is gone, the full tick
// evaluates everything); the class is kept as a defensive reading:
// a skipped rule is not satisfied, so an AND set cannot fire on a
// tick that did not evaluate all of it, while an OR set only needs
// one evaluated rule to fire.
//   OR: fire iff any evaluated rule is SATISFIED; unknowns are
//     ignored — a setdate rule still fires while its sibling price
//     rule cannot be read.
//   AND: fire iff EVERY rule is SATISFIED at this same tick —
//     "all at once" (Ryan, Nov 18), no per-rule latching (the
//     block-height latch is that rule type's own one-way semantics,
//     not latching). Any UNKNOWN, HELD, or SKIPPED rule blocks it.
// The combined status is the tx-level word: a one-rule set reads
// exactly as its single rule did ('on-track', 'grace', 'due',
// ...); a multi-rule set reads 'due' | 'unknown' | 'grace' |
// 'vacation' | 'held' | 'watching' (unknown beats held — a rule
// that cannot be read is the more urgent fact).
// Returns { fire, status, reason, firedIndexes } — firedIndexes
// are the rule indexes that fired, so the history event can name
// them.
function combineOutcomes(set, outcomes) {
  const evaluated = outcomes.filter((o) => !o.skipped);
  const fired = evaluated.filter((o) => o.cls === 'satisfied');
  const firedIndexes = fired.map((o) => o.index);
  let fire = false;
  if (set.op === 'OR') fire = fired.length > 0;
  else fire = evaluated.length === set.rules.length && evaluated.every((o) => o.cls === 'satisfied');
  if (set.rules.length === 1) {
    const o = outcomes[0];
    return { fire: o.fire, status: o.status, reason: o.reason, firedIndexes: o.fire ? [0] : [] };
  }
  let status, reason;
  if (fire) {
    status = 'due';
    reason = fired.map((o) => o.reason).join(' + ');
  } else if (evaluated.some((o) => o.cls === 'unknown')) {
    const u = evaluated.find((o) => o.cls === 'unknown');
    status = 'unknown';
    reason = u.reason;
  } else if (evaluated.some((o) => o.held === 'grace')) {
    status = 'grace';
    reason = 'grace period active — will evaluate when it ends';
  } else if (evaluated.some((o) => o.held === 'vacation')) {
    status = 'vacation';
    reason = 'Vacation mode is on';
  } else if (evaluated.some((o) => o.held === 'held')) {
    const h = evaluated.find((o) => o.held === 'held');
    status = 'held';
    reason = h.reason;
  } else {
    status = 'watching';
    reason = evaluated.map((o) => o.reason).join('; ');
  }
  return { fire, status, reason, firedIndexes };
}

// The outcome class of one evaluated rule: 'satisfied' when it
// fired, 'unknown' when it could not be read, 'held' when a hold
// kept it from firing, else 'not'.
function outcomeClass(r) {
  if (r.fire) return 'satisfied';
  if (r.status === 'unknown') return 'unknown';
  if (r.held) return 'held';
  return 'not';
}

// Evaluate a tx's whole rule set (0.8.2). Returns { fire, status,
// reason, ruleResults, firedIndexes } and writes each evaluated
// rule's triggerState slice (the caller saves). Every rule is
// evaluated, every time — there is no type filter any more
// (0.8.2): the full tick judges all types together, so an AND
// set spanning domains (check-in AND price) fires on the tick,
// not only on a manual check. That is what "all at once" needs:
// a tick that did not evaluate a rule cannot claim it held, and
// now every tick evaluates every rule.
async function evaluateTrigger(state, tx, now) {
  const set = store.triggerOf(tx);
  const ruleResults = [];
  for (let i = 0; i < set.rules.length; i++) {
    const rule = set.rules[i];
    const r = await evaluateRule(state, tx, i, now);
    ruleResults.push({ index: i, rule, fire: r.fire, status: r.status, reason: r.reason, held: r.held, skipped: false, cls: outcomeClass(r), slice: r.slice });
  }
  const combined = combineOutcomes(set, ruleResults);
  return {
    fire: combined.fire, status: combined.status, reason: combined.reason,
    ruleResults, firedIndexes: combined.firedIndexes,
    firedRuleTypes: combined.firedIndexes.map((i) => set.rules[i].type),
  };
}

// One rule's UI-facing status, computed from its STORED slice (no
// network) — except the check-in rule, whose state is live clock
// math. Returns { type, label, condition, status, reason,
// ...type-specific fields }. The price's "currently $X" line uses
// the cached price when one is available (it is fresher than the
// stored reading). `slice` is the rule's triggerState slice (null
// when it has never been evaluated).
function ruleStatusFor(state, tx, rule, slice, now) {
  const trg = rule;
  const st = slice;
  const base = { type: trg.type, label: triggerLabel(trg), condition: singleTriggerConditionText(trg) };
  if (trg.type === 'checkin') {
    const clock = checkinClock(state, now, trg.params.thresholdDays, checkinLiveOffsetMs(tx, now));
    if (clock.state === 'not-started') return { ...base, status: 'not-started', reason: 'No check-in recorded yet' };
    // Vacation is check-in-only (0.8.0): it freezes this tx's
    // clock and holds its release, and nothing else's.
    if (state.settings.vacationMode) return { ...base, status: 'vacation', reason: 'Vacation mode is on — the countdown is frozen' };
    if (clock.state === 'held') return { ...base, status: 'held', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
    if (clock.state === 'release-due') return { ...base, status: 'release-due', reason: 'Release due', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
    return { ...base, status: 'on-track', reason: clock.daysSince + ' of ' + clock.windowDays + ' days elapsed', daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue };
  }
  if (trg.type === 'manual') {
    return { ...base, status: 'manual', reason: 'Waiting for manual broadcast' };
  }
  if (trg.type === 'price') {
    // The cached readings (when they are for the currently
    // configured sources) give the live effective price + source
    // note; otherwise the stored last evaluation carries the
    // price and its note.
    const src = priceSourcesOf(state.settings);
    const cacheOk = priceCache.readings && Object.keys(priceCache.readings).length
      && priceCache.source1Key === bitcoin.priceSourceKey(src.source1) && priceCache.source2Key === bitcoin.priceSourceKey(src.source2);
    let price = null, note = '', mode = null;
    if (cacheOk) {
      const comb = bitcoin.combinePriceReadings(priceCache.readings, priceAgreementPctOf(state.settings));
      if (comb.valid) { price = comb.price; note = comb.note; mode = comb.mode; }
      else {
        // The latest fetch says the reading is not valid (the
        // sources disagree, or neither answers) — the card shows
        // unknown, whatever the last evaluation said. The reason
        // stays generic ('price feed unknown'): the source detail
        // lives in the Exchange Status section and the dry-run
        // notes, not on a per-tx line.
        return { ...base, status: 'unknown', reason: 'price feed unknown', lastPrice: null, priceMode: comb.mode, priceNote: '' };
      }
    }
    const stored = (st && typeof st.lastPrice === 'number' && Number.isFinite(st.lastPrice)) ? st.lastPrice : null;
    const storedNote = (st && typeof st.priceNote === 'string' && st.priceNote) ? st.priceNote : '';
    if (price === null) {
      if (stored === null) {
        if (st && st.status === 'unknown') return { ...base, status: 'unknown', reason: 'price feed unknown', lastPrice: null, priceMode: (st && st.priceMode) || null, priceNote: storedNote };
        return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastPrice: null };
      }
      price = stored; note = storedNote; mode = (st && st.priceMode) || null;
    }
    // The reason is trigger-only — the effective price, no
    // per-source note. The source detail lives in the Exchange
    // Status section (readiness card) and the dry-run notes, not
    // on a per-tx line. The subcard reads lastPrice directly.
    // A holding price is due at once — no sustained wait (the
    // two-source agreement is the guard, not a time delay).
    const shown = '$' + price.toLocaleString('en-US');
    const holding = trg.params.op === '>=' ? price >= trg.params.value : price <= trg.params.value;
    if (!holding) return { ...base, status: 'watching', reason: 'currently ' + shown, lastPrice: price, priceMode: mode, priceNote: note };
    return { ...base, status: 'due', reason: 'past threshold — firing', lastPrice: price, priceMode: mode, priceNote: note };
  }
  if (trg.type === 'utxo') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastOutspend: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'still unspent', lastOutspend: st.lastOutspend || null };
  }
  if (trg.type === 'blockheight') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastTipHeight: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for the height', lastTipHeight: (typeof st.lastTipHeight === 'number' ? st.lastTipHeight : null) };
  }
  if (trg.type === 'setdate') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet' };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for the date' };
  }
  if (trg.type === 'feemarket') {
    if (!st) return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet', lastEconomyFee: null };
    return { ...base, status: st.status || 'watching', reason: st.reason || 'waiting for fees to fall', lastEconomyFee: (typeof st.lastEconomyFee === 'number' ? st.lastEconomyFee : null) };
  }
  return { ...base, status: 'not-evaluated', reason: 'Not evaluated yet' };
}

// The tx-level trigger status for the UI (0.8.2): a one-rule set
// reads exactly as its single rule did (the object above); a
// multi-rule set reads the same combine as the evaluator — 'due'
// when the set would fire, 'unknown' when a rule cannot be read,
// 'grace' / 'vacation' / 'held' when a hold is the thing stopping
// it, else 'watching' — with one status object per rule under
// `rules`, so the card can list them. A rule never evaluated reads
// 'not-evaluated', which the combine treats as unknown (fail-safe:
// the set cannot be proven satisfied or not).
function triggerStatusFor(state, tx, now) {
  const set = store.triggerOf(tx);
  const statuses = set.rules.map((rule, i) => ruleStatusFor(state, tx, rule, ruleTriggerState(tx, i), now));
  if (set.rules.length === 1) return statuses[0];
  const outcomes = statuses.map((s, i) => {
    const held = s.status === 'grace' ? 'grace' : s.status === 'vacation' ? 'vacation' : s.status === 'held' ? 'held' : null;
    const cls = (s.status === 'due' || s.status === 'release-due') ? 'satisfied'
      : (s.status === 'unknown' || s.status === 'not-evaluated') ? 'unknown'
      : held ? 'held' : 'not';
    return { index: i, rule: set.rules[i], fire: cls === 'satisfied', status: s.status, reason: s.reason, held, skipped: false, cls };
  });
  const combined = combineOutcomes(set, outcomes);
  return {
    type: 'ruleset', op: set.op,
    label: set.op === 'AND' ? 'AND rules' : 'OR rules',
    condition: triggerConditionText(set),
    status: combined.status, reason: combined.reason,
    rules: statuses,
  };
}

// Evaluate a rule set ONCE, live, without changing any state
// (0.8.0, unified 0.8.2): the POST /api/triggers/check endpoint
// (the UI's already-true guard) and the add-time warning use this.
// `trgSet` is a NORMALIZED rule set (the caller validates first —
// a single rule is already wrapped as a one-rule set).
// Returns { valid, fire, status, reason, warning, detail } —
// `warning` is a human-readable string when the set is already
// satisfied (it would fire on the next evaluation), else the first
// per-rule warning (an unconfirmed UTXO spend warns without
// firing), else null. A price rule reports fire=true when both
// sources agree the price is already past the threshold — there is
// no sustained wait, so a single live sample that both sources
// agree on proves the condition. The 10x-jump guard does not apply
// here (it needs a stored baseline — the evaluator owns it); only
// the absolute bounds are checked.
// The gate answers the RAW condition: no grace, no vacation, no
// disarm. A price rule that is past its threshold during a grace,
// or a check-in rule that is due during vacation, still reports
// fire=true — the hold is temporary and the condition itself is
// already met, so adding the rule would fire on the next evaluation
// once the hold lifts. That is the gate's conservative block, and
// it is deliberate: the evaluator (evaluateRule) is the only path
// that applies the holds. `ctx` is { liveOffsetMs, latchedTargets }:
// the tx's frozen time for a check-in rule (a txId the caller
// passes), and one latched block height per rule (0.8.1, audit
// finding 1) — a latched rule fires even if the tip has since
// reorged below it; the add/edit gates pass none (a new rule has
// no latch). A one-rule set answers exactly as its single rule
// did (same status / reason / warning / detail); a multi-rule set
// answers the combined fire with the per-rule results in
// detail.rules.
async function checkTriggerNow(trgSet, state, now, ctx) {
  const set = toTriggerSet(trgSet);
  const liveOff = (ctx && typeof ctx.liveOffsetMs === 'number' && Number.isFinite(ctx.liveOffsetMs)) ? ctx.liveOffsetMs : 0;
  const latched = (ctx && Array.isArray(ctx.latchedTargets)) ? ctx.latchedTargets : [];
  const ruleResults = [];
  for (let i = 0; i < set.rules.length; i++) {
    const rule = set.rules[i];
    const r = await checkRule(state, rule, now, {
      prevSlice: null,
      liveOffsetMs: liveOff,
      latchedTarget: (typeof latched[i] === 'number') ? latched[i] : null,
    });
    ruleResults.push({
      index: i, rule, fire: r.fire, status: r.status,
      reason: (typeof r.gateReason === 'string' && r.gateReason) ? r.gateReason : r.reason,
      detail: r.detail || {}, warning: r.warning || null,
      held: null, skipped: false, cls: r.fire ? 'satisfied' : (r.status === 'unknown' ? 'unknown' : 'not'),
    });
  }
  const combined = combineOutcomes(set, ruleResults);
  let warning = null;
  if (set.rules.length === 1) {
    warning = ruleResults[0].warning;
  } else if (combined.fire) {
    warning = 'This rule set is already satisfied — it would fire on the next evaluation.';
  } else {
    const w = ruleResults.find((r) => r.warning);
    warning = w ? w.warning : null;
  }
  const detail = set.rules.length === 1
    ? ruleResults[0].detail
    : { rules: ruleResults.map((r) => ({ fire: r.fire, status: r.status, reason: r.reason, detail: r.detail })) };
  return { valid: true, fire: combined.fire, status: combined.status, reason: combined.reason, warning, detail };
}

function days(from, to) {
  return Math.floor((to - from) / 86400000);
}

// Re-verify, against freshly loaded state, that a broadcast is still
// wanted — right before the real broadcast. This closes the race where
// a check-in, a disable, or a replacement lands while the
// input check is waiting on the network, and the original evaluation
// would otherwise broadcast anyway using its stale state. For the
// automatic release it re-checks the armed toggle, vacation
// (check-in txs only), and that the clock is still release-due; a
// manual broadcast (the owner's explicit say-so) ignores the clock,
// the armed toggle, and vacation, exactly as the endpoints do. Both
// kinds re-check that the transaction still exists, is still the same
// hex, and is neither broadcast nor stale. Returns { ok, reason, state,
// tx } — the fresh state and tx to broadcast from. The broadcast record
// itself is NOT written to this snapshot: broadcastOne reloads fresh
// state again after the network call and merges only the record in
// (see below), so a check-in that lands mid-broadcast survives.
// The clock is NOT re-checked here: the release decision was made
// once, above — all-or-none, 0.7.10 — while the other guards
// above still apply.
function preBroadcastCheck(tx, logKind, opts) {
  const fresh = store.loadState(DATA_DIR);
  const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
  if (!ftx) return { ok: false, reason: 'transaction was deleted' };
  if (ftx.hex !== tx.hex) return { ok: false, reason: 'transaction was replaced' };
  if (ftx.broadcasted || (ftx.release && ftx.release.status === 'broadcast')) return { ok: false, reason: 'already broadcast' };
  if (ftx.release && ftx.release.status === 'stale') return { ok: false, reason: 'transaction is stale — replace it to re-arm' };
  // A transaction already submitted to Slipstream is waiting on
  // MARA — it is not re-submitted (0.7.16). The hourly MARA-waiting
  // refresh (refreshMaraWaiting) is what moves it on: to 'broadcast'
  // once the public nodes see it, or back to 'failed' if MARA drops
  // it, and only then is it attempted again. The ONE exception is
  // the manual "Broadcast publicly" escape hatch (opts.forcePublic):
  // the owner explicitly chose to give up the Slipstream privacy
  // and put this tx in the public mempool, so the wait is over.
  if (ftx.release && ftx.release.status === 'submitted-slipstream' && !(opts && opts.forcePublic)) return { ok: false, reason: 'already submitted to Slipstream — waiting on MARA' };
  if (logKind === 'release') {
    if (!ftx.enabled) return { ok: false, reason: 'transaction was disabled' };
    // Vacation is check-in-only (0.8.0): it holds a check-in
    // tx's automatic release, and nothing else's — a price or
    // UTXO tx broadcasts on schedule while the owner is away.
    // Manual broadcasts never enter this branch (logKind
    // 'broadcast'), so they bypass disarm and vacation entirely.
    // (0.8.2) Only a FIRED check-in rule is held: a set that fired
    // on a price rule broadcasts during vacation. When the caller
    // did not name the fired rules (the public-fallback path), a
    // tx that HAS a check-in rule is held, as before.
    const firedTypes = (opts && Array.isArray(opts.firedRuleTypes)) ? opts.firedRuleTypes : null;
    const holdsOnCheckin = firedTypes ? firedTypes.includes('checkin') : store.hasTriggerType(ftx, 'checkin');
    if (fresh.settings.vacationMode && holdsOnCheckin) return { ok: false, reason: 'vacation mode' };
    // All-or-none release (0.7.10): once a release evaluation has
    // decided the clock is due, the whole armed set broadcasts even
    // if a check-in lands mid-run. A check-in is still recorded —
    // the merge-only broadcast write preserves it — and resets the
    // clock for the next cycle; it just does not stop a release that
    // already started. So inside a decided release run the clock is
    // NOT re-checked here; the guards above (disabled, vacation)
    // still apply, because those are explicit owner actions on the
    // transaction or the switch, not the clock.
  }
  return { ok: true, state: fresh, tx: ftx };
}

// ---------------------------------------------------------------------------
// Broadcast ONE transaction for real — the shared path the release and
// the manual buttons (Broadcast Now, Broadcast Armed) both use.
//   1. Freshness gate: re-check every input right before broadcasting.
//      A spent input is three things (0.7.12, third-audit finding 1):
//      our OWN txid as the spender means the transaction is already
//      out there — record 'broadcast' and do NOT re-broadcast it
//      (recognition, not a re-send — the same as a node answering
//      'already in mempool'); a confirmed spend by another tx means
//      the tx is stale — record 'stale' and do NOT broadcast (a stale
//      tx can never broadcast); an unconfirmed spend by another tx is
//      a warning only — it does NOT block the broadcast below, the
//      node is the arbiter.
//   2. Broadcast via the transaction's selected route (0.7.16):
//      'public' broadcasts via the primary node, falling back to
//      the secondary if the primary does not answer; 'slipstream'
//      submits to MARA Slipstream ONLY — no fallback to the public
//      nodes. A successful Slipstream submission records status
//      'submitted-slipstream' (not 'broadcast') and no broadcasted
//      fact: the transaction is in MARA's private mempool, invisible
//      to the public nodes, until refreshMaraWaiting sees it publicly
//      (then 'broadcast') or MARA drops it (then 'failed', retried
//      next tick via Slipstream). Success is recorded once per tx
//      and never repeated, with the endpoint that actually broadcast;
//      failure is recorded as 'failed' and retried on the next tick
//      (a transient network failure must not lose the moment).
// A broadcast records BOTH the cycle release record (tx.release) and
// the permanent broadcasted fact (tx.broadcasted). A check-in clears
// the cycle record and starts a new cycle — but the broadcasted fact
// stays: a broadcast is an on-chain fact, and the card keeps showing
// it (with its confirmation count) until the transaction is replaced.
// `logKind` is 'release' for the automatic release and 'broadcast' for
// a manual broadcast, so the broadcast log distinguishes them.
// Returns the per-tx result { id, txid, label, action, method?, error? }.
// Callers skip already-broadcast and stale txs themselves.
// ---------------------------------------------------------------------------
// Broadcasts in flight, by transaction id — a manual Broadcast Now /
// Broadcast Armed and the automatic release must never broadcast the
// same transaction twice at once (audit finding 6). Only the release
// evaluation has a single-flight lock (0.7.6); the manual endpoints
// call broadcastOne directly, so a double-click or a manual call
// landing during a release could overlap it. broadcastOne claims the
// id for its whole run (freshness gate + network + write); a second
// attempt for the same id is skipped, not queued. The claim is a
// check-and-set with no await in between, so it is atomic on Node's
// single thread, and the finally releases it even if the inner run
// throws.
const broadcastingTxIds = new Set();
async function broadcastOne(state, tx, endpoints, now, logKind, opts) {
  if (broadcastingTxIds.has(tx.id)) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'broadcast already in progress' };
  }
  broadcastingTxIds.add(tx.id);
  try {
    return await broadcastOneInner(state, tx, endpoints, now, logKind, opts);
  } finally {
    broadcastingTxIds.delete(tx.id);
  }
}

async function broadcastOneInner(state, tx, endpoints, now, logKind, opts) {
  const failNote = logKind === 'release'
    ? 'Release check failed before broadcast: '
    : 'Broadcast check failed before broadcast: ';
  // (0.8.0) The trigger type stamped on every release record this
  // broadcast writes — the rule that fired it (or the tx's current
  // trigger, for a manual broadcast). (0.8.2) The caller names the
  // fired rules when it knows them (the release path does); a
  // manual broadcast and the fallback paths name none, so the
  // record carries all of the tx's rule types.
  const trigType = releaseTriggerFor(state, tx, opts && opts.firedRuleTypes);
  let check;
  try {
    check = await bitcoin.checkInputsUnspent(bitcoin.parseTx(tx.hex), endpoints);
  } catch (e) {
    // The manual "Broadcast publicly" escape hatch (forcePublic)
    // does NOT write a 'failed' record: the tx stays
    // Slipstream-pending if the public attempt cannot even check
    // its inputs — the failure is surfaced to the owner, and MARA
    // is still holding the tx.
    if (!(opts && opts.forcePublic)) {
      const record = { status: 'failed', kind: logKind, trigger: trigType, txid: tx.txid, method: 'primary', lastAttemptAt: now.toISOString(), error: 'input check failed: ' + e.message };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        pushHistory(ftx, 'failed', ('input check failed: ' + e.message).slice(0, 120));
        recordRelease(fresh, ftx, record, {
          ts: now.toISOString(), kind: logKind, status: 'failed', method: 'primary', txid: tx.txid,
          hexPreview: tx.hex.slice(0, 64), note: failNote + e.message,
        });
      }
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: 'input check failed: ' + e.message };
  }
  // Our own txid is the spender (0.7.12, third-audit finding 1):
  // this transaction is already out there — in the mempool or a
  // block — so there is nothing to send. Record it broadcast and
  // report broadcast, never stale, never a warning, regardless of
  // confirmations. The write is merge-only, like the success path
  // below: the broadcasted fact takes precedence over any cycle
  // record, and the hourly confirmation refresh fills in the
  // confirmation count from the block height the outspend reported.
  if (check.own && check.own.length) {
    const own = check.own[0];
    const record = { status: 'broadcast', kind: logKind, trigger: trigType, txid: tx.txid, method: check.checkedVia, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex && !ftx.broadcasted) {
      ftx.broadcasted = {
        txid: tx.txid, broadcastedAt: now.toISOString(), method: check.checkedVia,
        confirmations: null, blockHeight: own.blockHeight != null ? own.blockHeight : null, found: true, checkedAt: now.toISOString(),
      };
      // (0.8.2) The tx is out there — log the broadcast, and the
      // confirmation too when the outspend already names the block.
      pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(tx.txid));
      if (own.blockHeight != null) pushHistory(ftx, 'confirmed', 'Block ' + own.blockHeight.toLocaleString('en-US'));
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'broadcast', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is already out there — the node reports its own txid as the spending transaction. Recorded as broadcast; nothing was sent.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'broadcast', method: check.checkedVia, alreadyOut: true };
  }
  if (check.spent.length) {
    const spentDesc = check.spent.map((i) => i.prevTxid.slice(0, 12) + ':' + i.prevVout).join(', ');
    // The record survives check-ins: spent inputs are a fact about
    // the transaction, not the cycle (only replacing the hex clears
    // it — a stale transaction can never broadcast).
    const record = { status: 'stale', kind: logKind, trigger: trigType, txid: tx.txid, method: check.checkedVia, lastAttemptAt: now.toISOString(), error: 'inputs spent: ' + spentDesc };
    // Record the stale verdict on the CURRENT transaction only if it
    // is still the same hex; a replacement in the meantime means the
    // old tx is gone and there is nothing to mark stale.
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      pushHistory(ftx, 'stale', record.error);
      recordRelease(fresh, ftx, record, {
        ts: now.toISOString(), kind: logKind, status: 'stale', method: check.checkedVia, txid: tx.txid,
        hexPreview: tx.hex.slice(0, 64), note: 'Transaction is stale (inputs spent: ' + spentDesc + ') — broadcast not attempted.',
      });
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'stale', error: record.error };
  }

  // Broadcast for real — but only after re-verifying against fresh
  // state (see preBroadcastCheck above): a check-in, disable,
  // or replacement that landed while the input check was on the
  // network must stop the broadcast. The route is the transaction's
  // own broadcastVia (0.7.16): 'public' broadcasts via the mempool
  // nodes (primary, then secondary); 'slipstream' submits to MARA
  // Slipstream ONLY. There is no cross-route fallback — if the
  // selected route fails, the transaction is 'failed' and the next
  // evaluation retries that same route. The manual "Broadcast
  // publicly" escape hatch (opts.forcePublic) overrides the route:
  // it always goes public, whatever the stored route says.
  const pre = preBroadcastCheck(tx, logKind, opts);
  if (!pre.ok) {
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: pre.reason };
  }
  const via = (opts && opts.forcePublic) ? 'public' : (pre.tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public');
  // (0.7.17) The first Slipstream attempt — success or fail — is the
  // deadline anchor for a transaction whose submit keeps failing
  // (case (b) of fallbackDeadline). Record it once, before the
  // network call, so it is set even if the attempt itself throws;
  // never overwrite it after. The success and failure branches below
  // reload fresh state, so this write survives them.
  if (via === 'slipstream') {
    const fresh0 = store.loadState(DATA_DIR);
    const ftx0 = (fresh0.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx0 && ftx0.hex === tx.hex && !ftx0.slipstreamFirstAttemptAt) {
      ftx0.slipstreamFirstAttemptAt = now.toISOString();
      store.saveState(DATA_DIR, fresh0);
    }
  }
  // (0.7.17) The public fallback (refreshPublicFallbacks) passes
  // fallbackDays: its presence means this public broadcast is the
  // automatic fallback for a Slipstream transaction that ran out its
  // timer — the broadcast log must say why it went public, so the
  // note is prefixed onto the broadcast entry broadcastTx writes.
  const fallbackNote = (opts && typeof opts.fallbackDays === 'number')
    ? 'Public fallback: this Slipstream transaction was not publicly visible within ' + opts.fallbackDays + (opts.fallbackDays === 1 ? ' day' : ' days') + ', so Standby broadcast it publicly instead.'
    : null;
  try {
    if (via === 'slipstream') {
      // A successful Slipstream submission is NOT a broadcast yet:
      // the transaction is in MARA's private mempool, invisible to
      // the public nodes. It gets its own release status,
      // 'submitted-slipstream' — a pseudo-pending-but-success state
      // — and NO broadcasted fact (that fact is written only once
      // the public nodes see it, by refreshMaraWaiting). The release
      // is not complete while any transaction is in this state.
      const out = await bitcoin.broadcastViaSlipstream(pre.tx.hex, pre.tx.txid);
      const record = { status: 'submitted-slipstream', kind: logKind, trigger: trigType, txid: out.txid, method: 'slipstream', submittedAt: now.toISOString() };
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        ftx.release = record;
        pushHistory(ftx, 'slipstream', 'txid ' + shortTxid(out.txid));
        store.saveState(DATA_DIR, fresh);
      }
      store.appendBroadcastLog(DATA_DIR, {
        ts: now.toISOString(), kind: logKind, status: 'submitted-slipstream', method: 'slipstream', txid: out.txid,
        hexPreview: pre.tx.hex.slice(0, 64),
        note: 'Submitted to MARA Slipstream — waiting for MARA to mine it. Not visible in the public mempool yet.',
      });
      return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'submitted-slipstream', method: 'slipstream' };
    }
    const out = await bitcoin.broadcastTx(DATA_DIR, { hex: pre.tx.hex, txid: pre.tx.txid, endpoints, notePrefix: fallbackNote });
    // Merge-only write (audit finding 1): the broadcast itself was
    // just on the network, and anything may have landed while it was
    // out there — a check-in, a settings change, a disable. Saving
    // pre.state here would overwrite those newer changes (and a lost
    // check-in is exactly how a release could outlive the owner
    // checking in). So reload FRESH state and write only the
    // broadcast record onto the matching transaction. If the tx was
    // deleted or replaced mid-broadcast, there is no record left to
    // mark — the broadcast already went out on-chain and is in the
    // broadcast log — and the deleted/replaced record must NOT be
    // resurrected by saving the old snapshot.
    const record = { status: 'broadcast', kind: logKind, trigger: trigType, txid: out.txid, method: out.method, broadcastedAt: now.toISOString() };
    const fresh = store.loadState(DATA_DIR);
    const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    if (ftx && ftx.hex === tx.hex) {
      // The escape hatch went public: the stored route follows the
      // tx — it is a public tx now, and if it ever drops back to
      // 'release-due' it retries via the public route.
      if (opts && opts.forcePublic) ftx.broadcastVia = 'public';
      ftx.release = record;
      ftx.broadcasted = {
        txid: out.txid, broadcastedAt: now.toISOString(), method: out.method,
        confirmations: null, blockHeight: null, found: true, checkedAt: null,
      };
      pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(out.txid));
      store.saveState(DATA_DIR, fresh);
    }
    return { id: tx.id, txid: out.txid, label: tx.label || '', action: 'broadcast', method: out.method };
  } catch (e) {
    // A failed attempt (either route) is 'failed' and retried on
    // the next evaluation via the SAME selected route (0.7.14 retry
    // rule). For Slipstream the error carries Slipstream's own
    // rejection reason (a fee below the floor, a sanctions
    // rejection, an invalid tx). The method names the route that
    // failed: 'slipstream' for Slipstream, 'primary' for the public
    // route (the first endpoint tried — the pre-0.7.16 convention).
    // EXCEPT the manual "Broadcast publicly" escape hatch
    // (forcePublic): a failed public attempt does NOT write a
    // 'failed' record — the tx stays Slipstream-pending, still in
    // MARA's queue, and the error is surfaced to the owner instead.
    const record = { status: 'failed', kind: logKind, trigger: trigType, txid: tx.txid, method: via === 'slipstream' ? 'slipstream' : 'primary', lastAttemptAt: now.toISOString(), error: e.message };
    if (!(opts && opts.forcePublic)) {
      const fresh = store.loadState(DATA_DIR);
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && ftx.hex === tx.hex) {
        pushHistory(ftx, 'failed', String(e.message || '').slice(0, 120));
        recordRelease(fresh, ftx, record, null); // broadcastTx already logged the failure
      }
    }
    return { id: tx.id, txid: tx.txid, label: tx.label || '', action: 'failed', error: e.message };
  }
}

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
// a plain 'already in progress' skip. The flag is set and cleared
// synchronously around the awaited work, in a finally, so it can never
// stick — and Node's single thread makes the check-and-set atomic.
let releaseEvaluationInFlight = false;
// Broadcast backoff (0.8.2): an automatic evaluation does not
// re-attempt a broadcast for a tx within an hour of its last
// failed broadcast attempt (see the guard in
// evaluateReleaseInner). One hour, hard-coded — the retry
// cadence is a safety property, not a user setting.
const BROADCAST_BACKOFF_MS = 60 * 60 * 1000;
// `options.automatic` (optional) marks a tick-driven evaluation —
// the full tick passes { automatic: true }; the manual release
// check passes nothing. The backoff guard in evaluateReleaseInner
// applies only to automatic evaluations (a manual check or
// broadcast is explicit user action and always attempts).
// There is no type filter any more (0.8.2): the full tick
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
    // clock, so a second merge is a no-op (0.7.12, third-audit
    // finding 3).
    // (0.7.13, fourth-audit finding 7) An unreadable receiver state
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
    // Offline-gap grace (0.7.22): judged on the stored "I was
    // online" stamp (the tick refreshes it; a manual release check
    // does not). Sets + saves a hold when both conditions hold and
    // none is active, so the evaluation below sees the held clock.
    // Best-effort — a failure here must not block the evaluation
    // (the hold is a grace, not a gate).
    try {
      const stH = store.loadState(DATA_DIR);
      let changed = false;
      if (applyOfflineHold(stH, new Date())) changed = true;
      if (applyGrace(stH, new Date())) changed = true;
      if (expireVacation(stH, new Date())) changed = true;
      if (changed) store.saveState(DATA_DIR, stH);
    } catch (e) { console.error('offline-hold apply failed:', e); }
    return await evaluateReleaseInner(automatic);
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
    const s = ruleTriggerState(tx, i);
    const status = s ? (s.status || 'not-evaluated') : 'not-evaluated';
    const held = status === 'grace' ? 'grace' : status === 'vacation' ? 'vacation' : status === 'held' ? 'held' : null;
    const cls = (status === 'due' || status === 'release-due') ? 'satisfied'
      : (status === 'unknown' || status === 'not-evaluated') ? 'unknown'
      : held ? 'held' : 'not';
    return { index: i, rule, fire: cls === 'satisfied', status, reason: s ? (s.reason || '') : '', held, skipped: false, cls };
  });
}
function storedCombinedDue(tx) {
  return combineOutcomes(store.triggerOf(tx), storedRuleOutcomes(tx)).fire;
}

async function evaluateReleaseInner(automatic) {
  const state = store.loadState(DATA_DIR);
  const now = new Date();
  const s = state.settings;
  // `automatic` marks a tick-driven evaluation (the full tick
  // passes true; the manual release check passes nothing). It
  // only changes one thing: the broadcast backoff guard in the
  // firing loop below. Every rule type is evaluated, every time —
  // there is no type filter any more (0.8.2, the full tick).
  let armed = (state.bitcoin.txs || []).filter((t) => t.enabled);
  if (!armed.length) return { action: 'skipped', reason: 'no armed transactions', results: [] };

  // Endpoints: the primary node first, the secondary if the primary
  // does not answer. (The MEMPOOL_* env vars can override the primary
  // — see lib/bitcoin.js.)
  const endpoints = bitcoin.endpointsFor(s);
  const results = [];

  // (0.8.0) Each armed tx's own trigger decides whether it fires —
  // the release is no longer one global clock. The triggers are
  // evaluated ONCE, in list order, and the firing set is decided
  // before any broadcast starts (all-or-none, 0.7.10: a check-in
  // landing mid-run is recorded but does not stop the txs still to
  // broadcast). A trigger that cannot be read (a feed outage, an
  // outpoint no node can say about) is 'unknown' and does not fire.
  // The evaluations are persisted even when nothing fires — the
  // price trigger's last price and the UTXO trigger's
  // last outspend live in triggerState, and the next evaluation
  // builds on them.
  const firing = [];
  // (0.8.2) The 'fired' history event is logged once, on the
  // transition into due — so each evaluation records whether the
  // set was already due before it ran (from the STORED slices,
  // combined the same way), and the full evaluation result (which
  // rules fired) for the detail. 'release-due' counts as due here
  // — the old code only checked 'due', so a check-in tx whose
  // broadcast failed re-logged 'fired' on every hourly retry;
  // the new reading matches the "logged once" intent.
  const wasDueById = new Map();
  const evById = new Map();
  for (const tx of armed) {
    wasDueById.set(tx.id, storedCombinedDue(tx));
    let ev;
    try { ev = await evaluateTrigger(state, tx, now); }
    catch (e) {
      // An evaluator must never take the whole run down with it:
      // a throw is the same as 'unknown' — do not fire, and say so.
      // Every rule gets an unknown slice (the ones already
      // evaluated keep theirs).
      console.error('trigger evaluation failed for ' + (tx.label || tx.id) + ':', e);
      const set = store.triggerOf(tx);
      set.rules.forEach((rule, i) => {
        setRuleTriggerState(tx, i, { ...freshTriggerState(now, 'unknown', 'evaluation failed — will retry'), lastError: e.message });
      });
      ev = { fire: false, status: 'unknown', reason: 'evaluation failed — will retry', ruleResults: [], firedIndexes: [], firedRuleTypes: [] };
    }
    evById.set(tx.id, ev);
    if (!ev.fire) {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: ev.reason, trigger: triggerTypesLabel(tx), triggerStatus: ev.status });
      continue;
    }
    firing.push(tx);
  }
  const firingIds = new Set(firing.map((f) => f.id));
  // (0.8.2) Whether any firing tx was held back by the broadcast
  // backoff below — so the top-level reason says so instead of
  // 'no trigger fired' when nothing else happened.
  let backedOff = false;
  // Persist the triggerState updates by merging them into FRESH
  // state (see refreshConfirmations): the evaluations waited on the
  // network, so a user edit landing mid-loop — disable, delete, or
  // change a transaction — must not be clobbered by saving the stale
  // snapshot. The broadcast path below reloads fresh state per tx
  // and merges only its own record, so these evaluations survive
  // the broadcasts.
  try {
    const fresh = store.loadState(DATA_DIR);
    for (const tx of armed) {
      const ftx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (ftx && tx.triggerState) ftx.triggerState = tx.triggerState;
      // (0.8.2) The 'fired' history event, on the transition into
      // due only (see wasDueById above) — it rides on this same
      // save as the triggerState, so the event and the state that
      // caused it can never part ways.
      if (ftx && firingIds.has(tx.id) && !wasDueById.get(tx.id)) {
        const ev = evById.get(tx.id);
        pushHistory(ftx, 'fired', firedDetail(store.triggerOf(tx), ev.ruleResults, ev.firedIndexes));
      }
    }
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
    // Already submitted to Slipstream and waiting on MARA (0.7.16):
    // it is not re-submitted. refreshMaraWaiting (run after this
    // evaluation, on the tick and on the manual release check) is
    // what moves it on — to 'broadcast' once the public nodes see
    // it, or back to 'failed' if MARA drops it.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'submitted to Slipstream — waiting on MARA' });
      continue;
    }
    // (0.8.2) Broadcast backoff — automatic evaluations only. A
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
    // backoff (the pre-0.8.2 behaviour): a timestamp that cannot
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
    // transactions (all-or-none, 0.7.10). The fired rules ride along
    // so the broadcast path knows which of the set's rules fired
    // (the vacation guard only blocks a firing CHECK-IN rule; a
    // price rule firing during vacation broadcasts).
    const firedRuleTypes = (evById.get(tx.id) || {}).firedRuleTypes || store.triggerTypesOf(tx);
    results.push(await broadcastOne(state, tx, endpoints, now, 'release', { firedRuleTypes }));
  }

  const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
    : results.some((r) => r.action === 'failed') ? 'failed'
    : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
  const out = { action, results };
  if (action === 'skipped') out.reason = backedOff ? 'broadcast backoff — retry after an hour' : 'no trigger fired';
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
  // confirmation fields into FRESH state before saving. The old code
  // mutated this (stale) state object while the lookups were on the
  // network and saved it, so a user edit landing during the hourly
  // tick — disable, delete, or change a transaction — was clobbered
  // by the save. (Same class of bug as the 0.7.6 broadcast race;
  // the synchronous handlers were already atomic.)
  const endpoints = bitcoin.endpointsFor(state.settings);
  const nowMs = Date.now();
  const out = [];
  const updates = [];
  for (const tx of (state.bitcoin.txs || []).filter((t) => t.broadcasted)) {
    const b = tx.broadcasted;
    const ageSec = b.checkedAt ? (nowMs - new Date(b.checkedAt).getTime()) / 1000 : Infinity;
    if (ageSec < maxAgeSec && b.confirmations !== null) {
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt });
      continue;
    }
    try {
      const c = await bitcoin.getConfirmations(tx.txid, endpoints);
      const checkedAt = new Date().toISOString();
      updates.push({ id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight, found: c.found, checkedAt });
      out.push({ id: tx.id, txid: tx.txid, confirmations: c.confirmations, blockHeight: c.blockHeight ?? null, found: c.found !== false, checkedAt });
    } catch (e) {
      console.error('confirmations check failed for', tx.txid.slice(0, 12), e.message);
      out.push({ id: tx.id, txid: tx.txid, confirmations: b.confirmations, blockHeight: b.blockHeight ?? null, found: b.found !== false, checkedAt: b.checkedAt });
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
        // (0.8.2) The confirmation is a transition — log it once,
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
        }
        tx.broadcasted.confirmations = u.confirmations;
        tx.broadcasted.blockHeight = u.blockHeight;
        tx.broadcasted.found = u.found;
        tx.broadcasted.checkedAt = u.checkedAt;
        changed = true;
      }
    }
    if (changed) store.saveState(DATA_DIR, fresh);
  }
  return out;
}

// Refresh the MARA-waiting transactions (0.7.16). For every tx
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
//       it via Slipstream (the 0.7.14 retry rule). If Slipstream
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
        // (0.8.2) MARA's tx is out there now — log the broadcast,
        // and the confirmation when it is already in a block.
        pushHistory(tx, 'broadcast', 'txid ' + shortTxid(u.txid));
        if ((typeof u.confirmations === 'number' && u.confirmations >= 1) || (typeof u.blockHeight === 'number')) {
          pushHistory(tx, 'confirmed', (typeof u.blockHeight === 'number') ? 'Block ' + u.blockHeight.toLocaleString('en-US') : 'Confirmed');
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

// Public fallback (0.7.17): the automatic version of the manual
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
// here (0.8.0): the fallback is post-broadcast bookkeeping — a tx
// already broadcast via Slipstream waiting to go public — not a
// trigger firing, and vacation is check-in-only. Pause is gone
// entirely (Global Arm/Disarm replaces it, and a disarmed tx is
// already excluded above). Public visibility is checked FIRST: if the public
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
    const r = await broadcastOne(state, tx, endpoints, now, 'release', { forcePublic: true, fallbackDays: tx.publicFallbackDays });
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
// Fee verdict (0.7.20): the "90-day peak" — the 90th percentile of
// block medians over the 3-month window — is fetched from the
// mempool.space public fee-rates endpoint (NOT the configured node,
// which may be a plain Esplora that cannot serve it) and cached in
// memory. It is refreshed once a day: on the hourly tick when the
// cached value is older than 24h, and once shortly after startup.
// A failed refresh keeps the last cached value (a brief outage does
// not kill the verdict), but a value older than 48h is served as
// null — a multi-day outage degrades to "no verdict" rather than a
// stale one. The peak is derived, like the overlaps: it is never
// stored in state.json, so no migration and no restore change.
const FEE_PEAK_REFRESH_MS = 24 * 60 * 60 * 1000; // refresh once a day
const FEE_PEAK_MAX_AGE_MS = 48 * 60 * 60 * 1000; // older than this: no verdict
let feePeakCache = { peak: null, fetchedAt: null };

async function refreshFeePeakIfStale() {
  if (feePeakCache.fetchedAt && (Date.now() - feePeakCache.fetchedAt) < FEE_PEAK_REFRESH_MS) return;
  try {
    const peak = await bitcoin.fetchFeePeak();
    feePeakCache = { peak, fetchedAt: Date.now() };
  } catch (e) {
    console.error('fee-peak refresh failed (keeping last cached value):', e.message);
  }
}

// The current recommended fees (0.7.21): the same mempool.space
// public base, the /api/v1/fees/recommended endpoint — NOT the
// configured node (a plain Esplora has no such endpoint). Cached
// in memory and refreshed once an hour: on the hourly tick when
// the cached value is older than 1h, and once shortly after
// startup. The current fee moves fast, so a value older than 2h
// is served as null — the Critical check is then skipped and the
// verdict falls back to the historical ladder, rather than
// judging a live fee against a stale one. Like the peak, the
// current fees are derived, never stored in state.json.
const FEE_CURRENT_REFRESH_MS = 60 * 60 * 1000; // refresh once an hour
const FEE_CURRENT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // older than this: no Critical check
let currentFeesCache = { fees: null, fetchedAt: null };

async function refreshCurrentFeesIfStale() {
  if (currentFeesCache.fetchedAt && (Date.now() - currentFeesCache.fetchedAt) < FEE_CURRENT_REFRESH_MS) return;
  try {
    const fees = await bitcoin.fetchCurrentFees();
    currentFeesCache = { fees, fetchedAt: Date.now() };
  } catch (e) {
    console.error('current-fees refresh failed (keeping last cached value):', e.message);
  }
}

// The current recommended fees to serve with the state: the cached
// object, or null when there is nothing cached or the cached value
// is too old to present as current. The fetched-at timestamp rides
// along so the value is clearly labelled, never silently stale.
function currentFeesForState() {
  if (!currentFeesCache.fees || !currentFeesCache.fetchedAt) return { fees: null, fetchedAt: null };
  if ((Date.now() - currentFeesCache.fetchedAt) > FEE_CURRENT_MAX_AGE_MS) return { fees: null, fetchedAt: null };
  return { fees: currentFeesCache.fees, fetchedAt: new Date(currentFeesCache.fetchedAt).toISOString() };
}

// The peak to serve with the state: the cached number, or null when
// there is nothing cached or the cached value is too old to present
// as current. The fetched-at timestamp rides along so the value is
// clearly labelled, never silently stale.
function feePeakForState() {
  if (feePeakCache.peak === null || !feePeakCache.fetchedAt) return { peak: null, fetchedAt: null };
  if ((Date.now() - feePeakCache.fetchedAt) > FEE_PEAK_MAX_AGE_MS) return { peak: null, fetchedAt: null };
  return { peak: feePeakCache.peak, fetchedAt: new Date(feePeakCache.fetchedAt).toISOString() };
}

// The full-evaluation tick (0.8.2): ONE tick evaluates every rule
// type together, on the check cadence (Settings: Check cadence,
// default 60 s). It replaces the two-tick split (an hourly tick
// for check-in only, a fast tick for the five fast types): an AND
// set spanning the two domains — check-in AND price, say — can
// only fire when both rules are judged at the same tick, and the
// split ticks never did that (only a manual release check did).
// The cadence is a fast-trigger cadence: a setup with no armed
// non-manual rule never runs this tick, so a manual-only setup
// makes no extra API calls, and a check-in-only setup costs only
// the clock math (a timestamp compare — no network). The
// evaluation is the same single-flight evaluateRelease() the
// manual check uses, with no type filter — so every rule is
// judged together, every tick.
//   The stamp block (offline hold, grace, vacation expiry, the
//   "I was online" stamp) runs here, before the evaluation, on
//   the same reasoning as before: the hold is judged on the stamp
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
  // Offline-gap grace (0.7.22): the hold is judged on the "I was
  // online" stamp as it stands BEFORE this tick refreshes it —
  // refreshing first would shrink the gap to zero and the hold
  // could never be set. The stamp is then refreshed (so the gap is
  // measured from this tick onward) and recorded even when the
  // evaluation below is skipped.
  try {
    const st0 = store.loadState(DATA_DIR);
    mergeExternalCheckin(st0, now);
    if (applyOfflineHold(st0, now)) store.saveState(DATA_DIR, st0);
    applyGrace(st0, now); // the grace for price/UTXO triggers (0.8.0) — judged on the same stale stamp, before it is refreshed; the unconditional save below persists it
    // Vacation expiry (0.8.0): a dated vacation ends at the end
    // of its last day — the clock resumes from its frozen count.
    // Judged here on the full tick (and on every release
    // evaluation, see evaluateRelease), so a lapsed vacation
    // never lingers past the next tick.
    expireVacation(st0, now);
    st0.checkin.lastOnlineAt = now.toISOString();
    store.saveState(DATA_DIR, st0);
  } catch (e) { console.error('offline-hold / lastOnlineAt update failed:', e); }
  // A receiver check-in lands in the clock before the release is
  // evaluated, so a check-in that arrived between ticks is honoured
  // even if nobody opened the app.
  // The price cache refresh runs first, so the price rule's
  // "currently $X" line stays fresh even while its trigger is held
  // by a grace.
  try {
    await refreshPriceIfStale();
    const st = store.loadState(DATA_DIR);
    const hasArmed = (st.bitcoin.txs || []).some((t) => {
      if (!t.enabled) return false;
      return store.triggerTypesOf(t).some((ty) => ty !== 'manual');
    });
    if (!hasArmed) return;
    const r = await evaluateRelease({ automatic: true });
    if (r.action !== 'skipped') {
      const sum = (r.results || []).map((x) => x.action + ':' + (x.txid || '').slice(0, 8)).join(', ');
      console.log('full tick:', r.action, sum || r.reason || '');
    }
  } catch (e) { console.error('full tick failed:', e); }
}

// The hourly tick (0.8.2): housekeeping only. It used to be the
// release tick (check-in evaluation + this housekeeping); the
// evaluation moved to runFullTick above, and this tick keeps the
// hourly cadence for the work that is genuinely hourly — node
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
  // MARA-waiting transactions (0.7.16): a Slipstream submission
  // that is not yet visible publicly needs its status kept current
  // even while the clock is on-track — the refresh runs regardless
  // of the clock.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshMaraWaiting(st);
  } catch (e) { console.error('MARA-waiting refresh failed:', e); }
  // Public fallback (0.7.17): a Slipstream transaction whose
  // fallback deadline has passed goes public — after the MARA
  // refresh above, so a tx MARA just confirmed as visible is not
  // also fallback-broadcast. Runs regardless of the clock, like
  // the MARA refresh.
  try {
    const st = store.loadState(DATA_DIR);
    await refreshPublicFallbacks(st);
  } catch (e) { console.error('public-fallback refresh failed:', e); }
  // Fee verdict (0.7.20): refresh the 90-day peak when it is older
  // than a day, so the per-tx fee verdicts stay current. Best-
  // effort — a failed refresh never breaks the tick.
  try { await refreshFeePeakIfStale(); } catch (e) { console.error('fee-peak refresh failed:', e); }
  // Fee verdict (0.7.21): refresh the current recommended fees when
  // they are older than an hour, so the Critical Risk check judges
  // a live fee against a live market. Best-effort — a failed
  // refresh never breaks the tick (the Critical check is skipped
  // until the fees come back).
  try { await refreshCurrentFeesIfStale(); } catch (e) { console.error('current-fees refresh failed:', e); }
}

// Test both nodes and save the per-endpoint results, so the Dashboard
// can show each node's own status. The full result (endpoint, base,
// ok, detail) is stored — the Dashboard only trusts a result measured
// against the endpoint as currently configured.
async function testNodes() {
  const state = store.loadState(DATA_DIR);
  const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings));
  // Merge into FRESH state (see refreshConfirmations): an edit landing
  // while the node test was on the network would otherwise be
  // clobbered by the save of this stale copy. The Dashboard only
  // trusts a result measured against the endpoints as currently
  // configured, so a result measured against just-replaced endpoints
  // is ignored, not misattributed.
  const fresh = store.loadState(DATA_DIR);
  fresh.bitcoin.connection = { ok: r.ok, checkedAt: new Date().toISOString(), detail: r.detail, results: r.results };
  store.saveState(DATA_DIR, fresh);
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Prevent path traversal.
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR)) { sendError(res, 403, 'forbidden'); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { sendError(res, 404, 'not found'); return; }
  const ext = path.extname(resolved);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// CSRF protection (0.7.12, third-audit finding 2). The UI is the only
// browser client: it fetches this API from the same origin, and api()
// in public/app.js sends Content-Type: application/json on every call
// (verified — the file has a single fetch, with that header always
// set). A cross-origin page cannot read the responses (no CORS headers
// are ever sent), but a plain form POST, or a no-cors fetch, could
// still reach a state-changing endpoint with the owner's Umbrel
// app-auth cookie attached. So a state-changing /api request must
// pass both checks:
//   (a) a present Origin must match the host the request reached (the
//       Host header), or the X-Forwarded-Host the proxy sets — or both
//       sides must be loopback. A missing Origin (curl, a script, the
//       DOM test shim — Node's fetch sends none) is still allowed.
//       This is the same rule Umbrel's own Murmur app uses behind the
//       app proxy, which preserves Host.
//   (b) the Content-Type must be application/json — a cross-origin
//       HTML form can only send urlencoded / multipart / text, and a
//       no-cors fetch cannot set a JSON content type without a CORS
//       preflight this server never answers.
// GETs are reads and are not gated.
function hostOf(h) {
  h = (h || '').trim();
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return (close === -1 ? h.slice(1) : h.slice(1, close)).toLowerCase();
  }
  return h.split(':')[0].toLowerCase();
}

function isLoopback(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function csrfAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = hostOf(new URL(origin).hostname); } catch { return false; }
    const host = hostOf(req.headers.host);
    const fwd = hostOf((req.headers['x-forwarded-host'] || '').split(',')[0]);
    if (oh !== host && oh !== fwd && !(isLoopback(oh) && isLoopback(host))) return false;
  }
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  return true;
}

// The release-record statuses the app itself writes (see recordRelease
// / broadcastOne): 'stale', 'failed', 'broadcast', 'conflict' — the
// last is an input spent by another transaction that is NOT confirmed
// yet (0.7.12, third-audit finding 1): a warning, not a verdict —
// the transaction stays active and a broadcast is still attempted.
// A backup carrying any other status is not a real record (0.7.12,
// third-audit finding 4).
const RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
// The kinds a release record may carry — 'release' for the automatic
// release, 'broadcast' for a manual broadcast, 'dryrun' for a
// dry-run verdict. Used by the restore validation (0.7.13).
const RELEASE_KINDS = new Set(['release', 'broadcast', 'dryrun']);

// (0.8.1, audit finding 4) A mutating API handler loads state once at
// the top of handleApi, then awaits the network (fee lookups, trigger
// checks, node tests) — or just the request body — before saving. A
// second request, or the tick, may have saved newer state in between,
// and saving this stale snapshot would clobber it — a lost check-in,
// a lost disarm, a lost edit. So a handler NEVER saves its own
// snapshot after an await: it applies its change to FRESH state,
// synchronously, through saveMutation. The load, the mutation, and
// the save run with no await between them, so no other writer can
// interleave — the same pattern the background refreshes already use
// (see refreshConfirmations). The mutator gets the fresh state and
// returns false to decline the save (the tx or key it named is gone,
// or a fresh-state validation failed); anything else means save.
// Returns the fresh state, or null when the mutator declined.
function saveMutation(mutator) {
  const fresh = store.loadState(DATA_DIR);
  if (mutator(fresh) === false) return null;
  store.saveState(DATA_DIR, fresh);
  return fresh;
}

async function handleApi(req, res, pathname) {
  const now = new Date();
  // CSRF gate (0.7.12): state-changing requests must come from the
  // app's own page — see csrfAllowed above. Checked before any state
  // is loaded, so a rejected request cannot touch anything.
  if (req.method !== 'GET' && !csrfAllowed(req)) {
    return sendError(res, 403, 'cross-origin or non-JSON request rejected');
  }
  let state = store.loadState(DATA_DIR);

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }

  // GET /api/state — full state (no secrets live in state any more).
  // Also carries the shared inputs, derived from the stored
  // transactions on every read (findSharedInputs parses the hexes,
  // no network): the UI renders the shared-input warning from this,
  // so the warning persists across refreshes and clears the moment a
  // transaction is edited away from the shared input. It is derived,
  // not stored — the state file holds only the transactions.
  if (req.method === 'GET' && pathname === '/api/state') {
    // A receiver check-in that landed since the last read is merged
    // first, so the state served is current.
    mergeExternalCheckin(state, now);
    // Offline-gap grace (0.7.22): the hold is judged here too, so
    // a page load reflects it even if no release tick has run since
    // the device came back — the bars measure the held window, not
    // the stale original due. The stamp is NOT refreshed on a read
    // (only the tick does that), so the gap stays honest.
    try {
      let changed = false;
      if (applyOfflineHold(state, now)) changed = true;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('offline-hold apply failed:', e); }
    const served = sanitizeState(state);
    served.grace = graceStatus(state, now); // the price/UTXO grace (0.8.0): null when none is active, else { active, indefinite, graceUntil, triggeredAt, offlineGapDays }
    served.bitcoin.overlaps = bitcoin.findSharedInputs(state.bitcoin.txs || []);
    // The fee verdict's 90-day peak (0.7.20): the cached number (or
    // null when there is no usable fee data), with the fetched-at
    // timestamp so the value is clearly labelled. Derived on every
    // read, like the overlaps — never stored, so no migration and no
    // restore change. The frontend compares each active tx's own fee
    // rate to this peak; a null peak means no verdict anywhere.
    const fp = feePeakForState();
    served.bitcoin.feePeak = fp.peak;
    served.bitcoin.feePeakAt = fp.fetchedAt;
    // The current recommended fees (0.7.21): the cached object (or
    // null when there is no usable current-fee data), with the
    // fetched-at timestamp. The frontend compares each active tx's
    // own fee rate to the economy fee for the Critical Risk check;
    // a null object means the check is skipped and only the
    // historical ladder runs.
    const cf = currentFeesForState();
    served.bitcoin.currentFees = cf.fees;
    served.bitcoin.currentFeesAt = cf.fetchedAt;
    // The BTC price (0.8.0): the cached price (or nulls when
    // nothing has been fetched yet), so a price rule's "currently
    // $X" line is live on the card. currentPrices is the
    // per-source readings map (for the Settings display); the
    // provider list is served so the Settings selects always
    // match the registry.
    const pc = priceCacheForState(priceAgreementPctOf(state.settings));
    served.bitcoin.currentPrice = pc.price;
    served.bitcoin.currentPriceAt = pc.fetchedAt;
    served.bitcoin.currentPrices = pc.prices;
    served.bitcoin.priceProviders = bitcoin.PRICE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })).concat([{ id: 'custom', label: 'Custom' }]);
    // The consolidated exchange status (0.8.0): one status for
    // the configured price sources, shown once on the readiness
    // card (like Node Status) instead of repeated per price tx.
    served.bitcoin.exchangeStatus = exchangeStatusFor(pc, priceSourcesOf(state.settings), priceAgreementPctOf(state.settings));
    // The inputs/outputs detail (0.7.18 refinement): derived from
    // the stored hexes on every read, like the overlaps — never
    // stored, so no migration and no restore change. An unparseable
    // hex (defensive only — adds and restores validate) gets no
    // detail, and the card falls back to the plain counts.
    for (const t of served.bitcoin.txs || []) {
      try { t.detail = bitcoin.txIoDetail(bitcoin.parseTx(t.hex)); }
      catch { t.detail = null; }
      // The trigger (0.8.0): normalized (so the UI always sees a
      // valid one — a legacy tx reads as the check-in trigger) and
      // its current status, computed from the stored evaluation
      // (no network on a read) — except the check-in trigger,
      // whose state is live clock math. (0.8.2) The served trigger
      // is the legacy single-rule shape for a one-rule set and the
      // set for a multi-rule set (see serveTrigger); the served
      // triggerState matches — a flat slice for one rule, the
      // per-rule array for several. The status is computed first,
      // on the stored form, so a one-rule set reads exactly as it
      // did before rule sets.
      t.triggerStatus = triggerStatusFor(state, t, now);
      const servedSet = store.triggerOf(t);
      t.trigger = store.serveTrigger(servedSet);
      t.triggerState = store.serveTriggerState(servedSet, t.triggerState);
    }
    return sendJson(res, 200, served);
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    const merged = mergeExternalCheckin(state, now);
    // Offline-gap grace (0.7.22): see GET /api/state — the card
    // reads this endpoint, so the hold must be judged here too.
    try {
      let changed = false;
      if (applyOfflineHold(state, now)) changed = true;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('offline-hold apply failed:', e); }
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...checkinStatus(state, now),
      lastCheckinAt: state.checkin.lastCheckinAt,
      totalCheckins: state.checkin.totalCheckins,
      // (0.7.13, fourth-audit finding 7) Whether the receiver's
      // check-in file could not be read. A missing file is NOT an
      // error (no receiver installed); an unreadable one means the
      // release evaluation is withheld until it can be read again.
      checkinReadError: merged === 'error',
      bitcoinEnabled: txs.some((t) => t.enabled),
      bitcoinTxStored: txs.length > 0,
      primaryApiUrl: state.settings.primaryApiUrl,
      secondaryApiUrl: state.settings.secondaryApiUrl,
      // Per-tx release records (only txs with one) — the cycle-scoped
      // ones are cleared by a check-in, but a stale record survives
      // (it is a fact about the inputs, not the cycle).
      releases: txs.filter((t) => t.release).map((t) => ({
        id: t.id, txid: t.txid, label: t.label || '', ...t.release,
      })),
    });
  }

  // GET /api/checkins
  if (req.method === 'GET' && pathname === '/api/checkins') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, store.readCheckins(DATA_DIR, 50).reverse());
  }

  // GET /api/broadcast/log — dry-runs, broadcasts, release attempts.
  if (req.method === 'GET' && pathname === '/api/broadcast/log') {
    return sendJson(res, 200, store.readBroadcastLog(DATA_DIR, 50).reverse());
  }

  // POST /api/release/check — run the release evaluation now (the full tick runs the same evaluation on the cadence).
  // A receiver check-in is merged inside evaluateRelease first (0.7.12),
  // so a check-in that arrived since the last read is honoured here too.
  if (req.method === 'POST' && pathname === '/api/release/check') {
    const r = await evaluateRelease();
    // MARA-waiting transactions (0.7.16): refresh after the
    // evaluation, so a tx MARA just dropped is retried on the next
    // evaluation, not in this one. The response below is read from
    // fresh state, so it already reflects the refresh.
    try { await refreshMaraWaiting(store.loadState(DATA_DIR)); } catch (e) { console.error('MARA-waiting refresh failed:', e); }
    // Public fallback (0.7.17): after the MARA refresh, so a tx
    // MARA just confirmed as visible is not also fallback-broadcast.
    // Runs regardless of the check-in clock — a due fallback fires
    // even while the clock is on-track.
    let fallbacks = [];
    try { fallbacks = await refreshPublicFallbacks(store.loadState(DATA_DIR)); } catch (e) { console.error('public-fallback refresh failed:', e); }
    state = store.loadState(DATA_DIR);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...r,
      fallbacks,
      status: checkinStatus(state, now),
      releases: txs.filter((t) => t.release).map((t) => ({ id: t.id, txid: t.txid, label: t.label || '', ...t.release })),
    });
  }

  // POST /api/triggers/check — evaluate a trigger ONCE, live, WITHOUT
  // changing any state (0.8.0). The UI calls this when the owner picks
  // a trigger in the Add/Edit form, so the already-true guard can warn
  // before the rule is added ("this condition is already satisfied —
  // it would fire on the next evaluation"). Body { trigger, txId? } — the
  // same shape POST /api/bitcoin/txs accepts, plus an optional txId
  // naming the transaction being edited: for a check-in rule its
  // frozen time (disarmed / vacation) counts, so the guard measures
  // the same effective clock the evaluator uses. A new tx (no txId)
  // has no frozen time. An invalid trigger is
  // a 400 with the reason. A price trigger whose price is already
  // past the threshold (both sources agree) reports fire=true.
  // A UTXO trigger whose outpoint is already spent (confirmed)
  // reports fire=true. A trigger that cannot be read (a feed
  // outage, an outpoint no node can say about) is 'unknown',
  // never a fire.
  if (req.method === 'POST' && pathname === '/api/triggers/check') {
    const body = await readBody(req).catch(() => ({}));
    const v = store.normalizeTrigger(body.trigger);
    if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
    // The frozen time for the tx being edited, if any — only a
    // check-in rule reads it (checkTriggerNow takes it as the
    // clock's live offset); a price or UTXO rule ignores it.
    // A latched block-height rule (0.8.1, audit finding 1) is
    // passed the same way, one latch per rule, so the check
    // answers what the evaluator would answer for this tx.
    let liveOff = 0;
    let latchedTargets = null;
    if (typeof body.txId === 'string' && body.txId) {
      const etx = (state.bitcoin.txs || []).find((t) => t.id === body.txId);
      if (etx) {
        liveOff = checkinLiveOffsetMs(etx, now);
        const slices = Array.isArray(etx.triggerState) ? etx.triggerState
          : (etx.triggerState && typeof etx.triggerState === 'object' ? [etx.triggerState] : []);
        latchedTargets = v.trigger.rules.map((_, i) => {
          const s = slices[i];
          return (s && typeof s.heightReachedFor === 'number') ? s.heightReachedFor : null;
        });
      }
    }
    try {
      const r = await checkTriggerNow(v.trigger, state, now, { liveOffsetMs: liveOff, latchedTargets });
      return sendJson(res, 200, { ...r, trigger: store.serveTrigger(v.trigger) });
    } catch (e) {
      // Belt-and-braces: checkTriggerNow already answers 'unknown'
      // on a fetch failure, so a throw here is a bug — but it must
      // still answer 'unknown', never crash the check.
      return sendJson(res, 200, { valid: true, fire: false, status: 'unknown', reason: 'could not check the trigger — will retry', warning: null, detail: { error: e.message }, trigger: store.serveTrigger(v.trigger) });
    }
  }

  // POST /api/checkin — clears the CHECK-IN rules' cycle-scoped release records:
  // a new cycle starts for them. (0.8.0) A price or UTXO rule's record belongs
  // to its own trigger's cycle, not the check-in clock, so a check-in does
  // not clear it — and does not reset its trigger. A stale record is NOT
  // cleared: spent inputs are a fact about the transaction, not the cycle, so
  // a stale transaction stays stale (and archived) across check-ins — only
  // replacing the hex re-arms it. (If a broadcast already went out, the funds
  // have already moved.) A 'submitted-slipstream' record (0.7.16) IS
  // cleared, like any other non-stale cycle record: the check-in ends
  // the cycle, and the card goes back to Ready — but the transaction
  // is still sitting in MARA's private mempool, and a check-in cannot
  // recall it. If MARA mines it, the public-node lookup (or a fresh
  // dry-run) recognises the tx's own txid out there and records it
  // broadcast; if MARA drops it, the next release re-submits it.
  if (req.method === 'POST' && pathname === '/api/checkin') {
    const body = await readBody(req).catch(() => ({}));
    const method = body.method === 'telegram' ? 'telegram' : 'app';
    const fresh = saveMutation((f) => {
      f.checkin.lastCheckinAt = now.toISOString();
      f.checkin.totalCheckins += 1;
      // A check-in clears an offline-gap hold (0.7.22): the owner is
      // alive, the clock resets, and there is nothing to hold back.
      f.checkin.heldUntil = null;
      for (const t of (f.bitcoin.txs || [])) {
        if (!store.hasTriggerType(t, 'checkin')) continue;
        if (t.release && t.release.status === 'stale') continue;
        t.release = null;
        // The clock restarts at this check-in: any frozen time is
        // wiped, then a tx that is still inactive (disarmed, or on
        // vacation) is re-marked inactive from now — it stays frozen
        // at 0 instead of counting while inactive. Checking in does
        // NOT re-arm anything: there is no global pause to
        // auto-resume any more (0.8.0, Global Arm/Disarm).
        t.checkinOffsetMs = 0;
        t.checkinInactiveSince = null;
      }
      for (const t of (f.bitcoin.txs || [])) syncCheckinFreeze(t, f, now);
    });
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method });
    return sendJson(res, 200, { ok: true, status: checkinStatus(fresh, now) });
  }

  // POST /api/grace/resume — end the price/UTXO grace period
  // immediately (0.8.0). The dashboard's Grace period card
  // offers this while a grace is active; an indefinite grace
  // can only end this way (saving new grace settings never
  // changes an active one). Idempotent: resuming with no grace
  // active is a 200 no-op. Returns the grace state after the
  // resume (null when no grace is active). A check-in does NOT
  // clear the grace — this endpoint is the only way.
  // The resume also refreshes lastOnlineAt to now: the owner
  // just used the live app, so it is online now, and the next
  // read / tick must not re-set a grace on the same stale gap
  // (without this, resuming while the stamp is still stale
  // re-sets the grace on the very next read). This does not
  // touch an already-set check-in hold — heldUntil is only
  // cleared by a check-in — it only stops a NEW hold or grace
  // being set on a gap the owner has already resumed from.
  if (req.method === 'POST' && pathname === '/api/grace/resume') {
    const fresh = saveMutation((f) => {
      f.grace = { graceUntil: null, triggeredAt: null, offlineGapDays: null };
      f.checkin.lastOnlineAt = now.toISOString();
    });
    return sendJson(res, 200, { ok: true, grace: graceStatus(fresh, now) });
  }

  // Check-in API keys (0.6.6) — managed here, used by the check-in
  // receiver. A key is created with a label; the plaintext is returned
  // ONCE in the response and never stored — only its hash is kept, and
  // the hashes are published to the receiver (keys.json) on every
  // change. The list never carries the hash (the UI has no use for
  // it). Revoking a key removes it from state and from the receiver's
  // list, so the next check-in with it is refused.
  //
  // GET    /api/checkin-keys     — list { id, label, createdAt, lastUsedAt }
  // POST   /api/checkin-keys     — create { label } -> 201 { key, plain }
  // DELETE /api/checkin-keys/:id — revoke
  if (req.method === 'GET' && pathname === '/api/checkin-keys') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, (state.checkinKeys || []).map(publicCheckinKey));
  }
  if (req.method === 'POST' && pathname === '/api/checkin-keys') {
    const body = await readBody(req).catch(() => ({}));
    const label = asStr(typeof body.label === 'string' ? body.label.trim() : '', 80) || 'Untitled key';
    const plain = crypto.randomBytes(32).toString('base64url');
    const key = {
      id: newCheckinKeyId(), label, hash: hashCheckinKey(plain),
      createdAt: now.toISOString(), lastUsedAt: null,
    };
    const fresh = saveMutation((f) => {
      f.checkinKeys = f.checkinKeys || [];
      f.checkinKeys.push(key);
    });
    writeReceiverKeys(fresh);
    return sendJson(res, 201, { key: publicCheckinKey(key), plain });
  }
  const keyMatch = pathname.match(/^\/api\/checkin-keys\/([^/]+)$/);
  if (req.method === 'DELETE' && keyMatch) {
    const fresh = saveMutation((f) => {
      const keys = f.checkinKeys || [];
      const idx = keys.findIndex((k) => k.id === keyMatch[1]);
      if (idx === -1) return false;
      keys.splice(idx, 1);
    });
    if (!fresh) return sendError(res, 404, 'no such key');
    writeReceiverKeys(fresh);
    return sendJson(res, 200, { ok: true, removed: keyMatch[1] });
  }

  // POST /api/settings/price-sources/test {provider} (0.8.0):
  // tests one price provider with a FRESH fetch (bypasses the
  // price cache) and returns {provider, price, error}. Accepts
  // any of the five providers, not only the two configured
  // ones. Never changes the configured sources or the cache —
  // the Settings Test button uses this to check a provider
  // before (or without) saving it. A provider that fails
  // answers 200 with price null and the error, so the UI can
  // show the failure inline; only an unknown provider id is a
  // 400.
  if (req.method === 'POST' && pathname === '/api/settings/price-sources/test') {
    const body = await readBody(req);
    const prov = bitcoin.priceProviderById(body && body.provider);
    if (!prov) return sendError(res, 400, 'unknown price provider: ' + (body && body.provider));
    try {
      const price = await bitcoin.fetchPriceFromProvider(prov);
      return sendJson(res, 200, { provider: prov.id, price, error: null });
    } catch (e) {
      return sendJson(res, 200, { provider: prov.id, price: null, error: e.message });
    }
  }

  // POST /api/settings/price-sources/test-all {providers: [...]} (0.8.0):
  // tests several sources at once with FRESH fetches
  // (bypasses the price cache) and returns
  // {results: [{provider, label, price, error}, ...]} in the order
  // requested. Each entry is a provider id string or a custom
  // { id: 'custom', url, path } object (0.8.1). A source that
  // fails answers with price null and the error (the test itself
  // worked — the source is down); only a missing/empty providers
  // array is a 400, and an unknown id inside the list is reported
  // per-result, not as a whole-call failure. Never changes the
  // configured sources or the cache — the Settings "Test
  // connection" button uses this to check both sources in one call.
  if (req.method === 'POST' && pathname === '/api/settings/price-sources/test-all') {
    const body = await readBody(req);
    const ids = (body && Array.isArray(body.providers)) ? body.providers : [];
    if (!ids.length) return sendError(res, 400, 'providers must be a non-empty array');
    const results = await Promise.all(ids.map(async (src) => {
      const prov = bitcoin.resolvePriceSource(src);
      if (!prov) {
        const id = (typeof src === 'string') ? src : 'custom';
        return { provider: id, label: (typeof src === 'string') ? src : 'Custom', price: null, error: 'unknown price provider: ' + id };
      }
      try {
        const price = await bitcoin.fetchPriceFromProvider(prov);
        return { provider: prov.id, label: prov.label, price, error: null };
      } catch (e) {
        return { provider: prov.id, label: prov.label, price: null, error: e.message };
      }
    }));
    return sendJson(res, 200, { results });
  }

  // PUT /api/settings
  // PUT /api/settings (0.8.0): the global broadcast threshold is
  // GONE — each check-in transaction carries its own threshold
  // ("Days of silence", set when the tx is added/edited). A
  // thresholdDays in the body is a 400, not a silent no-op: a
  // stale client must not believe the setting saved. The
  // danger-zone reset tied to the global threshold change is gone
  // with it; the per-tx reset (PUT /api/bitcoin/txs/:id, add /
  // import / arm) stays.
  if (req.method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    const s = state.settings;
    // (0.8.1, audit finding 4) Snapshot for the fresh-state merge
    // below: only the settings this request changed are copied
    // into fresh state at save time.
    const origSettings = { ...s };
    if (body.thresholdDays !== undefined) {
      return sendError(res, 400, 'thresholdDays is no longer a setting — set "Days of silence" on each check-in transaction instead');
    }
    // (0.8.0) `paused` is gone — Global Arm/Disarm replaces it.
    // A stale client must not believe the setting saved.
    if (body.paused !== undefined) {
      return sendError(res, 400, 'paused is no longer a setting — use Global Arm/Disarm instead');
    }
    if (body.primaryApiUrl !== undefined) {
      const v = typeof body.primaryApiUrl === 'string' ? body.primaryApiUrl.trim() : '';
      try { s.primaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : bitcoin.DEFAULT_PUBLIC_API_URL; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.secondaryApiUrl !== undefined) {
      const v = typeof body.secondaryApiUrl === 'string' ? body.secondaryApiUrl.trim() : '';
      try { s.secondaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : ''; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.priceSources !== undefined) {
      const ps = body.priceSources;
      if (!ps || typeof ps !== 'object') return sendError(res, 400, 'priceSources must be {source1, source2}');
      const s1 = bitcoin.normalizePriceSourceValue(ps.source1);
      const s2 = bitcoin.normalizePriceSourceValue(ps.source2);
      if (s1 === null) return sendError(res, 400, priceSourceError(ps.source1));
      if (s2 === null) return sendError(res, 400, priceSourceError(ps.source2));
      if (bitcoin.priceSourceKey(s1) === bitcoin.priceSourceKey(s2)) return sendError(res, 400, 'price sources must be different');
      s.priceSources = { source1: s1, source2: s2 };
    }
    // Grace period (0.8.0): the offline gap that triggers a
    // grace and how long it lasts (null = indefinite, until the
    // owner resumes). Only the values the Settings dropdowns
    // offer are accepted — anything else is a 400. Saving new
    // values does NOT change an already-active grace (it keeps
    // the duration it was created with).
    if (body.graceOfflineDays !== undefined) {
      if (typeof body.graceOfflineDays !== 'number' || !GRACE_OFFLINE_DAYS.includes(body.graceOfflineDays)) {
        return sendError(res, 400, 'graceOfflineDays must be one of ' + GRACE_OFFLINE_DAYS.join(', ') + ' days');
      }
      s.graceOfflineDays = body.graceOfflineDays;
    }
    if (body.graceDurationDays !== undefined) {
      if (body.graceDurationDays !== null && (typeof body.graceDurationDays !== 'number' || !GRACE_DURATION_DAYS.includes(body.graceDurationDays))) {
        return sendError(res, 400, 'graceDurationDays must be one of ' + GRACE_DURATION_DAYS.join(', ') + ' days, or null for indefinite');
      }
      s.graceDurationDays = body.graceDurationDays;
    }
    // User controls (0.8.0): each is a number input with a
    // min/max bound — anything outside is a 400, never a silent
    // clamp. The fee pair is validated together (using the new
    // value where given, the saved value otherwise) so a partial
    // update cannot break the Low-above-Medium invariant.
    if (body.priceAgreementPct !== undefined) {
      if (typeof body.priceAgreementPct !== 'number' || !Number.isFinite(body.priceAgreementPct) || body.priceAgreementPct < PRICE_AGREEMENT_PCT_MIN || body.priceAgreementPct > PRICE_AGREEMENT_PCT_MAX) {
        return sendError(res, 400, 'priceAgreementPct must be a number from ' + PRICE_AGREEMENT_PCT_MIN + ' to ' + PRICE_AGREEMENT_PCT_MAX + ' (%)');
      }
      s.priceAgreementPct = body.priceAgreementPct;
    }
    let cadenceChanged = false;
    if (body.checkCadenceSeconds !== undefined) {
      if (typeof body.checkCadenceSeconds !== 'number' || !Number.isFinite(body.checkCadenceSeconds) || body.checkCadenceSeconds < CHECK_CADENCE_SECONDS_MIN || body.checkCadenceSeconds > CHECK_CADENCE_SECONDS_MAX) {
        return sendError(res, 400, 'checkCadenceSeconds must be a number from ' + CHECK_CADENCE_SECONDS_MIN + ' to ' + CHECK_CADENCE_SECONDS_MAX + ' (seconds)');
      }
      s.checkCadenceSeconds = body.checkCadenceSeconds;
      cadenceChanged = true;
    }
    if (body.feeLowMultiplier !== undefined || body.feeMediumMultiplier !== undefined) {
      const low = (body.feeLowMultiplier !== undefined) ? body.feeLowMultiplier : s.feeLowMultiplier;
      const med = (body.feeMediumMultiplier !== undefined) ? body.feeMediumMultiplier : s.feeMediumMultiplier;
      if (typeof low !== 'number' || !Number.isFinite(low) || low < FEE_LOW_MULT_MIN || low > FEE_LOW_MULT_MAX) {
        return sendError(res, 400, 'feeLowMultiplier must be a number from ' + FEE_LOW_MULT_MIN + ' to ' + FEE_LOW_MULT_MAX + ' (× peak)');
      }
      if (typeof med !== 'number' || !Number.isFinite(med) || med < FEE_MED_MULT_MIN || med > FEE_MED_MULT_MAX) {
        return sendError(res, 400, 'feeMediumMultiplier must be a number from ' + FEE_MED_MULT_MIN + ' to ' + FEE_MED_MULT_MAX + ' (× peak)');
      }
      if (low <= med) {
        return sendError(res, 400, 'feeLowMultiplier must be greater than feeMediumMultiplier');
      }
      if (body.feeLowMultiplier !== undefined) s.feeLowMultiplier = body.feeLowMultiplier;
      if (body.feeMediumMultiplier !== undefined) s.feeMediumMultiplier = body.feeMediumMultiplier;
    }
    // Vacation mode (0.8.0): check-in-only — while it is on, the
    // check-in countdown freezes. vacationUntil is the last away
    // day ('YYYY-MM-DD'); null (or '' from an older client) means
    // indefinite, until the owner says they're back. A change to
    // vacationMode re-syncs the freeze on every check-in tx, so
    // the days away start / stop counting exactly here.
    if (body.vacationMode !== undefined) s.vacationMode = !!body.vacationMode;
    if (body.vacationUntil === null) s.vacationUntil = null;
    else if (body.vacationUntil !== undefined) s.vacationUntil = asStr(body.vacationUntil, 10) || null;
    // (0.8.1, audit finding 4) The assignments above mutated the
    // request's snapshot; only the CHANGED settings ride into fresh
    // state, so a concurrent save is not clobbered. The fee pair is
    // re-checked on the fresh values when this request touched it
    // (a concurrent save could have moved the half it did not set).
    const fresh = saveMutation((f) => {
      for (const k of Object.keys(s)) {
        if (JSON.stringify(s[k]) !== JSON.stringify(origSettings[k])) f.settings[k] = s[k];
      }
      if ((body.feeLowMultiplier !== undefined || body.feeMediumMultiplier !== undefined)
          && !(f.settings.feeLowMultiplier > f.settings.feeMediumMultiplier)) return false;
      if (body.vacationMode !== undefined) {
        for (const t of (f.bitcoin.txs || [])) syncCheckinFreeze(t, f, now);
      }
    });
    if (!fresh) return sendError(res, 400, 'feeLowMultiplier must be greater than feeMediumMultiplier');
    // A new cadence takes effect immediately — the running fast
    // tick is cleared and restarted with the new delay.
    if (cadenceChanged) rearmFullTick();
    return sendJson(res, 200, sanitizeState(fresh).settings);
  }

  // (0.8.0) POST /api/pause and POST /api/resume are gone with
  // the `paused` setting — Global Arm/Disarm (POST
  // /api/bitcoin/txs/arm-all) replaces them. Those paths 404 now.

  // Transactions — the pre-signed list. Adding one arms it (the toggle
  // disarms it). The hex is validated (structure + txid) before
  // storing. The server never sees keys — only the signed hex. Replacing
  // a tx's hex clears its release record and its broadcasted fact (both
  // belong to the old hex — the new one has never been broadcast); the
  // broadcast log keeps the history. Deleting a tx drops its release
  // record with it.
  //
  // POST   /api/bitcoin/txs      — add { txHex, label, notes, broadcastVia? }
  // PUT    /api/bitcoin/txs/:id  — update { txHex?, label?, notes?, enabled?, broadcastVia? }
  // DELETE /api/bitcoin/txs/:id  — remove
  const txsMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)$/);
  // The already-satisfied gate for a rule set (0.8.2): evaluates
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
  // One stored-transaction record, from a parsed tx and its hex —
  // shared by the paste path (POST /api/bitcoin/txs) and the file
  // import path (POST /api/bitcoin/txs/import), so the two cannot
  // drift apart. broadcastVia is the route the transaction goes out
  // on ('public' or 'slipstream', 0.7.16) — default 'public'.
  // publicFallbackDays (0.7.17) is the opt-in public-fallback
  // duration in days, or null for Never (the default).
  // slipstreamFirstAttemptAt (0.7.17) is the ISO timestamp of the
  // first Slipstream broadcast attempt, success or fail — the
  // deadline anchor for a tx whose submit keeps failing. It is set
  // by broadcastOneInner, never by the client, and never overwritten
  // once set.
  // feeSats / feeRateSatVb (0.7.18) are the transaction fee in
  // satoshis and the fee rate in sat/vB, computed from the parent
  // txs on the node at add time (and refreshed by a dry-run, and
  // recomputed at startup — see recomputeStoredFees).
  // null when the parents could not be fetched — the fee is
  // display-only, never a gate, so an unknown fee never blocks an
  // add.
  function newTxRecord(parsed, hex, label, notes, broadcastVia, publicFallbackDays, trigger) {
    return {
      id: store.newTxId(),
      txid: parsed.txid,
      hex,
      label: typeof label === 'string' ? asStr(label, 80) : '',
      notes: typeof notes === 'string' ? asStr(notes, 500) : '',
      createdAt: now.toISOString(),
      inputs: parsed.inputs.length,
      outputs: parsed.outputs.length,
      totalOutSats: parsed.totalOutSats,
      feeSats: null,
      feeRateSatVb: null,
      locktime: parsed.locktime,
      segwit: parsed.segwit,
      enabled: true, // new transactions are armed by default
      // The check-in freeze (0.8.0): the accumulated inactive
      // time and the start of the current inactive period (see
      // syncCheckinFreeze). Only check-in logic reads them; a new
      // tx starts active, at 0 / null.
      checkinOffsetMs: 0,
      checkinInactiveSince: null,
      broadcastVia: validBroadcastVia(broadcastVia),
      publicFallbackDays: validPublicFallbackDays(publicFallbackDays),
      slipstreamFirstAttemptAt: null,
      // The rule that fires this transaction (0.8.0) — already
      // normalized by the caller (see the add / import handlers).
      // triggerState is the trigger's last evaluation, null until
      // the release has evaluated it once.
      trigger,
      triggerState: null,
      // The event trail (0.8.2): starts with the add itself —
      // the rule that was set, in its own words.
      history: [{ ts: now.toISOString(), type: 'added', detail: triggerConditionText(trigger) }],
      release: null,
      // broadcasted is set by broadcastOne() (release or manual) and
      // survives check-ins: { txid, broadcastedAt, method,
      // confirmations, blockHeight, found, checkedAt }.
      broadcasted: null,
    };
  }
  // The fee for a parsed tx, best-effort (0.7.18): null when the
  // node cannot answer (unknown parent, unreachable node). Never
  // throws — an add must never fail because the fee could not be
  // computed.
  async function feeFor(parsed) {
    try { return await bitcoin.computeFee(parsed, bitcoin.endpointsFor(state.settings)); }
    catch { return null; }
  }
  // A transaction is identified by its txid: the same on-chain
  // transaction stored twice is two cards, both armed, for one
  // Bitcoin tx (the second broadcast is a no-op). Reject a txid
  // that is already stored, naming the existing card by its label
  // (or its id when it has no label). `exceptId` is the tx being
  // edited — its own txid is not a duplicate.
  function duplicateTx(txid, exceptId) {
    const dup = (state.bitcoin.txs || []).find((t) => t.txid === txid && t.id !== exceptId);
    return dup ? "This transaction is already stored as '" + (dup.label || dup.id) + "'" : null;
  }
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs') {
    const body = await readBody(req);
    if (typeof body.txHex !== 'string' || !body.txHex.trim()) return sendError(res, 400, 'empty transaction hex');
    const input = body.txHex.trim();
    let hex;
    if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
      // Clean hex — the original paste path.
      hex = input;
    } else {
      // Maybe a pasted PSBT (base64). extractTxFromPsbt detects the
      // format by content. A PSBT that parses but is not fully
      // signed reports its own error (naming the inputs); anything
      // that is not a PSBT at all is an invalid paste, like a
      // corrupt hex.
      try { hex = bitcoin.extractTxFromPsbt(input).hex; }
      catch (e) {
        if (e.message.indexOf('not fully signed') !== -1) return sendError(res, 400, e.message);
        return sendError(res, 400, 'invalid transaction: ' + e.message);
      }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    // (0.8.0) The trigger: validated server-side (an invalid one
    // is a 400 with the reason). Omitted → the check-in trigger at
    // the 35-day fallback, so the old add path is unchanged.
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays, trig.trigger);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    // (0.8.0, extended 0.8.1) The already-satisfied check for a
    // price, UTXO, block-height, set-date, or fee-market rule: a
    // condition that is ALREADY met would fire on the next
    // evaluation, so adding it is a mistake unless the owner
    // confirms it (triggerConfirmed: true). What "met" means
    // depends on the rule: for a price rule both sources must
    // agree the price is past the threshold — a single-source or
    // disagreeing reading is not a fire (checkTriggerNow answers
    // fire: false), so it never blocks the add; for a UTXO rule
    // it depends on the confirmation mode: any spend in
    // unconfirmed mode (0), or a spend with at least N
    // confirmations in N-confirmation mode. For a block-height
    // rule the tip is already at or past the height; for a
    // set-date rule the date has already passed; for a fee-market
    // rule the economy fee is already at or below the threshold.
    // The check is best-effort — a reading no source can say
    // about (unknown) does not block the add; the tick will
    // evaluate it. A UTXO spend that is unconfirmed, or confirmed
    // but below N, is a warning at most, not a block. The warning
    // still rides on the response when the condition is NOT
    // already satisfied, so the UI can say what it found.
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'add');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the add proceeds without the warning */ }
    // (0.7.22, scoped 0.8.0) A new tx is armed by default — adding
    // a CHECK-IN rule while the clock is in the danger zone (the
    // last 25% of ITS window, including already past due) would
    // let the release fire soon after, so the add resets the
    // check-in the same way arming does (server-side, a direct API
    // call cannot bypass it). A price, UTXO, or manual rule does
    // not touch the check-in clock. The zone is measured against
    // the new rule's own threshold, not the global one. Adding
    // with more than 25% of the window left does not reset.
    // (0.8.1, audit finding 4) The push + the reset ride into
    // FRESH state: the fee and trigger checks above awaited the
    // network, so a second request may have saved in between. The
    // duplicate-txid check is re-run on fresh state too — a
    // concurrent add of the same txid would otherwise slip past
    // the stale-side check.
    let checkinReset = false;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const dup = txs.find((t) => t.txid === tx.txid);
      if (dup) { dupTx = dup; return false; }
      if (txs.some((t) => t.id === tx.id)) return false;
      txs.push(tx);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (dupTx) return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the transaction — try again');
    }
    const out = { tx: serveTx(tx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }

  // POST /api/bitcoin/txs/preview — finalize a file's contents and
  // return the raw hex WITHOUT storing anything. The UI calls this
  // when a PSBT file is imported, so the extracted hex can be put
  // in the textarea for the user to label and add via the normal
  // paste path. Body { format: 'hex'|'psbt', data }. Hex is
  // validated exactly like the paste path; a PSBT is finalized
  // exactly like the import path (same errors, including the
  // clearer "not a PSBT file" one). No state change.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/preview') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    return sendJson(res, 200, { hex, txid: parsed.txid });
  }

  // POST /api/bitcoin/txs/import — add a signed transaction from a
  // FILE instead of a paste. Body { format: 'hex'|'psbt', data,
  // label?, notes? }. A hex file is a text file holding the raw
  // transaction hex; it is validated exactly like the paste path
  // (same errors). A PSBT file (.psbt, base64 or raw binary) is
  // finalized server-side — the PSBT must be fully signed, or it is
  // rejected with a clear error naming the inputs that are missing
  // signatures; a partially signed PSBT is never stored. The
  // extracted raw hex is validated by parseTx exactly like a paste
  // before it is stored. The body is capped at 1 MB (MAX_BODY), and
  // the PSBT parser caps the decoded PSBT at 1 MB too.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/import') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    // (0.8.0) The trigger — same validation and already-spent gate
    // as the paste path (see POST /api/bitcoin/txs above).
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays, trig.trigger);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'import');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the import proceeds without the warning */ }
    // (0.7.22, scoped 0.8.0) The import path arms by default too —
    // same reset as the paste path when the clock is in the danger
    // zone, and only for a check-in rule. (0.8.1, audit finding 4)
    // The push + the reset ride into FRESH state (see the paste
    // path above): the fee and trigger checks awaited the network.
    let checkinReset = false;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const dup = txs.find((t) => t.txid === tx.txid);
      if (dup) { dupTx = dup; return false; }
      if (txs.some((t) => t.id === tx.id)) return false;
      txs.push(tx);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (dupTx) return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the transaction — try again');
    }
    const out = { tx: serveTx(tx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }
  if (txsMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txsMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    // (0.8.1, audit finding 4) Snapshot for the fresh-state merge
    // below: only the fields this edit changes are copied into
    // fresh state at save time. (Shallow: the handler replaces
    // trigger/release/broadcasted, never mutates them in place.)
    const orig = { ...tx };
    if (req.method === 'DELETE') {
      // (0.8.1, audit finding 4) The removal rides into FRESH
      // state: the request body was awaited above, so a second
      // request may have saved in between.
      const fresh = saveMutation((f) => {
        if (!(f.bitcoin.txs || []).some((t) => t.id === tx.id)) return false;
        f.bitcoin.txs = (f.bitcoin.txs || []).filter((t) => t.id !== tx.id);
      });
      if (!fresh) return sendError(res, 404, 'no such transaction');
      return sendJson(res, 200, { ok: true, removed: tx.id });
    }
    const body = await readBody(req);
    if (typeof body.txHex === 'string') {
      const hex = body.txHex.trim();
      if (!hex) return sendError(res, 400, 'empty transaction hex');
      let parsed;
      try { parsed = bitcoin.parseTx(hex); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      // The hex is immutable once the transaction is out the door
      // (0.7.16, Pending card): a broadcasted tx, one submitted to
      // Slipstream and waiting on MARA, a stale tx, or a
      // restore-carried 'broadcast' record — all Pending or Archived
      // — cannot be replaced with a DIFFERENT transaction, because
      // that would be a different on-chain tx. Sending the same hex
      // back (unchanged, same txid) is a no-op, not a change, so it
      // is allowed and changes nothing. A 'failed' or 'conflict'
      // record is Active, not locked: its hex can still change.
      const locked = !!(tx.broadcasted || (tx.release
        && (tx.release.status === 'submitted-slipstream' || tx.release.status === 'stale' || tx.release.status === 'broadcast')));
      if (locked && parsed.txid !== tx.txid) {
        return sendError(res, 400, 'the transaction hex cannot be changed once it has been broadcast');
      }
      if (parsed.txid !== tx.txid) {
        // A replacement hex that is another stored transaction's txid
        // is a duplicate; the tx's own hex (unchanged) is fine.
        const dupErr = duplicateTx(parsed.txid, tx.id);
        if (dupErr) return sendError(res, 400, dupErr);
        tx.hex = hex;
        tx.txid = parsed.txid;
        tx.inputs = parsed.inputs.length;
        tx.outputs = parsed.outputs.length;
        tx.totalOutSats = parsed.totalOutSats;
        // A replaced hex is a different transaction: its fee is
        // recomputed from the new inputs (best-effort, null when
        // the parents cannot be fetched).
        const fee = await feeFor(parsed);
        tx.feeSats = fee ? fee.feeSats : null;
        tx.feeRateSatVb = fee ? fee.feeRateSatVb : null;
        tx.locktime = parsed.locktime;
        tx.segwit = parsed.segwit;
        // A replaced hex is a different transaction: the broadcasted fact
        // and any release record belong to the old hex, so both are
        // cleared. The broadcast log keeps the history. (Only reachable
        // for an unlocked tx — a locked tx with a different txid is
        // rejected above, and a locked tx with the same txid takes the
        // no-op path, so its broadcasted fact is never cleared here.)
        tx.release = null;
        tx.broadcasted = null;
      }
    }
    if (typeof body.label === 'string') tx.label = asStr(body.label, 80);
    if (typeof body.notes === 'string') tx.notes = asStr(body.notes, 500);
    // (0.8.0) The trigger: changing it re-rules the transaction.
    // Validated server-side (an invalid one is a 400). A changed
    // trigger starts fresh — the old triggerState (a price's
    // last price, a UTXO's last outspend) belongs to the old
    // condition and must not carry over. The already-satisfied
    // gate (price or UTXO) applies here too (same rule as the add
    // path). Nothing is saved until the end of this handler, so a
    // 400 here discards the label / notes / hex changes above
    // with it.
    let triggerWarning = null;
    if (body.trigger !== undefined) {
      const v = store.normalizeTrigger(body.trigger);
      if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
      // The trigger is locked with the hex and route: a transaction
      // out the door (broadcasted, submitted to Slipstream, stale)
      // has already fired its rule, and re-ruling it now would
      // only rewrite history — the Edit popup disables the picker
      // for a locked tx, and this is the server-side backstop.
      const triggerLocked = !!(tx.broadcasted || (tx.release
        && (tx.release.status === 'submitted-slipstream' || tx.release.status === 'stale' || tx.release.status === 'broadcast')));
      if (triggerLocked && JSON.stringify(v.trigger) !== JSON.stringify(store.triggerOf(tx))) {
        return sendError(res, 400, 'the trigger cannot be changed once the transaction has been broadcast');
      }
      try {
        const gate = await setGateCheck(v.trigger, state, now, 'save');
        if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
        if (gate.blocked && body.triggerConfirmed !== true) {
          return sendError(res, 400, gate.message);
        }
      } catch (e) { /* best-effort: the save proceeds without the warning */ }
      if (JSON.stringify(v.trigger) !== JSON.stringify(tx.trigger)) {
        tx.trigger = v.trigger;
        tx.triggerState = null;
      }
    }
    // (0.7.22, scoped 0.8.0) Arming a CHECK-IN transaction while
    // the clock is in the danger zone (the last 25% of ITS window,
    // including already past due) would let the release fire soon
    // after — a present owner arming a tx should not get a surprise
    // broadcast. A disarmed→armed transition on a live tx (not
    // already broadcasted, not stale — one the release could
    // actually broadcast) resets the check-in instead, server-side
    // so a direct API call cannot bypass it. Arming a price, UTXO,
    // or manual rule does not touch the clock. Disarming, arming
    // outside the zone, and arming a broadcasted / stale tx leave
    // the clock untouched. The zone is measured against the tx's
    // own threshold (after a trigger change above, the new one).
    if (typeof body.enabled === 'boolean') tx.enabled = body.enabled;
    // The route toggle on the card (0.7.16): switching the route
    // applies to the NEXT broadcast attempt — a transaction already
    // submitted to Slipstream is not re-submitted by toggling it
    // (preBroadcastCheck blocks a re-submit while it waits on MARA).
    if (typeof body.broadcastVia === 'string') tx.broadcastVia = validBroadcastVia(body.broadcastVia);
    // The public-fallback duration (0.7.17): changeable on the card
    // and in the edit popup, for Active and Pending txs. It is
    // validated leniently (invalid → Never, never a 400), like the
    // route above. A change while the tx waits on MARA re-times the
    // deadline from the original submittedAt — the deadline is
    // computed from submittedAt at evaluation time (see
    // fallbackDeadline), so no clock is restarted here.
    if (body.publicFallbackDays !== undefined) tx.publicFallbackDays = validPublicFallbackDays(body.publicFallbackDays);
    // (0.8.2) The history events for this edit: an arm/disarm
    // flip logs on its own; any other field change logs as one
    // 'edited' event naming what changed. The events are appended
    // to tx.history here and ride into fresh state through the
    // mutator's field list below ('history' is in it), so a
    // rejected edit (a 400 above) leaves no event behind.
    if (typeof body.enabled === 'boolean' && orig.enabled !== tx.enabled) {
      pushHistory(tx, tx.enabled ? 'armed' : 'disarmed', '');
    }
    const editChanges = [];
    if (orig.label !== tx.label) editChanges.push('Label changed');
    if (JSON.stringify(orig.trigger) !== JSON.stringify(tx.trigger)) editChanges.push('Trigger changed to ' + triggerConditionText(tx.trigger));
    if (orig.hex !== tx.hex) editChanges.push('Transaction replaced');
    if (orig.broadcastVia !== tx.broadcastVia) editChanges.push('Route changed to ' + (tx.broadcastVia === 'slipstream' ? 'Slipstream' : 'Public'));
    if (orig.publicFallbackDays !== tx.publicFallbackDays) editChanges.push('Public fallback changed to ' + (tx.publicFallbackDays === null ? 'Never' : tx.publicFallbackDays + (tx.publicFallbackDays === 1 ? ' day' : ' days')));
    if (orig.notes !== tx.notes) editChanges.push('Notes changed');
    if (editChanges.length) pushHistory(tx, 'edited', editChanges.join('; '));
    let checkinReset = false;
    // (0.8.1, audit finding 4) The edit's field changes were
    // computed on the request's snapshot while the fee and trigger
    // checks awaited the network — only the fields this edit
    // actually changed ride into FRESH state, so a concurrent save
    // is not clobbered. The locks are re-checked on the fresh tx:
    // a tx broadcast in the meantime must not have its hex or
    // trigger rewritten. The freeze and the danger-zone reset are
    // re-evaluated on fresh state too.
    let editError = null;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const ftx = (f.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (!ftx) { editError = 'gone'; return false; }
      const freshLocked = !!(ftx.broadcasted || (ftx.release
        && (ftx.release.status === 'submitted-slipstream' || ftx.release.status === 'stale' || ftx.release.status === 'broadcast')));
      if (orig.hex !== tx.hex && freshLocked && tx.txid !== ftx.txid) { editError = 'locked-hex'; return false; }
      if (JSON.stringify(orig.trigger) !== JSON.stringify(tx.trigger) && freshLocked
          && JSON.stringify(tx.trigger) !== JSON.stringify(store.triggerOf(ftx))) { editError = 'locked-trigger'; return false; }
      if (orig.txid !== tx.txid) {
        const dup = (f.bitcoin.txs || []).find((t) => t.id !== tx.id && t.txid === tx.txid);
        if (dup) { dupTx = dup; editError = 'duplicate'; return false; }
      }
      const freshWasEnabled = ftx.enabled;
      for (const k of ['hex', 'txid', 'inputs', 'outputs', 'totalOutSats', 'locktime', 'segwit', 'feeSats', 'feeRateSatVb', 'release', 'broadcasted', 'label', 'notes', 'trigger', 'triggerState', 'enabled', 'broadcastVia', 'publicFallbackDays', 'history']) {
        if (JSON.stringify(tx[k]) !== JSON.stringify(orig[k])) ftx[k] = tx[k];
      }
      // The freeze (0.8.0): the danger zone is measured from the
      // EFFECTIVE last check-in — the tx's live frozen time — so a
      // frozen clock is never in the danger zone for time that never
      // counted. The freeze is re-synced after the toggle: disarming
      // starts an inactive period, re-arming banks it.
      syncCheckinFreeze(ftx, f, now);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const ftxCheckinThresholds = store.triggerOf(ftx).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (body.enabled === true && freshWasEnabled === false
          && ftxCheckinThresholds.length > 0
          && inDangerZone(f, now, Math.min(...ftxCheckinThresholds), checkinLiveOffsetMs(ftx, now))
          && !ftx.broadcasted && !(ftx.release && ftx.release.status === 'stale')) {
        resetCheckin(f, now, 'arm-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (editError === 'gone') return sendError(res, 404, 'no such transaction');
      if (editError === 'locked-hex') return sendError(res, 400, 'the transaction hex cannot be changed once it has been broadcast');
      if (editError === 'locked-trigger') return sendError(res, 400, 'the trigger cannot be changed once the transaction has been broadcast');
      if (editError === 'duplicate') return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the edit — try again');
    }
    const outTx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    const out = { tx: serveTx(outTx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 200, out);
  }

  // POST /api/bitcoin/txs/arm-all — Global Arm/Disarm (0.8.0):
  // set `enabled` on EVERY staged transaction at once. Body
  // { enabled: true|false }. Applies to all triggers — check-in,
  // price, UTXO, manual. "Arm all" arms EVERYTHING, including
  // transactions individually disarmed before — the owner
  // re-disarms those after if needed. Each check-in tx's freeze
  // is re-synced, so disarming freezes its countdown at the day
  // count it was left at and re-arming resumes from there.
  // Arming a check-in tx in its danger zone resets the check-in
  // (the same 0.7.22 guard as arming one tx), once, and the
  // response names it. Manual broadcasts still work while a tx
  // is disarmed — they never went through the armed toggle.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/arm-all') {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'enabled must be true or false');
    // (0.8.1, audit finding 4) The toggle + freeze sync + reset
    // ride into FRESH state: the request body was awaited above.
    let checkinReset = false;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const newlyArmed = [];
      for (const t of txs) {
        const wasEnabled = t.enabled;
        t.enabled = body.enabled;
        // (0.8.2) An arm/disarm flip logs on the tx it flipped —
        // a no-op toggle (already in that state) logs nothing.
        if (wasEnabled !== body.enabled) pushHistory(t, body.enabled ? 'armed' : 'disarmed', '');
        syncCheckinFreeze(t, f, now);
        if (body.enabled === true && wasEnabled === false) newlyArmed.push(t);
      }
      for (const t of newlyArmed) {
        const checkinThresholds = store.triggerOf(t).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
        if (checkinThresholds.length === 0) continue;
        if (t.broadcasted || (t.release && t.release.status === 'stale')) continue;
        if (inDangerZone(f, now, Math.min(...checkinThresholds), checkinLiveOffsetMs(t, now))) {
          resetCheckin(f, now, 'arm-all-reset');
          checkinReset = true;
          break;
        }
      }
    });
    const freshTxs = fresh.bitcoin.txs || [];
    return sendJson(res, 200, { ok: true, enabled: body.enabled, count: freshTxs.length, checkinReset, txs: serveTxs(freshTxs) });
  }

  // POST /api/bitcoin/txs/:id/broadcast — MANUAL broadcast, now. Same
  // path as the release (freshness gate, then primary with secondary
  // fallback) but on the owner's explicit say-so: it ignores the
  // check-in clock, the armed toggle, and vacation mode. The UI
  // asks first (a confirmation dialog). A tx already broadcast is
  // skipped, never re-sent.
  const txBroadcastMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && txBroadcastMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (tx.broadcasted) {
      return sendJson(res, 200, { ok: true, id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast', tx: serveTx(tx) });
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast');
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/bitcoin/txs/:id/broadcast-public — the MANUAL escape
  // hatch for a slow MARA tx (0.7.16, Pending card). A transaction
  // submitted to Slipstream and waiting on MARA is private until
  // MARA mines it; if the owner does not want to wait, this
  // broadcasts it via the PUBLIC route instead (mempool.space, then
  // blockstream.info), right now, on the owner's explicit say-so.
  // It applies ONLY to a Slipstream-pending tx (release status
  // 'submitted-slipstream') — a public-pending tx is already public,
  // and an active tx uses the route toggle. On success the
  // broadcasted fact is set, the stored route becomes 'public', and
  // the tx is public-pending (confirmed -> Archived, as usual). On
  // failure the error is surfaced and the tx STAYS Slipstream-pending
  // (no 'failed' record is written — MARA is still holding it).
  // MANUAL ONLY: it is not reachable from the release evaluation or
  // Broadcast Armed — only this endpoint calls broadcastOne with
  // forcePublic, and only for the one tx named here.
  const txBroadcastPublicMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast-public$/);
  if (req.method === 'POST' && txBroadcastPublicMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastPublicMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (!(tx.release && tx.release.status === 'submitted-slipstream')) {
      return sendError(res, 400, 'only a transaction waiting on MARA (Slipstream-pending) can be broadcast publicly');
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast', { forcePublic: true });
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/broadcast/all — MANUAL broadcast of the transactions
  // that are NOT in the Archived Transactions card (broadcasted, or
  // already declared stale) — those are never attempted or counted.
  // The UI sends their ids (it knows the archived set). Without ids
  // (an older client or a direct API call) the same rule applies from
  // what the server can see: the broadcasted ones, and the ones
  // already declared stale — by a release, a manual broadcast, or a
  // dry-run, whose stale verdict is now recorded on the transaction.
  // Each is broadcast through the same path (freshness gate, then primary
  // with secondary fallback); a stale or failed tx does not stop the
  // others. The UI asks first (a confirmation dialog).
  // Body { armedOnly: true } (round 12) sends only the armed
  // (enabled) transactions — a disarmed id in the list is skipped,
  // not sent. The broadcast guards are the same either way.
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req).catch(() => ({}));
    const armedOnly = !!(body && body.armedOnly);
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        // A transaction already submitted to Slipstream is not
        // re-submitted (0.7.16) — it is waiting on MARA, and the
        // MARA-waiting refresh is what moves it on.
        if (!tx.broadcasted && !(tx.release && tx.release.status === 'submitted-slipstream')) targets.push(tx);
      }
    } else {
      targets = txs.filter((t) => !t.broadcasted && !(t.release && t.release.status === 'stale')
        && !(t.release && t.release.status === 'submitted-slipstream'));
    }
    if (armedOnly) targets = targets.filter((t) => t.enabled);
    if (!targets.length) return sendError(res, 400, armedOnly ? 'nothing to broadcast — no armed transactions to broadcast' : 'nothing to broadcast — every transaction is already archived or pending');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of targets) {
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast'));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }

  // GET /api/bitcoin/confirmations — the confirmation count for every
  // broadcast transaction, refreshed from the network unless checked
  // less than a minute ago (the UI polls this; the hourly tick
  // refreshes it too). A failed lookup keeps the last known value.
  if (req.method === 'GET' && pathname === '/api/bitcoin/confirmations') {
    const refreshed = await refreshConfirmations(state, 60);
    return sendJson(res, 200, { confirmations: refreshed });
  }

  // GET /api/backup — the whole setup as one JSON document: settings,
  // every signed transaction (hex included), the check-in clock, and
  // the recent check-in + broadcast history. Restoring it (POST
  // /api/restore) puts the app back exactly where the backup was taken.
  // The file contains the signed hexes, which reveal the destination
  // addresses and amounts — treat it like the transactions themselves.
  // It also carries the check-in key hashes (not the keys — those were
  // never stored), so a restored setup keeps its keys working.
  if (req.method === 'GET' && pathname === '/api/backup') {
    // (0.8.2) The backup carries the SERVED form of each tx (a
    // one-rule set as its single rule) — restore accepts both
    // shapes, and the backup is compared against the served
    // triggers after a restore, so the backup must match what
    // the UI sees.
    const backupState = JSON.parse(JSON.stringify(state));
    backupState.bitcoin.txs = serveTxs(backupState.bitcoin.txs || []);
    return sendJson(res, 200, {
      format: 'standby-backup',
      version: 1,
      app: 'standby',
      exportedAt: now.toISOString(),
      state: backupState,
      checkins: store.readCheckins(DATA_DIR, 200),
      broadcastLog: store.readBroadcastLog(DATA_DIR, 200),
    });
  }

  // POST /api/restore — restore a backup document (the parsed JSON from
  // a downloaded backup). Validates before touching anything: the
  // format and version, the settings, and every transaction's hex
  // (each hex is re-parsed and all derived fields are recomputed from
  // it, so a corrupt or hand-edited backup cannot store a bad tx).
  // Replaces the state wholesale; the logs are replaced too when the
  // backup carries them. Returns the restored transaction count.
  if (req.method === 'POST' && pathname === '/api/restore') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || body.format !== 'standby-backup') {
      return sendError(res, 400, 'not a Standby backup file (format must be standby-backup)');
    }
    if (body.version !== 1) return sendError(res, 400, 'unsupported backup version: ' + body.version);
    const bs = body.state;
    if (!bs || typeof bs !== 'object' || !bs.settings || typeof bs.settings !== 'object'
        || !bs.bitcoin || typeof bs.bitcoin !== 'object' || !Array.isArray(bs.bitcoin.txs)) {
      return sendError(res, 400, 'backup is missing the state (settings + transactions)');
    }
    const bsSettings = bs.settings;
    const settings = {
      primaryApiUrl: bitcoin.DEFAULT_PUBLIC_API_URL,
      secondaryApiUrl: '',
      // (0.8.0) `paused` is gone — a backup carrying it restores
      // WITHOUT it (ignored, not an error). vacationUntil is null
      // for indefinite, a 'YYYY-MM-DD' date otherwise; anything
      // else (including a legacy '') restores as null.
      vacationMode: !!bsSettings.vacationMode,
      vacationUntil: (typeof bsSettings.vacationUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bsSettings.vacationUntil))
        ? bsSettings.vacationUntil : null,
    };
    if (typeof bsSettings.primaryApiUrl === 'string' && bsSettings.primaryApiUrl.trim()) {
      try { settings.primaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.primaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup primary node URL: ' + e.message); }
    }
    if (typeof bsSettings.secondaryApiUrl === 'string' && bsSettings.secondaryApiUrl.trim()) {
      try { settings.secondaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.secondaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup secondary node URL: ' + e.message); }
    }
    // (0.8.0) The price sources ride along: a backup from before
    // 0.8.0 carries none, which restores as the defaults; a present
    // but invalid pair rejects the whole restore, like a bad node URL.
    if (bsSettings.priceSources !== undefined && bsSettings.priceSources !== null) {
      const ps = bsSettings.priceSources;
      if (!ps || typeof ps !== 'object') return sendError(res, 400, 'backup priceSources must be {source1, source2}');
      const s1 = bitcoin.normalizePriceSourceValue(ps.source1);
      const s2 = bitcoin.normalizePriceSourceValue(ps.source2);
      if (s1 === null) return sendError(res, 400, 'backup ' + priceSourceError(ps.source1));
      if (s2 === null) return sendError(res, 400, 'backup ' + priceSourceError(ps.source2));
      if (bitcoin.priceSourceKey(s1) === bitcoin.priceSourceKey(s2)) return sendError(res, 400, 'backup price sources must be different');
      settings.priceSources = { source1: s1, source2: s2 };
    } else {
      settings.priceSources = { source1: 'coingecko', source2: 'coinbase' };
    }
    // (0.8.0) The grace settings ride along the same way: a backup
    // from before 0.8.0 carries none, which restores as the defaults
    // (7 days offline to trigger, 7-day grace); a present but invalid
    // value rejects the whole restore, like a bad node URL. The active
    // grace itself does NOT ride along — a restore counts as a check-in
    // (the owner is present), so the grace is cleared, just like the
    // check-in hold (heldUntil).
    if (bsSettings.graceOfflineDays !== undefined && bsSettings.graceOfflineDays !== null) {
      if (typeof bsSettings.graceOfflineDays !== 'number' || !GRACE_OFFLINE_DAYS.includes(bsSettings.graceOfflineDays)) {
        return sendError(res, 400, 'backup graceOfflineDays must be one of ' + GRACE_OFFLINE_DAYS.join(', ') + ' days');
      }
      settings.graceOfflineDays = bsSettings.graceOfflineDays;
    } else {
      settings.graceOfflineDays = 7;
    }
    if (bsSettings.graceDurationDays !== undefined) {
      if (bsSettings.graceDurationDays !== null && (typeof bsSettings.graceDurationDays !== 'number' || !GRACE_DURATION_DAYS.includes(bsSettings.graceDurationDays))) {
        return sendError(res, 400, 'backup graceDurationDays must be one of ' + GRACE_DURATION_DAYS.join(', ') + ' days, or null for indefinite');
      }
      settings.graceDurationDays = bsSettings.graceDurationDays;
    } else {
      settings.graceDurationDays = 7;
    }
    // (0.8.0) The price-agreement, check-cadence, and fee-verdict
    // settings ride along the same way: a backup from before
    // 0.8.0 carries none, which restores as the defaults; a
    // present but invalid value rejects the whole restore, like a
    // bad node URL. The fee pair is validated together (using
    // the backup's value where present, the default otherwise)
    // so a partial pair cannot break the Low-above-Medium
    // invariant.
    if (bsSettings.priceAgreementPct !== undefined && bsSettings.priceAgreementPct !== null) {
      if (typeof bsSettings.priceAgreementPct !== 'number' || !Number.isFinite(bsSettings.priceAgreementPct) || bsSettings.priceAgreementPct < PRICE_AGREEMENT_PCT_MIN || bsSettings.priceAgreementPct > PRICE_AGREEMENT_PCT_MAX) {
        return sendError(res, 400, 'backup priceAgreementPct must be a number from ' + PRICE_AGREEMENT_PCT_MIN + ' to ' + PRICE_AGREEMENT_PCT_MAX + ' (%)');
      }
      settings.priceAgreementPct = bsSettings.priceAgreementPct;
    } else {
      settings.priceAgreementPct = PRICE_AGREEMENT_PCT_DEFAULT;
    }
    if (bsSettings.checkCadenceSeconds !== undefined && bsSettings.checkCadenceSeconds !== null) {
      if (typeof bsSettings.checkCadenceSeconds !== 'number' || !Number.isFinite(bsSettings.checkCadenceSeconds) || bsSettings.checkCadenceSeconds < CHECK_CADENCE_SECONDS_MIN || bsSettings.checkCadenceSeconds > CHECK_CADENCE_SECONDS_MAX) {
        return sendError(res, 400, 'backup checkCadenceSeconds must be a number from ' + CHECK_CADENCE_SECONDS_MIN + ' to ' + CHECK_CADENCE_SECONDS_MAX + ' (seconds)');
      }
      settings.checkCadenceSeconds = bsSettings.checkCadenceSeconds;
    } else {
      settings.checkCadenceSeconds = CHECK_CADENCE_SECONDS_DEFAULT;
    }
    if (bsSettings.feeLowMultiplier !== undefined || bsSettings.feeMediumMultiplier !== undefined) {
      const low = (bsSettings.feeLowMultiplier !== undefined && bsSettings.feeLowMultiplier !== null) ? bsSettings.feeLowMultiplier : FEE_LOW_MULT_DEFAULT;
      const med = (bsSettings.feeMediumMultiplier !== undefined && bsSettings.feeMediumMultiplier !== null) ? bsSettings.feeMediumMultiplier : FEE_MED_MULT_DEFAULT;
      if (typeof low !== 'number' || !Number.isFinite(low) || low < FEE_LOW_MULT_MIN || low > FEE_LOW_MULT_MAX) {
        return sendError(res, 400, 'backup feeLowMultiplier must be a number from ' + FEE_LOW_MULT_MIN + ' to ' + FEE_LOW_MULT_MAX + ' (× peak)');
      }
      if (typeof med !== 'number' || !Number.isFinite(med) || med < FEE_MED_MULT_MIN || med > FEE_MED_MULT_MAX) {
        return sendError(res, 400, 'backup feeMediumMultiplier must be a number from ' + FEE_MED_MULT_MIN + ' to ' + FEE_MED_MULT_MAX + ' (× peak)');
      }
      if (low <= med) {
        return sendError(res, 400, 'backup feeLowMultiplier must be greater than feeMediumMultiplier');
      }
      settings.feeLowMultiplier = low;
      settings.feeMediumMultiplier = med;
    } else {
      settings.feeLowMultiplier = FEE_LOW_MULT_DEFAULT;
      settings.feeMediumMultiplier = FEE_MED_MULT_DEFAULT;
    }
    const txs = [];
    const seenIds = new Set();
    for (const t of bs.bitcoin.txs) {
      if (!t || typeof t.hex !== 'string' || !t.hex.trim()) {
        return sendError(res, 400, 'backup transaction is missing its hex');
      }
      let parsed;
      try { parsed = bitcoin.parseTx(t.hex.trim()); }
      catch (e) { return sendError(res, 400, 'backup transaction hex is invalid: ' + e.message); }
      // (0.7.12, third-audit finding 4; tightened in 0.7.13,
      // fourth-audit finding 1) A release record is only believed
      // when its status is one the app itself writes, its txid is a
      // string equal to the txid of the hex in this same backup
      // entry, and its kind (when present) is one the app writes.
      // The txid is REQUIRED: the 0.7.12 check only rejected a txid
      // when one was present and wrong, so {"release":{"status":
      // "stale"}} passed and permanently disabled a transaction
      // that was never broadcast. A broadcasted record is only
      // believed when its txid is that txid. Anything else rejects
      // the WHOLE restore — a corrupt or hand-edited backup must not
      // silently mark a transaction stale, or resurrect a broadcast
      // that never happened. (0.8.1, audit finding: even a
      // txid-matching broadcast/stale claim is not believed — it is
      // dropped when the restored tx is built below, and the network
      // re-derives it. The check here still rejects a malformed or
      // mismatched record outright.) A record the app wrote always passes:
      // every writer carries txid = the tx's txid (broadcastOneInner
      // paths, dry-run verdict writes) and kind in RELEASE_KINDS,
      // and the 0.4.0 migration guarantees txid on older records.
      if (t.release !== undefined && t.release !== null) {
        if (typeof t.release !== 'object' || !RELEASE_STATUSES.has(t.release.status)
            || typeof t.release.txid !== 'string' || t.release.txid !== parsed.txid
            || (t.release.kind !== undefined && !RELEASE_KINDS.has(t.release.kind))) {
          return sendError(res, 400, 'backup transaction release record is invalid');
        }
      }
      if (t.broadcasted !== undefined && t.broadcasted !== null) {
        if (typeof t.broadcasted !== 'object' || t.broadcasted.txid !== parsed.txid) {
          return sendError(res, 400, 'backup transaction broadcast record does not match its hex');
        }
      }
      let id = (typeof t.id === 'string' && t.id) ? asStr(t.id, 40) : '';
      if (!id || seenIds.has(id)) id = store.newTxId();
      seenIds.add(id);
      // (0.8.2) The rule set rides through validation (the same
      // per-rule rules as a single trigger), and the triggerState
      // is normalized to the rule count — a flat object wraps to
      // one element, an array is sanitized / padded / truncated,
      // a malformed one restores as null (the evaluator overwrites
      // it on the next evaluation anyway).
      const restoredTrigger = store.triggerOf(t);
      txs.push({
        id,
        txid: parsed.txid,
        hex: t.hex.trim(),
        label: asStr(t.label || '', 80),
        notes: asStr(t.notes || '', 500),
        createdAt: (typeof t.createdAt === 'string' && t.createdAt) ? t.createdAt : now.toISOString(),
        inputs: parsed.inputs.length,
        outputs: parsed.outputs.length,
        totalOutSats: parsed.totalOutSats,
        // The fee (0.7.18): carried through when present (a number
        // or null); a backup from before 0.7.18 carries no fee,
        // which restores as null — the same as an older record
        // loaded from disk. A negative or non-finite value is not
        // believed either.
        feeSats: (typeof t.feeSats === 'number' && Number.isFinite(t.feeSats) && t.feeSats >= 0) ? t.feeSats : null,
        feeRateSatVb: (typeof t.feeRateSatVb === 'number' && Number.isFinite(t.feeRateSatVb) && t.feeRateSatVb >= 0) ? t.feeRateSatVb : null,
        locktime: parsed.locktime,
        segwit: parsed.segwit,
        enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
        // The check-in freeze (0.8.0): carried through when
        // valid; a backup from before the redesign carries none,
        // which restores as 0 / null — the same as an older record
        // loaded from disk. (The restore itself counts as a
        // check-in, so the offsets are reset to the new clock
        // below — this carry-through is what validates them.)
        checkinOffsetMs: (typeof t.checkinOffsetMs === 'number' && Number.isFinite(t.checkinOffsetMs) && t.checkinOffsetMs >= 0) ? t.checkinOffsetMs : 0,
        checkinInactiveSince: (typeof t.checkinInactiveSince === 'string' && t.checkinInactiveSince && !Number.isNaN(new Date(t.checkinInactiveSince).getTime())) ? t.checkinInactiveSince : null,
        // The broadcast route (0.7.16): a backup from before 0.7.16
        // carries no route, which restores as 'public' — the same
        // as an older record loaded from disk.
        broadcastVia: validBroadcastVia(t.broadcastVia),
        // The public fallback (0.7.17): a backup from before 0.7.17
        // carries no duration, which restores as Never (null) — the
        // same as an older record loaded from disk. The first-attempt
        // timestamp rides along too (an unparseable one is dropped);
        // without it a restored failing-submit tx would have no
        // fallback deadline until its next attempt.
        publicFallbackDays: validPublicFallbackDays(t.publicFallbackDays),
        slipstreamFirstAttemptAt: (typeof t.slipstreamFirstAttemptAt === 'string'
          && !Number.isNaN(new Date(t.slipstreamFirstAttemptAt).getTime())) ? t.slipstreamFirstAttemptAt : null,
        // The trigger (0.8.0, rule sets 0.8.2): carried through
        // when valid — a single trigger or a rule set; a backup
        // from before 0.8.0 carries none, which restores as the
        // check-in trigger at the 35-day fallback — the same as
        // an older record loaded from disk. An invalid trigger in a
        // hand-edited backup falls back the same way (like the
        // route and fallback above: lenient, never a 400 — a bad
        // trigger must not reject a whole restore). The
        // triggerState rides along too, normalized to the rule
        // count (a malformed one restores as null — the evaluator
        // overwrites it on the next evaluation anyway).
        trigger: restoredTrigger,
        triggerState: store.normalizeTriggerState(t.triggerState, restoredTrigger.rules.length),
        // (0.8.1, audit finding: restored `broadcasted` records)
        // A broadcasted fact — or a release record claiming the tx
        // already went out ('broadcast') or is spent ('stale') — is
        // NOT believed from a backup on txid match alone: a
        // hand-edited backup could falsely mark a transaction
        // broadcast, or permanently disable one as stale. Both are
        // re-derived from the network on the next evaluation (the
        // freshness gate recognises a tx already out there, and
        // marks spent inputs stale), so the restore drops them and
        // the tx comes back active. 'failed', 'conflict', and
        // 'submitted-slipstream' records are transient and
        // self-correcting, so they ride along.
        release: (t.release && (t.release.status === 'broadcast' || t.release.status === 'stale')) ? null : (t.release ? t.release : null),
        broadcasted: null,
        // (0.8.2) The event trail rides along when it is well
        // formed — display-only, so a hand-edited backup cannot
        // hurt anything by forging it. The same distrust as the
        // records above applies to its broadcast claims: a
        // 'broadcast', 'confirmed', or 'stale' event from the
        // backup is dropped with the record it describes, and the
        // network re-derives it. A backup from before 0.8.2
        // carries no history (null) — the load-time backfill seeds
        // it from the restored facts on the next load.
        history: Array.isArray(t.history)
          ? t.history.filter((e) => e && typeof e === 'object' && store.HISTORY_TYPES.has(e.type)
              && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
              && typeof e.detail === 'string'
              && e.type !== 'broadcast' && e.type !== 'confirmed' && e.type !== 'stale').slice(-HISTORY_MAX)
          : null,
      });
    }
    const bsCheckin = (bs.checkin && typeof bs.checkin === 'object') ? bs.checkin : {};
    // (0.7.12, third-audit finding 4) The check-in time must be a
    // real date and not in the future (beyond the same 5-minute skew
    // the receiver merge allows). An invalid date makes checkinStatus
    // throw on every status read (new Date(NaN).toISOString()), and a
    // far-future date would silently postpone the release forever.
    // Anything else rejects the WHOLE restore before anything is
    // applied. A real backup always carries a valid ISO timestamp
    // (or null, for a setup that has never checked in), so this
    // cannot reject a backup the app itself wrote.
    let lastCheckinAt = null;
    if (bsCheckin.lastCheckinAt !== undefined && bsCheckin.lastCheckinAt !== null) {
      if (typeof bsCheckin.lastCheckinAt !== 'string') {
        return sendError(res, 400, 'backup check-in time is invalid');
      }
      const at = new Date(bsCheckin.lastCheckinAt);
      if (Number.isNaN(at.getTime())) {
        return sendError(res, 400, 'backup check-in time is not a valid date');
      }
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
        return sendError(res, 400, 'backup check-in time is in the future');
      }
      lastCheckinAt = bsCheckin.lastCheckinAt;
    }
    // (0.7.22) The "I was online" stamp rides along the same way:
    // a real date (or null), never in the future beyond the same
    // 5-minute skew — a future stamp would hide a real offline gap
    // and defeat the hold. The hold itself (heldUntil) is a date
    // or null; it is legitimately in the future (that is the point
    // of a hold), so it is only checked for being a real date —
    // a backup the app itself wrote always carries a valid one.
    let lastOnlineAt = null;
    if (bsCheckin.lastOnlineAt !== undefined && bsCheckin.lastOnlineAt !== null) {
      if (typeof bsCheckin.lastOnlineAt !== 'string') {
        return sendError(res, 400, 'backup last-online time is invalid');
      }
      const at = new Date(bsCheckin.lastOnlineAt);
      if (Number.isNaN(at.getTime())) {
        return sendError(res, 400, 'backup last-online time is not a valid date');
      }
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
        return sendError(res, 400, 'backup last-online time is in the future');
      }
      lastOnlineAt = bsCheckin.lastOnlineAt;
    }
    let heldUntil = null;
    if (bsCheckin.heldUntil !== undefined && bsCheckin.heldUntil !== null) {
      if (typeof bsCheckin.heldUntil !== 'string' || Number.isNaN(new Date(bsCheckin.heldUntil).getTime())) {
        return sendError(res, 400, 'backup hold time is invalid');
      }
      heldUntil = bsCheckin.heldUntil;
    }
    // Check-in API keys ride along in the backup (hashes only — the
    // plaintext keys were never stored, so a backup cannot leak them).
    // A malformed key entry rejects the restore, like a bad tx hex. A
    // backup from before 0.6.6 carries no keys at all, which restores
    // as an empty list.
    const restoredKeys = [];
    if (Array.isArray(bs.checkinKeys)) {
      for (const k of bs.checkinKeys) {
        if (!k || typeof k !== 'object' || typeof k.id !== 'string' || !k.id
            || typeof k.label !== 'string' || typeof k.hash !== 'string'
            || !/^[0-9a-f]{64}$/.test(k.hash)) {
          return sendError(res, 400, 'backup check-in key entry is invalid');
        }
        restoredKeys.push({
          id: asStr(k.id, 40), label: asStr(k.label, 80), hash: k.hash,
          createdAt: (typeof k.createdAt === 'string' && k.createdAt) ? k.createdAt : now.toISOString(),
          lastUsedAt: (typeof k.lastUsedAt === 'string' || k.lastUsedAt === null) ? (k.lastUsedAt || null) : null,
        });
      }
    }
    const restored = {
      version: 7,
      createdAt: (typeof bs.createdAt === 'string' && bs.createdAt) ? bs.createdAt : now.toISOString(),
      updatedAt: now.toISOString(),
      settings,
      bitcoin: {
        txs,
        connection: (bs.bitcoin.connection && typeof bs.bitcoin.connection === 'object')
          ? bs.bitcoin.connection : { ok: null, checkedAt: null, detail: '' },
      },
      checkin: {
        // (0.7.22) A restore is proof the owner is present, so it
        // counts as a check-in: the clock starts clean at the
        // restore moment. The backup's clock is still VALIDATED
        // above (a corrupt or future-dated clock rejects the whole
        // restore) — it is just not carried forward: lastCheckinAt
        // and lastOnlineAt are now, heldUntil is cleared, and the
        // count keeps the backup's total plus this restore.
        lastCheckinAt: now.toISOString(),
        totalCheckins: clampInt(bsCheckin.totalCheckins, 0, 0, 1000000) + 1,
        lastOnlineAt: now.toISOString(),
        heldUntil: null,
      },
      checkinKeys: restoredKeys,
    };
    // (0.8.0) The restore counts as a check-in (see the clock
    // comment above): the offsets are measured against the OLD
    // clock, so they are reset to the new one — a carried offset
    // would otherwise push the effective last check-in into the
    // future and the bar would read a negative count. A tx that
    // is still inactive (disarmed, or the restored vacation is
    // on) is re-marked inactive from now, so it stays frozen at 0.
    for (const t of txs) {
      if (!store.hasTriggerType(t, 'checkin')) continue;
      t.checkinOffsetMs = 0;
      t.checkinInactiveSince = null;
    }
    for (const t of txs) syncCheckinFreeze(t, restored, now);
    store.saveState(DATA_DIR, restored);
    // A restored cadence takes effect immediately — the running
    // fast tick is cleared and restarted with it.
    rearmFullTick();
    // The receiver's key list matches the restored state from now on.
    writeReceiverKeys(restored);
    if (Array.isArray(body.checkins)) store.writeCheckins(DATA_DIR, body.checkins.slice(-200));
    if (Array.isArray(body.broadcastLog)) store.writeBroadcastLog(DATA_DIR, body.broadcastLog.slice(-200));
    // (0.7.22) The restore itself is a check-in — record it in
    // the history so the displayed last check-in matches the
    // refreshed clock. Appended after the backup's own history
    // (above), so it is the most recent entry; the method reads
    // 'restore' in the recent-check-ins list.
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method: 'restore' });
    // The restored state is served the same way as a read (a
    // one-rule set as its single rule — see GET /api/state).
    const servedRestored = sanitizeState(restored);
    servedRestored.bitcoin.txs = serveTxs(servedRestored.bitcoin.txs || []);
    return sendJson(res, 200, { ok: true, restoredTxs: txs.length, state: servedRestored });
  }

  // POST /api/bitcoin/connection/test — verifies both nodes without
  // moving funds. Saves the result (including the per-endpoint results)
  // so the Dashboard can show each node's own status. The app is OK if
  // either one answers (the other is the backup).
  if (req.method === 'POST' && pathname === '/api/bitcoin/connection/test') {
    const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings));
    const conn = { ok: r.ok, checkedAt: now.toISOString(), detail: r.detail, results: r.results };
    // (0.8.1, audit finding 4) The node test awaited the network —
    // only the connection result rides into FRESH state.
    saveMutation((f) => { f.bitcoin.connection = conn; });
    return sendJson(res, 200, { ok: r.ok, detail: r.detail, results: r.results });
  }

  // POST /api/broadcast/test — DRY-RUN validation. Checks the stored
  // txs' inputs are still unspent via the primary node (falling back to
  // the secondary) and reports whether a broadcast would be attempted.
  // Never broadcasts anything.
  // Body { id } dry-runs one transaction; no id dry-runs all stored
  // ones. Every transaction is checked, armed or not — a dry-run is a
  // read-only test, and a signed transaction should be testable the
  // moment it is stored. The aggregate "would broadcast" count stays
  // armed-only (that is the release-relevant number). A failed check on
  // one tx does not stop the others.
  // A dry-run all only tests the transactions that could still
  // broadcast. One that has already been broadcast, or whose inputs
  // were already declared spent, is left out of the results and the
  // aggregate — the run gives it no new status. (A single dry-run of
  // one transaction still tests it: the owner asked for that one.)
  // A spent verdict is recorded on the transaction (a stale release
  // record, kind 'dryrun'): staleness is a fact about the inputs, so
  // the card stays Stale — and stays in the Archived Transactions
  // card — across refreshes and check-ins. Before 0.6.5 the verdict
  // lived only in the page's memory, so a dry-run-declared stale
  // transaction popped back to Ready on every refresh.
  if (req.method === 'POST' && pathname === '/api/broadcast/test') {
    const body = await readBody(req).catch(() => ({}));
    let txs = state.bitcoin.txs || [];
    if (body && body.id) {
      const one = txs.find((t) => t.id === body.id);
      if (!one) return sendError(res, 404, 'no such transaction');
      txs = [one];
    }
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    const results = [];
    for (const tx of txs) {
      if (!body.id && (tx.broadcasted || (tx.release && tx.release.status === 'stale'))) {
        continue;
      }
      try {
        const r = await bitcoin.dryRun(DATA_DIR, { tx, endpoints: bitcoin.endpointsFor(state.settings) });
        // (0.8.0) A price rule's dry-run note carries the source
        // detail — which sources were used, their readings,
        // single-source fallback, or that they disagreed — because
        // the subcard and the readiness card no longer repeat it
        // (it lives in the Exchange Status section and here, in
        // the dry-run notes). A price-fetch failure never breaks
        // the dry run itself; the note just says so.
        const trg = store.triggerOf(tx);
        if (trg && store.hasTriggerType(tx, 'price')) {
          try {
            const readings = await fetchPriceCached(priceSourcesOf(state.settings), checkCadenceSecondsOf(state.settings));
            const comb = bitcoin.combinePriceReadings(readings, priceAgreementPctOf(state.settings));
            let srcDetail;
            if (comb.mode === 'disagree' || comb.mode === 'none') {
              srcDetail = comb.reason.charAt(0).toUpperCase() + comb.reason.slice(1);
            } else {
              srcDetail = 'Price sources: ' + comb.note;
            }
            r.note = (r.note || '') + ' ' + srcDetail + '.';
          } catch (e) {
            r.note = (r.note || '') + ' Price sources: could not be checked.';
          }
        }
        results.push({ id: tx.id, label: tx.label || '', enabled: !!tx.enabled, ...r });
      } catch (e) {
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', enabled: !!tx.enabled, broadcastVia: validBroadcastVia(tx.broadcastVia), wouldBroadcast: false, error: e.message });
      }
    }
    // Persist what the run found (0.7.12, third-audit finding 1 —
    // three cases, not just stale): a broadcasted transaction is never
    // re-marked (its broadcast record takes precedence), and a stale
    // verdict is a fact and is left alone once recorded. An own-txid
    // spend is recorded as broadcast — recognition, not a re-send;
    // the dry-run never broadcasts, and neither does the record. A
    // conflict warning is re-derived on every fresh check: a clean
    // verdict clears it (the unconfirmed spend was evicted), a
    // confirmed spend turns it stale. The dry-run log entry (written
    // by bitcoin.dryRun) already records the run itself, so no second
    // log entry is written here.
    // (0.8.1, audit finding 4) The verdicts are network facts
    // collected above; only the per-tx updates ride into FRESH
    // state, with the same guards re-evaluated there — a tx
    // broadcast or deleted while the run was on the network must
    // not have its record rewritten from this stale snapshot.
    const actions = [];
    for (const r of results) {
      const a = { id: r.id };
      // The fee (0.7.18): a dry-run OVERWRITES the stored fee with
      // the freshly computed one — the input values were fetched
      // from the node for the freshness check anyway. A fee stored
      // wrong (e.g. by the units bug, which read the parent value
      // as BTC) self-corrects on the next dry-run instead of
      // lingering; a null result (the node could not answer) leaves
      // the stored fee alone.
      if (r.fee && typeof r.fee.feeSats === 'number') {
        a.fee = { feeSats: r.fee.feeSats, feeRateSatVb: (typeof r.fee.feeRateSatVb === 'number') ? r.fee.feeRateSatVb : null };
      }
      if (r.spent && r.spent.length) {
        a.stale = { method: r.checkedVia, error: 'inputs spent: ' + r.spent.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ') };
      } else if (r.own && r.own.length) {
        a.own = { method: r.checkedVia, blockHeight: r.own[0].blockHeight != null ? r.own[0].blockHeight : null };
      } else if (r.conflict && r.conflict.length) {
        a.conflict = { method: r.checkedVia, error: 'inputs spent by an unconfirmed transaction: ' + r.conflict.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ') };
      } else if (r.verdict === 'ready') {
        // A clean verdict re-derives the warning away: the unconfirmed
        // spend was evicted, so the transaction is ready again. Only a
        // 'ready' verdict clears — an 'unknown' verdict cannot prove
        // the input unspent, so the warning stands on ambiguous data.
        a.clearConflict = true;
      }
      if (a.fee || a.stale || a.own || a.conflict || a.clearConflict) actions.push(a);
    }
    if (actions.length) {
      saveMutation((f) => {
        for (const a of actions) {
          const ftx = (f.bitcoin.txs || []).find((t) => t.id === a.id);
          if (!ftx || ftx.broadcasted) continue;
          if (a.fee) {
            ftx.feeSats = a.fee.feeSats;
            ftx.feeRateSatVb = a.fee.feeRateSatVb;
          }
          if (a.stale) {
            if (ftx.release && ftx.release.status === 'stale') continue;
            ftx.release = { status: 'stale', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.stale.method, lastAttemptAt: now.toISOString(), error: a.stale.error };
            // (0.8.2) The dry run discovered the staleness — the
            // tx's history should say so, not just its card.
            pushHistory(ftx, 'stale', a.stale.error);
            continue;
          }
          if (a.own) {
            // Repair, don't overwrite: a release that already went out
            // keeps its kind ('release'); a broadcasted fact keeps the
            // confirmations it already has. A restore could have left
            // one half of the pair behind — the check that just proved
            // the tx is out there fills in the missing half.
            if (!ftx.broadcasted) {
              ftx.broadcasted = {
                txid: ftx.txid, broadcastedAt: now.toISOString(), method: a.own.method,
                confirmations: null, blockHeight: a.own.blockHeight, found: true, checkedAt: now.toISOString(),
              };
              // (0.8.2) The dry run discovered the tx is out there.
              pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(ftx.txid));
              if (a.own.blockHeight != null) pushHistory(ftx, 'confirmed', 'Block ' + a.own.blockHeight.toLocaleString('en-US'));
            }
            if (!ftx.release || ftx.release.status !== 'broadcast') {
              ftx.release = { status: 'broadcast', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.own.method, broadcastedAt: now.toISOString() };
            }
            continue;
          }
          if (a.conflict) {
            if (ftx.release && ftx.release.status === 'stale') continue;
            ftx.release = { status: 'conflict', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.conflict.method, lastAttemptAt: now.toISOString(), error: a.conflict.error };
            // (0.8.2) The warning on the card gets its history line.
            pushHistory(ftx, 'conflict', a.conflict.error);
            continue;
          }
          if (a.clearConflict && ftx.release && ftx.release.status === 'conflict') ftx.release = null;
        }
      });
    }
    const armed = results.filter((r) => r.enabled);
    // 'would broadcast' counts the transactions that would actually
    // land: a timelocked transaction is attempted (its per-result
    // wouldBroadcast is true — the release will try it) but the node
    // will reject it as non-final until the locktime passes, so it is
    // not counted here. It is named separately, so the summary never
    // implies it will successfully broadcast right now. A
    // Slipstream-route transaction is named separately too (0.7.16):
    // it would be submitted to MARA, not broadcast to the public
    // mempool — so if every would-be transaction is Slipstream, the
    // summary says "would submit to Slipstream"; if only some are,
    // it says how many are via Slipstream.
    const would = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked').length;
    const slipstream = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked' && r.broadcastVia === 'slipstream').length;
    const stale = armed.filter((r) => r.spent && r.spent.length).length;
    const timelocked = armed.filter((r) => r.verdict === 'timelocked').length;
    // Dry-run all also checks that no input is spent by two stored
    // transactions: only one of them can ever be confirmed, so the shared
    // input is flagged on both cards. A single dry-run does not run
    // this check — it is a property of the whole list. Archived
    // transactions are excluded from the check (round 12): their fate
    // is decided, so a live transaction sharing an input with an
    // archived one is not warned about it.
    const overlaps = body && body.id ? [] : bitcoin.findSharedInputs(state.bitcoin.txs || []);
    const overlapNote = overlaps.length
      ? ' Warning: ' + overlaps.length + ' input(s) are shared across transactions — only one transaction per shared input can ever be confirmed: '
        + overlaps.map((o) => o.input.slice(0, 12) + ':' + o.input.split(':')[1] + ' in ' + o.txIds.length + ' transactions').join('; ') + '.'
      : '';
    const note = results.length === 1
      ? (results[0].note || results[0].error || '')
      : results.length === 0
        ? 'No transactions to check — every stored transaction has already been broadcast or is stale.'
        : would + ' of ' + armed.length + ' armed transaction(s) would '
          + (slipstream > 0 && slipstream === would ? 'submit to Slipstream' : 'broadcast')
          + (slipstream > 0 && slipstream < would ? ' (' + slipstream + ' via Slipstream)' : '')
          + (stale ? ', ' + stale + ' stale' : '') + (timelocked ? ', ' + timelocked + ' timelocked' : '') + '.';
    return sendJson(res, 200, { ok: true, dryRun: true, results, wouldBroadcast: would > 0, overlaps, note: note + overlapNote });
  }

  return sendError(res, 404, 'unknown API route');
}

// Stored fees self-correct at startup (0.7.18, fee units fix): a
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
    });
    return;
  }
  try { serveStatic(req, res, pathname); }
  catch (e) { console.error(e); if (!res.headersSent) sendError(res, 500, 'static file error'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Standby ${VERSION} listening on :${PORT} (data: ${DATA_DIR})`);
});

// Release-evaluation timers (0.8.2): the full tick runs once
// shortly after startup and then every checkCadenceSeconds; the
// hourly tick runs once shortly after startup and then hourly.
// The startup fee recompute runs once shortly after startup too
// — see recomputeStoredFees. The fee peak is fetched once shortly
// after startup (the hourly tick refreshes it daily after that)
// — see refreshFeePeakIfStale.
setTimeout(runFullTick, 5000);
setTimeout(runHourlyTick, 5000);
setTimeout(recomputeStoredFees, 5000);
setTimeout(refreshFeePeakIfStale, 2000);
setTimeout(refreshCurrentFeesIfStale, 2000);
setTimeout(refreshPriceIfStale, 2000); // 0.8.0: a price rule's "currently $X" line is live on first load
setInterval(runHourlyTick, 60 * 60 * 1000);
// The full tick (0.8.2): every rule type is evaluated every
// checkCadenceSeconds (Settings: Check cadence; default 60) while
// one non-manual rule is armed. The interval is re-armed from the
// saved setting whenever the setting changes (PUT /api/settings,
// restore), so a new cadence takes effect without a restart — the
// old interval is cleared first, so there is never more than one
// full tick running.
let fullTickTimer = null;
function rearmFullTick() {
  if (fullTickTimer) clearInterval(fullTickTimer);
  fullTickTimer = setInterval(runFullTick, checkCadenceSecondsOf(store.loadState(DATA_DIR).settings) * 1000);
}
rearmFullTick();
