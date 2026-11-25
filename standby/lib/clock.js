'use strict';
// Is this device's clock right? Set-date and check-in triggers trust it, so
// a clock far off could fire one early (a desktop just woken, a dead clock
// battery). Node and RPC answers carry the node's time in their Date
// header; the median offset over the last hour is the device's error.
// Fails closed: with no recent node answer the clock is unverified, and a
// date trigger that would fire is held until a node answers.

const MAX_SKEW_MS = 10 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 15;

const samples = []; // { offsetMs, atMs }

function observe(dateHeader) {
  const serverMs = Date.parse(dateHeader || '');
  if (!Number.isFinite(serverMs)) return;
  const now = Date.now();
  samples.push({ offsetMs: now - serverMs, atMs: now });
  if (samples.length > MAX_SAMPLES) samples.shift();
}

// The device clock minus server time in ms (positive: the device is
// ahead), or null without a recent answer.
function offsetMs() {
  const now = Date.now();
  const recent = samples.filter((s) => Math.abs(now - s.atMs) <= WINDOW_MS).map((s) => s.offsetMs).sort((a, b) => a - b);
  if (!recent.length) return null;
  return recent[Math.floor(recent.length / 2)];
}

// 'verified', 'off' or 'unverified' (no node answer in the last hour).
function status() {
  const off = offsetMs();
  if (off === null) return 'unverified';
  return Math.abs(off) <= MAX_SKEW_MS ? 'verified' : 'off';
}

// The reason to hold a set-date or check-in trigger that would fire, or
// null when the clock is verified.
function problem() {
  const off = offsetMs();
  if (off === null) return "this device's time could not be checked against a node yet — date and check-in triggers are held until a node answers";
  if (Math.abs(off) <= MAX_SKEW_MS) return null;
  const mins = Math.round(Math.abs(off) / 60000);
  const span = mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' minutes';
  return "this device's clock is " + span + ' ' + (off > 0 ? 'ahead' : 'behind')
    + ' — date and check-in triggers are held until it is corrected';
}

// Whether to ask a node for its time now: unverified, and not asked in the
// last minute.
let lastAskMs = 0;
function shouldAsk() {
  if (status() !== 'unverified' || Date.now() - lastAskMs < 60000) return false;
  lastAskMs = Date.now();
  return true;
}

// Test only.
function reset() { samples.length = 0; lastAskMs = 0; }

module.exports = { observe, offsetMs, status, problem, shouldAsk, reset, MAX_SKEW_MS };
