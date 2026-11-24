'use strict';
// Standby — app login (0.8.11.1).
//
// Why: the Host allowlist stops DNS rebinding, but not a client
// that connects by IP. On Umbrel every app shares one Docker
// network, and Umbrel's login only guards traffic that comes
// through its app proxy — any other container (or a request-forgery
// bug in any other app) could reach this container's port directly
// and read or broadcast the signed transactions. A password the
// app checks itself closes that path. On Umbrel the compose file
// sets STANDBY_PASSWORD from the per-install APP_PASSWORD, which
// Umbrel shows on the app's page (deterministicPassword: true).
// On the generic Docker / bare installs it is optional.
//
// Off when STANDBY_PASSWORD is empty: every request is allowed,
// exactly as before 0.8.11.1.
//
// How a request proves itself:
//   - The UI logs in once (POST /api/login) and gets a session
//     token, which it keeps in localStorage and sends in the
//     X-Standby-Token header. NOT a cookie: cookies are scoped by
//     host, not port, so a cookie set on umbrel.local would be sent
//     to every other app on umbrel.local:<port>. localStorage is
//     scoped to the exact origin (scheme + host + port), so no
//     other app can read the token. And a custom header cannot be
//     attached to a cross-site request without a CORS preflight
//     this server never answers.
//   - Scripts can send the password itself as
//     `Authorization: Bearer <password>`.
//
// The token is stateless: "v1.<issued ms>.<HMAC>", where the HMAC
// key is a random secret in DATA_DIR/session.key (0600) and the
// signed message includes a hash of the password. So a token
// survives a restart, expires after TOKEN_TTL_MS, and stops working
// when the password changes. Logging out rotates the secret, which
// signs out every device at once — the owner is the only user.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PASSWORD, DATA_DIR } = require('./config');
const store = require('./store');

const SESSION_FILE = 'session.key';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_SKEW_MS = 5 * 60 * 1000; // a token "issued" further ahead than this is refused
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 10; // per window, across all clients

function enabled() {
  return PASSWORD.length > 0;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

// Constant-time password check: both sides are hashed first, so the
// comparison runs on equal-length buffers whatever was sent.
function passwordMatches(plain) {
  if (!enabled() || typeof plain !== 'string' || !plain) return false;
  return crypto.timingSafeEqual(sha256(plain), sha256(PASSWORD));
}

let secretCache = null;
function writeSecret(buf) {
  store.writeFileDurable(path.join(DATA_DIR, SESSION_FILE), buf.toString('hex') + '\n', store.DATA_FILE_MODE);
  secretCache = buf;
  return buf;
}
function sessionSecret() {
  if (secretCache) return secretCache;
  try {
    const hex = fs.readFileSync(path.join(DATA_DIR, SESSION_FILE), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) { secretCache = Buffer.from(hex, 'hex'); return secretCache; }
  } catch (e) { /* missing or unreadable: make a new one */ }
  return writeSecret(crypto.randomBytes(32));
}
function rotateSessionSecret() {
  return writeSecret(crypto.randomBytes(32));
}

function signature(issuedMs) {
  return crypto.createHmac('sha256', sessionSecret())
    .update('v1.' + issuedMs + '.' + sha256(PASSWORD).toString('hex'))
    .digest('base64url');
}

function issueToken(nowMs) {
  const issued = Math.floor(nowMs);
  return 'v1.' + issued + '.' + signature(issued);
}

function tokenValid(token, nowMs) {
  if (!enabled() || typeof token !== 'string' || token.length > 200) return false;
  const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const issued = Number(m[1]);
  if (!Number.isSafeInteger(issued)) return false;
  if (issued > nowMs + TOKEN_SKEW_MS || nowMs - issued > TOKEN_TTL_MS) return false;
  const want = Buffer.from(signature(issued));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function requestAuthorized(req, nowMs) {
  if (!enabled()) return true;
  const token = req.headers['x-standby-token'];
  if (typeof token === 'string' && tokenValid(token, nowMs)) return true;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return passwordMatches(auth.slice(7).trim());
  return false;
}

// Routes that work without a login: the liveness probe (version
// only — used by container health checks), the auth status the UI
// asks for before it shows the login screen, and the login itself.
function routeIsPublic(method, pathname) {
  return (method === 'GET' && pathname === '/api/health')
    || (method === 'GET' && pathname === '/api/auth/status')
    || (method === 'POST' && pathname === '/api/login');
}

// Brute-force brake: more than LOGIN_MAX_FAILURES wrong passwords
// in LOGIN_WINDOW_MS (from anyone) and the login answers 429 until
// the window clears. Global, not per address — behind Umbrel's
// proxy every client shares one address anyway.
const failures = [];
function pruneFailures(nowMs) {
  while (failures.length && nowMs - failures[0] > LOGIN_WINDOW_MS) failures.shift();
}
function loginLimited(nowMs) {
  pruneFailures(nowMs);
  return failures.length >= LOGIN_MAX_FAILURES;
}
function recordLoginFailure(nowMs) {
  pruneFailures(nowMs);
  failures.push(nowMs);
}

module.exports = {
  SESSION_FILE, TOKEN_TTL_MS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS,
  enabled, passwordMatches, issueToken, tokenValid, requestAuthorized, routeIsPublic,
  rotateSessionSecret, loginLimited, recordLoginFailure,
};
