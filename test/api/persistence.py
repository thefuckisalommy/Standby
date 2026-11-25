"""API suite: Persistence, crash recovery, fsync, heartbeat, follow-ups (sections 20-21, 33-36)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 20. persistence hardening ---
    # (a) Every save keeps state.json.bak; the first save of a day
    # snapshots (kept 7 days); a migration snapshots first. (b) A
    # corrupt or missing state recovers from the newest usable backup
    # and keeps the bad file; with no backup it fails loudly. (c)
    # Startup key-store check and key log lines. The app is stopped
    # before files are edited by hand.
    def state_warnings():
        s, st = req('GET', '/api/state')
        return st.get('warnings', []) if s == 200 else None
    def warning_codes():
        w = state_warnings()
        return [x.get('code') for x in (w or [])]
    def data_files():
        return os.listdir(DATA)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    check('20 warnings: /api/state carries a warnings array',
          isinstance(state_warnings(), list))
    # (a) .bak rotation: a save keeps the previous version.
    st_before = load_state_file()
    s, r = add_tx('20 bak marker', {'type': 'manual', 'params': {}}, 120000)
    check('20 bak: manual tx adds (201)', s == 201, (s, r))
    bak = json.load(open(os.path.join(DATA, 'state.json.bak')))
    check('20 bak: previous version kept (pre-save updatedAt)',
          bak.get('updatedAt') == st_before.get('updatedAt'), (bak.get('updatedAt'), st_before.get('updatedAt')))
    check('20 bak: previous version has no marker tx',
          not any(t.get('label') == '20 bak marker' for t in bak.get('bitcoin', {}).get('txs', [])))
    # (a) Daily snapshot: written once per day; 7-day retention.
    daily_today = os.path.join(DATA, 'state.json.bak.' + today)
    check("20 daily: today's snapshot exists and parses",
          os.path.exists(daily_today) and json.load(open(daily_today)).get('version') == 7)
    # Retention: nine old dailies plus a new day's first save prune to
    # 7.
    for d in ('2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
              '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'):
        open(os.path.join(DATA, 'state.json.bak.' + d), 'w').write('{}\n')
    os.unlink(daily_today)
    s, r = add_tx('20 prune marker', {'type': 'manual', 'params': {}}, 120002)
    check('20 prune: tx adds (201)', s == 201, (s, r))
    dailies = sorted(f for f in data_files() if f.startswith('state.json.bak.20'))
    check('20 prune: 7 daily snapshots kept (today + 6 newest)',
          len(dailies) == 7, dailies)
    check('20 prune: oldest fakes pruned',
          'state.json.bak.2026-11-01' not in dailies and 'state.json.bak.2026-11-03' not in dailies, dailies)
    check("20 prune: today's snapshot re-created",
          os.path.exists(daily_today))
    # (a) Pre-migration snapshot: a legacy settings field is
    # pruned by loadState's migration, which snapshots first.
    stop_app()
    st = load_state_file()
    st['settings']['thresholdDays'] = 35
    save_state_file(st)
    check('20 premig: app restarts with legacy state', restart())
    pm = os.path.join(DATA, 'state.json.pre-migration')
    check('20 premig: snapshot exists and holds the legacy field',
          os.path.exists(pm) and json.load(open(pm)).get('settings', {}).get('thresholdDays') == 35)
    check('20 premig: live state pruned the legacy field',
          'thresholdDays' not in load_state_file().get('settings', {}))
    delete_all_txs()
    # (b) Corrupt state.json -> recovers from .bak.
    s, r = add_tx('20 recover A', {'type': 'manual', 'params': {}}, 120010)
    check('20 recover: tx A adds (201)', s == 201, (s, r))
    s, r = add_tx('20 recover B', {'type': 'manual', 'params': {}}, 120012)
    check('20 recover: tx B adds (201)', s == 201, (s, r))
    stop_app()
    open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
    check('20 recover: app restarts with a corrupt state file', restart())
    s, st = req('GET', '/api/state')
    labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
    check('20 recover: recovered from .bak (A present, B absent)',
          s == 200 and '20 recover A' in labels and '20 recover B' not in labels, labels)
    check('20 recover: warnings carry state-recovered',
          'state-recovered' in warning_codes(), warning_codes())
    corrupt = [f for f in data_files() if f.startswith('state.json.corrupt.')]
    check('20 recover: corrupt file preserved, not deleted',
          len(corrupt) == 1, corrupt)
    # (b) Corrupt state + corrupt .bak -> recovers from daily.
    s, r = add_tx('20 daily marker', {'type': 'manual', 'params': {}}, 120014)
    check('20 daily: marker tx adds (201)', s == 201, (s, r))
    shutil.copy(os.path.join(DATA, 'state.json'), daily_today)
    s, r = add_tx('20 daily marker 2', {'type': 'manual', 'params': {}}, 120016)
    check('20 daily: second tx adds (201)', s == 201, (s, r))
    stop_app()
    open(os.path.join(DATA, 'state.json.bak'), 'w').write('GARBAGE{{{not json\n')
    open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
    check('20 daily: app restarts with corrupt state + corrupt .bak', restart())
    s, st = req('GET', '/api/state')
    labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
    check('20 daily: recovered from daily snapshot (marker present, second absent)',
          s == 200 and '20 daily marker' in labels and '20 daily marker 2' not in labels, labels)
    check('20 daily: warnings carry state-recovered',
          'state-recovered' in warning_codes(), warning_codes())
    # (b) All backups corrupt -> loud failure, NO silent reset.
    good_bytes = open(os.path.join(DATA, 'state.json'), 'rb').read()
    stop_app()
    for f in data_files():
        if f == 'state.json' or f.startswith('state.json.bak'):
            open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
    check('20 noreset: app does NOT come up healthy', not restart())
    s, r = req('GET', '/api/health')
    check('20 noreset: /api/health answers 500 naming the corruption',
          s == 500 and 'corrupt' in str(r).lower(), (s, r))
    s, r = req('GET', '/api/state')
    check('20 noreset: /api/state answers 500, not a default empty state',
          s == 500, (s, r))
    check('20 noreset: corrupt state file left in place, not reset',
          open(os.path.join(DATA, 'state.json'), 'rb').read().startswith(b'GARBAGE'))
    open(os.path.join(DATA, 'state.json'), 'wb').write(good_bytes)
    check('20 noreset: app recovers once a good state file is restored', restart())
    # (b2) A missing state.json with backups recovers from .bak.
    s, r = add_tx('20 missing A', {'type': 'manual', 'params': {}}, 120020)
    check('20 missing: tx A adds (201)', s == 201, (s, r))
    s, r = add_tx('20 missing B', {'type': 'manual', 'params': {}}, 120022)
    check('20 missing: tx B adds (201)', s == 201, (s, r))
    stop_app()
    os.unlink(os.path.join(DATA, 'state.json'))
    check('20 missing: app restarts with state.json deleted', restart())
    s, st = req('GET', '/api/state')
    labels = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
    check('20 missing: recovered from .bak (A present, B absent)',
          s == 200 and '20 missing A' in labels and '20 missing B' not in labels, labels)
    check('20 missing: warnings carry state-missing-recovered',
          'state-missing-recovered' in warning_codes(), warning_codes())
    check('20 missing: state.json written back',
          os.path.exists(os.path.join(DATA, 'state.json')))
    check('20 missing: .bak still on disk',
          os.path.exists(os.path.join(DATA, 'state.json.bak')))
    # (b2) Missing state.json + all backups corrupt -> loud
    # failure, NO silent reset (finding 1's other half).
    good2 = open(os.path.join(DATA, 'state.json'), 'rb').read()
    stop_app()
    for f in data_files():
        if f.startswith('state.json.bak'):
            open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
    os.unlink(os.path.join(DATA, 'state.json'))
    check('20 missing: app does NOT come up healthy (all backups corrupt)', not restart())
    s, r = req('GET', '/api/health')
    check('20 missing: /api/health answers 500 naming the missing state',
          s == 500 and 'missing' in str(r).lower(), (s, r))
    s, r = req('GET', '/api/state')
    check('20 missing: /api/state answers 500, not a default empty state',
          s == 500, (s, r))
    check('20 missing: no state.json created (no silent reset)',
          not os.path.exists(os.path.join(DATA, 'state.json')))
    open(os.path.join(DATA, 'state.json'), 'wb').write(good2)
    check('20 missing: app recovers once a good state file is restored', restart())
    # (c) Startup key sync: state has keys + receiver missing ->
    # rewritten from state.
    s, r = req('POST', '/api/checkin-keys', {'label': '20 sync key'})
    check('20 keys: key creates (201)', s == 201, (s, r))
    sync_id = r['key']['id'] if s == 201 else None
    time.sleep(0.5)
    check('20 keys: create writes a log line',
          ('check-in key created: ' + str(sync_id) + ' (20 sync key)') in read_log())
    stop_app()
    os.unlink(os.path.join(CHECKIN_DIR, 'keys.json'))
    check('20 keys: app restarts with receiver keys.json missing', restart())
    recv_keys = json.load(open(os.path.join(CHECKIN_DIR, 'keys.json')))
    check('20 keys: receiver file rewritten from state',
          [k.get('id') for k in recv_keys.get('keys', [])] == [sync_id], recv_keys)
    check('20 keys: warnings carry receiver-keys-rewritten',
          'receiver-keys-rewritten' in warning_codes(), warning_codes())
    # (c) State empty + receiver has keys -> warning, receiver
    # untouched; the previous version (.bak) also has the key.
    stop_app()
    st = load_state_file()
    st['checkinKeys'] = []
    save_state_file(st)
    recv_before = open(os.path.join(CHECKIN_DIR, 'keys.json'), 'rb').read()
    check('20 keys: app restarts with state keys emptied', restart())
    check('20 keys: receiver file untouched',
          open(os.path.join(CHECKIN_DIR, 'keys.json'), 'rb').read() == recv_before)
    check('20 keys: warnings carry receiver-keys-orphaned',
          'receiver-keys-orphaned' in warning_codes(), warning_codes())
    check('20 keys: warnings name the .bak holding the key',
          any('keys-in-backup' in c for c in warning_codes())
          and any('state.json.bak' in (x.get('message') or '') for x in (state_warnings() or []) if x.get('code') == 'keys-in-backup'),
          warning_codes())
    # (c) State empty + daily backup has keys -> warning names
    # the daily backup; no auto-restore either way.
    s, r = req('POST', '/api/checkin-keys', {'label': '20 daily key'})
    check('20 keys: second key creates (201)', s == 201, (s, r))
    shutil.copy(os.path.join(DATA, 'state.json'), daily_today)
    stop_app()
    st = load_state_file()
    st['checkinKeys'] = []
    save_state_file(st)
    open(os.path.join(CHECKIN_DIR, 'keys.json'), 'w').write('{"keys": []}\n')
    check('20 keys: app restarts with state + receiver both keyless', restart())
    w = state_warnings() or []
    check('20 keys: warnings name the daily backup holding the key',
          any(x.get('code') == 'keys-in-backup' and ('state.json.bak.' + today) in (x.get('message') or '') for x in w), w)
    s, st = req('GET', '/api/state')
    check('20 keys: no auto-restore — state stays keyless',
          s == 200 and st.get('checkinKeys') == [], st.get('checkinKeys'))
    check('20 keys: no auto-restore — receiver stays keyless',
          json.load(open(os.path.join(CHECKIN_DIR, 'keys.json'))).get('keys') == [])
    # (d) Revoke writes a log line; tidy up the test keys.
    s, r = req('POST', '/api/checkin-keys', {'label': '20 log key'})
    check('20 keys: log-test key creates (201)', s == 201, (s, r))
    log_id = r['key']['id'] if s == 201 else None
    s, r = req('DELETE', '/api/checkin-keys/' + str(log_id))
    check('20 keys: log-test key revokes (200)', s == 200, (s, r))
    time.sleep(0.5)
    check('20 keys: revoke writes a log line',
          ('check-in key revoked: ' + str(log_id)) in read_log())
    # (b2) No state and no backups: a genuine first boot (a second
    # instance proves it).
    fresh_data = TMP + '/standby-test099-fresh'
    fresh_checkin = TMP + '/standby-test099-fresh-checkin'
    shutil.rmtree(fresh_data, ignore_errors=True)
    shutil.rmtree(fresh_checkin, ignore_errors=True)
    check('20 fresh: port 3458 free', port_closed(3458))
    fresh_env = dict(APP_ENV)
    fresh_env.update({'PORT': '3458', 'DATA_DIR': fresh_data, 'CHECKIN_DIR': fresh_checkin})
    fresh_base = 'http://127.0.0.1:3458'
    fresh_app = start(['node', 'server.js'], env=fresh_env, cwd=APP, log=LOG)
    check('20 fresh: second instance comes up', wait_up(fresh_base))
    s, st = req('GET', '/api/state', base=fresh_base)
    check('20 fresh: default state (version 7, no txs)',
          s == 200 and st.get('version') == 7 and st.get('bitcoin', {}).get('txs') == [],
          (s, st.get('version') if s == 200 else st))
    s, st = req('GET', '/api/state', base=fresh_base)
    check('20 fresh: no recovery warning on first boot',
          s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
    check('20 fresh: no backup files on disk',
          not any(f.startswith('state.json.bak') for f in os.listdir(fresh_data)), os.listdir(fresh_data))
    stop(fresh_app)
    # (b2) With state and every backup corrupt the app answers 500s,
    # but restore and reset still work.
    s, backup_doc = req('POST', '/api/backup', {})
    check('20 rescue: backup downloads before breaking (200)',
          s == 200 and backup_doc.get('format') == 'standby-backup'
          and isinstance(backup_doc.get('state'), dict), (s, backup_doc.get('format')))
    labels_before = [t.get('label') for t in
                     (backup_doc.get('state', {}).get('bitcoin', {}) or {}).get('txs', [])]
    # (a) Restore while broken.
    stop_app()
    open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
    for f in data_files():
        if f.startswith('state.json.bak'):
            open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
    check('20 rescue: app does NOT come up healthy (corrupt state + corrupt backups)', not restart())
    s, r = req('POST', '/api/restore', backup_doc)
    check('20 rescue: restore works while broken (200)',
          s == 200 and r.get('ok') is True, (s, r))
    s, st = req('GET', '/api/state')
    labels_after = [t.get('label') for t in st.get('bitcoin', {}).get('txs', [])]
    check('20 rescue: state healthy again with the same txs',
          s == 200 and labels_after == labels_before, (s, labels_after))
    check('20 rescue: warnings cleared by the restore',
          s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
    # (c) An invalid backup while broken -> 400, still broken.
    stop_app()
    open(os.path.join(DATA, 'state.json'), 'w').write('GARBAGE{{{not json\n')
    for f in data_files():
        if f.startswith('state.json.bak'):
            open(os.path.join(DATA, f), 'w').write('GARBAGE{{{not json\n')
    check('20 rescue: app broken again for the invalid-restore check', not restart())
    s, r = req('POST', '/api/restore', {'format': 'standby-backup', 'version': 1, 'state': {}})
    check('20 rescue: invalid backup rejected while broken (400)',
          s == 400, (s, r))
    s, r = req('GET', '/api/state')
    check('20 rescue: still broken after the rejected restore',
          s == 500, (s, r))
    # (b) Reset while broken.
    s, r = req('POST', '/api/state/reset', {})
    check('20 rescue: reset without confirm rejected (400)',
          s == 400, (s, r))
    s, r = req('GET', '/api/state')
    check('20 rescue: still broken after the rejected reset',
          s == 500, (s, r))
    # Plant a pre-migration snapshot + a preserved corrupt file:
    # the reset must remove those too, not just .bak files.
    open(os.path.join(DATA, 'state.json.pre-migration'), 'w').write('{}\n')
    open(os.path.join(DATA, 'state.json.corrupt.2026-01-01T00-00-00-000Z'), 'w').write('GARBAGE\n')
    # Plant a stale receiver check-in: the reset must drop it too.
    json.dump({'lastCheckinAt': '2026-11-17T21:48:49.883Z', 'keyId': 'key_test'},
              open(os.path.join(CHECKIN_DIR, 'last.json'), 'w'))
    s, r = req('POST', '/api/state/reset', {'confirm': True})
    check('20 rescue: reset with confirm succeeds (200)',
          s == 200 and r.get('ok') is True, (s, r))
    s, st = req('GET', '/api/state')
    check('20 rescue: fresh default state after reset (version 7, no txs)',
          s == 200 and st.get('version') == 7 and st.get('bitcoin', {}).get('txs') == [],
          (s, st.get('version') if s == 200 else st))
    check('20 rescue: no state backup files remain after reset',
          not any(f.startswith('state.json.bak') or f.startswith('state.json.corrupt')
                  or f == 'state.json.pre-migration' for f in data_files()),
          data_files())
    check('20 rescue: state.json exists again after reset',
          os.path.exists(os.path.join(DATA, 'state.json')))
    check('20 rescue: receiver keys cleared by the reset',
          json.load(open(os.path.join(CHECKIN_DIR, 'keys.json'))).get('keys') == [])
    check('20 rescue: warnings cleared by the reset',
          s == 200 and st.get('warnings') == [], (s, st.get('warnings') if s == 200 else st))
    check('20 rescue: receiver last.json dropped by the reset',
          not os.path.exists(os.path.join(CHECKIN_DIR, 'last.json')))
    s, st = req('GET', '/api/state')
    check('20 rescue: no resurrected check-in clock after reset',
          s == 200 and st.get('checkin', {}).get('lastCheckinAt') is None
          and st.get('checkin', {}).get('totalCheckins') == 0,
          (s, st.get('checkin') if s == 200 else st))

    # --- 21. crash recovery, receiver auth, untested endpoints ---
    # The §20 reset restored the default nodes; point them back at the
    # stubs.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:18235',
                                        'secondaryApiUrl': 'http://127.0.0.1:18236'})
    check('21 crash: node urls re-pointed at the stubs after the §20 reset', s == 200, (s, r))
    # (a) Broadcast-then-crash: the node accepted the tx but the
    # record was never written. The dry run's own-txid check must heal
    # it to broadcast, never stale. Simulated by stripping the record
    # and restarting the stubs with STUB_OWN_SPEND_TXID.
    crash_hex = v.craft_prev('ee' * 32, 0, 121000)
    crash_txid = v.txid_of(crash_hex)
    s, r = req('POST', '/api/bitcoin/txs',
               {'txHex': crash_hex, 'label': '21 crash', 'notes': '',
                'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}},
                'triggerConfirmed': True})
    check('21 crash: own-spend tx adds with confirmation (201)', s == 201, (s, r))
    crash_id = r['tx']['id'] if s == 201 else None
    check('21 crash: crafted txid is the one the stubs will report', crash_txid == (r.get('tx') or {}).get('txid'), (crash_txid, r))
    s, r, by_id = release_results()
    check('21 crash: release check broadcasts it',
          s == 200 and by_id.get(crash_id, {}).get('action') == 'broadcast', (s, by_id.get(crash_id)))
    t = state_tx(crash_id)
    check('21 crash: broadcasted fact + broadcast release recorded',
          t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast', t)
    # The crash: stop the app, strip the record the crash lost.
    stop_app()
    stj = load_state_file()
    for tx in stj.get('bitcoin', {}).get('txs', []):
        if tx.get('id') == crash_id:
            tx.pop('broadcasted', None)
            tx['release'] = None
            tx['history'] = [e for e in (tx.get('history') or []) if e.get('type') != 'broadcast']
    save_state_file(stj)
    # The trigger no longer holds: stub price below the threshold
    # on both stubs (agreement still holds).
    s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_P)
    check('21 crash: stub price lowered (primary)', s == 200, (s, r))
    s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_S)
    check('21 crash: stub price lowered (secondary)', s == 200, (s, r))
    check('21 crash: app restarts after the crash', restart())
    t = state_tx(crash_id)
    check('21 crash: after restart the tx is unrecorded, not stale',
          t and not t.get('broadcasted') and (t.get('release') or {}).get('status') != 'stale', t)
    s, r, by_id = release_results()
    check('21 crash: release check does not fire it (trigger no longer holds)',
          s == 200 and by_id.get(crash_id, {}).get('action') == 'skipped', (s, by_id.get(crash_id)))
    t = state_tx(crash_id)
    check('21 crash: the skipped release check leaves it un-staled',
          t and (t.get('release') or {}).get('status') != 'stale', t)
    # Point the stubs at our own txid. The restart resets the stub
    # price, so lower it first (else the tick would re-fire the tx and
    # heal it through the broadcast path).
    restart_stubs(own=crash_txid)
    s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_P)
    check('21 crash: stub price lowered again after the restart (primary)', s == 200, (s, r))
    s, r = req('POST', '/__test__/price', {'usd': 80000}, base=STUB_BASE_S)
    check('21 crash: stub price lowered again after the restart (secondary)', s == 200, (s, r))
    # The startup freshness check cached the pre-restart stub answer;
    # clear the outspend cache so the dry run sees the stub's new
    # answer.
    s, r = req('POST', '/api/__test__/clear-caches', {'only': ['outspend']})
    check('21 crash: outspend cache cleared so the dry run sees the stub restart', s == 200, (s, r))
    s, r = req('POST', '/api/broadcast/test', {})
    check('21 crash: dry run runs (200)', s == 200, (s, r))
    drv = [x for x in (r.get('results') or []) if x.get('id') == crash_id]
    check('21 crash: dry run verdict is broadcast (own anchor)',
          len(drv) == 1 and drv[0].get('verdict') == 'broadcast', drv)
    check('21 crash: the own-spend entry names our own txid',
          len(drv) == 1 and (drv[0].get('own') or [{}])[0].get('spentBy') == crash_txid, drv[0].get('own') if drv else drv)
    t = state_tx(crash_id)
    check('21 crash: dry run heals it to broadcast, never stale',
          t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast', t)
    # Pristine stubs again for the remaining sections.
    restart_stubs()
    s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    check('21 crash: stub price restored (primary)', s == 200, (s, r))
    s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_S)
    check('21 crash: stub price restored (secondary)', s == 200, (s, r))

    # (b) Receiver auth: create a key, check in with it, revoke it.
    s, r = req('POST', '/api/checkin-keys', {'label': '21 auth'})
    check('21 auth: key creates (201)', s == 201, (s, r))
    key_plain = r.get('plain') if s == 201 else None
    key_id = (r.get('key') or {}).get('id') if s == 201 else None
    check('21 auth: create returns the plaintext once', bool(key_plain) and bool(key_id), r)
    s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
    check('21 auth: valid key checks in (200)', s == 200 and r.get('ok') is True, (s, r))
    try:
        _last = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))
    except Exception:
        _last = {}
    check('21 auth: last.json written with the key id',
          _last.get('keyId') == key_id, _last)
    s, r = req('POST', '/checkin', {}, base=RBASE, headers={'X-Api-Key': key_plain or ''})
    check('21 auth: X-Api-Key header also works (200)', s == 200 and r.get('ok') is True, (s, r))
    s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer badkey-123'})
    check('21 auth: unknown key rejected (401)', s == 401, (s, r))
    s, r = req('POST', '/checkin', {}, base=RBASE)
    check('21 auth: missing key rejected (401)', s == 401, (s, r))
    s, r = req('DELETE', '/api/checkin-keys/' + (key_id or 'none'), base=BASE)
    check('21 auth: key revokes (200)', s == 200, (s, r))
    s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
    check('21 auth: revoked key rejected (401)', s == 401, (s, r))
    s, keys = req('GET', '/api/checkin-keys')
    if isinstance(keys, list) and not keys:
        s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer anything'})
        check('21 auth: no keys configured rejects any key (401)', s == 401, (s, r))

    # (c) Endpoints never asserted before: GET /api/checkins, GET
    # /api/broadcast/log, POST /api/bitcoin/txs/preview, and the CSRF
    # gate.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('21 log: app check-in succeeds (200)', s == 200, (s, r))
    s, r = req('GET', '/api/checkins')
    check('21 log: check-ins list the app check-in',
          isinstance(r, list) and any(e.get('method') == 'app' and isinstance(e.get('ts'), str) for e in r), r)
    s, r = req('GET', '/api/broadcast/log')
    check('21 log: broadcast log lists the dry run',
          isinstance(r, list) and any(e.get('kind') == 'dry-run' for e in r), r)
    s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'hex', 'data': craft(1, 121001)})
    check('21 preview: valid hex previews (200 + txid)',
          s == 200 and r.get('txid') == txid_of(craft(1, 121001)), (s, r))
    s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'hex', 'data': 'zzzz'})
    check('21 preview: bad hex rejected (400)', s == 400, (s, r))
    s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'bogus', 'data': '00'})
    check('21 preview: bad format rejected (400)', s == 400, (s, r))
    s, r = req('POST', '/api/bitcoin/txs/preview', {'format': 'psbt', 'data': 'not a psbt'})
    check('21 preview: bad psbt rejected (400)', s == 400, (s, r))
    # CSRF: a POST without a JSON content type is 403 (raw urllib;
    # req() always sends JSON).
    import urllib.request as _urlreq
    import urllib.error as _urlerr
    try:
        _rq = _urlreq.Request(BASE + '/api/checkin', method='POST', data=b'{}')
        with _urlreq.urlopen(_rq, timeout=20) as _resp:
            _cs = _resp.status
    except _urlerr.HTTPError as _e:
        _cs = _e.code
    check('21 csrf: non-JSON POST rejected (403)', _cs == 403, _cs)
    delete_all_txs()

    # --- 33. Host allowlist + fsync ---
    # A foreign Host is a DNS-rebinding probe: 421 on both servers
    # before routing or auth. IP literals, localhost and *.local pass;
    # a missing Host fails; the machine's own hostname needs
    # STANDBY_ALLOWED_HOSTS.
    s, body = raw_req('GET', '/api/health', BASE, host='evil.example')
    check('33 hosts: foreign Host gets 421 on the app',
          s == 421 and body == b'Unrecognised Host header', (s, body))
    s, body = raw_req('GET', '/health', RBASE, host='evil.example')
    check('33 hosts: foreign Host gets 421 on the receiver',
          s == 421 and body == b'Unrecognised Host header', (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host='127.0.0.1:3438')
    check('33 hosts: IP literal Host passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host='umbrel.local')
    check('33 hosts: umbrel.local passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host=platform.node().lower())
    check('33 hosts: machine hostname is rejected without an allowlist (0.8.11)',
          s == 421 and body == b'Unrecognised Host header', (s, body))
    check('33 hosts: missing Host header is rejected',
          raw_socket_status(b'GET /api/health HTTP/1.0\r\n\r\n', BASE) == 421)
    check('33 hosts: startup log names the allowed Hosts',
          'Standby allowed Hosts: any IP literal, localhost, *.local' in read_log(),
          read_log()[-500:])
    # STANDBY_ALLOWED_HOSTS: a second instance with two extra names.
    # They pass, others still 421, IP literals still pass.
    extra_data = TMP + '/standby-test099-extra'
    extra_checkin = TMP + '/standby-test099-extra-checkin'
    shutil.rmtree(extra_data, ignore_errors=True)
    shutil.rmtree(extra_checkin, ignore_errors=True)
    check('33 hosts: port 3440 free', port_closed(3440))
    extra_env = dict(APP_ENV)
    extra_env.update({'PORT': '3440', 'DATA_DIR': extra_data, 'CHECKIN_DIR': extra_checkin,
                      'STANDBY_ALLOWED_HOSTS': 'extra.ts.net, custom.example'})
    extra_base = 'http://127.0.0.1:3440'
    extra_app = start(['node', 'server.js'], env=extra_env, cwd=APP, log=LOG)
    check('33 hosts: STANDBY_ALLOWED_HOSTS instance comes up', wait_up(extra_base))
    s, body = raw_req('GET', '/api/health', extra_base, host='extra.ts.net')
    check('33 hosts: STANDBY_ALLOWED_HOSTS name passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', extra_base, host='custom.example')
    check('33 hosts: second STANDBY_ALLOWED_HOSTS name passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', extra_base, host='other.example')
    check('33 hosts: a name not in STANDBY_ALLOWED_HOSTS is rejected',
          s == 421, (s, body))
    s, body = raw_req('GET', '/api/health', extra_base, host='127.0.0.1:3440')
    check('33 hosts: IP literal still passes with STANDBY_ALLOWED_HOSTS set',
          s == 200, (s, body))
    stop(extra_app)
    # X-Forwarded-Host is not trusted: a matching Origin smuggled via
    # XFH fails the CSRF gate; a genuine matching Origin passes.
    s, body = raw_req('POST', '/api/checkin', BASE, host='127.0.0.1:3438',
                      headers={'Origin': 'https://evil.example',
                               'X-Forwarded-Host': 'evil.example',
                               'Content-Type': 'application/json'},
                      body=b'{"method": "app"}')
    check('33 hosts: spoofed X-Forwarded-Host no longer bypasses the CSRF gate',
          s == 403, (s, body))
    s, r = req('POST', '/api/checkin', {'method': 'app'},
               headers={'Origin': 'http://127.0.0.1:3438'})
    check('33 hosts: a matching Origin still passes the CSRF gate',
          s == 200, (s, r))
    # (fsync) A saved value round-trips to disk, the file loads, no
    # .tmp is left. Cadence back to 60 after.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 33})
    check('33 fsync: settings save succeeds (200)', s == 200, (s, r))
    check('33 fsync: no state.json.tmp left behind',
          not os.path.exists(os.path.join(DATA, 'state.json.tmp')),
          os.listdir(DATA))
    _saved = {}
    try:
        _saved = load_state_file()
    except Exception:
        pass
    check('33 fsync: saved value round-trips through state.json',
          _saved.get('settings', {}).get('checkCadenceSeconds') == 33,
          _saved.get('settings', {}).get('checkCadenceSeconds'))
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('33 fsync: cadence restored to 60 (200)', s == 200, (s, r))
    # (fsync, receiver) A check-in writes last.json durably:
    # the file parses with the key id, and no .tmp is left.
    s, r = req('POST', '/api/checkin-keys', {'label': '33 fsync'})
    check('33 fsync: key creates (201)', s == 201, (s, r))
    key_plain = r.get('plain') if s == 201 else None
    key_id = (r.get('key') or {}).get('id') if s == 201 else None
    s, r = req('POST', '/checkin', {}, base=RBASE, headers={'Authorization': 'Bearer ' + (key_plain or '')})
    check('33 fsync: receiver check-in succeeds (200)', s == 200 and r.get('ok') is True, (s, r))
    try:
        _last = json.load(open(os.path.join(CHECKIN_DIR, 'last.json')))
    except Exception:
        _last = {}
    check('33 fsync: last.json written with the key id',
          _last.get('keyId') == key_id, _last)
    check('33 fsync: no last.json.tmp left behind',
          not os.path.exists(os.path.join(CHECKIN_DIR, 'last.json.tmp')),
          os.listdir(CHECKIN_DIR))
    check('33 fsync: no keys.json.tmp left behind',
          not os.path.exists(os.path.join(CHECKIN_DIR, 'keys.json.tmp')),
          os.listdir(CHECKIN_DIR))
    s, r = req('DELETE', '/api/checkin-keys/' + (key_id or 'none'), base=BASE)
    check('33 fsync: key revokes (200)', s == 200, (s, r))

    # --- 34. skip-save + heartbeat ---
    # (a) Quiet ticks write nothing: two full ticks with fixed stub
    # values leave state.json byte-identical and the heartbeat
    # untouched within its 5-minute throttle.
    delete_all_txs()
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('34 quiet: cadence set to 10 s', s == 200, (s, r))
    s, r = add_tx('34 quiet price', {'type': 'price', 'params': {'op': '>=', 'value': 200000}}, 121000, trigger_confirmed=True)
    check('34 quiet: watching price tx adds (201)', s == 201, (s, r))
    q34 = r['tx']['id'] if s == 201 else None
    check('34 quiet: one tick evaluates it (slice watching)',
          wait_slice(q34, {'status': 'watching'}), rule_slice(state_tx(q34)) if q34 else None)
    s, st = req('GET', '/api/state')
    check('34 quiet: no pending external check-in before the snapshot', s == 200, (s, r))
    before_bytes = open(os.path.join(DATA, 'state.json'), 'rb').read()
    before_mtime = os.path.getmtime(os.path.join(DATA, 'state.json'))
    hb_before = json.load(open(os.path.join(DATA, 'heartbeat.json')))
    hb_mtime_before = os.path.getmtime(os.path.join(DATA, 'heartbeat.json'))
    time.sleep(25)
    check('34 quiet: state.json byte-identical across two ticks',
          open(os.path.join(DATA, 'state.json'), 'rb').read() == before_bytes)
    check('34 quiet: state.json mtime untouched across two ticks',
          os.path.getmtime(os.path.join(DATA, 'state.json')) == before_mtime,
          (before_mtime, os.path.getmtime(os.path.join(DATA, 'state.json'))))
    check('34 quiet: heartbeat unrewritten inside its throttle',
          os.path.getmtime(os.path.join(DATA, 'heartbeat.json')) == hb_mtime_before
          and json.load(open(os.path.join(DATA, 'heartbeat.json'))) == hb_before)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('34 quiet: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()
    # (b) A grace activation still writes (clock backdated 10 days,
    # heartbeat and last.json dropped).
    s, r = add_tx('34 gap checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 121002)
    check('34 grace: gap check-in tx adds (201)', s == 201, (s, r))
    seed_mtime = []
    def seed_gap_34():
        try:
            os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
        except OSError:
            pass
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=20)
        stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
        save_state_file(stj)  # also drops heartbeat.json
        seed_mtime.append(os.path.getmtime(os.path.join(DATA, 'state.json')))
    check('34 grace: app restarted with a 10-day gap', restart(before_start=seed_gap_34))
    s, st = req('GET', '/api/state')
    check('34 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    gap_file = load_state_file()
    check('34 grace: activation persisted to state.json (graceUntil set)',
          isinstance((gap_file.get('grace') or {}).get('graceUntil'), str), gap_file.get('grace'))
    check('34 grace: state.json mtime advanced on the activation',
          seed_mtime and os.path.getmtime(os.path.join(DATA, 'state.json')) > seed_mtime[0],
          (seed_mtime, os.path.getmtime(os.path.join(DATA, 'state.json'))))
    # (c) The heartbeat advances across a restart, and the
    # served lastOnlineAt is the merged heartbeat value.
    hb1 = json.load(open(os.path.join(DATA, 'heartbeat.json')))
    check('34 heartbeat: heartbeat exists with a recent value after the gap restart',
          isinstance(hb1.get('lastOnlineAt'), str)
          and abs((datetime.now(timezone.utc) - datetime.fromisoformat(hb1['lastOnlineAt'].replace('Z', '+00:00'))).total_seconds()) < 120, hb1)
    check('34 heartbeat: app restarted', restart())
    hb2 = json.load(open(os.path.join(DATA, 'heartbeat.json')))
    check('34 heartbeat: heartbeat advances across a restart',
          isinstance(hb2.get('lastOnlineAt'), str) and hb2['lastOnlineAt'] > hb1['lastOnlineAt'], (hb1, hb2))
    s, st = req('GET', '/api/state')
    check('34 heartbeat: served lastOnlineAt is the merged heartbeat value',
          st.get('checkin', {}).get('lastOnlineAt') == hb2['lastOnlineAt'],
          (st.get('checkin', {}).get('lastOnlineAt'), hb2))
    s, r = req('POST', '/api/grace/resume', {})
    check('34 grace: resumed after the checks', s == 200, (s, r))
    delete_all_txs()
    # (d) SIGTERM flush: a fresh instance with its heartbeat deleted
    # must recreate it on SIGTERM and exit 0.
    sig_data = TMP + '/standby-test099-sigterm'
    sig_checkin = TMP + '/standby-test099-sigterm-checkin'
    shutil.rmtree(sig_data, ignore_errors=True)
    shutil.rmtree(sig_checkin, ignore_errors=True)
    check('34 sigterm: port 3440 free', port_closed(3440))
    sig_env = dict(APP_ENV)
    sig_env.update({'PORT': '3440', 'DATA_DIR': sig_data, 'CHECKIN_DIR': sig_checkin})
    sig_base = 'http://127.0.0.1:3440'
    # Windows has no SIGTERM; Ctrl+Break (SIGBREAK) is its stand-in.
    sig_name = 'SIGBREAK' if os.name == 'nt' else 'SIGTERM'
    sig_app = start(['node', 'server.js'], env=sig_env, cwd=APP, log=LOG, signal_group=True)
    check('34 sigterm: instance comes up', wait_up(sig_base))
    try:
        os.remove(os.path.join(sig_data, 'heartbeat.json'))
    except OSError:
        pass
    sig_app.send_signal(signal.CTRL_BREAK_EVENT if os.name == 'nt' else signal.SIGTERM)
    try:
        sig_code = sig_app.wait(timeout=5)
    except subprocess.TimeoutExpired:
        sig_code = None
        stop(sig_app)
    check('34 sigterm: process exits 0 on ' + sig_name, sig_code == 0, sig_code)
    try:
        hb_sig = json.load(open(os.path.join(sig_data, 'heartbeat.json')))
        hb_sig_at = hb_sig.get('lastOnlineAt')
    except Exception:
        hb_sig_at = None
    check('34 sigterm: ' + sig_name + ' flush lands the heartbeat',
          isinstance(hb_sig_at, str)
          and abs((datetime.now(timezone.utc) - datetime.fromisoformat(hb_sig_at.replace('Z', '+00:00'))).total_seconds()) < 30, hb_sig_at)
    # (e) A missing or corrupt heartbeat falls back to the state's
    # lastOnlineAt; tested directly against lib/store.js (a running
    # server rewrites the heartbeat). Also the save dedupe.
    hb_dir = TMP + '/standby-test099-heartbeat'
    shutil.rmtree(hb_dir, ignore_errors=True)
    os.makedirs(hb_dir)
    hb_seed = load_state_file()
    hb_seed['checkin']['lastOnlineAt'] = iso_ago(days=2)
    json.dump(hb_seed, open(os.path.join(hb_dir, 'state.json'), 'w'), indent=2)
    open(os.path.join(hb_dir, 'heartbeat.json'), 'w').write('{not json')

    def node_out(script):
        rr = subprocess.run(['node', '-e', script], cwd=APP, capture_output=True, text=True, timeout=20)
        return rr.stdout.strip(), rr.stderr.strip()
    node_load = ("const s=require('./lib/store');"
                 "console.log(s.loadState(%s).checkin.lastOnlineAt);" % json.dumps(hb_dir))
    out, err = node_out(node_load)
    check('34 fallback: corrupt heartbeat falls back to state.lastOnlineAt',
          out == hb_seed['checkin']['lastOnlineAt'], out + err)
    os.remove(os.path.join(hb_dir, 'heartbeat.json'))
    out, err = node_out(node_load)
    check('34 fallback: missing heartbeat falls back to state.lastOnlineAt',
          out == hb_seed['checkin']['lastOnlineAt'], out + err)
    hb_new = iso_ago(minutes=5)
    json.dump({'lastOnlineAt': hb_new}, open(os.path.join(hb_dir, 'heartbeat.json'), 'w'))
    out, err = node_out(node_load)
    check('34 fallback: newer heartbeat wins the merge', out == hb_new, out + err)
    hb_old = iso_ago(days=3)
    json.dump({'lastOnlineAt': hb_old}, open(os.path.join(hb_dir, 'heartbeat.json'), 'w'))
    out, err = node_out(node_load)
    check('34 fallback: older heartbeat loses to state.lastOnlineAt',
          out == hb_seed['checkin']['lastOnlineAt'], out + err)
    node_dedupe = ("const fs=require('fs');const s=require('./lib/store');"
                   "const d=%s;const st=s.loadState(d);"
                   "s.saveState(d, st);const m1=fs.statSync(d+'/state.json').mtimeMs;"
                   "s.saveState(d, st);const m2=fs.statSync(d+'/state.json').mtimeMs;"
                   "st.settings.checkCadenceSeconds=61;s.saveState(d, st);"
                   "const m3=fs.statSync(d+'/state.json').mtimeMs;"
                   "console.log(m1===m2 ? 'SKIP' : 'WROTE', m3>m2 ? 'WROTE-ON-CHANGE' : 'NO-WRITE');"
                   % json.dumps(hb_dir))
    out, err = node_out(node_dedupe)
    check('34 dedupe: identical save skips, a real change writes',
          out == 'SKIP WROTE-ON-CHANGE', out + err)
    # The save cache must not survive an out-of-band edit: write a
    # grace straight to the file, then save the cached cleared grace
    # through saveState; the mtime and size check must force the
    # write.
    node_oob = ("const fs=require('fs');const s=require('./lib/store');"
                "const d=%s;const st=s.loadState(d);"
                "st.grace={graceUntil:null,triggeredAt:null,offlineGapDays:null};"
                "s.saveState(d, st);const m1=fs.statSync(d+'/state.json').mtimeMs;"
                "s.saveState(d, st);const m2=fs.statSync(d+'/state.json').mtimeMs;"
                "const oob=s.loadState(d);"
                "oob.grace={graceUntil:null,triggeredAt:new Date().toISOString(),offlineGapDays:12};"
                "fs.writeFileSync(d+'/state.json', JSON.stringify(oob, null, 2)+'\\n');"
                "const back=s.loadState(d);"
                "back.grace={graceUntil:null,triggeredAt:null,offlineGapDays:null};"
                "s.saveState(d, back);const m3=fs.statSync(d+'/state.json').mtimeMs;"
                "console.log(m1===m2 ? 'SKIP' : 'WROTE', m3>m2 ? 'WROTE-AFTER-OOB' : 'SKIPPED-AFTER-OOB');"
                % json.dumps(hb_dir))
    out, err = node_out(node_oob)
    check('34 dedupe: an out-of-band edit invalidates the cache (Resume-after-seed writes)',
          out == 'SKIP WROTE-AFTER-OOB', out + err)

    # --- 35. follow-ups ---
    # (a) A future-dated heartbeat must not suppress a grace: an
    # 8-day-old state stamp with a heartbeat 2 days ahead must still
    # activate it.
    s, r = add_tx('35 future heartbeat', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 121004)
    check('35 clamp: gap check-in tx adds (201)', s == 201, (s, r))
    def seed_future_hb_35():
        try:
            os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
        except OSError:
            pass
        stj = load_state_file()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=20)
        stj['checkin']['lastOnlineAt'] = iso_ago(days=8)
        save_state_file(stj)  # also drops heartbeat.json
        json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(DATA, 'heartbeat.json'), 'w'))
    check('35 clamp: app restarted with a future heartbeat over an 8-day gap', restart(before_start=seed_future_hb_35))
    s, st = req('GET', '/api/state')
    check('35 clamp: the grace is active despite the future heartbeat', st.get('grace', {}).get('active') is True, st.get('grace'))
    check('35 clamp: served lastOnlineAt is not the future stamp',
          isinstance(st.get('checkin', {}).get('lastOnlineAt'), str)
          and st['checkin']['lastOnlineAt'] <= iso_in(minutes=6),
          st.get('checkin', {}).get('lastOnlineAt'))
    s, r = req('POST', '/api/grace/resume', {})
    check('35 clamp: resumed after the checks', s == 200, (s, r))
    delete_all_txs()
    # (b) The clamp, on lib/store.js directly: a future heartbeat is
    # ignored, a future state stamp capped, both together capped.
    cl_dir = TMP + '/standby-test099-clamp'
    shutil.rmtree(cl_dir, ignore_errors=True)
    os.makedirs(cl_dir)
    cl_seed = load_state_file()
    cl_seed['checkin']['lastOnlineAt'] = iso_ago(days=8)
    cl_seed['grace'] = {'graceUntil': None, 'triggeredAt': None, 'offlineGapDays': None}
    json.dump(cl_seed, open(os.path.join(cl_dir, 'state.json'), 'w'), indent=2)
    json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(cl_dir, 'heartbeat.json'), 'w'))
    node_load = ("const s=require('./lib/store');"
                 "console.log(s.loadState(%s).checkin.lastOnlineAt);" % json.dumps(cl_dir))
    out, err = node_out(node_load)
    check('35 clamp: future heartbeat ignored, state stamp stands',
          out == cl_seed['checkin']['lastOnlineAt'], out + err)
    node_grace = ("const s=require('./lib/store');const c=require('./lib/checkin');"
                  "const d=%s;const st=s.loadState(d);"
                  "console.log(c.applyGrace(st, new Date()) ? 'GRACE' : 'NO-GRACE');"
                  % json.dumps(cl_dir))
    out, err = node_out(node_grace)
    check('35 clamp: grace activates on the merged 8-day gap', out == 'GRACE', out + err)
    cl_seed['checkin']['lastOnlineAt'] = iso_in(days=1)
    json.dump(cl_seed, open(os.path.join(cl_dir, 'state.json'), 'w'), indent=2)
    os.remove(os.path.join(cl_dir, 'heartbeat.json'))
    out, err = node_out(node_load)
    try:
        _cap = datetime.fromisoformat(out.replace('Z', '+00:00'))
    except Exception:
        _cap = None
    check('35 clamp: future state stamp capped at now + 5 minutes',
          _cap is not None and datetime.now(timezone.utc) < _cap <= datetime.now(timezone.utc) + timedelta(minutes=6),
          out + err)
    json.dump({'lastOnlineAt': iso_in(days=2)}, open(os.path.join(cl_dir, 'heartbeat.json'), 'w'))
    out, err = node_out(node_load)
    try:
        _cap2 = datetime.fromisoformat(out.replace('Z', '+00:00'))
    except Exception:
        _cap2 = None
    check('35 clamp: both future together still cap at now + 5 minutes',
          _cap2 is not None and datetime.now(timezone.utc) < _cap2 <= datetime.now(timezone.utc) + timedelta(minutes=6),
          out + err)
    out, err = node_out(node_grace)
    check('35 clamp: both future together activate no grace (documented residual)', out == 'NO-GRACE', out + err)
    # (c) A backward clock jump expires the heartbeat throttle.
    node_throttle = ("const s=require('./lib/store');const fs=require('fs');"
                     "const d=%s;fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true});"
                     "let now=Date.now();const real=Date.now;Date.now=()=>now;"
                     "const iso=(ms)=>new Date(ms).toISOString();"
                     "const a=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                     "const b=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                     "now-=10*24*3600*1000;"
                     "const c=s.touchHeartbeat(d,iso(now))?'WROTE':'SKIP';"
                     "Date.now=real;console.log(a+' '+b+' '+c);"
                     % json.dumps(TMP + '/standby-test099-throttle'))
    out, err = node_out(node_throttle)
    check('35 throttle: write, throttled re-touch, backward jump writes again',
          out == 'WROTE SKIP WROTE', out + err)
    # (d) "localhost." and "umbrel.local." pass; a bare "." gets a
    # 421.
    s, body = raw_req('GET', '/api/health', BASE, host='localhost.')
    check('35 hosts: localhost. passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host='umbrel.local.')
    check('35 hosts: umbrel.local. passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host='localhost.:3438')
    check('35 hosts: localhost. with a port passes', s == 200, (s, body))
    s, body = raw_req('GET', '/api/health', BASE, host='.')
    check('35 hosts: bare . is still rejected',
          s == 421 and body == b'Unrecognised Host header', (s, body))
    s, body = raw_req('GET', '/health', RBASE, host='localhost.')
    check('35 hosts: localhost. passes on the receiver', s == 200, (s, body))
    # (e) Durable JSONL logs: a live check-in lands with no .tmp left;
    # append and rewrite round-trip.
    s, r = req('POST', '/api/checkin', {'method': 'app'}, headers={'Origin': 'http://127.0.0.1:3438'})
    check('35 jsonl: app check-in succeeds (200)', s == 200, (s, r))
    _log = os.path.join(DATA, 'checkins.jsonl')
    try:
        _rows = [json.loads(x) for x in open(_log).read().split('\n') if x.strip()]
    except Exception:
        _rows = []
    check('35 jsonl: check-in lands in checkins.jsonl',
          any(x.get('method') == 'app' for x in _rows), _rows[-3:] if _rows else None)
    check('35 jsonl: no checkins.jsonl.tmp left behind',
          not os.path.exists(_log + '.tmp'), os.listdir(DATA))
    node_jsonl = ("const s=require('./lib/store');const fs=require('fs');"
                  "const d=%s;fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d,{recursive:true});"
                  "s.appendCheckin(d,{ts:'2026-11-23T00:00:00.000Z',method:'t1'});"
                  "s.appendCheckin(d,{ts:'2026-11-23T00:01:00.000Z',method:'t2'});"
                  "const a=s.readCheckins(d,50);"
                  "s.writeCheckins(d,[{ts:'2026-11-23T00:02:00.000Z',method:'w'}]);"
                  "const b=s.readCheckins(d,50);"
                  "const tmp=!fs.existsSync(d+'/checkins.jsonl.tmp');"
                  "console.log(a.length===2&&a[1].method==='t2'&&b.length===1&&b[0].method==='w'&&tmp?'OK':'FAIL');"
                  % json.dumps(TMP + '/standby-test099-jsonl'))
    out, err = node_out(node_jsonl)
    check('35 jsonl: append + rewrite round-trip with no .tmp', out == 'OK', out + err)
    # --- 36. uncaught exception ---
    # The app and the receiver must exit nonzero on an uncaught
    # exception (test-only throw hook), log it, and close their ports.
    uc_data = TMP + '/standby-test099-uncaught'
    uc_checkin = TMP + '/standby-test099-uncaught-checkin'
    uc_log = TMP + '/standby-test099-uncaught.log'
    shutil.rmtree(uc_data, ignore_errors=True)
    shutil.rmtree(uc_checkin, ignore_errors=True)
    uc_env = dict(APP_ENV)
    uc_env.update({'PORT': '3440', 'DATA_DIR': uc_data, 'CHECKIN_DIR': uc_checkin})
    uc = start(['node', 'server.js'], env=uc_env, cwd=APP, log=uc_log)
    check('36 uncaught: scratch app server starts', wait_up('http://127.0.0.1:3440'))
    s, r = req('POST', '/api/__test__/throw-uncaught', {}, base='http://127.0.0.1:3440')
    check('36 uncaught: app hook answers 200', s == 200, (s, r))
    check('36 uncaught: app server exits on an uncaught exception',
          wait_until(lambda: uc.poll() is not None, deadline=10), uc.poll())
    check('36 uncaught: app exit code is nonzero',
          uc.poll() not in (None, 0), uc.poll())
    _uc_log = open(uc_log).read() if os.path.exists(uc_log) else ''
    check('36 uncaught: app log records the exception',
          'uncaught exception:' in _uc_log, _uc_log[-300:] if _uc_log else None)
    check('36 uncaught: scratch app port is closed again', port_closed(3440))
    rc_log = TMP + '/standby-test099-uncaught-recv.log'
    rc = start(['node', 'server.js'], env={'PORT': '3441', 'CHECKIN_DIR': uc_checkin},
               cwd=os.path.join(APP, 'checkin-receiver'), log=rc_log)
    check('36 uncaught: scratch receiver starts', wait_up('http://127.0.0.1:3441', path='/health'))
    s, r = req('POST', '/__test__/throw-uncaught', {}, base='http://127.0.0.1:3441')
    check('36 uncaught: receiver hook answers 200', s == 200, (s, r))
    check('36 uncaught: receiver exits on an uncaught exception',
          wait_until(lambda: rc.poll() is not None, deadline=10), rc.poll())
    check('36 uncaught: receiver exit code is nonzero',
          rc.poll() not in (None, 0), rc.poll())
    _rc_log = open(rc_log).read() if os.path.exists(rc_log) else ''
    check('36 uncaught: receiver log records the exception',
          'uncaught exception:' in _rc_log, _rc_log[-300:] if _rc_log else None)
    check('36 uncaught: scratch receiver port is closed again', port_closed(3441))

    # --- 47. one copy per data folder; port in use; log file ---
    one_data = TMP + '/standby-test099-onecopy'
    one_log = TMP + '/standby-test099-onecopy.log'
    one_file = TMP + '/standby-test099-onecopy-file.log'
    for pth in (one_data,):
        shutil.rmtree(pth, ignore_errors=True)
    for pth in (one_log, one_file, one_file + '.1'):
        try:
            os.remove(pth)
        except OSError:
            pass
    one_env = dict(APP_ENV)
    one_env.update({'PORT': '3440', 'DATA_DIR': one_data, 'CHECKIN_DIR': one_data + '/checkin', 'STANDBY_LOG_FILE': one_file})
    check('47 one copy: port 3440 free', port_closed(3440))
    one_app = start(['node', 'server.js'], env=one_env, cwd=APP, log=one_log)
    check('47 one copy: first copy comes up', wait_up('http://127.0.0.1:3440'))
    lock = json.load(open(os.path.join(one_data, 'standby.lock')))
    check('47 one copy: the lock names the running copy', lock.get('pid') == one_app.pid, lock)
    # A second copy on the same data folder (another port) refuses.
    two = subprocess.run(['node', 'server.js'], env=dict(os.environ, **dict(one_env, PORT='3441', STANDBY_TEST_MODE='1')),
                         cwd=APP, capture_output=True, text=True, timeout=20)
    check('47 one copy: a second copy on the same data folder refuses to start',
          two.returncode == 1 and 'another copy is already running on this data folder' in two.stdout + two.stderr,
          (two.returncode, (two.stdout + two.stderr)[-300:]))
    check('47 one copy: ... and never listened', port_closed(3441))
    # A copy on a taken port says so.
    busy = subprocess.run(['node', 'server.js'], env=dict(os.environ, **dict(one_env, DATA_DIR=one_data + '-other', STANDBY_TEST_MODE='1')),
                          cwd=APP, capture_output=True, text=True, timeout=20)
    shutil.rmtree(one_data + '-other', ignore_errors=True)
    check('47 port: a taken port is a clear error, not a crash',
          busy.returncode == 1 and 'port 3440 is already in use' in busy.stdout + busy.stderr,
          (busy.returncode, (busy.stdout + busy.stderr)[-300:]))
    # The log file holds the console lines, timestamped.
    try:
        log_text = open(one_file).read()
    except OSError:
        log_text = ''
    check('47 log file: STANDBY_LOG_FILE gets the console lines, timestamped',
          re.search(r'^\d{4}-\d\d-\d\dT[\d:.]+Z INFO Standby \S+ listening on ', log_text, re.M) is not None, log_text[:300])
    # A lock left by a dead copy is taken over.
    stop(one_app)
    with open(os.path.join(one_data, 'standby.lock'), 'w') as f:
        json.dump({'pid': 999999, 'refreshedAt': datetime.now(timezone.utc).isoformat()}, f)
    one_app = start(['node', 'server.js'], env=one_env, cwd=APP, log=one_log)
    check('47 one copy: a lock left by a dead copy is taken over', wait_up('http://127.0.0.1:3440'))
    stop(one_app)
    check('47 one copy: port 3440 closed again', port_closed(3440))

    # --- 47b. the lock under pressure (refresh every second) ---
    fast_env = dict(one_env, STANDBY_TEST_LOCK_REFRESH_MS='1000')
    fast_env.pop('STANDBY_LOG_FILE', None)
    shutil.rmtree(one_data, ignore_errors=True)
    def lock_now():
        try:
            return json.load(open(os.path.join(one_data, 'standby.lock')))
        except Exception:
            return {}
    def serving(port):
        try:
            return req('GET', '/api/health', base='http://127.0.0.1:%d' % port, timeout=2)[0] == 200
        except Exception:
            return False
    # Two copies started at the same moment: exactly one runs.
    pa = start(['node', 'server.js'], env=dict(fast_env, PORT='3440'), cwd=APP, log=one_log)
    pb = start(['node', 'server.js'], env=dict(fast_env, PORT='3441'), cwd=APP, log=one_log)
    time.sleep(5)
    up = [p for p, port in ((pa, 3440), (pb, 3441)) if p.poll() is None and serving(port)]
    check('47b race: two copies started together — exactly one runs', len(up) == 1,
          [(p.poll(), serving(port)) for p, port in ((pa, 3440), (pb, 3441))])
    winner = up[0] if up else pa
    check('47b race: the lock names the one that runs', lock_now().get('pid') == winner.pid, lock_now())
    # Killed outright (no clean exit): a new copy takes over at once.
    for p in (pa, pb):
        try:
            p.kill(); p.wait(timeout=5)
        except Exception:
            pass
    check('47b crash: the lock outlives a hard kill', bool(lock_now()), lock_now())
    pc = start(['node', 'server.js'], env=dict(fast_env, PORT='3440'), cwd=APP, log=one_log)
    check('47b crash: a new copy takes over the dead copy\'s lock', wait_up('http://127.0.0.1:3440') and lock_now().get('pid') == pc.pid, lock_now())
    # A live copy whose lock looks old (just woken from sleep) keeps it: the
    # new copy waits one interval, sees it refresh, and refuses.
    held = lock_now()
    held['refreshedAt'] = iso_ago(minutes=10)
    with open(os.path.join(one_data, 'standby.lock'), 'w') as f:
        json.dump(held, f)
    woke = subprocess.run(['node', 'server.js'], env=dict(os.environ, **dict(fast_env, PORT='3441', STANDBY_TEST_MODE='1')),
                          cwd=APP, capture_output=True, text=True, timeout=30)
    check('47b sleep: a live copy with an old lock keeps it (the new copy refuses)',
          woke.returncode == 1 and pc.poll() is None and lock_now().get('pid') == pc.pid, (woke.returncode, lock_now()))
    stop(pc)
    # A pid reused by another program (alive, but no Standby refreshing the
    # lock) is taken over after one interval.
    with open(os.path.join(one_data, 'standby.lock'), 'w') as f:
        json.dump({'pid': os.getpid(), 'id': 'not-standby', 'refreshedAt': iso_ago(minutes=10)}, f)
    pd = start(['node', 'server.js'], env=dict(fast_env, PORT='3440'), cwd=APP, log=one_log)
    check('47b reuse: a reused pid (alive, never refreshing) is taken over', wait_up('http://127.0.0.1:3440') and lock_now().get('pid') == pd.pid, lock_now())
    # A paused copy is taken over; when it resumes it exits before it can
    # evaluate or broadcast. Pausing a process is POSIX-only.
    if os.name == 'nt':
        check('47b paused: pausing a process is POSIX-only (covered on Linux)', True)
        stop(pd)
    else:
        os.kill(pd.pid, signal.SIGSTOP)
        time.sleep(3.5)
        pe = start(['node', 'server.js'], env=dict(fast_env, PORT='3441'), cwd=APP, log=one_log)
        check('47b paused: a new copy takes over from a paused one', wait_up('http://127.0.0.1:3441') and lock_now().get('pid') == pe.pid, lock_now())
        os.kill(pd.pid, signal.SIGCONT)
        try:
            pd_code = pd.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pd_code = None
        check('47b paused: on resuming, the old copy sees the lock is gone and exits', pd_code == 1, pd_code)
        check('47b paused: the new copy keeps running', pe.poll() is None and serving(3441))
        stop(pe)
    for port in (3440, 3441):
        check('47b: port %d closed again' % port, port_closed(port))

