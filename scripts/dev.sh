#!/usr/bin/env bash
# Run the dev build with the debugging hooks on.
#
#   ./scripts/dev.sh [--fresh] [--gallery|--setup|--about]
#
#   --fresh     use a throwaway profile (first-run state: no saved skin,
#               layout or onboarding). Also lets the dev build run beside an
#               installed Zellamp, which otherwise holds the single-instance
#               lock on the shared profile.
#   --gallery / --setup / --about   open that window at launch
#
# Always opens the CDP port (9333, or $WR_DEBUG_PORT) for
# scripts/debug/cdp.mjs. See DEVELOPMENT.md › Dev hooks.

set -euo pipefail
cd "$(dirname "$0")/.."

export WR_DEBUG_PORT="${WR_DEBUG_PORT:-9333}"
for arg in "$@"; do
  case "$arg" in
    --fresh)
      WR_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/zellamp-dev.XXXXXX")"
      export WR_USER_DATA
      echo "== fresh profile: $WR_USER_DATA =="
      ;;
    --gallery) export WR_OPEN_GALLERY=1 ;;
    --setup) export WR_OPEN_SETUP=1 ;;
    --about) export WR_OPEN_ABOUT=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

exec npx electron-vite dev --watch
