# Standby

Presigned Bitcoin transactions, broadcast when a condition you set is met. You sign in your own wallet; Standby stores the signed transaction and broadcasts it when its trigger fires. It never sees your keys.

Runs on Umbrel (community app store) or any Linux machine with Docker (arm64 and amd64).

## Features

- **Store signed transactions**: paste raw hex, or import a hex file or a fully signed PSBT.
- **Triggers**, one per set of transactions:
  - **Check-in**: fires after N days without a check-in (35 by default). Check in from the app or with an API key.
  - **BTC price**: fires when the price crosses your value. Two sources must agree (within 5% by default); if one fails, the other decides.
  - **UTXO moved**: fires when an outpoint is spent, at 0 or N confirmations.
  - **Block height** and **Set date**: fire at a height or time.
  - **Fee market**: fires when the economy fee crosses your rate, up or down.
  - **Manual only**: never fires on its own.
- **Releases**: every tick (about once a minute), each armed set whose trigger fires is broadcast. Inputs are re-checked first; a transaction whose input was spent elsewhere is marked stale and never sent.
- **Grace after being offline**: after more than 7 days offline, every trigger pauses for 7 days (or until you resume), so nothing fires on conditions that changed while you were away. Can be turned off.
- **Clock check**: a due set-date or check-in trigger fires only once a node confirms this device's clock is within 10 minutes of its own time; otherwise it is held, with the reason on the card.
- **Vacation and disarm**: vacation freezes check-in countdowns; a disarmed set never fires on its own but can still be broadcast by hand.
- **Fee risk**: each transaction's fee rate compared with the 90-day peak of observed fees (Low, Medium, High, Critical). Informational only.
- **Dry run**: checks inputs and timelocks without broadcasting.
- **Two nodes**: a primary and an optional fallback. Each is a mempool API (mempool.space, Blockstream, your own mempool or Esplora) or Bitcoin Core over RPC.
- **Slipstream**: optionally broadcast through MARA's private mempool, with an opt-in public fallback after 1–90 days.
- **Backup and restore**: encrypted by default. A restore re-checks every transaction against your node.

## Install on Umbrel

App Store → Community App Stores → add `https://github.com/thefuckisalommy/Standby`, then install Standby. The login password is shown on Standby's page in the Umbrel dashboard.

On first open, a short setup walks through the app password (skippable, with a warning), the Bitcoin nodes, the price sources and how triggers work, then your first transaction. Every step can keep its default, and everything can be changed later in Settings (which can also run setup again).

## Run with Docker

```sh
mkdir standby && cd standby
curl -O https://raw.githubusercontent.com/thefuckisalommy/Standby/main/docker-compose.yml
mkdir -p data checkin && sudo chown -R 1000:1000 data checkin
docker compose up -d
# open http://localhost:3100 — setup asks you to choose a password
```

The containers run as UID 1000, so the data directories must belong to it; Standby refuses to start and says so if it cannot write. Upgrading from 0.8.10 or older (which ran as root): run the `chown` once before starting.

Two services from one image:

- `web`: UI and API on port 3100, bound to localhost by default.
- `checkin`: the check-in receiver on port 3101. It sees only the `checkin` directory and has no route to the web API.

Both run read-only, without Linux capabilities, with `no-new-privileges`.

**Reaching the UI from elsewhere:** use SSH (`ssh -L 3100:localhost:3100 <host>`), Tailscale, or a reverse proxy. A hostname other than an IP, `localhost` or `*.local` must be listed in `STANDBY_ALLOWED_HOSTS`, or requests get 421. To open the port to your LAN, set a password and change the port mapping in `docker-compose.yml` to `"${STANDBY_WEB_PORT:-3100}:3100"`.

**Updating:** change the image tag (or download the new compose file), then `docker compose pull && docker compose up -d`. Data lives in `./data` and `./checkin`.

**Without Docker** (Linux, macOS or Windows): Node 26+, `cd standby && node server.js` (localhost:3100, data in `./data`). The check-in receiver is `node checkin-receiver/server.js` (port 3101). On Windows, Ctrl+C or Ctrl+Break stops it cleanly. Only one copy runs per data folder; a second refuses to start. Forgot a password set in the app? Start it once with `node server.js --reset-password` (see [SECURITY.md](SECURITY.md#login)).

### Configuration

All optional; see `standby/lib/config.js`.

| Variable | Default | Meaning |
|---|---|---|
| `STANDBY_PASSWORD` | unset | The app login, for setups that manage it outside the app (Umbrel sets it from its app password; with Docker, a `STANDBY_PASSWORD=` line in `.env`). Unset, you choose a password in the app (setup, or Settings → App login). |
| `STANDBY_BIND` | `127.0.0.1` | Listen address. Docker sets `0.0.0.0` inside the container. |
| `STANDBY_ALLOWED_HOSTS` | unset | Extra hostnames, comma-separated. |
| `STANDBY_WEB_PORT`, `STANDBY_CHECKIN_PORT` | `3100`, `3101` | Host ports in `docker-compose.yml`. |
| `PORT`, `DATA_DIR`, `CHECKIN_DIR` | `3100`, `./data`, `./data/checkin` | Listen port and data locations (Docker and Umbrel set `/data` and `/checkin`). |
| `MEMPOOL_HOST`, `MEMPOOL_PORT`, `MEMPOOL_PROTOCOL` | unset | Override a mempool primary node. |
| `STANDBY_LOG_FILE` | unset | Also write the log to this file (rotates at 1 MB). Give the receiver its own file. |

## Check-ins

Create a key in the Check-in API keys card (shown once). Then:

```sh
curl -X POST http://<host>:3101/checkin -H "Authorization: Bearer <key>"
```

The receiver is plain HTTP: keep port 3101 on your LAN or Tailscale.

## Nodes

Settings → Bitcoin nodes holds a primary and an optional secondary, tried in that order. Each node is either:

- **A mempool API**: mempool.space and blockstream.info by default, or your own mempool or Esplora. The public services rate-limit; your own instance avoids that.
- **Bitcoin Core RPC**: turn on the node's RPC toggle and enter the RPC address (e.g. `http://umbrel.local:8332`), username and password. Use `txindex=1` on the node: without it, Standby cannot tell when an input was spent in a block, so it cannot mark that transaction stale or fire a UTXO rule. A restricted RPC user is recommended (see [SECURITY.md](SECURITY.md)).

**Test connection** checks each node's broadcast, fee estimates, block height and output lookup, and reads OK, CAUTION (works, with a limit it names, such as txindex off) or FAIL.

## Slipstream

Each transaction broadcasts through the public mempool (default) or Slipstream, MARA's private mempool. A Slipstream transaction stays private until MARA mines it; MARA is about 5% of hashrate, so it can take time, and Slipstream rejects fees below its minimum. It reads "Slipstream Pending" until public nodes see it. Optional **Public fallback**: if it is not public within 1–90 days, Standby broadcasts it publicly. A pending one can also be broadcast publicly by hand.

## Warning

Standby is a helper, not an inheritance plan. It runs on one device that can fail; the inputs can be spent first; a transaction may be invalid or underpaid and never confirm; and software has bugs. Have a plan that does not depend on it.

## More

- [SECURITY.md](SECURITY.md): read before arming a transaction.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
