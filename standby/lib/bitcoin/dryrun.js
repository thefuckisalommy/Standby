'use strict';

// Dry runs: answers "would a broadcast be attempted?" and records the
// answer. NEVER broadcasts. The full hex never reaches the log. Also the
// transaction's fee, from its inputs' parent outputs.

const rpc = require('../rpc');
const { appendBroadcastLog } = require('../store');
const { timelockedUntil, parseTx } = require('./tx');
const { mempoolHostLabel, mempoolReq, mempoolTxStatus, mempoolTipHeight } = require('./nodes');
const { checkInputsUnspent } = require('./outspends');

async function dryRun(dataDir, { tx, endpoints, ttlMs }) {
  const parsed = parseTx(tx.hex);
  const check = await checkInputsUnspent(parsed, endpoints, ttlMs);
  const fellBack = check.checkedVia !== 'primary';
  const viaNote = 'Checked via the ' + check.checkedVia + ' node (' + mempoolHostLabel(check.checkedBase) + ')'
    + (fellBack ? ' — the primary node could not be reached.' : '.');
  // Verdicts, fail-open:
  // - ready: every input proven unspent
  // - unknown: nothing proven spent, some inputs unverifiable; the
  //   broadcast is still attempted
  // - conflict: an input spent by an unconfirmed transaction; a warning,
  //   still attempted
  // - timelocked: locktime not yet passed; attempted, rejected and retried
  //   until it passes
  // - broadcast: the node already has our txid; nothing to send
  // - blocked: an input spent by a confirmed transaction; stale
  // Precedence: blocked, broadcast, timelocked, conflict, unknown. The tip
  // is fetched only for a height locktime with a live sequence; if that
  // fetch fails the timelock check is skipped and the broadcast decides.
  let timelock = { timelocked: false, until: null };
  if (parsed.locktime && parsed.locktime < 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    let tipHeight = null;
    try { tipHeight = await mempoolTipHeight(check.checkedBase); } catch { tipHeight = null; }
    timelock = timelockedUntil(parsed, tipHeight, new Date());
  } else if (parsed.locktime && parsed.locktime >= 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    timelock = timelockedUntil(parsed, null, new Date());
  }
  const verdict = check.spent.length ? 'blocked'
    : check.own.length ? 'broadcast'
    : timelock.timelocked ? 'timelocked'
    : check.conflict.length ? 'conflict'
    : check.unknown.length ? 'unknown' : 'ready';
  const wouldBroadcast = check.spent.length === 0 && check.own.length === 0;
  // The route only changes the note's wording ("would submit to
  // Slipstream"); the freshness gate is the same.
  const viaSlipstream = tx.broadcastVia === 'slipstream';
  const attempt = viaSlipstream ? 'a submission to Slipstream (MARA)' : 'a broadcast';
  const rejecter = viaSlipstream ? 'Slipstream' : 'the node';
  const note = verdict === 'ready'
    ? 'All ' + check.checked + ' input(s) unspent — ' + attempt + ' would be attempted. ' + viaNote
    : verdict === 'blocked'
      ? check.spent.length + ' input(s) spent by another transaction that is confirmed — this transaction is stale and will not be ' + (viaSlipstream ? 'submitted to Slipstream' : 'broadcast') + '. ' + viaNote
      : verdict === 'broadcast'
        ? 'This transaction is already out there — the node knows its txid, in the mempool or a block — so it is recorded as broadcast. Nothing was sent. ' + viaNote
        : verdict === 'timelocked'
          ? 'This transaction is timelocked until ' + (typeof timelock.until === 'number' ? 'block ' + timelock.until : timelock.until.toISOString()) + ' — ' + rejecter + ' would reject it as non-final until then, so ' + attempt + ' would be attempted and rejected; it will be retried on the next hourly check. ' + viaNote
          : verdict === 'conflict'
          ? check.conflict.some((c) => c.unverified)
            ? check.conflict.length + ' input(s) are spent by another transaction, and this node cannot say whether that spend is confirmed, so it is treated as unconfirmed — this transaction stays active with a warning and ' + attempt + ' will still be attempted. ' + viaNote
            : check.conflict.length + ' input(s) are spent by another transaction that is not confirmed yet — the spend may still be evicted, so this transaction stays active with a warning and ' + attempt + ' will still be attempted. ' + viaNote
          : check.unknown.length + ' input(s) could not be verified — ' + attempt + ' would be attempted, but the network is the arbiter. ' + viaNote;
  // The fee, recomputed from the parents on every dry run, so a wrongly
  // stored fee corrects itself (the caller records it).
  const fee = await computeFee(parsed, endpoints);
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'dry-run',
    status: verdict === 'ready' ? 'would-broadcast' : verdict,
    method: check.checkedVia,
    txid: tx.txid,
    hexPreview: tx.hex.slice(0, 64),
    inputsChecked: check.checked,
    unspent: check.unspent.length,
    spent: check.spent.length,
    conflict: check.conflict.length,
    own: check.own.length,
    unknown: check.unknown.length,
    note,
  });
  return {
    ok: true,
    wouldBroadcast,
    verdict,
    broadcastVia: tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public',
    timelockedUntil: timelock.timelocked ? (timelock.until instanceof Date ? timelock.until.toISOString() : timelock.until) : null,
    txid: tx.txid,
    fee,
    checked: check.checked,
    checkedVia: check.checkedVia,
    checkedBase: check.checkedBase,
    unspent: check.unspent,
    spent: check.spent,
    conflict: check.conflict,
    own: check.own,
    unknown: check.unknown,
    note,
  };
}

// Transaction fee: input values minus outputs. Input values live in the
// parent transactions (GET /api/tx/:txid). Best-effort: any failure gives
// null and the add or dry run still succeeds.

// A vout value in satoshis as a BigInt, or null. The API returns satoshis,
// not BTC.
function satsValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  return BigInt(value);
}

// One input's prevout value in satoshis. An endpoint that 404s the parent
// or is down falls through to the next; a known parent with a missing vout
// is an answer (null).
async function parentOutputValue(prevTxid, prevVout, endpoints, timeoutMs) {
  for (const ep of endpoints) {
    let st;
    try {
      st = await mempoolTxStatus(prevTxid, ep.base, timeoutMs);
    } catch {
      continue; // endpoint down — try the next
    }
    if (st === null) {
      // Without txindex an RPC node knows only mempool transactions; an
      // unspent output's value is still in its UTXO set.
      if (rpc.isRpcBase(ep.base)) {
        const v = await rpcPrevoutValue(prevTxid, prevVout, ep.base, timeoutMs);
        if (v !== null) return v;
      }
      continue; // unknown here — maybe the other endpoint knows it
    }
    const vouts = st.vout || [];
    const out = vouts[prevVout];
    if (!out) return null;
    return satsValue(out.value);
  }
  return null;
}

async function rpcPrevoutValue(txid, vout, base, timeoutMs) {
  try {
    const res = await mempoolReq('/api/prevouts', 'POST', JSON.stringify([{ txid, vout }]), base, timeoutMs, 'application/json');
    const [out] = JSON.parse(res.body);
    return out && out.prevout ? satsValue(out.prevout.value) : null;
  } catch { return null; }
}

// { feeSats, feeRateSatVb } or null. Parents are fetched in parallel, each
// capped at FEE_LOOKUP_TIMEOUT_MS so a hung node cannot stall an add.
// Never throws.
const FEE_LOOKUP_TIMEOUT_MS = 5000;
async function computeFee(parsed, endpoints) {
  try {
    if (!parsed || !Array.isArray(parsed.inputs) || !parsed.inputs.length) return null;
    const values = await Promise.all(
      parsed.inputs.map((inp) => parentOutputValue(inp.prevTxid, inp.prevVout, endpoints, FEE_LOOKUP_TIMEOUT_MS))
    );
    if (values.some((v) => v === null)) return null;
    let inSats = 0n;
    for (const v of values) inSats += v;
    const fee = inSats - BigInt(parsed.totalOutSats);
    if (fee < 0n) return null;
    const vsize = parsed.vsize;
    if (!vsize || vsize <= 0) return null;
    return { feeSats: Number(fee), feeRateSatVb: Number(fee) / vsize };
  } catch {
    return null;
  }
}

module.exports = { dryRun, computeFee };
