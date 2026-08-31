const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, signal: 1, trade: 1 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m', signal: '\x1b[36m', trade: '\x1b[32m' };
const RESET = '\x1b[0m';

let logDir = './logs';
let minLevel = 'info';
let logStream = null;
let currentLogFile = '';

function init(config) {
  logDir = config.logDir || logDir;
  minLevel = config.logLevel || minLevel;
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  openLogFile();
}

function openLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  const filename = path.join(logDir, `trader-${date}.log`);
  if (filename !== currentLogFile) {
    if (logStream) logStream.end();
    logStream = fs.createWriteStream(filename, { flags: 'a' });
    currentLogFile = filename;
  }
}

function formatTime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, message, data) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const timestamp = formatTime();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  const color = COLORS[level] || COLORS.info;
  console.log(`${color}${line}${RESET}`);
  if (data !== undefined && data !== null) {
    const dump = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`${color}  ${dump}${RESET}`);
  }
  openLogFile();
  if (logStream) {
    logStream.write(line + '\n');
    if (data !== undefined && data !== null) logStream.write('  ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n');
  }
}

function debug(msg, data) { log('debug', msg, data); }
function info(msg, data) { log('info', msg, data); }
function warn(msg, data) { log('warn', msg, data); }
function error(msg, data) { log('error', msg, data); }
function signal(msg, data) { log('signal', msg, data); }
function trade(msg, data) { log('trade', msg, data); }
function close() { if (logStream) logStream.end(); }

module.exports = { init, debug, info, warn, error, signal, trade, close };
