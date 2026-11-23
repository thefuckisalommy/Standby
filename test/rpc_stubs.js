'use strict';
// Bitcoin Core JSON-RPC stub for Standby 0.8.8 local verification.
// Serves the methods the app uses over RPC, in Core's JSON-RPC 2.0
// shape (POST /, {jsonrpc:'2.0', id, method, params} ->
// {result, error, id}; a Core error is {code, message}):
//   getblockcount       -> fixed tip height (default 900000)
//   gettxout            -> FINNEY:0 null (spent, confirmed — hidden
//                          under both include_mempool values),
//                          FINNEY:1 unspent, SECOND:0 unspent,
//                          CONFLICT:0 null when include_mempool is
//                          true but the UTXO when false (spent in
//                          the mempool only — the two-call
//                          comparison, see rpcOutspend),
//                          UNCONF_PARENT:0 null under both (spent,
//                          parent itself unconfirmed — the edge
//                          that stays unknown), anything else null
//                          with an unknown parent
//   getrawtransaction   -> the parent tx (FINNEY / SECOND / CONFLICT /
//                          OWN_SPEND) or a tx registered via
//                          /__test__/rpc-known or recorded by a
//                          broadcast; anything else is Core error -5.
//                          Verbose form models REAL Core: it returns
//                          confirmations, blockhash (a real non-zero
//                          hash for confirmed txs), blocktime, time —
//                          and NO blockheight (Core never returns
//                          one; the height comes from getblockheader)
//   getblockheader      -> {height, ...} for a block hash the stub
//                          issued (unknown hash is Core error -5)
//   estimatesmartfee    -> {feerate, blocks: 6} (default 0.00005
//   estimatesmartfee    -> {feerate, blocks: 6} (default 0.00005
//                          BTC/kB = 5 sat/vB), or "insufficient data"
//   sendrawtransaction  -> the txid; the sentinel txid answers Core
//                          error -27 (already in block chain); '00'
//                          answers -22 (TX decode failed)
//   getblockchaininfo   -> {chain:'main', blocks, headers}
//   node rpc_stubs.js <port>   (env SENTINEL_TXID, STUB_RPC_FEE_RATE,
//   STUB_RPC_FEE_INSUFFICIENT, STUB_RPC_TIP)
// Finney txid: f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
//   vout 0 = 200,000 sats (spent), vout 1 = 150,000 sats (unspent) —
//   the same values the mempool stub serves, so a crafted tx's fee
//   computes identically on either transport.
// Test controls (runtime, per stub process):
//   POST /__test__/rpc-tip  {height} — sets the tip height
//   POST /__test__/rpc-fee  {feerate} | {insufficient: true|false} —
//     sets the estimatesmartfee answer (a feerate in BTC/kB), or
//     makes it fail with "Insufficient data"
//   POST /__test__/rpc-known {txid, confirmations, blockheight} —
//     registers a txid as known to getrawtransaction (the own-tx
//     check: a dry run of that txid reads 'own')
//   POST /__test__/rpc-tx {txid, confirmations, blockheight} —
//     sets the confirmations / block height a broadcasted txid
//     reports (default 6 at block 899995)
//   GET  /__test__/rpc-count — answers the per-method call counts
//     {getblockcount, gettxout, getrawtransaction, getblockheader,
//      estimatesmartfee, sendrawtransaction, getblockchaininfo}
const http = require('http');
const crypto = require('crypto');
const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const SECOND = 'aa'.repeat(32);
const CONFLICT = 'cc'.repeat(32);
const OWN_SPEND = 'ee'.repeat(32);
// (0.8.8) UNCONF_PARENT: a parent that is itself unconfirmed
// (mempool-only). Its child outpoint reads null under BOTH
// include_mempool values — the edge where the two-call spend
// comparison cannot separate a confirmed spend from a
// mempool-only one, so the app reads unknown.
const UNCONF_PARENT = 'dd'.repeat(32);
// A block hash for a height: deterministic and non-zero, so a
// getblockheader(hash) round-trips to the height it was issued
// for — the way real Core behaves (a zero hash would break any
// implementation that looks the height up by hash).
const hashToHeight = {};
function blockHashForHeight(h) {
  const hash = crypto.createHash('sha256').update('standby-block-' + h).digest('hex');
  hashToHeight[hash] = h;
  return hash;
}
const SENTINEL_TXID = (process.env.SENTINEL_TXID || '').toLowerCase();
const CONFIRMED_HEIGHT = 899995;
let tipHeight = parseInt(process.env.STUB_RPC_TIP || '900000', 10) || 900000;
let feeRate = (() => { const v = parseFloat(process.env.STUB_RPC_FEE_RATE || '0.00005'); return Number.isFinite(v) ? v : 0.00005; })();
let feeInsufficient = process.env.STUB_RPC_FEE_INSUFFICIENT === '1';
// Known txids for getrawtransaction: txid -> {confirmations,
// blockheight, vout:[{value (BTC)}]}. The parents are known from
// boot; broadcasts and /__test__/rpc-known add entries.
const known = {};
function parentEntry(txid, confirmations, blockheight, valuesBtc) {
  return { txid, confirmations, blockheight, vout: valuesBtc.map((v, i) => ({ value: v, n: i, scriptPubKey: { hex: '' } })) };
}
known[FINNEY] = parentEntry(FINNEY, 100, 899900, [2.0, 1.5]);
known[SECOND] = parentEntry(SECOND, 100, 899900, [2.0]);
known[CONFLICT] = parentEntry(CONFLICT, 50, 899950, [1.0]);
known[OWN_SPEND] = parentEntry(OWN_SPEND, 50, 899950, [1.0]);
known[UNCONF_PARENT] = parentEntry(UNCONF_PARENT, 0, null, [1.0]);
// The sentinel txid is deliberately NOT pre-registered here: a
// broadcast of it must reach sendrawtransaction and come back as
// Core error -27 ("already in block chain") — the race window
// where the tx lands on the node between the freshness gate and
// the send. (The own-tx check would catch a getrawtransaction-
// known txid first, so a known sentinel could never exercise
// the -27 mapping.)
// Broadcasted txids keep their own confirmation override:
// txid -> {confirmations, blockheight}; default 6 at 899995.
const broadcasted = {};
const counts = { getblockcount: 0, gettxout: 0, getrawtransaction: 0, getblockheader: 0, estimatesmartfee: 0, sendrawtransaction: 0, getblockchaininfo: 0 };

function txidOfHex(hex) {
  try {
    const buf = Buffer.from(String(hex), 'hex');
    const h1 = crypto.createHash('sha256').update(buf).digest();
    const h2 = crypto.createHash('sha256').update(h1).digest();
    return Buffer.from(h2).reverse().toString('hex');
  } catch { return ''; }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', result, error: null, id: id === undefined ? null : id }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', result: null, error: { code, message }, id: id === undefined ? null : id }; }

// One JSON-RPC method. Returns the {result} value, or throws
// {code, message} for a Core error.
function handleMethod(method, params) {
  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case 'getblockcount':
      counts.getblockcount++;
      return tipHeight;
    case 'getblockchaininfo':
      counts.getblockchaininfo++;
      return { chain: 'main', blocks: tipHeight, headers: tipHeight, bestblockhash: '00'.repeat(32), difficulty: 1, mediantime: 0, verificationprogress: 1, initialblockdownload: false, chainwork: '00'.repeat(32), size_on_disk: 0, pruned: false };
    case 'gettxout': {
      counts.gettxout++;
      const txid = String(p[0] || '').toLowerCase();
      const vout = parseInt(p[1], 10);
      // (0.8.8) The include_mempool flag (third param, default
      // true) models real Core: a mempool-only spend still shows
      // the UTXO when include_mempool is false (chain only) and
      // hides it when true. CONFLICT:0 is the mempool-spent
      // outpoint; FINNEY:0 is confirmed-spent (hidden under
      // both); UNCONF_PARENT:0 is spent with an unconfirmed
      // parent (hidden under both — the edge that stays unknown).
      const includeMempool = p[2] !== false;
      if (txid === FINNEY && vout === 1) {
        return { bestblock: '00'.repeat(32), confirmations: 100, value: 1.5, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' }, coinbase: false };
      }
      if (txid === SECOND && vout === 0) {
        return { bestblock: '00'.repeat(32), confirmations: 100, value: 2.0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' }, coinbase: false };
      }
      if (txid === CONFLICT && vout === 0 && !includeMempool) {
        return { bestblock: '00'.repeat(32), confirmations: 50, value: 1.0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' }, coinbase: false };
      }
      return null; // spent (FINNEY:0, CONFLICT:0, OWN_SPEND:0, UNCONF_PARENT:0) or unknown parent — getrawtransaction decides which
    }
    case 'getrawtransaction': {
      counts.getrawtransaction++;
      const txid = String(p[0] || '').toLowerCase();
      const verbose = p[1] === true;
      const entry = known[txid];
      if (!entry) throw { code: -5, message: 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.' };
      if (!verbose) return '00'; // non-verbose is raw hex; the app always asks verbose
      const out = { txid: entry.txid, hash: entry.txid, version: 1, size: 100, vsize: 100, weight: 400, locktime: 0,
        vin: [], vout: entry.vout.map((o, i) => ({ value: o.value, n: i, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } })) };
      if (typeof entry.confirmations === 'number' && entry.confirmations > 0) {
        out.confirmations = entry.confirmations;
        // Real Core: a confirmed tx carries blockhash/blocktime/
        // time — and NO blockheight. The height is recovered via
        // getblockheader(blockhash); a zero blockhash here would
        // break that lookup, so the hash is a real one for the
        // confirming height. A mempool (0-confirmation) tx
        // carries NO confirmations key at all — the app reads
        // "no key" the same as 0, and the distinction matters for
        // the two-call spend comparison (see rpcOutspend).
        out.blockhash = blockHashForHeight(entry.blockheight); out.blocktime = 0; out.time = 0;
      }
      return out;
    }
    case 'getblockheader': {
      counts.getblockheader++;
      const hash = String(p[0] || '').toLowerCase();
      const height = hashToHeight[hash];
      if (typeof height !== 'number') throw { code: -5, message: 'Block not found' };
      return { hash, confirmations: tipHeight - height + 1, height, version: 1, versionHex: '00000001', merkleroot: '00'.repeat(32), time: 0, mediantime: 0, nonce: 0, bits: '1d00ffff', difficulty: 1, chainwork: '00'.repeat(32), nTx: 1, previousblockhash: '00'.repeat(32), nextblockhash: null };
    }
    case 'estimatesmartfee': {
      counts.estimatesmartfee++;
      if (feeInsufficient) throw { code: -32603, message: 'Insufficient data or no feerate found' };
      return { feerate: feeRate, blocks: 6 };
    }
    case 'sendrawtransaction': {
      counts.sendrawtransaction++;
      const hex = String(p[0] || '');
      if (hex === '00') throw { code: -22, message: 'TX decode failed' };
      const txid = txidOfHex(hex);
      if (txid && txid === SENTINEL_TXID) throw { code: -27, message: 'Transaction already in block chain' };
      if (txid) {
        const ov = broadcasted[txid] || { confirmations: 6, blockheight: CONFIRMED_HEIGHT };
        known[txid] = parentEntry(txid, ov.confirmations, ov.blockheight, [1.0]);
      }
      return txid;
    }
    default:
      throw { code: -32601, message: 'Method not found' };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  };
  try {
    if (req.url.startsWith('/__test__/')) {
      const body = await readBody(req);
      let b = {};
      try { b = body ? JSON.parse(body) : {}; } catch { b = {}; }
      if (req.url === '/__test__/rpc-tip' && req.method === 'POST') {
        if (Number.isFinite(b.height) && b.height >= 0) tipHeight = Math.floor(b.height);
        return send(200, { height: tipHeight });
      }
      if (req.url === '/__test__/rpc-fee' && req.method === 'POST') {
        if (b.insufficient === true) feeInsufficient = true;
        else if (b.insufficient === false) feeInsufficient = false;
        if (typeof b.feerate === 'number' && Number.isFinite(b.feerate) && b.feerate >= 0) { feeRate = b.feerate; feeInsufficient = false; }
        return send(200, { feerate: feeRate, insufficient: feeInsufficient });
      }
      if (req.url === '/__test__/rpc-known' && req.method === 'POST') {
        const txid = String(b.txid || '').toLowerCase();
        if (/^[0-9a-f]{64}$/.test(txid)) {
          known[txid] = parentEntry(txid, b.confirmations, b.blockheight, [1.0]);
          return send(200, { ok: true, txid });
        }
        return send(400, { error: 'bad txid' });
      }
      if (req.url === '/__test__/rpc-tx' && req.method === 'POST') {
        const txid = String(b.txid || '').toLowerCase();
        if (/^[0-9a-f]{64}$/.test(txid)) {
          broadcasted[txid] = { confirmations: b.confirmations, blockheight: b.blockheight };
          if (known[txid]) known[txid] = parentEntry(txid, b.confirmations, b.blockheight, [1.0]);
          return send(200, { ok: true, txid });
        }
        return send(400, { error: 'bad txid' });
      }
      if (req.url === '/__test__/rpc-count' && req.method === 'GET') return send(200, { ...counts });
      return send(404, { error: 'unknown test route' });
    }
    if (req.method !== 'POST') return send(405, rpcError(null, -32600, 'method not allowed'));
    const body = await readBody(req);
    let msg;
    try { msg = JSON.parse(body); } catch { return send(200, rpcError(null, -32700, 'Parse error')); }
    const id = msg && msg.id !== undefined ? msg.id : null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return send(200, rpcError(id, -32600, 'Invalid Request'));
    try {
      const result = handleMethod(msg.method, msg.params);
      return send(200, rpcResult(id, result));
    } catch (e) {
      if (e && typeof e.code === 'number') return send(200, rpcError(id, e.code, e.message || 'error'));
      throw e;
    }
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
});

const port = parseInt(process.argv[2] || '0', 10);
server.listen(port, '127.0.0.1');
