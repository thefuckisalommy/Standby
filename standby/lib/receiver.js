'use strict';
// The check-in receiver's request handling, shared by the separate
// receiver (checkin-receiver/server.js: Docker, Umbrel, a plain run) and
// the check-in port a desktop or plain run opens itself (lib/remote-
// checkin.js). Two routes:
// - GET /health: liveness
// - POST /checkin with a key (Authorization: Bearer <key> or X-Api-Key):
//   writes last.json in the check-in folder, which the app merges into its
//   clock, with the caller's address
// Nothing else is served: no route reaches transactions or settings.
// Keys are checked against the SHA-256 hashes in keys.json, read fresh per
// request (revocation is immediate), and never logged. Plain HTTP: the key
// is the only authentication, so treat it like a password.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hostAllowed } = require('./http');
const { writeFileDurable } = require('./store');
const { TEST_MODE } = require('./config');

const MAX_KEY_LEN = 256;

function sendJson(res, status, obj) {
  // JSON only, so just nosniff and frame-ancestors (no full CSP).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Keys read fresh per request, so a revocation applies at once; a missing
// or unreadable file means nothing can check in.
function readKeys(checkinDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(checkinDir, 'keys.json'), 'utf8'));
    if (!doc || !Array.isArray(doc.keys)) return [];
    const keys = doc.keys.filter((k) => k && typeof k.id === 'string' && typeof k.hash === 'string'
      && /^[0-9a-f]{64}$/.test(k.hash));
    // Only a fully valid list with a new revision earns an acknowledgement.
    if (keys.length === doc.keys.length && typeof doc.revision === 'string' && /^[0-9a-f]{32}$/.test(doc.revision)) {
      const ackFile = path.join(checkinDir, 'keys-ack.json');
      try {
        let previous = null;
        try { previous = JSON.parse(fs.readFileSync(ackFile, 'utf8')); } catch { /* first acknowledgement */ }
        if (!previous || previous.revision !== doc.revision) {
          writeFileDurable(ackFile, JSON.stringify({ revision: doc.revision, acknowledgedAt: new Date().toISOString() }) + '\n');
        }
      } catch { /* The app reports pending confirmation; authentication still uses the current keys. */ }
    }
    return keys;
  } catch (e) { return []; }
}

function hashKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

// The key: a Bearer token, or X-Api-Key for clients that cannot set
// Authorization.
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

function writeLastCheckin(checkinDir, keyId, label, sourceIp) {
  const now = new Date().toISOString();
  const doc = { lastCheckinAt: now, keyId, label, receivedAt: now };
  if (sourceIp) doc.sourceIp = sourceIp;
  fs.mkdirSync(checkinDir, { recursive: true });
  const file = path.join(checkinDir, 'last.json');
  // Durable write: a lost last.json would silently move the broadcast
  // clock forward.
  writeFileDurable(file, JSON.stringify(doc, null, 2) + '\n');
  return now;
}

// The receiver as an HTTP server (not yet listening) for one check-in
// folder.
function createReceiverServer(checkinDir) {
  const server = http.createServer((req, res) => {
    // Host allowlist first: this port faces the LAN with no proxy, so it is
    // the rebinding defence here. 421, logged with the Host.
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
      // A malformed request target answers 400 instead of throwing.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad request URL');
      return;
    }
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    // POST /__test__/throw-uncaught: test mode only (else 404); answers 200,
    // then throws outside any handler.
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
      const keys = readKeys(checkinDir);
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
        writeLastCheckin(checkinDir, match.id, match.label, sourceIp);
      } catch (e) {
        console.error('check-in failed writing last.json:', e);
        return sendJson(res, 500, { error: 'could not record the check-in' });
      }
      console.log('check-in via key "' + match.label + '"' + (sourceIp ? ' from ' + sourceIp : ''));
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  });
  let keyPoll = null;
  server.on('listening', () => {
    readKeys(checkinDir);
    keyPoll = setInterval(() => readKeys(checkinDir), 500);
    keyPoll.unref();
  });
  server.on('close', () => { if (keyPoll) clearInterval(keyPoll); });
  return server;
}

module.exports = { createReceiverServer };
