#!/usr/bin/env python3
"""copilot-budget for hosts without Node (Ubuntu container).

Renders the JSON snapshot that the Windows panel writes (BUDGET_EXPORT, e.g. /shared/sherpa/budget.json).
No telemetry, credentials or network: one file read per refresh. Stdlib only.

python3 budget.py [--once] [--dock] [--file PATH]
"""
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone

STALE_S = 180
TEAL, AMBER, CORAL, DIM, RESET = "\x1b[38;2;95;179;171m", "\x1b[38;2;240;217;140m", "\x1b[38;2;242;140;120m", "\x1b[2m", "\x1b[0m"


def finite(x):
    return isinstance(x, (int, float)) and x == x and abs(x) != float("inf")


def risk(fc, today=None):
    if not fc:
        return None
    p = fc.get("projected")
    if (finite(p) and p > 100) or fc.get("capAt"):
        return "RISK"
    used, pace, dt = fc.get("used"), fc.get("pace"), fc.get("dailyTarget")
    if (finite(p) and p > fc.get("target", 100)) or (finite(used) and finite(pace) and used > pace + 10) \
            or (finite(today) and finite(dt) and today > dt):
        return "WATCH"
    return "OK"


def load(path, now=None):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, "off"
    try:
        at = datetime.fromisoformat(data["at"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, AttributeError):
        return data, "stale"
    return data, "stale" if (now or time.time()) - at > STALE_S else "ok"


def dock_line(data):
    used = ((data or {}).get("plan") or {}).get("usedPercent")
    if not finite(used):
        return "AIC --"
    fc = data.get("forecast") or {}
    status = risk(fc, data.get("today"))
    parts = ["AIC %d%%" % round(used)]
    if finite(fc.get("projected")):
        parts.append("→%d%%" % round(fc["projected"]))
    if status and status != "OK":
        parts.append(status)
    return " ".join(parts)


def bar(pct, width):
    width = max(0, width)
    n = int(round(min(max(pct, 0), 100) / 100 * width)) if finite(pct) else 0
    return "█" * n + "░" * (width - n)


def fit(s, w):
    return (s[:w] if len(s) > w else s + " " * (w - len(s))) if w > 0 else ""


def render(data, state, width, height, now=None, color=False):
    """Return exactly `height` lines of exactly `width` cells (ASCII/BMP single-width glyphs only)."""
    t = datetime.fromtimestamp(now or time.time())
    lines = []
    plan = (data or {}).get("plan") or {}
    fc = (data or {}).get("forecast") or {}
    status = risk(fc, (data or {}).get("today"))
    mark = {"RISK": "! ", "WATCH": "~ "}.get(status, "")
    lines.append("%sPLAN %s · %s" % (mark, status or "--", t.strftime("%H:%M")))
    used = plan.get("usedPercent")
    lines.append(("%3d%% " % round(used) if finite(used) else " --% ") + bar(used, width - 5))
    if finite(fc.get("projected")):
        lines.append("→ %d%%  target %d%%" % (round(fc["projected"]), fc.get("target", 100)))
    if fc.get("capAt"):
        cap = datetime.fromtimestamp(fc["capAt"] / 1000).strftime("%m-%d")
        lines.append("cap %s" % cap)
    if finite((data or {}).get("today")):
        lines.append("today %.1f AIC" % data["today"])
    lines.append(t.strftime("%a %d %b · %H:%M"))
    agents = (data or {}).get("agents") or []
    if agents:
        lines.append("AGENTS")
        for a in agents:
            c = a.get("context")
            lines.append(" %-12s %s" % (str(a.get("label", ""))[:12], ("%3d%%" % round(c)) if finite(c) else " --"))
    issues = (((data or {}).get("jira") or {}).get("issues")) or []
    if issues:
        lines.append("JIRA")
        for i in issues:
            lines.append(" %s %s" % (i.get("key", ""), i.get("summary", "")))
    if state != "ok":
        lines.append("snapshot: %s" % state)
    out = [fit(l, width) for l in lines[:height]]
    out += [" " * width] * (height - len(out))
    if color and out:
        tint = {"RISK": CORAL, "WATCH": AMBER}.get(status, TEAL)
        out[0] = tint + out[0] + RESET
        out[1:] = [TEAL + l + RESET if i == 0 else (DIM + l + RESET if l.startswith("snapshot") else l) for i, l in enumerate(out[1:])]
    return out


def main(argv):
    path = os.environ.get("BUDGET_EXPORT", "/shared/sherpa/budget.json")
    args = list(argv)
    if "--file" in args:
        i = args.index("--file")
        path = args[i + 1]
        del args[i:i + 2]
    if any(a not in ("--once", "--dock") for a in args):
        print("Usage: budget.py [--once] [--dock] [--file PATH]", file=sys.stderr)
        return 2
    if "--dock" in args:
        print(dock_line(load(path)[0]))
        return 0
    interactive = sys.stdout.isatty() and "--once" not in args
    if interactive:
        sys.stdout.write("\x1b[?1049h\x1b[?25l")
    try:
        while True:
            w, h = shutil.get_terminal_size((40, 12))
            data, state = load(path)
            view = render(data, state, w, h, color=interactive and "NO_COLOR" not in os.environ)
            if not interactive:
                print("\n".join(l.rstrip() for l in view).rstrip())
                return 0
            sys.stdout.write("\x1b[H" + "\r\n".join(view))
            sys.stdout.flush()
            time.sleep(30 - time.time() % 30 + 0.05)
    except KeyboardInterrupt:
        return 0
    finally:
        if interactive:
            sys.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
