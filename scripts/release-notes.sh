#!/usr/bin/env bash
# Печатает описание релиза: раздел версии из CHANGELOG.md и строку про обновление.
# Использование: scripts/release-notes.sh [ВЕРСИЯ]  (по умолчанию — из manifest.json)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:-$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")}
BODY=$(awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && (/^## \[/ || /^\[[^]]+\]: /) { exit }
  on { sub(/^### /, "## "); print }
' CHANGELOG.md | sed -e '/./,$!d')
if [ -z "$BODY" ]; then
  echo "CHANGELOG.md: нет раздела ## [$VERSION]" >&2
  exit 1
fi
printf '%s\n\n' "$BODY"
echo "Обновление: распакуйте **gigamcp-extension-v$VERSION.zip** поверх старой папки, нажмите «Обновить» в \`chrome://extensions\` и начните новый чат."
