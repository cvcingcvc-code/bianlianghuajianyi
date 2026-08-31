const { loadConfig, printConfig } = require('./config');
const eventBus = require('./eventBus');
const database = require('./state/database');
const repository = require('./state/repository');
const logger = require('./logger/logger');
const dashboard = require('./logger/dashboard');
const webDashboard = require('./logger/webDashboard');
const feishuCommands = require('./logger/feishuCommands');
const notifier = require('./logger/notifier');
const websocket = require('./market/websocket');
const positionTracker = require('./execution/positionTracker');
const orderExecutor = require('./execution/orderExecutor');
const riskManager = require('./risk/manager');
const strategyEngine = require('./strategy/engine');

let shutdownSignal = false;

async function main() {
  try {
    // 1. Load config
    const config = loadConfig();
    printConfig(config);

    // 2. Init database
    database.init();

    // 3. Init logger
    logger.init(config);

    // 4. Reset breakers if requested
    if (process.argv.includes('--reset-breaker')) {
      repository.resetBreaker();
      logger.info('Circuit breakers reset');
    }

    // 5. Live trading confirmation
    if (!config.testnet && !config.dryRun) {
      logger.warn('===================================================');
      logger.warn('  REAL MONEY trading on Binance LIVE Futures');
      logger.warn('  Type "yes" to continue, anything else to exit');
      logger.warn('===================================================');
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((r) => rl.question('> ', (ans) => { rl.close(); r(ans.trim()); }));
      if (answer !== 'yes') { logger.info('Aborted'); process.exit(0); }
      logger.warn('Starting live trading in 5 seconds...');
      await new Promise((r) => setTimeout(r, 5000));
    }

    // 6. Init WebSocket
    websocket.init(config, eventBus, logger);

    // 7. Sync account (non-fatal in dry-run mode)
    await positionTracker.init(websocket.getBinance(), repository, eventBus, logger);
    try {
      await positionTracker.syncAccount();
    } catch (acctErr) {
      if (config.dryRun) {
        logger.warn(`Account sync failed (dry-run continues): ${acctErr.message}`);
        repository.setStartBalance(1000); // simulated balance for display
      } else {
        throw acctErr;
      }
    }

    // 8-10. Init risk, executor, strategy
    riskManager.init(config, repository, eventBus, logger, positionTracker);
    orderExecutor.init(config, websocket.getBinance(), repository, eventBus, logger);
    strategyEngine.init(config, repository, eventBus, logger);

    // 9b. Init notifier & feishu commands
    notifier.init(config, eventBus, logger, repository, strategyEngine);
    feishuCommands.init(config, repository, eventBus, logger, orderExecutor, strategyEngine);

    // 11. Start dashboards
    dashboard.init(config, repository, eventBus, logger);
    dashboard.start();
    webDashboard.init(config, repository, eventBus, logger, feishuCommands);
    webDashboard.start();

    // 12. Connect WebSocket streams
    await websocket.connect();

    logger.info('Bot running. Ctrl+C to stop.');

    // 13. Periodic save + Feishu summary
    const saveInterval = setInterval(() => repository.save(), 30000);
    const summaryInterval = setInterval(() => { try { notifier.sendSummary(); } catch (e) {} }, 4 * 60 * 60 * 1000);
    // Send first summary after 30s
    setTimeout(() => { try { notifier.sendSummary(); } catch (e) {} }, 30000);

    // 14. Graceful shutdown
    const shutdown = () => {
      if (shutdownSignal) return;
      shutdownSignal = true;
      logger.info('Shutting down...');
      clearInterval(saveInterval);
      clearInterval(summaryInterval);
      dashboard.stop();
      webDashboard.stop();
      websocket.disconnect();
      repository.save();
      logger.close();
      logger.info('Bot stopped. Positions remain on exchange.');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    logger.error('Fatal startup error', err.message);
    console.error(err);
    process.exit(1);
  }
}

main();
