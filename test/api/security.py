"""API suite: Malformed requests, secure defaults, login, encrypted backups (sections 32, 39-41)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 32. malformed requests and security headers ---
    # A malformed request target is a 400 and the process keeps
    # serving (app and receiver); security headers on the page, the
    # API and the receiver.
    s, body = raw_get('//[', BASE)
    check('32 crash: malformed request line gets 400, not a dead server',
          s == 400 and body == b'Bad request URL', (s, body))
    s, r = req('GET', '/api/health')
    check('32 crash: app still answers after the malformed request',
          s == 200 and r.get('version') == VERSION, (s, r))
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

    # --- 39. secure defaults: STANDBY_BIND + startup security notes
    # ---
    # The default bind is loopback; the compose files set 0.0.0.0. The
    # startup warning is about the app login (an API reachable without
    # one); the generic Docker install gets an info line; the receiver
    # logs no warning.
    _expected_bind = APP_ENV.get('STANDBY_BIND', '127.0.0.1')
    check('39 bind: main instance listen line names the profile bind',
          ('Standby %s listening on %s:%d (data: ' % (VERSION, _expected_bind, PORT)) in read_log(),
          read_log()[-500:])

    def _bind_log_text():
        try:
            return open(_bind_log).read()
        except OSError:
            return ''

    def _fresh_bind_log():
        # start() appends to the log; truncate so each instance is
        # judged on its own lines.
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

    # --- 40. app login ---
    # With STANDBY_PASSWORD set, every /api route but health, auth
    # status and login needs a session token or the password as a
    # Bearer token. Tokens survive a restart; logout signs every token
    # out. Also: Sec-Fetch-Site, owner-only files, the startup
    # writability exit.
    _pw = 'correct horse battery staple'
    _ab = 'http://127.0.0.1:3440'
    _auth_app = _bind_instance({'STANDBY_PASSWORD': _pw})
    check('40 auth: instance comes up', wait_up(_ab))
    s, r = req('GET', '/api/health', base=_ab)
    check('40 auth: health is public', s == 200 and r.get('version') == VERSION, (s, r))
    s, r = req('GET', '/api/auth/status', base=_ab)
    check('40 auth: status says required, not authenticated, set by STANDBY_PASSWORD',
          s == 200 and r.get('required') is True and r.get('authenticated') is False and r.get('source') == 'env', (s, r))
    s, r = req('POST', '/api/auth/password', {'current': _pw, 'password': 'a new long password'}, base=_ab,
               headers={'Authorization': 'Bearer ' + _pw})
    check('40 auth: a STANDBY_PASSWORD cannot be changed from the app (409)', s == 409, (s, r))
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
    # Files are owner-only. Windows has no POSIX modes (the user profile's
    # folder permissions apply), so there the files only need to exist.
    _mode = lambda p: os.stat(p).st_mode & 0o777
    if os.name == 'nt':
        check('40 modes: Windows has no POSIX modes; data files exist',
              all(os.path.exists(os.path.join(_bind_data, f)) for f in ('state.json', 'session.key')))
    else:
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

    # --- 40b. app password (set in the app) and first-open setup ---
    # Without STANDBY_PASSWORD the owner can set one: stored as a scrypt
    # hash in login.json, changed or removed with the current one, and
    # reset only by --reset-password at start (or deleting the file).
    _apw = 'an app password here'
    _auth_app = _bind_instance({})
    check('40b app-pw: instance comes up', wait_up(_ab))
    s, r = req('GET', '/api/state', base=_ab)
    check('40b setup: a fresh install starts with setup not done', s == 200 and r.get('setup') == {'done': False}, (s, r.get('setup')))
    s, r = req('POST', '/api/setup', {'done': 'yes'}, base=_ab)
    check('40b setup: done must be a boolean', s == 400, (s, r))
    s, r = req('POST', '/api/setup', {'done': True}, base=_ab)
    s2, st = req('GET', '/api/state', base=_ab)
    check('40b setup: POST /api/setup marks it done', s == 200 and st.get('setup') == {'done': True}, (s, r, st.get('setup')))
    s, r = req('POST', '/api/auth/password', {'password': 'short'}, base=_ab)
    check('40b app-pw: under 12 characters is 400', s == 400 and '12' in r.get('error', ''), (s, r))
    s, r = req('POST', '/api/auth/password', {'password': _apw}, base=_ab)
    _atok = r.get('token') if isinstance(r, dict) else None
    check('40b app-pw: setting one answers a token', s == 200 and r.get('required') is True and isinstance(_atok, str), (s, r))
    _lf = os.path.join(_bind_data, 'login.json')
    _ldoc = json.load(open(_lf)) if os.path.exists(_lf) else {}
    check('40b app-pw: login.json holds a scrypt hash, not the password',
          _ldoc.get('format') == 'standby-login' and _ldoc.get('kdf', {}).get('name') == 'scrypt' and _apw not in open(_lf).read(), _ldoc)
    if os.name != 'nt':
        check('40b app-pw: login.json is 0600', _mode(_lf) == 0o600, oct(_mode(_lf)))
    s, r = req('GET', '/api/auth/status', base=_ab)
    check('40b app-pw: status says required, source app', r.get('required') is True and r.get('source') == 'app', r)
    s, r = req('GET', '/api/state', base=_ab)
    check('40b app-pw: the API is gated now', s == 401 and r.get('login') is True, (s, r))
    _ah = {'X-Standby-Token': _atok or ''}
    s, r = req('GET', '/api/state', base=_ab, headers=_ah)
    check('40b app-pw: the returned token works', s == 200, s)
    s, r = req('POST', '/api/login', {'password': _apw}, base=_ab)
    check('40b app-pw: login with it works', s == 200 and str(r.get('token', '')).startswith('v1.'), (s, r))
    s, r = req('POST', '/api/auth/password', {'current': 'not the password', 'password': 'another app password'}, base=_ab, headers=_ah)
    check('40b app-pw: a change with a wrong current password is 401 (no login flag)', s == 401 and r.get('login') is None, (s, r))
    s, r = req('POST', '/api/auth/password', {'current': _apw, 'password': 'another app password'}, base=_ab, headers=_ah)
    _atok2 = r.get('token') if isinstance(r, dict) else None
    check('40b app-pw: a change with the current password works', s == 200 and isinstance(_atok2, str), (s, r))
    s, r = req('GET', '/api/state', base=_ab, headers=_ah)
    check('40b app-pw: the old token stops working after a change', s == 401, s)
    _ah = {'X-Standby-Token': _atok2 or ''}
    s, r = req('POST', '/api/state/reset', {'confirm': True, 'password': 'nope nope nope'}, base=_ab, headers=_ah)
    check('40b fresh: start fresh with the wrong password is 401', s == 401 and r.get('error') == 'wrong password', (s, r))
    s, r = req('POST', '/api/state/reset', {'confirm': True}, base=_ab, headers=_ah)
    check('40b fresh: start fresh without the password is 401', s == 401, (s, r))
    s, r = req('POST', '/api/state/reset', {'confirm': True, 'password': 'another app password'}, base=_ab, headers=_ah)
    check('40b fresh: start fresh with the password works', s == 200 and r.get('ok') is True, (s, r))
    s, r = req('GET', '/api/state', base=_ab, headers=_ah)
    check('40b fresh: the login survives start fresh, and setup runs again',
          s == 200 and r.get('setup') == {'done': False} and os.path.exists(_lf), (s, r.get('setup')))
    # --reset-password at start removes it.
    stop(_auth_app)
    _e = dict(APP_ENV)
    _e.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin})
    for _k in ('STANDBY_ALLOWED_HOSTS', 'STANDBY_PASSWORD', 'STANDBY_DEPLOYMENT'):
        _e.pop(_k, None)
    _fresh_bind_log()
    _auth_app = start(['node', 'server.js', '--reset-password'], env=_e, cwd=APP, log=_bind_log)
    check('40b reset: instance comes up with --reset-password', wait_up(_ab))
    s, r = req('GET', '/api/auth/status', base=_ab)
    check('40b reset: the app password is gone', r.get('required') is False and r.get('source') == 'none' and not os.path.exists(_lf), r)
    check('40b reset: the log says so', 'app password removed (--reset-password)' in _bind_log_text(), _bind_log_text()[-400:])
    s, r = req('GET', '/api/state', base=_ab)
    check('40b reset: the data is kept (setup flag unchanged)', s == 200 and r.get('setup') == {'done': False}, (s, r.get('setup')))
    # Remove from the app (needs the current password).
    s, r = req('POST', '/api/auth/password', {'password': _apw}, base=_ab)
    _ah = {'X-Standby-Token': r.get('token') or ''}
    s, r = req('POST', '/api/auth/password', {'current': 'wrong wrong wrong', 'remove': True}, base=_ab, headers=_ah)
    check('40b remove: a wrong current password is refused', s == 401 and os.path.exists(_lf), (s, r))
    s, r = req('POST', '/api/auth/password', {'current': _apw, 'remove': True}, base=_ab, headers=_ah)
    check('40b remove: the right one removes it', s == 200 and r.get('required') is False and not os.path.exists(_lf), (s, r))
    stop(_auth_app)
    # A damaged login.json stops the start (never silently login-off).
    open(_lf, 'w').write('{damaged')
    _cp = subprocess.run(['node', 'server.js'], env=dict(os.environ, **_e), cwd=APP, capture_output=True, text=True, timeout=20)
    check('40b damaged: an unreadable login.json exits 1 and names the fix',
          _cp.returncode == 1 and 'login.json' in _cp.stderr and 'Delete it' in _cp.stderr, (_cp.returncode, _cp.stderr[-300:]))
    os.remove(_lf)
    # An install from before setup existed loads as set up.
    _sf = os.path.join(_bind_data, 'state.json')
    _st = json.load(open(_sf))
    _st.pop('setup', None)
    json.dump(_st, open(_sf, 'w'))
    _auth_app = start(['node', 'server.js'], env=_e, cwd=APP, log=_bind_log)
    check('40b setup: instance comes up on an older state', wait_up(_ab))
    s, r = req('GET', '/api/state', base=_ab)
    check('40b setup: an older install (no setup field) loads as done', s == 200 and r.get('setup') == {'done': True}, (s, r.get('setup')))
    stop(_auth_app)
    # A data directory that cannot be created: the app refuses to
    # start (exit 1) and names the problem and the fix.
    _blocker = TMP + '/standby-test099-bind-blocker'
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

    # --- 41. encrypted backups ---
    # POST /api/backup { password } encrypts (lib/backupcrypto.js);
    # restore asks for the password; tools/decrypt-backup.js opens it
    # without Standby. No GET route.
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
    _encf = TMP + '/standby-test099-backup.encrypted.json'
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
