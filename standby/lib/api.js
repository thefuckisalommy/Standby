'use strict';
// Standby — JSON API router.
const store = require('./store');
const bitcoin = require('./bitcoin');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { caches, clearCaches } = require('./caches');
const { applyGrace, checkinLiveOffsetMs, checkinStatus, graceStatus, hashCheckinKey, inDangerZone, mergeExternalCheckin, newCheckinKeyId, publicCheckinKey, resetCheckin, sanitizeState, startupWarnings, syncCheckinFreeze, writeReceiverKeys } = require('./checkin');
const { CHECKIN_DIR, DATA_DIR, TEST_MODE, VERSION } = require('./config');
const auth = require('./auth');
const backupcrypto = require('./backupcrypto');
const { HISTORY_MAX, forwardMemberHistory, noteSetMemberStale, pushHistory, shortTxid } = require('./history');
const { csrfAllowed, fetchSiteAllowed, saveMutation } = require('./http');
const { checkCadenceSecondsOf, exchangeStatusFor, fetchPriceCached, priceAgreementPctOf, priceCacheForState, priceSourceError, priceSourcesOf } = require('./prices');
const { currentFeesForState, evaluateRelease, feePeakForState, mergeNodeStamps, rearmFullTick, refreshConfirmations, refreshMaraWaiting, refreshPublicFallbacks } = require('./release');
const { broadcastOne, checkTriggerNow, triggerStatusFor } = require('./rules');
const { releaseTriggerFor, serveSet, serveSets, serveTx, serveTxs, setMembers, triggerConditionText } = require('./triggers');
const { CHECK_CADENCE_SECONDS_DEFAULT, CHECK_CADENCE_SECONDS_MAX, CHECK_CADENCE_SECONDS_MIN, FEE_LOW_MULT_DEFAULT, FEE_LOW_MULT_MAX, FEE_LOW_MULT_MIN, FEE_MED_MULT_DEFAULT, FEE_MED_MULT_MAX, FEE_MED_MULT_MIN, GRACE_DURATION_DAYS, GRACE_OFFLINE_DAYS, PRICE_AGREEMENT_PCT_DEFAULT, PRICE_AGREEMENT_PCT_MAX, PRICE_AGREEMENT_PCT_MIN, asStr, clampInt, days, readBody, sendError, sendJson, validBroadcastVia, validPublicFallbackDays } = require('./util');

const RELEASE_STATUSES = new Set(['stale', 'failed', 'broadcast', 'conflict', 'submitted-slipstream']);
// The kinds a release record may carry — 'release' for the automatic
// release, 'broadcast' for a manual broadcast, 'dryrun' for a
// dry-run verdict. Used by the restore validation.
const RELEASE_KINDS = new Set(['release', 'broadcast', 'dryrun']);

async function handleApi(req, res, pathname) {
  const now = new Date();
  // Fetch metadata: a browser request from another site
  // — or another port on the same host, i.e. another Umbrel app —
  // is refused before anything else, reads included. See
  // fetchSiteAllowed in lib/http.js.
  if (!fetchSiteAllowed(req)) {
    return sendError(res, 403, 'cross-site request rejected');
  }
  // CSRF gate: state-changing requests must come from the
  // app's own page — see csrfAllowed above. Checked before any state
  // is loaded, so a rejected request cannot touch anything.
  if (req.method !== 'GET' && !csrfAllowed(req)) {
    return sendError(res, 403, 'cross-origin or non-JSON request rejected');
  }
  // App login — see lib/auth.js. Checked before any
  // state is loaded. Off when STANDBY_PASSWORD is unset. The
  // `login: true` flag tells the UI to show its login screen.
  if (auth.enabled() && !auth.routeIsPublic(req.method, pathname) && !auth.requestAuthorized(req, now.getTime())) {
    return sendJson(res, 401, { error: 'login required', login: true });
  }

  // GET /api/auth/status: is a login required, and does
  // this request carry a valid one? The UI asks on startup.
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    return sendJson(res, 200, { required: auth.enabled(), authenticated: auth.requestAuthorized(req, now.getTime()) });
  }

  // POST /api/login {password} -> {ok, token}. With no
  // password configured it answers {ok:true, token:null}. Wrong
  // passwords are rate-limited (429) and logged without the value.
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req).catch(() => ({}));
    if (!auth.enabled()) return sendJson(res, 200, { ok: true, token: null });
    if (auth.loginLimited(now.getTime())) {
      return sendError(res, 429, 'too many wrong passwords — wait a minute and try again');
    }
    if (!auth.passwordMatches(body && body.password)) {
      auth.recordLoginFailure(now.getTime());
      console.warn('Standby: failed login attempt');
      return sendError(res, 401, 'wrong password');
    }
    return sendJson(res, 200, { ok: true, token: auth.issueToken(now.getTime()) });
  }

  // POST /api/logout: rotates the session secret, which
  // signs out every device. Requires a login (the gate above).
  if (req.method === 'POST' && pathname === '/api/logout') {
    if (auth.enabled()) auth.rotateSessionSecret();
    return sendJson(res, 200, { ok: true });
  }
  // A state file that cannot be loaded — corrupt or
  // missing with no usable backup — throws loudly by design, but
  // it must not take the whole API down with it: the two rescue
  // endpoints do not need the current state (restore validates
  // the uploaded backup from the body alone; reset starts fresh),
  // so they still run. Everything else answers with the load
  // error, exactly as before — including /api/health, which keeps
  // 500ing in this state.
  let state = null;
  let stateError = null;
  try {
    state = store.loadState(DATA_DIR);
  } catch (e) {
    stateError = e;
  }
  if (stateError) {
    const rescue = req.method === 'POST'
      && (pathname === '/api/restore' || pathname === '/api/state/reset');
    if (!rescue) return sendError(res, 500, stateError.message || 'internal error');
  }

  // POST /api/state/reset — start fresh after an unrecoverable
  // state-load failure. This sits above the endpoints
  // that need state because it must run while state fails to
  // load (see the rescue gate above): it deletes the state file
  // and every local backup, empties the audit logs, clears the
  // receiver keys, and writes a fresh default state. The body
  // must be {confirm:true} — anything else is a 400, so a stray
  // or accidental call cannot erase anything.
  if (req.method === 'POST' && pathname === '/api/state/reset') {
    const body = await readBody(req);
    if (!body || body.confirm !== true) {
      return sendError(res, 400, 'reset requires {confirm:true}');
    }
    store.resetStateFiles(DATA_DIR);
    // Also drop the receiver's last check-in record: on
    // the next /api/state read mergeExternalCheckin would otherwise
    // resurrect the pre-reset check-in time into the fresh state
    // (a fresh state's clock is null, so any last.json wins).
    // A start-fresh means fresh — including the clock.
    try { fs.unlinkSync(path.join(CHECKIN_DIR, 'last.json')); } catch {}
    const fresh = store.defaultState();
    store.saveState(DATA_DIR, fresh);
    store.writeCheckins(DATA_DIR, []);
    store.writeBroadcastLog(DATA_DIR, []);
    writeReceiverKeys(fresh);
    store.clearStateWarnings();
    startupWarnings.length = 0;
    rearmFullTick();
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/__test__/clear-caches (test-only, speedup): drop every
  // in-memory cache a restart would cold — price, node fee, tip,
  // fee peak, current fees, and the UTXO outspend caches — WITHOUT
  // restarting (no state re-read, no tick-timer reset, no 7 s
  // startup wait). It lives under /api/ so the dispatcher routes
  // it to handleApi (a bare /__test__/ path would fall through to
  // the static file server and 404). Gated on
  // STANDBY_TEST_MODE=1, which only the test harness sets
  // (verify094.start); without it the route 404s exactly like any
  // unknown path, so it cannot run in production. The caches are
  // reset to their initial shapes, so the next read fetches fresh
  // from the (stub) sources.
  // A body of { only: [...] } clears just
  // the named caches — the DOM suite clears only 'price', so the
  // fee-peak cache (re-fetched only by the startup refresh and the
  // hourly tick) survives and the fee-verdict pill keeps working.
  // With no `only` array the call clears everything, as before
  // (the API and regression suites rely on the full clear).
  if (req.method === 'POST' && pathname === '/api/__test__/clear-caches') {
    if (!TEST_MODE) return sendError(res, 404, 'not found');
    const clearBody = await readBody(req).catch(() => ({}));
    const only = (clearBody && Array.isArray(clearBody.only)) ? clearBody.only : null;
    return sendJson(res, 200, { ok: true, cleared: clearCaches(only) });
  }

  // POST /api/__test__/throw-uncaught (test-only): throw an
  // uncaught exception on the next tick, outside any handler, so
  // the suite can prove the process terminates instead of serving
  // through it. Gated on STANDBY_TEST_MODE=1
  // like clear-caches above. Answers 200 first — the throw lands
  // after the response, so the caller observes the 200 and then
  // the exit.
  if (req.method === 'POST' && pathname === '/api/__test__/throw-uncaught') {
    if (!TEST_MODE) return sendError(res, 404, 'not found');
    setTimeout(() => { throw new Error('test-only uncaught exception'); }, 0);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION });
  }

  // GET /api/state — full state (no secrets live in state).
  // Also carries the shared inputs, derived from the stored
  // transactions on every read (findSharedInputs parses the hexes,
  // no network): the UI renders the shared-input warning from this,
  // so the warning persists across refreshes and clears the moment a
  // transaction is edited away from the shared input. It is derived,
  // not stored — the state file holds only the transactions.
  if (req.method === 'GET' && pathname === '/api/state') {
    // A receiver check-in that landed since the last read is merged
    // first, so the state served is current.
    mergeExternalCheckin(state, now);
    // The grace: judged here too, so a
    // page load reflects it even if no release tick has run since
    // the device came back — held rules cannot fire before the
    // grace is noticed. The stamp is NOT refreshed on a read
    // (only the tick does that), so the gap stays honest.
    try {
      let changed = false;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('grace apply failed:', e); }
    const served = sanitizeState(state);
    // The fee history is state-internal — the raw hourly
    // observations (~2,160 entries) are never served; the peak,
    // window, count, and basis below describe them. Serving the
    // series would bloat every state read for data the UI never
    // renders.
    delete served.feeHistory;
    // Persistence / startup warnings for the UI (a later
    // increment renders them): a state recovery that happened in
    // this process, a receiver key list rewritten at startup, keys
    // orphaned in the receiver, or keys found in a backup. Empty
    // on a healthy run.
    served.warnings = startupWarnings.concat(store.getStateWarnings());
    served.grace = graceStatus(state, now); // the grace: null when none is active, else { active, indefinite, graceUntil, triggeredAt, offlineGapDays }
    served.bitcoin.overlaps = bitcoin.findSharedInputs(state.bitcoin.txs || []);
    // The fee verdict's peak: computed
    // from the recorded fee history in this state — the 90th
    // percentile of the hourly economy-fee observations, with the
    // window they span in days, how many there are, and the basis
    // (always fee estimates: one consistent day-scale measurement
    // across mempool, Esplora, and RPC modes). Derived on every
    // read, like the overlaps — the peak itself is never stored,
    // only the observations are. A null peak means the history is
    // still building (fewer than 24 observations) and there is no
    // verdict anywhere; the frontend compares each active tx's own
    // fee rate to this peak.
    const fp = feePeakForState(state);
    served.bitcoin.feePeak = fp.peak;
    served.bitcoin.feePeakWindowDays = fp.windowDays;
    served.bitcoin.feePeakObservations = fp.observations;
    served.bitcoin.feePeakBasis = fp.basis;
    served.bitcoin.feePeakAt = fp.fetchedAt;
    // The current recommended fees: the cached object (or
    // null when there is no usable current-fee data), with the
    // fetched-at timestamp. The frontend compares each active tx's
    // own fee rate to the economy fee for the Critical Risk check;
    // a null object means the check is skipped and only the
    // historical ladder runs.
    const cf = currentFeesForState();
    served.bitcoin.currentFees = cf.fees;
    served.bitcoin.currentFeesAt = cf.fetchedAt;
    // The BTC price: the cached price (or nulls when
    // nothing has been fetched yet), so a price rule's "currently
    // $X" line is live on the card. currentPrices is the
    // per-source readings map (for the Settings display); the
    // provider list is served so the Settings selects always
    // match the registry.
    const pc = priceCacheForState(priceAgreementPctOf(state.settings));
    served.bitcoin.currentPrice = pc.price;
    served.bitcoin.currentPriceAt = pc.fetchedAt;
    served.bitcoin.currentPrices = pc.prices;
    served.bitcoin.priceProviders = bitcoin.PRICE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })).concat([{ id: 'custom', label: 'Custom' }]);
    // The consolidated exchange status: one status for
    // the configured price sources, shown once on the readiness
    // card (like Node Status) instead of repeated per price tx.
    served.bitcoin.exchangeStatus = exchangeStatusFor(pc, priceSourcesOf(state.settings), priceAgreementPctOf(state.settings));
    // The inputs/outputs detail: derived from
    // the stored hexes on every read, like the overlaps — never
    // stored, so no migration and no restore change. An unparseable
    // hex (defensive only — adds and restores validate) gets no
    // detail, and the card falls back to the plain counts.
    for (const t of served.bitcoin.txs || []) {
      try { t.detail = bitcoin.txIoDetail(bitcoin.parseTx(t.hex)); }
      catch { t.detail = null; }
      // The trigger: normalized (so the UI always sees a
      // valid one — a legacy tx reads as the check-in trigger) and
      // its current status, computed from the stored evaluation
      // (no network on a read) — except the check-in trigger,
      // whose state is live clock math. The served trigger
      // is the legacy single-rule shape for a one-rule set and the
      // set for a multi-rule set (see serveTrigger); the served
      // triggerState matches — a flat slice for one rule, the
      // per-rule array for several. The status is computed first,
      // on the stored form, so a one-rule set reads exactly as it
      // did before rule sets.
      t.triggerStatus = triggerStatusFor(state, t, now);
      const servedSet = store.triggerOf(t);
      t.trigger = store.serveTrigger(servedSet);
      t.triggerState = store.serveTriggerState(servedSet, t.triggerState);
    }
    // Trigger sets are served the same way as txs: the
    // trigger in the dual shape, its current status computed from
    // the stored evaluation (no network on a read). The members
    // ride in served.bitcoin.txs as usual — the frontend joins
    // them by the set's txIds.
    for (const s of served.bitcoin.sets || []) {
      s.triggerStatus = triggerStatusFor(state, s, now);
      const servedSetT = store.triggerOf(s);
      s.trigger = store.serveTrigger(servedSetT);
      s.triggerState = store.serveTriggerState(servedSetT, s.triggerState);
    }
    return sendJson(res, 200, served);
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    const merged = mergeExternalCheckin(state, now);
    // The grace: see GET /api/state — the
    // card reads this endpoint, so the grace must be judged here too.
    try {
      let changed = false;
      if (applyGrace(state, now)) changed = true;
      if (changed) store.saveState(DATA_DIR, state);
    } catch (e) { console.error('grace apply failed:', e); }
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...checkinStatus(state, now),
      lastCheckinAt: state.checkin.lastCheckinAt,
      totalCheckins: state.checkin.totalCheckins,
      // Whether the receiver's
      // check-in file could not be read. A missing file is NOT an
      // error (no receiver installed); an unreadable one means the
      // release evaluation is withheld until it can be read again.
      checkinReadError: merged === 'error',
      bitcoinEnabled: txs.some((t) => t.enabled),
      bitcoinTxStored: txs.length > 0,
      primaryApiUrl: state.settings.primaryApiUrl,
      secondaryApiUrl: state.settings.secondaryApiUrl,
      // Per-tx release records (only txs with one) — the cycle-scoped
      // ones are cleared by a check-in, but a stale record survives
      // (it is a fact about the inputs, not the cycle).
      releases: txs.filter((t) => t.release).map((t) => ({
        id: t.id, txid: t.txid, label: t.label || '', ...t.release,
      })),
    });
  }

  // GET /api/checkins
  if (req.method === 'GET' && pathname === '/api/checkins') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, store.readCheckins(DATA_DIR, 50).reverse());
  }

  // GET /api/broadcast/log — dry-runs, broadcasts, release attempts.
  if (req.method === 'GET' && pathname === '/api/broadcast/log') {
    return sendJson(res, 200, store.readBroadcastLog(DATA_DIR, 50).reverse());
  }

  // POST /api/release/check — run the release evaluation now (the full tick runs the same evaluation on the cadence).
  // A receiver check-in is merged inside evaluateRelease first,
  // so a check-in that arrived since the last read is honoured here too.
  if (req.method === 'POST' && pathname === '/api/release/check') {
    const r = await evaluateRelease();
    // MARA-waiting transactions: refresh after the
    // evaluation, so a tx MARA just dropped is retried on the next
    // evaluation, not in this one. The response below is read from
    // fresh state, so it already reflects the refresh.
    try { await refreshMaraWaiting(store.loadState(DATA_DIR)); } catch (e) { console.error('MARA-waiting refresh failed:', e); }
    // Public fallback: after the MARA refresh, so a tx
    // MARA just confirmed as visible is not also fallback-broadcast.
    // Runs regardless of the check-in clock — a due fallback fires
    // even while the clock is on-track.
    let fallbacks = [];
    try { fallbacks = await refreshPublicFallbacks(store.loadState(DATA_DIR)); } catch (e) { console.error('public-fallback refresh failed:', e); }
    state = store.loadState(DATA_DIR);
    const txs = state.bitcoin.txs || [];
    return sendJson(res, 200, {
      ...r,
      fallbacks,
      status: checkinStatus(state, now),
      releases: txs.filter((t) => t.release).map((t) => ({ id: t.id, txid: t.txid, label: t.label || '', ...t.release })),
    });
  }

  // POST /api/triggers/check — evaluate a trigger ONCE, live, WITHOUT
  // changing any state. The UI calls this when the owner picks
  // a trigger in the Add/Edit form, so the already-true guard can warn
  // before the rule is added ("this condition is already satisfied —
  // it would fire on the next evaluation"). Body { trigger, txId? } — the
  // same shape POST /api/bitcoin/txs accepts, plus an optional txId
  // naming the transaction being edited: for a check-in rule its
  // frozen time (disarmed / vacation) counts, so the guard measures
  // the same effective clock the evaluator uses. A new tx (no txId)
  // has no frozen time. An invalid trigger is
  // a 400 with the reason. A price trigger whose price is already
  // past the threshold (both sources agree) reports fire=true.
  // A UTXO trigger whose outpoint is already spent (confirmed)
  // reports fire=true. A trigger that cannot be read (a feed
  // outage, an outpoint no node can say about) is 'unknown',
  // never a fire.
  if (req.method === 'POST' && pathname === '/api/triggers/check') {
    const body = await readBody(req).catch(() => ({}));
    const v = store.normalizeTrigger(body.trigger);
    if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
    // The frozen time for the tx being edited, if any — only a
    // check-in rule reads it (checkTriggerNow takes it as the
    // clock's live offset); a price or UTXO rule ignores it.
    let liveOff = 0;
    if (typeof body.txId === 'string' && body.txId) {
      const etx = (state.bitcoin.txs || []).find((t) => t.id === body.txId);
      if (etx) {
        liveOff = checkinLiveOffsetMs(etx, now);
      }
    }
    try {
      const r = await checkTriggerNow(v.trigger, state, now, { liveOffsetMs: liveOff });
      return sendJson(res, 200, { ...r, trigger: store.serveTrigger(v.trigger) });
    } catch (e) {
      // Belt-and-braces: checkTriggerNow already answers 'unknown'
      // on a fetch failure, so a throw here is a bug — but it must
      // still answer 'unknown', never crash the check.
      return sendJson(res, 200, { valid: true, fire: false, status: 'unknown', reason: 'could not check the trigger — will retry', warning: null, detail: { error: e.message }, trigger: store.serveTrigger(v.trigger) });
    }
  }

  // POST /api/checkin — clears the CHECK-IN rules' cycle-scoped release records:
  // a new cycle starts for them. A price or UTXO rule's record belongs
  // to its own trigger's cycle, not the check-in clock, so a check-in does
  // not clear it — and does not reset its trigger. A stale record is NOT
  // cleared: spent inputs are a fact about the transaction, not the cycle, so
  // a stale transaction stays stale (and archived) across check-ins — only
  // replacing the hex re-arms it. (If a broadcast already went out, the funds
  // have already moved.) A 'submitted-slipstream' record IS
  // cleared, like any other non-stale cycle record: the check-in ends
  // the cycle, and the card goes back to Ready — but the transaction
  // is still sitting in MARA's private mempool, and a check-in cannot
  // recall it. If MARA mines it, the public-node lookup (or a fresh
  // dry-run) recognises the tx's own txid out there and records it
  // broadcast; if MARA drops it, the next release re-submits it.
  if (req.method === 'POST' && pathname === '/api/checkin') {
    const body = await readBody(req).catch(() => ({}));
    const method = body.method === 'telegram' ? 'telegram' : 'app';
    const fresh = saveMutation((f) => {
      f.checkin.lastCheckinAt = now.toISOString();
      f.checkin.totalCheckins += 1;
      for (const t of (f.bitcoin.txs || [])) {
        if (!store.hasTriggerType(t, 'checkin')) continue;
        if (t.release && t.release.status === 'stale') continue;
        t.release = null;
        // The clock restarts at this check-in: any frozen time is
        // wiped, then a tx that is still inactive (disarmed, or on
        // vacation) is re-marked inactive from now — it stays frozen
        // at 0 instead of counting while inactive. Checking in does
        // NOT re-arm anything: there is no global pause to
        // auto-resume.
        t.checkinOffsetMs = 0;
        t.checkinInactiveSince = null;
      }
      for (const t of (f.bitcoin.txs || [])) syncCheckinFreeze(t, f, now);
    });
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method });
    return sendJson(res, 200, { ok: true, status: checkinStatus(fresh, now) });
  }

  // POST /api/grace/resume — end the grace period
  // immediately. The dashboard's Grace period card
  // offers this while a grace is active; an indefinite grace
  // can only end this way (saving new grace settings never
  // changes an active one). Idempotent: resuming with no grace
  // active is a 200 no-op. Returns the grace state after the
  // resume (null when no grace is active). A check-in does NOT
  // clear the grace — this endpoint is the only way.
  // The resume also refreshes lastOnlineAt to now: the owner
  // just used the live app, so it is online now, and the next
  // read / tick must not re-set a grace on the same stale gap
  // (without this, resuming while the stamp is still stale
  // re-sets the grace on the very next read).
  if (req.method === 'POST' && pathname === '/api/grace/resume') {
    const fresh = saveMutation((f) => {
      f.grace = { graceUntil: null, triggeredAt: null, offlineGapDays: null };
      f.checkin.lastOnlineAt = now.toISOString();
    });
    return sendJson(res, 200, { ok: true, grace: graceStatus(fresh, now) });
  }

  // Check-in API keys — managed here, used by the check-in
  // receiver. A key is created with a label; the plaintext is returned
  // ONCE in the response and never stored — only its hash is kept, and
  // the hashes are published to the receiver (keys.json) on every
  // change. The list never carries the hash (the UI has no use for
  // it). Revoking a key removes it from state and from the receiver's
  // list, so the next check-in with it is refused.
  //
  // GET    /api/checkin-keys     — list { id, label, createdAt, lastUsedAt }
  // POST   /api/checkin-keys     — create { label } -> 201 { key, plain }
  // DELETE /api/checkin-keys/:id — revoke
  if (req.method === 'GET' && pathname === '/api/checkin-keys') {
    mergeExternalCheckin(state, now);
    return sendJson(res, 200, (state.checkinKeys || []).map(publicCheckinKey));
  }
  if (req.method === 'POST' && pathname === '/api/checkin-keys') {
    const body = await readBody(req).catch(() => ({}));
    const label = asStr(typeof body.label === 'string' ? body.label.trim() : '', 80) || 'Untitled key';
    const plain = crypto.randomBytes(32).toString('base64url');
    const key = {
      id: newCheckinKeyId(), label, hash: hashCheckinKey(plain),
      createdAt: now.toISOString(), lastUsedAt: null,
    };
    const fresh = saveMutation((f) => {
      f.checkinKeys = f.checkinKeys || [];
      f.checkinKeys.push(key);
    });
    writeReceiverKeys(fresh);
    // Key creates are logged (id + label only — never the
    // hash or plaintext), so a lost key can be traced to when it
    // was created or revoked.
    console.log('Standby: check-in key created: ' + key.id + ' (' + key.label + ')');
    return sendJson(res, 201, { key: publicCheckinKey(key), plain });
  }
  const keyMatch = pathname.match(/^\/api\/checkin-keys\/([^/]+)$/);
  if (req.method === 'DELETE' && keyMatch) {
    const fresh = saveMutation((f) => {
      const keys = f.checkinKeys || [];
      const idx = keys.findIndex((k) => k.id === keyMatch[1]);
      if (idx === -1) return false;
      keys.splice(idx, 1);
    });
    if (!fresh) return sendError(res, 404, 'no such key');
    writeReceiverKeys(fresh);
    // Key revokes are logged too — same reason as creates.
    console.log('Standby: check-in key revoked: ' + keyMatch[1]);
    return sendJson(res, 200, { ok: true, removed: keyMatch[1] });
  }

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

  // There is no POST /api/pause or /api/resume: Global Arm/Disarm
  // (POST /api/bitcoin/txs/arm-all) is the control. Those paths 404.

  // Transactions — the pre-signed list. Adding one arms it (the toggle
  // disarms it). The hex is validated (structure + txid) before
  // storing. The server never sees keys — only the signed hex. Replacing
  // a tx's hex clears its release record and its broadcasted fact (both
  // belong to the old hex — the new one has never been broadcast); the
  // broadcast log keeps the history. Deleting a tx drops its release
  // record with it.
  //
  // POST   /api/bitcoin/txs      — add { txHex, label, notes, broadcastVia? }
  // PUT    /api/bitcoin/txs/:id  — update { txHex?, label?, notes?, enabled?, broadcastVia? }
  // DELETE /api/bitcoin/txs/:id  — remove
  const txsMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)$/);
  // The already-satisfied gate for a rule set: evaluates
  // the WHOLE set with the combined semantics — an OR set is blocked
  // when any rule is satisfied now, an AND set when all are.
  // Unknown rules never block (satisfaction cannot be proven).
  // Check-in-only sets never reach this gate: a due check-in rule
  // resets the clock instead (the danger-zone reset below), exactly
  // as a single check-in rule does today — so the gate only runs
  // when the set holds a price, UTXO, block-height, set-date, or
  // fee-market rule. `verb` is 'add' | 'import' | 'save' (the
  // handler's word for the action being confirmed). Returns
  // { chk, blocked, message } — chk is the checkTriggerNow answer
  // (its warning rides on the 201 when the set is not already
  // satisfied, so the UI can say what it found).
  async function setGateCheck(trgSet, state, now, verb) {
    const hasGatedRule = trgSet.rules.some((r) => r.type === 'price' || r.type === 'utxo' || r.type === 'blockheight' || r.type === 'setdate' || r.type === 'feemarket');
    if (!hasGatedRule) return { chk: null, blocked: false, message: null };
    const chk = await checkTriggerNow(trgSet, state, now, null);
    if (!chk.fire) return { chk, blocked: false, message: null };
    return { chk, blocked: true, message: alreadySatisfiedMessage(trgSet, verb) };
  }
  function alreadySatisfiedMessage(trgSet, verb) {
    const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
    const tail = cap + ' it with triggerConfirmed to ' + verb + ' it anyway.';
    if (trgSet.rules.length === 1) {
      const r = trgSet.rules[0];
      switch (r.type) {
        case 'utxo': return 'That UTXO is already spent — this rule would fire on the next evaluation. ' + tail;
        case 'price': {
          const dir = r.params.op === '>=' ? 'above' : 'below';
          return 'The price is already ' + dir + ' $' + Number(r.params.value).toLocaleString('en-US') + ' — this rule would fire on the next evaluation. ' + tail;
        }
        case 'blockheight': return 'That block height has already been reached — this rule would fire on the next evaluation. ' + tail;
        case 'setdate': return 'That date has already passed — this rule would fire on the next evaluation. ' + tail;
        case 'feemarket': {
          const fdir = r.params.direction === 'above' ? 'at or above' : 'at or below';
          return 'The economy fee is already ' + fdir + ' ' + Number(r.params.maxFeeRate).toLocaleString('en-US') + ' sat/vB — this rule would fire on the next evaluation. ' + tail;
        }
        default: return 'This rule is already satisfied — it would fire on the next evaluation. ' + tail;
      }
    }
    return 'This rule set is already satisfied — it would fire on the next evaluation. ' + tail;
  }
  // One stored-transaction record, from a parsed tx and its hex —
  // shared by the paste path (POST /api/bitcoin/txs) and the file
  // import path (POST /api/bitcoin/txs/import), so the two cannot
  // drift apart. broadcastVia is the route the transaction goes out
  // on ('public' or 'slipstream') — default 'public'.
  // publicFallbackDays is the opt-in public-fallback
  // duration in days, or null for Never (the default).
  // slipstreamFirstAttemptAt is the ISO timestamp of the
  // first Slipstream broadcast attempt, success or fail — the
  // deadline anchor for a tx whose submit keeps failing. It is set
  // by broadcastOneInner, never by the client, and never overwritten
  // once set.
  // feeSats / feeRateSatVb are the transaction fee in
  // satoshis and the fee rate in sat/vB, computed from the parent
  // txs on the node at add time (and refreshed by a dry-run, and
  // recomputed at startup — see recomputeStoredFees).
  // null when the parents could not be fetched — the fee is
  // display-only, never a gate, so an unknown fee never blocks an
  // add.
  function newTxRecord(parsed, hex, label, notes, broadcastVia, publicFallbackDays, trigger) {
    return {
      id: store.newTxId(),
      txid: parsed.txid,
      hex,
      label: typeof label === 'string' ? asStr(label, 80) : '',
      notes: typeof notes === 'string' ? asStr(notes, 500) : '',
      createdAt: now.toISOString(),
      inputs: parsed.inputs.length,
      outputs: parsed.outputs.length,
      totalOutSats: parsed.totalOutSats,
      feeSats: null,
      feeRateSatVb: null,
      locktime: parsed.locktime,
      segwit: parsed.segwit,
      enabled: true, // new transactions are armed by default
      // The check-in freeze: the accumulated inactive
      // time and the start of the current inactive period (see
      // syncCheckinFreeze). Only check-in logic reads them; a new
      // tx starts active, at 0 / null.
      checkinOffsetMs: 0,
      checkinInactiveSince: null,
      broadcastVia: validBroadcastVia(broadcastVia),
      publicFallbackDays: validPublicFallbackDays(publicFallbackDays),
      slipstreamFirstAttemptAt: null,
      // The rule that fires this transaction — already
      // normalized by the caller (see the add / import handlers).
      // triggerState is the trigger's last evaluation, null until
      // the release has evaluated it once.
      trigger,
      triggerState: null,
      // The event trail: starts with the add itself —
      // the rule that was set, in its own words.
      history: [{ ts: now.toISOString(), type: 'added', detail: triggerConditionText(trigger) }],
      release: null,
      // broadcasted is set by broadcastOne() (release or manual) and
      // survives check-ins: { txid, broadcastedAt, method,
      // confirmations, blockHeight, found, checkedAt }.
      broadcasted: null,
    };
  }
  // The fee for a parsed tx, best-effort: null when the
  // node cannot answer (unknown parent, unreachable node). Never
  // throws — an add must never fail because the fee could not be
  // computed.
  async function feeFor(parsed) {
    try { return await bitcoin.computeFee(parsed, bitcoin.endpointsFor(state.settings)); }
    catch { return null; }
  }
  // A transaction is identified by its txid: the same on-chain
  // transaction stored twice is two cards, both armed, for one
  // Bitcoin tx (the second broadcast is a no-op). Reject a txid
  // that is already stored, naming the existing card by its label
  // (or its id when it has no label). `exceptId` is the tx being
  // edited — its own txid is not a duplicate.
  function duplicateTx(txid, exceptId) {
    const dup = (state.bitcoin.txs || []).find((t) => t.txid === txid && t.id !== exceptId);
    return dup ? "This transaction is already stored as '" + (dup.label || dup.id) + "'" : null;
  }
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs') {
    const body = await readBody(req);
    if (typeof body.txHex !== 'string' || !body.txHex.trim()) return sendError(res, 400, 'empty transaction hex');
    const input = body.txHex.trim();
    let hex;
    if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
      // Clean hex — the original paste path.
      hex = input;
    } else {
      // Maybe a pasted PSBT (base64). extractTxFromPsbt detects the
      // format by content. A PSBT that parses but is not fully
      // signed reports its own error (naming the inputs); anything
      // that is not a PSBT at all is an invalid paste, like a
      // corrupt hex.
      try { hex = bitcoin.extractTxFromPsbt(input).hex; }
      catch (e) {
        if (e.message.indexOf('not fully signed') !== -1) return sendError(res, 400, e.message);
        return sendError(res, 400, 'invalid transaction: ' + e.message);
      }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    // The trigger: validated server-side (an invalid one
    // is a 400 with the reason). Omitted → the check-in trigger at
    // the 35-day fallback, so the old add path is unchanged.
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays, trig.trigger);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    // The already-satisfied check for a
    // price, UTXO, block-height, set-date, or fee-market rule: a
    // condition that is ALREADY met would fire on the next
    // evaluation, so adding it is a mistake unless the owner
    // confirms it (triggerConfirmed: true). What "met" means
    // depends on the rule: for a price rule both sources must
    // agree the price is past the threshold — a single-source or
    // disagreeing reading is not a fire (checkTriggerNow answers
    // fire: false), so it never blocks the add; for a UTXO rule
    // it depends on the confirmation mode: any spend in
    // unconfirmed mode (0), or a spend with at least N
    // confirmations in N-confirmation mode. For a block-height
    // rule the tip is already at or past the height; for a
    // set-date rule the date has already passed; for a fee-market
    // rule the economy fee is already at or below the threshold.
    // The check is best-effort — a reading no source can say
    // about (unknown) does not block the add; the tick will
    // evaluate it. A UTXO spend that is unconfirmed, or confirmed
    // but below N, is a warning at most, not a block. The warning
    // still rides on the response when the condition is NOT
    // already satisfied, so the UI can say what it found.
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'add');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the add proceeds without the warning */ }
    // A new tx is armed by default — adding
    // a CHECK-IN rule while the clock is in the danger zone (the
    // last 25% of ITS window, including already past due) would
    // let the release fire soon after, so the add resets the
    // check-in the same way arming does (server-side, a direct API
    // call cannot bypass it). A price, UTXO, or manual rule does
    // not touch the check-in clock. The zone is measured against
    // the new rule's own threshold, not the global one. Adding
    // with more than 25% of the window left does not reset.
    // The push + the reset ride into
    // FRESH state: the fee and trigger checks above awaited the
    // network, so a second request may have saved in between. The
    // duplicate-txid check is re-run on fresh state too — a
    // concurrent add of the same txid would otherwise slip past
    // the stale-side check.
    let checkinReset = false;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const dup = txs.find((t) => t.txid === tx.txid);
      if (dup) { dupTx = dup; return false; }
      if (txs.some((t) => t.id === tx.id)) return false;
      txs.push(tx);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (dupTx) return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the transaction — try again');
    }
    const out = { tx: serveTx(tx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }

  // POST /api/bitcoin/txs/preview — finalize a file's contents and
  // return the raw hex WITHOUT storing anything. The UI calls this
  // when a PSBT file is imported, so the extracted hex can be put
  // in the textarea for the user to label and add via the normal
  // paste path. Body { format: 'hex'|'psbt', data }. Hex is
  // validated exactly like the paste path; a PSBT is finalized
  // exactly like the import path (same errors, including the
  // clearer "not a PSBT file" one). No state change.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/preview') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    return sendJson(res, 200, { hex, txid: parsed.txid });
  }

  // POST /api/bitcoin/txs/import — add a signed transaction from a
  // FILE instead of a paste. Body { format: 'hex'|'psbt', data,
  // label?, notes? }. A hex file is a text file holding the raw
  // transaction hex; it is validated exactly like the paste path
  // (same errors). A PSBT file (.psbt, base64 or raw binary) is
  // finalized server-side — the PSBT must be fully signed, or it is
  // rejected with a clear error naming the inputs that are missing
  // signatures; a partially signed PSBT is never stored. The
  // extracted raw hex is validated by parseTx exactly like a paste
  // before it is stored. The body is capped at 1 MB (MAX_BODY), and
  // the PSBT parser caps the decoded PSBT at 1 MB too.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/import') {
    const body = await readBody(req);
    if (body.format !== 'hex' && body.format !== 'psbt') return sendError(res, 400, 'import format must be hex or psbt');
    if (typeof body.data !== 'string' || !body.data.trim()) return sendError(res, 400, 'empty import data');
    let hex;
    if (body.format === 'hex') {
      try { bitcoin.parseTx(body.data.trim()); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      hex = body.data.trim();
    } else {
      try { hex = bitcoin.extractTxFromPsbt(body.data).hex; }
      catch (e) { return sendError(res, 400, e.message); }
    }
    let parsed;
    try { parsed = bitcoin.parseTx(hex); }
    catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
    const dupErr = duplicateTx(parsed.txid);
    if (dupErr) return sendError(res, 400, dupErr);
    // The trigger — same validation and already-spent gate
    // as the paste path (see POST /api/bitcoin/txs above).
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const tx = newTxRecord(parsed, hex, body.label, body.notes, body.broadcastVia, body.publicFallbackDays, trig.trigger);
    const fee = await feeFor(parsed);
    if (fee) { tx.feeSats = fee.feeSats; tx.feeRateSatVb = fee.feeRateSatVb; }
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'import');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the import proceeds without the warning */ }
    // The import path arms by default too —
    // same reset as the paste path when the clock is in the danger
    // zone, and only for a check-in rule.
    // The push + the reset ride into FRESH state (see the paste
    // path above): the fee and trigger checks awaited the network.
    let checkinReset = false;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const dup = txs.find((t) => t.txid === tx.txid);
      if (dup) { dupTx = dup; return false; }
      if (txs.some((t) => t.id === tx.id)) return false;
      txs.push(tx);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (dupTx) return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the transaction — try again');
    }
    const out = { tx: serveTx(tx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }
  if (txsMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txsMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    // Snapshot for the fresh-state merge
    // below: only the fields this edit changes are copied into
    // fresh state at save time. (Shallow: the handler replaces
    // trigger/release/broadcasted, never mutates them in place.)
    const orig = { ...tx };
    if (req.method === 'DELETE') {
      // The removal rides into FRESH
      // state: the request body was awaited above, so a second
      // request may have saved in between.
      const fresh = saveMutation((f) => {
        if (!(f.bitcoin.txs || []).some((t) => t.id === tx.id)) return false;
        f.bitcoin.txs = (f.bitcoin.txs || []).filter((t) => t.id !== tx.id);
        // The tx leaves any set it was in; a set left with
        // no members has nothing to drive and goes with it. The
        // other members stay put.
        for (const s of (f.bitcoin.sets || [])) {
          s.txIds = (s.txIds || []).filter((id) => id !== tx.id);
        }
        f.bitcoin.sets = (f.bitcoin.sets || []).filter((s) => (s.txIds || []).length > 0);
      });
      if (!fresh) return sendError(res, 404, 'no such transaction');
      return sendJson(res, 200, { ok: true, removed: tx.id });
    }
    const body = await readBody(req);
    if (typeof body.txHex === 'string') {
      const hex = body.txHex.trim();
      if (!hex) return sendError(res, 400, 'empty transaction hex');
      let parsed;
      try { parsed = bitcoin.parseTx(hex); }
      catch (e) { return sendError(res, 400, 'invalid transaction: ' + e.message); }
      // The hex is immutable once the transaction is out the door:
      // a broadcasted tx, one submitted to
      // Slipstream and waiting on MARA, a stale tx, or a
      // restore-carried 'broadcast' record — all Pending or Archived
      // — cannot be replaced with a DIFFERENT transaction, because
      // that would be a different on-chain tx. Sending the same hex
      // back (unchanged, same txid) is a no-op, not a change, so it
      // is allowed and changes nothing. A 'failed' or 'conflict'
      // record is Active, not locked: its hex can still change.
      const locked = !!(tx.broadcasted || (tx.release
        && (tx.release.status === 'submitted-slipstream' || tx.release.status === 'stale' || tx.release.status === 'broadcast')));
      if (locked && parsed.txid !== tx.txid) {
        return sendError(res, 400, 'the transaction hex cannot be changed once it has been broadcast');
      }
      if (parsed.txid !== tx.txid) {
        // A replacement hex that is another stored transaction's txid
        // is a duplicate; the tx's own hex (unchanged) is fine.
        const dupErr = duplicateTx(parsed.txid, tx.id);
        if (dupErr) return sendError(res, 400, dupErr);
        tx.hex = hex;
        tx.txid = parsed.txid;
        tx.inputs = parsed.inputs.length;
        tx.outputs = parsed.outputs.length;
        tx.totalOutSats = parsed.totalOutSats;
        // A replaced hex is a different transaction: its fee is
        // recomputed from the new inputs (best-effort, null when
        // the parents cannot be fetched).
        const fee = await feeFor(parsed);
        tx.feeSats = fee ? fee.feeSats : null;
        tx.feeRateSatVb = fee ? fee.feeRateSatVb : null;
        tx.locktime = parsed.locktime;
        tx.segwit = parsed.segwit;
        // A replaced hex is a different transaction: the broadcasted fact
        // and any release record belong to the old hex, so both are
        // cleared. The broadcast log keeps the history. (Only reachable
        // for an unlocked tx — a locked tx with a different txid is
        // rejected above, and a locked tx with the same txid takes the
        // no-op path, so its broadcasted fact is never cleared here.)
        tx.release = null;
        tx.broadcasted = null;
      }
    }
    if (typeof body.label === 'string') tx.label = asStr(body.label, 80);
    if (typeof body.notes === 'string') tx.notes = asStr(body.notes, 500);
    // The trigger: changing it re-rules the transaction.
    // Validated server-side (an invalid one is a 400). A changed
    // trigger starts fresh — the old triggerState (a price's
    // last price, a UTXO's last outspend) belongs to the old
    // condition and must not carry over. The already-satisfied
    // gate (price or UTXO) applies here too (same rule as the add
    // path). Nothing is saved until the end of this handler, so a
    // 400 here discards the label / notes / hex changes above
    // with it.
    let triggerWarning = null;
    if (body.trigger !== undefined) {
      const v = store.normalizeTrigger(body.trigger);
      if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
      // The trigger is locked with the hex and route: a transaction
      // out the door (broadcasted, submitted to Slipstream, stale)
      // has already fired its rule, and re-ruling it now would
      // only rewrite history — the Edit popup disables the picker
      // for a locked tx, and this is the server-side backstop.
      const triggerLocked = !!(tx.broadcasted || (tx.release
        && (tx.release.status === 'submitted-slipstream' || tx.release.status === 'stale' || tx.release.status === 'broadcast')));
      if (triggerLocked && JSON.stringify(v.trigger) !== JSON.stringify(store.triggerOf(tx))) {
        return sendError(res, 400, 'the trigger cannot be changed once the transaction has been broadcast');
      }
      try {
        const gate = await setGateCheck(v.trigger, state, now, 'save');
        if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
        if (gate.blocked && body.triggerConfirmed !== true) {
          return sendError(res, 400, gate.message);
        }
      } catch (e) { /* best-effort: the save proceeds without the warning */ }
      if (JSON.stringify(v.trigger) !== JSON.stringify(tx.trigger)) {
        tx.trigger = v.trigger;
        tx.triggerState = null;
      }
    }
    // Arming a CHECK-IN transaction while
    // the clock is in the danger zone (the last 25% of ITS window,
    // including already past due) would let the release fire soon
    // after — a present owner arming a tx should not get a surprise
    // broadcast. A disarmed→armed transition on a live tx (not
    // already broadcasted, not stale — one the release could
    // actually broadcast) resets the check-in instead, server-side
    // so a direct API call cannot bypass it. Arming a price, UTXO,
    // or manual rule does not touch the clock. Disarming, arming
    // outside the zone, and arming a broadcasted / stale tx leave
    // the clock untouched. The zone is measured against the tx's
    // own threshold (after a trigger change above, the new one).
    if (typeof body.enabled === 'boolean') tx.enabled = body.enabled;
    // The route toggle on the card: switching the route
    // applies to the NEXT broadcast attempt — a transaction already
    // submitted to Slipstream is not re-submitted by toggling it
    // (preBroadcastCheck blocks a re-submit while it waits on MARA).
    if (typeof body.broadcastVia === 'string') tx.broadcastVia = validBroadcastVia(body.broadcastVia);
    // The public-fallback duration: changeable on the card
    // and in the edit popup, for Active and Pending txs. It is
    // validated leniently (invalid → Never, never a 400), like the
    // route above. A change while the tx waits on MARA re-times the
    // deadline from the original submittedAt — the deadline is
    // computed from submittedAt at evaluation time (see
    // fallbackDeadline), so no clock is restarted here.
    if (body.publicFallbackDays !== undefined) tx.publicFallbackDays = validPublicFallbackDays(body.publicFallbackDays);
    // The history events for this edit: an arm/disarm
    // flip logs on its own; any other field change logs as one
    // 'edited' event naming what changed. The events are appended
    // to tx.history here and ride into fresh state through the
    // mutator's field list below ('history' is in it), so a
    // rejected edit (a 400 above) leaves no event behind.
    // Single history: a member's 'edited' is
    // forwarded to its set's trail inside the save below, on
    // fresh state — the arm/disarm flip is NOT forwarded, the
    // set logs its own arm.
    const forwardedEditEvents = [];
    if (typeof body.enabled === 'boolean' && orig.enabled !== tx.enabled) {
      pushHistory(tx, tx.enabled ? 'armed' : 'disarmed', '');
    }
    const editChanges = [];
    if (orig.label !== tx.label) editChanges.push('Label changed');
    if (JSON.stringify(orig.trigger) !== JSON.stringify(tx.trigger)) editChanges.push('Trigger changed to ' + triggerConditionText(tx.trigger));
    if (orig.hex !== tx.hex) editChanges.push('Transaction replaced');
    if (orig.broadcastVia !== tx.broadcastVia) editChanges.push('Route changed to ' + (tx.broadcastVia === 'slipstream' ? 'Slipstream' : 'Public'));
    if (orig.publicFallbackDays !== tx.publicFallbackDays) editChanges.push('Public fallback changed to ' + (tx.publicFallbackDays === null ? 'Never' : tx.publicFallbackDays + (tx.publicFallbackDays === 1 ? ' day' : ' days')));
    if (orig.notes !== tx.notes) editChanges.push('Notes changed');
    if (editChanges.length) {
      pushHistory(tx, 'edited', editChanges.join('; '));
      forwardedEditEvents.push({ type: 'edited', detail: editChanges.join('; ') });
    }
    let checkinReset = false;
    // The edit's field changes were
    // computed on the request's snapshot while the fee and trigger
    // checks awaited the network — only the fields this edit
    // actually changed ride into FRESH state, so a concurrent save
    // is not clobbered. The locks are re-checked on the fresh tx:
    // a tx broadcast in the meantime must not have its hex or
    // trigger rewritten. The freeze and the danger-zone reset are
    // re-evaluated on fresh state too.
    let editError = null;
    let dupTx = null;
    const fresh = saveMutation((f) => {
      const ftx = (f.bitcoin.txs || []).find((t) => t.id === tx.id);
      if (!ftx) { editError = 'gone'; return false; }
      const freshLocked = !!(ftx.broadcasted || (ftx.release
        && (ftx.release.status === 'submitted-slipstream' || ftx.release.status === 'stale' || ftx.release.status === 'broadcast')));
      if (orig.hex !== tx.hex && freshLocked && tx.txid !== ftx.txid) { editError = 'locked-hex'; return false; }
      if (JSON.stringify(orig.trigger) !== JSON.stringify(tx.trigger) && freshLocked
          && JSON.stringify(tx.trigger) !== JSON.stringify(store.triggerOf(ftx))) { editError = 'locked-trigger'; return false; }
      if (orig.txid !== tx.txid) {
        const dup = (f.bitcoin.txs || []).find((t) => t.id !== tx.id && t.txid === tx.txid);
        if (dup) { dupTx = dup; editError = 'duplicate'; return false; }
      }
      const freshWasEnabled = ftx.enabled;
      for (const k of ['hex', 'txid', 'inputs', 'outputs', 'totalOutSats', 'locktime', 'segwit', 'feeSats', 'feeRateSatVb', 'release', 'broadcasted', 'label', 'notes', 'trigger', 'triggerState', 'enabled', 'broadcastVia', 'publicFallbackDays', 'history']) {
        if (JSON.stringify(tx[k]) !== JSON.stringify(orig[k])) ftx[k] = tx[k];
      }
      // Single history: the member's edit lands
      // on its set's trail too (forwardMemberHistory no-ops for a
      // standalone tx). This runs only on the success path — the
      // early returns above leave a rejected edit with no event
      // anywhere.
      for (const fe of forwardedEditEvents) forwardMemberHistory(f, ftx, fe.type, fe.detail);
      // The freeze: the danger zone is measured from the
      // EFFECTIVE last check-in — the tx's live frozen time — so a
      // frozen clock is never in the danger zone for time that never
      // counted. The freeze is re-synced after the toggle: disarming
      // starts an inactive period, re-arming banks it.
      syncCheckinFreeze(ftx, f, now);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const ftxCheckinThresholds = store.triggerOf(ftx).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (body.enabled === true && freshWasEnabled === false
          && ftxCheckinThresholds.length > 0
          && inDangerZone(f, now, Math.min(...ftxCheckinThresholds), checkinLiveOffsetMs(ftx, now))
          && !ftx.broadcasted && !(ftx.release && ftx.release.status === 'stale')) {
        resetCheckin(f, now, 'arm-reset');
        checkinReset = true;
      }
    });
    if (!fresh) {
      if (editError === 'gone') return sendError(res, 404, 'no such transaction');
      if (editError === 'locked-hex') return sendError(res, 400, 'the transaction hex cannot be changed once it has been broadcast');
      if (editError === 'locked-trigger') return sendError(res, 400, 'the trigger cannot be changed once the transaction has been broadcast');
      if (editError === 'duplicate') return sendError(res, 400, "This transaction is already stored as '" + (dupTx.label || dupTx.id) + "'");
      return sendError(res, 400, 'could not save the edit — try again');
    }
    const outTx = (fresh.bitcoin.txs || []).find((t) => t.id === tx.id);
    const out = { tx: serveTx(outTx) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 200, out);
  }

  // Trigger sets. A set is one label, one arm/disarm,
  // and one rule set driving several transactions:
  //   POST   /api/bitcoin/sets      — create { label, txIds, trigger, enabled?, triggerConfirmed? }
  //   PUT    /api/bitcoin/sets/:id  — update { label?, txIds?, trigger?, enabled?, triggerConfirmed? }
  //   DELETE /api/bitcoin/sets/:id  — remove (its txs return to standalone; they are never deleted with it)
  //   POST   /api/bitcoin/sets/:id/broadcast — MANUAL broadcast of every member, now
  // A member keeps its own trigger stored (it resumes when the tx
  // leaves the set); while attached, only the set's trigger is
  // evaluated. The already-satisfied gate, the danger-zone
  // check-in reset, and the freeze sync all mirror the tx paths.
  function setAttachErrors(freshState, txIds, exceptSetId) {
    const errs = [];
    const seen = new Set();
    for (const id of txIds) {
      if (typeof id !== 'string' || !id) { errs.push('set members must be transaction ids'); continue; }
      if (seen.has(id)) { errs.push('transaction attached twice: ' + id); continue; }
      seen.add(id);
      const t = (freshState.bitcoin.txs || []).find((x) => x.id === id);
      if (!t) { errs.push('unknown transaction id: ' + id); continue; }
      const other = (freshState.bitcoin.sets || []).find((s) => s.id !== exceptSetId && (s.txIds || []).includes(id));
      if (other) { errs.push("'" + (t.label || t.id) + "' is already in '" + (other.label || other.id) + "'"); continue; }
      if (t.broadcasted || (t.release && (t.release.status === 'broadcast' || t.release.status === 'stale' || t.release.status === 'submitted-slipstream'))) {
        errs.push("'" + (t.label || t.id) + "' is already broadcast, stale, or waiting on MARA and cannot join a set");
      }
    }
    return errs;
  }
  function newSetRecord(label, txIds, trigger) {
    return {
      id: store.newSetId(),
      label: typeof label === 'string' ? asStr(label, 80) : '',
      enabled: true,
      txIds: [...new Set(txIds)],
      trigger,
      triggerState: null,
      history: [{ ts: now.toISOString(), type: 'added', detail: 'Set created with ' + txIds.length + (txIds.length === 1 ? ' transaction' : ' transactions') }],
      createdAt: now.toISOString(),
      checkinOffsetMs: 0,
      checkinInactiveSince: null,
    };
  }
  if (req.method === 'POST' && pathname === '/api/bitcoin/sets') {
    const body = await readBody(req);
    if (!Array.isArray(body.txIds) || !body.txIds.length) return sendError(res, 400, 'a set needs at least one transaction');
    const errs = setAttachErrors(state, body.txIds, null);
    if (errs.length) return sendError(res, 400, errs[0]);
    const trig = (body.trigger === undefined)
      ? { trigger: store.defaultTriggerSet() }
      : store.normalizeTrigger(body.trigger);
    if (!trig.trigger) return sendError(res, 400, 'invalid trigger: ' + trig.error);
    const set = newSetRecord(body.label, body.txIds, trig.trigger);
    if (body.enabled === false) set.enabled = false;
    let triggerWarning = null;
    try {
      const gate = await setGateCheck(trig.trigger, state, now, 'add');
      if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
      if (gate.blocked && body.triggerConfirmed !== true) {
        return sendError(res, 400, gate.message);
      }
    } catch (e) { /* best-effort: the create proceeds without the warning */ }
    let checkinReset = false;
    let saveErrs = null;
    const fresh = saveMutation((f) => {
      saveErrs = setAttachErrors(f, body.txIds, null);
      if (saveErrs.length) return false;
      if ((f.bitcoin.sets || []).some((s) => s.id === set.id)) return false;
      // Single history: the set's trail opens
      // with each member's existing history (tagged, oldest
      // first); the creation event closes it, so the trail never
      // starts from scratch.
      const memberTxs = body.txIds.map((id) => (f.bitcoin.txs || []).find((t) => t.id === id)).filter(Boolean);
      set.history = [];
      store.backfillSetHistory(set, memberTxs);
      pushHistory(set, 'added', 'Set created with ' + body.txIds.length + (body.txIds.length === 1 ? ' transaction' : ' transactions'), now.toISOString());
      (f.bitcoin.sets = f.bitcoin.sets || []).push(set);
      // The danger zone is measured against the SMALLEST check-in
      // threshold in the set — the most urgent check-in rule is
      // the one that would let the release fire soonest.
      const checkinThresholds = trig.trigger.rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (checkinThresholds.length > 0 && inDangerZone(f, now, Math.min(...checkinThresholds))) {
        resetCheckin(f, now, 'add-reset');
        checkinReset = true;
      }
    });
    if (!fresh) return sendError(res, 400, (saveErrs && saveErrs[0]) || 'could not save the set — try again');
    const out = { set: serveSet((fresh.bitcoin.sets || []).find((s) => s.id === set.id) || set) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 201, out);
  }
  const setMatch = pathname.match(/^\/api\/bitcoin\/sets\/([^/]+)$/);
  if (setMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const set = (state.bitcoin.sets || []).find((s) => s.id === setMatch[1]);
    if (!set) return sendError(res, 404, 'no such trigger set');
    if (req.method === 'DELETE') {
      // Deleting a set never deletes its transactions — they
      // return to standalone, each with its own trigger again.
      const fresh = saveMutation((f) => {
        if (!(f.bitcoin.sets || []).some((s) => s.id === set.id)) return false;
        f.bitcoin.sets = (f.bitcoin.sets || []).filter((s) => s.id !== set.id);
      });
      if (!fresh) return sendError(res, 404, 'no such trigger set');
      return sendJson(res, 200, { ok: true, removed: set.id });
    }
    const body = await readBody(req);
    const orig = { ...set, txIds: [...(set.txIds || [])], trigger: set.trigger, history: set.history };
    if (typeof body.label === 'string') set.label = asStr(body.label, 80);
    if (body.txIds !== undefined) {
      if (!Array.isArray(body.txIds)) return sendError(res, 400, 'txIds must be a list of transaction ids');
      // Only the NEWLY attached ids are validated against the
      // settled / other-set rules — a member already in this set
      // stays put even if it has since broadcast.
      const freshIds = body.txIds.filter((id) => !orig.txIds.includes(id));
      const errs = setAttachErrors(state, freshIds, set.id);
      if (errs.length) return sendError(res, 400, errs[0]);
      set.txIds = [...new Set(body.txIds)];
      // Single history: a newly attached member
      // brings its existing history into the set's trail (tagged,
      // oldest first) — the 'Members changed' event below closes
      // the attach, so it stays the newest entry.
      const addedTxs = freshIds.map((id) => (state.bitcoin.txs || []).find((t) => t.id === id)).filter(Boolean);
      if (addedTxs.length) store.backfillSetHistory(set, addedTxs);
    }
    let triggerWarning = null;
    if (body.trigger !== undefined) {
      const v = store.normalizeTrigger(body.trigger);
      if (!v.trigger) return sendError(res, 400, 'invalid trigger: ' + v.error);
      try {
        const gate = await setGateCheck(v.trigger, state, now, 'save');
        if (gate.chk && gate.chk.warning) triggerWarning = gate.chk.warning;
        if (gate.blocked && body.triggerConfirmed !== true) {
          return sendError(res, 400, gate.message);
        }
      } catch (e) { /* best-effort: the save proceeds without the warning */ }
      if (JSON.stringify(v.trigger) !== JSON.stringify(set.trigger)) {
        set.trigger = v.trigger;
        set.triggerState = null;
      }
    }
    if (typeof body.enabled === 'boolean') set.enabled = body.enabled;
    if (typeof body.enabled === 'boolean' && orig.enabled !== set.enabled) {
      pushHistory(set, set.enabled ? 'armed' : 'disarmed', '');
    }
    const setChanges = [];
    if (orig.label !== set.label) setChanges.push('Label changed');
    if (JSON.stringify(orig.trigger) !== JSON.stringify(set.trigger)) setChanges.push('Trigger changed to ' + triggerConditionText(set.trigger));
    if (JSON.stringify(orig.txIds) !== JSON.stringify(set.txIds)) {
      const added = (set.txIds || []).filter((id) => !orig.txIds.includes(id)).length;
      const removed = orig.txIds.filter((id) => !(set.txIds || []).includes(id)).length;
      setChanges.push('Members changed' + (added ? ' (+' + added + ')' : '') + (removed ? ' (-' + removed + ')' : ''));
    }
    if (setChanges.length) pushHistory(set, 'edited', setChanges.join('; '));
    let checkinReset = false;
    const fresh = saveMutation((f) => {
      const fset = (f.bitcoin.sets || []).find((s) => s.id === set.id);
      if (!fset) return false;
      const freshWasEnabled = fset.enabled;
      for (const k of ['label', 'txIds', 'trigger', 'triggerState', 'enabled', 'history']) {
        if (JSON.stringify(set[k]) !== JSON.stringify(orig[k])) fset[k] = set[k];
      }
      syncCheckinFreeze(fset, f, now);
      const fsetCheckinThresholds = store.triggerOf(fset).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
      if (body.enabled === true && freshWasEnabled === false
          && fsetCheckinThresholds.length > 0
          && inDangerZone(f, now, Math.min(...fsetCheckinThresholds), checkinLiveOffsetMs(fset, now))) {
        resetCheckin(f, now, 'arm-reset');
        checkinReset = true;
      }
    });
    if (!fresh) return sendError(res, 400, 'could not save the set — try again');
    const outSet = (fresh.bitcoin.sets || []).find((s) => s.id === set.id);
    const out = { set: serveSet(outSet) };
    if (checkinReset) out.checkinReset = true;
    if (triggerWarning) out.triggerWarning = triggerWarning;
    return sendJson(res, 200, out);
  }

  // POST /api/bitcoin/sets/:id/broadcast — MANUAL broadcast of
  // every member, now. Same path as the release (freshness gate,
  // then the route), on the owner's explicit say-so: it ignores
  // the set's arm state, like a manual tx broadcast ignores its
  // own toggle. A stale member yields a 'stale' result and the
  // loop carries on to the next member — it does not archive
  // the set.
  const setBroadcastMatch = pathname.match(/^\/api\/bitcoin\/sets\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && setBroadcastMatch) {
    const set = (state.bitcoin.sets || []).find((s) => s.id === setBroadcastMatch[1]);
    if (!set) return sendError(res, 404, 'no such trigger set');
    const members = setMembers(state, set);
    if (!members.length) return sendError(res, 400, 'the set has no transactions to broadcast');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of members) {
      if (tx.broadcasted) {
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast' });
        continue;
      }
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast', { setId: set.id }));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }

  // POST /api/bitcoin/txs/arm-all — Global Arm/Disarm:
  // set `enabled` on EVERY staged transaction at once. Body
  // { enabled: true|false }. Applies to all triggers — check-in,
  // price, UTXO, manual. "Arm all" arms EVERYTHING, including
  // transactions individually disarmed before — the owner
  // re-disarms those after if needed. Each check-in tx's freeze
  // is re-synced, so disarming freezes its countdown at the day
  // count it was left at and re-arming resumes from there.
  // Arming a check-in tx in its danger zone resets the check-in
  // (the same guard as arming one tx), once, and the
  // response names it. Manual broadcasts still work while a tx
  // is disarmed — they never went through the armed toggle.
  if (req.method === 'POST' && pathname === '/api/bitcoin/txs/arm-all') {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'enabled must be true or false');
    // The toggle + freeze sync + reset
    // ride into FRESH state: the request body was awaited above.
    let checkinReset = false;
    const fresh = saveMutation((f) => {
      const txs = f.bitcoin.txs || [];
      const newlyArmed = [];
      for (const t of txs) {
        const wasEnabled = t.enabled;
        t.enabled = body.enabled;
        // An arm/disarm flip logs on the tx it flipped —
        // a no-op toggle (already in that state) logs nothing.
        if (wasEnabled !== body.enabled) pushHistory(t, body.enabled ? 'armed' : 'disarmed', '');
        syncCheckinFreeze(t, f, now);
        if (body.enabled === true && wasEnabled === false) newlyArmed.push(t);
      }
      for (const t of newlyArmed) {
        const checkinThresholds = store.triggerOf(t).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
        if (checkinThresholds.length === 0) continue;
        if (t.broadcasted || (t.release && t.release.status === 'stale')) continue;
        if (inDangerZone(f, now, Math.min(...checkinThresholds), checkinLiveOffsetMs(t, now))) {
          resetCheckin(f, now, 'arm-all-reset');
          checkinReset = true;
          break;
        }
      }
      // Arm/disarm every set too — a set's arm is the
      // only arm its members have, so leaving sets out would
      // leave half the release armed after "Disarm all".
      const newlyArmedSets = [];
      for (const s of (f.bitcoin.sets || [])) {
        const wasEnabled = s.enabled;
        s.enabled = body.enabled;
        if (wasEnabled !== body.enabled) pushHistory(s, body.enabled ? 'armed' : 'disarmed', '');
        syncCheckinFreeze(s, f, now);
        if (body.enabled === true && wasEnabled === false) newlyArmedSets.push(s);
      }
      for (const s of newlyArmedSets) {
        const checkinThresholds = store.triggerOf(s).rules.filter((r) => r.type === 'checkin').map((r) => r.params.thresholdDays);
        if (checkinThresholds.length === 0) continue;
        const members = (f.bitcoin.txs || []).filter((t) => (s.txIds || []).includes(t.id));
        if (members.length && members.every((t) => t.broadcasted || (t.release && t.release.status === 'stale'))) continue;
        if (inDangerZone(f, now, Math.min(...checkinThresholds), checkinLiveOffsetMs(s, now))) {
          resetCheckin(f, now, 'arm-all-reset');
          checkinReset = true;
          break;
        }
      }
    });
    const freshTxs = fresh.bitcoin.txs || [];
    return sendJson(res, 200, { ok: true, enabled: body.enabled, count: freshTxs.length, checkinReset, txs: serveTxs(freshTxs), sets: serveSets(fresh.bitcoin.sets || []) });
  }

  // POST /api/bitcoin/txs/:id/broadcast — MANUAL broadcast, now. Same
  // path as the release (freshness gate, then primary with secondary
  // fallback) but on the owner's explicit say-so: it ignores the
  // check-in clock, the armed toggle, and vacation mode. The UI
  // asks first (a confirmation dialog). A tx already broadcast is
  // skipped, never re-sent.
  const txBroadcastMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast$/);
  if (req.method === 'POST' && txBroadcastMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (tx.broadcasted) {
      return sendJson(res, 200, { ok: true, id: tx.id, txid: tx.txid, label: tx.label || '', action: 'skipped', reason: 'already broadcast', tx: serveTx(tx) });
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast');
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/bitcoin/txs/:id/broadcast-public — the MANUAL escape
  // hatch for a slow MARA tx. A transaction
  // submitted to Slipstream and waiting on MARA is private until
  // MARA mines it; if the owner does not want to wait, this
  // broadcasts it via the PUBLIC route instead (mempool.space, then
  // blockstream.info), right now, on the owner's explicit say-so.
  // It applies ONLY to a Slipstream-pending tx (release status
  // 'submitted-slipstream') — a public-pending tx is already public,
  // and an active tx uses the route toggle. On success the
  // broadcasted fact is set, the stored route becomes 'public', and
  // the tx is public-pending (confirmed -> Archived, as usual). On
  // failure the error is surfaced and the tx STAYS Slipstream-pending
  // (no 'failed' record is written — MARA is still holding it).
  // MANUAL ONLY: it is not reachable from the release evaluation or
  // Broadcast Armed — only this endpoint calls broadcastOne with
  // forcePublic, and only for the one tx named here.
  const txBroadcastPublicMatch = pathname.match(/^\/api\/bitcoin\/txs\/([^/]+)\/broadcast-public$/);
  if (req.method === 'POST' && txBroadcastPublicMatch) {
    const tx = (state.bitcoin.txs || []).find((t) => t.id === txBroadcastPublicMatch[1]);
    if (!tx) return sendError(res, 404, 'no such transaction');
    if (!(tx.release && tx.release.status === 'submitted-slipstream')) {
      return sendError(res, 400, 'only a transaction waiting on MARA (Slipstream-pending) can be broadcast publicly');
    }
    const r = await broadcastOne(state, tx, bitcoin.endpointsFor(state.settings), now, 'broadcast', { forcePublic: true });
    state = store.loadState(DATA_DIR);
    const fresh = (state.bitcoin.txs || []).find((t) => t.id === tx.id);
    return sendJson(res, 200, { ok: true, ...r, tx: serveTx(fresh) });
  }

  // POST /api/broadcast/all — MANUAL broadcast of the transactions
  // that are NOT in the Archived Transactions card (broadcasted, or
  // already declared stale) — those are never attempted or counted.
  // The UI sends their ids (it knows the archived set). Without ids
  // (an older client or a direct API call) the same rule applies from
  // what the server can see: the broadcasted ones, and the ones
  // already declared stale — by a release, a manual broadcast, or a
  // dry-run, whose stale verdict is now recorded on the transaction.
  // Each is broadcast through the same path (freshness gate, then primary
  // with secondary fallback); a stale or failed tx does not stop the
  // others. The UI asks first (a confirmation dialog).
  // Body { armedOnly: true } sends only the armed
  // (enabled) transactions — a disarmed id in the list is skipped,
  // not sent. The broadcast guards are the same either way.
  if (req.method === 'POST' && pathname === '/api/broadcast/all') {
    const body = await readBody(req).catch(() => ({}));
    const armedOnly = !!(body && body.armedOnly);
    const txs = state.bitcoin.txs || [];
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    let targets;
    if (Array.isArray(body.ids)) {
      targets = [];
      for (const id of body.ids) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) return sendError(res, 400, 'unknown transaction id: ' + id);
        // A transaction already submitted to Slipstream is not
        // re-submitted — it is waiting on MARA, and the
        // MARA-waiting refresh is what moves it on.
        if (!tx.broadcasted && !(tx.release && tx.release.status === 'submitted-slipstream')) targets.push(tx);
      }
    } else {
      targets = txs.filter((t) => !t.broadcasted && !(t.release && t.release.status === 'stale')
        && !(t.release && t.release.status === 'submitted-slipstream'));
    }
    if (armedOnly) targets = targets.filter((t) => t.enabled);
    if (!targets.length) return sendError(res, 400, armedOnly ? 'nothing to broadcast — no armed transactions to broadcast' : 'nothing to broadcast — every transaction is already archived or pending');
    const endpoints = bitcoin.endpointsFor(state.settings);
    const results = [];
    for (const tx of targets) {
      results.push(await broadcastOne(state, tx, endpoints, now, 'broadcast'));
    }
    const action = results.some((r) => r.action === 'broadcast') ? 'broadcast'
      : results.some((r) => r.action === 'failed') ? 'failed'
      : results.some((r) => r.action === 'stale') ? 'stale' : 'skipped';
    return sendJson(res, 200, { ok: true, action, results });
  }

  // GET /api/bitcoin/confirmations — the confirmation count for every
  // broadcast transaction, refreshed from the network unless checked
  // less than a minute ago (the UI polls this; the hourly tick
  // refreshes it too). A failed lookup keeps the last known value.
  if (req.method === 'GET' && pathname === '/api/bitcoin/confirmations') {
    const refreshed = await refreshConfirmations(state, 60);
    return sendJson(res, 200, { confirmations: refreshed });
  }

  // GET /api/backup — the whole setup as one JSON document: settings,
  // every signed transaction (hex included), the check-in clock, and
  // the recent check-in + broadcast history. Restoring it (POST
  // /api/restore) puts the app back exactly where the backup was taken.
  // The file contains the signed hexes, which reveal the destination
  // addresses and amounts — treat it like the transactions themselves.
  // It also carries the check-in key hashes (not the keys — those were
  // never stored), so a restored setup keeps its keys working.
  // GET /api/backup — the plain (unencrypted) backup document.
  // POST /api/backup {password?} — the same document, or,
  // with a password, encrypted with it (lib/backupcrypto.js). The
  // UI uses POST so a password never appears in a URL; GET stays
  // for scripts.
  const buildBackup = () => {
    // The backup carries the SERVED form of each tx (a
    // one-rule set as its single rule) — restore accepts both
    // shapes, and the backup is compared against the served
    // triggers after a restore, so the backup must match what
    // the UI sees.
    const backupState = JSON.parse(JSON.stringify(state));
    backupState.bitcoin.txs = serveTxs(backupState.bitcoin.txs || []);
    backupState.bitcoin.sets = serveSets(backupState.bitcoin.sets || []);
    return {
      format: 'standby-backup',
      version: 1,
      app: 'standby',
      exportedAt: now.toISOString(),
      state: backupState,
      checkins: store.readCheckins(DATA_DIR, 200),
      broadcastLog: store.readBroadcastLog(DATA_DIR, 200),
    };
  };
  if (req.method === 'GET' && pathname === '/api/backup') {
    return sendJson(res, 200, buildBackup());
  }
  if (req.method === 'POST' && pathname === '/api/backup') {
    const body = await readBody(req);
    const password = body && body.password;
    if (password === undefined || password === null || password === '') return sendJson(res, 200, buildBackup());
    const problem = backupcrypto.passwordProblem(password);
    if (problem) return sendError(res, 400, problem);
    return sendJson(res, 200, await backupcrypto.encryptBackup(buildBackup(), password));
  }

  // POST /api/restore — restore a backup document (the parsed JSON from
  // a downloaded backup). Validates before touching anything: the
  // format and version, the settings, and every transaction's hex
  // (each hex is re-parsed and all derived fields are recomputed from
  // it, so a corrupt or hand-edited backup cannot store a bad tx).
  // Replaces the state wholesale; the logs are replaced too when the
  // backup carries them. Returns the restored transaction count.
  if (req.method === 'POST' && pathname === '/api/restore') {
    let body = await readBody(req);
    // An encrypted backup is decrypted first — the UI sends
    // the file's JSON with the password added as `password` — then
    // validated exactly like a plain one.
    if (backupcrypto.isEncryptedBackup(body)) {
      try {
        body = await backupcrypto.decryptBackup(body, body.password);
      } catch (e) {
        if (e instanceof backupcrypto.BackupCryptoError) return sendError(res, 400, e.message);
        throw e;
      }
    }
    if (!body || typeof body !== 'object' || body.format !== 'standby-backup') {
      return sendError(res, 400, 'not a Standby backup file (format must be standby-backup)');
    }
    if (body.version !== 1) return sendError(res, 400, 'unsupported backup version: ' + body.version);
    const bs = body.state;
    if (!bs || typeof bs !== 'object' || !bs.settings || typeof bs.settings !== 'object'
        || !bs.bitcoin || typeof bs.bitcoin !== 'object' || !Array.isArray(bs.bitcoin.txs)) {
      return sendError(res, 400, 'backup is missing the state (settings + transactions)');
    }
    const bsSettings = bs.settings;
    const settings = {
      primaryApiUrl: bitcoin.DEFAULT_PUBLIC_API_URL,
      secondaryApiUrl: '',
      // `paused` is not a setting — a backup carrying it restores
      // WITHOUT it (ignored, not an error). vacationUntil is null
      // for indefinite, a 'YYYY-MM-DD' date otherwise; anything
      // else (including a legacy '') restores as null.
      vacationMode: !!bsSettings.vacationMode,
      vacationUntil: (typeof bsSettings.vacationUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bsSettings.vacationUntil))
        ? bsSettings.vacationUntil : null,
    };
    if (typeof bsSettings.primaryApiUrl === 'string' && bsSettings.primaryApiUrl.trim()) {
      try { settings.primaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.primaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup primary node URL: ' + e.message); }
    }
    if (typeof bsSettings.secondaryApiUrl === 'string' && bsSettings.secondaryApiUrl.trim()) {
      try { settings.secondaryApiUrl = bitcoin.normalizePublicApiUrl(bsSettings.secondaryApiUrl); }
      catch (e) { return sendError(res, 400, 'backup secondary node URL: ' + e.message); }
    }
    // The secondary-enabled toggle rides along: a backup
    // from before 0.8.8 carries none, which restores as enabled
    // (the default); a present but non-boolean value rejects the
    // whole restore, like a bad node URL.
    if (bsSettings.secondaryEnabled !== undefined && bsSettings.secondaryEnabled !== null) {
      if (typeof bsSettings.secondaryEnabled !== 'boolean') return sendError(res, 400, 'backup secondaryEnabled must be true or false');
      settings.secondaryEnabled = bsSettings.secondaryEnabled;
    } else {
      settings.secondaryEnabled = true;
    }
    // The price sources ride along: a backup from before
    // 0.8.0 carries none, which restores as the defaults; a present
    // but invalid pair rejects the whole restore, like a bad node URL.
    if (bsSettings.priceSources !== undefined && bsSettings.priceSources !== null) {
      const ps = bsSettings.priceSources;
      if (!ps || typeof ps !== 'object') return sendError(res, 400, 'backup priceSources must be {source1, source2}');
      const s1 = bitcoin.normalizePriceSourceValue(ps.source1);
      const s2 = bitcoin.normalizePriceSourceValue(ps.source2);
      if (s1 === null) return sendError(res, 400, 'backup ' + priceSourceError(ps.source1));
      if (s2 === null) return sendError(res, 400, 'backup ' + priceSourceError(ps.source2));
      if (bitcoin.priceSourceKey(s1) === bitcoin.priceSourceKey(s2)) return sendError(res, 400, 'backup price sources must be different');
      settings.priceSources = { source1: s1, source2: s2 };
    } else {
      settings.priceSources = { source1: 'coingecko', source2: 'coinbase' };
    }
    // The grace settings ride along the same way: a backup
    // from before 0.8.0 carries none, which restores as the defaults
    // (7 days offline to trigger, 7-day grace); a present but invalid
    // value rejects the whole restore, like a bad node URL. The active
    // grace itself does NOT ride along — a restore counts as a check-in
    // (the owner is present), so the grace is cleared. The
    // toggle rides along too:
    // a backup from before the toggle carries no flag, which restores
    // as on — except a stored duration of 0, which meant off, so it
    // restores as off.
    if (bsSettings.graceEnabled !== undefined) {
      if (typeof bsSettings.graceEnabled !== 'boolean') {
        return sendError(res, 400, 'backup graceEnabled must be a boolean');
      }
      settings.graceEnabled = bsSettings.graceEnabled;
    } else {
      settings.graceEnabled = (bsSettings.graceDurationDays === 0) ? false : true;
    }
    if (bsSettings.graceOfflineDays !== undefined && bsSettings.graceOfflineDays !== null) {
      if (typeof bsSettings.graceOfflineDays !== 'number' || !GRACE_OFFLINE_DAYS.includes(bsSettings.graceOfflineDays)) {
        return sendError(res, 400, 'backup graceOfflineDays must be one of ' + GRACE_OFFLINE_DAYS.join(', ') + ' days');
      }
      settings.graceOfflineDays = bsSettings.graceOfflineDays;
    } else {
      settings.graceOfflineDays = 7;
    }
    if (bsSettings.graceDurationDays !== undefined) {
      if (bsSettings.graceDurationDays !== null && (typeof bsSettings.graceDurationDays !== 'number' || !GRACE_DURATION_DAYS.includes(bsSettings.graceDurationDays))) {
        return sendError(res, 400, 'backup graceDurationDays must be one of ' + GRACE_DURATION_DAYS.join(', ') + ' days (0 = off, kept for back-compat), or null for indefinite');
      }
      settings.graceDurationDays = bsSettings.graceDurationDays;
    } else {
      settings.graceDurationDays = 7;
    }
    // The price-agreement, check-cadence, and fee-verdict
    // settings ride along the same way: a backup from before
    // 0.8.0 carries none, which restores as the defaults; a
    // present but invalid value rejects the whole restore, like a
    // bad node URL. The fee pair is validated together (using
    // the backup's value where present, the default otherwise)
    // so a partial pair cannot break the Low-above-Medium
    // invariant.
    if (bsSettings.priceAgreementPct !== undefined && bsSettings.priceAgreementPct !== null) {
      if (typeof bsSettings.priceAgreementPct !== 'number' || !Number.isFinite(bsSettings.priceAgreementPct) || bsSettings.priceAgreementPct < PRICE_AGREEMENT_PCT_MIN || bsSettings.priceAgreementPct > PRICE_AGREEMENT_PCT_MAX) {
        return sendError(res, 400, 'backup priceAgreementPct must be a number from ' + PRICE_AGREEMENT_PCT_MIN + ' to ' + PRICE_AGREEMENT_PCT_MAX + ' (%)');
      }
      settings.priceAgreementPct = bsSettings.priceAgreementPct;
    } else {
      settings.priceAgreementPct = PRICE_AGREEMENT_PCT_DEFAULT;
    }
    if (bsSettings.checkCadenceSeconds !== undefined && bsSettings.checkCadenceSeconds !== null) {
      if (typeof bsSettings.checkCadenceSeconds !== 'number' || !Number.isFinite(bsSettings.checkCadenceSeconds) || bsSettings.checkCadenceSeconds < CHECK_CADENCE_SECONDS_MIN || bsSettings.checkCadenceSeconds > CHECK_CADENCE_SECONDS_MAX) {
        return sendError(res, 400, 'backup checkCadenceSeconds must be a number from ' + CHECK_CADENCE_SECONDS_MIN + ' to ' + CHECK_CADENCE_SECONDS_MAX + ' (seconds)');
      }
      settings.checkCadenceSeconds = bsSettings.checkCadenceSeconds;
    } else {
      settings.checkCadenceSeconds = CHECK_CADENCE_SECONDS_DEFAULT;
    }
    if (bsSettings.feeLowMultiplier !== undefined || bsSettings.feeMediumMultiplier !== undefined) {
      const low = (bsSettings.feeLowMultiplier !== undefined && bsSettings.feeLowMultiplier !== null) ? bsSettings.feeLowMultiplier : FEE_LOW_MULT_DEFAULT;
      const med = (bsSettings.feeMediumMultiplier !== undefined && bsSettings.feeMediumMultiplier !== null) ? bsSettings.feeMediumMultiplier : FEE_MED_MULT_DEFAULT;
      if (typeof low !== 'number' || !Number.isFinite(low) || low < FEE_LOW_MULT_MIN || low > FEE_LOW_MULT_MAX) {
        return sendError(res, 400, 'backup feeLowMultiplier must be a number from ' + FEE_LOW_MULT_MIN + ' to ' + FEE_LOW_MULT_MAX + ' (× peak)');
      }
      if (typeof med !== 'number' || !Number.isFinite(med) || med < FEE_MED_MULT_MIN || med > FEE_MED_MULT_MAX) {
        return sendError(res, 400, 'backup feeMediumMultiplier must be a number from ' + FEE_MED_MULT_MIN + ' to ' + FEE_MED_MULT_MAX + ' (× peak)');
      }
      if (low <= med) {
        return sendError(res, 400, 'backup feeLowMultiplier must be greater than feeMediumMultiplier');
      }
      settings.feeLowMultiplier = low;
      settings.feeMediumMultiplier = med;
    } else {
      settings.feeLowMultiplier = FEE_LOW_MULT_DEFAULT;
      settings.feeMediumMultiplier = FEE_MED_MULT_DEFAULT;
    }
    const txs = [];
    const seenIds = new Set();
    for (const t of bs.bitcoin.txs) {
      if (!t || typeof t.hex !== 'string' || !t.hex.trim()) {
        return sendError(res, 400, 'backup transaction is missing its hex');
      }
      let parsed;
      try { parsed = bitcoin.parseTx(t.hex.trim()); }
      catch (e) { return sendError(res, 400, 'backup transaction hex is invalid: ' + e.message); }
      // A release record is only accepted when its status is one the
      // app itself writes, its txid is a string equal to the txid of
      // the hex in this same backup entry, and its kind (when
      // present) is one the app writes. The txid is REQUIRED: without
      // it, {"release":{"status":"stale"}} would permanently disable a
      // transaction that was never broadcast. Anything else rejects
      // the WHOLE restore — a corrupt or hand-edited backup must not
      // silently mark a transaction stale, or resurrect a broadcast
      // that never happened. Even a txid-matching broadcast/stale
      // claim is not believed: it is dropped when the restored tx is
      // built below, and the network re-derives it; the check here
      // only rejects a malformed or mismatched record outright. A
      // record the app wrote always passes: every writer carries
      // txid = the tx's txid (broadcastOneInner paths, dry-run
      // verdict writes) and kind in RELEASE_KINDS, and the state
      // migration guarantees txid on older records.
      if (t.release !== undefined && t.release !== null) {
        if (typeof t.release !== 'object' || !RELEASE_STATUSES.has(t.release.status)
            || typeof t.release.txid !== 'string' || t.release.txid !== parsed.txid
            || (t.release.kind !== undefined && !RELEASE_KINDS.has(t.release.kind))) {
          return sendError(res, 400, 'backup transaction release record is invalid');
        }
      }
      if (t.broadcasted !== undefined && t.broadcasted !== null) {
        if (typeof t.broadcasted !== 'object' || t.broadcasted.txid !== parsed.txid) {
          return sendError(res, 400, 'backup transaction broadcast record does not match its hex');
        }
      }
      let id = (typeof t.id === 'string' && t.id) ? asStr(t.id, 40) : '';
      if (!id || seenIds.has(id)) id = store.newTxId();
      seenIds.add(id);
      // The rule set rides through validation (the same
      // per-rule rules as a single trigger), and the triggerState
      // is normalized to the rule count — a flat object wraps to
      // one element, an array is sanitized / padded / truncated,
      // a malformed one restores as null (the evaluator overwrites
      // it on the next evaluation anyway).
      const restoredTrigger = store.triggerOf(t);
      txs.push({
        id,
        txid: parsed.txid,
        hex: t.hex.trim(),
        label: asStr(t.label || '', 80),
        notes: asStr(t.notes || '', 500),
        createdAt: (typeof t.createdAt === 'string' && t.createdAt) ? t.createdAt : now.toISOString(),
        inputs: parsed.inputs.length,
        outputs: parsed.outputs.length,
        totalOutSats: parsed.totalOutSats,
        // The fee: carried through when present (a number
        // or null); a backup from before 0.7.18 carries no fee,
        // which restores as null — the same as an older record
        // loaded from disk. A negative or non-finite value is not
        // believed either.
        feeSats: (typeof t.feeSats === 'number' && Number.isFinite(t.feeSats) && t.feeSats >= 0) ? t.feeSats : null,
        feeRateSatVb: (typeof t.feeRateSatVb === 'number' && Number.isFinite(t.feeRateSatVb) && t.feeRateSatVb >= 0) ? t.feeRateSatVb : null,
        locktime: parsed.locktime,
        segwit: parsed.segwit,
        enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
        // The check-in freeze: carried through when
        // valid; a backup from before the redesign carries none,
        // which restores as 0 / null — the same as an older record
        // loaded from disk. (The restore itself counts as a
        // check-in, so the offsets are reset to the new clock
        // below — this carry-through is what validates them.)
        checkinOffsetMs: (typeof t.checkinOffsetMs === 'number' && Number.isFinite(t.checkinOffsetMs) && t.checkinOffsetMs >= 0) ? t.checkinOffsetMs : 0,
        checkinInactiveSince: (typeof t.checkinInactiveSince === 'string' && t.checkinInactiveSince && !Number.isNaN(new Date(t.checkinInactiveSince).getTime())) ? t.checkinInactiveSince : null,
        // The broadcast route: a backup from before 0.7.16
        // carries no route, which restores as 'public' — the same
        // as an older record loaded from disk.
        broadcastVia: validBroadcastVia(t.broadcastVia),
        // The public fallback: a backup from before 0.7.17
        // carries no duration, which restores as Never (null) — the
        // same as an older record loaded from disk. The first-attempt
        // timestamp rides along too (an unparseable one is dropped);
        // without it a restored failing-submit tx would have no
        // fallback deadline until its next attempt.
        publicFallbackDays: validPublicFallbackDays(t.publicFallbackDays),
        slipstreamFirstAttemptAt: (typeof t.slipstreamFirstAttemptAt === 'string'
          && !Number.isNaN(new Date(t.slipstreamFirstAttemptAt).getTime())) ? t.slipstreamFirstAttemptAt : null,
        // The trigger: carried through
        // when valid — a single trigger or a rule set; a backup
        // from before 0.8.0 carries none, which restores as the
        // check-in trigger at the 35-day fallback — the same as
        // an older record loaded from disk. An invalid trigger in a
        // hand-edited backup falls back the same way (like the
        // route and fallback above: lenient, never a 400 — a bad
        // trigger must not reject a whole restore). The
        // triggerState rides along too, normalized to the rule
        // count (a malformed one restores as null — the evaluator
        // overwrites it on the next evaluation anyway).
        trigger: restoredTrigger,
        triggerState: store.normalizeTriggerState(t.triggerState, restoredTrigger.rules.length),
        // A broadcasted fact — or a release record claiming the tx
        // already went out ('broadcast') or is spent ('stale') — is
        // NOT believed from a backup on txid match alone: a
        // hand-edited backup could falsely mark a transaction
        // broadcast, or permanently disable one as stale. Both are
        // re-derived from the network on the next evaluation (the
        // freshness gate recognises a tx already out there, and
        // marks spent inputs stale), so the restore drops them and
        // the tx comes back active. 'failed', 'conflict', and
        // 'submitted-slipstream' records are transient and
        // self-correcting, so they ride along.
        release: (t.release && (t.release.status === 'broadcast' || t.release.status === 'stale')) ? null : (t.release ? t.release : null),
        broadcasted: null,
        // The event trail rides along when it is well
        // formed — display-only, so a hand-edited backup cannot
        // hurt anything by forging it. The same distrust as the
        // records above applies to its broadcast claims: a
        // 'broadcast', 'confirmed', or 'stale' event from the
        // backup is dropped with the record it describes, and the
        // network re-derives it. A backup from before 0.8.2
        // carries no history (null) — the load-time backfill seeds
        // it from the restored facts on the next load.
        history: Array.isArray(t.history)
          ? t.history.filter((e) => e && typeof e === 'object' && store.HISTORY_TYPES.has(e.type)
              && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
              && typeof e.detail === 'string'
              && e.type !== 'broadcast' && e.type !== 'confirmed' && e.type !== 'stale').slice(-HISTORY_MAX)
          : null,
      });
    }
    // Trigger sets ride along: each set's members must be
    // among the restored txs, its trigger normalized, its history
    // sanitized like a tx's (broadcast/confirmed/stale events are
    // dropped with the records they describe — the network
    // re-derives them). A set naming no restored tx is dropped
    // whole (its members stay standalone); a duplicate id, or a
    // tx in two sets, keeps only the first.
    const restoredSets = [];
    const restoredTxIds = new Set(txs.map((t) => t.id));
    const seenSetIds = new Set();
    const seenSetMembers = new Set();
    if (Array.isArray(bs.bitcoin.sets)) {
      for (const bsSet of bs.bitcoin.sets) {
        if (!bsSet || typeof bsSet !== 'object' || typeof bsSet.id !== 'string' || !bsSet.id || seenSetIds.has(bsSet.id)) continue;
        seenSetIds.add(bsSet.id);
        const memberIds = Array.isArray(bsSet.txIds)
          ? [...new Set(bsSet.txIds.filter((id) => typeof id === 'string' && restoredTxIds.has(id) && !seenSetMembers.has(id)))]
          : [];
        if (!memberIds.length) continue;
        const restoredSetTrigger = store.triggerOf(bsSet);
        restoredSets.push({
          id: asStr(bsSet.id, 40),
          label: asStr(bsSet.label || '', 80),
          enabled: typeof bsSet.enabled === 'boolean' ? bsSet.enabled : true,
          txIds: memberIds,
          trigger: restoredSetTrigger,
          triggerState: store.normalizeTriggerState(bsSet.triggerState, restoredSetTrigger.rules.length),
          history: Array.isArray(bsSet.history)
            ? bsSet.history.filter((e) => e && typeof e === 'object' && store.HISTORY_TYPES.has(e.type)
                && typeof e.ts === 'string' && !Number.isNaN(new Date(e.ts).getTime())
                && typeof e.detail === 'string'
                && e.type !== 'broadcast' && e.type !== 'confirmed' && e.type !== 'stale').slice(-HISTORY_MAX)
            : null,
          createdAt: (typeof bsSet.createdAt === 'string' && bsSet.createdAt) ? bsSet.createdAt : now.toISOString(),
          checkinOffsetMs: 0,
          checkinInactiveSince: null,
        });
        for (const id of memberIds) seenSetMembers.add(id);
      }
    }
    const bsCheckin = (bs.checkin && typeof bs.checkin === 'object') ? bs.checkin : {};
    // The check-in time must be a
    // real date and not in the future (beyond the same 5-minute skew
    // the receiver merge allows). An invalid date makes checkinStatus
    // throw on every status read (new Date(NaN).toISOString()), and a
    // far-future date would silently postpone the release forever.
    // Anything else rejects the WHOLE restore before anything is
    // applied. A real backup always carries a valid ISO timestamp
    // (or null, for a setup that has never checked in), so this
    // cannot reject a backup the app itself wrote.
    let lastCheckinAt = null;
    if (bsCheckin.lastCheckinAt !== undefined && bsCheckin.lastCheckinAt !== null) {
      if (typeof bsCheckin.lastCheckinAt !== 'string') {
        return sendError(res, 400, 'backup check-in time is invalid');
      }
      const at = new Date(bsCheckin.lastCheckinAt);
      if (Number.isNaN(at.getTime())) {
        return sendError(res, 400, 'backup check-in time is not a valid date');
      }
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
        return sendError(res, 400, 'backup check-in time is in the future');
      }
      lastCheckinAt = bsCheckin.lastCheckinAt;
    }
    // The "I was online" stamp rides along the same way:
    // a real date (or null), never in the future beyond the same
    // 5-minute skew — a future stamp would hide a real offline gap
    // and defeat the grace. A backup's check-in hold
    // (heldUntil) is accepted and dropped, never a 400 — and NOT
    // translated into a grace the way loadState does: a restore
    // counts as a check-in (the clock
    // resets to now below) and the grace is cleared by design,
    // so there is no due check-in for a translated hold to
    // protect and no offline gap for it to describe. Dropping
    // it here cannot cause a broadcast.
    let lastOnlineAt = null;
    if (bsCheckin.lastOnlineAt !== undefined && bsCheckin.lastOnlineAt !== null) {
      if (typeof bsCheckin.lastOnlineAt !== 'string') {
        return sendError(res, 400, 'backup last-online time is invalid');
      }
      const at = new Date(bsCheckin.lastOnlineAt);
      if (Number.isNaN(at.getTime())) {
        return sendError(res, 400, 'backup last-online time is not a valid date');
      }
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
        return sendError(res, 400, 'backup last-online time is in the future');
      }
      lastOnlineAt = bsCheckin.lastOnlineAt;
    }
    // Check-in API keys ride along in the backup (hashes only — the
    // plaintext keys were never stored, so a backup cannot leak them).
    // A malformed key entry rejects the restore, like a bad tx hex. A
    // backup from before 0.6.6 carries no keys at all, which restores
    // as an empty list.
    const restoredKeys = [];
    if (Array.isArray(bs.checkinKeys)) {
      for (const k of bs.checkinKeys) {
        if (!k || typeof k !== 'object' || typeof k.id !== 'string' || !k.id
            || typeof k.label !== 'string' || typeof k.hash !== 'string'
            || !/^[0-9a-f]{64}$/.test(k.hash)) {
          return sendError(res, 400, 'backup check-in key entry is invalid');
        }
        restoredKeys.push({
          id: asStr(k.id, 40), label: asStr(k.label, 80), hash: k.hash,
          createdAt: (typeof k.createdAt === 'string' && k.createdAt) ? k.createdAt : now.toISOString(),
          lastUsedAt: (typeof k.lastUsedAt === 'string' || k.lastUsedAt === null) ? (k.lastUsedAt || null) : null,
        });
      }
    }
    const restored = {
      version: 7,
      createdAt: (typeof bs.createdAt === 'string' && bs.createdAt) ? bs.createdAt : now.toISOString(),
      updatedAt: now.toISOString(),
      settings,
      bitcoin: {
        txs,
        sets: restoredSets,
        connection: (bs.bitcoin.connection && typeof bs.bitcoin.connection === 'object')
          ? bs.bitcoin.connection : { ok: null, checkedAt: null, detail: '' },
      },
      checkin: {
        // A restore is proof the owner is present, so it
        // counts as a check-in: the clock starts clean at the
        // restore moment. The backup's clock is still VALIDATED
        // above (a corrupt or future-dated clock rejects the whole
        // restore) — it is just not carried forward: lastCheckinAt
        // and lastOnlineAt are now, and the count keeps the
        // backup's total plus this restore.
        lastCheckinAt: now.toISOString(),
        totalCheckins: clampInt(bsCheckin.totalCheckins, 0, 0, 1000000) + 1,
        lastOnlineAt: now.toISOString(),
      },
      checkinKeys: restoredKeys,
      // The fee history rides along: the peak is computed
      // from these observations, so restoring without them would
      // reset the verdict to "still building" for a day. A backup
      // from before 0.8.9 carries none, which restores as empty.
      // Sanitized like a load — a hand-edited backup cannot
      // smuggle a bad entry into the peak.
      feeHistory: store.sanitizeFeeHistory(bs.feeHistory),
    };
    // The restore counts as a check-in (see the clock
    // comment above): the offsets are measured against the OLD
    // clock, so they are reset to the new one — a carried offset
    // would otherwise push the effective last check-in into the
    // future and the bar would read a negative count. A tx that
    // is still inactive (disarmed, or the restored vacation is
    // on) is re-marked inactive from now, so it stays frozen at 0.
    for (const t of txs) {
      if (!store.hasTriggerType(t, 'checkin')) continue;
      t.checkinOffsetMs = 0;
      t.checkinInactiveSince = null;
    }
    for (const t of txs) syncCheckinFreeze(t, restored, now);
    // A restored set's check-in freeze resets the same way.
    for (const s of restoredSets) {
      if (!store.hasTriggerType(s, 'checkin')) continue;
      s.checkinOffsetMs = 0;
      s.checkinInactiveSince = null;
    }
    for (const s of restoredSets) syncCheckinFreeze(s, restored, now);
    store.saveState(DATA_DIR, restored);
    // The warnings describe the state that was just
    // replaced — a recovery at boot, say — so they are stale now;
    // clear both lists.
    store.clearStateWarnings();
    startupWarnings.length = 0;
    // A restored cadence takes effect immediately — the running
    // fast tick is cleared and restarted with it.
    rearmFullTick();
    // The receiver's key list matches the restored state from now on.
    writeReceiverKeys(restored);
    if (Array.isArray(body.checkins)) store.writeCheckins(DATA_DIR, body.checkins.slice(-200));
    if (Array.isArray(body.broadcastLog)) store.writeBroadcastLog(DATA_DIR, body.broadcastLog.slice(-200));
    // The restore itself is a check-in — record it in
    // the history so the displayed last check-in matches the
    // refreshed clock. Appended after the backup's own history
    // (above), so it is the most recent entry; the method reads
    // 'restore' in the recent-check-ins list.
    store.appendCheckin(DATA_DIR, { ts: now.toISOString(), method: 'restore' });
    // The restored state is served the same way as a read (a
    // one-rule set as its single rule — see GET /api/state).
    const servedRestored = sanitizeState(restored);
    // The fee history is state-internal — see GET
    // /api/state — never served, even in a restore response.
    delete servedRestored.feeHistory;
    servedRestored.bitcoin.txs = serveTxs(servedRestored.bitcoin.txs || []);
    servedRestored.bitcoin.sets = serveSets(servedRestored.bitcoin.sets || []);
    return sendJson(res, 200, { ok: true, restoredTxs: txs.length, restoredSets: restoredSets.length, state: servedRestored });
  }

  // POST /api/bitcoin/connection/test — verifies both nodes without
  // moving funds. Saves the result (including the per-endpoint results)
  // so the Dashboard can show each node's own status. The app is OK if
  // either one answers (the other is the backup).
  if (req.method === 'POST' && pathname === '/api/bitcoin/connection/test') {
    const r = await bitcoin.testConnection(bitcoin.endpointsFor(state.settings), { probeOutputLookup: true });
    const conn = { ok: r.ok, checkedAt: now.toISOString(), detail: r.detail, results: r.results };
    // The node test awaited the network —
    // only the connection result rides into FRESH state.
    // The per-endpoint stamps ride over from the stored
    // connection, then the live stamps (the test just asked both
    // endpoints) overwrite them.
    saveMutation((f) => {
      const prev = (f.bitcoin.connection && f.bitcoin.connection.nodeCheckedAt) || null;
      f.bitcoin.connection = conn;
      if (prev) f.bitcoin.connection.nodeCheckedAt = { primary: prev.primary || null, secondary: prev.secondary || null };
      mergeNodeStamps(f);
    });
    return sendJson(res, 200, { ok: r.ok, detail: r.detail, results: r.results });
  }

  // POST /api/broadcast/test — DRY-RUN validation. Checks the stored
  // txs' inputs are still unspent via the primary node (falling back to
  // the secondary) and reports whether a broadcast would be attempted.
  // Never broadcasts anything.
  // Body { id } dry-runs one transaction; no id dry-runs all stored
  // ones. Every transaction is checked, armed or not — a dry-run is a
  // read-only test, and a signed transaction should be testable the
  // moment it is stored. The aggregate "would broadcast" count stays
  // armed-only (that is the release-relevant number). A failed check on
  // one tx does not stop the others.
  // A dry-run all only tests the transactions that could still
  // broadcast. One that has already been broadcast, or whose inputs
  // were already declared spent, is left out of the results and the
  // aggregate — the run gives it no new status. (A single dry-run of
  // one transaction still tests it: the owner asked for that one.)
  // A spent verdict is recorded on the transaction (a stale release
  // record, kind 'dryrun'): staleness is a fact about the inputs, so
  // the card stays Stale — and stays in the Archived Transactions
  // card — across refreshes and check-ins (a verdict kept only in
  // the page's memory would pop back to Ready on every refresh).
  if (req.method === 'POST' && pathname === '/api/broadcast/test') {
    const body = await readBody(req).catch(() => ({}));
    let txs = state.bitcoin.txs || [];
    // A set dry-run checks every member: { setId } names
    // the set, like { id } names one tx.
    let drySet = null;
    if (body && body.setId) {
      drySet = (state.bitcoin.sets || []).find((s) => s.id === body.setId);
      if (!drySet) return sendError(res, 404, 'no such trigger set');
      txs = setMembers(state, drySet);
    } else if (body && body.id) {
      const one = txs.find((t) => t.id === body.id);
      if (!one) return sendError(res, 404, 'no such transaction');
      txs = [one];
    }
    if (!txs.length) return sendError(res, 400, 'no transactions stored — paste a signed transaction hex first');
    const results = [];
    for (const tx of txs) {
      if (!body.id && (tx.broadcasted || (tx.release && tx.release.status === 'stale'))) {
        continue;
      }
      try {
        const r = await bitcoin.dryRun(DATA_DIR, { tx, endpoints: bitcoin.endpointsFor(state.settings), ttlMs: checkCadenceSecondsOf(state.settings) * 1000 });
        // A price rule's dry-run note carries the source
        // detail — which sources were used, their readings,
        // single-source fallback, or that they disagreed — because
        // the subcard and the readiness card do not repeat it
        // (it lives in the Exchange Status section and here, in
        // the dry-run notes). A price-fetch failure never breaks
        // the dry run itself; the note just says so.
        // A set member's dry-run note reads the SET's
        // trigger — the member's own trigger is dormant while it
        // is attached.
        const trg = drySet ? store.triggerOf(drySet) : store.triggerOf(tx);
        if (trg && trg.rules.some((r) => r.type === 'price')) {
          try {
            const readings = await fetchPriceCached(priceSourcesOf(state.settings), checkCadenceSecondsOf(state.settings));
            const comb = bitcoin.combinePriceReadings(readings, priceAgreementPctOf(state.settings));
            let srcDetail;
            if (comb.mode === 'disagree' || comb.mode === 'none') {
              srcDetail = comb.reason.charAt(0).toUpperCase() + comb.reason.slice(1);
            } else {
              srcDetail = 'Price sources: ' + comb.note;
            }
            r.note = (r.note || '') + ' ' + srcDetail + '.';
          } catch (e) {
            r.note = (r.note || '') + ' Price sources: could not be checked.';
          }
        }
        results.push({ id: tx.id, label: tx.label || '', enabled: drySet ? !!drySet.enabled : !!tx.enabled, ...r });
      } catch (e) {
        results.push({ id: tx.id, txid: tx.txid, label: tx.label || '', enabled: drySet ? !!drySet.enabled : !!tx.enabled, broadcastVia: validBroadcastVia(tx.broadcastVia), wouldBroadcast: false, error: e.message });
      }
    }
    // Persist what the run found (three cases, not just
    // stale): a broadcasted transaction is never
    // re-marked (its broadcast record takes precedence), and a stale
    // verdict is a fact and is left alone once recorded. An own-txid
    // spend is recorded as broadcast — recognition, not a re-send;
    // the dry-run never broadcasts, and neither does the record. A
    // conflict warning is re-derived on every fresh check: a clean
    // verdict clears it (the unconfirmed spend was evicted), a
    // confirmed spend turns it stale. The dry-run log entry (written
    // by bitcoin.dryRun) already records the run itself, so no second
    // log entry is written here.
    // The verdicts are network facts
    // collected above; only the per-tx updates ride into FRESH
    // state, with the same guards re-evaluated there — a tx
    // broadcast or deleted while the run was on the network must
    // not have its record rewritten from this stale snapshot.
    const actions = [];
    for (const r of results) {
      const a = { id: r.id };
      // The fee: a dry-run OVERWRITES the stored fee with
      // the freshly computed one — the input values were fetched
      // from the node for the freshness check anyway. A fee stored
      // wrong (e.g. by the units bug, which read the parent value
      // as BTC) self-corrects on the next dry-run instead of
      // lingering; a null result (the node could not answer) leaves
      // the stored fee alone.
      if (r.fee && typeof r.fee.feeSats === 'number') {
        a.fee = { feeSats: r.fee.feeSats, feeRateSatVb: (typeof r.fee.feeRateSatVb === 'number') ? r.fee.feeRateSatVb : null };
      }
      if (r.spent && r.spent.length) {
        a.stale = { method: r.checkedVia, error: 'inputs spent: ' + r.spent.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ') };
      } else if (r.own && r.own.length) {
        a.own = { method: r.checkedVia, blockHeight: r.own[0].blockHeight != null ? r.own[0].blockHeight : null };
      } else if (r.conflict && r.conflict.length) {
        a.conflict = { method: r.checkedVia, error: 'inputs spent by an unconfirmed transaction: ' + r.conflict.map((i) => String(i.prevTxid || '').slice(0, 12) + ':' + i.prevVout).join(', ') };
      } else if (r.verdict === 'ready') {
        // A clean verdict re-derives the warning away: the unconfirmed
        // spend was evicted, so the transaction is ready again. Only a
        // 'ready' verdict clears — an 'unknown' verdict cannot prove
        // the input unspent, so the warning stands on ambiguous data.
        a.clearConflict = true;
      }
      if (a.fee || a.stale || a.own || a.conflict || a.clearConflict) actions.push(a);
    }
    if (actions.length) {
      saveMutation((f) => {
        for (const a of actions) {
          const ftx = (f.bitcoin.txs || []).find((t) => t.id === a.id);
          if (!ftx || ftx.broadcasted) continue;
          if (a.fee) {
            ftx.feeSats = a.fee.feeSats;
            ftx.feeRateSatVb = a.fee.feeRateSatVb;
          }
          if (a.stale) {
            if (ftx.release && ftx.release.status === 'stale') continue;
            ftx.release = { status: 'stale', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.stale.method, lastAttemptAt: now.toISOString(), error: a.stale.error };
            // The dry run discovered the staleness — the
            // tx's history should say so, not just its card.
            pushHistory(ftx, 'stale', a.stale.error);
            // The set-stale rule: a stale member
            // does NOT archive its set — the verdict is noted on
            // the set's shared history, and the set keeps firing
            // for its non-stale members.
            noteSetMemberStale(f, ftx, a.stale.error);
            continue;
          }
          if (a.own) {
            // Repair, don't overwrite: a release that already went out
            // keeps its kind ('release'); a broadcasted fact keeps the
            // confirmations it already has. A restore could have left
            // one half of the pair behind — the check that just proved
            // the tx is out there fills in the missing half.
            if (!ftx.broadcasted) {
              ftx.broadcasted = {
                txid: ftx.txid, broadcastedAt: now.toISOString(), method: a.own.method,
                confirmations: null, blockHeight: a.own.blockHeight, found: true, checkedAt: now.toISOString(),
              };
              // The dry run discovered the tx is out there.
              pushHistory(ftx, 'broadcast', 'txid ' + shortTxid(ftx.txid));
              forwardMemberHistory(f, ftx, 'broadcast', 'txid ' + shortTxid(ftx.txid));
              if (a.own.blockHeight != null) {
                pushHistory(ftx, 'confirmed', 'Block ' + a.own.blockHeight.toLocaleString('en-US'));
                forwardMemberHistory(f, ftx, 'confirmed', 'Block ' + a.own.blockHeight.toLocaleString('en-US'));
              }
            }
            if (!ftx.release || ftx.release.status !== 'broadcast') {
              ftx.release = { status: 'broadcast', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.own.method, broadcastedAt: now.toISOString() };
            }
            continue;
          }
          if (a.conflict) {
            if (ftx.release && ftx.release.status === 'stale') continue;
            ftx.release = { status: 'conflict', kind: 'dryrun', trigger: releaseTriggerFor(f, ftx), txid: ftx.txid, method: a.conflict.method, lastAttemptAt: now.toISOString(), error: a.conflict.error };
            // The warning on the card gets its history line.
            pushHistory(ftx, 'conflict', a.conflict.error);
            forwardMemberHistory(f, ftx, 'conflict', a.conflict.error);
            continue;
          }
          if (a.clearConflict && ftx.release && ftx.release.status === 'conflict') ftx.release = null;
        }
      });
    }
    const armed = results.filter((r) => r.enabled);
    // 'would broadcast' counts the transactions that would actually
    // land: a timelocked transaction is attempted (its per-result
    // wouldBroadcast is true — the release will try it) but the node
    // will reject it as non-final until the locktime passes, so it is
    // not counted here. It is named separately, so the summary never
    // implies it will successfully broadcast right now. A
    // Slipstream-route transaction is named separately too:
    // it would be submitted to MARA, not broadcast to the public
    // mempool — so if every would-be transaction is Slipstream, the
    // summary says "would submit to Slipstream"; if only some are,
    // it says how many are via Slipstream.
    const would = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked').length;
    const slipstream = armed.filter((r) => r.wouldBroadcast && r.verdict !== 'timelocked' && r.broadcastVia === 'slipstream').length;
    const stale = armed.filter((r) => r.spent && r.spent.length).length;
    const timelocked = armed.filter((r) => r.verdict === 'timelocked').length;
    // Dry-run all also checks that no input is spent by two stored
    // transactions: only one of them can ever be confirmed, so the shared
    // input is flagged on both cards. A single dry-run does not run
    // this check — it is a property of the whole list. Archived
    // transactions are excluded from the check: their fate
    // is decided, so a live transaction sharing an input with an
    // archived one is not warned about it.
    const overlaps = body && body.id ? [] : bitcoin.findSharedInputs(state.bitcoin.txs || []);
    const overlapNote = overlaps.length
      ? ' Warning: ' + overlaps.length + ' input(s) are shared across transactions — only one transaction per shared input can ever be confirmed: '
        + overlaps.map((o) => o.input.slice(0, 12) + ':' + o.input.split(':')[1] + ' in ' + o.txIds.length + ' transactions').join('; ') + '.'
      : '';
    const note = results.length === 1
      ? (results[0].note || results[0].error || '')
      : results.length === 0
        ? 'No transactions to check — every stored transaction has already been broadcast or is stale.'
        : would + ' of ' + armed.length + ' armed transaction(s) would '
          + (slipstream > 0 && slipstream === would ? 'submit to Slipstream' : 'broadcast')
          + (slipstream > 0 && slipstream < would ? ' (' + slipstream + ' via Slipstream)' : '')
          + (stale ? ', ' + stale + ' stale' : '') + (timelocked ? ', ' + timelocked + ' timelocked' : '') + '.';
    return sendJson(res, 200, { ok: true, dryRun: true, results, wouldBroadcast: would > 0, overlaps, note: note + overlapNote });
  }

  return sendError(res, 404, 'unknown API route');
}

module.exports = { RELEASE_STATUSES, RELEASE_KINDS, handleApi };
