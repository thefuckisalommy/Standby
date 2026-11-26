'use strict';
// The Logs tab. Activity: dry runs, broadcasts and check-ins as one
// timeline by day, with filters, search, and each entry's details on a
// tap. App log: Standby's own recent log lines (GET /api/logs/app), with
// level filters, a text filter, Follow and Download.

var logsView = 'activity';
var logsFilter = 'all';
var logsQuery = '';
var logsOpenKey = null; // the expanded activity entry
var logsData = { checkins: [], blog: [] };
var appLog = { lines: [], file: null, max: 500, level: 'all', query: '', loaded: false };

function logsEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function logsDayLabel(d) {
  var today = new Date();
  var y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function logsTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// One broadcast-log entry as { group, kind, name, what, result: { text, cls } }.
function logsBlogItem(e) {
  var tx = (S.bitcoin && S.bitcoin.txs || []).find(function (t) { return t.txid === e.txid; });
  var name = tx ? txDisplayName(tx) : (e.txid ? e.txid.slice(0, 10) + '…' : 'Transaction');
  var via = e.method ? methodLabel(e.method) : '';
  if (e.kind === 'dry-run') {
    var map = {
      'would-broadcast': ['ready, nothing broadcast', 'Ready', 'ok'],
      spent: ['an input is already spent', 'Spent', 'bad'],
      conflict: ['an input is spent by an unconfirmed transaction', 'Conflict', 'warn'],
      timelocked: ['timelocked, the node would refuse it for now', 'Timelocked', 'warn'],
      unknown: ['some inputs could not be checked', 'Unverified', 'warn'],
      own: ['already in the mempool or confirmed', 'Sent', 'ok'],
    };
    var m = map[e.status] || [e.status || '', e.status || '', 'muted'];
    return { group: 'dryrun', kind: 'Dry run', kcls: 'dr', name: name, what: m[0] + (via ? ' · checked on the ' + via : ''), result: { text: m[1], cls: m[2] } };
  }
  if (e.status === 'submitted-slipstream') {
    return { group: 'broadcast', kind: 'Broadcast', kcls: 'bc', name: name, what: 'submitted to MARA Slipstream', result: { text: 'Submitted', cls: 'warn' } };
  }
  if (e.status === 'failed') {
    return { group: 'broadcast', kind: 'Broadcast', kcls: 'bc', name: name, what: 'no node accepted it', result: { text: 'Failed', cls: 'bad' } };
  }
  return { group: 'broadcast', kind: e.kind === 'release' ? 'Release' : 'Broadcast', kcls: 'bc', name: name,
    what: 'accepted' + (via ? ' by the ' + via : ''), result: { text: 'Sent', cls: 'ok' } };
}

function logsCheckinItem(c) {
  var name = c.keyLabel ? c.keyLabel : (c.method === 'api-key' ? 'API key' : c.method === 'restore' ? 'Backup restored' : 'This app');
  var what = c.method === 'api-key' ? 'API key' + (c.sourceIp ? ' · from ' + c.sourceIp : '') : c.method === 'restore' ? 'counted as a check-in' : 'Check in now';
  return { group: 'checkin', kind: 'Check-in', kcls: 'ci', name: name, what: what, result: { text: 'OK', cls: 'muted' } };
}

// Called with each load and live update.
function renderLogs(checkins, blog) {
  logsData = { checkins: checkins || [], blog: blog || [] };
  renderActivity();
}

function renderActivity() {
  var list = $('logs-activity-list');
  if (!list) return;
  var items = [];
  logsData.blog.forEach(function (e, i) {
    var it = logsBlogItem(e);
    it.ts = e.ts; it.key = 'b' + (e.ts || '') + i; it.entry = e;
    items.push(it);
  });
  logsData.checkins.forEach(function (c, i) {
    var it = logsCheckinItem(c);
    it.ts = c.ts; it.key = 'c' + (c.ts || '') + i; it.entry = null;
    items.push(it);
  });
  items.sort(function (a, b) { return (b.ts || '') < (a.ts || '') ? -1 : (b.ts || '') > (a.ts || '') ? 1 : 0; });
  var q = logsQuery.trim().toLowerCase();
  var matched = items.filter(function (it) {
    return !q || (it.name + ' ' + it.what + ' ' + ((it.entry && it.entry.txid) || '')).toLowerCase().indexOf(q) !== -1;
  });
  var counts = { all: matched.length, broadcast: 0, dryrun: 0, checkin: 0 };
  matched.forEach(function (it) { counts[it.group] += 1; });
  ['all', 'broadcast', 'dryrun', 'checkin'].forEach(function (f) {
    var n = $('logs-n-' + f);
    if (n) n.textContent = String(counts[f]);
    var b = $('logs-f-' + f);
    if (b) b.classList.toggle('on', f === logsFilter);
  });
  var shown = matched.filter(function (it) { return logsFilter === 'all' || it.group === logsFilter; });
  list.innerHTML = '';
  if (!shown.length) {
    list.appendChild(logsEl('p', 'muted logs-none', items.length ? 'Nothing matches.' : 'Nothing logged yet. Dry runs, broadcasts and check-ins show here.'));
    return;
  }
  var lastDay = '';
  shown.forEach(function (it) {
    var d = new Date(it.ts);
    var day = isFinite(d.getTime()) ? logsDayLabel(d) : '';
    if (day !== lastDay) { list.appendChild(logsEl('div', 'logs-day', day)); lastDay = day; }
    var row = logsEl('div', 'logs-ev' + (it.key === logsOpenKey ? ' open' : ''));
    row.tabIndex = 0;
    row.appendChild(logsEl('span', 'logs-t', isFinite(d.getTime()) ? logsTime(d) : ''));
    row.appendChild(logsEl('span', 'logs-kind ' + it.kcls, it.kind));
    var what = logsEl('span', 'logs-what');
    what.appendChild(logsEl('b', '', it.name));
    what.appendChild(logsEl('span', '', ' · ' + it.what));
    row.appendChild(what);
    var res = logsEl('span', 'logs-res');
    res.appendChild(logsEl('span', 'pill ' + it.result.cls, it.result.text));
    row.appendChild(res);
    row.appendChild(logsEl('span', 'logs-chev', it.key === logsOpenKey ? '⌄' : '›'));
    row.addEventListener('click', function () {
      logsOpenKey = logsOpenKey === it.key ? null : it.key;
      renderActivity();
    });
    list.appendChild(row);
    if (it.key === logsOpenKey) list.appendChild(logsDetail(it, d));
  });
}

function logsDetail(it, d) {
  var box = logsEl('div', 'logs-evd');
  function kv(k, v, mono) {
    box.appendChild(logsEl('span', 'k2', k));
    var vv = logsEl('span', mono ? 'mono' : '', v);
    box.appendChild(vv);
    return vv;
  }
  kv('When', isFinite(d.getTime()) ? d.toLocaleString() : '');
  var e = it.entry;
  if (!e) {
    var c = logsData.checkins.find(function (x) { return x.ts === it.ts; }) || {};
    kv('Method', c.method === 'api-key' ? 'API key' + (c.keyLabel ? ' “' + c.keyLabel + '”' : '') : c.method === 'restore' ? 'Restored from a backup' : 'This app');
    if (c.sourceIp) kv('From', c.sourceIp, true);
    return box;
  }
  if (e.note) kv('What happened', e.note);
  if (e.method) kv('Via', methodLabel(e.method));
  if (e.txid) {
    var t = kv('TXID', e.txid, true);
    t.classList.add('logs-txid');
  }
  var hex = logsEl('span', '');
  var a = logsEl('button', 'linkbtn', 'Show the signed transaction');
  a.type = 'button';
  a.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); showBroadcastDetails(e); });
  hex.appendChild(a);
  box.appendChild(logsEl('span', 'k2', 'Signed hex'));
  box.appendChild(hex);
  return box;
}

// --- App log ---

function appLogLevelKey(l) { return l === 'WARN' ? 'warn' : l === 'ERROR' ? 'error' : 'info'; }

function renderAppLog() {
  var box = $('logs-console');
  if (!box) return;
  var counts = { all: appLog.lines.length, info: 0, warn: 0, error: 0 };
  appLog.lines.forEach(function (l) { counts[appLogLevelKey(l.level)] += 1; });
  ['all', 'info', 'warn', 'error'].forEach(function (k) {
    var n = $('logs-lvn-' + k);
    if (n) n.textContent = String(counts[k]);
    var b = $('logs-lv-' + k);
    if (b) b.classList.toggle('on', k === appLog.level);
  });
  var q = appLog.query.trim().toLowerCase();
  var shown = appLog.lines.filter(function (l) {
    return (appLog.level === 'all' || appLogLevelKey(l.level) === appLog.level) && (!q || l.msg.toLowerCase().indexOf(q) !== -1);
  });
  box.innerHTML = '';
  if (!appLog.loaded) { box.appendChild(logsEl('p', 'muted', 'Loading…')); return; }
  if (!shown.length) box.appendChild(logsEl('p', 'muted', appLog.lines.length ? 'No lines match.' : 'No log lines yet.'));
  var lastDay = '';
  shown.forEach(function (l) {
    var d = new Date(l.t);
    var day = d.toDateString();
    if (day !== lastDay) {
      var sep = logsEl('div', 'ln date');
      sep.appendChild(logsEl('span', 'ts', ''));
      sep.appendChild(logsEl('span', 'lv', ''));
      sep.appendChild(logsEl('span', 'msg', '— ' + logsDayLabel(d) + ' —'));
      box.appendChild(sep);
      lastDay = day;
    }
    var row = logsEl('div', 'ln ' + appLogLevelKey(l.level));
    row.appendChild(logsEl('span', 'ts', d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })));
    row.appendChild(logsEl('span', 'lv', l.level));
    row.appendChild(logsEl('span', 'msg', l.msg.replace(/^Standby: /, '')));
    box.appendChild(row);
  });
  var foot = $('logs-app-foot');
  if (foot) {
    foot.textContent = 'The last ' + appLog.max + ' lines since Standby started.'
      + (appLog.file ? ' Download includes older lines from ' + appLog.file + ' in the data folder.'
        : ' Older lines: the container’s log (docker logs), where Standby runs in Docker or on Umbrel.');
  }
  if ($('logs-follow').checked && typeof box.scrollTo === 'function') box.scrollTo(0, box.scrollHeight);
}

async function loadAppLog() {
  try {
    var last = appLog.lines.length ? appLog.lines[appLog.lines.length - 1].n : 0;
    var r = await api('GET', '/api/logs/app' + (last ? '?after=' + last : ''));
    appLog.file = r.file || null;
    appLog.max = r.max || 500;
    appLog.lines = appLog.lines.concat(r.lines || []).slice(-appLog.max);
    appLog.loaded = true;
    renderAppLog();
  } catch (e) {
    var box = $('logs-console');
    if (box) { box.innerHTML = ''; box.appendChild(logsEl('p', 'muted', 'Could not load the log: ' + e.message)); }
  }
}

function showLogsView(v) {
  logsView = v;
  $('logs-seg-activity').classList.toggle('on', v === 'activity');
  $('logs-seg-app').classList.toggle('on', v === 'app');
  $('logs-activity').style.display = v === 'activity' ? '' : 'none';
  $('logs-app').style.display = v === 'app' ? '' : 'none';
  if (v === 'app') loadAppLog();
}

$('logs-seg-activity').addEventListener('click', function () { showLogsView('activity'); });
$('logs-seg-app').addEventListener('click', function () { showLogsView('app'); });
['all', 'broadcast', 'dryrun', 'checkin'].forEach(function (f) {
  $('logs-f-' + f).addEventListener('click', function () { logsFilter = f; renderActivity(); });
});
$('logs-search').addEventListener('input', function () { logsQuery = $('logs-search').value || ''; renderActivity(); });
['all', 'info', 'warn', 'error'].forEach(function (k) {
  $('logs-lv-' + k).addEventListener('click', function () { appLog.level = k; renderAppLog(); });
});
$('logs-app-search').addEventListener('input', function () { appLog.query = $('logs-app-search').value || ''; renderAppLog(); });
$('logs-follow').addEventListener('change', renderAppLog);

// Download: the log file where there is one, else the lines kept here.
$('logs-download').addEventListener('click', async function () {
  var text = null;
  if (appLog.file) {
    try {
      var headers = {};
      var token = getToken();
      if (token) headers['X-Standby-Token'] = token;
      var res = await fetch('/api/logs/app/file', { headers: headers });
      if (res.ok) text = await res.text();
    } catch (e) { /* fall back to the lines kept here */ }
  }
  if (text === null) {
    text = appLog.lines.map(function (l) { return l.t + ' ' + l.level + ' ' + l.msg; }).join('\n') + '\n';
  }
  var url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = 'standby.log';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});

// While the App log is on screen, fetch new lines every 5 seconds.
setInterval(function () {
  var tab = $('tab-logs');
  if (logsView === 'app' && tab && tab.classList.contains('active') && !document.hidden) loadAppLog();
}, 5000);
