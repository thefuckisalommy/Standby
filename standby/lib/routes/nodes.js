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
  // card — across refreshes and check-ins (a verdict kept only in
  // the page's memory would pop back to Ready on every refresh).
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
    // 'would broadcast' counts the transactions that would actually
    // land: a timelocked transaction is attempted (its per-result
    // wouldBroadcast is true — the release will try it) but the node
    // will reject it as non-final until the locktime passes, so it is
    // not counted here. It is named separately, so the summary never
    // implies it will successfully broadcast right now. A
    // Slipstream-route transaction is named separately too:
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
    // transactions are excluded from the check: their fate
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

  return NEXT;
};
