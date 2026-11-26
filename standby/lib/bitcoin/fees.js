'use strict';

// Fees: the 90-day peak, current estimates from the nodes, and the fee
// verdict on a stored transaction.

const rpc = require('../rpc');
const { sanitizeFeeHistory, FEE_HISTORY_WINDOW_DAYS, FEE_HISTORY_MIN_OBSERVATIONS, FEE_HISTORY_MAX_ENTRIES } = require('../store');
const { mempoolReq, ESPLORA_FEE_TARGETS } = require('./nodes');

// Fee verdict: is a transaction's fixed fee good enough for a long hold?
// It is compared with the 90-day peak (90th percentile of Standby's own
// hourly economy-fee readings, lib/release.js) and the current economy
// fee, both from the configured nodes. See feeVerdict.

// The 90th percentile of a sorted ascending array of numbers
// (linear interpolation, the standard definition). Returns null
// when there is nothing to measure.
function percentile90(sorted) {
  if (!sorted || !sorted.length) return null;
  const k = (sorted.length - 1) * 0.9;
  const f = Math.floor(k), c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] * (c - k) + sorted[c] * (k - f);
}

// The 90-day peak: the 90th percentile of the readings (a max would let
// one spike mark every fee High Risk). It stays null until
// FEE_HISTORY_MIN_OBSERVATIONS readings span a full day, so restarts
// cannot fake a peak. windowDays is the span covered; fetchedAt the latest
// reading.
function feePeakFromObservations(observations, nowMs) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const cutoff = now - FEE_HISTORY_WINDOW_DAYS * 86400000;
  const fees = [];
  let firstTs = null, lastTs = null;
  if (Array.isArray(observations)) {
    for (const e of observations) {
      if (!e || typeof e !== 'object') continue;
      const t = (typeof e.t === 'string' && e.t) ? new Date(e.t).getTime() : NaN;
      const fee = e.fee;
      if (!Number.isFinite(t) || t <= cutoff || t > now + 60000) continue;
      if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) continue;
      fees.push(fee);
      if (firstTs === null || t < firstTs) firstTs = t;
      if (lastTs === null || t > lastTs) lastTs = t;
    }
  }
  const count = fees.length;
  const windowDays = (firstTs === null || lastTs === null) ? 0
    : Math.min(FEE_HISTORY_WINDOW_DAYS, Math.ceil((lastTs - firstTs) / 86400000));
  const fetchedAt = (lastTs === null) ? null : new Date(lastTs).toISOString();
  // A full day on the raw span: the 25th hourly reading is the first a
  // full day after the first. A count alone would let restarts fake a
  // peak.
  const spanMs = (firstTs === null || lastTs === null) ? 0 : (lastTs - firstTs);
  if (count < FEE_HISTORY_MIN_OBSERVATIONS || spanMs < 86400000) return { peak: null, windowDays, observations: count, fetchedAt };
  fees.sort((a, b) => a - b);
  return { peak: percentile90(fees), windowDays, observations: count, fetchedAt };
}

// Append one { t, fee } reading. Pure. Prunes past the window and caps the
// size; at most one reading per hour (this is the single place every
// recording goes through, so restarts cannot add extra readings).
function appendFeeHistoryObservation(observations, fee, nowMs) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const next = sanitizeFeeHistory(Array.isArray(observations) ? observations : [], now);
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) return next;
  const last = next[next.length - 1];
  if (last) {
    const lastT = new Date(last.t).getTime();
    if (Number.isFinite(lastT) && now - lastT < 3600000) return next;
  }
  next.push({ t: new Date(now).toISOString(), fee });
  return next.slice(-FEE_HISTORY_MAX_ENTRIES);
}

// 1 sat/vB, the minimum relay fee. Esplora estimates can drift below it
// (they are historical); mempool tiers never do.
const MIN_FEE_RATE_SATVB = 1;

// The rate at exactly this target, or null: never a neighbouring target,
// which would mix horizons into the fee history. A present rate is floored
// at MIN_FEE_RATE_SATVB.
function feeEstimateAtTarget(estimates, target) {
  if (!estimates || typeof estimates !== 'object') return null;
  const v = estimates[String(target)];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.max(v, MIN_FEE_RATE_SATVB);
}

// Esplora /fee-estimates to the mempool tier shape; null without a usable
// economy rate.
function feeEstimatesToRecommended(estimates) {
  if (!estimates || typeof estimates !== 'object') return null;
  const out = {};
  for (const [tier, target] of Object.entries(ESPLORA_FEE_TARGETS)) {
    out[tier + 'Fee'] = feeEstimateAtTarget(estimates, target);
  }
  if (typeof out.economyFee !== 'number') return null;
  return out;
}

// Current fees from one node: /api/v1/fees/recommended, or Esplora's /fee-
// estimates when that 404s. Throws on anything unusable; the caller then
// skips the Critical check.
async function fetchCurrentFeesFromNode(base) {
  let res;
  try {
    res = await mempoolReq('/api/v1/fees/recommended', 'GET', undefined, base);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status === 200) {
    let data;
    try { data = JSON.parse(res.body); } catch { throw new Error('fees/recommended body is not JSON'); }
    const econ = data && data.economyFee;
    if (typeof econ !== 'number' || !Number.isFinite(econ) || econ < 0) throw new Error('fees/recommended has no usable economyFee');
    return {
      fastestFee: data.fastestFee, halfHourFee: data.halfHourFee,
      hourFee: data.hourFee, economyFee: econ, minimumFee: data.minimumFee,
    };
  }
  if (res.status !== 404) throw new Error('fees/recommended answered HTTP ' + res.status);
  try {
    res = await mempoolReq('/api/fee-estimates', 'GET', undefined, base);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status !== 200) throw new Error('no fee endpoint (404 on both)');
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('fee-estimates body is not JSON'); }
  const mapped = feeEstimatesToRecommended(data);
  if (!mapped) throw new Error('fee-estimates has no usable economy rate');
  return mapped;
}

// Current fees, primary first; the secondary only when the primary cannot
// answer. Throws when neither answers (the caller keeps the cached fees).
async function fetchCurrentFeesFromEndpoints(endpoints) {
  if (!endpoints || !endpoints.length) throw new Error('no fee endpoints configured');
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      return await fetchCurrentFeesFromNode(ep.base);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no fee endpoint answered');
}

// Fee verdict: below the current economy fee is Critical (it would not
// confirm within a day now). Otherwise against the 90-day peak: Low at
// lowMult x, Medium between medMult x and lowMult x, High below (defaults
// 2 and 1). Null without a peak or fee rate. The frontend mirrors this
// rule.
function feeVerdict(rate, peak, economyFee, lowMult, medMult) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null;
  if (typeof peak !== 'number' || !Number.isFinite(peak) || peak <= 0) return null;
  const low = (typeof lowMult === 'number' && Number.isFinite(lowMult) && lowMult > 0) ? lowMult : 2;
  const med = (typeof medMult === 'number' && Number.isFinite(medMult) && medMult > 0) ? medMult : 1;
  if (typeof economyFee === 'number' && Number.isFinite(economyFee) && economyFee >= 0 && rate < economyFee) return 'Critical Risk';
  if (rate >= low * peak) return 'Low Risk';
  if (rate >= med * peak) return 'Medium Risk';
  return 'High Risk';
}

// The economy fee from one node: { fee, source } from
// /api/v1/fees/recommended, or Esplora's 144-block rate. Throws when the
// node has no usable fee data. The fee-market trigger, the hourly reading
// and the node test share this.
async function fetchNodeFee(apiBase) {
  let res;
  try {
    res = await mempoolReq('/api/v1/fees/recommended', 'GET', undefined, apiBase);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status === 200) {
    let data;
    try { data = JSON.parse(res.body); } catch { throw new Error('fees/recommended body is not JSON'); }
    const econ = data && data.economyFee;
    if (typeof econ === 'number' && Number.isFinite(econ) && econ >= 0) {
      return { fee: econ, source: 'mempool' };
    }
    throw new Error('fees/recommended has no usable economyFee');
  }
  if (res.status !== 404) throw new Error('fees/recommended answered HTTP ' + res.status);
  try {
    res = await mempoolReq('/api/fee-estimates', 'GET', undefined, apiBase);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status !== 200) throw new Error('no fee endpoint (404 on both)');
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('fee-estimates body is not JSON'); }
  // The economy fee is the day-scale estimate everywhere, so Esplora's is
  // the 144-block rate; without it there is no economy fee.
  const fee = feeEstimateAtTarget(data, ESPLORA_FEE_TARGETS.economy);
  if (typeof fee !== 'number') throw new Error('fee-estimates has no usable rates');
  return { fee, source: rpc.isRpcBase(apiBase) ? 'core' : 'esplora' };
}

// Economy fee readings, primary first; the secondary only when the primary
// cannot answer or reads above FEE_IMPLAUSIBLE_SATVB (asking both every
// tick wasted the secondary's rate limit). Each reading is { fee, source
// }, { fee: null, error } or { fee: null, skipped: true }.
async function fetchNodeFeeReadings(endpoints) {
  const out = {};
  if (!endpoints || !endpoints.length) return out;
  const primary = endpoints[0];
  let primaryReading;
  try {
    const r = await fetchNodeFee(primary.base);
    primaryReading = { endpoint: primary.label, fee: r.fee, source: r.source, error: null };
  } catch (e) {
    primaryReading = { endpoint: primary.label, fee: null, source: null, error: e.message || String(e) };
  }
  out[primary.label] = primaryReading;
  const primaryUsable = typeof primaryReading.fee === 'number' && Number.isFinite(primaryReading.fee)
    && primaryReading.fee >= 0 && primaryReading.fee <= FEE_IMPLAUSIBLE_SATVB;
  for (let i = 1; i < endpoints.length; i++) {
    const ep = endpoints[i];
    if (primaryUsable) {
      // The primary answered, so the secondary was not needed (recorded so
      // the note does not say unreachable).
      out[ep.label] = { endpoint: ep.label, fee: null, source: null, error: null, skipped: true };
      continue;
    }
    try {
      const r = await fetchNodeFee(ep.base);
      out[ep.label] = { endpoint: ep.label, fee: r.fee, source: r.source, error: null };
    } catch (e) {
      out[ep.label] = { endpoint: ep.label, fee: null, source: null, error: e.message || String(e) };
    }
  }
  return out;
}

// Above this a fee reading is bad data, not a market move (the fee-market
// threshold caps at the same value).
const FEE_IMPLAUSIBLE_SATVB = 10000;

// The primary's fee counts; the secondary is a fallback (mode 'single');
// neither is 'none'. No agreement check: nodes lag each other a little. A
// reading above FEE_IMPLAUSIBLE_SATVB is bad data and ignored. Pure.
function combineFeeReadings(readings) {
  const valid = [];
  const implausible = [];
  for (const label of Object.keys(readings || {})) {
    const r = readings[label];
    if (!r || typeof r.fee !== 'number' || !Number.isFinite(r.fee) || r.fee < 0) continue;
    if (r.fee > FEE_IMPLAUSIBLE_SATVB) { implausible.push({ label, fee: r.fee }); continue; }
    valid.push({ label, fee: r.fee, source: r.source });
  }
  if (valid.length === 0) {
    if (implausible.length) {
      const names = implausible.map((x) => x.label + ' ' + x.fee + ' sat/vB').join('; ');
      return { valid: false, fee: null, mode: 'none', note: '', reason: 'implausible fee reading (' + names + ') — ignored', readings };
    }
    return { valid: false, fee: null, mode: 'none', note: '', reason: 'fee unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherLabel = Object.keys(readings || {}).find((label) => label !== only.label) || 'the other node';
    const other = readings[otherLabel];
    // A secondary never asked is 'not needed', not 'unreachable'.
    const otherWhy = (other && other.skipped) ? 'not needed'
      : (other && other.error) ? 'unreachable' : 'returned invalid data';
    return { valid: true, fee: only.fee, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const primary = valid.find((v) => v.label === 'primary') || valid[0];
  const fee = primary.fee;
  return { valid: true, fee, mode: 'dual',
    note: a.label + ' ' + a.fee + ' sat/vB · ' + b.label + ' ' + b.fee + ' sat/vB',
    reason: '', readings };
}

module.exports = { feePeakFromObservations, appendFeeHistoryObservation, feeEstimateAtTarget, feeEstimatesToRecommended, fetchCurrentFeesFromNode, fetchCurrentFeesFromEndpoints, feeVerdict, fetchNodeFee, fetchNodeFeeReadings, FEE_IMPLAUSIBLE_SATVB, combineFeeReadings };
