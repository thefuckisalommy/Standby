'use strict';
// Standby — check-in keys, grace, vacation, check-in clock (split from server.js, 0.8.7.3).
const store = require('./store');
const bitcoin = require('./bitcoin');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { CHECKIN_DIR, DATA_DIR } = require('./config');
const { GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, days } = require('./util');

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

// Read the receiver's key list (CHECKIN_DIR/keys.json) — tri-state,
// like readExternalCheckin below: 'missing' (no file — no receiver
// installed), 'ok' (a parsed {keys:[...]} list), 'error'
// (unreadable or unparseable). Only entries with a string id and
// hash count; anything else is dropped, never trusted.
function readReceiverKeys() {
  const file = path.join(CHECKIN_DIR, 'keys.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', keys: [] };
    return { status: 'error', error: e.message, keys: [] };
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.keys)) {
      return { status: 'error', error: 'keys.json is not a key list', keys: [] };
    }
    return {
      status: 'ok',
      keys: doc.keys.filter((k) => k && typeof k.id === 'string' && typeof k.hash === 'string'),
    };
  } catch (e) {
    return { status: 'error', error: e.message, keys: [] };
  }
}

// Warnings recorded at startup (0.8.3) — the check-in key-store
// verification below. Kept in memory for the life of the process
// and served on GET /api/state alongside the persistence layer's
// warnings, so the UI can show them (a later increment). Deduped
// by code: the check runs once at startup, but a warning is a
// fact about this run either way.
const startupWarnings = [];
function addStartupWarning(code, message) {
  if (startupWarnings.some((w) => w.code === code)) return;
  startupWarnings.push({ code, message, at: new Date().toISOString() });
}

// (0.8.3) Startup check-in key-store verification. The Nov 19
// incident: state.checkinKeys AND the receiver's keys.json were
// both empty — the old "Muse check-in" key was gone from both
// sides, cause undetermined (the 0.8.1 update or a Settings
// deletion; the app logged no key deletes). writeReceiverKeys
// only ran on create/revoke/restore, never on startup, so a
// divergence could sit unnoticed until the next check-in 401'd.
// This runs once at startup and compares the two sides:
//   state has keys + receiver missing/unreadable/mismatched ->
//     rewrite the receiver file from state (state is the source
//     of truth) and log it.
//   state empty + receiver has keys -> warn only. The receiver is
//     NOT overwritten (its keys may be the only copies left) and
//     keys are NOT auto-restored into state — that is a manual
//     decision by the owner.
//   state empty + a backup has keys -> warn, naming the backup.
//     Again, no auto-restore.
// Honest limit: this check does NOT recover the Nov 19 case —
// both sides were empty there. The daily backup (0.8.3) is what
// covers that case.
function verifyCheckinKeyStore() {
  try {
    const state = store.loadState(DATA_DIR);
    const stateKeys = Array.isArray(state.checkinKeys) ? state.checkinKeys : [];
    const recv = readReceiverKeys();
    const sameKeys = (a, b) => {
      if (a.length !== b.length) return false;
      const byId = new Map(a.map((k) => [k.id, k.hash]));
      return b.every((k) => byId.get(k.id) === k.hash);
    };
    if (stateKeys.length > 0) {
      if (recv.status !== 'ok' || !sameKeys(stateKeys, recv.keys)) {
        writeReceiverKeys(state);
        const why = recv.status === 'missing' ? 'missing'
          : recv.status === 'error' ? 'unreadable (' + recv.error + ')' : 'out of sync with state';
        const msg = 'Standby: receiver keys.json was ' + why + '; rewrote it from state (' + stateKeys.length + ' key(s))';
        console.warn(msg);
        addStartupWarning('receiver-keys-rewritten', msg);
      }
      return;
    }
    // State has no keys.
    if (recv.status === 'ok' && recv.keys.length > 0) {
      const msg = 'Standby: state has no check-in keys but the receiver still lists ' + recv.keys.length
        + ' key(s); receiver left untouched — restore the keys from a backup if they were lost';
      console.warn(msg);
      addStartupWarning('receiver-keys-orphaned', msg);
    }
    const backup = store.findBackupWithKeys(DATA_DIR);
    if (backup) {
      const msg = 'Standby: state has no check-in keys, but backup ' + backup.file + ' holds ' + backup.count
        + ' key(s); recovery is a manual decision — restore that backup if the keys were lost';
      console.warn(msg);
      addStartupWarning('keys-in-backup', msg);
    }
  } catch (e) {
    console.error('Standby: startup check-in key verification failed:', e.message);
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
  // (0.8.7) A set's check-in freeze resets the same way — the
  // set's own offset is measured against the old clock too.
  for (const s of (state.bitcoin.sets || [])) {
    if (!store.hasTriggerType(s, 'checkin')) continue;
    s.checkinOffsetMs = 0;
    s.checkinInactiveSince = null;
  }
  for (const s of (state.bitcoin.sets || [])) syncCheckinFreeze(s, state, now);
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
  // (0.8.7) A set member's own check-in trigger is dormant while
  // it is attached — the set's trigger is the one that fires — so
  // members get no bar of their own; the set gets one per rule,
  // like a tx, with the set's own label, arm state, and frozen
  // offset.
  const setMemberIds = new Set();
  for (const s of (state.bitcoin.sets || [])) for (const id of (s.txIds || [])) setMemberIds.add(id);
  const checkinTxs = txs
    .filter((t) => isCheckinTx(t) && !txSettledOrPending(t) && !setMemberIds.has(t.id))
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
  for (const s of (state.bitcoin.sets || [])) {
    if (!store.hasTriggerType(s, 'checkin')) continue;
    const members = txs.filter((t) => (s.txIds || []).includes(t.id));
    if (!members.length || members.every(txSettledOrPending)) continue;
    store.triggerOf(s).rules.forEach((rule, ruleIndex) => {
      if (rule.type !== 'checkin') return;
      const th = rule.params.thresholdDays;
      const off = checkinLiveOffsetMs(s, now);
      if (!last) {
        checkinTxs.push({ id: s.id, label: s.label || '', ruleIndex, thresholdDays: th, daysSince: 0, windowDays: th, nextDue: null, state: 'not-started', enabled: !!s.enabled });
        return;
      }
      const clock = checkinClock(state, now, th, off);
      checkinTxs.push({ id: s.id, label: s.label || '', ruleIndex, thresholdDays: th, daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue, state: clock.state, enabled: !!s.enabled });
    });
  }
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

module.exports = { sanitizeState, hashCheckinKey, newCheckinKeyId, publicCheckinKey, writeReceiverKeys, readReceiverKeys, startupWarnings, addStartupWarning, verifyCheckinKeyStore, readExternalCheckin, mergeExternalCheckin, applyOfflineHold, graceStatus, isGraceActive, applyGrace, inDangerZone, resetCheckin, checkinLiveOffsetMs, syncCheckinFreeze, vacationEndMs, expireVacation, checkinClock, txSettledOrPending, checkinStatus };
