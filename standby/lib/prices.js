'use strict';
// Standby — price / fee / tip fetchers + caches (split from server.js, 0.8.7.3).
const store = require('./store');
const bitcoin = require('./bitcoin');
const { caches } = require('./caches');
const { DATA_DIR } = require('./config');
const { CHECK_CADENCE_SECONDS_DEFAULT, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, PRICE_AGREEMENT_PCT_DEFAULT, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN } = require('./util');

// ---------------------------------------------------------------------------
// Trigger evaluation (0.8.0, unified 0.8.2). One pure condition
// function per rule type — checkXRule(state, rule, now, ctx) —
// shared by BOTH paths: the evaluator (evaluateRule /
// evaluateTrigger, which writes the rule's triggerState slice and
// applies the evaluator-only holds) and the gate (checkTriggerNow,
// which answers the raw condition without writing anything and
// without grace / vacation / disarm — the gate blocks an add when
// satisfaction is definite, even while a hold would stop the
// release). A check function returns { fire, status, reason, slice,
// detail, warning }: `slice` is the triggerState slice to store for
// this rule (null = keep the stored slice — a held rule writes
// nothing); `detail` is the extra facts the gate answers with;
// `warning` is the already-satisfied warning (the gate's text —
// the evaluator ignores it). ctx is { prevSlice, liveOffsetMs }:
// the rule's stored slice (the price jump guard's baseline) and
// the tx's frozen time (check-in rules only).
// evaluateTrigger(state, tx, now) evaluates each rule
// and combines by the set's op (see combineOutcomes). triggerStatusFor
// (state, tx, now) is the UI-facing status, computed from the STORED
// triggerState (no network) — except the check-in trigger, whose
// state is live clock math so the card's "3 of 35 days elapsed" line
// is current on every page load.
// ---------------------------------------------------------------------------
const PRICE_JUMP_WINDOW_MS = 60 * 60 * 1000; // the 10x-jump guard (below) only applies when the last good reading is recent — over a longer gap a real 10x move is possible

// The configured price sources (Settings: priceSources
// {source1, source2}). Each slot is either a provider id string
// ('kraken', ...) or a custom object { id: 'custom', url, path }
// (0.8.1). An unusable value or two identical sources fall back
// to the defaults — the settings validator (PUT /api/settings)
// rejects those, but a hand-edited or restored state must never
// break the fetch.
function priceSourcesOf(settings) {
  const s = (settings && settings.priceSources && typeof settings.priceSources === 'object') ? settings.priceSources : {};
  const s1 = bitcoin.normalizePriceSourceValue(s.source1);
  const s2 = bitcoin.normalizePriceSourceValue(s.source2);
  const v1 = (s1 === null) ? 'coingecko' : s1;
  const v2 = (s2 === null) ? 'coinbase' : s2;
  if (bitcoin.priceSourceKey(v1) === bitcoin.priceSourceKey(v2)) return { source1: 'coingecko', source2: 'coinbase' };
  return { source1: v1, source2: v2 };
}

// The 400 message for a price-source value the validator
// rejects: an unknown provider id, or a custom object without a
// valid http(s) URL and a well-formed JSON path.
function priceSourceError(v) {
  if (v && typeof v === 'object') return 'custom price source needs a valid http(s) URL and a JSON path to the price (e.g. data.amount)';
  return 'unknown price provider: ' + v;
}

// The user controls (0.8.0), read defensively like
// priceSourcesOf above: the settings validator (PUT
// /api/settings, restore) rejects out-of-range values, but a
// hand-edited or restored state must never break an evaluation
// — an unusable value falls back to its default.
function priceAgreementPctOf(settings) {
  const v = settings && settings.priceAgreementPct;
  return (typeof v === 'number' && Number.isFinite(v) && v >= PRICE_AGREEMENT_PCT_MIN && v <= PRICE_AGREEMENT_PCT_MAX) ? v : PRICE_AGREEMENT_PCT_DEFAULT;
}
function checkCadenceSecondsOf(settings) {
  const v = settings && settings.checkCadenceSeconds;
  return (typeof v === 'number' && Number.isFinite(v) && v >= CHECK_CADENCE_SECONDS_MIN && v <= CHECK_CADENCE_SECONDS_MAX) ? v : CHECK_CADENCE_SECONDS_DEFAULT;
}

// The price cache holds BOTH readings (per source, TTL = the
// check cadence — Settings: Check cadence, default 60 seconds)
// plus which sources they were fetched for — a settings change
// makes the cache stale, so the next read fetches the new
// sources instead of serving the old ones. readings is
// { [sourceId]: { provider, price|null, error|null } }.

// The current BTC price readings (per source), from the cache
// when fresh, else a live fetch of both sources in parallel.
// Returns the readings map — the caller combines them (the
// configured agreement rule + the directional extreme) via
// bitcoin.combinePriceReadings. `cadenceSeconds` is the cache
// TTL (Settings: Check cadence): the cache is fresh for exactly
// one tick, so a faster cadence fetches fresher prices and a
// slower cadence does not refetch on every read. A fetched
// reading is cached even when the evaluator later judges it
// implausible (the evaluator keeps lastPrice separately — see
// checkPriceRule — so a bad reading never becomes the
// baseline for the next one).
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

// The fee cache for the fee-market trigger (0.8.1): the economy
// fee from BOTH configured nodes (per endpoint, TTL = a fixed
// 5 minutes — NODE_FEE_CACHE_TTL_MS below). The TTL is NOT the
// check cadence: the market fee moves slowly (a low-fee window
// lasts longer than 5 minutes), so one fetch per 5 minutes for
// ALL fee rules combined is the intended tradeoff — the trigger
// may fire up to 5 minutes late, and the fee pill shows a fee
// up to 5 minutes old, the same trust-the-warm-cache philosophy
// as the 0.8.4 fee-pill fix. This is separate from the hourly
// caches.currentFees (used by the fee verdict): the verdict only
// needs an hourly fee. The cache is keyed by the endpoint URLs
// — a settings change makes it stale, so the next read fetches
// the new nodes instead of serving the old ones. readings is
// { [label]: { endpoint, fee|null, source|null, error|null } }.
// A failed fetch does NOT throw — the readings carry the error
// per node, and the caller combines them (the primary node's
// fee decides, the secondary is only a fallback) via
// bitcoin.combineFeeReadings; no usable reading means 'unknown',
// never a fire.

const NODE_FEE_CACHE_TTL_MS = 5 * 60 * 1000; // (0.8.5) one fee fetch per 5 minutes, shared across all fee rules

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

// The tip heights as fetched from the nodes, cached for one tick
// (0.8.5) — the same pattern as caches.nodeFee: N blockheight rules
// in one tick cost ONE tip fetch, not N. The cache is keyed by
// endpoint bases (a settings change busts it) and its TTL is the
// check cadence. A cached read makes no HTTP request, so it does
// not re-stamp the per-endpoint checked times — the stamps record
// when each endpoint was actually asked.

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

// The cached prices as served to the UI (GET /api/state) — the
// per-source readings, the consensus price (a single display
// number: the primary exchange's price when the two agree, the
// single valid one, or null), and the fetched-at timestamp.
// `agreementPct` is the configured agreement (Settings: Price
// agreement), so the displayed consensus uses the same rule as
// the trigger.
function priceCacheForState(agreementPct) {
  return {
    price: bitcoin.priceConsensus(caches.price.readings || {}, agreementPct),
    prices: caches.price.readings || {},
    fetchedAt: caches.price.fetchedAt,
    source1: caches.price.source1, source2: caches.price.source2,
  };
}

// The consolidated exchange status for the readiness card
// (0.8.0): one status for the configured price sources, so the
// readiness card shows it once instead of repeating it per
// price tx. OK = both responding and agreeing within the
// configured agreement; degraded = one source down
// (single-source mode); error = they disagree by more than the
// configured agreement or neither responds; not-tested = no
// readings yet (cache cold, or for different sources). Returns
// {status, detail, sources} — the detail is generic (no
// per-source prices); `sources` is one row per configured
// source, in configured order, each with its own status and
// last price (or error), so the readiness card can list them
// like the node rows. `pc` is the priceCacheForState() shape.
function exchangeStatusFor(pc, sources, agreementPct) {
  const ok = pc && pc.prices && Object.keys(pc.prices).length
    && bitcoin.priceSourceKey(pc.source1) === bitcoin.priceSourceKey(sources.source1)
    && bitcoin.priceSourceKey(pc.source2) === bitcoin.priceSourceKey(sources.source2);
  // One row per configured price source (in configured order).
  // A row is 'ok' when it has a price, 'error' when it has an
  // error (or no reading at all), and 'not-tested' while the
  // cache is cold or for different sources. Readings are keyed
  // by slot (source1/source2), and a custom source's label is
  // 'Custom' — the URL itself is never shown on the readiness
  // card.
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

// Refresh the price cache when it is stale and any tx has a price
// rule (0.8.0; 0.8.4: armed or not — a disarmed price tx's pill
// reads the cache too, and the tick evaluates disarmed txs, so a
// price rule that is disarmed-only must still keep the cache warm).
// The 1-minute fast tick and the startup refresh call this, so a
// price rule's "currently $X" line stays fresh. Best-effort — a
// failed refresh never throws here; the cache just stays cold
// until the next tick, and the evaluator reports the trigger
// 'unknown' in the meantime.
async function refreshPriceIfStale() {
  try {
    const st = store.loadState(DATA_DIR);
    const hasPrice = (st.bitcoin.txs || []).some((t) => store.hasTriggerType(t, 'price'));
    if (!hasPrice) return;
    await fetchPriceCached(priceSourcesOf(st.settings), checkCadenceSecondsOf(st.settings));
  } catch (e) { console.error('price refresh failed:', e); }
}

module.exports = { PRICE_JUMP_WINDOW_MS, priceSourcesOf, priceSourceError, priceAgreementPctOf, checkCadenceSecondsOf, fetchPriceCached, NODE_FEE_CACHE_TTL_MS, fetchNodeFeesCached, fetchTipHeightsCached, priceCacheForState, exchangeStatusFor, refreshPriceIfStale };
