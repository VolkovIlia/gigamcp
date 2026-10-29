#!/usr/bin/env bash
# Собирает архив расширения для релиза: manifest.json в корне, помощник в host/.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version" 2>/dev/null || python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/gigamcp-extension-v$VERSION.zip"
(cd extension && zip -qr "../dist/gigamcp-extension-v$VERSION.zip" . -x '.*' -x '*/__pycache__/*')
echo "dist/gigamcp-extension-v$VERSION.zip"
