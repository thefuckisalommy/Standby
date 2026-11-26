'use strict';
// The state load, restore from a backup, trigger descriptions, the
// Dashboard, the log, and the Add transaction popup.

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
