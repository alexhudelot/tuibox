#!/usr/bin/env node
// copilot-budget: a narrow tuios/herdr pane for GitHub Copilot CLI plan usage.
// node budget.mjs [--once] [--json]
// Reads local Copilot telemetry only (~/.copilot); no model calls, credentials or network.
import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const DAY = 86400000;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const safeText = (value) => String(value).replace(/[^\x20-\x7e]/g, '?');

// ---------- telemetry ----------

export function planUsage(snapshot, observedAt, now = Date.now()) {
  if (!snapshot) return null;
  const reset = Date.parse(snapshot.resetDate);
  if (Number.isFinite(reset) && now >= reset) return { expired: true, observedAt };
  if (snapshot.isUnlimitedEntitlement) return { unlimited: true, observedAt, resetDate: snapshot.resetDate };
  let usedPercent = null;
  if (finite(snapshot.remainingPercentage)) usedPercent = 100 - snapshot.remainingPercentage;
  else if (finite(snapshot.usedRequests) && snapshot.entitlementRequests > 0) {
    usedPercent = snapshot.usedRequests / snapshot.entitlementRequests * 100;
  }
  return { usedPercent, observedAt, resetDate: snapshot.resetDate };
}

const quotaFromLine = (line) => {
  if (!line.includes('quotaSnapshots')) return null;
  const event = JSON.parse(line);
  if (event.type !== 'model.model_call_success') return null;
  const snapshot = event.data?.quotaSnapshots?.premium_interactions;
  const observedAt = Date.parse(event.timestamp);
  return snapshot && Number.isFinite(observedAt) ? { snapshot, observedAt } : null;
};

const contextFromLine = (line) => {
  if (!line.includes('session.usage_record')) return null;
  const event = JSON.parse(line);
  const usage = event.data?.usage;
  if (event.type !== 'session.usage_record' || event.data?.agentName) return null;
  return finite(usage?.inputTokens) && usage.maxPromptTokens > 0
    ? { percent: usage.inputTokens / usage.maxPromptTokens * 100 } : null;
};

// Search a JSONL transcript backwards so large files are not replayed.
async function lastMatch(file, fromLine) {
  const handle = await open(file, 'r');
  try {
    let end = (await handle.stat()).size;
    let pending = Buffer.alloc(0);
    let tail = true;
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const block = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(block, 0, block.length, start);
      const buffer = Buffer.concat([block.subarray(0, bytesRead), pending]);
      let right = buffer.length;
      let newline;
      while ((newline = buffer.lastIndexOf(10, right - 1)) !== -1) {
        if (tail) tail = false;
        else {
          try {
            const match = fromLine(buffer.subarray(newline + 1, right).toString('utf8'));
            if (match) return match;
          } catch {
            // Skip a malformed line.
          }
        }
        right = newline;
        if (right === 0) break;
      }
      pending = buffer.subarray(0, right);
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export class Telemetry {
  constructor(home) {
    this.home = home;
    this.directory = join(home, 'session-state');
    this.quotas = new Map();
  }

  async newestQuota() {
    let newest = null;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const file = join(this.directory, entry.name, 'events.jsonl');
      try {
        const info = await stat(file);
        const version = `${info.size}:${info.mtimeMs}`;
        let cached = this.quotas.get(file);
        if (cached?.version !== version) this.quotas.set(file, cached = { version, quota: await lastMatch(file, quotaFromLine) });
        if (cached.quota && (!newest || cached.quota.observedAt > newest.observedAt)) newest = cached.quota;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return newest;
  }

  // Copilot holds inuse.<pid>.lock in a session folder while that process runs.
  async liveSessions() {
    const sessions = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      let names;
      try {
        names = await readdir(join(this.directory, entry.name));
      } catch {
        continue;
      }
      const pid = names.map((n) => /^inuse\.(\d+)\.lock$/.exec(n)?.[1]).map(Number).find((p) => p && alive(p));
      if (!pid) continue;
      let name = entry.name.slice(0, 8);
      try {
        const yaml = await readFile(join(this.directory, entry.name, 'workspace.yaml'), 'utf8');
        name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim() || name;
      } catch {
        // Older sessions lack workspace metadata.
      }
      let context = null;
      try {
        context = (await lastMatch(join(this.directory, entry.name, 'events.jsonl'), contextFromLine))?.percent ?? null;
      } catch {
        // No transcript yet.
      }
      sessions.push({ id: entry.name, pid, name, context });
    }
    return sessions;
  }
}

// Label each Copilot process with the tuios pane whose shell launched it (best effort).
async function paneNames(pids) {
  const session = process.env.TUIOS_SESSION || process.env.TUIOS_PLUGIN_SESSION;
  const { stdout } = await execute(process.env.TUIOS_BIN || 'tuios',
    ['list-windows', ...(session ? ['-s', session] : []), '--json'], { timeout: 3000, windowsHide: true });
  const windows = new Map(JSON.parse(stdout).windows.map((w) => [w.pid, w.display_name || w.custom_name]));
  const parents = new Map();
  if (process.platform === 'win32') {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
    const { stdout: out } = await execute('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`],
    { timeout: 5000, windowsHide: true });
    for (const [pid, parent] of out.trim().split(/\r?\n/).map((l) => l.split(' ').map(Number))) parents.set(pid, parent);
  } else {
    for (const pid of pids) {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      parents.set(pid, Number(/^PPid:\s*(\d+)/m.exec(status)?.[1]));
    }
  }
  return new Map(pids.map((pid) => [pid, windows.get(parents.get(pid))]));
}

// Usage history from the session store: daily AIC, per-model/effort cost and context habits.
export function usageHistory(db, { since, cycleStart, sessions = [], now = Date.now() }) {
  const iso = (time) => new Date(time).toISOString();
  const daily = db.prepare(`SELECT substr(created_at, 1, 10) AS day, SUM(total_nano_aiu) / 1e9 AS aic
    FROM assistant_usage_events WHERE created_at >= ? GROUP BY day ORDER BY day`).all(iso(since));
  const cycleAic = cycleStart === null ? null : db.prepare(`SELECT SUM(total_nano_aiu) / 1e9 AS aic
    FROM assistant_usage_events WHERE created_at >= ?`).get(iso(cycleStart)).aic ?? 0;
  const overall = db.prepare(`SELECT AVG(total_nano_aiu) / 1e9 AS cost, AVG(input_tokens) AS input,
    SUM(cache_read_tokens) * 1.0 / NULLIF(SUM(input_tokens), 0) AS cache
    FROM assistant_usage_events WHERE created_at >= ?`).get(iso(now - 14 * DAY));
  const costOf = db.prepare(`SELECT AVG(total_nano_aiu) / 1e9 AS cost FROM assistant_usage_events
    WHERE model = ? AND COALESCE(reasoning_effort, '') = ? AND created_at >= ?`);
  const lastOf = db.prepare(`SELECT model, COALESCE(reasoning_effort, '') AS effort, input_tokens AS input
    FROM assistant_usage_events WHERE session_id = ? AND parent_tool_call_id IS NULL
    ORDER BY created_at DESC LIMIT 1`);
  const active = sessions.map((s) => {
    const last = lastOf.get(s.id);
    if (!last) return { ...s, model: null, effort: null, cost: null, input: null };
    const cost = costOf.get(last.model, last.effort, iso(now - 30 * DAY)).cost;
    return { ...s, model: last.model, effort: last.effort || null, cost, input: last.input };
  });
  return { daily: daily.map((r) => ({ day: r.day, aic: r.aic ?? 0 })), cycleAic, overall, active };
}

// ---------- forecast ----------

const isWorkday = (time) => ![0, 6].includes(new Date(time).getUTCDay());
const dayStart = (time) => Math.floor(time / DAY) * DAY;

// Workdays strictly after today and before the reset instant.
export function workdaysBetween(now, reset) {
  let count = 0;
  for (let t = dayStart(now) + DAY; t < reset; t += DAY) if (isWorkday(t)) count++;
  return count;
}

export function cycleStartOf(reset) {
  const start = new Date(reset);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start.getTime();
}

// Exponentially weighted average of the last ten active days before today, newest weighted most.
export function baseBurn(daily, now, alpha = 0.35) {
  const today = new Date(dayStart(now)).toISOString().slice(0, 10);
  const days = daily.filter((d) => d.day < today && d.aic > 0).slice(-10);
  if (!days.length) return null;
  return days.reduce((average, d) => alpha * d.aic + (1 - alpha) * average, days[0].aic);
}

const average = (values) => {
  const kept = values.filter(finite);
  return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : null;
};

export function forecast({ plan, history, now = Date.now(), target = 100 }) {
  const reset = Date.parse(plan?.resetDate);
  if (!history || !finite(plan?.usedPercent) || !Number.isFinite(reset)) return null;
  const used = plan.usedPercent;
  const start = cycleStartOf(reset);
  const remaining = workdaysBetween(now, reset);
  const base = baseBurn(history.daily, now);
  // Active models and effort: what the live agents cost per request versus the recent average.
  const recentCost = history.overall?.cost;
  const mix = finite(recentCost) && recentCost > 0
    ? clamp((average(history.active.map((a) => a.cost)) ?? recentCost) / recentCost, 0.5, 2) : 1;
  // Context management: larger live prompts cost more per request.
  const liveInput = average(history.active.map((a) => a.input));
  const ctx = finite(liveInput) && history.overall?.input > 0 ? clamp(liveInput / history.overall.input, 0.5, 2) : 1;
  const cache = finite(history.overall?.cache) ? history.overall.cache : null;
  const liveContext = average(history.active.map((a) => a.context)) ?? 0;
  const grade = cache === null ? '?' : cache >= 0.85 && liveContext < 60 ? 'A' : cache >= 0.7 && liveContext < 80 ? 'B' : 'C';
  const burn = finite(base) ? base * Math.sqrt(mix * ctx) : null;
  // Calibrate AIC to plan %: this cycle's local AIC against the % the API reports used.
  const pctPerAic = history.cycleAic >= 50 && used > 0 ? used / history.cycleAic : null;
  const perDay = finite(burn) && pctPerAic ? burn * pctPerAic : null;
  const projected = finite(perDay) ? used + perDay * remaining : null;
  let capAt = null;
  if (finite(perDay) && perDay > 0) {
    let left = 100 - used;
    for (let t = dayStart(now) + DAY; t < reset && capAt === null; t += DAY) {
      if (isWorkday(t) && (left -= perDay) <= 0) capAt = t;
    }
  }
  const dailyTarget = pctPerAic && remaining > 0 ? Math.max(0, (target - used) / pctPerAic / remaining) : null;
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(dayStart(now) - i * DAY).toISOString().slice(0, 10);
    trend.push(history.daily.find((d) => d.day === day)?.aic ?? 0);
  }
  return {
    used, target, projected, overshoot: finite(projected) ? projected - target : null, capAt,
    dailyTarget, burn, base, mix, ctx, cache, grade, remaining, trend,
    pace: clamp((now - start) / (reset - start) * 100, 0, 100), daysToReset: Math.max(0, Math.ceil((reset - now) / DAY)),
  };
}

// ---------- rendering ----------

const DIGITS = {
  0: ['███', '█ █', '█ █', '█ █', '███'], 1: [' █ ', '██ ', ' █ ', ' █ ', '███'],
  2: ['███', '  █', '███', '█  ', '███'], 3: ['███', '  █', '███', '  █', '███'],
  4: ['█ █', '█ █', '███', '  █', '  █'], 5: ['███', '█  ', '███', '  █', '███'],
  6: ['███', '█  ', '███', '█ █', '███'], 7: ['███', '  █', '  █', '  █', '  █'],
  8: ['███', '█ █', '███', '█ █', '███'], 9: ['███', '█ █', '███', '  █', '███'],
  '%': ['█ █', '  █', ' █ ', '█  ', '█ █'],
};
const SPARK = '▁▂▃▄▅▆▇█';
const EIGHTHS = ' ▏▎▍▌▋▊▉';
const STOPS = [[0, 'C5DEA6'], [0.35, 'A9DED4'], [0.6, 'A9CDD9'], [0.82, 'D9C6EB'], [1, 'F2A89B']]
  .map(([at, hex]) => [at, [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))]);
export const gradient = (t) => {
  t = clamp(t, 0, 1);
  const i = Math.max(1, STOPS.findIndex(([at]) => at >= t));
  const [[a, from], [b, to]] = [STOPS[i - 1], STOPS[i]];
  return from.map((c, j) => Math.round(c + (to[j] - c) * (t - a) / (b - a))).join(';');
};
const TRACK = '38;44;47';
const INK = '255;248;232';
const INK_ON_FILL = '21;24;26';
const DIM = '127;163;160';
const AMBER = '242;200;120';
const ALERT = '242;140;120';
const UBUNTU = '200;131;74';
const CALM = gradient(0.35);

const compact = (value) => !finite(value) ? '--' : value >= 10000 ? `${Math.round(value / 1000)}k`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
const percent = (value) => finite(value) ? `${Math.round(value)}%` : '--';
const shortModel = (model) => (model ?? '').replace(/^claude-/, '').replace(/^gpt-/, 'g').replace(/[-.]/g, '');

// Horizontal bar filling left to right; the figure is drawn as block numerals when the bar has
// five rows and room, otherwise as text on its middle row.
function bar(plan, fc, width, height, color) {
  const used = !plan?.expired && finite(plan?.usedPercent) ? clamp(plan.usedPercent, 0, 100) : null;
  const label = plan?.expired ? 'EXP' : plan?.unlimited ? 'UNL' : used !== null ? `${Math.round(used)}%` : '--';
  const eighths = used === null ? 0 : Math.round(used / 100 * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const colOf = (value) => finite(value) ? Math.min(width - 1, Math.floor(clamp(value, 0, 100) / 100 * width)) : -1;
  const paceAt = colOf(fc?.pace);
  const projAt = colOf(fc?.projected);
  const big = [0, 1, 2, 3, 4].map((r) => [...label].map((c) => DIGITS[c]?.[r] ?? '   ').join(' '));
  const fits = big[0].length <= width && height >= 5 && [...label].every((c) => c in DIGITS);
  const top = Math.floor((height - 5) / 2);
  const left = Math.floor((width - (fits ? big[0].length : label.length)) / 2);
  const middle = Math.floor((height - 1) / 2);
  const lines = [];
  for (let y = 0; y < height; y++) {
    let out = '';
    let last = '';
    for (let x = 0; x < width; x++) {
      const tone = gradient(width > 1 ? x / (width - 1) : 1);
      const filled = x < full;
      const edge = x === full && part > 0;
      let char = filled ? '█' : edge ? EIGHTHS[part] : '·';
      let shown = edge ? char : ' ';
      let fg = edge ? tone : null;
      let bg = filled ? tone : TRACK;
      if (x === projAt && x !== paceAt) [char, shown, fg] = ['┆', '┆', filled ? INK_ON_FILL : ALERT];
      if (x === paceAt) [char, shown, fg] = ['│', '│', filled ? INK_ON_FILL : AMBER];
      if (fits ? y >= top && y < top + 5 && big[y - top][x - left] === '█' : y === middle && label[x - left]?.trim()) {
        if (fits) [char, shown, fg, bg] = filled || edge ? [' ', ' ', null, null] : ['█', ' ', null, INK];
        else [char, shown, fg] = [label[x - left], label[x - left], filled ? INK_ON_FILL : INK];
      }
      if (!color) out += char;
      else {
        const code = `${fg ? `38;2;${fg}` : '39'};${bg ? `48;2;${bg}` : '49'}`;
        out += (code === last ? '' : `\x1b[${code}m`) + shown;
        last = code;
      }
    }
    lines.push(color ? `${out}\x1b[0m` : out);
  }
  return lines;
}

export function render(data, width = 20, height = 40, now = Date.now(), { color = false } = {}) {
  width = Math.max(4, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const paint = (code, text) => color ? `\x1b[38;2;${code}m${text}\x1b[0m` : text;
  const row = (label, value, tone = INK, labelTone = DIM) => {
    value = value.slice(0, width - 1);
    label = label.slice(0, Math.max(1, width - value.length - 1));
    return paint(labelTone, label) + ' '.repeat(width - label.length - value.length) + paint(tone, value);
  };
  const rule = (title) => paint(DIM, `${title} ${'─'.repeat(width)}`.slice(0, width));
  const gauge = (value, prefix) => {
    const cells = width - prefix.length;
    const fill = Math.round(clamp(value || 0, 0, 100) / 100 * cells);
    const tone = value >= 90 ? ALERT : value >= 75 ? AMBER : CALM;
    return color ? paint(DIM, prefix) + `\x1b[38;2;${tone}m${'▆'.repeat(fill)}\x1b[38;2;${TRACK}m${'▆'.repeat(cells - fill)}\x1b[0m`
      : prefix + '▆'.repeat(fill) + '·'.repeat(cells - fill);
  };
  const fc = data.forecast;
  const below = (data.errors ?? []).map((e) => paint(ALERT, safeText(e).slice(0, width).padEnd(width)));
  below.push(row('RESET', fc ? `${fc.daysToReset}d` : '--'),
    row('PACE', percent(fc?.pace), fc && fc.used > fc.pace ? AMBER : CALM),
    row('AIC', compact(data.today)));
  if (data.remote !== undefined) below.push(row('UBU', data.remote === null ? 'off' : compact(data.remote.credits)));
  if (fc) {
    const peak = Math.max(...fc.trend, 1);
    const spark = fc.trend.slice(-width).map((v) => v > 0 ? SPARK[Math.min(7, Math.floor(v / peak * 8))] : '·').join('');
    const over = fc.overshoot;
    below.push(rule('FORECAST'), paint(gradient(0.5), spark.padStart(width)),
      row('PROJ', percent(fc.projected), !finite(fc.projected) ? INK : fc.projected > 100 ? ALERT : fc.projected > fc.target ? AMBER : CALM),
      row('TGT', percent(fc.target)),
      row(finite(over) && over > 0 ? 'OVER' : 'UNDER', finite(over) ? `${over > 0 ? '+' : ''}${Math.round(over)}%` : '--',
        finite(over) && over > 0 ? ALERT : CALM),
      row('CAP', fc.capAt ? new Date(fc.capAt).toISOString().slice(5, 10) : 'none', fc.capAt ? ALERT : INK),
      row('DAY', compact(fc.dailyTarget), finite(fc.burn) && finite(fc.dailyTarget) && fc.burn > fc.dailyTarget ? AMBER : INK),
      row('BURN', compact(fc.burn)),
      row('MIX', `x${fc.mix.toFixed(1)}`, fc.mix > 1.2 ? AMBER : INK),
      row('CTX', `${fc.grade} ${percent(finite(fc.cache) ? fc.cache * 100 : null)}`,
        fc.grade === 'C' ? ALERT : fc.grade === 'B' ? AMBER : CALM));
  }
  if (data.agents?.length) below.push(rule('AGENTS'));
  for (const a of data.agents ?? []) {
    below.push(row((a.ubuntu ? 'u ' : '') + safeText(a.label), percent(a.context), INK, a.ubuntu ? UBUNTU : DIM));
    const tag = a.model ? `${shortModel(a.model).slice(0, 7)}${a.effort ? `·${a.effort[0]}` : ''} ` : '';
    below.push(gauge(a.context, tag.length <= width - 3 ? tag : ''));
  }
  // Metrics keep priority as the pane shrinks: the bar gives up rows first, down to one,
  // then the separator goes, and only then are trailing rows (agents, forecast) dropped.
  // The bar takes at most 7 rows so spare height stays with the metrics.
  const footer = below.slice(0, Math.max(0, height - 1));
  const gap = footer.length && height - footer.length >= 2 ? 1 : 0;
  const barHeight = Math.min(7, height - footer.length - gap);
  const pad = Array(height - footer.length - gap - barHeight).fill(' '.repeat(width));
  return [...bar(data.plan, fc, width, barHeight, color), ...(gap ? [' '.repeat(width)] : []), ...footer, ...pad].join('\n');
}

// ---------- collection ----------

export async function collect(telemetry, { now = Date.now(), remoteFile = process.env.BUDGET_REMOTE,
  target = Number(process.env.BUDGET_TARGET) || 100 } = {}) {
  const errors = [];
  const quota = await telemetry.newestQuota();
  const plan = quota ? planUsage(quota.snapshot, quota.observedAt, now) : null;
  const sessions = await telemetry.liveSessions();
  if (sessions.length) {
    try {
      const panes = await paneNames(sessions.map((s) => s.pid));
      for (const s of sessions) s.label = panes.get(s.pid)?.split('|')[0].trim();
    } catch {
      // Outside tuios, keep session names.
    }
  }
  for (const s of sessions) s.label = (s.label || s.name).slice(0, 12).trimEnd();
  let history = null;
  let today = null;
  try {
    const db = new DatabaseSync(join(telemetry.home, 'session-store.db'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 500');
      const reset = Date.parse(plan?.resetDate);
      history = usageHistory(db, { since: now - 40 * DAY, cycleStart: Number.isFinite(reset) ? cycleStartOf(reset) : null, sessions, now });
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      today = db.prepare('SELECT SUM(total_nano_aiu) / 1e9 AS aic FROM assistant_usage_events WHERE created_at >= ?')
        .get(midnight.toISOString()).aic ?? 0;
    } finally {
      db.close();
    }
  } catch (error) {
    errors.push(`store: ${error.message}`);
  }
  let remote;
  if (remoteFile) {
    remote = null;
    try {
      const snapshot = JSON.parse(await readFile(remoteFile, 'utf8'));
      if (now - Date.parse(snapshot.at) <= 180000) remote = snapshot;
    } catch {
      // A missing or half-written snapshot reads as offline.
    }
  }
  const agents = [
    ...(history?.active ?? sessions).map((a) => ({ label: a.label, context: a.context, model: a.model, effort: a.effort })),
    ...(remote?.agents ?? []).map((a) => ({ label: String(a.label).slice(0, 12).trimEnd(), context: a.percent, ubuntu: true })),
  ];
  return { plan, today, remote, agents, forecast: forecast({ plan, history, now, target }), errors };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => !['--once', '--json'].includes(a))) throw new Error('Usage: node budget.mjs [--once] [--json]');
  const telemetry = new Telemetry(process.env.COPILOT_HOME || join(homedir(), '.copilot'));
  if (args.includes('--json')) return console.log(JSON.stringify(await collect(telemetry), null, 2));
  const interactive = process.stdout.isTTY && !args.includes('--once');
  let data = { plan: null, agents: [], errors: ['loading'] };
  const draw = () => {
    const view = render(data, process.stdout.columns || 20, process.stdout.rows || 40, Date.now(),
      { color: interactive && !Object.hasOwn(process.env, 'NO_COLOR') });
    process.stdout.write(interactive ? `\x1b[H${view.split('\n').join('\x1b[K\r\n')}\x1b[J` : `${view}\n`);
  };
  if (interactive) {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.once('exit', () => process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l'));
    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));
    process.stdout.on('resize', draw);
  }
  do {
    try {
      data = await collect(telemetry);
    } catch (error) {
      data = { ...data, errors: [error.message] };
    }
    draw();
    if (interactive) await setTimeout(Number(process.env.BUDGET_REFRESH_MS) || 30000);
  } while (interactive);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`copilot-budget: ${error.message}`);
    process.exitCode = 1;
  });
}
