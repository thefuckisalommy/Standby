'use strict';
// Standby — static serving + request plumbing (split from server.js, 0.8.7.3).
const store = require('./store');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { DATA_DIR, PUBLIC_DIR } = require('./config');
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
  // Prevent path traversal.
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR)) { sendError(res, 403, 'forbidden'); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { sendError(res, 404, 'not found'); return; }
  const ext = path.extname(resolved);
  setSecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// Security headers (0.8.10, audit fix 3): every response carries
// X-Frame-Options (the UI is never legitimately framed) and
// X-Content-Type-Options: nosniff, plus a Content-Security-Policy.
// The policy is minimal for what this page actually uses: its only
// script is the external /app.js (script-src 'self' — no inline
// scripts, no eval), its only stylesheet is /style.css, its only
// image is /logo.jpg, and it fetches only same-origin /api paths
// (connect-src 'self'). The page DOES use inline style="..."
// attributes everywhere, so style-src allows 'unsafe-inline' — a
// strict style-src would break the UI; scripts stay locked down.
// frame-ancestors 'self' backs the X-Frame-Options header.
// sendJson/sendError (lib/util.js) call this too — the same policy
// on API responses is inert there (CSP governs the page, not a JSON
// payload), and one code path beats two.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
}

// ---------------------------------------------------------------------------
// CSRF protection (0.7.12, third-audit finding 2). The UI is the only
// browser client: it fetches this API from the same origin, and api()
// in public/app.js sends Content-Type: application/json on every call
// (verified — the file has a single fetch, with that header always
// set). A cross-origin page cannot read the responses (no CORS headers
// are ever sent), but a plain form POST, or a no-cors fetch, could
// still reach a state-changing endpoint with the owner's Umbrel
// app-auth cookie attached. So a state-changing /api request must
// pass both checks:
//   (a) a present Origin must match the host the request reached (the
//       Host header) — or both sides must be loopback. A missing Origin
//       (curl, a script, the DOM test shim — Node's fetch sends none)
//       is still allowed. This is the same rule Umbrel's own Murmur app
//       uses behind the app proxy, which preserves Host.
//       X-Forwarded-Host is NOT trusted here (0.8.10, audit fix 2):
//       Umbrel's proxy sets it to the browser's Host, so behind the
//       proxy it can never add information the Host header does not
//       already carry — and a direct request can forge it freely.
//       Trusting it used to let a spoofed Host+Origin pair pass.
//   (b) the Content-Type must be application/json — a cross-origin
//       HTML form can only send urlencoded / multipart / text, and a
//       no-cors fetch cannot set a JSON content type without a CORS
//       preflight this server never answers.
// GETs are reads and are not gated.
function hostOf(h) {
  h = (h || '').trim();
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return (close === -1 ? h.slice(1) : h.slice(1, close)).toLowerCase();
  }
  return h.split(':')[0].toLowerCase();
}

function isLoopback(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// ---------------------------------------------------------------------------
// Host allowlist (0.8.10, audit fix 2): a DNS-rebinding page cannot
// reach this server through the browser's own Host header — the page
// is served from the attacker's domain, so its requests arrive with
// the attacker's Host — but a direct fetch to a LAN IP, or a
// same-origin request from a page the owner opened some other way,
// still carries a legitimate Host. The allowlist keys off the
// browser-facing names, which is safe because Umbrel's auth proxy
// forwards Host verbatim (changeOrigin: false on both proxy layers,
// verified in umbreld source Nov 23) — the container sees exactly
// what the browser sent, never the internal container name.
//   Allowed with zero configuration: any IP literal (an IP Host
//   cannot be rebound — rebinding sends the attacker's domain),
//   'localhost', any '*.local' name, and the machine's own
//   hostname (os.hostname() — covers a bare http://umbrel).
//   Escape hatch: STANDBY_ALLOWED_HOSTS, a comma-separated list of
//   extra hostnames (Tailscale MagicDNS *.ts.net, a custom domain,
//   a .onion address, a reverse-proxy hostname). On Umbrel there
//   is no UI for adding an env var, so that means editing a file
//   on the Pi — the default rule covers every access path Ryan
//   uses (LAN IP, umbrel.local, Tailscale IP, localhost) with
//   nothing to configure. A missing Host header is rejected:
//   HTTP/1.1 clients always send one, and accepting a request
//   with no Host would defeat the check.
function hostnameOf(hostHeader) {
  return hostOf(hostHeader);
}

function extraAllowedHosts() {
  return (process.env.STANDBY_ALLOWED_HOSTS || '').split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.local')) return true;
  if (name === os.hostname().toLowerCase()) return true;
  if (extraAllowedHosts().includes(name)) return true;
  return false;
}

// One line for the startup log, so a lockout is diagnosable at a
// glance: the default rule plus any names from the env var.
function describeAllowedHosts() {
  const parts = ['any IP literal', 'localhost', '*.local', os.hostname().toLowerCase()];
  const extra = extraAllowedHosts();
  if (extra.length) parts.push('STANDBY_ALLOWED_HOSTS: ' + extra.join(', '));
  return parts.join(', ');
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

// The release-record statuses the app itself writes (see recordRelease
// / broadcastOne): 'stale', 'failed', 'broadcast', 'conflict' — the
// last is an input spent by another transaction that is NOT confirmed
// yet (0.7.12, third-audit finding 1): a warning, not a verdict —
// the transaction stays active and a broadcast is still attempted.
// A backup carrying any other status is not a real record (0.7.12,
// third-audit finding 4).
// (0.8.1, audit finding 4) A mutating API handler loads state once at
// the top of handleApi, then awaits the network (fee lookups, trigger
// checks, node tests) — or just the request body — before saving. A
// second request, or the tick, may have saved newer state in between,
// and saving this stale snapshot would clobber it — a lost check-in,
// a lost disarm, a lost edit. So a handler NEVER saves its own
// snapshot after an await: it applies its change to FRESH state,
// synchronously, through saveMutation. The load, the mutation, and
// the save run with no await between them, so no other writer can
// interleave — the same pattern the background refreshes already use
// (see refreshConfirmations). The mutator gets the fresh state and
// returns false to decline the save (the tx or key it named is gone,
// or a fresh-state validation failed); anything else means save.
// Returns the fresh state, or null when the mutator declined.
function saveMutation(mutator) {
  const fresh = store.loadState(DATA_DIR);
  if (mutator(fresh) === false) return null;
  store.saveState(DATA_DIR, fresh);
  return fresh;
}

module.exports = { MIME, serveStatic, hostOf, hostnameOf, hostAllowed, describeAllowedHosts, isLoopback, csrfAllowed, saveMutation, setSecurityHeaders, CSP };
