# Binance Trader - Automated Futures Trading Bot

## Overview

**Binance Trader** is a sophisticated automated trading bot for Binance USD-M Futures contracts. It combines advanced algorithmic strategies (EMA Crossover and RSI + EMA hybrid) with comprehensive risk management, real-time monitoring, and production-grade reliability features.

## Key Features

- 🎯 **Dual Strategy Engine**: EMA Crossover (MVP) + RSI + EMA (advanced)
- 🔒 **Production-Grade Risk Management**: Daily loss caps, position limits, margin requirements, circuit breakers
- 📊 **Real-time Monitoring**: WebSocket dashboards, position tracking, P&L analytics
- 🛡️ **Multi-Layer Protection**: API error tracking, trading pause controls, circuit breakers
- 🔧 **Flexible Configuration**: Testnet/Live modes, dry-run capability, extensive customization
- 📱 **Multi-Platform Alerts**: Telegram, Feishu (Lark), web dashboard
- ⚡ **High Reliability**: Auto-reconnect, graceful shutdown, error recovery

---

## Technical Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    BINANCE TRADER                          │
├─────────────────────────────────────────────────────────────┤
│  📡 WEB SOCKETS MODULE                                     │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │   Binance API   │   Mini Tickers  │   Mark Prices   │   │
│  │   (REST)        │   (WS)          │   (WS)          │   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  🧠 STRATEGY ENGINE                                        │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │  EMA Crossover   │   RSI + EMA     │   Engine Core    │   │
│  │  (9/21 EMA)      │   (Trend + RSI) │   (Signal Gen)  │   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  ⚠️  RISK MANAGER                                          │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │   Position      │   Daily Loss    │   Circuit        │   │
│  │   Sizing        │   Limits        │   Breaker        │   │
│  │   Validation    │   Enforcement   │   Protection      │   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  ⚡ EXECUTION ENGINE                                       │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │  Order Executor │  Position       │   Stop/TP        │   │
│  │  (Market Orders)│   Tracker       │   Management      │   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  📊 STATE MANAGEMENT                                       │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │   Repository     │   Database      │   Event Bus     │   │
│  │   (SQLite)       │   (Persistence) │   (Events)       │   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  📝 LOGGING & MONITORING                                   │
│  ┌─────────────────┬─────────────────┬─────────────────┐   │
│  │   Logger        │   Dashboard     │   Notifier       │   │
│  │   (Multiple)    │   (Web)         │   (Multi-Channel)│   │
│  └─────────────────┴─────────────────┴─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Binance API Key & Secret (for live trading)
- Access to Binance Futures (Testnet recommended initially)

### Installation

```bash
# Clone project
cd /path/to/binance-trader

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env with your settings
# (BINANCE_API_KEY and BINANCE_SECRET_KEY optional for testnet)
```

### Basic Usage

```bash
# Start bot with testnet (recommended for testing)
npm run start:dry

# Start bot with live trading (requires confirmation!)
npm run start

# Reset circuit breakers (after fixing issues)
npm run start:reset-breaker
```

---

## Configuration

### Environment Variables

The bot uses the following environment variables (see `.env.example`):

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `BINANCE_TESTNET` | boolean | No | `true` | Use Binance Testnet (recommended) |
| `DRY_RUN` | boolean | No | `false` | Paper trading mode (no real orders) |
| `TRADING_PAIRS` | string | No | `BTCUSDT,ETHUSDT` | Comma-separated trading pairs |
| `MAX_LEVERAGE` | number | No | `10` | Maximum leverage per position |
| `POSITION_SIZE_PCT` | number | No | `5` | Position size as percentage of balance |
| `MAX_OPEN_POSITIONS` | number | No | `3` | Maximum concurrent positions |
| `DAILY_LOSS_CAP_PCT` | number | No | `5` | Maximum daily loss percentage |
| `STRATEGY` | string | No | `emaCrossover` | Strategy: `emaCrossover` or `rsiEma` |

### Configuration Files

The bot saves its state to `data/` directory:
- `data/repository.json` - Trading state
- `data/trades.db` - SQLite database

### Command Line Options

```bash
# Reset circuit breakers (after fixing issues)
node src/index.js --reset-breaker

# Dry-run mode (paper trading)
DRY_RUN=true npm start

# Testnet only (no API keys required)
BINANCE_TESTNET=true npm start
```

---

## Strategies

### 1. EMA Crossover (Default)

**Description**: Simple EMA crossover strategy with trend confirmation.

**Signals**:
- **LONG**: EMA9 crosses above EMA21 (golden cross)
- **CLOSE**: EMA9 crosses below EMA21 (death cross)

**Parameters**:
- `EMA_FAST`: 9 periods (configurable)
- `EMA_SLOW`: 21 periods (configurable)
- `CANDLE_INTERVAL`: 15m (configurable)

### 2. RSI + EMA (Advanced)

**Description**: Combines RSI momentum with EMA trend confirmation.

**Signals**:
- **LONG**: Trend up + EMA golden cross + RSI recovering from oversold (<40)
- **CLOSE**: EMA death cross OR RSI overbought (>60)

**Parameters**:
- `RSI_PERIOD`: 14 periods
- `EMA_TREND`: 50 periods for trend confirmation

---

## Risk Management

### Core Risk Controls

1. **Position Limits**
   - Maximum concurrent positions (configurable)
   - Position sizing based on account balance
   - Minimum notional value enforcement

2. **Daily Loss Protection**
   - Maximum daily loss percentage
   - Automatic rejection of losing trades after cap reached

3. **Circuit Breakers**
   - Consecutive API error limits
   - Manual trading pause via Feishu
   - Market condition triggers

4. **Margin Requirements**
   - Minimum 200% margin ratio
   - Dynamic leverage management
   - Risk per position calculations

### Risk Metrics Monitored

- Daily P&L percentage
- Current margin ratio
- Open position count
- API error rate
- Consecutive losses

---

## Monitoring & Alerts

### Web Dashboard

Access at: `http://localhost:3000`
- Real-time position tracking
- P&L charts and statistics
- Strategy performance metrics
- System health indicators

### Notification Channels

- **Telegram**: Configurable bot token + chat ID
- **Feishu (Lark)**: Webhook integration for trading alerts
- **Console**: Detailed logging with levels (INFO, WARN, ERROR)

### Key Metrics Displayed

- Account balance and PnL
- Open positions and P&L
- Strategy status and signals
- System uptime and health

---

## Quant Research

Quant Research V1（`src/research/`）是一个**完全离线的回测模块**，用于验证现有策略（`emaCrossover`、`rsiEma`）是否具有正期望。它**不会下任何订单、不接实盘、不需要 API key**，也**不触碰实时交易链路**。架构说明见 `docs/quant-research-v1.md`，前置审计见 `docs/research-audit.md`。

### 1. 如何准备 CSV

把历史 OHLCV 数据放到 `data/market/`（目录会自动创建），例如：

```
data/market/BTCUSDT-15m.csv
```

文件必须包含以下列（表头不区分大小写）：

```
timestamp,open,high,low,close,volume
2024-01-01T00:00:00Z,42000,42100,41900,42050,1234.5
```

数据要求（不满足会明确报错并给出质量报告）：

- `timestamp` 必须**严格升序**；重复时间戳会去重（保留第一条）
- OHLC 合法：`high >= max(open, close)`、`low <= min(open, close)`、`close > 0`、无 NaN

> 大型历史行情文件请勿提交到仓库（`data/market/*.csv` 已被 `.gitignore` 忽略）。

### 2. 运行单策略回测

```bash
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv
npm run research -- --symbol BTCUSDT --strategy emaCrossover --file data/market/BTCUSDT-15m.csv
```

可选参数：`--initial-capital`、`--commission`、`--slippage`、`--position-size-pct`、`--out-dir`。

### 3. 比较策略

```bash
npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv
```

自动跑 `emaCrossover` 与 `rsiEma`，输出 `reports/comparison-*.md`。表格只给出
Highest Return / Best Sharpe / Lowest Drawdown 三类客观结论，并附
`Past performance does not guarantee future results.` 免责声明，**不自动宣称"最佳策略"**。

### 4. Walk-Forward（严格 train/test 分离）

```bash
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv \
  --train-start 2023-01-01 --train-end 2024-12-31 --test-start 2025-01-01 --test-end 2025-12-31
```

TRAIN 与 TEST 结果**分开**输出，不会混合成一个收益率。

### 5. 如何阅读报告

每次运行在 `reports/<时间戳>-<symbol>-<strategy>/` 下生成：

- `report.md`：人类可读报告（绩效表、假设、Warnings）
- `summary.json`：机器可读的完整指标
- `trades.csv`：逐笔交易（含手续费/滑点后的净盈亏）
- `equity.csv`：净值曲线

指标定义与"样本不足返回 N/A"的规则见 `docs/quant-research-v1.md`。

### 6. 什么是 Look-ahead Bias（未来函数）

如果信号在第 N 根 K 线收盘后产生，却用第 N 根的收盘价成交，就是"偷看未来"，回测收益会被严重高估。
本模块强制：**信号在 N 收盘产生 → 在第 N+1 根的 open 成交**，并有自动化测试防止回归（见 `tests/`）。

### 7. 当前假设与限制

- 仅做多、单仓位、**无杠杆**（`--position-size-pct` 默认 100）
- 手续费默认 0.04%、滑点默认 0.02%（可用 CLI 覆盖）
- **Funding 默认未包含**，报告中明确标注 `funding rate not included`
- 数据不足的指标返回 `null/N/A`，不编造结果
- 仅供研究：`Past performance does not guarantee future results.`

---

## Development

### Project Structure

```
src/
├── config.js                    # Configuration management
├── index.js                     # Main application entry point
├── eventBus.js                  # Event system
├── strategy/                    # Trading strategies
│   ├── engine.js               # Strategy manager
│   ├── emaCrossover.js         # EMA crossover strategy
│   └── rsiEma.js               # RSI + EMA strategy
├── risk/                        # Risk management
│   ├── manager.js              # Risk controller
│   ├── limits.js               # Position sizing & validation
│   └── circuitBreaker.js       # Circuit breaker protection
├── execution/                   # Trade execution
│   ├── orderExecutor.js        # Order execution engine
│   └── positionTracker.js      # Position tracking
├── market/                      # Market data
│   ├── websocket.js            # WebSocket connections
│   └── streams.js              # Data parsing
├── state/                       # State management
│   ├── database.js             # Database initialization
│   └── repository.js           # Data repository
├── logger/                      # Logging & monitoring
│   ├── logger.js              # Core logger
│   ├── dashboard.js           # Web dashboard
│   ├── webDashboard.js         # WebSocket dashboard
│   ├── notifier.js             # Notification system
│   ├── feishuCommands.js       # Feishu integration
│   └── commands.js             # Command system
└── utils/                       # Utilities
    ├── constants.js            # Constants & enums
    ├── sleep.js                # Sleep utility
    └── validators.js           # Validation utilities
```

### Development Workflow

1. **Setup**: Clone, install dependencies, configure `.env`
2. **Testing**: Run unit tests (see Testing section)
3. **Development**: Modify strategy/risk/execution code
4. **Testing**: Verify changes with dry-run mode
5. **Deployment**: Use testnet for production readiness
6. **Live Trading**: Confirm with "yes" prompt

### Testing

```bash
# Run unit tests (if implemented)
npm test

# Start in dry-run mode for testing
DRY_RUN=true npm start

# Test with testnet (no API keys required)
BINANCE_TESTNET=true npm start
```

### Building & Deployment

```bash
# The project uses runtime dependencies, no build step needed
npm start

# For production deployment:
# 1. Use testnet extensively for testing
# 2. Validate configuration thoroughly
# 3. Use monitoring to track performance
# 4. Set up proper alerts and notifications
```

---

## Performance & Scaling

### Performance Considerations

- **Memory Usage**: Optimized for typical trading workloads
- **Database**: SQLite with WAL mode for concurrency
- **WebSocket**: Auto-reconnect with exponential backoff
- **Risk Checks**: Pre-trade validation before API calls

### Scaling Considerations

- **Multi-Symbol Trading**: Supports up to 10+ trading pairs
- **High Frequency**: Efficient event-driven architecture
- **Reliability**: Circuit breakers and error recovery
- **Monitoring**: Comprehensive logging and alerting

---

## Security

### Best Practices

1. **API Key Security**
   - Never commit `.env` to version control
   - Use read+trade permissions only
   - Enable API key IP restrictions

2. **Trading Safety**
   - Test extensively in testnet mode
   - Use dry-run mode before live trading
   - Set conservative position sizes initially

3. **Operational Security**
   - Secure server environment
   - Monitor logs for unusual activity
   - Regular backup of trading state

---

## Troubleshooting

### Common Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| "No position found" errors | Invalid API keys | Verify API key permissions and testnet settings |
| "Margin ratio too low" | Insufficient balance | Increase account balance or reduce position size |
| "Circuit breaker tripped" | API errors | Check internet connection, API limits, or fix strategy |
| "Strategy not loading" | Invalid config | Verify STRATEGY setting (emaCrossover/rsiEma) |

### Debug Commands

```bash
# Start with debug logging
LOG_LEVEL=debug npm start

# Check circuit breaker status
node src/index.js --reset-breaker

# Review logs (default: logs/trader.log)
tail -f logs/trader.log
```

---

## Troubleshooting & FAQs

### Common Issues

**Q: How do I switch from testnet to live trading?**
A: Set `BINANCE_TESTNET=false` in `.env` and restart. The bot will ask for confirmation before executing any real orders.

**Q: What happens if I interrupt the bot?**
A: The bot performs graceful shutdown, saving current positions and state. Positions remain open on Binance exchange.

**Q: How do I add new trading pairs?**
A: Add them to `TRADING_PAIRS` environment variable (comma-separated, e.g., `BTCUSDT,ETHUSDT,ADAUSDT`).

**Q: Can I run multiple instances?**
A: Yes, but ensure unique configuration to avoid conflicts.

### Monitoring Tips

- Watch for circuit breaker triggers (`logger.warn('Circuit breaker tripped')`)
- Monitor margin ratio alerts (`logger.warn('Margin ratio too low')`)
- Check daily loss cap notifications (`logger.info('Daily loss cap reached')`)

### API Errors

The bot tracks API errors and can auto-recover. If experiencing persistent issues:
1. Check your Binance API key permissions
2. Verify IP restrictions
3. Ensure testnet/live settings match your intent
4. Review circuit breaker status with `--reset-breaker`

---

## Advanced Features

### Customization

**Custom Strategies**: Add new strategies to `src/strategy/`:
- Implement `name()`, `init(config)`, `onTick()`, `getStatus()`
- Follow existing strategy patterns

**Risk Rules**: Modify risk checks in `src/risk/manager.js`
- Add new validation rules
- Adjust risk parameters

**Trading Behavior**: Modify execution logic in `src/execution/orderExecutor.js`
- Add custom order types
- Implement trading logic changes

### Extensions

**Additional Indicators**: Add technical indicators to strategy calculations:
- Moving averages (SMA, VWMA)
- Volatility indicators (ATR, BandWidth)
- Volume analysis (OBV, Volume SMA)

**Position Management**: Enhanced position tracking:
- Trailing stops
- Partial profit taking
- Scale-in/out strategies

---

## Support & Community

### Resources

- **Issues**: Report bugs or feature requests
- **Documentation**: Check this README for updated information
- **Community**: Join trading communities for strategy discussions

### Getting Help

1. Verify your configuration matches requirements
2. Check logs for error messages
3. Test with testnet and dry-run modes
4. Review circuit breaker status
5. Consult strategy documentation

---

## License

MIT License - Free for personal and commercial use with proper risk management and testing.

---

*Last Updated: $(date +%Y-%m-%d)*

---

**⚠️ Trading Warning**: This software is for educational and testing purposes only. Always test thoroughly in testnet mode before using real funds. Never trust a trading bot with more capital than you can afford to lose.*