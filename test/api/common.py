"""Shared helpers, constants and the app/stub harness for the API suite groups."""
import base64
import copy
import http.client
import json
import os
import platform
import re
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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import helpers as v

check = v.check
TMP = v.TMP


def req(method, path, body=None, base=None, timeout=20, headers=None):
    return v.req(method, path, body, base=base or BASE, timeout=timeout, headers=headers)


# The expected security headers, matching the CSP constant in
# standby/lib/http.js exactly (a drift is a regression).
CSP_0810 = ("default-src 'self'; script-src 'self'; style-src 'self' "
            "'unsafe-inline'; img-src 'self'; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'self'")


def raw_get(path, base):
    # Send the request line verbatim, so a malformed target like // [
    # reaches the server as typed. Returns (status, body bytes).
    u = urllib.parse.urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=5)
    conn.putrequest('GET', path)
    conn.putheader('Host', '%s:%d' % (u.hostname, u.port))
    conn.endheaders()
    r = conn.getresponse()
    return r.status, r.read()


def raw_req(method, path, base, host=None, headers=None, body=None):
    # Like raw_get, with a caller-controlled (or missing) Host, extra
    # headers and a body. Returns (status, body bytes).
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
    # A request with no Host at all needs a bare socket and HTTP/1.0 (Node
    # rejects a Host-less HTTP/1.1 request before the handler). Returns
    # the status.
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
    # (status, {lower-cased header: value}) for one request.
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
DATA = TMP + '/standby-test099'
CHECKIN_DIR = TMP + '/standby-test099-checkin'
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
# Profiles: default (code defaults, loopback bind) or umbrel
# (STANDBY_BIND=0.0.0.0 and STANDBY_ALLOWED_HOSTS set). CI runs each suite
# once per profile, sequentially (ports are fixed per suite). The receiver
# uses the same profile.
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    APP_ENV['STANDBY_BIND'] = '0.0.0.0'
    APP_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
RECEIVER_ENV = {'PORT': str(RECEIVER_PORT), 'CHECKIN_DIR': CHECKIN_DIR}
if os.environ.get('STANDBY_TEST_PROFILE') == 'umbrel':
    RECEIVER_ENV['STANDBY_BIND'] = '0.0.0.0'
    RECEIVER_ENV['STANDBY_ALLOWED_HOSTS'] = 'standby.local'
LOG = TMP + '/standby-test099-proc.log'

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
    # A seeded state.json defines the world, but the app merges its
    # heartbeat file over the state's own lastOnlineAt, so drop the
    # heartbeat whenever state is seeded.
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
    """One rule's slice: a one-rule set's state is served flat, a multi-rule
    set's as an array.
    """
    ts = (t or {}).get('triggerState')
    if isinstance(ts, list):
        return ts[i] if i < len(ts) else {}
    return ts if isinstance(ts, dict) else {}


def wait_until(cond, deadline=12, interval=0.5):
    """Poll cond() until truthy or the deadline (seconds) passes; True if it
    fired. Exceptions inside cond() count as not yet.
    """
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
    """Poll until the tx's rule slice matches every key in want."""
    def cond():
        t = state_tx(tx_id)
        if t is None:
            return False
        sl = rule_slice(t, i)
        return all(sl.get(k) == v for k, v in want.items())
    return wait_until(cond, deadline, interval)


def wait_last_eval(tx_id, before, deadline=12, interval=0.5, i=0):
    """Poll until the rule slice's lastEvalAt is newer than before: one
    observed tick, for negative checks.
    """
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


# --- harness: one app, receiver and two stubs per group ---
app = None
p_primary = p_secondary = p_receiver = None
# Paths for the sections that start their own instances.
_bind_log = TMP + '/standby-test099-bind.log'
_bind_data = TMP + '/standby-test099-bind'
_bind_checkin = TMP + '/standby-test099-bind-checkin'
# Every port a group may use, for the end-of-run check.
ALL_PORTS = (PORT, RECEIVER_PORT, STUB_P, STUB_S, 18190, 18191, 18197, 18198, 3440, 3441)



def restart(before_start=None):
    """Restart the app and wait for the startup tick (it stamps
    nodeCheckedAt.primary and fills currentFees), up to 4 s. Call before
    seeding firing state. before_start runs between stop and start, for
    state that must be on disk at boot.
    """
    global app
    # Wait for a node-check stamp newer than this one, so a stale
    # stamp cannot satisfy the poll.
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
    """Cold caches without a restart (price, fee, tip, current fees,
    outspend). Use restart() when a real restart is the subject or the
    fresh tick window matters.
    """
    s, r = req('POST', '/api/__test__/clear-caches', {})
    return s == 200 and r.get('ok') is True

def restart_stubs(own=None):
    """Restart both stubs with their env. own sets STUB_OWN_SPEND_TXID, so
    'ee'*32 reads as spent by that txid.
    """
    global p_primary, p_secondary
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
    # Poll for the stubs instead of sleeping (a slow stub would refuse
    # the probe).
    wait_up(STUB_BASE_P, path='/api/v3/simple/price')
    wait_up(STUB_BASE_S, path='/api/v3/simple/price')


def start_app():
    global app
    app = start(['node', 'server.js'], env=APP_ENV, cwd=APP, log=LOG)


def stop_app():
    stop(app)


def read_log():
    try:
        return open(LOG).read()
    except OSError:
        return ''


def outspend_counts():
    _, rp = req('GET', '/__test__/outspend-count', base=STUB_BASE_P)
    _, rs = req('GET', '/__test__/outspend-count', base=STUB_BASE_S)
    _, bp = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
    _, bs = req('GET', '/__test__/outspends-count', base=STUB_BASE_S)
    return rp.get('count', -1), rs.get('count', -1), bp.get('count', -1), bs.get('count', -1)


def boot():
    """Fresh data, stubs, receiver and app, nodes pointed at the stubs."""
    global p_primary, p_secondary, p_receiver
    for d in (DATA, CHECKIN_DIR):
        shutil.rmtree(d, ignore_errors=True)
    # A fresh process log per group, as on a CI runner (read_log() reads it).
    open(LOG, 'w').close()
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
    # Poll for the stubs instead of sleeping.
    wait_up(STUB_BASE_P, path='/api/v3/simple/price')
    wait_up(STUB_BASE_S, path='/api/v3/simple/price')
    s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_P)
    check('stubs up: primary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
    s, pr = req('GET', '/api/v3/simple/price', base=STUB_BASE_S)
    check('stubs up: secondary price route answers 98200', s == 200 and pr.get('bitcoin', {}).get('usd') == 98200, pr)
    check('app up', restart())
    check('receiver up', wait_up(RBASE, path='/health'))
    # Point the nodes at the stubs, so tip and outspend reads are the
    # stubs' fixed values.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S})
    check('0 node endpoints point at the stubs',
          s == 200 and r.get('primaryApiUrl') == STUB_BASE_P and r.get('secondaryApiUrl') == STUB_BASE_S, r)


def shutdown():
    global app
    for p in list(v.procs):
        stop(p)
    v.procs.clear()
    app = None
