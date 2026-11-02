#!/usr/bin/env sh
# Dock cell: Copilot plan usage + projection + risk (e.g. 'AIC 13% →238% RISK').
# Node hosts compute it live; elsewhere it reads the snapshot the Windows panel exports (BUDGET_EXPORT).
d="${COPILOT_BUDGET_DIR:-/workspace/tools/copilot-budget}"
exec "$d/start.sh" --dock 2>/dev/null
