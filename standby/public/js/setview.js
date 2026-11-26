'use strict';
// Settings in groups: a list on the left (search, each section with its
// current state), one group at a time on the right; on a phone, the list
// first, then a group's own screen with a link back. Sections that save
// share one Save bar: it appears once something changed and saves every
// changed section with that section's own Save (the buttons are hidden).

var SETV_GROUPS = [
  { id: 'safety', title: 'Safety', cards: ['vacation', 'grace', 'arm'] },
  { id: 'connections', title: 'Connections', cards: ['nodes', 'price-sources', 'agreement'] },
  { id: 'checks', title: 'Checks and fees', cards: ['cadence', 'fee'] },
  { id: 'checkin', title: 'Check-in', cards: ['keys'] },
  { id: 'security', title: 'Security and data', cards: ['session', 'backup', 'fresh'] },
  { id: 'app', title: 'App', cards: ['desktop', 'version'] },
];
// Each section's name in the list, and its Save button where it has one.
var SETV_CARDS = {
  vacation: { name: 'Vacation mode', save: 'btn-save-vacation' },
  grace: { name: 'Grace period', save: 'btn-save-grace' },
  arm: { name: 'Arm or disarm all' },
  nodes: { name: 'Bitcoin nodes', save: 'btn-btc-save-nodes' },
  'price-sources': { name: 'Price sources', save: 'btn-save-price-sources' },
  agreement: { name: 'Price agreement', save: 'btn-save-price-agreement' },
  cadence: { name: 'Check cadence', save: 'btn-save-check-cadence' },
  fee: { name: 'Broadcast fee risk', save: 'btn-save-fee-verdict' },
  keys: { name: 'Check-ins from other devices' },
  session: { name: 'App login' },
  backup: { name: 'Backup and restore' },
  fresh: { name: 'Start fresh' },
  desktop: { name: 'This computer' },
  version: { name: 'Version' },
};
var setvGroup = 'safety';
var setvOpen = false; // phone: a group's screen is showing
var setvDirty = {}; // card key -> true while it has unsaved changes
var setvQuery = '';

// The state shown beside each section: { text, dot: 'ok' | 'bad' | ''}.
function setvState(key) {
  var st = S && S.settings ? S.settings : {};
  var txs = (S && S.bitcoin && S.bitcoin.txs) || [];
  var sets = (S && S.bitcoin && S.bitcoin.sets) || [];
  if (key === 'vacation') return { text: st.vacationMode ? 'On' : 'Off' };
  if (key === 'grace') return { text: st.graceEnabled === false ? 'Off' : 'After ' + (st.graceOfflineDays || 7) + (st.graceOfflineDays === 1 ? ' day' : ' days') };
  if (key === 'arm') {
    var memberIds = {};
    sets.forEach(function (s) { (s.txIds || []).forEach(function (id) { memberIds[id] = true; }); });
    var holders = txs.filter(function (t) { return !memberIds[t.id] && !txStatus(t).settled && !txStatus(t).pending; })
      .concat(sets.filter(function (s) { return !setStatus(s).settled && !setStatus(s).pending; }));
    var on = holders.filter(function (h) { return h.enabled !== false; }).length;
    return { text: on + ' of ' + holders.length + ' armed' };
  }
  if (key === 'nodes') {
    var cls = function (id) { var p = $(id); return p ? String(p.className || '') : ''; };
    var p1 = cls('btc-primary-status');
    var p2 = cls('btc-secondary-status');
    var two = st.secondaryEnabled !== false;
    var ok = (/\bok\b/.test(p1) ? 1 : 0) + (two && /\bok\b/.test(p2) ? 1 : 0);
    var bad = /\bbad\b/.test(p1) || (two && /\bbad\b/.test(p2));
    if (!/\b(ok|bad)\b/.test(p1 + ' ' + p2)) return { text: 'Not tested' };
    return { text: ok + ' of ' + (two ? 2 : 1) + ' OK', dot: bad ? 'bad' : 'ok' };
  }
  if (key === 'price-sources') {
    var s1 = $('price-source1-status');
    var s2 = $('price-source2-status');
    var c = String((s1 && s1.className) || '') + ' ' + String((s2 && s2.className) || '');
    if (!/\b(ok|bad)\b/.test(c)) return { text: 'Not tested' };
    var n = (c.match(/\bok\b/g) || []).length;
    return { text: n + ' of 2 OK', dot: /\bbad\b/.test(c) ? 'bad' : 'ok' };
  }
  if (key === 'agreement') return { text: (typeof st.priceAgreementPct === 'number' ? st.priceAgreementPct : 5) + '%' };
  if (key === 'cadence') return { text: (st.checkCadenceSeconds || 60) + ' s' };
  if (key === 'fee') return { text: (st.feeLowMultiplier || 2) + '× · ' + (st.feeMediumMultiplier || 1) + '×' };
  if (key === 'keys') return { text: (typeof apiKeys !== 'undefined' && apiKeys ? apiKeys.length : 0) + ((apiKeys && apiKeys.length === 1) ? ' key' : ' keys') };
  if (key === 'session') return { text: authInfo && authInfo.required ? 'Password set' : 'No password' };
  if (key === 'version') {
    if (typeof updateInfo !== 'undefined' && updateInfo && updateInfo.enabled && updateInfo.newer) return { text: 'Update', dot: 'accent' };
    var av = $('app-version');
    return { text: av && av.textContent !== '—' ? av.textContent : '' };
  }
  return { text: '' };
}

function setvCardShown(key) {
  var c = $('card-' + key);
  return !!c && c.style.display !== 'none';
}

function setvMatches(key, q) {
  if (!q) return true;
  var c = $('card-' + key);
  var text = (SETV_CARDS[key].name + ' ' + ((c && c.textContent) || '')).toLowerCase();
  return text.indexOf(q) !== -1;
}

function setvEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderSetNav() {
  var box = $('setnav-groups');
  if (!box) return;
  box.innerHTML = '';
  var q = setvQuery.trim().toLowerCase();
  var any = false;
  SETV_GROUPS.forEach(function (g) {
    var keys = g.cards.filter(function (k) { return setvCardShown(k) && setvMatches(k, q); });
    if (!keys.length) return;
    any = true;
    var grp = setvEl('div', 'setnav-group');
    grp.appendChild(setvEl('div', 'setnav-k', g.title));
    var list = setvEl('div', 'setnav-list');
    keys.forEach(function (k) {
      var item = setvEl('button', 'setnav-item' + (g.id === setvGroup ? ' on' : ''));
      item.type = 'button';
      var st = setvState(k);
      if (st.dot) item.appendChild(setvEl('span', 'dot ' + st.dot));
      item.appendChild(setvEl('span', 'setnav-name', SETV_CARDS[k].name));
      if (setvDirty[k]) item.appendChild(setvEl('span', 'setnav-dirty', '●'));
      item.appendChild(setvEl('span', 'setnav-v', st.text));
      item.appendChild(setvEl('span', 'setnav-chev', '›'));
      item.addEventListener('click', function () { setvShow(g.id, k); });
      list.appendChild(item);
    });
    grp.appendChild(list);
    box.appendChild(grp);
  });
  if (!any) box.appendChild(setvEl('p', 'muted setnav-none', 'No setting matches “' + setvQuery.trim() + '”.'));
}

function setvApply() {
  SETV_GROUPS.forEach(function (g) {
    var el = $('sg-' + g.id);
    if (el) el.classList.toggle('on', g.id === setvGroup);
  });
  var v = $('setv');
  if (v) v.classList.toggle('open', setvOpen);
  renderSetNav();
  renderSaveBar();
}

// Show a group (and on a phone, its screen); scroll to one section.
function setvShow(groupId, cardKey) {
  setvGroup = groupId;
  setvOpen = true;
  setvApply();
  var card = cardKey ? $('card-' + cardKey) : null;
  if (card && typeof card.scrollIntoView === 'function' && cardKey !== SETV_GROUPS.filter(function (g) { return g.id === groupId; })[0].cards[0]) {
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else if (typeof window.scrollTo === 'function') {
    window.scrollTo(0, 0);
  }
}

function renderSaveBar() {
  var bar = $('savebar');
  if (!bar) return;
  var keys = Object.keys(setvDirty).filter(function (k) { return setvDirty[k]; });
  bar.style.display = keys.length ? '' : 'none';
  $('savebar-what').textContent = keys.map(function (k) { return SETV_CARDS[k].name; }).join(', ');
}

// After settings are drawn from saved state, nothing is unsaved.
function setvRefresh() {
  setvDirty = {};
  setvApply();
}

// Typing or changing anything in a section that saves marks it unsaved.
Object.keys(SETV_CARDS).forEach(function (key) {
  if (!SETV_CARDS[key].save) return;
  var card = $('card-' + key);
  if (!card) return;
  function mark(e) {
    var t = e && e.target;
    if (t && t.tagName === 'BUTTON') return;
    setvDirty[key] = true;
    renderSaveBar();
    renderSetNav();
  }
  card.addEventListener('input', mark);
  card.addEventListener('change', mark);
});

$('savebar-save').addEventListener('click', function () {
  Object.keys(setvDirty).forEach(function (k) {
    if (setvDirty[k] && SETV_CARDS[k].save) $(SETV_CARDS[k].save).click();
  });
  setvDirty = {};
  renderSaveBar();
  renderSetNav();
});
$('savebar-discard').addEventListener('click', function () {
  renderBitcoin();
  renderSettings();
});
$('set-back').addEventListener('click', function () {
  setvOpen = false;
  setvApply();
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
});
$('set-search').addEventListener('input', function () {
  setvQuery = $('set-search').value || '';
  renderSetNav();
});
// The Settings tab button opens the list (on a phone, from a group's
// screen too).
document.querySelectorAll('#tabs button').forEach(function (b) {
  if (b.dataset.tab !== 'settings') return;
  b.addEventListener('click', function () {
    if (!setvOpen) return;
    setvOpen = false;
    setvApply();
  });
});
setvApply();
