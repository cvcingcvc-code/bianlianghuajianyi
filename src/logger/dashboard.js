let config, repo, eventBus, logger;
let interval, startTime = Date.now();
const lastTicker = {};

function init(cfg, repository, bus, log) {
  config = cfg; repo = repository; eventBus = bus; logger = log;
  eventBus.on('ticker', (d) => { lastTicker[d.symbol] = d; });
}

function start() {
  startTime = Date.now();
  interval = setInterval(render, config.dashboardRefreshMs);
}

function render() {
  console.clear();
  const stats = repo.getDailyStats();
  const positions = repo.getOpenPositions();
  const breakers = repo.getBreakerState();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const modeStr = config.testnet ? 'TESTNET' : 'LIVE';
  const dryStr = config.dryRun ? ' [DRY RUN]' : '';

  console.log('═'.repeat(56));
  console.log(`  Binance Futures Trader | ${modeStr}${dryStr} | ${config.emaFast}/${config.emaSlow} EMA | ${config.candleInterval}`);
  console.log(`  Uptime: ${h}h ${m}m ${s}s | Positions: ${positions.length}/${config.maxOpenPositions}`);
  console.log('═'.repeat(56));

  // Balances
  const bal = stats.currentBalance > 0 ? stats.currentBalance.toFixed(2) : '...';
  const pnlSign = stats.realizedPnl >= 0 ? '+' : '';
  console.log(`  Balance: ${bal} USDT | PnL: ${pnlSign}${stats.realizedPnl.toFixed(2)} | Trades: ${stats.tradeCount} | Wins: ${stats.winningTrades}`);

  // Daily loss bar
  const capAbs = stats.startBalance * config.dailyLossCapPct / 100;
  const barW = 30;
  const lossRatio = capAbs > 0 ? Math.min(Math.abs(stats.realizedPnl) / capAbs, 1) : 0;
  const filled = Math.round(lossRatio * barW);
  console.log(`  Daily Loss: [${'█'.repeat(filled)}${'░'.repeat(barW - filled)}] ${config.dailyLossCapPct}% cap`);

  // Breaker status
  const tripped = Object.values(breakers).find((b) => b.tripped);
  if (tripped) {
    const remain = Math.max(0, Math.floor((tripped.expiresAt - Date.now()) / 1000));
    console.log(`  CIRCUIT BREAKER: ${tripped.reason} (${remain}s remaining)`);
  }

  // Prices
  let priceLine = '  ';
  for (const sym of config.tradingPairs) {
    const t = lastTicker[sym];
    if (t) {
      const cs = t.change != null ? ` (${t.change >= 0 ? '+' : ''}${t.change.toFixed(2)}%)` : '';
      priceLine += `${sym}: ${t.price.toFixed(2)}${cs}  `;
    } else {
      priceLine += `${sym}: ...  `;
    }
  }
  console.log(priceLine);

  // Positions
  if (positions.length > 0) {
    console.log('─'.repeat(56));
    for (const pos of positions) {
      const cp = lastTicker[pos.symbol] ? lastTicker[pos.symbol].price : pos.entryPrice;
      const uPnl = (cp - pos.entryPrice) * pos.quantity;
      const sign2 = uPnl >= 0 ? '+' : '';
      console.log(`  ${pos.symbol} LONG | Entry: ${pos.entryPrice.toFixed(4)} | Now: ${cp.toFixed(4)} | PnL: ${sign2}${uPnl.toFixed(2)} | SL: ${pos.stopLossPrice.toFixed(4)} | TP: ${pos.takeProfitPrice.toFixed(4)}`);
    }
  }

  console.log('═'.repeat(56));
}

function stop() { if (interval) clearInterval(interval); }

module.exports = { init, start, stop };
