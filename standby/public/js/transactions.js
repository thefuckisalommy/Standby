'use strict';
// The Transactions tab: node status, transaction and set cards, arming,
// dry runs and editing a transaction.

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
