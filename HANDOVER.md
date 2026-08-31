# Binance Trader 交接文档

> 本文档面向接手本项目的人：快速了解项目现状、如何运行、架构设计、已知问题与后续建议。
> 与 `README.md` 互补：README 偏功能介绍，本文档偏实操交接。

## 1. 项目概况

- **名称**：binance-trader（v0.1.0）
- **类型**：Binance USD-M 永续合约自动交易机器人（长多策略）
- **技术栈**：Node.js 18+ / CommonJS / `node-binance-api` v1.0.32 / `dotenv`
- **依赖**：仅 `node-binance-api`、`dotenv`（运行时）；`cross-env`（开发）
- **无构建步骤**：直接 `node src/index.js` 运行

### 当前状态（2026-08-31 交接时点）

- ✅ 已能在 **Testnet + Dry-Run** 模式下稳定运行（已实测）
- ✅ Web 仪表盘、实时行情、策略信号、风控链路完整
- ❌ 尚未接入有效测试网 API key（账户余额/持仓无法真实同步，dry-run 下用模拟余额 1000）
- ❌ 尚未实盘验证（实盘被地域封锁 + 未配置实盘 key）

## 2. 快速运行

```bash
cd C:\Users\lin\projects\binance-trader
npm install          # 首次
node src/index.js    # 或双击 start.bat
```

### 运行模式

| 模式 | 配置 | 行为 |
|------|------|------|
| 测试网 + 干燥 | `BINANCE_TESTNET=true`、`DRY_RUN=true` | 真实行情，不下单（推荐演示） |
| 测试网 + 真实 | `BINANCE_TESTNET=true`、`DRY_RUN=false` | 在测试网真实下单（需测试网 key） |
| 实盘 | `BINANCE_TESTNET=false`、`DRY_RUN=false` | 实盘真实下单，启动时需输入 `yes` 确认 |

### 常用命令

```bash
node src/index.js                 # 启动
node src/index.js --reset-breaker # 重置熔断器后启动
```

- 日志文件：`logs/trader-YYYY-MM-DD.log`
- Web 仪表盘：`http://localhost:3000`（面板内可发命令：`/status`、`/close SYMBOL`、`/pause`、`/resume`、`/help`）
- 状态持久化：`data/*.json`

## 3. 配置说明（.env）

关键变量（完整见 `.env.example`）：

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `BINANCE_TESTNET` | `true` | 测试网（推荐演示） |
| `DRY_RUN` | `true` | 干燥运行，不下单 |
| `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` | 空 | 需从 https://testnet.binancefuture.com 申请测试网 key |
| `TRADING_PAIRS` | `BTCUSDT,ETHUSDT` | 注意：`GLWUSDT` 已移除，测试网无此永续合约 |
| `STRATEGY` | `rsiEma` | `rsiEma` 或 `emaCrossover` |
| `CANDLE_INTERVAL` | `15m` | K 线周期 |
| `MAX_LEVERAGE` / `POSITION_SIZE_PCT` / `MAX_OPEN_POSITIONS` / `DAILY_LOSS_CAP_PCT` | 10 / 5 / 3 / 5 | 风控参数 |
| `FEISHU_WEBHOOK_URL` | 空（注释中） | 可选，飞书告警机器人 webhook |

> ⚠️ `.env` 已被 `.gitignore` 忽略，切勿提交任何真实 key。

## 4. 架构与启动流程

### 模块结构

```
src/
├── index.js               # 入口：编排初始化与生命周期
├── config.js              # 读取 .env，校验并冻结配置
├── eventBus.js            # 全局事件总线（EventEmitter）
├── strategy/              # 策略引擎（emaCrossover / rsiEma）
├── risk/                  # 风控（manager / limits / circuitBreaker）
├── execution/             # 执行（orderExecutor / positionTracker）
├── market/                # 行情（websocket / streams）
├── state/                 # 状态（database：内存 + JSON 持久化 / repository：读写封装）
├── logger/                # 日志与监控（logger / dashboard / webDashboard / notifier / feishuCommands）
└── utils/                 # 工具（constants / sleep / validators）
```

### 启动流程（index.js）

1. `loadConfig()` → `printConfig()`
2. `database.init()`（初始化内存状态 + 加载 `data/*.json`）
3. `logger.init()`
4. `--reset-breaker` 时重置熔断
5. **实盘安全确认**：`!testnet && !dryRun` 时要求输入 `yes`
6. `websocket.init()`（node-binance-api，testnet 时切到 fapiTest/fstreamTest）
7. `positionTracker.syncAccount()`（同步余额/持仓/合约信息；dry-run 失败则降级为模拟余额 1000）
8. 初始化 `riskManager`、`orderExecutor`、`strategyEngine`
9. 初始化 `notifier`、`feishuCommands`
10. 启动控制台仪表盘 + Web 仪表盘（:3000）
11. `websocket.connect()` 连接行情流
12. 每 30s 保存状态；每 4h 发送飞书汇总

### 核心信号链路

```
行情流(kline) → strategyEngine.onTick → emit('strategySignal')
     → riskManager.handleSignal（熔断/止损上限/持仓数/重复/保证金比例/R:R 校验）
     → emit('riskApproved') → orderExecutor.handleApproved
     → 干燥: simulate()（内存模拟） / 实盘: executeOpen/executeClose
```

仓位/订单更新 → `positionTracker`（用户数据流或 syncAccount）→ repository 持久化。

### 策略简介

- **emaCrossover**：EMA9 上穿 EMA21 开多（金叉），下穿平仓（死叉）。
- **rsiEma**（默认）：趋势向上（收盘 > EMA50）+ 金叉 + RSI 从超卖（<35）回升越过 40 开多；EMA 死叉或 RSI 从超买回落平仓。
- 两者均为**仅做多**；风控只处理 `LONG` / `CLOSE` 方向。

## 5. 数据与状态管理

- `state/database.js`：**内存状态为运行期唯一真源**，按日分文件写入 `data/*.json`（trades / positions / dailyStats / breakers / appState），`shutdown()` 时原子写入。
- `state/repository.js`：所有状态读写入口（仓位、日盈亏、熔断、连续亏损、API 错误窗口等）。
- 启动时若 `data/positions.json` 残留旧持仓，会显示"幽灵仓位"；演示前建议清空 `data/`。

> 📌 注意：README 声称使用 SQLite（`data/trades.db`），**实际实现是 JSON 文件持久化，无 SQLite**。属文档与代码不一致，见"已知问题"。

## 6. 已知问题 / 技术债

1. **`config.webPort` 未定义**（`webDashboard.js:142` 引用，`config.js` 未提供）——靠 `|| 3000` 兜底，未崩溃但属隐患。应在 `config.js` 增加 `webPort`（读 `WEB_PORT` 环境变量）。
2. **`userFutureData` 崩溃 bug（已修复）**：无 API key 时该函数抛出的异步 rejection 不受 `try/catch` 保护（`apiRequest` 为 async），会导致进程崩溃。当前修复为：无 key 时跳过用户数据流并挂 `.catch()`。
3. **实盘 REST 地域封锁**：本机直连 `fapi.binance.com` 返回 451（受限地区）；测试网 `testnet.binancefuture.com` 直连正常。实盘部署需在可访问地区的服务器/VPN 上进行。
4. **`npm run start:dry` 的代理不生效**：脚本里 `https_proxy=http://127.0.0.1:7890` 对 Node 原生 `https` 模块无效，实际不会走代理。需要走代理的话要自行在代码里实现（或直接使用测试网，无需代理）。
5. **Feishu `/close` 命令不真正平仓**（`feishuCommands.cmdClose`）：仅从本地状态移除仓位并 emit `positionClosed`（PnL=0），**不会向交易所发平仓单**。实盘使用时需改为调用 orderExecutor 真正执行。
6. **无单元测试**：README 提到 `npm test`，但项目没有测试框架与测试文件。
7. **文档与代码不一致**：README 多处声称 SQLite、多策略已适配等，与当前实现有出入；交接后建议以本文档 + 源码为准。
8. **`streams.js` 的 `parseKline` / `streams` 定义未实际使用**（websocket 走 `futuresChart`），可清理或重构。

## 7. 后续建议（Roadmap）

1. **申请测试网 API key** 填入 `.env`，让余额/持仓真实同步，再做测试网真实下单验证。
2. 修复 `config.webPort`（问题 1）。
3. 实盘化前：修复 Feishu `/close` 真正平仓（问题 5）、补单元测试（问题 6）、在可访问地区验证实盘链路。
4. 补充做空支持或明确当前仅做多的定位。
5. 可选：把 JSON 持久化升级为 SQLite（或改 README 澄清现状）。

## 8. 安全注意事项

- `.env` 含密钥，已被 gitignore，**严禁提交/外传**。
- 上实盘前务必在测试网 + dry-run 充分验证；实盘建议从最小仓位起步。
- 实盘启动会有 `yes` 确认 + 5 秒倒计时，属最后一道保险，勿移除。
- 状态备份在 `data/`；异常退出后先看 `logs/` 当日日志再决定是否 `--reset-breaker`。
