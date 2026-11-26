'use strict';

// Transactions: parsing signed hex, extracting a transaction from a
// finalized PSBT, output addresses, and which stored transactions share
// inputs. No network.

const crypto = require('crypto');

const MAX_TX_BYTES = 1000000; // 1 MB, same ceiling as the API body limit

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

module.exports = { timelockedUntil, parseTx, extractTxFromPsbt, scriptPubKeyInfo, txIoDetail, isArchivedTx, findSharedInputs };
