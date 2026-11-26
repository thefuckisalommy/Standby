'use strict';

// Broadcasting: the nodes (primary first, secondary on failure) or
// Slipstream (MARA).

const { SLIPSTREAM_API_URL_OVERRIDE } = require('../config');
const { requestText, BROADCAST_TIMEOUT_MS } = require('../net');
const instance = require('../instance');
const { appendBroadcastLog } = require('../store');
const { mempoolHostLabel, mempoolReq } = require('./nodes');

// "Already in mempool" counts as broadcast: if the reply to an accepted
// broadcast was lost, the retry sees this and must not call it a failure.
function isAlreadyOut(err) {
  return /already in mempool/i.test(err && err.message ? err.message : String(err || ''));
}

// Mempool API: POST /api/tx with the raw hex. Returns the txid as
// plain text on success. Throws on rejection — the tx stays off-chain.
async function broadcastViaApi(hex, txid, apiBase) {
  let res;
  try {
    res = await mempoolReq('/api/tx', 'POST', hex, apiBase, BROADCAST_TIMEOUT_MS);
  } catch (e) {
    throw new Error('could not reach ' + mempoolHostLabel(apiBase) + ': ' + e.message);
  }
  if (res.status === 200) {
    const returned = res.body.trim();
    // The node answers a broadcast with the txid as text. Only exactly our
    // 64-hex txid counts as success; any other 200 body is a failed
    // attempt.
    if (!/^[0-9a-f]{64}$/i.test(returned) || returned.toLowerCase() !== txid.toLowerCase()) {
      throw new Error('mempool answered 200 but returned an unexpected txid: ' + returned.slice(0, 200));
    }
    return txid;
  }
  if (isAlreadyOut(new Error(res.body))) return txid;
  throw new Error('mempool rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// MARA Slipstream: submits straight to MARA's private mempool, so the
// transaction stays private until MARA mines it (MARA is ~5% of hashrate;
// admission is best-effort). The public nodes still do every read, since
// Slipstream has no outspend lookup.
// Submit: POST /api/transactions {tx_hex}; success is HTTP 200 with status
// "success", anything else fails closed. Status: GET
// /api/transactions/status?tx_id=. No local fee pre-check: Slipstream's
// rejection reason is shown instead. SLIPSTREAM_API_URL points it at a
// test stub.
const DEFAULT_SLIPSTREAM_API_URL = 'https://slipstream.mara.com';

function slipstreamBase() {
  const v = SLIPSTREAM_API_URL_OVERRIDE;
  if (!v) return DEFAULT_SLIPSTREAM_API_URL;
  let u;
  try { u = new URL(v); } catch { throw new Error('invalid Slipstream URL: ' + v); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Slipstream URL must be http(s): ' + v);
  return u.protocol + '//' + u.host;
}

function slipstreamReq(path, method, body, timeoutMs) {
  const base = slipstreamBase();
  const u = new URL(base);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body,
    timeoutMs,
  });
}

// Submit to Slipstream; returns { txid, method: 'slipstream' } or throws.
// No fallback to the public nodes. A duplicate submit answers success
// again, so it is harmless.
async function broadcastViaSlipstream(hex, txid) {
  instance.assertOwner();
  let res;
  try {
    res = await slipstreamReq('/api/transactions', 'POST', JSON.stringify({ tx_hex: hex }), BROADCAST_TIMEOUT_MS);
  } catch (e) {
    throw new Error('could not reach Slipstream: ' + e.message);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (res.status === 200 && parsed && parsed.status === 'success') {
    return { txid, method: 'slipstream' };
  }
  // A 400 carries the reason in body.message; surface it. Anything else
  // unexpected is a failed submission (fail closed).
  if (parsed && typeof parsed.message === 'string' && parsed.message) {
    throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + parsed.message.slice(0, 200));
  }
  throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// Slipstream status, normalized: 'queued', 'confirmed', 'failed'
// (Slipstream no longer knows it: dropped, so it is retried) or 'unknown'
// (the status check failed: leave it waiting).
async function getSlipstreamTxStatus(txid) {
  let res;
  try {
    res = await slipstreamReq('/api/transactions/status?tx_id=' + encodeURIComponent(txid), 'GET');
  } catch (e) {
    return { state: 'unknown', message: 'could not reach Slipstream: ' + e.message };
  }
  if (res.status === 404) {
    return { state: 'failed', message: 'Slipstream does not list this transaction' };
  }
  if (res.status !== 200) {
    return { state: 'unknown', message: 'Slipstream status check failed (HTTP ' + res.status + ')' };
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { state: 'unknown', message: 'Slipstream status reply was not JSON' };
  }
  // A 200 carrying status 'error' is Slipstream saying it does not
  // know the transaction (the same as a 404).
  if (parsed.status === 'error') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const info = parsed.transaction;
  if (!info || typeof info !== 'object') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const st = info.status || {};
  if (st.confirmed === true) {
    return {
      state: 'confirmed',
      position: typeof info.position === 'number' ? info.position : null,
      isNextBlock: parsed.is_next_block === true,
      last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
      last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
      confirmed: true,
      blockHeight: Number.isFinite(st.block_height) ? st.block_height : null,
      message: (typeof parsed.message === 'string' && parsed.message) || '',
    };
  }
  return {
    state: 'queued',
    position: typeof info.position === 'number' ? info.position : null,
    isNextBlock: parsed.is_next_block === true,
    last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
    last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
    confirmed: false,
    blockHeight: null,
    message: (typeof parsed.message === 'string' && parsed.message) || '',
  };
}

// Real broadcast, primary first, secondary on failure. Returns { txid,
// method, fallback }; throws (and logs) on total failure. Irrevocable once
// it lands.
async function broadcastTx(dataDir, { hex, txid, endpoints, notePrefix }) {
  instance.assertOwner();
  const errors = [];
  for (const ep of endpoints) {
    try {
      const outTxid = await broadcastViaApi(hex, txid, ep.base);
      const fellBack = ep !== endpoints[0];
      appendBroadcastLog(dataDir, {
        ts: new Date().toISOString(),
        kind: 'broadcast',
        status: 'broadcast',
        method: ep.label,
        txid: outTxid,
        hexPreview: hex.slice(0, 64),
        note: (notePrefix ? notePrefix + ' ' : '') + 'Broadcast accepted by the ' + ep.label + ' node (' + mempoolHostLabel(ep.base) + ')'
          + (fellBack ? ' — the primary node failed (' + (errors[0] || '') + '), fell back to the secondary.' : '.'),
      });
      return { txid: outTxid, method: ep.label, fallback: fellBack };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  const errText = 'Broadcast failed: ' + errors.join('; ');
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'broadcast',
    status: 'failed',
    method: 'primary',
    txid: txid || '',
    hexPreview: hex.slice(0, 64),
    note: errText,
  });
  throw new Error(errText);
}

module.exports = { DEFAULT_SLIPSTREAM_API_URL, broadcastViaSlipstream, getSlipstreamTxStatus, broadcastTx };
