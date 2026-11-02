#!/usr/bin/env node
// copilot-budget: a narrow tuios/herdr pane for GitHub Copilot CLI plan usage.
// node budget.mjs [--once] [--json|--dock]
// Reads local Copilot telemetry only (~/.copilot); no model calls, credentials or network.
import { execFile } from 'node:child_process';
import { open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  // A fresh install has no session-state folder yet: treat it as empty.
  async entries() {
    try {
      return await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async newestQuota() {
    let newest = null;
    for (const entry of await this.entries()) {
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
    for (const entry of await this.entries()) {
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
    headroom: capAt === null ? null : Math.max(0, Math.ceil((capAt - now) / DAY)),
    dailyTarget, burn, base, mix, ctx, cache, grade, remaining, trend,
    pace: clamp((now - start) / (reset - start) * 100, 0, 100), daysToReset: Math.max(0, Math.ceil((reset - now) / DAY)),
  };
}

// RISK: heading past 100% or hitting the cap before reset. WATCH: past target, used running more
// than 10 points ahead of pace, or today's burn above the daily target. OK otherwise.
export function riskStatus(fc, today = null) {
  if (!fc) return null;
  if ((finite(fc.projected) && fc.projected > 100) || fc.capAt) return 'RISK';
  if ((finite(fc.projected) && fc.projected > fc.target) || (finite(fc.used) && finite(fc.pace) && fc.used > fc.pace + 10)
    || (finite(today) && finite(fc.dailyTarget) && today > fc.dailyTarget)) return 'WATCH';
  return 'OK';
}

// ---------- rendering ----------
// The pane is a grid of rack cells (about CELL_W x CELL_H). Data modules are placed greedily in
// priority order using the largest shape that still fits; empty cells become decorative "art"
// synth modules so the rack always looks full.

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
const rgb = (hex) => [0, 2, 4].map((i) => parseInt(String(hex).replace('#', '').slice(i, i + 2), 16));
const triple = (hex) => rgb(hex).join(';');
// Default palette = theme "zen". Themes override it through setPalette() (themes/<name>/theme.json "panel").
export const DEFAULT_PALETTE = {
  gradient: ['#134E4A', '#2F7F78', '#5FB3AB', '#8FD3C9', '#C4F1EA'], slate: ['#242A30', '#76828E'],
  bg: '#061214', track: '#262C2F', rule: '#1E3436', ink: '#FFF8E8', inkOnFill: '#15181A', dim: '#7FA3A0',
  watch: '#F2C878', risk: '#F28C78', ubuntu: '#C8834A', gradientAt: [0, 0.3, 0.6, 0.85, 1],
};
let STOPS, SLATE, BG, TRACK, RULE, INK, INK_ON_FILL, DIM, AMBER, ALERT, UBUNTU, CALM, LEDS, STATUS, JIRA_TONE;
export const gradient = (t) => {
  t = clamp(t, 0, 1);
  const i = Math.max(1, STOPS.findIndex(([at]) => at >= t));
  const [[a, from], [b, to]] = [STOPS[i - 1], STOPS[i]];
  return from.map((c, j) => Math.round(c + (to[j] - c) * (t - a) / (b - a))).join(';');
};
// Decorative modules use a muted slate family so they never read as data.
export const slate = (t) => {
  t = clamp(t, 0, 1);
  const [from, to] = SLATE;
  return from.map((c, j) => Math.round(c + (to[j] - c) * t)).join(';');
};
export function setPalette(palette = {}) {
  const p = { ...DEFAULT_PALETTE, ...palette };
  const at = palette.gradient && !palette.gradientAt ? null : p.gradientAt;
  STOPS = p.gradient.map((hex, i) => [at?.length === p.gradient.length ? at[i] : i / (p.gradient.length - 1), rgb(hex)]);
  SLATE = p.slate.map(rgb);
  [BG, TRACK, RULE, INK, INK_ON_FILL, DIM, AMBER, ALERT, UBUNTU] =
    [p.bg, p.track, p.rule, p.ink, p.inkOnFill, p.dim, p.watch, p.risk, p.ubuntu].map(triple);
  CALM = gradient(0.55);
  LEDS = { ok: CALM, warn: AMBER, alert: ALERT };
  STATUS = { OK: { state: 'ok', tone: CALM, mark: '' }, WATCH: { state: 'warn', tone: AMBER, mark: '~' },
    RISK: { state: 'alert', tone: ALERT, mark: '!' } };
  JIRA_TONE = { todo: DIM, progress: gradient(0.6), review: AMBER };
  return p;
}
setPalette();
const capDate = (time) => new Date(time).toISOString().slice(5, 10);
const CELL_W = 12;
const CELL_H = 5;

const compact = (value) => !finite(value) ? '--' : value >= 10000 ? `${Math.round(value / 1000)}k`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
const percent = (value) => finite(value) ? `${Math.round(value)}%` : '--';
const shortModel = (model) => (model ?? '').replace(/^claude-/, '').replace(/^gpt-/, 'g').replace(/[-.]/g, '');
const knob = (fraction) => '○◔◑◕●'[finite(fraction) ? Math.round(clamp(fraction, 0, 1) * 4) : 0];
const hash = (a, b) => (((a + 1) * 73856093) ^ ((b + 1) * 19349663)) >>> 0;
const severity = (value, warn, alert) => !finite(value) ? null : value >= alert ? 'alert' : value >= warn ? 'warn' : 'ok';

// A fixed-size character grid; every render goes through it so output is always width x height.
class Canvas {
  constructor(width, height, color) {
    Object.assign(this, { w: width, h: height, color });
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', fg: null, bg: null })));
  }

  put(x, y, ch, fg = null, bg) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const cell = this.cells[y][x];
    cell.ch = ch;
    cell.fg = fg;
    if (bg !== undefined) cell.bg = bg;
  }

  text(x, y, text, fg, max = Infinity) {
    [...text].slice(0, Math.max(0, max)).forEach((ch, i) => this.put(x + i, y, ch, fg));
  }

  fill(x, y, w, h, bg) {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.put(c, r, ' ', null, bg);
  }

  toString() {
    return this.cells.map((row) => {
      if (!this.color) return row.map((c) => c.ch).join('');
      let out = '';
      let last = '';
      for (const c of row) {
        const code = `${c.fg ? `38;2;${c.fg}` : '39'};${c.bg ? `48;2;${c.bg}` : '49'}`;
        out += (code === last ? '' : `\x1b[${code}m`) + c.ch;
        last = code;
      }
      return `${out}\x1b[0m`;
    }).join('\n');
  }
}

const led = (cv, x, y, state) => cv.put(x, y, cv.color || state !== 'ok' ? '●' : '○', LEDS[state]);

// Synth-panel frame: rounded border in the teal gradient, screw dots and a small label.
function frame(cv, b, title, art) {
  cv.fill(b.x, b.y, b.w, b.h, BG);
  const tone = (x) => art ? slate(0.35 + 0.2 * x / Math.max(1, cv.w - 1)) : gradient(0.3 + 0.55 * x / Math.max(1, cv.w - 1));
  const [hz, vt] = art ? ['┄', '┆'] : ['─', '│'];
  for (let i = 0; i < b.w; i++) {
    const x = b.x + i;
    const end = i === 0 ? 0 : i === b.w - 1 ? 1 : -1;
    cv.put(x, b.y, end < 0 ? hz : '╭╮'[end], tone(x));
    cv.put(x, b.y + b.h - 1, end < 0 ? hz : '╰╯'[end], tone(x));
  }
  for (let r = 1; r < b.h - 1; r++) {
    cv.put(b.x, b.y + r, vt, tone(b.x));
    cv.put(b.x + b.w - 1, b.y + r, vt, tone(b.x + b.w - 1));
  }
  if (b.w >= 8) {
    for (const y of [b.y, b.y + b.h - 1]) {
      cv.put(b.x + 1, y, '◦', art ? slate(0.4) : DIM);
      cv.put(b.x + b.w - 2, y, '◦', art ? slate(0.4) : DIM);
    }
  }
  if (title && b.w >= title.length + 6) cv.text(b.x + 2, b.y, ` ${title} `, art ? slate(0.6) : gradient(0.95));
  return { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
}

// Label left, value right, optional status LED in front.
function kv(cv, x, y, w, item) {
  if (w <= 0) return;
  let lx = x;
  let lw = w;
  if (item.state && w >= 10) {
    led(cv, x, y, item.state);
    lx += 2;
    lw -= 2;
  }
  const value = item.value.slice(0, lw);
  cv.text(lx, y, item.label.slice(0, Math.max(0, lw - value.length - 1)), DIM);
  cv.text(x + w - value.length, y, value, item.tone ?? INK);
}

// Key/value items flowed into as many columns as needed (and fit), centred in the box.
function kvGrid(cv, b, items) {
  if (!items.length || b.h <= 0 || b.w <= 0) return;
  const maxCols = Math.max(1, Math.floor((b.w + 2) / 12));
  const cols = clamp(Math.ceil(items.length / b.h), 1, maxCols);
  items = items.slice(0, cols * b.h);
  const per = Math.ceil(items.length / cols);
  const cw = Math.min(18, Math.floor((b.w - 2 * (cols - 1)) / cols));
  const left = b.x + Math.floor((b.w - (cw * cols + 2 * (cols - 1))) / 2);
  const top = b.y + Math.floor((b.h - per) / 2);
  items.forEach((item, i) => kv(cv, left + Math.floor(i / per) * (cw + 2), top + i % per, cw, item));
}

// VU-style meter row: optional dim prefix, then ▆ cells.
function meter(cv, x, y, w, value, prefix = '', tone = null) {
  if (prefix.length > w - 3) prefix = '';
  cv.text(x, y, prefix, DIM);
  const cells = w - prefix.length;
  const fill = Math.round(clamp(finite(value) ? value : 0, 0, 100) / 100 * cells);
  const shade = tone ?? LEDS[severity(value, 75, 90) ?? 'ok'];
  for (let i = 0; i < cells; i++) {
    const on = i < fill;
    cv.put(x + prefix.length + i, y, cv.color || on ? '▆' : '·', on ? shade : TRACK);
  }
}

// Horizontal plan bar filling left to right in the teal gradient, with pace │ and projection ┆.
function planBar(cv, x, y, w, rows, used, fc) {
  if (w <= 0) return;
  const eighths = used === null ? 0 : Math.round(used / 100 * w * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const colOf = (value) => finite(value) ? Math.min(w - 1, Math.floor(clamp(value, 0, 100) / 100 * w)) : -1;
  const paceAt = colOf(fc?.pace);
  const projAt = colOf(fc?.projected);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < w; i++) {
      const tone = gradient(w > 1 ? i / (w - 1) : 1);
      const filled = i < full;
      const edge = i === full && part > 0;
      let ch = cv.color ? (edge ? EIGHTHS[part] : ' ') : filled ? '█' : edge ? EIGHTHS[part] : '·';
      let fg = edge ? tone : null;
      if (i === projAt && i !== paceAt) [ch, fg] = ['┆', filled ? INK_ON_FILL : ALERT];
      if (i === paceAt) [ch, fg] = ['│', filled ? INK_ON_FILL : AMBER];
      cv.put(x + i, y + r, ch, fg, cv.color ? (filled ? tone : TRACK) : null);
    }
  }
}

const planLabel = (plan) => plan?.expired ? 'EXP' : plan?.unlimited ? 'UNL'
  : finite(plan?.usedPercent) ? `USED ${Math.round(clamp(plan.usedPercent, 0, 100))}%` : '--';

function planModule(cv, b, data) {
  const fc = data.forecast;
  const plan = data.plan;
  const used = !plan?.expired && finite(plan?.usedPercent) ? clamp(plan.usedPercent, 0, 100) : null;
  const label = plan?.expired ? 'EXP' : plan?.unlimited ? 'UNL' : used !== null ? `${Math.round(used)}%` : '--';
  const risk = riskStatus(fc, data.today);
  const state = used === null ? null : risk ? STATUS[risk].state : used >= 90 ? 'alert' : 'ok';
  if (b.h <= 1) {
    const head = `${risk && STATUS[risk].mark ? `${STATUS[risk].mark} ` : ''}${label} `;
    cv.text(b.x, b.y, head, risk ? STATUS[risk].tone : INK, b.w);
    planBar(cv, b.x + head.length, b.y, b.w - head.length, 1, used, fc);
    return;
  }
  const glyphs = [...label];
  const bigW = glyphs.length * 4 - 1;
  const big = glyphs.every((c) => c in DIGITS) && b.h >= 7 && b.w >= bigW + 2;
  const rest = b.h - (big ? 5 : 1);
  const barRows = rest >= 5 ? 3 : rest >= 4 ? 2 : rest >= 1 ? 1 : 0;
  const legend = rest - barRows >= 1 ? 1 : 0;
  const gap = rest - barRows - legend >= 1 ? 1 : 0;
  let y = b.y + Math.floor((rest - barRows - legend - gap) / 2);
  if (big) {
    const left = b.x + Math.floor((b.w - bigW) / 2);
    for (let r = 0; r < 5; r++) {
      glyphs.forEach((g, i) => [...DIGITS[g][r]].forEach((ch, j) => {
        if (ch !== ' ') cv.put(left + i * 4 + j, y + r, '█', gradient(0.5 + 0.5 * (i * 4 + j) / Math.max(1, bigW - 1)));
      }));
    }
    if (state && left - b.x >= 3) led(cv, left - 3, y + 2, state);
    y += 5;
  } else {
    const left = b.x + Math.floor((b.w - label.length) / 2);
    if (state && left - b.x >= 2) led(cv, left - 2, y, state);
    cv.text(left, y, label, INK);
    y += 1;
  }
  y += gap;
  const inset = b.w >= 14 ? 1 : 0;
  planBar(cv, b.x + inset, y, b.w - 2 * inset, barRows, used, fc);
  y += barRows;
  if (!legend) return;
  const pace = finite(fc?.pace) ? `│ pace ${percent(fc.pace)}` : '0%';
  const proj = finite(fc?.projected) ? `proj ${percent(fc.projected)} ┆` : '100%';
  if (pace.length + proj.length + 1 <= b.w - 2 * inset) {
    cv.text(b.x + inset, y, pace, finite(fc?.pace) ? AMBER : DIM);
    cv.text(b.x + b.w - inset - proj.length, y, proj, finite(fc?.projected) ? ALERT : DIM);
  } else if (finite(fc?.pace)) {
    cv.text(b.x + inset, y, `│${percent(fc.pace)}`, AMBER, b.w);
    const short = finite(fc.projected) ? `proj ${percent(fc.projected)}┆` : '';
    if (short.length + percent(fc.pace).length + 2 <= b.w - 2 * inset) cv.text(b.x + b.w - inset - short.length, y, short, ALERT);
  }
}

// Items first, then optional meter rows at the bottom when there is room.
function stack(cv, b, items, meters = []) {
  const extra = meters.slice(0, Math.max(0, b.h - Math.min(items.length, b.h)));
  const room = b.h - extra.length;
  const shown = Math.min(items.length, room);
  const slack = room - shown;
  kvGrid(cv, { ...b, y: b.y + Math.floor(slack / 2), h: shown }, items);
  extra.forEach((draw, i) => draw(b.x + (b.w >= 14 ? 1 : 0), b.y + room + i, b.w - (b.w >= 14 ? 2 : 0)));
}

function cycleModule(cv, b, data) {
  const fc = data.forecast;
  stack(cv, b, [
    { label: 'RESET', value: fc ? `${fc.daysToReset}d` : '--' },
    { label: 'PACE', value: fc ? `${knob(fc.pace / 100)} ${percent(fc.pace)}` : '--',
      tone: fc && fc.used > fc.pace ? AMBER : CALM, state: fc ? (fc.used > fc.pace ? 'warn' : 'ok') : null },
  ], fc ? [(x, y, w) => meter(cv, x, y, w, fc.pace, 'cyc ', gradient(0.4))] : []);
}

function todayModule(cv, b, data) {
  const fc = data.forecast;
  const items = [{ label: 'AIC', value: compact(data.today) }];
  if (data.remote !== undefined) {
    items.push({ label: 'UBU', value: data.remote === null ? 'off' : compact(data.remote.credits),
      state: data.remote === null ? 'warn' : 'ok' });
  }
  const ratio = finite(fc?.dailyTarget) && fc.dailyTarget > 0 && finite(data.today) ? data.today / fc.dailyTarget * 100 : null;
  stack(cv, b, items, ratio === null ? [] : [(x, y, w) => meter(cv, x, y, w, ratio, 'day ', LEDS[severity(ratio, 100, 150)])]);
}

function forecastModule(cv, b, data) {
  const fc = data.forecast;
  const over = fc.overshoot;
  const items = [
    { label: 'PROJ', value: percent(fc.projected), state: severity(fc.projected, fc.target + 0.5, 100.5),
      tone: !finite(fc.projected) ? INK : fc.projected > 100 ? ALERT : fc.projected > fc.target ? AMBER : CALM },
    { label: finite(over) && over > 0 ? 'OVER' : 'UNDER', value: finite(over) ? `${over > 0 ? '+' : ''}${Math.round(over)}%` : '--',
      tone: finite(over) && over > 0 ? ALERT : CALM },
    { label: 'CAP', value: fc.capAt ? new Date(fc.capAt).toISOString().slice(5, 10) : 'none', tone: fc.capAt ? ALERT : INK },
    { label: 'DAY', value: compact(fc.dailyTarget),
      tone: finite(fc.burn) && finite(fc.dailyTarget) && fc.burn > fc.dailyTarget ? AMBER : INK },
    { label: 'BURN', value: compact(fc.burn) },
    { label: 'TGT', value: percent(fc.target) },
  ];
  const spark = (x, y, w) => sparkline(cv, x, y, w, fc.trend);

  stack(cv, b, items, b.h >= 4 ? [spark] : []);
}

function modelModule(cv, b, data) {
  const fc = data.forecast;
  stack(cv, b, [
    { label: 'MIX', value: finite(fc.mix) ? `${knob((fc.mix - 0.5) / 1.5)} x${fc.mix.toFixed(1)}` : '--', tone: fc.mix > 1.2 ? AMBER : INK },
    { label: 'CTX', value: `${fc.grade} ${percent(finite(fc.cache) ? fc.cache * 100 : null)}`,
      tone: fc.grade === 'C' ? ALERT : fc.grade === 'B' ? AMBER : CALM,
      state: fc.grade === 'C' ? 'alert' : fc.grade === 'B' ? 'warn' : fc.grade === 'A' ? 'ok' : null },
  ], finite(fc.cache) ? [(x, y, w) => meter(cv, x, y, w, fc.cache * 100, 'cache ', gradient(0.6))] : []);
}

function agentsModule(cv, b, data) {
  const agents = data.agents;
  const peak = Math.max(...agents.map((a) => finite(a.context) ? a.context : 0));
  if (b.w < 16 || (b.h < 2 && agents.length > 1)) {
    kvGrid(cv, b, [{ label: 'LIVE', value: `${agents.length}` },
      { label: 'MAX', value: percent(peak), state: severity(peak, 75, 90) }]);
    return;
  }
  const rows = agents.length <= b.h ? agents.length : b.h - 1;
  const top = b.y + Math.floor((b.h - rows - (agents.length > rows ? 1 : 0)) / 2);
  agents.slice(0, rows).forEach((a, i) => {
    const y = top + i;
    const pct = percent(a.context);
    const name = (a.ubuntu ? 'u ' : '') + safeText(a.label);
    const nameW = Math.min(name.length, 12, Math.max(4, Math.floor(b.w * 0.4)));
    led(cv, b.x, y, severity(a.context, 75, 90) ?? 'ok');
    cv.text(b.x + 2, y, name, a.ubuntu ? UBUNTU : DIM, nameW);
    cv.text(b.x + b.w - pct.length, y, pct, INK);
    let x = b.x + 2 + 13;
    const tag = a.model ? `${safeText(shortModel(a.model)).slice(0, 7)}${a.effort ? `·${a.effort[0]}` : ''}` : '';
    const gaugeEnd = b.x + b.w - pct.length - 1;
    if (tag && gaugeEnd - x - tag.length - 1 >= 6) {
      cv.text(x, y, tag, DIM);
      x += tag.length + 1;
    }
    if (b.w < 26) x = b.x + 2 + nameW + 1;
    if (gaugeEnd - x >= 3) meter(cv, x, y, gaugeEnd - x, a.context);
  });
  if (agents.length > rows) cv.text(b.x + 2, top + rows, `+${agents.length - rows} more`, DIM, b.w - 2);
}

function sysModule(cv, b, data) {
  (data.errors ?? []).slice(0, b.h).forEach((e, i) => cv.text(b.x, b.y + i, safeText(e), ALERT, b.w));
}

function sparkline(cv, x, y, w, trend, label = '14d') {
  if (w <= 0) return;
  if (w < label.length + 4) label = '';
  const values = trend.slice(-Math.max(1, w - (label ? label.length + 1 : 0)));
  const peak = Math.max(...values, 1);
  cv.text(x, y, label, DIM);
  const left = x + w - values.length;
  values.forEach((v, i) => {
    const level = v > 0 ? Math.min(7, Math.floor(v / peak * 8)) : -1;
    cv.put(left + i, y, level < 0 ? '·' : SPARK[level], level < 0 ? TRACK : gradient(0.35 + level / 11));
  });
}

// Headline forecast next to PLAN: risk status, projected month-end %, overshoot, cap ETA, trend.
function trendModule(cv, b, data) {
  const fc = data.forecast;
  const risk = riskStatus(fc, data.today);
  if (!fc) {
    cv.text(b.x, b.y + Math.floor((b.h - 1) / 2), '→ -- no history', DIM, b.w);
    return;
  }
  const { tone, state } = STATUS[risk];
  const over = finite(fc.overshoot) ? `${fc.overshoot > 0 ? '+' : ''}${Math.round(fc.overshoot)}%` : '';
  const proj = `→ ${percent(fc.projected)}`;
  if (b.h <= 1) {
    const cap = fc.capAt ? ` cap ${capDate(fc.capAt)}` : '';
    const sw = Math.max(0, b.w - proj.length - cap.length - 2);
    cv.text(b.x, b.y, proj, tone, b.w);
    if (sw >= 3) sparkline(cv, b.x + proj.length + 1, b.y, sw, fc.trend, '');
    cv.text(b.x + b.w - cap.length, b.y, cap, ALERT, cap.length <= b.w - proj.length ? cap.length : 0);
    return;
  }
  // Rows of [left, right] in priority order; a right part that does not fit moves to its own row.
  const rows = [[{ text: risk, tone, led: state }, fc.capAt ? { text: `cap ${capDate(fc.capAt)}`, tone: ALERT } : null],
    [{ text: proj, tone }, over ? { text: over, tone: fc.overshoot > 0 ? ALERT : CALM } : null],
    risk === 'RISK' && finite(fc.headroom) ? [{ text: `headroom ${fc.headroom}d`, tone: ALERT }, null]
      : [{ text: 'day', tone: DIM }, { text: compact(fc.dailyTarget), tone: INK }]];
  const lines = [];
  for (const [l, r] of rows) {
    const lw = l.text.length + (l.led ? 2 : 0);
    if (!r || lw + r.text.length + 1 <= b.w) lines.push([l, r]);
    else lines.push([l, null], [null, r]);
  }
  const bigLabel = percent(fc.projected);
  const big = [...bigLabel].every((c) => c in DIGITS) && b.h >= lines.length + 6 && b.w >= bigLabel.length * 4 + 3;
  const spark = b.h >= lines.length + (big ? 6 : 1);
  const shown = lines.slice(0, b.h - (spark ? 1 : 0) - (big ? 5 : 0));
  let y = b.y + Math.floor((b.h - shown.length - (spark ? 1 : 0) - (big ? 5 : 0)) / 2);
  shown.forEach(([l, r], i) => {
    if (i === 1 && big) {
      const bw = bigLabel.length * 4 - 1;
      const left = b.x + Math.floor((b.w - bw) / 2);
      [...bigLabel].forEach((g, k) => DIGITS[g].forEach((row, rr) => [...row].forEach((ch, j) => {
        if (ch !== ' ') cv.put(left + k * 4 + j, y + rr, '█', tone);
      })));
      y += 5;
    }
    if (l) {
      if (l.led) led(cv, b.x, y, l.led);
      cv.text(b.x + (l.led ? 2 : 0), y, l.text, l.tone, b.w);
    }
    if (r) cv.text(b.x + b.w - r.text.length, y, r.text, r.tone, b.w);
    y++;
  });
  if (spark) sparkline(cv, b.x, y, b.w, fc.trend);
}

// Local wall clock, e.g. "Mon 02 Nov" and "12:57".
const two = (n) => String(n).padStart(2, '0');
export const clockTime = (now) => {
  const d = new Date(now);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
export const clockDate = (now) => {
  const d = new Date(now);
  return `${'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d.getDay()]} ${two(d.getDate())} ${
    'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getMonth()]}`;
};

// Synth-style display: big teal digits when there is room, else "Mon 02 Nov · 12:57" or just the time.
function clockModule(cv, b, data, now) {
  const time = clockTime(now);
  const date = clockDate(now);
  const glyph = (ch) => ch === ':' ? [' ', '█', ' ', '█', ' '] : DIGITS[ch];
  const bigW = 4 * 4 + 1 + 1;
  if (b.h >= 5 && b.w >= bigW + 2) {
    const left = b.x + Math.floor((b.w - bigW) / 2);
    const top = b.y + Math.floor((b.h - 5 - (b.h >= 6 ? 1 : 0)) / 2);
    let x = left;
    for (const ch of time) {
      const rows = glyph(ch);
      rows.forEach((row, r) => [...row].forEach((c, j) => {
        if (c !== ' ') cv.put(x + j, top + r, '█', gradient(0.5 + 0.5 * (x - left + j) / bigW));
      }));
      x += rows[0].length + 1;
    }
    if (b.h >= 6) cv.text(b.x + Math.floor((b.w - date.length) / 2), top + 5, date, DIM);
    return;
  }
  const full = `${date} · ${time}`;
  const lines = b.w >= full.length ? [full] : b.w >= date.length && b.h >= 2 ? [date, time] : [time];
  const top = b.y + Math.floor((b.h - lines.length) / 2);
  lines.forEach((line, i) => {
    const x = b.x + Math.max(0, Math.floor((b.w - line.length) / 2));
    cv.text(x, top + i, line, line === date ? DIM : gradient(0.9), b.w);
    if (line === full) cv.text(x + date.length + 3, top + i, time, gradient(0.9));
  });
}

// ---------- jira ----------

const JIRA_STATE = (issue) => /review|block/i.test(issue.status) ? 'review'
  : issue.category === 'indeterminate' ? 'progress' : 'todo';

export const jiraTitle = (jira) => jira.off ? 'JIRA · off'
  : `JIRA${jira.sprint ? ` · ${safeText(jira.sprint)}` : ''}${jira.stale ? ' · stale' : ''}`;

// Parse twg's stdout.json for a work item query (read-only).
export function parseJira(json) {
  const issues = (json?.data?.issues ?? []).map((i) => ({
    key: String(i.key ?? '?'), summary: String(i.summary ?? i.fields?.summary ?? '').trim(),
    status: String(i.status?.name ?? i.fields?.status?.name ?? ''),
    category: i.status?.statusCategory?.key ?? i.fields?.status?.statusCategory?.key ?? 'new',
  }));
  const sprints = (json?.data?.issues ?? []).flatMap((i) => i.customfield_10020 ?? i.fields?.customfield_10020 ?? i.sprint ?? []);
  const sprint = [sprints].flat().find((s) => s?.state === 'active')?.name ?? null;
  return { issues, sprint };
}

function jiraModule(cv, b, data) {
  const jira = data.jira;
  const issues = jira.issues ?? [];
  if (jira.off || (!issues.length && jira.stale)) {
    cv.text(b.x + Math.max(0, Math.floor((b.w - 10) / 2)), b.y + Math.floor((b.h - 1) / 2),
      jira.off ? 'jira: off' : 'jira: stale', jira.off ? DIM : AMBER, b.w);
    return;
  }
  if (!issues.length) {
    cv.text(b.x, b.y + Math.floor((b.h - 1) / 2), jira.loaded ? 'no open tickets' : 'loading…', DIM, b.w);
    return;
  }
  const counts = { todo: 0, progress: 0, review: 0 };
  for (const issue of issues) counts[JIRA_STATE(issue)]++;
  if (b.w < 22) {
    kvGrid(cv, b, [{ label: 'TODO', value: `${counts.todo}` }, { label: 'WIP', value: `${counts.progress}`, tone: JIRA_TONE.progress },
      { label: 'REV', value: `${counts.review}`, tone: counts.review ? AMBER : INK }]);
    return;
  }
  const rows = issues.length <= b.h ? issues.length : b.h - 1;
  const keyW = Math.min(10, Math.max(...issues.map((i) => i.key.length)));
  issues.slice(0, rows).forEach((issue, i) => {
    const state = JIRA_STATE(issue);
    const y = b.y + i;
    cv.put(b.x, y, state === 'todo' ? '○' : '●', JIRA_TONE[state]);
    cv.text(b.x + 2, y, safeText(issue.key), INK, keyW);
    const room = b.w - keyW - 3;
    let summary = safeText(issue.summary);
    if (summary.length > room) summary = `${summary.slice(0, Math.max(0, room - 1))}…`;
    cv.text(b.x + keyW + 3, y, summary, state === 'todo' ? DIM : INK, room);
  });
  if (issues.length > rows) {
    cv.text(b.x + 2, b.y + rows, `+${issues.length - rows} more · ${counts.progress} wip ${counts.review} rev`, DIM, b.w - 2);
  }
}

// Background poller: never blocks rendering; keeps the last good result and flags it stale on error.
export class JiraFeed {
  constructor({ run, interval = 300000 } = {}) {
    this.run = run ?? runTwg;
    this.interval = interval;
    this.state = { issues: [], sprint: null, loaded: false, stale: false, off: false };
    this.busy = null;
  }

  refresh() {
    this.busy ??= (async () => {
      try {
        Object.assign(this.state, await this.run(), { loaded: true, stale: false, off: false });
      } catch (error) {
        if (error.code === 'ENOENT' && !this.state.loaded) this.state.off = true;
        else this.state.stale = true;
      } finally {
        this.busy = null;
        this.onUpdate?.();
      }
    })();
    return this.busy;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), this.interval).unref();
    return this;
  }
}

const JQL = 'assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done ORDER BY priority DESC, updated DESC';

async function runTwg() {
  const candidates = [process.env.TWG_BIN, 'twg', process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'twg', 'bin', 'twg.exe')]
    .filter(Boolean);
  let lastError;
  for (const bin of candidates) {
    try {
      const { stdout } = await execute(bin, ['jira', 'workitem', 'query', '--jql', JQL,
        '--fields', 'key,summary,status,issuetype,priority,customfield_10020', '-n', '30', '-o', 'json'],
      { timeout: 90000, windowsHide: true, maxBuffer: 8 << 20 });
      const file = /stdout:\s*"([^"]+)"/.exec(stdout)?.[1]?.replace(/\\\\/g, '\\');
      return parseJira(JSON.parse(file ? await readFile(file, 'utf8') : stdout));
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}

// ---------- art modules ----------

const ART = ['OSC ∿', 'VCF', 'LFO', 'SEQ', 'ENV', 'MULT', 'VCA', 'VU', ''];
const KNOB_GLYPHS = '◐◓◑◒●';
const KNOB_NAMES = { VCF: ['CUT', 'RES', 'ENV', 'KEY'], VCA: ['GAIN', 'LVL', 'CV', 'PAN'] };

// Plot a function v(t) in [0,1] over the box with slope glyphs.
function plot(cv, b, f, tone, vertices = false) {
  let prev = null;
  for (let i = 0; i < b.w; i++) {
    const v = clamp(f(b.w > 1 ? i / (b.w - 1) : 0), 0, 1);
    const r = Math.round((1 - v) * (b.h - 1));
    const next = clamp(f(b.w > 1 ? (i + 1) / (b.w - 1) : 0), 0, 1);
    const slope = Math.round((1 - next) * (b.h - 1)) - r;
    const ch = slope < 0 ? '╱' : slope > 0 ? '╲' : vertices && prev !== null && prev !== r ? '•' : '─';
    cv.put(b.x + i, b.y + r, ch, tone(i));
    prev = r;
  }
}

function artModule(cv, b, kind, seed, now) {
  if (b.w <= 0 || b.h <= 0) return;
  const tone = (i) => slate(0.45 + 0.3 * i / Math.max(1, b.w - 1));
  const tick = Math.floor(now / 1000);
  if (kind === 'OSC ∿') {
    const mid = b.y + Math.floor(b.h / 2);
    if (b.h >= 3) for (let i = 0; i < b.w; i++) cv.put(b.x + i, mid, '┄', slate(0.15));
    const phase = now / 900 + seed;
    const cycles = 1 + seed % 2;
    for (let i = 0; i < b.w; i++) {
      const v = Math.sin(phase + i / Math.max(1, b.w) * cycles * 2 * Math.PI);
      cv.put(b.x + i, b.y + Math.round((1 - v) / 2 * (b.h - 1)), '•', tone(i));
    }
  } else if (kind === 'LFO') {
    const shift = (tick / 7 + seed % 5 / 5) % 1;
    plot(cv, b, (t) => 1 - Math.abs(((t * 2 + shift) % 2) - 1), tone);
  } else if (kind === 'ENV') {
    const a = 0.08 + seed % 4 * 0.05;
    const d = a + 0.1 + seed % 3 * 0.05;
    const s = 0.35 + seed % 5 * 0.1;
    const r = 0.62 + seed % 3 * 0.08;
    plot(cv, b, (t) => t < a ? t / a : t < d ? 1 - (t - a) / (d - a) * (1 - s) : t < r ? s
      : t < r + 0.2 ? s * (1 - (t - r) / 0.2) : 0, tone, true);
  } else if (kind === 'VCF' || kind === 'VCA') {
    const names = KNOB_NAMES[kind];
    const count = Math.min(names.length, Math.max(1, Math.floor((b.w + 1) / 5)));
    const left = b.x + Math.floor((b.w - (count * 5 - 1)) / 2);
    const top = b.y + Math.max(0, Math.floor((b.h - 3) / 2));
    for (let i = 0; i < count; i++) {
      const x = left + i * 5;
      cv.put(x + 1, top, KNOB_GLYPHS[(seed + i * 3 + Math.floor(tick / 30)) % 5], slate(0.5 + i * 0.1));
      if (b.h >= 2) cv.text(x, top + 1, names[i].slice(0, 4), DIM);
      if (b.h >= 3) cv.put(x + 1, top + 2, '◎', slate(0.3));
    }
  } else if (kind === 'SEQ') {
    const steps = Math.max(1, Math.min(16, Math.floor((b.w + 1) / 2)));
    const left = b.x + Math.floor((b.w - (steps * 2 - 1)) / 2);
    const active = Math.floor(now / 2000) % steps;
    for (let i = 0; i < steps; i++) {
      const lit = i === active || (seed >> i) % 4 === 0;
      cv.put(left + i * 2, b.y, cv.color || lit ? '●' : '○', i === active ? slate(1) : lit ? slate(0.7) : slate(0.2));
      for (let r = 1; r < b.h; r++) {
        const level = (hash(i, seed) >> (r * 3)) % 8;
        cv.put(left + i * 2, b.y + r, SPARK[level], slate(0.25 + level / 16));
      }
    }
  } else if (kind === 'VU') {
    const rows = Math.min(b.h, 3);
    const top = b.y + Math.floor((b.h - rows) / 2);
    for (let r = 0; r < rows; r++) {
      const level = 35 + 45 * Math.abs(Math.sin(now / 1300 + seed + r * 1.7));
      meter(cv, b.x, top + r, b.w, level, `${'LRM'[r]} `, slate(0.45));
    }
  } else if (kind === 'MULT') {
    const jacks = Math.max(1, Math.floor((b.w + 2) / 4));
    const left = b.x + Math.floor((b.w - (jacks * 4 - 3)) / 2);
    for (let i = 0; i < jacks; i++) cv.put(left + i * 4, b.y, '◎', slate(0.45));
    const cables = [slate(0.55), slate(0.75), slate(0.95)];
    for (let p = 0; p + 1 < jacks && b.h >= 2; p += 2) {
      const a = left + p * 4;
      const z = left + (p + 1) * 4 + (p + 2 < jacks && seed % 2 ? 4 : 0);
      const depth = Math.min(b.h - 1, 1 + (seed + p) % 2);
      const tint = cables[(seed + p) % cables.length];
      for (let r = 1; r < depth; r++) { cv.put(a, b.y + r, '│', tint); cv.put(z, b.y + r, '│', tint); }
      cv.put(a, b.y + depth, '╰', tint);
      for (let x = a + 1; x < z; x++) cv.put(x, b.y + depth, '─', tint);
      cv.put(z, b.y + depth, '╯', tint);
    }
  } else {
    const vw = Math.max(1, Math.floor(b.w / 2));
    for (let r = 0; r < b.h; r++) {
      if (r % 2 === b.h % 2) continue;
      for (let i = 0; i < vw; i++) cv.put(b.x + Math.floor((b.w - vw) / 2) + i, b.y + r, '┄', slate(0.15));
    }
  }
}

// ---------- layout ----------

// Tiny panes: the plan figure and bar on the first line, then the key numbers one per line.
function tinyView(cv, data, now) {
  const fc = data.forecast;
  planModule(cv, { x: 0, y: 0, w: cv.w, h: 1 }, data);
  const items = [
    { label: 'TIME', value: clockTime(now), tone: gradient(0.9) },
    { label: 'RST', value: fc ? `${fc.daysToReset}d` : '--' },
    ...(fc?.capAt ? [{ label: 'CAP', value: capDate(fc.capAt), tone: ALERT, state: 'alert' }] : []),
    { label: 'PACE', value: percent(fc?.pace) },
    { label: 'PROJ', value: percent(fc?.projected), tone: fc?.projected > 100 ? ALERT : INK },
    { label: 'AIC', value: compact(data.today) },
  ];
  if (data.remote !== undefined) items.push({ label: 'UBU', value: data.remote === null ? 'off' : compact(data.remote.credits) });
  if (data.jira?.issues?.length) items.push({ label: 'JIRA', value: `${data.jira.issues.length}` });
  if (data.agents?.length) {
    items.push({ label: 'AG', value: `${data.agents.length} ${percent(Math.max(...data.agents.map((a) => a.context ?? 0)))}` });
  }
  items.slice(0, cv.h - 1).forEach((item, i) => kv(cv, 0, i + 1, cv.w, item));
}

// Styles share data, the tiny fallback and the canvas; each one supplies its own frames, modules and fillers.
export const STYLES = ['synth-rack', 'cockpit', 'ledger', 'blueprint'];

export function render(data, width = 20, height = 40, now = Date.now(), { color = false, style = 'synth-rack' } = {}) {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const cv = new Canvas(width, height, color);
  if (width < 20 || height < 6) tinyView(cv, data, now);
  else ({ cockpit, ledger, blueprint }[style] ?? synthRack)(cv, data, now);
  return cv.toString();
}

// Synth-rack: modular grid of rack cells packed by priority, spare cells filled with decorative synth art.
function synthRack(cv, data, now) {
  const { w: width, h: height } = cv;
  const cols = Math.max(1, Math.floor(width / CELL_W));
  const rows = Math.max(1, Math.floor(height / CELL_H));
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.floor(i * width / cols));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.floor(i * height / rows));
  const cellH = height / rows;
  const fc = data.forecast;
  const agents = data.agents ?? [];
  const planW = cols <= 2 ? cols : clamp(Math.round(cols * 0.55), 2, cols - 1);
  const planH = rows >= 3 ? 2 : 1;
  const trendW = Math.min(3, cols - planW);
  const jiraRows = clamp(Math.ceil(((data.jira?.issues?.length ?? 0) + 2) / cellH), 1, Math.max(1, rows - planH));
  const agentRows = clamp(Math.ceil((agents.length + 2) / cellH), 1, rows);
  // TREND sits right next to PLAN (same row), or directly under it when PLAN spans the width.
  const risk = riskStatus(fc, data.today);
  const trendShapes = trendW > 0 ? [[trendW, planH, planW, 0], [trendW, 1, planW, 0]] : [[cols, rows >= 10 ? 2 : 1, 0, planH], [cols, 1, 0, planH], [cols, 1, 0, 1]];
  const modules = [
    { title: (w) => [`PLAN ${planLabel(data.plan)}${risk ? ` · ${risk}` : ''}`, `PLAN ${planLabel(data.plan).replace('USED ', '')}${risk ? ` ${risk}` : ''}`]
      .find((t) => t.length + 6 <= w) ?? `PLAN ${planLabel(data.plan)}`, draw: planModule, shapes: [[planW, planH], [planW, 1], [1, 1]] },
    { title: 'TREND', draw: trendModule, shapes: [...trendShapes, [1, 1]] },
    { id: 'clock', title: 'CLOCK', draw: clockModule, shapes: [[2, 1], [1, 1]] },
    ...(data.jira ? [{ title: jiraTitle(data.jira), draw: jiraModule,
      shapes: [[3, jiraRows], [2, jiraRows], [2, 1], [1, 1]] }] : []),
    ...(data.errors?.length ? [{ title: 'SYS', draw: sysModule, shapes: [[2, 1], [1, 1]] }] : []),
    { title: 'CYCLE', draw: cycleModule, shapes: [[2, 1], [1, 1]] },
    { title: 'TODAY', draw: todayModule, shapes: [[2, 1], [1, 1]] },
    ...(fc ? [{ title: 'FORECAST', draw: forecastModule, shapes: [[2, 2], [2, 1], [1, 2], [1, 1]] },
      { title: 'MODEL·CTX', draw: modelModule, shapes: [[2, 1], [1, 1]] }] : []),
    ...(agents.length ? [{ title: 'AGENTS', draw: agentsModule, shapes: [[2, agentRows], [2, 1], [1, agentRows], [1, 1]] }] : []),
  ];
  const used = Array.from({ length: rows }, () => Array(cols).fill(false));
  const free = (cx, cy, w, h) => {
    for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) if (y >= rows || x >= cols || used[y][x]) return false;
    return true;
  };
  const take = (cx, cy, w, h) => {
    for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) used[y][x] = true;
    return { x: xs[cx], y: ys[cy], w: xs[cx + w] - xs[cx], h: ys[cy + h] - ys[cy] };
  };
  const find = (w, h) => {
    for (let cy = 0; cy <= rows - h; cy++) for (let cx = 0; cx <= cols - w; cx++) if (free(cx, cy, w, h)) return [cx, cy];
    return null;
  };
  const placed = new Set();
  for (const module of modules) {
    for (const [w, h, ax, ay] of module.shapes) {
      const spot = w > cols || h > rows ? null : ax === undefined ? find(w, h) : free(ax, ay, w, h) ? [ax, ay] : null;
      if (!spot) continue;
      const box = take(spot[0], spot[1], w, h);
      module.draw(cv, frame(cv, box, typeof module.title === 'function' ? module.title(box.w) : module.title), data, now);
      placed.add(module.id ?? module.title);
      break;
    }
  }
  // No room for CLOCK: stamp HH:MM into the PLAN frame's bottom border so the time is always visible.
  if (!placed.has('clock')) {
    const stamp = ` ${clockTime(now)} `;
    const right = xs[planW] - 3;
    if (right - stamp.length >= 2) cv.text(right - stamp.length, ys[planH] - 1, stamp, gradient(0.9));
  }
  let previous = -1;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (used[cy][cx]) continue;
      const seed = hash(cx, cy);
      const w = seed % 3 && free(cx + 1, cy, 1, 1) ? 2 : 1;
      let kind = seed % ART.length;
      if (kind === previous) kind = (kind + 1) % ART.length;
      previous = kind;
      const box = take(cx, cy, w, 1);
      artModule(cv, frame(cv, box, ART[kind], true), ART[kind], seed % 97, now);
    }
  }
}

// ---------- shared style helpers ----------

// The numbers every style shows, computed once.
function facts(data, now) {
  const fc = data.forecast ?? null;
  const risk = riskStatus(fc, data.today);
  const used = finite(data.plan?.usedPercent) ? data.plan.usedPercent : fc?.used ?? null;
  const st = risk ? STATUS[risk] : null;
  const capTxt = fc?.capAt ? capDate(fc.capAt) : 'none';
  const detail = risk === 'RISK' ? [fc.capAt ? `cap ${capTxt}` : '', finite(fc.headroom) ? `${fc.headroom}d left` : ''].filter(Boolean).join(' · ')
    : risk === 'WATCH' ? `→ ${percent(fc.projected)}` : '';
  return {
    fc, risk, used, tone: st?.tone ?? INK, state: st?.state ?? null, mark: st?.mark ?? '', detail,
    rows: [
      { label: 'USED', value: data.plan?.expired || data.plan?.unlimited ? planLabel(data.plan) : percent(used) },
      { label: 'PACE', value: percent(fc?.pace), tone: AMBER },
      { label: 'PROJ', value: percent(fc?.projected), tone: !finite(fc?.projected) ? INK : fc.projected > 100 ? ALERT : fc.projected > fc.target ? AMBER : CALM },
      { label: 'CAP', value: capTxt, tone: fc?.capAt ? ALERT : INK },
      { label: 'TODAY', value: compact(data.today) },
      { label: 'BURN', value: compact(fc?.burn), tone: finite(fc?.burn) && finite(fc?.dailyTarget) && fc.burn > fc.dailyTarget ? AMBER : INK },
      { label: 'DAY', value: compact(fc?.dailyTarget) },
      { label: 'RESET', value: fc ? `${fc.daysToReset}d` : '--' },
    ],
  };
}

// Label left, value right-aligned; the value always wins over the label.
function row(cv, x, y, w, label, value, lt = DIM, vt = INK) {
  value = String(value).slice(0, w);
  cv.text(x, y, label, lt, Math.max(0, w - value.length - 1));
  cv.text(x + w - value.length, y, value, vt);
}

// Stack sections top-down; two columns when the pane is wide. A section is skipped when < min rows remain.
function flow(cv, sections, { top = 0, bottom = cv.h, gap = 0, split = 70 } = {}) {
  const n = cv.w >= split ? 2 : 1;
  const colW = Math.floor(cv.w / n);
  const ys = Array(n).fill(top);
  for (const s of sections) {
    const c = ys.indexOf(Math.min(...ys));
    const avail = bottom - ys[c];
    if (avail < s.min) continue;
    const h = Math.min(s.max ?? s.min, avail);
    const x = c * colW;
    s.draw({ x, y: ys[c], w: c === n - 1 ? cv.w - x : colW, h });
    ys[c] += h + gap;
  }
}

function issueRows(cv, b, data, dense = false) {
  const issues = data.jira?.issues ?? [];
  issues.slice(0, b.h).forEach((issue, i) => {
    const key = safeText(issue.key);
    cv.put(b.x, b.y + i, issue.state === 'todo' ? '○' : '●', JIRA_TONE[issue.state] ?? DIM);
    cv.text(b.x + 2, b.y + i, key, INK, b.w - 2);
    cv.text(b.x + 3 + key.length, b.y + i, safeText(issue.summary), issue.state === 'todo' || dense ? DIM : INK, Math.max(0, b.w - key.length - 3));
  });
}

function agentRows(cv, b, data) {
  (data.agents ?? []).slice(0, b.h).forEach((a, i) => row(cv, b.x, b.y + i, b.w, safeText(a.label ?? '?'), percent(a.context), a.ubuntu ? UBUNTU : DIM));
}

const jiraHead = (data) => data.jira ? (data.jira.off ? 'JIRA off' : data.jira.stale ? 'JIRA stale' : `JIRA ${data.jira.issues?.length ?? 0}`) : '';

// ---------- cockpit style ----------
// Glass cockpit: annunciator strip, semicircular dials, a horizon tape for the daily burn, dense readouts.

function annunciators(cv, b, f, data) {
  const lamps = [['OK', f.risk === 'OK', CALM], ['WATCH', f.risk === 'WATCH', AMBER], ['RISK', f.risk === 'RISK', ALERT],
    ['CAP', !!f.fc?.capAt, ALERT], ['SYNC', !!data.errors?.length, AMBER], ['JIRA', !!data.jira?.stale || !!data.jira?.off, AMBER]];
  const n = clamp(Math.floor(b.w / 7), 3, lamps.length);
  for (let i = 0; i < n; i++) {
    const x0 = b.x + Math.floor(i * b.w / n);
    const w = b.x + Math.floor((i + 1) * b.w / n) - x0;
    const [name, lit, tone] = lamps[i];
    const label = cv.color ? name : lit ? `[${name}]` : name.toLowerCase();
    for (let x = x0; x < x0 + w - 1; x++) cv.put(x, b.y, ' ', null, lit ? tone : TRACK);
    cv.text(x0 + Math.max(0, Math.floor((w - 1 - label.length) / 2)), b.y, label, lit ? INK_ON_FILL : DIM, w - 1);
    for (let x = x0; x < x0 + w - 1 && cv.color; x++) cv.cells[b.y][x].bg = lit ? tone : TRACK;
  }
}

function gauge(cv, b, value, max, label, marks = []) {
  const R = Math.max(1, Math.min(Math.floor((b.w - 1) / 4), b.h - 2));
  const cx = b.x + Math.floor(b.w / 2);
  const cy = b.y + R;
  const at = (v, r = R) => {
    const th = Math.PI * (1 - clamp(v / max, 0, 1));
    return [Math.round(cx + Math.cos(th) * r * 2), Math.round(cy - Math.sin(th) * r)];
  };
  const steps = R * 12;
  for (let i = 0; i <= steps; i++) {
    const v = i / steps * max;
    const lit = finite(value) && v <= value;
    const [x, y] = at(v);
    cv.put(x, y, lit ? '█' : '░', lit ? gradient(0.3 + 0.65 * i / steps) : TRACK);
  }
  for (const [v, ch, tone] of marks) if (finite(v)) cv.put(...at(v), ch, tone);
  if (finite(value)) {
    for (let r = 1; r < R; r++) {
      const [x, y] = at(Math.min(value, max), r);
      cv.put(x, y, '·', INK);
    }
  }
  const txt = percent(value);
  cv.text(cx - Math.floor(txt.length / 2), cy, txt, INK);
  if (b.h > R + 1) cv.text(cx - Math.floor(label.length / 2), cy + 1, label, DIM);
}

function horizon(cv, b, fc) {
  const ref = finite(fc?.dailyTarget) && fc.dailyTarget > 0 ? fc.dailyTarget : (fc?.trend?.reduce((a, v) => a + v, 0) / 14) || 1;
  const days = (fc?.trend ?? []).slice(-Math.max(1, b.w - 6));
  const mid = b.y + Math.floor(b.h / 2);
  cv.text(b.x, mid, 'HZN', DIM);
  const left = b.x + b.w - days.length;
  for (let x = b.x + 4; x < b.x + b.w; x++) cv.put(x, mid, '─', RULE === BG ? DIM : DIM);
  days.forEach((v, i) => {
    const d = v / ref;
    if (d >= 1) {
      const up = Math.min(mid - b.y, Math.max(1, Math.round((d - 1) * 2)));
      for (let k = 1; k <= up; k++) cv.put(left + i, mid - k, k === up ? '▄' : '█', d > 1.5 ? ALERT : AMBER);
      cv.put(left + i, mid, '┴', AMBER);
    } else {
      const down = Math.min(b.y + b.h - 1 - mid, v > 0 ? 1 : 0);
      for (let k = 1; k <= down; k++) cv.put(left + i, mid + k, '▀', CALM);
      cv.put(left + i, mid, v > 0 ? '┬' : '─', v > 0 ? CALM : DIM);
    }
  });
}

function cockpit(cv, data, now) {
  cv.fill(0, 0, cv.w, cv.h, BG);
  const f = facts(data, now);
  const head = `${f.mark ? `${f.mark} ` : ''}${f.risk ?? '--'} ${f.detail}`.trim();
  row(cv, 0, 0, cv.w, head, clockTime(now), f.tone, gradient(0.9));
  annunciators(cv, { x: 0, y: 1, w: cv.w, h: 1 }, f, data);
  const dialH = (w) => Math.min(Math.floor((w - 1) / 4), 5) + 2;
  flow(cv, [
    { min: 4, max: dialH(cv.w >= 70 ? Math.floor(cv.w / 2) : cv.w), draw: (b) => gauge(cv, b, f.used, 100, 'PLAN · pace ◆',
      [[f.fc?.pace, '◆', AMBER]]) },
    ...(f.fc ? [{ min: 4, max: dialH(cv.w >= 70 ? Math.floor(cv.w / 2) : cv.w), draw: (b) => gauge(cv, b, f.fc.projected, 200, 'PROJ /200 · 100 ◆',
      [[100, '◆', AMBER]]) }] : []),
    { min: 3, max: 5, draw: (b) => horizon(cv, { ...b, y: b.y, h: b.h }, f.fc) },
    { min: 2, max: 4, draw: (b) => {
      const half = b.w >= 24 ? Math.floor(b.w / 2) : b.w;
      f.rows.slice(1).forEach((r, i) => {
        const per = b.w >= 24 ? 2 : 1;
        const y = b.y + Math.floor(i / per);
        if (y < b.y + b.h) row(cv, b.x + (i % per) * half, y, half - (per > 1 ? 1 : 0), r.label, r.value, DIM, r.tone ?? INK);
      });
    } },
    ...(data.jira ? [{ min: 2, max: 2 + Math.min(8, data.jira.issues?.length ?? 0), draw: (b) => {
      row(cv, b.x, b.y, b.w, jiraHead(data), '', gradient(0.9));
      issueRows(cv, { ...b, y: b.y + 1, h: b.h - 1 }, data, true);
    } }] : []),
    ...(data.agents?.length ? [{ min: 2, max: 1 + data.agents.length, draw: (b) => {
      row(cv, b.x, b.y, b.w, 'CTX', `${data.agents.length}`, gradient(0.9));
      agentRows(cv, { ...b, y: b.y + 1, h: b.h - 1 }, data);
    } }] : []),
  ], { top: 2, gap: 0 });
}

// ---------- ledger style ----------
// Statement layout: thin rules, right-aligned figures, no boxes or art. Reads well in narrow panes.

function ledger(cv, data, now) {
  const f = facts(data, now);
  const w = cv.w;
  let y = 0;
  const rule = (ch = '─') => { if (y < cv.h) cv.text(0, y++, ch.repeat(w), DIM); };
  row(cv, 0, y++, w, `${f.mark ? `${f.mark} ` : ''}${f.risk ?? '--'} ${f.detail}`.trim(), clockTime(now), f.tone, gradient(0.9));
  if (y < cv.h) row(cv, 0, y++, w, 'COPILOT BUDGET', clockDate(now), INK, DIM);
  rule('═');
  const per = w >= 56 ? 2 : 1;
  const colW = Math.floor((w - (per - 1) * 3) / per);
  for (let i = 0; i < f.rows.length && y < cv.h; i += per) {
    for (let c = 0; c < per && i + c < f.rows.length; c++) {
      const r = f.rows[i + c];
      row(cv, c * (colW + 3), y, colW, r.label, r.value, DIM, r.tone ?? INK);
      if (c) cv.put(c * (colW + 3) - 2, y, '│', DIM);
    }
    y++;
  }
  rule();
  if (f.fc && y < cv.h) sparkline(cv, 0, y++, w, f.fc.trend, '14d');
  if (data.jira && y + 1 < cv.h) {
    rule();
    row(cv, 0, y++, w, jiraHead(data), '', INK);
    const n = Math.min(data.jira.issues?.length ?? 0, cv.h - y);
    issueRows(cv, { x: 0, y, w, h: n }, data);
    y += n;
  }
  if (data.agents?.length && y + 1 < cv.h) {
    rule();
    const n = Math.min(data.agents.length, cv.h - y);
    agentRows(cv, { x: 0, y, w, h: n }, data);
    y += n;
  }
  if (data.errors?.length && y < cv.h) cv.text(0, cv.h - 1, safeText(data.errors[0]), AMBER, w);
}

// ---------- blueprint style ----------
// Technical drawing: thin single-line frames, dimension lines for the figures, dot-grid paper, title block.

function thinFrame(cv, b, title) {
  const tone = DIM;
  for (let x = b.x; x < b.x + b.w; x++) { cv.put(x, b.y, '─', tone); cv.put(x, b.y + b.h - 1, '─', tone); }
  for (let y = b.y; y < b.y + b.h; y++) { cv.put(b.x, y, '│', tone); cv.put(b.x + b.w - 1, y, '│', tone); }
  for (let y = b.y + 1; y < b.y + b.h - 1; y++) for (let x = b.x + 1; x < b.x + b.w - 1; x++) cv.put(x, y, ' ');
  cv.put(b.x, b.y, '┌', tone); cv.put(b.x + b.w - 1, b.y, '┐', tone);
  cv.put(b.x, b.y + b.h - 1, '└', tone); cv.put(b.x + b.w - 1, b.y + b.h - 1, '┘', tone);
  if (title && b.w >= title.length + 4) cv.text(b.x + 2, b.y, title, INK);
  return { x: b.x + 2, y: b.y + 1, w: b.w - 4, h: b.h - 2 };
}

// ├── 26.7% ──┤ spanning `len` cells from x.
function dimension(cv, x, y, len, label, tone) {
  if (len < 2) {
    cv.put(x, y, '┤', tone);
    return cv.text(x + 2, y, label, INK);
  }
  for (let i = 0; i < len; i++) cv.put(x + i, y, '─', tone);
  cv.put(x, y, '├', tone);
  cv.put(x + len - 1, y, '┤', tone);
  const text = ` ${label} `;
  if (text.length <= len - 2) cv.text(x + Math.floor((len - text.length) / 2), y, text, INK);
  else cv.text(x + len + 1, y, label, INK);
}

function blueprint(cv, data, now) {
  const f = facts(data, now);
  cv.fill(0, 0, cv.w, cv.h, BG);
  for (let y = 2; y < cv.h; y += 2) for (let x = 0; x < cv.w; x += 4) cv.put(x, y, '·', TRACK);
  const head = `${f.mark ? `${f.mark} ` : ''}${f.risk ?? '--'} ${f.detail}`.trim();
  row(cv, 0, 0, cv.w, head, clockTime(now), f.tone, gradient(0.9));
  const tbW = Math.min(cv.w, 28);
  const tbH = cv.h >= 18 ? 7 : 0;
  flow(cv, [
    { min: 5, max: 6, draw: (b) => {
      const inner = thinFrame(cv, b, 'PLAN');
      const scale = Math.max(100, finite(f.fc?.projected) ? f.fc.projected : 0);
      const len = (v) => Math.max(1, Math.round(clamp(v, 0, scale) / scale * (inner.w - 8)));
      const lines = [['USED', f.used, CALM], ['PACE', f.fc?.pace, AMBER], ['PROJ', f.fc?.projected, f.fc?.projected > 100 ? ALERT : CALM]];
      lines.slice(0, inner.h - 1).forEach(([name, v, tone], i) => {
        cv.text(inner.x, inner.y + i, name, DIM);
        if (finite(v)) dimension(cv, inner.x + 5, inner.y + i, len(v), percent(v), tone);
        else cv.text(inner.x + 5, inner.y + i, '--', DIM);
      });
      const y = inner.y + Math.min(3, inner.h - 1);
      const x100 = inner.x + 5 + len(100) - 1;
      for (let x = inner.x + 5; x < inner.x + inner.w; x++) cv.put(x, y, '┈', DIM);
      cv.put(inner.x + 5, y, '0', DIM);
      if (x100 < inner.x + inner.w) cv.put(x100, y, '┬', INK);
      if (x100 + 4 < inner.x + inner.w) cv.text(x100 + 1, y, '100', DIM);
    } },
    ...(f.fc ? [{ min: 4, max: 4, draw: (b) => {
      const inner = thinFrame(cv, b, 'TREND');
      sparkline(cv, inner.x, inner.y, inner.w, f.fc.trend, '14d');
      if (inner.h > 1) row(cv, inner.x, inner.y + 1, inner.w, `→ ${percent(f.fc.projected)}`, f.fc.capAt ? `cap ${capDate(f.fc.capAt)}` : 'no cap', f.rows[2].tone, f.fc.capAt ? ALERT : DIM);
    } }] : []),
    { min: 4, max: 6, draw: (b) => {
      const inner = thinFrame(cv, b, 'BURN');
      f.rows.slice(4, 4 + inner.h).forEach((r, i) => row(cv, inner.x, inner.y + i, inner.w, r.label, r.value, DIM, r.tone ?? INK));
    } },
    ...(data.jira ? [{ min: 3, max: 2 + Math.min(8, Math.max(1, data.jira.issues?.length ?? 0)), draw: (b) => {
      issueRows(cv, thinFrame(cv, b, jiraHead(data)), data);
    } }] : []),
    ...(data.agents?.length ? [{ min: 3, max: 2 + data.agents.length, draw: (b) => agentRows(cv, thinFrame(cv, b, 'AGENTS'), data) }] : []),
  ], { top: 1, bottom: cv.h - tbH });
  if (tbH) {
    const b = { x: cv.w - tbW, y: cv.h - tbH, w: tbW, h: tbH };
    const inner = thinFrame(cv, b, 'TITLE BLOCK');
    [['DWG', 'COPILOT BUDGET'], ['DATE', `${clockDate(now)} ${clockTime(now)}`], ['RESET', f.rows[7].value],
      ['GRADE', f.fc?.grade ?? '--'], ['STATUS', f.risk ?? '--']]
      .slice(0, inner.h).forEach(([k, v], i) => row(cv, inner.x, inner.y + i, inner.w, k, v, DIM, k === 'STATUS' ? f.tone : INK));
    for (let y = inner.y; y < inner.y + inner.h && inner.w > 10; y++) cv.put(inner.x + 6, y, '│', DIM);
  }
}

// ---------- collection ----------

// One short line for a tuios dock cell: "AIC 42% →198% RISK".
export function dockLine(data) {
  const used = data?.plan?.usedPercent;
  if (!finite(used)) return 'AIC --';
  const fc = data.forecast;
  const status = riskStatus(fc, data.today);
  return ['AIC ' + Math.round(used) + '%', finite(fc?.projected) ? '→' + Math.round(fc.projected) + '%' : '',
    status && status !== 'OK' ? status : ''].filter(Boolean).join(' ');
}

export async function collect(telemetry, { now = Date.now(), remoteFile = process.env.BUDGET_REMOTE,
  target = Number(process.env.BUDGET_TARGET) || 100, jira } = {}) {
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
    ...(Array.isArray(remote?.agents) ? remote.agents : []).map((a) => ({ label: String(a.label).slice(0, 12).trimEnd(), context: a.percent, ubuntu: true })),
  ];
  return { plan, today, remote, agents, forecast: forecast({ plan, history, now, target }), errors,
    ...(jira ? { jira: { ...jira } } : {}) };
}

// Settings: <COPILOT_HOME>/copilot-budget.json (or BUDGET_CONFIG), overridden by environment variables,
// so the plugin manifest can start the pane without a wrapper setting env vars.
// Panel palette from themes/<name>/theme.json "panel"; unknown or unreadable themes fall back to zen.
export async function themePalette(name, dir) {
  try {
    return JSON.parse(await readFile(join(dir, name, 'theme.json'), 'utf8')).panel ?? {};
  } catch {
    return {};
  }
}

export async function loadSettings(env = process.env, home = env.COPILOT_HOME || join(homedir(), '.copilot')) {
  let file = {};
  try {
    file = JSON.parse(await readFile(env.BUDGET_CONFIG || join(home, 'copilot-budget.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`config: ${error.message}`);
  }
  const pick = (key, name) => env[name] !== undefined && env[name] !== '' ? env[name] : file[key];
  return {
    home,
    remote: pick('remote', 'BUDGET_REMOTE') || undefined,
    target: Number(pick('target', 'BUDGET_TARGET')) || 100,
    jira: String(pick('jira', 'BUDGET_JIRA') ?? '1') !== '0' && pick('jira', 'BUDGET_JIRA') !== false,
    refreshMs: Number(pick('refreshMs', 'BUDGET_REFRESH_MS')) || 30000,
    session: pick('session', 'TUIOS_SESSION') || env.TUIOS_PLUGIN_SESSION,
    export: pick('export', 'BUDGET_EXPORT') || undefined,
    theme: pick('theme', 'BUDGET_THEME') || 'zen',
    style: STYLES.includes(pick('style', 'BUDGET_STYLE')) ? pick('style', 'BUDGET_STYLE') : 'synth-rack',
    themesDir: pick('themesDir', 'BUDGET_THEMES_DIR') || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'themes'),
  };
}

// Terminal size with change notification. Public path: 'resize' events (SIGWINCH). ConPTY hosts do
// not always deliver those, so when the stream offers a refresh hook (Node's tty _refreshSize, feature
// detected and disabled after the first failure) it is polled as well. Without it, events only.
export function sizeSource(stream, { onChange, interval = 250, refresh = typeof stream._refreshSize === 'function'
  ? () => stream._refreshSize() : null } = {}) {
  const read = () => [stream.columns || 20, stream.rows || 40];
  let last = read().join('x');
  const check = () => {
    if (refresh) {
      try {
        refresh();
      } catch {
        refresh = null;
      }
    }
    const now = read().join('x');
    if (now !== last) {
      last = now;
      onChange?.(read());
    }
  };
  stream.on?.('resize', check);
  const timer = refresh ? setInterval(check, interval) : null;
  timer?.unref?.();
  return { get: () => (check(), read()), stop: () => { clearInterval(timer); stream.off?.('resize', check); }, polling: () => !!refresh };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => !['--once', '--json', '--dock'].includes(a))) throw new Error('Usage: node budget.mjs [--once] [--json|--dock]');
  const settings = await loadSettings();
  if (settings.session) process.env.TUIOS_SESSION ??= settings.session;
  const telemetry = new Telemetry(settings.home);
  const options = { remoteFile: settings.remote, target: settings.target };
  const feed = settings.jira ? new JiraFeed() : null;
  if (args.includes('--dock')) return console.log(dockLine(await collect(telemetry, options)));
  if (args.includes('--json')) {
    await feed?.refresh();
    return console.log(JSON.stringify(await collect(telemetry, { ...options, jira: feed?.state }), null, 2));
  }
  const interactive = process.stdout.isTTY && !args.includes('--once');
  let data = { plan: null, agents: [], errors: ['loading'] };
  if (feed && !interactive) await feed.refresh();
  // Every draw re-packs the grid from the current size; a size change also clears the screen.
  let drawnSize = '';
  let style = settings.style;
  let redraw = () => {};
  const size = sizeSource(process.stdout, { onChange: () => redraw() });
  const draw = () => {
    const [width, height] = size.get();
    const view = render(data, width, height, Date.now(), { color: interactive && !Object.hasOwn(process.env, 'NO_COLOR'), style });
    if (!interactive) return process.stdout.write(`${view}\n`);
    const clear = `${width}x${height}` !== drawnSize ? '\x1b[2J' : '';
    drawnSize = `${width}x${height}`;
    // Rows are always exactly full width, so no EL/ED: after the last column the cursor sits in
    // the pending-wrap state and an erase there would wipe the right border.
    process.stdout.write(`${clear}\x1b[H${view.split('\n').join('\r\n')}`);
  };
  if (interactive) {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.once('exit', () => process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l'));
    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));
    let pending = null;
    redraw = () => {
      clearTimeout(pending);
      pending = globalThis.setTimeout(draw, 50);
    };
    if (feed) {
      feed.onUpdate = () => {
        data = { ...data, jira: { ...feed.state } };
        redraw();
      };
      feed.start();
    }
    // Keep the clock minute-accurate independently of the data refresh.
    const tick = () => globalThis.setTimeout(() => {
      draw();
      tick();
    }, 60000 - Date.now() % 60000 + 50).unref();
    tick();
  }
  let themeKey = '';
  do {
    // Re-read settings each refresh so "themes/apply" switches the palette without a restart.
    const live = await loadSettings().catch(() => settings);
    if (`${live.themesDir}|${live.theme}` !== themeKey) {
      themeKey = `${live.themesDir}|${live.theme}`;
      setPalette(await themePalette(live.theme, live.themesDir));
    }
    if (live.style !== style) {
      style = live.style;
      drawnSize = '';
    }
    try {
      data = await collect(telemetry, { ...options, jira: feed?.state });
    } catch (error) {
      data = { ...data, errors: [error.message] };
    }
    draw();
    // Snapshot for consumers without Node (Ubuntu container budget.py); atomic so readers never see half a file.
    if (settings.export && data.plan) {
      await writeFile(settings.export + '.tmp', JSON.stringify({ ...data, at: new Date().toISOString() }))
        .then(() => rename(settings.export + '.tmp', settings.export)).catch(() => {});
    }
    if (interactive) await setTimeout(settings.refreshMs);
  } while (interactive);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`copilot-budget: ${error.message}`);
    process.exitCode = 1;
  });
}
