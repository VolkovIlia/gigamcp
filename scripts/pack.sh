#!/usr/bin/env bash
# Собирает архивы для релиза: расширение (manifest.json в корне архива) и мост.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
rm -f "dist/gigamcp-extension-v$VERSION.zip" "dist/gigamcp-bridge-v$VERSION.zip"
(cd extension && zip -qr "../dist/gigamcp-extension-v$VERSION.zip" . -x '.*')
zip -qr "dist/gigamcp-bridge-v$VERSION.zip" bridge LICENSE
echo "dist/gigamcp-extension-v$VERSION.zip"
echo "dist/gigamcp-bridge-v$VERSION.zip"
