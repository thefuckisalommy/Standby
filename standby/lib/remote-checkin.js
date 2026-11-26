'use strict';
// "Accept check-ins from other devices" (settings.acceptRemoteCheckins):
// on a desktop or plain run the app opens a check-in-only port itself,
// instead of a second program. It runs the same handler as the separate
// receiver (lib/receiver.js): GET /health and POST /checkin with an API
// key, nothing else, on all network interfaces so a phone or script can
// reach it. The app's own port stays where it is (localhost by default).
// Docker and Umbrel run the separate receiver in its own container, so
// the setting is not offered there.
const os = require('os');
const store = require('./store');
const { CHECKIN_DIR, CHECKIN_PORT, DATA_DIR, DEPLOYMENT } = require('./config');
const { createReceiverServer } = require('./receiver');

const AVAILABLE = DEPLOYMENT === 'desktop' || DEPLOYMENT === 'bare';
const BIND = '0.0.0.0';

let server = null;
let listening = false;
let lastError = null;

function start() {
  if (server) return;
  lastError = null;
  server = createReceiverServer(CHECKIN_DIR);
  server.on('error', (e) => {
    lastError = e.code === 'EADDRINUSE'
      ? 'port ' + CHECKIN_PORT + ' is already in use (another program, or a separate check-in receiver)'
      : e.message;
    console.error('Standby: could not open the check-in port: ' + lastError);
    listening = false;
    server = null;
  });
  server.listen(CHECKIN_PORT, BIND, () => {
    listening = true;
    console.log('Standby: accepting check-ins from other devices on port ' + CHECKIN_PORT + ' (check-ins only, each with an API key)');
  });
}

function stop() {
  if (!server) return;
  const s = server;
  server = null;
  listening = false;
  s.close();
  console.log('Standby: stopped accepting check-ins from other devices');
}

// Open or close the port to match the saved setting. Called at startup and
// after anything that can change it (settings, a restore, start fresh).
function sync(state) {
  const st = state || store.loadState(DATA_DIR);
  const want = AVAILABLE && !!(st.settings && st.settings.acceptRemoteCheckins === true);
  if (want) start();
  else stop();
}

// This computer's network addresses (IPv4, not loopback), for the address
// shown in Settings.
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a && !a.internal && (a.family === 'IPv4' || a.family === 4)) out.push(a.address);
    }
  }
  return out;
}

function status() {
  return { available: AVAILABLE, listening, port: CHECKIN_PORT, error: lastError, addresses: AVAILABLE ? addresses() : [] };
}

module.exports = { sync, status, AVAILABLE };
