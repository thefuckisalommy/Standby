'use strict';
// Transactions as a list and a detail: on the left, search, Add, the
// Active / Pending / Archived switch and one compact row per transaction
// or set (name, amount, trigger chips, how close it is to firing, fee
// risk); on the right, the selected one's full card with a summary strip
// (Armed, Sends, Fee, Route). On a phone the list comes first and a row
// opens its own screen, with a link back.
// renderBitcoin still builds every card into the three section lists;
// this file builds the list and shows only the selected card.

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

// A rule as a short chip label.
function txvRuleText(rule) {
  var p = rule.params || {};
  if (rule.type === 'checkin') return 'No check-in · ' + p.thresholdDays + ' days';
  if (rule.type === 'price') return 'BTC ' + (p.op === '>=' ? '≥' : '≤') + ' $' + Number(p.value).toLocaleString('en-US');
  if (rule.type === 'utxo') {
    var parts = String(p.outpoint || '').split(':');
    return txvShortOut(parts[0], 4, 4) + (parts.length > 1 ? ':' + parts[1] : '') + ' spent';
  }
  if (rule.type === 'blockheight') return 'Block ' + Number(p.targetHeight).toLocaleString('en-US');
  if (rule.type === 'setdate') {
    var d = new Date(p.fireAt);
    return isFinite(d.getTime()) ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(p.fireAt);
  }
  if (rule.type === 'feemarket') return 'Fees ' + (p.direction === 'above' ? '≥ ' : '≤ ') + p.maxFeeRate + ' sat/vB';
  return 'Manual only';
}

var TXV_TYPE_CLS = { checkin: 't-checkin', price: 't-price', utxo: 't-utxo', blockheight: 't-block', setdate: 't-date', feemarket: 't-fee', manual: 't-manual' };

// How close one rule is to firing: { frac (0..1, or null for no bar), text }.
function txvRuleProgress(rule, ts, holder) {
  ts = ts || {};
  var p = rule.params || {};
  var now = Date.now();
  var created = new Date(holder.createdAt || '').getTime();
  if (rule.type === 'checkin') {
    if (typeof ts.daysSince === 'number' && typeof ts.windowDays === 'number' && ts.windowDays > 0) {
      var left = ts.windowDays - ts.daysSince;
      return { frac: ts.daysSince / ts.windowDays, text: left > 0 ? left + (left === 1 ? ' day left' : ' days left') : 'Due' };
    }
    return { frac: null, text: ts.reason || 'No check-in yet' };
  }
  if (rule.type === 'price') {
    var lp = (typeof ts.lastPrice === 'number' && isFinite(ts.lastPrice)) ? ts.lastPrice : null;
    var v = Number(p.value);
    if (lp === null || !(v > 0)) return { frac: null, text: 'Price unknown' };
    if (p.op === '>=') return { frac: lp / v, text: lp >= v ? 'Reached' : '$' + Math.round(v - lp).toLocaleString('en-US') + ' to go' };
    return { frac: v / lp, text: lp <= v ? 'Reached' : '$' + Math.round(lp - v).toLocaleString('en-US') + ' away' };
  }
  if (rule.type === 'blockheight') {
    var tip = (typeof ts.lastTipHeight === 'number' && isFinite(ts.lastTipHeight)) ? ts.lastTipHeight : null;
    var target = Number(p.targetHeight);
    if (tip === null) return { frac: null, text: ts.reason || 'Tip unknown' };
    var togo = target - tip;
    if (togo <= 0) return { frac: 1, text: 'Reached' };
    // Time-based: time since added against ~10 minutes a block to go.
    var spent = isFinite(created) ? Math.max(0, now - created) : 0;
    return { frac: spent / (spent + togo * 600000), text: togo.toLocaleString('en-US') + ' blocks to go' };
  }
  if (rule.type === 'setdate') {
    var at = new Date(p.fireAt).getTime();
    if (!isFinite(at)) return { frac: null, text: '' };
    var whole = isFinite(created) ? at - created : 0;
    return { frac: whole > 0 ? (now - created) / whole : null, text: txvLeftText(at - now) };
  }
  if (rule.type === 'utxo') return { frac: null, text: ts.status === 'due' ? 'Spent' : 'Unspent' };
  if (rule.type === 'feemarket') {
    var ef = (typeof ts.lastEconomyFee === 'number' && isFinite(ts.lastEconomyFee)) ? ts.lastEconomyFee : null;
    return { frac: null, text: ef !== null ? 'Economy fee ' + ef + ' sat/vB' : 'Fee unknown' };
  }
  return { frac: null, text: 'Only when you broadcast it' };
}

// The row's one progress line: the rule closest to firing.
function txvProgress(holder) {
  var rules = triggerSetOf(holder).rules;
  var states = triggerStatesOf(holder);
  var best = null;
  rules.forEach(function (r, i) {
    var pr = txvRuleProgress(r, states[i], holder);
    if (!best || (pr.frac !== null && (best.frac === null || pr.frac > best.frac))) best = pr;
  });
  return best || { frac: null, text: '' };
}

// The worst fee verdict among the members still waiting, or null.
function txvFeeVerdict(it) {
  var rank = { 'Low Risk': 0, 'Medium Risk': 1, 'High Risk': 2, 'Critical Risk': 3 };
  var worst = null;
  it.members.forEach(function (t) {
    var v = txFeeVerdict(t);
    if (v && (worst === null || rank[v] > rank[worst])) worst = v;
  });
  return worst;
}

function txvEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// The chip for the row's state, when it is more than plain armed / ready.
function txvStateChip(it) {
  var st = it.st;
  if (it.section === 'pending') return { text: st.label === 'Broadcast' ? 'Waiting to confirm' : st.label, cls: 'warn' };
  if (it.section === 'archived') return { text: st.label === 'Broadcasted' ? 'Confirmed' : st.label, cls: st.cls };
  if (it.holder.enabled === false) return { text: 'Disarmed · will not fire', cls: 'muted' };
  if (st.label !== 'Ready' && st.label !== 'unarmed') return { text: st.label, cls: st.cls };
  return null;
}

function txvRow(it) {
  var row = txvEl('div', 'txv-row');
  row.dataset.key = it.key;
  row.dataset.armed = armedAttr(it.holder, it.st);
  row.tabIndex = 0;
  if (it.key === txvSelected) row.classList.add('sel');
  var r1 = txvEl('div', 'txv-r1');
  r1.appendChild(txvEl('span', 'txv-name', txvName(it)));
  if (it.kind === 'set') r1.appendChild(txvEl('span', 'txv-badge', 'SET · ' + it.members.length + ' TX'));
  r1.appendChild(txvEl('span', 'txv-amt', fmtBtc(txvSum(it)) + ' BTC'));
  row.appendChild(r1);
  var ruleSet = triggerSetOf(it.holder);
  var chips = txvEl('div', 'txv-chips');
  ruleSet.rules.forEach(function (r, i) {
    if (i > 0) chips.appendChild(txvEl('span', 'txv-op', ruleSet.op === 'AND' ? 'ALL' : 'ANY'));
    chips.appendChild(txvEl('span', 'txv-chip ' + (TXV_TYPE_CLS[r.type] || 't-manual'), txvRuleText(r)));
  });
  row.appendChild(chips);
  if (it.section === 'active') {
    var pr = txvProgress(it.holder);
    var prog = txvEl('div', 'txv-prog');
    if (pr.frac !== null) {
      var bar = txvEl('span', 'txv-bar');
      var fill = txvEl('i');
      fill.style.width = Math.round(Math.max(0, Math.min(1, pr.frac)) * 100) + '%';
      bar.appendChild(fill);
      prog.appendChild(bar);
    }
    prog.appendChild(txvEl('span', 'txv-left', pr.text));
    row.appendChild(prog);
  }
  var flags = [];
  var sc = txvStateChip(it);
  if (sc) flags.push(sc);
  var fv = it.section === 'active' && it.holder.enabled !== false ? txvFeeVerdict(it) : null;
  if (fv && fv !== 'Low Risk') flags.push({ text: fv.replace(' Risk', ' fee risk'), cls: feeVerdictCls(fv) });
  if (flags.length) {
    var fl = txvEl('div', 'txv-flags');
    flags.forEach(function (f) { fl.appendChild(txvEl('span', 'pill ' + f.cls, f.text)); });
    row.appendChild(fl);
  }
  if (it.kind === 'set' && it.members.length) {
    var mem = txvEl('div', 'txv-members');
    it.members.forEach(function (t, i) {
      var line = txvEl('div', 'txv-member');
      line.appendChild(txvEl('span', 'txv-member-n', 'Tx ' + (i + 1)));
      var outs = (t.detail && Array.isArray(t.detail.outputs)) ? t.detail.outputs : [];
      var to = outs.length === 1 && outs[0].address ? '→ ' + txvShortOut(outs[0].address, 6, 4)
        : (outs.length > 1 ? '→ ' + outs.length + ' outputs' : txvShortOut(t.txid, 8, 4));
      line.appendChild(txvEl('span', 'txv-member-to', to));
      line.appendChild(txvEl('span', 'txv-member-amt', fmtBtc(t.totalOutSats)));
      mem.appendChild(line);
    });
    row.appendChild(mem);
  }
  row.addEventListener('click', function () { txvSelect(it.key, true); });
  row.addEventListener('keydown', function (e) {
    if (e && (e.key === 'Enter' || e.key === ' ')) { if (e.preventDefault) e.preventDefault(); txvSelect(it.key, true); }
  });
  return row;
}

// The summary strip at the top of the selected card: Armed, Sends, Fee,
// Route (a set: Transactions in place of Route).
function txvStats(it) {
  var strip = txvEl('div', 'tx-stats');
  function cell(k, v, sub, extra) {
    var c = txvEl('div', 'tx-stat');
    c.appendChild(txvEl('div', 'tx-stat-k', k));
    var vv = txvEl('div', 'tx-stat-v', v);
    if (extra) vv.appendChild(extra);
    c.appendChild(vv);
    if (sub) c.appendChild(txvEl('div', 'tx-stat-sub', sub));
    strip.appendChild(c);
  }
  if (it.section === 'active') {
    var on = it.holder.enabled !== false;
    cell('Armed', on ? 'On' : 'Off', on ? 'Fires automatically' : 'Will not fire');
  } else {
    cell('Status', it.section === 'pending' ? 'Waiting to confirm' : (it.st.label === 'Broadcasted' ? 'Confirmed' : it.st.label),
      it.section === 'pending' ? 'Broadcast; Standby keeps checking' : '');
  }
  var sum = txvSum(it);
  cell('Sends', fmtBtc(sum) + ' BTC', fmtSats(sum) + ' sats');
  var rates = it.members.map(function (t) { return t.feeRateSatVb; }).filter(function (r) { return typeof r === 'number' && isFinite(r); });
  var feeSats = it.members.reduce(function (a, t) { return a + (Number(t.feeSats) || 0); }, 0);
  var fv = txvFeeVerdict(it);
  var chip = null;
  if (fv) chip = txvEl('span', 'pill ' + feeVerdictCls(fv), fv.replace(' Risk', ' risk'));
  var lo = rates.length ? fmtRate(Math.min.apply(null, rates)) : '';
  var hi = rates.length ? fmtRate(Math.max.apply(null, rates)) : '';
  var rateText = !rates.length ? 'Unknown' : (lo === hi ? lo : lo + '–' + hi) + ' sat/vB';
  cell('Fee', rateText, rates.length ? fmtSats(feeSats) + ' sats' : '', chip);
  if (it.kind === 'set') {
    cell('Transactions', String(it.members.length), 'Share one trigger');
  } else {
    var t = it.holder;
    var slip = t.broadcastVia === 'slipstream';
    cell('Route', slip ? 'MARA Slipstream' : 'Public',
      slip ? (t.publicFallbackDays != null ? 'Public after ' + t.publicFallbackDays + (t.publicFallbackDays === 1 ? ' day' : ' days') : 'No public fallback') : 'Primary, then secondary node');
  }
  return strip;
}

// Put a fresh summary strip at the end of each card (CSS places it under
// the header).
function txvFillStats(items) {
  items.forEach(function (it) {
    var refs = it.refs;
    if (!refs || !refs.row) return;
    if (refs.stats) refs.row.removeChild(refs.stats);
    refs.stats = txvStats(it);
    refs.row.appendChild(refs.stats);
  });
}

function renderTxIndex() {
  var rowsEl = $('txv-rows');
  if (!rowsEl || !S || !S.bitcoin) return;
  var items = txvItems();
  txvFillStats(items);
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
  var armed = inSec.filter(function (it) { return txvSection !== 'active' || it.holder.enabled !== false; });
  var off = inSec.filter(function (it) { return txvSection === 'active' && it.holder.enabled === false; });
  armed.forEach(function (it) { rowsEl.appendChild(txvRow(it)); });
  if (off.length) {
    rowsEl.appendChild(txvEl('div', 'txv-group', 'Disarmed'));
    off.forEach(function (it) { rowsEl.appendChild(txvRow(it)); });
  }
  if (!inSec.length) {
    rowsEl.appendChild(txvEl('p', 'muted txv-none', q ? 'Nothing matches “' + txvQuery.trim() + '”.'
      : txvSection === 'active' ? 'No transactions yet. Add a pre-signed transaction to get started.'
      : txvSection === 'pending' ? 'Nothing waiting to confirm.' : 'Nothing archived yet.'));
  }
  txvShowSelected(items);
}

// Show only the selected card, in its section, opening that section.
function txvShowSelected(items) {
  var holders = { active: $('btc-card'), pending: $('pending-card'), archived: $('archived-card') };
  var selIt = null;
  items.forEach(function (it) {
    if (!it.refs || !it.refs.row) return;
    var on = it.key === txvSelected;
    it.refs.row.classList.toggle('txv-sel', on);
    if (on) selIt = it;
  });
  Object.keys(holders).forEach(function (sec) {
    var h = holders[sec];
    if (!h) return;
    var has = !!selIt && selIt.section === sec;
    h.classList.toggle('txv-has', has);
    if (has && !h.open) h.open = true;
  });
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
