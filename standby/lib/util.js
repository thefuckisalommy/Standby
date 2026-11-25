'use strict';
// Standby — HTTP + validation helpers.
const { MAX_BODY } = require('./config');

function sendJson(res, status, obj) {
  // Required lazily: http.js requires this module, so a top-level require
  // would be a load cycle.
  require('./http').setSecurityHeaders(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// A client's own error, safe to show: answered with its status and
// message. Anything else is logged and answered as 'internal error'.
function clientError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.expose = true;
  return e;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(clientError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(clientError(400, 'invalid JSON')); }
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

// Broadcast route per transaction: 'public' (the mempool nodes, primary
// then secondary) or 'slipstream' (MARA only). Never a fallback chain:
// retries use the same route. Anything else is 'public'.
function validBroadcastVia(v) {
  return v === 'slipstream' ? 'slipstream' : 'public';
}

// Public fallback: an opt-in timer for a Slipstream tx; if it is not
// public within the chosen days, Standby broadcasts it publicly. Only the
// durations the UI offers; anything else is null (Never), never a 400.
// Stored but ignored while the route is public.
const PUBLIC_FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
function validPublicFallbackDays(v) {
  return (typeof v === 'number' && PUBLIC_FALLBACK_DAYS.includes(v)) ? v : null;
}

// Grace settings: graceOfflineDays (the gap that starts one) and
// graceDurationDays (null = until resumed; a stored 0 still means off).
// Only the dropdown values are accepted; anything else is a 400, so a bad
// value never silently becomes another.
const GRACE_OFFLINE_DAYS = [1, 3, 7, 14, 30];
// 0 means off (kept for old state). Indefinite arrives as the string
// 'indefinite' and is mapped to null.
const GRACE_DURATION_DAYS = [0, 1, 3, 7, 14, 30];

// Bounded number settings: out of range is a 400 (settings and restore),
// never clamped.
const PRICE_AGREEMENT_PCT_MIN = 1, PRICE_AGREEMENT_PCT_MAX = 20, PRICE_AGREEMENT_PCT_DEFAULT = 5;
const CHECK_CADENCE_SECONDS_MIN = 10, CHECK_CADENCE_SECONDS_MAX = 3600, CHECK_CADENCE_SECONDS_DEFAULT = 60;
const FEE_LOW_MULT_MIN = 1, FEE_LOW_MULT_MAX = 10, FEE_LOW_MULT_DEFAULT = 2;
const FEE_MED_MULT_MIN = 0.5, FEE_MED_MULT_MAX = 5, FEE_MED_MULT_DEFAULT = 1;

// ---------------------------------------------------------------------------
function days(from, to) {
  return Math.floor((to - from) / 86400000);
}

module.exports = { sendJson, sendError, clientError, readBody, clampInt, asStr, validBroadcastVia, PUBLIC_FALLBACK_DAYS, validPublicFallbackDays, GRACE_OFFLINE_DAYS, GRACE_DURATION_DAYS, PRICE_AGREEMENT_PCT_MIN, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_DEFAULT, CHECK_CADENCE_SECONDS_MIN, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_DEFAULT, FEE_LOW_MULT_MIN, FEE_LOW_MULT_MAX, FEE_LOW_MULT_DEFAULT, FEE_MED_MULT_MIN, FEE_MED_MULT_MAX, FEE_MED_MULT_DEFAULT, days };
