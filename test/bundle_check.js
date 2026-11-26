// Checks for tools/bundle.js on deliberately awkward source files: "//"
// and "/*" inside strings, template strings and regex literals; requires
// that only appear in comments; a .json require; a dynamic require (must
// fail the bundle); and a missing relative require (must fail at run
// time, never load from disk). Prints PASS/FAIL per check, then
// FAILURES: N; exits 0 when all pass. Run: node test/bundle_check.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BUNDLE = path.join(__dirname, '..', 'tools', 'bundle.js');
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - bundle: ' + name + (cond ? '' : ' | ' + String(detail).slice(0, 300)));
  if (!cond) failures.push(name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundle-check-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const bundle = (entry, out) => spawnSync(process.execPath, [BUNDLE, entry, out], { env: { ...process.env, BUNDLE_ROOT: root }, encoding: 'utf8' });

// Each dependency is required on the same line as something that looks
// like a comment start, but is not one.
write('entry.js', [
  "'use strict';",
  "const url = 'http://example.com//path'; const a = require('./lib/a');",
  'const s2 = "x//"; const b = require(\'./lib/b\');',
  "const re = /\\/\\/+/g; const c = require('./lib/c');",
  "const t = `template // not a comment /* nor this ${1 + 1}`; const d = require('./lib/d');",
  "const half = 10 / 2; const e = require('./lib/e'); // a real comment: require('./missing-1')",
  "/* a block comment: require('./missing-2') */",
  "function f() { return /x\\/y/.test('x/y'); } const g = require('./data.json');",
  "module.exports = { a, b, c, d, e, g, url, s2, re: String(re), t, half, f: f() };",
  '',
].join('\n'));
for (const m of ['a', 'b', 'c', 'd', 'e']) write('lib/' + m + '.js', "module.exports = '" + m + "';\n");
write('data.json', '{ "ok": true }\n');

const out = path.join(root, 'out', 'entry.js');
let r = bundle('entry.js', out);
check('the awkward file bundles', r.status === 0, r.stderr || r.stdout);
check('every dependency was found (7 files)', /\(7 files\)/.test(r.stdout), r.stdout);
if (r.status === 0) {
  // Run the bundle from a folder with none of the source files.
  const moved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'standby-bundle-run-')), 'entry.js');
  fs.copyFileSync(out, moved);
  let got = null;
  try {
    got = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(' + JSON.stringify(moved) + ')))'], { encoding: 'utf8' }));
  } catch (e) { got = { error: e.message }; }
  check('it runs without the source files, every value intact',
    got && got.a === 'a' && got.b === 'b' && got.c === 'c' && got.d === 'd' && got.e === 'e' && got.g && got.g.ok === true
      && got.url === 'http://example.com//path' && got.s2 === 'x//' && got.t === 'template // not a comment /* nor this 2'
      && got.half === 5 && got.f === true, JSON.stringify(got));
}

// A dynamic require cannot be bundled: the bundle must fail.
write('dynamic.js', "const name = './lib/a'; module.exports = require(name);\n");
r = bundle('dynamic.js', path.join(root, 'out', 'dynamic.js'));
check('a dynamic require fails the bundle', r.status !== 0 && /only literal/.test(r.stderr), r.stderr);

// A relative require to a file that does not exist fails the bundle.
write('missing.js', "module.exports = require('./lib/nope');\n");
r = bundle('missing.js', path.join(root, 'out', 'missing.js'));
check('a require of a missing file fails the bundle', r.status !== 0 && /not found/.test(r.stderr), r.stderr);

// A require that leaves the app folder fails the bundle.
write('outside.js', "module.exports = require('../outside');\n");
r = bundle('outside.js', path.join(root, 'out', 'outside.js'));
check('a require outside the app folder fails the bundle', r.status !== 0 && /leaves the app folder/.test(r.stderr), r.stderr);

fs.rmSync(root, { recursive: true, force: true });
console.log('FAILURES: ' + failures.length + (failures.length ? '' : ' (none)'));
process.exit(failures.length ? 1 : 0);
