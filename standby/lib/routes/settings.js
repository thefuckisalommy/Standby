'use strict';
const bitcoin = require('../bitcoin');
const { sanitizeState, syncCheckinFreeze } = require('../checkin');
const { saveMutation } = require('../http');
const { priceSourceError } = require('../prices');
const { rearmFullTick } = require('../release');
const { CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, FEE_LOW_MULT_MAX, FEE_LOW_MULT_MIN, FEE_MED_MULT_MAX, FEE_MED_MULT_MIN, GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN, asStr, readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function settingsRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/settings/price-sources/test {provider}:
  // tests one price provider with a FRESH fetch (bypasses the
  // price cache) and returns {provider, price, error}. Accepts
  // any of the five providers, not only the two configured
  // ones. Never changes the configured sources or the cache —
  // the Settings Test button uses this to check a provider
  // before (or without) saving it. A provider that fails
  // answers 200 with price null and the error, so the UI can
  // show the failure inline; only an unknown provider id is a
  // 400.
  if (req.method === 'POST' && pathname === '/api/settings/price-sources/test') {
    const body = await readBody(req);
    const prov = bitcoin.priceProviderById(body && body.provider);
    if (!prov) return sendError(res, 400, 'unknown price provider: ' + (body && body.provider));
    try {
      const price = await bitcoin.fetchPriceFromProvider(prov);
      return sendJson(res, 200, { provider: prov.id, price, error: null });
    } catch (e) {
      return sendJson(res, 200, { provider: prov.id, price: null, error: e.message });
    }
  }

  // POST /api/settings/price-sources/test-all {providers: [...]}:
  // tests several sources at once with FRESH fetches
  // (bypasses the price cache) and returns
  // {results: [{provider, label, price, error}, ...]} in the order
  // requested. Each entry is a provider id string or a custom
  // { id: 'custom', url, path } object. A source that
  // fails answers with price null and the error (the test itself
  // worked — the source is down); only a missing/empty providers
  // array is a 400, and an unknown id inside the list is reported
  // per-result, not as a whole-call failure. Never changes the
  // configured sources or the cache — the Settings "Test
  // connection" button uses this to check both sources in one call.
  if (req.method === 'POST' && pathname === '/api/settings/price-sources/test-all') {
    const body = await readBody(req);
    const ids = (body && Array.isArray(body.providers)) ? body.providers : [];
    if (!ids.length) return sendError(res, 400, 'providers must be a non-empty array');
    const results = await Promise.all(ids.map(async (src) => {
      const prov = bitcoin.resolvePriceSource(src);
      if (!prov) {
        const id = (typeof src === 'string') ? src : 'custom';
        return { provider: id, label: (typeof src === 'string') ? src : 'Custom', price: null, error: 'unknown price provider: ' + id };
      }
      try {
        const price = await bitcoin.fetchPriceFromProvider(prov);
        return { provider: prov.id, label: prov.label, price, error: null };
      } catch (e) {
        return { provider: prov.id, label: prov.label, price: null, error: e.message };
      }
    }));
    return sendJson(res, 200, { results });
  }

  // PUT /api/settings. There is no global broadcast threshold —
  // each check-in transaction carries its own threshold ("Days of
  // silence", set when the tx is added/edited). A thresholdDays in
  // the body is a 400, not a silent no-op: a stale client must not
  // believe the setting saved. The danger-zone reset is per tx
  // (PUT /api/bitcoin/txs/:id, add / import / arm).
  if (req.method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    const s = state.settings;
    // Snapshot for the fresh-state merge
    // below: only the settings this request changed are copied
    // into fresh state at save time.
    const origSettings = { ...s };
    if (body.thresholdDays !== undefined) {
      return sendError(res, 400, 'thresholdDays is no longer a setting — set "Days of silence" on each check-in transaction instead');
    }
    // `paused` is not a setting — Global Arm/Disarm is the
    // control. A stale client must not believe the setting saved.
    if (body.paused !== undefined) {
      return sendError(res, 400, 'paused is no longer a setting — use Global Arm/Disarm instead');
    }
    if (body.primaryApiUrl !== undefined) {
      const v = typeof body.primaryApiUrl === 'string' ? body.primaryApiUrl.trim() : '';
      try { s.primaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : bitcoin.DEFAULT_PUBLIC_API_URL; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.secondaryApiUrl !== undefined) {
      const v = typeof body.secondaryApiUrl === 'string' ? body.secondaryApiUrl.trim() : '';
      try { s.secondaryApiUrl = v ? bitcoin.normalizePublicApiUrl(v) : ''; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    // Secondary node on/off (Settings: Secondary node
    // toggle): a boolean; off means primary only, no fallback
    // anywhere. Missing in old state means enabled (the default).
    if (body.secondaryEnabled !== undefined) {
      if (typeof body.secondaryEnabled !== 'boolean') return sendError(res, 400, 'secondaryEnabled must be true or false');
      s.secondaryEnabled = body.secondaryEnabled;
    }
    if (body.priceSources !== undefined) {
      const ps = body.priceSources;
      if (!ps || typeof ps !== 'object') return sendError(res, 400, 'priceSources must be {source1, source2}');
      const s1 = bitcoin.normalizePriceSourceValue(ps.source1);
      const s2 = bitcoin.normalizePriceSourceValue(ps.source2);
      if (s1 === null) return sendError(res, 400, priceSourceError(ps.source1));
      if (s2 === null) return sendError(res, 400, priceSourceError(ps.source2));
      if (bitcoin.priceSourceKey(s1) === bitcoin.priceSourceKey(s2)) return sendError(res, 400, 'price sources must be different');
      s.priceSources = { source1: s1, source2: s2 };
    }
    // Grace period: the on/off toggle plus
    // the offline gap that triggers a grace and how long it lasts
    // (null = indefinite, until the owner resumes; a stored 0
    // still means off, kept for back-compat — the UI never sends
    // 0). Only the values the Settings card offers are
    // accepted — anything else is a 400. Saving new values does
    // NOT change an already-active grace (it keeps the duration
    // it was created with) — but turning the toggle off makes the
    // grace read as none everywhere at once (see graceStatus),
    // so held triggers fire immediately.
    if (body.graceEnabled !== undefined) {
      if (typeof body.graceEnabled !== 'boolean') {
        return sendError(res, 400, 'graceEnabled must be a boolean');
      }
      s.graceEnabled = body.graceEnabled;
    }
    if (body.graceOfflineDays !== undefined) {
      if (typeof body.graceOfflineDays !== 'number' || !GRACE_OFFLINE_DAYS.includes(body.graceOfflineDays)) {
        return sendError(res, 400, 'graceOfflineDays must be one of ' + GRACE_OFFLINE_DAYS.join(', ') + ' days');
      }
      s.graceOfflineDays = body.graceOfflineDays;
    }
    if (body.graceDurationDays !== undefined) {
      if (body.graceDurationDays !== null && (typeof body.graceDurationDays !== 'number' || !GRACE_DURATION_DAYS.includes(body.graceDurationDays))) {
        return sendError(res, 400, 'graceDurationDays must be one of ' + GRACE_DURATION_DAYS.join(', ') + ' days (0 = off, kept for back-compat), or null for indefinite');
      }
      s.graceDurationDays = body.graceDurationDays;
    }
    // User controls: each is a number input with a
    // min/max bound — anything outside is a 400, never a silent
    // clamp. The fee pair is validated together (using the new
    // value where given, the saved value otherwise) so a partial
    // update cannot break the Low-above-Medium invariant.
    if (body.priceAgreementPct !== undefined) {
      if (typeof body.priceAgreementPct !== 'number' || !Number.isFinite(body.priceAgreementPct) || body.priceAgreementPct < PRICE_AGREEMENT_PCT_MIN || body.priceAgreementPct > PRICE_AGREEMENT_PCT_MAX) {
        return sendError(res, 400, 'priceAgreementPct must be a number from ' + PRICE_AGREEMENT_PCT_MIN + ' to ' + PRICE_AGREEMENT_PCT_MAX + ' (%)');
      }
      s.priceAgreementPct = body.priceAgreementPct;
    }
    let cadenceChanged = false;
    if (body.checkCadenceSeconds !== undefined) {
      if (typeof body.checkCadenceSeconds !== 'number' || !Number.isFinite(body.checkCadenceSeconds) || body.checkCadenceSeconds < CHECK_CADENCE_SECONDS_MIN || body.checkCadenceSeconds > CHECK_CADENCE_SECONDS_MAX) {
        return sendError(res, 400, 'checkCadenceSeconds must be a number from ' + CHECK_CADENCE_SECONDS_MIN + ' to ' + CHECK_CADENCE_SECONDS_MAX + ' (seconds)');
      }
      s.checkCadenceSeconds = body.checkCadenceSeconds;
      cadenceChanged = true;
    }
    if (body.feeLowMultiplier !== undefined || body.feeMediumMultiplier !== undefined) {
      const low = (body.feeLowMultiplier !== undefined) ? body.feeLowMultiplier : s.feeLowMultiplier;
      const med = (body.feeMediumMultiplier !== undefined) ? body.feeMediumMultiplier : s.feeMediumMultiplier;
      if (typeof low !== 'number' || !Number.isFinite(low) || low < FEE_LOW_MULT_MIN || low > FEE_LOW_MULT_MAX) {
        return sendError(res, 400, 'feeLowMultiplier must be a number from ' + FEE_LOW_MULT_MIN + ' to ' + FEE_LOW_MULT_MAX + ' (× peak)');
      }
      if (typeof med !== 'number' || !Number.isFinite(med) || med < FEE_MED_MULT_MIN || med > FEE_MED_MULT_MAX) {
        return sendError(res, 400, 'feeMediumMultiplier must be a number from ' + FEE_MED_MULT_MIN + ' to ' + FEE_MED_MULT_MAX + ' (× peak)');
      }
      if (low <= med) {
        return sendError(res, 400, 'feeLowMultiplier must be greater than feeMediumMultiplier');
      }
      if (body.feeLowMultiplier !== undefined) s.feeLowMultiplier = body.feeLowMultiplier;
      if (body.feeMediumMultiplier !== undefined) s.feeMediumMultiplier = body.feeMediumMultiplier;
    }
    // Vacation mode: check-in-only — while it is on, the
    // check-in countdown freezes. vacationUntil is the last away
    // day ('YYYY-MM-DD'); null (or '' from an older client) means
    // indefinite, until the owner says they're back. A change to
    // vacationMode re-syncs the freeze on every check-in tx, so
    // the days away start / stop counting exactly here.
    if (body.vacationMode !== undefined) s.vacationMode = !!body.vacationMode;
    if (body.vacationUntil === null) s.vacationUntil = null;
    else if (body.vacationUntil !== undefined) s.vacationUntil = asStr(body.vacationUntil, 10) || null;
    // The assignments above mutated the
    // request's snapshot; only the CHANGED settings ride into fresh
    // state, so a concurrent save is not clobbered. The fee pair is
    // re-checked on the fresh values when this request touched it
    // (a concurrent save could have moved the half it did not set).
    const fresh = saveMutation((f) => {
      for (const k of Object.keys(s)) {
        if (JSON.stringify(s[k]) !== JSON.stringify(origSettings[k])) f.settings[k] = s[k];
      }
      if ((body.feeLowMultiplier !== undefined || body.feeMediumMultiplier !== undefined)
          && !(f.settings.feeLowMultiplier > f.settings.feeMediumMultiplier)) return false;
      if (body.vacationMode !== undefined) {
        for (const t of (f.bitcoin.txs || [])) syncCheckinFreeze(t, f, now);
      }
    });
    if (!fresh) return sendError(res, 400, 'feeLowMultiplier must be greater than feeMediumMultiplier');
    // A new cadence takes effect immediately — the running fast
    // tick is cleared and restarted with the new delay.
    if (cadenceChanged) rearmFullTick();
    return sendJson(res, 200, sanitizeState(fresh).settings);
  }
  return NEXT;
};
