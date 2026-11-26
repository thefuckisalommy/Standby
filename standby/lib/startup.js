'use strict';
// Startup checks shared by the app and the receiver. Writability: a
// Standby that cannot write is worse than one that is down (saves fail one
// by one with nothing on screen). Usually ownership: old installs ran as
// root, current ones run as UID 1000. So check at startup and, if anything
// is not writable, print what and the fix for this deployment, then exit.
const fs = require('fs');
const path = require('path');

// Per process, so two copies starting at once never share the probe.
const PROBE = '.standby-write-test-' + process.pid;

// Problems with one directory (cannot create it, create a file in it, or
// write an existing file). create false allows it to be missing. Returns
// readable problems, empty when fine.
function writeProblems(dir, { create, mode }) {
  const problems = [];
  if (!fs.existsSync(dir)) {
    if (!create) return problems;
    try { fs.mkdirSync(dir, { recursive: true, mode }); } catch (e) {
      problems.push('cannot create ' + dir + ' (' + e.code + ')');
      return problems;
    }
  }
  const probe = path.join(dir, PROBE);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    problems.push('cannot create files in ' + dir + ' (' + e.code + ')');
    return problems;
  }
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return problems; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.W_OK);
    } catch (e) {
      // Gone since the listing (a running copy's temp file swapped into
      // place): not a write problem.
      if (e.code === 'ENOENT') continue;
      problems.push('cannot write ' + file + ' (' + e.code + ')');
    }
  }
  return problems;
}

function ownershipHint(deployment) {
  if (deployment === 'docker') {
    return 'Fix: in the directory holding docker-compose.yml, run\n'
      + '  sudo chown -R 1000:1000 data checkin\n'
      + 'then `docker compose up -d` again. (Standby runs as UID 1000, not root, since 0.8.11.)';
  }
  if (deployment === 'umbrel') {
    return 'Fix: on the Umbrel, give the app data to UID 1000 (Standby does not run as root), then restart Standby from the Umbrel dashboard:\n'
      + '  sudo chown -R 1000:1000 ~/umbrel/app-data/standby/data';
  }
  return process.platform === 'win32'
    ? 'Fix: make these folders writable by the Windows user running `node server.js`, or set DATA_DIR to a folder in your user profile.'
    : 'Fix: make these paths writable by the user running `node server.js` (for example with chown).';
}

// Check every directory; on any problem, log them all with the fix
// and exit(1). `dirs` is a list of { dir, create, mode }.
function requireWritable(dirs, deployment, who) {
  const problems = [];
  for (const d of dirs) problems.push(...writeProblems(d.dir, d));
  if (!problems.length) return;
  console.error(who + ': FATAL: cannot write its files — refusing to start rather than run without saving:\n'
    + problems.map((p) => '  - ' + p).join('\n') + '\n' + ownershipHint(deployment));
  process.exit(1);
}

module.exports = { writeProblems, ownershipHint, requireWritable, PROBE };
