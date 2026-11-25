'use strict';
// Mempool API stub: tip, outspends, tx lookup and broadcast, fees, prices
// and Slipstream.
// node stubs.js <port> (env SENTINEL_TXID)
// FINNEY: vout 0 spent, vout 1 unspent. SECOND ('aa'*32): one unspent
// output. Other parents 404. Tip 900000; a broadcast txid (and the
// sentinel) reads confirmed at 899995; re-broadcasting the sentinel
// answers "already in mempool".
const http = require('http');
const crypto = require('crypto');
const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const SECOND = 'aa'.repeat(32);
// Tip height, settable per stub via POST /__test__/tip { height } (default
// 900000).
let tipHeight = 900000;
const TIP = 900000;
const CONFIRMED_HEIGHT = 899995;
const SENTINEL_TXID = process.env.SENTINEL_TXID || '';
// Env hooks:
// - STUB_OUTSPEND_DELAY_MS, STUB_TX_LOOKUP_DELAY_MS,
//   STUB_BROADCAST_DELAY_MS: delay those answers
// - STUB_BIG_RESPONSE_BYTES: an oversized outspend body
// - STUB_BAD_TXID: broadcast answers 200 'not-a-txid'
// - STUB_CONFLICT_MODE: 'cc'*32 spent by 'dd'*32, 'unconfirmed' (default),
//   'confirmed' (899990) or 'unspent'
// - STUB_OWN_SPEND_TXID: 'ee'*32 spent (unconfirmed) by that txid; unset,
//   unspent
const CONFLICT = 'cc'.repeat(32);
const CONFLICT_SPENDER = 'dd'.repeat(32);
const OWN_SPEND = 'ee'.repeat(32);
const OWN_SPEND_TXID = (process.env.STUB_OWN_SPEND_TXID || '').toLowerCase();
// STUB_REJECT_ONCE_TXID rejects that txid's first broadcast with 400 'non-
// final', then accepts it.
const REJECT_ONCE_TXID = (process.env.STUB_REJECT_ONCE_TXID || '').toLowerCase();
const rejectedOnce = new Set();
let broadcastFail = false;
let broadcastAttempts = 0;
// tipFail makes the tip read 500; tipRequests counts tip requests.
let tipFail = false;
let tipRequests = 0;
// Price feeds, one per provider in its real response shape. STUB_PRICE_USD
// sets the start (default 98200). POST /__test__/price: { usd }, { fail },
// { bad: 'zero'|'huge'|'empty'|null }, all providers or one via { provider
// }.
const PRICE_PROVIDERS = ['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp'];
const priceState = {};
// Fee mode: 'mempool' (default) or 'esplora', which 404s
// /api/v1/fees/recommended so the app falls back to /api/fee-estimates.
let feeMode = 'mempool';
// Counts /api/v1/fees/recommended requests (GET /__test__/fee-count).
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
// Which outspend routes exist: 'both' (default), 'batch', 'singular' or
// 'neither'. A missing route 404s.
let outspendMode = 'both';
// 'full' (spender and status, like Esplora) or 'bitcoind' (bare {spent} in
// the batch, no singular route). POST /__test__/prevouts-route { enabled }
// toggles /api/prevouts.
let outspendStyle = 'full';
let prevoutsRoute = true;
// The User-Agent each price feed was last fetched with (GET
// /__test__/price-ua).
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
// STUB_UNCONFIRMED_TXID: that txid looks in the mempool with 0
// confirmations instead of confirmed.
const UNCONFIRMED_TXID = (process.env.STUB_UNCONFIRMED_TXID || '').toLowerCase();
const seen = new Set();
if (SENTINEL_TXID) seen.add(SENTINEL_TXID.toLowerCase());

// Slipstream: STUB_SLIPSTREAM_REJECT=<reason> rejects every submission.
// Submitted txids queue (position 12) and are not publicly visible;
// /__test__/slipstream/visible and /drop control that.
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
// a confirmed spend at that height; { clear: true } removes it.
const outspendOverride = {};

// Parents this stub 404s (POST /__test__/unknown-parent), so a test can
// make only one node unaware of a parent.
const unknownParents = new Set();

// POST /__test__/date-offset { seconds }: answer with a Date header that
// far from the real time, so the app sees its own clock as off.
let dateOffsetMs = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (dateOffsetMs) res.setHeader('Date', new Date(Date.now() + dateOffsetMs).toUTCString());
  if (req.method === 'POST' && p === '/__test__/date-offset') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { dateOffsetMs = (Number(JSON.parse(body || '{}').seconds) || 0) * 1000; } catch { dateOffsetMs = 0; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, offsetSeconds: dateOffsetMs / 1000 }));
    });
    return;
  }
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
  // Esplora-style fee estimates (target -> rate), the fallback when
  // /api/v1/fees/recommended 404s. The 144-block rate tracks the economy
  // fee.
  if (req.method === 'GET' && p === '/api/fee-estimates') {
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(feeEstimatesMap || { '1': feeState.economyFee + 1, '2': feeState.economyFee + 1, '3': feeState.economyFee, '6': feeState.economyFee, '144': feeState.economyFee, '1008': 1 }));
    };
    if (feeDelayMs > 0) return setTimeout(answer, feeDelayMs);
    return answer();
  }
  // POST /__test__/fees { economyFee } sets the economy fee (and the
  // 6-block estimate).
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
  // POST /__test__/fee-mode { mode }.
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
  // POST /__test__/broadcast-fail { fail }; GET /__test__/broadcast-count
  // (the '00' probe is not counted).
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
  // POST /__test__/tip-fail { fail }; GET /__test__/tip-count.
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
  // GET /__test__/fee-count.
  if (req.method === 'GET' && p === '/__test__/fee-count') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: feeRequests }));
  }
  // GET /__test__/outspend-count (singular) and /__test__/outspends-count
  // (batch).
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
  // POST /__test__/outspend-mode { mode }.
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
  // BTC price: one route per provider, in its real shape. state.fail
  // answers 500; state.bad a malformed reading. The query string is
  // ignored.
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
  // POST /__test__/outspend { txid, vout, blockHeight } overrides that
  // spend's height; { clear: true } or blockHeight null removes it.
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
  // POST /__test__/unknown-parent { txid } 404s that parent's outspends; {
  // clear: true } removes it.
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
  // One outpoint's answer, or null to 404. Shared by the singular and
  // batch routes.
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
  // Batch outspends (Esplora): one entry per output, in vout order. FINNEY
  // has 2 outputs; other known parents 1.
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
  // POST /api/prevouts: [{txid, vout}] -> one answer per outpoint from the
  // confirmed UTXO set (like gettxout(txid, vout, false)): unspent or
  // mempool-spent gives its value; confirmed-spent or unknown gives null.
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
      // Parent values in satoshis: FINNEY vout 0 = 200,000, vout 1 =
      // 150,000; SECOND vout 0 = 200,000.
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
        // The node-capability probe ('00') is answered but not counted.
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
  // Slipstream: POST /api/transactions queues the txid or rejects; GET
  // /api/transactions/status?tx_id= reports queued txs, 404 otherwise.
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
