// Standby 0.8.2 DOM checks — block-height, set-date, and fee-market triggers.
// Runs public/app.js from branch-0.8.8-nonrpc in Node with the
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
//     trigger set: label + status pill (+ fee pill on a standalone
//     tx row only) on one line — the label truncates with an
//     ellipsis so the status never wraps — with the tx card's
//     condition summary on the line underneath
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
//   - the grace period (0.8.0, extended 0.8.8, unified 0.8.8): a
//     "Grace period active" card at the top of the Dashboard
//     whenever a grace is active — even with nothing held — with
//     the approved copy ("Grace period has been activated because
//     the device was offline for X days." / "N transaction(s)
//     is/are held by grace, M of them would fire now."), a countdown bar
//     ("Day N of M" / "N days left · until <date>", "less than a
//     day left" under a day, "until you resume" when indefinite),
//     a Resume now button with its note to the right; armed held
//     cards read "Grace" on an amber pill instead of "armed"
//     (check-in cards included; manual untouched, disarmed still
//     "unarmed"); the Settings grace card has the toggle + the two
//     dropdowns (offline days to trigger, how long it lasts, incl.
//     indefinite) with Save
//   - the Getting Started card (0.8.0): an empty-state card at the
//     very top of the Dashboard, shown only when no transactions
//     are STAGED (active) — archived and pending do not count —
//     the first thing a fresh install sees — with the owner's exact
//     copy and a full-width orange button that opens the Add
//     transaction popup (it never switches tabs or scrolls); it is
//     independent of the grace card (which shows whenever a grace
//     is active, even with nothing held)
//   - the Add form is a popup (0.8.0): the inline "Add a
//     transaction" card at the bottom of the Transactions tab is
//     gone — three buttons open the same popup (Getting Started,
//     the "+ Add a pre-signed transaction" button at the bottom of
//     the Transactions tab, and the oval "+ Add Tx" in the Staged
//     Transactions header); "Broadcast all" is gone again —
//     restored Nov 16 at the owner's word, then removed again the same
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
// The app instance under test is the one on :3478 (launcher data:
// 4 armed txs, one per trigger type, seeded via the API, one
// check-in, then one POST /api/release/check so the subcards show
// live statuses). setInterval is stubbed (captured, not scheduled)
// so the process can exit.
'use strict';
const fs = require('fs');
const BASE = 'http://127.0.0.1:3478';
const DATA_FILE = '/tmp/standby-test099-dom/state.json';
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
  // (0.8.7 fix, round 3) A standalone tx's Details lives inside
  // its blue tx subcard now, not at card level and NOT inside a
  // trigger subcard — so this card-level lookup returns null
  // for it; use txItemDetails below. A set card has no
  // card-level Details either (each member's lives in its own
  // subcard), so this still returns null for sets.
  for (const c of card.children) {
    if (c.className === 'tx-trigger') {
      for (const b of c.children) { if (b.className === 'tx-details') return b; }
    }
  }
  return null;
}
// (0.8.7 fix, round 3) Every card is a trigger set: the Details
// of a standalone transaction lives inside its blue .tx-item
// subcard (the same subcard a set member gets), above the
// trigger subcards — never inside a trigger subcard.
function txItemDetails(card) {
  for (const c of card.children) {
    if ((c.className || '').split(' ').includes('tx-item')) {
      for (const b of c.children) { if (b.className === 'tx-details') return b; }
    }
  }
  return null;
}
// (0.8.7 fix, round 3) Details NEVER lives inside a trigger
// subcard any more — it lives in the blue tx subcard. This
// helper now reads null on every card, and the checks below
// assert exactly that.
function detailsInTriggerBox(card) {
  const boxes = triggerBoxes(card);
  if (!boxes.length) return null;
  const box = boxes[boxes.length - 1];
  return box.children.find((c) => c.className === 'tx-details') || null;
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
// rather than below the buttons on the card. (0.8.7 fix, round 3)
// The Details lives in the blue tx subcard, so read it there.
function detailsContains(card, cls) {
  const d = txItemDetails(card);
  return !!d && d.children.some((x) => (x.className || '').split(' ').includes(cls));
}
// The index of a direct child of the card with the given class, or
// -1 — so a check can prove one line sits below another on the card.
function cardChildIndex(card, cls) {
  return card.children.findIndex((x) => (x.className || '').split(' ').includes(cls));
}
// (0.8.7 fix, round 3) The index of a direct child with EXACTLY
// the given class — cardChildIndex's includes() match cannot tell
// a plain trigger box ('tx-trigger') from the tx subcard
// ('tx-trigger tx-item'), so a check that needs the first plain
// trigger box uses this.
function cardChildExactIndex(card, cls) {
  return card.children.findIndex((x) => x.className === cls);
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
// The readiness blocks (0.8.0): one .readiness-tx per ACTIVE
// trigger set (0.8.7, round 10) — a .readiness-tx-row (label <b>
// + trigger-mode pill + status pill + optional fee pill on a
// standalone tx row only) and a .readiness-tx-state line
// underneath.
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
// The member lines under a set's readiness header (0.8.7,
// round 12): children[2+] of the block, each a
// .readiness-tx-member with the "Tx N — <short txid>…" label
// span + the amount span pinned right — no pill at all, so
// exactly 2 children and neither is a .pill.
function readinessMembers(label) {
  const txs = els['readiness-txs'];
  if (!txs) return null;
  const block = txs.children.find((b) => (b.className || '').split(' ').includes('readiness-tx')
    && ((b.children[0] || {}).children[0] || {}).textContent === label);
  if (!block) return null;
  return block.children.slice(2)
    .filter((c) => (c.className || '').split(' ').includes('readiness-tx-member'))
    .map((c) => ({
      left: (c.children[0] || {}).textContent || '',
      leftCls: (c.children[0] || {}).className || '',
      amt: (c.children[1] || {}).textContent || '',
      amtCls: (c.children[1] || {}).className || '',
      hasPill: (c.children || []).some((k) => (k.className || '').split(' ').includes('pill')),
      kids: (c.children || []).length,
    }));
}
// The shared-input warnings on a card (0.8.7, round 13): the
// .tx-warn lines inside each blue .tx-item subcard — one per
// shared input, in stored order. Returns the line elements
// themselves (so a tick test can prove the SAME element
// persists) plus their text.
function warnLines(card) {
  if (!card) return null;
  const out = [];
  for (const c of card.children) {
    if ((c.className || '').split(' ').includes('tx-item')) {
      for (const k of c.children) {
        if ((k.className || '').split(' ').includes('tx-warn')) out.push({ el: k, text: k.textContent || '' });
      }
    }
  }
  return out;
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
      return { label, width: parseFloat((fill.style || {}).width) || 0, fillBg: (fill.style || {}).background || '', caption: cap, cls: b.className || '' };
    });
}
function checkinBar(label) {
  const bars = checkinBars();
  return bars && bars.find((x) => x.label === label);
}
// How many tx cards read "Grace" on their pill right now — the
// per-card view of the held set, against which the grace card's
// held-count line must agree (both derive from the same hold,
// through different code paths: txStatus vs graceHeldTxCount).
function gracePillCount() {
  return txCards().filter((c) => { const p = cardStatus(c); return !!p && p.textContent === 'Grace'; }).length;
}
// A fingerprint of the whole shim DOM (ids + each element's text,
// class, display, value, checked state and child count, recursed
// into children — the shim stores textContent per-element, so the
// recursion is what sees the rendered rows). Two equal fingerprints
// 50 ms apart mean the render has settled.
function renderFingerprint() {
  const out = [];
  const walk = (el) => {
    out.push(el.tagName, '|', el.textContent || '', '|', el.className || '', '|',
      (el.style && el.style.display) || '', '|', el.value || '', '|', el.checked ? '1' : '0',
      '|', (el.children || []).length, ';');
    (el.children || []).forEach(walk);
  };
  Object.keys(els).sort().forEach((k) => { out.push('#', k, ':'); walk(els[k]); });
  return out.join('');
}
// O7: replace the fixed 900 ms post-action wait. Return once no
// fetch is in flight and the shim DOM has been stable for one
// 50 ms sample — the same rendered state, waited-for instead of
// slept-through. The 900 ms deadline is today's value as fallback:
// on a slow render the wait costs exactly what it used to. (A click
// handler starts its fetch synchronously, so the count is already
// up by the time this runs; a DOM-only action renders synchronously
// and returns after one stability sample.)
async function waitForRender(deadlineMs = 900) {
  const end = Date.now() + deadlineMs;
  let prev = null;
  while (Date.now() < end) {
    const fp = __inFlightFetches === 0 ? renderFingerprint() : null;
    if (fp !== null && fp === prev) return;
    if (fp !== null) prev = fp;
    await new Promise((r) => setTimeout(r, 50));
  }
}
// A fresh page load: wipe the shim DOM and eval app.js again,
// exactly like the 094 seedClock helper (minus the state.json edit).
async function rerender(appJs) {
  for (const k of Object.keys(els)) delete els[k];
  global.__loadError = undefined;
  eval(appJs);
  await waitForRender();
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
// as helpers.craft) — so the DOM test can add transactions via
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
  // non-maxed sequence (0), so the locktime applies. A block-height
  // locktime above the
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
  // (0.8.7 fix, round 6) The pill is found by class, not by
  // position: since round 5 the tx-item head also carries the
  // right-aligned BTC amount (.tx-item-amt), so children[1]
  // is the amount — not a pill — when the subcard has none.
  const pillEl = (head.children || []).find((c) => (c.className || '').split(' ').includes('pill'));
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
  querySelectorAll(sel) {
    // The one element-level selector the app uses:
    // setTxIdsFromForm reads the checked checkboxes inside the
    // set modal's checklist. Walk descendants and match inputs
    // by type, honouring :checked. Anything else stays empty,
    // as before.
    const out = [];
    const wantChecked = sel.indexOf(':checked') !== -1;
    const walk = (el) => {
      (el.children || []).forEach((c) => {
        if (c.tagName === 'INPUT' && c.type === 'checkbox' && (!wantChecked || c.checked)) out.push(c);
        walk(c);
      });
    };
    if (sel.indexOf('input[type="checkbox"]') !== -1) walk(this);
    return out;
  }
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
// In-flight fetch count (O7): load() and the click handlers fetch
// then render; waitForRender below waits for the count to hit 0
// and the shim DOM to settle, instead of a fixed 900 ms. The
// counter decrements when the response arrives (headers) — the
// render that follows is a microtask later, covered by the
// stability samples in waitForRender.
let __inFlightFetches = 0;
global.fetch = (path, opts) => {
  __inFlightFetches++;
  let p;
  try {
    p = realFetch(BASE + path, opts);
  } catch (e) {
    __inFlightFetches--;
    throw e;
  }
  const done = () => { __inFlightFetches--; };
  p.then(done, done);
  return p;
};
// The intervals: capture the callbacks with their delays, do not
// schedule them (a live interval would keep this process alive
// after the checks). __pollFn keeps its old meaning (the last
// registered callback); __intervals lists them all, so a check can
// fire the 1-second live-view timer (0.8.5) by hand.
global.setInterval = (fn, ms) => { (global.__intervals = global.__intervals || []).push({ fn: fn, ms: ms }); global.__pollFn = fn; return global.__intervals.length - 1; };
global.clearInterval = () => {};

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL'), '-', name, cond ? '' : '| ' + String(detail).slice(0, 200));
  if (!cond) failures.push(name);
}

(async () => {
  const appJs = await realFetch(BASE + '/app.js').then((r) => r.text());
  const idx = await realFetch(BASE + '/').then((r) => r.text());
  const css = await realFetch(BASE + '/style.css').then((r) => r.text());
  eval(appJs);
  await waitForRender(); // load() fetches state + renders
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
      !!parts && parts.box && parts.box.children.filter((c) => c.className !== 'tx-details').length === 3,
      parts ? 'children=' + parts.box.children.length : 'no subcard');
    check('details in tx subcard: "' + label + '" Details lives inside its blue tx subcard, never inside a trigger subcard (0.8.7 fix, round 3)',
      !!card && !!txItemDetails(card) && !detailsInTriggerBox(card), '');
    check('trigger 0.8.0: "' + label + '" has the type label "' + exp.k + '"', !!parts && parts.k === exp.k, parts ? parts.k : 'no subcard');
    check('trigger 0.8.0: "' + label + '" condition reads "' + exp.cond + '"', !!parts && parts.cond === exp.cond, parts ? parts.cond : 'no subcard');
    check('trigger 0.8.0: "' + label + '" state line reads "' + exp.now + '"', !!parts && parts.now.indexOf(exp.now) !== -1, parts ? parts.now : 'no subcard');
  }
  check('trigger 0.8.0: the card is a trigger set — amount, then the sub-line, then the blue tx subcard with Details inside it, then the trigger subcard(s)',
    cards0.length === 7 && cards0.every((c) => cardChildIndex(c, 'tx-amount') === 1 && cardChildIndex(c, 'tx-item') === 3 && cardChildExactIndex(c, 'tx-trigger') === 4 && !!txItemDetails(c) && !detailsInTriggerBox(c) && cardChildIndex(c, 'tx-details') === -1),
    cards0.map((c) => cardChildIndex(c, 'tx-amount') + '/' + cardChildIndex(c, 'tx-item') + '/' + cardChildExactIndex(c, 'tx-trigger') + '/' + cardChildIndex(c, 'tx-details')).join(' '));

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
    const det = card && txItemDetails(card);
    check('details 0.8.0: "' + label + '" Details exists and starts collapsed', !!det && det.open === false, det ? 'open=' + det.open : 'no Details');
    if (det) toggleDetails(det, true);
    check('details 0.8.0: "' + label + '" Details holds the Fee row and the Broadcast via row once opened',
      !!card && detailsContains(card, 'tx-fee') && detailsContains(card, 'tx-route'),
      card ? (txItemDetails(card) ? txItemDetails(card).children.map((x) => x.className).join(',') : 'no tx-item Details') : 'no card');
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
  check('add rule list 0.8.2 v2: the combine cards carry the owner\'s exact descriptions',
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
  const fmFlip = fmId ? await fetch('/api/bitcoin/txs/' + fmId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: { type: 'feemarket', params: { maxFeeRate: 2, direction: 'above' } }, triggerConfirmed: true }) }) : null;
  check('feemarket direction: flipping the rule to above via the API succeeds', !!fmFlip && fmFlip.status === 200, fmFlip ? 'status=' + fmFlip.status : 'no id');
  await rerender(appJs);
  const fmCard = cardByTitle('Dom Feemarket');
  const fmParts = fmCard && triggerParts(fmCard);
  check('feemarket direction: the subcard condition now reads "tx fees are >= 2 sat/vB"',
    !!fmParts && fmParts.cond === 'Fires when tx fees are >= 2 sat/vB', fmParts ? fmParts.cond : 'no subcard');
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
  // (0.8.6) The override goes in BEFORE the 6-conf add below: the
  // outpoint cache serves a fetched answer for one cadence window,
  // so if the 6-conf add's gate evaluation read the stub's default
  // FINNEY:0 answer (11 confirmations) first, the 3-conf add's
  // gate below would read the same cached answer and refuse the
  // add as already firing. With the override set first, every
  // FINNEY:0 read in this section sees 2 confirmations.
  const ovr = await realFetch('http://127.0.0.1:18275/__test__/outspend', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txid: FINNEY, vout: 0, blockHeight: 899999 }) });
  check('utxo modes: the outspend override sets FINNEY:0 to 2 confirmations', ovr.status === 200, 'status=' + ovr.status);
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
  // card. FINNEY:0 is already driven to 2 confirmations by the
  // stub override above, so add an N=3 rule (below threshold, so
  // no triggerConfirmed needed), run a release check so the
  // triggerState picks up the "2 of 3" reason, and read the card's
  // state line.
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
  const ovrClear = await realFetch('http://127.0.0.1:18275/__test__/outspend', { method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    appJs.indexOf('price decides') !== -1, '');
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
  await waitForRender();
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
  await waitForRender();
  const stRestored = await (await fetch('/api/state')).json();
  check('price sources: the defaults are restored (CoinGecko + Coinbase)',
    stRestored.settings && stRestored.settings.priceSources && stRestored.settings.priceSources.source1 === 'coingecko' && stRestored.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stRestored.settings && stRestored.settings.priceSources));
  // After restoring, the rows re-derive from the cache again —
  // both sources have a cached price, so both read OK. But a
  // background tick landing in the short Kraken + Bitstamp
  // window above re-keys the cache to those sources, and then
  // the restore reads Not Tested until something re-fetches for
  // the restored sources. Clear just the price cache (the fee
  // peak survives) and run a release check so the rows read the
  // live CoinGecko + Coinbase prices, deterministically.
  const ccRestore = await fetch('/api/__test__/clear-caches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: ['price'] }) });
  check('price sources: the price cache is cleared so the rows re-fetch for the restored sources', ccRestore.status === 200, 'status=' + ccRestore.status);
  const relRestore = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('price sources: a release check runs after the restore so the rows read live prices', relRestore.status === 200, 'status=' + relRestore.status);
  await rerender(appJs);
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  customUrl.value = 'http://127.0.0.1:18275/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
  customPath.value = 'bitcoin.usd';
  els['btn-test-price-sources'].click();
  await waitForRender();
  check('custom price source: Test shows the custom price to the right of the pill (Custom [OK] $98,200)',
    els['price-source1'] && els['price-source1'].textContent.indexOf('Custom') !== -1 && els['price-source1'].textContent.indexOf('$') === -1
    && els['price-source1-price'] && els['price-source1-price'].textContent === '$98,200',
    (els['price-source1'] && els['price-source1'].textContent) + ' / ' + (els['price-source1-price'] && els['price-source1-price'].textContent));
  check('custom price source: the tested Custom row pill reads OK',
    els['price-source1-status'] && els['price-source1-status'].textContent === 'OK' && els['price-source1-status'].className === 'pill ok',
    els['price-source1-status'] && els['price-source1-status'].textContent);
  els['btn-save-price-sources'].click();
  await waitForRender();
  const stCustom = await (await fetch('/api/state')).json();
  check('custom price source: saving stores the custom object in /api/state',
    stCustom.settings && stCustom.settings.priceSources
    && JSON.stringify(stCustom.settings.priceSources.source1) === JSON.stringify({ id: 'custom', url: 'http://127.0.0.1:18275/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', path: 'bitcoin.usd' })
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
  await waitForRender();
  const stCustomRestored = await (await fetch('/api/state')).json();
  check('custom price source: the defaults are restored after the custom save test',
    stCustomRestored.settings && stCustomRestored.settings.priceSources && stCustomRestored.settings.priceSources.source1 === 'coingecko' && stCustomRestored.settings.priceSources.source2 === 'coinbase',
    JSON.stringify(stCustomRestored.settings && stCustomRestored.settings.priceSources));
  check('custom price source: the custom inputs hide again once a built-in is selected',
    els['price-source1-custom'] && els['price-source1-custom'].style.display === 'none',
    els['price-source1-custom'] && els['price-source1-custom'].style.display);
  // A failing provider shows the failure inline, with the
  // error — while the other source still shows its price.
  const failCg = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: true }) });
  check('test button: the stub CoinGecko feed is set to fail', failCg.status === 200, 'status=' + failCg.status);
  els['btn-test-price-sources'].click();
  await waitForRender();
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
  const unFailCg = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  // (Optimization O6) The price-sources section above switched
  // the sources to Kraken + Bitstamp and back, so the price cache
  // is still keyed to those — the rows would read "Not tested"
  // until a refresh re-warms it for the restored sources. Clear
  // just the price cache (the fee peak survives) and run a release
  // check so the rows read the live CoinGecko + Coinbase prices.
  const ccWarm = await fetch('/api/__test__/clear-caches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: ['price'] }) });
  check('exchange status: the price cache is cleared so the rows re-fetch for the restored sources', ccWarm.status === 200, 'status=' + ccWarm.status);
  const relWarm = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the cache clear so the rows read live prices', relWarm.status === 200, 'status=' + relWarm.status);
  await rerender(appJs);
  check('exchange status: the section has a row for CoinGecko (row 1), price to the left of the pill (CoinGecko checked … - $98,200 [OK])',
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent.indexOf('CoinGecko') !== -1
    && els['readiness-exchange-1'].textContent.indexOf('$') === -1
    && els['readiness-exchange-1-price'] && /^checked .+ - \$98,200$/.test(els['readiness-exchange-1-price'].textContent),
    (els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent) + ' / ' + (els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent));
  check('exchange status: the CoinGecko row pill reads OK',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent === 'OK',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent);
  check('exchange status: the CoinGecko row pill uses the ok class',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className === 'pill ok',
    els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].className);
  check('exchange status: the section has a row for Coinbase (row 2), price to the left of the pill (Coinbase checked … - $98,200 [OK])',
    els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent.indexOf('Coinbase') !== -1
    && els['readiness-exchange-2'].textContent.indexOf('$') === -1
    && els['readiness-exchange-2-price'] && /^checked .+ - \$98,200$/.test(els['readiness-exchange-2-price'].textContent),
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
    !!partsPrice && partsPrice.box && partsPrice.box.children.filter((c) => c.className !== 'tx-details').length === 3,
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
    // (0.8.7 fix, round 3) The dry-run line lives inside the
    // blue tx subcard now, under its Details — not at card
    // level. Look there as well as at card level.
    const dryKids = [];
    for (const c of priceCard3.children) {
      dryKids.push(c);
      if ((c.className || '').split(' ').includes('tx-item')) {
        for (const b of c.children) dryKids.push(b);
      }
    }
    for (const c of dryKids) {
      if (c.className && c.className.split(' ').includes('tx-dryrun')) dryLine = c.textContent || '';
    }
  }
  check('dry-run source detail: a dry run of the price tx shows the source detail in its notes',
    dryLine.indexOf('Price sources: CoinGecko $98,200 · Coinbase $98,200') !== -1, dryLine || 'no dry-run line');
  // Degraded: one source down. The price cache is fresh for 1
  // min, so clear it (test-only endpoint) instead of waiting past
  // it, then a release check + re-render shows the degraded pill.
  const failCg2 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: true }) });
  check('exchange status: the stub CoinGecko feed is set to fail (degraded)', failCg2.status === 200, 'status=' + failCg2.status);
  const ccDeg = await fetch('/api/__test__/clear-caches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: ['price'] }) });
  check('exchange status: the price cache is cleared so the release check re-fetches (degraded)', ccDeg.status === 200, 'status=' + ccDeg.status);
  const relDeg = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the caches are cleared (degraded)', relDeg.status === 200, 'status=' + relDeg.status);
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
  check('exchange status: the CoinGecko row drops its price when it is down (no price, checked time only)',
    els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent.indexOf('$') === -1
    && /^checked /.test(els['readiness-exchange-1-price'].textContent),
    els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent);
  check('exchange status: the CoinGecko row still names the exchange when it is down',
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent.indexOf('CoinGecko') !== -1,
    els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent);
  check('exchange status: the Coinbase row stays OK with its price in single-source mode',
    els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent === 'OK'
    && els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent.indexOf('Coinbase') !== -1
    && els['readiness-exchange-2-price'] && /^checked .+ - \$98,200$/.test(els['readiness-exchange-2-price'].textContent),
    (els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent) + ' / ' + (els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent));
  const rbDeg = readinessBlock('Dom Price');
  check('exchange status: the Dom Price readiness line stays trigger-only in single-source mode',
    !!rbDeg && rbDeg.state.indexOf('CoinGecko') === -1 && rbDeg.state.indexOf('Coinbase') === -1,
    rbDeg ? rbDeg.state : 'no block');
  const unFailCg2 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', fail: false }) });
  check('exchange status: the stub CoinGecko feed is restored (degraded)', unFailCg2.status === 200, 'status=' + unFailCg2.status);
  // Error: the sources disagree by more than 5%. Same clear for
  // the cache, then a release check + re-render.
  const setDis1 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', usd: 100000 }) });
  check('exchange status: the stub CoinGecko is set to $100,000 (disagree)', setDis1.status === 200, 'status=' + setDis1.status);
  const setDis2 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coinbase', usd: 106000 }) });
  check('exchange status: the stub Coinbase is set to $106,000 (6% apart)', setDis2.status === 200, 'status=' + setDis2.status);
  const ccDis = await fetch('/api/__test__/clear-caches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: ['price'] }) });
  check('exchange status: the price cache is cleared so the release check re-fetches (disagree)', ccDis.status === 200, 'status=' + ccDis.status);
  const relDis = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the caches are cleared (disagree)', relDis.status === 200, 'status=' + relDis.status);
  await rerender(appJs);
  // Disagree: each source is up, so each row pill stays OK and
  // shows its own price; there is still no overall pill.
  check('exchange status: the CoinGecko row still shows $100,000 and OK when the sources disagree',
    els['readiness-exchange-1-price'] && /^checked .+ - \$100,000$/.test(els['readiness-exchange-1-price'].textContent)
    && els['readiness-exchange-1-status'] && els['readiness-exchange-1-status'].textContent === 'OK',
    (els['readiness-exchange-1'] && els['readiness-exchange-1'].textContent) + ' / ' + (els['readiness-exchange-1-price'] && els['readiness-exchange-1-price'].textContent));
  check('exchange status: the Coinbase row still shows $106,000 and OK when the sources disagree',
    els['readiness-exchange-2-price'] && /^checked .+ - \$106,000$/.test(els['readiness-exchange-2-price'].textContent)
    && els['readiness-exchange-2-status'] && els['readiness-exchange-2-status'].textContent === 'OK',
    (els['readiness-exchange-2'] && els['readiness-exchange-2'].textContent) + ' / ' + (els['readiness-exchange-2-price'] && els['readiness-exchange-2-price'].textContent));
  const rbDis = readinessBlock('Dom Price');
  check('exchange status: the Dom Price readiness line stays its condition when the sources disagree (no feed state on the line)',
    !!rbDis && rbDis.state === 'Fires when BTC price \u2265 $150,000', rbDis ? rbDis.state : 'no block');
  // Restore the stub so the suite ends on the default.
  const setBack1 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coingecko', usd: 98200 }) });
  check('exchange status: the stub CoinGecko is restored to $98,200', setBack1.status === 200, 'status=' + setBack1.status);
  const setBack2 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coinbase', usd: 98200 }) });
  check('exchange status: the stub Coinbase is restored to $98,200', setBack2.status === 200, 'status=' + setBack2.status);
  // Heal the price state the disagree test poisoned: the served
  // price is derived live from the price cache (ruleStatusFor),
  // so the disagreeing readings would keep every price line
  // 'unknown' until something re-fetches. Clear just the price
  // cache and run a release check — the Dom Price slice heals to
  // $98,200 here, before §14's held-clock edit triggers the
  // grace (during a grace the release check cannot
  // re-fetch prices, so this is the last chance to heal it).
  const ccOk = await fetch('/api/__test__/clear-caches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: ['price'] }) });
  check('exchange status: the price cache is cleared so the release check re-fetches the restored prices', ccOk.status === 200, 'status=' + ccOk.status);
  const relOk = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('exchange status: a release check runs after the restore so the price state reads $98,200 again', relOk.status === 200, 'status=' + relOk.status);
  await rerender(appJs);

  // --- 10b. node capability details, variant C: summary row + details on tap (0.8.1) ---
  // Static HTML: each node is a <details> — the summary is just
  // the node name + status pill, and the detail holds the four
  // checks as plain label — value lines (no pills).
  for (const lbl of ['primary', 'secondary']) {
    check('node checks static: the ' + lbl + ' node is a <details> with a capability block (static HTML)',
      idx.indexOf('<details id="btc-' + lbl + '-details" class="node-details">') !== -1
      && idx.indexOf('id="btc-' + lbl + '-checks"') !== -1, '');
    check('node checks static: the ' + lbl + ' detail has Broadcast / Fee estimates / Block height / Output lookup value spans (static HTML)',
      idx.indexOf('id="btc-' + lbl + '-broadcast-value"') !== -1
      && idx.indexOf('id="btc-' + lbl + '-fees-value"') !== -1
      && idx.indexOf('id="btc-' + lbl + '-height-value"') !== -1
      && idx.indexOf('id="btc-' + lbl + '-outputLookup-value"') !== -1, '');
    check('node checks static: the ' + lbl + ' detail has no per-check pills (static HTML)',
      idx.indexOf('id="btc-' + lbl + '-broadcast"') === -1
      && idx.indexOf('id="btc-' + lbl + '-fees"') === -1
      && idx.indexOf('id="btc-' + lbl + '-height"') === -1, '');
  }
  check('node checks static: the capability labels read Broadcast / Fee estimates / Block height / Output lookup (static HTML)',
    (idx.match(/>Broadcast</g) || []).length >= 2 && (idx.match(/>Fee estimates</g) || []).length >= 2 && (idx.match(/>Block height</g) || []).length >= 2 && (idx.match(/>Output lookup</g) || []).length >= 2, '');
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
    check('node checks: the ' + lbl + ' Output lookup value reads Batch',
      els['btc-' + lbl + '-outputLookup-value'] && els['btc-' + lbl + '-outputLookup-value'].textContent === 'Batch',
      els['btc-' + lbl + '-outputLookup-value'] && els['btc-' + lbl + '-outputLookup-value'].textContent);
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
  // (0.8.5) Test connection must not collapse manually opened
  // node details: the button used to force every OK node's
  // details closed after the test. Open the primary details,
  // click Test connection, and they stay open.
  toggleDetails(detP, true);
  check('node checks: the primary details open before the Test connection click', detP.open === true, 'open=' + detP.open);
  els['btn-btc-test-conn'].click();
  await new Promise((r) => setTimeout(r, 1500));
  check('node checks: the primary details stay open across a Test connection click (OK node)', detP.open === true, 'open=' + detP.open);
  check('node checks: the primary pill still reads OK after the Test connection click',
    els['btc-primary-status'] && els['btc-primary-status'].textContent === 'OK',
    els['btc-primary-status'] && els['btc-primary-status'].textContent);
  toggleDetails(detP, false);

  // --- 10d. Secondary-node toggle (0.8.8) ---
  // The toggle sits inline with the Secondary node heading,
  // right-aligned — the same switch as the arm/disarm toggle on
  // a transaction card — and never hides with the settings it
  // controls. Off hides the secondary URL box without clearing
  // its saved value, and the secondary pill reads Disabled —
  // never Offline, Failed, or a stale timestamp. The Dashboard
  // readiness row names the slot ("Secondary Node"), not the
  // provider host — but ONLY while the secondary is disabled,
  // when there is no real node to name. While enabled the
  // readiness row shows the node name (the configured host),
  // as before; Settings still shows the host. Save
  // round-trips it.
  check('secondary toggle static: the toggle exists in the HTML',
    idx.indexOf('id="btc-secondary-enabled"') !== -1, '');
  check('secondary toggle static: the toggle is the same switch as the arm/disarm toggle (class "switch green")',
    idx.indexOf('class="switch green" id="btc-secondary-enabled-wrap"') !== -1, '');
  check('secondary toggle static: the toggle sits inline with the Secondary node heading (label, then switch, in the heading row)',
    idx.indexOf('class="node-subhead"') !== -1
    && idx.indexOf('class="node-subhead"') < idx.indexOf('<label for="btc-secondary-url">Secondary node</label>')
    && idx.indexOf('<label for="btc-secondary-url">Secondary node</label>') < idx.indexOf('id="btc-secondary-enabled"'), '');
  check('secondary toggle static: the heading row spreads label and switch apart (space-between, so the switch sits right-aligned)',
    /\.node-subhead\s*\{[^}]*justify-content:\s*space-between/.test(css), '');
  check('secondary toggle static: the toggle sits before the secondary URL box',
    idx.indexOf('id="btc-secondary-enabled"') !== -1 && idx.indexOf('id="btc-secondary-enabled"') < idx.indexOf('id="btc-secondary-url"'), '');
  check('secondary toggle static: the toggle sits outside the secondary fields wrapper (it never hides with them)',
    idx.indexOf('id="btc-secondary-enabled"') !== -1 && idx.indexOf('id="btc-secondary-enabled"') < idx.indexOf('id="btc-secondary-fields"'), '');
  check('secondary toggle static: the secondary fields wrapper exists in the HTML',
    idx.indexOf('id="btc-secondary-fields"') !== -1, '');
  await rerender(appJs);
  check('secondary toggle: the toggle starts checked (secondary on by default)',
    els['btc-secondary-enabled'] && els['btc-secondary-enabled'].checked === true, '');
  check('secondary toggle: the secondary fields show while enabled',
    els['btc-secondary-fields'] && els['btc-secondary-fields'].style.display !== 'none', '');
  check('secondary toggle: the Dashboard readiness row shows the node name (host) while enabled',
    els['readiness-secondary'] && els['readiness-secondary'].textContent === '127.0.0.1:18276',
    els['readiness-secondary'] && els['readiness-secondary'].textContent);
  check('secondary toggle: the readiness row shows the same host as the Settings row while enabled',
    els['readiness-secondary'] && els['btc-secondary']
    && els['readiness-secondary'].textContent === els['btc-secondary'].textContent,
    els['readiness-secondary'] && els['readiness-secondary'].textContent);
  check('secondary toggle: the Settings row still shows the configured host',
    els['btc-secondary'] && els['btc-secondary'].textContent === '127.0.0.1:18276',
    els['btc-secondary'] && els['btc-secondary'].textContent);
  // Uncheck: the fields hide immediately (values untouched).
  els['btc-secondary-enabled'].checked = false;
  fireChange(els['btc-secondary-enabled']);
  check('secondary toggle: unchecking hides the secondary fields',
    els['btc-secondary-fields'] && els['btc-secondary-fields'].style.display === 'none', '');
  check('secondary toggle: the toggle itself stays visible while disabled (it lives in the heading row, not the fields)',
    els['btc-secondary-enabled-wrap'] && els['btc-secondary-enabled-wrap'].style.display !== 'none', '');
  check('secondary toggle: the switch title names the off state while disabled',
    els['btc-secondary-enabled-wrap'] && els['btc-secondary-enabled-wrap'].title === 'Secondary node off — primary only',
    els['btc-secondary-enabled-wrap'] && els['btc-secondary-enabled-wrap'].title);
  check('secondary toggle: hiding keeps the saved URL in the box',
    els['btc-secondary-url'] && els['btc-secondary-url'].value === 'http://127.0.0.1:18276',
    els['btc-secondary-url'] && els['btc-secondary-url'].value);
  els['btn-btc-save-nodes'].click();
  await new Promise((r) => setTimeout(r, 1500));
  await waitForRender();
  const stSecOff = await (await fetch('/api/state')).json();
  check('secondary toggle: the toggle saves off (state secondaryEnabled false)',
    stSecOff.settings.secondaryEnabled === false, JSON.stringify(stSecOff.settings));
  check('secondary toggle: the secondary setting survives the disable (URL kept)',
    stSecOff.settings.secondaryApiUrl === 'http://127.0.0.1:18276', JSON.stringify(stSecOff.settings));
  check('secondary toggle: the Settings secondary pill reads Disabled',
    els['btc-secondary-status'] && els['btc-secondary-status'].textContent === 'Disabled',
    els['btc-secondary-status'] && els['btc-secondary-status'].textContent);
  check('secondary toggle: the Dashboard readiness secondary pill reads Disabled',
    els['readiness-secondary-status'] && els['readiness-secondary-status'].textContent === 'Disabled',
    els['readiness-secondary-status'] && els['readiness-secondary-status'].textContent);
  check('secondary toggle: the disabled readiness row falls back to "Secondary Node" (no real name)',
    els['readiness-secondary'] && els['readiness-secondary'].textContent === 'Secondary Node',
    els['readiness-secondary'] && els['readiness-secondary'].textContent);
  check('secondary toggle: the disabled readiness row shows no provider hostname',
    els['readiness-secondary'] && els['readiness-secondary'].textContent.indexOf('127.0.0.1') === -1,
    els['readiness-secondary'] && els['readiness-secondary'].textContent);
  // Re-enable: the fields return with their saved values intact.
  els['btc-secondary-enabled'].checked = true;
  fireChange(els['btc-secondary-enabled']);
  check('secondary toggle: re-checking shows the secondary fields again',
    els['btc-secondary-fields'] && els['btc-secondary-fields'].style.display !== 'none',
    els['btc-secondary-fields'] && els['btc-secondary-fields'].style.display);
  check('secondary toggle: the switch title names the on state again after re-enabling',
    els['btc-secondary-enabled-wrap'] && els['btc-secondary-enabled-wrap'].title === 'Secondary node on — used if the primary fails',
    els['btc-secondary-enabled-wrap'] && els['btc-secondary-enabled-wrap'].title);
  check('secondary toggle: the URL box still holds the saved secondary URL after re-enabling',
    els['btc-secondary-url'] && els['btc-secondary-url'].value === 'http://127.0.0.1:18276',
    els['btc-secondary-url'] && els['btc-secondary-url'].value);
  els['btn-btc-save-nodes'].click();
  await new Promise((r) => setTimeout(r, 1500));
  await waitForRender();
  const stSecOn = await (await fetch('/api/state')).json();
  check('secondary toggle: the toggle saves back on',
    stSecOn.settings.secondaryEnabled === true, JSON.stringify(stSecOn.settings));
  // Re-test so the pills read OK again for the later sections.
  els['btn-btc-test-conn'].click();
  await new Promise((r) => setTimeout(r, 1500));
  await waitForRender();
  check('secondary toggle: both pills read OK again after re-enabling + re-test',
    els['btc-primary-status'] && els['btc-primary-status'].textContent === 'OK'
    && els['btc-secondary-status'] && els['btc-secondary-status'].textContent === 'OK', '');
  check('secondary toggle: the readiness row shows the host name again after re-enabling',
    els['readiness-secondary'] && els['readiness-secondary'].textContent === '127.0.0.1:18276',
    els['readiness-secondary'] && els['readiness-secondary'].textContent);

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
  check('add popup static: "+ New trigger set" button is gone (removed Nov 21 — "+ Add Tx" is the way to create a set)',
    idx.indexOf('btn-btc-new-set') === -1 && idx.indexOf('New trigger set') === -1, '');
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

  // --- 14. held window + shared check-in reset (0.8.0, unified 0.8.8) ---
  // Backdate the clock 40 days with lastOnlineAt 40 days back
  // (a direct state.json edit, like the API suite's seed): a
  // grace sets on the rerender's read (gap 40d > 7d
  // threshold), and both bars read past due in their OWN
  // windows — 40 of 35 / 40 of 10 — state 'grace', never
  // 'release-due': the due date is NOT pushed out by the
  // grace. The status pill reads "Grace period" and the grace
  // card shows with its countdown bar. The shared Check in
  // button then resets both bars to 0 (checking in does NOT
  // clear the grace — the card stays up).
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(heldSt, null, 2) + '\n');
  // (0.8.10, skip-save) Drop the heartbeat cache too: a
  // test-written state.json defines the world, and the fresh
  // heartbeat left over from the running app would silently
  // override the seeded 40-day gap on the rerender's read.
  // (Same fix as the API and regression suites' seeders.)
  try { fs.unlinkSync(DATA_FILE.replace('state.json', 'heartbeat.json')); } catch (e) { /* no heartbeat yet */ }
  await rerender(appJs);
  const heldBar35 = checkinBar('Dom Check-in');
  const heldBar10 = checkinBar('Dom Check-in 10d');
  check('held bars: the 35d bar reads "40 of 35 days elapsed — held by grace" (its own window, not pushed out)',
    !!heldBar35 && heldBar35.caption === '40 of 35 days elapsed — held by grace', heldBar35 ? heldBar35.caption : 'no bar');
  check('held bars: the 10d bar reads "40 of 10 days elapsed — held by grace" too',
    !!heldBar10 && heldBar10.caption === '40 of 10 days elapsed — held by grace', heldBar10 ? heldBar10.caption : 'no bar');
  check('held bars: both bars are full (40 of 35 / 40 of 10) with an amber fill',
    !!heldBar35 && heldBar35.width === 100 && heldBar35.fillBg === 'var(--warn)'
    && !!heldBar10 && heldBar10.width === 100 && heldBar10.fillBg === 'var(--warn)',
    (heldBar35 ? heldBar35.width + '/' + heldBar35.fillBg : '—') + ' / ' + (heldBar10 ? heldBar10.width + '/' + heldBar10.fillBg : '—'));
  check('held bars: the status pill reads "Grace period"',
    els['status-pill'] && els['status-pill'].textContent === 'Grace period',
    els['status-pill'] && els['status-pill'].textContent);
  // The held count is 9, not 7: the 7 trigger txs plus the two
  // FINNEY:0 txs from §8. (The third extra UTXO tx, the
  // unconfirmed-mode conflict tx, is NOT held: its rule fired
  // on the unconfirmed spend and it broadcast already, so it
  // is pending by now — the §14 comment used to say the
  // opposite, corrected by the §14 state dump in the
  // both-numbers build.) The line must agree with the
  // per-card pills, the independent view of the same held set.
  const heldN14 = gracePillCount();
  check('held bars: the grace card shows the 40-day gap and the held txs',
    els['grace-card'] && els['grace-card'].style.display !== 'none'
    && els['grace-text'] && elText(els['grace-text']) === 'Grace period has been activated because the device was offline for 40 days.'
    && els['grace-held'] && elText(els['grace-held']) === '9 transactions are held by grace, 2 of them would fire now.',
    elText(els['grace-text']) + ' / ' + elText(els['grace-held']));
  check('held bars: the held count is 9 (7 trigger txs + the 2 FINNEY:0 txs from §8)',
    heldN14 === 9, 'grace pills: ' + heldN14);
  // Both-numbers grace card (0.8.8): 2 of the 9 held would fire
  // now — the two past-due check-ins, judged on the live clock
  // (40 days past both the 35d and the 10d thresholds). The
  // rest read 'watching' on their stored slices (price $98,200
  // < $150,000, tip 900,000 < 950,000, fee 1 > 0.5, set-date in
  // 2029, FINNEY:1 unspent, both FINNEY:0 txs last read at 2
  // confirmations, below their N). The conflict tx reads
  // wouldFire TRUE on its stale 'due' slice but it already
  // broadcast, so it is not held and does not count toward
  // the second number.
  const st14 = await (await fetch('/api/state')).json();
  const heldLabels14 = txCards().filter((c) => { const p = cardStatus(c); return !!p && p.textContent === 'Grace'; }).map(cardTitle);
  const wf14 = (st14.bitcoin.txs || []).filter((t) => heldLabels14.includes(t.label) && (t.triggerStatus || {}).wouldFire).map((t) => t.label);
  check('held bars: 2 of the 9 held would fire now (the two past-due check-ins)',
    wf14.length === 2 && wf14.includes('Dom Check-in') && wf14.includes('Dom Check-in 10d'), wf14.join(', '));
  check('held bars: the grace countdown starts at "Day 0 of 7" with "7 days left"',
    els['grace-bar-day'] && els['grace-bar-day'].textContent === 'Day 0 of 7'
    && els['grace-bar-left'] && (els['grace-bar-left'].textContent || '').indexOf('7 days left · until ') === 0
    && els['grace-bar-fill'] && els['grace-bar-fill'].style.width === '0%',
    (els['grace-bar-day'] && els['grace-bar-day'].textContent) + ' / ' + (els['grace-bar-left'] && els['grace-bar-left'].textContent) + ' / ' + (els['grace-bar-fill'] && els['grace-bar-fill'].style.width));
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
  check('check-in resets: the status pill reads "On track" again (clock fresh, nothing past due)',
    els['status-pill'] && els['status-pill'].textContent === 'On track',
    els['status-pill'] && els['status-pill'].textContent);
  check('check-in resets: the grace card is still visible — checking in does not clear the grace',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);

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

  // --- 18. grace period for ALL triggers (0.8.0, extended 0.8.8, unified 0.8.8) ---
  // When the app comes back after being offline longer than
  // settings.graceOfflineDays (default 7), price, UTXO,
  // block-height, set-date, fee-market, AND check-in triggers
  // are paused for settings.graceDurationDays (default 7, null
  // = indefinite until resumed). The grace has an on/off
  // toggle as the first option on the Settings grace card (in
  // the heading, like the secondary-node toggle): off hides
  // the two dropdowns without clearing them, and no grace is
  // ever set — nor does an already-active grace show or hold
  // — while it is off. The duration dropdown offers 1/3/7/14/30
  // days + indefinite only (no 0: the toggle is the off switch
  // now). The dashboard shows a "Grace period active" card at
  // the top whenever a grace is active — even with nothing
  // held — with the approved copy ("Grace period has been
  // activated because the device was offline for X days." /
  // "N transaction(s) is/are held by grace, M of them would
  // fire now."),
  // a countdown bar ("Day N of M" / "N days left · until
  // <date>", "less than a day left" under a day, "until you
  // resume" for an indefinite grace), and a Resume now button
  // with "Resuming will end the grace period immediately." to
  // its right; armed held tx cards read "Grace" on an amber
  // pill instead of "armed" (check-in cards included now);
  // the Settings grace card has the toggle + the two dropdowns
  // (offline days to trigger, how long it lasts) with Save.
  // (Direct state.json edits for the grace, like §14's
  // held-clock edit and §16b's fate edits. The launcher's
  // lastOnlineAt is fresh — the app booted minutes ago — so
  // seeding a grace directly never re-triggers one on the
  // read.)
  function setDomGrace(grace) {
    const st = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    st.grace = grace;
    fs.writeFileSync(DATA_FILE, JSON.stringify(st, null, 2) + '\n');
  }
  const graceNow = Date.now();
  // A grace 5 days in, of a 7-day duration (the approved
  // render): "Day 5 of 7", "2 days left · until <date>", bar
  // ~71% wide. triggeredAt 5 days ago, graceUntil 2 days out.
  const graceUntil = new Date(graceNow + 2 * 86400000).toISOString();
  const graceTriggeredAt = new Date(graceNow - 5 * 86400000).toISOString();
  // Static HTML: the dashboard grace card (before the check-in
  // card) and the Settings grace card (after the price sources
  // card), with the exact copy from the approved mockup.
  check('grace card static: the dashboard grace card exists (title, text, held count, countdown bar, Resume button, note)',
    idx.indexOf('id="grace-card"') !== -1 && idx.indexOf('Grace period active') !== -1
    && idx.indexOf('id="grace-text"') !== -1 && idx.indexOf('id="grace-held"') !== -1
    && idx.indexOf('id="grace-bar-day"') !== -1 && idx.indexOf('id="grace-bar-left"') !== -1
    && idx.indexOf('id="grace-bar-fill"') !== -1 && idx.indexOf('id="btn-resume-grace"') !== -1
    && idx.indexOf('Resuming will end the grace period immediately.') !== -1, '');
  check('grace card static: the grace card sits at the top of the dashboard (before the check-in card)',
    idx.indexOf('id="grace-card"') !== -1 && idx.indexOf('id="checkin-card"') !== -1
    && idx.indexOf('id="grace-card"') < idx.indexOf('id="checkin-card"'), '');
  check('grace card static: the Resume button reads "Resume now" and is orange (primary)',
    idx.indexOf('id="btn-resume-grace" class="primary"') !== -1, '');
  check('grace settings static: the Settings grace card exists (title, toggle, two dropdowns, Save; the explainer lives in the "?" pop-out)',
    idx.indexOf('Grace period</h2>') !== -1 && idx.indexOf('id="grace-enabled"') !== -1
    && idx.indexOf('id="set-grace-offline"') !== -1
    && idx.indexOf('id="set-grace-duration"') !== -1 && idx.indexOf('id="btn-save-grace"') !== -1
    && appJs.indexOf('A pause for ALL triggers') !== -1, '');
  check('grace settings static: the toggle is the first option on the grace card (in the heading, before the offline dropdown)',
    idx.indexOf('id="grace-enabled"') !== -1 && idx.indexOf('id="set-grace-offline"') !== -1
    && idx.indexOf('id="grace-enabled"') < idx.indexOf('id="set-grace-offline"'), '');
  check('grace settings static: the toggle is the same switch as the arm/disarm toggle (class "switch green")',
    idx.indexOf('class="switch green" id="grace-enabled-wrap"') !== -1, '');
  check('grace settings static: the toggle sits inline with the Grace period heading (heading, then switch, then the "?" button)',
    idx.indexOf('Grace period</h2>') !== -1 && idx.indexOf('id="grace-enabled"') !== -1 && idx.indexOf('id="help-grace"') !== -1
    && idx.indexOf('Grace period</h2>') < idx.indexOf('id="grace-enabled"')
    && idx.indexOf('id="grace-enabled"') < idx.indexOf('id="help-grace"'), '');
  check('grace settings static: the grace fields wrapper exists in the HTML',
    idx.indexOf('id="grace-fields"') !== -1, '');
  check('grace settings static: the grace card sits after the Bitcoin price source card',
    idx.indexOf('id="btn-save-grace"') !== -1 && idx.indexOf('id="btn-save-price-sources"') !== -1
    && idx.indexOf('id="btn-save-grace"') > idx.indexOf('id="btn-save-price-sources"'), '');
  check('grace settings static: the offline dropdown offers 1/3/7/14/30 days',
    JSON.stringify(selectValues(idx, 'set-grace-offline')) === JSON.stringify(['1', '3', '7', '14', '30']),
    JSON.stringify(selectValues(idx, 'set-grace-offline')));
  check('grace settings static: the duration dropdown offers 1/3/7/14/30 days + indefinite (no 0 — the toggle is the off switch)',
    JSON.stringify(selectValues(idx, 'set-grace-duration')) === JSON.stringify(['1', '3', '7', '14', '30', 'indefinite']),
    JSON.stringify(selectValues(idx, 'set-grace-duration')));
  check('grace settings static: the Save button reads "Save grace period" and is orange (primary)',
    idx.indexOf('id="btn-save-grace" class="primary"') !== -1, '');
  // Section 14 left lastOnlineAt stale (the held-clock seed), so
  // a grace is active from the read paths by now — the app was
  // offline 40 days, which is past the 7-day grace threshold.
  // Restore a fresh stamp and clear the grace for a clean
  // starting point (the check-in clock is untouched).
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
  const bhLineBefore = (readinessBlock('Dom Blockheight') || {}).state || '';
  const sdLineBefore = (readinessBlock('Dom Setdate') || {}).state || '';
  const fmLineBefore = (readinessBlock('Dom Feemarket') || {}).state || '';
  const ckLineBefore = (readinessBlock('Dom Check-in') || {}).state || '';
  // Seed a finite grace (offline 8 days, 5 days into a 7-day
  // duration) and re-render: the card shows the approved copy
  // with the offline days bolded, the held count, and the
  // countdown bar at "Day 5 of 7" / "2 days left · until <date>".
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  const graceText = elText(els['grace-text']);
  const graceHeldText = elText(els['grace-held']);
  check('grace card: appears when a grace is active',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  check('grace card: reads "Grace period has been activated because the device was offline for 8 days."',
    graceText === 'Grace period has been activated because the device was offline for 8 days.', graceText);
  check('grace card: the offline days are bolded (only that value is bold)',
    (function () {
      const gt = els['grace-text'];
      const bolds = (gt.children || []).filter((c) => c.tagName === 'B').map((c) => c.textContent);
      return bolds.length === 1 && bolds[0] === '8 days';
    })(), JSON.stringify((els['grace-text'].children || []).map((c) => c.tagName + ':' + c.textContent)));
  // The held count is 9 here too (same inventory as §14:
  // 7 trigger txs + the 2 FINNEY:0 txs from §8).
  const heldN18 = gracePillCount();
  check('grace card: reads "N transactions are held by grace, M of them would fire now." (N = the Grace pills)',
    graceHeldText === '9 transactions are held by grace, 0 of them would fire now.', graceHeldText);
  check('grace card: the held count is 9 (same inventory as §14)',
    heldN18 === 9, 'grace pills: ' + heldN18);
  // Both-numbers grace card (0.8.8): 0 of the 9 held would fire
  // now. The check-in clock is fresh (§14's Check in button
  // reset it), so both check-ins read false on the live clock;
  // everything else still reads 'watching' on its stored slice;
  // the conflict tx still reads wouldFire TRUE on its stale
  // 'due' slice but it already broadcast, so it is not held
  // and does not count.
  const st18 = await (await fetch('/api/state')).json();
  const heldLabels18 = txCards().filter((c) => { const p = cardStatus(c); return !!p && p.textContent === 'Grace'; }).map(cardTitle);
  const wf18 = (st18.bitcoin.txs || []).filter((t) => heldLabels18.includes(t.label) && (t.triggerStatus || {}).wouldFire).map((t) => t.label);
  check('grace card: 0 of the 9 held would fire now (clock fresh, everything watching)',
    wf18.length === 0, wf18.join(', '));
  check('grace card: the countdown reads "Day 5 of 7" with "2 days left · until <date>"',
    els['grace-bar-day'] && els['grace-bar-day'].textContent === 'Day 5 of 7'
    && els['grace-bar-left'] && els['grace-bar-left'].textContent === '2 days left · until ' + new Date(graceUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    (els['grace-bar-day'] && els['grace-bar-day'].textContent) + ' / ' + (els['grace-bar-left'] && els['grace-bar-left'].textContent));
  check('grace card: the countdown bar is ~71% wide (5 of 7 days elapsed)',
    els['grace-bar-fill'] && Math.abs(parseFloat(els['grace-bar-fill'].style.width) - 5 / 7 * 100) < 0.5,
    els['grace-bar-fill'] && els['grace-bar-fill'].style.width);
  // The Grace pill: armed held cards read "Grace" on
  // amber; check-in cards are held now too (0.8.8 unification),
  // manual cards are untouched.
  for (const label of ['Dom Price', 'Dom UTXO', 'Dom Blockheight', 'Dom Setdate', 'Dom Feemarket', 'Dom Check-in']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" card pill reads "Grace" on amber during the grace',
      !!pill && pill.textContent === 'Grace' && pill.className === 'pill warn',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
    const rb = readinessBlock(label);
    check('grace pill: "' + label + '" readiness pill reads "Grace" on amber too',
      !!rb && rb.status === 'Grace' && rb.statusCls === 'pill warn',
      rb ? rb.status + ' / ' + rb.statusCls : 'no block');
  }
  check('grace pill: the Dom Check-in readiness line is unchanged (condition + current value)',
    (readinessBlock('Dom Check-in') || {}).state === ckLineBefore,
    (readinessBlock('Dom Check-in') || {}).state + ' (was: ' + ckLineBefore + ')');
  check('grace pill: the Dom Price readiness line is unchanged (condition + current value)',
    (readinessBlock('Dom Price') || {}).state === priceLineBefore,
    (readinessBlock('Dom Price') || {}).state + ' (was: ' + priceLineBefore + ')');
  check('grace pill: the Dom UTXO readiness line is unchanged',
    (readinessBlock('Dom UTXO') || {}).state === utxoLineBefore,
    (readinessBlock('Dom UTXO') || {}).state + ' (was: ' + utxoLineBefore + ')');
  for (const [label, before] of [['Dom Blockheight', bhLineBefore], ['Dom Setdate', sdLineBefore], ['Dom Feemarket', fmLineBefore]]) {
    check('grace pill: the ' + label + ' readiness line is unchanged',
      (readinessBlock(label) || {}).state === before,
      (readinessBlock(label) || {}).state + ' (was: ' + before + ')');
  }
  for (const label of ['Dom Manual', 'Dom Pill healthy']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" keeps its normal pill during the grace (manual, not held)',
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
  // The card shows even with NOTHING held (0.8.8): disarm every
  // tx whose pill reads "Grace" (the held set, whatever its
  // inventory — the 9 Grace pills) and the card stays up with
  // a 0 count, then re-arm them all and the count comes back.
  const heldBefore = elText(els['grace-held']);
  const graceLabels = txCards().map((c) => ({ label: cardTitle(c), pill: cardStatus(c) }))
    .filter((x) => x.label && x.pill && x.pill.textContent === 'Grace').map((x) => x.label);
  check('grace card: the held set is the 9 Grace pills',
    graceLabels.length === 9, graceLabels.join(', '));
  const allIds = ((await (await fetch('/api/state')).json()).bitcoin.txs || [])
    .filter((t) => graceLabels.includes(t.label))
    .map((t) => t.id);
  for (const id of allIds) {
    await fetch('/api/bitcoin/txs/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  }
  await rerender(appJs);
  check('grace card: still visible with nothing held (0 held)',
    els['grace-card'] && els['grace-card'].style.display !== 'none'
    && elText(els['grace-held']) === '0 transactions are held by grace, 0 of them would fire now.',
    elText(els['grace-held']));
  for (const id of allIds) {
    await fetch('/api/bitcoin/txs/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  }
  await rerender(appJs);
  check('grace card: the held count reads "' + heldBefore + '" again after re-arming',
    elText(els['grace-held']) === heldBefore,
    elText(els['grace-held']));
  // Under a day left: a grace ending ~12h out reads
  // "less than a day left" instead of "0 days left".
  // triggeredAt is 6.5 days ago (not 6): with until 12h out
  // the duration is exactly 7 days, so Math.round lands on 7.
  // A 6-day trigger puts the duration at exactly 6.5 days —
  // the rounding boundary — and a 1 ms gap between the seed's
  // two Date.now() calls flips the render to "Day 6 of 6"
  // (measured ~0.1% of seeds; a pre-existing flake, not an
  // app bug — the app only ever creates whole-day durations).
  setDomGrace({ graceUntil: new Date(Date.now() + 12 * 3600000).toISOString(), triggeredAt: new Date(Date.now() - 6.5 * 86400000).toISOString(), offlineGapDays: 8 });
  await rerender(appJs);
  check('grace card: under a day left reads "less than a day left" (Day 6 of 7)',
    els['grace-bar-day'] && els['grace-bar-day'].textContent === 'Day 6 of 7'
    && els['grace-bar-left'] && (els['grace-bar-left'].textContent || '').indexOf('less than a day left · until ') === 0,
    (els['grace-bar-day'] && els['grace-bar-day'].textContent) + ' / ' + (els['grace-bar-left'] && els['grace-bar-left'].textContent));
  // Resume now: the button clears the grace and the card hides;
  // the pills read "armed" again.
  els['btn-resume-grace'].click();
  await waitForRender();
  check('grace card: Resume now hides the card',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  const afterResume = await (await fetch('/api/state')).json();
  check('grace card: the grace is gone from /api/state after Resume',
    afterResume.grace === null, JSON.stringify(afterResume.grace));
  for (const label of ['Dom Price', 'Dom UTXO', 'Dom Blockheight', 'Dom Setdate', 'Dom Feemarket']) {
    const pill = cardByTitle(label) && cardStatus(cardByTitle(label));
    check('grace pill: "' + label + '" reads "armed" again after Resume',
      !!pill && pill.textContent === 'armed',
      pill ? pill.textContent + ' / ' + pill.className : 'no pill');
  }
  // An indefinite grace has no bar — the labels row reads
  // "until you resume" instead of a date.
  setDomGrace({ graceUntil: null, triggeredAt: graceTriggeredAt, offlineGapDays: 12 });
  await rerender(appJs);
  const indText = elText(els['grace-text']);
  check('grace card: an indefinite grace shows (offline 12 days)',
    els['grace-card'] && els['grace-card'].style.display !== 'none' && indText.indexOf('12 days') !== -1, indText);
  check('grace card: an indefinite grace reads "until you resume" in the labels row, with no bar',
    els['grace-bar-left'] && els['grace-bar-left'].textContent === 'until you resume'
    && els['grace-bar'] && els['grace-bar'].style.display === 'none',
    (els['grace-bar-left'] && els['grace-bar-left'].textContent) + ' / bar display=' + (els['grace-bar'] && els['grace-bar'].style.display));
  els['btn-resume-grace'].click();
  await waitForRender();
  check('grace card: Resume now hides the indefinite grace card too',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  // The toggle: off hides the dashboard card even with a grace
  // seeded active, and held pills read "armed" again — off means
  // triggers fire immediately. On brings the card back (the
  // seeded grace record itself survives the toggle).
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  check('grace toggle: the card shows again with a seeded grace (toggle on)',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  check('grace toggle: the toggle starts checked (grace on by default)',
    els['grace-enabled'] && els['grace-enabled'].checked === true, '');
  check('grace toggle: the grace fields show while enabled',
    els['grace-fields'] && els['grace-fields'].style.display !== 'none', '');
  els['grace-enabled'].checked = false;
  fireChange(els['grace-enabled']);
  check('grace toggle: unchecking hides the grace fields',
    els['grace-fields'] && els['grace-fields'].style.display === 'none', '');
  check('grace toggle: the toggle itself stays visible while disabled (it lives in the heading, not the fields)',
    els['grace-enabled-wrap'] && els['grace-enabled-wrap'].style.display !== 'none', '');
  check('grace toggle: the switch title names the off state while disabled',
    els['grace-enabled-wrap'] && els['grace-enabled-wrap'].title === 'Grace period off — triggers fire immediately',
    els['grace-enabled-wrap'] && els['grace-enabled-wrap'].title);
  check('grace toggle: hiding keeps the dropdown values (7 / 7)',
    els['set-grace-offline'] && els['set-grace-offline'].value === '7'
    && els['set-grace-duration'] && els['set-grace-duration'].value === '7',
    'offline=' + (els['set-grace-offline'] && els['set-grace-offline'].value)
    + ' duration=' + (els['set-grace-duration'] && els['set-grace-duration'].value));
  els['btn-save-grace'].click();
  await waitForRender();
  const gOff = await (await fetch('/api/state')).json();
  check('grace toggle: saving off persists graceEnabled false (dropdowns kept at 7 / 7)',
    gOff.settings && gOff.settings.graceEnabled === false
    && gOff.settings.graceOfflineDays === 7 && gOff.settings.graceDurationDays === 7,
    JSON.stringify(gOff.settings && { graceEnabled: gOff.settings.graceEnabled, graceOfflineDays: gOff.settings.graceOfflineDays, graceDurationDays: gOff.settings.graceDurationDays }));
  check('grace toggle: the dashboard card hides while the grace is off, even with a seeded active grace',
    els['grace-card'] && els['grace-card'].style.display === 'none',
    els['grace-card'] && els['grace-card'].style.display);
  check('grace toggle: held pills read "armed" again while the grace is off',
    (function () {
      const pill = cardByTitle('Dom Price') && cardStatus(cardByTitle('Dom Price'));
      return !!pill && pill.textContent === 'armed';
    })(), '');
  els['grace-enabled'].checked = true;
  fireChange(els['grace-enabled']);
  check('grace toggle: re-checking shows the grace fields again',
    els['grace-fields'] && els['grace-fields'].style.display !== 'none',
    els['grace-fields'] && els['grace-fields'].style.display);
  check('grace toggle: the switch title names the on state again after re-enabling',
    els['grace-enabled-wrap'] && els['grace-enabled-wrap'].title === 'Grace period on — triggers pause after an offline gap',
    els['grace-enabled-wrap'] && els['grace-enabled-wrap'].title);
  els['btn-save-grace'].click();
  await waitForRender();
  const gOn = await (await fetch('/api/state')).json();
  check('grace toggle: saving on persists graceEnabled true',
    gOn.settings && gOn.settings.graceEnabled === true,
    JSON.stringify(gOn.settings && { graceEnabled: gOn.settings.graceEnabled }));
  check('grace toggle: the dashboard card shows again with the toggle back on (the seeded grace survived)',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  // Clear the seeded grace so the settings tests below start clean.
  els['btn-resume-grace'].click();
  await waitForRender();
  check('grace toggle: Resume now hides the card after re-enabling',
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
  await waitForRender();
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
  // The toggle is the off switch now: saving with it off keeps the
  // dropdown values, and the duration dropdown has no 0 to save.
  check('grace settings: the toggle is on while saving the defaults',
    els['grace-enabled'] && els['grace-enabled'].checked === true, '');
  els['set-grace-offline'].value = '7';
  els['set-grace-duration'].value = '7';
  els['btn-save-grace'].click();
  await waitForRender();
  const gRestored = await (await fetch('/api/state')).json();
  check('grace settings: restoring the defaults (7 / 7, toggle on) persists',
    gRestored.settings && gRestored.settings.graceEnabled === true
    && gRestored.settings.graceOfflineDays === 7 && gRestored.settings.graceDurationDays === 7,
    JSON.stringify(gRestored.settings && { graceEnabled: gRestored.settings.graceEnabled, graceOfflineDays: gRestored.settings.graceOfflineDays, graceDurationDays: gRestored.settings.graceDurationDays }));
  // Leave a finite grace active at the end, so the width check
  // can measure the grace card at 390px.
  setDomGrace({ graceUntil, triggeredAt: graceTriggeredAt, offlineGapDays: 8 });
  await rerender(appJs);
  check('grace card: a finite grace is left active for the width check',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);
  // (0.8.8, audit finding 3) Grace counts must ignore a set
  // member's parked trigger: a member whose own trigger is
  // check-in, inside a set whose trigger is manual, is NOT
  // held by the grace — the set's trigger is the one that
  // fires. The reverse (manual member, check-in set) IS held,
  // counted through the set. (A live member's subcard carries
  // no pill at all — only a stale member gets one — so there
  // is no member "Grace" pill to fix; the count is the bug,
  // plus the set card's own pill, which must read the set's
  // trigger, not any member's parked one.)
  const addF3M1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 210001), label: 'Dom F3 member ck', trigger: { type: 'checkin', params: { thresholdDays: 35 } } }) });
  check('grace counts: the check-in member tx adds', addF3M1.status === 201, 'status=' + addF3M1.status);
  const addF3M1Json = addF3M1.status === 201 ? await addF3M1.json() : {};
  const f3m1Id = (addF3M1Json.tx || {}).id || null;
  // Standalone first: the check-in member counts on its own
  // (held 9 -> 10), so the set step below proves the drop.
  await rerender(appJs);
  check('grace counts: the standalone check-in member counts as held (10 held)',
    elText(els['grace-held']) === '10 transactions are held by grace, 0 of them would fire now.',
    elText(els['grace-held']));
  const addF3S1 = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom F3 manual set', txIds: [f3m1Id], trigger: { type: 'manual', params: {} } }) });
  check('grace counts: the manual set creates with the check-in member', addF3S1.status === 201, 'status=' + addF3S1.status);
  const addF3S1Json = addF3S1.status === 201 ? await addF3S1.json() : {};
  const f3s1Id = (addF3S1Json.set || {}).id || null;
  await rerender(appJs);
  check('grace counts: attaching the member to a manual set drops the held count back to 9 (parked trigger ignored)',
    elText(els['grace-held']) === '9 transactions are held by grace, 0 of them would fire now.',
    elText(els['grace-held']));
  const f3s1Card = cardByTitle('Dom F3 manual set');
  const f3s1Pill = f3s1Card && cardStatus(f3s1Card);
  check('grace counts: the manual set card pill reads "armed", not "Grace"',
    !!f3s1Pill && f3s1Pill.textContent === 'armed',
    f3s1Pill ? f3s1Pill.textContent + ' / ' + f3s1Pill.className : 'no pill');
  check('grace counts: no "Grace" anywhere on the manual set card (member subcard reads the set, not its parked trigger)',
    !!f3s1Card && cardFaceText(f3s1Card).indexOf('Grace') === -1,
    f3s1Card ? cardFaceText(f3s1Card) : 'no card');
  check('grace counts: the member has no standalone card while attached',
    !cardByTitle('Dom F3 member ck'), '');
  // Reverse: a manual member in a check-in set IS held, counted
  // through the set (held 9 -> 10), and the set pill reads Grace.
  const addF3M2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(2, 210002), label: 'Dom F3 member manual', trigger: { type: 'manual', params: {} } }) });
  check('grace counts: the manual member tx adds', addF3M2.status === 201, 'status=' + addF3M2.status);
  const addF3M2Json = addF3M2.status === 201 ? await addF3M2.json() : {};
  const f3m2Id = (addF3M2Json.tx || {}).id || null;
  const addF3S2 = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom F3 checkin set', txIds: [f3m2Id], trigger: { type: 'checkin', params: { thresholdDays: 35 } } }) });
  check('grace counts: the check-in set creates with the manual member', addF3S2.status === 201, 'status=' + addF3S2.status);
  const addF3S2Json = addF3S2.status === 201 ? await addF3S2.json() : {};
  const f3s2Id = (addF3S2Json.set || {}).id || null;
  await rerender(appJs);
  check('grace counts: the manual member in a check-in set counts through the set (10 held)',
    elText(els['grace-held']) === '10 transactions are held by grace, 0 of them would fire now.',
    elText(els['grace-held']));
  const f3s2Card = cardByTitle('Dom F3 checkin set');
  const f3s2Pill = f3s2Card && cardStatus(f3s2Card);
  check('grace counts: the check-in set card pill reads "Grace"',
    !!f3s2Pill && f3s2Pill.textContent === 'Grace' && f3s2Pill.className === 'pill warn',
    f3s2Pill ? f3s2Pill.textContent + ' / ' + f3s2Pill.className : 'no pill');
  // Clean up: delete both sets (members return to standalone),
  // then the member txs, so the fixture is back to 9 held for
  // the sections below. The seeded grace stays active.
  const delF3S1 = await fetch('/api/bitcoin/sets/' + f3s1Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('grace counts: the manual set deletes', delF3S1.status === 200, 'status=' + delF3S1.status);
  const delF3S2 = await fetch('/api/bitcoin/sets/' + f3s2Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('grace counts: the check-in set deletes', delF3S2.status === 200, 'status=' + delF3S2.status);
  const delF3M1 = await fetch('/api/bitcoin/txs/' + f3m1Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('grace counts: the check-in member tx deletes', delF3M1.status === 200, 'status=' + delF3M1.status);
  const delF3M2 = await fetch('/api/bitcoin/txs/' + f3m2Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  check('grace counts: the manual member tx deletes', delF3M2.status === 200, 'status=' + delF3M2.status);
  await rerender(appJs);
  check('grace counts: the held count is back to 9 after cleanup',
    elText(els['grace-held']) === '9 transactions are held by grace, 0 of them would fire now.',
    elText(els['grace-held']));

  // --- 19. Getting Started empty-state card (0.8.0) ---
  // When no transactions are STAGED (active), a "Getting
  // Started" card appears at the very top of the Dashboard —
  // the first thing a fresh install sees — with the owner's exact
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
  check('user controls static: the Broadcast Fee Risk inputs are number inputs with bounds 1-10 and 0.5-5 and a x peak tx fee unit',
    idx.indexOf('id="set-fee-low" type="number" min="1" max="10"') !== -1
    && idx.indexOf('id="set-fee-medium" type="number" min="0.5" max="5"') !== -1
    && idx.indexOf('<span>× peak tx fee</span>') !== -1, '');
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
  check('fee zone bar static: the second input reads "High Risk at or below" and both units read "× peak tx fee"',
    idx.indexOf('<label for="set-fee-medium">High Risk at or below</label>') !== -1
    && idx.indexOf('<span>× peak tx fee</span>') !== -1, '');
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
  // The peak is 2.0 — the launcher seeds 25 hourly observations
  // at 2.0 spanning a full day, and the startup tick adds nothing
  // (the latest seed is minutes old) — so 4.0 is Low Risk at the
  // defaults.
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
  const stAgreeRestored = await (await fetch('/api/state')).json();
  check('user controls agreement save: restoring 5% from the UI persists (and the note shows 5% again)',
    stAgreeRestored.settings && stAgreeRestored.settings.priceAgreementPct === 5
    && els['price-sources-agreement'] && els['price-sources-agreement'].textContent === '5%',
    JSON.stringify(stAgreeRestored.settings && stAgreeRestored.settings.priceAgreementPct) + ' note=' + (els['price-sources-agreement'] && els['price-sources-agreement'].textContent));
  // Save the check cadence from the UI, then restore it.
  els['set-check-cadence'].value = '10';
  els['btn-save-check-cadence'].click();
  await waitForRender();
  const stCad = await (await fetch('/api/state')).json();
  check('user controls cadence save: saving 10 seconds from the UI persists in /api/state',
    stCad.settings && stCad.settings.checkCadenceSeconds === 10,
    JSON.stringify(stCad.settings && stCad.settings.checkCadenceSeconds));
  check('user controls cadence save: the msg line confirms the save',
    els['check-cadence-msg'] && els['check-cadence-msg'].textContent === 'Check cadence saved.',
    els['check-cadence-msg'] && els['check-cadence-msg'].textContent);
  els['set-check-cadence'].value = '60';
  els['btn-save-check-cadence'].click();
  await waitForRender();
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
    && appJs.indexOf('price, UTXO, block-height, set-date, and fee-market triggers keep firing') !== -1,
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
  await waitForRender();
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
    { key: 'grace', title: 'Grace period', bodyPhrase: 'A pause for ALL triggers', appliesPhrase: 'Check-in, BTC price, UTXO, Block height, Set date, and Fee market triggers' },
    { key: 'agreement', title: 'Price agreement', bodyPhrase: 'How closely the two price sources must agree', appliesPhrase: 'BTC price triggers only' },
    { key: 'cadence', title: 'Check cadence', bodyPhrase: 'How often every trigger is checked', bodyPhrase2: 'refreshes once every 5 minutes regardless of this setting', bodyPhrase3: 'Public nodes rate-limit heavy use', appliesPhrase: 'BTC price, UTXO, Block height, Set date, and Fee market triggers' },
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
    if (h.bodyPhrase2) {
      check('help ' + h.key + ': the pop-out body also says the fee cache refreshes on its own 5-minute interval',
        els['confirm-body'] && els['confirm-body'].textContent.indexOf(h.bodyPhrase2) !== -1,
        els['confirm-body'] && els['confirm-body'].textContent.slice(0, 160));
    }
    if (h.bodyPhrase3) {
      check('help ' + h.key + ': the pop-out body also warns that public nodes rate-limit heavy use',
        els['confirm-body'] && els['confirm-body'].textContent.indexOf(h.bodyPhrase3) !== -1,
        els['confirm-body'] && els['confirm-body'].textContent.slice(0, 320));
    }
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
  // (0.8.5) The cadence help no longer claims the fee cache
  // matches the check interval — the fee cache is fixed at
  // 5 minutes regardless of cadence.
  check('help cadence: the served app.js no longer says the price and fee caches match the interval',
    appJs.indexOf('The price and fee caches match this interval') === -1, '');

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
    && idx.indexOf('Download an encrypted backup (recommended) or an unencrypted one.') !== -1
    && idx.indexOf('POST /checkin to check in, GET /health to test') !== -1
    && idx.indexOf('A reading is only trusted when the two agree within <span id="price-sources-agreement">5%</span>.') !== -1, '');
  // The trimmed facts still live in the "?" pop-outs (app.js).
  // The trimmed facts still live in the "?" pop-outs (app.js).
  // ASCII-safe substrings only: the source holds \u2019
  // escapes, not the decoded apostrophe.
  check('trim static: the moved facts still live in the "?" pop-outs',
    appJs.indexOf('price, UTXO, block-height, set-date, and fee-market triggers keep firing') !== -1
    && appJs.indexOf('which reveal the destination addresses and amounts') !== -1
    && appJs.indexOf('A key can only check in') !== -1
    && appJs.indexOf('The Low multiplier must stay above the Medium one') !== -1
    && appJs.indexOf('or your own mempool on the LAN') !== -1
    && appJs.indexOf('Toggle the secondary off to use the primary alone') !== -1
    && appJs.indexOf('price decides') !== -1
    && appJs.indexOf('Standby evaluates all triggers together every X seconds') !== -1, '');
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
  checkFilter('checkin', ['vacation', 'grace', 'keys']);
  checkFilter('price', ['price-sources', 'grace', 'agreement', 'cadence']);
  checkFilter('utxo', ['grace', 'cadence']);
  checkFilter('blockheight', ['grace', 'cadence']);
  checkFilter('setdate', ['grace', 'cadence']);
  checkFilter('feemarket', ['grace', 'cadence']);
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
    { key: 'grace', label: 'Check-in, BTC price, UTXO, Block height, Set date, and Fee market triggers', visible: ['all', 'checkin', 'price', 'utxo', 'blockheight', 'setdate', 'feemarket'] },
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
  check('app version: the installed version reads 0.8.13 (from /api/health)',
    els['app-version'] && els['app-version'].textContent === '0.8.13',
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
    const det = txItemDetails(card);
    if (!det) return null;
    for (const d of det.children) { if (d.className === 'tx-history') return d; }
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
      const det = txItemDetails(histCard);
      return !!det && det.children[det.children.length - 1] === cardHistory(histCard);
    })()
    && cardChildIndex(histCard, 'tx-trigger') < cardChildIndex(histCard, 'tx-actions'),
    histCard ? 'trigger=' + cardChildIndex(histCard, 'tx-trigger') + ' actions=' + cardChildIndex(histCard, 'tx-actions') : 'no card');
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
  // (Optimization O6, deviation from the proposal) No cache clear
  // here: the price cache is already warm with the live $98,200
  // readings (healed by the release check after the restore in
  // the exchange-status section above), and the served price is
  // derived live from that cache — clearing it would drop the
  // live values. (0.8.8) The grace is resumed first: the
  // extended grace holds block-height now, so a held release
  // check could not land the blockheight slice (the OR subcard
  // would read "Not evaluated yet", and the set-date sets in
  // §28 would read Grace instead of armed). Resumed, the
  // blockheight / check-in rule slices land as before. The
  // finite grace is re-seeded at the end of the script, for the
  // width check.
  const resGrace25 = await fetch('/api/grace/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('rule sets 0.8.2: the grace is resumed so the rules evaluate', resGrace25.status === 200, 'status=' + resGrace25.status);
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

  // --- §26 (0.8.5): live view — in-place refresh at the check cadence ---
  // One 1-second timer updates the check-in countdown from the
  // clock, and triggers a server refresh once
  // per check cadence; the server refresh patches changed values
  // in place (same card elements, new text) and only re-renders
  // structure when no popup is open and no field is focused. The
  // intervals are stubbed (captured, not scheduled), so the checks
  // fire the 1-second timer by hand.
  function sleep26(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function liveTickFn() {
    const ivs = (global.__intervals || []).filter((x) => x.ms === 1000);
    return ivs.length ? ivs[ivs.length - 1].fn : null;
  }
  // The server tick is every 60s and the price cache TTL is the
  // cadence, so a stub price change takes up to a tick to reach
  // the slices: poll the state until the Dom Price slice shows
  // the new price.
  async function waitPriceSlice26(label, want, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const st = await (await fetch('/api/state')).json();
      const tx = (st.bitcoin.txs || []).find((t) => t.label === label);
      const ts = tx && tx.triggerStatus;
      if (ts && ts.lastPrice === want) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep26(3000);
    }
  }
  // (a) Values update without a reload, in place.
  const st26a = await (await fetch('/api/state')).json();
  const domPrice26 = (st26a.bitcoin.txs || []).find((t) => t.label === 'Dom Price');
  const domCheckin26 = (st26a.bitcoin.txs || []).find((t) => t.label === 'Dom Check-in');
  const domUtxo26 = (st26a.bitcoin.txs || []).find((t) => t.label === 'Dom UTXO');
  const domOr26 = (st26a.bitcoin.txs || []).find((t) => t.label === 'Dom Rules OR');
  const cad10 = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkCadenceSeconds: 10 }) });
  check('live view: the check cadence drops to 10s for this section', cad10.status === 200, 'status=' + cad10.status);
  // Disarm Dom Price first, so the $160,000 crossing can never
  // broadcast it (it would fire the moment the slice updates).
  const disP26 = await fetch('/api/bitcoin/txs/' + domPrice26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('live view: Dom Price disarms before the price move', disP26.status === 200, 'status=' + disP26.status);
  // Disarm Dom Rules OR: its price rule (>= $150,000) would fire
  // while the stub sits at $160,000. Its blockheight rule is NOT
  // why it disarms any more: the tip fetch is primary-first now
  // (0.8.5), and a disarmed tx is still evaluated, so OR's
  // blockheight rule is itself the primary-only call the stamp
  // check needs — no fee tx has to be added for it (§19 deleted
  // the seeded Dom Feemarket and never restored it, and the old
  // stamp check added one for exactly this). Dom UTXO needs no
  // disarm either: its outspend check answers on the primary
  // (FINNEY:1 is unspent there), so the secondary is never
  // asked. OR re-arms at the end of (d), once the stub price is
  // back to $98,200 — its price rule would trip the enable gate
  // while the stub price sits at $160,000.
  const disOr26 = await fetch('/api/bitcoin/txs/' + domOr26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('live view: Dom Rules OR disarms (its price rule would fire at $160,000)', disOr26.status === 200, 'status=' + disOr26.status);
  await rerender(appJs);
  const priceCard26 = cardByTitle('Dom Price');
  check('live view: the Dom Price card exists after the re-render', !!priceCard26, '');
  const parts26a = priceCard26 ? boxParts(triggerBoxes(priceCard26)[0]) : null;
  check('live view: before the move the price pill reads Not met',
    !!parts26a && parts26a.pill === 'Not met', parts26a ? parts26a.pill : 'no box');
  check('live view: before the move the price line reads $98,200',
    !!parts26a && parts26a.now.indexOf('$98,200') !== -1, parts26a ? parts26a.now : 'no box');
  const rRow26 = priceCard26 ? (els['readiness-txs'].children || []).find((c) => c.dataset && c.dataset.txId === domPrice26.id) : null;
  check('live view: the Dom Price readiness row exists', !!rRow26, '');
  const det26 = priceCard26 ? txItemDetails(priceCard26) : null;
  if (det26) toggleDetails(det26, true);
  check('live view: the Dom Price Details open before the tick', !!det26 && det26.open === true, det26 ? 'open=' + det26.open : 'no details');
  // Open the cadence gate: the last fetch was the re-render load.
  await sleep26(11000);
  const setP160 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd: 160000 }) });
  check('live view: the stub price moves to $160,000', setP160.status === 200, 'status=' + setP160.status);
  const got160 = await waitPriceSlice26('Dom Price', 160000, 100000);
  check('live view: the Dom Price slice reaches $160,000', got160, '');
  // A fresh connection test, so the node rows have a checked
  // time to show (the DOM app's nodes point at the local stubs).
  const connTest26 = await fetch('/api/bitcoin/connection/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('live view: the connection test runs for the node rows', connTest26.status === 200, 'status=' + connTest26.status);
  const tick26 = liveTickFn();
  check('live view: the app registers a 1-second live timer', !!tick26, '');
  if (tick26) await tick26();
  check('live view: the price card is the SAME element after the tick (patched in place, not rebuilt)',
    !!priceCard26 && cardByTitle('Dom Price') === priceCard26, '');
  const parts26b = priceCard26 ? boxParts(triggerBoxes(priceCard26)[0]) : null;
  check('live view: after the tick the price pill reads Met',
    !!parts26b && parts26b.pill === 'Met', parts26b ? parts26b.pill : 'no box');
  check('live view: after the tick the price line reads $160,000',
    !!parts26b && parts26b.now.indexOf('$160,000') !== -1, parts26b ? parts26b.now : 'no box');
  check('live view: the readiness row is the SAME element after the tick',
    !!rRow26 && (els['readiness-txs'].children || []).indexOf(rRow26) !== -1, '');
  check('live view: the open Details stay open across the tick',
    !!det26 && det26.open === true, det26 ? 'open=' + det26.open : 'no details');
  check('live view: the Dashboard tab stays active across the tick',
    !!(els.__tabbtn && els.__tabbtn.dashboard && els.__tabbtn.dashboard.classList.contains('active')), '');
  check('live view: no overall freshness line — the element is gone',
    !els['live-updated'], '');
  const exPrice26 = els['readiness-exchange-1-price'] ? els['readiness-exchange-1-price'].textContent : '';
  check('live view: the exchange row reads checked time, dash, price',
    /^checked .+ - \$160,000$/.test(exPrice26), exPrice26);
  const nodeChecked26a = els['readiness-primary-checked'] ? els['readiness-primary-checked'].textContent : '';
  const nodeChecked26b = els['readiness-secondary-checked'] ? els['readiness-secondary-checked'].textContent : '';
  check('live view: each node row carries its own checked time left of the pill',
    /^checked /.test(nodeChecked26a) && /^checked /.test(nodeChecked26b), nodeChecked26a + ' / ' + nodeChecked26b);
  // (0.8.5, restated 0.8.8) Per-node stamps: the tick asks the
  // primary every time (the blockheight rule's tip fetch,
  // primary-first and cached once per tick) — but the old
  // assertion, that the primary stamp ends up NEWER than the
  // secondary's, was false. This suite's `Dom Rules Unknown`
  // watches a nonexistent outpoint, so its outspend check 404s
  // on the primary and falls through to the secondary on
  // null/404 (404s are never cached); every tick asks BOTH
  // nodes, the secondary ~1ms after the primary, so the
  // primary is newer only in a ~10ms window per tick and the
  // 60s poll essentially never lands in it — a phase lottery,
  // not a real failure. The restated check asserts the
  // primary stamp ADVANCES during the poll instead: capture
  // it once, then poll until a later reading is newer. The
  // tip cache TTL equals the tick cadence, so a tick can
  // occasionally find the cache still warm and skip the
  // fetch — poll until a tick actually fetches (the next tick
  // always does: the cache is then ~2x the TTL old).
  async function waitNodeStamps26(timeoutMs) {
    const t0 = Date.now();
    // Baseline: the primary stamp as it stands when the poll
    // starts. A missing baseline is a failure, not a pass.
    let start = null;
    while (start === null) {
      const st = await (await fetch('/api/state')).json();
      const nc = (st.bitcoin && st.bitcoin.connection && st.bitcoin.connection.nodeCheckedAt) || {};
      if (nc.primary) { start = nc.primary; break; }
      if (Date.now() - t0 > timeoutMs) return { start: null, end: null };
      await sleep26(3000);
    }
    for (;;) {
      const st = await (await fetch('/api/state')).json();
      const nc = (st.bitcoin && st.bitcoin.connection && st.bitcoin.connection.nodeCheckedAt) || {};
      if (nc.primary && nc.primary > start) return { start: start, end: nc.primary };
      if (Date.now() - t0 > timeoutMs) return { start: start, end: nc.primary || null };
      await sleep26(3000);
    }
  }
  const nc26 = await waitNodeStamps26(60000);
  check('live view: the primary node stamp advances during the poll (tick asks primary)',
    !!(nc26.start && nc26.end && nc26.end > nc26.start), JSON.stringify(nc26));
  // Dom Rules OR stays disarmed until the end of (d): its price
  // rule (>= $150,000) would trip the enable gate while the
  // stub price sits at $160,000.

  // (b) The refresh RUNS while the Add popup is open, and the
  // typed input survives; a structural change waits until the
  // popup closes.
  els['btn-btc-add-open'].click();
  check('live view: the Add popup opens for the modal test',
    !!(els['add-modal'] && els['add-modal'].classList.contains('open')), '');
  const typedHex26 = craftHex(1, 200401);
  els['btc-hex'].value = typedHex26;
  const addLive = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 200402), label: 'Dom Live New', trigger: { type: 'checkin', params: { thresholdDays: 35 } } }) });
  check('live view: a new tx adds via the API while the popup is open', addLive.status === 201, 'status=' + addLive.status);
  const addLiveJson = addLive.status === 201 ? await addLive.json() : {};
  const liveNewId = (addLiveJson.tx || {}).id || null;
  const setP98 = await realFetch('http://127.0.0.1:18275/__test__/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd: 98200 }) });
  check('live view: the stub price moves back to $98,200', setP98.status === 200, 'status=' + setP98.status);
  const got98 = await waitPriceSlice26('Dom Price', 98200, 100000);
  check('live view: the Dom Price slice returns to $98,200', got98, '');
  await sleep26(11000);
  const tick26b = liveTickFn();
  if (tick26b) await tick26b();
  check('live view: the popup is still open after the tick',
    !!(els['add-modal'] && els['add-modal'].classList.contains('open')), '');
  check('live view: the typed hex survives the tick untouched',
    !!(els['btc-hex'] && els['btc-hex'].value === typedHex26), els['btc-hex'] ? els['btc-hex'].value : 'no hex field');
  const parts26c = priceCard26 ? boxParts(triggerBoxes(priceCard26)[0]) : null;
  check('live view: the price line behind the popup updates to $98,200',
    !!parts26c && parts26c.now.indexOf('$98,200') !== -1, parts26c ? parts26c.now : 'no box');
  check('live view: the new tx does NOT appear while the popup is open (structural change deferred)',
    !cardByTitle('Dom Live New'), '');
  check('live view: the price card is still the same element after the modal tick',
    !!priceCard26 && cardByTitle('Dom Price') === priceCard26, '');
  els['btn-btc-add-cancel'].click();
  check('live view: Cancel closes the popup', !!(els['add-modal'] && !els['add-modal'].classList.contains('open')), '');
  const tick26c = liveTickFn();
  if (tick26c) await tick26c();
  check('live view: the new tx appears once the popup closes (pending structural load)',
    !!cardByTitle('Dom Live New'), '');

  // (c) A local-only tick (no fetch) leaves the values alone.
  await sleep26(2500);
  const tick26d = liveTickFn();
  if (tick26d) await tick26d();
  const parts26d = cardByTitle('Dom Price') ? boxParts(triggerBoxes(cardByTitle('Dom Price'))[0]) : null;
  check('live view: the price line is still $98,200 after the local-only tick',
    !!parts26d && parts26d.now.indexOf('$98,200') !== -1, parts26d ? parts26d.now : 'no box');

  // (d) The check-in countdown ticks locally, and a disarmed
  // (frozen) bar is not rewritten by the local tick.
  const disC26 = await fetch('/api/bitcoin/txs/' + domCheckin26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('live view: Dom Check-in disarms for the frozen-bar test', disC26.status === 200, 'status=' + disC26.status);
  await sleep26(11000);
  const tick26e = liveTickFn();
  if (tick26e) await tick26e();
  const frozenBar = checkinBar('Dom Check-in');
  check('live view: the disarmed check-in bar reads frozen',
    !!frozenBar && frozenBar.caption.indexOf('disarmed, frozen') !== -1, frozenBar ? frozenBar.caption : 'no bar');
  const frozenCap = frozenBar ? frozenBar.caption : '';
  const tick26f = liveTickFn();
  if (tick26f) await tick26f();
  const frozenBar2 = checkinBar('Dom Check-in');
  check('live view: the local-only tick leaves the frozen caption unchanged',
    !!frozenBar2 && frozenBar2.caption === frozenCap, frozenBar2 ? frozenBar2.caption : 'no bar');
  const reC26 = await fetch('/api/bitcoin/txs/' + domCheckin26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  check('live view: Dom Check-in re-arms', reC26.status === 200, 'status=' + reC26.status);
  await sleep26(11000);
  const tick26g = liveTickFn();
  if (tick26g) await tick26g();
  const liveBar = checkinBar('Dom Check-in');
  check('live view: the re-armed check-in bar is live again (0 of 35 days elapsed)',
    !!liveBar && liveBar.caption === '0 of 35 days elapsed', liveBar ? liveBar.caption : 'no bar');

  // --- §27 (0.8.5): an archived tx renders its settled state ---
  // A tx broadcast by hand and confirmed (the stub reports a
  // broadcast txid as confirmed at 899995 — 6 confirmations)
  // renders in the Archived Transactions card with a Broadcasted
  // pill, and leaves the staged list. Its trigger slice is frozen
  // by the server (the API suite owns that check); the card reads
  // its settled state from the broadcasted fact, not the slice.
  const addArch27 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 300010), label: 'Dom Archived', trigger: { type: 'manual', params: {} } }) });
  check('archived row: the tx adds', addArch27.status === 201, 'status=' + addArch27.status);
  const addArch27Json = addArch27.status === 201 ? await addArch27.json() : {};
  const arch27Id = (addArch27Json.tx || {}).id || null;
  const bcArch27 = arch27Id ? await fetch('/api/bitcoin/txs/' + arch27Id + '/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }) : null;
  check('archived row: the manual broadcast succeeds', !!bcArch27 && bcArch27.status === 200, bcArch27 ? 'status=' + bcArch27.status : 'no id');
  const conf27 = await fetch('/api/bitcoin/confirmations');
  check('archived row: the confirmations refresh runs', conf27.status === 200, 'status=' + conf27.status);
  await rerender(appJs);
  const archCards27 = listCards('btc-archived-list');
  const archCard27 = archCards27.find((c) => cardTitle(c) === 'Dom Archived');
  check('archived row: the broadcasted tx renders in the Archived Transactions card',
    !!archCard27, archCards27.map((c) => cardTitle(c)).join(','));
  check('archived row: its face reads Broadcasted',
    !!archCard27 && cardFaceText(archCard27).indexOf('Broadcasted') !== -1, archCard27 ? cardFaceText(archCard27) : 'no card');
  const activeCards27 = listCards('btc-active-list');
  check('archived row: it leaves the staged list',
    !activeCards27.some((c) => cardTitle(c) === 'Dom Archived'), activeCards27.map((c) => cardTitle(c)).join(','));
  if (arch27Id) {
    const delArch27 = await fetch('/api/bitcoin/txs/' + arch27Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('archived row: the tx is removed again (fixture restored)', delArch27.status === 200, 'status=' + delArch27.status);
  }
  await rerender(appJs);

  // --- §28 (0.8.7): a shared trigger set renders as one card ---
  // One label, the BTC total up top, one arm/disarm, the
  // transactions ABOVE the triggers as blue-edged subcards
  // (.tx-item) each with its own Details + per-tx note, the
  // trigger subcards verbatim, ONE shared History as its own
  // collapsible (collapsed by default), and the actions row —
  // like a tx card. Members have no standalone card. A standalone tx
  // renders alongside, exactly as before. The release check
  // here is safe for the §26 fixtures: Dom Price and Dom
  // Rules OR are disarmed until the restore block below, and
  // the check-in clock reads 0 days elapsed.
  // (0.8.7 fix, round 10) Baseline for the readiness delta
  // below: the set and the solo add two rows, not three.
  const rbBefore28 = (readinessBlocks() || []).length;
  const addSetM1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(1, 140001), label: 'Dom Set M1', notes: 'M1 note', trigger: { type: 'setdate', params: { fireAt: '2020-01-01T00:00:00.000Z' } }, triggerConfirmed: true }) });
  check('set card: member 1 adds (own past setdate trigger)', addSetM1.status === 201, 'status=' + addSetM1.status);
  const addSetM1Json = addSetM1.status === 201 ? await addSetM1.json() : {};
  const setM1Id = (addSetM1Json.tx || {}).id || null;
  const setM1Txid = (addSetM1Json.tx || {}).txid || '';
  const addSetM2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(2, 420002), label: 'Dom Set M2', notes: 'M2 note', trigger: { type: 'setdate', params: { fireAt: '2020-01-01T00:00:00.000Z' } }, triggerConfirmed: true }) });
  check('set card: member 2 adds (own past setdate trigger)', addSetM2.status === 201, 'status=' + addSetM2.status);
  const addSetM2Json = addSetM2.status === 201 ? await addSetM2.json() : {};
  const setM2Id = (addSetM2Json.tx || {}).id || null;
  const setM2Txid = (addSetM2Json.tx || {}).txid || '';
  const addSolo28 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(3, 430003), label: 'Dom Solo', trigger: { type: 'manual', params: {} } }) });
  check('set card: the standalone tx adds', addSolo28.status === 201, 'status=' + addSolo28.status);
  const addSolo28Json = addSolo28.status === 201 ? await addSolo28.json() : {};
  const solo28Id = (addSolo28Json.tx || {}).id || null;
  const addSet28 = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Set', txIds: [setM1Id, setM2Id], trigger: { type: 'setdate', params: { fireAt: '2999-01-01T00:00:00.000Z' } } }) });
  check('set card: the set creates', addSet28.status === 201, 'status=' + addSet28.status);
  const addSet28Json = addSet28.status === 201 ? await addSet28.json() : {};
  const set28Id = (addSet28Json.set || {}).id || null;
  const rel28 = await fetch('/api/release/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('set card: the release check runs (evaluates the set trigger)', rel28.status === 200, 'status=' + rel28.status);
  await rerender(appJs);
  // (0.8.7 fix, round 10) Release readiness: ONE card per
  // trigger set, headed by the set's label with the set's pill
  // — not one row per member. A member's frozen triggerState
  // used to read Unknown, and a label-less member rendered as
  // "Untitled transaction".
  const rbDomSet = readinessBlock('Dom Set');
  check('readiness set: exactly ONE row headed by the set label', !!rbDomSet, (readinessBlocks() || []).map((b) => b.label).join(','));
  check('readiness set: the set row pill matches the set card (armed)',
    !!rbDomSet && rbDomSet.status === 'armed', rbDomSet ? rbDomSet.status : 'no block');
  check('readiness set: the set row pill class is ok',
    !!rbDomSet && rbDomSet.statusCls === 'pill ok', rbDomSet ? rbDomSet.statusCls : 'no block');
  check('readiness set: the set row state line is the set condition ("Fires on Dec 31, 2998, 7:00 PM")',
    !!rbDomSet && rbDomSet.state.indexOf('Fires on Dec 31, 2998, 7:00 PM') !== -1, rbDomSet ? rbDomSet.state : 'no block');
  check('readiness set: the set row carries NO fee pill (the fee is per tx, in Details)',
    !!rbDomSet && rbDomSet.fee === '', rbDomSet ? 'fee=' + rbDomSet.fee : 'no block');
  check('readiness set: no readiness row for either member',
    !readinessBlock('Dom Set M1') && !readinessBlock('Dom Set M2'), '');
  check('readiness set: the standalone tx still has its own row',
    !!readinessBlock('Dom Solo'), '');
  check('readiness set: two new rows for three new txs (the set counts once, not per member)',
    (readinessBlocks() || []).length === rbBefore28 + 2,
    'before=' + rbBefore28 + ' after=' + (readinessBlocks() || []).length);
  const setCard28 = listCards('btc-active-list').find((c) => cardTitle(c) === 'Dom Set');
  check('set card: the set renders in the Staged Transactions card', !!setCard28,
    listCards('btc-active-list').map((c) => cardTitle(c)).join(','));
  check('set card: its face shows the summed total (0.00560003 BTC)',
    !!setCard28 && cardFaceText(setCard28).indexOf('0.00560003 BTC') !== -1, setCard28 ? cardFaceText(setCard28) : 'no card');
  check('set card: its face reads armed',
    !!setCard28 && cardFaceText(setCard28).indexOf('armed') !== -1, setCard28 ? cardFaceText(setCard28) : 'no card');
  check('set card: its face names 2 transactions and 1 shared trigger',
    !!setCard28 && cardFaceText(setCard28).indexOf('2 transactions \u00b7 1 shared trigger') !== -1, setCard28 ? cardFaceText(setCard28) : 'no card');
  check('set card: members have no standalone card',
    !cardByTitle('Dom Set M1') && !cardByTitle('Dom Set M2'), '');
  check('set card: the standalone tx still renders alongside',
    !!cardByTitle('Dom Solo'), '');
  const items28 = setCard28 ? setCard28.children.filter((c) => (c.className || '').split(' ').includes('tx-item')) : [];
  check('set card: two blue-edged transaction subcards', items28.length === 2, 'got ' + items28.length);
  check('set card: the transaction subcards sit ABOVE the trigger subcard',
    !!setCard28 && items28.length === 2
    && setCard28.children.findIndex((x) => (x.className || '').split(' ').includes('tx-item')) !== -1
    && setCard28.children.findIndex((x) => (x.className || '').split(' ').includes('tx-item'))
      < setCard28.children.findIndex((x) => x.className === 'tx-trigger'), '');
  const itemHead28 = items28.length ? elText(items28[0].children[0]) : '';
  check('set card: member 1 subcard names its txid',
    itemHead28.indexOf(setM1Txid.slice(0, 16)) !== -1, itemHead28);
  const itemHead28b = items28.length > 1 ? elText(items28[1].children[0]) : '';
  check('set card: member 2 subcard names its txid',
    itemHead28b.indexOf(setM2Txid.slice(0, 16)) !== -1, itemHead28b);
  const itemDet28 = items28.length ? items28[0].children.find((x) => x.className === 'tx-details') : null;
  check('set card: member 1 subcard has its own Details dropdown', !!itemDet28, '');
  check('set card: the member Details carries the per-tx note',
    !!itemDet28 && elText(itemDet28).indexOf('M1 note') !== -1, itemDet28 ? elText(itemDet28) : 'no details');
  check('set card: member 1 subcard head has no Fee line (fee lives in Details)',
    !!items28.length && items28[0].children.filter((x) => x.className !== 'tx-details').every((x) => elText(x).indexOf('Fee ') === -1),
    items28.length ? items28[0].children.map((x) => x.className).join(',') : 'no items');
  check('set card: member 1 Details holds the Fee row',
    detailsContains(setCard28, 'tx-fee'), '');
  // (0.8.7 fix, round 9) Single history: a set card shows ONE
  // History — the set's. Member subcards carry NO History of
  // their own (round 7's member History is reverted); the
  // member's trail lives on the set's History instead, tagged
  // with the member's label.
  const itemHist28 = itemDet28 ? itemDet28.children.find((x) => x.className === 'tx-history') : null;
  check('set card: member 1 Details carries NO History (single history — the set own)',
    !itemHist28, itemDet28 ? 'children=' + itemDet28.children.map((x) => x.className).join(',') : 'no details');
  const itemDet28b = items28.length > 1 ? items28[1].children.find((x) => x.className === 'tx-details') : null;
  const itemHist28b = itemDet28b ? itemDet28b.children.find((x) => x.className === 'tx-history') : null;
  check('set card: member 2 Details carries NO History either',
    !itemHist28b, itemDet28b ? 'children=' + itemDet28b.children.map((x) => x.className).join(',') : 'no details');
  check('set card: member 1 subcard head carries its BTC amount (0.00140001 BTC, right-aligned in the head)',
    !!items28.length && elText(items28[0].children[0]).indexOf('0.00140001 BTC') !== -1,
    items28.length ? elText(items28[0].children[0]) : 'no items');
  check('set card: member 1 subcard has no separate amount row (the head is followed straight by Details)',
    !!items28.length && items28[0].children[1] && items28[0].children[1].className === 'tx-details',
    items28.length ? items28[0].children.map((x) => x.className).join(',') : 'no items');
  const trig28 = setCard28 ? triggerBoxes(setCard28) : [];
  check('set card: exactly one verbatim trigger subcard', trig28.length === 1, 'got ' + trig28.length);
  const trigParts28 = trig28.length ? boxParts(trig28[0]) : null;
  check('set card: the trigger subcard reads SET DATE',
    !!trigParts28 && trigParts28.k.indexOf('SET DATE') !== -1, trigParts28 ? trigParts28.k : 'no box');
  check('set card: the trigger pill reads Not met (future date)',
    !!trigParts28 && trigParts28.pill === 'Not met', trigParts28 ? trigParts28.pill : 'no box');
  // (0.8.7 fix, round 8) The set's shared History — the
  // history of the entire set — is its own collapsible,
  // collapsed by default like the per-tx History, above the
  // actions row. It was a plain always-expanded section in
  // the 0.8.7 base (a v6 mockup choice); the owner asked for the
  // collapsible back. (0.8.7 fix, round 9) It is the ONLY
  // History on the card now: member histories (round 7) are
  // gone, and the members' trails are backfilled into this
  // one, tagged with the member's label.
  const hist28 = setCard28 ? setCard28.children.find((x) => x.className === 'tx-history') : null;
  check('set card: ONE shared History as its own collapsible', !!hist28, '');
  check('set card: the shared History is collapsed by default',
    !!hist28 && hist28.open === false, hist28 ? 'open=' + hist28.open : 'no history');
  check('set card: the History names the creation',
    !!hist28 && elText(hist28).indexOf('Set created with 2 transactions') !== -1, hist28 ? elText(hist28) : 'no history');
  check('set card: the shared History sits above the actions row',
    !!setCard28 && !!hist28
    && setCard28.children.findIndex((x) => x === hist28) !== -1
    && setCard28.children.findIndex((x) => x === hist28) < setCard28.children.findIndex((x) => x.className === 'tx-actions'), '');
  if (hist28) toggleDetails(hist28, true);
  check('set card: toggling the shared History open flips it',
    !!hist28 && hist28.open === true, hist28 ? 'open=' + hist28.open : 'no history');
  check('set card: the shared History shows the backfilled member trails, tagged',
    !!hist28 && elText(hist28).indexOf('"Dom Set" - Tx 1') !== -1 && elText(hist28).indexOf('"Dom Set" - Tx 2') !== -1, hist28 ? elText(hist28) : 'no history');
  check('set card: exactly ONE History at card level (the set own)',
    !!setCard28 && setCard28.children.filter((x) => x.className === 'tx-history').length === 1, '');
  check('set card: the standalone tx keeps its own History in its Details',
    !!cardByTitle('Dom Solo') && detailsContains(cardByTitle('Dom Solo'), 'tx-history'), '');
  check('set card: no set-level Details dropdown',
    !!setCard28 && !cardDetails(setCard28), '');
  check('set card: the actions row has Dry-run / Edit / Delete / Broadcast Now',
    !!setCard28 && ['Dry-run', 'Edit', 'Delete', 'Broadcast Now'].every((b) => !!cardButton(setCard28, b)), '');
  const head28 = setCard28 ? setCard28.children.find((x) => x.className === 'tx-head') : null;
  check('set card: one arm/disarm toggle in the header',
    !!head28 && head28.children.some((x) => (x.className || '').split(' ').includes('switch')), '');
  const tick28 = liveTickFn();
  if (tick28) await tick28();
  check('set card: the live tick patches in place (same element)',
    !!setCard28 && cardByTitle('Dom Set') === setCard28, '');
  if (set28Id) {
    const delSet28 = await fetch('/api/bitcoin/sets/' + set28Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('set card: the set deletes', delSet28.status === 200, 'status=' + delSet28.status);
  }
  await rerender(appJs);
  check('set card: the set card is gone after the delete', !cardByTitle('Dom Set'), '');
  check('set card: the members render standalone again',
    !!cardByTitle('Dom Set M1') && !!cardByTitle('Dom Set M2'), '');
  check('set card: the freed members show their own History again (their trails survived the set)',
    !!cardByTitle('Dom Set M1') && detailsContains(cardByTitle('Dom Set M1'), 'tx-history')
    && !!cardByTitle('Dom Set M2') && detailsContains(cardByTitle('Dom Set M2'), 'tx-history'), '');
  for (const id of [setM1Id, setM2Id, solo28Id]) {
    if (!id) continue;
    const del28 = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('set card: fixture tx removed', del28.status === 200, 'status=' + del28.status);
  }
  await rerender(appJs);

  // --- §28b (0.8.7, revised stale rule): a stale member gets a
  // 'stale' pill on its subcard, and the set stays live for its
  // non-stale members. A dry-run marks the spent member stale —
  // no trigger is evaluated, so nothing can fire here.
  const addStaleM1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(0, 440004), label: 'Dom Stale M1', trigger: { type: 'manual', params: {} } }) });
  check('set stale pill: the spent member adds (FINNEY:0)', addStaleM1.status === 201, 'status=' + addStaleM1.status);
  const addStaleM1Json = addStaleM1.status === 201 ? await addStaleM1.json() : {};
  const staleM1Id = (addStaleM1Json.tx || {}).id || null;
  const addStaleM2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(2, 440005), label: 'Dom Stale M2', trigger: { type: 'manual', params: {} } }) });
  check('set stale pill: the live member adds (FINNEY:2)', addStaleM2.status === 201, 'status=' + addStaleM2.status);
  const addStaleM2Json = addStaleM2.status === 201 ? await addStaleM2.json() : {};
  const staleM2Id = (addStaleM2Json.tx || {}).id || null;
  const addStaleSet = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Stale Set', txIds: [staleM1Id, staleM2Id], trigger: { type: 'setdate', params: { fireAt: '2999-01-01T00:00:00.000Z' } } }) });
  check('set stale pill: the set creates', addStaleSet.status === 201, 'status=' + addStaleSet.status);
  const addStaleSetJson = addStaleSet.status === 201 ? await addStaleSet.json() : {};
  const staleSet28Id = (addStaleSetJson.set || {}).id || null;
  const dryStale = await fetch('/api/broadcast/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setId: staleSet28Id }) });
  check('set stale pill: the set dry-run runs', dryStale.status === 200, 'status=' + dryStale.status);
  await rerender(appJs);
  const staleCard28 = listCards('btc-active-list').find((c) => cardTitle(c) === 'Dom Stale Set');
  check('set stale pill: the set stays in the Staged Transactions card (not archived)',
    !!staleCard28, listCards('btc-active-list').map((c) => cardTitle(c)).join(','));
  check('set stale pill: the set is NOT in the Archived Transactions card',
    !listCards('btc-archived-list').some((c) => cardTitle(c) === 'Dom Stale Set'), '');
  check('set stale pill: the set face still reads armed',
    !!staleCard28 && cardFaceText(staleCard28).indexOf('armed') !== -1, staleCard28 ? cardFaceText(staleCard28) : 'no card');
  const staleItems28 = staleCard28 ? staleCard28.children.filter((c) => (c.className || '').split(' ').includes('tx-item')) : [];
  check('set stale pill: two transaction subcards', staleItems28.length === 2, 'got ' + staleItems28.length);
  const staleHead28 = staleItems28.length ? boxHeadParts(staleItems28[0]) : null;
  check('set stale pill: the spent member subcard carries a pill saying stale',
    !!staleHead28 && staleHead28.pill === 'stale', staleHead28 ? staleHead28.pill : 'no head');
  check('set stale pill: the stale pill is red',
    !!staleHead28 && staleHead28.pillCls === 'pill bad', staleHead28 ? staleHead28.pillCls : 'no head');
  const liveHead28 = staleItems28.length > 1 ? boxHeadParts(staleItems28[1]) : null;
  check('set stale pill: the live member subcard carries no pill',
    !!liveHead28 && liveHead28.pill === null, liveHead28 ? liveHead28.pill : 'no head');
  if (staleSet28Id) {
    const delStaleSet = await fetch('/api/bitcoin/sets/' + staleSet28Id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('set stale pill: the set deletes', delStaleSet.status === 200, 'status=' + delStaleSet.status);
  }
  for (const id of [staleM1Id, staleM2Id]) {
    if (!id) continue;
    const delStale = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('set stale pill: fixture tx removed', delStale.status === 200, 'status=' + delStale.status);
  }
  await rerender(appJs);

  // --- §28c (0.8.7 fix, round 3): "+ Add Tx" IS "add trigger
  // set" — one save creates a COMPLETE INDEPENDENT new trigger
  // set. ONE label sits above the tx inputs (the set's label —
  // no per-entry label, no set picker); repeatable entries
  // (notes + hex each), "+ Add another transaction" appends
  // one; then the shared triggers / route below. Saving renders
  // a set card with N blue tx subcards (each holding its own
  // Details) and M orange trigger subcards. A standalone one-tx
  // card renders the same shape — a set of one — with its blue
  // tx subcard and Details inside it, never inside a trigger
  // subcard. The set modal gained a Transactions section in
  // round 5 (Edit can add a transaction); the modal shading
  // stays as rounds 1–2 built it.
  // The one label's element is reached through
  // getElementById, not els[...] — the app only touches it in
  // the save/reset paths, so els['btc-set-label'] is undefined
  // until something calls getElementById on it (reading .value
  // off undefined throws and kills the whole DOM run).
  const setLabelEl28c = () => document.getElementById('btc-set-label');
  check('add trigger set: the Add modal has ONE label above the tx inputs (static HTML)',
    idx.indexOf('id="btc-set-label"') !== -1 && idx.indexOf('id="btc-tx-list"') !== -1
    && idx.indexOf('id="btc-set-label"') < idx.indexOf('id="btc-tx-list"'), '');
  check('add trigger set: the Add modal has NO set picker any more (static HTML)',
    idx.indexOf('id="btc-set"') === -1, '');
  check('add trigger set: the Add modal has NO per-entry label any more (static HTML)',
    idx.indexOf('add-tx-label') === -1, '');
  check('add trigger set: the Add modal has a repeatable entry list (static HTML)',
    idx.indexOf('id="btc-tx-list"') !== -1 && idx.indexOf('id="btn-btc-add-entry"') !== -1
    && idx.indexOf('id="btc-hex"') !== -1, '');
  check('add trigger set: the set modal has no transaction checklist any more (grouping removed Nov 21 — membership is fixed at creation)',
    idx.indexOf('set-txs-section') === -1 && idx.indexOf('set-txs-list') === -1, '');
  check('add trigger set: the set modal keeps its orange Triggers section (static HTML)',
    idx.indexOf('id="set-triggers-section" class="tx-trigger"') !== -1, '');
  check('add trigger set: the set modal has a Transactions section with an Add button (round 5 — Edit can add a transaction)',
    idx.indexOf('id="set-new-txs-section"') !== -1 && idx.indexOf('id="btn-set-add-tx"') !== -1, '');
  check('add trigger set: the import button lives inside a transaction entry, not as a global button (round 5)',
    idx.indexOf('id="btn-btc-import-file"') !== -1
    && idx.indexOf('id="btn-btc-import-file"') > idx.indexOf('id="btc-tx-list"')
    && idx.indexOf('id="btn-btc-import-file"') < idx.indexOf('id="btn-btc-add-entry"'), '');
  check('add trigger set: the Add label has breathing room above the transaction list (CSS)',
    css.indexOf('#btc-tx-list { margin-top: 12px; }') !== -1, '');
  check('add trigger set: the edit modal is set-shaped too — Transactions blue, Triggers orange (static HTML)',
    idx.indexOf('id="edit-txs-section" class="tx-trigger tx-item"') !== -1
    && idx.indexOf('id="edit-triggers-section" class="tx-trigger"') !== -1, '');
  check('add trigger set: no standalone accent class left in the CSS (blue belongs to the tx subcard)',
    css.indexOf('.tx-card.tx-single') === -1 && css.indexOf('.tx-trigger.tx-item { border-left-color: #60a5fa; }') !== -1, '');
  // The Add form's rule list is whatever §25 left (up to three
  // panels) — narrow it to the one default check-in rule, so
  // the new txs get the 35-day check-in trigger (dormant in
  // the set) and no confirm can appear (0 days elapsed).
  while (rulePanels('btc').length > 1) panelRemoveBtn(rulePanels('btc')[rulePanels('btc').length - 1]).click();
  selectAddTrigger('checkin');
  check('add trigger set: the Add form is back to one check-in rule', rulePanels('btc').length === 1
    && panelTypeSelect(rulePanels('btc')[0]).value === 'checkin', 'panels=' + rulePanels('btc').length);
  els['btn-btc-add-open'].click();
  check('add trigger set: the Add popup opens', els['add-modal'] && els['add-modal'].classList.contains('open'), '');
  check('add trigger set: the one label starts blank', setLabelEl28c().value === '', 'value=' + setLabelEl28c().value);
  // The static first entry is not modelled as a child in the
  // shim — its fields are the standalone btc-* els — while
  // JS-built entries hang off #btc-tx-list. Appending twice
  // then removing one proves the repeatable entries work.
  const entryField28c = (entry, cls) => {
    let found = null;
    const walk = (el) => { (el.children || []).forEach((c) => { if ((c.className || '').split(' ').indexOf(cls) !== -1) found = c; walk(c); }); };
    walk(entry);
    return found;
  };
  const entryTitle28c = (entry) => entry.children[0] && entry.children[0].children[0] && entry.children[0].children[0].textContent;
  const entryRemove28c = (entry) => entry.children[0] && entry.children[0].children[1];
  els['btn-btc-add-entry'].click();
  els['btn-btc-add-entry'].click();
  check('add trigger set: "+ Add another" appends entries (two JS entries)',
    els['btc-tx-list'].children.length === 2, 'children=' + els['btc-tx-list'].children.length);
  check('add trigger set: the appended entries are titled Transaction 2 and 3',
    entryTitle28c(els['btc-tx-list'].children[0]) === 'Transaction 2'
    && entryTitle28c(els['btc-tx-list'].children[1]) === 'Transaction 3', '');
  entryRemove28c(els['btc-tx-list'].children[1]).click();
  check('add trigger set: removing an entry drops it and renumbers',
    els['btc-tx-list'].children.length === 1
    && entryTitle28c(els['btc-tx-list'].children[0]) === 'Transaction 2', 'children=' + els['btc-tx-list'].children.length);
  check('add trigger set: each appended entry has its own import button (round 5)',
    !!entryField28c(els['btc-tx-list'].children[0], 'btc-tx-import'), '');
  setLabelEl28c().value = 'Dom Add Set';
  els['btc-notes'].value = 'M1 note';
  els['btc-hex'].value = craftHex(1, 450001);
  const entry228c = els['btc-tx-list'].children[0];
  entryField28c(entry228c, 'add-tx-notes').value = 'M2 note';
  entryField28c(entry228c, 'add-tx-hex').value = craftHex(2, 450002);
  els['btn-btc-add'].click();
  await waitForRender();
  check('add trigger set: the popup closes on save',
    els['add-modal'] && !els['add-modal'].classList.contains('open'), '');
  check('add trigger set: the confirmation names the new set and both transactions',
    els['btc-all-msg'] && els['btc-all-msg'].textContent.indexOf('Trigger set "Dom Add Set" created with 2 transactions and armed') !== -1,
    els['btc-all-msg'] && els['btc-all-msg'].textContent);
  check('add trigger set: the form resets to one blank entry and a blank label',
    els['btc-hex'].value === '' && els['btc-tx-list'].children.length === 0 && setLabelEl28c().value === '',
    'hex=' + (els['btc-hex'] && els['btc-hex'].value) + ' children=' + els['btc-tx-list'].children.length + ' label=' + setLabelEl28c().value);
  await rerender(appJs);
  const addCard28c = listCards('btc-active-list').find((c) => cardTitle(c) === 'Dom Add Set');
  check('add trigger set: the set renders in the Staged Transactions card', !!addCard28c,
    listCards('btc-active-list').map((c) => cardTitle(c)).join(','));
  check('add trigger set: its face shows the summed total (0.00900003 BTC)',
    !!addCard28c && cardFaceText(addCard28c).indexOf('0.00900003 BTC') !== -1,
    addCard28c ? cardFaceText(addCard28c) : 'no card');
  const addItems28c = addCard28c ? addCard28c.children.filter((c) => (c.className || '').split(' ').includes('tx-item')) : [];
  check('add trigger set: two blue-edged transaction subcards', addItems28c.length === 2, 'got ' + addItems28c.length);
  check('add trigger set: each tx subcard holds its own Details',
    addItems28c.length === 2 && addItems28c.every((it) => !!it.children.find((x) => x.className === 'tx-details')), '');
  check('add trigger set: one orange trigger subcard below them, holding no Details',
    !!addCard28c && triggerBoxes(addCard28c).length === 1 && !detailsInTriggerBox(addCard28c),
    addCard28c ? 'boxes=' + triggerBoxes(addCard28c).length : 'no card');
  // (0.8.7 fix, round 5) The set modal's Edit can add a
  // transaction: its Transactions section lists the members
  // and "+ Add transaction" appends a blank entry (numbered
  // after the members) with its own import button. Cancel
  // closes without saving anything.
  const editBtn28c = addCard28c ? cardButton(addCard28c, 'Edit') : null;
  if (editBtn28c) editBtn28c.click();
  check('add trigger set: Edit opens the set modal',
    els['set-modal'] && els['set-modal'].classList.contains('open'), '');
  check('add trigger set: the set modal lists the two members',
    els['set-members-list'] && els['set-members-list'].children.length === 2,
    els['set-members-list'] ? 'children=' + els['set-members-list'].children.length : 'no list');
  els['btn-set-add-tx'].click();
  check('add trigger set: "+ Add transaction" appends a blank entry in the set modal',
    els['set-new-txs-list'] && els['set-new-txs-list'].children.length === 1,
    els['set-new-txs-list'] ? 'children=' + els['set-new-txs-list'].children.length : 'no list');
  check('add trigger set: the set-modal entry is numbered Transaction 3 (after the two members)',
    els['set-new-txs-list'] && els['set-new-txs-list'].children.length === 1
    && entryTitle28c(els['set-new-txs-list'].children[0]) === 'Transaction 3', '');
  check('add trigger set: the set-modal entry has its own import button',
    els['set-new-txs-list'] && els['set-new-txs-list'].children.length === 1
    && !!entryField28c(els['set-new-txs-list'].children[0], 'set-new-tx-import'), '');
  els['btn-set-cancel'].click();
  check('add trigger set: cancelling the set edit closes the modal',
    els['set-modal'] && !els['set-modal'].classList.contains('open'), '');
  const st28c = await (await fetch('/api/state')).json();
  const set28c = (st28c.bitcoin.sets || []).find((x) => x.label === 'Dom Add Set');
  const mem28c = set28c ? (st28c.bitcoin.txs || []).filter((t) => set28c.txIds.indexOf(t.id) !== -1) : [];
  check('add trigger set: the set serves both members',
    !!set28c && set28c.txIds.length === 2 && mem28c.length === 2, set28c ? set28c.txIds.join(',') : 'no set');
  check('add trigger set: the new txs carry the shared 35-day check-in trigger',
    mem28c.length === 2 && mem28c.every((t) => t.trigger
      && t.trigger.type === 'checkin' && t.trigger.params && t.trigger.params.thresholdDays === 35),
    JSON.stringify(mem28c.map((t) => t.trigger)));
  // The members carry no label of their own — the set's label
  // is the card's label.
  check('add trigger set: the members carry no per-tx label',
    mem28c.length === 2 && mem28c.every((t) => !t.label), JSON.stringify(mem28c.map((t) => t.label)));
  const m2tx28c = mem28c.find((t) => (t.notes || '') === 'M2 note');
  const m2prefix28c = m2tx28c ? m2tx28c.txid.slice(0, 16) : null;
  if (set28c) {
    const delAddSet = await fetch('/api/bitcoin/sets/' + set28c.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('add trigger set: the set deletes', delAddSet.status === 200, 'status=' + delAddSet.status);
  }
  await rerender(appJs);
  // A freed member is a set of one: the same card shape, with
  // its own blue tx subcard (Details inside it) above its
  // orange trigger subcard — no .tx-single, no Details inside
  // a trigger box.
  const solo28c = m2prefix28c ? listCards('btc-active-list').find((c) => cardFaceText(c).indexOf(m2prefix28c) !== -1) : null;
  check('add trigger set: the freed member renders standalone again', !!solo28c, '');
  check('add trigger set: the standalone card is titled with its short txid (no per-tx label, never "Untitled transaction")',
    !!solo28c && cardTitle(solo28c) === m2prefix28c + '…', solo28c ? cardTitle(solo28c) : 'no card');
  check('add trigger set: a standalone card carries NO .tx-single class any more',
    !!solo28c && !(solo28c.className || '').split(' ').includes('tx-single'), solo28c ? solo28c.className : 'no card');
  const soloItems28c = solo28c ? solo28c.children.filter((c) => (c.className || '').split(' ').includes('tx-item')) : [];
  check('add trigger set: the standalone card has ONE blue tx subcard', soloItems28c.length === 1, 'got ' + soloItems28c.length);
  check('add trigger set: the standalone Details lives inside its tx subcard',
    soloItems28c.length === 1 && !!txItemDetails(solo28c), '');
  check('add trigger set: the standalone trigger subcard holds no Details',
    !!solo28c && triggerBoxes(solo28c).length === 1 && !detailsInTriggerBox(solo28c), '');
  // Editing the standalone tx opens the set-shaped edit: its
  // own fields (notes, hex) in the Transactions section, its
  // own rules in the Triggers section.
  const soloEdit28c = solo28c && cardButton(solo28c, 'Edit');
  check('add trigger set: the standalone card has an Edit button', !!soloEdit28c, '');
  if (soloEdit28c) soloEdit28c.click();
  check('add trigger set: opening Edit on the standalone tx opens the modal',
    els['edit-modal'] && els['edit-modal'].classList.contains('open'), '');
  check('add trigger set: the edit form shows the tx\'s own notes',
    els['edit-notes'] && els['edit-notes'].value === 'M2 note', els['edit-notes'] && els['edit-notes'].value);
  check('add trigger set: the edit form shows the tx\'s own check-in rule (35 days)',
    !!panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value === 'checkin'
    && !!findById(rulePanels('edit')[0], 'edit-rule-0-threshold') && findById(rulePanels('edit')[0], 'edit-rule-0-threshold').value === '35',
    'trigger=' + (panelTypeSelect(rulePanels('edit')[0]) && panelTypeSelect(rulePanels('edit')[0]).value));
  els['btn-edit-cancel'].click();
  check('add trigger set: cancelling the edit closes the modal',
    els['edit-modal'] && !els['edit-modal'].classList.contains('open'), '');

  // --- §28d (0.8.7 fix, round 6): one construct — the
  // single-transaction edit can add transactions (promoting
  // the card to a set), and both edit modals can remove
  // members, never the last one. Same Transactions section
  // (member list + add + remove + import) above the same
  // Triggers section, same wording — no "single" vs "set".
  check('one construct: the edit modal is titled "Edit trigger set" (static HTML)',
    idx.indexOf('id="edit-form-title">Edit trigger set<') !== -1, '');
  check('one construct: no "Edit transaction" wording left in the page (static HTML)',
    idx.indexOf('Edit transaction') === -1, '');
  check('one construct: the edit modal has a member list, a new-entry list and an Add button (static HTML)',
    idx.indexOf('id="edit-members-list"') !== -1 && idx.indexOf('id="edit-new-txs-list"') !== -1
    && idx.indexOf('id="btn-edit-add-tx"') !== -1, '');
  check('one construct: the edit modal\'s import button lives inside the member entry (static HTML)',
    idx.indexOf('id="edit-members-list"') < idx.indexOf('id="btn-edit-import-file"')
    && idx.indexOf('id="btn-edit-import-file"') < idx.indexOf('id="edit-new-txs-list"'), '');
  check('one construct: the edit modal\'s rules cap note says "per trigger set" (static HTML)',
    idx.indexOf('id="edit-rules-cap-note" class="muted" style="display:none">Maximum 5 rules per trigger set.') !== -1, '');
  check('one construct: the set modal\'s save button says "Save changes" (static HTML)',
    idx.indexOf('id="btn-set-save" class="primary">Save changes<') !== -1, '');
  const solo28d = m2prefix28c ? listCards('btc-active-list').find((c) => cardTitle(c) === m2prefix28c + '…') : null;
  check('one construct: the standalone card is still there to edit', !!solo28d, '');
  const soloEdit28d = solo28d && cardButton(solo28d, 'Edit');
  if (soloEdit28d) soloEdit28d.click();
  check('one construct: opening Edit on the standalone tx opens the modal',
    els['edit-modal'] && els['edit-modal'].classList.contains('open'), '');
  check('one construct: the edit modal is titled "Edit trigger set"',
    els['edit-form-title'] && els['edit-form-title'].textContent === 'Edit trigger set',
    els['edit-form-title'] && els['edit-form-title'].textContent);
  check('one construct: the original transaction\'s remove is disabled while it is the only member',
    els['btn-edit-remove-tx'] && els['btn-edit-remove-tx'].disabled === true, '');
  els['btn-edit-add-tx'].click();
  check('one construct: "+ Add transaction" appends a blank entry in the edit modal',
    els['edit-new-txs-list'] && els['edit-new-txs-list'].children.length === 1,
    els['edit-new-txs-list'] ? 'children=' + els['edit-new-txs-list'].children.length : 'no list');
  check('one construct: the edit-modal entry is numbered Transaction 2 (after the original)',
    els['edit-new-txs-list'] && els['edit-new-txs-list'].children.length === 1
    && entryTitle28c(els['edit-new-txs-list'].children[0]) === 'Transaction 2', '');
  check('one construct: the edit-modal entry has its own import button',
    els['edit-new-txs-list'] && els['edit-new-txs-list'].children.length === 1
    && !!entryField28c(els['edit-new-txs-list'].children[0], 'edit-new-tx-import'), '');
  // Removing a blank entry is always free.
  entryRemove28c(els['edit-new-txs-list'].children[0]).click();
  check('one construct: removing a blank entry drops it',
    els['edit-new-txs-list'] && els['edit-new-txs-list'].children.length === 0, '');
  els['btn-edit-add-tx'].click();
  const entry28d = els['edit-new-txs-list'].children[0];
  entryField28c(entry28d, 'edit-new-tx-notes').value = 'M3 note';
  entryField28c(entry28d, 'edit-new-tx-hex').value = craftHex(5, 140001);
  entryField28c(entry28d, 'edit-new-tx-hex').fire('input');
  check('one construct: once a second transaction exists, the original\'s remove is enabled',
    els['btn-edit-remove-tx'] && els['btn-edit-remove-tx'].disabled === false, '');
  els['btn-edit-save'].click();
  await waitForRender();
  check('one construct: the popup closes on save',
    els['edit-modal'] && !els['edit-modal'].classList.contains('open'), '');
  check('one construct: the confirmation says the card is now a trigger set',
    els['btc-msg'] && els['btc-msg'].textContent.indexOf('this is now a trigger set') !== -1,
    els['btc-msg'] && els['btc-msg'].textContent);
  const st28d = await (await fetch('/api/state')).json();
  const m2tx28d = (st28d.bitcoin.txs || []).find((t) => (t.notes || '') === 'M2 note');
  const m3tx28d = (st28d.bitcoin.txs || []).find((t) => (t.notes || '') === 'M3 note');
  const set28d = (st28d.bitcoin.sets || []).find((x) => x.txIds && m2tx28d && x.txIds.indexOf(m2tx28d.id) !== -1);
  check('one construct: saving promoted the card to a set holding both transactions',
    !!set28d && !!m2tx28d && !!m3tx28d && set28d.txIds.length === 2
    && set28d.txIds.indexOf(m3tx28d.id) !== -1,
    set28d ? set28d.txIds.join(',') : 'no set');
  check('one construct: the new transaction carries the shared 35-day check-in trigger',
    !!m3tx28d && m3tx28d.trigger && m3tx28d.trigger.type === 'checkin'
    && m3tx28d.trigger.params && m3tx28d.trigger.params.thresholdDays === 35,
    m3tx28d ? JSON.stringify(m3tx28d.trigger) : 'no tx');
  check('one construct: the original transaction keeps its own trigger as the dormant fallback',
    !!m2tx28d && m2tx28d.trigger && m2tx28d.trigger.type === 'checkin'
    && m2tx28d.trigger.params && m2tx28d.trigger.params.thresholdDays === 35,
    m2tx28d ? JSON.stringify(m2tx28d.trigger) : 'no tx');
  await rerender(appJs);
  const promo28d = set28d ? listCards('btc-active-list').find((c) => cardTitle(c) === 'Untitled set') : null;
  check('one construct: the promoted card renders as a set card', !!promo28d, '');
  check('one construct: the promoted card shows the summed total (0.00590003 BTC)',
    !!promo28d && cardFaceText(promo28d).indexOf('0.00590003 BTC') !== -1,
    promo28d ? cardFaceText(promo28d) : 'no card');
  const promoItems28d = promo28d ? promo28d.children.filter((c) => (c.className || '').split(' ').includes('tx-item')) : [];
  check('one construct: the promoted card has two blue tx subcards', promoItems28d.length === 2, 'got ' + promoItems28d.length);
  check('one construct: the promoted card says "2 transactions · 1 shared trigger"',
    !!promo28d && cardFaceText(promo28d).indexOf('2 transactions · 1 shared trigger') !== -1,
    promo28d ? cardFaceText(promo28d) : 'no card');
  // Removing a member from the set: the set keeps the rest,
  // the removed transaction returns to standalone.
  const promoEdit28d = promo28d && cardButton(promo28d, 'Edit');
  if (promoEdit28d) promoEdit28d.click();
  check('one construct: Edit opens the set modal on the promoted card',
    els['set-modal'] && els['set-modal'].classList.contains('open'), '');
  check('one construct: the set modal lists the two members',
    els['set-members-list'] && els['set-members-list'].children.length === 2,
    els['set-members-list'] ? 'children=' + els['set-members-list'].children.length : 'no list');
  const memberRemove28d = (line) => {
    let found = null;
    (line.children || []).forEach((c) => { if ((c.className || '').split(' ').indexOf('set-member-remove') !== -1) found = c; });
    return found;
  };
  const firstLine28d = els['set-members-list'] ? els['set-members-list'].children[0] : null;
  if (firstLine28d && memberRemove28d(firstLine28d)) memberRemove28d(firstLine28d).click();
  check('one construct: removing a member drops its line and renumbers',
    els['set-members-list'] && els['set-members-list'].children.length === 1,
    els['set-members-list'] ? 'children=' + els['set-members-list'].children.length : 'no list');
  els['btn-set-save'].click();
  await waitForRender();
  check('one construct: the set edit closes on save',
    els['set-modal'] && !els['set-modal'].classList.contains('open'), '');
  check('one construct: the confirmation names the removed transaction',
    els['btc-msg'] && els['btc-msg'].textContent.indexOf('Removed 1 transaction') !== -1,
    els['btc-msg'] && els['btc-msg'].textContent);
  const st28d2 = await (await fetch('/api/state')).json();
  const set28d2 = set28d ? (st28d2.bitcoin.sets || []).find((x) => x.id === set28d.id) : null;
  const m2after28d = (st28d2.bitcoin.txs || []).find((t) => (t.notes || '') === 'M2 note');
  check('one construct: the set keeps one member after the removal',
    !!set28d2 && set28d2.txIds.length === 1 && set28d2.txIds[0] === (m3tx28d && m3tx28d.id),
    set28d2 ? set28d2.txIds.join(',') : 'no set');
  check('one construct: the removed transaction is standalone again (in no set)',
    !!m2after28d && !(st28d2.bitcoin.sets || []).some((x) => (x.txIds || []).indexOf(m2after28d.id) !== -1), '');
  await rerender(appJs);
  // The last-member guard: with one member left, its remove
  // is disabled, and clicking it anyway leaves the set
  // untouched with a message.
  const one28d = listCards('btc-active-list').find((c) => cardTitle(c) === 'Untitled set');
  const oneEdit28d = one28d && cardButton(one28d, 'Edit');
  if (oneEdit28d) oneEdit28d.click();
  check('one construct: the one-member set modal lists one member',
    els['set-members-list'] && els['set-members-list'].children.length === 1, '');
  const lastLine28d = els['set-members-list'] && els['set-members-list'].children[0];
  const lastRm28d = lastLine28d ? memberRemove28d(lastLine28d) : null;
  check('one construct: the last member\'s remove is disabled',
    !!lastRm28d && lastRm28d.disabled === true, '');
  if (lastRm28d) lastRm28d.click();
  check('one construct: clicking the last member\'s remove is refused with a message',
    els['set-msg'] && els['set-msg'].textContent.indexOf('last transaction') !== -1
    && els['set-members-list'].children.length === 1,
    els['set-msg'] && els['set-msg'].textContent);
  els['btn-set-cancel'].click();
  check('one construct: cancelling the set edit closes the modal',
    els['set-modal'] && !els['set-modal'].classList.contains('open'), '');
  const st28c2 = await (await fetch('/api/state')).json();
  const gone28c = (st28c2.bitcoin.txs || []).filter((t) => (t.notes || '') === 'M1 note' || (t.notes || '') === 'M2 note' || (t.notes || '') === 'M3 note');
  // (§28d) The promoted set still holds M3 — delete the set
  // first (its members return to standalone), then the txs.
  for (const s of (st28c2.bitcoin.sets || [])) {
    if ((s.txIds || []).some((id) => gone28c.some((t) => t.id === id))) {
      const delSet28c = await fetch('/api/bitcoin/sets/' + s.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      check('add trigger set: fixture set removed', delSet28c.status === 200, 'status=' + delSet28c.status);
    }
  }
  for (const t of gone28c) {
    const del28c = await fetch('/api/bitcoin/txs/' + t.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('add trigger set: fixture tx removed', del28c.status === 200, 'status=' + del28c.status);
  }
  await rerender(appJs);

  // --- §28e (0.8.7 fix, round 10): release readiness, one
  // card per trigger set — the owner's case. The members were
  // created inside the set, so they carry NO label of their
  // own: before this fix the second one showed up on the
  // Dashboard as "Untitled transaction" with an Unknown pill
  // from its frozen triggerState, and the set itself got no
  // row at all. The cadence is still 10s here (the restore
  // block below puts it back to 60), so an 11s sleep opens
  // the tick's server-refresh gate.
  check('readiness set: no "Untitled transaction" row before the fixtures',
    !(readinessBlocks() || []).some((b) => b.label === 'Untitled transaction'),
    (readinessBlocks() || []).map((b) => b.label).join(','));
  const addRdyM1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(4, 440006), trigger: { type: 'manual', params: {} } }) });
  check('readiness set: label-less member 1 adds', addRdyM1.status === 201, 'status=' + addRdyM1.status);
  const addRdyM1Json = addRdyM1.status === 201 ? await addRdyM1.json() : {};
  const rdyM1Id = (addRdyM1Json.tx || {}).id || null;
  const addRdyM2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(5, 440007), trigger: { type: 'manual', params: {} } }) });
  check('readiness set: label-less member 2 adds', addRdyM2.status === 201, 'status=' + addRdyM2.status);
  const addRdyM2Json = addRdyM2.status === 201 ? await addRdyM2.json() : {};
  const rdyM2Id = (addRdyM2Json.tx || {}).id || null;
  const addRdySet = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Ready Set', txIds: [rdyM1Id, rdyM2Id], trigger: { type: 'setdate', params: { fireAt: '2999-01-01T00:00:00.000Z' } } }) });
  check('readiness set: the set creates', addRdySet.status === 201, 'status=' + addRdySet.status);
  const addRdySetJson = addRdySet.status === 201 ? await addRdySet.json() : {};
  const rdySetId = (addRdySetJson.set || {}).id || null;
  await rerender(appJs);
  const rbReady = readinessBlock('Dom Ready Set');
  check('readiness set: ONE row headed by the set label', !!rbReady, (readinessBlocks() || []).map((b) => b.label).join(','));
  check('readiness set: the row pill reads armed (the set card pill)',
    !!rbReady && rbReady.status === 'armed', rbReady ? rbReady.status : 'no block');
  check('readiness set: the row state line is the set condition ("Fires on Dec 31, 2998, 7:00 PM")',
    !!rbReady && rbReady.state.indexOf('Fires on Dec 31, 2998, 7:00 PM') !== -1, rbReady ? rbReady.state : 'no block');
  check('readiness set: the row carries NO fee pill',
    !!rbReady && rbReady.fee === '', rbReady ? 'fee=' + rbReady.fee : 'no block');
  check('readiness set: NO "Untitled transaction" row for the label-less members',
    !(readinessBlocks() || []).some((b) => b.label === 'Untitled transaction'),
    (readinessBlocks() || []).map((b) => b.label).join(','));
  // The live tick patches the set row's pill in place: disarm
  // the set behind an open modal, so the changed signature
  // takes the values-only patch path instead of a re-render.
  const rdyRowEl = (els['readiness-txs'].children || []).find((c) => c.dataset && c.dataset.setId === rdySetId);
  check('readiness set: the set row element exists', !!rdyRowEl, '');
  els['btn-btc-add-pill'].click();
  check('readiness set: the Add modal opens (structural changes defer to the patch)',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  const disRdy = await fetch('/api/bitcoin/sets/' + rdySetId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('readiness set: the set disarms', disRdy.status === 200, 'status=' + disRdy.status);
  await sleep26(11000);
  const tickRdy = liveTickFn();
  check('readiness set: the app registers a 1-second live timer', !!tickRdy, '');
  if (tickRdy) await tickRdy();
  check('readiness set: the tick patches the set row in place (same element, no rebuild)',
    !!rdyRowEl && (els['readiness-txs'].children || []).indexOf(rdyRowEl) !== -1, '');
  const rbReadyAfter = readinessBlock('Dom Ready Set');
  check('readiness set: after the tick the set row pill reads unarmed',
    !!rbReadyAfter && rbReadyAfter.status === 'unarmed', rbReadyAfter ? rbReadyAfter.status : 'no block');
  check('readiness set: still exactly ONE row for the set after the tick (no member row resurrected)',
    (readinessBlocks() || []).filter((b) => b.label === 'Dom Ready Set').length === 1
    && !(readinessBlocks() || []).some((b) => b.label === 'Untitled transaction'),
    (readinessBlocks() || []).map((b) => b.label).join(','));
  els['add-modal-x'].click();
  check('readiness set: the Add modal closes',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  if (rdySetId) {
    const delRdySet = await fetch('/api/bitcoin/sets/' + rdySetId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness set: the set deletes', delRdySet.status === 200, 'status=' + delRdySet.status);
  }
  for (const id of [rdyM1Id, rdyM2Id]) {
    if (!id) continue;
    const delRdy = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness set: fixture tx removed', delRdy.status === 200, 'status=' + delRdy.status);
  }
  await rerender(appJs);
  check('readiness set: the set row is gone after the delete', !readinessBlock('Dom Ready Set'), '');

  // --- §28f (0.8.7 fix, round 12): release readiness lists
  // each member tx under its set's main label as "Tx N —
  // <first 16 of the txid>… <amount> BTC", amount right-aligned,
  // pill only on the set header. Two label-less members with
  // distinct amounts (0.001 / 0.0025 BTC), grouped into 'Dom
  // Ready Members', plus a standalone 'Dom Ready Solo' (0.0005
  // BTC) that keeps its own single row. The cadence is still
  // 10s here (the restore block below puts it back to 60), so
  // an 11s sleep opens the tick's server-refresh gate, as in
  // §28e.
  const addRdyM1f = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(6, 100000), trigger: { type: 'manual', params: {} } }) });
  check('readiness members: label-less member 1 adds', addRdyM1f.status === 201, 'status=' + addRdyM1f.status);
  const addRdyM1fJson = addRdyM1f.status === 201 ? await addRdyM1f.json() : {};
  const rdyM1fId = (addRdyM1fJson.tx || {}).id || null;
  const addRdyM2f = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(7, 250000), trigger: { type: 'manual', params: {} } }) });
  check('readiness members: label-less member 2 adds', addRdyM2f.status === 201, 'status=' + addRdyM2f.status);
  const addRdyM2fJson = addRdyM2f.status === 201 ? await addRdyM2f.json() : {};
  const rdyM2fId = (addRdyM2fJson.tx || {}).id || null;
  // The members' txids, from the state — the expected member
  // lines are built from these, not from a re-derived hash.
  const stRdyF = await (await fetch('/api/state')).json();
  const rdyTx1f = (stRdyF.bitcoin.txs || []).find((t) => t.id === rdyM1fId) || {};
  const rdyTx2f = (stRdyF.bitcoin.txs || []).find((t) => t.id === rdyM2fId) || {};
  const rdyShort1 = (rdyTx1f.txid || '').slice(0, 16);
  const rdyShort2 = (rdyTx2f.txid || '').slice(0, 16);
  check('readiness members: member 1 has a txid to shorten', rdyShort1.length === 16, rdyShort1);
  check('readiness members: member 2 has a txid to shorten', rdyShort2.length === 16, rdyShort2);
  const addRdySolo = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(8, 50000), label: 'Dom Ready Solo', trigger: { type: 'manual', params: {} } }) });
  check('readiness members: the standalone tx adds', addRdySolo.status === 201, 'status=' + addRdySolo.status);
  const addRdySoloJson = addRdySolo.status === 201 ? await addRdySolo.json() : {};
  const rdySoloId = (addRdySoloJson.tx || {}).id || null;
  const addRdySetF = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Ready Members', txIds: [rdyM1fId, rdyM2fId], trigger: { type: 'setdate', params: { fireAt: '2999-01-01T00:00:00.000Z' } } }) });
  check('readiness members: the set creates', addRdySetF.status === 201, 'status=' + addRdySetF.status);
  const addRdySetFJson = addRdySetF.status === 201 ? await addRdySetF.json() : {};
  const rdySetFId = (addRdySetFJson.set || {}).id || null;
  await rerender(appJs);
  const rbMembers = readinessBlock('Dom Ready Members');
  check('readiness members: ONE header headed by the set label', !!rbMembers, (readinessBlocks() || []).map((b) => b.label).join(','));
  check('readiness members: the header pill reads armed',
    !!rbMembers && rbMembers.status === 'armed', rbMembers ? rbMembers.status : 'no block');
  check('readiness members: the header state line is the set condition ("Fires on Dec 31, 2998, 7:00 PM")',
    !!rbMembers && rbMembers.state.indexOf('Fires on Dec 31, 2998, 7:00 PM') !== -1, rbMembers ? rbMembers.state : 'no block');
  check('readiness members: the header carries NO fee pill',
    !!rbMembers && rbMembers.fee === '', rbMembers ? 'fee=' + rbMembers.fee : 'no block');
  const rdyLines = readinessMembers('Dom Ready Members');
  check('readiness members: exactly 2 member lines under the header',
    !!rdyLines && rdyLines.length === 2, rdyLines ? 'got ' + rdyLines.length : 'no lines');
  check('readiness members: member 1 line reads "Tx 1 — <first 16 of txid>…"',
    !!rdyLines && rdyLines[0].left === 'Tx 1 \u2014 ' + rdyShort1 + '\u2026', rdyLines ? rdyLines[0].left : 'no lines');
  check('readiness members: member 1 line reads its amount (0.001 BTC)',
    !!rdyLines && rdyLines[0].amt === '0.001 BTC', rdyLines ? rdyLines[0].amt : 'no lines');
  check('readiness members: member 2 line reads "Tx 2 — <first 16 of txid>…"',
    !!rdyLines && rdyLines[1].left === 'Tx 2 \u2014 ' + rdyShort2 + '\u2026', rdyLines ? rdyLines[1].left : 'no lines');
  check('readiness members: member 2 line reads its amount (0.0025 BTC)',
    !!rdyLines && rdyLines[1].amt === '0.0025 BTC', rdyLines ? rdyLines[1].amt : 'no lines');
  check('readiness members: member lines are label span + amount span (exactly 2 children each)',
    !!rdyLines && rdyLines.every((l) => l.kids === 2), rdyLines ? rdyLines.map((l) => l.kids).join(',') : 'no lines');
  check('readiness members: member lines carry NO pill at all',
    !!rdyLines && rdyLines.every((l) => !l.hasPill), rdyLines ? rdyLines.map((l) => l.hasPill).join(',') : 'no lines');
  check('readiness members: the left span is the label class, the right span the amount class',
    !!rdyLines && rdyLines.every((l) => l.leftCls === 'readiness-tx-member-label' && l.amtCls === 'readiness-tx-member-amt'),
    rdyLines ? rdyLines.map((l) => l.leftCls + '/' + l.amtCls).join(',') : 'no lines');
  // Right alignment is a CSS fact, not a DOM one: the amount
  // span is pinned to the right edge by flex-shrink: 0 after
  // the label span takes the free space (flex: 1 1 auto).
  const cssRdyF = await realFetch(BASE + '/style.css').then((r) => r.text());
  check('readiness members: the amount span is pinned right (flex-shrink: 0 in its CSS rule)',
    /\.readiness-tx-member-amt\s*\{[^}]*flex-shrink:\s*0/.test(cssRdyF), '');
  check('readiness members: the label span takes the free space (flex: 1 1 auto in its CSS rule)',
    /\.readiness-tx-member-label\s*\{[^}]*flex:\s*1 1 auto/.test(cssRdyF), '');
  check('readiness members: NO "Untitled" text anywhere in the readiness list',
    !((readinessBlocks() || []).map((b) => b.label + ' ' + b.state).join(' ')
      + ' ' + ((rdyLines || []).map((l) => l.left + ' ' + l.amt).join(' '))).includes('Untitled'),
    (readinessBlocks() || []).map((b) => b.label).join(','));
  const rbSolo = readinessBlock('Dom Ready Solo');
  check('readiness members: the standalone tx keeps its own single row',
    !!rbSolo && rbSolo.status === 'armed', rbSolo ? rbSolo.status : 'no block');
  // The live tick patches the header in place and keeps the
  // member lines' text in step: disarm the set behind an open
  // modal, so the changed signature takes the values-only
  // patch path instead of a re-render.
  const rdyFRowEl = (els['readiness-txs'].children || []).find((c) => c.dataset && c.dataset.setId === rdySetFId);
  check('readiness members: the set row element exists', !!rdyFRowEl, '');
  const rdyFLineEls = (rdyFRowEl ? rdyFRowEl.children : []).filter((c) => (c.className || '').split(' ').includes('readiness-tx-member'));
  check('readiness members: the two member line elements exist',
    rdyFLineEls.length === 2, 'got ' + rdyFLineEls.length);
  els['btn-btc-add-pill'].click();
  check('readiness members: the Add modal opens (structural changes defer to the patch)',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  const disRdyF = await fetch('/api/bitcoin/sets/' + rdySetFId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('readiness members: the set disarms', disRdyF.status === 200, 'status=' + disRdyF.status);
  await sleep26(11000);
  const tickRdyF = liveTickFn();
  check('readiness members: the app registers a 1-second live timer', !!tickRdyF, '');
  if (tickRdyF) await tickRdyF();
  check('readiness members: the tick patches the set row in place (same element, no rebuild)',
    !!rdyFRowEl && (els['readiness-txs'].children || []).indexOf(rdyFRowEl) !== -1, '');
  const rbMembersAfter = readinessBlock('Dom Ready Members');
  check('readiness members: after the tick the header pill reads unarmed',
    !!rbMembersAfter && rbMembersAfter.status === 'unarmed', rbMembersAfter ? rbMembersAfter.status : 'no block');
  const rdyLinesAfter = readinessMembers('Dom Ready Members');
  check('readiness members: after the tick the member lines are the SAME elements (patched, not rebuilt)',
    !!rdyLinesAfter && rdyLinesAfter.length === 2
    && (rdyFRowEl.children || []).filter((c) => (c.className || '').split(' ').includes('readiness-tx-member')).every((c, i) => c === rdyFLineEls[i]),
    rdyLinesAfter ? 'got ' + rdyLinesAfter.length : 'no lines');
  check('readiness members: after the tick member 1 line text is unchanged',
    !!rdyLinesAfter && rdyLinesAfter[0].left === 'Tx 1 \u2014 ' + rdyShort1 + '\u2026' && rdyLinesAfter[0].amt === '0.001 BTC',
    rdyLinesAfter ? rdyLinesAfter[0].left + ' / ' + rdyLinesAfter[0].amt : 'no lines');
  check('readiness members: after the tick member 2 line text is unchanged',
    !!rdyLinesAfter && rdyLinesAfter[1].left === 'Tx 2 \u2014 ' + rdyShort2 + '\u2026' && rdyLinesAfter[1].amt === '0.0025 BTC',
    rdyLinesAfter ? rdyLinesAfter[1].left + ' / ' + rdyLinesAfter[1].amt : 'no lines');
  check('readiness members: after the tick member lines still carry NO pill',
    !!rdyLinesAfter && rdyLinesAfter.every((l) => !l.hasPill), rdyLinesAfter ? rdyLinesAfter.map((l) => l.hasPill).join(',') : 'no lines');
  check('readiness members: after the tick still exactly 2 member lines (none duplicated, none resurrected)',
    !!rdyLinesAfter && rdyLinesAfter.length === 2, rdyLinesAfter ? 'got ' + rdyLinesAfter.length : 'no lines');
  els['add-modal-x'].click();
  check('readiness members: the Add modal closes',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  if (rdySetFId) {
    const delRdySetF = await fetch('/api/bitcoin/sets/' + rdySetFId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness members: the set deletes', delRdySetF.status === 200, 'status=' + delRdySetF.status);
  }
  for (const id of [rdyM1fId, rdyM2fId, rdySoloId]) {
    if (!id) continue;
    const delRdyF = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness members: fixture tx removed', delRdyF.status === 200, 'status=' + delRdyF.status);
  }
  await rerender(appJs);
  check('readiness members: the set row is gone after the delete', !readinessBlock('Dom Ready Members'), '');
  // A set whose members are ALL stale gets no readiness card
  // at all (round 10 behavior): both members spend FINNEY:0,
  // confirmed spent, so a set dry-run marks them both stale —
  // no trigger is evaluated, so nothing can fire here.
  const addStaleR1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(0, 440008), trigger: { type: 'manual', params: {} } }) });
  check('readiness members: all-stale member 1 adds (FINNEY:0)', addStaleR1.status === 201, 'status=' + addStaleR1.status);
  const addStaleR1Json = addStaleR1.status === 201 ? await addStaleR1.json() : {};
  const staleR1Id = (addStaleR1Json.tx || {}).id || null;
  const addStaleR2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(0, 440009), trigger: { type: 'manual', params: {} } }) });
  check('readiness members: all-stale member 2 adds (FINNEY:0)', addStaleR2.status === 201, 'status=' + addStaleR2.status);
  const addStaleR2Json = addStaleR2.status === 201 ? await addStaleR2.json() : {};
  const staleR2Id = (addStaleR2Json.tx || {}).id || null;
  const addStaleRSet = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Ready Stale Set', txIds: [staleR1Id, staleR2Id], trigger: { type: 'setdate', params: { fireAt: '2999-01-01T00:00:00.000Z' } } }) });
  check('readiness members: the all-stale set creates', addStaleRSet.status === 201, 'status=' + addStaleRSet.status);
  const addStaleRSetJson = addStaleRSet.status === 201 ? await addStaleRSet.json() : {};
  const staleRSetId = (addStaleRSetJson.set || {}).id || null;
  const dryStaleR = await fetch('/api/broadcast/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setId: staleRSetId }) });
  check('readiness members: the all-stale set dry-run runs', dryStaleR.status === 200, 'status=' + dryStaleR.status);
  await rerender(appJs);
  check('readiness members: NO readiness card for the all-stale set',
    !readinessBlock('Dom Ready Stale Set'), (readinessBlocks() || []).map((b) => b.label).join(','));
  if (staleRSetId) {
    const delStaleRSet = await fetch('/api/bitcoin/sets/' + staleRSetId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness members: the all-stale set deletes', delStaleRSet.status === 200, 'status=' + delStaleRSet.status);
  }
  for (const id of [staleR1Id, staleR2Id]) {
    if (!id) continue;
    const delStaleR = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('readiness members: all-stale fixture tx removed', delStaleR.status === 200, 'status=' + delStaleR.status);
  }
  await rerender(appJs);

  // --- §28g (0.8.7 fix, round 13): warnings name a set member
  // as '"<set label>" - Tx #', never "Untitled transaction".
  // Two label-less members + one labeled standalone, all
  // spending FINNEY:9 (a fresh vout — the seeded txs share
  // FINNEY:1), grouped into 'Dom Warn Set'. The cadence is
  // still 10s here (the restore block below puts it back to
  // 60), so an 11s sleep opens the tick's server-refresh gate,
  // as in §28e/§28f.
  const addWarnM1 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(9, 100000), trigger: { type: 'manual', params: {} } }) });
  check('warnings name members: label-less member 1 adds', addWarnM1.status === 201, 'status=' + addWarnM1.status);
  const addWarnM1Json = addWarnM1.status === 201 ? await addWarnM1.json() : {};
  const warnM1Id = (addWarnM1Json.tx || {}).id || null;
  const addWarnM2 = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(9, 250000), trigger: { type: 'manual', params: {} } }) });
  check('warnings name members: label-less member 2 adds', addWarnM2.status === 201, 'status=' + addWarnM2.status);
  const addWarnM2Json = addWarnM2.status === 201 ? await addWarnM2.json() : {};
  const warnM2Id = (addWarnM2Json.tx || {}).id || null;
  const addWarnSolo = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(9, 50000), label: 'Dom Warn Solo', trigger: { type: 'manual', params: {} } }) });
  check('warnings name members: the standalone sharing the input adds', addWarnSolo.status === 201, 'status=' + addWarnSolo.status);
  const addWarnSoloJson = addWarnSolo.status === 201 ? await addWarnSolo.json() : {};
  const warnSoloId = (addWarnSoloJson.tx || {}).id || null;
  const addWarnSet = await fetch('/api/bitcoin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dom Warn Set', txIds: [warnM1Id, warnM2Id], trigger: { type: 'manual', params: {} } }) });
  check('warnings name members: the set creates', addWarnSet.status === 201, 'status=' + addWarnSet.status);
  const addWarnSetJson = addWarnSet.status === 201 ? await addWarnSet.json() : {};
  const warnSetId = (addWarnSetJson.set || {}).id || null;
  await rerender(appJs);
  const warnSetCard = cardByTitle('Dom Warn Set');
  const warnSetLines = warnLines(warnSetCard);
  check('warnings name members: the set card carries 2 warning lines (one per member subcard)',
    !!warnSetLines && warnSetLines.length === 2, warnSetLines ? 'got ' + warnSetLines.length : 'no lines');
  check('warnings name members: member 1 names the other member as "Dom Warn Set" - Tx 2',
    !!warnSetLines && warnSetLines[0].text === 'Warning: shares input f4184fc59640:9 with "Dom Warn Set" - Tx 2, "Dom Warn Solo" — only one of them can ever be confirmed.',
    warnSetLines ? warnSetLines[0].text : 'no lines');
  check('warnings name members: member 2 names the other member as "Dom Warn Set" - Tx 1',
    !!warnSetLines && warnSetLines[1].text === 'Warning: shares input f4184fc59640:9 with "Dom Warn Set" - Tx 1, "Dom Warn Solo" — only one of them can ever be confirmed.',
    warnSetLines ? warnSetLines[1].text : 'no lines');
  const warnSoloCard = cardByTitle('Dom Warn Solo');
  const warnSoloLines = warnLines(warnSoloCard);
  check('warnings name members: the standalone names both members by set + number',
    !!warnSoloLines && warnSoloLines.length === 1
    && warnSoloLines[0].text === 'Warning: shares input f4184fc59640:9 with "Dom Warn Set" - Tx 1, "Dom Warn Set" - Tx 2 — only one of them can ever be confirmed.',
    warnSoloLines ? warnSoloLines.map((l) => l.text).join(' | ') : 'no lines');
  check('warnings name members: NO "Untitled" or "Unknown" in any warning line',
    !!warnSetLines && !!warnSoloLines
    && warnSetLines.concat(warnSoloLines).every((l) => l.text.indexOf('Untitled') === -1 && l.text.indexOf('Unknown') === -1),
    warnSetLines ? warnSetLines.map((l) => l.text).join(' | ') : 'no lines');
  // The live tick leaves the warnings alone: disarm the set
  // behind an open modal, so the changed signature takes the
  // values-only patch path instead of a re-render.
  const warnCardBefore = cardByTitle('Dom Warn Set');
  const warnElsBefore = warnLines(warnCardBefore);
  els['btn-btc-add-pill'].click();
  check('warnings name members: the Add modal opens (structural changes defer to the patch)',
    els['add-modal'] && els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  const disWarn = await fetch('/api/bitcoin/sets/' + warnSetId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('warnings name members: the set disarms', disWarn.status === 200, 'status=' + disWarn.status);
  await sleep26(11000);
  const tickWarn = liveTickFn();
  check('warnings name members: the app registers a 1-second live timer', !!tickWarn, '');
  if (tickWarn) await tickWarn();
  check('warnings name members: the tick keeps the same set card element (patched, not rebuilt)',
    !!warnCardBefore && cardByTitle('Dom Warn Set') === warnCardBefore, '');
  const warnLinesAfter = warnLines(cardByTitle('Dom Warn Set'));
  check('warnings name members: after the tick the warning lines are the SAME elements with the SAME text',
    !!warnLinesAfter && warnLinesAfter.length === 2
    && warnLinesAfter.every((l, i) => l.el === warnElsBefore[i].el && l.text === warnElsBefore[i].text),
    warnLinesAfter ? warnLinesAfter.map((l) => l.text).join(' | ') : 'no lines');
  check('warnings name members: after the tick still no "Untitled" or "Unknown" in the warnings',
    !!warnLinesAfter && warnLinesAfter.every((l) => l.text.indexOf('Untitled') === -1 && l.text.indexOf('Unknown') === -1),
    warnLinesAfter ? warnLinesAfter.map((l) => l.text).join(' | ') : 'no lines');
  els['add-modal-x'].click();
  check('warnings name members: the Add modal closes',
    els['add-modal'] && !els['add-modal'].classList.contains('open'),
    els['add-modal'] ? 'open=' + els['add-modal'].classList.contains('open') : 'no add-modal');
  // (Round 13 sweep) A label-less standalone is named by its
  // short txid everywhere it is shown — card title, readiness
  // row, check-in bar — never "Untitled transaction".
  const addWarnPlain = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(10, 60000), trigger: { type: 'manual', params: {} } }) });
  check('warnings sweep: label-less standalone adds', addWarnPlain.status === 201, 'status=' + addWarnPlain.status);
  const addWarnPlainJson = addWarnPlain.status === 201 ? await addWarnPlain.json() : {};
  const warnPlainId = (addWarnPlainJson.tx || {}).id || null;
  const addWarnBar = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(11, 60001), trigger: { type: 'checkin', params: { thresholdDays: 10 } } }) });
  check('warnings sweep: label-less check-in tx adds', addWarnBar.status === 201, 'status=' + addWarnBar.status);
  const addWarnBarJson = addWarnBar.status === 201 ? await addWarnBar.json() : {};
  const warnBarId = (addWarnBarJson.tx || {}).id || null;
  await rerender(appJs);
  const stWarn = await (await fetch('/api/state')).json();
  const plainTx = (stWarn.bitcoin.txs || []).find((t) => t.id === warnPlainId);
  const barTx = (stWarn.bitcoin.txs || []).find((t) => t.id === warnBarId);
  const plainShort = plainTx ? (plainTx.txid || '').slice(0, 16) + '…' : '';
  const barShort = barTx ? (barTx.txid || '').slice(0, 16) + '…' : '';
  check('warnings sweep: the label-less card title is its short txid',
    !!plainShort && !!cardByTitle(plainShort), plainShort || 'no txid');
  check('warnings sweep: the label-less tx keeps its own readiness row under its short txid',
    !!plainShort && !!readinessBlock(plainShort) && readinessBlock(plainShort).status === 'armed',
    plainShort ? JSON.stringify(readinessBlock(plainShort)) : 'no txid');
  check('warnings sweep: the label-less check-in tx gets a bar under its short txid',
    !!barShort && (checkinBars() || []).some((b) => b.label === barShort),
    JSON.stringify(checkinBars()));
  check('warnings sweep: no card title or bar reads "Untitled transaction"',
    !txCards().some((c) => cardTitle(c) === 'Untitled transaction')
    && !(checkinBars() || []).some((b) => b.label === 'Untitled transaction'),
    txCards().map((c) => cardTitle(c)).join(', '));
  if (warnSetId) {
    const delWarnSet = await fetch('/api/bitcoin/sets/' + warnSetId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('warnings name members: the set deletes', delWarnSet.status === 200, 'status=' + delWarnSet.status);
  }
  for (const id of [warnM1Id, warnM2Id, warnSoloId, warnPlainId, warnBarId]) {
    if (!id) continue;
    const delWarn = await fetch('/api/bitcoin/txs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('warnings name members: fixture tx removed', delWarn.status === 200, 'status=' + delWarn.status);
  }
  await rerender(appJs);
  check('warnings name members: the set card is gone after the delete', !cardByTitle('Dom Warn Set'), '');

  // --- §28h (0.8.7.1): the broadcast line follows the verdict ---
  // Four manual txs on fresh FINNEY vouts (20–23, no shared-input
  // warnings), each seeded broadcast via the state file like §15:
  // stale (not found, input spent-confirmed), dropped (not found,
  // no verdict), unconfirmed (0 confirmations), confirmed (3).
  // The line's class is green only for confirmed, amber for
  // unconfirmed, red for not-found/stale — and the stale line
  // names the spending transaction instead of saying the tx "may
  // have been dropped". The pill is untouched by this change: the
  // stale card still reads Failed.
  function sentLineOf28h(card) {
    if (!card) return null;
    const stack = [card];
    while (stack.length) {
      const el = stack.pop();
      const cls = (el.className || '').split(' ');
      if ((cls.includes('tx-sent') || cls.includes('tx-warn') || cls.includes('tx-bad'))
        && (el.textContent || '').indexOf('Broadcast ') === 0) {
        return { el, cls: el.className, text: el.textContent || '' };
      }
      for (const c of (el.children || [])) stack.push(c);
    }
    return null;
  }
  const line28h = {};
  for (const [vout, value, label] of [[20, 113000, 'Dom Line Stale'], [21, 113001, 'Dom Line Dropped'],
      [22, 113002, 'Dom Line Unconf'], [23, 113003, 'Dom Line Conf']]) {
    const addL = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex: craftHex(vout, value), label, trigger: { type: 'manual', params: {} } }) });
    check('broadcast line: ' + label + ' adds', addL.status === 201, 'status=' + addL.status);
    if (addL.status === 201) line28h[label] = (await addL.json()).tx.id;
  }
  const lineNow28h = new Date().toISOString();
  const lineSt28h = await (await fetch('/api/state')).json();
  const lineTxid28h = {};
  for (const t of (lineSt28h.bitcoin.txs || [])) lineTxid28h[t.label] = t.txid || '';
  setDomTxFate('Dom Line Stale',
    { status: 'broadcast', kind: 'release', trigger: 'manual', txid: lineTxid28h['Dom Line Stale'], method: 'mempool.space', broadcastedAt: lineNow28h },
    { txid: lineTxid28h['Dom Line Stale'], broadcastedAt: lineNow28h, method: 'mempool.space', confirmations: 0, blockHeight: null, found: false, checkedAt: lineNow28h,
      staleInput: { spentBy: 'aabbccdd', blockHeight: 899990 } });
  setDomTxFate('Dom Line Dropped',
    { status: 'broadcast', kind: 'release', trigger: 'manual', txid: lineTxid28h['Dom Line Dropped'], method: 'mempool.space', broadcastedAt: lineNow28h },
    { txid: lineTxid28h['Dom Line Dropped'], broadcastedAt: lineNow28h, method: 'mempool.space', confirmations: 0, blockHeight: null, found: false, checkedAt: lineNow28h });
  setDomTxFate('Dom Line Unconf',
    { status: 'broadcast', kind: 'release', trigger: 'manual', txid: lineTxid28h['Dom Line Unconf'], method: 'mempool.space', broadcastedAt: lineNow28h },
    { txid: lineTxid28h['Dom Line Unconf'], broadcastedAt: lineNow28h, method: 'mempool.space', confirmations: 0, blockHeight: null, found: true, checkedAt: lineNow28h });
  setDomTxFate('Dom Line Conf',
    { status: 'broadcast', kind: 'release', trigger: 'manual', txid: lineTxid28h['Dom Line Conf'], method: 'mempool.space', broadcastedAt: lineNow28h },
    { txid: lineTxid28h['Dom Line Conf'], broadcastedAt: lineNow28h, method: 'mempool.space', confirmations: 3, blockHeight: 899997, found: true, checkedAt: lineNow28h });
  await rerender(appJs);
  const staleLine28h = sentLineOf28h(cardByTitle('Dom Line Stale'));
  check('broadcast line: the stale tx renders a sent line', !!staleLine28h, staleLine28h ? staleLine28h.text : 'no line');
  check('broadcast line: the stale line is red (tx-bad), not green',
    !!staleLine28h && staleLine28h.cls.split(' ').includes('tx-bad'), staleLine28h ? staleLine28h.cls : 'no line');
  check('broadcast line: the stale line names the spending transaction and its block, never "dropped"',
    !!staleLine28h && staleLine28h.text.indexOf('stale — input spent by aabbccdd (block 899,990)') !== -1
    && staleLine28h.text.indexOf('may have been dropped') === -1, staleLine28h ? staleLine28h.text : 'no line');
  check('broadcast line: the stale card pill still reads Failed (pill logic untouched)',
    !!cardByTitle('Dom Line Stale') && cardFaceText(cardByTitle('Dom Line Stale')).indexOf('Failed') !== -1,
    cardByTitle('Dom Line Stale') ? cardFaceText(cardByTitle('Dom Line Stale')) : 'no card');
  const droppedLine28h = sentLineOf28h(cardByTitle('Dom Line Dropped'));
  check('broadcast line: the plain not-found tx renders a sent line', !!droppedLine28h, droppedLine28h ? droppedLine28h.text : 'no line');
  check('broadcast line: the not-found line is red (tx-bad) and keeps the "dropped" wording',
    !!droppedLine28h && droppedLine28h.cls.split(' ').includes('tx-bad')
    && droppedLine28h.text.indexOf('may have been dropped from the mempool or replaced') !== -1,
    droppedLine28h ? droppedLine28h.cls + ' | ' + droppedLine28h.text : 'no line');
  const unconfLine28h = sentLineOf28h(cardByTitle('Dom Line Unconf'));
  check('broadcast line: the unconfirmed tx renders a sent line', !!unconfLine28h, unconfLine28h ? unconfLine28h.text : 'no line');
  check('broadcast line: the unconfirmed line is amber (tx-warn) with 0 confirmations',
    !!unconfLine28h && unconfLine28h.cls.split(' ').includes('tx-warn')
    && unconfLine28h.text.indexOf('0 confirmations — in the mempool, unconfirmed') !== -1,
    unconfLine28h ? unconfLine28h.cls + ' | ' + unconfLine28h.text : 'no line');
  const confLine28h = sentLineOf28h(cardByTitle('Dom Line Conf'));
  check('broadcast line: the confirmed tx renders a sent line', !!confLine28h, confLine28h ? confLine28h.text : 'no line');
  check('broadcast line: the confirmed line is green (tx-sent) with 3 confirmations',
    !!confLine28h && confLine28h.cls.split(' ').includes('tx-sent')
    && confLine28h.text.indexOf('3 confirmations') !== -1,
    confLine28h ? confLine28h.cls + ' | ' + confLine28h.text : 'no line');
  for (const label of ['Dom Line Stale', 'Dom Line Dropped', 'Dom Line Unconf', 'Dom Line Conf']) {
    if (!line28h[label]) continue;
    const delL = await fetch('/api/bitcoin/txs/' + line28h[label], { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('broadcast line: ' + label + ' removed', delL.status === 200, 'status=' + delL.status);
  }
  await rerender(appJs);

  // --- §28i (0.8.7.2): an archived broadcast line shows the derived count ---
  // A broadcast tx past 6 confirmations is never re-queried per-tx,
  // but its line no longer freezes at the stored snapshot: the
  // confirmations poll derives it from the settled block height +
  // the current stub tip (900,000 - 899,993 + 1 = 8), while the
  // stored snapshot stays 7. The line first renders the stored 7
  // from state, then the load's confirmations poll corrects it —
  // so wait for the derived count instead of reading once.
  const addD28i = await fetch('/api/bitcoin/txs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHex: craftHex(24, 113004), label: 'Dom Line Derived', trigger: { type: 'manual', params: {} } }) });
  check('broadcast line: Dom Line Derived adds', addD28i.status === 201, 'status=' + addD28i.status);
  const derivedId28i = addD28i.status === 201 ? (await addD28i.json()).tx.id : null;
  const derivedNow28i = new Date().toISOString();
  const derivedSt28i = await (await fetch('/api/state')).json();
  const derivedTxid28i = (derivedSt28i.bitcoin.txs || []).find((t) => t.label === 'Dom Line Derived');
  setDomTxFate('Dom Line Derived',
    { status: 'broadcast', kind: 'release', trigger: 'manual', txid: derivedTxid28i ? derivedTxid28i.txid : '', method: 'mempool.space', broadcastedAt: derivedNow28i },
    { txid: derivedTxid28i ? derivedTxid28i.txid : '', broadcastedAt: derivedNow28i, method: 'mempool.space', confirmations: 7, blockHeight: 899993, found: true, checkedAt: derivedNow28i });
  await rerender(appJs);
  let derivedLine28i = null;
  for (let i = 0; i < 20; i++) {
    derivedLine28i = sentLineOf28h(cardByTitle('Dom Line Derived'));
    if (derivedLine28i && derivedLine28i.text.indexOf('8 confirmations') !== -1) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('broadcast line: the archived tx renders a sent line', !!derivedLine28i, derivedLine28i ? derivedLine28i.text : 'no line');
  check('broadcast line: the archived line shows the derived count (8), not the stored 7',
    !!derivedLine28i && derivedLine28i.text.indexOf('8 confirmations') !== -1
    && derivedLine28i.text.indexOf('7 confirmations') === -1,
    derivedLine28i ? derivedLine28i.text : 'no line');
  check('broadcast line: the derived line is still green (tx-sent)',
    !!derivedLine28i && derivedLine28i.cls.split(' ').includes('tx-sent'), derivedLine28i ? derivedLine28i.cls : 'no line');
  const derivedStored28i = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).bitcoin.txs.find((t) => t.label === 'Dom Line Derived');
  check('broadcast line: the stored snapshot is untouched (still 7, checkedAt still the seeded value)',
    !!derivedStored28i && (derivedStored28i.broadcasted || {}).confirmations === 7
    && (derivedStored28i.broadcasted || {}).checkedAt === derivedNow28i,
    derivedStored28i ? JSON.stringify(derivedStored28i.broadcasted) : 'no tx');
  if (derivedId28i) {
    const delD = await fetch('/api/bitcoin/txs/' + derivedId28i, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('broadcast line: Dom Line Derived removed', delD.status === 200, 'status=' + delD.status);
  }
  await rerender(appJs);

  // Restore the seeded state for the width check.
  const cad60 = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkCadenceSeconds: 60 }) });
  check('live view: the check cadence restores to 60s', cad60.status === 200, 'status=' + cad60.status);
  const reP26 = await fetch('/api/bitcoin/txs/' + domPrice26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  check('live view: Dom Price re-arms', reP26.status === 200, 'status=' + reP26.status);
  const reOr26 = await fetch('/api/bitcoin/txs/' + domOr26.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  check('live view: Dom Rules OR re-arms (stub price back to $98,200, so its price rule watches)', reOr26.status === 200, 'status=' + reOr26.status);
  if (liveNewId) {
    const delLive = await fetch('/api/bitcoin/txs/' + liveNewId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    check('live view: the Dom Live New tx is removed', delLive.status === 200, 'status=' + delLive.status);
  }
  await rerender(appJs);

  // (0.8.8) Re-seed the finite grace §25 resumed: the width check
  // measures the grace card at 390px, so it must be visible.
  setDomGrace({ graceUntil: new Date(Date.now() + 7 * 86400000).toISOString(), triggeredAt: new Date().toISOString(), offlineGapDays: 8 });
  await rerender(appJs);
  check('live view: a finite grace is left active for the width check',
    els['grace-card'] && els['grace-card'].style.display !== 'none',
    els['grace-card'] && els['grace-card'].style.display);

  console.log();
  console.log('FAILURES: ' + failures.length + (failures.length ? ' ' + JSON.stringify(failures) : ' (none)'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('SHIM ERROR:', e); process.exit(1); });
