'use strict';
// Standby check-in receiver: a separate, minimal service with no
// transaction data (it mounts only CHECKIN_DIR). Two routes:
// - GET /health: liveness
// - POST /checkin with a key (Authorization: Bearer <key> or X-Api-Key):
//   writes last.json, which the app merges into its clock, with the
//   caller's address
// Keys are checked against the SHA-256 hashes in keys.json, read fresh per
// request (revocation is immediate), and never logged. Plain HTTP: the key
// is the only authentication, so treat it like a password.
// Run: PORT=3101 CHECKIN_DIR=/checkin node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The Host allowlist (lib/http.js) and durable writes (lib/store.js) are
// shared with the app; both load without side effects.
const { hostAllowed, describeAllowedHosts } = require('../lib/http');
const { writeFileDurable } = require('../lib/store');
const { BIND, DEPLOYMENT, TEST_MODE, PORT: CONFIG_PORT, CHECKIN_DIR } = require('../lib/config');
const { requireWritable } = require('../lib/startup');

// The receiver's own default port is 3101 (config's default, 3100,
// is the app's); the compose files always set PORT explicitly.
const PORT = process.env.PORT ? CONFIG_PORT : 3101;
const MAX_KEY_LEN = 256;

// The check-in directory must be writable (last.json),
// or the receiver exits with the fix — see lib/startup.js.
requireWritable([{ dir: CHECKIN_DIR, create: true }], DEPLOYMENT, 'Standby receiver');

function sendJson(res, status, obj) {
  // The receiver serves JSON only: no full
  // CSP, just nosniff + frame-ancestors, so its responses cannot be
  // framed or sniffed as another type.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// The key list, read fresh on every request: a revocation lands the
// moment the main app rewrites keys.json. A missing or unreadable
// file means no keys are configured — nothing can check in.
function readKeys() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(CHECKIN_DIR, 'keys.json'), 'utf8'));
    if (!doc || !Array.isArray(doc.keys)) return [];
    return doc.keys.filter((k) => k && typeof k.id === 'string' && typeof k.hash === 'string'
      && /^[0-9a-f]{64}$/.test(k.hash));
  } catch (e) { return []; }
}

function hashKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

// The presented key: a Bearer token, or the X-Api-Key header for
// clients that cannot set Authorization (a phone shortcut, a simple
// webhook). Nothing else is accepted.
function presentedKey(req) {
  const auth = req.headers.authorization || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' ? alt.trim() : '';
}

function cleanIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function writeLastCheckin(keyId, label, sourceIp) {
  const now = new Date().toISOString();
  const doc = { lastCheckinAt: now, keyId, label, receivedAt: now };
  if (sourceIp) doc.sourceIp = sourceIp;
  fs.mkdirSync(CHECKIN_DIR, { recursive: true });
  const file = path.join(CHECKIN_DIR, 'last.json');
  // Write + fsync + rename + dir fsync,
  // so a recorded check-in survives a power cut — a lost last.json
  // would silently move the broadcast clock forward.
  writeFileDurable(file, JSON.stringify(doc, null, 2) + '\n');
  return now;
}

// An uncaught exception is a crash: log it and let Node exit (Docker
// restarts it). Request handlers are guarded, and check-in state is re-
// read from disk.
process.on('uncaughtExceptionMonitor', (e) => {
  console.error('uncaught exception:', e);
});

const server = http.createServer((req, res) => {
  // Host allowlist — first, before the URL
  // parse, routing, and key check. This port is published directly
  // on the LAN with no proxy in front of it, so the allowlist is
  // the rebinding defense here. 421, plain text, and a log line
  // naming the rejected Host so a lockout is diagnosable.
  if (!hostAllowed(req.headers.host)) {
    console.warn('Standby receiver: rejected request with unrecognised Host header: ' + JSON.stringify(req.headers.host));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unrecognised Host header');
    return;
  }
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    // A malformed request target (e.g. `GET // [`) must not throw
    // out of the handler and kill the process: answer 400 and keep
    // serving.
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request URL');
    return;
  }
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  // POST /__test__/throw-uncaught (test-only): same as the app
  // server's hook — throw outside any handler so the suite can
  // prove the receiver terminates instead of serving through it.
  // Gated on STANDBY_TEST_MODE=1, which only
  // the test harness sets; without it this 404s like any unknown
  // path. Answers 200 first — the throw lands after the response.
  if (req.method === 'POST' && pathname === '/__test__/throw-uncaught') {
    if (!TEST_MODE) return sendJson(res, 404, { error: 'not found' });
    setTimeout(() => { throw new Error('test-only uncaught exception'); }, 0);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/checkin') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const sourceIp = cleanIp(req.socket && req.socket.remoteAddress);
    const plain = presentedKey(req);
    if (!plain || plain.length > MAX_KEY_LEN) {
      console.log('check-in rejected: no key' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    const keys = readKeys();
    if (!keys.length) {
      console.log('check-in rejected: no keys configured' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    const digest = hashKey(plain);
    const match = keys.find((k) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(k.hash, 'hex'));
      } catch (e) { return false; }
    });
    if (!match) {
      console.log('check-in rejected: unknown key' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 401, { error: 'invalid check-in key' });
    }
    try {
      writeLastCheckin(match.id, match.label, sourceIp);
    } catch (e) {
      console.error('check-in failed writing last.json:', e);
      return sendJson(res, 500, { error: 'could not record the check-in' });
    }
    console.log('check-in via key "' + match.label + '"' + (sourceIp ? ' from ' + sourceIp : ''));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, BIND, () => {
  console.log(`Standby check-in receiver listening on ${BIND}:${PORT} (checkin dir: ${CHECKIN_DIR})`);
  console.log('Standby receiver allowed Hosts: ' + describeAllowedHosts());
  // No bind warning here: the receiver is meant to be
  // reachable on the LAN, and every check-in needs a key.
});
