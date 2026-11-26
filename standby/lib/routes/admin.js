'use strict';
const store = require('../store');
const fs = require('fs');
const path = require('path');
const { clearCaches } = require('../caches');
const { startupWarnings, writeReceiverKeys } = require('../checkin');
const { CHECKIN_DIR, DATA_DIR, TEST_MODE, VERSION } = require('../config');
const { rearmFullTick } = require('../release');
const auth = require('../auth');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function adminRoutes(ctx) {
  const { req, res, pathname, now } = ctx;

  // POST /api/state/reset { confirm: true, password }: start fresh, from
  // Settings or after an unrecoverable load failure (it runs while state
  // cannot load). Deletes the state file and every backup, empties the
  // logs and receiver keys, writes a default state (so setup runs again),
  // and removes a password set in the app, so setup asks for a new one. A
  // password from Umbrel or STANDBY_PASSWORD cannot be removed here and
  // stays. With a login on, the password is asked again; a wrong one
  // counts against the login limit.
  if (req.method === 'POST' && pathname === '/api/state/reset') {
    const body = await readBody(req);
    if (!body || body.confirm !== true) {
      return sendError(res, 400, 'reset requires {confirm:true}');
    }
    if (auth.enabled()) {
      if (auth.loginLimited(now.getTime())) return sendError(res, 429, 'too many wrong passwords — wait a minute and try again');
      if (!auth.passwordMatches(body.password)) {
        auth.recordLoginFailure(now.getTime());
        return sendError(res, 401, 'wrong password');
      }
    }
    store.resetStateFiles(DATA_DIR);
    // Also drop the receiver's last.json, or the next read would merge the
    // pre-reset check-in back in.
    try { fs.unlinkSync(path.join(CHECKIN_DIR, 'last.json')); } catch {}
    const fresh = store.defaultState();
    store.saveState(DATA_DIR, fresh);
    store.writeCheckins(DATA_DIR, []);
    store.writeBroadcastLog(DATA_DIR, []);
    writeReceiverKeys(fresh);
    store.clearStateWarnings();
    startupWarnings.length = 0;
    if (auth.source() === 'app') auth.clearAppPassword();
    require('../remote-checkin').sync(fresh);
    clearCaches();
    rearmFullTick();
    console.log('Standby: all data deleted (start fresh)');
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/__test__/clear-caches: drop the in-memory caches without a
  // restart. Test mode only (STANDBY_TEST_MODE=1); otherwise it 404s like
  // any unknown route. { only: [...] } clears just the named caches.
  if (req.method === 'POST' && pathname === '/api/__test__/clear-caches') {
    if (!TEST_MODE) return sendError(res, 404, 'not found');
    const clearBody = await readBody(req).catch(() => ({}));
    const only = (clearBody && Array.isArray(clearBody.only)) ? clearBody.only : null;
    return sendJson(res, 200, { ok: true, cleared: clearCaches(only) });
  }

  // POST /api/__test__/throw-uncaught: answer 200, then throw outside any
  // handler, so the suite can prove the process exits. Test mode only.
  if (req.method === 'POST' && pathname === '/api/__test__/throw-uncaught') {
    if (!TEST_MODE) return sendError(res, 404, 'not found');
    setTimeout(() => { throw new Error('test-only uncaught exception'); }, 0);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }
  return NEXT;
};
