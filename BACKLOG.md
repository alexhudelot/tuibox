# tuibox backlog

Ids are `TB-nnn`. Each item lists acceptance criteria (AC).

## Now

_(empty: the Now items of 2026-11-02 shipped, see Done)_

## Next

- **TB-020 Replace the `_refreshSize()` resize hack** (fix). The overview panel calls Node's private `process.stdout._refreshSize()` every 250 ms because ConPTY doesn't always send SIGWINCH.
  AC: no private Node API is used; resizes under tuios (Windows ConPTY and Linux) re-pack within 500 ms; there's a test for the size-source abstraction. Options: use `process.stdout.getWindowSize()` on a timer, or have tuios publish the size to the plugin.
- **TB-021 PLAN pane runs an unbreakable restart loop on the main-tree copy** (fix). Neither ctrl+c nor killing node stops the pane's PowerShell loop (`C:/GHCP-Root/tuibox/plugins/copilot-budget/budget.mjs` keeps coming back), so you can't switch to the worktree build in place.
  AC: the pane is started through the plugin manifest (TB-022) or a documented launcher that ctrl+c stops; the live check can target the PLAN pane.
- **TB-022 Install and enable the plugin with `tuios plugins link/install`** (improvement). Replaces the manual pane start.
  AC: `tuios plugins link plugins/copilot-budget` (dev) and `install` (release) open the budget pane with env (`TUIOS_SESSION`, `BUDGET_REMOTE`) from config; the README shows both.
- **TB-023 Restore the sherpa layout after live checks** (fix). Partly superseded by TB-017's portrait layout. The temporary BUDGETTEST window changed the tiling (left column went from 82 to 140 columns, UBUNTU-TUIOS from 122 to 85). The user's preferred layout has PLAN about 66 wide under SHERPA on the left and UBUNTU-TUIOS on the right.
  AC: a scripted, reversible way to set and restore split ratios (for example, a saved layout); after any live test the layout matches the one before it.
- **TB-024 README and install.sh for the current setup** (fix). The README still describes WSL2 + Claude Code.
  AC: the README covers the Windows `sherpa` session, the Ubuntu container session, docks, WT schemes and the copilot-budget plugin; `install.sh`, plus a `install.ps1` for Windows, installs themes and config and links the plugin; `claude-week.sh` is marked legacy or replaced.

## Later

- **TB-030 Ubuntu port of the overview panel** (improvement). The container has no Node.
  AC: decide between a Python port, a bundled single-file Node binary (SEA) or running the panel on Windows against the shared JSON; the panel renders in the `ubuntu` session with amber accents.
- **TB-031 Push to GitHub** (chore). GitHub auth isn't configured on this machine.
  AC: credentials are configured (gh auth or a PAT in the credential manager); `tuibox-agent` and `main` are pushed to `alexhudelot/tuibox`.
- **TB-032 Merge tuibox-agent into main** (chore). Do this only when asked.
  AC: fast-forward or merge commit; tests pass on main; the PLAN pane runs from main again.
- **TB-033 Jira sprint name** (improvement). twg's query doesn't return `customfield_10020`, so the title is just "JIRA".
  AC: the active sprint name is resolved (for example via a board/sprint query) and shown as `JIRA · <sprint>`.
- **TB-034 Remaining review findings** (fix, low).
  - TODAY uses local midnight while daily history buckets are UTC.
  - FORECAST's labels truncate to `PRO` on 1-cell-wide modules; the values stay intact.
  - `kvGrid` silently drops items that don't fit.
  - The full 1..200×1..80 sweep takes about 60 s; it could be moved behind an env flag.
  AC: each one is fixed or explicitly accepted.

Out of scope: Lucid diagrams and other non-tuibox work.

## Proposed (awaiting approval)

Don't implement these until approved. Effort: S/M/L. Risk: L/M/H.

| Id | Type | Title | Why / value | Effort | Risk |
|---|---|---|---|---|---|
| TB-040 | fix | Launch the PLAN pane via the plugin manifest + stoppable launcher (merges TB-021/TB-022) | Live checks and upgrades can't currently be done in place | M | M |
| TB-041 | improvement | Saved `sherpa` layout preset (PLAN ~66 under SHERPA, UBUNTU-TUIOS right) + restore script | Layout drifts after tests and window churn; one-command restore | S | L |
| TB-042 | fix | Replace the `_refreshSize` polling with a supported size source (TB-020) | Private API may break on a Node upgrade | S | M |
| TB-043 | fix | Rewrite the README and add `install.ps1`; `install.sh` installs the plugin (TB-024) | Docs describe a WSL2/Claude setup that no longer exists | M | L |
| TB-044 | improvement | Ubuntu session theme parity: amber gradient theme file + WT scheme in the repo | Ubuntu styling currently lives only in the container | S | L |
| TB-045 | improvement | Ubuntu panel via shared JSON (Windows renders, Ubuntu displays) or a Python port (TB-030) | No Node in the container | L | M |
| TB-046 | improvement | Packaging: bump the plugin version, add a CHANGELOG, `tuios plugins install` from a tag | Reproducible installs | S | L |
| TB-047 | improvement | Jira module: sprint name (TB-033), hyperlink keys (OSC 8), priority glyph | More useful at a glance | S | L |
| TB-048 | fix | Speed up tests: share render results, gate the full sweep behind `BUDGET_FULL_SWEEP=1` | The suite takes about 60 s | S | L |
| TB-049 | improvement | Dock cell for the Copilot budget (replaces `claude-week.sh`) | The dock still shows Claude usage | M | L |
| TB-050 | chore | Configure GitHub auth and push; then merge to main on request (TB-031/032) | Work is only local | S | M |

Recommended Now set (5 items): **TB-040, TB-041, TB-042, TB-043, TB-048**.

## Done

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
