# Roadmap

Planned work, roughly in order. Nothing here is promised; [CHANGELOG.md](CHANGELOG.md) records what shipped.

## Decided

- **Login on the desktop builds:** like every install without a password from Umbrel or `STANDBY_PASSWORD`, the first-open setup asks for one; it can be skipped, with a warning (0.8.19).
- **Licence:** MIT.

## Next

- **Standalone builds (0.9.0).** A Windows x64 `.exe` and single-file Linux x64 and arm64 programs (Node built in, no Docker). Launching one opens a console window and the Standby page in the browser. The data folder lives in the user's own folder. The check-in receiver ships as a second, optional program.

## Later

- **A desktop window.** First a tray icon (open, quit) in place of the console window, then a full app window.
- **Encrypting the data folder.** Today the app password guards the app's controls, not the files: anyone who can read the data folder can read the signed transactions, so the machine's own login and disk encryption protect it. Two options are on the table:
  - *Lock the data with the app password.* Strongest, but after every restart Standby is locked and triggers wait until someone unlocks it, so it no longer works unattended. A forgotten password means starting fresh from a backup.
  - *Encrypt with a key tied to the Windows account* (DPAPI). Triggers keep working whenever the account is signed in, and the files are useless if copied off the machine. It does not stop someone signed in as you, and it is Windows only.
