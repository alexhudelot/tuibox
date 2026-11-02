#!/usr/bin/env bash
# Dock cell: Claude's weekly limit used, from what ~/.claude/statusline-weekly.sh saved.
jq -r '"wk \(.used_percentage | round)%"' "$HOME/.cache/claude-weekly.json" 2>/dev/null
