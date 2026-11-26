'use strict';
const bitcoin = require('../bitcoin');
const rpc = require('../rpc');
const { sanitizeState, syncCheckinFreeze } = require('../checkin');
const { saveMutation } = require('../http');
const { priceSourceError } = require('../prices');
const { rearmFullTick } = require('../release');
const remoteCheckin = require('../remote-checkin');
const autostart = require('../autostart');
const updates = require('../updates');
const desktop = require('../desktop');
const { STANDALONE } = require('../config');
const { CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, FEE_LOW_MULT_MAX, FEE_LOW_MULT_MIN, FEE_MED_MULT_MAX, FEE_MED_MULT_MIN, GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN, asStr, readBody, sendError, sendJson } = require('../util');
const { NEXT } = require('./shared');

module.exports = async function settingsRoutes(ctx) {
  const { req, res, pathname, now } = ctx;
  let state = ctx.state;

  // POST /api/settings/price-sources/test { provider }: fetch one provider
  // fresh (bypassing the cache) and return { provider, price, error }.
  // Changes nothing. A failing provider is a 200 with the error; only an
  // unknown id is a 400.
  // GET /api/remote-checkin: the check-in port for other devices —
  // { available (not on Docker/Umbrel), listening, port, error,
  // addresses (this computer's IPv4 addresses) }.
  if (req.method === 'GET' && pathname === '/api/remote-checkin') {
    return sendJson(res, 200, remoteCheckin.status());
  }

  // GET /api/desktop: this computer's options (standalone builds):
  // { available, startAtLogin, stop (Stop Standby offered), platform
  // ('win32' has the tray icon; Linux runs with no window), error }.
  if (req.method === 'GET' && pathname === '/api/desktop') {
    const a = autostart.status();
    return sendJson(res, 200, { available: a.available, startAtLogin: state.settings.startAtLogin !== false, stop: STANDALONE, platform: a.platform, error: a.error });
  }

  // POST /api/app/stop: Stop Standby (standalone builds only). Answers,
  // then shuts down cleanly; nothing is checked until it is started again.
  if (req.method === 'POST' && pathname === '/api/app/stop') {
    if (!STANDALONE) return sendError(res, 400, 'Stop Standby is only for the Windows and Linux downloads');
    console.log('Standby: stopped from the page (Stop Standby)');
    sendJson(res, 200, { ok: true });
    setTimeout(() => desktop.quit(), 300);
    return undefined;
  }

  // GET /api/update: "Check for new versions" — { available, enabled,
  // current, latest, newer, url, checkedAt, error }. POST
  // /api/update/check checks now (when it is on).
  if (req.method === 'GET' && pathname === '/api/update') {
    return sendJson(res, 200, updates.status(updates.enabledFor(state.settings)));
  }
  if (req.method === 'POST' && pathname === '/api/update/check') {
    if (!updates.enabledFor(state.settings)) return sendError(res, 400, 'checking for new versions is off');
    return sendJson(res, 200, await updates.check());
  }

  // POST /api/setup { done }: the first-open setup finished or skipped
  // (true), or shown again (false; Start fresh also does this).
  if (req.method === 'POST' && pathname === '/api/setup') {
    const body = await readBody(req);
    if (!body || typeof body.done !== 'boolean') return sendError(res, 400, 'done must be true or false');
    saveMutation((f) => { f.setup = { done: body.done }; });
    return sendJson(res, 200, { ok: true, setup: { done: body.done } });
  }

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

  // POST /api/settings/price-sources/test-all { providers: [...] }: the
  // same for several sources (ids or custom objects), results in request
  // order. Changes nothing; a missing or empty list is a 400, a bad entry
  // is reported in its result.
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

  // PUT /api/settings. There is no global threshold (each check-in rule
  // has its own): thresholdDays is a 400, so a stale client does not think
  // it saved.
  if (req.method === 'PUT' && pathname === '/api/settings') {
    const body = await readBody(req);
    const s = state.settings;
    // Snapshot: only the settings this request changes are copied into
    // fresh state.
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
    for (const key of ['primaryRpc', 'secondaryRpc']) {
      if (body[key] === undefined) continue;
      try { s[key] = rpc.normalizeSetting(body[key], s[key]); }
      catch (e) { return sendError(res, 400, (key === 'primaryRpc' ? 'primary' : 'secondary') + ' node: ' + e.message); }
    }
    // Secondary on/off (boolean); off means primary only. Missing means
    // on.
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
    // Grace settings: only the values the card offers (a stored 0 still
    // means off). New values do not change an active grace; turning the
    // toggle off makes it read as none everywhere at once.
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
    // Bounded number inputs: out of range is a 400, never clamped. The fee
    // pair is validated together (new value or saved one).
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
    // Vacation (check-in only) freezes the countdown; vacationUntil is the
    // last day away, null (or a legacy '') until back. A change re-syncs
    // every check-in tx's freeze.
    if (body.vacationMode !== undefined) s.vacationMode = !!body.vacationMode;
    if (body.startAtLogin !== undefined) {
      if (typeof body.startAtLogin !== 'boolean') return sendError(res, 400, 'startAtLogin must be true or false');
      if (!autostart.AVAILABLE) return sendError(res, 400, 'starting with the computer is only for the Windows and Linux downloads');
      s.startAtLogin = body.startAtLogin;
    }
    if (body.updateCheck !== undefined) {
      if (typeof body.updateCheck !== 'boolean') return sendError(res, 400, 'updateCheck must be true or false');
      if (!updates.AVAILABLE) return sendError(res, 400, 'Umbrel updates its apps itself');
      s.updateCheck = body.updateCheck;
    }
    if (body.acceptRemoteCheckins !== undefined) {
      if (typeof body.acceptRemoteCheckins !== 'boolean') return sendError(res, 400, 'acceptRemoteCheckins must be true or false');
      if (body.acceptRemoteCheckins && !remoteCheckin.AVAILABLE) {
        return sendError(res, 400, 'here the separate check-in receiver accepts check-ins from other devices');
      }
      s.acceptRemoteCheckins = body.acceptRemoteCheckins;
    }
    if (body.vacationUntil === null) s.vacationUntil = null;
    else if (body.vacationUntil !== undefined) s.vacationUntil = asStr(body.vacationUntil, 10) || null;
    // Only the changed settings are saved into fresh state; the fee pair
    // is re-checked there if this request set half of it.
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
    if (body.acceptRemoteCheckins !== undefined) remoteCheckin.sync(fresh);
    if (body.startAtLogin !== undefined) autostart.sync(fresh.settings.startAtLogin);
    if (body.updateCheck !== undefined) updates.sync(fresh.settings, true);
    return sendJson(res, 200, sanitizeState(fresh).settings);
  }
  return NEXT;
};
