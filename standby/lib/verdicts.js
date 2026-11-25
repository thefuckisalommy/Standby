'use strict';
// What a node check found about a staged transaction's inputs, and
// recording it on the card. One path for the dry-run endpoint, restore
// and the hourly freshness check.
const store = require('./store');
const bitcoin = require('./bitcoin');
const { DATA_DIR } = require('./config');
const { forwardMemberHistory, noteSetMemberStale, pushHistory, shortTxid } = require('./history');
const { saveMutation } = require('./http');
const { checkCadenceSecondsOf, fetchPriceCached, priceAgreementPctOf, priceSourcesOf } = require('./prices');
const { releaseTriggerFor } = require('./triggers');
const { validBroadcastVia } = require('./util');

function outpoints(inputs) {
  return inputs.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ');
}

// One finding per checked tx, from a dry-run or checkInputsUnspent
// result. staleOnly (the hourly check) records a confirmed foreign
// spend and nothing else: the broadcast-time gate owns the rest.
function findingFor(id, r, { staleOnly = false } = {}) {
  const f = { id };
  if (!staleOnly && r.fee && typeof r.fee.feeSats === 'number') {
    f.fee = { feeSats: r.fee.feeSats, feeRateSatVb: typeof r.fee.feeRateSatVb === 'number' ? r.fee.feeRateSatVb : null };
  }
  const method = r.checkedVia || 'primary';
  if (r.spent && r.spent.length) {
    f.stale = { method, error: 'inputs spent: ' + outpoints(r.spent) };
  } else if (staleOnly) {
    return f.stale ? f : null;
  } else if (r.own && r.own.length) {
    f.own = { method, blockHeight: r.own[0].blockHeight != null ? r.own[0].blockHeight : null };
  } else if (r.conflict && r.conflict.length) {
    const lead = r.conflict.some((i) => i.unverified)
      ? 'inputs spent by another transaction (the node cannot say whether that spend is confirmed): '
      : 'inputs spent by an unconfirmed transaction: ';
    f.conflict = { method, error: lead + outpoints(r.conflict) };
  } else if (r.verdict === 'ready') {
    // Only a clean verdict clears a conflict; 'unknown' proves nothing.
    f.clearConflict = true;
  }
  return (f.fee || f.stale || f.own || f.conflict || f.clearConflict) ? f : null;
}

// Apply findings to FRESH state, re-checking the guards there: a tx
// broadcast or deleted while the check was on the network is left
// alone. kind is the release record's kind ('dryrun' or 'release').
function recordFindings(findings, now, kind) {
  if (!findings.length) return;
  const at = now.toISOString();
  saveMutation((f) => {
    for (const a of findings) {
      const t = (f.bitcoin.txs || []).find((x) => x.id === a.id);
      if (!t || t.broadcasted) continue;
      if (a.fee) { t.feeSats = a.fee.feeSats; t.feeRateSatVb = a.fee.feeRateSatVb; }
      const isStale = t.release && t.release.status === 'stale';
      if (a.stale) {
        if (isStale) continue;
        t.release = { status: 'stale', kind, trigger: releaseTriggerFor(f, t), txid: t.txid, method: a.stale.method, lastAttemptAt: at, error: a.stale.error };
        pushHistory(t, 'stale', a.stale.error);
        // A stale member does not archive its set; the set keeps
        // firing for the rest.
        noteSetMemberStale(f, t, a.stale.error);
      } else if (a.own) {
        // Recognition, not a re-send: the node already has our tx.
        const line = 'txid ' + shortTxid(t.txid);
        t.broadcasted = { txid: t.txid, broadcastedAt: at, method: a.own.method, confirmations: null, blockHeight: a.own.blockHeight, found: true, checkedAt: at };
        pushHistory(t, 'broadcast', line);
        forwardMemberHistory(f, t, 'broadcast', line);
        if (a.own.blockHeight != null) {
          const blk = 'Block ' + a.own.blockHeight.toLocaleString('en-US');
          pushHistory(t, 'confirmed', blk);
          forwardMemberHistory(f, t, 'confirmed', blk);
        }
        if (!t.release || t.release.status !== 'broadcast') {
          t.release = { status: 'broadcast', kind, trigger: releaseTriggerFor(f, t), txid: t.txid, method: a.own.method, broadcastedAt: at };
        }
      } else if (a.conflict) {
        if (isStale) continue;
        t.release = { status: 'conflict', kind, trigger: releaseTriggerFor(f, t), txid: t.txid, method: a.conflict.method, lastAttemptAt: at, error: a.conflict.error };
        pushHistory(t, 'conflict', a.conflict.error);
        forwardMemberHistory(f, t, 'conflict', a.conflict.error);
      } else if (a.clearConflict && t.release && t.release.status === 'conflict') {
        t.release = null;
      }
    }
  });
}

// A price rule's dry-run note names the price sources and their
// readings (the cards do not); a failed price fetch only says so.
async function priceNote(st) {
  try {
    const readings = await fetchPriceCached(priceSourcesOf(st.settings), checkCadenceSecondsOf(st.settings));
    const comb = bitcoin.combinePriceReadings(readings, priceAgreementPctOf(st.settings));
    if (comb.mode === 'disagree' || comb.mode === 'none') return comb.reason.charAt(0).toUpperCase() + comb.reason.slice(1) + '.';
    return 'Price sources: ' + comb.note + '.';
  } catch (e) {
    return 'Price sources: could not be checked.';
  }
}

// Dry-run txs and record what each run found. Without checkDone, txs
// already broadcast or stale are skipped. With deadlineMs, a tx not
// checked by then gets a timedOut result and nothing is recorded for
// it (its lookup may still finish in the background).
async function dryRunAndRecord(st, txs, now, { drySet = null, checkDone = false, priceNotes = false, deadlineMs = null } = {}) {
  const results = [];
  const endpoints = bitcoin.endpointsFor(st.settings);
  const ttlMs = checkCadenceSecondsOf(st.settings) * 1000;
  for (const tx of txs) {
    if (!checkDone && (tx.broadcasted || (tx.release && tx.release.status === 'stale'))) continue;
    const base = { id: tx.id, label: tx.label || '', enabled: drySet ? !!drySet.enabled : !!tx.enabled };
    const left = deadlineMs == null ? null : deadlineMs - Date.now();
    if (left !== null && left <= 0) {
      results.push({ ...base, txid: tx.txid, wouldBroadcast: false, timedOut: true, error: 'not checked in time' });
      continue;
    }
    try {
      let run = bitcoin.dryRun(DATA_DIR, { tx, endpoints, ttlMs });
      if (left !== null) {
        let timer;
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); });
        run.catch(() => {});
        run = Promise.race([run, late]).finally(() => clearTimeout(timer));
      }
      const r = await run;
      if (r === null) {
        results.push({ ...base, txid: tx.txid, wouldBroadcast: false, timedOut: true, error: 'not checked in time' });
        continue;
      }
      // A set member's note reads the set's trigger.
      const trg = drySet ? store.triggerOf(drySet) : store.triggerOf(tx);
      if (priceNotes && trg && trg.rules.some((x) => x.type === 'price')) {
        r.note = (r.note || '') + ' ' + await priceNote(st);
      }
      results.push({ ...base, ...r });
    } catch (e) {
      results.push({ ...base, txid: tx.txid, broadcastVia: validBroadcastVia(tx.broadcastVia), wouldBroadcast: false, error: e.message });
    }
  }
  recordFindings(results.filter((r) => !r.timedOut && !r.error).map((r) => findingFor(r.id, r)).filter(Boolean), now, 'dryrun');
  return results;
}

module.exports = { findingFor, recordFindings, dryRunAndRecord };
