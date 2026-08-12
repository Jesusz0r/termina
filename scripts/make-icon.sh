#!/bin/sh
# Render the Termina app icon: build/icon.svg -> icon.icns + icon.png.
# Chromium (render-icon.mjs) rasterizes the SVG with real transparency;
# sips and iconutil build the icns from the master.
set -e
cd "$(dirname "$0")/.."

ICON_SET="build/icon.iconset"
MASTER="build/icon-master.png"

node scripts/render-icon.mjs "$MASTER"

rm -rf "$ICON_SET"
mkdir -p "$ICON_SET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$MASTER" --out "$ICON_SET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$MASTER" --out "$ICON_SET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICON_SET" -o build/icon.icns
sips -z 512 512 "$MASTER" --out build/icon.png >/dev/null
rm -rf "$ICON_SET" "$MASTER"
echo "✓ build/icon.icns and build/icon.png"
