'use strict';
// Lint for the app, the receiver, tools and the JS tests (CI runs it with
// `npx eslint@9`; nothing is installed into the app). Errors fail CI.
const node = {
  require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', fetch: 'readonly', performance: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly', structuredClone: 'readonly',
  SharedArrayBuffer: 'readonly', Atomics: 'readonly', crypto: 'readonly', queueMicrotask: 'readonly',
};
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly',
  sessionStorage: 'readonly', fetch: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly', Blob: 'readonly', FileReader: 'readonly',
  crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', CompressionStream: 'readonly',
  DecompressionStream: 'readonly', Response: 'readonly', requestAnimationFrame: 'readonly', alert: 'readonly',
  confirm: 'readonly', atob: 'readonly', btoa: 'readonly', Event: 'readonly', HTMLElement: 'readonly', getComputedStyle: 'readonly', history: 'readonly',
};
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-redeclare': 'error',
};
// The page's files (standby/public/js/) share one scope: each may use what
// the others declare at the top level. Unused or doubly declared top-level
// names are caught by test/page_names_check.js.
const fs = require('fs');
const path = require('path');
const PAGE_DIR = path.join(__dirname, 'standby', 'public', 'js');
const pageFiles = fs.existsSync(PAGE_DIR) ? fs.readdirSync(PAGE_DIR).filter((f) => f.endsWith('.js')) : [];
const topNames = (f) => [...fs.readFileSync(path.join(PAGE_DIR, f), 'utf8').matchAll(/^(?:async )?(?:function|var) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const pageGlobals = (own) => Object.fromEntries(pageFiles.filter((f) => f !== own).flatMap(topNames).map((n) => [n, 'writable']));
const pageRules = { ...rules, 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', vars: 'local' }] };

module.exports = [
  { ignores: ['**/node_modules/**', 'standby-bundled/**'] },
  { files: ['standby/**/*.js', 'tools/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: node }, rules },
  ...pageFiles.map((f) => ({
    files: ['standby/public/js/' + f],
    languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: { ...browser, ...pageGlobals(f) } },
    rules: pageRules,
  })),
  // Test drivers run code in the page too (browser globals), and share
  // helper blocks that not every driver uses.
  { files: ['test/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...browser, ...node } }, rules: { ...rules, 'no-unused-vars': 'off' } },
];
