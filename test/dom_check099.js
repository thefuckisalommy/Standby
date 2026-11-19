// Standby 0.8.2 DOM checks — block-height, set-date, and fee-market triggers.
// Runs public/app.js from branch-0.8.4 in Node with the
// minimal DOM shim from dom_check094.js (same El class, same
// document/window/fetch/setInterval stubs) and verifies the 0.8.0
// trigger UI only — the 094 suite still owns everything else.
//   - each tx card renders a .tx-trigger subcard right after the
//     amount and before Details. Every subcard is exactly 3 rows,
//     one line each: "TRIGGER - <TYPE>", the condition ("Fires
//     when ...", or "Never fires — manual only"), and the current
//     state — for price "BTC price currently $98,200" (the
//     effective price only, no source note), for check-in "N of
//     35 days since last check-in", for UTXO "still unspent" (or
//     spent + confirmations), for manual "Waiting for manual
//     broadcast". The state comes from tx.triggerStatus
//   - the readiness card renders one .readiness-tx block per active
//     tx: label + status pill (+ fee pill) on one line — the label
//     truncates with an ellipsis so the status never wraps — with
//     the tx card's condition summary on the line underneath
//     ("Fires when ..."), and NO trigger-type mode pill
//   - the per-exchange rows sit in a .node-lines container, the
//     same class/structure as the Node Status rows, so their
//     status pills are pinned to the same right edge (the width
//     check proves the x positions match at 390px)
//   - the check-in card has no "Liveness trigger" line (removed)
//   - the check-in card shows one bar per ACTIVE check-in tx
//     (label + bar + "X of N days elapsed", each at its own
//     threshold), no big countdown, no "until check-in triggered
//     transactions are broadcast" line, no "Next check-in due"
//     row and no total check-ins count; a held clock shows the
//     longer window on the bar with no "Grace period" text; the
//     shared Check in button resets every bar to 0 days elapsed;
//     a DISARMED check-in tx keeps its bar, frozen at the day
//     count it was left at (muted grey, marked disarmed) —
//     disarming never hides the card while a check-in tx is
//     still active
//   - the global broadcast threshold is gone: no threshold input
//     on the Settings page and PUT /api/settings with
//     thresholdDays is a 400 (the API suite owns that check)
//   - Fee and Broadcast via live inside Details (collapsed) on
//     every card, NOT on the card face
//   - the check-in card renders only when a check-in tx uses
//     the check-in trigger (or there are no txs at all); a
//     disarmed check-in tx keeps a frozen bar and the card stays
//     visible — disarming the only check-in tx no longer hides
//     it (the freeze redesign, 0.8.0)
//   - the Add form has a trigger picker (checkin/price/utxo/manual)
//     with one conditional row per type and guard notes naming the
//     two-source agreement price rule and the confirmed-only UTXO rule
//   - the status pill reads just "armed" for a healthy armed tx
//     (green), "Label + armed" for a genuine problem state, and
//     "unarmed" when disarmed; a shared-input overlap keeps the text
//     but turns the pill amber
//   - the grace period (0.8.0): a "Grace period active" card at the
//     top of the Dashboard (only while a grace is active for an
//     armed price or UTXO tx) with the offline days and the end date
//     bolded, a Resume now button, and the muted note; armed
//     price/UTXO cards read "Grace" on an amber pill instead of
//     "armed" (check-in/manual untouched, disarmed still "unarmed");
//     the Settings grace card has the two dropdowns (offline days to
//     trigger, how long it lasts, incl. indefinite) with Save; an
//     indefinite grace reads "until you resume" instead of a date
//   - the Getting Started card (0.8.0): an empty-state card at the
//     very top of the Dashboard, shown only when no transactions
//     are STAGED (active) — archived and pending do not count —
//     the first thing a fresh install sees — with Ryan's exact
//     copy and a full-width orange button that opens the Add
//     transaction popup (it never switches tabs or scrolls); it is
//     independent of the grace card (which needs armed price/UTXO
//     txs to show)
//   - the Add form is a popup (0.8.0): the inline "Add a
//     transaction" card at the bottom of the Transactions tab is
//     gone — three buttons open the same popup (Getting Started,
//     the "+ Add a pre-signed transaction" button at the bottom of
//     the Transactions tab, and the oval "+ Add Tx" in the Staged
//     Transactions header); "Broadcast all" is gone again —
//     restored Nov 16 at Ryan's word, then removed again the same
//     morning: he decided the button sits too close to the
//     "+ Add Tx" pill. (Broadcast armed stays.)
//   - the vacation card (0.8.0 redesign): check-in-only
//     language ("applies to check-in rules only", "the check-in
//     countdown freezes"), an indefinite option ("Until I say I'm
//     back"), and saving from the UI persists it; the Global
//     Arm/Disarm card (Arm all / Disarm all) replaces the old
//     Pause / resume card, which is gone entirely (no pause
//     button, pill, or 'Paused' state anywhere)
//   - every Settings card (0.8.0) has a "?" help button in its
//     header row; clicking it opens the shared showDetails
//     pop-out with the setting's title, what it does, and an
//     "Applies to:" line naming the trigger types; the pop-out
//     closes via the Close button or the X
//   - the Settings tab (0.8.0) has a filter dropdown at the
//     top (All settings / General / Check-in Trigger / BTC Price
//     Trigger / UTXO Trigger) that reads the same triggers array
//     the "?" pop-out renders its "Applies to" line from — one
//     declaration per card, no second mapping — and the inline
//     description paragraphs are trimmed to the essentials
//     (at most one short hint line per card; the full text
//     lives in the "?" pop-out)
//   - a tx with a very long label still renders in the readiness
//     list (the width check proves the row stays one line with the
//     label truncated by ellipsis at 390px)
//   - the Edit popup's trigger picker populates from the tx
//   - the Settings "Bitcoin price source" card has two provider
//     selects (all five providers, defaulting to CoinGecko +
//     Coinbase), a note explaining the 5% agreement rule, the
//     directional choice and the single-source fallback, and a
//     per-source last-price display; saving a change persists it
//     (and the selects re-render with the new values)
//   - each price source row has a Test button that fetches the
//     selected provider fresh and shows the result inline
//     (success or failure)
//   - the readiness card shows the Exchange Status once (a single
//     consolidated OK / Degraded / Error pill, like Node Status)
//     and the per-price-tx readiness lines are trigger-only —
//     they do not repeat the exchange/source status. No subcard
//     carries a source note either; the source detail lives in
//     the Exchange Status section and in a dry run's notes (a
//     Dry-run on a price tx shows it in its line)
// The app instance under test is the one on :3438 (launcher data:
// 4 armed txs, one per trigger type, seeded via the API, one
// check-in, then one POST /api/release/check so the subcards show
// live statuses). setInterval is stubbed (captured, not scheduled)
// so the process can exit.
'use strict';
const fs = require('fs');
const BASE = 'http://127.0.0.1:3438';
const DATA_FILE = '/tmp/heirloom099-dom/state.json';
const els = {};
function elText(el) {
  // The shim stores textContent as a plain property — it does NOT
  // aggregate from children the way a real browser does. Read the
  // children's text when the element's own text is empty, so a row
  // built from a label span + a value span reads "Label: value".
  if (!el) return '';
  if (el.textContent) return el.textContent;
  return (el.children || []).map(elText).join('');
}
function cardTitle(card) {
  for (const c of card.children) {
    if (c.className === 'tx-head' && c.children.length) return c.children[0].textContent;
  }
  return null;
}
function cardButton(card, label) {
  for (const c of card.children) {
    if (c.className === 'tx-actions') {
      for (const b of c.children) { if (b.textContent === label) return b; }
    }
  }
  return null;
}
function cardStatus(card) {
  // the pill lives in the head row, top-right
  for (const c of card.children) {
    if (c.className === 'tx-head' && c.children.length) {
      for (const h of c.children) { if (h.className && h.className.split(' ')[0] === 'pill') return h; }
    }
  }
  return null;
}
function cardDetails(card) {
  for (const c of card.children) { if (c.className === 'tx-details') return c; }
  return null;
}
// Simulate a user toggling a <details> open/closed (0.7.18): the
// shim has no native <details> behaviour, so set .open by hand and
// fire the toggle listener the app attached, as a real browser
// would on a summary click.
function toggleDetails(el, open) {
  el.open = open;
  (el.listeners.toggle || []).forEach((f) => f({ target: el }));
}
// True when the card's Details element itself holds a direct child
// with the given class — i.e. the line lives INSIDE the Details
// rather than below the buttons on the card.
function detailsContains(card, cls) {
  const d = cardDetails(card);
  return !!d && d.children.some((x) => (x.className || '').split(' ').includes(cls));
}
// The index of a direct child of the card with the given class, or
// -1 — so a check can prove one line sits below another on the card.
function cardChildIndex(card, cls) {
  return card.children.findIndex((x) => (x.className || '').split(' ').includes(cls));
}
function listCards(id) {
  return (els[id] && els[id].children || []).filter((c) => c.className && c.className.split(' ').includes('tx-card'));
}
function txCards() {
  return listCards('btc-active-list').concat(listCards('btc-pending-list')).concat(listCards('btc-archived-list'));
}
function cardByTitle(title) {
  return txCards().find((c) => cardTitle(c) === title);
}
// --- 0.8.0 helpers ---
function triggerBox(card) {
  for (const c of card.children) { if (c.className === 'tx-trigger') return c; }
  return null;
}
function triggerParts(card) {
  // the subcard's three spans: the type key, the condition, the
  // live state (" — <reason>"). Null when the subcard is missing
  // or malformed. (0.8.2 v2) The key + pill read through the
  // .tx-trigger-head wrapper in the first span.
  const box = triggerBox(card);
  if (!box || box.children.length < 3) return null;
  const head = boxHeadParts(box);
  return {
    box,
    k: head.k,
    pill: head.pill,
    pillCls: head.pillCls,
    cond: box.children[1].textContent || '',
    now: box.children[2].textContent || '',
  };
}
// The card face: every direct child EXCEPT the <details> — the
// text a user sees without expanding anything.
function cardFaceText(card) {
  return card.children.filter((c) => c.className !== 'tx-details').map(elText).join(' ');
}
// The readiness blocks (0.8.0): one .readiness-tx per ACTIVE tx —
// a .readiness-tx-row (label <b> + trigger-mode pill + status pill
// + optional fee pill) and a .readiness-tx-state line underneath.
// The 094 readinessRows() helper does not fit this shape (it read
// a flat row), so this replaces it for 0.8.0.
function readinessBlocks() {
  const txs = els['readiness-txs'];
  if (!txs) return null;
  return txs.children
    .filter((b) => (b.className || '').split(' ').includes('readiness-tx'))
    .map((b) => {
      const row = b.children[0] || { children: [] };
      const state = b.children[1];
      return {
        // (0.8.0) The row is label + status pill (+ fee pill) —
        // there is NO trigger-type mode pill any more; the state
        // line is the tx card's condition summary ("Fires when ...").
        label: (row.children[0] || {}).textContent || '',
        status: (row.children[1] || {}).textContent || '',
        statusCls: (row.children[1] || {}).className || '',
        fee: (row.children[2] || {}).textContent || '',
        state: state ? (state.textContent || '') : '',
      };
    });
}
function readinessBlock(label) {
  const blocks = readinessBlocks();
  return blocks && blocks.find((x) => x.label === label);
}
// The per-tx check-in bars (0.8.0): one .ck-tx block per active
// check-in tx inside #checkin-tx-bars — label, bar fill width,
// "X of N days elapsed" caption, and the block's class (a
// disarmed tx's bar carries 'frozen').
function checkinBars() {
  const wrap = els['checkin-tx-bars'];
  if (!wrap) return null;
  return wrap.children
    .filter((b) => (b.className || '').split(' ').includes('ck-tx'))
    .map((b) => {
      const label = (b.children[0] || {}).textContent || '';
      const bar = b.children[1] || { children: [] };
      const fill = bar.children[0] || { style: {} };
      const cap = (b.children[2] || {}).textContent || '';
      return { label, width: parseFloat((fill.style || {}).width) || 0, caption: cap, cls: b.className || '' };
    });
}
function checkinBar(label) {
  const bars = checkinBars();
  return bars && bars.find((x) => x.label === label);
}
// A fresh page load: wipe the shim DOM and eval app.js again,
// exactly like the 094 seedClock helper (minus the state.json edit).
async function rerender(appJs) {
  for (const k of Object.keys(els)) delete els[k];
  global.__loadError = undefined;
  eval(appJs);
  await new Promise((r) => setTimeout(r, 900));
}
function fireChange(el) {
  (el.listeners.change || []).forEach((f) => f({ target: el }));
}
function fireInput(el) {
  (el.listeners.input || []).forEach((f) => f({ target: el }));
}
// The option values carried by a <select> in the served HTML, in
// order, or null when the select is missing.
function selectValues(html, id) {
  const start = html.indexOf('id="' + id + '"');
  if (start === -1) return null;
  const block = html.slice(start, html.indexOf('</select>', start));
  return [...block.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
}
// A minimal 1-in/1-out tx spending Finney vout 1 (the same shape
// as verify094.craft) — so the DOM test can add transactions via
// the API without importing the Python helpers.
function craftHex(vout, value) {
  const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
  const prev = Buffer.from(FINNEY, 'hex').reverse();
  const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(vout);
  const valBuf = Buffer.alloc(8); valBuf.writeBigUInt64LE(BigInt(value));
  const script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.alloc(20), Buffer.from([0x88, 0xac])]);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01]),
    prev, voutBuf, Buffer.from([0x00]), Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x01]),
    valBuf, Buffer.from([script.length]), script,
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]).toString('hex');
}
function craftLocktimeHex(vout, locktime, value) {
  // Same shape as craftHex, but with an explicit locktime and a
  // non-maxed sequence (0), so the locktime applies — mirrors
  // verify094.craft_locktime. A block-height locktime above the
  // stub tip (900000) makes the dry-run verdict 'timelocked'.
  const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
  const prev = Buffer.from(FINNEY, 'hex').reverse();
  const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(vout);
  const seqBuf = Buffer.alloc(4); seqBuf.writeUInt32LE(0);
  const valBuf = Buffer.alloc(8); valBuf.writeBigUInt64LE(BigInt(value));
  const script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.alloc(20), Buffer.from([0x88, 0xac])]);
  const lockBuf = Buffer.alloc(4); lockBuf.writeUInt32LE(locktime);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01]),
    prev, voutBuf, Buffer.from([0x00]), seqBuf,
    Buffer.from([0x01]),
    valBuf, Buffer.from([script.length]), script,
    lockBuf,
  ]).toString('hex');
}
function selectAddTrigger(v) {
  // (0.8.2) The Add form's first rule panel carries the type
  // select now — set it there and fire its change.
  const p = rulePanels('btc')[0];
  if (!p) return;
  const sel = panelTypeSelect(p);
  sel.value = v;
  fireChange(sel);
}
// --- 0.8.2 rule-list helpers ---
// The rule panels are built in JS, so they are NOT in the els
// registry — walk the list container's children instead. A
// panel's rows and fields are found by id within its subtree.
function rulePanels(prefix) {
  return (els[prefix + '-rules-list'] && els[prefix + '-rules-list'].children) || [];
}
function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of (root.children || [])) { const f = findById(c, id); if (f) return f; }
  return null;
}
function panelTypeSelect(panel) {
  return panel && panel.children.find((c) => c.tagName === 'SELECT');
}
function panelRemoveBtn(panel) {
  const head = panel && panel.children[0];
  return head && head.children[1];
}
function panelSelectValues(panel, selId) {
  const sel = findById(panel, selId);
  if (!sel) return null;
  return (sel.children || []).filter((c) => c.tagName === 'OPTION').map((o) => o.value);
}
// One option of a panel's type select, by value — so a check can
// read its disabled state and label (0.8.2 v2: used types are
// disabled and labelled "(already used)").
function panelOption(panel, value) {
  const sel = panelTypeSelect(panel);
  if (!sel) return null;
  return (sel.children || []).find((c) => c.tagName === 'OPTION' && c.value === value) || null;
}
function panelRowVisible(panel, rowId) {
  const row = findById(panel, rowId);
  return !!(row && row.style.display !== 'none');
}
// Every .tx-trigger box on a card, in order — a one-rule card
// has exactly one, a multi-rule card one per rule.
function triggerBoxes(card) {
  return card.children.filter((c) => c.className === 'tx-trigger');
}
// The subcard header (0.8.2 v2): a .tx-trigger-head flex row
// holding the type key + the per-rule state pill (no pill on a
// manual rule). k and pill read through the wrapper.
function boxHeadParts(box) {
  const head = box && box.children[0];
  if (!head || !(head.className || '').split(' ').includes('tx-trigger-head')) return { k: '', pill: null, pillCls: null };
  const pillEl = head.children[1];
  return {
    k: (head.children[0] && head.children[0].textContent) || '',
    pill: pillEl ? (pillEl.textContent || '') : null,
    pillCls: pillEl ? (pillEl.className || '') : null,
  };
}
function boxParts(box) {
  if (!box || box.children.length < 3) return null;
  const head = boxHeadParts(box);
  return {
    k: head.k,
    pill: head.pill,
    pillCls: head.pillCls,
    cond: box.children[1].textContent || '',
    now: box.children[2].textContent || '',
  };
}
// The AND/OR combination line above a multi-rule card's
// subcards, or null for a one-rule card.
function comboLine(card) {
  const c = card.children.find((x) => (x.className || '').split(' ').includes('tx-rules-combo'));
  return c ? elText(c) : null;
}

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.classList = {
      _s: new Set(),
      toggle: (c, on) => { if (on === undefined) on = !this.classList._s.has(c); on ? this.classList._s.add(c) : this.classList._s.delete(c); },
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
    };
    this.textContent = '';
    this._html = '';
    Object.defineProperty(this, 'innerHTML', {
      get() { return this._html; },
      set(v) {
        this._html = v;
        if (this.tagName === 'TR') {
          const n = (String(v).match(/<td/g) || []).length;
          this.children = Array.from({ length: n }, () => new El('td'));
        } else if (!String(v)) {
          this.children = [];
        }
      },
      configurable: true,
    });
    this.value = '';
    this.checked = false;
    this.className = '';
    this.id = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  setAttribute() {}
  focus() {}
  scrollIntoView() { this.__scrolledIntoView = true; }
  select() { this.__selected = true; }
  click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault: function () {} })); }
  change() { (this.listeners.change || []).forEach((f) => f({ target: this, preventDefault: function () {} })); }
  fire(ev) { (this.listeners[ev] || []).forEach((f) => f({ target: this, preventDefault: function () {} })); }
  closest() { return this; }
  querySelectorAll() { return []; }
}

// The tab bar, the tab sections and the burger links, modelled so
// the app's tab code has something to switch (copied from 094).
function tabModels() {
  if (!els.__tabbtn) {
    els.__tabbtn = {};
    els.__tabsec = {};
    els.__burger = {};
    ['dashboard', 'bitcoin', 'settings', 'logs'].forEach(function (t) {
      var b = new El('button');
      b.dataset.tab = t;
      if (t === 'dashboard') b.classList.add('active');
      els.__tabbtn[t] = b;
      var s = new El('section');
      s.id = 'tab-' + t;
      if (t === 'dashboard') s.classList.add('active');
      els.__tabsec[t] = s;
      var a = new El('a');
      a.dataset.tabLink = t;
      els.__burger[t] = a;
    });
  }
  return els;
}
function tabEls() {
  tabModels();
  return Object.values(els.__tabbtn);
}
function tabSections() {
  tabModels();
  return Object.values(els.__tabsec);
}

global.document = {
  getElementById: (id) => els[id] || (els[id] = Object.assign(new El('div'), { id })),
  querySelector: (sel) => (sel === 'main' ? Object.assign(new El('main'), { insertAdjacentHTML: (pos, html) => { global.__loadError = html; } }) : new El('div')),
  querySelectorAll: (sel) => {
    if (sel === '#tabs button') return tabEls();
    if (sel === 'section.tab') return tabSections();
    if (sel === '#burger-menu a[data-tab-link]') { tabModels(); return Object.values(els.__burger); }
    return [];
  },
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
  execCommand: () => true,
  body: new El('body'),
};
global.window = {
  location: { hostname: '127.0.0.1', hash: '' },
  addEventListener: function (ev, fn) { if (ev === 'hashchange') global.__hashchange = fn; },
};
global.Blob = class { constructor(parts) { this.parts = parts || []; } };
global.URL.createObjectURL = (b) => { global.__capturedBlob = b; return 'blob:test'; };
global.URL.revokeObjectURL = () => {};
global.FileReader = class {
  readAsText(f) { this.result = (f && f.__content) || ''; if (this.onload) this.onload(); }
  readAsArrayBuffer(f) { const s = (f && f.__content) || ''; this.result = new TextEncoder().encode(s).buffer; if (this.onload) this.onload(); }
};
const realFetch = fetch;
global.fetch = (path, opts) => realFetch(BASE + path, opts);
// The 60s confirmations poll: capture the callback, do not schedule it
// (a live interval would keep this process alive after the checks).
global.setInterval = (fn) => { global.__pollFn = fn; return 0; };
global.clearInterval = () => {};

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL'), '-', name, cond ? '' : '| ' + String(detail).slice(0, 200));
  if (!cond) failures.push(name);
}

(async () => {
  const appJs = await realFetch(BASE + '/app.js').then((r) => r.text());
  const idx = await realFetch(BASE + '/').then((r) => r.text());
  eval(appJs);
  await new Promise((r) => setTimeout(r, 900)); // load() fetches state + renders
  const st0 = await (await fetch('/api/state')).json();
  const checkinId = ((st0.bitcoin.txs || []).find((t) => t.label === 'Dom Check-in') || {}).id;

  check('load completed (no load error)', !global.__loadError, global.__loadError || '');
  check('no global threshold: the Settings page has no threshold input (static HTML)',
    idx.indexOf('id="set-threshold"') === -1 && idx.indexOf('Broadcast Threshold') === -1, '');
  check('no global threshold: no Save-settings button for it (static HTML)',
    idx.indexOf('id="btn-save-settings"') === -1, '');
  const cards0 = txCards();
  check('each seeded transaction rendered as its own card (7 txs)', cards0.length === 7, 'cards found: ' + cards0.length);
  // Static HTML: the check-in card's heading. (The "Liveness
  // trigger" muted line was removed — it must not appear.)
  const ccIdx = idx.indexOf('id="checkin-card"');
  const ccBlock = ccIdx === -1 ? '' : idx.slice(ccIdx, ccIdx + 600);
  check('check-in card static: h2 reads Check-in', ccBlock.indexOf('<h2>Check-in</h2>') !== -1, ccBlock.slice(0, 200));
  check('check-in card static: the "Liveness trigger" line is gone', ccBlock.indexOf('Liveness trigger') === -1, ccBlock.slice(0, 300));
  check('check-in card static: the "until check-in triggered transactions are broadcast" line is gone',
    idx.indexOf('until check-in triggered transactions are broadcast') === -1, '');
  check('check-in card static: the big countdown is gone (no #checkin-countdown)',
    idx.indexOf('id="checkin-countdown"') === -1, '');
  check('check-in card static: the single progress bar is gone (no #checkin-progress)',
    idx.indexOf('id="checkin-progress"') === -1, '');
  check('check-in card static: no "Next check-in due" row (no #next-due)',
    idx.indexOf('id="next-due"') === -1, '');
  check('check-in card static: the per-tx bars container is present (#checkin-tx-bars)',
    idx.indexOf('id="checkin-tx-bars"') !== -1, '');
  check('check-in card static: no total check-ins count anywhere on the page',
    idx.indexOf('total') === -1, '');

  // --- 1. the trigger subcard on each of the seven cards ---
  // The condition for the UTXO card comes from the app's
  // triggerCondition (first 6 of the outpoint + '\u2026' + last 2):
  // the seeded outpoint is f4184fc5...e16:1, so 'f4184f\u2026:1'.
  const trigExpect = {
    'Dom Check-in': { k: 'TRIGGER - CHECK-IN', cond: 'Fires when you don\u2019t check in for 35 days', now: 'of 35 days since last check-in' },
    'Dom Price': { k: 'TRIGGER - BTC PRICE', cond: 'Fires when BTC price \u2265 $150,000', now: 'BTC price currently $98,200' },
    'Dom UTXO': { k: 'TRIGGER - UTXO', cond: 'Fires when UTXO f4184f\u2026:1 is spent', now: 'still unspent' },
    'Dom Manual': { k: 'TRIGGER - MANUAL', cond: 'Never fires \u2014 manual only', now: 'Waiting for manual broadcast' },
    'Dom Blockheight': { k: 'TRIGGER - BLOCK HEIGHT', cond: 'Fires when the chain reaches block 950,000', now: 'Chain at block 900,000 of 950,000' },
    'Dom Setdate': { k: 'TRIGGER - SET DATE', cond: 'Fires on Dec 31, 2029, 7:00 PM', now: 'fires on Dec 31, 2029, 7:00 PM' },
    'Dom Feemarket': { k: 'TRIGGER - FEE MARKET', cond: 'Fires when tx fees are <= 0.5 sat/vB', now: 'Economy fee currently 1 sat/vB' },
  };
  for (const label of Object.keys(trigExpect)) {
    const card = cardByTitle(label);
    const parts = card && triggerParts(card);
    const exp = trigExpect[label];
    check('trigger 0.8.0: "' + label + '" subcard has exactly 3 rows (header / condition / state)',
      !!parts && parts.box && parts.box.children.length === 3,
      parts ? 'children=' + parts.box.children.length : 'no subcard');
    check('trigger 0.8.0: "' + label + '" has the type label "' + exp.k + '"', !!parts && parts.k === exp.k, parts ? parts.k : 'no subcard');
    check('trigger 0.8.0: "' + label + '" condition reads "' + exp.cond + '"', !!parts && parts.cond === exp.cond, parts ? parts.cond : 'no subcard');
    check('trigger 0.8.0: "' + label + '" state line reads "' + exp.now + '"', !!parts && parts.now.indexOf(exp.now) !== -1, parts ? parts.now : 'no subcard');
  }
  check('trigger 0.8.0: the subcard sits after the amount and before Details on every card',
    cards0.length === 7 && cards0.every((c) => cardChildIndex(c, 'tx-amount') === 1 && cardChildIndex(c, 'tx-trigger') === 2 && cardChildIndex(c, 'tx-details') === 3),
    cards0.map((c) => cardChildIndex(c, 'tx-amount') + '/' + cardChildIndex(c, 'tx-trigger') + '/' + cardChildIndex(c, 'tx-details')).join(' '));

  // --- 2. the readiness card: one block per armed tx ---
  const blocks = readinessBlocks();
  check('readiness 0.8.1: seven .readiness-tx blocks (one per armed tx)', !!blocks && blocks.length === 7, blocks ? blocks.length : 'no readiness list');
  // There is NO trigger-type mode pill on a readiness row any
  // more — the state line is the tx card's condition summary
  // ("Fires when ..."), not a "[Type] Trigger:" line.
  // (A row is label + status pill + optional fee pill only.)
  check('readiness 0.8.0: no trigger-type mode pill on any row (label + status + optional fee only)',
    !!blocks && blocks.every((b) => b.status !== '' && !['Check-in', 'BTC Price', 'UTXO', 'Manual'].includes(b.status)),
    blocks ? blocks.map((b) => b.label + '=' + b.status).join(', ') : '');
  check('readiness 0.8.0: every state line is the tx card condition summary ("Fires when ...", "Fires on ...", or "Never fires — manual only")',
    !!blocks && blocks.every((b) => b.state.indexOf('Fires when ') === 0 || b.state.indexOf('Fires on ') === 0 || b.state.indexOf('Never fires ') === 0),
    blocks ? blocks.map((b) => b.label + '=' + b.state).join(' | ') : '');
  check('readiness 0.8.0: every row still carries its status pill',
    !!blocks && blocks.every((b) => b.status !== '' && (b.statusCls || '').split(' ')[0] === 'pill'),
    blocks ? blocks.map((b) => b.label + '=' + b.status).join(', ') : '');
  check('readiness 0.8.0: every row has a state line underneath',
    !!blocks && blocks.every((b) => b.state !== ''),
    blocks ? blocks.map((b) => b.label + '=' + b.state).join(', ') : '');
  // The state line is the tx card's condition summary — the same
  // text as the subcard's second row — one row per rule.
  const rbExpect = {
    'Dom Check-in': 'Fires when you don\u2019t check in for 35 days',
    'Dom Price': 'Fires when BTC price \u2265 $150,000',
    'Dom UTXO': 'Fires when UTXO f4184f\u2026:1 is spent',
    'Dom Manual': 'Never fires \u2014 manual only',
    'Dom Blockheight': 'Fires when the chain reaches block 950,000',
    'Dom Setdate': 'Fires on Dec 31, 2029, 7:00 PM',
    'Dom Feemarket': 'Fires when tx fees are <= 0.5 sat/vB',
  };
  for (const label of Object.keys(rbExpect)) {
    const b = readinessBlock(label);
    check('readiness 0.8.0: "' + label + '" state line reads "' + rbExpect[label] + '"', !!b && b.state.indexOf(rbExpect[label]) !== -1, b ? b.state : 'no block');
  }

  // --- 3. Fee and Broadcast via live inside Details, not the face ---
  // (0.8.1) The face-text substring check for 'Fee' cannot be used
  // any more: the shared-input warning lists 'Dom Feemarket', which
  // contains 'Fee', on every card's face. Check by class instead:
  // no direct face child (outside Details) carries tx-fee/tx-route.
  for (const label of Object.keys(trigExpect)) {
    const card = cardByTitle(label);
    const faceKids = card ? card.children.filter((c) => c.className !== 'tx-details') : [];
    const hasFeeRow = faceKids.some((c) => (c.className || '').split(' ').includes('tx-fee'));
    const hasRouteRow = faceKids.some((c) => (c.className || '').split(' ').includes('tx-route'));
    check('details 0.8.1: "' + label + '" face has no Fee row and no Broadcast via row', !!card && !hasFeeRow && !hasRouteRow, faceKids.map((c) => c.className).join(','));
    const det = card && cardDetails(card);
    check('details 0.8.0: "' + label + '" Details exists and starts collapsed', !!det && det.open === false, det ? 'open=' + det.open : 'no Details');
    if (det) toggleDetails(det, true);
    check('details 0.8.0: "' + label + '" Details holds the Fee row and the Broadcast via row once opened',
      !!card && detailsContains(card, 'tx-fee') && detailsContains(card, 'tx-route'),
      card ? cardDetails(card).children.map((x) => x.className).join(',') : 'no card');
  }

  // --- 4. the check-in strip is visible with an armed check-in tx ---
  check('check-in strip 0.8.0: visible with an armed check-in tx', els['checkin-card'] && els['checkin-card'].style.display !== 'none', els['checkin-card'] && els['checkin-card'].style.display);

  // --- 4b. the per-tx check-in bars (0.8.0) ---
  // One bar per armed check-in tx: the seeded 'Dom Check-in'
  // (35 days, checked in just now) reads 0 of 35. A second
  // check-in tx with a 10-day threshold proves the bars are
  // per-tx, not one shared window.
  const bar0 = checkinBar('Dom Check-in');
  check('per-tx bars: one bar for the armed check-in tx',
    (checkinBars() || []).length === 1, JSON.stringify(checkinBars()));
  check('per-tx bars: the Dom Check-in bar label reads "Dom Check-in"',
    !!bar0 && bar0.label === 'Dom Check-in', bar0 ? bar0.label : 'no bar');
  check('per-tx bars: the Dom Check-in bar reads "0 of 35 days elapsed" (checked in just now)',
    !!bar0 && bar0.caption === '0 of 35 days elapsed', bar0 ? bar0.caption : 'no bar');
  check('per-tx bars: the Dom Check-in bar fill is 0% wide',
    !!bar0 && bar0.width === 0, bar0 ? bar0.width : 'no bar');
  const add10 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200201), label: 'Dom Check-in 10d', trigger: { type: 'checkin', params: { thresholdDays: 10 } } }) });
  check('per-tx bars: a second check-in tx (10-day threshold) adds via the API', add10.status === 201, 'status=' + add10.status);
  const add10Json = add10.status === 201 ? await add10.json() : {};
  const checkin10Id = (add10Json.tx || {}).id || null;
  await rerender(appJs);
  check('per-tx bars: two bars once two check-in txs are armed',
    (checkinBars() || []).length === 2, JSON.stringify(checkinBars()));
  const bar10 = checkinBar('Dom Check-in 10d');
  check('per-tx bars: the 10d bar label reads "Dom Check-in 10d"',
    !!bar10 && bar10.label === 'Dom Check-in 10d', bar10 ? bar10.label : 'no bar');
  check('per-tx bars: the 10d bar reads "0 of 10 days elapsed" — its OWN window, not the 35d one',
    !!bar10 && bar10.caption === '0 of 10 days elapsed', bar10 ? bar10.caption : 'no bar');
  check('per-tx bars: the 10d bar fill is 0% wide',
    !!bar10 && bar10.width === 0, bar10 ? bar10.width : 'no bar');
  const bar35b = checkinBar('Dom Check-in');
  check('per-tx bars: the 35d bar still reads "0 of 35 days elapsed" alongside it',
    !!bar35b && bar35b.caption === '0 of 35 days elapsed', bar35b ? bar35b.caption : 'no bar');
  // The shim does not model parent/child HTML, so the removed
  // elements are proven gone a different way: the app never
  // touches them (no such element exists in the shim DOM), while
  // the bars container does.
  check('per-tx bars: the app never touches the removed elements (no #next-due / #checkin-countdown / #checkin-progress / #set-threshold in the DOM)',
    !('next-due' in els) && !('checkin-countdown' in els) && !('checkin-countdown-sub' in els)
    && !('checkin-progress' in els) && !('checkin-progress-fill' in els) && !('checkin-progress-label' in els)
    && !('set-threshold' in els) && !('btn-save-settings' in els),
    Object.keys(els).filter((k) => k.indexOf('checkin-') === 0 || k.indexOf('set-') === 0).join(', '));
  check('per-tx bars: the card still shows the Last check-in date',
    els['last-checkin'] && els['last-checkin'].textContent !== '' && els['last-checkin'].textContent !== '—',
    els['last-checkin'] && els['last-checkin'].textContent);

  // --- 5. the Add form rule list (0.8.2) ---
  const addPanel0 = rulePanels('btc')[0];
  check('add rule list 0.8.2: the Add form boots with one rule panel (check-in, 35 days)',
    rulePanels('btc').length === 1 && !!addPanel0 && panelTypeSelect(addPanel0).value === 'checkin'
    && findById(addPanel0, 'btc-rule-0-threshold').value === '35',
    'panels=' + rulePanels('btc').length);
  check('add rule list 0.8.2: the panel type select has the seven options (checkin/price/utxo/blockheight/setdate/feemarket/manual)',
    JSON.stringify(panelSelectValues(addPanel0, 'btc-rule-0-trigger')) === JSON.stringify(['checkin', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket', 'manual']),
    JSON.stringify(panelSelectValues(addPanel0, 'btc-rule-0-trigger')));
  check('add rule list 0.8.2 v2: the static HTML has the combine section (both op cards, the one-rule note), the rules list, the Add-rule button and the cap note',
    idx.indexOf('id="btc-op-section"') !== -1 && idx.indexOf('id="btc-op-any"') !== -1 && idx.indexOf('id="btc-op-all"') !== -1
    && idx.indexOf('id="btc-op-note"') !== -1 && idx.indexOf('id="btc-rules-list"') !== -1
    && idx.indexOf('id="btc-add-rule"') !== -1 && idx.indexOf('id="btc-rules-cap-note"') !== -1, '');
  check('add rule list 0.8.2 v2: the combine cards carry Ryan\'s exact descriptions',
    idx.indexOf('Broadcasts when any one rule is met') !== -1 && idx.indexOf('Broadcasts when all rules are simultaneously met') !== -1, '');
  check('add rule list 0.8.2 v2: the static HTML has no once-per-type note (the disabled option says it)',
    idx.indexOf('only once per transaction') === -1, '');
  check('add rule list 0.8.2 v2: with one panel the OR card is selected and the one-rule note shows',
    els['btc-op-any'] && els['btc-op-any'].className === 'op-card selected'
    && els['btc-op-all'] && els['btc-op-all'].className === 'op-card'
    && els['btc-op-note'] && els['btc-op-note'].style.display !== 'none',
    'any=' + (els['btc-op-any'] && els['btc-op-any'].className) + ' all=' + (els['btc-op-all'] && els['btc-op-all'].className)
    + ' note=' + (els['btc-op-note'] && els['btc-op-note'].style.display));
  check('add rule list 0.8.2: one panel hides its Remove button (a tx always has a rule)',
    !!panelRemoveBtn(addPanel0) && panelRemoveBtn(addPanel0).style.display === 'none',
    panelRemoveBtn(addPanel0) ? panelRemoveBtn(addPanel0).style.display : 'no button');
  check('add rule list 0.8.2: the checkin threshold input is a number input with bounds 1-3650, default 35',
    !!findById(addPanel0, 'btc-rule-0-threshold') && findById(addPanel0, 'btc-rule-0-threshold').type === 'number'
    && findById(addPanel0, 'btc-rule-0-threshold').min === '1' && findById(addPanel0, 'btc-rule-0-threshold').max === '3650'
    && findById(addPanel0, 'btc-rule-0-threshold').value === '35',
    findById(addPanel0, 'btc-rule-0-threshold') ? JSON.stringify({ type: findById(addPanel0, 'btc-rule-0-threshold').type, min: findById(addPanel0, 'btc-rule-0-threshold').min, max: findById(addPanel0, 'btc-rule-0-threshold').max, value: findById(addPanel0, 'btc-rule-0-threshold').value }) : 'no field');
  selectAddTrigger('price');
  check('add picker 0.8.2: price shows only the price row (checkin + utxo hidden)',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row'),
    'price=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') + ' checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') + ' utxo=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row'));
  check('add picker 0.8.2: the price guard note names the primary-decides rule',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-price-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-price-note').textContent.indexOf('the primary price source decides') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-price-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-price-note').textContent);
  selectAddTrigger('utxo');
  check('add picker 0.8.2: utxo shows only the utxo row (checkin + price hidden)',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row'),
    'utxo=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row') + ' checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') + ' price=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row'));
  check('add picker 0.8.2: the utxo guard note names the confirmed-only rule',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent.indexOf('only a confirmed spend fires') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent);
  selectAddTrigger('manual');
  check('add picker 0.8.2: manual shows only the manual row ("Never fires — manual only")',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-manual-row')
    && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row')
    && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-blockheight-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-setdate-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row')
    && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-manual-note').textContent === 'Never fires \u2014 manual only',
    'manual=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-manual-row'));
  selectAddTrigger('checkin');
  check('add picker 0.8.2: checkin shows only the checkin row (price + utxo hidden)',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row'),
    'checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') + ' price=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') + ' utxo=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row'));
  // --- 5b. the Add form rule panel: the three new rows (0.8.1) ---
  selectAddTrigger('blockheight');
  check('add picker 0.8.2: blockheight shows only the blockheight row',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-blockheight-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-setdate-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row'),
    'blockheight=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-blockheight-row') + ' checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row'));
  check('add picker 0.8.2: the blockheight row has a number input (placeholder 1000000)',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-blockheight') && findById(rulePanels('btc')[0], 'btc-rule-0-blockheight').type === 'number'
    && findById(rulePanels('btc')[0], 'btc-rule-0-blockheight').placeholder === '1000000',
    findById(rulePanels('btc')[0], 'btc-rule-0-blockheight') ? JSON.stringify({ type: findById(rulePanels('btc')[0], 'btc-rule-0-blockheight').type, placeholder: findById(rulePanels('btc')[0], 'btc-rule-0-blockheight').placeholder }) : 'no field');
  selectAddTrigger('setdate');
  check('add picker 0.8.2: setdate shows only the setdate row',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-setdate-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-blockheight-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row'),
    'setdate=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-setdate-row') + ' checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row'));
  check('add picker 0.8.2: the setdate row is a datetime-local input',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-setdate') && findById(rulePanels('btc')[0], 'btc-rule-0-setdate').type === 'datetime-local',
    findById(rulePanels('btc')[0], 'btc-rule-0-setdate') ? findById(rulePanels('btc')[0], 'btc-rule-0-setdate').type : 'no field');
  selectAddTrigger('feemarket');
  check('add picker 0.8.2: feemarket shows only the feemarket row',
    panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-blockheight-row') && !panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-setdate-row'),
    'feemarket=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row') + ' checkin=' + panelRowVisible(rulePanels('btc')[0], 'btc-rule-0-trigger-checkin-row'));
  check('add picker 0.8.2: the feemarket row has a sat/vB unit',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-feemarket') && elText(findById(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row')).indexOf('sat/vB') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row') ? elText(findById(rulePanels('btc')[0], 'btc-rule-0-trigger-feemarket-row')) : 'no row');
  // --- 5c. fee-market direction: a Direction select in both
  // Add and Edit panels, 'below' by default; flipping the seeded
  // rule to 'above' re-renders its condition as "tx fees are >=".
  check('add picker 0.8.2: the feemarket row has a Direction select with below/above ("Fee falls to or below" / "Fee rises to or above"), below by default',
    JSON.stringify(panelSelectValues(rulePanels('btc')[0], 'btc-rule-0-feemarket-dir')) === JSON.stringify(['below', 'above'])
    && findById(rulePanels('btc')[0], 'btc-rule-0-feemarket-dir').value === 'below'
    && JSON.stringify((findById(rulePanels('btc')[0], 'btc-rule-0-feemarket-dir').children || []).map((o) => o.textContent)) === JSON.stringify(['Fee falls to or below', 'Fee rises to or above']),
    JSON.stringify(panelSelectValues(rulePanels('btc')[0], 'btc-rule-0-feemarket-dir')));
  check('add picker 0.8.2: the Edit feemarket row has the same Direction select, below by default',
    JSON.stringify(panelSelectValues(rulePanels('edit')[0], 'edit-rule-0-feemarket-dir')) === JSON.stringify(['below', 'above'])
    && findById(rulePanels('edit')[0], 'edit-rule-0-feemarket-dir').value === 'below',
    JSON.stringify(panelSelectValues(rulePanels('edit')[0], 'edit-rule-0-feemarket-dir')));
  const fmId = ((st0.bitcoin.txs || []).find((t) => t.label === 'Dom Feemarket') || {}).id;
  check('feemarket direction: the seeded feemarket tx id is known', !!fmId, 'id=' + fmId);
  const fmFlip = fmId ? await fetch('/api/bitcoin/txs/' + fmId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: { type: 'feemarket', params: { maxFeeRate: 0.5, direction: 'above' } }, triggerConfirmed: true }) }) : null;
  check('feemarket direction: flipping the rule to above via the API succeeds', !!fmFlip && fmFlip.status === 200, fmFlip ? 'status=' + fmFlip.status : 'no id');
  await rerender(appJs);
  const fmCard = cardByTitle('Dom Feemarket');
  const fmParts = fmCard && triggerParts(fmCard);
  check('feemarket direction: the subcard condition now reads "tx fees are >= 0.5 sat/vB"',
    !!fmParts && fmParts.cond === 'Fires when tx fees are >= 0.5 sat/vB', fmParts ? fmParts.cond : 'no subcard');
  // Flip it back so later sections see the default 'below' rule.
  const fmBack = fmId ? await fetch('/api/bitcoin/txs/' + fmId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: { type: 'feemarket', params: { maxFeeRate: 0.5, direction: 'below' } }, triggerConfirmed: true }) }) : null;
  check('feemarket direction: flipping the rule back to below via the API succeeds', !!fmBack && fmBack.status === 200, fmBack ? 'status=' + fmBack.status : 'no id');
  await rerender(appJs);
  selectAddTrigger('checkin');

  // --- 6. dynamic check-in strip: disarm freezes the bar, re-arm resumes it ---
  // Two check-in txs are armed now (§4b). Disarming one leaves
  // its bar FROZEN at its day count (muted, marked disarmed) —
  // the redesign: a disarmed tx keeps its bar, and the card
  // stays visible while any check-in tx is still active.
  check('dynamic strip 0.8.0: the seeded check-in tx id is known', !!checkinId, 'id=' + checkinId);
  const dis = await fetch('/api/bitcoin/txs/' + checkinId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('dynamic strip 0.8.0: the check-in tx disarms via the API', dis.status === 200, 'status=' + dis.status);
  await rerender(appJs);
  check('dynamic strip 0.8.0: disarming one check-in tx leaves BOTH bars (its own frozen, the 10d tx live)',
    (checkinBars() || []).length === 2 && !!checkinBar('Dom Check-in') && !!checkinBar('Dom Check-in 10d'),
    JSON.stringify(checkinBars()));
  check('dynamic strip 0.8.0: the disarmed bar is frozen (class frozen, caption names it disarmed)',
    (checkinBar('Dom Check-in') || {}).cls.split(' ').includes('frozen')
    && (checkinBar('Dom Check-in') || {}).caption.indexOf('disarmed, frozen') !== -1,
    JSON.stringify(checkinBar('Dom Check-in')));
  check('dynamic strip 0.8.0: the 10d bar stays live (no frozen class)',
    !((checkinBar('Dom Check-in 10d') || {}).cls.split(' ').includes('frozen')),
    JSON.stringify(checkinBar('Dom Check-in 10d')));
  check('dynamic strip 0.8.0: the card stays visible while a check-in tx is disarmed',
    els['checkin-card'] && els['checkin-card'].style.display !== 'none',
    els['checkin-card'] && els['checkin-card'].style.display);
  const dis10 = checkin10Id ? await fetch('/api/bitcoin/txs/' + checkin10Id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }) : null;
  check('dynamic strip 0.8.0: the 10d check-in tx disarms via the API', !!dis10 && dis10.status === 200, dis10 ? 'status=' + dis10.status : 'no id');
  await rerender(appJs);
  check('dynamic strip 0.8.0: with both check-in txs disarmed, BOTH frozen bars remain',
    (checkinBars() || []).length === 2 && !!checkinBar('Dom Check-in') && !!checkinBar('Dom Check-in 10d'),
    JSON.stringify(checkinBars()));
  check('dynamic strip 0.8.0: with both disarmed the check-in card stays visible (frozen bars, not hidden)',
    els['checkin-card'] && els['checkin-card'].style.display !== 'none',
    els['checkin-card'] && els['checkin-card'].style.display);
  check('dynamic strip 0.8.1: the other six cards are still rendered while the strip is frozen',
    ['Dom Price', 'Dom UTXO', 'Dom Manual', 'Dom Blockheight', 'Dom Setdate', 'Dom Feemarket'].every((t) => !!cardByTitle(t)), txCards().map(cardTitle).join(', '));
  check('dynamic strip 0.8.1: the readiness rows remain (eight blocks) while the strip is frozen',
    (readinessBlocks() || []).length === 8, (readinessBlocks() || []).length);
  const rearm = await fetch('/api/bitcoin/txs/' + checkinId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  check('dynamic strip 0.8.0: the check-in tx re-arms via the API', rearm.status === 200, 'status=' + rearm.status);
  const rearm10 = checkin10Id ? await fetch('/api/bitcoin/txs/' + checkin10Id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }) : null;
  check('dynamic strip 0.8.0: the 10d check-in tx re-arms via the API', !!rearm10 && rearm10.status === 200, rearm10 ? 'status=' + rearm10.status : 'no id');
  await rerender(appJs);
  check('dynamic strip 0.8.0: re-arming the check-in txs unfreezes both bars (no frozen class, card visible)',
    els['checkin-card'] && els['checkin-card'].style.display !== 'none' && (checkinBars() || []).length === 2
    && (checkinBars() || []).every((b) => !b.cls.split(' ').includes('frozen')),
    els['checkin-card'] && els['checkin-card'].style.display + ' bars=' + JSON.stringify(checkinBars()));

  // --- 7. the Edit popup's trigger picker populates from the tx ---
  const priceCard = cardByTitle('Dom Price');
  const priceEdit = priceCard && cardButton(priceCard, 'Edit');
  check('edit picker 0.8.0: the price card has an Edit button', !!priceEdit, '');
  if (priceEdit) priceEdit.click();
  check('edit picker 0.8.0: opening Edit on the price tx opens the modal',
    els['edit-modal'] && els['edit-modal'].classList.contains('open'), '');
  // The confirm/details modal must stack above the Edit modal:
  // a trigger warning opened while editing a tx would otherwise
  // appear behind the edit card, invisible until the edit card
  // is closed. The confirm modal carries a higher z-index than
  // the shared .modal-overlay (which the Edit modal keeps).
  const cssText = await realFetch(BASE + '/style.css').then((r) => r.text());
  const overlayZ = parseInt((cssText.match(/\.modal-overlay\s*\{[^}]*z-index:\s*(\d+)/) || [])[1] || '0', 10);
  const confirmZ = parseInt((cssText.match(/#confirm-modal\s*\{[^}]*z-index:\s*(\d+)/) || [])[1] || '0', 10);
  check('modal stacking: #confirm-modal z-index beats .modal-overlay so a confirm opened while editing is visible',
    confirmZ > overlayZ && overlayZ > 0, 'overlay=' + overlayZ + ' confirm=' + confirmZ);
  // Both modals can be open at once (the confirm on top): open
  // the confirm while the edit modal is open and the edit modal
  // stays open behind it.
  els['help-vacation'].click();
  check('modal stacking: opening the confirm while the edit modal is open leaves both open',
    els['confirm-modal'] && els['confirm-modal'].classList.contains('open')
    && els['edit-modal'] && els['edit-modal'].classList.contains('open'), '');
  els['confirm-cancel'].click();
  check('modal stacking: closing the confirm leaves the edit modal open',
    !(els['confirm-modal'] && els['confirm-modal'].classList.contains('open'))
    && els['edit-modal'] && els['edit-modal'].classList.contains('open'), '');
  check('edit picker 0.8.2: the price tx populates the first rule panel as price with value 150000',
    !!panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value === 'price' && !!findById(rulePanels('edit')[0], 'edit-rule-0-value') && findById(rulePanels('edit')[0], 'edit-rule-0-value').value === '150000',
    'trigger=' + (panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value) + ' value=' + (findById(rulePanels('edit')[0], 'edit-rule-0-value') && findById(rulePanels('edit')[0], 'edit-rule-0-value').value));
  check('edit picker 0.8.2: the price tx shows only the price row (checkin + utxo hidden)',
    panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-row'),
    'price=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-price-row') + ' checkin=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-checkin-row') + ' utxo=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-row'));
  check('edit picker 0.8.2: the edit price guard note names the primary-decides rule',
    findById(rulePanels('edit')[0], 'edit-rule-0-trigger-price-note') && findById(rulePanels('edit')[0], 'edit-rule-0-trigger-price-note').textContent.indexOf('the primary price source decides') !== -1,
    findById(rulePanels('edit')[0], 'edit-rule-0-trigger-price-note') && findById(rulePanels('edit')[0], 'edit-rule-0-trigger-price-note').textContent);
  const checkinCard = cardByTitle('Dom Check-in');
  const checkinEdit = checkinCard && cardButton(checkinCard, 'Edit');
  check('edit picker 0.8.0: the check-in card has an Edit button', !!checkinEdit, '');
  if (checkinEdit) checkinEdit.click();
  check('edit picker 0.8.2: the check-in tx populates the first rule panel as checkin with threshold 35',
    !!panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value === 'checkin' && !!findById(rulePanels('edit')[0], 'edit-rule-0-threshold') && (findById(rulePanels('edit')[0], 'edit-rule-0-threshold').value === '35' || findById(rulePanels('edit')[0], 'edit-rule-0-threshold').value === 35),
    'trigger=' + (panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value) + ' threshold=' + (findById(rulePanels('edit')[0], 'edit-rule-0-threshold') && findById(rulePanels('edit')[0], 'edit-rule-0-threshold').value));
  check('edit picker 0.8.2: the check-in tx shows only the checkin row (price + utxo hidden)',
    panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-checkin-row') && !panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-price-row') && !panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-row'),
    'checkin=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-checkin-row') + ' price=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-price-row') + ' utxo=' + panelRowVisible(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-row'));

  // --- 8. the UTXO confirmation modes (picker + subcard) ---
  // Add form: the Fire-on select, the confirmations row, the guard note.
  selectAddTrigger('utxo');
  check('utxo modes: the Add UTXO row has a Fire-on select with confirmed/unconfirmed',
    JSON.stringify(panelSelectValues(rulePanels('btc')[0], 'btc-rule-0-utxo-mode')) === JSON.stringify(['confirmed', 'unconfirmed']),
    JSON.stringify(panelSelectValues(rulePanels('btc')[0], 'btc-rule-0-utxo-mode')));
  check('utxo modes: the Add mode defaults to confirmed',
    findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode').value === 'confirmed', '');
  check('utxo modes: the Add confirmations input defaults to 1',
    findById(rulePanels('btc')[0], 'btc-rule-0-utxo-confs').value === '1', '');
  // The shim does not parse the selected option, so set the mode
  // explicitly (a real browser defaults it to confirmed).
  findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode').value = 'confirmed';
  fireChange(findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode'));
  check('utxo modes: confirmed shows the confirmations row',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display !== 'none',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display);
  check('utxo modes: the Add guard note names the confirmed-only rule at N=1',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent.indexOf('only a confirmed spend fires') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent);
  findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode').value = 'unconfirmed';
  fireChange(findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode'));
  check('utxo modes: unconfirmed hides the confirmations row',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display === 'none',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display);
  check('utxo modes: the unconfirmed guard note warns the spend can be evicted',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent.indexOf('evicted') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent);
  findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode').value = 'confirmed';
  fireChange(findById(rulePanels('btc')[0], 'btc-rule-0-utxo-mode'));
  findById(rulePanels('btc')[0], 'btc-rule-0-utxo-confs').value = '6';
  fireInput(findById(rulePanels('btc')[0], 'btc-rule-0-utxo-confs'));
  check('utxo modes: confirmed with N=6 shows the confirmations row',
    !!findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display !== 'none',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-confs-row').style.display);
  check('utxo modes: the N=6 guard note names 6 confirmations',
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent.indexOf('6 confirmations') !== -1,
    findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note') && findById(rulePanels('btc')[0], 'btc-rule-0-trigger-utxo-note').textContent);
  // Subcard conditions: add one unconfirmed-mode tx and one
  // 6-confirmation tx via the API (triggerConfirmed: both are
  // already spent), re-render, and read their subcards.
  const CONFLICT = 'cc'.repeat(32);
  const FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
  const addU = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200001), label: 'Dom UTXO unconfirmed', trigger: { type: 'utxo', params: { outpoint: CONFLICT + ':0', confirmations: 0 } }, triggerConfirmed: true }) });
  check('utxo modes: the unconfirmed-mode tx adds via the API', addU.status === 201, 'status=' + addU.status);
  const add6 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200003), label: 'Dom UTXO 6 conf', trigger: { type: 'utxo', params: { outpoint: FINNEY + ':0', confirmations: 6 } }, triggerConfirmed: true }) });
  check('utxo modes: the 6-confirmation tx adds via the API', add6.status === 201, 'status=' + add6.status);
  await rerender(appJs);
  const cardU = cardByTitle('Dom UTXO unconfirmed');
  const partsU = cardU && triggerParts(cardU);
  check('utxo modes: the unconfirmed tx subcard reads "(unconfirmed)"',
    !!partsU && partsU.cond === 'Fires when UTXO cccccc\u2026:0 is spent (unconfirmed)', partsU ? partsU.cond : 'no subcard');
  const card6 = cardByTitle('Dom UTXO 6 conf');
  const parts6 = card6 && triggerParts(card6);
  check('utxo modes: the 6-confirmation tx subcard reads "(6 confirmations)"',
    !!parts6 && parts6.cond === 'Fires when UTXO f4184f\u2026:0 is spent (6 confirmations)', parts6 ? parts6.cond : 'no subcard');
  // Edit popup: the mode and N populate from the rule being edited.
  const edit6 = card6 && cardButton(card6, 'Edit');
  check('utxo modes: the 6-confirmation card has an Edit button', !!edit6, '');
  if (edit6) edit6.click();
  check('utxo modes: Edit on the 6-confirmation tx populates mode confirmed and N 6',
    !!panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value === 'utxo'
    && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode') && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode').value === 'confirmed'
    && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-confs') && (findById(rulePanels('edit')[0], 'edit-rule-0-utxo-confs').value === '6' || findById(rulePanels('edit')[0], 'edit-rule-0-utxo-confs').value === 6),
    'trigger=' + (panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value) + ' mode=' + (findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode') && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode').value) + ' confs=' + (findById(rulePanels('edit')[0], 'edit-rule-0-utxo-confs') && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-confs').value));
  const editU = cardU && cardButton(cardU, 'Edit');
  check('utxo modes: the unconfirmed card has an Edit button', !!editU, '');
  if (editU) editU.click();
  check('utxo modes: Edit on the unconfirmed tx populates mode unconfirmed and hides the confirmations row',
    !!panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value === 'utxo'
    && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode') && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode').value === 'unconfirmed'
    && findById(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-confs-row') && findById(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-confs-row').style.display === 'none',
    'mode=' + (findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode') && findById(rulePanels('edit')[0], 'edit-rule-0-utxo-mode').value) + ' confsRow=' + (findById(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-confs-row') && findById(rulePanels('edit')[0], 'edit-rule-0-trigger-utxo-confs-row').style.display));

  // Catch-up waiting state (0.8.0, fast tick): a rule whose spend
  // is first noticed below its N shows the progress reason on its
  // card. Drive FINNEY:0 to 2 confirmations via the stub override,
  // add an N=3 rule (below threshold, so no triggerConfirmed
  // needed), run a release check so the triggerState picks up the
  // "2 of 3" reason, and read the card's state line.
  const ovr = await realFetch('http://127.0.0.1:18235/__test__/outspend', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txid: FINNEY, vout: 0, blockHeight: 899999 }) });
  check('utxo modes: the outspend override sets FINNEY:0 to 2 confirmations', ovr.status === 200, 'status=' + ovr.status);
  const add3 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200005), label: 'Dom UTXO 2 of 3', trigger: { type: 'utxo', params: { outpoint: FINNEY + ':0', confirmations: 3 } } }) });
  check('utxo modes: the 3-confirmation tx adds via the API (below threshold, no confirm needed)', add3.status === 201, 'status=' + add3.status);
  const rel3 = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('utxo modes: a release check runs so the waiting state is recorded', rel3.status === 200, 'status=' + rel3.status);
  await rerender(appJs);
  const card3 = cardByTitle('Dom UTXO 2 of 3');
  const parts3 = card3 && triggerParts(card3);
  check('utxo modes: the waiting tx subcard state line reads "2 of 3 confirmations"',
    !!parts3 && parts3.now.indexOf('2 of 3 confirmations') !== -1, parts3 ? parts3.now : 'no subcard');
  check('utxo modes: the waiting tx subcard condition reads "(3 confirmations)"',
    !!parts3 && parts3.cond === 'Fires when UTXO f4184f\u2026:0 is spent (3 confirmations)', parts3 ? parts3.cond : 'no subcard');
  const rb3 = readinessBlock('Dom UTXO 2 of 3');
  check('utxo modes: the readiness block for the waiting tx reads its condition ("Fires when UTXO f4184f…:0 is spent (3 confirmations)")',
    !!rb3 && rb3.state === 'Fires when UTXO f4184f\u2026:0 is spent (3 confirmations)', rb3 ? rb3.state : 'no block');
  // Clear the override so the suite ends clean.
  const ovrClear = await realFetch('http://127.0.0.1:18235/__test__/outspend', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txid: FINNEY, vout: 0, clear: true }) });
  check('utxo modes: the outspend override is cleared', ovrClear.status === 200, 'status=' + ovrClear.status);

  // --- 9. the Bitcoin price source (Settings, two-source 0.8.0) ---
  // Static HTML: the card, the two (JS-populated) selects, the 5%
  // note, the per-source display, the save button.
  check('price sources: the Settings card has a "Bitcoin price source" heading (static HTML)',
    idx.indexOf('<h2>Bitcoin price source</h2>') !== -1, '');
  check('price sources: the card has two provider selects (static HTML)',
    idx.indexOf('id="set-price-source1"') !== -1 && idx.indexOf('id="set-price-source2"') !== -1, '');
  check('price sources: the note explains the 5% agreement rule (static HTML)',
    idx.indexOf('agree within <span id="price-sources-agreement">5%</span>') !== -1, '');
  check('price sources: the "?" pop-out names the primary-decides rule',
    appJs.indexOf('is the one that decides') !== -1, '');
  check('price sources: the "?" pop-out names the single-source fallback',
    appJs.indexOf('the other is used alone') !== -1, '');
  check('price sources: the card has a per-source display with a status pill and a price value span (static HTML)',
    idx.indexOf('id="price-source1"') !== -1 && idx.indexOf('id="price-source2"') !== -1
    && idx.indexOf('id="price-source1-status"') !== -1 && idx.indexOf('id="price-source2-status"') !== -1
    && idx.indexOf('id="price-source1-price" class="node-check-detail"') !== -1 && idx.indexOf('id="price-source2-price" class="node-check-detail"') !== -1, '');
  check('price sources: the card has a Save button (static HTML)',
    idx.indexOf('id="btn-save-price-sources"') !== -1, '');
  // After load(): the selects are populated with the five providers
  // and default to CoinGecko + Coinbase.
  const s1opts = (els['set-price-source1'] && els['set-price-source1'].children || []).map((o) => o.value);
  const s2opts = (els['set-price-source2'] && els['set-price-source2'].children || []).map((o) => o.value);
  check('price sources: Primary price source offers all five providers plus Custom',
    JSON.stringify(s1opts) === JSON.stringify(['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp', 'custom']), JSON.stringify(s1opts));
  check('price sources: Secondary price source offers all five providers plus Custom',
    JSON.stringify(s2opts) === JSON.stringify(['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp', 'custom']), JSON.stringify(s2opts));
  check('price sources: Primary price source defaults to CoinGecko',
    els['set-price-source1'] && els['set-price-source1'].value === 'coingecko', els['set-price-source1'] && els['set-price-source1'].value);
  check('price sources: Secondary price source defaults to Coinbase',
    els['set-price-source2'] && els['set-price-source2'].value === 'coinbase', els['set-price-source2'] && els['set-price-source2'].value);
  // The per-source rows show the provider name, the status pill,
  // and the last price in a small muted value span to the RIGHT
  // of the pill — "CoinGecko [OK] $98,200" — the same shape as
  // the node rows' values ("Reachable"). The launcher's release
  // check populated the cache at $98,200 for both sources.
  check('price sources: Primary price source shows its provider name, and its price to the right of the pill (CoinGecko [OK] $98,200)',
    els['price-source1'] && els['price-source1'].textContent.indexOf('CoinGecko') !== -1 && els['price-source1'].textContent.indexOf('$') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent));
  check('price sources: Primary price source status pill reads OK (cached price)',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  check('price sources: Secondary price source shows its provider name, and its price to the right of the pill (Coinbase [OK] $98,200)',
    els['price-source2'] && els['price-source2'].textContent.indexOf('Coinbase') !== -1 && els['price-source2'].textContent.indexOf('$') === -1
    && els['price-source2-price'] && els['price-source2-price'].textContent === '$98,200',
    (els['price-source2'] && els['price-source2'].textContent) + ' / ' + (els['price-source2-price'] && els['price-source2-price'].textContent));
  check('price sources: Secondary price source status pill reads OK (cached price)',
    els['price-source2-status'] && els['price-source2-status'].textContent === 'OK' && els['price-source2-status'].className === 'pill ok',
    els['price-source2-status'] && els['price-source2-status'].textContent + ' / ' + els['price-source2-status'].className);
  check('price sources: no per-source status pill shows a dash',
    els['price-source1-status'] && els['price-source1-status'].textContent !== '—' && els['price-source2-status'] && els['price-source2-status'].textContent !== '—',
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));
  // Change persists: pick Kraken + Bitstamp, save, and the
  // settings (and the re-rendered selects) follow.
  els['set-price-source1'].value = 'kraken';
  els['set-price-source2'].value = 'bitstamp';
  // Changing a dropdown updates the row label IMMEDIATELY
  // (before saving) — the label must name the newly selected
  // provider, never the old one, so the label and the Test
  // connection button always agree on which provider they mean.
  // (Setting .value programmatically fires no change event, so
  // the test fires it with the shim's fireChange, as a real
  // user change would.)
  fireChange(els['set-price-source1']);
  fireChange(els['set-price-source2']);
  check('price sources: changing the Primary price source dropdown to Kraken updates the row label to Kraken immediately (before saving)',
    els['price-source1'] && els['price-source1'].textContent.indexOf('Kraken') !== -1 && els['price-source1'].textContent.indexOf('CoinGecko') === -1,
    els['price-source1'] && els['price-source1'].textContent);
  check('price sources: changing the Secondary price source dropdown to Bitstamp updates the row label to Bitstamp immediately (before saving)',
    els['price-source2'] && els['price-source2'].textContent.indexOf('Bitstamp') !== -1 && els['price-source2'].textContent.indexOf('Coinbase') === -1,
    els['price-source2'] && els['price-source2'].textContent);
  // Changing a dropdown resets that row's status to Not Tested
  // — the new provider has not been tested yet — and it never
  // shows a dash.
  check('price sources: changing the Primary price source dropdown resets its status pill to Not Tested',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'Not Tested' && els['price-source1-status'].className === 'pill muted',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  check('price sources: changing the Secondary price source dropdown resets its status pill to Not Tested',
    els['price-source2-status'] && els['price-source2-status'].textContent === 'Not Tested' && els['price-source2-status'].className === 'pill muted',
    els['price-source2-status'] && els['price-source2-status'].textContent + ' / ' + els['price-source2-status'].className);
  check('price sources: after a change the status pills show Not Tested, never a dash',
    els['price-source1-status'] && els['price-source1-status'].textContent !== '—' && els['price-source2-status'] && els['price-source2-status'].textContent !== '—',
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stAfter = await (await fetch('/api/state')).json();
  check('price sources: saving Kraken + Bitstamp persists in /api/state',
    stAfter.settings && stAfter.settings.priceSources && stAfter.settings.priceSources.source1 === 'kraken' && stAfter.settings.priceSources.source2 === 'bitstamp',
    JSON.stringify(stAfter.settings && stAfter.settings.priceSources));
  check('price sources: after saving, the selects re-render as Kraken + Bitstamp',
    els['set-price-source1'] && els['set-price-source1'].value === 'kraken' && els['set-price-source2'] && els['set-price-source2'].value === 'bitstamp',
    's1=' + (els['set-price-source1'] && els['set-price-source1'].value) + ' s2=' + (els['set-price-source2'] && els['set-price-source2'].value));
  // After saving, the rows re-derive from the cache: Kraken and
  // Bitstamp have no cached reading yet, so both read Not Tested.
  check('price sources: after saving Kraken + Bitstamp both status pills read Not Tested (no cached reading)',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'Not Tested'
    && els['price-source2-status'] && els['price-source2-status'].textContent === 'Not Tested',
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));
  // Restore the defaults so the suite ends on the default sources.
  els['set-price-source1'].value = 'coingecko';
  els['set-price-source2'].value = 'coinbase';
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stRestored = await (await fetch('/api/state')).json();
  check('price sources: the defaults are restored (CoinGecko + Coinbase)',
    stRestored.settings && stRestored.settings.priceSources && stRestored.settings.priceSources.source1 === 'coingecko' && stRestored.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stRestored.settings && stRestored.settings.priceSources));
  // After restoring, the rows re-derive from the cache again —
  // both sources have a cached price, so both read OK.
  check('price sources: after restoring the defaults both status pills read OK again',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK'
    && els['price-source2-status'] && els['price-source2-status'].textContent === 'OK',
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));

  // --- 10. the single "Test connection" button + Exchange Status (0.8.0) ---
  // Static HTML: ONE "Test connection" button tests BOTH
  // sources at once (like the Node Status button tests all
  // nodes). There are NO per-source Test buttons and no
  // per-source result spans — one shared result area instead.
  check('test button: the Settings card has exactly one "Test connection" button for the exchanges (static HTML)',
    idx.indexOf('id="btn-test-price-sources"') !== -1, '');
  // Placement: the Test connection button sits immediately to
  // the right of the Save button in the price sources card —
  // the same layout as the node card (Save first, Test second).
  check('test button: Test connection sits to the right of Save in the price sources card (static HTML)',
    idx.indexOf('id="btn-save-price-sources"') !== -1 && idx.indexOf('id="btn-test-price-sources"') !== -1
    && idx.indexOf('id="btn-save-price-sources"') < idx.indexOf('id="btn-test-price-sources"'), '');
  check('test button: the node card Save button is orange (class primary, static HTML)',
    idx.indexOf('id="btn-btc-save-nodes" class="primary"') !== -1, '');
  check('test button: the node card Test connection button is grey (no class primary, static HTML)',
    idx.indexOf('id="btn-btc-test-conn"') !== -1 && idx.indexOf('id="btn-btc-test-conn" class="primary"') === -1, '');
  check('test button: the price sources Save button is orange (class primary, static HTML)',
    idx.indexOf('id="btn-save-price-sources" class="primary"') !== -1, '');
  check('test button: the price sources Test connection button is grey (no class primary, static HTML)',
    idx.indexOf('id="btn-test-price-sources"') !== -1 && idx.indexOf('id="btn-test-price-sources" class="primary"') === -1, '');
  check('test button: there are NO per-source Test buttons (static HTML)',
    idx.indexOf('id="btn-test-price-source1"') === -1 && idx.indexOf('id="btn-test-price-source2"') === -1, '');
  check('test button: there is NO results line under the Test button (static HTML — the prices live on the rows)',
    idx.indexOf('id="price-sources-test"') === -1, '');
  check('test button: there are NO per-source result spans (static HTML)',
    idx.indexOf('id="price-source1-test"') === -1 && idx.indexOf('id="price-source2-test"') === -1, '');
  // Clicking Test connection fetches BOTH selected providers
  // fresh and shows both prices inline on the rows (the stub
  // price is $98,200).
  els['btn-test-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('test button: Test connection shows BOTH prices to the right of the pills ("CoinGecko [OK] $98,200" and "Coinbase [OK] $98,200")',
    els['price-source1'] && els['price-source1'].textContent.indexOf('CoinGecko') !== -1 && els['price-source1'].textContent.indexOf('$') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200'
    && els['price-source2'] && els['price-source2'].textContent.indexOf('Coinbase') !== -1 && els['price-source2'].textContent.indexOf('$') === -1
    && els['price-source2-price'] && els['price-source2-price'].textContent === '$98,200',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent) + ' / ' + (els['price-source2'] && els['price-source2'].textContent) + ' / ' + (els['price-source2-price'] && els['price-source2-price'].textContent));
  // A successful test sets both status pills to OK — the rows
  // never sit on '—' after a test.
  check('test button: after a successful test both status pills read OK',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok'
    && els['price-source2-status'] && els['price-source2-status'].textContent === 'OK' && els['price-source2-status'].className === 'pill ok',
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));
  // The button tests the providers the dropdowns currently
  // hold — the ones the row labels show. Change Primary price source to
  // Kraken (its label follows, see section 9) and Test
  // connection must test Kraken, not the saved CoinGecko.
  els['set-price-source1'].value = 'kraken';
  fireChange(els['set-price-source1']);
  els['btn-test-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('test button: Test connection follows the displayed provider — after switching Primary price source to Kraken its row reads Kraken [OK] $98,200',
    els['price-source1'] && els['price-source1'].textContent.indexOf('Kraken') !== -1
    && els['price-source1'].textContent.indexOf('CoinGecko') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent));
  // The change-then-test flow: switching Primary price source to Kraken
  // reset its pill to Not Tested, and the test that followed
  // set it back to OK (Kraken answered with a price).
  check('test button: after testing the switched Primary price source (Kraken) its status pill reads OK',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  check('test button: the untouched Secondary price source pill still reads OK after the Kraken test',
    els['price-source2-status'] && els['price-source2-status'].textContent === 'OK',
    els['price-source2-status'] && els['price-source2-status'].textContent);
  // The save bug: a source tested OK must STAY OK after
  // saving. Change → Test → Save used to flip the row back
  // to Not Tested (the Save handler cleared the verdict and
  // the re-render found no cached reading for the newly-saved
  // source). Save Kraken + Coinbase now — both pills must
  // stay OK, not flip to Not Tested.
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stSavedKraken = await (await fetch('/api/state')).json();
  check('price sources: saving Kraken + Coinbase after testing persists in /api/state',
    stSavedKraken.settings && stSavedKraken.settings.priceSources && stSavedKraken.settings.priceSources.source1 === 'kraken' && stSavedKraken.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stSavedKraken.settings && stSavedKraken.settings.priceSources));
  check('price sources: after a test-then-save the tested Primary price source (Kraken) status pill STAYS OK (not Not Tested)',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  check('price sources: after a test-then-save the tested Secondary price source (Coinbase) status pill STAYS OK',
    els['price-source2-status'] && els['price-source2-status'].textContent === 'OK' && els['price-source2-status'].className === 'pill ok',
    els['price-source2-status'] && els['price-source2-status'].textContent + ' / ' + els['price-source2-status'].className);
  // Changing the dropdown AFTER saving still resets that row
  // to Not Tested until it is tested again.
  els['set-price-source1'].value = 'bitstamp';
  fireChange(els['set-price-source1']);
  check('price sources: changing the Primary price source dropdown after saving resets its status pill to Not Tested',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'Not Tested' && els['price-source1-status'].className === 'pill muted',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  // Restore the defaults (CoinGecko + Coinbase) so the rest of
  // the suite — and the Exchange Status rows below — see the
  // default sources again.
  els['set-price-source1'].value = 'coingecko';
  els['set-price-source2'].value = 'coinbase';
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stRestored2 = await (await fetch('/api/state')).json();
  check('price sources: the defaults are restored after the save test (CoinGecko + Coinbase)',
    stRestored2.settings && stRestored2.settings.priceSources && stRestored2.settings.priceSources.source1 === 'coingecko' && stRestored2.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stRestored2.settings && stRestored2.settings.priceSources));
  // Restore the dropdown (unsaved — the saved sources are
  // still CoinGecko + Coinbase).
  els['set-price-source1'].value = 'coingecko';
  fireChange(els['set-price-source1']);
  // Custom price source (0.8.1): the dropdowns offer Custom, and
  // selecting it reveals the URL + JSON-path inputs for that row.
  check('custom price source: the card has URL + JSON-path inputs for both rows (static HTML)',
    idx.indexOf('id="set-price-source1-url"') !== -1 && idx.indexOf('id="set-price-source1-path"') !== -1
    && idx.indexOf('id="set-price-source2-url"') !== -1 && idx.indexOf('id="set-price-source2-path"') !== -1, '');
  check('custom price source: the custom inputs are hidden while a built-in is selected',
    els['price-source1-custom'] && els['price-source1-custom'].style.display === 'none'
    && els['price-source2-custom'] && els['price-source2-custom'].style.display === 'none',
    (els['price-source1-custom'] && els['price-source1-custom'].style.display) + ' / ' + (els['price-source2-custom'] && els['price-source2-custom'].style.display));
  els['set-price-source1'].value = 'custom';
  fireChange(els['set-price-source1']);
  check('custom price source: selecting Custom reveals the Primary row inputs',
    els['price-source1-custom'] && els['price-source1-custom'].style.display !== 'none',
    els['price-source1-custom'] && els['price-source1-custom'].style.display);
  check('custom price source: selecting Custom resets the Primary row to Not Tested with no price',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'Not Tested'
    && els['price-source1'] && els['price-source1'].textContent === 'Custom',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-status'] && els['price-source1-status'].textContent));
  // The URL + JSON-path inputs are created lazily (app.js only
  // looks them up once a Custom source is read), so force them
  // into existence before filling them in.
  const customUrl = document.getElementById('set-price-source1-url');
  const customPath = document.getElementById('set-price-source1-path');
  customUrl.value = 'http://127.0.0.1:18235/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
  customPath.value = 'bitcoin.usd';
  els['btn-test-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('custom price source: Test shows the custom price to the right of the pill (Custom [OK] $98,200)',
    els['price-source1'] && els['price-source1'].textContent.indexOf('Custom') !== -1 && els['price-source1'].textContent.indexOf('$') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent));
  check('custom price source: the tested Custom row pill reads OK',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok',
    els['price-source1-status'] && els['price-source1-status'].textContent);
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stCustom = await (await fetch('/api/state')).json();
  check('custom price source: saving stores the custom object in /api/state',
    stCustom.settings && stCustom.settings.priceSources
    && JSON.stringify(stCustom.settings.priceSources.source1) === JSON.stringify({ id: 'custom', url: 'http://127.0.0.1:18235/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', path: 'bitcoin.usd' })
    && stCustom.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stCustom.settings && stCustom.settings.priceSources));
  check('custom price source: the tested Custom row STAYS OK with its price after saving',
    els['price-source1'] && els['price-source1'].textContent.indexOf('Custom') !== -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200'
    && els['price-source1-status'] && els['price-source1-status'].textContent === 'OK',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent) + ' / ' + (els['price-source1-status'] && els['price-source1-status'].textContent));
  // Restore the defaults so the failing-provider section sees them.
  els['set-price-source1'].value = 'coingecko';
  els['set-price-source2'].value = 'coinbase';
  els['btn-save-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stCustomRestored = await (await fetch('/api/state')).json();
  check('custom price source: the defaults are restored after the custom save test',
    stCustomRestored.settings && stCustomRestored.settings.priceSources && stCustomRestored.settings.priceSources.source1 === 'coingecko' && stCustomRestored.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stCustomRestored.settings && stCustomRestored.settings.priceSources));
  check('custom price source: the custom inputs hide again once a built-in is selected',
    els['price-source1-custom'] && els['price-source1-custom'].style.display === 'none',
    els['price-source1-custom'] && els['price-source1-custom'].style.display);
  // A failing provider shows the failure inline, with the
  // error — while the other source still shows its price.
  const failCg = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: true }) });
  check('test button: the stub CoinGecko feed is set to fail', failCg.status === 200, 'status=' + failCg.status);
  els['btn-test-price-sources'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('test button: Test connection on a failing CoinGecko drops its price from the row (name only, price span empty)',
    els['price-source1'] && els['price-source1'].textContent.indexOf('CoinGecko') !== -1
    && els['price-source1'].textContent.indexOf('$') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '',
    (els['price-source1'] && els['price-source1'].textContent) + ' / price=[' + (els['price-source1-price'] && els['price-source1-price'].textContent) + ']');
  check('test button: Test connection still shows the working source price to the right of the pill (Coinbase [OK] $98,200) when CoinGecko fails',
    els['price-source2'] && els['price-source2'].textContent.indexOf('Coinbase') !== -1
    && els['price-source2-price'] && els['price-source2-price'].textContent === '$98,200',
    (els['price-source2'] && els['price-source2'].textContent) + ' / ' + (els['price-source2-price'] && els['price-source2-price'].textContent));
  // A failing test sets that row's pill to Failed (not a dash,
  // and not the error text — the row shows the verdict, not the
  // reason), while the working row keeps its price and stays OK.
  check('test button: after a failing test the failed row status pill reads Failed',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'Failed' && els['price-source1-status'].className === 'pill bad',
    els['price-source1-status'] && els['price-source1-status'].textContent + ' / ' + els['price-source1-status'].className);
  check('test button: after a failing test the working row status pill still reads OK',
    els['price-source2-status'] && els['price-source2-status'].textContent === 'OK',
    els['price-source2-status'] && els['price-source2-status'].textContent);
  check('test button: no status pill shows a dash or an error reason after the failing test',
    els['price-source1-status'] && els['price-source1-status'].textContent.indexOf('—') === -1 && els['price-source1-status'].textContent.indexOf('answered') === -1
    && els['price-source2-status'] && els['price-source2-status'].textContent.indexOf('—') === -1,
    (els['price-source1-status'] && els['price-source1-status'].textContent) + ' / ' + (els['price-source2-status'] && els['price-source2-status'].textContent));
  const unFailCg = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: false }) });
  check('test button: the stub CoinGecko feed is restored', unFailCg.status === 200, 'status=' + unFailCg.status);
  // Exchange Status: exactly one section on the readiness card,
  // shown once (not repeated per price tx). The seeded state has
  // both sources agreeing at $98,200, so it reads OK.
  check('exchange status: the readiness card has exactly one "Exchange Status" section (static HTML)',
    (idx.match(/Exchange Status/g) || []).length === 1, 'count=' + (idx.match(/Exchange Status/g) || []).length);
  // Alignment: the per-exchange rows sit in a .node-lines
  // container — the SAME class/structure as the Node Status rows
  // — so their status pills are pinned to the same right edge
  // (the width check proves the x positions match at 390px).
  const nodeLinesCount = (idx.match(/class="node-lines"/g) || []).length;
  check('exchange status: the per-exchange rows use the same .node-lines container as the Node rows (2 blocks: Node + Exchange)',
    nodeLinesCount === 2, 'count=' + nodeLinesCount);
  const exLinesIdx = idx.lastIndexOf('class="node-lines"', idx.indexOf('id="readiness-exchange-1"'));
  check('exchange status: the exchange rows sit inside a .node-lines block (no closing div between it and row 1)',
    exLinesIdx !== -1 && idx.slice(exLinesIdx, idx.indexOf('id="readiness-exchange-1"')).indexOf('</div>') === -1, '');
  check('exchange status: the section is visible while a price rule exists',
    els['readiness-exchange-item'] && els['readiness-exchange-item'].style.display !== 'none',
    els['readiness-exchange-item'] && els['readiness-exchange-item'].style.display);
  // There is NO overall agreement pill next to the header:
  // the status (OK / Failed) lives only on each exchange row.
  check('exchange status: there is NO agreement pill next to the Exchange Status header (static HTML)',
    idx.indexOf('id="readiness-exchange-status"') === -1, '');
  check('exchange status: no header pill element exists in the DOM',
    !els['readiness-exchange-status'], els['readiness-exchange-status'] ? 'present' : 'absent');
  check('exchange status: each row has a price value span to the left of the pill (static HTML)',
    idx.indexOf('id="readiness-exchange-1-price" class="node-check-detail"') !== -1 && idx.indexOf('id="readiness-exchange-2-price" class="node-check-detail"') !== -1, '');
  // Per-exchange rows: one row per configured source, each with
  // its own status pill and last price — the price in a small
  // muted span to the LEFT of the pill, the same shape as the
  // Settings rows (never inside the label span). The pill stays
  // pinned to the right edge, with the Node pills. There is no
  // overall pill on the header; the rows carry the status.
  check('exchange status: the section has a row for CoinGecko (row 1), price to the left of the pill (CoinGecko $98,200 [OK])',
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent.indexOf('CoinGecko') !== -1
    && els['readiness-exchange-1'].textContent.indexOf('$') === -1
    && els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent === '$98,200',
    (els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent) + ' / ' + (els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent));
  check('exchange status: the CoinGecko row pill reads OK',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent === 'OK',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent);
  check('exchange status: the CoinGecko row pill uses the ok class',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className === 'pill ok',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className);
  check('exchange status: the section has a row for Coinbase (row 2), price to the left of the pill (Coinbase $98,200 [OK])',
    els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent.indexOf('Coinbase') !== -1
    && els['readiness-exchange-2'].textContent.indexOf('$') === -1
    && els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent === '$98,200',
    (els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent) + ' / ' + (els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent));
  check('exchange status: the Coinbase row pill reads OK',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent === 'OK',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent);
  check('exchange status: the Coinbase row pill uses the ok class',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].className === 'pill ok',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].className);
  // The per-tx price readiness line is trigger-only — it does
  // NOT repeat the exchange/source status. The price subcard is
  // exactly 3 rows (header / condition / current price only) and
  // carries NO source note either — the source detail lives in
  // the Exchange Status section and the dry-run notes.
  const rbPrice = readinessBlock('Dom Price');
  check('exchange status: the Dom Price readiness line is trigger-only (no source names)',
    !!rbPrice && rbPrice.state.indexOf('CoinGecko') === -1 && rbPrice.state.indexOf('Coinbase') === -1 && rbPrice.state.indexOf('·') === -1,
    rbPrice ? rbPrice.state : 'no block');
  check('exchange status: the Dom Price readiness line is its condition now ("Fires when BTC price ≥ $150,000") — the current price lives on the subcard, not the readiness line',
    !!rbPrice && rbPrice.state === 'Fires when BTC price \u2265 $150,000', rbPrice ? rbPrice.state : 'no block');
  const priceCard2 = cardByTitle('Dom Price');
  const partsPrice = priceCard2 && triggerParts(priceCard2);
  check('exchange status: the Dom Price subcard has exactly 3 rows',
    !!partsPrice && partsPrice.box && partsPrice.box.children.length === 3,
    partsPrice ? 'children=' + partsPrice.box.children.length : 'no subcard');
  check('exchange status: the Dom Price subcard row 1 is the header "TRIGGER - BTC PRICE"',
    !!partsPrice && partsPrice.k === 'TRIGGER - BTC PRICE', partsPrice ? partsPrice.k : 'no subcard');
  check('exchange status: the Dom Price subcard row 2 is the condition "Fires when BTC price ≥ $150,000"',
    !!partsPrice && partsPrice.cond === 'Fires when BTC price \u2265 $150,000', partsPrice ? partsPrice.cond : 'no subcard');
  check('exchange status: the Dom Price subcard row 3 is only the current price "BTC price currently $98,200"',
    !!partsPrice && partsPrice.now === 'BTC price currently $98,200', partsPrice ? partsPrice.now : 'no subcard');
  check('exchange status: the Dom Price subcard row 3 has no source note (no provider names, no parenthesis)',
    !!partsPrice && partsPrice.now.indexOf('CoinGecko') === -1 && partsPrice.now.indexOf('Coinbase') === -1
    && partsPrice.now.indexOf('(') === -1 && partsPrice.now.indexOf('·') === -1,
    partsPrice ? partsPrice.now : 'no subcard');
  // A dry run of the price tx surfaces the source detail in its
  // notes — that is where all dry-run data shows up. Click
  // Dry-run on the Dom Price card and read the dry-run line.
  const priceDry = priceCard2 && cardButton(priceCard2, 'Dry-run');
  check('dry-run source detail: the Dom Price card has a Dry-run button', !!priceDry, '');
  if (priceDry) priceDry.click();
  await new Promise((r) => setTimeout(r, 2500));
  const priceCard3 = cardByTitle('Dom Price');
  let dryLine = '';
  if (priceCard3) {
    for (const c of priceCard3.children) {
      if (c.className && c.className.split(' ').includes('tx-dryrun')) dryLine = c.textContent || '';
    }
  }
  check('dry-run source detail: a dry run of the price tx shows the source detail in its notes',
    dryLine.indexOf('Price sources: CoinGecko $98,200 · Coinbase $98,200') !== -1, dryLine || 'no dry-run line');
  // Degraded: one source down. The price cache is fresh for 1
  // min, so wait past it (the fast tick refreshes it), then a
  // release check + re-render shows the degraded pill.
  const failCg2 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: true }) });
  check('exchange status: the stub CoinGecko feed is set to fail (degraded)', failCg2.status === 200, 'status=' + failCg2.status);
  await new Promise((r) => setTimeout(r, 65000));
  const relDeg = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the cache goes stale (degraded)', relDeg.status === 200, 'status=' + relDeg.status);
  await rerender(appJs);
  // Degraded: one source down. The per-exchange rows carry the
  // failure (CoinGecko Failed, Coinbase OK) — there is still no
  // overall pill on the header.
  // Degraded: the CoinGecko row pill reads Failed and the
  // Coinbase row stays OK with its price. The readiness row
  // shows ONLY the status — never the error reason (that detail
  // lives in the Settings card only).
  check('exchange status: the CoinGecko row pill reads Failed when it is down',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent === 'Failed',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent);
  check('exchange status: the CoinGecko row pill uses the bad class when down',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className === 'pill bad',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className);
  check('exchange status: the CoinGecko row does NOT name the error when it is down (no "answered" / HTTP code text)',
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent.indexOf('answered') === -1
    && els['readiness-exchange-1'].textContent.indexOf('500') === -1,
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent);
  check('exchange status: the CoinGecko row drops its price when it is down (price span empty)',
    els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent === '',
    els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent);
  check('exchange status: the CoinGecko row still names the exchange when it is down',
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent.indexOf('CoinGecko') !== -1,
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent);
  check('exchange status: the Coinbase row stays OK with its price in single-source mode',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent === 'OK'
    && els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent.indexOf('Coinbase') !== -1
    && els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent === '$98,200',
    (els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent) + ' / ' + (els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent));
  const rbDeg = readinessBlock('Dom Price');
  check('exchange status: the Dom Price readiness line stays trigger-only in single-source mode',
    !!rbDeg && rbDeg.state.indexOf('CoinGecko') === -1 && rbDeg.state.indexOf('Coinbase') === -1,
    rbDeg ? rbDeg.state : 'no block');
  const unFailCg2 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: false }) });
  check('exchange status: the stub CoinGecko feed is restored (degraded)', unFailCg2.status === 200, 'status=' + unFailCg2.status);
  // Error: the sources disagree by more than 5%. Same wait for
  // the cache to go stale, then a release check + re-render.
  const setDis1 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', usd: 100000 }) });
  check('exchange status: the stub CoinGecko is set to $100,000 (disagree)', setDis1.status === 200, 'status=' + setDis1.status);
  const setDis2 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coinbase', usd: 106000 }) });
  check('exchange status: the stub Coinbase is set to $106,000 (6% apart)', setDis2.status === 200, 'status=' + setDis2.status);
  await new Promise((r) => setTimeout(r, 65000));
  const relDis = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the cache goes stale (disagree)', relDis.status === 200, 'status=' + relDis.status);
  await rerender(appJs);
  // Disagree: each source is up, so each row pill stays OK and
  // shows its own price; there is still no overall pill.
  check('exchange status: the CoinGecko row still shows $100,000 and OK when the sources disagree',
    els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent === '$100,000'
    && els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent === 'OK',
    (els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent) + ' / ' + (els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent));
  check('exchange status: the Coinbase row still shows $106,000 and OK when the sources disagree',
    els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent === '$106,000'
    && els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent === 'OK',
    (els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent) + ' / ' + (els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent));
  const rbDis = readinessBlock('Dom Price');
  check('exchange status: the Dom Price readiness line stays its condition when the sources disagree (no feed state on the line)',
    !!rbDis && rbDis.state === 'Fires when BTC price \u2265 $150,000', rbDis ? rbDis.state : 'no block');
  // Restore the stub so the suite ends on the default.
  const setBack1 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', usd: 98200 }) });
  check('exchange status: the stub CoinGecko is restored to $98,200', setBack1.status === 200, 'status=' + setBack1.status);
  const setBack2 = await realFetch('http://127.0.0.1:18235/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coinbase', usd: 98200 }) });
  check('exchange status: the stub Coinbase is restored to $98,200', setBack2.status === 200, 'status=' + setBack2.status);

  // --- 10b. node capability details, variant C: summary row + details on tap (0.8.1) ---
  // Static HTML: each node is a <details> — the summary is just
  // the node name + status pill, and the detail holds the three
  // checks as plain label — value lines (no pills).
  for (const lbl of ['primary', 'secondary']) {
    check('node checks static: the ' + lbl + ' node is a <details> with a capability block (static HTML)',
      idx.indexOf('<details id="btc-' + lbl + '-details" class="node-details">') !== -1
      && idx.indexOf('id="btc-' + lbl + '-checks"') !== -1, '');
    check('node checks static: the ' + lbl + ' detail has Broadcast / Fee estimates / Block height value spans (static HTML)',
      idx.indexOf('id="btc-' + lbl + '-broadcast-value"') !== -1
      && idx.indexOf('id="btc-' + lbl + '-fees-value"') !== -1
      && idx.indexOf('id="btc-' + lbl + '-height-value"') !== -1, '');
    check('node checks static: the ' + lbl + ' detail has no per-check pills (static HTML)',
      idx.indexOf('id="btc-' + lbl + '-broadcast"') === -1
      && idx.indexOf('id="btc-' + lbl + '-fees"') === -1
      && idx.indexOf('id="btc-' + lbl + '-height"') === -1, '');
  }
  check('node checks static: the capability labels read Broadcast / Fee estimates / Block height (static HTML)',
    (idx.match(/>Broadcast</g) || []).length >= 2 && (idx.match(/>Fee estimates</g) || []).length >= 2 && (idx.match(/>Block height</g) || []).length >= 2, '');
  // Dynamic: the launcher ran a connection test against both
  // stubs (full mempool-style nodes), so both nodes are OK and
  // the detail holds the measured values — in the Settings card
  // and on the Dashboard's Node Status rows. Stub TIP is 900,000
  // and the stub economy fee is 1 sat/vB. OK nodes stay closed
  // (only a non-OK node auto-opens after a test).
  await rerender(appJs);
  for (const lbl of ['primary', 'secondary']) {
    check('node checks: the ' + lbl + ' pill reads OK after the connection test',
      els['btc-' + lbl + '-status'] && els['btc-' + lbl + '-status'].textContent === 'OK',
      els['btc-' + lbl + '-status'] && els['btc-' + lbl + '-status'].textContent);
    check('node checks: the ' + lbl + ' capability block is visible after the connection test',
      els['btc-' + lbl + '-checks'] && els['btc-' + lbl + '-checks'].style.display !== 'none',
      els['btc-' + lbl + '-checks'] && els['btc-' + lbl + '-checks'].style.display);
    check('node checks: the ' + lbl + ' Broadcast value reads Reachable',
      els['btc-' + lbl + '-broadcast-value'] && els['btc-' + lbl + '-broadcast-value'].textContent === 'Reachable',
      els['btc-' + lbl + '-broadcast-value'] && els['btc-' + lbl + '-broadcast-value'].textContent);
    check('node checks: the ' + lbl + ' Fee estimates value reads 1 sat/vB',
      els['btc-' + lbl + '-fees-value'] && els['btc-' + lbl + '-fees-value'].textContent === '1 sat/vB',
      els['btc-' + lbl + '-fees-value'] && els['btc-' + lbl + '-fees-value'].textContent);
    check('node checks: the ' + lbl + ' Block height value reads Height 900,000',
      els['btc-' + lbl + '-height-value'] && els['btc-' + lbl + '-height-value'].textContent === 'Height 900,000',
      els['btc-' + lbl + '-height-value'] && els['btc-' + lbl + '-height-value'].textContent);
    check('node checks: the Dashboard Node Status ' + lbl + ' pill reads OK too',
      els['readiness-' + lbl + '-status'] && els['readiness-' + lbl + '-status'].textContent === 'OK',
      els['readiness-' + lbl + '-status'] && els['readiness-' + lbl + '-status'].textContent);
    const det = document.getElementById('btc-' + lbl + '-details');
    check('node checks: the ' + lbl + ' details stay closed for an OK node after the connection test',
      det && det.open !== true, det ? 'open=' + det.open : 'no details el');
  }
  // Behaviour: the details open and close on tap.
  const detP = document.getElementById('btc-primary-details');
  toggleDetails(detP, true);
  check('node checks: opening the primary details shows the checks', detP.open === true, 'open=' + detP.open);
  toggleDetails(detP, false);
  check('node checks: closing the primary details hides them again', detP.open === false, 'open=' + detP.open);

  // --- 11. Staged Transactions card (0.8.0) ---
  // Static HTML: the transactions card is renamed "Staged
  // Transactions" and is a <details> open by default — the whole
  // card collapses, like Pending and Archived.
  check('staged card: the card is titled "Staged Transactions" (static HTML)',
    idx.indexOf('Staged Transactions') !== -1 && idx.indexOf('id="btc-card"') !== -1, '');
  check('staged card: the old "Pre-signed Bitcoin transactions" title is gone (static HTML)',
    idx.indexOf('Pre-signed Bitcoin transactions') === -1, '');
  const btcTag = (idx.match(/<details[^>]*id="btc-card"[^>]*>/) || [''])[0];
  check('staged card: the card is a <details> open by default (static HTML)',
    btcTag.indexOf('<details') === 0 && btcTag.indexOf(' open') !== -1, btcTag);
  // Behaviour: the card starts open, collapses, and reopens.
  const btcCard = document.getElementById('btc-card');
  btcCard.open = true; // the HTML ships with the open attribute (verified above)
  check('staged card: open by default', btcCard.open === true, 'open=' + btcCard.open);
  toggleDetails(btcCard, false);
  check('staged card: collapsing closes it', btcCard.open === false, 'open=' + btcCard.open);
  toggleDetails(btcCard, true);
  check('staged card: expanding reopens it', btcCard.open === true, 'open=' + btcCard.open);

  // --- 11b. Add-transaction popup (0.8.0) ---
  // The inline "Add a transaction" card at the bottom of the tab is
  // gone; the form lives in a popup (#add-modal). Three buttons open
  // it: the Getting Started button, the "+ Add a pre-signed
  // transaction" button at the bottom of the tab, and the oval
  // "+ Add Tx" in this card's header. "Broadcast all" is gone
  // again (removed Nov 16 — too close to the pill).
  check('add popup static: the oval "+ Add Tx" pill is in the Staged header',
    idx.indexOf('id="btn-btc-add-pill"') !== -1 && idx.indexOf('+ Add Tx') !== -1, '');
  check('add popup static: the pill is an oval (add-tx-pill class)',
    idx.indexOf('class="add-tx-pill"') !== -1, '');
  check('add popup static: the bottom open button reads "+ Add a pre-signed transaction"',
    idx.indexOf('id="btn-btc-add-open"') !== -1 && idx.indexOf('id="btn-btc-add-open" class="primary add-open-full"') !== -1, '');
  check('add popup static: the Add modal exists with the form inside',
    idx.indexOf('id="add-modal"') !== -1 && idx.indexOf('id="btc-hex"') !== -1
    && idx.indexOf('id="btc-rules-list"') !== -1 && idx.indexOf('id="btn-btc-add"') !== -1, '');
  check('add popup static: the inline Add form card is gone (no btc-form-title outside the modal)',
    idx.indexOf('id="btc-form-title"') !== -1 && idx.indexOf('id="add-modal"') < idx.indexOf('id="btc-form-title"'), '');
  check('add popup static: "Broadcast all" is gone (no such button)',
    idx.indexOf('btn-btc-broadcast-all') === -1 && idx.indexOf('Broadcast all') === -1, '');
  check('add popup static: "Broadcast armed" stays',
    idx.indexOf('id="btn-btc-broadcast-armed"') !== -1, '');
  // The pill opens the popup. Its click is stopped before it reaches
  // the summary, so the card stays open.
  els['btn-btc-add-pill'].click();
  check('add popup: the "+ Add Tx" pill opens the popup',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  check('add popup: opening it from the pill does NOT collapse the Staged card',
    btcCard.open === true, 'open=' + btcCard.open);
  // The X closes it.
  els['add-modal-x'].click();
  check('add popup: the X closes the popup',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  // The bottom open button opens it too.
  els['btn-btc-add-open'].click();
  check('add popup: the bottom "+ Add a pre-signed transaction" button opens the popup',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  els['btn-btc-add-cancel'].click();
  check('add popup: Cancel closes the popup',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');

  // --- 12. the status pill: "armed", not "Ready + armed" (0.8.0) ---
  // A healthy armed tx reads just "armed" — "Ready" is redundant,
  // since a problem state already names itself. A shared-input
  // overlap keeps the text but turns the pill amber (the warning
  // lives in the line below, not in the pill). A genuine problem
  // state reads "Label + armed". Disarmed stays "unarmed".
  // The seven seeded txs all spend FINNEY:1, so they all share an
  // input: their CARD pills are amber, while their READINESS pills
  // stay green (the shared-input tweak is card-only).
  for (const label of ['Dom Check-in', 'Dom Price', 'Dom UTXO', 'Dom Manual']) {
    const card = cardByTitle(label);
    const pill = card && cardStatus(card);
    check('pill 0.8.0: "' + label + '" card pill reads just "armed" (shared input, amber)',
      !!pill && pill.textContent === 'armed' && pill.className === 'pill warn',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
    const rb = readinessBlock(label);
    check('pill 0.8.0: "' + label + '" readiness pill reads just "armed" (green)',
      !!rb && rb.status === 'armed' && rb.statusCls === 'pill ok',
      rb ? rb.status + ' / ' + rb.statusCls : 'no block');
  }
  // A healthy tx with a unique input (FINNEY:2, spent by no other
  // tx) reads "armed" on a GREEN card pill.
  const addHealthy = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(2, 200101), label: 'Dom Pill healthy', trigger: { type: 'manual', params: {} } }) });
  check('pill 0.8.0: a tx with a unique input adds via the API', addHealthy.status === 201, 'status=' + addHealthy.status);
  const healthyJson = addHealthy.status === 201 ? await addHealthy.json() : {};
  const healthyId = (healthyJson.tx || {}).id || null;
  await rerender(appJs);
  const healthyCard = cardByTitle('Dom Pill healthy');
  const healthyPill = healthyCard && cardStatus(healthyCard);
  check('pill 0.8.0: the healthy tx card pill reads "armed" on green',
    !!healthyPill && healthyPill.textContent === 'armed' && healthyPill.className === 'pill ok',
    healthyPill ? healthyPill.textContent + ' / ' + healthyPill.className : 'no pill');
  const healthyRb = readinessBlock('Dom Pill healthy');
  check('pill 0.8.0: the healthy tx readiness pill reads "armed" on green',
    !!healthyRb && healthyRb.status === 'armed' && healthyRb.statusCls === 'pill ok',
    healthyRb ? healthyRb.status + ' / ' + healthyRb.statusCls : 'no block');
  // Disarming it reads "unarmed" (unchanged by this change); re-arm
  // so the instance ends as it started.
  const disH = healthyId ? await fetch('/api/bitcoin/txs/' + healthyId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }) : null;
  check('pill 0.8.0: disarming the healthy tx via the API', !!disH && disH.status === 200, disH ? 'status=' + disH.status : 'no id');
  await rerender(appJs);
  const disPill = cardByTitle('Dom Pill healthy') && cardStatus(cardByTitle('Dom Pill healthy'));
  check('pill 0.8.0: the disarmed tx card pill reads "unarmed"',
    !!disPill && disPill.textContent === 'unarmed',
    disPill ? disPill.textContent + ' / ' + disPill.className : 'no pill');
  const rearmH = healthyId ? await fetch('/api/bitcoin/txs/' + healthyId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }) : null;
  check('pill 0.8.0: re-arming the healthy tx via the API', !!rearmH && rearmH.status === 200, rearmH ? 'status=' + rearmH.status : 'no id');
  await rerender(appJs);
  // A genuine problem state: a timelocked tx (locktime 950000, tip
  // 900000) reads "Timelocked + armed" once a dry run names it.
  // FINNEY:3 is spent by no other tx, so the pill is green until
  // the dry run — the amber there would be the timelock itself.
  const addTl = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftLocktimeHex(3, 950000, 200103), label: 'Dom Pill timelocked', trigger: { type: 'manual', params: {} } }) });
  check('pill 0.8.0: the timelocked tx adds via the API', addTl.status === 201, 'status=' + addTl.status);
  await rerender(appJs);
  const tlCard = cardByTitle('Dom Pill timelocked');
  const tlDry = tlCard && cardButton(tlCard, 'Dry-run');
  check('pill 0.8.0: the timelocked card has a Dry-run button', !!tlDry, '');
  if (tlDry) tlDry.click();
  await new Promise((r) => setTimeout(r, 2500));
  const tlCard2 = cardByTitle('Dom Pill timelocked');
  const tlPill = tlCard2 && cardStatus(tlCard2);
  check('pill 0.8.0: the timelocked tx pill reads "Timelocked + armed"',
    !!tlPill && tlPill.textContent === 'Timelocked + armed',
    tlPill ? tlPill.textContent + ' / ' + tlPill.className : 'no pill');
  const tlRb = readinessBlock('Dom Pill timelocked');
  check('pill 0.8.0: the timelocked readiness pill reads "Timelocked + armed"',
    !!tlRb && tlRb.status === 'Timelocked + armed',
    tlRb ? tlRb.status + ' / ' + tlRb.statusCls : 'no block');

  // --- 13. readiness row layout: a very long label ---
  // The shim cannot measure layout, so this section only proves
  // the long-label tx renders in the readiness list (full label
  // + a correct state line) and stays armed. The width check
  // (width_check095.js, real Playwright at 390px) proves the row
  // itself stays one line with the label truncated by ellipsis.
  // (The server caps labels at 80 chars — asStr(label, 80) — so
  // the stored/rendered label is the first 80 chars of the input.)
  const LONG_LABEL = 'A very long transaction label that must be truncated with an ellipsis on the readiness row, never wrapping the status pill';
  const STORED_LABEL = LONG_LABEL.slice(0, 80);
  const longAdd = await realFetch(BASE + '/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(4, 200105), label: LONG_LABEL, trigger: { type: 'manual', params: {} } }) });
  check('readiness rows: the long-label tx adds (201)', longAdd.status === 201, 'status=' + longAdd.status);
  await rerender(appJs);
  const longRb = readinessBlock(STORED_LABEL);
  check('readiness rows: the long-label tx renders in the readiness list with its stored (80-char) label',
    !!longRb && longRb.label === STORED_LABEL, longRb ? longRb.label : 'no block');
  check('readiness rows: the long-label row state line reads "Never fires — manual only"',
    !!longRb && longRb.state === 'Never fires \u2014 manual only',
    longRb ? longRb.state : 'no block');
  check('readiness rows: the long-label row status pill reads "armed"',
    !!longRb && longRb.status === 'armed', longRb ? longRb.status : 'no block');

  // --- 14. held window + shared check-in reset (0.8.0) ---
  // Backdate the clock 40 days with a hold 12 days out (a direct
  // state.json edit, like the API suite's seed): both bars read
  // 40 of 52 — the EFFECTIVE window, not their own thresholds —
  // with no "Grace period" text and the pill still "On track".
  // The shared Check in button then resets both bars to 0.
  const heldSt = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const heldNow = Date.now();
  // The 30 s margin keeps the floored day count exact: the
  // backdate is 40 days AND 30 seconds ago, so the elapsed
  // time is a hair OVER 40 days even after the few hundred ms
  // of freeze offset banked when the 10d tx was disarmed and
  // re-armed earlier in the suite (same ms boundary as the
  // API suite's §16 held leg, where iso_ago(days=40,
  // seconds=30) does the same thing).
  heldSt.checkin.lastCheckinAt = new Date(heldNow - 40 * 86400000 - 30000).toISOString();
  heldSt.checkin.lastOnlineAt = new Date(heldNow - 40 * 86400000).toISOString();
  heldSt.checkin.heldUntil = new Date(heldNow + 12 * 86400000).toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(heldSt, null, 2) + '\n');
  await rerender(appJs);
  const heldBar35 = checkinBar('Dom Check-in');
  const heldBar10 = checkinBar('Dom Check-in 10d');
  check('held bars: the 35d bar reads "40 of 52 days elapsed" (the longer held window)',
    !!heldBar35 && heldBar35.caption === '40 of 52 days elapsed', heldBar35 ? heldBar35.caption : 'no bar');
  check('held bars: the 10d bar reads "40 of 52 days elapsed" too (the hold outruns its own due)',
    !!heldBar10 && heldBar10.caption === '40 of 52 days elapsed', heldBar10 ? heldBar10.caption : 'no bar');
  check('held bars: the 35d bar fill is ~77% wide (40/52)',
    !!heldBar35 && Math.abs(heldBar35.width - 40 / 52 * 100) < 0.5, heldBar35 ? heldBar35.width : 'no bar');
  check('held bars: the status pill still reads "On track" — no grace state',
    els['status-pill'] && els['status-pill'].textContent === 'On track',
    els['status-pill'] && els['status-pill'].textContent);
  check('held bars: no "Grace period" text on the status pill or the bar captions',
    els['status-pill'] && els['status-pill'].textContent.indexOf('Grace') === -1
    && !!heldBar35 && heldBar35.caption.indexOf('Grace') === -1
    && !!heldBar10 && heldBar10.caption.indexOf('Grace') === -1, '');
  // The shared Check in button resets every bar to 0.
  els['btn-checkin'].click();
  await new Promise((r) => setTimeout(r, 1500));
  await rerender(appJs);
  const resetBar35 = checkinBar('Dom Check-in');
  const resetBar10 = checkinBar('Dom Check-in 10d');
  check('check-in resets: the 35d bar reads "0 of 35 days elapsed" after checking in',
    !!resetBar35 && resetBar35.caption === '0 of 35 days elapsed', resetBar35 ? resetBar35.caption : 'no bar');
  check('check-in resets: the 10d bar reads "0 of 10 days elapsed" after checking in',
    !!resetBar10 && resetBar10.caption === '0 of 10 days elapsed', resetBar10 ? resetBar10.caption : 'no bar');
  check('check-in resets: both bar fills are 0% wide after checking in',
    !!resetBar35 && resetBar35.width === 0 && !!resetBar10 && resetBar10.width === 0,
    (resetBar35 ? resetBar35.width : '—') + ' / ' + (resetBar10 ? resetBar10.width : '—'));

  // --- 15. settled / pending check-in txs get no bar ---
  // (Same rule as the API suite's §16b, proven in the DOM):
  // a stale, broadcasted (confirmed), pending (broadcast,
  // unconfirmed) or slipstream-pending check-in tx loses its
  // bar; a failed or conflict one keeps it. When every armed
  // check-in tx is archived the card hides; restoring both
  // brings the bars and the card back. (Direct state.json
  // edits, like §14's held-clock edit. When the server sends
  // an empty checkinTxs the frontend re-derives via its
  // fallback filter — the all-archived case below exercises
  // that path too, and it must agree: no bars.)
  function setDomTxFate(label, release, broadcasted) {
    const st = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const t of (st.bitcoin.txs || [])) {
      if (t.label === label) {
        t.release = release;
        if (broadcasted !== undefined) t.broadcasted = broadcasted;
        break;
      }
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(st, null, 2) + '\n');
  }
  const domTx = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).bitcoin.txs.find((t) => t.label === 'Dom Check-in') || {};
  const domTxid = domTx.txid || '';
  const domNow = new Date().toISOString();
  setDomTxFate('Dom Check-in', { status: 'stale', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', lastAttemptAt: domNow, error: 'inputs spent: staged' }, null);
  await rerender(appJs);
  check('archived bars: a stale check-in tx gets no bar (only the 10d bar remains)',
    (checkinBars() || []).length === 1 && !!checkinBar('Dom Check-in 10d') && !checkinBar('Dom Check-in'),
    JSON.stringify(checkinBars()));
  check('archived bars: the card stays visible while the 10d check-in tx is still active',
    els['checkin-card'] && els['checkin-card'].style.display !== 'none',
    els['checkin-card'] && els['checkin-card'].style.display);
  setDomTxFate('Dom Check-in', { status: 'broadcast', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', broadcastedAt: domNow },
    { txid: domTxid, broadcastedAt: domNow, method: 'mempool.space', confirmations: 5, blockHeight: 899995, found: true, checkedAt: domNow });
  await rerender(appJs);
  check('archived bars: a broadcasted (confirmed) check-in tx gets no bar',
    (checkinBars() || []).length === 1 && !!checkinBar('Dom Check-in 10d') && !checkinBar('Dom Check-in'),
    JSON.stringify(checkinBars()));
  setDomTxFate('Dom Check-in', { status: 'broadcast', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', broadcastedAt: domNow },
    { txid: domTxid, broadcastedAt: domNow, method: 'mempool.space', confirmations: 0, blockHeight: null, found: true, checkedAt: domNow });
  await rerender(appJs);
  check('archived bars: a pending (broadcast, 0 confirmations) check-in tx gets no bar',
    (checkinBars() || []).length === 1 && !!checkinBar('Dom Check-in 10d') && !checkinBar('Dom Check-in'),
    JSON.stringify(checkinBars()));
  setDomTxFate('Dom Check-in', { status: 'submitted-slipstream', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'slipstream', lastAttemptAt: domNow }, null);
  await rerender(appJs);
  check('archived bars: a slipstream-pending check-in tx gets no bar',
    (checkinBars() || []).length === 1 && !!checkinBar('Dom Check-in 10d') && !checkinBar('Dom Check-in'),
    JSON.stringify(checkinBars()));
  setDomTxFate('Dom Check-in', { status: 'failed', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', lastAttemptAt: domNow, error: 'simulated failure' }, null);
  await rerender(appJs);
  check('archived bars: a failed check-in tx KEEPS its bar (still owed a broadcast)',
    (checkinBars() || []).length === 2 && !!checkinBar('Dom Check-in') && !!checkinBar('Dom Check-in 10d'),
    JSON.stringify(checkinBars()));
  setDomTxFate('Dom Check-in', { status: 'conflict', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', lastAttemptAt: domNow, error: 'inputs spent by an unconfirmed transaction' }, null);
  await rerender(appJs);
  check('archived bars: a conflict check-in tx KEEPS its bar (active with a warning)',
    (checkinBars() || []).length === 2 && !!checkinBar('Dom Check-in') && !!checkinBar('Dom Check-in 10d'),
    JSON.stringify(checkinBars()));
  // Both archived: no bars and the card hides (the empty
  // server list re-derives via the frontend fallback, which
  // must agree — no bars from either path).
  setDomTxFate('Dom Check-in', { status: 'stale', kind: 'release', trigger: 'checkin', txid: domTxid, method: 'mempool.space', lastAttemptAt: domNow, error: 'inputs spent: staged' }, null);
  const domTx10 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).bitcoin.txs.find((t) => t.label === 'Dom Check-in 10d') || {};
  setDomTxFate('Dom Check-in 10d', { status: 'stale', kind: 'release', trigger: 'checkin', txid: domTx10.txid || '', method: 'mempool.space', lastAttemptAt: domNow, error: 'inputs spent: staged' }, null);
  await rerender(appJs);
  check('archived bars: with every armed check-in tx archived the bars are gone',
    (checkinBars() || []).length === 0, JSON.stringify(checkinBars()));
  check('archived bars: with no active check-in tx the check-in card hides (display none)',
    els['checkin-card'] && els['checkin-card'].style.display === 'none',
    els['checkin-card'] && els['checkin-card'].style.display);
  // Restore both to active so the run ends clean.
  setDomTxFate('Dom Check-in', null, null);
  setDomTxFate('Dom Check-in 10d', null, null);
  await rerender(appJs);
  check('archived bars: clearing the fates restores both bars and the card',
    (checkinBars() || []).length === 2 && els['checkin-card'] && els['checkin-card'].style.display !== 'none',
    JSON.stringify(checkinBars()) + ' display=' + (els['checkin-card'] && els['checkin-card'].style.display));

  // --- 18. grace period for price/UTXO triggers (0.8.0) ---
  // When the app comes back after being offline longer than
  // settings.graceOfflineDays (default 7), price and UTXO
  // triggers are paused for settings.graceDurationDays (default
  // 7, null = indefinite until resumed). The dashboard shows a
  // "Grace period active" card at the top (only while a grace
  // is active for an armed price or UTXO tx) with the offline
  // days and the end date bolded, a Resume now button, and the
  // muted note; armed price/UTXO tx cards read "Grace" on an
  // amber pill instead of "armed"; the Settings grace card has
  // the two dropdowns (offline days to trigger, how long it
  // lasts) with Save. (Direct state.json edits for the grace,
  // like §14's held-clock edit and §16b's fate edits. The
  // launcher's lastOnlineAt is fresh — the app booted minutes
  // ago — so seeding a grace directly never re-triggers one on
  // the read.)
  function setDomGrace(grace) {
    const st = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    st.grace = grace;
    fs.writeFileSync(DATA_FILE, JSON.stringify(st, null, 2) + '\n');
  }
  function fmtDateShortDom(d) {
    const x = new Date(d);
    return x.toLocaleDateString() + ', ' + x.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const graceNow = Date.now();
  const graceUntil = new Date(graceNow + 7 * 86400000).toISOString();
  const graceTriggeredAt = new Date(graceNow).toISOString();
  // Static HTML: the dashboard grace card (before the check-in
  // card) and the Settings grace card (after the price sources
  // card), with the exact copy from the approved mockup.
  check('grace card static: the dashboard grace card exists (title, text, Resume button, note)',
    idx.indexOf('id="grace-card"') !== -1 && idx.indexOf('Grace period active') !== -1
    && idx.indexOf('id="grace-text"') !== -1 && idx.indexOf('id="btn-resume-grace"') !== -1
    && idx.indexOf('Ends the grace period immediately') !== -1, '');
  check('grace card static: the grace card sits at the top of the dashboard (before the check-in card)',
    idx.indexOf('id="grace-card"') !== -1 && idx.indexOf('id="checkin-card"') !== -1
    && idx.indexOf('id="grace-card"') < idx.indexOf('id="checkin-card"'), '');
  check('grace card static: the Resume button reads "Resume now" and is orange (primary)',
    idx.indexOf('id="btn-resume-grace" class="primary"') !== -1, '');
  check('grace settings static: the Settings grace card exists (title, two dropdowns, Save; the explainer lives in the "?" pop-out)',
    idx.indexOf('Grace period</h2>') !== -1 && idx.indexOf('id="set-grace-offline"') !== -1
    && idx.indexOf('id="set-grace-duration"') !== -1 && idx.indexOf('id="btn-save-grace"') !== -1
    && appJs.indexOf('A pause for price and UTXO triggers after the app has been offline') !== -1, '');
  check('grace settings static: the grace card sits after the Bitcoin price source card',
    idx.indexOf('id="btn-save-grace"') !== -1 && idx.indexOf('id="btn-save-price-sources"') !== -1
    && idx.indexOf('id="btn-save-grace"') > idx.indexOf('id="btn-save-price-sources"'), '');
  check('grace settings static: the offline dropdown offers 1/3/7/14/30 days',
    JSON.stringify(selectValues(idx, 'set-grace-offline')) === JSON.stringify(['1', '3', '7', '14', '30']),
    JSON.stringify(selectValues(idx, 'set-grace-offline')));
  check('grace settings static: the duration dropdown offers 1/3/7/14/30 days + indefinite',
    JSON.stringify(selectValues(idx, 'set-grace-duration')) === JSON.stringify(['1', '3', '7', '14', '30', 'indefinite']),
    JSON.stringify(selectValues(idx, 'set-grace-duration')));
  check('grace settings static: the Save button reads "Save grace period" and is orange (primary)',
    idx.indexOf('id="btn-save-grace" class="primary"') !== -1, '');
  // Section 14 left lastOnlineAt stale (the held-clock seed), so
  // a grace is active from the read paths by now — the app was
  // offline 40 days, which is past the 7-day grace threshold as
  // well as the check-in hold. Restore a fresh stamp and clear
  // the grace for a clean starting point (the check-in clock and
  // hold are untouched).
  const stClean = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  stClean.checkin.lastOnlineAt = new Date().toISOString();
  stClean.grace = { graceUntil: null, triggeredAt: null, offlineGapDays: null };
  fs.writeFileSync(DATA_FILE, JSON.stringify(stClean, null, 2) + '\n');
  await rerender(appJs);
  // No grace active: the card is hidden.
  check('grace card: hidden when no grace is active',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  // Capture the readiness lines before the grace: the grace must
  // not change them (the rule's condition + current value are
  // still accurate — only the pill says Grace).
  const priceLineBefore = (readinessBlock('Dom Price') || {}).state || '';
  const utxoLineBefore = (readinessBlock('Dom UTXO') || {}).state || '';
  // Seed a finite grace (offline 8 days, 7-day duration) and
  // re-render: the card shows with the offline days and the end
  // date (both bolded) and the duration.
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  const graceText = elText(els['grace-text']);
  check('grace card: appears when a grace is active',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  check('grace card: names the offline days ("8 days")',
    graceText.indexOf('8 days') !== -1, graceText);
  check('grace card: names the end date (' + fmtDateShortDom(graceUntil) + ') and the duration ("7 days")',
    graceText.indexOf(fmtDateShortDom(graceUntil)) !== -1 && graceText.indexOf('(7 days)') !== -1, graceText);
  check('grace card: the offline days and the end date are bolded',
    (function () {
      const gt = els['grace-text'];
      const bolds = (gt.children || []).filter((c) => c.tagName === 'B').map((c) => c.textContent);
      return bolds.length === 2 && bolds[0] === '8 days' && bolds[1].indexOf(fmtDateShortDom(graceUntil)) !== -1;
    })(), JSON.stringify((els['grace-text'].children || []).map((c) => c.tagName + ':' + c.textContent)));
  // The Grace pill: armed price/UTXO cards read "Grace" on
  // amber; check-in and manual cards are untouched.
  for (const label of ['Dom Price', 'Dom UTXO']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" card pill reads "Grace" on amber during the grace',
      !!pill && pill.textContent === 'Grace' && pill.className === 'pill warn',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
    const rb = readinessBlock(label);
    check('grace pill: "' + label + '" readiness pill reads "Grace" on amber too',
      !!rb && rb.status === 'Grace' && rb.statusCls === 'pill warn',
      rb ? rb.status + ' / ' + rb.statusCls : 'no block');
  }
  check('grace pill: the Dom Price readiness line is unchanged (condition + current value)',
    (readinessBlock('Dom Price') || {}).state === priceLineBefore,
    (readinessBlock('Dom Price') || {}).state + ' (was: ' + priceLineBefore + ')');
  check('grace pill: the Dom UTXO readiness line is unchanged',
    (readinessBlock('Dom UTXO') || {}).state === utxoLineBefore,
    (readinessBlock('Dom UTXO') || {}).state + ' (was: ' + utxoLineBefore + ')');
  for (const label of ['Dom Check-in', 'Dom Manual', 'Dom Pill healthy']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" keeps its normal pill during the grace (check-in/manual not held)',
      !!pill && pill.textContent === 'armed',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
  }
  // A disarmed price tx still reads "unarmed" during the grace;
  // re-arming brings "Grace" back.
  const domPriceId = ((await (await fetch('/api/state')).json()).bitcoin.txs || []).find((t) => t.label === 'Dom Price') || {};
  const disP = await fetch('/api/bitcoin/txs/' + domPriceId.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('grace pill: disarming the Dom Price tx via the API', disP.status === 200, 'status=' + disP.status);
  await rerender(appJs);
  const graceDisPill = cardByTitle('Dom Price') && cardStatus(cardByTitle('Dom Price'));
  check('grace pill: the disarmed price tx reads "unarmed" during the grace',
    !!graceDisPill && graceDisPill.textContent === 'unarmed',
    graceDisPill ? graceDisPill.textContent + ' / ' + graceDisPill.className : 'no pill');
  const rearmP = await fetch('/api/bitcoin/txs/' + domPriceId.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  check('grace pill: re-arming the Dom Price tx via the API', rearmP.status === 200, 'status=' + rearmP.status);
  await rerender(appJs);
  const rearmPill = cardByTitle('Dom Price') && cardStatus(cardByTitle('Dom Price'));
  check('grace pill: the re-armed price tx reads "Grace" again',
    !!rearmPill && rearmPill.textContent === 'Grace' && rearmPill.className === 'pill warn',
    rearmPill ? rearmPill.textContent + ' / ' + rearmPill.className : 'no pill');
  // Resume now: the button clears the grace and the card hides;
  // the pills read "armed" again.
  els['btn-resume-grace'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('grace card: Resume now hides the card',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  const afterResume = await (await fetch('/api/state')).json();
  check('grace card: the grace is gone from /api/state after Resume',
    afterResume.grace === null, JSON.stringify(afterResume.grace));
  for (const label of ['Dom Price', 'Dom UTXO']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" reads "armed" again after Resume',
      !!pill && pill.textContent === 'armed',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
  }
  // An indefinite grace reads "until you resume" (no date).
  setDomGrace({ graceUntil: null, triggeredAt: graceTriggeredAt, offlineGapDays: 12 });
  await rerender(appJs);
  const indText = elText(els['grace-text']);
  check('grace card: an indefinite grace shows (offline 12 days)',
    els['grace-card'] && els['grace-card'].style.display !== 'none' && indText.indexOf('12 days') !== -1, indText);
  check('grace card: an indefinite grace reads "until you resume" instead of a date',
    indText.indexOf('until you resume') !== -1 && indText.indexOf('(7 days)') === -1, indText);
  els['btn-resume-grace'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('grace card: Resume now hides the indefinite grace card too',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  // Settings grace card: the dropdowns reflect the saved
  // defaults (7 / 7); saving a change persists it and the
  // selects re-render with the new values; restore the defaults.
  check('grace settings: the offline dropdown defaults to 7 days',
    els['set-grace-offline'] && els['set-grace-offline'].value === '7',
    els['set-grace-offline'] && els['set-grace-offline'].value);
  check('grace settings: the duration dropdown defaults to 7 days',
    els['set-grace-duration'] && els['set-grace-duration'].value === '7',
    els['set-grace-duration'] && els['set-grace-duration'].value);
  els['set-grace-offline'].value = '14';
  els['set-grace-duration'].value = 'indefinite';
  els['btn-save-grace'].click();
  await new Promise((r) => setTimeout(r, 900));
  const gAfter = await (await fetch('/api/state')).json();
  check('grace settings: saving 14 days + indefinite persists in /api/state',
    gAfter.settings && gAfter.settings.graceOfflineDays === 14 && gAfter.settings.graceDurationDays === null,
    JSON.stringify(gAfter.settings && { graceOfflineDays: gAfter.settings.graceOfflineDays, graceDurationDays: gAfter.settings.graceDurationDays }));
  check('grace settings: after saving, the dropdowns re-render as 14 / indefinite',
    els['set-grace-offline'] && els['set-grace-offline'].value === '14'
    && els['set-grace-duration'] && els['set-grace-duration'].value === 'indefinite',
    'offline=' + (els['set-grace-offline'] && els['set-grace-offline'].value)
    + ' duration=' + (els['set-grace-duration'] && els['set-grace-duration'].value));
  check('grace settings: the Save confirmation shows',
    els['grace-settings-msg'] && els['grace-settings-msg'].textContent === 'Grace period saved.',
    els['grace-settings-msg'] && els['grace-settings-msg'].textContent);
  els['set-grace-offline'].value = '7';
  els['set-grace-duration'].value = '7';
  els['btn-save-grace'].click();
  await new Promise((r) => setTimeout(r, 900));
  const gRestored = await (await fetch('/api/state')).json();
  check('grace settings: restoring the defaults (7 / 7) persists',
    gRestored.settings && gRestored.settings.graceOfflineDays === 7 && gRestored.settings.graceDurationDays === 7,
    JSON.stringify(gRestored.settings && { graceOfflineDays: gRestored.settings.graceOfflineDays, graceDurationDays: gRestored.settings.graceDurationDays }));
  // Leave a finite grace active at the end, so the width check
  // can measure the grace card at 390px.
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  check('grace card: a finite grace is left active for the width check',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);

  // --- 19. Getting Started empty-state card (0.8.0) ---
  // When no transactions are STAGED (active), a "Getting
  // Started" card appears at the very top of the Dashboard —
  // the first thing a fresh install sees — with Ryan's exact
  // copy and a full-width orange button that switches to the
  // Transactions tab and scrolls to the "Add a transaction"
  // form. Archived (settled) and pending transactions do NOT
  // count: the card shows when the only txs are archived or
  // pending, and hides as soon as the first transaction is
  // staged. It is independent of the grace card (which needs
  // armed price/UTXO txs to show).
  // Static HTML: the card (title, body verbatim, button) at the
  // top of the dashboard, before the grace card.
  check('getting started static: the card exists (title, body verbatim, button)',
    idx.indexOf('id="getting-started-card"') !== -1 && idx.indexOf('<h2>Getting Started</h2>') !== -1
    && idx.indexOf('Standby broadcasts presigned transactions based on the trigger criteria you define. Sign a transaction on your wallet, then add it here.') !== -1
    && idx.indexOf('id="btn-getting-started-add"') !== -1
    && idx.indexOf('+ Add a pre-signed transaction') !== -1, '');
  check('getting started static: the card sits at the top of the dashboard (before the grace card)',
    idx.indexOf('id="getting-started-card"') !== -1 && idx.indexOf('id="grace-card"') !== -1
    && idx.indexOf('id="getting-started-card"') < idx.indexOf('id="grace-card"'), '');
  check('getting started static: the button reads "+ Add a pre-signed transaction" and is orange (primary)',
    idx.indexOf('id="btn-getting-started-add" class="primary"') !== -1, '');
  check('getting started static: the card is a plain card (no grace-card class)',
    idx.indexOf('class="card empty-state"') !== -1, '');
  // Static CSS: the .empty-state rules (centered welcome layout,
  // full-width button) are in the served stylesheet.
  const css19 = await realFetch(BASE + '/style.css').then((r) => r.text());
  check('getting started static: the .empty-state rules are in the served stylesheet',
    css19.indexOf('.empty-state { text-align: center; padding: 28px 20px 24px; }') !== -1
    && css19.indexOf('.empty-state h2 { font-size: 20px;') !== -1
    && css19.indexOf('.empty-state p { color: var(--muted); font-size: 15px;') !== -1
    && css19.indexOf('.empty-state button { width: 100%; padding: 14px 20px; font-size: 17px; font-weight: 600; }') !== -1, '');
  // With the 4 seeded txs the card is hidden.
  check('getting started: hidden while transactions are staged',
    els['getting-started-card'] && els['getting-started-card'].style.display === 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // Delete all txs via the API: the card shows.
  const st19 = await (await fetch('/api/state')).json();
  for (const t of (st19.bitcoin.txs || [])) {
    // DELETE is a state-changing request, so the CSRF gate needs
    // the JSON content type even with no body (the app's own
    // api() helper sends it; a bare fetch does not).
    const d = await fetch('/api/bitcoin/txs/' + t.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('getting started: deleting "' + t.label + '" via the API', d.status === 200, 'status=' + d.status);
  }
  await rerender(appJs);
  check('getting started: shows when no transactions are staged',
    els['getting-started-card'] && els['getting-started-card'].style.display !== 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // The button opens the Add popup: clicking it opens the
  // #add-modal and does NOT switch tabs (the dashboard stays
  // active) and never scrolls the page.
  els['btn-getting-started-add'].click();
  check('getting started button: clicking it opens the Add popup',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  check('getting started button: it does NOT switch tabs (dashboard stays active)',
    els.__tabbtn && els.__tabbtn.dashboard && els.__tabbtn.dashboard.classList.contains('active')
    && els.__tabbtn.bitcoin && !els.__tabbtn.bitcoin.classList.contains('active'),
    'dashboard active=' + (els.__tabbtn && els.__tabbtn.dashboard && els.__tabbtn.dashboard.classList.contains('active')));
  check('getting started button: the add form title is NOT scrolled into view (no scroll)',
    !els['btc-form-title'] || els['btc-form-title'].__scrolledIntoView !== true,
    els['btc-form-title'] ? '__scrolledIntoView=' + els['btc-form-title'].__scrolledIntoView : 'never touched');
  // Closing the popup (Cancel) hides it again.
  els['btn-btc-add-cancel'].click();
  check('getting started button: Cancel closes the Add popup',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  // Add one tx: the card hides again. (Value 300001: a hex no
  // other section uses — 200001 is the 'Dom UTXO unconfirmed'
  // tx's hex, so reusing it would be a duplicate once restored.)
  const add19 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHex: craftHex(1, 300001), label: 'GS Check-in' }) });
  check('getting started: adding a tx via the API', add19.status === 201, 'status=' + add19.status);
  await rerender(appJs);
  check('getting started: hides as soon as the first transaction is added',
    els['getting-started-card'] && els['getting-started-card'].style.display === 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // A pending fate is NOT staged: the card shows when the only
  // tx is pending (submitted-slipstream).
  const gsTx = (await (await fetch('/api/state')).json()).bitcoin.txs.find((t) => t.label === 'GS Check-in') || {};
  const gsNow = new Date().toISOString();
  setDomTxFate('GS Check-in', { status: 'submitted-slipstream', kind: 'release', trigger: 'checkin', txid: gsTx.txid || '', method: 'slipstream', lastAttemptAt: gsNow }, null);
  await rerender(appJs);
  check('getting started: shows when the only tx is pending (submitted-slipstream) — pending is not staged',
    els['getting-started-card'] && els['getting-started-card'].style.display !== 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // An archived fate (stale) is NOT staged either: the card shows.
  setDomTxFate('GS Check-in', { status: 'stale', kind: 'release', trigger: 'checkin', txid: gsTx.txid || '', method: 'mempool.space', lastAttemptAt: gsNow, error: 'inputs spent: staged' }, null);
  await rerender(appJs);
  check('getting started: shows when the only tx is archived (stale) — archived is not staged',
    els['getting-started-card'] && els['getting-started-card'].style.display !== 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // Delete the tx: the card shows again.
  const del19 = await fetch('/api/bitcoin/txs/' + gsTx.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('getting started: deleting the tx via the API', del19.status === 200, 'status=' + del19.status);
  await rerender(appJs);
  check('getting started: shows again after the last tx is deleted',
    els['getting-started-card'] && els['getting-started-card'].style.display !== 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // Restore: re-seed the txs the delete removed — the 4 Dom txs
  // (same hexes/triggers as the launcher) PLUS the extra txs
  // later sections added ('Dom Check-in 10d', the two pill txs,
  // the long-label tx). The width check needs at least 7
  // readiness rows (4 seeded + 2 pill + long-label), so all 8
  // go back; the §8 UTXO txs are NOT re-added (they broadcast
  // and left the list, per the width check's own comment).
  const LONG_LABEL19 = 'A very long transaction label that must be truncated with an ellipsis on the readiness row, never wrapping the status pill';
  for (const [hexs, label, trig] of [
    [craftHex(1, 100001), 'Dom Check-in', null],
    [craftHex(1, 100003), 'Dom Price', { type: 'price', params: { op: '>=', value: 150000 } }],
    [craftHex(1, 100005), 'Dom UTXO', { type: 'utxo', params: { outpoint: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:1' } }],
    [craftHex(1, 100007), 'Dom Manual', { type: 'manual', params: {} }],
    [craftHex(1, 200201), 'Dom Check-in 10d', { type: 'checkin', params: { thresholdDays: 10 } }],
    [craftHex(2, 200101), 'Dom Pill healthy', { type: 'manual', params: {} }],
    [craftLocktimeHex(3, 950000, 200103), 'Dom Pill timelocked', { type: 'manual', params: {} }],
    [craftHex(4, 200105), LONG_LABEL19, { type: 'manual', params: {} }],
  ]) {
    const body = { txHex: hexs, label, notes: '' };
    if (trig !== null) body.trigger = trig;
    const rs = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    check('getting started restore: re-adding "' + label + '"', rs.status === 201, 'status=' + rs.status);
  }
  await rerender(appJs);
  const restored19 = (await (await fetch('/api/state')).json()).bitcoin.txs || [];
  check('getting started restore: all 8 txs are back (4 Dom + 10d + 2 pill + long-label)',
    restored19.length === 8, 'txs=' + restored19.length);
  check('getting started restore: hidden again with the txs staged',
    els['getting-started-card'] && els['getting-started-card'].style.display === 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // Grace independence: with txs staged and a finite grace
  // active, the grace card shows AND the Getting Started card
  // stays hidden (the two cards are independent).
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  check('getting started + grace: the grace card shows while txs are staged',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  check('getting started + grace: the Getting Started card stays hidden while txs are staged (grace does not summon it)',
    els['getting-started-card'] && els['getting-started-card'].style.display === 'none',
    els['getting-started-card'] && els['getting-started-card'].style.display);
  // Leave the finite grace active for the width check (as §18 did).

  // --- 20. user controls: price agreement, check cadence, broadcast fee risk (0.8.0) ---
  // Three Settings cards, each a number input with min/max
  // bounds, units shown, and its own orange Save button. The
  // price-sources note carries the agreement as a span so it
  // tracks the saved setting. The fee pill on a readiness row
  // flips when the multipliers move: a 4.0 sat/vB fee (peak
  // 2.0) is Low Fee Risk at the defaults (2x/1x) and Med Fee Risk
  // at 3x/1.5x.
  // Static HTML: the three cards exist (title, explainer, inputs
  // with bounds, units, Save buttons), after the grace card.
  check('user controls static: the Price agreement card exists (title, input, unit, Save; the explainer lives in the "?" pop-out)',
    idx.indexOf('<h2>Price agreement</h2>') !== -1 && idx.indexOf('id="set-price-agreement"') !== -1
    && idx.indexOf('id="btn-save-price-agreement"') !== -1 && idx.indexOf('id="price-agreement-msg"') !== -1
    && appJs.indexOf('How closely the two price sources must agree') !== -1, '');
  check('user controls static: the Price agreement input is a number input with bounds 1-20 and a % unit',
    idx.indexOf('id="set-price-agreement" type="number" min="1" max="20"') !== -1
    && idx.indexOf('<span>%</span>') !== -1, '');
  check('user controls static: the Check cadence card exists (title, input, unit, Save; the explainer lives in the "?" pop-out)',
    idx.indexOf('<h2>Check cadence</h2>') !== -1 && idx.indexOf('id="set-check-cadence"') !== -1
    && idx.indexOf('id="btn-save-check-cadence"') !== -1 && idx.indexOf('id="check-cadence-msg"') !== -1
    && appJs.indexOf('How often every trigger is checked') !== -1, '');
  // (0.8.2 v2) The cadence card states on the card itself — not
  // only behind the "?" — that it applies to every trigger,
  // including check-in.
  check('user controls static: the Check cadence card says on the card that it applies to every trigger, including check-in',
    idx.indexOf('Applies to every trigger, including check-in.') > idx.indexOf('<h2>Check cadence</h2>')
    && idx.indexOf('Applies to every trigger, including check-in.') < idx.indexOf('id="btn-save-check-cadence"'), '');
  check('user controls static: the Check cadence input is a number input with bounds 10-3600 and a seconds unit',
    idx.indexOf('id="set-check-cadence" type="number" min="10" max="3600"') !== -1
    && idx.indexOf('<span>seconds</span>') !== -1, '');
  check('user controls static: the Broadcast Fee Risk card exists (title, two inputs, units, Save; the explainer lives in the "?" pop-out)',
    idx.indexOf('<h2>Broadcast Fee Risk</h2>') !== -1 && idx.indexOf('id="set-fee-low"') !== -1
    && idx.indexOf('id="set-fee-medium"') !== -1 && idx.indexOf('id="btn-save-fee-verdict"') !== -1
    && idx.indexOf('id="fee-verdict-msg"') !== -1
    && appJs.indexOf('Where the Low / Medium / High fee pill flips') !== -1, '');
  check('user controls static: the Broadcast Fee Risk inputs are number inputs with bounds 1-10 and 0.5-5 and a x 90-day peak tx fee unit',
    idx.indexOf('id="set-fee-low" type="number" min="1" max="10"') !== -1
    && idx.indexOf('id="set-fee-medium" type="number" min="0.5" max="5"') !== -1
    && idx.indexOf('<span>× 90-day peak tx fee</span>') !== -1, '');
  check('user controls static: the three cards sit after the Grace period card, in order (agreement, cadence, fee)',
    idx.indexOf('id="btn-save-grace"') !== -1 && idx.indexOf('id="btn-save-price-agreement"') !== -1
    && idx.indexOf('id="btn-save-check-cadence"') !== -1 && idx.indexOf('id="btn-save-fee-verdict"') !== -1
    && idx.indexOf('id="btn-save-grace"') < idx.indexOf('id="btn-save-price-agreement"')
    && idx.indexOf('id="btn-save-price-agreement"') < idx.indexOf('id="btn-save-check-cadence"')
    && idx.indexOf('id="btn-save-check-cadence"') < idx.indexOf('id="btn-save-fee-verdict"'), '');
  check('user controls static: each Save button is orange (primary)',
    idx.indexOf('id="btn-save-price-agreement" class="primary"') !== -1
    && idx.indexOf('id="btn-save-check-cadence" class="primary"') !== -1
    && idx.indexOf('id="btn-save-fee-verdict" class="primary"') !== -1, '');
  // The inputs reflect the saved values on load (the defaults
  // here: agreement 5, cadence 60, fee Low 2 / Medium 1), and
  // the price-sources note shows the agreement as 5%.
  check('user controls: the inputs reflect the saved defaults on load (5 / 60 / 2 / 1)',
    els['set-price-agreement'] && els['set-price-agreement'].value === '5'
    && els['set-check-cadence'] && els['set-check-cadence'].value === '60'
    && els['set-fee-low'] && els['set-fee-low'].value === '2'
    && els['set-fee-medium'] && els['set-fee-medium'].value === '1',
    'agreement=' + (els['set-price-agreement'] && els['set-price-agreement'].value)
    + ' cadence=' + (els['set-check-cadence'] && els['set-check-cadence'].value)
    + ' low=' + (els['set-fee-low'] && els['set-fee-low'].value)
    + ' medium=' + (els['set-fee-medium'] && els['set-fee-medium'].value));
  check('user controls: the price-sources note shows the agreement as 5% by default',
    els['price-sources-agreement'] && els['price-sources-agreement'].textContent === '5%',
    els['price-sources-agreement'] && els['price-sources-agreement'].textContent);
  // Broadcast Fee Risk zone bar (0.8.0): always visible under the numbers,
  // showing the three zones as a bar that moves live as you type.
  // The second input is framed from the High side and the unit
  // names the 90-day peak tx fee. The bar reflects whatever is
  // in the inputs, so it is there whether or not you are editing
  // — no show/hide, no open class.
  check('fee zone bar static: the second input reads "High Risk at or below" and both units read "× 90-day peak tx fee"',
    idx.indexOf('<label for="set-fee-medium">High Risk at or below</label>') !== -1
    && idx.indexOf('<span>× 90-day peak tx fee</span>') !== -1, '');
  check('fee zone bar static: the zone bar exists with three segments and their ranges',
    idx.indexOf('id="zone-bar"') !== -1 && idx.indexOf('id="seg-high"') !== -1
    && idx.indexOf('id="seg-med"') !== -1 && idx.indexOf('id="seg-low"') !== -1
    && idx.indexOf('id="range-high"') !== -1 && idx.indexOf('id="range-med"') !== -1
    && idx.indexOf('id="range-low"') !== -1
    && idx.indexOf('>High Risk<') !== -1 && idx.indexOf('>Medium Risk<') !== -1
    && idx.indexOf('>Low Risk<') !== -1, '');
  check('fee zone bar static: the served CSS styles the zone bar and its three segments',
    (await realFetch(BASE + '/style.css').then((r) => r.text())).indexOf('.zone-bar .seg-high') !== -1, '');
  check('fee zone bar static: the bar is always visible (no open class and no hidden-by-default rule in the CSS)',
    (await realFetch(BASE + '/style.css').then((r) => r.text())).indexOf('.zone-bar.open') === -1, '');
  // The ranges are populated on load, with no focus needed — the
  // bar is visible by default and reflects the saved values.
  check('fee zone bar: the ranges read 1× and below / 1× – 2× / 2× and up at the defaults',
    els['range-high'] && els['range-high'].textContent === '1× and below'
    && els['range-med'] && els['range-med'].textContent === '1× – 2×'
    && els['range-low'] && els['range-low'].textContent === '2× and up',
    (els['range-high'] && els['range-high'].textContent) + ' / '
    + (els['range-med'] && els['range-med'].textContent) + ' / '
    + (els['range-low'] && els['range-low'].textContent));
  // Typing Low 5 moves the zones live (no focus needed).
  els['set-fee-low'].value = '5';
  els['set-fee-low'].fire('input');
  check('fee zone bar: typing Low 5 moves the ranges live (Medium 1× – 5×, Low 5× and up)',
    els['range-med'] && els['range-med'].textContent === '1× – 5×'
    && els['range-low'] && els['range-low'].textContent === '5× and up',
    (els['range-med'] && els['range-med'].textContent) + ' / '
    + (els['range-low'] && els['range-low'].textContent));
  check('fee zone bar: typing Low 5 widens the Medium segment and narrows High and Low',
    els['seg-high'] && els['seg-med'] && els['seg-low']
    && parseFloat(els['seg-high'].style.flexBasis) < parseFloat(els['seg-med'].style.flexBasis)
    && parseFloat(els['seg-low'].style.flexBasis) < parseFloat(els['seg-med'].style.flexBasis),
    'high=' + (els['seg-high'] && els['seg-high'].style.flexBasis)
    + ' med=' + (els['seg-med'] && els['seg-med'].style.flexBasis)
    + ' low=' + (els['seg-low'] && els['seg-low'].style.flexBasis));
  // Restore the defaults so the fee-pill checks that follow see 2/1.
  els['set-fee-low'].value = '2';
  els['set-fee-medium'].value = '1';
  els['set-fee-low'].fire('input');
  // The fee pill at the defaults: add a tx whose fee rate is
  // exactly 4.0 sat/vB (Finney vout 1 is 150,000 sats, the
  // output is 149,660, so the fee is 340 sats over 85 bytes).
  // The peak is 2.0, so 4.0 is Low Risk at the defaults.
  const feeTx = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHex: craftHex(1, 149660), label: 'Dom Fee 4', trigger: { type: 'manual', params: {} } }) });
  check('user controls fee pill: adding the 4.0 sat/vB tx (201)', feeTx.status === 201, 'status=' + feeTx.status);
  const stFee = await (await fetch('/api/state')).json();
  const feeTxState = (stFee.bitcoin.txs || []).find((t) => t.label === 'Dom Fee 4') || {};
  check('user controls fee pill: the tx fee rate is 4.0 sat/vB (peak 2.0)',
    feeTxState.feeRateSatVb === 4 && stFee.bitcoin.feePeak === 2,
    'feeRate=' + feeTxState.feeRateSatVb + ' peak=' + stFee.bitcoin.feePeak);
  await rerender(appJs);
  check('user controls fee pill: at the defaults (Low 2 / Medium 1) the readiness fee pill reads Low Fee Risk',
    (readinessBlock('Dom Fee 4') || {}).fee === 'Low Fee Risk',
    'fee pill=' + ((readinessBlock('Dom Fee 4') || {}).fee || '(none)'));
  // Save the fee multipliers 3 / 1.5 from the UI: the setting
  // persists, the msg line confirms, and the pill flips to
  // Medium Risk (4.0 is at least 1.5x but below 3x the peak).
  els['set-fee-low'].value = '3';
  els['set-fee-medium'].value = '1.5';
  els['btn-save-fee-verdict'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stFeeSaved = await (await fetch('/api/state')).json();
  check('user controls fee save: saving Low 3 / Medium 1.5 from the UI persists in /api/state',
    stFeeSaved.settings && stFeeSaved.settings.feeLowMultiplier === 3 && stFeeSaved.settings.feeMediumMultiplier === 1.5,
    JSON.stringify(stFeeSaved.settings && { low: stFeeSaved.settings.feeLowMultiplier, med: stFeeSaved.settings.feeMediumMultiplier }));
  check('user controls fee save: the msg line confirms the save',
    els['fee-verdict-msg'] && els['fee-verdict-msg'].textContent === 'Broadcast fee risk saved.',
    els['fee-verdict-msg'] && els['fee-verdict-msg'].textContent);
  await rerender(appJs);
  check('user controls fee pill: at Low 3 / Medium 1.5 the same 4.0 sat/vB fee reads Med Fee Risk',
    (readinessBlock('Dom Fee 4') || {}).fee === 'Med Fee Risk',
    'fee pill=' + ((readinessBlock('Dom Fee 4') || {}).fee || '(none)'));
  // Restore the fee defaults from the UI: the pill flips back.
  els['set-fee-low'].value = '2';
  els['set-fee-medium'].value = '1';
  els['btn-save-fee-verdict'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stFeeRestored = await (await fetch('/api/state')).json();
  check('user controls fee save: restoring Low 2 / Medium 1 from the UI persists',
    stFeeRestored.settings && stFeeRestored.settings.feeLowMultiplier === 2 && stFeeRestored.settings.feeMediumMultiplier === 1,
    JSON.stringify(stFeeRestored.settings && { low: stFeeRestored.settings.feeLowMultiplier, med: stFeeRestored.settings.feeMediumMultiplier }));
  await rerender(appJs);
  check('user controls fee pill: back at the defaults the fee pill reads Low Fee Risk again',
    (readinessBlock('Dom Fee 4') || {}).fee === 'Low Fee Risk',
    'fee pill=' + ((readinessBlock('Dom Fee 4') || {}).fee || '(none)'));
  // A fee pair with Low <= Medium is rejected from the UI: the
  // msg line shows the error and the settings do not change.
  els['set-fee-low'].value = '1';
  els['set-fee-medium'].value = '1';
  els['btn-save-fee-verdict'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('user controls fee save: Low 1 + Medium 1 shows an error in the msg line',
    els['fee-verdict-msg'] && els['fee-verdict-msg'].style.color === '#f87171'
    && (els['fee-verdict-msg'].textContent || '').indexOf('greater than') !== -1,
    els['fee-verdict-msg'] && els['fee-verdict-msg'].textContent + ' / color=' + els['fee-verdict-msg'].style.color);
  const stFeeBad = await (await fetch('/api/state')).json();
  check('user controls fee save: the rejected save changed nothing (still Low 2 / Medium 1)',
    stFeeBad.settings && stFeeBad.settings.feeLowMultiplier === 2 && stFeeBad.settings.feeMediumMultiplier === 1,
    JSON.stringify(stFeeBad.settings && { low: stFeeBad.settings.feeLowMultiplier, med: stFeeBad.settings.feeMediumMultiplier }));
  // Delete the fee-pill tx so the width check's row count is
  // unaffected (it expects the 8 restored txs).
  const delFee = await fetch('/api/bitcoin/txs/' + feeTxState.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('user controls fee pill: deleting the 4.0 sat/vB tx', delFee.status === 200, 'status=' + delFee.status);
  await rerender(appJs);
  // Save the price agreement from the UI: the setting persists,
  // the msg line confirms, and the price-sources note tracks it.
  els['set-price-agreement'].value = '2';
  els['btn-save-price-agreement'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stAgree = await (await fetch('/api/state')).json();
  check('user controls agreement save: saving 2% from the UI persists in /api/state',
    stAgree.settings && stAgree.settings.priceAgreementPct === 2,
    JSON.stringify(stAgree.settings && stAgree.settings.priceAgreementPct));
  check('user controls agreement save: the msg line confirms the save',
    els['price-agreement-msg'] && els['price-agreement-msg'].textContent === 'Price agreement saved.',
    els['price-agreement-msg'] && els['price-agreement-msg'].textContent);
  check('user controls agreement save: the price-sources note now shows 2%',
    els['price-sources-agreement'] && els['price-sources-agreement'].textContent === '2%',
    els['price-sources-agreement'] && els['price-sources-agreement'].textContent);
  // An out-of-range agreement is rejected from the UI: the msg
  // line shows the error and the setting does not change.
  els['set-price-agreement'].value = '0';
  els['btn-save-price-agreement'].click();
  await new Promise((r) => setTimeout(r, 900));
  check('user controls agreement save: 0% shows an error in the msg line',
    els['price-agreement-msg'] && els['price-agreement-msg'].style.color === '#f87171'
    && (els['price-agreement-msg'].textContent || '').indexOf('priceAgreementPct') !== -1,
    els['price-agreement-msg'] && els['price-agreement-msg'].textContent + ' / color=' + els['price-agreement-msg'].style.color);
  const stAgreeBad = await (await fetch('/api/state')).json();
  check('user controls agreement save: the rejected save changed nothing (still 2%)',
    stAgreeBad.settings && stAgreeBad.settings.priceAgreementPct === 2,
    JSON.stringify(stAgreeBad.settings && stAgreeBad.settings.priceAgreementPct));
  // Restore the agreement default from the UI.
  els['set-price-agreement'].value = '5';
  els['btn-save-price-agreement'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stAgreeRestored = await (await fetch('/api/state')).json();
  check('user controls agreement save: restoring 5% from the UI persists (and the note shows 5% again)',
    stAgreeRestored.settings && stAgreeRestored.settings.priceAgreementPct === 5
    && els['price-sources-agreement'] && els['price-sources-agreement'].textContent === '5%',
    JSON.stringify(stAgreeRestored.settings && stAgreeRestored.settings.priceAgreementPct) + ' note=' + (els['price-sources-agreement'] && els['price-sources-agreement'].textContent));
  // Save the check cadence from the UI, then restore it.
  els['set-check-cadence'].value = '10';
  els['btn-save-check-cadence'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stCad = await (await fetch('/api/state')).json();
  check('user controls cadence save: saving 10 seconds from the UI persists in /api/state',
    stCad.settings && stCad.settings.checkCadenceSeconds === 10,
    JSON.stringify(stCad.settings && stCad.settings.checkCadenceSeconds));
  check('user controls cadence save: the msg line confirms the save',
    els['check-cadence-msg'] && els['check-cadence-msg'].textContent === 'Check cadence saved.',
    els['check-cadence-msg'] && els['check-cadence-msg'].textContent);
  els['set-check-cadence'].value = '60';
  els['btn-save-check-cadence'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stCadRestored = await (await fetch('/api/state')).json();
  check('user controls cadence save: restoring 60 seconds from the UI persists',
    stCadRestored.settings && stCadRestored.settings.checkCadenceSeconds === 60,
    JSON.stringify(stCadRestored.settings && stCadRestored.settings.checkCadenceSeconds));

  // --- 21. pause/vacation/disarm redesign (0.8.0) ---
  // The old Pause / resume card is gone entirely; the vacation
  // card says plainly it is check-in-only and the countdown
  // freezes, with an indefinite option; the Global Arm/Disarm
  // card arms or disarms every tx at once. The static checks
  // read the served markup (the shim auto-creates any id, so
  // absence can only be proved from the HTML string); the
  // dynamic checks drive the UI.
  check('redesign static: the old Pause / resume card is gone (no heading, buttons, state pill, or msg line)',
    idx.indexOf('Pause / resume') === -1 && idx.indexOf('id="btn-pause"') === -1
    && idx.indexOf('id="btn-resume"') === -1 && idx.indexOf('id="pause-state"') === -1
    && idx.indexOf('id="pause-msg"') === -1, '');
  check('redesign static: no "Releases are paused" text anywhere in the served page or script',
    idx.indexOf('Releases are paused') === -1 && appJs.indexOf('Releases are paused') === -1, '');
  check('redesign static: no /api/pause or /api/resume call in the served script',
    appJs.indexOf('/api/pause') === -1 && appJs.indexOf('/api/resume') === -1, '');
  const vacIdx = idx.indexOf('<h2>Vacation mode</h2>');
  const vacBlock = vacIdx === -1 ? '' : idx.slice(vacIdx, vacIdx + 900);
  // The "Applies to" label is DERIVED from the triggers array
  // at runtime ("Check-in triggers only" is built from
  // TRIGGER_NAMES, not a literal in the source), so the source
  // check asserts the pop-out BODY facts; §22 proves the
  // rendered label. ASCII-safe substrings only: the source
  // holds \u2019 escapes, not the decoded apostrophe.
  check('redesign static: the vacation "?" pop-out says the countdown freezes and the five fast triggers keep firing (check-in-only)',
    appJs.indexOf('Freezes the check-in countdown') !== -1
    && appJs.indexOf('Price, UTXO, block-height, set-date, and fee-market triggers keep firing while you') !== -1,
    '');
  check('redesign static: the vacation card has the indefinite option ("Until I say I\'m back")',
    idx.indexOf('id="set-vacation-indefinite"') !== -1 && idx.indexOf("Until I say I'm back") !== -1, '');
  const armIdx = idx.indexOf('<h2>Global Arm/Disarm</h2>');
  const armBlock = armIdx === -1 ? '' : idx.slice(armIdx, armIdx + 900);
  check('redesign static: the Global Arm/Disarm card exists with Arm all / Disarm all buttons',
    armIdx !== -1 && idx.indexOf('id="btn-arm-all"') !== -1 && idx.indexOf('id="btn-disarm-all"') !== -1,
    armBlock.slice(0, 300));
  check('redesign static: the Global Arm/Disarm "?" pop-out says it applies to General and manual broadcasts still work',
    appJs.indexOf('General — not tied to a specific trigger') !== -1 && appJs.indexOf('A manual broadcast still works while disarmed') !== -1,
    '');
  check('redesign static: the frozen-bar CSS is in the served stylesheet',
    (await realFetch(BASE + '/style.css').then((r) => r.text())).indexOf('.ck-tx.frozen') !== -1, '');
  // Vacation from the UI, indefinite: the checkbox + save
  // persist vacationUntil null, the pill reads Vacation mode,
  // and the status line says the countdown is frozen.
  els['set-vacation'].checked = true;
  els['set-vacation-indefinite'].checked = true;
  fireChange(els['set-vacation-indefinite']);
  check('redesign vacation UI: checking indefinite disables the date input',
    els['set-vacation-until'] && els['set-vacation-until'].disabled === true, '');
  els['btn-save-vacation'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stVacInd = await (await fetch('/api/state')).json();
  check('redesign vacation UI: saving indefinite vacation persists (mode on, until null)',
    stVacInd.settings && stVacInd.settings.vacationMode === true && stVacInd.settings.vacationUntil === null,
    JSON.stringify(stVacInd.settings && { mode: stVacInd.settings.vacationMode, until: stVacInd.settings.vacationUntil }));
  await rerender(appJs);
  check('redesign vacation UI: the status pill reads "Vacation mode" while on vacation',
    els['status-pill'] && els['status-pill'].textContent === 'Vacation mode',
    els['status-pill'] && els['status-pill'].textContent);
  check('redesign vacation UI: the status line says the countdown is frozen',
    els['status-line'] && els['status-line'].textContent.indexOf('frozen') !== -1,
    els['status-line'] && els['status-line'].textContent);
  check('redesign vacation UI: after re-render the indefinite checkbox stays checked and the date stays disabled',
    els['set-vacation-indefinite'] && els['set-vacation-indefinite'].checked === true
    && els['set-vacation-until'] && els['set-vacation-until'].disabled === true, '');
  check('redesign vacation UI: no "Paused" state anywhere while on vacation',
    els['status-pill'] && els['status-pill'].textContent !== 'Paused', '');
  // Vacation from the UI, dated: uncheck indefinite, pick a
  // date, save — the date persists.
  els['set-vacation-indefinite'].checked = false;
  fireChange(els['set-vacation-indefinite']);
  check('redesign vacation UI: unchecking indefinite re-enables the date input',
    els['set-vacation-until'] && els['set-vacation-until'].disabled === false, '');
  els['set-vacation-until'].value = '2026-12-31';
  els['btn-save-vacation'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stVacDated = await (await fetch('/api/state')).json();
  check('redesign vacation UI: saving a dated vacation persists the date',
    stVacDated.settings && stVacDated.settings.vacationMode === true && stVacDated.settings.vacationUntil === '2026-12-31',
    JSON.stringify(stVacDated.settings && { mode: stVacDated.settings.vacationMode, until: stVacDated.settings.vacationUntil }));
  await rerender(appJs);
  check('redesign vacation UI: the dated status line names the date and the freeze',
    els['status-line'] && els['status-line'].textContent.indexOf('2026-12-31') !== -1
    && els['status-line'].textContent.indexOf('frozen') !== -1,
    els['status-line'] && els['status-line'].textContent);
  // Vacation off from the UI.
  els['set-vacation'].checked = false;
  els['btn-save-vacation'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stVacOff = await (await fetch('/api/state')).json();
  check('redesign vacation UI: turning vacation off from the UI persists',
    stVacOff.settings && stVacOff.settings.vacationMode === false, JSON.stringify(stVacOff.settings && stVacOff.settings.vacationMode));
  await rerender(appJs);
  check('redesign vacation UI: the pill is back to "On track" after vacation off',
    els['status-pill'] && els['status-pill'].textContent === 'On track',
    els['status-pill'] && els['status-pill'].textContent);
  // Global Arm/Disarm from the UI: Disarm all disarms every
  // tx (the seeded seven plus the 10d one), Arm all re-arms
  // them; the msg line confirms each way.
  els['btn-disarm-all'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stDisAll = await (await fetch('/api/state')).json();
  check('redesign arm-all UI: Disarm all disarms every staged tx',
    stDisAll.bitcoin && (stDisAll.bitcoin.txs || []).length > 0
    && (stDisAll.bitcoin.txs || []).every((t) => t.enabled === false),
    (stDisAll.bitcoin.txs || []).map((t) => t.label + '=' + t.enabled).join(', '));
  check('redesign arm-all UI: the msg line confirms the disarm',
    els['arm-all-msg'] && els['arm-all-msg'].textContent === 'All transactions disarmed.',
    els['arm-all-msg'] && els['arm-all-msg'].textContent);
  await rerender(appJs);
  check('redesign arm-all UI: while globally disarmed the check-in bars are frozen, not gone',
    (checkinBars() || []).length === 2
    && (checkinBars() || []).every((b) => b.cls.split(' ').includes('frozen')),
    JSON.stringify(checkinBars()));
  els['btn-arm-all'].click();
  await new Promise((r) => setTimeout(r, 900));
  const stArmAll = await (await fetch('/api/state')).json();
  check('redesign arm-all UI: Arm all re-arms every staged tx',
    stArmAll.bitcoin && (stArmAll.bitcoin.txs || []).length > 0
    && (stArmAll.bitcoin.txs || []).every((t) => t.enabled === true),
    (stArmAll.bitcoin.txs || []).map((t) => t.label + '=' + t.enabled).join(', '));
  check('redesign arm-all UI: the msg line confirms the arm',
    els['arm-all-msg'] && els['arm-all-msg'].textContent === 'All transactions armed.',
    els['arm-all-msg'] && els['arm-all-msg'].textContent);
  await rerender(appJs);
  check('redesign arm-all UI: after Arm all the check-in bars are live again (no frozen class)',
    (checkinBars() || []).length === 2
    && (checkinBars() || []).every((b) => !b.cls.split(' ').includes('frozen')),
    JSON.stringify(checkinBars()));

  // --- §22 (0.8.0): Settings "?" help — every Settings card
  // has a "?" button in its header; clicking it opens the shared
  // showDetails pop-out with the setting's title, what it does,
  // and an "Applies to:" line naming the trigger types; the
  // pop-out closes via the Close button and via the X.
  const HELP_KEYS = [
    { key: 'vacation', title: 'Vacation mode', bodyPhrase: 'Freezes the check-in countdown', appliesPhrase: 'Check-in triggers only' },
    { key: 'arm', title: 'Global Arm/Disarm', bodyPhrase: 'Arms or disarms every staged transaction', appliesPhrase: 'General' },
    { key: 'nodes', title: 'Bitcoin nodes', bodyPhrase: 'The Bitcoin nodes Standby talks to', appliesPhrase: 'General' },
    { key: 'price-sources', title: 'Bitcoin price source', bodyPhrase: 'The two price sources Standby reads', appliesPhrase: 'BTC price triggers only' },
    { key: 'grace', title: 'Grace period', bodyPhrase: 'A pause for price and UTXO triggers', appliesPhrase: 'BTC price and UTXO triggers' },
    { key: 'agreement', title: 'Price agreement', bodyPhrase: 'How closely the two price sources must agree', appliesPhrase: 'BTC price triggers only' },
    { key: 'cadence', title: 'Check cadence', bodyPhrase: 'How often every trigger is checked', appliesPhrase: 'BTC price, UTXO, Block height, Set date, and Fee market triggers' },
    { key: 'fee', title: 'Broadcast Fee Risk', bodyPhrase: 'Where the Low / Medium / High fee pill flips', appliesPhrase: 'General' },
    { key: 'keys', title: 'Check-in API keys', bodyPhrase: 'The keys that can check in through the API', appliesPhrase: 'Check-in triggers only' },
    { key: 'backup', title: 'Data backup', bodyPhrase: 'Back up or restore everything Standby knows', appliesPhrase: 'General' },
  ];
  // (The App version card has no "?" button and no details
  // pop-out — just the version line — so it is not in HELP_KEYS.
  // It is still in CARD_KEYS and TRUTH: the filter treats it as
  // General.)
  for (const h of HELP_KEYS) {
    check('help static: the ' + h.title + ' card has a "?" button in the served HTML',
      idx.indexOf('id="help-' + h.key + '"') !== -1, h.key);
    check('help static: the ' + h.title + ' button sits after its heading in the card header row',
      idx.indexOf('id="help-' + h.key + '"') > idx.indexOf('<h2>' + h.title + '</h2>'), h.key);
  }
  check('help static: all ten "?" buttons carry the accessible label',
    (idx.match(/aria-label="About this setting"/g) || []).length === 10,
    'count=' + ((idx.match(/aria-label="About this setting"/g) || []).length));
  check('help static: the served CSS styles the "?" button',
    (await realFetch(BASE + '/style.css').then((r) => r.text())).indexOf('.help-btn') !== -1, '');
  for (const h of HELP_KEYS) {
    els['help-' + h.key].click();
    check('help ' + h.key + ': clicking "?" opens the pop-out',
      els['confirm-modal'] && els['confirm-modal'].classList.contains('open'), h.key);
    check('help ' + h.key + ': the pop-out title is "' + h.title + '"',
      els['confirm-title'] && els['confirm-title'].textContent === h.title,
      els['confirm-title'] && els['confirm-title'].textContent);
    check('help ' + h.key + ': the pop-out body says what the setting does',
      els['confirm-body'] && els['confirm-body'].textContent.indexOf(h.bodyPhrase) !== -1,
      els['confirm-body'] && els['confirm-body'].textContent.slice(0, 80));
    check('help ' + h.key + ': the pop-out names the trigger types under "Applies to:"',
      els['modal-details'] && els['modal-details'].innerHTML.indexOf('Applies to:') !== -1
      && els['modal-details'].innerHTML.indexOf(h.appliesPhrase) !== -1,
      els['modal-details'] && els['modal-details'].innerHTML);
    els['confirm-cancel'].click();
    check('help ' + h.key + ': the Close button closes the pop-out',
      !(els['confirm-modal'] && els['confirm-modal'].classList.contains('open')), h.key);
  }
  // The X closes it too.
  els['help-vacation'].click();
  check('help X: the pop-out opens for the X check',
    els['confirm-modal'] && els['confirm-modal'].classList.contains('open'), '');
  els['modal-x'].click();
  check('help X: the X closes the pop-out',
    !(els['confirm-modal'] && els['confirm-modal'].classList.contains('open')), '');

  // --- §23 (0.8.0): Settings filter + trimmed card text ---
  // The filter row at the top of the Settings tab reads the
  // SAME triggers array the "?" pop-out renders its "Applies
  // to" line from (SETTINGS_HELP in app.js) — one declaration
  // per card, no second mapping. The inline description
  // paragraphs are trimmed to the essentials: the full text
  // lives in the "?" pop-out, and a card keeps at most one
  // short hint line where the input would be ambiguous
  // without it.
  const CARD_KEYS = ['vacation', 'arm', 'nodes', 'price-sources', 'grace', 'agreement', 'cadence', 'fee', 'keys', 'backup', 'version'];
  function visibleCards() {
    return CARD_KEYS.filter((k) => (els['card-' + k] && els['card-' + k].style.display) !== 'none');
  }
  // Static: the filter dropdown, its eight options in order,
  // All selected by default, and every card has its id.
  check('filter static: the filter dropdown exists at the top of the Settings tab, before the first card',
    idx.indexOf('id="filter-select"') !== -1
    && idx.indexOf('id="filter-select"') < idx.indexOf('id="card-vacation"'), '');
  const filterLabels = ['All settings', 'General', 'Check-in Trigger', 'BTC Price Trigger', 'UTXO Trigger', 'Block Height Trigger', 'Set Date Trigger', 'Fee Market Trigger'];
  let filterOrderOk = true;
  let lastPos = idx.indexOf('id="filter-select"');
  for (const lbl of filterLabels) {
    const p = idx.indexOf('>' + lbl + '<', lastPos);
    if (p === -1) { filterOrderOk = false; break; }
    lastPos = p;
  }
  check('filter static: the eight options read All settings / General / Check-in Trigger / BTC Price Trigger / UTXO Trigger / Block Height Trigger / Set Date Trigger / Fee Market Trigger, in that order',
    filterOrderOk, '');
  check('filter static: there is no Manual option (manual has no trigger-specific settings)',
    idx.indexOf('>Manual<') === -1, '');
  check('filter static: All settings is selected by default',
    idx.indexOf('<option value="all" selected>All settings</option>') !== -1, '');
  for (const k of CARD_KEYS) {
    check('filter static: the ' + k + ' card has its id for the filter',
      idx.indexOf('id="card-' + k + '"') !== -1, k);
  }
  check('filter static: the served CSS styles the filter dropdown',
    (await realFetch(BASE + '/style.css').then((r) => r.text())).indexOf('.settings-filter select') !== -1, '');
  // Static (trim): the long description paragraphs are gone
  // from the served page — no card keeps more than its short
  // hint line.
  const TRIMMED_GONE = [
    'Vacation applies to check-in rules only',
    'Disarming a check-in transaction freezes its countdown',
    'Where the app checks your transactions and broadcasts them',
    'Leave the secondary blank',
    'it never fires on a disagreement',
    'When Standby comes back after being offline',
    'Tighter is safer',
    'Faster catches an unconfirmed spend',
    'Where the fee pill flips',
    'The Low threshold must stay above the Medium one',
    'A key lets a service or app check in for you',
    'To add it as a custom integration',
    'Download a backup of everything needed',
  ];
  for (const phrase of TRIMMED_GONE) {
    check('trim static: the long paragraph is gone from the page — "' + phrase.slice(0, 40) + '"',
      idx.indexOf(phrase) === -1, phrase);
  }
  check('trim static: the kept short hints are still in the page',
    idx.indexOf('A mempool API endpoint — not an Electrum server or Bitcoin Core RPC') !== -1
    && idx.indexOf('The backup is not encrypted') !== -1
    && idx.indexOf('POST /checkin to check in, GET /health to test') !== -1
    && idx.indexOf('A reading is only trusted when the two agree within <span id="price-sources-agreement">5%</span>.') !== -1, '');
  // The trimmed facts still live in the "?" pop-outs (app.js).
  // The trimmed facts still live in the "?" pop-outs (app.js).
  // ASCII-safe substrings only: the source holds \u2019
  // escapes, not the decoded apostrophe.
  check('trim static: the moved facts still live in the "?" pop-outs',
    appJs.indexOf('Price, UTXO, block-height, set-date, and fee-market triggers keep firing while you') !== -1
    && appJs.indexOf('It contains the signed hexes, which reveal the destination addresses and amounts') !== -1
    && appJs.indexOf('A key can only record a check-in') !== -1
    && appJs.indexOf('The Low multiplier must stay above the Medium one') !== -1
    && appJs.indexOf('or your own mempool on the LAN') !== -1
    && appJs.indexOf('Leave the secondary blank to use the primary alone') !== -1
    && appJs.indexOf('is the one that decides') !== -1
    && appJs.indexOf('Standby evaluates all triggers \u2014 check-in, price, UTXO, block-height, set-date, and fee-market \u2014 together every X seconds') !== -1, '');
  // Dynamic: the default is All (everything visible).
  check('filter default: all eleven cards are visible before any filter click',
    JSON.stringify(visibleCards()) === JSON.stringify(CARD_KEYS), 'visible=' + visibleCards().join(', '));
  // Set the filter dropdown to a value and fire its change
  // event, the way a user picking an option would.
  function setFilter(name) {
    els['filter-select'].value = name;
    els['filter-select'].change();
  }
  function checkFilter(name, expected) {
    setFilter(name);
    const vis = visibleCards();
    check('filter ' + name + ': shows exactly the right cards',
      JSON.stringify(vis) === JSON.stringify(expected), 'visible=' + vis.join(', '));
    check('filter ' + name + ': the dropdown reads ' + name,
      els['filter-select'].value === name, 'value=' + els['filter-select'].value);
  }
  checkFilter('general', ['arm', 'nodes', 'fee', 'backup', 'version']);
  checkFilter('checkin', ['vacation', 'keys']);
  checkFilter('price', ['price-sources', 'grace', 'agreement', 'cadence']);
  checkFilter('utxo', ['grace', 'cadence']);
  checkFilter('blockheight', ['cadence']);
  checkFilter('setdate', ['cadence']);
  checkFilter('feemarket', ['cadence']);
  checkFilter('all', CARD_KEYS);
  // A hidden card is display:none, so its inputs are not
  // reachable.
  setFilter('price');
  check('filter hidden: under BTC Price the Vacation card is display:none (its inputs are not reachable)',
    els['card-vacation'] && els['card-vacation'].style.display === 'none',
    els['card-vacation'] && els['card-vacation'].style.display);
  setFilter('all');
  // Single source of truth: for one card in each category, the
  // "Applies to" label its "?" pop-out shows and the filters
  // under which it is visible must agree — both derive from
  // the same triggers array, so they cannot drift.
  function helpLabel(key) {
    els['help-' + key].click();
    const details = els['modal-details'] && els['modal-details'].innerHTML;
    const m = (details || '').match(/Applies to:<\/strong> ([^<]*)/);
    els['confirm-cancel'].click();
    return m ? m[1] : '';
  }
  const TRUTH = [
    { key: 'vacation', label: 'Check-in triggers only', visible: ['all', 'checkin'] },
    { key: 'grace', label: 'BTC price and UTXO triggers', visible: ['all', 'price', 'utxo'] },
    { key: 'cadence', label: 'BTC price, UTXO, Block height, Set date, and Fee market triggers', visible: ['all', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket'] },
    { key: 'fee', label: 'General — not tied to a specific trigger', visible: ['all', 'general'] },
    { key: 'keys', label: 'Check-in triggers only', visible: ['all', 'checkin'] },
    { key: 'nodes', label: 'General — not tied to a specific trigger', visible: ['all', 'general'] },
  ];
  // (The App version card is not in TRUTH: it has no "?" button,
  // so there is no pop-out label to read. Its filter visibility
  // — visible under All and General, hidden under the trigger
  // filters — is covered by the checkFilter calls above.)
  for (const t of TRUTH) {
    const label = helpLabel(t.key);
    check('single source: the ' + t.key + ' "?" pop-out label is "' + t.label + '"',
      label === t.label, label);
    for (const f of ['all', 'general', 'checkin', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket']) {
      setFilter(f);
      const shown = (els['card-' + t.key] && els['card-' + t.key].style.display) !== 'none';
      check('single source: the ' + t.key + ' card is ' + (t.visible.indexOf(f) !== -1 ? 'visible' : 'hidden')
        + ' under the ' + f + ' filter, matching its "' + t.label + '" label',
        shown === (t.visible.indexOf(f) !== -1),
        'display=' + (els['card-' + t.key] && els['card-' + t.key].style.display));
    }
  }
  setFilter('all');
  // Bitcoin nodes is general infrastructure, not a UTXO
  // setting: every trigger type needs the node for the
  // broadcast step, so the one ['general'] array puts it
  // under General only — not under UTXO or any trigger filter.
  setFilter('general');
  const nodesUnderGeneral = (els['card-nodes'] && els['card-nodes'].style.display) !== 'none';
  setFilter('utxo');
  const nodesUnderUtxo = (els['card-nodes'] && els['card-nodes'].style.display) !== 'none';
  setFilter('checkin');
  const nodesUnderCheckin = (els['card-nodes'] && els['card-nodes'].style.display) !== 'none';
  check('nodes general-only: the Bitcoin nodes card is visible under General and hidden under UTXO and Check-in',
    nodesUnderGeneral && !nodesUnderUtxo && !nodesUnderCheckin,
    'general=' + nodesUnderGeneral + ' utxo=' + nodesUnderUtxo + ' checkin=' + nodesUnderCheckin);
  // App version card (0.8.0): a short card at the very bottom of
  // General settings showing the installed version, from
  // /api/health. It is the last card in the Settings section
  // (after Data backup), so it is also last under the General
  // filter. The version is fetched once at startup; by this
  // point in the run it has resolved.
  check('app version static: the card exists after the backup card, with the version line',
    idx.indexOf('id="card-version"') !== -1 && idx.indexOf('id="card-version"') > idx.indexOf('id="card-backup"')
    && idx.indexOf('<h2>App version</h2>') !== -1
    && idx.indexOf('Installed version:') !== -1 && idx.indexOf('id="app-version"') !== -1, '');
  check('app version static: the card has no "?" button and no details (just the version line)',
    idx.indexOf('id="help-version"') === -1, '');
  check('app version: the installed version reads 0.8.4 (from /api/health)',
    els['app-version'] && els['app-version'].textContent === '0.8.4',
    els['app-version'] && els['app-version'].textContent);
  setFilter('general');
  check('app version: the card is visible under General',
    els['card-version'] && els['card-version'].style.display !== 'none',
    els['card-version'] && els['card-version'].style.display);
  setFilter('all');

  // --- §24 (0.8.2): per-tx History — its own collapsible nested
  // inside Details, collapsed by default, oldest first. The seeded txs
  // were added via the API, so each starts with one 'added' event
  // naming its rule (the server's wording — a straight apostrophe
  // in "don't", unlike the card subcard's \u2019) — and the §21
  // arm-all disarm + re-arm logged a 'disarmed' and an 'armed'
  // event on every one after that.
  function cardHistory(card) {
    for (const c of card.children) {
      if (c.className !== 'tx-details') continue;
      for (const d of c.children) { if (d.className === 'tx-history') return d; }
    }
    return null;
  }
  function histRows(card) {
    const h = cardHistory(card);
    if (!h) return null;
    for (const c of h.children) {
      if (c.className === 'timeline') return c.children;
    }
    return null;
  }
  const histCard = cardByTitle('Dom Check-in');
  check('history 0.8.2: the card has a History collapsible',
    !!cardHistory(histCard), histCard ? 'has history' : 'no history');
  check('history 0.8.2: History is collapsed by default',
    !!cardHistory(histCard) && cardHistory(histCard).open === false,
    cardHistory(histCard) ? 'open=' + cardHistory(histCard).open : 'no history');
  check('history 0.8.2: History is nested inside Details, last child of it',
    !!histCard && !!cardHistory(histCard)
    && (() => {
      for (const c of histCard.children) {
        if (c.className !== 'tx-details') continue;
        return c.children[c.children.length - 1] === cardHistory(histCard);
      }
      return false;
    })()
    && cardChildIndex(histCard, 'tx-details') < cardChildIndex(histCard, 'tx-actions'),
    histCard ? 'details=' + cardChildIndex(histCard, 'tx-details') + ' actions=' + cardChildIndex(histCard, 'tx-actions') : 'no card');
  const hRows = histCard ? histRows(histCard) : null;
  const hTypes = hRows ? hRows.map((r) => elText(r.children[1])) : [];
  check('history 0.8.2: oldest first — the first row is the added event',
    !!hRows && hRows.length >= 1 && elText(hRows[0].children[1]) === 'Transaction added',
    hRows ? hRows.length + ' rows, first=' + (hRows[0] ? elText(hRows[0].children[1]) : '') : 'no rows');
  check('history 0.8.2: the arm-all disarm + re-arm from §21 logged too',
    JSON.stringify(hTypes) === JSON.stringify(['Transaction added', 'Disarmed', 'Armed']), JSON.stringify(hTypes));
  check('history 0.8.2: the added row shows the rule as its detail',
    !!hRows && hRows.length >= 1 && hRows[0].children.length === 3
    && elText(hRows[0].children[2]) === "Fires when you don't check in for 35 days",
    hRows && hRows[0].children[2] ? elText(hRows[0].children[2]) : 'no detail');
  check('history 0.8.2: the added row has a plain grey dot',
    !!hRows && hRows.length >= 1 && hRows[0].children[0].className === 'dot',
    hRows ? hRows[0].children[0].className : 'no dot');
  check('history 0.8.2: the added row carries a short time ("Nov 18, 8:52 AM")',
    !!hRows && hRows.length >= 1 && hRows[0].children[1].children.length === 1
    && /[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/.test(hRows[0].children[1].children[0].textContent),
    hRows ? elText(hRows[0].children[1]) : 'no row');
  // Every seeded card carries History — the manual one too.
  const histManual = cardByTitle('Dom Manual');
  const hRowsM = histManual ? histRows(histManual) : null;
  const hTypesM = hRowsM ? hRowsM.map((r) => elText(r.children[1])) : [];
  check('history 0.8.2: the manual card has History with the manual line first',
    !!hRowsM && hRowsM.length >= 1 && hRowsM[0].children.length === 3
    && elText(hRowsM[0].children[2]) === 'Never fires — manual only'
    && JSON.stringify(hTypesM) === JSON.stringify(['Transaction added', 'Disarmed', 'Armed']),
    hRowsM ? JSON.stringify(hTypesM) + ' / ' + elText(hRowsM[0].children[2]) : 'no manual history');
  // Toggling History open flips it (the listener is wired).
  const hDet = cardHistory(histCard);
  if (hDet) toggleDetails(hDet, true);
  check('history 0.8.2: toggling History open flips it',
    !!hDet && hDet.open === true, hDet ? 'open=' + hDet.open : 'no history');

  // --- 25. rule sets: per-rule subcards, the combination line,
  // readiness joins, the check-in bar, and the rule-list
  // interactions (0.8.2) ---
  // Two multi-rule txs via the API: an OR set (price >= 150000
  // OR blockheight 1,000,000) and an AND set (check-in 35d AND
  // price >= 90000). Neither is already satisfied as a set —
  // the AND needs both rules at once — so no triggerConfirmed.
  const addOr = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200301), label: 'Dom Rules OR', trigger: { op: 'OR', rules: [{ type: 'price', params: { op: '>=', value: 150000 } }, { type: 'blockheight', params: { targetHeight: 1000000 } }] } }) });
  check('rule sets 0.8.2: the 2-rule OR tx adds via the API', addOr.status === 201, 'status=' + addOr.status);
  const addAnd = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200302), label: 'Dom Rules AND', trigger: { op: 'AND', rules: [{ type: 'checkin', params: { thresholdDays: 35 } }, { type: 'price', params: { op: '>=', value: 90000 } }] } }) });
  check('rule sets 0.8.2: the 2-rule AND tx adds via the API', addAnd.status === 201, 'status=' + addAnd.status);
  // Two more single-rule txs for the v2 pill states: a UTXO rule
  // on an outpoint the stubs 404 (unknown — "could not check the
  // outpoint") and a check-in tx whose slice turns 'vacation'
  // (Held) once vacation mode goes on at the end of §25.
  const addUnk = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200303), label: 'Dom Rules Unknown', trigger: { type: 'utxo', params: { outpoint: '0000000000000000000000000000000000000000000000000000000000000000:0', condition: 'spent', confirmations: 1 } } }) });
  check('rule sets 0.8.2 v2: the UTXO-unknown tx adds via the API', addUnk.status === 201, 'status=' + addUnk.status);
  const addHeld = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200304), label: 'Dom Rules Held', trigger: { type: 'checkin', params: { thresholdDays: 35 } } }) });
  check('rule sets 0.8.2 v2: the check-in Held tx adds via the API', addHeld.status === 201, 'status=' + addHeld.status);
  // One release check so the per-rule state lines are fresh
  // (the price/tip readings land in the slices).
  // One release check so the per-rule state lines are fresh
  // (the price/tip readings land in the slices). The price
  // cache is fresh for 60s and still holds the disagreeing
  // readings from the exchange-status section above, so wait
  // past it first — otherwise the release check reads the stale
  // disagreement and the price rules stay 'unknown' (correct
  // fail-safe behavior, but not the live values this checks).
  await new Promise((r) => setTimeout(r, 65000));
  const rel25 = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('rule sets 0.8.2: a release check runs so the rule state lines are fresh', rel25.status === 200, 'status=' + rel25.status);
  await rerender(appJs);
  const orCard = cardByTitle('Dom Rules OR');
  const orBoxes = orCard ? triggerBoxes(orCard) : [];
  check('rule sets 0.8.2: the OR card has two subcards', orBoxes.length === 2, 'boxes=' + orBoxes.length);
  check('rule sets 0.8.2: the OR combination line reads "Broadcasts when ANY rule fires"',
    !!orCard && comboLine(orCard) === 'Broadcasts when ANY rule fires', orCard ? comboLine(orCard) : 'no card');
  check('rule sets 0.8.2: the OR subcards read "Rule 1 \u2014 BTC Price" / "Rule 2 \u2014 Block height"',
    orBoxes.length === 2 && boxParts(orBoxes[0]).k === 'Rule 1 \u2014 BTC Price' && boxParts(orBoxes[1]).k === 'Rule 2 \u2014 Block height',
    orBoxes.map((b) => boxParts(b) && boxParts(b).k).join(' / '));
  check('rule sets 0.8.2: the OR subcard conditions are the two rules',
    orBoxes.length === 2 && boxParts(orBoxes[0]).cond === 'Fires when BTC price \u2265 $150,000' && boxParts(orBoxes[1]).cond === 'Fires when the chain reaches block 1,000,000',
    orBoxes.map((b) => boxParts(b) && boxParts(b).cond).join(' / '));
  check('rule sets 0.8.2: the OR subcard state lines read the live values (price $98,200, tip 900,000)',
    orBoxes.length === 2 && boxParts(orBoxes[0]).now === 'BTC price currently $98,200' && boxParts(orBoxes[1]).now === 'Chain at block 900,000 of 1,000,000',
    orBoxes.map((b) => boxParts(b) && boxParts(b).now).join(' / '));
  const andCard = cardByTitle('Dom Rules AND');
  const andBoxes = andCard ? triggerBoxes(andCard) : [];
  check('rule sets 0.8.2: the AND card has two subcards', andBoxes.length === 2, 'boxes=' + andBoxes.length);
  check('rule sets 0.8.2: the AND combination line reads "Broadcasts when ALL rules hold"',
    !!andCard && comboLine(andCard) === 'Broadcasts when ALL rules hold', andCard ? comboLine(andCard) : 'no card');
  check('rule sets 0.8.2: the AND subcards read "Rule 1 \u2014 Check-in" / "Rule 2 \u2014 BTC Price"',
    andBoxes.length === 2 && boxParts(andBoxes[0]).k === 'Rule 1 \u2014 Check-in' && boxParts(andBoxes[1]).k === 'Rule 2 \u2014 BTC Price',
    andBoxes.map((b) => boxParts(b) && boxParts(b).k).join(' / '));
  check('rule sets 0.8.2: the AND check-in condition keeps the app wording (don\u2019t)',
    andBoxes.length === 2 && boxParts(andBoxes[0]).cond === 'Fires when you don\u2019t check in for 35 days',
    andBoxes.length ? boxParts(andBoxes[0]).cond : 'no box');
  check('rule sets 0.8.2: the AND subcard state lines read the live values (check-in 0 of 35, price $98,200)',
    andBoxes.length === 2 && boxParts(andBoxes[0]).now === '0 of 35 days since last check-in' && boxParts(andBoxes[1]).now === 'BTC price currently $98,200',
    andBoxes.map((b) => boxParts(b) && boxParts(b).now).join(' / '));
  // (0.8.2 v2) The per-rule state pills: the AND card shows one
  // Not met (check-in, 0 of 35) and one Met (price $98,200 past
  // $90,000); the OR card shows two Not met (price below
  // $150,000, tip below 1,000,000). Only "Met" is green.
  const pillStr = (boxes) => boxes.map((b) => boxParts(b) && (boxParts(b).pill + '/' + boxParts(b).pillCls)).join(' / ');
  check('rule sets 0.8.2 v2: the AND pills read "Not met" (muted) / "Met" (green)',
    andBoxes.length === 2 && boxParts(andBoxes[0]).pill === 'Not met' && boxParts(andBoxes[0]).pillCls === 'pill muted'
    && boxParts(andBoxes[1]).pill === 'Met' && boxParts(andBoxes[1]).pillCls === 'pill ok',
    pillStr(andBoxes));
  check('rule sets 0.8.2 v2: the OR pills both read "Not met" (muted)',
    orBoxes.length === 2 && boxParts(orBoxes[0]).pill === 'Not met' && boxParts(orBoxes[0]).pillCls === 'pill muted'
    && boxParts(orBoxes[1]).pill === 'Not met' && boxParts(orBoxes[1]).pillCls === 'pill muted',
    pillStr(orBoxes));
  const rbOr = readinessBlock('Dom Rules OR');
  check('rule sets 0.8.2: the OR readiness line joins the conditions with OR',
    !!rbOr && rbOr.state === 'Fires when BTC price \u2265 $150,000 OR the chain reaches block 1,000,000', rbOr ? rbOr.state : 'no block');
  const rbAnd = readinessBlock('Dom Rules AND');
  check('rule sets 0.8.2: the AND readiness line joins the conditions with AND',
    !!rbAnd && rbAnd.state === 'Fires when you don\u2019t check in for 35 days AND BTC price \u2265 $90,000', rbAnd ? rbAnd.state : 'no block');
  // A one-rule card is unchanged: one subcard, no combination line.
  const oneCard = cardByTitle('Dom Price');
  check('rule sets 0.8.2: a one-rule card still has exactly one subcard and no combination line',
    !!oneCard && triggerBoxes(oneCard).length === 1 && comboLine(oneCard) === null,
    oneCard ? 'boxes=' + triggerBoxes(oneCard).length + ' combo=' + comboLine(oneCard) : 'no card');
  check('rule sets 0.8.2: the one-rule subcard header is still "TRIGGER - BTC PRICE"',
    !!oneCard && boxParts(triggerBoxes(oneCard)[0]).k === 'TRIGGER - BTC PRICE',
    oneCard ? boxParts(triggerBoxes(oneCard)[0]).k : 'no card');
  // (0.8.2 v2) A one-rule card gets the same pill; a manual rule
  // gets none; the UTXO-unknown tx reads "Unknown" (amber).
  check('rule sets 0.8.2 v2: the one-rule Dom Price subcard has a "Not met" pill',
    !!oneCard && boxParts(triggerBoxes(oneCard)[0]).pill === 'Not met' && boxParts(triggerBoxes(oneCard)[0]).pillCls === 'pill muted',
    oneCard ? pillStr(triggerBoxes(oneCard)) : 'no card');
  const manCard = cardByTitle('Dom Manual');
  check('rule sets 0.8.2 v2: the one-rule Dom Manual subcard has NO pill',
    !!manCard && triggerBoxes(manCard).length === 1 && boxParts(triggerBoxes(manCard)[0]).pill === null,
    manCard ? ('pill=' + boxParts(triggerBoxes(manCard)[0]).pill) : 'no card');
  const unkCard = cardByTitle('Dom Rules Unknown');
  check('rule sets 0.8.2 v2: the UTXO-unknown subcard has an "Unknown" amber pill',
    !!unkCard && triggerBoxes(unkCard).length === 1 && boxParts(triggerBoxes(unkCard)[0]).pill === 'Unknown' && boxParts(triggerBoxes(unkCard)[0]).pillCls === 'pill warn',
    unkCard ? pillStr(triggerBoxes(unkCard)) : 'no card');
  // The AND set's check-in rule gets its own bar; the OR set
  // has no check-in rule and gets none.
  check('rule sets 0.8.2: the AND tx has a check-in bar (its check-in rule)',
    !!checkinBar('Dom Rules AND'), JSON.stringify(checkinBars()));
  check('rule sets 0.8.2: the OR tx has no check-in bar (no check-in rule)',
    !checkinBar('Dom Rules OR'), JSON.stringify(checkinBars()));
  // Rule-list interactions on the Add form.
  check('rule sets 0.8.2: the Add form starts §25 with one panel', rulePanels('btc').length === 1, 'panels=' + rulePanels('btc').length);
  els['btc-add-rule'].click();
  check('rule sets 0.8.2: Add-rule appends a second panel titled "Rule 2"',
    rulePanels('btc').length === 2 && rulePanels('btc')[1].children[0].children[0].textContent === 'Rule 2',
    'panels=' + rulePanels('btc').length);
  check('rule sets 0.8.2: with two panels both Remove buttons show',
    !!panelRemoveBtn(rulePanels('btc')[0]) && panelRemoveBtn(rulePanels('btc')[0]).style.display !== 'none'
    && !!panelRemoveBtn(rulePanels('btc')[1]) && panelRemoveBtn(rulePanels('btc')[1]).style.display !== 'none', '');
  els['btc-op-all'].click();
  check('rule sets 0.8.2 v2: with two panels the one-rule note hides',
    els['btc-op-note'] && els['btc-op-note'].style.display === 'none',
    els['btc-op-note'] && els['btc-op-note'].style.display);
  check('rule sets 0.8.2 v2: the All card selects ("op-card selected") and the Any card deselects',
    els['btc-op-all'] && els['btc-op-all'].className === 'op-card selected' && els['btc-op-any'] && els['btc-op-any'].className === 'op-card',
    'any=' + (els['btc-op-any'] && els['btc-op-any'].className) + ' all=' + (els['btc-op-all'] && els['btc-op-all'].className));
  els['btc-op-any'].click();
  check('rule sets 0.8.2 v2: the Any card selects back',
    els['btc-op-any'] && els['btc-op-any'].className === 'op-card selected' && els['btc-op-all'] && els['btc-op-all'].className === 'op-card',
    'any=' + (els['btc-op-any'] && els['btc-op-any'].className) + ' all=' + (els['btc-op-all'] && els['btc-op-all'].className));
  // The 5-rule cap: three more adds reach 5, the Add button
  // disables and the note shows, and a 6th add does nothing.
  els['btc-add-rule'].click();
  els['btc-add-rule'].click();
  els['btc-add-rule'].click();
  check('rule sets 0.8.2: three more adds reach the 5-rule cap',
    rulePanels('btc').length === 5, 'panels=' + rulePanels('btc').length);
  check('rule sets 0.8.2: at the cap the Add-rule button disables and the cap note shows',
    els['btc-add-rule'] && els['btc-add-rule'].disabled === true
    && els['btc-rules-cap-note'] && els['btc-rules-cap-note'].style.display !== 'none',
    'disabled=' + (els['btc-add-rule'] && els['btc-add-rule'].disabled) + ' note=' + (els['btc-rules-cap-note'] && els['btc-rules-cap-note'].style.display));
  els['btc-add-rule'].click();
  check('rule sets 0.8.2: a 6th add at the cap adds nothing', rulePanels('btc').length === 5, 'panels=' + rulePanels('btc').length);
  // Removing a panel renumbers the rest and re-enables Add.
  panelRemoveBtn(rulePanels('btc')[4]).click();
  check('rule sets 0.8.2: removing the last panel leaves 4, renumbered "Rule 1".."Rule 4"',
    rulePanels('btc').length === 4
    && rulePanels('btc').map((p) => p.children[0].children[0].textContent).join(',') === 'Rule 1,Rule 2,Rule 3,Rule 4',
    'panels=' + rulePanels('btc').length + ' titles=' + rulePanels('btc').map((p) => p.children[0].children[0].textContent).join(','));
  check('rule sets 0.8.2: below the cap the Add-rule button re-enables and the cap note hides',
    els['btc-add-rule'] && els['btc-add-rule'].disabled === false
    && els['btc-rules-cap-note'] && els['btc-rules-cap-note'].style.display === 'none',
    'disabled=' + (els['btc-add-rule'] && els['btc-add-rule'].disabled) + ' note=' + (els['btc-rules-cap-note'] && els['btc-rules-cap-note'].style.display));
  // A manual rule shows the manual row in its own panel.
  const mp = rulePanels('btc')[1];
  const msel = panelTypeSelect(mp);
  msel.value = 'manual';
  fireChange(msel);
  check('rule sets 0.8.2: a manual rule shows only its manual row ("Never fires \u2014 manual only")',
    panelRowVisible(mp, 'btc-rule-1-trigger-manual-row')
    && !panelRowVisible(mp, 'btc-rule-1-trigger-checkin-row') && !panelRowVisible(mp, 'btc-rule-1-trigger-price-row')
    && findById(mp, 'btc-rule-1-trigger-manual-note').textContent === 'Never fires \u2014 manual only',
    'manual=' + panelRowVisible(mp, 'btc-rule-1-trigger-manual-row'));
  // (0.8.2 v2) No duplicate types: the types the other panels
  // use are disabled in each panel's picker and labelled
  // "(already used)"; the panel's own type stays available.
  // Panels now read [check-in, manual, utxo, blockheight].
  const dup0 = rulePanels('btc')[0];
  check('rule sets 0.8.2 v2: panel 1 (check-in) greys out manual, utxo and blockheight but keeps check-in and price',
    panelOption(dup0, 'manual') && panelOption(dup0, 'manual').disabled === true && panelOption(dup0, 'manual').textContent === 'Manual only — no trigger (already used)'
    && panelOption(dup0, 'utxo').disabled === true && panelOption(dup0, 'blockheight').disabled === true
    && panelOption(dup0, 'checkin').disabled === false && panelOption(dup0, 'price').disabled === false,
    ['manual', 'utxo', 'blockheight', 'checkin', 'price'].map((v) => v + '=' + (panelOption(dup0, v) && panelOption(dup0, v).disabled)).join(' '));
  const dup1 = rulePanels('btc')[1];
  check('rule sets 0.8.2 v2: panel 2 (manual) greys out check-in but keeps manual',
    panelOption(dup1, 'checkin').disabled === true && panelOption(dup1, 'manual').disabled === false,
    'checkin=' + panelOption(dup1, 'checkin').disabled + ' manual=' + panelOption(dup1, 'manual').disabled);
  // Changing a type frees the old one and takes the new one.
  const dupSel2 = panelTypeSelect(rulePanels('btc')[2]);
  dupSel2.value = 'setdate';
  fireChange(dupSel2);
  check('rule sets 0.8.2 v2: changing panel 3 to set-date frees utxo and takes set-date in the other pickers',
    panelOption(rulePanels('btc')[0], 'utxo').disabled === false
    && panelOption(rulePanels('btc')[0], 'setdate').disabled === true
    && panelOption(rulePanels('btc')[0], 'setdate').textContent === 'Set date (already used)',
    'utxo=' + panelOption(rulePanels('btc')[0], 'utxo').disabled + ' setdate=' + panelOption(rulePanels('btc')[0], 'setdate').disabled);
  // Removing a panel frees its type.
  panelRemoveBtn(rulePanels('btc')[3]).click();
  check('rule sets 0.8.2 v2: removing panel 4 frees blockheight in the other pickers',
    rulePanels('btc').length === 3 && panelOption(rulePanels('btc')[0], 'blockheight').disabled === false
    && panelOption(rulePanels('btc')[0], 'blockheight').textContent === 'Block height',
    'panels=' + rulePanels('btc').length + ' blockheight=' + panelOption(rulePanels('btc')[0], 'blockheight').disabled);
  // Edit pre-fills the OR set: two panels, OR toggle, both rules.
  const orEdit = orCard && cardButton(orCard, 'Edit');
  check('rule sets 0.8.2: the OR card has an Edit button', !!orEdit, '');
  if (orEdit) orEdit.click();
  check('rule sets 0.8.2: Edit on the OR tx pre-fills two panels',
    rulePanels('edit').length === 2, 'panels=' + rulePanels('edit').length);
  check('rule sets 0.8.2 v2: Edit on the OR tx shows the OR card selected',
    els['edit-op-any'] && els['edit-op-any'].className === 'op-card selected'
    && els['edit-op-all'] && els['edit-op-all'].className === 'op-card',
    'any=' + (els['edit-op-any'] && els['edit-op-any'].className) + ' all=' + (els['edit-op-all'] && els['edit-op-all'].className));
  check('rule sets 0.8.2 v2: Edit pre-fill greys out the other panel\'s type in each picker',
    panelOption(rulePanels('edit')[0], 'blockheight').disabled === true
    && panelOption(rulePanels('edit')[0], 'price').disabled === false
    && panelOption(rulePanels('edit')[1], 'price').disabled === true
    && panelOption(rulePanels('edit')[1], 'blockheight').disabled === false,
    'edit0 blockheight=' + panelOption(rulePanels('edit')[0], 'blockheight').disabled
    + ' edit1 price=' + panelOption(rulePanels('edit')[1], 'price').disabled);
  check('rule sets 0.8.2: Edit on the OR tx pre-fills rule 1 price 150000 and rule 2 blockheight 1000000',
    rulePanels('edit').length === 2
    && panelTypeSelect(rulePanels('edit')[0]).value === 'price' && findById(rulePanels('edit')[0], 'edit-rule-0-value').value === '150000'
    && panelTypeSelect(rulePanels('edit')[1]).value === 'blockheight' && findById(rulePanels('edit')[1], 'edit-rule-1-blockheight').value === '1000000',
    'r1=' + (panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value) + ' r2=' + (rulePanels('edit')[1] && panelTypeSelect(rulePanels('edit')[1]).value));
  // (0.8.2 v2) Held: vacation mode freezes the check-in clock,
  // so the Held tx's slice turns 'vacation' — an amber "Held"
  // pill. Restored immediately after, so nothing else sees it.
  const vacOn = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vacationMode: true, vacationUntil: null }) });
  check('rule sets 0.8.2 v2: vacation mode turns on for the Held check', vacOn.status === 200, 'status=' + vacOn.status);
  await rerender(appJs);
  const heldCard = cardByTitle('Dom Rules Held');
  check('rule sets 0.8.2 v2: with vacation on, the check-in subcard has a "Held" amber pill',
    !!heldCard && triggerBoxes(heldCard).length === 1 && boxParts(triggerBoxes(heldCard)[0]).pill === 'Held' && boxParts(triggerBoxes(heldCard)[0]).pillCls === 'pill warn',
    heldCard ? pillStr(triggerBoxes(heldCard)) : 'no card');
  const vacOff = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vacationMode: false, vacationUntil: null }) });
  check('rule sets 0.8.2 v2: vacation mode turns back off', vacOff.status === 200, 'status=' + vacOff.status);
  await rerender(appJs);

  console.log();
  console.log('FAILURES: ' + failures.length + (failures.length ? ' ' + JSON.stringify(failures) : ' (none)'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('SHIM ERROR:', e); process.exit(1); });
