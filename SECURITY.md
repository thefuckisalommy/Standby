# Standby — security notes

Standby holds presigned Bitcoin transactions. Read this before arming one.

## Logging in

Standby has its own login (since 0.8.11.1), checked by the app itself on every API request.

- **On Umbrel** the password is the one shown on Standby's page in the Umbrel dashboard (Umbrel's per-install app password). Umbrel's own login still guards the way in through the dashboard — keep it on — but Umbrel's login is enforced by its proxy, and every Umbrel app shares one Docker network: without Standby's own login, any other installed app (or a bug in one) could reach Standby's API directly and read or broadcast your transactions.
- **On Linux (Docker or plain Node)** the login is optional: set `STANDBY_PASSWORD`. Without it, anything that can reach port 3100 controls the app. The Docker install maps the port to localhost only, so that means anything running on the machine itself; use a password if the machine has other users, and always before opening the port further. The app logs a warning at startup when it is reachable from the network with no password.

You log in once per browser. The session lasts 30 days, and Settings → Session → Log out signs out every browser at once. The session token is kept in the browser's storage for this one address (host and port), never in a cookie — a cookie on `umbrel.local` would be sent to every other app on `umbrel.local`. Ten wrong passwords in a minute lock the login for the rest of that minute. Scripts can send the password as `Authorization: Bearer <password>`.

## Requests from other sites are refused

State-changing API requests must come from the app's own page: if the browser sends an Origin, it must match the address the app was reached on, and the request must use a JSON content type. Every API request a browser marks as coming from another site — or from another port on the same host, such as another Umbrel app — is refused too (the `Sec-Fetch-Site` header). So a website you visit, or another app's page, cannot use your browser to read your transactions or trigger a check-in, a pause, or a broadcast. Requests by an unrecognised hostname are refused (421), which stops DNS-rebinding attacks; see the README for adding your own hostnames.

## Your signed transactions are stored unencrypted — and they are bearer

Standby stores your signed transactions unencrypted in the app's data directory on the device. A signed transaction is bearer: whoever holds the signed hex can broadcast it, with or without Standby. The data directory and every file in it are readable by the app's own user only (UID 1000 — the app no longer runs as root), so other users on the machine cannot read them — but root, anyone with Docker access, or a stolen drive can. Protect access to the device itself.

A signed hex also reveals the destination addresses and amounts.

## Broadcasts are real

The dry-run buttons only check whether the inputs are still unspent — they never broadcast. A release broadcasts for real, so keep the inputs unspent (spend one and the transaction goes stale and is never broadcast), use RBF so the heir can fee-bump, and remember a false-positive release moves real funds. If this device is down, nothing broadcasts.

A release re-checks every armed transaction's inputs first — a spent input means stale, never broadcast — and a broadcast has a 15-second deadline. Releases are evaluated on every check-cadence tick (about once a minute by default) and on demand.

## Disarming stops automatic release, not manual broadcasts

Disarming a transaction only stops it firing on its own — the release and Broadcast Armed both skip disarmed transactions. You can still broadcast a disarmed transaction by hand, from its own card.

## Check-in keys and the receiver (port 3101)

A check-in key can only record a check-in: it cannot read your transactions, broadcast anything, or change settings. Give each service its own key so you can revoke one without touching the others. The key is shown once, when it is created — copy it then.

The check-in connection is plain HTTP: the key travels unencrypted. On the generic Docker install the receiver runs on its own Docker network, with no route to the web API. Keep port 3101 on your trusted LAN and Tailscale network only — never port-forward it or expose it to the internet. A stolen key can only check in, but it can keep the switch from ever triggering, so revoke a key the moment you suspect it leaked.

The receiver holds no transaction data: it has two routes (`GET /health`, `POST /checkin`), mounts only the checkin directory, and cannot read, generate, or broadcast anything. It answers every bad key with the same generic 401, so a caller learns nothing about the setup. Each check-in records the caller's address, shown in the Recent check-ins log, so a check-in you didn't make is visible.

## Backups are not encrypted

A backup is a plain JSON file of everything needed to restore the setup: every signed transaction (hex included), your settings, and the check-in clock, plus the check-in and broadcast history and the check-in key hashes. It contains the signed hexes, which reveal the destination addresses and amounts, so treat it like the transactions themselves and keep it somewhere safe.

## What leaves the device

Your keys never leave your wallet — the app never sees them. The app queries your mempool nodes with your transaction IDs to check the inputs (mempool.space as primary, blockstream.info as fallback), and sends the full signed hex to a node only when it broadcasts. Nothing else leaves the device: no keys, no recipient, no messages.
