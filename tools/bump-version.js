#!/usr/bin/env node
'use strict';
// Set the app version everywhere it must be written literally, in one step:
//   node tools/bump-version.js 0.8.19 [--notes "What changed."]
// - standby/package.json (the source the app and the tests read)
// - standby/umbrel-app.yml: version, and a new release-notes entry on top
//   (the notes keep the newest KEEP_NOTES releases and point to
//   CHANGELOG.md for the rest)
// - both compose files' image tags
// - CHANGELOG.md: a new section on top
// Without --notes the new entries say "Release notes to come." for you to
// fill in. Writes nothing if the version is malformed or already current.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEEP_NOTES = 4;
const CHANGELOG_URL = 'https://github.com/thefuckisalommy/Standby/blob/main/CHANGELOG.md';

function fail(msg) { console.error('bump-version: ' + msg); process.exit(1); }

const args = process.argv.slice(2);
const version = args[0];
const notesAt = args.indexOf('--notes');
const notes = (notesAt !== -1 && args[notesAt + 1]) ? args[notesAt + 1].trim() : 'Release notes to come.';
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version || '')) fail('usage: node tools/bump-version.js <x.y.z[.w]> [--notes "..."]');

const file = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(file(rel), 'utf8');
const edits = [];

// package.json
const pkg = read('standby/package.json');
const current = JSON.parse(pkg).version;
if (current === version) fail('already at ' + version);
edits.push(['standby/package.json', pkg.replace(/("version":\s*")[^"]+(")/, '$1' + version + '$2')]);

// Compose image tags.
for (const rel of ['docker-compose.yml', 'standby/docker-compose.yml']) {
  const text = read(rel);
  const next = text.replace(/(ghcr\.io\/thefuckisalommy\/standby:)[0-9.]+/g, '$1' + version);
  if (next === text) fail(rel + ': no image tag found');
  edits.push([rel, next]);
}

// Umbrel manifest: version, and release notes trimmed to the newest few.
{
  const text = read('standby/umbrel-app.yml');
  const withVersion = text.replace(/^version: "[^"]*"$/m, 'version: "' + version + '"');
  const m = withVersion.match(/^releaseNotes: \|-\n((?: {2}.*\n|\n)*?)(?=^\S)/m);
  if (!m) fail('standby/umbrel-app.yml: no releaseNotes block');
  const entries = m[1].split(/\n\s*\n/).map((e) => e.trim()).filter((e) => e && !e.startsWith('Older releases:'));
  const kept = [version + ' — ' + notes].concat(entries).slice(0, KEEP_NOTES);
  kept.push('Older releases: ' + CHANGELOG_URL);
  const block = 'releaseNotes: |-\n' + kept.map((e) => '  ' + e).join('\n\n') + '\n';
  edits.push(['standby/umbrel-app.yml', withVersion.replace(m[0], block)]);
}

// CHANGELOG: a new section above the newest.
{
  const text = read('CHANGELOG.md');
  const at = text.search(/^## /m);
  if (at === -1) fail('CHANGELOG.md: no release sections');
  edits.push(['CHANGELOG.md', text.slice(0, at) + '## ' + version + '\n\n' + notes + '\n\n' + text.slice(at)]);
}

for (const [rel, text] of edits) fs.writeFileSync(file(rel), text);
console.log('bump-version: ' + current + ' -> ' + version + ' (' + edits.map((e) => e[0]).join(', ') + ')');
