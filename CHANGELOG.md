# Changelog

What changed in each Standby release, newest first. The newest few also appear in the Umbrel app store (`standby/umbrel-app.yml`); `node tools/bump-version.js <version>` adds a release to both. Releases before 0.8.1 are recorded in the git history.

Code comments describe how the app works now; the history of why it changed lives here and in git.

## 0.8.21

Desktop: start with the computer, a tray icon, and an update check. The Windows and Linux downloads now start by themselves when you sign in, so triggers keep being checked after a restart (on by default; setup shows it with a switch to turn it off, and so does Settings > This computer, which also has Stop Standby). On Windows, Standby no longer opens a console window: it runs in the background with an icon next to the clock (Open Standby, Quit Standby), and its log goes to standby.log in the data folder. Starting it again while it runs just opens the page. Check for new versions: once a day Standby asks GitHub whether a newer release exists and, if so, says so with a download link (on by default for the downloads, off for Docker and plain Node, not on Umbrel, which updates apps itself; nothing is sent but the request, and nothing is installed automatically). Settings no longer has "Run setup again"; Start fresh still runs setup. The Windows program now shows Standby's own icon and name (in File Explorer, the taskbar, the tray and Task Manager) instead of Node's, and the README says how to remove Standby cleanly.

## 0.8.20

Standalone downloads. Standby now also comes as a single program for Windows (x64) and Linux (x64 and arm64) with nothing else to install: no Docker and no Node. Double-click it (or run ./standby): a window shows it is running and the page opens in your browser at http://localhost:3100; closing the window stops it. Your data is kept in your own user folder (%APPDATA%\Standby on Windows, ~/.local/share/standby on Linux), and "Forgot password?" names that folder. Each release has SHA-256 checksums and GitHub build attestations; the Windows build is not code-signed yet. Check-ins from other devices: on the download and a plain Node run, switch on "Accept check-ins from other devices" in Settings > Check-in API keys and Standby opens port 3101 for check-ins only (each needs an API key; nothing else in Standby can be reached through it). Docker and Umbrel keep the separate check-in receiver. Behind the scenes: the app can be bundled into one script (tools/bundle.js), and the test suites also run against that bundle.

## 0.8.19

First-open setup and app password. A fresh install opens a short setup, one page per step: an app password (skippable, with a warning), the Bitcoin nodes and price sources (keep the defaults or choose your own), how each trigger works, and your first transaction (or skip). Without STANDBY_PASSWORD, a password can now be set, changed or removed in the app (Settings → App login); it is stored only as a hash, and a forgotten one is reset on the machine itself (start with --reset-password), never over the network. The login screen has "Forgot password?" instructions. Settings has Start fresh (delete all data and a password set in the app, with a typed confirmation and the password; setup then runs again) and Run setup again. Existing installs are not shown the setup. Docker installs no longer need a password in `.env`: setup asks you to choose one (a `STANDBY_PASSWORD` in `.env` still works, and the app then says exactly where it is). The dashboard's check-in card now appears only once a transaction has a check-in trigger. Also: a password sent by a script as a Bearer token now counts toward the ten-wrong-passwords-a-minute limit (it did not before), and Standby refuses to start on a login file that parses but cannot be used, instead of rejecting the right password later. Standby is now released under the MIT licence.

## 0.8.18

Maintenance release with no change to how the app works: a one-command version bump for releases (tools/bump-version.js), the tests read the version from package.json, code lint runs in CI, and these release notes keep only the latest few releases (the full history is in CHANGELOG.md).

## 0.8.17

Windows groundwork. Standby now runs on Windows under plain Node (no Docker), and every test suite runs on Windows in CI alongside Linux. Saving no longer depends on Linux-only steps: a file Windows briefly holds open (an antivirus scan, the check-in receiver reading it) is retried, and Windows' own folder permissions protect the data instead of Linux file modes. Ctrl+Break stops it cleanly on Windows, saving its last-online time. A run without Docker now keeps the check-in folder inside the data folder (data/checkin) instead of /checkin; Docker and Umbrel installs are unchanged. Also: only one copy of Standby can run on a data folder (a second copy refuses to start, and a copy that finds another has taken over stops before it evaluates or broadcasts, so two can never both broadcast); a port already in use is a clear message instead of a crash; and STANDBY_LOG_FILE also writes the log to a file. Clock check: a due set-date or check-in trigger now fires only once a node confirms this device's clock is within 10 minutes of its own time; while the clock is off, or no node has answered to check it, the trigger is held with the reason on the card. A wrong clock (a desktop just woken, a dead clock battery) can no longer fire one early. Grace: only being offline longer than the grace threshold (7 days by default) starts a grace, the same rule for every trigger type; a short check-in period no longer starts a week-long grace after a few hours offline.

## 0.8.16

Back online after a day: when Standby hears from a node again after more than 24 hours without an answer (the device was off or the network down), it re-checks every transaction once, the same as Dry-run all, so stale, already-broadcast and conflicting ones show correctly again. Nothing is broadcast, and this is separate from the grace period. Also in 0.8.16: every password box has an eye button to show or hide what you type; the shortened txids on the Release readiness card open the full txid, as on the transaction cards; and node and price lookups give up after 8 seconds instead of 15, so a hung node fails over to the secondary sooner (broadcasts still wait 15).

## 0.8.15

Maintenance release with no change to how the app works. The API test suite is split into eight groups that run in parallel, so each change is checked in about a third of the time. Also: the four tabs no longer wrap onto a second row on narrow phones with a wider system font.

## 0.8.14

Bitcoin Core RPC. Each node in Settings → Bitcoin nodes now has a Bitcoin Core RPC toggle: turn it on and enter the node's RPC address, username and password to use Bitcoin Core directly instead of a mempool API. The password is stored on the device and never shown again in the app; turning RPC off deletes the login. Test connection warns when the RPC login is unrestricted (it could spend from a wallet loaded on the node), and the unencrypted-backup dialog warns that the file holds the RPC password. Test connection checks whether the node has txindex turned on and, if not, says how to enable it — without txindex Standby cannot tell when an input was spent in a block. Fees for new transactions are worked out from the node even without txindex, and a node running -txospenderindex is read correctly (a confirmed spend names its spender and block). IPv6 node addresses (like http://[::1]:8332) now work, for mempool nodes too. Also in 0.8.14: the README and security notes are shorter and cover RPC setup, including a restricted RPC user.

## 0.8.13.1

Maintenance release. A restore no longer waits indefinitely on a node that accepts requests but never answers: its check of the restored transactions stops after 60 seconds, and any transaction it could not check is reported as unchecked (run Dry-run all once the node answers). Restoring now opens a pop-out with an animated Standby logo while it works, then shows what it found. Fix: a dry run or node check still in flight when a transaction's hex was replaced could record its result on the new transaction (for example, mark it stale); a result now applies only to the transaction it checked. Under the hood: the API is split into smaller modules by area, the dry run, the restore check and the hourly check of staged transactions now record their findings through one shared path, and the code comments are trimmed to what explains the code. Nothing else about how the app works changes.

## 0.8.13

Spends on a self-hosted mempool that runs directly on Bitcoin Core (no Esplora) are now read correctly. Such a node reports that an output is spent but not by whom or whether that spend is confirmed, so Standby used to treat every such spend as unconfirmed: a transaction whose input was spent for good never went stale, and kept warning and retrying. Standby now asks the same node whether the spend is confirmed (its /api/prevouts route), and asks about its own transaction to recognise its own spends. A confirmed foreign spend marks the transaction stale; a mempool-only spend still only warns. UTXO triggers waiting for confirmations now fire on such a node, counting confirmations from when Standby first sees the confirmed spend. Before updating, review your armed UTXO triggers: on such a node, any whose output is already spent with enough confirmations will fire right after the update — as it always should have. Nodes that report the spender (mempool.space, Blockstream, Esplora) work exactly as before. Also in 0.8.13: restoring a backup now checks every restored transaction against the node (the same check as Dry-run all; nothing is broadcast), so transactions that were already broadcast or went stale go back to Archived instead of all showing as Active. The restore message says what the check found, and how many could not be checked if the node did not answer. The Download backup dialog now uses the app's usual on/off switches: one for encryption (on by default) and one to generate a passphrase instead of typing one. Restoring from the “could not load its data” screen now keeps the restore summary on screen until you press Continue. The backup can no longer be fetched with a plain GET request; scripts use POST /api/backup, as the app does. Test connection's Output lookup row now says which kind of node it is talking to — Full answers, Bare + confirmation check (a mempool on Bitcoin Core with /api/prevouts), or Bare only (limited, shown in amber) — instead of Batch or Singular. It asks about an output of Hal Finney's first transaction instead of the genesis coinbase, which a mempool running directly on Bitcoin Core cannot look up.

## 0.8.12.1

Fix: pressing Test connection while the hourly node check was running could leave a node's Output lookup row blank — the hourly check finished second and saved its older result over the fresh one. It now keeps the newer result. Also in 0.8.12.1: Standby now runs on Node.js 26, the current long-term-support release (Node 24 is in maintenance), and the build pipeline's GitHub Actions are updated.

## 0.8.12

Encrypted backups. Download Backup now asks how to save it: encrypted with a password you choose (the default), or unencrypted after a warning. An encrypted backup is useless to anyone without the password, and Standby cannot recover a lost one, so write it down somewhere other than this device. Encryption happens on the device, so the unencrypted backup never crosses your network. Restoring an encrypted backup asks for its password. Older, unencrypted backups restore exactly as before. An encrypted backup can also be opened without Standby, using tools/decrypt-backup.js from the Standby repository. Also in 0.8.12: the check-in and broadcast logs are capped at their newest entries instead of growing forever; an unexpected server error no longer shows internal details in the browser (they go to the app log); a malformed request is now answered as a bad request rather than a server error; and both containers report their health to Docker and now run with a read-only filesystem and no extra privileges.

## 0.8.11.1

Security and packaging update. Standby now has its own login: on Umbrel it uses the password shown on this app's page (Umbrel's login only guards the proxy, and every Umbrel app shares one Docker network, so another app could otherwise reach Standby's API directly). Log in once per browser; Settings → Session logs every browser out. The app and check-in receiver now run as an unprivileged user instead of root, and the app data is owner-only on disk — on the first start after this update Standby fixes the ownership of its data and moves the check-in folder under data/, so check-in keys keep working with nothing to do. Opening Standby over Tor now works without editing a file. Requests from another site, or from another app on the same Umbrel, are refused. The app now refuses to start, with a clear message, if it cannot save its files, instead of failing one save at a time. The Docker image is now tagged with the app version and built only after the test suites pass.

## 0.8.11

Secure by default: the app and the check-in receiver now listen on localhost (127.0.0.1) unless STANDBY_BIND says otherwise — a bare `node server.js` run is no longer exposed to the LAN by accident. Both Docker installs set STANDBY_BIND=0.0.0.0 in their compose file (a loopback bind inside a container would never receive forwarded traffic); the generic install stays localhost-only through its host-side port mapping, and the Umbrel install stays behind the app proxy. The machine's own hostname no longer passes the Host allowlist on its own — reach the app by a hostname and list it in STANDBY_ALLOWED_HOSTS instead (on Umbrel the compose file already sets it to the app domain). A startup warning is logged when the app is bound to a non-loopback address with no extra Hosts configured. The generic Docker install now also runs as user 1000 instead of root — chown ./data and ./checkin to UID 1000 before the first start (see the README).

## 0.8.10

Security and durability fixes: a malformed request URL no longer crashes the app or the check-in receiver (bad URLs now get a 400 and the process keeps serving); the app now sends security headers (content-security-policy, X-Frame-Options, X-Content-Type-Options) on every response; and the load-failure notice no longer builds HTML from an error message. Requests whose Host header is not an IP literal, localhost, a *.local name, or a name in STANDBY_ALLOWED_HOSTS are now rejected with a 421, so a DNS-rebinding page cannot reach the app or the receiver; the X-Forwarded-Host header is no longer trusted. State, check-in timestamps, and check-in keys are now written with an fsync before the rename, so the latest save survives a power cut instead of only the previous one. The app also stops rewriting state.json every minute: quiet ticks write nothing (the "I was online" stamp lives in a tiny heartbeat file instead, and a save happens only when something actually changed), and a shutdown flushes the heartbeat. Also in 0.8.10: a heartbeat written while the clock was wrong can no longer suppress the offline grace (a future-dated stamp is ignored and the merged stamp is capped a few minutes ahead); hostnames with a trailing dot (localhost.) are accepted; and the check-in and broadcast logs are now written durably with an fsync, like state itself. Also in 0.8.10 (audit follow-ups): an uncaught exception now terminates the process (it is logged, then Docker restarts it) instead of serving through a possibly corrupted state.

## 0.8.8

The secondary node can now be turned off in Settings — off means the primary node only, with no fallback anywhere. The offline grace period now also pauses block-height, set-date, and fee-market triggers — not just price and UTXO — and it now has its own on/off toggle in Settings: off means triggers fire immediately, with no pause after an offline gap. The check-in hold is now unified into the same grace: a check-in rule pauses like any other during the grace, its due date is not pushed out, and the grace card shows whenever a grace is active, with a countdown bar, the number of transactions held, and how many of them would fire the moment it lifts. A short check-in threshold can also start the grace sooner (offline more than a quarter of the threshold, with the clock more than half spent).

## 0.8.7.4

A staged transaction whose inputs were spent elsewhere now reads stale on its own: the hourly check re-tests every armed staged transaction's inputs, so one that can no longer broadcast is marked stale — in red — instead of sitting at Ready until a dry run or a firing trigger finds out. An unconfirmed spend still only warns; it never marks a transaction stale.

## 0.8.7.3

The server is now split into modules: the single large server file is divided into focused files — one each for configuration, trigger rules, release evaluation, the API, check-ins, and the rest — with a small entry point that starts them. Nothing about how the app works changes: same routes, same settings, same state file. It is a code-organisation change so each piece is easier to work on separately.

## 0.8.7.2

The confirmation count on an old broadcast no longer freezes: once a transaction is 6 confirmations deep, the card derives the count from its confirming block height plus the current tip instead of repeating the last stored snapshot — so a transaction broadcast days ago keeps counting up with no extra requests to the node. Below 6 confirmations nothing changes: the node is still asked every hour until the transaction is 6 deep, because a single sighting is not trusted.

## 0.8.7.1

A broadcast the network no longer knows is now called what it is: if the transaction's input was spent by another confirmed transaction, the card reads stale — in red — instead of "may have been dropped from the mempool" in green. The broadcast line's colour follows the verdict now (confirmed green, unconfirmed amber, not found or stale red). Also, the 390px width check in the test suite tolerates sub-pixel rounding between Chromium builds instead of failing on it.

## 0.8.7

Shared trigger sets: one set of triggers can now drive several transactions. Define the triggers once, attach the transactions, and when the set fires every attached transaction broadcasts. One label and one arm/disarm per set; the set's triggers are evaluated once per tick for all its members, not once per transaction. A member whose inputs are spent is skipped — it carries a 'stale' pill on its subcard — and the set keeps firing for its non-stale members; only when every member is stale does the whole set move to archive. Deleting a set returns its transactions to standalone; the transactions themselves are never deleted with it.

## 0.8.6

UTXO triggers share their work now: repeated checks of the same outpoint cost one request per check cadence, and when several watched outputs belong to one funding transaction they are answered with a single request instead of one per output. A confirmed-spend UTXO rule also reuses the shared per-tick block-height fetch instead of fetching the tip itself. An outpoint no node can say about is still unknown, never unspent. Fold-in: a batch lookup whose watched outputs are already cached costs no request at all, and two overlapping checks of the same outpoint — or the same funding transaction's batch — share one in-flight request instead of issuing two. A failed request never poisons the cache: the next lookup fetches fresh. The check-interval help now warns that a very fast cadence can get this IP rate-limited by a public node.

## 0.8.5

Live view: pills, prices, fees and block height update on their own now — the page refreshes at the check cadence, and the check-in countdown ticks every second without a fetch. Typing and popups are never interrupted: values update in place, and a new or moved transaction waits until no popup is open. Each node and exchange row carries its own last-checked time. Archived transactions no longer cause any network activity — a broadcast transaction is only re-checked until it reaches 6 confirmations — and the block-height tip is fetched once per tick from the primary node, so the node traffic no longer grows with the number of transactions. The fee trigger now fetches the market fee once per 5 minutes, shared across all fee transactions.

## 0.8.4

Fee rule pill stays live — reads the last known fee like price does. Trigger statuses stay live for disarmed transactions — evaluated for display, never broadcast unless armed. Block-height trigger no longer latches — judged fresh each tick like every other rule.

## 0.8.3

Persistence hardening: rotating state backups, recovery from a corrupt state file, and check-in key verification on startup.

- **Rotating state backups:** every save keeps the previous version as state.json.bak, the first save of each day snapshots the state (kept 7 days), and a snapshot is taken before any migration changes the state shape. A slow wipe — like the check-in keys that vanished in November — stays recoverable from yesterday's snapshot even though every save since is keyless.
- **Corrupt-state recovery:** a state file that cannot be read no longer crashes the app on startup — it recovers from the newest usable backup, preserves the corrupt file for inspection, and says so in the log. If no backup loads, it fails loudly instead of silently resetting to an empty state.
- **Check-in key verification on startup:** the app now compares its check-in keys with the receiver's key list when it starts, rewrites the receiver's list when state has keys the receiver is missing, and warns (without overwriting anything) when state has no keys but the receiver — or a backup — still does.

## 0.8.2

Multiple triggers per transaction.

- **Rule sets:** each transaction can now carry several triggers at once, combined with AND or OR. OR fires when any rule fires; AND fires only when every rule holds at the same moment. The Add and Edit forms let you add, remove, and reorder rules, and pick AND or OR for the set.

## 0.8.1

Three more triggers join the broadcast engine.

- **Block height:** fire when the chain reaches a block height you set. Deterministic — the height comes from your node's own chain.
- **Set date:** fire at a date and time you set, whether or not you check in. A pure deadline — checking in does not snooze it.
- **Fee market:** fire when the economy fee crosses a rate you set (sat/vB) — falls to or below it, or rises to or above it.
- **Custom price source:** pick Custom for either price source and point Standby at your own endpoint — a URL plus the JSON path to the price (for example, `data.amount`).

Block-height, set-date, and fee-market rules are evaluated about once a minute, alongside price and UTXO rules; check-in rules stay hourly. A rule whose condition is already met when you add or edit it is blocked unless you confirm it — so a height already reached, a date already passed, or a fee already past your threshold does not fire the moment you save it. The grace period and vacation freeze still apply only to price and UTXO triggers (grace) and check-in triggers (vacation) — the new triggers are not held by either.

Also in 0.8.1:

- **Node capability test:** Test connection now reports each node's Broadcast, Fee estimates, and Block height readiness, with the measured value beside it — and each node is one row, with the checks in a drop-down.
- **Per-transaction history:** each transaction card now has a History section, nested inside Details — a timeline of what happened to it, oldest first: added, trigger fired, broadcast sent, confirmed, went stale, edits, and arm/disarm changes. Older transactions get their history filled in from what Standby already knows (a broadcast that confirmed shows added, broadcast, confirmed).
- **Primary first:** prices, fees, and block height all come from the primary source or node; the secondary is only a fallback if the primary is down.
- **Readiness card:** transactions read as separate tiles, node and exchange status sit in their own sub-card, and the price sits next to each source's status.
