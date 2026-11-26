"""Launch test for the standalone programs (tools/build-standalone.js):
    python3 test/standalone_check.py [dist dir]
On the system they were built for: the app starts with no files beside
it, reports deployment "desktop" and the version, serves its page and
script from inside the program, keeps its data in the user's own folder
when DATA_DIR is unset (with the folder named, without the user's name,
for "Forgot password?"), honours --reset-password, and the check-in
receiver answers. The browser is not opened (STANDBY_OPEN_BROWSER=0).
Ports 3477/3476. Prints PASS/FAIL per check, then FAILURES: N.
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
recv_exe = os.path.join(DIST, 'standby-checkin' + EXE)
check('both programs were built', os.path.isfile(app_exe) and os.path.isfile(recv_exe), os.listdir(DIST) if os.path.isdir(DIST) else DIST)
archives = [f for f in os.listdir(DIST) if f.endswith(('.zip', '.tar.gz'))] if os.path.isdir(DIST) else []
check('one archive was packed, named with the version', len(archives) == 1 and ('-' + VERSION + '-') in archives[0], archives)

home = tempfile.mkdtemp()
base_env = {k: v for k, v in os.environ.items() if k not in ('DATA_DIR', 'CHECKIN_DIR', 'XDG_DATA_HOME')}
base_env.update({'PORT': '3477', 'STANDBY_OPEN_BROWSER': '0', 'HOME': home, 'USERPROFILE': home,
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
s, body = get(B + '/api/auth/password', {'password': 'standalone check pw'})
check('a password can be set', s == 200, body)
out = stop(p)
check('the start message says where the app is', 'Standby is running: open http://localhost:3477/' in out, out[-400:])

# 2. --reset-password clears it.
p = launch(app_exe, base_env, ['--reset-password'])
wait(B + '/api/health')
s, body = get(B + '/api/auth/status')
check('--reset-password removes the password', s == 200 and json.loads(body).get('required') is False, body)
out = stop(p)

# 3. The check-in receiver.
r = launch(recv_exe, dict(base_env, PORT='3476'))
check('the check-in receiver starts and answers', wait('http://127.0.0.1:3476/health'))
stop(r)

shutil.rmtree(home, ignore_errors=True)
print('FAILURES: %d%s' % (len(failures), '' if failures else ' (none)'))
sys.exit(1 if failures else 0)
