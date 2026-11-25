'use strict';
// Standby — price / fee / tip fetchers + caches.
const store = require('./store');
const bitcoin = require('./bitcoin');
const { caches } = require('./caches');
const { DATA_DIR } = require('./config');
const { CHECK_CADENCE_SECONDS_DEFAULT, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, PRICE_AGREEMENT_PCT_DEFAULT, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN } = require('./util');


// The configured price sources: provider ids or custom { id: 'custom',
// url, path }. Unusable or identical sources fall back to the defaults
// (settings reject them, but hand-edited or restored state must not break
// the fetch).
function priceSourcesOf(settings) {
  const s = (settings && settings.priceSources && typeof settings.priceSources === 'object') ? settings.priceSources : {};
  const s1 = bitcoin.normalizePriceSourceValue(s.source1);
  const s2 = bitcoin.normalizePriceSourceValue(s.source2);
  const v1 = (s1 === null) ? 'coingecko' : s1;
  const v2 = (s2 === null) ? 'coinbase' : s2;
  if (bitcoin.priceSourceKey(v1) === bitcoin.priceSourceKey(v2)) return { source1: 'coingecko', source2: 'coinbase' };
  return { source1: v1, source2: v2 };
}

// The 400 message for a rejected price source.
function priceSourceError(v) {
  if (v && typeof v === 'object') return 'custom price source needs a valid http(s) URL and a JSON path to the price (e.g. data.amount)';
  return 'unknown price provider: ' + v;
}

// User controls, read defensively: settings reject bad values, but hand-
// edited or restored state falls back to the defaults instead of breaking
// an evaluation.
function priceAgreementPctOf(settings) {
  const v = settings && settings.priceAgreementPct;
  return (typeof v === 'number' && Number.isFinite(v) && v >= PRICE_AGREEMENT_PCT_MIN && v <= PRICE_AGREEMENT_PCT_MAX) ? v : PRICE_AGREEMENT_PCT_DEFAULT;
}
function checkCadenceSecondsOf(settings) {
  const v = settings && settings.checkCadenceSeconds;
  return (typeof v === 'number' && Number.isFinite(v) && v >= CHECK_CADENCE_SECONDS_MIN && v <= CHECK_CADENCE_SECONDS_MAX) ? v : CHECK_CADENCE_SECONDS_DEFAULT;
}

// The price cache: both readings plus the sources they were fetched for
// (TTL = check cadence), so a settings change refetches.

// Current price readings per source: from the cache while fresh (TTL =
// check cadence), else both sources fetched in parallel. The caller
// combines them. A reading is cached even if the rule ends up unknown;
// lastPrice is kept separately.
async function fetchPriceCached(sources, cadenceSeconds) {
  const src = (sources && sources.source1 && sources.source2) ? sources : { source1: 'coingecko', source2: 'coinbase' };
  const ttlMs = ((typeof cadenceSeconds === 'number' && Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) ? cadenceSeconds : CHECK_CADENCE_SECONDS_DEFAULT) * 1000;
  const nowMs = Date.now();
  const k1 = bitcoin.priceSourceKey(src.source1), k2 = bitcoin.priceSourceKey(src.source2);
  if (caches.price.fetchedAt && caches.price.source1Key === k1 && caches.price.source2Key === k2
      && caches.price.readings && Object.keys(caches.price.readings).length
      && (nowMs - new Date(caches.price.fetchedAt).getTime()) < ttlMs) {
    return caches.price.readings;
  }
  const readings = await bitcoin.fetchPriceReadings(src.source1, src.source2);
  caches.price = { readings, fetchedAt: new Date(nowMs).toISOString(), source1: src.source1, source2: src.source2, source1Key: k1, source2Key: k2 };
  return readings;
}

// Fee-market cache: the economy fee from both nodes with a fixed 5-minute
// TTL (not the cadence: the market fee moves slowly, so one fetch per 5
// minutes serves every fee rule, possibly 5 minutes late). Separate from
// the hourly currentFees used by the verdict. Keyed by endpoint URLs, so a
// settings change refetches. Failures are carried per node, never thrown.

const NODE_FEE_CACHE_TTL_MS = 5 * 60 * 1000; // one fee fetch per 5 minutes, shared across all fee rules

async function fetchNodeFeesCached(endpoints) {
  const eps = (endpoints && endpoints.length) ? endpoints : bitcoin.endpointsFor({ primaryApiUrl: 'https://mempool.space', secondaryApiUrl: 'https://blockstream.info/api' });
  const primary = eps[0] ? eps[0].base : null;
  const secondary = eps[1] ? eps[1].base : null;
  const ttlMs = NODE_FEE_CACHE_TTL_MS;
  const nowMs = Date.now();
  if (caches.nodeFee.fetchedAt && caches.nodeFee.primary === primary && caches.nodeFee.secondary === secondary
      && caches.nodeFee.readings && Object.keys(caches.nodeFee.readings).length
      && (nowMs - new Date(caches.nodeFee.fetchedAt).getTime()) < ttlMs) {
    return caches.nodeFee.readings;
  }
  const readings = await bitcoin.fetchNodeFeeReadings(eps);
  caches.nodeFee = { readings, fetchedAt: new Date(nowMs).toISOString(), primary, secondary };
  return readings;
}

// Tip heights cached for one tick (TTL = cadence, keyed by endpoint), so
// any number of block-height rules cost one fetch. A cached read does not
// re-stamp the checked times.

async function fetchTipHeightsCached(endpoints, cadenceSeconds) {
  const eps = (endpoints && endpoints.length) ? endpoints : bitcoin.endpointsFor({ primaryApiUrl: 'https://mempool.space', secondaryApiUrl: 'https://blockstream.info/api' });
  const primary = eps[0] ? eps[0].base : null;
  const secondary = eps[1] ? eps[1].base : null;
  const ttlMs = ((typeof cadenceSeconds === 'number' && Number.isFinite(cadenceSeconds) && cadenceSeconds > 0) ? cadenceSeconds : CHECK_CADENCE_SECONDS_DEFAULT) * 1000;
  const nowMs = Date.now();
  if (caches.nodeTip.fetchedAt && caches.nodeTip.primary === primary && caches.nodeTip.secondary === secondary
      && caches.nodeTip.readings && Object.keys(caches.nodeTip.readings).length
      && (nowMs - new Date(caches.nodeTip.fetchedAt).getTime()) < ttlMs) {
    return caches.nodeTip.readings;
  }
  const readings = await bitcoin.fetchTipHeights(eps);
  caches.nodeTip = { readings, fetchedAt: new Date(nowMs).toISOString(), primary, secondary };
  return readings;
}

// Cached prices as served: per-source readings, the consensus display
// price (same agreement rule as the trigger) and fetchedAt.
function priceCacheForState(agreementPct) {
  return {
    price: bitcoin.priceConsensus(caches.price.readings || {}, agreementPct),
    prices: caches.price.readings || {},
    fetchedAt: caches.price.fetchedAt,
    source1: caches.price.source1, source2: caches.price.source2,
  };
}

// Exchange status for the readiness card: OK (both answer and agree),
// degraded (one down), error (they disagree, or neither answers), not-
// tested (no readings for these sources yet). Plus one row per source with
// its own status and price.
function exchangeStatusFor(pc, sources, agreementPct) {
  const ok = pc && pc.prices && Object.keys(pc.prices).length
    && bitcoin.priceSourceKey(pc.source1) === bitcoin.priceSourceKey(sources.source1)
    && bitcoin.priceSourceKey(pc.source2) === bitcoin.priceSourceKey(sources.source2);
  // One row per configured source: 'ok' with a price, 'error' otherwise,
  // 'not-tested' while the cache is cold or for other sources. A custom
  // source shows as 'Custom', never its URL.
  const rows = ['source1', 'source2'].map((slot) => {
    const src = sources[slot];
    const isCustom = src && typeof src === 'object' && src.id === 'custom';
    const label = isCustom ? 'Custom' : (bitcoin.priceProviderById(src) ? bitcoin.priceProviderById(src).label : String(src));
    const provider = isCustom ? 'custom' : String(src);
    if (!ok) return { provider, label, price: null, error: null, status: 'not-tested' };
    const r = pc.prices[slot] || null;
    if (!r) return { provider, label, price: null, error: 'No reading', status: 'error' };
    const price = typeof r.price === 'number' ? r.price : null;
    const error = r.error ? String(r.error) : null;
    return { provider, label, price, error, status: price != null ? 'ok' : 'error' };
  });
  if (!ok) return { status: 'not-tested', detail: 'No price readings yet', sources: rows };
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct : PRICE_AGREEMENT_PCT_DEFAULT;
  const comb = bitcoin.combinePriceReadings(pc.prices, agree);
  if (comb.mode === 'dual') return { status: 'ok', detail: 'Both price sources agree', sources: rows };
  if (comb.mode === 'single') return { status: 'degraded', detail: 'One price source down — running on a single source', sources: rows };
  if (comb.mode === 'disagree') return { status: 'error', detail: 'Price sources disagree by more than ' + agree + '%', sources: rows };
  return { status: 'error', detail: 'No price source responding', sources: rows };
}

// Refresh a stale price cache when any tx has a price rule (armed or not:
// disarmed txs are evaluated and their pill reads it too). Best-effort;
// never throws.
async function refreshPriceIfStale() {
  try {
    const st = store.loadState(DATA_DIR);
    const hasPrice = (st.bitcoin.txs || []).some((t) => store.hasTriggerType(t, 'price'));
    if (!hasPrice) return;
    await fetchPriceCached(priceSourcesOf(st.settings), checkCadenceSecondsOf(st.settings));
  } catch (e) { console.error('price refresh failed:', e); }
}

module.exports = { priceSourcesOf, priceSourceError, priceAgreementPctOf, checkCadenceSecondsOf, fetchPriceCached, NODE_FEE_CACHE_TTL_MS, fetchNodeFeesCached, fetchTipHeightsCached, priceCacheForState, exchangeStatusFor, refreshPriceIfStale };
