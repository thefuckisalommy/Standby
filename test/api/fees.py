"""API suite: Fee trigger and the accumulated fee peak (sections 24, 31)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 24. fee trigger: 5-minute node fee cache ---
    # Two fee-rule evaluations within 5 minutes cost one primary fee
    # fetch. Tick parked.
    def fee_counts():
        _, rp = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
        _, rs = req('GET', '/__test__/fee-count', base=STUB_BASE_S)
        return rp.get('count', -1), rs.get('count', -1)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('24 setup: cadence parked at 3600 s', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_P)
    check('24 setup: primary stub fee set to 5', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 4.5}, base=STUB_BASE_S)
    check('24 setup: secondary stub fee set to 4.5', s == 200, (s, r))
    # Two disarmed staged fee txs, both watching at fee 5.
    s, r = add_tx('Fee 24a', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 111400)
    check('24 cache: first watching fee tx adds', s == 201, (s, r))
    fee1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('Fee 24b', {'type': 'feemarket', 'params': {'maxFeeRate': 6, 'direction': 'above'}}, 111401)
    check('24 cache: second watching fee tx adds', s == 201, (s, r))
    fee2 = r['tx']['id'] if s == 201 else None
    for tid in (fee1, fee2):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('24 cache: both fee txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
    # Pointing the secondary at a closed port busts the cache: the
    # first evaluation fetches, the second reads it.
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
    check('24 cache: secondary pointed at a closed port (busts the fee cache)', s == 200, (s, r))
    fp0, fs0 = fee_counts()
    s, r, res = release_results()
    check('24 cache: release check runs', s == 200, (s, r))
    fp1, fs1 = fee_counts()
    check('24 cache: two fee rules cost ONE fee fetch, from the primary only',
          (fp1, fs1) == (fp0 + 1, fs0), ((fp0, fs0), (fp1, fs1)))
    for tid in (fee1, fee2):
        t = state_tx(tid)
        check('24 cache: the disarmed fee tx IS evaluated (slice refreshed, fee 5, primary-only note)',
              rule_slice(t).get('lastEconomyFee') == 5
              and rule_slice(t).get('feeMode') == 'single'
              and rule_slice(t).get('feeNote') == 'primary only — secondary not needed', rule_slice(t))
    # Restore: secondary back to the stub, both fees back to
    # 1, cadence back to 60.
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S, 'checkCadenceSeconds': 60})
    check('24 cleanup: secondary and cadence restored', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
    check('24 cleanup: stubs restored to fee 1', s == 200, (s, r))
    delete_all_txs()

    # --- 31. accumulated fee peak ---
    # One economy-fee reading per hourly tick from the configured
    # nodes; the peak is the 90th percentile and needs 24 readings
    # over a full day. Esplora is exact-target-or-nothing and floored
    # at 1 sat/vB. A second app on port 3440 gives controlled counts;
    # unit checks cover the pure helpers.
    lp_dir = TMP + '/standby-test099-accumpeak'
    lp_checkin = lp_dir + '-checkin'
    lp_port = 3440
    lp_base = 'http://127.0.0.1:%d' % lp_port
    lp_log = TMP + '/standby-test099-accumpeak-proc.log'
    app_lp = None

    def lp_state():
        s, st = req('GET', '/api/state', base=lp_base)
        return st

    def lp_bitcoin():
        return (lp_state().get('bitcoin', {}) or {})

    def lp_state_file():
        return json.load(open(os.path.join(lp_dir, 'state.json')))

    def lp_seed_state(fee_history, primary=STUB_BASE_P, secondary=STUB_BASE_S):
        # Seed the second app from the main app's state with pinned
        # nodes and exactly the given readings.
        shutil.rmtree(lp_dir, ignore_errors=True)
        shutil.rmtree(lp_checkin, ignore_errors=True)
        os.makedirs(lp_dir, exist_ok=True)
        st = load_state_file()
        (st.get('settings', {}) or {})['primaryApiUrl'] = primary
        (st.get('settings', {}) or {})['secondaryApiUrl'] = secondary
        st['feeHistory'] = fee_history
        json.dump(st, open(os.path.join(lp_dir, 'state.json'), 'w'), indent=2)

    def lp_start(env_extra=None):
        env = {'PORT': str(lp_port), 'DATA_DIR': lp_dir, 'CHECKIN_DIR': lp_checkin}
        if env_extra:
            env.update(env_extra)
        return start(['node', 'server.js'], env=env, cwd=APP, log=lp_log)

    def lp_wait_obs(n, deadline=15):
        # Poll until the second app has at least n readings; returns
        # the last bitcoin object.
        end = time.time() + deadline
        st = {}
        while time.time() < end:
            try:
                st = lp_bitcoin()
                if isinstance(st.get('feePeakObservations'), int) and st.get('feePeakObservations') >= n:
                    return st
            except Exception:
                pass
            time.sleep(0.5)
        return st

    def lp_wait_current_fee(fee, deadline=15):
        # Poll until the served current economy fee equals fee
        # (the +2 s startup refresh, from the configured nodes).
        end = time.time() + deadline
        while time.time() < end:
            try:
                cf = (lp_bitcoin().get('currentFees') or {})
                if cf.get('economyFee') == fee:
                    return True
            except Exception:
                pass
            time.sleep(0.5)
        return False

    def obs_hours_ago(hours, fee):
        # One observation `hours` hours ago at `fee` — the
        # timestamps the seed histories are built from.
        return {'t': iso_ago(hours=hours), 'fee': fee}

    try:
        # (a) Unit checks of the pure helpers, no server. The full-
        # history fixture is spaced 59 minutes apart so the hourly
        # dedupe does not block the append being tested.
        node_js = (
            "const b = require('./lib/bitcoin');"
            "const s = require('./lib/store.js');"
            "const now = Date.now();"
            "const h = (n) => new Date(now - n * 3600000).toISOString();"
            "const h24 = Array.from({length: 24}, (_, i) => ({ t: h(23 - i), fee: 2 }));"
            "const h25 = Array.from({length: 25}, (_, i) => ({ t: h(24 - i), fee: 2 }));"
            "const h23 = h24.slice(0, 23);"
            "const pct = Array.from({length: 25}, (_, i) => ({ t: h(24 - i), fee: i < 22 ? 1 : (i < 24 ? 2 : 10) }));"
            "const win3 = Array.from({length: 24}, (_, i) => ({ t: new Date(now - (3 * 86400000 - i * 3 * 3600000)).toISOString(), fee: 2 }));"
            "const old = [{ t: new Date(now - 91 * 86400000).toISOString(), fee: 100 }].concat(h23);"
            "const full = Array.from({length: 2160}, (_, i) => ({ t: new Date(now - (61 + i * 59) * 60000).toISOString(), fee: 2 }));"
            "const dirty = [{ t: h(1), fee: 2 }, { fee: 2 }, { t: h(1), fee: -1 }, { t: 'not-a-date', fee: 2 }, { t: new Date(now + 3600000).toISOString(), fee: 2 }, { t: new Date(now - 91 * 86400000).toISOString(), fee: 2 }];"
            "console.log(JSON.stringify({"
            " p24: b.feePeakFromObservations(h24, now),"
            " p25: b.feePeakFromObservations(h25, now),"
            " p23: b.feePeakFromObservations(h23, now),"
            " pPct: b.feePeakFromObservations(pct, now),"
            " pWin3: b.feePeakFromObservations(win3, now),"
            " pOld: b.feePeakFromObservations(old, now),"
            " pEmpty: b.feePeakFromObservations([], now),"
            " a4: b.appendFeeHistoryObservation([{t: h(3), fee: 1}, {t: h(2), fee: 1}, {t: h(1), fee: 1}], 2, now).length,"
            " aCap: b.appendFeeHistoryObservation(full, 3, now).length,"
            " aBad: b.appendFeeHistoryObservation([{t: h(1), fee: 1}], -1, now).length,"
            " aDedupe: b.appendFeeHistoryObservation([{t: h(2), fee: 1}, {t: new Date(now - 30 * 60000).toISOString(), fee: 1}], 2, now).length,"
            " sClean: s.sanitizeFeeHistory(dirty, now).length,"
            " mFull: b.feeEstimatesToRecommended({'1': 9, '2': 8, '3': 7, '6': 6, '144': 5, '1008': 1}),"
            " mSparse: b.feeEstimatesToRecommended({'6': 7}),"
            " mNear: b.feeEstimatesToRecommended({'120': 5, '168': 4}),"
            " mNull: b.feeEstimatesToRecommended({}),"
            " mSub1: b.feeEstimatesToRecommended({'1': 0.213, '2': 0.213, '3': 0.152, '6': 0.132, '144': 0.12, '1008': 0.108}),"
            " tExact: b.feeEstimateAtTarget({'6': 7, '144': 5, '1008': 1}, 144),"
            " tNear: b.feeEstimateAtTarget({'6': 7, '1008': 1}, 144),"
            " tTie: b.feeEstimateAtTarget({'143': 5, '145': 6}, 144),"
            " tSub1: b.feeEstimateAtTarget({'144': 0.12}, 144),"
            "}));"
        )
        nr = subprocess.run(['node', '-e', node_js], capture_output=True, text=True, cwd=APP, timeout=30)
        try:
            nv = json.loads(nr.stdout.strip())
        except Exception:
            nv = {}
        check('31 unit: 24 hourly observations spanning 23 hours serve no peak (a full day of coverage is required)',
              (nv.get('p24') or {}).get('peak') is None and (nv.get('p24') or {}).get('observations') == 24, nv.get('p24'))
        check('31 unit: 25 hourly observations spanning a full day peak at 2.0 over a 1-day window',
              (nv.get('p25') or {}).get('peak') == 2.0 and (nv.get('p25') or {}).get('windowDays') == 1
              and (nv.get('p25') or {}).get('observations') == 25, nv.get('p25'))
        check('31 unit: 23 observations serve no peak (24-observation minimum)',
              (nv.get('p23') or {}).get('peak') is None and (nv.get('p23') or {}).get('observations') == 23, nv.get('p23'))
        check('31 unit: the peak is a percentile, not the max ([1x22, 2, 2, 10] peaks at 1.6, not 10)',
              abs(((nv.get('pPct') or {}).get('peak') or 0) - 1.6) < 1e-9, nv.get('pPct'))
        check('31 unit: a 3-day span windows at 3 days',
              (nv.get('pWin3') or {}).get('windowDays') == 3, nv.get('pWin3'))
        check('31 unit: a 91-day-old observation is ignored by the peak (23 kept, no peak yet)',
              (nv.get('pOld') or {}).get('observations') == 23 and (nv.get('pOld') or {}).get('peak') is None, nv.get('pOld'))
        check('31 unit: an empty history serves no peak, a 0-day window, 0 observations',
              (nv.get('pEmpty') or {}).get('peak') is None and (nv.get('pEmpty') or {}).get('windowDays') == 0
              and (nv.get('pEmpty') or {}).get('observations') == 0, nv.get('pEmpty'))
        check('31 unit: appending grows the history by one',
              nv.get('a4') == 4, nv)
        check('31 unit: appending to a full 2,160-entry history caps it (oldest dropped)',
              nv.get('aCap') == 2160, nv)
        check('31 unit: appending an invalid fee appends nothing',
              nv.get('aBad') == 1, nv)
        check('31 unit: appending within an hour of the latest observation adds nothing (one observation per hour)',
              nv.get('aDedupe') == 2, nv)
        check('31 unit: the sanitizer keeps only the one clean entry of six dirty ones',
              nv.get('sClean') == 1, nv)
        check('31 unit: Esplora fee-estimates map exactly to the mempool tiers (144, not 6, is the economy tier)',
              nv.get('mFull') == {'fastestFee': 9, 'halfHourFee': 7, 'hourFee': 6, 'economyFee': 5, 'minimumFee': 1}, nv.get('mFull'))
        check('31 unit: a sparse Esplora map with only a 6-block rate maps to null (no substitute tier)',
              nv.get('mSparse') is None, nv.get('mSparse'))
        check('31 unit: a map with 120/168 but no 144 maps to null (nearest is not good enough)',
              nv.get('mNear') is None, nv.get('mNear'))
        check('31 unit: an empty Esplora map maps to null (no economy rate, no data)',
              nv.get('mNull') is None, nv)
        check('31 unit: the 144 target is exact when present, null when absent (no nearest-target fallback, no tie rule)',
              nv.get('tExact') == 5 and nv.get('tNear') is None and nv.get('tTie') is None, nv)
        check('31 unit: sub-1 Esplora rates floor at 1 sat/vB (the relay minimum) — a 0.12 economy rate maps to 1, not 0.12',
              nv.get('mSub1') == {'fastestFee': 1, 'halfHourFee': 1, 'hourFee': 1, 'economyFee': 1, 'minimumFee': 1}, nv.get('mSub1'))
        check('31 unit: feeEstimateAtTarget floors a present sub-1 rate at 1 and still returns null for a missing target',
              nv.get('tSub1') == 1, nv.get('tSub1'))
        # (b) A fresh app records one reading on the startup tick; the
        # peak stays null and the raw history is never served.
        lp_seed_state([])
        app_lp = lp_start()
        check('31 fresh: second app (empty history) up', wait_up(lp_base))
        st = lp_wait_obs(1)
        check('31 fresh: one observation recorded by the startup tick',
              st.get('feePeakObservations') == 1, st.get('feePeakObservations'))
        check('31 fresh: the peak stays null below 24 observations',
              st.get('feePeak') is None, st.get('feePeak'))
        check('31 fresh: one observation spans a 0-day window',
              st.get('feePeakWindowDays') == 0, st.get('feePeakWindowDays'))
        check('31 fresh: the served basis is fee-estimates',
              st.get('feePeakBasis') == 'fee-estimates', st.get('feePeakBasis'))
        check('31 fresh: the served peak time is the observation time (ISO)',
              isinstance(st.get('feePeakAt'), str) and 'T' in st.get('feePeakAt'), st.get('feePeakAt'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 fresh: the observation persists on disk (fee 1, from the primary stub)',
              len(fh) == 1 and fh[0].get('fee') == 1, fh)
        check('31 fresh: the served peak time matches the stored observation',
              len(fh) == 1 and fh[0].get('t') == st.get('feePeakAt'), (fh, st.get('feePeakAt')))
        check('31 fresh: the served state never carries the raw history',
              'feeHistory' not in lp_state(), 'feeHistory' in lp_state())
        # (c) 25 readings at 2.0 spanning exactly 24 hours (from one
        # base time, so the span does not round up to 2 days) serve a
        # 2.0 peak over a 1-day window at boot.
        stop(app_lp)
        seed_base = datetime.now(timezone.utc)
        lp_seed_state([{'t': (seed_base - timedelta(hours=24 - i)).isoformat().replace('+00:00', 'Z'), 'fee': 2.0} for i in range(25)])
        app_lp = lp_start()
        check('31 25th: second app up again', wait_up(lp_base))
        time.sleep(4)  # past the 500 ms startup hourly tick
        st = lp_bitcoin()
        check('31 25th: 25 observations at boot',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        check('31 25th: the peak appears at 2.0 sat/vB',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        check('31 25th: the served window is 1 day',
              st.get('feePeakWindowDays') == 1, st.get('feePeakWindowDays'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 25th: the startup tick adds nothing (latest seed minutes old)',
              len(fh) == 25 and fh[-1].get('fee') == 2.0, fh[-1] if fh else fh)
        # (h) A restart keeps the history but adds nothing (the latest
        # reading is minutes old): restarts cannot fake readings.
        stop(app_lp)
        app_lp = lp_start()
        check('31 restart: second app up after restart', wait_up(lp_base))
        time.sleep(4)  # past the 500 ms startup hourly tick
        st = lp_bitcoin()
        check('31 restart: still 25 observations after the restart startup tick (dedupe: within the hour)',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        check('31 restart: the peak stays 2.0 across the restart',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 restart: the seeded entries survive (first fee still 2.0, 25th is 2.0 — no new observation)',
              len(fh) == 25 and fh[0].get('fee') == 2.0 and fh[-1].get('fee') == 2.0, (len(fh), fh[0] if fh else None, fh[-1] if fh else None))
        # (i) A restore keeps the history and the peak.
        s, bak = req('POST', '/api/backup', {}, base=lp_base)
        check('31 restore: the backup carries the 25-observation history',
              s == 200 and len((bak.get('state', {}) or {}).get('feeHistory') or []) == 25, s)
        s, r = req('POST', '/api/restore', bak, base=lp_base)
        check('31 restore: the round-trip lands (200)', s == 200, (s, r))
        st = lp_bitcoin()
        check('31 restore: the peak survives the restore (25 observations, 2.0)',
              st.get('feePeakObservations') == 25 and st.get('feePeak') == 2.0, (st.get('feePeakObservations'), st.get('feePeak')))
        # (d) Primary dead, secondary at 5: the reading comes from the
        # secondary.
        s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_S)
        check('31 fallback: secondary stub fee set to 5', s == 200 and r.get('economyFee') == 5, (s, r))
        stop(app_lp)
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                      primary='http://127.0.0.1:9', secondary=STUB_BASE_S)
        app_lp = lp_start()
        check('31 fallback: second app (dead primary) up', wait_up(lp_base))
        st = lp_wait_obs(25)
        check('31 fallback: the observation still records with the primary dead',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        check('31 fallback: the peak still appears at 2.0',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 fallback: the recorded observation is the secondary fee (5), not the primary',
              len(fh) == 25 and fh[-1].get('fee') == 5, fh[-1] if fh else fh)
        check('31 fallback: the current fees come from the secondary too (economy 5)',
              lp_wait_current_fee(5), lp_bitcoin().get('currentFees'))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
        check('31 fallback: secondary stub fee restored to 1', s == 200 and r.get('economyFee') == 1, (s, r))
        # (e) Both nodes down: nothing recorded, peak unchanged.
        stop(app_lp)
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                      primary='http://127.0.0.1:9', secondary='http://127.0.0.1:19998')
        open(lp_log, 'w').close()
        app_lp = lp_start()
        check('31 both-fail: second app (both nodes dead) up', wait_up(lp_base))
        time.sleep(4)  # past the 500 ms startup hourly tick
        st = lp_bitcoin()
        check('31 both-fail: still 24 observations after the startup tick (nothing recorded)',
              st.get('feePeakObservations') == 24, st.get('feePeakObservations'))
        check('31 both-fail: the peak stays null with both nodes dead',
              st.get('feePeak') is None, st.get('feePeak'))
        check('31 both-fail: the current fees stay null too (no data, not a guess)',
              st.get('currentFees') is None, st.get('currentFees'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 both-fail: the stored history is untouched (24 entries)',
              len(fh) == 24, len(fh))
        lp_log_text = open(lp_log, errors='ignore').read() if os.path.exists(lp_log) else ''
        check('31 both-fail: the skipped hour is logged',
              'fee-history observation skipped' in lp_log_text, lp_log_text[-500:])
        # (f) Esplora mode: the 144-block rate (3) is the reading;
        # current fees map to the mempool tiers.
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
        check('31 esplora: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 3}, base=STUB_BASE_P)
        check('31 esplora: primary stub economy fee set to 3', s == 200 and r.get('economyFee') == 3, (s, r))
        stop(app_lp)
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)])
        app_lp = lp_start()
        check('31 esplora: second app (esplora primary) up', wait_up(lp_base))
        st = lp_wait_obs(25)
        check('31 esplora: the observation records from the Esplora primary',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 esplora: the recorded observation is the Esplora economy fee (3)',
              len(fh) == 25 and fh[-1].get('fee') == 3, fh[-1] if fh else fh)
        check('31 esplora: the peak is 2.0 (the 24th reading does not move it)',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        check('31 esplora: the current fees map from fee-estimates to the mempool tiers',
              lp_wait_current_fee(3) and (lp_bitcoin().get('currentFees') or {}) == {'fastestFee': 4, 'halfHourFee': 3, 'hourFee': 3, 'economyFee': 3, 'minimumFee': 1},
              lp_bitcoin().get('currentFees'))
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
        check('31 esplora: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
        s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
        check('31 esplora: primary stub economy fee restored to 1', s == 200 and r.get('economyFee') == 1, (s, r))
        # (g) A 91-day-old reading is pruned on load (23 kept plus 1
        # new).
        stop(app_lp)
        old_obs = {'t': iso_ago(days=91), 'fee': 100}
        lp_seed_state([old_obs] + [obs_hours_ago(24 - i, 2.0) for i in range(24)])
        app_lp = lp_start()
        check('31 prune: second app (stale history) up', wait_up(lp_base))
        st = lp_wait_obs(25)
        check('31 prune: 25 observations after load-prune + the new one',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        check('31 prune: the peak is 2.0, not polluted by the 100 sat/vB outlier',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 prune: the 91-day-old entry is gone from the stored history',
              len(fh) == 25 and all(e.get('fee') != 100 for e in fh), [e.get('fee') for e in fh])
        # (j) Stale-state race: hold the fee fetch (4 s delay) and
        # disarm a tx meanwhile; the disarm must survive the recording
        # save and the reading must still land.
        stop(app_lp)
        s, r = req('POST', '/__test__/fee-delay', {'ms': 4000}, base=STUB_BASE_P)
        check('31 race: primary stub fee delay set to 4000 ms', s == 200 and r.get('delayMs') == 4000, (s, r))
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)])
        _, rc0 = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
        race_base_count = (rc0 or {}).get('count') or 0
        app_lp = lp_start()
        check('31 race: second app up', wait_up(lp_base))
        # Wait until a fee request is in flight (the stub counts on
        # receipt), so the edits land before the save.
        fee_in_flight = False
        for _ in range(20):
            try:
                s2, r2 = req('GET', '/__test__/fee-count', base=STUB_BASE_P)
                if s2 == 200 and (r2.get('count') or 0) > race_base_count:
                    fee_in_flight = True
                    break
            except Exception:
                pass
            time.sleep(0.25)
        check('31 race: a fee fetch is in flight', fee_in_flight, fee_in_flight)
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 111900), 'label': 'Race disarm', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}}, base=lp_base)
        check('31 race: the tx is created mid-fetch (201)', s == 201, (s, r))
        race_tx_id = (r or {}).get('tx', {}).get('id')
        check('31 race: the created tx has an id', isinstance(race_tx_id, str) and bool(race_tx_id), race_tx_id)
        s, r = req('PUT', '/api/bitcoin/txs/' + race_tx_id, {'enabled': False}, base=lp_base)
        check('31 race: the tx disarms mid-fetch (200, enabled False)',
              s == 200 and r.get('tx', {}).get('enabled') is False, (s, r))
        mid = lp_bitcoin()
        check('31 race: the observation has not landed yet at edit time (fetch still in flight)',
              (mid.get('feePeakObservations') or 0) < 25, mid.get('feePeakObservations'))
        st = lp_wait_obs(25)
        check('31 race: the observation still lands after the slow fetch',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 race: the recorded observation is the stub economy fee (1)',
              len(fh) == 25 and fh[-1].get('fee') == 1, fh[-1] if fh else fh)
        st = lp_state()
        race_tx_now = [t for t in (st.get('bitcoin', {}) or {}).get('txs', []) if t.get('id') == race_tx_id]
        check('31 race: the mid-fetch disarm survives the recording save',
              len(race_tx_now) == 1 and race_tx_now[0].get('enabled') is False, race_tx_now)
        s, r = req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
        check('31 race: primary stub fee delay cleared', s == 200 and r.get('delayMs') == 0, (s, r))
        # (k) A sparse Esplora map without 144: no economy fee,
        # nothing recorded (the dead secondary cannot mask it).
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
        check('31 sparse: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
        s, r = req('POST', '/__test__/fee-estimates-map', {'map': {'6': 7}}, base=STUB_BASE_P)
        check('31 sparse: primary stub serves a 6-only fee-estimates map', s == 200 and r.get('map') == {'6': 7}, (s, r))
        stop(app_lp)
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                      primary=STUB_BASE_P, secondary='http://127.0.0.1:19998')
        app_lp = lp_start()
        check('31 sparse: second app up', wait_up(lp_base))
        time.sleep(4)  # past the 500 ms startup hourly tick
        st = lp_bitcoin()
        check('31 sparse: still 24 observations after the startup tick (nothing recorded)',
              st.get('feePeakObservations') == 24, st.get('feePeakObservations'))
        check('31 sparse: the peak stays null with no usable 144',
              st.get('feePeak') is None, st.get('feePeak'))
        check('31 sparse: the current fees stay null too (no data, not a guess)',
              st.get('currentFees') is None, st.get('currentFees'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 sparse: the stored history is untouched (24 entries)',
              len(fh) == 24, len(fh))
        s, r = req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
        check('31 sparse: primary stub fee-estimates map restored', s == 200 and r.get('map') is None, (s, r))
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
        check('31 sparse: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
        # (l) Sub-1 Esplora rates (0.12 at 144 blocks) floor to 1
        # everywhere: the reading, the served economy fee and the
        # node-test value.
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'esplora'}, base=STUB_BASE_P)
        check('31 floor: primary stub in esplora mode', s == 200 and r.get('mode') == 'esplora', (s, r))
        sub1_map = {'1': 0.213, '2': 0.213, '3': 0.152, '6': 0.132, '144': 0.12, '1008': 0.108}
        s, r = req('POST', '/__test__/fee-estimates-map', {'map': sub1_map}, base=STUB_BASE_P)
        check('31 floor: primary stub serves the sub-1 fee-estimates map', s == 200 and r.get('map') == sub1_map, (s, r))
        stop(app_lp)
        lp_seed_state([obs_hours_ago(24 - i, 2.0) for i in range(24)],
                      primary=STUB_BASE_P, secondary='http://127.0.0.1:19998')
        app_lp = lp_start()
        check('31 floor: second app up', wait_up(lp_base))
        time.sleep(4)  # past the 500 ms startup hourly tick
        st = lp_bitcoin()
        check('31 floor: 25 observations after the startup tick (one recorded)',
              st.get('feePeakObservations') == 25, st.get('feePeakObservations'))
        fh = (lp_state_file().get('feeHistory') or [])
        check('31 floor: the recorded observation is floored at 1, not 0.12',
              len(fh) == 25 and fh[-1].get('fee') == 1, fh[-1] if fh else fh)
        check('31 floor: the peak stays 2.0 (the floored reading does not distort it)',
              st.get('feePeak') == 2.0, st.get('feePeak'))
        check('31 floor: the served current economy fee is 1, not 0.12',
              lp_wait_current_fee(1), (lp_bitcoin().get('currentFees') or {}))
        conn = (lp_state().get('bitcoin', {}) or {}).get('connection', {}) or {}
        prim = [x for x in (conn.get('results') or []) if x.get('endpoint') == 'primary']
        check('31 floor: the node-test value for the Esplora primary reads 1 sat/vB',
              len(prim) == 1 and ((prim[0].get('checks') or {}).get('fees') or {}).get('value') == '1 sat/vB', prim)
        s, r = req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
        check('31 floor: primary stub fee-estimates map restored', s == 200 and r.get('map') is None, (s, r))
        s, r = req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
        check('31 floor: primary stub back in mempool mode', s == 200 and r.get('mode') == 'mempool', (s, r))
    finally:
        if app_lp is not None:
            stop(app_lp)
        # The stub fee modes and fees are reset either way, so
        # no later section (or suite) reads a doctored node.
        try:
            req('POST', '/__test__/fee-mode', {'mode': 'mempool'}, base=STUB_BASE_P)
            req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
            req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
            req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
            req('POST', '/__test__/fee-estimates-map', {'map': None}, base=STUB_BASE_P)
        except Exception:
            pass
