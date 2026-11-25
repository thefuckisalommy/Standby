'use strict';
// Is this device's clock right? Set-date and check-in triggers trust it, so
// a clock far ahead could fire one early (common on a desktop that just
// woke, or one with a dead clock battery). Every HTTP answer Standby gets
// (nodes, RPC, price sources) carries the server's time in its Date
// header; the median offset over the last hour is the device's error.
// No answers in the last hour: unknown, which holds nothing.

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

// The reason to hold set-date and check-in triggers, or null when the clock
// is fine or unknown.
function problem() {
  const off = offsetMs();
  if (off === null || Math.abs(off) <= MAX_SKEW_MS) return null;
  const mins = Math.round(Math.abs(off) / 60000);
  const span = mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' minutes';
  return "this device's clock is " + span + ' ' + (off > 0 ? 'ahead' : 'behind')
    + ' — date and check-in triggers are held until it is corrected';
}

// Test only.
function reset() { samples.length = 0; }

module.exports = { observe, offsetMs, problem, reset, MAX_SKEW_MS };
