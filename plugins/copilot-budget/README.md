# copilot-budget

TUIOS/herdr plugin pane for GitHub Copilot CLI plan usage (Node >= 22.5, uses `node:sqlite`).

- Horizontal plan % bar (fills left to right) with pace `│` and projection `┆` markers.
- RESET / PACE / AIC / UBU rows, FORECAST (14-day trend, projected %, target, overshoot, cap ETA, daily AIC target, burn, model-mix and context factors) and per-agent context gauges.
- On resize the bar compacts first (down to one row); metrics are dropped only after that.

Forecast: EWMA of recent daily AIC, weighted by live agents' model/effort cost (MIX) and context load (CTX), projected over remaining weekdays.

Install: `tuios plugins install alexhudelot/tuibox/plugins/copilot-budget`

Env: `BUDGET_TARGET` (default 100), `BUDGET_REMOTE` (remote dock JSON), `BUDGET_REFRESH_MS`, `COPILOT_HOME`. Flags: `--json`, `--once`.
