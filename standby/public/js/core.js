'use strict';
// Standby's page, in plain JavaScript with no build step. It talks to the
// JSON API (standby/lib/routes/). The page loads these files in order (see
// index.html), all sharing one scope: core.js, dashboard.js,
// transactions.js, sets.js, live.js, settings.js, setup.js, main.js.
// Nothing runs at load except wiring up the page; main.js, last, starts
// loading data and the timers.
// This file: shared state, the API call, number and date formats, tabs.

var S = null; // cached state
var stateErrorShown = false; // the state-load error view is up
// Live view: refresh from the server once per check cadence, patching
// values in place.
var lastStatus = null; // the last /api/status payload (for the live tick)
var lastFetchAt = 0; // ms of the last successful state fetch (cadence gate for the next server refresh)
var liveRefreshInFlight = false; // one server refresh at a time
var liveTickRunning = false; // one 1-second tick at a time
var pendingStructural = false; // a structural change is waiting for a safe moment
var lastLiveSignature = null; // structural signature of the DOM as rendered

function $(id) { return document.getElementById(id); }

function setMsg(el, text, ok) {
  el.textContent = text;
  // ok: true (default colour), false (red: an error) or 'warn' (amber: a
  // warning, e.g. a timelocked dry run).
  el.style.color = ok === false ? '#f87171' : ok === 'warn' ? '#fbbf24' : '';
}

// With a login required, the session token is kept in localStorage
// (scoped to this origin, host and port, so no other app on the host can
// read it) and sent as X-Standby-Token. If storage throws (private
// mode), it lives only for this page.
var TOKEN_KEY = 'standby.sessionToken';
var memToken = null;
function getToken() {
  try { return window.localStorage.getItem(TOKEN_KEY) || memToken; } catch (e) { return memToken; }
}
function setToken(t) {
  memToken = t || null;
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* memory only */ }
}
function showLogin() {
  var m = $('login-modal');
  if (!m || m.classList.contains('open')) return;
  m.classList.add('open');
  var pw = $('login-password');
  if (pw) pw.focus();
}

async function api(method, path, body) {
  var headers = { 'Content-Type': 'application/json' };
  var token = getToken();
  if (token) headers['X-Standby-Token'] = token;
  var res = await fetch(path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var data = await res.json().catch(function () { return {}; });
  if (res.status === 401 && data && data.login === true) {
    // Not logged in, or the session expired / was signed out.
    setToken(null);
    showLogin();
    throw new Error('login required');
  }
  if (!res.ok) throw new Error(data.error || ('request failed: ' + res.status));
  return data;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// A due day, short: "Mon 29 Dec".
function fmtDueDay(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (!isFinite(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Check-in dates without seconds ("11/11/2026, 9:00 AM").
function fmtDateShort(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleDateString() + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// "Last checked": time only when today, else date and time (the full
// form is too long at 390px).
function fmtCheckedAt(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  var now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return fmtDateShort(iso);
}

// The grace card's end date: short, e.g. "Nov 30" (the
// full fmtDateShort string is too long for the bar label).
function fmtGraceDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// History event titles, dot colours (green confirmed, amber
// fired/conflict, red failed/stale, grey others) and short timestamps.
var HIST_TITLES = {
  added: 'Transaction added', fired: 'Trigger fired', broadcast: 'Broadcast sent',
  slipstream: 'Submitted to Slipstream', confirmed: 'Confirmed', stale: 'Went stale',
  failed: 'Broadcast failed', conflict: 'Conflict', edited: 'Transaction edited',
  armed: 'Armed', disarmed: 'Disarmed',
};
function histTitle(type) { return HIST_TITLES[type] || 'Event'; }
function histDotCls(type) {
  if (type === 'confirmed') return 'ok';
  if (type === 'fired' || type === 'conflict') return 'warn';
  if (type === 'failed' || type === 'stale') return 'bad';
  return '';
}
function fmtHistTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// A tx's live frozen time: banked offset plus any open inactive period
// (mirrors lib/checkin.js; test/mirror_check.js), so the danger zone is measured from the
// effective last check-in.
function liveOffsetMs(tx) {
  var base = (typeof tx.checkinOffsetMs === 'number' && isFinite(tx.checkinOffsetMs) && tx.checkinOffsetMs >= 0) ? tx.checkinOffsetMs : 0;
  if (typeof tx.checkinInactiveSince === 'string' && tx.checkinInactiveSince) {
    var since = new Date(tx.checkinInactiveSince).getTime();
    if (isFinite(since)) return base + Math.max(0, Date.now() - since);
  }
  return base;
}

// The danger zone: the last 25% of a check-in window (past due
// included), measured from the effective last check-in (offMs is the
// tx's frozen time). Null outside the zone, else { overdue, daysLeft,
// daysSince }.
function dangerZone(thresholdDays, offMs) {
  var last = S && S.checkin && S.checkin.lastCheckinAt;
  if (!last || !thresholdDays || thresholdDays <= 0) return null;
  var off = (typeof offMs === 'number' && isFinite(offMs) && offMs >= 0) ? offMs : 0;
  var effLast = new Date(last).getTime() + off;
  var remainingMs = effLast + thresholdDays * 86400000 - Date.now();
  if (remainingMs > 0.25 * thresholdDays * 86400000) return null;
  return {
    overdue: remainingMs <= 0,
    daysLeft: Math.max(0, Math.ceil(remainingMs / 86400000)),
    daysSince: Math.floor((Date.now() - effLast) / 86400000),
  };
}

// Satoshis (a decimal string) -> BTC with up to 8 decimals,
// trailing zeros trimmed: "100000" -> "0.001", "12500000" ->
// "0.125". BigInt, so no float ever touches the amount.
function fmtBtc(satsStr) {
  var sats = BigInt(satsStr || '0');
  var whole = sats / 100000000n;
  var frac = sats % 100000000n;
  if (frac === 0n) return whole.toString();
  return whole.toString() + '.' + frac.toString().padStart(8, '0').replace(/0+$/, '');
}

// Satoshis with thousands separators: "100000" -> "100,000".
function fmtSats(satsStr) {
  return String(satsStr == null ? '0' : satsStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A fee rate with at most one decimal (588.235… → "588.2"), so the Fee
// row fits a phone line.
function fmtRate(rate) {
  if (rate === null || rate === undefined || !isFinite(rate)) return '—';
  var r = Math.round(rate * 10) / 10;
  return String(r);
}

// Mirrors lib/bitcoin/fees.js feeVerdict (the frontend cannot import it;
// test/mirror_check.js checks they agree):
// Critical below the current economy fee; otherwise Low at lowMult x the
// 90-day peak, Medium between medMult x and lowMult x, High below. Null
// without a peak or fee rate.
function feeVerdict(rate, peak, economyFee, lowMult, medMult) {
  if (typeof rate !== 'number' || !isFinite(rate) || rate < 0) return null;
  if (typeof peak !== 'number' || !isFinite(peak) || peak <= 0) return null;
  var low = (typeof lowMult === 'number' && isFinite(lowMult) && lowMult > 0) ? lowMult : 2;
  var med = (typeof medMult === 'number' && isFinite(medMult) && medMult > 0) ? medMult : 1;
  if (typeof economyFee === 'number' && isFinite(economyFee) && economyFee >= 0 && rate < economyFee) return 'Critical Risk';
  if (rate >= low * peak) return 'Low Risk';
  if (rate >= med * peak) return 'Medium Risk';
  return 'High Risk';
}

// Fee verdict pill class: Low green, Medium amber, High lighter red,
// Critical deepest red.
function feeVerdictCls(v) {
  if (v === 'Low Risk') return 'ok';
  if (v === 'Medium Risk') return 'warn';
  if (v === 'High Risk') return 'bad-soft';
  return 'bad';
}

// Readiness fee pill text: "Low Fee Risk" (next to the status pill a
// bare "Low Risk" is ambiguous); "Med" keeps it short.
function feePillText(v) {
  if (v === 'Low Risk') return 'Low Fee Risk';
  if (v === 'Medium Risk') return 'Med Fee Risk';
  if (v === 'High Risk') return 'High Fee Risk';
  if (v === 'Critical Risk') return 'Critical Fee Risk';
  return v;
}

// The fee verdict for one tx now; null when settled or pending (the fee
// is moot) or unknown. One place, so the Fee line, the readiness pill
// and the live tick agree.
function txFeeVerdict(tx) {
  var st = txStatus(tx);
  if (st.settled || st.pending) return null;
  return feeVerdict(tx.feeRateSatVb, S.bitcoin.feePeak, S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee, S.settings && S.settings.feeLowMultiplier, S.settings && S.settings.feeMediumMultiplier);
}

// The fee-risk pop-out explains the verdict: the peak, the tx's fee, the
// current economy fee and the reason.
function showFeePopout(tx, verdict) {
  var peak = S.bitcoin.feePeak;
  var win = S.bitcoin.feePeakWindowDays;
  // The peak's window: "90-day peak" at 90 days, else "peak over the
  // last N days of observations".
  var peakLabel = (typeof win === 'number' && win < 90)
    ? 'peak over the last ' + win + (win === 1 ? ' day' : ' days') + ' of observations'
    : '90-day peak';
  var econ = S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee;
  var rate = tx.feeRateSatVb;
  // The owner's own ladder thresholds, so the pop-out explains the
  // verdict in their terms.
  var low = (S.settings && typeof S.settings.feeLowMultiplier === 'number') ? S.settings.feeLowMultiplier : 2;
  var med = (S.settings && typeof S.settings.feeMediumMultiplier === 'number') ? S.settings.feeMediumMultiplier : 1;
  var body;
  if (verdict === 'Critical Risk') {
    body = 'Your fee is ' + fmtRate(rate) + ' sat/vB, but the current economy fee is ' + fmtRate(econ) + ' sat/vB — it would not confirm within a day right now. Because it is below the current market fee, it is ranked Critical Risk.';
  } else if (verdict === 'Low Risk') {
    body = 'The ' + peakLabel + ' is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Because it is at least ' + low + '× the peak (' + fmtRate(low * peak) + ' sat/vB), it is ranked Low Risk.';
  } else if (verdict === 'Medium Risk') {
    body = 'The ' + peakLabel + ' is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Low Risk needs ' + fmtRate(low * peak) + ' sat/vB (' + low + '× the peak). Your fee is at least ' + fmtRate(med * peak) + ' sat/vB (' + med + '× the peak) but below ' + low + '× the peak, so it is ranked Medium Risk.';
  } else { // High Risk
    body = 'The ' + peakLabel + ' is ' + fmtRate(peak) + ' sat/vB. Your fee is ' + fmtRate(rate) + ' sat/vB. Because it is below ' + fmtRate(med * peak) + ' sat/vB (' + med + '× the peak), it is ranked High Risk.';
  }
  var html = '<dl class="kv">'
    + '<dt>' + peakLabel + '</dt><dd>' + escapeHtml(fmtRate(peak) + ' sat/vB') + '</dd>'
    + '<dt>Your fee</dt><dd>' + escapeHtml(fmtRate(rate) + ' sat/vB') + '</dd>'
    + ((typeof econ === 'number')
      ? '<dt>Current economy fee</dt><dd>' + escapeHtml(fmtRate(econ) + ' sat/vB') + '</dd>' : '')
    + '</dl>';
  showDetails('Fee risk', body, html);
}

// Tabs are URL hashes (#dashboard, #transactions, #settings, #logs), so
// a refresh keeps the tab and Back/Forward step through them. The
// Transactions tab's internal key is 'bitcoin' (#bitcoin is accepted
// too).
var TAB_HASH = { dashboard: 'dashboard', bitcoin: 'transactions', settings: 'settings', logs: 'logs' };
var HASH_TAB = { dashboard: 'dashboard', transactions: 'bitcoin', bitcoin: 'bitcoin', settings: 'settings', logs: 'logs' };
var currentTab = 'dashboard';
function tabFromHash() {
  var h = '';
  try { h = (window.location.hash || '').replace(/^#\/?/, ''); } catch (e) { h = ''; }
  return HASH_TAB[h] || 'dashboard';
}
function showTab(name, updateHash) {
  if (stateErrorShown) return; // the error view replaces the tabs
  if (!TAB_HASH[name]) name = 'dashboard';
  currentTab = name;
  document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
  document.querySelectorAll('section.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
  // The Settings filter resets to All each time the tab opens (guarded:
  // at startup the registry is not assigned yet).
  if (name === 'settings' && typeof SETTINGS_HELP !== 'undefined') applySettingsFilter('all');
  if (updateHash !== false) {
    try {
      var want = '#' + TAB_HASH[name];
      if (window.location.hash !== want) window.location.hash = want;
    } catch (e) { /* no window (tests) — the tab still switches */ }
  }
}
document.getElementById('tabs').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  showTab(btn.dataset.tab);
});
// Back / Forward (and a pasted link) switch tabs without a reload.
try {
  window.addEventListener('hashchange', function () {
    var t = tabFromHash();
    if (t !== currentTab) showTab(t, false);
  });
} catch (e) { /* no window (tests) */ }
// The first paint is the tab the URL names, not always Dashboard.
showTab(tabFromHash(), false);

// The Umbrel button returns to the Umbrel home on whatever host this app
// was reached on (protocol-relative root); header.js shows it on Umbrel.
var exitLink = $('exit-app');
if (exitLink) exitLink.href = '//' + window.location.hostname + '/';
