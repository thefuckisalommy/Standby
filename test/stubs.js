'use strict';
// Mempool API stub for Standby local verification. Serves the endpoints
// the app uses: tip height, outspend, tx lookup, tx broadcast.
//   node stubs.js <port>   (env SENTINEL_TXID)
// Finney txid: f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
//   vout 0 = spent, vout 1 = unspent (the app's dry-run / freshness gate).
// A second known-unspent input (SECOND, all 0xaa) exists so a demo can
// hold two transactions with DISTINCT inputs — two crafted Finney
// spends share an input and the app (correctly) warns about it, which
// is noise in a store screenshot. Every other prevTxid still 404s.
// Tip height is fixed at 900000; a broadcast (POSTed) txid — and the
// sentinel — looks up as confirmed at block 899995 (6 confirmations).
// POST /api/tx with the sentinel hex answers "already in mempool".
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
// Test hook (0.7.6): STUB_OUTSPEND_DELAY_MS holds the outspend answer
// for that many ms, so a test can land a check-in while a release
// evaluation is waiting on the network and prove the pre-broadcast
// re-verification stops the broadcast.
// Test hook (0.7.8): STUB_TX_LOOKUP_DELAY_MS holds the tx-lookup
// answer (the confirmations path) for that many ms, so a test can
// land an edit while a confirmation refresh is on the network and
// prove the edit is not clobbered by the refresh's save.
// Test hook (0.7.10): STUB_BROADCAST_DELAY_MS holds the broadcast
// (POST /api/tx) answer for that many ms, so a test can land a
// check-in, a disable, or a delete while a broadcast is on the
// network and prove the broadcast record merges into fresh state
// instead of overwriting it.
// Test hook (0.7.11): STUB_BIG_RESPONSE_BYTES makes the outspend
// answer a body of that many bytes, so a test can prove the app
// rejects an oversized node reply instead of growing the process.
// Test hook (0.7.11): STUB_BAD_TXID makes POST /api/tx answer 200
// with 'not-a-txid', so a test can prove a garbage broadcast reply
// is treated as a failed broadcast, not recorded as broadcasted.
// Test hook (0.7.12): STUB_CONFLICT_MODE makes prevTxid 'cc'*32
// answer as spent by another transaction — 'unconfirmed' (the
// default, also when the variable is unset) reports the spend as
// status {confirmed: false}; 'confirmed' reports {confirmed: true,
// block_height: 899990}; 'unspent' reports {spent: false}. The
// spending txid is always 'dd'*32. STUB_OWN_SPEND_TXID=<txid> makes
// prevTxid 'ee'*32 answer as spent by exactly that txid
// (unconfirmed) — the app recognises its own transaction out there;
// when the variable is unset 'ee'*32 answers {spent: false}.
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
// Test hook (0.8.2, full-tick backoff): the broadcast-fail flag
// makes POST /api/tx reject EVERY broadcast with 400 while it is
// on, and broadcastAttempts counts every REAL broadcast submission
// — the node-capability test's probe (POST /api/tx with body '00',
// an invalid hex that never reaches the mempool) is NOT counted,
// or a startup's capability probe would look like a second
// broadcast attempt. A test can then prove a failed broadcast is
// not retried by the tick within the backoff hour, and that a manual
// broadcast bypasses it. Runtime-settable, per stub process:
//   POST /__test__/broadcast-fail { fail: true|false } — answers { fail }
//   GET  /__test__/broadcast-count — answers { count }
let broadcastFail = false;
let broadcastAttempts = 0;
// Test hook (0.8.5, tip fetch): the tip-fail flag makes GET
// /api/blocks/tip/height answer 500 while it is on, and
// tipRequests counts every tip-height request this stub has
// answered. Both are per stub process, runtime-settable via the
// /__test__/tip-fail and /__test__/tip-count endpoints below.
let tipFail = false;
let tipRequests = 0;
// Test hook (0.8.0, two-source 0.8.0): the BTC price feeds — one
// per provider in the app's registry (CoinGecko, Coinbase,
// Binance, Kraken, Bitstamp), each answering in the real
// provider's response shape. STUB_PRICE_USD sets the starting
// price for ALL providers (default 98200 — the measured live
// price when the trigger was built). The feeds are runtime-
// settable via POST /__test__/price:
//   { usd } — sets the price on ALL providers (backward compat:
//   the 095 suite's set_price helper posts a single price)
//   { fail: true } — makes ALL providers answer 500
//   { bad: 'zero'|'huge'|'empty'|null } — a malformed reading on
//   ALL providers
//   { provider: '<id>', usd / fail / bad } — the same controls,
//   but for ONE provider only (so a suite can drive the two
//   sources apart, or kill one and keep the other).
// A per-provider control never touches the other providers.
const PRICE_PROVIDERS = ['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp'];
const priceState = {};
// The economy fee this stub serves (0.8.1): settable via POST
// /__test__/fees { economyFee }, default 1 sat/vB.
// Test hook (0.8.9, accumulated peak): the fee mode this stub
// serves — 'mempool' (default) answers /api/v1/fees/recommended,
// 'esplora' 404s it, so the app falls back to /api/fee-estimates
// exactly like a plain Esplora node. Settable per stub via POST
// /__test__/fee-mode { mode }. Per stub process; restarting the
// stub clears it.
let feeMode = 'mempool';
// Test hook (0.8.5, fee fetch): feeRequests counts every
// /api/v1/fees/recommended request this stub has answered —
// the node fee fetch and the verdict's hourly current-fees
// fetch both hit this route from the configured node, so a suite
// reads the count as a delta across a controlled window.
// Runtime-readable via GET /__test__/fee-count below.
let feeRequests = 0;
const feeState = { economyFee: 1 };
// Test hooks (0.8.9 audit fixes): feeDelayMs delays every fee
// answer (recommended + estimates) by that many ms — mutable via
// POST /__test__/fee-delay, so a suite can hold a fee fetch in
// flight while an edit lands. feeEstimatesMap, when set, replaces
// the default /fee-estimates map — mutable via POST
// /__test__/fee-estimates-map {map|null}, so a suite can serve a
// sparse map and prove a missing 144 yields no reading.
let feeDelayMs = 0;
let feeEstimatesMap = null;
// Test hook (0.8.6, UTXO cache/batch): outspendRequests counts
// every singular /api/tx/:txid/outspend/:vout request this stub
// has answered, outspendsRequests every batch
// /api/tx/:txid/outspends request — so a suite can prove repeated
// outpoints cost one request (cache) and shared funding txs cost
// one batch request. Runtime-readable via GET
// /__test__/outspend-count and /__test__/outspends-count below.
let outspendRequests = 0;
let outspendsRequests = 0;
// Test hook (0.8.6 fold-in): outspendDelayMs delays every
// outspend answer (singular + batch) by that many ms — mutable
// via POST /__test__/outspend-delay, default from
// STUB_OUTSPEND_DELAY_MS; outspendFail makes both outspend
// routes answer 500 — mutable via POST /__test__/outspend-fail.
// Both exist so a suite can hold a request in flight, or make
// one fail, and prove the app dedupes / retries correctly.
let outspendDelayMs = parseInt(process.env.STUB_OUTSPEND_DELAY_MS || '0', 10) || 0;
let outspendFail = false;
// Test hook (0.8.10, generic outspend negotiation): outspendMode
// is which outspend shapes this stub serves — 'both' (default:
// batch + singular, like mempool.space and Esplora), 'batch'
// (batch only, like a self-hosted mempool backend v3, whose
// /api/v1/* has no singular route), 'singular' (singular only),
// or 'neither' (neither route exists). A missing route 404s,
// exactly like an unknown parent — the app cannot tell the two
// apart from the status alone, which is the point: the suite can
// prove the client negotiates the shape instead of assuming it.
// Mutable per stub via POST /__test__/outspend-mode {mode};
// restarting the stub resets it to 'both'.
let outspendMode = 'both';
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

// Test hook (0.7.16): STUB_SLIPSTREAM_REJECT=<reason> makes POST
// /api/transactions reject every submission with 400
// {"status":"error","message":"<reason>"} (a fee below the floor, a
// sanctions rejection) — so a test can prove a Slipstream failure
// surfaces the reason and keeps the tx 'release-due' for the hourly
// retry. Unset: submissions succeed.
// Slipstream state (0.7.16): slipstreamQueued holds the txids
// submitted to Slipstream and still in MARA's queue; the status
// endpoint reports them as queued (position 12, not next block) and
// 404s anything else (dropped / never submitted). The test-only
// /__test__/slipstream/* endpoints drive the transitions the app
// must handle: /visible marks a txid as publicly visible (MARA
// mined it — the public /api/tx lookup finds it), /drop removes it
// from the queue (MARA dropped it — the status endpoint 404s).
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

// Test hook (0.8.0, fast tick / catch-up): outspend block-height
// override — POST /__test__/outspend {txid, vout, blockHeight}
// makes the outspend for that outpoint answer as a confirmed spend
// at that block height, so a suite can drive a spend at an exact
// confirmation count (confs = TIP - blockHeight + 1; TIP is 900000,
// so blockHeight 899999 is 2 confirmations). POST {txid, vout,
// clear: true} (or blockHeight: null) removes it. Empty by default,
// so all existing behaviour is unchanged.
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
  // Current recommended fees (0.7.21): GET /api/v1/fees/recommended
  // returns a fixed object whose economyFee is 1 sat/vB — the
  // measured live floor — so an app pointed at a stub always sees
  // economyFee 1 and a fee below 1 sat/vB reads Critical Risk. The
  // economy fee is settable per stub via POST /__test__/fees
  // { economyFee } (0.8.1, two-node fee logic) — a suite can drive
  // the two nodes' fees apart, or make one implausible. In
  // 'esplora' fee mode (POST /__test__/fee-mode) this route 404s,
  // so the app falls back to /api/fee-estimates below.
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
  // Test control (0.8.9 audit fixes): POST /__test__/fee-delay
  // {ms} delays every fee answer by that many ms — {ms: 0}
  // clears it — so a suite can hold a fee fetch in flight while
  // an edit lands. POST /__test__/fee-estimates-map {map}
  // replaces the /fee-estimates map the stub serves (a sparse map
  // proves a missing 144 yields no reading); {map: null}
  // restores the default map.
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
  // Test hook (0.8.5, tip fetch): the tip-fail flag makes GET
  // /api/blocks/tip/height answer 500 while it is on (a node
  // failing the tip read, e.g. rate-limited), and tipRequests
  // counts every tip-height request this stub has answered — so a
  // suite can prove a primary-first fetch never asks the secondary
  // and a per-tick cache fetches once per tick no matter how many
  // blockheight rules there are. Runtime-settable, per stub process:
  //   POST /__test__/tip-fail { fail: true|false } — answers { fail }
  //   GET  /__test__/tip-count — answers { count }
  // Test control for the tip (0.8.1, block-height either-node):
  // POST /__test__/tip { height } sets this stub's tip height.
  // Answers the current tip.
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
  // Test control (0.8.6 fold-in): POST /__test__/outspend-delay
  // {ms} delays every outspend answer (singular + batch) by that
  // many ms — so a suite can hold a request in flight while a
  // second one starts, proving in-flight dedup; {ms: 0} clears
  // it. POST /__test__/outspend-fail {fail} makes both routes
  // answer 500 — so a suite can prove a failed request does not
  // poison later lookups.
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
  // Test control for the price feeds (0.8.0, two-source 0.8.0):
  // POST /__test__/price { usd } sets the price on ALL providers;
  // { fail: true/false } makes ALL answer 500 or not;
  // { bad: 'zero'|'huge'|'empty'|null } picks a malformed reading
  // on ALL or clears it. With { provider: '<id>' } the same
  // controls apply to ONE provider only. Answers the current
  // state (all providers, or just the one named).
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
  // One output's outspend answer (0.8.6): the JSON object for
  // this outpoint, or null when the stub must 404 (a parent tx it
  // has never seen, or one flagged unknown via
  // /__test__/unknown-parent). Shared by the singular route below
  // and the batch route above it, so both answer identically.
  // GENESIS is the genesis block's coinbase txid (0.8.10): the
  // node-test output-lookup probe asks for its only output
  // (vout 0), which is unspent in reality — the stub answers
  // {spent: false}, exactly as a real node does.
  const GENESIS = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
  function outspendEntry(txid, vout) {
    if (txid !== FINNEY && txid !== SECOND && txid !== CONFLICT && txid !== OWN_SPEND && txid !== GENESIS) return null;
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
      return res.end(JSON.stringify(entries));
    };
    if (outspendDelayMs > 0) return setTimeout(answer, outspendDelayMs);
    return answer();
  }
  const out = p.match(/^\/api\/tx\/([0-9a-fA-F]+)\/outspend\/(\d+)$/);
  if (req.method === 'GET' && out) {
    outspendRequests++;
    if (outspendFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'outspend down (stub)' })); }
    if (outspendMode === 'batch' || outspendMode === 'neither') { res.writeHead(404); return res.end(); }
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
      // Parent-tx lookup for the fee (0.7.18): the Finney and
      // SECOND parents answer with their output values, so the app
      // can compute a transaction's fee from the node. The values
      // are in SATOSHIS, as the real mempool /api/tx returns them
      // (the genesis coinbase pays 5000000000): Finney vout 0 =
      // 200,000 sats (spent), vout 1 = 150,000 sats (unspent);
      // SECOND vout 0 = 200,000 sats. A crafted tx spending Finney
      // vout 1 with 100,000 sats out pays a 50,000-sat fee. The
      // pre-fix stub spoke BTC decimals (0.002 / 0.0015) — the same
      // units error as the app's old btcToSats, which is why the
      // fee tests passed while the live fee was inflated 1e8x.
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
  // MARA Slipstream (0.7.16). POST /api/transactions submits a
  // signed tx: success is 200 {"status":"success","message":txid}
  // and the txid joins the queue (it is NOT publicly visible — the
  // public /api/tx lookup still 404s it, exactly like the real
  // Slipstream). With STUB_SLIPSTREAM_REJECT set, every submission
  // is 400 {"status":"error","message":reason}. GET
  // /api/transactions/status?tx_id= reports a queued tx as a
  // TransactionInfo (position 12, not next block) and 404s anything
  // else (dropped / never submitted). The /__test__/slipstream/*
  // endpoints let a test drive the transitions: /visible marks a
  // txid as publicly visible (MARA mined it), /drop removes it from
  // the queue (MARA dropped it).
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
