#!/bin/sh
# Installa l'app appena compilata in /Applications (sostituendo la versione precedente).
set -e
cd "$(dirname "$0")/.."
APP=dist/mac-arm64/Converto.app
[ -d "$APP" ] || { echo "Prima esegui: npm run dist"; exit 1; }
osascript -e 'tell application "Converto" to quit' >/dev/null 2>&1 || true
rm -rf /Applications/Converto.app
ditto "$APP" /Applications/Converto.app
echo "Installata in /Applications/Converto.app"
