'use strict';
// Standby — HTTP + validation helpers (split from server.js, 0.8.7.3).
const { MAX_BODY } = require('./config');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function asStr(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

// Broadcast route (0.7.16): which network a transaction goes out
// on. 'public' is the mempool nodes (primary, then secondary);
// 'slipstream' is MARA Slipstream (direct to MARA Pool's private
// mempool). Per transaction, chosen when it is added and changeable
// on its card — the two routes are never a fallback chain: only the
// selected route is attempted, and the hourly retry re-attempts that
// same route. Anything else (including a missing value on an older
// record or backup) is 'public'.
function validBroadcastVia(v) {
  return v === 'slipstream' ? 'slipstream' : 'public';
}

// Public fallback (0.7.17): a per-transaction OPT-IN timer on a
// Slipstream-route transaction. If the transaction is not publicly
// visible within the chosen number of days, Standby broadcasts it
// publicly instead — the automatic version of the manual "Broadcast
// publicly" escape hatch, for when nobody is watching. The allowed
// durations are the seven the UI offers; anything else (including a
// missing value on an older record or backup) is null — Never, no
// automatic fallback. The fallback only applies while the route is
// 'slipstream'; the value is stored (and kept) when the route is
// 'public', but ignored. It is deliberately lenient, like
// validBroadcastVia above: an invalid value becomes Never, never a
// 400.
const PUBLIC_FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
function validPublicFallbackDays(v) {
  return (typeof v === 'number' && PUBLIC_FALLBACK_DAYS.includes(v)) ? v : null;
}

// Grace period (0.8.0): when the app comes back after being
// offline, price and UTXO triggers are paused for a grace
// period so they do not fire on conditions that changed while
// the app was away. graceOfflineDays is the offline gap that
// triggers it; graceDurationDays is how long it lasts, or null
// = indefinite (until the owner resumes from the dashboard
// card). The allowed values are exactly the ones the Settings
// dropdowns offer; anything else is a 400 at PUT /api/settings
// — a bad grace setting must not silently become a different
// one (unlike the lenient per-tx fallback above, where a
// missing value becomes Never at serve time).
const GRACE_OFFLINE_DAYS = [1, 3, 7, 14, 30];
const GRACE_DURATION_DAYS = [1, 3, 7, 14, 30];

// User controls (0.8.0): the Settings cards for price agreement,
// check cadence, and fee verdict. Each is a number input with a
// min/max bound — anything outside is a 400 at PUT /api/settings
// and at restore, never a silent clamp (a bad value must not
// silently become a different one).
const PRICE_AGREEMENT_PCT_MIN = 1, PRICE_AGREEMENT_PCT_MAX = 20, PRICE_AGREEMENT_PCT_DEFAULT = 5;
const CHECK_CADENCE_SECONDS_MIN = 10, CHECK_CADENCE_SECONDS_MAX = 3600, CHECK_CADENCE_SECONDS_DEFAULT = 60;
const FEE_LOW_MULT_MIN = 1, FEE_LOW_MULT_MAX = 10, FEE_LOW_MULT_DEFAULT = 2;
const FEE_MED_MULT_MIN = 0.5, FEE_MED_MULT_MAX = 5, FEE_MED_MULT_DEFAULT = 1;

// ---------------------------------------------------------------------------
function days(from, to) {
  return Math.floor((to - from) / 86400000);
}

module.exports = { sendJson, sendError, readBody, clampInt, asStr, validBroadcastVia, PUBLIC_FALLBACK_DAYS, validPublicFallbackDays, GRACE_OFFLINE_DAYS, GRACE_DURATION_DAYS, PRICE_AGREEMENT_PCT_MIN, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_DEFAULT, CHECK_CADENCE_SECONDS_MIN, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_DEFAULT, FEE_LOW_MULT_MIN, FEE_LOW_MULT_MAX, FEE_LOW_MULT_DEFAULT, FEE_MED_MULT_MIN, FEE_MED_MULT_MAX, FEE_MED_MULT_DEFAULT, days };
