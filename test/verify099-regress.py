#!/usr/bin/env python3
"""Standby 0.8.0 local verification: per-transaction triggers.
Boots the branch-split app (port 3448), the check-in receiver
(3449), and two mempool stubs — primary 18245 (STUB_CONFLICT_MODE=
unconfirmed) and secondary 18246 (confirmed) — and checks the 0.8.0
trigger work: trigger field + validation at add/edit, legacy migration
to the check-in trigger, per-tx check-in thresholds, the check-in-only
scoping of the 0.7.22 guards (danger-zone resets, check-in clearing
release records, the check-in card), the per-tx check-in bars
and the removed global threshold (section 16), the price trigger (immediate fire
on two-source agreement, fail-safe unknown, already-true warning;
a large jump both sources agree on is trusted and fires — no range
check), the UTXO trigger (confirmation modes:
unconfirmed (0) fires on any spend, N confirmations fires at N —
default 1, confirmed-only; already-spent gate at add is mode-aware,
fail-safe unknown, unconfirmed-spend warning; catch-up: a spend
first noticed above N still fires, confirmations >= N), the 1-minute
full tick (every rule type evaluated together every minute), one release check evaluating per-tx triggers, and restore
carrying trigger + triggerState while still refreshing the clock. The price trigger
reads from TWO sources (Settings: priceSources, CoinGecko + Coinbase
by default): a reading is only valid when the two agree within 5%
(disagreement -> unknown, never fires); when both agree the
PRIMARY exchange's price decides; when the primary fails the
secondary is used alone (no 5% check); when neither answers
the reading is unknown. The
Settings validation (unknown provider, identical sources) and the
provider registry (CoinGecko, Coinbase, Binance, Kraken, Bitstamp)
are covered in section 12. Section 14 covers the price-source Test
button (a fresh-fetch endpoint that bypasses the cache and accepts
any of the five providers), the descriptive User-Agent on price
fetches (CoinGecko 403s a missing one), and the consolidated
Exchange Status on the readiness card (OK / degraded / error,
shown once — the per-price-tx reasons are trigger-only, no source
note). Section 15 covers the price confirm guard: a price rule
whose condition is already satisfied (both sources agree) is
blocked at add / import / edit unless triggerConfirmed is set —
mirroring the UTXO gate — while a rule that is not past the
threshold, or an unknown reading (disagreeing or unavailable
feeds), never blocks. Every trigger subcard is exactly 3 rows (header /
condition / current state, one line each) and the dry-run note of
a price tx carries the source detail (both readings, single-source
fallback, or the disagreement) — that is where the source detail
lives, alongside the Exchange Status section. Section 18 covers the
grace period for ALL triggers (0.8.0, extended 0.8.8, unified
0.8.8): when the app comes back after being offline longer than
settings.graceOfflineDays (default 7), price, UTXO, block-height,
set-date, fee-market, AND check-in triggers are paused for
settings.graceDurationDays (default 7, null = indefinite until
resumed) while the grace toggle is on — a blanket hold, so no held
trigger fires during it, even one whose condition first becomes
true during the grace; after expiry (or POST /api/grace/resume)
they evaluate normally and fire if the condition still holds.
Checking in does NOT clear it. A past-due check-in bar reads
'grace' while the grace holds it, never 'release-due', and the
top-level check-in state is 'grace' ("Grace period") while any
armed entry is past due and held. The settings validation (only
0/1/3/7/14/30, null duration valid, graceEnabled a boolean) and
the grace served on /api/state are covered there too (/api/status
stays grace-free — it is the check-in endpoint, and a held
check-in bar reads 'grace' there, not a Grace-period field).
The served triggerStatus also carries a wouldFire boolean (0.8.8
both-numbers card): among the held txs, how many would fire the
moment the grace lifts — check-in and set-date on the live clock,
price / fee-market / block-height on the warm caches (else the
stored last evaluation), UTXO on the stored slice only (it goes
stale during a grace), manual never, unknown never. Leg 1 reads
1 of 3 would fire (price only); leg 2 reads 2 of 3 (price +
check-in, not the UTXO whose spend landed after its last
evaluation).
Section 19 covers the Getting
Started empty-state card (0.8.0): the served markup and CSS only
(the show/hide behaviour and the button navigation are in the DOM
suite, §19) — the card at the top of the Dashboard with the owner's
exact copy, and the .empty-state rules in the served stylesheet.
Section 20 covers the user controls (price agreement, check
cadence, fee verdict). Section 21 covers the pause/vacation/
disarm redesign (0.8.0): inactive time does not count toward the
check-in countdown — vacation freezes it (check-in-only: price
and UTXO still fire on vacation), a disarmed check-in tx keeps a
frozen bar, Global Arm/Disarm (POST /api/bitcoin/txs/arm-all),
manual broadcasts bypassing disarm, indefinite and dated
vacation (expiry at end of the vacationUntil day), no
double-counting across overlapping inactive causes, and `paused`
being gone entirely (PUT 400, pause/resume 404, backups restore
without it, freeze fields carried through restore).

Timing hazards, handled by construction (see the branch server.js):
the app runs a full evaluation 5 s after startup and then every
checkCadenceSeconds (default 60 s) while a non-manual rule is
armed, and the price cache is fresh for 1 min. Every test that
seeds a firing state (a backdated check-in clock) therefore
restarts the app first (fresh tick clock + empty price cache),
waits 7 s (past the startup tick), seeds state.json, verifies
the seed via GET /api/state, and only then runs the manual
release check — the next tick is 1 min away, so the manual check
must land within that minute. Every test that changes the stub
price also restarts, so the evaluation reads the new price
instead of the cached one. The hourly tick never evaluates —
it only refreshes node status, confirmations, MARA/fallback
state, and fee caches.

Ports: app 3448, receiver 3449, stubs 18245/18246 — no collision
with the 094 suite (app 3378, receiver 3379, stubs 18159/18160/18161).
Reuses the 094 helpers (import verify094 — importing does not run
main()) and never touches the 094 files or the main app/ copy.
"""
import copy
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify094 as v

check = v.check


def req(method, path, body=None, base=None, timeout=20, headers=None):
    # verify094.req defaults to ITS base (port 3378); this suite's
    # app is on 3448, so default to our BASE here instead. base=None
    # resolves at call time (BASE is defined below).
    return v.req(method, path, body, base=base or BASE, timeout=timeout, headers=headers)


craft = v.craft
craft_prev = v.craft_prev
txid_of = v.txid_of
start = v.start
stop = v.stop
wait_up = v.wait_up
STUB = v.STUB
SENTINEL_TXID = v.SENTINEL_TXID
FINNEY = v.FINNEY
SECOND = v.SECOND
CONFLICT = 'cc' * 32

GOAL = v.GOAL
APP = v.app_dir(GOAL)
DATA = '/tmp/heirloom099-regress'
CHECKIN_DIR = '/tmp/heirloom099-regress-checkin'
PORT = 3448
BASE = 'http://127.0.0.1:%d' % PORT
RECEIVER_PORT = 3449
RBASE = 'http://127.0.0.1:%d' % RECEIVER_PORT
STUB_P = 18245
STUB_S = 18246
STUB_BASE_P = 'http://127.0.0.1:%d' % STUB_P
STUB_BASE_S = 'http://127.0.0.1:%d' % STUB_S
APP_ENV = {'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR,
           'SLIPSTREAM_API_URL': STUB_BASE_P,
           'PRICE_API_URL': STUB_BASE_P}
# (0.8.11, secure defaults) Profile dimension, same as the API suite:
# STANDBY_TEST_PROFILE=umbrel runs with STANDBY_BIND=0.0.0.0 and
# STANDBY_ALLOWED_HOSTS set (the ${APP_DOMAIN} equivalent); the
# default profile runs the code defaults (loopback bind, no
# allowlist). CI invokes the suite once per profile.
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    APP_ENV['STANDBY_BIND'] = '0.0.0.0'
    APP_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
RECEIVER_ENV = {'PORT': str(RECEIVER_PORT), 'CHECKIN_DIR': CHECKIN_DIR}
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    RECEIVER_ENV['STANDBY_BIND'] = '0.0.0.0'
    RECEIVER_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
LOG = '/tmp/heirloom099-regress-proc.log'


def iso_ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat().replace('+00:00', 'Z')


def iso_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def load_state_file():
    return json.load(open(os.path.join(DATA, 'state.json')))


def save_state_file(stj):
    json.dump(stj, open(os.path.join(DATA, 'state.json'), 'w'), indent=2)
    # (0.8.10, skip-save) A test-written state.json defines the
    # world — including a backdated lastOnlineAt for a grace test.
    # The heartbeat file is a runtime cache that loadState merges
    # over the state's own stamp, so a fresh heartbeat left over
    # from the running app would silently override the seeded
    # clock. Drop it whenever state is seeded; the next tick
    # rewrites it. (Same fix as verify099.py's save_state_file.)
    try:
        os.remove(os.path.join(DATA, 'heartbeat.json'))
    except OSError:
        pass


def set_clock(days_back, online_days=0):
    """Backdate the check-in clock; keep lastOnlineAt fresh so no
    grace sets in these tests. The
    30 s margin keeps floored day counts exact when a tx carries
    a banked freeze offset of a few hundred ms (a disarm->re-arm
    inside the test banks real elapsed time — section 21)."""
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=days_back, seconds=30)).isoformat().replace('+00:00', 'Z')
    stj['checkin']['lastOnlineAt'] = iso_ago(days=online_days)
    save_state_file(stj)


def state_tx(tx_id, base=BASE):
    s, st = req('GET', '/api/state', base=base)
    for t in st.get('bitcoin', {}).get('txs', []):
        if t.get('id') == tx_id:
            return t
    return None


def wait_until(cond, deadline=20, interval=0.5):
    """Poll cond() until it returns truthy, or the deadline
    (seconds) expires — the same evidence a fixed 'wait a tick'
    sleep bought, observed instead of assumed. Returns True if
    cond() fired, False on deadline (callers then assert as
    before, so a slow tick fails the same check the sleep would
    have failed). Exceptions inside cond() are swallowed per
    poll, so a transient read error cannot fail the wait."""
    end = time.time() + deadline
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def checkin_last(base=BASE):
    s, st = req('GET', '/api/state', base=base)
    return st.get('checkin', {}).get('lastCheckinAt')


def set_price(usd=None, fail=None, bad='__keep__', provider=None):
    """Drive the price stub. bad=None clears a malformed reading
    (the stub only accepts null / 'zero' / 'huge' / 'empty').
    With provider=None the control applies to ALL providers
    (backward compat); with a provider id it applies to that
    provider only (two-source 0.8.0)."""
    body = {}
    if usd is not None:
        body['usd'] = usd
    if fail is not None:
        body['fail'] = fail
    if bad != '__keep__':
        body['bad'] = bad
    if provider is not None:
        body['provider'] = provider
    return req('POST', '/__test__/price', body, base=STUB_BASE_P)


def set_outspend(txid, vout, block_height):
    """Drive the outspend block-height override on the primary stub.
    block_height=None clears it. The spend is then reported as
    confirmed at that height (confs = 900000 - height + 1)."""
    body = {'txid': txid, 'vout': vout}
    if block_height is None:
        body['clear'] = True
    else:
        body['blockHeight'] = block_height
    return req('POST', '/__test__/outspend', body, base=STUB_BASE_P)


def patch_trigger_state(tx_id, **fields):
    """Merge fields into a tx's stored triggerState (fresh defaults
    when it has none). Direct state.json edit, like 094's set_clock."""
    stj = load_state_file()
    for t in stj.get('bitcoin', {}).get('txs', []):
        if t.get('id') == tx_id:
            ts = t.get('triggerState') if isinstance(t.get('triggerState'), dict) else {}
            fresh = {'lastEvalAt': iso_now(), 'status': 'watching', 'reason': 'seeded',
                     'lastPrice': None, 'lastPriceAt': None,
                     'lastOutspend': None, 'lastError': None}
            fresh.update(ts)
            fresh.update(fields)
            t['triggerState'] = fresh
            break
    save_state_file(stj)


def set_tx_fate(tx_id, release=None, broadcasted='__keep__'):
    """Set a tx's stored release record / broadcasted fact (direct
    state.json edit). release=None clears the record; broadcasted
    '__keep__' leaves the fact alone, None clears it. Used to
    stage settled / pending / failed / conflict txs for the
    check-in bar tests."""
    stj = load_state_file()
    for t in stj.get('bitcoin', {}).get('txs', []):
        if t.get('id') == tx_id:
            t['release'] = release
            if broadcasted != '__keep__':
                t['broadcasted'] = broadcasted
            break
    save_state_file(stj)


def set_clock_margin(days_back, online_days=0, margin_s=30):
    """Backdate the check-in clock with a margin: lastCheckinAt
    N days + 30 s ago, so a floored day count lands on N even
    when a banked freeze offset carries a few seconds of
    test-execution time (see section 21)."""
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=days_back, seconds=margin_s)).isoformat().replace('+00:00', 'Z')
    stj['checkin']['lastOnlineAt'] = iso_ago(days=online_days)
    save_state_file(stj)


def set_tx_freeze(tx_id, offset_ms='__keep__', inactive_since='__keep__'):
    """Direct state.json edit of a tx's freeze fields, like
    set_clock: offset_ms is the banked inactive time, and
    inactive_since an ISO timestamp (or None) for the open
    inactive period. Used to simulate days passing while a tx
    is inactive — the server measures real elapsed time, so
    simulated time is written into these fields."""
    stj = load_state_file()
    for t in stj.get('bitcoin', {}).get('txs', []):
        if t.get('id') == tx_id:
            if offset_ms != '__keep__':
                t['checkinOffsetMs'] = offset_ms
            if inactive_since != '__keep__':
                t['checkinInactiveSince'] = inactive_since
            break
    save_state_file(stj)


def tx_freeze(tx_id):
    t = state_tx(tx_id)
    return ((t or {}).get('checkinOffsetMs'), (t or {}).get('checkinInactiveSince'))


def delete_all_txs(base=BASE):
    s, st = req('GET', '/api/state', base=base)
    for t in st.get('bitcoin', {}).get('txs', []):
        req('DELETE', '/api/bitcoin/txs/' + t['id'], base=base)


def release_results(base=BASE):
    s, r = req('POST', '/api/release/check', {}, base=base)
    return s, r, {x.get('id'): x for x in r.get('results', [])}


def port_closed(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            return False
    except OSError:
        return True


def main():
    for d in (DATA, CHECKIN_DIR):
        shutil.rmtree(d, ignore_errors=True)
    app = None

    def restart():
        """Stop + start the app, wait up, then poll until the
        startup tick has fired (Optimization O2): the startup
        hourly tick stamps bitcoin.connection.nodeCheckedAt.primary
        and the +2 s refresh fills bitcoin.currentFees — both are
        observable in /api/state, so poll for them instead of
        sleeping a fixed 7 s past the 5 s startup tick. The
        currentFees condition also guarantees the concurrent startup
        full tick (fired at the same ~0.5 s) has finished before
        any post-restart read. Deadline 4 s, then proceed anyway
        (the old behavior as fallback). On the very first boot the
        node URLs are not pointed at the stubs yet, so the +2 s
        refresh cannot fill currentFees and the poll runs its 4 s
        course — the 4 s itself still guarantees the 500 ms startup
        ticks finished. Call BEFORE seeding any firing state."""
        nonlocal app
        # The pre-restart node-check stamp: the poll waits for a
        # stamp NEWER than this, so a stale stamp can never
        # satisfy it (mergeNodeStamps keeps the stored stamp
        # until testNodes re-stamps it at startup).
        prev_stamp = None
        try:
            _, st = req('GET', '/api/state')
            prev_stamp = (st.get('bitcoin', {}).get('connection', {}).get('nodeCheckedAt') or {}).get('primary')
        except Exception:
            pass
        if app is not None:
            stop(app)
        app = start(['node', 'server.js'], env=APP_ENV, cwd=APP, log=LOG)
        ok = wait_up(BASE)
        if ok:
            end = time.time() + 4
            while time.time() < end:
                try:
                    _, st = req('GET', '/api/state')
                    conn = st.get('bitcoin', {}).get('connection', {})
                    stamp = (conn.get('nodeCheckedAt') or {}).get('primary')
                    cur_fees = st.get('bitcoin', {}).get('currentFees') or {}
                    if (isinstance(stamp, str) and stamp != prev_stamp
                            and isinstance(cur_fees.get('economyFee'), (int, float))):
                        break
                except Exception:
                    pass
                time.sleep(0.25)
        return ok

    def clear_caches():
        """POST /api/__test__/clear-caches — cold caches without a
        restart (speedup): the same empty price / fee / tip /
        current-fee / outspend caches a restart produces, but no
        state re-read, no tick-timer reset, no restart startup wait
        (~2.5 s poll). (There is no fee-peak cache any more — the
        peak is derived from the recorded history in state.json,
        so a restart is the only way to re-read it.) Use ONLY where
        a cold cache is all the test needs. Keep restart() where a
        real restart is the subject (state persistence, migration,
        crash recovery), or where the fresh tick window is
        load-bearing (a background tick must not fire before the
        manual check)."""
        s, r = req('POST', '/api/__test__/clear-caches', {})
        return s == 200 and r.get('ok') is True

    try:
        # --- pre-flight: our ports are free (nothing 09x left running) ---
        for port in (PORT, RECEIVER_PORT, STUB_P, STUB_S):
            check('preflight: port %d free' % port, port_closed(port))
        # --- stubs + receiver + app ---
        p_primary = start(['node', STUB, str(STUB_P)],
                          env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_CONFLICT_MODE': 'unconfirmed',
                               'STUB_PRICE_USD': '98200'}, log=LOG)
        p_secondary = start(['node', STUB, str(STUB_S)],
                            env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_CONFLICT_MODE': 'confirmed',
                                 'STUB_PRICE_USD': '98200'}, log=LOG)
        p_receiver = start(['node', 'checkin-receiver/server.js'],
                           env=RECEIVER_ENV,
                           cwd=APP, log=LOG)
        # Poll for the stubs instead of a fixed sleep: under parallel
        # startup load a stub can take longer than 0.8 s to listen,
        # and the probe below used to crash on Connection refused.
        wait_up(STUB_BASE_P, path='/api/v3/simple/price')
        wait_up(STUB_BASE_S, path='/api/v3/simple/price')
        s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_P)
        check('stubs up: primary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
        s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_S)
        check('stubs up: secondary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
        check('app up', restart())
        check('receiver up', wait_up(RBASE, path='/health'))

        # --- 1. health + endpoints -------------------------------------
        s, h = req('GET', '/api/health')
        check('1 health reports version 0.8.11.1', h.get('version') == '0.8.11.1', h)
        s, st = req('GET', '/api/state')
        check('1 fresh state: no global threshold in settings, no txs',
              'thresholdDays' not in st.get('settings', {}) and st.get('bitcoin', {}).get('txs') == [], st.get('settings'))
        check('1 fresh state: no price cached yet',
              st.get('bitcoin', {}).get('currentPrice') is None and st.get('bitcoin', {}).get('currentPriceAt') is None, st.get('bitcoin'))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S})
        check('1 settings PUT points primary+secondary at the stubs',
              s == 200 and r.get('primaryApiUrl') == STUB_BASE_P and r.get('secondaryApiUrl') == STUB_BASE_S, r)

        # --- 2. trigger field + validation at add ----------------------
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100001), 'label': 'N no trigger', 'notes': ''})
        check('2 no-trigger add -> 201 with check-in trigger at threshold 35, triggerState null',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'checkin', 'params': {'thresholdDays': 35}}
              and r.get('tx', {}).get('triggerState') is None, r)
        txn = r['tx']['id']
        s, st = req('GET', '/api/state')
        tn = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txn][0]
        check('2 no-trigger add: GET /api/state shows the same normalized trigger + triggerStatus',
              tn.get('trigger') == {'type': 'checkin', 'params': {'thresholdDays': 35}}
              and tn.get('triggerStatus', {}).get('type') == 'checkin', tn.get('triggerStatus'))
        bad_triggers = [
            ('bad type', {'type': 'bogus', 'params': {}}, 'unknown trigger type'),
            ("bad op '>'", {'type': 'price', 'params': {'op': '>', 'value': 90000}}, "op must be"),
            ("bad outpoint 'xyz:0'", {'type': 'utxo', 'params': {'outpoint': 'xyz:0'}}, 'txid:vout'),
            ('non-numeric thresholdDays', {'type': 'checkin', 'params': {'thresholdDays': '35'}}, 'must be a number'),
        ]
        for i, (label, trig, frag) in enumerate(bad_triggers):
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110000 + i * 2), 'label': 'bad ' + label, 'trigger': trig})
            check('2 invalid trigger at add -> 400 (%s)' % label,
                  s == 400 and frag in (r.get('error') or ''), (s, r))
        # No range check on a price trigger value any more: 0 and
        # $999,999,999 are both valid values. (0 with op '>=' is
        # holding at $98,200, so it needs triggerConfirmed — the
        # already-true gate, not validation — while $999,999,999
        # is not holding and adds plain.)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110100), 'label': 'P value 0',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 0}}, 'triggerConfirmed': True})
        check('2 price trigger value 0 adds (201, stored normalized)',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 0}}, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110102), 'label': 'P value 999999999',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 999999999}}})
        check('2 price trigger value 999999999 adds (201, stored normalized, no triggerWarning)',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 999999999}}
              and 'triggerWarning' not in r, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100003), 'label': 'P valid price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('2 valid price trigger stored normalized (asset BTC)',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, r)
        txp = r['tx']['id']
        check('2 valid price add: holding price rides a triggerWarning on the response',
              isinstance(r.get('triggerWarning'), str) and 'would fire on the next evaluation' in r.get('triggerWarning'), r.get('triggerWarning'))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100005), 'label': 'U valid utxo',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}})
        check('2 valid utxo trigger stored normalized (condition spent, confirmations default 1)',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, r)
        txu = r['tx']['id']
        check('2 valid utxo add: unspent outpoint rides no triggerWarning',
              'triggerWarning' not in r, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100007), 'label': 'M valid manual',
                                                'trigger': {'type': 'manual', 'params': {}}})
        check('2 valid manual trigger stored normalized',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'manual', 'params': {}}, r)
        txm = r['tx']['id']

        # --- 3. migration ----------------------------------------------
        stj = load_state_file()
        legacy = [t for t in stj['bitcoin']['txs'] if t['id'] == txn][0]
        del legacy['trigger']
        save_state_file(stj)
        s, st = req('GET', '/api/state')
        tn = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txn][0]
        check('3 migration: a tx with NO trigger field reads as check-in at threshold 35',
              tn.get('trigger') == {'type': 'checkin', 'params': {'thresholdDays': 35}}, tn.get('trigger'))
        stj = load_state_file()
        legacy = [t for t in stj['bitcoin']['txs'] if t['id'] == txn][0]
        legacy['trigger'] = {'type': 'bogus', 'params': {}}
        save_state_file(stj)
        s, st = req('GET', '/api/state')
        tn = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txn][0]
        check('3 migration: a tx with a bogus trigger also defaults to check-in at threshold 35',
              tn.get('trigger') == {'type': 'checkin', 'params': {'thresholdDays': 35}}, tn.get('trigger'))

        # --- 4. check-in trigger unchanged ------------------------------
        delete_all_txs()
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100011), 'label': 'C4a checkin 35',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txc4a = r['tx']['id']
        set_clock(100)
        s, r, res = release_results()
        check('4 check-in tx (threshold 35), clock 100 days back -> one release check broadcasts it',
              r.get('action') == 'broadcast' and res.get(txc4a, {}).get('action') == 'broadcast'
              and res.get(txc4a, {}).get('method') == 'primary', res.get(txc4a))
        c4a = state_tx(txc4a)
        check("4 the broadcast's release record carries trigger 'checkin'",
              ((c4a or {}).get('release') or {}).get('trigger') == 'checkin' and ((c4a or {}).get('release') or {}).get('kind') == 'release', (c4a or {}).get('release'))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100013), 'label': 'C4b threshold 5',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 5}}})
        txc4b5 = r['tx']['id']
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100015), 'label': 'C4b threshold 35',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txc4b35 = r['tx']['id']
        set_clock(6)
        s, r, res = release_results()
        check('4 same clock 6 days back: threshold-5 tx fires',
              res.get(txc4b5, {}).get('action') == 'broadcast', res.get(txc4b5))
        check('4 same clock 6 days back: threshold-35 tx does NOT fire (on-track)',
              res.get(txc4b35, {}).get('action') == 'skipped' and res.get(txc4b35, {}).get('triggerStatus') == 'on-track',
              res.get(txc4b35))
        check('4 same clock 6 days back: the threshold-35 tx is still un-broadcast',
              not (state_tx(txc4b35) or {}).get('broadcasted'), state_tx(txc4b35))
        # (0.8.5) An already-broadcast tx is skipped before its rules
        # are evaluated at all, so the clock no longer matters for
        # it: at 6 days back it is skipped as already broadcast,
        # exactly as at 100 days back below. The old eval-first
        # behaviour — skipped with the live 'on-track' trigger
        # status — is gone by design: an archived tx causes
        # nothing to happen, and its release-check result carries
        # no trigger status.
        check('4 already-broadcast check-in tx is skipped (already broadcast, no trigger status)',
              res.get(txc4a, {}).get('action') == 'skipped' and res.get(txc4a, {}).get('reason') == 'already broadcast'
              and 'triggerStatus' not in (res.get(txc4a) or {}), res.get(txc4a))
        set_clock(100)
        s, r, res = release_results()
        check('4 backdated again: a firing trigger on an already-broadcast tx is skipped as already broadcast',
              res.get(txc4a, {}).get('action') == 'skipped' and res.get(txc4a, {}).get('reason') == 'already broadcast', res.get(txc4a))
        check('4 backdated again: the threshold-5 tx (also broadcasted) is skipped as already broadcast',
              res.get(txc4b5, {}).get('action') == 'skipped' and res.get(txc4b5, {}).get('reason') == 'already broadcast', res.get(txc4b5))
        check('4 backdated again: the threshold-35 tx now fires and broadcasts',
              res.get(txc4b35, {}).get('action') == 'broadcast', res.get(txc4b35))

        # --- 5. guards stay check-in-only ------------------------------
        delete_all_txs()
        set_clock(30)  # 5 days left of 35 — inside the 25% danger zone
        before = checkin_last()
        check('5 setup: clock is 30 days back (danger zone, 5 days left)',
              before is not None and abs((datetime.now(timezone.utc) - datetime.fromisoformat(before.replace('Z', '+00:00'))).total_seconds() - 30 * 86400) < 300, before)
        # (a) adding price + utxo txs must NOT reset; a global
        # threshold PUT is gone entirely (400 — section 16 covers
        # the per-tx bars that replace it).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100501), 'label': 'P5 price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp5 = r['tx']['id']
        check('5a adding a price tx in the danger zone: 201, no checkinReset',
              s == 201 and 'checkinReset' not in r, r)
        check('5a adding a price tx in the danger zone: the check-in clock is unchanged',
              checkin_last() == before, (checkin_last(), before))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100503), 'label': 'U5 utxo',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}})
        txu5 = r['tx']['id']
        check('5a adding a utxo tx in the danger zone: 201, no checkinReset',
              s == 201 and 'checkinReset' not in r, r)
        check('5a adding a utxo tx in the danger zone: the check-in clock is unchanged',
              checkin_last() == before, (checkin_last(), before))
        s, r = req('PUT', '/api/settings', {'thresholdDays': 7})
        check('5a a global threshold PUT is a 400 (the setting is gone)',
              s == 400 and 'no longer a setting' in (r.get('error') or ''), (s, r))
        check('5a the rejected threshold PUT left the check-in clock unchanged',
              checkin_last() == before, (checkin_last(), before))
        s, st = req('GET', '/api/state')
        check('5a the settings carry no thresholdDays after the rejected PUT',
              'thresholdDays' not in st.get('settings', {}), st.get('settings'))
        # (b) arming a price tx in the danger zone must NOT reset
        s, r = req('PUT', '/api/bitcoin/txs/' + txp5, {'enabled': False})
        check('5b disarming the price tx (setup)', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txp5, {'enabled': True})
        check('5b arming a price tx in the danger zone: no checkinReset',
              s == 200 and 'checkinReset' not in r, r)
        check('5b arming a price tx in the danger zone: the check-in clock is unchanged',
              checkin_last() == before, (checkin_last(), before))
        # (c) a price tx's broadcast record survives a check-in; a check-in tx's does not
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100505), 'label': 'C5 checkin',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txc5 = r['tx']['id']
        check('5c control: adding a CHECK-IN tx in the danger zone DOES reset (add-reset)',
              s == 201 and r.get('checkinReset') is True, r)
        s, r = req('POST', '/api/bitcoin/txs/' + txp5 + '/broadcast', {})
        check('5c manual broadcast of the price tx', s == 200 and r.get('action') == 'broadcast', r)
        s, r = req('POST', '/api/bitcoin/txs/' + txc5 + '/broadcast', {})
        check('5c manual broadcast of the check-in tx', s == 200 and r.get('action') == 'broadcast', r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('5c check-in lands', s == 200 and r.get('ok') is True, r)
        p5 = state_tx(txp5)
        c5 = state_tx(txc5)
        check("5c a check-in does NOT clear a price tx's 'broadcast' release record",
              ((p5 or {}).get('release') or {}).get('status') == 'broadcast' and ((p5 or {}).get('release') or {}).get('trigger') == 'price', (p5 or {}).get('release'))
        check("5c the same check-in DOES clear a check-in tx's 'broadcast' release record",
              (c5 or {}).get('release') is None, (c5 or {}).get('release'))
        check('5c the price tx broadcasted fact survives the check-in',
              bool((p5 or {}).get('broadcasted')), (p5 or {}).get('broadcasted'))
        s, st = req('GET', '/api/status')
        check('5c after the check-in the status is On track', st.get('state') == 'on-track', st.get('state'))
        # (d) a price broadcast via a release check must NOT flip the check-in card.
        # The tx is added AFTER the restart: the startup full tick
        # would broadcast a due price tx on its own, so the add
        # comes after it and the release check is what broadcasts.
        check('5d restart before the release check (fresh price-tick clock, empty price cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100507), 'label': 'P5d price release',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp5d = r['tx']['id']
        check('5d price tx added (clock on-track)', s == 201, r)
        s, r, res = release_results()
        check('5d a price tx broadcasts at once via the release check (clock on-track)',
              res.get(txp5d, {}).get('action') == 'broadcast' and res.get(txp5d, {}).get('method') == 'primary', res.get(txp5d))
        p5d = state_tx(txp5d)
        check("5d the release record carries trigger 'price'",
              ((p5d or {}).get('release') or {}).get('trigger') == 'price' and ((p5d or {}).get('release') or {}).get('kind') == 'release', (p5d or {}).get('release'))
        s, st = req('GET', '/api/status')
        check("5d after a price broadcast the check-in card is still 'on-track', not 'broadcasted'",
              st.get('state') == 'on-track' and st.get('label') == 'On track', st)

        # --- 6. price trigger ------------------------------------------
        # (a) immediate fire — a holding price broadcasts on the
        # FIRST evaluation (no sustained wait); below threshold
        # does not fire; the triggerState carries no sustained
        # clock (no `since` field).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100601), 'label': 'P6a immediate',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp6a = r['tx']['id']
        check('6a holding price tx added', s == 201, r)
        s, r, res = release_results()
        p6a_res = res.get(txp6a, {})
        check('6a first eval: holding fires at once (broadcast, primary)',
              p6a_res.get('action') == 'broadcast' and p6a_res.get('method') == 'primary', p6a_res)
        p6a = state_tx(txp6a)
        check('6a the firing triggerState status is due',
              (p6a or {}).get('triggerState', {}).get('status') == 'due', (p6a or {}).get('triggerState'))
        check('6a the firing triggerState carries no sustained clock (no since field)',
              'since' not in ((p6a or {}).get('triggerState') or {}), (p6a or {}).get('triggerState'))
        check("6a the broadcast's release record carries trigger 'price'",
              ((p6a or {}).get('release') or {}).get('trigger') == 'price', (p6a or {}).get('release'))
        check('6a /api/state carries the cached price ($98,200) after the eval',
              (lambda st2: st2.get('bitcoin', {}).get('currentPrice') == 98200)(req('GET', '/api/state')[1]),
              req('GET', '/api/state')[1].get('bitcoin'))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100603), 'label': 'P6b below threshold',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        txp6b = r['tx']['id']
        check('6a below-threshold price tx added (no triggerWarning — not holding)',
              s == 201 and 'triggerWarning' not in r, r)
        s, r, res = release_results()
        p6b_res = res.get(txp6b, {})
        check('6a below threshold -> no fire (skipped, watching, currently $98,200)',
              p6b_res.get('action') == 'skipped' and p6b_res.get('triggerStatus') == 'watching'
              and 'currently $98,200' in (p6b_res.get('reason') or ''), p6b_res)
        check('6a below threshold -> triggerState carries no sustained clock (no since field)',
              'since' not in ((state_tx(txp6b) or {}).get('triggerState') or {}), (state_tx(txp6b) or {}).get('triggerState'))
        # (b) fail-safe — feed down -> unknown, no fire, lastError set
        s, pr = set_price(fail=True)
        check('6b stub price feed set to fail', s == 200 and pr.get('coingecko', {}).get('fail') is True and pr.get('coinbase', {}).get('fail') is True, pr)
        check('6b caches cleared so the eval actually hits the failing feed (empty cache)', clear_caches())
        s, r, res = release_results()
        p6b_res = res.get(txp6b, {})
        check('6b feed down -> release check gives status unknown, no fire',
              p6b_res.get('action') == 'skipped' and p6b_res.get('triggerStatus') == 'unknown'
              and 'unavailable' in (p6b_res.get('reason') or ''), p6b_res)
        p6b = state_tx(txp6b)
        check('6b feed down -> triggerState.lastError is set (and the last good price is kept)',
              bool((p6b or {}).get('triggerState', {}).get('lastError'))
              and (p6b or {}).get('triggerState', {}).get('lastPrice') == 98200, (p6b or {}).get('triggerState'))
        check('6b feed down -> the tx is not broadcast', not (p6b or {}).get('broadcasted'), (p6b or {}).get('broadcasted'))
        s, pr = set_price(fail=False)
        check('6b stub price feed restored', s == 200 and pr.get('coingecko', {}).get('fail') is False and pr.get('coinbase', {}).get('fail') is False, pr)
        # (c) malformed readings — zero / empty each -> unknown, no
        # fire. A huge reading both sources agree on is NOT
        # malformed: with no range check the agreement is the only
        # protection, so $1,000,000,000,000 fires at once (below).
        for bad in ('zero', 'empty'):
            s, pr = set_price(bad=bad)
            check('6c stub price set to bad=%s' % bad, s == 200 and pr.get('coingecko', {}).get('bad') == bad and pr.get('coinbase', {}).get('bad') == bad, pr)
            check('6c caches cleared before the bad=%s eval (empty cache)' % bad, clear_caches())
            s, r, res = release_results()
            p6b_res = res.get(txp6b, {})
            ok = p6b_res.get('action') == 'skipped' and p6b_res.get('triggerStatus') == 'unknown'
            check('6c malformed reading %s -> unknown, no fire' % bad, ok, p6b_res)
            p6b = state_tx(txp6b)
            check('6c malformed reading %s -> triggerState.lastError is set' % bad,
                  bool((p6b or {}).get('triggerState', {}).get('lastError')), (p6b or {}).get('triggerState'))
            check('6c malformed reading %s -> the tx is not broadcast' % bad,
                  not (p6b or {}).get('broadcasted'), (p6b or {}).get('broadcasted'))
            s, pr = set_price(bad=None)
            check('6c bad reading cleared after %s' % bad, s == 200 and pr.get('coingecko', {}).get('bad') is None and pr.get('coinbase', {}).get('bad') is None, pr)
        check('6c caches cleared after clearing the bad readings (cache back to $98,200)', clear_caches())
        # A huge reading ($1,000,000,000,000) both sources agree on
        # is trusted — it fires at once, like any holding price.
        s, pr = set_price(bad='huge')
        check('6c stub price set to bad=huge', s == 200 and pr.get('coingecko', {}).get('bad') == 'huge' and pr.get('coinbase', {}).get('bad') == 'huge', pr)
        check('6c caches cleared before the huge eval (empty cache)', clear_caches())
        s, r, res = release_results()
        p6b_res = res.get(txp6b, {})
        check('6c huge reading both sources agree on -> fires at once (broadcast, primary)',
              p6b_res.get('action') == 'broadcast' and p6b_res.get('method') == 'primary', p6b_res)
        p6b = state_tx(txp6b)
        check('6c huge reading -> the firing triggerState status is due',
              (p6b or {}).get('triggerState', {}).get('status') == 'due', (p6b or {}).get('triggerState'))
        check('6c huge reading -> the accepted reading becomes the last good reading ($1,000,000,000,000, no error)',
              (p6b or {}).get('triggerState', {}).get('lastPrice') == 1000000000000
              and (p6b or {}).get('triggerState', {}).get('lastError') is None, (p6b or {}).get('triggerState'))
        s, pr = set_price(bad=None)
        check('6c bad reading cleared after huge', s == 200 and pr.get('coingecko', {}).get('bad') is None and pr.get('coinbase', {}).get('bad') is None, pr)
        check('6c caches cleared after clearing the huge reading (cache back to $98,200)', clear_caches())
        # (d) already-true — holding price -> status due, fire true
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('6d /api/triggers/check on a holding price trigger -> status due, fire true',
              s == 200 and r.get('valid') is True and r.get('fire') is True and r.get('status') == 'due', r)
        check('6d /api/triggers/check holding -> a warning that it would fire on the next evaluation',
              isinstance(r.get('warning'), str) and 'would fire on the next evaluation' in r.get('warning'), r.get('warning'))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        check('6d /api/triggers/check on an on-track check-in trigger -> on-track, no warning',
              s == 200 and r.get('fire') is False and r.get('status') == 'on-track' and r.get('warning') is None, r)
        # (d2) check-in /api/triggers/check with a txId counts the
        # tx's frozen time — a tx disarmed for 20 days, clock 40
        # days back, threshold 35: raw the clock is past due, but
        # the effective clock (40 - 20 = 20 days) is on-track.
        # Without the txId the freeze is not counted (a new tx has
        # none), so the same trigger reads release-due.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100607), 'label': 'P6d freeze check',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txp6d2 = r['tx']['id']
        check('6d freeze setup: check-in tx added', s == 201 and txp6d2, r)
        set_clock_margin(40)
        set_tx_freeze(txp6d2, offset_ms=20 * 86400000)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}, 'txId': txp6d2})
        check('6d /api/triggers/check with txId counts the frozen time -> on-track, no fire (40 - 20 = 20 of 35 days)',
              s == 200 and r.get('fire') is False and r.get('status') == 'on-track' and r.get('warning') is None, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        check('6d /api/triggers/check without txId ignores the freeze -> release-due, fire true (40 of 35 days)',
              s == 200 and r.get('fire') is True and r.get('status') == 'release-due' and r.get('warning') is not None, r)
        # Restore the clock so the rest of section 6 is not
        # evaluated against a 40-day-back clock.
        set_clock_margin(0)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100605), 'label': 'P6d holding add',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp6d = r['tx']['id']
        check('6d adding a holding price tx returns triggerWarning that it would fire on the next evaluation',
              s == 201 and isinstance(r.get('triggerWarning'), str) and 'would fire on the next evaluation' in r.get('triggerWarning'), r.get('triggerWarning'))
        # (e) a large jump both sources agree on is trusted and
        # fires — there is no range check: the
        # two-source agreement is the only protection. A fresh
        # below-threshold price tx watches at $98,200; a $1,000,000
        # reading (10.2x) fires at once. (txp6b broadcast in 6c's
        # huge case, so this section uses its own tx.)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100609), 'label': 'P6e jump',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        txp6e = r['tx']['id']
        check('6e below-threshold price tx added (no triggerWarning — not holding)',
              s == 201 and 'triggerWarning' not in r, r)
        s, r, res = release_results()
        p6e_res = res.get(txp6e, {})
        check('6e below threshold -> no fire (skipped, watching, currently $98,200)',
              p6e_res.get('action') == 'skipped' and p6e_res.get('triggerStatus') == 'watching'
              and 'currently $98,200' in (p6e_res.get('reason') or ''), p6e_res)
        p6e = state_tx(txp6e)
        check('6e setup: the last good reading is $98,200 and recent (within 1 hour)',
              (p6e or {}).get('triggerState', {}).get('lastPrice') == 98200
              and abs((datetime.now(timezone.utc) - datetime.fromisoformat(((p6e or {}).get('triggerState', {}).get('lastPriceAt') or iso_now()).replace('Z', '+00:00'))).total_seconds()) < 3600,
              (p6e or {}).get('triggerState'))
        s, pr = set_price(usd=1000000)
        check('6e stub price set to $1,000,000', s == 200 and pr.get('coingecko', {}).get('usd') == 1000000 and pr.get('coinbase', {}).get('usd') == 1000000, pr)
        check('6e caches cleared so the eval reads $1,000,000 (empty cache)', clear_caches())
        s, r, res = release_results()
        p6e_res = res.get(txp6e, {})
        check('6e $1,000,000 vs a recent $98,200 last reading -> evaluated on its merits and fires at once (broadcast)',
              p6e_res.get('action') == 'broadcast' and p6e_res.get('method') == 'primary', p6e_res)
        p6e = state_tx(txp6e)
        check('6e the firing triggerState status is due',
              (p6e or {}).get('triggerState', {}).get('status') == 'due', (p6e or {}).get('triggerState'))
        check('6e the accepted reading becomes the last good reading ($1,000,000, no error)',
              (p6e or {}).get('triggerState', {}).get('lastPrice') == 1000000
              and (p6e or {}).get('triggerState', {}).get('lastError') is None, (p6e or {}).get('triggerState'))
        s, pr = set_price(usd=98200)
        check('6e stub price restored to $98,200', s == 200 and pr.get('coingecko', {}).get('usd') == 98200 and pr.get('coinbase', {}).get('usd') == 98200, pr)

        # --- 7. utxo trigger -------------------------------------------
        # (a) confirmed-only — unconfirmed stub: watching; confirmed stub: broadcast
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100701), 'label': 'U7a conflict unconfirmed',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': CONFLICT + ':0'}}})
        txu7a = r['tx']['id']
        check('7a adding a utxo tx on an unconfirmed spend -> 201 WITH triggerWarning (not a 400)',
              s == 201 and isinstance(r.get('triggerWarning'), str) and 'unconfirmed' in r.get('triggerWarning'), r.get('triggerWarning'))
        s, r, res = release_results()
        u7a_res = res.get(txu7a, {})
        check('7a primary unconfirmed: a utxo tx on an unconfirmed spend -> watching, no fire',
              u7a_res.get('action') == 'skipped' and u7a_res.get('triggerStatus') == 'watching'
              and 'unconfirmed' in (u7a_res.get('reason') or ''), u7a_res)
        check('7a primary unconfirmed: the tx is not broadcast', not (state_tx(txu7a) or {}).get('broadcasted'), state_tx(txu7a))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_S})
        check('7a primary switched to the confirmed stub', s == 200 and r.get('primaryApiUrl') == STUB_BASE_S, r)
        s, r, res = release_results()
        check('7a primary confirmed: the next release check broadcasts it',
              res.get(txu7a, {}).get('action') == 'broadcast' and res.get(txu7a, {}).get('method') == 'primary', res.get(txu7a))
        u7a = state_tx(txu7a)
        check("7a the broadcast's release record carries trigger 'utxo'",
              ((u7a or {}).get('release') or {}).get('trigger') == 'utxo', (u7a or {}).get('release'))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P})
        check('7a primary restored to the unconfirmed stub', s == 200 and r.get('primaryApiUrl') == STUB_BASE_P, r)
        # (b) already-spent — /api/triggers/check fires; add gates on triggerConfirmed
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0'}}})
        check('7b /api/triggers/check on Finney:0 (confirmed spent) -> fire true + warning',
              s == 200 and r.get('valid') is True and r.get('fire') is True and isinstance(r.get('warning'), str), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100703), 'label': 'U7b spent no confirm',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0'}}})
        check('7b adding an already-spent utxo tx WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already spent' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100703), 'label': 'U7b spent confirmed',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0'}},
                                                'triggerConfirmed': True})
        txu7b = r['tx']['id'] if s == 201 else None
        check('7b adding the same tx WITH triggerConfirmed -> 201, with the already-spent warning',
              s == 201 and isinstance(r.get('triggerWarning'), str) and 'already spent' in r.get('triggerWarning'), r.get('triggerWarning'))
        if txu7b:
            req('DELETE', '/api/bitcoin/txs/' + txu7b)
        # (c) fail-safe — both endpoints dead -> unknown, no fire
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:19000',
                                            'secondaryApiUrl': 'http://127.0.0.1:19001'})
        check('7c endpoints pointed at closed ports', s == 200, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100705), 'label': 'U7c dead endpoints',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': SECOND + ':0'}}})
        txu7c = r['tx']['id']
        check('7c adding a utxo tx with dead endpoints -> 201, no warning (unknown is not a block)',
              s == 201 and 'triggerWarning' not in r, r)
        s, r, res = release_results()
        u7c_res = res.get(txu7c, {})
        check('7c dead endpoints -> release check gives status unknown, no fire',
              u7c_res.get('action') == 'skipped' and u7c_res.get('triggerStatus') == 'unknown'
              and 'could not check' in (u7c_res.get('reason') or ''), u7c_res)
        u7c = state_tx(txu7c)
        check('7c dead endpoints -> triggerState.lastError is set',
              bool((u7c or {}).get('triggerState', {}).get('lastError')), (u7c or {}).get('triggerState'))
        check('7c dead endpoints -> the tx is not broadcast', not (u7c or {}).get('broadcasted'), (u7c or {}).get('broadcasted'))
        req('DELETE', '/api/bitcoin/txs/' + txu7c)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S})
        check('7c endpoints restored to the stubs', s == 200 and r.get('primaryApiUrl') == STUB_BASE_P, r)
        # (d) unconfirmed spend at add time is a warning only
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100707), 'label': 'U7d unconfirmed add',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': CONFLICT + ':0'}}})
        txu7d = r['tx']['id'] if s == 201 else None
        check('7d unconfirmed spend at add time -> 201 WITH triggerWarning (not a 400)',
              s == 201 and isinstance(r.get('triggerWarning'), str) and 'unconfirmed' in r.get('triggerWarning'), r.get('triggerWarning'))
        if txu7d:
            req('DELETE', '/api/bitcoin/txs/' + txu7d)

        # --- 8. trigger validation at edit ------------------------------
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100801), 'label': 'E8 edit test',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txe8 = r['tx']['id']
        check('8 edit test tx added', s == 201, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txe8, {'trigger': {'type': 'price', 'params': {'op': '>', 'value': 90000}}})
        check('8 PUT with a bad trigger -> 400', s == 400 and 'invalid trigger' in (r.get('error') or ''), (s, r))
        patch_trigger_state(txe8, lastPrice=98200, lastPriceAt=iso_now(), status='watching')
        check('8 triggerState seeded on the tx', bool((state_tx(txe8) or {}).get('triggerState', {}).get('lastPrice')), state_tx(txe8))
        s, r = req('PUT', '/api/bitcoin/txs/' + txe8, {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}})
        check('8 a valid trigger change clears triggerState',
              s == 200 and r.get('tx', {}).get('triggerState') is None
              and r.get('tx', {}).get('trigger') == {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txp6a, {'trigger': {'type': 'manual', 'params': {}}})
        check('8 a trigger change on a locked (broadcasted) tx -> 400',
              s == 400 and 'cannot be changed' in (r.get('error') or ''), (s, r))
        s, st = req('GET', '/api/state')
        p6a = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txp6a][0]
        check('8 the rejected trigger change left the broadcasted tx untouched',
              p6a.get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}
              and bool(p6a.get('broadcasted')), p6a)

        # --- 9. one release check evaluates per-tx triggers ------------
        delete_all_txs()
        # Section 6e left a $1,000,000 reading in the price cache —
        # without a restart the below-threshold add below would read
        # it as holding and the price gate would 400 it.
        check('9 caches cleared before the adds (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100901), 'label': 'R9c due checkin',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txr9c = r['tx']['id']
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100907), 'label': 'R9low below threshold',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        txr9low = r['tx']['id']
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100909), 'label': 'R9m manual',
                                                'trigger': {'type': 'manual', 'params': {}}})
        txr9m = r['tx']['id']
        check('9 three txs added (clock on-track)', s == 201, r)
        check('9 restart before the release check (fresh tick clock, empty cache)', restart())
        # The due price tx is added AFTER the restart, beside the
        # UTXO tx: the startup full tick would broadcast it on its
        # own, and the point here is that ONE release check
        # broadcasts everything due at once.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100903), 'label': 'R9p price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txr9p = r['tx']['id']
        check('9 due price tx added after the restart (triggerConfirmed)', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100905), 'label': 'R9u confirmed spent',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0'}},
                                                'triggerConfirmed': True})
        txr9u = r['tx']['id']
        check('9 confirmed-spent utxo tx added after the restart (triggerConfirmed)', s == 201, r)
        set_clock(100)
        s, r, res = release_results()
        check('9 one release check: action is broadcast', r.get('action') == 'broadcast', r.get('action'))
        check('9 one release check: the due check-in tx broadcasts',
              res.get(txr9c, {}).get('action') == 'broadcast', res.get(txr9c))
        check('9 one release check: the price tx broadcasts at once (no sustained wait)',
              res.get(txr9p, {}).get('action') == 'broadcast', res.get(txr9p))
        check('9 one release check: the confirmed-spent utxo tx broadcasts',
              res.get(txr9u, {}).get('action') == 'broadcast', res.get(txr9u))
        check('9 one release check: the below-threshold price tx is skipped (watching)',
              res.get(txr9low, {}).get('action') == 'skipped' and res.get(txr9low, {}).get('triggerStatus') == 'watching'
              and res.get(txr9low, {}).get('trigger') == 'price', res.get(txr9low))
        check('9 one release check: the manual tx is skipped (manual, never fires)',
              res.get(txr9m, {}).get('action') == 'skipped' and res.get(txr9m, {}).get('triggerStatus') == 'manual'
              and res.get(txr9m, {}).get('trigger') == 'manual', res.get(txr9m))
        check('9 the manual tx reason states the waiting state, not the condition',
              res.get(txr9m, {}).get('reason') == 'Waiting for manual broadcast', res.get(txr9m))
        s, st = req('GET', '/api/state')
        txs9 = {t.get('id'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check("9 each broadcast's release record carries the right trigger type",
              (txs9[txr9c].get('release') or {}).get('trigger') == 'checkin'
              and (txs9[txr9p].get('release') or {}).get('trigger') == 'price'
              and (txs9[txr9u].get('release') or {}).get('trigger') == 'utxo',
              {k: txs9[k].get('release') for k in (txr9c, txr9p, txr9u)})
        check('9 the skipped txs carry no release record',
              txs9[txr9low].get('release') is None and txs9[txr9m].get('release') is None,
              (txs9[txr9low].get('release'), txs9[txr9m].get('release')))

        # --- 10. restore carries trigger/triggerState, refreshes clock --
        s, bak = req('GET', '/api/backup')
        check('10 backup taken (5 txs)', s == 200 and len(bak.get('state', {}).get('bitcoin', {}).get('txs', [])) == 5, len(bak.get('state', {}).get('bitcoin', {}).get('txs', [])))
        bak_triggers = {t['id']: t.get('trigger') for t in bak['state']['bitcoin']['txs']}
        bak_states = {t['id']: t.get('triggerState') for t in bak['state']['bitcoin']['txs']}
        s, r = req('POST', '/api/restore', bak)
        check('10 restore lands', s == 200 and r.get('restoredTxs') == 5, r)
        s, st = req('GET', '/api/state')
        txs10 = {t.get('id'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check('10 restore: the txs keep their triggers',
              all(txs10[k].get('trigger') == bak_triggers[k] for k in bak_triggers), {k: txs10[k].get('trigger') for k in bak_triggers})
        check('10 restore: the price tx keeps its triggerState (same lastPrice, no sustained clock)',
              (txs10[txr9p].get('triggerState') or {}).get('lastPrice') == 98200
              and 'since' not in (txs10[txr9p].get('triggerState') or {}),
              txs10[txr9p].get('triggerState'))
        ck = st.get('checkin', {})
        ck_dt = datetime.fromisoformat((ck.get('lastCheckinAt') or '').replace('Z', '+00:00')) if ck.get('lastCheckinAt') else None
        check('10 restore: lastCheckinAt is the restore moment (within minutes), not the backup\'s 100 days back',
              ck_dt is not None and abs((datetime.now(timezone.utc) - ck_dt).total_seconds()) < 300, ck.get('lastCheckinAt'))
        # (0.8.1, audit: restored `broadcasted` records) A broadcasted
        # fact + a 'broadcast' release record are NOT believed from a
        # backup on txid match alone — both are dropped and the tx
        # comes back active, to be re-derived from the network.
        check('10 restore: broadcasted facts + broadcast release records are dropped (re-derived from the network)',
              txs10[txr9c].get('broadcasted') is None and txs10[txr9c].get('release') is None, txs10[txr9c])
        # The clock is fresh (asserted above), and with the broadcast
        # record dropped the status reads the clock: 'on-track'.
        s, st = req('GET', '/api/status')
        check("10 restore: the status is 'on-track' — the dropped broadcast record no longer overrides the fresh clock",
              st.get('state') == 'on-track', st.get('state'))

        # --- 11. utxo confirmation modes --------------------------------
        # Stub facts: FINNEY:0 is a confirmed spend at block 899990
        # (tip 900000 -> 11 confirmations); CONFLICT:0 is an
        # unconfirmed spend on the primary stub and a confirmed spend
        # (11 confirmations) on the secondary.
        delete_all_txs()
        # (a) unconfirmed mode (0) fires on an unconfirmed spend.
        # The add-time gate sees it as already satisfied (fire).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101101), 'label': 'U11a unconfirmed fires',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': CONFLICT + ':0', 'confirmations': 0}}})
        check('11a adding an unconfirmed-mode tx on an unconfirmed spend WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already spent' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101101), 'label': 'U11a unconfirmed fires',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': CONFLICT + ':0', 'confirmations': 0}},
                                                'triggerConfirmed': True})
        txu11a = r['tx']['id'] if s == 201 else None
        check('11a the same tx WITH triggerConfirmed -> 201, stored with confirmations 0',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'utxo', 'params': {'outpoint': CONFLICT + ':0', 'condition': 'spent', 'confirmations': 0}}, r)
        s, r, res = release_results()
        check('11a one release check: the unconfirmed-mode tx broadcasts on the unconfirmed spend',
              res.get(txu11a, {}).get('action') == 'broadcast', res.get(txu11a))
        check("11a the broadcast's release record carries trigger 'utxo'",
              ((state_tx(txu11a) or {}).get('release') or {}).get('trigger') == 'utxo', (state_tx(txu11a) or {}).get('release'))
        # (b) N confirmations fires at the threshold (11 of 11).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101103), 'label': 'U11b 11 of 11',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 11}},
                                                'triggerConfirmed': True})
        txu11b = r['tx']['id'] if s == 201 else None
        check('11b N=11 tx on FINNEY:0 (11 confirmations) added with triggerConfirmed -> 201', s == 201, r)
        s, r, res = release_results()
        check('11b one release check: the N=11 tx broadcasts (11 of 11, at threshold)',
              res.get(txu11b, {}).get('action') == 'broadcast', res.get(txu11b))
        # (c) N confirmations watches below the threshold (11 of 12).
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 12}}})
        check('11c /api/triggers/check on FINNEY:0 with N=12 -> fire false, 11 of 12',
              s == 200 and r.get('fire') is False and r.get('detail', {}).get('confirmations') == 11
              and '11 of 12' in (r.get('reason') or ''), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101105), 'label': 'U11c 11 of 12',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 12}}})
        txu11c = r['tx']['id'] if s == 201 else None
        check('11c adding an N=12 tx WITHOUT triggerConfirmed -> 201 (not yet firing, no block)',
              s == 201, r)
        s, r, res = release_results()
        check('11c one release check: the N=12 tx is skipped, watching with progress',
              res.get(txu11c, {}).get('action') == 'skipped' and res.get(txu11c, {}).get('triggerStatus') == 'watching'
              and '11 of 12' in (res.get(txu11c, {}).get('reason') or ''), res.get(txu11c))
        check('11c the N=12 tx is not broadcast', not (state_tx(txu11c) or {}).get('broadcasted'), state_tx(txu11c))
        # (d) the already-spent guard is mode-aware: N=6 fires
        # (11 >= 6), N=12 does not (11 < 12).
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 6}}})
        check('11d /api/triggers/check on FINNEY:0 with N=6 -> fire true (11 >= 6)',
              s == 200 and r.get('fire') is True and r.get('detail', {}).get('confirmations') == 11, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101107), 'label': 'U11d N=6 no confirm',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 6}}})
        check('11d adding an N=6 tx WITHOUT triggerConfirmed -> 400 (already satisfied)',
              s == 400 and 'already spent' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101107), 'label': 'U11d N=6 confirmed',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 6}},
                                                'triggerConfirmed': True})
        check('11d the same N=6 tx WITH triggerConfirmed -> 201', s == 201, r)
        if s == 201:
            req('DELETE', '/api/bitcoin/txs/' + r['tx']['id'])
        # (e) validation: confirmations must be an integer 0..100.
        for bad, why in ((-1, 'negative'), (101, 'over 100'), (1.5, 'non-integer'), ('6', 'string'), (None, 'null')):
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101109), 'label': 'U11e bad confs',
                                                    'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': bad}}})
            check('11e confirmations %s (%s) -> 400 invalid trigger' % (bad, why),
                  s == 400 and 'invalid trigger' in (r.get('error') or ''), (s, r))
        # (f) the default is still 1 (confirmed-only) when omitted.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101111), 'label': 'U11f default',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}})
        check('11f a utxo trigger with no confirmations stores confirmations 1',
              s == 201 and r.get('tx', {}).get('trigger', {}).get('params', {}).get('confirmations') == 1, r)
        # (g) the edit path gates the same way (PUT without
        # triggerConfirmed on an already-satisfied utxo rule -> 400).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 101113), 'label': 'U11g edit gate',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txu11g = r['tx']['id'] if s == 201 else None
        check('11g a check-in tx added for the edit gate', s == 201, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txu11g, {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 6}}})
        check('11g PUT to an already-satisfied utxo rule WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already spent' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/bitcoin/txs/' + txu11g, {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 6}}, 'triggerConfirmed': True})
        check('11g the same PUT WITH triggerConfirmed -> 200, stored with confirmations 6',
              s == 200 and r.get('tx', {}).get('trigger') == {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'condition': 'spent', 'confirmations': 6}}, r)

        # --- 12. two-source BTC price --------------------------------------
        # (a) settings defaults + provider list + the cache holds both
        # readings. A release check populates the price cache (armed
        # price txs exist), so read it right after one.
        s, r, res = release_results()
        s, st = req('GET', '/api/state')
        check('12a settings default to CoinGecko + Coinbase',
              st.get('settings', {}).get('priceSources') == {'source1': 'coingecko', 'source2': 'coinbase'}, st.get('settings'))
        check('12a /api/state serves the five price providers plus Custom',
              [p.get('id') for p in st.get('bitcoin', {}).get('priceProviders', [])] == ['coingecko', 'coinbase', 'binance', 'kraken', 'bitstamp', 'custom'],
              st.get('bitcoin', {}).get('priceProviders'))
        check('12a the Binance provider is Binance US (api.binance.com geo-blocks the US with 451)',
              {p.get('id'): p.get('label') for p in st.get('bitcoin', {}).get('priceProviders', [])}.get('binance') == 'Binance US (USDT)',
              st.get('bitcoin', {}).get('priceProviders'))
        check('12a the price cache holds BOTH readings, slot-keyed ($98,200 each)',
              (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('price') == 98200
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('price') == 98200,
              st.get('bitcoin', {}).get('currentPrices'))
        check('12a /api/state currentPrice is the primary exchange price ($98,200)',
              st.get('bitcoin', {}).get('currentPrice') == 98200, st.get('bitcoin', {}).get('currentPrice'))
        # (b) both agree within 5% -> valid; the rule fires at
        # once, and the stored state names both readings (dual mode).
        s, pr = set_price(usd=150000)
        check('12b stub price set to $150,000 on both sources',
              s == 200 and pr.get('coingecko', {}).get('usd') == 150000 and pr.get('coinbase', {}).get('usd') == 150000, pr)
        check('12b restart before the agree eval (empty cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120101), 'label': 'P12b agree fires',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 150000}}, 'triggerConfirmed': True})
        txp12b = r['tx']['id'] if s == 201 else None
        check('12b an agree price tx added (holding, triggerWarning that it would fire on the next evaluation)',
              s == 201 and isinstance(r.get('triggerWarning'), str) and 'would fire on the next evaluation' in r.get('triggerWarning'), r.get('triggerWarning'))
        s, r, res = release_results()
        check('12b both agree -> the rule broadcasts at once (immediate fire)',
              res.get(txp12b, {}).get('action') == 'broadcast' and res.get(txp12b, {}).get('method') == 'primary', res.get(txp12b))
        p12b = state_tx(txp12b)
        check('12b the firing state is dual mode and names both readings',
              (p12b or {}).get('triggerState', {}).get('priceMode') == 'dual'
              and 'CoinGecko $150,000' in ((p12b or {}).get('triggerState', {}).get('priceNote') or '')
              and 'Coinbase $150,000' in ((p12b or {}).get('triggerState', {}).get('priceNote') or ''),
              (p12b or {}).get('triggerState'))
        check("12b the release record carries trigger 'price'",
              ((p12b or {}).get('release') or {}).get('trigger') == 'price', (p12b or {}).get('release'))
        # (c) disagree by more than 5% -> unknown, never fires, the
        # reason names the disagreement.
        s, pr = set_price(usd=100000, provider='coingecko')
        check('12c CoinGecko set to $100,000', s == 200 and pr.get('coingecko', {}).get('usd') == 100000, pr)
        s, pr = set_price(usd=106000, provider='coinbase')
        check('12c Coinbase set to $106,000 (6% above CoinGecko)',
              s == 200 and pr.get('coinbase', {}).get('usd') == 106000, pr)
        check('12c caches cleared before the disagree eval (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120103), 'label': 'P12c disagree',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        txp12c = r['tx']['id'] if s == 201 else None
        check('12c a price tx added while the sources disagree', s == 201, r)
        # Seed a prior GOOD reading (no sustained clock — just the
        # last price): the fail-safe must keep it across the
        # disagreement instead of letting the bad reading replace it.
        patch_trigger_state(txp12c, lastPrice=98200, lastPriceAt=iso_now(), status='watching')
        s, r, res = release_results()
        p12c_res = res.get(txp12c, {})
        check('12c disagree -> unknown, no fire, the reason names the disagreement',
              p12c_res.get('action') == 'skipped' and p12c_res.get('triggerStatus') == 'unknown'
              and 'disagree' in (p12c_res.get('reason') or '')
              and '$100,000' in (p12c_res.get('reason') or '')
              and '$106,000' in (p12c_res.get('reason') or ''), p12c_res)
        check('12c disagree -> the tx is not broadcast', not (state_tx(txp12c) or {}).get('broadcasted'), state_tx(txp12c))
        p12c = state_tx(txp12c)
        check('12c disagree -> triggerState keeps the last good price (fail-safe, no sustained clock to reset)',
              (p12c or {}).get('triggerState', {}).get('lastPrice') == 98200
              and 'since' not in ((p12c or {}).get('triggerState') or {}), (p12c or {}).get('triggerState'))
        # (d) one source fails -> single-source mode, no 5% check,
        # the rule fires normally on the surviving price.
        s, pr = set_price(fail=True, provider='coingecko')
        check('12d CoinGecko set to fail', s == 200 and pr.get('coingecko', {}).get('fail') is True, pr)
        s, pr = set_price(usd=150000, provider='coinbase')
        check('12d Coinbase set to $150,000', s == 200 and pr.get('coinbase', {}).get('usd') == 150000, pr)
        check('12d restart before the single-source eval (empty cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120105), 'label': 'P12d single source',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 150000}}, 'triggerConfirmed': True})
        txp12d = r['tx']['id'] if s == 201 else None
        check('12d a single-source price tx added', s == 201, r)
        s, r, res = release_results()
        check('12d one source down -> the rule still broadcasts on the survivor',
              res.get(txp12d, {}).get('action') == 'broadcast' and res.get(txp12d, {}).get('method') == 'primary', res.get(txp12d))
        p12d = state_tx(txp12d)
        check('12d the firing state is single mode and names the survivor',
              (p12d or {}).get('triggerState', {}).get('priceMode') == 'single'
              and 'Coinbase only' in ((p12d or {}).get('triggerState', {}).get('priceNote') or '')
              and 'CoinGecko unreachable' in ((p12d or {}).get('triggerState', {}).get('priceNote') or ''),
              (p12d or {}).get('triggerState'))
        s, pr = set_price(fail=False, provider='coingecko')
        check('12d CoinGecko restored', s == 200 and pr.get('coingecko', {}).get('fail') is False, pr)
        # (e) neither source responds -> unknown, never fires.
        s, pr = set_price(fail=True)
        check('12e both price sources set to fail',
              s == 200 and pr.get('coingecko', {}).get('fail') is True and pr.get('coinbase', {}).get('fail') is True, pr)
        check('12e caches cleared before the neither eval (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120107), 'label': 'P12e neither',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        txp12e = r['tx']['id'] if s == 201 else None
        check('12e a price tx added while both sources are down', s == 201, r)
        s, r, res = release_results()
        p12e_res = res.get(txp12e, {})
        check('12e neither responds -> unknown, no fire',
              p12e_res.get('action') == 'skipped' and p12e_res.get('triggerStatus') == 'unknown'
              and 'unavailable' in (p12e_res.get('reason') or ''), p12e_res)
        check('12e neither responds -> the tx is not broadcast', not (state_tx(txp12e) or {}).get('broadcasted'), state_tx(txp12e))
        s, pr = set_price(fail=False)
        check('12e both price sources restored',
              s == 200 and pr.get('coingecko', {}).get('fail') is False and pr.get('coinbase', {}).get('fail') is False, pr)
        # (f) primary decides — 149k/151k straddle a $150,000
        # threshold: CoinGecko (source1, primary) is $149,000,
        # Coinbase (source2, secondary) $151,000 (1.3% apart, so
        # they agree). BOTH rules are judged on the primary's
        # $149,000: >= does NOT hold, <= DOES. The secondary's
        # higher price must not fire the >= rule.
        s, pr = set_price(usd=149000, provider='coingecko')
        check('12f CoinGecko set to $149,000', s == 200 and pr.get('coingecko', {}).get('usd') == 149000, pr)
        s, pr = set_price(usd=151000, provider='coinbase')
        check('12f Coinbase set to $151,000 (1.3% above CoinGecko — they agree)',
              s == 200 and pr.get('coinbase', {}).get('usd') == 151000, pr)
        check('12f restart before the straddle eval (empty cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120109), 'label': 'P12f above primary',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 150000}}})
        txp12f_hi = r['tx']['id'] if s == 201 else None
        check('12f the >= $150,000 tx added (not already satisfied on the primary)', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120111), 'label': 'P12f below primary',
                                                'trigger': {'type': 'price', 'params': {'op': '<=', 'value': 150000}}, 'triggerConfirmed': True})
        txp12f_lo = r['tx']['id'] if s == 201 else None
        check('12f the <= $150,000 tx added (already satisfied on the primary, confirmed)', s == 201, r)
        s, r, res = release_results()
        check('12f >= judged on the PRIMARY ($149,000) -> does not broadcast',
              res.get(txp12f_hi, {}).get('action') != 'broadcast', res.get(txp12f_hi))
        check('12f <= judged on the PRIMARY ($149,000) -> broadcasts',
              res.get(txp12f_lo, {}).get('action') == 'broadcast', res.get(txp12f_lo))
        # Primary down: the secondary alone decides — the >= rule
        # that was watching on the primary now fires on $151,000.
        # The restart's startup full tick is what fires it (the
        # tick evaluates every rule type now); the release check
        # below then finds it already broadcast. (The broadcast
        # itself still goes via the primary *node* — only the price
        # source fell back to the secondary — so no method is
        # asserted here, just the broadcast + its trigger.)
        s, pr = set_price(fail=True, provider='coingecko')
        check('12f CoinGecko set to fail (primary down)', s == 200 and pr.get('coingecko', {}).get('fail') is True, pr)
        check('12f restart before the fallback eval (empty cache)', restart())
        h12f = state_tx(txp12f_hi)
        check('12f primary down -> the startup tick fired >= on the secondary price ($151,000) alone',
              ((h12f or {}).get('release') or {}).get('status') == 'broadcast'
              and ((h12f or {}).get('release') or {}).get('trigger') == 'price', (h12f or {}).get('release'))
        s, r, res = release_results()
        check('12f primary down -> the release check finds >= already broadcast',
              res.get(txp12f_hi, {}).get('action') == 'skipped' and res.get(txp12f_hi, {}).get('reason') == 'already broadcast', res.get(txp12f_hi))
        s, pr = set_price(fail=False, provider='coingecko')
        check('12f CoinGecko restored', s == 200 and pr.get('coingecko', {}).get('fail') is False, pr)
        # (g) settings validation + a source change persists and is
        # actually used (Kraken + Bitstamp are fetched and parsed).
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'nope', 'source2': 'coinbase'}})
        check('12g an unknown provider -> 400',
              s == 400 and 'unknown price provider' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'kraken', 'source2': 'kraken'}})
        check('12g two identical sources -> 400',
              s == 400 and 'must be different' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'kraken', 'source2': 'bitstamp'}})
        check('12g Kraken + Bitstamp saved',
              s == 200 and r.get('priceSources') == {'source1': 'kraken', 'source2': 'bitstamp'}, r)
        s, st = req('GET', '/api/state')
        check('12g the source change persists in /api/state',
              st.get('settings', {}).get('priceSources') == {'source1': 'kraken', 'source2': 'bitstamp'}, st.get('settings'))
        s, pr = set_price(usd=98200)
        check('12g stub price back to $98,200 on all providers',
              s == 200 and pr.get('kraken', {}).get('usd') == 98200 and pr.get('bitstamp', {}).get('usd') == 98200, pr)
        check('12g restart before the Kraken/Bitstamp eval (empty cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120113), 'label': 'P12g kraken bitstamp',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp12g = r['tx']['id'] if s == 201 else None
        check('12g a price tx added on Kraken + Bitstamp', s == 201, r)
        s, r, res = release_results()
        p12g_res = res.get(txp12g, {})
        check('12g Kraken + Bitstamp are actually fetched and parsed (broadcasts at once)',
              p12g_res.get('action') == 'broadcast' and p12g_res.get('method') == 'primary', p12g_res)
        check('12g the firing triggerState status is due',
              (state_tx(txp12g) or {}).get('triggerState', {}).get('status') == 'due', (state_tx(txp12g) or {}).get('triggerState'))
        # The reason is trigger-only now (no source note) — the
        # proof that Kraken + Bitstamp were the sources fetched
        # and parsed lives in the stored priceNote, not the reason.
        p12g_ts = (state_tx(txp12g) or {}).get('triggerStatus', {})
        check('12g the stored priceNote names both sources (Kraken + Bitstamp fetched and parsed)',
              'Kraken $98,200' in (p12g_ts.get('priceNote') or '')
              and 'Bitstamp $98,200' in (p12g_ts.get('priceNote') or ''), p12g_ts)
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'coingecko', 'source2': 'coinbase'}})
        check('12g sources restored to CoinGecko + Coinbase',
              s == 200 and r.get('priceSources') == {'source1': 'coingecko', 'source2': 'coinbase'}, r)
        # (h) immediate fire still works with two sources: a fresh
        # holding rule broadcasts on the FIRST evaluation — no
        # sustained wait, no clock to seed.
        check('12h restart before the immediate-fire eval (empty cache)', restart())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 120115), 'label': 'P12h immediate',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txp12h = r['tx']['id'] if s == 201 else None
        check('12h a fresh holding price tx added', s == 201, r)
        s, r, res = release_results()
        p12h_res = res.get(txp12h, {})
        check('12h first eval with two sources: holding fires at once (broadcast, due)',
              p12h_res.get('action') == 'broadcast' and p12h_res.get('method') == 'primary', p12h_res)
        check('12h the firing triggerState status is due',
              (state_tx(txp12h) or {}).get('triggerState', {}).get('status') == 'due', (state_tx(txp12h) or {}).get('triggerState'))
        check('12h the firing triggerState carries no sustained clock (no since field)',
              'since' not in ((state_tx(txp12h) or {}).get('triggerState') or {}), (state_tx(txp12h) or {}).get('triggerState'))
        # Restore the stub price so the suite ends on the default.
        s, pr = set_price(usd=98200)
        check('12h stub price restored to $98,200',
              s == 200 and pr.get('coingecko', {}).get('usd') == 98200 and pr.get('coinbase', {}).get('usd') == 98200, pr)
        # --- 13. utxo catch-up + full-tick cadence ----------------------
        # Stub facts: FINNEY:0 is a confirmed spend at block 899990
        # (tip 900000 -> 11 confirmations). The /__test__/outspend
        # override below moves it to block 899999 -> 2 confirmations,
        # so a rule that selects fewer confirmations than 2 is first
        # noticed at a HIGHER count than it asked for — the catch-up
        # case: the spend happened, we only caught it late, and the
        # rule must still fire (confirmations >= N, never == N).
        # Restart first: the full tick runs every minute, so the
        # manual release checks below must land inside one 60 s
        # window (a fresh tick clock gives us that).
        delete_all_txs()
        check('13 restart before the catch-up evals (fresh full-tick clock)', restart())
        # (a) N=1 noticed at 2 confirmations fires (catch-up).
        s, pr = set_outspend(FINNEY, 0, 899999)
        check('13a outspend override set: FINNEY:0 at block 899999 (2 confirmations)',
              s == 200 and pr.get('overrides', {}).get(FINNEY.lower() + ':0') == 899999, pr)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
        check('13a /api/triggers/check N=1 at 2 confirmations -> fire true (catch-up, 2 >= 1)',
              s == 200 and r.get('fire') is True and r.get('detail', {}).get('confirmations') == 2
              and '2 confirmations' in (r.get('reason') or ''), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 130101), 'label': 'U13a N=1 caught at 2',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}},
                                                'triggerConfirmed': True})
        txu13a = r['tx']['id'] if s == 201 else None
        check('13a an N=1 tx on FINNEY:0 at 2 confirmations added with triggerConfirmed -> 201', s == 201, r)
        s, r, res = release_results()
        check('13a one release check: the N=1 tx broadcasts (caught at 2, fires on >=)',
              res.get(txu13a, {}).get('action') == 'broadcast', res.get(txu13a))
        check('13a the N=1 tx is broadcast', bool((state_tx(txu13a) or {}).get('broadcasted')), state_tx(txu13a))
        # (b) N=0 (unconfirmed) noticed at 2 confirmations fires —
        # an already-confirmed spend satisfies an unconfirmed-mode
        # rule (unconfirmed is 0 confirmations; 2 >= 0).
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 0}}})
        check('13b /api/triggers/check N=0 at 2 confirmations -> fire true (unconfirmed mode, any spend)',
              s == 200 and r.get('fire') is True and (r.get('reason') or '') == 'spent — firing', r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 130103), 'label': 'U13b N=0 caught at 2',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 0}},
                                                'triggerConfirmed': True})
        txu13b = r['tx']['id'] if s == 201 else None
        check('13b an N=0 tx on FINNEY:0 at 2 confirmations added with triggerConfirmed -> 201', s == 201, r)
        s, r, res = release_results()
        check('13b one release check: the N=0 tx broadcasts (confirmed spend satisfies unconfirmed mode)',
              res.get(txu13b, {}).get('action') == 'broadcast', res.get(txu13b))
        # (c) N=3 noticed at 2 confirmations does NOT fire yet — it
        # watches until the spend reaches 3, and the add is NOT
        # blocked (below threshold, so no already-spent gate).
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 3}}})
        check('13c /api/triggers/check N=3 at 2 confirmations -> fire false, 2 of 3',
              s == 200 and r.get('fire') is False and r.get('detail', {}).get('confirmations') == 2
              and '2 of 3' in (r.get('reason') or ''), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 130105), 'label': 'U13c N=3 at 2',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 3}}})
        txu13c = r['tx']['id'] if s == 201 else None
        check('13c adding an N=3 tx WITHOUT triggerConfirmed -> 201 (not yet firing, no block)', s == 201, r)
        s, r, res = release_results()
        check('13c one release check: the N=3 tx is skipped, watching with progress',
              res.get(txu13c, {}).get('action') == 'skipped' and res.get(txu13c, {}).get('triggerStatus') == 'watching'
              and '2 of 3' in (res.get(txu13c, {}).get('reason') or ''), res.get(txu13c))
        check('13c the N=3 tx is not broadcast', not (state_tx(txu13c) or {}).get('broadcasted'), state_tx(txu13c))
        # (d) cadence, static: the full tick runs every check
        # cadence for every rule type together, the hourly tick
        # does housekeeping only (no evaluation), and the tick
        # interval AND the price cache TTL both track the
        # user-configurable check cadence (Settings: Check
        # cadence, default 60s) — neither is hard-coded to 60s
        # any more (0.8.0 user controls). The interval is
        # re-armed on startup, on a settings save, and on a
        # restore; the cache TTL is the cadence in seconds.
        # (0.8.7.3 server split) the server is split into lib
        # modules, so read the module each string moved to instead
        # of server.js alone: tick/cadence in lib/release.js,
        # price cache in lib/prices.js. The 'onlyTypes' check keeps
        # its original "anywhere" intent: it scans the whole server
        # codebase (entry point + every lib module) — grep confirms
        # the string occurs nowhere, including lib/rules.js.
        _release = open(os.path.join(APP, 'lib', 'release.js')).read()
        _prices = open(os.path.join(APP, 'lib', 'prices.js')).read()
        _all = open(os.path.join(APP, 'server.js')).read()
        for _f in sorted(os.listdir(os.path.join(APP, 'lib'))):
            if _f.endswith('.js'):
                _all += open(os.path.join(APP, 'lib', _f)).read()
        # (0.8.3) rearmFullTick reads the cadence from state inside a
        # try/catch: when state.json is corrupt and no backup loads,
        # loadState throws, and the tick falls back to the 60 s
        # default instead of crashing the process at startup — so
        # the interval still tracks the saved cadence, and the
        # fallback is explicit, not a hard-coded interval.
        check('13d the full tick interval tracks the saved check cadence (rearmFullTick, not a hard-coded 60s)',
              'function rearmFullTick()' in _release
              and 'checkCadenceSecondsOf(store.loadState(DATA_DIR).settings)' in _release
              and 'setInterval(runFullTick, seconds * 1000)' in _release
              and 'could not read check cadence' in _release, '')
        check('13d the price cache TTL tracks the check cadence (fetchPriceCached takes the cadence, no fixed 60s constant)',
              'async function fetchPriceCached(sources, cadenceSeconds)' in _prices
              and 'PRICE_CACHE_MAX_AGE_MS' not in _prices, '')
        check('13d the full tick evaluates every type together (no onlyTypes filter anywhere)',
              'evaluateRelease({ automatic: true })' in _release and 'onlyTypes' not in _all, '')
        # The hourly tick does housekeeping only: extract its body
        # and assert it never evaluates but still refreshes node
        # status + confirmations.
        _start = _release.find('async function runHourlyTick() {')
        _end = _release.find('\n}\n', _start) if _start != -1 else -1
        _hourly = _release[_start:_end] if _start != -1 and _end != -1 else ''
        check('13d the hourly tick does housekeeping only (no release evaluation)',
              _hourly != '' and 'evaluateRelease' not in _hourly
              and 'testNodes()' in _hourly and 'refreshConfirmations(' in _hourly, _hourly[:200])
        # (e) cadence, behavioural: restart (a fresh 60 s full-tick
        # clock), add an armed UTXO tx (N=1, already spent at 2
        # confs — the override is still on) and a due check-in tx,
        # wait for the 60 s full tick, and confirm BOTH broadcast
        # on it — the full tick evaluates every rule type together,
        # so the check-in tx no longer waits for an hourly tick.
        # A manual release check afterwards finds both already
        # broadcast.
        delete_all_txs()
        check('13e restart before the full-tick eval (fresh tick clock)', restart())
        # (Optimization O4) Park the cadence at 10 s for this
        # section only: the full tick that broadcasts both txs
        # then fires ~10 s after the restart instead of ~60 s.
        # The 60 s interval itself is covered by §20's cadence
        # test, so nothing is lost. Restored to 60 s at the end
        # of this section.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('13e cadence set to 10 s for this section', s == 200, (s, r))
        set_clock(0)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 130201), 'label': 'U13e full tick utxo',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}},
                                                'triggerConfirmed': True})
        txu13e = r['tx']['id'] if s == 201 else None
        check('13e an armed N=1 UTXO tx added (already spent at 2 confs)', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 130203), 'label': 'U13e full tick checkin',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txc13e = r['tx']['id'] if s == 201 else None
        check('13e a check-in tx added on a fresh clock', s == 201, r)
        set_clock(36)
        # The full tick fires ~10 s after the cadence change
        # above; poll for both broadcasts (the loop exits as soon
        # as both land, so the extra iterations cost nothing in
        # the normal case).
        txu13e_broadcast = False
        txc13e_broadcast = False
        for _ in range(15):
            if (state_tx(txu13e) or {}).get('broadcasted'):
                txu13e_broadcast = True
            if (state_tx(txc13e) or {}).get('broadcasted'):
                txc13e_broadcast = True
            if txu13e_broadcast and txc13e_broadcast:
                break
            time.sleep(2)
        check('13e the full tick broadcast the UTXO tx (all types evaluated every minute)',
              txu13e_broadcast, state_tx(txu13e))
        check('13e the full tick broadcast the due check-in tx too (no more hourly-only check-in)',
              txc13e_broadcast, state_tx(txc13e))
        s, r, res = release_results()
        check('13e a manual release check afterwards finds both already broadcast',
              res.get(txc13e, {}).get('action') == 'skipped' and res.get(txu13e, {}).get('action') == 'skipped', res)
        # (Optimization O4) Restore the 60 s cadence before the
        # next section.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('13e cadence restored to 60 s', s == 200, (s, r))
        # Clear the outspend override so the suite ends clean.
        s, pr = set_outspend(FINNEY, 0, None)
        check('13e outspend override cleared',
              s == 200 and (FINNEY.lower() + ':0') not in (pr.get('overrides') or {}), pr)
        # --- 14. price-source test button + UA fix + Exchange Status ----
        # One armed price tx (>= $150,000, never fires at the stub
        # prices used here) drives the cache for the whole section.
        s, pr = set_price(usd=98200)
        check('14 stub price set to $98,200 on all providers',
              s == 200 and pr.get('coingecko', {}).get('usd') == 98200 and pr.get('coinbase', {}).get('usd') == 98200, pr)
        check('14 caches cleared before the test-endpoint evals (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 140101), 'label': 'P14 exchange',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 150000}}})
        txp14 = r['tx']['id'] if s == 201 else None
        check('14 an armed price tx added (>= $150,000, never fires here)', s == 201, r)
        s, r, res = release_results()
        check('14 a release check populates the price cache',
              (state_tx(txp14) or {}).get('triggerStatus', {}).get('status') == 'watching', state_tx(txp14))
        # (a) the test endpoint: success returns a price.
        s, r = req('POST', '/api/settings/price-sources/test', {'provider': 'coingecko'})
        check('14a test endpoint: CoinGecko returns $98,200',
              s == 200 and r.get('provider') == 'coingecko' and r.get('price') == 98200 and r.get('error') is None, (s, r))
        s, r = req('POST', '/api/settings/price-sources/test', {'provider': 'coinbase'})
        check('14a test endpoint: Coinbase returns $98,200',
              s == 200 and r.get('provider') == 'coinbase' and r.get('price') == 98200 and r.get('error') is None, (s, r))
        # (b) the User-Agent fix: the stub records the UA each
        # price feed was fetched with. CoinGecko 403s a missing /
        # non-descriptive UA, so the app must identify itself.
        s, ua = req('GET', '/__test__/price-ua', base=STUB_BASE_P)
        check('14b CoinGecko was fetched with a descriptive User-Agent (Standby/…)',
              s == 200 and isinstance((ua.get('ua') or {}).get('coingecko'), str)
              and (ua.get('ua') or {}).get('coingecko', '').startswith('Standby/'), ua)
        check('14b Coinbase was fetched with a descriptive User-Agent (Standby/…)',
              s == 200 and isinstance((ua.get('ua') or {}).get('coinbase'), str)
              and (ua.get('ua') or {}).get('coinbase', '').startswith('Standby/'), ua)
        # (c) the test endpoint accepts ANY of the five providers,
        # not only the two configured ones.
        for prov in ('binance', 'kraken', 'bitstamp'):
            s, r = req('POST', '/api/settings/price-sources/test', {'provider': prov})
            check('14c test endpoint: %s (not configured) returns a price' % prov,
                  s == 200 and r.get('provider') == prov and r.get('price') == 98200 and r.get('error') is None, (s, r))
        # (d) the test endpoint: an unknown provider is a 400.
        s, r = req('POST', '/api/settings/price-sources/test', {'provider': 'nope'})
        check('14d test endpoint: an unknown provider -> 400',
              s == 400 and 'unknown price provider' in (r.get('error') or ''), (s, r))
        # (e) the test endpoint bypasses the cache and does not
        # update it: change the stub, test, and the cached price
        # is still the old one (the cache is fresh for 1 min, so
        # the full tick cannot have refreshed it in this window).
        s, pr = set_price(usd=100000, provider='coinbase')
        check('14e Coinbase stub moved to $100,000',
              s == 200 and pr.get('coinbase', {}).get('usd') == 100000, pr)
        s, r = req('POST', '/api/settings/price-sources/test', {'provider': 'coinbase'})
        check('14e test endpoint returns the NEW stub price ($100,000) — a fresh fetch, not the cache',
              s == 200 and r.get('price') == 100000, (s, r))
        s, st = req('GET', '/api/state')
        check('14e the test did NOT update the price cache (Coinbase still $98,200 there)',
              (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('price') == 98200,
              st.get('bitcoin', {}).get('currentPrices'))
        check('14e the test did NOT change the configured sources (still CoinGecko + Coinbase)',
              st.get('settings', {}).get('priceSources') == {'source1': 'coingecko', 'source2': 'coinbase'}, st.get('settings'))
        s, pr = set_price(usd=98200, provider='coinbase')
        check('14e Coinbase stub restored to $98,200',
              s == 200 and pr.get('coinbase', {}).get('usd') == 98200, pr)
        # (f) the test endpoint: a failing provider answers 200
        # with price null and the error (the test itself worked —
        # the provider is down).
        s, pr = set_price(fail=True, provider='coingecko')
        check('14f CoinGecko set to fail', s == 200 and pr.get('coingecko', {}).get('fail') is True, pr)
        s, r = req('POST', '/api/settings/price-sources/test', {'provider': 'coingecko'})
        check('14f test endpoint: a failing CoinGecko answers 200 with price null and the error',
              s == 200 and r.get('provider') == 'coingecko' and r.get('price') is None
              and isinstance(r.get('error'), str) and 'CoinGecko' in r.get('error'), (s, r))
        s, pr = set_price(fail=False, provider='coingecko')
        check('14f CoinGecko restored', s == 200 and pr.get('coingecko', {}).get('fail') is False, pr)
        # (f2) the test-all endpoint: one call tests both
        # sources (the Settings "Test connection" button). It
        # returns {results: [{provider, price, error}, ...]} in
        # the order requested, with fresh fetches.
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': ['coingecko', 'coinbase']})
        check('14f2 test-all: both configured sources return $98,200 in one call',
              s == 200 and isinstance(r.get('results'), list) and len(r['results']) == 2
              and [x.get('provider') for x in r['results']] == ['coingecko', 'coinbase']
              and all(x.get('price') == 98200 and x.get('error') is None for x in r['results']), (s, r))
        # test-all accepts any providers, not only the configured
        # ones — including Binance (now Binance US).
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': ['binance', 'kraken']})
        check('14f2 test-all: non-configured providers (Binance, Kraken) return a price',
              s == 200 and [x.get('provider') for x in r.get('results', [])] == ['binance', 'kraken']
              and all(x.get('price') == 98200 and x.get('error') is None for x in r['results']), (s, r))
        # test-all: a failing provider is a per-result error, not
        # a whole-call failure — the other result still carries a
        # price.
        s, pr = set_price(fail=True, provider='coingecko')
        check('14f2 CoinGecko set to fail (test-all)', s == 200 and pr.get('coingecko', {}).get('fail') is True, pr)
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': ['coingecko', 'coinbase']})
        check('14f2 test-all: a failing CoinGecko is a per-result error (price null) while Coinbase still returns $98,200',
              s == 200 and len(r.get('results', [])) == 2
              and r['results'][0].get('provider') == 'coingecko' and r['results'][0].get('price') is None
              and isinstance(r['results'][0].get('error'), str)
              and r['results'][1].get('provider') == 'coinbase' and r['results'][1].get('price') == 98200, (s, r))
        s, pr = set_price(fail=False, provider='coingecko')
        check('14f2 CoinGecko restored (test-all)', s == 200 and pr.get('coingecko', {}).get('fail') is False, pr)
        # test-all: an unknown id inside the list is a per-result
        # error, not a whole-call 400.
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': ['coingecko', 'nope']})
        check('14f2 test-all: an unknown provider id is a per-result error (not a 400)',
              s == 200 and len(r.get('results', [])) == 2
              and r['results'][0].get('provider') == 'coingecko' and r['results'][0].get('price') == 98200
              and r['results'][1].get('provider') == 'nope' and r['results'][1].get('price') is None
              and 'unknown price provider' in (r['results'][1].get('error') or ''), (s, r))
        # test-all: a missing/empty providers array is a 400.
        s, r = req('POST', '/api/settings/price-sources/test-all', {})
        check('14f2 test-all: a missing providers array -> 400',
              s == 400 and 'providers' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': []})
        check('14f2 test-all: an empty providers array -> 400',
              s == 400 and 'providers' in (r.get('error') or ''), (s, r))
        # test-all does not update the cache or change the
        # configured sources (same as the single test endpoint).
        s, pr = set_price(usd=100000, provider='coinbase')
        check('14f2 Coinbase stub moved to $100,000 (test-all)', s == 200 and pr.get('coinbase', {}).get('usd') == 100000, pr)
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': ['coingecko', 'coinbase']})
        check('14f2 test-all returns the NEW stub price ($100,000) — a fresh fetch, not the cache',
              s == 200 and r['results'][1].get('price') == 100000, (s, r))
        s, st = req('GET', '/api/state')
        check('14f2 test-all did NOT update the price cache (Coinbase still $98,200 there)',
              (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('price') == 98200,
              st.get('bitcoin', {}).get('currentPrices'))
        check('14f2 test-all did NOT change the configured sources (still CoinGecko + Coinbase)',
              st.get('settings', {}).get('priceSources') == {'source1': 'coingecko', 'source2': 'coinbase'}, st.get('settings'))
        s, pr = set_price(usd=98200, provider='coinbase')
        check('14f2 Coinbase stub restored to $98,200 (test-all)', s == 200 and pr.get('coinbase', {}).get('usd') == 98200, pr)
        # (g) Exchange Status, OK: both sources agree. The
        # readiness card shows the consolidated status once; the
        # per-tx reason is trigger-only (no per-source note) and
        # readinessReason is gone — the subcard reads lastPrice.
        s, st = req('GET', '/api/state')
        check('14g Exchange Status is OK when both sources agree',
              (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'ok',
              st.get('bitcoin', {}).get('exchangeStatus'))
        ex14g = (st.get('bitcoin', {}).get('exchangeStatus') or {})
        srcs14g = ex14g.get('sources') or []
        check('14g Exchange Status has one row per configured source (CoinGecko + Coinbase)',
              len(srcs14g) == 2 and [s.get('provider') for s in srcs14g] == ['coingecko', 'coinbase'], srcs14g)
        check('14g Exchange Status row 1: CoinGecko $98,200, status ok',
              len(srcs14g) == 2 and srcs14g[0].get('label') == 'CoinGecko' and srcs14g[0].get('price') == 98200
              and srcs14g[0].get('error') is None and srcs14g[0].get('status') == 'ok', srcs14g)
        check('14g Exchange Status row 2: Coinbase $98,200, status ok',
              len(srcs14g) == 2 and srcs14g[1].get('label') == 'Coinbase' and srcs14g[1].get('price') == 98200
              and srcs14g[1].get('error') is None and srcs14g[1].get('status') == 'ok', srcs14g)
        p14 = state_tx(txp14)
        ts14 = (p14 or {}).get('triggerStatus', {})
        check('14g the price tx reason is trigger-only (no source note)',
              ts14.get('reason') == 'currently $98,200', ts14)
        check('14g readinessReason is gone (the reason alone is trigger-only)',
              'readinessReason' not in ts14, ts14)
        check('14g the price tx carries the effective price (lastPrice $98,200)',
              ts14.get('lastPrice') == 98200, ts14)
        check('14g the price tx condition reads "Fires when BTC price ≥ $150,000"',
              ts14.get('condition') == 'Fires when BTC price ≥ $150,000', ts14)
        # (g2) the dry run surfaces the source detail: both
        # sources and their readings.
        s, r = req('POST', '/api/broadcast/test', {'id': txp14})
        note14g = ((r.get('results') or [{}])[0] or {}).get('note') or ''
        check('14g dry-run of the price tx names both sources and their readings',
              'Price sources: CoinGecko $98,200 · Coinbase $98,200' in note14g, note14g)
        # (h) Exchange Status, degraded: one source down
        # (single-source mode).
        s, pr = set_price(fail=True, provider='coingecko')
        check('14h CoinGecko set to fail', s == 200 and pr.get('coingecko', {}).get('fail') is True, pr)
        check('14h caches cleared before the degraded eval (empty cache)', clear_caches())
        s, r, res = release_results()
        s, st = req('GET', '/api/state')
        check('14h Exchange Status is degraded when one source is down',
              (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'degraded',
              st.get('bitcoin', {}).get('exchangeStatus'))
        ex14h = (st.get('bitcoin', {}).get('exchangeStatus') or {})
        srcs14h = ex14h.get('sources') or []
        check('14h Exchange Status row 1: CoinGecko down, status error with the error',
              len(srcs14h) == 2 and srcs14h[0].get('provider') == 'coingecko' and srcs14h[0].get('price') is None
              and srcs14h[0].get('status') == 'error' and isinstance(srcs14h[0].get('error'), str), srcs14h)
        check('14h Exchange Status row 2: Coinbase $98,200, status ok',
              len(srcs14h) == 2 and srcs14h[1].get('provider') == 'coinbase' and srcs14h[1].get('price') == 98200
              and srcs14h[1].get('status') == 'ok', srcs14h)
        p14 = state_tx(txp14)
        ts14 = (p14 or {}).get('triggerStatus', {})
        check('14h the price tx reason is trigger-only in single-source mode',
              ts14.get('reason') == 'currently $98,200', ts14)
        check('14h readinessReason is gone in single-source mode',
              'readinessReason' not in ts14, ts14)
        check('14h the price tx carries the effective price (lastPrice $98,200)',
              ts14.get('lastPrice') == 98200, ts14)
        # (h2) the dry run names the single-source fallback.
        s, r = req('POST', '/api/broadcast/test', {'id': txp14})
        note14h = ((r.get('results') or [{}])[0] or {}).get('note') or ''
        check('14h dry-run of the price tx names the single-source fallback',
              'Price sources: Coinbase only — CoinGecko unreachable' in note14h, note14h)
        s, pr = set_price(fail=False, provider='coingecko')
        check('14h CoinGecko restored', s == 200 and pr.get('coingecko', {}).get('fail') is False, pr)
        # (i) Exchange Status, error: the sources disagree by
        # more than 5%. The per-tx readiness line is a generic
        # "price feed unknown" — the disagreement detail lives in
        # the Exchange Status section, not on every price tx.
        s, pr = set_price(usd=100000, provider='coingecko')
        check('14i CoinGecko set to $100,000', s == 200 and pr.get('coingecko', {}).get('usd') == 100000, pr)
        s, pr = set_price(usd=106000, provider='coinbase')
        check('14i Coinbase set to $106,000 (6% apart — they disagree)',
              s == 200 and pr.get('coinbase', {}).get('usd') == 106000, pr)
        check('14i caches cleared before the disagree eval (empty cache)', clear_caches())
        s, r, res = release_results()
        s, st = req('GET', '/api/state')
        check('14i Exchange Status is error when the sources disagree',
              (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'error',
              st.get('bitcoin', {}).get('exchangeStatus'))
        ex14i = (st.get('bitcoin', {}).get('exchangeStatus') or {})
        srcs14i = ex14i.get('sources') or []
        check('14i Exchange Status rows carry both prices when the sources disagree',
              len(srcs14i) == 2 and srcs14i[0].get('price') == 100000 and srcs14i[1].get('price') == 106000
              and srcs14i[0].get('status') == 'ok' and srcs14i[1].get('status') == 'ok', srcs14i)
        p14 = state_tx(txp14)
        ts14 = (p14 or {}).get('triggerStatus', {})
        check('14i the price tx reason is generic when the sources disagree (no source names or prices)',
              ts14.get('reason') == 'price feed unknown', ts14)
        check('14i readinessReason is gone when the sources disagree',
              'readinessReason' not in ts14, ts14)
        check('14i the price tx has no effective price when the sources disagree',
              ts14.get('lastPrice') is None, ts14)
        # (i2) the dry run names the disagreement.
        s, r = req('POST', '/api/broadcast/test', {'id': txp14})
        note14i = ((r.get('results') or [{}])[0] or {}).get('note') or ''
        check('14i dry-run of the price tx names the disagreement',
              'Price sources disagree — CoinGecko $100,000 vs Coinbase $106,000 (6.0% apart)' in note14i, note14i)
        # (j) Exchange Status, error: neither source responds.
        s, pr = set_price(fail=True)
        check('14j both price sources set to fail',
              s == 200 and pr.get('coingecko', {}).get('fail') is True and pr.get('coinbase', {}).get('fail') is True, pr)
        check('14j caches cleared before the neither eval (empty cache)', clear_caches())
        s, r, res = release_results()
        s, st = req('GET', '/api/state')
        check('14j Exchange Status is error when neither source responds',
              (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'error',
              st.get('bitcoin', {}).get('exchangeStatus'))
        ex14j = (st.get('bitcoin', {}).get('exchangeStatus') or {})
        srcs14j = ex14j.get('sources') or []
        check('14j Exchange Status rows are both error when neither source responds',
              len(srcs14j) == 2 and srcs14j[0].get('status') == 'error' and srcs14j[1].get('status') == 'error'
              and srcs14j[0].get('price') is None and srcs14j[1].get('price') is None, srcs14j)
        p14 = state_tx(txp14)
        ts14 = (p14 or {}).get('triggerStatus', {})
        check('14j the price tx reason is generic when neither source responds',
              ts14.get('reason') == 'price feed unknown', ts14)
        check('14j readinessReason is gone when neither source responds',
              'readinessReason' not in ts14, ts14)
        # (j2) the dry run says the feed is unavailable.
        s, r = req('POST', '/api/broadcast/test', {'id': txp14})
        note14j = ((r.get('results') or [{}])[0] or {}).get('note') or ''
        check('14j dry-run of the price tx says the price feed is unavailable',
              'Price unavailable — will retry' in note14j, note14j)
        # Restore the stub so the suite ends on the default.
        s, pr = set_price(usd=98200, fail=False)
        check('14j stub price restored to $98,200, both sources up',
              s == 200 and pr.get('coingecko', {}).get('usd') == 98200 and pr.get('coingecko', {}).get('fail') is False
              and pr.get('coinbase', {}).get('fail') is False, pr)

        # --- 15. price confirm guard --------------------------------------
        # A price rule whose condition is ALREADY satisfied (both
        # sources agree the price is past the threshold) is blocked
        # at add / import / edit unless the owner confirms it
        # (triggerConfirmed: true) — the premature-broadcast guard,
        # mirroring the UTXO gate. A rule that is NOT past the
        # threshold, or a reading that is unknown (disagreeing or
        # unavailable feeds), never blocks.
        check('15 caches cleared before the guard evals (empty cache)', clear_caches())
        # (a) add: holding without triggerConfirmed -> 400, nothing stored.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150101), 'label': 'G15a holding add',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('15a adding a holding price rule WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already' in (r.get('error') or '') and 'triggerConfirmed' in (r.get('error') or ''), (s, r))
        s, st = req('GET', '/api/state')
        check('15a the blocked add stored nothing (txid absent)',
              txid_of(craft(1, 150101)) not in [t.get('txid') for t in st.get('bitcoin', {}).get('txs', [])], (s, r))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150101), 'label': 'G15a holding add',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('15a the same add WITH triggerConfirmed -> 201',
              s == 201 and r.get('tx', {}).get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, r)
        # (b) import: the same gate, "import it anyway".
        s, r = req('POST', '/api/bitcoin/txs/import',
                   {'format': 'hex', 'data': craft(1, 150103), 'label': 'G15b holding import',
                    'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('15b importing a holding price rule WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already' in (r.get('error') or '') and 'Import it with triggerConfirmed' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/bitcoin/txs/import',
                   {'format': 'hex', 'data': craft(1, 150103), 'label': 'G15b holding import',
                    'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('15b the same import WITH triggerConfirmed -> 201',
              s == 201 and r.get('tx', {}).get('txid') == txid_of(craft(1, 150103)), (s, r))
        # (c) edit: changing a trigger TO a holding price -> 400, then 200.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150105), 'label': 'G15c edit base',
                                                'trigger': {'type': 'manual', 'params': {}}})
        txg15c = r['tx']['id'] if s == 201 else None
        check('15c a manual tx added for the edit gate', s == 201, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txg15c, {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('15c editing a trigger TO a holding price WITHOUT triggerConfirmed -> 400',
              s == 400 and 'already' in (r.get('error') or '') and 'Save it with triggerConfirmed' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/bitcoin/txs/' + txg15c, {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('15c the same edit WITH triggerConfirmed -> 200, stored as a price rule',
              s == 200 and r.get('tx', {}).get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, r)
        # (d) not past the threshold -> adds normally, no block.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150107), 'label': 'G15d below threshold',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        check('15d a price rule NOT past the threshold adds normally (201, no block)',
              s == 201, r)
        # (e) disagreeing feeds -> not a fire, no block.
        s, pr = set_price(usd=100000, provider='coingecko')
        check('15e CoinGecko set to $100,000', s == 200 and pr.get('coingecko', {}).get('usd') == 100000, pr)
        s, pr = set_price(usd=106000, provider='coinbase')
        check('15e Coinbase set to $106,000 (6% apart — they disagree)',
              s == 200 and pr.get('coinbase', {}).get('usd') == 106000, pr)
        check('15e caches cleared before the disagree add (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150109), 'label': 'G15e disagree',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('15e disagreeing feeds do not block the add (201)',
              s == 201, r)
        # (f) unavailable feeds -> not a fire, no block.
        s, pr = set_price(fail=True)
        check('15f both price sources set to fail',
              s == 200 and pr.get('coingecko', {}).get('fail') is True and pr.get('coinbase', {}).get('fail') is True, pr)
        check('15f caches cleared before the unavailable add (empty cache)', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 150111), 'label': 'G15f unavailable',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('15f unavailable feeds do not block the add (201)',
              s == 201, r)
        s, pr = set_price(usd=98200, fail=False)
        check('15f stub price restored to $98,200, both sources up',
              s == 200 and pr.get('coingecko', {}).get('usd') == 98200 and pr.get('coingecko', {}).get('fail') is False
              and pr.get('coinbase', {}).get('fail') is False, pr)
        # --- 16. per-tx check-in bars + the removed global threshold --
        # The check-in card serves one countdown bar per ARMED
        # check-in tx (GET /api/status checkinTxs), each measured
        # at its OWN threshold with the EFFECTIVE window (the
        # threshold on-track, the longer held window while an
        # offline-gap grace is active). There is no global
        # threshold setting any more: PUT /api/settings with
        # thresholdDays is a 400, fresh state carries none, a
        # legacy state file's thresholdDays is pruned on load, and
        # a pre-0.8.0 backup carrying one restores without it.
        delete_all_txs()
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 160101), 'label': 'B16a 35d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txb16a = r['tx']['id'] if s == 201 else None
        check('16 two check-in txs added (35d + 10d)', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 160103), 'label': 'B16b 10d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 10}}})
        txb16b = r['tx']['id'] if s == 201 else None
        check('16 the 10d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('16 check-in lands', s == 200 and r.get('ok') is True, r)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16 /api/status serves one bar per armed check-in tx (2)',
              len(bars) == 2 and set(bars) == {txb16a, txb16b}, st.get('checkinTxs'))
        check('16 the 35d bar reads 0 of 35 days elapsed after the check-in',
              bars.get(txb16a, {}).get('daysSince') == 0 and bars.get(txb16a, {}).get('windowDays') == 35
              and bars.get(txb16a, {}).get('thresholdDays') == 35 and bars.get(txb16a, {}).get('label') == 'B16a 35d',
              bars.get(txb16a))
        check('16 the 10d bar reads 0 of 10 days elapsed after the check-in',
              bars.get(txb16b, {}).get('daysSince') == 0 and bars.get(txb16b, {}).get('windowDays') == 10
              and bars.get(txb16b, {}).get('thresholdDays') == 10 and bars.get(txb16b, {}).get('label') == 'B16b 10d',
              bars.get(txb16b))
        check('16 the top-level due is the soonest (the 10d tx)',
              st.get('nextDue') == bars.get(txb16b, {}).get('nextDue') and st.get('windowDays') == 10,
              (st.get('nextDue'), st.get('windowDays')))
        # 3 days on: each bar counts its own window.
        set_clock(3)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16 clock 3 days back: the 35d bar reads 3 of 35',
              bars.get(txb16a, {}).get('daysSince') == 3 and bars.get(txb16a, {}).get('windowDays') == 35, bars.get(txb16a))
        check('16 clock 3 days back: the 10d bar reads 3 of 10',
              bars.get(txb16b, {}).get('daysSince') == 3 and bars.get(txb16b, {}).get('windowDays') == 10, bars.get(txb16b))
        check('16 clock 3 days back: the top-level state is still on-track',
              st.get('state') == 'on-track' and st.get('label') == 'On track', st.get('state'))
        # A disarmed check-in tx keeps a FROZEN bar (0.8.0
        # redesign): still listed, still at its day count, marked
        # enabled=false — inactive time does not count, so the bar
        # does not advance while it is disarmed. The top-level due
        # still comes from the ARMED tx only.
        s, r = req('PUT', '/api/bitcoin/txs/' + txb16b, {'enabled': False})
        check('16 disarming the 10d tx', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16 a disarmed check-in tx keeps a frozen bar (both bars listed, the 10d one enabled=false at 3 of 10)',
              len(bars) == 2 and bars.get(txb16b, {}).get('enabled') is False
              and bars.get(txb16b, {}).get('daysSince') == 3 and bars.get(txb16b, {}).get('windowDays') == 10
              and bars.get(txb16a, {}).get('enabled') is True, st.get('checkinTxs'))
        check('16 the top-level due still comes from the armed tx only (the 35d bar)',
              st.get('nextDue') == bars.get(txb16a, {}).get('nextDue') and st.get('windowDays') == 35,
              (st.get('nextDue'), st.get('windowDays')))
        s, r = req('PUT', '/api/bitcoin/txs/' + txb16b, {'enabled': True})
        check('16 re-arming the 10d tx', s == 200 and r.get('tx', {}).get('enabled') is True, r)
        # Held by the grace (0.8.8 unification): the bars use their
        # OWN windows — last check-in 40 days back, so both bars
        # read 40 of their own threshold (35 / 10) — and a bar
        # past due while the grace is active reads state 'grace',
        # never 'release-due': the due date is NOT pushed out by
        # the grace. The top-level state is 'grace' ("Grace
        # period") while any armed entry is past due and held.
        # The grace sets on the read: lastOnlineAt is 40 days
        # back, past the 7-day threshold.
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40, seconds=30)
        stj['checkin']['lastOnlineAt'] = iso_ago(days=40)
        save_state_file(stj)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16 grace: the 35d bar reads 40 of 35, state grace (past due, held by the grace)',
              bars.get(txb16a, {}).get('daysSince') == 40 and bars.get(txb16a, {}).get('windowDays') == 35
              and bars.get(txb16a, {}).get('state') == 'grace', bars.get(txb16a))
        check('16 grace: the 10d bar reads 40 of 10, state grace too',
              bars.get(txb16b, {}).get('daysSince') == 40 and bars.get(txb16b, {}).get('windowDays') == 10
              and bars.get(txb16b, {}).get('state') == 'grace', bars.get(txb16b))
        check('16 grace: the top-level state is grace ("Grace period"), not release-due',
              st.get('state') == 'grace' and st.get('label') == 'Grace period', (st.get('state'), st.get('label')))
        check('16 grace: no heldUntil anywhere in the status',
              'heldUntil' not in json.dumps(st), json.dumps(st)[:400])
        # A check-in clears the clock but NOT the grace: both bars
        # reset to 0 (on-track again — the clock is fresh, so no
        # entry is past due any more), while the grace stays
        # active until it expires or is resumed.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('16 check-in lands during the grace', s == 200 and r.get('ok') is True, r)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16 checking in resets both bars to 0 days elapsed (35d + 10d windows back, on-track)',
              bars.get(txb16a, {}).get('daysSince') == 0 and bars.get(txb16a, {}).get('windowDays') == 35
              and bars.get(txb16a, {}).get('state') == 'on-track'
              and bars.get(txb16b, {}).get('daysSince') == 0 and bars.get(txb16b, {}).get('windowDays') == 10
              and bars.get(txb16b, {}).get('state') == 'on-track',
              st.get('checkinTxs'))
        check('16 the top-level state is on-track after the check-in (clock fresh, nothing past due)',
              st.get('state') == 'on-track' and st.get('label') == 'On track', (st.get('state'), st.get('label')))
        s, st2 = req('GET', '/api/state')
        check('16 the grace is still active after the check-in',
              (st2.get('grace') or {}).get('active') is True, st2.get('grace'))
        stj = load_state_file()
        check('16 no heldUntil in the stored check-in state',
              'heldUntil' not in stj.get('checkin', {}), stj.get('checkin'))
        # Resume clears the grace for the sections below (resume
        # also refreshes lastOnlineAt, so no grace re-sets).
        s, r = req('POST', '/api/grace/resume', {})
        check('16 resume clears the grace', s == 200 and r.get('ok') is True and r.get('grace') is None, (s, r))
        # PUT /api/settings with thresholdDays is a 400 for any
        # value — and the clock is untouched by the rejection.
        before = checkin_last()
        s, r = req('PUT', '/api/settings', {'thresholdDays': 35})
        check('16 PUT /api/settings with thresholdDays 35 -> 400',
              s == 400 and 'no longer a setting' in (r.get('error') or ''), (s, r))
        check('16 the rejected PUT left the check-in clock unchanged',
              checkin_last() == before, (checkin_last(), before))
        # A legacy state file carrying settings.thresholdDays is
        # pruned on load (the setting no longer exists).
        stj = load_state_file()
        stj['settings']['thresholdDays'] = 90
        save_state_file(stj)
        s, st = req('GET', '/api/state')
        check('16 a legacy settings.thresholdDays is pruned on load',
              'thresholdDays' not in st.get('settings', {}), st.get('settings'))
        # A pre-0.8.0 backup carrying settings.thresholdDays
        # restores without it.
        s, bak = req('GET', '/api/backup')
        bak['state']['settings']['thresholdDays'] = 90
        s, r = req('POST', '/api/restore', bak)
        check('16 restore of a backup carrying thresholdDays lands', s == 200, r)
        s, st = req('GET', '/api/state')
        check('16 the restored settings carry no thresholdDays',
              'thresholdDays' not in st.get('settings', {}), st.get('settings'))
        check('16 the restored txs keep their per-tx triggers',
              {t.get('id'): t.get('trigger') for t in st.get('bitcoin', {}).get('txs', [])}.get(txb16a)
              == {'type': 'checkin', 'params': {'thresholdDays': 35}}, st.get('bitcoin', {}).get('txs'))
        # --- 16b. settled / pending check-in txs get no bar ---
        # The bars are for ACTIVE countdowns only: a stale, a
        # broadcasted (confirmed), a pending (broadcast but
        # unconfirmed) and a slipstream-pending check-in tx all
        # lose their bar, while a failed and a conflict one keep
        # theirs (still owed a broadcast). When every armed
        # check-in tx is archived the bar list is empty and the
        # top-level due / window go null. (Direct state edits
        # stage the fate; the server reads state fresh per call.)
        txid16a = (state_tx(txb16a) or {}).get('txid')
        now16 = iso_now()
        set_tx_fate(txb16a, release={'status': 'stale', 'kind': 'release', 'trigger': 'checkin',
                                     'txid': txid16a, 'method': 'mempool.space',
                                     'lastAttemptAt': now16, 'error': 'inputs spent: staged'},
                    broadcasted=None)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a stale check-in tx gets no bar (only the 10d bar remains)',
              list(bars) == [txb16b], st.get('checkinTxs'))
        check('16b with only the 10d tx active the top-level due is its due (window 10)',
              st.get('nextDue') == bars.get(txb16b, {}).get('nextDue') and st.get('windowDays') == 10,
              (st.get('nextDue'), st.get('windowDays')))
        set_tx_fate(txb16a,
                    release={'status': 'broadcast', 'kind': 'release', 'trigger': 'checkin',
                             'txid': txid16a, 'method': 'mempool.space', 'broadcastedAt': now16},
                    broadcasted={'txid': txid16a, 'broadcastedAt': now16, 'method': 'mempool.space',
                                 'confirmations': 5, 'blockHeight': 899995, 'found': True, 'checkedAt': now16})
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a broadcasted (confirmed) check-in tx gets no bar',
              list(bars) == [txb16b], st.get('checkinTxs'))
        set_tx_fate(txb16a,
                    release={'status': 'broadcast', 'kind': 'release', 'trigger': 'checkin',
                             'txid': txid16a, 'method': 'mempool.space', 'broadcastedAt': now16},
                    broadcasted={'txid': txid16a, 'broadcastedAt': now16, 'method': 'mempool.space',
                                 'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': now16})
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a pending (broadcast, 0 confirmations) check-in tx gets no bar',
              list(bars) == [txb16b], st.get('checkinTxs'))
        set_tx_fate(txb16a,
                    release={'status': 'submitted-slipstream', 'kind': 'release', 'trigger': 'checkin',
                             'txid': txid16a, 'method': 'slipstream', 'lastAttemptAt': now16},
                    broadcasted=None)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a slipstream-pending check-in tx gets no bar',
              list(bars) == [txb16b], st.get('checkinTxs'))
        set_tx_fate(txb16a,
                    release={'status': 'failed', 'kind': 'release', 'trigger': 'checkin',
                             'txid': txid16a, 'method': 'mempool.space',
                             'lastAttemptAt': now16, 'error': 'simulated failure'},
                    broadcasted=None)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a failed check-in tx KEEPS its bar (still owed a broadcast)',
              set(bars) == {txb16a, txb16b}, st.get('checkinTxs'))
        set_tx_fate(txb16a,
                    release={'status': 'conflict', 'kind': 'release', 'trigger': 'checkin',
                             'txid': txid16a, 'method': 'mempool.space',
                             'lastAttemptAt': now16, 'error': 'inputs spent by an unconfirmed transaction'},
                    broadcasted=None)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b a conflict check-in tx KEEPS its bar (active with a warning)',
              set(bars) == {txb16a, txb16b}, st.get('checkinTxs'))
        # Both archived: no bars, and the top-level due / window
        # go null (nothing left to count down to).
        set_tx_fate(txb16a, release={'status': 'stale', 'kind': 'release', 'trigger': 'checkin',
                                     'txid': txid16a, 'method': 'mempool.space',
                                     'lastAttemptAt': now16, 'error': 'inputs spent: staged'},
                    broadcasted=None)
        txid16b = (state_tx(txb16b) or {}).get('txid')
        set_tx_fate(txb16b, release={'status': 'stale', 'kind': 'release', 'trigger': 'checkin',
                                     'txid': txid16b, 'method': 'mempool.space',
                                     'lastAttemptAt': now16, 'error': 'inputs spent: staged'},
                    broadcasted=None)
        s, st = req('GET', '/api/status')
        check('16b with every armed check-in tx archived the bar list is empty',
              st.get('checkinTxs') == [], st.get('checkinTxs'))
        check('16b with no active check-in tx the top-level due and window are null',
              st.get('nextDue') is None and st.get('windowDays') is None,
              (st.get('nextDue'), st.get('windowDays')))
        # Restore both to active so the section ends clean.
        set_tx_fate(txb16a, release=None, broadcasted=None)
        set_tx_fate(txb16b, release=None, broadcasted=None)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('16b clearing the fates restores both bars',
              set(bars) == {txb16a, txb16b}, st.get('checkinTxs'))

        # --- 18. grace period for ALL triggers (0.8.0, unified 0.8.8) ---
        # When the app comes back after being offline longer than
        # settings.graceOfflineDays (default 7), price, UTXO,
        # block-height, set-date, fee-market, AND check-in
        # triggers are paused for settings.graceDurationDays
        # (default 7, null = indefinite until resumed). The grace
        # is a blanket hold: NO trigger fires while it is active,
        # even one whose condition first becomes true during the
        # grace. After it expires (or the owner resumes) the
        # triggers evaluate normally and fire if the condition
        # still holds. Checking in does NOT clear it.
        s, st = req('GET', '/api/state')
        check('18 grace settings default to graceOfflineDays 7 and graceDurationDays 7',
              st.get('settings', {}).get('graceOfflineDays') == 7
              and st.get('settings', {}).get('graceDurationDays') == 7,
              st.get('settings'))
        check('18 no grace active on a fresh state (grace is null on /api/state)',
              st.get('grace') is None, st.get('grace'))
        s, stat = req('GET', '/api/status')
        check('18 /api/status does NOT carry a grace field (the grace lives on /api/state only)',
              'grace' not in stat, [k for k in stat.keys() if 'grace' in k.lower()])
        # Settings validation: only the dropdown values are
        # accepted; anything else is a 400.
        for bad_off in (5, 0, 31, '7'):
            s, r = req('PUT', '/api/settings', {'graceOfflineDays': bad_off})
            check('18 graceOfflineDays %r is a 400' % (bad_off,),
                  s == 400 and 'graceOfflineDays' in (r.get('error') or ''), (s, r))
        for bad_dur in (5, 31, '7'):
            s, r = req('PUT', '/api/settings', {'graceDurationDays': bad_dur})
            check('18 graceDurationDays %r is a 400' % (bad_dur,),
                  s == 400 and 'graceDurationDays' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/settings', {'graceOfflineDays': 3, 'graceDurationDays': 14})
        check('18 graceOfflineDays 3 + graceDurationDays 14 save (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 saved grace settings read back (3 / 14)',
              st['settings']['graceOfflineDays'] == 3 and st['settings']['graceDurationDays'] == 14,
              st['settings'])
        s, r = req('PUT', '/api/settings', {'graceOfflineDays': 7, 'graceDurationDays': 7})
        check('18 grace settings restored to 7 / 7', s == 200, (s, r))
        s, r = req('PUT', '/api/settings', {'graceDurationDays': None})
        check('18 graceDurationDays null (indefinite) is valid', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 graceDurationDays reads back as null',
              st['settings'].get('graceDurationDays') is None, st['settings'])
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 7})
        check('18 graceDurationDays restored to 7', s == 200, (s, r))
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 0})
        check('18 graceDurationDays 0 (off, back-compat) is valid (0.8.8)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 graceDurationDays reads back as 0',
              st['settings'].get('graceDurationDays') == 0, st['settings'])
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 7})
        check('18 graceDurationDays restored to 7 after the 0 check', s == 200, (s, r))
        # The toggle (0.8.8): a non-boolean is a 400; false reads
        # back as false. Restored to true right away — the rest of
        # this section needs the grace on.
        s, r = req('PUT', '/api/settings', {'graceEnabled': 'yes'})
        check('18 graceEnabled non-boolean is rejected (400)', s == 400, (s, r))
        s, r = req('PUT', '/api/settings', {'graceEnabled': False})
        check('18 graceEnabled false is valid', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 graceEnabled reads back as false',
              st['settings'].get('graceEnabled') is False, st['settings'])
        s, r = req('PUT', '/api/settings', {'graceEnabled': True})
        check('18 graceEnabled restored to true', s == 200, (s, r))

        # A price rule that HOLDS at the stub price ($98,200 >=
        # $90,000), a UTXO rule on an unspent outpoint, and a
        # check-in rule — all armed, none fired yet.
        restart()
        delete_all_txs()
        set_price(98200)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200001), 'label': 'Grace Price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}},
                                                'triggerConfirmed': True})
        check('18 the holding price tx adds (triggerConfirmed)', s == 201, (s, r))
        txg_price = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200002), 'label': 'Grace UTXO',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': SECOND + ':0'}}})
        check('18 the UTXO tx adds (outpoint unspent)', s == 201, (s, r))
        txg_utxo = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200003), 'label': 'Grace Check-in',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        check('18 the check-in tx adds', s == 201, (s, r))
        txg_ck = r['tx']['id'] if s == 201 else None
        # 6 days offline is within the 7-day threshold: no grace.
        set_clock(0, 6)
        s, st = req('GET', '/api/state')
        check('18 no grace when the offline gap (6d) is within the threshold (7d)',
              st.get('grace') is None, st.get('grace'))
        s, stat = req('GET', '/api/status')
        check('18 /api/status agrees — no grace field at a 6-day gap',
              'grace' not in stat, [k for k in stat.keys() if 'grace' in k.lower()])
        # 8 days offline is past the threshold: the grace sets on
        # the next read. lastCheckinAt stays fresh, so the
        # check-in rule is on-track, not due — but it is still
        # held by the grace while the grace is active.
        set_clock(0, 8)
        s, st = req('GET', '/api/state')
        g = st.get('grace') or {}
        check('18 a grace sets when the offline gap (8d) exceeds the threshold (7d)',
              g.get('active') is True and g.get('indefinite') is False and g.get('offlineGapDays') == 8, g)
        gu = g.get('graceUntil')
        check('18 graceUntil is ~7 days out (the default duration)',
              bool(gu) and abs((datetime.fromisoformat(gu.replace('Z', '+00:00'))
                                - datetime.now(timezone.utc)).total_seconds() - 7 * 86400) < 180,
              gu)
        check('18 no heldUntil anywhere in the served check-in state',
              'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
        s, stat = req('GET', '/api/status')
        check('18 /api/status stays grace-free even while a grace is active',
              'grace' not in stat, [k for k in stat.keys() if 'grace' in k.lower()])
        # The UTXO is spent (confirmed, 2 confs) and the price is
        # past the threshold — both would fire now, but the grace
        # holds them. (The trigger watches SECOND:0, not FINNEY:1:
        # every craft(1, ...) tx spends FINNEY:1 as its input, so
        # spending FINNEY:1 would make the txs themselves stale.)
        set_outspend(SECOND, 0, 899999)
        s, rc, res = release_results()
        check('18 the holding price tx does NOT fire during the grace (skipped, status grace)',
              res.get(txg_price, {}).get('action') == 'skipped'
              and res.get(txg_price, {}).get('triggerStatus') == 'grace',
              res.get(txg_price))
        check('18 the spent UTXO tx does NOT fire during the grace (skipped, status grace)',
              res.get(txg_utxo, {}).get('action') == 'skipped'
              and res.get(txg_utxo, {}).get('triggerStatus') == 'grace',
              res.get(txg_utxo))
        check('18 the check-in tx IS held by the grace too (skipped, status grace)',
              res.get(txg_ck, {}).get('action') == 'skipped'
              and res.get(txg_ck, {}).get('triggerStatus') == 'grace',
              res.get(txg_ck))
        check('18 neither tx broadcasted during the grace',
              (state_tx(txg_price) or {}).get('broadcasted') is None
              and (state_tx(txg_utxo) or {}).get('broadcasted') is None,
              ((state_tx(txg_price) or {}).get('broadcasted'), (state_tx(txg_utxo) or {}).get('broadcasted')))
        # Both-numbers grace card (0.8.8): of the three held txs,
        # only the price tx would fire now — its condition reads
        # met on the warm price cache. The UTXO tx would NOT: its
        # spend landed after its last evaluation, and the UTXO rule
        # reads its stored slice only (stale during a grace). The
        # check-in tx would NOT either: its clock is fresh. So the
        # card reads 1 of 3 would fire.
        s, st = req('GET', '/api/state')
        wf1 = {t.get('id'): (t.get('triggerStatus') or {}).get('wouldFire') for t in st.get('bitcoin', {}).get('txs', [])}
        check('18 wouldFire: the holding price tx would fire (warm price cache, 98200 >= 90000)',
              wf1.get(txg_price) is True, wf1.get(txg_price))
        check('18 wouldFire: the spent UTXO tx would NOT fire (no stored slice — the spend landed after its last evaluation)',
              wf1.get(txg_utxo) is False, wf1.get(txg_utxo))
        check('18 wouldFire: the on-track check-in tx would NOT fire (clock fresh)',
              wf1.get(txg_ck) is False, wf1.get(txg_ck))
        # Saving new grace settings does NOT change an active
        # grace (it keeps the duration it was created with).
        gu_before = (req('GET', '/api/state')[1].get('grace') or {}).get('graceUntil')
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 30})
        check('18 saving a new grace duration (30d) is a 200', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 the active grace keeps its original graceUntil after the settings change',
              (st.get('grace') or {}).get('graceUntil') == gu_before, st.get('grace'))
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 7})
        check('18 grace duration restored to 7', s == 200, (s, r))
        # Checking in does NOT clear the grace.
        s, r = req('POST', '/api/checkin', {})
        check('18 a check-in lands (200)', s == 200 and r.get('ok') is True, (s, r))
        s, st = req('GET', '/api/state')
        check('18 the grace is still active after a check-in',
              (st.get('grace') or {}).get('active') is True, st.get('grace'))
        check('18 the grace keeps its original graceUntil after a check-in',
              (st.get('grace') or {}).get('graceUntil') == gu_before, st.get('grace'))
        # Resume clears the grace; a second resume is a no-op 200.
        s, r = req('POST', '/api/grace/resume', {})
        check('18 POST /api/grace/resume clears the grace (200, grace null)',
              s == 200 and r.get('ok') is True and r.get('grace') is None, (s, r))
        s, st = req('GET', '/api/state')
        check('18 the grace is gone after resume', st.get('grace') is None, st.get('grace'))
        s, r = req('POST', '/api/grace/resume', {})
        check('18 a second resume is a no-op 200 (grace still null)',
              s == 200 and r.get('ok') is True and r.get('grace') is None, (s, r))
        # An indefinite grace (duration null) stays active until resumed.
        s, r = req('PUT', '/api/settings', {'graceDurationDays': None})
        check('18 grace duration set to null (indefinite)', s == 200, (s, r))
        set_clock(0, 8)
        s, st = req('GET', '/api/state')
        g = st.get('grace') or {}
        check('18 an indefinite grace sets (graceUntil null, indefinite true, 8 days offline)',
              g.get('active') is True and g.get('indefinite') is True
              and g.get('graceUntil') is None and g.get('offlineGapDays') == 8, g)
        s, r = req('POST', '/api/grace/resume', {})
        check('18 resume clears the indefinite grace',
              s == 200 and r.get('ok') is True and r.get('grace') is None, (s, r))
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 7})
        check('18 grace duration restored to 7', s == 200, (s, r))
        # After the grace EXPIRES, the triggers evaluate normally
        # and fire if the condition still holds. Seed an expired
        # grace (graceUntil an hour ago) with a FRESH lastOnlineAt,
        # so no new grace sets on the read. (The restart also
        # clears the price cache, so the price read is fresh.)
        restart()
        set_price(98200)
        stj = load_state_file()
        stj['grace'] = {'graceUntil': iso_ago(hours=1), 'triggeredAt': iso_ago(days=8), 'offlineGapDays': 8}
        stj['checkin']['lastOnlineAt'] = iso_now()
        stj['checkin']['lastCheckinAt'] = iso_now()
        save_state_file(stj)
        s, st = req('GET', '/api/state')
        check('18 an expired grace reads as no grace (grace null)',
              st.get('grace') is None, st.get('grace'))
        # The restart's startup full tick already fired both (the
        # grace was cleared and the conditions still hold) — the
        # release check below finds them already broadcast.
        pg = state_tx(txg_price)
        ug = state_tx(txg_utxo)
        check('18 after expiry the startup tick fired the holding price tx',
              ((pg or {}).get('release') or {}).get('status') == 'broadcast', (pg or {}).get('release'))
        check('18 after expiry the startup tick fired the spent UTXO tx',
              ((ug or {}).get('release') or {}).get('status') == 'broadcast', (ug or {}).get('release'))
        s, rc, res = release_results()
        check('18 after expiry the release check finds the price tx already broadcast',
              res.get(txg_price, {}).get('action') == 'skipped' and res.get(txg_price, {}).get('reason') == 'already broadcast', res.get(txg_price))
        check('18 after expiry the release check finds the UTXO tx already broadcast',
              res.get(txg_utxo, {}).get('action') == 'skipped' and res.get(txg_utxo, {}).get('reason') == 'already broadcast', res.get(txg_utxo))
        check('18 the check-in tx does NOT broadcast (clock fresh, not due)',
              res.get(txg_ck, {}).get('action') == 'skipped', res.get(txg_ck))
        # Clear the SECOND:0 override now: the next phase adds a
        # fresh UTXO tx on the same outpoint, and it must be
        # unspent at add time.
        set_outspend(SECOND, 0, None)
        # A check-in trigger IS held by the grace (0.8.8
        # unification): with the clock 36 days back and an 8-day
        # offline gap, the grace sets — and the due check-in tx
        # is held like the price and UTXO txs. Once the grace is
        # resumed it broadcasts.
        restart()
        delete_all_txs()
        set_price(98200)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200011), 'label': 'Grace Price 2',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}},
                                                'triggerConfirmed': True})
        check('18 the second holding price tx adds', s == 201, (s, r))
        txg_price2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200012), 'label': 'Grace UTXO 2',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': SECOND + ':0'}}})
        check('18 the second UTXO tx adds (outpoint unspent)', s == 201, (s, r))
        txg_utxo2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200013), 'label': 'Grace Check-in 2',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        check('18 the second check-in tx adds', s == 201, (s, r))
        txg_ck2 = r['tx']['id'] if s == 201 else None
        set_outspend(SECOND, 0, 899999)
        set_clock(36, 8)
        s, st = req('GET', '/api/state')
        check('18 the grace sets again on the 8-day gap',
              (st.get('grace') or {}).get('active') is True, st.get('grace'))
        s, rc, res = release_results()
        check('18 the due check-in tx is held by the grace too (skipped, status grace)',
              res.get(txg_ck2, {}).get('action') == 'skipped'
              and res.get(txg_ck2, {}).get('triggerStatus') == 'grace',
              res.get(txg_ck2))
        check('18 the second price tx is held by the grace (skipped, status grace)',
              res.get(txg_price2, {}).get('action') == 'skipped'
              and res.get(txg_price2, {}).get('triggerStatus') == 'grace',
              res.get(txg_price2))
        check('18 the second UTXO tx is held by the grace (skipped, status grace)',
              res.get(txg_utxo2, {}).get('action') == 'skipped'
              and res.get(txg_utxo2, {}).get('triggerStatus') == 'grace',
              res.get(txg_utxo2))
        check('18 the due check-in tx did NOT broadcast during the grace',
              (state_tx(txg_ck2) or {}).get('broadcasted') is None, (state_tx(txg_ck2) or {}).get('broadcasted'))
        # Both-numbers grace card (0.8.8): 2 of 3 would fire —
        # the holding price tx (warm cache) and the past-due
        # check-in tx (live clock, 36d past the 35d threshold).
        # The UTXO tx would NOT: its spend landed after its last
        # evaluation and its stored slice was never written.
        s, st = req('GET', '/api/state')
        wf2 = {t.get('id'): (t.get('triggerStatus') or {}).get('wouldFire') for t in st.get('bitcoin', {}).get('txs', [])}
        check('18 wouldFire: the second holding price tx would fire (warm price cache)',
              wf2.get(txg_price2) is True, wf2.get(txg_price2))
        check('18 wouldFire: the second spent UTXO tx would NOT fire (no stored slice)',
              wf2.get(txg_utxo2) is False, wf2.get(txg_utxo2))
        check('18 wouldFire: the past-due check-in tx would fire (live clock, 36d past 35d)',
              wf2.get(txg_ck2) is True, wf2.get(txg_ck2))
        # Resume: the due check-in tx broadcasts, like the price
        # and UTXO txs. The outspend cache still holds the
        # add-time "unspent" verdict (TTL = the cadence), so
        # clear just the outspend cache first — otherwise the
        # resumed check reads the stale verdict.
        s, r = req('POST', '/api/grace/resume', {})
        check('18 resumed after the held check-in leg', s == 200, (s, r))
        s, r = req('POST', '/api/__test__/clear-caches', {'only': ['outspend']})
        check('18 outspend cache cleared after the resume', s == 200 and r.get('ok') is True, (s, r))
        s, rc, res = release_results()
        check('18 the due check-in tx broadcasts once the grace is resumed',
              s == 200 and res.get(txg_ck2, {}).get('action') == 'broadcast', res.get(txg_ck2))
        check('18 the second price tx broadcasts once the grace is resumed',
              s == 200 and res.get(txg_price2, {}).get('action') == 'broadcast', res.get(txg_price2))
        check('18 the second UTXO tx broadcasts once the grace is resumed',
              s == 200 and res.get(txg_utxo2, {}).get('action') == 'broadcast', res.get(txg_utxo2))
        # Re-seed an active grace for the restore section below:
        # it expects the backup to carry an ACTIVE grace (and
        # the restore to drop it). lastOnlineAt is fresh after
        # the resume, so the seeded grace reads as-is.
        stj = load_state_file()
        stj['grace'] = {'graceUntil': (datetime.now(timezone.utc) + timedelta(days=6)).isoformat().replace('+00:00', 'Z'),
                        'triggeredAt': iso_ago(days=1), 'offlineGapDays': 8}
        save_state_file(stj)
        s, st = req('GET', '/api/state')
        check('18 an active grace is seeded again for the restore leg',
              (st.get('grace') or {}).get('active') is True, st.get('grace'))
        # Restore carries the grace settings + price sources
        # (0.8.0): the backup holds them (it dumps the whole
        # state), and the restore applies them — a backup from
        # before 0.8.0 carries none, which restores as the
        # defaults. The ACTIVE grace does NOT ride along: a
        # restore counts as a check-in (the owner is present),
        # so the grace is cleared.
        s, r = req('PUT', '/api/settings', {'graceOfflineDays': 14, 'graceDurationDays': 30,
                                            'priceSources': {'source1': 'kraken', 'source2': 'bitstamp'}})
        check('18 restore: non-default grace + price-source settings save', s == 200, (s, r))
        s, bak = req('GET', '/api/backup')
        check('18 restore: the backup carries the grace settings (14 / 30)',
              bak.get('state', {}).get('settings', {}).get('graceOfflineDays') == 14
              and bak.get('state', {}).get('settings', {}).get('graceDurationDays') == 30,
              bak.get('state', {}).get('settings'))
        check('18 restore: the backup carries the price sources (kraken / bitstamp)',
              bak.get('state', {}).get('settings', {}).get('priceSources') == {'source1': 'kraken', 'source2': 'bitstamp'},
              bak.get('state', {}).get('settings', {}).get('priceSources'))
        check('18 restore: the backup carries the ACTIVE grace (it is set now)',
              (bak.get('state', {}).get('grace') or {}).get('graceUntil') is not None,
              bak.get('state', {}).get('grace'))
        s, r = req('POST', '/api/restore', bak)
        check('18 restore: the restore lands', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 restore: the grace settings ride along (14 / 30)',
              st['settings']['graceOfflineDays'] == 14 and st['settings']['graceDurationDays'] == 30,
              st['settings'])
        check('18 restore: the price sources ride along (kraken / bitstamp)',
              st['settings'].get('priceSources') == {'source1': 'kraken', 'source2': 'bitstamp'},
              st['settings'].get('priceSources'))
        check('18 restore: the ACTIVE grace does NOT ride along (grace null — the restore counts as a check-in)',
              st.get('grace') is None, st.get('grace'))
        # A backup with an invalid grace setting rejects the
        # whole restore (400), like a bad node URL.
        bad = json.loads(json.dumps(bak))
        bad['state']['settings']['graceOfflineDays'] = 5
        s, r = req('POST', '/api/restore', bad)
        check('18 restore: a backup with graceOfflineDays 5 is a 400',
              s == 400 and 'graceOfflineDays' in (r.get('error') or ''), (s, r))
        bad = json.loads(json.dumps(bak))
        bad['state']['settings']['graceDurationDays'] = 5
        s, r = req('POST', '/api/restore', bad)
        check('18 restore: a backup with graceDurationDays 5 is a 400',
              s == 400 and 'graceDurationDays' in (r.get('error') or ''), (s, r))
        bad = json.loads(json.dumps(bak))
        bad['state']['settings']['priceSources'] = {'source1': 'kraken', 'source2': 'kraken'}
        s, r = req('POST', '/api/restore', bad)
        check('18 restore: a backup with identical price sources is a 400',
              s == 400 and 'price sources must be different' in (r.get('error') or ''), (s, r))
        # A backup from before 0.8.0 (no grace settings, no
        # priceSources) restores as the defaults.
        old = json.loads(json.dumps(bak))
        del old['state']['settings']['graceOfflineDays']
        del old['state']['settings']['graceDurationDays']
        del old['state']['settings']['priceSources']
        s, r = req('POST', '/api/restore', old)
        check('18 restore: a pre-0.8.0 backup (no grace/price-source settings) lands', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('18 restore: a pre-0.8.0 backup restores the grace defaults (7 / 7)',
              st['settings']['graceOfflineDays'] == 7 and st['settings']['graceDurationDays'] == 7,
              st['settings'])
        check('18 restore: a pre-0.8.0 backup restores the price-source defaults (coingecko / coinbase)',
              st['settings'].get('priceSources') == {'source1': 'coingecko', 'source2': 'coinbase'},
              st['settings'].get('priceSources'))
        # Cleanup: resume any grace, clear the outspend
        # overrides, put the price back, restore the default grace
        # settings, leave the clock fresh, and remove the txs.
        s, r = req('POST', '/api/grace/resume', {})
        check('18 cleanup: resume is a 200', s == 200, (s, r))
        set_outspend(SECOND, 0, None)
        set_price(98200)
        s, r = req('PUT', '/api/settings', {'graceOfflineDays': 7, 'graceDurationDays': 7})
        check('18 cleanup: grace settings back to 7 / 7', s == 200, (s, r))
        set_clock(0, 0)
        delete_all_txs()

        # --- 19. Getting Started empty-state card (0.8.0) -----------
        # The API suite cannot render the DOM, so this section
        # asserts the served markup and CSS the DOM suite renders:
        # the card exists at the top of the Dashboard (before the
        # grace card) with the owner's exact copy, and the .empty-state
        # rules (centered welcome layout, full-width button) are
        # in the served stylesheet. The show/hide behaviour and
        # the button navigation are covered in the DOM suite (§19).
        import urllib.request as _urlreq
        def _raw(path):
            with _urlreq.urlopen(BASE + path, timeout=20) as resp:
                return resp.status, resp.read().decode()
        s, idx19 = _raw('/')
        check('19 served index.html is a 200', s == 200, s)
        check('19 the Getting Started card exists (id + title + body verbatim + button)',
              'id="getting-started-card"' in idx19
              and '<h2>Getting Started</h2>' in idx19
              and 'Standby broadcasts presigned transactions based on the trigger criteria you define. Sign a transaction on your wallet, then add it here.' in idx19
              and 'id="btn-getting-started-add"' in idx19
              and '+ Add a pre-signed transaction' in idx19, idx19[idx19.find('getting-started-card') - 40:idx19.find('getting-started-card') + 400])
        check('19 the card sits at the top of the dashboard (before the grace card)',
              idx19.index('id="getting-started-card"') < idx19.index('id="grace-card"'), '')
        check('19 the button is orange (primary) and full-width is a CSS rule, not inline',
              'id="btn-getting-started-add" class="primary"' in idx19, '')
        check('19 the card is a plain card (no amber left border — no grace-card class on it)',
              'class="card empty-state"' in idx19 and 'class="card empty-state grace-card"' not in idx19, '')
        s, css19 = _raw('/style.css')
        check('19 served style.css is a 200', s == 200, s)
        check('19 the .empty-state rules are in the served stylesheet (centered, padded, h2 20px, muted 15px body, full-width button)',
              '.empty-state { text-align: center; padding: 28px 20px 24px; }' in css19
              and '.empty-state h2 { font-size: 20px;' in css19
              and '.empty-state p { color: var(--muted); font-size: 15px;' in css19
              and '.empty-state button { width: 100%; padding: 14px 20px; font-size: 17px; font-weight: 600; }' in css19, css19[css19.find('.empty-state'):css19.find('.empty-state') + 400])

        # --- 20. user controls: price agreement, check cadence, fee verdict (0.8.0) ---
        # Three Settings cards, each a number input with min/max
        # bounds and its own Save button. The server is the
        # authority: out-of-range values are a 400, never a
        # silent clamp. The fee pair is validated together so a
        # partial update cannot break Low-above-Medium. The
        # cadence drives BOTH the full-tick interval and the
        # price-cache TTL, so a faster cadence actually fetches
        # faster and a slower one refetches less.
        # (a) Defaults read back on the current state.
        s, st = req('GET', '/api/state')
        check('20 defaults read back (agreement 5% / cadence 60s / fee Low 2 / Medium 1)',
              st.get('settings', {}).get('priceAgreementPct') == 5
              and st.get('settings', {}).get('checkCadenceSeconds') == 60
              and st.get('settings', {}).get('feeLowMultiplier') == 2
              and st.get('settings', {}).get('feeMediumMultiplier') == 1,
              st.get('settings'))
        # (b) PUT validation: each field 400s outside its bounds.
        for bad_pa in (0, 0.5, 21, '5'):
            s, r = req('PUT', '/api/settings', {'priceAgreementPct': bad_pa})
            check('20 priceAgreementPct %r is a 400' % (bad_pa,),
                  s == 400 and 'priceAgreementPct' in (r.get('error') or ''), (s, r))
        for bad_cc in (9, 0, 3601, '60'):
            s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': bad_cc})
            check('20 checkCadenceSeconds %r is a 400' % (bad_cc,),
                  s == 400 and 'checkCadenceSeconds' in (r.get('error') or ''), (s, r))
        for bad_low in (0.9, 11, '2'):
            s, r = req('PUT', '/api/settings', {'feeLowMultiplier': bad_low})
            check('20 feeLowMultiplier %r is a 400' % (bad_low,),
                  s == 400 and 'feeLowMultiplier' in (r.get('error') or ''), (s, r))
        for bad_med in (0.4, 6, '1'):
            s, r = req('PUT', '/api/settings', {'feeMediumMultiplier': bad_med})
            check('20 feeMediumMultiplier %r is a 400' % (bad_med,),
                  s == 400 and 'feeMediumMultiplier' in (r.get('error') or ''), (s, r))
        # Low <= Medium is a 400, both together and as a partial
        # update against the saved value.
        s, r = req('PUT', '/api/settings', {'feeLowMultiplier': 1, 'feeMediumMultiplier': 1})
        check('20 fee Low 1 + Medium 1 (Low == Medium) is a 400',
              s == 400 and 'greater than' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/settings', {'feeLowMultiplier': 1, 'feeMediumMultiplier': 2})
        check('20 fee Low 1 + Medium 2 (Low < Medium) is a 400',
              s == 400 and 'greater than' in (r.get('error') or ''), (s, r))
        s, r = req('PUT', '/api/settings', {'feeMediumMultiplier': 2})
        check('20 fee Medium 2 alone (against saved Low 2) is a 400',
              s == 400 and 'greater than' in (r.get('error') or ''), (s, r))
        # (c) Saving valid values sticks (read back via /api/state).
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 2, 'checkCadenceSeconds': 10, 'feeLowMultiplier': 3, 'feeMediumMultiplier': 1.5})
        check('20 valid values save (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('20 saved values read back (agreement 2% / cadence 10s / fee Low 3 / Medium 1.5)',
              st['settings']['priceAgreementPct'] == 2
              and st['settings']['checkCadenceSeconds'] == 10
              and st['settings']['feeLowMultiplier'] == 3
              and st['settings']['feeMediumMultiplier'] == 1.5,
              st['settings'])
        # (d) Price agreement behaviour: two readings 2% apart
        # count at 2% but not at 1%. Restart first so the price
        # cache is cold (the cache would otherwise serve the
        # pre-change readings); the stub prices are set per
        # provider. A clean slate (no txs) so no full-tick
        # broadcast can fire while the agreement is being probed.
        delete_all_txs()
        clear_caches()
        set_price(98200, provider='coingecko')
        set_price(100164, provider='coinbase')
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('20 at agreement 2%, a 2%-apart reading counts (fire true)',
              s == 200 and r.get('fire') is True, r)
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 1})
        check('20 agreement set to 1%', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('20 at agreement 1%, the same 2%-apart reading is unknown (disagree, no fire)',
              s == 200 and r.get('fire') is False and r.get('status') == 'unknown'
              and 'disagree' in (r.get('reason') or ''), r)
        # The consensus display follows the same rule: at 1% the
        # two readings disagree, so /api/state shows no consensus
        # price; at 2% it shows the PRIMARY exchange's price
        # (CoinGecko's $98,200), not an average.
        s, st = req('GET', '/api/state')
        check('20 at agreement 1%, the consensus price is null (readings disagree)',
              st.get('bitcoin', {}).get('currentPrice') is None, st.get('bitcoin', {}).get('currentPrice'))
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 2})
        check('20 agreement back to 2%', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('20 at agreement 2%, the consensus price is the primary price ($98,200)',
              st.get('bitcoin', {}).get('currentPrice') == 98200, st.get('bitcoin', {}).get('currentPrice'))
        # Restore the stub prices (both $98,200) and the agreement
        # default for the cadence test below.
        set_price(98200)
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 5})
        check('20 agreement restored to 5%', s == 200, (s, r))
        # (e) Check cadence behaviour: the full tick honours the
        # saved delay. At 10s a firing price tx (spending the
        # SECOND parent, which no earlier section spends) is
        # broadcast by a full tick within ~15s; at 3600s an
        # identical firing tx is still unbroadcast after 60s.
        # The price rule is already true at add time, so the add
        # needs triggerConfirmed (the guard from §15).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(SECOND, 0, 100000), 'label': 'Cadence 10s', 'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('20 cadence 10s: seeding a firing price tx (201)', s == 201, (s, r))
        cad10 = r.get('tx', {}).get('id')
        # (Optimization O5) Poll until the full tick broadcasts
        # it — the tick's observable effect, not a fixed 15 s
        # wait for a 10 s cadence.
        wait_until(lambda: (state_tx(cad10) or {}).get('broadcasted') is not None, deadline=20)
        check('20 cadence 10s: the full tick broadcast it within ~15s',
              state_tx(cad10) is not None and state_tx(cad10).get('broadcasted') is not None,
              state_tx(cad10))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('20 cadence set to 3600s', s == 200, (s, r))
        # A different output value (100001) so the hex differs
        # from the Cadence 10s tx — the same hex would be
        # rejected as a duplicate of the stored tx.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(SECOND, 0, 100001), 'label': 'Cadence 3600s', 'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        check('20 cadence 3600s: seeding an identical firing price tx (201)', s == 201, (s, r))
        cad3600 = r.get('tx', {}).get('id')
        check('20 cadence 3600s: the tx is not broadcast yet at seed time',
              state_tx(cad3600) is not None and state_tx(cad3600).get('broadcasted') is None,
              state_tx(cad3600))
        # (Optimization O5) The next tick is 3600 s away and the
        # PUT above re-armed the interval, so no 10 s tick is in
        # flight — a 20 s wait proves no tick fired, the same
        # evidence the 60 s wait bought.
        time.sleep(20)
        check('20 cadence 3600s: no full-tick evaluation fired in the next ~20s (still unbroadcast)',
              state_tx(cad3600) is not None and state_tx(cad3600).get('broadcasted') is None,
              state_tx(cad3600))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('20 cadence restored to 60s', s == 200, (s, r))
        delete_all_txs()
        # (f) Broadcast fee risk multipliers, called directly on
        # lib/bitcoin.js (the same pattern as the 094 suite):
        # peak 2.0 sat/vB (a plain input to the pure verdict
        # function — the peak itself now comes from the recorded
        # fee history, proved in the API suite's §31). A 4.0
        # sat/vB fee is Low at the defaults (2x/1x) and Medium
        # at 3x/1.5x; 2.5 sat/vB is Medium at the defaults and
        # High at 3x/1.5x. The Critical check (below the economy
        # fee) does not move with the multipliers.
        node_js = (
            "const b = require('./lib/bitcoin.js');"
            "console.log(JSON.stringify({"
            " d4: b.feeVerdict(4.0, 2.0, 1),"
            " c4: b.feeVerdict(4.0, 2.0, 1, 3, 1.5),"
            " d25: b.feeVerdict(2.5, 2.0, 1),"
            " c25: b.feeVerdict(2.5, 2.0, 1, 3, 1.5),"
            " dCrit: b.feeVerdict(0.6, 2.0, 1),"
            " cCrit: b.feeVerdict(0.6, 2.0, 1, 3, 1.5),"
            " dNoMult: b.feeVerdict(4.0, 2.0, 1, undefined, undefined)"
            "}));"
        )
        nr = subprocess.run(['node', '-e', node_js], capture_output=True, text=True, cwd=APP, timeout=30)
        try:
            nv = json.loads(nr.stdout.strip())
        except Exception:
            nv = {}
        check('20 fee verdict: 4.0 sat/vB vs peak 2.0 is Low Risk at the defaults (2x/1x)',
              nv.get('d4') == 'Low Risk', nv)
        check('20 fee verdict: the same 4.0 sat/vB is Medium Risk at Low 3 / Medium 1.5',
              nv.get('c4') == 'Medium Risk', nv)
        check('20 fee verdict: 2.5 sat/vB is Medium Risk at the defaults',
              nv.get('d25') == 'Medium Risk', nv)
        check('20 fee verdict: the same 2.5 sat/vB is High Risk at Low 3 / Medium 1.5',
              nv.get('c25') == 'High Risk', nv)
        check('20 fee verdict: Critical (below the economy fee) does not move with the multipliers',
              nv.get('dCrit') == 'Critical Risk' and nv.get('cCrit') == 'Critical Risk', nv)
        check('20 fee verdict: omitted multipliers fall back to the defaults (2x/1x)',
              nv.get('dNoMult') == 'Low Risk', nv)
        # (g) Restore carries all four through with the same
        # validation as PUT (the grace/price-source restore
        # pattern): a backup with the values restores them, a
        # backup with an invalid value 400s and changes nothing,
        # and a pre-0.8.0 backup without them gets the defaults.
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 2, 'checkCadenceSeconds': 10, 'feeLowMultiplier': 3, 'feeMediumMultiplier': 1.5})
        check('20 restore: non-default values saved for the backup', s == 200, (s, r))
        s, bak = req('GET', '/api/backup')
        check('20 restore: the backup carries all four values',
              s == 200
              and bak.get('state', {}).get('settings', {}).get('priceAgreementPct') == 2
              and bak.get('state', {}).get('settings', {}).get('checkCadenceSeconds') == 10
              and bak.get('state', {}).get('settings', {}).get('feeLowMultiplier') == 3
              and bak.get('state', {}).get('settings', {}).get('feeMediumMultiplier') == 1.5,
              bak.get('state', {}).get('settings'))
        s, r = req('POST', '/api/restore', bak)
        check('20 restore: the round-trip lands (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('20 restore: the non-default values survive the round-trip',
              st['settings']['priceAgreementPct'] == 2
              and st['settings']['checkCadenceSeconds'] == 10
              and st['settings']['feeLowMultiplier'] == 3
              and st['settings']['feeMediumMultiplier'] == 1.5,
              st['settings'])
        for field, badval, why in (
                ('priceAgreementPct', 0, 'agreement 0'),
                ('checkCadenceSeconds', 5, 'cadence 5s'),
                ('feeLowMultiplier', 11, 'Low 11'),
                ('feeMediumMultiplier', 0.4, 'Medium 0.4')):
            bak_bad = copy.deepcopy(bak)
            bak_bad['state']['settings'][field] = badval
            s, r = req('POST', '/api/restore', bak_bad)
            check('20 restore: a backup with %s is a 400' % why,
                  s == 400 and field in (r.get('error') or ''), (s, r))
        bak_bad = copy.deepcopy(bak)
        bak_bad['state']['settings']['feeLowMultiplier'] = 1
        bak_bad['state']['settings']['feeMediumMultiplier'] = 1
        s, r = req('POST', '/api/restore', bak_bad)
        check('20 restore: a backup with Low == Medium is a 400',
              s == 400 and 'greater than' in (r.get('error') or ''), (s, r))
        s, st = req('GET', '/api/state')
        check('20 restore: the failed restores changed nothing (values still 2/10/3/1.5)',
              st['settings']['priceAgreementPct'] == 2
              and st['settings']['checkCadenceSeconds'] == 10
              and st['settings']['feeLowMultiplier'] == 3
              and st['settings']['feeMediumMultiplier'] == 1.5,
              st['settings'])
        bak_old = copy.deepcopy(bak)
        for field in ('priceAgreementPct', 'checkCadenceSeconds', 'feeLowMultiplier', 'feeMediumMultiplier'):
            bak_old['state']['settings'].pop(field, None)
        s, r = req('POST', '/api/restore', bak_old)
        check('20 restore: a pre-0.8.0 backup without the fields lands (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('20 restore: the pre-0.8.0 backup gets the defaults (5/60/2/1)',
              st['settings']['priceAgreementPct'] == 5
              and st['settings']['checkCadenceSeconds'] == 60
              and st['settings']['feeLowMultiplier'] == 2
              and st['settings']['feeMediumMultiplier'] == 1,
              st['settings'])
        # Cleanup: settings back to the defaults, the stub price
        # back to $98,200 on all providers, no txs left, the
        # check-in clock fresh (the restore counted as one, but
        # be explicit for the next section's port check).
        s, r = req('PUT', '/api/settings', {'priceAgreementPct': 5, 'checkCadenceSeconds': 60, 'feeLowMultiplier': 2, 'feeMediumMultiplier': 1})
        check('20 cleanup: settings restored to the defaults', s == 200, (s, r))
        set_price(98200)
        delete_all_txs()
        set_clock(0, 0)

        # --- 21. pause/vacation/disarm redesign: the freeze (0.8.0) ---
        # Inactive time does not count toward the check-in
        # countdown. One per-tx offset carries all three inactive
        # causes (vacation, global disarm, per-tx disarm), so a
        # period where a tx was BOTH disarmed and on vacation is
        # counted once. `paused` is gone entirely. Time is
        # simulated the way the freeze measures it: lastCheckinAt
        # is backdated AND the open inactive period is backdated
        # (set_tx_freeze), so the live offset is the simulated
        # inactive span; set_clock_margin adds 30 s so floored
        # day counts land exactly (a banked offset carries a few
        # ms of test-execution time).
        # (a) Vacation freeze: 13/25, vacation on, +14 days, still
        # 13/25; off, resumes from 13 and advances from there.
        delete_all_txs()
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210101), 'label': 'V21a ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21a = r['tx']['id'] if s == 201 else None
        check('21a setup: the 25d check-in tx added', s == 201, r)
        check('21a setup: the new tx carries the freeze fields (0 / null)',
              r.get('tx', {}).get('checkinOffsetMs') == 0 and r.get('tx', {}).get('checkinInactiveSince') is None, r.get('tx'))
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21a check-in lands', s == 200 and r.get('ok') is True, r)
        check('21a the check-in response carries no autoResumed (pause auto-resume is gone)',
              'autoResumed' not in r, r)
        set_clock(13)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21a at 13 days back the bar reads 13 of 25',
              bars.get(txv21a, {}).get('daysSince') == 13 and bars.get(txv21a, {}).get('windowDays') == 25, bars.get(txv21a))
        fut = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': fut})
        check('21a vacation on (dated, +30d)', s == 200 and r.get('vacationMode') is True and r.get('vacationUntil') == fut, r)
        s, st = req('GET', '/api/status')
        check('21a on vacation the card state is vacation',
              st.get('state') == 'vacation' and st.get('label') == 'Vacation mode', st.get('state'))
        # Simulate 14 days passing on vacation: the clock is 27
        # days back, the inactive period started 14 days ago.
        set_clock_margin(27)
        set_tx_freeze(txv21a, inactive_since=iso_ago(days=14))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21a vacation +14d simulated: the bar is STILL 13 of 25 (frozen)',
              bars.get(txv21a, {}).get('daysSince') == 13 and bars.get(txv21a, {}).get('windowDays') == 25, bars.get(txv21a))
        check('21a vacation +14d simulated: the top-level daysSince is the frozen 13 too',
              st.get('daysSince') == 13, st.get('daysSince'))
        s, r = req('PUT', '/api/settings', {'vacationMode': False})
        check('21a vacation off', s == 200 and r.get('vacationMode') is False, r)
        off_ms, inact = tx_freeze(txv21a)
        check('21a turning vacation off banks the 14-day offset (and closes the period)',
              inact is None and isinstance(off_ms, (int, float)) and abs(off_ms - 14 * 86400000) < 60000, (off_ms, inact))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21a right after vacation off the bar still reads 13 of 25 (resumes from the frozen count)',
              bars.get(txv21a, {}).get('daysSince') == 13, bars.get(txv21a))
        set_clock_margin(28)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21a one more day later the bar advances from the frozen count: 14 of 25',
              bars.get(txv21a, {}).get('daysSince') == 14 and bars.get(txv21a, {}).get('windowDays') == 25, bars.get(txv21a))
        # (b) Vacation is check-in-only: while on vacation, a
        # price tx past threshold FIRES and a UTXO tx fires, but
        # a check-in tx past threshold does NOT fire. Restart
        # first (fresh full-tick clock + empty price cache), so
        # the manual release check lands inside one 60 s window.
        delete_all_txs()
        check('21b restart before the vacation check-in-only evals', restart())
        s, pr = set_outspend(FINNEY, 0, 899999)
        check('21b outspend override set: FINNEY:0 at block 899999 (2 confirmations)',
              s == 200 and pr.get('overrides', {}).get(FINNEY.lower() + ':0') == 899999, pr)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210201), 'label': 'V21b ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21b_ck = r['tx']['id'] if s == 201 else None
        check('21b the check-in tx added', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210203), 'label': 'V21b price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txv21b_pr = r['tx']['id'] if s == 201 else None
        check('21b the price tx added (holding at $98,200, triggerConfirmed)', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210205), 'label': 'V21b utxo',
                                                'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 'triggerConfirmed': True})
        txv21b_ux = r['tx']['id'] if s == 201 else None
        check('21b the UTXO tx added (spent, triggerConfirmed)', s == 201, r)
        set_clock(30)  # the check-in tx is 5 days past its 25d due
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': fut})
        check('21b vacation on', s == 200 and r.get('vacationMode') is True, r)
        s, r, res = release_results()
        check('21b on vacation: the price tx FIRES (vacation is check-in-only)',
              res.get(txv21b_pr, {}).get('action') == 'broadcast', res.get(txv21b_pr))
        check('21b on vacation: the UTXO tx FIRES (vacation is check-in-only)',
              res.get(txv21b_ux, {}).get('action') == 'broadcast', res.get(txv21b_ux))
        check('21b on vacation: the check-in tx does NOT fire (skipped, status vacation)',
              res.get(txv21b_ck, {}).get('action') == 'skipped' and res.get(txv21b_ck, {}).get('triggerStatus') == 'vacation',
              res.get(txv21b_ck))
        check('21b on vacation: the check-in tx is still un-broadcast',
              not (state_tx(txv21b_ck) or {}).get('broadcasted'), state_tx(txv21b_ck))
        s, st = req('GET', '/api/status')
        check('21b on vacation: the card state is vacation, not release-due',
              st.get('state') == 'vacation', st.get('state'))
        s, pr = set_outspend(FINNEY, 0, None)
        check('21b outspend override cleared', s == 200, pr)
        s, r = req('PUT', '/api/settings', {'vacationMode': False})
        check('21b vacation off (cleanup)', s == 200 and r.get('vacationMode') is False, r)
        delete_all_txs()
        # (c) Disarm freeze: disarm at 13/25, advance time, the
        # bar shows the frozen 13/25; re-arm, it resumes from 13.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210301), 'label': 'V21c ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21c = r['tx']['id'] if s == 201 else None
        check('21c setup: the 25d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21c check-in lands', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21c, {'enabled': False})
        check('21c disarming the tx at 13/25', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        set_clock_margin(27)
        set_tx_freeze(txv21c, inactive_since=iso_ago(days=14))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21c disarmed +14d simulated: the bar shows the frozen 13 of 25 (enabled=false)',
              bars.get(txv21c, {}).get('daysSince') == 13 and bars.get(txv21c, {}).get('windowDays') == 25
              and bars.get(txv21c, {}).get('enabled') is False, bars.get(txv21c))
        check('21c disarmed +14d simulated: the card stays on-track (a disarmed tx cannot make it release-due)',
              st.get('state') == 'on-track', st.get('state'))
        check('21c disarmed +14d simulated: the top-level due is null (no armed tx drives it)',
              st.get('nextDue') is None and st.get('windowDays') is None, (st.get('nextDue'), st.get('windowDays')))
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21c, {'enabled': True})
        check('21c re-arming the tx', s == 200 and r.get('tx', {}).get('enabled') is True, r)
        off_ms, inact = tx_freeze(txv21c)
        check('21c re-arming banks the 14-day offset (and closes the period)',
              inact is None and isinstance(off_ms, (int, float)) and abs(off_ms - 14 * 86400000) < 60000, (off_ms, inact))
        set_clock_margin(28)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21c one more day later the bar advances from the frozen count: 14 of 25',
              bars.get(txv21c, {}).get('daysSince') == 14, bars.get(txv21c))
        delete_all_txs()
        # (d) Global Arm/Disarm: the toggle disarms all txs and
        # arms all; while globally disarmed the check-in counts
        # freeze; on re-arm they resume from the frozen value.
        # Checking in does NOT re-arm anything (no global pause
        # to auto-resume any more).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210401), 'label': 'V21d ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21d_ck25 = r['tx']['id'] if s == 201 else None
        check('21d setup: the 25d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210403), 'label': 'V21d ck 35d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        txv21d_ck35 = r['tx']['id'] if s == 201 else None
        check('21d setup: the 35d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210405), 'label': 'V21d price',
                                                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 'triggerConfirmed': True})
        txv21d_pr = r['tx']['id'] if s == 201 else None
        check('21d setup: the price tx added', s == 201, r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21d check-in lands', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        s, r = req('POST', '/api/bitcoin/txs/arm-all', {'enabled': False})
        check('21d Disarm all: 200, count 3, every tx disarmed',
              s == 200 and r.get('enabled') is False and r.get('count') == 3
              and all((t.get('enabled') is False) for t in r.get('txs', [])), r)
        set_clock_margin(20)
        for txid in (txv21d_ck25, txv21d_ck35):
            set_tx_freeze(txid, inactive_since=iso_ago(days=7))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21d globally disarmed +7d simulated: both bars frozen at 13 (25d and 35d)',
              bars.get(txv21d_ck25, {}).get('daysSince') == 13
              and bars.get(txv21d_ck35, {}).get('daysSince') == 13, st.get('checkinTxs'))
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21d check-in lands while globally disarmed', s == 200 and r.get('ok') is True, r)
        s, st = req('GET', '/api/state')
        check('21d checking in does NOT re-arm anything (all three txs still disarmed)',
              all((t.get('enabled') is False) for t in st.get('bitcoin', {}).get('txs', [])), st.get('bitcoin', {}).get('txs'))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21d the check-in resets the frozen bars to 0 of their windows',
              bars.get(txv21d_ck25, {}).get('daysSince') == 0 and bars.get(txv21d_ck35, {}).get('daysSince') == 0, st.get('checkinTxs'))
        s, r = req('POST', '/api/bitcoin/txs/arm-all', {'enabled': True})
        check('21d Arm all: 200, every tx armed again',
              s == 200 and r.get('enabled') is True
              and all((t.get('enabled') is True) for t in r.get('txs', [])), r)
        set_clock_margin(1)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21d one day after re-arming the bars read 1 of their windows (resumed from 0)',
              bars.get(txv21d_ck25, {}).get('daysSince') == 1 and bars.get(txv21d_ck35, {}).get('daysSince') == 1, st.get('checkinTxs'))
        s, r = req('POST', '/api/bitcoin/txs/arm-all', {})
        check('21d arm-all without enabled is a 400', s == 400 and 'enabled' in (r.get('error') or ''), (s, r))
        delete_all_txs()
        # (e) Manual broadcast while disarmed: Broadcast Now on a
        # disarmed tx SUCCEEDS (it already bypassed disarm — this
        # locks the behaviour in); an automatic release does NOT
        # fire a disarmed tx (0.8.4: it evaluates it and lists it
        # as skipped); Broadcast Armed does not include a
        # disarmed tx; Broadcast All (not armed-only) DOES send a
        # disarmed tx, by design.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210501), 'label': 'V21e ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21e = r['tx']['id'] if s == 201 else None
        check('21e setup: the 25d check-in tx added', s == 201, r)
        set_clock(30)  # 5 days past due
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21e, {'enabled': False})
        check('21e disarming the past-due tx', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        s, r, res = release_results()
        check('21e an automatic release does NOT fire a disarmed tx (evaluated, listed as skipped — 0.8.4)',
              res.get(txv21e, {}).get('action') == 'skipped'
              and (res.get(txv21e, {}).get('reason') or '').startswith('disarmed'), res.get(txv21e))
        check('21e the disarmed tx is still un-broadcast after the release check',
              not (state_tx(txv21e) or {}).get('broadcasted'), state_tx(txv21e))
        s, st = req('GET', '/api/status')
        check('21e the card is on-track, not release-due, with the tx disarmed past due',
              st.get('state') == 'on-track', st.get('state'))
        s, r = req('POST', '/api/bitcoin/txs/' + txv21e + '/broadcast', {})
        check('21e Broadcast Now on the disarmed tx SUCCEEDS (manual bypasses disarm)',
              s == 200 and r.get('action') == 'broadcast', r)
        check('21e the disarmed tx is broadcast after the manual broadcast',
              bool((state_tx(txv21e) or {}).get('broadcasted')), state_tx(txv21e))
        delete_all_txs()
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210511), 'label': 'V21e armed',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21e_armed = r['tx']['id'] if s == 201 else None
        check('21e setup: the armed tx added', s == 201, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210513), 'label': 'V21e disarmed',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21e_dis = r['tx']['id'] if s == 201 else None
        check('21e setup: the to-be-disarmed tx added', s == 201, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21e_dis, {'enabled': False})
        check('21e disarming the second tx', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        s, r = req('POST', '/api/broadcast/all', {'armedOnly': True, 'ids': [txv21e_armed, txv21e_dis]})
        check('21e Broadcast Armed sends the armed tx only (the disarmed one is skipped)',
              s == 200 and [x.get('id') for x in r.get('results', [])] == [txv21e_armed], r)
        check('21e the disarmed tx is still un-broadcast after Broadcast Armed',
              not (state_tx(txv21e_dis) or {}).get('broadcasted'), state_tx(txv21e_dis))
        s, r = req('POST', '/api/broadcast/all', {'ids': [txv21e_dis]})
        check('21e Broadcast All (not armed-only) DOES send the disarmed tx, by design',
              s == 200 and r.get('action') == 'broadcast', r)
        check('21e the disarmed tx is broadcast after Broadcast All',
              bool((state_tx(txv21e_dis) or {}).get('broadcasted')), state_tx(txv21e_dis))
        delete_all_txs()
        # (f) Indefinite vacation: vacationUntil null stays on
        # vacation (does not expire), clock frozen; turning it
        # off resumes from the frozen count. Dated vacation
        # expires at vacationUntil (end of day) and resumes from
        # the frozen count.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210601), 'label': 'V21f ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21f = r['tx']['id'] if s == 201 else None
        check('21f setup: the 25d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21f check-in lands', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
        check('21f indefinite vacation on (vacationUntil null)',
              s == 200 and r.get('vacationMode') is True and r.get('vacationUntil') is None, r)
        set_clock_margin(27)
        set_tx_freeze(txv21f, inactive_since=iso_ago(days=14))
        s, r, res = release_results()
        check('21f a release evaluation does NOT end an indefinite vacation',
              s == 200, r)
        s, st = req('GET', '/api/state')
        check('21f the indefinite vacation is still on after the release check',
              st.get('settings', {}).get('vacationMode') is True and st.get('settings', {}).get('vacationUntil') is None,
              st.get('settings'))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21f the indefinite vacation keeps the bar frozen at 13 of 25',
              bars.get(txv21f, {}).get('daysSince') == 13, bars.get(txv21f))
        s, r = req('PUT', '/api/settings', {'vacationMode': False})
        check('21f indefinite vacation off', s == 200 and r.get('vacationMode') is False, r)
        set_clock_margin(28)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21f after turning it off the bar advances from the frozen count: 14 of 25',
              bars.get(txv21f, {}).get('daysSince') == 14, bars.get(txv21f))
        # Dated: vacationUntil 2 days ago (safely past end-of-day
        # in any timezone) — the next release evaluation ends it.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21f check-in lands before the dated-vacation leg', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        past = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': past})
        check('21f dated vacation on (until 2 days ago)', s == 200 and r.get('vacationMode') is True and r.get('vacationUntil') == past, r)
        set_clock_margin(27)
        set_tx_freeze(txv21f, inactive_since=iso_ago(days=14))
        s, r, res = release_results()
        check('21f the release evaluation runs with the lapsed vacation', s == 200, r)
        s, st = req('GET', '/api/state')
        check('21f the dated vacation EXPIRED on the evaluation (mode off, until null)',
              st.get('settings', {}).get('vacationMode') is False and st.get('settings', {}).get('vacationUntil') is None,
              st.get('settings'))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21f the expired vacation resumes from the frozen count: still 13 of 25',
              bars.get(txv21f, {}).get('daysSince') == 13, bars.get(txv21f))
        set_clock_margin(28)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21f one more day later the bar advances from the frozen count: 14 of 25',
              bars.get(txv21f, {}).get('daysSince') == 14, bars.get(txv21f))
        # A vacation ending TODAY does not expire yet (the owner
        # is away through today).
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21f check-in lands before the ends-today leg', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        today = datetime.now().strftime('%Y-%m-%d')
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': today})
        check('21f vacation until today on', s == 200 and r.get('vacationMode') is True, r)
        s, r, res = release_results()
        s, st = req('GET', '/api/state')
        check('21f a vacation ending today does NOT expire yet (away through today)',
              st.get('settings', {}).get('vacationMode') is True and st.get('settings', {}).get('vacationUntil') == today,
              st.get('settings'))
        s, r = req('PUT', '/api/settings', {'vacationMode': False})
        check('21f vacation off (cleanup)', s == 200, r)
        delete_all_txs()
        # (g) No double-counting: disarm -> vacation on -> vacation
        # off -> re-arm. The frozen count is counted once: the
        # banked offset equals the single 14-day disarm period,
        # not disarm + vacation.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210701), 'label': 'V21g ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21g = r['tx']['id'] if s == 201 else None
        check('21g setup: the 25d check-in tx added', s == 201, r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21g check-in lands', s == 200 and r.get('ok') is True, r)
        set_clock(13)
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21g, {'enabled': False})
        check('21g disarming the tx at 13/25', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        # 5 days pass disarmed only.
        set_clock_margin(18)
        set_tx_freeze(txv21g, inactive_since=iso_ago(days=5))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21g 5 days disarmed: still 13 of 25',
              bars.get(txv21g, {}).get('daysSince') == 13, bars.get(txv21g))
        off_before, inact_before = tx_freeze(txv21g)
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
        check('21g vacation on while already disarmed', s == 200 and r.get('vacationMode') is True, r)
        off_after, inact_after = tx_freeze(txv21g)
        check('21g the second cause does NOT restart the inactive period (inactiveSince unchanged)',
              inact_after == inact_before and off_after == off_before, (inact_before, inact_after))
        # 9 more days pass, disarmed AND on vacation.
        set_clock_margin(27)
        set_tx_freeze(txv21g, inactive_since=iso_ago(days=14))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21g 9 more days, disarmed + on vacation: still 13 of 25 (counted once)',
              bars.get(txv21g, {}).get('daysSince') == 13, bars.get(txv21g))
        s, r = req('PUT', '/api/settings', {'vacationMode': False})
        check('21g vacation off', s == 200 and r.get('vacationMode') is False, r)
        off_ms, inact = tx_freeze(txv21g)
        check('21g vacation off does NOT bank yet — the tx is still disarmed, so it stays inactive (offset 0, period open)',
              off_ms == 0 and inact is not None, (off_ms, inact))
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21g still disarmed after vacation off: the bar stays frozen at 13 of 25',
              bars.get(txv21g, {}).get('daysSince') == 13, bars.get(txv21g))
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21g, {'enabled': True})
        check('21g re-arming the tx', s == 200 and r.get('tx', {}).get('enabled') is True, r)
        off_ms, inact = tx_freeze(txv21g)
        check('21g re-arming banks ONE 14-day offset (not 5 + 9 + 9, not 9)',
              inact is None and isinstance(off_ms, (int, float)) and abs(off_ms - 14 * 86400000) < 60000, (off_ms, inact))
        set_clock_margin(28)
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('21g one more day later the bar advances from the frozen count: 14 of 25',
              bars.get(txv21g, {}).get('daysSince') == 14, bars.get(txv21g))
        delete_all_txs()
        # (h) `paused` is gone: PUT with paused is a 400, POST
        # /api/pause and POST /api/resume are 404s, a backup
        # carrying paused restores without it and without error.
        # A backup carrying the new offset fields restores them
        # (validated); a pre-redesign backup without them gets
        # the defaults 0 / null. (Restore counts as a check-in,
        # so carried offsets are reset to the new clock — a
        # disarmed tx is re-marked inactive from the restore.)
        s, r = req('PUT', '/api/settings', {'paused': True})
        check('21h PUT /api/settings with paused is a 400',
              s == 400 and 'no longer a setting' in (r.get('error') or '') and 'Global Arm/Disarm' in (r.get('error') or ''), (s, r))
        s, r = req('POST', '/api/pause', {})
        check('21h POST /api/pause is a 404', s == 404, (s, r))
        s, r = req('POST', '/api/resume', {})
        check('21h POST /api/resume is a 404', s == 404, (s, r))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 210801), 'label': 'V21h ck 25d',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        txv21h = r['tx']['id'] if s == 201 else None
        check('21h setup: the 25d check-in tx added', s == 201, r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txv21h, {'enabled': False})
        check('21h disarming the tx (so it carries an open inactive period)', s == 200, r)
        s, bak = req('GET', '/api/backup')
        bak_tx = [t for t in bak.get('state', {}).get('bitcoin', {}).get('txs', []) if t.get('id') == txv21h]
        check('21h the backup carries the freeze fields on the tx',
              s == 200 and len(bak_tx) == 1 and bak_tx[0].get('checkinOffsetMs') == 0
              and bak_tx[0].get('checkinInactiveSince') is not None, bak_tx)
        check('21h the backup carries no paused setting',
              'paused' not in bak.get('state', {}).get('settings', {}), bak.get('state', {}).get('settings'))
        bak_paused = copy.deepcopy(bak)
        bak_paused['state']['settings']['paused'] = True
        s, r = req('POST', '/api/restore', bak_paused)
        check('21h a backup carrying paused restores without error (200)', s == 200, r)
        s, st = req('GET', '/api/state')
        check('21h the restored settings carry no paused key',
              'paused' not in st.get('settings', {}), st.get('settings'))
        rt = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txv21h]
        check('21h the restored tx keeps the freeze fields (offset reset to the new clock, still inactive)',
              len(rt) == 1 and rt[0].get('checkinOffsetMs') == 0 and rt[0].get('checkinInactiveSince') is not None
              and rt[0].get('enabled') is False, rt)
        bak_old = copy.deepcopy(bak)
        for t in bak_old['state']['bitcoin']['txs']:
            t.pop('checkinOffsetMs', None)
            t.pop('checkinInactiveSince', None)
            # Arm the tx in this copy: a disarmed tx is re-marked
            # inactive on restore (restore counts as a check-in),
            # so the 0 / null defaults are only observable on an
            # armed tx.
            t['enabled'] = True
        bak_old['state']['settings']['paused'] = True
        s, r = req('POST', '/api/restore', bak_old)
        check('21h a pre-redesign backup (no freeze fields, paused set) restores (200)', s == 200, r)
        s, st = req('GET', '/api/state')
        rt = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txv21h]
        check('21h the pre-redesign backup gets the freeze defaults (0 / null) and no paused key',
              len(rt) == 1 and rt[0].get('checkinOffsetMs') == 0 and rt[0].get('checkinInactiveSince') is None
              and rt[0].get('enabled') is True and 'paused' not in st.get('settings', {}), (rt, st.get('settings')))
        # Cleanup: no txs, vacation off, clock fresh.
        s, r = req('PUT', '/api/settings', {'vacationMode': False, 'vacationUntil': None})
        check('21 cleanup: vacation off', s == 200, (s, r))
        delete_all_txs()
        set_clock(0, 0)
    finally:
        for p in list(v.procs):
            stop(p)

    # --- 17. no server left running -------------------------------------
    for port in (PORT, RECEIVER_PORT, STUB_P, STUB_S):
        check('17 no server left running on port %d' % port, port_closed(port))

    print()
    print('FAILURES: %d %s' % (len(v.failures), v.failures if v.failures else '(none)'))
    return 1 if v.failures else 0


if __name__ == '__main__':
    sys.exit(main())
