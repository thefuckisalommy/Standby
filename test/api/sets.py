"""API suite: Concurrency, history, multi-rule and shared sets, evaluation, staleness (sections 14-19, 22, 27-30)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 14. concurrent API writes ---
    # Ten adds at once, each awaiting the fee lookup: all must
    # survive.
    conc_ids = []
    conc_errs = []

    def _add_one(i):
        try:
            s2, r2 = add_tx('Conc %d' % i, {'type': 'checkin', 'params': {'thresholdDays': 35}}, 114000 + i * 2)
            if s2 == 201 and r2.get('tx', {}).get('id'):
                conc_ids.append(r2['tx']['id'])
            else:
                conc_errs.append((i, s2, r2))
        except Exception as e:  # noqa
            conc_errs.append((i, 'exc', str(e)))

    threads = [threading.Thread(target=_add_one, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    s, st = req('GET', '/api/state')
    have = {t.get('id') for t in st.get('bitcoin', {}).get('txs', [])}
    check('14 concurrent adds: all 10 survive', len(conc_ids) == 10 and all(i in have for i in conc_ids) and not conc_errs, (conc_ids, conc_errs))
    delete_all_txs()

    # --- 15. per-tx history ---
    # added, fired then broadcast, confirmed (block 899,995), edited,
    # disarmed/armed; a restored tx with no history gets a bare
    # 'added'.
    delete_all_txs()
    s, r = add_tx('H blockheight', {'type': 'blockheight', 'params': {'targetHeight': 800000}}, 115000, trigger_confirmed=True)
    check('15 add: accepted (201)', s == 201, (s, r))
    h_bh = r['tx']['id'] if s == 201 else None
    t = state_tx(h_bh)
    h = t.get('history') if t else None
    check('15 history: add logs one added event with the condition',
          isinstance(h, list) and len(h) == 1 and h[0].get('type') == 'added'
          and h[0].get('detail') == 'Fires when the chain reaches block 800,000', h)
    s, r, res = release_results()
    check('15 release: past height broadcasts', s == 200 and res.get(h_bh, {}).get('action') == 'broadcast', res.get(h_bh))
    t = state_tx(h_bh)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('15 history: fired then broadcast, fired once',
          types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
    check('15 history: fired detail names the tip reached',
          isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'block 900,000 reached',
          h[1] if isinstance(h, list) and len(h) >= 2 else h)
    txid = t.get('txid') if t else ''
    check('15 history: broadcast detail names the txid',
          isinstance(h, list) and len(h) >= 3 and h[2].get('detail') == 'txid ' + txid[:8] + '…' + txid[-4:],
          h[2] if isinstance(h, list) and len(h) >= 3 else h)
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('15 confirmations: refresh answers', s == 200, (s, r))
    t = state_tx(h_bh)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('15 history: confirmed appended once, Block 899,995',
          types == ['added', 'fired', 'broadcast', 'confirmed']
          and h[3].get('detail') == 'Block 899,995', h)
    s, r, res = release_results()
    t = state_tx(h_bh)
    h = t.get('history') if t else None
    check('15 history: a second release check adds no events',
          isinstance(h, list) and len(h) == 4, h)
    delete_all_txs()

    # Edit + arm/disarm on a fresh manual tx (never fired).
    s, r = add_tx('H manual', {'type': 'manual', 'params': {}}, 115002)
    check('15 add: manual tx accepted (201)', s == 201, (s, r))
    h_m = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'label': 'H manual renamed'})
    check('15 edit: label change saves (200)', s == 200, (s, r))
    s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'enabled': False})
    check('15 edit: disarm saves (200)', s == 200, (s, r))
    s, r = req('PUT', '/api/bitcoin/txs/' + h_m, {'enabled': True})
    check('15 edit: re-arm saves (200)', s == 200, (s, r))
    t = state_tx(h_m)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('15 history: edited, disarmed, armed in order',
          types == ['added', 'edited', 'disarmed', 'armed'], types)
    check('15 history: edited detail names the change',
          isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'Label changed',
          h[1] if isinstance(h, list) and len(h) >= 2 else h)
    check('15 history: manual added detail is the manual line',
          isinstance(h, list) and len(h) >= 1 and h[0].get('detail') == 'Never fires — manual only',
          h[0] if isinstance(h, list) and len(h) >= 1 else h)

    # Restore: a backup whose tx carries no history seeds one.
    s, bak = req('POST', '/api/backup', {})
    check('15 restore: backup fetched', s == 200, (s, r))
    bak3 = copy.deepcopy(bak)
    for tx3 in bak3['state']['bitcoin']['txs']:
        tx3.pop('history', None)
    delete_all_txs()
    s, r = req('POST', '/api/restore', bak3)
    check('15 restore: backup without history restores (200)', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
    h3 = by_label.get('H manual renamed', {}).get('history')
    check('15 history: restore seeds one bare added event',
          isinstance(h3, list) and len(h3) == 1 and h3[0].get('type') == 'added' and h3[0].get('detail') == '', h3)
    delete_all_txs()

    # --- 16. gate vs evaluator under grace and vacation ---
    # The add gate answers the raw condition (it blocks an already-met
    # condition even while held); only the evaluator applies holds.
    # Price under a grace: the gate fires, the release does not
    # broadcast until resumed.
    s, r = add_tx('16 price grace', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, 116000, trigger_confirmed=True)
    check('16 grace: price tx accepted (201)', s == 201, (s, r))
    g16 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
    save_state_file(stj)
    check('16 grace: app restarted with an active grace', restart())
    s, st = req('GET', '/api/state')
    check('16 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('16 grace: the gate still reports fire during a grace (no grace in the gate)',
          s == 200 and r.get('fire') is True, r)
    s, r, res = release_results()
    check('16 grace: the price tx does NOT broadcast during a grace',
          s == 200 and res.get(g16, {}).get('action') == 'skipped' and res.get(g16, {}).get('triggerStatus') == 'grace', res.get(g16))
    s, r = req('POST', '/api/grace/resume', {})
    check('16 grace: resumed', s == 200, (s, r))
    s, r, res = release_results()
    check('16 grace: the price tx broadcasts once the grace is resumed',
          s == 200 and res.get(g16, {}).get('action') == 'broadcast', res.get(g16))
    delete_all_txs()

    # Vacation: the gate still reports fire for a past-due check-in
    # (with or without txId); the release does not broadcast until
    # vacation ends.
    s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
    check('16 vacation: vacation mode on', s == 200, (s, r))
    s, r = add_tx('16 checkin vacation', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 116002)
    check('16 vacation: check-in tx accepted (201)', s == 201, (s, r))
    v16 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
    save_state_file(stj)
    check('16 vacation: app restarted with the clock 40 days past due', restart())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}})
    check('16 vacation: the gate reports fire during vacation (no vacation in the gate)',
          s == 200 and r.get('fire') is True, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'checkin', 'params': {'thresholdDays': 35}}, 'txId': v16})
    check('16 vacation: the gate reports fire with the txId too',
          s == 200 and r.get('fire') is True, r)
    s, r, res = release_results()
    check('16 vacation: the check-in tx does NOT broadcast during vacation',
          s == 200 and res.get(v16, {}).get('action') == 'skipped' and res.get(v16, {}).get('triggerStatus') == 'vacation', res.get(v16))
    s, r = req('PUT', '/api/settings', {'vacationMode': False, 'vacationUntil': None})
    check('16 vacation: vacation mode off', s == 200, (s, r))
    s, r, res = release_results()
    check('16 vacation: the check-in tx broadcasts once vacation is off',
          s == 200 and res.get(v16, {}).get('action') == 'broadcast', res.get(v16))
    delete_all_txs()

    # --- 17. multi-rule sets ---
    # OR fires on any rule; AND only when all hold on the same tick;
    # unknown blocks AND and is ignored by OR; a grace holds every
    # rule; an already-satisfied set blocks the add.
    # 17.1 OR fires on the set-date rule while the price rule does not
    # hold.
    or_set = {'op': 'OR', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
    ]}
    s, r = add_tx('17 OR one rule', or_set, 116100, trigger_confirmed=True)
    check('17 OR: accepted with triggerConfirmed (201)', s == 201, (s, r))
    or17 = r['tx']['id'] if s == 201 else None
    check('17 OR: the add response serves the set',
          isinstance(r.get('tx', {}).get('trigger'), dict)
          and r['tx']['trigger'].get('op') == 'OR'
          and [x.get('type') for x in r['tx']['trigger'].get('rules', [])] == ['price', 'setdate']
          and r['tx']['trigger']['rules'][0] == or_set['rules'][0]
          and r['tx']['trigger']['rules'][1].get('type') == 'setdate',
          r.get('tx', {}).get('trigger'))
    t = state_tx(or17)
    h = t.get('history') if t else None
    check('17 OR: added detail joins the rules with OR',
          isinstance(h, list) and len(h) >= 1
          and h[0].get('detail', '').startswith('Fires when BTC price ≥ $200,000 OR the date '),
          h[0] if isinstance(h, list) and len(h) >= 1 else h)
    s, r, res = release_results()
    check('17 OR: broadcasts on the one holding rule',
          s == 200 and res.get(or17, {}).get('action') == 'broadcast', res.get(or17))
    t = state_tx(or17)
    check('17 OR: the release record names the rule that fired',
          t is not None and (t.get('release') or {}).get('trigger') == 'setdate', t.get('release') if t else None)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('17 OR: fired then broadcast, fired once',
          types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
    check('17 OR: fired detail names the rule that fired (the set-date rule)',
          isinstance(h, list) and len(h) >= 2 and h[1].get('detail') == 'date reached',
          h[1] if isinstance(h, list) and len(h) >= 2 else h)
    delete_all_txs()

    # 17.2 AND fires only when all rules hold on the same tick: a
    # price hold that lapses before the fee rule holds must not latch.
    and_set = {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 100000}},
        {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'below'}},
    ]}
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('17 AND: cadence 10 s for the price-cache TTL', s == 200, (s, r))
    s, r = add_tx('17 AND no latch', and_set, 116102)
    check('17 AND: accepted without confirm (nothing holds yet, 201)', s == 201, (s, r))
    and17 = r['tx']['id'] if s == 201 else None
    # Phase 1: the price crosses ($101,000) while the fee is 1.
    s, pr = req('POST', '/__test__/price', {'usd': 101000}, base=STUB_BASE_P)
    check('17 AND: stub price $101,000', s == 200, pr)
    # Clear caches so the next tick fetches the new price, then poll
    # for the due slice.
    check('17 AND phase 1: caches cleared for a cold price cache', clear_caches())
    wait_slice(and17, {'status': 'due', 'lastPrice': 101000})
    s, r, res = release_results()
    check('17 AND phase 1: price holds, fee does not — no broadcast',
          s == 200 and res.get(and17, {}).get('action') == 'skipped'
          and res.get(and17, {}).get('triggerStatus') == 'watching', res.get(and17))
    check('17 AND phase 1: the skipped release result names all rule types',
          res.get(and17, {}).get('trigger') == 'price+feemarket', res.get(and17))
    # Phase 2: the price falls back ($98,200) while the fee drops
    # to 0.4 — the earlier price hold must not have latched.
    s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    check('17 AND: stub price back to $98,200', s == 200, pr)
    s, r = req('POST', '/__test__/fees', {'economyFee': 0.4}, base=STUB_BASE_P)
    check('17 AND: primary fee 0.4', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 0.4}, base=STUB_BASE_S)
    check('17 AND: secondary fee 0.4', s == 200, (s, r))
    check('17 AND phase 2: caches cleared for a cold fee cache (fee 0.4)', clear_caches())
    s, r, res = release_results()
    check('17 AND phase 2: fee holds, price does not — no broadcast (no latching)',
          s == 200 and res.get(and17, {}).get('action') == 'skipped'
          and res.get(and17, {}).get('triggerStatus') == 'watching', res.get(and17))
    # Phase 3: both hold on the same tick (the tick may broadcast
    # before the manual check, so read the stored release).
    s, pr = req('POST', '/__test__/price', {'usd': 101000}, base=STUB_BASE_P)
    check('17 AND: stub price $101,000 again', s == 200, pr)
    # Clear caches, then poll until the tick broadcasts.
    check('17 AND phase 3: caches cleared for a cold price cache', clear_caches())
    wait_until(lambda: ((state_tx(and17) or {}).get('release') or {}).get('status') == 'broadcast', deadline=12)
    s, r, res = release_results()
    t = state_tx(and17)
    check('17 AND phase 3: both hold on the same tick — broadcasts',
          t is not None and (t.get('release') or {}).get('status') == 'broadcast',
          t.get('release') if t else None)
    # Restore the stub prices/fees and the cadence.
    s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    check('17 AND: stub price restored to $98,200', s == 200, pr)
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
    check('17 AND: primary fee restored to 1', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
    check('17 AND: secondary fee restored to 1', s == 200, (s, r))
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('17 AND: cadence back to 60 s', s == 200, (s, r))
    delete_all_txs()

    # 17.3 Sources 8.7% apart make price unknown: the AND set cannot
    # fire; the OR set fires on its set-date rule.
    s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 90000}, base=STUB_BASE_P)
    check('17 unknown: CoinGecko stub set to $90,000', s == 200 and pr.get('coingecko', {}).get('usd') == 90000, pr)
    check('17 unknown: restart before the disagree eval (empty cache)', restart())
    and_unk = {'op': 'AND', 'rules': [
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
    ]}
    s, r = add_tx('17 AND unknown', and_unk, 116104)
    check('17 unknown: AND with an unknown rule accepted (201 — unknown never blocks)', s == 201, (s, r))
    andu17 = r['tx']['id'] if s == 201 else None
    or_unk = {'op': 'OR', 'rules': [
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
    ]}
    s, r = add_tx('17 OR unknown', or_unk, 116106, trigger_confirmed=True)
    check('17 unknown: OR with a holding rule accepted with confirm (201)', s == 201, (s, r))
    oru17 = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('17 unknown: AND does NOT broadcast while a rule is unknown',
          s == 200 and res.get(andu17, {}).get('action') == 'skipped' and res.get(andu17, {}).get('triggerStatus') == 'unknown', res.get(andu17))
    check('17 unknown: OR broadcasts on its readable rule',
          s == 200 and res.get(oru17, {}).get('action') == 'broadcast', res.get(oru17))
    s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 98200}, base=STUB_BASE_P)
    check('17 unknown: CoinGecko stub back to $98,200', s == 200, pr)
    check('17 unknown: caches cleared to bust the price cache', clear_caches())
    delete_all_txs()

    # 17.4 A grace holds every rule in a set: neither the OR nor the
    # AND set fires during it; both broadcast once it is resumed. The
    # txs are added while the clock is fresh (an add inside the danger
    # zone resets it), then the backdated clock and the grace are
    # seeded before the restart.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('17 grace: check-in lands so the clock is fresh for the adds', s == 200 and r.get('ok') is True, r)
    or_g = {'op': 'OR', 'rules': [
        {'type': 'checkin', 'params': {'thresholdDays': 2}},
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
    ]}
    and_g = {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
    ]}
    s, r = add_tx('17 OR grace', or_g, 116108, trigger_confirmed=True)
    check('17 grace: OR set accepted with confirm (201)', s == 201, (s, r))
    org17 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('17 AND grace', and_g, 116110, trigger_confirmed=True)
    check('17 grace: AND set accepted with confirm (201)', s == 201, (s, r))
    andg17 = r['tx']['id'] if s == 201 else None
    def seed_grace_17():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=3)
        stj['grace'] = {'graceUntil': iso_in(days=7), 'triggeredAt': iso_ago(), 'offlineGapDays': 10}
        save_state_file(stj)
    check('17 grace: app restarted with an active grace', restart(before_start=seed_grace_17))
    s, st = req('GET', '/api/state')
    check('17 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    org_tx = state_tx(org17)
    check('17 grace: OR still staged after the restart (its check-in rule is held by the grace now)',
          org_tx and org_tx.get('release') is None and not org_tx.get('broadcasted'),
          org_tx and {'release': org_tx.get('release'), 'broadcasted': org_tx.get('broadcasted')})
    and_tx = state_tx(andg17)
    check('17 grace: AND still staged after the restart (its rules are held)',
          and_tx and and_tx.get('release') is None and not and_tx.get('broadcasted'),
          and_tx and {'release': and_tx.get('release'), 'broadcasted': and_tx.get('broadcasted')})
    s, r, res = release_results()
    check('17 grace: OR does NOT fire while its check-in and price rules are held',
          s == 200 and res.get(org17, {}).get('action') == 'skipped' and res.get(org17, {}).get('triggerStatus') == 'grace', res.get(org17))
    check('17 grace: AND does NOT fire while its price and set-date rules are held',
          s == 200 and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
    s, r, res = release_results()
    check('17 grace: a second release check still does not fire either set',
          s == 200 and res.get(org17, {}).get('action') == 'skipped' and res.get(org17, {}).get('triggerStatus') == 'grace'
          and res.get(andg17, {}).get('action') == 'skipped' and res.get(andg17, {}).get('triggerStatus') == 'grace', res.get(andg17))
    s, r = req('POST', '/api/grace/resume', {})
    check('17 grace: resumed', s == 200, (s, r))
    s, r, res = release_results()
    check('17 grace: OR broadcasts once the grace is resumed (check-in + price)',
          s == 200 and res.get(org17, {}).get('action') == 'broadcast', res.get(org17))
    org_tx = state_tx(org17)
    check('17 grace: OR release names both fired rules (checkin+price)',
          org_tx and (org_tx.get('release') or {}).get('trigger') == 'checkin+price',
          org_tx and org_tx.get('release'))
    check('17 grace: AND broadcasts once the grace is resumed',
          s == 200 and res.get(andg17, {}).get('action') == 'broadcast', res.get(andg17))
    delete_all_txs()
    # Restore a fresh check-in clock.
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago()
    stj['checkin']['lastCheckinAt'] = iso_ago()
    save_state_file(stj)
    check('17 grace: check-in clock restored (restart)', restart())

    # 17.5 An already-satisfied set blocks the add: OR on any
    # satisfied rule, AND only when all are. Unknown never blocks.
    or_block = {'op': 'OR', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
    ]}
    s, r = add_tx('17 OR block', or_block, 116112)
    check('17 gate: OR with a holding rule blocked without confirm (400)',
          s == 400 and 'already satisfied' in str(r.get('error', '')), (s, r))
    s, r = add_tx('17 OR block', or_block, 116114, trigger_confirmed=True)
    check('17 gate: OR with a holding rule accepted with confirm (201)', s == 201, (s, r))
    and_block = {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}},
    ]}
    s, r = add_tx('17 AND block', and_block, 116116)
    check('17 gate: AND with all rules holding blocked without confirm (400)',
          s == 400 and 'already satisfied' in str(r.get('error', '')), (s, r))
    s, r = add_tx('17 AND block', and_block, 116118, trigger_confirmed=True)
    check('17 gate: AND with all rules holding accepted with confirm (201)', s == 201, (s, r))
    or_open = {'op': 'OR', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
        {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
    ]}
    s, r = add_tx('17 OR open', or_open, 116120)
    check('17 gate: OR with nothing holding accepted without confirm (201)', s == 201, (s, r))
    and_open = {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
    ]}
    s, r = add_tx('17 AND open', and_open, 116122)
    check('17 gate: AND with one rule not holding accepted without confirm (201)', s == 201, (s, r))
    # The check endpoint answers the same (fireAt compared
    # structurally: microseconds vs milliseconds).
    s, r = req('POST', '/api/triggers/check', {'trigger': or_block})
    trig = r.get('trigger')
    check('17 gate: check on a firing OR set reports fire',
          s == 200 and r.get('fire') is True and isinstance(trig, dict) and trig.get('op') == 'OR'
          and [x.get('type') for x in trig.get('rules', [])] == ['price', 'setdate'], r)
    s, r = req('POST', '/api/triggers/check', {'trigger': and_open})
    trig = r.get('trigger')
    check('17 gate: check on a non-firing AND set reports no fire',
          s == 200 and r.get('fire') is False and isinstance(trig, dict) and trig.get('op') == 'AND'
          and [x.get('type') for x in trig.get('rules', [])] == ['price', 'setdate'], r)
    delete_all_txs()

    # 17.6 A stored single trigger with a flat triggerState loads as a
    # set and array, is served as the single rule, and evaluates.
    s, r = add_tx('17 migrate', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 116124)
    check('17 migrate: single-rule tx accepted (201)', s == 201, (s, r))
    mig17 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    for txj in stj.get('bitcoin', {}).get('txs', []):
        if txj.get('id') == mig17:
            # Rewind to the 0.8.1 stored shape: a single trigger
            # and a flat triggerState.
            txj['trigger'] = {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}
            txj['triggerState'] = {'status': 'watching', 'reason': 'currently $98,200',
                                   'lastEvalAt': iso_ago(hours=1), 'lastPrice': 98200, 'lastPriceAt': iso_ago(hours=1),
                                   'lastError': None, 'priceMode': 'dual', 'priceNote': '',
                                   'lastEconomyFee': None, 'feeMode': None, 'feeNote': None,
                                   'heightReachedFor': None, 'lastBlockHeight': None}
    save_state_file(stj)
    check('17 migrate: app restarted on the 0.8.1 shape', restart())
    stj = load_state_file()
    migj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == mig17), None)
    check('17 migrate: the trigger loads as a one-rule OR set',
          migj is not None and migj.get('trigger') == {'op': 'OR', 'rules': [{'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}]}, migj.get('trigger') if migj else None)
    check('17 migrate: the triggerState loads as a one-element array keeping lastPrice',
          migj is not None and isinstance(migj.get('triggerState'), list) and len(migj.get('triggerState')) == 1
          and migj['triggerState'][0].get('lastPrice') == 98200, migj.get('triggerState') if migj else None)
    t = state_tx(mig17)
    check('17 migrate: the served trigger is the single rule',
          t is not None and t.get('trigger') == {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, t.get('trigger') if t else None)
    check('17 migrate: the served triggerState is the flat slice',
          t is not None and isinstance(t.get('triggerState'), dict) and t.get('triggerState', {}).get('lastPrice') == 98200, t.get('triggerState') if t else None)
    s, r, res = release_results()
    check('17 migrate: the migrated tx evaluates (not holding, no broadcast)',
          s == 200 and res.get(mig17, {}).get('action') == 'skipped' and res.get(mig17, {}).get('triggerStatus') == 'watching', res.get(mig17))
    delete_all_txs()

    # 17.7 Per-rule slices survive a restart.
    two_set = {'op': 'OR', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
        {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}},
    ]}
    s, r = add_tx('17 two-rule state', two_set, 116126)
    check('17 state: two-rule tx accepted (201)', s == 201, (s, r))
    two17 = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('17 state: neither rule holds — no broadcast',
          s == 200 and res.get(two17, {}).get('action') == 'skipped', res.get(two17))
    stj = load_state_file()
    twoj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == two17), None)
    check('17 state: triggerState is a two-element array with a price slice carrying lastPrice',
          twoj is not None and isinstance(twoj.get('triggerState'), list) and len(twoj.get('triggerState')) == 2
          and twoj['triggerState'][0].get('lastPrice') == 98200
          and twoj['triggerState'][1].get('status') == 'watching', twoj.get('triggerState') if twoj else None)
    check('17 state: app restarted', restart())
    stj = load_state_file()
    twoj = next((t for t in stj.get('bitcoin', {}).get('txs', []) if t.get('id') == two17), None)
    check('17 state: the per-rule array is intact after a restart',
          twoj is not None and isinstance(twoj.get('triggerState'), list) and len(twoj.get('triggerState')) == 2
          and twoj['triggerState'][0].get('lastPrice') == 98200
          and twoj['triggerState'][1].get('status') == 'watching', twoj.get('triggerState') if twoj else None)
    delete_all_txs()

    # --- 18. full-evaluation tick + broadcast backoff ---
    # An AND set spanning tick domains fires on the tick. A failed
    # broadcast is not retried by the tick within the hour; a manual
    # check or broadcast bypasses the backoff, and the retry succeeds
    # after the hour.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('18 tick: cadence set to 10 s', s == 200, (s, r))
    # 18.1 AND [checkin, price] fires on the startup tick (clock 40
    # days past due, price past $90,000).
    cross_set = {'op': 'AND', 'rules': [
        {'type': 'checkin', 'params': {'thresholdDays': 35}},
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
    ]}
    s, r = add_tx('18 cross-domain AND', cross_set, 118100)
    check('18 cross: AND [checkin, price] accepted (201 — check-in not due yet)', s == 201, (s, r))
    cross18 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
    save_state_file(stj)
    check('18 cross: app restarted with the clock 40 days past due', restart())
    t = state_tx(cross18)
    check('18 cross: the full tick broadcast the AND set (both rules held on the same tick)',
          t is not None and (t.get('release') or {}).get('status') == 'broadcast', t.get('release') if t else None)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('18 cross: fired once then broadcast',
          types[:3] == ['added', 'fired', 'broadcast'] and types.count('fired') == 1, types)
    delete_all_txs()

    # 18.2 Backoff: with both stubs rejecting broadcasts, later ticks
    # must not retry. The tx is added first (an add while past due
    # resets the clock), then the clock is backdated and the app
    # restarted, so the startup tick is the first attempt.
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': True}, base=STUB_BASE_P)
    check('18 backoff: primary stub rejecting broadcasts', s == 200 and r.get('fail') is True, r)
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': True}, base=STUB_BASE_S)
    check('18 backoff: secondary stub rejecting broadcasts', s == 200 and r.get('fail') is True, r)
    s, c0p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c0s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 backoff: attempt counts read', isinstance(c0p.get('count'), int) and isinstance(c0s.get('count'), int), (c0p, c0s))
    s, r = add_tx('18 backoff checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 118102, trigger_confirmed=True)
    check('18 backoff: check-in tx accepted with confirm (201)', s == 201, (s, r))
    check('18 backoff: the add reset the clock (danger-zone add-reset)', r.get('checkinReset') is True, r)
    bo18 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    save_state_file(stj)
    check('18 backoff: app restarted with the clock 40 days past due', restart())
    t = state_tx(bo18)
    check('18 backoff: the startup tick attempted once and it failed',
          t is not None and (t.get('release') or {}).get('status') == 'failed'
          and isinstance((t.get('release') or {}).get('lastAttemptAt'), str), (t or {}).get('release'))
    s, c1p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c1s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 backoff: the attempt hit the primary once and fell back to the secondary once',
          c1p.get('count') == c0p.get('count') + 1 and c1s.get('count') == c0s.get('count') + 1, (c0p, c1p, c0s, c1s))
    last_attempt = (t.get('release') or {}).get('lastAttemptAt') if t else None
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('18 backoff: exactly one failed history event, fired once',
          types.count('failed') == 1 and types.count('fired') == 1, types)
    # A later tick must not retry: poll for one more evaluation.
    before18 = rule_slice(state_tx(bo18)).get('lastEvalAt')
    wait_last_eval(bo18, before18)
    s, c2p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c2s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 backoff: the next tick made no second attempt on either node',
          c2p.get('count') == c1p.get('count') and c2s.get('count') == c1s.get('count'), (c1p, c2p, c1s, c2s))
    t = state_tx(bo18)
    check('18 backoff: lastAttemptAt unchanged across the second tick',
          t is not None and (t.get('release') or {}).get('lastAttemptAt') == last_attempt, (t or {}).get('release'))
    check('18 backoff: still failed, still due (no second fired event)',
          t is not None and (t.get('release') or {}).get('status') == 'failed'
          and [e.get('type') for e in (t.get('history') or [])].count('failed') == 1
          and [e.get('type') for e in (t.get('history') or [])].count('fired') == 1, (t or {}).get('history'))
    # 18.3 A manual check and a manual broadcast bypass the backoff
    # (and fail again against the rejecting stubs).
    s, r, res = release_results()
    check('18 manual: a manual release check retries despite the backoff',
          s == 200 and res.get(bo18, {}).get('action') == 'failed', res.get(bo18))
    s, c3p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c3s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 manual: the manual check attempted once more on each node',
          c3p.get('count') == c2p.get('count') + 1 and c3s.get('count') == c2s.get('count') + 1, (c2p, c3p, c2s, c3s))
    t = state_tx(bo18)
    last_attempt2 = (t.get('release') or {}).get('lastAttemptAt') if t else None
    check('18 manual: the manual check moved lastAttemptAt forward',
          isinstance(last_attempt2, str) and last_attempt2 > last_attempt, (last_attempt, last_attempt2))
    s, r = req('POST', '/api/bitcoin/txs/' + bo18 + '/broadcast', {})
    check('18 manual: a manual broadcast retries despite the backoff',
          s == 200 and r.get('action') == 'failed', r)
    s, c4p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c4s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 manual: the manual broadcast attempted once more on each node',
          c4p.get('count') == c3p.get('count') + 1 and c4s.get('count') == c3s.get('count') + 1, (c3p, c4p, c3s, c4s))
    t = state_tx(bo18)
    last_attempt3 = (t.get('release') or {}).get('lastAttemptAt') if t else None
    check('18 manual: the manual broadcast moved lastAttemptAt forward again',
          isinstance(last_attempt3, str) and last_attempt3 > last_attempt2, (last_attempt2, last_attempt3))
    # 18.4 Retry after the window: lastAttemptAt is backdated two
    # hours while the app is stopped, so the startup tick retries.
    # Phase 1: the stubs still reject.
    stop_app()
    stj = load_state_file()
    for txj in stj.get('bitcoin', {}).get('txs', []):
        if txj.get('id') == bo18 and isinstance(txj.get('release'), dict):
            txj['release']['lastAttemptAt'] = iso_ago(hours=2)
    save_state_file(stj)
    start_app()
    check('18 retry: app restarted with lastAttemptAt two hours back', wait_up(BASE))
    # Poll until the startup retry moves lastAttemptAt.
    wait_until(lambda: ((state_tx(bo18) or {}).get('release') or {}).get('lastAttemptAt', '') > last_attempt3, deadline=7)
    t = state_tx(bo18)
    check('18 retry: the startup tick retried after the hour and failed again',
          t is not None and (t.get('release') or {}).get('status') == 'failed'
          and (t.get('release') or {}).get('lastAttemptAt') > last_attempt3, (t or {}).get('release'))
    s, c5p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c5s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('18 retry: the retry attempted once more on each node',
          c5p.get('count') == c4p.get('count') + 1 and c5s.get('count') == c4s.get('count') + 1, (c4p, c5p, c4s, c5s))
    # Phase 2 — the stubs accept again: the same backdate +
    # restart retries and the broadcast lands.
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_P)
    check('18 retry: primary stub accepting broadcasts again', s == 200 and r.get('fail') is False, r)
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_S)
    check('18 retry: secondary stub accepting broadcasts again', s == 200 and r.get('fail') is False, r)
    stop_app()
    stj = load_state_file()
    for txj in stj.get('bitcoin', {}).get('txs', []):
        if txj.get('id') == bo18 and isinstance(txj.get('release'), dict):
            txj['release']['lastAttemptAt'] = iso_ago(hours=2)
    save_state_file(stj)
    start_app()
    check('18 retry: app restarted with lastAttemptAt two hours back again', wait_up(BASE))
    # Poll until the startup retry broadcasts.
    wait_until(lambda: ((state_tx(bo18) or {}).get('release') or {}).get('status') == 'broadcast', deadline=7)
    t = state_tx(bo18)
    check('18 retry: the startup tick retried after the hour and broadcast',
          t is not None and (t.get('release') or {}).get('status') == 'broadcast', (t or {}).get('release'))
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('18 retry: fired once across the whole backoff episode',
          types.count('fired') == 1, types)

    # Restore the default cadence for the remaining sections.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('18 tick: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 19. live rule status for never-evaluated / disarmed txs ---
    # Price, fee and set-date read warm data, so a never-evaluated tx
    # shows Met / Not met; the tick evaluates disarmed txs too, so
    # height and UTXO read a fresh slice. Caches are warmed first.
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
    check('19 warm: fee trigger check runs (warms the node-fee cache)', s == 200 and r.get('fire') is True, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('19 warm: price trigger check runs (warms the price cache)', s == 200 and r.get('fire') is True, (s, r))
    # A disarmed fee tx, never evaluated: below the fee watches.
    s, r = add_tx('FM live disarmed', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 119000)
    check('19 fee: disarmed fee tx adds (201)', s == 201, (s, r))
    fm_live = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + fm_live, {'enabled': False})
    check('19 fee: disarmed at once (200)', s == 200, (s, r))
    t = state_tx(fm_live)
    check('19 fee: live status is watching with the economy fee',
          t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerStatus') if t else None)
    # A disarmed fee tx above the fee reads due (Met), live.
    s, r = add_tx('FM live disarmed due', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 119002, trigger_confirmed=True)
    check('19 fee due: disarmed fee tx adds with confirmation (201)', s == 201, (s, r))
    fm_due = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + fm_due, {'enabled': False})
    check('19 fee due: disarmed at once (200)', s == 200, (s, r))
    t = state_tx(fm_due)
    check('19 fee due: live status is due',
          t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
    # Set-date is pure clock math: future watches, past is due.
    s, r = add_tx('SD live disarmed', {'type': 'setdate', 'params': {'fireAt': '2030-01-01T00:00:00.000Z'}}, 119004)
    check('19 setdate: disarmed set-date tx adds (201)', s == 201, (s, r))
    sd_live = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + sd_live, {'enabled': False})
    check('19 setdate: disarmed at once (200)', s == 200, (s, r))
    t = state_tx(sd_live)
    check('19 setdate: future date reads watching live',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    past_date = iso_ago(days=1)
    s, r = add_tx('SD past live disarmed', {'type': 'setdate', 'params': {'fireAt': past_date}}, 119006, trigger_confirmed=True)
    check('19 setdate past: disarmed past-date tx adds with confirmation (201)', s == 201, (s, r))
    sd_past = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + sd_past, {'enabled': False})
    check('19 setdate past: disarmed at once (200)', s == 200, (s, r))
    t = state_tx(sd_past)
    check('19 setdate past: past date reads due live',
          t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
    # The History-test shape: a disarmed AND [price >= 62625,
    # feemarket below 5] reads due on both rules, combined due.
    s, r = add_tx('AND live disarmed', {'op': 'AND', 'rules': [{'type': 'price', 'params': {'op': '>=', 'value': 62625}}, {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}]}, 119008, trigger_confirmed=True)
    check('19 AND: disarmed AND tx adds with confirmation (201)', s == 201, (s, r))
    and_live = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + and_live, {'enabled': False})
    check('19 AND: disarmed at once (200)', s == 200, (s, r))
    t = state_tx(and_live)
    ts = (t or {}).get('triggerStatus', {})
    check('19 AND: combined status is due, both rules due live',
          ts.get('status') == 'due' and len(ts.get('rules', [])) == 2
          and ts['rules'][0].get('status') == 'due' and ts['rules'][1].get('status') == 'due', ts)
    # Block-height and UTXO statuses come from the slice (pinned after
    # the manual check).
    s, r = add_tx('BH live disarmed', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 119010)
    check('19 blockheight: disarmed tx adds (201)', s == 201, (s, r))
    bh_live = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + bh_live, {'enabled': False})
    check('19 blockheight: disarmed at once (200)', s == 200, (s, r))
    s, r = add_tx('UTXO live disarmed', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, 119012)
    check('19 utxo: disarmed tx adds (201)', s == 201, (s, r))
    ux_live = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + ux_live, {'enabled': False})
    check('19 utxo: disarmed at once (200)', s == 200, (s, r))
    # A manual check evaluates every disarmed tx: fresh slices, no
    # broadcast, due ones listed as skipped.
    s, r, res = release_results()
    check('19 slices: the manual check evaluates all disarmed txs (200)',
          s == 200, (s, r))
    check('19 slices: the top-level reason names the disarmed firing',
          r.get('reason') == 'trigger fired — transaction disarmed', r.get('reason'))
    t = state_tx(fm_live)
    check('19 slices: disarmed fee slice is fresh (watching, economy fee 1)',
          rule_slice(t).get('status') == 'watching'
          and rule_slice(t).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerState') if t else None)
    t = state_tx(fm_due)
    check('19 slices: disarmed due fee slice is fresh (due)',
          rule_slice(t).get('status') == 'due', t.get('triggerState') if t else None)
    t = state_tx(sd_live)
    check('19 slices: disarmed set-date slice is fresh (watching)',
          rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
    t = state_tx(sd_past)
    check('19 slices: disarmed past-date slice is fresh (due)',
          rule_slice(t).get('status') == 'due', t.get('triggerState') if t else None)
    t = state_tx(and_live)
    check('19 slices: disarmed AND slices are fresh (both rules due)',
          rule_slice(t, 0).get('status') == 'due'
          and rule_slice(t, 1).get('status') == 'due', t.get('triggerState') if t else None)
    t = state_tx(bh_live)
    check('19 slices: disarmed block-height slice is live (watching, tip 900000)',
          rule_slice(t).get('status') == 'watching'
          and rule_slice(t).get('lastTipHeight') == STUB_TIP, t.get('triggerState') if t else None)
    t = state_tx(ux_live)
    check('19 slices: disarmed UTXO slice is live (watching, unspent)',
          rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
    check('19 slices: the due disarmed txs are listed as skipped, not broadcast',
          res.get(fm_due, {}).get('action') == 'skipped' and res.get(and_live, {}).get('action') == 'skipped'
          and (res.get(fm_due, {}).get('reason') or '').startswith('disarmed'), res)
    # Cold cache: the slices are wiped before the restart, so only the
    # startup tick can write them (proving it evaluates disarmed txs).
    stj = load_state_file()
    for txj in stj.get('bitcoin', {}).get('txs', []):
        txj['triggerState'] = None
    save_state_file(stj)
    check('19 cold: app restarts with wiped slices', restart())
    t = state_tx(fm_live)
    check('19 cold: the startup tick re-evaluated the disarmed fee tx (slice fresh, watching)',
          t and rule_slice(t).get('status') == 'watching', t.get('triggerState') if t else None)
    check('19 cold: fee rule reads watching live after restart',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    # TTL expiry: the last known fee is trusted until a fresh one
    # arrives (like price), so past one cadence the fee rule still
    # reads live. Cadence 10 s keeps the wait short.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('19 ttl: cadence set to 10 s', s == 200, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
    check('19 ttl: fee trigger check re-warms the cache', s == 200, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('19 ttl: price trigger check re-warms the cache', s == 200, (s, r))
    t = state_tx(fm_live)
    check('19 ttl: fee rule live (watching) right after warming',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    t = state_tx(and_live)
    check('19 ttl: AND price rule live (due) right after warming',
          t and (t.get('triggerStatus', {}).get('rules') or [{}])[0].get('status') == 'due', t.get('triggerStatus') if t else None)
    # Poll for one more evaluation of the fee tx.
    before19 = rule_slice(state_tx(fm_live)).get('lastEvalAt')
    wait_last_eval(fm_live, before19)
    t = state_tx(fm_live)
    check('19 ttl: fee rule still live (watching) past one cadence',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    check('19 ttl: fee rule still carries its last known fee past one cadence',
          t and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE
          and t.get('triggerStatus', {}).get('feeMode')
          and t.get('triggerStatus', {}).get('feeNote'), t.get('triggerStatus') if t else None)
    t = state_tx(and_live)
    check('19 ttl: AND price rule still due past one cadence (no age check)',
          t and (t.get('triggerStatus', {}).get('rules') or [{}])[0].get('status') == 'due', t.get('triggerStatus') if t else None)
    check('19 ttl: AND fee rule still due past one cadence (no age check)',
          t and (t.get('triggerStatus', {}).get('rules') or [{}])[1].get('status') == 'due', t.get('triggerStatus') if t else None)
    check('19 ttl: AND combined status still due past one cadence',
          t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('19 ttl: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 22. evaluate all, broadcast armed only ---
    # The tick evaluates every tx but only armed ones can fire: a
    # disarmed tx whose conditions hold shows Met and never
    # broadcasts; re-arming broadcasts on the next tick. A disarmed
    # check-in clock stays frozen.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('22 tick: cadence set to 10 s', s == 200, (s, r))
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_P)
    check('22 stubs: primary accepting broadcasts', s == 200 and r.get('fail') is False, r)
    s, r = req('POST', '/__test__/broadcast-fail', {'fail': False}, base=STUB_BASE_S)
    check('22 stubs: secondary accepting broadcasts', s == 200 and r.get('fail') is False, r)
    delete_all_txs()
    # (a) A disarmed price tx: the tick still warms the price cache
    # and writes a due slice.
    s, r = add_tx('22 price disarmed', {'type': 'price', 'params': {'op': '>=', 'value': 90000}}, 122000, trigger_confirmed=True)
    check('22 price: disarmed price tx adds with confirmation (201)', s == 201, (s, r))
    pr22 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + pr22, {'enabled': False})
    check('22 price: disarmed at once (200)', s == 200, (s, r))
    # Poll until a tick writes the slice.
    wait_slice(pr22, {'status': 'due', 'lastPrice': 98200})
    t = state_tx(pr22)
    sl = rule_slice(t)
    check('22 price: the tick wrote a fresh slice for the disarmed tx',
          sl.get('status') == 'due' and sl.get('lastPrice') == 98200, sl)
    check('22 price: live status is due with zero armed price txs',
          t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
    # (b) Disarmed fee tx stays due past one cadence.
    s, r = add_tx('22 fee disarmed', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 122002, trigger_confirmed=True)
    check('22 fee: disarmed fee tx adds with confirmation (201)', s == 201, (s, r))
    fm22 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + fm22, {'enabled': False})
    check('22 fee: disarmed at once (200)', s == 200, (s, r))
    # (Optimization O3) Poll until a full tick has written the
    # due fee slice — the tick's observable effect.
    wait_slice(fm22, {'status': 'due', 'lastEconomyFee': STUB_ECONOMY_FEE})
    t = state_tx(fm22)
    sl = rule_slice(t)
    check('22 fee: disarmed fee slice still due past one cadence',
          sl.get('status') == 'due' and sl.get('lastEconomyFee') == STUB_ECONOMY_FEE, sl)
    # (c) Disarmed block-height tx: the slice goes live from the stub tip.
    s, r = add_tx('22 blockheight disarmed', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 122004)
    check('22 blockheight: disarmed tx adds (201)', s == 201, (s, r))
    bh22 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + bh22, {'enabled': False})
    check('22 blockheight: disarmed at once (200)', s == 200, (s, r))
    # (Optimization O3) Poll until a full tick has written the
    # live block-height slice — the tick's observable effect.
    wait_slice(bh22, {'status': 'watching', 'lastTipHeight': STUB_TIP})
    t = state_tx(bh22)
    sl = rule_slice(t)
    check('22 blockheight: disarmed slice is live (watching, tip 900000)',
          sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP, sl)
    # (d) Disarmed UTXO tx: the slice updates on the tick.
    s, r = add_tx('22 utxo disarmed', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'condition': 'spent', 'confirmations': 1}}, 122006)
    check('22 utxo: disarmed tx adds (201)', s == 201, (s, r))
    ux22 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + ux22, {'enabled': False})
    check('22 utxo: disarmed at once (200)', s == 200, (s, r))
    # (Optimization O3) Poll until a full tick has written the
    # live UTXO slice — the tick's observable effect.
    wait_slice(ux22, {'status': 'watching'})
    t = state_tx(ux22)
    sl = rule_slice(t)
    check('22 utxo: disarmed slice is live (watching, FINNEY:1 unspent)',
          sl.get('status') == 'watching', sl)
    # (e) Its conditions hold, yet ticks never broadcast it; the
    # manual check lists it as skipped.
    s, c0p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c0s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('22 safety: attempt counts read', isinstance(c0p.get('count'), int) and isinstance(c0s.get('count'), int), (c0p, c0s))
    # Poll for one more evaluation.
    before22e = rule_slice(state_tx(pr22)).get('lastEvalAt')
    wait_last_eval(pr22, before22e)
    s, c1p = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
    s, c1s = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
    check('22 safety: the tick made no broadcast attempt for the disarmed due tx',
          c1p.get('count') == c0p.get('count') and c1s.get('count') == c0s.get('count'), (c0p, c1p, c0s, c1s))
    t = state_tx(pr22)
    check('22 safety: the disarmed due tx is still un-broadcast (no release record)',
          t is not None and not t.get('broadcasted') and not t.get('release'), t)
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('22 safety: no fired history event for the disarmed due tx',
          'fired' not in types, types)
    s, r, res = release_results()
    check('22 safety: the manual check lists the disarmed due tx as skipped (evaluated, not broadcast)',
          res.get(pr22, {}).get('action') == 'skipped' and (res.get(pr22, {}).get('reason') or '').startswith('disarmed'), res.get(pr22))
    check('22 safety: the manual check reason names the disarmed firing',
          r.get('reason') == 'trigger fired — transaction disarmed', r.get('reason'))
    # (f) Re-arming the satisfied tx DOES broadcast on the next tick.
    s, r = req('PUT', '/api/bitcoin/txs/' + pr22, {'enabled': True})
    check('22 rearm: the satisfied tx re-arms (200)', s == 200 and r.get('tx', {}).get('enabled') is True, r)
    # (Optimization O3) Poll until the next tick broadcasts the
    # re-armed tx — the tick's observable effect.
    wait_until(lambda: ((state_tx(pr22) or {}).get('release') or {}).get('status') == 'broadcast', deadline=12)
    t = state_tx(pr22)
    check('22 rearm: the next tick broadcast the re-armed tx',
          t is not None and (t.get('release') or {}).get('status') == 'broadcast', (t or {}).get('release'))
    h = t.get('history') if t else None
    types = [e.get('type') for e in h] if isinstance(h, list) else []
    check('22 rearm: fired logged exactly once, on the re-arm',
          types.count('fired') == 1, types)
    delete_all_txs()
    # (g) A disarmed check-in tx's clock stays frozen across ticks.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 122100), 'label': '22 ck frozen',
                                            'trigger': {'type': 'checkin', 'params': {'thresholdDays': 25}}})
    check('22 frozen: the check-in tx adds (201)', s == 201, (s, r))
    ck22 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('22 frozen: check-in lands (clock fresh)', s == 200 and r.get('ok') is True, r)
    # Remove the receiver's last.json (from §21) so the backdated
    # clock survives.
    try:
        os.remove(os.path.join(CHECKIN_DIR, 'last.json'))
    except OSError:
        pass
    # Backdate the clock 13 days, then disarm at 13/25.
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=13)
    stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
    save_state_file(stj)
    s, r = req('PUT', '/api/bitcoin/txs/' + ck22, {'enabled': False})
    check('22 frozen: disarmed at 13/25 (200)', s == 200 and r.get('tx', {}).get('enabled') is False, r)
    # Simulate 14 more days disarmed: the bar stays at the frozen 13.
    stj = load_state_file()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=27, seconds=30)
    stj['checkin']['lastOnlineAt'] = iso_ago(minutes=5)
    for txj in stj.get('bitcoin', {}).get('txs', []):
        if txj.get('id') == ck22:
            txj['checkinInactiveSince'] = iso_ago(days=14)
    save_state_file(stj)
    # Poll for one evaluation.
    before22g = rule_slice(state_tx(ck22)).get('lastEvalAt')
    wait_last_eval(ck22, before22g)
    s, st = req('GET', '/api/status')
    bars = {c.get('id'): c for c in st.get('checkinTxs', [])}
    check('22 frozen: the bar is STILL 13 of 25 after the tick (frozen)',
          bars.get(ck22, {}).get('daysSince') == 13 and bars.get(ck22, {}).get('windowDays') == 25, bars.get(ck22))
    check('22 frozen: the card stays on-track (a disarmed tx cannot make it release-due)',
          st.get('state') == 'on-track', st.get('state'))
    t = state_tx(ck22)
    sl = rule_slice(t)
    check('22 frozen: the tick evaluated the disarmed check-in rule (slice on-track, not unknown)',
          sl.get('status') == 'on-track', sl)
    check('22 frozen: the disarmed tx is still un-broadcast',
          t is not None and not t.get('broadcasted') and not t.get('release'), t)
    # Restore the default cadence for the remaining sections.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('22 tick: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 27. shared trigger sets ---
    # One rule set drives several txs: evaluated once per tick; on
    # fire every member broadcasts through the per-tx path. A stale
    # member is skipped and the set keeps firing; only all-stale
    # archives it. Deleting a set returns its txs to standalone. Tick
    # parked.
    def state_set(set_id, base=BASE):
        s, st = req('GET', '/api/state', base=base)
        for x in st.get('bitcoin', {}).get('sets', []):
            if x.get('id') == set_id:
                return x
        return None
    def state_sets(base=BASE):
        s, st = req('GET', '/api/state', base=base)
        return st.get('bitcoin', {}).get('sets', [])
    def add_tx_vout(label, trigger, vout, value, prev=FINNEY, trigger_confirmed=False):
        body = {'txHex': craft_prev(prev, vout, value), 'label': label, 'notes': '', 'trigger': trigger}
        if trigger_confirmed:
            body['triggerConfirmed'] = True
        return req('POST', '/api/bitcoin/txs', body)
    def broadcast_counts():
        _, rp = req('GET', '/__test__/broadcast-count', base=STUB_BASE_P)
        _, rs = req('GET', '/__test__/broadcast-count', base=STUB_BASE_S)
        return rp.get('count', -1), rs.get('count', -1)
    def set_rule_slice(x, i=0):
        ts = (x or {}).get('triggerState')
        if isinstance(ts, list):
            return ts[i] if i < len(ts) else {}
        return ts if isinstance(ts, dict) else {}
    def delete_all_sets(base=BASE):
        for x in state_sets(base):
            req('DELETE', '/api/bitcoin/sets/' + x['id'], base=base)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('27 setup: cadence parked at 3600 s', s == 200, (s, r))
    # (a) Three members with past set-date triggers of their own, in a
    # set whose rule watches FINNEY:1 (unspent): the startup tick
    # evaluates the set once; the members' own triggers are never
    # evaluated and nothing broadcasts.
    s, r = add_tx_vout('Set 27a m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112700, trigger_confirmed=True)
    check('27 single: member 1 adds (own past setdate trigger)', s == 201, (s, r))
    m1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27a m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112701, trigger_confirmed=True)
    check('27 single: member 2 adds (own past setdate trigger)', s == 201, (s, r))
    m2 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27a m3', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 0, 112702, prev=SECOND, trigger_confirmed=True)
    check('27 single: member 3 adds (own past setdate trigger, SECOND:0)', s == 201, (s, r))
    m3 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27a', 'txIds': [m1, m2, m3],
              'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
    check('27 single: set created with 3 members (201)', s == 201, (s, r))
    set27a = r.get('set', {}).get('id') if s == 201 else None
    # The set's trail opens with each member's 'added' (tagged, oldest
    # first), then the creation event.
    hist27a = r.get('set', {}).get('history', []) if s == 201 else []
    check('27 single: set serves its label, members, arm, and backfilled history',
          s == 201 and r.get('set', {}).get('label') == 'Set 27a'
          and r.get('set', {}).get('txIds') == [m1, m2, m3]
          and r.get('set', {}).get('enabled') is True
          and [e.get('type') for e in hist27a] == ['added', 'added', 'added', 'added']
          and hist27a[-1].get('detail') == 'Set created with 3 transactions'
          and {'"Set 27a" - Tx 1', '"Set 27a" - Tx 2', '"Set 27a" - Tx 3'} == {e.get('detail', '').split(':')[0] for e in hist27a[:3]}
          and [e.get('ts') for e in hist27a] == sorted(e.get('ts') for e in hist27a), r.get('set'))
    p0, s0, bp0, bs0 = outspend_counts()
    bc0 = broadcast_counts()
    check('27 single: app restarted (startup tick is the measured evaluation)', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    # Startup tick requests: the freshness check looks up each member
    # input (FINNEY:1, FINNEY:2, SECOND:0), batch first; FINNEY:2 also
    # needs a singular (the stub's FINNEY has two outputs). The set's
    # rule then reads FINNEY:1 from cache. Total: three batch plus one
    # singular, primary only.
    check('27 single: startup tick costs THREE batch + ONE singular requests (freshness refresh of the 3 member inputs), primary only',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 3, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    bc1 = broadcast_counts()
    check('27 single: the startup tick broadcast nothing', bc1 == bc0, (bc0, bc1))
    x = state_set(set27a)
    check('27 single: the set rule reads watching (FINNEY:1 still unspent)',
          set_rule_slice(x).get('status') == 'watching' and set_rule_slice(x).get('reason') == 'still unspent', set_rule_slice(x))
    for mid in (m1, m2, m3):
        t = state_tx(mid)
        check('27 single: member own trigger never evaluated (triggerState stays null)',
              t is not None and t.get('triggerState') is None, (t or {}).get('triggerState'))
    # The rule alone costs one request on a cold cache (a release
    # check runs no freshness refresh).
    s, r = req('POST', '/api/__test__/clear-caches', {'only': ['outspend']})
    check('27 single: outspend cache cleared for the cold rule check', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    s, r, res = release_results()
    check('27 single: release check runs (cold cache)', s == 200, (s, r))
    p1, s1, bp1, bs1 = outspend_counts()
    check('27 single: the set rule alone costs ONE batch request on a cold cache, primary only, no singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # (b) Retarget to a past date: a release check broadcasts all
    # three.
    s, r = req('PUT', '/api/bitcoin/sets/' + set27a,
               {'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
    check('27 fire: set retargeted to a past setdate (trigger confirmed)', s == 200, (s, r))
    bc0 = broadcast_counts()
    s, r, res = release_results()
    check('27 fire: release check runs', s == 200, (s, r))
    check('27 fire: release action is broadcast', r.get('action') == 'broadcast', r.get('action'))
    bc1 = broadcast_counts()
    check('27 fire: all three members broadcast via the primary (3 attempts, none secondary)',
          bc1 == (bc0[0] + 3, bc0[1]), (bc0, bc1))
    for mid in (m1, m2, m3):
        check('27 fire: member broadcast', res.get(mid, {}).get('action') == 'broadcast', res.get(mid))
        t = state_tx(mid)
        check('27 fire: member recorded broadcast', t is not None and bool(t.get('broadcasted')), (t or {}).get('broadcasted'))
    x = state_set(set27a)
    check('27 fire: the set history records the firing',
          [e.get('type') for e in (x or {}).get('history', [])].count('fired') == 1, (x or {}).get('history'))
    delete_all_txs()
    check('27 fire: cleanup leaves no sets (empty sets go with their last tx)',
          state_sets() == [], state_sets())
    # (c) A disarmed set is evaluated but never broadcasts.
    s, r = add_tx_vout('Set 27c m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112710, trigger_confirmed=True)
    check('27 disarmed: member 1 adds', s == 201, (s, r))
    n1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27c m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112711, trigger_confirmed=True)
    check('27 disarmed: member 2 adds', s == 201, (s, r))
    n2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27c', 'txIds': [n1, n2],
              'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
    check('27 disarmed: set created with a past setdate trigger', s == 201, (s, r))
    set27c = r.get('set', {}).get('id') if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/sets/' + set27c, {'enabled': False})
    check('27 disarmed: set disarmed', s == 200 and r.get('set', {}).get('enabled') is False, (s, r))
    bc0 = broadcast_counts()
    s, r, res = release_results()
    check('27 disarmed: release check runs', s == 200, (s, r))
    check('27 disarmed: the set result is skipped (disarmed)',
          res.get(set27c, {}).get('action') == 'skipped' and 'disarmed' in (res.get(set27c, {}).get('reason') or ''), res.get(set27c))
    check('27 disarmed: nothing broadcast', broadcast_counts() == bc0, (bc0, broadcast_counts()))
    x = state_set(set27c)
    check('27 disarmed: the set IS evaluated (triggerState due)',
          set_rule_slice(x).get('status') == 'due', set_rule_slice(x))
    for mid in (n1, n2):
        t = state_tx(mid)
        check('27 disarmed: member not broadcast', t is not None and not t.get('broadcasted'), (t or {}).get('broadcasted'))
    delete_all_txs()
    # (d) Detach one member, then delete the set: its txs return to
    # standalone with their own triggers.
    s, r = add_tx_vout('Set 27d m1', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 1, 112720, trigger_confirmed=True)
    check('27 detach: member 1 adds', s == 201, (s, r))
    d1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27d m2', {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 2, 112721, trigger_confirmed=True)
    check('27 detach: member 2 adds', s == 201, (s, r))
    d2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27d', 'txIds': [d1, d2],
              'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}})
    check('27 detach: set created with a future setdate trigger', s == 201, (s, r))
    set27d = r.get('set', {}).get('id') if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/sets/' + set27d, {'txIds': [d1]})
    check('27 detach: PUT txIds drops member 2', s == 200 and r.get('set', {}).get('txIds') == [d1], (s, r))
    s, r, res = release_results()
    check('27 detach: release check runs', s == 200, (s, r))
    check('27 detach: the dropped member fires on its own trigger now',
          res.get(d2, {}).get('action') == 'broadcast', res.get(d2))
    t = state_tx(d1)
    check('27 detach: the kept member does not broadcast (set trigger is future)',
          t is not None and not t.get('broadcasted'), (t or {}).get('broadcasted'))
    s, r = req('DELETE', '/api/bitcoin/sets/' + set27d)
    check('27 detach: set deleted', s == 200, (s, r))
    check('27 detach: the kept tx survives the set delete (standalone again)',
          state_tx(d1) is not None and state_sets() == [], (state_tx(d1), state_sets()))
    s, r, res = release_results()
    check('27 detach: release check runs after the delete', s == 200, (s, r))
    check('27 detach: the freed member fires on its own trigger now',
          res.get(d1, {}).get('action') == 'broadcast', res.get(d1))
    delete_all_txs()
    # (e) One fine member and one spending FINNEY:0: the fine one
    # broadcasts, the spent one is marked stale, the set stays live.
    s, r = add_tx_vout('Set 27e m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112730)
    check('27 stale: member 1 adds (FINNEY:1, fine)', s == 201, (s, r))
    e1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27e m2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112731)
    check('27 stale: member 2 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
    e2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27e', 'txIds': [e1, e2],
              'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
    check('27 stale: set created with a past setdate trigger', s == 201, (s, r))
    set27e = r.get('set', {}).get('id') if s == 201 else None
    bc0 = broadcast_counts()
    s, r, res = release_results()
    check('27 stale: release check runs', s == 200, (s, r))
    check('27 stale: release action is broadcast (the live member goes out)', r.get('action') == 'broadcast', r.get('action'))
    bc1 = broadcast_counts()
    check('27 stale: exactly one broadcast, via the primary (the stale member is excluded from the firing set)',
          bc1 == (bc0[0] + 1, bc0[1]), (bc0, bc1))
    check('27 stale: the fine member broadcasts', res.get(e1, {}).get('action') == 'broadcast', res.get(e1))
    check('27 stale: the spent member reads stale', res.get(e2, {}).get('action') == 'stale', res.get(e2))
    t = state_tx(e1)
    check('27 stale: the fine member is recorded broadcast', t is not None and bool(t.get('broadcasted')), (t or {}).get('broadcasted'))
    t = state_tx(e2)
    check('27 stale: only the spent member is recorded stale',
          t is not None and (t.get('release') or {}).get('status') == 'stale', (t or {}).get('release'))
    x = state_set(set27e)
    check('27 stale: the set is NOT archived (still present, still live for its remaining member)',
          x is not None and x.get('txIds') == [e1, e2], x)
    check('27 stale: the set history records the member going stale',
          [ev.get('type') for ev in (x or {}).get('history', [])].count('stale') == 1
          and any('"Set 27e" - Tx 2' in (ev.get('detail') or '') for ev in (x or {}).get('history', []) if ev.get('type') == 'stale'), (x or {}).get('history'))
    delete_all_txs()
    # (g) Both members spend FINNEY:0: nothing broadcasts, and the set
    # then reads archived.
    s, r = add_tx_vout('Set 27g m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112750)
    check('27 all-stale: member 1 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
    g1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Set 27g m2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 0, 112751)
    check('27 all-stale: member 2 adds (FINNEY:0, confirmed spent)', s == 201, (s, r))
    g2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27g', 'txIds': [g1, g2],
              'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
    check('27 all-stale: set created with a past setdate trigger', s == 201, (s, r))
    set27g = r.get('set', {}).get('id') if s == 201 else None
    bc0 = broadcast_counts()
    s, r, res = release_results()
    check('27 all-stale: release check runs', s == 200, (s, r))
    check('27 all-stale: release action is stale', r.get('action') == 'stale', r.get('action'))
    check('27 all-stale: nothing broadcast', broadcast_counts() == bc0, (bc0, broadcast_counts()))
    for mid in (g1, g2):
        check('27 all-stale: member reads stale', res.get(mid, {}).get('action') == 'stale', res.get(mid))
        t = state_tx(mid)
        check('27 all-stale: member recorded stale',
              t is not None and (t.get('release') or {}).get('status') == 'stale', (t or {}).get('release'))
    s, r, res = release_results()
    check('27 all-stale: second release check runs', s == 200, (s, r))
    check('27 all-stale: the set reads archived (skipped — all members are stale)',
          res.get(set27g, {}).get('action') == 'skipped' and 'all members are stale' in (res.get(set27g, {}).get('reason') or ''), res.get(set27g))
    check('27 all-stale: the set still exists in state (archived, not deleted)',
          state_set(set27g) is not None, state_sets())
    delete_all_txs()
    # (f) A state file with no sets loads as []; a dangling member is
    # pruned and a member claimed twice stays in the first set.
    stj = load_state_file()
    stj['bitcoin'].pop('sets', None)
    save_state_file(stj)
    check('27 migrate: app restarted with a pre-set state file', restart())
    check('27 migrate: pre-set state loads with sets == []', state_sets() == [], state_sets())
    s, r = add_tx_vout('Set 27f m1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112740)
    check('27 migrate: member adds', s == 201, (s, r))
    f1 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    stj['bitcoin']['sets'] = [
        {'id': 'set_hand1', 'label': 'Hand 1', 'enabled': True, 'txIds': [f1, 'tx_missing'],
         'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}},
        {'id': 'set_hand2', 'label': 'Hand 2', 'enabled': True, 'txIds': [f1],
         'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}},
    ]
    save_state_file(stj)
    check('27 migrate: app restarted with hand-edited sets', restart())
    sets27f = {x['id']: x for x in state_sets()}
    check('27 migrate: the dangling member is pruned, the real one kept',
          sets27f.get('set_hand1', {}).get('txIds') == [f1], sets27f.get('set_hand1'))
    check('27 migrate: a tx in two sets stays only in the first',
          sets27f.get('set_hand2', {}).get('txIds') == [], sets27f.get('set_hand2'))
    # The load-time backfill also runs for a hand-edited set (tag
    # '"Hand 1" - Tx 1').
    handHist27f = sets27f.get('set_hand1', {}).get('history', [])
    check('27 migrate: missing fields defaulted (history seeded + member backfilled, enabled true)',
          sets27f.get('set_hand1', {}).get('enabled') is True
          and [e.get('type') for e in handHist27f] == ['added', 'added']
          and any(e.get('detail') == 'Set created with 1 transaction' for e in handHist27f)
          and any(e.get('detail', '').startswith('"Hand 1" - Tx 1:') for e in handHist27f), sets27f.get('set_hand1'))
    # (h) The Add flow: each entry is posted with the shared trigger
    # (dormant while in the set, used if the set is deleted), then the
    # set in one POST. Create with two, edit to add a third and drop
    # one (it returns to standalone), delete the set, and the rest
    # fall back to their own trigger.
    shared27h = {'op': 'OR', 'rules': [{'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}]}
    # A one-rule set is served as its single rule.
    shared_rule27h = {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 112760), 'trigger': shared27h})
    check('27 add-set: member 1 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
    h1 = r['tx']['id'] if s == 201 else None
    t = state_tx(h1) if h1 else None
    check('27 add-set: member 1 keeps the shared trigger (not the 35-day default)',
          t is not None and t.get('trigger') == shared_rule27h, (t or {}).get('trigger'))
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 2, 112761), 'trigger': shared27h})
    check('27 add-set: member 2 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
    h2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 27h', 'txIds': [h1, h2], 'trigger': shared27h, 'enabled': True})
    check('27 add-set: set created with BOTH members and the ONE label in one call (201)', s == 201, (s, r))
    set27h = r.get('set', {}).get('id') if s == 201 else None
    x = state_set(set27h) if set27h else None
    check('27 add-set: the set serves both members under that label',
          x is not None and x.get('txIds') == [h1, h2] and x.get('label') == 'Set 27h', (x or {}).get('txIds'))
    check('27 add-set: the set carries the shared trigger',
          x is not None and x.get('trigger') == shared_rule27h, (x or {}).get('trigger'))
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 112762), 'trigger': shared27h})
    check('27 add-set: member 3 adds with the SHARED trigger in the body (201)', s == 201, (s, r))
    h3 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/sets/' + set27h, {'txIds': [h1, h2, h3]})
    check('27 add-set: edit adds a third member (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [h1, h2, h3], (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27h, {'txIds': [h1, h3]})
    check('27 add-set: edit drops member 2 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [h1, h3], (s, r))
    t = state_tx(h2)
    check('27 add-set: the dropped member is standalone again with its own trigger, never deleted',
          t is not None and t.get('trigger') == shared_rule27h, (t or {}).get('trigger'))
    s, r = req('DELETE', '/api/bitcoin/sets/' + set27h)
    check('27 add-set: deleting the set (200)', s == 200, (s, r))
    t1 = state_tx(h1); t3 = state_tx(h3)
    check('27 add-set: the remaining members fall back to their own trigger after the set is deleted',
          t1 is not None and t1.get('trigger') == shared_rule27h
          and t3 is not None and t3.get('trigger') == shared_rule27h
          and not any(h1 in (x.get('txIds') or []) or h3 in (x.get('txIds') or []) for x in state_sets()),
          ((t1 or {}).get('trigger'), (t3 or {}).get('trigger')))
    delete_all_txs()
    delete_all_sets()
    # (i) One history per card (the set's): member events are
    # forwarded, tagged; the set's trail opens with its members'; a
    # member's own history survives the set's delete.
    s, r = add_tx_vout('Dom Single M1', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 1, 112800)
    check('27 single-hist: member 1 adds (future setdate)', s == 201, (s, r))
    i1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx_vout('Dom Single M2', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 2, 112801)
    check('27 single-hist: member 2 adds (future setdate)', s == 201, (s, r))
    i2 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Dom Single Set', 'txIds': [i1, i2],
              'trigger': {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}})
    check('27 single-hist: set created with 2 members (201)', s == 201, (s, r))
    set27i = r.get('set', {}).get('id') if s == 201 else None
    hist27i = r.get('set', {}).get('history', []) if s == 201 else []
    check('27 single-hist: creation backfills both members, creation event last, chronological',
          [e.get('type') for e in hist27i] == ['added', 'added', 'added']
          and hist27i[-1].get('detail') == 'Set created with 2 transactions'
          and {'"Dom Single Set" - Tx 1', '"Dom Single Set" - Tx 2'} == {e.get('detail', '').split(':')[0] for e in hist27i[:2]}
          and [e.get('ts') for e in hist27i] == sorted(e.get('ts') for e in hist27i), hist27i)
    s, r = req('PUT', '/api/bitcoin/txs/' + i1, {'notes': 'edited note'})
    check('27 single-hist: member 1 notes edited (200)', s == 200, (s, r))
    t = state_tx(i1)
    check('27 single-hist: the edit lands on the member own history',
          t is not None and any(e.get('type') == 'edited' and e.get('detail') == 'Notes changed' for e in (t or {}).get('history', [])), (t or {}).get('history'))
    x = state_set(set27i)
    check('27 single-hist: the edit is forwarded to the set history, tagged, exactly once',
          x is not None and [e.get('detail') for e in (x or {}).get('history', []) if e.get('type') == 'edited'].count('"Dom Single Set" - Tx 1: Notes changed') == 1, (x or {}).get('history'))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'enabled': False})
    check('27 single-hist: set disarmed', s == 200 and r.get('set', {}).get('enabled') is False, (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'enabled': True})
    check('27 single-hist: set re-armed', s == 200 and r.get('set', {}).get('enabled') is True, (s, r))
    x = state_set(set27i)
    check('27 single-hist: arm/disarm logs once each on the set history, never member-tagged',
          x is not None
          and [e.get('type') for e in (x or {}).get('history', [])].count('disarmed') == 1
          and [e.get('type') for e in (x or {}).get('history', [])].count('armed') == 1
          and all(e.get('detail') == '' for e in (x or {}).get('history', []) if e.get('type') in ('armed', 'disarmed')), (x or {}).get('history'))
    s, r = add_tx_vout('Dom Single M3', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 3, 112802)
    check('27 single-hist: member 3 adds (future setdate)', s == 201, (s, r))
    i3 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + i3, {'notes': 'third note'})
    check('27 single-hist: member 3 notes edited (200)', s == 200, (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i3]})
    check('27 single-hist: edit attaches member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i3], (s, r))
    x = state_set(set27i)
    hist27i = (x or {}).get('history', [])
    check('27 single-hist: attach backfills member 3 history before the Members changed event',
          any('"Dom Single Set" - Tx 3' in e.get('detail', '') and e.get('type') == 'added' for e in hist27i)
          and any(e.get('detail') == '"Dom Single Set" - Tx 3: Notes changed' for e in hist27i)
          and hist27i[-1].get('type') == 'edited' and 'Members changed (+1)' in hist27i[-1].get('detail', ''), hist27i)
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
    check('27 single-hist: edit drops member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i3]})
    check('27 single-hist: edit re-attaches member 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i3], (s, r))
    x = state_set(set27i)
    hist27i = (x or {}).get('history', [])
    check('27 single-hist: re-attach does NOT duplicate member 3 history',
          sum(1 for e in hist27i if e.get('detail', '').startswith('"Dom Single Set" - Tx 3')) == 2, hist27i)
    # A label-less member is tagged by its set, never "Untitled
    # transaction".
    s, r = add_tx_vout('', {'type': 'setdate', 'params': {'fireAt': '2999-01-01T00:00:00.000Z'}}, 4, 112803)
    check('27 single-hist: label-less member adds (future setdate)', s == 201, (s, r))
    i4 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2, i4]})
    check('27 single-hist: label-less member attaches as Tx 3 (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2, i4], (s, r))
    s, r = req('PUT', '/api/bitcoin/txs/' + i4, {'notes': 'fourth note'})
    check('27 single-hist: label-less member notes edited (200)', s == 200, (s, r))
    x = state_set(set27i)
    hist27i = (x or {}).get('history', [])
    check('27 single-hist: the label-less edit is tagged "Dom Single Set" - Tx 3, never Untitled',
          any(e.get('detail') == '"Dom Single Set" - Tx 3: Notes changed' for e in hist27i)
          and not any('Untitled transaction' in e.get('detail', '') for e in hist27i), hist27i)
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
    check('27 single-hist: label-less member dropped again (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i, {'txIds': [i1, i2]})
    check('27 single-hist: member 3 dropped again before the fire (PUT txIds, 200)', s == 200 and r.get('set', {}).get('txIds') == [i1, i2], (s, r))
    s, r = req('PUT', '/api/bitcoin/sets/' + set27i,
               {'trigger': {'type': 'setdate', 'params': {'fireAt': '2020-01-01T00:00:00.000Z'}}, 'triggerConfirmed': True})
    check('27 single-hist: set retargeted to a past setdate (trigger confirmed)', s == 200, (s, r))
    s, r, res = release_results()
    check('27 single-hist: release check runs', s == 200, (s, r))
    check('27 single-hist: release action is broadcast', r.get('action') == 'broadcast', r.get('action'))
    x = state_set(set27i)
    hist27i = (x or {}).get('history', [])
    check('27 single-hist: both member broadcasts are forwarded, tagged',
          [e.get('type') for e in hist27i].count('broadcast') == 2
          and {'"Dom Single Set" - Tx 1', '"Dom Single Set" - Tx 2'} == {e.get('detail', '').split(':')[0] for e in hist27i if e.get('type') == 'broadcast'}, hist27i)
    check('27 single-hist: exactly ONE fired event (no duplicate from member forwarding)',
          [e.get('type') for e in hist27i].count('fired') == 1, hist27i)
    s, r = req('DELETE', '/api/bitcoin/sets/' + set27i)
    check('27 single-hist: set deleted', s == 200, (s, r))
    t1 = state_tx(i1); t2 = state_tx(i2); t3 = state_tx(i3)
    check('27 single-hist: deleting the set leaves each member own history intact and full',
          t1 is not None and [e.get('type') for e in t1.get('history', [])] == ['added', 'edited', 'broadcast']
          and t2 is not None and [e.get('type') for e in t2.get('history', [])] == ['added', 'broadcast']
          and t3 is not None and [e.get('type') for e in t3.get('history', [])] == ['added', 'edited'],
          ((t1 or {}).get('history'), (t2 or {}).get('history'), (t3 or {}).get('history')))
    delete_all_txs()
    delete_all_sets()
    # --- 28. not-found broadcast txs get a stale/conflict verdict ---
    # FINNEY:0 is spent-confirmed (stale); CONFLICT:0 is spent-
    # unconfirmed on the primary (conflict). Both are seeded as
    # broadcast via the state file. The startup tick's hourly refresh
    # records the verdicts.
    CONFLICT = 'cc' * 32
    CONFLICT_SPENDER = 'dd' * 32
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('28 setup: cadence parked at 3600 s', s == 200, (s, r))
    check('28 setup: caches cleared for a cold cache', clear_caches())
    FROZEN28 = iso_ago(hours=2)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 112800), 'label': 'Stale NF', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('28 stale: the FINNEY:0 tx adds', s == 201, (s, r))
    stale28 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(CONFLICT, 0, 112801), 'label': 'Conflict NF', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('28 conflict: the CONFLICT:0 tx adds', s == 201, (s, r))
    conflict28 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
    for tx_id in (stale28, conflict28):
        t = by_id.get(tx_id)
        t['broadcasted'] = {'txid': t.get('txid'), 'broadcastedAt': FROZEN28, 'method': 'mempool.space',
                            'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': FROZEN28}
        t['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'manual',
                        'txid': t.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN28}
    save_state_file(stj)
    check('28 setup: app restarted with the seeded not-found txs', restart())
    # Poll until the startup tick's merge has refreshed the seeded tx,
    # so it cannot race the endpoint's.
    wait_until(lambda: ((state_tx(stale28) or {}).get('broadcasted') or {}).get('checkedAt') != FROZEN28, deadline=5)
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('28 refresh: the confirmations endpoint runs', s == 200, (s, r))
    conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
    check('28 stale: the refresh reports the tx not found, with a stale verdict',
          conf_by_id.get(stale28, {}).get('found') is False
          and conf_by_id.get(stale28, {}).get('staleInput', {}).get('spentBy') == 'aabbccdd'
          and conf_by_id.get(stale28, {}).get('staleInput', {}).get('blockHeight') == 899990,
          conf_by_id.get(stale28))
    check('28 conflict: the refresh reports the tx not found, with a conflict verdict',
          conf_by_id.get(conflict28, {}).get('found') is False
          and conf_by_id.get(conflict28, {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER
          and not conf_by_id.get(conflict28, {}).get('staleInput'),
          conf_by_id.get(conflict28))
    t = state_tx(stale28)
    check('28 stale: the verdict is stored on the broadcasted fact',
          t is not None and (t.get('broadcasted') or {}).get('staleInput', {}).get('spentBy') == 'aabbccdd'
          and (t.get('broadcasted') or {}).get('staleInput', {}).get('blockHeight') == 899990, (t or {}).get('broadcasted'))
    check('28 stale: the transition logs exactly one stale history event',
          t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
    t = state_tx(conflict28)
    check('28 conflict: the verdict is stored, and no stale event is logged',
          t is not None and (t.get('broadcasted') or {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER
          and 'stale' not in [e.get('type') for e in t.get('history', [])], (t or {}).get('broadcasted'))
    # Force a second refresh: the conflict re-checks; the stale one is
    # never re-checked or re-logged.
    stj = load_state_file()
    by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
    for tx_id in (stale28, conflict28):
        by_id[tx_id]['broadcasted']['checkedAt'] = FROZEN28
    save_state_file(stj)
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('28 refresh again: the endpoint runs', s == 200, (s, r))
    t = state_tx(stale28)
    check('28 stale: the second refresh logs no duplicate stale event',
          t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
    t = state_tx(conflict28)
    check('28 conflict: the second refresh still reads conflict',
          t is not None and (t.get('broadcasted') or {}).get('conflictInput', {}).get('spentBy') == CONFLICT_SPENDER, (t or {}).get('broadcasted'))
    delete_all_txs()
    # Cleanup: cadence back to 60.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('27 cleanup: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 29. archived broadcast txs show a derived confirmation count
    # ---
    # Past 6 confirmations the count is derived from the confirming
    # height and the cached tip (one tip fetch for all, zero on a
    # hit); the stored snapshot is never overwritten. Below 6, txs are
    # still re-queried.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('29 setup: cadence parked at 3600 s', s == 200, (s, r))
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
    check('29 setup: caches cleared for a cold tip cache', clear_caches())
    FROZEN29 = iso_ago(hours=2)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 3, 112900), 'label': 'Derived Arch', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('29 derived: the FINNEY:3 tx adds', s == 201, (s, r))
    arch29 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
    arch_tx = by_id.get(arch29)
    arch_tx['broadcasted'] = {'txid': arch_tx.get('txid'), 'broadcastedAt': FROZEN29, 'method': 'mempool.space',
                              'confirmations': 7, 'blockHeight': 899993, 'found': True, 'checkedAt': FROZEN29}
    arch_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'manual',
                          'txid': arch_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN29}
    save_state_file(stj)
    check('29 setup: app restarted with the seeded archived tx', restart())
    # No wait: the archived tx is never touched by the refresh.
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('29 refresh: the confirmations endpoint runs', s == 200, (s, r))
    conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
    check('29 derived: the endpoint returns tip - block + 1 (900000 - 899993 + 1 = 8), not the stored 7',
          conf_by_id.get(arch29, {}).get('confirmations') == 8
          and conf_by_id.get(arch29, {}).get('blockHeight') == 899993
          and conf_by_id.get(arch29, {}).get('found') is True, conf_by_id.get(arch29))
    t = state_tx(arch29)
    check('29 stored: the stored snapshot is untouched (still 7, checkedAt still frozen)',
          t is not None and (t.get('broadcasted') or {}).get('confirmations') == 7
          and (t.get('broadcasted') or {}).get('checkedAt') == FROZEN29, (t or {}).get('broadcasted'))
    # Move the stub tip and restart (cold tip cache): the derived
    # count follows; the stored snapshot stays.
    s, r = req('POST', '/__test__/tip', {'height': 900010}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip', {'height': 900010}, base=STUB_BASE_S)
    check('29 setup: caches cleared for a cold tip cache after the tip move', clear_caches())
    # No wait: the endpoint fetches the tip itself.
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('29 refresh after tip move: the endpoint runs', s == 200, (s, r))
    conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
    check('29 derived: the count follows the tip (900010 - 899993 + 1 = 18)',
          conf_by_id.get(arch29, {}).get('confirmations') == 18, conf_by_id.get(arch29))
    t = state_tx(arch29)
    check('29 stored: the stored snapshot is still 7 after the tip move',
          t is not None and (t.get('broadcasted') or {}).get('confirmations') == 7, (t or {}).get('broadcasted'))
    # Fallback: with no tip available at all (both stubs fail
    # the tip read), the endpoint returns the stored count.
    s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_S)
    check('29 setup: caches cleared with both stubs failing the tip read', clear_caches())
    # (Optimization O8) No wait: the endpoint falls back to the
    # stored count itself — the old 3 s sleep bought nothing.
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('29 refresh with no tip: the endpoint runs', s == 200, (s, r))
    conf_by_id = {c.get('id'): c for c in r.get('confirmations', [])}
    check('29 fallback: with no tip available the endpoint returns the stored 7',
          conf_by_id.get(arch29, {}).get('confirmations') == 7, conf_by_id.get(arch29))
    # Cleanup: stubs back to the fixed tip, tip reads working,
    # cadence back to 60.
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('29 cleanup: settings and cadence restored', s == 200, (s, r))
    delete_all_txs()

    # --- 30. staged txs go stale on the hourly refresh ---
    # A confirmed spend marks a live staged tx stale (kind 'release',
    # one history event, a note on its set); an unconfirmed spend
    # changes nothing; an already-stale tx is not re-checked.
    CONFLICT = 'cc' * 32
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('30 setup: cadence parked at 3600 s', s == 200, (s, r))
    check('30 setup: caches cleared for a cold cache', clear_caches())
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 113000), 'label': 'Stale staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('30 stale: the FINNEY:0 staged tx adds', s == 201, (s, r))
    stale30 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 113001), 'label': 'Live staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('30 live: the FINNEY:1 staged tx adds', s == 201, (s, r))
    live30 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(CONFLICT, 0, 113002), 'label': 'Conflict staged', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('30 conflict: the CONFLICT:0 staged tx adds', s == 201, (s, r))
    conflict30 = r['tx']['id'] if s == 201 else None
    # A set with one stale and one live member: the stale one is noted
    # on its own and the set's history; the set stays live.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 0, 113003), 'label': 'Set stale m', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('30 set: the stale member adds', s == 201, (s, r))
    sm30 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft_prev(FINNEY, 1, 113004), 'label': 'Set live m', 'notes': '', 'trigger': {'type': 'manual', 'params': {}}})
    check('30 set: the live member adds', s == 201, (s, r))
    lm30 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'Set 30', 'txIds': [sm30, lm30],
              'trigger': {'type': 'manual', 'params': {}}, 'enabled': True})
    check('30 set: set created with 2 members (201)', s == 201, (s, r))
    set30 = r.get('set', {}).get('id') if s == 201 else None
    check('30 setup: app restarted (startup hourly tick is the refresh)', restart())
    # Poll until the tx is marked stale.
    wait_until(lambda: ((state_tx(stale30) or {}).get('release') or {}).get('status') == 'stale', deadline=5)
    t = state_tx(stale30)
    check('30 stale: the staged tx is marked stale by the hourly refresh',
          t is not None and (t.get('release') or {}).get('status') == 'stale'
          and (t.get('release') or {}).get('kind') == 'release'
          and (t.get('release') or {}).get('method') == 'primary'
          and (t.get('release') or {}).get('error', '').startswith('inputs spent: '), (t or {}).get('release'))
    check('30 stale: exactly one stale history event',
          t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
    t = state_tx(live30)
    check('30 live: the unspent staged tx is untouched (no release record, no stale event)',
          t is not None and not t.get('release')
          and 'stale' not in [e.get('type') for e in t.get('history', [])], t)
    t = state_tx(conflict30)
    check('30 conflict: the unconfirmed spend changes nothing (no release record, no stale event)',
          t is not None and not t.get('release')
          and 'stale' not in [e.get('type') for e in t.get('history', [])], t)
    t = state_tx(sm30)
    check('30 set: the stale member is marked stale on its own history',
          t is not None and (t.get('release') or {}).get('status') == 'stale'
          and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
    s, st = req('GET', '/api/state')
    setj = [x for x in st.get('bitcoin', {}).get('sets', []) if x.get('id') == set30]
    check('30 set: the set notes the stale member on its shared history, once',
          len(setj) == 1 and [e.get('type') for e in setj[0].get('history', [])].count('stale') == 1, setj[0].get('history') if setj else None)
    t = state_tx(lm30)
    check('30 set: the live member is untouched, so the set stays live',
          t is not None and not t.get('release'), t)
    # No re-check: with only the stale tx left, the next startup tick
    # makes no outspend request.
    for tid in (live30, conflict30, sm30, lm30):
        s, r = req('DELETE', '/api/bitcoin/txs/' + tid)
    p0, s0, bp0, bs0 = outspend_counts()
    check('30 no-recheck: app restarted with only the stale tx left', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('30 no-recheck: the second hourly tick costs ZERO outspend requests for the already-stale tx',
          (p1, s1, bp1, bs1) == (p0, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    t = state_tx(stale30)
    check('30 no-recheck: still exactly one stale history event after the second tick',
          t is not None and [e.get('type') for e in t.get('history', [])].count('stale') == 1, (t or {}).get('history'))
    # Cleanup: cadence back to 60.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('30 cleanup: settings and cadence restored', s == 200, (s, r))
    delete_all_txs()
