'use strict';
// Standby — static serving + request plumbing (split from server.js, 0.8.7.3).
const store = require('./store');
const fs = require('fs');
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
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
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
//       Host header), or the X-Forwarded-Host the proxy sets — or both
//       sides must be loopback. A missing Origin (curl, a script, the
//       DOM test shim — Node's fetch sends none) is still allowed.
//       This is the same rule Umbrel's own Murmur app uses behind the
//       app proxy, which preserves Host.
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

function csrfAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = hostOf(new URL(origin).hostname); } catch { return false; }
    const host = hostOf(req.headers.host);
    const fwd = hostOf((req.headers['x-forwarded-host'] || '').split(',')[0]);
    if (oh !== host && oh !== fwd && !(isLoopback(oh) && isLoopback(host))) return false;
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

module.exports = { MIME, serveStatic, hostOf, isLoopback, csrfAllowed, saveMutation };
