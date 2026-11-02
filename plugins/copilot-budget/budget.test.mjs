import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './budget.mjs';

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
    assert.match(text, /PLAN USED 57%/);
    assert.ok(text.includes('█'), 'big numerals or bar');
  }
  assert.match(render(full, 40, 6, 0), /57%/);
});

test('tiny panes fall back to a compact view', () => {
  const lines = render(full, 12, 3, 0).split('\n');
  assert.ok(lines[0].startsWith('57% '));
  assert.match(lines[1], /RST/);
  assert.equal(render(data, 20, 1, 0).split('\n')[0].trimEnd().at(-1), '·');
});

test('art modules fill otherwise empty space on a large pane', () => {
  const lines = render(data, 132, 50, 0).split('\n');
  for (const line of lines) assert.ok(line.trim(), 'no blank row');
  for (let x = 0; x < 132; x++) assert.ok(lines.some((l) => l[x] !== ' '), `column ${x} not blank`);
  assert.match(lines.join('\n'), /OSC|VCF|LFO|SEQ|ENV|MULT|VCA|VU/);
});
