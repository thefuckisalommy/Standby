'use strict';

// Input freshness: is each input still unspent? One outspend cache for
// every lookup.

const { mempoolHostLabel, mempoolReq, mempoolTxStatus } = require('./nodes');

// One outspend cache for every lookup, keyed by endpoint and outpoint,
// with the check cadence as TTL (default 60 s), so the trigger and
// freshness paths share requests. Never cached: a 404 (unknown parent: a
// later spend must not be missed) or a failed request. Unknown never means
// unspent.
const outspendCache = new Map(); // key -> { fetchedAtMs, result }
const OUTSPEND_CACHE_DEFAULT_TTL_MS = 60 * 1000;
// Bases whose batch outspend route is missing (a batch 404 then a singular
// success). Implementations differ in which routes they serve, so the
// client tries the batch, falls back to the singular, and remembers the
// base. In memory only: a restart re-learns it, and the test cache-clear
// hook does not reset it.
const singularOnlyBases = new Set();
// Test only: drop all outspend cache entries and in-flight lookups (via
// POST /__test__/clear-caches, test mode only).
function clearOutspendCache() {
  outspendCache.clear();
  outspendInflight.clear();
  outspendsInflight.clear();
}
// In-flight dedup: overlapping lookups of the same outpoint or batch share
// one request. The entry is dropped when it settles, so a failure never
// poisons later lookups.
const outspendInflight = new Map(); // key -> Promise<parsed|null>
const outspendsInflight = new Map(); // key -> Promise<array|null>

function outspendCacheKey(apiBase, prevTxid, prevVout) {
  return apiBase + '|' + prevTxid + ':' + prevVout;
}

function outspendCacheTtlMs(ttlMs) {
  return (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) ? ttlMs : OUTSPEND_CACHE_DEFAULT_TTL_MS;
}

function outspendCacheGet(apiBase, prevTxid, prevVout, ttlMs) {
  const e = outspendCache.get(outspendCacheKey(apiBase, prevTxid, prevVout));
  if (!e) return undefined;
  if (Date.now() - e.fetchedAtMs >= outspendCacheTtlMs(ttlMs)) {
    outspendCache.delete(outspendCacheKey(apiBase, prevTxid, prevVout));
    return undefined;
  }
  return e.result;
}

// Drop cached answers for these outputs (the node Test's probe must not
// change what a UTXO rule watching the same outputs reads).
function forgetOutspends(apiBase, prevTxid, vouts) {
  for (const vout of vouts) outspendCache.delete(outspendCacheKey(apiBase, prevTxid, vout));
}
function outspendCachePut(apiBase, prevTxid, prevVout, result) {
  outspendCache.set(outspendCacheKey(apiBase, prevTxid, prevVout), { fetchedAtMs: Date.now(), result });
}

// One outpoint's spend status (GET /api/tx/:txid/outspend/:vout, or the
// batch). The batch goes first; if it cannot answer (404: unknown parent
// or missing route) the singular is tried, and a base that needed it is
// recorded singular-only. A 404 from both is unknown and never cached;
// other errors throw. skipBatch: the batch was already tried for this
// funding tx.
// Bare answers: a mempool on bitcoind (BACKEND=none) answers {spent: true}
// with no spender or status. Any spend without a spender txid is checked
// with the same node's POST /api/prevouts (confirmed UTXO set only): null
// means spent by a confirmed transaction, a value means the spend is
// mempool-only. If that cannot be checked it reads as unconfirmed, never
// confirmed (which would make the transaction stale for good). Such
// entries are marked bare.
const PREVOUTS_MAX = 100; // the route's per-request limit
function isBareSpent(entry) {
  return !!entry && typeof entry === 'object' && entry.spent === true && !entry.txid;
}
async function resolveBareSpends(prevTxid, entries, apiBase) {
  const bare = entries.filter(([, e]) => isBareSpent(e));
  for (let i = 0; i < bare.length; i += PREVOUTS_MAX) {
    const chunk = bare.slice(i, i + PREVOUTS_MAX);
    let answers = null;
    try {
      const body = JSON.stringify(chunk.map(([vout]) => ({ txid: prevTxid, vout: Number(vout) })));
      const res = await mempoolReq('/api/prevouts', 'POST', body, apiBase, undefined, 'application/json');
      if (res.status === 200) {
        const parsed = JSON.parse(res.body);
        if (Array.isArray(parsed) && parsed.length === chunk.length) answers = parsed;
      }
    } catch (e) { /* unverifiable — treated as unconfirmed below */ }
    chunk.forEach(([, entry], j) => {
      entry.bare = true;
      entry.verified = answers !== null; // false: the node could not say — read as unconfirmed, but say so
      entry.status = { confirmed: answers !== null && answers[j] === null };
    });
  }
}

async function mempoolOutspend(prevTxid, prevVout, apiBase, ttlMs, skipBatch) {
  const cached = outspendCacheGet(apiBase, prevTxid, prevVout, ttlMs);
  if (cached !== undefined) return cached;
  const key = outspendCacheKey(apiBase, prevTxid, prevVout);
  const inflight = outspendInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const shapes = skipBatch ? ['singular']
      : (singularOnlyBases.has(apiBase) ? ['singular', 'batch'] : ['batch', 'singular']);
    let batchAnswered = false;
    for (const shape of shapes) {
      if (shape === 'batch') {
        // Cache only the requested outpoint: caching its siblings would
        // plant answers nobody asked for.
        const arr = await mempoolOutspends(prevTxid, apiBase, ttlMs, prevVout);
        if (arr === null) continue; // batch cannot answer — try the singular
        // The batch answered, so this base serves it. A missing entry for
        // this vout still gets the singular, which may know an output the
        // batch does not list.
        batchAnswered = true;
        singularOnlyBases.delete(apiBase);
        const entry = Array.isArray(arr) ? arr[prevVout] : null;
        // Cache this outpoint here: a shared in-flight batch only caches
        // its own cacheVout.
        if (entry && typeof entry === 'object') { outspendCachePut(apiBase, prevTxid, prevVout, entry); return entry; }
        continue;
      }
      const res = await mempoolReq('/api/tx/' + prevTxid + '/outspend/' + prevVout, 'GET', undefined, apiBase);
      if (res.status === 404) return null; // unknown — cannot prove spent or unspent; NEVER cached
      if (res.status === 405 || res.status === 501) continue; // singular route missing here — try the batch
      if (res.status !== 200) throw new Error('mempool outspend check failed (HTTP ' + res.status + ')');
      const parsed = JSON.parse(res.body);
      await resolveBareSpends(prevTxid, [[prevVout, parsed]], apiBase);
      // The singular answered while the batch did not, so the
      // batch route is missing on this base — remember it.
      if (!batchAnswered) singularOnlyBases.add(apiBase);
      outspendCachePut(apiBase, prevTxid, prevVout, parsed);
      return parsed;
    }
    return null; // neither shape could answer — unknown, never cached
  })();
  outspendInflight.set(key, p);
  try { return await p; }
  finally { if (outspendInflight.get(key) === p) outspendInflight.delete(key); }
}

// GET /api/tx/:txid/outspends: one entry per output, in vout order. 404,
// 405 or 501 return null (unknown or route missing: never cached) so the
// caller can try the singular. With cacheVout only that output is cached,
// so a batch fetched for one outpoint never plants answers for its
// siblings.
async function mempoolOutspends(prevTxid, apiBase, ttlMs, cacheVout) {
  const key = apiBase + '|' + prevTxid;
  const inflight = outspendsInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await mempoolReq('/api/tx/' + prevTxid + '/outspends', 'GET', undefined, apiBase);
    if (res.status === 404 || res.status === 405 || res.status === 501) return null; // unknown, or route missing — NEVER cached
    if (res.status !== 200) throw new Error('mempool outspends check failed (HTTP ' + res.status + ')');
    const arr = JSON.parse(res.body);
    if (Array.isArray(arr)) await resolveBareSpends(prevTxid, arr.map((e, i) => [i, e]), apiBase);
    if (Array.isArray(arr)) {
      const only = (cacheVout === undefined || cacheVout === null) ? null : Number(cacheVout);
      arr.forEach((entry, i) => {
        if (entry && typeof entry === 'object' && (only === null || i === only)) outspendCachePut(apiBase, prevTxid, i, entry);
      });
    }
    return arr;
  })();
  outspendsInflight.set(key, p);
  try { return await p; }
  finally { if (outspendsInflight.get(key) === p) outspendsInflight.delete(key); }
}

// Batch outspend check, primary first: { txid, results, unknown,
// checkedVia, checkedBase, error? } (results null when unknown). A 404 is
// inconclusive, so the next endpoint is asked.
async function checkOutspends(prevTxid, endpoints, ttlMs) {
  const errors = [];
  let first404 = null;
  for (const ep of endpoints) {
    try {
      const arr = await mempoolOutspends(prevTxid, ep.base, ttlMs);
      if (arr === null) {
        if (!first404) first404 = ep;
        continue;
      }
      return { txid: prevTxid, results: arr, unknown: false, checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (first404) {
    return { txid: prevTxid, results: null, unknown: true, checkedVia: first404.label, checkedBase: first404.base };
  }
  return { txid: prevTxid, results: null, unknown: true, checkedVia: null, checkedBase: null, error: errors.join('; ') };
}

// One evaluation's batch plan: funding txs with two or more watched
// outputs, each fetched lazily (only if a rule for it is evaluated). Built
// per evaluation; callers without a plan use the singular path.
function createOutspendBatch(plan, endpoints, ttlMs) {
  const fetched = new Map(); // txid -> Promise<checkOutspends result>
  return {
    plan,
    hasBatch(txid) {
      const s = plan.get(txid);
      return !!s && s.size >= 2;
    },
    fetch(txid) {
      if (!fetched.has(txid)) fetched.set(txid, checkOutspendsCached(txid, endpoints, ttlMs, plan.get(txid)));
      return fetched.get(txid);
    },
  };
}

// Assemble the batch from cache when every watched output is fresh there,
// primary entries only (a secondary answer never stands in for the
// primary). Otherwise fetch it.
async function checkOutspendsCached(prevTxid, endpoints, ttlMs, watched) {
  const primary = endpoints && endpoints[0];
  if (primary && watched && watched.size > 0) {
    const results = [];
    let allFresh = true;
    for (const vout of watched) {
      const entry = outspendCacheGet(primary.base, prevTxid, vout, ttlMs);
      if (entry === undefined) { allFresh = false; break; }
      results[vout] = entry;
    }
    if (allFresh) {
      return { txid: prevTxid, results, unknown: false, checkedVia: primary.label, checkedBase: primary.base };
    }
  }
  return checkOutspends(prevTxid, endpoints, ttlMs);
}

// One outspend answer as checkOutspend returns it. A missing entry is
// unknown, never unspent.
function outspendEntryToResult(outpoint, entry, checkedVia, checkedBase) {
  if (!entry || typeof entry !== 'object') {
    return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia, checkedBase };
  }
  const spent = !!entry.spent;
  const confirmed = !!(entry.status && entry.status.confirmed === true);
  const blockHeight = (confirmed && entry.status && Number.isFinite(entry.status.block_height)) ? entry.status.block_height : null;
  return { outpoint, spent, confirmed, txid: spent ? (entry.txid || null) : null, blockHeight, bare: !!entry.bare, unverified: !!entry.bare && entry.verified === false, unknown: false, checkedVia, checkedBase };
}

// Input freshness against one endpoint. A spent input is one of:
// - own: spent by this transaction's own txid: it is already out there
//   (broadcast)
// - spent: spent by another, confirmed transaction: stale
// - conflict: spent by another, unconfirmed (or unknown-status)
//   transaction: a warning; the broadcast is still attempted
async function checkInputsUnspentVia(parsed, apiBase, ttlMs) {
  const unspent = [];
  const spent = [];
  const conflict = [];
  const own = [];
  const unknown = [];
  // A bare spend cannot be matched to our txid, so ask the node about our
  // own txid (once per tx): if it knows it, the spender is us. A failed
  // lookup leaves the input unknown, never stale.
  let ownLookup; // undefined = not asked; null = not known; 'error'; else the tx status
  const ownStatus = async () => {
    if (ownLookup === undefined) {
      try {
        const t = await mempoolTxStatus(parsed.txid, apiBase);
        ownLookup = t ? (t.status || {}) : null;
      } catch (e) { ownLookup = 'error'; }
    }
    return ownLookup;
  };
  for (const inp of parsed.inputs) {
    const out = await mempoolOutspend(inp.prevTxid, inp.prevVout, apiBase, ttlMs);
    if (out === null) { unknown.push(inp); continue; }
    if (out.spent && out.bare) {
      const mine = await ownStatus();
      if (mine === 'error') { unknown.push(inp); continue; }
      if (mine) {
        own.push({ ...inp, spentBy: parsed.txid, confirmed: mine.confirmed === true,
          blockHeight: Number.isFinite(mine.block_height) ? mine.block_height : null });
        continue;
      }
    }
    if (!out.spent) unspent.push(inp);
    else if (out.txid && out.txid.toLowerCase() === parsed.txid.toLowerCase()) {
      own.push({ ...inp, spentBy: out.txid, confirmed: !!(out.status && out.status.confirmed),
        blockHeight: (out.status && Number.isFinite(out.status.block_height)) ? out.status.block_height : null });
    } else if (out.status && out.status.confirmed === true) spent.push({ ...inp, spentBy: out.txid || null,
      blockHeight: (out.status && Number.isFinite(out.status.block_height)) ? out.status.block_height : null });
    else conflict.push({ ...inp, spentBy: out.txid || null, unverified: !!(out.bare && out.verified === false) });
  }
  return { checked: parsed.inputs.length, unspent, spent, conflict, own, unknown };
}

// Returns { checked, unspent, spent, conflict, own, unknown, checkedVia,
// checkedBase }. Endpoints are tried in order; a completed check is
// definitive and only a failed one falls through. A 404 for an input is
// not a check (the node does not know the parent), so that input is asked
// on the next endpoint and stays unknown only if none can say.
async function checkInputsUnspent(parsed, endpoints, ttlMs) {
  const errors = [];
  let acc = null;
  let remaining = parsed.inputs;
  for (const ep of endpoints) {
    if (!remaining.length) break;
    try {
      const result = await checkInputsUnspentVia({ ...parsed, inputs: remaining }, ep.base, ttlMs);
      if (!acc) {
        acc = { checked: parsed.inputs.length, unspent: [], spent: [], conflict: [], own: [], unknown: [], checkedVia: ep.label, checkedBase: ep.base };
      }
      acc.unspent.push(...result.unspent);
      acc.spent.push(...result.spent);
      acc.conflict.push(...result.conflict);
      acc.own.push(...result.own);
      // checkedVia: 'secondary' if any input needed the fallback, else
      // 'primary'.
      if (result.unspent.length || result.spent.length || result.conflict.length || result.own.length) {
        acc.checkedVia = ep.label;
        acc.checkedBase = ep.base;
      }
      remaining = result.unknown;
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (!acc) throw new Error('could not verify inputs (' + errors.join('; ') + ')');
  acc.unknown = remaining;
  return acc;
}

// UTXO trigger: is a watched outpoint spent? Returns { outpoint, spent,
// confirmed, txid, blockHeight, unknown, checkedVia, checkedBase }.
// unknown when no endpoint can say (all 404 or failed); the trigger never
// fires on it. blockHeight lets the caller count confirmations. Only a
// confirmed spend fires, unless the rule asks for 0 confirmations.
async function checkOutspend(outpoint, endpoints, opts) {
  const parts = String(outpoint || '').split(':');
  const prevTxid = parts[0] || '';
  const prevVout = parseInt(parts[1], 10);
  const ttlMs = opts && opts.ttlMs;
  const batch = opts && opts.batch;
  // Batch path: one fetch answers every watched output of this funding tx.
  // An answer that cannot say about this output is unknown, never unspent.
  // Unless every endpoint failed outright, fall through to the singular,
  // which may answer where the batch could not.
  let batchTried = false;
  if (batch && batch.hasBatch(prevTxid) && Number.isFinite(prevVout) && prevVout >= 0) {
    const b = await batch.fetch(prevTxid);
    if (!b.unknown) {
      const entry = Array.isArray(b.results) ? b.results[prevVout] : null;
      return outspendEntryToResult(outpoint, entry, b.checkedVia, b.checkedBase);
    }
    if (b.error) {
      return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true,
        checkedVia: b.checkedVia, checkedBase: b.checkedBase, error: b.error };
    }
    batchTried = true;
  }
  const errors = [];
  let first404 = null;
  for (const ep of endpoints) {
    try {
      const out = await mempoolOutspend(prevTxid, prevVout, ep.base, ttlMs, batchTried);
      if (out === null) {
        if (!first404) first404 = ep;
        continue;
      }
      return outspendEntryToResult(outpoint, out, ep.label, ep.base);
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (first404) {
    return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia: first404.label, checkedBase: first404.base };
  }
  return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia: null, checkedBase: null, error: errors.join('; ') };
}

module.exports = { singularOnlyBases, clearOutspendCache, mempoolOutspend, checkOutspends, createOutspendBatch, checkInputsUnspent, checkOutspend, forgetOutspends };
