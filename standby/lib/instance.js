'use strict';
// One Standby per data folder: two copies would each evaluate triggers and
// could both broadcast. standby.lock holds the running copy's pid and a
// random id, refreshed every REFRESH_MS.
// - A start refuses while the holder's process is alive and the lock is
//   fresh. A live holder with an old lock (a copy just woken from sleep)
//   is given one more refresh interval to prove itself; a pid reused by
//   another program never refreshes, so the lock is taken over then.
// - Before every evaluation and broadcast the running copy confirms the
//   lock is still its own (assertOwner) and exits if not, so a copy paused
//   or racing at startup can never broadcast alongside the one that won.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOCK_REFRESH_MS } = require('./config');

const LOCK_FILE = 'standby.lock';
const REFRESH_MS = LOCK_REFRESH_MS;
const STALE_MS = 3 * REFRESH_MS;

const ID = crypto.randomBytes(8).toString('hex');
let lockPath = null;
let timer = null;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Another live copy's lock, or null when the lock is absent, ours, left by
// a dead process, or old and not refreshed within one more interval.
function holder(file) {
  const cur = readLock(file);
  if (!cur || !Number.isInteger(cur.pid) || cur.pid === process.pid || !alive(cur.pid)) return null;
  const age = Date.now() - Date.parse(cur.refreshedAt || '');
  if (age < STALE_MS) return cur;
  const deadline = Date.now() + REFRESH_MS + REFRESH_MS / 2;
  while (Date.now() < deadline) {
    sleep(Math.min(500, REFRESH_MS / 4));
    const now = readLock(file);
    if (now && now.refreshedAt !== cur.refreshedAt) return now; // alive and refreshing
  }
  return null;
}

function body() {
  return JSON.stringify({ pid: process.pid, id: ID, refreshedAt: new Date().toISOString() }) + '\n';
}

function own(file) {
  lockPath = file;
  timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();
  process.on('exit', release);
}

// { ok: true } once the lock is ours, or { ok: false, pid } when another
// copy holds it. A fresh lock is created exclusively; a takeover replaces
// the file atomically and then confirms it kept it.
function acquire(dataDir, fileMode) {
  const file = path.join(dataDir, LOCK_FILE);
  try {
    fs.writeFileSync(file, body(), { flag: 'wx', mode: fileMode });
    own(file);
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const other = holder(file);
  if (other) return { ok: false, pid: other.pid };
  const tmp = file + '.' + ID;
  fs.writeFileSync(tmp, body(), { mode: fileMode });
  fs.renameSync(tmp, file);
  sleep(Math.min(250, REFRESH_MS / 4));
  const cur = readLock(file);
  if (!cur || cur.id !== ID) return { ok: false, pid: cur && cur.pid };
  own(file);
  return { ok: true };
}

function stillOwner() {
  if (!lockPath) return true; // no lock taken (library use, scripts)
  const cur = readLock(lockPath);
  return !!cur && cur.id === ID;
}

// Called before every evaluation and broadcast.
function assertOwner() {
  if (stillOwner()) return;
  const cur = readLock(lockPath) || {};
  console.error('Standby: another copy (pid ' + cur.pid + ') now holds ' + lockPath + ' — stopping this one before it evaluates or broadcasts anything.');
  lockPath = null;
  process.exit(1);
}

function refresh() {
  if (!lockPath) return;
  assertOwner();
  try { fs.writeFileSync(lockPath, body()); } catch (e) { console.warn('Standby: could not refresh ' + lockPath + ': ' + e.message); }
}

function release() {
  if (!lockPath) return;
  clearInterval(timer);
  if (stillOwner()) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
  lockPath = null;
}

module.exports = { acquire, assertOwner, stillOwner, release, LOCK_FILE };
