'use strict';
// Standby — single-container Node app. ZERO runtime dependencies.
// Serves the static UI and a JSON API backed by plain files in DATA_DIR.
// Run:  PORT=3100 DATA_DIR=./data node server.js
//
// What this app is (0.7.22): a dead man's switch that does ONE thing —
// broadcast the owner's pre-signed Bitcoin transactions if they stop
// checking in past the broadcast threshold — or immediately, on the
// owner's say-so (Broadcast Now on a transaction's own card, or
// Broadcast Armed for the armed ones). There is no message delivery any more: no Part 1 /
// Part 2, no recipient, no channels, no reminders. Each transaction is
// signed in the owner's own wallet and pasted as raw hex; the app never
// sees keys. Each has its own enable toggle and its own release
// record. New transactions are armed by default. The broadcast is REAL,
// via the mempool API — a primary node and a secondary node (both
// user-chosen mempool endpoints, default mempool.space and
// blockstream.info/api), primary first, secondary if the primary does
// not answer. There is no Bitcoin Core RPC path any more (removed in
// 0.5.4). The "test" buttons are dry-runs that check the inputs are
// still unspent and never broadcast. A dry-run that finds spent inputs
// records the transaction stale on the spot: staleness is a durable
// fact about the inputs, not a cycle record and not page memory, so it
// survives refreshes and check-ins — only replacing the hex re-arms
// it. Settings has a data backup card:
// download a JSON backup of the whole setup, or restore one.
// The shared-input warning is derived from the stored transactions
// on every state read, so it persists across refreshes and clears the
// moment a transaction is edited away from the shared input.
// The check-in status turns 'broadcasted' once a release has gone
// out (a manual broadcast does not count) and a check-in resets it
// to 'on-track'. Broadcast Armed only attempts the armed transactions
// that are not archived (broadcasted or stale).
// 0.6.6 adds check-in API keys: a key lets a service or app check in
// for the owner, and it can only record a check-in — it cannot read
// transactions or broadcast. Each service gets its own labelled key
// (shown once, stored as a hash, revocable on its own), and the
// check-in log records which key checked in. The key is presented to
// the check-in receiver (a separate service, checkin-receiver/,
// LAN port 3101), which holds no transaction data and writes only a
// timestamp the app merges — so a holder of a key has no route to the
// transactions at all. The receiver reads the key hashes the app
// publishes to the shared CHECKIN_DIR (keys.json); the app merges a
// newer timestamp from CHECKIN_DIR/last.json on every status read and
// on the hourly tick.

const http = require('http');
const { PORT, VERSION, DATA_DIR, STARTUP_TICK_MS } = require('./lib/config');
const store = require('./lib/store');
const { verifyCheckinKeyStore } = require('./lib/checkin');
const { runFullTick, runHourlyTick, refreshCurrentFeesIfStale, recomputeStoredFees, rearmFullTick } = require('./lib/release');
const { refreshPriceIfStale } = require('./lib/prices');
const { handleApi } = require('./lib/api');
const { serveStatic, sendError, setSecurityHeaders, hostAllowed, describeAllowedHosts } = require('./lib/http');

// (0.8.10, audit fix) An uncaught exception is a crash, not a
// condition to serve through: Node warns that continuing after one
// risks undefined state, and for an app that broadcasts
// transactions a silently-corrupted process is worse than a short
// outage. So this is uncaughtExceptionMonitor — it only LOGS; the
// process still terminates with Node's default behaviour, and
// Docker restarts it (restart: on-failure on both services, and
// the Umbrel containers run the same policy — verified live).
// The request handler below is guarded, so a bad request still
// gets a 400 instead of killing the process; only a throw OUTSIDE
// a guarded handler reaches here. State is re-read from disk on
// every load, so a restarted process does not carry a torn
// in-memory snapshot from the failed handler — and a failed
// check-in is visible (the POST fails), never silent.
process.on('uncaughtExceptionMonitor', (e) => {
  console.error('uncaught exception:', e);
});

// (0.8.10, skip-save) Flush the heartbeat on shutdown: the "I was
// online" stamp lives in heartbeat.json, throttled to one write
// per 5 minutes — a shutdown inside the throttle window would
// otherwise leave a stamp up to 5 minutes stale (harmless for
// grace, which needs hours, but a clean flush costs nothing and
// keeps the stamp exact). process.exit(0) is EXPLICIT: a handler
// that returns without exiting makes Node ignore the signal, and
// Umbrel SIGKILLs after its grace period — stalling the update
// and losing the flush. SIGINT gets the same treatment for a
// local Ctrl-C stop.
function flushHeartbeatAndExit() {
  try { store.writeHeartbeat(DATA_DIR, new Date().toISOString()); } catch (e) { console.error('heartbeat flush failed:', e); }
  process.exit(0);
}
process.on('SIGTERM', flushHeartbeatAndExit);
process.on('SIGINT', flushHeartbeatAndExit);

const server = http.createServer((req, res) => {
  // (0.8.10, audit fix 2) Host allowlist — first, before the URL
  // parse, routing, and auth: a request whose Host is not one of
  // the machine's own names (or an IP literal, or a name in
  // STANDBY_ALLOWED_HOSTS) is a DNS-rebinding probe, not a client.
  // 421, plain text, and a log line naming the rejected Host so a
  // lockout is diagnosable instead of silent.
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
    // (0.8.10, audit fix 1) A malformed request target (e.g.
    // `GET // [`) used to throw here, uncaught, and kill the
    // process. Answer 400 and keep serving instead.
    setSecurityHeaders(res);
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request URL');
    return;
  }
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendError(res, 500, e.message || 'internal error');
    });
    return;
  }
  try { serveStatic(req, res, pathname); }
  catch (e) { console.error(e); if (!res.headersSent) sendError(res, 500, 'static file error'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Standby ${VERSION} listening on :${PORT} (data: ${DATA_DIR})`);
  console.log('Standby allowed Hosts: ' + describeAllowedHosts());
  // (0.8.3) Compare the check-in keys in state with the receiver's
  // key list once at startup — see verifyCheckinKeyStore above.
  verifyCheckinKeyStore();
});

// Release-evaluation timers (0.8.2): the full tick runs once
// shortly after startup and then every checkCadenceSeconds; the
// hourly tick runs once shortly after startup and then hourly.
// The startup fee recompute runs once shortly after startup too
// — see recomputeStoredFees. The hourly tick records one
// economy-fee observation (the fee history the peak is computed
// from) — see recordFeeHistoryObservation. The three 5 s startup delays are
// STARTUP_TICK_MS (5000 in production; the test harness shortens
// it to 500 ms via STANDBY_TEST_STARTUP_TICK_MS — see above).
setTimeout(runFullTick, STARTUP_TICK_MS);
setTimeout(runHourlyTick, STARTUP_TICK_MS);
setTimeout(recomputeStoredFees, STARTUP_TICK_MS);
setTimeout(refreshCurrentFeesIfStale, 2000);
setTimeout(refreshPriceIfStale, 2000); // 0.8.0: a price rule's "currently $X" line is live on first load
setInterval(runHourlyTick, 60 * 60 * 1000);
rearmFullTick();
