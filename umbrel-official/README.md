# Standby for the official Umbrel App Store

This folder is Standby packaged the way the official store
([getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps)) wants
it. It is not used by this repository's own community store (that is
`standby/`), and Umbrel does not read it from here.

- `standby/`: the app folder to copy into a fork of `getumbrel/umbrel-apps`.
  - `umbrel-app.yml`: the same app as `standby/umbrel-app.yml`, with the
    official store's fields: `storage: dataRoot: data` (the data can be
    moved to another drive), category `bitcoin`, no `icon` (Umbrel hosts
    it), `gallery: []` and `releaseNotes: ""` (Umbrel fills them),
    `submitter` and `submission`.
  - `docker-compose.yml`: the same as `standby/docker-compose.yml`, with
    both images pinned to the release's multi-arch digest.
  - `hooks/pre-start`: the same hook (moves the check-in folder under
    `data/`, gives the data to UID 1000).
- `icon.png`: the icon for the pull request, a plain 512 px square (Umbrel
  rounds it). Made by `tools/make-icon.py` from `assets/icon-source.png`.

## For each release

1. Copy `version` and `description` from `standby/umbrel-app.yml` into
   `standby/umbrel-app.yml` here, and the compose file over this one
   (keeping the header comment).
2. Pin both images to the new tag's digest (the image workflow prints it
   in its summary), the multi-arch index digest, not a per-architecture one:
   `docker buildx imagetools inspect ghcr.io/thefuckisalommy/standby:<version>`
3. In the fork: copy `standby/` over the store's `standby/`, then run
   `npm run lint:apps -- standby --check-images` and `git diff --check`.

## First submission

1. Fork `getumbrel/umbrel-apps`, add this `standby/` folder, run the linter
   (it also checks that port 3100 is not taken by another app; if it is,
   change `port` in `umbrel-app.yml` only, not the compose file).
2. Test on an Umbrel (a plain `docker compose up` does not count): install
   from the fork, open Standby from the dashboard, log in with the shown
   password, finish setup, add a transaction, check in from another device
   on port 3101; restart the app and check everything is kept; install the
   previous version, then update and check again.
3. Open the pull request with the icon, screenshots, and set `submission`
   to its URL.

### Pull request notes

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
- **Hardening:** runs as UID 1000, read-only filesystem, all capabilities
  dropped, `no-new-privileges`.
- **Sensitive data:** the data folder (and so any Umbrel backup) holds
  fully signed transactions, which anyone holding them can broadcast; see
  SECURITY.md upstream.
