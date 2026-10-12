# Binance Trader - Quantitative Trading System

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Binance API](https://img.shields.io/badge/API-Binance_Futures-blue.svg)](https://binance-docs.github.io/apidocs/futures/en/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 📊 Overview

**Binance Trader** is a sophisticated quantitative trading system designed for cryptocurrency futures trading. Built with Node.js and featuring advanced risk management, comprehensive backtesting capabilities, and real-time monitoring, this system enables traders to develop, test, and execute algorithmic trading strategies with confidence and precision.

## 🚀 Key Features

- 📈 **Advanced Strategies**: EMA Crossover and RSI + EMA hybrid algorithms
- 📊 **Comprehensive Backtesting**: Offline testing with Walk-Forward validation
- ⚡ **Real-time Analytics**: WebSocket-powered monitoring and performance tracking
- 🛡️ **Robust Risk Management**: Kelly formula, ATR stops, and multi-level circuit breakers
- 📱 **Multi-channel Notifications**: Telegram and Feishu integration
- 🧠 **Production Ready**: Clean architecture, comprehensive testing, and monitoring

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
│                 BINANCE TRADER SYSTEM                      │
├─────────────────────────────────────────────────────────────┤
│  📡 MARKET DATA INTEGRATION                              │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Binance API   │   WebSocket     │                   │
│  │   (REST)        │   (Real-time)   │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  🧠 STRATEGY ENGINE                                      │
│  ┌─────────────────┬─────────────────┐                   │
│  │  EMA Crossover   │   RSI + EMA     │                   │
│  │  (Trend Follower)│   (Momentum)    │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  📊 BACKTESTING ENGINE                                   │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Historical    │   Performance   │                   │
│  │   Data Processing│   Metrics       │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  ⚠️ RISK MANAGEMENT SYSTEM                               │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Position      │   Daily Loss    │                   │
│  │   Sizing        │   Controls      │                   │
│  └─────────────────┴─────────────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  📈 MONITORING & ALERTS                                  │
│  ┌─────────────────┬─────────────────┐                   │
│  │   Real-time     │   Multi-channel │                   │
│  │   Dashboard     │   Notifications│                   │
│  └─────────────────┴─────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- Binance Testnet account (free for research)
- Basic understanding of quantitative trading concepts

### Installation

```bash
# Clone repository
git clone https://github.com/cvcingcvc-code/bianlianghuajianyi.git
cd bianlianghuajianyi

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your testnet credentials
```

### Quick Start

```bash
# Start in safe research mode
npm run start:dry

# Run backtesting analysis
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv

# Compare multiple strategies
npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv
```

## 📈 Trading Strategies

### 1. EMA Crossover Strategy

**Description**: Trend-following strategy using exponential moving average crossovers.

**Entry Signals**:
- **LONG**: EMA9 crosses above EMA21 (golden cross)
- **SHORT**: EMA9 crosses below EMA21 (death cross)

**Exit Signals**:
- **CLOSE LONG**: EMA9 crosses below EMA21
- **CLOSE SHORT**: EMA9 crosses above EMA21

**Key Parameters**:
- `FAST_EMA`: 9 periods (short-term trend)
- `SLOW_EMA`: 21 periods (long-term trend)

### 2. RSI + EMA Hybrid Strategy

**Description**: Combines momentum oscillators with trend confirmation for higher quality signals.

**Entry Conditions**:
- **LONG**: Uptrend + EMA golden cross + RSI recovering from oversold (<40)
- **SHORT**: Downtrend + EMA death cross + RSI overbought (>60)

**Exit Conditions**:
- **CLOSE**: EMA reversal OR RSI extreme levels (>60/<40)

**Key Parameters**:
- `RSI_PERIOD`: 14 periods (momentum strength)
- `TREND_EMA`: 50 periods (trend direction)

## 📊 Backtesting & Analysis

### Key Features

- **Historical Backtesting**: Test strategies against market data
- **Walk-Forward Validation**: Robust out-of-sample testing
- **Performance Metrics**: Sharpe ratio, max drawdown, win rate
- **Strategy Comparison**: Head-to-head performance analysis
- **Realistic Simulation**: Slippage, fees, and funding costs

### Usage Examples

```bash
# Basic strategy backtesting
npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv

# Compare multiple strategies
npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv

# Walk-forward analysis
npm run research -- --symbol BTCUSDT --strategy rsiEma \
  --train-start 2023-01-01 --train-end 2024-12-31 \
  --test-start 2025-01-01 --test-end 2025-12-31
```

## 📈 Monitoring & Analytics

### Real-time Dashboard

Access the comprehensive monitoring dashboard at: `http://localhost:3000`

**Dashboard Features**:
- Live price charts and indicators
- Strategy performance metrics
- Risk monitoring and alerts
- Portfolio position tracking

### Notification System

- **Telegram**: Real-time trade alerts and notifications
- **Feishu (Lark)**: Webhook integration for team notifications
- **Console**: Detailed logging with configurable levels

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

## 💡 Technical Achievements

- **Quantitative Analysis**: Developed robust backtesting methodologies and strategy validation
- **Risk Management**: Implemented Kelly formula position sizing and multi-level circuit breakers
- **Real-time Architecture**: Built event-driven WebSocket systems with sub-millisecond latency
- **Data Processing**: Optimized time-series analysis with efficient data pipelines
- **Production Engineering**: Created modular, maintainable codebase with comprehensive testing

## 🚀 Future Development

- [ ] Advanced indicators (MACD, Bollinger Bands, Ichimoku Cloud)
- [ ] Machine learning integration for strategy optimization
- [ ] Enhanced risk metrics (VaR, CVaR, stress testing)
- [ ] Docker containerization for cloud deployment
- [ ] Multi-exchange support and portfolio management

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
