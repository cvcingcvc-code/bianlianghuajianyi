// CSV loader for historical OHLCV data.
// Kept intentionally low-level: parses text into columns + raw string rows.
// Typed-candle construction and validation live in candleRepository/dataValidator.

const fs = require('fs');

// Standard OHLCV columns expected in research CSV files.
const REQUIRED_COLUMNS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];

// Parse CSV text into { columns, rows } where rows are arrays of raw strings.
// Handles BOM, CRLF/LF, blank lines and case-insensitive header names.
function parse(text, delimiter = ',') {
  if (typeof text !== 'string') {
    throw new Error('csvLoader.parse: expected a string');
  }
  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('CSV is empty (no header row)');
  }

  const header = lines[0].split(delimiter).map((c) => c.trim().toLowerCase());
  if (new Set(header).size !== header.length) {
    throw new Error(`CSV header contains duplicate column names: ${header.join(', ')}`);
  }

  const rows = lines.slice(1).map((line) => line.split(delimiter).map((c) => c.trim()));
  return { columns: header, rows };
}

// Read a CSV file from disk and parse it.
function readFile(filePath, delimiter = ',') {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return parse(text, delimiter);
}

// Return the subset of required columns that are missing from the header.
function detectMissingColumns(columns, required = REQUIRED_COLUMNS) {
  return required.filter((col) => !columns.includes(col));
}

module.exports = { parse, readFile, detectMissingColumns, REQUIRED_COLUMNS };
