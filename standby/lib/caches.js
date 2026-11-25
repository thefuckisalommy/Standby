'use strict';
// Shared fetch caches on one holder object: fetchers reassign its fields,
// so always go through caches.*, never destructure.
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
  if (want('clock')) { require('./clock').reset(); cleared.push('clock'); }
  return cleared;
}

module.exports = { caches, clearCaches };
