#!/usr/bin/env bash
# Standby — image + compose smoke test.
#
# Builds the image, then runs both install paths for real:
#   1. Generic Docker (docker-compose.yml at the repo root):
#      - data directories not owned by UID 1000: the app refuses to
#        start and logs the fix;
#      - after the chown: both containers become healthy, run as UID
#        1000, the login is required, a check-in key works through the
#        receiver, the receiver cannot reach the web container, and
#        the data files are owner-only.
#   2. Umbrel (standby/docker-compose.yml + standby/hooks/pre-start),
#      simulated: an old root-owned layout with the check-in directory
#      outside data/, then the hook, then the compose (without Umbrel's
#      app_proxy placeholder). The hook must move the check-in files
#      and set ownership; the app must require its login and accept
#      the Tor address as a Host.
#
# Needs: docker with the compose plugin, curl, python3, and root or
# passwordless sudo (for the chown). Uses host ports 3100 and 3101.
# Run from anywhere:  bash test/smoke_compose.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$ROOT/standby/package.json")"
IMAGE="ghcr.io/thefuckisalommy/standby:${VERSION}"
WORK="$(mktemp -d)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
FAILS=0

pass() { echo "PASS - $*"; }
fail() { echo "FAIL - $*"; FAILS=$((FAILS + 1)); }
check() { local desc="$1"; shift; if "$@"; then pass "$desc"; else fail "$desc"; fi; }

# Wait up to $1 seconds for the command to succeed.
wait_for() {
  local secs="$1"; shift
  local i
  for ((i = 0; i < secs; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

cleanup() {
  (cd "$WORK/generic" 2>/dev/null && docker compose -p sbsmoke-generic down -v >/dev/null 2>&1) || true
  (cd "$WORK/umbrel/app-data/standby" 2>/dev/null && docker compose -p sbsmoke-umbrel down -v >/dev/null 2>&1) || true
  $SUDO rm -rf "$WORK"
}
trap cleanup EXIT

echo "== building $IMAGE"
docker build -q -t "$IMAGE" "$ROOT/standby" >/dev/null

# ---------------------------------------------------------------- generic
echo "== generic Docker install"
G="$WORK/generic"
mkdir -p "$G/data" "$G/checkin"
cp "$ROOT/docker-compose.yml" "$G/"
cd "$G"
# Not owned by UID 1000 (root's, or the CI runner's): must refuse to start.
$SUDO chown -R 0:0 data checkin
docker compose -p sbsmoke-generic up -d >/dev/null 2>&1
logs_have_fatal() { docker compose -p sbsmoke-generic logs web 2>&1 | grep -q 'FATAL: cannot write its files'; }
check "generic: unwritable data dirs -> the app refuses to start and says why" wait_for 30 logs_have_fatal
check "generic: the log names the chown fix" \
  bash -c "docker compose -p sbsmoke-generic logs web 2>&1 | grep -q 'chown -R 1000:1000 data checkin'"
docker compose -p sbsmoke-generic down >/dev/null 2>&1

$SUDO chown -R 1000:1000 data checkin
healthy() { [ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose -p sbsmoke-generic ps -q "$1")")" = healthy ]; }
B=http://127.0.0.1:3100
H='Content-Type: application/json'

# The README install: no .env. No password yet; the first-open setup asks
# for one (and so does Settings), stored in the app.
docker compose -p sbsmoke-generic up -d >/dev/null 2>&1
check "generic (no .env): web container becomes healthy" wait_for 90 healthy web
check "generic (no .env): no password yet, so setup will ask for one" \
  bash -c "curl -s $B/api/auth/status | grep -q '\"source\":\"none\"'"
check "generic (no .env): a fresh install starts in setup" \
  bash -c "curl -s $B/api/state | grep -q '\"setup\":{\"done\":false}'"
check "generic (no .env): a password can be chosen in the app" \
  bash -c "curl -s -X POST -H '$H' -d '{\"password\":\"chosen-in-the-app-1\"}' $B/api/auth/password | grep -q '\"required\":true'"
check "generic (no .env): it is kept in the data folder" bash -c "$SUDO test -f data/login.json"
docker compose -p sbsmoke-generic down >/dev/null 2>&1
$SUDO rm -f data/login.json

# A STANDBY_PASSWORD in .env (older installs, or managing it outside the
# app): it takes over.
printf 'STANDBY_PASSWORD=smoke-test-password-123\n' > .env
docker compose -p sbsmoke-generic up -d >/dev/null 2>&1
check "generic: web container becomes healthy" wait_for 90 healthy web
check "generic: check-in receiver becomes healthy" wait_for 90 healthy checkin
check "generic: a .env password reads as set outside the app" \
  bash -c "curl -s $B/api/auth/status | grep -q '\"source\":\"env\"'"
check "generic: web runs as UID 1000" \
  bash -c "[ \"\$(docker compose -p sbsmoke-generic exec -T web id -u)\" = 1000 ]"
check "generic: /api/state without a login is 401" \
  bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $B/api/state)\" = 401 ]"
TOKEN="$(curl -s -X POST -H "$H" -d '{"password":"smoke-test-password-123"}' $B/api/login \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token") or "")')"
check "generic: login returns a token" test -n "$TOKEN"
KEY="$(curl -s -X POST -H "$H" -H "X-Standby-Token: $TOKEN" -d '{"label":"smoke"}' $B/api/checkin-keys \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("plain") or "")')"
check "generic: a check-in key can be created" test -n "$KEY"
check "generic: a check-in through the receiver works" \
  bash -c "curl -s -X POST -H 'Authorization: Bearer $KEY' http://127.0.0.1:3101/checkin | grep -q '\"ok\":true'"
check "generic: a bad key is refused by the receiver" \
  bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer nope' http://127.0.0.1:3101/checkin)\" = 401 ]"
check "generic: the receiver cannot reach the web container" \
  bash -c "! docker compose -p sbsmoke-generic exec -T checkin wget -qO- -T 3 http://web:3100/api/health >/dev/null 2>&1"
check "generic: the data directory is 0700" bash -c "[ \"\$($SUDO stat -c %a data)\" = 700 ]"
check "generic: state.json is 0600" bash -c "[ \"\$($SUDO stat -c %a data/state.json)\" = 600 ]"
docker compose -p sbsmoke-generic down >/dev/null 2>&1

# ----------------------------------------------------------------- umbrel
echo "== Umbrel install (simulated upgrade from a root-owned layout)"
A="$WORK/umbrel/app-data/standby"
mkdir -p "$A/hooks" "$A/data" "$A/checkin"
cp "$ROOT/standby/docker-compose.yml" "$A/"
cp "$ROOT/standby/hooks/pre-start" "$A/hooks/"
# The old layout: root-owned state, check-in files outside data/.
echo '{"keys":[]}' > "$A/checkin/keys.json"
echo '{"lastCheckinAt":"2026-01-01T00:00:00.000Z"}' > "$A/checkin/last.json"
$SUDO chown -R 0:0 "$A/data" "$A/checkin"
# Umbrel injects app_proxy; outside Umbrel it has no image, so drop it.
python3 - "$A/docker-compose.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
i = s.index('  app_proxy:'); j = s.index('  web:')
open(p, 'w').write(s[:i] + s[j:])
PY
$SUDO env APP_DATA_DIR="$A" bash "$A/hooks/pre-start"
check "umbrel: the hook moved keys.json under data/checkin" test -f "$A/data/checkin/keys.json"
check "umbrel: the hook moved last.json under data/checkin" test -f "$A/data/checkin/last.json"
check "umbrel: the old check-in directory is gone" test ! -e "$A/checkin"
check "umbrel: data is owned by UID 1000" bash -c "[ \"\$(stat -c %u '$A/data')\" = 1000 ] && [ \"\$(stat -c %u '$A/data/checkin/keys.json')\" = 1000 ]"
$SUDO env APP_DATA_DIR="$A" bash "$A/hooks/pre-start"
check "umbrel: the hook is safe to run twice" test -f "$A/data/checkin/last.json"

cd "$A"
export APP_DATA_DIR="$A" APP_PASSWORD="umbrel-smoke-password-1" APP_DOMAIN="umbrel.local" APP_HIDDEN_SERVICE="smoketest.onion"
docker compose -p sbsmoke-umbrel up -d >/dev/null 2>&1
uhealthy() { [ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose -p sbsmoke-umbrel ps -q "$1")")" = healthy ]; }
check "umbrel: web container becomes healthy" wait_for 90 uhealthy web
check "umbrel: check-in receiver becomes healthy" wait_for 90 uhealthy checkin
check "umbrel: the API requires the login" \
  bash -c "docker compose -p sbsmoke-umbrel exec -T web wget -qO- http://127.0.0.1:3100/api/state 2>&1 | grep -q '401'"
check "umbrel: the Tor address passes the Host allowlist" \
  bash -c "docker compose -p sbsmoke-umbrel exec -T web wget -qO- --header 'Host: smoketest.onion' http://127.0.0.1:3100/api/health | grep -q '\"ok\":true'"
check "umbrel: the startup log says the login is required" \
  bash -c "docker compose -p sbsmoke-umbrel logs web 2>&1 | grep -q 'app login: required'"
docker compose -p sbsmoke-umbrel down >/dev/null 2>&1

echo
echo "FAILURES: $FAILS"
[ "$FAILS" -eq 0 ]
