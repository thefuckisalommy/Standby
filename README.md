# Standby

Community app store for [Standby](https://github.com/thefuckisalommy/Standby) — presigned Bitcoin transactions, ready when they're needed.

Standby is a transaction broadcasting tool: you sign Bitcoin transactions in your own wallet, store them in Standby, set the conditions in which they should broadcast, and Standby broadcasts them when the set's trigger fires.

> **Runs on Umbrel or on any Linux box with Docker.** The prebuilt image is built for arm64 and amd64 — see [Run on any Linux box (Docker)](#run-on-any-linux-box-docker).

## Features

- **Prepare in advance** — store presigned transactions: paste the raw signed hex, or import a hex file or a fully-signed PSBT (.psbt). The app never sees your keys.
- **Broadcast Triggers** — a trigger is the broadcast condition for every transaction it is bundled with
  - **Check-in** — fire after N days of silence (35 by default; each set has its own threshold and countdown). Check in from the app or an API key; it resets every check-in countdown.
  - **BTC price** — fire when the price crosses a value you set. Two sources you pick (CoinGecko and Coinbase by default, or Custom with a URL and JSON path). A reading counts only when they agree within 5% (default); if they disagree, the rule waits. If one feed fails, the other decides alone.
  - **UTXO moved** — fire when a named outpoint is spent, on any spend (0 confirmations) or at N confirmations.
  - **Block height** — fire when the chain reaches a height you set. Judged fresh every tick, so a reorg that moves the tip back below the height stops it being due.
  - **Set date** — fire at a date and time you set. A pure deadline: checking in does not snooze it.
  - **Fee market** — fire when the economy fee crosses a rate you set, up or down. The market rate alone, not the transaction's own fee. Read from the primary node first (secondary only if the primary fails), once per 5 minutes, shared across all fee transactions.
  - **Manual only** — never fires on its own.
- **Releases** — when a trigger condition is met, every armed transaction in its set is broadcast. Rules are evaluated together on every check-cadence tick (about once a minute by default, adjustable in Settings).
- **Grace after being offline** — if the app was offline longer than 7 days (by default), ALL triggers pause for a 7-day grace period (or until you resume): price, UTXO, block-height, set-date, fee-market, and check-in. A check-in rule is held by the same grace as everything else — its due date is not pushed out, and while the grace is active a past-due check-in reads as held, not due. The dashboard card shows whenever a grace is active, with a countdown bar, how many transactions are held, and how many of them would fire the moment it lifts. Turn it off with the toggle in the Settings grace card: off means no pause after an offline gap, and no outage protection for check-in either. A short check-in threshold can also start the grace sooner — if the device was offline for more than a quarter of that threshold and the check-in clock is more than half spent.
- **Vacation and disarm** — vacation freezes the check-in countdown (price and UTXO triggers keep firing); disarming a set stops its transactions firing on their own (manual broadcast still works). Disarmed sets are still evaluated every tick, so their statuses stay live.
- **Broadcast Fee Risk** — each transaction's fee rate vs the 90-day peak (the 90th percentile of the app's own hourly economy-fee observations over the last 90 days; the peak appears once a day of observations has accumulated): Low at 2× the peak, Medium at 1×, High below it, Critical below the current economy fee. Informational only — it never blocks a broadcast. The Low and Medium multipliers are adjustable in Settings.
- **Dry-run before you trust it** — checks whether the inputs are still unspent and whether an absolute locktime has passed. It never broadcasts. Our own transaction out there means broadcast; a confirmed spend by another transaction means stale (never broadcast); an unconfirmed spend means a warning, and the transaction stays active.
- **Two nodes** — a primary (mempool.space) with a secondary (blockstream.info) as fallback. The secondary can be turned off in Settings for primary-only use, with no fallback anywhere.
- **Slipstream broadcast route** — each transaction can go out via the public mempool or MARA Pool's private mempool (Slipstream). A Slipstream submission stays private until MARA mines it and reads “Slipstream Pending” until the public nodes see it. It can carry an opt-in Public Fallback (1, 3, 7, 14, 30, 60, or 90 days; Never by default): if MARA hasn't confirmed it in time, Standby broadcasts it publicly instead.
- **Pending Transactions** — the card above Archived for transactions out the door but unconfirmed: “Broadcast” for public, “Slipstream Pending” for MARA. Once confirmed, a tx moves to Archived. A pending tx's hex and route are locked (label and notes can still change), and a Slipstream-pending tx has a manual “Broadcast publicly” button.
- **Backup and restore** — export everything (including check-in keys), encrypted with a password you choose or unencrypted, and restore it on a fresh install. An encrypted backup can also be opened without Standby with `tools/decrypt-backup.js`.

## Setup

In Umbrel: App Store → Community App Stores → add this repo's URL:

```
https://github.com/thefuckisalommy/Standby
```

Then install Standby from the store. The app's Docker image is built for arm64 and amd64 by GitHub Actions — only after the test suites pass — and published to GHCR tagged with the app version, so installing just pulls it.

**Login:** Standby asks for a password the first time you open it in a browser. On Umbrel it is the password shown on Standby's page in the Umbrel dashboard. (Umbrel's own login guards the way in through the dashboard, but every Umbrel app shares one Docker network — Standby's own login keeps the other apps out of its API.)

After installing, add your first trigger set: sign a transaction in your own wallet, paste the raw signed hex (or import a hex file or a fully-signed PSBT), pick the set's trigger, and arm it. For a check-in set, set its own threshold ("Days of silence", 35 by default) when you add it. Then check in — from the app, or by creating a check-in API key for your gadget, shortcut, bot, or script.

## Run on any Linux box (Docker)

No Umbrel needed. Standby is a plain Docker image (`ghcr.io/thefuckisalommy/standby:<version>`, multi-arch amd64 and arm64) that runs anywhere Docker runs. It is two services from the same image: the web UI, and a check-in receiver that only records check-ins.

**Prerequisites:** Docker Engine and the Compose plugin. If you don't have them, follow the [Docker Engine install docs](https://docs.docker.com/engine/install/) for your distro, then confirm with `docker compose version`.

**Start it:**
```sh
mkdir standby && cd standby
curl -O https://raw.githubusercontent.com/thefuckisalommy/Standby/main/docker-compose.yml
mkdir -p data checkin && sudo chown -R 1000:1000 data checkin
# optional but recommended — require a password for the UI and API:
printf 'STANDBY_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env && chmod 600 .env && cat .env
docker compose up -d
# open http://localhost:3100
```
(The `chown` step matters: the services run as UID 1000, not root, and Docker creates the data directories root-owned if they do not exist. If Standby cannot write its files it refuses to start and prints this fix in `docker compose logs web`.)

**Upgrading from 0.8.10 or older:** those versions ran as root, so the files already in `data` and `checkin` are root-owned. Before starting the new version, run `sudo chown -R 1000:1000 data checkin` once (with `-R`: the files inside need it too), and download the new `docker-compose.yml`.

**What is running:**
- `web` — the Standby UI and API, on port 3100. It listens on localhost only (`127.0.0.1:3100`) by default.
- `checkin` — the check-in receiver, on port 3101. It runs the same image with `node checkin-receiver/server.js` and mounts only the shared `./checkin` directory, so it can record a check-in but cannot see or change your transactions. It is on its own Docker network, so it cannot reach the web API either.

Both containers run as UID 1000 with a read-only filesystem, no Linux capabilities, `no-new-privileges`, and log rotation (10 MB × 3).

**Ports:** override with `STANDBY_WEB_PORT` (default 3100) and `STANDBY_CHECKIN_PORT` (default 3101).

**Login:** set `STANDBY_PASSWORD` (in a `.env` file next to `docker-compose.yml`, as above, or in the shell) and the UI asks for it once per browser; scripts can send it as `Authorization: Bearer <password>`. Without it there is no login, and anything that can reach port 3100 controls the app — on this path that means anything running on the box itself, because the port is mapped to localhost only. Use a password if the box has other users, or if you open the port further. Settings → Session → Log out signs out every browser.

**Reaching the UI:** the web UI is localhost-only by default. Reach it on the box itself, over SSH (`ssh -L 3100:localhost:3100 <box>`), over Tailscale, or behind your own reverse proxy — a proxy serving it under its own hostname needs that hostname in STANDBY_ALLOWED_HOSTS, or the app answers 421. A Tailscale MagicDNS name (like `name.ts.net`) counts as its own hostname too, so it needs to be listed the same way; a plain Tailscale IP needs nothing. The same rule covers check-ins: a gadget or bot reaching the receiver at `http://<hostname>:3101` gets a 421 unless that hostname is listed in STANDBY_ALLOWED_HOSTS. On Umbrel the compose file already allows the device's `.local` name and the app's Tor address; a Tailscale MagicDNS name or a custom domain still needs a manual edit of the compose file. To open the UI to your LAN, set `STANDBY_PASSWORD` and change the web port line in `docker-compose.yml` to `"${STANDBY_WEB_PORT:-3100}:3100"` — only on a network you trust.

**Check-ins:** `curl -X POST http://<box>:3101/checkin -H "Authorization: Bearer <your key>"`. Plain HTTP, protected only by the key — keep it on your trusted LAN or Tailscale network, as in [SECURITY.md](SECURITY.md).

**Data:** `./data` (app state) and `./checkin` (receiver state) next to the compose file, as plain files — the app's files are readable by UID 1000 only. Back up by copying those two directories, or use the in-app Backup download; restore with the in-app Restore. **Updating:** the image is pinned to a version tag. Download the new `docker-compose.yml` (or change the tag in yours to the new version), then `docker compose pull && docker compose up -d` — your data is untouched. **Stopping:** `docker compose down` stops both services without deleting data — delete the directories yourself to wipe everything.

**Without Compose (plain `docker run`):**
```sh
mkdir -p data checkin && sudo chown -R 1000:1000 data checkin
docker network create standby-web && docker network create standby-checkin
docker run -d --name standby-web --restart on-failure --network standby-web -p 127.0.0.1:3100:3100 -v "$PWD/data:/data" -v "$PWD/checkin:/checkin" -e STANDBY_BIND=0.0.0.0 -e STANDBY_PASSWORD="<your password>" ghcr.io/thefuckisalommy/standby:0.8.12
docker run -d --name standby-checkin --restart on-failure --network standby-checkin -p 3101:3101 -v "$PWD/checkin:/checkin" -e PORT=3101 -e CHECKIN_DIR=/checkin -e STANDBY_BIND=0.0.0.0 ghcr.io/thefuckisalommy/standby:0.8.12 node checkin-receiver/server.js
# open http://localhost:3100
```
(`-e STANDBY_BIND=0.0.0.0` is required here: the app binds localhost by default, and a loopback bind inside a container never receives traffic forwarded to the container's IP. The image runs as UID 1000, hence the `chown`.)

**Build it yourself / run from source:**
```sh
git clone https://github.com/thefuckisalommy/Standby.git
docker build -t standby Standby/standby
mkdir -p data checkin && sudo chown -R 1000:1000 data checkin
docker run --rm -p 127.0.0.1:3100:3100 -v "$PWD/data:/data" -v "$PWD/checkin:/checkin" -e STANDBY_BIND=0.0.0.0 standby
# open http://localhost:3100
```

Or plain Node 24+ (no Docker): `cd Standby/standby && node server.js` — same port, localhost only, data in `./data` next to the server. Set `STANDBY_PASSWORD` before binding it to anything else with `STANDBY_BIND`.

**Configuration reference** (environment variables, all optional — see `standby/lib/config.js`):

| Variable | Default | Meaning |
|---|---|---|
| `STANDBY_PASSWORD` | unset (no login) | The app login. On Umbrel it is set from the password shown on the app page. |
| `STANDBY_BIND` | `127.0.0.1` | Address to listen on. Docker installs set `0.0.0.0` (inside the container). |
| `STANDBY_ALLOWED_HOSTS` | unset | Extra Host-header names, comma-separated (reverse-proxy hostname, MagicDNS name). IP literals, `localhost` and `*.local` are always allowed. |
| `STANDBY_DEPLOYMENT` | `bare` (`docker` in the image) | `umbrel`, `docker` or `bare` — tunes startup checks and messages. |
| `PORT`, `DATA_DIR`, `CHECKIN_DIR` | `3100`, `./data`, `/checkin` | Listen port and data locations. |
| `MEMPOOL_HOST` / `MEMPOOL_PORT` / `MEMPOOL_PROTOCOL` | unset | Override the primary node set in Settings (logged at startup). |

## Check-in API keys

The Check-in API keys card shows one address — the receiver URL, filled in from `window.location.hostname` (the host the page was opened on IS this Pi: LAN IP, `umbrel.local`, or Tailscale IP). That one address works for any connection, with the key as the password. The key is shown once, when it is created — copy it then. The endpoint is `POST <address>/checkin` with the key as an `Authorization: Bearer` token; the health check is `GET <address>/health`. The receiver answers `{"ok": true}` and gives every bad key the same generic 401. It holds no transaction data — two routes, checkin directory only — and cannot read, generate, or broadcast anything. The connection is plain HTTP, so the key travels unencrypted: keep port 3101 on your trusted LAN and Tailscale network only; see [SECURITY.md](SECURITY.md) for what a stolen key can do.

## Broadcast nodes

The app broadcasts via a primary node with a secondary as fallback (mempool.space, then blockstream.info). A release re-checks every armed transaction's inputs first — a confirmed spend by another transaction means stale, never broadcast; an unconfirmed spend warns; our own transaction out there means broadcast — and a broadcast has a 15-second deadline. Releases are evaluated on every check-cadence tick and on demand.

**Rate limits on public nodes.** The default nodes are public services and rate-limit heavy use from one IP: blockstream.info caps unauthenticated use at 700 requests per hour per IP, and mempool.space rate-limits past an unpublished threshold and can ban repeat excess. Standby keeps its volume down — primary first, secondary only when needed, the tip once per tick, the market fee once per 5 minutes, UTXO checks cached for one cadence and batched per funding transaction — but a faster cadence still means more requests, so keep the interval as slow as your triggers allow. Pointing the nodes at your own mempool instance in Settings avoids the public limits entirely.

**Test connection** (in the Bitcoin nodes settings card) checks each node for **Broadcast**, **Fee estimates**, **Block height**, and **Output lookup** — one row per node; tapping a row shows each check as a label–value line (Broadcast: "Reachable"; Block height: the tip, e.g. "Height 976,200"; Fee estimates: the economy fee, e.g. "1 sat/vB"; Output lookup: the discovered shape, e.g. "Batch"). On failure the value is the reason. Overall status is **OK** when all four are ready, **CAUTION** when block height answers but a capability is missing, and **FAIL** when the node is unreachable or not a mempool/Esplora API. The broadcast check posts an invalid hex, rejected without broadcasting anything; the fee check accepts mempool fee tiers, Esplora's fee-estimates endpoint (a plain Esplora has no mempool fee endpoint).

## Slipstream (MARA) broadcast route

Each transaction has its own broadcast route, chosen when you add it and changeable in the Edit popup while it is still Active: **Public mempool** (the default) or **Slipstream (MARA)**. Once it is out the door the route locks, like the hex — if it drops back to 'release-due' it becomes Active again and the route unlocks. Only the selected route is attempted; the hourly retry re-attempts the same route. The only automatic public broadcast is the opt-in fallback timer below.

Slipstream sends the signed transaction straight to MARA Pool's private mempool, bypassing the public mempool entirely. It stays private until MARA mines it — nobody else can see the transaction before it confirms. That is the point, and the limit: MARA is about 5% of hashrate, so a Slipstream-only transaction can wait, and admission is best-effort, with no guarantee of a block.

A Slipstream submission gets its own status, **“Slipstream Pending”** — it is not “Broadcasted” yet, because it is not visible in the public mempool. It lives in the Pending Transactions card, alongside public broadcasts waiting for their first confirmation (“Broadcast”). On the hourly tick (and on a manual release check): once the public nodes see it, it becomes Broadcasted (and moves to Archived once confirmed); if MARA drops it, it becomes Failed and is retried via Slipstream on the next hourly check. Neither pending kind is ever re-sent. A Slipstream-pending card also carries a manual **“Broadcast publicly”** button: it broadcasts that one transaction via the public mempool, right now, by hand only. The confirm names the cost — the transaction becomes visible to everyone, giving up the Slipstream privacy. On success it becomes public-pending; on failure the error is shown and it stays Slipstream-pending.

### Public fallback

A Slipstream transaction can carry an opt-in **Public Fallback**: a number of days (1, 3, 7, 14, 30, 60, or 90; **Never** by default). If the transaction is not publicly visible within that time, Standby broadcasts it publicly instead. The deadline runs from when MARA first accepted it; changing the duration while it waits re-times the deadline from that same acceptance (it does not restart the clock). A transaction whose Slipstream submit keeps failing falls back from its first attempt instead, so a fee-too-low rejection still goes public after the timer. The fallback is checked on the hourly tick and on a manual release check, after the MARA status refresh, and only for Slipstream-route transactions with a duration set. It never fires for a transaction that is already publicly visible (recognised as broadcast instead), already broadcast, stale, or disarmed — and a check-in does not cancel a due fallback.

Two things to know. First, the fee floor: Slipstream only accepts transactions at or above its minimum submission rate — currently the higher of 2x the mempool priority fee rate or 2 sat/vB. Standby does not pre-check the fee rate; it attempts the submission and surfaces Slipstream's rejection reason if the fee is too low. Second, verification still comes from your nodes: confirmations, input freshness, and the tip height all come from your nodes, because Slipstream has no outspend lookup and no transaction search — it only submits. A check-in cannot recall a transaction already in MARA's queue: if MARA mines it, the app recognises it as broadcast once the public nodes see it; if MARA drops it, the next release re-submits it.

## Warning

**What Standby is not.** Standby is a helper, not an inheritance plan, and it cannot promise your transactions will ever be broadcast. It holds no keys and cannot recover anything by itself — it can only broadcast transactions you already signed and stored. It runs on one device that can fail, lose power, or be destroyed; it depends on network access and on a reachable node. The inputs your transactions spend can be moved first, which makes a stored transaction invalid; a stored transaction may not even be valid under Bitcoin's consensus rules, which Standby does not fully check; and even a transaction that does get broadcast can carry too little fee to confirm, leaving it stuck in the mempool. And like any software, it can have bugs. Any of those can mean your heirs receive nothing from this app — the broadcast never goes out, or it goes out and never confirms. If you use Standby as part of planning for the unexpected, have a backup that does not depend on this app working.

## Security

Security notes live in [SECURITY.md](SECURITY.md) — read it before arming a transaction. The short version: Standby has its own login (on Umbrel, the password shown on the app page; on Linux, `STANDBY_PASSWORD`); your signed transactions are stored unencrypted and are bearer, so the data directory is readable by the app's user only; and the check-in receiver on port 3101 is plain HTTP, so keep it on your trusted LAN and Tailscale network only. On the generic Docker path the login is optional and the web UI listens on localhost only by default; see "Run on any Linux box" before exposing it.
