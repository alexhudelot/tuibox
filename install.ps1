# Install the tuibox tuios setup on Windows. Existing files are backed up with a timestamp suffix.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$cfg = Join-Path $env:LOCALAPPDATA 'tuios'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
function Put($src, $dest) {
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  if ((Test-Path $dest) -and (Get-FileHash $src).Hash -ne (Get-FileHash $dest).Hash) {
    Copy-Item $dest "$dest.bak-$stamp"; "backed up $dest"
  }
  Copy-Item $src $dest -Force; "installed $dest"
}
Put "$here\tuios\config.toml" "$cfg\config.toml"
Put "$here\tuios\themes\zen.json" "$cfg\themes\zen.json"
$settings = Join-Path $env:USERPROFILE '.copilot\copilot-budget.json'
if (-not (Test-Path $settings)) {
  New-Item -ItemType Directory -Force (Split-Path $settings) | Out-Null
  '{ "session": "sherpa", "target": 100, "jira": true }' | Set-Content $settings -Encoding utf8
  "created $settings"
}
"copilot-budget: run $here\plugins\copilot-budget\start.ps1 in a pane, or from a terminal outside tuios:"
"  tuios plugins link $here\plugins\copilot-budget; tuios plugins enable copilot-budget"
