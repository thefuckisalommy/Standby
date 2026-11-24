#!/usr/bin/env python3
"""Launch Standby 0.8.11 (branch-0811-secure-defaults) + mempool stubs with
seeded trigger data, run dom_check099.js against it, then stop
everything. Reuses the verify script's helpers (importing it does
not run its main()).

Ports (must not collide with 095, which uses app 3388, receiver
3389 and stubs 18175/18176, or 096, which uses app 3398, receiver
3399 and stubs 18185/18186): app 3478, receiver 3479, stubs
18275 (primary) and 18276 (secondary). The stub's default BTC price
is $98,200 (STUB_PRICE_USD unset), so the seeded price rule
(BTC >= $150,000) does not hold and its state line reads
"currently $98,200". The stub's tip height is 900,000 and its
economy fee is 1 sat/vB, so the seeded block-height rule (950,000)
watches and the seeded fee-market rule (0.5 sat/vB) watches.

Seeds (one armed tx per trigger type, all spending Finney vout 1
with distinct values): 'Dom Check-in' (trigger omitted -> the
check-in default), 'Dom Price' (price >= $150,000), 'Dom UTXO'
(outpoint f4184fc5...e16:1, unspent), 'Dom Manual' (manual only),
'Dom Blockheight' (target 950,000), 'Dom Setdate' (30 days out),
'Dom Feemarket' (max 0.5 sat/vB). Then a connection test, one
check-in, and one POST /api/release/check so the trigger subcards
show live statuses before the DOM script runs.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location('v70', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verify094.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

# Portability (0.8.3, tests-in-repo): resolve paths from this file.
# _ROOT is the goal dir locally and the repo root in a checkout; the
# app is branch-0.8.8-nonrpc/ locally and standby/ in a checkout.
_TESTDIR = os.path.dirname(os.path.abspath(__file__))
GOAL = os.path.dirname(_TESTDIR)
BRANCH = v.app_dir(GOAL)
TESTDIR = _TESTDIR
DATA = '/tmp/heirloom099-dom'
CHECKIN_DIR = '/tmp/heirloom099-dom-checkin'
BASE = 'http://127.0.0.1:3478'
RBASE = 'http://127.0.0.1:3479'
LOG = '/tmp/heirloom099-dom-proc.log'
FINNEY_OUTPOINT = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16:1'

# (0.8.11, secure defaults) Profile dimension, same as the API and
# regression suites: STANDBY_TEST_PROFILE=umbrel runs the app and
# receiver with STANDBY_BIND=0.0.0.0 and STANDBY_ALLOWED_HOSTS set
# (the ${APP_DOMAIN} equivalent); the default profile runs the code
# defaults (loopback bind, no allowlist). CI invokes the launcher
# once per profile.


_PROFILE_ENV = {}
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    _PROFILE_ENV = {'STANDBY_BIND': '0.0.0.0', 'STANDBY_ALLOWED_HOSTS': 'standby.local'}


def _with_profile(env):
    d = dict(env)
    d.update(_PROFILE_ENV)
    return d


def port_closed(port):
    # True only when nothing answers at all: an HTTP error (even a
    # 404 from a stub) means the port is still open.
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/health' % port, timeout=2) as resp:
            resp.read()
        return False
    except urllib.error.HTTPError:
        return False
    except Exception:
        return True


shutil.rmtree(DATA, ignore_errors=True)
shutil.rmtree(CHECKIN_DIR, ignore_errors=True)
# Fee-history seed (0.8.9, accumulated peak): the fee-pill checks
# need a served peak of 2.0 sat/vB, and a fresh app has no history
# (the peak appears only after 24 hourly observations spanning a
# full day). Seed the state file with 25 hourly observations at
# 2.0 sat/vB over the last 24 hours — the 90th percentile is 2.0
# over a 1-day window — before the app boots. loadState merges
# the seed over the defaults, so only version, bitcoin.txs, and
# feeHistory need to be present. The startup hourly tick adds
# nothing (one observation per hour: the latest seed is minutes
# old), so the peak stays 2.0.
os.makedirs(DATA, exist_ok=True)
_now = datetime.now(timezone.utc)
_seed_history = [{'t': (_now - timedelta(hours=24 - i)).isoformat().replace('+00:00', 'Z'), 'fee': 2.0} for i in range(25)]
# The seed must be a plausible state document (version + bitcoin.txs)
# or loadState rejects it as corrupt; mergeDefaults fills the rest.
json.dump({'version': 7, 'bitcoin': {'txs': []}, 'feeHistory': _seed_history}, open(os.path.join(DATA, 'state.json'), 'w'), indent=2)
# Primary stub answers the Slipstream API and the BTC price feed
# too (same port), so the app never touches the real
# slipstream.mara.com, mempool.space or CoinGecko.
p1 = v.start(['node', v.STUB, '18275'], log=LOG)
p2 = v.start(['node', v.STUB, '18276'], log=LOG)
recv = v.start(['node', 'checkin-receiver/server.js'],
               env=_with_profile({'PORT': '3479', 'CHECKIN_DIR': CHECKIN_DIR}), cwd=BRANCH, log=LOG)
app = v.start(['node', 'server.js'],
              env=_with_profile({'PORT': '3478', 'DATA_DIR': DATA, 'CHECKIN_DIR': CHECKIN_DIR,
                   'SLIPSTREAM_API_URL': 'http://127.0.0.1:18275',
                   'PRICE_API_URL': 'http://127.0.0.1:18275'}),
              cwd=BRANCH, log=LOG)
rc = 1
try:
    assert v.wait_up(BASE), 'app did not come up'
    assert v.wait_up(RBASE, path='/health'), 'receiver did not come up'
    s, h = v.req('GET', '/api/health', base=BASE)
    assert h.get('version') == '0.8.11', h
    s, r = v.req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18275',
                                          'secondaryApiUrl': 'http://127.0.0.1:18276'}, base=BASE)
    assert s == 200, r
    for hexs, label, trig in (
            (v.craft(1, 100001), 'Dom Check-in', None),
            (v.craft(1, 100003), 'Dom Price',
             {'type': 'price', 'params': {'op': '>=', 'value': 150000}}),
            (v.craft(1, 100005), 'Dom UTXO',
             {'type': 'utxo', 'params': {'outpoint': FINNEY_OUTPOINT}}),
            (v.craft(1, 100007), 'Dom Manual',
             {'type': 'manual', 'params': {}}),
            (v.craft(1, 100009), 'Dom Blockheight',
             {'type': 'blockheight', 'params': {'targetHeight': 950000}}),
            (v.craft(1, 100011), 'Dom Setdate',
             {'type': 'setdate', 'params': {'fireAt': '2030-01-01T00:00:00.000Z'}}),
            (v.craft(1, 100013), 'Dom Feemarket',
             {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}})):
        body = {'txHex': hexs, 'label': label, 'notes': ''}
        if trig is not None:
            body['trigger'] = trig
        s, r = v.req('POST', '/api/bitcoin/txs', body, base=BASE)
        assert s == 201, r
        tid = r['tx']['id']
        s, r = v.req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': True}, base=BASE)
        assert s == 200, r
    s, r = v.req('POST', '/api/bitcoin/connection/test', {}, base=BASE)
    assert r.get('ok') is True, r
    s, r = v.req('POST', '/api/checkin', {'method': 'app'}, base=BASE)
    assert s == 200, r
    s, r = v.req('POST', '/api/release/check', {}, base=BASE)
    assert s == 200, r
    acts = [x.get('action') for x in r.get('results', [])]
    assert 'broadcast' not in acts, r
    s, st = v.req('GET', '/api/state', base=BASE)
    for t in st.get('bitcoin', {}).get('txs', []):
        print('seed triggerStatus: %-14s %s' % (t.get('label'), (t.get('triggerStatus') or {}).get('reason')))
    print('seeded: 7 armed txs (checkin/price/utxo/manual/blockheight/setdate/feemarket), nodes tested OK, 1 check-in, 1 release check (no broadcasts)')
    rc = subprocess.run(['node', TESTDIR + '/dom_check099.js']).returncode
    # Width check (390px): the price $ amount field and every
    # guard-note in the Add and Edit forms. Runs while the app is
    # still up, against the same seeded instance. Browsers: use
    # PLAYWRIGHT_BROWSERS_PATH when set; locally the goal dir's
    # screenshots/browsers copy; in CI leave it unset so Playwright
    # uses its default cache (installed by `npx playwright install
    # chromium`).
    _pw_env = dict(os.environ)
    if 'PLAYWRIGHT_BROWSERS_PATH' not in _pw_env:
        _local_browsers = os.path.join(GOAL, 'screenshots', 'browsers')
        if os.path.isdir(_local_browsers):
            _pw_env['PLAYWRIGHT_BROWSERS_PATH'] = _local_browsers
    wrc = subprocess.run(['node', TESTDIR + '/width_check099.js'],
                         env=_pw_env).returncode
    rc = rc or wrc
    # Error-screen phase (0.8.3): the main DOM run boots a healthy
    # app, so the broken-state error view and the restore /
    # start-fresh flows get their own instance on ports 3468/3469
    # (stubs 18265/18266, data /tmp/heirloom099-dom-err). The
    # script kills and respawns the app itself by exact PID; the
    # launcher stops the receiver + stubs here.
    err_data = '/tmp/heirloom099-dom-err'
    err_checkin = '/tmp/heirloom099-dom-err-checkin'
    shutil.rmtree(err_data, ignore_errors=True)
    shutil.rmtree(err_checkin, ignore_errors=True)
    e1 = v.start(['node', v.STUB, '18265'], log=LOG)
    e2 = v.start(['node', v.STUB, '18266'], log=LOG)
    erecv = v.start(['node', 'checkin-receiver/server.js'],
                    env=_with_profile({'PORT': '3469', 'CHECKIN_DIR': err_checkin}), cwd=BRANCH, log=LOG)
    eapp = v.start(['node', 'server.js'],
                   env=_with_profile({'PORT': '3468', 'DATA_DIR': err_data, 'CHECKIN_DIR': err_checkin,
                        'SLIPSTREAM_API_URL': 'http://127.0.0.1:18265',
                        'PRICE_API_URL': 'http://127.0.0.1:18265'}),
                   cwd=BRANCH, log=LOG)
    try:
        assert v.wait_up('http://127.0.0.1:3468'), 'error-phase app did not come up'
        assert v.wait_up('http://127.0.0.1:3469', path='/health'), 'error-phase receiver did not come up'
        s, r = v.req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18265',
                                              'secondaryApiUrl': 'http://127.0.0.1:18266'},
                     base='http://127.0.0.1:3468')
        assert s == 200, r
        s, r = v.req('POST', '/api/bitcoin/txs',
                     {'txHex': v.craft(1, 100021), 'label': 'Dom Error', 'notes': '',
                      'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 150000}}},
                     base='http://127.0.0.1:3468')
        assert s == 201, r
        err_env = dict(os.environ)
        err_env.update({
            'ERR_BASE': 'http://127.0.0.1:3468',
            'ERR_PORT': '3468',
            'ERR_DATA': err_data,
            'ERR_CHECKIN': err_checkin,
            'ERR_APP_DIR': BRANCH,
            'ERR_APP_PID': str(eapp.pid),
            'ERR_STUB_P': '18265',
            'ERR_STUB_S': '18266',
        })
        erc = subprocess.run(['node', TESTDIR + '/dom_check099_error.js'], env=err_env).returncode
        rc = rc or erc
    finally:
        # The error script stops the app it last spawned itself;
        # stop whatever is left (receiver + stubs, and the app if
        # the script died mid-flow) by process object.
        for p in (eapp, erecv, e1, e2):
            v.stop(p)
        err_open = [port for port in (3468, 3469, 18265, 18266) if not port_closed(port)]
        if err_open:
            print('ERROR PHASE STILL LISTENING:', err_open)
            rc = 1
        else:
            print('all 099 error-phase ports closed (3468, 3469, 18265, 18266)')
finally:
    for p in (app, recv, p1, p2):
        v.stop(p)
    # Coverage 8: no server left running on any 09x port.
    open_ports = [port for port in (3478, 3479, 18275, 18276) if not port_closed(port)]
    if open_ports:
        print('STILL LISTENING after stop:', open_ports)
        rc = 1
    else:
        print('all 099 ports closed (3478, 3479, 18275, 18276)')
sys.exit(rc)
