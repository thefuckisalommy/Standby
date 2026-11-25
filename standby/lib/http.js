'use strict';
// Standby — static serving + request plumbing.
const store = require('./store');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { DATA_DIR, PUBLIC_DIR, ALLOWED_HOSTS_EXTRA } = require('./config');
const { sendError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  // No path traversal: compare against the directory with a trailing
  // separator (a bare prefix would also match "public-old").
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) { sendError(res, 403, 'forbidden'); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { sendError(res, 404, 'not found'); return; }
  const ext = path.extname(resolved);
  setSecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// Security headers on every response: X-Frame-Options, nosniff and a
// minimal CSP. Scripts only from 'self' (the page's one script is /app.js,
// no inline or eval); inline style attributes are used throughout, so
// style-src allows 'unsafe-inline'. Also sent on API responses, where it
// is inert.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
}

// CSRF: a state-changing /api request must (a) carry no Origin, or one
// matching the Host it reached (or both loopback), and (b) be
// application/json, which a cross-origin form or no-cors fetch cannot
// send. X-Forwarded-Host is not trusted (Umbrel's proxy keeps Host; a
// direct request could forge it). GETs are not gated.
function hostOf(h) {
  h = (h || '').trim();
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return (close === -1 ? h.slice(1) : h.slice(1, close)).toLowerCase();
  }
  let name = h.split(':')[0].toLowerCase();
  // Strip one trailing DNS dot ("localhost." is localhost); a bare "."
  // becomes "" and is rejected.
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name;
}

function isLoopback(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// Host allowlist against DNS rebinding (a rebinding page's requests carry
// the attacker's Host; Umbrel's proxy forwards Host unchanged). Allowed
// with no configuration: IP literals, 'localhost' and '*.local'. Other
// names (Tailscale, a custom domain, .onion, a reverse proxy) go in
// STANDBY_ALLOWED_HOSTS; the machine's own hostname is not trusted (in
// Docker it is the container ID). A missing Host is rejected. This does
// not stop clients that connect by IP, such as other Umbrel apps: that is
// the app login's job.
function hostnameOf(hostHeader) {
  return hostOf(hostHeader);
}

function extraAllowedHosts() {
  return ALLOWED_HOSTS_EXTRA;
}

function hostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.local')) return true;
  if (extraAllowedHosts().includes(name)) return true;
  return false;
}

// One line for the startup log, so a lockout is diagnosable at a
// glance: the default rule plus any names from the env var.
function describeAllowedHosts() {
  const parts = ['any IP literal', 'localhost', '*.local'];
  const extra = extraAllowedHosts();
  if (extra.length) parts.push('STANDBY_ALLOWED_HOSTS: ' + extra.join(', '));
  return parts.join(', ');
}

// Startup security notes: can something other than the owner reach the API
// without a login? Warnings for Umbrel without a password and a non-
// loopback bind outside Docker without one; info for generic Docker (the
// host-side 127.0.0.1 mapping is the boundary); a warning for a password
// under 12 characters. STANDBY_ALLOWED_HOSTS only widens access, so it
// never silences a warning.
const MIN_PASSWORD_LENGTH = 12;
function startupSecurityNotes({ bind, deployment, password, appPassword }) {
  const warnings = [];
  const info = [];
  if (!password && appPassword && deployment !== 'umbrel') return { warnings, info };
  if (!password) {
    if (deployment === 'umbrel') {
      warnings.push('Standby: WARNING: STANDBY_PASSWORD is unset — other apps on the Umbrel Docker network can reach the API without Umbrel\'s login. The Umbrel compose file sets it from APP_PASSWORD; check that it is present.');
    } else if (deployment === 'docker') {
      info.push('Standby: no app login (STANDBY_PASSWORD unset) — access is limited only by the host-side port mapping. Set STANDBY_PASSWORD, or a password in Settings → App login, to require one.');
    } else if (!isLoopback(bind)) {
      warnings.push('Standby: WARNING: listening on ' + bind + ' with no app login (STANDBY_PASSWORD unset) — anyone who can reach this port can read and broadcast your transactions. Set a password in Settings → App login (or STANDBY_PASSWORD), or bind 127.0.0.1.');
    }
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    warnings.push('Standby: WARNING: STANDBY_PASSWORD is shorter than ' + MIN_PASSWORD_LENGTH + ' characters — use a longer one.');
  }
  return { warnings, info };
}

// Fetch metadata, for every /api request: 'same-origin' (the app) and
// 'none' (typed URL, bookmark) pass; 'same-site' (another port on the
// host, i.e. another Umbrel app) and 'cross-site' are refused. Requests
// without the header rely on the other checks.
function fetchSiteAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return true;
  return site === 'same-origin' || site === 'none';
}

function csrfAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = hostOf(new URL(origin).hostname); } catch { return false; }
    const host = hostOf(req.headers.host);
    if (oh !== host && !(isLoopback(oh) && isLoopback(host))) return false;
  }
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  return true;
}

// Handlers never save the snapshot they loaded before awaiting something:
// another request or the tick may have saved meanwhile. saveMutation loads
// fresh state, applies the change and saves with no await in between. The
// mutator returns false to skip the save. Returns the fresh state, or null
// when skipped.
function saveMutation(mutator) {
  const fresh = store.loadState(DATA_DIR);
  if (mutator(fresh) === false) return null;
  store.saveState(DATA_DIR, fresh);
  return fresh;
}

module.exports = { MIME, serveStatic, hostOf, hostnameOf, hostAllowed, describeAllowedHosts, startupSecurityNotes, MIN_PASSWORD_LENGTH, isLoopback, fetchSiteAllowed, csrfAllowed, saveMutation, setSecurityHeaders, CSP };
