'use strict';
// Transactions as a list and a detail. The list: search, Dry-run all and
// Add; the Active / Pending / Archived switch; one card per transaction or
// set with its arm switch, one line per trigger (AND / OR, Met or Not met)
// and one line per transaction (where it pays, any problem, its fee risk,
// the amount). The detail: the selected one in full, built here from the
// state; its buttons press the matching buttons of the full cards that
// renderBitcoin still builds (kept out of sight), so every action keeps
// its confirms. On a phone the list comes first and a card opens its own
// screen, with a link back.

var txvSection = 'active';
var txvSelected = null; // 'tx:<id>' or 'set:<id>'
var txvQuery = '';
var txvDetailOpen = false; // phone: the selected one's screen is showing

// Standalone txs and sets, newest first, each with its section and card.
function txvItems() {
  var memberIds = {};
  (S.bitcoin.sets || []).forEach(function (s) {
    (s.txIds || []).forEach(function (id) { memberIds[id] = true; });
  });
  var out = [];
  (S.bitcoin.txs || []).forEach(function (t) {
    if (memberIds[t.id]) return;
    out.push({ key: 'tx:' + t.id, kind: 'tx', holder: t, members: [t], st: txStatus(t), refs: txCardEls[t.id] });
  });
  (S.bitcoin.sets || []).forEach(function (s) {
    out.push({ key: 'set:' + s.id, kind: 'set', holder: s, members: setMembersOf(s), st: setStatus(s), refs: setCardEls[s.id] });
  });
  out.forEach(function (it) {
    it.section = it.st.settled ? 'archived' : (it.st.pending ? 'pending' : 'active');
    it.armed = it.section === 'active' && it.holder.enabled !== false;
  });
  return out.sort(function (a, b) {
    var x = a.holder.createdAt || '';
    var y = b.holder.createdAt || '';
    return (y < x) ? -1 : (y > x) ? 1 : 0;
  });
}

function txvName(it) {
  return it.kind === 'set' ? (it.holder.label || 'Untitled set') : txDisplayName(it.holder);
}

// Search: name, txids, notes and output addresses.
function txvMatches(it, q) {
  if (!q) return true;
  var hay = [txvName(it)];
  it.members.forEach(function (t) {
    hay.push(t.label || '', t.txid || '', t.notes || '');
    var io = t.detail;
    if (io && Array.isArray(io.outputs)) io.outputs.forEach(function (o) { if (o.address) hay.push(o.address); });
  });
  return hay.join(' ').toLowerCase().indexOf(q) !== -1;
}

function txvSum(it) {
  return it.members.reduce(function (a, t) { return a + (Number(t.totalOutSats) || 0); }, 0);
}

function txvShortOut(s, head, tail) {
  s = String(s || '');
  return s.length > head + tail + 1 ? s.slice(0, head) + '…' + s.slice(-tail) : s;
}

// "35d 15h left", "4h 10m left".
function txvLeftText(ms) {
  if (!(ms > 0)) return 'Due';
  var m = Math.floor(ms / 60000);
  var d = Math.floor(m / 1440);
  var h = Math.floor((m % 1440) / 60);
  if (d >= 365) return '~' + (d / 365).toFixed(1) + ' years left';
  if (d >= 60) return d + ' days left';
  if (d > 0) return d + 'd ' + h + 'h left';
  return h + 'h ' + (m % 60) + 'm left';
}

var txvOpenTx = {}; // tx id -> true while its Details are open in the detail
var txvHistOpen = {};

function txvEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

var TXV_TYPE = {
  checkin: ['Check-in', 't-checkin'], price: ['Price', 't-price'], utxo: ['UTXO', 't-utxo'],
  blockheight: ['Block', 't-block'], setdate: ['Date', 't-date'], feemarket: ['Fees', 't-fee'], manual: ['Manual', 't-manual'],
};

// $60,000 -> "$60k", $98,250 -> "$98.3k" (the list's short form).
function txvUsdShort(v) {
  var n = Number(v);
  if (!isFinite(n)) return '$?';
  if (Math.abs(n) >= 1000000) return '$' + (Math.round(n / 100000) / 10) + 'M';
  if (Math.abs(n) >= 1000) return '$' + (Math.round(n / 100) / 10) + 'k';
  return '$' + Math.round(n);
}

function txvDate(iso) {
  var d = new Date(iso);
  return isFinite(d.getTime()) ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : String(iso);
}

// One trigger in a few words, the same in a list card and the detail:
// { text, frac (check-in bar, or null) }.
function txvRuleWords(rule, ts) {
  ts = ts || {};
  var p = rule.params || {};
  if (rule.type === 'checkin') {
    if (typeof ts.daysSince === 'number' && typeof ts.windowDays === 'number' && ts.windowDays > 0) {
      return { text: ts.daysSince + ' of ' + ts.windowDays + ' days', frac: ts.daysSince / ts.windowDays };
    }
    return { text: ts.reason || 'Not started', frac: null };
  }
  if (rule.type === 'price') {
    var lp = (typeof ts.lastPrice === 'number' && isFinite(ts.lastPrice)) ? ts.lastPrice : null;
    return { text: (p.op === '>=' ? '≥ ' : '≤ ') + txvUsdShort(p.value) + ' · ' + (lp !== null ? 'now ' + txvUsdShort(lp) : 'price unknown'), frac: null };
  }
  if (rule.type === 'utxo') {
    var parts = String(p.outpoint || '').split(':');
    var spent = ts.status === 'due' || ts.status === 'release-due';
    return { text: txvShortOut(parts[0], 4, 4) + (parts.length > 1 ? ':' + parts[1] : '') + ' · ' + (spent ? 'spent' : 'unspent'), frac: null };
  }
  if (rule.type === 'blockheight') {
    var tip = (typeof ts.lastTipHeight === 'number' && isFinite(ts.lastTipHeight)) ? ts.lastTipHeight.toLocaleString('en-US') : '?';
    return { text: tip + ' / ' + Number(p.targetHeight).toLocaleString('en-US'), frac: null };
  }
  if (rule.type === 'setdate') {
    var d = new Date(p.fireAt);
    if (!isFinite(d.getTime())) return { text: String(p.fireAt), frac: null };
    return { text: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + txvLeftText(d.getTime() - Date.now()), frac: null };
  }
  if (rule.type === 'feemarket') {
    var ef = (typeof ts.lastEconomyFee === 'number' && isFinite(ts.lastEconomyFee)) ? ts.lastEconomyFee : null;
    return { text: (p.direction === 'above' ? '≥ ' : '≤ ') + p.maxFeeRate + ' sat/vB · ' + (ef !== null ? 'now ' + ef : 'unknown'), frac: null };
  }
  return { text: 'By hand only', frac: null };
}

// The trigger lines: type (with AND / OR before every rule after the
// first), the words, an inline bar for check-in, and the Met pill.
function txvRuleLines(holder) {
  var box = txvEl('div', 'txv-rules');
  var set = triggerSetOf(holder);
  var states = triggerStatesOf(holder);
  set.rules.forEach(function (rule, i) {
    var ty = TXV_TYPE[rule.type] || TXV_TYPE.manual;
    var line = txvEl('div', 'txv-rl');
    var tyEl = txvEl('span', 'txv-ty ' + ty[1]);
    if (i > 0) tyEl.appendChild(txvEl('i', 'txv-op', set.op === 'AND' ? 'AND' : 'OR'));
    tyEl.appendChild(txvEl('span', '', ty[0]));
    line.appendChild(tyEl);
    var words = txvRuleWords(rule, states[i]);
    var cr = txvEl('span', 'txv-cr');
    if (words.frac !== null) {
      var bar = txvEl('span', 'txv-mini');
      var fill = txvEl('i');
      fill.style.width = Math.round(Math.max(0, Math.min(1, words.frac)) * 100) + '%';
      bar.appendChild(fill);
      cr.appendChild(bar);
    }
    var crt = txvEl('span', 'txv-crt', words.text);
    crt.title = triggerCondition(rule) + ' · ' + triggerStateLine(rule, states[i] || {});
    cr.appendChild(crt);
    line.appendChild(cr);
    var pill = ruleStatePill(rule, states[i] || {});
    line.appendChild(pill ? txvEl('span', 'pill txv-st ' + pill.cls, pill.text) : txvEl('span', ''));
    box.appendChild(line);
  });
  return box;
}

// What to show next to Tx: the transaction's own id, or the number of
// outputs when it pays several.
function txvTxRef(t, head, tail) {
  var outs = (t.detail && Array.isArray(t.detail.outputs)) ? t.detail.outputs : [];
  if (outs.length > 1) return '→ ' + outs.length + ' outputs';
  return txvShortOut(t.txid, head, tail);
}

// A transaction's own state, when it is more than ready / armed.
function txvTxState(t, overlaps) {
  var st = txStatus(t);
  if (st.pending) return { text: st.label === 'Broadcast' ? 'Waiting to confirm' : st.label, cls: 'warn' };
  if (st.settled) return { text: st.label === 'Broadcasted' ? 'Confirmed' : st.label, cls: st.cls };
  if (st.label !== 'Ready' && st.label !== 'unarmed' && st.label !== 'Grace') return { text: st.label, cls: st.cls };
  if (overlaps[t.id] && overlaps[t.id].length) return { text: 'Shared input', cls: 'warn' };
  return null;
}

// The fee rate, coloured by its fee risk ("● 14 sat/vB"); the risk in
// words on hover.
function txvFeeDot(t) {
  var v = txFeeVerdict(t);
  if (!v || typeof t.feeRateSatVb !== 'number' || !isFinite(t.feeRateSatVb)) return null;
  var el = txvEl('span', 'txv-fr ' + feeVerdictCls(v), fmtRate(t.feeRateSatVb) + ' sat/vB');
  el.title = 'Fee risk: ' + v.replace(' Risk', '');
  return el;
}

function txvSwitch(it) {
  var tog = txvEl('label', 'switch small green txv-arm');
  tog.title = it.holder.enabled ? 'Armed: will broadcast when it fires' : 'Disarmed: will not broadcast';
  var cb = txvEl('input');
  cb.type = 'checkbox';
  cb.checked = it.holder.enabled !== false;
  cb.addEventListener('change', function () {
    if (it.kind === 'set') toggleSet(it.holder.id, cb.checked); else toggleTx(it.holder.id, cb.checked);
  });
  tog.appendChild(cb);
  tog.appendChild(txvEl('span', 'slider'));
  // Switching never opens the transaction.
  tog.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
  return tog;
}

function txvRow(it, overlaps) {
  var row = txvEl('div', 'txv-row');
  row.dataset.key = it.key;
  row.dataset.armed = armedAttr(it.holder, it.st);
  row.tabIndex = 0;
  if (it.key === txvSelected) row.classList.add('sel');
  var r1 = txvEl('div', 'txv-r1');
  r1.appendChild(txvEl('span', 'txv-name', txvName(it)));
  r1.appendChild(txvEl('span', 'txv-chev', '›'));
  if (it.section === 'active') {
    var arm = txvEl('span', 'txv-armwrap');
    if (it.holder.enabled === false) arm.appendChild(txvEl('span', 'pill muted txv-st', 'Disarmed'));
    arm.appendChild(txvSwitch(it));
    r1.appendChild(arm);
  }
  row.appendChild(r1);
  row.appendChild(txvRuleLines(it.holder));
  var txs = txvEl('div', 'txv-txs');
  it.members.forEach(function (t, i) {
    var line = txvEl('div', 'txv-tl');
    line.appendChild(txvEl('span', 'txv-tn', it.members.length > 1 ? 'Tx ' + (i + 1) : 'Tx'));
    var to = txvEl('span', 'txv-to', txvTxRef(t, 6, 4));
    to.title = t.txid || '';
    line.appendChild(to);
    var right = txvEl('span', 'txv-tr');
    var st = txvTxState(t, overlaps);
    if (st) right.appendChild(txvEl('span', 'pill ' + st.cls, st.text));
    var fd = txvFeeDot(t);
    if (fd) right.appendChild(fd);
    line.appendChild(right);
    line.appendChild(txvEl('span', 'txv-amt', fmtBtc(t.totalOutSats)));
    txs.appendChild(line);
  });
  row.appendChild(txs);
  row.addEventListener('click', function () { txvSelect(it.key, true); });
  row.addEventListener('keydown', function (e) {
    if (e && (e.key === 'Enter' || e.key === ' ')) { if (e.preventDefault) e.preventDefault(); txvSelect(it.key, true); }
  });
  return row;
}

// --- The detail ---

// Press a button of the full card (so its confirms and checks apply).
function txvKids(el) { return el && el.children ? Array.prototype.slice.call(el.children) : []; }
function txvCardButton(it, label) {
  var row = it.refs && it.refs.row;
  var acts = txvKids(row).filter(function (c) { return c.className === 'tx-actions'; })[0];
  return txvKids(acts).filter(function (b) { return b.textContent === label; })[0] || null;
}
function txvPress(it, label) {
  var btn = txvCardButton(it, label);
  if (btn && !btn.disabled) btn.click();
}

function txvSec(title, right) {
  var sec = txvEl('div', 'txv-sec');
  var h = txvEl('div', 'txv-sh');
  h.appendChild(txvEl('span', 'txv-k', title));
  if (right) h.appendChild(right);
  sec.appendChild(h);
  return sec;
}

function txvKv(box, k, v, onClick) {
  box.appendChild(txvEl('span', 'txv-dk', k));
  var vv = txvEl('span', 'txv-dv', v);
  if (onClick) { vv.classList.add('txv-link'); vv.addEventListener('click', onClick); }
  box.appendChild(vv);
}

// One transaction in the detail: its txid and amount; its Details
// (inputs, outputs, fee and risk, txid, route, locktime, when added); any
// problem or warning at the bottom.
function txvTxBlock(it, t, i, overlaps) {
  var b = txvEl('div', 'txv-txb');
  var l1 = txvEl('div', 'txv-txb1');
  l1.appendChild(txvEl('b', '', it.members.length > 1 ? 'Tx ' + (i + 1) : 'Tx'));
  var tid = txvEl('span', 'mono txv-link', t.txid.slice(0, 16) + '…');
  tid.title = 'Show the full TXID';
  tid.addEventListener('click', function () { showTxidPopout(t); });
  l1.appendChild(tid);
  l1.appendChild(txvEl('span', 'mono txv-v', fmtBtc(t.totalOutSats) + ' BTC'));
  b.appendChild(l1);
  var open = !!txvOpenTx[t.id];
  var tog = txvEl('button', 'txv-more', (open ? '⌄ ' : '› ') + 'Details');
  tog.type = 'button';
  tog.addEventListener('click', function () { txvOpenTx[t.id] = !txvOpenTx[t.id]; renderTxIndex(); });
  b.appendChild(tog);
  if (open) {
    var d = txvEl('div', 'txv-dl');
    var io = t.detail;
    if (io && Array.isArray(io.inputs)) {
      io.inputs.forEach(function (inp, k) {
        txvKv(d, io.inputs.length > 1 ? 'Input ' + (k + 1) : 'Input', shortInput(inp.prevTxid + ':' + inp.prevVout) + '…'
          + ((inp.valueSats !== null && inp.valueSats !== undefined) ? ' · ' + fmtBtc(inp.valueSats) + ' BTC' : ''),
        function () { showInputPopout(t, inp, k); });
      });
      io.outputs.forEach(function (out, k) {
        txvKv(d, io.outputs.length > 1 ? 'Output ' + (k + 1) : 'Output', fmtBtc(out.valueSats) + ' BTC' + (out.address ? ' → ' + txvShortOut(out.address, 12, 6) : ' · ' + out.type),
          function () { showOutputPopout(t, out, k); });
      });
    }
    if (t.feeSats !== null && t.feeSats !== undefined) {
      var fv = txFeeVerdict(t);
      d.appendChild(txvEl('span', 'txv-dk', 'Fee'));
      var fee = txvEl('span', 'txv-dv', fmtSats(t.feeSats) + ' sats · ' + fmtRate(t.feeRateSatVb) + ' sat/vB');
      if (fv) {
        var pill = txvEl('span', 'pill txv-link ' + feeVerdictCls(fv), fv);
        pill.title = 'How this risk was worked out';
        pill.addEventListener('click', function () { showFeePopout(t, txFeeVerdict(t) || fv); });
        fee.appendChild(pill);
      }
      d.appendChild(fee);
    }
    txvKv(d, 'TXID', txvShortOut(t.txid, 16, 8), function () { showTxidPopout(t); });
    txvKv(d, 'Broadcast via', t.broadcastVia === 'slipstream' ? 'Slipstream (MARA)' : 'Public mempool');
    if (t.broadcastVia === 'slipstream' && t.publicFallbackDays !== null && t.publicFallbackDays !== undefined) txvKv(d, 'Public fallback', txFallbackText(t, txStatus(t)));
    if (t.locktime > 0) txvKv(d, 'Locktime', String(t.locktime));
    txvKv(d, 'Added', fmtDate(t.createdAt));
    if (t.notes) txvKv(d, 'Notes', t.notes);
    b.appendChild(d);
  }
  // Problems and warnings last.
  var st = txvTxState(t, overlaps);
  if (st && st.text !== 'Shared input') {
    var sl = txvEl('div', 'txv-txs-state');
    sl.appendChild(txvEl('span', 'pill ' + st.cls, st.text));
    b.appendChild(sl);
  }
  if (t.release || t.broadcasted) b.appendChild(txvEl('div', broadcastLineCls(t) + ' txv-txl', txReleaseLine(t)));
  var dr = dryRunResults[t.id];
  if (dr && dr.verdict === 'timelocked') b.appendChild(txvEl('div', 'txv-txw', dr.text));
  (overlaps[t.id] || []).forEach(function (w) {
    var n = String(w.others).split(', ').length;
    var line = txvEl('div', 'txv-txw', 'Shares an input with ' + (n > 2 ? n + ' other transactions' : w.others) + ': only one of them can confirm.');
    line.title = 'Input ' + shortInput(w.input) + ' is also spent by ' + w.others;
    b.appendChild(line);
  });
  return b;
}

function renderTxPanel(it, overlaps) {
  var panel = $('txv-panel');
  if (!panel) return;
  panel.innerHTML = '';
  if (!it) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  var h = txvEl('div', 'txv-dhead');
  var t1 = txvEl('div', 'txv-dt');
  t1.appendChild(txvEl('h2', '', txvName(it)));
  var arm = txvEl('span', 'txv-armwrap');
  var pillText = it.kind === 'set' ? setPillText(it.holder, it.st) : txPillText(it.holder, it.st);
  var pillCls = it.st.cls;
  if (pillCls === 'ok' && it.members.some(function (t) { return overlaps[t.id] && overlaps[t.id].length; })) pillCls = 'warn';
  arm.appendChild(txvEl('span', 'pill ' + pillCls, pillText));
  if (it.section === 'active') arm.appendChild(txvSwitch(it));
  t1.appendChild(arm);
  h.appendChild(t1);
  var acts = txvEl('div', 'txv-acts');
  [['Dry run', 'Dry-run', ''], ['Edit', 'Edit', ''], ['Broadcast', 'Broadcast Now', 'danger'],
    ['Broadcast publicly', 'Broadcast publicly', 'danger'], ['Delete', 'Delete', 'danger']].forEach(function (a) {
    var src = txvCardButton(it, a[1]);
    if (!src && a[1] === 'Broadcast publicly') return;
    var b = txvEl('button', a[2], a[0]);
    b.type = 'button';
    b.disabled = !src || src.disabled;
    if (src && src.title) b.title = src.title;
    b.addEventListener('click', function () { txvPress(it, a[1]); });
    acts.appendChild(b);
  });
  h.appendChild(acts);
  panel.appendChild(h);
  // Two boxes: what it sends, and what it is made of.
  var boxes = txvEl('div', 'txv-boxes');
  var sum = txvSum(it);
  var b1 = txvEl('div', 'txv-box');
  b1.appendChild(txvEl('span', 'txv-k', it.section === 'active' ? 'Sends' : 'Sent'));
  b1.appendChild(txvEl('div', 'txv-bv', fmtBtc(sum) + ' BTC'));
  b1.appendChild(txvEl('div', 'txv-bs', fmtSats(sum) + ' sats'));
  boxes.appendChild(b1);
  var rs = triggerSetOf(it.holder);
  var b2 = txvEl('div', 'txv-box');
  b2.appendChild(txvEl('span', 'txv-k', 'Made of'));
  b2.appendChild(txvEl('div', 'txv-bv', it.members.length + (it.members.length === 1 ? ' transaction' : ' transactions')));
  b2.appendChild(txvEl('div', 'txv-bs', rs.rules.length === 1 ? '1 trigger'
    : rs.rules.length + ' triggers, ' + (rs.op === 'AND' ? 'all must hold (AND)' : 'any one fires it (OR)')));
  boxes.appendChild(b2);
  panel.appendChild(boxes);
  var fires = txvSec('Fires when');
  fires.appendChild(txvRuleLines(it.holder));
  panel.appendChild(fires);
  var txsec = txvSec('Transactions');
  it.members.forEach(function (t, i) { txsec.appendChild(txvTxBlock(it, t, i, overlaps)); });
  panel.appendChild(txsec);
  // The last dry run of each transaction, from the log.
  var blog = (typeof logsData !== 'undefined' && logsData.blog) ? logsData.blog : [];
  var lastRuns = it.members.map(function (t) {
    return blog.filter(function (e) { return e.kind === 'dry-run' && e.txid === t.txid; })
      .sort(function (a, b) { return (b.ts || '') < (a.ts || '') ? -1 : 1; })[0] || null;
  });
  if (lastRuns.some(Boolean)) {
    var newest = lastRuns.filter(Boolean).map(function (e) { return e.ts; }).sort().pop();
    var dsec = txvSec('Last dry run · ' + txvDate(newest));
    var dl = txvEl('div', 'txv-checks');
    lastRuns.forEach(function (e, i) {
      if (!e) return;
      var item = logsBlogItem(e);
      var c = txvEl('span', 'txv-ck ' + item.result.cls);
      c.appendChild(txvEl('i', '', item.result.cls === 'ok' ? '✓' : '!'));
      c.appendChild(txvEl('span', '', (it.members.length > 1 ? 'Tx ' + (i + 1) + ': ' : '') + item.what));
      dl.appendChild(c);
    });
    dsec.appendChild(dl);
    panel.appendChild(dsec);
  }
  var hist = it.kind === 'set' ? it.holder.history : it.holder.history;
  if (Array.isArray(hist) && hist.length) {
    var hsec = txvEl('div', 'txv-sec');
    var htog = txvEl('button', 'txv-more', (txvHistOpen[it.key] ? '⌄ ' : '› ') + 'History');
    htog.type = 'button';
    var hlist = buildHistoryList(hist.slice().reverse());
    hlist.style.display = txvHistOpen[it.key] ? '' : 'none';
    htog.addEventListener('click', function () {
      txvHistOpen[it.key] = !txvHistOpen[it.key];
      htog.textContent = (txvHistOpen[it.key] ? '⌄ ' : '› ') + 'History';
      hlist.style.display = txvHistOpen[it.key] ? '' : 'none';
    });
    hsec.appendChild(htog);
    hsec.appendChild(hlist);
    panel.appendChild(hsec);
  }
}

function renderTxIndex() {
  var rowsEl = $('txv-rows');
  if (!rowsEl || !S || !S.bitcoin) return;
  var items = txvItems();
  var overlaps = computeOverlaps();
  var q = txvQuery.trim().toLowerCase();
  var shown = items.filter(function (it) { return txvMatches(it, q); });
  // A selection that moved section (sent, confirmed) is followed there.
  var sel = items.filter(function (it) { return it.key === txvSelected; })[0];
  if (sel && sel.section !== txvSection && txvMatches(sel, q)) txvSection = sel.section;
  var counts = { active: 0, pending: 0, archived: 0 };
  shown.forEach(function (it) { counts[it.section] += 1; });
  ['active', 'pending', 'archived'].forEach(function (sec) {
    var b = $('txv-seg-' + sec);
    if (!b) return;
    b.classList.toggle('on', sec === txvSection);
    b.setAttribute('aria-selected', sec === txvSection ? 'true' : 'false');
    var n = $('txv-n-' + sec);
    if (n) {
      n.textContent = String(counts[sec]);
      n.className = 'n' + (sec === 'pending' && counts[sec] ? ' dot' : '');
    }
  });
  var inSec = shown.filter(function (it) { return it.section === txvSection; });
  if (!inSec.some(function (it) { return it.key === txvSelected; })) {
    txvSelected = inSec.length ? inSec[0].key : null;
  }
  rowsEl.innerHTML = '';
  inSec.forEach(function (it) { rowsEl.appendChild(txvRow(it, overlaps)); });
  if (!inSec.length) {
    rowsEl.appendChild(txvEl('p', 'muted txv-none', q ? 'Nothing matches “' + txvQuery.trim() + '”.'
      : txvSection === 'active' ? 'No transactions yet. Add a pre-signed transaction to get started.'
      : txvSection === 'pending' ? 'Nothing waiting to confirm.' : 'Nothing archived yet.'));
  }
  var selIt = null;
  items.forEach(function (it) {
    var on = it.key === txvSelected;
    if (it.refs && it.refs.row) it.refs.row.classList.toggle('txv-sel', on);
    if (on) selIt = it;
  });
  renderTxPanel(selIt, overlaps);
  var empty = $('txv-empty');
  if (empty) empty.style.display = selIt ? 'none' : '';
  var view = $('txv');
  if (view) view.classList.toggle('detail-open', txvDetailOpen && !!selIt);
}

function txvSelect(key, open) {
  txvSelected = key;
  if (open) txvDetailOpen = true;
  renderTxIndex();
  if (open && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}

['active', 'pending', 'archived'].forEach(function (sec) {
  $('txv-seg-' + sec).addEventListener('click', function () {
    txvSection = sec;
    txvSelected = null;
    renderTxIndex();
  });
});
$('txv-search').addEventListener('input', function () {
  txvQuery = $('txv-search').value || '';
  renderTxIndex();
});
$('txv-back').addEventListener('click', function () {
  txvDetailOpen = false;
  renderTxIndex();
});
// The Transactions tab button always opens the list (on a phone, from a
// transaction's own screen too).
document.querySelectorAll('#tabs button').forEach(function (b) {
  if (b.dataset.tab !== 'bitcoin') return;
  b.addEventListener('click', function () {
    if (!txvDetailOpen) return;
    txvDetailOpen = false;
    renderTxIndex();
  });
});
