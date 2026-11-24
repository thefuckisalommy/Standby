'use strict';
// Standby — shared fetch caches.
// One holder object whose identity never changes: the fetchers
// REASSIGN the caches (caches.price = {...}), so destructured imports
// would go stale. Every reader/writer goes through `caches.*`.
const bitcoin = require('./bitcoin');

const caches = {
  price: { readings: {}, fetchedAt: null, source1: null, source2: null },
  nodeFee: { readings: null, fetchedAt: null, primary: null, secondary: null },
  nodeTip: { readings: null, fetchedAt: null, primary: null, secondary: null },
  currentFees: { fees: null, fetchedAt: null },
};

// Test-only cache clear (POST /api/__test__/clear-caches): `only` is an
// array of cache names, or null for all. Returns the cleared names.
function clearCaches(only) {
  const want = (name) => !only || only.includes(name);
  const cleared = [];
  if (want('price')) { caches.price = { readings: {}, fetchedAt: null, source1: null, source2: null }; cleared.push('price'); }
  if (want('nodeFee')) { caches.nodeFee = { readings: null, fetchedAt: null, primary: null, secondary: null }; cleared.push('nodeFee'); }
  if (want('nodeTip')) { caches.nodeTip = { readings: null, fetchedAt: null, primary: null, secondary: null }; cleared.push('nodeTip'); }
  if (want('currentFees')) { caches.currentFees = { fees: null, fetchedAt: null }; cleared.push('currentFees'); }
  if (want('outspend')) { bitcoin.clearOutspendCache(); cleared.push('outspend'); }
  return cleared;
}

module.exports = { caches, clearCaches };
