'use strict';
const store = require('../store');
const bitcoin = require('../bitcoin');
const { checkinLiveOffsetMs, inDangerZone, resetCheckin, syncCheckinFreeze } = require('../checkin');
const { forwardMemberHistory, pushHistory } = require('../history');
const { saveMutation } = require('../http');

const { serveTx, triggerConditionText } = require('../triggers');
const { asStr, readBody, sendError, sendJson, validBroadcastVia, validPublicFallbackDays } = require('../util');
const { NEXT, setGateCheck } = require('./shared');

module.exports = async function txsRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // There is no POST /api/pause or /api/resume: Global Arm/Disarm
  // (POST /api/bitcoin/txs/arm-all) is the control. Those paths 404.

  // Transactions. Adding one arms it. The hex is validated before storing;
  // the server never sees keys. Replacing the hex clears the release
  // record and broadcasted fact (they belong to the old tx); the broadcast
  // log keeps the history.
  // POST /api/bitcoin/txs { txHex, label, notes, broadcastVia? }
  // PUT /api/bitcoin/txs/:id { txHex?, label?, notes?, enabled?,
  // broadcastVia? }
  // DELETE /api/bitcoin/txs/:id
  const txsMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)$/);
  // One new tx record, shared by the paste and file-import paths.
  // broadcastVia defaults to 'public'; publicFallbackDays null means
  // Never; slipstreamFirstAttemptAt is set once by the broadcast path (the
  // fallback anchor). The fee is computed from the parents at add time
  // (also on dry run and startup); null when unknown, and never a gate.
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
      // The check-in freeze: the accumulated inactive
      // time and the start of the current inactive period (see
      // syncCheckinFreeze). Only check-in logic reads them; a new
      // tx starts active, at 0 / null.
      checkinOffsetMs: 0,
      checkinInactiveSince: null,
      broadcastVia: validBroadcastVia(broadcastVia),
      publicFallbackDays: validPublicFallbackDays(publicFallbackDays),
      slipstreamFirstAttemptAt: null,
      // The rule that fires this transaction — already
      // normalized by the caller (see the add / import handlers).
      // triggerState is the trigger's last evaluation, null until
      // the release has evaluated it once.
      trigger,
      triggerState: null,
      // The event trail: starts with the add itself —
      // the rule that was set, in its own words.
      history: [{ ts: now.toISOString(), type: 'added', detail: triggerConditionText(trigger) }],
      release: null,
      // broadcasted is set by broadcastOne() (release or manual) and
      // survives check-ins: { txid, broadcastedAt, method,
      // confirmations, blockHeight, found, checkedAt }.
      broadcasted: null,
    };
  }
  // The fee for a parsed tx, best-effort: null when the
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
    // The trigger: validated server-side (an invalid one
    // is a 400 with the reason). Omitted → the check-in trigger at
    // the 35-day fallback, so the old add path is unchanged.
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays, trig.trigger);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    // Already-satisfied gate for price, UTXO, block-height, set-date and
    // fee-market rules: a met condition would fire on the next evaluation,
    // so the add needs triggerConfirmed. Price needs both sources to
    // agree; UTXO depends on its confirmation mode. Unknown readings never
    // block, and the check's warning rides on the response either way.
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'add');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the add proceeds without the warning */ }
    // A new tx is armed, so a check-in rule added inside its danger zone
    // resets the check-in (server-side, so the API cannot bypass it);
    // other rule types never touch the clock. The add and reset are saved
    // into fresh state, re-checking for a duplicate txid there.
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

  // POST /api/bitcoin/txs/preview { format: 'hex'|'psbt', data }: validate
  // or finalize a file and return the raw hex without storing anything
  // (the UI then adds it via the paste path).
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

  // POST /api/bitcoin/txs/import { format: 'hex'|'psbt', data, label?,
  // notes? }: add from a file. Hex is validated like a paste; a PSBT must
  // be fully signed (missing signatures are named) and the extracted hex
  // is validated too. Body and PSBT are capped at 1 MB.
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
    // The trigger — same validation and already-spent gate
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
    // The import path arms by default too —
    // same reset as the paste path when the clock is in the danger
    // zone, and only for a check-in rule.
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
    // Snapshot for the fresh-state merge
    // below: only the fields this edit changes are copied into
    // fresh state at save time. (Shallow: the handler replaces
    // trigger/release/broadcasted, never mutates them in place.)
    const orig = { ...tx };
    if (req.method === 'DELETE') {
      // The removal rides into FRESH
      // state: the request body was awaited above, so a second
      // request may have saved in between.
      const fresh = saveMutation((f) => {
        if (!(f.bitcoin.txs || []).some((t) => t.id === tx.id)) return false;
        f.bitcoin.txs = (f.bitcoin.txs || []).filter((t) => t.id !== tx.id);
        // The tx leaves any set it was in; a set left with
        // no members has nothing to drive and goes with it. The
        // other members stay put.
        for (const s of (f.bitcoin.sets || [])) {
          s.txIds = (s.txIds || []).filter((id) => id !== tx.id);
        }
        f.bitcoin.sets = (f.bitcoin.sets || []).filter((s) => (s.txIds || []).length > 0);
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
      // Once a tx is out the door (broadcast, waiting on MARA, stale, or a
      // broadcast record), its hex cannot become a different transaction;
      // the same hex back is a no-op. Failed and conflict txs are still
      // active, so their hex can change.
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
    // A changed trigger is validated, starts with a fresh triggerState,
    // and goes through the already-satisfied gate. Nothing is saved until
    // the end, so a 400 discards the whole edit.
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
    // Arming a live check-in tx inside its danger zone resets the check-in
    // (server-side), measured against its own (possibly new) threshold.
    // Other rule types, disarming, and arming outside the zone leave the
    // clock alone.
    if (typeof body.enabled === 'boolean') tx.enabled = body.enabled;
    // The route toggle on the card: switching the route
    // applies to the NEXT broadcast attempt — a transaction already
    // submitted to Slipstream is not re-submitted by toggling it
    // (preBroadcastCheck blocks a re-submit while it waits on MARA).
    if (typeof body.broadcastVia === 'string') tx.broadcastVia = validBroadcastVia(body.broadcastVia);
    // Public-fallback duration: editable for active and pending txs,
    // invalid means Never (no 400). Changing it while waiting on MARA re-
    // times the deadline from the original submission.
    if (body.publicFallbackDays !== undefined) tx.publicFallbackDays = validPublicFallbackDays(body.publicFallbackDays);
    // History for this edit: an arm flip logs on its own, anything else as
    // one 'edited' event; a rejected edit logs nothing. A member's
    // 'edited' is forwarded to its set (its arm flip is not).
    const forwardedEditEvents = [];
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
    if (editChanges.length) {
      pushHistory(tx, 'edited', editChanges.join('; '));
      forwardedEditEvents.push({ type: 'edited', detail: editChanges.join('; ') });
    }
    let checkinReset = false;
    // Only the fields this edit changed are saved into fresh state (the
    // request waited on the network). Locks, the freeze and the danger-
    // zone reset are re-checked there.
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
      // Single history: the member's edit lands
      // on its set's trail too (forwardMemberHistory no-ops for a
      // standalone tx). This runs only on the success path — the
      // early returns above leave a rejected edit with no event
      // anywhere.
      for (const fe of forwardedEditEvents) forwardMemberHistory(f, ftx, fe.type, fe.detail);
      // The freeze: the danger zone is measured from the
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
  return NEXT;
};
