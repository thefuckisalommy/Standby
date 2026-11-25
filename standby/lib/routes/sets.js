'use strict';
const store = require('../store');
const bitcoin = require('../bitcoin');
const { checkinLiveOffsetMs, inDangerZone, resetCheckin, syncCheckinFreeze } = require('../checkin');
const { pushHistory } = require('../history');
const { saveMutation } = require('../http');
const { broadcastOne } = require('../rules');
const { serveSet, setMembers, triggerConditionText } = require('../triggers');
const { asStr, readBody, sendError, sendJson } = require('../util');
const { NEXT, setGateCheck } = require('./shared');

module.exports = async function setsRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // Trigger sets: one label, one arm, one rule set for several
  // transactions.
  // POST /api/bitcoin/sets { label, txIds, trigger, enabled?,
  // triggerConfirmed? }
  // PUT /api/bitcoin/sets/:id (same fields, optional)
  // DELETE /api/bitcoin/sets/:id (members return to standalone)
  // POST /api/bitcoin/sets/:id/broadcast (manual, now)
  // Members keep their own trigger for when they leave; while attached
  // only the set's is evaluated. The gate, danger-zone reset and freeze
  // mirror the tx paths.
  function setAttachErrors(freshState, txIds, exceptSetId) {
    const errs = [];
    const seen = new Set();
    for (const id of txIds) {
      if (typeof id !== 'string' || !id) { errs.push('set members must be transaction ids'); continue; }
      if (seen.has(id)) { errs.push('transaction attached twice: ' + id); continue; }
      seen.add(id);
      const t = (freshState.bitcoin.txs || []).find((x) => x.id === id);
      if (!t) { errs.push('unknown transaction id: ' + id); continue; }
      const other = (freshState.bitcoin.sets || []).find((s) => s.id !== exceptSetId && (s.txIds || []).includes(id));
      if (other) { errs.push("'" + (t.label || t.id) + "' is already in '" + (other.label || other.id) + "'"); continue; }
      if (t.broadcasted || (t.release && (t.release.status === 'broadcast' || t.release.status === 'stale' || t.release.status === 'submitted-slipstream'))) {
        errs.push("'" + (t.label || t.id) + "' is already broadcast, stale, or waiting on MARA and cannot join a set");
      }
    }
    return errs;
  }
  function newSetRecord(label, txIds, trigger) {
    return {
      id: store.newSetId(),
      label: typeof label === 'string' ? asStr(label, 80) : '',
      enabled: true,
      txIds: [...new Set(txIds)],
      trigger,
      triggerState: null,
      history: [{ ts: now.toISOString(), type: 'added', detail: 'Set created with ' + txIds.length + (txIds.length === 1 ? ' transaction' : ' transactions') }],
      createdAt: now.toISOString(),
      checkinOffsetMs: 0,
      checkinInactiveSince: null,
    };
  }
  if (req.method === 'POST' && pathname === '/api/bitcoin/sets') {
    const body = await readBody(req);
    if (!Array.isArray(body.txIds) || !body.txIds.length) return sendError(res, 400, 'a set needs at least one transaction');
    const errs = setAttachErrors(state, body.txIds, null);
    if (errs.length) return sendError(res, 400, errs[0]);
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const set = newSetRecord(body.label, body.txIds, trig.trigger);
    if (body.enabled === false) set.enabled = false;
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'add');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the create proceeds without the warning */ }
    let checkinReset = false;
    let saveErrs = null;
    const fresh = saveMutation((f) => {
      saveErrs = setAttachErrors(f, body.txIds, null);
      if (saveErrs.length) return false;
      if ((f.bitcoin.sets || []).some((s) => s.id === set.id)) return false;
      // Single history: the set's trail opens
      // with each member's existing history (tagged, oldest
      // first); the creation event closes it, so the trail never
      // starts from scratch.
      const memberTxs = body.txIds.map((id) => (f.bitcoin.txs || []).find((t) => t.id === id)).filter(Boolean);
      set.history = [];
      store.backfillSetHistory(set, memberTxs);
      pushHistory(set, 'added', 'Set created with ' + body.txIds.length + (body.txIds.length === 1 ? ' transaction' : ' transactions'), now.toISOString());
      (f.bitcoin.sets = f.bitcoin.sets || []).push(set);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) return sendError(res, 400, (saveErrs && saveErrs[0]) || 'could not save the set — try again');
    const out = { set: serveSet((fresh.bitcoin.sets || []).find((s) => s.id === set.id) || set) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }
  const setMatch = pathname.match(/^\/api\/bitcoin\/sets\/([^/]+)$/);
  if (setMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const set = (state.bitcoin.sets || []).find((s) => s.id === setMatch[1]);
    if (!set) return sendError(res, 404, 'no such trigger set');
    if (req.method === 'DELETE') {
      // Deleting a set never deletes its transactions — they
      // return to standalone, each with its own trigger again.
      const fresh = saveMutation((f) => {
        if (!(f.bitcoin.sets || []).some((s) => s.id === set.id)) return false;
        f.bitcoin.sets = (f.bitcoin.sets || []).filter((s) => s.id !== set.id);
      });
      if (!fresh) return sendError(res, 404, 'no such trigger set');
      return sendJson(res, 200, { ok: true, removed: set.id });
    }
    const body = await readBody(req);
    const orig = { ...set, txIds: [...(set.txIds || [])], trigger: set.trigger, history: set.history };
    if (typeof body.label === 'string') set.label = asStr(body.label, 80);
    if (body.txIds !== undefined) {
      if (!Array.isArray(body.txIds)) return sendError(res, 400, 'txIds must be a list of transaction ids');
      // Only the NEWLY attached ids are validated against the
      // settled / other-set rules — a member already in this set
      // stays put even if it has since broadcast.
      const freshIds = body.txIds.filter((id) => !orig.txIds.includes(id));
      const errs = setAttachErrors(state, freshIds, set.id);
      if (errs.length) return sendError(res, 400, errs[0]);
      set.txIds = [...new Set(body.txIds)];
      // Single history: a newly attached member
      // brings its existing history into the set's trail (tagged,
      // oldest first) — the 'Members changed' event below closes
      // the attach, so it stays the newest entry.
      const addedTxs = freshIds.map((id) => (state.bitcoin.txs || []).find((t) => t.id === id)).filter(Boolean);
      if (addedTxs.length) store.backfillSetHistory(set, addedTxs);
    }
    let triggerWarning = null;
    if (body.trigger !== undefined) {
      const v = store.normalizeTrigger(body.trigger);
      if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
      try {
        const gate = await setGateCheck(v.trigger, state, now, 'save');
        if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
        if (gate.blocked && body.triggerConfirmed !== true) {
          return sendError(res, 400, gate.message);
        }
      } catch (e) { /* best-effort: the save proceeds without the warning */ }
      if (JSON.stringify(v.trigger) !== JSON.stringify(set.trigger)) {
        set.trigger = v.trigger;
        set.triggerState = null;
      }
    }
    if (typeof body.enabled === 'boolean') set.enabled = body.enabled;
    if (typeof body.enabled === 'boolean' && orig.enabled !== set.enabled) {
      pushHistory(set, set.enabled ? 'armed' : 'disarmed', '');
    }
    const setChanges = [];
    if (orig.label !== set.label) setChanges.push('Label changed');
    if (JSON.stringify(orig.trigger) !== JSON.stringify(set.trigger)) setChanges.push('Trigger changed to ' + triggerConditionText(set.trigger));
    if (JSON.stringify(orig.txIds) !== JSON.stringify(set.txIds)) {
      const added = (set.txIds || []).filter((id) => !orig.txIds.includes(id)).length;
      const removed = orig.txIds.filter((id) => !(set.txIds || []).includes(id)).length;
      setChanges.push('Members changed' + (added ? ' (+' + added + ')' : '') + (removed ? ' (-' + removed + ')' : ''));
    }
    if (setChanges.length) pushHistory(set, 'edited', setChanges.join('; '));
    let checkinReset = false;
    const fresh = saveMutation((f) => {
      const fset = (f.bitcoin.sets || []).find((s) => s.id === set.id);
      if (!fset) return false;
      const freshWasEnabled = fset.enabled;
      for (const k of ['label', 'txIds', 'trigger', 'triggerState', 'enabled', 'history']) {
        if (JSON.stringify(set[k]) !== JSON.stringify(orig[k])) fset[k] = set[k];
      }
      syncCheckinFreeze(fset, f, now);
      const fsetCheckinThresholds = store.triggerOf(fset).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (body.enabled === true && freshWasEnabled === false
          && fsetCheckinThresholds.length > 0
          && inDangerZone(f, now, Math.min(...fsetCheckinThresholds), checkinLiveOffsetMs(fset, now))) {
        resetCheckin(f, now, 'arm-reset');
        checkinReset = true;
      }
    });
    if (!fresh) return sendError(res, 400, 'could not save the set — try again');
    const outSet = (fresh.bitcoin.sets || []).find((s) => s.id === set.id);
    const out = { set: serveSet(outSet) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 200, out);
  }

  // POST /api/bitcoin/sets/:id/broadcast: manual broadcast of every member
  // through the normal path, ignoring the set's arm. A stale member is
  // reported and the rest carry on.
  const setBroadcastMatch = pathname.match(/^\/api\/bitcoin\/sets\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && setBroadcastMatch) {
    const set = (state.bitcoin.sets || []).find((s) => s.id === setBroadcastMatch[1]);
    if (!set) return sendError(res, 404, 'no such trigger set');
    const members = setMembers(state, set);
    if (!members.length) return sendError(res, 400, 'the set has no transactions to broadcast');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of members) {
      if (tx.broadcasted) {
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
        continue;
      }
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast', { setId: set.id }));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }
  return NEXT;
};
