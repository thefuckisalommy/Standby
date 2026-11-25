#!/usr/bin/env node
'use strict';
// Decrypt a Standby encrypted backup without Standby: for when the device
// is gone, or for whoever holds the file and its password. Node.js 18+, no
// dependencies.
// node decrypt-backup.js standby-backup-2026-11-24.encrypted.json >
// backup.json
// The password is read from the terminal (not echoed) or
// STANDBY_BACKUP_PASSWORD. The output is the plain backup JSON: restore it
// in Standby, or take the signed hexes from state.bitcoin.txs[].hex and
// broadcast them with any wallet or explorer. Treat it like the
// transactions. Format: SECURITY.md and standby/lib/backupcrypto.js.
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

function fail(msg) { process.stderr.write('decrypt-backup: ' + msg + '\n'); process.exit(1); }

function readPassword() {
  if (process.env.STANDBY_BACKUP_PASSWORD) return Promise.resolve(process.env.STANDBY_BACKUP_PASSWORD);
  if (!process.stdin.isTTY) fail('no terminal to ask for the password — set STANDBY_BACKUP_PASSWORD');
  return new Promise((resolve) => {
    process.stderr.write('Backup password: ');
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let pw = '';
    stdin.on('data', (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n'); resolve(pw); return; }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1); else pw += c;
      }
    });
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) fail('usage: node decrypt-backup.js <encrypted backup file> > backup.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('cannot read ' + file + ': ' + e.message); }
  if (!doc || doc.format !== 'standby-backup-encrypted') fail('not an encrypted Standby backup (a plain backup needs no decrypting)');
  if (doc.version !== 1) fail('unsupported version ' + doc.version);
  const { kdf, cipher } = doc;
  if (!kdf || kdf.name !== 'scrypt' || !cipher || cipher.name !== 'aes-256-gcm') fail('unsupported algorithm');
  if (!(kdf.N >= 2 ** 14 && kdf.N <= 2 ** 18 && kdf.r >= 1 && kdf.r <= 16 && kdf.p >= 1 && kdf.p <= 4)) fail('key-derivation settings out of range');

  const password = await readPassword();
  const key = crypto.scryptSync(password, Buffer.from(kdf.salt, 'base64'), 32,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 });
  const data = Buffer.from(doc.data, 'base64');
  const aad = Buffer.from(JSON.stringify([doc.format, doc.version,
    kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt, cipher.name, cipher.iv]), 'utf8');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'base64'));
    d.setAAD(aad);
    d.setAuthTag(data.subarray(data.length - 16));
    plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch (e) {
    fail('wrong password, or the file is damaged');
  }
  let out;
  // Same 64 MB limit as the app's restore, so a crafted file cannot exhaust memory.
  try { out = zlib.gunzipSync(plain, { maxOutputLength: 64 * 1024 * 1024 }); }
  catch (e) { fail('the decrypted contents are not a backup (or are too large)'); }
  process.stdout.write(out.toString('utf8') + '\n');
}

main();
