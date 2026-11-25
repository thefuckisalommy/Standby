"""API suite: Nodes on Bitcoin Core: bare spends, restore re-check, RPC (sections 43-45)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 43. bare spends from a bitcoind-backed mempool ---
    # Outspends answer {spent: true} only. The app checks
    # /api/prevouts (confirmed vs mempool spend), its own txid, and
    # counts confirmations from first sighting. Uses its own stub and
    # app instance.
    _bs_port = 18197
    _bs_base = 'http://127.0.0.1:%d' % _bs_port
    _ab43 = 'http://127.0.0.1:3440'
    _stub43 = start(['node', STUB, str(_bs_port)], env={'SENTINEL_TXID': SENTINEL_TXID}, log=_bind_log)
    check('43 bare: stub comes up', wait_up(_bs_base, path='/api/blocks/tip/height'))
    s, r = req('POST', '/__test__/outspend-style', {'style': 'bitcoind'}, base=_bs_base)
    check('43 bare: stub answers like a bitcoind-backed mempool', s == 200 and r.get('style') == 'bitcoind', r)
    shutil.rmtree(_bind_data, ignore_errors=True)
    shutil.rmtree(_bind_checkin, ignore_errors=True)
    _e43 = dict(APP_ENV)
    _e43.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin,
                 'STANDBY_TEST_STARTUP_TICK_MS': '600000', 'STANDBY_TEST_RESTORE_CHECK_MS': '4000'})
    _e43.pop('STANDBY_PASSWORD', None)
    _app43 = start(['node', 'server.js'], env=_e43, cwd=APP, log=_bind_log)
    check('43 bare: instance comes up', wait_up(_ab43))
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': _bs_base, 'secondaryEnabled': False}, base=_ab43)
    check('43 bare: primary node is the bitcoind-style stub, secondary off', s == 200, (s, r))
    # The raw answer really is bare.
    s, r = req('GET', '/api/tx/' + v.FINNEY + '/outspends', base=_bs_base)
    check('43 bare: the stub batch answer is bare (no txid, no status)',
          s == 200 and r[0] == {'spent': True}, r)
    # Output lookup: bare with confirmation check, then bare only
    # (CAUTION) without /api/prevouts.
    def _lookup43():
        s, r = req('POST', '/api/bitcoin/connection/test', {}, base=_ab43)
        res = {x.get('endpoint'): x for x in r.get('results', [])}
        return s, res.get('primary', {})
    check('43 lookup: caches cleared for the probe', req('POST', '/api/__test__/clear-caches', {'only': ['outspend', 'nodeTip']}, base=_ab43)[0] == 200)
    s, pr = _lookup43()
    ol = (pr.get('checks') or {}).get('outputLookup') or {}
    check('43 lookup: a bitcoind-backed mempool with /api/prevouts reads Bare + confirmation check, node OK',
          s == 200 and ol.get('ok') is True and ol.get('kind') == 'bare-verified'
          and ol.get('value') == 'Bare + confirmation check' and pr.get('status') == 'ok', (s, pr))
    req('POST', '/__test__/prevouts-route', {'enabled': False}, base=_bs_base)
    check('43 lookup: caches cleared again', req('POST', '/api/__test__/clear-caches', {'only': ['outspend', 'nodeTip']}, base=_ab43)[0] == 200)
    s, pr = _lookup43()
    ol = (pr.get('checks') or {}).get('outputLookup') or {}
    check('43 lookup: without /api/prevouts it reads Bare only, a warning (not a failure)',
          ol.get('ok') is False and ol.get('warn') is True and ol.get('kind') == 'bare'
          and ol.get('value') == 'Bare only \u2014 can\u2019t tell confirmed spends', ol)
    check('43 lookup: ... the node is CAUTION and says why',
          pr.get('status') == 'caution' and 'not whether the spend is confirmed' in (pr.get('detail') or ''), pr.get('detail'))
    req('POST', '/__test__/prevouts-route', {'enabled': True}, base=_bs_base)

    def _dry43(tx_id):
        s, r = req('POST', '/api/broadcast/test', {'id': tx_id}, base=_ab43)
        return s, (r.get('results') or [{}])[0]

    def _clear43():
        return req('POST', '/api/__test__/clear-caches', {'only': ['outspend', 'nodeTip']}, base=_ab43)[0] == 200

    # A confirmed foreign spend without /api/prevouts reads
    # unconfirmed (a warning, never stale).
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(0, 114001), 'label': 'Bare confirmed', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    check('43 bare: tx spending a confirmed-spent input added', s == 201, (s, r))
    _conf43 = r['tx']['id'] if s == 201 else None
    req('POST', '/__test__/prevouts-route', {'enabled': False}, base=_bs_base)
    check('43 bare: caches cleared', _clear43())
    s, one = _dry43(_conf43)
    check('43 bare: without /api/prevouts a bare spend reads unconfirmed, as before (conflict, not stale)',
          s == 200 and one.get('verdict') == 'conflict' and len(one.get('spent', [])) == 0, one)
    check('43 notes: the unverified note says the node cannot tell, not that the spend is unconfirmed',
          'cannot say whether that spend is confirmed' in (one.get('note') or '')
          and 'not confirmed yet' not in (one.get('note') or ''), one.get('note'))
    t = state_tx(_conf43, base=_ab43)
    check('43 bare: ... and the transaction stays active (not stale)',
          t and (t.get('release') or {}).get('status') != 'stale', t and t.get('release'))
    # With the route: proven confirmed, so stale.
    req('POST', '/__test__/prevouts-route', {'enabled': True}, base=_bs_base)
    check('43 bare: caches cleared again', _clear43())
    s, one = _dry43(_conf43)
    check('43 bare: /api/prevouts proves the spend confirmed — the dry run says stale (blocked)',
          s == 200 and one.get('verdict') == 'blocked' and len(one.get('spent', [])) == 1, one)
    check('43 notes: the stale note says the spend is confirmed',
          'spent by another transaction that is confirmed' in (one.get('note') or ''), one.get('note'))
    check('43 bare: the spender is not named (the node cannot say)',
          (one.get('spent') or [{}])[0].get('spentBy') is None, one.get('spent'))
    t = state_tx(_conf43, base=_ab43)
    check('43 bare: the transaction is recorded stale',
          t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
    # Mempool-only foreign spend (CONFLICT, unconfirmed in the stub).
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft_prev('cc' * 32, 0, 114002), 'label': 'Bare mempool', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    check('43 bare: tx spending a mempool-spent input added', s == 201, (s, r))
    s, one = _dry43(r['tx']['id'] if s == 201 else None)
    check('43 bare: a mempool-only bare spend stays a warning (conflict, not stale)',
          s == 200 and one.get('verdict') == 'conflict' and len(one.get('conflict', [])) == 1, one)
    check('43 notes: a verified mempool-only spend is called not confirmed yet',
          'not confirmed yet' in (one.get('note') or '') and 'cannot say' not in (one.get('note') or ''), one.get('note'))
    # Our own transaction already out: SECOND:0 spent (confirmed),
    # and the node knows our txid.
    req('POST', '/__test__/outspend', {'txid': 'aa' * 32, 'vout': 0, 'blockHeight': STUB_TIP}, base=_bs_base)
    _own_hex = v.craft_prev('aa' * 32, 0, 114003)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': _own_hex, 'label': 'Bare own', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    check('43 bare: own-spend tx added', s == 201, (s, r))
    _own43 = r['tx']['id'] if s == 201 else None
    s, body = raw_req('POST', '/api/tx', _bs_base, host='127.0.0.1:%d' % _bs_port,
                      headers={'Content-Type': 'text/plain'}, body=_own_hex.encode())
    check('43 bare: our transaction is known to the node', s == 200, (s, body))
    check('43 bare: caches cleared for the own check', _clear43())
    s, one = _dry43(_own43)
    check('43 bare: a bare spend by our own txid is recognised as broadcast, not stale',
          s == 200 and one.get('verdict') == 'broadcast'
          and (one.get('own') or [{}])[0].get('spentBy') == v.txid_of(_own_hex), one)
    check('43 notes: the own-spend note says the node knows our txid',
          'the node knows its txid' in (one.get('note') or ''), one.get('note'))
    # UTXO rule, N=1: a confirmed bare spend fires at once.
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': 'aa' * 32 + ':0', 'confirmations': 1}}}, base=_ab43)
    check('43 utxo: N=1 fires on a confirmed bare spend', s == 200 and r.get('fire') is True, r)
    # UTXO rule, N=3: counted from first sighting (tip 900,000),
    # so it waits, then fires once the tip is two blocks higher.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(1, 114004), 'label': 'Bare N3',
               'trigger': {'type': 'utxo', 'params': {'outpoint': 'aa' * 32 + ':0', 'confirmations': 3}},
               'triggerConfirmed': True}, base=_ab43)
    check('43 utxo: N=3 tx added', s == 201, (s, r))
    _n3 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/release/check', {}, base=_ab43)
    t = state_tx(_n3, base=_ab43)
    sl = rule_slice(t) if t else {}
    lo = (sl or {}).get('lastOutspend') or {}
    check('43 utxo: N=3 first sighting stamps the tip height', lo.get('firstSeenConfirmedHeight') == STUB_TIP, lo)
    check('43 utxo: N=3 waits at 1 of 3 confirmations', lo.get('confirmations') == 1 and not t.get('broadcasted'), (lo, t.get('broadcasted')))
    check('43 notes: the count from first sighting reads as a minimum',
          (sl.get('reason') or '').startswith('spent — at least 1 of 3 confirmations'), sl.get('reason'))
    req('POST', '/__test__/tip', {'height': STUB_TIP + 1}, base=_bs_base)
    check('43 utxo: caches cleared after one block', _clear43())
    req('POST', '/api/release/check', {}, base=_ab43)
    t = state_tx(_n3, base=_ab43)
    lo = (rule_slice(t) or {}).get('lastOutspend') or {}
    check('43 utxo: one block later it reads 2 of 3, first sighting unchanged',
          lo.get('confirmations') == 2 and lo.get('firstSeenConfirmedHeight') == STUB_TIP and not t.get('broadcasted'), lo)
    req('POST', '/__test__/tip', {'height': STUB_TIP + 2}, base=_bs_base)
    check('43 utxo: caches cleared after two blocks', _clear43())
    req('POST', '/api/release/check', {}, base=_ab43)
    t = state_tx(_n3, base=_ab43)
    check('43 utxo: at 3 confirmations from first sighting it fires and broadcasts', t and t.get('broadcasted'), t and t.get('release'))

    # --- 44. restore re-checks every card against the node ---
    # Broadcast and stale claims are dropped on restore, then re-
    # derived by the node check, so those cards return to Archived.
    def _by_label44(st, label):
        return next((t for t in (st.get('bitcoin') or {}).get('txs', []) if t.get('label') == label), None)
    s, bak44 = req('POST', '/api/backup', {}, base=_ab43)
    check('44 restore: backup fetched', s == 200 and 'state' in bak44, s)
    check('44 restore: caches cleared before the restore', _clear43())
    s, r = req('POST', '/api/restore', bak44, base=_ab43, timeout=60)
    check('44 restore: restore succeeds', s == 200 and r.get('ok') is True, (s, r))
    rc = r.get('recheck') or {}
    check('44 restore: the response says what the check found',
          rc.get('checked') == r.get('restoredTxs') and rc.get('stale', 0) >= 1 and rc.get('broadcast', 0) >= 1
          and rc.get('conflict', 0) >= 1 and rc.get('unchecked') == 0, rc)
    t = _by_label44(r.get('state') or {}, 'Bare confirmed')
    check('44 restore: the restore response already carries the re-derived status',
          t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
    s, st = req('GET', '/api/state', base=_ab43)
    t = _by_label44(st, 'Bare confirmed')
    check('44 restore: a stale transaction is stale again (Archived), not Active',
          t and (t.get('release') or {}).get('status') == 'stale', t and t.get('release'))
    check('44 restore: ... with a stale line in its history',
          t and any(h.get('type') == 'stale' for h in (t.get('history') or [])), t and t.get('history'))
    t = _by_label44(st, 'Bare own')
    check('44 restore: our own broadcast transaction is broadcast again (Archived)',
          t and t.get('broadcasted') and (t.get('release') or {}).get('status') == 'broadcast',
          t and (t.get('broadcasted'), t.get('release')))
    t = _by_label44(st, 'Bare mempool')
    check('44 restore: an unconfirmed conflict keeps its warning',
          t and (t.get('release') or {}).get('status') == 'conflict', t and t.get('release'))
    # The node cannot answer: nothing is recorded, the restore still
    # succeeds, and the response says how many went unchecked.
    bak44['state']['settings']['primaryApiUrl'] = 'http://127.0.0.1:18199'
    s, r = req('POST', '/api/restore', bak44, base=_ab43, timeout=60)
    rc = r.get('recheck') or {}
    check('44 restore: with the node unreachable the restore still succeeds', s == 200 and r.get('ok') is True, (s, r))
    check('44 restore: ... and says every transaction went unchecked',
          rc.get('unchecked') == r.get('restoredTxs') and rc.get('stale') == 0 and rc.get('broadcast') == 0, rc)
    s, st = req('GET', '/api/state', base=_ab43)
    t = _by_label44(st, 'Bare confirmed')
    check('44 restore: ... and records nothing it could not check',
          t and (t.get('release') or {}).get('status') != 'stale', t and t.get('release'))
    # A node that answers too slowly cannot hold the restore: the
    # check stops at its limit (4 s here) and reports the rest
    # unchecked.
    bak44['state']['settings']['primaryApiUrl'] = _bs_base
    req('POST', '/__test__/outspend-delay', {'ms': 8000}, base=_bs_base)
    check('44 restore: caches cleared before the slow-node restore', _clear43())
    _t0 = time.time()
    s, r = req('POST', '/api/restore', bak44, base=_ab43, timeout=60)
    _took = time.time() - _t0
    rc = r.get('recheck') or {}
    check('44 restore: a hanging node does not hold the restore past its time limit',
          s == 200 and r.get('ok') is True and _took < 8, (s, round(_took, 1)))
    check('44 restore: ... and the transactions it could not check are reported unchecked',
          rc.get('unchecked') == r.get('restoredTxs') and rc.get('stale') == 0, rc)
    req('POST', '/__test__/outspend-delay', {'ms': 0}, base=_bs_base)
    stop(_app43)
    stop(_stub43)

    # --- 45. Bitcoin Core RPC node ---
    # The primary node is the RPC stub (a tiny chain: FINNEY vout 0
    # spent in a block, vout 1 unspent). Own app instance.
    _rpc_port = 18198
    _rpc_base = 'http://127.0.0.1:%d' % _rpc_port
    _stub45 = start(['node', os.path.join(os.path.dirname(v.STUB), 'rpc_stub.js'), str(_rpc_port)], log=_bind_log)
    check('45 rpc: stub comes up', wait_up(_rpc_base, path='/__test__/calls'))
    shutil.rmtree(_bind_data, ignore_errors=True)
    shutil.rmtree(_bind_checkin, ignore_errors=True)
    _app45 = start(['node', 'server.js'], env=_e43, cwd=APP, log=_bind_log)
    check('45 rpc: instance comes up', wait_up(_ab43))
    _rpc_on = {'enabled': True, 'url': '127.0.0.1:%d' % _rpc_port, 'user': 'standby', 'password': 'stubpass'}

    s, r = req('PUT', '/api/settings', {'primaryRpc': dict(_rpc_on, password=''), 'secondaryEnabled': False}, base=_ab43)
    check('45 settings: RPC on without a password is refused (400)', s == 400 and 'password' in r.get('error', ''), (s, r))
    s, r = req('PUT', '/api/settings', {'primaryRpc': dict(_rpc_on, url='ftp://x'), 'secondaryEnabled': False}, base=_ab43)
    check('45 settings: a non-http RPC address is refused (400)', s == 400, (s, r))
    s, r = req('PUT', '/api/settings', {'primaryRpc': _rpc_on, 'secondaryEnabled': False}, base=_ab43)
    check('45 settings: RPC primary saved (200)', s == 200, (s, r))
    check('45 settings: the reply holds no password, only that one is saved',
          r.get('primaryRpc') == {'enabled': True, 'url': _rpc_base, 'user': 'standby', 'hasPassword': True}, r.get('primaryRpc'))
    s, st = req('GET', '/api/state', base=_ab43)
    check('45 settings: GET /api/state never serves the password',
          'stubpass' not in json.dumps(st) and st['settings']['primaryRpc'].get('hasPassword') is True, st['settings'].get('primaryRpc'))
    check('45 settings: the node base is the RPC address',
          (st.get('bitcoin') or {}).get('nodeBases', {}).get('primary') == 'rpc://127.0.0.1:%d' % _rpc_port, (st.get('bitcoin') or {}).get('nodeBases'))
    with open(os.path.join(_bind_data, 'state.json')) as f:
        check('45 settings: the password is stored on the device', json.load(f)['settings']['primaryRpc']['password'] == 'stubpass')
    s, r = req('PUT', '/api/settings', {'primaryRpc': dict(_rpc_on, password='')}, base=_ab43)
    with open(os.path.join(_bind_data, 'state.json')) as f:
        check('45 settings: saving with a blank password keeps the stored one',
              s == 200 and json.load(f)['settings']['primaryRpc']['password'] == 'stubpass', (s, r))

    def _test45():
        s, r = req('POST', '/api/bitcoin/connection/test', {}, base=_ab43)
        return {x.get('endpoint'): x for x in r.get('results', [])}.get('primary', {})

    def _clear45():
        return req('POST', '/api/__test__/clear-caches', {'only': ['outspend', 'nodeTip']}, base=_ab43)[0] == 200

    pr = _test45()
    ck = pr.get('checks') or {}
    check('45 test: RPC node with txindex is OK on every row',
          pr.get('status') == 'ok' and (ck.get('height') or {}).get('value') == 'Height 900,000'
          and (ck.get('fees') or {}).get('value') == '1 sat/vB' and (ck.get('broadcast') or {}).get('value') == 'Reachable'
          and (ck.get('outputLookup') or {}).get('value') == 'RPC with txindex', pr)
    s, calls = req('GET', '/__test__/calls', base=_rpc_base)
    check('45 test: the broadcast probe sent nothing', calls.get('sendrawtransaction', 0) >= 1, calls)
    s, sent = req('GET', '/__test__/sent', base=_rpc_base)
    check('45 test: ... and nothing was accepted', sent == [], sent)
    check('45 rpc user: a whitelisted login reads Restricted',
          (ck.get('rpcUser') or {}).get('value') == 'Restricted', ck.get('rpcUser'))
    req('POST', '/__test__/restricted', {'enabled': False}, base=_rpc_base)
    pr = _test45()
    ru = (pr.get('checks') or {}).get('rpcUser') or {}
    check('45 rpc user: an unrestricted login reads Unrestricted with advice, and the node stays OK',
          pr.get('status') == 'ok' and ru.get('value') == 'Unrestricted' and ru.get('warn') is True
          and 'restricted user' in (ru.get('note') or ''), pr)
    req('POST', '/__test__/restricted', {'enabled': True}, base=_rpc_base)
    req('POST', '/__test__/txindex', {'enabled': False}, base=_rpc_base)
    _clear45()
    pr = _test45()
    ol = (pr.get('checks') or {}).get('outputLookup') or {}
    check('45 txindex: off reads CAUTION with "txindex off" and how to enable it',
          pr.get('status') == 'caution' and ol.get('value') == 'txindex off' and ol.get('warn') is True
          and 'txindex=1' in (ol.get('note') or ''), pr)
    req('POST', '/__test__/txindex', {'enabled': True, 'synced': False}, base=_rpc_base)
    pr = _test45()
    check('45 txindex: still building reads CAUTION and says so',
          pr.get('status') == 'caution' and ((pr.get('checks') or {}).get('outputLookup') or {}).get('value') == 'txindex still building', pr)
    req('POST', '/__test__/txindex', {'enabled': True}, base=_rpc_base)
    s, r = req('PUT', '/api/settings', {'primaryRpc': dict(_rpc_on, password='wrong')}, base=_ab43)
    pr = _test45()
    check('45 test: a wrong password fails and says so',
          pr.get('status') == 'fail' and 'login failed' in (pr.get('detail') or ''), pr)
    req('PUT', '/api/settings', {'primaryRpc': _rpc_on}, base=_ab43)

    def _dry45(tx_id):
        s, r = req('POST', '/api/broadcast/test', {'id': tx_id}, base=_ab43)
        return s, (r.get('results') or [{}])[0]

    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(1, 120000), 'label': 'RPC ready', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    check('45 tx: added over RPC (201)', s == 201, (s, r))
    _ready45 = r['tx']['id'] if s == 201 else None
    check('45 tx: fee from the parent output (150,000 - 120,000)', r.get('tx', {}).get('feeSats') == 30000, r.get('tx', {}).get('feeSats'))
    s, one = _dry45(_ready45)
    check('45 dry run: unspent input reads ready', s == 200 and one.get('verdict') == 'ready', one)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(0, 120001), 'label': 'RPC stale', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    _stale45 = r['tx']['id'] if s == 201 else None
    s, one = _dry45(_stale45)
    check('45 dry run: an input spent in a block reads stale', s == 200 and one.get('verdict') == 'blocked' and len(one.get('spent', [])) == 1, one)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': v.FINNEY + ':0', 'confirmations': 0}}}, base=_ab43)
    check('45 utxo: a spent outpoint fires', s == 200 and r.get('fire') is True, r)
    # With -txospenderindex Core names a confirmed spender and its
    # block: still stale, now with the spender and height. While the
    # index is behind it errors, and the spend reads as without it.
    req('POST', '/__test__/spender-index', {'mode': 'synced'}, base=_rpc_base)
    _clear45()
    s, one = _dry45(_stale45)
    sp = (one.get('spent') or [{}])[0]
    check('45 spender index: a confirmed spend is stale, naming the spender and block',
          s == 200 and one.get('verdict') == 'blocked' and sp.get('spentBy') == 'bb' * 32 and sp.get('blockHeight') == 899990, one)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': v.FINNEY + ':0', 'confirmations': 6}}}, base=_ab43)
    check('45 spender index: a UTXO rule counts confirmations from the spend block (11 >= 6, fires)', s == 200 and r.get('fire') is True, r)
    req('POST', '/__test__/spender-index', {'mode': 'behind'}, base=_rpc_base)
    _clear45()
    s, one = _dry45(_stale45)
    check('45 spender index: while the index is behind, the spend still reads stale (via txindex)',
          s == 200 and one.get('verdict') == 'blocked' and len(one.get('spent', [])) == 1, one)
    req('POST', '/__test__/spender-index', {'mode': 'off'}, base=_rpc_base)
    # The same RPC node in both slots is asked once, with the primary's
    # login (the secondary's must not replace it).
    s, r = req('PUT', '/api/settings', {'secondaryEnabled': True, 'secondaryRpc': dict(_rpc_on, user='other', password='otherpass')}, base=_ab43)
    pr = _test45()
    check('45 same node twice: the primary keeps its own login (OK)', s == 200 and pr.get('status') == 'ok', (s, pr.get('detail')))
    req('PUT', '/api/settings', {'secondaryEnabled': False, 'secondaryRpc': dict(_rpc_on, enabled=False)}, base=_ab43)
    # A mempool spend by someone else: a conflict naming the spender.
    req('POST', '/__test__/mempool-spend', {'txid': v.SECOND, 'vout': 0, 'spender': 'cd' * 32}, base=_rpc_base)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft_prev(v.SECOND, 0, 120002), 'label': 'RPC conflict', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    _conf45 = r['tx']['id'] if s == 201 else None
    _clear45()
    s, one = _dry45(_conf45)
    check('45 dry run: a mempool spend is a conflict naming the spender',
          s == 200 and one.get('verdict') == 'conflict' and (one.get('conflict') or [{}])[0].get('spentBy') == 'cd' * 32, one)
    # Without txindex: the fee still comes from the UTXO set, and a
    # spend in a block reads unknown, never stale.
    req('POST', '/__test__/txindex', {'enabled': False}, base=_rpc_base)
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': v.craft(1, 120003), 'label': 'RPC no index', 'trigger': {'type': 'manual', 'params': {}}}, base=_ab43)
    check('45 no txindex: the fee still reads (from the UTXO set)', s == 201 and r['tx'].get('feeSats') == 29997, r.get('tx', {}).get('feeSats'))
    _clear45()
    s, one = _dry45(_stale45)
    check('45 no txindex: a spend in a block is unknown, not stale',
          s == 200 and one.get('verdict') != 'blocked' and len(one.get('spent', [])) == 0, one)
    req('POST', '/__test__/txindex', {'enabled': True}, base=_rpc_base)
    # Broadcast by hand: sent once, confirmed, then recognised as ours.
    s, r = req('POST', '/api/bitcoin/txs/' + _ready45 + '/broadcast', {}, base=_ab43)
    check('45 broadcast: sent over RPC', s == 200 and (r.get('tx') or {}).get('broadcasted'), (s, r))
    s, sent = req('GET', '/__test__/sent', base=_rpc_base)
    check('45 broadcast: the node received exactly that hex', sent == [v.craft(1, 120000)], len(sent))
    s, r = req('GET', '/api/bitcoin/confirmations', base=_ab43)
    c = next((x for x in r.get('confirmations', []) if x.get('id') == _ready45), {})
    check('45 broadcast: confirmations read from the node (block 899,995)', c.get('blockHeight') == 899995 and c.get('confirmations') == 6, c)
    # Backup and restore carry the RPC login.
    s, bak = req('POST', '/api/backup', {}, base=_ab43)
    check('45 backup: the backup carries the RPC login', bak['state']['settings']['primaryRpc']['password'] == 'stubpass', bak['state']['settings'].get('primaryRpc', {}).keys())
    bak['state']['settings']['primaryRpc']['password'] = 'stubpass'
    s, r = req('POST', '/api/restore', bak, base=_ab43, timeout=60)
    check('45 restore: restores with the RPC node (200)', s == 200 and r.get('ok') is True, (s, r))
    check('45 restore: ... and serves no password', 'stubpass' not in json.dumps(r), (r.get('state') or {}).get('settings', {}).get('primaryRpc'))
    with open(os.path.join(_bind_data, 'state.json')) as f:
        check('45 restore: ... with the RPC login stored', json.load(f)['settings']['primaryRpc'] == dict(_rpc_on, url=_rpc_base))
    # Back to a mempool node.
    s, r = req('PUT', '/api/settings', {'primaryRpc': dict(_rpc_on, enabled=False)}, base=_ab43)
    s, st = req('GET', '/api/state', base=_ab43)
    check('45 settings: RPC off uses the mempool URL again',
          s == 200 and not (st['settings']['primaryRpc'] or {}).get('enabled') and not st['bitcoin']['nodeBases']['primary'].startswith('rpc'), st['bitcoin'].get('nodeBases'))
    with open(os.path.join(_bind_data, 'state.json')) as f:
        _off45 = json.load(f)['settings']['primaryRpc']
        check('45 settings: RPC off forgets the login, keeping the address',
              _off45 == {'enabled': False, 'url': _rpc_base, 'user': '', 'password': ''}, _off45)
    stop(_app45)
    stop(_stub45)
