'use strict';
// Every environment variable the app reads is parsed here; modules never
// read process.env.
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
// Bind address, default 127.0.0.1 so a bare run is not exposed to the LAN.
// Docker sets 0.0.0.0 (a loopback bind would never see forwarded traffic);
// there the port mapping or proxy, plus the app login, is the boundary.
const BIND = process.env.STANDBY_BIND || '127.0.0.1';
// Where this runs: 'umbrel', 'docker' or 'bare' (the default), so startup
// checks and messages can be specific.
const DEPLOYMENTS = ['umbrel', 'docker', 'bare'];
const DEPLOYMENT = DEPLOYMENTS.includes(process.env.STANDBY_DEPLOYMENT)
  ? process.env.STANDBY_DEPLOYMENT : 'bare';
// The app login; empty means none. Umbrel sets it to APP_PASSWORD (shown
// on the app's page).
const PASSWORD = process.env.STANDBY_PASSWORD || '';
// Test mode: set only by the test harness. Gates the /__test__
// routes and every test-only override below.
const TEST_MODE = process.env.STANDBY_TEST_MODE === '1';
// The startup tick delay (5 s); STANDBY_TEST_STARTUP_TICK_MS changes it in
// test mode only.
const STARTUP_TICK_MS = (() => {
  if (!TEST_MODE) return 5000;
  const ms = parseInt(process.env.STANDBY_TEST_STARTUP_TICK_MS || '', 10);
  return (Number.isFinite(ms) && ms >= 0) ? ms : 5000;
})();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The directory shared with the check-in receiver (keys.json out,
// last.json in). Docker and Umbrel set it; a bare run (Linux, macOS or
// Windows) uses the checkin folder inside the data directory.
const CHECKIN_DIR = process.env.CHECKIN_DIR || path.join(DATA_DIR, 'checkin');
// Also write the log to this file (relative to the working directory);
// empty means console only.
const LOG_FILE = (process.env.STANDBY_LOG_FILE || '').trim();
// One source of truth for the version: package.json.
const VERSION = require('../package.json').version;
const MAX_BODY = 1024 * 1024; // 1 MB

// MEMPOOL_HOST / MEMPOOL_PORT / MEMPOOL_PROTOCOL override the saved
// primary node (logged at startup). null when unset.
const MEMPOOL_OVERRIDE = (() => {
  if (!process.env.MEMPOOL_HOST) return null;
  const proto = process.env.MEMPOOL_PROTOCOL || 'https:';
  const port = parseInt(process.env.MEMPOOL_PORT || (proto === 'https:' ? '443' : '80'), 10);
  return proto + '//' + process.env.MEMPOOL_HOST + ':' + port;
})();
// How long a restore waits for its node check; transactions not checked by
// then are reported unchecked. Tests shorten it with
// STANDBY_TEST_RESTORE_CHECK_MS (test mode only).
const RESTORE_CHECK_MS = (() => {
  const ms = TEST_MODE ? parseInt(process.env.STANDBY_TEST_RESTORE_CHECK_MS || '', 10) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 60000;
})();
// Back from a silence this long (no node answered: the device was off or
// the network down), every card is re-checked once. Tests shorten it with
// STANDBY_TEST_OFFLINE_REFRESH_MS (test mode only).
const OFFLINE_REFRESH_MS = (() => {
  const ms = TEST_MODE ? parseInt(process.env.STANDBY_TEST_OFFLINE_REFRESH_MS || '', 10) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 24 * 60 * 60 * 1000;
})();
// How often the running copy refreshes standby.lock (lib/instance.js);
// STANDBY_TEST_LOCK_REFRESH_MS shortens it in tests.
const LOCK_REFRESH_MS = (() => {
  const ms = TEST_MODE ? parseInt(process.env.STANDBY_TEST_LOCK_REFRESH_MS || '', 10) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 30 * 1000;
})();
// Test-only endpoint overrides (test mode only): PRICE_API_URL points every
// built-in price provider at one stub, which outside tests would collapse
// the two-source agreement into one source. SLIPSTREAM_API_URL likewise.
const PRICE_API_URL_OVERRIDE = TEST_MODE ? (process.env.PRICE_API_URL || '').trim() : '';
const SLIPSTREAM_API_URL_OVERRIDE = TEST_MODE ? (process.env.SLIPSTREAM_API_URL || '').trim() : '';
// Ignored-in-production overrides, named for the startup log.
const IGNORED_TEST_OVERRIDES = TEST_MODE ? []
  : ['PRICE_API_URL', 'SLIPSTREAM_API_URL'].filter((k) => (process.env[k] || '').trim());

// Extra Host-header names, comma-separated.
const ALLOWED_HOSTS_EXTRA = (process.env.STANDBY_ALLOWED_HOSTS || '').split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  PORT, BIND, DEPLOYMENT, DEPLOYMENTS, PASSWORD, TEST_MODE, STARTUP_TICK_MS, RESTORE_CHECK_MS, OFFLINE_REFRESH_MS, LOCK_REFRESH_MS, DATA_DIR, PUBLIC_DIR,
  CHECKIN_DIR, LOG_FILE, VERSION, MAX_BODY, MEMPOOL_OVERRIDE, PRICE_API_URL_OVERRIDE,
  SLIPSTREAM_API_URL_OVERRIDE, IGNORED_TEST_OVERRIDES, ALLOWED_HOSTS_EXTRA,
};
