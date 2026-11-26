'use strict';
// First-open setup, one page per step, and Start fresh.

// First-open setup: one page per step (Welcome, App password, Bitcoin
// nodes, Price sources, How triggers work, First transaction, Done),
// while state.setup.done is false.
// "Choose own" moves the Settings card for nodes or prices into the step
// (and back when leaving it), so its fields and buttons work as there.
var DEFAULT_PRIMARY = 'https://mempool.space';
var DEFAULT_SECONDARY = 'https://blockstream.info/api';
var setup = { open: false, steps: [], i: 0, nodesOwn: false, pricesOwn: false, nodesTested: false, pricesTested: false, homes: {}, afterSkip: null };

function setupSteps() {
  var steps = ['welcome', 'password', 'nodes', 'prices', 'checkin', 'tx'];
  if (desktopInfo && desktopInfo.available) steps.push('startup');
  return steps.concat(['done']);
}
function nodesAreDefault() {
  var st = (S && S.settings) || {};
  return st.primaryApiUrl === DEFAULT_PRIMARY && st.secondaryApiUrl === DEFAULT_SECONDARY && st.secondaryEnabled !== false
    && !(st.primaryRpc && st.primaryRpc.enabled) && !(st.secondaryRpc && st.secondaryRpc.enabled);
}
function pricesAreDefault() {
  var ps = ((S && S.settings) || {}).priceSources || {};
  return ps.source1 === 'coingecko' && ps.source2 === 'coinbase';
}
function hostLabel(base) {
  return String(base || '').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
}
var PRICE_LABELS = { coingecko: 'CoinGecko', coinbase: 'Coinbase', binance: 'Binance US', kraken: 'Kraken', bitstamp: 'Bitstamp' };
function priceLabel(src) {
  if (src && typeof src === 'object') return 'Custom (' + hostLabel(src.url) + ')';
  return PRICE_LABELS[src] || String(src || '—');
}

function syncSetup() {
  if (!S || !authKnown || stateErrorShown) return;
  var want = !!(S.setup && S.setup.done === false);
  if (want && !setup.open) openSetup();
  else if (!want && setup.open) closeSetup();
}
function openSetup() {
  setup.open = true;
  setup.steps = setupSteps();
  setup.i = 0;
  setup.nodesOwn = !nodesAreDefault();
  setup.pricesOwn = !pricesAreDefault();
  setup.nodesTested = false;
  setup.pricesTested = false;
  document.body.classList.add('setup-open');
  $('setup-card').style.display = '';
  showSetupStep();
}
function closeSetup() {
  putBack('card-nodes');
  putBack('card-price-sources');
  setup.open = false;
  document.body.classList.remove('setup-open');
  $('setup-card').style.display = 'none';
}
function moveInto(cardId, slotId) {
  var c = $(cardId);
  if (!setup.homes[cardId]) setup.homes[cardId] = { parent: c.parentNode, next: c.nextSibling };
  $(slotId).appendChild(c);
}
function putBack(cardId) {
  var h = setup.homes[cardId];
  if (!h) return;
  h.parent.insertBefore($(cardId), h.next);
  delete setup.homes[cardId];
}

function showSetupStep() {
  var name = setup.steps[setup.i];
  ['welcome', 'password', 'nodes', 'prices', 'checkin', 'tx', 'startup', 'done'].forEach(function (n) {
    $('setup-' + n).classList.toggle('on', n === name);
  });
  var counted = setup.steps.length - 1; // the welcome page is not a step
  $('setup-head').style.display = name === 'welcome' ? 'none' : '';
  $('setup-stepno').textContent = 'Step ' + setup.i + ' of ' + counted;
  var dots = '';
  for (var k = 1; k <= counted; k++) dots += '<i class="' + (k < setup.i ? 'done' : k === setup.i ? 'on' : '') + '"></i>';
  $('setup-dots').innerHTML = dots;
  $('btn-setup-back').style.display = (name === 'welcome' || name === 'done') ? 'none' : '';
  if (name !== 'nodes') putBack('card-nodes');
  if (name !== 'prices') putBack('card-price-sources');
  if (name === 'password') renderSetupPassword();
  if (name === 'nodes') renderSetupNodes();
  if (name === 'prices') renderSetupPrices();
  if (name === 'tx') renderSetupTx();
  if (name === 'startup') renderSetupStartup();
  if (window.scrollTo) window.scrollTo(0, 0);
}
function setupGo(delta) {
  setup.i = Math.max(0, Math.min(setup.steps.length - 1, setup.i + delta));
  showSetupStep();
}
function setupGoTo(name) {
  var at = setup.steps.indexOf(name);
  if (at !== -1) { setup.i = at; showSetupStep(); }
}

async function finishSetup(msgEl) {
  try {
    await api('POST', '/api/setup', { done: true });
    if (S) S.setup = { done: true };
    closeSetup();
    showTab('dashboard', true);
    await load();
  } catch (e) { setMsg(msgEl, e.message, false); }
}

$('btn-setup-start').addEventListener('click', function () { setupGo(1); });
$('btn-setup-back').addEventListener('click', function () { setupGo(-1); });
$('btn-setup-restore').addEventListener('click', function () { $('backup-file').click(); });
$('btn-setup-skip-all').addEventListener('click', function () {
  if (authInfo.source === 'none') {
    openSkipWarning(function () { finishSetup($('setup-welcome-msg')); }, function () { setupGoTo('password'); });
  } else {
    finishSetup($('setup-welcome-msg'));
  }
});

// Step: app password (skipping asks first).
// Set outside the app (Umbrel's app password, or STANDBY_PASSWORD): the
// page says so — it is the password just used to log in — and never
// shows it.
function envPasswordText() {
  return 'Standby is protected by a password: the one you just logged in with. ' + envPasswordWhere();
}
function renderSetupPassword() {
  var src = authInfo.source;
  $('setup-password-form').style.display = src === 'none' ? '' : 'none';
  $('setup-password-done').style.display = src === 'app' ? '' : 'none';
  $('setup-password-env').style.display = src === 'env' ? '' : 'none';
  $('setup-password-env-text').textContent = envPasswordText();
}
var skipBack = null;
function openSkipWarning(onSkip, onBack) {
  setup.afterSkip = onSkip;
  skipBack = onBack || null;
  $('setup-skip-modal').classList.add('open');
}
$('btn-setup-skip-confirm').addEventListener('click', function () {
  $('setup-skip-modal').classList.remove('open');
  var cb = setup.afterSkip;
  setup.afterSkip = null;
  if (cb) cb();
});
$('btn-setup-skip-back').addEventListener('click', function () {
  $('setup-skip-modal').classList.remove('open');
  setup.afterSkip = null;
  if (skipBack) skipBack();
  var pw = $('setup-pw1');
  if (pw && pw.focus) pw.focus();
});
$('btn-setup-pw-set').addEventListener('click', async function () {
  try {
    await setAppPassword({ password: newPasswordFrom('setup-pw1', 'setup-pw2') });
    clearFields(['setup-pw1', 'setup-pw2']);
    setMsg($('setup-password-msg'), '', true);
    setupGo(1);
  } catch (e) { setMsg($('setup-password-msg'), e.message, false); }
});
$('btn-setup-pw-skip').addEventListener('click', function () {
  setMsg($('setup-password-msg'), '', true);
  openSkipWarning(function () { setupGo(1); });
});
$('btn-setup-pw-next').addEventListener('click', function () { setupGo(1); });
$('btn-setup-pw-env-next').addEventListener('click', function () { setupGo(1); });

// Step: Bitcoin nodes.
function renderSetupNodes() {
  var own = setup.nodesOwn;
  $('setup-nodes-public').checked = !own;
  $('setup-nodes-own').checked = own;
  $('setup-nodes-public-choice').classList.toggle('sel', !own);
  $('setup-nodes-own-choice').classList.toggle('sel', own);
  $('setup-nodes-public-actions').style.display = own ? 'none' : '';
  $('setup-nodes-own-actions').style.display = own ? '' : 'none';
  $('setup-nodes-status').style.display = own ? 'none' : '';
  if (own) moveInto('card-nodes', 'setup-nodes-slot');
  else putBack('card-nodes');
  if (!own && !setup.nodesTested) { setup.nodesTested = true; testSetupNodes(); }
}
async function usePublicNodes() {
  if (nodesAreDefault()) return;
  S.settings = await api('PUT', '/api/settings', {
    primaryApiUrl: DEFAULT_PRIMARY, secondaryApiUrl: DEFAULT_SECONDARY, secondaryEnabled: true,
    primaryRpc: { enabled: false }, secondaryRpc: { enabled: false },
  });
}
function statusLine(pillCls, pillText, text) {
  var row = document.createElement('div');
  row.className = 'setup-status';
  var pill = document.createElement('span');
  pill.className = 'pill ' + pillCls;
  pill.textContent = pillText;
  var t = document.createElement('span');
  t.textContent = text;
  row.appendChild(pill);
  row.appendChild(t);
  return row;
}
async function testSetupNodes() {
  var box = $('setup-nodes-status');
  box.innerHTML = '';
  box.appendChild(statusLine('muted', '…', 'Checking the nodes…'));
  try {
    await usePublicNodes();
    var r = await api('POST', '/api/bitcoin/connection/test', {});
    box.innerHTML = '';
    (r.results || []).forEach(function (x) {
      var st = x.status === 'ok' ? ['ok', 'OK'] : x.status === 'caution' ? ['warn', 'CAUTION'] : ['bad', 'FAIL'];
      box.appendChild(statusLine(st[0], st[1], hostLabel(x.base)));
    });
  } catch (e) {
    box.innerHTML = '';
    setMsg($('setup-nodes-msg'), e.message, false);
  }
}
function setNodesMode(own) {
  setup.nodesOwn = own;
  setMsg($('setup-nodes-msg'), '', true);
  renderSetupNodes();
}
$('setup-nodes-public').addEventListener('change', function () { setNodesMode(false); });
$('setup-nodes-own').addEventListener('change', function () { setNodesMode(true); });
$('btn-setup-nodes-test').addEventListener('click', testSetupNodes);
$('btn-setup-nodes-keep').addEventListener('click', async function () {
  try { await usePublicNodes(); setupGo(1); } catch (e) { setMsg($('setup-nodes-msg'), e.message, false); }
});
$('btn-setup-nodes-save').addEventListener('click', async function () {
  try { await saveBitcoinSettings(); setupGo(1); } catch (e) { setMsg($('setup-nodes-msg'), e.message, false); }
});

// Step: price sources.
function renderSetupPrices() {
  var own = setup.pricesOwn;
  $('setup-prices-defaults').style.display = own ? 'none' : '';
  $('setup-prices-own-actions').style.display = own ? '' : 'none';
  if (own) moveInto('card-price-sources', 'setup-prices-slot');
  else putBack('card-price-sources');
  if (!own && !setup.pricesTested) { setup.pricesTested = true; testSetupPrices(); }
}
async function testSetupPrices() {
  var box = $('setup-prices-status');
  box.innerHTML = '';
  box.appendChild(statusLine('muted', '…', 'Reading the price…'));
  try {
    var r = await api('POST', '/api/settings/price-sources/test-all', { providers: ['coingecko', 'coinbase'] });
    box.innerHTML = '';
    ['coingecko', 'coinbase'].forEach(function (id, i) {
      var x = (r.results || [])[i] || {};
      var ok = typeof x.price === 'number' && Number.isFinite(x.price);
      box.appendChild(statusLine(ok ? 'ok' : 'bad', ok ? 'OK' : 'FAIL', priceLabel(id) + (ok ? ' — $' + x.price.toLocaleString('en-US') : '')));
    });
  } catch (e) { box.innerHTML = ''; }
}
$('btn-setup-prices-keep').addEventListener('click', async function () {
  try {
    if (!pricesAreDefault()) S.settings = await api('PUT', '/api/settings', { priceSources: { source1: 'coingecko', source2: 'coinbase' } });
    setupGo(1);
  } catch (e) { setMsg($('setup-prices-msg'), e.message, false); }
});
$('btn-setup-prices-own').addEventListener('click', function () { setup.pricesOwn = true; renderSetupPrices(); });
$('btn-setup-prices-default').addEventListener('click', function () { setup.pricesOwn = false; setMsg($('setup-prices-msg'), '', true); renderSetupPrices(); });
$('btn-setup-prices-save').addEventListener('click', async function () {
  try { await savePriceSources(); setupGo(1); } catch (e) { setMsg($('setup-prices-msg'), e.message, false); }
});

// Step: how triggers work (information only).
$('btn-setup-checkin-next').addEventListener('click', function () { setupGo(1); });

// Step: start with this computer (downloads only); on by default, and
// switching it off here takes effect at once.
function renderSetupStartup() {
  var on = !!(desktopInfo && desktopInfo.startAtLogin);
  $('setup-startup-lead').textContent = 'Standby only checks your triggers while it is running. So that it keeps running after a restart, it starts by itself when you sign in to this computer, '
    + (hasTray() ? 'quietly in the background with its icon next to the clock.'
      : 'quietly in the background with no window. Open it any time at ' + pageAddress() + ' (worth bookmarking), and stop it from Settings → This computer.');
  $('setup-autostart').checked = on;
  $('setup-autostart-note').textContent = on
    ? 'On. You can turn this off here, or later in Settings → This computer.'
    : 'Off. Standby only runs when you start it yourself; triggers wait while it is closed. Turn it back on here or in Settings → This computer.';
}
$('setup-autostart').addEventListener('change', async function () {
  await setStartAtLogin($('setup-autostart').checked, $('setup-startup-msg'));
  renderSetupStartup();
});
$('btn-setup-startup-next').addEventListener('click', function () { setupGo(1); });

// Step: first transaction (the usual Add form, over the setup page).
function renderSetupTx() {
  var n = ((S && S.bitcoin && S.bitcoin.txs) || []).length;
  $('setup-tx-count').textContent = n ? n + ' transaction' + (n === 1 ? '' : 's') + ' added.' : '';
  $('btn-setup-tx-skip').textContent = n ? 'Continue' : 'Skip for now';
}
$('btn-setup-tx-add').addEventListener('click', function () {
  onAddModalClosed = function () {
    load().catch(function () { /* shown elsewhere */ }).then(function () {
      if (setup.open && setup.steps[setup.i] === 'tx') renderSetupTx();
    });
  };
  openAddModal();
});
$('btn-setup-tx-skip').addEventListener('click', function () { setupGo(1); });

$('btn-setup-finish').addEventListener('click', function () { finishSetup($('setup-done-msg')); });

// Start fresh: delete all data. From Settings (with "Download a backup
// first") or the could-not-load screen.
function openFreshModal(withBackup) {
  $('fresh-backup-row').style.display = withBackup ? '' : 'none';
  $('fresh-password-row').style.display = authInfo.required ? '' : 'none';
  clearFields(['fresh-confirm', 'fresh-password']);
  setMsg($('fresh-msg'), '', true);
  $('btn-fresh-go').disabled = false;
  $('fresh-modal').classList.add('open');
}
function closeFreshModal() { $('fresh-modal').classList.remove('open'); }
$('btn-fresh-delete').addEventListener('click', function () { openFreshModal(true); });
$('btn-fresh-backup').addEventListener('click', function () { $('btn-backup-download').click(); });
$('btn-fresh-modal-backup').addEventListener('click', function () { $('btn-backup-download').click(); });
$('btn-fresh-cancel').addEventListener('click', closeFreshModal);
$('fresh-modal-x').addEventListener('click', closeFreshModal);
$('btn-fresh-go').addEventListener('click', async function () {
  if ($('fresh-confirm').value.trim() !== 'DELETE') { setMsg($('fresh-msg'), 'Type DELETE to confirm.', false); return; }
  var body = { confirm: true };
  if (authInfo.required) body.password = $('fresh-password').value;
  $('btn-fresh-go').disabled = true;
  setMsg($('fresh-msg'), 'Deleting…', true);
  try {
    await api('POST', '/api/state/reset', body);
    location.reload();
  } catch (e) {
    setMsg($('fresh-msg'), e.message, false);
    $('btn-fresh-go').disabled = false;
  }
});
