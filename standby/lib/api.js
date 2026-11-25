'use strict';
const store = require('./store');
const { DATA_DIR } = require('./config');
const auth = require('./auth');
const { csrfAllowed, fetchSiteAllowed } = require('./http');
const { sendError, sendJson } = require('./util');
const { NEXT } = require('./routes/shared');
const authRoutes = require('./routes/auth');
// Route modules, tried in order; each returns NEXT when none of its routes match.
const ROUTES = [require('./routes/admin'), require('./routes/state'), require('./routes/checkin'), require('./routes/settings'), require('./routes/txs'), require('./routes/sets'), require('./routes/broadcast'), require('./routes/backup'), require('./routes/nodes')];

async function handleApi(req, res, pathname) {
  const now = new Date();
  // Fetch metadata: a browser request from another site
  // — or another port on the same host, i.e. another Umbrel app —
  // is refused before anything else, reads included. See
  // fetchSiteAllowed in lib/http.js.
  if (!fetchSiteAllowed(req)) {
    return sendError(res, 403, 'cross-site request rejected');
  }
  // CSRF gate: state-changing requests must come from the
  // app's own page — see csrfAllowed above. Checked before any state
  // is loaded, so a rejected request cannot touch anything.
  if (req.method !== 'GET' && !csrfAllowed(req)) {
    return sendError(res, 403, 'cross-origin or non-JSON request rejected');
  }
  // App login — see lib/auth.js. Checked before any
  // state is loaded. Off when STANDBY_PASSWORD is unset. The
  // `login: true` flag tells the UI to show its login screen.
  if (auth.enabled() && !auth.routeIsPublic(req.method, pathname) && !auth.requestAuthorized(req, now.getTime())) {
    return sendJson(res, 401, { error: 'login required', login: true });
  }
  const pre = await authRoutes({ req, res, pathname, now });
  if (pre !== NEXT) return pre;
  // A state file that cannot be loaded — corrupt or
  // missing with no usable backup — throws loudly by design, but
  // it must not take the whole API down with it: the two rescue
  // endpoints do not need the current state (restore validates
  // the uploaded backup from the body alone; reset starts fresh),
  // so they still run. Everything else answers with the load
  // error, exactly as before — including /api/health, which keeps
  // 500ing in this state.
  let state = null;
  let stateError = null;
  try {
    state = store.loadState(DATA_DIR);
  } catch (e) {
    stateError = e;
  }
  if (stateError) {
    const rescue = req.method === 'POST'
      && (pathname === '/api/restore' || pathname === '/api/state/reset');
    if (!rescue) return sendError(res, 500, stateError.message || 'internal error');
  }
  const ctx = { req, res, pathname, now, state };
  for (const routes of ROUTES) {
    const out = await routes(ctx);
    if (out !== NEXT) return out;
  }
  return sendError(res, 404, 'unknown API route');
}

module.exports = { handleApi };
