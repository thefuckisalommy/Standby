'use strict';
// STANDBY_LOG_FILE: also write every console line to a file, timestamped,
// for runs with no console (a desktop app, a service). It rotates at 1 MB,
// keeping one previous file (.1). Logging never fails the app.
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 1024 * 1024;

function install(file) {
  if (!file) return;
  const full = path.resolve(file);
  try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch { /* reported on the first write */ }
  let size = 0;
  try { size = fs.statSync(full).size; } catch { /* new file */ }
  const write = (level, args) => {
    try {
      const line = new Date().toISOString() + ' ' + level + ' ' + util.format(...args) + '\n';
      if (size + line.length > MAX_BYTES) {
        try { fs.renameSync(full, full + '.1'); } catch { /* nothing to rotate */ }
        size = 0;
      }
      fs.appendFileSync(full, line, { mode: 0o600 });
      size += Buffer.byteLength(line);
    } catch { /* never fail the app over its log */ }
  };
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => { orig(...args); write(level, args); };
  }
}

module.exports = { install };
