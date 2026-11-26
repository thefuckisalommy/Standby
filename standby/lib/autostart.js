'use strict';
// "Start Standby when I sign in" (settings.startAtLogin, on by default) for
// the standalone builds: Standby adds itself to the computer's sign-in
// list and starts there with --background (no browser; on Windows, only
// the tray icon). Turning it off removes the entry.
// - Windows: the Run value "Standby" under
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run (this user only).
// - Linux: $XDG_CONFIG_HOME/autostart/standby.desktop (~/.config/...),
//   which desktop sessions start. A machine without a desktop has no
//   sign-in to hook: the README shows a systemd user service instead.
// The entry names the program where it is now, so moving the program and
// starting it again repoints it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { STANDALONE } = require('./config');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AVAILABLE = STANDALONE && (process.platform === 'win32' || process.platform === 'linux');

// The Exec= value for the program at exe, per the Desktop Entry spec: the
// path is a quoted argument (inside quotes, ", `, $ and \ take a
// backslash), then the whole value takes the string escapes (\ for a
// backslash, \n for a newline), and a literal % is %%. So a backslash in
// the path ends up as four.
function desktopExec(exe) {
  const quoted = '"' + String(exe).replace(/(["`$\\])/g, '\\$1') + '"';
  return quoted.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/%/g, '%%') + ' --background';
}

function linuxFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'standby.desktop');
}

function enable() {
  const exe = process.execPath;
  if (process.platform === 'win32') {
    execFileSync('reg', ['add', RUN_KEY, '/v', 'Standby', '/t', 'REG_SZ', '/d', '"' + exe + '" --background', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    const file = linuxFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Standby',
      'Comment=Broadcasts presigned Bitcoin transactions when their triggers are met',
      'Exec=' + desktopExec(exe),
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  }
}

function disable() {
  if (process.platform === 'win32') {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', 'Standby', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* not there */ }
  } else {
    try { fs.unlinkSync(linuxFile()); } catch { /* not there */ }
  }
}

let lastError = null;
// Match the sign-in entry to the setting. Called at startup and when the
// setting changes; a failure is reported, never fatal.
function sync(want) {
  if (!AVAILABLE) return;
  try {
    if (want) enable();
    else disable();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.warn('Standby: could not ' + (want ? 'add Standby to' : 'remove Standby from') + ' the sign-in list: ' + e.message);
  }
}

function status() {
  return { available: AVAILABLE, error: lastError, platform: process.platform };
}

module.exports = { sync, status, desktopExec, AVAILABLE };
