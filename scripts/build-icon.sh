#!/bin/sh
# Genera build/icon.icns a partire dallo script Swift dell'icona.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
swift scripts/make-icon.swift "$TMP/icon.png"
mkdir -p "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o build/icon.icns
cp "$TMP/icon.png" build/icon.png
rm -rf "$TMP"
echo "Icona creata: build/icon.icns"
