import assert from 'node:assert/strict';
import test from 'node:test';
import { contrast, contrastReport, listThemes, loadTheme, validateTheme, wtScheme } from './themes.mjs';

test('contrast: WCAG reference values', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrast('#767676', '#FFFFFF') - 4.54) < 0.01);
});

test('every theme package is valid, distinguishable and meets contrast minimums', () => {
  const names = listThemes();
  assert.ok(['zen', 'nocturne', 'ember', 'mono'].every((n) => names.includes(n)), names.join());
  assert.deepEqual(names.filter((n) => loadTheme(n).default), ['zen']);
  for (const name of names) {
    const theme = loadTheme(name);
    assert.deepEqual(validateTheme(theme), [], name);
    assert.ok(contrastReport(theme).length >= 6, name);
  }
});

test('validateTheme catches bad manifests', () => {
  const good = loadTheme('zen');
  const bad = structuredClone(good);
  bad.windowsTheme.fg = bad.windowsTheme.bg;
  bad.ubuntu.borders = { ...good.windows.borders };
  bad.panel.dim = 'teal';
  bad.panel.extra = '#000000';
  const errors = validateTheme(bad).join('\n');
  assert.match(errors, /contrast windows fg\/bg/);
  assert.match(errors, /borders must differ/);
  assert.match(errors, /panel\.dim: not #RRGGBB/);
  assert.match(errors, /panel\.extra: unknown key/);
});

test('wtScheme maps tuios keys to Windows Terminal keys', () => {
  const t = loadTheme('mono');
  const s = wtScheme('Mono', t.windowsTheme);
  assert.equal(s.background, t.windowsTheme.bg);
  assert.equal(s.brightBlack, t.windowsTheme.bright_black);
  assert.equal(Object.keys(s).length, 21);
});
