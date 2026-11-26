'use strict';

// The two node endpoints (a mempool API or Bitcoin Core RPC, lib/rpc.js),
// tried in order; a blank secondary means primary only. Requests, the
// tip height and a broadcast transaction's confirmations.

const { MEMPOOL_OVERRIDE } = require('../config');
const { requestText } = require('../net');
const rpc = require('../rpc');
const clock = require('../clock');

// Node endpoints come from settings. MEMPOOL_HOST / MEMPOOL_PORT /
// MEMPOOL_PROTOCOL override the primary (lib/config.js); there is no
// override for the secondary.
const DEFAULT_PUBLIC_API_URL = 'https://mempool.space';
const DEFAULT_SECONDARY_API_URL = 'https://blockstream.info/api';

// Normalise a user-supplied endpoint to "protocol://host[:port]" (no
// path — the app appends /api/... itself). A bare host gets https://.
// Throws on anything that is not a usable http(s) URL.
function normalizePublicApiUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return DEFAULT_PUBLIC_API_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('invalid node URL: ' + raw); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('node URL must be http(s): ' + raw);
  if (!u.hostname) throw new Error('node URL needs a host: ' + raw);
  return u.protocol + '//' + u.host;
}

function mempoolBase(settings) {
  if (MEMPOOL_OVERRIDE) return MEMPOOL_OVERRIDE;
  return normalizePublicApiUrl(settings && settings.primaryApiUrl);
}

// The secondary endpoint, or null when the setting is blank (primary
// runs alone). A blank setting is "no secondary", not the default.
function mempoolSecondaryBase(settings) {
  const v = settings && typeof settings.secondaryApiUrl === 'string' ? settings.secondaryApiUrl.trim() : '';
  if (!v) return null;
  return normalizePublicApiUrl(v);
}

// The endpoints in the order they are tried. A secondary identical to
// the primary is dropped — trying the same server twice buys nothing.
function endpointsFor(settings) {
  const s = settings || {};
  const primaryRpc = rpc.settingBase(s.primaryRpc);
  if (primaryRpc) rpc.register(primaryRpc, s.primaryRpc.user, s.primaryRpc.password);
  const eps = [{ label: 'primary', base: primaryRpc || mempoolBase(s) }];
  // Secondary disabled: return the primary alone. Every endpoint consumer
  // reads from here, so this is the whole enforcement. A missing flag
  // means enabled.
  if (s.secondaryEnabled === false) return eps;
  const secondaryRpc = rpc.settingBase(s.secondaryRpc);
  const sec = secondaryRpc || mempoolSecondaryBase(s);
  // The same node twice is tried once, with the primary's login.
  if (sec && sec !== eps[0].base) {
    if (secondaryRpc) rpc.register(secondaryRpc, s.secondaryRpc.user, s.secondaryRpc.password);
    eps.push({ label: 'secondary', base: sec });
  }
  return eps;
}

// Each node slot's base as configured (the secondary even while it is
// switched off), for the UI to match test results to its rows.
function nodeBases(settings) {
  const s = settings || {};
  return {
    primary: rpc.settingBase(s.primaryRpc) || mempoolBase(s),
    secondary: rpc.settingBase(s.secondaryRpc) || mempoolSecondaryBase(s),
  };
}

// "host[:port]" for messages and log notes (never the full URL twice).
function mempoolHostLabel(base) {
  try { return new URL(base).host; } catch { return base; }
}

function mempoolReq(path, method, body, base, timeoutMs, contentType) {
  const key = base || DEFAULT_PUBLIC_API_URL;
  const p = rpc.isRpcBase(key)
    ? rpc.answer(path, method || 'GET', body, key, timeoutMs, Object.values(ESPLORA_FEE_TARGETS))
    : restReq(path, method, body, key, timeoutMs, contentType).then((r) => { clock.observe(r.date); return r; });
  // Stamp the endpoint on any answer (any status); a timeout, refusal
  // or DNS error stamps nothing. The derived promise's catch only prevents
  // an unhandled rejection.
  p.then(() => { nodeCheckedAtByBase[key] = new Date().toISOString(); }, () => {});
  return p;
}

function restReq(path, method, body, base, timeoutMs, contentType) {
  const u = new URL(base);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': contentType || 'text/plain' } : {},
    body,
    timeoutMs,
  });
}

// Per-endpoint last-answered stamps (the secondary is only asked on
// fallback, so the rows need their own times); folded into the stored
// connection before a save.
const nodeCheckedAtByBase = {};
function nodeCheckedAt() { return { ...nodeCheckedAtByBase }; }

// Every node type reports the same 'economy' fee: mempool's economyFee is
// a ~1-day estimate, so Esplora's /fee-estimates is read at the 144-block
// target and mapped to the mempool tier shape. Targets: fastest 1, half-
// hour 3, hour 6, economy 144, minimum 1008.
const ESPLORA_FEE_TARGETS = { fastest: 1, halfHour: 3, hour: 6, economy: 144, minimum: 1008 };

// GET /api/tx/:txid: 200 with status { confirmed, block_height, ... }; 404
// means the network does not know the tx.
async function mempoolTxStatus(txid, apiBase, timeoutMs) {
  const res = await mempoolReq('/api/tx/' + txid, 'GET', undefined, apiBase, timeoutMs);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('mempool tx lookup failed (HTTP ' + res.status + ')');
  return JSON.parse(res.body);
}

// Tip height from one endpoint (the same probe the connection test uses).
async function mempoolTipHeight(apiBase) {
  const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
  if (res.status !== 200) throw new Error('mempool tip height failed (HTTP ' + res.status + ')');
  const h = parseInt(res.body.trim(), 10);
  if (!Number.isFinite(h)) throw new Error('mempool tip height unparseable');
  return h;
}

// Tip height, primary first; the secondary only when the primary has no
// valid height (its entry is then { skipped: true }).
async function fetchTipHeights(endpoints) {
  const out = {};
  if (!endpoints || !endpoints.length) return out;
  const primary = endpoints[0];
  let primaryReading;
  try {
    const h = await mempoolTipHeight(primary.base);
    primaryReading = { endpoint: primary.label, height: h, error: null };
  } catch (e) {
    primaryReading = { endpoint: primary.label, height: null, error: e.message || String(e) };
  }
  out[primary.label] = primaryReading;
  const primaryUsable = typeof primaryReading.height === 'number'
    && Number.isFinite(primaryReading.height) && primaryReading.height >= 0;
  for (let i = 1; i < endpoints.length; i++) {
    const ep = endpoints[i];
    if (primaryUsable) {
      // The primary answered, so the secondary was not needed (recorded so
      // the note does not say unreachable).
      out[ep.label] = { endpoint: ep.label, height: null, error: null, skipped: true };
      continue;
    }
    try {
      const h = await mempoolTipHeight(ep.base);
      out[ep.label] = { endpoint: ep.label, height: h, error: null };
    } catch (e) {
      out[ep.label] = { endpoint: ep.label, height: null, error: e.message || String(e) };
    }
  }
  return out;
}

// The primary's tip counts; the secondary is a fallback. No agreement
// check: a block or two of lag between nodes is normal.
function combineTipHeights(readings) {
  const valid = [];
  for (const label of Object.keys(readings || {})) {
    const r = readings[label];
    if (!r || typeof r.height !== 'number' || !Number.isFinite(r.height) || r.height < 0) continue;
    valid.push({ label, height: r.height });
  }
  if (valid.length === 0) {
    return { valid: false, tip: null, mode: 'none', note: '', reason: 'tip height unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherLabel = Object.keys(readings || {}).find((label) => label !== only.label) || 'the other node';
    const other = readings[otherLabel];
    // A secondary never asked is 'not needed', not 'unreachable'.
    const otherWhy = (other && other.skipped) ? 'not needed'
      : (other && other.error) ? 'unreachable' : 'returned invalid data';
    return { valid: true, tip: only.height, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const primary = valid.find((v) => v.label === 'primary') || valid[0];
  const tip = primary.height;
  return { valid: true, tip, mode: 'dual',
    note: a.label + ' ' + a.height.toLocaleString('en-US') + ' · ' + b.label + ' ' + b.height.toLocaleString('en-US'),
    reason: '', readings };
}

// Tip height from the first endpoint that answers; throws if none does (an
// uncountable spend never fires).
async function getTipHeight(endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try { return await mempoolTipHeight(ep.base); }
    catch (e) { errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message); }
  }
  throw new Error('could not fetch tip height (' + errors.join('; ') + ')');
}

// Confirmations for a broadcast transaction: { found, confirmed,
// blockHeight, confirmations, checkedVia, checkedBase }. found: false when
// the network does not know it; throws when no endpoint answers (the
// caller keeps the last value).
async function getConfirmations(txid, endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const st = await mempoolTxStatus(txid, ep.base);
      if (st === null) continue; // unknown here — maybe the other endpoint knows it
      const tip = await mempoolTipHeight(ep.base);
      const status = st.status || {};
      if (!status.confirmed) {
        return { found: true, confirmed: false, blockHeight: null, confirmations: 0, checkedVia: ep.label, checkedBase: ep.base };
      }
      const height = status.block_height;
      if (!Number.isFinite(height)) {
        return { found: true, confirmed: true, blockHeight: null, confirmations: null, checkedVia: ep.label, checkedBase: ep.base };
      }
      return { found: true, confirmed: true, blockHeight: height, confirmations: Math.max(0, tip - height + 1), checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  // Every endpoint 404'd or failed: not found only if every endpoint that
  // answered said 404; otherwise a lookup failure (the caller keeps the
  // last value).
  if (errors.length === 0) {
    return { found: false, confirmed: false, blockHeight: null, confirmations: null, checkedVia: null, checkedBase: null };
  }
  throw new Error('could not check confirmations (' + errors.join('; ') + ')');
}

module.exports = { DEFAULT_PUBLIC_API_URL, DEFAULT_SECONDARY_API_URL, normalizePublicApiUrl, mempoolBase, endpointsFor, nodeBases, mempoolHostLabel, mempoolReq, nodeCheckedAt, ESPLORA_FEE_TARGETS, mempoolTxStatus, mempoolTipHeight, fetchTipHeights, combineTipHeights, getTipHeight, getConfirmations };
