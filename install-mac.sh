#!/bin/bash
# Installs (or updates) Interview Banner on a Mac with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/captainstealyograndma/Interview-Tool/refs/heads/claude/interview-prep-tool-brainstorm-9npr4a/install-mac.sh | bash
#
# What it does: downloads the app's code, builds the app, puts
# "Interview Banner" in your Applications folder, and opens it.
# Running it again later updates the app.

set -euo pipefail

REPO="captainstealyograndma/Interview-Tool"
BRANCH="${INTERVIEW_BANNER_BRANCH:-claude/interview-prep-tool-brainstorm-9npr4a}"
DEST="${INTERVIEW_BANNER_DIR:-$HOME/InterviewBanner}"
APP_NAME="Interview Banner.app"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() {
  printf '\n\033[1;31m%s\033[0m\n' "$1"
  exit 1
}
trap 'printf "\n\033[1;31mSomething went wrong. Take a screenshot of this window and send it to Claude.\033[0m\n"' ERR

if [ "$(uname)" != "Darwin" ] && [ -z "${INTERVIEW_BANNER_TEST:-}" ]; then
  fail "This installer is for a Mac."
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "Node.js isn't installed yet. Install it from https://nodejs.org (the big LTS download button), then run this command again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Your Node.js is too old (version $NODE_MAJOR). Install the current LTS version from https://nodejs.org, then run this command again."
fi

bold "Step 1 of 4: Downloading the app's code…"
TMP="$(mktemp -d)"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/source.tar.gz"
tar -xzf "$TMP/source.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
mkdir -p "$DEST"
# Keep already-downloaded building blocks and your private folder between updates.
rsync -a --delete --exclude node_modules --exclude private --exclude release "$SRC/" "$DEST/"
rm -rf "$TMP"
cd "$DEST"

bold "Step 2 of 4: Installing the building blocks (this can take a few minutes)…"
npm install --no-audit --no-fund --loglevel=error

bold "Step 3 of 4: Building the app…"
npm run package --silent

if [ -n "${INTERVIEW_BANNER_TEST:-}" ]; then
  bold "Test mode: built successfully; skipping the copy to Applications."
  exit 0
fi

bold "Step 4 of 4: Putting Interview Banner in your Applications folder…"
BUILT="$(ls -d release/mac*/"$APP_NAME" 2>/dev/null | head -n 1)"
[ -n "$BUILT" ] || fail "The app was not built."
osascript -e 'quit app "Interview Banner"' >/dev/null 2>&1 || true
TARGET_DIR="/Applications"
if ! { rm -rf "$TARGET_DIR/$APP_NAME" && cp -R "$BUILT" "$TARGET_DIR/"; } 2>/dev/null; then
  TARGET_DIR="$HOME/Applications"
  mkdir -p "$TARGET_DIR"
  rm -rf "$TARGET_DIR/$APP_NAME"
  cp -R "$BUILT" "$TARGET_DIR/"
fi

bold "Done! Interview Banner is in $TARGET_DIR. Opening it now…"
open "$TARGET_DIR/$APP_NAME"
