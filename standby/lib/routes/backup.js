'use strict';
const store = require('../store');
const bitcoin = require('../bitcoin');
const rpc = require('../rpc');
const { sanitizeState, startupWarnings, syncCheckinFreeze, writeReceiverKeys } = require('../checkin');
const { DATA_DIR, RESTORE_CHECK_MS } = require('../config');
const backupcrypto = require('../backupcrypto');
const { HISTORY_MAX } = require('../history');
const { priceSourceError } = require('../prices');
const { rearmFullTick } = require('../release');
const { dryRunAndRecord } = require('../verdicts');
const { serveSets, serveTxs } = require('../triggers');
const { CHECK_CADENCE_SECONDS_DEFAULT, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, FEE_LOW_MULT_DEFAULT, FEE_LOW_MULT_MAX, FEE_LOW_MULT_MIN, FEE_MED_MULT_DEFAULT, FEE_MED_MULT_MAX, FEE_MED_MULT_MIN, GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, PRICE_AGREEMENT_PCT_DEFAULT, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN, asStr, clampInt, readBody, sendError, sendJson, validBroadcastVia, validPublicFallbackDays } = require('../util');
const { NEXT } = require('./shared');

const RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
// Release record kinds: 'release' (automatic), 'broadcast' (manual),
// 'dryrun' (a dry-run verdict).
const RELEASE_KINDS = new Set(['release', 'broadcast', 'dryrun']);

module.exports = async function backupRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/backup { password? }: the whole setup as one document
  // (settings, every signed hex, the clock, recent logs, check-in key
  // hashes so keys keep working), encrypted when a password is given
  // (lib/backupcrypto.js). The hexes reveal destinations and amounts:
  // treat it like the transactions. POST only, so a password never lands
  // in a URL and the plain backup is never one link away.
  const buildBackup = () => {
    // The backup carries the served form of each tx (a one-rule set as its
    // rule); restore accepts both shapes.
    const backupState = JSON.parse(JSON.stringify(state));
    backupState.bitcoin.txs = serveTxs(backupState.bitcoin.txs || []);
    backupState.bitcoin.sets = serveSets(backupState.bitcoin.sets || []);
    return {
      format: 'standby-backup',
      version: 1,
      app: 'standby',
      exportedAt: now.toISOString(),
      state: backupState,
      checkins: store.readCheckins(DATA_DIR, 200),
      broadcastLog: store.readBroadcastLog(DATA_DIR, 200),
    };
  };
  if (req.method === 'POST' && pathname === '/api/backup') {
    const body = await readBody(req);
    const password = body && body.password;
    if (password === undefined || password === null || password === '') return sendJson(res, 200, buildBackup());
    const problem = backupcrypto.passwordProblem(password);
    if (problem) return sendError(res, 400, problem);
    return sendJson(res, 200, await backupcrypto.encryptBackup(buildBackup(), password));
  }

  // POST /api/restore: validate everything before touching anything
  // (format, settings, every hex re-parsed with derived fields
  // recomputed), then replace the state wholesale (and the logs, if
  // carried).
  if (req.method === 'POST' && pathname === '/api/restore') {
    let body = await readBody(req);
    // An encrypted backup (the file's JSON plus `password`) is decrypted
    // first, then validated like a plain one.
    if (backupcrypto.isEncryptedBackup(body)) {
      try {
        body = await backupcrypto.decryptBackup(body, body.password);
      } catch (e) {
        if (e instanceof backupcrypto.BackupCryptoError) return sendError(res, 400, e.message);
        throw e;
      }
    }
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
      // paused is ignored; vacationUntil is a 'YYYY-MM-DD' date or null (a
      // legacy '' too).
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
    for (const key of ['primaryRpc', 'secondaryRpc']) {
      if (bsSettings[key] === undefined || bsSettings[key] === null) continue;
      try { settings[key] = rpc.normalizeSetting(bsSettings[key], null); }
      catch (e) { return sendError(res, 400, 'backup ' + (key === 'primaryRpc' ? 'primary' : 'secondary') + ' node: ' + e.message); }
    }
    // The secondary toggle rides along (missing means enabled; a non-
    // boolean rejects the restore).
    if (bsSettings.secondaryEnabled !== undefined && bsSettings.secondaryEnabled !== null) {
      if (typeof bsSettings.secondaryEnabled !== 'boolean') return sendError(res, 400, 'backup secondaryEnabled must be true or false');
      settings.secondaryEnabled = bsSettings.secondaryEnabled;
    } else {
      settings.secondaryEnabled = true;
    }
    // Price sources ride along (missing means the defaults; an invalid
    // pair rejects the restore).
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
    // Grace settings ride along (older backups get the defaults; an
    // invalid value rejects the restore). The active grace does not: a
    // restore counts as a check-in. No toggle restores as on, unless the
    // stored duration is 0 (off).
    if (bsSettings.graceEnabled !== undefined) {
      if (typeof bsSettings.graceEnabled !== 'boolean') {
        return sendError(res, 400, 'backup graceEnabled must be a boolean');
      }
      settings.graceEnabled = bsSettings.graceEnabled;
    } else {
      settings.graceEnabled = (bsSettings.graceDurationDays === 0) ? false : true;
    }
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
        return sendError(res, 400, 'backup graceDurationDays must be one of ' + GRACE_DURATION_DAYS.join(', ') + ' days (0 = off, kept for back-compat), or null for indefinite');
      }
      settings.graceDurationDays = bsSettings.graceDurationDays;
    } else {
      settings.graceDurationDays = 7;
    }
    // Price agreement, cadence and fee multipliers ride along the same
    // way; the fee pair is validated together so Low stays above Medium.
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
      // A release record is accepted only with a status and kind the app
      // writes and a txid equal to this entry's hex txid; anything else
      // rejects the whole restore (a forged stale record would disable a
      // tx for good). Even a valid broadcast or stale claim is dropped
      // below and re-derived from the network.
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
      // The rule set is validated like a single trigger; triggerState is
      // normalized to the rule count (malformed restores as null).
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
        // The fee rides along when a non-negative number or null; anything
        // else, or missing, restores as null.
        feeSats: (typeof t.feeSats === 'number' && Number.isFinite(t.feeSats) && t.feeSats >= 0) ? t.feeSats : null,
        feeRateSatVb: (typeof t.feeRateSatVb === 'number' && Number.isFinite(t.feeRateSatVb) && t.feeRateSatVb >= 0) ? t.feeRateSatVb : null,
        locktime: parsed.locktime,
        segwit: parsed.segwit,
        enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
        // Freeze offsets are validated here (missing means 0 / null); they
        // are reset to the new clock below.
        checkinOffsetMs: (typeof t.checkinOffsetMs === 'number' && Number.isFinite(t.checkinOffsetMs) && t.checkinOffsetMs >= 0) ? t.checkinOffsetMs : 0,
        checkinInactiveSince: (typeof t.checkinInactiveSince === 'string' && t.checkinInactiveSince && !Number.isNaN(new Date(t.checkinInactiveSince).getTime())) ? t.checkinInactiveSince : null,
        // Missing route restores as 'public'.
        broadcastVia: validBroadcastVia(t.broadcastVia),
        // Missing fallback restores as Never. The first-attempt time rides
        // along (dropped if unparseable), so a failing Slipstream submit
        // keeps its deadline.
        publicFallbackDays: validPublicFallbackDays(t.publicFallbackDays),
        slipstreamFirstAttemptAt: (typeof t.slipstreamFirstAttemptAt === 'string'
          && !Number.isNaN(new Date(t.slipstreamFirstAttemptAt).getTime())) ? t.slipstreamFirstAttemptAt : null,
        // A valid trigger (single or set) rides along; missing or invalid
        // falls back to a 35-day check-in rule rather than rejecting the
        // restore. triggerState is normalized to the rule count.
        trigger: restoredTrigger,
        triggerState: store.normalizeTriggerState(t.triggerState, restoredTrigger.rules.length),
        // Broadcast and stale claims are not believed from a backup (a
        // forged one could mark a tx sent or disable it for good): they
        // are dropped and the post-restore node check re-derives them.
        // Failed, conflict and Slipstream-pending records are transient
        // and ride along.
        release: (t.release && (t.release.status === 'broadcast' || t.release.status === 'stale')) ? null : (t.release ? t.release : null),
        broadcasted: null,
        // History rides along when well formed (display only), minus
        // broadcast, confirmed and stale events, which the network re-
        // derives. A missing history is seeded on the next load.
        history: Array.isArray(t.history)
          ? t.history.filter((e) => e && typeof e === 'object' && store.HISTORY_TYPES.has(e.type)
              && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
              && typeof e.detail === 'string'
              && e.type !== 'broadcast' && e.type !== 'confirmed' && e.type !== 'stale').slice(-HISTORY_MAX)
          : null,
      });
    }
    // Trigger sets ride along: members must be restored txs, triggers
    // normalized, history sanitized like a tx's. A set with no restored
    // member is dropped; a duplicate id or a tx in two sets keeps the
    // first.
    const restoredSets = [];
    const restoredTxIds = new Set(txs.map((t) => t.id));
    const seenSetIds = new Set();
    const seenSetMembers = new Set();
    if (Array.isArray(bs.bitcoin.sets)) {
      for (const bsSet of bs.bitcoin.sets) {
        if (!bsSet || typeof bsSet !== 'object' || typeof bsSet.id !== 'string' || !bsSet.id || seenSetIds.has(bsSet.id)) continue;
        seenSetIds.add(bsSet.id);
        const memberIds = Array.isArray(bsSet.txIds)
          ? [...new Set(bsSet.txIds.filter((id) => typeof id === 'string' && restoredTxIds.has(id) && !seenSetMembers.has(id)))]
          : [];
        if (!memberIds.length) continue;
        const restoredSetTrigger = store.triggerOf(bsSet);
        restoredSets.push({
          id: asStr(bsSet.id, 40),
          label: asStr(bsSet.label || '', 80),
          enabled: typeof bsSet.enabled === 'boolean' ? bsSet.enabled : true,
          txIds: memberIds,
          trigger: restoredSetTrigger,
          triggerState: store.normalizeTriggerState(bsSet.triggerState, restoredSetTrigger.rules.length),
          history: Array.isArray(bsSet.history)
            ? bsSet.history.filter((e) => e && typeof e === 'object' && store.HISTORY_TYPES.has(e.type)
                && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
                && typeof e.detail === 'string'
                && e.type !== 'broadcast' && e.type !== 'confirmed' && e.type !== 'stale').slice(-HISTORY_MAX)
            : null,
          createdAt: (typeof bsSet.createdAt === 'string' && bsSet.createdAt) ? bsSet.createdAt : now.toISOString(),
          checkinOffsetMs: 0,
          checkinInactiveSince: null,
        });
        for (const id of memberIds) seenSetMembers.add(id);
      }
    }
    const bsCheckin = (bs.checkin && typeof bs.checkin === 'object') ? bs.checkin : {};
    // The backup's check-in time must be a real date, not more than 5
    // minutes in the future (an invalid date breaks every status read; a
    // future one would postpone the release forever). Otherwise the whole
    // restore is rejected.
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
    }
    // lastOnlineAt is checked the same way (a future stamp would hide an
    // outage). A heldUntil is accepted and dropped: the restore is a
    // check-in, so there is nothing for it to protect.
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
    }
    // Check-in key hashes ride along (never the keys). A malformed entry
    // rejects the restore; missing means none.
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
      setup: { done: true }, // a restored install is set up
      createdAt: (typeof bs.createdAt === 'string' && bs.createdAt) ? bs.createdAt : now.toISOString(),
      updatedAt: now.toISOString(),
      settings,
      bitcoin: {
        txs,
        sets: restoredSets,
        connection: (bs.bitcoin.connection && typeof bs.bitcoin.connection === 'object')
          ? bs.bitcoin.connection : { ok: null, checkedAt: null, detail: '' },
      },
      checkin: {
        // A restore counts as a check-in: the clock starts now (the
        // backup's clock was validated above, not carried), and the count
        // keeps the backup's total plus one.
        lastCheckinAt: now.toISOString(),
        totalCheckins: clampInt(bsCheckin.totalCheckins, 0, 0, 1000000) + 1,
        lastOnlineAt: now.toISOString(),
      },
      checkinKeys: restoredKeys,
      // The fee history rides along (sanitized like a load), so the
      // verdict does not restart from "still building".
      feeHistory: store.sanitizeFeeHistory(bs.feeHistory),
    };
    // Freeze offsets were measured against the old clock, so they reset; a
    // tx still inactive (disarmed, or on the restored vacation) is re-
    // marked inactive from now.
    for (const t of txs) {
      if (!store.hasTriggerType(t, 'checkin')) continue;
      t.checkinOffsetMs = 0;
      t.checkinInactiveSince = null;
    }
    for (const t of txs) syncCheckinFreeze(t, restored, now);
    // A restored set's check-in freeze resets the same way.
    for (const s of restoredSets) {
      if (!store.hasTriggerType(s, 'checkin')) continue;
      s.checkinOffsetMs = 0;
      s.checkinInactiveSince = null;
    }
    for (const s of restoredSets) syncCheckinFreeze(s, restored, now);
    store.saveState(DATA_DIR, restored);
    require('../remote-checkin').sync(restored);
    // The warnings described the replaced state; clear them.
    store.clearStateWarnings();
    startupWarnings.length = 0;
    // A restored cadence takes effect immediately — the running
    // fast tick is cleared and restarted with it.
    rearmFullTick();
    // The receiver's key list matches the restored state from now on.
    writeReceiverKeys(restored);
    if (Array.isArray(body.checkins)) store.writeCheckins(DATA_DIR, body.checkins.slice(-200));
    if (Array.isArray(body.broadcastLog)) store.writeBroadcastLog(DATA_DIR, body.broadcastLog.slice(-200));
    // Record the restore as a check-in in the history, after the backup's
    // own entries.
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method: 'restore' });
    // Broadcast and stale claims were dropped above, so ask the node: the
    // same check as Dry-run all records what is already broadcast, stale
    // or in conflict. Nothing is sent; it stops at RESTORE_CHECK_MS, and a
    // tx it could not check keeps its restored status.
    let recheck = { checked: 0, broadcast: 0, stale: 0, conflict: 0, unchecked: 0 };
    try {
      const rr = await dryRunAndRecord(restored, restored.bitcoin.txs || [], now, { deadlineMs: Date.now() + RESTORE_CHECK_MS });
      recheck = {
        checked: rr.length,
        broadcast: rr.filter((r) => !(r.spent && r.spent.length) && r.own && r.own.length).length,
        stale: rr.filter((r) => r.spent && r.spent.length).length,
        conflict: rr.filter((r) => !(r.spent && r.spent.length) && !(r.own && r.own.length) && r.conflict && r.conflict.length).length,
        unchecked: rr.filter((r) => r.error || r.verdict === 'unknown').length,
      };
    } catch (e) {
      recheck.unchecked = txs.length;
    }
    // Serve the restored state like a read, re-read so it includes what
    // the check recorded.
    const servedRestored = sanitizeState(store.loadState(DATA_DIR));
    // The fee history is state-internal — see GET
    // /api/state — never served, even in a restore response.
    delete servedRestored.feeHistory;
    servedRestored.bitcoin.txs = serveTxs(servedRestored.bitcoin.txs || []);
    servedRestored.bitcoin.sets = serveSets(servedRestored.bitcoin.sets || []);
    return sendJson(res, 200, { ok: true, restoredTxs: txs.length, restoredSets: restoredSets.length, recheck, state: servedRestored });
  }
  return NEXT;
};
