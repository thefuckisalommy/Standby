"""Shared helpers for the test suites: check tally, JSON requests, process
start/stop, and fake transactions the stub nodes understand.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Windows: run in UTF-8 mode, as on Linux. The app's files and logs are
# UTF-8; the Windows code page can neither read nor print them.
if os.name == 'nt' and not sys.flags.utf8_mode:
    sys.exit(subprocess.call([sys.executable, '-X', 'utf8'] + sys.argv))

_TESTDIR = os.path.dirname(os.path.abspath(__file__))
# The system temp folder (/tmp on Linux, %TEMP% on Windows).
TMP = tempfile.gettempdir()
# The repository root; the app lives in its standby/ folder.
GOAL = os.path.dirname(_TESTDIR)
STUB = os.path.join(_TESTDIR, 'stubs.js')


def app_dir(root):
    """The app's folder under the repository root."""
    return os.path.join(root, 'standby')


# The parent transactions the stub node knows: FINNEY has outputs 0
# and 1, SECOND output 0. A parent the stub does not know is 404.
FINNEY = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'
SECOND = 'aa' * 32

failures = []


def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL'), '-', name, '' if cond else '| ' + str(detail)[:300])
    if not cond:
        failures.append(name)


def req(method, path, body=None, base=None, timeout=20, headers=None):
    """A JSON request to base + path; returns (status, parsed body)."""
    h = {'Content-Type': 'application/json'}
    if headers:
        h.update(headers)
    r = urllib.request.Request(base + path, method=method,
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
    """A one-input, one-output transaction spending prev_txid:vout (empty
    signature: the app does not verify signatures).
    """
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
    """A transaction spending FINNEY:vout."""
    return craft_prev(FINNEY, vout, value)


def txid_of(hexs):
    b = bytes.fromhex(hexs)
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()[::-1].hex()


# The stub's sentinel transaction (it answers as already known).
SENTINEL_HEX = craft(1, 100001)
SENTINEL_TXID = txid_of(SENTINEL_HEX)

procs = []


def start(cmd, env=None, cwd=None, log=None, signal_group=False):
    """Start a process the suite stops at the end (see procs)."""
    log = log or os.path.join(TMP, 'standby-test-proc.log')
    e = dict(os.environ)
    if env:
        e.update(env)
    # STANDBY_TEST_MODE=1 is the only way the app's test-only
    # endpoints answer; without it they 404 like any unknown path.
    e.setdefault('STANDBY_TEST_MODE', '1')
    # A 500 ms startup tick instead of 5 s (honored in test mode only).
    e.setdefault('STANDBY_TEST_STARTUP_TICK_MS', '500')
    # signal_group: on Windows, its own process group, so it can be sent
    # Ctrl+Break (the Windows stand-in for SIGTERM).
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if (signal_group and os.name == 'nt') else 0
    p = subprocess.Popen(cmd, env=e, cwd=cwd, stdout=open(log, 'ab'), stderr=subprocess.STDOUT, creationflags=flags)
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
