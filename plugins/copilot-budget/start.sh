#!/usr/bin/env sh
# Start the copilot-budget pane: Node if available, else the Python port (Ubuntu container).
here="$(cd "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then exec node --no-warnings "$here/budget.mjs" "$@"; fi
exec python3 "$here/budget.py" "$@"