'use strict';
// Standby — encrypted backups (0.8.12).
//
// A backup holds every signed transaction, and a signed transaction
// is bearer: whoever has the file can broadcast it. Unlike the data
// directory, a backup leaves the device. So the download can be
// encrypted with a password the owner chooses.
//
// Done on the SERVER, not in the browser: on Umbrel the page is
// served over plain HTTP on the LAN, so browser-side encryption would
// first send every signed transaction across the network in the
// clear. Encrypted here, the plaintext backup never leaves the device.
//
// Format (a JSON file, documented in SECURITY.md):
//   {
//     "format": "standby-backup-encrypted", "version": 1,
//     "kdf":    { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": <base64, 16 bytes> },
//     "cipher": { "name": "aes-256-gcm", "iv": <base64, 12 bytes> },
//     "data":   <base64 of ciphertext || 16-byte GCM tag>
//   }
// The plaintext is the ordinary standby-backup JSON, gzipped. The
// header (everything but `data`) is the GCM additional data, so the
// KDF settings, salt and IV cannot be altered without detection.
// Nothing about the contents (labels, counts, dates) is in the clear.
//
// tools/decrypt-backup.js (repo root) decrypts this format with no
// Standby install — keep the two in step.
const crypto = require('crypto');
const zlib = require('zlib');

const FORMAT = 'standby-backup-encrypted';
const VERSION = 1;
const KDF_DEFAULT = { N: 2 ** 17, r: 8, p: 1 }; // ~128 MB, about a second on a Raspberry Pi
// Accepted on restore. The cap stops a crafted file from making the
// device allocate an absurd amount of memory (N=2^18, r=8: 256 MB).
const N_MIN = 2 ** 14, N_MAX = 2 ** 18, R_MIN = 1, R_MAX = 16, P_MIN = 1, P_MAX = 4;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

class BackupCryptoError extends Error {}

function passwordProblem(password) {
  if (typeof password !== 'string' || !password) return 'a backup password is required';
  if (password.length < MIN_PASSWORD_LENGTH) return 'the backup password must be at least ' + MIN_PASSWORD_LENGTH + ' characters';
  if (password.length > MAX_PASSWORD_LENGTH) return 'the backup password is too long';
  return null;
}

function scryptAsync(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// The additional authenticated data: the header fields in a fixed
// order, so encrypt and decrypt (and the standalone tool) agree.
function aadOf(header) {
  return Buffer.from(JSON.stringify([header.format, header.version,
    header.kdf.name, header.kdf.N, header.kdf.r, header.kdf.p, header.kdf.salt,
    header.cipher.name, header.cipher.iv]), 'utf8');
}

async function encryptBackup(backupDoc, password) {
  const problem = passwordProblem(password);
  if (problem) throw new BackupCryptoError(problem);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = {
    format: FORMAT, version: VERSION,
    kdf: { name: 'scrypt', ...KDF_DEFAULT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
  };
  const key = await scryptAsync(password, salt, KDF_DEFAULT);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(backupDoc), 'utf8'));
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(header));
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { ...header, data: data.toString('base64') };
}

function isEncryptedBackup(doc) {
  return !!doc && typeof doc === 'object' && doc.format === FORMAT;
}

function b64(v, name, wantLen) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new BackupCryptoError('encrypted backup: bad ' + name);
  const buf = Buffer.from(v, 'base64');
  if (wantLen !== undefined && buf.length !== wantLen) throw new BackupCryptoError('encrypted backup: bad ' + name);
  return buf;
}

// Validates the envelope, then decrypts. Throws BackupCryptoError
// with a message fit for the owner; a wrong password and a damaged
// file are indistinguishable by design (GCM says only "no").
async function decryptBackup(doc, password) {
  if (!isEncryptedBackup(doc)) throw new BackupCryptoError('not an encrypted Standby backup');
  if (doc.version !== VERSION) throw new BackupCryptoError('unsupported encrypted backup version: ' + doc.version);
  const kdf = doc.kdf || {};
  const cipher = doc.cipher || {};
  if (kdf.name !== 'scrypt' || cipher.name !== 'aes-256-gcm') throw new BackupCryptoError('encrypted backup: unsupported algorithm');
  const isPow2 = (n) => Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
  if (!isPow2(kdf.N) || kdf.N < N_MIN || kdf.N > N_MAX
      || !Number.isSafeInteger(kdf.r) || kdf.r < R_MIN || kdf.r > R_MAX
      || !Number.isSafeInteger(kdf.p) || kdf.p < P_MIN || kdf.p > P_MAX) {
    throw new BackupCryptoError('encrypted backup: key-derivation settings out of range');
  }
  const salt = b64(kdf.salt, 'salt');
  if (salt.length < 16 || salt.length > 64) throw new BackupCryptoError('encrypted backup: bad salt');
  const iv = b64(cipher.iv, 'iv', 12);
  const data = b64(doc.data, 'data');
  if (data.length < 17) throw new BackupCryptoError('encrypted backup: bad data');
  if (typeof password !== 'string' || !password) throw new BackupCryptoError('this backup is encrypted — enter its password');
  if (password.length > MAX_PASSWORD_LENGTH) throw new BackupCryptoError('wrong password, or the backup file is damaged');

  const key = await scryptAsync(password, salt, { N: kdf.N, r: kdf.r, p: kdf.p });
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(aadOf({ format: doc.format, version: doc.version, kdf, cipher }));
    d.setAuthTag(data.subarray(data.length - 16));
    plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch (e) {
    throw new BackupCryptoError('wrong password, or the backup file is damaged');
  }
  try {
    // Bounded inflate: a valid file was made by us, but cap it anyway.
    return JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
  } catch (e) {
    throw new BackupCryptoError('encrypted backup: the decrypted contents are not a backup');
  }
}

module.exports = {
  FORMAT, VERSION, KDF_DEFAULT, MIN_PASSWORD_LENGTH, BackupCryptoError,
  passwordProblem, encryptBackup, decryptBackup, isEncryptedBackup,
};
