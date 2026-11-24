#!/usr/bin/env python3
"""Standby 0.7.22 local verification: primary/secondary mempool endpoints,
manual broadcast (Broadcast Now / Broadcast All), confirmations, and the
shared-input check on dry-run all.
Boots the app + three mempool stubs (primary 18160, secondary 18161,
env-override 18159) and checks: fresh defaults, URL validation, dry-run
+ broadcast + already-in-mempool via primary, fallback to secondary when
the primary is down, a spent verdict from the primary is definitive (no
fallback), both-down failure, restart survival, env override for the
primary, the 0.5.3 -> 0.6.5 state migration (RPC password deleted from
disk, custom endpoint carried over as the primary), and the 0.6.4
additions: manual broadcast of one tx, already-broadcast skip, stale
manual broadcast, broadcast all, confirmations (6 for a stub-confirmed
tx), shared inputs flagged on dry-run all (and not on a single dry-run),
check-in clearing the release record but NOT the broadcasted fact, hex
replacement clearing the broadcasted fact, and the release skipping an
already-broadcast tx after a check-in instead of marking it stale — plus
the 0.6.4 changes: new transactions default to armed, dry-run all
tests every stored tx that could still broadcast (armed or not) and its
aggregate counts the armed txs correctly (0.5.9 said "0 of 0 armed" —
the success path omitted the enabled flag), and in 0.6.4 a dry-run all
skips the transactions that have already been broadcast or whose inputs
were already declared spent (they get no new status from the run; with
nothing left to test the note says so), and data backup / restore
round-trips the whole setup. 0.6.4 itself: the check-in status turns
'Broadcasted' once a release has gone out (a manual broadcast does
not count — the release record carries kind 'release' vs 'broadcast',
and a check-in resets it to 'On track'); Broadcast All only attempts
the transactions that are not archived (the UI sends their ids, and
the server skips the broadcasted and release-stale ones without ids);
the stored-count fields (bitcoinTxCount / bitcoinEnabledCount) are
gone from /api/status — the readiness count is client-side now. 0.6.5
itself: a dry-run that finds spent inputs RECORDS the stale verdict
on the transaction (a stale release record, kind 'dryrun') — the card
stays Stale across refreshes (the 0.6.4 bug: the verdict lived only in
the page's memory, so a dry-run-declared stale tx popped back to
Ready on every refresh), and a check-in no longer clears a stale
record (staleness is a fact about the inputs, not the cycle — only
replacing the hex clears it); the shared-input warning is now derived
from the stored transactions on every state read (GET /api/state
carries `overlaps`), so it persists across refreshes and clears the
moment a transaction is edited away from the shared input. This
suite re-verifies the same API against the 0.7.3 build, and
dom_check093 covers the layout. 0.7.17 itself: the public fallback for Slipstream — a per-transaction opt-in timer. If a Slipstream-route transaction is not publicly visible within the chosen number of days (1, 3, 7, 14, 30, 60, or 90; Never by default), Standby broadcasts it publicly instead. The deadline runs from when MARA first accepted it (release.submittedAt), and changing the duration while it waits re-times the deadline from that same acceptance; a transaction whose Slipstream submit keeps failing falls back from its first attempt (slipstreamFirstAttemptAt, set on the first attempt whether it succeeds or fails, never overwritten). The fallback is checked on the hourly tick and on a manual release check, after the MARA status refresh — it is the only automatic public broadcast, and a check-in does not cancel a due fallback. A pending or archived tx's hex is immutable (PUT rejects a hex change; label/notes still work). 0.7.18 itself: the transaction cards are redesigned — a prominent BTC amount, a status-coloured accent bar, the armed state in the pill ("Ready + armed"), a collapsed Details section (inputs, fee, TXID, route, fallback, notes), and the actions as quiet text links; the fee in sats and sat/vB is stored at add time (computed from the parent transactions via the node, best-effort — null when the node cannot answer), the parent value read in satoshis as the mempool API returns it (a pre-fix units bug read it as BTC and inflated the fee 1e8x; a dry-run or a restart recomputes a wrong stored fee), and the rate shown to one decimal; the check-in card leads with the next due date; the broadcast log and recent check-ins are styled lists. Round 6 (still 0.7.18): Details open by default on Active/Pending cards and closed on Archived ones, the open state (Details, Inputs/Outputs, TXID) survives button clicks including the arm toggle, the dry-run result and warnings sit below the buttons, and the Add header aligns with the other card headers. Round 12 (still 0.7.18): archived transactions are excluded from the shared-input check (a live tx sharing an input with an archived one is not warned about it), Details are collapsed by default on every card, the main card has three separate buttons ("Dry-run all", "Broadcast all", "Broadcast armed") each broadcast button with its own confirmation dialog and an armedOnly flag on POST /api/broadcast/all for the armed one, and the sticky header bar is shorter (less vertical padding, logo and burger unchanged).
0.6.6 itself: check-in API keys — a
labelled key per service, shown once at creation, stored as a SHA-256
hash; the check-in receiver (a separate service on its own port,
holding no transaction data) validates the key against the hashes the
app publishes to the shared directory and writes only a timestamp,
which the app merges into the check-in clock (same as an in-app
check-in: clears the cycle release records, never a stale one,
auto-resumes a pause, logs which key checked in); revocation takes
effect immediately because the receiver reads the key list fresh on
every request; a backup/restore carries the keys (hashes only); a
future or already-merged timestamp is ignored. 0.7.19 itself: the
Dashboard check-in card leads with a countdown ("N days left" /
"Overdue") and a progress bar coloured by how much of the window is
left, with an "X of Y days elapsed" caption — the window is the
configured thresholdDays, and the card renders from /api/status
(daysSince / nextDue / lastCheckinAt), which this suite now checks
for consistency against the seeded check-in clock; Last check-in and
Next due are the absolute date only (no relative line). The
old "N of M armed" count. 0.7.20 itself: the fee verdict — each
active transaction's Fee line carries a colour-coded " — Low
Risk / Medium Risk / High Risk" suffix, and the release-readiness
list shows the same verdict as a second pill next to the status
pill; both compare the tx's own fee rate against the 90-day peak
(the 90th percentile of block medians over the 3m fee-rates
window, fetched from the mempool.space public endpoint —
FEE_RATES_URL points it at the primary stub in tests — cached,
refreshed daily, served as bitcoin.feePeak / bitcoin.feePeakAt
with /api/state, null when the fetch fails or the value is older
than 48h). Low Risk at 2x the peak, Medium Risk at 1x–2x, High
Risk below it; no verdict on a settled or pending tx, or when
the rate or the peak is unknown. Also in 0.7.20: an unarmed
tx's pill reads just "unarmed" (no "Disabled + unarmed"); the
check-in countdown subline reads "until transactions are
broadcast"; and after a successful check-in there is no
"Checked in just now." line below the button (the error path
still reports e.message). 0.7.21 itself: the fee verdict is
explainable — tapping a transaction's Fee line opens a pop-out
(the shared showDetails modal) with the 90-day peak, your fee,
the current economy fee, and the reason for the level — and a
fourth level, Critical Risk, flags a fee below the current
economy fee (it would not confirm within a day right now) and
wins over the historical ladder; the current recommended fees
are fetched from the same mempool.space public base
(/api/v1/fees/recommended), cached, refreshed hourly, served
as bitcoin.currentFees / bitcoin.currentFeesAt, and a dead
current-fee fetch skips the Critical check (the historical
ladder alone) instead of a wrong verdict. High Risk is a
lighter red now; Critical Risk keeps the current red, so the
worst level is visibly the deepest red. 0.7.22 itself: the
offline-gap grace ("boot hold") — the app records an "I was
online" stamp (state.checkin.lastOnlineAt, refreshed on every
hourly release tick and set on check-in) and, on each release
evaluation and on each read of /api/state and /api/status, if
(now - lastOnlineAt) > threshold/4 AND (now - lastCheckinAt) >
threshold/2 (17.5 days on the 35-day threshold for the clock
half, 8.75 days for the gap quarter), it sets a persisted
state.checkin.heldUntil = now + threshold/2 (17.5 days from
NOW, not from the original due date — a months-long outage
must still leave a real grace window). The release cannot
fire before heldUntil: the effective due is max(original due,
heldUntil), checkinStatus returns 'held' / 'Grace period'
with nextDue = heldUntil while the hold is active, and the
check-in card renders against it (countdown to the held
date, the progress bar and "X of Y days elapsed" against the
longer held window, the pill reading "Grace period"). A
check-in clears the hold. The hold is judged on the stamp
BEFORE the tick refreshes it (refreshing first would shrink
the gap to zero), and it is persisted so a reboot mid-grace
does not lose it. A restore refreshes the check-in clock
too: it counts as a check-in (the owner is present), so the
restored clock is the restore moment, not the backup's
(totalCheckins keeps the backup's count + 1, heldUntil is
cleared, and the restore is recorded in the check-in
history as method 'restore'). The backup's clock is still
validated first — a corrupt or future-dated clock rejects
the whole restore. The danger zone is the last 25% of the
check-in window — remainingMs = (lastCheckinAt +
thresholdMs) - now, and the zone is remainingMs <= 0.25 *
thresholdMs (already past due is inside it). Three actions
reset the check-in instead of letting a due release fire,
server-side so a direct API call cannot bypass them:
shortening the threshold (PUT /api/settings, measured
against the NEW threshold — a shorten landing the new due
inside 25% of the new threshold resets, a shorten or
lengthen leaving the new due comfortably out does not),
arming a disarmed live tx (PUT /api/bitcoin/txs/:id,
false->true, not broadcasted / not stale), and adding a
new tx (paste or file import — armed by default), each
measured against the current clock. The reset is
lastCheckinAt = now (+1 check-in, heldUntil cleared,
lastOnlineAt now, a history entry — 'threshold-reset' /
'arm-reset' / 'add-reset' — and checkinReset: true in the
response). Disarming, arming/adding outside the zone, and
arming a broadcasted / stale tx leave the clock alone.
Boundary cases on a 35-day threshold: 30 days back (5
days left, ~14%) resets; 20 days back (15 days left,
~43%) does not. The UI confirms first in the zone and
words itself around the remaining time ("The release is
due…" when past due, "Only X days left until the release
is due." when in the zone), and says when a save reset
the check-in.

Lives in the goal dir (test/) now — /tmp does not survive VM replacement.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# Portability (0.8.3, tests-in-repo): resolve paths from this file, not
# from a hardcoded goal dir. _ROOT is the goal dir locally and the repo
# root in a checkout; test/ is this file's own dir in both layouts.
_TESTDIR = os.path.dirname(os.path.abspath(__file__))
GOAL = os.path.dirname(_TESTDIR)
STUB = os.path.join(_TESTDIR, 'stubs.js')


def app_dir(root, candidates=('branch-0811-secure-defaults', 'branch-0810-fixes', 'branch-local-peak', 'branch-0.8.8-nonrpc', 'branch-0.8.8', 'standby', 'branch-split', 'branch-speedup', 'branch-0.8.7.2', 'branch-0.8.7.1', 'branch-0.8.7', 'branch-0.8.6', 'branch-0.8.5', 'branch-0.8.4', 'branch-0.8.3', 'app')):
    """The app dir under a root: branch-0811-secure-defaults/ in the goal dir (0.8.11
    working copy), branch-0810-fixes/ in the goal dir (0.8.10
    working copy), branch-local-peak/ in the goal dir (0.8.9
    working copy), branch-0.8.8-nonrpc/ in the goal dir (0.8.8
    working copy), standby/ in a repo checkout,
    branch-split/ in the goal dir (0.8.7.4 working copy),
    branch-speedup/ in the goal dir (test-infra working copy),
    branch-0.8.7.2/ the 0.8.7.2 copy, branch-0.8.7.1/ the 0.8.7.1 copy, branch-0.8.7/ the 0.8.7 copy, branch-0.8.6/ the 0.8.6 copy,
    branch-0.8.5/ the 0.8.5 copy, branch-0.8.4/ the 0.8.4 copy,
    branch-0.8.3/ the 0.8.3 copy, app/ for the 0.7.22-era layout this file's own suite boots."""
    for cand in candidates:
        if os.path.exists(os.path.join(root, cand, 'server.js')):
            return os.path.join(root, cand)
    return os.path.join(root, candidates[0])


# This file's own suite (0.7.22) boots the goal dir's app/ copy;
# the 099 suites call app_dir(GOAL) for their own dir instead.
APP = os.path.join(GOAL, 'app')
FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'
SECOND = 'aa' * 32
DATA = '/tmp/heirloom094'
CHECKIN_DIR = '/tmp/heirloom094-checkin'
PORT = 3378
BASE = 'http://127.0.0.1:%d' % PORT
RECEIVER_PORT = 3379
RBASE = 'http://127.0.0.1:%d' % RECEIVER_PORT

failures = []


def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL'), '-', name, '' if cond else '| ' + str(detail)[:300])
    if not cond:
        failures.append(name)


def req(method, path, body=None, base=None, timeout=20, headers=None):
    h = {'Content-Type': 'application/json'}
    if headers:
        h.update(headers)
    r = urllib.request.Request((base or BASE) + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {}


def craft_prev(prev_txid, vout, value=100000):
    # Same shape as craft(), but spending an arbitrary parent txid —
    # the stub 404s any parent that is not FINNEY or SECOND, so the
    # input is "unknown" (cannot prove spent or unspent).
    tx = b'\x01\x00\x00\x00' + b'\x01'
    tx += bytes.fromhex(prev_txid)[::-1]
    tx += vout.to_bytes(4, 'little')
    tx += b'\x00' + b'\xff\xff\xff\xff'
    tx += b'\x01'
    tx += value.to_bytes(8, 'little')
    script = b'\x76\xa9\x14' + b'\x00' * 20 + b'\x88\xac'
    tx += bytes([len(script)]) + script
    tx += b'\x00\x00\x00\x00'
    return tx.hex()


def craft(vout, value=100000):
    return craft_prev(FINNEY, vout, value)


def craft_locktime(prev_txid, vout, locktime, sequence=0, value=100000):
    # Same shape as craft_prev(), but with an explicit locktime and
    # sequence, so a test can build a timelocked transaction (0.7.14).
    # sequence defaults to 0 (below 0xffffffff, so the locktime
    # applies); pass 0xffffffff to prove a locktime is ignored when
    # every sequence is maxed. locktime is a block height below
    # 500,000,000, a Unix timestamp at or above it.
    tx = b'\x01\x00\x00\x00' + b'\x01'
    tx += bytes.fromhex(prev_txid)[::-1]
    tx += vout.to_bytes(4, 'little')
    tx += b'\x00' + sequence.to_bytes(4, 'little')
    tx += b'\x01'
    tx += value.to_bytes(8, 'little')
    script = b'\x76\xa9\x14' + b'\x00' * 20 + b'\x88\xac'
    tx += bytes([len(script)]) + script
    tx += locktime.to_bytes(4, 'little')
    return tx.hex()


def txid_of(hexs):
    b = bytes.fromhex(hexs)
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()[::-1].hex()


# --- PSBT builders (0.7.15 import) ---
# Dummy signatures / pubkeys (shape only — the server does not verify
# signatures, it only finalizes and extracts the hex).
PSBT_PK1 = b'\x02' + b'\x11' * 32
PSBT_PK2 = b'\x02' + b'\x22' * 32
PSBT_PK3 = b'\x02' + b'\x33' * 32
PSBT_SIG = b'\x30' * 70 + b'\x01'
PSBT_SIG2 = b'\x31' * 70 + b'\x01'

def _psbt_varint(n):
    if n < 0xfd: return bytes([n])
    if n <= 0xffff: return b'\xfd' + n.to_bytes(2, 'little')
    return b'\xfe' + n.to_bytes(4, 'little')

def _psbt_kv(type_byte, keydata, value):
    key = bytes([type_byte]) + keydata
    return _psbt_varint(len(key)) + key + _psbt_varint(len(value)) + value

def _psbt_map(entries):
    return b''.join(entries) + b'\x00'

def _tx_counts(tx_hex):
    # (input count, output count) of a raw tx, or (0, 0) when the tx
    # is too malformed to count (the server rejects it as unparsable
    # before it ever reads the maps).
    try:
        b = bytes.fromhex(tx_hex)
        off = 4
        if len(b) > off + 1 and b[off] == 0 and b[off + 1] == 1:
            off += 2
        def varint(o):
            first = b[o]
            if first < 0xfd: return first, o + 1
            if first == 0xfd: return int.from_bytes(b[o+1:o+3], 'little'), o + 3
            if first == 0xfe: return int.from_bytes(b[o+1:o+5], 'little'), o + 5
            return int.from_bytes(b[o+1:o+9], 'little'), o + 9
        n_in, off = varint(off)
        for _ in range(n_in):
            off += 36
            sl, off = varint(off)
            off += sl + 4
        n_out, off = varint(off)
        return n_in, n_out
    except Exception:
        return 0, 0

def build_psbt(unsigned_hex, input_entries, output_entries=None):
    # unsigned_hex: the unsigned tx as hex. input_entries: one list
    # per input, each a list of (type, keydata, value) triples.
    # output_entries: same shape, one per output — when omitted, one
    # empty map per output of the unsigned tx (a PSBT needs one map
    # per output, even when it carries nothing).
    n_in, n_out = _tx_counts(unsigned_hex)
    if output_entries is None:
        output_entries = [[] for _ in range(n_out)]
    parts = [b'psbt\xff',
             _psbt_map([_psbt_kv(0x00, b'', bytes.fromhex(unsigned_hex))])]
    for entries in input_entries:
        parts.append(_psbt_map([_psbt_kv(t, k, v) for (t, k, v) in entries]))
    for entries in output_entries:
        parts.append(_psbt_map([_psbt_kv(t, k, v) for (t, k, v) in entries]))
    return b''.join(parts)

def _hash160(b):
    return hashlib.new('ripemd160', hashlib.sha256(b).digest()).digest()

def _push(b):
    return bytes([len(b)]) + b

def _wit_utxo(script_pubkey, value=100000):
    return value.to_bytes(8, 'little') + _psbt_varint(len(script_pubkey)) + script_pubkey

def _signed_frame(script_sig, witness=None, value=100000):
    # The 1-input / 1-output tx (FINNEY vout 1, the craft() shape)
    # with the given scriptSig and optional witness stack.
    parts = [b'\x01\x00\x00\x00']
    if witness is not None:
        parts.append(b'\x00\x01')
    parts.append(b'\x01')
    parts.append(bytes.fromhex(FINNEY)[::-1] + (1).to_bytes(4, 'little'))
    parts.append(_psbt_varint(len(script_sig)) + script_sig + b'\xff\xff\xff\xff')
    parts.append(b'\x01' + value.to_bytes(8, 'little'))
    script = b'\x76\xa9\x14' + b'\x00' * 20 + b'\x88\xac'
    parts.append(bytes([len(script)]) + script)
    if witness is not None:
        w = _psbt_varint(len(witness))
        for item in witness:
            w += _psbt_varint(len(item)) + item
        parts.append(w)
    parts.append(b'\x00\x00\x00\x00')
    return b''.join(parts).hex()

def signed_p2pkh_hex(sig, pubkey, value=100000):
    return _signed_frame(_push(sig) + _push(pubkey), value=value)

def signed_p2wpkh_hex(sig, pubkey, value=100000):
    return _signed_frame(b'', witness=[sig, pubkey], value=value)

def signed_p2sh_p2wpkh_hex(redeem, sig, pubkey, value=100000):
    return _signed_frame(_push(redeem), witness=[sig, pubkey], value=value)

def signed_p2wsh_msig_hex(sigs, value=100000):
    return _signed_frame(b'', witness=[b''] + sigs, value=value)


SENTINEL_HEX = craft(1, 100001)
SENTINEL_TXID = txid_of(SENTINEL_HEX)

procs = []


def start(cmd, env=None, cwd=None, log='/tmp/heirloom094-proc.log'):
    e = dict(os.environ)
    if env:
        e.update(env)
    # Test mode (speedup): every process the harness starts runs
    # with STANDBY_TEST_MODE=1, which is the ONLY way the app's
    # test-only endpoints (POST /__test__/clear-caches) answer —
    # without it they 404 like any unknown path. Production (Umbrel)
    # never sets this variable, so the endpoints cannot run there.
    # Stubs and the receiver inherit it too; they ignore it.
    e.setdefault('STANDBY_TEST_MODE', '1')
    # (Optimization O2) Shorten the app's 5 s startup-tick delay
    # to 500 ms for every process the harness starts — the app
    # honors it only in test mode (see STARTUP_TICK_MS in
    # server.js), so the production startup delay is untouched.
    # Stubs and the receiver inherit it too; they ignore it.
    e.setdefault('STANDBY_TEST_STARTUP_TICK_MS', '500')
    p = subprocess.Popen(cmd, env=e, cwd=cwd, stdout=open(log, 'ab'), stderr=subprocess.STDOUT)
    procs.append(p)
    return p


def wait_up(base, tries=25, path='/api/health'):
    for _ in range(tries):
        try:
            s, _ = req('GET', path, base=base, timeout=3)
            if s == 200:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def stop(p):
    try:
        p.terminate()
        p.wait(timeout=5)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def main():
    for d in (DATA, '/tmp/heirloom094-env', '/tmp/heirloom094-mig', CHECKIN_DIR):
        shutil.rmtree(d, ignore_errors=True)
    # 0.7.20: every app instance refreshes the 90-day fee peak 2s
    # after startup — point the fetch at the primary stub for the
    # whole run (inherited by every child process), never the real
    # mempool.space. A section that needs a different value passes
    # its own FEE_RATES_URL in its env (the no-fee degradation
    # instance below does exactly that).
    os.environ['FEE_RATES_URL'] = 'http://127.0.0.1:18160'
    # stubs
    p_primary = start(['node', STUB, '18160'], env={'SENTINEL_TXID': SENTINEL_TXID})
    p_secondary = start(['node', STUB, '18161'])
    p_env = start(['node', STUB, '18159'])
    # the check-in receiver (0.6.6): its own port + the shared check-in dir
    p_receiver = start(['node', 'checkin-receiver/server.js'],
                       env={'PORT': str(RECEIVER_PORT), 'CHECKIN_DIR': CHECKIN_DIR}, cwd=APP)
    app = start(['node', 'server.js'],
                env={'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR,
                     'FEE_RATES_URL': 'http://127.0.0.1:18160'}, cwd=APP)
    try:
        check('app up', wait_up(BASE))
        check('receiver up', wait_up(RBASE, path='/health'))
        s, h = req('GET', '/api/health')
        check('health version 0.7.22', h.get('version') == '0.7.22', h)
        s, rh = req('GET', '/health', base=RBASE)
        check('receiver health 0.7.1: exactly {ok: true}, no service name',
              s == 200 and rh == {'ok': True}, rh)
        # 0.7.19: the served Dashboard carries the countdown + progress
        # elements and the per-tx readiness list; the old readiness
        # count element and the relative last-check-in line are gone.
        with urllib.request.urlopen(BASE + '/', timeout=20) as resp:
            idx_html = resp.read().decode()
        with urllib.request.urlopen(BASE + '/style.css', timeout=20) as resp:
            css_text = resp.read().decode()
        check('static 0.7.19: the check-in card carries the countdown + progress elements',
              all(x in idx_html for x in ('id="checkin-countdown"', 'id="checkin-countdown-sub"',
                                          'id="checkin-progress"', 'id="checkin-progress-fill"',
                                          'id="checkin-progress-label"'))
              and 'until transactions are broadcast' in idx_html, idx_html[:200])
        check('static 0.7.19: the readiness list replaces the count element',
              'id="readiness-txs"' in idx_html and 'readiness-btc' not in idx_html, '')
        check('static 0.7.19: the Check in button is full width (btn-checkin-big)',
              'id="btn-checkin" class="primary big btn-checkin-big"' in idx_html
              and 'button.btn-checkin-big { width: 100%;' in css_text, '')
        check('static 0.7.19: the last check-in is a plain date cell (no checkin-last / rel line)',
              'id="last-checkin"' in idx_html and 'checkin-last' not in idx_html
              and 'Checked in ' not in idx_html, '')
        check('static 0.7.19: the countdown / tx-row / node-flex CSS is present',
              '.countdown {' in css_text and '.tx-row { display: flex;' in css_text
              and '#tab-dashboard .node-lines > div { display: flex;' in css_text
              and 'justify-content: space-between' in css_text, '')
        # 0.7.20: the fee verdict — the 90-day peak (90th percentile
        # of the per-block median fee rates over 3 months) is fetched
        # from the mempool fee-rates endpoint 2s after startup and
        # served with the state. The fetch goes to the primary stub
        # (FEE_RATES_URL), never the real mempool.space: the stub's
        # 10-point series has medians [1x8, 2, 2], so the peak is 2.0
        # sat/vB. Poll — the refresh fires 2s after startup, so the
        # first state read may not have it yet.
        fee_peak = None
        for _ in range(30):
            s, st = req('GET', '/api/state')
            fee_peak = (st.get('bitcoin', {}) or {}).get('feePeak')
            if isinstance(fee_peak, (int, float)):
                break
            time.sleep(1)
        check('fee verdict 0.7.20: /api/state carries the 90-day peak (2.0 sat/vB)',
              fee_peak == 2.0, fee_peak)
        fee_peak_at = (st.get('bitcoin', {}) or {}).get('feePeakAt')
        check('fee verdict 0.7.20: /api/state carries the peak fetch time (ISO)',
              isinstance(fee_peak_at, str) and 'T' in fee_peak_at, fee_peak_at)
        # 0.7.21: the current recommended fees are fetched from the
        # same mempool.space public base (/api/v1/fees/recommended,
        # served by the primary stub) 2s after startup and served
        # with the state. The stub's economy fee is 1 sat/vB — the
        # measured live floor — so a fee below 1 reads Critical.
        current_fees = None
        for _ in range(30):
            s, st = req('GET', '/api/state')
            current_fees = (st.get('bitcoin', {}) or {}).get('currentFees')
            if isinstance(current_fees, dict) and isinstance(current_fees.get('economyFee'), (int, float)):
                break
            time.sleep(1)
        check('fee verdict 0.7.21: /api/state carries the current recommended fees (economyFee 1 sat/vB)',
              isinstance(current_fees, dict) and current_fees.get('economyFee') == 1, current_fees)
        current_fees_at = (st.get('bitcoin', {}) or {}).get('currentFeesAt')
        check('fee verdict 0.7.21: /api/state carries the current-fees fetch time (ISO)',
              isinstance(current_fees_at, str) and 'T' in current_fees_at, current_fees_at)
        # The verdict ladder itself, against lib/bitcoin.js (the
        # same rule the frontend mirrors): 2.0 -> Medium, 1.0 ->
        # High, 4.0/5.0 -> Low, null rate/peak -> null. The peak
        # from the stub medians is 2.0. 0.7.21 adds the Critical
        # check first: a rate below the economy fee (1 sat/vB here)
        # is Critical whatever the history says; without an economy
        # fee the Critical check is skipped and the ladder alone
        # runs (0.6 at peak 2.0 with no economy fee is High, not
        # Critical).
        node_js = (
            "const b = require('./lib/bitcoin.js');"
            "const peak = b.feePeakFromRates([1,1,1,1,1,1,1,1,2,2].map((m) => ({ avgFee_50: m })));"
            "console.log(JSON.stringify({ peak,"
            " v2: b.feeVerdict(2.0, 2.0, 1), v1: b.feeVerdict(1.0, 2.0, 1),"
            " v4: b.feeVerdict(4.0, 2.0, 1), v5: b.feeVerdict(5.0, 2.0, 1),"
            " vCrit: b.feeVerdict(0.6, 2.0, 1), vCritLow: b.feeVerdict(0.6, 2.0, 5),"
            " vNoEcon: b.feeVerdict(0.6, 2.0), vEconEq: b.feeVerdict(1.0, 2.0, 1),"
            " vNullRate: b.feeVerdict(null, 2.0, 1), vNullPeak: b.feeVerdict(2.0, null, 1),"
            " vNullBoth: b.feeVerdict(null, null, 1) }));"
        )
        nr = subprocess.run(['node', '-e', node_js], capture_output=True, text=True, cwd=APP, timeout=30)
        try:
            nv = json.loads(nr.stdout.strip())
        except Exception:
            nv = {}
        check('fee verdict 0.7.20: the 90th percentile of [1x8, 2, 2] is 2.0',
              nv.get('peak') == 2.0, nr.stdout[:200] + nr.stderr[:200])
        check('fee verdict 0.7.20: rate 2.0 at peak 2.0 is Medium Risk',
              nv.get('v2') == 'Medium Risk', nv)
        check('fee verdict 0.7.20: rate 1.0 at peak 2.0 is High Risk',
              nv.get('v1') == 'High Risk', nv)
        check('fee verdict 0.7.20: rate 4.0 and 5.0 at peak 2.0 are Low Risk',
              nv.get('v4') == 'Low Risk' and nv.get('v5') == 'Low Risk', nv)
        check('fee verdict 0.7.20: a null rate or peak gives no verdict',
              nv.get('vNullRate') is None and nv.get('vNullPeak') is None and nv.get('vNullBoth') is None, nv)
        check('fee verdict 0.7.21: a rate below the economy fee (0.6 < 1) is Critical Risk, whatever the peak',
              nv.get('vCrit') == 'Critical Risk' and nv.get('vCritLow') == 'Critical Risk', nv)
        check('fee verdict 0.7.21: a rate AT the economy fee (1.0) is not Critical (it is High Risk at peak 2.0)',
              nv.get('vEconEq') == 'High Risk', nv)
        check('fee verdict 0.7.21: without an economy fee the Critical check is skipped (0.6 at peak 2.0 is High, not Critical)',
              nv.get('vNoEcon') == 'High Risk', nv)
        # No-verdict degradation: a second app whose fee-rates
        # endpoint is a dead port serves feePeak null — the fetch
        # fails at startup and the cache stays empty, so the UI
        # shows no verdict instead of a wrong one. 0.7.21: the
        # same dead base also serves the current recommended fees,
        # so currentFees stays null too (the Critical check is
        # skipped, not guessed).
        nofee_dir = '/tmp/heirloom094-nofee'
        shutil.rmtree(nofee_dir, ignore_errors=True)
        shutil.rmtree(nofee_dir + '-checkin', ignore_errors=True)
        app_nf = start(['node', 'server.js'],
                       env={'PORT': '3381', 'DATA_DIR': nofee_dir,
                            'CHECKIN_DIR': nofee_dir + '-checkin',
                            'FEE_RATES_URL': 'http://127.0.0.1:19999'}, cwd=APP)
        try:
            check('fee verdict 0.7.20: no-fee app up', wait_up('http://127.0.0.1:3381'))
            nf_peak = 'unset'
            nfst = {}
            for _ in range(8):
                time.sleep(1)
                s, nfst = req('GET', '/api/state', base='http://127.0.0.1:3381')
                nf_peak = (nfst.get('bitcoin', {}) or {}).get('feePeak')
            check('fee verdict 0.7.20: with the fee endpoint dead, feePeak stays null (no verdict, not a wrong one)',
                  nf_peak is None, nf_peak)
            check('fee verdict 0.7.20: with the fee endpoint dead, feePeakAt stays null',
                  (nfst.get('bitcoin', {}) or {}).get('feePeakAt') is None, nfst.get('bitcoin', {}))
            check('fee verdict 0.7.21: with the fee endpoint dead, currentFees stays null (no Critical check, not a wrong one)',
                  (nfst.get('bitcoin', {}) or {}).get('currentFees') is None, (nfst.get('bitcoin', {}) or {}).get('currentFees'))
            check('fee verdict 0.7.21: with the fee endpoint dead, currentFeesAt stays null',
                  (nfst.get('bitcoin', {}) or {}).get('currentFeesAt') is None, nfst.get('bitcoin', {}))
        finally:
            stop(app_nf)
        s, st = req('GET', '/api/state')
        ss = st.get('settings', {})
        check('fresh state: primary defaults to mempool.space',
              ss.get('primaryApiUrl') == 'https://mempool.space', ss)
        check('fresh state: secondary defaults to blockstream.info/api',
              ss.get('secondaryApiUrl') == 'https://blockstream.info/api', ss)
        check('fresh state: no broadcastMethod / rpc* / publicApiUrl keys',
              not any(k in ss for k in ('broadcastMethod', 'publicApiUrl', 'rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword')),
              [k for k in ss if 'rpc' in k.lower() or k in ('broadcastMethod', 'publicApiUrl')])
        check('fresh state: checkinKeys is an empty list (0.6.6)',
              st.get('checkinKeys') == [], st.get('checkinKeys'))
        s, r = req('GET', '/api/checkin-keys')
        check('fresh state: no check-in keys listed', s == 200 and r == [], r)

        # URL validation
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'not a url with spaces'})
        check('invalid primary URL -> 400', s == 400, r)
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'ftp://example.com'})
        check('non-http(s) secondary URL -> 400', s == 400, r)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'mempool.example.com'})
        check('bare host primary -> normalised to https',
              s == 200 and r.get('primaryApiUrl') == 'https://mempool.example.com', r)
        s, r = req('PUT', '/api/settings', {'secondaryApiUrl': ''})
        check('empty secondary -> no secondary', s == 200 and r.get('secondaryApiUrl') == '', r)
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': ''})
        check('empty primary -> back to default',
              s == 200 and r.get('primaryApiUrl') == 'https://mempool.space', r)

        # point at the stubs
        s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18160',
                                            'secondaryApiUrl': 'http://127.0.0.1:18161'})
        check('endpoints set to stubs', s == 200 and r.get('primaryApiUrl') == 'http://127.0.0.1:18160', r)

        # tx A: spends Finney vout 1 (unspent per stub) — armed by default in 0.6.5
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1), 'label': 'A unspent', 'notes': ''})
        check('add tx A: new tx defaults to armed (0.6.5)',
              s == 201 and r.get('tx', {}).get('enabled') is True, r)
        txa = r['tx']['id']

        # dry-run via PRIMARY
        s, r = req('POST', '/api/broadcast/test', {'id': txa})
        one = (r.get('results') or [{}])[0]
        check('dry-run via PRIMARY (note names 127.0.0.1:18160)',
              one.get('wouldBroadcast') is True and one.get('verdict') == 'ready' and '127.0.0.1:18160' in (one.get('note') or '') and 'primary' in (one.get('note') or ''), one)

        # test connection: both endpoints OK
        s, r = req('POST', '/api/bitcoin/connection/test', {})
        check('test connection: both OK, detail names Primary + Secondary + tip height',
              r.get('ok') is True and 'Primary' in (r.get('detail') or '') and 'Secondary' in (r.get('detail') or '') and 'tip height' in (r.get('detail') or ''), r)
        s, st = req('GET', '/api/state')
        res_persist = (st.get('bitcoin', {}).get('connection', {}) or {}).get('results') or []
        check('per-endpoint results persist in state (primary+secondary, both ok)',
              len(res_persist) == 2 and all(x.get('ok') is True for x in res_persist)
              and {x.get('endpoint') for x in res_persist} == {'primary', 'secondary'}, res_persist)

        # primary down -> dry-run falls back to SECONDARY
        stop(p_primary)
        time.sleep(0.5)
        s, r = req('POST', '/api/broadcast/test', {'id': txa})
        one = (r.get('results') or [{}])[0]
        check('primary down: dry-run falls back to secondary',
              one.get('wouldBroadcast') is True and one.get('verdict') == 'ready' and '127.0.0.1:18161' in (one.get('note') or '') and 'secondary' in (one.get('note') or ''), one)
        p_primary = start(['node', STUB, '18160'], env={'SENTINEL_TXID': SENTINEL_TXID})
        time.sleep(0.5)

        # tx B: spends Finney vout 0 (spent) — primary verdict is definitive
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0), 'label': 'B spent', 'notes': ''})
        txb = r['tx']['id']
        check('add tx B: armed by default too', r.get('tx', {}).get('enabled') is True, r)
        s, r = req('POST', '/api/broadcast/test', {'id': txb})
        one = (r.get('results') or [{}])[0]
        check('spent verdict from primary is definitive (stale, names primary)',
              one.get('wouldBroadcast') is False and one.get('verdict') == 'blocked' and (one.get('spent') or []) and '127.0.0.1:18160' in (one.get('note') or ''), one)
        # 0.6.5: a dry-run that finds spent inputs RECORDS the stale
        # verdict on the transaction (kind 'dryrun') — it is state
        # now, not page memory, so the card stays Stale on refresh.
        s, st = req('GET', '/api/state')
        b = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txb][0]
        check('dry-run records the stale verdict on the tx (kind dryrun)',
              b.get('release', {}).get('status') == 'stale' and b.get('release', {}).get('kind') == 'dryrun'
              and 'inputs spent' in (b.get('release', {}).get('error') or ''), b.get('release'))

        # both down -> dry-run fails naming both endpoints
        stop(p_primary)
        stop(p_secondary)
        time.sleep(0.5)
        s, r = req('POST', '/api/broadcast/test', {'id': txa})
        one = (r.get('results') or [{}])[0]
        check('both down: dry-run fails naming both endpoints',
              one.get('wouldBroadcast') is False and '127.0.0.1:18160' in (one.get('error') or '') and '127.0.0.1:18161' in (one.get('error') or ''), one)
        p_primary = start(['node', STUB, '18160'], env={'SENTINEL_TXID': SENTINEL_TXID})
        p_secondary = start(['node', STUB, '18161'])
        time.sleep(0.5)

        # sentinel tx C: primary says "already in mempool" -> counts as broadcast
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': SENTINEL_HEX, 'label': 'C sentinel', 'notes': ''})
        txc = r['tx']['id']
        # force release-due: last check-in 100 days ago
        st_path = os.path.join(DATA, 'state.json')
        stj = json.load(open(st_path))
        stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
        json.dump(stj, open(st_path, 'w'), indent=2)
        s, r = req('POST', '/api/release/check', {})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('release broadcasts tx A via primary',
              res.get(txa, {}).get('action') == 'broadcast' and res.get(txa, {}).get('method') == 'primary', res)
        check('release skips B as already stale (declared by the earlier dry-run)',
              res.get(txb, {}).get('action') == 'skipped' and 'stale' in (res.get(txb, {}).get('reason') or ''), res.get(txb))
        check('sentinel tx C: already-in-mempool via primary counts as broadcast',
              res.get(txc, {}).get('action') == 'broadcast' and res.get(txc, {}).get('method') == 'primary', res)
        # 0.6.5: once a release has gone out the check-in status is
        # 'broadcasted' (label Broadcasted), and the release record
        # says kind 'release' (a manual broadcast says 'broadcast')
        s, st = req('GET', '/api/status')
        check('status: after a release broadcast the status is Broadcasted',
              st.get('state') == 'broadcasted' and st.get('label') == 'Broadcasted', st)
        check('status: the old stored-count fields are gone (readiness is client-side now)',
              'bitcoinTxCount' not in st and 'bitcoinEnabledCount' not in st, sorted(st.keys()))
        rel = {x.get('id'): x for x in st.get('releases', [])}
        check('release record: A was broadcast by the release (kind release)',
              rel.get(txa, {}).get('status') == 'broadcast' and rel.get(txa, {}).get('kind') == 'release', rel.get(txa))
        check('release record: B keeps its dry-run stale record (kind dryrun, not overwritten)',
              rel.get(txb, {}).get('status') == 'stale' and rel.get(txb, {}).get('kind') == 'dryrun', rel.get(txb))
        s, blog = req('GET', '/api/broadcast/log')
        check('broadcast log names the primary endpoint',
              any('127.0.0.1:18160' in (e.get('note') or '') for e in blog), blog[-3:] if blog else blog)

        # restart survival
        stop(app)
        app = start(['node', 'server.js'], env={'PORT': str(PORT), 'DATA_DIR': DATA}, cwd=APP)
        check('restart: app up', wait_up(BASE))
        s, st = req('GET', '/api/state')
        check('settings + txs survive restart',
              st.get('settings', {}).get('primaryApiUrl') == 'http://127.0.0.1:18160'
              and len(st.get('bitcoin', {}).get('txs', [])) == 3, st.get('settings'))
        tick_ok = False
        for _ in range(15):
            time.sleep(2)
            s, st = req('GET', '/api/state')
            conn = (st.get('bitcoin', {}).get('connection', {}) or {})
            rs = conn.get('results') or []
            if conn.get('checkedAt') and len(rs) == 2 and all(x.get('ok') is True for x in rs):
                tick_ok = True
                break
        check('hourly tick re-tests the nodes on its own (results fresh after restart)', tick_ok, conn)

        # env override still wins for the primary
        env_dir = '/tmp/heirloom094-env'
        app_env = start(['node', 'server.js'],
                        env={'PORT': '3274', 'DATA_DIR': env_dir,
                             'MEMPOOL_HOST': '127.0.0.1', 'MEMPOOL_PORT': '18159', 'MEMPOOL_PROTOCOL': 'http:'},
                        cwd=APP)
        try:
            ebase = 'http://127.0.0.1:3274'
            check('env instance up', wait_up(ebase))
            req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18160',
                                         'secondaryApiUrl': 'http://127.0.0.1:18161'}, base=ebase)
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1), 'label': 'env', 'notes': ''}, base=ebase)
            env_tx = r['tx']['id']
            s, r = req('POST', '/api/broadcast/test', {'id': env_tx}, base=ebase)
            one = (r.get('results') or [{}])[0]
            check('env override wins: dry-run names 18159 despite setting 18160',
                  one.get('wouldBroadcast') is True and '127.0.0.1:18159' in (one.get('note') or ''), one)
        finally:
            stop(app_env)

        # 0.5.3 -> 0.6.5 migration: RPC password deleted, custom endpoint kept
        mig = '/tmp/heirloom094-mig'
        os.makedirs(mig, exist_ok=True)
        seed = {
            'version': 3,
            'settings': {'thresholdDays': 90, 'primaryApiUrl': 'https://mempool.space',
                         'publicApiUrl': 'http://127.0.0.1:18160',
                         'broadcastMethod': 'both', 'rpcHost': '127.0.0.1',
                         'rpcPort': 8332, 'rpcUser': 'u', 'rpcPassword': 'supersecret'},
            'checkin': {'lastCheckinAt': '2026-11-10T05:50:00.000Z', 'totalCheckins': 13},
            'bitcoin': {'txs': [], 'connection': {'ok': False, 'checkedAt': None, 'detail': ''}},
        }
        json.dump(seed, open(os.path.join(mig, 'state.json'), 'w'), indent=2)
        app_mig = start(['node', 'server.js'], env={'PORT': '3275', 'DATA_DIR': mig}, cwd=APP)
        mbase = 'http://127.0.0.1:3275'
        check('migration instance up', wait_up(mbase))
        s, st = req('GET', '/api/state', base=mbase)
        ss = st.get('settings', {})
        check('migration: version is 5', st.get('version') == 5, st.get('version'))
        check('migration: no broadcastMethod / rpc* / publicApiUrl keys',
              not any(k in ss for k in ('broadcastMethod', 'publicApiUrl', 'rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword')), ss)
        check('migration: custom endpoint carried over as the primary',
              ss.get('primaryApiUrl') == 'http://127.0.0.1:18160', ss)
        raw = open(os.path.join(mig, 'state.json')).read()
        check('migration: RPC password deleted from disk', 'supersecret' not in raw, raw[:200])
        stop(app_mig)

        # --- 0.6.5: manual broadcast -------------------------------
        # tx D: spends Finney vout 1 (same input as A and C), armed by default
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100002), 'label': 'D shares A input', 'notes': ''})
        txd = r['tx']['id']
        # --- 0.6.5: dry-run all skips what is already settled --------
        # tx E: spends Finney vout 1 too, disarmed — the run still checks
        # it (a dry-run is read-only) but does not count it as armed.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100003), 'label': 'E disarmed', 'notes': ''})
        txe = r['tx']['id']
        s, r = req('PUT', '/api/bitcoin/txs/' + txe, {'enabled': False})
        check('disarm tx E (to test dry-run all includes a disarmed tx)',
              s == 200 and r.get('tx', {}).get('enabled') is False, r)
        # B is already release-stale (the release above marked it), so the
        # run skips it and says nothing new about it.
        s, r = req('POST', '/api/broadcast/test', {})
        ov = r.get('overlaps') or []
        res_by_id = {x.get('id'): x for x in r.get('results', [])}
        check('dry-run all 0.6.5: stale B is skipped — it gets no result from the run',
              txb not in res_by_id, sorted(res_by_id.keys()))
        check('dry-run all 0.6.5: aggregate counts the tested armed txs (1 of 1 would broadcast — A and C are already broadcast, B is already stale)',
              '1 of 1 armed transaction(s) would broadcast.' in (r.get('note') or ''), r.get('note'))
        check('dry-run all: shared input flagged (Finney vout 1, live D+E only — A/C archived, round 12)',
              len(ov) == 1 and ov[0].get('input') == FINNEY + ':1'
              and set(ov[0].get('txIds') or []) == {txd, txe}, ov)
        check('dry-run all: aggregate note carries the shared-input warning',
              'Warning' in (r.get('note') or '') and 'shared' in (r.get('note') or ''), r.get('note'))
        check('dry-run all amend 0.7.16: the shared-input warning says confirmed, not broadcast',
              'can ever be confirmed' in (r.get('note') or '') and 'can ever broadcast' not in (r.get('note') or ''), r.get('note'))
        check('dry-run all: results carry the enabled flag (the 0.5.9 aggregate bug)',
              all('enabled' in x for x in r.get('results', [])) and len(r.get('results', [])) == 2, r.get('results'))
        check('dry-run all: the disarmed tx E was actually checked (not the disabled note)',
              res_by_id.get(txe, {}).get('wouldBroadcast') is True and res_by_id.get(txe, {}).get('enabled') is False,
              res_by_id.get(txe))
        # 0.6.5: the state itself carries the shared inputs, derived
        # on every read — no dry-run needed for the warning to exist.
        s, st = req('GET', '/api/state')
        ovl = st.get('bitcoin', {}).get('overlaps') or []
        check('state carries the shared inputs (Finney vout 1, live D+E only — A/C archived, round 12)',
              len(ovl) == 1 and ovl[0].get('input') == FINNEY + ':1'
              and set(ovl[0].get('txIds') or []) == {txd, txe}, ovl)
        s, r = req('POST', '/api/bitcoin/txs/' + txd + '/broadcast', {})
        check('manual broadcast: tx D broadcasts via primary',
              s == 200 and r.get('action') == 'broadcast' and r.get('method') == 'primary', r)
        s, st = req('GET', '/api/state')
        d = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txd][0]
        check('manual broadcast: broadcasted fact + release record set on D',
              bool(d.get('broadcasted')) and bool(d.get('release'))
              and d['broadcasted'].get('method') == 'primary'
              and d['release'].get('status') == 'broadcast', d)
        check('manual broadcast: D was broadcast by hand (kind broadcast, not release)',
              d.get('release', {}).get('kind') == 'broadcast', d.get('release'))
        s, r = req('GET', '/api/bitcoin/confirmations')
        conf = {c.get('id'): c for c in r.get('confirmations', [])}
        check('confirmations: D is 6 deep (tip 900000 - block 899995 + 1), found',
              conf.get(txd, {}).get('confirmations') == 6 and conf.get(txd, {}).get('found') is True, conf)
        check('confirmations: released A and C also 6 deep',
              conf.get(txa, {}).get('confirmations') == 6 and conf.get(txc, {}).get('confirmations') == 6, conf)
        s, r = req('POST', '/api/bitcoin/txs/' + txd + '/broadcast', {})
        check('manual broadcast: already-broadcast D is skipped, not re-sent',
              s == 200 and r.get('action') == 'skipped' and r.get('reason') == 'already broadcast', r)
        s, r = req('POST', '/api/bitcoin/txs/' + txb + '/broadcast', {})
        check('manual broadcast: stale tx B is not broadcast',
              s == 200 and r.get('action') == 'stale' and 'inputs spent' in (r.get('error') or ''), r)
        s, r = req('POST', '/api/bitcoin/txs/tx_nope/broadcast', {})
        check('manual broadcast: unknown tx id -> 404', s == 404, r)

        # broadcast all: tx E is disarmed and unspent — it still broadcasts.
        # 0.6.5: the archived ones (A, C, D already broadcast, B
        # release-stale) are never attempted or counted — they are not
        # in the results at all, only E is.
        s, r = req('POST', '/api/broadcast/all', {})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('broadcast all: E (disarmed) broadcasts via primary',
              res.get(txe, {}).get('action') == 'broadcast' and res.get(txe, {}).get('method') == 'primary', res)
        check('broadcast all: A, C, D (already broadcast) are not in the results',
              all(t not in res for t in (txa, txc, txd)), sorted(res.keys()))
        check('broadcast all: B (release-stale) is not in the results',
              txb not in res, sorted(res.keys()))
        check('broadcast all: only the one non-archived tx was attempted',
              len(res) == 1, sorted(res.keys()))
        # the ids path: an unknown id -> 400, an empty list -> 400
        s, r = req('POST', '/api/broadcast/all', {'ids': ['tx_nope']})
        check('broadcast all ids: unknown id -> 400', s == 400, r)
        s, r = req('POST', '/api/broadcast/all', {'ids': []})
        check('broadcast all ids: empty list -> 400', s == 400, r)
        s, r = req('GET', '/api/bitcoin/confirmations')
        conf = {c.get('id'): c for c in r.get('confirmations', [])}
        check('confirmations: E is 6 deep too',
              conf.get(txe, {}).get('confirmations') == 6, conf)

        # dry-run all after the broadcasts: A, C, D, E are broadcasted
        # and B is release-stale, so there is nothing left to test — the
        # run says so and returns no results. Round 12: the
        # shared-input check excludes archived transactions, so with
        # every tx on Finney vout 1 archived there is no warning at
        # all (before, it still flagged the overlap).
        s, r = req('POST', '/api/broadcast/test', {})
        ov = r.get('overlaps') or []
        check('dry-run all 0.6.5: nothing left to test — no results',
              r.get('results') == [], r.get('results'))
        check('dry-run all 0.6.5: the note says every tx is broadcast or stale',
              'No transactions to check — every stored transaction has already been broadcast or is stale.' in (r.get('note') or ''), r.get('note'))
        check('dry-run all round 12: no shared-input warning once every tx on the input is archived',
              ov == [], ov)
        check('dry-run all round 12: aggregate note carries no shared-input warning',
              'shared' not in (r.get('note') or ''), r.get('note'))
        # a single dry-run of a disabled tx tests it too
        s, r2 = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100005), 'label': 'F disarmed', 'notes': ''})
        txf = r2['tx']['id']
        req('PUT', '/api/bitcoin/txs/' + txf, {'enabled': False})
        s, r2 = req('POST', '/api/broadcast/test', {'id': txf})
        one = (r2.get('results') or [{}])[0]
        check('single dry-run: a disabled tx is actually checked (would broadcast)',
              one.get('wouldBroadcast') is True and one.get('enabled') is False, one)
        s, r = req('POST', '/api/broadcast/test', {'id': txa})
        check('single dry-run: no overlap check',
              r.get('overlaps') == [], r.get('overlaps'))
        # Round 12: one live tx sharing an input with archived txs —
        # no shared-input warning. A, C, D, E are broadcasted
        # (archived) and B is stale (archived); F is the only live
        # tx spending Finney vout 1, so the check must stay silent
        # even though six stored txs share the input.
        s, r = req('POST', '/api/broadcast/test', {})
        check('dry-run all round 12: one live + archived txs sharing an input — no warning',
              r.get('overlaps') == [], r.get('overlaps'))
        check('dry-run all round 12: aggregate note carries no shared-input warning',
              'shared' not in (r.get('note') or ''), r.get('note'))
        s, st = req('GET', '/api/state')
        ovl = st.get('bitcoin', {}).get('overlaps') or []
        check('state round 12: overlaps empty when only one live tx shares the input',
              ovl == [], ovl)

        # check-in clears the cycle release record, NOT the broadcasted fact
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('check-in lands', s == 200, r)
        s, st = req('GET', '/api/state')
        txs = {t.get('id'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check('check-in: release records cleared',
              all(txs[t].get('release') is None for t in (txa, txc, txd, txe)), txs)
        check('check-in: broadcasted facts survive',
              all(bool(txs[t].get('broadcasted')) for t in (txa, txc, txd, txe)), txs)
        # 0.6.5: a stale record is NOT cleared by a check-in — it is a
        # fact about the inputs, not the cycle (B's record was written
        # by the release above, kind 'release', and survives).
        check('check-in: B stays stale (stale record survives the check-in)',
              txs[txb].get('release', {}).get('status') == 'stale', txs[txb].get('release'))
        # 0.6.5: the check-in resets the Broadcasted status to On track
        # (the release records are gone, so nothing says 'broadcasted')
        s, st = req('GET', '/api/status')
        check('status: after a check-in the status is On track again',
              st.get('state') == 'on-track' and st.get('label') == 'On track', st)

        # 0.7.16 (Pending card): the hex is immutable once the tx is
        # out the door — replacing D's hex (it was broadcast by hand)
        # is rejected, and the broadcasted fact + release record stay.
        # A label/notes change on the same broadcast tx is still
        # allowed (the edit restriction is hex-only).
        s, r = req('PUT', '/api/bitcoin/txs/' + txd, {'txHex': craft(1, 100004)})
        check('hex locked 0.7.16: replacing a broadcast tx hex is rejected',
              s == 400 and 'cannot be changed once it has been broadcast' in (r.get('error') or ''), r)
        s, st = req('GET', '/api/state')
        d2 = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txd][0]
        check('hex locked 0.7.16: the rejected replace leaves the broadcasted fact intact and the hex unchanged',
              bool(d2.get('broadcasted'))
              and d2.get('hex') == craft(1, 100002), d2)
        s, r = req('PUT', '/api/bitcoin/txs/' + txd, {'label': 'D renamed', 'notes': 'renamed after broadcast'})
        check('hex locked 0.7.16: label/notes on a broadcast tx are still allowed',
              s == 200 and r.get('tx', {}).get('label') == 'D renamed'
              and r.get('tx', {}).get('notes') == 'renamed after broadcast'
              and bool(r.get('tx', {}).get('broadcasted')), r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txd, {'txHex': d2.get('hex')})
        check('hex locked 0.7.16: re-saving the SAME hex on a broadcast tx is a no-op (allowed)',
              s == 200 and bool(r.get('tx', {}).get('broadcasted')), r)
        # A stale tx is Archived too, so its hex is locked as well
        # (its inputs are spent — it is a dead tx, not a draft).
        s, r = req('PUT', '/api/bitcoin/txs/' + txb, {'txHex': craft(1, 100009)})
        check('hex locked 0.7.16: replacing a stale tx hex is rejected',
              s == 400 and 'cannot be changed once it has been broadcast' in (r.get('error') or ''), r)
        s, r = req('PUT', '/api/bitcoin/txs/' + txb, {'label': 'B stale renamed'})
        check('hex locked 0.7.16: label on a stale tx is still allowed',
              s == 200 and r.get('tx', {}).get('label') == 'B stale renamed', r)

        # the release now skips an already-broadcast tx instead of
        # marking it stale (its inputs are spent by its own broadcast)
        stj = json.load(open(st_path))
        stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
        json.dump(stj, open(st_path, 'w'), indent=2)
        s, r = req('POST', '/api/release/check', {})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('release after check-in: A skipped as already broadcast (not stale)',
              res.get(txa, {}).get('action') == 'skipped' and res.get(txa, {}).get('reason') == 'already broadcast', res)
        # 0.7.16: D's hex can no longer be replaced once broadcast, so
        # D stays broadcasted and the release skips it too (it is not
        # broadcast a second time).
        check('release after check-in: D (broadcast, hex locked) is skipped as already broadcast',
              res.get(txd, {}).get('action') == 'skipped' and res.get(txd, {}).get('reason') == 'already broadcast', res)
        check('release after check-in: B skipped as already stale (its record survived the check-in)',
              res.get(txb, {}).get('action') == 'skipped' and 'stale' in (res.get(txb, {}).get('reason') or ''), res.get(txb))

        # --- 0.6.5: backup & restore --------------------------------
        s, r = req('GET', '/api/backup')
        check('backup: format + version + all 6 txs with hexes',
              s == 200 and r.get('format') == 'standby-backup' and r.get('version') == 1
              and len(r.get('state', {}).get('bitcoin', {}).get('txs', [])) == 6
              and all(t.get('hex') for t in r['state']['bitcoin']['txs']), r)
        check('backup: carries the check-in clock + both history logs',
              isinstance(r.get('checkins'), list) and isinstance(r.get('broadcastLog'), list)
              and r.get('state', {}).get('checkin', {}).get('totalCheckins', 0) >= 1, r)
        original = json.loads(json.dumps(r))
        backup = json.loads(json.dumps(r))
        backup['state']['bitcoin']['txs'][0]['label'] = 'Restored label'
        backup['state']['settings']['thresholdDays'] = 42
        s, r = req('POST', '/api/restore', backup)
        check('restore: modified backup restores (label + threshold changed)',
              s == 200 and r.get('restoredTxs') == 6
              and r.get('state', {}).get('settings', {}).get('thresholdDays') == 42
              and r.get('state', {}).get('bitcoin', {}).get('txs', [{}])[0].get('label') == 'Restored label', r)
        s, r = req('POST', '/api/restore', original)
        check('restore: the original backup restores back (threshold 35, label A unspent)',
              s == 200 and r.get('state', {}).get('settings', {}).get('thresholdDays') == 35
              and r.get('state', {}).get('bitcoin', {}).get('txs', [{}])[0].get('label') == 'A unspent', r)
        s, r = req('POST', '/api/restore', {})
        check('restore: not a backup -> 400', s == 400, r)
        s, r = req('POST', '/api/restore', {'format': 'standby-backup', 'version': 2, 'state': {}})
        check('restore: unsupported version -> 400', s == 400, r)
        s, r = req('POST', '/api/restore', {'format': 'heirloom-backup', 'version': 1, 'state': {}})
        check('restore 0.7.0: the old heirloom-backup format is rejected (break is intentional)', s == 400 and 'standby-backup' in (r.get('error') or ''), r)
        bad = json.loads(json.dumps(original))
        bad['state']['bitcoin']['txs'][0]['hex'] = 'not hex at all'
        s, r = req('POST', '/api/restore', bad)
        check('restore: a bad hex in the backup -> 400', s == 400, r)

        # --- 0.6.5: broadcast all with ids -------------------------
        # A new tx G (unspent, armed). Broadcasting with ids [G, A]:
        # only G is attempted — A is already broadcast, so it is not
        # in the results at all. G uses its own value (100008): F
        # already holds craft(1, 100005), and duplicate txids are
        # rejected.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100008), 'label': 'G ids', 'notes': ''})
        txg = r['tx']['id']
        s, r = req('POST', '/api/broadcast/all', {'ids': [txg, txa]})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('broadcast all ids: only the listed non-archived tx is attempted',
              len(res) == 1 and res.get(txg, {}).get('action') == 'broadcast', res)
        check('broadcast all ids: the already-broadcast id is not in the results',
              txa not in res, sorted(res.keys()))

        # --- 0.6.5: dry-run stale verdict survives everything --------
        # A fresh spent tx H: a single dry-run records it stale (kind
        # 'dryrun'), and the record then survives a dry-run all
        # (H is skipped), a broadcast all (H is not attempted), a
        # check-in, and a server restart.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 100006), 'label': 'H dryrun stale', 'notes': ''})
        txh = r['tx']['id']
        s, r = req('POST', '/api/broadcast/test', {'id': txh})
        one = (r.get('results') or [{}])[0]
        check('dry-run on H finds it spent',
              one.get('wouldBroadcast') is False and (one.get('spent') or []), one)
        s, st = req('GET', '/api/state')
        h = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txh][0]
        check('dry-run on H records stale kind dryrun on the tx',
              h.get('release', {}).get('status') == 'stale' and h.get('release', {}).get('kind') == 'dryrun', h.get('release'))
        s, r = req('POST', '/api/broadcast/test', {})
        res_by_id = {x.get('id'): x for x in r.get('results', [])}
        check('dry-run all skips the dryrun-stale H (no new status)',
              txh not in res_by_id, sorted(res_by_id.keys()))
        s, r = req('POST', '/api/broadcast/all', {})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('broadcast all (no ids): H is not attempted',
              txh not in res, sorted(res.keys()))
        check('broadcast all (no ids): only the unspent F was attempted',
              len(res) == 1 and res.get(txf, {}).get('action') == 'broadcast', res)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('check-in lands (H section)', s == 200, r)
        s, st = req('GET', '/api/state')
        h = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txh][0]
        check('check-in preserves H stale kind dryrun',
              h.get('release', {}).get('status') == 'stale' and h.get('release', {}).get('kind') == 'dryrun', h.get('release'))
        stop(app)
        app = start(['node', 'server.js'],
                    env={'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR}, cwd=APP)
        check('restart (H section): app up', wait_up(BASE))
        s, st = req('GET', '/api/state')
        h = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txh][0]
        check('restart preserves H stale kind dryrun',
              h.get('release', {}).get('status') == 'stale' and h.get('release', {}).get('kind') == 'dryrun', h.get('release'))
        b = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == txb][0]
        check('restart preserves B stale too',
              b.get('release', {}).get('status') == 'stale', b.get('release'))

        # --- 0.6.6: check-in API keys + receiver --------------------
        # Receiver rejects without a key, and with a wrong key, before
        # any key exists.
        s, r = req('POST', '/checkin', {}, base=RBASE)
        check('receiver: no key -> 401 invalid check-in key',
              s == 401 and r.get('error') == 'invalid check-in key', r)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer nope'})
        check('receiver 0.7.1: no keys configured -> the same generic 401',
              s == 401 and r.get('error') == 'invalid check-in key', r)
        s, r = req('GET', '/unknown', base=RBASE)
        check('receiver: unknown path -> 404', s == 404, r)
        # Create key 1 (Muse): the plaintext comes back ONCE, 43 chars
        # of base64url, and the listed key carries no hash.
        s, r = req('POST', '/api/checkin-keys', {'label': 'Check-in bot'})
        check('create key: 201 + plaintext returned once (43-char base64url)',
              s == 201 and isinstance(r.get('plain'), str) and len(r['plain']) == 43
              and all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' for c in r['plain']), r)
        plain1 = r['plain']
        key1 = r['key']['id']
        check('create key: the listed key has no hash and no plaintext',
              'hash' not in r.get('key', {}) and 'plain' not in r.get('key', {}), r.get('key'))
        check('create key: lastUsedAt starts null',
              r['key'].get('lastUsedAt') is None, r['key'])
        s, r = req('GET', '/api/checkin-keys')
        check('list keys: one key, no hash anywhere in the response',
              s == 200 and len(r) == 1 and r[0].get('id') == key1
              and 'hash' not in json.dumps(r), r)
        # The hash — and only the hash — is on disk: state.json holds
        # sha256(plain), never the plain itself.
        raw = open(os.path.join(DATA, 'state.json')).read()
        check('state file: holds the key hash, never the plaintext',
              hashlib.sha256(plain1.encode()).hexdigest() in raw and plain1 not in raw, raw[-200:])
        keys_doc = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
        check('keys.json: the receiver list carries id + label + hash',
              len(keys_doc.get('keys', [])) == 1
              and keys_doc['keys'][0].get('id') == key1
              and keys_doc['keys'][0].get('hash') == hashlib.sha256(plain1.encode()).hexdigest(), keys_doc)
        check('keys.json: no transaction data in the receiver list (no hex/txid)',
              'hex' not in json.dumps(keys_doc) and 'txid' not in json.dumps(keys_doc), keys_doc)
        s, rb = req('GET', '/api/backup')
        check('backup 0.7.1: the backup doc still carries the key hashes (restores keep keys working)',
              s == 200 and len(rb.get('state', {}).get('checkinKeys', [])) == 1
              and rb['state']['checkinKeys'][0].get('hash') == hashlib.sha256(plain1.encode()).hexdigest(), rb.get('state', {}).get('checkinKeys'))
        s, rs = req('GET', '/api/state')
        check('state 0.7.1: the served state strips the key hashes',
              s == 200 and all('hash' not in k for k in rs.get('checkinKeys', [])), rs.get('checkinKeys'))
        # Receiver: wrong key 401; the right key 200, and the timestamp
        # file it writes holds no transaction data either.
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer wrongkey'})
        check('receiver: wrong key -> 401 invalid check-in key',
              s == 401 and r.get('error') == 'invalid check-in key', r)
        s, st_before = req('GET', '/api/status')
        total_before = st_before.get('totalCheckins', 0)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain1})
        check('receiver 0.7.1: valid Bearer token -> 200 with exactly {ok: true}',
              s == 200 and r == {'ok': True}, r)
        # The timestamp is no longer in the response — it lives in
        # last.json, which the app still merges into the clock.
        ts1 = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))['lastCheckinAt']
        last_doc = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))
        check('last.json: timestamp + key id + label, no transaction data',
              last_doc.get('lastCheckinAt') == ts1 and last_doc.get('keyId') == key1
              and last_doc.get('label') == 'Check-in bot'
              and 'hex' not in json.dumps(last_doc) and 'txid' not in json.dumps(last_doc), last_doc)
        # The app merges it on the next status read: the clock moves to
        # the receiver's timestamp and the total goes up by one.
        s, st = req('GET', '/api/status')
        check('merge: status clock is the receiver timestamp, total +1',
              st.get('lastCheckinAt') == ts1 and st.get('totalCheckins') == total_before + 1, st)
        s, st = req('GET', '/api/status')
        check('merge: a second status read changes nothing (idempotent)',
              st.get('lastCheckinAt') == ts1 and st.get('totalCheckins') == total_before + 1, st)
        s, r = req('GET', '/api/checkin-keys')
        check('merge: the key shows last used at the receiver timestamp',
              len(r) == 1 and r[0].get('lastUsedAt') == ts1, r)
        s, r = req('GET', '/api/checkins')
        check('merge: the check-in log says api-key + the key label',
              r and r[0].get('method') == 'api-key' and r[0].get('keyLabel') == 'Check-in bot', r[0] if r else r)
        check('merge 0.7.12: last.json carries the caller address (loopback here)',
              last_doc.get('sourceIp') == '127.0.0.1', last_doc)
        check('merge 0.7.12: the check-in log entry carries the caller address',
              r and r[0].get('sourceIp') == '127.0.0.1', r[0] if r else r)
        # X-Api-Key works too (a phone shortcut cannot always set
        # Authorization).
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'X-Api-Key': plain1})
        check('receiver 0.7.1: X-Api-Key header also checks in (exactly {ok: true})',
              s == 200 and r == {'ok': True}, r)
        ts2 = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))['lastCheckinAt']
        s, st = req('GET', '/api/status')
        check('merge: the second receiver check-in moves the clock again',
              st.get('lastCheckinAt') == ts2 and st.get('totalCheckins') == total_before + 2, st)
        # A future timestamp is ignored (a skewed clock, not a
        # check-in), and so is one older than the clock.
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace('+00:00', 'Z')
        json.dump({'lastCheckinAt': future, 'keyId': key1, 'label': 'Check-in bot', 'receivedAt': future},
                  open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'), indent=2)
        s, st = req('GET', '/api/status')
        check('merge: a timestamp an hour in the future is ignored',
              st.get('lastCheckinAt') == ts2 and st.get('totalCheckins') == total_before + 2, st)
        old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat().replace('+00:00', 'Z')
        json.dump({'lastCheckinAt': old, 'keyId': key1, 'label': 'Check-in bot', 'receivedAt': old},
                  open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'), indent=2)
        s, st = req('GET', '/api/status')
        check('merge: a timestamp older than the clock is ignored',
              st.get('lastCheckinAt') == ts2 and st.get('totalCheckins') == total_before + 2, st)
        # 0.7.12: a last.json written by an older receiver (no
        # sourceIp) still merges — the address is optional.
        new_ts = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        json.dump({'lastCheckinAt': new_ts, 'keyId': key1, 'label': 'Check-in bot', 'receivedAt': new_ts},
                  open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'), indent=2)
        s, st = req('GET', '/api/status')
        check('merge 0.7.12: a last.json with no sourceIp still merges (backward compatible)',
              st.get('lastCheckinAt') == new_ts and st.get('totalCheckins') == total_before + 3, st)
        s, r = req('GET', '/api/checkins')
        check('merge 0.7.12: the entry from a sourceless last.json has sourceIp null',
              r and r[0].get('sourceIp') is None, r[0] if r else r)
        s, r = req('POST', '/api/checkin', {'method': 'app'})
        check('check-in 0.7.12: an in-app check-in lands', s == 200, r)
        s, r = req('GET', '/api/checkins')
        check('check-in 0.7.12: the in-app entry has no source address (it came through the proxy)',
              r and r[0].get('method') == 'app' and r[0].get('sourceIp') is None, r[0] if r else r)
        # A second key works immediately (the receiver reads keys.json
        # fresh on every request); revoking it refuses it at once,
        # while key 1 keeps working.
        s, r = req('POST', '/api/checkin-keys', {'label': 'Telegram bot'})
        plain2 = r['plain']
        key2 = r['key']['id']
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain2})
        check('receiver 0.7.1: a key created after the receiver started works at once (exactly {ok: true})',
              s == 200 and r == {'ok': True}, r)
        s, r = req('DELETE', '/api/checkin-keys/' + key2)
        check('revoke key 2', s == 200 and r.get('removed') == key2, r)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain2})
        check('receiver: a revoked key is refused immediately',
              s == 401 and r.get('error') == 'invalid check-in key', r)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain1})
        check('receiver: key 1 still works after key 2 is revoked',
              s == 200 and r.get('ok') is True, r)
        # A receiver check-in clears a cycle release record but never a
        # stale one, and never the broadcasted fact — the same
        # semantics as an in-app check-in. Force a release for a fresh
        # tx I first.
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100007), 'label': 'I release test', 'notes': ''})
        txi = r['tx']['id']
        # 0.7.12: the manual release check now merges a receiver
        # check-in first — so the last.json on disk (a recent
        # receiver check-in from the tests above) would reset the
        # backdated clock and the release would never fire. Pin
        # last.json to the same backdated instant: a timestamp no
        # newer than the clock is ignored by the merge, so the
        # release-due setup stands.
        ago100 = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
        json.dump({'lastCheckinAt': ago100, 'keyId': key1, 'label': 'Check-in bot', 'receivedAt': ago100},
                  open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'), indent=2)
        stj = json.load(open(st_path))
        stj['checkin']['lastCheckinAt'] = ago100
        json.dump(stj, open(st_path, 'w'), indent=2)
        s, r = req('POST', '/api/release/check', {})
        res = {x.get('id'): x for x in r.get('results', [])}
        check('release: fresh tx I broadcasts (kind release)',
              res.get(txi, {}).get('action') == 'broadcast' and res.get(txi, {}).get('method') == 'primary', res)
        check('release: B and H skipped as already stale',
              res.get(txb, {}).get('action') == 'skipped' and res.get(txh, {}).get('action') == 'skipped', res)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain1})
        check('receiver: check-in after the release lands', s == 200, r)
        s, st = req('GET', '/api/state')
        txs = {t.get('id'): t for t in st.get('bitcoin', {}).get('txs', [])}
        check('merge: I release record cleared, broadcasted fact survives',
              txs[txi].get('release') is None and bool(txs[txi].get('broadcasted')), txs[txi])
        check('merge: B and H stay stale through a receiver check-in',
              txs[txb].get('release', {}).get('status') == 'stale'
              and txs[txh].get('release', {}).get('status') == 'stale', txs[txb].get('release'))
        s, st = req('GET', '/api/status')
        check('merge: status is On track again after the receiver check-in',
              st.get('state') == 'on-track', st)
        # Backup / restore carries the keys (hashes only) — and the
        # receiver's list follows the restore.
        s, r = req('POST', '/api/checkin-keys', {'label': 'Backup key'})
        plain3 = r['plain']
        key3 = r['key']['id']
        s, r = req('GET', '/api/backup')
        bk_keys = r.get('state', {}).get('checkinKeys', [])
        check('backup: carries the keys (hashes only, no plaintext)',
              len(bk_keys) == 2 and all('hash' in k for k in bk_keys)
              and plain1 not in json.dumps(r) and plain3 not in json.dumps(r), bk_keys)
        mod = json.loads(json.dumps(r))
        mod['state']['checkinKeys'][1]['label'] = 'Restored key label'
        s, r = req('POST', '/api/restore', mod)
        check('restore: the relabelled key comes back',
              s == 200 and len(r.get('state', {}).get('checkinKeys', [])) == 2
              and r['state']['checkinKeys'][1].get('label') == 'Restored key label', r)
        keys_doc = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
        check('restore: keys.json rewritten with the restored hashes',
              len(keys_doc.get('keys', [])) == 2
              and keys_doc['keys'][1].get('hash') == hashlib.sha256(plain3.encode()).hexdigest(), keys_doc)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain3})
        check('restore 0.7.1: the restored key still checks in (same hash; response is exactly {ok: true})',
              s == 200 and r == {'ok': True}, r)
        bad = json.loads(json.dumps(mod))
        bad['state']['checkinKeys'][0]['hash'] = 'not-a-hash'
        s, r = req('POST', '/api/restore', bad)
        check('restore: a malformed key entry -> 400', s == 400, r)
        # Restart: the keys survive on disk and in the receiver list.
        stop(app)
        app = start(['node', 'server.js'],
                    env={'PORT': str(PORT), 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR}, cwd=APP)
        check('restart (keys): app up', wait_up(BASE))
        s, r = req('GET', '/api/checkin-keys')
        check('restart: both keys still listed',
              s == 200 and len(r) == 2 and {k.get('id') for k in r} == {key1, key3}, r)
        keys_doc = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
        check('restart: keys.json still has both hashes',
              len(keys_doc.get('keys', [])) == 2, keys_doc)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain1})
        check('restart: key 1 still checks in after a restart', s == 200, r)
        # Revoke everything: the list empties, the receiver list
        # empties, and the receiver refuses.
        s, r = req('DELETE', '/api/checkin-keys/' + key1)
        check('revoke key 1', s == 200, r)
        s, r = req('DELETE', '/api/checkin-keys/' + key3)
        check('revoke key 3', s == 200, r)
        s, r = req('GET', '/api/checkin-keys')
        check('revoke all: the list is empty', s == 200 and r == [], r)
        keys_doc = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
        check('revoke all: keys.json is empty', keys_doc.get('keys') == [], keys_doc)
        s, r = req('POST', '/checkin', {}, base=RBASE,
                   headers={'Authorization': 'Bearer ' + plain1})
        check('revoke all 0.7.1: the receiver refuses with the same generic 401',
              s == 401 and r.get('error') == 'invalid check-in key', r)
        s, r = req('DELETE', '/api/checkin-keys/key_nope')
        check('revoke: unknown key -> 404', s == 404, r)
        s, r = req('POST', '/api/checkin-keys', {'label': ''})
        check('create key: an empty label becomes Untitled key',
              s == 201 and r['key'].get('label') == 'Untitled key', r)
        s, r = req('DELETE', '/api/checkin-keys/' + r['key']['id'])
        check('revoke the untitled key (tidy up)', s == 200, r)

        # --- 0.6.5: overlaps derived on read; edit clears them ------
        ov_dir = '/tmp/heirloom094-overlap'
        shutil.rmtree(ov_dir, ignore_errors=True)
        os.makedirs(ov_dir, exist_ok=True)
        app_ov = start(['node', 'server.js'], env={'PORT': '3276', 'DATA_DIR': ov_dir}, cwd=APP)
        obase = 'http://127.0.0.1:3276'
        try:
            check('overlap instance up', wait_up(obase))
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200001), 'label': 'X shares', 'notes': ''}, base=obase)
            txx = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 200002), 'label': 'Y shares', 'notes': ''}, base=obase)
            txy = r['tx']['id']
            s, st = req('GET', '/api/state', base=obase)
            ovl = st.get('bitcoin', {}).get('overlaps') or []
            check('overlaps: state carries the shared input with no dry-run run',
                  len(ovl) == 1 and ovl[0].get('input') == FINNEY + ':1'
                  and set(ovl[0].get('txIds') or []) == {txx, txy}, ovl)
            s, r = req('PUT', '/api/bitcoin/txs/' + txy, {'txHex': craft(0, 200003)}, base=obase)
            check('overlaps: Y edited to a new input (hex replaced)', s == 200, r)
            s, st = req('GET', '/api/state', base=obase)
            ovl = st.get('bitcoin', {}).get('overlaps') or []
            check('overlaps: editing Y away from the shared input clears the warning',
                  ovl == [], ovl)
        finally:
            stop(app_ov)

        # --- round 12: broadcast all, armed only -------------------
        # A fresh instance: K (armed, unspent) and L (disarmed,
        # unspent) both spend Finney vout 1. Broadcast-all with
        # armedOnly sends only K; L is skipped, not sent. With no
        # armed txs left, the armed-only call fails cleanly instead
        # of broadcasting nothing. A plain broadcast all still sends
        # the disarmed tx.
        armed_dir = '/tmp/heirloom094-armed'
        shutil.rmtree(armed_dir, ignore_errors=True)
        os.makedirs(armed_dir, exist_ok=True)
        app_armed = start(['node', 'server.js'], env={'PORT': '3277', 'DATA_DIR': armed_dir}, cwd=APP)
        abase = 'http://127.0.0.1:3277'
        try:
            check('armed instance up', wait_up(abase))
            s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18160',
                                                'secondaryApiUrl': 'http://127.0.0.1:18161'}, base=abase)
            assert s == 200, r
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100011), 'label': 'K armed', 'notes': ''}, base=abase)
            txk = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100012), 'label': 'L disarmed', 'notes': ''}, base=abase)
            txl = r['tx']['id']
            s, r = req('PUT', '/api/bitcoin/txs/' + txl, {'enabled': False}, base=abase)
            check('armed-only setup: L disarmed', s == 200 and r.get('tx', {}).get('enabled') is False, r)
            # armedOnly with ids: only the armed one is attempted,
            # even though the disarmed id was listed too.
            s, r = req('POST', '/api/broadcast/all', {'ids': [txk, txl], 'armedOnly': True}, base=abase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('broadcast all armedOnly (ids): only the armed tx broadcasts',
                  len(res) == 1 and res.get(txk, {}).get('action') == 'broadcast', res)
            check('broadcast all armedOnly (ids): the disarmed tx is not in the results',
                  txl not in res, sorted(res.keys()))
            # armedOnly with no ids: L is the only live tx and it is
            # disarmed, so there is nothing armed to broadcast.
            s, r = req('POST', '/api/broadcast/all', {'armedOnly': True}, base=abase)
            check('broadcast all armedOnly (no ids): no armed txs left -> 400',
                  s == 400 and 'armed' in (r.get('error') or ''), r)
            # plain broadcast all still sends the disarmed tx.
            s, r = req('POST', '/api/broadcast/all', {}, base=abase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('broadcast all (plain): the disarmed tx still broadcasts',
                  len(res) == 1 and res.get(txl, {}).get('action') == 'broadcast', res)
        finally:
            stop(app_armed)

        # --- 0.6.10: a broadcast the network no longer knows -------
        # A broadcasted transaction the stubs never saw: restore a
        # backup carrying one (its txid was never POSTed, so both
        # endpoints 404 it — the dropped-from-the-mempool case the owner
        # hit with two transactions sharing an input). The
        # confirmations check must report it not found, persist
        # that verdict, and keep saying so on a second check.
        drop_dir = '/tmp/heirloom094-dropped'
        shutil.rmtree(drop_dir, ignore_errors=True)
        os.makedirs(drop_dir, exist_ok=True)
        app_drop = start(['node', 'server.js'], env={'PORT': '3380', 'DATA_DIR': drop_dir}, cwd=APP)
        dbase = 'http://127.0.0.1:3380'
        try:
            check('dropped instance up', wait_up(dbase))
            s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18160',
                                                'secondaryApiUrl': 'http://127.0.0.1:18161'}, base=dbase)
            assert s == 200, r
            s, r = req('GET', '/api/backup', base=dbase)
            bak = json.loads(json.dumps(r))
            ghex = craft(1, 100099)
            bak['state']['bitcoin']['txs'].append({
                'id': 'tx_dropped', 'hex': ghex, 'label': 'G dropped',
                'broadcasted': {'txid': txid_of(ghex),
                                'broadcastedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                                'method': 'primary', 'confirmations': None, 'blockHeight': None,
                                'found': True, 'checkedAt': None}})
            s, r = req('POST', '/api/restore', bak, base=dbase)
            check('dropped: restore seeds the broadcasted tx',
                  s == 200 and r.get('restoredTxs') == 1, r)
            s, r = req('GET', '/api/bitcoin/confirmations', base=dbase)
            conf = {c.get('id'): c for c in r.get('confirmations', [])}
            check('dropped: confirmations reports a never-seen txid as not found',
                  conf.get('tx_dropped', {}).get('found') is False
                  and conf.get('tx_dropped', {}).get('confirmations') is None, conf)
            s, st = req('GET', '/api/state', base=dbase)
            g = [t for t in st.get('bitcoin', {}).get('txs', []) if t.get('id') == 'tx_dropped'][0]
            check('dropped: the not-found verdict is persisted on the tx',
                  g.get('broadcasted', {}).get('found') is False, g.get('broadcasted'))
            s, r = req('GET', '/api/bitcoin/confirmations', base=dbase)
            conf = {c.get('id'): c for c in r.get('confirmations', [])}
            check('dropped: a second check still says not found (no stale cache)',
                  conf.get('tx_dropped', {}).get('found') is False, conf)
            # Control: a broadcasted tx the stubs DO know stays found.
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 100100), 'label': 'H control', 'notes': ''}, base=dbase)
            txh = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs/' + txh + '/broadcast', {}, base=dbase)
            check('dropped: control tx H broadcasts via primary',
                  s == 200 and r.get('action') == 'broadcast', r)
            s, r = req('GET', '/api/bitcoin/confirmations', base=dbase)
            conf = {c.get('id'): c for c in r.get('confirmations', [])}
            check('dropped: control tx H is found, 6 confirmations',
                  conf.get(txh, {}).get('found') is True and conf.get(txh, {}).get('confirmations') == 6, conf)
        finally:
            stop(app_drop)

        # 0.7.12 — the release timer is exact now: the decision compares
        # real timestamps, not the floored day count. With a 35-day
        # threshold the status must flip to 'release-due' at exactly 35
        # days (not a day late), and stay 'on-track' an hour before.
        # No txs at all here, so no tick can broadcast anything.
        tdata = '/tmp/heirloom094-timer'
        tbase = 'http://127.0.0.1:3382'
        shutil.rmtree(tdata, ignore_errors=True)
        app_t = start(['node', 'server.js'],
                      env={'PORT': '3382', 'DATA_DIR': tdata, 'CHECKIN_DIR': tdata + '-checkin'},
                      cwd=APP)
        try:
            check('timer: app up', wait_up(tbase))
            def set_last(delta):
                st_path = os.path.join(tdata, 'state.json')
                stj = json.load(open(st_path))
                stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - delta).isoformat().replace('+00:00', 'Z')
                json.dump(stj, open(st_path, 'w'), indent=2)
            def status_state():
                s, st = req('GET', '/api/status', base=tbase)
                return st.get('state')
            set_last(timedelta(days=35))
            check('timer: exactly 35 days ago is release-due (not on-track)', status_state() == 'release-due', status_state())
            set_last(timedelta(days=35, hours=12))
            check('timer: 35 days 12 hours ago is release-due', status_state() == 'release-due', status_state())
            set_last(timedelta(days=34, hours=23))
            check('timer: 1 hour short of the threshold is still on-track', status_state() == 'on-track', status_state())
            # 0.7.19: the fields the check-in card renders off — the
            # day count, the due instant, and the last check-in —
            # must agree with the seeded clock and the configured
            # threshold (read from state, never hardcoded). No txs
            # here, so no tick can broadcast anything.
            s, full = req('GET', '/api/state', base=tbase)
            thr = full['settings']['thresholdDays']
            set_last(timedelta(days=10))
            s, st = req('GET', '/api/status', base=tbase)
            last_dt = datetime.fromisoformat(st['lastCheckinAt'].replace('Z', '+00:00'))
            due_dt = datetime.fromisoformat(st['nextDue'].replace('Z', '+00:00'))
            check('status fields 0.7.19: 10 days ago -> daysSince 10, on-track',
                  st.get('daysSince') == 10 and st.get('state') == 'on-track' and st.get('label') == 'On track', st)
            check('status fields 0.7.19: nextDue is lastCheckinAt + thresholdDays',
                  abs((due_dt - last_dt).total_seconds() - thr * 86400) < 2,
                  (st.get('lastCheckinAt'), st.get('nextDue'), thr))
            check('status fields 0.7.19: lastCheckinAt echoes the seeded check-in',
                  abs((datetime.now(timezone.utc) - last_dt).total_seconds() - 10 * 86400) < 300,
                  st.get('lastCheckinAt'))
            set_last(timedelta(days=thr))
            s, st = req('GET', '/api/status', base=tbase)
            check('status fields 0.7.19: exactly the threshold ago -> daysSince is the threshold, release-due',
                  st.get('daysSince') == thr and st.get('state') == 'release-due', st)
            # No check-in at all: the card's inputs are all null.
            st_path = os.path.join(tdata, 'state.json')
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = None
            json.dump(stj, open(st_path, 'w'), indent=2)
            s, st = req('GET', '/api/status', base=tbase)
            check('status fields 0.7.19: no check-in yet -> daysSince/nextDue null, not-started',
                  st.get('state') == 'not-started' and st.get('label') == 'Not started'
                  and st.get('daysSince') is None and st.get('nextDue') is None, st)
        finally:
            stop(app_t)

        # 0.7.12 — all-or-none release: a check-in that lands while a
        # release is running no longer stops the broadcast (the 0.7.6
        # race test asserted the opposite — that behavior is now
        # intentionally removed). The check-in must still be recorded:
        # the broadcast write is merge-only, so the check-in survives
        # the save. Two overlapping release evaluations must still not
        # broadcast twice (the single-flight lock is unchanged).
        # Delayed stubs (400 ms on every outspend answer) open a window
        # a check-in can land in. Uses its own stubs + app so the delay
        # does not slow the rest of the suite.
        rdata = '/tmp/heirloom094-race'
        rbase = 'http://127.0.0.1:3384'
        shutil.rmtree(rdata, ignore_errors=True)
        rs1 = start(['node', STUB, '18162'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_OUTSPEND_DELAY_MS': '400'})
        rs2 = start(['node', STUB, '18163'],
                    env={'STUB_OUTSPEND_DELAY_MS': '400'})
        time.sleep(0.5)
        app_r = start(['node', 'server.js'],
                      env={'PORT': '3384', 'DATA_DIR': rdata, 'CHECKIN_DIR': rdata + '-checkin'},
                      cwd=APP)
        try:
            check('race: app up', wait_up(rbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18162',
                        'secondaryApiUrl': 'http://127.0.0.1:18163'}, base=rbase)
            check('race: endpoints set to delayed stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'R race', 'notes': ''}, base=rbase)
            txr = r['tx']['id']
            txr_txid = r['tx']['txid']
            # force release-due: last check-in 100 days ago
            st_path = os.path.join(rdata, 'state.json')
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            # Fire the release check in a thread; check in from the main
            # thread while the input check is still in its 400 ms delay.
            rel_out = {}
            def do_release():
                rel_out['s'], rel_out['r'] = req('POST', '/api/release/check', {}, base=rbase, timeout=30)
            t = threading.Thread(target=do_release)
            t.start()
            time.sleep(0.05)
            s, cr = req('POST', '/api/checkin', {'method': 'app'}, base=rbase)
            check('race: check-in lands during the evaluation', s == 200 and cr.get('ok') is True, cr)
            t.join(timeout=30)
            res = {x.get('id'): x for x in rel_out.get('r', {}).get('results', [])}
            check('race: a check-in during the input check no longer stops the broadcast (all-or-none 0.7.12)',
                  res.get(txr, {}).get('action') == 'broadcast', res.get(txr))
            s, st = req('GET', '/api/state', base=rbase)
            rt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txr][0]
            check('race: the tx IS broadcast', bool(rt.get('broadcasted')), rt.get('broadcasted'))
            ck = st.get('checkin', {})
            ck_at = ck.get('lastCheckinAt') or ''
            ck_dt = datetime.fromisoformat(ck_at.replace('Z', '+00:00')) if ck_at else None
            check('race: the mid-flight check-in survived the broadcast write (merge-only)',
                  ck.get('totalCheckins') == 1 and ck_dt is not None and abs((datetime.now(timezone.utc) - ck_dt).total_seconds()) < 300,
                  (ck.get('lastCheckinAt'), ck.get('totalCheckins')))
            # Lock: force release-due again, fire two release checks at
            # once — at most one broadcast may happen.
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            outs = []
            def do_rel2():
                outs.append(req('POST', '/api/release/check', {}, base=rbase, timeout=30))
            t1 = threading.Thread(target=do_rel2)
            t2 = threading.Thread(target=do_rel2)
            t1.start(); t2.start()
            t1.join(timeout=30); t2.join(timeout=30)
            s, blog = req('GET', '/api/broadcast/log', base=rbase)
            n_bcast = sum(1 for e in blog if e.get('status') == 'broadcast' and e.get('txid') == txr_txid)
            check('lock: two concurrent release checks broadcast at most once',
                  n_bcast == 1, n_bcast)
            s, st = req('GET', '/api/state', base=rbase)
            rt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txr][0]
            check('lock: the tx is broadcast exactly once', bool(rt.get('broadcasted')), rt.get('broadcasted'))
        finally:
            stop(app_r)
            stop(rs1)
            stop(rs2)

        # 0.7.12 — the lost-update fix: an edit landing while a
        # confirmation refresh is on the network must survive. The
        # refresh used to save its stale state after the lookups,
        # clobbering the edit; it now merges only the confirmation
        # fields into fresh state. Delayed tx-lookup stubs (400 ms)
        # open a window an edit can land in.
        cdata = '/tmp/heirloom094-conc'
        cbase = 'http://127.0.0.1:3386'
        shutil.rmtree(cdata, ignore_errors=True)
        cs1 = start(['node', STUB, '18161'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_TX_LOOKUP_DELAY_MS': '400'})
        cs2 = start(['node', STUB, '18162'],
                    env={'STUB_TX_LOOKUP_DELAY_MS': '400'})
        time.sleep(0.5)
        app_c = start(['node', 'server.js'],
                      env={'PORT': '3386', 'DATA_DIR': cdata, 'CHECKIN_DIR': cdata + '-checkin'},
                      cwd=APP)
        try:
            check('conc: app up', wait_up(cbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18161',
                        'secondaryApiUrl': 'http://127.0.0.1:18162'}, base=cbase)
            check('conc: endpoints set to delayed-lookup stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'A broadcasted', 'notes': ''}, base=cbase)
            txa = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100201), 'label': 'B to disable', 'notes': ''}, base=cbase)
            txb = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs/' + txa + '/broadcast', {}, base=cbase)
            check('conc: A broadcasts', s == 200 and r.get('action') == 'broadcast', r)
            # Fire the confirmation refresh in a thread; disable B
            # from the main thread while the lookup is still delayed.
            conf_out = {}
            def do_conf():
                conf_out['s'], conf_out['r'] = req('GET', '/api/bitcoin/confirmations', base=cbase, timeout=30)
            t = threading.Thread(target=do_conf)
            t.start()
            time.sleep(0.05)
            s, r = req('PUT', '/api/bitcoin/txs/' + txb, {'enabled': False}, base=cbase)
            check('conc: B disabled during the refresh', s == 200 and r.get('tx', {}).get('enabled') is False, r)
            t.join(timeout=30)
            conf = {c.get('id'): c for c in conf_out.get('r', {}).get('confirmations', [])}
            check('conc: the refresh still returns A at 6 confirmations',
                  conf.get(txa, {}).get('confirmations') == 6, conf)
            s, st = req('GET', '/api/state', base=cbase)
            bt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txb][0]
            check('conc: the edit survived — B is STILL disabled after the refresh',
                  bt.get('enabled') is False, bt.get('enabled'))
            at = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txa][0]
            check('conc: A stored 6 confirmations (the merge applied)',
                  at.get('broadcasted', {}).get('confirmations') == 6, at.get('broadcasted'))
        finally:
            stop(app_c)
            stop(cs1)
            stop(cs2)

        # 0.7.12 — finding 1: the broadcast write is merge-only, and
        # the release is all-or-none. Delayed broadcast stubs (1500 ms
        # on every POST /api/tx) open a window a check-in, a disable,
        # or a delete can land in while a broadcast is on the network.
        bdata = '/tmp/heirloom094-bcast'
        bbase = 'http://127.0.0.1:3388'
        shutil.rmtree(bdata, ignore_errors=True)
        bs1 = start(['node', STUB, '18163'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BROADCAST_DELAY_MS': '1500'})
        bs2 = start(['node', STUB, '18164'],
                    env={'STUB_BROADCAST_DELAY_MS': '1500'})
        time.sleep(0.5)
        app_b = start(['node', 'server.js'],
                      env={'PORT': '3388', 'DATA_DIR': bdata, 'CHECKIN_DIR': bdata + '-checkin'},
                      cwd=APP)
        try:
            check('bcast: app up', wait_up(bbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18163',
                        'secondaryApiUrl': 'http://127.0.0.1:18164'}, base=bbase)
            check('bcast: endpoints set to delayed-broadcast stubs', s == 200, r)
            # Two armed txs; force release-due.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'A first', 'notes': ''}, base=bbase)
            txa = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100201), 'label': 'B second', 'notes': ''}, base=bbase)
            txb = r['tx']['id']
            st_path = os.path.join(bdata, 'state.json')
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            s, st0 = req('GET', '/api/state', base=bbase)
            n0 = st0.get('checkin', {}).get('totalCheckins', 0)
            # Fire the release in a thread; check in from the main
            # thread while A's broadcast is still in its 1500 ms delay.
            rel_out = {}
            def do_release():
                rel_out['s'], rel_out['r'] = req('POST', '/api/release/check', {}, base=bbase, timeout=30)
            t = threading.Thread(target=do_release)
            t.start()
            time.sleep(0.05)
            s, cr = req('POST', '/api/checkin', {'method': 'app'}, base=bbase)
            check('bcast: check-in lands during A\'s broadcast', s == 200 and cr.get('ok') is True, cr)
            t.join(timeout=30)
            check('bcast: the release action is broadcast', rel_out.get('r', {}).get('action') == 'broadcast', rel_out.get('r', {}).get('action'))
            res = {x.get('id'): x for x in rel_out.get('r', {}).get('results', [])}
            check('bcast: A broadcasts', res.get(txa, {}).get('action') == 'broadcast', res.get(txa))
            check('bcast: B broadcasts too — the mid-flight check-in does not stop the release (all-or-none)',
                  res.get(txb, {}).get('action') == 'broadcast', res.get(txb))
            s, st = req('GET', '/api/state', base=bbase)
            at = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txa][0]
            bt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txb][0]
            check('bcast: both txs recorded broadcasted',
                  bool(at.get('broadcasted')) and bool(bt.get('broadcasted')),
                  (at.get('broadcasted'), bt.get('broadcasted')))
            ck = st.get('checkin', {})
            ck_at = ck.get('lastCheckinAt') or ''
            ck_dt = datetime.fromisoformat(ck_at.replace('Z', '+00:00')) if ck_at else None
            check('bcast: the check-in survived both broadcast writes',
                  ck.get('totalCheckins') == n0 + 1 and ck_dt is not None and abs((datetime.now(timezone.utc) - ck_dt).total_seconds()) < 300,
                  (ck.get('lastCheckinAt'), ck.get('totalCheckins'), n0))
            # Guards still hold: disabling D while C's broadcast is on
            # the network must stop D (an explicit owner action), even
            # though the clock check is skipped inside the run.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100202), 'label': 'C third', 'notes': ''}, base=bbase)
            txc = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100203), 'label': 'D fourth', 'notes': ''}, base=bbase)
            txd = r['tx']['id']
            # A release already went out in this cycle, so the status is
            # 'broadcasted' until a check-in starts a new cycle — only
            # then can the clock be release-due again. Check in first,
            # then backdate.
            s, cr2 = req('POST', '/api/checkin', {'method': 'app'}, base=bbase)
            check('bcast: check-in starts a new cycle (clears the broadcasted status)', s == 200 and cr2.get('ok') is True, cr2)
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            rel_out2 = {}
            def do_release2():
                rel_out2['s'], rel_out2['r'] = req('POST', '/api/release/check', {}, base=bbase, timeout=30)
            t2 = threading.Thread(target=do_release2)
            t2.start()
            time.sleep(0.05)
            s, r = req('PUT', '/api/bitcoin/txs/' + txd, {'enabled': False}, base=bbase)
            check('bcast: D disabled during C\'s broadcast', s == 200 and r.get('tx', {}).get('enabled') is False, r)
            t2.join(timeout=30)
            res2 = {x.get('id'): x for x in rel_out2.get('r', {}).get('results', [])}
            check('bcast: C broadcasts', res2.get(txc, {}).get('action') == 'broadcast', res2.get(txc))
            check('bcast: D is skipped — disabled mid-release still stops it',
                  res2.get(txd, {}).get('action') == 'skipped' and 'disabled' in (res2.get(txd, {}).get('reason') or ''), res2.get(txd))
            s, st = req('GET', '/api/state', base=bbase)
            dt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txd][0]
            check('bcast: D was NOT broadcast', not dt.get('broadcasted'), dt.get('broadcasted'))
            # Deleted mid-broadcast: the broadcast already went out
            # on-chain, but the record is gone — the merge-only write
            # must NOT resurrect it.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100204), 'label': 'E fifth', 'notes': ''}, base=bbase)
            txe = r['tx']['id']
            txe_txid = r['tx']['txid']
            # Same new-cycle step as above: C broadcasted in the last
            # run, so the status is 'broadcasted' until a check-in.
            s, cr3 = req('POST', '/api/checkin', {'method': 'app'}, base=bbase)
            check('bcast: check-in starts a new cycle before E\'s run', s == 200 and cr3.get('ok') is True, cr3)
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            rel_out3 = {}
            def do_release3():
                rel_out3['s'], rel_out3['r'] = req('POST', '/api/release/check', {}, base=bbase, timeout=30)
            t3 = threading.Thread(target=do_release3)
            t3.start()
            time.sleep(0.05)
            s, r = req('DELETE', '/api/bitcoin/txs/' + txe, base=bbase)
            check('bcast: E deleted during its broadcast', s == 200, r)
            t3.join(timeout=30)
            res3 = {x.get('id'): x for x in rel_out3.get('r', {}).get('results', [])}
            check('bcast: E still reports broadcast (it went out on-chain)',
                  res3.get(txe, {}).get('action') == 'broadcast', res3.get(txe))
            s, st = req('GET', '/api/state', base=bbase)
            gone = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txe]
            check('bcast: E stays deleted — the broadcast write did not resurrect it',
                  gone == [], gone)
            s, blog = req('GET', '/api/broadcast/log', base=bbase)
            check('bcast: the broadcast log still has E\'s entry',
                  any(e.get('txid') == txe_txid for e in blog), txe_txid)
        finally:
            stop(app_b)
            stop(bs1)
            stop(bs2)

        # 0.7.12 — finding 2: an input the node does not know is
        # "unknown", not spent. The dry-run reports verdict 'unknown'
        # and wouldBroadcast True (the release stays fail-open — the
        # network is the arbiter), with a note that says so; the log
        # entry is 'unknown', not 'blocked'. The old code said
        # wouldBroadcast False while the note said the broadcast would
        # be attempted, and logged the run as 'blocked'.
        udata = '/tmp/heirloom094-unknown'
        ubase = 'http://127.0.0.1:3390'
        shutil.rmtree(udata, ignore_errors=True)
        us1 = start(['node', STUB, '18165'], env={'SENTINEL_TXID': SENTINEL_TXID})
        us2 = start(['node', STUB, '18166'])
        time.sleep(0.5)
        app_u = start(['node', 'server.js'],
                      env={'PORT': '3390', 'DATA_DIR': udata, 'CHECKIN_DIR': udata + '-checkin'},
                      cwd=APP)
        try:
            check('unknown: app up', wait_up(ubase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18165',
                        'secondaryApiUrl': 'http://127.0.0.1:18166'}, base=ubase)
            check('unknown: endpoints set to stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_prev('bb' * 32, 0), 'label': 'U unknown parent', 'notes': ''}, base=ubase)
            txu = r['tx']['id']
            check('unknown: tx stores fine', s == 201 and r.get('tx', {}).get('enabled') is True, r)
            s, r = req('POST', '/api/broadcast/test', {'id': txu}, base=ubase)
            one = (r.get('results') or [{}])[0]
            check('unknown: verdict unknown, wouldBroadcast True (fail-open)',
                  one.get('verdict') == 'unknown' and one.get('wouldBroadcast') is True and (one.get('unknown') or []), one)
            check('unknown: the note says the broadcast would be attempted',
                  'could not be verified' in (one.get('note') or '') and 'would be attempted' in (one.get('note') or ''), one.get('note'))
            s, blog = req('GET', '/api/broadcast/log', base=ubase)
            u_entries = [e for e in blog if e.get('txid') == one.get('txid') and e.get('kind') == 'dry-run']
            check('unknown: the log entry is unknown, not blocked',
                  u_entries and u_entries[-1].get('status') == 'unknown', u_entries[-1] if u_entries else blog)
            s, st = req('GET', '/api/state', base=ubase)
            ut = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txu][0]
            check('unknown: no stale record — unknown is not spent',
                  not ut.get('release'), ut.get('release'))
        finally:
            stop(app_u)
            stop(us1)
            stop(us2)

        # 0.7.12 — finding 4: an oversized node reply is rejected
        # instead of growing the process. Both stubs answer the
        # outspend check with a 2 MB body; the dry-run must fail
        # cleanly (naming the cap) and the app must stay up.
        hdata = '/tmp/heirloom094-bigresp'
        hbase = 'http://127.0.0.1:3392'
        shutil.rmtree(hdata, ignore_errors=True)
        hs1 = start(['node', STUB, '18167'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BIG_RESPONSE_BYTES': '2000000'})
        hs2 = start(['node', STUB, '18168'],
                    env={'STUB_BIG_RESPONSE_BYTES': '2000000'})
        time.sleep(0.5)
        app_h = start(['node', 'server.js'],
                      env={'PORT': '3392', 'DATA_DIR': hdata, 'CHECKIN_DIR': hdata + '-checkin'},
                      cwd=APP)
        try:
            check('bigresp: app up', wait_up(hbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18167',
                        'secondaryApiUrl': 'http://127.0.0.1:18168'}, base=hbase)
            check('bigresp: endpoints set to big-response stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'H big reply', 'notes': ''}, base=hbase)
            txh = r['tx']['id']
            s, r = req('POST', '/api/broadcast/test', {'id': txh}, base=hbase)
            one = (r.get('results') or [{}])[0]
            check('bigresp: the dry-run fails naming the size cap',
                  one.get('wouldBroadcast') is False and 'exceeded' in (one.get('error') or ''), one)
            check('bigresp: the app is still up after the oversized reply',
                  wait_up(hbase))
            s, r = req('GET', '/api/status', base=hbase)
            check('bigresp: a status read still works', s == 200 and r.get('state') in ('on-track', 'not-started'), r.get('state'))
        finally:
            stop(app_h)
            stop(hs1)
            stop(hs2)

        # 0.7.12 — finding 5: a broadcast reply is validated against
        # the txid sent. Both stubs answer 200 with 'not-a-txid', so
        # the broadcast must FAIL (not be recorded as broadcasted) and
        # the tx must stay un-broadcast, ready to retry.
        xdata = '/tmp/heirloom094-badtxid'
        xbase = 'http://127.0.0.1:3394'
        shutil.rmtree(xdata, ignore_errors=True)
        xs1 = start(['node', STUB, '18169'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BAD_TXID': '1'})
        xs2 = start(['node', STUB, '18170'],
                    env={'STUB_BAD_TXID': '1'})
        time.sleep(0.5)
        app_x = start(['node', 'server.js'],
                      env={'PORT': '3394', 'DATA_DIR': xdata, 'CHECKIN_DIR': xdata + '-checkin'},
                      cwd=APP)
        try:
            check('badtxid: app up', wait_up(xbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18169',
                        'secondaryApiUrl': 'http://127.0.0.1:18170'}, base=xbase)
            check('badtxid: endpoints set to bad-txid stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'X bad reply', 'notes': ''}, base=xbase)
            txx = r['tx']['id']
            txx_txid = r['tx']['txid']
            s, r = req('POST', '/api/bitcoin/txs/' + txx + '/broadcast', {}, base=xbase)
            check('badtxid: the broadcast FAILS (garbage txid is not accepted)',
                  s == 200 and r.get('action') == 'failed' and 'unexpected txid' in (r.get('error') or ''), r)
            s, st = req('GET', '/api/state', base=xbase)
            xt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txx][0]
            check('badtxid: the tx is NOT marked broadcasted',
                  not xt.get('broadcasted'), xt.get('broadcasted'))
            s, blog = req('GET', '/api/broadcast/log', base=xbase)
            check('badtxid: the log has a failed broadcast entry, no broadcast entry',
                  any(e.get('status') == 'failed' and e.get('txid') == txx_txid for e in blog)
                  and not any(e.get('status') == 'broadcast' and e.get('txid') == txx_txid for e in blog), blog)
        finally:
            stop(app_x)
            stop(xs1)
            stop(xs2)

        # 0.7.12 — finding 6: two broadcasts of the same transaction
        # cannot overlap. Two concurrent Broadcast Now calls for one
        # tx, with the broadcast delayed 1500 ms: exactly one
        # broadcasts, the other is skipped as already in progress.
        gdata = '/tmp/heirloom094-guard'
        gbase = 'http://127.0.0.1:3396'
        shutil.rmtree(gdata, ignore_errors=True)
        gs1 = start(['node', STUB, '18171'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BROADCAST_DELAY_MS': '1500'})
        gs2 = start(['node', STUB, '18172'],
                    env={'STUB_BROADCAST_DELAY_MS': '1500'})
        time.sleep(0.5)
        app_g = start(['node', 'server.js'],
                      env={'PORT': '3396', 'DATA_DIR': gdata, 'CHECKIN_DIR': gdata + '-checkin'},
                      cwd=APP)
        try:
            check('guard: app up', wait_up(gbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18171',
                        'secondaryApiUrl': 'http://127.0.0.1:18172'}, base=gbase)
            check('guard: endpoints set to delayed-broadcast stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100200), 'label': 'G guarded', 'notes': ''}, base=gbase)
            txg = r['tx']['id']
            txg_txid = r['tx']['txid']
            outs = []
            def do_bc():
                outs.append(req('POST', '/api/bitcoin/txs/' + txg + '/broadcast', {}, base=gbase, timeout=30))
            t1 = threading.Thread(target=do_bc)
            t2 = threading.Thread(target=do_bc)
            t1.start(); t2.start()
            t1.join(timeout=30); t2.join(timeout=30)
            actions = sorted([o[1].get('action') for o in outs])
            check('guard: one broadcasts, the other is skipped as in progress',
                  actions == ['broadcast', 'skipped'], actions)
            skipped = [o[1] for o in outs if o[1].get('action') == 'skipped']
            check('guard: the skip names the in-progress broadcast',
                  skipped and 'already in progress' in (skipped[0].get('reason') or ''), skipped)
            s, blog = req('GET', '/api/broadcast/log', base=gbase)
            n_bcast = sum(1 for e in blog if e.get('status') == 'broadcast' and e.get('txid') == txg_txid)
            check('guard: the tx broadcast exactly once in the log',
                  n_bcast == 1, n_bcast)
            s, st = req('GET', '/api/state', base=gbase)
            gt = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txg][0]
            check('guard: the tx is broadcast once in state',
                  bool(gt.get('broadcasted')), gt.get('broadcasted'))
        finally:
            stop(app_g)
            stop(gs1)
            stop(gs2)

        # 0.7.12 — finding 2: cross-site request protection. A
        # state-changing /api request must come from the app's own
        # page (Origin matching Host, or X-Forwarded-Host, or both
        # loopback) and must use Content-Type: application/json.
        # The UI's api() sends both on every call, so this cannot
        # break it — and a cross-origin form or no-cors fetch cannot
        # satisfy either. No stubs needed: pause/resume/settings do
        # not touch the nodes.
        cdata = '/tmp/heirloom094-csrf'
        cbase = 'http://127.0.0.1:3398'
        shutil.rmtree(cdata, ignore_errors=True)
        app_csrf = start(['node', 'server.js'],
                         env={'PORT': '3398', 'DATA_DIR': cdata, 'CHECKIN_DIR': cdata + '-checkin'},
                         cwd=APP)
        try:
            check('csrf: app up', wait_up(cbase))
            s, r = req('POST', '/api/pause', {}, base=cbase,
                       headers={'Origin': 'https://evil.example.com'})
            check('csrf: cross-origin POST /api/pause is rejected 403',
                  s == 403, r)
            s, st = req('GET', '/api/state', base=cbase)
            check('csrf: the rejected pause changed nothing (still unpaused)',
                  st.get('settings', {}).get('paused') is False, st.get('settings'))
            s, r = req('POST', '/api/pause', {}, base=cbase)
            check('csrf: missing Origin (curl / a script) still pauses',
                  s == 200 and r.get('paused') is True, r)
            s, r = req('POST', '/api/resume', {}, base=cbase,
                       headers={'Content-Type': 'application/json; charset=utf-8'})
            check('csrf: application/json with a charset still works',
                  s == 200 and r.get('paused') is False, r)
            s, r = req('POST', '/api/pause', {}, base=cbase,
                       headers={'Content-Type': 'text/plain'})
            check('csrf: a form-style Content-Type is rejected 403',
                  s == 403, r)
            s, r = req('POST', '/api/pause', {}, base=cbase,
                       headers={'Origin': 'http://127.0.0.1:3398'})
            check('csrf: an Origin matching Host is allowed',
                  s == 200 and r.get('paused') is True, r)
            s, r = req('POST', '/api/resume', {}, base=cbase,
                       headers={'Origin': 'http://192.0.2.20',
                                'X-Forwarded-Host': '192.0.2.20'})
            check('csrf: an Origin matching X-Forwarded-Host is allowed (the proxy path)',
                  s == 200 and r.get('paused') is False, r)
            s, r = req('POST', '/api/settings', {'thresholdDays': 35}, base=cbase,
                       headers={'Origin': 'https://evil.example.com'})
            check('csrf: cross-origin PUT /api/settings is rejected 403',
                  s == 403, r)
            s, r = req('GET', '/api/status', base=cbase,
                       headers={'Origin': 'https://evil.example.com'})
            check('csrf: a GET with a cross-origin Origin is still served (reads are not gated)',
                  s == 200, r)
            s, r = req('POST', '/api/broadcast/all', {}, base=cbase,
                       headers={'Origin': 'https://evil.example.com'})
            check('csrf: cross-origin Broadcast All is rejected before the handler runs (no default-to-all)',
                  s == 403, r)
            s, r = req('POST', '/api/broadcast/all', {}, base=cbase)
            check('csrf: the same call with no Origin reaches the handler (400, no txs stored)',
                  s == 400 and 'no transactions stored' in (r.get('error') or ''), r)
        finally:
            stop(app_csrf)

        # 0.7.12 — finding 3: the manual release check now merges a
        # receiver check-in before judging the clock. Force
        # release-due, prove the release fires with no receiver
        # check-in, then start a new cycle, backdate again, check in
        # through the receiver, and prove the same release check now
        # skips (the clock is on-track) and broadcasts nothing. A
        # second, fresh tx is the tell: if the merge had not
        # happened it would broadcast in the second run.
        qdata = '/tmp/heirloom094-relcheck'
        qcheck = '/tmp/heirloom094-relcheck-checkin'
        qbase = 'http://127.0.0.1:3400'
        qrbase = 'http://127.0.0.1:3401'
        shutil.rmtree(qdata, ignore_errors=True)
        shutil.rmtree(qcheck, ignore_errors=True)
        qs1 = start(['node', STUB, '18173'], env={'SENTINEL_TXID': SENTINEL_TXID})
        qs2 = start(['node', STUB, '18174'])
        time.sleep(0.5)
        app_q = start(['node', 'server.js'],
                      env={'PORT': '3400', 'DATA_DIR': qdata, 'CHECKIN_DIR': qcheck}, cwd=APP)
        qrec = start(['node', 'checkin-receiver/server.js'],
                     env={'PORT': '3401', 'CHECKIN_DIR': qcheck}, cwd=APP)
        try:
            check('relcheck: app + receiver up', wait_up(qbase) and wait_up(qrbase, path='/health'))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18173',
                        'secondaryApiUrl': 'http://127.0.0.1:18174'}, base=qbase)
            check('relcheck: endpoints set to stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100300), 'label': 'Q release test', 'notes': ''}, base=qbase)
            txq = r['tx']['id']
            s, r = req('POST', '/api/checkin-keys', {'label': 'relcheck'}, base=qbase)
            plain_q = r['plain']
            q_path = os.path.join(qdata, 'state.json')
            def q_backdate():
                stj = json.load(open(q_path))
                stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
                json.dump(stj, open(q_path, 'w'), indent=2)
            q_backdate()
            s, r = req('POST', '/api/release/check', {}, base=qbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('relcheck: control — with no receiver check-in the release fires',
                  r.get('action') == 'broadcast' and res.get(txq, {}).get('action') == 'broadcast', r)
            # New cycle: check in (clears the broadcasted status),
            # add a fresh tx, backdate again, then check in through
            # the receiver.
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=qbase)
            check('relcheck: check-in starts a new cycle', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100301), 'label': 'Q2 fresh tell', 'notes': ''}, base=qbase)
            txq2 = r['tx']['id']
            q_backdate()
            s, st0 = req('GET', '/api/status', base=qbase)
            check('relcheck: the clock is release-due again before the receiver check-in',
                  st0.get('state') == 'release-due', st0.get('state'))
            total0 = st0.get('totalCheckins', 0)
            s, r = req('POST', '/checkin', {}, base=qrbase,
                       headers={'Authorization': 'Bearer ' + plain_q})
            check('relcheck: the receiver check-in lands', s == 200 and r == {'ok': True}, r)
            s, r = req('POST', '/api/release/check', {}, base=qbase)
            check('relcheck: the manual release check now skips — the receiver check-in was merged',
                  r.get('action') == 'skipped' and 'not release-due' in (r.get('reason') or ''), r)
            res2 = {x.get('id'): x for x in r.get('results', [])}
            check('relcheck: the fresh tx was not even attempted (the run never started)',
                  txq2 not in res2, sorted(res2.keys()))
            s, blog = req('GET', '/api/broadcast/log', base=qbase)
            n_bcast = sum(1 for e in blog if e.get('status') == 'broadcast')
            check('relcheck: exactly one broadcast in the log (the control run only)',
                  n_bcast == 1, n_bcast)
            s, st1 = req('GET', '/api/state', base=qbase)
            q2 = [x for x in st1.get('bitcoin', {}).get('txs', []) if x.get('id') == txq2][0]
            check('relcheck: the fresh tx is un-broadcast in state',
                  not q2.get('broadcasted'), q2.get('broadcasted'))
            s, st1 = req('GET', '/api/status', base=qbase)
            check('relcheck: the clock is on-track and the merge counted the check-in',
                  st1.get('state') == 'on-track' and st1.get('totalCheckins') == total0 + 1, st1)
        finally:
            stop(app_q)
            stop(qrec)
            stop(qs1)
            stop(qs2)

        # 0.7.12 — finding 4: restore validates before applying. A
        # backup with an invalid or far-future check-in time, a
        # broadcasted record whose txid is not the tx's own, or a
        # release record with an unknown status or a mismatched txid
        # is rejected whole (400) and the state is untouched — so a
        # corrupt backup can no longer silently disable a transaction
        # or break every status read. A valid restore still applies,
        # including one carrying a matching broadcasted record.
        wdata = '/tmp/heirloom094-restore'
        wbase = 'http://127.0.0.1:3400'
        shutil.rmtree(wdata, ignore_errors=True)
        app_w = start(['node', 'server.js'],
                      env={'PORT': '3400', 'DATA_DIR': wdata}, cwd=APP)
        try:
            check('restore4: app up', wait_up(wbase))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100400), 'label': 'W restore test', 'notes': ''}, base=wbase)
            txw = r['tx']['id']
            txw_txid = r['tx']['txid']
            s, rb = req('GET', '/api/backup', base=wbase)
            orig = json.loads(json.dumps(rb))
            def w_state():
                s2, st2 = req('GET', '/api/state', base=wbase)
                return st2
            def w_status_ok():
                s2, st2 = req('GET', '/api/status', base=wbase)
                return s2 == 200
            # (A) an invalid check-in time
            bad = json.loads(json.dumps(orig))
            bad['state']['checkin']['lastCheckinAt'] = 'not-a-date'
            s, r = req('POST', '/api/restore', bad, base=wbase)
            check('restore 0.7.12: an invalid check-in time -> 400',
                  s == 400, r)
            check('restore 0.7.12: the invalid-date attempt changed nothing (clock still null, status reads fine)',
                  w_state().get('checkin', {}).get('lastCheckinAt') is None
                  and w_status_ok(), w_state().get('checkin'))
            # (A) a far-future check-in time
            bad = json.loads(json.dumps(orig))
            bad['state']['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat().replace('+00:00', 'Z')
            s, r = req('POST', '/api/restore', bad, base=wbase)
            check('restore 0.7.12: a far-future check-in time -> 400',
                  s == 400, r)
            check('restore 0.7.12: the far-future attempt changed nothing',
                  w_state().get('checkin', {}).get('lastCheckinAt') is None, w_state().get('checkin'))
            # (B) a broadcasted record whose txid is not the tx's own
            bad = json.loads(json.dumps(orig))
            bad['state']['bitcoin']['txs'][0]['broadcasted'] = {
                'txid': '00' * 32, 'broadcastedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'method': 'primary', 'confirmations': None, 'blockHeight': None, 'found': True, 'checkedAt': None}
            s, r = req('POST', '/api/restore', bad, base=wbase)
            check('restore 0.7.12: a broadcasted txid that is not the tx -> 400',
                  s == 400, r)
            check('restore 0.7.12: the mismatched-broadcast attempt changed nothing',
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('broadcasted') is None,
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('broadcasted'))
            # (C) a release record with an unknown status
            bad = json.loads(json.dumps(orig))
            bad['state']['bitcoin']['txs'][0]['release'] = {
                'status': 'exploded', 'kind': 'release', 'txid': txw_txid,
                'method': 'primary', 'lastAttemptAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'error': ''}
            s, r = req('POST', '/api/restore', bad, base=wbase)
            check('restore 0.7.12: an unknown release status -> 400',
                  s == 400, r)
            check('restore 0.7.12: the bad-status attempt changed nothing',
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('release') is None,
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('release'))
            # (C) a release record whose txid is not the tx's own
            bad = json.loads(json.dumps(orig))
            bad['state']['bitcoin']['txs'][0]['release'] = {
                'status': 'stale', 'kind': 'dryrun', 'txid': '11' * 32,
                'method': 'primary', 'lastAttemptAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'error': 'inputs spent: x'}
            s, r = req('POST', '/api/restore', bad, base=wbase)
            check('restore 0.7.12: a release txid that is not the tx -> 400',
                  s == 400, r)
            check('restore 0.7.12: the mismatched-release attempt changed nothing',
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('release') is None,
                  w_state().get('bitcoin', {}).get('txs', [{}])[0].get('release'))
            # A valid restore still applies — with a real past
            # check-in time and a broadcasted record that DOES match.
            good = json.loads(json.dumps(orig))
            good['state']['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat().replace('+00:00', 'Z')
            good['state']['bitcoin']['txs'][0]['label'] = 'W restored'
            good['state']['bitcoin']['txs'][0]['broadcasted'] = {
                'txid': txw_txid, 'broadcastedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'method': 'primary', 'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': None}
            s, r = req('POST', '/api/restore', good, base=wbase)
            check('restore 0.7.12: a valid restore (real date + matching broadcasted record) still applies',
                  s == 200 and r.get('restoredTxs') == 1, r)
            wst = w_state()
            # 0.7.22: a restore refreshes the check-in clock — the
            # restored lastCheckinAt is the restore moment, NOT the
            # backup's 3-days-ago value. The backup's clock was
            # still validated (a bad one would have rejected the
            # restore); it is just not carried forward.
            check('restore 0.7.12: the valid restore took (label + refreshed clock + broadcasted fact)',
                  wst.get('bitcoin', {}).get('txs', [{}])[0].get('label') == 'W restored'
                  and wst.get('checkin', {}).get('lastCheckinAt') != good['state']['checkin']['lastCheckinAt']
                  and abs((datetime.now(timezone.utc) - datetime.fromisoformat(wst.get('checkin', {}).get('lastCheckinAt', '').replace('Z', '+00:00'))).total_seconds()) < 10
                  and wst.get('bitcoin', {}).get('txs', [{}])[0].get('broadcasted', {}).get('txid') == txw_txid, wst.get('bitcoin', {}).get('txs', [{}])[0])
            check('restore 0.7.12: status reads fine after the valid restore',
                  w_status_ok(), '')
        finally:
            stop(app_w)
        # 0.7.12 — finding 1: a spent input is three different
        # things. The stub answers 'cc'*32 as spent by another tx
        # ('dd'*32) — unconfirmed by default, confirmed or unspent
        # via STUB_CONFLICT_MODE — and 'ee'*32 as spent by the txid
        # in STUB_OWN_SPEND_TXID. The mode flips by restarting the
        # stubs, exactly like the primary-down sections restart theirs.
        fdata = '/tmp/heirloom094-finding1'
        fbase = 'http://127.0.0.1:3402'
        shutil.rmtree(fdata, ignore_errors=True)
        fs1 = start(['node', STUB, '18175'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_CONFLICT_MODE': 'unconfirmed'})
        fs2 = start(['node', STUB, '18176'],
                    env={'STUB_CONFLICT_MODE': 'unconfirmed'})
        time.sleep(0.5)
        app_f = start(['node', 'server.js'],
                      env={'PORT': '3402', 'DATA_DIR': fdata, 'CHECKIN_DIR': fdata + '-checkin'},
                      cwd=APP)
        def f_restart(mode=None, own=None):
            nonlocal fs1, fs2
            stop(fs1); stop(fs2)
            e1 = {'SENTINEL_TXID': SENTINEL_TXID}
            e2 = {}
            if mode:
                e1['STUB_CONFLICT_MODE'] = mode
                e2['STUB_CONFLICT_MODE'] = mode
            if own:
                e1['STUB_OWN_SPEND_TXID'] = own
                e2['STUB_OWN_SPEND_TXID'] = own
            fs1 = start(['node', STUB, '18175'], env=e1)
            fs2 = start(['node', STUB, '18176'], env=e2)
            time.sleep(0.5)
        def f_state(txid):
            s, st = req('GET', '/api/state', base=fbase)
            return [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid][0]
        def f_dryrun(txid):
            s, r = req('POST', '/api/broadcast/test', {'id': txid}, base=fbase)
            return (r.get('results') or [{}])[0]
        try:
            check('finding1: app up', wait_up(fbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18175',
                        'secondaryApiUrl': 'http://127.0.0.1:18176'}, base=fbase)
            check('finding1: endpoints set to the stubs', s == 200, r)
            # (a) an unconfirmed spend by another tx -> a warning, and
            # the tx stays active (not stale, not archived, not sent)
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev('cc'*32, 0), 'label': 'F conflict', 'notes': ''}, base=fbase)
            txf = r['tx']['id']
            one = f_dryrun(txf)
            check('finding1: an unconfirmed spend by another tx dry-runs "conflict" and would still broadcast',
                  one.get('verdict') == 'conflict' and one.get('wouldBroadcast') is True, one)
            check('finding1: the conflict names the other spending txid, not our own',
                  (one.get('conflict') or [{}])[0].get('spentBy') == 'dd'*32, one.get('conflict'))
            ft = f_state(txf)
            check('finding1: the warning is recorded on the tx (status conflict), not stale',
                  ft.get('release', {}).get('status') == 'conflict' and ft.get('release', {}).get('kind') == 'dryrun', ft.get('release'))
            check('finding1: no broadcasted fact — the tx stays active',
                  not ft.get('broadcasted'), ft)
            s, blog = req('GET', '/api/broadcast/log', base=fbase)
            f_log = [e for e in blog if e.get('txid') == ft.get('txid') and e.get('kind') == 'dry-run']
            check('finding1: the dry-run log entry says conflict, not blocked',
                  f_log and f_log[-1].get('status') == 'conflict', f_log[-1] if f_log else '')
            # (b) Broadcast Now still attempts — and succeeds — for a
            # warning tx: the warning must not block broadcast
            s, r = req('POST', '/api/bitcoin/txs/' + txf + '/broadcast', {}, base=fbase)
            check('finding1: Broadcast Now on a warning tx succeeds (the warning does not block)',
                  s == 200 and r.get('action') == 'broadcast', r)
            ft = f_state(txf)
            check('finding1: after the broadcast the warning is gone (broadcast record + broadcasted fact)',
                  ft.get('release', {}).get('status') == 'broadcast' and bool(ft.get('broadcasted')), ft)
            # (c) the same input confirmed-spent -> stale, never broadcast
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev('cc'*32, 0, 100401), 'label': 'F2 confirmed', 'notes': ''}, base=fbase)
            txf2 = r['tx']['id']
            f_restart('confirmed')
            one = f_dryrun(txf2)
            check('finding1: the same input confirmed-spent dry-runs "blocked", never broadcast',
                  one.get('verdict') == 'blocked' and one.get('wouldBroadcast') is False, one)
            ft2 = f_state(txf2)
            check('finding1: the confirmed spend marks the tx stale',
                  ft2.get('release', {}).get('status') == 'stale', ft2.get('release'))
            # (d) the conflict evicted -> the warning clears on a fresh check
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev('cc'*32, 0, 100402), 'label': 'F3 evicted', 'notes': ''}, base=fbase)
            txf3 = r['tx']['id']
            f_restart('unconfirmed')
            one = f_dryrun(txf3)
            check('finding1: F3 starts with a conflict warning', one.get('verdict') == 'conflict', one)
            f_restart('unspent')
            one = f_dryrun(txf3)
            check('finding1: the conflict evicted — the same tx dry-runs "ready" again',
                  one.get('verdict') == 'ready' and one.get('wouldBroadcast') is True, one)
            ft3 = f_state(txf3)
            check('finding1: the warning clears from the tx (no release record left)',
                  not ft3.get('release'), ft3.get('release'))
            # (e) our own txid as the spender -> already broadcast,
            # recognised, never re-sent
            own_hex = craft_prev('ee'*32, 0, 100403)
            own_txid = txid_of(own_hex)
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': own_hex, 'label': 'O own tx out there', 'notes': ''}, base=fbase)
            txo = r['tx']['id']
            f_restart(None, own_txid)
            one = f_dryrun(txo)
            check('finding1: spending txid === our own txid dry-runs "broadcast", not ready and not blocked',
                  one.get('verdict') == 'broadcast' and one.get('wouldBroadcast') is False, one)
            check('finding1: the own-spend entry names our own txid',
                  (one.get('own') or [{}])[0].get('spentBy') == own_txid, one.get('own'))
            fto = f_state(txo)
            check('finding1: the tx is recorded broadcast (release + broadcasted fact with our txid)',
                  fto.get('release', {}).get('status') == 'broadcast' and (fto.get('broadcasted') or {}).get('txid') == own_txid, fto)
            s, blog = req('GET', '/api/broadcast/log', base=fbase)
            o_posts = [e for e in blog if e.get('txid') == own_txid and e.get('kind') == 'broadcast']
            check('finding1: recognising our own tx never POSTs a broadcast (no broadcast-kind log entry)',
                  not o_posts, o_posts)
            # (f) a warning tx is ATTEMPTED in a release run, not skipped
            s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev('cc'*32, 0, 100404), 'label': 'F4 release', 'notes': ''}, base=fbase)
            txf4 = r['tx']['id']
            f_restart('unconfirmed')
            s, r = req('PUT', '/api/bitcoin/txs/' + txf3, {'enabled': False}, base=fbase)
            check('finding1: F3 disarmed so the release run has exactly one live candidate', s == 200, r)
            st_path = os.path.join(fdata, 'state.json')
            stj = json.load(open(st_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(st_path, 'w'), indent=2)
            s, r = req('POST', '/api/release/check', {}, base=fbase, timeout=30)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('finding1: the release run attempts the warning tx (action broadcast, not skipped)',
                  r.get('action') == 'broadcast' and res.get(txf4, {}).get('action') == 'broadcast', res.get(txf4))
            ft4 = f_state(txf4)
            check('finding1: the warning tx is broadcast by the release',
                  bool(ft4.get('broadcasted')) and ft4.get('release', {}).get('status') == 'broadcast', ft4)
            check('finding1: the disarmed F3 was not attempted (still no broadcasted fact)',
                  not f_state(txf3).get('broadcasted'), '')
        finally:
            stop(app_f)
            stop(fs1)
            stop(fs2)
        # 0.7.13 — finding 1: restore requires a txid on EVERY
        # release record. A backup carrying {"release":
        # {"status": "stale"}} with no txid used to pass validation
        # and permanently disable a transaction that was never
        # broadcast. The same for failed, broadcast, and conflict
        # records, and for a kind the app never writes. All five
        # must now be rejected whole (400), state untouched — while
        # a valid restore carrying matching txids (and matching
        # kinds, or no kind at all) still applies.
        w2data = '/tmp/heirloom094-restore2'
        w2base = 'http://127.0.0.1:3406'
        shutil.rmtree(w2data, ignore_errors=True)
        app_w2 = start(['node', 'server.js'],
                       env={'PORT': '3406', 'DATA_DIR': w2data}, cwd=APP)
        try:
            check('restore1: app up', wait_up(w2base))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100500), 'label': 'W2 restore test', 'notes': ''}, base=w2base)
            txw2 = r['tx']['id']
            txw2_txid = r['tx']['txid']
            s, rb2 = req('GET', '/api/backup', base=w2base)
            orig2 = json.loads(json.dumps(rb2))
            def w2_state():
                s2, st2 = req('GET', '/api/state', base=w2base)
                return st2
            def w2_release():
                return w2_state().get('bitcoin', {}).get('txs', [{}])[0].get('release')
            def w2_label():
                return w2_state().get('bitcoin', {}).get('txs', [{}])[0].get('label')
            now_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            for status in ('stale', 'failed', 'broadcast', 'conflict'):
                bad = json.loads(json.dumps(orig2))
                bad['state']['bitcoin']['txs'][0]['release'] = {
                    'status': status, 'kind': 'dryrun',
                    'method': 'primary', 'lastAttemptAt': now_iso, 'error': 'x'}
                s, r = req('POST', '/api/restore', bad, base=w2base)
                check('restore 0.7.13: a %s record with NO txid -> 400' % status,
                      s == 400, r)
                check('restore 0.7.13: the no-txid %s attempt changed nothing' % status,
                      w2_release() is None and w2_label() == 'W2 restore test', w2_state())
            # A kind the app never writes, even with a matching txid
            bad = json.loads(json.dumps(orig2))
            bad['state']['bitcoin']['txs'][0]['release'] = {
                'status': 'stale', 'kind': 'weird', 'txid': txw2_txid,
                'method': 'primary', 'lastAttemptAt': now_iso, 'error': 'x'}
            s, r = req('POST', '/api/restore', bad, base=w2base)
            check('restore 0.7.13: an unknown release kind -> 400',
                  s == 400, r)
            check('restore 0.7.13: the bad-kind attempt changed nothing',
                  w2_release() is None, w2_state())
            # Positive controls: matching txids still restore — a
            # stale record with kind, and one without kind at all
            # (kind is optional; when present it must be in the set).
            good = json.loads(json.dumps(orig2))
            good['state']['bitcoin']['txs'][0]['label'] = 'W2 restored stale'
            good['state']['bitcoin']['txs'][0]['release'] = {
                'status': 'stale', 'kind': 'dryrun', 'txid': txw2_txid,
                'method': 'primary', 'lastAttemptAt': now_iso, 'error': 'inputs spent: x'}
            s, r = req('POST', '/api/restore', good, base=w2base)
            check('restore 0.7.13: a stale record WITH its matching txid still restores',
                  s == 200 and r.get('restoredTxs') == 1, r)
            check('restore 0.7.13: the valid stale restore took (label + record)',
                  w2_label() == 'W2 restored stale'
                  and (w2_release() or {}).get('status') == 'stale'
                  and (w2_release() or {}).get('txid') == txw2_txid, w2_state())
            good = json.loads(json.dumps(orig2))
            good['state']['bitcoin']['txs'][0]['label'] = 'W2 restored no-kind'
            good['state']['bitcoin']['txs'][0]['release'] = {
                'status': 'conflict', 'txid': txw2_txid,
                'method': 'primary', 'lastAttemptAt': now_iso, 'error': 'x'}
            s, r = req('POST', '/api/restore', good, base=w2base)
            check('restore 0.7.13: a conflict record with a matching txid and NO kind still restores',
                  s == 200 and r.get('restoredTxs') == 1, r)
            check('restore 0.7.13: the no-kind restore took',
                  w2_label() == 'W2 restored no-kind'
                  and (w2_release() or {}).get('status') == 'conflict', w2_state())
        finally:
            stop(app_w2)
        # 0.7.13 — finding 7: a missing check-in file is not an
        # error (no receiver, or none recorded yet), but an
        # UNREADABLE one withholds the release: the file may hold a
        # check-in that would clear the due state, and broadcasting
        # on a clock that may be wrong is the worst failure. The
        # withhold skips the evaluation, marks nothing, and retries
        # next tick — it does not cancel the due state. Status reads,
        # in-app check-ins, and manual broadcasts are unaffected
        # (they do not touch last.json); the condition is visible in
        # GET /api/status as checkinReadError.
        gdata = '/tmp/heirloom094-readerror'
        gcheck = '/tmp/heirloom094-readerror-checkin'
        gbase = 'http://127.0.0.1:3408'
        shutil.rmtree(gdata, ignore_errors=True)
        shutil.rmtree(gcheck, ignore_errors=True)
        os.makedirs(gcheck, exist_ok=True)
        gs1 = start(['node', STUB, '18177'], env={'SENTINEL_TXID': SENTINEL_TXID})
        gs2 = start(['node', STUB, '18178'])
        time.sleep(0.5)
        app_g = start(['node', 'server.js'],
                      env={'PORT': '3408', 'DATA_DIR': gdata, 'CHECKIN_DIR': gcheck}, cwd=APP)
        g_path = os.path.join(gdata, 'state.json')
        g_last = os.path.join(gcheck, 'last.json')
        def g_status():
            s, st = req('GET', '/api/status', base=gbase)
            return st
        def g_backdate():
            stj = json.load(open(g_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(g_path, 'w'), indent=2)
        def g_broadcasted(txid):
            s, st = req('GET', '/api/state', base=gbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return bool(tx and tx[0].get('broadcasted'))
        def g_broadcast_count():
            s, blog = req('GET', '/api/broadcast/log', base=gbase)
            return sum(1 for e in blog if e.get('status') == 'broadcast')
        try:
            check('readerror: app up', wait_up(gbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18177',
                        'secondaryApiUrl': 'http://127.0.0.1:18178'}, base=gbase)
            check('readerror: endpoints set to stubs', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100600), 'label': 'G control', 'notes': ''}, base=gbase)
            txg = r['tx']['id']
            # (a) missing file is NOT an error: the release fires
            check('readerror: missing last.json is not an error (flag false)',
                  g_status().get('checkinReadError') is False, g_status())
            g_backdate()
            check('readerror: the clock is release-due before the control run',
                  g_status().get('state') == 'release-due', g_status().get('state'))
            s, r = req('POST', '/api/release/check', {}, base=gbase)
            check('readerror: control — with no last.json the release fires',
                  r.get('action') == 'broadcast', r)
            check('readerror: the control tx broadcast',
                  g_broadcasted(txg), '')
            # New cycle, fresh tx, backdate — then corrupt the file.
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=gbase)
            check('readerror: check-in starts a new cycle', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100601), 'label': 'G garbage', 'notes': ''}, base=gbase)
            txg2 = r['tx']['id']
            g_backdate()
            with open(g_last, 'w') as f:
                f.write('this is not json{{{')
            # (b) malformed last.json withholds the release
            st = g_status()
            check('readerror: a malformed last.json is flagged in /api/status',
                  st.get('checkinReadError') is True, st)
            check('readerror: the clock is still release-due (the flag does not hide the due state)',
                  st.get('state') == 'release-due', st.get('state'))
            n0 = g_broadcast_count()
            s, r = req('POST', '/api/release/check', {}, base=gbase)
            check('readerror: the release is WITHHELD while last.json is malformed',
                  r.get('action') == 'skipped' and r.get('reason') == 'check-in state unreadable', r)
            check('readerror: nothing was attempted in the withheld run',
                  r.get('results') == [], r.get('results'))
            check('readerror: the tx is still un-broadcast in state',
                  not g_broadcasted(txg2), '')
            check('readerror: no new broadcast in the log',
                  g_broadcast_count() == n0, g_broadcast_count())
            # In-app check-in still works: it does not touch last.json.
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=gbase)
            check('readerror: an in-app check-in still lands while the file is malformed',
                  s == 200, r)
            # Backdate again — the withhold persists, it is not a one-shot.
            g_backdate()
            s, r = req('POST', '/api/release/check', {}, base=gbase)
            check('readerror: the withhold persists on a re-run (still skipped)',
                  r.get('action') == 'skipped' and r.get('reason') == 'check-in state unreadable', r)
            check('readerror: still nothing broadcast',
                  not g_broadcasted(txg2), '')
            # Repair: a valid last.json older than the clock merges as
            # a no-op — the flag clears and the due release fires.
            # The withhold did NOT cancel the due state.
            with open(g_last, 'w') as f:
                json.dump({'lastCheckinAt': (datetime.now(timezone.utc) - timedelta(days=200)).isoformat().replace('+00:00', 'Z'),
                           'keyId': None, 'label': None}, f)
            st = g_status()
            check('readerror: the flag clears once last.json is readable again',
                  st.get('checkinReadError') is False, st)
            check('readerror: the clock is still release-due after the repair (due state survived the withhold)',
                  st.get('state') == 'release-due', st.get('state'))
            s, r = req('POST', '/api/release/check', {}, base=gbase)
            check('readerror: the release fires once the file is readable again',
                  r.get('action') == 'broadcast', r)
            check('readerror: the tx broadcast after the repair',
                  g_broadcasted(txg2), '')
            # (c) a last.json that EXISTS but cannot be read
            # withholds too. (The suite runs as root, so chmod 000
            # does not block reads — root bypasses permission bits.
            # A directory in place of the file is the equivalent
            # probe here: readFileSync throws EISDIR, a non-ENOENT
            # read error, which must surface as 'error', not
            # 'missing' — the same branch an EACCES takes.)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=gbase)
            check('readerror: check-in starts a new cycle for the unreadable-file run', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100602), 'label': 'G unreadable', 'notes': ''}, base=gbase)
            txg3 = r['tx']['id']
            g_backdate()
            os.remove(g_last)
            os.mkdir(g_last)
            try:
                st = g_status()
                check('readerror: an unreadable last.json is flagged',
                      st.get('checkinReadError') is True, st)
                s, r = req('POST', '/api/release/check', {}, base=gbase)
                check('readerror: the release is WITHHELD while last.json is unreadable',
                      r.get('action') == 'skipped' and r.get('reason') == 'check-in state unreadable', r)
                check('readerror: the tx is still un-broadcast',
                      not g_broadcasted(txg3), '')
            finally:
                os.rmdir(g_last)
            check('readerror: the flag clears once last.json is readable again',
                  g_status().get('checkinReadError') is False, g_status())
            s, r = req('POST', '/api/release/check', {}, base=gbase)
            check('readerror: the release fires once last.json is readable again',
                  r.get('action') == 'broadcast', r)
            check('readerror: the tx broadcast after the repair',
                  g_broadcasted(txg3), '')
        finally:
            stop(app_g)
            stop(gs1)
            stop(gs2)

        # 0.7.14 — retry fix: a failed broadcast no longer ends the
        # release. A spent input is still stale (terminal, skip it),
        # but an unknown-reason failure (a node rejection, a network
        # error, a not-yet-final timelocked transaction) is recorded
        # as 'failed' and retried on the next hourly tick — so while
        # any ARMED transaction carries a 'failed' release record,
        # the status stays 'release-due' and the release keeps
        # running. 'Broadcasted' only once every armed transaction
        # has reached a terminal state (broadcasted or stale).
        rdata = '/tmp/heirloom094-retry'
        rbase = 'http://127.0.0.1:3410'
        shutil.rmtree(rdata, ignore_errors=True)
        # Craft both hexes BEFORE the stubs start: the stub must know
        # B's txid in advance (STUB_REJECT_ONCE_TXID) so it rejects
        # B's first broadcast with 400 'non-final' and accepts it
        # on the retry.
        r_hex_a = craft(1, 100700)
        r_hex_b = craft(1, 100701)
        r_txid_b = txid_of(r_hex_b)
        rs1 = start(['node', STUB, '18179'],
                    env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_REJECT_ONCE_TXID': r_txid_b})
        rs2 = start(['node', STUB, '18180'],
                    env={'STUB_REJECT_ONCE_TXID': r_txid_b})
        time.sleep(0.5)
        app_r = start(['node', 'server.js'],
                      env={'PORT': '3410', 'DATA_DIR': rdata, 'CHECKIN_DIR': rdata + '-checkin'},
                      cwd=APP)
        r_path = os.path.join(rdata, 'state.json')
        def r_status():
            s, st = req('GET', '/api/status', base=rbase)
            return st
        def r_backdate():
            stj = json.load(open(r_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(r_path, 'w'), indent=2)
        def r_release(txid):
            s, st = req('GET', '/api/state', base=rbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return tx[0].get('release') if tx else None
        def r_broadcasted(txid):
            s, st = req('GET', '/api/state', base=rbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return bool(tx and tx[0].get('broadcasted'))
        try:
            check('retry: app up', wait_up(rbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18179',
                        'secondaryApiUrl': 'http://127.0.0.1:18180'}, base=rbase)
            check('retry: endpoints set to stubs', s == 200, r)
            # A broadcasts, B is rejected once (400 'non-final').
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': r_hex_a, 'label': 'R first', 'notes': ''}, base=rbase)
            txr_a = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': r_hex_b, 'label': 'R second', 'notes': ''}, base=rbase)
            txr_b = r['tx']['id']
            r_backdate()
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('retry: the release action is broadcast (A went out)',
                  r.get('action') == 'broadcast', r.get('action'))
            check('retry: A broadcasts', res.get(txr_a, {}).get('action') == 'broadcast', res.get(txr_a))
            check('retry: B fails (unknown reason — the node rejected it)',
                  res.get(txr_b, {}).get('action') == 'failed', res.get(txr_b))
            check('retry: B carries a failed release record',
                  (r_release(txr_b) or {}).get('status') == 'failed', r_release(txr_b))
            # The release is NOT done: the status stays release-due
            # while an armed tx carries a failed record.
            check('retry: the status stays release-due while B has a failed record',
                  r_status().get('state') == 'release-due', r_status().get('state'))
            # Next evaluation retries B — and now the stub accepts it.
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('retry: the retry re-attempts B (not skipped)',
                  res.get(txr_b, {}).get('action') == 'broadcast', res.get(txr_b))
            check('retry: B broadcasts on the retry', r_broadcasted(txr_b), '')
            check('retry: the status is broadcasted once every armed tx is resolved',
                  r_status().get('state') == 'broadcasted', r_status().get('state'))
            # A stale tx does NOT keep the status release-due: D is
            # spent (Finney vout 0), E broadcasts. The release ends.
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=rbase)
            check('retry: check-in starts a new cycle', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(0, 100702), 'label': 'R stale', 'notes': ''}, base=rbase)
            txr_d = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100703), 'label': 'R third', 'notes': ''}, base=rbase)
            txr_e = r['tx']['id']
            r_backdate()
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('retry: D is stale (spent input)', res.get(txr_d, {}).get('action') == 'stale', res.get(txr_d))
            check('retry: E broadcasts', res.get(txr_e, {}).get('action') == 'broadcast', res.get(txr_e))
            check('retry: the status is broadcasted — a stale tx does not keep it release-due',
                  r_status().get('state') == 'broadcasted', r_status().get('state'))
            # A second evaluation is skipped (not release-due): the
            # stale tx is not retried, and the cycle is over.
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            check('retry: a second evaluation is skipped once the cycle is broadcasted',
                  r.get('action') == 'skipped' and 'broadcasted' in (r.get('reason') or ''), r)
            # All fail: restart the stubs so every broadcast is
            # rejected (STUB_BAD_TXID on both), new cycle, one tx.
            stop(rs1)
            stop(rs2)
            rs1 = start(['node', STUB, '18179'],
                        env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BAD_TXID': '1'})
            rs2 = start(['node', STUB, '18180'],
                        env={'STUB_BAD_TXID': '1'})
            time.sleep(0.5)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=rbase)
            check('retry: check-in starts a new cycle for the all-fail run', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100704), 'label': 'R all-fail', 'notes': ''}, base=rbase)
            txr_c = r['tx']['id']
            r_backdate()
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('retry: all fail — the release action is failed',
                  r.get('action') == 'failed', r.get('action'))
            check('retry: C fails', res.get(txr_c, {}).get('action') == 'failed', res.get(txr_c))
            check('retry: the status stays release-due when every tx fails',
                  r_status().get('state') == 'release-due', r_status().get('state'))
            # The retry is armed: a second evaluation re-attempts C
            # (it fails again while the stubs reject, but it is
            # attempted, not skipped).
            s, r = req('POST', '/api/release/check', {}, base=rbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('retry: the second evaluation re-attempts C (not skipped)',
                  res.get(txr_c, {}).get('action') == 'failed', res.get(txr_c))
            check('retry: the status is still release-due after the second failure',
                  r_status().get('state') == 'release-due', r_status().get('state'))
        finally:
            stop(app_r)
            stop(rs1)
            stop(rs2)

        # 0.7.14 — absolute-locktime warning: a dry-run on a
        # transaction whose absolute locktime has not passed reports
        # verdict 'timelocked' (not 'ready'), with wouldBroadcast
        # true — the release WILL attempt the broadcast (and the node
        # will reject it as non-final), so it is retried on the next
        # hourly check like any other unknown-reason failure. A
        # locktime in the past, or one with every sequence maxed (so
        # the locktime is ignored), is still 'ready'. The dry-run
        # summary counts only the transactions that would actually
        # land (a timelocked one is named separately, not counted as
        # 'would broadcast'). The stub tip height is fixed at 900000.
        tdata = '/tmp/heirloom094-timelock'
        tbase = 'http://127.0.0.1:3412'
        shutil.rmtree(tdata, ignore_errors=True)
        ts1 = start(['node', STUB, '18181'], env={'SENTINEL_TXID': SENTINEL_TXID})
        ts2 = start(['node', STUB, '18182'])
        time.sleep(0.5)
        app_t = start(['node', 'server.js'],
                      env={'PORT': '3412', 'DATA_DIR': tdata, 'CHECKIN_DIR': tdata + '-checkin'},
                      cwd=APP)
        def t_dryrun(txid):
            s, r = req('POST', '/api/broadcast/test', {'id': txid}, base=tbase)
            return (r.get('results') or [{}])[0]
        def t_release(txid):
            s, st = req('GET', '/api/state', base=tbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return tx[0].get('release') if tx else None
        try:
            check('timelock: app up', wait_up(tbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18181',
                        'secondaryApiUrl': 'http://127.0.0.1:18182'}, base=tbase)
            check('timelock: endpoints set to stubs', s == 200, r)
            now_ts = int(time.time())
            # T1: height locktime 950000 (> stub tip 900000), live
            # sequence -> timelocked. T2: height locktime 800000 (<
            # tip) -> ready. T3: height locktime 950000 but every
            # sequence maxed -> ready (locktime ignored). T4:
            # timestamp locktime a year out -> timelocked. T5:
            # timestamp locktime a year back -> ready.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_locktime(FINNEY, 1, 950000, 0, 100710), 'label': 'T1 height future', 'notes': ''}, base=tbase)
            txt1 = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_locktime(SECOND, 0, 800000, 0, 100711), 'label': 'T2 height past', 'notes': ''}, base=tbase)
            txt2 = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_locktime(SECOND, 1, 950000, 0xffffffff, 100712), 'label': 'T3 height future maxed seq', 'notes': ''}, base=tbase)
            txt3 = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_locktime(SECOND, 2, now_ts + 365 * 86400, 0, 100713), 'label': 'T4 timestamp future', 'notes': ''}, base=tbase)
            txt4 = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_locktime(FINNEY, 1, now_ts - 365 * 86400, 0, 100714), 'label': 'T5 timestamp past', 'notes': ''}, base=tbase)
            txt5 = r['tx']['id']
            d1 = t_dryrun(txt1)
            check('timelock: a height locktime above the tip is verdict timelocked',
                  d1.get('verdict') == 'timelocked', d1.get('verdict'))
            check('timelock: a timelocked tx would be attempted (wouldBroadcast true — the release tries it, the node rejects it)',
                  d1.get('wouldBroadcast') is True, d1.get('wouldBroadcast'))
            check('timelock: the note names the unlock block',
                  'timelocked until block 950000' in (d1.get('note') or ''), d1.get('note'))
            check('timelock: the note says the broadcast will be attempted and rejected, then retried',
                  'attempted and rejected' in (d1.get('note') or '') and 'retried on the next hourly check' in (d1.get('note') or '') and 'no broadcast will be attempted' not in (d1.get('note') or ''), d1.get('note'))
            check('timelock: timelockedUntil carries the block height',
                  d1.get('timelockedUntil') == 950000, d1.get('timelockedUntil'))
            check('timelock: a timelocked verdict writes NO release record',
                  t_release(txt1) is None, t_release(txt1))
            d2 = t_dryrun(txt2)
            check('timelock: a height locktime below the tip is verdict ready',
                  d2.get('verdict') == 'ready', d2.get('verdict'))
            check('timelock: a passed height locktime would broadcast',
                  d2.get('wouldBroadcast') is True, d2.get('wouldBroadcast'))
            d3 = t_dryrun(txt3)
            check('timelock: a locktime with every sequence maxed is verdict ready (locktime ignored)',
                  d3.get('verdict') == 'ready', d3.get('verdict'))
            check('timelock: a maxed-sequence locktime would broadcast',
                  d3.get('wouldBroadcast') is True, d3.get('wouldBroadcast'))
            d4 = t_dryrun(txt4)
            check('timelock: a timestamp locktime in the future is verdict timelocked',
                  d4.get('verdict') == 'timelocked', d4.get('verdict'))
            check('timelock: a future timestamp locktime would be attempted (wouldBroadcast true)',
                  d4.get('wouldBroadcast') is True, d4.get('wouldBroadcast'))
            check('timelock: the timestamp note names the unlock date',
                  'timelocked until ' in (d4.get('note') or '') and 'T' in (d4.get('note') or ''), d4.get('note'))
            check('timelock: timelockedUntil carries the unlock date as an ISO string',
                  isinstance(d4.get('timelockedUntil'), str) and 'T' in d4.get('timelockedUntil'), d4.get('timelockedUntil'))
            d5 = t_dryrun(txt5)
            check('timelock: a timestamp locktime in the past is verdict ready',
                  d5.get('verdict') == 'ready', d5.get('verdict'))
            check('timelock: a passed timestamp locktime would broadcast',
                  d5.get('wouldBroadcast') is True, d5.get('wouldBroadcast'))
            # The dry-run-all summary counts only the transactions
            # that would actually land: T2/T3/T5 are ready (3 of 5),
            # T1/T4 are timelocked (named separately, not counted as
            # 'would broadcast'). The top-level wouldBroadcast is
            # true because some tx would land.
            s, rall = req('POST', '/api/broadcast/test', {}, base=tbase)
            check('timelock: the dry-run-all summary counts only the txs that would land (3 of 5)',
                  '3 of 5 armed transaction(s) would broadcast' in (rall.get('note') or ''), rall.get('note'))
            check('timelock: the dry-run-all summary names the timelocked txs separately',
                  '2 timelocked' in (rall.get('note') or ''), rall.get('note'))
            check('timelock: the dry-run-all top-level wouldBroadcast is true (some tx would land)',
                  rall.get('wouldBroadcast') is True, rall.get('wouldBroadcast'))
            # A dry-run-all with ONLY timelocked txs: nothing would
            # land, so the top-level wouldBroadcast is false — but
            # the note still names them as timelocked, not as
            # would-broadcast.
            s, r = req('DELETE', '/api/bitcoin/txs/' + txt2, base=tbase)
            s, r = req('DELETE', '/api/bitcoin/txs/' + txt3, base=tbase)
            s, r = req('DELETE', '/api/bitcoin/txs/' + txt5, base=tbase)
            s, rall2 = req('POST', '/api/broadcast/test', {}, base=tbase)
            check('timelock: with only timelocked txs, the summary counts 0 would broadcast',
                  '0 of 2 armed transaction(s) would broadcast' in (rall2.get('note') or ''), rall2.get('note'))
            check('timelock: with only timelocked txs, the summary still names them timelocked',
                  '2 timelocked' in (rall2.get('note') or ''), rall2.get('note'))
            check('timelock: with only timelocked txs, the top-level wouldBroadcast is false',
                  rall2.get('wouldBroadcast') is False, rall2.get('wouldBroadcast'))
        finally:
            stop(app_t)
            stop(ts1)
            stop(ts2)

        # --- import (0.7.15): hex file + fully-signed PSBT ---
        # No mempool stubs: import is pure parsing/finalization, no
        # network. App on 3414 (next free after the 3412 timelock app).
        idata = '/tmp/heirloom094-import'
        ibase = 'http://127.0.0.1:3414'
        shutil.rmtree(idata, ignore_errors=True)
        app_i = start(['node', 'server.js'],
                      env={'PORT': '3414', 'DATA_DIR': idata, 'CHECKIN_DIR': idata + '-checkin'},
                      cwd=APP)
        try:
            check('import: app up', wait_up(ibase))
            unsigned_hex = craft(1)  # 1 input (FINNEY vout 1), empty scriptSig
            exp_p2pkh = signed_p2pkh_hex(PSBT_SIG, PSBT_PK1)
            exp_p2wpkh = signed_p2wpkh_hex(PSBT_SIG, PSBT_PK1)
            redeem = b'\x00\x14' + _hash160(PSBT_PK1)
            exp_p2sh = signed_p2sh_p2wpkh_hex(redeem, PSBT_SIG, PSBT_PK1)
            ms_script = (b'\x52' + _push(PSBT_PK1) + _push(PSBT_PK2) + _push(PSBT_PK3)
                         + b'\x53\xae')
            exp_msig = signed_p2wsh_msig_hex([PSBT_SIG, PSBT_SIG2])
            pkh_spk = b'\x76\xa9\x14' + _hash160(PSBT_PK1) + b'\x88\xac'
            wpkh_spk = b'\x00\x14' + _hash160(PSBT_PK1)
            sh_spk = b'\xa9\x14' + _hash160(redeem) + b'\x87'
            wsh_spk = b'\x00\x20' + hashlib.sha256(ms_script).digest()
            script_sig = _push(PSBT_SIG) + _push(PSBT_PK1)
            # Each PSBT case gets its own unsigned tx value, so each
            # finalizes to a distinct txid — duplicate txids are now
            # rejected, so the cases cannot all share craft(1).
            unsigned_11, exp_p2pkh_11 = craft(1, 100011), signed_p2pkh_hex(PSBT_SIG, PSBT_PK1, value=100011)
            unsigned_12, exp_p2wpkh_12 = craft(1, 100012), signed_p2wpkh_hex(PSBT_SIG, PSBT_PK1, value=100012)
            unsigned_13, exp_p2sh_13 = craft(1, 100013), signed_p2sh_p2wpkh_hex(redeem, PSBT_SIG, PSBT_PK1, value=100013)
            unsigned_14, exp_msig_14 = craft(1, 100014), signed_p2wsh_msig_hex([PSBT_SIG, PSBT_SIG2], value=100014)
            unsigned_15, exp_p2pkh_15 = craft(1, 100015), signed_p2pkh_hex(PSBT_SIG, PSBT_PK1, value=100015)
            unsigned_16, exp_p2pkh_16 = craft(1, 100016), signed_p2pkh_hex(PSBT_SIG, PSBT_PK1, value=100016)

            # (a) Hex file import: a valid hex adds the tx; an invalid hex
            # is rejected with the paste-path error; surrounding
            # whitespace (a trailing newline in a real file) is trimmed.
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': craft(1, 100101), 'label': 'hex import', 'notes': ''}, base=ibase)
            check('import hex: a valid hex file imports (201)',
                  s == 201 and r.get('tx', {}).get('txid') == txid_of(craft(1, 100101)), (s, r))
            check('import hex: the label is stored',
                  r.get('tx', {}).get('label') == 'hex import', r.get('tx', {}).get('label'))
            check('import hex: the imported tx is armed by default',
                  r.get('tx', {}).get('enabled') is True, r.get('tx', {}).get('enabled'))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': '  ' + craft(1, 100102) + '\n', 'label': 'hex ws', 'notes': ''}, base=ibase)
            check('import hex: surrounding whitespace is trimmed',
                  s == 201, (s, r))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': 'zzzz', 'label': 'bad', 'notes': ''}, base=ibase)
            check('import hex: an invalid hex is rejected with the paste-path error',
                  s == 400 and r.get('error', '').startswith('invalid transaction: '), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': '   ', 'label': 'empty', 'notes': ''}, base=ibase)
            check('import hex: empty data is rejected', s == 400, (s, r))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'yaml', 'data': craft(1, 100103)}, base=ibase)
            check('import: an unknown format is rejected',
                  s == 400 and 'hex or psbt' in r.get('error', ''), (s, r))

            # (b) PSBT import, base64: final_script_sig (P2PKH) extracts
            # the exact raw hex; P2PKH / P2WPKH / P2SH-P2WPKH / P2WSH
            # 2-of-3 finalize from partial signatures + scripts.
            psbt_final = build_psbt(unsigned_hex, [[(0x07, b'', script_sig)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_final).decode(),
                        'label': 'psbt final', 'notes': ''}, base=ibase)
            check('import psbt: a final_script_sig PSBT (base64) imports (201)',
                  s == 201, (s, r))
            check('import psbt: the extracted hex is the exact signed tx',
                  r.get('tx', {}).get('hex') == exp_p2pkh, (r.get('tx', {}).get('hex') or '')[:80])
            check('import psbt: the extracted txid matches',
                  r.get('tx', {}).get('txid') == txid_of(exp_p2pkh), r.get('tx', {}).get('txid'))
            psbt_p2pkh = build_psbt(unsigned_11,
                                    [[(0x01, b'', _wit_utxo(pkh_spk)), (0x02, PSBT_PK1, PSBT_SIG)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_p2pkh).decode(),
                        'label': 'psbt p2pkh', 'notes': ''}, base=ibase)
            check('import psbt: a P2PKH PSBT finalizes from partial signatures',
                  s == 201 and r.get('tx', {}).get('hex') == exp_p2pkh_11, (s, r))
            psbt_p2wpkh = build_psbt(unsigned_12,
                                     [[(0x01, b'', _wit_utxo(wpkh_spk)), (0x02, PSBT_PK1, PSBT_SIG)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_p2wpkh).decode(),
                        'label': 'psbt p2wpkh', 'notes': ''}, base=ibase)
            check('import psbt: a P2WPKH PSBT finalizes from partial signatures (segwit)',
                  s == 201 and r.get('tx', {}).get('hex') == exp_p2wpkh_12 and r.get('tx', {}).get('segwit') is True, (s, r))
            psbt_p2sh = build_psbt(unsigned_13,
                                   [[(0x01, b'', _wit_utxo(sh_spk)), (0x04, b'', redeem),
                                     (0x02, PSBT_PK1, PSBT_SIG)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_p2sh).decode(),
                        'label': 'psbt p2sh', 'notes': ''}, base=ibase)
            check('import psbt: a P2SH-P2WPKH PSBT finalizes from partial signatures + redeem script',
                  s == 201 and r.get('tx', {}).get('hex') == exp_p2sh_13, (s, r))
            psbt_msig = build_psbt(unsigned_14,
                                   [[(0x01, b'', _wit_utxo(wsh_spk)), (0x05, b'', ms_script),
                                     (0x02, PSBT_PK1, PSBT_SIG), (0x02, PSBT_PK3, PSBT_SIG2)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_msig).decode(),
                        'label': 'psbt msig', 'notes': ''}, base=ibase)
            check('import psbt: a P2WSH 2-of-3 multisig PSBT finalizes from two partial signatures',
                  s == 201 and r.get('tx', {}).get('hex') == exp_msig_14, (s, r))

            # (f) A PSBT given as raw binary works too (sent as a latin1
            # string in the JSON body — the server detects it by content).
            # Built around its own unsigned tx so its txid is distinct.
            psbt_raw = build_psbt(unsigned_15, [[(0x07, b'', script_sig)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': psbt_raw.decode('latin1'),
                        'label': 'psbt raw', 'notes': ''}, base=ibase)
            check('import psbt: a raw binary PSBT imports (latin1)',
                  s == 201 and r.get('tx', {}).get('hex') == exp_p2pkh_15, (s, r))

            # (c) A partially-signed PSBT is rejected, naming the input
            # and how many signatures it has vs. needs — and is NOT added.
            psbt_partial = build_psbt(unsigned_hex,
                                      [[(0x01, b'', _wit_utxo(wsh_spk)), (0x05, b'', ms_script),
                                        (0x02, PSBT_PK1, PSBT_SIG)]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_partial).decode(),
                        'label': 'psbt partial', 'notes': ''}, base=ibase)
            check('import psbt: a 1-of-2 multisig PSBT is rejected',
                  s == 400, (s, r))
            check('import psbt: the rejection names input 0 and the 1-of-2 count',
                  'input 0' in r.get('error', '') and 'has 1 of 2' in r.get('error', ''), r.get('error'))
            psbt_nosig = build_psbt(unsigned_hex,
                                    [[(0x01, b'', _wit_utxo(wpkh_spk))]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_nosig).decode(),
                        'label': 'psbt nosig', 'notes': ''}, base=ibase)
            check('import psbt: a PSBT with no signatures is rejected, naming input 0',
                  s == 400 and 'input 0' in r.get('error', '') and 'has 0 of 1' in r.get('error', ''), (s, r))

            # (d) A malformed PSBT is rejected.
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(b'not a psbt at all').decode(),
                        'label': 'bad magic', 'notes': ''}, base=ibase)
            check('import psbt: bad magic is rejected as not a PSBT file (names the two valid formats)',
                  s == 400 and 'not a PSBT file' in r.get('error', '') and 'plain hex file' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_final[:12]).decode(),
                        'label': 'truncated', 'notes': ''}, base=ibase)
            check('import psbt: a truncated PSBT is rejected',
                  s == 400 and 'truncated' in r.get('error', ''), (s, r))

            # (e) A PSBT whose unsigned transaction does not parse is rejected.
            psbt_badtx = build_psbt('0100000000', [[]])
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_badtx).decode(),
                        'label': 'bad unsigned', 'notes': ''}, base=ibase)
            check('import psbt: an unparsable unsigned transaction is rejected',
                  s == 400 and 'does not parse' in r.get('error', ''), (s, r))

            # The imported transactions are all stored (hex + PSBT paths).
            s, st = req('GET', '/api/state', base=ibase)
            n_imported = len(st.get('bitcoin', {}).get('txs', []))
            check('import: the imported transactions are stored (8)',
                  n_imported == 8, n_imported)

            # (g) Preview endpoint: validates and returns the hex
            # WITHOUT storing anything. The UI calls this when a PSBT
            # file is imported, so the extracted hex can be put in
            # the textarea for the user to label and add via paste.
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'hex', 'data': craft(1, 100201)}, base=ibase)
            check('preview: a hex preview returns the hex and txid',
                  s == 200 and r.get('hex') == craft(1, 100201) and r.get('txid') == txid_of(craft(1, 100201)), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_final).decode()}, base=ibase)
            check('preview: a PSBT preview returns the extracted hex and txid',
                  s == 200 and r.get('hex') == exp_p2pkh and r.get('txid') == txid_of(exp_p2pkh), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(b'not a psbt at all').decode()}, base=ibase)
            check('preview: a bad PSBT is rejected as not a PSBT file',
                  s == 400 and 'not a PSBT file' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_partial).decode()}, base=ibase)
            check('preview: a not-fully-signed PSBT is rejected, naming input 0',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'yaml', 'data': craft(1, 100202)}, base=ibase)
            check('preview: an unknown format is rejected',
                  s == 400 and 'hex or psbt' in r.get('error', ''), (s, r))
            s, st = req('GET', '/api/state', base=ibase)
            check('preview: nothing is stored by previewing',
                  len(st.get('bitcoin', {}).get('txs', [])) == 8, len(st.get('bitcoin', {}).get('txs', [])))

            # (h) The paste path accepts a PSBT too (the box is now
            # "hex or PSBT"): a pasted base64 PSBT is finalized and
            # stored like a hex paste. Built around its own unsigned
            # tx so its txid is distinct.
            psbt_paste = build_psbt(unsigned_16, [[(0x07, b'', script_sig)]])
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': base64.b64encode(psbt_paste).decode(),
                        'label': 'paste psbt', 'notes': ''}, base=ibase)
            check('paste: a pasted base64 PSBT adds the transaction (201)',
                  s == 201 and r.get('tx', {}).get('hex') == exp_p2pkh_16, (s, r))
            check('paste: the pasted PSBT txid matches',
                  r.get('tx', {}).get('txid') == txid_of(exp_p2pkh_16), r.get('tx', {}).get('txid'))
            paste_id = r.get('tx', {}).get('id')
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': base64.b64encode(psbt_partial).decode(),
                        'label': 'paste partial', 'notes': ''}, base=ibase)
            check('paste: a pasted not-fully-signed PSBT is rejected, naming input 0',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': 'garbage not hex not psbt!!', 'label': 'paste garbage', 'notes': ''}, base=ibase)
            check('paste: text that is neither hex nor PSBT is rejected as an invalid transaction',
                  s == 400 and r.get('error', '').startswith('invalid transaction: '), (s, r))

            # (i) Duplicate txids are rejected in every add path,
            # naming the existing card by its label.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': base64.b64encode(psbt_paste).decode(),
                        'label': 'paste dup', 'notes': ''}, base=ibase)
            check('dup: pasting a duplicate PSBT txid is rejected, naming the existing card',
                  s == 400 and 'already stored' in r.get('error', '') and 'paste psbt' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100101), 'label': 'paste dup hex', 'notes': ''}, base=ibase)
            check('dup: pasting a duplicate hex txid is rejected, naming the existing card',
                  s == 400 and 'already stored' in r.get('error', '') and 'hex import' in r.get('error', ''), (s, r))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': craft(1, 100102), 'label': 'import dup', 'notes': ''}, base=ibase)
            check('dup: importing a duplicate txid is rejected, naming the existing card',
                  s == 400 and 'already stored' in r.get('error', '') and 'hex ws' in r.get('error', ''), (s, r))
            s, r = req('PUT', '/api/bitcoin/txs/' + paste_id,
                       {'txHex': craft(1, 100101)}, base=ibase)
            check('dup: editing a tx hex to another stored txid is rejected',
                  s == 400 and 'already stored' in r.get('error', '') and 'hex import' in r.get('error', ''), (s, r))
            s, r = req('PUT', '/api/bitcoin/txs/' + paste_id,
                       {'txHex': exp_p2pkh_16}, base=ibase)
            check('dup: editing a tx to its own hex is allowed',
                  s == 200, (s, r))
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'hex', 'data': craft(1, 100101)}, base=ibase)
            check('dup: preview still returns the hex for a duplicate txid (no rejection there)',
                  s == 200 and r.get('hex') == craft(1, 100101) and r.get('txid') == txid_of(craft(1, 100101)), (s, r))
            s, st = req('GET', '/api/state', base=ibase)
            check('dup: no duplicates were stored (9 total)',
                  len(st.get('bitcoin', {}).get('txs', [])) == 9, len(st.get('bitcoin', {}).get('txs', [])))

            # (j) 0.7.19: final-script validation — the final fields
            # are validated against the spent-output script type,
            # not merely trusted because one of them is present.
            # All cases use preview (no storage), so the stored
            # count stays 9.
            def _wit_stack(items):
                w = _psbt_varint(len(items))
                for it in items:
                    w += _psbt_varint(len(it)) + it
                return w
            tap_spk = b'\x51\x20' + b'\x11' * 32  # SegWit v1 (taproot-shaped)
            # The finding: P2WPKH with an EMPTY final_scriptSig and
            # NO final_scriptWitness is rejected as not fully signed.
            psbt_wpkh_empty = build_psbt(craft(1, 100401),
                [[(0x01, b'', _wit_utxo(wpkh_spk, 100401)), (0x07, b'', b'')]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wpkh_empty).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WPKH with an empty final_scriptSig and no witness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'P2WPKH' in r.get('error', '') and 'no final_scriptWitness' in r.get('error', ''), (s, r))
            # A proper P2WPKH final_scriptWitness (2 items) with an
            # empty final_scriptSig entry is accepted — the empty
            # field is treated as absent, not as finalization.
            psbt_wpkh_final = build_psbt(craft(1, 100402),
                [[(0x01, b'', _wit_utxo(wpkh_spk, 100402)), (0x07, b'', b''),
                  (0x08, b'', _wit_stack([PSBT_SIG, PSBT_PK1]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wpkh_final).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WPKH with a proper 2-item final_scriptWitness is accepted',
                  s == 200 and r.get('hex') == signed_p2wpkh_hex(PSBT_SIG, PSBT_PK1, value=100402), (s, r))
            # A P2WPKH witness with the wrong item count is rejected.
            psbt_wpkh_1item = build_psbt(craft(1, 100409),
                [[(0x01, b'', _wit_utxo(wpkh_spk, 100409)),
                  (0x08, b'', _wit_stack([PSBT_SIG]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wpkh_1item).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WPKH with a 1-item final_scriptWitness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'exactly 2' in r.get('error', ''), (s, r))
            # P2PKH: a proper final_scriptSig is accepted.
            psbt_pkh_final = build_psbt(craft(1, 100403),
                [[(0x01, b'', _wit_utxo(pkh_spk, 100403)), (0x07, b'', script_sig)]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_pkh_final).decode()}, base=ibase)
            check('import psbt 0.7.19: P2PKH with a proper final_scriptSig is accepted',
                  s == 200 and r.get('hex') == signed_p2pkh_hex(PSBT_SIG, PSBT_PK1, value=100403), (s, r))
            # P2PKH: an empty final_scriptSig and no witness is rejected.
            psbt_pkh_empty = build_psbt(craft(1, 100410),
                [[(0x01, b'', _wit_utxo(pkh_spk, 100410)), (0x07, b'', b'')]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_pkh_empty).decode()}, base=ibase)
            check('import psbt 0.7.19: P2PKH with an empty final_scriptSig and no witness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'P2PKH' in r.get('error', '') and 'no final_scriptSig' in r.get('error', ''), (s, r))
            # P2PKH: a non-empty witness on a non-SegWit input is rejected.
            psbt_pkh_wit = build_psbt(craft(1, 100414),
                [[(0x01, b'', _wit_utxo(pkh_spk, 100414)), (0x07, b'', script_sig),
                  (0x08, b'', _wit_stack([PSBT_SIG, PSBT_PK1]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_pkh_wit).decode()}, base=ibase)
            check('import psbt 0.7.19: P2PKH with an unexpected final_scriptWitness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'should not have' in r.get('error', ''), (s, r))
            # P2WPKH: a non-empty scriptSig on a SegWit input is rejected.
            psbt_wpkh_sig = build_psbt(craft(1, 100415),
                [[(0x01, b'', _wit_utxo(wpkh_spk, 100415)), (0x07, b'', script_sig),
                  (0x08, b'', _wit_stack([PSBT_SIG, PSBT_PK1]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wpkh_sig).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WPKH with an unexpected final_scriptSig is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'should not have' in r.get('error', ''), (s, r))
            # P2WSH: a proper final_scriptWitness is accepted.
            psbt_wsh_final = build_psbt(craft(1, 100404),
                [[(0x01, b'', _wit_utxo(wsh_spk, 100404)), (0x05, b'', ms_script),
                  (0x08, b'', _wit_stack([b'', PSBT_SIG, PSBT_SIG2]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wsh_final).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WSH with a proper final_scriptWitness is accepted',
                  s == 200 and r.get('hex') == signed_p2wsh_msig_hex([PSBT_SIG, PSBT_SIG2], value=100404), (s, r))
            # P2WSH: an empty final_scriptWitness is rejected.
            psbt_wsh_empty = build_psbt(craft(1, 100411),
                [[(0x01, b'', _wit_utxo(wsh_spk, 100411)),
                  (0x08, b'', _wit_stack([]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_wsh_empty).decode()}, base=ibase)
            check('import psbt 0.7.19: P2WSH with an empty final_scriptWitness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'P2WSH' in r.get('error', '') and 'no final_scriptWitness' in r.get('error', ''), (s, r))
            # P2SH-P2WPKH: a final scriptSig (redeem) + witness is accepted.
            psbt_sh_final = build_psbt(craft(1, 100405),
                [[(0x01, b'', _wit_utxo(sh_spk, 100405)), (0x04, b'', redeem),
                  (0x07, b'', _push(redeem)), (0x08, b'', _wit_stack([PSBT_SIG, PSBT_PK1]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_sh_final).decode()}, base=ibase)
            check('import psbt 0.7.19: P2SH-P2WPKH with a final scriptSig + witness is accepted',
                  s == 200 and r.get('hex') == signed_p2sh_p2wpkh_hex(redeem, PSBT_SIG, PSBT_PK1, value=100405), (s, r))
            # P2SH-P2WPKH: a final scriptSig with no witness is rejected.
            psbt_sh_nowit = build_psbt(craft(1, 100416),
                [[(0x01, b'', _wit_utxo(sh_spk, 100416)), (0x04, b'', redeem),
                  (0x07, b'', _push(redeem))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_sh_nowit).decode()}, base=ibase)
            check('import psbt 0.7.19: P2SH-P2WPKH with a final scriptSig but no witness is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'P2SH-P2WPKH' in r.get('error', '') and 'no final_scriptWitness' in r.get('error', ''), (s, r))
            # Unknown script type (taproot-shaped): a non-empty final
            # witness is accepted — the fallback must not break
            # legitimate taproot imports.
            psbt_tap_final = build_psbt(craft(1, 100406),
                [[(0x01, b'', _wit_utxo(tap_spk, 100406)),
                  (0x08, b'', _wit_stack([PSBT_SIG]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_tap_final).decode()}, base=ibase)
            check('import psbt 0.7.19: a taproot-shaped input with a non-empty final_scriptWitness is accepted',
                  s == 200 and r.get('hex') == _signed_frame(b'', witness=[PSBT_SIG], value=100406), (s, r))
            # Unknown script type with BOTH final fields empty is rejected.
            psbt_tap_empty = build_psbt(craft(1, 100412),
                [[(0x01, b'', _wit_utxo(tap_spk, 100412)), (0x07, b'', b''),
                  (0x08, b'', _wit_stack([]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_tap_empty).decode()}, base=ibase)
            check('import psbt 0.7.19: a taproot-shaped input with both final fields empty is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'no usable' in r.get('error', ''), (s, r))
            # No spent-output info: both final fields empty is rejected.
            psbt_nospk_empty = build_psbt(craft(1, 100413), [[(0x07, b'', b'')]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_nospk_empty).decode()}, base=ibase)
            check('import psbt 0.7.19: no spent-output info and both final fields empty is rejected',
                  s == 400 and 'not fully signed' in r.get('error', '') and 'input 0' in r.get('error', '')
                  and 'no usable' in r.get('error', ''), (s, r))
            # No spent-output info: one non-empty final_scriptSig is accepted.
            psbt_nospk_sig = build_psbt(craft(1, 100407), [[(0x07, b'', script_sig)]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_nospk_sig).decode()}, base=ibase)
            check('import psbt 0.7.19: no spent-output info and a non-empty final_scriptSig is accepted',
                  s == 200 and r.get('hex') == signed_p2pkh_hex(PSBT_SIG, PSBT_PK1, value=100407), (s, r))
            # No spent-output info: one non-empty final_scriptWitness is accepted.
            psbt_nospk_wit = build_psbt(craft(1, 100408),
                [[(0x08, b'', _wit_stack([PSBT_SIG, PSBT_PK1]))]])
            s, r = req('POST', '/api/bitcoin/txs/preview',
                       {'format': 'psbt', 'data': base64.b64encode(psbt_nospk_wit).decode()}, base=ibase)
            check('import psbt 0.7.19: no spent-output info and a non-empty final_scriptWitness is accepted',
                  s == 200 and r.get('hex') == signed_p2wpkh_hex(PSBT_SIG, PSBT_PK1, value=100408), (s, r))
        finally:
            stop(app_i)

        # --- slipstream (0.7.16): MARA Slipstream as a broadcast route ---
        # A transaction's route is per-tx (Public mempool by default,
        # Slipstream if chosen) and changeable on its card; only the
        # selected route is attempted — no fallback either way. A
        # Slipstream submission is 'submitted-slipstream' (Waiting on
        # MARA), not 'broadcasted': it becomes 'broadcasted' once the
        # public nodes see it, or 'failed' (retried via Slipstream)
        # if MARA drops it. A Slipstream failure surfaces MARA's
        # rejection reason. The stub serves both the mempool API and
        # the Slipstream API on one port, so the app's
        # SLIPSTREAM_API_URL points at the primary stub; the
        # /__test__/slipstream/* endpoints drive the MARA transitions
        # (visible = MARA mined it, drop = MARA dropped it).
        sdata = '/tmp/heirloom094-slipstream'
        sbase = 'http://127.0.0.1:3416'
        sstub = 'http://127.0.0.1:18183'
        shutil.rmtree(sdata, ignore_errors=True)
        ss1 = start(['node', STUB, '18183'], env={'SENTINEL_TXID': SENTINEL_TXID})
        ss2 = start(['node', STUB, '18184'])
        time.sleep(0.5)
        app_s = start(['node', 'server.js'],
                      env={'PORT': '3416', 'DATA_DIR': sdata, 'CHECKIN_DIR': sdata + '-checkin',
                           'SLIPSTREAM_API_URL': 'http://127.0.0.1:18183'},
                      cwd=APP)
        s_path = os.path.join(sdata, 'state.json')
        def s_status():
            s, st = req('GET', '/api/status', base=sbase)
            return st
        def s_backdate():
            stj = json.load(open(s_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(s_path, 'w'), indent=2)
        def s_tx(txid):
            s, st = req('GET', '/api/state', base=sbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return tx[0] if tx else None
        def s_release(txid):
            tx = s_tx(txid)
            return tx.get('release') if tx else None
        try:
            check('slip: app up', wait_up(sbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18183',
                        'secondaryApiUrl': 'http://127.0.0.1:18184'}, base=sbase)
            check('slip: endpoints set to stubs', s == 200, r)
            # (a) The route is stored on the record; the default is
            # 'public' when omitted, and PUT changes it.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100800), 'label': 'S public', 'notes': ''}, base=sbase)
            txs_a = r['tx']['id']
            check('slip: adding without a route defaults to public',
                  s == 201 and r['tx'].get('broadcastVia') == 'public', r.get('tx', {}).get('broadcastVia'))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100801), 'label': 'S slipstream', 'notes': '', 'broadcastVia': 'slipstream'}, base=sbase)
            txs_b = r['tx']['id']
            txs_b_txid = r['tx']['txid']
            check('slip: adding with broadcastVia slipstream stores it',
                  s == 201 and r['tx'].get('broadcastVia') == 'slipstream', r.get('tx', {}).get('broadcastVia'))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_a, {'broadcastVia': 'slipstream'}, base=sbase)
            check('slip: PUT changes the route to slipstream',
                  s == 200 and r['tx'].get('broadcastVia') == 'slipstream', r.get('tx', {}).get('broadcastVia'))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_a, {'broadcastVia': 'bogus'}, base=sbase)
            check('slip: PUT with an invalid route falls back to public',
                  s == 200 and r['tx'].get('broadcastVia') == 'public', r.get('tx', {}).get('broadcastVia'))
            # (b) The dry-run names the route: a Slipstream tx says
            # it would submit to Slipstream, and the dry-run-all
            # summary names Slipstream separately.
            s, r = req('POST', '/api/broadcast/test', {'id': txs_b}, base=sbase)
            one = (r.get('results') or [{}])[0]
            check('slip: the dry-run names Slipstream for a Slipstream-route tx',
                  'Slipstream' in (one.get('note') or '') and 'submission to Slipstream' in (one.get('note') or ''), one.get('note'))
            check('slip: the dry-run result carries the route',
                  one.get('broadcastVia') == 'slipstream', one.get('broadcastVia'))
            s, r = req('POST', '/api/broadcast/test', {}, base=sbase)
            check('slip: the dry-run-all summary names the Slipstream tx separately (mixed)',
                  '2 of 2 armed transaction(s) would broadcast (1 via Slipstream)' in (r.get('note') or ''), r.get('note'))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_a, {'enabled': False}, base=sbase)
            s, r = req('POST', '/api/broadcast/test', {}, base=sbase)
            check('slip: the dry-run-all summary says submit to Slipstream when every would-be tx is Slipstream',
                  '1 of 1 armed transaction(s) would submit to Slipstream' in (r.get('note') or ''), r.get('note'))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_a, {'enabled': True}, base=sbase)
            # (c) The release: the public tx broadcasts, the
            # Slipstream tx is 'submitted-slipstream' — and the
            # release is NOT complete while one waits on MARA.
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: the release action is broadcast (the public tx went out)',
                  r.get('action') == 'broadcast', r.get('action'))
            check('slip: the public tx broadcasts',
                  res.get(txs_a, {}).get('action') == 'broadcast', res.get(txs_a))
            check('slip: the Slipstream tx action is submitted-slipstream (not broadcast)',
                  res.get(txs_b, {}).get('action') == 'submitted-slipstream', res.get(txs_b))
            check('slip: the Slipstream tx carries a submitted-slipstream release record',
                  (s_release(txs_b) or {}).get('status') == 'submitted-slipstream', s_release(txs_b))
            check('slip: a Slipstream submission writes NO broadcasted fact yet',
                  (s_tx(txs_b) or {}).get('broadcasted') is None, (s_tx(txs_b) or {}).get('broadcasted'))
            check('slip: the status stays release-due while a tx waits on MARA (not broadcasted)',
                  s_status().get('state') == 'release-due', s_status().get('state'))
            # (d) A second evaluation does NOT re-submit the waiting
            # tx — it is skipped, and the queue info (position 12)
            # lands on the record from Slipstream's status endpoint.
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: the second evaluation skips the MARA-waiting tx (not re-submitted)',
                  res.get(txs_b, {}).get('action') == 'skipped' and 'Slipstream' in (res.get(txs_b, {}).get('reason') or ''), res.get(txs_b))
            check('slip: the MARA-waiting tx is still submitted-slipstream',
                  (s_release(txs_b) or {}).get('status') == 'submitted-slipstream', s_release(txs_b))
            check('slip: the queue info (position 12) is on the record',
                  (s_release(txs_b) or {}).get('mara', {}).get('position') == 12, s_release(txs_b))
            check('slip: the status is still release-due while the tx waits on MARA',
                  s_status().get('state') == 'release-due', s_status().get('state'))
            # (e) MARA mines it: the public lookup finds it, and the
            # tx becomes 'broadcasted' (release 'broadcast', fact
            # method 'slipstream'); the release is then complete.
            s, r = req('POST', '/__test__/slipstream/visible', {'txid': txs_b_txid}, base=sstub)
            check('slip: the test endpoint marks the tx publicly visible', s == 200, r)
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            check('slip: once visible publicly the tx is broadcasted',
                  (s_release(txs_b) or {}).get('status') == 'broadcast', s_release(txs_b))
            check('slip: the broadcasted fact names Slipstream as the method',
                  ((s_tx(txs_b) or {}).get('broadcasted') or {}).get('method') == 'slipstream', (s_tx(txs_b) or {}).get('broadcasted'))
            check('slip: the status is broadcasted once every armed tx is resolved',
                  s_status().get('state') == 'broadcasted', s_status().get('state'))
            # (f) MARA drops it: a new Slipstream tx is submitted,
            # then dropped — it becomes 'failed', the status stays
            # release-due, and the next evaluation retries it via
            # Slipstream (not the public nodes).
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=sbase)
            check('slip: check-in starts a new cycle', s == 200, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100802), 'label': 'S dropped', 'notes': '', 'broadcastVia': 'slipstream'}, base=sbase)
            txs_c = r['tx']['id']
            txs_c_txid = r['tx']['txid']
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: the dropped tx is submitted-slipstream first',
                  res.get(txs_c, {}).get('action') == 'submitted-slipstream', res.get(txs_c))
            s, r = req('POST', '/__test__/slipstream/drop', {'txid': txs_c_txid}, base=sstub)
            check('slip: the test endpoint drops the tx from MARA', s == 200, r)
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            check('slip: a dropped tx becomes failed',
                  (s_release(txs_c) or {}).get('status') == 'failed', s_release(txs_c))
            check('slip: the failed record names Slipstream as the method',
                  (s_release(txs_c) or {}).get('method') == 'slipstream', s_release(txs_c))
            check('slip: the status stays release-due while the dropped tx has a failed record',
                  s_status().get('state') == 'release-due', s_status().get('state'))
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: the next evaluation retries the dropped tx via Slipstream (submitted-slipstream again)',
                  res.get(txs_c, {}).get('action') == 'submitted-slipstream', res.get(txs_c))
            # (g) A check-in clears a 'submitted-slipstream' record
            # like any other cycle record — the card goes back to
            # Ready (the transaction is still in MARA's queue, and
            # a check-in cannot recall it; see GOAL.md).
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=sbase)
            check('slip: check-in succeeds', s == 200, r)
            check('slip: the check-in clears the submitted-slipstream record',
                  s_release(txs_c) is None, s_release(txs_c))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_c, {'enabled': False}, base=sbase)
            # (h) A Slipstream failure surfaces MARA's rejection
            # reason and keeps the tx 'release-due' for the hourly
            # retry. Restart the primary stub with the reject hook.
            stop(ss1)
            ss1 = start(['node', STUB, '18183'],
                        env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_SLIPSTREAM_REJECT': 'fee below the 2 sat/vB floor'})
            time.sleep(0.5)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100803), 'label': 'S rejected', 'notes': '', 'broadcastVia': 'slipstream'}, base=sbase)
            txs_d = r['tx']['id']
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: a rejected Slipstream submit fails (not submitted-slipstream)',
                  res.get(txs_d, {}).get('action') == 'failed', res.get(txs_d))
            check('slip: the rejection reason surfaces the fee floor',
                  '2 sat/vB' in (res.get(txs_d, {}).get('error') or ''), res.get(txs_d, {}).get('error'))
            check('slip: the failed record carries the reason',
                  '2 sat/vB' in ((s_release(txs_d) or {}).get('error') or ''), s_release(txs_d))
            check('slip: the status stays release-due after a Slipstream rejection',
                  s_status().get('state') == 'release-due', s_status().get('state'))
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_d, {'enabled': False}, base=sbase)
            # (i) No fallback: a public-route tx whose broadcast
            # fails does NOT go to Slipstream. Restart both stubs so
            # every public broadcast is rejected (200 'not-a-txid');
            # the Slipstream endpoint still accepts, so a fallback
            # would show up as 'submitted-slipstream'.
            stop(ss1)
            stop(ss2)
            ss1 = start(['node', STUB, '18183'], env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BAD_TXID': '1'})
            ss2 = start(['node', STUB, '18184'], env={'STUB_BAD_TXID': '1'})
            time.sleep(0.5)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=sbase)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100804), 'label': 'S public fail', 'notes': ''}, base=sbase)
            txs_e = r['tx']['id']
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('slip: a public tx that fails does NOT fall back to Slipstream (still failed)',
                  res.get(txs_e, {}).get('action') == 'failed', res.get(txs_e))
            check('slip: the failed public tx is not submitted-slipstream',
                  (s_release(txs_e) or {}).get('status') == 'failed', s_release(txs_e))
            check('slip: the failed public record method is primary (not slipstream)',
                  (s_release(txs_e) or {}).get('method') == 'primary', s_release(txs_e))
            check('slip: the status stays release-due when the public tx fails',
                  s_status().get('state') == 'release-due', s_status().get('state'))
            # (j) Pending exclusion + the manual public-broadcast
            # escape hatch (0.7.16, Pending card). Restart both
            # stubs clean, so public broadcasts and Slipstream
            # submits both work again. A public tx that just
            # broadcast (broadcasted fact, confirmations null) and
            # a Slipstream-pending tx are both PENDING — already out
            # the door — so Broadcast All and the release evaluation
            # must skip them, and only the manual escape hatch may
            # move the Slipstream one to the public route.
            stop(ss1)
            stop(ss2)
            ss1 = start(['node', STUB, '18183'], env={'SENTINEL_TXID': SENTINEL_TXID})
            ss2 = start(['node', STUB, '18184'])
            time.sleep(0.5)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=sbase)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100805), 'label': 'S escape', 'notes': '', 'broadcastVia': 'slipstream'}, base=sbase)
            txs_f = r['tx']['id']
            txs_f_txid = r['tx']['txid']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100806), 'label': 'S pubpend', 'notes': ''}, base=sbase)
            txs_g = r['tx']['id']
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('pend: the public tx broadcasts in the release',
                  res.get(txs_g, {}).get('action') == 'broadcast' and res.get(txs_g, {}).get('method') == 'primary', res.get(txs_g))
            check('pend: the Slipstream tx is submitted-slipstream',
                  res.get(txs_f, {}).get('action') == 'submitted-slipstream', res.get(txs_f))
            check('pend: the just-broadcast public tx has a broadcasted fact with confirmations null (pending, unconfirmed)',
                  bool((s_tx(txs_g) or {}).get('broadcasted'))
                  and (s_tx(txs_g) or {}).get('broadcasted', {}).get('confirmations') is None, (s_tx(txs_g) or {}).get('broadcasted'))
            check('pend: the Slipstream tx has NO broadcasted fact yet',
                  (s_tx(txs_f) or {}).get('broadcasted') is None, (s_tx(txs_f) or {}).get('broadcasted'))
            # Broadcast All skips both pending txs (with ids: the
            # call is rejected — nothing eligible; without ids:
            # neither is in the results).
            s, r = req('POST', '/api/broadcast/all', {'ids': [txs_g, txs_f]}, base=sbase)
            check('pend: Broadcast All with only pending ids is rejected (nothing to broadcast)',
                  s == 400 and 'archived or pending' in (r.get('error') or ''), r)
            s, r = req('POST', '/api/broadcast/all', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('pend: Broadcast All without ids does not attempt the public-pending tx',
                  txs_g not in res, sorted(res.keys()))
            check('pend: Broadcast All without ids does not attempt the Slipstream-pending tx',
                  txs_f not in res, sorted(res.keys()))
            # The release evaluation skips both too (the public one
            # as already broadcast, the Slipstream one as waiting on
            # MARA) — neither is re-attempted.
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('pend: the release skips the public-pending tx as already broadcast',
                  res.get(txs_g, {}).get('action') == 'skipped' and res.get(txs_g, {}).get('reason') == 'already broadcast', res.get(txs_g))
            check('pend: the release skips the Slipstream-pending tx as waiting on MARA',
                  res.get(txs_f, {}).get('action') == 'skipped' and 'Slipstream' in (res.get(txs_f, {}).get('reason') or ''), res.get(txs_f))
            check('pend: the Slipstream tx is still submitted-slipstream after both (no public fallback)',
                  (s_release(txs_f) or {}).get('status') == 'submitted-slipstream'
                  and (s_tx(txs_f) or {}).get('broadcasted') is None
                  and (s_tx(txs_f) or {}).get('broadcastVia') == 'slipstream', s_tx(txs_f))
            # The hex is locked on a Slipstream-pending tx too.
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_f, {'txHex': craft(1, 100807)}, base=sbase)
            check('pend: replacing the hex of a Slipstream-pending tx is rejected',
                  s == 400 and 'cannot be changed once it has been broadcast' in (r.get('error') or ''), r)
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_f, {'label': 'S escape renamed'}, base=sbase)
            check('pend: label on a Slipstream-pending tx is still allowed',
                  s == 200 and r.get('tx', {}).get('label') == 'S escape renamed', r)
            # The escape hatch: broadcast the Slipstream-pending tx
            # publicly, by hand. It goes out via the primary node,
            # the broadcasted fact is set, the stored route becomes
            # 'public', and the tx is public-pending (confirmations
            # null until the next confirmations refresh).
            s, r = req('POST', '/api/bitcoin/txs/' + txs_f + '/broadcast-public', {}, base=sbase)
            check('hatch: the escape hatch broadcasts the Slipstream-pending tx via the public route',
                  s == 200 and r.get('action') == 'broadcast' and r.get('method') == 'primary', r)
            check('hatch: the broadcasted fact is set (method primary)',
                  bool((s_tx(txs_f) or {}).get('broadcasted'))
                  and (s_tx(txs_f) or {}).get('broadcasted', {}).get('method') == 'primary', (s_tx(txs_f) or {}).get('broadcasted'))
            check('hatch: the stored route becomes public',
                  (s_tx(txs_f) or {}).get('broadcastVia') == 'public', (s_tx(txs_f) or {}).get('broadcastVia'))
            check('hatch: the release record is broadcast (the MARA wait is over)',
                  (s_release(txs_f) or {}).get('status') == 'broadcast', s_release(txs_f))
            check('hatch: the tx is public-pending (confirmations null until refreshed)',
                  (s_tx(txs_f) or {}).get('broadcasted', {}).get('confirmations') is None, (s_tx(txs_f) or {}).get('broadcasted'))
            s, r = req('GET', '/api/bitcoin/confirmations', base=sbase)
            conf = {c.get('id'): c for c in r.get('confirmations', [])}
            check('hatch: after a confirmations refresh the tx is 6 deep (confirmed, Archived in the UI)',
                  conf.get(txs_f, {}).get('confirmations') == 6, conf.get(txs_f))
            # The escape hatch rejects anything that is not
            # Slipstream-pending: a public-pending tx, an active tx,
            # and an unknown id.
            s, r = req('POST', '/api/bitcoin/txs/' + txs_g + '/broadcast-public', {}, base=sbase)
            check('hatch: a public-pending tx cannot use the escape hatch',
                  s == 400 and 'waiting on MARA' in (r.get('error') or ''), r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100807), 'label': 'S active', 'notes': ''}, base=sbase)
            txs_h = r['tx']['id']
            s, r = req('POST', '/api/bitcoin/txs/' + txs_h + '/broadcast-public', {}, base=sbase)
            check('hatch: an active tx cannot use the escape hatch',
                  s == 400 and 'waiting on MARA' in (r.get('error') or ''), r)
            s, r = req('POST', '/api/bitcoin/txs/tx_nope/broadcast-public', {}, base=sbase)
            check('hatch: unknown tx id -> 404', s == 404, r)
            # (k) A FAILED escape hatch leaves the tx
            # Slipstream-pending: restart both stubs so every public
            # broadcast is rejected (200 'not-a-txid'); the
            # Slipstream endpoint still accepts, so the tx can be
            # submitted to MARA first and then the public attempt
            # fails. No 'failed' record is written — MARA is still
            # holding the tx.
            s, r = req('PUT', '/api/bitcoin/txs/' + txs_h, {'enabled': False}, base=sbase)
            stop(ss1)
            stop(ss2)
            ss1 = start(['node', STUB, '18183'], env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BAD_TXID': '1'})
            ss2 = start(['node', STUB, '18184'], env={'STUB_BAD_TXID': '1'})
            time.sleep(0.5)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100808), 'label': 'S escfail', 'notes': '', 'broadcastVia': 'slipstream'}, base=sbase)
            txs_i = r['tx']['id']
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=sbase)
            s_backdate()
            s, r = req('POST', '/api/release/check', {}, base=sbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('hatch: the failing-escape tx is submitted-slipstream first',
                  res.get(txs_i, {}).get('action') == 'submitted-slipstream', res.get(txs_i))
            s, r = req('POST', '/api/bitcoin/txs/' + txs_i + '/broadcast-public', {}, base=sbase)
            check('hatch: a failed public attempt surfaces the error (action failed)',
                  s == 200 and r.get('action') == 'failed' and bool(r.get('error')), r)
            check('hatch: the failed escape leaves the tx Slipstream-pending (no failed record)',
                  (s_release(txs_i) or {}).get('status') == 'submitted-slipstream', s_release(txs_i))
            check('hatch: the failed escape writes no broadcasted fact and keeps the Slipstream route',
                  (s_tx(txs_i) or {}).get('broadcasted') is None
                  and (s_tx(txs_i) or {}).get('broadcastVia') == 'slipstream', s_tx(txs_i))
        finally:
            stop(app_s)
            stop(ss1)
            stop(ss2)

        # --- public fallback (0.7.17): the opt-in Slipstream timer ---
        # A Slipstream-route tx with a fallback duration (1/3/7/14/30/
        # 60/90 days; Never/null by default) is broadcast publicly if
        # it is not publicly visible within that time. The deadline
        # runs from when MARA first accepted it (release.submittedAt)
        # while it waits, or from the first Slipstream attempt
        # (slipstreamFirstAttemptAt) when the submit keeps failing.
        # The fallback is checked on the hourly tick and on a manual
        # release check, AFTER the MARA status refresh — it is the
        # only automatic public broadcast, and a check-in does not
        # cancel a due fallback (the deadline is anchored on
        # firstAttemptAt, which a check-in does not clear, so the
        # next tick re-evaluates the same past deadline). It never
        # fires for a tx that is already publicly visible (recognised
        # as broadcast instead), already broadcast, stale, disarmed,
        # or while paused — and Broadcast All never triggers it.
        fdata = '/tmp/heirloom094-fallback'
        fbase = 'http://127.0.0.1:3419'
        fstub = 'http://127.0.0.1:18187'
        shutil.rmtree(fdata, ignore_errors=True)
        fs1 = start(['node', STUB, '18187'], env={'SENTINEL_TXID': SENTINEL_TXID})
        fs2 = start(['node', STUB, '18188'])
        time.sleep(0.5)
        app_f = start(['node', 'server.js'],
                      env={'PORT': '3419', 'DATA_DIR': fdata, 'CHECKIN_DIR': fdata + '-checkin',
                           'SLIPSTREAM_API_URL': 'http://127.0.0.1:18187'},
                      cwd=APP)
        f_path = os.path.join(fdata, 'state.json')
        def f_status():
            s, st = req('GET', '/api/status', base=fbase)
            return st
        def f_backdate(days=100):
            stj = json.load(open(f_path))
            stj['checkin']['lastCheckinAt'] = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace('+00:00', 'Z')
            json.dump(stj, open(f_path, 'w'), indent=2)
        def f_tx(txid):
            s, st = req('GET', '/api/state', base=fbase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return tx[0] if tx else None
        def f_release(txid):
            tx = f_tx(txid)
            return tx.get('release') if tx else None
        def f_past(days):
            return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace('+00:00', 'Z')
        def f_set_submitted(txid, days):
            stj = json.load(open(f_path))
            for t in stj['bitcoin']['txs']:
                if t['id'] == txid:
                    t['release']['submittedAt'] = f_past(days)
            json.dump(stj, open(f_path, 'w'), indent=2)
        def f_set_first(txid, days):
            stj = json.load(open(f_path))
            for t in stj['bitcoin']['txs']:
                if t['id'] == txid:
                    t['slipstreamFirstAttemptAt'] = f_past(days)
            json.dump(stj, open(f_path, 'w'), indent=2)
        def f_log(txid):
            s, log = req('GET', '/api/broadcast/log', base=fbase)
            return [e for e in (log or []) if e.get('txid') == txid]
        try:
            check('fb: app up', wait_up(fbase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18187',
                        'secondaryApiUrl': 'http://127.0.0.1:18188'}, base=fbase)
            check('fb: endpoints set to stubs', s == 200, r)
            # (a) The fallback is stored on the record; the default
            # is null (Never) when omitted; PUT changes it; an
            # invalid value becomes null, never a 400; the import
            # path carries it too.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100900), 'label': 'F store7', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 7}, base=fbase)
            tx_fa = r['tx']['id']
            check('fb: adding with a 7-day fallback stores it',
                  s == 201 and r['tx'].get('publicFallbackDays') == 7, r.get('tx', {}).get('publicFallbackDays'))
            check('fb: a new tx has no first Slipstream attempt yet',
                  r['tx'].get('slipstreamFirstAttemptAt') is None, r['tx'].get('slipstreamFirstAttemptAt'))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100901), 'label': 'F default', 'notes': '',
                        'broadcastVia': 'slipstream'}, base=fbase)
            tx_fb_def = r['tx']['id']
            check('fb: adding without a fallback defaults to null (Never)',
                  s == 201 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100902), 'label': 'F bad5', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 5}, base=fbase)
            tx_fb5 = r['tx']['id']
            check('fb: an invalid fallback (5, not an offered duration) becomes null',
                  s == 201 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100903), 'label': 'F str7', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': '7'}, base=fbase)
            tx_fb_str = r['tx']['id']
            check('fb: a string fallback becomes null (only a number counts)',
                  s == 201 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100904), 'label': 'F zero', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 0}, base=fbase)
            tx_fb0 = r['tx']['id']
            check('fb: a 0-day fallback becomes null',
                  s == 201 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': craft(1, 100905), 'label': 'F import',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 3}, base=fbase)
            tx_fb_imp = r['tx']['id']
            check('fb: the import path stores the fallback too',
                  s == 201 and r['tx'].get('publicFallbackDays') == 3, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('PUT', '/api/bitcoin/txs/' + tx_fa, {'publicFallbackDays': 14}, base=fbase)
            check('fb: PUT changes the fallback to 14 days',
                  s == 200 and r['tx'].get('publicFallbackDays') == 14, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('PUT', '/api/bitcoin/txs/' + tx_fa, {'publicFallbackDays': 5}, base=fbase)
            check('fb: PUT with an invalid fallback becomes null',
                  s == 200 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            s, r = req('PUT', '/api/bitcoin/txs/' + tx_fa, {'publicFallbackDays': None}, base=fbase)
            check('fb: PUT with null turns the fallback off (Never)',
                  s == 200 and r['tx'].get('publicFallbackDays') is None, r.get('tx', {}).get('publicFallbackDays'))
            # The storage txs are disabled now, so the release checks
            # below only ever attempt the tx each sub-test adds.
            for tid in (tx_fa, tx_fb_def, tx_fb5, tx_fb_str, tx_fb0, tx_fb_imp):
                s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False}, base=fbase)
            # (b) A waiting tx past its deadline is broadcast
            # publicly. The deadline is anchored on submittedAt; a
            # check-in in between does NOT cancel it — the check-in
            # clears the submitted-slipstream record, but the
            # deadline is re-evaluated from firstAttemptAt (set on
            # the first attempt, never cleared), so the next tick
            # still fires.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100910), 'label': 'F waiting', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 7}, base=fbase)
            tx_fb = r['tx']['id']
            tx_fb_txid = r['tx']['txid']
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: the waiting tx is submitted-slipstream first',
                  res.get(tx_fb, {}).get('action') == 'submitted-slipstream', res.get(tx_fb))
            check('fb: the first Slipstream attempt is recorded on the tx',
                  bool((f_tx(tx_fb) or {}).get('slipstreamFirstAttemptAt')), (f_tx(tx_fb) or {}).get('slipstreamFirstAttemptAt'))
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            check('fb: before the deadline the tx is still waiting (no fallback)',
                  (f_release(tx_fb) or {}).get('status') == 'submitted-slipstream'
                  and (f_tx(tx_fb) or {}).get('broadcasted') is None, f_tx(tx_fb))
            f_set_submitted(tx_fb, 8)
            f_set_first(tx_fb, 8)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            check('fb: the check-in clears the submitted-slipstream record',
                  f_release(tx_fb) is None, f_release(tx_fb))
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: past the deadline the fallback fires (action broadcast)',
                  fbres.get(tx_fb, {}).get('action') == 'broadcast', fbres.get(tx_fb))
            check('fb: the fallback broadcasts via the primary node',
                  fbres.get(tx_fb, {}).get('method') == 'primary', fbres.get(tx_fb))
            check('fb: the fallback sets the broadcasted fact',
                  bool((f_tx(tx_fb) or {}).get('broadcasted')), (f_tx(tx_fb) or {}).get('broadcasted'))
            check('fb: the fallback sets the stored route to public',
                  (f_tx(tx_fb) or {}).get('broadcastVia') == 'public', (f_tx(tx_fb) or {}).get('broadcastVia'))
            check('fb: the fallback release record is broadcast',
                  (f_release(tx_fb) or {}).get('status') == 'broadcast', f_release(tx_fb))
            entries = [e for e in f_log(tx_fb_txid) if e.get('status') == 'broadcast']
            check('fb: the broadcast log entry notes it was a public fallback',
                  bool(entries) and 'Public fallback' in (entries[0].get('note') or ''), entries[0].get('note') if entries else entries)
            # (d) Never means never: a Slipstream tx with no
            # fallback stays waiting even 100 days past any timer.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100911), 'label': 'F never', 'notes': '',
                        'broadcastVia': 'slipstream'}, base=fbase)
            tx_never = r['tx']['id']
            # A new cycle first: (b)'s fallback left a 'broadcast'
            # record, which would read as status 'broadcasted' and
            # skip the release until a check-in clears it.
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: the Never tx is submitted-slipstream first',
                  res.get(tx_never, {}).get('action') == 'submitted-slipstream', res.get(tx_never))
            f_set_submitted(tx_never, 100)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            check('fb: with Never set the tx is still waiting 100 days later (no fallback)',
                  (f_release(tx_never) or {}).get('status') == 'submitted-slipstream'
                  and (f_tx(tx_never) or {}).get('broadcasted') is None
                  and (f_tx(tx_never) or {}).get('broadcastVia') == 'slipstream', f_tx(tx_never))
            s, r = req('PUT', '/api/bitcoin/txs/' + tx_never, {'enabled': False}, base=fbase)
            # (e) A tx whose Slipstream submit keeps failing falls
            # back from its FIRST attempt: the deadline is
            # firstAttemptAt + days, and the fallback fires even
            # though MARA never accepted it.
            stop(fs1)
            fs1 = start(['node', STUB, '18187'],
                        env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_SLIPSTREAM_REJECT': 'fee below the 2 sat/vB floor'})
            time.sleep(0.5)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100912), 'label': 'F failing', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 7}, base=fbase)
            tx_fail = r['tx']['id']
            tx_fail_txid = r['tx']['txid']
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: a rejected Slipstream submit fails (not submitted-slipstream)',
                  res.get(tx_fail, {}).get('action') == 'failed', res.get(tx_fail))
            check('fb: the failed attempt still records firstAttemptAt',
                  bool((f_tx(tx_fail) or {}).get('slipstreamFirstAttemptAt')), (f_tx(tx_fail) or {}).get('slipstreamFirstAttemptAt'))
            f_set_first(tx_fail, 8)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: a failing-submit tx past its first-attempt deadline falls back publicly',
                  fbres.get(tx_fail, {}).get('action') == 'broadcast', fbres.get(tx_fail))
            check('fb: the failing-submit fallback sets the broadcasted fact (method primary)',
                  bool((f_tx(tx_fail) or {}).get('broadcasted'))
                  and (f_tx(tx_fail) or {}).get('broadcasted', {}).get('method') == 'primary', (f_tx(tx_fail) or {}).get('broadcasted'))
            check('fb: the failing-submit fallback sets the stored route to public',
                  (f_tx(tx_fail) or {}).get('broadcastVia') == 'public', (f_tx(tx_fail) or {}).get('broadcastVia'))
            entries = [e for e in f_log(tx_fail_txid) if e.get('status') == 'broadcast']
            check('fb: the failing-submit fallback is logged as a public fallback',
                  bool(entries) and 'Public fallback' in (entries[0].get('note') or ''), entries[0].get('note') if entries else entries)
            stop(fs1)
            fs1 = start(['node', STUB, '18187'], env={'SENTINEL_TXID': SENTINEL_TXID})
            time.sleep(0.5)
            # (f) Already publicly visible: the normal visible path
            # marks the tx broadcast (method slipstream) BEFORE the
            # fallback runs — no public fallback broadcast happens.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100913), 'label': 'F visible', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 1}, base=fbase)
            tx_vis = r['tx']['id']
            tx_vis_txid = r['tx']['txid']
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: the visible tx is submitted-slipstream first',
                  res.get(tx_vis, {}).get('action') == 'submitted-slipstream', res.get(tx_vis))
            s, r = req('POST', '/__test__/slipstream/visible', {'txid': tx_vis_txid}, base=fstub)
            check('fb: the test endpoint marks the tx publicly visible', s == 200, r)
            f_set_submitted(tx_vis, 8)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: a publicly visible tx is broadcasted by the visible path (not the fallback)',
                  (f_release(tx_vis) or {}).get('status') == 'broadcast'
                  and ((f_tx(tx_vis) or {}).get('broadcasted') or {}).get('method') == 'slipstream', f_tx(tx_vis))
            check('fb: the visible tx keeps the Slipstream route (no fallback broadcast)',
                  (f_tx(tx_vis) or {}).get('broadcastVia') == 'slipstream', (f_tx(tx_vis) or {}).get('broadcastVia'))
            check('fb: the visible tx is 6 deep (confirmed, straight to Archived)',
                  ((f_tx(tx_vis) or {}).get('broadcasted') or {}).get('confirmations') == 6, (f_tx(tx_vis) or {}).get('broadcasted'))
            check('fb: the fallback list has no broadcast for the visible tx',
                  fbres.get(tx_vis, {}).get('action') != 'broadcast', fbres.get(tx_vis))
            entries = [e for e in f_log(tx_vis_txid) if e.get('status') == 'broadcast']
            check('fb: the visible tx log entry does not claim a public fallback',
                  bool(entries) and 'Public fallback' not in (entries[0].get('note') or ''), entries[0].get('note') if entries else entries)
            # (g) Stale: a Slipstream tx whose inputs are spent is
            # never broadcast — the fallback's freshness gate marks
            # it stale instead. The clock is on-track here, so only
            # the fallback runs (the release evaluation is skipped).
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(0, 100914), 'label': 'F stale', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 1}, base=fbase)
            tx_stale = r['tx']['id']
            stj = json.load(open(f_path))
            for t in stj['bitcoin']['txs']:
                if t['id'] == tx_stale:
                    t['slipstreamFirstAttemptAt'] = f_past(8)
                    t['release'] = {'status': 'failed', 'kind': 'release', 'txid': t['txid'],
                                    'method': 'slipstream', 'lastAttemptAt': f_past(8),
                                    'error': 'fee below the 2 sat/vB floor'}
            json.dump(stj, open(f_path, 'w'), indent=2)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            check('fb: with the clock on-track the release evaluation is skipped (only the fallback runs)',
                  r.get('action') == 'skipped', r.get('action'))
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: a stale tx is marked stale by the fallback, not broadcast',
                  fbres.get(tx_stale, {}).get('action') == 'stale', fbres.get(tx_stale))
            check('fb: the stale tx has a stale record and no broadcasted fact',
                  (f_release(tx_stale) or {}).get('status') == 'stale'
                  and (f_tx(tx_stale) or {}).get('broadcasted') is None, f_tx(tx_stale))
            # (h) A failed public fallback is retried on the next
            # tick: with both nodes rejecting the broadcast, the tx
            # stays Slipstream-pending (no 'failed' record — MARA
            # is still holding it); once the nodes answer again the
            # next tick broadcasts it publicly.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100915), 'label': 'F retry', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 1}, base=fbase)
            tx_retry = r['tx']['id']
            tx_retry_txid = r['tx']['txid']
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: the retry tx is submitted-slipstream first',
                  res.get(tx_retry, {}).get('action') == 'submitted-slipstream', res.get(tx_retry))
            f_set_submitted(tx_retry, 8)
            f_set_first(tx_retry, 8)
            stop(fs1)
            stop(fs2)
            fs1 = start(['node', STUB, '18187'], env={'SENTINEL_TXID': SENTINEL_TXID, 'STUB_BAD_TXID': '1'})
            fs2 = start(['node', STUB, '18188'], env={'STUB_BAD_TXID': '1'})
            time.sleep(0.5)
            # The restart wiped the stub's in-memory Slipstream queue,
            # so MARA would look like it dropped the tx — re-queue it
            # directly (STUB_BAD_TXID only breaks the public broadcast
            # POST /api/tx, not the Slipstream submit), so the tx
            # stays waiting and only the fallback can fail here.
            s, r = req('POST', '/api/transactions', {'tx_hex': craft(1, 100915)}, base=fstub)
            check('fb: the retry tx is re-queued on MARA after the stub restart', s == 200, r)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: a failed public fallback reports failed (not broadcast)',
                  fbres.get(tx_retry, {}).get('action') == 'failed', fbres.get(tx_retry))
            check('fb: the failed fallback leaves the tx Slipstream-pending (no failed record)',
                  (f_release(tx_retry) or {}).get('status') == 'submitted-slipstream', f_release(tx_retry))
            check('fb: the failed fallback writes no broadcasted fact and keeps the Slipstream route',
                  (f_tx(tx_retry) or {}).get('broadcasted') is None
                  and (f_tx(tx_retry) or {}).get('broadcastVia') == 'slipstream', f_tx(tx_retry))
            stop(fs1)
            stop(fs2)
            fs1 = start(['node', STUB, '18187'], env={'SENTINEL_TXID': SENTINEL_TXID})
            fs2 = start(['node', STUB, '18188'])
            time.sleep(0.5)
            # Re-queue again (same restart wipe as above), so the tx
            # is still waiting when the next tick retries the
            # fallback — the retry is from the waiting state, not
            # from a MARA-dropped 'failed' record.
            s, r = req('POST', '/api/transactions', {'tx_hex': craft(1, 100915)}, base=fstub)
            check('fb: the retry tx is re-queued on MARA after the clean restart', s == 200, r)
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: the next tick re-attempts the fallback and broadcasts publicly',
                  fbres.get(tx_retry, {}).get('action') == 'broadcast', fbres.get(tx_retry))
            check('fb: the retried fallback sets the broadcasted fact and the public route',
                  bool((f_tx(tx_retry) or {}).get('broadcasted'))
                  and (f_tx(tx_retry) or {}).get('broadcastVia') == 'public', f_tx(tx_retry))
            entries = [e for e in f_log(tx_retry_txid) if e.get('status') == 'broadcast']
            check('fb: the retried fallback is logged as a public fallback',
                  bool(entries) and 'Public fallback' in (entries[0].get('note') or ''), entries[0].get('note') if entries else entries)
            # (i) Restore carries the fallback field: a backup round
            # trip keeps the duration and the first-attempt time, and
            # an invalid value in a hand-edited backup restores as
            # null (Never).
            s, bak = req('GET', '/api/backup', base=fbase)
            check('fb: backup downloads', s == 200 and bak.get('format') == 'standby-backup', s)
            s, r = req('POST', '/api/restore', bak, base=fbase)
            check('fb: the backup restores', s == 200, r)
            restored = f_tx(tx_fb)
            check('fb: restore keeps the 7-day fallback',
                  (restored or {}).get('publicFallbackDays') == 7, (restored or {}).get('publicFallbackDays'))
            check('fb: restore keeps the first-attempt time',
                  bool((restored or {}).get('slipstreamFirstAttemptAt')), (restored or {}).get('slipstreamFirstAttemptAt'))
            restored5 = f_tx(tx_fb5)
            check('fb: restore keeps a null fallback null',
                  (restored5 or {}).get('publicFallbackDays') is None, (restored5 or {}).get('publicFallbackDays'))
            bak2 = json.loads(json.dumps(bak))
            for t in bak2['state']['bitcoin']['txs']:
                if t['id'] == tx_fb:
                    t['publicFallbackDays'] = 5
                    t['slipstreamFirstAttemptAt'] = 'garbage'
            s, r = req('POST', '/api/restore', bak2, base=fbase)
            check('fb: a hand-edited backup with an invalid fallback still restores', s == 200, r)
            restored2 = f_tx(tx_fb)
            check('fb: the invalid fallback in the backup restores as null',
                  (restored2 or {}).get('publicFallbackDays') is None, (restored2 or {}).get('publicFallbackDays'))
            check('fb: the unparseable first-attempt time in the backup restores as null',
                  (restored2 or {}).get('slipstreamFirstAttemptAt') is None, (restored2 or {}).get('slipstreamFirstAttemptAt'))
            # (j) Broadcast All never triggers the fallback: a
            # waiting tx past its deadline is excluded from Broadcast
            # All (with and without ids) and stays Slipstream-pending
            # — only the release evaluation's fallback moves it.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100916), 'label': 'F bcastall', 'notes': '',
                        'broadcastVia': 'slipstream', 'publicFallbackDays': 1}, base=fbase)
            tx_ba = r['tx']['id']
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=fbase)
            f_backdate()
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: the Broadcast All tx is submitted-slipstream first',
                  res.get(tx_ba, {}).get('action') == 'submitted-slipstream', res.get(tx_ba))
            f_set_submitted(tx_ba, 8)
            f_set_first(tx_ba, 8)
            s, r = req('POST', '/api/broadcast/all', {'ids': [tx_ba]}, base=fbase)
            check('fb: Broadcast All with only the waiting tx id is rejected (nothing to broadcast)',
                  s == 400 and 'archived or pending' in (r.get('error') or ''), r)
            s, r = req('POST', '/api/broadcast/all', {}, base=fbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('fb: Broadcast All without ids does not attempt the waiting tx',
                  tx_ba not in res, sorted(res.keys()))
            check('fb: Broadcast All leaves the tx Slipstream-pending (no fallback)',
                  (f_release(tx_ba) or {}).get('status') == 'submitted-slipstream'
                  and (f_tx(tx_ba) or {}).get('broadcasted') is None, f_tx(tx_ba))
            s, r = req('POST', '/api/release/check', {}, base=fbase)
            fbres = {x.get('id'): x for x in r.get('fallbacks', [])}
            check('fb: the release check after Broadcast All still fires the fallback',
                  fbres.get(tx_ba, {}).get('action') == 'broadcast', fbres.get(tx_ba))
            check('fb: the fallback after Broadcast All sets the public route',
                  (f_tx(tx_ba) or {}).get('broadcastVia') == 'public', (f_tx(tx_ba) or {}).get('broadcastVia'))
        finally:
            stop(app_f)
            stop(fs1)
            stop(fs2)

        # --- fee (0.7.18): stored at add time ---
        # The fee is sum(input prevout values) - totalOutSats, and
        # the rate is fee / vsize. The parent values come from the
        # node (GET /api/tx/:prevTxid) IN SATOSHIS, as the mempool
        # API returns them — the pre-fix code read them as BTC and
        # multiplied by 1e8, inflating the fee a hundred-million
        # fold (a 14,913-sat parent became 1,491,300,000,000 sats).
        # The lookup is best-effort — an unreachable node or an
        # unknown parent stores null and never blocks the add. A
        # dry-run OVERWRITES the stored fee with the freshly
        # computed one, and a restart recomputes every stored fee,
        # so a wrong stored fee self-corrects; restore carries the
        # fee through.
        edata = '/tmp/heirloom094-fee'
        ebase = 'http://127.0.0.1:3420'
        shutil.rmtree(edata, ignore_errors=True)
        es1 = start(['node', STUB, '18189'], env={'SENTINEL_TXID': SENTINEL_TXID})
        es2 = start(['node', STUB, '18190'])
        time.sleep(0.5)
        app_e = start(['node', 'server.js'],
                      env={'PORT': '3420', 'DATA_DIR': edata, 'CHECKIN_DIR': edata + '-checkin'},
                      cwd=APP)
        def e_tx(txid):
            s, st = req('GET', '/api/state', base=ebase)
            tx = [x for x in st.get('bitcoin', {}).get('txs', []) if x.get('id') == txid]
            return tx[0] if tx else None
        try:
            check('fee: app up', wait_up(ebase))
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18189',
                        'secondaryApiUrl': 'http://127.0.0.1:18190'}, base=ebase)
            # craft(1) spends Finney vout 1 (150,000 sats) with
            # 100,000 sats out: a 50,000-sat fee on an
            # 85-byte (85 vbyte) tx -> ~588.24 sat/vB.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1), 'label': 'E fee', 'notes': ''}, base=ebase)
            check('fee: add succeeds', s == 201, r)
            tx_e = r['tx']['id']
            check('fee: the fee is stored at add (50,000 sats)',
                  (r['tx'] or {}).get('feeSats') == 50000, r['tx'])
            check('fee: the rate is stored at add (~588.24 sat/vB)',
                  abs((r['tx'] or {}).get('feeRateSatVb') - 50000 / 85) < 0.01, r['tx'])
            # An unknown parent ('ff'*32) stores null and never
            # blocks the add.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_prev('ff' * 32, 0), 'label': 'E unknown', 'notes': ''}, base=ebase)
            check('fee: add with an unknown parent still succeeds', s == 201, r)
            tx_u = r['tx']['id']
            check('fee: the fee is null for an unknown parent',
                  (r['tx'] or {}).get('feeSats') is None and (r['tx'] or {}).get('feeRateSatVb') is None, r['tx'])
            # Backfill: wipe the fee on disk, then dry-run — the
            # dry-run talks to the node, so it restores the fee.
            epath = os.path.join(edata, 'state.json')
            stj = json.load(open(epath))
            for t in stj['bitcoin']['txs']:
                if t['id'] == tx_e:
                    t['feeSats'] = None
                    t['feeRateSatVb'] = None
            json.dump(stj, open(epath, 'w'), indent=2)
            check('fee: the fee is null after wiping it on disk',
                  (e_tx(tx_e) or {}).get('feeSats') is None, e_tx(tx_e))
            s, r = req('POST', '/api/broadcast/test', {'id': tx_e}, base=ebase)
            check('fee: the dry-run succeeds', s == 200, r)
            check('fee: the dry-run restores the fee (50,000 sats)',
                  (e_tx(tx_e) or {}).get('feeSats') == 50000, e_tx(tx_e))
            check('fee: the dry-run restores the rate (~588.24 sat/vB)',
                  abs((e_tx(tx_e) or {}).get('feeRateSatVb') - 50000 / 85) < 0.01, e_tx(tx_e))
            # Restore carries the fee through.
            s, b = req('GET', '/api/backup', base=ebase)
            check('fee: the backup carries the fee',
                  [t.get('feeSats') for t in b['state']['bitcoin']['txs'] if t['id'] == tx_e] == [50000],
                  [t.get('feeSats') for t in b['state']['bitcoin']['txs']])
            s, r = req('POST', '/api/restore', b, base=ebase)
            check('fee: the restore succeeds', s == 200, r)
            check('fee: the fee survives the restore',
                  (e_tx(tx_e) or {}).get('feeSats') == 50000, e_tx(tx_e))
            # Units (0.7.18 fee fix): the mempool /api/tx vout value
            # is in SATOSHIS, not BTC — the pre-fix code read it as
            # BTC and multiplied by 1e8, so a 200,000-sat parent
            # became 20,000,000,000,000 sats and the fee inflated a
            # hundred-million fold. A tx spending SECOND vout 0
            # (200,000 sats) with 199,776 out pays a 224-sat fee;
            # with the bug it would read 19,999,999,800,224.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft_prev(SECOND, 0, 199776), 'label': 'E units', 'notes': ''}, base=ebase)
            check('fee units: add succeeds', s == 201, r)
            check('fee units: the fee is 224 sats (parent value read as sats, not BTC)',
                  (r['tx'] or {}).get('feeSats') == 224, r['tx'])
            check('fee units: the rate is ~2.64 sat/vB (224 / 85 vbytes)',
                  abs((r['tx'] or {}).get('feeRateSatVb') - 224 / 85) < 0.01, r['tx'])
            # Self-correction 1 — dry-run overwrite: corrupt the
            # stored fee on disk to the value the units bug would
            # have produced for tx_e (parent 150,000 sats read as
            # BTC = 15,000,000,000,000, minus 100,000 out), then
            # dry-run — the dry-run recomputes the fee fresh and
            # OVERWRITES the stored one (not just backfilling a
            # null), so a wrong fee self-corrects.
            buggy = 150000 * 100000000 - 100000
            stj = json.load(open(epath))
            for t in stj['bitcoin']['txs']:
                if t['id'] == tx_e:
                    t['feeSats'] = buggy
                    t['feeRateSatVb'] = buggy / 85
            json.dump(stj, open(epath, 'w'), indent=2)
            check('fee correct: the stored fee is the buggy value before the dry-run',
                  (e_tx(tx_e) or {}).get('feeSats') == buggy, e_tx(tx_e))
            s, r = req('POST', '/api/broadcast/test', {'id': tx_e}, base=ebase)
            check('fee correct: the dry-run succeeds', s == 200, r)
            check('fee correct: the dry-run OVERWRITES the buggy stored fee (50,000 sats)',
                  (e_tx(tx_e) or {}).get('feeSats') == 50000, e_tx(tx_e))
            check('fee correct: the dry-run overwrites the buggy rate too (~588.24 sat/vB)',
                  abs((e_tx(tx_e) or {}).get('feeRateSatVb') - 50000 / 85) < 0.01, e_tx(tx_e))
            # Self-correction 2 — startup recompute: corrupt the
            # stored fee on disk again, RESTART the app (same data
            # dir — the settings persist, so the recompute can reach
            # the stubs), and poll until the stored fee is correct
            # again. This is the path that heals a wrong stored fee
            # on the next restart, with nobody re-adding the tx.
            stj = json.load(open(epath))
            for t in stj['bitcoin']['txs']:
                if t['id'] == tx_e:
                    t['feeSats'] = buggy
                    t['feeRateSatVb'] = buggy / 85
            json.dump(stj, open(epath, 'w'), indent=2)
            check('fee startup: the stored fee is the buggy value before the restart',
                  (e_tx(tx_e) or {}).get('feeSats') == buggy, e_tx(tx_e))
            stop(app_e)
            app_e = start(['node', 'server.js'],
                          env={'PORT': '3420', 'DATA_DIR': edata, 'CHECKIN_DIR': edata + '-checkin'},
                          cwd=APP)
            check('fee startup: app up after restart', wait_up(ebase))
            corrected = False
            for _ in range(40):
                time.sleep(0.5)
                if (e_tx(tx_e) or {}).get('feeSats') == 50000:
                    corrected = True
                    break
            check('fee startup: the restart recomputes the buggy stored fee (50,000 sats)', corrected, e_tx(tx_e))
            check('fee startup: the restart recomputes the buggy rate too (~588.24 sat/vB)',
                  abs((e_tx(tx_e) or {}).get('feeRateSatVb') - 50000 / 85) < 0.01, e_tx(tx_e))
            # The inputs/outputs detail (0.7.18 refinement): GET
            # /api/state derives it from the stored hex — never
            # stored, so the backup does NOT carry it (restore is
            # unaffected) and it appears for every tx, old or new.
            det = (e_tx(tx_e) or {}).get('detail')
            check('io detail: /api/state carries the inputs/outputs detail',
                  isinstance(det, dict), det)
            check('io detail: the input is the Finney outpoint (vout 1), value unknown at read time',
                  det and det.get('inputs') == [{'prevTxid': FINNEY, 'prevVout': 1, 'valueSats': None}], det)
            check('io detail: the output is 100,000 sats to the P2PKH all-zero address',
                  det and det.get('outputs') == [{'valueSats': '100000', 'address': '1111111111111111111114oLvT2', 'type': 'P2PKH'}], det)
            check('io detail: the backup does NOT carry the detail (it is derived, not stored)',
                  all('detail' not in t for t in b['state']['bitcoin']['txs']),
                  [t.get('detail', 'ABSENT') for t in b['state']['bitcoin']['txs']])
        finally:
            stop(app_e)
            stop(es1)
            stop(es2)

        # 0.7.22 — the offline-gap grace ("boot hold"). A dedicated
        # app (port 3383, its own data dir) so the backdated clock
        # here cannot touch the main app's state. The quarter (gap)
        # and half (clock) are read from the threshold, never
        # hardcoded: thr/4 is 8.75 days, thr/2 is 17.5 days on the
        # 35-day threshold.
        hdata = '/tmp/heirloom094-hold'
        hbase = 'http://127.0.0.1:3383'
        shutil.rmtree(hdata, ignore_errors=True)
        shutil.rmtree(hdata + '-checkin', ignore_errors=True)
        app_h = start(['node', 'server.js'],
                      env={'PORT': '3383', 'DATA_DIR': hdata, 'CHECKIN_DIR': hdata + '-checkin',
                           'FEE_RATES_URL': 'http://127.0.0.1:18160'}, cwd=APP)
        try:
            check('hold: app up', wait_up(hbase))
            # The release's input/broadcast checks must hit the
            # stubs, never the real mempool.space / blockstream.
            s, r = req('PUT', '/api/settings',
                       {'primaryApiUrl': 'http://127.0.0.1:18160',
                        'secondaryApiUrl': 'http://127.0.0.1:18161'}, base=hbase)
            check('hold: endpoints set to the stubs', s == 200, r)
            # An armed tx to prove the release does / does not fire.
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100201), 'label': 'H hold test', 'notes': ''}, base=hbase)
            txh = r['tx']['id']
            check('hold: tx added (armed by default)', s == 201 and r['tx'].get('enabled') is True, r)

            def h_state_file():
                return json.load(open(os.path.join(hdata, 'state.json')))
            def iso_ago(**kw):
                return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat().replace('+00:00', 'Z')
            def iso_ahead(**kw):
                return (datetime.now(timezone.utc) + timedelta(**kw)).isoformat().replace('+00:00', 'Z')
            def h_tx_by(tx_id):
                s, st = req('GET', '/api/state', base=hbase)
                for t in st.get('bitcoin', {}).get('txs', []):
                    if t['id'] == tx_id:
                        return t
                return None
            def set_clock(checkin_days, online_days):
                stj = h_state_file()
                stj['checkin']['lastCheckinAt'] = iso_ago(days=checkin_days)
                stj['checkin']['lastOnlineAt'] = iso_ago(days=online_days)
                stj['checkin']['heldUntil'] = None
                json.dump(stj, open(os.path.join(hdata, 'state.json'), 'w'), indent=2)
            def set_held(iso):
                stj = h_state_file()
                stj['checkin']['heldUntil'] = iso
                json.dump(stj, open(os.path.join(hdata, 'state.json'), 'w'), indent=2)
            def h_status():
                s, st = req('GET', '/api/status', base=hbase)
                return st
            def h_tx():
                s, st = req('GET', '/api/state', base=hbase)
                for t in st.get('bitcoin', {}).get('txs', []):
                    if t['id'] == txh:
                        return t
                return None

            # The startup tick (5 s after boot) records the "I was
            # online" stamp — poll, since the exact moment depends
            # on how fast the app came up.
            loa = None
            for _ in range(20):
                s, st = req('GET', '/api/state', base=hbase)
                loa = st.get('checkin', {}).get('lastOnlineAt')
                if loa:
                    break
                time.sleep(1)
            thr = st['settings']['thresholdDays']
            check('hold 0.7.22: the startup tick records lastOnlineAt (a recent ISO)',
                  isinstance(loa, str) and abs((datetime.now(timezone.utc) - datetime.fromisoformat(loa.replace('Z', '+00:00'))).total_seconds()) < 120, loa)
            check('hold 0.7.22: no hold on a fresh app',
                  st.get('checkin', {}).get('heldUntil') is None, st.get('checkin'))
            check('hold 0.7.22: the state carries the new check-in fields',
                  'lastOnlineAt' in st.get('checkin', {}) and 'heldUntil' in st.get('checkin', {}), st.get('checkin'))
            # Both conditions: gap 20d (> thr/4 = 8.75d) AND clock
            # 100d (> thr/2 = 17.5d). The original due is months in
            # the past — the hold must still be ~now + thr/2.
            before = datetime.now(timezone.utc)
            set_clock(100, 20)
            st = h_status()
            exp_due = before + timedelta(days=thr / 2)
            due_dt = datetime.fromisoformat(st['nextDue'].replace('Z', '+00:00')) if st.get('nextDue') else None
            check('hold 0.7.22: long outage + far clock -> state held',
                  st.get('state') == 'held', st)
            check('hold 0.7.22: long outage + far clock -> label Grace period',
                  st.get('label') == 'Grace period', st)
            check('hold 0.7.22: heldUntil is ~now + threshold/2 (measured from now, not the original due)',
                  due_dt is not None and abs((due_dt - exp_due).total_seconds()) < 300, (st.get('nextDue'), exp_due.isoformat()))
            check('hold 0.7.22: nextDue is the held date',
                  st.get('nextDue') == h_state_file()['checkin']['heldUntil'], (st.get('nextDue'), h_state_file()['checkin']['heldUntil']))
            check('hold 0.7.22: the held window is longer than the threshold',
                  isinstance(st.get('windowDays'), (int, float)) and st['windowDays'] > thr, st.get('windowDays'))
            check('hold 0.7.22: the held window is ~117.5 days (100 elapsed + 17.5 grace)',
                  abs(st.get('windowDays', 0) - 117.5) <= 1, st.get('windowDays'))
            # The release must NOT fire while the hold is active.
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('hold 0.7.22: the release does NOT fire while the hold is active',
                  r.get('action') == 'skipped' and 'held' in (r.get('reason') or ''), r)
            check('hold 0.7.22: the tx is still not broadcast while held',
                  not (h_tx() or {}).get('broadcasted'), h_tx())
            check('hold 0.7.22: the release check reports the held status',
                  (r.get('status') or {}).get('state') == 'held', r.get('status'))
            # Gap small (1d < 8.75d) even though the clock is far
            # along (20d > 17.5d): no hold.
            set_clock(20, 1)
            st = h_status()
            check('hold 0.7.22: small gap (1d) + far clock (20d) -> no hold, on-track',
                  st.get('state') == 'on-track', st)
            check('hold 0.7.22: small gap -> heldUntil stays null',
                  h_state_file()['checkin']['heldUntil'] is None, h_state_file()['checkin'])
            check('hold 0.7.22: small gap -> nextDue is the original due (lastCheckinAt + threshold)',
                  abs((datetime.fromisoformat(st['nextDue'].replace('Z', '+00:00')) - datetime.fromisoformat(st['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds() - thr * 86400) < 2, st)
            # Clock short (10d < 17.5d) even with a big gap (20d >
            # 8.75d): no hold.
            set_clock(10, 20)
            st = h_status()
            check('hold 0.7.22: big gap (20d) + short clock (10d) -> no hold, on-track',
                  st.get('state') == 'on-track', st)
            check('hold 0.7.22: short clock -> heldUntil stays null',
                  h_state_file()['checkin']['heldUntil'] is None, h_state_file()['checkin'])
            # A check-in clears the hold.
            set_clock(100, 20)
            st = h_status()
            check('hold 0.7.22: hold re-set for the clear test', st.get('state') == 'held', st)
            s, r = req('POST', '/api/checkin', {'method': 'app'}, base=hbase)
            check('hold 0.7.22: check-in lands', s == 200 and r.get('ok') is True, r)
            st = h_status()
            check('hold 0.7.22: a check-in clears heldUntil (back to on-track)',
                  st.get('state') == 'on-track' and h_state_file()['checkin']['heldUntil'] is None, (st, h_state_file()['checkin']))
            check('hold 0.7.22: the check-in also resets the clock (daysSince 0)',
                  st.get('daysSince') == 0, st)
            # The hold persists across a restart and is NOT
            # re-timed: the restart's tick sees an active hold and
            # leaves heldUntil exactly as it was.
            set_clock(100, 20)
            st = h_status()
            held_before = h_state_file()['checkin']['heldUntil']
            check('hold 0.7.22: hold set before the restart', st.get('state') == 'held' and held_before is not None, (st, held_before))
            stop(app_h)
            app_h = start(['node', 'server.js'],
                          env={'PORT': '3383', 'DATA_DIR': hdata, 'CHECKIN_DIR': hdata + '-checkin',
                               'FEE_RATES_URL': 'http://127.0.0.1:18160'}, cwd=APP)
            check('hold 0.7.22: app up after the restart', wait_up(hbase))
            # Let the startup tick (5 s) run — it refreshes
            # lastOnlineAt but must not re-time the hold.
            time.sleep(7)
            st = h_status()
            held_after = h_state_file()['checkin']['heldUntil']
            check('hold 0.7.22: the hold survives a restart (still held)',
                  st.get('state') == 'held', st)
            check('hold 0.7.22: the hold is NOT re-timed by the restart (same heldUntil)',
                  held_after == held_before, (held_before, held_after))
            check('hold 0.7.22: the restart tick refreshed lastOnlineAt (recent)',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(h_state_file()['checkin']['lastOnlineAt'].replace('Z', '+00:00'))).total_seconds()) < 120, h_state_file()['checkin']['lastOnlineAt'])
            # After the hold expires, the release fires: the clock
            # is still 100 days back, the hold is in the past, and
            # the app has been running (lastOnlineAt fresh), so the
            # gap is small and the hold is not re-set.
            set_clock(100, 0)
            set_held(iso_ago(hours=1))
            st = h_status()
            check('hold 0.7.22: an expired hold + fresh lastOnlineAt -> release-due',
                  st.get('state') == 'release-due', st)
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            res = {x.get('id'): x for x in r.get('results', [])}
            check('hold 0.7.22: the release fires once the hold has expired',
                  res.get(txh, {}).get('action') == 'broadcast' and res.get(txh, {}).get('method') == 'primary', res)
            check('hold 0.7.22: the tx is broadcasted after the hold expires',
                  bool((h_tx() or {}).get('broadcasted')), h_tx())
            # 0.7.22 — a restore refreshes the check-in clock (it
            # counts as a check-in: the owner is present). Remove
            # the broadcasted tx first: a broadcasted tx makes the
            # status 'broadcasted' (a broadcast went out this
            # cycle), and the restore test wants to see the clock's
            # own state — on-track. Then take a backup, backdate
            # its clock to 90 days (past due on a 30-day threshold)
            # with a stale lastOnlineAt and a pending hold, and
            # restore it: the clock must come back as now, not the
            # backup's 90 days. A fresh armed tx rides along so the
            # "does not fire" assertion is meaningful.
            s, r = req('DELETE', '/api/bitcoin/txs/' + txh, base=hbase)
            check('restore-refresh: the broadcasted tx is removed (so the clock state is its own)', s == 200 and r.get('removed') == txh, r)
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100202), 'label': 'R restore test', 'notes': ''}, base=hbase)
            txr = r['tx']['id']
            check('restore-refresh: a second armed tx rides along', s == 201, r)
            s, bak = req('GET', '/api/backup', base=hbase)
            bak_total = bak['state']['checkin']['totalCheckins']
            bak['state']['checkin']['lastCheckinAt'] = iso_ago(days=90)
            bak['state']['checkin']['lastOnlineAt'] = iso_ago(days=90)
            bak['state']['checkin']['heldUntil'] = iso_ahead(days=5)
            bak['state']['settings']['thresholdDays'] = 30
            s, r = req('POST', '/api/restore', bak, base=hbase)
            check('restore-refresh: restore lands', s == 200 and r.get('ok') is True, r)
            ck = r.get('state', {}).get('checkin', {})
            check('restore-refresh: lastCheckinAt is the restore moment (within seconds of now), not the backup\'s 90 days',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(ck.get('lastCheckinAt', '').replace('Z', '+00:00'))).total_seconds()) < 10, ck)
            check('restore-refresh: totalCheckins is the backup count + 1',
                  ck.get('totalCheckins') == bak_total + 1, (ck.get('totalCheckins'), bak_total))
            check('restore-refresh: heldUntil is null (no hold — the clock is fresh)',
                  ck.get('heldUntil') is None, ck)
            check('restore-refresh: lastOnlineAt is the restore moment too',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(ck.get('lastOnlineAt', '').replace('Z', '+00:00'))).total_seconds()) < 10, ck)
            check('restore-refresh: the backup\'s pending hold is cleared by the restore',
                  h_state_file()['checkin']['heldUntil'] is None, h_state_file()['checkin'])
            # The release must not fire right after the restore (the
            # clock is fresh — on-track on the 30-day threshold).
            st = h_status()
            check('restore-refresh: after the restore the state is on-track (30-day threshold)',
                  st.get('state') == 'on-track', st)
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('restore-refresh: a release evaluation right after does NOT fire',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('restore-refresh: the armed tx is still not broadcast after the release check',
                  not (h_tx_by(txr) or {}).get('broadcasted'), h_tx_by(txr))
            s, cins = req('GET', '/api/checkins', base=hbase)
            check('restore-refresh: the restore is recorded in the check-in history (method restore, most recent)',
                  cins and cins[0].get('method') == 'restore', cins[0] if cins else cins)
            # (b) A backup with a recent clock still refreshes to
            # now on restore — the restore moment wins either way.
            s, bak2 = req('GET', '/api/backup', base=hbase)
            bak2['state']['checkin']['lastCheckinAt'] = iso_ago(hours=2)
            bak2_total = bak2['state']['checkin']['totalCheckins']
            s, r = req('POST', '/api/restore', bak2, base=hbase)
            check('restore-refresh: restore of a recent-clock backup lands', s == 200 and r.get('ok') is True, r)
            ck2 = r.get('state', {}).get('checkin', {})
            check('restore-refresh: a recent clock still refreshes to now on restore',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(ck2.get('lastCheckinAt', '').replace('Z', '+00:00'))).total_seconds()) < 10, ck2)
            check('restore-refresh: totalCheckins increments again on the second restore',
                  ck2.get('totalCheckins') == bak2_total + 1, (ck2.get('totalCheckins'), bak2_total))
            check('restore-refresh: heldUntil stays null on the second restore',
                  ck2.get('heldUntil') is None, ck2)
            # 0.7.22 — threshold shortening: a shorten that would
            # make the release immediately due resets the check-in
            # instead of letting it fire. Clock 20 days back on the
            # 30-day threshold (due in 10 days); shorten to 7 and
            # the new due is 13 days ago.
            set_clock(20, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_a = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/settings', {'thresholdDays': 7}, base=hbase)
            check('threshold-reset: a shorten past due returns checkinReset: true',
                  s == 200 and r.get('checkinReset') is True and r.get('thresholdDays') == 7, r)
            st = h_state_file()
            check('threshold-reset: lastCheckinAt is reset to now (within seconds)',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('threshold-reset: totalCheckins incremented',
                  st['checkin']['totalCheckins'] == tot_a + 1, (st['checkin']['totalCheckins'], tot_a))
            check('threshold-reset: heldUntil is null after the reset',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            check('threshold-reset: lastOnlineAt is reset to now too',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastOnlineAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            st_s = h_status()
            check('threshold-reset: after the reset the state is on-track (7-day threshold)',
                  st_s.get('state') == 'on-track', st_s)
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('threshold-reset: a release evaluation right after the reset does NOT fire',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('threshold-reset: the armed tx is still not broadcast after the release check',
                  not (h_tx_by(txr) or {}).get('broadcasted'), h_tx_by(txr))
            s, cins = req('GET', '/api/checkins', base=hbase)
            check('threshold-reset: the reset is recorded in the check-in history (method threshold-reset, most recent)',
                  cins and cins[0].get('method') == 'threshold-reset', cins[0] if cins else cins)
            # (b) A shorten that leaves the new due well outside
            # the zone does NOT reset. Clock 2 days back on the
            # 7-day threshold; shorten to 6 and the new due is 4
            # days out — more than 25% of the new 6-day window
            # (1.5 days) away.
            set_clock(2, 0)
            s, st = req('GET', '/api/state', base=hbase)
            before_b = st['checkin']['lastCheckinAt']
            tot_b = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/settings', {'thresholdDays': 6}, base=hbase)
            check('threshold-reset: a shorten that leaves the new due outside the zone returns no reset flag',
                  s == 200 and r.get('checkinReset') is None and r.get('thresholdDays') == 6, r)
            st = h_state_file()
            check('threshold-reset: the clock is untouched when the new due is outside the zone',
                  st['checkin']['lastCheckinAt'] == before_b, (st['checkin']['lastCheckinAt'], before_b))
            check('threshold-reset: totalCheckins is untouched too',
                  st['checkin']['totalCheckins'] == tot_b, (st['checkin']['totalCheckins'], tot_b))
            # (c) A shorten that lands the new due inside 25% of
            # the NEW threshold resets — even though the new due is
            # still in the future. Clock 20 days back; shorten to
            # 25 and the new due is 5 days out — inside 25% of the
            # new 25-day window (6.25 days).
            set_clock(20, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_c2 = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/settings', {'thresholdDays': 25}, base=hbase)
            check('threshold-reset: a shorten landing the new due inside 25% of the new threshold returns checkinReset: true',
                  s == 200 and r.get('checkinReset') is True and r.get('thresholdDays') == 25, r)
            st = h_state_file()
            check('threshold-reset: lastCheckinAt is reset to now by the inside-zone shorten',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('threshold-reset: totalCheckins incremented by the inside-zone shorten',
                  st['checkin']['totalCheckins'] == tot_c2 + 1, (st['checkin']['totalCheckins'], tot_c2))
            check('threshold-reset: heldUntil is null after the inside-zone shorten',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            # (d) Lengthening the threshold never resets the clock
            # (the new due is 35 days out — far outside the zone).
            # The threshold is now 35 for the arm boundary tests.
            s, st = req('GET', '/api/state', base=hbase)
            before_c = st['checkin']['lastCheckinAt']
            tot_c = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/settings', {'thresholdDays': 35}, base=hbase)
            check('threshold-reset: lengthening returns no reset flag',
                  s == 200 and r.get('checkinReset') is None and r.get('thresholdDays') == 35, r)
            st = h_state_file()
            check('threshold-reset: the clock is untouched when the threshold is lengthened',
                  st['checkin']['lastCheckinAt'] == before_c, (st['checkin']['lastCheckinAt'], before_c))
            check('threshold-reset: totalCheckins is untouched when lengthening',
                  st['checkin']['totalCheckins'] == tot_c, (st['checkin']['totalCheckins'], tot_c))
            # 0.7.22 — arming while release-due: the next tick would
            # broadcast a newly armed tx, so arming resets the
            # check-in instead. (a) Disarm R while on-track (no
            # reset), back the clock to release-due, then arm it.
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': False}, base=hbase)
            check('arm-reset: disarming while on-track does not reset',
                  s == 200 and r.get('checkinReset') is None, r)
            set_clock(40, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_arm = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': True}, base=hbase)
            check('arm-reset: arming a disarmed live tx while release-due returns checkinReset: true',
                  s == 200 and r.get('checkinReset') is True and r.get('tx', {}).get('enabled') is True, r)
            st = h_state_file()
            check('arm-reset: lastCheckinAt is reset to now (within seconds)',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('arm-reset: totalCheckins incremented',
                  st['checkin']['totalCheckins'] == tot_arm + 1, (st['checkin']['totalCheckins'], tot_arm))
            check('arm-reset: heldUntil is null after the reset',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            st_s = h_status()
            check('arm-reset: after the reset the state is on-track',
                  st_s.get('state') == 'on-track', st_s)
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('arm-reset: a release evaluation right after the reset does NOT broadcast the tx',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('arm-reset: the armed tx is still not broadcast after the release check',
                  not (h_tx_by(txr) or {}).get('broadcasted'), h_tx_by(txr))
            s, cins = req('GET', '/api/checkins', base=hbase)
            check('arm-reset: the reset is recorded in the check-in history (method arm-reset, most recent)',
                  cins and cins[0].get('method') == 'arm-reset', cins[0] if cins else cins)
            # (b) Arming outside the danger zone does NOT reset.
            # 20 days back on the 35-day threshold: 15 days left
            # (~43% of the window) — well outside the 25% zone.
            # Disarm R again, back the clock, then arm it.
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': False}, base=hbase)
            check('arm-reset: disarm for the outside-zone test lands', s == 200, r)
            set_clock(20, 0)
            s, st = req('GET', '/api/state', base=hbase)
            before_on = st['checkin']['lastCheckinAt']
            tot_on = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': True}, base=hbase)
            check('arm-reset: arming outside the danger zone (20d back, 15d left) returns no reset flag',
                  s == 200 and r.get('checkinReset') is None, r)
            st = h_state_file()
            check('arm-reset: the clock is untouched when arming outside the zone',
                  st['checkin']['lastCheckinAt'] == before_on, (st['checkin']['lastCheckinAt'], before_on))
            check('arm-reset: totalCheckins is untouched when arming outside the zone',
                  st['checkin']['totalCheckins'] == tot_on, (st['checkin']['totalCheckins'], tot_on))
            # (b2) Arming inside the danger zone but not yet due
            # DOES reset. 30 days back on the 35-day threshold:
            # 5 days left (~14% of the window) — inside the 25%
            # zone. Disarm R again, back the clock, then arm it.
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': False}, base=hbase)
            check('arm-reset: disarm for the inside-zone test lands', s == 200, r)
            set_clock(30, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_in = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': True}, base=hbase)
            check('arm-reset: arming inside the danger zone (30d back, 5d left) returns checkinReset: true',
                  s == 200 and r.get('checkinReset') is True and r.get('tx', {}).get('enabled') is True, r)
            st = h_state_file()
            check('arm-reset: lastCheckinAt is reset to now by the inside-zone arm',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('arm-reset: totalCheckins incremented by the inside-zone arm',
                  st['checkin']['totalCheckins'] == tot_in + 1, (st['checkin']['totalCheckins'], tot_in))
            check('arm-reset: heldUntil is null after the inside-zone arm',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            # (c) Disarming while release-due does NOT reset.
            set_clock(40, 0)
            s, st = req('GET', '/api/state', base=hbase)
            before_dis = st['checkin']['lastCheckinAt']
            tot_dis = st['checkin']['totalCheckins']
            s, r = req('PUT', '/api/bitcoin/txs/' + txr, {'enabled': False}, base=hbase)
            check('arm-reset: disarming while release-due returns no reset flag',
                  s == 200 and r.get('checkinReset') is None, r)
            st = h_state_file()
            check('arm-reset: the clock is untouched when disarming while release-due',
                  st['checkin']['lastCheckinAt'] == before_dis, (st['checkin']['lastCheckinAt'], before_dis))
            check('arm-reset: totalCheckins is untouched when disarming while release-due',
                  st['checkin']['totalCheckins'] == tot_dis, (st['checkin']['totalCheckins'], tot_dis))
            # (d) Adding a new tx while release-due resets the clock
            # too (a new tx is armed by default), and the new tx
            # does not fire on the next evaluation.
            s, st = req('GET', '/api/state', base=hbase)
            tot_add = st['checkin']['totalCheckins']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100203), 'label': 'A add while due', 'notes': ''}, base=hbase)
            txa = r['tx']['id']
            check('arm-reset: adding a new tx while release-due returns checkinReset: true',
                  s == 201 and r.get('checkinReset') is True and r['tx'].get('enabled') is True, r)
            st = h_state_file()
            check('arm-reset: lastCheckinAt is reset to now by the add (within seconds)',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('arm-reset: totalCheckins incremented by the add',
                  st['checkin']['totalCheckins'] == tot_add + 1, (st['checkin']['totalCheckins'], tot_add))
            check('arm-reset: heldUntil is null after the add reset',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('arm-reset: the new tx does not fire on the next evaluation after the add reset',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('arm-reset: the new tx is still not broadcast after the release check',
                  not (h_tx_by(txa) or {}).get('broadcasted'), h_tx_by(txa))
            s, cins = req('GET', '/api/checkins', base=hbase)
            check('arm-reset: the add reset is recorded in the check-in history (method add-reset, most recent)',
                  cins and cins[0].get('method') == 'add-reset', cins[0] if cins else cins)
            # (e) Adding while inside the danger zone but not yet
            # due resets too. 30 days back on the 35-day threshold
            # (5 days left, ~14%) — inside the 25% zone.
            set_clock(30, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_add2 = st['checkin']['totalCheckins']
            s, r = req('POST', '/api/bitcoin/txs',
                       {'txHex': craft(1, 100204), 'label': 'A add in zone', 'notes': ''}, base=hbase)
            txa2 = r['tx']['id']
            check('arm-reset: adding a new tx inside the danger zone (30d back, 5d left) returns checkinReset: true',
                  s == 201 and r.get('checkinReset') is True and r['tx'].get('enabled') is True, r)
            st = h_state_file()
            check('arm-reset: lastCheckinAt is reset to now by the inside-zone add',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('arm-reset: totalCheckins incremented by the inside-zone add',
                  st['checkin']['totalCheckins'] == tot_add2 + 1, (st['checkin']['totalCheckins'], tot_add2))
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('arm-reset: the inside-zone add does not fire on the next evaluation',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('arm-reset: the inside-zone add tx is still not broadcast',
                  not (h_tx_by(txa2) or {}).get('broadcasted'), h_tx_by(txa2))
            # (f) Importing a tx inside the danger zone resets the
            # clock too (an imported tx is armed by default), and
            # the imported tx does not fire on the next evaluation.
            # 30 days back on the 35-day threshold (5 days left,
            # ~14%) — inside the 25% zone.
            set_clock(30, 0)
            s, st = req('GET', '/api/state', base=hbase)
            tot_imp = st['checkin']['totalCheckins']
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': craft(1, 100205), 'label': 'I import in zone', 'notes': ''}, base=hbase)
            txi = r['tx']['id']
            check('import-reset: importing a new tx inside the danger zone (30d back, 5d left) returns checkinReset: true',
                  s == 201 and r.get('checkinReset') is True and r['tx'].get('enabled') is True, r)
            st = h_state_file()
            check('import-reset: lastCheckinAt is reset to now by the inside-zone import',
                  abs((datetime.now(timezone.utc) - datetime.fromisoformat(st['checkin']['lastCheckinAt'].replace('Z', '+00:00'))).total_seconds()) < 10, st['checkin'])
            check('import-reset: totalCheckins incremented by the inside-zone import',
                  st['checkin']['totalCheckins'] == tot_imp + 1, (st['checkin']['totalCheckins'], tot_imp))
            check('import-reset: heldUntil is null after the inside-zone import',
                  st['checkin']['heldUntil'] is None, st['checkin'])
            s, r = req('POST', '/api/release/check', {}, base=hbase)
            check('import-reset: the inside-zone import does not fire on the next evaluation',
                  r.get('action') == 'skipped' and 'on-track' in (r.get('reason') or ''), r)
            check('import-reset: the inside-zone import tx is still not broadcast',
                  not (h_tx_by(txi) or {}).get('broadcasted'), h_tx_by(txi))
            s, cins = req('GET', '/api/checkins', base=hbase)
            check('import-reset: the import reset is recorded in the check-in history (method add-reset, most recent)',
                  cins and cins[0].get('method') == 'add-reset', cins[0] if cins else cins)
            # (g) Importing outside the danger zone does NOT reset.
            # 20 days back on the 35-day threshold: 15 days left
            # (~43% of the window) — well outside the 25% zone.
            set_clock(20, 0)
            s, st = req('GET', '/api/state', base=hbase)
            before_imp = st['checkin']['lastCheckinAt']
            tot_imp2 = st['checkin']['totalCheckins']
            s, r = req('POST', '/api/bitcoin/txs/import',
                       {'format': 'hex', 'data': craft(1, 100206), 'label': 'I import outside zone', 'notes': ''}, base=hbase)
            check('import-reset: importing outside the danger zone (20d back, 15d left) returns no reset flag',
                  s == 201 and r.get('checkinReset') is None, r)
            st = h_state_file()
            check('import-reset: the clock is untouched when importing outside the zone',
                  st['checkin']['lastCheckinAt'] == before_imp, (st['checkin']['lastCheckinAt'], before_imp))
            check('import-reset: totalCheckins is untouched when importing outside the zone',
                  st['checkin']['totalCheckins'] == tot_imp2, (st['checkin']['totalCheckins'], tot_imp2))
        finally:
            stop(app_h)
    finally:
        for p in list(procs):
            stop(p)

    print()
    print('FAILURES: %d %s' % (len(failures), failures if failures else '(none)'))


if __name__ == '__main__':
    main()
