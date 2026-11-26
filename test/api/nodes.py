"""API suite: Node checks, UTXO lookups, outspend caching and negotiation (sections 10-13, 23, 25-26, 37-38, 42)."""
from api.common import *  # noqa: F401,F403 (the suite's helpers and constants)
from api.common import _bind_checkin, _bind_data, _bind_log  # noqa: F401


def run():
    # --- 10. node capability test (OK / CAUTION / FAIL) ---
    # Both stubs answer everything: OK.
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    check('10 nodes: connection test returns 200', s == 200, (s, r))
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('10 nodes: primary is OK with all four checks ready',
          res.get('primary', {}).get('status') == 'ok'
          and res.get('primary', {}).get('checks', {}).get('height', {}).get('ok') is True
          and res.get('primary', {}).get('checks', {}).get('fees', {}).get('ok') is True
          and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('ok') is True
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True,
          res.get('primary'))
    check('10 nodes: primary shows the measured values next to each status',
          res.get('primary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
          and res.get('primary', {}).get('checks', {}).get('fees', {}).get('value') == '1 sat/vB'
          and res.get('primary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'Reachable'
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Full answers',
          res.get('primary', {}).get('checks'))
    check('10 nodes: secondary is OK too', res.get('secondary', {}).get('status') == 'ok', res.get('secondary'))
    check('10 nodes: overall ok is true', r.get('ok') is True, r.get('ok'))
    # A height-only server is CAUTION: a node, but no fees or
    # broadcast.
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class HeightOnly(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/api/blocks/tip/height':
                self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
                self.wfile.write(b'900000')
            else:
                self.send_response(404); self.end_headers()
        def do_POST(self):
            self.send_response(404); self.end_headers()
        def log_message(self, *a):
            pass
    height_srv = HTTPServer(('127.0.0.1', 18190), HeightOnly)
    threading.Thread(target=height_srv.serve_forever, daemon=True).start()
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:18190'})
    check('10 nodes: secondary pointed at the height-only server', s == 200, (s, r))
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('10 nodes: height-only secondary is CAUTION',
          res.get('secondary', {}).get('status') == 'caution'
          and res.get('secondary', {}).get('checks', {}).get('height', {}).get('ok') is True
          and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('ok') is False
          and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False
          and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False,
          res.get('secondary'))
    check('10 nodes: height-only secondary shows the height value and the failure reasons',
          res.get('secondary', {}).get('checks', {}).get('height', {}).get('value') == 'Height 900,000'
          and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('value') == 'no fee endpoint'
          and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('value') == 'answered HTTP 404'
          and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
          res.get('secondary', {}).get('checks'))
    check('10 nodes: height-only secondary detail lists every failing check (multi-failure format)',
          'output lookup:' in res.get('secondary', {}).get('detail', ''),
          res.get('secondary', {}).get('detail'))
    check('10 nodes: primary stays OK while secondary is CAUTION', res.get('primary', {}).get('status') == 'ok', res.get('primary'))
    check('10 nodes: overall ok stays true with a CAUTION node', r.get('ok') is True, r.get('ok'))
    # An Esplora-style server is CAUTION with fees ready via /fee-
    # estimates.
    class EsploraStyle(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/api/blocks/tip/height':
                self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
                self.wfile.write(b'900000')
            elif self.path == '/api/fee-estimates':
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(b'{"1": 2, "2": 2, "3": 1, "6": 1, "144": 1, "1008": 1}')
            else:
                self.send_response(404); self.end_headers()
        def do_POST(self):
            self.send_response(404); self.end_headers()
        def log_message(self, *a):
            pass
    esplora_srv = HTTPServer(('127.0.0.1', 18191), EsploraStyle)
    threading.Thread(target=esplora_srv.serve_forever, daemon=True).start()
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:18191'})
    check('10 nodes: secondary pointed at the Esplora-style server', s == 200, (s, r))
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('10 nodes: Esplora-style secondary is CAUTION with fees ready via the fallback',
          res.get('secondary', {}).get('status') == 'caution'
          and res.get('secondary', {}).get('checks', {}).get('height', {}).get('ok') is True
          and res.get('secondary', {}).get('checks', {}).get('fees', {}).get('ok') is True
          and res.get('secondary', {}).get('checks', {}).get('broadcast', {}).get('ok') is False
          and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False,
          res.get('secondary'))
    check('10 nodes: Esplora-style output lookup is unavailable (both outspend routes 404)',
          res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
          res.get('secondary', {}).get('checks', {}).get('outputLookup'))
    check('10 nodes: Esplora-style fee value is the 6-block rate',
          res.get('secondary', {}).get('checks', {}).get('fees', {}).get('value') == '1 sat/vB',
          res.get('secondary', {}).get('checks', {}).get('fees'))
    esplora_srv.shutdown()
    esplora_srv.server_close()
    # A closed port is FAIL: unreachable.
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('10 nodes: unreachable secondary is FAIL',
          res.get('secondary', {}).get('status') == 'fail'
          and res.get('secondary', {}).get('ok') is False
          and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('detail') == 'not checked — height failed'
          and res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == '—',
          res.get('secondary'))
    check('10 nodes: overall ok stays true with one good node', r.get('ok') is True, r.get('ok'))
    # Restore the stub secondary and stop the height-only server.
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S})
    check('10 nodes: secondary restored to the stub', s == 200, (s, r))
    height_srv.shutdown()
    height_srv.server_close()

    # --- 11. per-node checked stamps ---
    # The secondary is only asked on fallback, so a release check with
    # a watching fee tx moves the primary's stamp only.
    s, st = req('GET', '/api/state')
    conn0 = (st.get('bitcoin', {}) or {}).get('connection') or {}
    stamps0 = conn0.get('nodeCheckedAt') or {}
    check('11 stamps: the stored connection carries per-node stamps',
          isinstance(stamps0, dict) and 'primary' in stamps0 and 'secondary' in stamps0,
          stamps0)
    # A connection test asks both endpoints, so both stamps
    # land on the test time.
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    check('11 stamps: connection test runs for the stamp baseline', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    stamps1 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
    check('11 stamps: after a connection test both stamps are set',
          bool(stamps1.get('primary')) and bool(stamps1.get('secondary')),
          stamps1)
    # Restart for a cold fee cache; the restart re-tests both nodes,
    # so re-read the baseline after it.
    check('11 stamps: app restarted for a cold fee cache', restart())
    s, st = req('GET', '/api/state')
    stamps1 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
    check('11 stamps: after restart both stamps read the startup test',
          bool(stamps1.get('primary')) and bool(stamps1.get('secondary')),
          stamps1)
    s, r = add_tx('Stamp FM', {'type': 'feemarket', 'params': {'maxFeeRate': 0.5}}, 110800)
    check('11 stamps: watching fee tx added', s == 201, (s, r))
    s, r, res = release_results()
    check('11 stamps: release check runs', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    stamps2 = (((st.get('bitcoin', {}) or {}).get('connection') or {}).get('nodeCheckedAt') or {})
    check('11 stamps: the release check moves the primary stamp past the test time',
          bool(stamps2.get('primary')) and stamps2.get('primary') > stamps1.get('primary'),
          (stamps1, stamps2))
    check('11 stamps: the secondary stamp does not move on a primary-only check',
          stamps2.get('secondary') == stamps1.get('secondary'),
          (stamps1, stamps2))
    delete_all_txs()

    # --- 12. custom price source ---
    # { id, url, path } reads a price from any JSON endpoint by dot-
    # path. It decides as primary, falls back as secondary, validates
    # like a built-in and survives restore. The URL points at the
    # stub's CoinGecko route.
    CG_URL = STUB_BASE_P + '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
    KR_URL = STUB_BASE_P + '/0/public/Ticker?pair=XBTUSD'
    CB_URL = STUB_BASE_P + '/v2/prices/BTC-USD/spot'
    custom_cg = {'id': 'custom', 'url': CG_URL, 'path': 'bitcoin.usd'}
    # Stub prices back to the defaults both sources read.
    s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    check('12 stub prices reset to $98,200', s == 200, pr)
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': 'coinbase'}})
    check('12 custom primary (CoinGecko shape) saves (200)', s == 200, (s, r))
    check('12 caches cleared before the custom eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('12 custom primary: price check fires on the custom reading ($98,200)',
          s == 200 and r.get('fire') is True, r)
    s, st = req('GET', '/api/state')
    check('12 custom primary: settings store the custom object',
          st.get('settings', {}).get('priceSources', {}).get('source1') == custom_cg,
          st.get('settings', {}).get('priceSources'))
    check('12 custom primary: currentPrices are slot-keyed, Custom reads $98,200',
          (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('provider') == 'custom'
          and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('label') == 'Custom'
          and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('price') == 98200
          and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('provider') == 'coinbase'
          and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source2', {}).get('price') == 98200,
          st.get('bitcoin', {}).get('currentPrices'))
    check('12 custom primary: currentPrice is the primary (custom) price ($98,200)',
          st.get('bitcoin', {}).get('currentPrice') == 98200, st.get('bitcoin', {}).get('currentPrice'))
    check('12 custom primary: Exchange Status is ok with a Custom row',
          (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'ok'
          and [x.get('label') for x in (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('sources', [])] == ['Custom', 'Coinbase'],
          st.get('bitcoin', {}).get('exchangeStatus'))
    # Custom primary decides: $100,000 vs Coinbase $98,200 (they
    # agree). '>=' $99,000 fires; '<=' $99,000 watches.
    s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 100000}, base=STUB_BASE_P)
    check('12 CoinGecko stub set to $100,000', s == 200 and pr.get('coingecko', {}).get('usd') == 100000, pr)
    check('12 caches cleared before the straddle eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 99000}}})
    check('12 custom decides: >= $99,000 fires on the custom $100,000',
          s == 200 and r.get('fire') is True and 'Custom' in str(r.get('reason', '')), r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '<=', 'value': 99000}}})
    check('12 custom decides: <= $99,000 watches (Coinbase $98,200 does not decide)',
          s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    # Disagree: CoinGecko $90,000 vs Coinbase $98,200 (8.7% apart).
    s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 90000}, base=STUB_BASE_P)
    check('12 CoinGecko stub set to $90,000', s == 200 and pr.get('coingecko', {}).get('usd') == 90000, pr)
    check('12 caches cleared before the disagree eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('12 custom disagree: 8.7% apart is unknown, never fires',
          s == 200 and r.get('fire') is False and r.get('status') == 'unknown', r)
    # A path that matches nothing: the custom source is down and
    # Coinbase alone decides (single mode).
    s, pr = req('POST', '/__test__/price', {'provider': 'coingecko', 'usd': 98200}, base=STUB_BASE_P)
    check('12 CoinGecko stub back to $98,200', s == 200, pr)
    bad_path = {'id': 'custom', 'url': CG_URL, 'path': 'nope.missing'}
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': bad_path, 'source2': 'coinbase'}})
    check('12 a well-formed but unmatched path still saves (200)', s == 200, (s, r))
    check('12 caches cleared before the single-source eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 98000}}})
    check('12 unmatched path: the custom source is down, Coinbase alone fires',
          s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
    s, st = req('GET', '/api/state')
    check('12 unmatched path: the custom reading is null with an error, Exchange Status degraded',
          (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('price') is None
          and (st.get('bitcoin', {}).get('currentPrices') or {}).get('source1', {}).get('error')
          and (st.get('bitcoin', {}).get('exchangeStatus') or {}).get('status') == 'degraded',
          (st.get('bitcoin', {}).get('currentPrices'), st.get('bitcoin', {}).get('exchangeStatus')))
    # Kraken (result.XXBTZUSD.c[0], a string) and Coinbase
    # (data.amount) shapes both read through the walker.
    custom_kr = {'id': 'custom', 'url': KR_URL, 'path': 'result.XXBTZUSD.c[0]'}
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_kr, 'source2': 'coinbase'}})
    check('12 Kraken-shaped custom saves (200)', s == 200, (s, r))
    check('12 caches cleared before the Kraken-shape eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('12 Kraken shape: result.XXBTZUSD.c[0] reads $98,200',
          s == 200 and r.get('fire') is True, r)
    custom_cb = {'id': 'custom', 'url': CB_URL, 'path': 'data.amount'}
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cb, 'source2': 'coinbase'}})
    check('12 Coinbase-shaped custom saves (200)', s == 200, (s, r))
    check('12 caches cleared before the Coinbase-shape eval (empty cache)', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'price', 'params': {'op': '>=', 'value': 90000}}})
    check('12 Coinbase shape: data.amount reads $98,200 (string coerced)',
          s == 200 and r.get('fire') is True, r)
    # Validation: bad URLs, bad paths, and identical sources
    # are 400s; two customs that differ only by path are fine.
    bad_customs = [
        ({'id': 'custom', 'url': 'ftp://example.com/p', 'path': 'data.amount'}, 'ftp URL'),
        ({'id': 'custom', 'url': 'not a url', 'path': 'data.amount'}, 'unparseable URL'),
        ({'id': 'custom', 'url': CG_URL, 'path': ''}, 'empty path'),
        ({'id': 'custom', 'url': CG_URL, 'path': 'a..b'}, 'doubled dot'),
        ({'id': 'custom', 'url': CG_URL, 'path': 'x['}, 'unclosed bracket'),
        ({'id': 'custom', 'url': CG_URL}, 'missing path'),
        ({'id': 'custom', 'path': 'data.amount'}, 'missing url'),
    ]
    for bad, label in bad_customs:
        s, r = req('PUT', '/api/settings', {'priceSources': {'source1': bad, 'source2': 'coinbase'}})
        check('12 validation rejects custom with %s (400)' % label, s == 400, (s, r))
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': custom_cg}})
    check('12 validation rejects two identical customs (400)', s == 400, (s, r))
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': {'id': 'custom', 'url': CG_URL, 'path': 'bitcoin.usd.x'}}})
    check('12 two customs differing only by path are accepted (200)', s == 200, (s, r))
    # test-all takes a custom descriptor and answers it.
    s, r = req('POST', '/api/settings/price-sources/test-all', {'providers': [custom_cg, 'coinbase']})
    check('12 test-all: custom + Coinbase both answer $98,200',
          s == 200 and len(r.get('results', [])) == 2
          and r['results'][0].get('provider') == 'custom' and r['results'][0].get('label') == 'Custom'
          and r['results'][0].get('price') == 98200 and r['results'][1].get('price') == 98200, r)
    # Restore carries the custom source.
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': custom_cg, 'source2': 'coinbase'}})
    check('12 custom restored as the configured sources (200)', s == 200, (s, r))
    s, bak = req('POST', '/api/backup', {})
    check('12 restore: backup fetched', s == 200, (s, bak))
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'coingecko', 'source2': 'coinbase'}})
    check('12 restore: sources reset to defaults first', s == 200, (s, r))
    s, r = req('POST', '/api/restore', bak)
    check('12 restore: backup restores (200)', s == 200, (s, r))
    s, st = req('GET', '/api/state')
    check('12 restore: the custom source survives',
          st.get('settings', {}).get('priceSources', {}).get('source1') == custom_cg,
          st.get('settings', {}).get('priceSources'))
    # Back to the defaults so later sections (and the next run)
    # see CoinGecko + Coinbase at $98,200.
    s, pr = req('POST', '/__test__/price', {'usd': 98200}, base=STUB_BASE_P)
    s, r = req('PUT', '/api/settings', {'priceSources': {'source1': 'coingecko', 'source2': 'coinbase'}})
    check('12 defaults restored (CoinGecko + Coinbase)', s == 200, (s, r))

    # --- 13. UTXO 404 failover ---
    # A primary 404 is inconclusive, so the secondary is asked (and
    # fires on FINNEY:0's confirmed spend). Both 404: unknown, never
    # fires.
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
    check('13 primary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
    check('13 404 failover: primary 404s, secondary knows the spend — fires', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
    # The freshness path too: a dry-run of a tx spending FINNEY:0
    # must see the spend (stale), not an unknown input.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 113000), 'label': 'U404 dryrun', 'trigger': {'type': 'manual', 'params': {}}})
    check('13 404 dry-run tx added (201)', s == 201, (s, r))
    u404 = r['tx']['id'] if s == 201 else None
    s, r = req('POST', '/api/broadcast/test', {'id': u404})
    one = (r.get('results') or [{}])[0]
    check('13 404 dry-run: spent input seen via the secondary', s == 200 and len(one.get('spent', [])) == 1, one)
    # Both 404: unknown, never fires. Restart first for a cold
    # outspend cache.
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
    check('13 secondary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
    check('13 both 404: caches cleared for a cold outpoint cache', clear_caches())
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
    check('13 both 404: unknown, never fires', s == 200 and r.get('fire') is False and r.get('status') == 'unknown', r)
    # Cleanup: both stubs know FINNEY again.
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
    check('13 unknown-parent cleared on both stubs', s == 200, (s, r))
    delete_all_txs()

    # --- 23. archived txs make no network calls; one primary tip
    # fetch per tick ---
    # Archived txs are not evaluated and not re-queried past 6
    # confirmations; the tip is fetched once per tick from the
    # primary. The tick is parked (cadence 3600 s).
    def tip_counts():
        _, rp = req('GET', '/__test__/tip-count', base=STUB_BASE_P)
        _, rs = req('GET', '/__test__/tip-count', base=STUB_BASE_S)
        return rp.get('count', -1), rs.get('count', -1)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('23 setup: cadence parked at 3600 s', s == 200, (s, r))
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip', {'height': STUB_TIP}, base=STUB_BASE_S)
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_S)
    check('23 setup: caches cleared for a cold tip cache', clear_caches())
    FROZEN = iso_ago(hours=2)
    # (a) An archived tx (>= 6 confirmations) and a stale one, seeded
    # via the state file with frozen slices, plus a disarmed price tx
    # whose slice must still refresh.
    s, r = add_tx('Arch BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111300)
    check('23 archived: watching blockheight tx adds', s == 201, (s, r))
    arch23 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('Stale BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111301)
    check('23 stale: watching blockheight tx adds', s == 201, (s, r))
    stale23 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('Dis Price', {'type': 'price', 'params': {'op': '>=', 'value': 150000}}, 111302)
    check('23 disarmed: watching price tx adds', s == 201, (s, r))
    dis23 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + dis23, {'enabled': False})
    check('23 disarmed: the price tx disarms', s == 200, (s, r))
    stj = load_state_file()
    by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
    frozen_slice = {'lastEvalAt': FROZEN, 'status': 'watching', 'reason': 'block 900,000 of 950,000',
                    'lastTipHeight': STUB_TIP, 'lastPrice': None, 'lastPriceAt': None,
                    'lastOutspend': None, 'lastError': None, 'tipMode': 'dual',
                    'tipNote': 'primary 900,000 · secondary 900,000'}
    arch_tx = by_id.get(arch23)
    arch_tx['broadcasted'] = {'txid': arch_tx.get('txid'), 'broadcastedAt': FROZEN, 'method': 'mempool.space',
                              'confirmations': 7, 'blockHeight': 899993, 'found': True, 'checkedAt': FROZEN}
    arch_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                          'txid': arch_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN}
    arch_tx['triggerState'] = [dict(frozen_slice)]
    stale_tx = by_id.get(stale23)
    stale_tx['release'] = {'status': 'stale', 'kind': 'release', 'trigger': 'blockheight',
                           'txid': stale_tx.get('txid'), 'method': 'mempool.space',
                           'error': 'inputs spent: staged'}
    stale_tx['triggerState'] = [dict(frozen_slice)]
    save_state_file(stj)
    check('23 archived: app restarted with the seeded terminal txs', restart())
    cp0, cs0 = tip_counts()
    dis_before = rule_slice(state_tx(dis23))
    s, r, res = release_results()
    check('23 archived: release check runs', s == 200, (s, r))
    t = state_tx(arch23)
    check('23 archived: the broadcast tx (>= 6 confs) is skipped, already broadcast',
          res.get(arch23, {}).get('action') == 'skipped' and 'already broadcast' in str(res.get(arch23, {}).get('reason', '')), res.get(arch23))
    check('23 archived: its slice is frozen (lastEvalAt and lastTipHeight untouched)',
          rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
    t = state_tx(stale23)
    check('23 stale: the stale tx is skipped',
          res.get(stale23, {}).get('action') == 'skipped' and 'stale' in str(res.get(stale23, {}).get('reason', '')), res.get(stale23))
    check('23 stale: its slice is frozen too',
          rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
    t = state_tx(dis23)
    check('23 disarmed: the disarmed staged tx IS still evaluated (slice refreshed, price read)',
          rule_slice(t).get('lastEvalAt') != dis_before.get('lastEvalAt')
          and rule_slice(t).get('lastPrice') == 98200, rule_slice(t))
    cp1, cs1 = tip_counts()
    check('23 archived: the release check made no tip fetch at all (both stubs quiet)',
          (cp1, cs1) == (cp0, cs0), ((cp0, cs0), (cp1, cs1)))
    # (b) A pending broadcast (< 6 confirmations) is refreshed hourly
    # but not evaluated; the >= 6 one is not re-queried.
    s, r = add_tx('Pend BH', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111303)
    check('23 pending: watching blockheight tx adds', s == 201, (s, r))
    pend23 = r['tx']['id'] if s == 201 else None
    stj = load_state_file()
    by_id = {t.get('id'): t for t in stj.get('bitcoin', {}).get('txs', [])}
    pend_tx = by_id.get(pend23)
    pend_tx['broadcasted'] = {'txid': pend_tx.get('txid'), 'broadcastedAt': FROZEN, 'method': 'mempool.space',
                              'confirmations': 0, 'blockHeight': None, 'found': True, 'checkedAt': FROZEN}
    pend_tx['release'] = {'status': 'broadcast', 'kind': 'release', 'trigger': 'blockheight',
                          'txid': pend_tx.get('txid'), 'method': 'mempool.space', 'broadcastedAt': FROZEN}
    pend_tx['triggerState'] = [dict(frozen_slice)]
    save_state_file(stj)
    s, r = req('GET', '/api/bitcoin/confirmations')
    check('23 pending: the confirmations endpoint runs', s == 200, (s, r))
    t = state_tx(pend23)
    check('23 pending: the < 6 tx IS re-queried (checkedAt moved, stub does not know it)',
          t.get('broadcasted', {}).get('checkedAt') != FROZEN
          and t.get('broadcasted', {}).get('found') is False, t.get('broadcasted'))
    t = state_tx(arch23)
    check('23 archived: the >= 6 tx is NOT re-queried (checkedAt still the old value, 7 confs kept)',
          t.get('broadcasted', {}).get('checkedAt') == FROZEN
          and t.get('broadcasted', {}).get('confirmations') == 7, t.get('broadcasted'))
    cp0, cs0 = tip_counts()
    s, r, res = release_results()
    t = state_tx(pend23)
    check('23 pending: its rules are not re-evaluated (slice frozen)',
          rule_slice(t).get('lastEvalAt') == FROZEN and rule_slice(t).get('lastTipHeight') == STUB_TIP, rule_slice(t))
    cp1, cs1 = tip_counts()
    check('23 pending: the release check made no tip fetch for it either',
          (cp1, cs1) == (cp0, cs0), ((cp0, cs0), (cp1, cs1)))
    # (c) Two block-height rules in one check cost one primary tip
    # fetch (the secondary points at a closed port, which also busts
    # the cache).
    s, r = add_tx('Tip BH 1', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111304)
    check('23 cache: first watching blockheight tx adds', s == 201, (s, r))
    tip1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('Tip BH 2', {'type': 'blockheight', 'params': {'targetHeight': 950000}}, 111305)
    check('23 cache: second watching blockheight tx adds', s == 201, (s, r))
    tip2 = r['tx']['id'] if s == 201 else None
    for tid in (tip1, tip2):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('23 cache: both tip txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': 'http://127.0.0.1:9'})
    check('23 cache: secondary pointed at a closed port (busts the tip cache)', s == 200, (s, r))
    cp0, cs0 = tip_counts()
    s, r, res = release_results()
    check('23 cache: release check runs', s == 200, (s, r))
    cp1, cs1 = tip_counts()
    check('23 cache: two blockheight rules cost ONE tip fetch, from the primary only',
          (cp1, cs1) == (cp0 + 1, cs0), ((cp0, cs0), (cp1, cs1)))
    for tid in (tip1, tip2):
        t = state_tx(tid)
        check('23 cache: the disarmed blockheight tx IS evaluated (slice refreshed, primary-only note)',
              rule_slice(t).get('lastTipHeight') == STUB_TIP
              and rule_slice(t).get('tipMode') == 'single'
              and rule_slice(t).get('tipNote') == 'primary only — secondary not needed', rule_slice(t))
    s, r = req('PUT', '/api/settings', {'secondaryApiUrl': STUB_BASE_S})
    check('23 cache: secondary restored to the stub', s == 200, (s, r))
    # (d) Primary down: the secondary alone decides.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': 'http://127.0.0.1:9'})
    check('23 down: primary pointed at a closed port', s == 200, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 950000}}})
    check('23 down: the secondary alone decides (watching on its 900,000 tip)',
          s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r, res = release_results()
    t = state_tx(tip1)
    check('23 down: the note names the fallback',
          rule_slice(t).get('tipMode') == 'single'
          and rule_slice(t).get('tipNote') == 'secondary only — primary unreachable', rule_slice(t))
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P})
    check('23 down: primary restored to the stub', s == 200, (s, r))
    # (e) Primary failing the tip read (500): the secondary
    # alone decides, same as down.
    s, r = req('POST', '/__test__/tip-fail', {'fail': True}, base=STUB_BASE_P)
    check('23 invalid: primary stub fails the tip read (500)', s == 200, (s, r))
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'blockheight', 'params': {'targetHeight': 950000}}})
    check('23 invalid: the secondary alone decides on a 500 primary',
          s == 200 and r.get('fire') is False and r.get('status') == 'watching', r)
    s, r, res = release_results()
    t = state_tx(tip1)
    check('23 invalid: the note names the fallback',
          rule_slice(t).get('tipMode') == 'single'
          and rule_slice(t).get('tipNote') == 'secondary only — primary unreachable', rule_slice(t))
    s, r = req('POST', '/__test__/tip-fail', {'fail': False}, base=STUB_BASE_P)
    check('23 invalid: primary stub tip reads again', s == 200, (s, r))
    # (f) Manual paths are unchanged: a single dry-run still
    # tests an archived tx when asked, and dry-run all runs.
    s, r = req('POST', '/api/broadcast/test', {'id': arch23})
    check('23 manual: a single dry-run still tests the archived tx when asked',
          s == 200 and any(x.get('id') == arch23 for x in r.get('results', [])), (s, r))
    s, r = req('POST', '/api/broadcast/test', {})
    check('23 manual: dry-run all still runs', s == 200, (s, r))
    # Cleanup: settings back to the stubs, cadence back to 60,
    # caches cold (restart) for the sections after this one.
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryApiUrl': STUB_BASE_S,
                                        'checkCadenceSeconds': 60})
    check('23 cleanup: settings and cadence restored', s == 200, (s, r))
    delete_all_txs()
    check('23 cleanup: caches cleared', clear_caches())

    # --- 25. UTXO shared outpoint cache + batching ---
    # (a) Repeated checks of one outpoint cost one request per
    # cadence. (b) Several watched outputs of one funding tx cost one
    # batch request. (c) A 404 is never cached. (d) A confirmed-spend
    # rule reuses the per-tick tip. Tick parked; the startup tick is
    # the evaluation each part measures.
    def tip_counts_25():
        _, rp = req('GET', '/__test__/tip-count', base=STUB_BASE_P)
        _, rs = req('GET', '/__test__/tip-count', base=STUB_BASE_S)
        return rp.get('count', -1), rs.get('count', -1)
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('25 setup: cadence parked at 3600 s', s == 200, (s, r))
    # (a) Two rules, one outpoint: one batch request, primary only.
    s, r = add_tx('UTXO 25a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111500)
    check('25 dedup: first same-outpoint tx adds', s == 201, (s, r))
    utxo_a1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('UTXO 25b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111501)
    check('25 dedup: second same-outpoint tx adds', s == 201, (s, r))
    utxo_a2 = r['tx']['id'] if s == 201 else None
    for tid in (utxo_a1, utxo_a2):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('25 dedup: both txs disarm (disarmed staged txs are still evaluated)', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    check('25 dedup: app restarted (cold caches, startup tick is the measured evaluation)', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('25 dedup: two rules on one outpoint cost ONE batch request, primary only, no singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    for tid in (utxo_a1, utxo_a2):
        t = state_tx(tid)
        check('25 dedup: the disarmed tx IS evaluated (slice watching, still unspent)',
              rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
    # A second evaluation inside the TTL window costs nothing —
    # the cache holds the answer.
    s, r, res = release_results()
    check('25 dedup: release check runs', s == 200, (s, r))
    p2, s2, bp2, bs2 = outspend_counts()
    check('25 dedup: re-evaluation inside the cache window costs ZERO outspend requests',
          (p2, s2, bp2, bs2) == (p1, s1, bp1, bs1), ((p1, s1, bp1, bs1), (p2, s2, bp2, bs2)))
    delete_all_txs()
    # (b) Two outputs, one funding tx: the startup tick costs
    # ONE batch request, primary only — and zero singular ones.
    s, r = add_tx('UTXO 25c', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111502, True)
    check('25 batch: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
    utxo_b1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('UTXO 25d', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111503)
    check('25 batch: second same-funding-tx tx adds', s == 201, (s, r))
    utxo_b2 = r['tx']['id'] if s == 201 else None
    for tid in (utxo_b1, utxo_b2):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('25 batch: both txs disarm', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    check('25 batch: app restarted', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('25 batch: two outputs of one funding tx cost ONE batch request, primary only, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    t = state_tx(utxo_b1)
    check('25 batch: the spent output reads due (11 confirmations)',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    t = state_tx(utxo_b2)
    check('25 batch: the unspent output reads watching',
          rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
    # The batch populated the per-output cache: a later singular
    # lookup of one of those outpoints costs nothing.
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}})
    check('25 batch: single-trigger check of a batched outpoint reads due', s == 200 and r.get('fire') is True and r.get('status') == 'due', r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('25 batch: the batched outpoint is served from the cache (zero new requests)',
          (p1, s1, bp1, bs1) == (p0, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    delete_all_txs()
    # (b2) One watched output of a funding tx: (0.8.10) the
    # batch first — one batch request, no singular.
    s, r = add_tx('UTXO 25e', {'type': 'utxo', 'params': {'outpoint': SECOND + ':0', 'confirmations': 1}}, 111504)
    check('25 single: lone-output tx adds', s == 201, (s, r))
    utxo_e = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + utxo_e, {'enabled': False})
    check('25 single: the tx disarms', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    check('25 single: app restarted', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('25 single: one watched output costs ONE batch request, primary only, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    t = state_tx(utxo_e)
    check('25 single: the lone output reads watching (SECOND:0 unspent)',
          rule_slice(t).get('status') == 'watching', rule_slice(t))
    delete_all_txs()
    # (c) A 404 is never cached: the parent goes unknown on both stubs
    # (before the restart that clears the cache), then known with a
    # spend, and the next evaluation must see the spend.
    s, r = add_tx('UTXO 25f', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111505)
    check('25 unknown: watching tx adds', s == 201, (s, r))
    utxo_f = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + utxo_f, {'enabled': False})
    check('25 unknown: the tx disarms', s == 200, (s, r))
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
    check('25 unknown: primary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
    check('25 unknown: secondary stub marks FINNEY unknown', s == 200 and FINNEY in r.get('unknownParents', []), r)
    check('25 unknown: caches cleared for a cold outpoint cache', clear_caches())
    s, r, res = release_results()
    check('25 unknown: release check runs', s == 200, (s, r))
    t = state_tx(utxo_f)
    check('25 unknown: the rule reads unknown while the parent is unknown to both nodes',
          rule_slice(t).get('status') == 'unknown', rule_slice(t))
    # The parent is known again, and the outpoint is now spent
    # (override: confirmed at 899999 = 2 confirmations).
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
    check('25 unknown: both stubs know FINNEY again', s == 200, (s, r))
    s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'blockHeight': 899999}, base=STUB_BASE_P)
    check('25 unknown: primary stub overrides FINNEY:1 as spent', s == 200, (s, r))
    s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'blockHeight': 899999}, base=STUB_BASE_S)
    check('25 unknown: secondary stub overrides FINNEY:1 as spent', s == 200, (s, r))
    s, r, res = release_results()
    check('25 unknown: release check runs again', s == 200, (s, r))
    t = state_tx(utxo_f)
    check('25 unknown: the spend is detected on the next evaluation (the 404 was not cached)',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    # The mirror case: a real observation stands for one TTL window
    # even if both nodes go unknown right after.
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY}, base=STUB_BASE_S)
    check('25 unknown: both stubs mark FINNEY unknown again', s == 200, (s, r))
    s, r, res = release_results()
    check('25 unknown: release check runs a third time', s == 200, (s, r))
    t = state_tx(utxo_f)
    check('25 unknown: the observed spend still reads due inside its TTL window',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    # Cleanup: the unknowns and the override go away, FINNEY:1
    # is unspent again.
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/unknown-parent', {'txid': FINNEY, 'clear': True}, base=STUB_BASE_S)
    check('25 unknown: unknowns cleared', s == 200, (s, r))
    s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'clear': True}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/outspend', {'txid': FINNEY, 'vout': 1, 'clear': True}, base=STUB_BASE_S)
    check('25 unknown: overrides cleared', s == 200, (s, r))
    delete_all_txs()
    # (d) A confirmed-spend rule with a warm tip cache costs no tip
    # fetch.
    s, r = add_tx('UTXO 25g', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111506, True)
    check('25 tip: confirmed-spend tx adds (trigger confirmed)', s == 201, (s, r))
    utxo_g = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + utxo_g, {'enabled': False})
    check('25 tip: the tx disarms', s == 200, (s, r))
    check('25 tip: app restarted (startup tick warms the tip cache)', restart())
    t0, s0 = tip_counts_25()
    s, r, res = release_results()
    check('25 tip: release check runs', s == 200, (s, r))
    t1, s1 = tip_counts_25()
    check('25 tip: re-evaluating a confirmed-spend rule costs ZERO tip fetches (shared cache)',
          (t1, s1) == (t0, s0), ((t0, s0), (t1, s1)))
    t = state_tx(utxo_g)
    check('25 tip: the rule still reads due (11 confirmations, from the cached tip)',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    # Cleanup: cadence back to 60.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('25 cleanup: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()
    # --- 26. batch cache consult + in-flight dedup ---
    # (a) A batch whose outputs are all cached costs nothing. (b) Two
    # simultaneous singular lookups cost one request. (c) Two
    # simultaneous batch lookups cost one (called directly on
    # lib/bitcoin/: the API never overlaps them). (d) A failed
    # request does not poison the in-flight map. Tick parked; stub
    # hooks cleared at the end.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('26 setup: cadence parked at 3600 s', s == 200, (s, r))
    # (a) Re-evaluating within the cache window costs nothing.
    s, r = add_tx('UTXO 26a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111600, True)
    check('26 batch-cache: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
    utxo_a1 = r['tx']['id'] if s == 201 else None
    s, r = add_tx('UTXO 26b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111601)
    check('26 batch-cache: second same-funding-tx tx adds', s == 201, (s, r))
    utxo_a2 = r['tx']['id'] if s == 201 else None
    for tid in (utxo_a1, utxo_a2):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('26 batch-cache: both txs disarm', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    check('26 batch-cache: app restarted (startup tick is the measured batch fetch)', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('26 batch-cache: startup tick costs ONE batch request, primary only, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    s, r, res = release_results()
    check('26 batch-cache: release check runs', s == 200, (s, r))
    p2, s2, bp2, bs2 = outspend_counts()
    check('26 batch-cache: re-evaluation inside the cache window costs ZERO batch AND zero singular requests',
          (p2, s2, bp2, bs2) == (p1, s1, bp1, bs1), ((p1, s1, bp1, bs1), (p2, s2, bp2, bs2)))
    t = state_tx(utxo_a1)
    check('26 batch-cache: the spent output still reads due from the cached batch',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    delete_all_txs()
    # (b) Two simultaneous lookups of one outpoint cost one request
    # (the stub delays 400 ms). Caches cleared first.
    check('26 inflight: caches cleared for a cold outpoint cache', clear_caches())
    s, r = req('POST', '/__test__/outspend-delay', {'ms': 400}, base=STUB_BASE_P)
    check('26 inflight: primary stub delays outspend answers 400 ms', s == 200 and r.get('delayMs') == 400, r)
    s, r = req('POST', '/__test__/outspend-delay', {'ms': 400}, base=STUB_BASE_S)
    check('26 inflight: secondary stub delays outspend answers 400 ms', s == 200 and r.get('delayMs') == 400, r)
    p0, s0, bp0, bs0 = outspend_counts()
    results_26 = []
    def _trigger_check_26():
        results_26.append(req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}}))
    threads_26 = [threading.Thread(target=_trigger_check_26) for _ in range(2)]
    for th in threads_26: th.start()
    for th in threads_26: th.join()
    check('26 inflight: both simultaneous trigger checks answer', len(results_26) == 2 and all(x[0] == 200 for x in results_26), results_26)
    check('26 inflight: both read the same answer (watching, unspent)',
          all(x[1].get('status') == 'watching' and x[1].get('fire') is False for x in results_26), results_26)
    p1, s1, bp1, bs1 = outspend_counts()
    check('26 inflight: two simultaneous lookups cost ONE batch request, primary only, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    s, r = req('POST', '/__test__/outspend-delay', {'ms': 0}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/outspend-delay', {'ms': 0}, base=STUB_BASE_S)
    check('26 inflight: stub delays cleared', s == 200, (s, r))
    # (b2) A finding is for the txid that was checked: a hex replaced
    # while a dry run is in flight is not marked stale by the old run.
    check('26 race: caches cleared', clear_caches())
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 113500), 'label': 'Race hex', 'trigger': {'type': 'manual', 'params': {}}})
    check('26 race: tx spending a spent input added (201)', s == 201, (s, r))
    race_id = r['tx']['id'] if s == 201 else None
    for b in (STUB_BASE_P, STUB_BASE_S):
        req('POST', '/__test__/outspend-delay', {'ms': 1500}, base=b)
    race_dry = []
    th = threading.Thread(target=lambda: race_dry.append(req('POST', '/api/broadcast/test', {'id': race_id})))
    th.start()
    time.sleep(0.5)
    new_hex = craft(1, 113500)
    s, r = req('PUT', '/api/bitcoin/txs/' + race_id, {'txHex': new_hex})
    check('26 race: hex replaced mid-check (200)', s == 200, (s, r))
    th.join()
    one = ((race_dry[0][1] if race_dry else {}).get('results') or [{}])[0]
    check('26 race: the dry run saw the old hex spent', len(one.get('spent', [])) == 1, one)
    t = state_tx(race_id)
    check('26 race: the new hex is not marked stale by the old run',
          t and t.get('txid') == txid_of(new_hex) and (t.get('release') or {}).get('status') != 'stale',
          t and (t.get('txid'), t.get('release')))
    for b in (STUB_BASE_P, STUB_BASE_S):
        req('POST', '/__test__/outspend-delay', {'ms': 0}, base=b)
    delete_all_txs()
    # (c) Two concurrent checkOutspends calls against the primary must
    # move the counter by exactly one.
    node_probe_26 = TMP + '/standby-test099-batch-inflight.js'
    with open(node_probe_26, 'w') as f:
        f.write("const bitcoin = require(" + json.dumps(APP + '/lib/bitcoin') + ");\n"
                "(async () => {\n"
                "  const eps = [{ label: 'primary', base: process.argv[2] }];\n"
                "  const [a, b] = await Promise.all([\n"
                "    bitcoin.checkOutspends(process.argv[3], eps, 60000),\n"
                "    bitcoin.checkOutspends(process.argv[3], eps, 60000),\n"
                "  ]);\n"
                "  console.log(JSON.stringify({ aUnknown: a.unknown, bUnknown: b.unknown,\n"
                "    aLen: Array.isArray(a.results) ? a.results.length : -1,\n"
                "    bLen: Array.isArray(b.results) ? b.results.length : -1 }));\n"
                "})().catch((e) => { console.error(e); process.exit(1); });\n")
    _, bp0_26 = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
    bp0_26 = bp0_26.get('count', -1)
    cp = subprocess.run(['node', node_probe_26, STUB_BASE_P, FINNEY], capture_output=True, text=True, timeout=30)
    check('26 batch-inflight: node probe runs', cp.returncode == 0, (cp.returncode, cp.stdout, cp.stderr))
    probe_26 = json.loads(cp.stdout) if cp.returncode == 0 and cp.stdout.strip() else {}
    check('26 batch-inflight: both concurrent batch lookups answer (2 outputs, not unknown)',
          probe_26.get('aUnknown') is False and probe_26.get('bUnknown') is False
          and probe_26.get('aLen') == 2 and probe_26.get('bLen') == 2, probe_26)
    _, bp1_26 = req('GET', '/__test__/outspends-count', base=STUB_BASE_P)
    bp1_26 = bp1_26.get('count', -1)
    check('26 batch-inflight: two simultaneous batch lookups cost ONE batch request',
          bp1_26 == bp0_26 + 1, (bp0_26, bp1_26))
    # (d) A failed request (both stubs 500) does not poison the in-
    # flight map: the retry fetches fresh.
    check('26 fail: caches cleared for a cold outpoint cache', clear_caches())
    s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_P)
    check('26 fail: primary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
    s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_S)
    check('26 fail: secondary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
    check('26 fail: trigger check runs while both stubs fail', s == 200, (s, r))
    check('26 fail: the rule reads unknown while both nodes fail', r.get('status') == 'unknown', r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('26 fail: the failed lookup tried both endpoints (one batch request each)',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_P)
    s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_S)
    check('26 fail: stub failures cleared', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}})
    check('26 fail: retry trigger check runs', s == 200, (s, r))
    check('26 fail: the retry reads the real answer (watching, unspent)',
          r.get('status') == 'watching' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('26 fail: the retry issues a FRESH request (the failure did not poison the map)',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # Cleanup: cadence back to 60.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('26 cleanup: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()
    # --- 37. generic outspend negotiation ---
    # Nodes differ in which outspend routes they serve. The client
    # tries the batch, falls back to the singular, and remembers per
    # node what worked (stub hook /__test__/outspend-mode). Tick
    # parked; modes restored to 'both' at the end.
    def set_outspend_mode(mode, base):
        s, r = req('POST', '/__test__/outspend-mode', {'mode': mode}, base=base)
        return s == 200 and r.get('mode') == mode
    def trig_utxo(outpoint, confs=1):
        return req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': outpoint, 'confirmations': confs}}})
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('37 setup: cadence parked at 3600 s', s == 200, (s, r))
    check('37 setup: caches cleared for a cold outpoint cache', clear_caches())
    # (a) Batch-only node (the self-hosted v3 shape): a lone
    # watched output is answered by the batch, zero singular.
    check('37 batch-only: primary stub serves batch only', set_outspend_mode('batch', STUB_BASE_P))
    check('37 batch-only: secondary stub serves both', set_outspend_mode('both', STUB_BASE_S))
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = trig_utxo(FINNEY + ':1')
    check('37 batch-only: trigger check runs', s == 200, (s, r))
    check('37 batch-only: the unspent outpoint reads watching (not due, no fire)',
          r.get('status') == 'watching' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 batch-only: ONE batch request, primary only, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # (b) Singular-only node: the second lookup goes singular-first
    # (the learned shape survives a cache clear; only a restart resets
    # it).
    check('37 singular-only: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
    check('37 singular-only: caches cleared for a cold outpoint cache', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = trig_utxo(FINNEY + ':1')
    check('37 singular-only: first trigger check runs', s == 200, (s, r))
    check('37 singular-only: the unspent outpoint reads watching',
          r.get('status') == 'watching' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 singular-only: first lookup costs ONE batch 404 + ONE singular request, primary only',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 1, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    check('37 singular-only: caches cleared again (shape record survives)', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = trig_utxo(FINNEY + ':1')
    check('37 singular-only: second trigger check runs', s == 200, (s, r))
    check('37 singular-only: the second lookup still reads watching',
          r.get('status') == 'watching' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 singular-only: second lookup goes singular-first — ONE singular request, ZERO batch',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # (c) Neither route on either node: unknown, never fires. The
    # primary (learned singular-only) tries singular first; the
    # secondary tries batch then singular.
    check('37 neither: primary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_P))
    check('37 neither: secondary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_S))
    check('37 neither: caches cleared for a cold outpoint cache', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = trig_utxo(FINNEY + ':1')
    check('37 neither: trigger check runs', s == 200, (s, r))
    check('37 neither: the unreadable outpoint reads unknown, never fires',
          r.get('status') == 'unknown' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 neither: primary one singular / zero batch, secondary one batch + one singular',
          (p1, s1, bp1, bs1) == (p0 + 1, s0 + 1, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # (d) The evaluation's batch path falls through to the singular
    # when both nodes are singular-only: FINNEY:0 due, FINNEY:1
    # watching.
    check('37 fallthrough: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
    check('37 fallthrough: secondary stub serves singular only', set_outspend_mode('singular', STUB_BASE_S))
    s, r = add_tx('UTXO 37a', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':0', 'confirmations': 1}}, 111700, True)
    check('37 fallthrough: first same-funding-tx tx adds (trigger confirmed)', s == 201, (s, r))
    utxo_37a = r['tx']['id'] if s == 201 else None
    s, r = add_tx('UTXO 37b', {'type': 'utxo', 'params': {'outpoint': FINNEY + ':1', 'confirmations': 1}}, 111701)
    check('37 fallthrough: second same-funding-tx tx adds', s == 201, (s, r))
    utxo_37b = r['tx']['id'] if s == 201 else None
    for tid in (utxo_37a, utxo_37b):
        s, r = req('PUT', '/api/bitcoin/txs/' + tid, {'enabled': False})
    check('37 fallthrough: both txs disarm', s == 200, (s, r))
    p0, s0, bp0, bs0 = outspend_counts()
    check('37 fallthrough: app restarted (cold shape record, startup tick is the measured evaluation)', restart())
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 fallthrough: the tick costs ONE batch 404 per node + TWO singular requests on the primary',
          (p1, s1, bp1, bs1) == (p0 + 2, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    t = state_tx(utxo_37a)
    check('37 fallthrough: the spent output reads due (11 confirmations)',
          rule_slice(t).get('status') == 'due', rule_slice(t))
    t = state_tx(utxo_37b)
    check('37 fallthrough: the unspent output reads watching',
          rule_slice(t).get('status') == 'watching' and rule_slice(t).get('reason') == 'still unspent', rule_slice(t))
    delete_all_txs()
    # (e) A batch 500 still throws (no singular fallback for server
    # errors); the healthy secondary answers.
    check('37 no-fallback-on-500: app restarted (cold shape record)', restart())
    check('37 no-fallback-on-500: primary stub serves batch only', set_outspend_mode('batch', STUB_BASE_P))
    check('37 no-fallback-on-500: secondary stub serves both', set_outspend_mode('both', STUB_BASE_S))
    s, r = req('POST', '/__test__/outspend-fail', {'fail': True}, base=STUB_BASE_P)
    check('37 no-fallback-on-500: primary stub fails outspend requests', s == 200 and r.get('fail') is True, r)
    check('37 no-fallback-on-500: caches cleared for a cold outpoint cache', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = trig_utxo(FINNEY + ':1')
    check('37 no-fallback-on-500: trigger check runs', s == 200, (s, r))
    check('37 no-fallback-on-500: the check still reads watching (secondary answers)',
          r.get('status') == 'watching' and r.get('fire') is False, r)
    p1, s1, bp1, bs1 = outspend_counts()
    check('37 no-fallback-on-500: the primary shows ONE batch 500 and ZERO singular (no fallback on a server error)',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    s, r = req('POST', '/__test__/outspend-fail', {'fail': False}, base=STUB_BASE_P)
    check('37 no-fallback-on-500: primary stub failure cleared', s == 200, (s, r))
    # Cleanup: both stubs serve both shapes again, cadence back
    # to 60.
    check('37 cleanup: primary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_P))
    check('37 cleanup: secondary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_S))
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('37 cleanup: cadence restored to 60 s', s == 200, (s, r))
    delete_all_txs()
    # --- 38. Output lookup node check ---
    # The probe asks about an output of Hal Finney's first transaction
    # (long spent) and reports the answer type. Tick parked; caches
    # cleared before each shape flip.
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 3600})
    check('38 setup: cadence parked at 3600 s', s == 200, (s, r))
    check('38 setup: caches cleared for a cold outpoint cache', clear_caches())
    # Baseline: the probe answers via the batch on both nodes; both
    # OK.
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    check('38 baseline: connection test returns 200', s == 200, (s, r))
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('38 baseline: primary output lookup reads Full answers and the node is OK',
          res.get('primary', {}).get('status') == 'ok'
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Full answers',
          res.get('primary', {}).get('checks', {}).get('outputLookup'))
    check('38 baseline: secondary output lookup reads Full answers too',
          res.get('secondary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Full answers',
          res.get('secondary', {}).get('checks', {}).get('outputLookup'))
    p1, s1, bp1, bs1 = outspend_counts()
    check('38 baseline: the probe costs ONE batch request per node, zero singular',
          (p1, s1, bp1, bs1) == (p0, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # The probe leaves nothing in the outspend cache: with the stubs
    # now saying FINNEY:0 has 1 confirmation, a 3-confirmation rule
    # must not fire right after a connection test.
    for _b in (STUB_BASE_P, STUB_BASE_S):
        req('POST', '/__test__/outspend', {'txid': v.FINNEY, 'vout': 0, 'blockHeight': STUB_TIP}, base=_b)
    s, r = req('POST', '/api/triggers/check', {'trigger': {'type': 'utxo', 'params': {'outpoint': v.FINNEY + ':0', 'confirmations': 3}}})
    check('38 baseline: a UTXO rule on the probed output reads the node, not the probe (1 of 3, no fire)',
          s == 200 and r.get('fire') is False, (s, r))
    for _b in (STUB_BASE_P, STUB_BASE_S):
        req('POST', '/__test__/outspend', {'txid': v.FINNEY, 'vout': 0, 'clear': True}, base=_b)
    check('38 baseline: caches cleared after the probe-cache check', clear_caches())
    # Singular-only node: still OK, singular named in the detail.
    check('38 singular-only: primary stub serves singular only', set_outspend_mode('singular', STUB_BASE_P))
    check('38 singular-only: caches cleared for a cold outpoint cache', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('38 singular-only: primary output lookup reads Full answers, singular in its detail and the node stays OK',
          res.get('primary', {}).get('status') == 'ok'
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is True
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Full answers'
          and '(singular)' in (res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('detail') or ''),
          res.get('primary', {}).get('checks', {}).get('outputLookup'))
    p1, s1, bp1, bs1 = outspend_counts()
    check('38 singular-only: the probe costs ONE batch 404 + ONE singular on the primary, ONE batch on the secondary',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0 + 1, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # The learned shape survives a cache clear: one singular, no
    # batch.
    check('38 singular-only: caches cleared again (shape record survives)', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('38 singular-only: the second probe still reads Full answers, singular in its detail',
          res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Full answers'
          and '(singular)' in (res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('detail') or ''),
          res.get('primary', {}).get('checks', {}).get('outputLookup'))
    p1, s1, bp1, bs1 = outspend_counts()
    check('38 singular-only: the second probe costs ONE singular, ZERO batch on the primary',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # Neither route on the primary: Unavailable, node CAUTION with a
    # plain tooltip; overall ok stays true.
    check('38 neither: primary stub serves neither shape', set_outspend_mode('neither', STUB_BASE_P))
    check('38 neither: caches cleared for a cold outpoint cache', clear_caches())
    p0, s0, bp0, bs0 = outspend_counts()
    s, r = req('POST', '/api/bitcoin/connection/test', {})
    res = {x.get('endpoint'): x for x in r.get('results', [])}
    check('38 neither: primary output lookup reads Unavailable and the node is CAUTION',
          res.get('primary', {}).get('status') == 'caution'
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('ok') is False
          and res.get('primary', {}).get('checks', {}).get('outputLookup', {}).get('value') == 'Unavailable — UTXO rules can\u2019t be evaluated',
          res.get('primary', {}).get('checks', {}).get('outputLookup'))
    check('38 neither: the CAUTION tooltip names the missing capability plainly',
          res.get('primary', {}).get('detail') == 'Height OK, but output lookup is unavailable — UTXO rules cannot be evaluated against this node.',
          res.get('primary', {}).get('detail'))
    check('38 neither: overall ok stays true with a CAUTION node', r.get('ok') is True, r.get('ok'))
    check('38 neither: secondary stays OK',
          res.get('secondary', {}).get('status') == 'ok', res.get('secondary'))
    p1, s1, bp1, bs1 = outspend_counts()
    check('38 neither: the probe costs ONE singular, ZERO batch on the primary (recorded singular-only, 404 returns at once)',
          (p1, s1, bp1, bs1) == (p0 + 1, s0, bp0, bs0 + 1), ((p0, s0, bp0, bs0), (p1, s1, bp1, bs1)))
    # Cleanup: both shapes again, cadence 60, restart (clears the
    # learned shape).
    check('38 cleanup: primary stub serves both shapes again', set_outspend_mode('both', STUB_BASE_P))
    s, r = req('PUT', '/api/settings', {'checkCadenceSeconds': 60})
    check('38 cleanup: cadence restored to 60 s', s == 200, (s, r))
    check('38 cleanup: app restarted (cold shape record)', restart())

    # --- 42. node test vs Test connection race ---
    # The tick's node test carries the last Output lookup forward; it
    # must not overwrite a newer Test connection result saved while it
    # was on the network.
    _rb = 'http://127.0.0.1:3440'
    shutil.rmtree(_bind_data, ignore_errors=True)
    shutil.rmtree(_bind_checkin, ignore_errors=True)
    _e = dict(APP_ENV)
    _e.update({'PORT': '3440', 'DATA_DIR': _bind_data, 'CHECKIN_DIR': _bind_checkin,
               'STANDBY_TEST_STARTUP_TICK_MS': '2000'})
    _e.pop('STANDBY_PASSWORD', None)
    _race_app = start(['node', 'server.js'], env=_e, cwd=APP, log=_bind_log)
    check('42 race: instance comes up', wait_up(_rb))
    s, r = req('PUT', '/api/settings', {'primaryApiUrl': STUB_BASE_P, 'secondaryEnabled': False}, base=_rb)
    check('42 race: primary node set to the stub, secondary off', s == 200, (s, r))
    req('POST', '/__test__/fee-delay', {'ms': 3000}, base=STUB_BASE_P)
    time.sleep(2.5)  # the startup tick (at 2 s) is now waiting on a slow fee answer
    req('POST', '/__test__/fee-delay', {'ms': 0}, base=STUB_BASE_P)
    s, r = req('POST', '/api/bitcoin/connection/test', {}, base=_rb, timeout=30)
    check('42 race: Test connection answers', s == 200, (s, r))

    def _lookup_value():
        s, st = req('GET', '/api/state', base=_rb)
        res = ((st.get('bitcoin') or {}).get('connection') or {}).get('results') or [{}]
        return ((res[0].get('checks') or {}).get('outputLookup') or {}).get('value')

    check('42 race: the Test connection result carries an Output lookup value', _lookup_value() == 'Full answers', _lookup_value())
    time.sleep(4)  # the tick finishes its node test and saves
    check('42 race: the tick that was on the network does not overwrite it', _lookup_value() == 'Full answers', _lookup_value())
    stop(_race_app)

    # --- 46. back online after a silence: every card re-checked once ---
    # The nodes last answered two days ago (seeded). The first answer after
    # the restart dry-runs every card: a disarmed tx whose input was spent
    # meanwhile reads stale, which no other check would record for it.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 115500), 'label': 'Offline 46', 'trigger': {'type': 'manual', 'params': {}}})
    check('46 offline: tx spending a spent input added (201)', s == 201, (s, r))
    t46 = r['tx']['id'] if s == 201 else None
    s, r = req('PUT', '/api/bitcoin/txs/' + t46, {'enabled': False})
    check('46 offline: disarmed (200)', s == 200, (s, r))
    check('46 offline: not stale yet', ((state_tx(t46) or {}).get('release') or {}).get('status') != 'stale')

    def seed46():
        stj = load_state_file()
        conn = stj['bitcoin'].setdefault('connection', {})
        conn['nodeCheckedAt'] = {'primary': iso_ago(days=2), 'secondary': iso_ago(days=2)}
        save_state_file(stj)
    check('46 offline: app restarted after two days without a node answer', restart(before_start=seed46))
    check('46 offline: the first node answer re-checks every card (the disarmed tx reads stale)',
          wait_until(lambda: ((state_tx(t46) or {}).get('release') or {}).get('status') == 'stale', deadline=20),
          (state_tx(t46) or {}).get('release'))
    check('46 offline: the log says so', 'back online after a silence' in read_log())
    # A short gap does not re-check: a restart with fresh stamps leaves a
    # new disarmed stale-input tx alone.
    s, r = req('POST', '/api/bitcoin/txs', {'txHex': craft(0, 115501), 'label': 'Online 46', 'trigger': {'type': 'manual', 'params': {}}})
    t46b = r['tx']['id'] if s == 201 else None
    req('PUT', '/api/bitcoin/txs/' + t46b, {'enabled': False})
    check('46 online: app restarted after a short gap', restart())
    time.sleep(3)
    check('46 online: no re-check after a short gap (still not stale)',
          ((state_tx(t46b) or {}).get('release') or {}).get('status') != 'stale', (state_tx(t46b) or {}).get('release'))
    delete_all_txs()

