'use strict';
// Standby: holds pre-signed Bitcoin transactions and broadcasts them when
// their trigger fires (a missed check-in, a price, a spent UTXO, a block
// height, a date, a fee level) or on the owner's say-so. No runtime
// dependencies; a static UI and a JSON API over plain files in DATA_DIR.
// Run: PORT=3100 DATA_DIR=./data node server.js
// The app never sees keys, only signed hex. Broadcasts are real, via two
// configured mempool API endpoints (primary first). Dry runs never
// broadcast. Check-in keys go to the separate check-in receiver (checkin-
// receiver/), which holds no transaction data and only writes a timestamp
// the app merges.

const http = require('http');
const { PORT, BIND, VERSION, DATA_DIR, CHECKIN_DIR, LOG_FILE, STARTUP_TICK_MS, DEPLOYMENT, PASSWORD, MEMPOOL_OVERRIDE, IGNORED_TEST_OVERRIDES } = require('./lib/config');
require('./lib/logfile').install(LOG_FILE);
const instance = require('./lib/instance');
const { requireWritable } = require('./lib/startup');
const store = require('./lib/store');
const { verifyCheckinKeyStore } = require('./lib/checkin');
const { runFullTick, runHourlyTick, refreshCurrentFeesIfStale, recomputeStoredFees, rearmFullTick } = require('./lib/release');
const { refreshPriceIfStale } = require('./lib/prices');
const { handleApi } = require('./lib/api');
const { serveStatic, sendError, setSecurityHeaders, hostAllowed, describeAllowedHosts, startupSecurityNotes } = require('./lib/http');

// Before anything touches the disk: the data (and check-in) directories
// must be writable, or the app exits with the fix (lib/startup.js). Then
// tighten an older install's permissions.
requireWritable([
  { dir: DATA_DIR, create: true, mode: store.DATA_DIR_MODE },
  { dir: CHECKIN_DIR, create: false },
], DEPLOYMENT, 'Standby');
{
  const tightened = store.secureDataDir(DATA_DIR);
  if (tightened) console.log('Standby: made ' + tightened + ' data path(s) owner-only (0700 directory, 0600 files)');
}
// One copy per data folder (lib/instance.js): a second would also
// evaluate triggers and could broadcast twice.
{
  const lock = instance.acquire(DATA_DIR, store.DATA_FILE_MODE);
  if (!lock.ok) {
    console.error('Standby: another copy is already running on this data folder (' + DATA_DIR + ', pid ' + lock.pid + ').'
      + ' Stop it first, or give this copy its own DATA_DIR. Two copies could both broadcast.');
    process.exit(1);
  }
}
// The app password (lib/auth.js). --reset-password removes it: the reset
// for a forgotten one, possible only by whoever can start Standby on this
// machine. A damaged login file stops the start rather than turning the
// login off.
const auth = require('./lib/auth');
if (process.argv.includes('--reset-password')) {
  if (PASSWORD) console.log('Standby: --reset-password does nothing here — the password comes from STANDBY_PASSWORD' + (DEPLOYMENT === 'umbrel' ? " (Umbrel's app password)." : '; change it there.'));
  else console.log(auth.clearAppPassword() ? 'Standby: app password removed (--reset-password). Open Standby to set a new one.' : 'Standby: --reset-password: no app password was set.');
}
try { auth.source(); } catch (e) {
  console.error('Standby: ' + e.message);
  process.exit(1);
}

// An uncaught exception is a crash, not something to serve through: for an
// app that broadcasts, a corrupted process is worse than a short outage.
// This only logs; Node still exits and Docker restarts it. Request
// handlers are guarded (a bad request gets a 400), and state is re-read
// from disk on every load.
process.on('uncaughtExceptionMonitor', (e) => {
  console.error('uncaught exception:', e);
});

// Flush the heartbeat on shutdown. process.exit(0) is explicit: a handler
// that returns without exiting makes Node ignore the signal, and Umbrel
// then SIGKILLs it, stalling updates.
function flushHeartbeatAndExit() {
  try { store.writeHeartbeat(DATA_DIR, new Date().toISOString()); } catch (e) { console.error('heartbeat flush failed:', e); }
  process.exit(0);
}
process.on('SIGTERM', flushHeartbeatAndExit);
process.on('SIGINT', flushHeartbeatAndExit);
// Windows sends no SIGTERM; Ctrl+Break arrives as SIGBREAK.
if (process.platform === 'win32') process.on('SIGBREAK', flushHeartbeatAndExit);

const server = http.createServer((req, res) => {
  // Host allowlist first, before parsing, routing or auth: anything but an
  // IP, localhost, *.local or a STANDBY_ALLOWED_HOSTS name is a DNS-
  // rebinding probe. 421, with a log line naming the Host so a lockout is
  // diagnosable.
  if (!hostAllowed(req.headers.host)) {
    console.warn('Standby: rejected request with unrecognised Host header: ' + JSON.stringify(req.headers.host));
    setSecurityHeaders(res);
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unrecognised Host header');
    return;
  }
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    // A malformed request target answers 400 instead of throwing.
    setSecurityHeaders(res);
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request URL');
    return;
  }
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      // Client errors are answered as themselves; anything else is logged
      // in full and answered generically.
      if (e && e.expose) {
        if (!res.headersSent) sendError(res, e.statusCode, e.message);
        return;
      }
      console.error(e);
      if (!res.headersSent) sendError(res, 500, 'internal error');
    });
    return;
  }
  try { serveStatic(req, res, pathname); }
  catch (e) { console.error(e); if (!res.headersSent) sendError(res, 500, 'static file error'); }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Standby: port ' + PORT + ' is already in use on ' + BIND + ' (another program, or another Standby). Set PORT to a free port.');
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, BIND, () => {
  console.log(`Standby ${VERSION} listening on ${BIND}:${PORT} (data: ${DATA_DIR}, deployment: ${DEPLOYMENT})`);
  console.log('Standby allowed Hosts: ' + describeAllowedHosts());
  const loginSource = auth.source();
  console.log('Standby app login: ' + (loginSource === 'env' ? 'required (STANDBY_PASSWORD set)' : loginSource === 'app' ? 'required (password set in the app)' : 'off (no password set)'));
  // Who can reach the API without a login? See
  // startupSecurityNotes in lib/http.js.
  const notes = startupSecurityNotes({ bind: BIND, deployment: DEPLOYMENT, password: PASSWORD, appPassword: loginSource === 'app' });
  for (const line of notes.info) console.log(line);
  for (const line of notes.warnings) console.warn(line);
  // Endpoint overrides are never silent.
  if (MEMPOOL_OVERRIDE) console.log('Standby: MEMPOOL_HOST is set — the primary node is ' + MEMPOOL_OVERRIDE + ' (the Settings value is ignored)');
  for (const k of IGNORED_TEST_OVERRIDES) console.warn('Standby: ' + k + ' is set but ignored — it is a test-only override (STANDBY_TEST_MODE=1)');
  // Compare the check-in keys in state with the receiver's
  // key list once at startup — see verifyCheckinKeyStore above.
  verifyCheckinKeyStore();
});

// Timers: the full tick runs shortly after startup and every check
// cadence; the hourly tick shortly after startup and hourly; the stored-
// fee recompute once at startup. The startup delays are STARTUP_TICK_MS (5
// s; 500 ms in tests).
setTimeout(runFullTick, STARTUP_TICK_MS);
setTimeout(runHourlyTick, STARTUP_TICK_MS);
setTimeout(recomputeStoredFees, STARTUP_TICK_MS);
setTimeout(refreshCurrentFeesIfStale, 2000);
setTimeout(refreshPriceIfStale, 2000); // so a price rule's "currently $X" line is live on first load
setInterval(runHourlyTick, 60 * 60 * 1000);
rearmFullTick();
