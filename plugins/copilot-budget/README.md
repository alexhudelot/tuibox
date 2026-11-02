# copilot-budget

TUIOS/herdr plugin pane for GitHub Copilot CLI plan usage (Node >= 22.5, uses `node:sqlite`).

- Modular synth-rack grid layout: the pane is split into cells (~12 cols x 5 rows); modules are placed greedily in priority order with the largest shape that fits:
  1. **PLAN** — big numerals + teal gradient bar with pace `│` / projection `┆`; the title carries the risk status (`· OK|WATCH|RISK`).
  2. **TREND** — right next to PLAN (same row; directly below on narrow panes): risk LED + status, projected month-end %, overshoot, cap date, headroom days on RISK, 14-day sparkline (big digits when room).
  3. **CLOCK** — local "Mon 02 Nov · 12:57" (big digits on large panes); if no cell is free the time is stamped into the PLAN frame. Redrawn on every minute boundary.
  4. **JIRA** — your open tickets in the active sprint (LED: ○ to do, teal in progress, amber review/blocked); compact variant shows counts. `jira: stale` / `jira: off` on error / missing twg.
  5. SYS (errors), CYCLE, TODAY, FORECAST, MODEL·CTX, AGENTS (Ubuntu agents `u ` in amber).
- Remaining cells are decorative art modules (OSC, LFO, ENV, VCF, VCA, SEQ, VU, MULT, blank) in a muted slate palette with dotted `┄┆` borders, so they never read as data.
- Risk: **RISK** (coral) if projected > 100% or the cap is hit before reset; **WATCH** (amber) if projected > target, used > pace + 10 pts, or today's AIC > daily target; **OK** (teal) otherwise.
- Panes under 20 columns or 6 rows fall back to a one-line plan bar (prefixed `!` RISK / `~` WATCH) plus TIME and key numbers; output is always exactly the pane size.

Forecast: EWMA of recent daily AIC, weighted by live agents' model/effort cost (MIX) and context load (CTX), projected over remaining weekdays.

Jira data is read-only via `twg jira workitem query` (JQL: assignee = currentUser() in open sprints, not Done), polled in the background every 5 minutes; rendering never waits for it.

Install: `tuios plugins install alexhudelot/tuibox/plugins/copilot-budget` (manual start: `node --no-warnings budget.mjs`).

Settings: `~/.copilot/copilot-budget.json` (or `BUDGET_CONFIG`), keys `remote`, `target`, `jira`, `refreshMs`, `session`, `export`; the matching env vars override: `BUDGET_REMOTE` (remote dock JSON), `BUDGET_TARGET` (default 100), `BUDGET_REFRESH_MS`, `BUDGET_JIRA=0` (disable Jira), `TUIOS_SESSION`, `BUDGET_EXPORT` (write a JSON snapshot each refresh). Also `TWG_BIN`, `COPILOT_HOME`, `NO_COLOR`. Flags: `--json`, `--dock` (one line, e.g. `AIC 13% →238% RISK`), `--once`.

Start: `start.ps1` (Windows, Ctrl+C stops) or `start.sh` (Node if present, else `python3 budget.py`). `budget.py` (stdlib only) renders the exported snapshot for hosts without Node such as the Ubuntu container: `python3 budget.py [--once] [--dock] [--file /shared/sherpa/budget.json]`; it shows `snapshot: stale` after 3 min and `off` when the file is missing. Times follow the host TZ (set `TZ` in the container).

Tests: `node --test` (coarse render sweep; `BUDGET_FULL_SWEEP=1` for every size 1..200×1..80) and `python3 -m unittest test_budget`.

