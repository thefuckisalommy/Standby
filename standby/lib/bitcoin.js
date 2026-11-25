'use strict';
// Bitcoin: transaction parsing, dry runs, broadcasts, node reads. Node
// built-ins only.
// Nodes are two endpoints, each a mempool API or Bitcoin Core RPC
// (lib/rpc.js), tried in order; a blank secondary means primary only.
// A completed check is definitive (a spent input is a chain fact); only a
// failed check falls through to the next endpoint.
// Hard rules: never accept, store or log wallet keys or seeds (an RPC
// login is stored for the node, never served or logged); the
// stored signed hex reveals destinations and amounts, so only a short
// preview is ever logged; a broadcast is irrevocable and only the release
// evaluation may trigger one.

const crypto = require('crypto');
const { MEMPOOL_OVERRIDE, PRICE_API_URL_OVERRIDE, SLIPSTREAM_API_URL_OVERRIDE } = require('./config');
const { requestText, NET_TIMEOUT_MS } = require('./net');
const rpc = require('./rpc');
const { appendBroadcastLog, sanitizeFeeHistory, FEE_HISTORY_WINDOW_DAYS, FEE_HISTORY_MIN_OBSERVATIONS, FEE_HISTORY_MAX_ENTRIES } = require('./store');

const MAX_TX_BYTES = 1000000; // 1 MB, same ceiling as the API body limit

// Node endpoints come from settings. MEMPOOL_HOST / MEMPOOL_PORT /
// MEMPOOL_PROTOCOL override the primary (lib/config.js); there is no
// override for the secondary.
const DEFAULT_PUBLIC_API_URL = 'https://mempool.space';
const DEFAULT_SECONDARY_API_URL = 'https://blockstream.info/api';

// Normalise a user-supplied endpoint to "protocol://host[:port]" (no
// path — the app appends /api/... itself). A bare host gets https://.
// Throws on anything that is not a usable http(s) URL.
function normalizePublicApiUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return DEFAULT_PUBLIC_API_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('invalid node URL: ' + raw); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('node URL must be http(s): ' + raw);
  if (!u.hostname) throw new Error('node URL needs a host: ' + raw);
  return u.protocol + '//' + u.host;
}

function mempoolBase(settings) {
  if (MEMPOOL_OVERRIDE) return MEMPOOL_OVERRIDE;
  return normalizePublicApiUrl(settings && settings.primaryApiUrl);
}

// The secondary endpoint, or null when the setting is blank (primary
// runs alone). A blank setting is "no secondary", not the default.
function mempoolSecondaryBase(settings) {
  const v = settings && typeof settings.secondaryApiUrl === 'string' ? settings.secondaryApiUrl.trim() : '';
  if (!v) return null;
  return normalizePublicApiUrl(v);
}

// Absolute locktime only: timelocked while locktime != 0, some input
// sequence is below 0xffffffff, and the locktime (a height below
// 500,000,000, else a Unix time) has not passed. Timestamps are compared
// to wall-clock time, not median time past; the broadcast retry covers the
// gap. Relative and script timelocks are not evaluated. Returns {
// timelocked, until }.
function timelockedUntil(tx, tipHeight, now) {
  const locktime = tx.locktime || 0;
  if (!locktime) return { timelocked: false, until: null };
  const anySeq = (tx.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff);
  if (!anySeq) return { timelocked: false, until: null };
  if (locktime < 500000000) {
    if (tipHeight == null) return { timelocked: false, until: null };
    return tipHeight < locktime ? { timelocked: true, until: locktime } : { timelocked: false, until: null };
  }
  const until = new Date(locktime * 1000);
  return now.getTime() < locktime * 1000 ? { timelocked: true, until } : { timelocked: false, until: null };
}

// The endpoints in the order they are tried. A secondary identical to
// the primary is dropped — trying the same server twice buys nothing.
function endpointsFor(settings) {
  const s = settings || {};
  const primaryRpc = rpc.settingBase(s.primaryRpc);
  if (primaryRpc) rpc.register(primaryRpc, s.primaryRpc.user, s.primaryRpc.password);
  const eps = [{ label: 'primary', base: primaryRpc || mempoolBase(s) }];
  // Secondary disabled: return the primary alone. Every endpoint consumer
  // reads from here, so this is the whole enforcement. A missing flag
  // means enabled.
  if (s.secondaryEnabled === false) return eps;
  const secondaryRpc = rpc.settingBase(s.secondaryRpc);
  const sec = secondaryRpc || mempoolSecondaryBase(s);
  // The same node twice is tried once, with the primary's login.
  if (sec && sec !== eps[0].base) {
    if (secondaryRpc) rpc.register(secondaryRpc, s.secondaryRpc.user, s.secondaryRpc.password);
    eps.push({ label: 'secondary', base: sec });
  }
  return eps;
}

// Each node slot's base as configured (the secondary even while it is
// switched off), for the UI to match test results to its rows.
function nodeBases(settings) {
  const s = settings || {};
  return {
    primary: rpc.settingBase(s.primaryRpc) || mempoolBase(s),
    secondary: rpc.settingBase(s.secondaryRpc) || mempoolSecondaryBase(s),
  };
}

// "host[:port]" for messages and log notes (never the full URL twice).
function mempoolHostLabel(base) {
  try { return new URL(base).host; } catch { return base; }
}

function readVarint(buf, off) {
  if (off >= buf.length) throw new Error('truncated varint');
  const first = buf[off];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    if (off + 3 > buf.length) throw new Error('truncated varint');
    return { value: buf.readUInt16LE(off + 1), size: 3 };
  }
  if (first === 0xfe) {
    if (off + 5 > buf.length) throw new Error('truncated varint');
    return { value: buf.readUInt32LE(off + 1), size: 5 };
  }
  if (off + 9 > buf.length) throw new Error('truncated varint');
  const lo = buf.readUInt32LE(off + 1);
  const hi = buf.readUInt32LE(off + 5);
  const value = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(value) || value > 1e9) throw new Error('varint too large');
  return { value, size: 9 };
}

// Parse a raw signed transaction (legacy or segwit) and compute its txid.
// Throws on anything that is not a well-formed transaction. Returns:
// { txid, version, segwit, inputs, outputs, totalOutSats, locktime, size, vsize }
function parseTx(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('transaction must be a hex string');
  }
  if (hex.length % 2 !== 0) throw new Error('transaction hex must have an even length');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 10) throw new Error('transaction too short');
  if (buf.length > MAX_TX_BYTES) throw new Error('transaction too large');

  let off = 0;
  const version = buf.readUInt32LE(off); off += 4;

  // Segwit marker (0x00) + flag (0x01) sit between version and inputs.
  let segwit = false;
  let inputsStart = off;
  if (buf[off] === 0x00 && buf[off + 1] === 0x01) {
    segwit = true;
    off += 2;
    inputsStart = off;
  }

  const vin = readVarint(buf, off); off += vin.size;
  if (vin.value === 0 || vin.value > 10000) throw new Error('implausible input count');
  const inputs = [];
  for (let i = 0; i < vin.value; i++) {
    if (off + 36 > buf.length) throw new Error('truncated input');
    const prevTxid = Buffer.from(buf.subarray(off, off + 32)).reverse().toString('hex');
    off += 32;
    const prevVout = buf.readUInt32LE(off); off += 4;
    const sl = readVarint(buf, off); off += sl.size;
    if (off + sl.value + 4 > buf.length) throw new Error('truncated input script');
    off += sl.value;
    const sequence = buf.readUInt32LE(off); off += 4;
    inputs.push({ prevTxid, prevVout, sequence });
  }

  const vout = readVarint(buf, off); off += vout.size;
  if (vout.value === 0 || vout.value > 10000) throw new Error('implausible output count');
  const outputs = [];
  let totalOut = 0n;
  for (let i = 0; i < vout.value; i++) {
    if (off + 8 > buf.length) throw new Error('truncated output');
    const value = buf.readBigUInt64LE(off); off += 8;
    const sl = readVarint(buf, off); off += sl.size;
    if (off + sl.value > buf.length) throw new Error('truncated output script');
    const script = buf.subarray(off, off + sl.value).toString('hex');
    off += sl.value;
    totalOut += value;
    outputs.push({ value: value.toString(), script });
  }
  const outputsEnd = off;

  if (segwit) {
    // Witness data: one stack per input. Skipped for the txid, which
    // commits to the non-witness serialization only.
    for (let i = 0; i < vin.value; i++) {
      const n = readVarint(buf, off); off += n.size;
      if (n.value > 10000) throw new Error('implausible witness stack size');
      for (let j = 0; j < n.value; j++) {
        const l = readVarint(buf, off); off += l.size;
        if (off + l.value > buf.length) throw new Error('truncated witness data');
        off += l.value;
      }
    }
  }

  if (off + 4 !== buf.length) throw new Error('trailing bytes after locktime');
  const locktime = buf.readUInt32LE(off);

  // txid = double-SHA256 of the serialization WITHOUT marker/flag/witness,
  // byte-reversed for display.
  const stripped = Buffer.concat([
    buf.subarray(0, 4),
    buf.subarray(inputsStart, outputsEnd),
    buf.subarray(off, off + 4),
  ]);
  const hash = crypto.createHash('sha256').update(stripped).digest();
  const txid = crypto.createHash('sha256').update(hash).digest().reverse().toString('hex');

  return {
    txid,
    version,
    segwit,
    inputs,
    outputs,
    totalOutSats: totalOut.toString(),
    locktime,
    size: buf.length,
    // vsize: the serialized size, or for segwit ceil((3 * base + total) /
    // 4), where base is the `stripped` serialization without witness data.
    vsize: segwit ? Math.ceil((3 * stripped.length + buf.length) / 4) : buf.length,
  };
}

// PSBT (BIP 174) import. extractTxFromPsbt(data) takes raw bytes, base64,
// or raw bytes as latin1 (the JSON API carries text) and returns { hex,
// txid } for a fully signed PSBT; anything else throws, naming the inputs
// missing signatures. A partially signed PSBT is never added.
// Finalized from partial signatures: P2PKH, P2WPKH, P2SH-P2WPKH, P2SH and
// P2WSH multisig, P2WSH single-key. Existing final fields are used only
// after they are checked against the spent script type, so an empty final
// field is never accepted. Unknown script types (taproot) need a non-empty
// final field.
const PSBT_MAGIC = Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]); // 'psbt\xff'
const MAX_PSBT_BYTES = 1024 * 1024; // 1 MB — the API body is capped at 1 MB too

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function pushData(buf) {
  if (buf.length < 0x4c) return Buffer.concat([Buffer.from([buf.length]), buf]);
  if (buf.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]);
  const len = Buffer.alloc(2); len.writeUInt16LE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x4d]), len, buf]);
}

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function serVarint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

// Read one <key,value> map starting at off. Returns { map, next }
// where map is [{ type, keydata, value }] and next is the offset just
// past the 0x00 terminator.
function readPsbtMap(buf, off) {
  const map = [];
  for (;;) {
    if (off >= buf.length) throw new Error('PSBT is truncated (a map has no terminator)');
    const kl = readVarint(buf, off); off += kl.size;
    if (kl.value === 0) break; // map terminator
    if (off + kl.value > buf.length) throw new Error('PSBT is truncated (a key overruns the buffer)');
    const key = buf.subarray(off, off + kl.value); off += kl.value;
    const vl = readVarint(buf, off); off += vl.size;
    if (off + vl.value > buf.length) throw new Error('PSBT is truncated (a value overruns the buffer)');
    const value = buf.subarray(off, off + vl.value); off += vl.value;
    if (key.length === 0) throw new Error('PSBT has a key with no type byte');
    map.push({ type: key[0], keydata: Buffer.from(key.subarray(1)), value: Buffer.from(value) });
  }
  return { map, next: off };
}

// A final_script_witness value is a serialized witness stack:
// <count varint> then per item <len varint><bytes>.
function parseWitnessStack(buf) {
  let off = 0;
  const n = readVarint(buf, off); off += n.size;
  if (n.value > 10000) throw new Error('PSBT witness stack is implausibly large');
  const items = [];
  for (let i = 0; i < n.value; i++) {
    const l = readVarint(buf, off); off += l.size;
    if (off + l.value > buf.length) throw new Error('PSBT witness stack is truncated');
    items.push(Buffer.from(buf.subarray(off, off + l.value))); off += l.value;
  }
  if (off !== buf.length) throw new Error('PSBT witness stack has trailing bytes');
  return items;
}

// { m, pubkeys } for OP_M <pubkey>... OP_N OP_CHECKMULTISIG, or null
// when the script is not a multisig. OP_1..OP_16 are 0x51..0x60,
// OP_CHECKMULTISIG is 0xae.
function parseMultisigScript(script) {
  if (script.length < 3) return null;
  const mOp = script[0];
  if (mOp < 0x51 || mOp > 0x60) return null;
  const m = mOp - 0x50;
  let off = 1;
  const pubkeys = [];
  while (off < script.length) {
    const op = script[off];
    if (op >= 0x51 && op <= 0x60) {
      const n = op - 0x50;
      if (off + 2 !== script.length || script[off + 1] !== 0xae) return null;
      if (n < m || n > 16 || pubkeys.length !== n) return null;
      return { m, pubkeys };
    }
    if (op !== 0x21 && op !== 0x41) return null; // 33- or 65-byte pubkey push
    if (off + 1 + op > script.length) return null;
    pubkeys.push(Buffer.from(script.subarray(off + 1, off + 1 + op)));
    off += 1 + op;
  }
  return null;
}

// The scriptPubKey an input spends, from witness_utxo, else the
// non_witness_utxo parent. Null without either: then only final scripts
// can finalize it.
function inputScriptPubKey(inputMap, prevVout) {
  const wit = inputMap.find((e) => e.type === 0x01);
  if (wit) {
    if (wit.value.length < 8) throw new Error('witness_utxo is truncated');
    let off = 8;
    const sl = readVarint(wit.value, off); off += sl.size;
    if (off + sl.value > wit.value.length) throw new Error('witness_utxo script overruns its value');
    return Buffer.from(wit.value.subarray(off, off + sl.value));
  }
  const nonwit = inputMap.find((e) => e.type === 0x00);
  if (nonwit) {
    let prev;
    try { prev = parseTx(nonwit.value.toString('hex')); }
    catch (e) { throw new Error('non_witness_utxo does not parse: ' + e.message); }
    const out = prev.outputs[prevVout];
    if (!out) throw new Error('non_witness_utxo has no output ' + prevVout);
    return Buffer.from(out.script, 'hex');
  }
  return null;
}

// Finalize one input: { scriptSig, witness }. Throws a message naming the
// input (and signatures had vs needed) for the not-fully-signed report.
function finalizePsbtInput(inputMap, scriptPubKey, index) {
  const at = 'input ' + index;
  const finalSig = inputMap.find((e) => e.type === 0x07);
  const finalWit = inputMap.find((e) => e.type === 0x08);
  if (finalSig || finalWit) {
    // A final field is only trusted if it matches the spent script type:
    // an empty one would build a transaction the nodes reject.
    let witItems = null;
    if (finalWit) {
      try { witItems = parseWitnessStack(finalWit.value); }
      catch (e) { throw new Error(at + ' has a malformed final_scriptWitness (' + e.message + ')'); }
    }
    const hasSig = !!(finalSig && finalSig.value.length > 0);
    const hasWit = !!(witItems && witItems.length > 0);
    const isP2pkh = scriptPubKey && scriptPubKey.length === 25 && scriptPubKey[0] === 0x76 && scriptPubKey[1] === 0xa9
      && scriptPubKey[2] === 0x14 && scriptPubKey[23] === 0x88 && scriptPubKey[24] === 0xac;
    const isP2wpkh = scriptPubKey && scriptPubKey.length === 22 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x14;
    const isP2sh = scriptPubKey && scriptPubKey.length === 23 && scriptPubKey[0] === 0xa9 && scriptPubKey[1] === 0x14 && scriptPubKey[22] === 0x87;
    const isP2wsh = scriptPubKey && scriptPubKey.length === 34 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x20;
    if (isP2pkh) {
      if (!hasSig) throw new Error(at + ' is a P2PKH input with no final_scriptSig, so it is not fully signed');
      if (hasWit) throw new Error(at + ' is a P2PKH input with a final_scriptWitness, which it should not have');
    } else if (isP2wpkh) {
      if (!hasWit) throw new Error(at + ' is a P2WPKH input with no final_scriptWitness, so it is not fully signed');
      if (witItems.length !== 2) throw new Error(at + ' is a P2WPKH input whose final_scriptWitness does not have exactly 2 items (signature + pubkey)');
      if (hasSig) throw new Error(at + ' is a P2WPKH input with a final_scriptSig, which it should not have');
    } else if (isP2sh) {
      const redeemEntry = inputMap.find((e) => e.type === 0x04);
      const redeem = redeemEntry ? redeemEntry.value : null;
      if (redeem && redeem.length === 22 && redeem[0] === 0x00 && redeem[1] === 0x14) {
        // P2SH-P2WPKH: the redeem script goes in the scriptSig,
        // the signature + pubkey in the witness.
        if (!hasSig) throw new Error(at + ' is a P2SH-P2WPKH input with no final_scriptSig, so it is not fully signed');
        if (!hasWit) throw new Error(at + ' is a P2SH-P2WPKH input with no final_scriptWitness, so it is not fully signed');
      } else if (redeem && parseMultisigScript(redeem)) {
        if (!hasSig) throw new Error(at + ' is a P2SH multisig input with no final_scriptSig, so it is not fully signed');
        if (hasWit) throw new Error(at + ' is a P2SH multisig input with a final_scriptWitness, which it should not have');
      } else {
        // Another redeem type, or no redeem_script: do not guess
        // further — require at least one non-empty final field.
        if (!hasSig && !hasWit) throw new Error(at + ' has no usable final_scriptSig or final_scriptWitness, so it is not fully signed');
      }
    } else if (isP2wsh) {
      if (!hasWit) throw new Error(at + ' is a P2WSH input with no final_scriptWitness, so it is not fully signed');
      if (hasSig) throw new Error(at + ' is a P2WSH input with a final_scriptSig, which it should not have');
    } else {
      // Unknown script type (taproot) or no spent-output info: accept if
      // at least one final field is non-empty.
      if (!hasSig && !hasWit) throw new Error(at + ' has no usable final_scriptSig or final_scriptWitness, so it is not fully signed');
    }
    return {
      scriptSig: hasSig ? finalSig.value : Buffer.alloc(0),
      witness: hasWit ? witItems : [],
    };
  }
  const partials = new Map(); // pubkey hex -> signature Buffer
  for (const e of inputMap) {
    if (e.type === 0x02) partials.set(e.keydata.toString('hex'), e.value);
  }
  if (!scriptPubKey) {
    throw new Error(at + ' cannot be finalized: no final scripts, and no spent-output info (witness_utxo / non_witness_utxo) to match signatures against');
  }
  const sigFor = (pubkey) => partials.get(pubkey.toString('hex')) || null;
  const sigForHash = (hash20) => {
    for (const [pkHex, sig] of partials) {
      const pk = Buffer.from(pkHex, 'hex');
      if (hash160(pk).equals(hash20)) return { sig, pubkey: pk };
    }
    return null;
  };
  // P2PKH: 76 a9 14 <20-byte hash> 88 ac.
  if (scriptPubKey.length === 25 && scriptPubKey[0] === 0x76 && scriptPubKey[1] === 0xa9
      && scriptPubKey[2] === 0x14 && scriptPubKey[23] === 0x88 && scriptPubKey[24] === 0xac) {
    const found = sigForHash(scriptPubKey.subarray(3, 23));
    if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
    return { scriptSig: Buffer.concat([pushData(found.sig), pushData(found.pubkey)]), witness: [] };
  }
  // P2WPKH: 00 14 <20-byte hash>.
  if (scriptPubKey.length === 22 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x14) {
    const found = sigForHash(scriptPubKey.subarray(2, 22));
    if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
    return { scriptSig: Buffer.alloc(0), witness: [found.sig, found.pubkey] };
  }
  // P2SH: a9 14 <20-byte hash> 87. The redeem script decides the rest.
  if (scriptPubKey.length === 23 && scriptPubKey[0] === 0xa9 && scriptPubKey[1] === 0x14 && scriptPubKey[22] === 0x87) {
    const redeemEntry = inputMap.find((e) => e.type === 0x04);
    if (!redeemEntry) throw new Error(at + ' is a P2SH input with no redeem_script, so it cannot be finalized');
    const redeem = redeemEntry.value;
    if (!hash160(redeem).equals(scriptPubKey.subarray(2, 22))) {
      throw new Error(at + ' has a redeem_script that does not match the spent output');
    }
    // P2SH-P2WPKH: the redeem script is itself a P2WPKH script.
    if (redeem.length === 22 && redeem[0] === 0x00 && redeem[1] === 0x14) {
      const found = sigForHash(redeem.subarray(2, 22));
      if (!found) throw new Error(at + ' is missing its signature (has 0 of 1)');
      return { scriptSig: pushData(redeem), witness: [found.sig, found.pubkey] };
    }
    const ms = parseMultisigScript(redeem);
    if (ms) {
      const sigs = [];
      for (const pk of ms.pubkeys) {
        const sig = sigFor(pk);
        if (sig) sigs.push(sig);
        if (sigs.length === ms.m) break;
      }
      if (sigs.length < ms.m) throw new Error(at + ' is missing ' + (ms.m - sigs.length) + ' of ' + ms.m + ' signatures (has ' + sigs.length + ' of ' + ms.m + ')');
      const parts = [Buffer.from([0x00])];
      for (const s of sigs) parts.push(pushData(s));
      parts.push(pushData(redeem));
      return { scriptSig: Buffer.concat(parts), witness: [] };
    }
    throw new Error(at + ' has an unsupported redeem_script type, so it cannot be finalized');
  }
  // P2WSH: 00 20 <32-byte hash>. The witness script decides the rest.
  if (scriptPubKey.length === 34 && scriptPubKey[0] === 0x00 && scriptPubKey[1] === 0x20) {
    const witEntry = inputMap.find((e) => e.type === 0x05);
    if (!witEntry) throw new Error(at + ' is a P2WSH input with no witness_script, so it cannot be finalized');
    const wscript = witEntry.value;
    const hash = crypto.createHash('sha256').update(wscript).digest();
    if (!hash.equals(scriptPubKey.subarray(2, 34))) {
      throw new Error(at + ' has a witness_script that does not match the spent output');
    }
    const ms = parseMultisigScript(wscript);
    if (ms) {
      const sigs = [];
      for (const pk of ms.pubkeys) {
        const sig = sigFor(pk);
        if (sig) sigs.push(sig);
        if (sigs.length === ms.m) break;
      }
      if (sigs.length < ms.m) throw new Error(at + ' is missing ' + (ms.m - sigs.length) + ' of ' + ms.m + ' signatures (has ' + sigs.length + ' of ' + ms.m + ')');
      return { scriptSig: Buffer.alloc(0), witness: [Buffer.alloc(0), ...sigs] };
    }
    // Single-key P2WSH: <pubkey> OP_CHECKSIG — the witness is just the signature.
    if (wscript.length === 35 && wscript[0] === 0x21 && wscript[34] === 0xac) {
      const pk = wscript.subarray(1, 34);
      const sig = sigFor(pk);
      if (!sig) throw new Error(at + ' is missing its signature (has 0 of 1)');
      return { scriptSig: Buffer.alloc(0), witness: [sig] };
    }
    throw new Error(at + ' has an unsupported witness_script type, so it cannot be finalized');
  }
  throw new Error(at + ' has an unsupported script type, so it cannot be finalized');
}

// The raw hex of a fully signed PSBT; throws a clear error otherwise.
function extractTxFromPsbt(data) {
  let buf;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (typeof data === 'string') {
    const s = data.trim();
    if (!s) throw new Error('empty PSBT');
    const b64 = s.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
      const dec = Buffer.from(b64, 'base64');
      if (dec.length >= 5 && dec.subarray(0, 5).equals(PSBT_MAGIC)) buf = dec;
    }
    if (!buf) buf = Buffer.from(s, 'latin1'); // raw binary PSBT sent as text
  } else {
    throw new Error('PSBT must be a Buffer or a string');
  }
  if (buf.length > MAX_PSBT_BYTES) throw new Error('PSBT too large');
  if (buf.length < 5 || !buf.subarray(0, 5).equals(PSBT_MAGIC)) {
    throw new Error('not a PSBT file — import a fully-signed PSBT (.psbt) or a plain hex file');
  }
  let off = 5;
  const g = readPsbtMap(buf, off); off = g.next;
  const unsignedEntry = g.map.find((e) => e.type === 0x00);
  if (!unsignedEntry) throw new Error('PSBT has no unsigned transaction');
  let unsigned;
  try { unsigned = parseTx(unsignedEntry.value.toString('hex')); }
  catch (e) { throw new Error('PSBT unsigned transaction does not parse: ' + e.message); }
  const inputMaps = [];
  for (let i = 0; i < unsigned.inputs.length; i++) {
    const m = readPsbtMap(buf, off); off = m.next;
    inputMaps.push(m.map);
  }
  for (let i = 0; i < unsigned.outputs.length; i++) {
    const m = readPsbtMap(buf, off); off = m.next;
  }
  if (off !== buf.length) throw new Error('PSBT has trailing bytes after the output maps');
  const missing = [];
  const finals = [];
  for (let i = 0; i < unsigned.inputs.length; i++) {
    let spk = null;
    try { spk = inputScriptPubKey(inputMaps[i], unsigned.inputs[i].prevVout); }
    catch (e) { missing.push('input ' + i + ' has an unreadable spent output (' + e.message + ')'); finals.push(null); continue; }
    try { finals.push(finalizePsbtInput(inputMaps[i], spk, i)); }
    catch (e) { missing.push(e.message); finals.push(null); }
  }
  if (missing.length) {
    throw new Error('PSBT is not fully signed: ' + missing.join('; '));
  }
  // Serialize the final transaction (segwit when any input carries a
  // witness) and validate it exactly like a pasted hex.
  const segwit = finals.some((f) => f.witness.length > 0);
  const parts = [u32le(unsigned.version)];
  if (segwit) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(serVarint(unsigned.inputs.length));
  for (let i = 0; i < unsigned.inputs.length; i++) {
    const inp = unsigned.inputs[i];
    parts.push(Buffer.from(inp.prevTxid, 'hex').reverse());
    parts.push(u32le(inp.prevVout));
    const sig = finals[i].scriptSig;
    parts.push(serVarint(sig.length), sig);
    parts.push(u32le(inp.sequence));
  }
  parts.push(serVarint(unsigned.outputs.length));
  for (const out of unsigned.outputs) {
    parts.push(u64le(out.value));
    const script = Buffer.from(out.script, 'hex');
    parts.push(serVarint(script.length), script);
  }
  if (segwit) {
    for (let i = 0; i < unsigned.inputs.length; i++) {
      const wit = finals[i].witness;
      parts.push(serVarint(wit.length));
      for (const item of wit) parts.push(serVarint(item.length), item);
    }
  }
  parts.push(u32le(unsigned.locktime));
  const hex = Buffer.concat(parts).toString('hex');
  const parsed = parseTx(hex);
  return { hex, txid: parsed.txid };
}

function mempoolReq(path, method, body, base, timeoutMs, contentType) {
  const key = base || DEFAULT_PUBLIC_API_URL;
  const p = rpc.isRpcBase(key)
    ? rpc.answer(path, method || 'GET', body, key, timeoutMs, Object.values(ESPLORA_FEE_TARGETS))
    : restReq(path, method, body, key, timeoutMs, contentType);
  // Stamp the endpoint on any answer (any status); a timeout, refusal
  // or DNS error stamps nothing. The derived promise's catch only prevents
  // an unhandled rejection.
  p.then(() => { nodeCheckedAtByBase[key] = new Date().toISOString(); }, () => {});
  return p;
}

function restReq(path, method, body, base, timeoutMs, contentType) {
  const u = new URL(base);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': contentType || 'text/plain' } : {},
    body,
    timeoutMs,
  });
}

// Per-endpoint last-answered stamps (the secondary is only asked on
// fallback, so the rows need their own times); folded into the stored
// connection before a save.
const nodeCheckedAtByBase = {};
function nodeCheckedAt() { return { ...nodeCheckedAtByBase }; }

// Fee verdict: is a transaction's fixed fee good enough for a long hold?
// It is compared with the 90-day peak (90th percentile of Standby's own
// hourly economy-fee readings, lib/release.js) and the current economy
// fee, both from the configured nodes. See feeVerdict.

// The 90th percentile of a sorted ascending array of numbers
// (linear interpolation, the standard definition). Returns null
// when there is nothing to measure.
function percentile90(sorted) {
  if (!sorted || !sorted.length) return null;
  const k = (sorted.length - 1) * 0.9;
  const f = Math.floor(k), c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] * (c - k) + sorted[c] * (k - f);
}

// The 90-day peak: the 90th percentile of the readings (a max would let
// one spike mark every fee High Risk). It stays null until
// FEE_HISTORY_MIN_OBSERVATIONS readings span a full day, so restarts
// cannot fake a peak. windowDays is the span covered; fetchedAt the latest
// reading.
function feePeakFromObservations(observations, nowMs) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const cutoff = now - FEE_HISTORY_WINDOW_DAYS * 86400000;
  const fees = [];
  let firstTs = null, lastTs = null;
  if (Array.isArray(observations)) {
    for (const e of observations) {
      if (!e || typeof e !== 'object') continue;
      const t = (typeof e.t === 'string' && e.t) ? new Date(e.t).getTime() : NaN;
      const fee = e.fee;
      if (!Number.isFinite(t) || t <= cutoff || t > now + 60000) continue;
      if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) continue;
      fees.push(fee);
      if (firstTs === null || t < firstTs) firstTs = t;
      if (lastTs === null || t > lastTs) lastTs = t;
    }
  }
  const count = fees.length;
  const windowDays = (firstTs === null || lastTs === null) ? 0
    : Math.min(FEE_HISTORY_WINDOW_DAYS, Math.ceil((lastTs - firstTs) / 86400000));
  const fetchedAt = (lastTs === null) ? null : new Date(lastTs).toISOString();
  // A full day on the raw span: the 25th hourly reading is the first a
  // full day after the first. A count alone would let restarts fake a
  // peak.
  const spanMs = (firstTs === null || lastTs === null) ? 0 : (lastTs - firstTs);
  if (count < FEE_HISTORY_MIN_OBSERVATIONS || spanMs < 86400000) return { peak: null, windowDays, observations: count, fetchedAt };
  fees.sort((a, b) => a - b);
  return { peak: percentile90(fees), windowDays, observations: count, fetchedAt };
}

// Append one { t, fee } reading. Pure. Prunes past the window and caps the
// size; at most one reading per hour (this is the single place every
// recording goes through, so restarts cannot add extra readings).
function appendFeeHistoryObservation(observations, fee, nowMs) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const next = sanitizeFeeHistory(Array.isArray(observations) ? observations : [], now);
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) return next;
  const last = next[next.length - 1];
  if (last) {
    const lastT = new Date(last.t).getTime();
    if (Number.isFinite(lastT) && now - lastT < 3600000) return next;
  }
  next.push({ t: new Date(now).toISOString(), fee });
  return next.slice(-FEE_HISTORY_MAX_ENTRIES);
}

// Every node type reports the same 'economy' fee: mempool's economyFee is
// a ~1-day estimate, so Esplora's /fee-estimates is read at the 144-block
// target and mapped to the mempool tier shape. Targets: fastest 1, half-
// hour 3, hour 6, economy 144, minimum 1008.
const ESPLORA_FEE_TARGETS = { fastest: 1, halfHour: 3, hour: 6, economy: 144, minimum: 1008 };

// 1 sat/vB, the minimum relay fee. Esplora estimates can drift below it
// (they are historical); mempool tiers never do.
const MIN_FEE_RATE_SATVB = 1;

// The rate at exactly this target, or null: never a neighbouring target,
// which would mix horizons into the fee history. A present rate is floored
// at MIN_FEE_RATE_SATVB.
function feeEstimateAtTarget(estimates, target) {
  if (!estimates || typeof estimates !== 'object') return null;
  const v = estimates[String(target)];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.max(v, MIN_FEE_RATE_SATVB);
}

// Esplora /fee-estimates to the mempool tier shape; null without a usable
// economy rate.
function feeEstimatesToRecommended(estimates) {
  if (!estimates || typeof estimates !== 'object') return null;
  const out = {};
  for (const [tier, target] of Object.entries(ESPLORA_FEE_TARGETS)) {
    out[tier + 'Fee'] = feeEstimateAtTarget(estimates, target);
  }
  if (typeof out.economyFee !== 'number') return null;
  return out;
}

// Current fees from one node: /api/v1/fees/recommended, or Esplora's /fee-
// estimates when that 404s. Throws on anything unusable; the caller then
// skips the Critical check.
async function fetchCurrentFeesFromNode(base) {
  let res;
  try {
    res = await mempoolReq('/api/v1/fees/recommended', 'GET', undefined, base);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status === 200) {
    let data;
    try { data = JSON.parse(res.body); } catch { throw new Error('fees/recommended body is not JSON'); }
    const econ = data && data.economyFee;
    if (typeof econ !== 'number' || !Number.isFinite(econ) || econ < 0) throw new Error('fees/recommended has no usable economyFee');
    return {
      fastestFee: data.fastestFee, halfHourFee: data.halfHourFee,
      hourFee: data.hourFee, economyFee: econ, minimumFee: data.minimumFee,
    };
  }
  if (res.status !== 404) throw new Error('fees/recommended answered HTTP ' + res.status);
  try {
    res = await mempoolReq('/api/fee-estimates', 'GET', undefined, base);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status !== 200) throw new Error('no fee endpoint (404 on both)');
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('fee-estimates body is not JSON'); }
  const mapped = feeEstimatesToRecommended(data);
  if (!mapped) throw new Error('fee-estimates has no usable economy rate');
  return mapped;
}

// Current fees, primary first; the secondary only when the primary cannot
// answer. Throws when neither answers (the caller keeps the cached fees).
async function fetchCurrentFeesFromEndpoints(endpoints) {
  if (!endpoints || !endpoints.length) throw new Error('no fee endpoints configured');
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      return await fetchCurrentFeesFromNode(ep.base);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no fee endpoint answered');
}

// BTC price providers: id, label, base URL, path and parser, all no-auth
// GETs. The price comes from two configured sources and is trusted only
// when they agree (combinePriceReadings). Binance US quotes USDT
// (api.binance.com blocks the US). PRICE_API_URL points every built-in
// provider at a test stub.
const PRICE_PROVIDERS = [
  { id: 'coingecko', label: 'CoinGecko', baseUrl: 'https://api.coingecko.com',
    path: '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    parse: (d) => d && d.bitcoin && d.bitcoin.usd },
  { id: 'coinbase', label: 'Coinbase', baseUrl: 'https://api.coinbase.com',
    path: '/v2/prices/BTC-USD/spot',
    parse: (d) => d && d.data && d.data.amount },
  { id: 'binance', label: 'Binance US (USDT)', baseUrl: 'https://api.binance.us',
    path: '/api/v3/ticker/price?symbol=BTCUSDT',
    parse: (d) => d && d.price },
  { id: 'kraken', label: 'Kraken', baseUrl: 'https://api.kraken.com',
    path: '/0/public/Ticker?pair=XBTUSD',
    parse: (d) => { const r = d && d.result && d.result.XXBTZUSD; return r && r.c && r.c[0]; } },
  { id: 'bitstamp', label: 'Bitstamp', baseUrl: 'https://www.bitstamp.net',
    path: '/api/v2/ticker/btcusd/',
    parse: (d) => d && d.last },
];

function priceProviderById(id) {
  return PRICE_PROVIDERS.find((p) => p.id === id) || null;
}

function priceProviderLabel(id) {
  if (id === 'custom') return 'Custom';
  const p = priceProviderById(id);
  return p ? p.label : String(id);
}

// A custom price source is { id: 'custom', url, path }: the full URL and a
// dot-path to the price in the JSON answer (e.g. data.amount,
// result.XXBTZUSD.c[0]). parseJsonPath and priceFromPath are pure, so the
// UI, the validator and the fetch read a path the same way.
function parseJsonPath(path) {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const steps = [];
  for (const seg of trimmed.split('.')) {
    if (!seg) return null;
    const m = /^([A-Za-z0-9_$]+)?(?:\[(\d+)\])?$/.exec(seg);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    steps.push({ key: m[1] === undefined ? null : m[1], index: m[2] === undefined ? null : parseInt(m[2], 10) });
  }
  return steps.length ? steps : null;
}

function priceFromPath(data, path) {
  const steps = parseJsonPath(path);
  if (!steps) return undefined;
  let cur = data;
  for (const st of steps) {
    if (cur === null || cur === undefined) return undefined;
    if (st.key !== null) {
      if (typeof cur !== 'object') return undefined;
      cur = cur[st.key];
    }
    if (st.index !== null) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[st.index];
    }
  }
  return cur;
}

// The provider-like object for a custom source: base and path from the
// URL, the JSON-path walker as parser. Throws on a bad URL (the source
// then counts as not configured).
function customPriceProvider(url, jsonPath) {
  const u = new URL(String(url).trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('custom price URL must be http(s): ' + url);
  return {
    id: 'custom', label: 'Custom',
    baseUrl: u.protocol + '//' + u.host,
    path: (u.pathname || '/') + (u.search || ''),
    parse: (d) => priceFromPath(d, jsonPath),
  };
}

// Normalize a stored price-source value: a known provider id, or a custom
// { id, url, path } with an http(s) URL and a valid path; anything else is
// null. Settings, restore and readers all use this rule.
function normalizePriceSourceValue(v) {
  if (typeof v === 'string') return priceProviderById(v) ? v : null;
  if (v && typeof v === 'object' && v.id === 'custom') {
    const url = typeof v.url === 'string' ? v.url.trim() : '';
    const path = typeof v.path === 'string' ? v.path.trim() : '';
    if (!url || !path || !parseJsonPath(path)) return null;
    try { customPriceProvider(url, path); } catch { return null; }
    return { id: 'custom', url, path };
  }
  return null;
}

// The stable cache/comparison key for one stored source value:
// the provider id, or the custom URL + JSON path. Two sources
// are "the same" when their keys match.
function priceSourceKey(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.id === 'custom') return 'custom:' + (v.url || '') + '\n' + (v.path || '');
  return String(v);
}

// The provider-like object for a stored source (custom or registry), or
// null when unusable.
function resolvePriceSource(v) {
  const norm = normalizePriceSourceValue(v);
  if (norm === null) return null;
  if (typeof norm === 'string') return priceProviderById(norm);
  return customPriceProvider(norm.url, norm.path);
}

// User-Agent for price fetches (CoinGecko rejects requests without a
// descriptive one), from package.json with a bare fallback.
let PRICE_USER_AGENT = 'Standby';
try { PRICE_USER_AGENT = 'Standby/' + require('../package.json').version; } catch { /* keep the bare name */ }

const DEFAULT_PRICE_API_URL = 'https://api.coingecko.com';

function priceApiBase() {
  // Legacy single override: the CoinGecko base. Kept so
  // the built-in providers and the existing tests keep working.
  const v = PRICE_API_URL_OVERRIDE;
  if (!v) return DEFAULT_PRICE_API_URL;
  let u;
  try { u = new URL(v); } catch { throw new Error('invalid price URL: ' + v); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('price URL must be http(s): ' + v);
  return u.protocol + '//' + u.host;
}

// PRICE_API_URL (test mode only) redirects every built-in provider; a
// custom source keeps its own URL.
function priceProviderBase(provider) {
  if (PRICE_API_URL_OVERRIDE && provider.id !== 'custom') return priceApiBase();
  return provider.baseUrl;
}

// One provider's BTC price in USD. Throws on anything unusable (non-200,
// bad body, non-positive, or outside $1–$100M); the caller treats that as
// no answer.
async function fetchPriceFromProvider(provider) {
  const base = priceProviderBase(provider);
  const u = new URL(base);
  const r = await requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path: provider.path,
    method: 'GET',
    headers: { 'User-Agent': PRICE_USER_AGENT },
    timeoutMs: NET_TIMEOUT_MS,
  });
  if (r.status !== 200) throw new Error(provider.label + ' answered ' + r.status);
  let data;
  try { data = JSON.parse(r.body); } catch { throw new Error(provider.label + ' body is not JSON'); }
  let raw;
  try { raw = provider.parse(data); } catch { throw new Error(provider.label + ' has no usable BTC price'); }
  const price = (typeof raw === 'number') ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(price) || price <= 0) throw new Error(provider.label + ' has no usable BTC price');
  return price;
}

// Fetch both sources in parallel (one failing does not block the other).
// Readings are keyed by slot, since two custom sources share the id
// 'custom'. An unusable source is a failed reading, not a throw.
async function fetchPriceReadings(source1, source2) {
  const jobs = [source1, source2].map(async (src) => {
    const prov = resolvePriceSource(src);
    if (!prov) {
      const id = (typeof src === 'string') ? src : 'custom';
      return { provider: id, label: (typeof src === 'string') ? src : 'Custom', price: null, error: 'unknown price provider: ' + id };
    }
    try {
      const price = await fetchPriceFromProvider(prov);
      return { provider: prov.id, label: prov.label, price, error: null };
    } catch (e) {
      return { provider: prov.id, label: prov.label, price: null, error: e.message };
    }
  });
  const [r1, r2] = await Promise.all(jobs);
  return { source1: r1, source2: r2 };
}

// Two readings agree when |p1 - p2| / min(p1, p2) <= agreementPct / 100.
// The result is the primary source's price:
// - both valid and agree: mode 'dual'
// - one valid: mode 'single', no agreement check
// - both valid but disagree: invalid, mode 'disagree'
// - neither: invalid, mode 'none'
// Pure, so the evaluator, the UI and the already-true check share one
// rule.
function combinePriceReadings(readings, agreementPct) {
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct / 100 : 0.05;
  const valid = [];
  for (const slot of ['source1', 'source2']) {
    const r = (readings || {})[slot];
    if (r && typeof r.price === 'number' && Number.isFinite(r.price)) {
      valid.push({ slot, label: r.label || r.provider || slot, price: r.price });
    }
  }
  if (valid.length === 0) {
    // No usable price: the feed is down or returned garbage, not a market
    // move. No range check: an agreed reading is trusted whatever its
    // size.
    return { valid: false, price: null, mode: 'none', note: '', reason: 'price unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherSlot = only.slot === 'source1' ? 'source2' : 'source1';
    const other = (readings || {})[otherSlot];
    const otherLabel = (other && (other.label || other.provider)) || 'the other source';
    const otherErr = (other && other.error) || '';
    // Say whether the other source was unreachable or returned garbage, so
    // an outage can be told from a bad feed.
    const otherWhy = /no usable BTC price/.test(otherErr) ? 'returned invalid data' : 'unreachable';
    return { valid: true, price: only.price, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const lo = Math.min(a.price, b.price), hi = Math.max(a.price, b.price);
  const diff = (hi - lo) / lo;
  if (diff > agree) {
    const pct = (diff * 100).toFixed(1);
    return { valid: false, price: null, mode: 'disagree', note: '',
      reason: 'price sources disagree — ' + a.label + ' $' + a.price.toLocaleString('en-US') + ' vs ' + b.label + ' $' + b.price.toLocaleString('en-US') + ' (' + pct + '% apart)',
      readings };
  }
  // Both agree: the PRIMARY slot's price decides (source1 is the
  // primary by construction — the slot order is the priority).
  const primary = valid.find((v) => v.slot === 'source1') || valid[0];
  const price = primary.price;
  return { valid: true, price, mode: 'dual',
    note: a.label + ' $' + a.price.toLocaleString('en-US') + ' · ' + b.label + ' $' + b.price.toLocaleString('en-US'),
    reason: '', readings };
}

// The display price for /api/state: the primary's when the sources agree,
// the single valid one, or null.
function priceConsensus(readings, agreementPct) {
  const agree = (typeof agreementPct === 'number' && Number.isFinite(agreementPct) && agreementPct > 0) ? agreementPct / 100 : 0.05;
  const valid = [];
  for (const slot of ['source1', 'source2']) {
    const r = (readings || {})[slot];
    if (r && typeof r.price === 'number' && Number.isFinite(r.price)) valid.push({ slot, price: r.price });
  }
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].price;
  const lo = Math.min(valid[0].price, valid[1].price), hi = Math.max(valid[0].price, valid[1].price);
  if ((hi - lo) / lo > agree) return null;
  const primary = valid.find((v) => v.slot === 'source1') || valid[0];
  return primary.price;
}

// Fee verdict: below the current economy fee is Critical (it would not
// confirm within a day now). Otherwise against the 90-day peak: Low at
// lowMult x, Medium between medMult x and lowMult x, High below (defaults
// 2 and 1). Null without a peak or fee rate. The frontend mirrors this
// rule.
function feeVerdict(rate, peak, economyFee, lowMult, medMult) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null;
  if (typeof peak !== 'number' || !Number.isFinite(peak) || peak <= 0) return null;
  const low = (typeof lowMult === 'number' && Number.isFinite(lowMult) && lowMult > 0) ? lowMult : 2;
  const med = (typeof medMult === 'number' && Number.isFinite(medMult) && medMult > 0) ? medMult : 1;
  if (typeof economyFee === 'number' && Number.isFinite(economyFee) && economyFee >= 0 && rate < economyFee) return 'Critical Risk';
  if (rate >= low * peak) return 'Low Risk';
  if (rate >= med * peak) return 'Medium Risk';
  return 'High Risk';
}

// ---------------------------------------------------------------------------
// Broadcast paths — primary node first, secondary on failure.
// ---------------------------------------------------------------------------

// "Already in mempool" counts as broadcast: if the reply to an accepted
// broadcast was lost, the retry sees this and must not call it a failure.
function isAlreadyOut(err) {
  return /already in mempool/i.test(err && err.message ? err.message : String(err || ''));
}

// Mempool API: POST /api/tx with the raw hex. Returns the txid as
// plain text on success. Throws on rejection — the tx stays off-chain.
async function broadcastViaApi(hex, txid, apiBase) {
  let res;
  try {
    res = await mempoolReq('/api/tx', 'POST', hex, apiBase);
  } catch (e) {
    throw new Error('could not reach ' + mempoolHostLabel(apiBase) + ': ' + e.message);
  }
  if (res.status === 200) {
    const returned = res.body.trim();
    // The node answers a broadcast with the txid as text. Only exactly our
    // 64-hex txid counts as success; any other 200 body is a failed
    // attempt.
    if (!/^[0-9a-f]{64}$/i.test(returned) || returned.toLowerCase() !== txid.toLowerCase()) {
      throw new Error('mempool answered 200 but returned an unexpected txid: ' + returned.slice(0, 200));
    }
    return txid;
  }
  if (isAlreadyOut(new Error(res.body))) return txid;
  throw new Error('mempool rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// MARA Slipstream: submits straight to MARA's private mempool, so the
// transaction stays private until MARA mines it (MARA is ~5% of hashrate;
// admission is best-effort). The public nodes still do every read, since
// Slipstream has no outspend lookup.
// Submit: POST /api/transactions {tx_hex}; success is HTTP 200 with status
// "success", anything else fails closed. Status: GET
// /api/transactions/status?tx_id=. No local fee pre-check: Slipstream's
// rejection reason is shown instead. SLIPSTREAM_API_URL points it at a
// test stub.
const DEFAULT_SLIPSTREAM_API_URL = 'https://slipstream.mara.com';

function slipstreamBase() {
  const v = SLIPSTREAM_API_URL_OVERRIDE;
  if (!v) return DEFAULT_SLIPSTREAM_API_URL;
  let u;
  try { u = new URL(v); } catch { throw new Error('invalid Slipstream URL: ' + v); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Slipstream URL must be http(s): ' + v);
  return u.protocol + '//' + u.host;
}

function slipstreamReq(path, method, body) {
  const base = slipstreamBase();
  const u = new URL(base);
  return requestText({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
    path,
    method: method || 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body,
  });
}

// Submit to Slipstream; returns { txid, method: 'slipstream' } or throws.
// No fallback to the public nodes. A duplicate submit answers success
// again, so it is harmless.
async function broadcastViaSlipstream(hex, txid) {
  let res;
  try {
    res = await slipstreamReq('/api/transactions', 'POST', JSON.stringify({ tx_hex: hex }));
  } catch (e) {
    throw new Error('could not reach Slipstream: ' + e.message);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (res.status === 200 && parsed && parsed.status === 'success') {
    return { txid, method: 'slipstream' };
  }
  // A 400 carries the reason in body.message; surface it. Anything else
  // unexpected is a failed submission (fail closed).
  if (parsed && typeof parsed.message === 'string' && parsed.message) {
    throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + parsed.message.slice(0, 200));
  }
  throw new Error('Slipstream rejected the transaction (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
}

// Slipstream status, normalized: 'queued', 'confirmed', 'failed'
// (Slipstream no longer knows it: dropped, so it is retried) or 'unknown'
// (the status check failed: leave it waiting).
async function getSlipstreamTxStatus(txid) {
  let res;
  try {
    res = await slipstreamReq('/api/transactions/status?tx_id=' + encodeURIComponent(txid), 'GET');
  } catch (e) {
    return { state: 'unknown', message: 'could not reach Slipstream: ' + e.message };
  }
  if (res.status === 404) {
    return { state: 'failed', message: 'Slipstream does not list this transaction' };
  }
  if (res.status !== 200) {
    return { state: 'unknown', message: 'Slipstream status check failed (HTTP ' + res.status + ')' };
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { state: 'unknown', message: 'Slipstream status reply was not JSON' };
  }
  // A 200 carrying status 'error' is Slipstream saying it does not
  // know the transaction (the same as a 404).
  if (parsed.status === 'error') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const info = parsed.transaction;
  if (!info || typeof info !== 'object') {
    return { state: 'failed', message: (typeof parsed.message === 'string' && parsed.message) || 'Slipstream does not list this transaction' };
  }
  const st = info.status || {};
  if (st.confirmed === true) {
    return {
      state: 'confirmed',
      position: typeof info.position === 'number' ? info.position : null,
      isNextBlock: parsed.is_next_block === true,
      last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
      last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
      confirmed: true,
      blockHeight: Number.isFinite(st.block_height) ? st.block_height : null,
      message: (typeof parsed.message === 'string' && parsed.message) || '',
    };
  }
  return {
    state: 'queued',
    position: typeof info.position === 'number' ? info.position : null,
    isNextBlock: parsed.is_next_block === true,
    last24hOdds: typeof parsed.last_24h_odds === 'number' ? parsed.last_24h_odds : null,
    last7dOdds: typeof parsed.last_7d_odds === 'number' ? parsed.last_7d_odds : null,
    confirmed: false,
    blockHeight: null,
    message: (typeof parsed.message === 'string' && parsed.message) || '',
  };
}

// ---------------------------------------------------------------------------
// Input freshness — is each input still unspent?
// ---------------------------------------------------------------------------

// One outspend cache for every lookup, keyed by endpoint and outpoint,
// with the check cadence as TTL (default 60 s), so the trigger and
// freshness paths share requests. Never cached: a 404 (unknown parent: a
// later spend must not be missed) or a failed request. Unknown never means
// unspent.
const outspendCache = new Map(); // key -> { fetchedAtMs, result }
const OUTSPEND_CACHE_DEFAULT_TTL_MS = 60 * 1000;
// Bases whose batch outspend route is missing (a batch 404 then a singular
// success). Implementations differ in which routes they serve, so the
// client tries the batch, falls back to the singular, and remembers the
// base. In memory only: a restart re-learns it, and the test cache-clear
// hook does not reset it.
const singularOnlyBases = new Set();
// Test only: drop all outspend cache entries and in-flight lookups (via
// POST /__test__/clear-caches, test mode only).
function clearOutspendCache() {
  outspendCache.clear();
  outspendInflight.clear();
  outspendsInflight.clear();
}
// In-flight dedup: overlapping lookups of the same outpoint or batch share
// one request. The entry is dropped when it settles, so a failure never
// poisons later lookups.
const outspendInflight = new Map(); // key -> Promise<parsed|null>
const outspendsInflight = new Map(); // key -> Promise<array|null>

function outspendCacheKey(apiBase, prevTxid, prevVout) {
  return apiBase + '|' + prevTxid + ':' + prevVout;
}

function outspendCacheTtlMs(ttlMs) {
  return (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) ? ttlMs : OUTSPEND_CACHE_DEFAULT_TTL_MS;
}

function outspendCacheGet(apiBase, prevTxid, prevVout, ttlMs) {
  const e = outspendCache.get(outspendCacheKey(apiBase, prevTxid, prevVout));
  if (!e) return undefined;
  if (Date.now() - e.fetchedAtMs >= outspendCacheTtlMs(ttlMs)) {
    outspendCache.delete(outspendCacheKey(apiBase, prevTxid, prevVout));
    return undefined;
  }
  return e.result;
}

function outspendCachePut(apiBase, prevTxid, prevVout, result) {
  outspendCache.set(outspendCacheKey(apiBase, prevTxid, prevVout), { fetchedAtMs: Date.now(), result });
}

// One outpoint's spend status (GET /api/tx/:txid/outspend/:vout, or the
// batch). The batch goes first; if it cannot answer (404: unknown parent
// or missing route) the singular is tried, and a base that needed it is
// recorded singular-only. A 404 from both is unknown and never cached;
// other errors throw. skipBatch: the batch was already tried for this
// funding tx.
// Bare answers: a mempool on bitcoind (BACKEND=none) answers {spent: true}
// with no spender or status. Any spend without a spender txid is checked
// with the same node's POST /api/prevouts (confirmed UTXO set only): null
// means spent by a confirmed transaction, a value means the spend is
// mempool-only. If that cannot be checked it reads as unconfirmed, never
// confirmed (which would make the transaction stale for good). Such
// entries are marked bare.
const PREVOUTS_MAX = 100; // the route's per-request limit
function isBareSpent(entry) {
  return !!entry && typeof entry === 'object' && entry.spent === true && !entry.txid;
}
async function resolveBareSpends(prevTxid, entries, apiBase) {
  const bare = entries.filter(([, e]) => isBareSpent(e));
  for (let i = 0; i < bare.length; i += PREVOUTS_MAX) {
    const chunk = bare.slice(i, i + PREVOUTS_MAX);
    let answers = null;
    try {
      const body = JSON.stringify(chunk.map(([vout]) => ({ txid: prevTxid, vout: Number(vout) })));
      const res = await mempoolReq('/api/prevouts', 'POST', body, apiBase, undefined, 'application/json');
      if (res.status === 200) {
        const parsed = JSON.parse(res.body);
        if (Array.isArray(parsed) && parsed.length === chunk.length) answers = parsed;
      }
    } catch (e) { /* unverifiable — treated as unconfirmed below */ }
    chunk.forEach(([, entry], j) => {
      entry.bare = true;
      entry.verified = answers !== null; // false: the node could not say — read as unconfirmed, but say so
      entry.status = { confirmed: answers !== null && answers[j] === null };
    });
  }
}

async function mempoolOutspend(prevTxid, prevVout, apiBase, ttlMs, skipBatch) {
  const cached = outspendCacheGet(apiBase, prevTxid, prevVout, ttlMs);
  if (cached !== undefined) return cached;
  const key = outspendCacheKey(apiBase, prevTxid, prevVout);
  const inflight = outspendInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const shapes = skipBatch ? ['singular']
      : (singularOnlyBases.has(apiBase) ? ['singular', 'batch'] : ['batch', 'singular']);
    let batchAnswered = false;
    for (const shape of shapes) {
      if (shape === 'batch') {
        // Cache only the requested outpoint: caching its siblings would
        // plant answers nobody asked for.
        const arr = await mempoolOutspends(prevTxid, apiBase, ttlMs, prevVout);
        if (arr === null) continue; // batch cannot answer — try the singular
        // The batch answered, so this base serves it. A missing entry for
        // this vout still gets the singular, which may know an output the
        // batch does not list.
        batchAnswered = true;
        singularOnlyBases.delete(apiBase);
        const entry = Array.isArray(arr) ? arr[prevVout] : null;
        // Cache this outpoint here: a shared in-flight batch only caches
        // its own cacheVout.
        if (entry && typeof entry === 'object') { outspendCachePut(apiBase, prevTxid, prevVout, entry); return entry; }
        continue;
      }
      const res = await mempoolReq('/api/tx/' + prevTxid + '/outspend/' + prevVout, 'GET', undefined, apiBase);
      if (res.status === 404) return null; // unknown — cannot prove spent or unspent; NEVER cached
      if (res.status === 405 || res.status === 501) continue; // singular route missing here — try the batch
      if (res.status !== 200) throw new Error('mempool outspend check failed (HTTP ' + res.status + ')');
      const parsed = JSON.parse(res.body);
      await resolveBareSpends(prevTxid, [[prevVout, parsed]], apiBase);
      // The singular answered while the batch did not, so the
      // batch route is missing on this base — remember it.
      if (!batchAnswered) singularOnlyBases.add(apiBase);
      outspendCachePut(apiBase, prevTxid, prevVout, parsed);
      return parsed;
    }
    return null; // neither shape could answer — unknown, never cached
  })();
  outspendInflight.set(key, p);
  try { return await p; }
  finally { if (outspendInflight.get(key) === p) outspendInflight.delete(key); }
}

// GET /api/tx/:txid/outspends: one entry per output, in vout order. 404,
// 405 or 501 return null (unknown or route missing: never cached) so the
// caller can try the singular. With cacheVout only that output is cached,
// so a batch fetched for one outpoint never plants answers for its
// siblings.
async function mempoolOutspends(prevTxid, apiBase, ttlMs, cacheVout) {
  const key = apiBase + '|' + prevTxid;
  const inflight = outspendsInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await mempoolReq('/api/tx/' + prevTxid + '/outspends', 'GET', undefined, apiBase);
    if (res.status === 404 || res.status === 405 || res.status === 501) return null; // unknown, or route missing — NEVER cached
    if (res.status !== 200) throw new Error('mempool outspends check failed (HTTP ' + res.status + ')');
    const arr = JSON.parse(res.body);
    if (Array.isArray(arr)) await resolveBareSpends(prevTxid, arr.map((e, i) => [i, e]), apiBase);
    if (Array.isArray(arr)) {
      const only = (cacheVout === undefined || cacheVout === null) ? null : Number(cacheVout);
      arr.forEach((entry, i) => {
        if (entry && typeof entry === 'object' && (only === null || i === only)) outspendCachePut(apiBase, prevTxid, i, entry);
      });
    }
    return arr;
  })();
  outspendsInflight.set(key, p);
  try { return await p; }
  finally { if (outspendsInflight.get(key) === p) outspendsInflight.delete(key); }
}

// Batch outspend check, primary first: { txid, results, unknown,
// checkedVia, checkedBase, error? } (results null when unknown). A 404 is
// inconclusive, so the next endpoint is asked.
async function checkOutspends(prevTxid, endpoints, ttlMs) {
  const errors = [];
  let first404 = null;
  for (const ep of endpoints) {
    try {
      const arr = await mempoolOutspends(prevTxid, ep.base, ttlMs);
      if (arr === null) {
        if (!first404) first404 = ep;
        continue;
      }
      return { txid: prevTxid, results: arr, unknown: false, checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (first404) {
    return { txid: prevTxid, results: null, unknown: true, checkedVia: first404.label, checkedBase: first404.base };
  }
  return { txid: prevTxid, results: null, unknown: true, checkedVia: null, checkedBase: null, error: errors.join('; ') };
}

// One evaluation's batch plan: funding txs with two or more watched
// outputs, each fetched lazily (only if a rule for it is evaluated). Built
// per evaluation; callers without a plan use the singular path.
function createOutspendBatch(plan, endpoints, ttlMs) {
  const fetched = new Map(); // txid -> Promise<checkOutspends result>
  return {
    plan,
    hasBatch(txid) {
      const s = plan.get(txid);
      return !!s && s.size >= 2;
    },
    fetch(txid) {
      if (!fetched.has(txid)) fetched.set(txid, checkOutspendsCached(txid, endpoints, ttlMs, plan.get(txid)));
      return fetched.get(txid);
    },
  };
}

// Assemble the batch from cache when every watched output is fresh there,
// primary entries only (a secondary answer never stands in for the
// primary). Otherwise fetch it.
async function checkOutspendsCached(prevTxid, endpoints, ttlMs, watched) {
  const primary = endpoints && endpoints[0];
  if (primary && watched && watched.size > 0) {
    const results = [];
    let allFresh = true;
    for (const vout of watched) {
      const entry = outspendCacheGet(primary.base, prevTxid, vout, ttlMs);
      if (entry === undefined) { allFresh = false; break; }
      results[vout] = entry;
    }
    if (allFresh) {
      return { txid: prevTxid, results, unknown: false, checkedVia: primary.label, checkedBase: primary.base };
    }
  }
  return checkOutspends(prevTxid, endpoints, ttlMs);
}

// One outspend answer as checkOutspend returns it. A missing entry is
// unknown, never unspent.
function outspendEntryToResult(outpoint, entry, checkedVia, checkedBase) {
  if (!entry || typeof entry !== 'object') {
    return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia, checkedBase };
  }
  const spent = !!entry.spent;
  const confirmed = !!(entry.status && entry.status.confirmed === true);
  const blockHeight = (confirmed && entry.status && Number.isFinite(entry.status.block_height)) ? entry.status.block_height : null;
  return { outpoint, spent, confirmed, txid: spent ? (entry.txid || null) : null, blockHeight, bare: !!entry.bare, unverified: !!entry.bare && entry.verified === false, unknown: false, checkedVia, checkedBase };
}

// Input freshness against one endpoint. A spent input is one of:
// - own: spent by this transaction's own txid: it is already out there
//   (broadcast)
// - spent: spent by another, confirmed transaction: stale
// - conflict: spent by another, unconfirmed (or unknown-status)
//   transaction: a warning; the broadcast is still attempted
async function checkInputsUnspentVia(parsed, apiBase, ttlMs) {
  const unspent = [];
  const spent = [];
  const conflict = [];
  const own = [];
  const unknown = [];
  // A bare spend cannot be matched to our txid, so ask the node about our
  // own txid (once per tx): if it knows it, the spender is us. A failed
  // lookup leaves the input unknown, never stale.
  let ownLookup; // undefined = not asked; null = not known; 'error'; else the tx status
  const ownStatus = async () => {
    if (ownLookup === undefined) {
      try {
        const t = await mempoolTxStatus(parsed.txid, apiBase);
        ownLookup = t ? (t.status || {}) : null;
      } catch (e) { ownLookup = 'error'; }
    }
    return ownLookup;
  };
  for (const inp of parsed.inputs) {
    const out = await mempoolOutspend(inp.prevTxid, inp.prevVout, apiBase, ttlMs);
    if (out === null) { unknown.push(inp); continue; }
    if (out.spent && out.bare) {
      const mine = await ownStatus();
      if (mine === 'error') { unknown.push(inp); continue; }
      if (mine) {
        own.push({ ...inp, spentBy: parsed.txid, confirmed: mine.confirmed === true,
          blockHeight: Number.isFinite(mine.block_height) ? mine.block_height : null });
        continue;
      }
    }
    if (!out.spent) unspent.push(inp);
    else if (out.txid && out.txid.toLowerCase() === parsed.txid.toLowerCase()) {
      own.push({ ...inp, spentBy: out.txid, confirmed: !!(out.status && out.status.confirmed),
        blockHeight: (out.status && Number.isFinite(out.status.block_height)) ? out.status.block_height : null });
    } else if (out.status && out.status.confirmed === true) spent.push({ ...inp, spentBy: out.txid || null,
      blockHeight: (out.status && Number.isFinite(out.status.block_height)) ? out.status.block_height : null });
    else conflict.push({ ...inp, spentBy: out.txid || null, unverified: !!(out.bare && out.verified === false) });
  }
  return { checked: parsed.inputs.length, unspent, spent, conflict, own, unknown };
}

// Returns { checked, unspent, spent, conflict, own, unknown, checkedVia,
// checkedBase }. Endpoints are tried in order; a completed check is
// definitive and only a failed one falls through. A 404 for an input is
// not a check (the node does not know the parent), so that input is asked
// on the next endpoint and stays unknown only if none can say.
async function checkInputsUnspent(parsed, endpoints, ttlMs) {
  const errors = [];
  let acc = null;
  let remaining = parsed.inputs;
  for (const ep of endpoints) {
    if (!remaining.length) break;
    try {
      const result = await checkInputsUnspentVia({ ...parsed, inputs: remaining }, ep.base, ttlMs);
      if (!acc) {
        acc = { checked: parsed.inputs.length, unspent: [], spent: [], conflict: [], own: [], unknown: [], checkedVia: ep.label, checkedBase: ep.base };
      }
      acc.unspent.push(...result.unspent);
      acc.spent.push(...result.spent);
      acc.conflict.push(...result.conflict);
      acc.own.push(...result.own);
      // checkedVia: 'secondary' if any input needed the fallback, else
      // 'primary'.
      if (result.unspent.length || result.spent.length || result.conflict.length || result.own.length) {
        acc.checkedVia = ep.label;
        acc.checkedBase = ep.base;
      }
      remaining = result.unknown;
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (!acc) throw new Error('could not verify inputs (' + errors.join('; ') + ')');
  acc.unknown = remaining;
  return acc;
}

// UTXO trigger: is a watched outpoint spent? Returns { outpoint, spent,
// confirmed, txid, blockHeight, unknown, checkedVia, checkedBase }.
// unknown when no endpoint can say (all 404 or failed); the trigger never
// fires on it. blockHeight lets the caller count confirmations. Only a
// confirmed spend fires, unless the rule asks for 0 confirmations.
async function checkOutspend(outpoint, endpoints, opts) {
  const parts = String(outpoint || '').split(':');
  const prevTxid = parts[0] || '';
  const prevVout = parseInt(parts[1], 10);
  const ttlMs = opts && opts.ttlMs;
  const batch = opts && opts.batch;
  // Batch path: one fetch answers every watched output of this funding tx.
  // An answer that cannot say about this output is unknown, never unspent.
  // Unless every endpoint failed outright, fall through to the singular,
  // which may answer where the batch could not.
  let batchTried = false;
  if (batch && batch.hasBatch(prevTxid) && Number.isFinite(prevVout) && prevVout >= 0) {
    const b = await batch.fetch(prevTxid);
    if (!b.unknown) {
      const entry = Array.isArray(b.results) ? b.results[prevVout] : null;
      return outspendEntryToResult(outpoint, entry, b.checkedVia, b.checkedBase);
    }
    if (b.error) {
      return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true,
        checkedVia: b.checkedVia, checkedBase: b.checkedBase, error: b.error };
    }
    batchTried = true;
  }
  const errors = [];
  let first404 = null;
  for (const ep of endpoints) {
    try {
      const out = await mempoolOutspend(prevTxid, prevVout, ep.base, ttlMs, batchTried);
      if (out === null) {
        if (!first404) first404 = ep;
        continue;
      }
      return outspendEntryToResult(outpoint, out, ep.label, ep.base);
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  if (first404) {
    return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia: first404.label, checkedBase: first404.base };
  }
  return { outpoint, spent: false, confirmed: false, txid: null, blockHeight: null, unknown: true, checkedVia: null, checkedBase: null, error: errors.join('; ') };
}

// ---------------------------------------------------------------------------
// Dry-run validation — answers "would a broadcast be attempted?" and
// records the answer. NEVER broadcasts. The full hex never reaches the log.
// ---------------------------------------------------------------------------
async function dryRun(dataDir, { tx, endpoints, ttlMs }) {
  const parsed = parseTx(tx.hex);
  const check = await checkInputsUnspent(parsed, endpoints, ttlMs);
  const fellBack = check.checkedVia !== 'primary';
  const viaNote = 'Checked via the ' + check.checkedVia + ' node (' + mempoolHostLabel(check.checkedBase) + ')'
    + (fellBack ? ' — the primary node could not be reached.' : '.');
  // Verdicts, fail-open:
  // - ready: every input proven unspent
  // - unknown: nothing proven spent, some inputs unverifiable; the
  //   broadcast is still attempted
  // - conflict: an input spent by an unconfirmed transaction; a warning,
  //   still attempted
  // - timelocked: locktime not yet passed; attempted, rejected and retried
  //   until it passes
  // - broadcast: the node already has our txid; nothing to send
  // - blocked: an input spent by a confirmed transaction; stale
  // Precedence: blocked, broadcast, timelocked, conflict, unknown. The tip
  // is fetched only for a height locktime with a live sequence; if that
  // fetch fails the timelock check is skipped and the broadcast decides.
  let timelock = { timelocked: false, until: null };
  if (parsed.locktime && parsed.locktime < 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    let tipHeight = null;
    try { tipHeight = await mempoolTipHeight(check.checkedBase); } catch { tipHeight = null; }
    timelock = timelockedUntil(parsed, tipHeight, new Date());
  } else if (parsed.locktime && parsed.locktime >= 500000000
    && (parsed.inputs || []).some((i) => (i.sequence >>> 0) !== 0xffffffff)) {
    timelock = timelockedUntil(parsed, null, new Date());
  }
  const verdict = check.spent.length ? 'blocked'
    : check.own.length ? 'broadcast'
    : timelock.timelocked ? 'timelocked'
    : check.conflict.length ? 'conflict'
    : check.unknown.length ? 'unknown' : 'ready';
  const wouldBroadcast = check.spent.length === 0 && check.own.length === 0;
  // The route only changes the note's wording ("would submit to
  // Slipstream"); the freshness gate is the same.
  const viaSlipstream = tx.broadcastVia === 'slipstream';
  const attempt = viaSlipstream ? 'a submission to Slipstream (MARA)' : 'a broadcast';
  const rejecter = viaSlipstream ? 'Slipstream' : 'the node';
  const note = verdict === 'ready'
    ? 'All ' + check.checked + ' input(s) unspent — ' + attempt + ' would be attempted. ' + viaNote
    : verdict === 'blocked'
      ? check.spent.length + ' input(s) spent by another transaction that is confirmed — this transaction is stale and will not be ' + (viaSlipstream ? 'submitted to Slipstream' : 'broadcast') + '. ' + viaNote
      : verdict === 'broadcast'
        ? 'This transaction is already out there — the node knows its txid, in the mempool or a block — so it is recorded as broadcast. Nothing was sent. ' + viaNote
        : verdict === 'timelocked'
          ? 'This transaction is timelocked until ' + (typeof timelock.until === 'number' ? 'block ' + timelock.until : timelock.until.toISOString()) + ' — ' + rejecter + ' would reject it as non-final until then, so ' + attempt + ' would be attempted and rejected; it will be retried on the next hourly check. ' + viaNote
          : verdict === 'conflict'
          ? check.conflict.some((c) => c.unverified)
            ? check.conflict.length + ' input(s) are spent by another transaction, and this node cannot say whether that spend is confirmed, so it is treated as unconfirmed — this transaction stays active with a warning and ' + attempt + ' will still be attempted. ' + viaNote
            : check.conflict.length + ' input(s) are spent by another transaction that is not confirmed yet — the spend may still be evicted, so this transaction stays active with a warning and ' + attempt + ' will still be attempted. ' + viaNote
          : check.unknown.length + ' input(s) could not be verified — ' + attempt + ' would be attempted, but the network is the arbiter. ' + viaNote;
  // The fee, recomputed from the parents on every dry run, so a wrongly
  // stored fee corrects itself (the caller records it).
  const fee = await computeFee(parsed, endpoints);
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'dry-run',
    status: verdict === 'ready' ? 'would-broadcast' : verdict,
    method: check.checkedVia,
    txid: tx.txid,
    hexPreview: tx.hex.slice(0, 64),
    inputsChecked: check.checked,
    unspent: check.unspent.length,
    spent: check.spent.length,
    conflict: check.conflict.length,
    own: check.own.length,
    unknown: check.unknown.length,
    note,
  });
  return {
    ok: true,
    wouldBroadcast,
    verdict,
    broadcastVia: tx.broadcastVia === 'slipstream' ? 'slipstream' : 'public',
    timelockedUntil: timelock.timelocked ? (timelock.until instanceof Date ? timelock.until.toISOString() : timelock.until) : null,
    txid: tx.txid,
    fee,
    checked: check.checked,
    checkedVia: check.checkedVia,
    checkedBase: check.checkedBase,
    unspent: check.unspent,
    spent: check.spent,
    conflict: check.conflict,
    own: check.own,
    unknown: check.unknown,
    note,
  };
}

// Real broadcast, primary first, secondary on failure. Returns { txid,
// method, fallback }; throws (and logs) on total failure. Irrevocable once
// it lands.
async function broadcastTx(dataDir, { hex, txid, endpoints, notePrefix }) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const outTxid = await broadcastViaApi(hex, txid, ep.base);
      const fellBack = ep !== endpoints[0];
      appendBroadcastLog(dataDir, {
        ts: new Date().toISOString(),
        kind: 'broadcast',
        status: 'broadcast',
        method: ep.label,
        txid: outTxid,
        hexPreview: hex.slice(0, 64),
        note: (notePrefix ? notePrefix + ' ' : '') + 'Broadcast accepted by the ' + ep.label + ' node (' + mempoolHostLabel(ep.base) + ')'
          + (fellBack ? ' — the primary node failed (' + (errors[0] || '') + '), fell back to the secondary.' : '.'),
      });
      return { txid: outTxid, method: ep.label, fallback: fellBack };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  const errText = 'Broadcast failed: ' + errors.join('; ');
  appendBroadcastLog(dataDir, {
    ts: new Date().toISOString(),
    kind: 'broadcast',
    status: 'failed',
    method: 'primary',
    txid: txid || '',
    hexPreview: hex.slice(0, 64),
    note: errText,
  });
  throw new Error(errText);
}

// ---------------------------------------------------------------------------
// Confirmation lookup — how many blocks deep is a broadcast transaction?
// ---------------------------------------------------------------------------

// GET /api/tx/:txid: 200 with status { confirmed, block_height, ... }; 404
// means the network does not know the tx.
async function mempoolTxStatus(txid, apiBase, timeoutMs) {
  const res = await mempoolReq('/api/tx/' + txid, 'GET', undefined, apiBase, timeoutMs);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('mempool tx lookup failed (HTTP ' + res.status + ')');
  return JSON.parse(res.body);
}

// Transaction fee: input values minus outputs. Input values live in the
// parent transactions (GET /api/tx/:txid). Best-effort: any failure gives
// null and the add or dry run still succeeds.

// A vout value in satoshis as a BigInt, or null. The API returns satoshis,
// not BTC.
function satsValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  return BigInt(value);
}

// One input's prevout value in satoshis. An endpoint that 404s the parent
// or is down falls through to the next; a known parent with a missing vout
// is an answer (null).
async function parentOutputValue(prevTxid, prevVout, endpoints, timeoutMs) {
  for (const ep of endpoints) {
    let st;
    try {
      st = await mempoolTxStatus(prevTxid, ep.base, timeoutMs);
    } catch {
      continue; // endpoint down — try the next
    }
    if (st === null) {
      // Without txindex an RPC node knows only mempool transactions; an
      // unspent output's value is still in its UTXO set.
      if (rpc.isRpcBase(ep.base)) {
        const v = await rpcPrevoutValue(prevTxid, prevVout, ep.base, timeoutMs);
        if (v !== null) return v;
      }
      continue; // unknown here — maybe the other endpoint knows it
    }
    const vouts = st.vout || [];
    const out = vouts[prevVout];
    if (!out) return null;
    return satsValue(out.value);
  }
  return null;
}

async function rpcPrevoutValue(txid, vout, base, timeoutMs) {
  try {
    const res = await mempoolReq('/api/prevouts', 'POST', JSON.stringify([{ txid, vout }]), base, timeoutMs, 'application/json');
    const [out] = JSON.parse(res.body);
    return out && out.prevout ? satsValue(out.prevout.value) : null;
  } catch { return null; }
}

// { feeSats, feeRateSatVb } or null. Parents are fetched in parallel, each
// capped at FEE_LOOKUP_TIMEOUT_MS so a hung node cannot stall an add.
// Never throws.
const FEE_LOOKUP_TIMEOUT_MS = 5000;
async function computeFee(parsed, endpoints) {
  try {
    if (!parsed || !Array.isArray(parsed.inputs) || !parsed.inputs.length) return null;
    const values = await Promise.all(
      parsed.inputs.map((inp) => parentOutputValue(inp.prevTxid, inp.prevVout, endpoints, FEE_LOOKUP_TIMEOUT_MS))
    );
    if (values.some((v) => v === null)) return null;
    let inSats = 0n;
    for (const v of values) inSats += v;
    const fee = inSats - BigInt(parsed.totalOutSats);
    if (fee < 0n) return null;
    const vsize = parsed.vsize;
    if (!vsize || vsize <= 0) return null;
    return { feeSats: Number(fee), feeRateSatVb: Number(fee) / vsize };
  } catch {
    return null;
  }
}

// Inputs and outputs for the card's details, derived from the stored hex
// at read time (never stored, no network). Input values are null: they
// would need a parent lookup.

// Base58 (Bitcoin alphabet) and Base58Check: the legacy address
// encoding. A leading zero byte in the payload is a leading '1'.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    s = BASE58_ALPHABET[Number(r)] + s;
  }
  return '1'.repeat(zeros) + s;
}
function base58checkEncode(version, payload) {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const chk = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([body, chk]));
}

// Bech32 (version 0) and bech32m (version 1, taproot) segwit addresses,
// mainnet only.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bech32ConvertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const b of data) {
    acc = (acc << from) | b;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}
function bech32Encode(hrp, witver, program) {
  const spec = witver === 0 ? 1 : 0x2bc830a3;
  const data = bech32ConvertBits(program, 8, 5, true);
  if (data === null) return null;
  const values = bech32HrpExpand(hrp).concat([witver]).concat(data);
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ spec;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [witver].concat(data).concat(checksum).map((v) => BECH32_CHARSET[v]).join('');
}

// An output's destination: { type, address }, address null for OP_RETURN
// and unknown scripts. No hashing needed.
function scriptPubKeyInfo(scriptHex) {
  let script;
  try { script = Buffer.from(scriptHex || '', 'hex'); } catch { return { type: 'nonstandard', address: null }; }
  // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return { type: 'P2PKH', address: base58checkEncode(0x00, script.subarray(3, 23)) };
  }
  // P2SH: OP_HASH160 <20> OP_EQUAL
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { type: 'P2SH', address: base58checkEncode(0x05, script.subarray(2, 22)) };
  }
  // P2WPKH: OP_0 <20>
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return { type: 'P2WPKH', address: bech32Encode('bc', 0, script.subarray(2, 22)) };
  }
  // P2WSH: OP_0 <32>
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) {
    return { type: 'P2WSH', address: bech32Encode('bc', 0, script.subarray(2, 34)) };
  }
  // P2TR: OP_1 <32>
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return { type: 'P2TR', address: bech32Encode('bc', 1, script.subarray(2, 34)) };
  }
  // OP_RETURN: a data carrier, no destination.
  if (script.length >= 1 && script[0] === 0x6a) {
    return { type: 'OP_RETURN', address: null };
  }
  return { type: 'nonstandard', address: null };
}

// Inputs and outputs of a parsed tx: outputs with value (satoshis as a
// string), address and type; inputs with their outpoint and valueSats
// null. Null if unusable.
function txIoDetail(parsed) {
  if (!parsed || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) return null;
  return {
    inputs: parsed.inputs.map((inp) => ({ prevTxid: inp.prevTxid, prevVout: inp.prevVout, valueSats: null })),
    outputs: parsed.outputs.map((out) => {
      const info = scriptPubKeyInfo(out.script);
      return { valueSats: out.value, address: info.address, type: info.type };
    }),
  };
}

// Tip height from one endpoint (the same probe the connection test uses).
async function mempoolTipHeight(apiBase) {
  const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
  if (res.status !== 200) throw new Error('mempool tip height failed (HTTP ' + res.status + ')');
  const h = parseInt(res.body.trim(), 10);
  if (!Number.isFinite(h)) throw new Error('mempool tip height unparseable');
  return h;
}

// Tip height, primary first; the secondary only when the primary has no
// valid height (its entry is then { skipped: true }).
async function fetchTipHeights(endpoints) {
  const out = {};
  if (!endpoints || !endpoints.length) return out;
  const primary = endpoints[0];
  let primaryReading;
  try {
    const h = await mempoolTipHeight(primary.base);
    primaryReading = { endpoint: primary.label, height: h, error: null };
  } catch (e) {
    primaryReading = { endpoint: primary.label, height: null, error: e.message || String(e) };
  }
  out[primary.label] = primaryReading;
  const primaryUsable = typeof primaryReading.height === 'number'
    && Number.isFinite(primaryReading.height) && primaryReading.height >= 0;
  for (let i = 1; i < endpoints.length; i++) {
    const ep = endpoints[i];
    if (primaryUsable) {
      // The primary answered, so the secondary was not needed (recorded so
      // the note does not say unreachable).
      out[ep.label] = { endpoint: ep.label, height: null, error: null, skipped: true };
      continue;
    }
    try {
      const h = await mempoolTipHeight(ep.base);
      out[ep.label] = { endpoint: ep.label, height: h, error: null };
    } catch (e) {
      out[ep.label] = { endpoint: ep.label, height: null, error: e.message || String(e) };
    }
  }
  return out;
}

// The primary's tip counts; the secondary is a fallback. No agreement
// check: a block or two of lag between nodes is normal.
function combineTipHeights(readings) {
  const valid = [];
  for (const label of Object.keys(readings || {})) {
    const r = readings[label];
    if (!r || typeof r.height !== 'number' || !Number.isFinite(r.height) || r.height < 0) continue;
    valid.push({ label, height: r.height });
  }
  if (valid.length === 0) {
    return { valid: false, tip: null, mode: 'none', note: '', reason: 'tip height unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherLabel = Object.keys(readings || {}).find((label) => label !== only.label) || 'the other node';
    const other = readings[otherLabel];
    // A secondary never asked is 'not needed', not 'unreachable'.
    const otherWhy = (other && other.skipped) ? 'not needed'
      : (other && other.error) ? 'unreachable' : 'returned invalid data';
    return { valid: true, tip: only.height, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const primary = valid.find((v) => v.label === 'primary') || valid[0];
  const tip = primary.height;
  return { valid: true, tip, mode: 'dual',
    note: a.label + ' ' + a.height.toLocaleString('en-US') + ' · ' + b.label + ' ' + b.height.toLocaleString('en-US'),
    reason: '', readings };
}

// Tip height from the first endpoint that answers; throws if none does (an
// uncountable spend never fires).
async function getTipHeight(endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try { return await mempoolTipHeight(ep.base); }
    catch (e) { errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message); }
  }
  throw new Error('could not fetch tip height (' + errors.join('; ') + ')');
}

// Confirmations for a broadcast transaction: { found, confirmed,
// blockHeight, confirmations, checkedVia, checkedBase }. found: false when
// the network does not know it; throws when no endpoint answers (the
// caller keeps the last value).
async function getConfirmations(txid, endpoints) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const st = await mempoolTxStatus(txid, ep.base);
      if (st === null) continue; // unknown here — maybe the other endpoint knows it
      const tip = await mempoolTipHeight(ep.base);
      const status = st.status || {};
      if (!status.confirmed) {
        return { found: true, confirmed: false, blockHeight: null, confirmations: 0, checkedVia: ep.label, checkedBase: ep.base };
      }
      const height = status.block_height;
      if (!Number.isFinite(height)) {
        return { found: true, confirmed: true, blockHeight: null, confirmations: null, checkedVia: ep.label, checkedBase: ep.base };
      }
      return { found: true, confirmed: true, blockHeight: height, confirmations: Math.max(0, tip - height + 1), checkedVia: ep.label, checkedBase: ep.base };
    } catch (e) {
      errors.push(ep.label + ' (' + mempoolHostLabel(ep.base) + '): ' + e.message);
    }
  }
  // Every endpoint 404'd or failed: not found only if every endpoint that
  // answered said 404; otherwise a lookup failure (the caller keeps the
  // last value).
  if (errors.length === 0) {
    return { found: false, confirmed: false, blockHeight: null, confirmations: null, checkedVia: null, checkedBase: null };
  }
  throw new Error('could not check confirmations (' + errors.join('; ') + ')');
}

// Archived: broadcast, or a release record whose fate is decided (keep in
// sync with RELEASE_STATUSES in lib/routes/backup.js).
const ARCHIVED_RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
function isArchivedTx(tx) {
  return !!(tx && (tx.broadcasted || (tx.release && ARCHIVED_RELEASE_STATUSES.has(tx.release.status))));
}

// Inputs spent by two or more stored transactions: only one can ever
// confirm. No network; archived transactions are left out (their fate is
// decided).
function findSharedInputs(txs) {
  const byInput = new Map();
  for (const tx of txs || []) {
    if (isArchivedTx(tx)) continue;
    let parsed;
    try { parsed = parseTx(tx.hex); } catch { continue; }
    for (const inp of parsed.inputs) {
      const key = inp.prevTxid + ':' + inp.prevVout;
      if (!byInput.has(key)) byInput.set(key, []);
      if (!byInput.get(key).includes(tx.id)) byInput.get(key).push(tx.id);
    }
  }
  const out = [];
  for (const [input, txIds] of byInput) {
    if (txIds.length > 1) out.push({ input, txIds });
  }
  return out;
}

// Connection test: checks both endpoints without moving funds; OK if
// either answers. Returns { ok, detail, results }.
async function testConnection(endpoints, opts) {
  // probeOutputLookup: only Test connection probes it. The hourly tick
  // reuses each endpoint's last probe (prevResults), so it makes no
  // outspend request and never changes the learned route. The 'not
  // checked' placeholder is not carried forward.
  const probeOutputLookup = !opts || opts.probeOutputLookup !== false;
  const prevResults = (opts && Array.isArray(opts.prevResults)) ? opts.prevResults : [];
  const results = [];
  for (const ep of endpoints) {
    const prev = prevResults.find((x) => x && x.endpoint === ep.label && x.base === ep.base);
    const prevCheck = prev && prev.checks ? prev.checks.outputLookup : null;
    const prevOutputLookup = (prevCheck && typeof prevCheck === 'object' && prevCheck.value !== '—') ? prevCheck : null;
    results.push({ endpoint: ep.label, base: ep.base, ...(await testOnePath(ep.base, probeOutputLookup, prevOutputLookup)) });
  }
  const ok = results.some((r) => r.ok);
  const detail = results
    .map((r) => (r.endpoint === 'primary' ? 'Primary' : 'Secondary') + ' (' + mempoolHostLabel(r.base) + '): ' + r.status.toUpperCase() + ' — ' + r.detail)
    .join('; ');
  return { ok, detail, results };
}

// One endpoint, four checks: height, fees, broadcast, output lookup.
// Status is OK when all probed checks pass, CAUTION when height works but
// another check does not, FAIL when height fails (height is the one thing
// every node serves). ok stays true for OK and CAUTION. The detail is the
// pill tooltip.
async function testOnePath(apiBase, probeOutputLookup, prevOutputLookup) {
  const height = await testNodeHeight(apiBase);
  if (!height.ok) {
    return {
      ok: false, status: 'fail',
      detail: 'height: ' + height.detail,
      checks: { height, fees: { ok: false, detail: 'not checked — height failed', value: '—' }, broadcast: { ok: false, detail: 'not checked — height failed', value: '—' }, outputLookup: { ok: false, detail: 'not checked — height failed', value: '—' } },
    };
  }
  const fees = await testNodeFees(apiBase);
  const broadcast = await testNodeBroadcast(apiBase);
  // Output lookup is only probed by Test connection; the tick reuses the
  // last probe. Never probed means absent (no value, does not block OK).
  const outputLookup = probeOutputLookup ? await testNodeOutputLookup(apiBase) : (prevOutputLookup || null);
  const checks = { height, fees, broadcast };
  if (outputLookup) checks.outputLookup = outputLookup;
  const allOk = fees.ok && broadcast.ok && (outputLookup ? outputLookup.ok : true);
  let detail;
  if (outputLookup && outputLookup.warn && outputLookup.kind === 'rpc' && fees.ok && broadcast.ok) {
    detail = 'Height OK, but ' + outputLookup.detail.charAt(0).toLowerCase() + outputLookup.detail.slice(1);
  } else if (outputLookup && outputLookup.warn && fees.ok && broadcast.ok) {
    detail = 'Height OK, but this node says only that an output is spent, not whether the spend is confirmed — a spent input warns instead of going stale.';
  } else if (outputLookup && !outputLookup.ok && fees.ok && broadcast.ok) {
    detail = 'Height OK, but output lookup is unavailable — UTXO rules cannot be evaluated against this node.';
  } else {
    const parts = ['height ' + height.detail, 'fees: ' + fees.detail, 'broadcast: ' + broadcast.detail];
    if (outputLookup) parts.push('output lookup: ' + outputLookup.detail);
    detail = parts.join(' · ');
  }
  return {
    ok: true, status: allOk ? 'ok' : 'caution', detail,
    checks,
  };
}

// Block height: GET /api/blocks/tip/height, which every node serves. value
// is the short text beside the pill ("Height 976,200"), or the reason on
// failure; detail is the tooltip.
async function testNodeHeight(apiBase) {
  try {
    const res = await mempoolReq('/api/blocks/tip/height', 'GET', undefined, apiBase);
    if (res.status !== 200) return { ok: false, detail: 'answered HTTP ' + res.status, value: 'answered HTTP ' + res.status };
    const height = parseInt(res.body.trim(), 10);
    return Number.isFinite(height)
      ? { ok: true, detail: 'tip height ' + height, value: 'Height ' + height.toLocaleString('en-US') }
      : { ok: false, detail: 'answered 200 with an unparseable height', value: 'unparseable height' };
  } catch (e) {
    return { ok: false, detail: e.message, value: e.message };
  }
}

// The economy fee from one node: { fee, source } from
// /api/v1/fees/recommended, or Esplora's 144-block rate. Throws when the
// node has no usable fee data. The fee-market trigger, the hourly reading
// and the node test share this.
async function fetchNodeFee(apiBase) {
  let res;
  try {
    res = await mempoolReq('/api/v1/fees/recommended', 'GET', undefined, apiBase);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status === 200) {
    let data;
    try { data = JSON.parse(res.body); } catch { throw new Error('fees/recommended body is not JSON'); }
    const econ = data && data.economyFee;
    if (typeof econ === 'number' && Number.isFinite(econ) && econ >= 0) {
      return { fee: econ, source: 'mempool' };
    }
    throw new Error('fees/recommended has no usable economyFee');
  }
  if (res.status !== 404) throw new Error('fees/recommended answered HTTP ' + res.status);
  try {
    res = await mempoolReq('/api/fee-estimates', 'GET', undefined, apiBase);
  } catch (e) {
    throw new Error(e.message);
  }
  if (res.status !== 200) throw new Error('no fee endpoint (404 on both)');
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('fee-estimates body is not JSON'); }
  // The economy fee is the day-scale estimate everywhere, so Esplora's is
  // the 144-block rate; without it there is no economy fee.
  const fee = feeEstimateAtTarget(data, ESPLORA_FEE_TARGETS.economy);
  if (typeof fee !== 'number') throw new Error('fee-estimates has no usable rates');
  return { fee, source: rpc.isRpcBase(apiBase) ? 'core' : 'esplora' };
}

// Fee check: mempool's /api/v1/fees/recommended, or Esplora's /api/fee-
// estimates at the 144-block target.
async function testNodeFees(apiBase) {
  try {
    const r = await fetchNodeFee(apiBase);
    if (r.source === 'mempool') return { ok: true, detail: 'ready (economy ' + r.fee + ' sat/vB)', value: r.fee + ' sat/vB' };
    return { ok: true, detail: r.source === 'core' ? 'ready (Bitcoin Core estimates)' : 'ready (Esplora estimates)', value: r.fee + ' sat/vB' };
  } catch (e) {
    const msg = e.message || String(e);
    const value = /no fee endpoint/.test(msg) ? 'no fee endpoint' : /no usable economyFee/.test(msg) ? 'no economy fee' : /no usable rates/.test(msg) ? 'no usable rates' : /not JSON/.test(msg) ? 'not JSON' : msg;
    return { ok: false, detail: msg, value };
  }
}

// Economy fee readings, primary first; the secondary only when the primary
// cannot answer or reads above FEE_IMPLAUSIBLE_SATVB (asking both every
// tick wasted the secondary's rate limit). Each reading is { fee, source
// }, { fee: null, error } or { fee: null, skipped: true }.
async function fetchNodeFeeReadings(endpoints) {
  const out = {};
  if (!endpoints || !endpoints.length) return out;
  const primary = endpoints[0];
  let primaryReading;
  try {
    const r = await fetchNodeFee(primary.base);
    primaryReading = { endpoint: primary.label, fee: r.fee, source: r.source, error: null };
  } catch (e) {
    primaryReading = { endpoint: primary.label, fee: null, source: null, error: e.message || String(e) };
  }
  out[primary.label] = primaryReading;
  const primaryUsable = typeof primaryReading.fee === 'number' && Number.isFinite(primaryReading.fee)
    && primaryReading.fee >= 0 && primaryReading.fee <= FEE_IMPLAUSIBLE_SATVB;
  for (let i = 1; i < endpoints.length; i++) {
    const ep = endpoints[i];
    if (primaryUsable) {
      // The primary answered, so the secondary was not needed (recorded so
      // the note does not say unreachable).
      out[ep.label] = { endpoint: ep.label, fee: null, source: null, error: null, skipped: true };
      continue;
    }
    try {
      const r = await fetchNodeFee(ep.base);
      out[ep.label] = { endpoint: ep.label, fee: r.fee, source: r.source, error: null };
    } catch (e) {
      out[ep.label] = { endpoint: ep.label, fee: null, source: null, error: e.message || String(e) };
    }
  }
  return out;
}

// Above this a fee reading is bad data, not a market move (the fee-market
// threshold caps at the same value).
const FEE_IMPLAUSIBLE_SATVB = 10000;

// The primary's fee counts; the secondary is a fallback (mode 'single');
// neither is 'none'. No agreement check: nodes lag each other a little. A
// reading above FEE_IMPLAUSIBLE_SATVB is bad data and ignored. Pure.
function combineFeeReadings(readings) {
  const valid = [];
  const implausible = [];
  for (const label of Object.keys(readings || {})) {
    const r = readings[label];
    if (!r || typeof r.fee !== 'number' || !Number.isFinite(r.fee) || r.fee < 0) continue;
    if (r.fee > FEE_IMPLAUSIBLE_SATVB) { implausible.push({ label, fee: r.fee }); continue; }
    valid.push({ label, fee: r.fee, source: r.source });
  }
  if (valid.length === 0) {
    if (implausible.length) {
      const names = implausible.map((x) => x.label + ' ' + x.fee + ' sat/vB').join('; ');
      return { valid: false, fee: null, mode: 'none', note: '', reason: 'implausible fee reading (' + names + ') — ignored', readings };
    }
    return { valid: false, fee: null, mode: 'none', note: '', reason: 'fee unavailable — will retry', readings };
  }
  if (valid.length === 1) {
    const only = valid[0];
    const otherLabel = Object.keys(readings || {}).find((label) => label !== only.label) || 'the other node';
    const other = readings[otherLabel];
    // A secondary never asked is 'not needed', not 'unreachable'.
    const otherWhy = (other && other.skipped) ? 'not needed'
      : (other && other.error) ? 'unreachable' : 'returned invalid data';
    return { valid: true, fee: only.fee, mode: 'single',
      note: only.label + ' only — ' + otherLabel + ' ' + otherWhy, reason: '', readings };
  }
  const a = valid[0], b = valid[1];
  const primary = valid.find((v) => v.label === 'primary') || valid[0];
  const fee = primary.fee;
  return { valid: true, fee, mode: 'dual',
    note: a.label + ' ' + a.fee + ' sat/vB · ' + b.label + ' ' + b.fee + ' sat/vB',
    reason: '', readings };
}

// Broadcast check: POST /api/tx with "00", which every node rejects at
// parse time, so nothing is broadcast. 400/422 (and the test stub's 200)
// mean reachable; 404 or anything else means not ready.
async function testNodeBroadcast(apiBase) {
  try {
    const res = await mempoolReq('/api/tx', 'POST', '00', apiBase);
    if (res.status === 200 || res.status === 400 || res.status === 422) {
      return { ok: true, detail: 'ready (endpoint live)', value: 'Reachable' };
    }
    return { ok: false, detail: 'answered HTTP ' + res.status, value: 'answered HTTP ' + res.status };
  } catch (e) {
    return { ok: false, detail: e.message, value: e.message };
  }
}

// Output lookup: how this node answers spends, which decides how Standby
// reads them. It asks about the outputs of Hal Finney's first transaction
// (block 170), both long spent:
// - full: names the spender and its status (mempool.space, Blockstream,
//   Esplora)
// - bare, verified: only {spent: true}, but /api/prevouts tells confirmed
//   from mempool spends (a mempool on Bitcoin Core)
// - bare, unverified: no /api/prevouts; limited, shown as a warning
// The request shape that answered goes in the detail. Read-only.
const PROBE_TXID = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
// The probe asks the node fresh and leaves nothing in the outspend
// cache: a connection test must not change what a UTXO rule watching
// the same outputs reads.
function forgetProbeOutspends(apiBase) {
  for (const vout of [0, 1]) outspendCache.delete(outspendCacheKey(apiBase, PROBE_TXID, vout));
}
// RPC: ask Bitcoin Core whether txindex is on (getindexinfo, Core 0.21+)
// so the owner is told to enable it. null when the node cannot say.
const TXINDEX_OFF = { ok: false, warn: true, kind: 'rpc', detail: 'txindex is off — add txindex=1 to bitcoin.conf and restart Bitcoin Core. Until then an input spent by a confirmed transaction reads unknown (never stale), and a UTXO rule on a spent output never fires.', value: 'txindex off',
  note: 'Add txindex=1 to bitcoin.conf and restart Bitcoin Core. Until then, Standby can\u2019t tell when an input was spent in a block, so it can\u2019t mark that transaction stale or fire a UTXO rule.' };
async function rpcTxindexCheck(apiBase) {
  let info;
  try { info = await rpc.call(apiBase, 'getindexinfo', ['txindex']); } catch { return null; }
  const ti = info && info.txindex;
  if (!ti) return TXINDEX_OFF;
  if (ti.synced === false) {
    return { ok: false, warn: true, kind: 'rpc', detail: 'txindex is still building — spent outputs in blocks it has not indexed yet read unknown until it finishes.', value: 'txindex still building',
      note: 'Bitcoin Core is still building its transaction index. Test again once it finishes.' };
  }
  return null;
}

async function testNodeOutputLookup(apiBase) {
  if (rpc.isRpcBase(apiBase)) {
    const txindex = await rpcTxindexCheck(apiBase);
    if (txindex) return txindex;
  }
  forgetProbeOutspends(apiBase);
  try {
    let entry = null;
    for (const vout of [0, 1]) {
      const out = await mempoolOutspend(PROBE_TXID, vout, apiBase);
      if (out === null && rpc.isRpcBase(apiBase)) {
        return TXINDEX_OFF;
      }
      if (out === null) {
        return { ok: false, detail: 'unavailable — UTXO rules cannot be evaluated against this node', value: 'Unavailable — UTXO rules can\u2019t be evaluated' };
      }
      if (out.spent) { entry = out; break; }
    }
    const shape = singularOnlyBases.has(apiBase) ? 'singular' : 'batch';
    if (!entry) {
      // Both outputs read unspent: the node answers, but not with
      // a spend this probe can read the type from.
      return { ok: true, detail: 'ready (' + shape + '; answer type unknown)', value: 'Answers' };
    }
    if (!entry.bare) {
      return { ok: true, kind: 'full', detail: 'ready — names the spending transaction and its confirmations (' + shape + ')', value: 'Full answers' };
    }
    if (entry.verified && rpc.isRpcBase(apiBase)) {
      return { ok: true, kind: 'rpc-txindex', detail: 'ready — RPC with txindex; a confirmed spend is told from a mempool one', value: 'RPC with txindex' };
    }
    if (entry.verified) {
      return { ok: true, kind: 'bare-verified', detail: 'ready — says only \u201cspent\u201d; /api/prevouts tells a confirmed spend from a mempool one (' + shape + ')', value: 'Bare + confirmation check' };
    }
    return { ok: false, warn: true, kind: 'bare', detail: 'limited — says only \u201cspent\u201d and has no /api/prevouts, so a confirmed spend cannot be told from a mempool one', value: 'Bare only \u2014 can\u2019t tell confirmed spends' };
  } catch (e) {
    const msg = e.message || String(e);
    return { ok: false, detail: msg, value: msg };
  } finally {
    forgetProbeOutspends(apiBase);
  }
}

module.exports = {
  parseTx, extractTxFromPsbt, checkInputsUnspent, checkOutspend, checkOutspends, createOutspendBatch, dryRun, broadcastTx, testConnection,
  getConfirmations, getTipHeight, findSharedInputs, isArchivedTx, timelockedUntil, computeFee, txIoDetail, scriptPubKeyInfo,
  broadcastViaSlipstream, getSlipstreamTxStatus,
  feePeakFromObservations, appendFeeHistoryObservation, feeEstimatesToRecommended, feeEstimateAtTarget, ESPLORA_FEE_TARGETS,
  fetchCurrentFeesFromNode, fetchCurrentFeesFromEndpoints, feeVerdict,
  priceApiBase, DEFAULT_PRICE_API_URL,
  PRICE_PROVIDERS, priceProviderById, priceProviderLabel, fetchPriceFromProvider, PRICE_USER_AGENT,
  fetchPriceReadings, combinePriceReadings, priceConsensus,
  parseJsonPath, priceFromPath, customPriceProvider,
  normalizePriceSourceValue, priceSourceKey, resolvePriceSource,
  fetchNodeFee, fetchNodeFeeReadings, combineFeeReadings, FEE_IMPLAUSIBLE_SATVB,
  fetchTipHeights, combineTipHeights,
  normalizePublicApiUrl, mempoolBase, endpointsFor, nodeBases, nodeCheckedAt,
  clearOutspendCache,
  DEFAULT_PUBLIC_API_URL, DEFAULT_SECONDARY_API_URL,
  DEFAULT_SLIPSTREAM_API_URL,
};

