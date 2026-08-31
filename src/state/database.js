const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// In-memory state — the single source of truth during runtime
const state = {
  trades: [],
  positions: {},
  dailyStats: null,
  breakers: {},
  eventLog: [],
  appState: {},
  orderIndex: {},
};

function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const today = getDateKey();
  state.dailyStats = { date: today, startBalance: 0, currentBalance: 0, realizedPnl: 0, tradeCount: 0, winningTrades: 0 };
  state.breakers = {};
  state.eventLog = [];
  state.appState = { schema_version: 1, consecutiveLosses: 0, apiErrors: 0, apiErrorWindowStart: 0 };

  loadState();
  return state;
}

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getStatePath(filename) {
  return path.join(DATA_DIR, filename);
}

function loadState() {
  const files = ['appState.json', 'breakers.json', 'dailyStats.json', 'positions.json', 'trades.json'];
  for (const file of files) {
    try {
      const fp = getStatePath(file);
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const key = file.replace('.json', '');
        if (key === 'trades') state.trades = data;
        else if (key === 'positions') state.positions = data;
        else if (key === 'dailyStats' && data.date === getDateKey()) state.dailyStats = data;
        else if (key === 'breakers') state.breakers = data;
        else if (key === 'appState') Object.assign(state.appState, data);
      }
    } catch (e) { /* keep defaults */ }
  }
}

function saveState() {
  try {
    atomicWrite(getStatePath('trades.json'), state.trades);
    atomicWrite(getStatePath('positions.json'), state.positions);
    atomicWrite(getStatePath('dailyStats.json'), state.dailyStats);
    atomicWrite(getStatePath('breakers.json'), state.breakers);
    atomicWrite(getStatePath('appState.json'), state.appState);
  } catch (e) { /* non-fatal */ }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function shutdown() {
  saveState();
}

module.exports = { init, state, getDateKey, shutdown };
