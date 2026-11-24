'use strict';
// Standby — env-derived config (split from server.js, 0.8.7.3).
const path = require('path');

const PORT = parseInt(process.env.PORT || '3100', 10);
// (0.8.11, secure defaults) The bind address. Default 127.0.0.1:
// a bare `node server.js` run listens on loopback only, so the
// no-login UI is not exposed to the LAN by accident. Docker
// installs set STANDBY_BIND=0.0.0.0 in their compose file — a
// loopback bind inside a container would never receive traffic
// forwarded to the container's IP — and the exposure boundary
// there is the host-side port mapping / proxy, not the bind.
const BIND = process.env.STANDBY_BIND || '127.0.0.1';
// (Optimization O2) The startup-tick delay (the three 5 s
// setTimeouts below: full tick, hourly tick, fee recompute).
// Test-only: honored ONLY in test mode (STANDBY_TEST_MODE=1,
// the same double gate as the /api/__test__/clear-caches
// endpoint) — production (Umbrel) never sets either variable,
// and with the var unset the delay is exactly 5000 as today.
// STANDBY_TEST_STARTUP_TICK_MS must parse to a non-negative
// integer; anything else falls back to 5000.
const STARTUP_TICK_MS = (() => {
  if (process.env.STANDBY_TEST_MODE !== '1') return 5000;
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
const VERSION = '0.8.11';
const MAX_BODY = 1024 * 1024; // 1 MB

module.exports = { PORT, BIND, STARTUP_TICK_MS, DATA_DIR, PUBLIC_DIR, CHECKIN_DIR, VERSION, MAX_BODY };
