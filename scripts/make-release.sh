#!/usr/bin/env bash
# Build release installers for macOS and Windows.
#
#   ./scripts/make-release.sh <version>
#
#   <version>   e.g. 0.2.0. Stamped into package.json, the apps and the
#               installer names.
#
# Gates: typecheck and unit tests must pass before anything is built.
#
# Output (dist/):
#   Zellamp-<version>-arm64.dmg        macOS (Apple Silicon)
#   Zellamp Setup <version>.exe        Windows x64 (NSIS)
#   SHA256SUMS.txt
#
# Signing: the Mac app is re-signed with the "Zellamp Local Signing"
# certificate when present (stable permissions on *your* Mac; other Macs
# still see an unidentified developer). Neither installer is notarized or
# Authenticode-signed yet. See DEVELOPMENT.md › Releasing.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: make-release.sh <version>}"

echo "== version $VERSION =="
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

echo "== typecheck + tests =="
npm run typecheck
npm test

echo "== macOS =="
npm run dist
echo "== Windows =="
npx electron-builder --win --x64

DMG="dist/Zellamp-$VERSION-arm64.dmg"
EXE="dist/Zellamp Setup $VERSION.exe"
for f in "$DMG" "$EXE"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done
(cd dist && shasum -a 256 "$(basename "$DMG")" "$(basename "$EXE")" > SHA256SUMS.txt)

if ! security find-identity -p codesigning 2>/dev/null | grep -q '"Developer ID Application'; then
  echo
  echo "!! not notarized: other Macs will need System Settings › Privacy & Security › Open Anyway."
fi

cat <<NEXT

== done ==
$(cat dist/SHA256SUMS.txt)

Publish (commit the version bump first):
  git commit -am "Zellamp $VERSION" && git tag v$VERSION && git push --follow-tags
  gh release create v$VERSION "$DMG" "$EXE" dist/SHA256SUMS.txt --title "Zellamp $VERSION"
NEXT
