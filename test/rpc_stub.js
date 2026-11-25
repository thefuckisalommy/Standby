'use strict';
// Bitcoin Core JSON-RPC stub: the calls Standby makes, against a tiny
// chain. node rpc_stub.js <port>
// FINNEY: vout 0 spent by a confirmed tx, vout 1 unspent (values 200,000
// and 150,000 sats). SECOND ('aa'*32): one unspent output (200,000).
// Parents are confirmed at 899000; tip 900000. A sent transaction
// confirms at 899995 and spends its inputs (or stays in the mempool in
// mempool mode). Login: user "standby", password "stubpass".
// Test controls (plain HTTP, no login):
// - POST /__test__/txindex { enabled, synced }: without it, getrawtransaction
//   knows mempool transactions only
// - POST /__test__/mempool-spend { txid, vout, spender }: a mempool spend
// - POST /__test__/old-core { enabled }: no gettxspendingprevout
// - POST /__test__/send-mode { mode: 'confirm'|'mempool' }
// - POST /__test__/fees { economyFee } (sat/vB)
// - POST /__test__/reset
// - GET /__test__/calls: method call counts; GET /__test__/sent: raw hexes sent
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '18198', 10);
const USER = 'standby';
const PASS = 'stubpass';
const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const SECOND = 'aa'.repeat(32);
const TIP = 900000;

let world;
function reset() {
  world = {
    txindex: true, txindexSynced: true, oldCore: false, sendMode: 'confirm', economyFee: 1,
    // txid -> { vouts: [sats], height: number|null (null: mempool), hex }
    txs: new Map([[FINNEY, { vouts: [200000, 150000], height: 899000 }], [SECOND, { vouts: [200000], height: 899000 }]]),
    // 'txid:vout' -> { spender, confirmed }
    spends: new Map([[FINNEY + ':0', { spender: 'bb'.repeat(32), confirmed: true }]]),
    calls: {}, sent: [],
  };
}
reset();

function txidOf(hex) {
  const h1 = crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest();
  return crypto.createHash('sha256').update(h1).digest().reverse().toString('hex');
}

// Inputs and output values of a raw transaction (legacy or segwit).
function parseTx(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4;
  const varint = () => {
    const n = b[o++];
    if (n < 0xfd) return n;
    if (n === 0xfd) { o += 2; return b.readUInt16LE(o - 2); }
    o += 4; return b.readUInt32LE(o - 4);
  };
  let segwit = false;
  if (b[o] === 0 && b[o + 1] === 1) { segwit = true; o += 2; }
  const nin = varint();
  const inputs = [];
  for (let i = 0; i < nin; i++) {
    const txid = Buffer.from(b.subarray(o, o + 32)).reverse().toString('hex');
    const vout = b.readUInt32LE(o + 32);
    o += 36;
    const scriptLen = varint(); // read before adding: varint() moves o
    o += scriptLen + 4;
    inputs.push({ txid, vout });
  }
  const nout = varint();
  const vouts = [];
  for (let i = 0; i < nout; i++) {
    vouts.push(Number(b.readBigUInt64LE(o))); o += 8;
    const scriptLen = varint();
    o += scriptLen;
  }
  if (o > b.length || (!segwit && o + 4 !== b.length)) throw new Error('decode');
  return { inputs, vouts, txid: txidOf(hex) }; // legacy txid; the suites send legacy transactions
}

class RpcErr { constructor(code, message) { this.code = code; this.message = message; } }
const btc = (s) => s / 1e8;

function utxo(txid, vout, includeMempool) {
  const t = world.txs.get(txid);
  if (!t || vout >= t.vouts.length) return null;
  if (!includeMempool && t.height === null) return null;
  const sp = world.spends.get(txid + ':' + vout);
  if (sp && (sp.confirmed || includeMempool)) return null;
  return { bestblock: 'blk' + TIP, confirmations: t.height === null ? 0 : TIP - t.height + 1, value: btc(t.vouts[vout]) };
}

const methods = {
  getblockcount: () => TIP,
  getindexinfo: ([name]) => {
    if (world.oldCore) throw new RpcErr(-32601, 'Method not found');
    return world.txindex && (!name || name === 'txindex') ? { txindex: { synced: world.txindexSynced, best_block_height: TIP } } : {};
  },
  gettxout: ([txid, vout, mem]) => utxo(txid, vout, mem !== false),
  gettxspendingprevout: ([outpoints]) => {
    if (world.oldCore) throw new RpcErr(-32601, 'Method not found');
    return outpoints.map(({ txid, vout }) => {
      const sp = world.spends.get(txid + ':' + vout);
      return sp && !sp.confirmed ? { txid, vout, spendingtxid: sp.spender } : { txid, vout };
    });
  },
  getrawtransaction: ([txid]) => {
    const t = world.txs.get(txid);
    if (!t || (!world.txindex && t.height !== null)) {
      throw new RpcErr(-5, world.txindex ? 'No such mempool or blockchain transaction.'
        : 'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.');
    }
    const r = { txid, vout: t.vouts.map((v, n) => ({ value: btc(v), n })) };
    if (t.height !== null) { r.blockhash = 'blk' + t.height; r.confirmations = TIP - t.height + 1; }
    return r;
  },
  getblockheader: ([hash]) => {
    const m = /^blk(\d+)$/.exec(hash);
    if (!m) throw new RpcErr(-5, 'Block not found');
    return { hash, height: parseInt(m[1], 10) };
  },
  estimatesmartfee: ([target]) => {
    const rate = world.economyFee * (target >= 144 ? 1 : target >= 6 ? 2 : 4);
    return { feerate: rate / 1e5, blocks: Math.max(2, target) };
  },
  sendrawtransaction: ([hex]) => {
    let tx;
    try { tx = parseTx(hex); } catch { throw new RpcErr(-22, 'TX decode failed'); }
    if (world.txs.has(tx.txid)) {
      throw world.txs.get(tx.txid).height === null
        ? new RpcErr(-26, 'txn-already-in-mempool') : new RpcErr(-27, 'Transaction outputs already in utxo set');
    }
    for (const i of tx.inputs) {
      if (!utxo(i.txid, i.vout, true)) throw new RpcErr(-25, 'bad-txns-inputs-missingorspent');
    }
    const confirm = world.sendMode === 'confirm';
    world.txs.set(tx.txid, { vouts: tx.vouts, height: confirm ? 899995 : null });
    for (const i of tx.inputs) world.spends.set(i.txid + ':' + i.vout, { spender: tx.txid, confirmed: confirm });
    world.sent.push(hex);
    return tx.txid;
  },
};

function run(call) {
  world.calls[call.method] = (world.calls[call.method] || 0) + 1;
  const f = methods[call.method];
  try {
    if (!f) throw new RpcErr(-32601, 'Method not found');
    return { result: f(call.params || []), error: null, id: call.id };
  } catch (e) {
    if (!(e instanceof RpcErr)) throw e;
    return { result: null, error: { code: e.code, message: e.message }, id: call.id };
  }
}

function readJson(req, cb) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { let v = null; try { v = JSON.parse(raw || '{}'); } catch { /* bad body */ } cb(v); });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p.startsWith('/__test__/')) {
    if (req.method === 'GET' && p === '/__test__/calls') return send(res, 200, world.calls);
    if (req.method === 'GET' && p === '/__test__/sent') return send(res, 200, world.sent);
    return readJson(req, (b) => {
      b = b || {};
      if (p === '/__test__/reset') reset();
      else if (p === '/__test__/txindex') { world.txindex = b.enabled !== false; world.txindexSynced = b.synced !== false; }
      else if (p === '/__test__/old-core') world.oldCore = b.enabled === true;
      else if (p === '/__test__/send-mode') world.sendMode = b.mode === 'mempool' ? 'mempool' : 'confirm';
      else if (p === '/__test__/fees') world.economyFee = Number(b.economyFee) || 1;
      else if (p === '/__test__/mempool-spend') world.spends.set(b.txid + ':' + b.vout, { spender: b.spender, confirmed: false });
      else return send(res, 404, { error: 'unknown test route' });
      return send(res, 200, { ok: true });
    });
  }
  if (req.method !== 'POST' || p !== '/') return send(res, 404, { error: 'not found' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="jsonrpc"' });
    return res.end();
  }
  readJson(req, (body) => {
    if (body === null) return send(res, 500, { result: null, error: { code: -32700, message: 'Parse error' }, id: null });
    if (Array.isArray(body)) return send(res, 200, body.map(run));
    const out = run(body);
    // Legacy JSON-RPC 1.0: an error reply is HTTP 500 (404 for an unknown method).
    send(res, out.error ? (out.error.code === -32601 ? 404 : 500) : 200, out);
  });
}).listen(PORT, '127.0.0.1');
