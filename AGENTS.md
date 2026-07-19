# AGENTS.md — setup guide for AI agents

If a human gave you this repository's link and said something like
**"install this on my Mac"**, "set this up", or "get this running" — this file is
for you. Follow it exactly, then hand control back to the human.

## What this is

**Disk Reclaim** (`mac-cleaner`) — a local, dependency-free Node.js web app that
scans macOS cache/temp/junk locations and lets the human clean them **from a
browser UI**. It also inspects/purges MySQL schemas. It binds to `127.0.0.1` only.

## Prerequisites

- **macOS**.
- **Node.js ≥ 18** — check with `node --version`.
  - If missing: `brew install node` (if Homebrew is present) or point the human to
    <https://nodejs.org>. Don't install Node without the human's OK.
- **No npm dependencies.** This project uses Node built-ins only.
  **Do NOT run `npm install`** — there is nothing to install.

## Install & run

1. **Get the code** into a sensible location (skip if it's already cloned locally):
   ```bash
   git clone https://github.com/jan1tha/mac-cleaner.git ~/Documents/GIT/mac-cleaner
   cd ~/Documents/GIT/mac-cleaner
   ```
2. **Start the server** (it auto-opens the browser):
   ```bash
   node server.js
   ```
   - Default URL: <http://localhost:4567>.
   - If port 4567 is busy, start with a different port and tell the human the URL:
     ```bash
     PORT=8080 node server.js
     ```
   - To keep it running in the background, launch it detached and report the URL.
3. **Verify** it's up:
   ```bash
   curl -s http://localhost:4567/api/scan -o /dev/null -w "%{http_code}\n"   # expect 200
   ```
4. **Tell the human**: "It's running at http://localhost:4567 — select what to clean
   in the browser; cleaned items go to the Trash (recoverable)."

## Guardrails — important

You are here to **set it up, not to clean anything**. The human drives all
destructive actions from the UI. Specifically:

- **Do NOT** call the `/api/clean` or `/api/mysql/drop` endpoints yourself, and do
  not delete, move, or `DROP` anything on the human's behalf.
- **Do NOT** ask for or hardcode MySQL credentials. The database panel takes them
  in the browser, per-session only.
- Moving files to Trash is recoverable; MySQL `DROP DATABASE` is **permanent** —
  leave both to the human via the UI.
- Don't run the app with `sudo`. It doesn't need elevated privileges.

## One-liner (optional)

The human can also run the bundled installer, which clones (if needed) and starts it:

```bash
curl -fsSL https://raw.githubusercontent.com/jan1tha/mac-cleaner/main/install.sh | bash
```

Prefer the explicit steps above when acting as an agent, so the human sees what runs.
