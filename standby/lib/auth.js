'use strict';
// App login. The Host allowlist does not stop clients that connect by IP,
// and on Umbrel every app shares one Docker network while Umbrel's login
// only guards its proxy. A password checked here closes that path. Umbrel
// sets STANDBY_PASSWORD from APP_PASSWORD; elsewhere it is optional.
// Without STANDBY_PASSWORD the owner can set one in the app: it is kept as
// a scrypt hash in DATA_DIR/login.json, never readable back. Forgotten, it
// is reset only on the machine itself (delete login.json, or start with
// --reset-password); nothing over HTTP can reset it. The password guards
// the API; it does not encrypt the data folder.
// The UI logs in once (POST /api/login) and sends the session token as
// X-Standby-Token from localStorage. Not a cookie: cookies are scoped by
// host, not port, so every app on umbrel.local would receive it;
// localStorage is per origin, and a custom header cannot cross sites
// without a preflight this server never answers. Scripts may send
// Authorization: Bearer <password>.
// Tokens are stateless, "v1.<issued ms>.<HMAC>", keyed by a random
// DATA_DIR/session.key and bound to a hash of the password: they survive
// restarts, expire after TOKEN_TTL_MS, and die when the password changes.
// Logout rotates the key, signing out every device.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PASSWORD, DATA_DIR } = require('./config');
const store = require('./store');

const SESSION_FILE = 'session.key';
const LOGIN_FILE = 'login.json';
const LOGIN_FORMAT = 'standby-login';
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
const KDF = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_SKEW_MS = 5 * 60 * 1000; // a token "issued" further ahead than this is refused
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 10; // per window, across all clients

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

// The password set in the app: { salt, hash } as Buffers, or null.
let appLogin;
function loginPath() { return path.join(DATA_DIR, LOGIN_FILE); }
function readAppLogin() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(loginPath(), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    // A damaged file must not silently turn the login off.
    throw new Error(LOGIN_FILE + ' in the data folder is unreadable (' + e.message + '). Delete it to remove the app password.');
  }
  if (!doc || doc.format !== LOGIN_FORMAT || doc.version !== 1 || !doc.kdf || typeof doc.salt !== 'string' || typeof doc.hash !== 'string') {
    throw new Error(LOGIN_FILE + ' in the data folder is not a Standby login file. Delete it to remove the app password.');
  }
  return { salt: Buffer.from(doc.salt, 'base64'), hash: Buffer.from(doc.hash, 'base64'), kdf: doc.kdf };
}
function appLoginNow() {
  if (appLogin === undefined) appLogin = readAppLogin();
  return appLogin;
}
function derive(plain, salt, kdf) {
  return crypto.scryptSync(plain, salt, kdf.keylen || 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

// Where the login comes from: 'env' (STANDBY_PASSWORD, Umbrel's
// APP_PASSWORD), 'app' (set in Settings) or 'none'.
function source() {
  if (PASSWORD.length > 0) return 'env';
  return appLoginNow() ? 'app' : 'none';
}
function enabled() {
  return source() !== 'none';
}

// Constant-time password check. The scrypt check is costly, so the last
// match is remembered (scripts sending the password on every call).
let lastMatch = null;
function passwordMatches(plain) {
  if (typeof plain !== 'string' || !plain || plain.length > MAX_PASSWORD_LENGTH) return false;
  const src = source();
  if (src === 'env') return crypto.timingSafeEqual(sha256(plain), sha256(PASSWORD));
  if (src !== 'app') return false;
  const digest = sha256(plain);
  if (lastMatch && crypto.timingSafeEqual(digest, lastMatch)) return true;
  const ok = crypto.timingSafeEqual(derive(plain, appLogin.salt, appLogin.kdf), appLogin.hash);
  if (ok) lastMatch = digest;
  return ok;
}

// null when the password is acceptable, else why not.
function passwordProblem(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) return 'the password must be at least ' + MIN_PASSWORD_LENGTH + ' characters';
  if (plain.length > MAX_PASSWORD_LENGTH) return 'the password is too long';
  return null;
}

// Set or replace the app password. Every session signed with the old one
// stops working (the token is bound to the password).
function setAppPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = derive(plain, salt, KDF);
  const doc = { format: LOGIN_FORMAT, version: 1, kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keylen: KDF.keylen }, salt: salt.toString('base64'), hash: hash.toString('base64') };
  store.writeFileDurable(loginPath(), JSON.stringify(doc) + '\n', store.DATA_FILE_MODE);
  appLogin = { salt, hash, kdf: doc.kdf };
  lastMatch = null;
}

// Remove the app password (from Settings, or --reset-password at start).
// true when there was one.
function clearAppPassword() {
  let had = false;
  try { fs.unlinkSync(loginPath()); had = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  appLogin = null;
  lastMatch = null;
  return had;
}

// What a session token is bound to: changes whenever the password does.
function passwordFingerprint() {
  const src = source();
  if (src === 'env') return sha256(PASSWORD).toString('hex');
  if (src === 'app') return sha256(appLogin.hash).toString('hex');
  return '';
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
    .update('v1.' + issuedMs + '.' + passwordFingerprint())
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

// Public without a login: health (version only), auth status and login.
function routeIsPublic(method, pathname) {
  return (method === 'GET' && pathname === '/api/health')
    || (method === 'GET' && pathname === '/api/auth/status')
    || (method === 'POST' && pathname === '/api/login');
}

// Brute-force brake: more than LOGIN_MAX_FAILURES wrong passwords in
// LOGIN_WINDOW_MS answers 429. Global (behind Umbrel's proxy every client
// shares an address).
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
  SESSION_FILE, LOGIN_FILE, TOKEN_TTL_MS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, MIN_PASSWORD_LENGTH,
  source, enabled, passwordMatches, passwordProblem, setAppPassword, clearAppPassword, issueToken, tokenValid, requestAuthorized, routeIsPublic,
  rotateSessionSecret, loginLimited, recordLoginFailure,
};
