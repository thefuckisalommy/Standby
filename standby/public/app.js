'use strict';
// Standby UI — vanilla JS, no build step. Talks to the JSON API
// (standby/lib/api.js).
(function () {
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
  // (mirrors lib/checkin.js), so the danger zone is measured from the
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

  // Mirrors lib/bitcoin.js feeVerdict (the frontend cannot import it):
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

  // Exit App returns to the Umbrel home on whatever host this app was
  // reached on (protocol-relative root).
  var exitLink = $('exit-app');
  if (exitLink) exitLink.href = '//' + window.location.hostname + '/';
  // The menu also lists the tabs (as hash links) above Exit App; tapping
  // one switches and closes the menu.
  document.querySelectorAll('#burger-menu a[data-tab-link]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var menu = $('burger-menu');
      if (menu) menu.open = false;
      showTab(a.dataset.tabLink);
    });
  });
  // Tapping anywhere outside the open menu closes it.
  document.addEventListener('click', function (e) {
    var menu = $('burger-menu');
    if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // ---------- load & render ----------
  async function load() {
    S = await api('GET', '/api/state');
    var status = await api('GET', '/api/status');
    var checkins = await api('GET', '/api/checkins');
    var blog = await api('GET', '/api/broadcast/log');
    try { apiKeys = await api('GET', '/api/checkin-keys'); } catch (e) { apiKeys = []; }
    lastStatus = status;
    lastFetchAt = Date.now();
    renderDashboard(status);
    renderLogs(checkins, blog);
    renderBitcoin();
    renderSettings();
    refreshConfirmations(); // fire-and-forget: the sent lines show the last known count, then update
    lastLiveSignature = liveSignature(S, status, apiKeys);
    syncSetup();
  }

  // State could not load and nothing was recovered: offer restore or start
  // fresh. Only a state-load error shows this; other load failures keep
  // the plain notice.
  function showStateError(message) {
    stateErrorShown = true;
    $('tabs').style.display = 'none';
    document.querySelectorAll('main section.tab').forEach(function (s) { s.style.display = 'none'; });
    $('state-error-detail').textContent = message;
    $('state-error-card').style.display = '';
  }

  // Restore, plain or encrypted (Settings and the state-error card): an
  // encrypted backup asks for its password, and the server decrypts it.
  // Cancelling rejects with 'cancelled', which callers ignore.
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('could not read the backup file')); };
      reader.readAsText(file);
    });
  }
  var restorePwPending = null;
  function closeRestorePw(err) {
    $('restore-pw-modal').classList.remove('open');
    $('restore-password').value = '';
    var p = restorePwPending;
    restorePwPending = null;
    if (p && err) p.reject(err);
    return p;
  }
  function askBackupPassword() {
    return new Promise(function (resolve, reject) {
      restorePwPending = { resolve: resolve, reject: reject };
      $('restore-pw-modal').classList.add('open');
      $('restore-password').focus();
    });
  }
  $('restore-pw-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pw = $('restore-password').value;
    var p = closeRestorePw(null);
    if (p) p.resolve(pw);
  });
  $('restore-pw-x').addEventListener('click', function () { closeRestorePw(new Error('cancelled')); });
  $('btn-restore-pw-cancel').addEventListener('click', function () { closeRestorePw(new Error('cancelled')); });
  async function restoreBackupFile(file) {
    var backup;
    try { backup = JSON.parse(await readFileText(file)); } catch (e) { throw new Error('this is not a Standby backup file (not JSON)'); }
    if (backup && backup.format === 'standby-backup-encrypted') {
      backup.password = await askBackupPassword();
    }
    showRestoreProgress();
    try { return await api('POST', '/api/restore', backup); }
    catch (e) { showRestoreFailed(e.message); throw e; }
  }

  // The restore pop-out: the logo animates while the restore and its
  // node check run (up to a minute), then the pop-out shows the result.
  var restoreDone = null;
  function setRestoreView(logoCls, title, body, items, actions) {
    $('restore-progress-logo').setAttribute('class', 'logo-loader' + (logoCls ? ' ' + logoCls : ''));
    $('restore-progress-title').textContent = title;
    $('restore-progress-body').textContent = body;
    var list = $('restore-progress-list');
    list.innerHTML = '';
    (items || []).forEach(function (it) {
      var li = document.createElement('li');
      li.textContent = it.text;
      if (it.warn) li.className = 'warn';
      list.appendChild(li);
    });
    list.style.display = items && items.length ? '' : 'none';
    $('restore-progress-body').style.display = body ? '' : 'none';
    $('restore-progress-actions').style.display = actions ? '' : 'none';
  }
  function showRestoreProgress() {
    restoreDone = null;
    setRestoreView('', 'Restoring backup\u2026', 'Checking each transaction with your node. This can take up to a minute.', null, false);
    $('restore-progress-modal').classList.add('open');
  }
  function restoreSummary(r) {
    var n = r.restoredTxs || 0;
    var items = [{ text: n + (n === 1 ? ' transaction restored' : ' transactions restored') }];
    var c = r.recheck;
    if (!c || !n) return items;
    var found = [];
    if (c.broadcast) found.push(c.broadcast + ' already broadcast');
    if (c.stale) found.push(c.stale + ' stale');
    if (found.length) items.push({ text: found.join(', ') + ' \u2014 moved to Archived' });
    if (c.conflict) items.push({ text: c.conflict + ' in conflict (a warning)' });
    var staged = c.checked - c.unchecked - c.broadcast - c.stale;
    if (staged > 0) items.push({ text: staged + ' staged' });
    if (c.unchecked) items.push({ text: c.unchecked + ' not checked \u2014 run Dry-run all later', warn: true });
    return items;
  }
  function showRestoreResult(r, onDone) {
    restoreDone = onDone || null;
    var partial = !!(r.recheck && r.recheck.unchecked);
    setRestoreView(partial ? 'done partial' : 'done', 'Backup restored', '', restoreSummary(r), true);
  }
  function showRestoreFailed(message) {
    restoreDone = null;
    setRestoreView('', 'Restore failed', message, null, true);
    $('restore-progress-logo').setAttribute('class', 'logo-loader failed');
  }
  $('btn-restore-progress-close').addEventListener('click', function () {
    $('restore-progress-modal').classList.remove('open');
    var then = restoreDone;
    restoreDone = null;
    if (then) then();
  });
  // The short form for the Backup card's message line.
  function restoreMessage(r) {
    return restoreSummary(r).map(function (it) { return it.text; }).join(' \u00b7 ') + '.';
  }

  $('btn-state-restore').addEventListener('click', function () { $('state-restore-file').click(); });

  $('state-restore-file').addEventListener('change', async function () {
    var file = $('state-restore-file').files && $('state-restore-file').files[0];
    if (!file) return;
    try {
      var r = await restoreBackupFile(file);
      $('state-restore-file').value = '';
      // Done reloads into the restored app.
      showRestoreResult(r, function () { location.reload(); });
    } catch (e) {
      if (e.message !== 'cancelled') setMsg($('state-error-msg'), e.message, false);
      $('state-restore-file').value = '';
    }
  });

  $('btn-state-reset').addEventListener('click', function () { openFreshModal(false); });

  var PILL_CLASS = {
    'on-track': 'ok', 'release-due': 'bad', 'broadcasted': 'bad',
    'vacation': 'warn', 'not-started': 'muted', 'grace': 'warn',
  };

  // Normalize one rule; an unknown shape falls back to a 35-day check-in
  // rule (so pre-trigger txs read as check-in). Mirrors lib/store.js
  // normalizeRule.
  function normalizeRule(t) {
    if (!t || typeof t !== 'object') return { type: 'checkin', params: { thresholdDays: 35 } };
    var p = (t.params && typeof t.params === 'object') ? t.params : {};
    if (t.type === 'checkin') {
      var th = (typeof p.thresholdDays === 'number' && isFinite(p.thresholdDays)) ? Math.max(1, Math.min(3650, Math.floor(p.thresholdDays))) : 35;
      return { type: 'checkin', params: { thresholdDays: th } };
    }
    if (t.type === 'price' && (p.op === '>=' || p.op === '<=') && typeof p.value === 'number' && isFinite(p.value)) {
      return { type: 'price', params: { asset: 'BTC', op: p.op, value: p.value } };
    }
    if (t.type === 'utxo' && typeof p.outpoint === 'string' && /^[0-9a-fA-F]{64}:[0-9]+$/.test(p.outpoint.trim())) {
      var cf = (p.confirmations === 0) ? 0 : ((typeof p.confirmations === 'number' && isFinite(p.confirmations)) ? Math.max(0, Math.min(100, Math.floor(p.confirmations))) : 1);
      return { type: 'utxo', params: { outpoint: p.outpoint.trim().toLowerCase(), condition: 'spent', confirmations: cf } };
    }
    if (t.type === 'manual') return { type: 'manual', params: {} };
    if (t.type === 'blockheight' && typeof p.targetHeight === 'number' && isFinite(p.targetHeight) && Math.floor(p.targetHeight) === p.targetHeight && p.targetHeight >= 1) {
      return { type: 'blockheight', params: { targetHeight: p.targetHeight } };
    }
    if (t.type === 'setdate' && typeof p.fireAt === 'string' && isFinite(Date.parse(p.fireAt))) {
      return { type: 'setdate', params: { fireAt: new Date(Date.parse(p.fireAt)).toISOString() } };
    }
    if (t.type === 'feemarket' && typeof p.maxFeeRate === 'number' && isFinite(p.maxFeeRate) && p.maxFeeRate > 0) {
      return { type: 'feemarket', params: { maxFeeRate: p.maxFeeRate, direction: p.direction === 'above' ? 'above' : 'below' } };
    }
    return { type: 'checkin', params: { thresholdDays: 35 } };
  }
  // A rule set { op, rules }. The server serves a one-rule set as its
  // single rule, so both shapes are accepted and the set shape is
  // returned.
  function triggerSetOf(tx) {
    var t = tx && tx.trigger;
    if (t && typeof t === 'object' && Array.isArray(t.rules)) {
      var rs = t.rules.map(function (r) { return normalizeRule(r); });
      if (!rs.length) rs = [{ type: 'checkin', params: { thresholdDays: 35 } }];
      return { op: t.op === 'AND' ? 'AND' : 'OR', rules: rs };
    }
    return { op: 'OR', rules: [normalizeRule(t)] };
  }
  // Per-rule slices: a flat slice for one rule, or .rules for a multi-rule
  // set (lib/rules.js triggerStatusFor). Missing slices read as {}.
  function triggerStatesOf(tx) {
    var set = triggerSetOf(tx);
    var ts = tx && tx.triggerStatus;
    if (Array.isArray(ts)) {
      return set.rules.map(function (r, i) { return (ts[i] && typeof ts[i] === 'object') ? ts[i] : {}; });
    }
    if (ts && typeof ts === 'object') {
      if (Array.isArray(ts.rules)) {
        return set.rules.map(function (r, i) { return (ts.rules[i] && typeof ts.rules[i] === 'object') ? ts.rules[i] : {}; });
      }
      return set.rules.map(function (r, i) { return i === 0 ? ts : {}; });
    }
    return set.rules.map(function () { return {}; });
  }
  // Whether any rule in the set has this type.
  function hasRuleType(tx, type) {
    return triggerSetOf(tx).rules.some(function (r) { return r.type === type; });
  }
  // The smallest check-in threshold in a rule set (the soonest rule), or
  // null without one.
  function minSetCheckinThreshold(set) {
    var ths = (set.rules || []).filter(function (r) { return r.type === 'checkin'; }).map(function (r) { return r.params.thresholdDays; });
    return ths.length ? Math.min.apply(null, ths) : null;
  }
  function minCheckinThreshold(tx) {
    return minSetCheckinThreshold(triggerSetOf(tx));
  }
  // The set's condition: rule conditions joined with AND / OR, dropping
  // the "Fires when" prefix after the first.
  function triggerSetCondition(tx) {
    var set = triggerSetOf(tx);
    var parts = set.rules.map(function (r) { return triggerCondition(r); });
    if (parts.length <= 1) return parts[0] || '';
    var joiner = set.op === 'AND' ? ' AND ' : ' OR ';
    return parts.map(function (p, i) {
      return i === 0 ? p : p.replace(/^Fires (when|on) /, '');
    }).join(joiner);
  }
  // Pill text for a trigger type (the subcard uppercases it).
  function triggerLabel(trigger) {
    return trigger.type === 'checkin' ? 'Check-in'
      : trigger.type === 'price' ? 'BTC Price'
      : trigger.type === 'utxo' ? 'UTXO'
      : trigger.type === 'blockheight' ? 'Block height'
      : trigger.type === 'setdate' ? 'Set date'
      : trigger.type === 'feemarket' ? 'Fee market'
      : 'Manual';
  }
  // A rule's condition in words. UTXO's default (1 confirmation) reads "is
  // spent"; 0 and N > 1 say so.
  function triggerCondition(trigger) {
    if (trigger.type === 'checkin') return 'Fires when you don\u2019t check in for ' + trigger.params.thresholdDays + ' days';
    if (trigger.type === 'price') return 'Fires when BTC price ' + (trigger.params.op === '>=' ? '≥' : '≤') + ' $' + Number(trigger.params.value).toLocaleString('en-US');
    if (trigger.type === 'utxo') {
      var ucf = (trigger.params.confirmations === 0) ? 0 : (trigger.params.confirmations || 1);
      var usuffix = ucf === 0 ? ' (unconfirmed)' : (ucf === 1 ? '' : ' (' + ucf + ' confirmations)');
      return 'Fires when UTXO ' + trigger.params.outpoint.slice(0, 6) + '…' + trigger.params.outpoint.slice(-2) + ' is spent' + usuffix;
    }
    if (trigger.type === 'blockheight') return 'Fires when the chain reaches block ' + Number(trigger.params.targetHeight).toLocaleString('en-US');
    if (trigger.type === 'setdate') {
      var sd = new Date(trigger.params.fireAt);
      var shown = isFinite(sd.getTime()) ? sd.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : String(trigger.params.fireAt);
      return 'Fires on ' + shown;
    }
    if (trigger.type === 'feemarket') return 'Fires when tx fees are ' + (trigger.params.direction === 'above' ? '>= ' : '<= ') + Number(trigger.params.maxFeeRate).toLocaleString('en-US') + ' sat/vB';
    return 'Never fires — manual only';
  }
  // Row 3 of a trigger subcard: the current state in plain words.
  function triggerStateLine(trigger, ts) {
    if (trigger.type === 'price') {
      var lp = (ts && typeof ts.lastPrice === 'number' && Number.isFinite(ts.lastPrice)) ? ts.lastPrice : null;
      return lp !== null ? 'BTC price currently $' + lp.toLocaleString('en-US') : 'BTC price currently unknown';
    }
    if (trigger.type === 'checkin') {
      // On track shows days elapsed of the window; other states already
      // name themselves in the reason.
      if (ts && ts.status === 'on-track' && typeof ts.daysSince === 'number' && typeof ts.windowDays === 'number') {
        return ts.daysSince + ' of ' + ts.windowDays + ' days since last check-in';
      }
      return (ts && ts.reason) ? ts.reason : 'No check-in recorded yet';
    }
    if (trigger.type === 'blockheight') {
      var th = (ts && typeof ts.lastTipHeight === 'number' && Number.isFinite(ts.lastTipHeight)) ? ts.lastTipHeight : null;
      return th !== null ? 'Chain at block ' + th.toLocaleString('en-US') + ' of ' + Number(trigger.params.targetHeight).toLocaleString('en-US') : ((ts && ts.reason) ? ts.reason : 'Tip height unknown');
    }
    if (trigger.type === 'feemarket') {
      var ef = (ts && typeof ts.lastEconomyFee === 'number' && Number.isFinite(ts.lastEconomyFee)) ? ts.lastEconomyFee : null;
      return ef !== null ? 'Economy fee currently ' + ef + ' sat/vB' : ((ts && ts.reason) ? ts.reason : 'Fee unknown');
    }
    // UTXO, set date and manual: the reason already states it.
    return (ts && ts.reason) ? ts.reason : 'Not evaluated yet';
  }
  // Per-rule state pill: Met (green), Not met (muted), Unknown (amber: it
  // blocks an AND set), Held (amber); none for a manual rule. Null for no
  // pill.
  function ruleStatePill(trigger, ts) {
    if (trigger.type === 'manual') return null;
    var st = ts && ts.status;
    if (st === 'manual') return null;
    if (st === 'due' || st === 'release-due') return { text: 'Met', cls: 'ok' };
    if (st === 'grace' || st === 'vacation' || st === 'held') return { text: 'Held', cls: 'warn' };
    if (st === 'unknown' || st === 'not-evaluated' || !st) return { text: 'Unknown', cls: 'warn' };
    return { text: 'Not met', cls: 'muted' };
  }
  // The UTXO guard note for a confirmation mode (Add and Edit).
  function utxoGuardNote(mode, confs) {
    if (mode === 'unconfirmed') return 'Guard: fires on any spend, even unconfirmed — a mempool spend can still be evicted or replaced, so it may fire on a spend that never confirms.';
    if (confs === 1) return 'Guard: only a confirmed spend fires — an unconfirmed (mempool) spend only watches until it confirms.';
    return 'Guard: fires once the spend has ' + confs + ' confirmations — an unconfirmed (mempool) spend only watches until it confirms.';
  }
  // An ISO time as a datetime-local value in local time ('' if
  // unparseable).
  function isoToLocalDatetime(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Grace card, shown whenever a grace is active. Copy (keep exactly):
  // "Grace period has been activated because the device was offline for 3
  // days." / "2 transactions are held by grace, 1 of them would fire now."
  // The bar fills as the grace elapses; an indefinite grace has none. The
  // live tick calls this too.
  function renderGraceCard() {
    var graceCard = $('grace-card');
    if (!graceCard) return;
    graceCard.style.display = graceActive() ? '' : 'none';
    if (!graceActive()) return;
    var g = S.grace;
    var gapDays = (typeof g.offlineGapDays === 'number') ? g.offlineGapDays : 0;
    var gapText = gapDays === 1 ? '1 day' : gapDays + ' days';
    var held = graceHeldTxCount();
    var fire = graceWouldFireTxCount();
    // Built from spans and <b> elements (not innerHTML) so
    // the dynamic values are text, never markup.
    var ts = function (t) { var s = document.createElement('span'); s.textContent = t; return s; };
    var gt = $('grace-text');
    gt.innerHTML = '';
    gt.appendChild(ts('Grace period has been activated because the device was offline for '));
    var b1 = document.createElement('b'); b1.textContent = gapText; gt.appendChild(b1);
    gt.appendChild(ts('.'));
    var gh = $('grace-held');
    gh.innerHTML = '';
    var b2 = document.createElement('b');
    b2.textContent = held === 1 ? '1 transaction' : held + ' transactions';
    gh.appendChild(b2);
    gh.appendChild(ts(held === 1 ? ' is held by grace, ' : ' are held by grace, '));
    var b3 = document.createElement('b');
    b3.textContent = fire === 1 ? '1 of them' : fire + ' of them';
    gh.appendChild(b3);
    gh.appendChild(ts(' would fire now.'));
    // Finite grace bar: "Day N of M" and days left (whole days, so they
    // sum to the duration); under a day reads so plainly.
    var wrap = $('grace-bar-wrap');
    if (g.indefinite) {
      // No bar for an indefinite grace — just the labels row
      // saying when it ends.
      $('grace-bar').style.display = 'none';
      $('grace-bar-day').textContent = '';
      $('grace-bar-left').textContent = 'until you resume';
    } else {
      wrap.style.display = '';
      $('grace-bar').style.display = '';
      var triggeredMs = g.triggeredAt ? new Date(g.triggeredAt).getTime() : NaN;
      var untilMs = g.graceUntil ? new Date(g.graceUntil).getTime() : NaN;
      var durDays = Math.max(1, Math.round(((isFinite(triggeredMs) && isFinite(untilMs)) ? untilMs - triggeredMs : 7 * 86400000) / 86400000));
      var elapsedDays = isFinite(triggeredMs) ? Math.max(0, Math.floor((Date.now() - triggeredMs) / 86400000)) : 0;
      var leftMs = isFinite(untilMs) ? untilMs - Date.now() : 0;
      var leftDays = durDays - elapsedDays;
      var leftText = leftMs < 86400000 ? 'less than a day left'
        : (leftDays === 1 ? '1 day left' : leftDays + ' days left');
      $('grace-bar-day').textContent = 'Day ' + elapsedDays + ' of ' + durDays;
      $('grace-bar-left').textContent = leftText + ' · until ' + fmtGraceDate(g.graceUntil);
      var fillEl = $('grace-bar-fill');
      fillEl.style.width = (Math.min(1, Math.max(0, elapsedDays / durDays)) * 100) + '%';
      fillEl.style.background = 'var(--warn)';
    }
  }

  // The check-in card head (pill, explainer, last check-in); the live tick
  // calls this too.
  function renderStatusHead(status) {
    var pill = $('status-pill');
    pill.textContent = status.label;
    pill.className = 'pill ' + (PILL_CLASS[status.state] || 'muted');
    // The explainer line only appears when the state needs it.
    var line = $('status-line');
    line.textContent =
      status.checkinReadError ? 'Warning: the check-in receiver state could not be read — releases are held until it can be read again.'
      : status.state === 'not-started' ? 'No check-in recorded yet. Tap “Check in” to start the clock.'
      : status.state === 'vacation' ? 'Vacation mode is on' + (status.vacationUntil ? ' until ' + status.vacationUntil : ' until you say you\u2019re back') + '. The check-in countdown is frozen — the days away never count.'
      : status.state === 'grace' ? 'Grace period is active — the release is held until it ends.'
      : status.state === 'broadcasted' ? 'A broadcast went out. Check in to start a new cycle.'
      : status.state === 'release-due' ? 'Release is due — the stored transaction will be broadcast unless you check in.'
      : '';
    line.style.display = line.textContent ? '' : 'none';
    // Last check-in: the date only (each bar has its own elapsed caption
    // and window).
    var lastEl = $('last-checkin');
    lastEl.textContent = status.lastCheckinAt ? fmtDateShort(status.lastCheckinAt) : '—';
  }

  // Check-in bars as data, one per active check-in rule: from
  // status.checkinTxs, or derived for an older server. Shared by the
  // render and the live patch.
  function checkinBarsData(status) {
    var bars = status.checkinTxs || [];
    if (!bars.length) {
      // An older server sends no checkinTxs: derive one bar per check-in
      // rule from the txs' own trigger statuses (settled and pending txs
      // get none).
      bars = [];
      // Members get no bar; their set gets one per check-in rule.
      var memberIds = {};
      (S.bitcoin.sets || []).forEach(function (s) { (s.txIds || []).forEach(function (id) { memberIds[id] = true; }); });
      (S.bitcoin.txs || []).forEach(function (t) {
        if (memberIds[t.id]) return;
        if (txStatus(t).settled || txStatus(t).pending) return;
        var bset = triggerSetOf(t);
        var bstates = triggerStatesOf(t);
        bset.rules.forEach(function (rule, i) {
          if (rule.type !== 'checkin') return;
          var ts = bstates[i] || {};
          var th = rule.params.thresholdDays;
          // A past-due slice while a grace is active reads
          // 'grace', not 'release-due' — the rule is held.
          var bst = ts.status || 'not-started';
          if (graceActive() && bst === 'release-due') bst = 'grace';
          bars.push({
            id: t.id, label: t.label || '', ruleIndex: i,
            thresholdDays: th,
            daysSince: (typeof ts.daysSince === 'number') ? ts.daysSince : 0,
            windowDays: (typeof ts.windowDays === 'number' && ts.windowDays > 0) ? ts.windowDays : th,
            nextDue: ts.nextDue || null, state: bst,
            enabled: !!t.enabled,
          });
        });
      });
      (S.bitcoin.sets || []).forEach(function (s) {
        if (setStatus(s).settled || setStatus(s).pending) return;
        var sset = triggerSetOf(s);
        var sstates = triggerStatesOf(s);
        sset.rules.forEach(function (rule, i) {
          if (rule.type !== 'checkin') return;
          var sts = sstates[i] || {};
          var sth = rule.params.thresholdDays;
          var sst = sts.status || 'not-started';
          if (graceActive() && sst === 'release-due') sst = 'grace';
          bars.push({
            id: s.id, label: s.label || '', ruleIndex: i,
            thresholdDays: sth,
            daysSince: (typeof sts.daysSince === 'number') ? sts.daysSince : 0,
            windowDays: (typeof sts.windowDays === 'number' && sts.windowDays > 0) ? sts.windowDays : sth,
            nextDue: sts.nextDue || null, state: sst,
            enabled: !!s.enabled,
          });
        });
      });
    }
    return bars;
  }

  var readinessEls = {}; // entry key -> { item, row, pill, feePill }: the readiness row, so the live tick can patch its pills in place. A standalone tx keys by its tx id; a set keys by 'set:' + its set id. A set's member lines key by their tx id.
  // Exchange Status: one row per configured price source, with its last
  // price beside its own OK/Failed pill (no overall pill). Shared with the
  // live tick.
  function renderExchangeRows(status) {
    // A set's price rule counts too — its members'
    // own price rules are dormant while attached.
    var hasPriceTx = (S.bitcoin.txs || []).some(function (t) { return hasRuleType(t, 'price') && !setOfTxId(t.id); })
      || (S.bitcoin.sets || []).some(function (s) { return hasRuleType(s, 'price'); });
    var exItem = $('readiness-exchange-item');
    if (exItem) exItem.style.display = hasPriceTx ? '' : 'none';
    if (hasPriceTx) {
      var ex = (S.bitcoin && S.bitcoin.exchangeStatus) || { status: 'not-tested', detail: '', sources: [] };
      (ex.sources || []).forEach(function (src, i) {
        var host = $('readiness-exchange-' + (i + 1));
        var pill = $('readiness-exchange-' + (i + 1) + '-status');
        var priceEl = $('readiness-exchange-' + (i + 1) + '-price');
        if (!host || !pill) return;
        host.textContent = src.label || src.provider || '';
        host.title = host.textContent;
        // Checked line: "checked 11:53 PM - $61,392.8" (one refresh time
        // for both sources), or just the time before any price.
        var checked = (S.bitcoin && S.bitcoin.currentPriceAt) ? 'checked ' + fmtCheckedAt(S.bitcoin.currentPriceAt) : '';
        if (priceEl) priceEl.textContent = (src.price != null && Number.isFinite(Number(src.price))) ? (checked ? checked + ' - ' : '') + '$' + Number(src.price).toLocaleString('en-US') : checked;
        if (src.status === 'ok') { pill.textContent = 'OK'; pill.className = 'pill ok'; }
        else if (src.status === 'error') { pill.textContent = 'Failed'; pill.className = 'pill bad'; }
        else { pill.textContent = 'Not tested'; pill.className = 'pill muted'; }
      });
    }
  }

  // Member line: "Tx N — <txid prefix>…" left, amount right. N is the
  // member's position in the set, so it stays put if a member goes stale.
  // No pill on member lines.
  // A shortened txid that opens the full one (the same pop-out as a
  // card's TXID row).
  function txidLink(tx) {
    var a = document.createElement('span');
    a.className = 'txid-link';
    a.textContent = shortTxid16(tx.txid);
    a.title = 'Show full TXID';
    a.txRef = tx;
    a.addEventListener('click', function () { showTxidPopout(a.txRef); });
    return a;
  }
  // A readiness member line's left side: "Tx N — " and the txid link.
  // The tick updates the same two spans in place.
  function fillMemberLeft(el, tx, index) {
    var pre = el.children[0];
    var link = el.children[1];
    if (!pre) { pre = document.createElement('span'); el.appendChild(pre); }
    pre.textContent = 'Tx ' + index + (tx.txid ? ' \u2014 ' : '');
    if (!tx.txid) return;
    if (!link) { el.appendChild(txidLink(tx)); return; }
    link.textContent = shortTxid16(tx.txid);
    link.txRef = tx;
  }
  function readinessMemberParts(tx, index) {
    var short = (tx.txid || '').slice(0, 16);
    var left = 'Tx ' + index + (short ? ' \u2014 ' + short + '\u2026' : '');
    var sats = (tx.totalOutSats === null || tx.totalOutSats === undefined) ? '' : String(tx.totalOutSats);
    var amt = /^\d+$/.test(sats) ? fmtBtc(sats) + ' BTC' : '';
    return { left: left, amt: amt };
  }

  // How a tx is named elsewhere: a set member as '"<set label>" - Tx N'
  // (same numbering as the readiness lines); a standalone tx by its label,
  // else its short txid. Never 'Untitled transaction' in practice.
  // txRefName is the quoted form.
  function shortTxid16(txid) {
    var s = String(txid || '');
    return s ? s.slice(0, 16) + (s.length > 16 ? '\u2026' : '') : '';
  }
  function txDisplayName(tx) {
    if (!tx) return 'Untitled transaction';
    var set = setOfTxId(tx.id);
    if (set) {
      var idx = (set.txIds || []).indexOf(tx.id);
      return '"' + (set.label || 'Untitled set') + '" - Tx ' + (idx + 1);
    }
    return tx.label || shortTxid16(tx.txid) || 'Untitled transaction';
  }
  function txRefName(tx) {
    if (!tx) return 'Untitled transaction';
    var set = setOfTxId(tx.id);
    if (set) {
      var idx = (set.txIds || []).indexOf(tx.id);
      return '"' + (set.label || 'Untitled set') + '" - Tx ' + (idx + 1);
    }
    return '"' + (tx.label || shortTxid16(tx.txid) || 'Untitled transaction') + '"';
  }
  // A bar names a standalone tx (via txDisplayName) or a set; members
  // never get their own.
  function barLabel(b) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === b.id; });
    return tx ? txDisplayName(tx) : (b.label || '');
  }

  // Readiness entries: one per trigger set, headed by the set's label,
  // pill and condition (members have no labels of their own). A set
  // appears at its first member's position and only while it has a live
  // member.
  function readinessEntries() {
    var entries = [];
    var seenSets = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      var set = setOfTxId(t.id);
      if (set) {
        if (seenSets[set.id]) return;
        seenSets[set.id] = true;
        var live = setMembersOf(set).some(function (m) { var ms = txStatus(m); return !ms.settled && !ms.pending; });
        if (!live) return;
        entries.push({ kind: 'set', set: set });
        return;
      }
      var st = txStatus(t);
      if (st.settled || st.pending) return;
      entries.push({ kind: 'tx', tx: t });
    });
    return entries;
  }

  function renderDashboard(status) {
    renderGraceCard();
    // Getting Started shows only while no transaction is staged; archived
    // and pending ones do not count.
    var anyStaged = (S.bitcoin.txs || []).some(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    var gsCard = $('getting-started-card');
    if (gsCard) gsCard.style.display = anyStaged ? 'none' : '';
    // The check-in card shows only when an active tx has a check-in rule
    // (armed or disarmed: a disarmed one keeps a frozen bar). A check-in
    // rule never fires before the first check-in, so its clock is started
    // from the card once such a tx exists.
    var anyCheckinActive = (S.bitcoin.txs || []).some(function (t) { return hasRuleType(t, 'checkin') && !txStatus(t).settled && !txStatus(t).pending && !setOfTxId(t.id); })
      || (S.bitcoin.sets || []).some(function (s) { return hasRuleType(s, 'checkin') && !setStatus(s).settled && !setStatus(s).pending; });
    var showCheckin = anyCheckinActive;
    $('checkin-card').style.display = showCheckin ? '' : 'none';
    renderStatusHead(status);
    // Per-tx check-in bars, each against its own threshold
    // (status.checkinTxs[].windowDays). Green while over 3/4 of the window
    // remains, amber after, red in the last quarter; overdue is full red.
    // Disarmed bars freeze grey. Past due during a grace reads 'held by
    // grace' in amber, not due.
    var barsEl = $('checkin-tx-bars');
    barsEl.innerHTML = '';
    var bars = checkinBarsData(status);
    // Two check-in rules on one tx: label the bars by rule number.
    var barsById = {};
    bars.forEach(function (b) { barsById[b.id] = (barsById[b.id] || 0) + 1; });
    bars.forEach(function (b) {
      var daysSince = b.daysSince || 0;
      var windowDays = (typeof b.windowDays === 'number' && b.windowDays > 0) ? b.windowDays : (b.thresholdDays || 35);
      var frozen = b.enabled === false;
      var block = document.createElement('div');
      block.className = 'ck-tx' + (frozen ? ' frozen' : '');
      // The live tick finds this bar by tx and rule; its window rides on
      // the element.
      block.dataset.txId = b.id;
      block.dataset.ruleIndex = (typeof b.ruleIndex === 'number') ? b.ruleIndex : 0;
      block.dataset.windowDays = windowDays;
      var label = document.createElement('div');
      label.className = 'ck-tx-label';
      label.textContent = barLabel(b) + ((barsById[b.id] || 0) > 1 && typeof b.ruleIndex === 'number' ? ' \u2014 Rule ' + (b.ruleIndex + 1) : '');
      block.appendChild(label);
      var bar = document.createElement('div');
      bar.className = 'progress';
      var fill = document.createElement('div');
      fill.style.width = (Math.min(1, Math.max(0, daysSince / windowDays)) * 100) + '%';
      var remaining = (windowDays - daysSince) / windowDays;
      fill.style.background = frozen ? 'var(--muted)' : b.state === 'grace' ? 'var(--warn)' : remaining > 0.75 ? 'var(--ok)' : remaining > 0.25 ? 'var(--warn)' : 'var(--bad)';
      bar.appendChild(fill);
      block.appendChild(bar);
      var cap = document.createElement('p');
      cap.className = 'progress-label';
      cap.textContent = daysSince + ' of ' + windowDays + ' days elapsed' + (frozen ? ' — disarmed, frozen' : b.state === 'grace' ? ' — held by grace' : '');
      block.appendChild(cap);
      barsEl.appendChild(block);
    });
    // Active transactions only (pending and archived never broadcast at
    // release), one row per trigger set: the label with the same pill as
    // its card, plus the fee pill for a standalone tx. A set row has no
    // fee pill; under it, one line per live member with its amount.
    var entries = readinessEntries();
    var txsEl = $('readiness-txs');
    txsEl.innerHTML = '';
    readinessEls = {};
    if (entries.length) {
      entries.forEach(function (e) {
        // One block per armed rule: label and pills, then the condition
        // ("Fires when ...").
        var item = document.createElement('div');
        item.className = 'readiness-tx';
        var row = document.createElement('div');
        row.className = 'readiness-tx-row';
        var label = document.createElement('b');
        var pill = document.createElement('span');
        var fpill = null;
        var key;
        if (e.kind === 'set') {
          key = 'set:' + e.set.id;
          item.dataset.setId = e.set.id;
          label.textContent = e.set.label || 'Untitled set';
          var sst = setStatus(e.set);
          pill.className = 'pill ' + sst.cls;
          pill.textContent = setPillText(e.set, sst);
        } else {
          key = e.tx.id;
          item.dataset.txId = e.tx.id;
          // A label-less tx is named by its short txid, which opens the full one.
          if (!e.tx.label && e.tx.txid) label.appendChild(txidLink(e.tx));
          else label.textContent = txDisplayName(e.tx);
          var st = txStatus(e.tx);
          pill.className = 'pill ' + st.cls;
          pill.textContent = txPillText(e.tx, st);
          var fv = txFeeVerdict(e.tx);
          if (fv) {
            fpill = document.createElement('span');
            fpill.className = 'pill fee-pill ' + feeVerdictCls(fv);
            fpill.textContent = feePillText(fv);
          }
        }
        row.appendChild(label);
        row.appendChild(pill);
        if (fpill) row.appendChild(fpill);
        item.appendChild(row);
        var stateLine = document.createElement('div');
        stateLine.className = 'readiness-tx-state';
        // The state line is the card's condition text (one row per rule);
        // current values live on the card and in the status sections.
        stateLine.textContent = triggerSetCondition(e.kind === 'set' ? e.set : e.tx);
        item.appendChild(stateLine);
        if (e.kind === 'set') {
          setMembersOf(e.set).forEach(function (m, i) {
            var mst = txStatus(m);
            if (mst.settled || mst.pending) return;
            var parts = readinessMemberParts(m, i + 1);
            var mrow = document.createElement('div');
            mrow.className = 'readiness-tx-member';
            mrow.dataset.txId = m.id;
            var mleft = document.createElement('span');
            mleft.className = 'readiness-tx-member-label';
            fillMemberLeft(mleft, m, i + 1);
            var mamt = document.createElement('span');
            mamt.className = 'readiness-tx-member-amt';
            mamt.textContent = parts.amt;
            mrow.appendChild(mleft);
            mrow.appendChild(mamt);
            item.appendChild(mrow);
            readinessEls[m.id] = { item: mrow, left: mleft, amt: mamt };
          });
        }
        txsEl.appendChild(item);
        // The live tick patches this row's pills in place.
        readinessEls[key] = { item: item, row: row, pill: pill, feePill: fpill };
      });
    } else {
      txsEl.textContent = (S.bitcoin.txs || []).length
        ? 'No active transactions — every stored transaction is pending or archived'
        : 'No transactions stored (no broadcast at release)';
    }
    // Node Status: primary and secondary lines from the last connection
    // test; a result for an endpoint that has since changed reads Not
    // tested.
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('readiness-', 'primary', nodeBase('primary', status.nodeBases), conn);
    renderNodeStatus('readiness-', 'secondary', nodeBase('secondary', status.nodeBases), conn);
    renderExchangeRows(status);
  }

  // The Logs tab: broadcast log and recent check-ins.
  function renderLogs(checkins, blog) {
    var tbody = $('broadcast-log');
    tbody.innerHTML = '';
    if (!blog.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>';
    } else {
      blog.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.className = 'log-row';
        tr.innerHTML = '<td></td><td></td><td></td><td></td>';
        tr.children[0].textContent = fmtDate(e.ts);
        tr.children[1].textContent = e.kind || '';
        tr.children[2].textContent = (e.txid || '').slice(0, 4) + '…';
        tr.children[3].textContent = (e.status || '') + (e.method ? ' (' + e.method + ')' : '');
        tr.title = 'Click for details';
        tr.addEventListener('click', function () { showBroadcastDetails(e); });
        tbody.appendChild(tr);
      });
    }
    var cbody = $('recent-checkins');
    cbody.innerHTML = '';
    if (!checkins.length) {
      cbody.innerHTML = '<tr><td colspan="3" class="muted">None yet.</td></tr>';
    } else {
      checkins.forEach(function (c) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td>';
        tr.children[0].textContent = fmtDate(c.ts);
        tr.children[1].textContent = c.method || 'app';
        tr.children[2].textContent = c.sourceIp || '\u2014';
        cbody.appendChild(tr);
      });
    }
  }

  // A check-in shows no success line (the refreshed bars are the
  // confirmation); a failure shows its error.
  $('btn-checkin').addEventListener('click', async function () {
    try {
      await api('POST', '/api/checkin', { method: 'app' });
      await load();
      // A check-in also re-tests the nodes (best-effort).
      try { await api('POST', '/api/bitcoin/connection/test', {}); } catch (e) { /* node test failed; check-in stands */ }
      await load();
    } catch (e) { setMsg($('checkin-msg'), e.message, false); }
  });

  // Resume now ends the grace; the card disappearing on reload is the
  // confirmation. A check-in does not clear a grace.
  $('btn-resume-grace').addEventListener('click', async function () {
    try {
      await api('POST', '/api/grace/resume', {});
      await load();
    } catch (e) { setMsg($('grace-msg'), e.message, false); }
  });

  // The Add popup opens from Getting Started, the Transactions tab and the
  // "+ Add Tx" button; it never switches tabs and focuses the hex field.
  function openAddModal() {
    var m = $('add-modal');
    if (!m) return;
    setMsg($('btc-msg'), '', true);
    syncAddFallbackRow();
    m.classList.add('open');
    var hex = $('btc-hex');
    if (hex && hex.focus) hex.focus();
  }
  var onAddModalClosed = null; // setup's first-transaction step
  function closeAddModal() {
    var m = $('add-modal');
    if (m) m.classList.remove('open');
    if (onAddModalClosed) { var cb = onAddModalClosed; onAddModalClosed = null; cb(); }
  }

  // "+ Add Tx" creates one new trigger set: one label, one or more entries
  // (notes + hex), shared rules and route. The first entry is static HTML
  // (btc-notes / btc-hex); extra entries are built here. Entries are found
  // by walking children (the test DOM shim supports no general
  // querySelectorAll), and the static entry is prepended when the shim
  // omits it.
  function isAddTxEntryEl(c) {
    return (c.className || '').split(' ').indexOf('btc-tx-entry') !== -1;
  }
  function addTxEntryFields(entry) {
    return txEntryFields(entry, 'add-tx-notes', 'add-tx-hex');
  }
  function staticAddTxEntrySet() {
    return { root: null, fields: { notes: $('btc-notes'), hex: $('btc-hex') }, titleEl: null, removeBtn: null };
  }
  function addTxEntrySets() {
    var list = $('btc-tx-list');
    var kids = list ? Array.prototype.filter.call(list.children || [], isAddTxEntryEl) : [];
    if (!kids.length) return [staticAddTxEntrySet()];
    var sets = [];
    if (addTxEntryFields(kids[0]).hex !== $('btc-hex')) sets.push(staticAddTxEntrySet());
    kids.forEach(function (e) {
      sets.push({ root: e, fields: addTxEntryFields(e), titleEl: e.__titleEl || null, removeBtn: e.__removeBtn || null });
    });
    return sets;
  }
  function syncAddTxEntries() {
    var sets = addTxEntrySets();
    sets.forEach(function (s, i) {
      if (s.titleEl) s.titleEl.textContent = 'Transaction ' + (i + 1);
      if (s.removeBtn) s.removeBtn.style.display = sets.length > 1 ? '' : 'none';
    });
  }
  // One builder for a new-transaction entry (notes, hex, import and remove
  // buttons), shared by the Add, set and edit popups; cfg carries each
  // popup's class names and callbacks. The one hidden #btc-file input does
  // the reading.
  function buildTxEntry(cfg) {
    var entry = mkEl('div', cfg.entryCls);
    var head = mkEl('div', 'rule-head');
    var title = mkEl('b', null, 'Transaction');
    entry.__titleEl = title;
    head.appendChild(title);
    var rm = mkEl('button', 'rule-remove' + (cfg.removeCls ? ' ' + cfg.removeCls : ''), '\u00d7 Remove');
    rm.type = 'button';
    entry.__removeBtn = rm;
    rm.addEventListener('click', function () { if (cfg.onRemove) cfg.onRemove(entry); });
    head.appendChild(rm);
    entry.appendChild(head);
    entry.appendChild(mkEl('label', null, 'Notes (optional)'));
    var notes = document.createElement('textarea');
    notes.className = 'plain ' + cfg.notesCls;
    notes.style.minHeight = '56px';
    notes.placeholder = cfg.notesPlaceholder || 'What is this one for?';
    entry.appendChild(notes);
    entry.appendChild(mkEl('label', null, 'Signed transaction (hex or PSBT)'));
    var hex = document.createElement('textarea');
    hex.className = 'plain ' + cfg.hexCls;
    hex.style.minHeight = '120px';
    hex.placeholder = '02000000\u2026';
    hex.spellcheck = false;
    if (cfg.onHexInput) hex.addEventListener('input', cfg.onHexInput);
    entry.appendChild(hex);
    var imp = mkEl('button', cfg.importCls, 'Import from file\u2026');
    imp.type = 'button';
    imp.addEventListener('click', function () {
      pendingImportTarget = { hex: hex, msg: $(cfg.msgId) };
      $('btc-file').click();
    });
    entry.appendChild(imp);
    return entry;
  }
  // Walk a list of such entries into the same shape addTxEntrySets
  // returns.
  function txEntryFields(entry, notesCls, hexCls) {
    var out = { notes: null, hex: null };
    function walk(el) {
      Array.prototype.forEach.call(el.children || [], function (c) {
        var cls = (c.className || '').split(' ');
        if (cls.indexOf(notesCls) !== -1) out.notes = c;
        else if (cls.indexOf(hexCls) !== -1) out.hex = c;
        walk(c);
      });
    }
    walk(entry);
    return out;
  }
  function txEntrySets(listEl, entryCls, notesCls, hexCls) {
    var kids = listEl ? Array.prototype.filter.call(listEl.children || [], function (c) {
      return (c.className || '').split(' ').indexOf(entryCls) !== -1;
    }) : [];
    return kids.map(function (e) {
      return { root: e, fields: txEntryFields(e, notesCls, hexCls), titleEl: e.__titleEl || null, removeBtn: e.__removeBtn || null };
    });
  }
  // New entries from either edit popup: blank ones ignored, notes without
  // hex blocks the save. n is the position for the message.
  function collectNewTxEntries(sets) {
    var snap = sets.map(function (s, i) {
      return {
        notes: s.fields.notes ? s.fields.notes.value.trim() : '',
        hex: s.fields.hex ? s.fields.hex.value.trim() : '',
        n: i + 1
      };
    });
    var filled = snap.filter(function (e) { return !!e.hex; });
    var noteless = snap.filter(function (e) { return !e.hex && e.notes !== ''; })[0];
    return { filled: filled, noteless: noteless || null };
  }
  function buildAddTxEntry() {
    return buildTxEntry({
      entryCls: 'btc-tx-entry', notesCls: 'add-tx-notes', hexCls: 'add-tx-hex',
      importCls: 'btc-tx-import', removeCls: 'btc-tx-remove',
      notesPlaceholder: 'What is this one for? e.g. Pays the mortgage from the joint wallet; signed Oct 2026, RBF on.',
      msgId: 'btc-msg', onRemove: removeAddTxEntry
    });
  }
  function removeAddTxEntry(entry) {
    if (addTxEntrySets().length <= 1) return;
    var list = $('btc-tx-list');
    if (list) list.removeChild(entry);
    syncAddTxEntries();
  }
  // After an add the form resets to one blank entry and an empty label.
  function resetAddTxEntries() {
    var list = $('btc-tx-list');
    if (list) {
      var kids = Array.prototype.filter.call(list.children || [], isAddTxEntryEl);
      var keepFirst = kids.length && addTxEntryFields(kids[0]).hex === $('btc-hex');
      kids.forEach(function (e, i) { if (!keepFirst || i > 0) list.removeChild(e); });
    }
    var lab = $('btc-set-label');
    if (lab) lab.value = '';
    var f = staticAddTxEntrySet().fields;
    if (f.notes) f.notes.value = '';
    if (f.hex) f.hex.value = '';
    syncAddTxEntries();
  }
  // Wire the static first entry (renumbering) and the add button. A no-op
  // in the DOM shim, where addTxEntrySets covers it.
  (function () {
    var list = $('btc-tx-list');
    var kids = list ? Array.prototype.filter.call(list.children || [], isAddTxEntryEl) : [];
    if (kids.length && addTxEntryFields(kids[0]).hex === $('btc-hex')) {
      var first = kids[0];
      Array.prototype.forEach.call(first.children || [], function (c) {
        if ((c.className || '').split(' ').indexOf('rule-head') !== -1) {
          Array.prototype.forEach.call(c.children || [], function (h) {
            if (h.tagName === 'B') first.__titleEl = h;
            if ((h.className || '').split(' ').indexOf('btc-tx-remove') !== -1) first.__removeBtn = h;
          });
        }
      });
      if (first.__removeBtn) first.__removeBtn.addEventListener('click', function () { removeAddTxEntry(first); });
    }
    var addEntryBtn = $('btn-btc-add-entry');
    if (addEntryBtn) addEntryBtn.addEventListener('click', function () {
      var entry = buildAddTxEntry();
      if (list) list.appendChild(entry);
      syncAddTxEntries();
      var f = addTxEntryFields(entry);
      if (f.hex && f.hex.focus) f.hex.focus();
    });
    syncAddTxEntries();
  })();
  $('btn-getting-started-add').addEventListener('click', function () { openAddModal(); });
  $('btn-btc-add-open').addEventListener('click', function () { openAddModal(); });
  // The pill is inside the <summary>: stop its click from toggling the
  // card.
  $('btn-btc-add-pill').addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    openAddModal();
  });
  // The popup closes with Cancel, the X or the backdrop (guarded, so an
  // old page just lacks the X).
  $('btn-btc-add-cancel').addEventListener('click', function () { closeAddModal(); });
  var addModalX = $('add-modal-x');
  if (addModalX) addModalX.addEventListener('click', function () { closeAddModal(); });
  $('add-modal').addEventListener('click', function (e) {
    if (e.target === $('add-modal')) closeAddModal();
  });

  // ---------- bitcoin ----------
  // Pre-signed transactions, each with its own arm toggle, label, notes
  // and release record. Dry runs never broadcast.
  var editingId = null; // id of the tx loaded into the add form, or null
  var dryRunResults = {}; // tx id -> { text, ok, verdict, spent, unknown, error }: the last dry-run result per transaction, shown in its own card. The *line* is page memory only — but a spent verdict is also recorded on the transaction server-side (a stale release record), a conflict verdict the same way (a conflict release record — a warning, not a verdict), and an own-txid verdict as a broadcast record, so the Stale / Conflict / Broadcasted status itself survives a refresh.
  // Each card's open/closed sections, kept across re-renders (a button
  // press rebuilds every card). Keyed by tx id; set only once the user
  // toggles something, otherwise defaults apply.
  var txUiState = {};
  // The note under the fallback select: what the duration means (Never:
  // MARA holds it until mined or dropped).
  function fallbackAddNote(days) {
    if (days === null || days === undefined || days === '') return 'No automatic fallback \u2014 it stays with MARA until mined or dropped.';
    return 'If MARA hasn\u2019t confirmed it within ' + fallbackLabel(days) + ', Standby broadcasts it publicly instead.';
  }
  function fallbackLabel(days) {
    if (days === null || days === undefined || days === '') return 'Never';
    return days + (days === 1 ? ' day' : ' days');
  }
  // Days until a pending tx's fallback fires (rounded up; null means
  // Never; past reads as due).
  function fallbackCountdown(tx) {
    var days = tx.publicFallbackDays;
    if (days === null || days === undefined) return '(No automatic fallback)';
    var submittedAt = tx.release && tx.release.submittedAt;
    if (!submittedAt) return '(No automatic fallback)';
    var deadline = new Date(submittedAt).getTime() + days * 86400000;
    var left = Math.ceil((deadline - Date.now()) / 86400000);
    if (left <= 0) return '(fallback due \u2014 broadcasts publicly on the next check)';
    return '(' + left + (left === 1 ? ' day' : ' days') + ' left before fallback)';
  }
  // The fallback row text: duration, plus countdown while pending or "from
  // broadcast" while active. Shared with the live tick.
  function txFallbackText(tx, st) {
    var fbText = fallbackLabel(tx.publicFallbackDays);
    if (st.pending && tx.release && tx.release.status === 'submitted-slipstream') {
      fbText += ' ' + fallbackCountdown(tx);
    } else if (!st.pending && !st.settled) {
      // Not yet broadcast (Active): the duration runs from the
      // broadcast, not from now — "7 days from broadcast".
      fbText += ' from broadcast';
    }
    return fbText;
  }
  var txCardEls = {}; // tx id -> { row, sentLine, pill, rules, feeVerdictEl, maraEl, fallbackValueEl }: the rendered card, so the confirmations poll and the live tick can update it in place
  var setCardEls = {}; // set id -> { row, pill, rules }: the rendered set card, for the live tick

  function hostOf(u) {
    if (/^rpcs?:\/\//.test(u || '')) return u.replace(/^rpcs?:\/\//, '') + ' \u00b7 RPC';
    try { return new URL(u).host; } catch (e) { return u || ''; }
  }
  // One node's row: host plus overall pill (OK, CAUTION, FAIL, Not tested,
  // Not set); the tooltip has the detail. Settings ('btc-') also shows the
  // capability rows; the Dashboard ('readiness-') only the pill. A legacy
  // result without a status derives it from ok.
  function renderNodeStatus(prefix, label, url, conn) {
    var host = $(prefix + label);
    var pill = $(prefix + label + '-status');
    var checksEl = $(prefix + label + '-checks');
    // Each readiness row shows its own endpoint's last-answered time (the
    // secondary is only asked on fallback, so the times differ). No stamp,
    // no time.
    var checkedEl = $(prefix + label + '-checked');
    // While the secondary is disabled, the Dashboard row reads "Secondary
    // Node"; otherwise it shows the host.
    var secondaryDisabled = (label === 'secondary' && S && S.settings && S.settings.secondaryEnabled === false);
    var slotName = (prefix === 'readiness-' && secondaryDisabled) ? 'Secondary Node' : null;
    if (!url) {
      host.textContent = slotName || 'Not set';
      host.title = host.textContent;
      pill.textContent = 'Not set';
      pill.className = 'pill muted';
      if (checksEl) checksEl.style.display = 'none';
      if (checkedEl) checkedEl.textContent = '';
      return;
    }
    // Secondary disabled: the pill reads Disabled, with no checks or time,
    // never as failing.
    if (secondaryDisabled) {
      host.textContent = slotName || hostOf(url);
      host.title = host.textContent;
      pill.textContent = 'Disabled';
      pill.className = 'pill muted';
      pill.title = 'Secondary node is off — Standby talks to the primary node only.';
      if (checksEl) checksEl.style.display = 'none';
      if (checkedEl) checkedEl.textContent = '';
      return;
    }
    host.textContent = slotName || hostOf(url);
    // A long name is cut to one line with "…"; the full name is its title.
    host.title = host.textContent;
    var res = (conn.results || []).find(function (r) { return r.endpoint === label && r.base === url; });
    var stamp = conn.nodeCheckedAt && conn.nodeCheckedAt[label];
    if (checkedEl) checkedEl.textContent = (res && stamp) ? 'checked ' + fmtCheckedAt(stamp) : '';
    if (!res) {
      pill.textContent = 'Not tested';
      pill.className = 'pill muted';
      pill.title = '';
      if (checksEl) checksEl.style.display = 'none';
      return;
    }
    var status = res.status || (res.ok ? 'ok' : 'fail');
    if (status === 'ok') {
      pill.textContent = 'OK';
      pill.className = 'pill ok';
    } else if (status === 'caution') {
      pill.textContent = 'CAUTION';
      pill.className = 'pill warn';
    } else {
      pill.textContent = 'FAIL';
      pill.className = 'pill bad';
    }
    pill.title = res.detail || '';
    if (checksEl) renderNodeChecks(prefix, label, res);
  }
  // Capability lines under a node in Settings (a <details>): label and
  // value; on failure the value is the reason, in red.
  function renderNodeChecks(prefix, label, res) {
    var checksEl = $(prefix + label + '-checks');
    if (!checksEl) return;
    var checks = res.checks || null;
    if (!checks) { checksEl.style.display = 'none'; return; }
    checksEl.style.display = '';
    setNodeCheckValue(prefix + label + '-broadcast-value', checks.broadcast);
    setNodeCheckValue(prefix + label + '-fees-value', checks.fees);
    setNodeCheckValue(prefix + label + '-height-value', checks.height);
    setNodeCheckValue(prefix + label + '-outputLookup-value', checks.outputLookup);
    // RPC nodes only: whether the login is restricted.
    var userLine = $(prefix + label + '-rpcUser-line');
    if (userLine) {
      userLine.style.display = checks.rpcUser ? '' : 'none';
      setNodeCheckValue(prefix + label + '-rpcUser-value', checks.rpcUser);
    }
    // A limit or risk with a fix (txindex off, unrestricted login) says
    // how to fix it.
    var note = $(prefix + label + '-checks-note');
    if (note) {
      var text = [checks.outputLookup, checks.rpcUser]
        .map(function (c) { return (c && c.note) || ''; }).filter(Boolean).join('\n\n');
      note.textContent = text;
      note.style.display = text ? '' : 'none';
    }
  }
  function setNodeCheckValue(id, check) {
    var val = $(id);
    if (!val) return;
    if (!check) { val.textContent = ''; val.title = ''; val.classList.remove('failed'); val.classList.remove('warn'); return; }
    val.textContent = check.value || '';
    // The longer detail (e.g. which request shape answered) is the
    // hover text.
    val.title = check.detail || '';
    // A limited capability (warn) is amber, a failed one red.
    val.classList.toggle('warn', !check.ok && !!check.warn);
    val.classList.toggle('failed', !check.ok && !check.warn);
  }
  // After a test, open any node that is not OK or carries advice; never
  // close one the owner opened. Runs once per test, not on re-render.
  function openFailedNodeDetails() {
    var conn = (S.bitcoin && S.bitcoin.connection) || null;
    var results = (conn && conn.results) || [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      // An OK node with advice (an unrestricted RPC login) opens too.
      var advice = r.checks && r.checks.rpcUser && r.checks.rpcUser.note;
      if (r.status === 'ok' && !advice) continue;
      var det = $('btc-' + r.endpoint + '-details');
      if (det) det.open = true;
    }
  }
  // Which endpoint broadcast it — 'primary'/'secondary' today, and the
  // pre-0.5.4 values ('node'/'api'/'both') for records from older builds.
  function methodLabel(m) {
    return m === 'primary' ? 'primary node'
      : m === 'secondary' ? 'secondary node'
      : m === 'node' ? 'own node'
      : m === 'api' ? 'public API'
      : m === 'both' ? 'own node + public API'
      : m === 'slipstream' ? 'Slipstream (MARA)'
      : (m || '');
  }

  // MARA queue line for a waiting Slipstream tx (position and odds from
  // the last status check).
  function txMaraLine(tx) {
    var rel = tx.release;
    if (!rel || rel.status !== 'submitted-slipstream') return '';
    var m = rel.mara || {};
    var bits = [];
    if (typeof m.position === 'number') bits.push('position ' + m.position + ' in MARA\u2019s queue');
    if (m.isNextBlock === true) bits.push('likely in the next block');
    else if (typeof m.last24hOdds === 'number') bits.push(Math.round(m.last24hOdds * 100) + '% mined in the last 24h');
    else if (typeof m.last7dOdds === 'number') bits.push(Math.round(m.last7dOdds * 100) + '% mined in the last 7 days');
    if (!bits.length) return '';
    return 'Slipstream queue: ' + bits.join(', ') + '.';
  }

  // The sent line: when, via which node, how deep. confirmations null
  // means not checked yet. Wording follows the server's verdict: a missing
  // tx with a confirmed foreign spend reads stale, an unconfirmed one says
  // so; confirmed beats a lingering stale verdict.
  function txBroadcastLine(tx) {
    var b = tx.broadcasted;
    if (!b) return '';
    var conf;
    if ((typeof b.confirmations === 'number' && b.confirmations > 0) || b.blockHeight != null) {
      conf = (typeof b.confirmations === 'number' && b.confirmations > 0)
        ? b.confirmations + (b.confirmations === 1 ? ' confirmation' : ' confirmations')
        : 'confirmed in block ' + Number(b.blockHeight).toLocaleString('en-US');
    } else if (b.staleInput) {
      // A bitcoind-backed node proves the spend confirmed without
      // naming the spender — say so instead of an empty name.
      conf = 'stale — input spent by ' + (b.staleInput.spentBy ? shortTxid16(b.staleInput.spentBy) : 'a confirmed transaction (the node does not name it)')
        + ((b.staleInput.blockHeight != null) ? ' (block ' + Number(b.staleInput.blockHeight).toLocaleString('en-US') + ')' : '');
    } else if (b.conflictInput) {
      conf = 'not found on the network — its input is spent by ' + (b.conflictInput.spentBy ? shortTxid16(b.conflictInput.spentBy) : 'another transaction')
        + (b.conflictInput.unverified ? ', and the node cannot say whether that spend is confirmed' : ', but that spend is not confirmed yet');
    } else if (b.found === false) {
      // found decides: an old count of 0 must not read "in the mempool"
      // for a tx no node knows.
      conf = 'not found on the network — it may have been dropped from the mempool or replaced';
    } else if (b.confirmations === null) {
      conf = 'confirmations not checked yet';
    } else if (b.confirmations === 0) {
      conf = '0 confirmations — in the mempool, unconfirmed';
    } else {
      conf = b.confirmations + (b.confirmations === 1 ? ' confirmation' : ' confirmations');
    }
    return 'Broadcast ' + fmtDate(b.broadcastedAt) + ' via ' + methodLabel(b.method) + ' — ' + conf + '.';
  }

  // Line colour follows the verdict: confirmed green, unconfirmed amber,
  // not found or stale red.
  function broadcastLineCls(tx) {
    var b = tx.broadcasted;
    if (!b) return 'muted';
    if ((typeof b.confirmations === 'number' && b.confirmations > 0) || b.blockHeight != null) return 'tx-sent';
    if (b.found === false) return 'tx-bad';
    return 'tx-warn';
  }

  function txReleaseLine(tx) {
    // A sent tx shows its broadcast line (an on-chain fact that survives
    // check-ins); a stale record survives too; other records do not.
    if (tx.broadcasted) return txBroadcastLine(tx);
    var rel = tx.release;
    if (!rel) return '';
    if (rel.status === 'broadcast') return 'Broadcast ' + fmtDate(rel.broadcastedAt) + ' via ' + methodLabel(rel.method) + '.';
    if (rel.status === 'stale') return 'Stale — ' + (rel.error || 'inputs spent') + '.';
    // Slipstream submission: with MARA, not public yet; becomes
    // Broadcasted when the nodes see it or Failed if dropped. Shows the
    // queue line when known.
    if (rel.status === 'submitted-slipstream') {
      // The queue position is its own row (txMaraLine).
      return 'Submitted to Slipstream (MARA) ' + fmtDate(rel.submittedAt) + ' — waiting for MARA to mine it.';
    }
    return 'Failed — ' + (rel.error || 'unknown error') + '. Will retry automatically, at most once an hour.';
  }

  // Is a grace active now? S.grace is the server's computed view (null
  // when none), so an expired grace hides everywhere at once.
  function graceActive() {
    return !!(S && S.grace && S.grace.active);
  }
  // Held by the grace: armed, with a held rule type, and still active.
  function graceHoldsTx(tx) {
    if (!graceActive() || !tx || !tx.enabled) return false;
    if (!hasRuleType(tx, 'price') && !hasRuleType(tx, 'utxo') && !hasRuleType(tx, 'blockheight') && !hasRuleType(tx, 'setdate') && !hasRuleType(tx, 'feemarket') && !hasRuleType(tx, 'checkin')) return false;
    var st = txStatus(tx);
    return !st.settled && !st.pending;
  }
  // Whether THIS set is held by the grace: the same rule as
  // graceHoldsTx, at set level (see setStatus).
  function graceHoldsSet(set) {
    if (!graceActive() || !set || !set.enabled) return false;
    if (!hasRuleType(set, 'price') && !hasRuleType(set, 'utxo') && !hasRuleType(set, 'blockheight') && !hasRuleType(set, 'setdate') && !hasRuleType(set, 'feemarket') && !hasRuleType(set, 'checkin')) return false;
    var st = setStatus(set);
    return !st.settled && !st.pending;
  }
  // Txs held by the grace: armed active txs with a held rule type, plus
  // members of held sets, each counted once. Held, not evaluated.
  function graceHeldTxCount() {
    var ids = {};
    // Members are counted through their set (their own trigger is parked;
    // judging it would count a member of a manual set as held).
    (S.bitcoin.txs || []).forEach(function (t) { if (!setOfTxId(t.id) && graceHoldsTx(t)) ids[t.id] = true; });
    (S.bitcoin.sets || []).forEach(function (s) {
      if (!graceHoldsSet(s)) return;
      (s.txIds || []).forEach(function (id) { ids[id] = true; });
    });
    return Object.keys(ids).length;
  }
  // How many held txs would fire if the grace lifted: those whose served
  // triggerStatus reads wouldFire (no network). A subset of the held
  // count.
  function graceWouldFireTxCount() {
    var ids = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      // Members are skipped here, like graceHeldTxCount above —
      // their parked trigger must not count them either.
      if (!setOfTxId(t.id) && graceHoldsTx(t) && t.triggerStatus && t.triggerStatus.wouldFire) ids[t.id] = true;
    });
    (S.bitcoin.sets || []).forEach(function (s) {
      if (!graceHoldsSet(s) || !s.triggerStatus || !s.triggerStatus.wouldFire) return;
      (s.txIds || []).forEach(function (id) { ids[id] = true; });
    });
    return Object.keys(ids).length;
  }

  // "unarmed" is the whole status; settled and pending cards keep their
  // plain label.
  function txPillText(tx, st) {
    if (st.settled || st.pending) return st.label;
    if (!tx.enabled) return 'unarmed';
    // Held by the grace: just "Grace" (the amber colour already says
    // armed).
    if (st.label === 'Grace') return 'Grace';
    if (st.label === 'Ready') return 'armed';
    return st.label + ' + armed';
  }

  // One "Label: value" row in Details: a fixed 120px label column, so
  // every value starts at the same x and wraps in its own column. The
  // label's trailing space keeps textContent reading "Label: value".
  function kvRow(cls, label, value) {
    var r = document.createElement('div');
    r.className = 'tx-kv' + (cls ? ' ' + cls : '');
    var k = document.createElement('span');
    k.className = 'tx-kv-k';
    k.textContent = label + ': ';
    var v = document.createElement('span');
    v.className = 'tx-kv-v';
    v.textContent = value;
    r.appendChild(k);
    r.appendChild(v);
    return r;
  }

  // An Inputs/Outputs row: one truncated line that opens a pop-out with
  // the full info, so the card never grows.
  function ioEntryRow(label, shortText, valueClass, title, openFn) {
    var r = document.createElement('div');
    r.className = 'tx-kv tx-io-line';
    var k = document.createElement('span');
    k.className = 'tx-kv-k';
    k.textContent = label + ': ';
    var v = document.createElement('span');
    v.className = 'tx-kv-v ' + valueClass;
    v.textContent = shortText;
    v.title = title;
    v.addEventListener('click', openFn);
    r.appendChild(k);
    r.appendChild(v);
    return r;
  }

  // TXID and Inputs/Outputs pop-outs (shared showDetails), so the card
  // never shifts.
  function showTxidPopout(tx) {
    showDetails('Transaction ID', 'The full 64-character transaction ID.',
      '<dl class="kv"><dt>TXID</dt><dd>' + escapeHtml(tx.txid) + '</dd></dl>');
  }
  function showInputPopout(tx, inp, i) {
    var html = '<dl class="kv"><dt>UTXO</dt><dd>' + escapeHtml(inp.prevTxid + ':' + inp.prevVout) + '</dd>'
      + ((inp.valueSats !== null && inp.valueSats !== undefined)
        ? '<dt>Value</dt><dd>' + escapeHtml(fmtBtc(inp.valueSats) + ' BTC (' + fmtSats(inp.valueSats) + ' sats)') + '</dd>' : '')
      + '</dl>';
    showDetails('Input ' + (i + 1), 'The UTXO this input spends.', html);
  }
  function showOutputPopout(tx, out, i) {
    var html = '<dl class="kv"><dt>Value</dt><dd>' + escapeHtml(fmtBtc(out.valueSats) + ' BTC (' + fmtSats(out.valueSats) + ' sats)') + '</dd>'
      + (out.address ? '<dt>Address</dt><dd>' + escapeHtml(out.address) + '</dd>'
        : '<dt>Type</dt><dd>' + escapeHtml(out.type) + '</dd>')
      + '</dl>';
    showDetails('Output ' + (i + 1), 'The full value and destination for this output.', html);
  }

  // One transaction's status pill. Broadcast and confirmed is
  // Broadcasted (archived); broadcast but unconfirmed is Broadcast
  // (pending); broadcast but no longer known is Failed. Then: Stale
  // (inputs spent by a confirmed tx), Conflict (by an unconfirmed one:
  // a warning, still active), Node Failure, Failed, Unverified, else
  // Ready or unarmed. settled marks the Archived card, pending the
  // Pending card. A release record of 'broadcast' counts as broadcast
  // even without the fact (a restore can carry one half).
  function txStatus(tx) {
    var dr = dryRunResults[tx.id] || null;
    if (tx.broadcasted || (tx.release && tx.release.status === 'broadcast')) {
      if (tx.broadcasted && tx.broadcasted.found === false) return { label: 'Failed', cls: 'bad', settled: true, pending: false };
      // Confirmed (or a restored broadcast record with no fact) is
      // Archived, green; broadcast but unconfirmed is Pending, amber.
      if (!tx.broadcasted) return { label: 'Broadcasted', cls: 'ok', settled: true, pending: false };
      var conf = tx.broadcasted.confirmations;
      if ((typeof conf === 'number' && conf > 0) || tx.broadcasted.blockHeight != null) {
        return { label: 'Broadcasted', cls: 'ok', settled: true, pending: false };
      }
      return { label: 'Broadcast', cls: 'warn', settled: false, pending: true };
    }
    if ((tx.release && tx.release.status === 'stale') || (dr && dr.spent)) {
      return { label: 'Stale', cls: 'bad', settled: true, pending: false };
    }
    // Slipstream Pending: submitted to MARA, not yet public. Lives in the
    // Pending card with its own amber pill, and beats a timelock or
    // conflict warning.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      return { label: 'Slipstream Pending', cls: 'warn', settled: false, pending: true };
    }
    // Timelock warning: the locktime has not passed, so the node would
    // reject it. Stays active; the broadcast retries once it passes. Beats
    // a conflict, as in the dry run.
    if (dr && dr.verdict === 'timelocked') {
      return { label: 'Timelocked', cls: 'warn', settled: false, pending: false };
    }
    if (dr && dr.error) return { label: 'Node Failure', cls: 'warn', settled: false, pending: false };
    // Unconfirmed-spend warning: the card stays active and broadcasts are
    // still attempted; the server clears it on a clean check or turns it
    // stale on a confirmed spend.
    if ((tx.release && tx.release.status === 'conflict') || (dr && dr.verdict === 'conflict')) {
      return { label: 'Conflict', cls: 'warn', settled: false, pending: false };
    }
    if (tx.release && tx.release.status === 'failed') {
      var e = tx.release.error || '';
      var node = e.indexOf('input check failed') !== -1 || e.indexOf('could not reach') !== -1;
      return node
        ? { label: 'Node Failure', cls: 'warn', settled: false, pending: false }
        : { label: 'Failed', cls: 'warn', settled: false, pending: false };
    }
    if (dr && dr.unknown) return { label: 'Unverified', cls: 'muted', settled: false, pending: false };
    // Unarmed: the pill reads just "unarmed".
    if (!tx.enabled) return { label: 'unarmed', cls: 'muted', settled: false, pending: false };
    // During a grace, an armed active tx with a held rule type reads Grace
    // (amber); manual txs are not held.
    if (graceActive()) {
      if (hasRuleType(tx, 'price') || hasRuleType(tx, 'utxo') || hasRuleType(tx, 'blockheight') || hasRuleType(tx, 'setdate') || hasRuleType(tx, 'feemarket') || hasRuleType(tx, 'checkin')) return { label: 'Grace', cls: 'warn', settled: false, pending: false };
    }
    return { label: 'Ready', cls: 'ok', settled: false, pending: false };
  }

  // 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:1'
  // -> 'f4184fc59640:1': short enough to fit a card line, long enough
  // to tell two inputs apart.
  function shortInput(input) {
    var parts = String(input || '').split(':');
    return parts[0].slice(0, 12) + (parts.length > 1 ? ':' + parts[1] : '');
  }

  // Shared-input warnings come from the state on every load (computed
  // server-side), so they persist without a dry run. Settled and pending
  // cards get none. Shared with the live tick.
  function computeOverlaps() {
    var overlapsByTx = {};
    (S.bitcoin.overlaps || []).forEach(function (ov) {
      ov.txIds.forEach(function (tid) {
        var tx = (S.bitcoin.txs || []).find(function (y) { return y.id === tid; });
        if (tx && (txStatus(tx).settled || txStatus(tx).pending)) return;
        var others = ov.txIds.filter(function (x) { return x !== tid; }).map(function (x) {
          var t = (S.bitcoin.txs || []).find(function (y) { return y.id === x; });
          // A member is named by its set, never
          // by its own (absent) label — '"<set label>" - Tx N'.
          return t ? txRefName(t) : x;
        }).join(', ');
        (overlapsByTx[tid] = overlapsByTx[tid] || []).push({ input: ov.input, others: others });
      });
    });
    return overlapsByTx;
  }

  // Trigger subcards, one 3-row box per rule (with the combination line
  // for a set), for tx and set cards alike. Returns the refs the live tick
  // patches.
  function appendTriggerBoxes(parent, holder) {
    var ruleEls = [];
  var ruleSet = triggerSetOf(holder);
  var ruleStates = triggerStatesOf(holder);
  if (ruleSet.rules.length > 1) {
    var combo = document.createElement('div');
    combo.className = 'tx-rules-combo';
    combo.appendChild(document.createElement('span')).textContent = 'Broadcasts when ';
    var comboOp = document.createElement('strong');
    comboOp.textContent = ruleSet.op === 'AND' ? 'ALL' : 'ANY';
    combo.appendChild(comboOp);
    combo.appendChild(document.createElement('span')).textContent = ruleSet.op === 'AND' ? ' rules hold' : ' rule fires';
    parent.appendChild(combo);
  }
  ruleSet.rules.forEach(function (rule, ri) {
    var trigBox = document.createElement('div');
    trigBox.className = 'tx-trigger';
    var trigK = document.createElement('span');
    trigK.className = ruleSet.rules.length > 1 ? 'tx-trigger-k rule-k' : 'tx-trigger-k';
    trigK.textContent = ruleSet.rules.length > 1 ? 'Rule ' + (ri + 1) + ' \u2014 ' + triggerLabel(rule) : 'TRIGGER - ' + triggerLabel(rule).toUpperCase();
    var trigHead = document.createElement('span');
    trigHead.className = 'tx-trigger-head';
    trigHead.appendChild(trigK);
    // The per-rule state pill in each subcard header (none for manual).
    var trigPill = ruleStatePill(rule, ruleStates[ri] || {});
    if (trigPill) {
      var trigPillEl = document.createElement('span');
      trigPillEl.className = 'pill ' + trigPill.cls;
      trigPillEl.textContent = trigPill.text;
      trigHead.appendChild(trigPillEl);
    }
    trigBox.appendChild(trigHead);
    var trigCond = document.createElement('span');
    trigCond.textContent = triggerCondition(rule);
    trigBox.appendChild(trigCond);
    var trigNow = document.createElement('span');
    trigNow.className = 'now';
    trigNow.textContent = triggerStateLine(rule, ruleStates[ri] || {});
    trigBox.appendChild(trigNow);
    parent.appendChild(trigBox);
    ruleEls.push({ pillEl: (typeof trigPillEl !== 'undefined' && trigPillEl) ? trigPillEl : null, condEl: trigCond, nowEl: trigNow });
  });
    return ruleEls;
  }

  // One history timeline, oldest first, shared by tx and set cards.
  function buildHistoryList(hist) {
    var tl = document.createElement('ul');
    tl.className = 'timeline';
    hist.forEach(function (ev) {
      var li = document.createElement('li');
      var dot = document.createElement('span');
      var dotCls = histDotCls(ev.type);
      dot.className = 'dot' + (dotCls ? ' ' + dotCls : '');
      li.appendChild(dot);
      var evEl = document.createElement('div');
      evEl.className = 'ev';
      evEl.textContent = histTitle(ev.type);
      var tEl = document.createElement('span');
      tEl.className = 't';
      tEl.textContent = fmtHistTime(ev.ts);
      evEl.appendChild(tEl);
      li.appendChild(evEl);
      if (ev.detail) {
        var det = document.createElement('div');
        det.className = 'det';
        det.textContent = ev.detail;
        li.appendChild(det);
      }
      tl.appendChild(li);
    });
    return tl;
  }

  // One tx's Details: inputs/outputs, fee, TXID, route, fallback,
  // locktime, created, MARA line, notes, sent line and (standalone only)
  // its History. Returns the elements the live tick patches.
  function buildTxDetails(tx, st, uiKey, includeHistory) {
    var feeVerdictEl = null;
    var maraEl = null;
    var fallbackValueEl = null;
  var ui = txUiState[uiKey] || {};
  var details = document.createElement('details');
  details.className = 'tx-details';
  details.open = ui.detailsOpen !== undefined ? ui.detailsOpen : false;
  details.addEventListener('toggle', function () {
    (txUiState[uiKey] = txUiState[uiKey] || {}).detailsOpen = details.open;
  });
  var sum = document.createElement('summary');
  sum.textContent = 'Details';
  details.appendChild(sum);
  var body = details;
  // Inputs and Outputs: one entry shows inline; more become a collapsed
  // drop-down with a count. Each row is a truncated line that opens a pop-
  // out. The detail is derived server-side from the hex; without it the
  // counts show.
  var io = tx.detail;
  if (io && Array.isArray(io.inputs) && Array.isArray(io.outputs)) {
    if (io.inputs.length === 1) {
      var inp0 = io.inputs[0];
      var shortIn = shortInput(inp0.prevTxid + ':' + inp0.prevVout) + '…'
        + ((inp0.valueSats !== null && inp0.valueSats !== undefined) ? ' · ' + fmtBtc(inp0.valueSats) + ' BTC' : '');
      body.appendChild(ioEntryRow('Input', shortIn, 'tx-io-value', 'Click to show full input', function () { showInputPopout(tx, inp0, 0); }));
    } else {
      var inDet = document.createElement('details');
      inDet.className = 'tx-io';
      inDet.open = ui.inputsOpen === true;
      inDet.addEventListener('toggle', function () {
        (txUiState[uiKey] = txUiState[uiKey] || {}).inputsOpen = inDet.open;
      });
      var inSum = document.createElement('summary');
      inSum.textContent = 'Inputs: ' + tx.inputs;
      inDet.appendChild(inSum);
      io.inputs.forEach(function (inp, i) {
        var shortText = shortInput(inp.prevTxid + ':' + inp.prevVout) + '…'
          + ((inp.valueSats !== null && inp.valueSats !== undefined) ? ' · ' + fmtBtc(inp.valueSats) + ' BTC' : '');
        inDet.appendChild(ioEntryRow('Input ' + (i + 1), shortText, 'tx-io-value', 'Click to show full input', function () { showInputPopout(tx, inp, i); }));
      });
      body.appendChild(inDet);
    }
    if (io.outputs.length === 1) {
      var out0 = io.outputs[0];
      var shortOut = fmtBtc(out0.valueSats) + ' BTC (' + fmtSats(out0.valueSats) + ' sats)'
        + (out0.address ? ' → ' + out0.address.slice(0, 12) + '…' : ' · ' + out0.type);
      body.appendChild(ioEntryRow('Output', shortOut, 'tx-io-value', 'Click to show full output', function () { showOutputPopout(tx, out0, 0); }));
    } else {
      var outDet = document.createElement('details');
      outDet.className = 'tx-io';
      outDet.open = ui.outputsOpen === true;
      outDet.addEventListener('toggle', function () {
        (txUiState[uiKey] = txUiState[uiKey] || {}).outputsOpen = outDet.open;
      });
      var outSum = document.createElement('summary');
      outSum.textContent = 'Outputs: ' + tx.outputs;
      outDet.appendChild(outSum);
      io.outputs.forEach(function (out, i) {
        var shortText = fmtBtc(out.valueSats) + ' BTC (' + fmtSats(out.valueSats) + ' sats)'
          + (out.address ? ' → ' + out.address.slice(0, 12) + '…' : ' · ' + out.type);
        outDet.appendChild(ioEntryRow('Output ' + (i + 1), shortText, 'tx-io-value', 'Click to show full output', function () { showOutputPopout(tx, out, i); }));
      });
      body.appendChild(outDet);
    }
  } else {
    body.appendChild(kvRow('', 'Inputs', String(tx.inputs)));
    body.appendChild(kvRow('', 'Outputs', String(tx.outputs)));
  }
  // Fee row, hidden when the fee is unknown. Units shortened so it fits a
  // phone line. An active tx adds its verdict (" — Low Risk" etc.), only
  // when known.
  if (tx.feeSats !== null && tx.feeSats !== undefined) {
    var feeRow = kvRow('tx-fee', 'Fee', fmtSats(tx.feeSats) + ' · ' + fmtRate(tx.feeRateSatVb) + ' sat/vB');
    var fv = txFeeVerdict(tx);
    if (fv) {
      var fvs = document.createElement('span');
      fvs.className = 'fee-verdict ' + feeVerdictCls(fv);
      fvs.textContent = ' — ' + fv;
      feeRow.children[1].appendChild(fvs);
      feeVerdictEl = fvs;
      // The Fee line opens the fee-risk pop-out when there is a verdict to
      // explain.
      feeRow.children[1].className = 'tx-kv-v tx-fee-value';
      feeRow.children[1].title = 'Click to see how this risk was calculated';
      feeRow.children[1].addEventListener('click', function () { showFeePopout(tx, txFeeVerdict(tx) || fv); });
    }
    body.appendChild(feeRow);
  }
  // TXID, truncated; tapping opens the full value in a pop-out (inline
  // would grow the card). Display only.
  var txidRow = document.createElement('div');
  txidRow.className = 'tx-kv tx-txid';
  var txidK = document.createElement('span');
  txidK.className = 'tx-kv-k';
  txidK.textContent = 'TXID: ';
  var txidV = document.createElement('span');
  txidV.className = 'tx-kv-v tx-txid-value';
  txidV.textContent = tx.txid.slice(0, 16) + '…';
  txidV.title = 'Click to show full TXID';
  txidV.addEventListener('click', function () { showTxidPopout(tx); });
  txidRow.appendChild(txidK);
  txidRow.appendChild(txidV);
  body.appendChild(txidRow);
  body.appendChild(kvRow('tx-route', 'Broadcast via', tx.broadcastVia === 'slipstream' ? 'Slipstream (MARA)' : 'Public mempool'));
  // Public fallback timer: shown only while the route is Slipstream and a
  // fallback is set; counted from when MARA first received the tx. Changed
  // in the Edit popup.
  if (tx.broadcastVia === 'slipstream' && tx.publicFallbackDays !== null && tx.publicFallbackDays !== undefined) {
    var fbRow = kvRow('tx-fallback', 'Public Fallback', txFallbackText(tx, st));
    fallbackValueEl = fbRow.children[1];
    body.appendChild(fbRow);
  }
  if (tx.locktime > 0) {
    body.appendChild(kvRow('', 'Locktime', String(tx.locktime)));
  }
  body.appendChild(kvRow('', 'Created', fmtDate(tx.createdAt)));
  // MARA queue line on a pending Slipstream card, its own row.
  if (st.pending && tx.release && tx.release.status === 'submitted-slipstream') {
    var mara = txMaraLine(tx);
    if (mara) {
      var maraLine = document.createElement('p');
      maraLine.className = 'tx-mara';
      maraLine.textContent = mara;
      maraEl = maraLine;
      body.appendChild(maraLine);
    }
  }
  if (tx.notes) {
    var notes = document.createElement('p');
    notes.className = 'tx-notes';
    notes.textContent = tx.notes;
    body.appendChild(notes);
  }
  var sentLine = null;
  if (tx.release || tx.broadcasted) {
    var rel = document.createElement('p');
    rel.className = broadcastLineCls(tx);
    rel.textContent = txReleaseLine(tx);
    body.appendChild(rel);
    if (tx.broadcasted) sentLine = rel;
  }
  // History: the tx's transitions, oldest first, collapsed inside Details;
  // hidden when empty.
  var hist = tx.history;
  if (includeHistory && Array.isArray(hist) && hist.length) {
    var histDet = document.createElement('details');
    histDet.className = 'tx-history';
    histDet.open = ui.historyOpen === true;
    histDet.addEventListener('toggle', function () {
      (txUiState[uiKey] = txUiState[uiKey] || {}).historyOpen = histDet.open;
    });
    var histSum = document.createElement('summary');
    histSum.textContent = 'History';
    histDet.appendChild(histSum);
    histDet.appendChild(buildHistoryList(hist));
    details.appendChild(histDet);
  }
    return { details: details, feeVerdictEl: feeVerdictEl, maraEl: maraEl, fallbackValueEl: fallbackValueEl, sentLine: sentLine };
  }

  // Trigger sets: one label, arm and rule set for several txs, in the
  // set's order; members have no card of their own.
  function setOfTxId(txId) {
    return ((S.bitcoin.sets || []).find(function (s) { return (s.txIds || []).indexOf(txId) !== -1; })) || null;
  }
  function setMembersOf(set) {
    var txs = S.bitcoin.txs || [];
    return (set.txIds || []).map(function (id) {
      return txs.filter(function (t) { return t.id === id; })[0];
    }).filter(function (t) { return !!t; });
  }
  // A set's status from its members: Stale only when every member is
  // stale; all settled is Broadcasted; any pending is Broadcast; otherwise
  // like a tx.
  function setStatus(set) {
    var members = setMembersOf(set);
    if (!members.length) return { label: 'Empty', cls: 'muted', settled: false, pending: false };
    var sts = members.map(function (t) { return txStatus(t); });
    // Only all-stale makes the set Stale; one stale member just carries
    // its own pill.
    if (sts.every(function (s) { return s.label === 'Stale'; })) return { label: 'Stale', cls: 'bad', settled: true, pending: false };
    if (sts.every(function (s) { return s.settled; })) return { label: 'Broadcasted', cls: 'ok', settled: true, pending: false };
    if (sts.some(function (s) { return s.pending; })) return { label: 'Broadcast', cls: 'warn', settled: false, pending: true };
    if (!set.enabled) return { label: 'unarmed', cls: 'muted', settled: false, pending: false };
    if (graceActive() && (hasRuleType(set, 'price') || hasRuleType(set, 'utxo') || hasRuleType(set, 'blockheight') || hasRuleType(set, 'setdate') || hasRuleType(set, 'feemarket') || hasRuleType(set, 'checkin'))) return { label: 'Grace', cls: 'warn', settled: false, pending: false };
    return { label: 'Ready', cls: 'ok', settled: false, pending: false };
  }
  // The set card's pill text — the txPillText rule, at set level.
  function setPillText(set, st) {
    if (st.settled || st.pending) return st.label;
    if (!set.enabled) return 'unarmed';
    if (st.label === 'Grace') return 'Grace';
    if (st.label === 'Ready') return 'armed';
    return st.label + ' + armed';
  }
  function setTotalSats(set) {
    return setMembersOf(set).reduce(function (a, t) { return a + (Number(t.totalOutSats) || 0); }, 0);
  }

  // One blue transaction subcard (every card has one per tx; a standalone
  // tx is a set of one). Its Details live inside it, never in a trigger
  // subcard. Set members pass includeHistory false: the set's shared
  // History is the only trail shown. Returns the element and the refs the
  // live tick patches.
  function buildTxItem(tx, st, uiKey, includeHistory, idx, overlapsByTx) {
    var item = document.createElement('div');
    item.className = 'tx-trigger tx-item';
    var itemHead = document.createElement('span');
    itemHead.className = 'tx-trigger-head';
    var itemK = document.createElement('span');
    itemK.className = 'tx-trigger-k rule-k';
    itemK.textContent = 'Tx ' + (idx + 1) + ' — ' + tx.txid.slice(0, 16) + '…';
    itemHead.appendChild(itemK);
    // A stale member gets a 'stale' pill (the only per-member pill).
    if (st.label === 'Stale') {
      var itemPill = document.createElement('span');
      itemPill.className = 'pill bad';
      itemPill.textContent = 'stale';
      itemHead.appendChild(itemPill);
    }
    // The amount sits right-aligned in the head line.
    var itemAmt = document.createElement('span');
    itemAmt.className = 'tx-item-amt';
    itemAmt.textContent = fmtBtc(tx.totalOutSats) + ' BTC';
    itemHead.appendChild(itemAmt);
    item.appendChild(itemHead);
    // The fee lives inside Details, not here.
    var detOut = buildTxDetails(tx, st, uiKey, includeHistory);
    item.appendChild(detOut.details);
    // The last dry-run result for THIS transaction, under its
    // Details — visible without expanding anything.
    var dr = dryRunResults[tx.id];
    if (dr) {
      var dryLine = document.createElement('p');
      dryLine.className = dr.verdict === 'timelocked' ? 'tx-dryrun tx-warn' : 'tx-dryrun muted';
      dryLine.textContent = dr.text;
      item.appendChild(dryLine);
    }
    // Shared-input warning: another stored tx spends the same input, so
    // only one can confirm.
    var ow = overlapsByTx[tx.id];
    if (ow && ow.length) {
      ow.forEach(function (w) {
        var warnLine = document.createElement('p');
        warnLine.className = 'tx-warn';
        warnLine.textContent = 'Warning: shares input ' + shortInput(w.input) + ' with ' + w.others + ' — only one of them can ever be confirmed.';
        item.appendChild(warnLine);
      });
    }
    return { el: item, detOut: detOut };
  }

  // One set card: label, total and arm toggle in the header; the blue tx
  // subcards; the orange trigger subcards; the shared History (collapsed);
  // then the actions.
  function renderSetCard(set, overlapsByTx) {
    var members = setMembersOf(set);
    var st = setStatus(set);
    var settled = st.settled;
    var pending = st.pending;
    var row = document.createElement('div');
    row.className = 'tx-card tx-sub';
    var head = document.createElement('div');
    head.className = 'tx-head';
    var title = document.createElement('b');
    title.textContent = set.label || 'Untitled set';
    var pill = document.createElement('span');
    pill.className = 'pill ' + st.cls;
    pill.textContent = setPillText(set, st);
    head.appendChild(title); head.appendChild(pill);
    if (!settled && !pending) {
      var tog = document.createElement('label');
      tog.className = 'switch green';
      tog.title = set.enabled ? 'Armed — will broadcast at release' : 'Unarmed — will not broadcast at release';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!set.enabled;
      cb.addEventListener('change', function () { toggleSet(set.id, cb.checked); });
      var slider = document.createElement('span');
      slider.className = 'slider';
      tog.appendChild(cb); tog.appendChild(slider);
      head.appendChild(tog);
    }
    row.appendChild(head);
    var total = setTotalSats(set);
    var amount = document.createElement('div');
    amount.className = 'tx-amount';
    var btcAmt = document.createElement('span');
    btcAmt.textContent = fmtBtc(total) + ' BTC';
    var satsAmt = document.createElement('span');
    satsAmt.className = 'tx-amount-sats';
    satsAmt.textContent = fmtSats(total) + ' sats';
    amount.appendChild(btcAmt); amount.appendChild(satsAmt);
    row.appendChild(amount);
    var sub = document.createElement('p');
    sub.className = 'muted';
    sub.style.margin = '6px 0 0';
    var ruleCount = triggerSetOf(set).rules.length;
    sub.textContent = members.length + (members.length === 1 ? ' transaction' : ' transactions') + ' · ' + ruleCount + (ruleCount === 1 ? ' shared trigger' : ' shared triggers');
    row.appendChild(sub);
    // Tx subcards above the triggers; members carry no History (the set's
    // is the only one).
    members.forEach(function (tx, i) {
      var mst = txStatus(tx);
      var built = buildTxItem(tx, mst, 'set:' + set.id + ':' + tx.id, false, i, overlapsByTx);
      row.appendChild(built.el);
    });
    // The shared triggers, verbatim trigger subcards.
    var ruleEls = appendTriggerBoxes(row, set);
    // The set's one shared History: collapsed by default, its open state
    // kept under 'set:<id>'.
    var hist = set.history;
    if (Array.isArray(hist) && hist.length) {
      var histDet = document.createElement('details');
      histDet.className = 'tx-history';
      var setUi = txUiState['set:' + set.id] || {};
      histDet.open = setUi.historyOpen === true;
      histDet.addEventListener('toggle', function () {
        (txUiState['set:' + set.id] = txUiState['set:' + set.id] || {}).historyOpen = histDet.open;
      });
      var histSum = document.createElement('summary');
      histSum.textContent = 'History';
      histDet.appendChild(histSum);
      histDet.appendChild(buildHistoryList(hist));
      row.appendChild(histDet);
    }
    var actions = document.createElement('div');
    actions.className = 'tx-actions';
    var dryBtn = document.createElement('button');
    dryBtn.textContent = 'Dry-run';
    dryBtn.disabled = settled || pending;
    if (settled || pending) dryBtn.title = 'Set already broadcast or submitted';
    dryBtn.addEventListener('click', function () { dryRunSet(set.id); });
    var editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { startEditSet(set); });
    var delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', function () {
      var label = set.label || 'Untitled set';
      showConfirm('Delete this trigger set?',
        'This deletes "' + label + '" from Standby. Its ' + members.length + (members.length === 1 ? ' transaction returns' : ' transactions return') + ' to standalone — they are NOT deleted, and each keeps its own trigger. The set\'s shared history goes with it.' + (settled ? ' Transactions already broadcast cannot be recalled by deleting the set.' : ''),
        function () { deleteSet(set.id); },
        'Delete');
    });
    var bcBtn = document.createElement('button');
    bcBtn.textContent = 'Broadcast Now';
    bcBtn.className = 'danger';
    bcBtn.disabled = settled || pending;
    if (settled) bcBtn.title = 'Stale — inputs spent';
    else if (pending) bcBtn.title = 'Already broadcast or submitted';
    else bcBtn.addEventListener('click', function () { broadcastSetNow(set.id); });
    actions.appendChild(dryBtn); actions.appendChild(editBtn); actions.appendChild(delBtn); actions.appendChild(bcBtn);
    row.appendChild(actions);
    setCardEls[set.id] = { row: row, pill: pill, rules: ruleEls };
    return row;
  }

  // Secondary toggle in the heading row: off hides the URL box without
  // clearing it.
  function syncSecondaryEnabled() {
    var on = $('btc-secondary-enabled').checked;
    $('btc-secondary-fields').style.display = on ? '' : 'none';
    $('btc-secondary-enabled-wrap').title = on ? 'Secondary node on — used if the primary fails' : 'Secondary node off — primary only';
  }
  // RPC toggle per node: on shows the RPC fields instead of the mempool
  // URL. The password is never served; blank keeps the saved one.
  function syncRpc(slot) {
    var on = $('btc-' + slot + '-rpc').checked;
    $('btc-' + slot + '-url').style.display = on ? 'none' : '';
    $('btc-' + slot + '-rpc-fields').style.display = on ? '' : 'none';
  }
  function renderRpcFields(slot) {
    var r = S.settings[slot + 'Rpc'] || {};
    $('btc-' + slot + '-rpc').checked = r.enabled === true;
    $('btc-' + slot + '-rpc-url').value = r.url || '';
    $('btc-' + slot + '-rpc-user').value = r.user || '';
    $('btc-' + slot + '-rpc-password').value = '';
    $('btc-' + slot + '-rpc-password').placeholder = r.hasPassword ? 'Saved \u2014 leave blank to keep' : '';
    syncRpc(slot);
  }
  function rpcFieldsBody(slot) {
    return {
      enabled: $('btc-' + slot + '-rpc').checked,
      url: $('btc-' + slot + '-rpc-url').value,
      user: $('btc-' + slot + '-rpc-user').value,
      password: $('btc-' + slot + '-rpc-password').value,
    };
  }
  // The base each node slot uses (mempool URL or rpc://host:port), as the
  // test results name it.
  function nodeBase(slot, bases) {
    if (bases && bases[slot] !== undefined) return bases[slot];
    return slot === 'primary' ? S.settings.primaryApiUrl : S.settings.secondaryApiUrl;
  }
  function renderBitcoin() {
    $('btc-primary-url').value = S.settings.primaryApiUrl || 'https://mempool.space';
    $('btc-secondary-url').value = S.settings.secondaryApiUrl || '';
    renderRpcFields('primary');
    renderRpcFields('secondary');
    // Secondary on/off (missing means on): the toggle hides the other
    // settings without clearing them.
    $('btc-secondary-enabled').checked = S.settings.secondaryEnabled !== false;
    syncSecondaryEnabled();
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('btc-', 'primary', nodeBase('primary', S.bitcoin.nodeBases), conn);
    renderNodeStatus('btc-', 'secondary', nodeBase('secondary', S.bitcoin.nodeBases), conn);

    var txs = S.bitcoin.txs || [];
    var overlapsByTx = computeOverlaps();
    // Three lists: Staged (waiting), Pending (sent, unconfirmed) and
    // Archived (confirmed or stale).
    var activeList = $('btc-active-list');
    var pendingList = $('btc-pending-list');
    var archivedList = $('btc-archived-list');
    activeList.innerHTML = '';
    pendingList.innerHTML = '';
    archivedList.innerHTML = '';
    txCardEls = {};
    setCardEls = {};
    // Standalone txs and sets share the lists (a set takes its bucket from
    // its members), newest first; display order only.
    var memberIds = {};
    (S.bitcoin.sets || []).forEach(function (s) {
      (s.txIds || []).forEach(function (id) { memberIds[id] = true; });
    });
    function setBucket(s) {
      var sst = setStatus(s);
      return sst.settled ? 2 : (sst.pending ? 1 : 0);
    }
    function bucketRank(t) {
      var st = txStatus(t);
      return st.settled ? 2 : (st.pending ? 1 : 0);
    }
    var items = txs.filter(function (t) { return !memberIds[t.id]; }).map(function (t) {
      return { kind: 'tx', tx: t, at: t.createdAt || '' };
    }).concat((S.bitcoin.sets || []).map(function (s) {
      return { kind: 'set', set: s, at: s.createdAt || '' };
    }));
    var sorted = items.sort(function (a, b) {
      var ba = a.kind === 'tx' ? bucketRank(a.tx) : setBucket(a.set);
      var bb = b.kind === 'tx' ? bucketRank(b.tx) : setBucket(b.set);
      if (ba !== bb) return ba - bb;
      return (b.at < a.at) ? -1 : (b.at > a.at) ? 1 : 0;
    });
    sorted.forEach(function (item) {
      if (item.kind === 'set') {
        var setRow = renderSetCard(item.set, overlapsByTx);
        var sst = setStatus(item.set);
        (sst.settled ? archivedList : (sst.pending ? pendingList : activeList)).appendChild(setRow);
        return;
      }
      var tx = item.tx;
      var row = document.createElement('div');
      // A standalone tx renders as a set of one.
      row.className = 'tx-card tx-sub';
      var st = txStatus(tx);
      var settled = st.settled;
      var pending = st.pending;
      // Element refs for the live tick to patch.
      var ruleEls = []; // per rule: { pillEl, condEl, nowEl }
      var feeVerdictEl = null; // the " — Low Risk" suffix span, when rendered
      var maraEl = null; // the Slipstream queue line, when rendered
      var fallbackValueEl = null; // the Public Fallback value span, when rendered
      var sentLine = null; // the sent/broadcast line inside Details, when rendered
      // Card header: label, status pill, and on an active card the arm
      // toggle beside it. Pending and settled cards have no toggle.
      var head = document.createElement('div');
      head.className = 'tx-head';
      var title = document.createElement('b');
      title.textContent = txDisplayName(tx);
      var pill = document.createElement('span');
      // A warned-about Ready tx gets an amber pill: still ready, but a
      // shared input means only one can confirm. Other warning states are
      // amber already.
      var pillCls = st.cls;
      if (pillCls === 'ok' && overlapsByTx[tx.id] && overlapsByTx[tx.id].length) pillCls = 'warn';
      pill.className = 'pill ' + pillCls;
      pill.textContent = txPillText(tx, st);
      head.appendChild(title); head.appendChild(pill);
      if (!settled && !pending) {
        var tog = document.createElement('label');
        tog.className = 'switch green';
        tog.title = tx.enabled ? 'Armed — will broadcast at release' : 'Unarmed — will not broadcast at release';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!tx.enabled;
        cb.addEventListener('change', function () { toggleTx(tx.id, cb.checked); });
        var slider = document.createElement('span');
        slider.className = 'slider';
        tog.appendChild(cb); tog.appendChild(slider);
        head.appendChild(tog);
      }
      row.appendChild(head);
      // The amount, prominent below the header: the BTC figure
      // large, the sats beside it smaller.
      var amount = document.createElement('div');
      amount.className = 'tx-amount';
      var btcAmt = document.createElement('span');
      btcAmt.textContent = fmtBtc(tx.totalOutSats) + ' BTC';
      var satsAmt = document.createElement('span');
      satsAmt.className = 'tx-amount-sats';
      satsAmt.textContent = fmtSats(tx.totalOutSats) + ' sats';
      amount.appendChild(btcAmt); amount.appendChild(satsAmt);
      row.appendChild(amount);
      // The sub-line, like a set card's: one transaction, N
      // triggers — the card is a trigger set of one.
      var sub = document.createElement('p');
      sub.className = 'muted';
      sub.style.margin = '6px 0 0';
      var ruleCount = triggerSetOf(tx).rules.length;
      sub.textContent = '1 transaction · ' + ruleCount + (ruleCount === 1 ? ' trigger' : ' triggers');
      row.appendChild(sub);
      // The tx subcard, with this tx's Details, History, dry-run line and
      // warnings inside.
      var built = buildTxItem(tx, st, tx.id, true, 0, overlapsByTx);
      row.appendChild(built.el);
      var detOut = built.detOut;
      feeVerdictEl = detOut.feeVerdictEl; maraEl = detOut.maraEl; fallbackValueEl = detOut.fallbackValueEl; sentLine = detOut.sentLine;
      // Trigger subcards on every card (the rule is the tx's identity even
      // after it is sent): exactly three lines each, the type with its
      // per-rule pill, the condition, and the current value, from the
      // server's triggerStatus. A multi-rule set adds the ANY/ALL line and
      // numbers its rules.
      ruleEls = appendTriggerBoxes(row, tx);
      var actions = document.createElement('div');
      actions.className = 'tx-actions';
      var dryBtn = document.createElement('button');
      dryBtn.textContent = 'Dry-run';
      dryBtn.disabled = settled || pending;
      if (settled || pending) dryBtn.title = 'Transaction already broadcast or submitted';
      dryBtn.addEventListener('click', function () { dryRunTx(tx.id); });
      // Edit stays available on pending and archived cards, but only for
      // label and notes (the server enforces this).
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { startEdit(tx); });
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', function () {
        // The delete confirm says what deleting does: for an active tx it
        // stops a future broadcast; a tx already sent cannot be recalled,
        // and only Standby's record goes.
        var label = txDisplayName(tx);
        var delBody;
        if (tx.release && tx.release.status === 'submitted-slipstream') {
          delBody = 'This deletes "' + label + '" from Standby. It has already been submitted to MARA Slipstream and is waiting to be mined — deleting it here does NOT cancel or recall it, and MARA can still mine it. Its history on this card goes with it.';
        } else if (tx.broadcasted) {
          var conf = tx.broadcasted.confirmations;
          if (tx.broadcasted.found === false) {
            delBody = 'This deletes "' + label + '" from Standby. It was already broadcast, but the network no longer reports it — deleting it here only removes it from Standby; it does not undo the broadcast. Its history on this card goes with it.';
          } else if ((typeof conf === 'number' && conf > 0) || tx.broadcasted.blockHeight != null) {
            delBody = 'This deletes "' + label + '" from Standby. It has already been broadcast and confirmed on the network — deleting it here does NOT undo the broadcast. Its history on this card goes with it.';
          } else {
            delBody = 'This deletes "' + label + '" from Standby. It is already in the public mempool waiting for its first confirmation — deleting it here does NOT stop or recall it, and it can still confirm on the network. Its history on this card goes with it.';
          }
        } else if (st.label === 'Stale') {
          delBody = 'This deletes "' + label + '" from Standby. Its inputs were spent, so it will never broadcast — deleting it here only removes the record from Standby. Its history on this card goes with it.';
        } else if (st.label === 'Broadcasted') {
          // A restored broadcast record without the fact: broadcast,
          // confirmation unknown.
          delBody = 'This deletes "' + label + '" from Standby. It has already been broadcast — deleting it here only removes it from Standby; it does not undo the broadcast. Its history on this card goes with it.';
        } else {
          delBody = 'This deletes "' + label + '" from Standby. It will no longer be broadcast if the release runs, and its history on this card goes with it.';
        }
        showConfirm('Delete this transaction?',
          delBody,
          function () { deleteTx(tx.id); },
          'Delete');
      });
      // Broadcast Now: send this tx now, after a confirm, through the
      // release path. Not offered once sent, stale, or waiting on MARA.
      var bcBtn = document.createElement('button');
      bcBtn.textContent = 'Broadcast Now';
      bcBtn.className = 'danger';
      var waitingMara = !!(tx.release && tx.release.status === 'submitted-slipstream');
      bcBtn.disabled = settled || pending || waitingMara;
      if (tx.broadcasted) bcBtn.title = 'Already broadcast';
      else if (waitingMara) bcBtn.title = 'Already submitted to Slipstream — waiting on MARA';
      else if (settled) bcBtn.title = 'Stale — inputs spent';
      else bcBtn.addEventListener('click', function () { broadcastNow(tx.id); });
      actions.appendChild(dryBtn); actions.appendChild(editBtn); actions.appendChild(delBtn); actions.appendChild(bcBtn);
      // Broadcast a Slipstream-pending tx publicly, by hand only, after a
      // confirm naming the privacy cost.
      if (waitingMara) {
        var pubBtn = document.createElement('button');
        pubBtn.textContent = 'Broadcast publicly';
        pubBtn.className = 'danger';
        pubBtn.addEventListener('click', function () { broadcastPublic(tx.id); });
        actions.appendChild(pubBtn);
      }
      row.appendChild(actions);
      txCardEls[tx.id] = { row: row, sentLine: sentLine, pill: pill, rules: ruleEls, feeVerdictEl: feeVerdictEl, maraEl: maraEl, fallbackValueEl: fallbackValueEl };
      (settled ? archivedList : (pending ? pendingList : activeList)).appendChild(row);
    });
    // Empty lists say so, except the staged list (its Add button is the
    // prompt).
    if (!pendingList.children.length) {
      var nonePending = document.createElement('p');
      nonePending.className = 'muted';
      nonePending.textContent = 'No pending transactions yet.';
      pendingList.appendChild(nonePending);
    }
    if (!archivedList.children.length) {
      var noneArchived = document.createElement('p');
      noneArchived.className = 'muted';
      noneArchived.textContent = 'No archived transactions yet.';
      archivedList.appendChild(noneArchived);
    }
  }

  async function toggleTx(id, enabled) {
    function doToggle() {
      return (async function () {
        try {
          var r = await api('PUT', '/api/bitcoin/txs/' + encodeURIComponent(id), { enabled: enabled });
          setMsg($('btc-msg'), enabled
            ? 'Transaction armed.' + (r && r.checkinReset ? ' Your check-in was reset to today.' : '')
            : 'Transaction unarmed.', true);
          await load();
        } catch (e) { setMsg($('btc-msg'), e.message, false); await load(); }
      })();
    }
    // Arming a check-in rule inside its danger zone (its own threshold)
    // could fire the release soon after, so confirm first. The server
    // resets the check-in anyway; other rule types never warn.
    var armTx = (S.bitcoin.txs || []).find(function (t) { return t.id === id; });
    var armTh = (enabled && armTx) ? minCheckinThreshold(armTx) : null;
    var dz = (armTh !== null) ? dangerZone(armTh, liveOffsetMs(armTx)) : null;
    if (dz) {
      showConfirm('Reset your check-in?',
        dz.overdue
          ? 'The release is due — your last check-in was ' + dz.daysSince + ' day' + (dz.daysSince === 1 ? '' : 's') + ' ago. Arming this transaction will broadcast it on the next check. Arming will reset your check-in to today and restart the countdown.'
          : 'Only ' + dz.daysLeft + ' day' + (dz.daysLeft === 1 ? '' : 's') + ' left until the release is due. Arming will reset your check-in to today and restart the countdown.',
        doToggle, 'Arm and reset', function () { load(); });
    } else {
      doToggle();
    }
  }

  // Arming a set: the set's toggle is its members' only arm. Same danger-
  // zone confirm as a tx, against the set's own rules and offset.
  async function toggleSet(id, enabled) {
    function doToggle() {
      return (async function () {
        try {
          var r = await api('PUT', '/api/bitcoin/sets/' + encodeURIComponent(id), { enabled: enabled });
          setMsg($('btc-msg'), enabled
            ? 'Trigger set armed.' + (r && r.checkinReset ? ' Your check-in was reset to today.' : '')
            : 'Trigger set unarmed.', true);
          await load();
        } catch (e) { setMsg($('btc-msg'), e.message, false); await load(); }
      })();
    }
    var armSet = (S.bitcoin.sets || []).find(function (s) { return s.id === id; });
    var armTh = (enabled && armSet) ? minCheckinThreshold(armSet) : null;
    var dz = (armTh !== null) ? dangerZone(armTh, liveOffsetMs(armSet)) : null;
    if (dz) {
      showConfirm('Reset your check-in?',
        dz.overdue
          ? 'The release is due — your last check-in was ' + dz.daysSince + ' day' + (dz.daysSince === 1 ? '' : 's') + ' ago. Arming this trigger set will broadcast its transactions on the next check. Arming will reset your check-in to today and restart the countdown.'
          : 'Only ' + dz.daysLeft + ' day' + (dz.daysLeft === 1 ? '' : 's') + ' left until the release is due. Arming will reset your check-in to today and restart the countdown.',
        doToggle, 'Arm and reset', function () { load(); });
    } else {
      doToggle();
    }
  }

  // Ids of txs not active (pending or archived), to see which ones a dry
  // run just moved.
  function inactiveIds() {
    var ids = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      var st = txStatus(t);
      if (st.settled || st.pending) ids[t.id] = true;
    });
    return ids;
  }
  // After a dry run, list the txs that just left Active and why (inputs
  // spent, or already out there), naming and opening the card each landed
  // in (Pending or Archived). Nothing moved, no pop-up.
  function noticeMovedToArchive(before, moved, why) {
    var fresh = (moved || []).filter(function (m) { return !before[m.id]; });
    if (!fresh.length) return;
    // why 'broadcast': the dry run found the tx already out, so the
    // wording must not say spent.
    var broadcast = why === 'broadcast';
    var pend = [], arch = [];
    fresh.forEach(function (m) {
      var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === m.id; });
      var st = tx ? txStatus(tx) : null;
      if (st && st.pending) pend.push(m);
      else arch.push(m);
    });
    if (!pend.length && !arch.length) return;
    var pendingCard = $('pending-card');
    if (pendingCard && pend.length) pendingCard.open = true;
    var archived = $('archived-card');
    if (archived && arch.length) archived.open = true;
    var title = pend.length && arch.length ? 'Transactions moved'
      : pend.length ? 'Moved to Pending Transactions'
      : 'Moved to Archived Transactions';
    var parts = [];
    if (pend.length) parts.push(pend.length + ' transaction' + (pend.length === 1 ? '' : 's') + ' moved to Pending Transactions — ' + (broadcast
      ? 'already out there (the node knows its txid), so recorded as broadcast, waiting for its first confirmation.'
      : (pend.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    if (arch.length) parts.push(arch.length + ' transaction' + (arch.length === 1 ? '' : 's') + ' moved to Archived Transactions — ' + (broadcast
      ? 'already out there (the node knows its txid), so recorded as broadcast.'
      : (arch.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    showDetails(title, parts.join(' '),
      '<ul class="plain-list">' + fresh.map(function (m) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === m.id; });
        var dest = tx && txStatus(tx).pending ? 'pending' : 'archived';
        // Named via txDisplayName.
        var name = tx ? txDisplayName(tx) : (m.label || '');
        return '<li>' + escapeHtml(name) + ' — ' + (broadcast ? 'already broadcast' : 'inputs spent') + ' (' + dest + ')</li>';
      }).join('') + '</ul>');
  }

  async function dryRunTx(id) {
    var before = inactiveIds();
    try {
      var r = await api('POST', '/api/broadcast/test', { id: id });
      var one = (r.results || [])[0] || {};
      dryRunResults[id] = { text: 'Dry-run: ' + (one.note || one.error || r.note || ''), ok: !!one.wouldBroadcast,
        verdict: one.verdict || '',
        spent: !!(one.spent && one.spent.length), unknown: !!(one.unknown && one.unknown.length), error: !!one.error };
      await load();
      if (one.spent && one.spent.length) {
        noticeMovedToArchive(before, [{ id: id, label: one.label || '' }]);
      } else if (one.verdict === 'broadcast') {
        // Found already out and moved to Archived: broadcast wording, not
        // spent.
        noticeMovedToArchive(before, [{ id: id, label: one.label || '' }], 'broadcast');
      }
    } catch (e) {
      dryRunResults[id] = { text: 'Dry-run failed: ' + e.message, ok: false, error: true };
      await load();
    }
  }

  // Dry-run a set: every member is checked and marked on its own; the
  // notice names each member that left Active.
  async function dryRunSet(id) {
    var set = (S.bitcoin.sets || []).find(function (s) { return s.id === id; });
    if (!set) return;
    var before = inactiveIds();
    try {
      var r = await api('POST', '/api/broadcast/test', { setId: id });
      (r.results || []).forEach(function (one) {
        if (one.id) dryRunResults[one.id] = { text: 'Dry-run: ' + (one.note || one.error || r.note || ''), ok: !!one.wouldBroadcast,
          verdict: one.verdict || '',
          spent: !!(one.spent && one.spent.length), unknown: !!(one.unknown && one.unknown.length), error: !!one.error };
      });
      await load();
      var moved = (r.results || []).filter(function (one) { return one.spent && one.spent.length; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, moved);
      var movedOut = (r.results || []).filter(function (one) { return one.verdict === 'broadcast'; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, movedOut, 'broadcast');
    } catch (e) {
      setMembersOf(set).forEach(function (t) {
        dryRunResults[t.id] = { text: 'Dry-run failed: ' + e.message, ok: false, error: true };
      });
      await load();
    }
  }

  // Locked once out the door (broadcast or waiting on MARA): only label
  // and notes can change.
  function isTxLocked(tx) {
    var st = txStatus(tx);
    return st.settled || st.pending;
  }

  // Edit happens in a popup (no scrolling to a form on a phone); editingId
  // alone says an edit is open.
  function startEdit(tx) {
    editingId = tx.id;
    editOriginalRemoved = false;
    $('edit-label').value = tx.label || '';
    $('edit-notes').value = tx.notes || '';
    $('edit-hex').value = tx.hex || '';
    // The route selector follows the transaction being edited, so
    // saving keeps its route unless the owner changes it.
    $('edit-route').value = tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public';
    // The fallback select follows the route: shown for active and pending
    // Slipstream txs only. A pending tx keeps its hex and route locked;
    // label, notes and fallback can change.
    $('edit-fallback').value = (tx.publicFallbackDays === null || tx.publicFallbackDays === undefined) ? '' : String(tx.publicFallbackDays);
    var stEdit = txStatus(tx);
    $('edit-fallback-row').style.display = (!stEdit.settled && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // The fallback deadline warning shows only in the Edit popup of a
    // pending tx (the deadline is already running).
    $('edit-fallback-note').style.display = (stEdit.pending && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // The rule list follows the tx being edited; a locked tx's rules are
    // disabled (they have fired).
    resetRuleList('edit', triggerSetOf(tx));
    // A locked tx (pending or archived) can change only label and notes;
    // hex, route and import are disabled.
    var locked = isTxLocked(tx);
    editLockedTx = locked;
    $('edit-hex').title = locked ? 'The transaction hex cannot be changed once it has been broadcast' : '';
    $('edit-route').title = locked ? 'The broadcast route is locked once the transaction is out the door' : '';
    // The trigger is locked with the hex and route (it has fired).
    setRuleListLocked('edit', locked);
    $('edit-locked-note').style.display = locked ? '' : 'none';
    $('edit-form-title').textContent = !locked ? 'Edit trigger set'
      : stEdit.settled ? 'Edit trigger set — label and notes only'
      : 'Edit trigger set — label, notes and fallback only';
    // A fresh Transactions section: earlier appended entries are gone;
    // remove/add follow the lock.
    var newList = $('edit-new-txs-list');
    if (newList) newList.innerHTML = '';
    syncEditOriginalEntry();
    syncEditNewTxEntries();
    $('edit-msg').textContent = '';
    $('edit-modal').classList.add('open');
    $('edit-label').focus();
  }

  function cancelEdit() {
    editingId = null;
    editOriginalRemoved = false;
    editLockedTx = false;
    $('edit-label').value = '';
    $('edit-notes').value = '';
    $('edit-hex').value = '';
    $('edit-route').value = 'public';
    $('edit-fallback').value = '';
    $('edit-fallback-row').style.display = 'none';
    $('edit-fallback-note').style.display = 'none';
    // Reset the rule list to one default check-in rule.
    resetRuleList('edit');
    var newList = $('edit-new-txs-list');
    if (newList) newList.innerHTML = '';
    // Re-enable the fields a locked edit disabled.
    $('edit-hex').title = '';
    $('edit-route').title = '';
    setRuleListLocked('edit', false);
    $('edit-locked-note').style.display = 'none';
    syncEditOriginalEntry();
    $('edit-form-title').textContent = 'Edit trigger set';
    $('edit-msg').textContent = '';
    $('edit-modal').classList.remove('open');
  }

  // Edit state: whether the original was removed from the card (it stays
  // standalone) and whether it is locked.
  var editOriginalRemoved = false;
  var editLockedTx = false;

  // New entries in the edit popup, numbered after the original (from 1 if
  // it was removed).
  function buildEditNewTxEntry() {
    return buildTxEntry({
      entryCls: 'edit-new-tx-entry', notesCls: 'edit-new-tx-notes', hexCls: 'edit-new-tx-hex',
      importCls: 'edit-new-tx-import', removeCls: 'edit-new-tx-remove',
      msgId: 'edit-msg', onRemove: removeEditNewTxEntry, onHexInput: syncEditRemoveButtons
    });
  }
  function editNewTxEntrySets() {
    return txEntrySets($('edit-new-txs-list'), 'edit-new-tx-entry', 'edit-new-tx-notes', 'edit-new-tx-hex');
  }
  function syncEditNewTxEntries() {
    var base = editOriginalRemoved ? 0 : 1;
    editNewTxEntrySets().forEach(function (s, i) {
      if (s.titleEl) s.titleEl.textContent = 'Transaction ' + (base + i + 1);
    });
    syncEditRemoveButtons();
  }
  // Members the save would keep: the original (unless removed) plus filled
  // new entries.
  function editRemainingMembers() {
    return (editOriginalRemoved ? 0 : 1) + collectNewTxEntries(editNewTxEntrySets()).filled.length;
  }
  function removeEditNewTxEntry(entry) {
    var f = txEntryFields(entry, 'edit-new-tx-notes', 'edit-new-tx-hex');
    if (f.hex && f.hex.value.trim() && editRemainingMembers() <= 1) {
      setMsg($('edit-msg'), 'This is the last transaction — use Delete to remove the whole card.', false);
      return;
    }
    var list = $('edit-new-txs-list');
    if (list) list.removeChild(entry);
    syncEditNewTxEntries();
  }
  // Remove buttons follow the click guards: the save must keep at least
  // one member.
  function syncEditRemoveButtons() {
    var remaining = editRemainingMembers();
    var origRm = $('btn-edit-remove-tx');
    if (origRm) origRm.disabled = editLockedTx || (!editOriginalRemoved && remaining <= 1);
    editNewTxEntrySets().forEach(function (s) {
      var isFilled = !!(s.fields.hex && s.fields.hex.value.trim());
      if (s.removeBtn) s.removeBtn.disabled = isFilled && remaining <= 1;
    });
  }
  // Removing the original dims it and turns its button into Undo; it only
  // applies on save.
  function syncEditOriginalEntry() {
    var entry = $('edit-member-entry');
    if (entry) {
      if (editOriginalRemoved) entry.classList.add('tx-entry-removed');
      else entry.classList.remove('tx-entry-removed');
    }
    $('edit-notes').disabled = editOriginalRemoved;
    $('edit-hex').disabled = editLockedTx || editOriginalRemoved;
    $('edit-route').disabled = editLockedTx;
    $('btn-edit-import-file').disabled = editLockedTx || editOriginalRemoved;
    var rm = $('btn-edit-remove-tx');
    if (rm) {
      rm.textContent = editOriginalRemoved ? '\u21a9 Undo' : '\u00d7 Remove';
      rm.disabled = editLockedTx || (!editOriginalRemoved && editRemainingMembers() <= 1);
    }
    var addBtn = $('btn-edit-add-tx');
    if (addBtn) addBtn.disabled = editLockedTx;
  }
  function toggleEditOriginalRemoved() {
    if (editLockedTx) {
      setMsg($('edit-msg'), 'This transaction has already been broadcast — it can only change its label and notes.', false);
      return;
    }
    if (!editOriginalRemoved && editRemainingMembers() <= 1) {
      setMsg($('edit-msg'), 'This is the last transaction — use Delete to remove the whole card.', false);
      return;
    }
    editOriginalRemoved = !editOriginalRemoved;
    syncEditOriginalEntry();
    syncEditNewTxEntries();
  }

  // ---------- trigger sets ----------
  // editingSetId says a set edit is open (like editingId).
  var editingSetId = null;
  // The set popup's working member list; removals are applied on save and
  // discarded on cancel.
  var setEditMembers = [];

  // The set popup's arm switch; its text follows the switch.
  function syncSetEnabledText() {
    var on = $('set-enabled').checked;
    $('set-enabled-text').textContent = on ? 'Armed' : 'Unarmed';
    $('set-enabled-wrap').title = on ? 'Armed — will broadcast at release' : 'Unarmed — will not broadcast at release';
  }

  function startEditSet(set) {
    editingSetId = set.id;
    $('set-form-title').textContent = 'Edit trigger set';
    $('set-label').value = set.label || '';
    $('set-enabled').checked = set.enabled !== false;
    syncSetEnabledText();
    // The set popup lists the current members (each removable: removed
    // members return to standalone on save) and can append new entries.
    setEditMembers = setMembersOf(set).slice();
    renderSetMembers();
    var newList = $('set-new-txs-list');
    if (newList) newList.innerHTML = '';
    resetRuleList('set', triggerSetOf(set));
    $('set-msg').textContent = '';
    $('set-modal').classList.add('open');
    $('set-label').focus();
  }

  // New entries in the set popup, numbered after the members, held by
  // reference like addTxEntrySets.
  function setNewTxEntryFields(entry) {
    return txEntryFields(entry, 'set-new-tx-notes', 'set-new-tx-hex');
  }
  function setNewTxEntrySets() {
    return txEntrySets($('set-new-txs-list'), 'set-new-tx-entry', 'set-new-tx-notes', 'set-new-tx-hex');
  }
  function syncSetNewTxEntries() {
    var base = setEditMembers.length;
    setNewTxEntrySets().forEach(function (s, i) {
      if (s.titleEl) s.titleEl.textContent = 'Transaction ' + (base + i + 1);
    });
    syncSetRemoveButtons();
  }
  function buildSetNewTxEntry() {
    return buildTxEntry({
      entryCls: 'set-new-tx-entry', notesCls: 'set-new-tx-notes', hexCls: 'set-new-tx-hex',
      importCls: 'set-new-tx-import', removeCls: 'set-new-tx-remove',
      msgId: 'set-msg', onRemove: removeSetNewTxEntry, onHexInput: syncSetRemoveButtons
    });
  }
  function removeSetNewTxEntry(entry) {
    var f = setNewTxEntryFields(entry);
    if (f.hex && f.hex.value.trim() && setEditMembers.length + collectNewTxEntries(setNewTxEntrySets()).filled.length <= 1) {
      setMsg($('set-msg'), 'This is the last transaction in the set — use Delete to remove the whole set.', false);
      return;
    }
    var list = $('set-new-txs-list');
    if (list) list.removeChild(entry);
    syncSetNewTxEntries();
  }

  // Member lines (number, txid, amount, notes, remove), rendered from
  // setEditMembers so removals renumber at once.
  function renderSetMembers() {
    var membersEl = $('set-members-list');
    if (!membersEl) return;
    membersEl.innerHTML = '';
    setEditMembers.forEach(function (t, i) {
      var line = document.createElement('p');
      line.className = 'muted';
      line.style.margin = '6px 0 0';
      var span = document.createElement('span');
      span.textContent = 'Tx ' + (i + 1) + ' — ' + t.txid.slice(0, 16) + '… · ' + fmtBtc(t.totalOutSats) + ' BTC' + (t.notes ? ' — ' + t.notes : '');
      line.appendChild(span);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rule-remove set-member-remove';
      rm.textContent = '\u00d7 Remove';
      rm.addEventListener('click', function () { removeSetMember(t.id); });
      line.appendChild(rm);
      membersEl.appendChild(line);
    });
    syncSetRemoveButtons();
  }
  function removeSetMember(id) {
    // The last remaining member cannot go — the card would
    // have no transaction left. Delete removes the whole card.
    var remaining = setEditMembers.length - 1 + collectNewTxEntries(setNewTxEntrySets()).filled.length;
    if (remaining <= 0) {
      setMsg($('set-msg'), 'This is the last transaction in the set — use Delete to remove the whole set.', false);
      return;
    }
    setEditMembers = setEditMembers.filter(function (t) { return t.id !== id; });
    renderSetMembers();
    syncSetNewTxEntries();
  }
  // Remove buttons follow the click guards (at least one member must
  // remain); the handlers re-check.
  function syncSetRemoveButtons() {
    var filled = collectNewTxEntries(setNewTxEntrySets()).filled.length;
    var membersEl = $('set-members-list');
    if (membersEl) {
      Array.prototype.forEach.call(membersEl.children || [], function (line) {
        Array.prototype.forEach.call(line.children || [], function (c) {
          if ((c.className || '').split(' ').indexOf('set-member-remove') !== -1) {
            c.disabled = setEditMembers.length <= 1 && filled === 0;
          }
        });
      });
    }
    var remaining = setEditMembers.length + filled;
    setNewTxEntrySets().forEach(function (s) {
      var isFilled = !!(s.fields.hex && s.fields.hex.value.trim());
      if (s.removeBtn) s.removeBtn.disabled = isFilled && remaining <= 1;
    });
  }

  function cancelSet() {
    editingSetId = null;
    setEditMembers = [];
    $('set-label').value = '';
    $('set-enabled').checked = true;
    syncSetEnabledText();
    var membersEl = $('set-members-list');
    if (membersEl) membersEl.innerHTML = '';
    var newList = $('set-new-txs-list');
    if (newList) newList.innerHTML = '';
    resetRuleList('set');
    $('set-msg').textContent = '';
    $('set-modal').classList.remove('open');
  }

  // The set popup closes with Cancel, the X or the backdrop (guarded).
  var btnSetCancel = $('btn-set-cancel');
  if (btnSetCancel) btnSetCancel.addEventListener('click', function () { cancelSet(); });
  var setEnabledCb = $('set-enabled');
  if (setEnabledCb) setEnabledCb.addEventListener('change', function () { syncSetEnabledText(); });
  // "+ Add transaction" in the set popup (guarded).
  var btnSetAddTx = $('btn-set-add-tx');
  if (btnSetAddTx) btnSetAddTx.addEventListener('click', function () {
    var list = $('set-new-txs-list');
    if (!list) return;
    var entry = buildSetNewTxEntry();
    list.appendChild(entry);
    syncSetNewTxEntries();
    var f = setNewTxEntryFields(entry);
    if (f.hex && f.hex.focus) f.hex.focus();
  });
  // The same add/remove pair in the edit popup.
  var btnEditAddTx = $('btn-edit-add-tx');
  if (btnEditAddTx) btnEditAddTx.addEventListener('click', function () {
    var list = $('edit-new-txs-list');
    if (!list) return;
    var entry = buildEditNewTxEntry();
    list.appendChild(entry);
    syncEditNewTxEntries();
    var f = txEntryFields(entry, 'edit-new-tx-notes', 'edit-new-tx-hex');
    if (f.hex && f.hex.focus) f.hex.focus();
  });
  var btnEditRemoveTx = $('btn-edit-remove-tx');
  if (btnEditRemoveTx) btnEditRemoveTx.addEventListener('click', function () { toggleEditOriginalRemoved(); });

  // The edit popup closes with Cancel, the X or the backdrop (guarded).
  $('btn-edit-cancel').addEventListener('click', function () { cancelEdit(); });
  // The edit popup's fallback row shows only while the route is
  // Slipstream.
  $('edit-route').addEventListener('change', function () {
    $('edit-fallback-row').style.display = $('edit-route').value === 'slipstream' ? '' : 'none';
  });
  // Rule lists: the Add and Edit forms carry a list of rule panels plus
  // how they combine. Panels are built in JS and held by reference, never
  // re-queried by id.
  var MAX_RULES_PER_TX = 5;
  var TRIGGER_TYPE_OPTIONS = [
    { value: 'checkin', label: 'Check-in — fire after days of silence' },
    { value: 'price', label: 'BTC price' },
    { value: 'utxo', label: 'UTXO moved' },
    { value: 'blockheight', label: 'Block height' },
    { value: 'setdate', label: 'Set date' },
    { value: 'feemarket', label: 'Fee market' },
    { value: 'manual', label: 'Manual only — no trigger' },
  ];
  var ruleLists = { btc: { op: 'OR', panels: [], nextIdx: 0 }, edit: { op: 'OR', panels: [], nextIdx: 0 }, set: { op: 'OR', panels: [], nextIdx: 0 } };
  function mkEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function mkOption(value, label, selected) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (selected) o.selected = true;
    return o;
  }
  function fieldLabel(forId, text) {
    var l = document.createElement('label');
    l.htmlFor = forId;
    l.textContent = text;
    return l;
  }
  function inlineUnit(children) {
    var d = mkEl('div', 'inline-unit');
    children.forEach(function (c) { d.appendChild(c); });
    return d;
  }
  // One rule panel: the trigger picker and every type's param rows (ids
  // like btc-rule-0-trigger so labels resolve; the code uses the returned
  // references).
  function buildRulePanel(prefix, idx, rule) {
    var pfx = prefix + '-rule-' + idx;
    var panel = { root: null, titleEl: null, typeSel: null, rows: {}, f: {}, removeBtn: null, prefix: prefix };
    var root = mkEl('div', 'rule');
    root.id = pfx;
    panel.root = root;
    var head = mkEl('div', 'rule-head');
    var title = mkEl('b', null, 'Rule ' + (idx + 1));
    panel.titleEl = title;
    head.appendChild(title);
    var rm = mkEl('button', 'rule-remove', '\u00d7 Remove');
    rm.type = 'button';
    rm.addEventListener('click', function () { removeRulePanel(prefix, panel); });
    panel.removeBtn = rm;
    head.appendChild(rm);
    root.appendChild(head);
    var lab = fieldLabel(pfx + '-trigger', 'Trigger');
    root.appendChild(lab);
    var sel = document.createElement('select');
    sel.id = pfx + '-trigger';
    TRIGGER_TYPE_OPTIONS.forEach(function (o) { sel.appendChild(mkOption(o.value, o.label, o.value === rule.type)); });
    sel.value = rule.type;
    sel.addEventListener('change', function () { syncRulePanel(panel); syncRuleTypeOptions(panel.prefix); });
    panel.typeSel = sel;
    root.appendChild(sel);
    // Check-in row.
    var rCheckin = mkEl('div');
    rCheckin.id = pfx + '-trigger-checkin-row';
    rCheckin.appendChild(fieldLabel(pfx + '-threshold', 'Days of silence'));
    var th = document.createElement('input');
    th.type = 'number'; th.id = pfx + '-threshold'; th.min = '1'; th.max = '3650'; th.value = '35';
    rCheckin.appendChild(inlineUnit([th, mkEl('span', null, 'days')]));
    panel.f.threshold = th;
    panel.rows.checkin = rCheckin;
    root.appendChild(rCheckin);
    // Price row.
    var rPrice = mkEl('div');
    rPrice.id = pfx + '-trigger-price-row';
    rPrice.appendChild(fieldLabel(pfx + '-value', 'BTC price'));
    var opSel = document.createElement('select');
    opSel.id = pfx + '-op'; opSel.style.flex = '0 0 auto';
    opSel.appendChild(mkOption('>=', '\u2265', true));
    opSel.appendChild(mkOption('<=', '\u2264', false));
    opSel.value = '>=';
    var val = document.createElement('input');
    val.type = 'number'; val.id = pfx + '-value'; val.min = '1'; val.step = 'any'; val.placeholder = '150000';
    rPrice.appendChild(inlineUnit([opSel, mkEl('span', null, '$'), val]));
    var priceNote = mkEl('p', 'guard-note', 'Guard: the two price sources must agree within your price-agreement setting \u2014 the primary price source decides.');
    priceNote.id = pfx + '-trigger-price-note';
    rPrice.appendChild(priceNote);
    panel.f.op = opSel; panel.f.value = val; panel.f.priceNote = priceNote;
    panel.rows.price = rPrice;
    root.appendChild(rPrice);
    // UTXO row.
    var rUtxo = mkEl('div');
    rUtxo.id = pfx + '-trigger-utxo-row';
    rUtxo.appendChild(fieldLabel(pfx + '-outpoint', 'UTXO (txid:vout)'));
    var out = document.createElement('input');
    out.type = 'text'; out.id = pfx + '-outpoint'; out.placeholder = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:0'; out.spellcheck = false;
    rUtxo.appendChild(out);
    rUtxo.appendChild(fieldLabel(pfx + '-utxo-mode', 'Fire on'));
    var mode = document.createElement('select');
    mode.id = pfx + '-utxo-mode';
    mode.appendChild(mkOption('confirmed', 'Confirmed \u2014 N confirmations', true));
    mode.appendChild(mkOption('unconfirmed', 'Unconfirmed (in mempool)', false));
    mode.value = 'confirmed';
    mode.addEventListener('change', function () { syncRuleUtxoNote(panel); });
    rUtxo.appendChild(mode);
    var confsRow = mkEl('div');
    confsRow.id = pfx + '-trigger-utxo-confs-row';
    confsRow.appendChild(fieldLabel(pfx + '-utxo-confs', 'Fire after'));
    var confs = document.createElement('input');
    confs.type = 'number'; confs.id = pfx + '-utxo-confs'; confs.min = '1'; confs.max = '100'; confs.value = '1';
    confs.addEventListener('input', function () { syncRuleUtxoNote(panel); });
    confsRow.appendChild(inlineUnit([confs, mkEl('span', null, 'confirmations')]));
    rUtxo.appendChild(confsRow);
    var utxoNote = mkEl('p', 'guard-note', 'Guard: only a confirmed spend fires \u2014 an unconfirmed (mempool) spend only watches until it confirms.');
    utxoNote.id = pfx + '-trigger-utxo-note';
    rUtxo.appendChild(utxoNote);
    panel.f.outpoint = out; panel.f.utxoMode = mode; panel.f.utxoConfs = confs; panel.f.utxoConfsRow = confsRow; panel.f.utxoNote = utxoNote;
    panel.rows.utxo = rUtxo;
    root.appendChild(rUtxo);
    // Block-height row.
    var rBh = mkEl('div');
    rBh.id = pfx + '-trigger-blockheight-row';
    rBh.appendChild(fieldLabel(pfx + '-blockheight', 'Block height'));
    var bh = document.createElement('input');
    bh.type = 'number'; bh.id = pfx + '-blockheight'; bh.min = '1'; bh.max = '10000000'; bh.placeholder = '1000000';
    rBh.appendChild(inlineUnit([bh, mkEl('span', null, 'block')]));
    rBh.appendChild(mkEl('p', 'guard-note', 'Fires when the chain reaches this height \u2014 a reorg can\u2019t un-fire it.'));
    panel.f.blockheight = bh;
    panel.rows.blockheight = rBh;
    root.appendChild(rBh);
    // Set-date row.
    var rSd = mkEl('div');
    rSd.id = pfx + '-trigger-setdate-row';
    rSd.appendChild(fieldLabel(pfx + '-setdate', 'Date and time'));
    var sd = document.createElement('input');
    sd.type = 'datetime-local'; sd.id = pfx + '-setdate';
    rSd.appendChild(sd);
    rSd.appendChild(mkEl('p', 'guard-note', 'Fires at this date and time, whether or not you check in.'));
    panel.f.setdate = sd;
    panel.rows.setdate = rSd;
    root.appendChild(rSd);
    // Fee-market row.
    var rFm = mkEl('div');
    rFm.id = pfx + '-trigger-feemarket-row';
    rFm.appendChild(fieldLabel(pfx + '-feemarket-dir', 'Direction'));
    var dir = document.createElement('select');
    dir.id = pfx + '-feemarket-dir';
    dir.appendChild(mkOption('below', 'Fee falls to or below', true));
    dir.appendChild(mkOption('above', 'Fee rises to or above', false));
    dir.value = 'below';
    rFm.appendChild(dir);
    rFm.appendChild(fieldLabel(pfx + '-feemarket', 'Economy fee'));
    var fm = document.createElement('input');
    fm.type = 'number'; fm.id = pfx + '-feemarket'; fm.min = '0.1'; fm.step = 'any'; fm.placeholder = '5';
    rFm.appendChild(inlineUnit([fm, mkEl('span', null, 'sat/vB')]));
    rFm.appendChild(mkEl('p', 'guard-note', 'Fires when the fee crosses this rate in the direction you choose.'));
    panel.f.feemarketDir = dir; panel.f.feemarket = fm;
    panel.rows.feemarket = rFm;
    root.appendChild(rFm);
    // Manual row.
    var rManual = mkEl('div');
    rManual.id = pfx + '-trigger-manual-row';
    var mNote = mkEl('p', 'rule-manual-note', 'Never fires \u2014 manual only');
    mNote.id = pfx + '-trigger-manual-note';
    rManual.appendChild(mNote);
    panel.f.manualNote = mNote;
    panel.rows.manual = rManual;
    root.appendChild(rManual);
    fillRulePanel(panel, rule);
    return panel;
  }
  // Show only the picked type's rows; the UTXO guard note
  // follows the confirmation mode.
  function syncRulePanel(panel) {
    var v = panel.typeSel.value;
    panel.rows.checkin.style.display = v === 'checkin' ? '' : 'none';
    panel.rows.price.style.display = v === 'price' ? '' : 'none';
    panel.rows.utxo.style.display = v === 'utxo' ? '' : 'none';
    panel.rows.blockheight.style.display = v === 'blockheight' ? '' : 'none';
    panel.rows.setdate.style.display = v === 'setdate' ? '' : 'none';
    panel.rows.feemarket.style.display = v === 'feemarket' ? '' : 'none';
    panel.rows.manual.style.display = v === 'manual' ? '' : 'none';
    if (v === 'utxo') syncRuleUtxoNote(panel);
  }
  function syncRuleUtxoNote(panel) {
    var mode = panel.f.utxoMode.value;
    panel.f.utxoConfsRow.style.display = mode === 'confirmed' ? '' : 'none';
    var n = parseInt(panel.f.utxoConfs.value, 10);
    if (!isFinite(n) || n < 1) n = 1;
    panel.f.utxoNote.textContent = utxoGuardNote(mode, n);
  }
  // Fill one panel from a rule (the Add form's default and the
  // Edit form's pre-fill share this).
  function fillRulePanel(panel, rule) {
    var f = panel.f;
    panel.typeSel.value = rule.type;
    f.threshold.value = rule.type === 'checkin' ? String(rule.params.thresholdDays) : '35';
    f.op.value = rule.type === 'price' ? rule.params.op : '>=';
    f.value.value = rule.type === 'price' ? String(rule.params.value) : '';
    f.outpoint.value = rule.type === 'utxo' ? rule.params.outpoint : '';
    f.blockheight.value = rule.type === 'blockheight' ? String(rule.params.targetHeight) : '';
    f.setdate.value = rule.type === 'setdate' ? isoToLocalDatetime(rule.params.fireAt) : '';
    f.feemarket.value = rule.type === 'feemarket' ? String(rule.params.maxFeeRate) : '';
    f.feemarketDir.value = rule.type === 'feemarket' && rule.params.direction === 'above' ? 'above' : 'below';
    var uconfs = rule.type === 'utxo' ? ((rule.params.confirmations === 0) ? 0 : (rule.params.confirmations || 1)) : 1;
    f.utxoMode.value = (rule.type === 'utxo' && uconfs === 0) ? 'unconfirmed' : 'confirmed';
    f.utxoConfs.value = String(uconfs === 0 ? 1 : uconfs);
    syncRulePanel(panel);
  }
  function utxoConfsFromPanel(panel) {
    if (panel.f.utxoMode.value === 'unconfirmed') return 0;
    var n = parseInt(panel.f.utxoConfs.value, 10);
    if (!isFinite(n) || n < 1 || n > 100) return null;
    return n;
  }
  // The rule a panel describes, or null if incomplete (an empty price or
  // outpoint is not a rule yet).
  function ruleFromPanel(panel) {
    var v = panel.typeSel.value;
    var f = panel.f;
    if (v === 'checkin') {
      var th = parseInt(f.threshold.value, 10);
      if (!isFinite(th) || th < 1) return null;
      return { type: 'checkin', params: { thresholdDays: th } };
    }
    if (v === 'price') {
      var val = parseFloat(f.value.value);
      if (!isFinite(val) || val <= 0) return null;
      return { type: 'price', params: { asset: 'BTC', op: f.op.value, value: val } };
    }
    if (v === 'utxo') {
      var out = f.outpoint.value.trim();
      if (!/^[0-9a-fA-F]{64}:[0-9]+$/.test(out)) return null;
      var ecf = utxoConfsFromPanel(panel);
      if (ecf === null) return null;
      return { type: 'utxo', params: { outpoint: out.toLowerCase(), condition: 'spent', confirmations: ecf } };
    }
    if (v === 'blockheight') {
      var bh = parseInt(f.blockheight.value, 10);
      if (!isFinite(bh) || bh < 1) return null;
      return { type: 'blockheight', params: { targetHeight: bh } };
    }
    if (v === 'setdate') {
      var sdv = f.setdate.value;
      if (!sdv || !isFinite(Date.parse(sdv))) return null;
      return { type: 'setdate', params: { fireAt: new Date(Date.parse(sdv)).toISOString() } };
    }
    if (v === 'feemarket') {
      var fm = parseFloat(f.feemarket.value);
      if (!isFinite(fm) || fm <= 0) return null;
      return { type: 'feemarket', params: { maxFeeRate: fm, direction: f.feemarketDir.value === 'above' ? 'above' : 'below' } };
    }
    return { type: 'manual', params: {} };
  }
  function ruleErrorHint(type) {
    return type === 'price' ? 'a BTC price above $0.'
      : type === 'utxo' ? 'an outpoint like txid:vout.'
      : type === 'blockheight' ? 'a block height above 0.'
      : type === 'setdate' ? 'a date and time.'
      : type === 'feemarket' ? 'a fee rate above 0 sat/vB.'
      : 'a number of days.';
  }
  // Read the rule set one form describes, or {set: null,
  // error} naming the first incomplete rule.
  function ruleSetFromForm(prefix) {
    var list = ruleLists[prefix];
    var rules = [];
    for (var i = 0; i < list.panels.length; i++) {
      var r = ruleFromPanel(list.panels[i]);
      if (!r) return { set: null, error: 'Fill in rule ' + (i + 1) + ': ' + ruleErrorHint(list.panels[i].typeSel.value) };
      rules.push(r);
    }
    if (!rules.length) return { set: null, error: 'Add at least one rule.' };
    return { set: { op: list.op, rules: rules }, error: null };
  }
  // Default params for a fresh rule, so empty fields render instead of
  // "undefined".
  function defaultRuleParams(type) {
    if (type === 'checkin') return { thresholdDays: 35 };
    if (type === 'price') return { op: '>=', value: '' };
    if (type === 'utxo') return { outpoint: '', condition: 'spent', confirmations: 1 };
    if (type === 'blockheight') return { targetHeight: '' };
    if (type === 'setdate') return { fireAt: '' };
    if (type === 'feemarket') return { maxFeeRate: '', direction: 'below' };
    return {};
  }
  // A new panel gets the first type no other panel uses.
  function defaultRuleFor(prefix) {
    var list = ruleLists[prefix];
    var used = {};
    list.panels.forEach(function (p) { used[p.typeSel.value] = true; });
    var t = null;
    TRIGGER_TYPE_OPTIONS.some(function (o) { if (!used[o.value]) { t = o.value; return true; } return false; });
    if (!t) t = 'checkin';
    return { type: t, params: defaultRuleParams(t) };
  }
  // No duplicate rule types: types used by other panels are disabled as
  // "(already used)".
  function syncRuleTypeOptions(prefix) {
    var list = ruleLists[prefix];
    var used = {};
    list.panels.forEach(function (p) { used[p.typeSel.value] = true; });
    list.panels.forEach(function (p) {
      var own = p.typeSel.value;
      Array.prototype.forEach.call(p.typeSel.children, function (o) {
        if (o.tagName !== 'OPTION') return;
        var taken = o.value !== own && !!used[o.value];
        o.disabled = taken;
        var base = null;
        TRIGGER_TYPE_OPTIONS.some(function (t) { if (t.value === o.value) { base = t.label; return true; } return false; });
        o.textContent = taken ? (base || o.value) + ' (already used)' : (base || o.value);
      });
    });
  }
  function addRulePanel(prefix, rule) {
    var list = ruleLists[prefix];
    if (list.panels.length >= MAX_RULES_PER_TX) return null;
    var panel = buildRulePanel(prefix, list.nextIdx++, rule || defaultRuleFor(prefix));
    list.panels.push(panel);
    $(prefix + '-rules-list').appendChild(panel.root);
    syncRuleListChrome(prefix);
    return panel;
  }
  function removeRulePanel(prefix, panel) {
    var list = ruleLists[prefix];
    if (list.panels.length <= 1) return;
    var i = list.panels.indexOf(panel);
    if (i === -1) return;
    list.panels.splice(i, 1);
    $(prefix + '-rules-list').removeChild(panel.root);
    syncRuleListChrome(prefix);
  }
  // The combine cards, notes and buttons follow the list: no Remove on a
  // single rule, Add disabled at the 5-rule cap.
  function syncRuleListChrome(prefix) {
    var list = ruleLists[prefix];
    list.panels.forEach(function (p, i) {
      p.titleEl.textContent = 'Rule ' + (i + 1);
      p.removeBtn.style.display = list.panels.length > 1 ? '' : 'none';
    });
    var anyBtn = $(prefix + '-op-any');
    var allBtn = $(prefix + '-op-all');
    if (anyBtn) anyBtn.className = list.op === 'OR' ? 'op-card selected' : 'op-card';
    if (allBtn) allBtn.className = list.op === 'AND' ? 'op-card selected' : 'op-card';
    // The one-rule note: combining matters from the second rule, but the
    // section is visible from the first.
    var opNote = $(prefix + '-op-note');
    if (opNote) opNote.style.display = list.panels.length <= 1 ? '' : 'none';
    var addBtn = $(prefix + '-add-rule');
    var atCap = list.panels.length >= MAX_RULES_PER_TX;
    if (addBtn) addBtn.disabled = atCap;
    var capNote = $(prefix + '-rules-cap-note');
    if (capNote) capNote.style.display = atCap ? '' : 'none';
    syncRuleTypeOptions(prefix);
  }
  function resetRuleList(prefix, set) {
    var list = ruleLists[prefix];
    var listEl = $(prefix + '-rules-list');
    if (listEl) listEl.innerHTML = '';
    list.panels = [];
    list.nextIdx = 0;
    list.op = (set && set.op === 'AND') ? 'AND' : 'OR';
    var rules = (set && set.rules && set.rules.length) ? set.rules : [{ type: 'checkin', params: { thresholdDays: 35 } }];
    rules.forEach(function (r) { addRulePanel(prefix, r); });
    syncRuleListChrome(prefix);
  }
  function setRuleListLocked(prefix, locked) {
    var list = ruleLists[prefix];
    [$(prefix + '-op-any'), $(prefix + '-op-all'), $(prefix + '-add-rule')].forEach(function (b) { if (b) b.disabled = locked; });
    list.panels.forEach(function (p) {
      p.typeSel.disabled = locked;
      p.typeSel.title = locked ? 'The trigger cannot be changed once the transaction has been broadcast' : '';
      Object.keys(p.f).forEach(function (k) { p.f[k].disabled = locked; });
      p.removeBtn.disabled = locked;
    });
  }
  // The toggle and "+ Add rule" wiring, then the boot state:
  // one default check-in rule in each form.
  $('btc-op-any').addEventListener('click', function () { ruleLists.btc.op = 'OR'; syncRuleListChrome('btc'); });
  $('btc-op-all').addEventListener('click', function () { ruleLists.btc.op = 'AND'; syncRuleListChrome('btc'); });
  $('btc-add-rule').addEventListener('click', function () { addRulePanel('btc'); });
  $('edit-op-any').addEventListener('click', function () { ruleLists.edit.op = 'OR'; syncRuleListChrome('edit'); });
  $('edit-op-all').addEventListener('click', function () { ruleLists.edit.op = 'AND'; syncRuleListChrome('edit'); });
  $('edit-add-rule').addEventListener('click', function () { addRulePanel('edit'); });
  // The set popup's rule form uses the same machinery with prefix 'set'
  // (skipped on an old page).
  if ($('set-rules-list')) {
    $('set-op-any').addEventListener('click', function () { ruleLists.set.op = 'OR'; syncRuleListChrome('set'); });
    $('set-op-all').addEventListener('click', function () { ruleLists.set.op = 'AND'; syncRuleListChrome('set'); });
    $('set-add-rule').addEventListener('click', function () { addRulePanel('set'); });
    resetRuleList('set');
  }
  resetRuleList('btc');
  resetRuleList('edit');
  var editModalX = $('edit-modal-x');
  if (editModalX) editModalX.addEventListener('click', function () { cancelEdit(); });
  $('edit-modal').addEventListener('click', function (e) {
    if (e.target === $('edit-modal')) cancelEdit();
  });
  // The set popup's X and backdrop (guarded).
  var setModalX = $('set-modal-x');
  if (setModalX) setModalX.addEventListener('click', function () { cancelSet(); });
  var setModalEl = $('set-modal');
  if (setModalEl) setModalEl.addEventListener('click', function (e) {
    if (e.target === setModalEl) cancelSet();
  });

  // Save the edit. Without new entries it is a plain PUT. With them, they
  // are created first (with this card's trigger and route) and the card
  // becomes a set holding the kept original and the new txs; an original
  // removed from the card stays standalone. A failure stops the save: txs
  // already created stay standalone and no set is made. Errors stay in the
  // popup.
  $('btn-edit-save').addEventListener('click', async function () {
    if (!editingId) return;
    var origKept = !editOriginalRemoved;
    var hex = origKept ? $('edit-hex').value.trim() : '';
    if (origKept && !hex) { setMsg($('edit-msg'), 'Paste the signed transaction hex first.', false); return; }
    // New entries: blank ignored, notes without hex blocks the save.
    var collected = collectNewTxEntries(editNewTxEntrySets());
    if (collected.noteless) { setMsg($('edit-msg'), 'Transaction ' + collected.noteless.n + ' has notes but no signed transaction — paste its hex or remove the entry.', false); return; }
    var newTxs = collected.filled;
    if (!origKept && !newTxs.length) { setMsg($('edit-msg'), 'This trigger set needs at least one transaction — add one, or undo the removal.', false); return; }
    var eres = ruleSetFromForm('edit');
    var trig = eres.set;
    if (!trig) { setMsg($('edit-msg'), eres.error, false); return; }
    var saveTitle = trig.rules.length > 1 ? 'Save a rule set that is already satisfied?' : 'Save a rule that is already satisfied?';
    var oldTx0 = (S.bitcoin.txs || []).find(function (t) { return t.id === editingId; });
    // Warn about an already-satisfied price or UTXO rule only when the
    // rules changed (not on a label edit). Check-in needs no warning on
    // edit.
    var triggerChanged = oldTx0 && (JSON.stringify(triggerSetOf(oldTx0)) !== JSON.stringify(trig));
    function doSave(triggerConfirmed) {
      return (async function () {
        var originalUpdated = false;
        var createdIds = [];
        var checkinReset = false;
        var triggerWarning = null;
        var putRes = null;
        try {
          await saveBitcoinSettings();
          var oldTx = (S.bitcoin.txs || []).find(function (t) { return t.id === editingId; });
          var editFbVal = $('edit-fallback').value;
          if (origKept) {
            var body = { txHex: hex, label: $('edit-label').value, notes: $('edit-notes').value, broadcastVia: $('edit-route').value, publicFallbackDays: editFbVal === '' ? null : parseInt(editFbVal, 10), trigger: trig };
            if (triggerConfirmed) body.triggerConfirmed = true;
            putRes = await api('PUT', '/api/bitcoin/txs/' + encodeURIComponent(editingId), body);
            originalUpdated = true;
            if (putRes && putRes.triggerWarning) triggerWarning = putRes.triggerWarning;
            // A replaced hex clears the old dry-run result (shared-input
            // warnings recompute on the next load).
            if (oldTx && oldTx.hex !== hex) { delete dryRunResults[editingId]; }
          }
          for (var i = 0; i < newTxs.length; i++) {
            var txBody = { txHex: newTxs[i].hex, notes: newTxs[i].notes, broadcastVia: $('edit-route').value, publicFallbackDays: editFbVal === '' ? null : parseInt(editFbVal, 10), trigger: trig };
            if (triggerConfirmed) txBody.triggerConfirmed = true;
            var cr = await api('POST', '/api/bitcoin/txs', txBody);
            createdIds.push(cr.tx.id);
            if (cr.checkinReset) checkinReset = true;
            if (cr.triggerWarning) triggerWarning = cr.triggerWarning;
          }
          var doneMsg;
          if (createdIds.length) {
            var allIds = (origKept ? [editingId] : []).concat(createdIds);
            var setBody = { label: $('edit-label').value, txIds: allIds, trigger: trig, enabled: oldTx ? oldTx.enabled !== false : true };
            if (triggerConfirmed) setBody.triggerConfirmed = true;
            var sr = await api('POST', '/api/bitcoin/sets', setBody);
            if (sr && sr.checkinReset) checkinReset = true;
            if (sr && sr.triggerWarning) triggerWarning = sr.triggerWarning;
            doneMsg = origKept
              ? 'Transaction updated. Added ' + createdIds.length + (createdIds.length === 1 ? ' transaction — this is now a trigger set.' : ' transactions — this is now a trigger set.')
              : 'Trigger set created with ' + createdIds.length + (createdIds.length === 1 ? ' transaction.' : ' transactions.') + ' The original transaction is staged standalone.';
          } else {
            doneMsg = 'Transaction updated. TXID ' + putRes.tx.txid + '.';
          }
          if (checkinReset) doneMsg += ' Your check-in was reset to today.';
          if (triggerWarning) doneMsg += ' ' + triggerWarning;
          setMsg($('btc-msg'), doneMsg, true);
          cancelEdit();
          await load();
        } catch (e) {
          // The server's already-satisfied gate backs up the pre-check; a
          // gate 400 offers the same confirm, unless something was already
          // created (then it is reported as a partial save).
          if (createdIds.length === 0 && e.message && e.message.indexOf('would fire on the next evaluation') !== -1) {
            showConfirm(saveTitle, 'This rule is already satisfied — it would fire on the next evaluation. Save it anyway?', function () { doSave(true); }, 'Save anyway');
            return;
          }
          if (createdIds.length) {
            setMsg($('edit-msg'), 'Added ' + createdIds.length + ' of ' + newTxs.length + ' transactions before the error: ' + e.message
              + ' The trigger set was not created — the added transactions are staged standalone.'
              + (originalUpdated ? ' The original transaction was already updated.' : ''), false);
            return;
          }
          setMsg($('edit-msg'), e.message, false);
        }
      })();
    }
    // Adding a check-in rule inside the danger zone could fire soon:
    // confirm first (only when a tx is actually added).
    if (newTxs.length) {
      var editCkTh = minSetCheckinThreshold(trig);
      if (editCkTh !== null) {
        var dz = dangerZone(editCkTh);
        if (dz) {
          showConfirm('Reset your check-in?',
            dz.overdue
              ? 'The release is due — your last check-in was ' + dz.daysSince + ' day' + (dz.daysSince === 1 ? '' : 's') + ' ago. A new transaction is armed by default, so it would broadcast on the next check. Adding it will reset your check-in to today and restart the countdown.'
              : 'Only ' + dz.daysLeft + ' day' + (dz.daysLeft === 1 ? '' : 's') + ' left until the release is due. Adding it will reset your check-in to today and restart the countdown.',
            function () { doSave(); }, 'Add and reset');
          return;
        }
      }
    }
    if (triggerChanged && trig.rules.some(function (r) { return r.type === 'price' || r.type === 'utxo' || r.type === 'blockheight' || r.type === 'setdate' || r.type === 'feemarket'; })) {
      try {
        var chk = await api('POST', '/api/triggers/check', { trigger: trig });
        if (chk && chk.warning) {
          showConfirm(saveTitle, chk.warning + ' Save it anyway?', function () { doSave(true); }, 'Save anyway');
          return;
        }
      } catch (e) { /* the save proceeds — the server gates the price, UTXO, block-height, set-date, and fee-market cases */ }
    }
    doSave();
  });

  // Save a set (edit only; new sets come from "+ Add Tx"). New entries are
  // created first with the set's trigger, then attached by sending the
  // full txIds; without them txIds is omitted. A failure stops the save:
  // created txs stay standalone and the set is unchanged. Same already-
  // satisfied guard as the other saves.
  var btnSetSave = $('btn-set-save');
  if (btnSetSave) btnSetSave.addEventListener('click', async function () {
    var sres = ruleSetFromForm('set');
    var trig = sres.set;
    if (!trig) { setMsg($('set-msg'), sres.error, false); return; }
    var saveTitle = trig.rules.length > 1 ? 'Save a rule set that is already satisfied?' : 'Save a rule that is already satisfied?';
    var oldSet = (S.bitcoin.sets || []).find(function (s) { return s.id === editingSetId; }) || null;
    var triggerChanged = !oldSet || (JSON.stringify(triggerSetOf(oldSet)) !== JSON.stringify(trig));
    // New entries: blank ignored, notes without hex blocks the save.
    var collected = collectNewTxEntries(setNewTxEntrySets());
    if (collected.noteless) { setMsg($('set-msg'), 'Transaction ' + collected.noteless.n + ' has notes but no signed transaction — paste its hex or remove the entry.', false); return; }
    var newTxs = collected.filled;
    // New txs take the first member's route (public if the set has none).
    var members0 = oldSet ? setMembersOf(oldSet) : [];
    var newVia = (members0[0] && members0[0].broadcastVia) || 'public';
    var newFb = (members0[0] && members0[0].publicFallbackDays !== undefined && members0[0].publicFallbackDays !== null) ? members0[0].publicFallbackDays : null;
    function doSave(triggerConfirmed) {
      return (async function () {
        var createdIds = [];
        var checkinReset = false;
        try {
          for (var i = 0; i < newTxs.length; i++) {
            var txBody = { txHex: newTxs[i].hex, notes: newTxs[i].notes, broadcastVia: newVia, publicFallbackDays: newFb, trigger: trig };
            if (triggerConfirmed) txBody.triggerConfirmed = true;
            var cr = await api('POST', '/api/bitcoin/txs', txBody);
            createdIds.push(cr.tx.id);
            if (cr.checkinReset) checkinReset = true;
          }
          var body = { label: $('set-label').value, trigger: trig, enabled: $('set-enabled').checked };
          // Kept plus new members; with no change txIds is omitted.
          var keptIds = setEditMembers.map(function (t) { return t.id; });
          var removedCount = oldSet ? (oldSet.txIds || []).filter(function (id) { return keptIds.indexOf(id) === -1; }).length : 0;
          if (createdIds.length || removedCount) body.txIds = keptIds.concat(createdIds);
          if (triggerConfirmed) body.triggerConfirmed = true;
          var r = await api('PUT', '/api/bitcoin/sets/' + encodeURIComponent(editingSetId), body);
          var doneMsg = 'Trigger set updated.'
            + (createdIds.length ? ' Added ' + createdIds.length + (createdIds.length === 1 ? ' transaction.' : ' transactions.') : '')
            + (removedCount ? ' Removed ' + removedCount + (removedCount === 1 ? ' transaction — it is staged standalone.' : ' transactions — they are staged standalone.') : '')
            + (checkinReset ? ' Your check-in was reset to today.' : '')
            + (r && r.triggerWarning ? ' ' + r.triggerWarning : '');
          setMsg($('btc-msg'), doneMsg, true);
          cancelSet();
          await load();
        } catch (e) {
          // The server's gate backs up the pre-check, unless something was
          // already created (then it is a partial save).
          if (createdIds.length === 0 && e.message && e.message.indexOf('would fire on the next evaluation') !== -1) {
            showConfirm(saveTitle, 'This rule is already satisfied — it would fire on the next evaluation. Save it anyway?', function () { doSave(true); }, 'Save anyway');
            return;
          }
          if (createdIds.length) {
            setMsg($('set-msg'), 'Added ' + createdIds.length + ' of ' + newTxs.length + ' transactions before the error: ' + e.message
              + ' The added transactions are staged standalone — they were not attached to this set, and the set was not changed.', false);
            return;
          }
          setMsg($('set-msg'), e.message, false);
        }
      })();
    }
    // Same check-in confirm as the Add form, only when a tx is actually
    // added.
    if (newTxs.length) {
      var setCkTh = minSetCheckinThreshold(trig);
      if (setCkTh !== null) {
        var dz = dangerZone(setCkTh);
        if (dz) {
          showConfirm('Reset your check-in?',
            dz.overdue
              ? 'The release is due — your last check-in was ' + dz.daysSince + ' day' + (dz.daysSince === 1 ? '' : 's') + ' ago. A new transaction is armed by default, so it would broadcast on the next check. Adding it will reset your check-in to today and restart the countdown.'
              : 'Only ' + dz.daysLeft + ' day' + (dz.daysLeft === 1 ? '' : 's') + ' left until the release is due. Adding it will reset your check-in to today and restart the countdown.',
            function () { doSave(); }, 'Add and reset');
          return;
        }
      }
    }
    if (triggerChanged && trig.rules.some(function (r) { return r.type === 'price' || r.type === 'utxo' || r.type === 'blockheight' || r.type === 'setdate' || r.type === 'feemarket'; })) {
      try {
        var chk = await api('POST', '/api/triggers/check', { trigger: trig });
        if (chk && chk.warning) {
          showConfirm(saveTitle, chk.warning + ' Save it anyway?', function () { doSave(true); }, 'Save anyway');
          return;
        }
      } catch (e) { /* the save proceeds — the server gates the price, UTXO, block-height, set-date, and fee-market cases */ }
    }
    doSave();
  });

  async function deleteTx(id) {
    try {
      await api('DELETE', '/api/bitcoin/txs/' + encodeURIComponent(id));
      delete dryRunResults[id];
      if (editingId === id) cancelEdit();
      setMsg($('btc-msg'), 'Transaction removed.', true);
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); }
  }

  // Deleting a set returns its txs to standalone (each with its own
  // trigger); the set's history goes.
  async function deleteSet(id) {
    try {
      await api('DELETE', '/api/bitcoin/sets/' + encodeURIComponent(id));
      if (editingSetId === id) cancelSet();
      setMsg($('btc-msg'), 'Trigger set removed. Its transactions are standalone again.', true);
      await load();
    } catch (e) { setMsg($('btc-msg'), e.message, false); }
  }

  async function saveBitcoinSettings() {
    var s = await api('PUT', '/api/settings', {
      primaryApiUrl: $('btc-primary-url').value,
      secondaryApiUrl: $('btc-secondary-url').value,
      primaryRpc: rpcFieldsBody('primary'),
      secondaryRpc: rpcFieldsBody('secondary'),
      // The secondary toggle saves with the node settings; its URL is kept
      // while off.
      secondaryEnabled: $('btc-secondary-enabled').checked,
    });
    S.settings = s;
  }

  $('btn-btc-save-nodes').addEventListener('click', async function () {
    try {
      await saveBitcoinSettings();
      setMsg($('btc-nodes-msg'), 'Nodes saved.', true);
      await load();
    } catch (e) { setMsg($('btc-nodes-msg'), e.message, false); }
  });

  $('btn-btc-test-conn').addEventListener('click', async function () {
    try {
      await saveBitcoinSettings();
      await api('POST', '/api/bitcoin/connection/test', {});
      setMsg($('btc-nodes-msg'), '', true);
      await load();
      openFailedNodeDetails();
    } catch (e) { setMsg($('btc-nodes-msg'), e.message, false); }
  });


  // The secondary settings hide or show at once; the value saves with Save
  // nodes.
  $('btc-secondary-enabled').addEventListener('change', syncSecondaryEnabled);
  // Show/hide on every password box.
  ['btc-primary-rpc-password', 'btc-secondary-rpc-password', 'login-password', 'backup-password', 'backup-password2', 'restore-password',
    'setup-pw1', 'setup-pw2', 'login-new1', 'login-new2', 'login-cur', 'login-chg1', 'login-chg2', 'fresh-password'].forEach(function (id) {
    var btn = $(id + '-show');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var input = $(id);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.title = show ? 'Hide password' : 'Show password';
      btn.setAttribute('aria-label', btn.title);
    });
  });
  $('btc-primary-rpc').addEventListener('change', function () { syncRpc('primary'); });
  $('btc-secondary-rpc').addEventListener('change', function () { syncRpc('secondary'); });

  // The Add form's fallback row shows only while the route is Slipstream,
  // with a note on what the duration means.
  function syncAddFallbackRow() {
    var slip = $('btc-route').value === 'slipstream';
    $('btc-fallback-row').style.display = slip ? '' : 'none';
    if (slip) {
      var v = $('btc-fallback').value;
      $('btc-fallback-note').textContent = fallbackAddNote(v === '' ? null : parseInt(v, 10));
    }
  }
  $('btc-route').addEventListener('change', syncAddFallbackRow);
  $('btc-fallback').addEventListener('change', syncAddFallbackRow);
  // Add: create every filled entry with the shared rules and route (each
  // tx also keeps the trigger, used if the set is deleted), then one new
  // set with the label. Blank entries are skipped; notes without hex is an
  // error. A failure after some txs were created leaves those standalone
  // and makes no set.
  $('btn-btc-add').addEventListener('click', async function () {
    var sets = addTxEntrySets();
    var snap = sets.map(function (s, i) {
      return {
        n: i + 1,
        notes: s.fields.notes ? s.fields.notes.value : '',
        hex: s.fields.hex ? s.fields.hex.value.trim() : '',
      };
    });
    var filled = snap.filter(function (e) { return !!e.hex; });
    if (!filled.length) { setMsg($('btc-msg'), 'Paste the signed transaction hex first.', false); return; }
    var noteless = snap.filter(function (e) { return !e.hex && e.notes.trim() !== ''; })[0];
    if (noteless) { setMsg($('btc-msg'), 'Transaction ' + noteless.n + ' has notes but no signed transaction — paste its hex or remove the entry.', false); return; }
    var setLabel = $('btc-set-label') ? $('btc-set-label').value : '';
    var res = ruleSetFromForm('btc');
    var trig = res.set;
    if (!trig) { setMsg($('btc-msg'), res.error, false); return; }
    // A multi-rule set that is already satisfied reads "rule
    // set" in the confirm title; a single rule keeps "rule".
    var addTitle = trig.rules.length > 1 ? 'Add a rule set that is already satisfied?' : 'Add a rule that is already satisfied?';
    function doAdd(triggerConfirmed) {
      return (async function () {
        var created = [];
        var setCreated = false;
        try {
          await saveBitcoinSettings();
          var fbVal = $('btc-fallback').value;
          var checkinReset = false;
          var triggerWarning = null;
          for (var i = 0; i < filled.length; i++) {
            var body = { txHex: filled[i].hex, notes: filled[i].notes, broadcastVia: $('btc-route').value, publicFallbackDays: fbVal === '' ? null : parseInt(fbVal, 10), trigger: trig };
            if (triggerConfirmed) body.triggerConfirmed = true;
            var r = await api('POST', '/api/bitcoin/txs', body);
            created.push(r.tx);
            if (r.checkinReset) checkinReset = true;
            if (r.triggerWarning) triggerWarning = r.triggerWarning;
          }
          // Then one POST for the set (the gate already ran on the tx
          // POSTs).
          var setBody = { label: setLabel, txIds: created.map(function (t) { return t.id; }), trigger: trig, enabled: true };
          if (triggerConfirmed) setBody.triggerConfirmed = true;
          var sr = await api('POST', '/api/bitcoin/sets', setBody);
          setCreated = true;
          if (sr && sr.checkinReset) checkinReset = true;
          if (sr && sr.triggerWarning) triggerWarning = sr.triggerWarning;
          // On success the popup closes and the message lands in the
          // Staged card; errors stay in the popup.
          closeAddModal();
          var doneMsg = 'Trigger set "' + (setLabel || 'Untitled set') + '" created with ' + created.length
            + (created.length === 1 ? ' transaction' : ' transactions') + ' and armed. TXIDs '
            + created.map(function (t) { return t.txid; }).join(', ') + ' — use the toggle to unarm it.';
          if (checkinReset) doneMsg += ' Your check-in was reset to today.';
          if (triggerWarning) doneMsg += ' ' + triggerWarning;
          setMsg($('btc-all-msg'), doneMsg, true);
          resetAddTxEntries();
          $('btc-route').value = 'public';
          $('btc-fallback').value = '';
          resetRuleList('btc');
          syncAddFallbackRow();
          await load();
        } catch (e) {
          // The server's already-satisfied gate backs up the pre-check
          // (the price can cross in between); a gate 400 offers the same
          // confirm unless something was already created.
          if (created.length === 0 && e.message && e.message.indexOf('would fire on the next evaluation') !== -1) {
            showConfirm(addTitle, 'This rule is already satisfied — it would fire on the next evaluation. Add it anyway?', function () { doAdd(true); }, 'Add anyway');
            return;
          }
          if (created.length) {
            await load();
            setMsg($('btc-msg'), 'Added ' + created.length + ' of ' + filled.length + ' transactions before the error: ' + e.message
              + (setCreated ? '' : ' The trigger set was not created — the added transactions are staged standalone.'), false);
            return;
          }
          setMsg($('btc-msg'), e.message, false);
        }
      })();
    }
    // A new check-in rule inside its danger zone could fire soon, so
    // confirm first (the server resets the check-in anyway). With several
    // check-in rules, the soonest measures the window.
    var addCkTh = minSetCheckinThreshold(trig);
    if (addCkTh !== null) {
      var dz = dangerZone(addCkTh);
      if (dz) {
        showConfirm('Reset your check-in?',
          dz.overdue
            ? 'The release is due — your last check-in was ' + dz.daysSince + ' day' + (dz.daysSince === 1 ? '' : 's') + ' ago. A new transaction is armed by default, so it would broadcast on the next check. Adding it will reset your check-in to today and restart the countdown.'
            : 'Only ' + dz.daysLeft + ' day' + (dz.daysLeft === 1 ? '' : 's') + ' left until the release is due. Adding it will reset your check-in to today and restart the countdown.',
          doAdd, 'Add and reset');
        return;
      }
      doAdd();
      return;
    }
    // A price, UTXO, height, date or fee rule that is already satisfied
    // would fire on the next evaluation: ask the server once and confirm
    // first. Confirming sends triggerConfirmed.
    var addHasLive = trig.rules.some(function (r) { return r.type === 'price' || r.type === 'utxo' || r.type === 'blockheight' || r.type === 'setdate' || r.type === 'feemarket'; });
    if (addHasLive) {
      try {
        var chk = await api('POST', '/api/triggers/check', { trigger: trig });
        if (chk && chk.warning) {
          showConfirm(addTitle, chk.warning + ' Add it anyway?', function () { doAdd(true); }, 'Add anyway');
          return;
        }
      } catch (e) { /* the add proceeds without the check — the server gates the price, UTXO, block-height, set-date, and fee-market cases */ }
    }
    doAdd();
  });

  // Import from a file fills the hex box only; adding stays a separate
  // step. A PSBT is finalized by the server first (a not-fully-signed one
  // is rejected with the inputs named). Each entry's import button fills
  // its own box (hexEl / msgEl); the Add form's first entry is the
  // default.
  var pendingImportTarget = null;
  function base64OfBytes(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function importTxFile(file, hexEl, msgEl, fileId) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
        if (/^[0-9a-fA-F]+$/.test(text) && text.length > 0 && text.length % 2 === 0) {
          // Hex file: put the hex straight in the box.
          hexEl.value = text;
        } else if (bytes.length >= 5 && bytes[0] === 0x70 && bytes[1] === 0x73 && bytes[2] === 0x62 && bytes[3] === 0x74 && bytes[4] === 0xff) {
          // A binary PSBT is base64-encoded for the JSON body and
          // finalized server-side.
          var r = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: base64OfBytes(bytes) });
          hexEl.value = r.hex;
        } else {
          // Base64 PSBT text: finalize it server-side the same way.
          var b64 = text.replace(/\s+/g, '');
          var decodesToPsbt = false;
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
            try { var raw = atob(b64); decodesToPsbt = raw.slice(0, 4) === 'psbt' && raw.charCodeAt(4) === 0xff; } catch (e) { /* not base64 */ }
          }
          if (decodesToPsbt) {
            var r2 = await api('POST', '/api/bitcoin/txs/preview', { format: 'psbt', data: text });
            hexEl.value = r2.hex;
          } else {
            // Neither hex nor a PSBT — say so plainly instead of
            // sending it as a PSBT and getting a PSBT error back.
            setMsg(msgEl, 'This file does not look like a signed transaction. Import a plain hex file or a fully-signed PSBT (.psbt).', false);
          }
        }
      } catch (e) { setMsg(msgEl, e.message, false); }
      $(fileId).value = '';
    };
    reader.onerror = function () { setMsg(msgEl, 'Could not read that file.', false); $(fileId).value = ''; };
    reader.readAsArrayBuffer(file);
  }
  // The static first entry's import button targets its own hex box.
  $('btn-btc-import-file').addEventListener('click', function () {
    pendingImportTarget = { hex: $('btc-hex'), msg: $('btc-msg') };
    $('btc-file').click();
  });
  $('btc-file').addEventListener('change', function () {
    var t = pendingImportTarget || { hex: $('btc-hex'), msg: $('btc-msg') };
    pendingImportTarget = null;
    importTxFile($('btc-file').files && $('btc-file').files[0], t.hex, t.msg, 'btc-file');
  });
  $('btn-edit-import-file').addEventListener('click', function () { $('edit-file').click(); });
  $('edit-file').addEventListener('change', function () {
    importTxFile($('edit-file').files && $('edit-file').files[0], $('edit-hex'), $('edit-msg'), 'edit-file');
  });

  // One modal, two uses: a confirm (Proceed and Cancel) or a details pop-
  // out (Close only).
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var confirmPending = null;
  var confirmCancel = null;
  function showConfirm(title, body, onProceed, proceedLabel, onCancel) {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('modal-details').innerHTML = '';
    $('confirm-proceed').style.display = '';
    $('confirm-proceed').textContent = proceedLabel || 'Proceed';
    $('confirm-cancel').textContent = 'Cancel';
    confirmPending = onProceed;
    // Dismissing a confirm must not leave a flipped control on screen:
    // onCancel (usually a re-render) runs on any dismissal.
    confirmCancel = typeof onCancel === 'function' ? onCancel : null;
    $('confirm-modal').classList.add('open');
  }
  function showDetails(title, body, detailsHtml) {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('modal-details').innerHTML = detailsHtml;
    $('confirm-proceed').style.display = 'none';
    $('confirm-cancel').textContent = 'Close';
    confirmPending = null;
    confirmCancel = null;
    $('confirm-modal').classList.add('open');
  }
  function hideConfirm() {
    $('confirm-modal').classList.remove('open');
    confirmPending = null;
    var cb = confirmCancel;
    confirmCancel = null;
    // Closing the pop-out any way drops a new key's plaintext, so it is
    // never shown again.
    newKeyPlain = null;
    $('modal-details').innerHTML = '';
    // The dismiss hook runs after the modal is closed and the action
    // cleared, so it cannot reopen or re-fire.
    if (cb) cb();
  }
  $('confirm-proceed').addEventListener('click', function () {
    var fn = confirmPending;
    confirmCancel = null; // Proceed is not a cancel — the hook must not fire.
    hideConfirm();
    if (fn) fn();
  });
  $('confirm-cancel').addEventListener('click', hideConfirm);
  $('confirm-modal').addEventListener('click', function (e) {
    if (e.target === $('confirm-modal')) hideConfirm();
  });
  // The X closes like Cancel (guarded: an old page still closes via Cancel
  // or the backdrop).
  var modalX = $('modal-x');
  if (modalX) modalX.addEventListener('click', hideConfirm);

  // The receiver address comes from the host this page was opened on (that
  // host is this device); the server cannot know its LAN address from
  // inside the container.
  function fillConnectLine() {
    var host = window.location.hostname || 'localhost';
    var el = $('api-keys-receiver-url');
    if (el) el.textContent = 'http://' + host + ':3101';
  }
  fillConnectLine();

  // "Accept check-ins from other devices" (desktop and plain runs): the
  // switch, this computer's addresses for the port, and whether it opened.
  var remoteCheckin = null;
  function renderRemoteCheckin() {
    var r = remoteCheckin;
    var box = $('remote-checkin');
    if (!r || !r.available) { box.style.display = 'none'; return; }
    box.style.display = '';
    var on = !!(S && S.settings && S.settings.acceptRemoteCheckins);
    $('remote-checkin-on').checked = on;
    $('remote-checkin-off-note').style.display = on ? 'none' : '';
    $('remote-checkin-on-note').style.display = on ? '' : 'none';
    // The old one-line address is the separate receiver's; here the switch
    // and the addresses below replace it.
    $('api-keys-receiver-line').style.display = 'none';
    $('api-keys-routes').style.display = on ? '' : 'none';
    document.querySelectorAll('.remote-checkin-port').forEach(function (el) { el.textContent = String(r.port); });
    var urls = $('remote-checkin-urls');
    urls.innerHTML = '';
    var hosts = (r.addresses && r.addresses.length) ? r.addresses : ['<this computer\'s address>'];
    hosts.forEach(function (h, i) {
      if (i) urls.appendChild(document.createElement('br'));
      var c = document.createElement('code');
      c.textContent = 'http://' + h + ':' + r.port + '/checkin';
      urls.appendChild(c);
    });
    if (on && r.error) setMsg($('remote-checkin-msg'), 'Could not open the check-in port: ' + r.error, false);
    else if (on && !r.listening) setMsg($('remote-checkin-msg'), 'Opening the check-in port…', true);
    else setMsg($('remote-checkin-msg'), '', true);
  }
  function loadRemoteCheckin() {
    return api('GET', '/api/remote-checkin').then(function (r) { remoteCheckin = r; renderRemoteCheckin(); })
      .catch(function () { /* older server: nothing to show */ });
  }
  $('remote-checkin-on').addEventListener('change', async function () {
    var want = $('remote-checkin-on').checked;
    try {
      S.settings = await api('PUT', '/api/settings', { acceptRemoteCheckins: want });
      // The port opens asynchronously; ask again once it has had a moment.
      await new Promise(function (r) { setTimeout(r, 300); });
      await loadRemoteCheckin();
    } catch (e) {
      $('remote-checkin-on').checked = !want;
      setMsg($('remote-checkin-msg'), e.message, false);
    }
  });

  // A clicked log entry: full TXID, what happened, and the full hex if the
  // tx is still stored (the log keeps only a preview).
  function showBroadcastDetails(e) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.txid === e.txid; });
    var hex = tx ? tx.hex : null;
    var body = (e.kind || '') + ' — ' + (e.status || '') + (e.method ? ' (' + methodLabel(e.method) + ')' : '');
    var html = '<dl class="kv">'
      + '<dt>TXID</dt><dd>' + escapeHtml(e.txid || '') + '</dd>'
      + '<dt>Kind</dt><dd>' + escapeHtml(e.kind || '') + '</dd>'
      + '<dt>Status</dt><dd>' + escapeHtml(e.status || '') + '</dd>'
      + '<dt>Method</dt><dd>' + escapeHtml(e.method ? methodLabel(e.method) : '—') + '</dd>'
      + '<dt>When</dt><dd>' + escapeHtml(fmtDate(e.ts)) + '</dd>'
      + '</dl>'
      + (e.note ? '<p class="muted">' + escapeHtml(e.note) + '</p>' : '')
      + '<h3>Signed transaction (hex)</h3>'
      + '<pre>' + escapeHtml(hex || ((e.hexPreview || '') + ' — this transaction is no longer stored, so only the logged preview is available.')) + '</pre>';
    showDetails('Broadcast log entry', body, html);
  }

  function broadcastResultText(r) {
    if (!r) return '';
    if (r.action === 'broadcast') return 'Broadcast via the ' + methodLabel(r.method) + ' node.';
    if (r.action === 'stale') return 'Not broadcast — stale: ' + (r.error || 'inputs spent') + '.';
    if (r.action === 'skipped') return 'Skipped — ' + (r.reason || 'already broadcast') + '.';
    return 'Broadcast failed: ' + (r.error || 'unknown error') + '.';
  }

  // Broadcast Now: one transaction, immediately, on the owner's word.
  // The dialog says plainly that the funds move for real.
  async function broadcastNow(id) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === id; });
    if (!tx || tx.broadcasted) return;
    var label = txDisplayName(tx);
    showConfirm('Broadcast this transaction?',
      'This will broadcast "' + label + '" to the network for real — the funds move and it cannot be undone. The inputs are re-checked first (a stale transaction is not sent), then it broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        try {
          var r = await api('POST', '/api/bitcoin/txs/' + encodeURIComponent(id) + '/broadcast', {});
          setMsg($('btc-all-msg'), broadcastResultText(r), r.action === 'broadcast');
          await load();
          await refreshConfirmations();
        } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
      },
      'Broadcast — I understand');
  }

  // Broadcast a whole set now, in order; a stale member is skipped, the
  // rest go.
  async function broadcastSetNow(id) {
    var set = (S.bitcoin.sets || []).find(function (s) { return s.id === id; });
    if (!set) return;
    var members = setMembersOf(set);
    if (!members.length) return;
    var label = set.label || 'Untitled set';
    showConfirm('Broadcast this trigger set?',
      'This will broadcast all ' + members.length + ' transaction' + (members.length === 1 ? '' : 's') + ' in "' + label + '" to the network for real — the funds move and it cannot be undone. The inputs are re-checked first: a stale member is skipped, not sent, and the rest still broadcast. Each one broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        try {
          var r = await api('POST', '/api/bitcoin/sets/' + encodeURIComponent(id) + '/broadcast', {});
          var sent = (r.results || []).filter(function (x) { return x.action === 'broadcast'; }).length;
          var stale = (r.results || []).filter(function (x) { return x.action === 'stale'; }).length;
          var failed = (r.results || []).filter(function (x) { return x.action === 'failed'; }).length;
          var summary = 'Trigger set: ' + sent + ' broadcast' + (stale ? ', ' + stale + ' stale' : '') + (failed ? ', ' + failed + ' failed' : '') + '.';
          setMsg($('btc-all-msg'), summary, failed === 0);
          await load();
          await refreshConfirmations();
        } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
      },
      'Broadcast — I understand');
  }

  // Broadcast a Slipstream-pending tx publicly: manual only, never part of
  // Broadcast Armed or the release. The confirm names the privacy cost. On
  // success it becomes a public pending tx; on failure it stays
  // Slipstream-pending.
  async function broadcastPublic(id) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === id; });
    if (!tx || !(tx.release && tx.release.status === 'submitted-slipstream')) return;
    var label = txDisplayName(tx);
    showConfirm('Broadcast this transaction publicly?',
      'This will broadcast "' + label + '" to the PUBLIC mempool for real — the funds move and it cannot be undone. It is currently waiting on MARA Slipstream, where it stays private until MARA mines it. Broadcasting publicly makes it visible to everyone in the public mempool — it gives up the Slipstream privacy. The inputs are re-checked first (a stale transaction is not sent), then it broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      async function () {
        try {
          var r = await api('POST', '/api/bitcoin/txs/' + encodeURIComponent(id) + '/broadcast-public', {});
          setMsg($('btc-all-msg'), broadcastResultText(r), r.action === 'broadcast');
          await load();
          await refreshConfirmations();
        } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
      },
      'Broadcast publicly — I understand');
  }

  // Broadcast Armed: sends only armed, unbroadcast txs (filtered here and
  // on the server via armedOnly), after a confirm naming the count. A pop-
  // out lists each result as it lands; closing it early leaves the summary
  // line. Slipstream-pending txs are never sent publicly by this.
  async function broadcastArmed() {
    // Members are broadcast through their set (their arm lives there), not
    // as standalone txs.
    var pending = (S.bitcoin.txs || []).filter(function (t) { return !txStatus(t).settled && !txStatus(t).pending && !setOfTxId(t.id); });
    var armedSets = (S.bitcoin.sets || []).filter(function (s) { return s.enabled && !setStatus(s).settled && !setStatus(s).pending && setMembersOf(s).length; });
    if (!pending.length && !armedSets.length) {
      setMsg($('btc-all-msg'),
        (S.bitcoin.txs || []).length
          ? 'Nothing to broadcast — every transaction is already archived or pending.'
          : 'Nothing to broadcast — no transactions stored.',
        true);
      return;
    }
    var armed = pending.filter(function (t) { return t.enabled; });
    if (!armed.length && !armedSets.length) {
      setMsg($('btc-all-msg'), 'Nothing to broadcast — no armed transactions to broadcast.', true);
      return;
    }
    var parts = [];
    if (armed.length) parts.push('the ' + armed.length + ' armed transaction(s)');
    if (armedSets.length) parts.push('the ' + armedSets.length + ' armed trigger set(s) (' + armedSets.reduce(function (n, s) { return n + setMembersOf(s).length; }, 0) + ' transaction(s))');
    showConfirm('Broadcast armed transactions?',
      'This will broadcast for real — the funds move and it cannot be undone. This sends only ' + parts.join(' and ') + '; unarmed ones are left alone. Each one is checked first (a stale one is skipped, not sent) and broadcasts via the primary node, falling back to the secondary if the primary does not answer.',
      function () { runBroadcastAll(armed, true, 'Broadcast armed', armedSets); },
      'Broadcast — I understand');
  }

  // The Broadcast Armed run after the confirm: armed txs via armedOnly,
  // armed sets one at a time; results combined in one pop-out.
  async function runBroadcastAll(targets, armedOnly, label, setTargets) {
    setTargets = setTargets || [];
    if (!targets.length && !setTargets.length) {
      setMsg($('btc-all-msg'), 'Nothing to broadcast — no armed transactions to broadcast.', true);
      return;
    }
    // Standalone targets only; a label-less one reads its short txid.
    var names = targets.map(txDisplayName);
    setTargets.forEach(function (s) {
      names.push((s.label || 'Untitled set') + ' (set: ' + setMembersOf(s).length + ' transactions)');
    });
    showDetails(label + ' — broadcasting',
      'Attempting to broadcast ' + targets.length + ' transaction(s)' + (setTargets.length ? ' and ' + setTargets.length + ' trigger set(s)' : '') + '…',
      '<ul class="plain-list">' + names.map(function (n) {
        return '<li>' + escapeHtml(n) + ' — pending…</li>';
      }).join('') + '</ul>');
    try {
      var allResults = [];
      if (targets.length) {
        var body = { ids: targets.map(function (t) { return t.id; }) };
        if (armedOnly) body.armedOnly = true;
        var r = await api('POST', '/api/broadcast/all', body);
        allResults = allResults.concat(r.results || []);
      }
      for (var si = 0; si < setTargets.length; si++) {
        var sr = await api('POST', '/api/bitcoin/sets/' + encodeURIComponent(setTargets[si].id) + '/broadcast', {});
        allResults = allResults.concat(sr.results || []);
      }
      var sent = allResults.filter(function (x) { return x.action === 'broadcast'; }).length;
      var stale = allResults.filter(function (x) { return x.action === 'stale'; }).length;
      var failed = allResults.filter(function (x) { return x.action === 'failed'; }).length;
      var summary = label + ': ' + sent + ' broadcast' + (stale ? ', ' + stale + ' stale' : '') + (failed ? ', ' + failed + ' failed' : '') + '.';
      setMsg($('btc-all-msg'), summary, failed === 0);
      await load();
      await refreshConfirmations();
      if ($('confirm-modal').classList.contains('open')) {
        showDetails(label + ' — ' + (failed ? 'finished with failures' : 'complete'),
          summary,
          '<ul class="plain-list">' + allResults.map(function (x) {
            // Member results carry an empty label: resolve the tx so it
            // reads '"<set label>" - Tx N'.
            var xt = x.id ? (S.bitcoin.txs || []).find(function (t) { return t.id === x.id; }) : null;
            var xname = xt ? txDisplayName(xt) : (x.label || '');
            return '<li>' + escapeHtml(xname) + ' — ' + escapeHtml(broadcastResultText(x)) + '</li>';
          }).join('') + '</ul>');
      }
    } catch (e) {
      setMsg($('btc-all-msg'), e.message, false);
      if ($('confirm-modal').classList.contains('open')) showDetails(label + ' — failed', e.message, '');
    }
  }

  $('btn-btc-broadcast-armed').addEventListener('click', broadcastArmed);

  $('btn-btc-test-all').addEventListener('click', async function () {
    var before = inactiveIds();
    try {
      var r = await api('POST', '/api/broadcast/test', {});
      // Each transaction's own result goes in its own card; the line
      // below is only the aggregate.
      (r.results || []).forEach(function (one) {
        if (one.id) dryRunResults[one.id] = { text: 'Dry-run: ' + (one.note || one.error || ''), ok: !!one.wouldBroadcast,
          verdict: one.verdict || '',
          spent: !!(one.spent && one.spent.length), unknown: !!(one.unknown && one.unknown.length), error: !!one.error };
      });
      // Shared-input warnings reappear from the state on the next load.
      // The summary line is amber when only timelocks stopped a broadcast
      // (a warning), default when nothing would broadcast by choice, red
      // only when a tx errored.
      var anyTimelocked = (r.results || []).some(function (one) { return one.verdict === 'timelocked'; });
      var anyError = (r.results || []).some(function (one) { return one.error; });
      setMsg($('btc-all-msg'), 'Dry-run: ' + (r.note || '') + ' Nothing was broadcast.', r.wouldBroadcast ? true : (anyError ? false : (anyTimelocked ? 'warn' : true)));
      await load();
      // The ones this run found spent move to Archived — pop up a
      // notice naming them (only the ones that moved in this run).
      var moved = (r.results || []).filter(function (one) { return one.spent && one.spent.length; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, moved);
      // Same for the ones this run found already out there (own txid)
      // — a different notice, with the broadcast wording.
      var movedOut = (r.results || []).filter(function (one) { return one.verdict === 'broadcast'; })
        .map(function (one) { return { id: one.id, label: one.label || '' }; });
      noticeMovedToArchive(before, movedOut, 'broadcast');
    } catch (e) { setMsg($('btc-all-msg'), e.message, false); }
  });

  // Confirmation counts, polled every minute while any tx is broadcast
  // (also refreshed hourly server-side). A failure keeps the last value.
  async function refreshConfirmations() {
    var txs = (S && S.bitcoin.txs || []).filter(function (t) { return t.broadcasted; });
    if (!txs.length) return;
    try {
      var r = await api('GET', '/api/bitcoin/confirmations');
      var bucketChanged = false;
      (r.confirmations || []).forEach(function (c) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === c.id; });
        if (tx && tx.broadcasted) {
          var before = txStatus(tx);
          tx.broadcasted.confirmations = c.confirmations;
          tx.broadcasted.blockHeight = c.blockHeight;
          tx.broadcasted.found = c.found;
          tx.broadcasted.checkedAt = c.checkedAt;
          // The not-found verdict rides the same refresh:
          // a null clears a verdict the server cleared (or never set).
          if (c.staleInput) tx.broadcasted.staleInput = c.staleInput; else delete tx.broadcasted.staleInput;
          if (c.conflictInput) tx.broadcasted.conflictInput = c.conflictInput; else delete tx.broadcasted.conflictInput;
          var after = txStatus(tx);
          if (before.settled !== after.settled || before.pending !== after.pending) bucketChanged = true;
        }
        var card = txCardEls[c.id];
        if (card && card.sentLine && tx) {
          card.sentLine.textContent = txBroadcastLine(tx);
          card.sentLine.className = broadcastLineCls(tx);
        }
        // The pill follows the network verdict too (Broadcasted to Failed
        // and back) without a reload.
        if (card && card.pill && tx) {
          var pst = txStatus(tx);
          card.pill.textContent = pst.label;
          card.pill.className = 'pill ' + pst.cls;
        }
      });
      // A tx that changed buckets needs a full re-render to move cards;
      // this cannot loop, since buckets only move forward and
      // confirmations are cached for 60 s.
      if (bucketChanged) await load();
    } catch (e) { /* the last known value stays on the card */ }
  }
  setInterval(refreshConfirmations, 60 * 1000);

  // Live view: a 1-second timer recomputes the check-in countdown (no
  // fetch) and refreshes from the server once per check cadence (clamped
  // to 10–3600 s). The refresh patches values in place; a structural
  // change (a tx added, removed or moved) waits until no popup is open and
  // no field is focused, then reloads. Inputs, selects and popups are
  // never written to.
  function liveCadenceMs() {
    var c = (S.settings && typeof S.settings.checkCadenceSeconds === 'number') ? S.settings.checkCadenceSeconds : 60;
    if (!isFinite(c)) c = 60;
    c = Math.max(10, Math.min(3600, c));
    return c * 1000;
  }
  // Structural signature: whatever a value patch cannot change (the tx set
  // and buckets, labels, notes, triggers, broadcast state, history length,
  // shared inputs, settings, bar keys, source count, key ids). Everything
  // else patches in place.
  function liveSignature(state, status, keys) {
    var txs = (state.bitcoin && state.bitcoin.txs) || [];
    var sigTxs = txs.map(function (t) {
      var st = txStatus(t);
      return {
        id: t.id, label: t.label || '', notes: t.notes || '', enabled: !!t.enabled,
        txid: t.txid || '', inputs: t.inputs, outputs: t.outputs,
        feeSats: (t.feeSats === null || t.feeSats === undefined) ? null : t.feeSats,
        broadcastVia: t.broadcastVia || '', publicFallbackDays: (t.publicFallbackDays === null || t.publicFallbackDays === undefined) ? null : t.publicFallbackDays,
        locktime: t.locktime || 0,
        trigger: triggerSetOf(t),
        broadcasted: !!t.broadcasted,
        releaseStatus: (t.release && t.release.status) || '',
        historyLen: Array.isArray(t.history) ? t.history.length : 0,
        bucket: st.settled ? 'settled' : (st.pending ? 'pending' : 'active'),
      };
    });
    // Sets are structural too (bucket, label, arm, members, rules, history
    // length).
    var sigSets = ((state.bitcoin && state.bitcoin.sets) || []).map(function (s) {
      var sst = setStatus(s);
      return {
        id: s.id, label: s.label || '', enabled: !!s.enabled,
        txIds: (s.txIds || []).slice(),
        trigger: triggerSetOf(s),
        historyLen: Array.isArray(s.history) ? s.history.length : 0,
        bucket: sst.settled ? 'settled' : (sst.pending ? 'pending' : 'active'),
      };
    });
    var bars = checkinBarsData(status).map(function (b) { return b.id + ':' + (typeof b.ruleIndex === 'number' ? b.ruleIndex : 0); });
    return JSON.stringify({
      txs: sigTxs,
      sets: sigSets,
      overlaps: (state.bitcoin && state.bitcoin.overlaps) || [],
      settings: state.settings || {},
      bars: bars,
      exSources: ((state.bitcoin && state.bitcoin.exchangeStatus && state.bitcoin.exchangeStatus.sources) || []).length,
      keys: (keys || []).map(function (k) { return k.id; }),
    });
  }
  // A full re-render is safe only with no popup open and no field focused.
  function anyModalOpen() {
    return ['add-modal', 'edit-modal', 'set-modal', 'confirm-modal'].some(function (id) {
      var m = $(id);
      return m && m.classList && m.classList.contains('open');
    });
  }
  function safeToRestructure() {
    if (stateErrorShown) return false;
    if (anyModalOpen()) return false;
    var ae = (typeof document !== 'undefined') ? document.activeElement : null;
    if (ae && ae.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return false;
    return true;
  }
  // Patch the check-in bars in place, matched by tx and rule (only fill,
  // colour and caption change).
  function patchCheckinBars(status) {
    var barsEl = $('checkin-tx-bars');
    if (!barsEl) return;
    var bars = checkinBarsData(status);
    var byKey = {};
    var barsById = {};
    bars.forEach(function (b) {
      byKey[b.id + ':' + (typeof b.ruleIndex === 'number' ? b.ruleIndex : 0)] = b;
      barsById[b.id] = (barsById[b.id] || 0) + 1;
    });
    Array.prototype.forEach.call(barsEl.children || [], function (block) {
      if (!(block.className || '').split(' ').includes('ck-tx')) return;
      var key = (block.dataset && block.dataset.txId) + ':' + ((block.dataset && block.dataset.ruleIndex !== undefined) ? block.dataset.ruleIndex : 0);
      var b = byKey[key];
      if (!b) return;
      var daysSince = b.daysSince || 0;
      var windowDays = (typeof b.windowDays === 'number' && b.windowDays > 0) ? b.windowDays : (b.thresholdDays || 35);
      var frozen = b.enabled === false;
      block.className = 'ck-tx' + (frozen ? ' frozen' : '');
      block.dataset.windowDays = windowDays;
      var label = block.children[0];
      if (label) label.textContent = barLabel(b) + ((barsById[b.id] || 0) > 1 && typeof b.ruleIndex === 'number' ? ' — Rule ' + (b.ruleIndex + 1) : '');
      var bar = block.children[1];
      var fill = bar && bar.children[0];
      if (fill) {
        fill.style.width = (Math.min(1, Math.max(0, daysSince / windowDays)) * 100) + '%';
        var remaining = (windowDays - daysSince) / windowDays;
        fill.style.background = frozen ? 'var(--muted)' : b.state === 'grace' ? 'var(--warn)' : remaining > 0.75 ? 'var(--ok)' : remaining > 0.25 ? 'var(--warn)' : 'var(--bad)';
      }
      var cap = block.children[2];
      if (cap) cap.textContent = daysSince + ' of ' + windowDays + ' days elapsed' + (frozen ? ' — disarmed, frozen' : b.state === 'grace' ? ' — held by grace' : '');
    });
  }
  // Patch the readiness rows in place (status and fee pills; set rows by
  // setPillText, keyed 'set:' + id). Only rows the render created are
  // touched, so a tick never adds or revives a row or member line; a
  // member leaving live is structural.
  function patchReadinessRows() {
    readinessEntries().forEach(function (e) {
      var key = e.kind === 'set' ? 'set:' + e.set.id : e.tx.id;
      var entry = readinessEls[key];
      if (!entry) return;
      if (e.kind === 'set') {
        var sst = setStatus(e.set);
        entry.pill.textContent = setPillText(e.set, sst);
        entry.pill.className = 'pill ' + sst.cls;
        setMembersOf(e.set).forEach(function (m, i) {
          var mst = txStatus(m);
          if (mst.settled || mst.pending) return;
          var ment = readinessEls[m.id];
          if (!ment) return;
          var parts = readinessMemberParts(m, i + 1);
          if (ment.left) fillMemberLeft(ment.left, m, i + 1);
          if (ment.amt) ment.amt.textContent = parts.amt;
        });
        return;
      }
      var st = txStatus(e.tx);
      entry.pill.textContent = txPillText(e.tx, st);
      entry.pill.className = 'pill ' + st.cls;
      var fv = txFeeVerdict(e.tx);
      if (fv) {
        if (entry.feePill) {
          entry.feePill.textContent = feePillText(fv);
          entry.feePill.className = 'pill fee-pill ' + feeVerdictCls(fv);
        } else {
          var fpill = document.createElement('span');
          fpill.className = 'pill fee-pill ' + feeVerdictCls(fv);
          fpill.textContent = feePillText(fv);
          entry.row.appendChild(fpill);
          entry.feePill = fpill;
        }
      } else if (entry.feePill) {
        if (Array.prototype.indexOf.call(entry.row.children, entry.feePill) !== -1) entry.row.removeChild(entry.feePill);
        entry.feePill = null;
      }
    });
  }
  // Patch one tx card in place (pills, state lines, sent line, fee suffix,
  // queue line, fallback countdown); nothing structural.
  function patchTxCard(tx, overlapsByTx) {
    var card = txCardEls[tx.id];
    if (!card) return;
    var st = txStatus(tx);
    var pillCls = st.cls;
    if (pillCls === 'ok' && overlapsByTx[tx.id] && overlapsByTx[tx.id].length) pillCls = 'warn';
    card.pill.textContent = txPillText(tx, st);
    card.pill.className = 'pill ' + pillCls;
    var ruleSet = triggerSetOf(tx);
    var ruleStates = triggerStatesOf(tx);
    (card.rules || []).forEach(function (r, i) {
      var rule = ruleSet.rules[i];
      var ts = ruleStates[i] || {};
      if (r.pillEl) {
        var rp = rule ? ruleStatePill(rule, ts) : null;
        if (rp) { r.pillEl.textContent = rp.text; r.pillEl.className = 'pill ' + rp.cls; }
      }
      if (r.condEl && rule) r.condEl.textContent = triggerCondition(rule);
      if (r.nowEl && rule) r.nowEl.textContent = triggerStateLine(rule, ts);
    });
    if (card.sentLine) {
      card.sentLine.textContent = txReleaseLine(tx);
      card.sentLine.className = broadcastLineCls(tx);
    }
    if (card.feeVerdictEl) {
      var fv = txFeeVerdict(tx);
      if (fv) {
        card.feeVerdictEl.textContent = ' — ' + fv;
        card.feeVerdictEl.className = 'fee-verdict ' + feeVerdictCls(fv);
      } else {
        card.feeVerdictEl.textContent = '';
      }
    }
    if (card.maraEl) {
      var ml = txMaraLine(tx);
      card.maraEl.textContent = ml;
      card.maraEl.style.display = ml ? '' : 'none';
    }
    if (card.fallbackValueEl) card.fallbackValueEl.textContent = txFallbackText(tx, st);
  }
  // Patch one set card in place: header pill and rule lines.
  function patchSetCard(set) {
    var card = setCardEls[set.id];
    if (!card) return;
    var st = setStatus(set);
    card.pill.textContent = setPillText(set, st);
    card.pill.className = 'pill ' + st.cls;
    var ruleSet = triggerSetOf(set);
    var ruleStates = triggerStatesOf(set);
    (card.rules || []).forEach(function (r, i) {
      var rule = ruleSet.rules[i];
      var ts = ruleStates[i] || {};
      if (r.pillEl) {
        var rp = rule ? ruleStatePill(rule, ts) : null;
        if (rp) { r.pillEl.textContent = rp.text; r.pillEl.className = 'pill ' + rp.cls; }
      }
      if (r.condEl && rule) r.condEl.textContent = triggerCondition(rule);
      if (r.nowEl && rule) r.nowEl.textContent = triggerStateLine(rule, ts);
    });
  }
  // Patch every live value from the fresh state, never rebuilding lists,
  // inputs or popups, so it can run while the owner types.
  function patchLive(status, checkins, blog) {
    renderStatusHead(status);
    renderGraceCard();
    var anyStaged = (S.bitcoin.txs || []).some(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    var gsCard = $('getting-started-card');
    if (gsCard) gsCard.style.display = anyStaged ? 'none' : '';
    var anyCheckinActive = (S.bitcoin.txs || []).some(function (t) { return hasRuleType(t, 'checkin') && !txStatus(t).settled && !txStatus(t).pending && !setOfTxId(t.id); })
      || (S.bitcoin.sets || []).some(function (s) { return hasRuleType(s, 'checkin') && !setStatus(s).settled && !setStatus(s).pending; });
    var showCheckin = anyCheckinActive;
    $('checkin-card').style.display = showCheckin ? '' : 'none';
    patchCheckinBars(status);
    patchReadinessRows();
    var conn = (S.bitcoin && S.bitcoin.connection) || {};
    renderNodeStatus('readiness-', 'primary', nodeBase('primary', status.nodeBases), conn);
    renderNodeStatus('readiness-', 'secondary', nodeBase('secondary', status.nodeBases), conn);
    renderExchangeRows(status);
    // The Logs tab has no inputs in it — rebuilding its rows is
    // safe any time, even with a pop-out open over it.
    renderLogs(checkins, blog);
    var overlapsByTx = computeOverlaps();
    (S.bitcoin.txs || []).forEach(function (tx) { patchTxCard(tx, overlapsByTx); });
    (S.bitcoin.sets || []).forEach(function (s) { patchSetCard(s); });
    // Settings live updates touch text only, never input values.
    renderNodeStatus('btc-', 'primary', nodeBase('primary', S.bitcoin.nodeBases), conn);
    renderNodeStatus('btc-', 'secondary', nodeBase('secondary', S.bitcoin.nodeBases), conn);
    refreshPriceSourceRow(1);
    refreshPriceSourceRow(2);
    var agreeSpan = $('price-sources-agreement');
    if (agreeSpan) agreeSpan.textContent = ((S.settings && typeof S.settings.priceAgreementPct === 'number') ? S.settings.priceAgreementPct : 5) + '%';
    updateFeeZoneBar();
  }
  // Whole days since the effective last check-in (same math as the
  // server); null before any check-in.
  function checkinDaysSince(tx, nowMs) {
    var last = (S.checkin && S.checkin.lastCheckinAt) ? new Date(S.checkin.lastCheckinAt).getTime() : NaN;
    if (!isFinite(last)) return null;
    var effLast = last + liveOffsetMs(tx);
    return Math.max(0, Math.floor((nowMs - effLast) / 86400000));
  }
  // Check-in countdown, ticked every second from the clock (no fetch), so
  // a day boundary shows within a second. Only the day count moves; pills
  // come from the server.
  function tickCheckinCountdownLocal() {
    if (!S || !lastStatus) return;
    var nowMs = Date.now();
    var barsEl = $('checkin-tx-bars');
    if (barsEl) {
      Array.prototype.forEach.call(barsEl.children || [], function (block) {
        if (!(block.className || '').split(' ').includes('ck-tx')) return;
        // A bar's id is a tx id or a set id — a set bar
        // ticks the same way, off the set's own offset.
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === (block.dataset && block.dataset.txId); })
          || (S.bitcoin.sets || []).find(function (s) { return s.id === (block.dataset && block.dataset.txId); });
        if (!tx) return;
        var windowDays = block.dataset && Number(block.dataset.windowDays);
        if (!windowDays || windowDays <= 0) return;
        var d = checkinDaysSince(tx, nowMs);
        if (d === null) return;
        var frozen = (block.className || '').split(' ').includes('frozen');
        var fill = block.children[1] && block.children[1].children[0];
        if (fill) {
          fill.style.width = (Math.min(1, Math.max(0, d / windowDays)) * 100) + '%';
          var remaining = (windowDays - d) / windowDays;
          fill.style.background = frozen ? 'var(--muted)' : remaining > 0.75 ? 'var(--ok)' : remaining > 0.25 ? 'var(--warn)' : 'var(--bad)';
        }
        var cap = block.children[2];
        if (cap) cap.textContent = d + ' of ' + windowDays + ' days elapsed' + (frozen ? ' — disarmed, frozen' : '');
      });
    }
    (S.bitcoin.txs || []).forEach(function (tx) {
      var card = txCardEls[tx.id];
      if (!card || !card.rules) return;
      var ruleSet = triggerSetOf(tx);
      var ruleStates = triggerStatesOf(tx);
      card.rules.forEach(function (r, i) {
        var rule = ruleSet.rules[i];
        var ts = ruleStates[i] || {};
        if (!rule || rule.type !== 'checkin' || !r.nowEl) return;
        if (ts.status !== 'on-track' && ts.status !== 'held') return;
        var d = checkinDaysSince(tx, nowMs);
        if (d === null) return;
        var w = (typeof ts.windowDays === 'number' && ts.windowDays > 0) ? ts.windowDays : (rule.params.thresholdDays || 35);
        r.nowEl.textContent = ts.status === 'on-track'
          ? d + ' of ' + w + ' days since last check-in'
          : d + ' of ' + w + ' days elapsed';
      });
    });
    // The same local tick for a set card's shared
    // check-in rule lines.
    (S.bitcoin.sets || []).forEach(function (set) {
      var scard = setCardEls[set.id];
      if (!scard || !scard.rules) return;
      var sruleSet = triggerSetOf(set);
      var sruleStates = triggerStatesOf(set);
      scard.rules.forEach(function (r, i) {
        var srule = sruleSet.rules[i];
        var sts = sruleStates[i] || {};
        if (!srule || srule.type !== 'checkin' || !r.nowEl) return;
        if (sts.status !== 'on-track' && sts.status !== 'held') return;
        var sd = checkinDaysSince(set, nowMs);
        if (sd === null) return;
        var sw = (typeof sts.windowDays === 'number' && sts.windowDays > 0) ? sts.windowDays : (srule.params.thresholdDays || 35);
        r.nowEl.textContent = sts.status === 'on-track'
          ? sd + ' of ' + sw + ' days since last check-in'
          : sd + ' of ' + sw + ' days elapsed';
      });
    });
  }
  // Hold the scroll position across a structural re-render.
  async function loadPreservingScroll() {
    var y = (typeof window !== 'undefined' && typeof window.scrollY === 'number') ? window.scrollY : 0;
    await load();
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, y);
  }
  // One refresh: patch values, or reload on a structural change when safe
  // (else patch and defer). A failed fetch keeps the last values.
  async function liveRefresh() {
    if (liveRefreshInFlight) return;
    liveRefreshInFlight = true;
    try {
      var ns = await api('GET', '/api/state');
      var nstatus = await api('GET', '/api/status');
      var ncheckins = await api('GET', '/api/checkins');
      var nblog = await api('GET', '/api/broadcast/log');
      var nkeys = apiKeys;
      try { nkeys = await api('GET', '/api/checkin-keys'); } catch (e) { nkeys = apiKeys; }
      // Commit the fresh data first — the signature and every
      // patch below read S / lastStatus.
      S = ns;
      lastStatus = nstatus;
      apiKeys = nkeys;
      lastFetchAt = Date.now();
      var sig = liveSignature(S, nstatus, nkeys);
      if (sig === lastLiveSignature) {
        patchLive(nstatus, ncheckins, nblog);
        pendingStructural = false;
      } else if (safeToRestructure()) {
        await loadPreservingScroll();
        pendingStructural = false;
      } else {
        // Values keep updating behind a popup or while typing; structure
        // waits for a safe moment.
        patchLive(nstatus, ncheckins, nblog);
        pendingStructural = true;
      }
    } catch (e) {
      /* the last known values stay on screen; the next tick retries */
    } finally {
      liveRefreshInFlight = false;
    }
  }
  // The 1-second timer: countdown, refresh once per cadence, deferred
  // reload when safe. Paused while the tab is hidden.
  async function liveSecondTick() {
    if (liveTickRunning) return;
    if (!S || stateErrorShown) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    liveTickRunning = true;
    try {
      tickCheckinCountdownLocal();
      if (pendingStructural && safeToRestructure()) {
        pendingStructural = false;
        try { await loadPreservingScroll(); } catch (e) { /* a failed load leaves the values stale; the next tick retries */ }
        return;
      }
      if (!liveRefreshInFlight && lastFetchAt && (Date.now() - lastFetchAt >= liveCadenceMs())) {
        await liveRefresh();
      }
    } finally {
      liveTickRunning = false;
    }
  }
  // One 1-second timer, not a cadence interval, so a cadence change
  // applies at once and the countdown keeps ticking.
  setInterval(liveSecondTick, 1000);

  // ---------- settings ----------
  function renderSettings() {
    loadRemoteCheckin();
    loadDesktop();
    loadUpdate();
    $('set-vacation').checked = !!S.settings.vacationMode;
    $('set-vacation-until').value = S.settings.vacationUntil || '';
    // No end date means indefinite; the checkbox mirrors it and disables
    // the date.
    $('set-vacation-indefinite').checked = !S.settings.vacationUntil;
    $('set-vacation-until').disabled = !S.settings.vacationUntil;
    // A new check-in rule defaults to 35 days, only while the Add form is
    // untouched.
    if (!$('btc-hex').value.trim()) {
      if (ruleLists.btc.panels.length) ruleLists.btc.panels[0].f.threshold.value = '35';
    }
    // Price source selects, from the server's provider list (with a
    // fallback copy), plus each source's last price.
    var providers = (S.bitcoin && Array.isArray(S.bitcoin.priceProviders) && S.bitcoin.priceProviders.length)
      ? S.bitcoin.priceProviders
      : [
        { id: 'coingecko', label: 'CoinGecko' },
        { id: 'coinbase', label: 'Coinbase' },
        { id: 'binance', label: 'Binance US (USDT)' },
        { id: 'kraken', label: 'Kraken' },
        { id: 'bitstamp', label: 'Bitstamp' },
        { id: 'custom', label: 'Custom' },
      ];
    var psrc = (S.settings && S.settings.priceSources) || { source1: 'coingecko', source2: 'coinbase' };
    function fillPriceSelect(sel, val) {
      sel.innerHTML = '';
      providers.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.label;
        sel.appendChild(o);
      });
      sel.value = (val && typeof val === 'object') ? 'custom' : val;
    }
    fillPriceSelect($('set-price-source1'), psrc.source1 || 'coingecko');
    fillPriceSelect($('set-price-source2'), psrc.source2 || 'coinbase');
    // Custom sources show their saved URL and path (visibility set by
    // refreshPriceSourceCustom).
    [1, 2].forEach(function (n) {
      var v = psrc['source' + n];
      if (v && typeof v === 'object') {
        var u = $('set-price-source' + n + '-url'); if (u) u.value = v.url || '';
        var pp = $('set-price-source' + n + '-path'); if (pp) pp.value = v.path || '';
      }
      refreshPriceSourceCustom(n);
    });
    // The row shows the provider with its last price beside its pill
    // ("Kraken $98,200 [OK]"), from the last test or else the cached
    // reading. Dropdown changes re-render the row, so it and Test
    // connection always mean the same provider.
    refreshPriceSourceRow(1);
    refreshPriceSourceRow(2);
    // Grace settings reflect the saved values; the toggle is the off
    // switch (missing means on), and a stored 0 duration displays as 7.
    // Only values are set, so a re-render never clobbers a choice in
    // progress.
    $('grace-enabled').checked = S.settings.graceEnabled !== false;
    var go = (S.settings && typeof S.settings.graceOfflineDays === 'number') ? S.settings.graceOfflineDays : 7;
    $('set-grace-offline').value = String(go);
    var gd = (S.settings && S.settings.graceDurationDays !== undefined) ? S.settings.graceDurationDays : 7;
    if (gd === 0) gd = 7; // a stored 0 meant off; the toggle says off now
    $('set-grace-duration').value = (gd === null) ? 'indefinite' : String(gd);
    syncGraceEnabled();
    // The number inputs reflect the saved settings; save handlers read the
    // inputs, so a re-render never clobbers typing.
    var pa = (S.settings && typeof S.settings.priceAgreementPct === 'number') ? S.settings.priceAgreementPct : 5;
    $('set-price-agreement').value = String(pa);
    var agreeSpan = $('price-sources-agreement');
    if (agreeSpan) agreeSpan.textContent = pa + '%';
    var cc = (S.settings && typeof S.settings.checkCadenceSeconds === 'number') ? S.settings.checkCadenceSeconds : 60;
    $('set-check-cadence').value = String(cc);
    var fl = (S.settings && typeof S.settings.feeLowMultiplier === 'number') ? S.settings.feeLowMultiplier : 2;
    $('set-fee-low').value = String(fl);
    var fm = (S.settings && typeof S.settings.feeMediumMultiplier === 'number') ? S.settings.feeMediumMultiplier : 1;
    $('set-fee-medium').value = String(fm);
    updateFeeZoneBar();
    // The fee-history note: what the peak covers, or that it is still
    // building (24 readings over a day).
    var fhn = $('fee-history-note');
    if (fhn) {
      var fobs = (S.bitcoin && typeof S.bitcoin.feePeakObservations === 'number') ? S.bitcoin.feePeakObservations : 0;
      var fwin = (S.bitcoin && typeof S.bitcoin.feePeakWindowDays === 'number') ? S.bitcoin.feePeakWindowDays : 0;
      fhn.textContent = (S.bitcoin && typeof S.bitcoin.feePeak === 'number')
        ? 'Peak from ' + fwin + (fwin === 1 ? ' day' : ' days') + ' of hourly observations (' + fobs + ' readings).'
        : 'Fee history is still building: ' + fobs + ' of 24 hourly observations. The peak appears after a day.';
    }
    renderApiKeys();
  }

  // Price sources: each row's pill reads OK, Failed or Not Tested. A test
  // verdict (kept per row this session) wins; changing the dropdown
  // deletes it, and without one the row uses the cached reading only if
  // the dropdown still holds the saved source (else Not Tested, never a
  // wrong price). Keying by row lets a tested source stay OK after saving.
  // Listeners are attached once, here. Custom URL and path inputs show
  // only for Custom.
  function refreshPriceSourceCustom(n) {
    var sel = $('set-price-source' + n);
    var box = $('price-source' + n + '-custom');
    if (!sel || !box) return;
    box.style.display = (sel.value === 'custom') ? '' : 'none';
  }
  // Two source values are the same: equal ids, or Custom with the same URL
  // and path.
  function samePriceSource(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    if (!a || !b) return a === b;
    return a.id === b.id && (a.url || '') === (b.url || '') && (a.path || '') === (b.path || '');
  }
  // One source's value for save or test: an id, or a Custom { id, url,
  // path } from its inputs.
  function priceSourceValue(n) {
    var sel = $('set-price-source' + n);
    if (sel && sel.value === 'custom') {
      var u = $('set-price-source' + n + '-url');
      var pp = $('set-price-source' + n + '-path');
      return { id: 'custom', url: u ? u.value.trim() : '', path: pp ? pp.value.trim() : '' };
    }
    return sel ? sel.value : '';
  }
  var priceSourceStatus = {}; // row ('source1'/'source2') -> 'ok' | 'failed' | 'not-tested': the last Test verdict (or change reset) for that row, in this session
  var priceSourcePrice = {}; // row -> the last tested price (a number) or null: the price shown to the right of the pill
  function setPriceSourceStatus(n, state) {
    var pill = $('price-source' + n + '-status');
    if (!pill) return;
    if (state === 'ok') { pill.textContent = 'OK'; pill.className = 'pill ok'; }
    else if (state === 'failed') { pill.textContent = 'Failed'; pill.className = 'pill bad'; }
    else { pill.textContent = 'Not Tested'; pill.className = 'pill muted'; }
  }
  function refreshPriceSourceRow(n, resetStatus) {
    var sel = $('set-price-source' + n);
    var host = $('price-source' + n);
    if (!sel || !host) return;
    var id = sel.value;
    var providers = (S.bitcoin && Array.isArray(S.bitcoin.priceProviders) && S.bitcoin.priceProviders.length)
      ? S.bitcoin.priceProviders
      : [
        { id: 'coingecko', label: 'CoinGecko' },
        { id: 'coinbase', label: 'Coinbase' },
        { id: 'binance', label: 'Binance US (USDT)' },
        { id: 'kraken', label: 'Kraken' },
        { id: 'bitstamp', label: 'Bitstamp' },
        { id: 'custom', label: 'Custom' },
      ];
    var label = id;
    for (var i = 0; i < providers.length; i++) if (providers[i].id === id) { label = providers[i].label; break; }
    var status, price = null;
    if (resetStatus) {
      delete priceSourceStatus['source' + n];
      delete priceSourcePrice['source' + n];
    }
    if (priceSourceStatus['source' + n] === 'ok' || priceSourceStatus['source' + n] === 'failed') {
      status = priceSourceStatus['source' + n];
      price = priceSourcePrice['source' + n];
    } else {
      // No test verdict: use the cached reading only if the dropdown still
      // holds the saved source.
      var saved = (S.settings && S.settings.priceSources) || {};
      var ex = samePriceSource(priceSourceValue(n), saved['source' + n])
        ? ((S.bitcoin && S.bitcoin.exchangeStatus && S.bitcoin.exchangeStatus.sources) || [])
        : [];
      var r = ex[n - 1];
      if (r && r.status === 'ok' && typeof r.price === 'number' && Number.isFinite(r.price)) { status = 'ok'; price = r.price; }
      else if (r && r.status === 'error') { status = 'failed'; }
      else { status = 'not-tested'; }
    }
    host.textContent = label;
    // The price sits beside the pill in small muted text, never in the
    // label.
    var priceEl = $('price-source' + n + '-price');
    if (priceEl) priceEl.textContent = (typeof price === 'number' && Number.isFinite(price)) ? '$' + price.toLocaleString('en-US') : '';
    setPriceSourceStatus(n, status);
  }
  $('set-price-source1').addEventListener('change', function () { refreshPriceSourceRow(1, true); refreshPriceSourceCustom(1); });
  $('set-price-source2').addEventListener('change', function () { refreshPriceSourceRow(2, true); refreshPriceSourceCustom(2); });

  async function savePriceSources() {
    var s = await api('PUT', '/api/settings', { priceSources: { source1: priceSourceValue(1), source2: priceSourceValue(2) } });
    S.settings = s;
  }
  $('btn-save-price-sources').addEventListener('click', async function () {
    try {
      await savePriceSources();
      setMsg($('price-sources-msg'), 'Price sources saved.', true);
      // Verdicts are per row, so saving keeps a tested source OK; a
      // changed source already lost its verdict to its change listener.
      await load();
    } catch (e) { setMsg($('price-sources-msg'), e.message, false); }
  });

  // Grace toggle in the card heading: off hides the dropdowns without
  // clearing them.
  function syncGraceEnabled() {
    var on = $('grace-enabled').checked;
    $('grace-fields').style.display = on ? '' : 'none';
    $('grace-enabled-wrap').title = on ? 'Grace period on — triggers pause after an offline gap' : 'Grace period off — triggers fire immediately';
  }

  // Save grace settings (the server rejects values the dropdowns do not
  // offer). Turning the toggle off keeps the saved values, and ends an
  // active grace everywhere at once; new values do not change an active
  // grace.
  $('btn-save-grace').addEventListener('click', async function () {
    var offline = parseInt($('set-grace-offline').value, 10);
    var durRaw = $('set-grace-duration').value;
    var duration = durRaw === 'indefinite' ? null : parseInt(durRaw, 10);
    try {
      var s = await api('PUT', '/api/settings', { graceEnabled: $('grace-enabled').checked, graceOfflineDays: offline, graceDurationDays: duration });
      S.settings = s;
      setMsg($('grace-settings-msg'), 'Grace period saved.', true);
      await load();
    } catch (e) { setMsg($('grace-settings-msg'), e.message, false); }
  });

  // The grace options hide or show at once; the value saves with Save
  // grace period.
  $('grace-enabled').addEventListener('change', syncGraceEnabled);

  // Each card saves its own fields. parseFloat keeps decimals; a blank
  // field is NaN, sent as null and rejected.
  $('btn-save-price-agreement').addEventListener('click', async function () {
    var v = parseFloat($('set-price-agreement').value);
    try {
      var s = await api('PUT', '/api/settings', { priceAgreementPct: v });
      S.settings = s;
      setMsg($('price-agreement-msg'), 'Price agreement saved.', true);
      await load();
    } catch (e) { setMsg($('price-agreement-msg'), e.message, false); }
  });

  $('btn-save-check-cadence').addEventListener('click', async function () {
    var v = parseFloat($('set-check-cadence').value);
    try {
      var s = await api('PUT', '/api/settings', { checkCadenceSeconds: v });
      S.settings = s;
      setMsg($('check-cadence-msg'), 'Check cadence saved.', true);
      await load();
    } catch (e) { setMsg($('check-cadence-msg'), e.message, false); }
  });

  // Fee verdict zone bar, live as you type; the scale grows past 3x when
  // Low is higher. Critical is fixed, so it is not a zone.
  function updateFeeZoneBar() {
    var bar = $('zone-bar');
    if (!bar) return;
    var low = parseFloat($('set-fee-low').value);
    var med = parseFloat($('set-fee-medium').value);
    if (!isFinite(low) || low <= 0) low = 2;
    if (!isFinite(med) || med < 0) med = 1;
    med = Math.min(med, low);
    var max = Math.max(3, Math.ceil(low) + 1);
    var fmt = function (v) { return String(Math.round(v * 10) / 10); };
    var segHigh = $('seg-high'), segMed = $('seg-med'), segLow = $('seg-low');
    if (segHigh) segHigh.style.flexBasis = Math.max(0, med / max * 100) + '%';
    if (segMed) segMed.style.flexBasis = Math.max(0, (low - med) / max * 100) + '%';
    if (segLow) segLow.style.flexBasis = Math.max(0, (max - low) / max * 100) + '%';
    var rH = $('range-high'), rM = $('range-med'), rL = $('range-low');
    if (rH) rH.textContent = fmt(med) + '× and below';
    if (rM) rM.textContent = fmt(med) + '× – ' + fmt(low) + '×';
    if (rL) rL.textContent = fmt(low) + '× and up';
  }
  // The bar updates live as either number is typed; it is always
  // visible, so there is no focus/blur show/hide.
  ['set-fee-low', 'set-fee-medium'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', updateFeeZoneBar);
  });
  $('btn-save-fee-verdict').addEventListener('click', async function () {
    var low = parseFloat($('set-fee-low').value);
    var med = parseFloat($('set-fee-medium').value);
    try {
      var s = await api('PUT', '/api/settings', { feeLowMultiplier: low, feeMediumMultiplier: med });
      S.settings = s;
      setMsg($('fee-verdict-msg'), 'Broadcast fee risk saved.', true);
      await load();
    } catch (e) { setMsg($('fee-verdict-msg'), e.message, false); }
  });

  // Price sources Test connection: tests whatever the two dropdowns hold,
  // with fresh fetches; nothing configured or cached changes.
  async function testPriceSources() {
    var btn = $('btn-test-price-sources');
    if (!btn) return;
    var ids = [priceSourceValue(1), priceSourceValue(2)];
    btn.disabled = true;
    try {
      var r = await api('POST', '/api/settings/price-sources/test-all', { providers: ids });
      // Results land on the rows (price beside pill), in request order:
      // result i is row i + 1.
      (r.results || []).forEach(function (x, i) {
        var n = i + 1;
        var ok = (typeof x.price === 'number' && Number.isFinite(x.price));
        priceSourceStatus['source' + n] = ok ? 'ok' : 'failed';
        priceSourcePrice['source' + n] = ok ? x.price : null;
        refreshPriceSourceRow(n);
      });
    } catch (e) {
      setMsg($('price-sources-msg'), 'Test failed — ' + e.message, false);
    }
    btn.disabled = false;
  }

  $('btn-test-price-sources').addEventListener('click', testPriceSources);

  // Settings help: each card's "?" opens a pop-out with what the setting
  // does and which trigger types it applies to. This registry is the only
  // mapping of cards to trigger types: the "Applies to" line and the
  // Settings filter both read it.
  var SETTINGS_HELP = {
    vacation: {
      title: 'Vacation mode',
      body: 'Freezes the check-in countdown while you\u2019re away. Leave at 13 of 25 days and you come back to 13 of 25.\n\nCheck-in transactions do not fire while you\u2019re away, but price, UTXO, block-height, set-date, and fee-market triggers keep firing.\n\nSet an end date, or leave it indefinite and it holds until you say you\u2019re back.',
      triggers: ['checkin'],
    },
    arm: {
      title: 'Global Arm/Disarm',
      body: 'Arms or disarms every staged transaction at once \u2014 check-in, BTC price, UTXO, block height, set date, fee market, and manual.\n\nDisarming stops automatic firing for all triggers \u2014 nothing broadcasts on its own. A manual broadcast still works while disarmed.\n\nDisarmed check-in transactions freeze their countdown and resume from the same spot when re-armed.\n\n\u2018Arm all\u2019 arms everything, including transactions you had individually disarmed before.',
      triggers: ['general'],
    },
    nodes: {
      title: 'Bitcoin nodes',
      body: 'The Bitcoin nodes Standby talks to. The primary is tried first; if it fails, the secondary is used.\n\nToggle the secondary off to use the primary alone with no fallback if it is down or unreachable.\n\nEach node is a mempool instance \u2014 mempool.space by default, another public instance, or your own mempool on the LAN \u2014 or, with its RPC toggle on, Bitcoin Core over RPC. An RPC node needs txindex=1 to see spends in blocks; Test connection says if it is off.\n\nUTXO, block-height, and fee-market triggers read the node, and broadcasts go through it.\n\nA mempool running directly on Bitcoin Core reports that an input is spent but not by whom. Standby asks it whether that spend is confirmed instead, and counts a UTXO trigger\u2019s confirmations from when it first sees the confirmed spend.',
      triggers: ['general'],
    },
    'price-sources': {
      title: 'Bitcoin price source',
      body: 'The two price sources Standby reads the BTC price from. Every check, Standby fetches the price from both.\n\nA price trigger only fires when both agree within your price-agreement setting; if one is down, the other is used alone. When they agree, the primary\u2019s price decides.\n\nPick Custom for either source to point Standby at your own endpoint \u2014 give its full URL and the Custom endpoint json path (for example, data.amount).',
      triggers: ['price'],
    },
    grace: {
      title: 'Grace period',
      body: 'A pause for ALL triggers after the app has been offline. If Standby was offline longer than the \u2018offline\u2019 days, automatic broadcasts pause for the \u2018lasts\u2019 days, or until you resume.\n\nTurn it off with the toggle in the card heading.\n\nExample: Your device is offline for 10 days. Rather than broadcasting any transactions when the device powers back on, you enter a grace period. Triggers stay paused for 7 days, or until you clear the grace manually.',
      triggers: ['checkin', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket'],
    },
    agreement: {
      title: 'Price agreement',
      body: 'How closely the two price sources must agree. A price reading only counts if the two sources are within this % of each other. Tighter means safer but more \u2018unknown\u2019 readings during fast moves; looser fires more readily.',
      triggers: ['price'],
    },
    cadence: {
      title: 'Check cadence',
      body: 'How often every trigger is checked. Standby evaluates all triggers together every X seconds.\n\nFaster catches an unconfirmed spend, a brief price spike, or a block height sooner, but makes more API calls.\n\nThe price cache refreshes on this interval too. The fee cache does not: it refreshes once every 5 minutes regardless of this setting.\n\nPublic nodes rate-limit heavy use, so a very fast cadence can get this IP throttled.\n\nExample: at 60 seconds, a price spike that lasts 30 seconds may never be seen; at 10 seconds it will be \u2014 but that\u2019s six times the requests.',
      triggers: ['price', 'utxo', 'blockheight', 'setdate', 'feemarket'],
    },
    fee: {
      title: 'Broadcast Fee Risk',
      body: 'Where the Low / Medium / High fee pill flips. Each transaction\u2019s fee rate is compared to the peak fee \u2014 the 90th percentile of the hourly economy-fee readings Standby records from your nodes, up to 90 days back.\n\nLow Risk is at or above the Low multiplier, Medium Risk at or above the Medium multiplier, High Risk below it. A fee below the current economy fee is Critical Risk.\n\nThe peak needs a day of readings (24 hourly observations) before it appears; until then the pill is hidden and only the current-fee check applies. The pill is informational \u2014 it never blocks a broadcast \u2014 and shows on every staged transaction. The Low multiplier must stay above the Medium one.',
      triggers: ['general'],
    },
    keys: {
      title: 'Check-in API keys',
      body: 'The keys that can check in through the API. Your gadget uses one to tell Standby you\u2019re still here; each check-in resets the countdown on every check-in transaction.\n\nA key can only check in \u2014 no reading transactions, no broadcasts, no settings changes. One key per service, so revoking one leaves the others alone.\n\nKeep keys private: anyone holding one can check in as you. Shown once, at creation \u2014 copy it then.\n\nAs a custom integration: Name \u2018Standby Check-in\u2019, Base URL the connection IP above, Auth: Bearer <redacted> (Authorization: Bearer), Test path /health, API key / token the key you generate below.\n\nPlain HTTP only \u2014 keep port 3101 on your trusted LAN and Tailscale network; never expose it to the internet.',
      triggers: ['checkin'],
    },
    backup: {
      title: 'Data backup',
      body: 'Back up or restore everything Standby knows. A backup is a file holding all your staged transactions, triggers, and settings.\n\nRestoring replaces the current state with the backup\u2019s \u2014 a restore counts as a check-in and clears any active grace period. After restoring, Standby checks each transaction against your node (nothing is broadcast), so one that was already broadcast or went stale goes back to Archived.\n\nDownload it encrypted with a password you choose (recommended) or unencrypted. Encrypted, the file is useless without the password \u2014 and Standby cannot recover a lost password, so write it down somewhere other than this device. Unencrypted, it contains the signed hexes, which anyone can broadcast and which reveal the destination addresses and amounts, so treat it like the transactions themselves.\n\nAn encrypted backup can also be opened without Standby, using tools/decrypt-backup.js from the Standby repository.',
      triggers: ['general'],
    },
    // The version card has no help pop-out; the entry only places it under
    // General for the filter.
    version: {
      triggers: ['general'],
    },
  };
  // The "Applies to" label, derived from the triggers array (one, two, an
  // Oxford list, or "All trigger types"; 'general' alone or appended as
  // general infrastructure).
  var TRIGGER_NAMES = { checkin: 'Check-in', price: 'BTC price', utxo: 'UTXO', manual: 'Manual', blockheight: 'Block height', setdate: 'Set date', feemarket: 'Fee market' };
  function helpAppliesLabel(triggers) {
    var general = triggers.indexOf('general') !== -1;
    var codes = triggers.filter(function (t) { return t !== 'general'; });
    var label;
    if (codes.length === 0) {
      label = 'General — not tied to a specific trigger';
    } else if (codes.length === 7) {
      label = 'All trigger types';
    } else {
      var names = codes.map(function (c) { return TRIGGER_NAMES[c] || c; });
      if (names.length === 1) {
        label = names[0] + ' triggers';
      } else if (names.length === 2) {
        label = names.join(' and ') + ' triggers';
      } else {
        label = names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1] + ' triggers';
      }
      if (codes.length === 1 && !general) label += ' only';
    }
    if (general && codes.length > 0) label += ', and general infrastructure';
    return label;
  }
  Object.keys(SETTINGS_HELP).forEach(function (key) {
    var btn = $('help-' + key);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var h = SETTINGS_HELP[key];
      showDetails(h.title, h.body, '<p><strong>Applies to:</strong> ' + escapeHtml(helpAppliesLabel(h.triggers)) + '</p>');
    });
  });

  // Settings filter: shows cards whose triggers array includes the chosen
  // type; resets to All when the tab opens.
  function applySettingsFilter(name) {
    if (!SETTINGS_HELP) return;
    var sel = $('filter-select');
    if (sel) sel.value = name;
    Object.keys(SETTINGS_HELP).forEach(function (key) {
      var card = $('card-' + key);
      if (!card) return;
      var show = name === 'all' || SETTINGS_HELP[key].triggers.indexOf(name) !== -1;
      card.style.display = show ? '' : 'none';
    });
  }
  var filterSel = $('filter-select');
  if (filterSel) filterSel.addEventListener('change', function () { applySettingsFilter(filterSel.value); });

  $('btn-save-vacation').addEventListener('click', async function () {
    try {
      var indefinite = $('set-vacation-indefinite').checked;
      var s = await api('PUT', '/api/settings', {
        vacationMode: $('set-vacation').checked,
        vacationUntil: indefinite ? null : ($('set-vacation-until').value || null),
      });
      S.settings = s;
      setMsg($('vacation-msg'), 'Vacation settings saved.', true);
      await load();
    } catch (e) { setMsg($('vacation-msg'), e.message, false); }
  });

  $('set-vacation-indefinite').addEventListener('change', function () {
    $('set-vacation-until').disabled = $('set-vacation-indefinite').checked;
  });

  // Global Arm/Disarm: one call arms or disarms every
  // staged transaction. The server answers with the updated list.
  async function armAll(enabled) {
    try {
      await api('POST', '/api/bitcoin/txs/arm-all', { enabled: enabled });
      setMsg($('arm-all-msg'), enabled ? 'All transactions armed.' : 'All transactions disarmed.', true);
      await load();
    } catch (e) { setMsg($('arm-all-msg'), e.message, false); }
  }

  $('btn-arm-all').addEventListener('click', function () { armAll(true); });

  $('btn-disarm-all').addEventListener('click', function () { armAll(false); });

  // Check-in API keys: one labelled key per service. The plaintext key
  // shows once, when created; afterwards only its label and last use.
  // Revoking one leaves the others working.
  var apiKeys = []; // { id, label, createdAt, lastUsedAt }
  var newKeyPlain = null; // the plaintext of the key just created, until its pop-out closes

  function renderApiKeys() {
    var list = $('api-keys-list');
    list.innerHTML = '';
    if (!apiKeys.length) {
      var none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No API keys yet.';
      list.appendChild(none);
      return;
    }
    apiKeys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'api-key-row';
      var name = document.createElement('b');
      name.textContent = k.label || 'Untitled key';
      var meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = 'created ' + fmtDate(k.createdAt) + ' · last used ' + (k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never');
      var del = document.createElement('button');
      del.textContent = 'Revoke';
      del.className = 'danger';
      del.addEventListener('click', function () { revokeApiKey(k.id, k.label); });
      row.appendChild(name); row.appendChild(meta); row.appendChild(del);
      list.appendChild(row);
    });
  }

  function revokeApiKey(id, label) {
    showConfirm('Revoke this key?',
      'This revokes the key labelled "' + (label || 'Untitled key') + '". The service using it will no longer be able to check in. Other keys are unaffected.',
      async function () {
        try {
          await api('DELETE', '/api/checkin-keys/' + encodeURIComponent(id));
          apiKeys = apiKeys.filter(function (k) { return k.id !== id; });
          renderApiKeys();
          setMsg($('api-keys-msg'), 'Key revoked.', true);
        } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
      },
      'Revoke');
  }

  // The new-key pop-out, built from real elements so Copy has a handler;
  // closing it drops the key.
  function showNewKeyModal() {
    $('confirm-title').textContent = 'Your new key';
    $('confirm-body').textContent = 'Your new key — copy it now, it will not be shown again.';
    var details = $('modal-details');
    details.innerHTML = '';
    var input = document.createElement('input');
    input.id = 'new-key-value';
    input.type = 'text';
    input.readOnly = true;
    input.value = newKeyPlain || '';
    details.appendChild(input);
    var copyBtn = document.createElement('button');
    copyBtn.id = 'btn-key-copy';
    copyBtn.className = 'primary';
    copyBtn.textContent = 'Copy key';
    copyBtn.addEventListener('click', copyNewKey);
    details.appendChild(copyBtn);
    $('confirm-proceed').style.display = 'none';
    $('confirm-cancel').textContent = 'Close';
    confirmPending = null;
    $('confirm-modal').classList.add('open');
  }

  async function copyNewKey() {
    var el = $('new-key-value');
    var copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(newKeyPlain || (el && el.value) || '');
        copied = true;
      }
    } catch (e) { copied = false; }
    if (!copied && el && typeof el.select === 'function' && typeof document.execCommand === 'function') {
      try { el.select(); document.execCommand('copy'); copied = true; } catch (e) { copied = false; }
    }
    setMsg($('api-keys-msg'), copied ? 'Key copied.' : 'Copy failed — select the key and copy it by hand.', copied);
  }

  $('btn-api-key-create').addEventListener('click', async function () {
    try {
      var r = await api('POST', '/api/checkin-keys', { label: $('api-key-label').value });
      apiKeys.push(r.key);
      $('api-key-label').value = '';
      newKeyPlain = r.plain;
      showNewKeyModal();
      renderApiKeys();
      setMsg($('api-keys-msg'), 'Key created — copy it now. It will not be shown again.', true);
    } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
  });

  // ---------- data backup ----------
  // Download Backup asks: encrypted with the owner's password (default) or
  // unencrypted after a warning. The server encrypts, so the plaintext
  // never crosses the network.
  function backupMode() { return $('backup-encrypt').checked ? 'encrypted' : 'plain'; }
  function syncBackupMode() {
    var enc = backupMode() === 'encrypted';
    $('backup-encrypted-fields').style.display = enc ? '' : 'none';
    $('backup-plain-fields').style.display = enc ? 'none' : '';
    // Only when an RPC password is saved: the file carries it.
    var rpcSaved = ['primaryRpc', 'secondaryRpc'].some(function (k) { return S.settings && S.settings[k] && S.settings[k].hasPassword; });
    $('backup-rpc-warning').style.display = rpcSaved ? '' : 'none';
    // The write-it-down warning belongs to a generated passphrase, so
    // it goes away while encryption is off and comes back with it.
    setMsg($('backup-modal-msg'), enc && generatedPassphrase ? 'Write this passphrase down now \u2014 it is not stored anywhere.' : '', 'warn');
  }
  function closeBackupModal() {
    $('backup-modal').classList.remove('open');
    $('backup-password').value = '';
    $('backup-password2').value = '';
    useTypedPassword();
    setMsg($('backup-modal-msg'), '', true);
  }
  // Password: typed twice, or generated (shown once, in full); turning the
  // switch on again makes a new one.
  var generatedPassphrase = null;
  function useTypedPassword() {
    generatedPassphrase = null;
    $('backup-generate').checked = false;
    $('backup-generated').textContent = '';
    $('backup-generated-fields').style.display = 'none';
    $('backup-typed-fields').style.display = '';
  }
  $('backup-encrypt').addEventListener('change', syncBackupMode);
  $('backup-modal-x').addEventListener('click', closeBackupModal);
  $('btn-backup-modal-cancel').addEventListener('click', closeBackupModal);
  $('btn-backup-download').addEventListener('click', function () {
    $('backup-encrypt').checked = true;
    syncBackupMode();
    $('backup-modal').classList.add('open');
  });
  // A generated passphrase: 6 groups of 5 from an unambiguous alphabet (no
  // 0/o, 1/l/i), about 145 bits.
  $('backup-generate').addEventListener('change', function () {
    if (!this.checked) {
      useTypedPassword();
      setMsg($('backup-modal-msg'), '', true);
      $('backup-password').focus();
      return;
    }
    var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    var bytes = new Uint32Array(30);
    window.crypto.getRandomValues(bytes);
    var groups = [];
    for (var g = 0; g < 6; g++) {
      var w = '';
      for (var i = 0; i < 5; i++) w += alphabet[bytes[g * 5 + i] % alphabet.length];
      groups.push(w);
    }
    generatedPassphrase = groups.join('-');
    $('backup-password').value = '';
    $('backup-password2').value = '';
    $('backup-generated').textContent = generatedPassphrase;
    $('backup-typed-fields').style.display = 'none';
    $('backup-generated-fields').style.display = '';
    setMsg($('backup-modal-msg'), 'Write this passphrase down now — it is not stored anywhere.', 'warn');
  });
  $('btn-backup-modal-download').addEventListener('click', async function () {
    var enc = backupMode() === 'encrypted';
    var body = {};
    if (enc && generatedPassphrase) {
      body.password = generatedPassphrase;
    } else if (enc) {
      var pw = $('backup-password').value;
      if (pw.length < 12) { setMsg($('backup-modal-msg'), 'The password must be at least 12 characters.', false); return; }
      if (pw !== $('backup-password2').value) { setMsg($('backup-modal-msg'), 'The two passwords do not match.', false); return; }
      body.password = pw;
    }
    var btn = $('btn-backup-modal-download');
    btn.disabled = true;
    setMsg($('backup-modal-msg'), enc ? 'Encrypting…' : 'Preparing…', true);
    try {
      var backup = await api('POST', '/api/backup', body);
      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'standby-backup-' + new Date().toISOString().slice(0, 10) + (enc ? '.encrypted' : '') + '.json';
      if (document.body) document.body.appendChild(a);
      a.click();
      if (document.body) document.body.removeChild(a);
      URL.revokeObjectURL(url);
      closeBackupModal();
      setMsg($('backup-msg'), enc ? 'Encrypted backup downloaded.' : 'Unencrypted backup downloaded — keep it somewhere safe.', enc ? true : 'warn');
    } catch (e) {
      setMsg($('backup-modal-msg'), e.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-backup-restore').addEventListener('click', function () { $('backup-file').click(); });

  $('backup-file').addEventListener('change', async function () {
    var file = $('backup-file').files && $('backup-file').files[0];
    if (!file) return;
    try {
      var r = await restoreBackupFile(file);
      setMsg($('backup-msg'), restoreMessage(r), true);
      $('backup-file').value = '';
      await load();
      showRestoreResult(r);
    } catch (e) {
      if (e.message !== 'cancelled') setMsg($('backup-msg'), e.message, false);
      $('backup-file').value = '';
    }
  });

  // The installed version, from /api/health, fetched once at startup.
  api('GET', '/api/health').then(function (h) {
    var v = $('app-version');
    if (v && h && h.version) v.textContent = h.version;
  }).catch(function () { /* leave the placeholder */ });

  // ---------- app login ----------
  $('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('btn-login');
    btn.disabled = true;
    setMsg($('login-msg'), 'Checking…', true);
    try {
      var r = await api('POST', '/api/login', { password: $('login-password').value });
      setToken(r.token);
      $('login-password').value = '';
      window.location.reload();
    } catch (e) {
      setMsg($('login-msg'), e.message, false);
      btn.disabled = false;
    }
  });
  // App login: who sets the password (auth/status source: 'env' is
  // STANDBY_PASSWORD or Umbrel's app password, 'app' is set here, 'none').
  var authInfo = { required: false, source: 'none', deployment: '' };
  var authKnown = false;
  var MIN_APP_PASSWORD = 12;

  // Where a password set outside the app (auth source 'env') is found:
  // Umbrel shows it; Docker keeps it in .env; otherwise the environment.
  function envPasswordWhere() {
    if (authInfo.deployment === 'umbrel') return "It is Umbrel's app password for Standby: Umbrel shows it on Standby's page in the Umbrel dashboard.";
    if (authInfo.deployment === 'docker') return 'It is the STANDBY_PASSWORD line in the .env file in the folder where Standby was installed (next to docker-compose.yml).';
    return 'It is the STANDBY_PASSWORD setting Standby was started with.';
  }

  function renderLoginCard() {
    var src = authInfo.source;
    $('login-card-none').style.display = src === 'none' ? '' : 'none';
    $('login-card-app').style.display = src === 'app' ? '' : 'none';
    var env = $('login-card-env');
    env.style.display = src === 'env' ? '' : 'none';
    env.textContent = 'A password is set. ' + envPasswordWhere() + (authInfo.deployment === 'umbrel' ? '' : ' It is changed there, not here.');
    $('logout-row').style.display = authInfo.required ? '' : 'none';
    // Start fresh: what happens to the password, only where it matters.
    $('fresh-login-note').textContent = src === 'app' ? 'Your Standby password is removed too, so setup asks for a new one.'
      : (src === 'env' && authInfo.deployment === 'umbrel') ? 'Your Umbrel app password stays.' : '';
  }

  // "Forgot password?" on the login screen: instructions only — nothing
  // here can show or reset the password.
  function renderForgot() {
    var body = $('login-forgot-body');
    if (authInfo.source === 'app' && authInfo.dataFolder) {
      // A standalone build: no command line needed.
      body.innerHTML = '<p>It cannot be shown or reset from this page. On the computer running Standby:</p>'
        + '<ol><li>Close Standby (close its window).</li><li>Open the folder <code></code> and delete the file <code>login.json</code> in it.</li><li>Start Standby again and set a new password.</li></ol>'
        + '<p>Your transactions, triggers and settings are kept.</p>';
      body.querySelector('code').textContent = authInfo.dataFolder;
    } else if (authInfo.source === 'app') {
      body.innerHTML = '<p>It cannot be shown or reset from this page. On the computer running Standby:</p>'
        + '<ol><li>Close Standby.</li><li>Start it again with <code>--reset-password</code>, or delete <code>login.json</code> from the Standby data folder'
        + (authInfo.deployment === 'docker' ? ' (<code>data</code>, next to <code>docker-compose.yml</code>)' : '') + '.</li><li>Open Standby and set a new password.</li></ol>'
        + '<p>Your transactions, triggers and settings are kept.</p>';
    } else {
      body.innerHTML = '';
      var para = document.createElement('p');
      para.textContent = envPasswordWhere() + (authInfo.deployment === 'umbrel' ? '' : ' To change it, edit it there and restart Standby.');
      body.appendChild(para);
    }
    $('login-hint').textContent = authInfo.deployment === 'umbrel'
      ? "Enter the Standby password. On Umbrel it is shown on the app's page in the Umbrel dashboard."
      : 'Enter your Standby password.';
  }

  function newPasswordFrom(id1, id2) {
    var a = $(id1).value, b = $(id2).value;
    if (a.length < MIN_APP_PASSWORD) throw new Error('The password must be at least ' + MIN_APP_PASSWORD + ' characters.');
    if (a !== b) throw new Error('The two passwords do not match.');
    return a;
  }
  function clearFields(ids) { ids.forEach(function (id) { $(id).value = ''; }); }
  // Set, change or remove the app password; this browser stays logged in
  // with the fresh token (other sessions end).
  async function setAppPassword(body) {
    var r = await api('POST', '/api/auth/password', body);
    setToken(r.token);
    authInfo.required = !!r.required;
    authInfo.source = r.required ? 'app' : 'none';
    renderLoginCard();
    renderForgot();
    return r;
  }

  $('btn-login-set').addEventListener('click', async function () {
    try {
      await setAppPassword({ password: newPasswordFrom('login-new1', 'login-new2') });
      clearFields(['login-new1', 'login-new2']);
      setMsg($('logout-msg'), 'Password set. Standby now asks for it on every device.', true);
    } catch (e) { setMsg($('logout-msg'), e.message, false); }
  });
  $('btn-login-change').addEventListener('click', async function () {
    try {
      var pw = newPasswordFrom('login-chg1', 'login-chg2');
      await setAppPassword({ current: $('login-cur').value, password: pw });
      clearFields(['login-cur', 'login-chg1', 'login-chg2']);
      setMsg($('logout-msg'), 'Password changed. Other devices must log in again.', true);
    } catch (e) { setMsg($('logout-msg'), e.message, false); }
  });
  $('btn-login-remove').addEventListener('click', function () {
    var current = $('login-cur').value;
    if (!current) { setMsg($('logout-msg'), 'Enter your current password first.', false); return; }
    showConfirm('Remove the password?', 'Anyone who can open this page will be able to use Standby.', async function () {
      try {
        await setAppPassword({ current: current, remove: true });
        clearFields(['login-cur', 'login-chg1', 'login-chg2']);
        setMsg($('logout-msg'), 'Password removed.', true);
      } catch (e) { setMsg($('logout-msg'), e.message, false); }
    }, 'Remove password');
  });
  $('btn-logout').addEventListener('click', async function () {
    try {
      await api('POST', '/api/logout');
      setToken(null);
      window.location.reload();
    } catch (e) { setMsg($('logout-msg'), e.message, false); }
  });

  // This computer (standalone builds): start with the computer, and Stop
  // Standby. desktopInfo is GET /api/desktop; null until known.
  var desktopInfo = null;
  function loadDesktop() {
    return api('GET', '/api/desktop').then(function (d) { desktopInfo = d; renderDesktop(); })
      .catch(function () { /* older server: nothing to show */ });
  }
  // Windows runs in the tray; Linux has no tray icon, so it says where
  // to open Standby instead.
  function hasTray() { return !!(desktopInfo && desktopInfo.platform === 'win32'); }
  function pageAddress() { return 'http://' + (window.location.host || 'localhost:3100'); }
  function renderDesktop() {
    var d = desktopInfo;
    $('card-desktop').style.display = (d && d.available) ? '' : 'none';
    if (!d || !d.available) return;
    $('desktop-autostart').checked = !!d.startAtLogin;
    $('desktop-autostart-note').textContent = hasTray()
      ? 'Standby starts in the background when you sign in to this computer, with its icon next to the clock. Triggers are only checked while Standby runs.'
      : 'Standby starts in the background when you sign in to this computer, with no window: open it at ' + pageAddress() + '. Triggers are only checked while Standby runs.';
    if (d.error) setMsg($('desktop-msg'), 'Could not change the sign-in list: ' + d.error, false);
  }
  async function setStartAtLogin(want, msgEl) {
    try {
      S.settings = await api('PUT', '/api/settings', { startAtLogin: want });
      await loadDesktop();
      setMsg(msgEl, '', true);
    } catch (e) {
      setMsg(msgEl, e.message, false);
      await loadDesktop();
    }
  }
  $('desktop-autostart').addEventListener('change', function () { setStartAtLogin($('desktop-autostart').checked, $('desktop-msg')); });
  $('btn-app-stop').addEventListener('click', function () {
    showConfirm('Stop Standby?', 'Triggers are not checked until you start Standby again.', async function () {
      try {
        await api('POST', '/api/app/stop');
        setMsg($('desktop-msg'), 'Standby has stopped. Start it again by opening the Standby program.', true);
      } catch (e) { setMsg($('desktop-msg'), e.message, false); }
    }, 'Stop Standby');
  });

  // Check for new versions: GET /api/update. The dashboard notice shows a
  // newer version until "Not now" for that version (in this browser).
  var UPDATE_DISMISS_KEY = 'standby.updateDismissed';
  var updateInfo = null;
  function loadUpdate() {
    return api('GET', '/api/update').then(function (u) { updateInfo = u; renderUpdate(); })
      .catch(function () { /* older server: nothing to show */ });
  }
  function renderUpdate() {
    var u = updateInfo;
    var avail = !!(u && u.available);
    $('update-box').style.display = avail ? '' : 'none';
    $('btn-update-now').style.display = (avail && u.enabled) ? '' : 'none';
    $('update-now-row').style.display = (avail && u.enabled) ? '' : 'none';
    var banner = $('update-banner');
    if (!avail) { banner.style.display = 'none'; return; }
    $('update-check').checked = !!u.enabled;
    var notice = $('update-notice');
    if (u.enabled && u.newer) {
      notice.style.display = '';
      notice.innerHTML = '';
      notice.appendChild(document.createTextNode('Standby ' + u.latest + ' is available. '));
      var a = document.createElement('a');
      a.href = u.url || 'https://github.com/thefuckisalommy/Standby/releases';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Download it from GitHub';
      notice.appendChild(a);
      notice.appendChild(document.createTextNode('. Your data stays where it is.'));
    } else {
      notice.style.display = 'none';
    }
    if (u.enabled && u.error) setMsg($('update-msg'), 'Could not check: ' + u.error, false);
    else if (u.enabled && u.checkedAt && !u.newer) setMsg($('update-msg'), 'You have the latest version (checked ' + fmtCheckedAt(u.checkedAt) + ').', true);
    else setMsg($('update-msg'), '', true);
    var dismissed = null;
    try { dismissed = window.localStorage.getItem(UPDATE_DISMISS_KEY); } catch (e) { /* none */ }
    var show = u.enabled && u.newer && dismissed !== u.latest;
    banner.style.display = show ? '' : 'none';
    if (show) {
      $('update-banner-version').textContent = u.latest;
      $('update-banner-link').href = u.url || 'https://github.com/thefuckisalommy/Standby/releases';
    }
  }
  $('update-banner-later').addEventListener('click', function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    try { if (updateInfo && updateInfo.latest) window.localStorage.setItem(UPDATE_DISMISS_KEY, updateInfo.latest); } catch (e) { /* this view only */ }
    $('update-banner').style.display = 'none';
  });
  $('update-check').addEventListener('change', async function () {
    var want = $('update-check').checked;
    try {
      S.settings = await api('PUT', '/api/settings', { updateCheck: want });
      if (want) {
        setMsg($('update-msg'), 'Checking…', true);
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
      await loadUpdate();
    } catch (e) {
      $('update-check').checked = !want;
      setMsg($('update-msg'), e.message, false);
    }
  });
  $('btn-update-now').addEventListener('click', async function () {
    setMsg($('update-msg'), 'Checking…', true);
    try { updateInfo = await api('POST', '/api/update/check'); renderUpdate(); } catch (e) { setMsg($('update-msg'), e.message, false); }
  });

  // First-open setup: one page per step (Welcome, App password, Bitcoin
  // nodes, Price sources, How triggers work, First transaction, Done),
  // while state.setup.done is false.
  // "Choose own" moves the Settings card for nodes or prices into the step
  // (and back when leaving it), so its fields and buttons work as there.
  var DEFAULT_PRIMARY = 'https://mempool.space';
  var DEFAULT_SECONDARY = 'https://blockstream.info/api';
  var setup = { open: false, steps: [], i: 0, nodesOwn: false, pricesOwn: false, nodesTested: false, pricesTested: false, homes: {}, afterSkip: null };

  function setupSteps() {
    var steps = ['welcome', 'password', 'nodes', 'prices', 'checkin', 'tx'];
    if (desktopInfo && desktopInfo.available) steps.push('startup');
    return steps.concat(['done']);
  }
  function nodesAreDefault() {
    var st = (S && S.settings) || {};
    return st.primaryApiUrl === DEFAULT_PRIMARY && st.secondaryApiUrl === DEFAULT_SECONDARY && st.secondaryEnabled !== false
      && !(st.primaryRpc && st.primaryRpc.enabled) && !(st.secondaryRpc && st.secondaryRpc.enabled);
  }
  function pricesAreDefault() {
    var ps = ((S && S.settings) || {}).priceSources || {};
    return ps.source1 === 'coingecko' && ps.source2 === 'coinbase';
  }
  function hostLabel(base) {
    return String(base || '').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  }
  var PRICE_LABELS = { coingecko: 'CoinGecko', coinbase: 'Coinbase', binance: 'Binance US', kraken: 'Kraken', bitstamp: 'Bitstamp' };
  function priceLabel(src) {
    if (src && typeof src === 'object') return 'Custom (' + hostLabel(src.url) + ')';
    return PRICE_LABELS[src] || String(src || '—');
  }

  function syncSetup() {
    if (!S || !authKnown || stateErrorShown) return;
    var want = !!(S.setup && S.setup.done === false);
    if (want && !setup.open) openSetup();
    else if (!want && setup.open) closeSetup();
  }
  function openSetup() {
    setup.open = true;
    setup.steps = setupSteps();
    setup.i = 0;
    setup.nodesOwn = !nodesAreDefault();
    setup.pricesOwn = !pricesAreDefault();
    setup.nodesTested = false;
    setup.pricesTested = false;
    document.body.classList.add('setup-open');
    $('setup-card').style.display = '';
    showSetupStep();
  }
  function closeSetup() {
    putBack('card-nodes');
    putBack('card-price-sources');
    setup.open = false;
    document.body.classList.remove('setup-open');
    $('setup-card').style.display = 'none';
  }
  function moveInto(cardId, slotId) {
    var c = $(cardId);
    if (!setup.homes[cardId]) setup.homes[cardId] = { parent: c.parentNode, next: c.nextSibling };
    $(slotId).appendChild(c);
  }
  function putBack(cardId) {
    var h = setup.homes[cardId];
    if (!h) return;
    h.parent.insertBefore($(cardId), h.next);
    delete setup.homes[cardId];
  }

  function showSetupStep() {
    var name = setup.steps[setup.i];
    ['welcome', 'password', 'nodes', 'prices', 'checkin', 'tx', 'startup', 'done'].forEach(function (n) {
      $('setup-' + n).classList.toggle('on', n === name);
    });
    var counted = setup.steps.length - 1; // the welcome page is not a step
    $('setup-head').style.display = name === 'welcome' ? 'none' : '';
    $('setup-stepno').textContent = 'Step ' + setup.i + ' of ' + counted;
    var dots = '';
    for (var k = 1; k <= counted; k++) dots += '<i class="' + (k < setup.i ? 'done' : k === setup.i ? 'on' : '') + '"></i>';
    $('setup-dots').innerHTML = dots;
    $('btn-setup-back').style.display = (name === 'welcome' || name === 'done') ? 'none' : '';
    if (name !== 'nodes') putBack('card-nodes');
    if (name !== 'prices') putBack('card-price-sources');
    if (name === 'password') renderSetupPassword();
    if (name === 'nodes') renderSetupNodes();
    if (name === 'prices') renderSetupPrices();
    if (name === 'tx') renderSetupTx();
    if (name === 'startup') renderSetupStartup();
    if (window.scrollTo) window.scrollTo(0, 0);
  }
  function setupGo(delta) {
    setup.i = Math.max(0, Math.min(setup.steps.length - 1, setup.i + delta));
    showSetupStep();
  }
  function setupGoTo(name) {
    var at = setup.steps.indexOf(name);
    if (at !== -1) { setup.i = at; showSetupStep(); }
  }

  async function finishSetup(msgEl) {
    try {
      await api('POST', '/api/setup', { done: true });
      if (S) S.setup = { done: true };
      closeSetup();
      showTab('dashboard', true);
      await load();
    } catch (e) { setMsg(msgEl, e.message, false); }
  }

  $('btn-setup-start').addEventListener('click', function () { setupGo(1); });
  $('btn-setup-back').addEventListener('click', function () { setupGo(-1); });
  $('btn-setup-restore').addEventListener('click', function () { $('backup-file').click(); });
  $('btn-setup-skip-all').addEventListener('click', function () {
    if (authInfo.source === 'none') {
      openSkipWarning(function () { finishSetup($('setup-welcome-msg')); }, function () { setupGoTo('password'); });
    } else {
      finishSetup($('setup-welcome-msg'));
    }
  });

  // Step: app password (skipping asks first).
  // Set outside the app (Umbrel's app password, or STANDBY_PASSWORD): the
  // page says so — it is the password just used to log in — and never
  // shows it.
  function envPasswordText() {
    return 'Standby is protected by a password: the one you just logged in with. ' + envPasswordWhere();
  }
  function renderSetupPassword() {
    var src = authInfo.source;
    $('setup-password-form').style.display = src === 'none' ? '' : 'none';
    $('setup-password-done').style.display = src === 'app' ? '' : 'none';
    $('setup-password-env').style.display = src === 'env' ? '' : 'none';
    $('setup-password-env-text').textContent = envPasswordText();
  }
  var skipBack = null;
  function openSkipWarning(onSkip, onBack) {
    setup.afterSkip = onSkip;
    skipBack = onBack || null;
    $('setup-skip-modal').classList.add('open');
  }
  $('btn-setup-skip-confirm').addEventListener('click', function () {
    $('setup-skip-modal').classList.remove('open');
    var cb = setup.afterSkip;
    setup.afterSkip = null;
    if (cb) cb();
  });
  $('btn-setup-skip-back').addEventListener('click', function () {
    $('setup-skip-modal').classList.remove('open');
    setup.afterSkip = null;
    if (skipBack) skipBack();
    var pw = $('setup-pw1');
    if (pw && pw.focus) pw.focus();
  });
  $('btn-setup-pw-set').addEventListener('click', async function () {
    try {
      await setAppPassword({ password: newPasswordFrom('setup-pw1', 'setup-pw2') });
      clearFields(['setup-pw1', 'setup-pw2']);
      setMsg($('setup-password-msg'), '', true);
      setupGo(1);
    } catch (e) { setMsg($('setup-password-msg'), e.message, false); }
  });
  $('btn-setup-pw-skip').addEventListener('click', function () {
    setMsg($('setup-password-msg'), '', true);
    openSkipWarning(function () { setupGo(1); });
  });
  $('btn-setup-pw-next').addEventListener('click', function () { setupGo(1); });
  $('btn-setup-pw-env-next').addEventListener('click', function () { setupGo(1); });

  // Step: Bitcoin nodes.
  function renderSetupNodes() {
    var own = setup.nodesOwn;
    $('setup-nodes-public').checked = !own;
    $('setup-nodes-own').checked = own;
    $('setup-nodes-public-choice').classList.toggle('sel', !own);
    $('setup-nodes-own-choice').classList.toggle('sel', own);
    $('setup-nodes-public-actions').style.display = own ? 'none' : '';
    $('setup-nodes-own-actions').style.display = own ? '' : 'none';
    $('setup-nodes-status').style.display = own ? 'none' : '';
    if (own) moveInto('card-nodes', 'setup-nodes-slot');
    else putBack('card-nodes');
    if (!own && !setup.nodesTested) { setup.nodesTested = true; testSetupNodes(); }
  }
  async function usePublicNodes() {
    if (nodesAreDefault()) return;
    S.settings = await api('PUT', '/api/settings', {
      primaryApiUrl: DEFAULT_PRIMARY, secondaryApiUrl: DEFAULT_SECONDARY, secondaryEnabled: true,
      primaryRpc: { enabled: false }, secondaryRpc: { enabled: false },
    });
  }
  function statusLine(pillCls, pillText, text) {
    var row = document.createElement('div');
    row.className = 'setup-status';
    var pill = document.createElement('span');
    pill.className = 'pill ' + pillCls;
    pill.textContent = pillText;
    var t = document.createElement('span');
    t.textContent = text;
    row.appendChild(pill);
    row.appendChild(t);
    return row;
  }
  async function testSetupNodes() {
    var box = $('setup-nodes-status');
    box.innerHTML = '';
    box.appendChild(statusLine('muted', '…', 'Checking the nodes…'));
    try {
      await usePublicNodes();
      var r = await api('POST', '/api/bitcoin/connection/test', {});
      box.innerHTML = '';
      (r.results || []).forEach(function (x) {
        var st = x.status === 'ok' ? ['ok', 'OK'] : x.status === 'caution' ? ['warn', 'CAUTION'] : ['bad', 'FAIL'];
        box.appendChild(statusLine(st[0], st[1], hostLabel(x.base)));
      });
    } catch (e) {
      box.innerHTML = '';
      setMsg($('setup-nodes-msg'), e.message, false);
    }
  }
  function setNodesMode(own) {
    setup.nodesOwn = own;
    setMsg($('setup-nodes-msg'), '', true);
    renderSetupNodes();
  }
  $('setup-nodes-public').addEventListener('change', function () { setNodesMode(false); });
  $('setup-nodes-own').addEventListener('change', function () { setNodesMode(true); });
  $('btn-setup-nodes-test').addEventListener('click', testSetupNodes);
  $('btn-setup-nodes-keep').addEventListener('click', async function () {
    try { await usePublicNodes(); setupGo(1); } catch (e) { setMsg($('setup-nodes-msg'), e.message, false); }
  });
  $('btn-setup-nodes-save').addEventListener('click', async function () {
    try { await saveBitcoinSettings(); setupGo(1); } catch (e) { setMsg($('setup-nodes-msg'), e.message, false); }
  });

  // Step: price sources.
  function renderSetupPrices() {
    var own = setup.pricesOwn;
    $('setup-prices-defaults').style.display = own ? 'none' : '';
    $('setup-prices-own-actions').style.display = own ? '' : 'none';
    if (own) moveInto('card-price-sources', 'setup-prices-slot');
    else putBack('card-price-sources');
    if (!own && !setup.pricesTested) { setup.pricesTested = true; testSetupPrices(); }
  }
  async function testSetupPrices() {
    var box = $('setup-prices-status');
    box.innerHTML = '';
    box.appendChild(statusLine('muted', '…', 'Reading the price…'));
    try {
      var r = await api('POST', '/api/settings/price-sources/test-all', { providers: ['coingecko', 'coinbase'] });
      box.innerHTML = '';
      ['coingecko', 'coinbase'].forEach(function (id, i) {
        var x = (r.results || [])[i] || {};
        var ok = typeof x.price === 'number' && Number.isFinite(x.price);
        box.appendChild(statusLine(ok ? 'ok' : 'bad', ok ? 'OK' : 'FAIL', priceLabel(id) + (ok ? ' — $' + x.price.toLocaleString('en-US') : '')));
      });
    } catch (e) { box.innerHTML = ''; }
  }
  $('btn-setup-prices-keep').addEventListener('click', async function () {
    try {
      if (!pricesAreDefault()) S.settings = await api('PUT', '/api/settings', { priceSources: { source1: 'coingecko', source2: 'coinbase' } });
      setupGo(1);
    } catch (e) { setMsg($('setup-prices-msg'), e.message, false); }
  });
  $('btn-setup-prices-own').addEventListener('click', function () { setup.pricesOwn = true; renderSetupPrices(); });
  $('btn-setup-prices-default').addEventListener('click', function () { setup.pricesOwn = false; setMsg($('setup-prices-msg'), '', true); renderSetupPrices(); });
  $('btn-setup-prices-save').addEventListener('click', async function () {
    try { await savePriceSources(); setupGo(1); } catch (e) { setMsg($('setup-prices-msg'), e.message, false); }
  });

  // Step: how triggers work (information only).
  $('btn-setup-checkin-next').addEventListener('click', function () { setupGo(1); });

  // Step: start with this computer (downloads only); on by default, and
  // switching it off here takes effect at once.
  function renderSetupStartup() {
    var on = !!(desktopInfo && desktopInfo.startAtLogin);
    $('setup-startup-lead').textContent = 'Standby only checks your triggers while it is running. So that it keeps running after a restart, it starts by itself when you sign in to this computer, '
      + (hasTray() ? 'quietly in the background with its icon next to the clock.'
        : 'quietly in the background with no window. Open it any time at ' + pageAddress() + ' (worth bookmarking), and stop it from Settings → This computer.');
    $('setup-autostart').checked = on;
    $('setup-autostart-note').textContent = on
      ? 'On. You can turn this off here, or later in Settings → This computer.'
      : 'Off. Standby only runs when you start it yourself; triggers wait while it is closed. Turn it back on here or in Settings → This computer.';
  }
  $('setup-autostart').addEventListener('change', async function () {
    await setStartAtLogin($('setup-autostart').checked, $('setup-startup-msg'));
    renderSetupStartup();
  });
  $('btn-setup-startup-next').addEventListener('click', function () { setupGo(1); });

  // Step: first transaction (the usual Add form, over the setup page).
  function renderSetupTx() {
    var n = ((S && S.bitcoin && S.bitcoin.txs) || []).length;
    $('setup-tx-count').textContent = n ? n + ' transaction' + (n === 1 ? '' : 's') + ' added.' : '';
    $('btn-setup-tx-skip').textContent = n ? 'Continue' : 'Skip for now';
  }
  $('btn-setup-tx-add').addEventListener('click', function () {
    onAddModalClosed = function () {
      load().catch(function () { /* shown elsewhere */ }).then(function () {
        if (setup.open && setup.steps[setup.i] === 'tx') renderSetupTx();
      });
    };
    openAddModal();
  });
  $('btn-setup-tx-skip').addEventListener('click', function () { setupGo(1); });

  $('btn-setup-finish').addEventListener('click', function () { finishSetup($('setup-done-msg')); });

  // Start fresh: delete all data. From Settings (with "Download a backup
  // first") or the could-not-load screen.
  function openFreshModal(withBackup) {
    $('fresh-backup-row').style.display = withBackup ? '' : 'none';
    $('fresh-password-row').style.display = authInfo.required ? '' : 'none';
    clearFields(['fresh-confirm', 'fresh-password']);
    setMsg($('fresh-msg'), '', true);
    $('btn-fresh-go').disabled = false;
    $('fresh-modal').classList.add('open');
  }
  function closeFreshModal() { $('fresh-modal').classList.remove('open'); }
  $('btn-fresh-delete').addEventListener('click', function () { openFreshModal(true); });
  $('btn-fresh-backup').addEventListener('click', function () { $('btn-backup-download').click(); });
  $('btn-fresh-modal-backup').addEventListener('click', function () { $('btn-backup-download').click(); });
  $('btn-fresh-cancel').addEventListener('click', closeFreshModal);
  $('fresh-modal-x').addEventListener('click', closeFreshModal);
  $('btn-fresh-go').addEventListener('click', async function () {
    if ($('fresh-confirm').value.trim() !== 'DELETE') { setMsg($('fresh-msg'), 'Type DELETE to confirm.', false); return; }
    var body = { confirm: true };
    if (authInfo.required) body.password = $('fresh-password').value;
    $('btn-fresh-go').disabled = true;
    setMsg($('fresh-msg'), 'Deleting…', true);
    try {
      await api('POST', '/api/state/reset', body);
      location.reload();
    } catch (e) {
      setMsg($('fresh-msg'), e.message, false);
      $('btn-fresh-go').disabled = false;
    }
  });

  api('GET', '/api/auth/status').then(function (st) {
    authInfo = { required: !!st.required, source: st.source || (st.required ? 'env' : 'none'), deployment: st.deployment || '', dataFolder: st.dataFolder || '' };
    renderLoginCard();
    renderForgot();
    if (st.required && !st.authenticated) showLogin();
    // Setup's pages depend on this computer's options; ask first (only
    // when logged in, or no login is needed).
    if (!st.required || st.authenticated) return loadDesktop();
    return null;
  }).catch(function () { /* older server or offline: nothing to show */ }).then(function () {
    authKnown = true;
    syncSetup();
  });

  load().catch(function (e) {
    // The login screen is already up — no error notice.
    if (e.message === 'login required') return;
    if (/state\.json is (corrupt|missing)/.test(e.message)) { showStateError(e.message); return; }
    // Error text, not HTML: built with textContent so markup renders
    // literally.
    var main = document.querySelector('main');
    var notice = document.createElement('div');
    notice.className = 'notice bad';
    notice.textContent = 'Could not load Standby state: ' + e.message;
    main.insertBefore(notice, main.firstChild);
  });
})();
