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

put "$here/tuios/config.toml"          "$cfg/tuios/config.toml"
put "$here/tuios/themes/zen.json"      "$cfg/tuios/themes/zen.json"
put "$here/tuios/dock/claude-week.sh"  "$cfg/tuios/dock/claude-week.sh"
chmod +x "$cfg/tuios/dock/claude-week.sh"

if [ "${1:-}" = "--autostart" ]; then
  put "$here/tuios/systemd/tuios.service" "$cfg/systemd/user/tuios.service"
  systemctl --user daemon-reload
  systemctl --user enable tuios.service
  loginctl enable-linger "$USER" 2>/dev/null || echo "note: run 'sudo loginctl enable-linger $USER' so the daemon starts without a login"
  echo "autostart enabled (starts on next boot; 'systemctl --user start tuios' to start now)"
fi
