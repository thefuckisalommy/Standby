'use strict';
// Standby — check-in keys, grace, vacation, check-in clock.
const store = require('./store');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { CHECKIN_DIR, DATA_DIR } = require('./config');
const { GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, days } = require('./util');

// State as served: a deep copy without the check-in key hashes (the UI
// never needs them). Only the backup carries them, so restored keys keep
// working.
function sanitizeState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  if (Array.isArray(copy.checkinKeys)) copy.checkinKeys = copy.checkinKeys.map(publicCheckinKey);
  return copy;
}

// Check-in API keys. A key authorizes exactly one thing: recording a
// check-in through the receiver, which has no route to the transactions.
// - The plaintext key is returned once and never stored; only its SHA-256
//   hash is kept.
// - Hashes are published to the receiver in CHECKIN_DIR/keys.json, read
//   fresh per request, so a revocation is immediate.
// - The receiver writes CHECKIN_DIR/last.json; mergeExternalCheckin folds
//   a newer timestamp into the clock like POST /api/checkin (clearing
//   cycle records, never a stale one). Idempotent.
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
    // Durable write: a lost keys.json write could revive a revoked key or
    // lose a new one.
    store.writeFileDurable(file, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    // No shared directory (bare run, no receiver): the keys are inert. If
    // it exists, a failed write would leave a revoked key valid, so say so
    // loudly.
    if (fs.existsSync(CHECKIN_DIR)) {
      console.error('Standby: ERROR: could not update the receiver key list (' + path.join(CHECKIN_DIR, 'keys.json') + '): ' + e.message
        + ' — a key created or revoked just now is NOT in effect at the receiver until this is fixed.');
    }
  }
}

// Read the receiver's keys.json: 'missing', 'ok' or 'error' (like
// readExternalCheckin). Only entries with a string id and hash count.
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

// Startup warnings from the key-store check, kept for this process, served
// on GET /api/state, deduped by code.
const startupWarnings = [];
function addStartupWarning(code, message) {
  if (startupWarnings.some((w) => w.code === code)) return;
  startupWarnings.push({ code, message, at: new Date().toISOString() });
}

// Startup key-store check (keys live in state and in the receiver's
// keys.json):
// - state has keys, receiver missing or different: rewrite the receiver
//   file from state and log it
// - state empty, receiver has keys: warn only (they may be the only
//   copies; restoring is the owner's call)
// - state empty, a backup has keys: warn, naming the backup
// If both sides lost the keys, the daily backups are the recovery.
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

// Read the receiver's last check-in: 'missing' (no file: not an error),
// 'ok', or 'error' (exists but unreadable: a check-in may be hidden there,
// so no release while it stands). Missing is decided by ENOENT, not
// existsSync, which is also false on EACCES.
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

// Fold a newer receiver check-in into the clock. true when applied (saved
// and logged); false for nothing to apply (missing, more than 5 minutes in
// the future, or not newer); 'error' when unreadable. Release callers must
// treat 'error' as do not proceed.
function mergeExternalCheckin(state, now) {
  const ext = readExternalCheckin();
  if (ext.status === 'error') return 'error';
  if (ext.status === 'missing') return false;
  if (ext.at.getTime() > now.getTime() + 5 * 60 * 1000) return false;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (last && ext.at.getTime() <= last.getTime()) return false;
  state.checkin.lastCheckinAt = ext.raw;
  state.checkin.totalCheckins += 1;
  // A check-in clears only the check-in rules' cycle records (price and
  // UTXO records belong to their own triggers); stale records survive.
  for (const t of (state.bitcoin.txs || [])) {
    if (!store.hasTriggerType(t, 'checkin')) continue;
    if (t.release && t.release.status === 'stale') continue;
    t.release = null;
    // The clock restarts here: frozen time is wiped, and a still-inactive
    // tx is re-marked inactive from now (frozen at 0).
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

// Grace period: state.grace = { graceUntil (null = until resumed),
// triggeredAt, offlineGapDays }. Set on an offline gap past
// graceOfflineDays, or by the check-in outage leg in applyGrace; never
// while one is active; cleared only by expiry or POST /api/grace/resume,
// not by a check-in. It holds every trigger type and does not push check-
// in due dates out. graceEnabled false (or a stored duration of 0) means
// no grace at all.
function graceIsEnabled(settings) {
  const s = settings || {};
  if (s.graceEnabled === false) return false;
  if (s.graceEnabled === undefined && s.graceDurationDays === 0) return false;
  return true;
}
function graceStatus(state, now) {
  const g = (state && state.grace && typeof state.grace === 'object') ? state.grace : null;
  if (!g || !g.triggeredAt) return null;
  // Grace off reads as no grace everywhere, even for a record set earlier;
  // the record stays and resumes if re-enabled before it expires.
  if (!graceIsEnabled(state.settings)) return null;
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
// The smallest threshold among armed check-in rules that can fire
// (standalone txs and sets; a member's parked trigger never counts). null
// when none: the check-in leg then has nothing to protect.
function smallestArmedCheckinThresholdDays(state) {
  const txs = state.bitcoin.txs || [];
  const memberIds = new Set();
  for (const s of (state.bitcoin.sets || [])) for (const id of (s.txIds || [])) memberIds.add(id);
  const thresholds = [];
  for (const t of txs) {
    if (!t.enabled || memberIds.has(t.id) || !store.hasTriggerType(t, 'checkin')) continue;
    for (const r of store.triggerOf(t).rules) if (r.type === 'checkin') thresholds.push(r.params.thresholdDays);
  }
  for (const s of (state.bitcoin.sets || [])) {
    if (!s.enabled || !store.hasTriggerType(s, 'checkin')) continue;
    for (const r of store.triggerOf(s).rules) if (r.type === 'checkin') thresholds.push(r.params.thresholdDays);
  }
  return thresholds.length ? Math.min.apply(null, thresholds) : null;
}

// Start a grace on an offline gap when either the gap exceeds
// graceOfflineDays, or it exceeds a quarter of the shortest armed check-in
// threshold with over half of it elapsed since the last check-in (so a
// 1-day rule is protected after a 6-hour outage). The grant is
// graceDurationDays either way. Runs on evaluation, on state and status
// reads and on the full tick, so a returning app notices the gap before
// anything fires. Returns true when it set one.
function applyGrace(state, now) {
  if (isGraceActive(state, now)) return false;
  const online = state.checkin && state.checkin.lastOnlineAt ? new Date(state.checkin.lastOnlineAt) : null;
  if (!online || Number.isNaN(online.getTime())) return false;
  const s = state.settings || {};
  if (!graceIsEnabled(s)) return false; // grace disabled: never set one
  const offlineDays = (typeof s.graceOfflineDays === 'number' && GRACE_OFFLINE_DAYS.includes(s.graceOfflineDays)) ? s.graceOfflineDays : 7;
  const gapMs = now.getTime() - online.getTime();
  let activates = gapMs > offlineDays * 86400000;
  if (!activates) {
    // The check-in leg only applies when a check-in rule is armed.
    const thresholdDays = smallestArmedCheckinThresholdDays(state);
    if (thresholdDays !== null) {
      const thresholdMs = thresholdDays * 86400000;
      const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
      if (last && !Number.isNaN(last.getTime())
        && gapMs > thresholdMs / 4
        && now.getTime() - last.getTime() > thresholdMs / 2) activates = true;
    }
  }
  if (!activates) return false;
  const durationDays = (s.graceDurationDays === null) ? null
    : ((typeof s.graceDurationDays === 'number' && GRACE_DURATION_DAYS.includes(s.graceDurationDays)) ? s.graceDurationDays : 7);
  if (durationDays === 0) return false; // grace disabled: never set one
  state.grace = {
    graceUntil: durationDays === null ? null : new Date(now.getTime() + durationDays * 86400000).toISOString(),
    triggeredAt: now.toISOString(),
    offlineGapDays: Math.floor(gapMs / 86400000),
  };
  return true;
}

// The danger zone: the last 25% of a check-in window (past due included),
// measured from the effective last check-in (liveOffsetMs is the tx's
// frozen time). Arming, adding or shortening inside it resets the check-in
// instead of letting a due release fire.
function inDangerZone(state, now, thresholdDays, liveOffsetMs) {
  if (!state.checkin.lastCheckinAt || !thresholdDays || thresholdDays <= 0) return false;
  const thresholdMs = thresholdDays * 86400000;
  const off = (typeof liveOffsetMs === 'number' && Number.isFinite(liveOffsetMs) && liveOffsetMs >= 0) ? liveOffsetMs : 0;
  const dueMs = new Date(state.checkin.lastCheckinAt).getTime() + off + thresholdMs;
  return (dueMs - now.getTime()) <= 0.25 * thresholdMs;
}

// Reset the check-in clock when the owner is present and about to let a
// due release fire (arming, adding or shortening into the danger zone).
// Restarts at now and records it in the check-in history; never touches a
// release record.
function resetCheckin(state, now, method) {
  state.checkin.lastCheckinAt = now.toISOString();
  state.checkin.totalCheckins += 1;
  state.checkin.lastOnlineAt = now.toISOString();
  // The clock restarts now: frozen time is wiped (it would push the
  // effective check-in into the future); a still-inactive tx is re-marked
  // from now.
  for (const t of (state.bitcoin.txs || [])) {
    if (!store.hasTriggerType(t, 'checkin')) continue;
    t.checkinOffsetMs = 0;
    t.checkinInactiveSince = null;
  }
  for (const t of (state.bitcoin.txs || [])) syncCheckinFreeze(t, state, now);
  // A set's check-in freeze resets the same way — the
  // set's own offset is measured against the old clock too.
  for (const s of (state.bitcoin.sets || [])) {
    if (!store.hasTriggerType(s, 'checkin')) continue;
    s.checkinOffsetMs = 0;
    s.checkinInactiveSince = null;
  }
  for (const s of (state.bitcoin.sets || [])) syncCheckinFreeze(s, state, now);
  store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method });
}

// The check-in freeze: inactive time (disarmed, including Global Disarm,
// or on vacation) does not count. One per-tx offset covers every cause, so
// overlapping causes count once:
// - checkinOffsetMs: banked inactive time
// - checkinInactiveSince: start of the open inactive period, or null
// checkinLiveOffsetMs is the total right now; syncCheckinFreeze runs on
// every active/inactive transition, and does not restart an already-open
// period.
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

// A dated vacation ends after vacationUntil (local time); an indefinite
// one never expires on its own. On expiry the freeze is banked so the days
// away never count. Returns true when it ended one.
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

// The pure check-in clock at a threshold: state 'not-started', 'on-track'
// or 'release-due', windowDays and daysSince (display). The decision
// compares real timestamps, not floored days. The grace never pushes the
// due out (a held past-due rule reads 'grace' elsewhere); heldMs and
// heldActive stay in the shape for older readers.
function checkinClock(state, now, thresholdDays, liveOffsetMs) {
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  if (!last || !thresholdDays || thresholdDays <= 0) {
    return { dueMs: null, heldMs: null, heldActive: false, effectiveDueMs: null, nextDue: null, windowDays: null, daysSince: null, state: 'not-started' };
  }
  // Measured from the effective last check-in (real plus frozen time); due
  // and window shift together, so the window stays the threshold.
  const off = (typeof liveOffsetMs === 'number' && Number.isFinite(liveOffsetMs) && liveOffsetMs >= 0) ? liveOffsetMs : 0;
  const effLast = new Date(last.getTime() + off);
  const d = Math.max(0, days(effLast, now));
  const dueMs = effLast.getTime() + thresholdDays * 86400000;
  const nextDue = new Date(dueMs).toISOString();
  // The bar's window in whole days, from the effective last check-in to
  // the due.
  const windowDays = Math.max(1, Math.round((dueMs - effLast.getTime()) / 86400000));
  const st = now.getTime() < dueMs ? 'on-track' : 'release-due';
  return { dueMs, heldMs: null, heldActive: false, effectiveDueMs: dueMs, nextDue, windowDays, daysSince: d, state: st };
}

// A tx whose fate is decided gets no check-in bar: broadcast, or recorded
// stale, Slipstream-pending or broadcast. Failed and conflict txs are
// still owed a broadcast and keep theirs.
function txSettledOrPending(t) {
  if (t.broadcasted) return true;
  const rs = t.release && t.release.status;
  return rs === 'stale' || rs === 'submitted-slipstream' || rs === 'broadcast';
}
// The check-in status served to the UI. Each armed check-in rule has its
// own countdown (checkinTxs: one entry per active check-in rule, with its
// threshold, days, due and state); a disarmed one keeps a frozen bar. The
// top-level state, due and window come from armed entries only:
// 'not-started', 'on-track', 'release-due', 'grace' (past due but held:
// nothing can fire, and the due is not pushed out) or 'broadcasted' once a
// release has finished every armed check-in tx (a failed one keeps it due).
// A check-in clears the cycle records, so it returns to on-track.
function checkinStatus(state, now) {
  const s = state.settings;
  const last = state.checkin.lastCheckinAt ? new Date(state.checkin.lastCheckinAt) : null;
  const txs = state.bitcoin.txs || [];
  const isCheckinTx = (t) => store.hasTriggerType(t, 'checkin');
  // One entry per check-in rule (each with its ruleIndex). Set members get
  // none of their own; the set gets one per rule with its own label, arm
  // state and offset.
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
        // Past due while a grace is active reads 'grace',
        // not 'release-due' — the rule is held, it cannot fire.
        const st = (isGraceActive(state, now) && clock.state === 'release-due') ? 'grace' : clock.state;
        return { id: t.id, label: t.label || '', ruleIndex, thresholdDays: th, daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue, state: st, enabled: !!t.enabled };
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
      const st = (isGraceActive(state, now) && clock.state === 'release-due') ? 'grace' : clock.state;
      checkinTxs.push({ id: s.id, label: s.label || '', ruleIndex, thresholdDays: th, daysSince: clock.daysSince, windowDays: clock.windowDays, nextDue: clock.nextDue, state: st, enabled: !!s.enabled });
    });
  }
  // The top level comes from armed entries only; with none armed, due is
  // null and daysSince is the first disarmed entry's frozen count.
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
  // An armed check-in tx with a 'failed' record keeps the status release-
  // due (it is retried); disarmed, stale and never-attempted txs do not.
  // Only check-in txs count here.
  const anyFailed = txs.some((t) => t.enabled && isCheckinTx(t) && t.release && t.release.status === 'failed');
  // A tx waiting on MARA means the release is not done, so the status is
  // not 'broadcasted' (armed txs only).
  const anyWaitingMara = txs.some((t) => t.enabled && isCheckinTx(t) && t.release && t.release.status === 'submitted-slipstream');
  if (!anyFailed && !anyWaitingMara && txs.some((t) => isCheckinTx(t) && t.release && t.release.status === 'broadcast' && t.release.kind === 'release')) {
    return { ...base, state: 'broadcasted', label: 'Broadcasted' };
  }
  // Only armed check-in txs can make the card release-due; during a grace
  // a past-due armed entry makes it 'grace'.
  if (armedEntries.some((c) => c.state === 'grace')) return { ...base, state: 'grace', label: 'Grace period' };
  if (armedEntries.some((c) => c.state === 'release-due')) return { ...base, state: 'release-due', label: 'Release due' };
  return { ...base, state: 'on-track', label: 'On track' };
}

module.exports = { sanitizeState, hashCheckinKey, newCheckinKeyId, publicCheckinKey, writeReceiverKeys, readReceiverKeys, startupWarnings, addStartupWarning, verifyCheckinKeyStore, readExternalCheckin, mergeExternalCheckin, graceStatus, isGraceActive, applyGrace, inDangerZone, resetCheckin, checkinLiveOffsetMs, syncCheckinFreeze, vacationEndMs, expireVacation, checkinClock, txSettledOrPending, checkinStatus };
