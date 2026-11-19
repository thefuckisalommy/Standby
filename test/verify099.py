#!/usr/bin/env python3
"""Standby 0.8.4 local verification: block-height, set-date, and
fee-market triggers.

Boots the branch-0.8.4 app (port 3438), the check-in receiver
(3439), and two mempool stubs — primary 18235 and secondary 18236
(both fixed: tip height 900000, economy fee 1 sat/vB, price 98200)
— and checks the 0.8.1 trigger work:

  1. health reports version 0.8.4.
  2. Block-height trigger: validation at add (bad heights rejected,
     good ones accepted), checkTriggerNow (a height already reached
     fires + warns, a future height watches), evaluation via the
     manual release check (an already-reached height broadcasts, a
     future one does not), and the full tick (an armed block-height
     tx fires on the full tick).
  2c. Block-height reorg latch (0.8.1, audit 1): once the chain has
     been observed at the target, a later reorg below the target
     must not un-fire the rule.
  3. Set-date trigger: validation (bad dates rejected), checkTriggerNow
     (a past date fires + warns, a future date watches), evaluation
     (a past date broadcasts, a future one does not), and the full
     tick (an armed set-date tx fires on the full tick).
  4. Fee-market trigger: validation (bad rates rejected), checkTriggerNow
     (economy 1 sat/vB: a threshold at/above 1 fires + warns, below 1
     watches), evaluation (a threshold at/above the economy fee
     broadcasts, below does not), and the full tick.
  5. The already-satisfied guard at add/edit: a rule whose condition
     is already met is blocked unless triggerConfirmed is set — for
     all three new types, mirroring price/UTXO.
  6. Grace does NOT hold the new types: an active grace period pauses
     price/UTXO only — a set-date (and block-height / fee-market) tx
     still fires during it.
  7. Vacation does NOT freeze the new types: vacation is check-in-only
     — a set-date tx still fires while vacation mode is on.
  8. Existing triggers still work (smoke): check-in, price, UTXO,
     and manual txs are accepted and evaluate as before.
  9. Restore carries the new triggers: a backup holding one tx of
     each new type restores with the triggers intact.
  12. Custom price source: a Custom entry ({url, path}) fetches a
      price from any JSON endpoint via a dot-path (with [n]
      indices); it decides as primary, falls back as secondary,
      validates like a built-in, and survives restore.
  13. UTXO 404 failover (0.8.1, audit 2): a 404 from the primary is
      inconclusive — the secondary is asked, and only when every
      endpoint 404s does the answer stay unknown.
  14. Concurrent API writes (0.8.1, audit 4): ten adds fired at
      once must all survive — no lost update from a stale save.
  15. Per-tx history (0.8.2): add logs 'added' with the rule's
      condition; a release logs 'fired' once then 'broadcast'; a
      confirmation refresh logs 'confirmed'; an edit logs 'edited'
      and an arm/disarm flip logs 'armed'/'disarmed'; a restore of
      a backup with no history seeds a bare 'added' event.
  16. Gate/evaluator agreement (0.8.2, step 1): the gate answers
      the RAW condition — no grace, no vacation — so it still
      reports fire while the evaluator holds the rule; the
      release check does not broadcast until the hold lifts.
  17. Multi-trigger rule sets (0.8.2): OR fires on any rule; AND
      fires only when every rule holds on the same tick (no
      per-rule latching); an unknown rule blocks AND and is
      ignored by OR; grace holds only the price/UTXO rule in a
      set; an already-satisfied set blocks the add with the
      combined semantics; a stored single trigger migrates to a
      one-rule OR set with per-rule state; per-rule triggerState
      survives a restart.
  18. Full-evaluation tick + broadcast backoff (0.8.2): one tick
      evaluates every rule type together, so an AND set spanning
      tick domains (check-in AND price) fires on the tick; a due
      tx whose broadcast fails is not re-attempted by the tick
      within the hour (stub attempt counts prove it); a manual
      broadcast bypasses the backoff; the retry succeeds once
      the hour has passed (lastAttemptAt backdated in state).
  19. Live rule status for never-evaluated / disarmed txs (0.8.2;
      0.8.4): ruleStatusFor reads warm in-memory data for price,
      fee and set-date, so a tx that was never evaluated (added
      then disarmed before any tick) still shows Met / Not met
      instead of Unknown. (0.8.4) The tick now evaluates every tx,
      so a disarmed tx also gets a fresh slice within one cadence
      — block-height and UTXO read live from the slice, and the
      fee branch trusts the last known fee like price (no age
      check), so the fee pill stays live past one cadence. A
      manual release check evaluates all txs on demand and writes
      fresh slices.
  20. Persistence hardening (0.8.3): every save keeps the previous
      version as state.json.bak; the first save of a day snapshots
      it (7 days kept); a migration snapshots the pre-migration
      file. A corrupt state.json recovers from the newest usable
      backup, preserves the corrupt file, and warns — and with no
      usable backup it fails loudly instead of silently resetting.
      Startup key-store check: state keys + missing receiver file
      -> rewritten from state; state empty + receiver keys ->
      warning, receiver untouched; state empty + backup keys ->
      warning naming the backup. Key create/revoke write log
      lines.
  21. Crash recovery, receiver auth, untested endpoints (0.8.3,
      tests-in-repo): a tx that broadcast and then lost its record
      in a crash is never called stale once its trigger stops
      holding — the dry run's 'own' anchor heals it to broadcast;
      the check-in receiver accepts a valid key (Bearer or
      X-Api-Key), rejects unknown/missing/revoked keys with 401,
      and writes last.json; GET /api/checkins and
      GET /api/broadcast/log return their entries; POST
      /api/bitcoin/txs/preview validates hex/psbt; a non-JSON
      POST is rejected 403 by the CSRF gate.
  22. Evaluate all, broadcast armed only (0.8.4): the tick
      evaluates every tx — armed or not — and writes fresh
      slices, but only armed txs can enter the firing set. A
      disarmed tx whose conditions all hold shows Met, is never
      broadcast (stub attempt counts prove it), logs no 'fired'
      history, and is listed as skipped by a manual release
      check; re-arming it broadcasts on the next tick, with
      'fired' logged exactly once. A disarmed check-in tx's clock
      stays frozen while the tick evaluates it.

Ports: app 3438, receiver 3439, stubs 18235/18236 — no collision
with the 095 suite (app 3388, receiver 3389, stubs 18175/18176) or
the 096 suite (app 3398, receiver 3399, stubs 18185/18186).
Reuses the 094 helpers (import verify094 — importing does not run
main()) and never touches the 095 files or the main app/ copy.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify094 as v

check = v.check


def req(method, path, body=None, base=None, timeout=20, headers=None):
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

GOAL = v.GOAL
APP = v.app_dir(GOAL)
DATA = '/tmp/heirloom099'
CHECKIN_DIR = '/tmp/heirloom099-checkin'
PORT = 3438
BASE = 'http://127.0.0.1:%d' % PORT
RECEIVER_PORT = 3439
RBASE = 'http://127.0.0.1:%d' % RECEIVER_PORT
STUB_P = 18235
STUB_S = 18236
STUB_BASE_P = 'http://127.0.0.1:%d' % STUB_P
STUB_BASE_S = 'http://127.0.0.1:%d' % STUB_S
APP_ENV = {'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR,
           'SLIPSTREAM_API_URL': STUB_BASE_P, 'FEE_RATES_URL': STUB_BASE_P,
           'PRICE_API_URL': STUB_BASE_P}
LOG = '/tmp/heirloom099-proc.log'

# The stub's fixed values: tip height 900000, economy fee 1 sat/vB.
STUB_TIP = 900000
STUB_ECONOMY_FEE = 1


def iso_ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat().replace('+00:00', 'Z')


def iso_in(**kw):
    return (datetime.now(timezone.utc) + timedelta(**kw)).isoformat().replace('+00:00', 'Z')


def load_state_file():
    return json.load(open(os.path.join(DATA, 'state.json')))


def save_state_file(stj):
    json.dump(stj, open(os.path.join(DATA, 'state.json'), 'w'), indent=2)


def state_tx(tx_id, base=BASE):
    s, st = req('GET', '/api/state', base=base)
    for t in st.get('bitcoin', {}).get('txs', []):
        if t.get('id') == tx_id:
            return t
    return None


def rule_slice(t, i=0):
    """One rule's triggerState slice from a state_tx() tx: the API
    serves a one-rule set's state as its single flat slice (a dict)
    and a multi-rule set's as an array (serveTriggerState)."""
    ts = (t or {}).get('triggerState')
    if isinstance(ts, list):
        return ts[i] if i < len(ts) else {}
    return ts if isinstance(ts, dict) else {}


def delete_all_txs(base=BASE):
    s, st = req('GET', '/api/state', base=base)
    for t in st.get('bitcoin', {}).get('txs', []):
        req('DELETE', '/api/bitcoin/txs/' + t['id'], base=base)


def release_results(base=BASE):
    s, r = req('POST', '/api/release/check', {}, base=base)
    return s, r, {x.get('id'): x for x in r.get('results', [])}


def port_closed(port):
    try:
        import socket
        s = socket.create_connection(('127.0.0.1', port), timeout=1)
        s.close()
        return False
    except OSError:
        return True


def add_tx(label, trigger, value, trigger_confirmed=False):
    body = {'txHex': craft(1, value), 'label': label, 'notes': '', 'trigger': trigger}
    if trigger_confirmed:
        body['triggerConfirmed'] = True
    return req('POST', '/api/bitcoin/txs', body)


def main():
    for d in (DATA, CHECKIN_DIR):
        shutil.rmtree(d, ignore_errors=True)
    app = None

    def restart():
        """Stop + start the app, wait up, then sleep past the 5 s
        startup release tick. Call BEFORE seeding any firing state."""
        nonlocal app
        if app is not None:
            stop(app)
        app = start(['node', 'server.js'], env=APP_ENV, cwd=APP, log=LOG)
        ok = wait_up(BASE)
        if ok:
            time.sleep(7)
        return ok

    def restart_stubs(own=None):
        """Restart both stubs, keeping their 099 env (conflict modes
        + stub price). `own` sets STUB_OWN_SPEND_TXID so the
        OWN_SPEND parent ('ee'*32) answers as spent by that txid —
        the dry-run / release 'own' anchor (the 094 finding-1
        pattern). Without it the stubs are pristine again."""
        nonlocal p_primary, p_secondary
        stop(p_primary); stop(p_secondary)
        e1 = {'SENTINEL_TXID': SENTINEL_TXID, 'STUB_CONFLICT_MODE': 'unconfirmed',
              'STUB_PRICE_USD': '98200'}
        e2 = {'SENTINEL_TXID': SENTINEL_TXID, 'STUB_CONFLICT_MODE': 'confirmed',
              'STUB_PRICE_USD': '98200'}
        if own:
            e1['STUB_OWN_SPEND_TXID'] = own
            e2['STUB_OWN_SPEND_TXID'] = own
        p_primary = start(['node', STUB, str(STUB_P)], env=e1, log=LOG)
        p_secondary = start(['node', STUB, str(STUB_S)], env=e2, log=LOG)
        time.sleep(0.5)

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
                           env={'PORT': str(RECEIVER_PORT), 'CHECKIN_DIR': CHECKIN_DIR},
                           cwd=APP, log=LOG)
        time.sleep(0.8)
        s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_P)
        check('stubs up: primary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
        s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_S)
        check('stubs up: secondary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
        check('app up', restart())
        check('receiver up', wait_up(RBASE, path='/health'))
        # Point the node endpoints at the stubs (like verify095):
        # getTipHeight and the outspend checks must read the stub's
        # fixed tip (900000), not the live chain.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S})
        check('0 node endpoints point at the stubs',
              s == 200 and r.get('primaryApiUrl') == STUB_BASE_P and r.get('secondaryApiUrl') == STUB_BASE_S, r)

        # --- 1. health + version ----------------------------------------
        s, h = req('GET', '/api/health')
        check('1 health reports version 0.8.4', h.get('version') == '0.8.4', h)

        # --- 2. block-height trigger --------------------------------------
        # Validation at add: bad heights rejected, good ones accepted.
        bad_heights = [
            ({'type': 'blockheight', 'params': {}}, 'missing targetHeight'),
            ({'type': 'blockheight', 'params': {'targetHeight': 0}}, 'zero'),
            ({'type': 'blockheight', 'params': {'targetHeight': -5}}, 'negative'),
            ({'type': 'blockheight', 'params': {'targetHeight': 1.5}}, 'non-integer'),
            ({'type': 'blockheight', 'params': {'targetHeight': '900000'}}, 'string'),
            ({'type': 'blockheight', 'params': {'targetHeight': 10000001}}, 'over max'),
        ]
        for i, (trig, label) in enumerate(bad_heights):
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110000 + i * 2), 'label': 'bad bh ' + label, 'trigger': trig})
            check('2 blockheight validation rejects %s (400)' % label, s == 400, (s, r))
        s, r = add_tx('BH future', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 110100)
        check('2 blockheight add: future height accepted (201)', s == 201, (s, r))
        bh_future = r['tx']['id'] if s == 201 else None
        # checkTriggerNow: future height watches, past height fires + warns.
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}})
        check('2 blockheight check: future height watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
        check('2 blockheight check: past height fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
        # The add-time guard: an already-reached height is blocked
        # unless triggerConfirmed is set.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110102), 'label': 'BH past no confirm', 'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
        check('2 blockheight add: past height blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
        s, r = add_tx('BH past', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 110104, trigger_confirmed=True)
        check('2 blockheight add: past height accepted with triggerConfirmed (201)', s == 201, (s, r))
        bh_past = r['tx']['id'] if s == 201 else None
        # Evaluation via the manual release check: the past height
        # broadcasts, the future one does not.
        s, r, res = release_results()
        check('2 blockheight release: past height broadcasts', s == 200 and res.get(bh_past, {}).get('action') == 'broadcast', res.get(bh_past))
        check('2 blockheight release: future height does not broadcast', res.get(bh_future, {}).get('action') != 'broadcast', res.get(bh_future))
        # The future tx's triggerStatus shows watching with the tip.
        t = state_tx(bh_future)
        check('2 blockheight status: future tx is watching with the tip height',
              t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastTipHeight') == STUB_TIP, t.get('triggerStatus') if t else None)
        delete_all_txs()

        # --- 2c. block-height: the reorg latch (0.8.1, audit 1) --------
        # Once the chain has been observed at the target, the rule has
        # fired — a later reorg below the target must not un-fire it.
        # The past-height tx broadcasts (latch set), the primary tip
        # then drops below the target, and the rule must still fire.
        s, r = add_tx('BH latch', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 110108, trigger_confirmed=True)
        check('2c latch add: past height accepted with triggerConfirmed (201)', s == 201, (s, r))
        bh_latch = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('2c latch release: past height broadcasts (latch set)', s == 200 and res.get(bh_latch, {}).get('action') == 'broadcast', res.get(bh_latch))
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
        check('2c primary stub tip dropped to 700000', s == 200 and r.get('height') == STUB_TIP - 200000, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 'txId': bh_latch})
        check('2c latch check: reorged tip still fires with the tx latch', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        s, r, res = release_results()
        t = state_tx(bh_latch)
        check('2c latch status: reorged tip still shows due', t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        check('2c primary stub tip restored to 900000', s == 200 and r.get('height') == STUB_TIP, r)
        delete_all_txs()

        # --- 2b. block-height: the PRIMARY node's tip decides ----------
        # Secondary stub runs 1000 blocks ahead of the primary: a target
        # between the two must WATCH (the primary has not reached it) —
        # the secondary's higher tip no longer fires the rule. The
        # add-time gate uses the same rule.
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP + 1000}, base=STUB_BASE_S)
        check('2b secondary stub tip set to 901000', s == 200 and r.get('height') == STUB_TIP + 1000, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
        check('2b check: target between the two tips watches (primary has not reached it)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100}}})
        check('2b check: target below the primary tip fires', s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110106), 'label': 'BH primary no confirm', 'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
        check('2b add: target above the primary tip accepted without triggerConfirmed (201)', s == 201, (s, r))
        bh_primary = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('2b release: target above the primary tip does not broadcast', res.get(bh_primary, {}).get('action') != 'broadcast', res.get(bh_primary))
        # One node down: the other alone still decides. Primary down,
        # secondary alone at 901000: the between target now fires.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
        check('2b primary pointed at a closed port', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
        check('2b check: primary down, secondary past target fires', s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 2000}}})
        check('2b check: primary down, target above the secondary watches', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P})
        check('2b primary restored to the stub', s == 200, (s, r))
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
        check('2b secondary stub tip restored to 900000', s == 200 and r.get('height') == STUB_TIP, r)
        delete_all_txs()

        # --- 3. set-date trigger ------------------------------------------
        bad_dates = [
            ({'type': 'setdate', 'params': {}}, 'missing fireAt'),
            ({'type': 'setdate', 'params': {'fireAt': 'not a date'}}, 'invalid date'),
            ({'type': 'setdate', 'params': {'fireAt': 12345}}, 'non-string'),
        ]
        for i, (trig, label) in enumerate(bad_dates):
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110200 + i * 2), 'label': 'bad sd ' + label, 'trigger': trig})
            check('3 setdate validation rejects %s (400)' % label, s == 400, (s, r))
        future_date = iso_in(days=30)
        s, r = add_tx('SD future', {'type': 'setdate', 'params': {'fireAt': future_date}}, 110300)
        check('3 setdate add: future date accepted (201)', s == 201, (s, r))
        sd_future = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'setdate', 'params': {'fireAt': future_date}}})
        check('3 setdate check: future date watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        past_date = iso_ago(days=1)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'setdate', 'params': {'fireAt': past_date}}})
        check('3 setdate check: past date fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110302), 'label': 'SD past no confirm', 'trigger': {'type': 'setdate', 'params': {'fireAt': past_date}}})
        check('3 setdate add: past date blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
        s, r = add_tx('SD past', {'type': 'setdate', 'params': {'fireAt': past_date}}, 110304, trigger_confirmed=True)
        check('3 setdate add: past date accepted with triggerConfirmed (201)', s == 201, (s, r))
        sd_past = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('3 setdate release: past date broadcasts', s == 200 and res.get(sd_past, {}).get('action') == 'broadcast', res.get(sd_past))
        check('3 setdate release: future date does not broadcast', res.get(sd_future, {}).get('action') != 'broadcast', res.get(sd_future))
        t = state_tx(sd_future)
        check('3 setdate status: future tx is watching',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        delete_all_txs()

        # --- 4. fee-market trigger ----------------------------------------
        # The stub's economy fee is 1 sat/vB: a threshold >= 1 fires,
        # below 1 watches.
        bad_rates = [
            ({'type': 'feemarket', 'params': {}}, 'missing maxFeeRate'),
            ({'type': 'feemarket', 'params': {'maxFeeRate': 0}}, 'zero'),
            ({'type': 'feemarket', 'params': {'maxFeeRate': -1}}, 'negative'),
            ({'type': 'feemarket', 'params': {'maxFeeRate': '5'}}, 'string'),
            ({'type': 'feemarket', 'params': {'maxFeeRate': 10001}}, 'over max'),
        ]
        for i, (trig, label) in enumerate(bad_rates):
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110400 + i * 2), 'label': 'bad fm ' + label, 'trigger': trig})
            check('4 feemarket validation rejects %s (400)' % label, s == 400, (s, r))
        s, r = add_tx('FM low', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 110500)
        check('4 feemarket add: threshold below the economy fee accepted (201)', s == 201, (s, r))
        fm_low = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}})
        check('4 feemarket check: below the economy fee watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
        check('4 feemarket check: at/above the economy fee fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110502), 'label': 'FM high no confirm', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
        check('4 feemarket add: threshold at/above the fee blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
        s, r = add_tx('FM high', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110504, trigger_confirmed=True)
        check('4 feemarket add: threshold at/above the fee accepted with triggerConfirmed (201)', s == 201, (s, r))
        fm_high = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('4 feemarket release: threshold at/above the fee broadcasts', s == 200 and res.get(fm_high, {}).get('action') == 'broadcast', res.get(fm_high))
        check('4 feemarket release: threshold below the fee does not broadcast', res.get(fm_low, {}).get('action') != 'broadcast', res.get(fm_low))
        t = state_tx(fm_low)
        check('4 feemarket status: low-threshold tx is watching with the economy fee',
              t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerStatus') if t else None)

        # --- 4b. fee-market direction -------------------------------------
        # 'above' fires when the economy fee rises to or above the
        # threshold (stub economy fee is 1 sat/vB): threshold 0.5
        # fires, threshold 5 watches. A rule with no direction
        # defaults to 'below', and a bad direction is rejected.
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}})
        check('4b feemarket above: threshold below the fee fires (fire=true)', s == 200 and r.get('fire') is True and r.get('warning'), r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'above'}}})
        check('4b feemarket above: threshold above the fee watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110506), 'label': 'FM above no confirm', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}})
        check('4b feemarket above: already-satisfied add blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r) and 'at or above' in str(r), (s, r))
        s, r = add_tx('FM above', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}, 110508, trigger_confirmed=True)
        check('4b feemarket above: already-satisfied add accepted with triggerConfirmed (201)', s == 201, (s, r))
        fm_above = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110510), 'label': 'bad fm dir', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'sideways'}}})
        check('4b feemarket validation rejects a bad direction (400)', s == 400, (s, r))
        s, r, res = release_results()
        check('4b feemarket above: threshold below the fee broadcasts', s == 200 and res.get(fm_above, {}).get('action') == 'broadcast', res.get(fm_above))
        t = state_tx(fm_above)
        check('4b feemarket above: stored params carry direction above',
              t and t.get('trigger', {}).get('params', {}).get('direction') == 'above', t.get('trigger') if t else None)
        t = state_tx(fm_low)
        check('4b feemarket default: a rule added without direction reads as below',
              t and t.get('trigger', {}).get('params', {}).get('direction') == 'below', t.get('trigger') if t else None)
        delete_all_txs()

        # --- 4c. fee-market trigger: two-node logic, primary decides ---
        # The two stubs are the two nodes. Drive their fees apart
        # via POST /__test__/fees, and set the cadence to 10 s so
        # the node fee cache (TTL = cadence) refreshes within ~11 s
        # of each fee change. There is NO agreement check: the
        # primary node's fee is the one that counts — the secondary
        # is only a fallback if the primary is down.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('4c two-node fees: cadence set to 10 s', s == 200, (s, r))
        # Dual, close: primary 5, secondary 4.5. BOTH directions
        # use the primary (5) — the secondary's lower reading does
        # not fire a 'below' rule and does not hold back an 'above'.
        s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_P)
        check('4c two-node fees: primary stub fee set to 5', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 4.5}, base=STUB_BASE_S)
        check('4c two-node fees: secondary stub fee set to 4.5', s == 200, (s, r))
        time.sleep(11)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.7, 'direction': 'below'}}})
        check("4c two-node fees: 'below' 4.7 watches — the primary (5) has not crossed", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.8, 'direction': 'above'}}})
        check("4c two-node fees: 'above' 4.8 fires on the primary reading (5)", s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5.1, 'direction': 'below'}}})
        check("4c two-node fees: 'below' 5.1 fires on the primary reading (5)", s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5.1, 'direction': 'above'}}})
        check("4c two-node fees: 'above' 5.1 watches — the primary (5) has not crossed", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        # Far apart, no agreement check: primary 10 vs secondary
        # 4.5 — the primary still decides. 'below' 5 watches (the
        # secondary's 4.5 does not fire it); 'above' 9 fires (10).
        s, r = req('POST', '/__test__/fees', {'economyFee': 10}, base=STUB_BASE_P)
        time.sleep(11)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
        check("4c two-node fees: far apart, 'below' 5 watches on the primary (10)", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 9, 'direction': 'above'}}})
        check("4c two-node fees: far apart, 'above' 9 fires on the primary (10)", s == 200 and r.get('fire') is True, r)
        # One node down: point the PRIMARY at a closed port — the
        # secondary alone is used, with no agreement check. (The
        # changed URL busts the fee cache, so no sleep is needed.)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.7, 'direction': 'below'}}})
        check('4c two-node fees: primary down, secondary alone decides (4.5 <= 4.7 fires)', s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.8, 'direction': 'above'}}})
        check('4c two-node fees: primary down, secondary alone decides (4.5 < 4.8 watches)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        # Restore: primary back to the stub, both fees back to 1,
        # cadence back to 60.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'checkCadenceSeconds': 60})
        check('4c two-node fees: primary and cadence restored', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
        check('4c two-node fees: stubs restored to fee 1', s == 200, (s, r))

        # --- 5. the full tick fires the new types ------------------------
        # Set the cadence to 10 s, restart (fresh tick clock), wait
        # past the startup tick, then arm one already-satisfied tx of
        # each new type. A broadcast within ~15 s proves the full
        # tick picks them up.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('5 full tick: cadence set to 10 s', s == 200, (s, r))
        check('5 full tick: app restarted', restart())
        s, r = add_tx('FT blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 1000}}, 110600, trigger_confirmed=True)
        ft_bh = r['tx']['id'] if s == 201 else None
        s, r = add_tx('FT setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110602, trigger_confirmed=True)
        ft_sd = r['tx']['id'] if s == 201 else None
        s, r = add_tx('FT feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110604, trigger_confirmed=True)
        ft_fm = r['tx']['id'] if s == 201 else None
        check('5 full tick: three already-satisfied txs added', ft_bh and ft_sd and ft_fm, (ft_bh, ft_sd, ft_fm))
        time.sleep(16)
        s, st = req('GET', '/api/state')
        by_id = {t['id']: t for t in st.get('bitcoin', {}).get('txs', [])}
        check('5 full tick: block-height tx broadcast by the full tick',
              (by_id.get(ft_bh, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_bh, {}).get('release'))
        check('5 full tick: set-date tx broadcast by the full tick',
              (by_id.get(ft_sd, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_sd, {}).get('release'))
        check('5 full tick: fee-market tx broadcast by the full tick',
              (by_id.get(ft_fm, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_fm, {}).get('release'))
        # Restore the default cadence for the remaining sections.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('5 full tick: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()

        # --- 6. grace does NOT hold the new types -------------------------
        # Put the app into an active grace (offline 10 days, duration
        # 7 days): price/UTXO would be held, but a set-date tx must
        # still fire on the manual release check.
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
        save_state_file(stj)
        check('6 grace: app restarted with an active grace', restart())
        s, st = req('GET', '/api/state')
        check('6 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r = add_tx('G setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110700, trigger_confirmed=True)
        g_sd = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('6 grace: set-date tx still broadcasts during an active grace',
              s == 200 and res.get(g_sd, {}).get('action') == 'broadcast', res.get(g_sd))
        # Clear the grace for the remaining sections.
        s, r = req('POST', '/api/grace/resume', {})
        check('6 grace: resumed', s == 200, (s, r))
        delete_all_txs()

        # --- 7. vacation does NOT freeze the new types --------------------
        # Vacation is check-in-only: a set-date tx must still fire
        # while vacation mode is on.
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
        check('7 vacation: vacation mode on', s == 200, (s, r))
        s, r = add_tx('V setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110800, trigger_confirmed=True)
        v_sd = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('7 vacation: set-date tx still broadcasts during vacation',
              s == 200 and res.get(v_sd, {}).get('action') == 'broadcast', res.get(v_sd))
        s, r = req('PUT', '/api/settings', {'vacationMode': False, 'vacationUntil': None})
        check('7 vacation: vacation mode off', s == 200, (s, r))
        delete_all_txs()

        # --- 8. existing triggers still work (smoke) ---------------------
        s, r = add_tx('S checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110900)
        check('8 smoke: check-in tx accepted', s == 201, (s, r))
        s, r = add_tx('S price', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 110902)
        check('8 smoke: price tx accepted', s == 201, (s, r))
        s, r = add_tx('S utxo', {'type': 'utxo', 'params': {'outpoint': SECOND + ':1', 'condition': 'spent', 'confirmations': 1}}, 110904)
        check('8 smoke: utxo tx accepted', s == 201, (s, r))
        s, r = add_tx('S manual', {'type': 'manual', 'params': {}}, 110906)
        check('8 smoke: manual tx accepted', s == 201, (s, r))
        s, r, res = release_results()
        check('8 smoke: none of the four broadcasts (nothing due)',
              all(res.get(t, {}).get('action') != 'broadcast' for t in res), res)
        delete_all_txs()

        # --- 9. restore carries the new triggers -------------------------
        s, r = add_tx('R blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 111000)
        r_bh = r['tx']['id'] if s == 201 else None
        s, r = add_tx('R setdate', {'type': 'setdate', 'params': {'fireAt': iso_in(days=30)}}, 111002)
        r_sd = r['tx']['id'] if s == 201 else None
        s, r = add_tx('R feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 111004)
        r_fm = r['tx']['id'] if s == 201 else None
        s, bak = req('GET', '/api/backup')
        check('9 restore: backup fetched', s == 200, (s, r))
        delete_all_txs()
        s, st = req('GET', '/api/state')
        check('9 restore: txs deleted before restore', st.get('bitcoin', {}).get('txs') == [], st.get('bitcoin', {}).get('txs'))
        s, r = req('POST', '/api/restore', bak)
        check('9 restore: backup restores (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check('9 restore: block-height trigger survives',
              by_label.get('R blockheight', {}).get('trigger', {}).get('type') == 'blockheight'
              and by_label.get('R blockheight', {}).get('trigger', {}).get('params', {}).get('targetHeight') == STUB_TIP + 50000,
              by_label.get('R blockheight', {}).get('trigger'))
        check('9 restore: set-date trigger survives',
              by_label.get('R setdate', {}).get('trigger', {}).get('type') == 'setdate'
              and by_label.get('R setdate', {}).get('trigger', {}).get('params', {}).get('fireAt') is not None,
              by_label.get('R setdate', {}).get('trigger'))
        check('9 restore: fee-market trigger survives',
              by_label.get('R feemarket', {}).get('trigger', {}).get('type') == 'feemarket'
              and by_label.get('R feemarket', {}).get('trigger', {}).get('params', {}).get('maxFeeRate') == 0.5,
              by_label.get('R feemarket', {}).get('trigger'))
        # (0.8.1, audit: restored `broadcasted` records) A backup
        # carrying a fabricated broadcasted fact + a 'broadcast'
        # release record — txids matching the hex, so the old
        # validation passes — must NOT come back broadcast: both
        # claims are dropped and the tx restores active. A transient
        # 'failed' record rides along.
        bak2 = copy.deepcopy(bak)
        for tx2 in bak2['state']['bitcoin']['txs']:
            if tx2.get('label') == 'R blockheight':
                tx2['broadcasted'] = {'txid': tx2['txid'], 'broadcastedAt': '2026-11-18T00:00:00.000Z',
                                      'method': 'primary', 'confirmations': 3, 'blockHeight': 899999,
                                      'found': True, 'checkedAt': '2026-11-18T00:00:00.000Z'}
                tx2['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                                  'txid': tx2['txid'], 'method': 'primary',
                                  'broadcastedAt': '2026-11-18T00:00:00.000Z'}
            if tx2.get('label') == 'R setdate':
                tx2['release'] = {'status': 'failed', 'kind': 'release', 'trigger': 'setdate',
                                  'txid': tx2['txid'], 'method': 'primary',
                                  'lastAttemptAt': '2026-11-18T00:00:00.000Z', 'error': 'test failure'}
        delete_all_txs()
        s, r = req('POST', '/api/restore', bak2)
        check('9 restore: edited backup restores (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check('9 restore: fabricated broadcasted fact is dropped',
              by_label.get('R blockheight', {}).get('broadcasted') is None,
              by_label.get('R blockheight', {}).get('broadcasted'))
        check('9 restore: fabricated broadcast release record is dropped',
              by_label.get('R blockheight', {}).get('release') is None,
              by_label.get('R blockheight', {}).get('release'))
        check('9 restore: transient failed record rides along',
              (by_label.get('R setdate', {}).get('release') or {}).get('status') == 'failed',
              by_label.get('R setdate', {}).get('release'))
        delete_all_txs()

        # --- 10. node capability test (OK / CAUTION / FAIL) ------------
        # Both stubs are full mempool-style nodes: height, fees and
        # broadcast all answer, so both results are OK.
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        check('10 nodes: connection test returns 200', s == 200, (s, r))
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('10 nodes: primary is OK with all three checks ready',
              res.get('primary', {}).get('status') == 'ok'
              and res.get('primary', {}).get('checks', {}).get('height', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('fees', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('ok') is True,
              res.get('primary'))
        check('10 nodes: primary shows the measured values next to each status',
              res.get('primary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
              and res.get('primary', {}).get('checks', {}).get('fees', {}).get('value') == '1 sat/vB'
              and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'Reachable',
              res.get('primary', {}).get('checks'))
        check('10 nodes: secondary is OK too', res.get('secondary', {}).get('status') == 'ok', res.get('secondary'))
        check('10 nodes: overall ok is true', r.get('ok') is True, r.get('ok'))
        # A height-only server (answers /api/blocks/tip/height, 404s
        # everything else) is CAUTION: it IS a node, but fees and
        # broadcast are not ready.
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        class HeightOnly(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/api/blocks/tip/height':
                    self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
                    self.wfile.write(b'900000')
                else:
                    self.send_response(404); self.end_headers()
            def do_POST(self):
                self.send_response(404); self.end_headers()
            def log_message(self, *a):
                pass
        height_srv = HTTPServer(('127.0.0.1', 18190), HeightOnly)
        threading.Thread(target=height_srv.serve_forever, daemon=True).start()
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:18190'})
        check('10 nodes: secondary pointed at the height-only server', s == 200, (s, r))
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('10 nodes: height-only secondary is CAUTION',
              res.get('secondary', {}).get('status') == 'caution'
              and res.get('secondary', {}).get('checks', {}).get('height', {}).get('ok') is True
              and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('ok') is False
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False,
              res.get('secondary'))
        check('10 nodes: height-only secondary shows the height value and the failure reasons',
              res.get('secondary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
              and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('value') == 'no fee endpoint'
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'answered HTTP 404',
              res.get('secondary', {}).get('checks'))
        check('10 nodes: primary stays OK while secondary is CAUTION', res.get('primary', {}).get('status') == 'ok', res.get('primary'))
        check('10 nodes: overall ok stays true with a CAUTION node', r.get('ok') is True, r.get('ok'))
        # An Esplora-style server (height + /api/fee-estimates,
        # 404s the mempool fee endpoint and /api/tx) is CAUTION
        # with fees READY via the fallback — and the fee value is
        # the 6-block rate from the estimates.
        class EsploraStyle(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/api/blocks/tip/height':
                    self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
                    self.wfile.write(b'900000')
                elif self.path == '/api/fee-estimates':
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                    self.wfile.write(b'{"1": 2, "2": 2, "3": 1, "6": 1, "144": 1, "1008": 1}')
                else:
                    self.send_response(404); self.end_headers()
            def do_POST(self):
                self.send_response(404); self.end_headers()
            def log_message(self, *a):
                pass
        esplora_srv = HTTPServer(('127.0.0.1', 18191), EsploraStyle)
        threading.Thread(target=esplora_srv.serve_forever, daemon=True).start()
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:18191'})
        check('10 nodes: secondary pointed at the Esplora-style server', s == 200, (s, r))
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('10 nodes: Esplora-style secondary is CAUTION with fees ready via the fallback',
              res.get('secondary', {}).get('status') == 'caution'
              and res.get('secondary', {}).get('checks', {}).get('height', {}).get('ok') is True
              and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('ok') is True
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False,
              res.get('secondary'))
        check('10 nodes: Esplora-style fee value is the 6-block rate',
              res.get('secondary', {}).get('checks', {}).get('fees', {}).get('value') == '1 sat/vB',
              res.get('secondary', {}).get('checks', {}).get('fees'))
        esplora_srv.shutdown()
        esplora_srv.server_close()
        # A closed port is FAIL: unreachable.
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('10 nodes: unreachable secondary is FAIL',
              res.get('secondary', {}).get('status') == 'fail'
              and res.get('secondary', {}).get('ok') is False,
              res.get('secondary'))
        check('10 nodes: overall ok stays true with one good node', r.get('ok') is True, r.get('ok'))
        # Restore the stub secondary and stop the height-only server.
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S})
        check('10 nodes: secondary restored to the stub', s == 200, (s, r))
        height_srv.shutdown()
        height_srv.server_close()

        # --- 12. custom price source --------------------------------------
        # A Custom entry ({id, url, path}) fetches a price from any
        # JSON endpoint via a dot-path (with [n] indices). It decides
        # as primary, falls back as secondary, validates like a
        # built-in, and survives restore. The stub's CoinGecko route
        # answers {bitcoin: {usd}} — the custom URL points at it.
        CG_URL = STUB_BASE_P + '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
        KR_URL = STUB_BASE_P + '/0/public/Ticker?pair=XBTUSD'
        CB_URL = STUB_BASE_P + '/v2/prices/BTC-USD/spot'
        custom_cg = {'id': 'custom', 'url': CG_URL, 'path': 'bitcoin.usd'}
        # Stub prices back to the defaults both sources read.
        s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        check('12 stub prices reset to $98,200', s == 200, pr)
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': 'coinbase'}})
        check('12 custom primary (CoinGecko shape) saves (200)', s == 200, (s, r))
        check('12 restart before the custom eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('12 custom primary: price check fires on the custom reading ($98,200)',
              s == 200 and r.get('fire') is True, r)
        s, st = req('GET', '/api/state')
        check('12 custom primary: settings store the custom object',
              st.get('settings', {}).get('priceSources', {}).get('source1') == custom_cg,
              st.get('settings', {}).get('priceSources'))
        check('12 custom primary: currentPrices are slot-keyed, Custom reads $98,200',
              (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('provider') == 'custom'
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('label') == 'Custom'
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('price') == 98200
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('provider') == 'coinbase'
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('price') == 98200,
              st.get('bitcoin', {}).get('currentPrices'))
        check('12 custom primary: currentPrice is the primary (custom) price ($98,200)',
              st.get('bitcoin', {}).get('currentPrice') == 98200, st.get('bitcoin', {}).get('currentPrice'))
        check('12 custom primary: Exchange Status is ok with a Custom row',
              (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'ok'
              and [x.get('label') for x in (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('sources', [])] == ['Custom', 'Coinbase'],
              st.get('bitcoin', {}).get('exchangeStatus'))
        # Custom-primary decides: CoinGecko stub $100,000, Coinbase
        # $98,200 (1.8% apart — they agree). '>=' $99,000 fires on
        # the custom $100,000; '<=' $99,000 watches (Coinbase's
        # $98,200 must not fire it).
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 100000}, base=STUB_BASE_P)
        check('12 CoinGecko stub set to $100,000', s == 200 and pr.get('coingecko', {}).get('usd') == 100000, pr)
        check('12 restart before the straddle eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        check('12 custom decides: >= $99,000 fires on the custom $100,000',
              s == 200 and r.get('fire') is True and 'Custom' in str(r.get('reason', '')), r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '<=', 'value': 99000}}})
        check('12 custom decides: <= $99,000 watches (Coinbase $98,200 does not decide)',
              s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        # Disagree: CoinGecko $90,000 vs Coinbase $98,200 (8.7% apart).
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 90000}, base=STUB_BASE_P)
        check('12 CoinGecko stub set to $90,000', s == 200 and pr.get('coingecko', {}).get('usd') == 90000, pr)
        check('12 restart before the disagree eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('12 custom disagree: 8.7% apart is unknown, never fires',
              s == 200 and r.get('fire') is False and r.get('status') == 'unknown', r)
        # A path that matches nothing: the custom source is down and
        # Coinbase alone decides (single mode).
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 98200}, base=STUB_BASE_P)
        check('12 CoinGecko stub back to $98,200', s == 200, pr)
        bad_path = {'id': 'custom', 'url': CG_URL, 'path': 'nope.missing'}
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': bad_path, 'source2': 'coinbase'}})
        check('12 a well-formed but unmatched path still saves (200)', s == 200, (s, r))
        check('12 restart before the single-source eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 98000}}})
        check('12 unmatched path: the custom source is down, Coinbase alone fires',
              s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        s, st = req('GET', '/api/state')
        check('12 unmatched path: the custom reading is null with an error, Exchange Status degraded',
              (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('price') is None
              and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('error')
              and (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'degraded',
              (st.get('bitcoin', {}).get('currentPrices'), st.get('bitcoin', {}).get('exchangeStatus')))
        # Bracket indices + string numbers: the Kraken shape
        # (result.XXBTZUSD.c[0], a string) and the Coinbase shape
        # (data.amount, a string) both read through the walker.
        custom_kr = {'id': 'custom', 'url': KR_URL, 'path': 'result.XXBTZUSD.c[0]'}
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_kr, 'source2': 'coinbase'}})
        check('12 Kraken-shaped custom saves (200)', s == 200, (s, r))
        check('12 restart before the Kraken-shape eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('12 Kraken shape: result.XXBTZUSD.c[0] reads $98,200',
              s == 200 and r.get('fire') is True, r)
        custom_cb = {'id': 'custom', 'url': CB_URL, 'path': 'data.amount'}
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cb, 'source2': 'coinbase'}})
        check('12 Coinbase-shaped custom saves (200)', s == 200, (s, r))
        check('12 restart before the Coinbase-shape eval (empty cache)', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('12 Coinbase shape: data.amount reads $98,200 (string coerced)',
              s == 200 and r.get('fire') is True, r)
        # Validation: bad URLs, bad paths, and identical sources
        # are 400s; two customs that differ only by path are fine.
        bad_customs = [
            ({'id': 'custom', 'url': 'ftp://example.com/p', 'path': 'data.amount'}, 'ftp URL'),
            ({'id': 'custom', 'url': 'not a url', 'path': 'data.amount'}, 'unparseable URL'),
            ({'id': 'custom', 'url': CG_URL, 'path': ''}, 'empty path'),
            ({'id': 'custom', 'url': CG_URL, 'path': 'a..b'}, 'doubled dot'),
            ({'id': 'custom', 'url': CG_URL, 'path': 'x['}, 'unclosed bracket'),
            ({'id': 'custom', 'url': CG_URL}, 'missing path'),
            ({'id': 'custom', 'path': 'data.amount'}, 'missing url'),
        ]
        for bad, label in bad_customs:
            s, r = req('PUT', '/api/settings', {'priceSources': {'source1': bad, 'source2': 'coinbase'}})
            check('12 validation rejects custom with %s (400)' % label, s == 400, (s, r))
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': custom_cg}})
        check('12 validation rejects two identical customs (400)', s == 400, (s, r))
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': {'id': 'custom', 'url': CG_URL, 'path': 'bitcoin.usd.x'}}})
        check('12 two customs differing only by path are accepted (200)', s == 200, (s, r))
        # test-all takes a custom descriptor and answers it.
        s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': [custom_cg, 'coinbase']})
        check('12 test-all: custom + Coinbase both answer $98,200',
              s == 200 and len(r.get('results', [])) == 2
              and r['results'][0].get('provider') == 'custom' and r['results'][0].get('label') == 'Custom'
              and r['results'][0].get('price') == 98200 and r['results'][1].get('price') == 98200, r)
        # Restore carries the custom source.
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': 'coinbase'}})
        check('12 custom restored as the configured sources (200)', s == 200, (s, r))
        s, bak = req('GET', '/api/backup')
        check('12 restore: backup fetched', s == 200, (s, bak))
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'coingecko', 'source2': 'coinbase'}})
        check('12 restore: sources reset to defaults first', s == 200, (s, r))
        s, r = req('POST', '/api/restore', bak)
        check('12 restore: backup restores (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('12 restore: the custom source survives',
              st.get('settings', {}).get('priceSources', {}).get('source1') == custom_cg,
              st.get('settings', {}).get('priceSources'))
        # Back to the defaults so later sections (and the next run)
        # see CoinGecko + Coinbase at $98,200.
        s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'coingecko', 'source2': 'coinbase'}})
        check('12 defaults restored (CoinGecko + Coinbase)', s == 200, (s, r))

        # --- 13. UTXO 404 failover (0.8.1, audit 2) ----------------------
        # A 404 from the primary is inconclusive, not an answer: the
        # secondary is asked. FINNEY:0 is a confirmed spend (block
        # 899990) — the primary 404s the parent, the secondary answers
        # it, so the rule must fire. With both 404ing it must stay
        # unknown, never fire.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
        check('13 primary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
        check('13 404 failover: primary 404s, secondary knows the spend — fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        # The freshness path too: a dry-run of a tx spending FINNEY:0
        # must see the spend (stale), not an unknown input.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 113000), 'label': 'U404 dryrun', 'trigger': {'type': 'manual', 'params': {}}})
        check('13 404 dry-run tx added (201)', s == 201, (s, r))
        u404 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/broadcast/test', {'id': u404})
        one = (r.get('results') or [{}])[0]
        check('13 404 dry-run: spent input seen via the secondary', s == 200 and len(one.get('spent', [])) == 1, one)
        # Both 404: unknown, never fires.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
        check('13 secondary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
        check('13 both 404: unknown, never fires', s == 200 and r.get('fire') is False and r.get('status') == 'unknown', r)
        # Cleanup: both stubs know FINNEY again.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
        check('13 unknown-parent cleared on both stubs', s == 200, (s, r))
        delete_all_txs()

        # --- 14. concurrent API writes (0.8.1, audit 4) ------------------
        # Ten adds fired at once, each awaiting the fee lookup before
        # saving: every one must survive. Before the fix the last
        # save won and most adds were lost.
        conc_ids = []
        conc_errs = []

        def _add_one(i):
            try:
                s2, r2 = add_tx('Conc %d' % i, {'type': 'checkin', 'params': {'thresholdDays': 35}}, 114000 + i * 2)
                if s2 == 201 and r2.get('tx', {}).get('id'):
                    conc_ids.append(r2['tx']['id'])
                else:
                    conc_errs.append((i, s2, r2))
            except Exception as e:  # noqa
                conc_errs.append((i, 'exc', str(e)))

        threads = [threading.Thread(target=_add_one, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        s, st = req('GET', '/api/state')
        have = {t.get('id') for t in st.get('bitcoin', {}).get('txs', [])}
        check('14 concurrent adds: all 10 survive', len(conc_ids) == 10 and all(i in have for i in conc_ids) and not conc_errs, (conc_ids, conc_errs))
        delete_all_txs()

        # --- 15. per-tx history (0.8.2) ---------------------------------
        # Add -> one 'added' event naming the rule; a release that
        # fires the rule -> 'fired' then 'broadcast'; a confirmation
        # refresh -> 'confirmed' (Block 899,995, the stub's height
        # for a broadcast tx); an edit -> 'edited'; an arm/disarm
        # flip -> 'disarmed' / 'armed'. A restore of a backup whose
        # tx carries no history seeds a bare 'added' event.
        delete_all_txs()
        s, r = add_tx('H blockheight', {'type': 'blockheight', 'params': {'targetHeight': 800000}}, 115000, trigger_confirmed=True)
        check('15 add: accepted (201)', s == 201, (s, r))
        h_bh = r['tx']['id'] if s == 201 else None
        t = state_tx(h_bh)
        h = t.get('history') if t else None
        check('15 history: add logs one added event with the condition',
              isinstance(h, list) and len(h) == 1 and h[0].get('type') == 'added'
              and h[0].get('detail') == 'Fires when the chain reaches block 800,000', h)
        s, r, res = release_results()
        check('15 release: past height broadcasts', s == 200 and res.get(h_bh, {}).get('action') == 'broadcast', res.get(h_bh))
        t = state_tx(h_bh)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('15 history: fired then broadcast, fired once',
              types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
        check('15 history: fired detail names the tip reached',
              isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'block 900,000 reached',
              h[1] if isinstance(h, list) and len(h) >= 2 else h)
        txid = t.get('txid') if t else ''
        check('15 history: broadcast detail names the txid',
              isinstance(h, list) and len(h) >= 3 and h[2].get('detail') == 'txid ' + txid[:8] + '…' + txid[-4:],
              h[2] if isinstance(h, list) and len(h) >= 3 else h)
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('15 confirmations: refresh answers', s == 200, (s, r))
        t = state_tx(h_bh)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('15 history: confirmed appended once, Block 899,995',
              types == ['added', 'fired', 'broadcast', 'confirmed']
              and h[3].get('detail') == 'Block 899,995', h)
        s, r, res = release_results()
        t = state_tx(h_bh)
        h = t.get('history') if t else None
        check('15 history: a second release check adds no events',
              isinstance(h, list) and len(h) == 4, h)
        delete_all_txs()

        # Edit + arm/disarm on a fresh manual tx (never fired).
        s, r = add_tx('H manual', {'type': 'manual', 'params': {}}, 115002)
        check('15 add: manual tx accepted (201)', s == 201, (s, r))
        h_m = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'label': 'H manual renamed'})
        check('15 edit: label change saves (200)', s == 200, (s, r))
        s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'enabled': False})
        check('15 edit: disarm saves (200)', s == 200, (s, r))
        s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'enabled': True})
        check('15 edit: re-arm saves (200)', s == 200, (s, r))
        t = state_tx(h_m)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('15 history: edited, disarmed, armed in order',
              types == ['added', 'edited', 'disarmed', 'armed'], types)
        check('15 history: edited detail names the change',
              isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'Label changed',
              h[1] if isinstance(h, list) and len(h) >= 2 else h)
        check('15 history: manual added detail is the manual line',
              isinstance(h, list) and len(h) >= 1 and h[0].get('detail') == 'Never fires — manual only',
              h[0] if isinstance(h, list) and len(h) >= 1 else h)

        # Restore: a backup whose tx carries no history seeds one.
        s, bak = req('GET', '/api/backup')
        check('15 restore: backup fetched', s == 200, (s, r))
        bak3 = copy.deepcopy(bak)
        for tx3 in bak3['state']['bitcoin']['txs']:
            tx3.pop('history', None)
        delete_all_txs()
        s, r = req('POST', '/api/restore', bak3)
        check('15 restore: backup without history restores (200)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
        h3 = by_label.get('H manual renamed', {}).get('history')
        check('15 history: restore seeds one bare added event',
              isinstance(h3, list) and len(h3) == 1 and h3[0].get('type') == 'added' and h3[0].get('detail') == '', h3)
        delete_all_txs()

        # --- 16. gate/evaluator agreement on grace + vacation (0.8.2) ---
        # Step 1 pinned the gate's grace/vacation behaviour: the gate
        # answers the RAW condition (no grace, no vacation) — it
        # blocks an add whose condition is already met, even while
        # the evaluator holds it. The evaluator is the only path
        # that applies the holds.
        # Grace (price): the price is past the threshold, but the
        # grace holds the rule — the gate still reports fire, the
        # release check still does not broadcast, until the grace
        # is resumed.
        s, r = add_tx('16 price grace', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, 116000, trigger_confirmed=True)
        check('16 grace: price tx accepted (201)', s == 201, (s, r))
        g16 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
        save_state_file(stj)
        check('16 grace: app restarted with an active grace', restart())
        s, st = req('GET', '/api/state')
        check('16 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('16 grace: the gate still reports fire during a grace (no grace in the gate)',
              s == 200 and r.get('fire') is True, r)
        s, r, res = release_results()
        check('16 grace: the price tx does NOT broadcast during a grace',
              s == 200 and res.get(g16, {}).get('action') == 'skipped' and res.get(g16, {}).get('triggerStatus') == 'grace', res.get(g16))
        s, r = req('POST', '/api/grace/resume', {})
        check('16 grace: resumed', s == 200, (s, r))
        s, r, res = release_results()
        check('16 grace: the price tx broadcasts once the grace is resumed',
              s == 200 and res.get(g16, {}).get('action') == 'broadcast', res.get(g16))
        delete_all_txs()

        # Vacation (check-in): the clock is 40 days past due, but
        # vacation holds the rule — the gate still reports fire
        # (with and without the txId), the release check still
        # does not broadcast, until vacation is off.
        s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
        check('16 vacation: vacation mode on', s == 200, (s, r))
        s, r = add_tx('16 checkin vacation', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 116002)
        check('16 vacation: check-in tx accepted (201)', s == 201, (s, r))
        v16 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
        save_state_file(stj)
        check('16 vacation: app restarted with the clock 40 days past due', restart())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
        check('16 vacation: the gate reports fire during vacation (no vacation in the gate)',
              s == 200 and r.get('fire') is True, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}, 'txId': v16})
        check('16 vacation: the gate reports fire with the txId too',
              s == 200 and r.get('fire') is True, r)
        s, r, res = release_results()
        check('16 vacation: the check-in tx does NOT broadcast during vacation',
              s == 200 and res.get(v16, {}).get('action') == 'skipped' and res.get(v16, {}).get('triggerStatus') == 'vacation', res.get(v16))
        s, r = req('PUT', '/api/settings', {'vacationMode': False, 'vacationUntil': None})
        check('16 vacation: vacation mode off', s == 200, (s, r))
        s, r, res = release_results()
        check('16 vacation: the check-in tx broadcasts once vacation is off',
              s == 200 and res.get(v16, {}).get('action') == 'broadcast', res.get(v16))
        delete_all_txs()

        # --- 17. multi-trigger rule sets (0.8.2) --------------------------
        # OR fires on any rule; AND fires only when every rule holds
        # on the SAME tick (no per-rule latching); an unknown rule
        # blocks AND and is ignored by OR; grace holds only the
        # price/UTXO rule in a set; an already-satisfied set blocks
        # the add with the combined semantics.
        # 17.1 OR fires on one rule: the price rule does not hold
        # ($98,200 < $200,000) but the set-date rule does.
        or_set = {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        ]}
        s, r = add_tx('17 OR one rule', or_set, 116100, trigger_confirmed=True)
        check('17 OR: accepted with triggerConfirmed (201)', s == 201, (s, r))
        or17 = r['tx']['id'] if s == 201 else None
        check('17 OR: the add response serves the set',
              isinstance(r.get('tx', {}).get('trigger'), dict)
              and r['tx']['trigger'].get('op') == 'OR'
              and [x.get('type') for x in r['tx']['trigger'].get('rules', [])] == ['price', 'setdate']
              and r['tx']['trigger']['rules'][0] == or_set['rules'][0]
              and r['tx']['trigger']['rules'][1].get('type') == 'setdate',
              r.get('tx', {}).get('trigger'))
        t = state_tx(or17)
        h = t.get('history') if t else None
        check('17 OR: added detail joins the rules with OR',
              isinstance(h, list) and len(h) >= 1
              and h[0].get('detail', '').startswith('Fires when BTC price ≥ $200,000 OR the date '),
              h[0] if isinstance(h, list) and len(h) >= 1 else h)
        s, r, res = release_results()
        check('17 OR: broadcasts on the one holding rule',
              s == 200 and res.get(or17, {}).get('action') == 'broadcast', res.get(or17))
        t = state_tx(or17)
        check('17 OR: the release record names the rule that fired',
              t is not None and (t.get('release') or {}).get('trigger') == 'setdate', t.get('release') if t else None)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('17 OR: fired then broadcast, fired once',
              types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
        check('17 OR: fired detail names the rule that fired (the set-date rule)',
              isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'date reached',
              h[1] if isinstance(h, list) and len(h) >= 2 else h)
        delete_all_txs()

        # 17.2 AND fires only when all rules hold on the SAME tick:
        # the price crosses, then falls back before the fee rule
        # holds — the earlier hold must NOT latch.
        and_set = {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 100000}},
            {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'below'}},
        ]}
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('17 AND: cadence 10 s for the cache TTL', s == 200, (s, r))
        s, r = add_tx('17 AND no latch', and_set, 116102)
        check('17 AND: accepted without confirm (nothing holds yet, 201)', s == 201, (s, r))
        and17 = r['tx']['id'] if s == 201 else None
        # Phase 1: the price crosses ($101,000) while the fee is 1.
        s, pr = req('POST', '/__test__/price', {'usd': 101000}, base=STUB_BASE_P)
        check('17 AND: stub price $101,000', s == 200, pr)
        time.sleep(11)
        s, r, res = release_results()
        check('17 AND phase 1: price holds, fee does not — no broadcast',
              s == 200 and res.get(and17, {}).get('action') == 'skipped'
              and res.get(and17, {}).get('triggerStatus') == 'watching', res.get(and17))
        check('17 AND phase 1: the skipped release result names all rule types',
              res.get(and17, {}).get('trigger') == 'price+feemarket', res.get(and17))
        # Phase 2: the price falls back ($98,200) while the fee drops
        # to 0.4 — the earlier price hold must not have latched.
        s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        check('17 AND: stub price back to $98,200', s == 200, pr)
        s, r = req('POST', '/__test__/fees', {'economyFee': 0.4}, base=STUB_BASE_P)
        check('17 AND: primary fee 0.4', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 0.4}, base=STUB_BASE_S)
        check('17 AND: secondary fee 0.4', s == 200, (s, r))
        time.sleep(11)
        s, r, res = release_results()
        check('17 AND phase 2: fee holds, price does not — no broadcast (no latching)',
              s == 200 and res.get(and17, {}).get('action') == 'skipped'
              and res.get(and17, {}).get('triggerStatus') == 'watching', res.get(and17))
        # Phase 3: both hold on the same tick. (With the 10 s
        # cadence the full tick may broadcast it before the manual
        # check below — either path is the same tick's decision —
        # so the assertion reads the stored release, not the
        # manual check's action.)
        s, pr = req('POST', '/__test__/price', {'usd': 101000}, base=STUB_BASE_P)
        check('17 AND: stub price $101,000 again', s == 200, pr)
        time.sleep(11)
        s, r, res = release_results()
        t = state_tx(and17)
        check('17 AND phase 3: both hold on the same tick — broadcasts',
              t is not None and (t.get('release') or {}).get('status') == 'broadcast',
              t.get('release') if t else None)
        # Restore the stub prices/fees and the cadence.
        s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        check('17 AND: stub price restored to $98,200', s == 200, pr)
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
        check('17 AND: primary fee restored to 1', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
        check('17 AND: secondary fee restored to 1', s == 200, (s, r))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('17 AND: cadence back to 60 s', s == 200, (s, r))
        delete_all_txs()

        # 17.3 An unknown rule blocks AND and is ignored by OR:
        # CoinGecko $90,000 vs Coinbase $98,200 (8.7% apart) — the
        # price cannot be read, so the AND set cannot fire while
        # the OR set fires on its set-date rule.
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 90000}, base=STUB_BASE_P)
        check('17 unknown: CoinGecko stub set to $90,000', s == 200 and pr.get('coingecko', {}).get('usd') == 90000, pr)
        check('17 unknown: restart before the disagree eval (empty cache)', restart())
        and_unk = {'op': 'AND', 'rules': [
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        ]}
        s, r = add_tx('17 AND unknown', and_unk, 116104)
        check('17 unknown: AND with an unknown rule accepted (201 — unknown never blocks)', s == 201, (s, r))
        andu17 = r['tx']['id'] if s == 201 else None
        or_unk = {'op': 'OR', 'rules': [
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        ]}
        s, r = add_tx('17 OR unknown', or_unk, 116106, trigger_confirmed=True)
        check('17 unknown: OR with a holding rule accepted with confirm (201)', s == 201, (s, r))
        oru17 = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('17 unknown: AND does NOT broadcast while a rule is unknown',
              s == 200 and res.get(andu17, {}).get('action') == 'skipped' and res.get(andu17, {}).get('triggerStatus') == 'unknown', res.get(andu17))
        check('17 unknown: OR broadcasts on its readable rule',
              s == 200 and res.get(oru17, {}).get('action') == 'broadcast', res.get(oru17))
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 98200}, base=STUB_BASE_P)
        check('17 unknown: CoinGecko stub back to $98,200', s == 200, pr)
        check('17 unknown: restart to bust the price cache', restart())
        delete_all_txs()

        # 17.4 Grace holds only the price/UTXO rule in a set: the OR
        # set fires on its set-date rule during the grace, the AND
        # set cannot fire until the grace is resumed. The txs are
        # added AFTER the restart: the startup tick is a full
        # evaluation, so an already-satisfied OR set armed across
        # it would broadcast before the manual check below.
        or_g = {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        ]}
        and_g = {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        ]}
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
        save_state_file(stj)
        check('17 grace: app restarted with an active grace', restart())
        s, r = add_tx('17 OR grace', or_g, 116108, trigger_confirmed=True)
        check('17 grace: OR set accepted with confirm (201)', s == 201, (s, r))
        org17 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('17 AND grace', and_g, 116110, trigger_confirmed=True)
        check('17 grace: AND set accepted with confirm (201)', s == 201, (s, r))
        andg17 = r['tx']['id'] if s == 201 else None
        s, st = req('GET', '/api/state')
        check('17 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r, res = release_results()
        check('17 grace: OR fires on its non-held rule during a grace',
              s == 200 and res.get(org17, {}).get('action') == 'broadcast', res.get(org17))
        check('17 grace: AND does NOT fire while its price rule is held',
              s == 200 and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
        s, r, res = release_results()
        check('17 grace: a second release check still does not fire the AND set',
              s == 200 and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
        s, r = req('POST', '/api/grace/resume', {})
        check('17 grace: resumed', s == 200, (s, r))
        s, r, res = release_results()
        check('17 grace: AND broadcasts once the grace is resumed',
              s == 200 and res.get(andg17, {}).get('action') == 'broadcast', res.get(andg17))
        delete_all_txs()

        # 17.5 An already-satisfied set blocks the add with the
        # combined semantics: OR on any satisfied rule, AND only
        # when every rule is satisfied. Unknown rules never block.
        or_block = {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
        ]}
        s, r = add_tx('17 OR block', or_block, 116112)
        check('17 gate: OR with a holding rule blocked without confirm (400)',
              s == 400 and 'already satisfied' in str(r.get('error', '')), (s, r))
        s, r = add_tx('17 OR block', or_block, 116114, trigger_confirmed=True)
        check('17 gate: OR with a holding rule accepted with confirm (201)', s == 201, (s, r))
        and_block = {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        ]}
        s, r = add_tx('17 AND block', and_block, 116116)
        check('17 gate: AND with all rules holding blocked without confirm (400)',
              s == 400 and 'already satisfied' in str(r.get('error', '')), (s, r))
        s, r = add_tx('17 AND block', and_block, 116118, trigger_confirmed=True)
        check('17 gate: AND with all rules holding accepted with confirm (201)', s == 201, (s, r))
        or_open = {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
            {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
        ]}
        s, r = add_tx('17 OR open', or_open, 116120)
        check('17 gate: OR with nothing holding accepted without confirm (201)', s == 201, (s, r))
        and_open = {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
        ]}
        s, r = add_tx('17 AND open', and_open, 116122)
        check('17 gate: AND with one rule not holding accepted without confirm (201)', s == 201, (s, r))
        # The check endpoint answers the set the same way. (The
        # fireAt strings are compared structurally, not exactly:
        # the test's iso_* carry microseconds, the server stores
        # millisecond ISO.)
        s, r = req('POST', '/api/triggers/check', {'trigger': or_block})
        trig = r.get('trigger')
        check('17 gate: check on a firing OR set reports fire',
              s == 200 and r.get('fire') is True and isinstance(trig, dict) and trig.get('op') == 'OR'
              and [x.get('type') for x in trig.get('rules', [])] == ['price', 'setdate'], r)
        s, r = req('POST', '/api/triggers/check', {'trigger': and_open})
        trig = r.get('trigger')
        check('17 gate: check on a non-firing AND set reports no fire',
              s == 200 and r.get('fire') is False and isinstance(trig, dict) and trig.get('op') == 'AND'
              and [x.get('type') for x in trig.get('rules', [])] == ['price', 'setdate'], r)
        delete_all_txs()

        # 17.6 Migration wraps a single trigger as a one-rule OR
        # set with per-rule state: a stored single trigger + flat
        # triggerState (the 0.8.1 shape) loads as a set + array,
        # is served as the single rule, and still evaluates.
        s, r = add_tx('17 migrate', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 116124)
        check('17 migrate: single-rule tx accepted (201)', s == 201, (s, r))
        mig17 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        for txj in stj.get('bitcoin', {}).get('txs', []):
            if txj.get('id') == mig17:
                # Rewind to the 0.8.1 stored shape: a single trigger
                # and a flat triggerState.
                txj['trigger'] = {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}
                txj['triggerState'] = {'status': 'watching', 'reason': 'currently $98,200',
                                       'lastEvalAt': iso_ago(hours=1), 'lastPrice': 98200, 'lastPriceAt': iso_ago(hours=1),
                                       'lastError': None, 'priceMode': 'dual', 'priceNote': '',
                                       'lastEconomyFee': None, 'feeMode': None, 'feeNote': None,
                                       'heightReachedFor': None, 'lastBlockHeight': None}
        save_state_file(stj)
        check('17 migrate: app restarted on the 0.8.1 shape', restart())
        stj = load_state_file()
        migj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == mig17), None)
        check('17 migrate: the trigger loads as a one-rule OR set',
              migj is not None and migj.get('trigger') == {'op': 'OR', 'rules': [{'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}]}, migj.get('trigger') if migj else None)
        check('17 migrate: the triggerState loads as a one-element array keeping lastPrice',
              migj is not None and isinstance(migj.get('triggerState'), list) and len(migj.get('triggerState')) == 1
              and migj['triggerState'][0].get('lastPrice') == 98200, migj.get('triggerState') if migj else None)
        t = state_tx(mig17)
        check('17 migrate: the served trigger is the single rule',
              t is not None and t.get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, t.get('trigger') if t else None)
        check('17 migrate: the served triggerState is the flat slice',
              t is not None and isinstance(t.get('triggerState'), dict) and t.get('triggerState', {}).get('lastPrice') == 98200, t.get('triggerState') if t else None)
        s, r, res = release_results()
        check('17 migrate: the migrated tx evaluates (not holding, no broadcast)',
              s == 200 and res.get(mig17, {}).get('action') == 'skipped' and res.get(mig17, {}).get('triggerStatus') == 'watching', res.get(mig17))
        delete_all_txs()

        # 17.7 Per-rule triggerState survives a restart: a
        # multi-rule tx evaluated once carries one slice per rule,
        # and the array is intact after a restart.
        two_set = {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
            {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
        ]}
        s, r = add_tx('17 two-rule state', two_set, 116126)
        check('17 state: two-rule tx accepted (201)', s == 201, (s, r))
        two17 = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('17 state: neither rule holds — no broadcast',
              s == 200 and res.get(two17, {}).get('action') == 'skipped', res.get(two17))
        stj = load_state_file()
        twoj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == two17), None)
        check('17 state: triggerState is a two-element array with a price slice carrying lastPrice',
              twoj is not None and isinstance(twoj.get('triggerState'), list) and len(twoj.get('triggerState')) == 2
              and twoj['triggerState'][0].get('lastPrice') == 98200
              and twoj['triggerState'][1].get('status') == 'watching', twoj.get('triggerState') if twoj else None)
        check('17 state: app restarted', restart())
        stj = load_state_file()
        twoj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == two17), None)
        check('17 state: the per-rule array is intact after a restart',
              twoj is not None and isinstance(twoj.get('triggerState'), list) and len(twoj.get('triggerState')) == 2
              and twoj['triggerState'][0].get('lastPrice') == 98200
              and twoj['triggerState'][1].get('status') == 'watching', twoj.get('triggerState') if twoj else None)
        delete_all_txs()

        # --- 18. full-evaluation tick + broadcast backoff (0.8.2) -----
        # One tick evaluates every rule type together: an AND set
        # spanning tick domains (check-in AND price) fires on the
        # tick, not only on a manual check. And a due tx whose
        # broadcast fails is not re-attempted by the tick within
        # the hour — the stub attempt counts prove it — while a
        # manual release check and a manual broadcast bypass the
        # backoff (explicit user action), and the retry succeeds
        # once the hour has passed.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('18 tick: cadence set to 10 s', s == 200, (s, r))
        # 18.1 AND [checkin, price] fires on the full tick: the
        # clock is 40 days past due (check-in rule holds) and the
        # stub price $98,200 is past the $90,000 threshold. The tx
        # is added before the restart so the startup tick (5 s
        # after boot, a full evaluation) is the tick that fires it.
        cross_set = {'op': 'AND', 'rules': [
            {'type': 'checkin', 'params': {'thresholdDays': 35}},
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        ]}
        s, r = add_tx('18 cross-domain AND', cross_set, 118100)
        check('18 cross: AND [checkin, price] accepted (201 — check-in not due yet)', s == 201, (s, r))
        cross18 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
        save_state_file(stj)
        check('18 cross: app restarted with the clock 40 days past due', restart())
        t = state_tx(cross18)
        check('18 cross: the full tick broadcast the AND set (both rules held on the same tick)',
              t is not None and (t.get('release') or {}).get('status') == 'broadcast', t.get('release') if t else None)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('18 cross: fired once then broadcast',
              types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
        delete_all_txs()

        # 18.2 Backoff: with both stubs rejecting every broadcast,
        # the tick's first attempt fails — and the next ticks,
        # minutes later, must NOT re-attempt it. A check-in tx
        # added while the clock is past due RESETS the clock
        # (0.7.22 add-reset — the add is the danger-zone reset, not
        # a test artifact), so the tx is added first and the clock
        # is then backdated 40 days in state, and the app is
        # restarted: the startup full tick is the first attempt.
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': True}, base=STUB_BASE_P)
        check('18 backoff: primary stub rejecting broadcasts', s == 200 and r.get('fail') is True, r)
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': True}, base=STUB_BASE_S)
        check('18 backoff: secondary stub rejecting broadcasts', s == 200 and r.get('fail') is True, r)
        s, c0p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c0s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 backoff: attempt counts read', isinstance(c0p.get('count'), int) and isinstance(c0s.get('count'), int), (c0p, c0s))
        s, r = add_tx('18 backoff checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 118102, trigger_confirmed=True)
        check('18 backoff: check-in tx accepted with confirm (201)', s == 201, (s, r))
        check('18 backoff: the add reset the clock (danger-zone add-reset)', r.get('checkinReset') is True, r)
        bo18 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        save_state_file(stj)
        check('18 backoff: app restarted with the clock 40 days past due', restart())
        t = state_tx(bo18)
        check('18 backoff: the startup tick attempted once and it failed',
              t is not None and (t.get('release') or {}).get('status') == 'failed'
              and isinstance((t.get('release') or {}).get('lastAttemptAt'), str), (t or {}).get('release'))
        s, c1p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c1s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 backoff: the attempt hit the primary once and fell back to the secondary once',
              c1p.get('count') == c0p.get('count') + 1 and c1s.get('count') == c0s.get('count') + 1, (c0p, c1p, c0s, c1s))
        last_attempt = (t.get('release') or {}).get('lastAttemptAt') if t else None
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('18 backoff: exactly one failed history event, fired once',
              types.count('failed') == 1 and types.count('fired') == 1, types)
        # A second tick, minutes later, must not re-attempt it.
        time.sleep(12)
        s, c2p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c2s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 backoff: the next tick made no second attempt on either node',
              c2p.get('count') == c1p.get('count') and c2s.get('count') == c1s.get('count'), (c1p, c2p, c1s, c2s))
        t = state_tx(bo18)
        check('18 backoff: lastAttemptAt unchanged across the second tick',
              t is not None and (t.get('release') or {}).get('lastAttemptAt') == last_attempt, (t or {}).get('release'))
        check('18 backoff: still failed, still due (no second fired event)',
              t is not None and (t.get('release') or {}).get('status') == 'failed'
              and [e.get('type') for e in (t.get('history') or [])].count('failed') == 1
              and [e.get('type') for e in (t.get('history') or [])].count('fired') == 1, (t or {}).get('history'))
        # 18.3 Manual paths bypass the backoff (explicit user
        # action): a manual release check retries — and fails
        # again against the rejecting stubs — and so does a manual
        # broadcast of the tx. Each moves lastAttemptAt forward.
        s, r, res = release_results()
        check('18 manual: a manual release check retries despite the backoff',
              s == 200 and res.get(bo18, {}).get('action') == 'failed', res.get(bo18))
        s, c3p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c3s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 manual: the manual check attempted once more on each node',
              c3p.get('count') == c2p.get('count') + 1 and c3s.get('count') == c2s.get('count') + 1, (c2p, c3p, c2s, c3s))
        t = state_tx(bo18)
        last_attempt2 = (t.get('release') or {}).get('lastAttemptAt') if t else None
        check('18 manual: the manual check moved lastAttemptAt forward',
              isinstance(last_attempt2, str) and last_attempt2 > last_attempt, (last_attempt, last_attempt2))
        s, r = req('POST', '/api/bitcoin/txs/' + bo18 + '/broadcast', {})
        check('18 manual: a manual broadcast retries despite the backoff',
              s == 200 and r.get('action') == 'failed', r)
        s, c4p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c4s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 manual: the manual broadcast attempted once more on each node',
              c4p.get('count') == c3p.get('count') + 1 and c4s.get('count') == c3s.get('count') + 1, (c3p, c4p, c3s, c4s))
        t = state_tx(bo18)
        last_attempt3 = (t.get('release') or {}).get('lastAttemptAt') if t else None
        check('18 manual: the manual broadcast moved lastAttemptAt forward again',
              isinstance(last_attempt3, str) and last_attempt3 > last_attempt2, (last_attempt2, last_attempt3))
        # 18.4 Retry after the window: lastAttemptAt is backdated
        # two hours in state — the startup tick (a full evaluation)
        # retries. The edit is made while the app is STOPPED: a
        # tick firing between the edit and a restart would retry
        # immediately and clobber the backdate with a fresh stamp.
        # Phase 1 — the stubs still reject, so the retry fails
        # again (and moves lastAttemptAt forward once more).
        stop(app)
        stj = load_state_file()
        for txj in stj.get('bitcoin', {}).get('txs', []):
            if txj.get('id') == bo18 and isinstance(txj.get('release'), dict):
                txj['release']['lastAttemptAt'] = iso_ago(hours=2)
        save_state_file(stj)
        app = start(['node', 'server.js'], env=APP_ENV, cwd=APP, log=LOG)
        check('18 retry: app restarted with lastAttemptAt two hours back', wait_up(BASE))
        time.sleep(7)
        t = state_tx(bo18)
        check('18 retry: the startup tick retried after the hour and failed again',
              t is not None and (t.get('release') or {}).get('status') == 'failed'
              and (t.get('release') or {}).get('lastAttemptAt') > last_attempt3, (t or {}).get('release'))
        s, c5p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c5s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('18 retry: the retry attempted once more on each node',
              c5p.get('count') == c4p.get('count') + 1 and c5s.get('count') == c4s.get('count') + 1, (c4p, c5p, c4s, c5s))
        # Phase 2 — the stubs accept again: the same backdate +
        # restart retries and the broadcast lands.
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_P)
        check('18 retry: primary stub accepting broadcasts again', s == 200 and r.get('fail') is False, r)
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_S)
        check('18 retry: secondary stub accepting broadcasts again', s == 200 and r.get('fail') is False, r)
        stop(app)
        stj = load_state_file()
        for txj in stj.get('bitcoin', {}).get('txs', []):
            if txj.get('id') == bo18 and isinstance(txj.get('release'), dict):
                txj['release']['lastAttemptAt'] = iso_ago(hours=2)
        save_state_file(stj)
        app = start(['node', 'server.js'], env=APP_ENV, cwd=APP, log=LOG)
        check('18 retry: app restarted with lastAttemptAt two hours back again', wait_up(BASE))
        time.sleep(7)
        t = state_tx(bo18)
        check('18 retry: the startup tick retried after the hour and broadcast',
              t is not None and (t.get('release') or {}).get('status') == 'broadcast', (t or {}).get('release'))
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('18 retry: fired once across the whole backoff episode',
              types.count('fired') == 1, types)

        # Restore the default cadence for the remaining sections.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('18 tick: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()

        # --- 19. live rule status for never-evaluated / disarmed txs (0.8.2; 0.8.4) -----
        # ruleStatusFor reads warm in-memory data for price, fee and
        # set-date, so a tx that was never evaluated (added then
        # disarmed before any tick) still shows Met / Not met instead
        # of Unknown. (0.8.4) The tick now evaluates EVERY tx, so a
        # disarmed tx also gets a fresh slice within one cadence —
        # block-height and UTXO read live from the slice, not from
        # a warm cache (there is none). A manual release check
        # evaluates all txs on demand, which is what pins the slice
        # values below. Stub facts: price 98200, economy fee 1
        # sat/vB, tip 900000.
        # Warm both caches first (the trigger-check endpoint reads
        # through the same caches the status read uses).
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
        check('19 warm: fee trigger check runs (warms the node-fee cache)', s == 200 and r.get('fire') is True, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('19 warm: price trigger check runs (warms the price cache)', s == 200 and r.get('fire') is True, (s, r))
        # A disarmed fee tx, never evaluated: below the fee watches.
        s, r = add_tx('FM live disarmed', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 119000)
        check('19 fee: disarmed fee tx adds (201)', s == 201, (s, r))
        fm_live = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + fm_live, {'enabled': False})
        check('19 fee: disarmed at once (200)', s == 200, (s, r))
        t = state_tx(fm_live)
        check('19 fee: live status is watching with the economy fee',
              t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerStatus') if t else None)
        # A disarmed fee tx above the fee reads due (Met), live.
        s, r = add_tx('FM live disarmed due', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 119002, trigger_confirmed=True)
        check('19 fee due: disarmed fee tx adds with confirmation (201)', s == 201, (s, r))
        fm_due = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + fm_due, {'enabled': False})
        check('19 fee due: disarmed at once (200)', s == 200, (s, r))
        t = state_tx(fm_due)
        check('19 fee due: live status is due',
              t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        # Set-date is pure clock math: future watches, past is due.
        s, r = add_tx('SD live disarmed', {'type': 'setdate', 'params': {'fireAt': '2030-01-01T00:00:00.000Z'}}, 119004)
        check('19 setdate: disarmed set-date tx adds (201)', s == 201, (s, r))
        sd_live = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + sd_live, {'enabled': False})
        check('19 setdate: disarmed at once (200)', s == 200, (s, r))
        t = state_tx(sd_live)
        check('19 setdate: future date reads watching live',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        past_date = iso_ago(days=1)
        s, r = add_tx('SD past live disarmed', {'type': 'setdate', 'params': {'fireAt': past_date}}, 119006, trigger_confirmed=True)
        check('19 setdate past: disarmed past-date tx adds with confirmation (201)', s == 201, (s, r))
        sd_past = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + sd_past, {'enabled': False})
        check('19 setdate past: disarmed at once (200)', s == 200, (s, r))
        t = state_tx(sd_past)
        check('19 setdate past: past date reads due live',
              t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        # The History-test shape: a disarmed AND [price >= 62625,
        # feemarket below 5] reads due on both rules, combined due.
        s, r = add_tx('AND live disarmed', {'op': 'AND', 'rules': [{'type': 'price', 'params': {'op': '>=', 'value': 62625}}, {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}]}, 119008, trigger_confirmed=True)
        check('19 AND: disarmed AND tx adds with confirmation (201)', s == 201, (s, r))
        and_live = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + and_live, {'enabled': False})
        check('19 AND: disarmed at once (200)', s == 200, (s, r))
        t = state_tx(and_live)
        ts = (t or {}).get('triggerStatus', {})
        check('19 AND: combined status is due, both rules due live',
              ts.get('status') == 'due' and len(ts.get('rules', [])) == 2
              and ts['rules'][0].get('status') == 'due' and ts['rules'][1].get('status') == 'due', ts)
        # Block-height and UTXO have no live cache read — their
        # status comes from the evaluation slice, pinned after the
        # manual check below (0.8.4: the tick writes it too).
        s, r = add_tx('BH live disarmed', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 119010)
        check('19 blockheight: disarmed tx adds (201)', s == 201, (s, r))
        bh_live = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + bh_live, {'enabled': False})
        check('19 blockheight: disarmed at once (200)', s == 200, (s, r))
        s, r = add_tx('UTXO live disarmed', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, 119012)
        check('19 utxo: disarmed tx adds (201)', s == 201, (s, r))
        ux_live = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + ux_live, {'enabled': False})
        check('19 utxo: disarmed at once (200)', s == 200, (s, r))
        # (0.8.4) A manual release check evaluates every disarmed
        # tx and writes fresh slices — no broadcast (nothing is
        # armed), and the due ones are listed as skipped with a
        # disarmed reason.
        s, r, res = release_results()
        check('19 slices: the manual check evaluates all disarmed txs (200)',
              s == 200, (s, r))
        check('19 slices: the top-level reason names the disarmed firing',
              r.get('reason') == 'trigger fired — transaction disarmed', r.get('reason'))
        t = state_tx(fm_live)
        check('19 slices: disarmed fee slice is fresh (watching, economy fee 1)',
              rule_slice(t).get('status') == 'watching'
              and rule_slice(t).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerState') if t else None)
        t = state_tx(fm_due)
        check('19 slices: disarmed due fee slice is fresh (due)',
              rule_slice(t).get('status') == 'due', t.get('triggerState') if t else None)
        t = state_tx(sd_live)
        check('19 slices: disarmed set-date slice is fresh (watching)',
              rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
        t = state_tx(sd_past)
        check('19 slices: disarmed past-date slice is fresh (due)',
              rule_slice(t).get('status') == 'due', t.get('triggerState') if t else None)
        t = state_tx(and_live)
        check('19 slices: disarmed AND slices are fresh (both rules due)',
              rule_slice(t, 0).get('status') == 'due'
              and rule_slice(t, 1).get('status') == 'due', t.get('triggerState') if t else None)
        t = state_tx(bh_live)
        check('19 slices: disarmed block-height slice is live (watching, tip 900000)',
              rule_slice(t).get('status') == 'watching'
              and rule_slice(t).get('lastTipHeight') == STUB_TIP, t.get('triggerState') if t else None)
        t = state_tx(ux_live)
        check('19 slices: disarmed UTXO slice is live (watching, unspent)',
              rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
        check('19 slices: the due disarmed txs are listed as skipped, not broadcast',
              res.get(fm_due, {}).get('action') == 'skipped' and res.get(and_live, {}).get('action') == 'skipped'
              and (res.get(fm_due, {}).get('reason') or '').startswith('disarmed'), res)
        # Cold cache (0.8.4): restart clears the in-memory caches,
        # but the slices are wiped from the state file first, so
        # only the startup tick can rewrite them — proving the tick
        # evaluates disarmed txs. The fee rule reads watching from
        # the fresh slice and the re-warmed cache.
        stj = load_state_file()
        for txj in stj.get('bitcoin', {}).get('txs', []):
            txj['triggerState'] = None
        save_state_file(stj)
        check('19 cold: app restarts with wiped slices', restart())
        t = state_tx(fm_live)
        check('19 cold: the startup tick re-evaluated the disarmed fee tx (slice fresh, watching)',
              t and rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
        check('19 cold: fee rule reads watching live after restart',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        # TTL expiry (0.8.4: the age check is gone, like price, and
        # the tick evaluates disarmed txs, so the caches stay warm
        # for them too). Before 0.8.4 the fee branch only trusted
        # the node-fee cache while it was younger than one cadence
        # — nothing re-warmed it for a disarmed tx, so past one
        # cadence the pill fell back to Unknown. Now the last known
        # fee is trusted until a fresh reading arrives, exactly
        # like the price branch: past one cadence the fee rule
        # still reads live (watching/due) with its fee note
        # intact. Cadence 10 s keeps the wait short.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('19 ttl: cadence set to 10 s', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
        check('19 ttl: fee trigger check re-warms the cache', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('19 ttl: price trigger check re-warms the cache', s == 200, (s, r))
        t = state_tx(fm_live)
        check('19 ttl: fee rule live (watching) right after warming',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        t = state_tx(and_live)
        check('19 ttl: AND price rule live (due) right after warming',
              t and (t.get('triggerStatus', {}).get('rules') or [{}])[0].get('status') == 'due', t.get('triggerStatus') if t else None)
        time.sleep(12)
        t = state_tx(fm_live)
        check('19 ttl: fee rule still live (watching) past one cadence',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        check('19 ttl: fee rule still carries its last known fee past one cadence',
              t and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE
              and t.get('triggerStatus', {}).get('feeMode')
              and t.get('triggerStatus', {}).get('feeNote'), t.get('triggerStatus') if t else None)
        t = state_tx(and_live)
        check('19 ttl: AND price rule still due past one cadence (no age check)',
              t and (t.get('triggerStatus', {}).get('rules') or [{}])[0].get('status') == 'due', t.get('triggerStatus') if t else None)
        check('19 ttl: AND fee rule still due past one cadence (no age check)',
              t and (t.get('triggerStatus', {}).get('rules') or [{}])[1].get('status') == 'due', t.get('triggerStatus') if t else None)
        check('19 ttl: AND combined status still due past one cadence',
              t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('19 ttl: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()

        # --- 20. persistence hardening (0.8.3) ---------------------------
        # (a) Backup rotation: every save keeps the previous version
        # as state.json.bak; the first save of a day snapshots it
        # (kept 7 days); a migration snapshots the pre-migration
        # file. (b) Corrupt state.json recovers from the newest
        # usable backup, preserves the corrupt file, and warns — and
        # with NO usable backup it fails loudly instead of silently
        # resetting. A missing state.json recovers from backups the
        # same way (finding 1); only a directory with no backups at
        # all starts fresh. (c) Startup key-store check: state keys +
        # missing receiver file -> rewritten; state empty +
        # receiver keys -> warning, receiver untouched; state empty
        # + backup keys -> warning naming the backup. Key
        # create/revoke write log lines.
        # The app is STOPPED before any file is corrupted by hand:
        # a running full tick would otherwise recover first and the
        # restart would have nothing to prove (and the in-memory
        # warning would be lost across the restart).
        def state_warnings():
            s, st = req('GET', '/api/state')
            return st.get('warnings', []) if s == 200 else None
        def warning_codes():
            w = state_warnings()
            return [x.get('code') for x in (w or [])]
        def data_files():
            return os.listdir(DATA)
        def read_log():
            try:
                return open(LOG).read()
            except OSError:
                return ''
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        check('20 warnings: /api/state carries a warnings array',
              isinstance(state_warnings(), list))
        # (a) .bak rotation: a save keeps the previous version.
        st_before = load_state_file()
        s, r = add_tx('20 bak marker', {'type': 'manual', 'params': {}}, 120000)
        check('20 bak: manual tx adds (201)', s == 201, (s, r))
        bak = json.load(open(os.path.join(DATA, 'state.json.bak')))
        check('20 bak: previous version kept (pre-save updatedAt)',
              bak.get('updatedAt') == st_before.get('updatedAt'), (bak.get('updatedAt'), st_before.get('updatedAt')))
        check('20 bak: previous version has no marker tx',
              not any(t.get('label') == '20 bak marker' for t in bak.get('bitcoin', {}).get('txs', [])))
        # (a) Daily snapshot: written once per day; 7-day retention.
        daily_today = os.path.join(DATA, 'state.json.bak.' + today)
        check("20 daily: today's snapshot exists and parses",
              os.path.exists(daily_today) and json.load(open(daily_today)).get('version') == 7)
        # Retention: nine fake old dailies + a new day's first save
        # prunes to the 7 newest. (Today's snapshot is removed first
        # so the next save counts as the day's first.)
        for d in ('2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
                  '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'):
            open(os.path.join(DATA, 'state.json.bak.' + d), 'w').write('{}\n')
        os.unlink(daily_today)
        s, r = add_tx('20 prune marker', {'type': 'manual', 'params': {}}, 120002)
        check('20 prune: tx adds (201)', s == 201, (s, r))
        dailies = sorted(f for f in data_files() if f.startswith('state.json.bak.20'))
        check('20 prune: 7 daily snapshots kept (today + 6 newest)',
              len(dailies) == 7, dailies)
        check('20 prune: oldest fakes pruned',
              'state.json.bak.2026-11-01' not in dailies and 'state.json.bak.2026-11-03' not in dailies, dailies)
        check("20 prune: today's snapshot re-created",
              os.path.exists(daily_today))
        # (a) Pre-migration snapshot: a legacy settings field is
        # pruned by loadState's migration, which snapshots first.
        stop(app)
        st = load_state_file()
        st['settings']['thresholdDays'] = 35
        save_state_file(st)
        check('20 premig: app restarts with legacy state', restart())
        pm = os.path.join(DATA, 'state.json.pre-migration')
        check('20 premig: snapshot exists and holds the legacy field',
              os.path.exists(pm) and json.load(open(pm)).get('settings', {}).get('thresholdDays') == 35)
        check('20 premig: live state pruned the legacy field',
              'thresholdDays' not in load_state_file().get('settings', {}))
        delete_all_txs()
        # (b) Corrupt state.json -> recovers from .bak.
        s, r = add_tx('20 recover A', {'type': 'manual', 'params': {}}, 120010)
        check('20 recover: tx A adds (201)', s == 201, (s, r))
        s, r = add_tx('20 recover B', {'type': 'manual', 'params': {}}, 120012)
        check('20 recover: tx B adds (201)', s == 201, (s, r))
        stop(app)
        open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
        check('20 recover: app restarts with a corrupt state file', restart())
        s, st = req('GET', '/api/state')
        labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
        check('20 recover: recovered from .bak (A present, B absent)',
              s == 200 and '20 recover A' in labels and '20 recover B' not in labels, labels)
        check('20 recover: warnings carry state-recovered',
              'state-recovered' in warning_codes(), warning_codes())
        corrupt = [f for f in data_files() if f.startswith('state.json.corrupt.')]
        check('20 recover: corrupt file preserved, not deleted',
              len(corrupt) == 1, corrupt)
        # (b) Corrupt state + corrupt .bak -> recovers from daily.
        s, r = add_tx('20 daily marker', {'type': 'manual', 'params': {}}, 120014)
        check('20 daily: marker tx adds (201)', s == 201, (s, r))
        shutil.copy(os.path.join(DATA, 'state.json'), daily_today)
        s, r = add_tx('20 daily marker 2', {'type': 'manual', 'params': {}}, 120016)
        check('20 daily: second tx adds (201)', s == 201, (s, r))
        stop(app)
        open(os.path.join(DATA, 'state.json.bak'), 'w').write('GARBAGE{{{not json\n')
        open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
        check('20 daily: app restarts with corrupt state + corrupt .bak', restart())
        s, st = req('GET', '/api/state')
        labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
        check('20 daily: recovered from daily snapshot (marker present, second absent)',
              s == 200 and '20 daily marker' in labels and '20 daily marker 2' not in labels, labels)
        check('20 daily: warnings carry state-recovered',
              'state-recovered' in warning_codes(), warning_codes())
        # (b) All backups corrupt -> loud failure, NO silent reset.
        good_bytes = open(os.path.join(DATA, 'state.json'), 'rb').read()
        stop(app)
        for f in data_files():
            if f == 'state.json' or f.startswith('state.json.bak'):
                open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
        check('20 noreset: app does NOT come up healthy', not restart())
        s, r = req('GET', '/api/health')
        check('20 noreset: /api/health answers 500 naming the corruption',
              s == 500 and 'corrupt' in str(r).lower(), (s, r))
        s, r = req('GET', '/api/state')
        check('20 noreset: /api/state answers 500, not a default empty state',
              s == 500, (s, r))
        check('20 noreset: corrupt state file left in place, not reset',
              open(os.path.join(DATA, 'state.json'), 'rb').read().startswith(b'GARBAGE'))
        open(os.path.join(DATA, 'state.json'), 'wb').write(good_bytes)
        check('20 noreset: app recovers once a good state file is restored', restart())
        # (b2) Missing state.json with backups -> recovers from
        # .bak (finding 1): a missing state file is a lost state
        # file, not a fresh install.
        s, r = add_tx('20 missing A', {'type': 'manual', 'params': {}}, 120020)
        check('20 missing: tx A adds (201)', s == 201, (s, r))
        s, r = add_tx('20 missing B', {'type': 'manual', 'params': {}}, 120022)
        check('20 missing: tx B adds (201)', s == 201, (s, r))
        stop(app)
        os.unlink(os.path.join(DATA, 'state.json'))
        check('20 missing: app restarts with state.json deleted', restart())
        s, st = req('GET', '/api/state')
        labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
        check('20 missing: recovered from .bak (A present, B absent)',
              s == 200 and '20 missing A' in labels and '20 missing B' not in labels, labels)
        check('20 missing: warnings carry state-missing-recovered',
              'state-missing-recovered' in warning_codes(), warning_codes())
        check('20 missing: state.json written back',
              os.path.exists(os.path.join(DATA, 'state.json')))
        check('20 missing: .bak still on disk',
              os.path.exists(os.path.join(DATA, 'state.json.bak')))
        # (b2) Missing state.json + all backups corrupt -> loud
        # failure, NO silent reset (finding 1's other half).
        good2 = open(os.path.join(DATA, 'state.json'), 'rb').read()
        stop(app)
        for f in data_files():
            if f.startswith('state.json.bak'):
                open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
        os.unlink(os.path.join(DATA, 'state.json'))
        check('20 missing: app does NOT come up healthy (all backups corrupt)', not restart())
        s, r = req('GET', '/api/health')
        check('20 missing: /api/health answers 500 naming the missing state',
              s == 500 and 'missing' in str(r).lower(), (s, r))
        s, r = req('GET', '/api/state')
        check('20 missing: /api/state answers 500, not a default empty state',
              s == 500, (s, r))
        check('20 missing: no state.json created (no silent reset)',
              not os.path.exists(os.path.join(DATA, 'state.json')))
        open(os.path.join(DATA, 'state.json'), 'wb').write(good2)
        check('20 missing: app recovers once a good state file is restored', restart())
        # (c) Startup key sync: state has keys + receiver missing ->
        # rewritten from state.
        s, r = req('POST', '/api/checkin-keys', {'label': '20 sync key'})
        check('20 keys: key creates (201)', s == 201, (s, r))
        sync_id = r['key']['id'] if s == 201 else None
        time.sleep(0.5)
        check('20 keys: create writes a log line',
              ('check-in key created: ' + str(sync_id) + ' (20 sync key)') in read_log())
        stop(app)
        os.unlink(os.path.join(CHECKIN_DIR, 'keys.json'))
        check('20 keys: app restarts with receiver keys.json missing', restart())
        recv_keys = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
        check('20 keys: receiver file rewritten from state',
              [k.get('id') for k in recv_keys.get('keys', [])] == [sync_id], recv_keys)
        check('20 keys: warnings carry receiver-keys-rewritten',
              'receiver-keys-rewritten' in warning_codes(), warning_codes())
        # (c) State empty + receiver has keys -> warning, receiver
        # untouched; the previous version (.bak) also has the key.
        stop(app)
        st = load_state_file()
        st['checkinKeys'] = []
        save_state_file(st)
        recv_before = open(os.path.join(CHECKIN_DIR, 'keys.json'), 'rb').read()
        check('20 keys: app restarts with state keys emptied', restart())
        check('20 keys: receiver file untouched',
              open(os.path.join(CHECKIN_DIR, 'keys.json'), 'rb').read() == recv_before)
        check('20 keys: warnings carry receiver-keys-orphaned',
              'receiver-keys-orphaned' in warning_codes(), warning_codes())
        check('20 keys: warnings name the .bak holding the key',
              any('keys-in-backup' in c for c in warning_codes())
              and any('state.json.bak' in (x.get('message') or '') for x in (state_warnings() or []) if x.get('code') == 'keys-in-backup'),
              warning_codes())
        # (c) State empty + daily backup has keys -> warning names
        # the daily backup; no auto-restore either way.
        s, r = req('POST', '/api/checkin-keys', {'label': '20 daily key'})
        check('20 keys: second key creates (201)', s == 201, (s, r))
        shutil.copy(os.path.join(DATA, 'state.json'), daily_today)
        stop(app)
        st = load_state_file()
        st['checkinKeys'] = []
        save_state_file(st)
        open(os.path.join(CHECKIN_DIR, 'keys.json'), 'w').write('{"keys": []}\n')
        check('20 keys: app restarts with state + receiver both keyless', restart())
        w = state_warnings() or []
        check('20 keys: warnings name the daily backup holding the key',
              any(x.get('code') == 'keys-in-backup' and ('state.json.bak.' + today) in (x.get('message') or '') for x in w), w)
        s, st = req('GET', '/api/state')
        check('20 keys: no auto-restore — state stays keyless',
              s == 200 and st.get('checkinKeys') == [], st.get('checkinKeys'))
        check('20 keys: no auto-restore — receiver stays keyless',
              json.load(open(os.path.join(CHECKIN_DIR, 'keys.json'))).get('keys') == [])
        # (d) Revoke writes a log line; tidy up the test keys.
        s, r = req('POST', '/api/checkin-keys', {'label': '20 log key'})
        check('20 keys: log-test key creates (201)', s == 201, (s, r))
        log_id = r['key']['id'] if s == 201 else None
        s, r = req('DELETE', '/api/checkin-keys/' + str(log_id))
        check('20 keys: log-test key revokes (200)', s == 200, (s, r))
        time.sleep(0.5)
        check('20 keys: revoke writes a log line',
              ('check-in key revoked: ' + str(log_id)) in read_log())
        # (b2) Fresh install: no state file AND no backups -> a
        # genuine default state, not an error. A second app
        # instance on its own port + data dir proves first boot
        # still works after the finding-1 change.
        fresh_data = '/tmp/heirloom099-fresh'
        fresh_checkin = '/tmp/heirloom099-fresh-checkin'
        shutil.rmtree(fresh_data, ignore_errors=True)
        shutil.rmtree(fresh_checkin, ignore_errors=True)
        check('20 fresh: port 3458 free', port_closed(3458))
        fresh_env = dict(APP_ENV)
        fresh_env.update({'PORT': '3458', 'DATA_DIR': fresh_data, 'CHECKIN_DIR': fresh_checkin})
        fresh_base = 'http://127.0.0.1:3458'
        fresh_app = start(['node', 'server.js'], env=fresh_env, cwd=APP, log=LOG)
        check('20 fresh: second instance comes up', wait_up(fresh_base))
        s, st = req('GET', '/api/state', base=fresh_base)
        check('20 fresh: default state (version 7, no txs)',
              s == 200 and st.get('version') == 7 and st.get('bitcoin', {}).get('txs') == [],
              (s, st.get('version') if s == 200 else st))
        s, st = req('GET', '/api/state', base=fresh_base)
        check('20 fresh: no recovery warning on first boot',
              s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
        check('20 fresh: no backup files on disk',
              not any(f.startswith('state.json.bak') for f in os.listdir(fresh_data)), os.listdir(fresh_data))
        stop(fresh_app)
        # (b2) Rescue endpoints (0.8.3, clearable error): with
        # state.json corrupt and every backup corrupt, the app
        # stays up answering 500s — but POST /api/restore with a
        # valid backup still works, and POST /api/state/reset
        # with {confirm:true} starts fresh.
        s, backup_doc = req('GET', '/api/backup')
        check('20 rescue: backup downloads before breaking (200)',
              s == 200 and backup_doc.get('format') == 'standby-backup'
              and isinstance(backup_doc.get('state'), dict), (s, backup_doc.get('format')))
        labels_before = [t.get('label') for t in
                         (backup_doc.get('state', {}).get('bitcoin', {}) or {}).get('txs', [])]
        # (a) Restore while broken.
        stop(app)
        open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
        for f in data_files():
            if f.startswith('state.json.bak'):
                open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
        check('20 rescue: app does NOT come up healthy (corrupt state + corrupt backups)', not restart())
        s, r = req('POST', '/api/restore', backup_doc)
        check('20 rescue: restore works while broken (200)',
              s == 200 and r.get('ok') is True, (s, r))
        s, st = req('GET', '/api/state')
        labels_after = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
        check('20 rescue: state healthy again with the same txs',
              s == 200 and labels_after == labels_before, (s, labels_after))
        check('20 rescue: warnings cleared by the restore',
              s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
        # (c) An invalid backup while broken -> 400, still broken.
        stop(app)
        open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
        for f in data_files():
            if f.startswith('state.json.bak'):
                open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
        check('20 rescue: app broken again for the invalid-restore check', not restart())
        s, r = req('POST', '/api/restore', {'format': 'standby-backup', 'version': 1, 'state': {}})
        check('20 rescue: invalid backup rejected while broken (400)',
              s == 400, (s, r))
        s, r = req('GET', '/api/state')
        check('20 rescue: still broken after the rejected restore',
              s == 500, (s, r))
        # (b) Reset while broken.
        s, r = req('POST', '/api/state/reset', {})
        check('20 rescue: reset without confirm rejected (400)',
              s == 400, (s, r))
        s, r = req('GET', '/api/state')
        check('20 rescue: still broken after the rejected reset',
              s == 500, (s, r))
        # Plant a pre-migration snapshot + a preserved corrupt file:
        # the reset must remove those too, not just .bak files.
        open(os.path.join(DATA, 'state.json.pre-migration'), 'w').write('{}\n')
        open(os.path.join(DATA, 'state.json.corrupt.2026-01-01T00-00-00-000Z'), 'w').write('GARBAGE\n')
        # Plant a stale receiver check-in record: the reset must
        # drop it too, or the next state read would resurrect the
        # pre-reset check-in time into the fresh state.
        json.dump({'lastCheckinAt': '2026-11-17T21:48:49.883Z', 'keyId': 'key_test'},
                  open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'))
        s, r = req('POST', '/api/state/reset', {'confirm': True})
        check('20 rescue: reset with confirm succeeds (200)',
              s == 200 and r.get('ok') is True, (s, r))
        s, st = req('GET', '/api/state')
        check('20 rescue: fresh default state after reset (version 7, no txs)',
              s == 200 and st.get('version') == 7 and st.get('bitcoin', {}).get('txs') == [],
              (s, st.get('version') if s == 200 else st))
        check('20 rescue: no state backup files remain after reset',
              not any(f.startswith('state.json.bak') or f.startswith('state.json.corrupt')
                      or f == 'state.json.pre-migration' for f in data_files()),
              data_files())
        check('20 rescue: state.json exists again after reset',
              os.path.exists(os.path.join(DATA, 'state.json')))
        check('20 rescue: receiver keys cleared by the reset',
              json.load(open(os.path.join(CHECKIN_DIR, 'keys.json'))).get('keys') == [])
        check('20 rescue: warnings cleared by the reset',
              s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
        check('20 rescue: receiver last.json dropped by the reset',
              not os.path.exists(os.path.join(CHECKIN_DIR, 'last.json')))
        s, st = req('GET', '/api/state')
        check('20 rescue: no resurrected check-in clock after reset',
              s == 200 and st.get('checkin', {}).get('lastCheckinAt') is None
              and st.get('checkin', {}).get('totalCheckins') == 0,
              (s, st.get('checkin') if s == 200 else st))

        # --- 21. crash recovery, receiver auth, untested endpoints ----
        # The §20 reset restored factory defaults — including the
        # node URLs (real mempool.space / blockstream.info). The
        # sections below check inputs against the nodes, so re-point
        # them at the stubs first; otherwise the real mainnet FINNEY
        # vout 1 (spent) makes every crash-tx check read stale.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18235',
                                            'secondaryApiUrl': 'http://127.0.0.1:18236'})
        check('21 crash: node urls re-pointed at the stubs after the §20 reset', s == 200, (s, r))
        # (a) Broadcast-then-crash: the tx fires and the node accepts
        # it, but the process dies before the broadcasted fact and
        # the release record are written. On restart the trigger no
        # longer holds, so the release check never re-enters the
        # broadcast path — the tx must still never be called stale:
        # the dry run's 'own' anchor (the node reports this tx's own
        # txid as the spender) heals it back to broadcast. Simulate
        # the crash by state surgery: strip broadcasted + release
        # from the tx (triggerState stays — it was saved before the
        # firing loop). The tx spends the stub's OWN_SPEND parent
        # ('ee'*32), so restarting the stubs with
        # STUB_OWN_SPEND_TXID makes the node report our own txid —
        # the stub's outspend answers are otherwise static and never
        # learn a broadcast (the 094 finding-1 pattern).
        crash_hex = v.craft_prev('ee' * 32, 0, 121000)
        crash_txid = v.txid_of(crash_hex)
        s, r = req('POST', '/api/bitcoin/txs',
                   {'txHex': crash_hex, 'label': '21 crash', 'notes': '',
                    'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}},
                    'triggerConfirmed': True})
        check('21 crash: own-spend tx adds with confirmation (201)', s == 201, (s, r))
        crash_id = r['tx']['id'] if s == 201 else None
        check('21 crash: crafted txid is the one the stubs will report', crash_txid == (r.get('tx') or {}).get('txid'), (crash_txid, r))
        s, r, by_id = release_results()
        check('21 crash: release check broadcasts it',
              s == 200 and by_id.get(crash_id, {}).get('action') == 'broadcast', (s, by_id.get(crash_id)))
        t = state_tx(crash_id)
        check('21 crash: broadcasted fact + broadcast release recorded',
              t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast', t)
        # The crash: stop the app, strip the record the crash lost.
        stop(app)
        stj = load_state_file()
        for tx in stj.get('bitcoin', {}).get('txs', []):
            if tx.get('id') == crash_id:
                tx.pop('broadcasted', None)
                tx['release'] = None
                tx['history'] = [e for e in (tx.get('history') or []) if e.get('type') != 'broadcast']
        save_state_file(stj)
        # The trigger no longer holds: stub price below the threshold
        # on both stubs (agreement still holds).
        s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_P)
        check('21 crash: stub price lowered (primary)', s == 200, (s, r))
        s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_S)
        check('21 crash: stub price lowered (secondary)', s == 200, (s, r))
        check('21 crash: app restarts after the crash', restart())
        t = state_tx(crash_id)
        check('21 crash: after restart the tx is unrecorded, not stale',
              t and not t.get('broadcasted') and (t.get('release') or {}).get('status') != 'stale', t)
        s, r, by_id = release_results()
        check('21 crash: release check does not fire it (trigger no longer holds)',
              s == 200 and by_id.get(crash_id, {}).get('action') == 'skipped', (s, by_id.get(crash_id)))
        t = state_tx(crash_id)
        check('21 crash: the skipped release check leaves it un-staled',
              t and (t.get('release') or {}).get('status') != 'stale', t)
        # Point the stubs at our own txid: the OWN_SPEND parent now
        # answers as spent by the crash tx itself. The restart also
        # resets the stub price to its env default, so lower it again
        # first — with the price back at 98,200 the background tick
        # would re-fire the armed tx and heal it through the
        # broadcast path instead of the dry-run anchor.
        restart_stubs(own=crash_txid)
        s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_P)
        check('21 crash: stub price lowered again after the restart (primary)', s == 200, (s, r))
        s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_S)
        check('21 crash: stub price lowered again after the restart (secondary)', s == 200, (s, r))
        s, r = req('POST', '/api/broadcast/test', {})
        check('21 crash: dry run runs (200)', s == 200, (s, r))
        drv = [x for x in (r.get('results') or []) if x.get('id') == crash_id]
        check('21 crash: dry run verdict is broadcast (own anchor)',
              len(drv) == 1 and drv[0].get('verdict') == 'broadcast', drv)
        check('21 crash: the own-spend entry names our own txid',
              len(drv) == 1 and (drv[0].get('own') or [{}])[0].get('spentBy') == crash_txid, drv[0].get('own') if drv else drv)
        t = state_tx(crash_id)
        check('21 crash: dry run heals it to broadcast, never stale',
              t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast', t)
        # Pristine stubs again for the remaining sections.
        restart_stubs()
        s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        check('21 crash: stub price restored (primary)', s == 200, (s, r))
        s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_S)
        check('21 crash: stub price restored (secondary)', s == 200, (s, r))

        # (b) Receiver check-in auth: the receiver is a separate
        # process with its own key file — nothing in the suite ever
        # POSTed to it, so a broken auth path (or a bypass) would
        # have been silent. Create a key, use it, revoke it.
        s, r = req('POST', '/api/checkin-keys', {'label': '21 auth'})
        check('21 auth: key creates (201)', s == 201, (s, r))
        key_plain = r.get('plain') if s == 201 else None
        key_id = (r.get('key') or {}).get('id') if s == 201 else None
        check('21 auth: create returns the plaintext once', bool(key_plain) and bool(key_id), r)
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
        check('21 auth: valid key checks in (200)', s == 200 and r.get('ok') is True, (s, r))
        try:
            _last = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))
        except Exception:
            _last = {}
        check('21 auth: last.json written with the key id',
              _last.get('keyId') == key_id, _last)
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'X-Api-Key': key_plain or ''})
        check('21 auth: X-Api-Key header also works (200)', s == 200 and r.get('ok') is True, (s, r))
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer badkey-123'})
        check('21 auth: unknown key rejected (401)', s == 401, (s, r))
        s, r = req('POST', '/checkin', {}, base=RBASE)
        check('21 auth: missing key rejected (401)', s == 401, (s, r))
        s, r = req('DELETE', '/api/checkin-keys/' + (key_id or 'none'), base=BASE)
        check('21 auth: key revokes (200)', s == 200, (s, r))
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
        check('21 auth: revoked key rejected (401)', s == 401, (s, r))
        s, keys = req('GET', '/api/checkin-keys')
        if isinstance(keys, list) and not keys:
            s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer anything'})
            check('21 auth: no keys configured rejects any key (401)', s == 401, (s, r))

        # (c) Endpoints the suite never called: GET /api/checkins and
        # GET /api/broadcast/log are fetched by every page load but
        # their contents were never asserted; POST
        # /api/bitcoin/txs/preview was never called at all; and the
        # CSRF gate was only covered by the 094 generation's own run.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('21 log: app check-in succeeds (200)', s == 200, (s, r))
        s, r = req('GET', '/api/checkins')
        check('21 log: check-ins list the app check-in',
              isinstance(r, list) and any(e.get('method') == 'app' and isinstance(e.get('ts'), str) for e in r), r)
        s, r = req('GET', '/api/broadcast/log')
        check('21 log: broadcast log lists the dry run',
              isinstance(r, list) and any(e.get('kind') == 'dry-run' for e in r), r)
        s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'hex', 'data': craft(1, 121001)})
        check('21 preview: valid hex previews (200 + txid)',
              s == 200 and r.get('txid') == txid_of(craft(1, 121001)), (s, r))
        s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'hex', 'data': 'zzzz'})
        check('21 preview: bad hex rejected (400)', s == 400, (s, r))
        s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'bogus', 'data': '00'})
        check('21 preview: bad format rejected (400)', s == 400, (s, r))
        s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'psbt', 'data': 'not a psbt'})
        check('21 preview: bad psbt rejected (400)', s == 400, (s, r))
        # CSRF: a state-changing POST without a JSON content type
        # (and no Origin) is rejected 403 — raw urllib, because the
        # suite's req() always sends Content-Type: application/json.
        import urllib.request as _urlreq
        import urllib.error as _urlerr
        try:
            _rq = _urlreq.Request(BASE + '/api/checkin', method='POST', data=b'{}')
            with _urlreq.urlopen(_rq, timeout=20) as _resp:
                _cs = _resp.status
        except _urlerr.HTTPError as _e:
            _cs = _e.code
        check('21 csrf: non-JSON POST rejected (403)', _cs == 403, _cs)
        delete_all_txs()

        # --- 22. evaluate all, broadcast armed only (0.8.4) ------------
        # The tick evaluates EVERY tx — armed or not — and writes
        # fresh triggerState slices for display, but only ARMED txs
        # can enter the firing set. A disarmed tx whose conditions
        # all hold is evaluated, shows Met, and is never broadcast;
        # its 'fired' history event never logs. Re-arming it
        # broadcasts on the next tick. A disarmed check-in tx's
        # clock stays frozen. Stub facts: price 98200, economy fee
        # 1 sat/vB, tip 900000.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('22 tick: cadence set to 10 s', s == 200, (s, r))
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_P)
        check('22 stubs: primary accepting broadcasts', s == 200 and r.get('fail') is False, r)
        s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_S)
        check('22 stubs: secondary accepting broadcasts', s == 200 and r.get('fail') is False, r)
        delete_all_txs()
        # (a) Disarmed price tx: no armed price tx anywhere, yet
        # the tick warms the price cache (refreshPriceIfStale) and
        # writes a fresh due slice.
        s, r = add_tx('22 price disarmed', {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 122000, trigger_confirmed=True)
        check('22 price: disarmed price tx adds with confirmation (201)', s == 201, (s, r))
        pr22 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + pr22, {'enabled': False})
        check('22 price: disarmed at once (200)', s == 200, (s, r))
        time.sleep(12)  # a full tick at the 10 s cadence
        t = state_tx(pr22)
        sl = rule_slice(t)
        check('22 price: the tick wrote a fresh slice for the disarmed tx',
              sl.get('status') == 'due' and sl.get('lastPrice') == 98200, sl)
        check('22 price: live status is due with zero armed price txs',
              t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        # (b) Disarmed fee tx stays due past one cadence.
        s, r = add_tx('22 fee disarmed', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 122002, trigger_confirmed=True)
        check('22 fee: disarmed fee tx adds with confirmation (201)', s == 201, (s, r))
        fm22 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + fm22, {'enabled': False})
        check('22 fee: disarmed at once (200)', s == 200, (s, r))
        time.sleep(12)
        t = state_tx(fm22)
        sl = rule_slice(t)
        check('22 fee: disarmed fee slice still due past one cadence',
              sl.get('status') == 'due' and sl.get('lastEconomyFee') == STUB_ECONOMY_FEE, sl)
        # (c) Disarmed block-height tx: the slice goes live from the stub tip.
        s, r = add_tx('22 blockheight disarmed', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 122004)
        check('22 blockheight: disarmed tx adds (201)', s == 201, (s, r))
        bh22 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + bh22, {'enabled': False})
        check('22 blockheight: disarmed at once (200)', s == 200, (s, r))
        time.sleep(12)
        t = state_tx(bh22)
        sl = rule_slice(t)
        check('22 blockheight: disarmed slice is live (watching, tip 900000)',
              sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP, sl)
        # (d) Disarmed UTXO tx: the slice updates on the tick.
        s, r = add_tx('22 utxo disarmed', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, 122006)
        check('22 utxo: disarmed tx adds (201)', s == 201, (s, r))
        ux22 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + ux22, {'enabled': False})
        check('22 utxo: disarmed at once (200)', s == 200, (s, r))
        time.sleep(12)
        t = state_tx(ux22)
        sl = rule_slice(t)
        check('22 utxo: disarmed slice is live (watching, FINNEY:1 unspent)',
              sl.get('status') == 'watching', sl)
        # (e) Safety: the disarmed price tx's conditions all hold,
        # yet ticks do NOT broadcast it — no broadcast, no release
        # record, no 'fired' history. The manual check lists it as
        # skipped.
        s, c0p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c0s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('22 safety: attempt counts read', isinstance(c0p.get('count'), int) and isinstance(c0s.get('count'), int), (c0p, c0s))
        time.sleep(12)  # another full tick with the disarmed tx due
        s, c1p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        s, c1s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        check('22 safety: the tick made no broadcast attempt for the disarmed due tx',
              c1p.get('count') == c0p.get('count') and c1s.get('count') == c0s.get('count'), (c0p, c1p, c0s, c1s))
        t = state_tx(pr22)
        check('22 safety: the disarmed due tx is still un-broadcast (no release record)',
              t is not None and not t.get('broadcasted') and not t.get('release'), t)
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('22 safety: no fired history event for the disarmed due tx',
              'fired' not in types, types)
        s, r, res = release_results()
        check('22 safety: the manual check lists the disarmed due tx as skipped (evaluated, not broadcast)',
              res.get(pr22, {}).get('action') == 'skipped' and (res.get(pr22, {}).get('reason') or '').startswith('disarmed'), res.get(pr22))
        check('22 safety: the manual check reason names the disarmed firing',
              r.get('reason') == 'trigger fired — transaction disarmed', r.get('reason'))
        # (f) Re-arming the satisfied tx DOES broadcast on the next tick.
        s, r = req('PUT', '/api/bitcoin/txs/' + pr22, {'enabled': True})
        check('22 rearm: the satisfied tx re-arms (200)', s == 200 and r.get('tx', {}).get('enabled') is True, r)
        time.sleep(12)
        t = state_tx(pr22)
        check('22 rearm: the next tick broadcast the re-armed tx',
              t is not None and (t.get('release') or {}).get('status') == 'broadcast', (t or {}).get('release'))
        h = t.get('history') if t else None
        types = [e.get('type') for e in h] if isinstance(h, list) else []
        check('22 rearm: fired logged exactly once, on the re-arm',
              types.count('fired') == 1, types)
        delete_all_txs()
        # (g) Disarmed check-in tx: the clock stays frozen while
        # disarmed — the tick evaluates it but the bar never
        # advances.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 122100), 'label': '22 ck frozen',
                                                'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
        check('22 frozen: the check-in tx adds (201)', s == 201, (s, r))
        ck22 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('22 frozen: check-in lands (clock fresh)', s == 200 and r.get('ok') is True, r)
        # The §21 auth test checked in to the receiver, so its
        # last.json holds a recent timestamp — the tick's
        # mergeExternalCheckin would apply it over any backdate.
        # Remove it so the simulated clock below survives.
        try:
            os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
        except OSError:
            pass
        # Backdate the clock 13 days, then disarm at 13/25.
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=13)
        stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
        save_state_file(stj)
        s, r = req('PUT', '/api/bitcoin/txs/' + ck22, {'enabled': False})
        check('22 frozen: disarmed at 13/25 (200)', s == 200 and r.get('tx', {}).get('enabled') is False, r)
        # Simulate 14 more days passing while disarmed: the clock
        # moves to 27 days back and the open inactive period
        # started 14 days ago — the live offset is the simulated
        # inactive span, so the bar stays at the frozen 13.
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=27, seconds=30)
        stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
        for txj in stj.get('bitcoin', {}).get('txs', []):
            if txj.get('id') == ck22:
                txj['checkinInactiveSince'] = iso_ago(days=14)
        save_state_file(stj)
        time.sleep(12)  # a full tick evaluates the disarmed tx
        s, st = req('GET', '/api/status')
        bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
        check('22 frozen: the bar is STILL 13 of 25 after the tick (frozen)',
              bars.get(ck22, {}).get('daysSince') == 13 and bars.get(ck22, {}).get('windowDays') == 25, bars.get(ck22))
        check('22 frozen: the card stays on-track (a disarmed tx cannot make it release-due)',
              st.get('state') == 'on-track', st.get('state'))
        t = state_tx(ck22)
        sl = rule_slice(t)
        check('22 frozen: the tick evaluated the disarmed check-in rule (slice on-track, not unknown)',
              sl.get('status') == 'on-track', sl)
        check('22 frozen: the disarmed tx is still un-broadcast',
              t is not None and not t.get('broadcasted') and not t.get('release'), t)
        # Restore the default cadence for the remaining sections.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('22 tick: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()
    finally:
        for p in list(v.procs):
            stop(p)

    # --- 11. no server left running -------------------------------------
    for port in (PORT, RECEIVER_PORT, STUB_P, STUB_S, 18190, 18191):
        check('11 no server left running on port %d' % port, port_closed(port))

    print()
    print('FAILURES: %d %s' % (len(v.failures), v.failures if v.failures else '(none)'))
    return 1 if v.failures else 0


if __name__ == '__main__':
    sys.exit(main())
