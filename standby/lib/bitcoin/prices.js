'use strict';

// BTC price sources (built-in providers or a custom URL and JSON path),
// read in pairs and combined.

const { PRICE_API_URL_OVERRIDE } = require('../config');
const { requestText, NET_TIMEOUT_MS } = require('../net');

// BTC price providers: id, label, base URL, path and parser, all no-auth
// GETs. The price comes from two configured sources and is trusted only
// when they agree (combinePriceReadings). Binance US quotes USDT
// (api.binance.com blocks the US). PRICE_API_URL points every built-in
// provider at a test stub.
const PRICE_PROVIDERS = [
  { id: 'coingecko', label: 'CoinGecko', baseUrl: 'https://api.coingecko.com',
    path: '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    parse: (d) => d && d.bitcoin && d.bitcoin.usd },
  { id: 'coinbase', label: 'Coinbase', baseUrl: 'https://api.coinbase.com',
    path: '/v2/prices/BTC-USD/spot',
    parse: (d) => d && d.data && d.data.amount },
  { id: 'binance', label: 'Binance US (USDT)', baseUrl: 'https://api.binance.us',
    path: '/api/v3/ticker/price?symbol=BTCUSDT',
    parse: (d) => d && d.price },
  { id: 'kraken', label: 'Kraken', baseUrl: 'https://api.kraken.com',
    path: '/0/public/Ticker?pair=XBTUSD',
    parse: (d) => { const r = d && d.result && d.result.XXBTZUSD; return r && r.c && r.c[0]; } },
  { id: 'bitstamp', label: 'Bitstamp', baseUrl: 'https://www.bitstamp.net',
    path: '/api/v2/ticker/btcusd/',
    parse: (d) => d && d.last },
];

function priceProviderById(id) {
  return PRICE_PROVIDERS.find((p) => p.id === id) || null;
}

function priceProviderLabel(id) {
  if (id === 'custom') return 'Custom';
  const p = priceProviderById(id);
  return p ? p.label : String(id);
}

// A custom price source is { id: 'custom', url, path }: the full URL and a
// dot-path to the price in the JSON answer (e.g. data.amount,
// result.XXBTZUSD.c[0]). parseJsonPath and priceFromPath are pure, so the
// UI, the validator and the fetch read a path the same way.
function parseJsonPath(path) {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const steps = [];
  for (const seg of trimmed.split('.')) {
    if (!seg) return null;
    const m = /^([A-Za-z0-9_$]+)?(?:\[(\d+)\])?$/.exec(seg);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    steps.push({ key: m[1] === undefined ? null : m[1], index: m[2] === undefined ? null : parseInt(m[2], 10) });
  }
  return steps.length ? steps : null;
}

function priceFromPath(data, path) {
  const steps = parseJsonPath(path);
  if (!steps) return undefined;
  let cur = data;
  for (const st of steps) {
    if (cur === null || cur === undefined) return undefined;
    if (st.key !== null) {
      if (typeof cur !== 'object') return undefined;
      cur = cur[st.key];
    }
    if (st.index !== null) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[st.index];
    }
  }
  return cur;
}

// The provider-like object for a custom source: base and path from the
// URL, the JSON-path walker as parser. Throws on a bad URL (the source
// then counts as not configured).
function customPriceProvider(url, jsonPath) {
  const u = new URL(String(url).trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('custom price URL must be http(s): ' + url);
  return {
    id: 'custom', label: 'Custom',
    baseUrl: u.protocol + '//' + u.host,
    path: (u.pathname || '/') + (u.search || ''),
    parse: (d) => priceFromPath(d, jsonPath),
  };
}

// Normalize a stored price-source value: a known provider id, or a custom
// { id, url, path } with an http(s) URL and a valid path; anything else is
// null. Settings, restore and readers all use this rule.
function normalizePriceSourceValue(v) {
  if (typeof v === 'string') return priceProviderById(v) ? v : null;
  if (v && typeof v === 'object' && v.id === 'custom') {
    const url = typeof v.url === 'string' ? v.url.trim() : '';
    const path = typeof v.path === 'string' ? v.path.trim() : '';
    if (!url || !path || !parseJsonPath(path)) return null;
    try { customPriceProvider(url, path); } catch { return null; }
    return { id: 'custom', url, path };
  }
  return null;
}

// The stable cache/comparison key for one stored source value:
// the provider id, or the custom URL + JSON path. Two sources
// are "the same" when their keys match.
function priceSourceKey(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.id === 'custom') return 'custom:' + (v.url || '') + '\n' + (v.path || '');
  return String(v);
}

// The provider-like object for a stored source (custom or registry), or
// null when unusable.
function resolvePriceSource(v) {
  const norm = normalizePriceSourceValue(v);
  if (norm === null) return null;
  if (typeof norm === 'string') return priceProviderById(norm);
  return customPriceProvider(norm.url, norm.path);
}

// User-Agent for price fetches (CoinGecko rejects requests without a
// descriptive one), from package.json with a bare fallback.
let PRICE_USER_AGENT = 'Standby';
try { PRICE_USER_AGENT = 'Standby/' + require('../../package.json').version; } catch { /* keep the bare name */ }

const DEFAULT_PRICE_API_URL = 'https://api.coingecko.com';

function priceApiBase() {
  // Legacy single override: the CoinGecko base. Kept so
  // the built-in providers and the existing tests keep working.
  const v = PRICE_API_URL_OVERRIDE;
  if (!v) return DEFAULT_PRICE_API_URL;
  let u;
  try { u = new URL(v); } catch { throw new Error('invalid price URL: ' + v); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('price URL must be http(s): ' + v);
  return u.protocol + '//' + u.host;
}

// PRICE_API_URL (test mode only) redirects every built-in provider; a
// custom source keeps its own URL.
function priceProviderBase(provider) {
  if (PRICE_API_URL_OVERRIDE && provider.id !== 'custom') return priceApiBase();
  return provider.baseUrl;
}

// One provider's BTC price in USD. Throws on anything unusable (non-200,
// bad body, non-positive, or outside $1–$100M); the caller treats that as
// no answer.
async function fetchPriceFromProvider(provider) {
  const base = priceProviderBase(provider);
  const u = new URL(base);
  const r = await requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path: provider.path,
    method: 'GET',
    headers: { 'User-Agent': PRICE_USER_AGENT },
    timeoutMs: NET_TIMEOUT_MS,
  });
  if (r.status !== 200) throw new Error(provider.label + ' answered ' + r.status);
  let data;
  try { data = JSON.parse(r.body); } catch { throw new Error(provider.label + ' body is not JSON'); }
  let raw;
  try { raw = provider.parse(data); } catch { throw new Error(provider.label + ' has no usable BTC price'); }
  const price = (typeof raw === 'number') ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(price) || price <= 0) throw new Error(provider.label + ' has no usable BTC price');
  return price;
}

// Fetch both sources in parallel (one failing does not block the other).
// Readings are keyed by slot, since two custom sources share the id
// 'custom'. An unusable source is a failed reading, not a throw.
async function fetchPriceReadings(source1, source2) {
  const jobs = [source1, source2].map(async (src) => {
    const prov = resolvePriceSource(src);
    if (!prov) {
      const id = (typeof src === 'string') ? src : 'custom';
      return { provider: id, label: (typeof src === 'string') ? src : 'Custom', price: null, error: 'unknown price provider: ' + id };
    }
    try {
      const price = await fetchPriceFromProvider(prov);
      return { provider: prov.id, label: prov.label, price, error: null };
    } catch (e) {
      return { provider: prov.id, label: prov.label, price: null, error: e.message };
    }
  });
  const [r1, r2] = await Promise.all(jobs);
  return { source1: r1, source2: r2 };
}

// Two readings agree when |p1 - p2| / min(p1, p2) <= agreementPct / 100.
// The result is the primary source's price:
// - both valid and agree: mode 'dual'
// - one valid: mode 'single', no agreement check
// - both valid but disagree: invalid, mode 'disagree'
// - neither: invalid, mode 'none'
// Pure, so the evaluator, the UI and the already-true check share one
// rule.
function combinePriceReadings(readings, agreementPct) {
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct / 100 : 0.05;
  const valid = [];
  for (const slot of ['source1', 'source2']) {
    const r = (readings || {})[slot];
    if (r && typeof r.price === 'number' && Number.isFinite(r.price)) {
      valid.push({ slot, label: r.label || r.provider || slot, price: r.price });
    }
  }
  if (valid.length === 0) {
    // No usable price: the feed is down or returned garbage, not a market
    // move. No range check: an agreed reading is trusted whatever its
    // size.
    return { valid: false, price: null, mode: 'none', note: '', reason: 'price unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherSlot = only.slot === 'source1' ? 'source2' : 'source1';
    const other = (readings || {})[otherSlot];
    const otherLabel = (other && (other.label || other.provider)) || 'the other source';
    const otherErr = (other && other.error) || '';
    // Say whether the other source was unreachable or returned garbage, so
    // an outage can be told from a bad feed.
    const otherWhy = /no usable BTC price/.test(otherErr) ? 'returned invalid data' : 'unreachable';
    return { valid: true, price: only.price, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const lo = Math.min(a.price, b.price), hi = Math.max(a.price, b.price);
  const diff = (hi - lo) / lo;
  if (diff > agree) {
    const pct = (diff * 100).toFixed(1);
    return { valid: false, price: null, mode: 'disagree', note: '',
      reason: 'price sources disagree — ' + a.label + ' $' + a.price.toLocaleString('en-US') + ' vs ' + b.label + ' $' + b.price.toLocaleString('en-US') + ' (' + pct + '% apart)',
      readings };
  }
  // Both agree: the PRIMARY slot's price decides (source1 is the
  // primary by construction — the slot order is the priority).
  const primary = valid.find((v) => v.slot === 'source1') || valid[0];
  const price = primary.price;
  return { valid: true, price, mode: 'dual',
    note: a.label + ' $' + a.price.toLocaleString('en-US') + ' · ' + b.label + ' $' + b.price.toLocaleString('en-US'),
    reason: '', readings };
}

// The display price for /api/state: the primary's when the sources agree,
// the single valid one, or null.
function priceConsensus(readings, agreementPct) {
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct / 100 : 0.05;
  const valid = [];
  for (const slot of ['source1', 'source2']) {
    const r = (readings || {})[slot];
    if (r && typeof r.price === 'number' && Number.isFinite(r.price)) valid.push({ slot, price: r.price });
  }
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].price;
  const lo = Math.min(valid[0].price, valid[1].price), hi = Math.max(valid[0].price, valid[1].price);
  if ((hi - lo) / lo > agree) return null;
  const primary = valid.find((v) => v.slot === 'source1') || valid[0];
  return primary.price;
}

module.exports = { PRICE_PROVIDERS, priceProviderById, priceProviderLabel, parseJsonPath, priceFromPath, customPriceProvider, normalizePriceSourceValue, priceSourceKey, resolvePriceSource, PRICE_USER_AGENT, DEFAULT_PRICE_API_URL, priceApiBase, fetchPriceFromProvider, fetchPriceReadings, combinePriceReadings, priceConsensus };
