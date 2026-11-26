// The page and the server each carry a copy of a few rules (the page
// cannot load the server's modules). This runs both copies on the same
// inputs and fails on any difference:
//   - the fee verdict (lib/bitcoin/fees.js feeVerdict)
//   - reading a transaction's triggers (lib/store.js triggerOf)
//   - a transaction's name in history (lib/store.js memberHistoryDetail)
//   - the check-in danger zone and frozen time (lib/checkin.js
//     inDangerZone, checkinLiveOffsetMs)
// The page's functions are taken from standby/public/js/ by name and run
// in a sandbox with a fixed clock. Run: node test/mirror_check.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = process.env.STANDBY_TEST_APP_DIR ? path.resolve(process.env.STANDBY_TEST_APP_DIR) : path.join(__dirname, '..', 'standby');
const fees = require(path.join(APP, 'lib', 'bitcoin', 'fees'));
const store = require(path.join(APP, 'lib', 'store'));
const checkin = require(path.join(APP, 'lib', 'checkin'));

const failures = [];
let compared = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.log('FAIL - mirror: ' + name + ' | ' + String(detail).slice(0, 400));
    failures.push(name);
  }
}

// The page's copies, by name, from the page files.
const PAGE_DIR = path.join(APP, 'public', 'js');
const pageSrc = fs.readdirSync(PAGE_DIR).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(PAGE_DIR, f), 'utf8')).join('\n');
function pageFunction(name) {
  const m = new RegExp('^function ' + name + '\\(.*\\n(?:.*\\n)*?\\}$', 'm').exec(pageSrc);
  if (!m) throw new Error('page function not found: ' + name);
  return m[0];
}
const NOW = Date.parse('2026-06-15T12:00:00Z');
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const page = vm.createContext({ S: null, Date: FixedDate, Math, isFinite, String, Array });
vm.runInContext(['feeVerdict', 'normalizeRule', 'triggerSetOf', 'shortTxid16', 'setOfTxId', 'txDisplayName', 'liveOffsetMs', 'dangerZone']
  .map(pageFunction).join('\n'), page);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Fee verdict.
const nums = [undefined, null, 'x', NaN, Infinity, -1, 0, 0.5, 1, 1.5, 2, 3, 4, 10];
for (const rate of nums) for (const peak of nums) for (const eco of [undefined, null, -1, 0, 1, 2, 5]) {
  for (const [lo, med] of [[undefined, undefined], [3, 1.5], [0, -1], [2, 1], ['a', NaN]]) {
    const s = fees.feeVerdict(rate, peak, eco, lo, med);
    const p = page.feeVerdict(rate, peak, eco, lo, med);
    compared++;
    check('fee verdict ' + JSON.stringify([rate, peak, eco, lo, med]), s === p, 'server ' + s + ', page ' + p);
  }
}

// 2. Reading a transaction's triggers.
const OUT = 'a'.repeat(64) + ':1';
const rules = [
  undefined, null, 'checkin', {}, { type: 'nope' },
  { type: 'checkin' }, { type: 'checkin', params: { thresholdDays: 10 } }, { type: 'checkin', params: { thresholdDays: 0 } },
  { type: 'checkin', params: { thresholdDays: 99999 } }, { type: 'checkin', params: { thresholdDays: 7.9 } }, { type: 'checkin', params: { thresholdDays: '9' } },
  { type: 'price', params: { op: '>=', value: 100000 } }, { type: 'price', params: { op: '<=', value: 5 } }, { type: 'price', params: { op: '>', value: 5 } },
  { type: 'price', params: { op: '>=', value: 'x' } }, { type: 'price', params: { asset: 'ETH', op: '>=', value: 1 } },
  { type: 'utxo', params: { outpoint: OUT } }, { type: 'utxo', params: { outpoint: ' ' + OUT.toUpperCase() + ' ', confirmations: 0 } },
  { type: 'utxo', params: { outpoint: OUT, confirmations: 250 } }, { type: 'utxo', params: { outpoint: OUT, confirmations: 2.5 } },
  { type: 'utxo', params: { outpoint: 'bad' } }, { type: 'manual' }, { type: 'manual', params: { x: 1 } },
  { type: 'setdate', params: { fireAt: '2027-01-01T09:30:00Z' } }, { type: 'setdate', params: { fireAt: 'soon' } },
  { type: 'feemarket', params: { maxFeeRate: 5 } }, { type: 'feemarket', params: { maxFeeRate: 50, direction: 'above' } },
  { type: 'feemarket', params: { maxFeeRate: 0.05 } }, { type: 'feemarket', params: { maxFeeRate: 5, direction: 'sideways' } },
  { type: 'blockheight', params: { targetHeight: 900000 } }, { type: 'blockheight', params: { targetHeight: 1.5 } },
];
const triggers = [];
for (const r of rules) triggers.push(r);
for (const op of ['OR', 'AND', 'xor', undefined]) {
  triggers.push({ op, rules: [] });
  for (let i = 0; i < rules.length; i++) triggers.push({ op, rules: [rules[i], rules[(i + 5) % rules.length]] });
  triggers.push({ op, rules: rules.slice(5, 11) }); // more rules than a transaction may have
  triggers.push({ op, rules: [rules[6], rules[11], rules[16], rules[23], rules[25]] });
}
// The server rewrites every stored trigger to its strict reading on load
// (one bad rule: the whole set becomes the 35-day check-in) and serves
// that, a one-rule set as its single rule. So (a) whatever was stored,
// the page reading what is served must match the server; (b) a trigger
// the server accepts as is must read the same in both. (The page alone
// is more lenient on input the server never sends.)
for (const t of triggers) {
  const s = store.triggerOf({ id: 't', trigger: t });
  const served = page.triggerSetOf({ id: 't', trigger: JSON.parse(JSON.stringify(store.serveTrigger(s))) });
  compared++;
  check('triggers as served ' + JSON.stringify(t), same(s, served), 'server ' + JSON.stringify(s) + ' | page ' + JSON.stringify(served));
  if (store.normalizeTrigger(t).trigger) {
    const raw = page.triggerSetOf({ id: 't', trigger: t });
    compared++;
    check('triggers as stored ' + JSON.stringify(t), same(s, raw), 'server ' + JSON.stringify(s) + ' | page ' + JSON.stringify(raw));
  }
}

// 3. A transaction's name in history.
const txid = 'b'.repeat(64);
const sets = [{ id: 's1', label: 'Family', txIds: ['m1', 'm2'] }, { id: 's2', label: '', txIds: ['m3'] }];
page.S = { bitcoin: { sets } };
for (const tx of [
  null, { id: 'a', label: 'Savings', txid }, { id: 'b', label: '', txid }, { id: 'c', txid: 'abc' }, { id: 'd' },
  { id: 'm1', label: 'ignored', txid }, { id: 'm2', txid }, { id: 'm3', label: 'x', txid },
]) {
  const set = tx ? (sets.find((st) => st.txIds.includes(tx.id)) || null) : null;
  const s = store.memberHistoryDetail(set, tx, null);
  const p = page.txDisplayName(tx);
  compared++;
  check('name ' + JSON.stringify(tx), s === p, 'server ' + s + ', page ' + p);
}

// 4. The check-in danger zone and frozen time.
const now = new Date(NOW);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;
for (const ago of [null, 0, 1, 20, 26.25, 26.249, 26.251, 34, 35, 40]) {
  for (const th of [0, -1, 7, 35]) {
    for (const off of [undefined, -5, 0, 2 * DAY, 30 * DAY]) {
      const last = ago === null ? null : iso(NOW - ago * DAY);
      page.S = { checkin: { lastCheckinAt: last } };
      const s = checkin.inDangerZone({ checkin: { lastCheckinAt: last } }, now, th, off);
      const p = page.dangerZone(th, off) !== null;
      compared++;
      check('danger zone ' + JSON.stringify({ ago, th, off }), s === p, 'server ' + s + ', page ' + p);
    }
  }
}
for (const tx of [
  {}, { checkinOffsetMs: 5000 }, { checkinOffsetMs: -1 }, { checkinOffsetMs: 'x' },
  { checkinInactiveSince: iso(NOW - 3 * DAY) }, { checkinOffsetMs: DAY, checkinInactiveSince: iso(NOW - DAY) },
  { checkinInactiveSince: iso(NOW + DAY) }, { checkinInactiveSince: 'not a date' }, { checkinInactiveSince: '' },
]) {
  const s = checkin.checkinLiveOffsetMs(tx, now);
  const p = page.liveOffsetMs(tx);
  compared++;
  check('frozen time ' + JSON.stringify(tx), s === p, 'server ' + s + ', page ' + p);
}

console.log((failures.length ? 'FAIL' : 'PASS') + ' - mirror: the page and server copies agree on ' + compared + ' inputs');
console.log('FAILURES: ' + failures.length + (failures.length ? '' : ' (none)'));
process.exit(failures.length ? 1 : 0);
