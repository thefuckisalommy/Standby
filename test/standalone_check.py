"""Launch test for the standalone programs (tools/build-standalone.js):
    python3 test/standalone_check.py [dist dir]
On the system they were built for: the app starts with no files beside
it, reports deployment "desktop" and the version, serves its page and
script from inside the program, keeps its data in the user's own folder
when DATA_DIR is unset (with the folder named, without the user's name,
for "Forgot password?"), honours --reset-password, opens its own
check-in port when "Accept check-ins from other devices" is on, and
keeps everything across a restart (an armed transaction and its
trigger, a check-in key, settings, the check-in clock). The
browser is not opened (STANDBY_OPEN_BROWSER=0). Ports 3477/3476. Prints PASS/FAIL per check, then FAILURES: N.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import helpers as v  # noqa: E402 (a signed test transaction)
DIST = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'dist'))
EXE = '.exe' if os.name == 'nt' else ''
VERSION = json.load(open(os.path.join(HERE, '..', 'standby', 'package.json')))['version']
failures = []


def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL') + ' - standalone: ' + name + ('' if cond else ' | ' + str(detail)[:300]))
    if not cond:
        failures.append(name)


def get(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # not up yet
        return None, str(e).encode()


def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def wait(url, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        s, _ = get(url)
        if s == 200:
            return True
        time.sleep(0.3)
    return False


def launch(exe, env, args=()):
    # Run from an empty folder: nothing beside the program.
    return subprocess.Popen([exe, *args], cwd=tempfile.mkdtemp(), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def stop(p):
    p.terminate()
    try:
        out, _ = p.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
    return out or ''


app_exe = os.path.join(DIST, 'standby' + EXE)
check('the program was built (and no separate receiver)',
      os.path.isfile(app_exe) and not os.path.exists(os.path.join(DIST, 'standby-checkin' + EXE)),
      os.listdir(DIST) if os.path.isdir(DIST) else DIST)
archives = [f for f in os.listdir(DIST) if f.endswith(('.zip', '.tar.gz'))] if os.path.isdir(DIST) else []
check('one archive was packed, named with the version', len(archives) == 1 and ('-' + VERSION + '-') in archives[0], archives)

home = tempfile.mkdtemp()
base_env = {k: v for k, v in os.environ.items() if k not in ('DATA_DIR', 'CHECKIN_DIR', 'XDG_DATA_HOME')}
base_env.update({'PORT': '3477', 'STANDBY_CHECKIN_PORT': '3476', 'STANDBY_OPEN_BROWSER': '0', 'HOME': home, 'USERPROFILE': home,
                 'APPDATA': os.path.join(home, 'AppData', 'Roaming')})
B = 'http://127.0.0.1:3477'

# 1. Default data folder (the user's own), nothing beside the program.
p = launch(app_exe, base_env)
up = wait(B + '/api/health')
check('the app starts and answers', up)
s, body = get(B + '/api/health')
check('it reports the version ' + VERSION, s == 200 and json.loads(body).get('version') == VERSION, body)
s, body = get(B + '/')
check('it serves the page from inside the program', s == 200 and b'<title>' in body, s)
s, body = get(B + '/app.js')
check('and the script', s == 200 and len(body) > 10000, s)
s, body = get(B + '/no-such-file.js')
check('a missing page file is 404', s == 404, s)
s, body = get(B + '/api/auth/status')
st = json.loads(body) if s == 200 else {}
want_hint = '%APPDATA%\\Standby' if os.name == 'nt' else '~/.local/share/standby'
check('deployment is desktop, data folder named without the user name',
      st.get('deployment') == 'desktop' and st.get('dataFolder') == want_hint, st)
data_dir = os.path.join(home, 'AppData', 'Roaming', 'Standby') if os.name == 'nt' else os.path.join(home, '.local', 'share', 'standby')
check('state is kept in the user folder', os.path.isfile(os.path.join(data_dir, 'state.json')), data_dir)
s, body = get(B + '/api/remote-checkin')
check('the check-in port is offered, and off by default', s == 200 and json.loads(body).get('available') is True
      and get('http://127.0.0.1:3476/health')[0] is None, body)
req = urllib.request.Request(B + '/api/settings', data=b'{"acceptRemoteCheckins":true}', method='PUT',
                             headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req, timeout=5).read()
s, body = get(B + '/api/checkin-keys', {'label': 'standalone check'})
key = json.loads(body).get('plain', '') if s in (200, 201) else ''
up = wait('http://127.0.0.1:3476/health', 10)
creq = urllib.request.Request('http://127.0.0.1:3476/checkin', data=b'', method='POST', headers={'Authorization': 'Bearer ' + key})
try:
    cs = urllib.request.urlopen(creq, timeout=5).status
except urllib.error.HTTPError as e:
    cs = e.code
check('switched on, the program checks in from its own check-in port', up and cs == 200, (up, cs))
s, body = get('http://127.0.0.1:3476/api/state')
check('the check-in port serves nothing of the app', s == 404, s)
# State that must survive a restart (checked in run 2).
s, r = call('POST', B + '/api/bitcoin/txs', {'txHex': v.craft(1, 100021), 'label': 'Standalone restart', 'notes': '',
                                              'trigger': {'type': 'checkin', 'params': {'thresholdDays': 30}}})
tx_id = (r or {}).get('tx', {}).get('id') if s == 201 else None
s2, _ = call('PUT', B + '/api/bitcoin/txs/' + str(tx_id), {'enabled': True}) if tx_id else (None, None)
s3, _ = call('PUT', B + '/api/settings', {'checkCadenceSeconds': 120, 'graceOfflineDays': 3})
check('a transaction is added and armed, and settings changed', s == 201 and s2 == 200 and s3 == 200, (s, r, s2, s3))
_, before = call('GET', B + '/api/state')
s, body = get(B + '/api/auth/password', {'password': 'standalone check pw'})
check('a password can be set', s == 200, body)
out = stop(p)
check('the start message says where the app is', 'Standby is running: open http://localhost:3477/' in out, out[-400:])

# 2. --reset-password clears it.
p = launch(app_exe, base_env, ['--reset-password'])
wait(B + '/api/health')
s, body = get(B + '/api/auth/status')
check('--reset-password removes the password', s == 200 and json.loads(body).get('required') is False, body)
check('the check-in port reopens after a restart', wait('http://127.0.0.1:3476/health', 10))
_, after = call('GET', B + '/api/state')
tx = next((t for t in (after or {}).get('bitcoin', {}).get('txs', []) if t.get('id') == tx_id), None)
check('after a restart the transaction is still there, armed, with its trigger',
      tx is not None and tx.get('enabled') is True and tx.get('hex') == v.craft(1, 100021)
      and (tx.get('trigger') or {}).get('type') == 'checkin' and ((tx.get('trigger') or {}).get('params') or {}).get('thresholdDays') == 30,
      tx and {k: tx.get(k) for k in ('enabled', 'trigger')})
check('after a restart the settings, check-in clock and key are kept',
      (after or {}).get('settings', {}).get('checkCadenceSeconds') == 120
      and (after or {}).get('settings', {}).get('graceOfflineDays') == 3
      and (after or {}).get('settings', {}).get('acceptRemoteCheckins') is True
      and (after or {}).get('checkin', {}).get('lastCheckinAt') == (before or {}).get('checkin', {}).get('lastCheckinAt')
      and any(k.get('label') == 'standalone check' for k in (after or {}).get('checkinKeys', [])),
      {'settings': {k: (after or {}).get('settings', {}).get(k) for k in ('checkCadenceSeconds', 'graceOfflineDays', 'acceptRemoteCheckins')},
       'checkin': (after or {}).get('checkin')})
out = stop(p)

shutil.rmtree(home, ignore_errors=True)
print('FAILURES: %d%s' % (len(failures), '' if failures else ' (none)'))
sys.exit(1 if failures else 0)
