'use strict';
// Standby UI — vanilla JS, no build step. Talks to the JSON API
// (standby/lib/api.js).
(function () {
  var S = null; // cached state
  var stateErrorShown = false; // the state-load error view is up
  // Live view: the 1-second timer below refreshes the page
  // from the server once per check cadence, patching changed values
  // in place — never rebuilding the DOM the owner is touching.
  var lastStatus = null; // the last /api/status payload (for the live tick)
  var lastFetchAt = 0; // ms of the last successful state fetch (cadence gate for the next server refresh)
  var liveRefreshInFlight = false; // one server refresh at a time
  var liveTickRunning = false; // one 1-second tick at a time
  var pendingStructural = false; // a structural change is waiting for a safe moment
  var lastLiveSignature = null; // structural signature of the DOM as rendered

  function $(id) { return document.getElementById(id); }

  function setMsg(el, text, ok) {
    el.textContent = text;
    // ok is true (fine, default colour), false (red — an error, or
    // nothing will happen), or 'warn' (amber — a warning, e.g. a
    // timelocked dry-run: nothing will land yet, but it is not a
    // failure and the release will retry it).
    el.style.color = ok === false ? '#f87171' : ok === 'warn' ? '#fbbf24' : '';
  }

  // App login: when the server requires a password, the
  // session token from POST /api/login is kept in localStorage —
  // scoped to this exact origin (host AND port), unlike a cookie,
  // so no other app on the same host can read it — and sent in the
  // X-Standby-Token header on every API call. Storage access can
  // throw (private mode, blocked site data); then the token lives
  // only for this page.
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

  // The check-in status dates: no seconds, e.g. "11/11/2026, 9:00 AM".
  // toLocaleString() includes seconds in this browser, and the
  // check-in rows do not want them.
  function fmtDateShort(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString() + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // The readiness "last checked" caption: time only when
  // the check was today ("4:29 PM"), date + time when older — the
  // full fmtDateShort string is too long to share the "Exchange
  // Status" label line at 390px.
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

  // The per-tx History: the event titles, the dot colour
  // per type (green = confirmed, amber = fired / conflict, red =
  // failed / stale, grey = the rest), and the short timestamp
  // ("Nov 15, 6:55 PM") the timeline rows show.
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

  // The check-in freeze: the live frozen time for a tx —
  // the banked offset plus the open inactive period, if any.
  // Mirrors lib/checkin.js checkinLiveOffsetMs. A tx that was disarmed
  // or on vacation has time that never counted toward its
  // countdown, so the danger zone is measured from the EFFECTIVE
  // last check-in, not the raw one.
  function liveOffsetMs(tx) {
    var base = (typeof tx.checkinOffsetMs === 'number' && isFinite(tx.checkinOffsetMs) && tx.checkinOffsetMs >= 0) ? tx.checkinOffsetMs : 0;
    if (typeof tx.checkinInactiveSince === 'string' && tx.checkinInactiveSince) {
      var since = new Date(tx.checkinInactiveSince).getTime();
      if (isFinite(since)) return base + Math.max(0, Date.now() - since);
    }
    return base;
  }

  // The danger zone: the last 25% of the check-in window —
  // the time remaining until the due date is a quarter of the
  // threshold or less (already past due is inside the zone).
  // thresholdDays is the threshold to measure against (the
  // entered value for the tx being armed/added/edited).
  // offMs is the tx's frozen time (liveOffsetMs) — the due is
  // measured from the EFFECTIVE last check-in, so a frozen clock
  // is never in the danger zone for time that never counted.
  // A new tx has no frozen time (offMs 0). Returns null outside
  // the zone (or with no check-in yet), else { overdue, daysLeft,
  // daysSince } for the confirm wording — daysSince is the
  // EFFECTIVE days elapsed, matching the server's clock.
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

  // A fee rate in sat/vB, ONE decimal at most, trailing zeros
  // trimmed: 588.235294... -> "588.2", 2.635294... -> "2.6",
  // 1000 -> "1000". One decimal keeps the Fee row short enough to
  // fit on one line on a phone.
  function fmtRate(rate) {
    if (rate === null || rate === undefined || !isFinite(rate)) return '—';
    var r = Math.round(rate * 10) / 10;
    return String(r);
  }

  // The fee verdict: is this tx's FIXED fee good enough
  // for a long-term hold? The ladder, against the peak (the 90th
  // percentile of the hourly economy-fee observations Standby
  // records from its own nodes, S.bitcoin.feePeak; the window they
  // span in days is S.bitcoin.feePeakWindowDays, the count
  // S.bitcoin.feePeakObservations):
  // Low Risk at `lowMult`x the peak, Medium Risk at `medMult`x–
  // `lowMult`x, High Risk below the peak (Settings: Fee verdict;
  // defaults 2 and 1). The CURRENT check comes first: a fee
  // below the current economy fee (served as
  // S.bitcoin.currentFees.economyFee) would not confirm within a
  // day right now, so it is Critical Risk whatever the history
  // says. When the economy fee is not supplied the Critical check
  // is skipped and only the historical ladder runs. Mirrors
  // lib/bitcoin.js feeVerdict exactly (the frontend cannot import
  // that module). Returns null when there is no peak or no fee
  // rate, so the caller shows no verdict instead of a wrong one.
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

  // The pill class for a fee verdict: Low green, Medium amber,
  // High a LIGHTER red, Critical the current red — so
  // the worst level is visibly the deepest red.
  function feeVerdictCls(v) {
    if (v === 'Low Risk') return 'ok';
    if (v === 'Medium Risk') return 'warn';
    if (v === 'High Risk') return 'bad-soft';
    return 'bad';
  }

  // The readiness pill text for a fee verdict: the dashboard
  // names the fee explicitly ("Low Fee Risk") — on the dashboard
  // the pill sits next to the status pill, so a bare "Low Risk"
  // is ambiguous. The tx card's Fee line and the Settings card
  // already name the fee, so they keep the short verdict.
  // "Med" (not "Medium") keeps the pill short.
  function feePillText(v) {
    if (v === 'Low Risk') return 'Low Fee Risk';
    if (v === 'Medium Risk') return 'Med Fee Risk';
    if (v === 'High Risk') return 'High Fee Risk';
    if (v === 'Critical Risk') return 'Critical Fee Risk';
    return v;
  }

  // The fee verdict for one tx right now: the verdict of
  // the tx's stored fee rate against the current peak and economy
  // fee — null when the tx is settled or pending (its fee is
  // moot) or the inputs are unknown. One place, so the card's Fee
  // line, the readiness pill, and the live tick all agree — and
  // the Fee-line pop-out computes it at click time, so it never
  // explains a verdict the tick has since replaced.
  function txFeeVerdict(tx) {
    var st = txStatus(tx);
    if (st.settled || st.pending) return null;
    return feeVerdict(tx.feeRateSatVb, S.bitcoin.feePeak, S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee, S.settings && S.settings.feeLowMultiplier, S.settings && S.settings.feeMediumMultiplier);
  }

  // The fee-risk pop-out: the Fee line is clickable and
  // opens the shared showDetails pop-out with HOW the verdict was
  // calculated — the peak, your fee, the current economy
  // fee, and the reason for the level — so the verdict is
  // explainable, not a black box. The numbers use the app's own
  // one-decimal rate formatting, so they match the Fee line.
  function showFeePopout(tx, verdict) {
    var peak = S.bitcoin.feePeak;
    var win = S.bitcoin.feePeakWindowDays;
    // The window the peak covers: the
    // observations reach back at most 90 days; a young history
    // reaches back only as far as it has been recording. The label
    // names the real window — "90-day peak" at 90 days, "peak over
    // the last N days of observations" when shorter.
    var peakLabel = (typeof win === 'number' && win < 90)
      ? 'peak over the last ' + win + (win === 1 ? ' day' : ' days') + ' of observations'
      : '90-day peak';
    var econ = S.bitcoin.currentFees && S.bitcoin.currentFees.economyFee;
    var rate = tx.feeRateSatVb;
    // The ladder's thresholds (Settings: Fee verdict) — the
    // pop-out explains the verdict in the owner's own terms,
    // not the defaults.
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

  // ---------- tabs ----------
  // Each tab is its own subpage: the URL hash names it (#dashboard,
  // #transactions, #settings, #logs), so refreshing the page lands
  // back on the tab you were on instead of the Dashboard, and the
  // browser's Back / Forward steps through tabs. The Transactions
  // tab reads #transactions in the address bar (the internal tab key
  // is still 'bitcoin'; #bitcoin is accepted as an alias).
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
    // The Settings filter defaults to All each time the Settings
    // tab is shown (no persistence). Guarded: at startup this
    // runs before the SETTINGS_HELP registry is assigned, and
    // the default is All anyway (every card visible in the HTML).
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

  // ---------- header burger menu ----------
  // Exit App goes back to the Umbrel home screen on the same host,
  // whatever host this app was reached on (umbrel.local, LAN IP, Tailscale).
  // Protocol-relative root of the request host, so it works with no
  // hardcoded address.
  var exitLink = $('exit-app');
  if (exitLink) exitLink.href = '//' + window.location.hostname + '/';
  // The menu also holds the app's main tabs, with Exit App at the
  // bottom — the whole app is reachable from it. Tapping a tab
  // switches to it and closes the menu. The links carry the tab's
  // hash, so they work as plain links too (a long-press copies a
  // link straight to that tab).
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
  }

  // The state file could not be loaded and no backup could be
  // recovered: the app cannot run, but it can still be
  // rescued — restore a backup file, or start fresh. Only a
  // state-load error shows this view; any other load failure
  // (a network error, say) keeps the plain notice at startup
  // and never offers to erase anything.
  function showStateError(message) {
    stateErrorShown = true;
    $('tabs').style.display = 'none';
    document.querySelectorAll('main section.tab').forEach(function (s) { s.style.display = 'none'; });
    $('state-error-detail').textContent = message;
    $('state-error-card').style.display = '';
  }

  // ---------- restore, plain or encrypted ----------
  // Both restore paths (Settings, and the state-error card) read the
  // file, and — when it is an encrypted backup — ask for its password
  // in a small dialog, then send the file's JSON with the password
  // added. The server decrypts it (lib/backupcrypto.js); a wrong
  // password comes back as an ordinary error. Cancelling the dialog
  // rejects with a 'cancelled' error the callers stay quiet about.
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
    return api('POST', '/api/restore', backup);
  }

  $('btn-state-restore').addEventListener('click', function () { $('state-restore-file').click(); });

  $('state-restore-file').addEventListener('change', async function () {
    var file = $('state-restore-file').files && $('state-restore-file').files[0];
    if (!file) return;
    try {
      var r = await restoreBackupFile(file);
      setMsg($('state-error-msg'), 'Restored ' + r.restoredTxs + ' transaction(s) and settings from the backup.', true);
      $('state-restore-file').value = '';
      location.reload();
    } catch (e) {
      if (e.message !== 'cancelled') setMsg($('state-error-msg'), e.message, false);
      $('state-restore-file').value = '';
    }
  });

  $('btn-state-reset').addEventListener('click', function () {
    showConfirm('Start fresh?',
      'This erases all transactions, settings, check-in keys, and history. The check-in key stops working until you create a new one. This cannot be undone.',
      function () {
        api('POST', '/api/state/reset', { confirm: true }).then(function () {
          location.reload();
        }).catch(function (e) { setMsg($('state-error-msg'), e.message, false); });
      }, 'Start fresh');
  });

  var PILL_CLASS = {
    'on-track': 'ok', 'release-due': 'bad', 'broadcasted': 'bad',
    'vacation': 'warn', 'not-started': 'muted', 'grace': 'warn',
  };

  // Triggers: the rule that fires a transaction. The tx's
  // trigger, normalized — a missing or unusable trigger defaults
  // Normalize ONE rule: a rule with an unknown shape falls back
  // to the check-in trigger at 35 days, so a legacy tx (written
  // before triggers existed) reads as a check-in rule. There is
  // no global threshold: 35 is the per-tx default.
  // Mirrors lib/store.js normalizeRule — the frontend cannot import
  // that module, so the normalization is duplicated here (same
  // pattern as the feeVerdict mirror).
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
  // A transaction carries a rule SET, not one
  // trigger: {op: 'AND'|'OR', rules: [...]}. The server still
  // serves a one-rule set as its single rule with a flat
  // triggerState (legacy shape), so the set normalizer accepts
  // both shapes on read and always returns the set shape.
  function triggerSetOf(tx) {
    var t = tx && tx.trigger;
    if (t && typeof t === 'object' && Array.isArray(t.rules)) {
      var rs = t.rules.map(function (r) { return normalizeRule(r); });
      if (!rs.length) rs = [{ type: 'checkin', params: { thresholdDays: 35 } }];
      return { op: t.op === 'AND' ? 'AND' : 'OR', rules: rs };
    }
    return { op: 'OR', rules: [normalizeRule(t)] };
  }
  // The per-rule triggerState slices, parallel to the rules.
  // The server serves a flat slice for a one-rule set, and one
  // ruleset object for a multi-rule set — its per-rule slices
  // live under .rules (see lib/rules.js triggerStatusFor). A
  // one-rule set served as an array (the old interim shape)
  // reads the same way. Missing slices read as {}.
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
  // The smallest check-in threshold in a rule set, or null when
  // the set has no check-in rule — the danger-zone reset and
  // the arming warning measure against the soonest rule.
  function minSetCheckinThreshold(set) {
    var ths = (set.rules || []).filter(function (r) { return r.type === 'checkin'; }).map(function (r) { return r.params.thresholdDays; });
    return ths.length ? Math.min.apply(null, ths) : null;
  }
  function minCheckinThreshold(tx) {
    return minSetCheckinThreshold(triggerSetOf(tx));
  }
  // The set's condition in plain words — the per-rule
  // conditions joined with AND / OR. A one-rule set reads
  // exactly like the single rule; for
  // later rules the "Fires when/on" prefix is dropped, so a
  // two-rule set reads "Fires when BTC price ≥ $150,000 OR the
  // chain reaches block 1,000,000".
  function triggerSetCondition(tx) {
    var set = triggerSetOf(tx);
    var parts = set.rules.map(function (r) { return triggerCondition(r); });
    if (parts.length <= 1) return parts[0] || '';
    var joiner = set.op === 'AND' ? ' AND ' : ' OR ';
    return parts.map(function (p, i) {
      return i === 0 ? p : p.replace(/^Fires (when|on) /, '');
    }).join(joiner);
  }
  // The pill text for a trigger type ("Check-in", "BTC Price",
  // "UTXO", "Manual", "Block height", "Set date", "Fee market") —
  // the readiness rows and the trigger subcards both use it. (The
  // subcard uppercases it.)
  function triggerLabel(trigger) {
    return trigger.type === 'checkin' ? 'Check-in'
      : trigger.type === 'price' ? 'BTC Price'
      : trigger.type === 'utxo' ? 'UTXO'
      : trigger.type === 'blockheight' ? 'Block height'
      : trigger.type === 'setdate' ? 'Set date'
      : trigger.type === 'feemarket' ? 'Fee market'
      : 'Manual';
  }
  // The trigger's condition in plain words ("Fires when BTC ≥
  // $150,000") — the subcard and the readiness state line use it.
  // The UTXO mode rides on the condition: the default (1
  // confirmation) reads as before — "is spent" already meant
  // confirmed — while unconfirmed and N > 1 say so explicitly.
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
  // Row 3 of the trigger subcard: the current state/value for
  // this trigger type, in plain language — no extra detail.
  // (owner: every subcard is exactly 3 rows, one line each.)
  function triggerStateLine(trigger, ts) {
    if (trigger.type === 'price') {
      var lp = (ts && typeof ts.lastPrice === 'number' && Number.isFinite(ts.lastPrice)) ? ts.lastPrice : null;
      return lp !== null ? 'BTC price currently $' + lp.toLocaleString('en-US') : 'BTC price currently unknown';
    }
    if (trigger.type === 'checkin') {
      // On track: the days since the last check-in, out of the
      // window. Other states (not started, vacation,
      // grace period, release due) already name themselves in
      // the reason — use it as-is.
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
    // UTXO, set date, and manual: the reason already states the
    // state (unspent / spent + confirmations; the date; waiting
    // for a manual broadcast).
    return (ts && ts.reason) ? ts.reason : 'Not evaluated yet';
  }
  // The per-rule state pill: whether this rule's
  // criterion is met right now, from its triggerStatus slice —
  // so an AND set shows at a glance which rules hold and which
  // don't. 'due' / 'release-due' → "Met" (green); 'watching' /
  // 'on-track' → "Not met" (muted); 'unknown' / 'not-evaluated'
  // (or no status at all) → "Unknown" (amber — an unknown rule
  // blocks AND, so it stands out); 'grace' / 'vacation' / 'held'
  // → "Held" (amber); 'manual' → no pill at all (a manual rule
  // never fires, so neither word fits). Only "Met" is green — an
  // unmet rule never reads as an error. Returns null for no pill.
  function ruleStatePill(trigger, ts) {
    if (trigger.type === 'manual') return null;
    var st = ts && ts.status;
    if (st === 'manual') return null;
    if (st === 'due' || st === 'release-due') return { text: 'Met', cls: 'ok' };
    if (st === 'grace' || st === 'vacation' || st === 'held') return { text: 'Held', cls: 'warn' };
    if (st === 'unknown' || st === 'not-evaluated' || !st) return { text: 'Unknown', cls: 'warn' };
    return { text: 'Not met', cls: 'muted' };
  }
  // The UTXO guard note for a confirmation mode — the Add and Edit
  // pickers both use it. Unconfirmed warns the spend can be
  // evicted or replaced; N confirmations names the threshold.
  function utxoGuardNote(mode, confs) {
    if (mode === 'unconfirmed') return 'Guard: fires on any spend, even unconfirmed — a mempool spend can still be evicted or replaced, so it may fire on a spend that never confirms.';
    if (confs === 1) return 'Guard: only a confirmed spend fires — an unconfirmed (mempool) spend only watches until it confirms.';
    return 'Guard: fires once the spend has ' + confs + ' confirmations — an unconfirmed (mempool) spend only watches until it confirms.';
  }
  // Convert an ISO UTC string to a datetime-local input value
  // (local time, YYYY-MM-DDTHH:MM) — the Edit popup's set-date
  // field. Returns '' for an unparseable input.
  function isoToLocalDatetime(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Grace period: the card at the top of the dashboard,
  // shown whenever a grace is active — even with nothing held.
  // The copy (keep it exactly):
  // "Grace period has been activated because the device was offline
  // for 3 days." / "2 transactions are held by grace, 1 of them
  // would fire now." — the held line carries both numbers (held,
  // then would-fire as a subset of held) and is the same line for
  // 0 or more.
  // The countdown bar fills as the grace elapses (same convention
  // as the check-in bar): "Day N of M" left, "N days left · until
  // Nov 30" right; under a day left it reads "less than a day
  // left"; an indefinite grace has no bar, just "until you resume".
  // The Resume row puts the button first with its note to the
  // right. Shared with the live tick: patchLive calls this
  // instead of rebuilding the dashboard, so the card's text
  // stays fresh without touching anything else.
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
    // Countdown bar (finite grace only): Day N of M, N days left.
    // N is whole days elapsed since the grace was set (the bar
    // fills as the grace elapses, like the check-in bar); the
    // days-left count is the same whole-day math, so N + left
    // is always the duration — except under a day left, when
    // the label says so plainly instead of "0 days left".
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

  // The check-in card's head: the status pill, the
  // explainer line under it, and the last check-in date.
  // Shared with the live tick: patchLive calls this instead of
  // rebuilding the dashboard.
  function renderStatusHead(status) {
    var pill = $('status-pill');
    pill.textContent = status.label;
    pill.className = 'pill ' + (PILL_CLASS[status.state] || 'muted');
    // On track, there is nothing to say below the pill — the line
    // only appears when the state needs explaining (release due,
    // vacation, broadcasted, not started).
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
    // Last check-in: the absolute date only. The relative elapsed
    // time is already in each bar's caption, so no "Checked in X
    // days ago" line — and no single "Next check-in due": with
    // per-tx thresholds there is no one due date (each bar
    // carries its own window).
    var lastEl = $('last-checkin');
    lastEl.textContent = status.lastCheckinAt ? fmtDateShort(status.lastCheckinAt) : '—';
  }

  // The per-tx check-in bars as data: one entry per ACTIVE
  // check-in RULE, from status.checkinTxs when the server sends
  // it, else derived from the txs' own triggerState slices (the
  // same shape, for an older server). Shared by renderDashboard
  // (which builds the bar elements) and patchLive (which patches
  // the existing ones in place).
  function checkinBarsData(status) {
    var bars = status.checkinTxs || [];
    if (!bars.length) {
      // An older server sends no checkinTxs: derive the bars
      // from the txs' own trigger statuses (same numbers).
      // Settled / pending txs get no bar here either — same
      // rule as the server (txStatus is the authority). A
      // disarmed tx keeps a frozen bar here too.
      // One entry per check-in RULE (a tx with two check-in
      // rules gets two bars), each at its own threshold, from
      // that rule's triggerState slice — the same shape the
      // server sends in status.checkinTxs.
      bars = [];
      // Set members get no bar of their own — their own
      // check-in triggers are dormant while attached; the SET
      // gets one bar per check-in rule, like a tx.
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
  // Exchange Status rows: one row per configured price
  // source, each with its own status pill and last price.
  // There is NO overall agreement pill next to the header:
  // the status (OK / Failed) lives only on each exchange
  // row. The per-price-tx lines stay trigger-only. The price
  // sits in a small muted span to the left of the pill — the
  // same `.node-check-detail` shape as the Settings rows —
  // never inside the label span, and never the error reason;
  // that detail lives in the Settings card only. The pill
  // stays pinned to the right edge, with the Node pills.
  // Shared with the live tick.
  // Exchange Status: one row per configured price
  // source, with the live price and the last-checked time.
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
        // Per-row checked time: "checked 11:53 PM -
        // $61,392.8" — the price refresh's time (currentPriceAt,
        // one refresh for both sources, so the two rows show the
        // same time as each other), a dash, then the last price.
        // No price yet but a refresh ran: the checked time alone.
        // The pill stays pinned to the right edge.
        var checked = (S.bitcoin && S.bitcoin.currentPriceAt) ? 'checked ' + fmtCheckedAt(S.bitcoin.currentPriceAt) : '';
        if (priceEl) priceEl.textContent = (src.price != null && Number.isFinite(Number(src.price))) ? (checked ? checked + ' - ' : '') + '$' + Number(src.price).toLocaleString('en-US') : checked;
        if (src.status === 'ok') { pill.textContent = 'OK'; pill.className = 'pill ok'; }
        else if (src.status === 'error') { pill.textContent = 'Failed'; pill.className = 'pill bad'; }
        else { pill.textContent = 'Not tested'; pill.className = 'pill muted'; }
      });
    }
  }

  // The member line's text: "Tx N — <first 16
  // of the txid>…" on the left, the amount ("0.00013681 BTC",
  // the same value the tx subcard head shows) on the right.
  // Members have no label, so the number + short txid is the
  // identifier — never "Untitled transaction" or any invented
  // label. N is the member's 1-based index in the set's stored
  // member order, so the number stays put if a member goes
  // stale. A tx with no txid falls back to "Tx N" on the left;
  // a tx with no parseable amount leaves the amount blank. The
  // status pill lives ONLY on the set header row — member lines
  // carry no pill at all.
  function readinessMemberParts(tx, index) {
    var short = (tx.txid || '').slice(0, 16);
    var left = 'Tx ' + index + (short ? ' \u2014 ' + short + '\u2026' : '');
    var sats = (tx.totalOutSats === null || tx.totalOutSats === undefined) ? '' : String(tx.totalOutSats);
    var amt = /^\d+$/.test(sats) ? fmtBtc(sats) + ' BTC' : '';
    return { left: left, amt: amt };
  }

  // How a transaction is NAMED anywhere another surface refers
  // to it: a set member is always named by its
  // set — '"<set label>" - Tx N', N the member's 1-based index
  // in the set's stored txIds order (the same numbering the
  // readiness lines use, so "Tx 2" means the same transaction in
  // both places, and the number stays put if a member goes
  // stale). A standalone tx keeps its own label; one without a
  // label falls back to its short txid (first 16 chars + '…').
  // No surface ever renders 'Untitled transaction' for any
  // transaction. txDisplayName is the plain form (card titles,
  // bar labels, confirms, result lists); txRefName is the quoted
  // form for the shared-input warning's "with ..." list.
  // (The 'Untitled transaction' last resort below is
  // unreachable in practice — every stored tx carries a txid —
  // but a name function must return something.)
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
  // A check-in bar's label: bars name a
  // standalone tx or a set — members never get a bar of their
  // own (the server sends the set's bar instead). A standalone
  // tx resolves through txDisplayName, so a label-less one reads
  // its short txid; a set bar keeps its plain label.
  function barLabel(b) {
    var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === b.id; });
    return tx ? txDisplayName(tx) : (b.label || '');
  }

  // The release-readiness entries: ONE entry
  // per trigger set, not one per transaction. A set's members
  // share one trigger set, so they share one readiness row —
  // headed by the SET's label, with the SET's pill (the same
  // pill the set card shows) and the set's condition line. A
  // member tx has no label of its own (the label lives on the
  // set), so per-member rows would render it as "Untitled
  // transaction" with an Unknown pill from its frozen triggerState
  // — and the set itself would get no row at all.
  // Standalone txs (sets of one) render exactly as before.
  // Entries walk the txs in stored order, emitting a set at its
  // first member's position, so the list keeps the order the
  // owner added things in. A set gets a row iff it has a live
  // member (not settled, not pending) — a set whose members are
  // all pending or archived has nothing left to broadcast, and
  // an empty set has nothing at all. A mixed set (one member
  // pending, the rest live) still gets a row, with the set
  // card's own pill ('Broadcast').
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
    // Getting Started card: the empty-state card at the
    // top of the Dashboard, shown only when no transactions are
    // STAGED (active). Archived (settled) and pending
    // transactions do not count — the card returns when the last
    // staged tx is archived, goes pending, or is removed, so an
    // owner with only archived txs still gets the prompt to add
    // one. The first thing a fresh install sees; it disappears
    // as soon as the first transaction is staged. Independent of
    // the grace card (which shows whenever a grace is active,
    // held txs or not).
    var anyStaged = (S.bitcoin.txs || []).some(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    var gsCard = $('getting-started-card');
    if (gsCard) gsCard.style.display = anyStaged ? 'none' : '';
    // The check-in card renders when any rule uses the
    // check-in trigger — check-in is one trigger among
    // several now, not the whole app, so a price- or UTXO-only
    // setup has no countdown to show. Only ACTIVE check-in
    // txs count: a settled (archived) or pending one has nothing
    // to count down to, so it neither shows a bar nor keeps the
    // card visible. Armed OR disarmed both count — a disarmed
    // tx keeps a FROZEN bar (its countdown is held, not gone).
    // The one exception is a fresh install with no
    // transactions at all: the card stays visible so the clock
    // can be started before the first rule exists.
    var anyCheckinActive = (S.bitcoin.txs || []).some(function (t) { return hasRuleType(t, 'checkin') && !txStatus(t).settled && !txStatus(t).pending && !setOfTxId(t.id); })
      || (S.bitcoin.sets || []).some(function (s) { return hasRuleType(s, 'checkin') && !setStatus(s).settled && !setStatus(s).pending; });
    var showCheckin = anyCheckinActive || !(S.bitcoin.txs || []).length;
    $('checkin-card').style.display = showCheckin ? '' : 'none';
    renderStatusHead(status);
    // The per-tx check-in bars: one block per ACTIVE
    // check-in tx — the label above, the bar, and "X of N
    // days elapsed" below. Each bar measures its OWN window: the
    // server sends it per tx as status.checkinTxs[].windowDays —
    // the tx's own threshold. A DISARMED check-in tx keeps its bar, frozen at the day
    // count it was left at: muted grey, marked disarmed, its
    // count never advancing while it is disarmed or on vacation.
    // Settled (archived) and pending check-in txs get no bar.
    // With no check-in yet every bar reads 0 of its threshold. The bar fills as days
    // elapse; its colour is by how much time is LEFT: green
    // while more than 3/4 of the window remains, amber past
    // that, red in the last quarter. Overdue is a full red bar.
    // A frozen bar is grey instead — it is held, not live.
    // A bar past due while a grace is active reads
    // 'grace', not 'release-due': amber, captioned "— held by
    // grace" — the due date is not pushed out by the grace, so
    // the bar must not read as due while the rule is held.
    var barsEl = $('checkin-tx-bars');
    barsEl.innerHTML = '';
    var bars = checkinBarsData(status);
    // A tx with two check-in rules sends two bars with the same
    // label — tell them apart by rule number, matching the
    // "Rule N" headers on the tx card.
    var barsById = {};
    bars.forEach(function (b) { barsById[b.id] = (barsById[b.id] || 0) + 1; });
    bars.forEach(function (b) {
      var daysSince = b.daysSince || 0;
      var windowDays = (typeof b.windowDays === 'number' && b.windowDays > 0) ? b.windowDays : (b.thresholdDays || 35);
      var frozen = b.enabled === false;
      var block = document.createElement('div');
      block.className = 'ck-tx' + (frozen ? ' frozen' : '');
      // The live tick finds this bar by tx + rule and
      // ticks its countdown locally — the window it measures
      // against rides on the element, so no second lookup.
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
    // The transactions, one row each: the label with its
    // status pill — the same pill the transaction's own card shows
    // ("armed", "Timelocked + armed", ...), via
    // txPillText(tx, txStatus(tx)). Only the active ones: pending
    // and archived transactions live in their own cards and will
    // never broadcast at release, so they are not listed here.
    // (No shared-input pill tweak here — that stays on the tx cards.)
    // Each row also carries the fee verdict as a second
    // pill next to the status pill ("armed" + "Med Fee Risk"),
    // colour-coded like the status pill. No verdict when the fee
    // rate is unknown or the peak has no history yet — the
    // row then shows only the status pill.
    // One row per trigger set, not per
    // transaction: a set renders once, headed by the SET's label
    // with the SET's pill (setPillText / setStatus — the same
    // pill the set card shows) and the set's condition line. A
    // set row carries NO fee pill: the fee is per transaction,
    // and it lives inside each member's Details on the tx card.
    // Under the header, one sub-line per LIVE
    // member: the member's amount + its own pill (never a label
    // — members have none). Settled / pending members are
    // omitted; they already show on the tx card / Pending
    // Transactions card. No fee pill on member lines either.
    var entries = readinessEntries();
    var txsEl = $('readiness-txs');
    txsEl.innerHTML = '';
    readinessEls = {};
    if (entries.length) {
      entries.forEach(function (e) {
        // One block per armed rule: the label + the status
        // pill on the first line (and the fee pill, unchanged, on
        // a standalone tx row), the trigger's condition on the
        // second line — the same summary the tx card shows
        // ("Fires when ...") — so the dashboard reads as a list
        // of RULES, not just transactions. The current value
        // lives on the tx card's third row, not here.
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
          label.textContent = txDisplayName(e.tx);
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
        // The state line is the tx card's condition summary —
        // triggerCondition, the same text as the subcard's second
        // row ("Fires when tx fees are >= 5 sat/vB") — so the
        // readiness list stays one row per rule. The live current
        // value is not repeated here; it lives on the tx card's
        // third row and in the Exchange / Node Status sections.
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
            mleft.textContent = parts.left;
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
    // One "Node Status" item, with the Primary and Secondary lines
    // listed below it (each with its own status pill). The status comes
    // from the last connection test — the Test connection button, a
    // check-in, or the hourly check. A result only counts for the
    // endpoint it was measured against: if the settings changed since
    // the test ran, the pill goes back to Not tested.
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('readiness-', 'primary', status.primaryApiUrl, conn);
    renderNodeStatus('readiness-', 'secondary', status.secondaryApiUrl, conn);
    renderExchangeRows(status);
  }

  // The Logs tab: the broadcast log and the recent check-ins. They
  // live here so the Dashboard is only the status and the check-in
  // — one view, no scroll.
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

  // A check-in: no success message below the button — the
  // refreshed bars and last-check-in date ARE the confirmation,
  // so the "Checked in just now." line was redundant.
  // A FAILED check-in still reports its error here.
  $('btn-checkin').addEventListener('click', async function () {
    try {
      await api('POST', '/api/checkin', { method: 'app' });
      await load();
      // A check-in also re-tests the nodes, so their status on the
      // Dashboard is fresh when the owner looks at it. Best-effort:
      // the check-in already landed either way.
      try { await api('POST', '/api/bitcoin/connection/test', {}); } catch (e) { /* node test failed; check-in stands */ }
      await load();
    } catch (e) { setMsg($('checkin-msg'), e.message, false); }
  });

  // Grace period: "Resume now" on the dashboard card
  // ends the grace immediately. The card hiding is the
  // confirmation — load() re-renders with no grace active, so
  // the card disappears and the pills read "armed" again.
  // A check-in does NOT clear the grace; this is the only way
  // (besides expiry).
  $('btn-resume-grace').addEventListener('click', async function () {
    try {
      await api('POST', '/api/grace/resume', {});
      await load();
    } catch (e) { setMsg($('grace-msg'), e.message, false); }
  });

  // Add-transaction popup: the Add form is a modal now,
  // not a card at the bottom of the Transactions tab. Three buttons
  // open it — the Getting Started button, the "+ Add a pre-signed
  // transaction" button at the bottom of the Transactions tab, and
  // the oval "+ Add Tx" in the Staged Transactions header. Opening
  // it never switches tabs or scrolls the page; the hex field is
  // focused so a paste lands straight in it. It never submits
  // anything on its own.
  function openAddModal() {
    var m = $('add-modal');
    if (!m) return;
    setMsg($('btc-msg'), '', true);
    syncAddFallbackRow();
    m.classList.add('open');
    var hex = $('btc-hex');
    if (hex && hex.focus) hex.focus();
  }
  function closeAddModal() {
    var m = $('add-modal');
    if (m) m.classList.remove('open');
  }

  // ---------- Add modal: repeatable transactions, one set label ----------
  // "+ Add Tx" IS "add trigger set": one save creates a COMPLETE
  // INDEPENDENT new trigger set. ONE label sits above the tx
  // inputs (the set's label — there is no per-entry label); each
  // entry in #btc-tx-list is one tx (notes + hex), "+ Add another
  // transaction" appends one, and the single Save creates all of
  // them with the shared rules / route below, then creates the
  // set holding them. The first entry is static HTML (it keeps
  // the btc-notes / btc-hex ids); extra entries are built here.
  // Entries are collected by walking children, never
  // querySelectorAll — the DOM shim only implements the
  // checkbox selector. The shim does not model static-HTML
  // children, so the first entry's fields are also reachable
  // as the standalone btc-* els: a child list whose first entry
  // is NOT the static one (its hex field is not $('btc-hex'))
  // gets the static entry prepended.
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
  // One builder for a blank
  // new-transaction entry — the same construct in the Add
  // modal, the set modal, and the single-transaction edit
  // modal: notes + hex + a per-entry import button + a
  // remove button. cfg carries the class names (each modal
  // keeps its own, so the DOM walkers and tests keep
  // working), the message element id for import errors, and
  // the remove / hex-input callbacks. The import button only
  // records its target; the one hidden file input (#btc-file)
  // does the reading.
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
  // The walk over a list of such entries: the same shape the
  // Add modal's addTxEntrySets returns (root, fields, titleEl,
  // removeBtn), so the save paths read them identically.
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
  // New-transaction entries, collected the same way in both
  // edit modals: blank entries ignored, notes-without-hex
  // blocks the save (same message as the Add form). `n` is the
  // entry's position, for the message.
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
  // After a successful add the form resets to one blank entry,
  // ready for the next batch — same as the old single-tx reset,
  // plus the one set label above the entries.
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
  // Wire the static first entry (its title + remove button live
  // in the HTML, not built here) so renumbering reaches it, and
  // the "+ Add another transaction" button. In the DOM shim the
  // static entry has no children to walk, so this is a no-op
  // there — the fallback in addTxEntrySets covers it.
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
  // The pill lives inside the Staged Transactions <summary>: a click
  // on it must NOT toggle the card, so the event is stopped before
  // it reaches the summary.
  $('btn-btc-add-pill').addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    openAddModal();
  });
  // The popup closes like the edit modal: Cancel, the X, or a click
  // on the backdrop. Guarded like modal-x: a mixed tree (new script,
  // old page) must degrade to a missing X, not a dead page.
  $('btn-btc-add-cancel').addEventListener('click', function () { closeAddModal(); });
  var addModalX = $('add-modal-x');
  if (addModalX) addModalX.addEventListener('click', function () { closeAddModal(); });
  $('add-modal').addEventListener('click', function (e) {
    if (e.target === $('add-modal')) closeAddModal();
  });

  // ---------- bitcoin ----------
  // Pre-signed transactions: a LIST. Each has its OWN enable toggle,
  // its own label + notes, and its own release record. Adding one arms
  // it by default — the toggle unarms it. The dry-run buttons check
  // the inputs are still unspent and NEVER broadcast. Notes say what
  // each tx is for, at a glance, in the list.
  var editingId = null; // id of the tx loaded into the add form, or null
  var dryRunResults = {}; // tx id -> { text, ok, verdict, spent, unknown, error }: the last dry-run result per transaction, shown in its own card. The *line* is page memory only — but a spent verdict is also recorded on the transaction server-side (a stale release record), a conflict verdict the same way (a conflict release record — a warning, not a verdict), and an own-txid verdict as a broadcast record, so the Stale / Conflict / Broadcasted status itself survives a refresh.
  // Per-card expandable state, kept across re-renders:
  // clicking a card button (Dry-run, the arm toggle, ...) reloads
  // the list and rebuilds every card's DOM — without this map the
  // rebuild resets each <details> to its default, so using a
  // button would open or close the Details the user had set.
  // Keyed by tx id; an entry exists only once the user has
  // toggled something on that card (a fresh card uses the
  // defaults: Details open for Active/Pending, closed for
  // Archived; nested Inputs/Outputs closed). The render reads
  // the map, and each <details> toggle listener writes the user's
  // choice back into it — so a re-render restores exactly what
  // the user left, on every card. The TXID and the Inputs/Outputs
  // entries do not live in this map: tapping one opens a pop-out
  // with the full info instead of expanding inline, so there is
  // no inline state to preserve.
  var txUiState = {};
  // The public fallback: a per-transaction opt-in timer on a
  // Slipstream-route transaction — if MARA has not confirmed it
  // within the chosen days, Standby broadcasts it publicly instead.
  // The same seven durations the server accepts, plus Never (null).
  var FALLBACK_DAYS = [1, 3, 7, 14, 30, 60, 90];
  // The one-sentence explainer under the Add form's fallback select:
  // what the chosen duration means. Never means MARA
  // holds it until it is mined or dropped — no automatic fallback.
  function fallbackAddNote(days) {
    if (days === null || days === undefined || days === '') return 'No automatic fallback \u2014 it stays with MARA until mined or dropped.';
    return 'If MARA hasn\u2019t confirmed it within ' + fallbackLabel(days) + ', Standby broadcasts it publicly instead.';
  }
  function fallbackLabel(days) {
    if (days === null || days === undefined || days === '') return 'Never';
    return days + (days === 1 ? ' day' : ' days');
  }
  // Days left before a Slipstream-pending tx's public fallback fires
  // — from the deadline (submittedAt + duration) to now, rounded up,
  // so a deadline later today still reads as a day left. Never (null)
  // has no deadline; a passed deadline reads as due.
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
  // The Public Fallback row's text: the duration, plus the
  // countdown while Slipstream-pending, or "from broadcast" while
  // still active. Shared by renderBitcoin and the live tick.
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

  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u || ''; } }
  // One node's row — the host, plus a pill for the last test of that
  // endpoint (OK / Failed / Not tested). `prefix` is 'readiness-' on the
  // Dashboard and 'btc-' on the Settings tab; both render the same
  // data. A blank URL means no secondary node is set. One exception:
  // while the secondary is DISABLED, the Dashboard
  // secondary row names the slot, not the provider — it reads
  // "Secondary Node" because there is no real node behind it
  // (see slotName below). While enabled it shows the configured
  // host, as before; Settings still shows the host.
  // One node's status line: the host plus an overall pill —
  // OK (all four capabilities ready), CAUTION (the height probe
  // works but broadcast, fees, and/or output lookup are not ready),
  // FAIL (the height probe failed — unreachable or not a node at
  // all), or Not tested / Not set. The pill's tooltip carries the
  // detail.
  // In the Settings nodes card (prefix 'btc-') the three
  // capability rows render under it too; the Dashboard (prefix
  // 'readiness-') has no capability elements, so it shows the
  // overall pill only. A legacy result without a status derives
  // it from ok (true → OK, false → FAIL) and hides the rows.
  function renderNodeStatus(prefix, label, url, conn) {
    var host = $(prefix + label);
    var pill = $(prefix + label + '-status');
    var checksEl = $(prefix + label + '-checks');
    // Per-row checked time: the readiness rows carry
    // their own "checked …" left of the pill — each endpoint's
    // own last-answered stamp (connection.nodeCheckedAt), not
    // the shared connection-test time: the tick asks the primary
    // every time and the secondary only on fallback, so the two
    // stamps diverge. No stamp yet means no time shown, never
    // an invented one. Only the readiness rows have this
    // element; the Settings rows have none, so they are untouched.
    var checkedEl = $(prefix + label + '-checked');
    // The Dashboard readiness row names the slot, not the
    // provider, but ONLY while the secondary is disabled: with no
    // real node behind it there is no name to show, so the row
    // reads "Secondary Node". While enabled the row shows the
    // configured host (blockstream.info or whichever URL is set),
    // as before. Settings still shows the host where it is
    // configured (the btc- rows and the URL box).
    var secondaryDisabled = (label === 'secondary' && S && S.settings && S.settings.secondaryEnabled === false);
    var slotName = (prefix === 'readiness-' && secondaryDisabled) ? 'Secondary Node' : null;
    if (!url) {
      host.textContent = slotName || 'Not set';
      pill.textContent = 'Not set';
      pill.className = 'pill muted';
      if (checksEl) checksEl.style.display = 'none';
      if (checkedEl) checkedEl.textContent = '';
      return;
    }
    // Secondary disabled: the pill says Disabled — never
    // Offline, Failed, or a stale timestamp — and no checks or
    // checked time are shown. The saved secondary URL is still
    // named in Settings (it comes back when the node is
    // re-enabled), but nothing about it reads as failing. The
    // "Secondary Node" naming lives in the readiness row label
    // (slotName above, disabled only), not in the pill.
    if (secondaryDisabled) {
      host.textContent = slotName || hostOf(url);
      pill.textContent = 'Disabled';
      pill.className = 'pill muted';
      pill.title = 'Secondary node is off — Standby talks to the primary node only.';
      if (checksEl) checksEl.style.display = 'none';
      if (checkedEl) checkedEl.textContent = '';
      return;
    }
    host.textContent = slotName || hostOf(url);
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
  // The four capability checks under one node's summary row,
  // variant C: the node is a <details> — the summary is
  // just the node name + status pill, and the checks open on tap
  // as plain label — value lines, no pills. On failure the value
  // IS the reason, shown in red. Only the Settings nodes card has
  // these elements; the Dashboard rows have no -checks block and
  // are untouched.
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
  }
  function setNodeCheckValue(id, check) {
    var val = $(id);
    if (!val) return;
    if (!check) { val.textContent = ''; val.classList.remove('failed'); return; }
    val.textContent = check.value || '';
    if (check.ok) val.classList.remove('failed');
    else val.classList.add('failed');
  }
  // After a connection test, open the details of any node that is
  // not OK so the failure is visible without a tap — and never
  // close anything: a node the owner opened by hand stays open
  // across the test. Runs once per test, never on
  // re-render, so it does not fight a manual open/close.
  function openFailedNodeDetails() {
    var conn = (S.bitcoin && S.bitcoin.connection) || null;
    var results = (conn && conn.results) || [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.status === 'ok') continue;
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

  // The MARA queue line for a Slipstream-submitted transaction:
  // where it sits in MARA's queue and how likely it is to be mined
  // soon, from the last status check. Only shown while waiting.
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

  // The broadcasted line for a sent transaction: when it went out, via
  // which node, and how deep it is. confirmations === null means it
  // has not been checked yet (or the check failed — the checkedAt stays
  // old then, so the number reads as stale rather than wrong).
  // The state words follow the verdict the server records
  // on the not-found path: a missing tx whose input is spent-confirmed
  // reads stale — never "may have been dropped" — and one whose input
  // has an unconfirmed spend says so. Confirmed wins over a stale
  // verdict (a block height is a fact even if an old verdict lingers).
  function txBroadcastLine(tx) {
    var b = tx.broadcasted;
    if (!b) return '';
    var conf;
    if ((typeof b.confirmations === 'number' && b.confirmations > 0) || b.blockHeight != null) {
      conf = (typeof b.confirmations === 'number' && b.confirmations > 0)
        ? b.confirmations + (b.confirmations === 1 ? ' confirmation' : ' confirmations')
        : 'confirmed in block ' + Number(b.blockHeight).toLocaleString('en-US');
    } else if (b.staleInput) {
      conf = 'stale — input spent by ' + shortTxid16(b.staleInput.spentBy)
        + ((b.staleInput.blockHeight != null) ? ' (block ' + Number(b.staleInput.blockHeight).toLocaleString('en-US') + ')' : '');
    } else if (b.conflictInput) {
      conf = 'not found on the network — its input is spent by ' + shortTxid16(b.conflictInput.spentBy) + ', but that spend is not confirmed yet';
    } else if (b.found === false) {
      // `found` is the verdict — a stale confirmation
      // count (0, from before the tx dropped out) must not read
      // "in the mempool" for a tx no node knows.
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

  // The broadcast line's colour follows the verdict, not
  // the mere fact of a broadcast record: confirmed green, unconfirmed
  // amber, not-found (or stale) red. A release-only line stays muted.
  function broadcastLineCls(tx) {
    var b = tx.broadcasted;
    if (!b) return 'muted';
    if ((typeof b.confirmations === 'number' && b.confirmations > 0) || b.blockHeight != null) return 'tx-sent';
    if (b.found === false) return 'tx-bad';
    return 'tx-warn';
  }

  function txReleaseLine(tx) {
    // A sent transaction shows the broadcast line (with confirmations),
    // not the cycle's release record — the broadcast is an on-chain
    // fact that survives check-ins. A stale record survives check-ins
    // too (the inputs are spent for good); the other release records
    // do not.
    if (tx.broadcasted) return txBroadcastLine(tx);
    var rel = tx.release;
    if (!rel) return '';
    if (rel.status === 'broadcast') return 'Broadcast ' + fmtDate(rel.broadcastedAt) + ' via ' + methodLabel(rel.method) + '.';
    if (rel.status === 'stale') return 'Stale — ' + (rel.error || 'inputs spent') + '.';
    // A Slipstream submission is a pseudo-pending-but-success state:
    // it went to MARA, it is not in the public mempool yet, and it
    // becomes Broadcasted once the public nodes see it — or Failed
    // if MARA drops it. The queue line (when the last status check
    // brought one back) says where it sits.
    if (rel.status === 'submitted-slipstream') {
      // The queue position lives on its own row (txMaraLine), not
      // in this line — the card shows the submission and the queue
      // as two rows.
      return 'Submitted to Slipstream (MARA) ' + fmtDate(rel.submittedAt) + ' — waiting for MARA to mine it.';
    }
    return 'Failed — ' + (rel.error || 'unknown error') + '. Will retry automatically, at most once an hour.';
  }

  // The overall status of one transaction, shown as a pill at the
  // top-right of its label row. Precedence: a broadcasted tx the
  // network no longer knows is Failed — the node accepted it, then
  // it was dropped from the mempool (or replaced by the other
  // transaction sharing its inputs); the broadcast line on the card
  // says so. A broadcasted tx that is CONFIRMED (confirmations > 0,
  // or a block height set) is Broadcasted (green, archived); a
  // broadcasted tx that is NOT yet confirmed — in the mempool, or
  // not checked yet (confirmations null) — is Broadcast (amber,
  // pending): it is out the door but not settled yet. A release
  // record that says 'broadcast' counts as Broadcasted even without
  // the broadcasted fact — a restore can carry one half of the
  // pair, and there is no confirmation count to consult for it.
  // Inputs declared spent is Stale — the spent verdict is recorded
  // on the transaction (by the release, a manual broadcast, or a
  // dry-run), so it survives refreshes and check-ins and the card
  // stays in the Archived Transactions card; an input spent by
  // another transaction that is NOT confirmed yet is Conflict — a
  // warning, not a verdict: the card stays active (not archived,
  // not stale) and a broadcast is still attempted, and a later
  // clean check clears it; a dry-run that could not reach the
  // nodes is Node Failure; a failed release is Failed; a dry-run
  // that could not say either way is Unverified; otherwise an armed
  // tx is Ready and an unarmed one is "unarmed" (just that, not
  // "Disabled + unarmed"). `settled` marks a
  // card whose body is collapsed and whose dry-run button is
  // disabled — a broadcasted-and-confirmed, failed, or stale
  // transaction (the Archived card). `pending` marks a card that is
  // broadcast/submitted but not yet confirmed — the Pending card.
  // A pending card takes the archived-card format (collapsed
  // details, no arm toggle) but its Edit button stays available
  // (label and notes only — the hex is locked) and a
  // Slipstream-pending card carries a "Broadcast publicly" escape
  // hatch. The route toggle is locked once broadcast: it appears
  // only on Active cards.
  // The status pill carries the armed state as text on an Active
  // card — a healthy armed tx reads just "armed" (the "Ready" is
  // redundant: if it were not ready, the pill would already name
  // the problem, e.g. "Timelocked + armed"), and a problem state
  // reads "Label + armed". An unarmed card's pill reads just
  // Grace period: whether the grace is
  // active right now. S.grace is the computed view the server
  // serves on /api/state and /api/status ({ active, indefinite,
  // graceUntil, triggeredAt, offlineGapDays }) — null when no
  // grace was ever set (or it was resumed / expired). The pill
  // and the dashboard card both read this, so a grace that
  // expired on the server hides everywhere at once.
  function graceActive() {
    return !!(S && S.grace && S.grace.active);
  }
  // Whether THIS tx is held by the grace: armed, with a
  // price, UTXO, block-height, set-date, fee-market, or
  // check-in rule (check-in rules are held by the same
  // grace as everything else), and still active (not settled
  // or pending).
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
  // How many transactions the grace is holding, for the card's
  // held-count line: every armed active tx with a held rule
  // type, plus every member of a held set — each tx counted
  // once. This is the held count, NOT a fresh evaluation:
  // held rules are not evaluated during a grace, so a held tx
  // is one whose triggers are paused, whether or not its
  // condition is met (see graceWouldFireTxCount for the ones
  // whose condition is met).
  function graceHeldTxCount() {
    var ids = {};
    // A set member's own trigger is
    // parked while attached — the set's trigger is the one that
    // fires — so members are skipped here and counted through
    // their set below. Judging a member by its parked trigger
    // counted it as held even when the set's trigger is manual
    // (never held).
    (S.bitcoin.txs || []).forEach(function (t) { if (!setOfTxId(t.id) && graceHoldsTx(t)) ids[t.id] = true; });
    (S.bitcoin.sets || []).forEach(function (s) {
      if (!graceHoldsSet(s)) return;
      (s.txIds || []).forEach(function (id) { ids[id] = true; });
    });
    return Object.keys(ids).length;
  }
  // How many of the held transactions would fire right now if
  // the grace lifted: the same held
  // population as graceHeldTxCount, restricted to txs/sets whose
  // served triggerStatus reads wouldFire — the backend's raw
  // condition, judged on the best data available without any new
  // network calls (live clock for check-in/set-date, live caches
  // for price/block-height/fee-market, the last stored evaluation
  // for UTXO — see wouldFireFor in lib/rules.js). The second
  // number is a subset of the first, so it never exceeds the held
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

  // "unarmed" — the arm state is the whole status, not a prefix
  // on another one. A
  // settled or pending card has no arm state, so it keeps its
  // plain label.
  function txPillText(tx, st) {
    if (st.settled || st.pending) return st.label;
    if (!tx.enabled) return 'unarmed';
    // Grace: an armed tx held by the grace
    // reads just "Grace" — the pill's text is the status, and
    // the arm state is already in the amber colour.
    if (st.label === 'Grace') return 'Grace';
    if (st.label === 'Ready') return 'armed';
    return st.label + ' + armed';
  }

  // One label/value row inside a card's Details: "Label: value".
  // The row is flex: the label is a fixed 120px column and the
  // value takes the rest, so every row's value starts at exactly
  // the same x — and a long value wraps inside its own column
  // instead of running under the label. `cls` is the row's own
  // class (tx-route, tx-fallback, ...) so a row can be found by
  // name. Every value is sans like every other Details value
  // (no monospace values). The space between
  // label and value lives at the END of the label span: the label
  // is sans for every row, so that space is the same width on all
  // of them. The label's trailing space is not rendered (it sits
  // inside the 120px column) but it is in textContent, so the row
  // still reads "Label: value".
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

  // One Inputs/Outputs entry row: a kv row like
  // every other Details row — the label ("Input 1", "Output 1")
  // in the 120px label column, the content on the same line in
  // the value column. The content is truncated to one line (an
  // ellipsis if it still does not fit) and clickable: tapping it
  // opens a pop-out with the full info instead of expanding
  // inline, so the card never grows or shifts. `openFn` opens
  // that pop-out.
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

  // The pop-outs for the TXID and the Inputs/Outputs entries:
  // the shared showDetails pop-out (X, Close,
  // backdrop to dismiss) with the full info in a kv list — the
  // card itself never changes, so nothing shifts or wraps.
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

  function txStatus(tx) {
    var dr = dryRunResults[tx.id] || null;
    if (tx.broadcasted || (tx.release && tx.release.status === 'broadcast')) {
      if (tx.broadcasted && tx.broadcasted.found === false) return { label: 'Failed', cls: 'bad', settled: true, pending: false };
      // Confirmed (or a restore-carried 'broadcast' record with no
      // broadcasted fact to consult) -> Archived, green. Broadcast
      // but unconfirmed (0 confirmations, or not checked yet) ->
      // Pending, amber.
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
    // Slipstream Pending: submitted to Slipstream, not yet
    // visible in the public mempool. A pseudo-pending-but-success
    // state — the card lives in the Pending Transactions card, with
    // its own amber pill, distinct from Broadcasted and from Failed.
    // It takes precedence over a timelock or conflict warning: the
    // transaction is already submitted, so that is the state that
    // matters.
    if (tx.release && tx.release.status === 'submitted-slipstream') {
      return { label: 'Slipstream Pending', cls: 'warn', settled: false, pending: true };
    }
    // Absolute-locktime warning: the transaction carries a
    // locktime that has not passed yet, so the node would reject it as
    // non-final. The card stays active with a warning pill — and the
    // broadcast is not gated on it, the retry fix retakes the
    // transaction once the locktime passes. Precedence matches the
    // dry-run: a timelock beats a conflict.
    if (dr && dr.verdict === 'timelocked') {
      return { label: 'Timelocked', cls: 'warn', settled: false, pending: false };
    }
    if (dr && dr.error) return { label: 'Node Failure', cls: 'warn', settled: false, pending: false };
    // Unconfirmed-spend warning: another
    // transaction spends an input, but it is not confirmed yet and
    // may still be evicted — so the card stays active with a warning
    // pill, and Broadcast Now / a release run still attempt it. The
    // server re-derives the warning on every fresh check: a clean
    // verdict clears it, a confirmed spend turns it stale.
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
    // Unarmed: the pill reads just "unarmed" — the label
    // here is the pill's text, and txPillText returns it plainly
    // for an unarmed tx instead of appending " + unarmed" to it.
    if (!tx.enabled) return { label: 'unarmed', cls: 'muted', settled: false, pending: false };
    // Grace: while the grace is active, an
    // armed tx with a price, UTXO, block-height, set-date,
    // fee-market, or check-in rule reads "Grace" on an amber pill —
    // the rule is paused, not ready. Settled/pending txs return
    // above, so only an active tx can show this; manual txs
    // are not held by the grace and fall through to
    // Ready. (The readiness rows use the same txStatus /
    // txPillText, so their pill reads "Grace" too — the row's
    // state line, the trigger condition + current value, is
    // unchanged, because the grace does not change the rule.)
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

  // Shared-input warnings, derived from the stored transactions on
  // every load (the state carries the shared inputs, computed
  // server-side), so the warning persists across refreshes — it is
  // not page memory, and no Dry-run all is needed for it to appear.
  // A settled or pending card gets no warning: its fate is already
  // decided. The server-side detection already excludes archived
  // transactions; the skip here is belt-and-braces for
  // a settled or pending card. Editing a transaction to spend a
  // different input removes it from the shared set, and the warning
  // clears on the next load.
  // Shared with the live tick: patchLive needs the same
  // map to keep the amber pill in step.
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

  // The trigger subcards: one 3-row box per rule,
  // with the combination line above them for a multi-rule
  // set. Shared by tx cards and set cards — `holder`
  // is a tx or a set; both carry trigger + triggerState +
  // triggerStatus. Returns the per-rule element refs for
  // the live tick. `parent` is the card the boxes go into.
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
    // The per-rule state pill in the subcard
    // header — Met / Not met / Unknown / Held, or no pill
    // on a manual rule. On every subcard, including a
    // one-rule tx's.
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

  // One history timeline: the event trail as a <ul>,
  // oldest first. Shared by a tx card (nested inside Details)
  // and a set card (a plain section above the actions).
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

  // The Details for one transaction: Inputs/Outputs, fee, TXID, route,
  // fallback, locktime, Created, the MARA line, notes, the
  // sent line, and the tx's own History collapsible, nested
  // inside Details — for set members AND standalone cards
  // alike. The set card ADDITIONALLY carries ONE shared
  // history, as its own collapsible on the card itself.
  // `uiKey` is the txUiState key for the open states.
  // Returns { details, feeVerdictEl, maraEl,
  // fallbackValueEl, sentLine } for the live tick.
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
  // The Inputs and Outputs: a drop-down
  // only when there is more than one entry on that side —
  // with exactly one input (or output) there is no drop-down
  // at all, just the single entry as a normal kv row inline.
  // Each drop-down is collapsed by default, its
  // summary shows only its count — no BTC amount in a summary
  // — and expanding one lists every entry as a kv row:
  // the label ("Input 1", "Output 1") in the 120px
  // label column, the content on the same line in the value
  // column, left-aligned with every other Details value. The
  // content is truncated to one line and clickable — tapping
  // it opens a pop-out with the full info instead of expanding
  // inline. Inputs list each input's outpoint (and its value
  // when known); Outputs list each output's value and
  // destination address (or its script type when no address
  // can be derived). The detail comes from the server (GET
  // /api/state derives it from the stored hex); without it
  // the rows fall back to the plain counts.
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
  // The fee: stored at add time when the node could
  // answer the parent lookup. The row hides entirely when the
  // fee is unknown — no "—" fee. The row uses the standard
  // 120px label column like every other Details row,
  // so its value starts exactly where the others' do. The
  // value drops the redundant "sats" — the rate's "sat/vB"
  // carries the unit — so even a 50,000-sat fee fits on one
  // line in the 162px left after the column on a phone.
  // The fee verdict rides on the same line as a short
  // colour-coded suffix — " — Low Risk" / " — Medium Risk" /
  // " — High Risk" — for an ACTIVE tx only (a broadcast or
  // archived tx's fee is moot, and a pending one is already
  // submitted). No verdict when the fee rate is unknown or the
  // peak has no history yet: the line stays exactly
  // as it was, rather than showing a wrong one.
  if (tx.feeSats !== null && tx.feeSats !== undefined) {
    var feeRow = kvRow('tx-fee', 'Fee', fmtSats(tx.feeSats) + ' · ' + fmtRate(tx.feeRateSatVb) + ' sat/vB');
    var fv = txFeeVerdict(tx);
    if (fv) {
      var fvs = document.createElement('span');
      fvs.className = 'fee-verdict ' + feeVerdictCls(fv);
      fvs.textContent = ' — ' + fv;
      feeRow.children[1].appendChild(fvs);
      feeVerdictEl = fvs;
      // The Fee line is clickable: tapping it opens
      // the fee-risk pop-out, which explains how the verdict
      // was calculated. The pointer cursor and the title say
      // it is clickable, like the TXID value below. Only
      // when there is a verdict to explain — a tx with no
      // verdict has nothing to pop out.
      feeRow.children[1].className = 'tx-kv-v tx-fee-value';
      feeRow.children[1].title = 'Click to see how this risk was calculated';
      feeRow.children[1].addEventListener('click', function () { showFeePopout(tx, txFeeVerdict(tx) || fv); });
    }
    body.appendChild(feeRow);
  }
  // The TXID, truncated — clickable to open a pop-out with the
  // full 64-hex value (expanding inline would grow the card and
  // wrap the hex under the label; the pop-out leaves the card
  // exactly as it is). A display
  // action only: it changes nothing about the tx. The pointer
  // cursor and the title say it is clickable.
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
  // The public fallback: a per-transaction opt-in
  // timer, shown only while the route is Slipstream AND a
  // fallback is set — when the route is public the setting is
  // stored but ignored, and when it is Never there is nothing
  // to show. On a Slipstream-pending card the countdown rides
  // on the same row. The duration is changed in the Edit popup,
  // not on the card. Changing it only moves the deadline: it is
  // counted from when MARA first received the transaction, and
  // setting it sooner or later does not change the count.
  if (tx.broadcastVia === 'slipstream' && tx.publicFallbackDays !== null && tx.publicFallbackDays !== undefined) {
    var fbRow = kvRow('tx-fallback', 'Public Fallback', txFallbackText(tx, st));
    fallbackValueEl = fbRow.children[1];
    body.appendChild(fbRow);
  }
  if (tx.locktime > 0) {
    body.appendChild(kvRow('', 'Locktime', String(tx.locktime)));
  }
  body.appendChild(kvRow('', 'Created', fmtDate(tx.createdAt)));
  // The MARA queue line for a Slipstream-pending card: where
  // it sits in MARA's queue and how likely it is to be mined
  // soon. Its own row, not folded into the submission line.
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
  // The History: the tx's own event trail — added,
  // fired, broadcast, confirmed, stale, failed, edited,
  // armed, disarmed — oldest first, in a collapsible of its
  // own nested inside Details, collapsed by default. Only transitions
  // are logged, never the routine release evaluations. The open state
  // is remembered like Details (txUiState). Hidden entirely
  // when the tx has no history (a hand-edited state — every tx
  // the app writes carries at least the 'added' event).
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

  // Trigger sets: one label, one arm/disarm, one rule set
  // driving several transactions. A set's members are the txs in
  // its txIds, in the set's own order; a tx in a set has no
  // standalone card (its own trigger is dormant while attached).
  function setOfTxId(txId) {
    return ((S.bitcoin.sets || []).find(function (s) { return (s.txIds || []).indexOf(txId) !== -1; })) || null;
  }
  function setMembersOf(set) {
    var txs = S.bitcoin.txs || [];
    return (set.txIds || []).map(function (id) {
      return txs.filter(function (t) { return t.id === id; })[0];
    }).filter(function (t) { return !!t; });
  }
  // The set's aggregate status: the same three buckets as
  // a tx — active, pending, settled — from its members. Only when
  // EVERY member is stale does the set read Stale (archived); one
  // stale member leaves the set live for the rest. All members
  // settled is Broadcasted; any member pending (broadcast but
  // unconfirmed, or waiting on MARA) is Broadcast; otherwise the
  // set reads like a tx — unarmed, Grace, or Ready.
  function setStatus(set) {
    var members = setMembersOf(set);
    if (!members.length) return { label: 'Empty', cls: 'muted', settled: false, pending: false };
    var sts = members.map(function (t) { return txStatus(t); });
    // Only when EVERY member is stale does the
    // set read Stale (archived). One stale member leaves the set
    // live for the rest — the stale member just carries its own
    // 'stale' pill on its subcard.
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

  // One transaction subcard: the blue
  // .tx-item every card carries for each of its transactions —
  // set members AND a standalone transaction alike. Every card
  // is a trigger set, so a standalone tx renders as a set of
  // one: the same subcard, in the same spot (above the trigger
  // subcards), with its own Details dropdown INSIDE it (plus
  // the per-tx note, the last dry-run line, and any shared-input
  // warnings). Details NEVER lives inside a trigger subcard.
  // `idx` numbers the subcard ("Tx 1", "Tx 2", ...); `uiKey`
  // is the txUiState key for the Details open state;
  // `includeHistory` puts the tx's own History collapsible
  // inside its Details — standalone cards pass true. Set
  // members pass false (the set's ONE shared History is the only trail on a set card;
  // a member's own history keeps recording in state, it is
  // just never rendered while the tx is attached). Returns the
  // element plus the buildTxDetails refs (fee verdict, MARA
  // line, fallback, sent line) the live tick patches.
  function buildTxItem(tx, st, uiKey, includeHistory, idx, overlapsByTx) {
    var item = document.createElement('div');
    item.className = 'tx-trigger tx-item';
    var itemHead = document.createElement('span');
    itemHead.className = 'tx-trigger-head';
    var itemK = document.createElement('span');
    itemK.className = 'tx-trigger-k rule-k';
    itemK.textContent = 'Tx ' + (idx + 1) + ' — ' + tx.txid.slice(0, 16) + '…';
    itemHead.appendChild(itemK);
    // The stale member gets a pill saying
    // 'stale' — the only per-member pill on a subcard. A live
    // member carries no pill: the card's own pill says armed.
    if (st.label === 'Stale') {
      var itemPill = document.createElement('span');
      itemPill.className = 'pill bad';
      itemPill.textContent = 'stale';
      itemHead.appendChild(itemPill);
    }
    // The BTC amount lives in the head
    // line, right-aligned — no separate amount row below it.
    // The head is flex (space-between), so the amount sits at
    // the right end; the fee stays inside Details.
    var itemAmt = document.createElement('span');
    itemAmt.className = 'tx-item-amt';
    itemAmt.textContent = fmtBtc(tx.totalOutSats) + ' BTC';
    itemHead.appendChild(itemAmt);
    item.appendChild(itemHead);
    // The fee is NOT shown here: it lives inside Details
    // (the Fee row in buildTxDetails, same numbers + verdict)
    // and only shows when Details is expanded.
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
    // Shared-input warnings: this tx spends an input another
    // stored tx also spends, so only one of them can ever be
    // confirmed.
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

  // One set card: it reads as a tx card — a
  // single label in the header with the BTC total in the amount
  // spot, a single arm/disarm in the same spot as a tx card —
  // then the transactions ABOVE the triggers, each as a compact
  // subcard in the same shape/size as a trigger subcard but with
  // a BLUE left border (.tx-item) vs the triggers' orange, each
  // with its own Details dropdown + per-tx note; then the trigger
  // subcards verbatim; then the ONE shared History as its own
  // collapsible, collapsed by default (no Created row); then the
  // actions row (Dry-run / Edit / Delete / Broadcast Now), like
  // a tx card. There is no set-level Details dropdown, and no per-card
  // "staged" pill anywhere.
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
    // The transaction subcards, above the triggers. Members
    // carry no History of their own (the set's shared History
    // below is the only trail on the card).
    members.forEach(function (tx, i) {
      var mst = txStatus(tx);
      var built = buildTxItem(tx, mst, 'set:' + set.id + ':' + tx.id, false, i, overlapsByTx);
      row.appendChild(built.el);
    });
    // The shared triggers, verbatim trigger subcards.
    var ruleEls = appendTriggerBoxes(row, set);
    // The ONE shared History, as its own collapsible — the
    // history of the entire set, collapsed by default like the
    // per-tx History, above the actions row. There is
    // still no set-level Details dropdown. The open state is
    // remembered in txUiState under 'set:<id>' like the per-tx
    // histories, so a re-render keeps it open.
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

  // Secondary on/off: when the secondary is disabled,
  // only the heading-row toggle shows — the URL box hides, but
  // its value is never cleared, so re-enabling brings it back as
  // saved. The toggle lives in the Secondary node heading row
  // (right-aligned, like the arm/disarm switch on a card), so it
  // never hides with the settings it controls.
  function syncSecondaryEnabled() {
    var on = $('btc-secondary-enabled').checked;
    $('btc-secondary-fields').style.display = on ? '' : 'none';
    $('btc-secondary-enabled-wrap').title = on ? 'Secondary node on — used if the primary fails' : 'Secondary node off — primary only';
  }
  function renderBitcoin() {
    $('btc-primary-url').value = S.settings.primaryApiUrl || 'https://mempool.space';
    $('btc-secondary-url').value = S.settings.secondaryApiUrl || '';
    // Secondary on/off — missing in old state means
    // enabled. The toggle sits in the secondary heading row and
    // hides the rest of the secondary settings while off,
    // without clearing them (see syncSecondaryEnabled).
    $('btc-secondary-enabled').checked = S.settings.secondaryEnabled !== false;
    syncSecondaryEnabled();
    var conn = S.bitcoin.connection || {};
    renderNodeStatus('btc-', 'primary', S.settings.primaryApiUrl, conn);
    renderNodeStatus('btc-', 'secondary', S.settings.secondaryApiUrl, conn);

    var txs = S.bitcoin.txs || [];
    var overlapsByTx = computeOverlaps();
    // The three lists: the ones still waiting live inside the
    // Staged Transactions card, below the Dry-run All /
    // Broadcast Armed buttons; the ones broadcast or submitted but not
    // yet confirmed live in the Pending Transactions card; the
    // settled ones (broadcasted-and-confirmed, or stale) live in the
    // Archived Transactions card.
    var activeList = $('btc-active-list');
    var pendingList = $('btc-pending-list');
    var archivedList = $('btc-archived-list');
    activeList.innerHTML = '';
    pendingList.innerHTML = '';
    archivedList.innerHTML = '';
    txCardEls = {};
    setCardEls = {};
    // Standalone txs and sets share the three lists: a
    // set's members have no standalone card, and a set card takes
    // its bucket from its members (see setStatus). Newest first
    // within a bucket, by creation time — the sort is render-time
    // only: the release still evaluates in stored order.
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
      // A standalone transaction IS a
      // trigger set of one: it renders exactly like a set card
      // — label + total + toggle in the header, then ONE blue
      // tx subcard (its own Details inside it), then its trigger
      // subcards in orange below. The blue accent belongs to the tx subcard, and
      // the trigger
      // subcards keep the orange border on every card.
      row.className = 'tx-card tx-sub';
      var st = txStatus(tx);
      var settled = st.settled;
      var pending = st.pending;
      // Element refs for the live tick, filled in below as
      // the card is built — the tick patches these in place and
      // never rebuilds the card.
      var ruleEls = []; // per rule: { pillEl, condEl, nowEl }
      var feeVerdictEl = null; // the " — Low Risk" suffix span, when rendered
      var maraEl = null; // the Slipstream queue line, when rendered
      var fallbackValueEl = null; // the Public Fallback value span, when rendered
      var sentLine = null; // the sent/broadcast line inside Details, when rendered
      // Header: label (bold) + status pill, and on an Active card
      // the arm/disarm toggle immediately to the right of the pill.
      // The pill carries the armed state as text ("armed" when
      // healthy, "Label + armed" for a problem state) — the toggle
      // is the control, green when armed. Pending and settled cards
      // have no toggle (the tx is already out the door).
      var head = document.createElement('div');
      head.className = 'tx-head';
      var title = document.createElement('b');
      title.textContent = txDisplayName(tx);
      var pill = document.createElement('span');
      // A warned-about tx keeps its "Ready" label but gets an amber
      // pill: the tx is still ready to
      // broadcast, but the warning — a shared input, only one of
      // them can ever be confirmed — deserves attention. Only the
      // green pill changes: Conflict/Timelocked/Node Failure are
      // already amber, and settled/pending cards never carry a
      // warning line (overlapsByTx skips them), so 'ok' + a warning
      // can only be a Ready card.
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
      // The transaction subcard — the same blue .tx-item a set
      // member gets, with this tx's own Details (and its History)
      // inside it. The dry-run line and shared-input warnings
      // live in there too, like a set member's.
      var built = buildTxItem(tx, st, tx.id, true, 0, overlapsByTx);
      row.appendChild(built.el);
      var detOut = built.detOut;
      feeVerdictEl = detOut.feeVerdictEl; maraEl = detOut.maraEl; fallbackValueEl = detOut.fallbackValueEl; sentLine = detOut.sentLine;
      // The trigger subcards: the rule(s) that fire this
      // transaction — an amber-edged box with the trigger type, the
      // condition, and the current state — so the condition is
      // visible without opening Details, on every card (active,
      // pending, archived): the rule is the transaction's identity
      // even after it has gone out. The state comes from
      // tx.triggerStatus, computed server-side on every state
      // load (no network at render time).
      // Every subcard is exactly 3 rows (owner), one line each:
      // the header ("TRIGGER - <TYPE>"), the condition, and the
      // current state/value for that trigger. No extra detail and
      // no source breakdown here — the source detail lives in
      // the Exchange Status section and the dry-run notes.
      // One subcard per rule. A one-rule set renders
      // a single subcard ("TRIGGER - <TYPE>", 3 rows);
      // a multi-rule set gets the combination line ("Broadcasts when
      // ANY rule fires" / "Broadcasts when ALL rules hold") and one
      // 3-row subcard per rule ("Rule N — <Type>").
      // Every subcard header also carries the per-rule state
      // pill (ruleStatePill) — Met / Not met / Unknown / Held,
      // or no pill on a manual rule — including a one-rule tx's.
      ruleEls = appendTriggerBoxes(row, tx);
      var actions = document.createElement('div');
      actions.className = 'tx-actions';
      var dryBtn = document.createElement('button');
      dryBtn.textContent = 'Dry-run';
      dryBtn.disabled = settled || pending;
      if (settled || pending) dryBtn.title = 'Transaction already broadcast or submitted';
      dryBtn.addEventListener('click', function () { dryRunTx(tx.id); });
      // Edit stays available on every card — including Pending and
      // Archived ones — but for those it may change only the label
      // and notes: the hex field is disabled in edit mode (and the
      // server rejects a hex change on a broadcasted or
      // Slipstream-pending tx). See startEdit.
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { startEdit(tx); });
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', function () {
        // The confirm must say what deleting actually does. For an
        // Active tx it stops a future broadcast — but a tx already
        // out the door cannot be recalled: deleting it only removes
        // Standby's record of it, and it can still confirm on the
        // network. Branched on the same txStatus() classification
        // the card itself uses (st is in scope here).
        // The deleted tx is named through
        // txDisplayName: a label-less standalone reads its short
        // txid, never 'Untitled transaction'.
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
          // A restore-carried 'broadcast' record with no broadcasted
          // fact to consult: it was broadcast, but we cannot say
          // whether it has confirmed yet.
          delBody = 'This deletes "' + label + '" from Standby. It has already been broadcast — deleting it here only removes it from Standby; it does not undo the broadcast. Its history on this card goes with it.';
        } else {
          delBody = 'This deletes "' + label + '" from Standby. It will no longer be broadcast if the release runs, and its history on this card goes with it.';
        }
        showConfirm('Delete this transaction?',
          delBody,
          function () { deleteTx(tx.id); },
          'Delete');
      });
      // Broadcast Now: send this transaction immediately, on the owner's
      // say-so — same path as the release, after a confirmation dialog.
      // A sent or stale transaction cannot be broadcast from its card,
      // and neither can one already submitted to Slipstream — it is
      // waiting on MARA, and re-submitting it would be a duplicate.
      // A pending public tx is already out the door too.
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
      // The escape hatch for a slow MARA tx:
      // a Slipstream-pending tx can be broadcast publicly instead,
      // by hand. It is NOT part of Broadcast Armed or the release —
      // only this button, after a confirmation that names the
      // privacy cost (the tx becomes visible in the public mempool).
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
    // A list with nothing in it yet says so, instead of sitting empty
    // — except the active (staged) list, which stays bare: the
    // "+ Add a pre-signed transaction" button below it is the prompt.
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
    // Arming a CHECK-IN rule while the
    // clock is in the danger zone (the last 25% of the window,
    // including already past due) would let the release fire soon
    // after — warn first and only arm on confirm. The server
    // resets the check-in in that case anyway (a direct API call
    // cannot bypass it); this is the UI telling the owner what
    // arming will do, before they commit to it. Arming a price,
    // UTXO, or manual rule touches no check-in clock at all, so
    // it never warns — and the zone is measured against the
    // rule's OWN threshold, not the global one.
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

  // Arm/disarm a whole set: the set's toggle is the only
  // arm its members have — a member's own `enabled` is ignored
  // while it is attached. The danger-zone warn is the same as
  // toggleTx's, at set level: arming a set whose shared rules
  // include a check-in rule while the clock is in the danger zone
  // would let the release fire soon after. minCheckinThreshold
  // and liveOffsetMs read the set's own rule set and offset.
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

  // The ids of the transactions that are NOT active right now
  // (pending or archived) — the ones no longer in the Active list.
  // Used to detect, after a dry-run, which transactions just left
  // the Active list. A set member counts through its own tx, so a
  // set dry-run that archives a whole set pops the members.
  function inactiveIds() {
    var ids = {};
    (S.bitcoin.txs || []).forEach(function (t) {
      var st = txStatus(t);
      if (st.settled || st.pending) ids[t.id] = true;
    });
    return ids;
  }
  // After a dry-run, pop up the transactions that just left the
  // Active list — one line each, naming the transaction and the
  // reason (its inputs are spent, or it is already out there). Only
  // the ones that moved in this run; if none moved, no pop-up. The
  // broadcast cases do not need one: Broadcast Armed already lists
  // each transaction and its outcome, and Broadcast Now shows the
  // sent line on the card. A move can land in the Pending
  // Transactions card (a dry-run discovering the tx is already out
  // there, unconfirmed) or the Archived Transactions card (inputs
  // spent, or already out there and confirmed) — the pop-up names
  // the destination it actually landed in, and opens that card so
  // the move is visible the moment the pop-up closes.
  function noticeMovedToArchive(before, moved, why) {
    var fresh = (moved || []).filter(function (m) { return !before[m.id]; });
    if (!fresh.length) return;
    // `why` is 'broadcast' when the move is a dry-run discovering
    // the transaction is already out there —
    // the wording must not say its inputs are spent.
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
      ? 'already out there (the network reports its own txid), so recorded as broadcast, waiting for its first confirmation.'
      : (pend.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    if (arch.length) parts.push(arch.length + ' transaction' + (arch.length === 1 ? '' : 's') + ' moved to Archived Transactions — ' + (broadcast
      ? 'already out there (the network reports its own txid), so recorded as broadcast.'
      : (arch.length === 1 ? 'its' : 'their') + ' inputs are spent.'));
    showDetails(title, parts.join(' '),
      '<ul class="plain-list">' + fresh.map(function (m) {
        var tx = (S.bitcoin.txs || []).find(function (t) { return t.id === m.id; });
        var dest = tx && txStatus(tx).pending ? 'pending' : 'archived';
        // The moved tx is named through
        // txDisplayName: a member reads '"<set label>" - Tx N',
        // a label-less standalone its short txid.
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
        // A dry-run discovering the tx is already out there moves it
        // to Archived too — with the broadcast wording, not the spent
        // wording.
        noticeMovedToArchive(before, [{ id: id, label: one.label || '' }], 'broadcast');
      }
    } catch (e) {
      dryRunResults[id] = { text: 'Dry-run failed: ' + e.message, ok: false, error: true };
      await load();
    }
  }

  // Dry-run a whole set: every member is checked, armed
  // or not, and each member's result lands under its own subcard.
  // A member found stale is marked stale on its own (server-side)
  // — the set keeps its other members — so the moved-to-archive
  // notice names every member that left the Active list in this run.
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

  // A transaction is locked once it is out the door — broadcasted,
  // or submitted to Slipstream and waiting on MARA. Its hex (and
  // its route) cannot change; only the label and notes can.
  function isTxLocked(tx) {
    var st = txStatus(tx);
    return st.settled || st.pending;
  }

  // Edit in a popup, so editing never scrolls the page down to a
  // form at the bottom of the tab on a phone. The popup carries the
  // same fields; the Add card stays "Add" only and never switches
  // to edit mode. editingId is the single source of truth for "an
  // edit is open" — the popup's Save button keys off it.
  function startEdit(tx) {
    editingId = tx.id;
    editOriginalRemoved = false;
    $('edit-label').value = tx.label || '';
    $('edit-notes').value = tx.notes || '';
    $('edit-hex').value = tx.hex || '';
    // The route selector follows the transaction being edited, so
    // saving keeps its route unless the owner changes it.
    $('edit-route').value = tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public';
    // The fallback select: it follows the transaction's
    // route — shown for Active and Pending txs while the route is
    // Slipstream, hidden for settled/archived txs (it is meaningless
    // there) and while the route is public. Changing the route in
    // the popup toggles the row (see the edit-route listener below).
    // A Pending tx's title names the fallback too: its hex and route
    // are locked, but the label, notes, and fallback can change.
    $('edit-fallback').value = (tx.publicFallbackDays === null || tx.publicFallbackDays === undefined) ? '' : String(tx.publicFallbackDays);
    var stEdit = txStatus(tx);
    $('edit-fallback-row').style.display = (!stEdit.settled && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // The deadline warning: it lives ONLY in
    // the Edit popup, and ONLY for a Pending tx — the deadline is
    // already running there, counted from when MARA first received
    // the transaction. An Active tx has no deadline yet, and a
    // settled tx has no fallback at all, so neither shows it.
    $('edit-fallback-note').style.display = (stEdit.pending && tx.broadcastVia === 'slipstream') ? '' : 'none';
    // The rule list follows the transaction being
    // edited — its op, and its rules, each panel filled from
    // its rule. A locked tx keeps its rules: the list is
    // disabled with the hex and route, since the rules have
    // already fired (the server enforces the same).
    resetRuleList('edit', triggerSetOf(tx));
    // A locked tx (Pending or Archived) may change only its label
    // and notes: the hex box, the route selector and the Import
    // button are disabled (import would only populate a hex that
    // cannot change), and a note says so. The server enforces the
    // same rule (PUT rejects a hex change on a locked tx).
    var locked = isTxLocked(tx);
    editLockedTx = locked;
    $('edit-hex').title = locked ? 'The transaction hex cannot be changed once it has been broadcast' : '';
    $('edit-route').title = locked ? 'The broadcast route is locked once the transaction is out the door' : '';
    // The trigger is locked with the hex and route: the rule has
    // already fired, so the picker and its fields are disabled
    // with them.
    setRuleListLocked('edit', locked);
    $('edit-locked-note').style.display = locked ? '' : 'none';
    $('edit-form-title').textContent = !locked ? 'Edit trigger set'
      : stEdit.settled ? 'Edit trigger set — label and notes only'
      : 'Edit trigger set — label, notes and fallback only';
    // A fresh Transactions section: the
    // appended entries from any earlier edit are gone, and the
    // original's remove/add state follows the lock.
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

  // The single-transaction edit's working state: whether the transaction
  // being edited was removed
  // from the card in this modal (it stays standalone, and the
  // new entries form a set on their own), and whether it is
  // locked (broadcast/pending — no add, no remove, hex/route
  // fixed).
  var editOriginalRemoved = false;
  var editLockedTx = false;

  // The single-transaction edit's new-transaction entries: the
  // same blank entry the set modal appends — notes + hex +
  // per-entry import — numbered after the transaction being
  // edited (Transaction 2, 3, ...; from 1 when the original
  // was removed from the card).
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
  // The members the save would keep: the original (unless
  // removed) plus the filled new entries. A blank entry is not
  // a member yet.
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
  // The remove buttons' disabled state follows the same rule
  // as the click guards: the original's remove is disabled
  // while it is the last member the save would keep (its Undo
  // state is always available), and a filled new entry's
  // remove is disabled while it is the last one.
  function syncEditRemoveButtons() {
    var remaining = editRemainingMembers();
    var origRm = $('btn-edit-remove-tx');
    if (origRm) origRm.disabled = editLockedTx || (!editOriginalRemoved && remaining <= 1);
    editNewTxEntrySets().forEach(function (s) {
      var isFilled = !!(s.fields.hex && s.fields.hex.value.trim());
      if (s.removeBtn) s.removeBtn.disabled = isFilled && remaining <= 1;
    });
  }
  // The original transaction's entry, kept or removed: removed
  // dims the entry and disables its fields, and its remove
  // button becomes Undo. Removing it only takes effect on save
  // — Cancel keeps everything.
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
  // editingSetId is the single source of truth for "a set edit is
  // open", mirroring editingId for transactions.
  var editingSetId = null;
  // The set modal's working member list:
  // startEditSet copies the set's members here, the member
  // lines render from it, and removing one drops it from this
  // list — the save sends the reduced txIds and the removed
  // member returns to standalone. Cancel discards it.
  var setEditMembers = [];

  // The arm/disarm switch in the set modal's header row (the
  // card header's toggle, in the modal): its text follows the
  // switch, so the modal never needs a pill to say armed.
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
    // The Transactions section lists the
    // current members (one line each: tx number, txid, amount,
    // notes) so the owner can see what the set holds — and the
    // "+ Add transaction" button below appends blank entries
    // for new transactions, created on save. Each
    // member line has a remove button; removed members return
    // to standalone on save.
    setEditMembers = setMembersOf(set).slice();
    renderSetMembers();
    var newList = $('set-new-txs-list');
    if (newList) newList.innerHTML = '';
    resetRuleList('set', triggerSetOf(set));
    $('set-msg').textContent = '';
    $('set-modal').classList.add('open');
    $('set-label').focus();
  }

  // The set modal's new-transaction entries: the same blank entry the Add
  // modal appends (notes +
  // hex + per-entry import), numbered after the existing
  // members. Entries are built in JS and held by reference
  // through the list's children — the same walk pattern as
  // addTxEntrySets.
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

  // The set modal's member lines: one line
  // per member — tx number, txid, amount, notes — with its own
  // remove button. Rendered from setEditMembers so a removal
  // renumbers the lines at once.
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
  // The remove buttons' disabled state follows the same rule
  // as the click guards: a member's remove is disabled while
  // it is the last member the save would keep, and a filled
  // new entry's remove is disabled while it is the last one.
  // The click handlers re-check, so a button left enabled by
  // a typed-then-removed hex still cannot strand the card.
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

  // The set popup closes like the edit popup: Cancel, the X, or
  // a click on the backdrop. Guarded like the set rule wiring
  // above: a mixed tree has no set modal.
  var btnSetCancel = $('btn-set-cancel');
  if (btnSetCancel) btnSetCancel.addEventListener('click', function () { cancelSet(); });
  var setEnabledCb = $('set-enabled');
  if (setEnabledCb) setEnabledCb.addEventListener('change', function () { syncSetEnabledText(); });
  // "+ Add transaction" appends a blank
  // entry to the set modal's Transactions section. Guarded
  // like the set rule wiring: a mixed tree has no such button.
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
  // The same pair in the edit modal:
  // "+ Add transaction" appends a blank entry to its
  // Transactions section, and the original transaction's
  // remove button toggles its removal from the card. Guarded
  // like the set modal's wiring.
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

  // The edit popup closes like the confirm modal: Cancel, the X,
  // or a click on the backdrop. Guarded like modal-x: a mixed tree
  // (new script, old page) must degrade to a missing X, not a dead
  // page.
  $('btn-edit-cancel').addEventListener('click', function () { cancelEdit(); });
  // The edit popup's fallback row follows the route selector:
  // it shows while the route is Slipstream and hides
  // while it is public — the same rule as the Add form and the card.
  $('edit-route').addEventListener('change', function () {
    $('edit-fallback-row').style.display = $('edit-route').value === 'slipstream' ? '' : 'none';
  });
  // ---------- rule lists ----------
  // The Add / Edit forms carry a LIST of rules instead of one
  // trigger picker: a "How the rules combine" section, one boxed
  // panel per rule (each with the same trigger picker and param
  // rows the single picker had), and a full-width "+ Add rule"
  // button. Panels are built in JS and held by reference — a panel
  // field is never re-queried by id after creation.
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
  // One rule panel: the trigger picker + the param rows for
  // every type (only the picked type's rows show). The field
  // ids follow the old static ids with the panel index in the
  // middle (btc-rule-0-trigger, ...), so a real browser's
  // labels still resolve; the code itself only ever uses the
  // returned references.
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
  // Read the rule one panel describes, or null when its fields
  // are incomplete (the caller shows the error). An empty
  // price value or outpoint is "not filled in yet", not a rule.
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
  // The default params for a fresh rule of a type — just enough
  // that fillRulePanel renders empty fields instead of
  // "undefined" (a fresh rule is "not filled in yet" until the
  // owner completes it, and ruleFromPanel says so).
  function defaultRuleParams(type) {
    if (type === 'checkin') return { thresholdDays: 35 };
    if (type === 'price') return { op: '>=', value: '' };
    if (type === 'utxo') return { outpoint: '', condition: 'spent', confirmations: 1 };
    if (type === 'blockheight') return { targetHeight: '' };
    if (type === 'setdate') return { fireAt: '' };
    if (type === 'feemarket') return { maxFeeRate: '', direction: 'below' };
    return {};
  }
  // A fresh panel's rule: the first trigger type no other panel
  // in this form uses yet (a tx never holds the same
  // type twice, so a new panel never opens as a duplicate).
  function defaultRuleFor(prefix) {
    var list = ruleLists[prefix];
    var used = {};
    list.panels.forEach(function (p) { used[p.typeSel.value] = true; });
    var t = null;
    TRIGGER_TYPE_OPTIONS.some(function (o) { if (!used[o.value]) { t = o.value; return true; } return false; });
    if (!t) t = 'checkin';
    return { type: t, params: defaultRuleParams(t) };
  }
  // No duplicate trigger types in one tx:
  // in every panel's type select, the types the OTHER panels use
  // are disabled and labelled "(already used)" — the panel's own
  // type always stays available. Runs on every add, remove, and
  // type change, so removing a rule frees its type at once.
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
  // The combine cards, the one-rule note, the Add-rule button
  // and the cap note all follow the list: the Remove button hides
  // when a single panel is left (a tx always has a rule), and
  // at the 5-rule cap the Add button disables and the note
  // shows. The type options re-sync here too, so an add or a
  // remove frees (or takes) a type at once.
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
    // The one-rule note: the combine choice only matters once a
    // second rule exists — but the section stays visible from the
    // first rule, so it is never scrolled past unseen.
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
  // The set modal's rule form is the same machinery,
  // with the prefix 'set'. Guarded: a mixed tree (new script,
  // old page) has no set modal — skip the wiring instead of dying.
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
  // The set popup's X and backdrop, guarded like the
  // edit popup's: a mixed tree (new script, old page) must
  // degrade to a missing X, not a dead page.
  var setModalX = $('set-modal-x');
  if (setModalX) setModalX.addEventListener('click', function () { cancelSet(); });
  var setModalEl = $('set-modal');
  if (setModalEl) setModalEl.addEventListener('click', function (e) {
    if (e.target === setModalEl) cancelSet();
  });

  // Save the open edit — the same construct as the set save:
  // the Transactions section holds the transaction being edited
  // plus any blank entries appended with "+ Add transaction".
  // Saving with no new entries is the old single-tx PUT.
  // Saving WITH new entries creates them first (with this
  // card's trigger — dormant while attached — and its route),
  // then promotes the card to a trigger set holding the kept
  // original plus the new ones. If the original was removed
  // from the card it stays staged standalone, untouched, and
  // the new entries form the set on their own. A failure while
  // creating stops the save and says so: txs already created
  // stay staged standalone and the set is not created. Errors
  // stay in the popup (edit-msg); on success the popup closes
  // and the message lands on the Add card, which is visible
  // after the popup closes.
  $('btn-edit-save').addEventListener('click', async function () {
    if (!editingId) return;
    var origKept = !editOriginalRemoved;
    var hex = origKept ? $('edit-hex').value.trim() : '';
    if (origKept && !hex) { setMsg($('edit-msg'), 'Paste the signed transaction hex first.', false); return; }
    // The new entries appended in the modal: blank entries are
    // ignored; an entry with notes but no hex blocks the save,
    // like the Add form.
    var collected = collectNewTxEntries(editNewTxEntrySets());
    if (collected.noteless) { setMsg($('edit-msg'), 'Transaction ' + collected.noteless.n + ' has notes but no signed transaction — paste its hex or remove the entry.', false); return; }
    var newTxs = collected.filled;
    if (!origKept && !newTxs.length) { setMsg($('edit-msg'), 'This trigger set needs at least one transaction — add one, or undo the removal.', false); return; }
    var eres = ruleSetFromForm('edit');
    var trig = eres.set;
    if (!trig) { setMsg($('edit-msg'), eres.error, false); return; }
    var saveTitle = trig.rules.length > 1 ? 'Save a rule set that is already satisfied?' : 'Save a rule that is already satisfied?';
    var oldTx0 = (S.bitcoin.txs || []).find(function (t) { return t.id === editingId; });
    // A price or UTXO rule whose condition is already
    // satisfied warns first (same guard as the Add form) — but
    // only when the rule set CHANGED: editing a label on a rule
    // that has already fired must not re-warn. A check-in rule
    // needs no warn on edit — the danger-zone reset only attaches
    // to ARMING, not to editing.
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
            // A replaced hex makes the old dry-run result stale (the
            // shared-input warning clears on its own — the server
            // recomputes it from the new hexes on the next load).
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
          // The server's already-satisfied gate (price or
          // UTXO) is the backstop for the pre-check above — a
          // label-only edit on a rule that is already satisfied
          // hits it too, since the save always sends the trigger.
          // A gate 400 offers the same confirm instead of a dead
          // error — but only when nothing was created yet; a
          // failure mid-batch is a partial save, reported as one.
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
    // A new tx with a CHECK-IN rule is
    // armed by default — adding one while the clock is in the
    // danger zone would let the release fire soon after, so
    // warn first, like the Add form and the set save. Only when
    // a transaction is actually being added.
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

  // Save a trigger set: edit-only (PUT) — the modal
  // never creates a set (new sets come from "+ Add Tx"). New
  // transactions appended in the modal are created
  // first with the set's shared trigger — dormant while
  // attached, the same as the Add flow — then attached by
  // sending the full txIds list (existing members + new
  // ones); with no new transactions txIds is omitted and the
  // server keeps the existing members. A failure while
  // creating a new tx stops the save and says so in the
  // popup: txs already created stay staged standalone, and
  // the set itself is unchanged. The already-satisfied guard
  // mirrors the Add/Edit transaction saves — a pre-check via
  // /api/triggers/check, with the server's 400 as the
  // backstop. Errors stay in the popup (set-msg).
  // Guarded like the set rule wiring: a mixed tree has
  // no set modal.
  var btnSetSave = $('btn-set-save');
  if (btnSetSave) btnSetSave.addEventListener('click', async function () {
    var sres = ruleSetFromForm('set');
    var trig = sres.set;
    if (!trig) { setMsg($('set-msg'), sres.error, false); return; }
    var saveTitle = trig.rules.length > 1 ? 'Save a rule set that is already satisfied?' : 'Save a rule that is already satisfied?';
    var oldSet = (S.bitcoin.sets || []).find(function (s) { return s.id === editingSetId; }) || null;
    var triggerChanged = !oldSet || (JSON.stringify(triggerSetOf(oldSet)) !== JSON.stringify(trig));
    // The new transactions appended in
    // the modal: blank entries are ignored; an entry with
    // notes but no hex blocks the save, like the Add form.
    var collected = collectNewTxEntries(setNewTxEntrySets());
    if (collected.noteless) { setMsg($('set-msg'), 'Transaction ' + collected.noteless.n + ' has notes but no signed transaction — paste its hex or remove the entry.', false); return; }
    var newTxs = collected.filled;
    // New transactions take the first member's broadcast
    // route (the set itself has no route); a set with no
    // members yet falls back to the public mempool.
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
          // The kept members plus the new
          // ones — members removed in the modal are left out,
          // so they return to standalone; with nothing added or
          // removed txIds is omitted and the server keeps them.
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
          // The server's already-satisfied gate is the
          // backstop for the pre-check below — but only when
          // nothing was created yet; a failure mid-batch is a
          // partial save, reported as one, and the set itself
          // is left unchanged.
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
    // A new tx with a CHECK-IN rule is
    // armed by default — adding one while the clock is in the
    // danger zone would let the release fire soon after, so
    // warn first, like the Add form. Only when a transaction
    // is actually being added; editing the label or triggers
    // of an already-armed set changes nothing about the clock.
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

  // Delete a set: the set goes, its transactions do not —
  // they return to standalone, each with its own trigger again.
  // The set's shared history goes with it.
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
      // Secondary on/off: the toggle's value rides with
      // the rest of the node settings. The secondary URL is sent
      // as it stands, so turning the node off never clears its
      // saved settings — re-enabling brings it back as saved.
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


  // Secondary on/off: hiding/showing the secondary
  // settings is immediate; the value itself is saved with the
  // rest of the node settings (Save nodes).
  $('btc-secondary-enabled').addEventListener('change', syncSecondaryEnabled);

  // The Add form's fallback row: shown only while the route
  // is Slipstream — when the route is public the setting is stored
  // but ignored, and the row hides. The note under the select says
  // what the chosen duration means.
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
  // The Add card is add-only now: editing lives
  // in the popup, so this button always POSTs new transactions.
  // "+ Add Tx" IS "add trigger set": one
  // Save creates ALL filled entries (notes + hex each, the
  // shared rules and route below) and then creates a COMPLETE
  // INDEPENDENT new trigger set holding them, with the ONE label
  // above the entries. The txs carry the shared trigger in
  // their own record too — it stays dormant while they are in
  // the set, and it is what they fall back to if the set is
  // ever deleted. Blank entries are skipped; an entry with
  // notes but no hex is an error naming it. With one entry
  // filled in, this is the one-transaction case of the same
  // flow (same validation, same already-satisfied confirm,
  // same success path). After a successful add the form clears,
  // ready for the next set. A failure after some txs were
  // created leaves those txs staged standalone — the error
  // says so, and the set is not created.
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
          // The set itself: one POST holding the new txs, the
          // one label, and the shared triggers. The gate on the
          // tx POSTs above runs first with the same trigger, so
          // by here the already-satisfied case is either clear
          // or confirmed (triggerConfirmed rides along).
          var setBody = { label: setLabel, txIds: created.map(function (t) { return t.id; }), trigger: trig, enabled: true };
          if (triggerConfirmed) setBody.triggerConfirmed = true;
          var sr = await api('POST', '/api/bitcoin/sets', setBody);
          setCreated = true;
          if (sr && sr.checkinReset) checkinReset = true;
          if (sr && sr.triggerWarning) triggerWarning = sr.triggerWarning;
          // The popup closes on success; the confirmation lands in
          // the Staged Transactions card (visible after the popup
          // closes). Errors stay in the popup (btc-msg) so the
          // owner can fix them without losing the form.
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
          // The server's already-satisfied gate (price or
          // UTXO) is the backstop for the pre-check above — the
          // price can cross, or the pre-check can fail, between
          // the check and the add. A gate 400 offers the same
          // confirm instead of a dead error — but only when
          // nothing was created yet; a failure mid-batch is a
          // partial add, reported as one.
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
    // A new tx with a CHECK-IN rule is
    // armed by default — adding one while the clock is in the
    // danger zone (the last 25% of ITS window, including already
    // past due) would let the release fire soon after. Warn
    // first; the server resets the check-in in that case anyway
    // (a direct API call cannot bypass it). A price, UTXO, or
    // manual rule never touches the clock, so it never warns
    // about a reset. The soonest check-in rule measures the
    // window when the set has more than one.
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
    // A price, UTXO, block-height,
    // set-date, or fee-market rule whose condition is ALREADY
    // satisfied would fire on the next evaluation — ask the
    // server once (live, no state change) and warn first, so an
    // already-spent outpoint, an already-crossed price, a passed
    // height or date, or an already-low fee is never a surprise.
    // Confirming adds it with triggerConfirmed, so the server's
    // already-satisfied gate lets the rule through.
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

  // Import a signed transaction from a file: the file's hex is put
  // in the "Signed transaction" box — it does NOT add the
  // transaction. The user adds a label/note in the fields and clicks
  // "+ Add transaction" (the normal paste path) to add it, or Save
  // changes in the edit popup. A hex file goes straight in the box;
  // a PSBT file is finalized server-side (preview endpoint) first
  // and the extracted raw hex goes in the box. A PSBT that is not
  // fully signed is rejected by the server with the inputs named,
  // and the box is left alone. Shared by the Add card (btc-*), the
  // edit popup (edit-*), and the set modal's new entries — hexEl /
  // msgEl name the target elements, so each entry's own import
  // button fills its own box. A successful import just fills the
  // hex box; there is no success message (the filled box is the
  // confirmation). Errors still report through msgEl.
  // Which hex box the next file read fills: set by the import
  // button that was clicked (each entry's button records its own
  // box); the Add form's static first entry is the default.
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
          // Raw binary PSBT: finalize it server-side, then put the
          // extracted hex in the box. Base64-encoded here so it
          // survives the JSON body.
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
  // The static first entry's import button lives inside that
  // entry — it records the static hex box as the
  // target, like every entry's button records its own.
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

  // The modal does double duty: a confirmation dialog (Broadcast Now,
  // Broadcast Armed, Delete — Proceed + Cancel) and a details pop-out
  // (a broadcast log entry — no Proceed, Cancel reads "Close").
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
    // A Cancel/close must not leave a flipped control
    // stuck on screen: the checkbox has already changed by the time
    // the confirm opens, and nothing re-rendered it. The caller may
    // pass an onCancel (usually a re-render) that runs when the
    // dialog is dismissed any way other than Proceed.
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
    // A new API key lives only in this page's memory, and only while
    // its pop-out is open: closing the pop-out any way (the X, the
    // Close button, or the backdrop) drops the plaintext and empties
    // the pop-out, so the key is never shown again — not even on this
    // page. Harmless for the other modal uses (their details are
    // rebuilt on every open).
    newKeyPlain = null;
    $('modal-details').innerHTML = '';
    // The dismiss-any-other-way hook (see showConfirm): it runs
    // after the modal is closed and the pending action cleared, so
    // a Cancel re-render cannot resurrect the dialog or re-fire.
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
  // The X in the modal's top-right corner closes it, like Cancel.
  // Guarded: a mixed tree (new script, old page) must degrade to a
  // missing X, not a dead page — the modal still closes via Cancel
  // or the backdrop.
  var modalX = $('modal-x');
  if (modalX) modalX.addEventListener('click', hideConfirm);

  // The "Your connection IP is:" line fills itself in from the host this
  // page was opened on — that host IS this Pi (LAN IP, umbrel.local,
  // or Tailscale IP), so the receiver address is always right and
  // nothing needs typing in by hand. The server can't know the LAN
  // address (the container only sees its own bridge IP), which is
  // why the page does it. Called once at startup; the line is static
  // HTML, so nothing re-renders it. One address for every connection
  // method — the check-in endpoint, the health check, and any client
  // all hang off it, so the card shows only the address and the key.
  function fillConnectLine() {
    var host = window.location.hostname || 'localhost';
    var el = $('api-keys-receiver-url');
    if (el) el.textContent = 'http://' + host + ':3101';
  }
  fillConnectLine();

  // A broadcast log entry, clicked: the full details of that entry in
  // a pop-out — the full TXID, what happened, and the full signed hex
  // of the transaction (looked up from the stored list by TXID; the
  // log itself still only carries a short preview). If the transaction
  // is no longer stored, the preview is all that is left.
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

  // Broadcast a whole set now: every member, in the
  // set's order. The confirm names the stale rule: a stale member
  // is skipped, not sent — the rest still broadcast. Only a set
  // whose every member is stale sends nothing at all.
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

  // The manual escape hatch for a slow MARA tx (Pending
  // card): broadcast a Slipstream-pending transaction publicly
  // instead. MANUAL ONLY — it is not part of Broadcast Armed or the
  // release. The confirm names the privacy cost: the tx is
  // currently private in MARA's mempool, and broadcasting it
  // publicly puts it in the public mempool, visible to everyone.
  // On success the tx becomes public-pending (and follows the
  // normal path from there: confirmed -> Archived). On failure the
  // error is surfaced and the tx stays Slipstream-pending.
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

  // Broadcast Armed: one button on the main card — "Broadcast armed" — with
  // its own confirmation dialog. It sends only the armed
  // unbroadcasted transactions; the unarmed ones are left alone.
  // Cancel sends nothing. The dialog names the count, and once the
  // owner proceeds, a status pop-out says what is being attempted
  // and then what completed, one line per transaction, so a mixed
  // result (one broadcast, one stale) is legible instead of a single
  // aggregate line. The pop-out stays open until the owner closes
  // it; closing it mid-run leaves it closed and lets the aggregate
  // line below the buttons speak. The archived and pending ones are
  // never attempted or counted: their ids are not sent, and the
  // server skips them too. A Slipstream-pending tx is never
  // broadcast publicly by Broadcast Armed — the public escape hatch
  // is a separate manual button on its card.
  // Broadcast Armed: only the armed unbroadcasted transactions —
  // the unarmed ones are left alone. The armed-only filter is applied
  // client-side (which ids are sent) AND server-side (the armedOnly
  // flag), so a stale or disarmed id in the request is still never
  // broadcast.
  async function broadcastArmed() {
    // Set members are never broadcast as standalone txs:
    // their arm lives on the set, so they are excluded here and
    // the armed SETS are broadcast through their own endpoint.
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

  // The actual Broadcast Armed run: the progress pop-out, the POST
  // (armedOnly: true), the per-transaction results. Nothing is
  // broadcast until the owner confirms in the dialog.
  // `setTargets` are armed sets, broadcast one set at a
  // time through their own endpoint; their member results join
  // the same combined summary and pop-out as the tx results.
  async function runBroadcastAll(targets, armedOnly, label, setTargets) {
    setTargets = setTargets || [];
    if (!targets.length && !setTargets.length) {
      setMsg($('btc-all-msg'), 'Nothing to broadcast — no armed transactions to broadcast.', true);
      return;
    }
    // Targets here are standalone txs only
    // (members are excluded above, sets get their own line) —
    // a label-less one reads its short txid.
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
            // Set-member results arrive with
            // the member's own (empty) label — resolve the tx by
            // id so a member reads '"<set label>" - Tx N' here
            // too, and a label-less standalone its short txid.
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
      // The shared-input warnings come from the state on the next
      // load (renderBitcoin derives them from the stored
      // transactions), so there is nothing to keep from this run —
      // the aggregate note below still names the shared inputs.
      // The aggregate line is amber (not red) when the only reason
      // nothing would broadcast is timelocks: a timelocked dry-run
      // is a warning, not a failure, and the release will retry it.
      // And it is the default colour — not red — when the run
      // completed cleanly and simply nothing would broadcast
      // (e.g. every staged tx is disarmed on purpose): red is
      // reserved for a run where a transaction errored.
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

  // Confirmation counts for broadcast transactions, refreshed from the
  // network. The UI polls this every minute while any transaction is
  // broadcast, so the number stays accurate without a reload; the
  // server also refreshes it on the hourly tick. Best-effort: a failed
  // refresh keeps the last known value on the card.
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
        // The pill follows the network verdict too: a broadcast the
        // network no longer knows flips Broadcasted -> Failed (and
        // back if it shows up again) without waiting for a reload.
        if (card && card.pill && tx) {
          var pst = txStatus(tx);
          card.pill.textContent = pst.label;
          card.pill.className = 'pill ' + pst.cls;
        }
      });
      // A tx that changed buckets (pending -> archived on its first
      // confirmation, or back if it drops out of the mempool) needs
      // a re-render so its card moves lists — the in-place pill
      // update above cannot move it. load() is safe here: the bucket
      // is stable after the move (confirmations only go up, and a
      // Failed card stays archived), and the server caches a
      // confirmation check for 60s, so the re-render's own refresh
      // reads the same values and does not loop.
      if (bucketChanged) await load();
    } catch (e) { /* the last known value stays on the card */ }
  }
  setInterval(refreshConfirmations, 60 * 1000);

  // ---------- live view ----------
  // The page updates itself: pills, prices, fees, block height,
  // check-in bars — without a manual reload, and without
  // interrupting anything the owner is doing. Two parts:
  //   - a 1-second timer (liveSecondTick) that recomputes
  //     the check-in countdown from the clock (no fetch),
  //     and triggers a server refresh once per check cadence;
  //   - the server refresh (liveRefresh), which fetches the
  //     state and patches changed VALUES in place. A structural
  //     change — a tx added, removed, or moved between the
  //     staged / pending / archived lists — waits for a safe
  //     moment (no popup open, no field focused) and then does
  //     a full load(); until then the values still update
  //     behind the popup. Nothing here ever writes into an
  //     input, a select, or a modal subtree.
  // The refresh interval IS the check cadence: new server
  // data only appears once per tick, so polling faster wastes
  // fetches. Read live from settings, so a Settings change takes
  // effect without restarting anything. Clamped to the server's
  // own bounds (10–3600s, default 60).
  function liveCadenceMs() {
    var c = (S.settings && typeof S.settings.checkCadenceSeconds === 'number') ? S.settings.checkCadenceSeconds : 60;
    if (!isFinite(c)) c = 60;
    c = Math.max(10, Math.min(3600, c));
    return c * 1000;
  }
  // The structural signature: everything a values-only
  // patch cannot change — the tx set and each tx's bucket, label,
  // notes, trigger set, broadcast/release state, history length,
  // and the render-relevant details; the shared-input map; the
  // settings (a settings change rewrites input values, which the
  // patch never touches); the check-in bar keys; the exchange
  // source count; the check-in key ids. Everything else (prices,
  // fees, tip height, pill states, rule slices, day counts,
  // confirmations, last-checked times, node checks, grace text,
  // log rows) is values and patches in place.
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
    // Sets are structural too: the set itself and each
    // set's bucket, label, arm, members, trigger set, and history
    // length. A member's bucket is already in sigTxs above.
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
  // A full re-render is only safe when nothing the owner is
  // doing can be clobbered: no popup open (Add / Edit / confirm
  // — including the details pop-out and the new-key pop-out,
  // which both use the confirm modal) and no field focused.
  // The in-place patch never needs this — it touches neither.
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
  // Patch the check-in bars in place: same numbers as
  // renderDashboard builds — matched by tx + rule index, so a
  // bar never moves or rebuilds, only its fill, colour, and
  // caption change.
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
  // Patch the readiness rows in place: the status pill
  // and the fee pill per active tx. A fee pill appears or
  // disappears with the verdict (cold fee data hides it, exactly
  // like a fresh render); the condition line never changes
  // without a trigger change, which is structural.
  // Set rows patch by the same rule as the
  // set card — setPillText / setStatus — keyed 'set:' + id.
  // A set row has no fee pill to patch. Rows are rebuilt, never
  // resurrected, by the patch: it only touches entries the
  // render created, so a tick can never bring back a per-member
  // row.
  // A set's member lines carry no pill any
  // more — the patch keeps their text (number + short txid,
  // amount) in step instead, keyed by tx id. The same rule:
  // only lines the render created are touched, so a tick can
  // neither duplicate a member line nor resurrect a removed
  // one. A member that stopped being live (settled / pending)
  // is a structural change — its line goes away on the next
  // re-render, never here — and a newly live member never gains
  // a line from the patch.
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
          if (ment.left) ment.left.textContent = parts.left;
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
  // Patch one tx card in place: the header pill, every
  // rule pill + state line, the sent line, the fee-verdict
  // suffix, the Slipstream queue line, and the fallback
  // countdown. The label, amount, trigger conditions (a trigger
  // change is structural), toggle, and Details rows are never
  // touched here.
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
  // Patch one set card in place: the header pill and
  // every shared-rule pill + state line — the mirror of
  // patchTxCard, minus the per-tx lines (the set has no fee
  // verdict, MARA line, fallback, or sent line of its own; its
  // members' Details rows are never patched here).
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
  // The values-only patch: every live value on the page,
  // updated in place from the freshly fetched state. S and
  // lastStatus are already the new data when this runs. It never
  // rebuilds a list, never writes an input value, and never
  // touches a modal subtree — so it runs on every tick, even
  // while the owner is typing.
  function patchLive(status, checkins, blog) {
    renderStatusHead(status);
    renderGraceCard();
    var anyStaged = (S.bitcoin.txs || []).some(function (t) { return !txStatus(t).settled && !txStatus(t).pending; });
    var gsCard = $('getting-started-card');
    if (gsCard) gsCard.style.display = anyStaged ? 'none' : '';
    var anyCheckinActive = (S.bitcoin.txs || []).some(function (t) { return hasRuleType(t, 'checkin') && !txStatus(t).settled && !txStatus(t).pending && !setOfTxId(t.id); })
      || (S.bitcoin.sets || []).some(function (s) { return hasRuleType(s, 'checkin') && !setStatus(s).settled && !setStatus(s).pending; });
    var showCheckin = anyCheckinActive || !(S.bitcoin.txs || []).length;
    $('checkin-card').style.display = showCheckin ? '' : 'none';
    patchCheckinBars(status);
    patchReadinessRows();
    var conn = (S.bitcoin && S.bitcoin.connection) || {};
    renderNodeStatus('readiness-', 'primary', status.primaryApiUrl, conn);
    renderNodeStatus('readiness-', 'secondary', status.secondaryApiUrl, conn);
    renderExchangeRows(status);
    // The Logs tab has no inputs in it — rebuilding its rows is
    // safe any time, even with a pop-out open over it.
    renderLogs(checkins, blog);
    var overlapsByTx = computeOverlaps();
    (S.bitcoin.txs || []).forEach(function (tx) { patchTxCard(tx, overlapsByTx); });
    (S.bitcoin.sets || []).forEach(function (s) { patchSetCard(s); });
    // Settings live bits are text only, never input values:
    // node rows, price-source rows (they read the dropdowns,
    // never write them), the agreement span, and the fee zone
    // bar (it reads the two number inputs and moves the ranges).
    renderNodeStatus('btc-', 'primary', S.settings.primaryApiUrl, conn);
    renderNodeStatus('btc-', 'secondary', S.settings.secondaryApiUrl, conn);
    refreshPriceSourceRow(1);
    refreshPriceSourceRow(2);
    var agreeSpan = $('price-sources-agreement');
    if (agreeSpan) agreeSpan.textContent = ((S.settings && typeof S.settings.priceAgreementPct === 'number') ? S.settings.priceAgreementPct : 5) + '%';
    updateFeeZoneBar();
  }
  // Whole days since the last check-in, measured from the
  // EFFECTIVE last check-in (the real one plus the frozen time)
  // — the same math as the server's checkinClock, so a disarmed
  // or vacation-frozen clock stays put while a live one
  // advances. Null when no check-in is recorded yet.
  function checkinDaysSince(tx, nowMs) {
    var last = (S.checkin && S.checkin.lastCheckinAt) ? new Date(S.checkin.lastCheckinAt).getTime() : NaN;
    if (!isFinite(last)) return null;
    var effLast = last + liveOffsetMs(tx);
    return Math.max(0, Math.floor((nowMs - effLast) / 86400000));
  }
  // The check-in countdown, ticked locally every second:
  // pure clock math, no fetch. The dashboard bars (fill, colour,
  // caption) and the check-in rules' third rows on the tx cards
  // recompute from the cached last check-in — so a day boundary
  // lands within a second instead of waiting for the next server
  // refresh. Only the day count moves (whole days, like the
  // server); the pill / met status still comes from the server
  // on the tick.
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
  // A full re-render can shift the page (a card moving lists
  // changes the heights above the viewport) — hold the scroll
  // position across it. Only used on the structural path, which
  // never runs while the owner is typing. The in-place patch
  // never scrolls anything, so it needs no help.
  async function loadPreservingScroll() {
    var y = (typeof window !== 'undefined' && typeof window.scrollY === 'number') ? window.scrollY : 0;
    await load();
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, y);
  }
  // One server refresh: fetch the state, then either
  // patch the values in place (same structure) or, for a
  // structural change, do a full load when it is safe — or defer
  // it and patch the values anyway when it is not. A failed
  // fetch leaves the last known values on screen; the next tick
  // retries.
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
        // Values still update behind the popup / while typing;
        // the structure (new or moved cards) waits for a safe
        // moment. lastLiveSignature stays at the rendered
        // structure, so the wait ends the moment it is safe.
        patchLive(nstatus, ncheckins, nblog);
        pendingStructural = true;
      }
    } catch (e) {
      /* the last known values stay on screen; the next tick retries */
    } finally {
      liveRefreshInFlight = false;
    }
  }
  // The 1-second timer: the check-in countdown
  // updates every second from the clock; a server refresh runs
  // once per check cadence; a deferred structural change
  // re-renders the moment it is safe. Paused while the tab is
  // hidden — on return the cadence gate is already open, so the
  // refresh fires at once.
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
  // Live view: one 1-second timer drives the local
  // countdown and triggers a server refresh once per check
  // cadence (see liveSecondTick). A single timer (not a cadence
  // interval) so a Settings change to the cadence takes effect
  // without restarting anything, and the countdown keeps ticking
  // between server refreshes.
  setInterval(liveSecondTick, 1000);

  // ---------- settings ----------
  function renderSettings() {
    $('set-vacation').checked = !!S.settings.vacationMode;
    $('set-vacation-until').value = S.settings.vacationUntil || '';
    // No end date means indefinite (until the owner says they're
    // back) — the checkbox mirrors that, and the date input is
    // disabled while it is checked.
    $('set-vacation-indefinite').checked = !S.settings.vacationUntil;
    $('set-vacation-until').disabled = !S.settings.vacationUntil;
    // A new check-in rule defaults to 35 days — but
    // only while the Add form is untouched (no hex pasted yet),
    // so a re-render never clobbers a value the owner is
    // mid-typing. The days field lives in the first
    // rule panel now.
    if (!$('btc-hex').value.trim()) {
      if (ruleLists.btc.panels.length) ruleLists.btc.panels[0].f.threshold.value = '35';
    }
    // BTC price sources: two provider selects, populated
    // from the provider list the server serves (with a fallback
    // copy so the selects still work against an older server),
    // plus the last fetched price per source, from the cache.
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
    function providerLabel(id) {
      for (var i = 0; i < providers.length; i++) if (providers[i].id === id) return providers[i].label;
      return id;
    }
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
    // Custom sources: when a slot holds a custom object,
    // its URL + JSON-path inputs show the saved values; the
    // visibility itself is set by refreshPriceSourceCustom below.
    [1, 2].forEach(function (n) {
      var v = psrc['source' + n];
      if (v && typeof v === 'object') {
        var u = $('set-price-source' + n + '-url'); if (u) u.value = v.url || '';
        var pp = $('set-price-source' + n + '-path'); if (pp) pp.value = v.path || '';
      }
      refreshPriceSourceCustom(n);
    });
    // The row shows the provider name with its last price inline
    // next to the status pill — "Kraken $98,200 [OK]" — the same
    // shape as the readiness card's Exchange Status rows. The
    // price comes from the last Test verdict for the row, or from
    // the cached reading when there is none.
    // refreshPriceSourceRow (module level) re-renders the row, and
    // the dropdowns' change listeners (attached once, next to the
    // Save listener) call it on every change — so the row and the
    // Test connection button always agree on which provider they
    // mean. A changed dropdown never leaves the old name showing.
    refreshPriceSourceRow(1);
    refreshPriceSourceRow(2);
    // Grace period: the toggle plus the two
    // dropdowns reflect the saved settings — the toggle is the
    // off switch (missing in old state means on), the offline gap
    // that triggers a grace and how long it lasts (null =
    // indefinite, until resumed). A stored duration of 0 (the old
    // off switch) displays as 7 — the toggle carries the off
    // state now, so flipping it on shows a real duration. The
    // options are static in index.html; renderSettings only sets
    // the value, so a re-render never clobbers a choice the
    // owner is mid-changing (the Save handler reads the
    // dropdowns, not S.settings).
    $('grace-enabled').checked = S.settings.graceEnabled !== false;
    var go = (S.settings && typeof S.settings.graceOfflineDays === 'number') ? S.settings.graceOfflineDays : 7;
    $('set-grace-offline').value = String(go);
    var gd = (S.settings && S.settings.graceDurationDays !== undefined) ? S.settings.graceDurationDays : 7;
    if (gd === 0) gd = 7; // a stored 0 meant off; the toggle says off now
    $('set-grace-duration').value = (gd === null) ? 'indefinite' : String(gd);
    syncGraceEnabled();
    // User controls: the three number inputs reflect the
    // saved settings — price agreement (%), check cadence
    // (seconds), fee verdict multipliers (× peak). The inputs
    // are set from S.settings, so a re-render never clobbers a
    // choice the owner is mid-changing (the Save handlers read
    // the inputs, not S.settings). The price-sources note names
    // the agreement — its span stays in sync with the setting.
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
    // The fee-history note under the Broadcast Fee Risk
    // card: what the peak actually covers, or that it is still
    // building — the peak appears only after a day of readings
    // (24 hourly observations).
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

  // BTC price sources: save the two source choices — a
  // provider id string, or a Custom { url, path } object. The
  // server rejects an unknown provider, a bad custom URL/path,
  // or two identical sources (400) — the error shows in the
  // message line.
  // BTC price sources: re-render one source row from
  // the provider its dropdown currently holds. The row shows the
  // provider name with its last price inline next to the status
  // pill — "Kraken $98,200 [OK]" — the same shape as the
  // readiness card's Exchange Status rows. The pill reads OK /
  // Failed / Not Tested — never '—'. It is test-driven: the last
  // Test connection verdict for that row (kept in
  // priceSourceStatus / priceSourcePrice, in this session, keyed
  // by row) wins — but only an actual test result ('ok' or
  // 'failed'). A change reset is NOT a verdict: it deletes the
  // row's verdict, so the row falls back to the cached reading
  // below. With no verdict it reflects the cached reading in
  // the Exchange Status — but only when the dropdown still holds
  // the SAVED source for this slot. A changed (unsaved)
  // selection has no cached reading, so it reads Not Tested
  // with no price until it is tested. The Exchange Status is
  // only current when the cache is for the configured sources,
  // so a stale cache reads Not Tested with no price, never a
  // wrong one. Pass resetStatus when the dropdown changes.
  // Keying by row (source1/source2 — a custom source has no
  // provider id to key by) means a test verdict survives a save
  // for a source that is unchanged in that row — a source
  // tested OK stays OK after saving. Changing the dropdown
  // resets the row to Not Tested first, so a verdict can never
  // linger on a different source than the one tested. The change
  // listeners are attached once, here, like the rest of the
  // app's select listeners (renderSettings runs on every load,
  // so attaching them there would stack a duplicate each time).
  // Custom price sources: the URL + JSON-path inputs for
  // a row show only while that row's dropdown holds Custom.
  function refreshPriceSourceCustom(n) {
    var sel = $('set-price-source' + n);
    var box = $('price-source' + n + '-custom');
    if (!sel || !box) return;
    box.style.display = (sel.value === 'custom') ? '' : 'none';
  }
  // Two source values are the same selection: a provider id
  // compared as a string, or a Custom object compared on its URL
  // + JSON path (the id is 'custom' for both).
  function samePriceSource(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    if (!a || !b) return a === b;
    return a.id === b.id && (a.url || '') === (b.url || '') && (a.path || '') === (b.path || '');
  }
  // One source's value for save/test: a built-in is its id
  // string; Custom is the { id, url, path } object from its two
  // inputs (trimmed; the server rejects a bad URL or path).
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
      // No test verdict for this row: fall back to the cached
      // reading, but only when the dropdown still holds the saved
      // source for the slot (samePriceSource compares a provider
      // id, or a Custom object's URL + path).
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
    // The price sits to the right of the status pill, in the same
    // small muted text as the node rows' values ("Reachable") —
    // never inside the label span.
    var priceEl = $('price-source' + n + '-price');
    if (priceEl) priceEl.textContent = (typeof price === 'number' && Number.isFinite(price)) ? '$' + price.toLocaleString('en-US') : '';
    setPriceSourceStatus(n, status);
  }
  $('set-price-source1').addEventListener('change', function () { refreshPriceSourceRow(1, true); refreshPriceSourceCustom(1); });
  $('set-price-source2').addEventListener('change', function () { refreshPriceSourceRow(2, true); refreshPriceSourceCustom(2); });

  $('btn-save-price-sources').addEventListener('click', async function () {
    var s1 = priceSourceValue(1);
    var s2 = priceSourceValue(2);
    try {
      var s = await api('PUT', '/api/settings', { priceSources: { source1: s1, source2: s2 } });
      S.settings = s;
      setMsg($('price-sources-msg'), 'Price sources saved.', true);
      // The test verdicts are keyed by row, so they are NOT
      // cleared here — a source that was tested and returned a
      // price stays OK after saving. A source that was just
      // changed (and not yet tested) had its verdict deleted by
      // its change listener, so the re-render after load() falls
      // back to the cached reading for the saved source.
      // (Clearing the map would flip a tested source back to
      // Not Tested on save, because the re-render would find no
      // cached reading for the newly-saved source yet.)
      await load();
    } catch (e) { setMsg($('price-sources-msg'), e.message, false); }
  });

  // Grace on/off: the toggle is the first option on the
  // grace card, inline with the heading — off hides the two
  // dropdowns, but their values are never cleared, so
  // re-enabling brings them back as saved. The toggle lives in
  // the card heading, so it never hides with the settings it
  // controls. The title syncs with the state.
  function syncGraceEnabled() {
    var on = $('grace-enabled').checked;
    $('grace-fields').style.display = on ? '' : 'none';
    $('grace-enabled-wrap').title = on ? 'Grace period on — triggers pause after an offline gap' : 'Grace period off — triggers fire immediately';
  }

  // Grace period: save the grace settings. The
  // server rejects any value the dropdowns do not offer (400)
  // — the error shows in the message line. The toggle rides
  // with the rest of the grace settings, so turning the grace
  // off never clears the saved dropdowns — re-enabling brings
  // them back as saved. Saving new values does NOT change an
  // already-active grace (it keeps the duration it was created
  // with) — but turning the toggle off makes the grace read as
  // none everywhere at once, so held triggers fire immediately.
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

  // Grace on/off: hiding/showing the grace options is
  // immediate; the value itself is saved with the rest of the
  // grace settings (Save grace period).
  $('grace-enabled').addEventListener('change', syncGraceEnabled);

  // User controls: each card saves only its own
  // field(s). The server rejects an out-of-range value or a
  // fee pair that breaks Low-above-Medium (400) — the error
  // shows in the message line. parseFloat (not parseInt) so a
  // decimal the owner typed (e.g. 2.5%) reaches the server
  // instead of being silently truncated; a blank field parses
  // to NaN, which JSON sends as null and the server rejects.
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

  // Fee verdict zone bar: always visible under the numbers,
  // showing the three zones as a bar that moves live as you type.
  // The boundaries are the two input values; the scale grows past
  // 3× when Low is set above it so the green zone always has
  // headroom. Critical Risk is separate and hard-coded, so it is
  // not a zone here. The bar reflects whatever is in the inputs,
  // so it is there whether or not you are editing — no show/hide.
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

  // BTC price sources: ONE "Test connection" button
  // tests BOTH sources at once — like the Node Status "Test
  // connection" button tests all nodes. It tests the sources
  // currently selected in the two dropdowns (a provider or
  // Custom, not only the two configured ones) with fresh fetches
  // (the server bypasses the price cache), and shows both results
  // inline on the rows. The configured sources and the cache are
  // untouched.
  async function testPriceSources() {
    var btn = $('btn-test-price-sources');
    if (!btn) return;
    var ids = [priceSourceValue(1), priceSourceValue(2)];
    btn.disabled = true;
    try {
      var r = await api('POST', '/api/settings/price-sources/test-all', { providers: ids });
      // The results land on the rows themselves — each row shows
      // its price inline next to its pill ("Kraken $98,200 [OK]"),
      // the same shape as the readiness card's Exchange Status
      // rows. There is no results line under the button.
      // The results come back in the order requested, so result i
      // is row i + 1; the verdict is keyed by row, so it survives a
      // save for that row.
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

  // Settings "?" help: every Settings card has a "?"
  // button in its header that opens the shared showDetails
  // pop-out with what the setting is, what it does, and which
  // trigger types it applies to ("Applies to:"). The pop-out
  // closes the same way the other pop-outs do (X / Close /
  // backdrop) — showDetails owns that behaviour.
  //
  // SINGLE SOURCE OF TRUTH: this registry is the ONE
  // declaration of which trigger types each card applies to.
  // The "?" pop-out renders its "Applies to" line FROM the
  // triggers array (helpAppliesLabel, below), and the Settings
  // filter at the top of the tab decides visibility FROM the
  // same array. There is no second copy of the mapping
  // anywhere: update the array here and both stay in
  // alignment. The nuanced prose (e.g. the nodes broadcast
  // note, the grace check-in-hold note) lives in the BODY,
  // not in the "Applies to" line.
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
      body: 'The Bitcoin nodes Standby talks to. The primary is tried first; if it fails, the secondary is used.\n\nToggle the secondary off to use the primary alone with no fallback if it is down or unreachable.\n\nThe address is a mempool instance \u2014 mempool.space by default, another public instance, or your own mempool on the LAN.\n\nUTXO, block-height, and fee-market triggers read the node, and broadcasts go through it.',
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
      body: 'Back up or restore everything Standby knows. A backup is a file holding all your staged transactions, triggers, and settings.\n\nRestoring replaces the current state with the backup\u2019s \u2014 a restore counts as a check-in and clears any active grace period.\n\nDownload it encrypted with a password you choose (recommended) or unencrypted. Encrypted, the file is useless without the password \u2014 and Standby cannot recover a lost password, so write it down somewhere other than this device. Unencrypted, it contains the signed hexes, which anyone can broadcast and which reveal the destination addresses and amounts, so treat it like the transactions themselves.\n\nAn encrypted backup can also be opened without Standby, using tools/decrypt-backup.js from the Standby repository.',
      triggers: ['general'],
    },
    // No title/body: the version card has no "?" button and no
    // details pop-out — just the version line. The entry exists
    // only so the filter knows it is General (bottom of General
    // settings, hidden under the trigger filters).
    version: {
      triggers: ['general'],
    },
  };
  // The "Applies to" label, derived from the triggers array —
  // never a second hardcoded per-card string. Trigger codes
  // alone: one code reads "<Name> triggers only", two read
  // "<Name> and <Name> triggers", three or more read an Oxford
  // list ("<Name>, <Name>, and <Name> triggers"), all seven read
  // "All trigger types". 'general' alone reads "General — not
  // tied to a specific trigger"; 'general' WITH trigger codes
  // reads "<Trigger label>, and general infrastructure" (the
  // 'only' drops, because the card's scope is wider than that one
  // trigger — e.g. Bitcoin nodes: "UTXO triggers, and general
  // infrastructure").
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

  // Settings filter: a dropdown at the top of the
  // Settings tab, so it takes one row instead of two. It reads
  // the SAME triggers array the "?" pop-out renders its
  // "Applies to" line from — no second mapping. "All settings"
  // shows every card; a trigger filter shows the cards whose
  // array includes that trigger. No persistence: the default is
  // All, and showing the Settings tab resets to All (see showTab).
  var settingsFilter = 'all';
  function applySettingsFilter(name) {
    if (!SETTINGS_HELP) return;
    settingsFilter = name;
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

  // ---------- check-in API keys ----------
  // One labelled key per service that may check in for the owner. The
  // plaintext key is shown ONCE, when it is created, in a pop-out —
  // it lives only in this page's memory afterwards (closing the
  // pop-out drops it for good; a reload hides it too; the list keeps
  // showing the key's label and last-used time, never the key
  // itself). Revoking one key leaves the others working.
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

  // The new-key pop-out: the key, a Copy key button, and an X to
  // close it (the modal's own X, the Close button, or the backdrop —
  // all go through hideConfirm, which drops the plaintext and
  // empties the pop-out, so the key is never shown again). Built
  // from real elements, not an HTML string, so the Copy button has
  // a real click handler.
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
  // Download Backup opens a dialog: encrypted with a
  // password the owner chooses (the default), or unencrypted after a
  // warning. The server encrypts (POST /api/backup {password}), so the
  // plain backup never crosses the network when encrypted.
  function backupMode() { return $('backup-mode-plain').checked ? 'plain' : 'encrypted'; }
  function syncBackupMode() {
    var enc = backupMode() === 'encrypted';
    $('backup-encrypted-fields').style.display = enc ? '' : 'none';
    $('backup-plain-fields').style.display = enc ? 'none' : '';
    $('btn-backup-modal-download').textContent = enc ? 'Download encrypted backup' : 'Download unencrypted backup';
  }
  function closeBackupModal() {
    $('backup-modal').classList.remove('open');
    $('backup-password').value = '';
    $('backup-password2').value = '';
    useTypedPassword();
    setMsg($('backup-modal-msg'), '', true);
  }
  // Two ways to set the password: typed twice, or generated. A
  // generated passphrase replaces the typing fields and is shown once,
  // in full (it wraps on a phone) — nothing to repeat or confirm.
  var generatedPassphrase = null;
  function useTypedPassword() {
    generatedPassphrase = null;
    $('backup-generated').textContent = '';
    $('backup-generated-fields').style.display = 'none';
    $('backup-typed-fields').style.display = '';
  }
  $('btn-backup-own').addEventListener('click', function () {
    useTypedPassword();
    setMsg($('backup-modal-msg'), '', true);
    $('backup-password').focus();
  });
  $('backup-mode-encrypted').addEventListener('change', syncBackupMode);
  $('backup-mode-plain').addEventListener('change', syncBackupMode);
  $('backup-modal-x').addEventListener('click', closeBackupModal);
  $('btn-backup-modal-cancel').addEventListener('click', closeBackupModal);
  $('btn-backup-download').addEventListener('click', function () {
    $('backup-mode-encrypted').checked = true;
    syncBackupMode();
    $('backup-modal').classList.add('open');
  });
  // A random passphrase: 6 groups of 5 from an unambiguous alphabet
  // (no 0/o, 1/l/i) — about 145 bits. Shown in the clear so it can be
  // written down.
  $('btn-backup-generate').addEventListener('click', function () {
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
      setMsg($('backup-msg'), 'Restored ' + r.restoredTxs + ' transaction(s) and settings from the backup.', true);
      $('backup-file').value = '';
      await load();
    } catch (e) {
      if (e.message !== 'cancelled') setMsg($('backup-msg'), e.message, false);
      $('backup-file').value = '';
    }
  });

  // App version card: the installed version, from /api/health,
  // shown in the version card at the bottom of General settings.
  // Fetched once at startup — it only changes on an update.
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
  $('btn-logout').addEventListener('click', async function () {
    try {
      await api('POST', '/api/logout');
      setToken(null);
      window.location.reload();
    } catch (e) { setMsg($('logout-msg'), e.message, false); }
  });
  api('GET', '/api/auth/status').then(function (st) {
    if (st && st.required) {
      $('card-session').style.display = '';
      if (!st.authenticated) showLogin();
    }
  }).catch(function () { /* older server or offline: nothing to show */ });

  load().catch(function (e) {
    // The login screen is already up — no error notice.
    if (e.message === 'login required') return;
    if (/state\.json is (corrupt|missing)/.test(e.message)) { showStateError(e.message); return; }
    // The message is error text, not HTML:
    // build the notice with textContent so markup in it renders
    // literally instead of being parsed (insertAdjacentHTML used
    // to splice e.message straight into the page).
    var main = document.querySelector('main');
    var notice = document.createElement('div');
    notice.className = 'notice bad';
    notice.textContent = 'Could not load Standby state: ' + e.message;
    main.insertBefore(notice, main.firstChild);
  });
})();
