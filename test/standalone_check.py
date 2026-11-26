"""Launch test for the standalone programs (tools/build-standalone.js):
    python3 test/standalone_check.py [dist dir]
On the system they were built for: the app starts with no files beside
it, reports deployment "desktop" and the version, serves its page and
script from inside the program, keeps its data in the user's own folder
when DATA_DIR is unset (with the folder named, without the user's name,
for "Forgot password?"), honours --reset-password, opens its own
check-in port when "Accept check-ins from other devices" is on, and
keeps everything across a restart (an armed transaction and its
trigger, a check-in key, settings, the check-in clock). 0.8.21: it adds
itself to the sign-in list by default (the Windows Run key, or
~/.config/autostart) and removes itself when that is switched off; the
update check is on by default; a second start exits and leaves the
running one; Stop Standby shuts it down; it logs to standby.log in the
data folder; and on Windows the program is windowed (no console) and
shows its tray icon. Any sign-in entry is removed at the end. The
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
base_env = {k: v for k, v in os.environ.items() if k not in ('DATA_DIR', 'CHECKIN_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME')}
base_env.update({'PORT': '3477', 'STANDBY_CHECKIN_PORT': '3476', 'STANDBY_OPEN_BROWSER': '0', 'HOME': home, 'USERPROFILE': home,
                 'APPDATA': os.path.join(home, 'AppData', 'Roaming')})
B = 'http://127.0.0.1:3477'
RUN_KEY = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'


def autostart_entry():
    # The sign-in entry's text, or None.
    if os.name == 'nt':
        r = subprocess.run(['reg', 'query', RUN_KEY, '/v', 'Standby'], capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else None
    f = os.path.join(home, '.config', 'autostart', 'standby.desktop')
    return open(f).read() if os.path.exists(f) else None


if os.name == 'nt':
    subprocess.run(['reg', 'delete', RUN_KEY, '/v', 'Standby', '/f'], capture_output=True)
    # The program is windowed: PE Subsystem 2, not 3 (console).
    with open(app_exe, 'rb') as f:
        exe_head = f.read(4096)
    pe = int.from_bytes(exe_head[0x3c:0x40], 'little')
    check('the Windows program is windowed (no console window)', int.from_bytes(exe_head[pe + 24 + 68:pe + 24 + 70], 'little') == 2,
          int.from_bytes(exe_head[pe + 24 + 68:pe + 24 + 70], 'little'))
    # It carries Standby's name (and icon, set in the same step), not Node's.
    _vi = subprocess.run(['powershell', '-NoProfile', '-Command',
                          "$v = (Get-Item -LiteralPath $env:SB_EXE).VersionInfo; $v.FileDescription + '|' + $v.ProductName + '|' + $v.FileVersion"],
                         capture_output=True, text=True, env=dict(os.environ, SB_EXE=app_exe)).stdout.strip()
    check('the Windows program is named Standby (description, product, version)',
          _vi.startswith('Standby|Standby|') and _vi.endswith(VERSION.split('-')[0] + ('.0' * (4 - len(VERSION.split('.'))))), _vi)
    # Standby's icon has orange broadcast arcs (about 50 orange pixels at
    # 32 px); Node's green icon has none.
    _ico = subprocess.run(['powershell', '-NoProfile', '-Command',
                           "Add-Type -AssemblyName System.Drawing; $b = [System.Drawing.Icon]::ExtractAssociatedIcon($env:SB_EXE).ToBitmap(); $n = 0; "
                           "for ($x = 0; $x -lt $b.Width; $x++) { for ($y = 0; $y -lt $b.Height; $y++) { $c = $b.GetPixel($x, $y); "
                           "if ($c.A -gt 128 -and $c.R -gt 180 -and $c.G -gt 80 -and $c.G -lt 190 -and $c.B -lt 90) { $n++ } } }; $n"],
                          capture_output=True, text=True, env=dict(os.environ, SB_EXE=app_exe)).stdout.strip()
    check('the Windows program shows the Standby icon (its orange arcs)', _ico.isdigit() and int(_ico) >= 20, _ico)

# 1. Default data folder (the user's own), nothing beside the program.
p = launch(app_exe, base_env)
up = wait(B + '/api/health')
check('the app starts and answers', up)
s, body = get(B + '/api/health')
check('it reports the version ' + VERSION, s == 200 and json.loads(body).get('version') == VERSION, body)
s, body = get(B + '/')
check('it serves the page from inside the program', s == 200 and b'<title>' in body, s)
s, body = get(B + '/js/core.js')
check('and its scripts', s == 200 and len(body) > 5000 and get(B + '/js/main.js')[0] == 200, s)
s, body = get(B + '/no-such-file.js')
check('a missing page file is 404', s == 404, s)
s, body = get(B + '/api/auth/status')
st = json.loads(body) if s == 200 else {}
want_hint = '%APPDATA%\\Standby' if os.name == 'nt' else '~/.local/share/standby'
check('deployment is desktop, data folder named without the user name',
      st.get('deployment') == 'desktop' and st.get('dataFolder') == want_hint, st)
data_dir = os.path.join(home, 'AppData', 'Roaming', 'Standby') if os.name == 'nt' else os.path.join(home, '.local', 'share', 'standby')
check('state is kept in the user folder', os.path.isfile(os.path.join(data_dir, 'state.json')), data_dir)
entry = autostart_entry()
check('it adds itself to the sign-in list by default, to start in the background',
      entry is not None and app_exe in entry and '--background' in entry, entry)
_, d = call('GET', B + '/api/desktop')
check('This computer is offered, start with the computer on', (d or {}).get('available') is True and d.get('startAtLogin') is True and d.get('stop') is True, d)
_, u = call('GET', B + '/api/update')
check('the update check is on by default', (u or {}).get('available') is True and u.get('enabled') is True, u)
if os.name == 'nt':
    log_file = os.path.join(data_dir, 'standby.log')
    shown = False
    for _ in range(40):
        if os.path.exists(log_file) and 'tray icon shown' in open(log_file, encoding='utf-8', errors='replace').read():
            shown = True
            break
        time.sleep(0.5)
    check('the tray icon is shown', shown, open(log_file, encoding='utf-8', errors='replace').read()[-600:] if os.path.exists(log_file) else 'no log')
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

# 3. Start with the computer off and on again; a second start; the log;
#    Stop Standby.
s, _ = call('PUT', B + '/api/settings', {'startAtLogin': False})
check('switched off, the sign-in entry is removed', s == 200 and autostart_entry() is None, autostart_entry())
s, _ = call('PUT', B + '/api/settings', {'startAtLogin': True})
check('switched on again, it is back', s == 200 and autostart_entry() is not None, s)
second = launch(app_exe, base_env)
try:
    out2, _ = second.communicate(timeout=20)
except subprocess.TimeoutExpired:
    second.kill()
    out2, _ = second.communicate()
check('a second start leaves the running one and exits', second.returncode == 0 and 'already running' in (out2 or '')
      and get(B + '/api/health')[0] == 200, (second.returncode, (out2 or '')[-300:]))
log_text = open(os.path.join(data_dir, 'standby.log'), encoding='utf-8', errors='replace').read() if os.path.exists(os.path.join(data_dir, 'standby.log')) else ''
check('it logs to standby.log in the data folder', 'listening on' in log_text, log_text[-300:])
s, _ = call('POST', B + '/api/app/stop', {})
try:
    code = p.wait(timeout=15)
except subprocess.TimeoutExpired:
    code = None
check('Stop Standby shuts it down cleanly', s == 200 and code == 0 and get(B + '/api/health')[0] is None, (s, code))
check('Stop Standby releases its lock (the next start is not refused)', not os.path.exists(os.path.join(data_dir, 'standby.lock')),
      os.listdir(data_dir))
if p.poll() is None:
    stop(p)

# Leave no sign-in entry behind (a temporary run on the real account).
p = launch(app_exe, base_env)
wait(B + '/api/health')
call('PUT', B + '/api/settings', {'startAtLogin': False})
check('the sign-in entry is removed at the end', autostart_entry() is None, autostart_entry())
out = stop(p)

shutil.rmtree(home, ignore_errors=True)
print('FAILURES: %d%s' % (len(failures), '' if failures else ' (none)'))
sys.exit(1 if failures else 0)
