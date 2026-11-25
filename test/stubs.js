'use strict';
// Mempool API stub for the test suites: tip height, outspends, tx lookup
// and broadcast, fees, prices and Slipstream.
// node stubs.js <port> (env SENTINEL_TXID)
// FINNEY (f4184fc5…): vout 0 spent, vout 1 unspent. SECOND ('aa'*32): one
// more unspent input, so two txs can avoid sharing one. Any other parent
// 404s. Tip 900000; a broadcast txid (and the sentinel) reads confirmed at
// 899995. Broadcasting the sentinel answers "already in mempool".
const http = require('http');
const crypto = require('crypto');
const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const SECOND = 'aa'.repeat(32);
// Test control (0.8.1, block-height either-node): the tip is
// settable per stub via POST /__test__/tip { height } so a test can
// make the two nodes disagree. Default 900000.
let tipHeight = 900000;
const TIP = 900000;
const CONFIRMED_HEIGHT = 899995;
const SENTINEL_TXID = process.env.SENTINEL_TXID || '';
// Env hooks:
// - STUB_OUTSPEND_DELAY_MS, STUB_TX_LOOKUP_DELAY_MS,
//   STUB_BROADCAST_DELAY_MS: hold those answers, so a test can land a
//   change mid-request
// - STUB_BIG_RESPONSE_BYTES: an oversized outspend body
// - STUB_BAD_TXID: broadcast answers 200 'not-a-txid'
// - STUB_CONFLICT_MODE: 'cc'*32 is spent by 'dd'*32, 'unconfirmed'
//   (default), 'confirmed' (block 899990) or 'unspent'
// - STUB_OWN_SPEND_TXID: 'ee'*32 is spent (unconfirmed) by that txid;
//   unset, it is unspent
const CONFLICT = 'cc'.repeat(32);
const CONFLICT_SPENDER = 'dd'.repeat(32);
const OWN_SPEND = 'ee'.repeat(32);
const OWN_SPEND_TXID = (process.env.STUB_OWN_SPEND_TXID || '').toLowerCase();
// Test hook (0.7.14): STUB_REJECT_ONCE_TXID=<txid> makes POST /api/tx
// reject the FIRST broadcast of that txid with 400 'non-final'
// (simulating a not-yet-final transaction the node refuses), then
// accept it on later attempts — so a test can prove a failed
// broadcast is retried on the next evaluation and succeeds once
// the rejection lifts. Any other txid is unaffected.
const REJECT_ONCE_TXID = (process.env.STUB_REJECT_ONCE_TXID || '').toLowerCase();
const rejectedOnce = new Set();
// Broadcast failure and counting: POST /__test__/broadcast-fail { fail }
// rejects every broadcast with 400; GET /__test__/broadcast-count counts
// real submissions (the node test's '00' probe is not counted).
let broadcastFail = false;
let broadcastAttempts = 0;
// Test hook (0.8.5, tip fetch): the tip-fail flag makes GET
// /api/blocks/tip/height answer 500 while it is on, and
// tipRequests counts every tip-height request this stub has
// answered. Both are per stub process, runtime-settable via the
// /__test__/tip-fail and /__test__/tip-count endpoints below.
let tipFail = false;
let tipRequests = 0;
// Price feeds, one per provider in the app's registry, in each provider's
// real response shape. STUB_PRICE_USD sets the start (default 98200). POST
// /__test__/price: { usd }, { fail }, { bad: 'zero'|'huge'|'empty'|null }
// on every provider, or with { provider } on one only.
const PRICE_PROVIDERS = ['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp'];
const priceState = {};
// Fees: POST /__test__/fees { economyFee } (default 1). POST
// /__test__/fee-mode { mode }: 'mempool' (default) or 'esplora', which
// 404s /api/v1/fees/recommended so the app falls back to /api/fee-
// estimates.
let feeMode = 'mempool';
// Test hook (0.8.5, fee fetch): feeRequests counts every
// /api/v1/fees/recommended request this stub has answered —
// the node fee fetch and the verdict's hourly current-fees
// fetch both hit this route from the configured node, so a suite
// reads the count as a delta across a controlled window.
// Runtime-readable via GET /__test__/fee-count below.
let feeRequests = 0;
const feeState = { economyFee: 1 };
// feeDelayMs (POST /__test__/fee-delay) holds fee answers; feeEstimatesMap
// (POST /__test__/fee-estimates-map) replaces the /fee-estimates map.
let feeDelayMs = 0;
let feeEstimatesMap = null;
// Request counters for the singular and batch outspend routes (GET
// /__test__/outspend-count, /__test__/outspends-count).
let outspendRequests = 0;
let outspendsRequests = 0;
// outspendDelayMs (POST /__test__/outspend-delay) holds outspend answers;
// outspendFail (POST /__test__/outspend-fail) makes both routes 500.
let outspendDelayMs = parseInt(process.env.STUB_OUTSPEND_DELAY_MS || '0', 10) || 0;
let outspendFail = false;
// outspendMode (POST /__test__/outspend-mode): which outspend routes
// exist, 'both' (default), 'batch', 'singular' or 'neither'. A missing
// route 404s like an unknown parent, so the client has to negotiate.
let outspendMode = 'both';
// outspendStyle (POST /__test__/outspend-style): 'full' (spender and
// status, like Esplora) or 'bitcoind' (bare {spent} in the batch, no
// singular route). /api/prevouts answers in both styles; POST
// /__test__/prevouts-route { enabled } turns it off.
let outspendStyle = 'full';
let prevoutsRoute = true;
// Test hook (0.8.0, UA fix): the User-Agent each price feed was
// last fetched with, so a suite can prove the app identifies
// itself (CoinGecko 403s a missing/non-descriptive UA).
// GET /__test__/price-ua answers it.
const priceUaSeen = {};
for (const id of PRICE_PROVIDERS) {
  priceState[id] = {
    usd: (() => { const v = parseFloat(process.env.STUB_PRICE_USD || '98200'); return Number.isFinite(v) ? v : 98200; })(),
    fail: false,
    bad: null,
  };
}
// The response body for one provider's feed, from its state — the
// real provider's shape, so the app's parser is exercised.
function priceBody(id) {
  const st = priceState[id];
  if (st.bad === 'zero') {
    if (id === 'coingecko') return { bitcoin: { usd: 0 } };
    if (id === 'coinbase') return { data: { amount: '0', currency: 'USD' } };
    if (id === 'binance') return { symbol: 'BTCUSDT', price: '0' };
    if (id === 'kraken') return { result: { XXBTZUSD: { c: ['0'] } } };
    return { last: '0' };
  }
  if (st.bad === 'huge') {
    if (id === 'coingecko') return { bitcoin: { usd: 1000000000000 } };
    if (id === 'coinbase') return { data: { amount: '1000000000000', currency: 'USD' } };
    if (id === 'binance') return { symbol: 'BTCUSDT', price: '1000000000000' };
    if (id === 'kraken') return { result: { XXBTZUSD: { c: ['1000000000000'] } } };
    return { last: '1000000000000' };
  }
  if (st.bad === 'empty') {
    if (id === 'coingecko') return {};
    if (id === 'coinbase') return { data: {} };
    if (id === 'binance') return {};
    if (id === 'kraken') return { result: {} };
    return {};
  }
  if (id === 'coingecko') return { bitcoin: { usd: st.usd } };
  if (id === 'coinbase') return { data: { amount: String(st.usd), currency: 'USD' } };
  if (id === 'binance') return { symbol: 'BTCUSDT', price: String(st.usd) };
  if (id === 'kraken') return { result: { XXBTZUSD: { c: [String(st.usd)] } } };
  return { last: String(st.usd) };
}
// Test hook (0.7.16, Pending card): STUB_UNCONFIRMED_TXID=<txid>
// makes the public /api/tx lookup report that txid as IN the
// mempool but UNCONFIRMED (0 confirmations) instead of confirmed
// at block 899995 — so a test can drive a public broadcast that
// stays pending (broadcasted, 0 confirmations) instead of jumping
// straight to confirmed. Any other txid is unaffected.
const UNCONFIRMED_TXID = (process.env.STUB_UNCONFIRMED_TXID || '').toLowerCase();
const seen = new Set();
if (SENTINEL_TXID) seen.add(SENTINEL_TXID.toLowerCase());

// Slipstream: STUB_SLIPSTREAM_REJECT=<reason> rejects every submission
// with that reason. Submitted txids queue (position 12) and are not
// publicly visible; /__test__/slipstream/visible and /drop drive what MARA
// would do.
const SLIPSTREAM_REJECT = process.env.STUB_SLIPSTREAM_REJECT || '';
const slipstreamQueued = new Set();

function slipstreamStatusBody(txid) {
  return JSON.stringify({
    message: 'Transaction in Slipstream queue',
    market_rate: 1.0,
    functional_rate: 2.0,
    last_24h_odds: 0.05,
    last_7d_odds: 0.3,
    is_next_block: false,
    transaction: {
      txid,
      size: 200,
      weight: 800,
      fee: 400,
      vsize: 200,
      status: { confirmed: false },
      firstSeen: 1762800000,
      position: 12,
    },
    submission_type: 'tx_submission',
  });
}

function txidOf(hex) {
  const b = Buffer.from(hex, 'hex');
  const h1 = crypto.createHash('sha256').update(b).digest();
  return crypto.createHash('sha256').update(h1).digest().reverse().toString('hex');
}

// POST /__test__/outspend { txid, vout, blockHeight } makes that outpoint
// a confirmed spend at that height (900000 - height + 1 confirmations); {
// clear: true } removes it.
const outspendOverride = {};

// Test hook (0.8.1, audit finding 2): unknown parents — POST
// /__test__/unknown-parent {txid} makes this stub answer 404 for
// that parent's outspends, as a node that has never seen the parent
// would; {txid, clear: true} removes it. Per-stub-process state, so
// a suite can make the primary 404 while the secondary answers —
// the 404-failover case. Empty by default.
const unknownParents = new Set();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'GET' && p === '/api/blocks/tip/height') {
    tipRequests++;
    if (tipFail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'tip height unavailable (stub)' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(String(tipHeight));
  }
  // GET /api/v1/fees/recommended: fixed tiers with economyFee from
  // /__test__/fees (default 1). 404 in 'esplora' fee mode.
  if (req.method === 'GET' && p === '/api/v1/fees/recommended') {
    feeRequests++;
    const answer = () => {
      if (feeMode === 'esplora') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found (stub esplora mode)' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ fastestFee: feeState.economyFee, halfHourFee: feeState.economyFee, hourFee: feeState.economyFee, economyFee: feeState.economyFee, minimumFee: 1 }));
    };
    if (feeDelayMs > 0) return setTimeout(answer, feeDelayMs);
    return answer();
  }
  // Esplora-style fee estimates (0.8.1): GET /api/fee-estimates
  // returns a map of confirmation target to fee rate — the shape
  // a plain Esplora serves instead of /api/v1/fees/recommended.
  // The node capability test falls back to it when the mempool
  // fee endpoint 404s. The 144-block rate tracks the settable
  // economy fee, so the same hook drives it.
  if (req.method === 'GET' && p === '/api/fee-estimates') {
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(feeEstimatesMap || { '1': feeState.economyFee + 1, '2': feeState.economyFee + 1, '3': feeState.economyFee, '6': feeState.economyFee, '144': feeState.economyFee, '1008': 1 }));
    };
    if (feeDelayMs > 0) return setTimeout(answer, feeDelayMs);
    return answer();
  }
  // Test control for the fee (0.8.1): POST /__test__/fees
  // { economyFee } sets this stub's economy fee (and its
  // 6-block estimate). Answers the current fee state.
  if (req.method === 'POST' && p === '/__test__/fees') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.economyFee === 'number' && Number.isFinite(b.economyFee) && b.economyFee >= 0) feeState.economyFee = b.economyFee;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, economyFee: feeState.economyFee }));
    });
    return;
  }
  // Test control (0.8.9, accumulated peak):
  // POST /__test__/fee-mode { mode: 'mempool'|'esplora' } — see
  // the feeMode declaration above. Answers the current mode.
  if (req.method === 'POST' && p === '/__test__/fee-mode') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (b.mode === 'mempool' || b.mode === 'esplora') feeMode = b.mode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode: feeMode }));
    });
    return;
  }
  // POST /__test__/fee-delay { ms } and /__test__/fee-estimates-map { map
  // | null }.
  if (req.method === 'POST' && p === '/__test__/fee-delay') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.ms === 'number' && Number.isFinite(b.ms) && b.ms >= 0) feeDelayMs = b.ms;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, delayMs: feeDelayMs }));
    });
    return;
  }
  if (req.method === 'POST' && p === '/__test__/fee-estimates-map') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (b.map === null) feeEstimatesMap = null;
      else if (b.map && typeof b.map === 'object') feeEstimatesMap = b.map;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, map: feeEstimatesMap }));
    });
    return;
  }
  // Tip: POST /__test__/tip-fail { fail } makes the tip read 500; GET
  // /__test__/tip-count counts tip requests; POST /__test__/tip { height }
  // sets the tip.
  if (req.method === 'POST' && p === '/__test__/tip') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.height === 'number' && Number.isFinite(b.height) && b.height >= 0) tipHeight = Math.floor(b.height);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, height: tipHeight }));
    });
    return;
  }
  // Test controls for broadcast failure (0.8.2, full-tick
  // backoff): POST /__test__/broadcast-fail { fail } turns the
  // reject-everything flag on/off; GET /__test__/broadcast-count
  // answers how many REAL broadcast submissions this stub has
  // received (the node-capability probe, body '00', is not counted).
  if (req.method === 'POST' && p === '/__test__/broadcast-fail') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.fail === 'boolean') broadcastFail = b.fail;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, fail: broadcastFail }));
    });
    return;
  }
  if (req.method === 'GET' && p === '/__test__/broadcast-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: broadcastAttempts }));
  }
  // Test controls for the tip fetch (0.8.5): POST
  // /__test__/tip-fail { fail } turns the 500 flag on/off; GET
  // /__test__/tip-count answers how many tip-height requests
  // this stub has answered.
  if (req.method === 'POST' && p === '/__test__/tip-fail') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.fail === 'boolean') tipFail = b.fail;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, fail: tipFail }));
    });
    return;
  }
  if (req.method === 'GET' && p === '/__test__/tip-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: tipRequests }));
  }
  // Test control for the fee fetch (0.8.5): GET
  // /__test__/fee-count answers how many recommended-fee
  // requests this stub has answered.
  if (req.method === 'GET' && p === '/__test__/fee-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: feeRequests }));
  }
  // Test controls for the outspend fetch (0.8.6): GET
  // /__test__/outspend-count answers how many singular outspend
  // requests this stub has answered; GET
  // /__test__/outspends-count how many batch outspends requests.
  if (req.method === 'GET' && p === '/__test__/outspend-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: outspendRequests }));
  }
  if (req.method === 'GET' && p === '/__test__/outspends-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: outspendsRequests }));
  }
  // POST /__test__/outspend-delay { ms } and /__test__/outspend-fail {
  // fail }.
  if (req.method === 'POST' && p === '/__test__/outspend-delay') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.ms === 'number' && Number.isFinite(b.ms) && b.ms >= 0) outspendDelayMs = b.ms;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, delayMs: outspendDelayMs }));
    });
    return;
  }
  if (req.method === 'POST' && p === '/__test__/outspend-fail') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.fail === 'boolean') outspendFail = b.fail;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, fail: outspendFail }));
    });
    return;
  }
  // Test control (0.8.10, generic outspend negotiation):
  // POST /__test__/outspend-mode { mode: 'both'|'batch'|
  // 'singular'|'neither' } — see the outspendMode declaration
  // above. Answers the current mode.
  if (req.method === 'POST' && (p === '/__test__/outspend-style' || p === '/__test__/prevouts-route')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { b = {}; }
      if (p === '/__test__/outspend-style' && (b.style === 'full' || b.style === 'bitcoind')) outspendStyle = b.style;
      if (p === '/__test__/prevouts-route' && typeof b.enabled === 'boolean') prevoutsRoute = b.enabled;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, style: outspendStyle, prevoutsRoute }));
    });
    return;
  }
  if (req.method === 'POST' && p === '/__test__/outspend-mode') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      if (b.mode === 'both' || b.mode === 'batch' || b.mode === 'singular' || b.mode === 'neither') outspendMode = b.mode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode: outspendMode }));
    });
    return;
  }
  // BTC price (0.8.0, two-source 0.8.0): one route per provider,
  // each in the real provider's shape. state.fail answers 500
  // (a dead feed); state.bad answers a malformed reading. The
  // query string is ignored — the stub answers the path. Older
  // suites never call these routes, so the stub stays
  // forward-compatible.
  const PRICE_ROUTES = {
    '/api/v3/simple/price': 'coingecko',
    '/v2/prices/BTC-USD/spot': 'coinbase',
    '/api/v3/ticker/price': 'binance',
    '/0/public/Ticker': 'kraken',
    '/api/v2/ticker/btcusd/': 'bitstamp',
  };
  if (req.method === 'GET' && PRICE_ROUTES[p]) {
    const id = PRICE_ROUTES[p];
    priceUaSeen[id] = req.headers['user-agent'] || null;
    if (priceState[id].fail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'price feed down (stub)' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(priceBody(id)));
  }
  // Test control (0.8.0, UA fix): GET /__test__/price-ua answers
  // the User-Agent last sent to each price feed (or null).
  if (req.method === 'GET' && p === '/__test__/price-ua') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ua: priceUaSeen }));
  }
  // POST /__test__/price: see the price feed hooks above. Answers the
  // current state.
  if (req.method === 'POST' && p === '/__test__/price') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      const targets = (typeof b.provider === 'string' && priceState[b.provider])
        ? [b.provider] : PRICE_PROVIDERS;
      for (const id of targets) {
        if (typeof b.usd === 'number' && Number.isFinite(b.usd)) priceState[id].usd = b.usd;
        if (typeof b.fail === 'boolean') priceState[id].fail = b.fail;
        if (b.bad === null || b.bad === 'zero' || b.bad === 'huge' || b.bad === 'empty') priceState[id].bad = b.bad;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const out = { ok: true };
      for (const id of targets) out[id] = { usd: priceState[id].usd, fail: priceState[id].fail, bad: priceState[id].bad };
      return res.end(JSON.stringify(out));
    });
    return;
  }
  // Test control for the outspend block height (0.8.0): POST
  // /__test__/outspend {txid, vout, blockHeight} overrides the
  // spend's block height for that outpoint; {txid, vout, clear:
  // true} (or blockHeight: null) removes it. Answers the current
  // overrides.
  if (req.method === 'POST' && p === '/__test__/outspend') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      const key = String(b.txid || '').toLowerCase() + ':' + String(b.vout);
      if (b.clear === true || b.blockHeight === null) delete outspendOverride[key];
      else if (typeof b.blockHeight === 'number' && Number.isFinite(b.blockHeight)) outspendOverride[key] = b.blockHeight;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, overrides: outspendOverride }));
    });
    return;
  }
  // Test control for unknown parents (0.8.1, audit finding 2):
  // POST /__test__/unknown-parent {txid} makes this stub 404 that
  // parent's outspends; {txid, clear: true} removes it. Answers the
  // current set.
  if (req.method === 'POST' && p === '/__test__/unknown-parent') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { b = {}; }
      const txid = String(b.txid || '').toLowerCase();
      if (txid) {
        if (b.clear === true) unknownParents.delete(txid);
        else unknownParents.add(txid);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, unknownParents: [...unknownParents] }));
    });
    return;
  }
  // One outpoint's answer, or null to 404 (an unknown parent, or one
  // flagged via /__test__/unknown-parent). Shared by the singular and
  // batch routes. The node test's output-lookup probe reads FINNEY:0.
  function outspendEntry(txid, vout) {
    if (txid !== FINNEY && txid !== SECOND && txid !== CONFLICT && txid !== OWN_SPEND) return null;
    if (unknownParents.has(txid)) return null;
    const okey = txid + ':' + vout;
    if (outspendOverride[okey] !== undefined) {
      return { spent: true, txid: 'aabbccdd', vin: 0, status: { confirmed: true, block_height: outspendOverride[okey] } };
    }
    if (txid === FINNEY && vout === '0') {
      return { spent: true, txid: 'aabbccdd', vin: 0, status: { confirmed: true, block_height: 899990 } };
    }
    if (txid === CONFLICT) {
      const mode = process.env.STUB_CONFLICT_MODE || 'unconfirmed';
      if (mode === 'unspent') return { spent: false };
      return mode === 'confirmed'
        ? { spent: true, txid: CONFLICT_SPENDER, vin: 0, status: { confirmed: true, block_height: 899990 } }
        : { spent: true, txid: CONFLICT_SPENDER, vin: 0, status: { confirmed: false } };
    }
    if (txid === OWN_SPEND) {
      if (!OWN_SPEND_TXID) return { spent: false };
      return { spent: true, txid: OWN_SPEND_TXID, vin: 0, status: { confirmed: false } };
    }
    return { spent: false };
  }
  // Batch outspend (0.8.6, Esplora): GET /api/tx/:txid/outspends
  // answers one entry per output of the funding tx, in vout order
  // — the shape the real endpoint serves. FINNEY has 2 outputs
  // (vout 0 spent, vout 1 unspent); the other known parents have 1.
  // An unknown parent 404s, like the singular route.
  const outs = p.match(/^\/api\/tx\/([0-9a-fA-F]+)\/outspends$/);
  if (req.method === 'GET' && outs) {
    outspendsRequests++;
    if (outspendFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'outspend down (stub)' })); }
    if (outspendMode === 'singular' || outspendMode === 'neither') { res.writeHead(404); return res.end(); }
    const txid = outs[1].toLowerCase();
    const nouts = txid === FINNEY ? 2 : 1;
    const answer = () => {
      const entries = [];
      for (let i = 0; i < nouts; i++) entries.push(outspendEntry(txid, String(i)));
      if (entries.some((e) => e === null)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(outspendStyle === 'bitcoind' ? entries.map((e) => ({ spent: !!e.spent })) : entries));
    };
    if (outspendDelayMs > 0) return setTimeout(answer, outspendDelayMs);
    return answer();
  }
  // POST /api/prevouts (0.8.13): [{txid, vout}] -> one answer per
  // outpoint, from the CONFIRMED UTXO set only, as the real backend's
  // gettxout(txid, vout, false): an output with no spend, or only a
  // mempool spend, is still there (its value); one spent by a
  // confirmed transaction — or unknown — is null.
  if (req.method === 'POST' && p === '/api/prevouts') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!prevoutsRoute) { res.writeHead(404); return res.end(); }
      let list;
      try { list = JSON.parse(raw); } catch { list = null; }
      if (!Array.isArray(list)) { res.writeHead(400); return res.end('Invalid outpoints format'); }
      const answers = list.map((o) => {
        const e = outspendEntry(String(o.txid || '').toLowerCase(), String(o.vout));
        if (e === null) return null;
        if (e.spent && e.status && e.status.confirmed) return null;
        return { prevout: { value: 100000, scriptpubkey: '0014' + '00'.repeat(20) }, unconfirmed: false };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(answers));
    });
    return;
  }
  const out = p.match(/^\/api\/tx\/([0-9a-fA-F]+)\/outspend\/(\d+)$/);
  if (req.method === 'GET' && out) {
    outspendRequests++;
    if (outspendFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'outspend down (stub)' })); }
    if (outspendMode === 'batch' || outspendMode === 'neither' || outspendStyle === 'bitcoind') { res.writeHead(404); return res.end(); }
    const txid = out[1].toLowerCase();
    const vout = out[2];
    const answer = () => {
      const big = parseInt(process.env.STUB_BIG_RESPONSE_BYTES || '0', 10);
      if (big > 0) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('x'.repeat(big));
      }
      const entry = outspendEntry(txid, vout);
      if (entry === null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(entry));
    };
    if (outspendDelayMs > 0) return setTimeout(answer, outspendDelayMs);
    return answer();
  }
  const lookup = p.match(/^\/api\/tx\/([0-9a-fA-F]+)$/);
  if (req.method === 'GET' && lookup) {
    const txid = lookup[1].toLowerCase();
    const delay = parseInt(process.env.STUB_TX_LOOKUP_DELAY_MS || '0', 10);
    const answer = () => {
      // Parent lookups for the fee, values in satoshis as the real API
      // returns them: FINNEY vout 0 = 200,000, vout 1 = 150,000; SECOND
      // vout 0 = 200,000.
      if (txid === FINNEY || txid === SECOND) {
        const values = txid === FINNEY ? [200000, 150000] : [200000];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          txid,
          version: 1,
          locktime: 0,
          vin: [],
          vout: values.map((value) => ({ scriptpubkey: '76a914' + '00'.repeat(20) + '88ac', scriptpubkey_address: '', value })),
          size: 200,
          weight: 800,
          fee: 0,
          status: { confirmed: true, block_height: 899000, block_time: 1762800000 },
        }));
      }
      if (!seen.has(txid)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // The unconfirmed hook (0.7.16): this txid sits in the
      // mempool, unconfirmed — 0 confirmations, no block height.
      if (UNCONFIRMED_TXID && txid === UNCONFIRMED_TXID) {
        return res.end(JSON.stringify({ txid, status: { confirmed: false } }));
      }
      return res.end(JSON.stringify({ txid, status: { confirmed: true, block_height: CONFIRMED_HEIGHT, block_time: 1762800000 } }));
    };
    if (delay > 0) return setTimeout(answer, delay);
    return answer();
  }
  if (req.method === 'POST' && p === '/api/tx') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const delay = parseInt(process.env.STUB_BROADCAST_DELAY_MS || '0', 10);
      const answer = () => {
        // The node-capability probe posts body '00' (an invalid
        // hex, not a transaction) — it is answered like any other
        // submission below, but it is not a broadcast attempt and
        // must not move the counter.
        if (body.trim() !== '00') broadcastAttempts++;
        if (broadcastFail) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('broadcast rejected (test hook)');
        }
        if (process.env.STUB_BAD_TXID) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('not-a-txid');
        }
        let id = '';
        try { id = txidOf(body.trim()); } catch { id = ''; }
        if (id && REJECT_ONCE_TXID && id.toLowerCase() === REJECT_ONCE_TXID && !rejectedOnce.has(id.toLowerCase())) {
          rejectedOnce.add(id.toLowerCase());
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('non-final');
        }
        if (id && id.toLowerCase() === SENTINEL_TXID.toLowerCase()) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('Transaction already in mempool');
        }
        if (id) seen.add(id.toLowerCase());
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(id);
      };
      if (delay > 0) return setTimeout(answer, delay);
      return answer();
    });
    return;
  }
  // MARA Slipstream: POST /api/transactions queues the txid (not publicly
  // visible) or rejects with STUB_SLIPSTREAM_REJECT; GET
  // /api/transactions/status?tx_id= reports queued txs and 404s the rest.
  if (req.method === 'POST' && p === '/api/transactions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (SLIPSTREAM_REJECT) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: SLIPSTREAM_REJECT }));
      }
      let hex = '';
      try { hex = JSON.parse(body).tx_hex || ''; } catch { hex = ''; }
      let id = '';
      try { id = txidOf(hex.trim()); } catch { id = ''; }
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'invalid transaction hex' }));
      }
      slipstreamQueued.add(id.toLowerCase());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'success', message: id }));
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/transactions/status') {
    const txid = (u.searchParams.get('tx_id') || '').toLowerCase();
    if (!txid || !slipstreamQueued.has(txid)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(slipstreamStatusBody(txid));
  }
  if (req.method === 'POST' && (p === '/__test__/slipstream/visible' || p === '/__test__/slipstream/drop')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let txid = '';
      try { txid = (JSON.parse(body).txid || '').toLowerCase(); } catch { txid = ''; }
      if (!txid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'txid required' }));
      }
      if (p.endsWith('/visible')) seen.add(txid);
      else slipstreamQueued.delete(txid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = parseInt(process.argv[2] || '18081', 10);
server.listen(port, '127.0.0.1', () => console.log('stub on :' + port));
