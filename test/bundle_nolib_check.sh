#!/usr/bin/env bash
# The bundles must run with the app's own files gone: copy the bundled app
# (test/make_bundled_app.sh), delete lib/, start the app and the receiver,
# and check each answers (the app also serves its page). Ports 3487/3486.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/standby-bundled}"
T="$(mktemp -d)"
trap 'kill "${APP:-}" "${RECV:-}" 2>/dev/null || true; rm -rf "$T"' EXIT
cp -r "$SRC" "$T/app"
rm -rf "$T/app/lib"
mkdir -p "$T/data"
(cd "$T/app" && DATA_DIR="$T/data" PORT=3487 exec node server.js > "$T/app.log" 2>&1) & APP=$!
(cd "$T/app" && CHECKIN_DIR="$T/data/checkin" PORT=3486 exec node checkin-receiver/server.js > "$T/recv.log" 2>&1) & RECV=$!
up() { for _ in $(seq 40); do curl -sf "$1" >/dev/null && return 0; sleep 0.25; done; return 1; }
fail=0
up http://127.0.0.1:3487/api/health || { echo 'FAIL - bundled app did not answer without lib/'; cat "$T/app.log"; fail=1; }
up http://127.0.0.1:3486/health || { echo 'FAIL - bundled receiver did not answer without lib/'; cat "$T/recv.log"; fail=1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3487/)" = 200 ] || { echo 'FAIL - bundled app did not serve its page'; fail=1; }
[ "$fail" = 0 ] && echo 'PASS - the bundled app and receiver run without lib/'
exit "$fail"
