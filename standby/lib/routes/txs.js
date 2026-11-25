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
  // One stored-transaction record, from a parsed tx and its hex —
  // shared by the paste path (POST /api/bitcoin/txs) and the file
  // import path (POST /api/bitcoin/txs/import), so the two cannot
  // drift apart. broadcastVia is the route the transaction goes out
  // on ('public' or 'slipstream') — default 'public'.
  // publicFallbackDays is the opt-in public-fallback
  // duration in days, or null for Never (the default).
  // slipstreamFirstAttemptAt is the ISO timestamp of the
  // first Slipstream broadcast attempt, success or fail — the
  // deadline anchor for a tx whose submit keeps failing. It is set
  // by broadcastOneInner, never by the client, and never overwritten
  // once set.
  // feeSats / feeRateSatVb are the transaction fee in
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
    // The already-satisfied check for a
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
    // A new tx is armed by default — adding
    // a CHECK-IN rule while the clock is in the danger zone (the
    // last 25% of ITS window, including already past due) would
    // let the release fire soon after, so the add resets the
    // check-in the same way arming does (server-side, a direct API
    // call cannot bypass it). A price, UTXO, or manual rule does
    // not touch the check-in clock. The zone is measured against
    // the new rule's own threshold, not the global one. Adding
    // with more than 25% of the window left does not reset.
    // The push + the reset ride into
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
      // The hex is immutable once the transaction is out the door:
      // a broadcasted tx, one submitted to
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
    // The trigger: changing it re-rules the transaction.
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
    // Arming a CHECK-IN transaction while
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
    // The route toggle on the card: switching the route
    // applies to the NEXT broadcast attempt — a transaction already
    // submitted to Slipstream is not re-submitted by toggling it
    // (preBroadcastCheck blocks a re-submit while it waits on MARA).
    if (typeof body.broadcastVia === 'string') tx.broadcastVia = validBroadcastVia(body.broadcastVia);
    // The public-fallback duration: changeable on the card
    // and in the edit popup, for Active and Pending txs. It is
    // validated leniently (invalid → Never, never a 400), like the
    // route above. A change while the tx waits on MARA re-times the
    // deadline from the original submittedAt — the deadline is
    // computed from submittedAt at evaluation time (see
    // fallbackDeadline), so no clock is restarted here.
    if (body.publicFallbackDays !== undefined) tx.publicFallbackDays = validPublicFallbackDays(body.publicFallbackDays);
    // The history events for this edit: an arm/disarm
    // flip logs on its own; any other field change logs as one
    // 'edited' event naming what changed. The events are appended
    // to tx.history here and ride into fresh state through the
    // mutator's field list below ('history' is in it), so a
    // rejected edit (a 400 above) leaves no event behind.
    // Single history: a member's 'edited' is
    // forwarded to its set's trail inside the save below, on
    // fresh state — the arm/disarm flip is NOT forwarded, the
    // set logs its own arm.
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
    // The edit's field changes were
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
