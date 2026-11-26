#!/usr/bin/env node
'use strict';
// Build Standby's standalone programs for the system this runs on, with
// the Node running this script built in (Node's single executable apps):
//   node tools/build-standalone.js [out dir]      (default: dist/)
// Makes standby[.exe] in the out dir: the app, with the page files
// inside it. (No separate check-in receiver: a desktop build opens its own
// check-in port when "Accept check-ins from other devices" is on.) Then
// packs it with LICENSE and a short README into
//   standby-<version>-<os>-<arch>.zip (Windows) or .tar.gz (Linux, macOS).
// Needs Node 25.5+ (node --build-sea). Builds only for this system; CI
// runs it on each one.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const APP = path.join(REPO, 'standby');
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const VERSION = require(path.join(APP, 'package.json')).version;
const EXE = process.platform === 'win32' ? '.exe' : '';
const OS = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform] || process.platform;
const WORK = path.join(OUT, 'build');

function run(cmd, args, opts) { execFileSync(cmd, args, { stdio: 'inherit', ...opts }); }

// Windows: the program is built from a copy of Node that carries
// Standby's icon (standby/public/standby.ico, made by tools/make-icon.py)
// and name, so File Explorer, the taskbar and Task Manager show Standby,
// not Node. The resources are set with rcedit, fetched at build time only
// (never shipped), pinned to a version and checked against its published
// SHA-512 before use.
const RCEDIT = { version: '5.0.2', integrity: 'sha512-dgysxaeXZ4snLpPjn8aVtHvZDCx+aRcvZbaWBgl1poU6OPustMvOkj9a9ZqASQ6i5Y5szJ13LSvglEOwrmgUxA==' };
function untarFile(tgz, wanted) {
  const tar = require('zlib').gunzipSync(fs.readFileSync(tgz));
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', at + 124, at + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === wanted) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(wanted + ' not found in ' + tgz);
}
function brandedNode() {
  const dir = path.join(WORK, 'rcedit');
  fs.mkdirSync(dir, { recursive: true });
  run('npm', ['pack', 'rcedit@' + RCEDIT.version], { cwd: dir, shell: true });
  const tgz = path.join(dir, 'rcedit-' + RCEDIT.version + '.tgz');
  const got = 'sha512-' + require('crypto').createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
  if (got !== RCEDIT.integrity) throw new Error('rcedit ' + RCEDIT.version + ' does not match its published SHA-512');
  const rcedit = path.join(dir, 'rcedit-x64.exe');
  fs.writeFileSync(rcedit, untarFile(tgz, 'package/bin/rcedit-x64.exe'));
  const base = path.join(WORK, 'node-standby.exe');
  fs.copyFileSync(process.execPath, base);
  const v4 = (VERSION.split('.').concat(['0', '0', '0', '0'])).slice(0, 4).join('.');
  run(rcedit, [base,
    '--set-icon', path.join(APP, 'public', 'standby.ico'),
    '--set-file-version', v4, '--set-product-version', v4,
    '--set-version-string', 'FileDescription', 'Standby',
    '--set-version-string', 'ProductName', 'Standby',
    '--set-version-string', 'CompanyName', 'Standby',
    '--set-version-string', 'InternalName', 'standby',
    '--set-version-string', 'OriginalFilename', 'standby.exe',
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 Standby (MIT licence)',
  ]);
  console.log('set the Standby icon and name on the Windows program');
  return base;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// The page files go inside the app as assets named public/<file>.
function publicAssets() {
  const assets = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const key = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, key);
      else assets['public/' + key] = full;
    }
  };
  walk(path.join(APP, 'public'), '');
  return assets;
}

function build(entry, name, assets) {
  const bundle = path.join(WORK, name + '.js');
  run(process.execPath, [path.join(__dirname, 'bundle.js'), entry, bundle]);
  const config = path.join(WORK, name + '.sea.json');
  fs.writeFileSync(config, JSON.stringify({
    main: bundle,
    output: path.join(OUT, name + EXE),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets,
  }, null, 2));
  // node --build-sea copies the Node that runs it: on Windows, the
  // branded copy.
  run(OS === 'windows' ? brandedNode() : process.execPath, ['--build-sea', config]);
  console.log('built ' + name + EXE);
}

build('server.js', 'standby', publicAssets());

// Windows: make the program windowed, so starting it opens no console
// window (the tray icon shows it is running, and the log goes to a file;
// see lib/desktop.js). The PE header's Subsystem field: 3 (console) to 2
// (windows). Node writes nothing to a console it does not have.
if (OS === 'windows') {
  const exe = path.join(OUT, 'standby' + EXE);
  const buf = fs.readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE program: ' + exe);
  const optional = pe + 24;
  if (buf.readUInt16LE(optional) !== 0x20b) throw new Error('not a 64-bit PE program: ' + exe);
  const SUBSYSTEM = optional + 68;
  if (buf.readUInt16LE(SUBSYSTEM) !== 3) throw new Error('unexpected PE subsystem ' + buf.readUInt16LE(SUBSYSTEM));
  buf.writeUInt16LE(2, SUBSYSTEM);
  fs.writeFileSync(exe, buf);
  console.log('made ' + path.basename(exe) + ' a windowed program (no console window)');
}

// The archive: the program, the licence and a short README.
const pkg = 'standby-' + VERSION + '-' + OS + '-' + process.arch;
const stage = path.join(WORK, pkg);
fs.mkdirSync(stage);
fs.copyFileSync(path.join(OUT, 'standby' + EXE), path.join(stage, 'standby' + EXE));
fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(stage, 'LICENSE.txt'));
const dataFolder = OS === 'windows' ? '%APPDATA%\\Standby' : OS === 'macos' ? '~/Library/Application Support/Standby' : '~/.local/share/standby';
const start = OS === 'windows' ? 'Double-click standby.exe.' : 'Run ./standby in a terminal.';
fs.writeFileSync(path.join(stage, 'README.txt'), [
  'Standby ' + VERSION + ' (' + OS + ' ' + process.arch + ')',
  '',
  start + ' A window shows that Standby is running, and the page opens',
  'in your browser (http://localhost:3100). Keep the window open: closing it',
  'stops Standby, and triggers are only checked while it runs.',
  '',
  'Your data is kept in ' + dataFolder + '.',
  'By default Standby starts when you sign in (Settings > This computer turns',
  'that off). To remove Standby, switch that off first, quit it, then delete',
  'the program.',
  'To check in from a phone or script, turn on "Accept check-ins from other',
  'devices" in Settings > Check-in API keys (port 3101, check-ins only).',
  '',
  ...(OS === 'windows' ? ['This build is not code-signed yet: Windows may say "Windows protected your PC".', 'Choose "More info", then "Run anyway".', ''] : []),
  'Check the download against SHA256SUMS.txt from the same release.',
  'More: https://github.com/thefuckisalommy/Standby',
  '',
].join(OS === 'windows' ? '\r\n' : '\n'));
if (OS === 'windows') {
  const zip = path.join(OUT, pkg + '.zip');
  run('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Path "' + stage + '" -DestinationPath "' + zip + '"']);
  console.log('packed ' + path.basename(zip));
} else {
  run('tar', ['-czf', path.join(OUT, pkg + '.tar.gz'), '-C', WORK, pkg]);
  console.log('packed ' + pkg + '.tar.gz');
}
fs.rmSync(WORK, { recursive: true, force: true });
