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
  run(process.execPath, ['--build-sea', config]);
  console.log('built ' + name + EXE);
}

build('server.js', 'standby', publicAssets());

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
