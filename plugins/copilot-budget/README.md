# copilot-budget

TUIOS/herdr plugin pane for GitHub Copilot CLI plan usage (Node >= 22.5, uses `node:sqlite`).

- Modular synth-rack grid layout: the pane is split into cells (~12 cols x 5 rows); modules are placed greedily in priority order with the largest shape that fits: PLAN (big numerals + teal gradient bar, pace `│` / projection `┆`), CYCLE, TODAY, FORECAST (14-day trend), MODEL·CTX and AGENTS (Ubuntu agents `u ` in amber). Remaining cells are filled with decorative art modules (OSC, LFO, ENV, VCF, VCA, SEQ, VU, MULT, blank panels).
- Each module has compact, wide, tall and large variants; LEDs mark ok / warn / alert.
- Panes under 20 columns or 6 rows fall back to a one-line plan bar plus key numbers; output is always exactly the pane size.

Forecast: EWMA of recent daily AIC, weighted by live agents' model/effort cost (MIX) and context load (CTX), projected over remaining weekdays.

Install: `tuios plugins install alexhudelot/tuibox/plugins/copilot-budget`

Env: `BUDGET_TARGET` (default 100), `BUDGET_REMOTE` (remote dock JSON), `BUDGET_REFRESH_MS`, `COPILOT_HOME`. Flags: `--json`, `--once`.
