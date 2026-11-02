import test from 'node:test';
import assert from 'node:assert/strict';
import { setPalette, themePalette, dockLine, clockDate, clockTime, collect, forecast, JiraFeed, loadSettings, parseJira, sizeSource, gradient, planUsage, render, riskStatus, slate, Telemetry, workdaysBetween } from './budget.mjs';

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const data = { plan: { usedPercent: 50 }, forecast: null, extras: null };
const full = {
  plan: { usedPercent: 57 }, today: 120, remote: { credits: 40 }, errors: [],
  agents: [{ label: 'main', context: 40, model: 'claude-opus-4', effort: 'high' }, { label: 'dock', context: 80, ubuntu: true }],
  forecast: { used: 57, target: 100, projected: 92, overshoot: -8, capAt: null, dailyTarget: 50, burn: 40, base: 40,
    mix: 1, ctx: 1, cache: 0.9, grade: 'A', remaining: 10, trend: Array.from({ length: 14 }, (_, i) => i * 3), pace: 48, daysToReset: 12 },
};

test('every size renders exactly width x height, plain and color', () => {
  for (const d of [data, full]) {
    for (let w = 1; w <= 200; w += 7) {
      for (let h = 1; h <= 80; h += 5) {
        for (const color of [false, true]) {
          const lines = strip(render(d, w, h, 0, { color })).split('\n');
          assert.equal(lines.length, h, `${w}x${h}`);
          for (const line of lines) assert.equal([...line].length, w, `${w}x${h} color=${color}`);
        }
      }
    }
  }
});

test('plan module shows the percentage on medium and large panes', () => {
  for (const [w, h] of [[24, 12], [40, 20], [66, 34], [132, 50]]) {
    const text = render(full, w, h, 0);
    assert.match(text, /PLAN (USED )?57%/);
    assert.ok(text.includes('█'), 'big numerals or bar');
  }
  assert.match(render(full, 40, 6, 0), /57%/);
});

test('tiny panes fall back to a compact view', () => {
  const lines = render(full, 12, 3, 0).split('\n');
  assert.ok(lines[0].startsWith('~ 57% '), 'WATCH mark in tiny view');
  assert.match(lines[1], /TIME/);
  assert.match(render(full, 12, 4, 0).split('\n')[2], /RST/);
  assert.equal(render(data, 20, 1, 0).split('\n')[0].trimEnd().at(-1), '·');
});

test('art modules fill otherwise empty space on a large pane', () => {
  const lines = render(data, 132, 50, 0).split('\n');
  for (const line of lines) assert.ok(line.trim(), 'no blank row');
  for (let x = 0; x < 132; x++) assert.ok(lines.some((l) => l[x] !== ' '), `column ${x} not blank`);
  assert.match(lines.join('\n'), /OSC|VCF|LFO|SEQ|ENV|MULT|VCA|VU/);
});

const sizes = function* (step = 1) {
  for (let w = 1; w <= 200; w += step) for (let h = 1; h <= 80; h += step) yield [w, h];
};

test('full sweep 1..200 x 1..80: exact width x height in plain and colour', () => {
  const loading = { plan: null, agents: [], errors: ['loading'] };
  for (const d of [full, loading]) {
    for (const [w, h] of sizes(process.env.BUDGET_FULL_SWEEP === '1' ? 1 : 2)) {
      for (const color of [false, true]) {
        const lines = strip(render(d, w, h, 0, { color })).split('\n');
        assert.equal(lines.length, h, `${w}x${h}`);
        for (const line of lines) assert.equal([...line].length, w, `${w}x${h} color=${color}`);
      }
    }
  }
});

test('grid mode: PLAN always present and frames cover every cell (art fills leftovers)', () => {
  for (const [w, h] of sizes(3)) {
    if (w < 20 || h < 6) continue;
    const lines = render(full, w, h, 0).split('\n');
    assert.match(lines.join('\n'), /PLAN (USED )?57%/, `${w}x${h}`);
    for (const [y, line] of lines.entries()) {
      assert.match(line[0], /[╭│╰┆]/, `${w}x${h} row ${y} left`);
      assert.match(line.at(-1), /[╮│╯┆]/, `${w}x${h} row ${y} right`);
    }
  }
});

test('modules never clip their numbers', () => {
  for (const [w, h] of sizes(3)) {
    if (w < 20 || h < 6) continue;
    const text = render(full, w, h, 0);
    const pairs = { PROJ: '92%', UNDER: '-8%', CAP: 'none', DAY: '50', BURN: '40', TGT: '100%', RESET: '12d', AIC: '120', UBU: '40' };
    for (const line of text.split('\n')) {
      for (const [label, value] of Object.entries(pairs)) {
        if (new RegExp(`\\b${label}\\b`).test(line)) assert.match(line, new RegExp(`\\b${label} +${value}( |│)`), `${w}x${h} ${label}`);
      }
    }
    if (text.includes(' TODAY ')) assert.ok(text.includes('120'), `${w}x${h} today`);
    if (text.includes(' CYCLE ')) assert.ok(text.includes('12d'), `${w}x${h} reset`);
  }
});

test('renders stably with hostile data', () => {
  const nasty = {
    plan: { usedPercent: NaN }, today: Infinity, remote: null, errors: ['store: unable to open database file', 'x'.repeat(500)],
    agents: Array.from({ length: 60 }, (_, i) => ({ label: `名前-agent-${'z'.repeat(40)}-${i}`, context: i % 2 ? NaN : 300, model: 'gpt-9-ü' })),
    forecast: { ...full.forecast, projected: Infinity, overshoot: NaN, mix: NaN, cache: NaN, grade: '?', pace: NaN, dailyTarget: -1, trend: Array(14).fill(0) },
  };
  for (const [w, h] of [[1, 1], [19, 5], [20, 6], [48, 21], [66, 34], [164, 23], [200, 80]]) {
    for (const color of [false, true]) {
      const lines = strip(render(nasty, w, h, 0, { color })).split('\n');
      assert.equal(lines.length, h);
      for (const line of lines) assert.equal([...line].length, w);
      assert.doesNotMatch(lines.join(''), /NaN|undefined|Infinity/);
    }
  }
});

test('forecast edge cases', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const plan = { usedPercent: 40, resetDate: '2026-12-01T00:00:00Z' };
  assert.equal(forecast({ plan, history: null, now }), null);
  assert.equal(forecast({ plan: { usedPercent: 40 }, history: { daily: [], active: [] }, now }), null);
  const empty = forecast({ plan, history: { daily: [], cycleAic: 0, overall: {}, active: [] }, now });
  assert.equal(empty.projected, null);
  assert.equal(empty.capAt, null);
  assert.equal(empty.grade, '?');
  const daily = Array.from({ length: 30 }, (_, i) => ({ day: new Date(now - (30 - i) * 86400000).toISOString().slice(0, 10), aic: 100 }));
  const busy = forecast({ plan, history: { daily, cycleAic: 1000, overall: { cost: 1, input: 1000, cache: 0.9 }, active: [] }, now });
  assert.ok(Math.abs(busy.base - 100) < 1e-9);
  assert.ok(busy.projected > 100 && busy.capAt > now);
  assert.equal(workdaysBetween(Date.parse('2026-11-06T10:00:00Z'), Date.parse('2026-11-09T00:00:00Z')), 0);
  assert.equal(planUsage({ resetDate: '2020-01-01' }, 1, now).expired, true);
  assert.equal(planUsage({ remainingPercentage: 25, resetDate: '2026-12-01' }, 1, now).usedPercent, 75);
});

test('collect tolerates missing telemetry, store and stale remote', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(new URL('./.test-', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remoteFile = `${dir}/remote.json`;
  await writeFile(remoteFile, JSON.stringify({ at: '2020-01-01T00:00:00Z', credits: 5, agents: { bad: 1 } }));
  const data = await collect(new Telemetry(dir), { remoteFile });
  assert.equal(data.plan, null);
  assert.equal(data.remote, null);
  assert.deepEqual(data.agents, []);
  assert.match(data.errors[0], /^store:/);
  assert.equal(strip(render(data, 48, 21, 0, { color: true })).split('\n').length, 21);
});

const at = (fc) => ({ ...full, forecast: { ...full.forecast, ...fc } });
const okFc = { projected: 90, overshoot: -10, capAt: null, used: 50, pace: 48, dailyTarget: 200 };

test('risk status thresholds', () => {
  assert.equal(riskStatus(null), null);
  assert.equal(riskStatus({ ...full.forecast, ...okFc }, 100), 'OK');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, projected: 101 }, 100), 'RISK');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, capAt: 5 }, 100), 'RISK');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, projected: 95, target: 90 }, 100), 'WATCH');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, used: 58.5 }, 100), 'WATCH');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, used: 58 }, 100), 'OK');
  assert.equal(riskStatus({ ...full.forecast, ...okFc }, 201), 'WATCH');
  assert.equal(riskStatus({ ...full.forecast, ...okFc, projected: NaN }, null), 'OK');
});

test('risk is visible at every size, with cap and headroom on RISK', () => {
  const risky = at({ ...okFc, projected: 198, overshoot: 98, capAt: Date.parse('2026-11-16'), headroom: 9 });
  for (const [w, h] of sizes(4)) {
    const text = render(risky, w, h, 0);
    if (w < 20 || h < 6) assert.ok(text.startsWith('!'), `${w}x${h} tiny mark`);
    else assert.match(text, /RISK/, `${w}x${h}`);
  }
  const big = render(risky, 66, 34, 0);
  assert.match(big, /cap 11-16/);
  assert.match(big, /headroom 9d/);
  assert.match(big, /→ 198%/);
  assert.match(render(at(okFc), 66, 34, 0, {}), /PLAN USED 57% · OK/);
  assert.ok(render(at(okFc), 12, 3, 0).startsWith('57% '));
});

test('TREND sits next to PLAN: same row when wide, directly below when narrow', () => {
  for (const [w, h] of sizes(3)) {
    if (w < 20 || h < 10) continue;
    const lines = render(full, w, h, 0).split('\n');
    const planRow = lines.findIndex((l) => l.includes(' PLAN '));
    const trendRow = lines.findIndex((l) => l.includes(' TREND '));
    assert.ok(trendRow >= 0, `${w}x${h} trend present`);
    const plan = lines[planRow].indexOf('╭');
    if (w >= 36) {
      assert.equal(trendRow, planRow, `${w}x${h} same row`);
      assert.equal(lines[planRow][lines[planRow].indexOf('╮') + 1], '╭', `${w}x${h} adjacent`);
    } else {
      const bottom = lines.findIndex((l, i) => i > planRow && l[plan] === '╰');
      assert.equal(trendRow, bottom + 1, `${w}x${h} below`);
    }
  }
});

test('art modules are visually distinct from data modules', () => {
  const plain = render(full, 164, 23, 0);
  assert.match(plain, /╭◦ (OSC|VCF|LFO|SEQ|ENV|MULT|VCA|VU)[^╮]*┄/);
  assert.match(plain, /╭◦ PLAN [^╮]*─/);
  const colour = render(full, 164, 23, 0, { color: true });
  const teal = gradient(0.95);
  const muted = slate(0.6);
  assert.ok(colour.includes(`38;2;${teal};48;2;6;18;20m PLAN`));
  assert.match(colour, new RegExp(`38;2;${muted};48;2;6;18;20m (OSC|VCF|LFO|SEQ|ENV|MULT|VCA|VU)`));
});

const NOW = new Date(2026, 10, 2, 12, 57, 30).getTime(); // local Mon 02 Nov 12:57
const twgFixture = { data: { issues: [
  { key: 'AO-425', summary: 'Contract Admin: Define Transition Architecture v.1 ', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    customfield_10020: [{ name: 'Sprint 41', state: 'closed' }, { name: 'Sprint 42', state: 'active' }] },
  { key: 'AO-426', summary: 'Obtain Governance Validation', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
  { key: 'AO-965', summary: 'Define workbench feature split', status: { name: 'Backlog', statusCategory: { key: 'new' } } },
] } };
const withJira = (jira) => ({ ...full, jira: { loaded: true, stale: false, off: false, ...jira } });

test('clock shows local date and time at every size', () => {
  assert.equal(clockTime(NOW), '12:57');
  assert.equal(clockDate(NOW), 'Mon 02 Nov');
  assert.match(render(full, 82, 21, NOW), /Mon 02 Nov · 12:57/);
  for (const [w, h] of sizes(4)) {
    const text = render(full, w, h, NOW);
    if (w < 20 || h < 6) {
      if (h >= 2 && w >= 10) assert.match(text, /12:57/, `${w}x${h} tiny`);
    } else if (!text.includes(' CLOCK ')) assert.match(text, /12:57/, `${w}x${h} stamp`);
  }
  assert.match(render(full, 164, 40, NOW), /█ █/);
});

test('parseJira reads twg stdout.json', () => {
  const jira = parseJira(twgFixture);
  assert.equal(jira.sprint, 'Sprint 42');
  assert.deepEqual(jira.issues.map((i) => i.key), ['AO-425', 'AO-426', 'AO-965']);
  assert.equal(jira.issues[0].summary, 'Contract Admin: Define Transition Architecture v.1');
  assert.deepEqual(parseJira({}), { issues: [], sprint: null });
});

test('JIRA module: list, compact counts, stale and off', () => {
  const data = withJira(parseJira(twgFixture));
  const big = render(data, 82, 21, NOW);
  assert.match(big, /JIRA · Sprint 42/);
  assert.match(big, /● AO-426 Obtain Governance/);
  assert.match(big, /○ AO-965/);
  assert.match(render(withJira({ ...parseJira(twgFixture), stale: true }), 82, 21, NOW), /JIRA · Sprint 42 · stale/);
  assert.match(render(withJira({ issues: [], off: true }), 82, 21, NOW), /jira: off/);
  assert.match(render(withJira({ issues: [], stale: true }), 82, 21, NOW), /jira: stale/);
  const colour = render(data, 82, 21, NOW, { color: true });
  assert.ok(colour.includes(`38;2;${'242;200;120'};48;2;6;18;20m●`), 'review LED amber');
  for (const [w, h] of sizes(5)) {
    for (const color of [false, true]) {
      const lines = strip(render(data, w, h, NOW, { color })).split('\n');
      assert.equal(lines.length, h);
      for (const line of lines) assert.equal([...line].length, w, `${w}x${h}`);
    }
  }
});

test('JiraFeed keeps the last result, flags stale and off, never throws', async () => {
  let fail = null;
  const feed = new JiraFeed({ run: async () => { if (fail) throw fail; return parseJira(twgFixture); } });
  await feed.refresh();
  assert.equal(feed.state.issues.length, 3);
  fail = Object.assign(new Error('boom'), { code: 1 });
  await feed.refresh();
  assert.equal(feed.state.stale, true);
  assert.equal(feed.state.issues.length, 3);
  const missing = new JiraFeed({ run: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  await missing.refresh();
  assert.equal(missing.state.off, true);
});

test('portrait column stacks PLAN, TREND (with sparkline), CLOCK at the top', () => {
  for (const [w, h] of [[34, 69], [30, 60], [35, 80]]) {
    const lines = render(full, w, h, NOW).split('\n');
    const row = (t) => lines.findIndex((l) => l.includes(` ${t} `) || l.includes(` ${t}`));
    assert.ok(row('PLAN') === 0 && row('PLAN') < row('TREND') && row('TREND') < row('CLOCK'), `${w}x${h} order`);
    const trend = lines.slice(row('TREND'), row('CLOCK')).join('\n');
    assert.match(trend, /14d/, `${w}x${h} sparkline`);
    assert.match(trend, /WATCH/);
  }
});

test('loadSettings: file defaults, env overrides, missing file ok', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(new URL('./.test-', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { themesDir, ...defaults } = await loadSettings({}, dir);
  assert.match(themesDir, /themes$/);
  assert.deepEqual(defaults, { home: dir, remote: undefined, target: 100, jira: true, refreshMs: 30000, session: undefined, export: undefined, theme: 'zen' });
  assert.equal((await loadSettings({ BUDGET_THEME: 'mono' }, dir)).theme, 'mono');
  await writeFile(`${dir}/copilot-budget.json`, JSON.stringify({ remote: 'r.json', target: 80, jira: false, session: 'sherpa' }));
  const s = await loadSettings({ BUDGET_TARGET: '90' }, dir);
  assert.equal(s.remote, 'r.json');
  assert.equal(s.target, 90);
  assert.equal(s.jira, false);
  assert.equal(s.session, 'sherpa');
  assert.equal((await loadSettings({ BUDGET_JIRA: '0' }, dir)).jira, false);
  await writeFile(`${dir}/copilot-budget.json`, '{bad');
  await assert.rejects(loadSettings({}, dir), /config:/);
});

test('sizeSource: resize events, refresh polling, failing refresh degrades to events', async () => {
  const { EventEmitter } = await import('node:events');
  const stream = Object.assign(new EventEmitter(), { columns: 80, rows: 24 });
  const seen = [];
  let fresh = [80, 24];
  const src = sizeSource(stream, { onChange: (s) => seen.push(s.join('x')), interval: 5,
    refresh: () => { [stream.columns, stream.rows] = fresh; } });
  fresh = [34, 69];
  await new Promise((r) => globalThis.setTimeout(r, 30));
  assert.deepEqual(seen, ['34x69']);
  src.stop();
  const plain = Object.assign(new EventEmitter(), { columns: 10, rows: 10 });
  const events = sizeSource(plain, { onChange: (s) => seen.push(s.join('x')), refresh: () => { throw new Error('gone'); } });
  plain.columns = 50;
  plain.emit('resize');
  assert.equal(events.polling(), false);
  assert.deepEqual(events.get(), [50, 10]);
  assert.equal(seen.at(-1), '50x10');
  events.stop();
});

test('dockLine: short status for dock cells', () => {
  assert.equal(dockLine({ plan: null }), 'AIC --');
  assert.equal(dockLine({ plan: { usedPercent: 41.6 }, forecast: { projected: 198, capAt: 1, target: 100 } }), 'AIC 42% →198% RISK');
  assert.equal(dockLine({ plan: { usedPercent: 10 }, forecast: { projected: 50, target: 100, used: 10, pace: 20, dailyTarget: 5 }, today: 1 }), 'AIC 10% →50%');
});

test('themes: panel renders every palette with exact dimensions; palette reaches the output', async () => {
  const { listThemes, THEMES_DIR } = await import('../../themes/themes.mjs');
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const names = listThemes();
  assert.ok(names.length >= 4);
  try {
    for (const name of names) {
      const palette = await themePalette(name, THEMES_DIR);
      setPalette(palette);
      for (const [w, h] of [[1, 1], [19, 5], [20, 6], [32, 69], [80, 24], [164, 23]]) {
        const lines = strip(render(full, w, h, NOW, { color: true })).split('\n');
        assert.equal(lines.length, h, `${name} ${w}x${h}`);
        for (const l of lines) assert.equal([...l].length, w, `${name} ${w}x${h}`);
      }
      const bg = palette.bg.slice(1).match(/../g).map((x) => parseInt(x, 16)).join(';');
      assert.ok(render(full, 80, 24, NOW, { color: true }).includes(`48;2;${bg}`), `${name} bg used`);
    }
    assert.deepEqual(await themePalette('no-such-theme', THEMES_DIR), {});
  } finally {
    setPalette();
  }
});