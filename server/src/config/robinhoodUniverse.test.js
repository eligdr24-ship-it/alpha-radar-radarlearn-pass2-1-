import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRobinhoodUniverse, isRobinhood, categoryOf, ROBINHOOD_SYMBOLS, CATEGORIES } from './robinhoodUniverse.js';

test('all 31 listed coins are present and uniquely categorized', () => {
  assert.equal(ROBINHOOD_SYMBOLS.length, 31);
  assert.equal(new Set(ROBINHOOD_SYMBOLS).size, 31);
  for (const s of ROBINHOOD_SYMBOLS) assert.ok(CATEGORIES.includes(categoryOf(s)), `${s} -> valid category`);
});

test('isRobinhood / categoryOf', () => {
  assert.equal(isRobinhood('btc'), true);
  assert.equal(isRobinhood('WIF'), false);     // not on Robinhood list
  assert.equal(categoryOf('BTC'), 'Store of Value');
  assert.equal(categoryOf('ARB'), 'Layer 2');
  assert.equal(categoryOf('NOTACOIN'), 'Other');
});

test('applyRobinhoodUniverse filters non-listed + tags category', () => {
  const input = [{ symbol: 'BTC' }, { symbol: 'WIF' }, { symbol: 'SEI' }, { symbol: 'ARB' }];
  const out = applyRobinhoodUniverse(input, { only: true });
  assert.deepEqual(out.map((c) => c.symbol).sort(), ['ARB', 'BTC']);
  assert.equal(out.find((c) => c.symbol === 'ARB').category, 'Layer 2');
});

test('only:false tags category without filtering', () => {
  const out = applyRobinhoodUniverse([{ symbol: 'WIF' }], { only: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'Other');
});
