'use strict';
// Standby check-in receiver: a separate, minimal service with no
// transaction data (it mounts only CHECKIN_DIR). It serves only GET
// /health and POST /checkin with a key; see lib/receiver.js.
// Run: PORT=3101 CHECKIN_DIR=/checkin node server.js
const { describeAllowedHosts } = require('../lib/http');
const { BIND, DEPLOYMENT, PORT: CONFIG_PORT, CHECKIN_DIR, LOG_FILE } = require('../lib/config');
require('../lib/logfile').install(LOG_FILE);
const { requireWritable } = require('../lib/startup');
const { createReceiverServer } = require('../lib/receiver');

// The receiver's own default port is 3101 (config's default, 3100,
// is the app's); the compose files always set PORT explicitly.
const PORT = process.env.PORT ? CONFIG_PORT : 3101;

// The check-in directory must be writable (last.json),
// or the receiver exits with the fix — see lib/startup.js.
requireWritable([{ dir: CHECKIN_DIR, create: true }], DEPLOYMENT, 'Standby receiver');

// An uncaught exception is a crash: log it and let Node exit (Docker
// restarts it). Request handlers are guarded, and check-in state is re-
// read from disk.
process.on('uncaughtExceptionMonitor', (e) => {
  console.error('uncaught exception:', e);
});

const server = createReceiverServer(CHECKIN_DIR);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Standby receiver: port ' + PORT + ' is already in use on ' + BIND + '. Set PORT to a free port.');
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, BIND, () => {
  console.log(`Standby check-in receiver listening on ${BIND}:${PORT} (checkin dir: ${CHECKIN_DIR})`);
  console.log('Standby receiver allowed Hosts: ' + describeAllowedHosts());
  // No bind warning here: the receiver is meant to be
  // reachable on the LAN, and every check-in needs a key.
});
