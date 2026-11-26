// Width check: Chromium (Playwright) at 390px against the app the DOM
// launcher runs on :3478. Forms, notes, Settings cards, help buttons and
// filter must fit; readiness rows stay one line; exchange and node pills
// share a right edge; on a phone the tabs are a bar along the bottom.
// Exits 0 when every check passes; prints PASS/FAIL per check, then
// FAILURES: N.
'use strict';
const { chromium, devices } = require('playwright');

const BASE = 'http://127.0.0.1:3478';
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL'), '-', name, cond ? '' : '| ' + String(detail).slice(0, 200));
  if (!cond) failures.push(name);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // The cards live on the Bitcoin tab, which is hidden until it is
  // the active tab — switch first, then wait for a card to be visible.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tabs button')].find((x) => x.dataset.tab === 'bitcoin');
    if (b) b.click();
  });
  await page.waitForSelector('.tx-card', { timeout: 10000 });
  await page.waitForTimeout(400);

  // No overflow inside the element and fully inside the 390px viewport.
  // Returns a short summary.
  async function measure(sel) {
    return await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        sw: el.scrollWidth, cw: el.clientWidth,
        right: Math.round(r.right * 10) / 10, left: Math.round(r.left * 10) / 10,
        visible: r.width > 0,
      };
    }, sel);
  }
  function fits(m, label) {
    if (!m) return { ok: false, why: label + ' missing' };
    if (!m.visible) return { ok: false, why: label + ' not visible' };
    if (m.sw > m.cw) return { ok: false, why: label + ' overflows inside itself (scrollWidth ' + m.sw + ' > clientWidth ' + m.cw + ')' };
    if (m.right > 390) return { ok: false, why: label + ' cut off at the right edge (right ' + m.right + ' > 390)' };
    return { ok: true, why: label + ' fits (scrollWidth ' + m.sw + ' <= clientWidth ' + m.cw + ', right ' + m.right + ')' };
  }
  // Inputs and selects: only the bounding box matters (a long value
  // scrolls inside the input).
  function fitsBox(m, label) {
    if (!m) return { ok: false, why: label + ' missing' };
    if (!m.visible) return { ok: false, why: label + ' not visible' };
    if (m.right > 390) return { ok: false, why: label + ' cut off at the right edge (right ' + m.right + ' > 390)' };
    return { ok: true, why: label + ' fits (right ' + m.right + ')' };
  }
  async function checkEl(name, sel) {
    const m = await measure(sel);
    const f = fits(m, name);
    check(name, f.ok, f.why);
  }
  async function checkInput(name, sel) {
    const m = await measure(sel);
    const f = fitsBox(m, name);
    check(name, f.ok, f.why);
  }
  async function checkPage(name) {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(name, sw <= 390, 'document scrollWidth ' + sw);
  }

  // --- Trigger subcards: three stacked rows ---
  // Each card's subcard fits at 390px and its rows (header, condition,
  // state) each start below the previous.
  const subcards = await page.evaluate(() => {
    return [...document.querySelectorAll('.tx-card')].map((card) => {
      // The first .tx-trigger is the blue tx subcard (.tx-item); the
      // trigger box is the first plain one.
      const box = card.querySelector('.tx-trigger:not(.tx-item)');
      if (!box) return null;
      const rows = [...box.children].filter((el) => !el.classList.contains('tx-details')).map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 };
      });
      const item = card.querySelector('.tx-trigger.tx-item');
      const hasDetails = !!item && !!item.querySelector(':scope > .tx-details');
      const br = box.getBoundingClientRect();
      return { sw: box.scrollWidth, cw: box.clientWidth, right: Math.round(br.right * 10) / 10,
        visible: br.width > 0, rows, hasDetails };
    });
  });
  check('width subcards: every tx card has a subcard (at least the 4 seeded)',
    subcards.length >= 4 && subcards.every(Boolean),
    'subcards found: ' + subcards.filter(Boolean).length);
  // One log line per subcard, so a failure survives check()'s 200-char
  // truncation.
  const fitsOk = subcards.length >= 4 && subcards.every((s) => s && s.visible && s.sw <= s.cw && s.right <= 390);
  if (!fitsOk) {
    subcards.forEach((s, i) => console.log('  width subcards fit: subcard ' + i + ': ' + JSON.stringify(s && { sw: s.sw, cw: s.cw, right: s.right, visible: s.visible })));
  }
  const fitsFailing = subcards.map((s, i) => (s && s.visible && s.sw <= s.cw && s.right <= 390) ? null : i).filter((i) => i !== null);
  check('width subcards: every subcard fits at 390px',
    fitsOk,
    fitsFailing.length ? 'failing subcard(s): ' + fitsFailing.join(', ') : 'fewer than 4 subcards (' + subcards.length + ')');
  // A 1px tolerance forgives rounding differences between Chromium builds;
  // a real overlap is tens of pixels. The row count stays exact.
  function rowsStacked(rows) {
    return rows.length === 3
      && rows[1].top >= rows[0].bottom - 1
      && rows[2].top >= rows[1].bottom - 1;
  }
  const stackedOk = subcards.length >= 4 && subcards.every((s) => s && rowsStacked(s.rows));
  if (!stackedOk) {
    subcards.forEach((s, i) => console.log('  width subcards rows: subcard ' + i + ': ' + JSON.stringify(s && s.rows)));
  }
  const stackedFailing = subcards.map((s, i) => (s && rowsStacked(s.rows)) ? null : i).filter((i) => i !== null);
  check('width subcards: every subcard has 3 rows stacked on separate lines',
    stackedOk,
    stackedFailing.length ? 'failing subcard(s): ' + stackedFailing.join(', ') : 'fewer than 4 subcards (' + subcards.length + ')');
  check('width subcards: every tx subcard holds its Details inside it (0.8.7 fix, round 3)',
    subcards.length >= 4 && subcards.every((s) => s && s.hasDetails),
    JSON.stringify(subcards.map((s) => s && s.hasDetails)));
  // The Staged Transactions card (0.8.0): its summary is the
  // card header and the collapse toggle — it fits at 390px.
  await checkEl('width bitcoin: Staged Transactions summary fits', '#btc-card > summary');

  // The "+ Add Tx" pill in the Staged Transactions header fits.
  await checkEl('width bitcoin: "+ Add Tx" pill in the Staged header fits', '#btn-btc-add-pill');

  // --- Add form: every trigger type and the fallback row ---
  // Open the #add-modal popup before measuring.
  await page.click('#btn-btc-add-open');
  await page.waitForSelector('#add-modal.open', { timeout: 5000 });
  await page.waitForTimeout(200);
  for (const v of ['checkin', 'price', 'utxo', 'manual']) {
    await page.selectOption('#btc-rule-0-trigger', v);
    await page.waitForTimeout(100);
    await checkPage('width add: document has no horizontal overflow with trigger=' + v);
  }
  // Price row: the $ amount input itself must be fully visible.
  await page.selectOption('#btc-rule-0-trigger', 'price');
  await page.waitForTimeout(100);
  await checkInput('width add: price $ amount input fully visible', '#btc-rule-0-value');
  await checkEl('width add: price row (op + $ + input) fits', '#btc-rule-0-trigger-price-row .inline-unit');
  await checkEl('width add: price guard note fits', '#btc-rule-0-trigger-price-note');
  // The price guard note, both directions (the text changes above/below).
  await page.selectOption('#btc-rule-0-op', '<=');
  await page.waitForTimeout(100);
  await checkEl('width add: price guard note fits (below)', '#btc-rule-0-trigger-price-note');
  await page.selectOption('#btc-rule-0-op', '>=');
  await page.waitForTimeout(100);
  // UTXO row: the outpoint input, the Fire-on select, the
  // confirmations row, and the guard note in both modes.
  await page.selectOption('#btc-rule-0-trigger', 'utxo');
  await page.waitForTimeout(100);
  await checkInput('width add: UTXO outpoint input fits', '#btc-rule-0-outpoint');
  await checkInput('width add: UTXO Fire-on select fits', '#btc-rule-0-utxo-mode');
  await checkEl('width add: UTXO confirmations row (Fire after + input) fits', '#btc-rule-0-trigger-utxo-confs-row .inline-unit');
  await checkEl('width add: UTXO guard note fits (confirmed, N=1)', '#btc-rule-0-trigger-utxo-note');
  await page.selectOption('#btc-rule-0-utxo-mode', 'unconfirmed');
  await page.waitForTimeout(100);
  await checkEl('width add: UTXO guard note fits (unconfirmed)', '#btc-rule-0-trigger-utxo-note');
  await page.selectOption('#btc-rule-0-utxo-mode', 'confirmed');
  await page.waitForTimeout(100);
  await page.fill('#btc-rule-0-utxo-confs', '100');
  await page.waitForTimeout(100);
  await checkEl('width add: UTXO guard note fits (confirmed, N=100)', '#btc-rule-0-trigger-utxo-note');
  // Check-in row: the days input + "days" unit.
  await page.selectOption('#btc-rule-0-trigger', 'checkin');
  await page.waitForTimeout(100);
  await checkInput('width add: check-in days input fits', '#btc-rule-0-threshold');
  await checkEl('width add: check-in row (input + days) fits', '#btc-rule-0-trigger-checkin-row .inline-unit');
  // Rule list: a second panel + the AND/OR toggle fit at 390px.
  await page.click('#btc-add-rule');
  await page.waitForTimeout(100);
  await checkEl('width add: second rule panel fits', '#btc-rule-1');
  await checkEl('width add: combine section fits', '#btc-op-section');
  await checkPage('width add: document has no horizontal overflow with two rule panels');
  // Fallback row: select Slipstream so the row shows, both durations.
  await page.selectOption('#btc-route', 'slipstream');
  await page.waitForTimeout(100);
  await checkInput('width add: fallback select fits', '#btc-fallback');
  await checkEl('width add: fallback note fits (Never)', '#btc-fallback-note');
  await page.selectOption('#btc-fallback', '90');
  await page.waitForTimeout(100);
  await checkEl('width add: fallback note fits (90 days)', '#btc-fallback-note');
  await page.selectOption('#btc-route', 'public');
  await page.waitForTimeout(100);
  // The Add message with a 64-hex txid, the longest unbreakable string it
  // can hold.
  await page.evaluate(() => {
    const el = document.querySelector('#btc-msg');
    if (el) el.textContent = 'Transaction added and armed. TXID ' + 'a'.repeat(64) + ' — use the toggle to unarm it.';
  });
  await checkEl('width add: message line with a 64-hex txid fits', '#btc-msg');

  // --- Edit popup: every trigger type + the fallback row + notes ---
  // Open Edit on the first card (Dom Check-in).
  await page.evaluate(() => {
    const card = document.querySelector('.tx-card');
    const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
    if (btn) btn.click();
  });
  await page.waitForSelector('#edit-modal.open', { timeout: 5000 });
  await page.waitForTimeout(200);
  for (const v of ['checkin', 'price', 'utxo', 'manual']) {
    await page.selectOption('#edit-rule-0-trigger', v);
    await page.waitForTimeout(100);
    await checkPage('width edit: document has no horizontal overflow with trigger=' + v);
  }
  await page.selectOption('#edit-rule-0-trigger', 'price');
  await page.waitForTimeout(100);
  await checkInput('width edit: price $ amount input fully visible', '#edit-rule-0-value');
  await checkEl('width edit: price row (op + $ + input) fits', '#edit-rule-0-trigger-price-row .inline-unit');
  await checkEl('width edit: price guard note fits', '#edit-rule-0-trigger-price-note');
  await page.selectOption('#edit-rule-0-trigger', 'utxo');
  await page.waitForTimeout(100);
  await checkInput('width edit: UTXO outpoint input fits', '#edit-rule-0-outpoint');
  await checkInput('width edit: UTXO Fire-on select fits', '#edit-rule-0-utxo-mode');
  await checkEl('width edit: UTXO confirmations row fits', '#edit-rule-0-trigger-utxo-confs-row .inline-unit');
  await checkEl('width edit: UTXO guard note fits (confirmed, N=1)', '#edit-rule-0-trigger-utxo-note');
  await page.selectOption('#edit-rule-0-utxo-mode', 'unconfirmed');
  await page.waitForTimeout(100);
  await checkEl('width edit: UTXO guard note fits (unconfirmed)', '#edit-rule-0-trigger-utxo-note');
  await page.selectOption('#edit-rule-0-trigger', 'checkin');
  await page.waitForTimeout(100);
  await checkInput('width edit: check-in days input fits', '#edit-rule-0-threshold');
  await checkEl('width edit: check-in row fits', '#edit-rule-0-trigger-checkin-row .inline-unit');
  // The Edit fallback note shows only for Pending + Slipstream; reveal it
  // and its row, then check it wraps.
  await page.evaluate(() => {
    const row = document.querySelector('#edit-fallback-row');
    if (row) row.style.display = '';
    const el = document.querySelector('#edit-fallback-note');
    if (el) el.style.display = '';
  });
  await checkEl('width edit: fallback deadline note fits', '#edit-fallback-note');
  // Locked note (shown for a broadcasted tx — reveal it directly).
  await page.evaluate(() => {
    const el = document.querySelector('#edit-locked-note');
    if (el) el.style.display = '';
  });
  await checkEl('width edit: locked note fits', '#edit-locked-note');
  // The Edit message line, with a long txid in it.
  await page.evaluate(() => {
    const el = document.querySelector('#edit-msg');
    if (el) el.textContent = 'Transaction updated. TXID ' + 'b'.repeat(64) + '.';
  });
  await checkEl('width edit: message line with a 64-hex txid fits', '#edit-msg');
  await page.evaluate(() => {
    const x = document.querySelector('#edit-modal-x');
    if (x) x.click();
  });
  await page.waitForTimeout(200);

  // --- Settings: BTC price sources ---
  // Both selects, the 5% note and the last-price lines fit at 390px.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tabs button')].find((x) => x.dataset.tab === 'settings');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  await checkPage('width settings: document has no horizontal overflow');
  await checkInput('width settings: price Source 1 select fits', '#set-price-source1');
  await checkInput('width settings: price Source 2 select fits', '#set-price-source2');
  await checkEl('width settings: price sources note fits', '#price-sources-note');
  await checkEl('width settings: Source 1 row (name + status pill) fits', '#price-source1');
  await checkEl('width settings: Source 2 row (name + status pill) fits', '#price-source2');
  await checkEl('width settings: Source 1 status pill fits', '#price-source1-status');
  await checkEl('width settings: Source 2 status pill fits', '#price-source2-status');
  // One Test connection button, right of Save; results land on the rows.
  await checkEl('width settings: Save price sources button fits', '#btn-save-price-sources');
  await checkEl('width settings: Test connection button fits', '#btn-test-price-sources');
  // Rows read name, price and pill; fill row 1 with the longest provider
  // label and a price, then check both fit.
  await page.evaluate(() => {
    const r = document.querySelector('#price-source1');
    if (r) r.textContent = 'Binance US (USDT)';
    const p = document.querySelector('#price-source1-price');
    if (p) p.textContent = '$98,200';
    const p2 = document.querySelector('#price-source2-price');
    if (p2) p2.textContent = '$98,200';
  });
  await checkEl('width settings: Source 1 row (name + pill + price) fits', '#price-source1-row');
  await checkEl('width settings: Source 2 row (name + pill + price) fits', '#price-source2-row');

  // --- Settings: price agreement, check cadence, fee verdict ---
  // Each card's input, unit, explainer and Save fit at 390px.
  await checkPage('width settings: document has no horizontal overflow (user controls)');
  await checkInput('width settings: price agreement input fits', '#set-price-agreement');
  await checkEl('width settings: price agreement row (input + % unit) fits', '#set-price-agreement-row');
  await checkEl('width settings: Save price agreement button fits', '#btn-save-price-agreement');
  await checkInput('width settings: check cadence input fits', '#set-check-cadence');
  await checkEl('width settings: check cadence row (input + seconds unit) fits', '#set-check-cadence-row');
  await checkEl('width settings: Save check cadence button fits', '#btn-save-check-cadence');
  await checkInput('width settings: fee Low input fits', '#set-fee-low');
  await checkInput('width settings: fee Medium input fits', '#set-fee-medium');
  await checkEl('width settings: fee Low row (input + x peak tx fee unit) fits', '#set-fee-low-row');
  await checkEl('width settings: fee Medium row (input + x peak tx fee unit) fits', '#set-fee-medium-row');
  await checkEl('width settings: fee zone bar fits', '#zone-bar');
  await checkEl('width settings: Save fee verdict button fits', '#btn-save-fee-verdict');
  // Fill the msg lines with an error (the longest case) before measuring.
  await page.evaluate(() => {
    for (const [id, text] of [
      ['price-agreement-msg', 'priceAgreementPct must be a number between 1 and 20'],
      ['check-cadence-msg', 'checkCadenceSeconds must be a number between 10 and 3600'],
      ['fee-verdict-msg', 'feeLowMultiplier must be greater than feeMediumMultiplier'],
    ]) {
      const s = document.querySelector('#' + id);
      if (s) s.textContent = text;
    }
  });
  await checkEl('width settings: price agreement msg line fits', '#price-agreement-msg');
  await checkEl('width settings: check cadence msg line fits', '#check-cadence-msg');
  await checkEl('width settings: fee verdict msg line fits', '#fee-verdict-msg');

  // --- Settings: vacation and Global Arm/Disarm ---
  // Measured by their h2 text (no ids); everything fits at 390px.
  async function cardByHeading(heading) {
    return await page.evaluate((h) => {
      const card = [...document.querySelectorAll('#tab-settings .card')].find((c) => {
        const h2 = c.querySelector('h2');
        return h2 && h2.textContent === h;
      });
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { sw: card.scrollWidth, cw: card.clientWidth, right: Math.round(r.right * 10) / 10, visible: r.width > 0 };
    }, heading);
  }
  async function checkCard(name, heading) {
    const m = await cardByHeading(heading);
    const f = fits(m, name);
    check(name, f.ok, f.why);
  }
  await checkCard('width settings: Vacation mode card fits', 'Vacation mode');
  await checkCard('width settings: Global Arm/Disarm card fits', 'Global Arm/Disarm');
  await checkInput('width settings: vacation until date input fits', '#set-vacation-until');
  await checkEl('width settings: Save vacation button fits', '#btn-save-vacation');
  await checkEl('width settings: Arm all button fits', '#btn-arm-all');
  await checkEl('width settings: Disarm all button fits', '#btn-disarm-all');
  // The msg lines are empty until a Save is run, so give them
  // realistic content first, then check they fit at 390px.
  await page.evaluate(() => {
    for (const [id, text] of [
      ['vacation-msg', 'Vacation settings saved.'],
      ['arm-all-msg', 'All transactions disarmed.'],
    ]) {
      const s = document.querySelector('#' + id);
      if (s) s.textContent = text;
    }
  });
  await checkEl('width settings: vacation msg line fits', '#vacation-msg');
  await checkEl('width settings: arm-all msg line fits', '#arm-all-msg');
  await checkPage('width settings: document has no horizontal overflow (vacation + arm/disarm)');

  // --- Tab bar ---
  // At phone width the tabs are a bar fixed along the bottom of the
  // screen (icons over labels), above the content, with an opaque
  // background; the page leaves room at the bottom so its last lines are
  // not hidden behind it. The appbar stays sticky at the top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const tabBar = await page.evaluate(() => {
    const main = document.querySelector('main');
    const tabs = document.querySelector('nav.tabs');
    const appbar = document.querySelector('header.appbar');
    if (!main || !tabs || !appbar) return null;
    const csMain = getComputedStyle(main);
    const csTabs = getComputedStyle(tabs);
    const csBar = getComputedStyle(appbar);
    const tr = tabs.getBoundingClientRect();
    return {
      mainPadBottom: parseFloat(csMain.paddingBottom),
      tabsPosition: csTabs.position, tabsZ: Number(csTabs.zIndex), tabsBg: csTabs.backgroundColor,
      tabsBottom: Math.round(tr.bottom * 10) / 10, tabsHeight: Math.round(tr.height), tabsLeft: Math.round(tr.left), tabsWidth: Math.round(tr.width),
      viewH: window.innerHeight, viewW: window.innerWidth,
      appbarPosition: csBar.position, appbarTop: csBar.top, appbarZ: Number(csBar.zIndex),
      iconsShown: [...tabs.querySelectorAll('button svg')].filter((x) => getComputedStyle(x).display !== 'none').length,
    };
  });
  check('width tabs: at 390px nav.tabs is fixed along the bottom of the screen, full width',
    !!tabBar && tabBar.tabsPosition === 'fixed' && Math.abs(tabBar.tabsBottom - tabBar.viewH) <= 1 && tabBar.tabsLeft === 0 && tabBar.tabsWidth === tabBar.viewW,
    tabBar ? 'position=' + tabBar.tabsPosition + ' bottom=' + tabBar.tabsBottom + '/' + tabBar.viewH + ' left=' + tabBar.tabsLeft + ' width=' + tabBar.tabsWidth : 'no main/tabs/appbar');
  check('width tabs: the bottom bar has an opaque background and sits above the content (z-index > 0)',
    !!tabBar && /^rgb\(/.test(tabBar.tabsBg) && tabBar.tabsZ > 0,
    tabBar ? 'background=' + tabBar.tabsBg + ' z=' + tabBar.tabsZ : 'no tabs');
  check('width tabs: the page leaves room at the bottom for the bar (main bottom padding >= bar height)',
    !!tabBar && tabBar.mainPadBottom >= tabBar.tabsHeight,
    tabBar ? 'padding=' + tabBar.mainPadBottom + ' bar=' + tabBar.tabsHeight : 'no main');
  check('width tabs: every tab shows its icon on a phone',
    !!tabBar && tabBar.iconsShown === 4, tabBar ? 'icons=' + tabBar.iconsShown : 'no tabs');
  check('width tabs: the appbar is still sticky at top 0, above the tab bar',
    !!tabBar && tabBar.appbarPosition === 'sticky' && tabBar.appbarTop === '0px' && tabBar.appbarZ > tabBar.tabsZ,
    tabBar ? 'position=' + tabBar.appbarPosition + ' top=' + tabBar.appbarTop + ' z=' + tabBar.appbarZ : 'no appbar');
  // All four tabs on one row, equal widths.
  const tabRows = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('nav.tabs button')];
    if (btns.length !== 4) return null;
    const tops = btns.map((b) => Math.round(b.getBoundingClientRect().top));
    const widths = btns.map((b) => Math.round(b.getBoundingClientRect().width));
    return { tops, rows: new Set(tops).size, widths, spread: Math.max(...widths) - Math.min(...widths) };
  });
  check('width tabs: all four tabs fit on one row at 390px, equal widths',
    !!tabRows && tabRows.rows === 1 && tabRows.spread <= 1,
    tabRows ? 'tops=' + JSON.stringify(tabRows.tops) + ' widths=' + JSON.stringify(tabRows.widths) : 'no tabs');
  // Scrolled down, the bar stays put at the bottom.
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(400);
  const tabBarScrolled = await page.evaluate(() => {
    const tabs = document.querySelector('nav.tabs');
    if (!tabs) return null;
    const tr = tabs.getBoundingClientRect();
    return { scrollY: Math.round(window.scrollY), tabsBottom: Math.round(tr.bottom * 10) / 10, viewH: window.innerHeight };
  });
  check('width tabs: scrolled 800px, the page actually scrolled',
    !!tabBarScrolled && tabBarScrolled.scrollY >= 700, tabBarScrolled ? 'scrollY=' + tabBarScrolled.scrollY : 'no tabs');
  check('width tabs: scrolled, the tab bar stays along the bottom of the screen',
    !!tabBarScrolled && Math.abs(tabBarScrolled.tabsBottom - tabBarScrolled.viewH) <= 1,
    tabBarScrolled ? 'bottom=' + tabBarScrolled.tabsBottom + '/' + tabBarScrolled.viewH : 'no tabs');
  await checkPage('width tabs: document has no horizontal overflow with the bottom tab bar');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  // --- Settings "?" buttons ---
  // One per card at the header's right: fits, does not overlap the
  // heading, stays a small circle.
  const HELP_KEYS_W = ['vacation', 'arm', 'nodes', 'price-sources', 'grace', 'agreement', 'cadence', 'fee', 'keys', 'backup'];
  for (const k of HELP_KEYS_W) await checkEl('width help: the "?" button fits on the ' + k + ' card', '#help-' + k);
  const helpLayout = await page.evaluate(() => {
    const keys = ['vacation', 'arm', 'nodes', 'price-sources', 'grace', 'agreement', 'cadence', 'fee', 'keys', 'backup'];
    const bad = [];
    for (const k of keys) {
      const btn = document.getElementById('help-' + k);
      if (!btn) { bad.push(k + ': missing'); continue; }
      const card = btn.closest('.card');
      const h2 = card ? card.querySelector('h2') : null;
      const br = btn.getBoundingClientRect();
      const hr = h2 ? h2.getBoundingClientRect() : null;
      const cs = getComputedStyle(btn);
      if (br.width < 20 || br.width > 30 || br.height < 20 || br.height > 30) bad.push(k + ': button ' + Math.round(br.width) + 'x' + Math.round(br.height));
      if (hr && br.left < hr.right - 1) bad.push(k + ': button overlaps the heading');
      if (hr && Math.abs(br.top - hr.top) > 4) bad.push(k + ': button not aligned with the heading');
      if (cs.position === 'absolute' || cs.position === 'fixed') bad.push(k + ': button is positioned, not in flow');
    }
    return bad;
  });
  check('width help: every "?" button is a small circle in the header row, right of its heading, no overlap',
    helpLayout.length === 0, helpLayout.join('; ') || 'all ten OK');
  await checkPage('width help: document has no horizontal overflow with the "?" buttons');

  // --- Settings filter ---
  // One row at the top: fits without wrapping, overflowing or overlapping
  // the first card.
  await checkEl('width filter: the dropdown fits', '#filter-select');
  await checkEl('width filter: the filter row fits', '#settings-filter');
  const filterLayout = await page.evaluate(() => {
    const row = document.getElementById('settings-filter');
    if (!row) return null;
    const rr = row.getBoundingClientRect();
    const first = document.getElementById('card-vacation');
    const fr = first ? first.getBoundingClientRect() : null;
    const sel = document.getElementById('filter-select');
    const sr = sel ? sel.getBoundingClientRect() : null;
    return {
      rowRight: Math.round(rr.right), rowBottom: Math.round(rr.bottom),
      rowHeight: Math.round(rr.height),
      firstCardTop: fr ? Math.round(fr.top) : null,
      selectRight: sr ? Math.round(sr.right) : null,
      selectBottom: sr ? Math.round(sr.bottom) : null,
      viewportWidth: window.innerWidth,
    };
  });
  check('width filter: the dropdown stays inside the 390px viewport on one row',
    !!filterLayout && filterLayout.selectRight <= 390 && filterLayout.rowRight <= 390 && filterLayout.rowHeight <= 60,
    JSON.stringify(filterLayout));
  check('width filter: the row sits above the first card with a gap (no overlap)',
    !!filterLayout && filterLayout.firstCardTop !== null && filterLayout.rowBottom < filterLayout.firstCardTop,
    JSON.stringify(filterLayout));
  await checkPage('width filter: document has no horizontal overflow with the filter row');

  // --- Dashboard tab: the Exchange Status section (0.8.0) ---
  // The launcher seeds a Dom Price tx, so the section is visible.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#tabs button')].find((x) => x.dataset.tab === 'dashboard');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  // --- Dashboard: Getting Started ---
  // Hidden while txs are staged, so reveal it; its centered layout and
  // button fit at 390px.
  await page.evaluate(() => {
    const el = document.getElementById('getting-started-card');
    if (el) el.style.display = '';
  });
  await page.waitForTimeout(200);
  const gsVisible = await page.evaluate(() => {
    const el = document.getElementById('getting-started-card');
    if (!el) return { visible: false, text: '' };
    const r = el.getBoundingClientRect();
    return { visible: r.height > 0, text: el.textContent || '' };
  });
  check('width dashboard: the Getting Started card is revealed for measurement (title present)',
    gsVisible.visible && gsVisible.text.indexOf('Getting Started') !== -1, 'visible=' + gsVisible.visible);
  await checkEl('width dashboard: Getting Started card fits', '#getting-started-card');
  await checkEl('width dashboard: Getting Started button fits', '#btn-getting-started-add');
  const gsLayout = await page.evaluate(() => {
    const card = document.getElementById('getting-started-card');
    const btn = document.getElementById('btn-getting-started-add');
    if (!card || !btn) return null;
    const br = btn.getBoundingClientRect();
    return { btnWidth: Math.round(br.width * 10) / 10, textAlign: getComputedStyle(card).textAlign };
  });
  check('width dashboard: the Getting Started button is full-width (width > 300 at 390px)',
    !!gsLayout && gsLayout.btnWidth > 300, gsLayout ? 'btnWidth=' + gsLayout.btnWidth : 'no card/button');
  check('width dashboard: the Getting Started card is centered (text-align center)',
    !!gsLayout && gsLayout.textAlign === 'center', gsLayout ? 'textAlign=' + gsLayout.textAlign : 'no card');
  await checkPage('width dashboard: document has no horizontal overflow with the Getting Started card shown');
  // Hide it again so the grace card + readiness checks measure
  // the dashboard as the DOM check left it.
  await page.evaluate(() => {
    const el = document.getElementById('getting-started-card');
    if (el) el.style.display = 'none';
  });
  await page.waitForTimeout(200);
  // --- Dashboard: Grace period ---
  // The DOM check leaves a grace active; title, text, button and note fit
  // at 390px.
  const graceVisible = await page.evaluate(() => {
    const el = document.getElementById('grace-card');
    if (!el) return { visible: false, text: '' };
    const r = el.getBoundingClientRect();
    return { visible: r.height > 0, text: el.textContent || '' };
  });
  check('width dashboard: the grace card is visible (the DOM check left a grace active)',
    graceVisible.visible, 'visible=' + graceVisible.visible + ' text=' + (graceVisible.text || '').slice(0, 80));
  await checkEl('width dashboard: grace card fits', '#grace-card');
  await checkEl('width dashboard: grace card Resume button fits', '#btn-resume-grace');
  await checkEl('width dashboard: Exchange Status section fits', '#readiness-exchange-item');
  // One row per exchange: price in muted text left of the pill, the pill
  // pinned right.
  await checkEl('width dashboard: Exchange Status CoinGecko row fits', '#readiness-exchange-1');
  await checkEl('width dashboard: Exchange Status Coinbase row fits', '#readiness-exchange-2');
  await checkEl('width dashboard: Node Status primary row checked time fits', '#readiness-primary-checked');
  await checkEl('width dashboard: Node Status secondary row checked time fits', '#readiness-secondary-checked');
  // A long node name is cut to one line with "…" (full name in the title).
  const longName = await page.evaluate(() => {
    const el = document.getElementById('readiness-primary');
    const keep = el.textContent;
    el.textContent = 'a-very-long-bitcoin-node-hostname.example.local:8332 \u00b7 RPC';
    const cs = getComputedStyle(el);
    const row = el.parentNode.getBoundingClientRect();
    const pill = document.getElementById('readiness-primary-status').getBoundingClientRect();
    const out = { nowrap: cs.whiteSpace === 'nowrap', ellipsis: cs.textOverflow === 'ellipsis', cut: el.scrollWidth > el.clientWidth,
      oneLine: row.height < pill.height * 1.8, pillInside: pill.right <= row.right + 1, title: !!el.title };
    el.textContent = keep;
    return out;
  });
  check('width dashboard: a long node name stays on one line, cut with an ellipsis, the pill still in the row',
    longName.nowrap && longName.ellipsis && longName.cut && longName.oneLine && longName.pillInside && longName.title, JSON.stringify(longName));
  await checkEl('width dashboard: Exchange Status CoinGecko row pill fits', '#readiness-exchange-1-status');
  await checkEl('width dashboard: Exchange Status Coinbase row pill fits', '#readiness-exchange-2-status');
  await checkEl('width dashboard: Exchange Status CoinGecko row price fits', '#readiness-exchange-1-price');
  await checkEl('width dashboard: Exchange Status Coinbase row price fits', '#readiness-exchange-2-price');
  // --- Exchange vs Node alignment ---
  // All four status pills share one right-edge x position.
  const align = await page.evaluate(() => {
    const out = {};
    for (const id of ['readiness-primary-status', 'readiness-secondary-status', 'readiness-exchange-1-status', 'readiness-exchange-1-price', 'readiness-exchange-2-status', 'readiness-exchange-2-price']) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      const r = el.getBoundingClientRect();
      out[id] = { right: Math.round(r.right * 10) / 10, left: Math.round(r.left * 10) / 10, text: el.textContent };
    }
    return out;
  });
  const alignRights = ['readiness-primary-status', 'readiness-secondary-status', 'readiness-exchange-1-status', 'readiness-exchange-2-status'].map((id) => align[id]).filter((v) => v !== null).map((v) => v.right);
  const alignOk = alignRights.length === 4 && Math.max(...alignRights) - Math.min(...alignRights) <= 1;
  check('width dashboard: Exchange row pills share the Node pills\' right edge (one aligned column)',
    alignOk,
    'rights=' + JSON.stringify(align));
  check('width dashboard: Exchange row pills are right-aligned (their right edge is at the card edge, not next to the label)',
    align['readiness-exchange-1-status'] !== null && align['readiness-exchange-2-status'] !== null
      && align['readiness-exchange-1-status'].right > 300 && align['readiness-exchange-2-status'].right > 300,
    'exchange rights=' + (align['readiness-exchange-1-status'] ? align['readiness-exchange-1-status'].right : 'null') + '/' + (align['readiness-exchange-2-status'] ? align['readiness-exchange-2-status'].right : 'null'));
  check('width dashboard: Exchange price sits to the left of its pill (CoinGecko row)',
    align['readiness-exchange-1-price'] !== null && align['readiness-exchange-1-status'] !== null
      && align['readiness-exchange-1-price'].right <= align['readiness-exchange-1-status'].left,
    'price right=' + (align['readiness-exchange-1-price'] ? align['readiness-exchange-1-price'].right : 'null') + ' pill left=' + (align['readiness-exchange-1-status'] ? align['readiness-exchange-1-status'].left : 'null'));
  check('width dashboard: Exchange price sits to the left of its pill (Coinbase row)',
    align['readiness-exchange-2-price'] !== null && align['readiness-exchange-2-status'] !== null
      && align['readiness-exchange-2-price'].right <= align['readiness-exchange-2-status'].left,
    'price right=' + (align['readiness-exchange-2-price'] ? align['readiness-exchange-2-price'].right : 'null') + ' pill left=' + (align['readiness-exchange-2-status'] ? align['readiness-exchange-2-status'].left : 'null'));

  // --- Readiness rows stay one line ---
  // Under 30px tall (two lines are ~46px); the long label truncates with
  // an ellipsis.
  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.readiness-tx-row').forEach((row) => {
      const r = row.getBoundingClientRect();
      const label = row.querySelector('b');
      const pill = row.querySelector('.pill');
      const pr = pill ? pill.getBoundingClientRect() : null;
      const cs = label ? getComputedStyle(label) : null;
      out.push({
        label: label ? label.textContent : '',
        height: Math.round(r.height * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        pillTopDelta: pr ? Math.round((pr.top - r.top) * 10) / 10 : null,
        pillText: pill ? pill.textContent : '',
        textOverflow: cs ? cs.textOverflow : '',
        whiteSpace: cs ? cs.whiteSpace : '',
        truncated: label ? label.scrollWidth > label.clientWidth : false,
      });
    });
    return out;
  });
  check('width dashboard: readiness list has at least 7 rows (4 seeded + 2 pill + long-label; the 3 section-8 UTXO txs broadcast and leave the list)', rows.length >= 7, 'rows=' + rows.length);
  const badRows = rows.filter((x) => x.height > 30 || x.pillTopDelta === null || x.pillTopDelta > 3 || x.right > 390);
  check('width dashboard: every readiness row is a single line at 390px (height <= 30, status pill on the first line, right edge <= 390)',
    rows.length > 0 && badRows.length === 0,
    badRows.length ? JSON.stringify(badRows.slice(0, 3)) : 'rows=' + rows.length + ', heights=' + rows.map((x) => x.height).join(','));
  const longRow = rows.find((x) => x.label.indexOf('A very long transaction label') === 0);
  check('width dashboard: the long-label readiness row exists', !!longRow, longRow ? longRow.label.slice(0, 40) : 'not found');
  check('width dashboard: the long label is truncated with an ellipsis (scrollWidth > clientWidth, text-overflow ellipsis, white-space nowrap)',
    !!longRow && longRow.truncated && longRow.textOverflow === 'ellipsis' && longRow.whiteSpace === 'nowrap',
    longRow ? 'truncated=' + longRow.truncated + ' textOverflow=' + longRow.textOverflow + ' whiteSpace=' + longRow.whiteSpace : 'no long row');
  check('width dashboard: the long-label row is still a single line with its status pill on it',
    !!longRow && longRow.height <= 30 && longRow.pillTopDelta !== null && longRow.pillTopDelta <= 3 && longRow.pillText !== '',
    longRow ? 'height=' + longRow.height + ' pillTopDelta=' + longRow.pillTopDelta + ' pill=' + longRow.pillText : 'no long row');
  // The seeded Dom Price row still carries its fee pill.
  const feePills = await page.evaluate(() => document.querySelectorAll('.readiness-tx-row .pill.fee-pill').length);
  check('width dashboard: a fee-verdict pill is still present on a readiness row', feePills >= 1, 'fee pills=' + feePills);

  await browser.close();
  console.log();
  console.log('FAILURES: ' + failures.length + (failures.length ? ' ' + JSON.stringify(failures) : ' (none)'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
