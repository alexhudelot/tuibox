import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './budget.mjs';
const data = { plan: { usedPercent: 50 }, forecast: null, extras: null };
test('bar fills left to right', () => {
  const row = render(data, 20, 1).split('\n')[0];
  assert.equal(row.length, 20);
  assert.equal(row[0], '█');
  assert.equal(row[19], '·');
});
test('render honours height', () => {
  for (const h of [1, 5, 12]) assert.equal(render(data, 20, h).split('\n').length, h);
});
