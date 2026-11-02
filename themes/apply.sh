#!/usr/bin/env sh
# Apply a tuibox theme inside the Ubuntu container (or any Linux tuios host):
# tuios theme file (Ubuntu variant) + borders, and the budget.py palette. Rewritten files are backed up as .bak-<ts>.
#   sh themes/apply.sh <name> [session]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
name="${1:?usage: apply.sh <theme> [session]}"
session="${2:-${TUIOS_SESSION:-ubuntu}}"
stamp="$(date +%Y%m%d-%H%M%S)"
dir="$here/$name"
[ -f "$dir/theme.json" ] || { echo "unknown theme: $name" >&2; exit 1; }
if [ -x /workspace/tools/tuios/tuios ]; then
  tuios=/workspace/tools/tuios/tuios; cfg="${TUIOS_CONFIG_DIR:-/workspace/tools/tuios/config/tuios}"
else
  tuios=tuios; cfg="${TUIOS_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tuios}"
fi
field() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [d:=d[k] for k in sys.argv[2:]]; print(d if isinstance(d,str) else json.dumps(d))" "$dir/theme.json" "$@"; }

mkdir -p "$cfg/themes"
src="$dir/$(field ubuntu tuios)"
dest="$cfg/themes/$name.json"
if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then cp "$dest" "$dest.bak-$stamp"; echo "backed up $dest"; fi
cp "$src" "$dest"
[ -f "$cfg/config.toml" ] && cp "$cfg/config.toml" "$cfg/config.toml.bak-$stamp"
"$tuios" set-config -s "$session" theme nord >/dev/null
"$tuios" set-config -s "$session" theme "$name" >/dev/null
"$tuios" set-config -s "$session" border_focused_gradient "$(field ubuntu borders border_focused_gradient)" >/dev/null
"$tuios" set-config -s "$session" border_unfocused_color "$(field ubuntu borders border_unfocused_color)" >/dev/null
echo "tuios ($session): theme $name, borders $(field ubuntu borders border_focused_gradient)"

budget="${COPILOT_BUDGET_DIR:-/workspace/tools/copilot-budget}"
if [ -d "$budget" ]; then
  field panel > "$budget/palette.json.tmp" && mv "$budget/palette.json.tmp" "$budget/palette.json"
  echo "copilot-budget: palette $name ($budget/palette.json)"
fi
