'use strict';
// The app's recent console lines (INFO, WARN, ERROR) kept in memory for
// the Logs tab: the last 500 since Standby started, on every kind of
// install. Older lines live in the log file where there is one (the
// downloads), or in the container's log (Docker, Umbrel).
const util = require('util');

const MAX_LINES = 500;
const lines = [];
let seq = 0;

function push(level, args) {
  try {
    lines.push({ n: ++seq, t: new Date().toISOString(), level, msg: util.format(...args) });
    if (lines.length > MAX_LINES) lines.shift();
  } catch { /* never fail the app over its log */ }
}

function install() {
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { orig(...args); push(level, args); };
  }
}

// The kept lines, oldest first; with `after`, only lines newer than that
// line number.
function recent(after) {
  const a = Number(after) || 0;
  return a ? lines.filter((l) => l.n > a) : lines.slice();
}

module.exports = { install, recent, MAX_LINES };
