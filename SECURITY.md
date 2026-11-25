# Security

Standby holds presigned Bitcoin transactions. Read this before arming one.

## Signed transactions are bearer

Whoever holds a signed transaction can broadcast it, with or without Standby, and it reveals destinations and amounts. Standby stores them unencrypted (it must read them unattended to broadcast), in a data directory readable only by the app's user (UID 1000). Root, anyone with Docker access, or a stolen drive can read them: protect the device.

Saves are written to a temporary file and swapped into place. On Linux the folder is also flushed to disk, so a power cut cannot lose the last save; Windows has no way to flush a folder, so there a power cut right after a save can lose that one save (the previous one stays intact).

## Login

Every API request is checked against the app's own login.

- **Umbrel:** the password shown on Standby's app page. Umbrel's login only guards its proxy, and all Umbrel apps share one Docker network, so Standby's own login keeps other apps out of its API.
- **Docker or Node:** set `STANDBY_PASSWORD`, or set a password in the app (first-open setup, or Settings → App login). Without one, anything that can reach port 3100 controls the app (by default only the machine itself, but every account and program on it). Standby warns at startup if it is reachable from the network without one.

A password set in the app is stored as a scrypt hash in `login.json` in the data folder; it cannot be read back. Changing or removing it needs the current one. **Forgot it:** nothing over the network can reset it. On the machine, start Standby with `--reset-password` (or stop it and delete `login.json`), then set a new one; transactions and settings are kept. This is safe because whoever can do that can already read the data folder. A `STANDBY_PASSWORD` is changed where it is set (on Umbrel it is Umbrel's app password, shown on Standby's page).

The password guards the app's controls (the web page and API); it does not encrypt the data folder. Anyone who can read that folder (your own account, an administrator, a stolen disk) can read the signed transactions: protect the machine with its own login and disk encryption (BitLocker, FileVault, LUKS).

**Start fresh** (Settings) deletes every transaction, set, log, API key, saved node login and automatic backup in the data folder, after asking for the password and a typed DELETE. The app login is kept.

Sessions last 30 days; Settings → App login → Log out everywhere ends them all. The token is kept in the browser's storage for this address, not in a cookie (a cookie on `umbrel.local` would reach every app there). Ten wrong passwords in a minute, counted together wherever they are sent (the login screen, a password change, Start fresh, or a script's `Authorization: Bearer` header), lock the login for that minute; a browser already logged in keeps working.

Standby does not encrypt its own connection. Over plain `http://` the password and session token can be captured on the network: use HTTPS, SSH or Tailscale where the network is not yours.

## Requests from other sites

A request a browser marks as coming from another site or another port (another Umbrel app) is refused. State-changing requests must also come from the app's own origin with a JSON content type. Unknown hostnames get 421, which blocks DNS rebinding.

## Broadcasts are real

Dry runs never broadcast; a release does. Before each release the inputs are re-checked and a transaction whose input was spent elsewhere is never sent. A false release moves real funds. Disarming stops automatic release only; a disarmed transaction can still be broadcast by hand. If the device is down, nothing broadcasts.

## Check-in keys

A key can only record a check-in: it cannot read transactions, broadcast or change settings. A stolen key can still keep check-in triggers from ever firing, so revoke it at once if you suspect a leak, and give each service its own key. Keys are stored only as hashes.

The receiver (port 3101) is plain HTTP and has two routes (`GET /health`, `POST /checkin`), access only to the check-in directory, and a generic 401 for every bad key. Keep it on your LAN or Tailscale; never expose it to the internet. Each check-in records the caller's address in the log.

## Bitcoin Core RPC

An RPC node's username and password are stored in the app's state (owner-only) and never logged. The app never shows the password again after you save it; the only thing that carries it is a backup, and an unencrypted backup carries it in plain text. Turning RPC off for a node deletes its login (older snapshots and backups keep theirs until deleted). Test connection reads **Unrestricted** when the login can make calls Standby never needs. RPC credentials control the whole node, and its wallets if any are loaded, so give Standby a restricted user. Generate one with Bitcoin Core's `share/rpcauth/rpcauth.py` and limit it in `bitcoin.conf`:

```
rpcauth=standby:<salt>$<hash>
rpcwhitelist=standby:getblockcount,getindexinfo,gettxout,gettxspendingprevout,getrawtransaction,getblockheader,estimatesmartfee,sendrawtransaction
```

RPC is plain HTTP unless you put TLS in front of it: keep it on your LAN or Tailscale.

## Backups

A backup contains every signed transaction, your settings (RPC login included), the check-in clock and key hashes, and recent logs.

- **Encrypted** (default): useless without the password, which Standby cannot recover. Encryption happens on the device.
- **Unencrypted:** treat the file like the transactions themselves.

`tools/decrypt-backup.js` decrypts a backup with only Node.js 18+:

```sh
node decrypt-backup.js standby-backup-2026-11-24.encrypted.json > backup.json
```

Format (version 1):

```json
{ "format": "standby-backup-encrypted", "version": 1,
  "kdf":    { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64>" },
  "cipher": { "name": "aes-256-gcm", "iv": "<base64, 12 bytes>" },
  "data":   "<base64: ciphertext followed by the 16-byte GCM tag>" }
```

The key is scrypt(password as UTF-8, salt, N, r, p), 32 bytes. The GCM additional data is the compact UTF-8 JSON array `[format, version, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt, cipher.name, cipher.iv]`. The plaintext is a gzipped `standby-backup` JSON document.

## What leaves the device

Standby asks your nodes about the transactions' inputs and txids, sends the signed hex to a node (or Slipstream) only to broadcast, and fetches BTC prices from the sources you choose. Nothing else leaves: no keys and no messages.
