'use strict';
const auth = require('../auth');
const { DEPLOYMENT, DATA_FOLDER_HINT } = require('../config');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function authRoutes(ctx) {
  const { req, res, pathname, now } = ctx;

  // GET /api/auth/status: is a login required, and does
  // this request carry a valid one? The UI asks on startup.
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    // source: 'env' (STANDBY_PASSWORD; on Umbrel its app password), 'app'
    // (set in Settings) or 'none'. The login screen words its "Forgot
    // password?" help from it, and from dataFolder: where a standalone
    // build keeps its data, written without the user's name.
    const st = { required: auth.enabled(), authenticated: auth.requestAuthorized(req, now.getTime()), source: auth.source(), deployment: DEPLOYMENT };
    if (DATA_FOLDER_HINT) st.dataFolder = DATA_FOLDER_HINT;
    return sendJson(res, 200, st);
  }

  // POST /api/auth/password { current, password }: set the app password
  // (none yet) or change it (current required). POST /api/auth/password
  // { current, remove: true } removes it. Not while STANDBY_PASSWORD
  // sets it. Answers a fresh token, as the old sessions stop working.
  // Wrong current passwords count against the login limit.
  if (req.method === 'POST' && pathname === '/api/auth/password') {
    const body = await readBody(req);
    const src = auth.source();
    if (src === 'env') {
      return sendError(res, 409, DEPLOYMENT === 'umbrel'
        ? 'the password is Umbrel\'s app password and cannot be changed here'
        : 'the password is set by STANDBY_PASSWORD and cannot be changed here');
    }
    if (src === 'app') {
      if (auth.loginLimited(now.getTime())) return sendError(res, 429, 'too many wrong passwords — wait a minute and try again');
      if (!auth.passwordMatches(body && body.current)) {
        auth.recordLoginFailure(now.getTime());
        console.warn('Standby: wrong current password on a password change');
        return sendError(res, 401, 'the current password is wrong');
      }
    }
    if (body && body.remove === true) {
      if (src !== 'app') return sendError(res, 400, 'no app password is set');
      auth.clearAppPassword();
      console.log('Standby: app password removed');
      return sendJson(res, 200, { ok: true, required: false, token: null });
    }
    const problem = auth.passwordProblem(body && body.password);
    if (problem) return sendError(res, 400, problem);
    auth.setAppPassword(body.password);
    console.log('Standby: app password ' + (src === 'app' ? 'changed' : 'set'));
    return sendJson(res, 200, { ok: true, required: true, token: auth.issueToken(now.getTime()) });
  }

  // POST /api/login { password }: { ok, token } (token null with no
  // password set). Wrong passwords are rate-limited and logged without the
  // value.
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req).catch(() => ({}));
    if (!auth.enabled()) return sendJson(res, 200, { ok: true, token: null });
    if (auth.loginLimited(now.getTime())) {
      return sendError(res, 429, 'too many wrong passwords — wait a minute and try again');
    }
    if (!auth.passwordMatches(body && body.password)) {
      auth.recordLoginFailure(now.getTime());
      console.warn('Standby: failed login attempt');
      return sendError(res, 401, 'wrong password');
    }
    return sendJson(res, 200, { ok: true, token: auth.issueToken(now.getTime()) });
  }

  // POST /api/logout: rotates the session secret, which
  // signs out every device. Requires a login (the gate above).
  if (req.method === 'POST' && pathname === '/api/logout') {
    if (auth.enabled()) auth.rotateSessionSecret();
    return sendJson(res, 200, { ok: true });
  }
  return NEXT;
};
