#!/bin/bash
# Rebase origin/deploy onto a fresh mirror branch (main or release/v3.8.0).
# Run this before opening a new upstream PR session so deploy stays current.
set -e

TARGET="${1:-release/v3.8.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Fetching origin…"
git fetch origin

echo "Checking out deploy…"
git checkout deploy

echo "Rebasing onto origin/$TARGET…"
git rebase "origin/$TARGET"

echo
echo "Rebase succeeded. Remaining local commits on deploy:"
git log "origin/$TARGET..deploy" --oneline

echo
echo "If happy with the rebase, force-push:"
echo "  git push --force-with-lease origin deploy"
echo
echo "Then verify the deploy image still represents the right content."
