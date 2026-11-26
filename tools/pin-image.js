#!/usr/bin/env node
'use strict';
// Pin the Umbrel package's images to the release's multi-arch digest:
//   node tools/pin-image.js [--check]
// Reads the version from standby/package.json, asks GHCR (anonymously; the
// image is public) for that tag's image index, checks it covers linux/amd64
// and linux/arm64, and rewrites both image lines in
// standby/docker-compose.yml as ghcr.io/thefuckisalommy/standby:<version>@<digest>,
// as the official Umbrel App Store requires.
// The image workflow runs it after each build and commits the change to
// main; run it by hand the same way. --check only reports whether the
// compose file is already pinned to that digest (exit 1 if not).
// Exits non-zero, changing nothing, when the tag is missing or incomplete.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMPOSE = path.join(ROOT, 'standby', 'docker-compose.yml');
const REPO = 'thefuckisalommy/standby';
const IMAGE = 'ghcr.io/' + REPO;
const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const NEEDED = ['linux/amd64', 'linux/arm64'];

function fail(msg) { console.error('pin-image: ' + msg); process.exit(1); }

async function main() {
  const check = process.argv.includes('--check');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'standby', 'package.json'), 'utf8')).version;
  if (!/^\d+(\.\d+){2,3}$/.test(version)) fail('standby/package.json version "' + version + '" is not a release version');

  const tokenRes = await fetch('https://ghcr.io/token?scope=repository:' + REPO + ':pull');
  if (!tokenRes.ok) fail('GHCR token request answered HTTP ' + tokenRes.status);
  const { token } = await tokenRes.json();
  const res = await fetch('https://ghcr.io/v2/' + REPO + '/manifests/' + version, {
    headers: { Authorization: 'Bearer ' + token, Accept: INDEX_TYPES.join(', ') },
  });
  if (res.status === 404) fail(IMAGE + ':' + version + ' does not exist yet (the image workflow builds it after the version reaches main)');
  if (!res.ok) fail('GHCR answered HTTP ' + res.status + ' for ' + IMAGE + ':' + version);
  const digest = res.headers.get('docker-content-digest');
  const index = await res.json();
  if (!INDEX_TYPES.includes(index.mediaType)) fail(IMAGE + ':' + version + ' is not a multi-arch image index (' + index.mediaType + ')');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest || '')) fail('GHCR gave no usable digest');
  const platforms = (index.manifests || []).map((m) => m.platform && (m.platform.os + '/' + m.platform.architecture));
  const missing = NEEDED.filter((p) => !platforms.includes(p));
  if (missing.length) fail(IMAGE + ':' + version + ' has no ' + missing.join(' or ') + ' image');

  const pinned = IMAGE + ':' + version + '@' + digest;
  const text = fs.readFileSync(COMPOSE, 'utf8');
  const re = /ghcr\.io\/thefuckisalommy\/standby:[0-9.]+(?:@sha256:[0-9a-f]{64})?/g;
  const found = text.match(re) || [];
  if (found.length !== 2) fail('expected 2 image lines in standby/docker-compose.yml, found ' + found.length);
  const next = text.replace(re, pinned);
  if (check) {
    console.log(next === text ? 'pinned: ' + pinned : 'not pinned to ' + pinned);
    process.exit(next === text ? 0 : 1);
  }
  if (next === text) { console.log('already pinned: ' + pinned); return; }
  fs.writeFileSync(COMPOSE, next);
  console.log('pinned: ' + pinned);
}

main().catch((e) => fail(e.message));
