#!/usr/bin/env python3
"""Standby API suite. Each group (test/api/<group>.py) boots its own app
(port 3438), check-in receiver (3439) and two mempool stubs (primary 18235,
secondary 18236: tip 900000, economy fee 1 sat/vB, price 98200) on fresh
data, then runs its sections in order. Some sections start their own app and
stub instances on other ports. STANDBY_TEST_PROFILE=umbrel runs the Umbrel
bind and allowlist.

  python3 test/verify099.py                  every group, one after another
  python3 test/verify099.py --only nodes,rpc  the named groups
"""
import argparse
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import common  # noqa: E402
import helpers as v  # noqa: E402

GROUPS = ['triggers', 'restore', 'nodes', 'sets', 'persistence', 'fees', 'security', 'core']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='comma-separated groups: ' + ', '.join(GROUPS))
    args = ap.parse_args()
    selected = [g for g in args.only.split(',') if g] or GROUPS
    unknown = [g for g in selected if g not in GROUPS]
    if unknown:
        ap.error('unknown group(s): ' + ', '.join(unknown))
    for name in selected:
        print('\n=== group: %s ===' % name)
        group = importlib.import_module('api.' + name)
        try:
            common.boot()
            group.run()
        finally:
            common.shutdown()
    # --- 11. no server left running -------------------------------------
    for port in common.ALL_PORTS:
        v.check('11 no server left running on port %d' % port, common.port_closed(port))
    print()
    print('FAILURES: %d %s' % (len(v.failures), v.failures if v.failures else '(none)'))
    return 1 if v.failures else 0


if __name__ == '__main__':
    sys.exit(main())
