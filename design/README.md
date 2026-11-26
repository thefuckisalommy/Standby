# UI overhaul mock-ups (0.8.24)

Static mock-ups of the planned new look, with made-up data. Nothing here is
wired to the app; the app itself is unchanged on this branch.

## See them

- **Pictures:** open the PNGs in `renders/` (GitHub shows them directly).
- **In a browser:** download this branch (Code → Download ZIP, or
  `git checkout 0.8.24`), then open `design/overview.html`. The top menu and
  the Active / Pending tabs link between the pages. Make the window narrow
  (under 720 px) or use your browser's phone view to see the phone layout.

| File | What it shows |
|---|---|
| `overview.html` | Overview: check-in card with a bar per check-in transaction, the "Ready to broadcast" status card, armed transactions with their triggers and progress, recent activity. |
| `transactions.html` | Transactions, Active tab: the list (trigger-type colour pills, sets as groups, orange edge = armed, grey = disarmed) and the selected transaction in full (Armed / Sends / Fee / Route, rules, last dry run, inputs and outputs, notes, history). |
| `transactions-pending.html` | Transactions, Pending tab: a broadcast transaction waiting to confirm, with its confirmation steps. |
| `transactions-phone-list.html`, `transactions-phone-detail.html` | The phone's two screens for Transactions (open at phone width): the list, and a transaction's own screen. Tap the selected card to open it. |

## Trigger colours

Check-in blue, BTC price violet, coin (UTXO) spent cyan, block height
slate, set date rose. Fee risk appears only when it is medium (amber) or
high (red).
