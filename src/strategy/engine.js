const emaCrossover = require('./emaCrossover');
const rsiEma = require('./rsiEma');
const breakout24h4h = require('./breakout24h4h');

const strategies = {
  emaCrossover,
  rsiEma,
  breakout24h4h,
  breakout24h: breakout24h4h,
};

let activeStrategy, config, repo, eventBus, logger;

function init(cfg, repository, bus, log) {
  config = cfg; repo = repository; eventBus = bus; logger = log;

  const name = config.strategy || 'emaCrossover';
  activeStrategy = strategies[name];
  if (!activeStrategy) {
    logger.warn(`Unknown strategy "${name}", falling back to emaCrossover`);
    activeStrategy = emaCrossover;
  }

  activeStrategy.init(config);

  eventBus.on('kline', (kline) => {
    try { activeStrategy.onTick(kline, repo, eventBus, logger); }
    catch (err) { logger.error('Strategy error', err.message); }
  });

  logger.info(`Strategy loaded: ${activeStrategy.name()}`);
}

function getStatus() {
  return { name: activeStrategy.name(), details: activeStrategy.getStatus() };
}

module.exports = { init, getStatus };
