// tuibox theme packages: themes/<name>/theme.json + windows.json + ubuntu.json (tuios theme files).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEMES_DIR = dirname(fileURLToPath(import.meta.url));
const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white'];
const PANEL = ['gradient', 'slate', 'bg', 'track', 'rule', 'ink', 'inkOnFill', 'dim', 'watch', 'risk', 'ubuntu'];

export const listThemes = (dir = THEMES_DIR) => readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'theme.json'))).map((d) => d.name).sort();

export function loadTheme(name, dir = THEMES_DIR) {
  const base = join(dir, name);
  const manifest = JSON.parse(readFileSync(join(base, 'theme.json'), 'utf8'));
  const read = (file) => JSON.parse(readFileSync(join(base, file), 'utf8'));
  return { ...manifest, windowsTheme: read(manifest.windows.tuios), ubuntuTheme: read(manifest.ubuntu.tuios) };
}

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Pairs checked per theme: body text >= 7:1, dim text >= 4.5:1.
export function contrastReport(theme) {
  const rows = [];
  for (const [variant, t] of [['windows', theme.windowsTheme], ['ubuntu', theme.ubuntuTheme]]) {
    rows.push({ variant, pair: 'fg/bg', ratio: contrast(t.fg, t.bg), min: 7 });
    rows.push({ variant, pair: 'dim(bright_black)/bg', ratio: contrast(t.bright_black, t.bg), min: 4.5 });
  }
  const p = theme.panel ?? {};
  if (p.ink) rows.push({ variant: 'panel', pair: 'ink/bg', ratio: contrast(p.ink, p.bg), min: 7 });
  if (p.dim) rows.push({ variant: 'panel', pair: 'dim/bg', ratio: contrast(p.dim, p.bg), min: 4.5 });
  return rows;
}

export function validateTheme(theme) {
  const errors = [];
  const hex = (v, where) => { if (!HEX.test(String(v))) errors.push(`${where}: not #RRGGBB (${v})`); };
  if (!/^[a-z][a-z0-9-]*$/.test(theme.name ?? '')) errors.push('name: lowercase id required');
  for (const variant of ['windows', 'ubuntu']) {
    const v = theme[variant];
    if (!v?.tuios || !v.wtScheme) { errors.push(`${variant}: tuios file and wtScheme required`); continue; }
    const grad = String(v.borders?.border_focused_gradient ?? '').split(/\s+/);
    if (grad.length < 2) errors.push(`${variant}.borders.border_focused_gradient: >= 2 colours`);
    grad.forEach((c) => hex(c, `${variant}.borders.border_focused_gradient`));
    hex(v.borders?.border_unfocused_color, `${variant}.borders.border_unfocused_color`);
    const t = theme[`${variant}Theme`];
    if (t?.id !== theme.name) errors.push(`${variant} tuios theme id must be "${theme.name}"`);
    for (const k of ['fg', 'bg', 'cursor', ...ANSI, ...ANSI.map((a) => `bright_${a}`)]) hex(t?.[k], `${variant}.${k}`);
  }
  const p = theme.panel ?? {};
  for (const k of Object.keys(p)) if (!PANEL.includes(k) && k !== 'gradientAt') errors.push(`panel.${k}: unknown key`);
  for (const k of PANEL) {
    if (p[k] === undefined) continue;
    (Array.isArray(p[k]) ? p[k] : [p[k]]).forEach((c) => hex(c, `panel.${k}`));
  }
  if (p.gradient && p.gradient.length < 2) errors.push('panel.gradient: >= 2 stops');
  if (p.slate && p.slate.length !== 2) errors.push('panel.slate: exactly 2 colours');
  if (theme.windows?.borders?.border_focused_gradient && theme.windows.borders.border_focused_gradient
    === theme.ubuntu?.borders?.border_focused_gradient) errors.push('windows and ubuntu borders must differ');
  if (theme.windowsTheme?.bg && theme.windowsTheme.bg === theme.ubuntuTheme?.bg) errors.push('windows and ubuntu bg must differ');
  for (const r of contrastReport(theme)) {
    if (r.ratio < r.min) errors.push(`contrast ${r.variant} ${r.pair} ${r.ratio.toFixed(2)} < ${r.min}`);
  }
  return errors;
}

// Windows Terminal scheme from a tuios theme file.
export function wtScheme(name, t) {
  const s = { name, background: t.bg, foreground: t.fg, cursorColor: t.cursor, selectionBackground: t.black };
  for (const k of ANSI) {
    s[k] = t[k];
    s[`bright${k[0].toUpperCase()}${k.slice(1)}`] = t[`bright_${k}`];
  }
  return s;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'list') console.log(listThemes().join('\n'));
  else if (cmd === 'wt') {
    const t = loadTheme(name);
    console.log(JSON.stringify([wtScheme(t.windows.wtScheme, t.windowsTheme), wtScheme(t.ubuntu.wtScheme, t.ubuntuTheme)], null, 2));
  } else if (cmd === 'report') {
    for (const n of listThemes()) {
      for (const r of contrastReport(loadTheme(n))) console.log(`${n}\t${r.variant}\t${r.pair}\t${r.ratio.toFixed(2)}\t${r.ratio >= r.min ? 'ok' : 'FAIL'}`);
    }
  } else {
    console.error('Usage: node themes.mjs list | wt <name> | report');
    process.exitCode = 2;
  }
}
