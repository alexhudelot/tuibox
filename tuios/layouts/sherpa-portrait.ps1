# Restore the Windows `sherpa` portrait layout:
#   SHERPA (~30%) | UBUNTU-TUIOS (large) | PLAN (~34 cols, full height, copilot-budget panel)
# Idempotent: creates PLAN (split right of UBUNTU-TUIOS) only if missing, then re-applies the ratios.
param([string]$Session = 'sherpa', [switch]$StartPanel)
$ErrorActionPreference = 'Stop'
function Act([string]$name) { tuios run-command -s $Session Action $name | Out-Null }
function Focus([string]$w) { tuios run-command -s $Session FocusWindow $w | Out-Null }
$names = (tuios list-windows -s $Session --json | ConvertFrom-Json).windows.custom_name
if ($names -notcontains 'PLAN') {
  tuios split-window right -s $Session -w UBUNTU-TUIOS --name PLAN | Out-Null
  $StartPanel = $true
}
Focus SHERPA; Act resize_width_30
# Width presets are % of the screen (10% ~ 22 cols); each master_grow step adds ~4 cols.
function PlanWidth { $line = tuios list-windows -s $Session | Where-Object { $_ -match 'PLAN' } | Select-Object -First 1; if ($line -match '(\d+)x\d+') { [int]$Matches[1] } else { 0 } }
Focus PLAN; Act resize_width_10
for ($i = 0; $i -lt 8 -and (PlanWidth) -lt 32; $i++) { Act resize_master_grow }
if ($StartPanel) {
  $start = Join-Path $PSScriptRoot '..\..\plugins\copilot-budget\start.ps1' | Resolve-Path
  tuios send-text -s $Session -w PLAN "& '$start'`r" | Out-Null
}
Focus SHERPA
tuios list-windows -s $Session


