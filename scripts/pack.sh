#!/usr/bin/env bash
# Собирает файлы релиза в dist/ и печатает их пути:
#   gigamcp-extension-vX.Y.Z.zip — расширение: manifest.json в корне, помощник в host/;
#   install-host.py — установщик помощника со встроенным gigamcp_host.py, запускается без папки расширения.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/gigamcp-extension-v$VERSION.zip"
(cd extension && zip -qr "../dist/gigamcp-extension-v$VERSION.zip" . -x '.*' -x '*/__pycache__/*')
echo "dist/gigamcp-extension-v$VERSION.zip"
python3 - <<'EOF'
marker = 'HOST_SOURCE = None'
src = open('extension/host/gigamcp_host.py', encoding='utf-8').read()
inst = open('extension/host/install-host.py', encoding='utf-8').read()
if inst.count(marker) != 1:
    raise SystemExit('install-host.py: строка «%s» должна быть ровно одна' % marker)
with open('dist/install-host.py', 'w', encoding='utf-8') as f:
    f.write(inst.replace(marker, 'HOST_SOURCE = %r' % src))
EOF
echo dist/install-host.py
