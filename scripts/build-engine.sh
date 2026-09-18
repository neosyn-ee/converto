#!/bin/sh
# Compila il motore Swift (solo se i sorgenti sono cambiati).
set -e
cd "$(dirname "$0")/.."
OUT=engine/build/converto-engine
mkdir -p engine/build
if [ -f "$OUT" ] && [ -z "$(find engine -name '*.swift' -newer "$OUT")" ]; then
  exit 0
fi
echo "Compilo il motore…"
swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos26.0 \
  engine/*.swift -o "$OUT"
