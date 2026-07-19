# 🧹 Disk Reclaim (`mac-cleaner`)

A tiny **local** web app that scans the usual macOS temp / cache / junk locations,
tells you which ones belong to apps that are currently running, and lets you
**selectively** clean them from your browser — plus inspect and purge MySQL
schemas by size.

It runs entirely on `localhost`, has **zero dependencies** (Node.js built-ins
only — nothing to `npm install`), and never sends anything off your machine.

> **Why a local server and not just a web page?**
> A page in a browser sandbox cannot read your filesystem or delete files. So this
> is a small Node HTTP server that does the privileged work (`du`, moving files to
> Trash, talking to MySQL) and serves a browser UI to drive it.

---

## Highlights

- **Recoverable by default** — filesystem "cleaning" *moves items to `~/.Trash`*.
  It never hard-deletes; you reclaim the space by emptying the Trash afterwards.
- **Safe by design** — only the locations defined in `server.js` can ever be
  cleaned. Any other path sent to the clean endpoint is rejected server-side, and
  real app data (Application Support, Containers…) is shown read-only.
- **Running-app awareness** — cache/log items whose owning app looks like it's
  running are flagged, so you can quit the app first for a clean cache rebuild.
- **MySQL schema inspector** — see each database's real size and purge by name,
  with strong guardrails (see [Safety model](#safety-model)).

---

## Requirements

- macOS
- [Node.js](https://nodejs.org) 18 or newer (`node --version`)
- Optional: a local **MySQL** server + `mysql` client, only if you want the
  database panel. The app auto-detects the client at common locations
  (`/usr/local/mysql/bin/mysql`, Homebrew paths, `$PATH`).

---

## Run

```bash
cd ~/Documents/GIT/mac-cleaner
node server.js          # or: npm start
```

It listens on `http://localhost:4567` and tries to open your browser.
Pick a different port with:

```bash
PORT=8080 node server.js
```

Stop it with `Ctrl-C`.

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/jan1tha/mac-cleaner/main/install.sh | bash
```

Clones (if needed) and launches — no sudo, no dependencies, nothing deleted.

### Install with an AI agent 🤖

Hand your coding agent (Claude Code, Cursor, etc.) this repo's link and say:

> **"Install this on my Mac: https://github.com/jan1tha/mac-cleaner"**

The agent reads [`AGENTS.md`](./AGENTS.md), checks you have Node, starts the server,
and tells you the URL. It's instructed to **set up only** — it won't delete, move,
or drop anything itself; all cleaning stays in your hands via the UI.

---

## What it scans

The categories are **generic macOS user-domain locations**, not tied to any one
machine. All paths live under `~/Library`, `~/`, or `$TMPDIR`, which are stable
across macOS versions. **Any group that resolves to zero items on your Mac is
hidden**, so you only ever see the groups that actually apply (no Xcode → no Xcode
groups; no iOS backups → no backups group; etc.).

### Cleanable → moved to `~/.Trash` (recoverable)

| Group | Location | Risk |
|---|---|---|
| App updater leftovers | `~/Library/Caches/*.ShipIt` | safe |
| App caches | `~/Library/Caches/*` | safe |
| App logs | `~/Library/Logs/*` | safe |
| Saved application state | `~/Library/Saved Application State/*` | safe |
| Containers (sandboxed app data) | `~/Library/Containers/*` | review |
| Developer build caches | npm / Yarn / pnpm / Gradle / Maven / Cargo / Go / CocoaPods / pip caches + Xcode `DerivedData`, `CoreSimulator/Caches` | safe |
| Xcode device support & simulators | `iOS/watchOS/tvOS DeviceSupport`, `Archives`, `CoreSimulator/Devices` | review |
| iOS / iPadOS device backups | `~/Library/Application Support/MobileSync/Backup/*` | review |
| MySQL Workbench logs | `~/Library/Application Support/MySQL/Workbench/log/*` | safe |
| User temp | `$TMPDIR/*` | review |
| Downloads | `~/Downloads/*` | review |

`safe` = regenerated automatically. `review` = reclaimable, but check first
(Containers and backups are real app data — deleting resets the app / removes the backup).

### Read-only info (never cleanable)

`~/Library/Application Support/*` — real application data, shown only so you can
see where the big space goes.

### Databases (MySQL) — shown only if MySQL is installed

If a `mysql` client is present, a panel appears: connect → lists every schema with
its size (from `information_schema`) and table count → select and `DROP DATABASE`.
On Macs without MySQL, the panel is hidden entirely.

---

## Features in detail

**Whole-group select.** Tick the checkbox on a group header to queue every item in
it without expanding. Partial selections show an indeterminate state.

**Reclaim meter.** The hero shows total reclaimable space; a cyan meter fills as
you queue items, with a live "X GB queued" readout. Tick marks show group
boundaries.

**Running-app detection.** Built from `lsappinfo list` (running bundle IDs + app
names) and `ps` (process names) — no permission prompt. Matching is limited to
app-owned groups (caches, logs, updaters) where "is the app running?" is a
meaningful question. The Move-to-Trash confirmation warns if any queued item
belongs to a running app.

**MySQL inspect & purge.** Credentials are entered in the UI, used per-request, and
never stored. Sizes and table counts come straight from `information_schema`.

---

## Safety model

| Action | Reversible? | Guardrails |
|---|---|---|
| Clean files | ✅ moved to `~/.Trash` | Server recomputes an allow-list from the category definitions on every request; anything not on it is refused. |
| Drop MySQL schema | ❌ **permanent** | Requires live credentials; system schemas (`mysql`, `information_schema`, `performance_schema`, `sys`) are refused; each name is re-validated against the live schema list; UI requires a listing confirmation **and** typing `PURGE`; the API requires `confirm: true`. |

---

## Architecture

```
Browser (public/index.html)
   │  fetch()  ── /api/scan ─────────────► du -sk over category paths
   │           ── /api/clean ────────────► mv <path> ~/.Trash   (allow-list checked)
   │           ── /api/mysql/schemas ───► mysql → information_schema
   │           ── /api/mysql/drop ──────► mysql → DROP DATABASE  (validated)
   ▼
Node HTTP server (server.js, 127.0.0.1 only, built-ins only)
```

### API

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/scan` | — | Categories with per-item sizes + running flags, plus read-only info. |
| `POST /api/clean` | `{ paths: [...] }` | Per-path result; each path validated against the allow-list, then `mv`d to Trash. |
| `POST /api/mysql/schemas` | `{ host, port, user, password }` | `{ ok, schemas: [{ name, bytes, tables, system }] }`. |
| `POST /api/mysql/drop` | `{ …creds, databases: [...], confirm: true }` | Per-db result; system/unknown schemas refused. |

---

## Project layout

```
mac-cleaner/
├── server.js          # Node HTTP server: scan, clean, MySQL — built-ins only
├── public/
│   └── index.html     # Single-file UI (inline CSS + JS)
├── package.json
├── README.md
└── LICENSE
```

---

## Notes & caveats

- Close apps before clearing **User temp** — a running app may still be using files there.
- **Downloads** is your own data; pick items individually.
- The first scan can take a few seconds because `du` walks large folders.
- macOS may prompt for permission the first time the app reads certain folders.
- The server binds to `127.0.0.1` only; it is not reachable from other machines.

---

## License

[MIT](./LICENSE) © Janitha Senevirathna
