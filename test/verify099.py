#!/usr/bin/env python3
"""Standby 0.8.5 local verification: block-height, set-date, and
fee-market triggers.

Boots the branch-0.8.5 app (port 3438), the check-in receiver
(3439), and two mempool stubs — primary 18235 and secondary 18236
(both fixed: tip height 900000, economy fee 1 sat/vB, price 98200)
— and checks the 0.8.1 trigger work:

  1. health reports version 0.8.10.
  2. Block-height trigger: validation at add (bad heights rejected,
     good ones accepted), checkTriggerNow (a height already reached
     fires + warns, a future height watches), evaluation via the
     manual release check (an already-reached height broadcasts, a
     future one does not), and the full tick (an armed block-height
     tx fires on the full tick).
  2c. Block-height: NO latch (0.8.4): the rule is judged fresh
     every evaluation — a reorg below the target un-fires it
     again, for the check endpoint, for a disarmed tx's tick
     slices, and for an AND set; editing the target starts
     fresh; a disarmed due tx still never broadcasts, and
     re-arming it past the target broadcasts.
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
  6. Grace holds the new types too (0.8.8): an active grace period pauses
     block-height, set-date, and fee-market txs like price/UTXO —
     they are held, then fire once the grace is resumed. A
     check-in tx is held by the same grace (0.8.8 unification):
     held while the grace is active, then evaluates normally
     once it is resumed.
  6b. Grace on/off toggle (0.8.8): graceEnabled false means no grace
      at all — an offline gap past the threshold sets none, and due
      triggers fire normally. A stored duration of 0 still means
      off (back-compat), and old state with duration 0 and no flag
      loads as graceEnabled false; turning the toggle back on
      restores the grace. 2 is not an offered duration (400), and
      a non-boolean graceEnabled is a 400.
  6c. Grace unification (0.8.8): a past-due check-in rule is held
      by the grace (no separate offline-gap hold — heldUntil is
      gone: a stored heldUntil loads dropped, and a backup
      carrying one restores without a 400); once the grace
      expires or is resumed the check-in rule evaluates and
      fires; with the toggle off a past-due check-in fires on
      schedule, with no grace at all.
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
      ignored by OR; grace holds every non-check-in rule in a
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
  23. No block-height latch (0.8.4): covered by 2c above — the
      latch is gone from the evaluator, the gate, and the
      check endpoint, and no stored heightReachedFor is
      honored anywhere.
  24. Fee trigger: 5-minute node fee cache (0.8.5): two fee-rule
      evaluations inside one 5-minute window cost ONE stub fee
      fetch, from the primary only.
  25. UTXO shared outpoint cache + /outspends batching (0.8.6):
      repeated checks of the same outpoint cost one request per
      cadence window; several watched outputs of one funding tx
      cost one batch request; a 404 is never cached — a spend
      that appears after the parent was unknown is detected on
      the next evaluation; a confirmed-spend UTXO rule reuses
      the shared per-tick tip cache. (0.8.10) Every lookup tries
      the batch first now (generic outspend negotiation), so a
      lone watched output costs one batch request, not one
      singular one — the count per outpoint is unchanged, only
      the route moved; §37 proves the negotiation itself.
  26. Batch cache consult + in-flight dedup (0.8.6 fold-in):
      a batch lookup whose watched outputs are all fresh in the
      per-outpoint cache costs zero requests; two simultaneous
      lookups of one outpoint cost one request (0.8.10: one batch
      request, since every lookup tries the batch first); two
      simultaneous batch lookups cost one request (module-level
      check — the app's single-flight lock means two batch
      fetches can never overlap through the HTTP API); a failed
      request does not poison later lookups — the retry fetches
      fresh and can succeed.
  27. Shared trigger sets (0.8.7): one label, one arm/disarm,
      one rule set driving several transactions — the set's
      triggers are evaluated ONCE per tick (shared across
      members), and on fire ALL attached members broadcast
      through the existing per-tx path; a disarmed set is
      evaluated but never broadcasts; a stale member is skipped
      (its subcard carries a 'stale' pill) and the set keeps
      firing for its non-stale members — only when EVERY member
      is stale does the set archive; deleting a set returns its
      txs to standalone; a pre-set state file loads with sets [].
  28. Not-found broadcast verdicts (0.8.7.1): the confirmation
     refresh runs one outspend check per missing tx — a
     spent-confirmed input records the tx stale (with the
     spending txid and block height, logged once), an
     unconfirmed spend records a conflict, and a clean check
     clears a conflict; an already-stale tx is never re-checked.
  29. Archived broadcast counts are derived (0.8.7.2): past 6
     confirmations the endpoint returns tip - blockHeight + 1
     from the shared per-tick tip cache instead of the frozen
     stored snapshot — the count follows the tip, the stored
     snapshot is never overwritten, and with no tip available
     the stored count is returned.
  30. Staged freshness on the hourly tick (0.8.7.4): the hourly
     refresh re-checks every live staged tx's inputs — a
     confirmed spend marks it stale (release record kind
     'release', one 'stale' history event, a note on the set's
     shared history for a member, and the set stays live for
     its non-stale members), an unconfirmed spend changes
     nothing, and an already-stale tx is never re-checked
     (the stub outspend counters prove zero requests on a
     second hourly tick with no live staged txs left).
  32. Audit fixes 1/3/4 (0.8.10): a malformed request target gets a
      400 and the process keeps serving (app server and receiver);
      security headers (X-Frame-Options, nosniff, CSP) on the page,
      the API, and the receiver; the load-failure notice renders
      its message as text, never as HTML (the DOM half of fix 4
      lives in dom_check099_error.js).
  33. Audit fix 2 + fsync (0.8.10): the Host allowlist — a foreign
      Host gets a 421 on both servers, IP literals / localhost /
      *.local / the machine's hostname pass, STANDBY_ALLOWED_HOSTS
      adds names, and a spoofed X-Forwarded-Host no longer
      bypasses the CSRF gate; fsync durability — a save
      round-trips through state.json with no .tmp left behind,
      and the receiver's last.json does the same. (True power-loss
      durability cannot be unit-tested; the suite verifies the
      write path, not the crash guarantee.)
  34. Skip-save + heartbeat (0.8.10): quiet ticks leave state.json
      byte-identical with its mtime untouched (and the heartbeat
      unrewritten inside its 5-minute throttle); a grace activation
      still writes; the heartbeat advances across a restart and
      the served lastOnlineAt is the merged heartbeat value; a
      SIGTERM flush lands the heartbeat and exits 0; a missing or
      corrupt heartbeat falls back to state.lastOnlineAt (checked
      directly against lib/store.js — the running server rewrites
      the heartbeat on its first tick, so a live test could not
      observe the fallback).
  35. 0.8.10 follow-ups: a future-dated heartbeat is ignored and
      the merged lastOnlineAt is capped at now + 5 minutes, so a
      grace still activates after a real outage (a live restart
      plus direct node checks, including the documented residual
      that both stamps future together still cap and activate no
      grace); the heartbeat throttle treats a backward clock jump
      as expired; hostnames with a trailing dot pass the
      allowlist and a bare "." still gets a 421; the
      check-in/broadcast JSONL logs round-trip durably with no
      .tmp left behind.
  36. 0.8.10 audit fix: an uncaught exception
      terminates the process (uncaughtExceptionMonitor) on both
      servers — a scratch server hit with the test-only throw
      hook exits nonzero with the log line recorded.
  37. Generic outspend negotiation (0.8.10): the mempool client
      tries the batch outspend shape first and falls back to the
      singular shape when a node does not serve the batch, and
      remembers per node which shape worked — so it works with
      any implementation (batch-only, singular-only, both,
      neither) without hard-coding any inventory. Proved with
      the stub's outspend-mode hook: (a) a batch-only node
      answers a lone-output lookup via the batch, zero singular;
      (b) a singular-only node answers via the singular, and the
      second lookup goes singular-first (no second batch call);
      (c) a node serving neither reads unknown, never fires;
      (d) the rule evaluation's batch path falls through to the
      singular when both nodes are singular-only; (e) a 500 on
      the batch still throws (no fallback for server errors).
Ports: app 3438, receiver 3439, stubs 18235/18236 — no collision
with the 095 suite (app 3388, receiver 3389, stubs 18175/18176) or
the 096 suite (app 3398, receiver 3399, stubs 18185/18186).
Reuses the shared test helpers (test/helpers.py) and never touches the 095 files or the main app/ copy.
"""
import base64
import copy
import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers as v

check = v.check


def req(method, path, body=None, base=None, timeout=20, headers=None):
    return v.req(method, path, body, base=base or BASE, timeout=timeout, headers=headers)


# The expected security-header policy (0.8.10, fix 3) — kept in sync
# with the CSP constant in branch-0810-fixes/lib/http.js. Asserted
# exactly below: a drifted policy is a real regression, not a
# cosmetic one.
CSP_0810 = ("default-src 'self'; script-src 'self'; style-src 'self' "
            "'unsafe-inline'; img-src 'self'; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'self'")


def raw_get(path, base):
    # Sends the request line verbatim (no client-side URL
    # normalization) and returns (status, body bytes) — so a
    # malformed target like // [ reaches the server exactly as typed.
    u = urllib.parse.urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=5)
    conn.putrequest('GET', path)
    conn.putheader('Host', '%s:%d' % (u.hostname, u.port))
    conn.endheaders()
    r = conn.getresponse()
    return r.status, r.read()


def raw_req(method, path, base, host=None, headers=None, body=None):
    # Like raw_get, but the Host header is caller-controlled (or
    # omitted) and extra headers / a body can be sent — for the
    # Host-allowlist checks, where urllib would always send its own
    # Host. Returns (status, body bytes).
    u = urllib.parse.urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=5)
    conn.putrequest(method, path, skip_host=True)
    if host is not None:
        conn.putheader('Host', host)
    for k, vv in (headers or {}).items():
        conn.putheader(k, vv)
    if body is not None:
        conn.putheader('Content-Length', str(len(body)))
    conn.endheaders(body)
    r = conn.getresponse()
    return r.status, r.read()


def raw_socket_status(request_lines, base):
    # A bare socket: the only way to send a request with no Host
    # header at all. (http.client always sends one unless told not
    # to — and Node rejects a Host-less HTTP/1.1 request at the
    # parser, before the handler ever runs — so the request must
    # be HTTP/1.0, where Host is optional.) Returns the status int.
    u = urllib.parse.urlparse(base)
    s = socket.create_connection((u.hostname, u.port), timeout=5)
    try:
        s.sendall(request_lines)
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        return int(data.split(b' ')[1])
    finally:
        s.close()


def resp_headers(method, path, base):
    # (status, {lower-cased header name: value}) for one request —
    # v.req returns the parsed body only, and the header checks
    # below need the raw response headers.
    r = urllib.request.Request(base + path, method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, {k.lower(): vv for k, vv in resp.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): vv for k, vv in e.headers.items()}


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
DATA = '/tmp/standby-test099'
CHECKIN_DIR = '/tmp/standby-test099-checkin'
PORT = 3438
BASE = 'http://127.0.0.1:%d' % PORT
RECEIVER_PORT = 3439
RBASE = 'http://127.0.0.1:%d' % RECEIVER_PORT
STUB_P = 18235
STUB_S = 18236
STUB_BASE_P = 'http://127.0.0.1:%d' % STUB_P
STUB_BASE_S = 'http://127.0.0.1:%d' % STUB_S
APP_ENV = {'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR,
           'SLIPSTREAM_API_URL': STUB_BASE_P,
           'PRICE_API_URL': STUB_BASE_P}
# (0.8.11, secure defaults) Profile dimension: the suites run twice —
# default profile (no STANDBY_BIND, no STANDBY_ALLOWED_HOSTS: the code
# defaults, loopback bind) and the Umbrel profile (STANDBY_BIND=0.0.0.0
# plus STANDBY_ALLOWED_HOSTS set, the ${APP_DOMAIN} equivalent).
# The harness reads STANDBY_TEST_PROFILE from its own environment;
# CI invokes each suite once per profile (sequential runs — the ports
# are hardcoded per suite). The receiver spawn below uses the same
# profile vars, so both servers run the profile.
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    APP_ENV['STANDBY_BIND'] = '0.0.0.0'
    APP_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
RECEIVER_ENV = {'PORT': str(RECEIVER_PORT), 'CHECKIN_DIR': CHECKIN_DIR}
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    RECEIVER_ENV['STANDBY_BIND'] = '0.0.0.0'
    RECEIVER_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
LOG = '/tmp/standby-test099-proc.log'

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
    # (0.8.10, skip-save) A test-written state.json defines the
    # world — including a backdated lastOnlineAt for a grace test.
    # The heartbeat file is a runtime cache that loadState merges
    # over the state's own stamp, so a fresh heartbeat left over
    # from the running app would silently override the seeded
    # clock (the same reason §22 removes the receiver's last.json
    # before simulating a clock). Drop it whenever state is
    # seeded; the next tick rewrites it.
    try:
        os.remove(os.path.join(DATA, 'heartbeat.json'))
    except OSError:
        pass


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


def wait_until(cond, deadline=12, interval=0.5):
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


def wait_slice(tx_id, want, deadline=12, interval=0.5, i=0):
    """Poll until the tx's rule slice matches every key/value in
    want (e.g. {'status': 'due', 'lastTipHeight': STUB_TIP}) —
    the tick's observable effect, replacing a fixed 'wait a tick'
    sleep. Same deadline as the sleep it replaces."""
    def cond():
        t = state_tx(tx_id)
        if t is None:
            return False
        sl = rule_slice(t, i)
        return all(sl.get(k) == v for k, v in want.items())
    return wait_until(cond, deadline, interval)


def wait_last_eval(tx_id, before, deadline=12, interval=0.5, i=0):
    """Poll until the tx's rule slice carries a lastEvalAt newer
    than `before` (an ISO string, or None) — one observed tick,
    which is exactly the evidence a fixed sleep was buying for a
    negative check ('did NOT broadcast')."""
    def cond():
        t = state_tx(tx_id)
        if t is None:
            return False
        cur = rule_slice(t, i).get('lastEvalAt')
        return isinstance(cur, str) and cur != before
    return wait_until(cond, deadline, interval)


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

    def restart(before_start=None):
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
        ticks finished. Call BEFORE seeding any firing state.
        `before_start`, when given, runs after the old app stops
        and before the new one starts — for seeding state that must
        be on disk before boot (a backdated clock, an active grace)."""
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
        if before_start is not None:
            before_start()
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
        # Poll for the stubs instead of a fixed sleep (same parallel-
        # startup race as main(): a slow stub + an immediate probe
        # crashes on Connection refused).
        wait_up(STUB_BASE_P, path='/api/v3/simple/price')
        wait_up(STUB_BASE_S, path='/api/v3/simple/price')

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
        # Point the node endpoints at the stubs (like verify095):
        # getTipHeight and the outspend checks must read the stub's
        # fixed tip (900000), not the live chain.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S})
        check('0 node endpoints point at the stubs',
              s == 200 and r.get('primaryApiUrl') == STUB_BASE_P and r.get('secondaryApiUrl') == STUB_BASE_S, r)

        # --- 1. health + version ----------------------------------------
        s, h = req('GET', '/api/health')
        check('1 health reports version 0.8.13', h.get('version') == '0.8.13', h)

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

        # --- 2c. block-height: NO latch (0.8.4) -------------------------
        # The one-way latch is gone: the rule is judged fresh every
        # evaluation, like every other rule. A reorg that drops the
        # tip below the target un-fires it again.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('2c tick: cadence set to 10 s', s == 200, (s, r))
        # (a) The check endpoint judges the CURRENT tip: due above
        # the target, watching again after a simulated reorg. The
        # check reads the per-tick tip cache (TTL = the 10 s cadence),
        # so each stub-tip move waits the cache out first.
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
        check('2c no-latch check: tip above target fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
        # The check endpoint reads the per-tick tip cache (TTL =
        # the cadence) — clear it so the check below reads the new
        # stub tip at once, instead of waiting 11 s for the cache
        # to expire.
        check('2c tip cache cleared so the check reads the new tip', clear_caches())
        check('2c primary stub tip dropped to 700000', s == 200 and r.get('height') == STUB_TIP - 200000, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
        check('2c no-latch check: reorged tip no longer fires', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        # Clear the tip cache so the next tick fetches the restored
        # tip instead of writing the stale cached one.
        check('2c tip cache cleared so the next tick fetches the restored tip', clear_caches())
        check('2c primary stub tip restored to 900000', s == 200 and r.get('height') == STUB_TIP, r)
        # (b) The tick writes fresh slices for a disarmed tx: due
        # while the tip is past the target, watching after the reorg.
        s, r = add_tx('BH nolatch', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 110108, trigger_confirmed=True)
        check('2c no-latch add: past height accepted with triggerConfirmed (201)', s == 201, (s, r))
        bh_nl = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'enabled': False})
        check('2c no-latch: disarmed at once (200)', s == 200, (s, r))
        wait_slice(bh_nl, {'status': 'due', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
        t = state_tx(bh_nl)
        sl = rule_slice(t)
        check('2c no-latch slice: disarmed tx is due with the tip past the target',
              sl.get('status') == 'due' and sl.get('lastTipHeight') == STUB_TIP, sl)
        check('2c no-latch status: live status is due (no latch needed)',
              t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
        check('2c primary stub tip dropped to 700000 (again)', s == 200 and r.get('height') == STUB_TIP - 200000, r)
        # Clear the tip cache so the next tick fetches the dropped
        # tip instead of the cached one.
        check('2c tip cache cleared so the next tick fetches the dropped tip', clear_caches())
        wait_slice(bh_nl, {'status': 'watching', 'lastTipHeight': STUB_TIP - 200000})  # one full tick at the 10 s cadence
        t = state_tx(bh_nl)
        sl = rule_slice(t)
        check('2c no-latch slice: the reorg un-fires it (watching, tip 700000)',
              sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP - 200000, sl)
        check('2c no-latch status: live status is watching after the reorg',
              t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        # The check endpoint reads the per-tick tip cache — clear
        # it so the check below reads the new stub tip at once.
        check('2c tip cache cleared so the check reads the new tip (again)', clear_caches())
        check('2c primary stub tip restored to 900000 (again)', s == 200 and r.get('height') == STUB_TIP, r)
        # (c) An AND set [blockheight, price] stops firing when the
        # tip drops: the height rule is judged fresh, so the set
        # cannot fire on a stale latch.
        and_bh = {'op': 'AND', 'rules': [{'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}},
                                       {'type': 'price', 'params': {'op': '>=', 'value': 90000}}]}
        s, r = req('POST', '/api/triggers/check', {'trigger': and_bh})
        check('2c no-latch AND check: height reached + price holding fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
        # The check endpoint reads the per-tick tip cache — clear
        # it so the check below reads the new stub tip at once.
        check('2c tip cache cleared so the check reads the new tip (AND)', clear_caches())
        check('2c primary stub tip dropped to 700000 (AND)', s == 200 and r.get('height') == STUB_TIP - 200000, r)
        s, r = req('POST', '/api/triggers/check', {'trigger': and_bh})
        check('2c no-latch AND check: reorged height un-fires the set', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        # Clear the tip cache so the next tick fetches the restored
        # tip instead of writing the stale cached one.
        check('2c tip cache cleared so the next tick fetches the restored tip (AND)', clear_caches())
        check('2c primary stub tip restored to 900000 (AND)', s == 200 and r.get('height') == STUB_TIP, r)
        # (d) Editing the target starts fresh: the edited rule is
        # judged against the NEW target, with no memory of the old one.
        s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}})
        check('2c no-latch edit: retarget above the tip saves (200)', s == 200, (s, r))
        wait_slice(bh_nl, {'status': 'watching', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
        t = state_tx(bh_nl)
        sl = rule_slice(t)
        check('2c no-latch edit: retargeted rule is watching (tip 900000 of 950000)',
              sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP, sl)
        s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 'triggerConfirmed': True})
        check('2c no-latch edit: retarget back below the tip saves with confirmation (200)', s == 200, (s, r))
        wait_slice(bh_nl, {'status': 'due', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
        t = state_tx(bh_nl)
        sl = rule_slice(t)
        check('2c no-latch edit: retargeted rule is due again (tip 900000 of 800000)',
              sl.get('status') == 'due' and sl.get('lastTipHeight') == STUB_TIP, sl)
        # (e) Safety: the disarmed tx whose target is reached still
        # does NOT broadcast; re-arming it after the tip is still
        # past the target DOES broadcast on the next manual check.
        s, r, res = release_results()
        check('2c no-latch safety: manual check lists the disarmed due tx as skipped',
              res.get(bh_nl, {}).get('action') == 'skipped', res.get(bh_nl))
        t = state_tx(bh_nl)
        check('2c no-latch safety: the disarmed due tx is still un-broadcast',
              t is not None and not t.get('broadcasted') and not t.get('release'), t)
        s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'enabled': True})
        check('2c no-latch rearm: the tx re-arms (200)', s == 200 and r.get('tx', {}).get('enabled') is True, r)
        s, r, res = release_results()
        check('2c no-latch rearm: re-armed tx broadcasts with the tip past the target',
              s == 200 and res.get(bh_nl, {}).get('action') == 'broadcast', res.get(bh_nl))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('2c tick: cadence restored to 60 s', s == 200, (s, r))
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
        # via POST /__test__/fees. The node fee cache (TTL = 5
        # minutes, 0.8.5) does NOT refresh on its own within the
        # section — each fee change is followed by a restart,
        # which clears the in-memory cache. There is NO agreement
        # check: the primary node's fee is the one that counts —
        # the secondary is only a fallback if the primary is down.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('4c two-node fees: cadence set to 10 s', s == 200, (s, r))
        # Dual, close: primary 5, secondary 4.5. BOTH directions
        # use the primary (5) — the secondary's lower reading does
        # not fire a 'below' rule and does not hold back an 'above'.
        s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_P)
        check('4c two-node fees: primary stub fee set to 5', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 4.5}, base=STUB_BASE_S)
        check('4c two-node fees: secondary stub fee set to 4.5', s == 200, (s, r))
        check('4c two-node fees: caches cleared for a cold fee cache (fees 5/4.5)', clear_caches())
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
        check('4c two-node fees: caches cleared for a cold fee cache (fee 10)', clear_caches())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
        check("4c two-node fees: far apart, 'below' 5 watches on the primary (10)", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 9, 'direction': 'above'}}})
        check("4c two-node fees: far apart, 'above' 9 fires on the primary (10)", s == 200 and r.get('fire') is True, r)
        # (0.8.5) Primary-first fetch: the secondary is never asked
        # while the primary answers — the stored slice says so.
        # (/api/triggers/check drops the slice, so this reads it
        # off a real tx after a manual release check.)
        s, r = add_tx('FM 4c note', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 110520)
        check("4c two-node fees: far apart, a 'below' 5 fee tx adds (watching on the primary 10)", s == 201, (s, r))
        fm_note = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        t = state_tx(fm_note)
        check("4c two-node fees: far apart, the secondary is not asked — single-primary note",
              t and (t.get('triggerState') or {}).get('feeMode') == 'single'
              and (t.get('triggerState') or {}).get('feeNote') == 'primary only — secondary not needed',
              t.get('triggerState') if t else None)
        delete_all_txs()
        # An implausible primary fee counts as the primary not
        # answering — the secondary is asked, so a valid reading
        # is not lost to bad data.
        s, r = req('POST', '/__test__/fees', {'economyFee': 20000}, base=STUB_BASE_P)
        check('4c two-node fees: primary stub fee set implausible (20000)', s == 200, (s, r))
        check('4c two-node fees: caches cleared for a cold fee cache (implausible fee)', clear_caches())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
        check("4c two-node fees: implausible primary falls back to the secondary (4.5 <= 5 fires)",
              s == 200 and r.get('fire') is True, r)
        s, r = add_tx('FM 4c implausible', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 110522)
        check("4c two-node fees: implausible primary, a 'below' 4 fee tx adds (watching on the secondary 4.5)", s == 201, (s, r))
        fm_impl = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        t = state_tx(fm_impl)
        check('4c two-node fees: implausible-primary fallback note names the secondary',
              t and (t.get('triggerState') or {}).get('feeMode') == 'single'
              and (t.get('triggerState') or {}).get('feeNote') == 'secondary only — primary returned invalid data',
              t.get('triggerState') if t else None)
        delete_all_txs()
        s, r = req('POST', '/__test__/fees', {'economyFee': 10}, base=STUB_BASE_P)
        check('4c two-node fees: primary stub fee back to 10', s == 200, (s, r))
        # One node down: point the PRIMARY at a closed port — the
        # secondary alone is used, with no agreement check. (The
        # changed URL busts the fee cache, so no sleep is needed.)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.7, 'direction': 'below'}}})
        check('4c two-node fees: primary down, secondary alone decides (4.5 <= 4.7 fires)', s == 200 and r.get('fire') is True, r)
        s, r = add_tx('FM 4c down', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 110524)
        check("4c two-node fees: primary down, a 'below' 4 fee tx adds (watching on the secondary 4.5)", s == 201, (s, r))
        fm_down = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        t = state_tx(fm_down)
        check('4c two-node fees: primary down, the note names the fallback',
              t and (t.get('triggerState') or {}).get('feeMode') == 'single'
              and (t.get('triggerState') or {}).get('feeNote') == 'secondary only — primary unreachable',
              t.get('triggerState') if t else None)
        delete_all_txs()
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
        # (Optimization O3) Poll until the full tick has broadcast
        # all three — the tick's observable effect, not a fixed
        # 16 s wait for a 10 s cadence plus the startup tick.
        wait_until(lambda: all(
            ((state_tx(x) or {}).get('release') or {}).get('status') == 'broadcast'
            for x in (ft_bh, ft_sd, ft_fm)), deadline=16)
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

        # --- 6. grace holds the new types too (0.8.8) --------------------
        # Put the app into an active grace (offline 10 days, duration
        # 7 days): block-height, set-date, and fee-market txs that
        # are already satisfied must be HELD by the grace, like
        # price/UTXO — then fire once the grace is resumed. A
        # check-in tx is held by the same grace (0.8.8
        # unification): held while the grace is active, then it
        # evaluates normally once resumed — its clock is fresh
        # here, so it stays on-track instead of broadcasting.
        # The check-in first makes the clock fresh, so adding the
        # check-in tx does not restart it (danger-zone reset).
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6 grace: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
        save_state_file(stj)
        check('6 grace: app restarted with an active grace', restart())
        s, st = req('GET', '/api/state')
        check('6 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r = add_tx('G blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 1000}}, 110700, trigger_confirmed=True)
        g_bh = r['tx']['id'] if s == 201 else None
        s, r = add_tx('G setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110702, trigger_confirmed=True)
        g_sd = r['tx']['id'] if s == 201 else None
        s, r = add_tx('G feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110704, trigger_confirmed=True)
        g_fm = r['tx']['id'] if s == 201 else None
        s, r = add_tx('G checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110706)
        g_ck = r['tx']['id'] if s == 201 else None
        check('6 grace: four txs added (block-height, set-date, fee-market, check-in)', g_bh and g_sd and g_fm and g_ck, (g_bh, g_sd, g_fm, g_ck))
        s, r, res = release_results()
        for gid, name in ((g_bh, 'block-height'), (g_sd, 'set-date'), (g_fm, 'fee-market'), (g_ck, 'check-in')):
            check('6 grace: %s tx is held during the grace (skipped, status grace)' % name,
                  s == 200 and res.get(gid, {}).get('action') == 'skipped' and res.get(gid, {}).get('triggerStatus') == 'grace', res.get(gid))
        # Resume: the three satisfied txs fire on the next release
        # check; the check-in tx stays staged (its clock is fresh,
        # so it evaluates on-track, not due).
        s, r = req('POST', '/api/grace/resume', {})
        check('6 grace: resumed', s == 200, (s, r))
        s, r, res = release_results()
        for gid, name in ((g_bh, 'block-height'), (g_sd, 'set-date'), (g_fm, 'fee-market')):
            check('6 grace: %s tx broadcasts once the grace is resumed' % name,
                  s == 200 and res.get(gid, {}).get('action') == 'broadcast', res.get(gid))
        check('6 grace: the check-in tx stays staged after resume (clock fresh, on-track)',
              s == 200 and res.get(g_ck, {}).get('action') == 'skipped' and res.get(g_ck, {}).get('triggerStatus') == 'on-track', res.get(g_ck))
        delete_all_txs()

        # --- 6b. grace on/off toggle (0.8.8) ---------------------------
        # The toggle is the off switch: graceEnabled false means no
        # grace period at all — an offline gap past the threshold
        # sets no grace, and due triggers fire normally. A stored
        # duration of 0 still means off (back-compat with the old
        # dropdown), and old state with duration 0 and no flag loads
        # as graceEnabled false. 2 is not an offered duration (400),
        # and a non-boolean graceEnabled is a 400.
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 2})
        check('6b grace off: duration 2 rejected (400)', s == 400, (s, r))
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 0})
        check('6b grace off: duration 0 saved', s == 200, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        save_state_file(stj)
        check('6b grace off: app restarted after a 10-day gap', restart())
        s, st = req('GET', '/api/state')
        check('6b grace off: no grace is set despite the gap (duration 0)', st.get('grace') is None, st.get('grace'))
        s, r = add_tx('G0 setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110706, trigger_confirmed=True)
        g0_sd = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('6b grace off: set-date tx broadcasts with the grace disabled',
              s == 200 and res.get(g0_sd, {}).get('action') == 'broadcast', res.get(g0_sd))
        delete_all_txs()
        # The toggle itself: a non-boolean is a 400; false means no
        # grace even with a normal duration, and due txs fire.
        s, r = req('PUT', '/api/settings', {'graceEnabled': 'yes'})
        check('6b grace toggle: non-boolean graceEnabled rejected (400)', s == 400, (s, r))
        s, r = req('PUT', '/api/settings', {'graceEnabled': False})
        check('6b grace toggle: graceEnabled false saved', s == 200, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        save_state_file(stj)
        check('6b grace toggle: app restarted after a 10-day gap', restart())
        s, st = req('GET', '/api/state')
        check('6b grace toggle: no grace is set despite the gap (toggle off)', st.get('grace') is None, st.get('grace'))
        s, r = add_tx('G1 setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110708, trigger_confirmed=True)
        g1_sd = r['tx']['id'] if s == 201 else None
        s, r, res = release_results()
        check('6b grace toggle: set-date tx broadcasts with the toggle off',
              s == 200 and res.get(g1_sd, {}).get('action') == 'broadcast', res.get(g1_sd))
        delete_all_txs()
        # Migration: old state with duration 0 and no graceEnabled
        # flag loads as grace off, not on.
        stj = load_state_file()
        stj['settings'].pop('graceEnabled', None)
        stj['settings']['graceDurationDays'] = 0
        save_state_file(stj)
        check('6b grace toggle: app restarted with pre-toggle state', restart())
        s, st = req('GET', '/api/state')
        check('6b grace toggle: pre-toggle duration 0 loads as graceEnabled false',
              st.get('settings', {}).get('graceEnabled') is False, st.get('settings'))
        # Turning the toggle back on restores the grace: a 10-day
        # gap sets one again. Restore the defaults for the
        # remaining sections — grace on, duration 7.
        s, r = req('PUT', '/api/settings', {'graceDurationDays': 7, 'graceEnabled': True})
        check('6b grace toggle: duration 7 + toggle on saved', s == 200, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        save_state_file(stj)
        check('6b grace toggle: app restarted after a 10-day gap', restart())
        s, st = req('GET', '/api/state')
        check('6b grace toggle: grace is set again with the toggle on', st.get('grace', {}).get('active') is True, st.get('grace'))
        # Resume to clear it for the remaining sections (resume also
        # refreshes lastOnlineAt, so no grace re-sets on the next read).
        s, r = req('POST', '/api/grace/resume', {})
        check('6b grace toggle: resumed to clear the grace', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('6b grace toggle: grace cleared after resume', st.get('grace') is None, st.get('grace'))
        delete_all_txs()

        # --- 6c. grace unification: the check-in hold IS the grace (0.8.8) ---
        # No separate offline-gap hold any more (heldUntil is gone):
        # a past-due check-in rule is held by the grace like any
        # other rule — skipped with status grace, nothing
        # broadcasts — and fires once the grace is resumed or
        # expires. With the toggle off there is no grace at all
        # and a past-due check-in fires on schedule. A stored
        # heldUntil loads dropped, and a backup carrying one
        # (even a garbage one) restores without a 400.
        # Past due + grace active: held, nothing broadcasts.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6c unify: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('U checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110710)
        u_ck = r['tx']['id'] if s == 201 else None
        check('6c unify: the past-due check-in tx adds', s == 201, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        save_state_file(stj)
        check('6c unify: app restarted with a 10-day gap and a 40-day-old clock', restart())
        s, st = req('GET', '/api/state')
        check('6c unify: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        check('6c unify: no heldUntil anywhere in the served check-in state',
              'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
        s, r, res = release_results()
        check('6c unify: the past-due check-in tx is held during the grace (skipped, status grace)',
              s == 200 and res.get(u_ck, {}).get('action') == 'skipped' and res.get(u_ck, {}).get('triggerStatus') == 'grace', res.get(u_ck))
        check('6c unify: nothing broadcasted during the grace',
              (state_tx(u_ck) or {}).get('broadcasted') is None, (state_tx(u_ck) or {}).get('broadcasted'))
        # Resume: the past-due check-in fires on the next check.
        s, r = req('POST', '/api/grace/resume', {})
        check('6c unify: resumed', s == 200, (s, r))
        s, r, res = release_results()
        check('6c unify: the past-due check-in tx broadcasts once the grace is resumed',
              s == 200 and res.get(u_ck, {}).get('action') == 'broadcast', res.get(u_ck))
        delete_all_txs()
        # Expiry: a seeded expired grace reads as no grace, and a
        # past-due check-in fires on the startup tick.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6c unify: check-in lands so the clock is fresh for the expired-grace add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('U checkin expired', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110712)
        ux_ck = r['tx']['id'] if s == 201 else None
        check('6c unify: the expired-grace check-in tx adds', s == 201, (s, r))
        stj = load_state_file()
        stj['grace'] = {'graceUntil': iso_ago(hours=1), 'triggeredAt': iso_ago(days=8), 'offlineGapDays': 8}
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        save_state_file(stj)
        check('6c unify: app restarted with an expired grace and a 40-day-old clock', restart())
        s, st = req('GET', '/api/state')
        check('6c unify: an expired grace reads as no grace (grace null)',
              st.get('grace') is None, st.get('grace'))
        check('6c unify: the startup tick fired the past-due check-in tx after expiry',
              ((state_tx(ux_ck) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(ux_ck) or {}).get('release'))
        delete_all_txs()
        # Toggle off: no grace at all — a past-due check-in fires
        # on schedule (the startup tick broadcasts it).
        s, r = req('PUT', '/api/settings', {'graceEnabled': False})
        check('6c unify: toggle off saved', s == 200, (s, r))
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6c unify: check-in lands so the clock is fresh for the toggle-off add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('U checkin off', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110714)
        uo_ck = r['tx']['id'] if s == 201 else None
        check('6c unify: the toggle-off check-in tx adds', s == 201, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        save_state_file(stj)
        check('6c unify: app restarted with the toggle off, a 10-day gap, a 40-day-old clock', restart())
        s, st = req('GET', '/api/state')
        check('6c unify: no grace is set with the toggle off', st.get('grace') is None, st.get('grace'))
        check('6c unify: the startup tick fired the past-due check-in tx with the toggle off',
              ((state_tx(uo_ck) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(uo_ck) or {}).get('release'))
        delete_all_txs()
        s, r = req('PUT', '/api/settings', {'graceEnabled': True})
        check('6c unify: toggle restored to on', s == 200, (s, r))
        # Migration: a stored heldUntil loads dropped — the loaded
        # state carries no heldUntil key at all.
        stj = load_state_file()
        stj['checkin']['heldUntil'] = iso_in(days=12)
        save_state_file(stj)
        check('6c unify: app restarted with a stored heldUntil', restart())
        s, st = req('GET', '/api/state')
        check('6c unify: a stored heldUntil loads dropped (no heldUntil key)',
              'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
        # Backup/restore: a backup carrying a heldUntil — even a
        # garbage one — restores without a 400, and the restored
        # state carries no heldUntil.
        s, bak = req('POST', '/api/backup', {})
        check('6c unify: backup fetched', s == 200 and 'state' in bak, (s, list(bak.keys()) if isinstance(bak, dict) else bak))
        bak['state']['checkin']['heldUntil'] = 'not-a-date'
        s, r = req('POST', '/api/restore', bak)
        check('6c unify: a backup with a garbage heldUntil restores (200, accept-and-drop)', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        check('6c unify: the restored state carries no heldUntil',
              'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
        # Restore a fresh clock for the remaining sections.
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago()
        save_state_file(stj)
        check('6c unify: check-in clock restored (restart)', restart())

        # --- 6e. short-threshold check-in outage protection (0.8.8, audit finding 1) ---
        # The unification (6c) replaced the old heldUntil hold with
        # the flat 7-day offline grace — but the old hold activated
        # on the CHECK-IN clock, not the offline threshold: gap >
        # a quarter of the shortest ARMED check-in threshold AND
        # more than half that threshold since the last check-in.
        # A 1-day check-in rule used to earn protection after a
        # 6-hour outage; the flat threshold alone left it
        # unprotected (a 30-hour outage is under 7 days, so no
        # grace, and a past-due 1-day clock would broadcast on
        # the startup tick). The fix restores the ACTIVATION only:
        # grace now sets when EITHER the flat threshold OR the
        # check-in condition holds. The GRANT stays the unified
        # grace duration (7 days by default) — never the old
        # heldUntil pushout (now + half the threshold). The
        # threshold is measured on the EFFECTIVE rules only:
        # standalone txs plus sets — a set member's parked
        # trigger cannot set it. And a stored unexpired heldUntil
        # translates into an active grace on load instead of
        # being dropped (an expired one is still dropped).
        # NOTE on the 18h case: the audit's worked example showed
        # the PRE-fix behaviour (no grace, due in 6h). After this
        # fix the 18h case DOES activate the grace — 18h is over
        # both a quarter (6h) and a half (12h) of a 1-day
        # threshold, so the old code granted a hold there too.
        # The true no-grace pin is the 5h case below.
        def state_set_e(set_id):
            s2, st2 = req('GET', '/api/state')
            for x in st2.get('bitcoin', {}).get('sets', []):
                if x.get('id') == set_id:
                    return x
            return None
        def delete_all_sets_e():
            s2, st2 = req('GET', '/api/state')
            for x in st2.get('bitcoin', {}).get('sets', []):
                req('DELETE', '/api/bitcoin/sets/' + x['id'], base=BASE)
        # Leg 1 — 30h gap, 1-day threshold: the flat leg cannot
        # fire (30h < 7d), so an active grace proves the
        # check-in leg. Past due (30h > 24h), held, nothing
        # broadcasts — and the grant is 7 days, not 12h.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e short: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E checkin 1d', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111200)
        e1 = r['tx']['id'] if s == 201 else None
        check('6e short: the 1-day check-in tx adds', s == 201, (s, r))
        def seed_e1():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago(hours=30)
            stj['checkin']['lastCheckinAt'] = iso_ago(hours=30)
            save_state_file(stj)
        check('6e short: app restarted with a 30h gap and a 30h-old clock (1-day threshold)', restart(before_start=seed_e1))
        s, st = req('GET', '/api/state')
        check('6e short: the grace is active (check-in leg — the 30h gap is under the 7-day flat threshold)',
              st.get('grace', {}).get('active') is True, st.get('grace'))
        check('6e short: the offline gap reads 1 day (floor of 30h)',
              st.get('grace', {}).get('offlineGapDays') == 1, st.get('grace'))
        gu1 = st.get('grace', {}).get('graceUntil')
        check('6e short: the grace lasts the configured 7 days, not the old 12h pushout',
              gu1 is not None and (datetime.fromisoformat(gu1.replace('Z', '+00:00')) - datetime.now(timezone.utc)).total_seconds() > 6 * 86400,
              gu1)
        s, r, res = release_results()
        check('6e short: the past-due 1-day check-in tx is held during the grace (skipped, status grace)',
              s == 200 and res.get(e1, {}).get('action') == 'skipped' and res.get(e1, {}).get('triggerStatus') == 'grace', res.get(e1))
        check('6e short: nothing broadcasted during the grace',
              (state_tx(e1) or {}).get('broadcasted') is None, (state_tx(e1) or {}).get('broadcasted'))
        delete_all_txs()
        s, r = req('POST', '/api/grace/resume', {})
        check('6e short: resumed', s == 200, (s, r))
        # Leg 2 — 18h gap, 1-day threshold (the audit's corrected
        # example, AFTER the fix): 18h clears both old bars
        # (6h and 12h), so the grace activates and holds the
        # not-yet-due tx (due in 6h) instead of leaving it to
        # fire on schedule.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e 18h: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E checkin 1d 18h', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111202)
        e2 = r['tx']['id'] if s == 201 else None
        check('6e 18h: the 1-day check-in tx adds', s == 201, (s, r))
        def seed_e2():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago(hours=18)
            stj['checkin']['lastCheckinAt'] = iso_ago(hours=18)
            save_state_file(stj)
        check('6e 18h: app restarted with an 18h gap and an 18h-old clock (1-day threshold)', restart(before_start=seed_e2))
        s, st = req('GET', '/api/state')
        check('6e 18h: the grace IS active (18h > 6h and > 12h — the old condition holds)',
              st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r, res = release_results()
        check('6e 18h: the not-yet-due 1-day check-in tx is held during the grace (skipped, status grace)',
              s == 200 and res.get(e2, {}).get('action') == 'skipped' and res.get(e2, {}).get('triggerStatus') == 'grace', res.get(e2))
        check('6e 18h: nothing broadcasted during the grace',
              (state_tx(e2) or {}).get('broadcasted') is None, (state_tx(e2) or {}).get('broadcasted'))
        delete_all_txs()
        s, r = req('POST', '/api/grace/resume', {})
        check('6e 18h: resumed', s == 200, (s, r))
        # Leg 3 — 5h gap, 1-day threshold: the true no-grace pin.
        # 5h is under a quarter of the threshold (6h) and under
        # the flat 7 days, so no grace sets and the tx (due in
        # 19h) stays staged.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e 5h: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E checkin 1d 5h', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111204)
        e3 = r['tx']['id'] if s == 201 else None
        check('6e 5h: the 1-day check-in tx adds', s == 201, (s, r))
        def seed_e3():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago(hours=5)
            stj['checkin']['lastCheckinAt'] = iso_ago(hours=5)
            save_state_file(stj)
        check('6e 5h: app restarted with a 5h gap and a 5h-old clock (1-day threshold)', restart(before_start=seed_e3))
        s, st = req('GET', '/api/state')
        check('6e 5h: NO grace — 5h is under a quarter of the 1-day threshold (6h)',
              st.get('grace') is None, st.get('grace'))
        check('6e 5h: the 1-day check-in tx is still staged (not due for 19h, nothing broadcast)',
              (state_tx(e3) or {}).get('release') is None and (state_tx(e3) or {}).get('broadcasted') is None,
              (state_tx(e3) or {}))
        delete_all_txs()
        # Leg 4 — the threshold is the EFFECTIVE rules only: a
        # member with a parked 1-day check-in trigger, in a set
        # whose own trigger is 2 days. T is 2 days, not 1: a 7h
        # gap with a 13h-old clock sets no grace (7h < 12h =
        # T/4); a parked trigger setting T would have activated
        # it (7h > 6h, 13h > 12h). At 30h/30h the grace sets
        # (30h > 12h and > 24h) and the set is held.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e set: check-in lands so the clock is fresh for the adds', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E set member 1d', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111206)
        m4 = r['tx']['id'] if s == 201 else None
        check('6e set: the member tx adds with its own 1-day check-in trigger', s == 201, (s, r))
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'E set 2d', 'txIds': [m4],
              'trigger': {'type': 'checkin', 'params': {'thresholdDays': 2}}})
        set4 = r.get('set', {}).get('id') if s == 201 else None
        check('6e set: the set creates with a 2-day check-in trigger', s == 201, (s, r))
        def seed_e4a():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago(hours=7)
            stj['checkin']['lastCheckinAt'] = iso_ago(hours=13)
            save_state_file(stj)
        check('6e set: app restarted with a 7h gap and a 13h-old clock (set threshold 2d)', restart(before_start=seed_e4a))
        s, st = req('GET', '/api/state')
        check('6e set: NO grace — T is the set\'s 2 days, not the parked 1 day (7h < 12h = T/4)',
              st.get('grace') is None, st.get('grace'))
        x4a = state_set_e(set4)
        check('6e set: the set reads on-track (13h of 48h), not grace',
              (x4a or {}).get('triggerStatus', {}).get('status') == 'on-track', (x4a or {}).get('triggerStatus'))
        check('6e set: the member tx is still staged (nothing broadcast)',
              (state_tx(m4) or {}).get('release') is None and (state_tx(m4) or {}).get('broadcasted') is None,
              (state_tx(m4) or {}))
        def seed_e4b():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago(hours=30)
            stj['checkin']['lastCheckinAt'] = iso_ago(hours=30)
            save_state_file(stj)
        check('6e set: app restarted with a 30h gap and a 30h-old clock (set threshold 2d)', restart(before_start=seed_e4b))
        s, st = req('GET', '/api/state')
        check('6e set: the grace IS active (30h > 12h = T/4 and > 24h = T/2)',
              st.get('grace', {}).get('active') is True, st.get('grace'))
        s, r, res = release_results()
        check('6e set: the set is held during the grace (skipped, status grace)',
              s == 200 and res.get(set4, {}).get('action') == 'skipped' and res.get(set4, {}).get('triggerStatus') == 'grace', res.get(set4))
        check('6e set: the member tx is still staged (nothing broadcast)',
              (state_tx(m4) or {}).get('release') is None and (state_tx(m4) or {}).get('broadcasted') is None,
              (state_tx(m4) or {}))
        s, r = req('DELETE', '/api/bitcoin/sets/' + set4)
        check('6e set: the set deletes', s == 200, (s, r))
        delete_all_txs()
        s, r = req('POST', '/api/grace/resume', {})
        check('6e set: resumed', s == 200, (s, r))
        # Leg 5 — migration: a stored UNEXPIRED heldUntil
        # translates into an active grace ending at the heldUntil,
        # instead of being dropped. The clock is 40 days stale
        # with a FRESH lastOnlineAt, so no new grace could set —
        # the active grace below can only be the translation.
        # The past-due tx is held, nothing broadcasts.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e mig: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E mig checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111208)
        e5 = r['tx']['id'] if s == 201 else None
        check('6e mig: the 35-day check-in tx adds', s == 201, (s, r))
        held_e5 = iso_in(hours=12)
        def seed_e5():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago()
            stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
            stj['checkin']['heldUntil'] = held_e5
            save_state_file(stj)
        check('6e mig: app restarted with an unexpired heldUntil (+12h) and a 40-day-old clock', restart(before_start=seed_e5))
        s, st = req('GET', '/api/state')
        check('6e mig: a stored heldUntil still loads dropped (no heldUntil key)',
              'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
        gu5 = st.get('grace', {}).get('graceUntil')
        check('6e mig: the unexpired hold translated into an active grace ending at the heldUntil',
              st.get('grace', {}).get('active') is True and gu5 is not None
              and abs((datetime.fromisoformat(gu5.replace('Z', '+00:00')) - datetime.fromisoformat(held_e5.replace('Z', '+00:00'))).total_seconds()) < 1,
              st.get('grace'))
        s, r, res = release_results()
        check('6e mig: the past-due check-in tx is held by the translated grace (skipped, status grace)',
              s == 200 and res.get(e5, {}).get('action') == 'skipped' and res.get(e5, {}).get('triggerStatus') == 'grace', res.get(e5))
        check('6e mig: nothing broadcasted during the translated grace',
              (state_tx(e5) or {}).get('broadcasted') is None, (state_tx(e5) or {}).get('broadcasted'))
        delete_all_txs()
        s, r = req('POST', '/api/grace/resume', {})
        check('6e mig: resumed', s == 200, (s, r))
        # Leg 6 — migration: an EXPIRED heldUntil is still
        # dropped, and the past-due tx broadcasts on the startup
        # tick as before (no grace: the gap is fresh, the hold
        # is spent).
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6e mig-exp: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
        s, r = add_tx('E mig-exp checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111210)
        e6 = r['tx']['id'] if s == 201 else None
        check('6e mig-exp: the 35-day check-in tx adds', s == 201, (s, r))
        def seed_e6():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago()
            stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
            stj['checkin']['heldUntil'] = iso_ago(hours=1)
            save_state_file(stj)
        check('6e mig-exp: app restarted with an expired heldUntil and a 40-day-old clock', restart(before_start=seed_e6))
        s, st = req('GET', '/api/state')
        check('6e mig-exp: no grace (the expired hold is dropped, the gap is fresh)',
              st.get('grace') is None, st.get('grace'))
        check('6e mig-exp: the startup tick fired the past-due check-in tx after the expired hold was dropped',
              ((state_tx(e6) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(e6) or {}).get('release'))
        delete_all_txs()
        delete_all_sets_e()
        # Restore a fresh clock for the remaining sections.
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago()
        save_state_file(stj)
        check('6e short: check-in clock restored (restart)', restart())

        # --- 6d. both-numbers grace card: wouldFire (0.8.8) ---
        # The grace card's second number — how many of the held
        # transactions would fire the moment the grace lifts — is
        # served per tx/set as triggerStatus.wouldFire: the raw
        # condition of each rule, judged on the best data
        # available WITHOUT any new network calls (the grace
        # suspends rule evaluation, and the card must not defeat
        # that). Per rule: check-in and set-date read the live
        # clock (exact); price and fee-market read the live caches
        # when warm, else the stored last evaluation; block-height
        # reads the tip cache when warm, else the stored slice;
        # UTXO reads the stored slice ONLY (its checks ARE the
        # rule evaluation, so they go stale during a grace);
        # manual never fires; unknown / not-evaluated never fire.
        # Combined by the set's op (OR: any met; AND: all met).
        # The stub price is pinned to 98200 and the fee to 1
        # sat/vB (earlier sections leave other values behind).
        delete_all_txs()
        check('6d wouldFire: caches cleared cold for a deterministic start', clear_caches())
        s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
        check('6d wouldFire: stub price pinned to 98200', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
        check('6d wouldFire: stub fee pinned to 1 sat/vB', s == 200, (s, r))
        s, r = req('POST', '/__test__/outspend', {'txid': SECOND, 'vout': 0, 'blockHeight': 899999}, base=STUB_BASE_P)
        check('6d wouldFire: SECOND:0 driven to spent (2 confs)', s == 200, (s, r))
        # The spent UTXO tx first, alone and disarmed: a real
        # evaluation writes its slice 'due' without broadcasting
        # (disarmed txs are evaluated for display but never enter
        # the firing set). It stays disarmed — a real 'due' UTXO
        # tx would broadcast before any grace could hold it, which
        # is exactly why the number reads the last evaluation.
        s, r = add_tx('WF UTXO spent', {'type': 'utxo', 'params': {'outpoint': SECOND + ':0'}}, 111000, trigger_confirmed=True)
        check('6d wouldFire: the spent UTXO tx adds (triggerConfirmed)', s == 201, (s, r))
        wf_utxo_spent = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + wf_utxo_spent, {'enabled': False})
        check('6d wouldFire: the spent UTXO tx is disarmed', s == 200, (s, r))
        s, r, res = release_results()
        check('6d wouldFire: the disarmed spent UTXO tx is skipped, not broadcast',
              res.get(wf_utxo_spent, {}).get('action') == 'skipped', res.get(wf_utxo_spent))
        check('6d wouldFire: the evaluation wrote its slice due',
              rule_slice(state_tx(wf_utxo_spent)).get('status') == 'due', rule_slice(state_tx(wf_utxo_spent)))
        # The rest, added with a fresh clock and no grace yet.
        s, r = add_tx('WF check-in due', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111001)
        check('6d wouldFire: the check-in tx adds', s == 201, (s, r))
        wf_ck = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF price holding', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, 111002, trigger_confirmed=True)
        check('6d wouldFire: the holding price tx adds (triggerConfirmed)', s == 201, (s, r))
        wf_price = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF price not holding', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 111003)
        check('6d wouldFire: the not-holding price tx adds', s == 201, (s, r))
        wf_price_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF setdate past', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 111004, trigger_confirmed=True)
        check('6d wouldFire: the past set-date tx adds (triggerConfirmed)', s == 201, (s, r))
        wf_sd = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF setdate future', {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}}, 111005)
        check('6d wouldFire: the future set-date tx adds', s == 201, (s, r))
        wf_sd_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF blockheight reached', {'type': 'blockheight', 'params': {'targetHeight': 899000}}, 111006, trigger_confirmed=True)
        check('6d wouldFire: the reached block-height tx adds (triggerConfirmed)', s == 201, (s, r))
        wf_bh = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF blockheight not reached', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111007)
        check('6d wouldFire: the unreached block-height tx adds', s == 201, (s, r))
        wf_bh_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF UTXO unspent', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}, 111008)
        check('6d wouldFire: the unspent UTXO tx adds', s == 201, (s, r))
        wf_utxo_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF feemarket met', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 111009, trigger_confirmed=True)
        check('6d wouldFire: the met fee-market tx adds (triggerConfirmed)', s == 201, (s, r))
        wf_fm = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF feemarket unmet', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'above'}}, 111010)
        check('6d wouldFire: the unmet fee-market tx adds', s == 201, (s, r))
        wf_fm_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF OR', {'op': 'OR', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}]}, 111011, trigger_confirmed=True)
        check('6d wouldFire: the OR set adds (triggerConfirmed)', s == 201, (s, r))
        wf_or = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF AND unmet', {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}}]}, 111012)
        check('6d wouldFire: the unmet AND set adds', s == 201, (s, r))
        wf_and_no = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF AND met', {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}]}, 111013, trigger_confirmed=True)
        check('6d wouldFire: the met AND set adds (triggerConfirmed)', s == 201, (s, r))
        wf_and = r['tx']['id'] if s == 201 else None
        s, r = add_tx('WF manual', {'type': 'manual', 'params': {}}, 111014)
        check('6d wouldFire: the manual tx adds', s == 201, (s, r))
        wf_manual = r['tx']['id'] if s == 201 else None
        # Backdate the clock 40 days (past the 35-day check-in
        # threshold) and the online stamp 10 days (past the
        # 7-day grace threshold), then restart: the grace sets
        # on the startup tick before any held rule evaluates.
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        save_state_file(stj)
        check('6d wouldFire: app restarted with a 10-day gap and a 40-day-old clock', restart())
        s, st = req('GET', '/api/state')
        check('6d wouldFire: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        def wf(tx_id):
            t = state_tx(tx_id)
            return (t or {}).get('triggerStatus', {}).get('wouldFire')
        # Cache-independent reads first: clock rules and stored
        # slices are exact whether or not a cache is warm.
        check('6d wouldFire: the past-due check-in tx would fire (live clock)', wf(wf_ck) is True, wf(wf_ck))
        check('6d wouldFire: the unspent UTXO tx would not fire (never evaluated)', wf(wf_utxo_no) is False, wf(wf_utxo_no))
        check('6d wouldFire: the spent UTXO tx would fire (stored slice due)', wf(wf_utxo_spent) is True, wf(wf_utxo_spent))
        check('6d wouldFire: the past set-date tx would fire (live clock)', wf(wf_sd) is True, wf(wf_sd))
        check('6d wouldFire: the future set-date tx would not fire', wf(wf_sd_no) is False, wf(wf_sd_no))
        check('6d wouldFire: the not-holding price tx would not fire', wf(wf_price_no) is False, wf(wf_price_no))
        check('6d wouldFire: the unmet fee-market tx would not fire', wf(wf_fm_no) is False, wf(wf_fm_no))
        check('6d wouldFire: the unreached block-height tx would not fire', wf(wf_bh_no) is False, wf(wf_bh_no))
        check('6d wouldFire: the manual tx would never fire', wf(wf_manual) is False, wf(wf_manual))
        check('6d wouldFire: the unmet AND set would not fire (one rule unmet)', wf(wf_and_no) is False, wf(wf_and_no))
        # Cold caches, one snapshot: the holding price, the met
        # fee-market, and the reached block-height txs read false
        # until their caches warm — the card must not claim a
        # condition it has no data for. The OR set already reads
        # true (its set-date rule is clock-exact); the met AND set
        # reads false (its price rule is unreadable cold).
        check('6d wouldFire: caches cleared cold', clear_caches())
        s, st = req('GET', '/api/state')
        cold = {t.get('id'): (t.get('triggerStatus') or {}).get('wouldFire') for t in st.get('bitcoin', {}).get('txs', [])}
        check('6d wouldFire: the holding price tx reads false with a cold price cache', cold.get(wf_price) is False, cold.get(wf_price))
        check('6d wouldFire: the met fee-market tx reads false with a cold fee cache', cold.get(wf_fm) is False, cold.get(wf_fm))
        check('6d wouldFire: the reached block-height tx reads false with a cold tip cache', cold.get(wf_bh) is False, cold.get(wf_bh))
        check('6d wouldFire: the OR set reads true cold (its set-date rule is clock-exact)', cold.get(wf_or) is True, cold.get(wf_or))
        check('6d wouldFire: the met AND set reads false cold (its price rule is unreadable)', cold.get(wf_and) is False, cold.get(wf_and))
        # Warm each cache explicitly via the stateless trigger
        # gate (no state change, no evaluation) and re-read.
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}})
        check('6d wouldFire: the price gate warms the price cache', s == 200 and r.get('fire') is True, (s, r))
        check('6d wouldFire: the holding price tx reads true once the price cache is warm', wf(wf_price) is True, wf(wf_price))
        check('6d wouldFire: the met AND set reads true once its price rule is met', wf(wf_and) is True, wf(wf_and))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
        check('6d wouldFire: the fee gate warms the fee cache', s == 200 and r.get('fire') is True, (s, r))
        check('6d wouldFire: the met fee-market tx reads true once the fee cache is warm', wf(wf_fm) is True, wf(wf_fm))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 899000}}})
        check('6d wouldFire: the block-height gate warms the tip cache', s == 200 and r.get('fire') is True, (s, r))
        check('6d wouldFire: the reached block-height tx reads true once the tip cache is warm', wf(wf_bh) is True, wf(wf_bh))
        # Checking in clears the check-in rule's wouldFire (the
        # clock is fresh again) but not the grace itself.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('6d wouldFire: a check-in lands', s == 200 and r.get('ok') is True, (s, r))
        check('6d wouldFire: the check-in tx reads false once the clock is fresh', wf(wf_ck) is False, wf(wf_ck))
        s, st = req('GET', '/api/state')
        check('6d wouldFire: the grace is still active after the check-in', st.get('grace', {}).get('active') is True, st.get('grace'))
        # A stale 'due' block-height slice still counts when the
        # tip cache is cold (the fallback): seed one on the
        # unreached tx via before_start — on disk before boot,
        # race-free — and restart. The grace holds the rules, so
        # the seeded slice survives the startup tick.
        def seed_bh_due():
            stj2 = load_state_file()
            for t in stj2.get('bitcoin', {}).get('txs', []):
                if t.get('id') == wf_bh_no:
                    t['triggerState'] = {'lastEvalAt': iso_ago(), 'status': 'due', 'reason': 'block 900,000 reached — firing',
                                         'lastPrice': None, 'lastPriceAt': None, 'lastOutspend': None, 'lastError': None,
                                         'lastTipHeight': 900000}
                    break
            save_state_file(stj2)
        check('6d wouldFire: app restarted with a seeded due block-height slice', restart(before_start=seed_bh_due))
        s, st = req('GET', '/api/state')
        check('6d wouldFire: the grace is still active after the restart', st.get('grace', {}).get('active') is True, st.get('grace'))
        check('6d wouldFire: the seeded due slice survives the startup tick',
              rule_slice(state_tx(wf_bh_no)).get('status') == 'due', rule_slice(state_tx(wf_bh_no)))
        check('6d wouldFire: the stale due slice counts with a cold tip cache (fallback)', wf(wf_bh_no) is True, wf(wf_bh_no))
        # Cleanup: resume the grace, drop the txs, clear the stub
        # override, restore a fresh clock for the next sections.
        s, r = req('POST', '/api/grace/resume', {})
        check('6d wouldFire: resumed', s == 200, (s, r))
        delete_all_txs()
        s, r = req('POST', '/__test__/outspend', {'txid': SECOND, 'vout': 0, 'clear': True}, base=STUB_BASE_P)
        check('6d wouldFire: SECOND:0 override cleared', s == 200, (s, r))
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago()
        save_state_file(stj)
        check('6d wouldFire: check-in clock restored (restart)', restart())

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
        s, bak = req('POST', '/api/backup', {})
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
        check('10 nodes: primary is OK with all four checks ready',
              res.get('primary', {}).get('status') == 'ok'
              and res.get('primary', {}).get('checks', {}).get('height', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('fees', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True,
              res.get('primary'))
        check('10 nodes: primary shows the measured values next to each status',
              res.get('primary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
              and res.get('primary', {}).get('checks', {}).get('fees', {}).get('value') == '1 sat/vB'
              and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'Reachable'
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Batch',
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
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False
              and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False,
              res.get('secondary'))
        check('10 nodes: height-only secondary shows the height value and the failure reasons',
              res.get('secondary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
              and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('value') == 'no fee endpoint'
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'answered HTTP 404'
              and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
              res.get('secondary', {}).get('checks'))
        check('10 nodes: height-only secondary detail lists every failing check (multi-failure format)',
              'output lookup:' in res.get('secondary', {}).get('detail', ''),
              res.get('secondary', {}).get('detail'))
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
              and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False
              and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False,
              res.get('secondary'))
        check('10 nodes: Esplora-style output lookup is unavailable (both outspend routes 404)',
              res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
              res.get('secondary', {}).get('checks', {}).get('outputLookup'))
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
              and res.get('secondary', {}).get('ok') is False
              and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('detail') == 'not checked — height failed'
              and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == '—',
              res.get('secondary'))
        check('10 nodes: overall ok stays true with one good node', r.get('ok') is True, r.get('ok'))
        # Restore the stub secondary and stop the height-only server.
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S})
        check('10 nodes: secondary restored to the stub', s == 200, (s, r))
        height_srv.shutdown()
        height_srv.server_close()

        # --- 11. per-node checked stamps (0.8.5) -----------------------
        # The tick asks the primary every time and the secondary
        # only on fallback, so each node row carries its own
        # last-checked time (connection.nodeCheckedAt). A release
        # check with a watching fee tx fetches fees from the
        # primary only: the primary stamp moves, the secondary
        # stamp does not.
        s, st = req('GET', '/api/state')
        conn0 = (st.get('bitcoin', {}) or {}).get('connection') or {}
        stamps0 = conn0.get('nodeCheckedAt') or {}
        check('11 stamps: the stored connection carries per-node stamps',
              isinstance(stamps0, dict) and 'primary' in stamps0 and 'secondary' in stamps0,
              stamps0)
        # A connection test asks both endpoints, so both stamps
        # land on the test time.
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        check('11 stamps: connection test runs for the stamp baseline', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        stamps1 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
        check('11 stamps: after a connection test both stamps are set',
              bool(stamps1.get('primary')) and bool(stamps1.get('secondary')),
              stamps1)
        # Restart for a cold fee cache — and note the restart
        # itself re-tests both nodes (the startup hourly tick
        # runs testNodes at 5 s), so the baseline is re-read
        # after it: both stamps move to the startup test, and
        # only the primary may move after that.
        check('11 stamps: app restarted for a cold fee cache', restart())
        s, st = req('GET', '/api/state')
        stamps1 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
        check('11 stamps: after restart both stamps read the startup test',
              bool(stamps1.get('primary')) and bool(stamps1.get('secondary')),
              stamps1)
        s, r = add_tx('Stamp FM', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 110800)
        check('11 stamps: watching fee tx added', s == 201, (s, r))
        s, r, res = release_results()
        check('11 stamps: release check runs', s == 200, (s, r))
        s, st = req('GET', '/api/state')
        stamps2 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
        check('11 stamps: the release check moves the primary stamp past the test time',
              bool(stamps2.get('primary')) and stamps2.get('primary') > stamps1.get('primary'),
              (stamps1, stamps2))
        check('11 stamps: the secondary stamp does not move on a primary-only check',
              stamps2.get('secondary') == stamps1.get('secondary'),
              (stamps1, stamps2))
        delete_all_txs()

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
        check('12 caches cleared before the custom eval (empty cache)', clear_caches())
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
        check('12 caches cleared before the straddle eval (empty cache)', clear_caches())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
        check('12 custom decides: >= $99,000 fires on the custom $100,000',
              s == 200 and r.get('fire') is True and 'Custom' in str(r.get('reason', '')), r)
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '<=', 'value': 99000}}})
        check('12 custom decides: <= $99,000 watches (Coinbase $98,200 does not decide)',
              s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        # Disagree: CoinGecko $90,000 vs Coinbase $98,200 (8.7% apart).
        s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 90000}, base=STUB_BASE_P)
        check('12 CoinGecko stub set to $90,000', s == 200 and pr.get('coingecko', {}).get('usd') == 90000, pr)
        check('12 caches cleared before the disagree eval (empty cache)', clear_caches())
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
        check('12 caches cleared before the single-source eval (empty cache)', clear_caches())
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
        check('12 caches cleared before the Kraken-shape eval (empty cache)', clear_caches())
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
        check('12 Kraken shape: result.XXBTZUSD.c[0] reads $98,200',
              s == 200 and r.get('fire') is True, r)
        custom_cb = {'id': 'custom', 'url': CB_URL, 'path': 'data.amount'}
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cb, 'source2': 'coinbase'}})
        check('12 Coinbase-shaped custom saves (200)', s == 200, (s, r))
        check('12 caches cleared before the Coinbase-shape eval (empty cache)', clear_caches())
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
        s, bak = req('POST', '/api/backup', {})
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
        # Both 404: unknown, never fires. (0.8.6) The outpoint
        # cache holds the secondary's answer from the failover
        # check above, inside its TTL window — so restart first
        # for a cold cache; this proves the failover logic itself,
        # not the cache. The startup tick evaluates only the
        # manual dry-run tx, so no outspend fetch warms the cache.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
        check('13 secondary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
        check('13 both 404: caches cleared for a cold outpoint cache', clear_caches())
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
        s, bak = req('POST', '/api/backup', {})
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
        # blocks AND and is ignored by OR; grace holds every
        # non-check-in rule in a set; an already-satisfied set blocks
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
        check('17 AND: cadence 10 s for the price-cache TTL', s == 200, (s, r))
        s, r = add_tx('17 AND no latch', and_set, 116102)
        check('17 AND: accepted without confirm (nothing holds yet, 201)', s == 201, (s, r))
        and17 = r['tx']['id'] if s == 201 else None
        # Phase 1: the price crosses ($101,000) while the fee is 1.
        s, pr = req('POST', '/__test__/price', {'usd': 101000}, base=STUB_BASE_P)
        check('17 AND: stub price $101,000', s == 200, pr)
        # (Optimization O3) Clear the caches so the next tick
        # fetches the new $101,000 price at once (the price-cache
        # TTL is the 10 s cadence — no need to wait it out), then
        # poll until a tick has written the due price slice.
        check('17 AND phase 1: caches cleared for a cold price cache', clear_caches())
        wait_slice(and17, {'status': 'due', 'lastPrice': 101000})
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
        check('17 AND phase 2: caches cleared for a cold fee cache (fee 0.4)', clear_caches())
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
        # (Optimization O3) Clear the caches so the next tick
        # fetches the new $101,000 price at once, then poll until
        # the tick broadcasts (both rules hold on the same tick).
        check('17 AND phase 3: caches cleared for a cold price cache', clear_caches())
        wait_until(lambda: ((state_tx(and17) or {}).get('release') or {}).get('status') == 'broadcast', deadline=12)
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
        check('17 unknown: caches cleared to bust the price cache', clear_caches())
        delete_all_txs()

        # 17.4 Grace holds every rule in a set (0.8.8, unified 0.8.8):
        # the OR set does NOT fire on its check-in rule during the
        # grace (check-in rules are held by the same grace as
        # everything else now — the old "never held" exemption is
        # gone), and the AND set cannot fire while its price and
        # set-date rules are held. Both stay staged through the
        # grace, then broadcast once it is resumed — the OR set on
        # both its rules (check-in + price), the AND set on both
        # of its. The grace is seeded directly with a fresh
        # lastOnlineAt, so no new grace re-sets on the read; the
        # check-in rule is past due on a 2-day threshold (last
        # check-in 3 days ago). The backdate lands AFTER the adds:
        # adding a check-in tx while its clock is in the danger
        # zone restarts the clock (resetCheckin, 0.7.22), so the
        # txs go in while the clock is fresh (a check-in first —
        # §16 left it 40 days stale) and the backdate + grace are
        # seeded on disk before the restart (restart's
        # before_start hook). Neither set broadcasts on the
        # startup tick.
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('17 grace: check-in lands so the clock is fresh for the adds', s == 200 and r.get('ok') is True, r)
        or_g = {'op': 'OR', 'rules': [
            {'type': 'checkin', 'params': {'thresholdDays': 2}},
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        ]}
        and_g = {'op': 'AND', 'rules': [
            {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
            {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        ]}
        s, r = add_tx('17 OR grace', or_g, 116108, trigger_confirmed=True)
        check('17 grace: OR set accepted with confirm (201)', s == 201, (s, r))
        org17 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('17 AND grace', and_g, 116110, trigger_confirmed=True)
        check('17 grace: AND set accepted with confirm (201)', s == 201, (s, r))
        andg17 = r['tx']['id'] if s == 201 else None
        def seed_grace_17():
            stj = load_state_file()
            stj['checkin']['lastOnlineAt'] = iso_ago()
            stj['checkin']['lastCheckinAt'] = iso_ago(days=3)
            stj['grace'] = {'graceUntil': iso_in(days=7), 'triggeredAt': iso_ago(), 'offlineGapDays': 10}
            save_state_file(stj)
        check('17 grace: app restarted with an active grace', restart(before_start=seed_grace_17))
        s, st = req('GET', '/api/state')
        check('17 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        org_tx = state_tx(org17)
        check('17 grace: OR still staged after the restart (its check-in rule is held by the grace now)',
              org_tx and org_tx.get('release') is None and not org_tx.get('broadcasted'),
              org_tx and {'release': org_tx.get('release'), 'broadcasted': org_tx.get('broadcasted')})
        and_tx = state_tx(andg17)
        check('17 grace: AND still staged after the restart (its rules are held)',
              and_tx and and_tx.get('release') is None and not and_tx.get('broadcasted'),
              and_tx and {'release': and_tx.get('release'), 'broadcasted': and_tx.get('broadcasted')})
        s, r, res = release_results()
        check('17 grace: OR does NOT fire while its check-in and price rules are held',
              s == 200 and res.get(org17, {}).get('action') == 'skipped' and res.get(org17, {}).get('triggerStatus') == 'grace', res.get(org17))
        check('17 grace: AND does NOT fire while its price and set-date rules are held',
              s == 200 and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
        s, r, res = release_results()
        check('17 grace: a second release check still does not fire either set',
              s == 200 and res.get(org17, {}).get('action') == 'skipped' and res.get(org17, {}).get('triggerStatus') == 'grace'
              and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
        s, r = req('POST', '/api/grace/resume', {})
        check('17 grace: resumed', s == 200, (s, r))
        s, r, res = release_results()
        check('17 grace: OR broadcasts once the grace is resumed (check-in + price)',
              s == 200 and res.get(org17, {}).get('action') == 'broadcast', res.get(org17))
        org_tx = state_tx(org17)
        check('17 grace: OR release names both fired rules (checkin+price)',
              org_tx and (org_tx.get('release') or {}).get('trigger') == 'checkin+price',
              org_tx and org_tx.get('release'))
        check('17 grace: AND broadcasts once the grace is resumed',
              s == 200 and res.get(andg17, {}).get('action') == 'broadcast', res.get(andg17))
        delete_all_txs()
        # Restore a fresh check-in clock for the remaining
        # sections (the OR set's past-due check-in rule above
        # needed lastCheckinAt 3 days back).
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago()
        save_state_file(stj)
        check('17 grace: check-in clock restored (restart)', restart())

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
        # (Optimization O3) Poll until one more tick has evaluated
        # the tx (lastEvalAt advances) — a negative check needs one
        # observed tick, not a fixed 12 s wait.
        before18 = rule_slice(state_tx(bo18)).get('lastEvalAt')
        wait_last_eval(bo18, before18)
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
        # (Optimization O3, extra — not in the proposal) Poll until
        # the startup tick's retry moves lastAttemptAt forward:
        # the observable effect of the startup tick, not a fixed
        # 7 s wait for it.
        wait_until(lambda: ((state_tx(bo18) or {}).get('release') or {}).get('lastAttemptAt', '') > last_attempt3, deadline=7)
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
        # (Optimization O3, extra — not in the proposal) Poll until
        # the startup tick's retry broadcasts: the observable
        # effect, not a fixed 7 s wait for the startup tick.
        wait_until(lambda: ((state_tx(bo18) or {}).get('release') or {}).get('status') == 'broadcast', deadline=7)
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
        # (Optimization O3) Poll until one more tick has evaluated
        # the fee tx (lastEvalAt advances) — a negative check needs
        # one observed tick, not a fixed 12 s wait for a 10 s
        # cadence.
        before19 = rule_slice(state_tx(fm_live)).get('lastEvalAt')
        wait_last_eval(fm_live, before19)
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
        fresh_data = '/tmp/standby-test099-fresh'
        fresh_checkin = '/tmp/standby-test099-fresh-checkin'
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
        s, backup_doc = req('POST', '/api/backup', {})
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
        # (0.8.7.4) The startup tick's freshness refresh (§30)
        # checked the crash tx's input against the PRE-restart
        # stub answers — OWN_SPEND is unspent by default — and
        # cached it; the stub restart above just changed what the
        # node says underneath the running app. Clear the outspend
        # cache so the dry run sees the stub's new own-anchor
        # answer. In production the node never rewrites an
        # outpoint's answer, and a cached answer inside the
        # cadence TTL is the accepted design — this clear is for
        # the stub's answer flip, not a product gap.
        s, r = req('POST', '/api/__test__/clear-caches', {'only': ['outspend']})
        check('21 crash: outspend cache cleared so the dry run sees the stub restart', s == 200, (s, r))
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
        # (Optimization O3) Poll until a full tick has written the
        # fresh due slice for the disarmed tx — the tick's
        # observable effect, not a fixed 12 s wait.
        wait_slice(pr22, {'status': 'due', 'lastPrice': 98200})
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
        # (Optimization O3) Poll until a full tick has written the
        # due fee slice — the tick's observable effect.
        wait_slice(fm22, {'status': 'due', 'lastEconomyFee': STUB_ECONOMY_FEE})
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
        # (Optimization O3) Poll until a full tick has written the
        # live block-height slice — the tick's observable effect.
        wait_slice(bh22, {'status': 'watching', 'lastTipHeight': STUB_TIP})
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
        # (Optimization O3) Poll until a full tick has written the
        # live UTXO slice — the tick's observable effect.
        wait_slice(ux22, {'status': 'watching'})
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
        # (Optimization O3) Poll until one more tick has evaluated
        # the disarmed due tx (lastEvalAt advances) — a negative
        # check needs one observed tick, not a fixed 12 s wait.
        before22e = rule_slice(state_tx(pr22)).get('lastEvalAt')
        wait_last_eval(pr22, before22e)
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
        # (Optimization O3) Poll until the next tick broadcasts the
        # re-armed tx — the tick's observable effect.
        wait_until(lambda: ((state_tx(pr22) or {}).get('release') or {}).get('status') == 'broadcast', deadline=12)
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
        # (Optimization O3) Poll until a full tick has evaluated
        # the disarmed tx (lastEvalAt advances) — the tick's
        # observable effect, not a fixed 12 s wait.
        before22g = rule_slice(state_tx(ck22)).get('lastEvalAt')
        wait_last_eval(ck22, before22g)
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

        # --- 23. archived txs make no network calls; primary-first tip fetch + per-tick tip cache (0.8.5) ---
        # Owner (Nov 20): "Once they are archived with 6 confirmations
        # they shouldn't be pinging." A tx that can no longer
        # broadcast is never evaluated on the tick and is never
        # re-queried once it reaches 6 confirmations — and the
        # block-height tip is fetched once per tick from the primary
        # node, not once per rule from both. The background tick is
        # parked (cadence 3600 s) so only the evaluations this
        # section triggers can move the stub counters.
        def tip_counts():
            _, rp = req('GET', '/__test__/tip-count', base=STUB_BASE_P)
            _, rs = req('GET', '/__test__/tip-count', base=STUB_BASE_S)
            return rp.get('count', -1), rs.get('count', -1)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('23 setup: cadence parked at 3600 s', s == 200, (s, r))
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
        check('23 setup: caches cleared for a cold tip cache', clear_caches())
        FROZEN = iso_ago(hours=2)
        # (a) An archived broadcast tx (>= 6 confs), a stale tx, and
        # a disarmed staged tx. The archived/stale ones are seeded
        # via the state file (a broadcast fact cannot be made
        # through the API) with frozen slices; the disarmed one is
        # a real price tx, so its slice must still refresh.
        s, r = add_tx('Arch BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111300)
        check('23 archived: watching blockheight tx adds', s == 201, (s, r))
        arch23 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('Stale BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111301)
        check('23 stale: watching blockheight tx adds', s == 201, (s, r))
        stale23 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('Dis Price', {'type': 'price', 'params': {'op': '>=', 'value': 150000}}, 111302)
        check('23 disarmed: watching price tx adds', s == 201, (s, r))
        dis23 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + dis23, {'enabled': False})
        check('23 disarmed: the price tx disarms', s == 200, (s, r))
        stj = load_state_file()
        by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
        frozen_slice = {'lastEvalAt': FROZEN, 'status': 'watching', 'reason': 'block 900,000 of 950,000',
                        'lastTipHeight': STUB_TIP, 'lastPrice': None, 'lastPriceAt': None,
                        'lastOutspend': None, 'lastError': None, 'tipMode': 'dual',
                        'tipNote': 'primary 900,000 · secondary 900,000'}
        arch_tx = by_id.get(arch23)
        arch_tx['broadcasted'] = {'txid': arch_tx.get('txid'), 'broadcastedAt': FROZEN, 'method': 'mempool.space',
                                  'confirmations': 7, 'blockHeight': 899993, 'found': True, 'checkedAt': FROZEN}
        arch_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                              'txid': arch_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN}
        arch_tx['triggerState'] = [dict(frozen_slice)]
        stale_tx = by_id.get(stale23)
        stale_tx['release'] = {'status': 'stale', 'kind': 'release', 'trigger': 'blockheight',
                               'txid': stale_tx.get('txid'), 'method': 'mempool.space',
                               'error': 'inputs spent: staged'}
        stale_tx['triggerState'] = [dict(frozen_slice)]
        save_state_file(stj)
        check('23 archived: app restarted with the seeded terminal txs', restart())
        cp0, cs0 = tip_counts()
        dis_before = rule_slice(state_tx(dis23))
        s, r, res = release_results()
        check('23 archived: release check runs', s == 200, (s, r))
        t = state_tx(arch23)
        check('23 archived: the broadcast tx (>= 6 confs) is skipped, already broadcast',
              res.get(arch23, {}).get('action') == 'skipped' and 'already broadcast' in str(res.get(arch23, {}).get('reason', '')), res.get(arch23))
        check('23 archived: its slice is frozen (lastEvalAt and lastTipHeight untouched)',
              rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
        t = state_tx(stale23)
        check('23 stale: the stale tx is skipped',
              res.get(stale23, {}).get('action') == 'skipped' and 'stale' in str(res.get(stale23, {}).get('reason', '')), res.get(stale23))
        check('23 stale: its slice is frozen too',
              rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
        t = state_tx(dis23)
        check('23 disarmed: the disarmed staged tx IS still evaluated (slice refreshed, price read)',
              rule_slice(t).get('lastEvalAt') != dis_before.get('lastEvalAt')
              and rule_slice(t).get('lastPrice') == 98200, rule_slice(t))
        cp1, cs1 = tip_counts()
        check('23 archived: the release check made no tip fetch at all (both stubs quiet)',
              (cp1, cs1) == (cp0, cs0), ((cp0, cs0), (cp1, cs1)))
        # (b) A pending broadcast tx (< 6 confs) still gets its
        # confirmations refreshed hourly, but its rules are not
        # re-evaluated — while the >= 6 tx above is not re-queried
        # even though its last check is hours old.
        s, r = add_tx('Pend BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111303)
        check('23 pending: watching blockheight tx adds', s == 201, (s, r))
        pend23 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
        pend_tx = by_id.get(pend23)
        pend_tx['broadcasted'] = {'txid': pend_tx.get('txid'), 'broadcastedAt': FROZEN, 'method': 'mempool.space',
                                  'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': FROZEN}
        pend_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                              'txid': pend_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN}
        pend_tx['triggerState'] = [dict(frozen_slice)]
        save_state_file(stj)
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('23 pending: the confirmations endpoint runs', s == 200, (s, r))
        t = state_tx(pend23)
        check('23 pending: the < 6 tx IS re-queried (checkedAt moved, stub does not know it)',
              t.get('broadcasted', {}).get('checkedAt') != FROZEN
              and t.get('broadcasted', {}).get('found') is False, t.get('broadcasted'))
        t = state_tx(arch23)
        check('23 archived: the >= 6 tx is NOT re-queried (checkedAt still the old value, 7 confs kept)',
              t.get('broadcasted', {}).get('checkedAt') == FROZEN
              and t.get('broadcasted', {}).get('confirmations') == 7, t.get('broadcasted'))
        cp0, cs0 = tip_counts()
        s, r, res = release_results()
        t = state_tx(pend23)
        check('23 pending: its rules are not re-evaluated (slice frozen)',
              rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
        cp1, cs1 = tip_counts()
        check('23 pending: the release check made no tip fetch for it either',
              (cp1, cs1) == (cp0, cs0), ((cp0, cs0), (cp1, cs1)))
        # (c) Primary-first tip fetch + per-tick cache: two
        # disarmed staged blockheight rules in one release check
        # cost ONE tip fetch, from the primary only. (The
        # secondary is pointed at a closed port first: the cache
        # is keyed by endpoint bases, so the settings change busts
        # it — and a closed-port secondary is never even asked.)
        s, r = add_tx('Tip BH 1', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111304)
        check('23 cache: first watching blockheight tx adds', s == 201, (s, r))
        tip1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('Tip BH 2', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111305)
        check('23 cache: second watching blockheight tx adds', s == 201, (s, r))
        tip2 = r['tx']['id'] if s == 201 else None
        for tid in (tip1, tip2):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('23 cache: both tip txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
        check('23 cache: secondary pointed at a closed port (busts the tip cache)', s == 200, (s, r))
        cp0, cs0 = tip_counts()
        s, r, res = release_results()
        check('23 cache: release check runs', s == 200, (s, r))
        cp1, cs1 = tip_counts()
        check('23 cache: two blockheight rules cost ONE tip fetch, from the primary only',
              (cp1, cs1) == (cp0 + 1, cs0), ((cp0, cs0), (cp1, cs1)))
        for tid in (tip1, tip2):
            t = state_tx(tid)
            check('23 cache: the disarmed blockheight tx IS evaluated (slice refreshed, primary-only note)',
                  rule_slice(t).get('lastTipHeight') == STUB_TIP
                  and rule_slice(t).get('tipMode') == 'single'
                  and rule_slice(t).get('tipNote') == 'primary only — secondary not needed', rule_slice(t))
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S})
        check('23 cache: secondary restored to the stub', s == 200, (s, r))
        # (d) Primary down: the secondary alone decides.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
        check('23 down: primary pointed at a closed port', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 950000}}})
        check('23 down: the secondary alone decides (watching on its 900,000 tip)',
              s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r, res = release_results()
        t = state_tx(tip1)
        check('23 down: the note names the fallback',
              rule_slice(t).get('tipMode') == 'single'
              and rule_slice(t).get('tipNote') == 'secondary only — primary unreachable', rule_slice(t))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P})
        check('23 down: primary restored to the stub', s == 200, (s, r))
        # (e) Primary failing the tip read (500): the secondary
        # alone decides, same as down.
        s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_P)
        check('23 invalid: primary stub fails the tip read (500)', s == 200, (s, r))
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 950000}}})
        check('23 invalid: the secondary alone decides on a 500 primary',
              s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
        s, r, res = release_results()
        t = state_tx(tip1)
        check('23 invalid: the note names the fallback',
              rule_slice(t).get('tipMode') == 'single'
              and rule_slice(t).get('tipNote') == 'secondary only — primary unreachable', rule_slice(t))
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
        check('23 invalid: primary stub tip reads again', s == 200, (s, r))
        # (f) Manual paths are unchanged: a single dry-run still
        # tests an archived tx when asked, and dry-run all runs.
        s, r = req('POST', '/api/broadcast/test', {'id': arch23})
        check('23 manual: a single dry-run still tests the archived tx when asked',
              s == 200 and any(x.get('id') == arch23 for x in r.get('results', [])), (s, r))
        s, r = req('POST', '/api/broadcast/test', {})
        check('23 manual: dry-run all still runs', s == 200, (s, r))
        # Cleanup: settings back to the stubs, cadence back to 60,
        # caches cold (restart) for the sections after this one.
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S,
                                            'checkCadenceSeconds': 60})
        check('23 cleanup: settings and cadence restored', s == 200, (s, r))
        delete_all_txs()
        check('23 cleanup: caches cleared', clear_caches())

        # --- 24. fee trigger: 5-minute node fee cache (0.8.5) --------
        # Owner (Nov 20): one fee fetch per 5 minutes for ALL fee
        # txs combined. The node fee cache TTL is a fixed 5
        # minutes, not the check cadence — two fee-rule evaluations
        # inside one window cost ONE stub fee fetch, from the
        # primary only. The background tick is parked (cadence
        # 3600 s) so only the evaluations this section triggers
        # can move the stub counters. (The verdict's hourly
        # current-fees fetch also hits the primary stub's fees
        # route, but it fired at startup — before the baseline
        # below — and does not repeat within the hour.)
        def fee_counts():
            _, rp = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
            _, rs = req('GET', '/__test__/fee-count', base=STUB_BASE_S)
            return rp.get('count', -1), rs.get('count', -1)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('24 setup: cadence parked at 3600 s', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_P)
        check('24 setup: primary stub fee set to 5', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 4.5}, base=STUB_BASE_S)
        check('24 setup: secondary stub fee set to 4.5', s == 200, (s, r))
        # Two disarmed staged fee txs, both watching at fee 5.
        s, r = add_tx('Fee 24a', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 111400)
        check('24 cache: first watching fee tx adds', s == 201, (s, r))
        fee1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('Fee 24b', {'type': 'feemarket', 'params': {'maxFeeRate': 6, 'direction': 'above'}}, 111401)
        check('24 cache: second watching fee tx adds', s == 201, (s, r))
        fee2 = r['tx']['id'] if s == 201 else None
        for tid in (fee1, fee2):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('24 cache: both fee txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
        # The cache is keyed by endpoint bases, so pointing the
        # secondary at a closed port busts it — the first
        # evaluation below fetches, the second reads the cache.
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
        check('24 cache: secondary pointed at a closed port (busts the fee cache)', s == 200, (s, r))
        fp0, fs0 = fee_counts()
        s, r, res = release_results()
        check('24 cache: release check runs', s == 200, (s, r))
        fp1, fs1 = fee_counts()
        check('24 cache: two fee rules cost ONE fee fetch, from the primary only',
              (fp1, fs1) == (fp0 + 1, fs0), ((fp0, fs0), (fp1, fs1)))
        for tid in (fee1, fee2):
            t = state_tx(tid)
            check('24 cache: the disarmed fee tx IS evaluated (slice refreshed, fee 5, primary-only note)',
                  rule_slice(t).get('lastEconomyFee') == 5
                  and rule_slice(t).get('feeMode') == 'single'
                  and rule_slice(t).get('feeNote') == 'primary only — secondary not needed', rule_slice(t))
        # Restore: secondary back to the stub, both fees back to
        # 1, cadence back to 60.
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S, 'checkCadenceSeconds': 60})
        check('24 cleanup: secondary and cadence restored', s == 200, (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
        check('24 cleanup: stubs restored to fee 1', s == 200, (s, r))
        delete_all_txs()

        # --- 25. UTXO shared outpoint cache + /outspends batching (0.8.6) ---
        # Owner (Nov 20): UTXO triggers should stop being independent
        # API requests — one shared monitoring workload. (a) Repeated
        # checks of the same outpoint cost ONE stub request per
        # cadence window (shared outpoint cache, TTL = cadence).
        # (b) Several watched outputs of one funding tx cost ONE
        # batch /outspends request; (0.8.10) a single watched
        # output now also tries the batch first (generic outspend
        # negotiation) — the count per outpoint is unchanged, only
        # the route moved. (c) A 404 is never cached — a
        # spend that appears after the parent was unknown is
        # detected on the next evaluation. (d) A confirmed-spend
        # UTXO rule reuses the shared per-tick tip cache — no extra
        # tip fetch. The background tick is parked (cadence 3600 s)
        # so only the evaluations this section triggers can move
        # the stub counters. The startup tick (5 s) is the single
        # evaluation each sub-part measures: baseline BEFORE
        # restart(), read counters after it.
        def outspend_counts():
            _, rp = req('GET', '/__test__/outspend-count', base=STUB_BASE_P)
            _, rs = req('GET', '/__test__/outspend-count', base=STUB_BASE_S)
            _, bp = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
            _, bs = req('GET', '/__test__/outspends-count', base=STUB_BASE_S)
            return rp.get('count', -1), rs.get('count', -1), bp.get('count', -1), bs.get('count', -1)
        def tip_counts_25():
            _, rp = req('GET', '/__test__/tip-count', base=STUB_BASE_P)
            _, rs = req('GET', '/__test__/tip-count', base=STUB_BASE_S)
            return rp.get('count', -1), rs.get('count', -1)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('25 setup: cadence parked at 3600 s', s == 200, (s, r))
        # (a) Two rules, one outpoint: the startup tick's evaluation
        # costs ONE batch outspend request, primary only — (0.8.10)
        # every lookup tries the batch first now, so the lone
        # outpoint is answered by the batch, not the singular.
        s, r = add_tx('UTXO 25a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111500)
        check('25 dedup: first same-outpoint tx adds', s == 201, (s, r))
        utxo_a1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('UTXO 25b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111501)
        check('25 dedup: second same-outpoint tx adds', s == 201, (s, r))
        utxo_a2 = r['tx']['id'] if s == 201 else None
        for tid in (utxo_a1, utxo_a2):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('25 dedup: both txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        check('25 dedup: app restarted (cold caches, startup tick is the measured evaluation)', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('25 dedup: two rules on one outpoint cost ONE batch request, primary only, no singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        for tid in (utxo_a1, utxo_a2):
            t = state_tx(tid)
            check('25 dedup: the disarmed tx IS evaluated (slice watching, still unspent)',
                  rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
        # A second evaluation inside the TTL window costs nothing —
        # the cache holds the answer.
        s, r, res = release_results()
        check('25 dedup: release check runs', s == 200, (s, r))
        p2, s2, bp2, bs2 = outspend_counts()
        check('25 dedup: re-evaluation inside the cache window costs ZERO outspend requests',
              (p2, s2, bp2, bs2) == (p1, s1, bp1, bs1), ((p1, s1, bp1, bs1), (p2, s2, bp2, bs2)))
        delete_all_txs()
        # (b) Two outputs, one funding tx: the startup tick costs
        # ONE batch request, primary only — and zero singular ones.
        s, r = add_tx('UTXO 25c', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111502, True)
        check('25 batch: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
        utxo_b1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('UTXO 25d', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111503)
        check('25 batch: second same-funding-tx tx adds', s == 201, (s, r))
        utxo_b2 = r['tx']['id'] if s == 201 else None
        for tid in (utxo_b1, utxo_b2):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('25 batch: both txs disarm', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        check('25 batch: app restarted', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('25 batch: two outputs of one funding tx cost ONE batch request, primary only, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        t = state_tx(utxo_b1)
        check('25 batch: the spent output reads due (11 confirmations)',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        t = state_tx(utxo_b2)
        check('25 batch: the unspent output reads watching',
              rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
        # The batch populated the per-output cache: a later singular
        # lookup of one of those outpoints costs nothing.
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
        check('25 batch: single-trigger check of a batched outpoint reads due', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('25 batch: the batched outpoint is served from the cache (zero new requests)',
              (p1, s1, bp1, bs1) == (p0, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        delete_all_txs()
        # (b2) One watched output of a funding tx: (0.8.10) the
        # batch first — one batch request, no singular.
        s, r = add_tx('UTXO 25e', {'type': 'utxo', 'params': {'outpoint': SECOND + ':0', 'confirmations': 1}}, 111504)
        check('25 single: lone-output tx adds', s == 201, (s, r))
        utxo_e = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + utxo_e, {'enabled': False})
        check('25 single: the tx disarms', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        check('25 single: app restarted', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('25 single: one watched output costs ONE batch request, primary only, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        t = state_tx(utxo_e)
        check('25 single: the lone output reads watching (SECOND:0 unspent)',
              rule_slice(t).get('status') == 'watching', rule_slice(t))
        delete_all_txs()
        # (c) A 404 is never cached: the parent unknown on both
        # stubs, then known again with a spend — the next
        # evaluation must see the spend, not a cached unknown.
        # (0.8.6) The earlier sub-parts cached FINNEY:1 as
        # unspent (TTL = the parked 3600 s cadence), so the
        # unknowns are marked BEFORE a restart: the restart
        # clears the cache, and the startup tick itself reads
        # unknown from both stubs (a 404 is never cached).
        s, r = add_tx('UTXO 25f', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111505)
        check('25 unknown: watching tx adds', s == 201, (s, r))
        utxo_f = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + utxo_f, {'enabled': False})
        check('25 unknown: the tx disarms', s == 200, (s, r))
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
        check('25 unknown: primary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
        check('25 unknown: secondary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
        check('25 unknown: caches cleared for a cold outpoint cache', clear_caches())
        s, r, res = release_results()
        check('25 unknown: release check runs', s == 200, (s, r))
        t = state_tx(utxo_f)
        check('25 unknown: the rule reads unknown while the parent is unknown to both nodes',
              rule_slice(t).get('status') == 'unknown', rule_slice(t))
        # The parent is known again, and the outpoint is now spent
        # (override: confirmed at 899999 = 2 confirmations).
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
        check('25 unknown: both stubs know FINNEY again', s == 200, (s, r))
        s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'blockHeight': 899999}, base=STUB_BASE_P)
        check('25 unknown: primary stub overrides FINNEY:1 as spent', s == 200, (s, r))
        s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'blockHeight': 899999}, base=STUB_BASE_S)
        check('25 unknown: secondary stub overrides FINNEY:1 as spent', s == 200, (s, r))
        s, r, res = release_results()
        check('25 unknown: release check runs again', s == 200, (s, r))
        t = state_tx(utxo_f)
        check('25 unknown: the spend is detected on the next evaluation (the 404 was not cached)',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        # The mirror side, pinned explicitly: a genuine observation
        # stands for one TTL window — if both nodes go unknown
        # again right after observing the spend, the rule still
        # reads due from the cache. The fail-safe is that unknowns
        # are never cached, not that a fresh 404 overrides a fresh
        # observation.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
        check('25 unknown: both stubs mark FINNEY unknown again', s == 200, (s, r))
        s, r, res = release_results()
        check('25 unknown: release check runs a third time', s == 200, (s, r))
        t = state_tx(utxo_f)
        check('25 unknown: the observed spend still reads due inside its TTL window',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        # Cleanup: the unknowns and the override go away, FINNEY:1
        # is unspent again.
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
        check('25 unknown: unknowns cleared', s == 200, (s, r))
        s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'clear': True}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'clear': True}, base=STUB_BASE_S)
        check('25 unknown: overrides cleared', s == 200, (s, r))
        delete_all_txs()
        # (d) A confirmed-spend UTXO rule reuses the shared tip
        # cache: with the tip cache warm, a re-evaluation costs
        # ZERO tip fetches (before the fix, every evaluation paid
        # for its own direct tip fetch).
        s, r = add_tx('UTXO 25g', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111506, True)
        check('25 tip: confirmed-spend tx adds (trigger confirmed)', s == 201, (s, r))
        utxo_g = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + utxo_g, {'enabled': False})
        check('25 tip: the tx disarms', s == 200, (s, r))
        check('25 tip: app restarted (startup tick warms the tip cache)', restart())
        t0, s0 = tip_counts_25()
        s, r, res = release_results()
        check('25 tip: release check runs', s == 200, (s, r))
        t1, s1 = tip_counts_25()
        check('25 tip: re-evaluating a confirmed-spend rule costs ZERO tip fetches (shared cache)',
              (t1, s1) == (t0, s0), ((t0, s0), (t1, s1)))
        t = state_tx(utxo_g)
        check('25 tip: the rule still reads due (11 confirmations, from the cached tip)',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        # Cleanup: cadence back to 60.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('25 cleanup: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()
        # --- 26. Batch cache consult + in-flight dedup (0.8.6 fold-in) ---
        # Audit findings 1 and 3: (a) a batch lookup whose watched
        # outputs are all fresh in the per-outpoint cache costs ZERO
        # requests — the batch consults the cache before fetching;
        # (b) two simultaneous singular lookups of one outpoint
        # cost ONE request (in-flight dedup); (c) two simultaneous
        # batch lookups cost ONE request (in-flight dedup, proven
        # at the module level — the app's single-flight evaluation
        # lock means two batch fetches can never overlap through
        # the HTTP API, so this one calls lib/bitcoin.js directly
        # with node); (d) a failed request does not poison the
        # in-flight map — the retry fetches fresh and can succeed.
        # Cadence is parked at 3600 s again so the TTL window is
        # wide and only this section's evaluations move the
        # counters. The stub delay/fail hooks are cleared at the
        # end so nothing leaks into later sections.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('26 setup: cadence parked at 3600 s', s == 200, (s, r))
        # (a) Batch re-evaluation inside the cache window costs
        # nothing — the startup tick's batch fetch populated the
        # per-output cache, and the release check's batch consults
        # it before fetching.
        s, r = add_tx('UTXO 26a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111600, True)
        check('26 batch-cache: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
        utxo_a1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx('UTXO 26b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111601)
        check('26 batch-cache: second same-funding-tx tx adds', s == 201, (s, r))
        utxo_a2 = r['tx']['id'] if s == 201 else None
        for tid in (utxo_a1, utxo_a2):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('26 batch-cache: both txs disarm', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        check('26 batch-cache: app restarted (startup tick is the measured batch fetch)', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('26 batch-cache: startup tick costs ONE batch request, primary only, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        s, r, res = release_results()
        check('26 batch-cache: release check runs', s == 200, (s, r))
        p2, s2, bp2, bs2 = outspend_counts()
        check('26 batch-cache: re-evaluation inside the cache window costs ZERO batch AND zero singular requests',
              (p2, s2, bp2, bs2) == (p1, s1, bp1, bs1), ((p1, s1, bp1, bs1), (p2, s2, bp2, bs2)))
        t = state_tx(utxo_a1)
        check('26 batch-cache: the spent output still reads due from the cached batch',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        delete_all_txs()
        # (b) Two simultaneous lookups of one outpoint cost ONE
        # request: the stub delays its answer 400 ms so the second
        # lookup lands while the first is still in flight, and the
        # in-flight map shares it. (0.8.10) The shared request is
        # a batch one now — every lookup tries the batch first.
        # A restart first, for a cold cache — otherwise the cache
        check('26 inflight: caches cleared for a cold outpoint cache', clear_caches())
        s, r = req('POST', '/__test__/outspend-delay', {'ms': 400}, base=STUB_BASE_P)
        check('26 inflight: primary stub delays outspend answers 400 ms', s == 200 and r.get('delayMs') == 400, r)
        s, r = req('POST', '/__test__/outspend-delay', {'ms': 400}, base=STUB_BASE_S)
        check('26 inflight: secondary stub delays outspend answers 400 ms', s == 200 and r.get('delayMs') == 400, r)
        p0, s0, bp0, bs0 = outspend_counts()
        results_26 = []
        def _trigger_check_26():
            results_26.append(req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}}))
        threads_26 = [threading.Thread(target=_trigger_check_26) for _ in range(2)]
        for th in threads_26: th.start()
        for th in threads_26: th.join()
        check('26 inflight: both simultaneous trigger checks answer', len(results_26) == 2 and all(x[0] == 200 for x in results_26), results_26)
        check('26 inflight: both read the same answer (watching, unspent)',
              all(x[1].get('status') == 'watching' and x[1].get('fire') is False for x in results_26), results_26)
        p1, s1, bp1, bs1 = outspend_counts()
        check('26 inflight: two simultaneous lookups cost ONE batch request, primary only, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        s, r = req('POST', '/__test__/outspend-delay', {'ms': 0}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/outspend-delay', {'ms': 0}, base=STUB_BASE_S)
        check('26 inflight: stub delays cleared', s == 200, (s, r))
        # (c) Two simultaneous batch lookups cost ONE request.
        # Module-level, not HTTP: the app's single-flight
        # evaluation lock means two batch fetches can never
        # overlap through the API (the second release check is
        # skipped outright), so the in-flight map for batches is
        # defense-in-depth — and only a direct call to
        # lib/bitcoin.js can put two of them in flight at once.
        # The probe calls the exported checkOutspends twice
        # concurrently against the primary stub; the counter must
        # move by exactly one.
        node_probe_26 = '/tmp/standby-test099-batch-inflight.js'
        with open(node_probe_26, 'w') as f:
            f.write("const bitcoin = require('" + APP + "/lib/bitcoin.js');\n"
                    "(async () => {\n"
                    "  const eps = [{ label: 'primary', base: process.argv[2] }];\n"
                    "  const [a, b] = await Promise.all([\n"
                    "    bitcoin.checkOutspends(process.argv[3], eps, 60000),\n"
                    "    bitcoin.checkOutspends(process.argv[3], eps, 60000),\n"
                    "  ]);\n"
                    "  console.log(JSON.stringify({ aUnknown: a.unknown, bUnknown: b.unknown,\n"
                    "    aLen: Array.isArray(a.results) ? a.results.length : -1,\n"
                    "    bLen: Array.isArray(b.results) ? b.results.length : -1 }));\n"
                    "})().catch((e) => { console.error(e); process.exit(1); });\n")
        _, bp0_26 = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
        bp0_26 = bp0_26.get('count', -1)
        cp = subprocess.run(['node', node_probe_26, STUB_BASE_P, FINNEY], capture_output=True, text=True, timeout=30)
        check('26 batch-inflight: node probe runs', cp.returncode == 0, (cp.returncode, cp.stdout, cp.stderr))
        probe_26 = json.loads(cp.stdout) if cp.returncode == 0 and cp.stdout.strip() else {}
        check('26 batch-inflight: both concurrent batch lookups answer (2 outputs, not unknown)',
              probe_26.get('aUnknown') is False and probe_26.get('bUnknown') is False
              and probe_26.get('aLen') == 2 and probe_26.get('bLen') == 2, probe_26)
        _, bp1_26 = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
        bp1_26 = bp1_26.get('count', -1)
        check('26 batch-inflight: two simultaneous batch lookups cost ONE batch request',
              bp1_26 == bp0_26 + 1, (bp0_26, bp1_26))
        # (d) A failed request does not poison the in-flight map:
        # with both stubs answering 500, a lookup fails
        # (unknown, never cached); with the failure cleared, the
        # retry fetches fresh and reads the real answer. If the
        # rejected promise stayed in the map, the retry would
        # return the same failure without a new request.
        check('26 fail: caches cleared for a cold outpoint cache', clear_caches())
        s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_P)
        check('26 fail: primary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
        s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_S)
        check('26 fail: secondary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
        check('26 fail: trigger check runs while both stubs fail', s == 200, (s, r))
        check('26 fail: the rule reads unknown while both nodes fail', r.get('status') == 'unknown', r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('26 fail: the failed lookup tried both endpoints (one batch request each)',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_S)
        check('26 fail: stub failures cleared', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
        check('26 fail: retry trigger check runs', s == 200, (s, r))
        check('26 fail: the retry reads the real answer (watching, unspent)',
              r.get('status') == 'watching' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('26 fail: the retry issues a FRESH request (the failure did not poison the map)',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # Cleanup: cadence back to 60.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('26 cleanup: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()
        # --- 27. Shared trigger sets (0.8.7) ---
        # One label, one arm/disarm, one rule set driving several
        # transactions: the set's triggers are evaluated ONCE per
        # tick (shared across members), and on fire ALL attached
        # members broadcast through the existing per-tx path. A
        # stale member is skipped (its subcard carries a 'stale'
        # pill) and the set keeps firing for its non-stale
        # members — only when EVERY member is stale does the set
        # archive. Deleting a set returns its txs to standalone —
        # it never deletes them.
        # Cadence is parked at 3600 s so only this section's
        # evaluations move the stub counters; the startup tick
        # (5 s) is the single evaluation each sub-part measures.
        def state_set(set_id, base=BASE):
            s, st = req('GET', '/api/state', base=base)
            for x in st.get('bitcoin', {}).get('sets', []):
                if x.get('id') == set_id:
                    return x
            return None
        def state_sets(base=BASE):
            s, st = req('GET', '/api/state', base=base)
            return st.get('bitcoin', {}).get('sets', [])
        def add_tx_vout(label, trigger, vout, value, prev=FINNEY, trigger_confirmed=False):
            body = {'txHex': craft_prev(prev, vout, value), 'label': label, 'notes': '', 'trigger': trigger}
            if trigger_confirmed:
                body['triggerConfirmed'] = True
            return req('POST', '/api/bitcoin/txs', body)
        def broadcast_counts():
            _, rp = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
            _, rs = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
            return rp.get('count', -1), rs.get('count', -1)
        def set_rule_slice(x, i=0):
            ts = (x or {}).get('triggerState')
            if isinstance(ts, list):
                return ts[i] if i < len(ts) else {}
            return ts if isinstance(ts, dict) else {}
        def delete_all_sets(base=BASE):
            for x in state_sets(base):
                req('DELETE', '/api/bitcoin/sets/' + x['id'], base=base)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('27 setup: cadence parked at 3600 s', s == 200, (s, r))
        # (a) Create + attach, and the single evaluation: three
        # members, each with its own past setdate trigger that
        # WOULD fire standalone, attached to a set whose one
        # shared rule is a UTXO watch on FINNEY:1 (unspent). The
        # startup tick evaluates the set once — and (0.8.7.4) the
        # hourly freshness refresh checks the three member inputs
        # first, so the rule reads FINNEY:1 from the shared cache:
        # three singular requests total, primary only, no batch —
        # and the members' own triggers are never evaluated (their
        # triggerState stays null, nothing broadcasts). The rule's
        # own one-request cost is re-proved on a cold cache just
        # below, via a release check.
        s, r = add_tx_vout('Set 27a m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112700, trigger_confirmed=True)
        check('27 single: member 1 adds (own past setdate trigger)', s == 201, (s, r))
        m1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27a m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112701, trigger_confirmed=True)
        check('27 single: member 2 adds (own past setdate trigger)', s == 201, (s, r))
        m2 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27a m3', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 0, 112702, prev=SECOND, trigger_confirmed=True)
        check('27 single: member 3 adds (own past setdate trigger, SECOND:0)', s == 201, (s, r))
        m3 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27a', 'txIds': [m1, m2, m3],
                  'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
        check('27 single: set created with 3 members (201)', s == 201, (s, r))
        set27a = r.get('set', {}).get('id') if s == 201 else None
        # (0.8.7, round 9) Single history: the set's trail opens
        # with each member's 'added' event (tagged with the member
        # label, oldest first) and the creation event closes it.
        hist27a = r.get('set', {}).get('history', []) if s == 201 else []
        check('27 single: set serves its label, members, arm, and backfilled history',
              s == 201 and r.get('set', {}).get('label') == 'Set 27a'
              and r.get('set', {}).get('txIds') == [m1, m2, m3]
              and r.get('set', {}).get('enabled') is True
              and [e.get('type') for e in hist27a] == ['added', 'added', 'added', 'added']
              and hist27a[-1].get('detail') == 'Set created with 3 transactions'
              and {'"Set 27a" - Tx 1', '"Set 27a" - Tx 2', '"Set 27a" - Tx 3'} == {e.get('detail', '').split(':')[0] for e in hist27a[:3]}
              and [e.get('ts') for e in hist27a] == sorted(e.get('ts') for e in hist27a), r.get('set'))
        p0, s0, bp0, bs0 = outspend_counts()
        bc0 = broadcast_counts()
        check('27 single: app restarted (startup tick is the measured evaluation)', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        # (0.8.7.4) The startup tick now does two things: the
        # hourly freshness refresh (§30) checks each live staged
        # member input — FINNEY:1, FINNEY:2, SECOND:0 — and the
        # set's UTXO rule on FINNEY:1 then reads the shared cache
        # the refresh populated, costing zero extra requests.
        # (0.8.10) Every lookup tries the batch first: FINNEY:1
        # costs one batch request (which also answers FINNEY:0
        # into the cache); FINNEY:2 costs a second batch request
        # for the same funding tx — the batch answer itself is
        # not cached — plus a singular fallback, because the
        # batch array has no vout 2 (the stub's FINNEY has only
        # 2 outputs); SECOND:0 costs one batch request. The tick
        # total is three batch + one singular, primary only.
        check('27 single: startup tick costs THREE batch + ONE singular requests (freshness refresh of the 3 member inputs), primary only',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 3, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        bc1 = broadcast_counts()
        check('27 single: the startup tick broadcast nothing', bc1 == bc0, (bc0, bc1))
        x = state_set(set27a)
        check('27 single: the set rule reads watching (FINNEY:1 still unspent)',
              set_rule_slice(x).get('status') == 'watching' and set_rule_slice(x).get('reason') == 'still unspent', set_rule_slice(x))
        for mid in (m1, m2, m3):
            t = state_tx(mid)
            check('27 single: member own trigger never evaluated (triggerState stays null)',
                  t is not None and t.get('triggerState') is None, (t or {}).get('triggerState'))
        # (0.8.7.4) The rule itself still costs exactly one
        # request when the cache is cold: clear the outspend cache
        # and run a release check — no freshness refresh runs on a
        # release check, so the set rule's FINNEY:1 lookup is the
        # only outspend request the check makes.
        s, r = req('POST', '/api/__test__/clear-caches', {'only': ['outspend']})
        check('27 single: outspend cache cleared for the cold rule check', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        s, r, res = release_results()
        check('27 single: release check runs (cold cache)', s == 200, (s, r))
        p1, s1, bp1, bs1 = outspend_counts()
        check('27 single: the set rule alone costs ONE batch request on a cold cache, primary only, no singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # (b) Fire broadcasts ALL members: retarget the set to a
        # past setdate, then a manual release check sends all
        # three through the per-tx broadcast path.
        s, r = req('PUT', '/api/bitcoin/sets/' + set27a,
                   {'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
        check('27 fire: set retargeted to a past setdate (trigger confirmed)', s == 200, (s, r))
        bc0 = broadcast_counts()
        s, r, res = release_results()
        check('27 fire: release check runs', s == 200, (s, r))
        check('27 fire: release action is broadcast', r.get('action') == 'broadcast', r.get('action'))
        bc1 = broadcast_counts()
        check('27 fire: all three members broadcast via the primary (3 attempts, none secondary)',
              bc1 == (bc0[0] + 3, bc0[1]), (bc0, bc1))
        for mid in (m1, m2, m3):
            check('27 fire: member broadcast', res.get(mid, {}).get('action') == 'broadcast', res.get(mid))
            t = state_tx(mid)
            check('27 fire: member recorded broadcast', t is not None and bool(t.get('broadcasted')), (t or {}).get('broadcasted'))
        x = state_set(set27a)
        check('27 fire: the set history records the firing',
              [e.get('type') for e in (x or {}).get('history', [])].count('fired') == 1, (x or {}).get('history'))
        delete_all_txs()
        check('27 fire: cleanup leaves no sets (empty sets go with their last tx)',
              state_sets() == [], state_sets())
        # (c) A disarmed set is evaluated but never broadcasts.
        s, r = add_tx_vout('Set 27c m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112710, trigger_confirmed=True)
        check('27 disarmed: member 1 adds', s == 201, (s, r))
        n1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27c m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112711, trigger_confirmed=True)
        check('27 disarmed: member 2 adds', s == 201, (s, r))
        n2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27c', 'txIds': [n1, n2],
                  'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
        check('27 disarmed: set created with a past setdate trigger', s == 201, (s, r))
        set27c = r.get('set', {}).get('id') if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/sets/' + set27c, {'enabled': False})
        check('27 disarmed: set disarmed', s == 200 and r.get('set', {}).get('enabled') is False, (s, r))
        bc0 = broadcast_counts()
        s, r, res = release_results()
        check('27 disarmed: release check runs', s == 200, (s, r))
        check('27 disarmed: the set result is skipped (disarmed)',
              res.get(set27c, {}).get('action') == 'skipped' and 'disarmed' in (res.get(set27c, {}).get('reason') or ''), res.get(set27c))
        check('27 disarmed: nothing broadcast', broadcast_counts() == bc0, (bc0, broadcast_counts()))
        x = state_set(set27c)
        check('27 disarmed: the set IS evaluated (triggerState due)',
              set_rule_slice(x).get('status') == 'due', set_rule_slice(x))
        for mid in (n1, n2):
            t = state_tx(mid)
            check('27 disarmed: member not broadcast', t is not None and not t.get('broadcasted'), (t or {}).get('broadcasted'))
        delete_all_txs()
        # (d) Detach: PUT txIds drops a member, and deleting the
        # set returns its txs to standalone — each with its own
        # trigger live again.
        s, r = add_tx_vout('Set 27d m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112720, trigger_confirmed=True)
        check('27 detach: member 1 adds', s == 201, (s, r))
        d1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27d m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112721, trigger_confirmed=True)
        check('27 detach: member 2 adds', s == 201, (s, r))
        d2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27d', 'txIds': [d1, d2],
                  'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}})
        check('27 detach: set created with a future setdate trigger', s == 201, (s, r))
        set27d = r.get('set', {}).get('id') if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/sets/' + set27d, {'txIds': [d1]})
        check('27 detach: PUT txIds drops member 2', s == 200 and r.get('set', {}).get('txIds') == [d1], (s, r))
        s, r, res = release_results()
        check('27 detach: release check runs', s == 200, (s, r))
        check('27 detach: the dropped member fires on its own trigger now',
              res.get(d2, {}).get('action') == 'broadcast', res.get(d2))
        t = state_tx(d1)
        check('27 detach: the kept member does not broadcast (set trigger is future)',
              t is not None and not t.get('broadcasted'), (t or {}).get('broadcasted'))
        s, r = req('DELETE', '/api/bitcoin/sets/' + set27d)
        check('27 detach: set deleted', s == 200, (s, r))
        check('27 detach: the kept tx survives the set delete (standalone again)',
              state_tx(d1) is not None and state_sets() == [], (state_tx(d1), state_sets()))
        s, r, res = release_results()
        check('27 detach: release check runs after the delete', s == 200, (s, r))
        check('27 detach: the freed member fires on its own trigger now',
              res.get(d1, {}).get('action') == 'broadcast', res.get(d1))
        delete_all_txs()
        # (e) Stale member (0.8.7, revised rule): member 1 is fine
        # (FINNEY:1), member 2 spends FINNEY:0 (confirmed spent).
        # The set fires: the fine member broadcasts, the spent
        # member is marked stale and skipped — the set itself
        # stays live for the member that is left. Only when EVERY
        # member is stale does the set archive (see (g)).
        s, r = add_tx_vout('Set 27e m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112730)
        check('27 stale: member 1 adds (FINNEY:1, fine)', s == 201, (s, r))
        e1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27e m2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112731)
        check('27 stale: member 2 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
        e2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27e', 'txIds': [e1, e2],
                  'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
        check('27 stale: set created with a past setdate trigger', s == 201, (s, r))
        set27e = r.get('set', {}).get('id') if s == 201 else None
        bc0 = broadcast_counts()
        s, r, res = release_results()
        check('27 stale: release check runs', s == 200, (s, r))
        check('27 stale: release action is broadcast (the live member goes out)', r.get('action') == 'broadcast', r.get('action'))
        bc1 = broadcast_counts()
        check('27 stale: exactly one broadcast, via the primary (the stale member is excluded from the firing set)',
              bc1 == (bc0[0] + 1, bc0[1]), (bc0, bc1))
        check('27 stale: the fine member broadcasts', res.get(e1, {}).get('action') == 'broadcast', res.get(e1))
        check('27 stale: the spent member reads stale', res.get(e2, {}).get('action') == 'stale', res.get(e2))
        t = state_tx(e1)
        check('27 stale: the fine member is recorded broadcast', t is not None and bool(t.get('broadcasted')), (t or {}).get('broadcasted'))
        t = state_tx(e2)
        check('27 stale: only the spent member is recorded stale',
              t is not None and (t.get('release') or {}).get('status') == 'stale', (t or {}).get('release'))
        x = state_set(set27e)
        check('27 stale: the set is NOT archived (still present, still live for its remaining member)',
              x is not None and x.get('txIds') == [e1, e2], x)
        check('27 stale: the set history records the member going stale',
              [ev.get('type') for ev in (x or {}).get('history', [])].count('stale') == 1
              and any('"Set 27e" - Tx 2' in (ev.get('detail') or '') for ev in (x or {}).get('history', []) if ev.get('type') == 'stale'), (x or {}).get('history'))
        delete_all_txs()
        # (g) All members stale archives the set: both members
        # spend FINNEY:0 (confirmed spent). The set fires, the
        # pre-check finds both stale, and NOTHING broadcasts.
        # A second release check then reads the set as archived
        # (skipped — all members are stale).
        s, r = add_tx_vout('Set 27g m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112750)
        check('27 all-stale: member 1 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
        g1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Set 27g m2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112751)
        check('27 all-stale: member 2 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
        g2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27g', 'txIds': [g1, g2],
                  'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
        check('27 all-stale: set created with a past setdate trigger', s == 201, (s, r))
        set27g = r.get('set', {}).get('id') if s == 201 else None
        bc0 = broadcast_counts()
        s, r, res = release_results()
        check('27 all-stale: release check runs', s == 200, (s, r))
        check('27 all-stale: release action is stale', r.get('action') == 'stale', r.get('action'))
        check('27 all-stale: nothing broadcast', broadcast_counts() == bc0, (bc0, broadcast_counts()))
        for mid in (g1, g2):
            check('27 all-stale: member reads stale', res.get(mid, {}).get('action') == 'stale', res.get(mid))
            t = state_tx(mid)
            check('27 all-stale: member recorded stale',
                  t is not None and (t.get('release') or {}).get('status') == 'stale', (t or {}).get('release'))
        s, r, res = release_results()
        check('27 all-stale: second release check runs', s == 200, (s, r))
        check('27 all-stale: the set reads archived (skipped — all members are stale)',
              res.get(set27g, {}).get('action') == 'skipped' and 'all members are stale' in (res.get(set27g, {}).get('reason') or ''), res.get(set27g))
        check('27 all-stale: the set still exists in state (archived, not deleted)',
              state_set(set27g) is not None, state_sets())
        delete_all_txs()
        # (f) Migration / compat: a pre-set state file (no `sets`
        # key at all) loads as sets [], and a hand-edited set
        # with a dangling member and a member claimed by two sets
        # is sanitized on load — the dangling id is pruned, the
        # duplicate stays only in the first set.
        stj = load_state_file()
        stj['bitcoin'].pop('sets', None)
        save_state_file(stj)
        check('27 migrate: app restarted with a pre-set state file', restart())
        check('27 migrate: pre-set state loads with sets == []', state_sets() == [], state_sets())
        s, r = add_tx_vout('Set 27f m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112740)
        check('27 migrate: member adds', s == 201, (s, r))
        f1 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        stj['bitcoin']['sets'] = [
            {'id': 'set_hand1', 'label': 'Hand 1', 'enabled': True, 'txIds': [f1, 'tx_missing'],
             'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}},
            {'id': 'set_hand2', 'label': 'Hand 2', 'enabled': True, 'txIds': [f1],
             'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}},
        ]
        save_state_file(stj)
        check('27 migrate: app restarted with hand-edited sets', restart())
        sets27f = {x['id']: x for x in state_sets()}
        check('27 migrate: the dangling member is pruned, the real one kept',
              sets27f.get('set_hand1', {}).get('txIds') == [f1], sets27f.get('set_hand1'))
        check('27 migrate: a tx in two sets stays only in the first',
              sets27f.get('set_hand2', {}).get('txIds') == [], sets27f.get('set_hand2'))
        # (0.8.7, round 9) The load-time backfill runs for a
        # hand-edited set too: the seeded creation event plus the
        # member's own 'added' event, tagged by its set
        # (0.8.7, round 13: '"Hand 1" - Tx 1', never the bare
        # member label).
        handHist27f = sets27f.get('set_hand1', {}).get('history', [])
        check('27 migrate: missing fields defaulted (history seeded + member backfilled, enabled true)',
              sets27f.get('set_hand1', {}).get('enabled') is True
              and [e.get('type') for e in handHist27f] == ['added', 'added']
              and any(e.get('detail') == 'Set created with 1 transaction' for e in handHist27f)
              and any(e.get('detail', '').startswith('"Hand 1" - Tx 1:') for e in handHist27f), sets27f.get('set_hand1'))
        # (h) Add flow IS "add trigger set" (0.8.7 fix, round 3):
        # one Save creates ALL filled entries — each POSTed with
        # the SHARED trigger in its own record (it stays dormant
        # while the tx is in the set, and it is what the tx falls
        # back to if the set is ever deleted) — then creates the
        # set in ONE POST with the one label, the members, and
        # the same shared trigger. Create a set with two such
        # txs, then edit it to add a third and drop one (the
        # dropped tx returns to standalone, never deleted), then
        # delete the set and confirm the remaining members fall
        # back to their own trigger. This is the exact sequence
        # the Add modal's Save runs.
        shared27h = {'op': 'OR', 'rules': [{'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}]}
        # Dual-shape serving: a one-rule set is SERVED as its
        # single rule (serveTx / serveSet unwrap it), so the
        # served trigger reads as the rule, not the wrapper.
        shared_rule27h = {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 112760), 'trigger': shared27h})
        check('27 add-set: member 1 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
        h1 = r['tx']['id'] if s == 201 else None
        t = state_tx(h1) if h1 else None
        check('27 add-set: member 1 keeps the shared trigger (not the 35-day default)',
              t is not None and t.get('trigger') == shared_rule27h, (t or {}).get('trigger'))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 2, 112761), 'trigger': shared27h})
        check('27 add-set: member 2 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
        h2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27h', 'txIds': [h1, h2], 'trigger': shared27h, 'enabled': True})
        check('27 add-set: set created with BOTH members and the ONE label in one call (201)', s == 201, (s, r))
        set27h = r.get('set', {}).get('id') if s == 201 else None
        x = state_set(set27h) if set27h else None
        check('27 add-set: the set serves both members under that label',
              x is not None and x.get('txIds') == [h1, h2] and x.get('label') == 'Set 27h', (x or {}).get('txIds'))
        check('27 add-set: the set carries the shared trigger',
              x is not None and x.get('trigger') == shared_rule27h, (x or {}).get('trigger'))
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 112762), 'trigger': shared27h})
        check('27 add-set: member 3 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
        h3 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/sets/' + set27h, {'txIds': [h1, h2, h3]})
        check('27 add-set: edit adds a third member (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [h1, h2, h3], (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27h, {'txIds': [h1, h3]})
        check('27 add-set: edit drops member 2 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [h1, h3], (s, r))
        t = state_tx(h2)
        check('27 add-set: the dropped member is standalone again with its own trigger, never deleted',
              t is not None and t.get('trigger') == shared_rule27h, (t or {}).get('trigger'))
        s, r = req('DELETE', '/api/bitcoin/sets/' + set27h)
        check('27 add-set: deleting the set (200)', s == 200, (s, r))
        t1 = state_tx(h1); t3 = state_tx(h3)
        check('27 add-set: the remaining members fall back to their own trigger after the set is deleted',
              t1 is not None and t1.get('trigger') == shared_rule27h
              and t3 is not None and t3.get('trigger') == shared_rule27h
              and not any(h1 in (x.get('txIds') or []) or h3 in (x.get('txIds') or []) for x in state_sets()),
              ((t1 or {}).get('trigger'), (t3 or {}).get('trigger')))
        delete_all_txs()
        delete_all_sets()
        # (i) Single history (0.8.7, round 9): ONE history per
        # card — the set's. A member's events are forwarded to
        # it tagged with the member's label; a set's trail opens
        # with its members' existing histories (creation and
        # attach backfill); the member's own history keeps
        # recording and survives the set's delete.
        s, r = add_tx_vout('Dom Single M1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112800)
        check('27 single-hist: member 1 adds (future setdate)', s == 201, (s, r))
        i1 = r['tx']['id'] if s == 201 else None
        s, r = add_tx_vout('Dom Single M2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 2, 112801)
        check('27 single-hist: member 2 adds (future setdate)', s == 201, (s, r))
        i2 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Dom Single Set', 'txIds': [i1, i2],
                  'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}})
        check('27 single-hist: set created with 2 members (201)', s == 201, (s, r))
        set27i = r.get('set', {}).get('id') if s == 201 else None
        hist27i = r.get('set', {}).get('history', []) if s == 201 else []
        check('27 single-hist: creation backfills both members, creation event last, chronological',
              [e.get('type') for e in hist27i] == ['added', 'added', 'added']
              and hist27i[-1].get('detail') == 'Set created with 2 transactions'
              and {'"Dom Single Set" - Tx 1', '"Dom Single Set" - Tx 2'} == {e.get('detail', '').split(':')[0] for e in hist27i[:2]}
              and [e.get('ts') for e in hist27i] == sorted(e.get('ts') for e in hist27i), hist27i)
        s, r = req('PUT', '/api/bitcoin/txs/' + i1, {'notes': 'edited note'})
        check('27 single-hist: member 1 notes edited (200)', s == 200, (s, r))
        t = state_tx(i1)
        check('27 single-hist: the edit lands on the member own history',
              t is not None and any(e.get('type') == 'edited' and e.get('detail') == 'Notes changed' for e in (t or {}).get('history', [])), (t or {}).get('history'))
        x = state_set(set27i)
        check('27 single-hist: the edit is forwarded to the set history, tagged, exactly once',
              x is not None and [e.get('detail') for e in (x or {}).get('history', []) if e.get('type') == 'edited'].count('"Dom Single Set" - Tx 1: Notes changed') == 1, (x or {}).get('history'))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'enabled': False})
        check('27 single-hist: set disarmed', s == 200 and r.get('set', {}).get('enabled') is False, (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'enabled': True})
        check('27 single-hist: set re-armed', s == 200 and r.get('set', {}).get('enabled') is True, (s, r))
        x = state_set(set27i)
        check('27 single-hist: arm/disarm logs once each on the set history, never member-tagged',
              x is not None
              and [e.get('type') for e in (x or {}).get('history', [])].count('disarmed') == 1
              and [e.get('type') for e in (x or {}).get('history', [])].count('armed') == 1
              and all(e.get('detail') == '' for e in (x or {}).get('history', []) if e.get('type') in ('armed', 'disarmed')), (x or {}).get('history'))
        s, r = add_tx_vout('Dom Single M3', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 3, 112802)
        check('27 single-hist: member 3 adds (future setdate)', s == 201, (s, r))
        i3 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/txs/' + i3, {'notes': 'third note'})
        check('27 single-hist: member 3 notes edited (200)', s == 200, (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i3]})
        check('27 single-hist: edit attaches member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i3], (s, r))
        x = state_set(set27i)
        hist27i = (x or {}).get('history', [])
        check('27 single-hist: attach backfills member 3 history before the Members changed event',
              any('"Dom Single Set" - Tx 3' in e.get('detail', '') and e.get('type') == 'added' for e in hist27i)
              and any(e.get('detail') == '"Dom Single Set" - Tx 3: Notes changed' for e in hist27i)
              and hist27i[-1].get('type') == 'edited' and 'Members changed (+1)' in hist27i[-1].get('detail', ''), hist27i)
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
        check('27 single-hist: edit drops member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i3]})
        check('27 single-hist: edit re-attaches member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i3], (s, r))
        x = state_set(set27i)
        hist27i = (x or {}).get('history', [])
        check('27 single-hist: re-attach does NOT duplicate member 3 history',
              sum(1 for e in hist27i if e.get('detail', '').startswith('"Dom Single Set" - Tx 3')) == 2, hist27i)
        # (0.8.7, round 13) A label-less member is tagged by
        # its set, never "Untitled transaction": attach one as
        # Tx 3, edit its notes, and read the tag back.
        s, r = add_tx_vout('', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 4, 112803)
        check('27 single-hist: label-less member adds (future setdate)', s == 201, (s, r))
        i4 = r['tx']['id'] if s == 201 else None
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i4]})
        check('27 single-hist: label-less member attaches as Tx 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i4], (s, r))
        s, r = req('PUT', '/api/bitcoin/txs/' + i4, {'notes': 'fourth note'})
        check('27 single-hist: label-less member notes edited (200)', s == 200, (s, r))
        x = state_set(set27i)
        hist27i = (x or {}).get('history', [])
        check('27 single-hist: the label-less edit is tagged "Dom Single Set" - Tx 3, never Untitled',
              any(e.get('detail') == '"Dom Single Set" - Tx 3: Notes changed' for e in hist27i)
              and not any('Untitled transaction' in e.get('detail', '') for e in hist27i), hist27i)
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
        check('27 single-hist: label-less member dropped again (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
        check('27 single-hist: member 3 dropped again before the fire (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
        s, r = req('PUT', '/api/bitcoin/sets/' + set27i,
                   {'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
        check('27 single-hist: set retargeted to a past setdate (trigger confirmed)', s == 200, (s, r))
        s, r, res = release_results()
        check('27 single-hist: release check runs', s == 200, (s, r))
        check('27 single-hist: release action is broadcast', r.get('action') == 'broadcast', r.get('action'))
        x = state_set(set27i)
        hist27i = (x or {}).get('history', [])
        check('27 single-hist: both member broadcasts are forwarded, tagged',
              [e.get('type') for e in hist27i].count('broadcast') == 2
              and {'"Dom Single Set" - Tx 1', '"Dom Single Set" - Tx 2'} == {e.get('detail', '').split(':')[0] for e in hist27i if e.get('type') == 'broadcast'}, hist27i)
        check('27 single-hist: exactly ONE fired event (no duplicate from member forwarding)',
              [e.get('type') for e in hist27i].count('fired') == 1, hist27i)
        s, r = req('DELETE', '/api/bitcoin/sets/' + set27i)
        check('27 single-hist: set deleted', s == 200, (s, r))
        t1 = state_tx(i1); t2 = state_tx(i2); t3 = state_tx(i3)
        check('27 single-hist: deleting the set leaves each member own history intact and full',
              t1 is not None and [e.get('type') for e in t1.get('history', [])] == ['added', 'edited', 'broadcast']
              and t2 is not None and [e.get('type') for e in t2.get('history', [])] == ['added', 'broadcast']
              and t3 is not None and [e.get('type') for e in t3.get('history', [])] == ['added', 'edited'],
              ((t1 or {}).get('history'), (t2 or {}).get('history'), (t3 or {}).get('history')))
        delete_all_txs()
        delete_all_sets()
        # --- 28. not-found broadcast txs get a stale/conflict verdict (0.8.7.1) ---
        # A broadcast tx the nodes no longer know is not just "not
        # found": the confirmation refresh now asks whether its
        # inputs are spent. FINNEY:0 is spent-confirmed by the stub
        # (spender aabbccdd, block 899990); CONFLICT:0 ('cc'*32) is
        # spent-unconfirmed on the primary (spender 'dd'*32), so the
        # first completed check reads conflict. Both txs are seeded
        # broadcast via the state file (a broadcast fact cannot be
        # made through the API — and the pre-broadcast freshness
        # gate would refuse these hexes outright, their inputs
        # being spent). The background tick is parked (cadence
        # 3600 s) so only the refreshes below move anything; the
        # restart's 5 s startup tick runs the hourly refresh once,
        # so the verdicts are already recorded when the endpoint
        # below answers.
        CONFLICT = 'cc' * 32
        CONFLICT_SPENDER = 'dd' * 32
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('28 setup: cadence parked at 3600 s', s == 200, (s, r))
        check('28 setup: caches cleared for a cold cache', clear_caches())
        FROZEN28 = iso_ago(hours=2)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 112800), 'label': 'Stale NF', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('28 stale: the FINNEY:0 tx adds', s == 201, (s, r))
        stale28 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(CONFLICT, 0, 112801), 'label': 'Conflict NF', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('28 conflict: the CONFLICT:0 tx adds', s == 201, (s, r))
        conflict28 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
        for tx_id in (stale28, conflict28):
            t = by_id.get(tx_id)
            t['broadcasted'] = {'txid': t.get('txid'), 'broadcastedAt': FROZEN28, 'method': 'mempool.space',
                                'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': FROZEN28}
            t['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'manual',
                            'txid': t.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN28}
        save_state_file(stj)
        check('28 setup: app restarted with the seeded not-found txs', restart())
        # Let the startup hourly tick finish before the endpoint
        # call, so its merge (which logs the stale transition)
        # cannot race the endpoint's own merge.
        # (Optimization O8) Poll until the startup hourly tick's
        # merge has refreshed the seeded tx's checkedAt — the
        # merge's observable effect, not a fixed 3 s wait.
        wait_until(lambda: ((state_tx(stale28) or {}).get('broadcasted') or {}).get('checkedAt') != FROZEN28, deadline=5)
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('28 refresh: the confirmations endpoint runs', s == 200, (s, r))
        conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
        check('28 stale: the refresh reports the tx not found, with a stale verdict',
              conf_by_id.get(stale28, {}).get('found') is False
              and conf_by_id.get(stale28, {}).get('staleInput', {}).get('spentBy') == 'aabbccdd'
              and conf_by_id.get(stale28, {}).get('staleInput', {}).get('blockHeight') == 899990,
              conf_by_id.get(stale28))
        check('28 conflict: the refresh reports the tx not found, with a conflict verdict',
              conf_by_id.get(conflict28, {}).get('found') is False
              and conf_by_id.get(conflict28, {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER
              and not conf_by_id.get(conflict28, {}).get('staleInput'),
              conf_by_id.get(conflict28))
        t = state_tx(stale28)
        check('28 stale: the verdict is stored on the broadcasted fact',
              t is not None and (t.get('broadcasted') or {}).get('staleInput', {}).get('spentBy') == 'aabbccdd'
              and (t.get('broadcasted') or {}).get('staleInput', {}).get('blockHeight') == 899990, (t or {}).get('broadcasted'))
        check('28 stale: the transition logs exactly one stale history event',
              t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
        t = state_tx(conflict28)
        check('28 conflict: the verdict is stored, and no stale event is logged',
              t is not None and (t.get('broadcasted') or {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER
              and 'stale' not in [e.get('type') for e in t.get('history', [])], (t or {}).get('broadcasted'))
        # Force a real second refresh (backdate checkedAt past the
        # endpoint's 60 s window): the conflict re-checks (it is
        # transient) but the stale one is never re-checked — and
        # never re-logged — once recorded.
        stj = load_state_file()
        by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
        for tx_id in (stale28, conflict28):
            by_id[tx_id]['broadcasted']['checkedAt'] = FROZEN28
        save_state_file(stj)
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('28 refresh again: the endpoint runs', s == 200, (s, r))
        t = state_tx(stale28)
        check('28 stale: the second refresh logs no duplicate stale event',
              t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
        t = state_tx(conflict28)
        check('28 conflict: the second refresh still reads conflict',
              t is not None and (t.get('broadcasted') or {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER, (t or {}).get('broadcasted'))
        delete_all_txs()
        # Cleanup: cadence back to 60.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('27 cleanup: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()

        # --- 29. archived broadcast txs show a derived confirmation count (0.8.7.2) ---
        # A broadcast tx past 6 confirmations is never re-queried
        # per-tx — but its displayed count no longer freezes at the
        # last stored snapshot (the live "Mara" tx still read 1043
        # when the true count was 1288). The confirmations endpoint
        # now derives the count from the settled confirming block
        # height + the current tip, from the shared per-tick tip
        # cache — one tip fetch for all archived txs on a cold
        # cache, zero on a hit. The gate is unchanged: below 6 the
        # tx is still re-queried per-tx, and the stored snapshot is
        # never overwritten with the derived number.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('29 setup: cadence parked at 3600 s', s == 200, (s, r))
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
        check('29 setup: caches cleared for a cold tip cache', clear_caches())
        FROZEN29 = iso_ago(hours=2)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 3, 112900), 'label': 'Derived Arch', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('29 derived: the FINNEY:3 tx adds', s == 201, (s, r))
        arch29 = r['tx']['id'] if s == 201 else None
        stj = load_state_file()
        by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
        arch_tx = by_id.get(arch29)
        arch_tx['broadcasted'] = {'txid': arch_tx.get('txid'), 'broadcastedAt': FROZEN29, 'method': 'mempool.space',
                                  'confirmations': 7, 'blockHeight': 899993, 'found': True, 'checkedAt': FROZEN29}
        arch_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'manual',
                              'txid': arch_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN29}
        save_state_file(stj)
        check('29 setup: app restarted with the seeded archived tx', restart())
        # (Optimization O8) No wait here: the archived tx (7
        # confirmations) is never touched by refreshConfirmations,
        # so nothing races the endpoint's own refresh — the old
        # 3 s sleep bought nothing.
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('29 refresh: the confirmations endpoint runs', s == 200, (s, r))
        conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
        check('29 derived: the endpoint returns tip - block + 1 (900000 - 899993 + 1 = 8), not the stored 7',
              conf_by_id.get(arch29, {}).get('confirmations') == 8
              and conf_by_id.get(arch29, {}).get('blockHeight') == 899993
              and conf_by_id.get(arch29, {}).get('found') is True, conf_by_id.get(arch29))
        t = state_tx(arch29)
        check('29 stored: the stored snapshot is untouched (still 7, checkedAt still frozen)',
              t is not None and (t.get('broadcasted') or {}).get('confirmations') == 7
              and (t.get('broadcasted') or {}).get('checkedAt') == FROZEN29, (t or {}).get('broadcasted'))
        # Move the stub tip forward; restart (cold tip cache — the
        # TTL is the parked 3600 s cadence); the derived count must
        # follow the tip while the stored snapshot stays put.
        s, r = req('POST', '/__test__/tip', {'height': 900010}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip', {'height': 900010}, base=STUB_BASE_S)
        check('29 setup: caches cleared for a cold tip cache after the tip move', clear_caches())
        # (Optimization O8) No wait: the endpoint re-fetches the
        # tip itself on a cold cache — the old 3 s sleep bought
        # nothing.
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('29 refresh after tip move: the endpoint runs', s == 200, (s, r))
        conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
        check('29 derived: the count follows the tip (900010 - 899993 + 1 = 18)',
              conf_by_id.get(arch29, {}).get('confirmations') == 18, conf_by_id.get(arch29))
        t = state_tx(arch29)
        check('29 stored: the stored snapshot is still 7 after the tip move',
              t is not None and (t.get('broadcasted') or {}).get('confirmations') == 7, (t or {}).get('broadcasted'))
        # Fallback: with no tip available at all (both stubs fail
        # the tip read), the endpoint returns the stored count.
        s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_S)
        check('29 setup: caches cleared with both stubs failing the tip read', clear_caches())
        # (Optimization O8) No wait: the endpoint falls back to the
        # stored count itself — the old 3 s sleep bought nothing.
        s, r = req('GET', '/api/bitcoin/confirmations')
        check('29 refresh with no tip: the endpoint runs', s == 200, (s, r))
        conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
        check('29 fallback: with no tip available the endpoint returns the stored 7',
              conf_by_id.get(arch29, {}).get('confirmations') == 7, conf_by_id.get(arch29))
        # Cleanup: stubs back to the fixed tip, tip reads working,
        # cadence back to 60.
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
        s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('29 cleanup: settings and cadence restored', s == 200, (s, r))
        delete_all_txs()

        # --- 30. staged txs go stale on the hourly refresh (0.8.7.4) ---
        # A staged tx whose inputs were spent elsewhere used to sit
        # at Ready until a dry run or a firing trigger noticed:
        # refreshConfirmations only looks at broadcasted txs, and
        # the tick only evaluates trigger rules. The hourly tick
        # now re-checks every live staged tx's inputs — a
        # confirmed spend marks it stale (release record kind
        # 'release', one 'stale' history event, a note on the
        # set's shared history for a member), an unconfirmed
        # spend changes nothing, and an already-stale tx is never
        # re-checked (the outspend counters prove it). The
        # restart's 5 s startup tick runs the hourly refresh once,
        # so the verdicts are already recorded when the state
        # below is read.
        CONFLICT = 'cc' * 32
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('30 setup: cadence parked at 3600 s', s == 200, (s, r))
        check('30 setup: caches cleared for a cold cache', clear_caches())
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 113000), 'label': 'Stale staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('30 stale: the FINNEY:0 staged tx adds', s == 201, (s, r))
        stale30 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 113001), 'label': 'Live staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('30 live: the FINNEY:1 staged tx adds', s == 201, (s, r))
        live30 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(CONFLICT, 0, 113002), 'label': 'Conflict staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('30 conflict: the CONFLICT:0 staged tx adds', s == 201, (s, r))
        conflict30 = r['tx']['id'] if s == 201 else None
        # A set with one stale member and one live member: the
        # member goes stale on its own history AND the set's
        # shared history, and the set stays live for the rest.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 113003), 'label': 'Set stale m', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('30 set: the stale member adds', s == 201, (s, r))
        sm30 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 113004), 'label': 'Set live m', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
        check('30 set: the live member adds', s == 201, (s, r))
        lm30 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 30', 'txIds': [sm30, lm30],
                  'trigger': {'type': 'manual', 'params': {}}, 'enabled': True})
        check('30 set: set created with 2 members (201)', s == 201, (s, r))
        set30 = r.get('set', {}).get('id') if s == 201 else None
        check('30 setup: app restarted (startup hourly tick is the refresh)', restart())
        # (Optimization O8) Poll until the refresh's merge has
        # marked the tx stale — the merge's observable effect,
        # not a fixed wait.
        wait_until(lambda: ((state_tx(stale30) or {}).get('release') or {}).get('status') == 'stale', deadline=5)
        t = state_tx(stale30)
        check('30 stale: the staged tx is marked stale by the hourly refresh',
              t is not None and (t.get('release') or {}).get('status') == 'stale'
              and (t.get('release') or {}).get('kind') == 'release'
              and (t.get('release') or {}).get('method') == 'primary'
              and (t.get('release') or {}).get('error', '').startswith('inputs spent: '), (t or {}).get('release'))
        check('30 stale: exactly one stale history event',
              t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
        t = state_tx(live30)
        check('30 live: the unspent staged tx is untouched (no release record, no stale event)',
              t is not None and not t.get('release')
              and 'stale' not in [e.get('type') for e in t.get('history', [])], t)
        t = state_tx(conflict30)
        check('30 conflict: the unconfirmed spend changes nothing (no release record, no stale event)',
              t is not None and not t.get('release')
              and 'stale' not in [e.get('type') for e in t.get('history', [])], t)
        t = state_tx(sm30)
        check('30 set: the stale member is marked stale on its own history',
              t is not None and (t.get('release') or {}).get('status') == 'stale'
              and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
        s, st = req('GET', '/api/state')
        setj = [x for x in st.get('bitcoin', {}).get('sets', []) if x.get('id') == set30]
        check('30 set: the set notes the stale member on its shared history, once',
              len(setj) == 1 and [e.get('type') for e in setj[0].get('history', [])].count('stale') == 1, setj[0].get('history') if setj else None)
        t = state_tx(lm30)
        check('30 set: the live member is untouched, so the set stays live',
              t is not None and not t.get('release'), t)
        # No re-check: delete everything but the stale tx, restart
        # again — the second startup hourly tick must cost ZERO
        # singular outspend requests (no live staged txs left to
        # check, and the stale one is terminal so it is skipped).
        for tid in (live30, conflict30, sm30, lm30):
            s, r = req('DELETE', '/api/bitcoin/txs/' + tid)
        p0, s0, bp0, bs0 = outspend_counts()
        check('30 no-recheck: app restarted with only the stale tx left', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('30 no-recheck: the second hourly tick costs ZERO outspend requests for the already-stale tx',
              (p1, s1, bp1, bs1) == (p0, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        t = state_tx(stale30)
        check('30 no-recheck: still exactly one stale history event after the second tick',
              t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
        # Cleanup: cadence back to 60.
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('30 cleanup: settings and cadence restored', s == 200, (s, r))
        delete_all_txs()

        # --- 31. accumulated fee peak (0.8.9) ---------------------------
        # The peak is no longer fetched from anywhere — Standby
        # records one economy-fee observation per hourly tick (the
        # startup tick counts) from the primary node, falling back
        # to the secondary, and the peak is the 90th percentile of
        # the recorded history in state.json. No public endpoint is
        # involved at any point: the current fees come from the
        # configured nodes too (mempool /fees/recommended, or
        # Esplora /fee-estimates mapped to the same tiers). At
        # most one observation per hour — a restart within the
        # hour adds nothing — and the peak needs 24 observations
        # spanning a full day, so the 25th hourly reading is the
        # first that can serve one. Esplora is exact-target-or-
        # nothing, like mempool: a map without 144 yields no
        # reading. A rate that IS present floors at 1 sat/vB (the
        # relay minimum) — Esplora estimates can drift below 1,
        # which no transaction could propagate at. A second app on port 3440 proves the live
        # behaviour — the main app's own history is already long
        # (one observation per restart), so only a seeded second
        # app gives controlled counts. The unit checks prove the
        # pure helpers without a server.
        lp_dir = '/tmp/standby-test099-accumpeak'
        lp_checkin = lp_dir + '-checkin'
        lp_port = 3440
        lp_base = 'http://127.0.0.1:%d' % lp_port
        lp_log = '/tmp/standby-test099-accumpeak-proc.log'
        app_lp = None

        def lp_state():
            s, st = req('GET', '/api/state', base=lp_base)
            return st

        def lp_bitcoin():
            return (lp_state().get('bitcoin', {}) or {})

        def lp_state_file():
            return json.load(open(os.path.join(lp_dir, 'state.json')))

        def lp_seed_state(fee_history, primary=STUB_BASE_P, secondary=STUB_BASE_S):
            # Seed the second app's state from the main app's, with
            # the node URLs pinned and the fee history replaced by
            # exactly the given observations — the main app's own
            # history is already long (one observation per restart),
            # so only an overwritten history gives controlled counts.
            shutil.rmtree(lp_dir, ignore_errors=True)
            shutil.rmtree(lp_checkin, ignore_errors=True)
            os.makedirs(lp_dir, exist_ok=True)
            st = load_state_file()
            (st.get('settings', {}) or {})['primaryApiUrl'] = primary
            (st.get('settings', {}) or {})['secondaryApiUrl'] = secondary
            st['feeHistory'] = fee_history
            json.dump(st, open(os.path.join(lp_dir, 'state.json'), 'w'), indent=2)

        def lp_start(env_extra=None):
            env = {'PORT': str(lp_port), 'DATA_DIR': lp_dir, 'CHECKIN_DIR': lp_checkin}
            if env_extra:
                env.update(env_extra)
            return start(['node', 'server.js'], env=env, cwd=APP, log=lp_log)

        def lp_wait_obs(n, deadline=15):
            # Poll until the second app has recorded at least n
            # observations (or the deadline expires); returns the
            # state bitcoin object from the last read.
            end = time.time() + deadline
            st = {}
            while time.time() < end:
                try:
                    st = lp_bitcoin()
                    if isinstance(st.get('feePeakObservations'), int) and st.get('feePeakObservations') >= n:
                        return st
                except Exception:
                    pass
                time.sleep(0.5)
            return st

        def lp_wait_current_fee(fee, deadline=15):
            # Poll until the served current economy fee equals fee
            # (the +2 s startup refresh, from the configured nodes).
            end = time.time() + deadline
            while time.time() < end:
                try:
                    cf = (lp_bitcoin().get('currentFees') or {})
                    if cf.get('economyFee') == fee:
                        return True
                except Exception:
                    pass
                time.sleep(0.5)
            return False

        def obs_hours_ago(hours, fee):
            # One observation `hours` hours ago at `fee` — the
            # timestamps the seed histories are built from.
            return {'t': iso_ago(hours=hours), 'fee': fee}

        try:
            # (a) Unit checks for the pure helpers (same pattern as
            # the 0.7.20 ladder check): percentile, minimum, window,
            # pruning, append cap, sanitizer, and the Esplora
            # mapping — without a server. The full-history fixture
            # is spaced 59 minutes apart (latest 61 minutes old)
            # so the per-hour dedupe does not block the append
            # whose cap is being proved.
            node_js = (
                "const b = require('./lib/bitcoin.js');"
                "const s = require('./lib/store.js');"
                "const now = Date.now();"
                "const h = (n) => new Date(now - n * 3600000).toISOString();"
                "const h24 = Array.from({length: 24}, (_, i) => ({ t: h(23 - i), fee: 2 }));"
                "const h25 = Array.from({length: 25}, (_, i) => ({ t: h(24 - i), fee: 2 }));"
                "const h23 = h24.slice(0, 23);"
                "const pct = Array.from({length: 25}, (_, i) => ({ t: h(24 - i), fee: i < 22 ? 1 : (i < 24 ? 2 : 10) }));"
                "const win3 = Array.from({length: 24}, (_, i) => ({ t: new Date(now - (3 * 86400000 - i * 3 * 3600000)).toISOString(), fee: 2 }));"
                "const old = [{ t: new Date(now - 91 * 86400000).toISOString(), fee: 100 }].concat(h23);"
                "const full = Array.from({length: 2160}, (_, i) => ({ t: new Date(now - (61 + i * 59) * 60000).toISOString(), fee: 2 }));"
                "const dirty = [{ t: h(1), fee: 2 }, { fee: 2 }, { t: h(1), fee: -1 }, { t: 'not-a-date', fee: 2 }, { t: new Date(now + 3600000).toISOString(), fee: 2 }, { t: new Date(now - 91 * 86400000).toISOString(), fee: 2 }];"
                "console.log(JSON.stringify({"
                " p24: b.feePeakFromObservations(h24, now),"
                " p25: b.feePeakFromObservations(h25, now),"
                " p23: b.feePeakFromObservations(h23, now),"
                " pPct: b.feePeakFromObservations(pct, now),"
                " pWin3: b.feePeakFromObservations(win3, now),"
                " pOld: b.feePeakFromObservations(old, now),"
                " pEmpty: b.feePeakFromObservations([], now),"
                " a4: b.appendFeeHistoryObservation([{t: h(3), fee: 1}, {t: h(2), fee: 1}, {t: h(1), fee: 1}], 2, now).length,"
                " aCap: b.appendFeeHistoryObservation(full, 3, now).length,"
                " aBad: b.appendFeeHistoryObservation([{t: h(1), fee: 1}], -1, now).length,"
                " aDedupe: b.appendFeeHistoryObservation([{t: h(2), fee: 1}, {t: new Date(now - 30 * 60000).toISOString(), fee: 1}], 2, now).length,"
                " sClean: s.sanitizeFeeHistory(dirty, now).length,"
                " mFull: b.feeEstimatesToRecommended({'1': 9, '2': 8, '3': 7, '6': 6, '144': 5, '1008': 1}),"
                " mSparse: b.feeEstimatesToRecommended({'6': 7}),"
                " mNear: b.feeEstimatesToRecommended({'120': 5, '168': 4}),"
                " mNull: b.feeEstimatesToRecommended({}),"
                " mSub1: b.feeEstimatesToRecommended({'1': 0.213, '2': 0.213, '3': 0.152, '6': 0.132, '144': 0.12, '1008': 0.108}),"
                " tExact: b.feeEstimateAtTarget({'6': 7, '144': 5, '1008': 1}, 144),"
                " tNear: b.feeEstimateAtTarget({'6': 7, '1008': 1}, 144),"
                " tTie: b.feeEstimateAtTarget({'143': 5, '145': 6}, 144),"
                " tSub1: b.feeEstimateAtTarget({'144': 0.12}, 144),"
                "}));"
            )
            nr = subprocess.run(['node', '-e', node_js], capture_output=True, text=True, cwd=APP, timeout=30)
            try:
                nv = json.loads(nr.stdout.strip())
            except Exception:
                nv = {}
            check('31 unit: 24 hourly observations spanning 23 hours serve no peak (a full day of coverage is required)',
                  (nv.get('p24') or {}).get('peak') is None and (nv.get('p24') or {}).get('observations') == 24, nv.get('p24'))
            check('31 unit: 25 hourly observations spanning a full day peak at 2.0 over a 1-day window',
                  (nv.get('p25') or {}).get('peak') == 2.0 and (nv.get('p25') or {}).get('windowDays') == 1
                  and (nv.get('p25') or {}).get('observations') == 25, nv.get('p25'))
            check('31 unit: 23 observations serve no peak (24-observation minimum)',
                  (nv.get('p23') or {}).get('peak') is None and (nv.get('p23') or {}).get('observations') == 23, nv.get('p23'))
            check('31 unit: the peak is a percentile, not the max ([1x22, 2, 2, 10] peaks at 1.6, not 10)',
                  abs(((nv.get('pPct') or {}).get('peak') or 0) - 1.6) < 1e-9, nv.get('pPct'))
            check('31 unit: a 3-day span windows at 3 days',
                  (nv.get('pWin3') or {}).get('windowDays') == 3, nv.get('pWin3'))
            check('31 unit: a 91-day-old observation is ignored by the peak (23 kept, no peak yet)',
                  (nv.get('pOld') or {}).get('observations') == 23 and (nv.get('pOld') or {}).get('peak') is None, nv.get('pOld'))
            check('31 unit: an empty history serves no peak, a 0-day window, 0 observations',
                  (nv.get('pEmpty') or {}).get('peak') is None and (nv.get('pEmpty') or {}).get('windowDays') == 0
                  and (nv.get('pEmpty') or {}).get('observations') == 0, nv.get('pEmpty'))
            check('31 unit: appending grows the history by one',
                  nv.get('a4') == 4, nv)
            check('31 unit: appending to a full 2,160-entry history caps it (oldest dropped)',
                  nv.get('aCap') == 2160, nv)
            check('31 unit: appending an invalid fee appends nothing',
                  nv.get('aBad') == 1, nv)
            check('31 unit: appending within an hour of the latest observation adds nothing (one observation per hour)',
                  nv.get('aDedupe') == 2, nv)
            check('31 unit: the sanitizer keeps only the one clean entry of six dirty ones',
                  nv.get('sClean') == 1, nv)
            check('31 unit: Esplora fee-estimates map exactly to the mempool tiers (144, not 6, is the economy tier)',
                  nv.get('mFull') == {'fastestFee': 9, 'halfHourFee': 7, 'hourFee': 6, 'economyFee': 5, 'minimumFee': 1}, nv.get('mFull'))
            check('31 unit: a sparse Esplora map with only a 6-block rate maps to null (no substitute tier)',
                  nv.get('mSparse') is None, nv.get('mSparse'))
            check('31 unit: a map with 120/168 but no 144 maps to null (nearest is not good enough)',
                  nv.get('mNear') is None, nv.get('mNear'))
            check('31 unit: an empty Esplora map maps to null (no economy rate, no data)',
                  nv.get('mNull') is None, nv)
            check('31 unit: the 144 target is exact when present, null when absent (no nearest-target fallback, no tie rule)',
                  nv.get('tExact') == 5 and nv.get('tNear') is None and nv.get('tTie') is None, nv)
            check('31 unit: sub-1 Esplora rates floor at 1 sat/vB (the relay minimum) — a 0.12 economy rate maps to 1, not 0.12',
                  nv.get('mSub1') == {'fastestFee': 1, 'halfHourFee': 1, 'hourFee': 1, 'economyFee': 1, 'minimumFee': 1}, nv.get('mSub1'))
            check('31 unit: feeEstimateAtTarget floors a present sub-1 rate at 1 and still returns null for a missing target',
                  nv.get('tSub1') == 1, nv.get('tSub1'))
            # (b) Fresh app: the startup hourly tick records one
            # observation from the primary stub (economyFee 1) and
            # the peak stays null — the history is still building.
            # The served state never carries the raw history.
            lp_seed_state([])
            app_lp = lp_start()
            check('31 fresh: second app (empty history) up', wait_up(lp_base))
            st = lp_wait_obs(1)
            check('31 fresh: one observation recorded by the startup tick',
                  st.get('feePeakObservations') == 1, st.get('feePeakObservations'))
            check('31 fresh: the peak stays null below 24 observations',
                  st.get('feePeak') is None, st.get('feePeak'))
            check('31 fresh: one observation spans a 0-day window',
                  st.get('feePeakWindowDays') == 0, st.get('feePeakWindowDays'))
            check('31 fresh: the served basis is fee-estimates',
                  st.get('feePeakBasis') == 'fee-estimates', st.get('feePeakBasis'))
            check('31 fresh: the served peak time is the observation time (ISO)',
                  isinstance(st.get('feePeakAt'), str) and 'T' in st.get('feePeakAt'), st.get('feePeakAt'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 fresh: the observation persists on disk (fee 1, from the primary stub)',
                  len(fh) == 1 and fh[0].get('fee') == 1, fh)
            check('31 fresh: the served peak time matches the stored observation',
                  len(fh) == 1 and fh[0].get('t') == st.get('feePeakAt'), (fh, st.get('feePeakAt')))
            check('31 fresh: the served state never carries the raw history',
                  'feeHistory' not in lp_state(), 'feeHistory' in lp_state())
            # (c) A full day of coverage serves the peak: seed 25
            # hourly readings at 2.0 spanning exactly 24 hours —
            # the startup tick adds nothing (one observation per
            # hour: the latest seed is minutes old), so the peak
            # is 2.0 over a 1-day window at boot. (Seeding 24 and
            # letting the tick record the 25th would push the span
            # a second past 24 hours, and the ceil'd window would
            # read 2 days — the span is the observations' own
            # timestamps, so the seed must carry the full day.)
            # All 25 timestamps derive from ONE base time: a
            # fresh now() per entry would skew the span a
            # millisecond past 24 hours and ceil it to 2 days.
            stop(app_lp)
            seed_base = datetime.now(timezone.utc)
            lp_seed_state([{'t': (seed_base - timedelta(hours=24 - i)).isoformat().replace('+00:00', 'Z'), 'fee': 2.0} for i in range(25)])
            app_lp = lp_start()
            check('31 25th: second app up again', wait_up(lp_base))
            time.sleep(4)  # past the 500 ms startup hourly tick
            st = lp_bitcoin()
            check('31 25th: 25 observations at boot',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            check('31 25th: the peak appears at 2.0 sat/vB',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            check('31 25th: the served window is 1 day',
                  st.get('feePeakWindowDays') == 1, st.get('feePeakWindowDays'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 25th: the startup tick adds nothing (latest seed minutes old)',
                  len(fh) == 25 and fh[-1].get('fee') == 2.0, fh[-1] if fh else fh)
            # (h) Restart survival: the history is in state.json,
            # so a restart keeps it — but the next startup tick
            # adds NOTHING (one observation per hour: the latest
            # reading is minutes old), so the count stays 25 and
            # the peak stays 2.0. Restarts cannot manufacture
            # observations.
            stop(app_lp)
            app_lp = lp_start()
            check('31 restart: second app up after restart', wait_up(lp_base))
            time.sleep(4)  # past the 500 ms startup hourly tick
            st = lp_bitcoin()
            check('31 restart: still 25 observations after the restart startup tick (dedupe: within the hour)',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            check('31 restart: the peak stays 2.0 across the restart',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 restart: the seeded entries survive (first fee still 2.0, 25th is 2.0 — no new observation)',
                  len(fh) == 25 and fh[0].get('fee') == 2.0 and fh[-1].get('fee') == 2.0, (len(fh), fh[0] if fh else None, fh[-1] if fh else None))
            # (i) Restore round-trip: the backup carries the
            # history, so restoring it keeps the peak — the verdict
            # does not reset to "still building" for a day.
            s, bak = req('POST', '/api/backup', {}, base=lp_base)
            check('31 restore: the backup carries the 25-observation history',
                  s == 200 and len((bak.get('state', {}) or {}).get('feeHistory') or []) == 25, s)
            s, r = req('POST', '/api/restore', bak, base=lp_base)
            check('31 restore: the round-trip lands (200)', s == 200, (s, r))
            st = lp_bitcoin()
            check('31 restore: the peak survives the restore (25 observations, 2.0)',
                  st.get('feePeakObservations') == 25 and st.get('feePeak') == 2.0, (st.get('feePeakObservations'), st.get('feePeak')))
            # (d) Primary-to-secondary fallback: the primary is a
            # dead port and the secondary stub's economy fee is 5 —
            # the observation still records, from the secondary,
            # and the history continues the primary's picture.
            s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_S)
            check('31 fallback: secondary stub fee set to 5', s == 200 and r.get('economyFee') == 5, (s, r))
            stop(app_lp)
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                          primary='http://127.0.0.1:9', secondary=STUB_BASE_S)
            app_lp = lp_start()
            check('31 fallback: second app (dead primary) up', wait_up(lp_base))
            st = lp_wait_obs(25)
            check('31 fallback: the observation still records with the primary dead',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            check('31 fallback: the peak still appears at 2.0',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 fallback: the recorded observation is the secondary fee (5), not the primary',
                  len(fh) == 25 and fh[-1].get('fee') == 5, fh[-1] if fh else fh)
            check('31 fallback: the current fees come from the secondary too (economy 5)',
                  lp_wait_current_fee(5), lp_bitcoin().get('currentFees'))
            s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
            check('31 fallback: secondary stub fee restored to 1', s == 200 and r.get('economyFee') == 1, (s, r))
            # (e) Both nodes fail: the hour records nothing and the
            # peak stays null — a dead hour leaves the history
            # (and the peak) unchanged, never a wrong value.
            stop(app_lp)
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                          primary='http://127.0.0.1:9', secondary='http://127.0.0.1:19998')
            open(lp_log, 'w').close()
            app_lp = lp_start()
            check('31 both-fail: second app (both nodes dead) up', wait_up(lp_base))
            time.sleep(4)  # past the 500 ms startup hourly tick
            st = lp_bitcoin()
            check('31 both-fail: still 24 observations after the startup tick (nothing recorded)',
                  st.get('feePeakObservations') == 24, st.get('feePeakObservations'))
            check('31 both-fail: the peak stays null with both nodes dead',
                  st.get('feePeak') is None, st.get('feePeak'))
            check('31 both-fail: the current fees stay null too (no data, not a guess)',
                  st.get('currentFees') is None, st.get('currentFees'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 both-fail: the stored history is untouched (24 entries)',
                  len(fh) == 24, len(fh))
            lp_log_text = open(lp_log, errors='ignore').read() if os.path.exists(lp_log) else ''
            check('31 both-fail: the skipped hour is logged',
                  'fee-history observation skipped' in lp_log_text, lp_log_text[-500:])
            # (f) Esplora mode: the primary stub 404s
            # /fees/recommended, so the app reads /fee-estimates —
            # the 144-block rate (economy 3) is the observation,
            # and the current fees map to the mempool tiers.
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
            check('31 esplora: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
            s, r = req('POST', '/__test__/fees', {'economyFee': 3}, base=STUB_BASE_P)
            check('31 esplora: primary stub economy fee set to 3', s == 200 and r.get('economyFee') == 3, (s, r))
            stop(app_lp)
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)])
            app_lp = lp_start()
            check('31 esplora: second app (esplora primary) up', wait_up(lp_base))
            st = lp_wait_obs(25)
            check('31 esplora: the observation records from the Esplora primary',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 esplora: the recorded observation is the Esplora economy fee (3)',
                  len(fh) == 25 and fh[-1].get('fee') == 3, fh[-1] if fh else fh)
            check('31 esplora: the peak is 2.0 (the 24th reading does not move it)',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            check('31 esplora: the current fees map from fee-estimates to the mempool tiers',
                  lp_wait_current_fee(3) and (lp_bitcoin().get('currentFees') or {}) == {'fastestFee': 4, 'halfHourFee': 3, 'hourFee': 3, 'economyFee': 3, 'minimumFee': 1},
                  lp_bitcoin().get('currentFees'))
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
            check('31 esplora: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
            s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
            check('31 esplora: primary stub economy fee restored to 1', s == 200 and r.get('economyFee') == 1, (s, r))
            # (g) Pruning on load: a 91-day-old observation is
            # dropped when the state loads, so it can never
            # pollute the peak — the history after the startup
            # tick is 23 kept readings + 1 new one.
            stop(app_lp)
            old_obs = {'t': iso_ago(days=91), 'fee': 100}
            lp_seed_state([old_obs] + [obs_hours_ago(24 - i, 2.0) for i in range(24)])
            app_lp = lp_start()
            check('31 prune: second app (stale history) up', wait_up(lp_base))
            st = lp_wait_obs(25)
            check('31 prune: 25 observations after load-prune + the new one',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            check('31 prune: the peak is 2.0, not polluted by the 100 sat/vB outlier',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 prune: the 91-day-old entry is gone from the stored history',
                  len(fh) == 25 and all(e.get('fee') != 100 for e in fh), [e.get('fee') for e in fh])
            # (j) Stale-state race (0.8.9 audit fix 1): the
            # recording fetches from the node before saving, so
            # hold that fetch in flight (primary stub fee-delay
            # 4 s) and disarm a tx while it is on the network —
            # the disarm must survive the recording save, and the
            # observation must still land. The tx is created on
            # the second app after boot (a manual trigger, so it
            # can never fire) — the seeded state carries no txs
            # by this point in the suite, so the test must not
            # depend on them.
            stop(app_lp)
            s, r = req('POST', '/__test__/fee-delay', {'ms': 4000}, base=STUB_BASE_P)
            check('31 race: primary stub fee delay set to 4000 ms', s == 200 and r.get('delayMs') == 4000, (s, r))
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)])
            _, rc0 = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
            race_base_count = (rc0 or {}).get('count') or 0
            app_lp = lp_start()
            check('31 race: second app up', wait_up(lp_base))
            # Wait until a fee request is in flight (the stub
            # counts it on receipt, before the delay answers) —
            # the count is cumulative, so wait for it to rise
            # past its pre-boot value. The observation fetch runs
            # ~4 s, so the edits below land well before its save.
            fee_in_flight = False
            for _ in range(20):
                try:
                    s2, r2 = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
                    if s2 == 200 and (r2.get('count') or 0) > race_base_count:
                        fee_in_flight = True
                        break
                except Exception:
                    pass
                time.sleep(0.25)
            check('31 race: a fee fetch is in flight', fee_in_flight, fee_in_flight)
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 111900), 'label': 'Race disarm', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}}, base=lp_base)
            check('31 race: the tx is created mid-fetch (201)', s == 201, (s, r))
            race_tx_id = (r or {}).get('tx', {}).get('id')
            check('31 race: the created tx has an id', isinstance(race_tx_id, str) and bool(race_tx_id), race_tx_id)
            s, r = req('PUT', '/api/bitcoin/txs/' + race_tx_id, {'enabled': False}, base=lp_base)
            check('31 race: the tx disarms mid-fetch (200, enabled False)',
                  s == 200 and r.get('tx', {}).get('enabled') is False, (s, r))
            mid = lp_bitcoin()
            check('31 race: the observation has not landed yet at edit time (fetch still in flight)',
                  (mid.get('feePeakObservations') or 0) < 25, mid.get('feePeakObservations'))
            st = lp_wait_obs(25)
            check('31 race: the observation still lands after the slow fetch',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 race: the recorded observation is the stub economy fee (1)',
                  len(fh) == 25 and fh[-1].get('fee') == 1, fh[-1] if fh else fh)
            st = lp_state()
            race_tx_now = [t for t in (st.get('bitcoin', {}) or {}).get('txs', []) if t.get('id') == race_tx_id]
            check('31 race: the mid-fetch disarm survives the recording save',
                  len(race_tx_now) == 1 and race_tx_now[0].get('enabled') is False, race_tx_now)
            s, r = req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
            check('31 race: primary stub fee delay cleared', s == 200 and r.get('delayMs') == 0, (s, r))
            # (k) Sparse Esplora map (0.8.9 audit fix 3): the
            # primary serves /fee-estimates with only a 6-block
            # rate and no 144 — exact-target-or-nothing means no
            # economy fee, so the startup tick records nothing
            # (the secondary is dead, so it cannot mask the gap).
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
            check('31 sparse: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
            s, r = req('POST', '/__test__/fee-estimates-map', {'map': {'6': 7}}, base=STUB_BASE_P)
            check('31 sparse: primary stub serves a 6-only fee-estimates map', s == 200 and r.get('map') == {'6': 7}, (s, r))
            stop(app_lp)
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                          primary=STUB_BASE_P, secondary='http://127.0.0.1:19998')
            app_lp = lp_start()
            check('31 sparse: second app up', wait_up(lp_base))
            time.sleep(4)  # past the 500 ms startup hourly tick
            st = lp_bitcoin()
            check('31 sparse: still 24 observations after the startup tick (nothing recorded)',
                  st.get('feePeakObservations') == 24, st.get('feePeakObservations'))
            check('31 sparse: the peak stays null with no usable 144',
                  st.get('feePeak') is None, st.get('feePeak'))
            check('31 sparse: the current fees stay null too (no data, not a guess)',
                  st.get('currentFees') is None, st.get('currentFees'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 sparse: the stored history is untouched (24 entries)',
                  len(fh) == 24, len(fh))
            s, r = req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
            check('31 sparse: primary stub fee-estimates map restored', s == 200 and r.get('map') is None, (s, r))
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
            check('31 sparse: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
            # (l) Sub-1 Esplora floor: the primary serves the
            # live blockstream-style /fee-estimates map (144 at
            # 0.12, fastest at 0.213 — below the 1 sat/vB relay
            # minimum, so no transaction could propagate at those
            # rates). Every tier floors at 1: the recorded
            # observation is 1, the served current economy fee is
            # 1, and the node-test value reads '1 sat/vB'.
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
            check('31 floor: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
            sub1_map = {'1': 0.213, '2': 0.213, '3': 0.152, '6': 0.132, '144': 0.12, '1008': 0.108}
            s, r = req('POST', '/__test__/fee-estimates-map', {'map': sub1_map}, base=STUB_BASE_P)
            check('31 floor: primary stub serves the sub-1 fee-estimates map', s == 200 and r.get('map') == sub1_map, (s, r))
            stop(app_lp)
            lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                          primary=STUB_BASE_P, secondary='http://127.0.0.1:19998')
            app_lp = lp_start()
            check('31 floor: second app up', wait_up(lp_base))
            time.sleep(4)  # past the 500 ms startup hourly tick
            st = lp_bitcoin()
            check('31 floor: 25 observations after the startup tick (one recorded)',
                  st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
            fh = (lp_state_file().get('feeHistory') or [])
            check('31 floor: the recorded observation is floored at 1, not 0.12',
                  len(fh) == 25 and fh[-1].get('fee') == 1, fh[-1] if fh else fh)
            check('31 floor: the peak stays 2.0 (the floored reading does not distort it)',
                  st.get('feePeak') == 2.0, st.get('feePeak'))
            check('31 floor: the served current economy fee is 1, not 0.12',
                  lp_wait_current_fee(1), (lp_bitcoin().get('currentFees') or {}))
            conn = (lp_state().get('bitcoin', {}) or {}).get('connection', {}) or {}
            prim = [x for x in (conn.get('results') or []) if x.get('endpoint') == 'primary']
            check('31 floor: the node-test value for the Esplora primary reads 1 sat/vB',
                  len(prim) == 1 and ((prim[0].get('checks') or {}).get('fees') or {}).get('value') == '1 sat/vB', prim)
            s, r = req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
            check('31 floor: primary stub fee-estimates map restored', s == 200 and r.get('map') is None, (s, r))
            s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
            check('31 floor: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
        finally:
            if app_lp is not None:
                stop(app_lp)
            # The stub fee modes and fees are reset either way, so
            # no later section (or suite) reads a doctored node.
            try:
                req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
                req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
                req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
                req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
                req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
            except Exception:
                pass

        # --- 32. audit fixes 1/3/4 (0.8.10) ---------------------------
        # (fix 1) A malformed request target gets a 400 and the
        # process keeps serving — the app server and the receiver
        # alike. (fix 3) Security headers on the page, the API, and
        # the receiver.
        s, body = raw_get('//[', BASE)
        check('32 crash: malformed request line gets 400, not a dead server',
              s == 400 and body == b'Bad request URL', (s, body))
        s, r = req('GET', '/api/health')
        check('32 crash: app still answers after the malformed request',
              s == 200 and r.get('version') == '0.8.13', (s, r))
        s, body = raw_get('//[', RBASE)
        check('32 crash: malformed request line to the receiver gets 400',
              s == 400 and body == b'Bad request URL', (s, body))
        check('32 crash: receiver still answers after the malformed request',
              wait_up(RBASE, path='/health'))
        s, hdrs = resp_headers('GET', '/', BASE)
        check('32 headers: / carries X-Frame-Options DENY',
              hdrs.get('x-frame-options') == 'DENY', hdrs)
        check('32 headers: / carries nosniff',
              hdrs.get('x-content-type-options') == 'nosniff', hdrs)
        check('32 headers: / carries the CSP (script-src self, inline styles allowed)',
              hdrs.get('content-security-policy') == CSP_0810, hdrs.get('content-security-policy'))
        s, hdrs = resp_headers('GET', '/api/health', BASE)
        check('32 headers: /api/health carries X-Frame-Options DENY',
              hdrs.get('x-frame-options') == 'DENY', hdrs)
        check('32 headers: /api/health carries nosniff',
              hdrs.get('x-content-type-options') == 'nosniff', hdrs)
        check('32 headers: /api/health carries the full CSP',
              hdrs.get('content-security-policy') == CSP_0810, hdrs.get('content-security-policy'))
        s, hdrs = resp_headers('GET', '/health', RBASE)
        check('32 headers: receiver /health carries nosniff',
              hdrs.get('x-content-type-options') == 'nosniff', hdrs)
        check('32 headers: receiver /health carries frame-ancestors only (no full CSP)',
              hdrs.get('content-security-policy') == "frame-ancestors 'self'",
              hdrs.get('content-security-policy'))
        check('32 headers: receiver /health carries no X-Frame-Options',
              'x-frame-options' not in hdrs, hdrs)

        # --- 33. audit fix 2 (Host allowlist) + fsync (0.8.10) -------
        # (fix 2) A foreign Host is a DNS-rebinding probe, not a
        # client: 421 on both servers, before routing or auth. An
        # IP literal, localhost, and a *.local name pass with zero
        # configuration; a missing Host is rejected too. (0.8.11)
        # The machine's own hostname no longer passes — it needs
        # STANDBY_ALLOWED_HOSTS, like any other hostname.
        s, body = raw_req('GET', '/api/health', BASE, host='evil.example')
        check('33 hosts: foreign Host gets 421 on the app',
              s == 421 and body == b'Unrecognised Host header', (s, body))
        s, body = raw_req('GET', '/health', RBASE, host='evil.example')
        check('33 hosts: foreign Host gets 421 on the receiver',
              s == 421 and body == b'Unrecognised Host header', (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host='127.0.0.1:3438')
        check('33 hosts: IP literal Host passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host='umbrel.local')
        check('33 hosts: umbrel.local passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host=os.uname().nodename.lower())
        check('33 hosts: machine hostname is rejected without an allowlist (0.8.11)',
              s == 421 and body == b'Unrecognised Host header', (s, body))
        check('33 hosts: missing Host header is rejected',
              raw_socket_status(b'GET /api/health HTTP/1.0\r\n\r\n', BASE) == 421)
        check('33 hosts: startup log names the allowed Hosts',
              'Standby allowed Hosts: any IP literal, localhost, *.local' in read_log(),
              read_log()[-500:])
        # STANDBY_ALLOWED_HOSTS: a second instance on port 3440
        # (§31's port — its instance is stopped by now) with two
        # extra names. The names pass, anything else still 421s,
        # and the IP-literal rule still holds with the var set.
        extra_data = '/tmp/standby-test099-extra'
        extra_checkin = '/tmp/standby-test099-extra-checkin'
        shutil.rmtree(extra_data, ignore_errors=True)
        shutil.rmtree(extra_checkin, ignore_errors=True)
        check('33 hosts: port 3440 free', port_closed(3440))
        extra_env = dict(APP_ENV)
        extra_env.update({'PORT': '3440', 'DATA_DIR': extra_data, 'CHECKIN_DIR': extra_checkin,
                          'STANDBY_ALLOWED_HOSTS': 'extra.ts.net, custom.example'})
        extra_base = 'http://127.0.0.1:3440'
        extra_app = start(['node', 'server.js'], env=extra_env, cwd=APP, log=LOG)
        check('33 hosts: STANDBY_ALLOWED_HOSTS instance comes up', wait_up(extra_base))
        s, body = raw_req('GET', '/api/health', extra_base, host='extra.ts.net')
        check('33 hosts: STANDBY_ALLOWED_HOSTS name passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', extra_base, host='custom.example')
        check('33 hosts: second STANDBY_ALLOWED_HOSTS name passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', extra_base, host='other.example')
        check('33 hosts: a name not in STANDBY_ALLOWED_HOSTS is rejected',
              s == 421, (s, body))
        s, body = raw_req('GET', '/api/health', extra_base, host='127.0.0.1:3440')
        check('33 hosts: IP literal still passes with STANDBY_ALLOWED_HOSTS set',
              s == 200, (s, body))
        stop(extra_app)
        # X-Forwarded-Host is no longer trusted: a matching Origin
        # smuggled in via XFH must not pass the CSRF gate. (Before
        # the fix, Origin evil.example + XFH evil.example passed
        # it.) A matching Origin still passes — the gate itself is
        # intact, only the forged-header bypass is gone.
        s, body = raw_req('POST', '/api/checkin', BASE, host='127.0.0.1:3438',
                          headers={'Origin': 'https://evil.example',
                                   'X-Forwarded-Host': 'evil.example',
                                   'Content-Type': 'application/json'},
                          body=b'{"method": "app"}')
        check('33 hosts: spoofed X-Forwarded-Host no longer bypasses the CSRF gate',
              s == 403, (s, body))
        s, r = req('POST', '/api/checkin', {'method': 'app'},
                   headers={'Origin': 'http://127.0.0.1:3438'})
        check('33 hosts: a matching Origin still passes the CSRF gate',
              s == 200, (s, r))
        # (fsync) A save round-trips through the file: the value
        # written via the API is the value on disk, the file loads
        # cleanly, and no .tmp file is left behind. The cadence is
        # restored to 60 afterwards (the §22 pattern).
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 33})
        check('33 fsync: settings save succeeds (200)', s == 200, (s, r))
        check('33 fsync: no state.json.tmp left behind',
              not os.path.exists(os.path.join(DATA, 'state.json.tmp')),
              os.listdir(DATA))
        _saved = {}
        try:
            _saved = load_state_file()
        except Exception:
            pass
        check('33 fsync: saved value round-trips through state.json',
              _saved.get('settings', {}).get('checkCadenceSeconds') == 33,
              _saved.get('settings', {}).get('checkCadenceSeconds'))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('33 fsync: cadence restored to 60 (200)', s == 200, (s, r))
        # (fsync, receiver) A check-in writes last.json durably:
        # the file parses with the key id, and no .tmp is left.
        s, r = req('POST', '/api/checkin-keys', {'label': '33 fsync'})
        check('33 fsync: key creates (201)', s == 201, (s, r))
        key_plain = r.get('plain') if s == 201 else None
        key_id = (r.get('key') or {}).get('id') if s == 201 else None
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
        check('33 fsync: receiver check-in succeeds (200)', s == 200 and r.get('ok') is True, (s, r))
        try:
            _last = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))
        except Exception:
            _last = {}
        check('33 fsync: last.json written with the key id',
              _last.get('keyId') == key_id, _last)
        check('33 fsync: no last.json.tmp left behind',
              not os.path.exists(os.path.join(CHECKIN_DIR, 'last.json.tmp')),
              os.listdir(CHECKIN_DIR))
        check('33 fsync: no keys.json.tmp left behind',
              not os.path.exists(os.path.join(CHECKIN_DIR, 'keys.json.tmp')),
              os.listdir(CHECKIN_DIR))
        s, r = req('DELETE', '/api/checkin-keys/' + (key_id or 'none'), base=BASE)
        check('33 fsync: key revokes (200)', s == 200, (s, r))

        # --- 34. skip-save + heartbeat (0.8.10) -------------------------
        # (a) Quiet ticks write nothing: with a watching price tx
        # (so the tick has work — it evaluates every tick) and the
        # cadence at 10 s, two full ticks leave state.json
        # byte-identical with its mtime untouched, and the
        # heartbeat unrewritten inside its 5-minute throttle. The
        # stub price/tip/fee are fixed, so nothing meaningful
        # changes — the dedupe must skip both the stamp-block save
        # and the trigger-state save.
        delete_all_txs()
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
        check('34 quiet: cadence set to 10 s', s == 200, (s, r))
        s, r = add_tx('34 quiet price', {'type': 'price', 'params': {'op': '>=', 'value': 200000}}, 121000, trigger_confirmed=True)
        check('34 quiet: watching price tx adds (201)', s == 201, (s, r))
        q34 = r['tx']['id'] if s == 201 else None
        check('34 quiet: one tick evaluates it (slice watching)',
              wait_slice(q34, {'status': 'watching'}), rule_slice(state_tx(q34)) if q34 else None)
        s, st = req('GET', '/api/state')
        check('34 quiet: no pending external check-in before the snapshot', s == 200, (s, r))
        before_bytes = open(os.path.join(DATA, 'state.json'), 'rb').read()
        before_mtime = os.path.getmtime(os.path.join(DATA, 'state.json'))
        hb_before = json.load(open(os.path.join(DATA, 'heartbeat.json')))
        hb_mtime_before = os.path.getmtime(os.path.join(DATA, 'heartbeat.json'))
        time.sleep(25)
        check('34 quiet: state.json byte-identical across two ticks',
              open(os.path.join(DATA, 'state.json'), 'rb').read() == before_bytes)
        check('34 quiet: state.json mtime untouched across two ticks',
              os.path.getmtime(os.path.join(DATA, 'state.json')) == before_mtime,
              (before_mtime, os.path.getmtime(os.path.join(DATA, 'state.json'))))
        check('34 quiet: heartbeat unrewritten inside its throttle',
              os.path.getmtime(os.path.join(DATA, 'heartbeat.json')) == hb_mtime_before
              and json.load(open(os.path.join(DATA, 'heartbeat.json'))) == hb_before)
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('34 quiet: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()
        # (b) A grace activation still writes: backdate the clock
        # 10 days (flat leg) with an armed 35-day check-in tx, drop
        # the heartbeat and the receiver's last.json so the seeded
        # clock survives (the §22 pattern), restart, and the
        # startup tick's grace must persist to state.json.
        s, r = add_tx('34 gap checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 121002)
        check('34 grace: gap check-in tx adds (201)', s == 201, (s, r))
        seed_mtime = []
        def seed_gap_34():
            try:
                os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
            except OSError:
                pass
            stj = load_state_file()
            stj['checkin']['lastCheckinAt'] = iso_ago(days=20)
            stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
            save_state_file(stj)  # also drops heartbeat.json
            seed_mtime.append(os.path.getmtime(os.path.join(DATA, 'state.json')))
        check('34 grace: app restarted with a 10-day gap', restart(before_start=seed_gap_34))
        s, st = req('GET', '/api/state')
        check('34 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
        gap_file = load_state_file()
        check('34 grace: activation persisted to state.json (graceUntil set)',
              isinstance((gap_file.get('grace') or {}).get('graceUntil'), str), gap_file.get('grace'))
        check('34 grace: state.json mtime advanced on the activation',
              seed_mtime and os.path.getmtime(os.path.join(DATA, 'state.json')) > seed_mtime[0],
              (seed_mtime, os.path.getmtime(os.path.join(DATA, 'state.json'))))
        # (c) The heartbeat advances across a restart, and the
        # served lastOnlineAt is the merged heartbeat value.
        hb1 = json.load(open(os.path.join(DATA, 'heartbeat.json')))
        check('34 heartbeat: heartbeat exists with a recent value after the gap restart',
              isinstance(hb1.get('lastOnlineAt'), str)
              and abs((datetime.now(timezone.utc) - datetime.fromisoformat(hb1['lastOnlineAt'].replace('Z', '+00:00'))).total_seconds()) < 120, hb1)
        check('34 heartbeat: app restarted', restart())
        hb2 = json.load(open(os.path.join(DATA, 'heartbeat.json')))
        check('34 heartbeat: heartbeat advances across a restart',
              isinstance(hb2.get('lastOnlineAt'), str) and hb2['lastOnlineAt'] > hb1['lastOnlineAt'], (hb1, hb2))
        s, st = req('GET', '/api/state')
        check('34 heartbeat: served lastOnlineAt is the merged heartbeat value',
              st.get('checkin', {}).get('lastOnlineAt') == hb2['lastOnlineAt'],
              (st.get('checkin', {}).get('lastOnlineAt'), hb2))
        s, r = req('POST', '/api/grace/resume', {})
        check('34 grace: resumed after the checks', s == 200, (s, r))
        delete_all_txs()
        # (d) SIGTERM flush: a fresh instance on port 3440, its
        # heartbeat deleted, SIGTERM at once — the next tick is up
        # to 60 s away, so only the flush can recreate the file —
        # and the process must exit 0.
        sig_data = '/tmp/standby-test099-sigterm'
        sig_checkin = '/tmp/standby-test099-sigterm-checkin'
        shutil.rmtree(sig_data, ignore_errors=True)
        shutil.rmtree(sig_checkin, ignore_errors=True)
        check('34 sigterm: port 3440 free', port_closed(3440))
        sig_env = dict(APP_ENV)
        sig_env.update({'PORT': '3440', 'DATA_DIR': sig_data, 'CHECKIN_DIR': sig_checkin})
        sig_base = 'http://127.0.0.1:3440'
        sig_app = start(['node', 'server.js'], env=sig_env, cwd=APP, log=LOG)
        check('34 sigterm: instance comes up', wait_up(sig_base))
        try:
            os.remove(os.path.join(sig_data, 'heartbeat.json'))
        except OSError:
            pass
        sig_app.send_signal(signal.SIGTERM)
        try:
            sig_code = sig_app.wait(timeout=5)
        except subprocess.TimeoutExpired:
            sig_code = None
            stop(sig_app)
        check('34 sigterm: process exits 0 on SIGTERM', sig_code == 0, sig_code)
        try:
            hb_sig = json.load(open(os.path.join(sig_data, 'heartbeat.json')))
            hb_sig_at = hb_sig.get('lastOnlineAt')
        except Exception:
            hb_sig_at = None
        check('34 sigterm: SIGTERM flush lands the heartbeat',
              isinstance(hb_sig_at, str)
              and abs((datetime.now(timezone.utc) - datetime.fromisoformat(hb_sig_at.replace('Z', '+00:00'))).total_seconds()) < 30, hb_sig_at)
        # (e) Missing/corrupt heartbeat falls back to the state's
        # own lastOnlineAt — checked directly against lib/store.js
        # in a scratch data dir (no server: the running server
        # rewrites the heartbeat on its first tick, so a live test
        # could not observe the fallback). The dedupe itself is
        # pinned the same way: an identical save skips, a real
        # change writes.
        hb_dir = '/tmp/standby-test099-heartbeat'
        shutil.rmtree(hb_dir, ignore_errors=True)
        os.makedirs(hb_dir)
        hb_seed = load_state_file()
        hb_seed['checkin']['lastOnlineAt'] = iso_ago(days=2)
        json.dump(hb_seed, open(os.path.join(hb_dir, 'state.json'), 'w'), indent=2)
        open(os.path.join(hb_dir, 'heartbeat.json'), 'w').write('{not json')

        def node_out(script):
            rr = subprocess.run(['node', '-e', script], cwd=APP, capture_output=True, text=True, timeout=20)
            return rr.stdout.strip(), rr.stderr.strip()
        node_load = ("const s=require('./lib/store');"
                     "console.log(s.loadState(%s).checkin.lastOnlineAt);" % json.dumps(hb_dir))
        out, err = node_out(node_load)
        check('34 fallback: corrupt heartbeat falls back to state.lastOnlineAt',
              out == hb_seed['checkin']['lastOnlineAt'], out + err)
        os.remove(os.path.join(hb_dir, 'heartbeat.json'))
        out, err = node_out(node_load)
        check('34 fallback: missing heartbeat falls back to state.lastOnlineAt',
              out == hb_seed['checkin']['lastOnlineAt'], out + err)
        hb_new = iso_ago(minutes=5)
        json.dump({'lastOnlineAt': hb_new}, open(os.path.join(hb_dir, 'heartbeat.json'), 'w'))
        out, err = node_out(node_load)
        check('34 fallback: newer heartbeat wins the merge', out == hb_new, out + err)
        hb_old = iso_ago(days=3)
        json.dump({'lastOnlineAt': hb_old}, open(os.path.join(hb_dir, 'heartbeat.json'), 'w'))
        out, err = node_out(node_load)
        check('34 fallback: older heartbeat loses to state.lastOnlineAt',
              out == hb_seed['checkin']['lastOnlineAt'], out + err)
        node_dedupe = ("const fs=require('fs');const s=require('./lib/store');"
                       "const d=%s;const st=s.loadState(d);"
                       "s.saveState(d, st);const m1=fs.statSync(d+'/state.json').mtimeMs;"
                       "s.saveState(d, st);const m2=fs.statSync(d+'/state.json').mtimeMs;"
                       "st.settings.checkCadenceSeconds=61;s.saveState(d, st);"
                       "const m3=fs.statSync(d+'/state.json').mtimeMs;"
                       "console.log(m1===m2 ? 'SKIP' : 'WROTE', m3>m2 ? 'WROTE-ON-CHANGE' : 'NO-WRITE');"
                       % json.dumps(hb_dir))
        out, err = node_out(node_dedupe)
        check('34 dedupe: identical save skips, a real change writes',
              out == 'SKIP WROTE-ON-CHANGE', out + err)
        # The cache must not survive an out-of-band edit: the DOM
        # suite caught Resume doing nothing after a directly-seeded
        # grace, because the cache still held the cleared grace
        # from the previous Resume and the restoring mutation
        # compared equal. Seed an active grace by writing the
        # file directly (bypassing saveState), then restore the
        # cached cleared grace through saveState: the mtime+size
        # validation must force the write.
        node_oob = ("const fs=require('fs');const s=require('./lib/store');"
                    "const d=%s;const st=s.loadState(d);"
                    "st.grace={graceUntil:null,triggeredAt:null,offlineGapDays:null};"
                    "s.saveState(d, st);const m1=fs.statSync(d+'/state.json').mtimeMs;"
                    "s.saveState(d, st);const m2=fs.statSync(d+'/state.json').mtimeMs;"
                    "const oob=s.loadState(d);"
                    "oob.grace={graceUntil:null,triggeredAt:new Date().toISOString(),offlineGapDays:12};"
                    "fs.writeFileSync(d+'/state.json', JSON.stringify(oob, null, 2)+'\\n');"
                    "const back=s.loadState(d);"
                    "back.grace={graceUntil:null,triggeredAt:null,offlineGapDays:null};"
                    "s.saveState(d, back);const m3=fs.statSync(d+'/state.json').mtimeMs;"
                    "console.log(m1===m2 ? 'SKIP' : 'WROTE', m3>m2 ? 'WROTE-AFTER-OOB' : 'SKIPPED-AFTER-OOB');"
                    % json.dumps(hb_dir))
        out, err = node_out(node_oob)
        check('34 dedupe: an out-of-band edit invalidates the cache (Resume-after-seed writes)',
              out == 'SKIP WROTE-AFTER-OOB', out + err)

        # --- 35. 0.8.10 follow-ups ------------------------------------
        # (a) A future-dated heartbeat must not suppress a grace:
        # seed an 8-day-stale state stamp with a heartbeat 2 days
        # in the future, restart, and the grace must activate on
        # the flat 7-day leg. Before the fix the merge took the
        # future stamp (a negative gap reads as no gap at all) and
        # the first tick could fire a due transaction.
        s, r = add_tx('35 future heartbeat', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 121004)
        check('35 clamp: gap check-in tx adds (201)', s == 201, (s, r))
        def seed_future_hb_35():
            try:
                os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
            except OSError:
                pass
            stj = load_state_file()
            stj['checkin']['lastCheckinAt'] = iso_ago(days=20)
            stj['checkin']['lastOnlineAt'] = iso_ago(days=8)
            save_state_file(stj)  # also drops heartbeat.json
            json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(DATA, 'heartbeat.json'), 'w'))
        check('35 clamp: app restarted with a future heartbeat over an 8-day gap', restart(before_start=seed_future_hb_35))
        s, st = req('GET', '/api/state')
        check('35 clamp: the grace is active despite the future heartbeat', st.get('grace', {}).get('active') is True, st.get('grace'))
        check('35 clamp: served lastOnlineAt is not the future stamp',
              isinstance(st.get('checkin', {}).get('lastOnlineAt'), str)
              and st['checkin']['lastOnlineAt'] <= iso_in(minutes=6),
              st.get('checkin', {}).get('lastOnlineAt'))
        s, r = req('POST', '/api/grace/resume', {})
        check('35 clamp: resumed after the checks', s == 200, (s, r))
        delete_all_txs()
        # (b) The clamp, pinned directly against lib/store.js in a
        # scratch data dir (the §34(e) pattern): a future
        # heartbeat is ignored, a future state stamp is capped,
        # and both future together cap too — the documented
        # residual, which activates no grace until the heartbeat
        # rewrites correctly.
        cl_dir = '/tmp/standby-test099-clamp'
        shutil.rmtree(cl_dir, ignore_errors=True)
        os.makedirs(cl_dir)
        cl_seed = load_state_file()
        cl_seed['checkin']['lastOnlineAt'] = iso_ago(days=8)
        cl_seed['grace'] = {'graceUntil': None, 'triggeredAt': None, 'offlineGapDays': None}
        json.dump(cl_seed, open(os.path.join(cl_dir, 'state.json'), 'w'), indent=2)
        json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(cl_dir, 'heartbeat.json'), 'w'))
        node_load = ("const s=require('./lib/store');"
                     "console.log(s.loadState(%s).checkin.lastOnlineAt);" % json.dumps(cl_dir))
        out, err = node_out(node_load)
        check('35 clamp: future heartbeat ignored, state stamp stands',
              out == cl_seed['checkin']['lastOnlineAt'], out + err)
        node_grace = ("const s=require('./lib/store');const c=require('./lib/checkin');"
                      "const d=%s;const st=s.loadState(d);"
                      "console.log(c.applyGrace(st, new Date()) ? 'GRACE' : 'NO-GRACE');"
                      % json.dumps(cl_dir))
        out, err = node_out(node_grace)
        check('35 clamp: grace activates on the merged 8-day gap', out == 'GRACE', out + err)
        cl_seed['checkin']['lastOnlineAt'] = iso_in(days=1)
        json.dump(cl_seed, open(os.path.join(cl_dir, 'state.json'), 'w'), indent=2)
        os.remove(os.path.join(cl_dir, 'heartbeat.json'))
        out, err = node_out(node_load)
        try:
            _cap = datetime.fromisoformat(out.replace('Z', '+00:00'))
        except Exception:
            _cap = None
        check('35 clamp: future state stamp capped at now + 5 minutes',
              _cap is not None and datetime.now(timezone.utc) < _cap <= datetime.now(timezone.utc) + timedelta(minutes=6),
              out + err)
        json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(cl_dir, 'heartbeat.json'), 'w'))
        out, err = node_out(node_load)
        try:
            _cap2 = datetime.fromisoformat(out.replace('Z', '+00:00'))
        except Exception:
            _cap2 = None
        check('35 clamp: both future together still cap at now + 5 minutes',
              _cap2 is not None and datetime.now(timezone.utc) < _cap2 <= datetime.now(timezone.utc) + timedelta(minutes=6),
              out + err)
        out, err = node_out(node_grace)
        check('35 clamp: both future together activate no grace (documented residual)', out == 'NO-GRACE', out + err)
        # (c) The heartbeat throttle treats a backward clock jump
        # as expired: write, confirm the immediate re-touch is
        # throttled, jump the fake clock back 10 days, and the
        # next touch writes.
        node_throttle = ("const s=require('./lib/store');const fs=require('fs');"
                         "const d=%s;fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true});"
                         "let now=Date.now();const real=Date.now;Date.now=()=>now;"
                         "const iso=(ms)=>new Date(ms).toISOString();"
                         "const a=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                         "const b=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                         "now-=10*24*3600*1000;"
                         "const c=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                         "Date.now=real;console.log(a+' '+b+' '+c);"
                         % json.dumps('/tmp/standby-test099-throttle'))
        out, err = node_out(node_throttle)
        check('35 throttle: write, throttled re-touch, backward jump writes again',
              out == 'WROTE SKIP WROTE', out + err)
        # (d) Trailing-dot hostnames: "localhost." IS localhost
        # and "umbrel.local." IS umbrel.local (a trailing dot
        # marks a fully-qualified name), so both pass; a bare "."
        # is empty after the strip and still gets a 421.
        s, body = raw_req('GET', '/api/health', BASE, host='localhost.')
        check('35 hosts: localhost. passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host='umbrel.local.')
        check('35 hosts: umbrel.local. passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host='localhost.:3438')
        check('35 hosts: localhost. with a port passes', s == 200, (s, body))
        s, body = raw_req('GET', '/api/health', BASE, host='.')
        check('35 hosts: bare . is still rejected',
              s == 421 and body == b'Unrecognised Host header', (s, body))
        s, body = raw_req('GET', '/health', RBASE, host='localhost.')
        check('35 hosts: localhost. passes on the receiver', s == 200, (s, body))
        # (e) The JSONL logs are durable: a live app check-in
        # lands in checkins.jsonl with no .tmp left behind, and
        # the node round-trip (append + full rewrite) reads back
        # what was written.
        s, r = req('POST', '/api/checkin', {'method': 'app'}, headers={'Origin': 'http://127.0.0.1:3438'})
        check('35 jsonl: app check-in succeeds (200)', s == 200, (s, r))
        _log = os.path.join(DATA, 'checkins.jsonl')
        try:
            _rows = [json.loads(x) for x in open(_log).read().split('\n') if x.strip()]
        except Exception:
            _rows = []
        check('35 jsonl: check-in lands in checkins.jsonl',
              any(x.get('method') == 'app' for x in _rows), _rows[-3:] if _rows else None)
        check('35 jsonl: no checkins.jsonl.tmp left behind',
              not os.path.exists(_log + '.tmp'), os.listdir(DATA))
        node_jsonl = ("const s=require('./lib/store');const fs=require('fs');"
                      "const d=%s;fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true});"
                      "s.appendCheckin(d,{ts:'2026-11-23T00:00:00.000Z',method:'t1'});"
                      "s.appendCheckin(d,{ts:'2026-11-23T00:01:00.000Z',method:'t2'});"
                      "const a=s.readCheckins(d,50);"
                      "s.writeCheckins(d,[{ts:'2026-11-23T00:02:00.000Z',method:'w'}]);"
                      "const b=s.readCheckins(d,50);"
                      "const tmp=!fs.existsSync(d+'/checkins.jsonl.tmp');"
                      "console.log(a.length===2&&a[1].method==='t2'&&b.length===1&&b[0].method==='w'&&tmp?'OK':'FAIL');"
                      % json.dumps('/tmp/standby-test099-jsonl'))
        out, err = node_out(node_jsonl)
        check('35 jsonl: append + rewrite round-trip with no .tmp', out == 'OK', out + err)
        # --- 36. uncaught exception (0.8.10 audit fix) ----------------
        # An uncaught exception terminates the process
        # (uncaughtExceptionMonitor) instead of serving through
        # it: a scratch app server and a scratch receiver, each
        # hit with its test-only throw hook, must exit nonzero
        # with the log line recorded, and their ports must close.
        # (The request-level 400 handling for a malformed URL
        # is untouched — §32 still covers it.)
        uc_data = '/tmp/standby-test099-uncaught'
        uc_checkin = '/tmp/standby-test099-uncaught-checkin'
        uc_log = '/tmp/standby-test099-uncaught.log'
        shutil.rmtree(uc_data, ignore_errors=True)
        shutil.rmtree(uc_checkin, ignore_errors=True)
        uc_env = dict(APP_ENV)
        uc_env.update({'PORT': '3440', 'DATA_DIR': uc_data, 'CHECKIN_DIR': uc_checkin})
        uc = start(['node', 'server.js'], env=uc_env, cwd=APP, log=uc_log)
        check('36 uncaught: scratch app server starts', wait_up('http://127.0.0.1:3440'))
        s, r = req('POST', '/api/__test__/throw-uncaught', {}, base='http://127.0.0.1:3440')
        check('36 uncaught: app hook answers 200', s == 200, (s, r))
        check('36 uncaught: app server exits on an uncaught exception',
              wait_until(lambda: uc.poll() is not None, deadline=10), uc.poll())
        check('36 uncaught: app exit code is nonzero',
              uc.poll() not in (None, 0), uc.poll())
        _uc_log = open(uc_log).read() if os.path.exists(uc_log) else ''
        check('36 uncaught: app log records the exception',
              'uncaught exception:' in _uc_log, _uc_log[-300:] if _uc_log else None)
        check('36 uncaught: scratch app port is closed again', port_closed(3440))
        rc_log = '/tmp/standby-test099-uncaught-recv.log'
        rc = start(['node', 'server.js'], env={'PORT': '3441', 'CHECKIN_DIR': uc_checkin},
                   cwd=os.path.join(APP, 'checkin-receiver'), log=rc_log)
        check('36 uncaught: scratch receiver starts', wait_up('http://127.0.0.1:3441', path='/health'))
        s, r = req('POST', '/__test__/throw-uncaught', {}, base='http://127.0.0.1:3441')
        check('36 uncaught: receiver hook answers 200', s == 200, (s, r))
        check('36 uncaught: receiver exits on an uncaught exception',
              wait_until(lambda: rc.poll() is not None, deadline=10), rc.poll())
        check('36 uncaught: receiver exit code is nonzero',
              rc.poll() not in (None, 0), rc.poll())
        _rc_log = open(rc_log).read() if os.path.exists(rc_log) else ''
        check('36 uncaught: receiver log records the exception',
              'uncaught exception:' in _rc_log, _rc_log[-300:] if _rc_log else None)
        check('36 uncaught: scratch receiver port is closed again', port_closed(3441))
        # --- 37. Generic outspend negotiation (0.8.10) -----------------
        # Mempool-compatible APIs differ in which outspend endpoints
        # they serve: mempool.space and Esplora serve both the batch
        # /outspends and the singular /outspend/:vout; a self-hosted
        # mempool backend v3 serves only the batch; some other
        # implementation may serve only the singular. The client
        # must not assume any inventory: it tries the batch first,
        # falls back to the singular on a route-missing signal, and
        # remembers per node which shape worked. Proved with the
        # stub's outspend-mode hook (POST /__test__/outspend-mode).
        # Cadence is parked at 3600 s so the TTL window is wide and
        # only this section's evaluations move the counters. The
        # modes are restored to 'both' at the end so nothing leaks
        # into later sections.
        def set_outspend_mode(mode, base):
            s, r = req('POST', '/__test__/outspend-mode', {'mode': mode}, base=base)
            return s == 200 and r.get('mode') == mode
        def trig_utxo(outpoint, confs=1):
            return req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': outpoint, 'confirmations': confs}}})
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('37 setup: cadence parked at 3600 s', s == 200, (s, r))
        check('37 setup: caches cleared for a cold outpoint cache', clear_caches())
        # (a) Batch-only node (the self-hosted v3 shape): a lone
        # watched output is answered by the batch, zero singular.
        check('37 batch-only: primary stub serves batch only', set_outspend_mode('batch', STUB_BASE_P))
        check('37 batch-only: secondary stub serves both', set_outspend_mode('both', STUB_BASE_S))
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = trig_utxo(FINNEY + ':1')
        check('37 batch-only: trigger check runs', s == 200, (s, r))
        check('37 batch-only: the unspent outpoint reads watching (not due, no fire)',
              r.get('status') == 'watching' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 batch-only: ONE batch request, primary only, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # (b) Singular-only node: the batch 404s, the singular
        # answers — and the second lookup goes singular-first,
        # proving the shape is learned per base (no second batch
        # call). The caches are cleared between the lookups so the
        # second one fetches fresh; the learned shape survives a
        # cache clear (it is capability state, reset only by a
        # restart).
        check('37 singular-only: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
        check('37 singular-only: caches cleared for a cold outpoint cache', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = trig_utxo(FINNEY + ':1')
        check('37 singular-only: first trigger check runs', s == 200, (s, r))
        check('37 singular-only: the unspent outpoint reads watching',
              r.get('status') == 'watching' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 singular-only: first lookup costs ONE batch 404 + ONE singular request, primary only',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        check('37 singular-only: caches cleared again (shape record survives)', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = trig_utxo(FINNEY + ':1')
        check('37 singular-only: second trigger check runs', s == 200, (s, r))
        check('37 singular-only: the second lookup still reads watching',
              r.get('status') == 'watching' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 singular-only: second lookup goes singular-first — ONE singular request, ZERO batch',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # (c) Neither shape: both routes 404 on both nodes — the
        # rule reads unknown and never fires. The primary, whose
        # shape was learned as singular-only in (b), tries its
        # singular first (one singular, zero batch); the secondary
        # tries the batch first, then the singular.
        check('37 neither: primary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_P))
        check('37 neither: secondary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_S))
        check('37 neither: caches cleared for a cold outpoint cache', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = trig_utxo(FINNEY + ':1')
        check('37 neither: trigger check runs', s == 200, (s, r))
        check('37 neither: the unreadable outpoint reads unknown, never fires',
              r.get('status') == 'unknown' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 neither: primary one singular / zero batch, secondary one batch + one singular',
              (p1, s1, bp1, bs1) == (p0 + 1, s0 + 1, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # (d) The rule evaluation's batch path falls through to the
        # singular when both nodes are singular-only: two txs watch
        # FINNEY:0 (spent) and FINNEY:1 (unspent); the startup tick
        # must read them due and watching. The batch is attempted on
        # both nodes first (one 404 each), then the singular answers
        # both outpoints on the primary. (The restart also resets
        # the learned shape record, so this proves the fall-through
        # itself, not the record.)
        check('37 fallthrough: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
        check('37 fallthrough: secondary stub serves singular only', set_outspend_mode('singular', STUB_BASE_S))
        s, r = add_tx('UTXO 37a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111700, True)
        check('37 fallthrough: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
        utxo_37a = r['tx']['id'] if s == 201 else None
        s, r = add_tx('UTXO 37b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111701)
        check('37 fallthrough: second same-funding-tx tx adds', s == 201, (s, r))
        utxo_37b = r['tx']['id'] if s == 201 else None
        for tid in (utxo_37a, utxo_37b):
            s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
        check('37 fallthrough: both txs disarm', s == 200, (s, r))
        p0, s0, bp0, bs0 = outspend_counts()
        check('37 fallthrough: app restarted (cold shape record, startup tick is the measured evaluation)', restart())
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 fallthrough: the tick costs ONE batch 404 per node + TWO singular requests on the primary',
              (p1, s1, bp1, bs1) == (p0 + 2, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        t = state_tx(utxo_37a)
        check('37 fallthrough: the spent output reads due (11 confirmations)',
              rule_slice(t).get('status') == 'due', rule_slice(t))
        t = state_tx(utxo_37b)
        check('37 fallthrough: the unspent output reads watching',
              rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
        delete_all_txs()
        # (e) A 500 on the batch still throws — no fallback for a
        # server error. The primary is batch-only and failing; the
        # secondary is both and healthy, so the check still reads
        # watching via the secondary — but the primary must show
        # exactly one batch request and ZERO singular ones (the
        # 500 never triggered the singular fallback).
        check('37 no-fallback-on-500: app restarted (cold shape record)', restart())
        check('37 no-fallback-on-500: primary stub serves batch only', set_outspend_mode('batch', STUB_BASE_P))
        check('37 no-fallback-on-500: secondary stub serves both', set_outspend_mode('both', STUB_BASE_S))
        s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_P)
        check('37 no-fallback-on-500: primary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
        check('37 no-fallback-on-500: caches cleared for a cold outpoint cache', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = trig_utxo(FINNEY + ':1')
        check('37 no-fallback-on-500: trigger check runs', s == 200, (s, r))
        check('37 no-fallback-on-500: the check still reads watching (secondary answers)',
              r.get('status') == 'watching' and r.get('fire') is False, r)
        p1, s1, bp1, bs1 = outspend_counts()
        check('37 no-fallback-on-500: the primary shows ONE batch 500 and ZERO singular (no fallback on a server error)',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_P)
        check('37 no-fallback-on-500: primary stub failure cleared', s == 200, (s, r))
        # Cleanup: both stubs serve both shapes again, cadence back
        # to 60.
        check('37 cleanup: primary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_P))
        check('37 cleanup: secondary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_S))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('37 cleanup: cadence restored to 60 s', s == 200, (s, r))
        delete_all_txs()
        # --- 38. Output lookup node status check (0.8.10) --------------
        # The connection test gains a fourth capability, Output
        # lookup: the probe asks the node for the spend status of
        # the genesis coinbase output (a fixed, well-known outpoint
        # every synced node knows), through the §37 negotiation —
        # batch first, singular as fallback — and reports which
        # shape answered. Cadence is parked at 3600 s so no tick
        # fires mid-section and moves the outspend counters; the
        # caches are cleared before each shape flip so the probe
        # fetches fresh (the shape record survives a cache clear —
        # it is capability state, reset only by a restart).
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
        check('38 setup: cadence parked at 3600 s', s == 200, (s, r))
        check('38 setup: caches cleared for a cold outpoint cache', clear_caches())
        # Baseline (both shapes served): the probe answers via the
        # batch on both nodes, and both nodes are OK with all four
        # checks ready.
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        check('38 baseline: connection test returns 200', s == 200, (s, r))
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('38 baseline: primary output lookup reads Batch and the node is OK',
              res.get('primary', {}).get('status') == 'ok'
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Batch',
              res.get('primary', {}).get('checks', {}).get('outputLookup'))
        check('38 baseline: secondary output lookup reads Batch too',
              res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Batch',
              res.get('secondary', {}).get('checks', {}).get('outputLookup'))
        p1, s1, bp1, bs1 = outspend_counts()
        check('38 baseline: the probe costs ONE batch request per node, zero singular',
              (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # Singular-only node (the shape a node serves when it has
        # no batch route): the batch 404s, the singular answers,
        # and the value names it — the node is still OK.
        check('38 singular-only: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
        check('38 singular-only: caches cleared for a cold outpoint cache', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('38 singular-only: primary output lookup reads Singular and the node stays OK',
              res.get('primary', {}).get('status') == 'ok'
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Singular',
              res.get('primary', {}).get('checks', {}).get('outputLookup'))
        p1, s1, bp1, bs1 = outspend_counts()
        check('38 singular-only: the probe costs ONE batch 404 + ONE singular on the primary, ONE batch on the secondary',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # The learned shape survives a cache clear: the second
        # probe goes singular-first — ONE singular, ZERO batch on
        # the primary — and still reads Singular.
        check('38 singular-only: caches cleared again (shape record survives)', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('38 singular-only: the second probe still reads Singular',
              res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Singular',
              res.get('primary', {}).get('checks', {}).get('outputLookup'))
        p1, s1, bp1, bs1 = outspend_counts()
        check('38 singular-only: the second probe costs ONE singular, ZERO batch on the primary',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # Neither shape: both routes 404 on the primary — the
        # check reads Unavailable with the reason as its value,
        # the node drops to CAUTION (height still works), and the
        # tooltip names the missing capability plainly. Overall ok
        # stays true: the height probe passed, so the node is usable.
        check('38 neither: primary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_P))
        check('38 neither: caches cleared for a cold outpoint cache', clear_caches())
        p0, s0, bp0, bs0 = outspend_counts()
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        check('38 neither: primary output lookup reads Unavailable and the node is CAUTION',
              res.get('primary', {}).get('status') == 'caution'
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False
              and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
              res.get('primary', {}).get('checks', {}).get('outputLookup'))
        check('38 neither: the CAUTION tooltip names the missing capability plainly',
              res.get('primary', {}).get('detail') == 'Height OK, but output lookup is unavailable — UTXO rules cannot be evaluated against this node.',
              res.get('primary', {}).get('detail'))
        check('38 neither: overall ok stays true with a CAUTION node', r.get('ok') is True, r.get('ok'))
        check('38 neither: secondary stays OK',
              res.get('secondary', {}).get('status') == 'ok', res.get('secondary'))
        p1, s1, bp1, bs1 = outspend_counts()
        check('38 neither: the probe costs ONE singular, ZERO batch on the primary (recorded singular-only, 404 returns at once)',
              (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
        # Cleanup: the primary serves both shapes again, cadence
        # back to 60, and the app restarts so the learned
        # singular-only record does not leak past this section.
        check('38 cleanup: primary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_P))
        s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
        check('38 cleanup: cadence restored to 60 s', s == 200, (s, r))
        check('38 cleanup: app restarted (cold shape record)', restart())

        # --- 39. secure defaults: STANDBY_BIND + startup security notes
        # (0.8.11, reworked 0.8.11.1). The code default bind is
        # loopback (127.0.0.1): a bare `node server.js` run is not
        # exposed to the LAN. Both compose files set
        # STANDBY_BIND=0.0.0.0; the Umbrel profile runs the main
        # instance that way (see APP_ENV above), so this section also
        # proves the main instance's own listen line names the
        # profile bind. (0.8.11.1) The startup warning is about the
        # app LOGIN, not the Host allowlist: it fires when the API is
        # reachable without one — a non-loopback bind outside Docker,
        # or any Umbrel install — and never because of
        # STANDBY_ALLOWED_HOSTS (which only widens access). The
        # generic Docker install gets an info line instead (its port
        # is host-loopback-mapped). The receiver logs no warning (it
        # is meant for the LAN, and every check-in needs a key).
        _bind_log = '/tmp/standby-test099-bind.log'
        _bind_data = '/tmp/standby-test099-bind'
        _bind_checkin = '/tmp/standby-test099-bind-checkin'
        _expected_bind = APP_ENV.get('STANDBY_BIND', '127.0.0.1')
        check('39 bind: main instance listen line names the profile bind',
              ('Standby 0.8.13 listening on %s:%d (data: ' % (_expected_bind, PORT)) in read_log(),
              read_log()[-500:])

        def _bind_log_text():
            try:
                return open(_bind_log).read()
            except OSError:
                return ''

        def _fresh_bind_log():
            # start() appends — truncate so each instance's warning
            # (or its absence) is judged on its own log, not on an
            # earlier instance's lines.
            open(_bind_log, 'wb').close()

        def _bind_instance(extra, drop=()):
            shutil.rmtree(_bind_data, ignore_errors=True)
            shutil.rmtree(_bind_checkin, ignore_errors=True)
            _fresh_bind_log()
            e = dict(APP_ENV)
            e.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin})
            for k in ('STANDBY_ALLOWED_HOSTS', 'STANDBY_PASSWORD', 'STANDBY_DEPLOYMENT') + tuple(drop):
                e.pop(k, None)
            e.update(extra)
            return start(['node', 'server.js'], env=e, cwd=APP, log=_bind_log)

        _NO_LOGIN_WARN = 'WARNING: listening on 0.0.0.0 with no app login'
        # (a) 0.0.0.0, no password, bare: warns, and still answers.
        _bind_app = _bind_instance({'STANDBY_BIND': '0.0.0.0'})
        check('39 warn: 0.0.0.0 instance comes up', wait_up('http://127.0.0.1:3440'))
        s, body = raw_req('GET', '/api/health', 'http://127.0.0.1:3440', host='127.0.0.1:3440')
        check('39 warn: 0.0.0.0 instance answers on 127.0.0.1', s == 200, (s, body))
        check('39 warn: 0.0.0.0 with no password logs the no-login warning',
              _NO_LOGIN_WARN in _bind_log_text(), _bind_log_text()[-500:])
        check('39 warn: the listen line names the deployment (bare)',
              'deployment: bare)' in _bind_log_text(), _bind_log_text()[-500:])
        stop(_bind_app)
        # (b) An allowlist does NOT silence it (it widens access).
        _bind_app = _bind_instance({'STANDBY_BIND': '0.0.0.0', 'STANDBY_ALLOWED_HOSTS': 'bind.example'})
        check('39 warn: 0.0.0.0 + allowlist instance comes up', wait_up('http://127.0.0.1:3440'))
        s, body = raw_req('GET', '/api/health', 'http://127.0.0.1:3440', host='bind.example')
        check('39 warn: allowlisted name passes on the 0.0.0.0 instance', s == 200, (s, body))
        check('39 warn: an allowlist does not silence the no-login warning',
              _NO_LOGIN_WARN in _bind_log_text(), _bind_log_text()[-500:])
        stop(_bind_app)
        # (c) 0.0.0.0 with a password: no warning.
        _bind_app = _bind_instance({'STANDBY_BIND': '0.0.0.0', 'STANDBY_PASSWORD': 'a-long-enough-password'})
        check('39 warn: 0.0.0.0 + password instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 warn: 0.0.0.0 with a password logs no warning',
              'WARNING' not in _bind_log_text() and 'app login: required' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (d) A short password warns.
        _bind_app = _bind_instance({'STANDBY_PASSWORD': 'short'})
        check('39 warn: short-password instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 warn: a password under 12 characters warns',
              'WARNING: STANDBY_PASSWORD is shorter than 12 characters' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (e) Loopback bind with no password: no warning.
        _bind_app = _bind_instance({'STANDBY_BIND': '127.0.0.1'})
        check('39 warn: loopback instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 warn: loopback bind with no password logs no warning',
              'WARNING' not in _bind_log_text() and 'listening on 127.0.0.1:3440' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (f) Generic Docker, no password: an info line, no warning.
        _bind_app = _bind_instance({'STANDBY_BIND': '0.0.0.0', 'STANDBY_DEPLOYMENT': 'docker'})
        check('39 warn: docker instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 warn: docker with no password logs the info line, not a warning',
              'WARNING' not in _bind_log_text()
              and 'no app login (STANDBY_PASSWORD unset) — access is limited only by the host-side port mapping' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (g) Umbrel, no password: warns (other apps share the network).
        _bind_app = _bind_instance({'STANDBY_BIND': '0.0.0.0', 'STANDBY_DEPLOYMENT': 'umbrel'})
        check('39 warn: umbrel instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 warn: umbrel with no password warns',
              'WARNING: STANDBY_PASSWORD is unset — other apps on the Umbrel Docker network' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (h) Test-only overrides are ignored, and say so, outside test mode.
        _bind_app = _bind_instance({'STANDBY_TEST_MODE': '0', 'PRICE_API_URL': 'http://127.0.0.1:1',
                                    'SLIPSTREAM_API_URL': 'http://127.0.0.1:1'})
        check('39 overrides: non-test-mode instance comes up', wait_up('http://127.0.0.1:3440'))
        check('39 overrides: PRICE_API_URL is ignored outside test mode, and logged',
              'PRICE_API_URL is set but ignored' in _bind_log_text()
              and 'SLIPSTREAM_API_URL is set but ignored' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_bind_app)
        # (i) The receiver logs no bind warning.
        _fresh_bind_log()
        _recv_env = {'PORT': '3441', 'CHECKIN_DIR': _bind_checkin,
                     'STANDBY_BIND': '0.0.0.0'}
        _recv = start(['node', 'checkin-receiver/server.js'], env=_recv_env, cwd=APP, log=_bind_log)
        check('39 warn: receiver 0.0.0.0 instance comes up', wait_up('http://127.0.0.1:3441', path='/health'))
        check('39 warn: receiver 0.0.0.0 logs no warning',
              'WARNING' not in _bind_log_text() and 'listening on 0.0.0.0:3441' in _bind_log_text(),
              _bind_log_text()[-500:])
        stop(_recv)

        # --- 40. app login (0.8.11.1) ---------------------------------
        # STANDBY_PASSWORD on: every /api route except health, auth
        # status and login needs a session token (X-Standby-Token) or
        # the password as a Bearer token. Tokens survive a restart
        # (DATA_DIR/session.key), and logging out rotates the key,
        # signing every token out. Also here: Sec-Fetch-Site, the
        # owner-only data files, and the startup writability exit.
        _pw = 'correct horse battery staple'
        _ab = 'http://127.0.0.1:3440'
        _auth_app = _bind_instance({'STANDBY_PASSWORD': _pw})
        check('40 auth: instance comes up', wait_up(_ab))
        s, r = req('GET', '/api/health', base=_ab)
        check('40 auth: health is public', s == 200 and r.get('version') == '0.8.13', (s, r))
        s, r = req('GET', '/api/auth/status', base=_ab)
        check('40 auth: status says required, not authenticated',
              s == 200 and r == {'required': True, 'authenticated': False}, (s, r))
        s, r = req('GET', '/api/state', base=_ab)
        check('40 auth: state without a login is 401 login:true',
              s == 401 and r.get('login') is True, (s, r))
        s, r = req('POST', '/api/checkin', {}, base=_ab)
        check('40 auth: a mutation without a login is 401', s == 401, (s, r))
        s, r = req('POST', '/api/login', {'password': 'wrong'}, base=_ab)
        check('40 auth: wrong password is 401', s == 401 and r.get('error') == 'wrong password', (s, r))
        s, r = req('POST', '/api/login', {'password': _pw}, base=_ab)
        _tok = r.get('token') if isinstance(r, dict) else None
        check('40 auth: right password returns a v1 token',
              s == 200 and isinstance(_tok, str) and _tok.startswith('v1.'), (s, r))
        _th = {'X-Standby-Token': _tok or ''}
        s, r = req('GET', '/api/state', base=_ab, headers=_th)
        check('40 auth: state with the token is 200', s == 200, s)
        s, r = req('GET', '/api/auth/status', base=_ab, headers=_th)
        check('40 auth: status with the token says authenticated', s == 200 and r.get('authenticated') is True, (s, r))
        s, r = req('GET', '/api/state', base=_ab, headers={'Authorization': 'Bearer ' + _pw})
        check('40 auth: the password as a Bearer token works', s == 200, s)
        s, r = req('GET', '/api/state', base=_ab, headers={'Authorization': 'Bearer nope'})
        check('40 auth: a wrong Bearer password is 401', s == 401, s)
        _bad = (_tok or 'v1.0.x')[:-1] + ('A' if (_tok or 'x')[-1] != 'A' else 'B')
        s, r = req('GET', '/api/state', base=_ab, headers={'X-Standby-Token': _bad})
        check('40 auth: a tampered token is 401', s == 401, s)
        _old = 'v1.1000.' + (_tok or 'v1.0.' + 'x' * 43).split('.')[2]
        s, r = req('GET', '/api/state', base=_ab, headers={'X-Standby-Token': _old})
        check('40 auth: a token with a changed timestamp is 401', s == 401, s)
        # Fetch metadata: another site or another port on the host is refused.
        for _site, _want in (('same-origin', 200), ('none', 200), ('same-site', 403), ('cross-site', 403)):
            s, r = req('GET', '/api/state', base=_ab, headers=dict(_th, **{'Sec-Fetch-Site': _site}))
            check('40 fetch-site: Sec-Fetch-Site %s -> %d' % (_site, _want), s == _want, (s, r))
        # Files are owner-only.
        _mode = lambda p: os.stat(p).st_mode & 0o777
        check('40 modes: data directory is 0700', _mode(_bind_data) == 0o700, oct(_mode(_bind_data)))
        check('40 modes: state.json is 0600', _mode(os.path.join(_bind_data, 'state.json')) == 0o600,
              oct(_mode(os.path.join(_bind_data, 'state.json'))))
        check('40 modes: session.key is 0600', _mode(os.path.join(_bind_data, 'session.key')) == 0o600,
              oct(_mode(os.path.join(_bind_data, 'session.key'))))
        # A token survives a restart.
        stop(_auth_app)
        _e = dict(APP_ENV)
        _e.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin, 'STANDBY_PASSWORD': _pw})
        _e.pop('STANDBY_ALLOWED_HOSTS', None)
        _auth_app = start(['node', 'server.js'], env=_e, cwd=APP, log=_bind_log)
        check('40 auth: instance restarts', wait_up(_ab))
        s, r = req('GET', '/api/state', base=_ab, headers=_th)
        check('40 auth: the token still works after a restart', s == 200, s)
        # A password change signs every token out: the token's
        # signature covers a hash of the password.
        stop(_auth_app)
        _e2 = dict(_e, STANDBY_PASSWORD='a different long password')
        _auth_app = start(['node', 'server.js'], env=_e2, cwd=APP, log=_bind_log)
        check('40 auth: instance restarts with a new password', wait_up(_ab))
        s, r = req('GET', '/api/state', base=_ab, headers=_th)
        check('40 auth: a token from the old password is 401 after the password changes', s == 401, s)
        s, r = req('GET', '/api/state', base=_ab, headers={'Authorization': 'Bearer ' + _pw})
        check('40 auth: the old password no longer works as a Bearer token', s == 401, s)
        stop(_auth_app)
        _auth_app = start(['node', 'server.js'], env=_e, cwd=APP, log=_bind_log)
        check('40 auth: instance restarts with the original password', wait_up(_ab))
        s, r = req('GET', '/api/state', base=_ab, headers=_th)
        check('40 auth: the original token works again under the original password', s == 200, s)
        # Logout signs every token out.
        s, r = req('POST', '/api/logout', {}, base=_ab, headers=_th)
        check('40 auth: logout is 200', s == 200, (s, r))
        s, r = req('GET', '/api/state', base=_ab, headers=_th)
        check('40 auth: the old token is 401 after logout', s == 401, s)
        # Brute-force brake: 10 wrong passwords a minute, then 429.
        for _ in range(10):
            req('POST', '/api/login', {'password': 'wrong'}, base=_ab)
        s, r = req('POST', '/api/login', {'password': _pw}, base=_ab)
        check('40 auth: the 11th login in a minute is 429, even with the right password', s == 429, (s, r))
        stop(_auth_app)
        # Without a password, login is a no-op and nothing is gated.
        _auth_app = _bind_instance({})
        check('40 auth-off: instance comes up', wait_up(_ab))
        s, r = req('GET', '/api/auth/status', base=_ab)
        check('40 auth-off: status says not required', s == 200 and r.get('required') is False, (s, r))
        s, r = req('POST', '/api/login', {'password': 'anything'}, base=_ab)
        check('40 auth-off: login answers ok with no token', s == 200 and r.get('token') is None, (s, r))
        stop(_auth_app)
        # A data directory that cannot be created: the app refuses to
        # start (exit 1) and names the problem and the fix.
        _blocker = '/tmp/standby-test099-bind-blocker'
        shutil.rmtree(_blocker, ignore_errors=True)
        open(_blocker, 'w').close()
        _e = dict(os.environ, **APP_ENV)
        _e.update({'PORT': '3440', 'DATA_DIR': _blocker + '/data', 'CHECKIN_DIR': _bind_checkin,
                   'STANDBY_DEPLOYMENT': 'docker'})
        _cp = subprocess.run(['node', 'server.js'], env=_e, cwd=APP, capture_output=True, text=True, timeout=20)
        check('40 writable: an unwritable data dir exits 1', _cp.returncode == 1, (_cp.returncode, _cp.stderr[-300:]))
        check('40 writable: the log names the problem and the chown fix',
              'FATAL: cannot write its files' in _cp.stderr and 'chown -R 1000:1000 data checkin' in _cp.stderr,
              _cp.stderr[-500:])
        os.remove(_blocker)

        # --- 41. encrypted backups (0.8.12) --------------------------
        # POST /api/backup {password} returns the backup encrypted
        # (scrypt + AES-256-GCM, lib/backupcrypto.js); restore asks
        # for the password; tools/decrypt-backup.js opens the file
        # with no Standby. A plain backup is POST without a password;
        # there is no GET route (0.8.13).
        _bpw = 'a long enough backup passphrase'
        s, r = req('POST', '/api/backup', {'password': 'short'})
        check('41 backup: a password under 12 characters is 400', s == 400 and '12 characters' in r.get('error', ''), (s, r))
        s, r = req('GET', '/api/backup')
        check('41 backup: there is no GET backup route (404)', s == 404, (s, r))
        s, plain = req('POST', '/api/backup', {})
        s, r = req('POST', '/api/backup', {})
        check('41 backup: POST without a password returns the plain backup', s == 200 and r.get('format') == 'standby-backup', s)
        s, enc = req('POST', '/api/backup', {'password': _bpw}, timeout=60)
        check('41 backup: POST with a password returns the encrypted envelope',
              s == 200 and enc.get('format') == 'standby-backup-encrypted' and enc.get('version') == 1, (s, list(enc)))
        check('41 backup: nothing but the envelope fields is in the clear',
              sorted(enc) == ['cipher', 'data', 'format', 'kdf', 'version']
              and sorted(enc.get('kdf', {})) == ['N', 'name', 'p', 'r', 'salt']
              and sorted(enc.get('cipher', {})) == ['iv', 'name'], (sorted(enc), enc.get('kdf'), enc.get('cipher')))
        check('41 backup: scrypt N=2^17 r=8 p=1, AES-256-GCM',
              enc.get('kdf', {}).get('name') == 'scrypt' and enc['kdf'].get('N') == 2 ** 17
              and enc['kdf'].get('r') == 8 and enc['kdf'].get('p') == 1
              and enc.get('cipher', {}).get('name') == 'aes-256-gcm', (enc.get('kdf'), enc.get('cipher')))
        _txids = sorted(t.get('id') for t in plain['state']['bitcoin']['txs'])
        if _txids:
            _hex0 = plain['state']['bitcoin']['txs'][0].get('hex', '')
            check('41 backup: no signed hex appears in the encrypted file',
                  _hex0 and _hex0 not in json.dumps(enc), '')
        # The standalone tool decrypts it to the same backup.
        _encf = '/tmp/standby-test099-backup.encrypted.json'
        with open(_encf, 'w') as f:
            json.dump(enc, f)
        _tool = os.path.join(APP, '..', 'tools', 'decrypt-backup.js')
        _cp = subprocess.run(['node', _tool, _encf], env=dict(os.environ, STANDBY_BACKUP_PASSWORD=_bpw),
                             capture_output=True, text=True, timeout=60)
        _dec = None
        try:
            _dec = json.loads(_cp.stdout)
        except Exception:
            pass
        check('41 tool: decrypt-backup.js opens the file with the right password',
              _cp.returncode == 0 and isinstance(_dec, dict) and _dec.get('format') == 'standby-backup'
              and sorted(t.get('id') for t in _dec['state']['bitcoin']['txs']) == _txids,
              (_cp.returncode, _cp.stderr[-300:]))
        _cp = subprocess.run(['node', _tool, _encf], env=dict(os.environ, STANDBY_BACKUP_PASSWORD='the wrong passphrase'),
                             capture_output=True, text=True, timeout=60)
        check('41 tool: a wrong password exits 1 with a clear message',
              _cp.returncode == 1 and 'wrong password' in _cp.stderr and not _cp.stdout, (_cp.returncode, _cp.stderr[-200:]))
        os.remove(_encf)
        # Restore: missing, wrong, tampered, out-of-range, swapped header, right.
        s, r = req('POST', '/api/restore', enc, timeout=60)
        check('41 restore: no password is 400 asking for it', s == 400 and 'enter its password' in r.get('error', ''), (s, r))
        s, r = req('POST', '/api/restore', dict(enc, password='the wrong passphrase'), timeout=60)
        check('41 restore: a wrong password is 400', s == 400 and 'wrong password' in r.get('error', ''), (s, r))
        _raw = bytearray(base64.b64decode(enc['data']))
        _raw[3] ^= 1
        s, r = req('POST', '/api/restore', dict(enc, data=base64.b64encode(bytes(_raw)).decode(), password=_bpw), timeout=60)
        check('41 restore: a tampered file is 400', s == 400 and 'damaged' in r.get('error', ''), (s, r))
        s, r = req('POST', '/api/restore', dict(enc, kdf=dict(enc['kdf'], N=2 ** 22), password=_bpw), timeout=60)
        check('41 restore: an out-of-range scrypt N is refused before any work', s == 400 and 'out of range' in r.get('error', ''), (s, r))
        s, r = req('POST', '/api/restore', dict(enc, kdf=dict(enc['kdf'], N=2 ** 16), password=_bpw), timeout=60)
        check('41 restore: an altered header (N) fails authentication', s == 400 and 'damaged' in r.get('error', ''), (s, r))
        s, r = req('POST', '/api/restore', dict(enc, password=_bpw), timeout=60)
        check('41 restore: the right password restores', s == 200 and r.get('ok') is True, (s, r))
        s, after = req('POST', '/api/backup', {})
        check('41 restore: the restored transactions match the backup',
              sorted(t.get('id') for t in after['state']['bitcoin']['txs']) == _txids, '')

        # --- 42. node test vs Test connection race --------------------
        # The hourly tick's node test does not probe Output lookup; it
        # carries the last probed result forward. If a Test connection
        # saves a fresh result while the tick is on the network, the
        # tick must not overwrite it with its older copy (which would
        # drop the Output lookup value). The stub's fee delay holds the
        # startup tick on the network while the button test finishes.
        _rb = 'http://127.0.0.1:3440'
        shutil.rmtree(_bind_data, ignore_errors=True)
        shutil.rmtree(_bind_checkin, ignore_errors=True)
        _e = dict(APP_ENV)
        _e.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin,
                   'STANDBY_TEST_STARTUP_TICK_MS': '2000'})
        _e.pop('STANDBY_PASSWORD', None)
        _race_app = start(['node', 'server.js'], env=_e, cwd=APP, log=_bind_log)
        check('42 race: instance comes up', wait_up(_rb))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryEnabled': False}, base=_rb)
        check('42 race: primary node set to the stub, secondary off', s == 200, (s, r))
        req('POST', '/__test__/fee-delay', {'ms': 3000}, base=STUB_BASE_P)
        time.sleep(2.5)  # the startup tick (at 2 s) is now waiting on a slow fee answer
        req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
        s, r = req('POST', '/api/bitcoin/connection/test', {}, base=_rb, timeout=30)
        check('42 race: Test connection answers', s == 200, (s, r))

        def _lookup_value():
            s, st = req('GET', '/api/state', base=_rb)
            res = ((st.get('bitcoin') or {}).get('connection') or {}).get('results') or [{}]
            return ((res[0].get('checks') or {}).get('outputLookup') or {}).get('value')

        check('42 race: the Test connection result carries an Output lookup value', _lookup_value() == 'Batch', _lookup_value())
        time.sleep(4)  # the tick finishes its node test and saves
        check('42 race: the tick that was on the network does not overwrite it', _lookup_value() == 'Batch', _lookup_value())
        stop(_race_app)

        # --- 43. bare spends from a bitcoind-backed mempool (0.8.13) ---
        # A mempool backed directly by bitcoind answers outspends with
        # a bare {spent: true}: no spender, no status. The app asks the
        # same node's POST /api/prevouts (confirmed UTXO set only) to
        # tell a confirmed spend (stale) from a mempool one (warning),
        # asks about its own txid to recognise its own spend, and
        # counts a UTXO rule's confirmations from first sighting.
        # A dedicated stub (bitcoind style) and app instance, so the
        # rest of the suite never sees bare answers.
        _bs_port = 18197
        _bs_base = 'http://127.0.0.1:%d' % _bs_port
        _ab43 = 'http://127.0.0.1:3440'
        _stub43 = start(['node', STUB, str(_bs_port)], env={'SENTINEL_TXID': SENTINEL_TXID}, log=_bind_log)
        check('43 bare: stub comes up', wait_up(_bs_base, path='/api/blocks/tip/height'))
        s, r = req('POST', '/__test__/outspend-style', {'style': 'bitcoind'}, base=_bs_base)
        check('43 bare: stub answers like a bitcoind-backed mempool', s == 200 and r.get('style') == 'bitcoind', r)
        shutil.rmtree(_bind_data, ignore_errors=True)
        shutil.rmtree(_bind_checkin, ignore_errors=True)
        _e43 = dict(APP_ENV)
        _e43.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin,
                     'STANDBY_TEST_STARTUP_TICK_MS': '600000'})
        _e43.pop('STANDBY_PASSWORD', None)
        _app43 = start(['node', 'server.js'], env=_e43, cwd=APP, log=_bind_log)
        check('43 bare: instance comes up', wait_up(_ab43))
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': _bs_base, 'secondaryEnabled': False}, base=_ab43)
        check('43 bare: primary node is the bitcoind-style stub, secondary off', s == 200, (s, r))
        # The raw answer really is bare.
        s, r = req('GET', '/api/tx/' + v.FINNEY + '/outspends', base=_bs_base)
        check('43 bare: the stub batch answer is bare (no txid, no status)',
              s == 200 and r[0] == {'spent': True}, r)

        def _dry43(tx_id):
            s, r = req('POST', '/api/broadcast/test', {'id': tx_id}, base=_ab43)
            return s, (r.get('results') or [{}])[0]

        def _clear43():
            return req('POST', '/api/__test__/clear-caches', {'only': ['outspend', 'nodeTip']}, base=_ab43)[0] == 200

        # Confirmed foreign spend (FINNEY:0, confirmed in the stub) —
        # first with no prevouts route: unverifiable, so the old
        # reading stands (unconfirmed — a warning, never stale).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(0, 114001), 'label': 'Bare confirmed', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
        check('43 bare: tx spending a confirmed-spent input added', s == 201, (s, r))
        _conf43 = r['tx']['id'] if s == 201 else None
        req('POST', '/__test__/prevouts-route', {'enabled': False}, base=_bs_base)
        check('43 bare: caches cleared', _clear43())
        s, one = _dry43(_conf43)
        check('43 bare: without /api/prevouts a bare spend reads unconfirmed, as before (conflict, not stale)',
              s == 200 and one.get('verdict') == 'conflict' and len(one.get('spent', [])) == 0, one)
        check('43 notes: the unverified note says the node cannot tell, not that the spend is unconfirmed',
              'cannot say whether that spend is confirmed' in (one.get('note') or '')
              and 'not confirmed yet' not in (one.get('note') or ''), one.get('note'))
        t = state_tx(_conf43, base=_ab43)
        check('43 bare: ... and the transaction stays active (not stale)',
              t and (t.get('release') or {}).get('status') != 'stale', t and t.get('release'))
        # With the route: proven confirmed, so stale.
        req('POST', '/__test__/prevouts-route', {'enabled': True}, base=_bs_base)
        check('43 bare: caches cleared again', _clear43())
        s, one = _dry43(_conf43)
        check('43 bare: /api/prevouts proves the spend confirmed — the dry run says stale (blocked)',
              s == 200 and one.get('verdict') == 'blocked' and len(one.get('spent', [])) == 1, one)
        check('43 notes: the stale note says the spend is confirmed',
              'spent by another transaction that is confirmed' in (one.get('note') or ''), one.get('note'))
        check('43 bare: the spender is not named (the node cannot say)',
              (one.get('spent') or [{}])[0].get('spentBy') is None, one.get('spent'))
        t = state_tx(_conf43, base=_ab43)
        check('43 bare: the transaction is recorded stale',
              t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
        # Mempool-only foreign spend (CONFLICT, unconfirmed in the stub).
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft_prev('cc' * 32, 0, 114002), 'label': 'Bare mempool', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
        check('43 bare: tx spending a mempool-spent input added', s == 201, (s, r))
        s, one = _dry43(r['tx']['id'] if s == 201 else None)
        check('43 bare: a mempool-only bare spend stays a warning (conflict, not stale)',
              s == 200 and one.get('verdict') == 'conflict' and len(one.get('conflict', [])) == 1, one)
        check('43 notes: a verified mempool-only spend is called not confirmed yet',
              'not confirmed yet' in (one.get('note') or '') and 'cannot say' not in (one.get('note') or ''), one.get('note'))
        # Our own transaction already out: SECOND:0 spent (confirmed),
        # and the node knows our txid.
        req('POST', '/__test__/outspend', {'txid': 'aa' * 32, 'vout': 0, 'blockHeight': STUB_TIP}, base=_bs_base)
        _own_hex = v.craft_prev('aa' * 32, 0, 114003)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': _own_hex, 'label': 'Bare own', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
        check('43 bare: own-spend tx added', s == 201, (s, r))
        _own43 = r['tx']['id'] if s == 201 else None
        s, body = raw_req('POST', '/api/tx', _bs_base, host='127.0.0.1:%d' % _bs_port,
                          headers={'Content-Type': 'text/plain'}, body=_own_hex.encode())
        check('43 bare: our transaction is known to the node', s == 200, (s, body))
        check('43 bare: caches cleared for the own check', _clear43())
        s, one = _dry43(_own43)
        check('43 bare: a bare spend by our own txid is recognised as broadcast, not stale',
              s == 200 and one.get('verdict') == 'broadcast'
              and (one.get('own') or [{}])[0].get('spentBy') == v.txid_of(_own_hex), one)
        check('43 notes: the own-spend note says the node knows our txid',
              'the node knows its txid' in (one.get('note') or ''), one.get('note'))
        # UTXO rule, N=1: a confirmed bare spend fires at once.
        s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': 'aa' * 32 + ':0', 'confirmations': 1}}}, base=_ab43)
        check('43 utxo: N=1 fires on a confirmed bare spend', s == 200 and r.get('fire') is True, r)
        # UTXO rule, N=3: counted from first sighting (tip 900,000),
        # so it waits, then fires once the tip is two blocks higher.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(1, 114004), 'label': 'Bare N3',
                   'trigger': {'type': 'utxo', 'params': {'outpoint': 'aa' * 32 + ':0', 'confirmations': 3}},
                   'triggerConfirmed': True}, base=_ab43)
        check('43 utxo: N=3 tx added', s == 201, (s, r))
        _n3 = r['tx']['id'] if s == 201 else None
        s, r = req('POST', '/api/release/check', {}, base=_ab43)
        t = state_tx(_n3, base=_ab43)
        sl = rule_slice(t) if t else {}
        lo = (sl or {}).get('lastOutspend') or {}
        check('43 utxo: N=3 first sighting stamps the tip height', lo.get('firstSeenConfirmedHeight') == STUB_TIP, lo)
        check('43 utxo: N=3 waits at 1 of 3 confirmations', lo.get('confirmations') == 1 and not t.get('broadcasted'), (lo, t.get('broadcasted')))
        check('43 notes: the count from first sighting reads as a minimum',
              (sl.get('reason') or '').startswith('spent — at least 1 of 3 confirmations'), sl.get('reason'))
        req('POST', '/__test__/tip', {'height': STUB_TIP + 1}, base=_bs_base)
        check('43 utxo: caches cleared after one block', _clear43())
        req('POST', '/api/release/check', {}, base=_ab43)
        t = state_tx(_n3, base=_ab43)
        lo = (rule_slice(t) or {}).get('lastOutspend') or {}
        check('43 utxo: one block later it reads 2 of 3, first sighting unchanged',
              lo.get('confirmations') == 2 and lo.get('firstSeenConfirmedHeight') == STUB_TIP and not t.get('broadcasted'), lo)
        req('POST', '/__test__/tip', {'height': STUB_TIP + 2}, base=_bs_base)
        check('43 utxo: caches cleared after two blocks', _clear43())
        req('POST', '/api/release/check', {}, base=_ab43)
        t = state_tx(_n3, base=_ab43)
        check('43 utxo: at 3 confirmations from first sighting it fires and broadcasts', t and t.get('broadcasted'), t and t.get('release'))

        # --- 44. restore re-checks every card against the node (0.8.13) ---
        # A backup's broadcast and stale records are not trusted, so
        # restore drops them — and then runs the dry-run check on every
        # restored transaction, so a card already broadcast or stale
        # goes back to Archived instead of reading Active.
        def _by_label44(st, label):
            return next((t for t in (st.get('bitcoin') or {}).get('txs', []) if t.get('label') == label), None)
        s, bak44 = req('POST', '/api/backup', {}, base=_ab43)
        check('44 restore: backup fetched', s == 200 and 'state' in bak44, s)
        check('44 restore: caches cleared before the restore', _clear43())
        s, r = req('POST', '/api/restore', bak44, base=_ab43, timeout=60)
        check('44 restore: restore succeeds', s == 200 and r.get('ok') is True, (s, r))
        rc = r.get('recheck') or {}
        check('44 restore: the response says what the check found',
              rc.get('checked') == r.get('restoredTxs') and rc.get('stale', 0) >= 1 and rc.get('broadcast', 0) >= 1
              and rc.get('conflict', 0) >= 1 and rc.get('unchecked') == 0, rc)
        t = _by_label44(r.get('state') or {}, 'Bare confirmed')
        check('44 restore: the restore response already carries the re-derived status',
              t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
        s, st = req('GET', '/api/state', base=_ab43)
        t = _by_label44(st, 'Bare confirmed')
        check('44 restore: a stale transaction is stale again (Archived), not Active',
              t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
        check('44 restore: ... with a stale line in its history',
              t and any(h.get('type') == 'stale' for h in (t.get('history') or [])), t and t.get('history'))
        t = _by_label44(st, 'Bare own')
        check('44 restore: our own broadcast transaction is broadcast again (Archived)',
              t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast',
              t and (t.get('broadcasted'), t.get('release')))
        t = _by_label44(st, 'Bare mempool')
        check('44 restore: an unconfirmed conflict keeps its warning',
              t and (t.get('release') or {}).get('status') == 'conflict', t and t.get('release'))
        # The node cannot answer: nothing is recorded, the restore still
        # succeeds, and the response says how many went unchecked.
        bak44['state']['settings']['primaryApiUrl'] = 'http://127.0.0.1:18199'
        s, r = req('POST', '/api/restore', bak44, base=_ab43, timeout=60)
        rc = r.get('recheck') or {}
        check('44 restore: with the node unreachable the restore still succeeds', s == 200 and r.get('ok') is True, (s, r))
        check('44 restore: ... and says every transaction went unchecked',
              rc.get('unchecked') == r.get('restoredTxs') and rc.get('stale') == 0 and rc.get('broadcast') == 0, rc)
        s, st = req('GET', '/api/state', base=_ab43)
        t = _by_label44(st, 'Bare confirmed')
        check('44 restore: ... and records nothing it could not check',
              t and (t.get('release') or {}).get('status') != 'stale', t and t.get('release'))
        stop(_app43)
        stop(_stub43)

    finally:
        for p in list(v.procs):
            stop(p)

    # --- 11. no server left running -------------------------------------
    for port in (PORT, RECEIVER_PORT, STUB_P, STUB_S, 18190, 18191, 18197, 3440, 3441):
        check('11 no server left running on port %d' % port, port_closed(port))

    print()
    print('FAILURES: %d %s' % (len(v.failures), v.failures if v.failures else '(none)'))
    return 1 if v.failures else 0


if __name__ == '__main__':
    sys.exit(main())

