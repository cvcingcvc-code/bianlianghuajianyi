const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parse, readFile, detectMissingColumns } = require('../src/research/data/csvLoader');

test('CSV parsing: parses header and rows', () => {
  const text = 'timestamp,open,high,low,close,volume\n2024-01-01T00:00:00Z,100,101,99,100.5,1000\n';
  const { columns, rows } = parse(text);
  assert.deepEqual(columns, ['timestamp', 'open', 'high', 'low', 'close', 'volume']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['2024-01-01T00:00:00Z', '100', '101', '99', '100.5', '1000']);
});

test('CSV parsing: strips BOM and handles CRLF and blank lines', () => {
  const text = '\uFEFFtimestamp,open,high,low,close,volume\r\n1,2,3,4,5,6\r\n7,8,9,10,11,12\r\n\r\n';
  const { columns, rows } = parse(text);
  assert.deepEqual(columns, ['timestamp', 'open', 'high', 'low', 'close', 'volume']);
  assert.equal(rows.length, 2);
});

test('CSV parsing: missing column detection', () => {
  const { columns } = parse('ts,open,high\n1,2,3');
  const missing = detectMissingColumns(columns);
  assert.deepEqual(missing, ['timestamp', 'low', 'close', 'volume']);
});

test('CSV parsing: rejects empty file', () => {
  assert.throws(() => parse(''), /empty/);
});

test('CSV parsing: reads fixture file from disk', () => {
  const file = path.join(__dirname, 'fixtures', 'synthetic-15m.csv');
  const { columns, rows } = readFile(file);
  assert.equal(columns.length, 6);
  assert.equal(rows.length, 60);
});
