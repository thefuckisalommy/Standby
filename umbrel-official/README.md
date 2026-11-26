# Standby for the official Umbrel App Store

`standby/` at the top of this repository is the one Umbrel package for both
stores: this repository's community store installs it from there, and the
official store ([getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps))
gets a copy of the same folder. It follows the official store's rules:
fields in its order, `storage: dataRoot: data`, category `bitcoin`, port
3102 (3100 is taken there), the data folders committed
(`data/checkin/.gitkeep`) instead of a hook, and both images pinned to the
release's multi-arch digest.

The digest pin is automatic: `tools/bump-version.js` writes the new tag
alone, and once the image is built the image workflow runs
`tools/pin-image.js` and commits the pin to main. By hand:
`node tools/pin-image.js` (`--check` only reports).

This folder holds what goes with the pull request: `icon.png`, a plain
512 px square (Umbrel rounds it), made by `tools/make-icon.py` from
`assets/icon-source.png`.

## First submission

1. Fork `getumbrel/umbrel-apps` and copy this repository's `standby/` into
   it as `standby/` (once main has the digest pin for the release).
2. For a new app, Umbrel's guidance also asks for, in the fork's copy:
   `icon:` removed (they host it), `gallery: []` and `releaseNotes: ""`
   (they fill them). The linter accepts ours, so this is only if the
   reviewers ask; our copy keeps them because the community store shows
   them.
3. Run `npm run lint:apps -- standby --check-images` and `git diff --check`.
   Checked against the store as of 0.8.22: with a pull request URL in
   `submission` it reports 0 errors and two warnings, both answered below
   (each service sets `security_opt`). It also checks ports: if 3102 or
   3101 has been taken since, change them here, in `standby/`.
4. Test on an Umbrel (a plain `docker compose up` does not count): install
   from the fork, open Standby from the dashboard (port 3102), log in with
   the shown password, finish setup, add a transaction, check in from
   another device on port 3101; restart the app and check everything is
   kept.
5. Open the pull request with the icon and screenshots, and set
   `submission` to its URL (in `standby/` here too).

## Each release after that

Copy `standby/` into the fork again (after the pin commit) and open a pull
request. Before, test the update on an Umbrel: install the previous
version, then update and check everything is kept.

## Pull request notes

- **Upstream:** https://github.com/thefuckisalommy/Standby (MIT). Image:
  `ghcr.io/thefuckisalommy/standby`, built for amd64 and arm64 by the
  repository's GitHub Actions; public.
- **Port 3101 (check-in receiver):** a separate container from the same
  image that only records check-ins from a phone or script, which has no
  Umbrel login, so it cannot sit behind the app proxy. It needs a per-key
  API key, mounts only the check-in folder (never the transactions), and
  cannot read, broadcast or change anything.
- **Login:** Umbrel's proxy guards the page; Standby also requires
  `${APP_PASSWORD}` (shown on the app page, `deterministicPassword: true`),
  because every app shares one Docker network.
- **Hardening (`security_opt`):** both services set
  `no-new-privileges:true`, so nothing in the containers can gain
  privileges (for example through a setuid binary). They also run as
  UID 1000 with a read-only filesystem and all capabilities dropped; the
  only writable paths are the data mounts and a `/tmp` tmpfs.
- **Sensitive data:** the data folder (and so any Umbrel backup) holds
  fully signed transactions, which anyone holding them can broadcast; see
  SECURITY.md upstream.
