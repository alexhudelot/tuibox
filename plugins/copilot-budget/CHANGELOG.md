# Changelog — copilot-budget

## 0.2.0 — 2026-11-02
- Synth-rack grid layout that re-packs on every resize (wide, narrow and portrait panes; tiny fallback below 20×6).
- Modules: PLAN, TREND (projection, overshoot, cap ETA, 14-day sparkline), CLOCK, JIRA, SYS, CYCLE, TODAY, FORECAST, MODEL·CTX, AGENTS; muted dotted art fills spare cells.
- Risk status OK / WATCH / RISK (teal / amber / coral) at every size.
- JIRA module: read-only `twg` query every 5 min, cached, `stale`/`off` states, opt out with `BUDGET_JIRA=0`.
- Config file `~/.copilot/copilot-budget.json` (env vars override); launchers `start.ps1` / `start.sh`.
- `--dock` one-liner and `tuios/dock/copilot-budget.sh`; `export` snapshot + stdlib `budget.py` renderer for hosts without Node.
- Robustness: missing session store, NaN/Infinity, hostile agent data, wide unicode; resize via `sizeSource`.

## 0.1.0
- Narrow pane: plan % bar, pace and projection markers, today's AIC, forecast, agent context gauges.
