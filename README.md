# tuibox

My [tuios](https://github.com/Gaurav-Gosain/tuios) setup for running GitHub Copilot CLI agents on Windows (session `sherpa`) and in an Ubuntu 24.04 container (`ghcp-ubuntu-agent`), with matching Windows Terminal colour schemes and a Copilot budget overview pane.

- **Zen theme**: muted teal dark palette. Windows uses `themes/zen.json`; the Ubuntu container uses a bluer variant `themes/ubuntu/zen.json` so the two sessions are told apart at a glance.
- **Layout**: tiled windows, rounded borders, teal gradient on the focused pane, compact bottom dock. Windows `sherpa` portrait preset: SHERPA | UBUNTU-TUIOS (largest) | PLAN (~32 cols, full height) — `tuios/layouts/sherpa-portrait.ps1` restores it.
- **Overview pane**: [copilot-budget](plugins/copilot-budget/README.md) — plan %, risk (OK/WATCH/RISK), projection, clock, Jira sprint tickets, agent context.
- **Docks**: `dock/copilot-budget.sh` (`AIC 13% →238% RISK`); `dock/claude-week.sh` kept for Claude Code users.

Tested with tuios 0.11.1 on Windows 11 and Ubuntu 24.04.

## Layout

```
tuios/
  config.toml              Windows config (%LOCALAPPDATA%\tuios\config.toml)
  ubuntu-config.toml       container config (/workspace/tools/tuios/config/tuios/config.toml)
  themes/zen.json          Windows theme
  themes/ubuntu/zen.json   Ubuntu container theme
  dock/copilot-budget.sh   dock cell: Copilot plan usage / projection / risk
  dock/claude-week.sh      dock cell: Claude weekly limit (legacy)
  layouts/sherpa-portrait.ps1  restore the portrait PLAN layout in session sherpa
  systemd/tuios.service    user service for the daemon (Linux/WSL)
windows-terminal/
  zen-scheme.json          Windows session scheme ("Zen")
  zen-ubuntu-scheme.json   Ubuntu session scheme ("Zen Ubuntu")
  profile-defaults.json    profile defaults (scheme, acrylic, opacity)
plugins/copilot-budget/    overview pane (Node >= 22.5; Python fallback renderer)
install.ps1                Windows install
install.sh                 Linux / container install
```

## Install

Windows (PowerShell):

```powershell
git clone https://github.com/alexhudelot/tuibox; cd tuibox
./install.ps1        # config, theme, plugin config file; backs up existing files
```

Linux / Ubuntu container:

```bash
./install.sh               # config, theme, dock scripts, copilot-budget (Python fallback)
./install.sh --ubuntu      # use the Ubuntu theme/config variant
./install.sh --autostart   # also install and enable the systemd service
```

Existing files are backed up as `*.bak-<timestamp>`.

### Overview pane (copilot-budget)

Run it in a pane with `plugins/copilot-budget/start.ps1` (Windows) or `start.sh` (Linux: Node if present, else `budget.py`). Settings live in `~/.copilot/copilot-budget.json`, see the plugin README.

As a tuios plugin — run **outside** a tuios pane (tuios refuses plugin changes from inside its own panes):

```powershell
tuios plugins link C:\path\to\tuibox\plugins\copilot-budget
tuios plugins enable copilot-budget
tuios plugins open copilot-budget budget
```

The Ubuntu container has no Node. The Windows pane writes a JSON snapshot (`"export": "C:/GHCP-Root/Ubuntu-Shared/sherpa/budget.json"`, i.e. `/shared/sherpa/budget.json` in the container) and `budget.py` renders/docks it with the Python standard library only.

### Windows Terminal

Settings → Open JSON file: add `windows-terminal/zen-scheme.json` and `zen-ubuntu-scheme.json` to `schemes`, merge `profile-defaults.json`, and set `"colorScheme": "Zen Ubuntu"` on the profile that attaches to the container.

### Autostart (Linux/WSL)

Needs systemd (`[boot] systemd=true` in `/etc/wsl.conf` under WSL) and `loginctl enable-linger $USER`. `resume_agents` accepts `ask`, `auto` or `off`.

## Themes

A theme is a matched set under `themes/<name>/`: `theme.json` (manifest: Windows + Ubuntu border gradients, Windows Terminal scheme names, copilot-budget panel palette) plus `windows.json` / `ubuntu.json` (tuios theme files). Windows stays cool, the Ubuntu variant gets a warmer accent (borders, background tint) so the sessions are told apart at a glance.

| Theme | Look | Windows fg/dim | Ubuntu fg/dim | Panel ink/dim |
|---|---|---|---|---|
| zen (default) | calm high-contrast teal; Ubuntu copper borders | 18.61 / 10.02 | 17.07 / 9.19 | 17.97 / 6.93 |
| nocturne | deep ink blue + silver/ice; Ubuntu violet-ink + gold | 15.94 / 6.70 | 15.58 / 6.68 | 17.32 / 6.70 |
| ember | warm charcoal + copper; Ubuntu redder ember + flame | 15.05 / 6.62 | 14.86 / 6.81 | 17.28 / 6.62 |
| mono | black/white/greys, blueprint-like; Ubuntu sepia | 17.37 / 7.04 | 16.42 / 6.99 | 19.80 / 7.04 |

WCAG contrast ratios against the background; minimums enforced by tests: body ≥ 7:1, dim ≥ 4.5:1.

```powershell
themes\apply.ps1 -List
themes\apply.ps1 nocturne            # tuios (sherpa) + borders, WT schemes, panel, Ubuntu container
themes\apply.ps1 zen -NoTerminal -NoUbuntu
```

`apply.ps1` copies the tuios theme, sets `theme` (via `nord` to force a reload) and the border options with `tuios set-config`, upserts the `Zen`/`Tuibox <Name>` (+ ` Ubuntu`) schemes in Windows Terminal and moves profiles that use a tuibox scheme to the new one (settings.json backed up as `.bak-<ts>`; JSON comments are not preserved), writes `theme`/`themesDir` to `~/.copilot/copilot-budget.json` (or set `BUDGET_THEME`), and runs `apply.sh` in the container. The panel and `budget.py` re-read their palette every refresh, no restart needed. In the container: `sh themes/apply.sh <name> [session]`.

Tests: `node --test themes/` (manifest validation, contrast, WT mapping).
## Backlog

See [BACKLOG.md](BACKLOG.md).
