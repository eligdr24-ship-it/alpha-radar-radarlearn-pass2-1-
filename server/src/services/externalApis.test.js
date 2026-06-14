import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStooqQuotes } from './externalApis.js';

test('parseStooqQuotes parses live macro CSV with open→close change', () => {
  const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
    'XAUUSD,2026-06-13,22:00:00,2900,2980,2890,2958,0\n' +
    '^VIX,2026-06-13,22:00:00,14.0,14.5,13.5,13.6,0';
  const rows = parseStooqQuotes(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'XAUUSD');
  assert.equal(rows[0].value, 2958);
  assert.equal(rows[0].change, 2); // (2958-2900)/2900*100 = 2.0
  assert.equal(rows[1].symbol, '^VIX');
});

test('parseStooqQuotes skips N/D rows', () => {
  const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^DXY,N/D,N/D,N/D,N/D,N/D,N/D,N/D';
  assert.equal(parseStooqQuotes(csv).length, 0);
});
