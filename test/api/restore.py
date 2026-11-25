"""API suite: Restore carries the trigger types (section 9)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 9. restore carries the new triggers -------------------------
    s, r = add_tx('R blockheight', {'type': 'blockheight', 'params': {'targetHeight': STUB_TIP + 50000}}, 111000)
    r_bh = r['tx']['id'] if s == 201 else None
    s, r = add_tx('R setdate', {'type': 'setdate', 'params': {'fireAt': iso_in(days=30)}}, 111002)
    r_sd = r['tx']['id'] if s == 201 else None
    s, r = add_tx('R feemarket', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 111004)
    r_fm = r['tx']['id'] if s == 201 else None
    s, bak = req('POST', '/api/backup', {})
    check('9 restore: backup fetched', s == 200, (s, r))
    delete_all_txs()
    s, st = req('GET', '/api/state')
    check('9 restore: txs deleted before restore', st.get('bitcoin', {}).get('txs') == [], st.get('bitcoin', {}).get('txs'))
    s, r = req('POST', '/api/restore', bak)
    check('9 restore: backup restores (200)', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
    check('9 restore: block-height trigger survives',
          by_label.get('R blockheight', {}).get('trigger', {}).get('type') == 'blockheight'
          and by_label.get('R blockheight', {}).get('trigger', {}).get('params', {}).get('targetHeight') == STUB_TIP + 50000,
          by_label.get('R blockheight', {}).get('trigger'))
    check('9 restore: set-date trigger survives',
          by_label.get('R setdate', {}).get('trigger', {}).get('type') == 'setdate'
          and by_label.get('R setdate', {}).get('trigger', {}).get('params', {}).get('fireAt') is not None,
          by_label.get('R setdate', {}).get('trigger'))
    check('9 restore: fee-market trigger survives',
          by_label.get('R feemarket', {}).get('trigger', {}).get('type') == 'feemarket'
          and by_label.get('R feemarket', {}).get('trigger', {}).get('params', {}).get('maxFeeRate') == 0.5,
          by_label.get('R feemarket', {}).get('trigger'))
    # A backup with a fabricated broadcasted fact and 'broadcast'
    # record (txids matching) restores active: both claims are
    # dropped. A 'failed' record rides along.
    bak2 = copy.deepcopy(bak)
    for tx2 in bak2['state']['bitcoin']['txs']:
        if tx2.get('label') == 'R blockheight':
            tx2['broadcasted'] = {'txid': tx2['txid'], 'broadcastedAt': '2026-11-18T00:00:00.000Z',
                                  'method': 'primary', 'confirmations': 3, 'blockHeight': 899999,
                                  'found': True, 'checkedAt': '2026-11-18T00:00:00.000Z'}
            tx2['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                              'txid': tx2['txid'], 'method': 'primary',
                              'broadcastedAt': '2026-11-18T00:00:00.000Z'}
        if tx2.get('label') == 'R setdate':
            tx2['release'] = {'status': 'failed', 'kind': 'release', 'trigger': 'setdate',
                              'txid': tx2['txid'], 'method': 'primary',
                              'lastAttemptAt': '2026-11-18T00:00:00.000Z', 'error': 'test failure'}
    delete_all_txs()
    s, r = req('POST', '/api/restore', bak2)
    check('9 restore: edited backup restores (200)', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    by_label = {t.get('label'): t for t in st.get('bitcoin', {}).get('txs', [])}
    check('9 restore: fabricated broadcasted fact is dropped',
          by_label.get('R blockheight', {}).get('broadcasted') is None,
          by_label.get('R blockheight', {}).get('broadcasted'))
    check('9 restore: fabricated broadcast release record is dropped',
          by_label.get('R blockheight', {}).get('release') is None,
          by_label.get('R blockheight', {}).get('release'))
    check('9 restore: transient failed record rides along',
          (by_label.get('R setdate', {}).get('release') or {}).get('status') == 'failed',
          by_label.get('R setdate', {}).get('release'))
    delete_all_txs()
