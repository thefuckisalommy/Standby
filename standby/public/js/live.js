'use strict';
// The confirm and details pop-up, check-ins from other devices,
// broadcasting, and the live view (refreshing the page in place).

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
