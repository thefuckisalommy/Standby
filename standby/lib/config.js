'use strict';
// Standby — env-derived config (split from server.js, 0.8.7.3).
// (0.8.11.1) Every environment variable the app reads lives here,
// so the full set of knobs is visible in one file. Modules import
// the parsed values; none of them read process.env directly.
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
// (0.8.11, secure defaults) The bind address. Default 127.0.0.1:
// a bare `node server.js` run listens on loopback only, so the
// UI is not exposed to the LAN by accident. Docker installs set
// STANDBY_BIND=0.0.0.0 in their compose file — a loopback bind
// inside a container would never receive traffic forwarded to the
// container's IP — and the exposure boundary there is the
// host-side port mapping / proxy (plus the app login, when set).
const BIND = process.env.STANDBY_BIND || '127.0.0.1';
// (0.8.11.1) Where this process is running, so startup checks and
// messages can be specific instead of guessing:
//   'umbrel' — the Umbrel package (standby/docker-compose.yml)
//   'docker' — the generic Docker image (Dockerfile default)
//   'bare'   — `node server.js` from a checkout (the default)
const DEPLOYMENTS = ['umbrel', 'docker', 'bare'];
const DEPLOYMENT = DEPLOYMENTS.includes(process.env.STANDBY_DEPLOYMENT)
  ? process.env.STANDBY_DEPLOYMENT : 'bare';
// (0.8.11.1) The app login. Empty means no login (the pre-0.8.11.1
// behaviour). On Umbrel the compose file sets it to the per-install
// APP_PASSWORD, which Umbrel shows on the app's page.
const PASSWORD = process.env.STANDBY_PASSWORD || '';
// Test mode: set only by the test harness. Gates the /__test__
// routes and every test-only override below.
const TEST_MODE = process.env.STANDBY_TEST_MODE === '1';
// (Optimization O2) The startup-tick delay (the three 5 s
// setTimeouts in server.js: full tick, hourly tick, fee recompute).
// Test-only: honored ONLY in test mode. With the var unset the
// delay is exactly 5000. STANDBY_TEST_STARTUP_TICK_MS must parse
// to a non-negative integer; anything else falls back to 5000.
const STARTUP_TICK_MS = (() => {
  if (!TEST_MODE) return 5000;
  const ms = parseInt(process.env.STANDBY_TEST_STARTUP_TICK_MS || '', 10);
  return (Number.isFinite(ms) && ms >= 0) ? ms : 5000;
})();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The directory shared with the check-in receiver (mounted as a
// volume in docker-compose.yml). The app publishes the key hashes
// there (keys.json) and reads the receiver's check-in timestamps
// (last.json). Absent on a plain `node server.js` run — the key
// feature is dormant then; every file access is guarded.
const CHECKIN_DIR = process.env.CHECKIN_DIR || '/checkin';
// (0.8.11.1) One source of truth for the version: package.json.
const VERSION = require('../package.json').version;
const MAX_BODY = 1024 * 1024; // 1 MB

// (0.8.11.1) Primary-node override for self-hosters:
// MEMPOOL_HOST / MEMPOOL_PORT / MEMPOOL_PROTOCOL win over the
// primary node URL saved in Settings. Logged at startup when set,
// so an override is never silent. null when unset.
const MEMPOOL_OVERRIDE = (() => {
  if (!process.env.MEMPOOL_HOST) return null;
  const proto = process.env.MEMPOOL_PROTOCOL || 'https:';
  const port = parseInt(process.env.MEMPOOL_PORT || (proto === 'https:' ? '443' : '80'), 10);
  return proto + '//' + process.env.MEMPOOL_HOST + ':' + port;
})();
// (0.8.11.1) Test-only endpoint overrides. PRICE_API_URL points
// EVERY built-in price provider at one base (so a stub can answer
// all of them) — outside tests that would quietly collapse the
// two-source price agreement into one source, so it is honored
// only in test mode. SLIPSTREAM_API_URL likewise.
const PRICE_API_URL_OVERRIDE = TEST_MODE ? (process.env.PRICE_API_URL || '').trim() : '';
const SLIPSTREAM_API_URL_OVERRIDE = TEST_MODE ? (process.env.SLIPSTREAM_API_URL || '').trim() : '';
// Ignored-in-production overrides, named for the startup log.
const IGNORED_TEST_OVERRIDES = TEST_MODE ? []
  : ['PRICE_API_URL', 'SLIPSTREAM_API_URL'].filter((k) => (process.env[k] || '').trim());

// (0.8.10) Extra Host-header names, comma-separated.
const ALLOWED_HOSTS_EXTRA = (process.env.STANDBY_ALLOWED_HOSTS || '').split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  PORT, BIND, DEPLOYMENT, DEPLOYMENTS, PASSWORD, TEST_MODE, STARTUP_TICK_MS, DATA_DIR, PUBLIC_DIR,
  CHECKIN_DIR, VERSION, MAX_BODY, MEMPOOL_OVERRIDE, PRICE_API_URL_OVERRIDE,
  SLIPSTREAM_API_URL_OVERRIDE, IGNORED_TEST_OVERRIDES, ALLOWED_HOSTS_EXTRA,
};
