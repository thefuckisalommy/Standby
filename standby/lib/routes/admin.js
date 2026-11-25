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

  // POST /api/state/reset — start fresh after an unrecoverable
  // state-load failure. This sits above the endpoints
  // that need state because it must run while state fails to
  // load (see the rescue gate above): it deletes the state file
  // and every local backup, empties the audit logs, clears the
  // receiver keys, and writes a fresh default state. The body
  // must be {confirm:true} — anything else is a 400, so a stray
  // or accidental call cannot erase anything.
  if (req.method === 'POST' && pathname === '/api/state/reset') {
    const body = await readBody(req);
    if (!body || body.confirm !== true) {
      return sendError(res, 400, 'reset requires {confirm:true}');
    }
    store.resetStateFiles(DATA_DIR);
    // Also drop the receiver's last check-in record: on
    // the next /api/state read mergeExternalCheckin would otherwise
    // resurrect the pre-reset check-in time into the fresh state
    // (a fresh state's clock is null, so any last.json wins).
    // A start-fresh means fresh — including the clock.
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

  // POST /api/__test__/clear-caches (test-only, speedup): drop every
  // in-memory cache a restart would cold — price, node fee, tip,
  // fee peak, current fees, and the UTXO outspend caches — WITHOUT
  // restarting (no state re-read, no tick-timer reset, no 7 s
  // startup wait). It lives under /api/ so the dispatcher routes
  // it to handleApi (a bare /__test__/ path would fall through to
  // the static file server and 404). Gated on
  // STANDBY_TEST_MODE=1, which only the test harness sets
  // (test/helpers.py start); without it the route 404s exactly like any
  // unknown path, so it cannot run in production. The caches are
  // reset to their initial shapes, so the next read fetches fresh
  // from the (stub) sources.
  // A body of { only: [...] } clears just
  // the named caches — the DOM suite clears only 'price', so the
  // fee-peak cache (re-fetched only by the startup refresh and the
  // hourly tick) survives and the fee-verdict pill keeps working.
  // With no `only` array the call clears everything, as before
  // (the API and regression suites rely on the full clear).
  if (req.method === 'POST' && pathname === '/api/__test__/clear-caches') {
    if (!TEST_MODE) return sendError(res, 404, 'not found');
    const clearBody = await readBody(req).catch(() => ({}));
    const only = (clearBody && Array.isArray(clearBody.only)) ? clearBody.only : null;
    return sendJson(res, 200, { ok: true, cleared: clearCaches(only) });
  }

  // POST /api/__test__/throw-uncaught (test-only): throw an
  // uncaught exception on the next tick, outside any handler, so
  // the suite can prove the process terminates instead of serving
  // through it. Gated on STANDBY_TEST_MODE=1
  // like clear-caches above. Answers 200 first — the throw lands
  // after the response, so the caller observes the 200 and then
  // the exit.
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
