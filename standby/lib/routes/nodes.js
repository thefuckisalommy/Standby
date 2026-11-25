'use strict';
const bitcoin = require('../bitcoin');
const { saveMutation } = require('../http');
const { mergeNodeStamps } = require('../release');
const { dryRunAndRecord } = require('../verdicts');
const { setMembers } = require('../triggers');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function nodesRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/bitcoin/connection/test — verifies both nodes without
  // moving funds. Saves the result (including the per-endpoint results)
  // so the Dashboard can show each node's own status. The app is OK if
  // either one answers (the other is the backup).
  if (req.method === 'POST' && pathname === '/api/bitcoin/connection/test') {
    const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings), { probeOutputLookup: true });
    const conn = { ok: r.ok, checkedAt: now.toISOString(), detail: r.detail, results: r.results };
    // The node test awaited the network —
    // only the connection result rides into FRESH state.
    // The per-endpoint stamps ride over from the stored
    // connection, then the live stamps (the test just asked both
    // endpoints) overwrite them.
    saveMutation((f) => {
      const prev = (f.bitcoin.connection && f.bitcoin.connection.nodeCheckedAt) || null;
      f.bitcoin.connection = conn;
      if (prev) f.bitcoin.connection.nodeCheckedAt = { primary: prev.primary || null, secondary: prev.secondary || null };
      mergeNodeStamps(f);
    });
    return sendJson(res, 200, { ok: r.ok, detail: r.detail, results: r.results });
  }

  // POST /api/broadcast/test: dry run, never broadcasts. { id } tests one
  // tx (whatever its state), { setId } a set's members, no body every tx
  // that could still broadcast (armed or not). Each tx's inputs are
  // checked and the findings recorded on its card (lib/verdicts.js), so a
  // stale verdict survives refreshes. One failure does not stop the rest;
  // the summary counts armed txs only.
  if (req.method === 'POST' && pathname === '/api/broadcast/test') {
    const body = await readBody(req).catch(() => ({}));
    let txs = state.bitcoin.txs || [];
    // A set dry-run checks every member: { setId } names
    // the set, like { id } names one tx.
    let drySet = null;
    if (body && body.setId) {
      drySet = (state.bitcoin.sets || []).find((s) => s.id === body.setId);
      if (!drySet) return sendError(res, 404, 'no such trigger set');
      txs = setMembers(state, drySet);
    } else if (body && body.id) {
      const one = txs.find((t) => t.id === body.id);
      if (!one) return sendError(res, 404, 'no such transaction');
      txs = [one];
    }
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    const results = await dryRunAndRecord(state, txs, now, { drySet, checkDone: !!(body && body.id), priceNotes: true });
    const armed = results.filter((r) => r.enabled);
    // 'Would broadcast' counts txs that would actually land: timelocked
    // ones are attempted but named separately, and Slipstream ones are
    // named as submissions.
    const would = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked').length;
    const slipstream = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked' && r.broadcastVia === 'slipstream').length;
    const stale = armed.filter((r) => r.spent && r.spent.length).length;
    const timelocked = armed.filter((r) => r.verdict === 'timelocked').length;
    // Dry-run all also flags inputs shared by two stored txs (only one can
    // confirm); archived txs are left out.
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

  return NEXT;
};
