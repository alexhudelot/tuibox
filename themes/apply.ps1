# Apply a tuibox theme on Windows: tuios theme + borders, Windows Terminal schemes, copilot-budget palette,
# and (unless -NoUbuntu) the Ubuntu container via apply.sh. Every file it rewrites is backed up as .bak-<ts>.
#   themes\apply.ps1 <name> [-Session sherpa] [-NoTerminal] [-NoUbuntu]
#   themes\apply.ps1 -List
param(
  [Parameter(Position = 0)] [string] $Name,
  [string] $Session = 'sherpa',
  [string] $Container = 'ghcp-ubuntu-agent',
  [switch] $NoTerminal,
  [switch] $NoUbuntu,
  [switch] $List
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.vfox\sdks\nodejs\node.exe' }
if ($List -or -not $Name) { & $node "$here\themes.mjs" list; return }
$dir = Join-Path $here $Name
if (-not (Test-Path "$dir\theme.json")) { throw "unknown theme '$Name' (themes\apply.ps1 -List)" }
$theme = Get-Content "$dir\theme.json" -Raw | ConvertFrom-Json

function Backup($path) {
  if (Test-Path $path) { Copy-Item $path "$path.bak-$stamp"; "backed up $path" }
}

# 1. tuios theme file + live config (switching through nord forces tuios to re-read the theme file).
$tuiosThemes = Join-Path $env:LOCALAPPDATA 'tuios\themes'
New-Item -ItemType Directory -Force $tuiosThemes | Out-Null
$dest = Join-Path $tuiosThemes "$Name.json"
if ((Test-Path $dest) -and (Get-FileHash $dest).Hash -ne (Get-FileHash "$dir\$($theme.windows.tuios)").Hash) { Backup $dest }
Copy-Item "$dir\$($theme.windows.tuios)" $dest -Force
Backup (Join-Path $env:LOCALAPPDATA 'tuios\config.toml')
tuios set-config -s $Session theme nord | Out-Null
tuios set-config -s $Session theme $Name | Out-Null
foreach ($p in $theme.windows.borders.PSObject.Properties) { tuios set-config -s $Session $p.Name $p.Value | Out-Null }
"tuios ($Session): theme $Name, borders $($theme.windows.borders.border_focused_gradient)"

# 2. Windows Terminal: upsert both schemes; profiles using any tuibox scheme follow the new one.
if (-not $NoTerminal) {
  $wt = Get-ChildItem "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal*\LocalState\settings.json" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wt) {
    $schemes = & $node "$here\themes.mjs" wt $Name | ConvertFrom-Json
    $all = Get-ChildItem $here -Directory | Where-Object { Test-Path "$($_.FullName)\theme.json" } |
      ForEach-Object { Get-Content "$($_.FullName)\theme.json" -Raw | ConvertFrom-Json }
    $winNames = @($all.windows.wtScheme); $ubuNames = @($all.ubuntu.wtScheme)
    Backup $wt.FullName
    $settings = Get-Content $wt.FullName -Raw | ConvertFrom-Json
    foreach ($s in $schemes) {
      $settings.schemes = @($settings.schemes | Where-Object { $_.name -ne $s.name }) + $s
    }
    foreach ($p in $settings.profiles.list) {
      if ($p.PSObject.Properties['colorScheme']) {
        if ($winNames -contains $p.colorScheme) { $p.colorScheme = $theme.windows.wtScheme }
        elseif ($ubuNames -contains $p.colorScheme) { $p.colorScheme = $theme.ubuntu.wtScheme }
      }
    }
    $settings | ConvertTo-Json -Depth 32 | Set-Content $wt.FullName -Encoding utf8
    "windows terminal: schemes '$($theme.windows.wtScheme)', '$($theme.ubuntu.wtScheme)'"
  } else { 'windows terminal: settings.json not found, skipped' }
}

# 3. copilot-budget palette: the pane re-reads this file every refresh.
$cfg = Join-Path $env:USERPROFILE '.copilot\copilot-budget.json'
$settings = if (Test-Path $cfg) { Get-Content $cfg -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$settings | Add-Member -Force NoteProperty theme $Name
$settings | Add-Member -Force NoteProperty themesDir ($here -replace '\\', '/')
New-Item -ItemType Directory -Force (Split-Path $cfg) | Out-Null
$settings | ConvertTo-Json -Depth 8 | Set-Content $cfg -Encoding utf8
"copilot-budget: theme $Name ($cfg)"

# 4. Ubuntu container: stage the package on /shared and run apply.sh there.
if (-not $NoUbuntu -and (Get-Command docker -ErrorAction SilentlyContinue)) {
  $running = docker ps --filter "name=^$Container$" --format '{{.Names}}' 2>$null
  $shared = 'C:\GHCP-Root\Ubuntu-Shared\sherpa\tuibox-themes'
  if ($running -and (Test-Path (Split-Path $shared))) {
    New-Item -ItemType Directory -Force $shared | Out-Null
    Copy-Item "$here\apply.sh" $shared -Force
    Copy-Item $dir $shared -Recurse -Force
    docker exec -u agent $Container sh -c "tr -d '\r' < /shared/sherpa/tuibox-themes/apply.sh > /shared/sherpa/tuibox-themes/.apply.sh && sh /shared/sherpa/tuibox-themes/.apply.sh $Name"
  } else { "ubuntu: container $Container not running, skipped" }
}
