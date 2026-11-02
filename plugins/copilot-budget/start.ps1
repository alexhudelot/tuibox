# Start the copilot-budget pane in the current terminal. Ctrl+C stops it (no restart loop).
# Settings come from ~/.copilot/copilot-budget.json; env vars (BUDGET_REMOTE, ...) override.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.vfox\sdks\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-Error 'copilot-budget: Node >= 22.5 not found (PATH or ~/.vfox)'; exit 1 }
& $node --no-warnings (Join-Path $PSScriptRoot 'budget.mjs') @args
