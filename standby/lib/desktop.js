'use strict';
// The standalone builds on a desktop: opening the page in the browser, the
// Windows tray icon, and stopping Standby from the page.
// - The tray icon (Windows only) is drawn by a small PowerShell script with
//   Windows Forms, both part of every Windows 10 and 11, so the download
//   stays one file. Its menu: Open Standby (also a double-click) and Quit
//   Standby. The script reports clicks on its output, and closes itself
//   when Standby's process is gone.
// - The Windows program is built windowed (no console window; see
//   tools/build-standalone.js), so the icon is how one knows it is running.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let quitHandler = () => process.exit(0);
// server.js passes the clean shutdown (heartbeat saved, lock released).
function onQuit(fn) { quitHandler = fn; }
function quit() { quitHandler(); }

function openBrowser(url) {
  let cmd = null;
  let args = [];
  if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) { cmd = 'xdg-open'; args = [url]; }
  if (!cmd) return false;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no browser: the address is in the log */ });
    child.unref();
    return true;
  } catch { return false; }
}

const TRAY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Say($word) { [Console]::Out.WriteLine($word); [Console]::Out.Flush() }
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-Object System.Drawing.Icon($env:STANDBY_TRAY_ICON, [System.Windows.Forms.SystemInformation]::SmallIconSize)
$icon.Text = 'Standby'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$title = $menu.Items.Add('Standby ' + $env:STANDBY_TRAY_VERSION + ' (running)')
$title.Enabled = $false
$open = $menu.Items.Add('Open Standby')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Say 'open' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit Standby')
$quit.add_Click({ Say 'quit' })
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Say 'open' })
$icon.Visible = $true
$parent = [int]$env:STANDBY_TRAY_PARENT
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) {
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()
Say 'ready'
[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
`;

// Show the tray icon (Windows). iconFile: the logo on disk (the script
// reads a file). Never fatal: without it Standby still runs.
let tray = null;
function startTray({ iconFile, version, onOpen }) {
  if (process.platform !== 'win32' || tray) return;
  try {
    tray = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(TRAY_SCRIPT, 'utf16le').toString('base64'),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STANDBY_TRAY_ICON: iconFile, STANDBY_TRAY_VERSION: version, STANDBY_TRAY_PARENT: String(process.pid) },
    });
  } catch (e) {
    console.warn('Standby: could not show the tray icon: ' + e.message);
    return;
  }
  let buf = '';
  tray.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const word = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (word === 'ready') console.log('Standby: tray icon shown');
      else if (word === 'open') onOpen();
      else if (word === 'quit') { console.log('Standby: Quit Standby chosen in the tray'); quit(); }
    }
  });
  tray.stderr.on('data', (d) => console.warn('Standby tray: ' + String(d).trim()));
  tray.on('error', (e) => console.warn('Standby: could not show the tray icon: ' + e.message));
  tray.on('exit', (code) => { tray = null; if (code) console.warn('Standby: the tray icon closed (exit ' + code + ')'); });
  process.on('exit', () => { if (tray) { try { tray.kill(); } catch { /* gone */ } } });
}

// The app icon (standby.ico, all sizes) as a file for the tray script:
// from inside the program in a standalone build, else from public/.
function writeTrayIcon(dataDir, publicDir) {
  let bytes = null;
  try { bytes = Buffer.from(require('node:sea').getAsset('public/standby.ico')); } catch { /* not standalone */ }
  if (!bytes) bytes = fs.readFileSync(path.join(publicDir, 'standby.ico'));
  const file = path.join(dataDir, 'tray-icon.ico');
  fs.writeFileSync(file, bytes);
  return file;
}

module.exports = { openBrowser, startTray, writeTrayIcon, onQuit, quit };
