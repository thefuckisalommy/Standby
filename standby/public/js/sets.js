'use strict';
// Trigger sets, the trigger panels in the popups, saving, deleting and
// importing transactions.

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
