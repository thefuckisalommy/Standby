// The page's files (standby/public/js/) share one scope, so lint sees each
// alone. This checks across all of them: every top-level function or var
// is declared once, is used somewhere, and is not also a browser global
// name it would hide. Run: node test/page_names_check.js
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'standby', 'public', 'js');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
// The code without comments and strings, so a name only in a comment or
// message does not count as a use. (The page has no template strings.)
function codeOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/[^\n]*/g, ' ');
}
const all = files.map((f) => codeOf(fs.readFileSync(path.join(DIR, f), 'utf8'))).join('\n');
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - page names: ' + name + (cond ? '' : ' | ' + detail));
  if (!cond) failures.push(name);
}

const where = {};
for (const f of files) {
  for (const m of fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(/^(?:async )?(?:function|var) ([A-Za-z_$][\w$]*)/gm)) {
    (where[m[1]] = where[m[1]] || []).push(f);
  }
}
const names = Object.keys(where);
const twice = names.filter((n) => where[n].length > 1);
check('each top-level name is declared once', !twice.length, twice.map((n) => n + ' (' + where[n].join(', ') + ')').join('; '));
const esc = (n) => n.replace(/\$/g, '\\$');
const unused = names.filter((n) => (all.match(new RegExp('(?<![\\w$.])' + esc(n) + '(?![\\w$])', 'g')) || []).length < 2);
check('each top-level name is used', !unused.length, unused.join(', '));
// Names a browser already has on window (checked once in Chromium; a
// shared-scope declaration would hide them).
const BROWSER = ['name', 'status', 'close', 'open', 'stop', 'print', 'find', 'focus', 'blur', 'top', 'parent', 'self',
  'length', 'origin', 'history', 'location', 'event', 'external', 'frames', 'opener', 'closed', 'scroll', 'alert',
  'confirm', 'prompt', 'fetch', 'screen', 'navigator', 'document', 'performance', 'crypto', 'caches', 'menubar',
  'toolbar', 'statusbar', 'scrollbars', 'personalbar', 'locationbar', 'customElements', 'visualViewport', 'onload'];
const hides = names.filter((n) => BROWSER.includes(n));
check('no top-level name hides a browser global', !hides.length, hides.join(', '));
console.log('FAILURES: ' + failures.length + (failures.length ? '' : ' (none)'));
process.exit(failures.length ? 1 : 0);
