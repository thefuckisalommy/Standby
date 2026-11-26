'use strict';

// The Test button on a node: height, fees, broadcast path, output
// lookups, and on Bitcoin Core the RPC login and txindex. Read-only.

const rpc = require('../rpc');
const { mempoolHostLabel, mempoolReq } = require('./nodes');
const { fetchNodeFee } = require('./fees');
const { singularOnlyBases, mempoolOutspend, forgetOutspends } = require('./outspends');

// Connection test: checks both endpoints without moving funds; OK if
// either answers. Returns { ok, detail, results }.
async function testConnection(endpoints, opts) {
  // probeOutputLookup: only Test connection probes it. The hourly tick
  // reuses each endpoint's last probe (prevResults), so it makes no
  // outspend request and never changes the learned route. The 'not
  // checked' placeholder is not carried forward.
  const probeOutputLookup = !opts || opts.probeOutputLookup !== false;
  const prevResults = (opts && Array.isArray(opts.prevResults)) ? opts.prevResults : [];
  const results = [];
  for (const ep of endpoints) {
    const prev = prevResults.find((x) => x && x.endpoint === ep.label && x.base === ep.base);
    const prevCheck = prev && prev.checks ? prev.checks.outputLookup : null;
    const prevOutputLookup = (prevCheck && typeof prevCheck === 'object' && prevCheck.value !== '—') ? prevCheck : null;
    results.push({ endpoint: ep.label, base: ep.base, ...(await testOnePath(ep.base, probeOutputLookup, prevOutputLookup)) });
  }
  const ok = results.some((r) => r.ok);
  const detail = results
    .map((r) => (r.endpoint === 'primary' ? 'Primary' : 'Secondary') + ' (' + mempoolHostLabel(r.base) + '): ' + r.status.toUpperCase() + ' — ' + r.detail)
    .join('; ');
  return { ok, detail, results };
}

// One endpoint, four checks: height, fees, broadcast, output lookup.
// Status is OK when all probed checks pass, CAUTION when height works but
// another check does not, FAIL when height fails (height is the one thing
// every node serves). ok stays true for OK and CAUTION. The detail is the
// pill tooltip.
async function testOnePath(apiBase, probeOutputLookup, prevOutputLookup) {
  const height = await testNodeHeight(apiBase);
  if (!height.ok) {
    return {
      ok: false, status: 'fail',
      detail: 'height: ' + height.detail,
      checks: { height, fees: { ok: false, detail: 'not checked — height failed', value: '—' }, broadcast: { ok: false, detail: 'not checked — height failed', value: '—' }, outputLookup: { ok: false, detail: 'not checked — height failed', value: '—' } },
    };
  }
  const fees = await testNodeFees(apiBase);
  const broadcast = await testNodeBroadcast(apiBase);
  // Output lookup is only probed by Test connection; the tick reuses the
  // last probe. Never probed means absent (no value, does not block OK).
  const outputLookup = probeOutputLookup ? await testNodeOutputLookup(apiBase) : (prevOutputLookup || null);
  const checks = { height, fees, broadcast };
  if (outputLookup) checks.outputLookup = outputLookup;
  // Advice only: an unrestricted RPC login does not change the status.
  if (rpc.isRpcBase(apiBase)) {
    const rpcUser = await testRpcUser(apiBase);
    if (rpcUser) checks.rpcUser = rpcUser;
  }
  const allOk = fees.ok && broadcast.ok && (outputLookup ? outputLookup.ok : true);
  let detail;
  if (outputLookup && outputLookup.warn && outputLookup.kind === 'rpc' && fees.ok && broadcast.ok) {
    detail = 'Height OK, but ' + outputLookup.detail.charAt(0).toLowerCase() + outputLookup.detail.slice(1);
  } else if (outputLookup && outputLookup.warn && fees.ok && broadcast.ok) {
    detail = 'Height OK, but this node says only that an output is spent, not whether the spend is confirmed — a spent input warns instead of going stale.';
  } else if (outputLookup && !outputLookup.ok && fees.ok && broadcast.ok) {
    detail = 'Height OK, but output lookup is unavailable — UTXO rules cannot be evaluated against this node.';
  } else {
    const parts = ['height ' + height.detail, 'fees: ' + fees.detail, 'broadcast: ' + broadcast.detail];
    if (outputLookup) parts.push('output lookup: ' + outputLookup.detail);
    detail = parts.join(' · ');
  }
  return {
    ok: true, status: allOk ? 'ok' : 'caution', detail,
    checks,
  };
}

// Block height: GET /api/blocks/tip/height, which every node serves. value
// is the short text beside the pill ("Height 976,200"), or the reason on
// failure; detail is the tooltip.
async function testNodeHeight(apiBase) {
  try {
    const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
    if (res.status !== 200) return { ok: false, detail: 'answered HTTP ' + res.status, value: 'answered HTTP ' + res.status };
    const height = parseInt(res.body.trim(), 10);
    return Number.isFinite(height)
      ? { ok: true, detail: 'tip height ' + height, value: 'Height ' + height.toLocaleString('en-US') }
      : { ok: false, detail: 'answered 200 with an unparseable height', value: 'unparseable height' };
  } catch (e) {
    return { ok: false, detail: e.message, value: e.message };
  }
}

// Fee check: mempool's /api/v1/fees/recommended, or Esplora's /api/fee-
// estimates at the 144-block target.
async function testNodeFees(apiBase) {
  try {
    const r = await fetchNodeFee(apiBase);
    if (r.source === 'mempool') return { ok: true, detail: 'ready (economy ' + r.fee + ' sat/vB)', value: r.fee + ' sat/vB' };
    return { ok: true, detail: r.source === 'core' ? 'ready (Bitcoin Core estimates)' : 'ready (Esplora estimates)', value: r.fee + ' sat/vB' };
  } catch (e) {
    const msg = e.message || String(e);
    const value = /no fee endpoint/.test(msg) ? 'no fee endpoint' : /no usable economyFee/.test(msg) ? 'no economy fee' : /no usable rates/.test(msg) ? 'no usable rates' : /not JSON/.test(msg) ? 'not JSON' : msg;
    return { ok: false, detail: msg, value };
  }
}

// Broadcast check: POST /api/tx with "00", which every node rejects at
// parse time, so nothing is broadcast. 400/422 (and the test stub's 200)
// mean reachable; 404 or anything else means not ready.
async function testNodeBroadcast(apiBase) {
  try {
    const res = await mempoolReq('/api/tx', 'POST', '00', apiBase);
    if (res.status === 200 || res.status === 400 || res.status === 422) {
      return { ok: true, detail: 'ready (endpoint live)', value: 'Reachable' };
    }
    return { ok: false, detail: 'answered HTTP ' + res.status, value: 'answered HTTP ' + res.status };
  } catch (e) {
    return { ok: false, detail: e.message, value: e.message };
  }
}

// Output lookup: how this node answers spends, which decides how Standby
// reads them. It asks about the outputs of Hal Finney's first transaction
// (block 170), both long spent:
// - full: names the spender and its status (mempool.space, Blockstream,
//   Esplora)
// - bare, verified: only {spent: true}, but /api/prevouts tells confirmed
//   from mempool spends (a mempool on Bitcoin Core)
// - bare, unverified: no /api/prevouts; limited, shown as a warning
// The request shape that answered goes in the detail. Read-only.
const PROBE_TXID = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
// The probe asks the node fresh and leaves nothing in the outspend
// cache: a connection test must not change what a UTXO rule watching
// the same outputs reads.
function forgetProbeOutspends(apiBase) {
  forgetOutspends(apiBase, PROBE_TXID, [0, 1]);
}
async function testRpcUser(apiBase) {
  const open = await rpc.loginUnrestricted(apiBase);
  if (open === null) return null;
  if (!open) return { ok: true, detail: 'restricted by rpcwhitelist', value: 'Restricted' };
  return { ok: false, warn: true, kind: 'rpc-user', detail: 'this RPC login can make any call, including wallet and node control', value: 'Unrestricted',
    note: 'This RPC login can do anything on the node, including spending from a loaded wallet. Give Standby a restricted user (see SECURITY.md).' };
}

// RPC: ask Bitcoin Core whether txindex is on (getindexinfo, Core 0.21+)
// so the owner is told to enable it. null when the node cannot say.
const TXINDEX_OFF = { ok: false, warn: true, kind: 'rpc', detail: 'txindex is off — add txindex=1 to bitcoin.conf and restart Bitcoin Core. Until then an input spent by a confirmed transaction reads unknown (never stale), and a UTXO rule on a spent output never fires.', value: 'txindex off',
  note: 'Add txindex=1 to bitcoin.conf and restart Bitcoin Core. Until then, Standby can\u2019t tell when an input was spent in a block, so it can\u2019t mark that transaction stale or fire a UTXO rule.' };
async function rpcTxindexCheck(apiBase) {
  let info;
  try { info = await rpc.call(apiBase, 'getindexinfo', ['txindex']); } catch { return null; }
  const ti = info && info.txindex;
  if (!ti) return TXINDEX_OFF;
  if (ti.synced === false) {
    return { ok: false, warn: true, kind: 'rpc', detail: 'txindex is still building — spent outputs in blocks it has not indexed yet read unknown until it finishes.', value: 'txindex still building',
      note: 'Bitcoin Core is still building its transaction index. Test again once it finishes.' };
  }
  return null;
}


async function testNodeOutputLookup(apiBase) {
  if (rpc.isRpcBase(apiBase)) {
    const txindex = await rpcTxindexCheck(apiBase);
    if (txindex) return txindex;
  }
  forgetProbeOutspends(apiBase);
  try {
    let entry = null;
    for (const vout of [0, 1]) {
      const out = await mempoolOutspend(PROBE_TXID, vout, apiBase);
      if (out === null && rpc.isRpcBase(apiBase)) {
        return TXINDEX_OFF;
      }
      if (out === null) {
        return { ok: false, detail: 'unavailable — UTXO rules cannot be evaluated against this node', value: 'Unavailable — UTXO rules can\u2019t be evaluated' };
      }
      if (out.spent) { entry = out; break; }
    }
    const shape = singularOnlyBases.has(apiBase) ? 'singular' : 'batch';
    if (!entry) {
      // Both outputs read unspent: the node answers, but not with
      // a spend this probe can read the type from.
      return { ok: true, detail: 'ready (' + shape + '; answer type unknown)', value: 'Answers' };
    }
    if (!entry.bare) {
      return { ok: true, kind: 'full', detail: 'ready — names the spending transaction and its confirmations (' + shape + ')', value: 'Full answers' };
    }
    if (entry.verified && rpc.isRpcBase(apiBase)) {
      return { ok: true, kind: 'rpc-txindex', detail: 'ready — RPC with txindex; a confirmed spend is told from a mempool one', value: 'RPC with txindex' };
    }
    if (entry.verified) {
      return { ok: true, kind: 'bare-verified', detail: 'ready — says only \u201cspent\u201d; /api/prevouts tells a confirmed spend from a mempool one (' + shape + ')', value: 'Bare + confirmation check' };
    }
    return { ok: false, warn: true, kind: 'bare', detail: 'limited — says only \u201cspent\u201d and has no /api/prevouts, so a confirmed spend cannot be told from a mempool one', value: 'Bare only \u2014 can\u2019t tell confirmed spends' };
  } catch (e) {
    const msg = e.message || String(e);
    return { ok: false, detail: msg, value: msg };
  } finally {
    forgetProbeOutspends(apiBase);
  }
}

module.exports = { testConnection };
