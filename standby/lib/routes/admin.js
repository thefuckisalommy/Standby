'use strict';
const store = require('../store');
const fs = require('fs');
const path = require('path');
const { clearCaches } = require('../caches');
const { startupWarnings, writeReceiverKeys } = require('../checkin');
const { CHECKIN_DIR, DATA_DIR, TEST_MODE, VERSION } = require('../config');
const { rearmFullTick } = require('../release');
const { readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function adminRoutes(ctx) {
  const { req, res, pathname } = ctx;

  // POST /api/state/reset { confirm: true }: start fresh after an
  // unrecoverable load failure (it runs while state cannot load). Deletes
  // the state file and every backup, empties the logs and receiver keys,
  // writes a default state. Anything but { confirm: true } is a 400.
  if (req.method === 'POST' && pathname === '/api/state/reset') {
    const body = await readBody(req);
    if (!body || body.confirm !== true) {
      return sendError(res, 400, 'reset requires {confirm:true}');
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
    rearmFullTick();
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
