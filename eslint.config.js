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
module.exports = [
  { ignores: ['**/node_modules/**', 'standby-bundled/**'] },
  { files: ['standby/**/*.js', 'tools/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: node }, rules },
  { files: ['standby/public/**/*.js'], languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: browser }, rules },
  // Test drivers run code in the page too (browser globals), and share
  // helper blocks that not every driver uses.
  { files: ['test/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...browser, ...node } }, rules: { ...rules, 'no-unused-vars': 'off' } },
];
