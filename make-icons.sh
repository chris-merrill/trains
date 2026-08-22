#!/bin/sh
# Regenerate every app icon from the three SVG sources.
#
#   icon.svg           -> icon-512.png, icon-192.png   (rounded, "any" purpose)
#   icon-maskable.svg  -> icon-maskable-512.png        (full bleed, 78% safe zone)
#   icon-apple.svg     -> apple-touch-icon.png         (full bleed, iOS masks it)
#
# macOS only: qlmanage renders the SVG, sips resizes. Exporting PNGs from a
# headless Chrome is blocked by the extension sandbox, hence this route.
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

for f in icon.svg icon-maskable.svg icon-apple.svg; do
  qlmanage -t -s 1024 -o "$OUT" "$f" >/dev/null 2>&1
done

sips -z 512 512 "$OUT/icon.svg.png"          --out icon-512.png         >/dev/null
sips -z 192 192 "$OUT/icon.svg.png"          --out icon-192.png         >/dev/null
sips -z 512 512 "$OUT/icon-maskable.svg.png" --out icon-maskable-512.png >/dev/null
sips -z 180 180 "$OUT/icon-apple.svg.png"    --out apple-touch-icon.png  >/dev/null

echo "icons regenerated — bump CACHE in sw.js before deploying"
