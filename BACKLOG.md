# tuibox backlog

Ids are `TB-nnn`. Each item lists acceptance criteria (AC).

## Now

- **TB-050 / TB-031 Push to GitHub** (chore, blocked: auth). Non-interactive attempt on 2026-11-02 (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, 30 s) timed out; `gh` isn't installed.
  User steps (outside tuios, interactive): `winget install GitHub.cli`, `gh auth login` (HTTPS, browser), `gh auth setup-git`, then in `C:\GHCP-Root\tuibox`: `git push origin main tuibox-agent`. Alternative: create a fine-grained PAT (Contents: read/write on alexhudelot/tuibox) and enter it once at the Git Credential Manager prompt of a plain `git push`.
  AC: `main` and `tuibox-agent` are on GitHub.
- **TB-040b Enable copilot-budget as a tuios plugin** (user action). `tuios plugins link/enable` refuse to run inside a tuios pane (security guard, not bypassed). Run from a terminal outside tuios: `tuios plugins link C:\GHCP-Root\tuibox\plugins\copilot-budget`, `tuios plugins enable copilot-budget`, `tuios plugins open copilot-budget budget`.
  AC: the PLAN pane is opened by the plugin; `start.ps1` stays as the manual fallback.

## Next

- **TB-047 Jira extras** (improvement, partly blocked). Sprint name: twg returns `customfield_10020` as null, so the title stays "JIRA" (needs a twg board/sprint command or a field fix upstream). OSC 8 hyperlinks on keys: deferred, the cell canvas has no zero-width escape support yet and tuios' OSC 8 pass-through is unverified. Priority glyph: deferred with OSC 8.
  AC: `JIRA · <sprint>` title; clickable keys in tuios; priority glyph; tests.
- **TB-051 Container clock TZ** (fix, S). `budget.py` in the container shows UTC (container TZ). AC: `TZ=Europe/Paris` set in the container tuios wrapper or the snapshot carries the Windows offset.
- **TB-052 Ubuntu dock uses copilot-budget.sh** (improvement, S). Script and install are in the repo; the live container config still has its old dock. AC: container `config.toml` dock cell runs `/workspace/tools/copilot-budget/start.sh --dock` (back up config first).

## Later

- **TB-066 Theme follow-ups** (improvement, S). install.ps1/install.sh still install from 	uios/themes (now duplicated by 	hemes/zen); switch them to 	hemes/apply.* and drop the duplicates. WT JSON comments are lost on apply (backup kept): consider a text-level upsert.

- **TB-053 Amber accents for the Ubuntu renderer** (improvement, S). `budget.py` uses the teal palette; the Ubuntu theme is blue-teal. AC: palette follows the session theme.

Out of scope: Lucid diagrams and other non-tuibox work.

## Later (styles)

- **TB-074** udget.py (Ubuntu) style parity: only synth-rack-like view in the container.

## Done

- **TB-060** Theme package format `themes/<name>/` (manifest + Windows/Ubuntu tuios themes), validator with WCAG contrast checks (body ≥ 7:1, dim ≥ 4.5:1), Windows/Ubuntu distinguishability check (36cc082).
- **TB-061** zen packaged as the default theme; copilot-budget palette (data gradient, muted art slate, OK/WATCH/RISK, ubuntu accent) comes from the theme via `setPalette()`, `BUDGET_THEME` / `theme` setting, re-read every refresh (36cc082).
- **TB-062** New themes nocturne, ember, mono with Ubuntu variants; all pass contrast (c1b12a0).
- **TB-063** `themes/apply.ps1`: tuios theme + borders (nord→theme reload), WT schemes (backup, `Tuibox <Name>` names so the user's own "Nocturne" scheme isn't clobbered), panel setting, container via `apply.sh` (488b465).
- **TB-064** `themes/apply.sh` for the container + `budget.py` palette.json (live re-read); tests (488b465).
- **TB-070** Panel style system: `style` setting / `BUDGET_STYLE` (synth-rack default), switched live on next refresh; styles independent of palettes; shared data/packing helpers, tiny fallback shared, RISK at every size; style × palette sweep tests.
- **TB-071** Style `cockpit`: semicircle block gauges (PLAN, pace), horizon trend tape, OK/WATCH/RISK annunciators, no art.
- **TB-072** Style `ledger`: rules, right-aligned USED/PACE/PROJ/CAP/TODAY/BURN table, sparkline row, Jira list; no boxes.
- **TB-073** Style `blueprint`: thin frames, dimension lines `├── 238% ──┤`, dot-grid filler, bottom-right title block (date, reset, grade).
- **TB-065** Live demo 2026-11-02: nocturne → ember → mono → zen applied to sherpa + ubuntu; PLAN capture showed each panel background (#0B1020, #161311, #0A0A0A, #061214) without restarting the pane; zen restored, portrait layout restored (PLAN 32x69).

- **TB-040 / TB-021 / TB-022** Stoppable launchers `start.ps1` (Ctrl+C stops, no restart loop) and `start.sh` (Node, else Python); settings file `~/.copilot/copilot-budget.json` with env overrides; the live PLAN pane runs via `start.ps1` from the worktree (f5fc0ba). Plugin link/enable is a user action (TB-040b).
- **TB-041 / TB-023** `tuios/layouts/sherpa-portrait.ps1` restores SHERPA | UBUNTU-TUIOS | PLAN (PLAN grown until ≥32 cols). Live: SHERPA 46x69, UBUNTU-TUIOS 76x69, PLAN 32x69 (afd52f4). The earlier "PLAN ~66 under SHERPA" layout is superseded by the portrait request.
- **TB-042 / TB-020** `sizeSource()`: resize events plus feature-detected `_refreshSize` polling isolated in one place, degrading to events if it throws; tests (f5fc0ba). The private API is still used when present (ConPTY needs it) but can no longer crash the panel.
- **TB-043 / TB-024** README for Windows sherpa + Ubuntu container, docks, WT schemes, plugin; `install.ps1`; `install.sh --ubuntu` installs the variant theme/config, both dock scripts and the plugin; `.gitattributes` keeps `.sh`/`.py` LF (9ff6d04, 3bb5d9f).
- **TB-044** Live Windows and Ubuntu container themes/configs synced into the repo (`themes/ubuntu/zen.json`, `ubuntu-config.toml`); WT schemes `Zen` and `Zen Ubuntu` generated from them (3b11eb5, 9ff6d04).
- **TB-045 / TB-030** Ubuntu panel: the Windows panel writes an atomic JSON snapshot (`export` → `/shared/sherpa/budget.json`); `budget.py` (stdlib, no telemetry/network) renders it with stale/off states, `--dock`, `--once`. Chosen over a full Python port (duplicate telemetry/forecast logic) and a bundled Node binary (rootfs read-only, ~100 MB). Deployed to `/workspace/tools/copilot-budget` (previous dir would be backed up `.bak-<date>`). 4 Python tests (cedcbcc).
- **TB-046** Plugin 0.2.0: manifest description, `dock` action, CHANGELOG (b3fa677).
- **TB-048** Full 1-px sweep opt-in with `BUDGET_FULL_SWEEP=1`; default sweeps every 2nd size (ca8d9e2).
- **TB-049** `budget.mjs --dock` / `budget.py --dock` one-liner (`AIC 13% →238% RISK`) and `tuios/dock/copilot-budget.sh`; test (cedcbcc).
- **TB-034** Review findings accepted: TODAY local midnight vs UTC buckets (intended: "today" is the user's day; forecast uses UTC history consistently); FORECAST labels truncating on 1-cell modules (values never clipped, tested); `kvGrid` dropping items that don't fit (by design, priority order); sweep time fixed by TB-048.
- **TB-032** Merge tuibox-agent → main in `C:\GHCP-Root\tuibox` (see final commit log).

- **TB-017** Portrait overview panel (2026-11-02): PLAN was recreated as a full-height right-edge column with `split-window right -w UBUNTU-TUIOS --name PLAN`, then sized with `resize_width_10` plus 3× `resize_master_grow` (4 cols each). The panel restarted from the worktree, which also removed the old restart loop. Layout: SHERPA 67x69 | UBUNTU-TUIOS 123x69 | PLAN 34x69. In portrait, TREND gets 2 cells so the big projection and sparkline fit.
  AC: portrait test (PLAN → TREND → CLOCK order, sparkline shown); live capture verified.

- **TB-001** Horizontal teal plan bar with pace `│` and projection `┆` markers (57719cd).
- **TB-002** Monthly forecast: EWMA burn, model/effort MIX, context CTX, cap ETA, daily target (57719cd).
- **TB-003** Modular synth-rack grid layout with art fillers (d09968a).
- **TB-004** Re-pack and clear the screen on every resize (676d833).
- **TB-010** Review fixes (2026-11-02):
  - a missing `session-state` dir no longer crashes collection;
  - non-array remote `agents` are ignored;
  - NaN pace and mix no longer render `undefined`/`NaN`;
  - model tags are made ASCII-safe;
  - the EL/ED erase after full-width rows is removed, so the right border is no longer wiped in pending-wrap state.

  AC: covered by tests (hostile data, collect with missing store and stale remote).
- **TB-011** Tests: full 1..200×1..80 sweep, plain and colour (ANSI stripped), with exact size invariants. Also covers: PLAN always present, frames cover every cell, label→value never clipped, forecast edge cases, loading/error data.
- **TB-012** Art modules are visually distinct: muted slate colours and dotted `┄┆` borders; data modules keep the teal gradient and solid borders.
  AC: tests on border glyphs and title colours.
- **TB-013** TREND module next to PLAN shows projected %, overshoot, cap date and the 14-day sparkline, in compact and large (big digits) variants.
  AC: adjacency test (same row when the pane is at least 36 wide, else directly below).
- **TB-014** Risk status OK/WATCH/RISK with LED and colour, shown in the PLAN title, TREND, and the tiny view (`!`/`~`); cap date and headroom days on RISK.
  AC: threshold tests; visible at every swept size.
- **TB-015** CLOCK module: local "Mon 02 Nov · 12:57" with big digits when there's room. Otherwise the time is stamped into the PLAN frame; the tiny view has a TIME row. It redraws on the minute boundary.
  AC: fixed-`now` tests; minute rollover verified live.
- **TB-016** JIRA module: assigned open tickets in the active sprint, read-only via twg, polled in the background every 5 min. Shows `stale`/`off` states; `BUDGET_JIRA=0` turns it off. List and compact count variants.
  AC: fixture and feed tests; checked live.
