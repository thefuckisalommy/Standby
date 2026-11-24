// dom_check099_error.js — DOM coverage for the 0.8.3 error screen
// (#state-error-card) and the restore / start-fresh flows.
//
// The main DOM suite boots a healthy app, so the broken-state view
// was never exercised from the client side: the gating regex, the
// show/hide logic, and the two rescue buttons could all have
// regressed silently. This script boots its OWN instance (ports
// 3468/3469, stubs 18265/18266, data /tmp/heirloom099-dom-err) so
// it can break the state and restart the app without disturbing
// the main DOM run. dom_launcher099.py boots the instance and seeds
// one tx, then runs this script after the width check; the script
// kills and respawns the app itself (by exact PID, never pkill).
//
// Exits 0 when every check passes, 1 otherwise. Prints one
// PASS/FAIL line per check, then FAILURES: N.
//
// The harness block below (El shim, document/window/fetch stubs,
// check(), rerender()) is copied verbatim from dom_check099.js
// lines 125-530, with only BASE/DATA_FILE made env-driven —
// keep it in sync when the main shim changes.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

// app.js calls location.reload() after a successful restore or
// reset; observe it instead of navigating anywhere.
global.location = { reload: () => { global.__reloaded = true; } };

const fs = require('fs');
const BASE = process.env.ERR_BASE || 'http://127.0.0.1:3468';
const DATA_FILE = (process.env.ERR_DATA || '/tmp/heirloom099-dom-err') + '/state.json';
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
  insertBefore(c, ref) {
    // (0.8.10, fix 4) The load-failure notice uses insertBefore
    // (first child of <main>); a null/unknown ref appends, like the
    // real DOM. The shim's <main> override captures the insert.
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
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
  querySelector: (sel) => (sel === 'main' ? Object.assign(new El('main'), { insertAdjacentHTML: (pos, html) => { global.__loadError = html; }, insertBefore: (el, ref) => { global.__loadNotice = el; } }) : new El('div')),
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

// --- error-flow helpers -------------------------------------------------
const APP_DIR = process.env.ERR_APP_DIR
  || (fs.existsSync(path.join(__dirname, '..', 'standby', 'server.js'))
    ? path.join(__dirname, '..', 'standby')
    : fs.existsSync(path.join(__dirname, '..', 'branch-0.8.6', 'server.js'))
      ? path.join(__dirname, '..', 'branch-0.8.6')
      : fs.existsSync(path.join(__dirname, '..', 'branch-0.8.5', 'server.js'))
        ? path.join(__dirname, '..', 'branch-0.8.5')
        : fs.existsSync(path.join(__dirname, '..', 'branch-0.8.4', 'server.js'))
        ? path.join(__dirname, '..', 'branch-0.8.4')
        : fs.existsSync(path.join(__dirname, '..', 'branch-0.8.3', 'server.js'))
          ? path.join(__dirname, '..', 'branch-0.8.3')
          : path.join(__dirname, '..', 'app'));
const DATA = process.env.ERR_DATA || '/tmp/heirloom099-dom-err';
const CHECKIN_DIR = process.env.ERR_CHECKIN || '/tmp/heirloom099-dom-err-checkin';
const STUB_P = process.env.ERR_STUB_P || '18265';
const STUB_S = process.env.ERR_STUB_S || '18266';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let appChild = null; // the currently running app process (spawned here)
let appPid = process.env.ERR_APP_PID ? Number(process.env.ERR_APP_PID) : null;

async function waitHealth(want) {
  // Poll /api/health until it answers with the wanted status
  // (200 healthy, 500 broken) or 15 s pass. Returns the last status
  // seen, or 0 if the port never answered at all.
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < 15000) {
    try {
      const r = await realFetch(BASE + '/api/health');
      last = r.status;
      if (last === want) return last;
    } catch (e) { last = 0; }
    await sleep(250);
  }
  return last;
}

async function waitPortClosed() {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    try { await realFetch(BASE + '/api/health'); } catch (e) { return true; }
    await sleep(250);
  }
  return false;
}

async function stopApp() {
  if (appPid) {
    try { process.kill(appPid, 'SIGTERM'); } catch (e) { /* already gone */ }
    appPid = null;
  }
  if (appChild) { try { appChild.kill('SIGTERM'); } catch (e) { /* already gone */ } appChild = null; }
  await waitPortClosed();
}

function startApp() {
  const env = Object.assign({}, process.env, {
    PORT: String(process.env.ERR_PORT || '3468'),
    DATA_DIR: DATA,
    CHECKIN_DIR,
    SLIPSTREAM_API_URL: 'http://127.0.0.1:' + STUB_P,
    PRICE_API_URL: 'http://127.0.0.1:' + STUB_P,
  });
  appChild = spawn('node', ['server.js'], { cwd: APP_DIR, env, stdio: 'ignore' });
  appPid = appChild.pid;
}

function corruptState() {
  fs.writeFileSync(path.join(DATA, 'state.json'), 'GARBAGE');
  for (const f of fs.readdirSync(DATA)) {
    if (f.startsWith('state.json.bak')) fs.writeFileSync(path.join(DATA, f), 'GARBAGE');
  }
}

function errorCardVisible() {
  // The shim never parses the static HTML, so the card's inline
  // style="display:none" is invisible here: style.display starts
  // undefined, and only showStateError() ever sets it (to '').
  // Shown therefore means exactly '' — never 'none', never
  // undefined.
  const card = document.getElementById('state-error-card');
  return !!card && card.style.display === '';
}

(async () => {
  const appJs = await realFetch(BASE + '/app.js').then((r) => r.text());
  eval(appJs);
  await sleep(900); // load() fetches state + renders

  // --- healthy baseline ------------------------------------------------
  check('error: load completed (no load error)', !global.__loadError, global.__loadError || '');
  check('error: error card hidden on a healthy app', !errorCardVisible(), '');
  const st0 = await (await fetch('/api/state')).json();
  check('error: seeded tx present before breaking', (st0.bitcoin.txs || []).length === 1, (st0.bitcoin.txs || []).length);
  const backup = await (await fetch('/api/backup')).text();
  check('error: backup downloads before breaking', backup.indexOf('Dom Error') !== -1, backup.slice(0, 120));

  // --- break the state, restart, the error view shows -----------------
  await stopApp();
  corruptState();
  startApp();
  check('error: health 500s after corrupting state + backups', (await waitHealth(500)) === 500, '');
  await rerender(appJs);
  check('error: error card shows on broken state', errorCardVisible(), '');
  check('error: tab bar hidden while the error view is up',
    document.getElementById('tabs').style.display === 'none', '');
  check('error: detail names the corrupt state file',
    (document.getElementById('state-error-detail').textContent || '').indexOf('state.json is corrupt') !== -1,
    document.getElementById('state-error-detail').textContent || '');
  check('error: no plain notice — the state-error path was taken, not the generic one',
    !global.__loadError, global.__loadError || '');

  // --- restore from the backup file ------------------------------------
  global.__reloaded = false;
  document.getElementById('btn-state-restore').click();
  const fileInput = document.getElementById('state-restore-file');
  fileInput.files = [{ __content: backup }];
  fileInput.change();
  await sleep(800);
  check('error: restore reports the restored transaction',
    (document.getElementById('state-error-msg').textContent || '').indexOf('Restored 1 transaction') !== -1,
    document.getElementById('state-error-msg').textContent || '');
  check('error: restore reloads the page', global.__reloaded === true, '');
  check('error: health 200 again after restore', (await waitHealth(200)) === 200, '');
  const st1 = await (await fetch('/api/state')).json();
  check('error: the seeded tx is back after restore',
    (st1.bitcoin.txs || []).length === 1 && (st1.bitcoin.txs[0] || {}).label === 'Dom Error', (st1.bitcoin.txs || []).length);
  await rerender(appJs); // simulate the reload
  check('error: error card hidden again after restore + reload', !errorCardVisible(), '');
  check('error: tx card visible again after restore + reload',
    txCards().some((c) => cardTitle(c) === 'Dom Error'), txCards().map(cardTitle).join(', '));

  // --- break it again, start fresh --------------------------------------
  await stopApp();
  corruptState();
  startApp();
  check('error: health 500s after breaking it a second time', (await waitHealth(500)) === 500, '');
  await rerender(appJs);
  check('error: error card shows again on the second break', errorCardVisible(), '');
  document.getElementById('btn-state-reset').click();
  await sleep(200);
  check('error: start-fresh opens the confirm modal',
    document.getElementById('confirm-modal').classList.contains('open'), '');
  check('error: confirm title is Start fresh?',
    document.getElementById('confirm-title').textContent === 'Start fresh?',
    document.getElementById('confirm-title').textContent || '');
  check('error: confirm button reads Start fresh',
    document.getElementById('confirm-proceed').textContent === 'Start fresh',
    document.getElementById('confirm-proceed').textContent || '');
  global.__reloaded = false;
  document.getElementById('confirm-proceed').click();
  await sleep(800);
  check('error: start-fresh reloads the page', global.__reloaded === true, '');
  check('error: health 200 again after start fresh', (await waitHealth(200)) === 200, '');
  const st2 = await (await fetch('/api/state')).json();
  check('error: state is a fresh default after start fresh (0 txs)',
    (st2.bitcoin.txs || []).length === 0, (st2.bitcoin.txs || []).length);
  await rerender(appJs); // simulate the reload
  check('error: error card hidden after start fresh + reload', !errorCardVisible(), '');
  check('error: Getting Started shows on the fresh state (no staged txs)',
    document.getElementById('getting-started-card')
      && document.getElementById('getting-started-card').style.display !== 'none',
    document.getElementById('getting-started-card') && document.getElementById('getting-started-card').style.display);

  // --- load-failure notice escapes markup (0.8.10, fix 4) ------------
  // The generic notice (not the state-error card) fires when load()
  // fails with an error that is NOT a corrupt/missing state file.
  // Feed it one whose message is markup: the old insertAdjacentHTML
  // code would have parsed it as HTML; the textContent code must
  // render it literally, with no element children.
  const savedFetch = global.fetch;
  global.fetch = (path, opts) => {
    if (path === '/api/state') {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: '<b>markup</b> & "quotes"' }) });
    }
    return savedFetch(path, opts);
  };
  global.__loadNotice = undefined;
  global.__loadError = undefined;
  await rerender(appJs);
  check('error: markup load failure takes the generic notice, not the state-error card',
    !!global.__loadNotice && !errorCardVisible(),
    global.__loadNotice ? global.__loadNotice.textContent : 'no notice');
  check('error: the notice text is literal markup, not parsed HTML',
    !!global.__loadNotice && global.__loadNotice.textContent.indexOf('<b>markup</b>') !== -1,
    global.__loadNotice ? global.__loadNotice.textContent : 'no notice');
  check('error: the notice has no element children (nothing was parsed as HTML)',
    !!global.__loadNotice && global.__loadNotice.children.length === 0,
    global.__loadNotice ? global.__loadNotice.children.length : 'no notice');
  check('error: the notice keeps the .notice.bad classes',
    !!global.__loadNotice && global.__loadNotice.className === 'notice bad',
    global.__loadNotice ? global.__loadNotice.className : 'no notice');
  check('error: the old insertAdjacentHTML path was not taken',
    !global.__loadError, global.__loadError || '');
  global.fetch = savedFetch;

  await stopApp(); // leave nothing running: the launcher stops the receiver + stubs
  console.log('FAILURES: ' + failures.length);
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  try { await stopApp(); } catch (_) { /* already gone */ }
  console.error('SHIM ERROR:', e);
  process.exit(1);
});
