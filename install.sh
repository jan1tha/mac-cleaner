#!/usr/bin/env bash
# Disk Reclaim (mac-cleaner) — installer / launcher.
# Clones the repo if needed, then starts the local web app.
# No sudo, no dependencies, nothing deleted.
set -euo pipefail

REPO="https://github.com/jan1tha/mac-cleaner.git"
DIR="${1:-$HOME/Documents/GIT/mac-cleaner}"

if [ "$(uname)" != "Darwin" ]; then
  echo "This app is for macOS." >&2; exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js (>=18) is required. Install it from https://nodejs.org" >&2
  echo "or, with Homebrew:  brew install node" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only || true
else
  echo "Cloning into $DIR"
  git clone "$REPO" "$DIR"
fi

cd "$DIR"
echo "Starting Disk Reclaim — it will open http://localhost:${PORT:-4567}"
exec node server.js
