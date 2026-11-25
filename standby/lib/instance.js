'use strict';
// One Standby per data folder: two copies would each evaluate triggers and
// could both broadcast. standby.lock holds the running copy's pid and is
// refreshed every 30 s. A start refuses while the lock is fresh and its
// process is alive; a lock left by a crash goes stale and is taken over.
const fs = require('fs');
const path = require('path');

const LOCK_FILE = 'standby.lock';
const REFRESH_MS = 30 * 1000;
const STALE_MS = 90 * 1000;

let lockPath = null;
let timer = null;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Another live copy's lock, or null when the lock is absent, stale, ours,
// or unreadable.
function holder(file) {
  const cur = readLock(file);
  if (!cur || !Number.isInteger(cur.pid) || cur.pid === process.pid) return null;
  const age = Date.now() - Date.parse(cur.refreshedAt || '');
  if (!(age < STALE_MS)) return null;
  return alive(cur.pid) ? cur : null;
}

function body() {
  return JSON.stringify({ pid: process.pid, refreshedAt: new Date().toISOString() }) + '\n';
}

// { ok: true } once the lock is ours, or { ok: false, pid } when another
// copy holds it. Creation is exclusive, so two simultaneous starts cannot
// both win.
function acquire(dataDir, fileMode) {
  const file = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body(), { flag: 'wx', mode: fileMode });
      lockPath = file;
      timer = setInterval(refresh, REFRESH_MS);
      if (timer.unref) timer.unref();
      process.on('exit', release);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = holder(file);
      if (other) return { ok: false, pid: other.pid };
      try { fs.unlinkSync(file); } catch { /* another start took it first */ }
    }
  }
  const other = readLock(file);
  return { ok: false, pid: other && other.pid };
}

// Refresh the lock; if another copy has taken it over, stop rather than
// run two.
function refresh() {
  if (!lockPath) return;
  const cur = readLock(lockPath);
  if (cur && cur.pid !== process.pid && holder(lockPath)) {
    console.error('Standby: another copy (pid ' + cur.pid + ') now holds ' + lockPath + ' — stopping this one.');
    process.exit(1);
  }
  try { fs.writeFileSync(lockPath, body()); } catch (e) { console.warn('Standby: could not refresh ' + lockPath + ': ' + e.message); }
}

function release() {
  if (!lockPath) return;
  clearInterval(timer);
  const cur = readLock(lockPath);
  if (cur && cur.pid === process.pid) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
  lockPath = null;
}

module.exports = { acquire, release, LOCK_FILE };
