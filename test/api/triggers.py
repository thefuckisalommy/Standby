"""API suite: Block height, set date, fee market, grace and vacation (sections 1-8)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 1. health + version ----------------------------------------
    s, h = req('GET', '/api/health')
    check('1 health reports version 0.8.14', h.get('version') == '0.8.14', h)

    # --- 2. block-height trigger --------------------------------------
    # Validation at add: bad heights rejected, good ones accepted.
    bad_heights = [
        ({'type': 'blockheight', 'params': {}}, 'missing targetHeight'),
        ({'type': 'blockheight', 'params': {'targetHeight': 0}}, 'zero'),
        ({'type': 'blockheight', 'params': {'targetHeight': -5}}, 'negative'),
        ({'type': 'blockheight', 'params': {'targetHeight': 1.5}}, 'non-integer'),
        ({'type': 'blockheight', 'params': {'targetHeight': '900000'}}, 'string'),
        ({'type': 'blockheight', 'params': {'targetHeight': 10000001}}, 'over max'),
    ]
    for i, (trig, label) in enumerate(bad_heights):
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110000 + i * 2), 'label': 'bad bh ' + label, 'trigger': trig})
        check('2 blockheight validation rejects %s (400)' % label, s == 400, (s, r))
    s, r = add_tx('BH future', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 110100)
    check('2 blockheight add: future height accepted (201)', s == 201, (s, r))
    bh_future = r['tx']['id'] if s == 201 else None
    # checkTriggerNow: future height watches, past height fires + warns.
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}})
    check('2 blockheight check: future height watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
    check('2 blockheight check: past height fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
    # The add-time guard: an already-reached height is blocked
    # unless triggerConfirmed is set.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110102), 'label': 'BH past no confirm', 'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
    check('2 blockheight add: past height blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
    s, r = add_tx('BH past', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 110104, trigger_confirmed=True)
    check('2 blockheight add: past height accepted with triggerConfirmed (201)', s == 201, (s, r))
    bh_past = r['tx']['id'] if s == 201 else None
    # Evaluation via the manual release check: the past height
    # broadcasts, the future one does not.
    s, r, res = release_results()
    check('2 blockheight release: past height broadcasts', s == 200 and res.get(bh_past, {}).get('action') == 'broadcast', res.get(bh_past))
    check('2 blockheight release: future height does not broadcast', res.get(bh_future, {}).get('action') != 'broadcast', res.get(bh_future))
    # The future tx's triggerStatus shows watching with the tip.
    t = state_tx(bh_future)
    check('2 blockheight status: future tx is watching with the tip height',
          t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastTipHeight') == STUB_TIP, t.get('triggerStatus') if t else None)
    delete_all_txs()

    # --- 2c. block-height: no latch ---
    # Judged fresh every evaluation: a reorg below the target un-fires
    # it.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('2c tick: cadence set to 10 s', s == 200, (s, r))
    # (a) The check endpoint judges the current tip (through the per-
    # tick tip cache).
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
    check('2c no-latch check: tip above target fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
    # Clear the tip cache so the check reads the new stub tip at once.
    check('2c tip cache cleared so the check reads the new tip', clear_caches())
    check('2c primary stub tip dropped to 700000', s == 200 and r.get('height') == STUB_TIP - 200000, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}})
    check('2c no-latch check: reorged tip no longer fires', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    # Clear the tip cache so the next tick fetches the restored
    # tip instead of writing the stale cached one.
    check('2c tip cache cleared so the next tick fetches the restored tip', clear_caches())
    check('2c primary stub tip restored to 900000', s == 200 and r.get('height') == STUB_TIP, r)
    # (b) The tick writes fresh slices for a disarmed tx: due
    # while the tip is past the target, watching after the reorg.
    s, r = add_tx('BH nolatch', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 110108, trigger_confirmed=True)
    check('2c no-latch add: past height accepted with triggerConfirmed (201)', s == 201, (s, r))
    bh_nl = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'enabled': False})
    check('2c no-latch: disarmed at once (200)', s == 200, (s, r))
    wait_slice(bh_nl, {'status': 'due', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
    t = state_tx(bh_nl)
    sl = rule_slice(t)
    check('2c no-latch slice: disarmed tx is due with the tip past the target',
          sl.get('status') == 'due' and sl.get('lastTipHeight') == STUB_TIP, sl)
    check('2c no-latch status: live status is due (no latch needed)',
          t and t.get('triggerStatus', {}).get('status') == 'due', t.get('triggerStatus') if t else None)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
    check('2c primary stub tip dropped to 700000 (again)', s == 200 and r.get('height') == STUB_TIP - 200000, r)
    # Clear the tip cache so the next tick fetches the dropped
    # tip instead of the cached one.
    check('2c tip cache cleared so the next tick fetches the dropped tip', clear_caches())
    wait_slice(bh_nl, {'status': 'watching', 'lastTipHeight': STUB_TIP - 200000})  # one full tick at the 10 s cadence
    t = state_tx(bh_nl)
    sl = rule_slice(t)
    check('2c no-latch slice: the reorg un-fires it (watching, tip 700000)',
          sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP - 200000, sl)
    check('2c no-latch status: live status is watching after the reorg',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    # The check endpoint reads the per-tick tip cache — clear
    # it so the check below reads the new stub tip at once.
    check('2c tip cache cleared so the check reads the new tip (again)', clear_caches())
    check('2c primary stub tip restored to 900000 (again)', s == 200 and r.get('height') == STUB_TIP, r)
    # (c) An AND set [blockheight, price] stops firing when the tip
    # drops.
    and_bh = {'op': 'AND', 'rules': [{'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}},
                                   {'type': 'price', 'params': {'op': '>=', 'value': 90000}}]}
    s, r = req('POST', '/api/triggers/check', {'trigger': and_bh})
    check('2c no-latch AND check: height reached + price holding fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP - 200000}, base=STUB_BASE_P)
    # The check endpoint reads the per-tick tip cache — clear
    # it so the check below reads the new stub tip at once.
    check('2c tip cache cleared so the check reads the new tip (AND)', clear_caches())
    check('2c primary stub tip dropped to 700000 (AND)', s == 200 and r.get('height') == STUB_TIP - 200000, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': and_bh})
    check('2c no-latch AND check: reorged height un-fires the set', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    # Clear the tip cache so the next tick fetches the restored
    # tip instead of writing the stale cached one.
    check('2c tip cache cleared so the next tick fetches the restored tip (AND)', clear_caches())
    check('2c primary stub tip restored to 900000 (AND)', s == 200 and r.get('height') == STUB_TIP, r)
    # (d) Editing the target starts fresh: the edited rule is
    # judged against the NEW target, with no memory of the old one.
    s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}})
    check('2c no-latch edit: retarget above the tip saves (200)', s == 200, (s, r))
    wait_slice(bh_nl, {'status': 'watching', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
    t = state_tx(bh_nl)
    sl = rule_slice(t)
    check('2c no-latch edit: retargeted rule is watching (tip 900000 of 950000)',
          sl.get('status') == 'watching' and sl.get('lastTipHeight') == STUB_TIP, sl)
    s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100000}}, 'triggerConfirmed': True})
    check('2c no-latch edit: retarget back below the tip saves with confirmation (200)', s == 200, (s, r))
    wait_slice(bh_nl, {'status': 'due', 'lastTipHeight': STUB_TIP})  # one full tick at the 10 s cadence
    t = state_tx(bh_nl)
    sl = rule_slice(t)
    check('2c no-latch edit: retargeted rule is due again (tip 900000 of 800000)',
          sl.get('status') == 'due' and sl.get('lastTipHeight') == STUB_TIP, sl)
    # (e) A disarmed tx past its target does not broadcast; re-armed,
    # it does on the next check.
    s, r, res = release_results()
    check('2c no-latch safety: manual check lists the disarmed due tx as skipped',
          res.get(bh_nl, {}).get('action') == 'skipped', res.get(bh_nl))
    t = state_tx(bh_nl)
    check('2c no-latch safety: the disarmed due tx is still un-broadcast',
          t is not None and not t.get('broadcasted') and not t.get('release'), t)
    s, r = req('PUT', '/api/bitcoin/txs/' + bh_nl, {'enabled': True})
    check('2c no-latch rearm: the tx re-arms (200)', s == 200 and r.get('tx', {}).get('enabled') is True, r)
    s, r, res = release_results()
    check('2c no-latch rearm: re-armed tx broadcasts with the tip past the target',
          s == 200 and res.get(bh_nl, {}).get('action') == 'broadcast', res.get(bh_nl))
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('2c tick: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 2b. block-height: the primary's tip decides ---
    # The secondary runs 1000 blocks ahead; a target between them
    # watches. The add gate agrees.
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP + 1000}, base=STUB_BASE_S)
    check('2b secondary stub tip set to 901000', s == 200 and r.get('height') == STUB_TIP + 1000, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
    check('2b check: target between the two tips watches (primary has not reached it)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 100}}})
    check('2b check: target below the primary tip fires', s == 200 and r.get('fire') is True, r)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110106), 'label': 'BH primary no confirm', 'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
    check('2b add: target above the primary tip accepted without triggerConfirmed (201)', s == 201, (s, r))
    bh_primary = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('2b release: target above the primary tip does not broadcast', res.get(bh_primary, {}).get('action') != 'broadcast', res.get(bh_primary))
    # One node down: the other alone still decides. Primary down,
    # secondary alone at 901000: the between target now fires.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
    check('2b primary pointed at a closed port', s == 200, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 500}}})
    check('2b check: primary down, secondary past target fires', s == 200 and r.get('fire') is True, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 2000}}})
    check('2b check: primary down, target above the secondary watches', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P})
    check('2b primary restored to the stub', s == 200, (s, r))
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
    check('2b secondary stub tip restored to 900000', s == 200 and r.get('height') == STUB_TIP, r)
    delete_all_txs()

    # --- 3. set-date trigger ------------------------------------------
    bad_dates = [
        ({'type': 'setdate', 'params': {}}, 'missing fireAt'),
        ({'type': 'setdate', 'params': {'fireAt': 'not a date'}}, 'invalid date'),
        ({'type': 'setdate', 'params': {'fireAt': 12345}}, 'non-string'),
    ]
    for i, (trig, label) in enumerate(bad_dates):
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110200 + i * 2), 'label': 'bad sd ' + label, 'trigger': trig})
        check('3 setdate validation rejects %s (400)' % label, s == 400, (s, r))
    future_date = iso_in(days=30)
    s, r = add_tx('SD future', {'type': 'setdate', 'params': {'fireAt': future_date}}, 110300)
    check('3 setdate add: future date accepted (201)', s == 201, (s, r))
    sd_future = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'setdate', 'params': {'fireAt': future_date}}})
    check('3 setdate check: future date watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    past_date = iso_ago(days=1)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'setdate', 'params': {'fireAt': past_date}}})
    check('3 setdate check: past date fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110302), 'label': 'SD past no confirm', 'trigger': {'type': 'setdate', 'params': {'fireAt': past_date}}})
    check('3 setdate add: past date blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
    s, r = add_tx('SD past', {'type': 'setdate', 'params': {'fireAt': past_date}}, 110304, trigger_confirmed=True)
    check('3 setdate add: past date accepted with triggerConfirmed (201)', s == 201, (s, r))
    sd_past = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('3 setdate release: past date broadcasts', s == 200 and res.get(sd_past, {}).get('action') == 'broadcast', res.get(sd_past))
    check('3 setdate release: future date does not broadcast', res.get(sd_future, {}).get('action') != 'broadcast', res.get(sd_future))
    t = state_tx(sd_future)
    check('3 setdate status: future tx is watching',
          t and t.get('triggerStatus', {}).get('status') == 'watching', t.get('triggerStatus') if t else None)
    delete_all_txs()

    # --- 4. fee-market trigger ---
    # The stub's economy fee is 1 sat/vB: a threshold >= 1 fires,
    # below watches.
    bad_rates = [
        ({'type': 'feemarket', 'params': {}}, 'missing maxFeeRate'),
        ({'type': 'feemarket', 'params': {'maxFeeRate': 0}}, 'zero'),
        ({'type': 'feemarket', 'params': {'maxFeeRate': -1}}, 'negative'),
        ({'type': 'feemarket', 'params': {'maxFeeRate': '5'}}, 'string'),
        ({'type': 'feemarket', 'params': {'maxFeeRate': 10001}}, 'over max'),
    ]
    for i, (trig, label) in enumerate(bad_rates):
        s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110400 + i * 2), 'label': 'bad fm ' + label, 'trigger': trig})
        check('4 feemarket validation rejects %s (400)' % label, s == 400, (s, r))
    s, r = add_tx('FM low', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 110500)
    check('4 feemarket add: threshold below the economy fee accepted (201)', s == 201, (s, r))
    fm_low = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}})
    check('4 feemarket check: below the economy fee watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
    check('4 feemarket check: at/above the economy fee fires + warns', s == 200 and r.get('fire') is True and r.get('warning'), r)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110502), 'label': 'FM high no confirm', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5}}})
    check('4 feemarket add: threshold at/above the fee blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r), (s, r))
    s, r = add_tx('FM high', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110504, trigger_confirmed=True)
    check('4 feemarket add: threshold at/above the fee accepted with triggerConfirmed (201)', s == 201, (s, r))
    fm_high = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('4 feemarket release: threshold at/above the fee broadcasts', s == 200 and res.get(fm_high, {}).get('action') == 'broadcast', res.get(fm_high))
    check('4 feemarket release: threshold below the fee does not broadcast', res.get(fm_low, {}).get('action') != 'broadcast', res.get(fm_low))
    t = state_tx(fm_low)
    check('4 feemarket status: low-threshold tx is watching with the economy fee',
          t and t.get('triggerStatus', {}).get('status') == 'watching' and t.get('triggerStatus', {}).get('lastEconomyFee') == STUB_ECONOMY_FEE, t.get('triggerStatus') if t else None)

    # --- 4b. fee-market direction ---
    # 'above' 0.5 fires, 5 watches. No direction means 'below'; a bad
    # one is rejected.
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}})
    check('4b feemarket above: threshold below the fee fires (fire=true)', s == 200 and r.get('fire') is True and r.get('warning'), r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'above'}}})
    check('4b feemarket above: threshold above the fee watches (fire=false)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110506), 'label': 'FM above no confirm', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}})
    check('4b feemarket above: already-satisfied add blocked without triggerConfirmed (400)', s == 400 and 'would fire' in str(r) and 'at or above' in str(r), (s, r))
    s, r = add_tx('FM above', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5, 'direction': 'above'}}, 110508, trigger_confirmed=True)
    check('4b feemarket above: already-satisfied add accepted with triggerConfirmed (201)', s == 201, (s, r))
    fm_above = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(1, 110510), 'label': 'bad fm dir', 'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'sideways'}}})
    check('4b feemarket validation rejects a bad direction (400)', s == 400, (s, r))
    s, r, res = release_results()
    check('4b feemarket above: threshold below the fee broadcasts', s == 200 and res.get(fm_above, {}).get('action') == 'broadcast', res.get(fm_above))
    t = state_tx(fm_above)
    check('4b feemarket above: stored params carry direction above',
          t and t.get('trigger', {}).get('params', {}).get('direction') == 'above', t.get('trigger') if t else None)
    t = state_tx(fm_low)
    check('4b feemarket default: a rule added without direction reads as below',
          t and t.get('trigger', {}).get('params', {}).get('direction') == 'below', t.get('trigger') if t else None)
    delete_all_txs()

    # --- 4c. fee-market trigger: two-node logic, primary decides ---
    # The stubs' fees are driven apart; each change is followed by a
    # restart to clear the 5-minute fee cache. The primary's fee
    # counts; the secondary is only a fallback.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('4c two-node fees: cadence set to 10 s', s == 200, (s, r))
    # Close: primary 5, secondary 4.5; both directions use the
    # primary.
    s, r = req('POST', '/__test__/fees', {'economyFee': 5}, base=STUB_BASE_P)
    check('4c two-node fees: primary stub fee set to 5', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 4.5}, base=STUB_BASE_S)
    check('4c two-node fees: secondary stub fee set to 4.5', s == 200, (s, r))
    check('4c two-node fees: caches cleared for a cold fee cache (fees 5/4.5)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.7, 'direction': 'below'}}})
    check("4c two-node fees: 'below' 4.7 watches — the primary (5) has not crossed", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.8, 'direction': 'above'}}})
    check("4c two-node fees: 'above' 4.8 fires on the primary reading (5)", s == 200 and r.get('fire') is True, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5.1, 'direction': 'below'}}})
    check("4c two-node fees: 'below' 5.1 fires on the primary reading (5)", s == 200 and r.get('fire') is True, r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5.1, 'direction': 'above'}}})
    check("4c two-node fees: 'above' 5.1 watches — the primary (5) has not crossed", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    # Far apart, no agreement check: primary 10 decides ('below' 5
    # watches, 'above' 9 fires).
    s, r = req('POST', '/__test__/fees', {'economyFee': 10}, base=STUB_BASE_P)
    check('4c two-node fees: caches cleared for a cold fee cache (fee 10)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
    check("4c two-node fees: far apart, 'below' 5 watches on the primary (10)", s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 9, 'direction': 'above'}}})
    check("4c two-node fees: far apart, 'above' 9 fires on the primary (10)", s == 200 and r.get('fire') is True, r)
    # Primary first: the secondary is never asked while the primary
    # answers (read from a real tx's slice).
    s, r = add_tx('FM 4c note', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 110520)
    check("4c two-node fees: far apart, a 'below' 5 fee tx adds (watching on the primary 10)", s == 201, (s, r))
    fm_note = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    t = state_tx(fm_note)
    check("4c two-node fees: far apart, the secondary is not asked — single-primary note",
          t and (t.get('triggerState') or {}).get('feeMode') == 'single'
          and (t.get('triggerState') or {}).get('feeNote') == 'primary only — secondary not needed',
          t.get('triggerState') if t else None)
    delete_all_txs()
    # An implausible primary fee counts as no answer, so the secondary
    # is asked.
    s, r = req('POST', '/__test__/fees', {'economyFee': 20000}, base=STUB_BASE_P)
    check('4c two-node fees: primary stub fee set implausible (20000)', s == 200, (s, r))
    check('4c two-node fees: caches cleared for a cold fee cache (implausible fee)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
    check("4c two-node fees: implausible primary falls back to the secondary (4.5 <= 5 fires)",
          s == 200 and r.get('fire') is True, r)
    s, r = add_tx('FM 4c implausible', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 110522)
    check("4c two-node fees: implausible primary, a 'below' 4 fee tx adds (watching on the secondary 4.5)", s == 201, (s, r))
    fm_impl = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    t = state_tx(fm_impl)
    check('4c two-node fees: implausible-primary fallback note names the secondary',
          t and (t.get('triggerState') or {}).get('feeMode') == 'single'
          and (t.get('triggerState') or {}).get('feeNote') == 'secondary only — primary returned invalid data',
          t.get('triggerState') if t else None)
    delete_all_txs()
    s, r = req('POST', '/__test__/fees', {'economyFee': 10}, base=STUB_BASE_P)
    check('4c two-node fees: primary stub fee back to 10', s == 200, (s, r))
    # Primary down (closed port): the secondary alone decides. The URL
    # change busts the fee cache.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.7, 'direction': 'below'}}})
    check('4c two-node fees: primary down, secondary alone decides (4.5 <= 4.7 fires)', s == 200 and r.get('fire') is True, r)
    s, r = add_tx('FM 4c down', {'type': 'feemarket', 'params': {'maxFeeRate': 4, 'direction': 'below'}}, 110524)
    check("4c two-node fees: primary down, a 'below' 4 fee tx adds (watching on the secondary 4.5)", s == 201, (s, r))
    fm_down = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    t = state_tx(fm_down)
    check('4c two-node fees: primary down, the note names the fallback',
          t and (t.get('triggerState') or {}).get('feeMode') == 'single'
          and (t.get('triggerState') or {}).get('feeNote') == 'secondary only — primary unreachable',
          t.get('triggerState') if t else None)
    delete_all_txs()
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 4.8, 'direction': 'above'}}})
    check('4c two-node fees: primary down, secondary alone decides (4.5 < 4.8 watches)', s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    # Restore: primary back to the stub, both fees back to 1,
    # cadence back to 60.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'checkCadenceSeconds': 60})
    check('4c two-node fees: primary and cadence restored', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_S)
    check('4c two-node fees: stubs restored to fee 1', s == 200, (s, r))

    # --- 5. the full tick fires the new types ---
    # At a 10 s cadence, one already-satisfied tx of each new type
    # broadcasts on the tick.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 10})
    check('5 full tick: cadence set to 10 s', s == 200, (s, r))
    check('5 full tick: app restarted', restart())
    s, r = add_tx('FT blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 1000}}, 110600, trigger_confirmed=True)
    ft_bh = r['tx']['id'] if s == 201 else None
    s, r = add_tx('FT setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110602, trigger_confirmed=True)
    ft_sd = r['tx']['id'] if s == 201 else None
    s, r = add_tx('FT feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110604, trigger_confirmed=True)
    ft_fm = r['tx']['id'] if s == 201 else None
    check('5 full tick: three already-satisfied txs added', ft_bh and ft_sd and ft_fm, (ft_bh, ft_sd, ft_fm))
    # Poll until the tick has broadcast all three.
    wait_until(lambda: all(
        ((state_tx(x) or {}).get('release') or {}).get('status') == 'broadcast'
        for x in (ft_bh, ft_sd, ft_fm)), deadline=16)
    s, st = req('GET', '/api/state')
    by_id = {t['id']: t for t in st.get('bitcoin', {}).get('txs', [])}
    check('5 full tick: block-height tx broadcast by the full tick',
          (by_id.get(ft_bh, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_bh, {}).get('release'))
    check('5 full tick: set-date tx broadcast by the full tick',
          (by_id.get(ft_sd, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_sd, {}).get('release'))
    check('5 full tick: fee-market tx broadcast by the full tick',
          (by_id.get(ft_fm, {}).get('release') or {}).get('status') == 'broadcast', by_id.get(ft_fm, {}).get('release'))
    # Restore the default cadence for the remaining sections.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('5 full tick: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()

    # --- 6. grace holds the new types too ---
    # With an active grace, already-satisfied block-height, set-date
    # and fee-market txs are held, then fire once resumed. A check-in
    # tx is held too, and stays on track after (its clock is fresh).
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6 grace: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    stj['grace'] = {'offlineDays': 10, 'startedAt': iso_ago(hours=1), 'durationDays': 7, 'resumedAt': None}
    save_state_file(stj)
    check('6 grace: app restarted with an active grace', restart())
    s, st = req('GET', '/api/state')
    check('6 grace: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    s, r = add_tx('G blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP - 1000}}, 110700, trigger_confirmed=True)
    g_bh = r['tx']['id'] if s == 201 else None
    s, r = add_tx('G setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110702, trigger_confirmed=True)
    g_sd = r['tx']['id'] if s == 201 else None
    s, r = add_tx('G feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 5}}, 110704, trigger_confirmed=True)
    g_fm = r['tx']['id'] if s == 201 else None
    s, r = add_tx('G checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110706)
    g_ck = r['tx']['id'] if s == 201 else None
    check('6 grace: four txs added (block-height, set-date, fee-market, check-in)', g_bh and g_sd and g_fm and g_ck, (g_bh, g_sd, g_fm, g_ck))
    s, r, res = release_results()
    for gid, name in ((g_bh, 'block-height'), (g_sd, 'set-date'), (g_fm, 'fee-market'), (g_ck, 'check-in')):
        check('6 grace: %s tx is held during the grace (skipped, status grace)' % name,
              s == 200 and res.get(gid, {}).get('action') == 'skipped' and res.get(gid, {}).get('triggerStatus') == 'grace', res.get(gid))
    # Resumed: the satisfied txs fire on the next check; the check-in
    # tx stays staged (fresh clock).
    s, r = req('POST', '/api/grace/resume', {})
    check('6 grace: resumed', s == 200, (s, r))
    s, r, res = release_results()
    for gid, name in ((g_bh, 'block-height'), (g_sd, 'set-date'), (g_fm, 'fee-market')):
        check('6 grace: %s tx broadcasts once the grace is resumed' % name,
              s == 200 and res.get(gid, {}).get('action') == 'broadcast', res.get(gid))
    check('6 grace: the check-in tx stays staged after resume (clock fresh, on-track)',
          s == 200 and res.get(g_ck, {}).get('action') == 'skipped' and res.get(g_ck, {}).get('triggerStatus') == 'on-track', res.get(g_ck))
    delete_all_txs()

    # --- 6b. grace on/off toggle ---
    # graceEnabled false means no grace at all. A stored duration of 0
    # still means off (old state loads as graceEnabled false); 2 is
    # not an offered duration, and a non-boolean flag is a 400.
    s, r = req('PUT', '/api/settings', {'graceDurationDays': 2})
    check('6b grace off: duration 2 rejected (400)', s == 400, (s, r))
    s, r = req('PUT', '/api/settings', {'graceDurationDays': 0})
    check('6b grace off: duration 0 saved', s == 200, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    save_state_file(stj)
    check('6b grace off: app restarted after a 10-day gap', restart())
    s, st = req('GET', '/api/state')
    check('6b grace off: no grace is set despite the gap (duration 0)', st.get('grace') is None, st.get('grace'))
    s, r = add_tx('G0 setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110706, trigger_confirmed=True)
    g0_sd = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('6b grace off: set-date tx broadcasts with the grace disabled',
          s == 200 and res.get(g0_sd, {}).get('action') == 'broadcast', res.get(g0_sd))
    delete_all_txs()
    # The toggle itself: a non-boolean is a 400; false means no
    # grace even with a normal duration, and due txs fire.
    s, r = req('PUT', '/api/settings', {'graceEnabled': 'yes'})
    check('6b grace toggle: non-boolean graceEnabled rejected (400)', s == 400, (s, r))
    s, r = req('PUT', '/api/settings', {'graceEnabled': False})
    check('6b grace toggle: graceEnabled false saved', s == 200, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    save_state_file(stj)
    check('6b grace toggle: app restarted after a 10-day gap', restart())
    s, st = req('GET', '/api/state')
    check('6b grace toggle: no grace is set despite the gap (toggle off)', st.get('grace') is None, st.get('grace'))
    s, r = add_tx('G1 setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110708, trigger_confirmed=True)
    g1_sd = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('6b grace toggle: set-date tx broadcasts with the toggle off',
          s == 200 and res.get(g1_sd, {}).get('action') == 'broadcast', res.get(g1_sd))
    delete_all_txs()
    # Migration: old state with duration 0 and no graceEnabled
    # flag loads as grace off, not on.
    stj = load_state_file()
    stj['settings'].pop('graceEnabled', None)
    stj['settings']['graceDurationDays'] = 0
    save_state_file(stj)
    check('6b grace toggle: app restarted with pre-toggle state', restart())
    s, st = req('GET', '/api/state')
    check('6b grace toggle: pre-toggle duration 0 loads as graceEnabled false',
          st.get('settings', {}).get('graceEnabled') is False, st.get('settings'))
    # Toggle back on: a 10-day gap sets a grace again. Then restore
    # the defaults.
    s, r = req('PUT', '/api/settings', {'graceDurationDays': 7, 'graceEnabled': True})
    check('6b grace toggle: duration 7 + toggle on saved', s == 200, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    save_state_file(stj)
    check('6b grace toggle: app restarted after a 10-day gap', restart())
    s, st = req('GET', '/api/state')
    check('6b grace toggle: grace is set again with the toggle on', st.get('grace', {}).get('active') is True, st.get('grace'))
    # Resume to clear it for the remaining sections (resume also
    # refreshes lastOnlineAt, so no grace re-sets on the next read).
    s, r = req('POST', '/api/grace/resume', {})
    check('6b grace toggle: resumed to clear the grace', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    check('6b grace toggle: grace cleared after resume', st.get('grace') is None, st.get('grace'))
    delete_all_txs()

    # --- 6c. the check-in hold is the grace ---
    # A past-due check-in rule is held by the grace like any rule and
    # fires when it ends; with the toggle off it fires on schedule. A
    # stored heldUntil is dropped, and a backup carrying one still
    # restores.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6c unify: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('U checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110710)
    u_ck = r['tx']['id'] if s == 201 else None
    check('6c unify: the past-due check-in tx adds', s == 201, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    save_state_file(stj)
    check('6c unify: app restarted with a 10-day gap and a 40-day-old clock', restart())
    s, st = req('GET', '/api/state')
    check('6c unify: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    check('6c unify: no heldUntil anywhere in the served check-in state',
          'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
    s, r, res = release_results()
    check('6c unify: the past-due check-in tx is held during the grace (skipped, status grace)',
          s == 200 and res.get(u_ck, {}).get('action') == 'skipped' and res.get(u_ck, {}).get('triggerStatus') == 'grace', res.get(u_ck))
    check('6c unify: nothing broadcasted during the grace',
          (state_tx(u_ck) or {}).get('broadcasted') is None, (state_tx(u_ck) or {}).get('broadcasted'))
    # Resume: the past-due check-in fires on the next check.
    s, r = req('POST', '/api/grace/resume', {})
    check('6c unify: resumed', s == 200, (s, r))
    s, r, res = release_results()
    check('6c unify: the past-due check-in tx broadcasts once the grace is resumed',
          s == 200 and res.get(u_ck, {}).get('action') == 'broadcast', res.get(u_ck))
    delete_all_txs()
    # Expiry: a seeded expired grace reads as no grace, and a
    # past-due check-in fires on the startup tick.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6c unify: check-in lands so the clock is fresh for the expired-grace add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('U checkin expired', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110712)
    ux_ck = r['tx']['id'] if s == 201 else None
    check('6c unify: the expired-grace check-in tx adds', s == 201, (s, r))
    stj = load_state_file()
    stj['grace'] = {'graceUntil': iso_ago(hours=1), 'triggeredAt': iso_ago(days=8), 'offlineGapDays': 8}
    stj['checkin']['lastOnlineAt'] = iso_ago()
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    save_state_file(stj)
    check('6c unify: app restarted with an expired grace and a 40-day-old clock', restart())
    s, st = req('GET', '/api/state')
    check('6c unify: an expired grace reads as no grace (grace null)',
          st.get('grace') is None, st.get('grace'))
    check('6c unify: the startup tick fired the past-due check-in tx after expiry',
          ((state_tx(ux_ck) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(ux_ck) or {}).get('release'))
    delete_all_txs()
    # Toggle off: no grace at all — a past-due check-in fires
    # on schedule (the startup tick broadcasts it).
    s, r = req('PUT', '/api/settings', {'graceEnabled': False})
    check('6c unify: toggle off saved', s == 200, (s, r))
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6c unify: check-in lands so the clock is fresh for the toggle-off add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('U checkin off', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110714)
    uo_ck = r['tx']['id'] if s == 201 else None
    check('6c unify: the toggle-off check-in tx adds', s == 201, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    save_state_file(stj)
    check('6c unify: app restarted with the toggle off, a 10-day gap, a 40-day-old clock', restart())
    s, st = req('GET', '/api/state')
    check('6c unify: no grace is set with the toggle off', st.get('grace') is None, st.get('grace'))
    check('6c unify: the startup tick fired the past-due check-in tx with the toggle off',
          ((state_tx(uo_ck) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(uo_ck) or {}).get('release'))
    delete_all_txs()
    s, r = req('PUT', '/api/settings', {'graceEnabled': True})
    check('6c unify: toggle restored to on', s == 200, (s, r))
    # Migration: a stored heldUntil loads dropped — the loaded
    # state carries no heldUntil key at all.
    stj = load_state_file()
    stj['checkin']['heldUntil'] = iso_in(days=12)
    save_state_file(stj)
    check('6c unify: app restarted with a stored heldUntil', restart())
    s, st = req('GET', '/api/state')
    check('6c unify: a stored heldUntil loads dropped (no heldUntil key)',
          'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
    # A backup carrying a heldUntil (even garbage) restores, without
    # it.
    s, bak = req('POST', '/api/backup', {})
    check('6c unify: backup fetched', s == 200 and 'state' in bak, (s, list(bak.keys()) if isinstance(bak, dict) else bak))
    bak['state']['checkin']['heldUntil'] = 'not-a-date'
    s, r = req('POST', '/api/restore', bak)
    check('6c unify: a backup with a garbage heldUntil restores (200, accept-and-drop)', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    check('6c unify: the restored state carries no heldUntil',
          'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
    # Restore a fresh clock for the remaining sections.
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago()
    stj['checkin']['lastCheckinAt'] = iso_ago()
    save_state_file(stj)
    check('6c unify: check-in clock restored (restart)', restart())

    # --- 6e. short-threshold check-in outage protection ---
    # The grace also activates on the check-in clock: an offline gap
    # over a quarter of the shortest armed check-in threshold, with
    # over half of it elapsed since the last check-in. The grant is
    # still the grace duration. Only effective rules set the threshold
    # (a set member's parked trigger does not). A stored unexpired
    # heldUntil becomes an active grace. The 5h case is the no-grace
    # pin.
    def state_set_e(set_id):
        s2, st2 = req('GET', '/api/state')
        for x in st2.get('bitcoin', {}).get('sets', []):
            if x.get('id') == set_id:
                return x
        return None
    def delete_all_sets_e():
        s2, st2 = req('GET', '/api/state')
        for x in st2.get('bitcoin', {}).get('sets', []):
            req('DELETE', '/api/bitcoin/sets/' + x['id'], base=BASE)
    # Leg 1: 30h gap, 1-day threshold. Only the check-in leg can set
    # the grace; the past-due tx is held and the grant is 7 days.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e short: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E checkin 1d', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111200)
    e1 = r['tx']['id'] if s == 201 else None
    check('6e short: the 1-day check-in tx adds', s == 201, (s, r))
    def seed_e1():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(hours=30)
        stj['checkin']['lastCheckinAt'] = iso_ago(hours=30)
        save_state_file(stj)
    check('6e short: app restarted with a 30h gap and a 30h-old clock (1-day threshold)', restart(before_start=seed_e1))
    s, st = req('GET', '/api/state')
    check('6e short: the grace is active (check-in leg — the 30h gap is under the 7-day flat threshold)',
          st.get('grace', {}).get('active') is True, st.get('grace'))
    check('6e short: the offline gap reads 1 day (floor of 30h)',
          st.get('grace', {}).get('offlineGapDays') == 1, st.get('grace'))
    gu1 = st.get('grace', {}).get('graceUntil')
    check('6e short: the grace lasts the configured 7 days, not the old 12h pushout',
          gu1 is not None and (datetime.fromisoformat(gu1.replace('Z', '+00:00')) - datetime.now(timezone.utc)).total_seconds() > 6 * 86400,
          gu1)
    s, r, res = release_results()
    check('6e short: the past-due 1-day check-in tx is held during the grace (skipped, status grace)',
          s == 200 and res.get(e1, {}).get('action') == 'skipped' and res.get(e1, {}).get('triggerStatus') == 'grace', res.get(e1))
    check('6e short: nothing broadcasted during the grace',
          (state_tx(e1) or {}).get('broadcasted') is None, (state_tx(e1) or {}).get('broadcasted'))
    delete_all_txs()
    s, r = req('POST', '/api/grace/resume', {})
    check('6e short: resumed', s == 200, (s, r))
    # Leg 2: 18h gap clears both bars (6h and 12h), so the grace holds
    # the tx due in 6h.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e 18h: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E checkin 1d 18h', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111202)
    e2 = r['tx']['id'] if s == 201 else None
    check('6e 18h: the 1-day check-in tx adds', s == 201, (s, r))
    def seed_e2():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(hours=18)
        stj['checkin']['lastCheckinAt'] = iso_ago(hours=18)
        save_state_file(stj)
    check('6e 18h: app restarted with an 18h gap and an 18h-old clock (1-day threshold)', restart(before_start=seed_e2))
    s, st = req('GET', '/api/state')
    check('6e 18h: the grace IS active (18h > 6h and > 12h — the old condition holds)',
          st.get('grace', {}).get('active') is True, st.get('grace'))
    s, r, res = release_results()
    check('6e 18h: the not-yet-due 1-day check-in tx is held during the grace (skipped, status grace)',
          s == 200 and res.get(e2, {}).get('action') == 'skipped' and res.get(e2, {}).get('triggerStatus') == 'grace', res.get(e2))
    check('6e 18h: nothing broadcasted during the grace',
          (state_tx(e2) or {}).get('broadcasted') is None, (state_tx(e2) or {}).get('broadcasted'))
    delete_all_txs()
    s, r = req('POST', '/api/grace/resume', {})
    check('6e 18h: resumed', s == 200, (s, r))
    # Leg 3: 5h gap is under both, so no grace; the tx (due in 19h)
    # stays staged.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e 5h: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E checkin 1d 5h', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111204)
    e3 = r['tx']['id'] if s == 201 else None
    check('6e 5h: the 1-day check-in tx adds', s == 201, (s, r))
    def seed_e3():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(hours=5)
        stj['checkin']['lastCheckinAt'] = iso_ago(hours=5)
        save_state_file(stj)
    check('6e 5h: app restarted with a 5h gap and a 5h-old clock (1-day threshold)', restart(before_start=seed_e3))
    s, st = req('GET', '/api/state')
    check('6e 5h: NO grace — 5h is under a quarter of the 1-day threshold (6h)',
          st.get('grace') is None, st.get('grace'))
    check('6e 5h: the 1-day check-in tx is still staged (not due for 19h, nothing broadcast)',
          (state_tx(e3) or {}).get('release') is None and (state_tx(e3) or {}).get('broadcasted') is None,
          (state_tx(e3) or {}))
    delete_all_txs()
    # Leg 4: a member's parked 1-day trigger does not set the
    # threshold; its set's 2-day rule does (7h/13h: no grace; 30h/30h:
    # grace, set held).
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e set: check-in lands so the clock is fresh for the adds', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E set member 1d', {'type': 'checkin', 'params': {'thresholdDays': 1}}, 111206)
    m4 = r['tx']['id'] if s == 201 else None
    check('6e set: the member tx adds with its own 1-day check-in trigger', s == 201, (s, r))
    s, r = req('POST', '/api/bitcoin/sets', {'label': 'E set 2d', 'txIds': [m4],
          'trigger': {'type': 'checkin', 'params': {'thresholdDays': 2}}})
    set4 = r.get('set', {}).get('id') if s == 201 else None
    check('6e set: the set creates with a 2-day check-in trigger', s == 201, (s, r))
    def seed_e4a():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(hours=7)
        stj['checkin']['lastCheckinAt'] = iso_ago(hours=13)
        save_state_file(stj)
    check('6e set: app restarted with a 7h gap and a 13h-old clock (set threshold 2d)', restart(before_start=seed_e4a))
    s, st = req('GET', '/api/state')
    check('6e set: NO grace — T is the set\'s 2 days, not the parked 1 day (7h < 12h = T/4)',
          st.get('grace') is None, st.get('grace'))
    x4a = state_set_e(set4)
    check('6e set: the set reads on-track (13h of 48h), not grace',
          (x4a or {}).get('triggerStatus', {}).get('status') == 'on-track', (x4a or {}).get('triggerStatus'))
    check('6e set: the member tx is still staged (nothing broadcast)',
          (state_tx(m4) or {}).get('release') is None and (state_tx(m4) or {}).get('broadcasted') is None,
          (state_tx(m4) or {}))
    def seed_e4b():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago(hours=30)
        stj['checkin']['lastCheckinAt'] = iso_ago(hours=30)
        save_state_file(stj)
    check('6e set: app restarted with a 30h gap and a 30h-old clock (set threshold 2d)', restart(before_start=seed_e4b))
    s, st = req('GET', '/api/state')
    check('6e set: the grace IS active (30h > 12h = T/4 and > 24h = T/2)',
          st.get('grace', {}).get('active') is True, st.get('grace'))
    s, r, res = release_results()
    check('6e set: the set is held during the grace (skipped, status grace)',
          s == 200 and res.get(set4, {}).get('action') == 'skipped' and res.get(set4, {}).get('triggerStatus') == 'grace', res.get(set4))
    check('6e set: the member tx is still staged (nothing broadcast)',
          (state_tx(m4) or {}).get('release') is None and (state_tx(m4) or {}).get('broadcasted') is None,
          (state_tx(m4) or {}))
    s, r = req('DELETE', '/api/bitcoin/sets/' + set4)
    check('6e set: the set deletes', s == 200, (s, r))
    delete_all_txs()
    s, r = req('POST', '/api/grace/resume', {})
    check('6e set: resumed', s == 200, (s, r))
    # Leg 5: an unexpired stored heldUntil becomes an active grace
    # (the fresh lastOnlineAt rules out a new one); the past-due tx is
    # held.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e mig: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E mig checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111208)
    e5 = r['tx']['id'] if s == 201 else None
    check('6e mig: the 35-day check-in tx adds', s == 201, (s, r))
    held_e5 = iso_in(hours=12)
    def seed_e5():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        stj['checkin']['heldUntil'] = held_e5
        save_state_file(stj)
    check('6e mig: app restarted with an unexpired heldUntil (+12h) and a 40-day-old clock', restart(before_start=seed_e5))
    s, st = req('GET', '/api/state')
    check('6e mig: a stored heldUntil still loads dropped (no heldUntil key)',
          'heldUntil' not in st.get('checkin', {}), st.get('checkin'))
    gu5 = st.get('grace', {}).get('graceUntil')
    check('6e mig: the unexpired hold translated into an active grace ending at the heldUntil',
          st.get('grace', {}).get('active') is True and gu5 is not None
          and abs((datetime.fromisoformat(gu5.replace('Z', '+00:00')) - datetime.fromisoformat(held_e5.replace('Z', '+00:00'))).total_seconds()) < 1,
          st.get('grace'))
    s, r, res = release_results()
    check('6e mig: the past-due check-in tx is held by the translated grace (skipped, status grace)',
          s == 200 and res.get(e5, {}).get('action') == 'skipped' and res.get(e5, {}).get('triggerStatus') == 'grace', res.get(e5))
    check('6e mig: nothing broadcasted during the translated grace',
          (state_tx(e5) or {}).get('broadcasted') is None, (state_tx(e5) or {}).get('broadcasted'))
    delete_all_txs()
    s, r = req('POST', '/api/grace/resume', {})
    check('6e mig: resumed', s == 200, (s, r))
    # Leg 6: an expired heldUntil is dropped and the past-due tx
    # broadcasts on the startup tick.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6e mig-exp: check-in lands so the clock is fresh for the add', s == 200 and r.get('ok') is True, r)
    s, r = add_tx('E mig-exp checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111210)
    e6 = r['tx']['id'] if s == 201 else None
    check('6e mig-exp: the 35-day check-in tx adds', s == 201, (s, r))
    def seed_e6():
        stj = load_state_file()
        stj['checkin']['lastOnlineAt'] = iso_ago()
        stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
        stj['checkin']['heldUntil'] = iso_ago(hours=1)
        save_state_file(stj)
    check('6e mig-exp: app restarted with an expired heldUntil and a 40-day-old clock', restart(before_start=seed_e6))
    s, st = req('GET', '/api/state')
    check('6e mig-exp: no grace (the expired hold is dropped, the gap is fresh)',
          st.get('grace') is None, st.get('grace'))
    check('6e mig-exp: the startup tick fired the past-due check-in tx after the expired hold was dropped',
          ((state_tx(e6) or {}).get('release') or {}).get('status') == 'broadcast', (state_tx(e6) or {}).get('release'))
    delete_all_txs()
    delete_all_sets_e()
    # Restore a fresh clock for the remaining sections.
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago()
    stj['checkin']['lastCheckinAt'] = iso_ago()
    save_state_file(stj)
    check('6e short: check-in clock restored (restart)', restart())

    # --- 6d. grace card: would fire now ---
    # triggerStatus.wouldFire is each rule's raw condition without any
    # network call: check-in and set-date from the clock,
    # price/fee/height from warm caches or the stored slice, UTXO from
    # the stored slice only; manual and unknown never fire. Price and
    # fee are pinned first.
    delete_all_txs()
    check('6d wouldFire: caches cleared cold for a deterministic start', clear_caches())
    s, r = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    check('6d wouldFire: stub price pinned to 98200', s == 200, (s, r))
    s, r = req('POST', '/__test__/fees', {'economyFee': 1}, base=STUB_BASE_P)
    check('6d wouldFire: stub fee pinned to 1 sat/vB', s == 200, (s, r))
    s, r = req('POST', '/__test__/outspend', {'txid': SECOND, 'vout': 0, 'blockHeight': 899999}, base=STUB_BASE_P)
    check('6d wouldFire: SECOND:0 driven to spent (2 confs)', s == 200, (s, r))
    # The spent UTXO tx first, alone and disarmed: an evaluation
    # writes 'due' without broadcasting. It stays disarmed (armed, it
    # would broadcast before a grace could hold it).
    s, r = add_tx('WF UTXO spent', {'type': 'utxo', 'params': {'outpoint': SECOND + ':0'}}, 111000, trigger_confirmed=True)
    check('6d wouldFire: the spent UTXO tx adds (triggerConfirmed)', s == 201, (s, r))
    wf_utxo_spent = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + wf_utxo_spent, {'enabled': False})
    check('6d wouldFire: the spent UTXO tx is disarmed', s == 200, (s, r))
    s, r, res = release_results()
    check('6d wouldFire: the disarmed spent UTXO tx is skipped, not broadcast',
          res.get(wf_utxo_spent, {}).get('action') == 'skipped', res.get(wf_utxo_spent))
    check('6d wouldFire: the evaluation wrote its slice due',
          rule_slice(state_tx(wf_utxo_spent)).get('status') == 'due', rule_slice(state_tx(wf_utxo_spent)))
    # The rest, added with a fresh clock and no grace yet.
    s, r = add_tx('WF check-in due', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 111001)
    check('6d wouldFire: the check-in tx adds', s == 201, (s, r))
    wf_ck = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF price holding', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}, 111002, trigger_confirmed=True)
    check('6d wouldFire: the holding price tx adds (triggerConfirmed)', s == 201, (s, r))
    wf_price = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF price not holding', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 111003)
    check('6d wouldFire: the not-holding price tx adds', s == 201, (s, r))
    wf_price_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF setdate past', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 111004, trigger_confirmed=True)
    check('6d wouldFire: the past set-date tx adds (triggerConfirmed)', s == 201, (s, r))
    wf_sd = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF setdate future', {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}}, 111005)
    check('6d wouldFire: the future set-date tx adds', s == 201, (s, r))
    wf_sd_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF blockheight reached', {'type': 'blockheight', 'params': {'targetHeight': 899000}}, 111006, trigger_confirmed=True)
    check('6d wouldFire: the reached block-height tx adds (triggerConfirmed)', s == 201, (s, r))
    wf_bh = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF blockheight not reached', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111007)
    check('6d wouldFire: the unreached block-height tx adds', s == 201, (s, r))
    wf_bh_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF UTXO unspent', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1'}}, 111008)
    check('6d wouldFire: the unspent UTXO tx adds', s == 201, (s, r))
    wf_utxo_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF feemarket met', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}, 111009, trigger_confirmed=True)
    check('6d wouldFire: the met fee-market tx adds (triggerConfirmed)', s == 201, (s, r))
    wf_fm = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF feemarket unmet', {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'above'}}, 111010)
    check('6d wouldFire: the unmet fee-market tx adds', s == 201, (s, r))
    wf_fm_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF OR', {'op': 'OR', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}},
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}]}, 111011, trigger_confirmed=True)
    check('6d wouldFire: the OR set adds (triggerConfirmed)', s == 201, (s, r))
    wf_or = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF AND unmet', {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_in(days=1)}}]}, 111012)
    check('6d wouldFire: the unmet AND set adds', s == 201, (s, r))
    wf_and_no = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF AND met', {'op': 'AND', 'rules': [
        {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}},
        {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}]}, 111013, trigger_confirmed=True)
    check('6d wouldFire: the met AND set adds (triggerConfirmed)', s == 201, (s, r))
    wf_and = r['tx']['id'] if s == 201 else None
    s, r = add_tx('WF manual', {'type': 'manual', 'params': {}}, 111014)
    check('6d wouldFire: the manual tx adds', s == 201, (s, r))
    wf_manual = r['tx']['id'] if s == 201 else None
    # Backdate the clock 40 days and liveness 10 days, then restart:
    # the grace sets before any held rule evaluates.
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago(days=10)
    stj['checkin']['lastCheckinAt'] = iso_ago(days=40)
    save_state_file(stj)
    check('6d wouldFire: app restarted with a 10-day gap and a 40-day-old clock', restart())
    s, st = req('GET', '/api/state')
    check('6d wouldFire: the grace is active', st.get('grace', {}).get('active') is True, st.get('grace'))
    def wf(tx_id):
        t = state_tx(tx_id)
        return (t or {}).get('triggerStatus', {}).get('wouldFire')
    # Cache-independent reads first: clock rules and stored
    # slices are exact whether or not a cache is warm.
    check('6d wouldFire: the past-due check-in tx would fire (live clock)', wf(wf_ck) is True, wf(wf_ck))
    check('6d wouldFire: the unspent UTXO tx would not fire (never evaluated)', wf(wf_utxo_no) is False, wf(wf_utxo_no))
    check('6d wouldFire: the spent UTXO tx would fire (stored slice due)', wf(wf_utxo_spent) is True, wf(wf_utxo_spent))
    check('6d wouldFire: the past set-date tx would fire (live clock)', wf(wf_sd) is True, wf(wf_sd))
    check('6d wouldFire: the future set-date tx would not fire', wf(wf_sd_no) is False, wf(wf_sd_no))
    check('6d wouldFire: the not-holding price tx would not fire', wf(wf_price_no) is False, wf(wf_price_no))
    check('6d wouldFire: the unmet fee-market tx would not fire', wf(wf_fm_no) is False, wf(wf_fm_no))
    check('6d wouldFire: the unreached block-height tx would not fire', wf(wf_bh_no) is False, wf(wf_bh_no))
    check('6d wouldFire: the manual tx would never fire', wf(wf_manual) is False, wf(wf_manual))
    check('6d wouldFire: the unmet AND set would not fire (one rule unmet)', wf(wf_and_no) is False, wf(wf_and_no))
    # Cold caches: price, fee and height read false until warm (no
    # claim without data). The OR set is true via its clock-exact set-
    # date rule; the AND set is false (price unreadable).
    check('6d wouldFire: caches cleared cold', clear_caches())
    s, st = req('GET', '/api/state')
    cold = {t.get('id'): (t.get('triggerStatus') or {}).get('wouldFire') for t in st.get('bitcoin', {}).get('txs', [])}
    check('6d wouldFire: the holding price tx reads false with a cold price cache', cold.get(wf_price) is False, cold.get(wf_price))
    check('6d wouldFire: the met fee-market tx reads false with a cold fee cache', cold.get(wf_fm) is False, cold.get(wf_fm))
    check('6d wouldFire: the reached block-height tx reads false with a cold tip cache', cold.get(wf_bh) is False, cold.get(wf_bh))
    check('6d wouldFire: the OR set reads true cold (its set-date rule is clock-exact)', cold.get(wf_or) is True, cold.get(wf_or))
    check('6d wouldFire: the met AND set reads false cold (its price rule is unreadable)', cold.get(wf_and) is False, cold.get(wf_and))
    # Warm each cache explicitly via the stateless trigger
    # gate (no state change, no evaluation) and re-read.
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 90000}}})
    check('6d wouldFire: the price gate warms the price cache', s == 200 and r.get('fire') is True, (s, r))
    check('6d wouldFire: the holding price tx reads true once the price cache is warm', wf(wf_price) is True, wf(wf_price))
    check('6d wouldFire: the met AND set reads true once its price rule is met', wf(wf_and) is True, wf(wf_and))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'feemarket', 'params': {'maxFeeRate': 5, 'direction': 'below'}}})
    check('6d wouldFire: the fee gate warms the fee cache', s == 200 and r.get('fire') is True, (s, r))
    check('6d wouldFire: the met fee-market tx reads true once the fee cache is warm', wf(wf_fm) is True, wf(wf_fm))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 899000}}})
    check('6d wouldFire: the block-height gate warms the tip cache', s == 200 and r.get('fire') is True, (s, r))
    check('6d wouldFire: the reached block-height tx reads true once the tip cache is warm', wf(wf_bh) is True, wf(wf_bh))
    # Checking in clears the check-in rule's wouldFire (the
    # clock is fresh again) but not the grace itself.
    s, r = req('POST', '/api/checkin', {'method': 'app'})
    check('6d wouldFire: a check-in lands', s == 200 and r.get('ok') is True, (s, r))
    check('6d wouldFire: the check-in tx reads false once the clock is fresh', wf(wf_ck) is False, wf(wf_ck))
    s, st = req('GET', '/api/state')
    check('6d wouldFire: the grace is still active after the check-in', st.get('grace', {}).get('active') is True, st.get('grace'))
    # Cold tip cache falls back to the stored slice: seed a 'due'
    # slice before boot; the grace keeps the startup tick from
    # overwriting it.
    def seed_bh_due():
        stj2 = load_state_file()
        for t in stj2.get('bitcoin', {}).get('txs', []):
            if t.get('id') == wf_bh_no:
                t['triggerState'] = {'lastEvalAt': iso_ago(), 'status': 'due', 'reason': 'block 900,000 reached — firing',
                                     'lastPrice': None, 'lastPriceAt': None, 'lastOutspend': None, 'lastError': None,
                                     'lastTipHeight': 900000}
                break
        save_state_file(stj2)
    check('6d wouldFire: app restarted with a seeded due block-height slice', restart(before_start=seed_bh_due))
    s, st = req('GET', '/api/state')
    check('6d wouldFire: the grace is still active after the restart', st.get('grace', {}).get('active') is True, st.get('grace'))
    check('6d wouldFire: the seeded due slice survives the startup tick',
          rule_slice(state_tx(wf_bh_no)).get('status') == 'due', rule_slice(state_tx(wf_bh_no)))
    check('6d wouldFire: the stale due slice counts with a cold tip cache (fallback)', wf(wf_bh_no) is True, wf(wf_bh_no))
    # Cleanup: resume the grace, drop the txs, clear the stub
    # override, restore a fresh clock for the next sections.
    s, r = req('POST', '/api/grace/resume', {})
    check('6d wouldFire: resumed', s == 200, (s, r))
    delete_all_txs()
    s, r = req('POST', '/__test__/outspend', {'txid': SECOND, 'vout': 0, 'clear': True}, base=STUB_BASE_P)
    check('6d wouldFire: SECOND:0 override cleared', s == 200, (s, r))
    stj = load_state_file()
    stj['checkin']['lastOnlineAt'] = iso_ago()
    stj['checkin']['lastCheckinAt'] = iso_ago()
    save_state_file(stj)
    check('6d wouldFire: check-in clock restored (restart)', restart())

    # --- 7. vacation does not freeze the new types ---
    # A set-date tx still fires during vacation.
    s, r = req('PUT', '/api/settings', {'vacationMode': True, 'vacationUntil': None})
    check('7 vacation: vacation mode on', s == 200, (s, r))
    s, r = add_tx('V setdate', {'type': 'setdate', 'params': {'fireAt': iso_ago(hours=1)}}, 110800, trigger_confirmed=True)
    v_sd = r['tx']['id'] if s == 201 else None
    s, r, res = release_results()
    check('7 vacation: set-date tx still broadcasts during vacation',
          s == 200 and res.get(v_sd, {}).get('action') == 'broadcast', res.get(v_sd))
    s, r = req('PUT', '/api/settings', {'vacationMode': False, 'vacationUntil': None})
    check('7 vacation: vacation mode off', s == 200, (s, r))
    delete_all_txs()

    # --- 8. existing triggers still work (smoke) ---------------------
    s, r = add_tx('S checkin', {'type': 'checkin', 'params': {'thresholdDays': 35}}, 110900)
    check('8 smoke: check-in tx accepted', s == 201, (s, r))
    s, r = add_tx('S price', {'type': 'price', 'params': {'asset': 'BTC', 'op': '>=', 'value': 200000}}, 110902)
    check('8 smoke: price tx accepted', s == 201, (s, r))
    s, r = add_tx('S utxo', {'type': 'utxo', 'params': {'outpoint': SECOND + ':1', 'condition': 'spent', 'confirmations': 1}}, 110904)
    check('8 smoke: utxo tx accepted', s == 201, (s, r))
    s, r = add_tx('S manual', {'type': 'manual', 'params': {}}, 110906)
    check('8 smoke: manual tx accepted', s == 201, (s, r))
    s, r, res = release_results()
    check('8 smoke: none of the four broadcasts (nothing due)',
          all(res.get(t, {}).get('action') != 'broadcast' for t in res), res)
    delete_all_txs()
