'use strict';
// The top bar's buttons: back to Umbrel (Umbrel only), Alerts, and Lock
// (a password is set). The logo goes to the Dashboard.
// Alerts list what needs a look now, from what the page already knows:
// a check-in deadline in its last quarter or due, a node or price source
// failing, a transaction that cannot go out cleanly, broadcasts waiting
// to confirm, and a newer version. Each goes away once fixed; tapping one
// opens the tab where it is fixed.

// The Umbrel button and the lock, once the login status is known.
function renderHeaderButtons() {
  var exit = $('exit-app');
  if (exit) exit.style.display = authInfo.deployment === 'umbrel' ? '' : 'none';
  var lock = $('btn-lock');
  if (lock) lock.style.display = authInfo.required ? '' : 'none';
}

// Lock: forget this browser's login and show the login screen. Other
// devices stay logged in (Settings > App login > Log out everywhere ends
// every session).
$('btn-lock').addEventListener('click', function () {
  setToken(null);
  location.reload();
});

$('appbar-brand').addEventListener('click', function () { showTab('dashboard'); });

// One alert: { sev: 'bad' | 'warn' | 'info', title, detail, tab, href }.
function computeAlerts() {
  var out = [];
  if (!S || !S.bitcoin) return out;
  // Check-in: a bar in the last quarter of its window, or due.
  if (lastStatus) {
    checkinBarsData(lastStatus).forEach(function (b) {
      if (b.enabled === false || b.state === 'grace') return;
      var windowDays = (typeof b.windowDays === 'number' && b.windowDays > 0) ? b.windowDays : (b.thresholdDays || 35);
      var left = windowDays - (b.daysSince || 0);
      if (left > 0.25 * windowDays) return;
      var name = '“' + barLabel(b) + '”';
      out.push(left <= 0
        ? { sev: 'bad', title: 'Check-in due', detail: name + ' fires at the next check unless you check in.', tab: 'dashboard' }
        : { sev: 'warn', title: 'Check in soon', detail: name + ' fires in ' + left + (left === 1 ? ' day' : ' days') + ' unless you check in.', tab: 'dashboard' });
    });
  }
  // Nodes and price sources: their Dashboard pills say Failed.
  [['readiness-primary', 'Primary node'], ['readiness-secondary', 'Secondary node']].forEach(function (n) {
    var pill = $(n[0] + '-status');
    if (pill && /\bbad\b/.test(pill.className || '')) {
      out.push({ sev: 'bad', title: n[1] + ' failing', detail: ($(n[0]) || {}).textContent + ' did not answer its last check.', tab: 'settings' });
    }
  });
  var exItem = $('readiness-exchange-item');
  if (exItem && exItem.style.display !== 'none') {
    [1, 2].forEach(function (i) {
      var pill = $('readiness-exchange-' + i + '-status');
      if (pill && /\bbad\b/.test(pill.className || '')) {
        out.push({ sev: 'warn', title: 'Price source failing', detail: ($('readiness-exchange-' + i) || {}).textContent + ' did not answer; price rules wait for two agreeing prices.', tab: 'settings' });
      }
    });
  }
  // Transactions that cannot go out cleanly, and broadcasts waiting.
  var pending = 0;
  (S.bitcoin.txs || []).forEach(function (t) {
    var st = txStatus(t);
    if (st.pending) { pending += 1; return; }
    if (st.settled) return;
    if (st.label === 'Node Failure' || st.label === 'Conflict' || st.label === 'Failed') {
      out.push({ sev: st.label === 'Conflict' ? 'warn' : 'bad', title: st.label + ': ' + txDisplayName(t), detail: st.label === 'Conflict'
        ? 'An input was spent by an unconfirmed transaction; a broadcast is still attempted.'
        : 'Its last check or broadcast attempt failed. Open it for details.', tab: 'bitcoin' });
    }
  });
  if (pending) {
    out.push({ sev: 'info', title: pending + (pending === 1 ? ' transaction' : ' transactions') + ' waiting to confirm', detail: 'Broadcast; Standby keeps checking until it is confirmed.', tab: 'bitcoin' });
  }
  // A newer version (unless "Not now" was chosen for it).
  if (typeof updateInfo !== 'undefined' && updateInfo && updateInfo.enabled && updateInfo.newer) {
    var dismissed = null;
    try { dismissed = window.localStorage.getItem(UPDATE_DISMISS_KEY); } catch (e) { /* none */ }
    if (dismissed !== updateInfo.latest) {
      out.push({ sev: 'info', title: 'Standby ' + updateInfo.latest + ' is available', detail: 'Download it from GitHub; your data stays where it is.', href: updateInfo.url || 'https://github.com/thefuckisalommy/Standby/releases' });
    }
  }
  var rank = { bad: 0, warn: 1, info: 2 };
  return out.sort(function (a, b) { return rank[a.sev] - rank[b.sev]; });
}

function renderAlerts() {
  var list = $('alerts-list');
  var badge = $('alerts-count');
  if (!list || !badge) return;
  var alerts = computeAlerts();
  list.innerHTML = '';
  if (!alerts.length) {
    var none = document.createElement('li');
    none.className = 'alerts-none';
    none.textContent = 'Nothing needs your attention.';
    list.appendChild(none);
  }
  alerts.forEach(function (a) {
    var li = document.createElement('li');
    li.className = 'alert-item ' + a.sev;
    var t = document.createElement('div');
    t.className = 'alert-title';
    t.textContent = a.title;
    var d = document.createElement('div');
    d.className = 'alert-detail';
    d.textContent = a.detail;
    li.appendChild(t);
    li.appendChild(d);
    li.addEventListener('click', function () {
      closeAlerts();
      if (a.href) window.open(a.href, '_blank', 'noopener');
      else if (a.tab) showTab(a.tab);
    });
    list.appendChild(li);
  });
  badge.textContent = String(alerts.length);
  badge.className = 'badge ' + (alerts.length ? alerts[0].sev : '');
  badge.style.display = alerts.length ? '' : 'none';
  $('btn-alerts').title = alerts.length ? alerts.length + (alerts.length === 1 ? ' alert' : ' alerts') : 'Alerts';
}

function closeAlerts() {
  $('alerts-panel').style.display = 'none';
  $('btn-alerts').setAttribute('aria-expanded', 'false');
}
$('btn-alerts').addEventListener('click', function (e) {
  if (e && e.stopPropagation) e.stopPropagation();
  var open = $('alerts-panel').style.display !== 'none';
  if (open) { closeAlerts(); return; }
  renderAlerts();
  $('alerts-panel').style.display = '';
  $('btn-alerts').setAttribute('aria-expanded', 'true');
});
// A tap outside the panel, or Escape, closes it.
document.addEventListener('click', function (e) {
  var panel = $('alerts-panel');
  if (panel && panel.style.display !== 'none' && panel.contains && !panel.contains(e.target)) closeAlerts();
});
document.addEventListener('keydown', function (e) {
  if (e && e.key === 'Escape') closeAlerts();
});
