#!/usr/bin/env bash
# Install the tuibox tuios setup into ~/.config. Existing files are backed up with a timestamp suffix.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
stamp="$(date +%Y%m%d-%H%M%S)"

put() { # put <src> <dest>
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ] && ! cmp -s "$1" "$2"; then cp "$2" "$2.bak-$stamp"; echo "backed up $2"; fi
  cp "$1" "$2"; echo "installed $2"
}

variant=""; [ "${1:-}" = "--ubuntu" ] && { variant="ubuntu"; shift; }
if [ -n "$variant" ]; then
  put "$here/tuios/ubuntu-config.toml"     "$cfg/tuios/config.toml"
  put "$here/tuios/themes/ubuntu/zen.json" "$cfg/tuios/themes/zen.json"
else
  put "$here/tuios/config.toml"            "$cfg/tuios/config.toml"
  put "$here/tuios/themes/zen.json"        "$cfg/tuios/themes/zen.json"
fi
for d in claude-week.sh copilot-budget.sh; do
  put "$here/tuios/dock/$d" "$cfg/tuios/dock/$d"; chmod +x "$cfg/tuios/dock/$d"
done
dest="${COPILOT_BUDGET_DIR:-$HOME/.local/share/copilot-budget}"
for f in budget.mjs budget.py start.sh herdr-plugin.toml; do put "$here/plugins/copilot-budget/$f" "$dest/$f"; done
chmod +x "$dest/start.sh"

if [ "${1:-}" = "--autostart" ]; then
  put "$here/tuios/systemd/tuios.service" "$cfg/systemd/user/tuios.service"
  systemctl --user daemon-reload
  systemctl --user enable tuios.service
  loginctl enable-linger "$USER" 2>/dev/null || echo "note: run 'sudo loginctl enable-linger $USER' so the daemon starts without a login"
  echo "autostart enabled (starts on next boot; 'systemctl --user start tuios' to start now)"
fi
