# Quant Trading Research & Backtesting System

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Binance API](https://img.shields.io/badge/API-Binance_Futures-blue.svg)](https://binance-docs.github.io/apidocs/futures/en/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 📊 Overview

**Quant Trading Research & Backtesting System** is a comprehensive research platform for algorithmic trading strategy development and backtesting. This project focuses on quantitative analysis, strategy research, and risk management for cryptocurrency futures trading, with emphasis on research, backtesting, and dry-run capabilities rather than live trading.

## 🚀 Key Features

- 📈 **Strategy Research**: EMA Crossover and RSI + EMA hybrid strategies
- 📊 **Backtesting Engine**: Comprehensive offline backtesting with Walk-Forward validation
- ⚡ **Real-time Monitoring**: WebSocket dashboards and performance analytics
- 🛡️ **Risk Management**: Position sizing, daily loss limits, and circuit breakers
- 📱 **Multi-platform Alerts**: Telegram and Feishu notifications
- 🧠 **Engineering Excellence**: Modular architecture, clean code, and production-ready practices

## 🛠️ Tech Stack

- **Language**: Node.js / JavaScript
- **API**: Binance Futures API
- **Database**: SQLite
- **Real-time Data**: WebSocket connections
- **Testing**: Unit testing framework
- **Monitoring**: Web dashboard and logging

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              QUANT TRADING RESEARCH SYSTEM                │
├─────────────────────────────────────────────────────────────┤
│  📡 MARKET DATA MODULE                                   │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Binance API   │   WebSocket     │                   │
│  │   (REST)        │   (Real-time)   │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  🧠 STRATEGY ENGINE                                      │
│  ┌─────────────────┬─────────────────┐                   │
│  │  EMA Crossover   │   RSI + EMA     │                   │
│  │  (9/21 EMA)      │   (Trend + RSI) │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  📊 BACKTESTING ENGINE                                   │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Strategy      │   Performance   │                   │
│  │   Execution     │   Analysis      │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  ⚠️ RISK MANAGEMENT                                     │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Position      │   Daily Loss    │                   │
│  │   Sizing        │   Limits        │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  📝 MONITORING & ALERTS                                  │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Web Dashboard │   Notifications │                   │
│  │   (Real-time)   │   (Multi-channel)│                   │
│  └─────────────────┴─────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Binance Testnet access (no API keys required for research)
- Basic understanding of quantitative trading concepts

### Installation

```bash
# Clone repository
git clone https://github.com/cvcingcvc-code/bianlianghuajianyi.git
cd bianlianghuajianyi

# Install dependencies
npm install

# Create environment configuration
cp .env.example .env

# Configure for research mode (recommended)
echo "BINANCE_TESTNET=true" >> .env
echo "DRY_RUN=true" >> .env
```

### Basic Usage

```bash
# Start in research/dry-run mode (recommended)
npm run start:dry

# Run backtesting
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv

# Compare strategies
npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv
```

## 📈 Strategies

### 1. EMA Crossover

**Description**: Simple EMA crossover strategy with trend confirmation.

**Signals**:
- **LONG**: EMA9 crosses above EMA21 (golden cross)
- **CLOSE**: EMA9 crosses below EMA21 (death cross)

**Parameters**:
- `EMA_FAST`: 9 periods (configurable)
- `EMA_SLOW`: 21 periods (configurable)

### 2. RSI + EMA

**Description**: Combines RSI momentum with EMA trend confirmation.

**Signals**:
- **LONG**: Trend up + EMA golden cross + RSI recovering from oversold (<40)
- **CLOSE**: EMA death cross OR RSI overbought (>60)

**Parameters**:
- `RSI_PERIOD`: 14 periods
- `EMA_TREND`: 50 periods for trend confirmation

## 📊 Backtesting

### Key Features

- **Offline Backtesting**: No API keys required
- **Walk-Forward Validation**: Train/test separation
- **Comprehensive Metrics**: Sharpe ratio, drawdown, win rate
- **Strategy Comparison**: Side-by-side performance analysis
- **Realistic Assumptions**: Slippage, commissions, and funding rates

### Usage Examples

```bash
# Basic backtesting
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv

# Strategy comparison
npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv

# Walk-Forward validation
npm run research -- --symbol BTCUSDT --strategy rsiEma \
  --train-start 2023-01-01 --train-end 2024-12-31 \
  --test-start 2025-01-01 --test-end 2025-12-31
```

## 📱 Monitoring & Alerts

### Web Dashboard

Access the real-time dashboard at: `http://localhost:3000`

### Notification Channels

- **Telegram**: Configurable bot integration
- **Feishu (Lark)**: Webhook notifications
- **Console**: Detailed logging with levels

## 🔧 Development

### Project Structure

```
├── src/                 # Source code
│   ├── strategy/        # Trading strategies
│   ├── risk/           # Risk management
│   ├── execution/      # Trade execution
│   ├── market/         # Market data handling
│   ├── state/          # State management
│   └── utils/          # Utilities
├── data/               # Data storage
│   ├── market/         # Market data for backtesting
│   └── repository/     # Trading state
├── docs/               # Documentation
├── reports/            # Backtesting reports
├── public/             # Web dashboard
└── tests/              # Test suite
```

### Testing

```bash
# Run unit tests
npm test

# Start in dry-run mode for testing
DRY_RUN=true npm start

# Test with testnet
BINANCE_TESTNET=true npm start
```

## 📚 What I Learned

- **Quantitative Analysis**: Strategy development and backtesting methodologies
- **Risk Management**: Position sizing, stop-loss, and portfolio risk control
- **Real-time Systems**: WebSocket connections and event-driven architecture
- **Data Processing**: Market data analysis and time-series processing
- **Software Engineering**: Modular design, clean code practices, and testing strategies

## 📈 Roadmap

- [ ] Add more technical indicators (MACD, Bollinger Bands)
- [ ] Implement machine learning-based strategy optimization
- [ ] Enhance backtesting with more sophisticated risk metrics
- [ ] Add Docker containerization for easier deployment
- [ ] Improve documentation and examples

## 🔒 Security

### Best Practices

- **API Key Security**: Never commit `.env` files to version control
- **Research Mode**: Default to testnet and dry-run for safety
- **Data Privacy**: Market data files are excluded from git
- **Configuration Management**: Environment variables for sensitive data

## 📝 License

MIT License - Free for personal and commercial use with proper risk management and testing.

---

*This project is for educational and research purposes only. Always test thoroughly before using with real funds.*