// Checks lib/autostart.js's Linux Exec= line against the Desktop Entry
// spec: each awkward program path, written out and read back the way a
// desktop does (string escapes, then the quoting rules, then %% -> %),
// must give back the same path and the --background argument.
// Prints PASS/FAIL per check, then FAILURES: N. Run: node test/autostart_check.js
'use strict';
const { desktopExec } = require('../standby/lib/autostart');

const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - autostart: ' + name + (cond ? '' : ' | ' + String(detail).slice(0, 300)));
  if (!cond) failures.push(name);
}

// What a desktop does with an Exec= value: the arguments it runs.
function readExec(value) {
  let s = '';
  for (let i = 0; i < value.length; i++) { // 1. string escapes
    if (value[i] === '\\' && i + 1 < value.length) {
      const n = value[++i];
      s += { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' }[n] !== undefined ? { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' }[n] : '\\' + n;
    } else s += value[i];
  }
  const args = [];
  let i = 0;
  while (i < s.length) { // 2. quoting
    if (s[i] === ' ') { i++; continue; }
    let arg = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"`$\\'.includes(s[i + 1])) { arg += s[i + 1]; i += 2; } else arg += s[i++];
      }
      i++;
    } else {
      while (i < s.length && s[i] !== ' ') arg += s[i++];
    }
    args.push(arg.replace(/%%/g, '%')); // 3. a literal percent
  }
  return args;
}

for (const exe of [
  '/home/user/standby/standby',
  '/home/user/My Apps/standby',
  '/opt/100% sure/standby',
  '/opt/a "quoted" dir/standby',
  '/opt/$HOME and `cmd`/standby',
  '/opt/back\\slash/standby',
  '/opt/all of it: % " ` $ \\ \\\\/standby',
]) {
  const line = desktopExec(exe);
  const args = readExec(line);
  check('round-trips ' + JSON.stringify(exe), args.length === 2 && args[0] === exe && args[1] === '--background', line + ' -> ' + JSON.stringify(args));
}
console.log('FAILURES: ' + failures.length + (failures.length ? '' : ' (none)'));
process.exit(failures.length ? 1 : 0);
