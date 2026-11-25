'use strict';
const auth = require('../auth');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function authRoutes(ctx) {
  const { req, res, pathname, now } = ctx;

  // GET /api/auth/status: is a login required, and does
  // this request carry a valid one? The UI asks on startup.
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    return sendJson(res, 200, { required: auth.enabled(), authenticated: auth.requestAuthorized(req, now.getTime()) });
  }

  // POST /api/login {password} -> {ok, token}. With no
  // password configured it answers {ok:true, token:null}. Wrong
  // passwords are rate-limited (429) and logged without the value.
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
