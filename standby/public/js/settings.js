'use strict';
// The Settings tab: options and their help, check-in API keys, backups,
// the app password, This computer, and the update check.

// ---------- settings ----------
function renderSettings() {
  loadRemoteCheckin();
  loadDesktop();
  loadUpdate();
  $('set-vacation').checked = !!S.settings.vacationMode;
  $('set-vacation-until').value = S.settings.vacationUntil || '';
  // No end date means indefinite; the checkbox mirrors it and disables
  // the date.
  $('set-vacation-indefinite').checked = !S.settings.vacationUntil;
  $('set-vacation-until').disabled = !S.settings.vacationUntil;
  // A new check-in rule defaults to 35 days, only while the Add form is
  // untouched.
  if (!$('btc-hex').value.trim()) {
    if (ruleLists.btc.panels.length) ruleLists.btc.panels[0].f.threshold.value = '35';
  }
  // Price source selects, from the server's provider list (with a
  // fallback copy), plus each source's last price.
  var providers = (S.bitcoin && Array.isArray(S.bitcoin.priceProviders) && S.bitcoin.priceProviders.length)
    ? S.bitcoin.priceProviders
    : [
      { id: 'coingecko', label: 'CoinGecko' },
      { id: 'coinbase', label: 'Coinbase' },
      { id: 'binance', label: 'Binance US (USDT)' },
      { id: 'kraken', label: 'Kraken' },
      { id: 'bitstamp', label: 'Bitstamp' },
      { id: 'custom', label: 'Custom' },
    ];
  var psrc = (S.settings && S.settings.priceSources) || { source1: 'coingecko', source2: 'coinbase' };
  function fillPriceSelect(sel, val) {
    sel.innerHTML = '';
    providers.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    });
    sel.value = (val && typeof val === 'object') ? 'custom' : val;
  }
  fillPriceSelect($('set-price-source1'), psrc.source1 || 'coingecko');
  fillPriceSelect($('set-price-source2'), psrc.source2 || 'coinbase');
  // Custom sources show their saved URL and path (visibility set by
  // refreshPriceSourceCustom).
  [1, 2].forEach(function (n) {
    var v = psrc['source' + n];
    if (v && typeof v === 'object') {
      var u = $('set-price-source' + n + '-url'); if (u) u.value = v.url || '';
      var pp = $('set-price-source' + n + '-path'); if (pp) pp.value = v.path || '';
    }
    refreshPriceSourceCustom(n);
  });
  // The row shows the provider with its last price beside its pill
  // ("Kraken $98,200 [OK]"), from the last test or else the cached
  // reading. Dropdown changes re-render the row, so it and Test
  // connection always mean the same provider.
  refreshPriceSourceRow(1);
  refreshPriceSourceRow(2);
  // Grace settings reflect the saved values; the toggle is the off
  // switch (missing means on), and a stored 0 duration displays as 7.
  // Only values are set, so a re-render never clobbers a choice in
  // progress.
  $('grace-enabled').checked = S.settings.graceEnabled !== false;
  var go = (S.settings && typeof S.settings.graceOfflineDays === 'number') ? S.settings.graceOfflineDays : 7;
  $('set-grace-offline').value = String(go);
  var gd = (S.settings && S.settings.graceDurationDays !== undefined) ? S.settings.graceDurationDays : 7;
  if (gd === 0) gd = 7; // a stored 0 meant off; the toggle says off now
  $('set-grace-duration').value = (gd === null) ? 'indefinite' : String(gd);
  syncGraceEnabled();
  // The number inputs reflect the saved settings; save handlers read the
  // inputs, so a re-render never clobbers typing.
  var pa = (S.settings && typeof S.settings.priceAgreementPct === 'number') ? S.settings.priceAgreementPct : 5;
  $('set-price-agreement').value = String(pa);
  var agreeSpan = $('price-sources-agreement');
  if (agreeSpan) agreeSpan.textContent = pa + '%';
  var cc = (S.settings && typeof S.settings.checkCadenceSeconds === 'number') ? S.settings.checkCadenceSeconds : 60;
  $('set-check-cadence').value = String(cc);
  var fl = (S.settings && typeof S.settings.feeLowMultiplier === 'number') ? S.settings.feeLowMultiplier : 2;
  $('set-fee-low').value = String(fl);
  var fm = (S.settings && typeof S.settings.feeMediumMultiplier === 'number') ? S.settings.feeMediumMultiplier : 1;
  $('set-fee-medium').value = String(fm);
  updateFeeZoneBar();
  // The fee-history note: what the peak covers, or that it is still
  // building (24 readings over a day).
  var fhn = $('fee-history-note');
  if (fhn) {
    var fobs = (S.bitcoin && typeof S.bitcoin.feePeakObservations === 'number') ? S.bitcoin.feePeakObservations : 0;
    var fwin = (S.bitcoin && typeof S.bitcoin.feePeakWindowDays === 'number') ? S.bitcoin.feePeakWindowDays : 0;
    fhn.textContent = (S.bitcoin && typeof S.bitcoin.feePeak === 'number')
      ? 'Peak from ' + fwin + (fwin === 1 ? ' day' : ' days') + ' of hourly observations (' + fobs + ' readings).'
      : 'Fee history is still building: ' + fobs + ' of 24 hourly observations. The peak appears after a day.';
  }
  renderApiKeys();
  setvRefresh();
}

// Price sources: each row's pill reads OK, Failed or Not Tested. A test
// verdict (kept per row this session) wins; changing the dropdown
// deletes it, and without one the row uses the cached reading only if
// the dropdown still holds the saved source (else Not Tested, never a
// wrong price). Keying by row lets a tested source stay OK after saving.
// Listeners are attached once, here. Custom URL and path inputs show
// only for Custom.
function refreshPriceSourceCustom(n) {
  var sel = $('set-price-source' + n);
  var box = $('price-source' + n + '-custom');
  if (!sel || !box) return;
  box.style.display = (sel.value === 'custom') ? '' : 'none';
}
// Two source values are the same: equal ids, or Custom with the same URL
// and path.
function samePriceSource(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (!a || !b) return a === b;
  return a.id === b.id && (a.url || '') === (b.url || '') && (a.path || '') === (b.path || '');
}
// One source's value for save or test: an id, or a Custom { id, url,
// path } from its inputs.
function priceSourceValue(n) {
  var sel = $('set-price-source' + n);
  if (sel && sel.value === 'custom') {
    var u = $('set-price-source' + n + '-url');
    var pp = $('set-price-source' + n + '-path');
    return { id: 'custom', url: u ? u.value.trim() : '', path: pp ? pp.value.trim() : '' };
  }
  return sel ? sel.value : '';
}
var priceSourceStatus = {}; // row ('source1'/'source2') -> 'ok' | 'failed' | 'not-tested': the last Test verdict (or change reset) for that row, in this session
var priceSourcePrice = {}; // row -> the last tested price (a number) or null: the price shown to the right of the pill
function setPriceSourceStatus(n, state) {
  var pill = $('price-source' + n + '-status');
  if (!pill) return;
  if (state === 'ok') { pill.textContent = 'OK'; pill.className = 'pill ok'; }
  else if (state === 'failed') { pill.textContent = 'Failed'; pill.className = 'pill bad'; }
  else { pill.textContent = 'Not Tested'; pill.className = 'pill muted'; }
}
function refreshPriceSourceRow(n, resetStatus) {
  var sel = $('set-price-source' + n);
  var host = $('price-source' + n);
  if (!sel || !host) return;
  var id = sel.value;
  var providers = (S.bitcoin && Array.isArray(S.bitcoin.priceProviders) && S.bitcoin.priceProviders.length)
    ? S.bitcoin.priceProviders
    : [
      { id: 'coingecko', label: 'CoinGecko' },
      { id: 'coinbase', label: 'Coinbase' },
      { id: 'binance', label: 'Binance US (USDT)' },
      { id: 'kraken', label: 'Kraken' },
      { id: 'bitstamp', label: 'Bitstamp' },
      { id: 'custom', label: 'Custom' },
    ];
  var label = id;
  for (var i = 0; i < providers.length; i++) if (providers[i].id === id) { label = providers[i].label; break; }
  var status, price = null;
  if (resetStatus) {
    delete priceSourceStatus['source' + n];
    delete priceSourcePrice['source' + n];
  }
  if (priceSourceStatus['source' + n] === 'ok' || priceSourceStatus['source' + n] === 'failed') {
    status = priceSourceStatus['source' + n];
    price = priceSourcePrice['source' + n];
  } else {
    // No test verdict: use the cached reading only if the dropdown still
    // holds the saved source.
    var saved = (S.settings && S.settings.priceSources) || {};
    var ex = samePriceSource(priceSourceValue(n), saved['source' + n])
      ? ((S.bitcoin && S.bitcoin.exchangeStatus && S.bitcoin.exchangeStatus.sources) || [])
      : [];
    var r = ex[n - 1];
    if (r && r.status === 'ok' && typeof r.price === 'number' && Number.isFinite(r.price)) { status = 'ok'; price = r.price; }
    else if (r && r.status === 'error') { status = 'failed'; }
    else { status = 'not-tested'; }
  }
  host.textContent = label;
  // The price sits beside the pill in small muted text, never in the
  // label.
  var priceEl = $('price-source' + n + '-price');
  if (priceEl) priceEl.textContent = (typeof price === 'number' && Number.isFinite(price)) ? '$' + price.toLocaleString('en-US') : '';
  setPriceSourceStatus(n, status);
}
$('set-price-source1').addEventListener('change', function () { refreshPriceSourceRow(1, true); refreshPriceSourceCustom(1); });
$('set-price-source2').addEventListener('change', function () { refreshPriceSourceRow(2, true); refreshPriceSourceCustom(2); });

async function savePriceSources() {
  var s = await api('PUT', '/api/settings', { priceSources: { source1: priceSourceValue(1), source2: priceSourceValue(2) } });
  S.settings = s;
}
$('btn-save-price-sources').addEventListener('click', async function () {
  try {
    await savePriceSources();
    setMsg($('price-sources-msg'), 'Price sources saved.', true);
    // Verdicts are per row, so saving keeps a tested source OK; a
    // changed source already lost its verdict to its change listener.
    await load();
  } catch (e) { setMsg($('price-sources-msg'), e.message, false); }
});

// Grace toggle in the card heading: off hides the dropdowns without
// clearing them.
function syncGraceEnabled() {
  var on = $('grace-enabled').checked;
  $('grace-fields').style.display = on ? '' : 'none';
  $('grace-enabled-wrap').title = on ? 'Grace period on — triggers pause after an offline gap' : 'Grace period off — triggers fire immediately';
}

// Save grace settings (the server rejects values the dropdowns do not
// offer). Turning the toggle off keeps the saved values, and ends an
// active grace everywhere at once; new values do not change an active
// grace.
$('btn-save-grace').addEventListener('click', async function () {
  var offline = parseInt($('set-grace-offline').value, 10);
  var durRaw = $('set-grace-duration').value;
  var duration = durRaw === 'indefinite' ? null : parseInt(durRaw, 10);
  try {
    var s = await api('PUT', '/api/settings', { graceEnabled: $('grace-enabled').checked, graceOfflineDays: offline, graceDurationDays: duration });
    S.settings = s;
    setMsg($('grace-settings-msg'), 'Grace period saved.', true);
    await load();
  } catch (e) { setMsg($('grace-settings-msg'), e.message, false); }
});

// The grace options hide or show at once; the value saves with Save
// grace period.
$('grace-enabled').addEventListener('change', syncGraceEnabled);

// Each card saves its own fields. parseFloat keeps decimals; a blank
// field is NaN, sent as null and rejected.
$('btn-save-price-agreement').addEventListener('click', async function () {
  var v = parseFloat($('set-price-agreement').value);
  try {
    var s = await api('PUT', '/api/settings', { priceAgreementPct: v });
    S.settings = s;
    setMsg($('price-agreement-msg'), 'Price agreement saved.', true);
    await load();
  } catch (e) { setMsg($('price-agreement-msg'), e.message, false); }
});

$('btn-save-check-cadence').addEventListener('click', async function () {
  var v = parseFloat($('set-check-cadence').value);
  try {
    var s = await api('PUT', '/api/settings', { checkCadenceSeconds: v });
    S.settings = s;
    setMsg($('check-cadence-msg'), 'Check cadence saved.', true);
    await load();
  } catch (e) { setMsg($('check-cadence-msg'), e.message, false); }
});

// Fee verdict zone bar, live as you type; the scale grows past 3x when
// Low is higher. Critical is fixed, so it is not a zone.
function updateFeeZoneBar() {
  var bar = $('zone-bar');
  if (!bar) return;
  var low = parseFloat($('set-fee-low').value);
  var med = parseFloat($('set-fee-medium').value);
  if (!isFinite(low) || low <= 0) low = 2;
  if (!isFinite(med) || med < 0) med = 1;
  med = Math.min(med, low);
  var max = Math.max(3, Math.ceil(low) + 1);
  var fmt = function (v) { return String(Math.round(v * 10) / 10); };
  var segHigh = $('seg-high'), segMed = $('seg-med'), segLow = $('seg-low');
  if (segHigh) segHigh.style.flexBasis = Math.max(0, med / max * 100) + '%';
  if (segMed) segMed.style.flexBasis = Math.max(0, (low - med) / max * 100) + '%';
  if (segLow) segLow.style.flexBasis = Math.max(0, (max - low) / max * 100) + '%';
  var rH = $('range-high'), rM = $('range-med'), rL = $('range-low');
  if (rH) rH.textContent = fmt(med) + '× and below';
  if (rM) rM.textContent = fmt(med) + '× – ' + fmt(low) + '×';
  if (rL) rL.textContent = fmt(low) + '× and up';
}
// The bar updates live as either number is typed; it is always
// visible, so there is no focus/blur show/hide.
['set-fee-low', 'set-fee-medium'].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener('input', updateFeeZoneBar);
});
$('btn-save-fee-verdict').addEventListener('click', async function () {
  var low = parseFloat($('set-fee-low').value);
  var med = parseFloat($('set-fee-medium').value);
  try {
    var s = await api('PUT', '/api/settings', { feeLowMultiplier: low, feeMediumMultiplier: med });
    S.settings = s;
    setMsg($('fee-verdict-msg'), 'Broadcast fee risk saved.', true);
    await load();
  } catch (e) { setMsg($('fee-verdict-msg'), e.message, false); }
});

// Price sources Test connection: tests whatever the two dropdowns hold,
// with fresh fetches; nothing configured or cached changes.
async function testPriceSources() {
  var btn = $('btn-test-price-sources');
  if (!btn) return;
  var ids = [priceSourceValue(1), priceSourceValue(2)];
  btn.disabled = true;
  try {
    var r = await api('POST', '/api/settings/price-sources/test-all', { providers: ids });
    // Results land on the rows (price beside pill), in request order:
    // result i is row i + 1.
    (r.results || []).forEach(function (x, i) {
      var n = i + 1;
      var ok = (typeof x.price === 'number' && Number.isFinite(x.price));
      priceSourceStatus['source' + n] = ok ? 'ok' : 'failed';
      priceSourcePrice['source' + n] = ok ? x.price : null;
      refreshPriceSourceRow(n);
    });
  } catch (e) {
    setMsg($('price-sources-msg'), 'Test failed — ' + e.message, false);
  }
  btn.disabled = false;
}

$('btn-test-price-sources').addEventListener('click', testPriceSources);

// Settings help: each card's "?" opens a pop-out with what the setting
// does and which trigger types it applies to. This registry is the only
// mapping of cards to trigger types: the "Applies to" line and the
// Settings filter both read it.
var SETTINGS_HELP = {
  vacation: {
    title: 'Vacation mode',
    body: 'Freezes the check-in countdown while you\u2019re away. Leave at 13 of 25 days and you come back to 13 of 25.\n\nCheck-in transactions do not fire while you\u2019re away, but price, UTXO, block-height, set-date, and fee-market triggers keep firing.\n\nSet an end date, or leave it indefinite and it holds until you say you\u2019re back.',
    triggers: ['checkin'],
  },
  arm: {
    title: 'All transactions',
    body: 'Arms or disarms sets in the Active category at once \u2014 check-in, BTC price, UTXO, block height, set date, fee market, and manual.\n\nDisarming stops new automatic releases for Active sets. Pending and Archived sets are unchanged; scheduled public fallback for a pending Slipstream transaction continues. A manual broadcast still works while disarmed.\n\nDisarmed check-in transactions freeze their countdown and resume from the same spot when re-armed.\n\n\u2018Arm all active\u2019 includes Active sets you had individually disarmed before.\n\n\u2018Broadcast armed\u2019 sends every armed transaction now, after a confirm naming how many.',
    triggers: ['general'],
  },
  nodes: {
    title: 'Bitcoin nodes',
    body: 'The Bitcoin nodes Standby talks to. The primary is tried first; if it fails, the secondary is used.\n\nToggle the secondary off to use the primary alone with no fallback if it is down or unreachable.\n\nEach node is a mempool instance \u2014 mempool.space by default, another public instance, or your own mempool on the LAN \u2014 or, with its RPC toggle on, Bitcoin Core over RPC. An RPC node needs txindex=1 to see spends in blocks; Test connection says if it is off.\n\nUTXO, block-height, and fee-market triggers read the node, and broadcasts go through it.\n\nA mempool running directly on Bitcoin Core reports that an input is spent but not by whom. Standby asks it whether that spend is confirmed instead, and counts a UTXO trigger\u2019s confirmations from when it first sees the confirmed spend.',
    triggers: ['general'],
  },
  'price-sources': {
    title: 'Bitcoin price source',
    body: 'The two price sources Standby reads the BTC price from. Every check, Standby fetches the price from both.\n\nA price trigger only fires when both agree within your price-agreement setting; if one is down, the other is used alone. When they agree, the primary\u2019s price decides.\n\nPick Custom for either source to point Standby at your own endpoint \u2014 give its full URL and the Custom endpoint json path (for example, data.amount).',
    triggers: ['price'],
  },
  grace: {
    title: 'Grace period',
    body: 'A pause for ALL triggers after the app has been offline. If Standby was offline longer than the \u2018offline\u2019 days, automatic broadcasts pause for the \u2018lasts\u2019 days, or until you resume.\n\nTurn it off with the toggle in the card heading.\n\nExample: Your device is offline for 10 days. Rather than broadcasting any transactions when the device powers back on, you enter a grace period. Triggers stay paused for 7 days, or until you clear the grace manually.',
    triggers: ['checkin', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket'],
  },
  agreement: {
    title: 'Price agreement',
    body: 'How closely the two price sources must agree. A price reading only counts if the two sources are within this % of each other. Tighter means safer but more \u2018unknown\u2019 readings during fast moves; looser fires more readily.',
    triggers: ['price'],
  },
  cadence: {
    title: 'Check cadence',
    body: 'How often every trigger is checked. Standby evaluates all triggers together every X seconds.\n\nFaster catches an unconfirmed spend, a brief price spike, or a block height sooner, but makes more API calls.\n\nThe price cache refreshes on this interval too. The fee cache does not: it refreshes once every 5 minutes regardless of this setting.\n\nPublic nodes rate-limit heavy use, so a very fast cadence can get this IP throttled.\n\nExample: at 60 seconds, a price spike that lasts 30 seconds may never be seen; at 10 seconds it will be \u2014 but that\u2019s six times the requests.',
    triggers: ['price', 'utxo', 'blockheight', 'setdate', 'feemarket'],
  },
  fee: {
    title: 'Broadcast Fee Risk',
    body: 'Where the Low / Medium / High fee pill flips. Each transaction\u2019s fee rate is compared to the peak fee \u2014 the 90th percentile of the hourly economy-fee readings Standby records from your nodes, up to 90 days back.\n\nLow Risk is at or above the Low multiplier, Medium Risk at or above the Medium multiplier, High Risk below it. A fee below the current economy fee is Critical Risk.\n\nThe peak needs a day of readings (24 hourly observations) before it appears; until then the pill is hidden and only the current-fee check applies. The pill is informational \u2014 it never blocks a broadcast \u2014 and shows on every staged transaction. The Low multiplier must stay above the Medium one.',
    triggers: ['general'],
  },
  keys: {
    title: 'Check-in API keys',
    body: 'The keys that can check in through the API. Your gadget uses one to tell Standby you\u2019re still here; each check-in resets the countdown on every check-in transaction.\n\nA key can only check in \u2014 no reading transactions, no broadcasts, no settings changes. One key per service, so revoking one leaves the others alone.\n\nKeep keys private: anyone holding one can check in as you. Shown once, at creation \u2014 copy it then.\n\nAs a custom integration: Name \u2018Standby Check-in\u2019, Base URL the connection IP above, Auth: Bearer <redacted> (Authorization: Bearer), Test path /health, API key / token the key you generate below.\n\nPlain HTTP only \u2014 keep port 3101 on your trusted LAN and Tailscale network; never expose it to the internet.',
    triggers: ['checkin'],
  },
  backup: {
    title: 'Data backup',
    body: 'Back up or restore everything Standby knows. A backup is a file holding all your staged transactions, triggers, and settings.\n\nRestoring replaces the current state with the backup\u2019s \u2014 a restore counts as a check-in and clears any active grace period. After restoring, Standby checks each transaction against your node (nothing is broadcast), so one that was already broadcast or went stale goes back to Archived.\n\nDownload it encrypted with a password you choose (recommended) or unencrypted. Encrypted, the file is useless without the password \u2014 and Standby cannot recover a lost password, so write it down somewhere other than this device. Unencrypted, it contains the signed hexes, which anyone can broadcast and which reveal the destination addresses and amounts, so treat it like the transactions themselves.\n\nAn encrypted backup can also be opened without Standby, using tools/decrypt-backup.js from the Standby repository.',
    triggers: ['general'],
  },
  // The version card has no help pop-out; the entry only places it under
  // General for the filter.
  version: {
    triggers: ['general'],
  },
};
// The "Applies to" label, derived from the triggers array (one, two, an
// Oxford list, or "All trigger types"; 'general' alone or appended as
// general infrastructure).
var TRIGGER_NAMES = { checkin: 'Check-in', price: 'BTC price', utxo: 'UTXO', manual: 'Manual', blockheight: 'Block height', setdate: 'Set date', feemarket: 'Fee market' };
function helpAppliesLabel(triggers) {
  var general = triggers.indexOf('general') !== -1;
  var codes = triggers.filter(function (t) { return t !== 'general'; });
  var label;
  if (codes.length === 0) {
    label = 'General — not tied to a specific trigger';
  } else if (codes.length === 7) {
    label = 'All trigger types';
  } else {
    var names = codes.map(function (c) { return TRIGGER_NAMES[c] || c; });
    if (names.length === 1) {
      label = names[0] + ' triggers';
    } else if (names.length === 2) {
      label = names.join(' and ') + ' triggers';
    } else {
      label = names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1] + ' triggers';
    }
    if (codes.length === 1 && !general) label += ' only';
  }
  if (general && codes.length > 0) label += ', and general infrastructure';
  return label;
}
Object.keys(SETTINGS_HELP).forEach(function (key) {
  var btn = $('help-' + key);
  if (!btn) return;
  btn.addEventListener('click', function () {
    var h = SETTINGS_HELP[key];
    showDetails(h.title, h.body, '<p><strong>Applies to:</strong> ' + escapeHtml(helpAppliesLabel(h.triggers)) + '</p>');
  });
});

// Settings filter: shows cards whose triggers array includes the chosen
// type; resets to All when the tab opens.
function applySettingsFilter(name) {
  if (!SETTINGS_HELP) return;
  var sel = $('filter-select');
  if (sel) sel.value = name;
  Object.keys(SETTINGS_HELP).forEach(function (key) {
    var card = $('card-' + key);
    if (!card) return;
    var show = name === 'all' || SETTINGS_HELP[key].triggers.indexOf(name) !== -1;
    card.style.display = show ? '' : 'none';
  });
}
var filterSel = $('filter-select');
if (filterSel) filterSel.addEventListener('change', function () { applySettingsFilter(filterSel.value); });

$('btn-save-vacation').addEventListener('click', async function () {
  try {
    var indefinite = $('set-vacation-indefinite').checked;
    var s = await api('PUT', '/api/settings', {
      vacationMode: $('set-vacation').checked,
      vacationUntil: indefinite ? null : ($('set-vacation-until').value || null),
    });
    S.settings = s;
    setMsg($('vacation-msg'), 'Vacation settings saved.', true);
    await load();
  } catch (e) { setMsg($('vacation-msg'), e.message, false); }
});

$('set-vacation-indefinite').addEventListener('change', function () {
  $('set-vacation-until').disabled = $('set-vacation-indefinite').checked;
});

// All transactions (Arm all, Disarm all): one call arms or disarms every
// staged transaction. The server answers with the updated list.
async function armAll(enabled) {
  try {
    await api('POST', '/api/bitcoin/txs/arm-all', { enabled: enabled });
    setMsg($('arm-all-msg'), enabled ? 'Active sets armed.' : 'Active sets disarmed.', true);
    await load();
  } catch (e) { setMsg($('arm-all-msg'), e.message, false); }
}

$('btn-arm-all').addEventListener('click', function () { armAll(true); });

$('btn-disarm-all').addEventListener('click', function () { armAll(false); });

// Check-in API keys: one labelled key per service. The plaintext key
// shows once, when created; afterwards only its label and last use.
// Revoking one leaves the others working.
var apiKeys = []; // { id, label, createdAt, lastUsedAt }
var newKeyPlain = null; // the plaintext of the key just created, until its pop-out closes

function renderApiKeys() {
  var list = $('api-keys-list');
  list.innerHTML = '';
  if (!apiKeys.length) {
    var none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No API keys yet.';
    list.appendChild(none);
    return;
  }
  apiKeys.forEach(function (k) {
    var row = document.createElement('div');
    row.className = 'api-key-row';
    var name = document.createElement('b');
    name.textContent = k.label || 'Untitled key';
    var meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = 'created ' + fmtDate(k.createdAt) + ' · last used ' + (k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never');
    var del = document.createElement('button');
    del.textContent = 'Revoke';
    del.className = 'danger';
    del.addEventListener('click', function () { revokeApiKey(k.id, k.label); });
    row.appendChild(name); row.appendChild(meta); row.appendChild(del);
    list.appendChild(row);
  });
}

function revokeApiKey(id, label) {
  showConfirm('Revoke this key?',
    'This revokes the key labelled "' + (label || 'Untitled key') + '". The service using it will no longer be able to check in. Other keys are unaffected.',
    async function () {
      try {
        var result = await api('DELETE', '/api/checkin-keys/' + encodeURIComponent(id));
        apiKeys = apiKeys.filter(function (k) { return k.id !== id; });
        renderApiKeys();
        setMsg($('api-keys-msg'), result.warning || 'Key revoked; receiver confirmed.', !result.warning);
      } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
    },
    'Revoke');
}

// The new-key pop-out, built from real elements so Copy has a handler;
// closing it drops the key.
function showNewKeyModal() {
  $('confirm-title').textContent = 'Your new key';
  $('confirm-body').textContent = 'Your new key — copy it now, it will not be shown again.';
  var details = $('modal-details');
  details.innerHTML = '';
  var input = document.createElement('input');
  input.id = 'new-key-value';
  input.type = 'text';
  input.readOnly = true;
  input.value = newKeyPlain || '';
  details.appendChild(input);
  var copyBtn = document.createElement('button');
  copyBtn.id = 'btn-key-copy';
  copyBtn.className = 'primary';
  copyBtn.textContent = 'Copy key';
  copyBtn.addEventListener('click', copyNewKey);
  details.appendChild(copyBtn);
  $('confirm-proceed').style.display = 'none';
  $('confirm-cancel').textContent = 'Close';
  confirmPending = null;
  $('confirm-modal').classList.add('open');
}

async function copyNewKey() {
  var el = $('new-key-value');
  var copied = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(newKeyPlain || (el && el.value) || '');
      copied = true;
    }
  } catch (e) { copied = false; }
  if (!copied && el && typeof el.select === 'function' && typeof document.execCommand === 'function') {
    try { el.select(); document.execCommand('copy'); copied = true; } catch (e) { copied = false; }
  }
  setMsg($('api-keys-msg'), copied ? 'Key copied.' : 'Copy failed — select the key and copy it by hand.', copied);
}

$('btn-api-key-create').addEventListener('click', async function () {
  try {
    var r = await api('POST', '/api/checkin-keys', { label: $('api-key-label').value });
    apiKeys.push(r.key);
    $('api-key-label').value = '';
    newKeyPlain = r.plain;
    showNewKeyModal();
    renderApiKeys();
    setMsg($('api-keys-msg'), 'Key created — copy it now. It will not be shown again.', true);
  } catch (e) { setMsg($('api-keys-msg'), e.message, false); }
});

// ---------- data backup ----------
// Download Backup asks: encrypted with the owner's password (default) or
// unencrypted after a warning. The server encrypts, so the plaintext
// never crosses the network.
function backupMode() { return $('backup-encrypt').checked ? 'encrypted' : 'plain'; }
function syncBackupMode() {
  var enc = backupMode() === 'encrypted';
  $('backup-encrypted-fields').style.display = enc ? '' : 'none';
  $('backup-plain-fields').style.display = enc ? 'none' : '';
  // Only when an RPC password is saved: the file carries it.
  var rpcSaved = ['primaryRpc', 'secondaryRpc'].some(function (k) { return S.settings && S.settings[k] && S.settings[k].hasPassword; });
  $('backup-rpc-warning').style.display = rpcSaved ? '' : 'none';
  // The write-it-down warning belongs to a generated passphrase, so
  // it goes away while encryption is off and comes back with it.
  setMsg($('backup-modal-msg'), enc && generatedPassphrase ? 'Write this passphrase down now \u2014 it is not stored anywhere.' : '', 'warn');
}
function closeBackupModal() {
  $('backup-modal').classList.remove('open');
  $('backup-password').value = '';
  $('backup-password2').value = '';
  useTypedPassword();
  setMsg($('backup-modal-msg'), '', true);
}
// Password: typed twice, or generated (shown once, in full); turning the
// switch on again makes a new one.
var generatedPassphrase = null;
function useTypedPassword() {
  generatedPassphrase = null;
  $('backup-generate').checked = false;
  $('backup-generated').textContent = '';
  $('backup-generated-fields').style.display = 'none';
  $('backup-typed-fields').style.display = '';
}
$('backup-encrypt').addEventListener('change', syncBackupMode);
$('backup-modal-x').addEventListener('click', closeBackupModal);
$('btn-backup-modal-cancel').addEventListener('click', closeBackupModal);
$('btn-backup-download').addEventListener('click', function () {
  $('backup-encrypt').checked = true;
  syncBackupMode();
  $('backup-modal').classList.add('open');
});
// A generated passphrase: 6 groups of 5 from an unambiguous alphabet (no
// 0/o, 1/l/i), about 145 bits.
$('backup-generate').addEventListener('change', function () {
  if (!this.checked) {
    useTypedPassword();
    setMsg($('backup-modal-msg'), '', true);
    $('backup-password').focus();
    return;
  }
  var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  var bytes = new Uint32Array(30);
  window.crypto.getRandomValues(bytes);
  var groups = [];
  for (var g = 0; g < 6; g++) {
    var w = '';
    for (var i = 0; i < 5; i++) w += alphabet[bytes[g * 5 + i] % alphabet.length];
    groups.push(w);
  }
  generatedPassphrase = groups.join('-');
  $('backup-password').value = '';
  $('backup-password2').value = '';
  $('backup-generated').textContent = generatedPassphrase;
  $('backup-typed-fields').style.display = 'none';
  $('backup-generated-fields').style.display = '';
  setMsg($('backup-modal-msg'), 'Write this passphrase down now — it is not stored anywhere.', 'warn');
});
$('btn-backup-modal-download').addEventListener('click', async function () {
  var enc = backupMode() === 'encrypted';
  var body = {};
  if (enc && generatedPassphrase) {
    body.password = generatedPassphrase;
  } else if (enc) {
    var pw = $('backup-password').value;
    if (pw.length < 12) { setMsg($('backup-modal-msg'), 'The password must be at least 12 characters.', false); return; }
    if (pw !== $('backup-password2').value) { setMsg($('backup-modal-msg'), 'The two passwords do not match.', false); return; }
    body.password = pw;
  }
  var btn = $('btn-backup-modal-download');
  btn.disabled = true;
  setMsg($('backup-modal-msg'), enc ? 'Encrypting…' : 'Preparing…', true);
  try {
    var backup = await api('POST', '/api/backup', body);
    var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'standby-backup-' + new Date().toISOString().slice(0, 10) + (enc ? '.encrypted' : '') + '.json';
    if (document.body) document.body.appendChild(a);
    a.click();
    if (document.body) document.body.removeChild(a);
    URL.revokeObjectURL(url);
    closeBackupModal();
    setMsg($('backup-msg'), enc ? 'Encrypted backup downloaded.' : 'Unencrypted backup downloaded — keep it somewhere safe.', enc ? true : 'warn');
  } catch (e) {
    setMsg($('backup-modal-msg'), e.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('btn-backup-restore').addEventListener('click', function () { $('backup-file').click(); });

$('backup-file').addEventListener('change', async function () {
  var file = $('backup-file').files && $('backup-file').files[0];
  if (!file) return;
  try {
    var r = await restoreBackupFile(file);
    setMsg($('backup-msg'), restoreMessage(r), true);
    $('backup-file').value = '';
    await load();
    showRestoreResult(r);
  } catch (e) {
    if (e.message !== 'cancelled') setMsg($('backup-msg'), e.message, false);
    $('backup-file').value = '';
  }
});

// ---------- app login ----------
$('login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var btn = $('btn-login');
  btn.disabled = true;
  setMsg($('login-msg'), 'Checking…', true);
  try {
    var r = await api('POST', '/api/login', { password: $('login-password').value });
    setToken(r.token);
    $('login-password').value = '';
    window.location.reload();
  } catch (e) {
    setMsg($('login-msg'), e.message, false);
    btn.disabled = false;
  }
});
// App login: who sets the password (auth/status source: 'env' is
// STANDBY_PASSWORD or Umbrel's app password, 'app' is set here, 'none').
var authInfo = { required: false, source: 'none', deployment: '' };
var authKnown = false;
var MIN_APP_PASSWORD = 12;

// Where a password set outside the app (auth source 'env') is found:
// Umbrel shows it; Docker keeps it in .env; otherwise the environment.
function envPasswordWhere() {
  if (authInfo.deployment === 'umbrel') return "It is Umbrel's app password for Standby: Umbrel shows it on Standby's page in the Umbrel dashboard.";
  if (authInfo.deployment === 'docker') return 'It is the STANDBY_PASSWORD line in the .env file in the folder where Standby was installed (next to docker-compose.yml).';
  return 'It is the STANDBY_PASSWORD setting Standby was started with.';
}

function renderLoginCard() {
  var src = authInfo.source;
  $('login-card-none').style.display = src === 'none' ? '' : 'none';
  $('login-card-app').style.display = src === 'app' ? '' : 'none';
  var env = $('login-card-env');
  env.style.display = src === 'env' ? '' : 'none';
  env.textContent = 'A password is set. ' + envPasswordWhere() + (authInfo.deployment === 'umbrel' ? '' : ' It is changed there, not here.');
  $('logout-row').style.display = authInfo.required ? '' : 'none';
  // Start fresh: what happens to the password, only where it matters.
  $('fresh-login-note').textContent = src === 'app' ? 'Your Standby password is removed too, so setup asks for a new one.'
    : (src === 'env' && authInfo.deployment === 'umbrel') ? 'Your Umbrel app password stays.' : '';
}

// "Forgot password?" on the login screen: instructions only — nothing
// here can show or reset the password.
function renderForgot() {
  var body = $('login-forgot-body');
  if (authInfo.source === 'app' && authInfo.dataFolder) {
    // A standalone build: no command line needed.
    body.innerHTML = '<p>It cannot be shown or reset from this page. On the computer running Standby:</p>'
      + '<ol><li>Close Standby (close its window).</li><li>Open the folder <code></code> and delete the file <code>login.json</code> in it.</li><li>Start Standby again and set a new password.</li></ol>'
      + '<p>Your transactions, triggers and settings are kept.</p>';
    body.querySelector('code').textContent = authInfo.dataFolder;
  } else if (authInfo.source === 'app') {
    body.innerHTML = '<p>It cannot be shown or reset from this page. On the computer running Standby:</p>'
      + '<ol><li>Close Standby.</li><li>Start it again with <code>--reset-password</code>, or delete <code>login.json</code> from the Standby data folder'
      + (authInfo.deployment === 'docker' ? ' (<code>data</code>, next to <code>docker-compose.yml</code>)' : '') + '.</li><li>Open Standby and set a new password.</li></ol>'
      + '<p>Your transactions, triggers and settings are kept.</p>';
  } else {
    body.innerHTML = '';
    var para = document.createElement('p');
    para.textContent = envPasswordWhere() + (authInfo.deployment === 'umbrel' ? '' : ' To change it, edit it there and restart Standby.');
    body.appendChild(para);
  }
  $('login-hint').textContent = authInfo.deployment === 'umbrel'
    ? "Enter the Standby password. On Umbrel it is shown on the app's page in the Umbrel dashboard."
    : 'Enter your Standby password.';
}

function newPasswordFrom(id1, id2) {
  var a = $(id1).value, b = $(id2).value;
  if (a.length < MIN_APP_PASSWORD) throw new Error('The password must be at least ' + MIN_APP_PASSWORD + ' characters.');
  if (a !== b) throw new Error('The two passwords do not match.');
  return a;
}
function clearFields(ids) { ids.forEach(function (id) { $(id).value = ''; }); }
// Set, change or remove the app password; this browser stays logged in
// with the fresh token (other sessions end).
async function setAppPassword(body) {
  var r = await api('POST', '/api/auth/password', body);
  setToken(r.token);
  authInfo.required = !!r.required;
  authInfo.source = r.required ? 'app' : 'none';
  renderLoginCard();
  renderForgot();
  return r;
}

$('btn-login-set').addEventListener('click', async function () {
  try {
    await setAppPassword({ password: newPasswordFrom('login-new1', 'login-new2') });
    clearFields(['login-new1', 'login-new2']);
    setMsg($('logout-msg'), 'Password set. Standby now asks for it on every device.', true);
  } catch (e) { setMsg($('logout-msg'), e.message, false); }
});
$('btn-login-change').addEventListener('click', async function () {
  try {
    var pw = newPasswordFrom('login-chg1', 'login-chg2');
    await setAppPassword({ current: $('login-cur').value, password: pw });
    clearFields(['login-cur', 'login-chg1', 'login-chg2']);
    setMsg($('logout-msg'), 'Password changed. Other devices must log in again.', true);
  } catch (e) { setMsg($('logout-msg'), e.message, false); }
});
$('btn-login-remove').addEventListener('click', function () {
  var current = $('login-cur').value;
  if (!current) { setMsg($('logout-msg'), 'Enter your current password first.', false); return; }
  showConfirm('Remove the password?', 'Anyone who can open this page will be able to use Standby.', async function () {
    try {
      await setAppPassword({ current: current, remove: true });
      clearFields(['login-cur', 'login-chg1', 'login-chg2']);
      setMsg($('logout-msg'), 'Password removed.', true);
    } catch (e) { setMsg($('logout-msg'), e.message, false); }
  }, 'Remove password');
});
$('btn-logout').addEventListener('click', async function () {
  try {
    await api('POST', '/api/logout');
    setToken(null);
    window.location.reload();
  } catch (e) { setMsg($('logout-msg'), e.message, false); }
});

// This computer (standalone builds): start with the computer, and Stop
// Standby. desktopInfo is GET /api/desktop; null until known.
var desktopInfo = null;
function loadDesktop() {
  return api('GET', '/api/desktop').then(function (d) { desktopInfo = d; renderDesktop(); })
    .catch(function () { /* older server: nothing to show */ });
}
// Windows runs in the tray; Linux has no tray icon, so it says where
// to open Standby instead.
function hasTray() { return !!(desktopInfo && desktopInfo.platform === 'win32'); }
function pageAddress() { return 'http://' + (window.location.host || 'localhost:3100'); }
function renderDesktop() {
  var d = desktopInfo;
  $('card-desktop').style.display = (d && d.available) ? '' : 'none';
  if (!d || !d.available) return;
  $('desktop-autostart').checked = !!d.startAtLogin;
  $('desktop-autostart-note').textContent = hasTray()
    ? 'Standby starts in the background when you sign in to this computer, with its icon next to the clock. Triggers are only checked while Standby runs.'
    : 'Standby starts in the background when you sign in to this computer, with no window: open it at ' + pageAddress() + '. Triggers are only checked while Standby runs.';
  if (d.error) setMsg($('desktop-msg'), 'Could not change the sign-in list: ' + d.error, false);
}
async function setStartAtLogin(want, msgEl) {
  try {
    S.settings = await api('PUT', '/api/settings', { startAtLogin: want });
    await loadDesktop();
    setMsg(msgEl, '', true);
  } catch (e) {
    setMsg(msgEl, e.message, false);
    await loadDesktop();
  }
}
$('desktop-autostart').addEventListener('change', function () { setStartAtLogin($('desktop-autostart').checked, $('desktop-msg')); });
$('btn-app-stop').addEventListener('click', function () {
  showConfirm('Stop Standby?', 'Triggers are not checked until you start Standby again.', async function () {
    try {
      await api('POST', '/api/app/stop');
      setMsg($('desktop-msg'), 'Standby has stopped. Start it again by opening the Standby program.', true);
    } catch (e) { setMsg($('desktop-msg'), e.message, false); }
  }, 'Stop Standby');
});

// Check for new versions: GET /api/update. The dashboard notice shows a
// newer version until "Not now" for that version (in this browser).
var UPDATE_DISMISS_KEY = 'standby.updateDismissed';
var updateInfo = null;
function loadUpdate() {
  return api('GET', '/api/update').then(function (u) { updateInfo = u; renderUpdate(); })
    .catch(function () { /* older server: nothing to show */ });
}
function renderUpdate() {
  var u = updateInfo;
  var avail = !!(u && u.available);
  $('update-box').style.display = avail ? '' : 'none';
  $('btn-update-now').style.display = (avail && u.enabled) ? '' : 'none';
  $('update-now-row').style.display = (avail && u.enabled) ? '' : 'none';
  var banner = $('update-banner');
  if (!avail) { banner.style.display = 'none'; return; }
  $('update-check').checked = !!u.enabled;
  var notice = $('update-notice');
  if (u.enabled && u.newer) {
    notice.style.display = '';
    notice.innerHTML = '';
    notice.appendChild(document.createTextNode('Standby ' + u.latest + ' is available. '));
    var a = document.createElement('a');
    a.href = u.url || 'https://github.com/thefuckisalommy/Standby/releases';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Download it from GitHub';
    notice.appendChild(a);
    notice.appendChild(document.createTextNode('. Your data stays where it is.'));
  } else {
    notice.style.display = 'none';
  }
  if (u.enabled && u.error) setMsg($('update-msg'), 'Could not check: ' + u.error, false);
  else if (u.enabled && u.checkedAt && !u.newer) setMsg($('update-msg'), 'You have the latest version (checked ' + fmtCheckedAt(u.checkedAt) + ').', true);
  else setMsg($('update-msg'), '', true);
  var dismissed = null;
  try { dismissed = window.localStorage.getItem(UPDATE_DISMISS_KEY); } catch (e) { /* none */ }
  var show = u.enabled && u.newer && dismissed !== u.latest;
  banner.style.display = show ? '' : 'none';
  renderAlerts();
  if (show) {
    $('update-banner-version').textContent = u.latest;
    $('update-banner-link').href = u.url || 'https://github.com/thefuckisalommy/Standby/releases';
  }
}
$('update-banner-later').addEventListener('click', function (ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  try { if (updateInfo && updateInfo.latest) window.localStorage.setItem(UPDATE_DISMISS_KEY, updateInfo.latest); } catch (e) { /* this view only */ }
  $('update-banner').style.display = 'none';
  renderAlerts();
});
$('update-check').addEventListener('change', async function () {
  var want = $('update-check').checked;
  try {
    S.settings = await api('PUT', '/api/settings', { updateCheck: want });
    if (want) {
      setMsg($('update-msg'), 'Checking…', true);
      await new Promise(function (r) { setTimeout(r, 1500); });
    }
    await loadUpdate();
  } catch (e) {
    $('update-check').checked = !want;
    setMsg($('update-msg'), e.message, false);
  }
});
$('btn-update-now').addEventListener('click', async function () {
  setMsg($('update-msg'), 'Checking…', true);
  try { updateInfo = await api('POST', '/api/update/check'); renderUpdate(); } catch (e) { setMsg($('update-msg'), e.message, false); }
});
