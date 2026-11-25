'use strict';
// Bitcoin Core JSON-RPC as a node. The rest of the app speaks the mempool
// REST API, so answer() serves the few routes it uses from RPC calls, in
// the same shapes and status codes. An RPC node's base is
// "rpc://host:port" ("rpcs://" for https); its login is registered here by
// endpointsFor and never leaves this module.
// What RPC cannot say: who spent a confirmed output, or at what height.
// A confirmed spend is answered bare ({spent: true}) and the caller tells
// confirmed from mempool spends with /api/prevouts, as for a mempool on
// Bitcoin Core. Without txindex a confirmed parent is unknown (404).
const { requestText } = require('./net');
const clock = require('./clock');

const logins = new Map(); // base -> { user, password }

function isRpcBase(base) {
  return typeof base === 'string' && /^rpcs?:\/\//.test(base);
}

// "http://host:port" (a bare host gets http:// and port 8332) to the
// base. Throws on anything else.
function rpcBaseFor(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('RPC address is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('invalid RPC address: ' + raw); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('RPC address must be http(s): ' + raw);
  if (!u.hostname) throw new Error('RPC address needs a host: ' + raw);
  if (u.pathname !== '/' || u.search || u.username || u.password) throw new Error('RPC address is host and port only: ' + raw);
  return (u.protocol === 'https:' ? 'rpcs://' : 'rpc://') + u.hostname + ':' + (u.port || '8332');
}

function register(base, user, password) {
  logins.set(base, { user: String(user || ''), password: String(password || '') });
}

// An enabled RPC setting's base, or null when RPC is off or the address
// is unusable. Registers nothing.
function settingBase(r) {
  if (!r || r.enabled !== true) return null;
  try { return rpcBaseFor(r.url); } catch { return null; }
}

// HTTP 403: this host is not in rpcallowip, or the call is not in the
// user's rpcwhitelist.
class RpcForbidden extends Error {
  constructor() { super('RPC refused this request — check rpcallowip, and rpcwhitelist if set'); }
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// One HTTP request carrying one call, or a batch (an array). Returns the
// parsed reply. HTTP errors other than an RPC error reply throw.
async function post(base, payload, timeoutMs) {
  const login = logins.get(base);
  if (!login) throw new Error('no RPC login saved for this node');
  const u = new URL(base.replace(/^rpc/, 'http'));
  const res = await requestText({
    protocol: base.startsWith('rpcs:') ? 'https:' : 'http:',
    hostname: u.hostname,
    port: parseInt(u.port, 10),
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(login.user + ':' + login.password).toString('base64'),
    },
    body: JSON.stringify(payload),
    timeoutMs,
  });
  clock.observe(res.date);
  if (res.status === 401) throw new Error('RPC login failed — check the username and password');
  if (res.status === 403) throw new RpcForbidden();
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('RPC answered HTTP ' + res.status + ' without JSON'); }
  return data;
}

function unwrap(reply) {
  if (!reply || typeof reply !== 'object') throw new Error('RPC reply is not an object');
  if (reply.error) throw new RpcError(reply.error.code, reply.error.message || 'RPC error');
  return reply.result;
}

async function call(base, method, params, timeoutMs) {
  return unwrap(await post(base, { jsonrpc: '1.0', id: 0, method, params }, timeoutMs));
}

// Several calls in one request; each entry is its result or an RpcError.
async function batch(base, calls, timeoutMs) {
  if (!calls.length) return [];
  const replies = await post(base, calls.map(([method, params], id) => ({ jsonrpc: '1.0', id, method, params })), timeoutMs);
  if (!Array.isArray(replies)) throw new Error('RPC batch reply is not a list');
  return calls.map((_, id) => {
    const r = replies.find((x) => x && x.id === id);
    if (!r) return new RpcError(null, 'missing batch reply');
    try { return unwrap(r); } catch (e) { return e; }
  });
}

const NOT_FOUND = -5; // RPC_INVALID_ADDRESS_OR_KEY: no such transaction
const METHOD_NOT_FOUND = -32601;
const MISC_ERROR = -1;

const sats = (btc) => Math.round(btc * 1e8);
const reply = (status, body) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

// A transaction in the mempool API's shape: vout values in satoshis and a
// status with the block height. null when the node does not know it.
async function txInfo(base, txid, timeoutMs) {
  let tx;
  try {
    tx = await call(base, 'getrawtransaction', [txid, true], timeoutMs);
  } catch (e) {
    if (e.code === NOT_FOUND) return null;
    throw e;
  }
  const status = { confirmed: false };
  if (tx.blockhash && tx.confirmations > 0) {
    const header = await call(base, 'getblockheader', [tx.blockhash], timeoutMs);
    status.confirmed = true;
    status.block_height = header.height;
    status.block_hash = tx.blockhash;
  }
  return { txid: tx.txid, vout: (tx.vout || []).map((o) => ({ value: sats(o.value) })), status };
}

// One output's spend: unspent if it is in the UTXO set with the mempool
// applied; spent with the spender if a mempool transaction spends it;
// otherwise spent by a confirmed transaction, which is answered bare once
// the parent is known to have that output.
async function outspend(base, txid, vout, timeoutMs) {
  const out = await call(base, 'gettxout', [txid, vout, true], timeoutMs);
  if (out) return { spent: false };
  try {
    // With -txospenderindex this also finds confirmed spenders, with
    // their block hash.
    const [hit] = await call(base, 'gettxspendingprevout', [[{ txid, vout }]], timeoutMs);
    if (hit && hit.spendingtxid && hit.blockhash) {
      const header = await call(base, 'getblockheader', [hit.blockhash], timeoutMs);
      return { spent: true, txid: hit.spendingtxid, vin: null, status: { confirmed: true, block_height: header.height, block_hash: hit.blockhash } };
    }
    if (hit && hit.spendingtxid) return { spent: true, txid: hit.spendingtxid, vin: null, status: { confirmed: false } };
  } catch (e) {
    // Before Core 24 there is no such call; an index that is not caught up
    // answers RPC_MISC_ERROR. Either way, read the spend as below.
    if (e.code !== METHOD_NOT_FOUND && e.code !== MISC_ERROR) throw e;
  }
  const parent = await txInfo(base, txid, timeoutMs);
  if (!parent || vout >= parent.vout.length) return null;
  return { spent: true };
}

async function feeEstimates(base, targets, timeoutMs) {
  const results = await batch(base, targets.map((t) => ['estimatesmartfee', [t, 'ECONOMICAL']]), timeoutMs);
  const out = {};
  targets.forEach((t, i) => {
    const r = results[i];
    if (r instanceof Error) throw r;
    if (r && typeof r.feerate === 'number' && r.feerate > 0) out[String(t)] = r.feerate * 1e5; // BTC/kvB to sat/vB
  });
  return out;
}

// Core's "already known" rejections, worded so the broadcast code reads
// them as already out.
function broadcastError(e) {
  if (/txn-already-in-mempool|txn-already-known|already in block chain|outputs already in utxo set/i.test(e.message)) {
    return 'Transaction already in mempool (' + e.message + ')';
  }
  return e.message;
}

// The mempool route answered from RPC: { status, body }. Unknown routes
// 404 like a node without them. Network and login failures throw.
async function answer(path, method, body, base, timeoutMs, feeTargets) {
  let m;
  try {
    if (method === 'GET' && path === '/api/blocks/tip/height') {
      return reply(200, String(await call(base, 'getblockcount', [], timeoutMs)));
    }
    if (method === 'GET' && path === '/api/fee-estimates') {
      return reply(200, await feeEstimates(base, feeTargets, timeoutMs));
    }
    if (method === 'POST' && path === '/api/tx') {
      try {
        return reply(200, await call(base, 'sendrawtransaction', [String(body || '').trim()], timeoutMs));
      } catch (e) {
        if (e instanceof RpcError) return reply(400, broadcastError(e));
        throw e;
      }
    }
    if (method === 'POST' && path === '/api/prevouts') {
      const outpoints = JSON.parse(body);
      const results = await batch(base, outpoints.map((o) => ['gettxout', [o.txid, o.vout, false]]), timeoutMs);
      return reply(200, results.map((r) => {
        if (r instanceof Error) throw r;
        return r ? { prevout: { value: sats(r.value) }, unconfirmed: false } : null;
      }));
    }
    if (method === 'GET' && (m = path.match(/^\/api\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) {
      const entry = await outspend(base, m[1], parseInt(m[2], 10), timeoutMs);
      return entry ? reply(200, entry) : reply(404, 'Transaction not found');
    }
    if (method === 'GET' && (m = path.match(/^\/api\/tx\/([0-9a-f]{64})$/))) {
      const tx = await txInfo(base, m[1], timeoutMs);
      return tx ? reply(200, tx) : reply(404, 'Transaction not found');
    }
    // The batch outspends route is left to the singular, which also works
    // without txindex for unspent outputs.
    if (method === 'GET' && /^\/api\/tx\/[0-9a-f]{64}\/outspends$/.test(path)) return reply(501, 'not served over RPC');
    return reply(404, 'not served over RPC');
  } catch (e) {
    if (e instanceof RpcError) throw new Error('RPC ' + (e.code != null ? e.code + ': ' : '') + e.message);
    throw e;
  }
}

// A node's RPC setting from a save or a restore: { enabled, url, user,
// password }. A blank password keeps the stored one (the browser never
// sees it); RPC off clears the login. Throws on anything unusable.
function normalizeSetting(input, stored) {
  if (!input || typeof input !== 'object') throw new Error('RPC setting must be an object');
  if (typeof input.enabled !== 'boolean') throw new Error('RPC enabled must be true or false');
  const keep = stored && typeof stored === 'object' ? stored : {};
  const str = (v, name) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > 500) throw new Error('RPC ' + name + ' must be text');
    return v.trim();
  };
  const url = str(input.url, 'address');
  const user = str(input.user, 'username');
  const password = (typeof input.password === 'string' && input.password !== '') ? str(input.password, 'password')
    : (typeof keep.password === 'string' ? keep.password : '');
  if (input.enabled) {
    rpcBaseFor(url);
    if (!user || !password) throw new Error('RPC needs a username and password');
  }
  // Off forgets the login and keeps the address (tidied when valid).
  if (!input.enabled) {
    let kept = url;
    try { if (url) kept = rpcBaseFor(url).replace(/^rpc/, 'http'); } catch { /* keep as typed */ }
    return { enabled: false, url: kept, user: '', password: '' };
  }
  return { enabled: true, url: rpcBaseFor(url).replace(/^rpc/, 'http'), user, password };
}

// What the browser sees: everything but the password.
function publicSetting(r) {
  if (!r || typeof r !== 'object') return { enabled: false, url: '', user: '', hasPassword: false };
  return { enabled: r.enabled === true, url: r.url || '', user: r.user || '', hasPassword: !!r.password };
}

// Whether this login can make calls Standby never needs: Standby asks
// for uptime, which a restricted user's rpcwhitelist leaves out. true,
// false, or null when the node could not be asked.
async function loginUnrestricted(base, timeoutMs) {
  try {
    await call(base, 'uptime', [], timeoutMs);
    return true;
  } catch (e) {
    return e instanceof RpcForbidden ? false : null;
  }
}

module.exports = { loginUnrestricted, isRpcBase, rpcBaseFor, settingBase, register, answer, call, normalizeSetting, publicSetting };
