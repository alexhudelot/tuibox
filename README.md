# tuibox

My [tuios](https://github.com/Gaurav-Gosain/tuios) setup for running Claude Code agents in WSL2, plus a matching Windows Terminal colour scheme.

- **Zen theme**: a muted moss-and-teal dark palette, used by both tuios and Windows Terminal.
- **Layout**: tiled windows, rounded borders with a teal gradient on the focused one, pill titles, dimmed unfocused panes, compact bottom dock with clock/CPU/RAM.
- **Agents**: agent detection on, left and right sidebars.
- **Autostart**: a systemd user service runs the tuios daemon at boot, and `resume_agents = "auto"` types `claude --resume <session>` back into each agent pane, so agents come back after a WSL or machine restart.

Tested with tuios 0.11.1 on Ubuntu 24.04 (WSL2).

## Layout

```
tuios/
  config.toml            main config (~/.config/tuios/config.toml)
  themes/zen.json        tuios theme
  dock/claude-week.sh    dock cell showing Claude weekly limit usage
  systemd/tuios.service  user service for the daemon
windows-terminal/
  zen-scheme.json        colour scheme, paste into "schemes"
  profile-defaults.json  profile defaults (scheme, acrylic, opacity)
install.sh
```

## Install

```bash
git clone https://github.com/alexhudelot/tuibox && cd tuibox
./install.sh               # config, theme, dock script
./install.sh --autostart   # also install and enable the systemd service
```

Existing files are backed up as `*.bak-<timestamp>`.

Autostart needs systemd in WSL (`[boot] systemd=true` in `/etc/wsl.conf`) and lingering (`loginctl enable-linger $USER`) so the user service runs without a login. If you start the daemon by hand instead, skip `--autostart`; `resume_agents` works either way.

`resume_agents` accepts `ask` (tuios default), `auto` or `off`.

### Dock cell

`dock/claude-week.sh` reads `~/.cache/claude-weekly.json` (written by a Claude Code status-line script, not included) and prints `wk NN%`. It prints nothing if the file is missing, so it is harmless without it. Needs `jq`.

### Windows Terminal

Open Settings → Open JSON file, then:

1. Add the object from `windows-terminal/zen-scheme.json` to the `schemes` array.
2. Merge `windows-terminal/profile-defaults.json` into the top level (or just set `"colorScheme": "Zen"` on your WSL profile).

## Plugins

- [copilot-budget](plugins/copilot-budget/README.md): Copilot CLI plan usage and forecast pane.

