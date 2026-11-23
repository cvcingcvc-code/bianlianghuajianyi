# 端口与接口梳理（Ports & Interfaces Reference）

## 1. 端口配置（务必记住）

| 服务 / 用途 | 默认端口 / 地址 | 环境变量 | 所在源码 |
|---|---|---|---|
| **本地 Web 监控面板 & HTTP/飞书回调服务** | **`3000`** (`http://127.0.0.1:3000`) | `WEB_HOST=127.0.0.1`、`WEB_PORT=3000` | `src/config.js`、`src/logger/webDashboard.js` |
| 币安 USD-M 合约**测试网** REST | `https://testnet.binancefuture.com/fapi/` (`443`) | `BINANCE_TESTNET=true` | `src/market/websocket.js` |
| 币安 USD-M 合约**测试网** WebSocket | `wss://stream.binancefuture.com/stream` (`443`) | `BINANCE_TESTNET=true` | `src/market/websocket.js` |
| 币安 USD-M 合约**实盘** REST | `https://fapi.binance.com/fapi/` (`443`) | `BINANCE_TESTNET=false` | `src/market/websocket.js` |
| 币安 USD-M 合约**实盘** WebSocket | `wss://fstream.binance.com/stream` (`443`) | `BINANCE_TESTNET=false` | `src/market/websocket.js` |

---

## 2. 本地 HTTP / SSE 服务接口（监听于 `WEB_PORT`，默认 `:3000`）

由 `src/logger/webDashboard.js` 提供：

| 方法 | 路径 | 请求体 / 参数 | 返回格式 | 功能说明 |
|---|---|---|---|---|
| `GET` | `/` | 无 | `text/html` | 返回前端监控页面 `public/dashboard.html` |
| `GET` | `/api/state` | 无 | `application/json` | 获取快照状态：`prices`、`positions`、`balance`、`pnl`（扣除手续费净值）、`grossPnl`、`totalCommission`、`trades`、`wins`、`signals`、`recentTrades`（最近50条成交流水）、`breakers`、`priceHistory`、`authRequired` |
| `GET` | `/api/trades` | `?limit=50` (可选 1~100) | `application/json` | 获取最近成交流水明细数组（包含 `id`、`symbol`、`side`、`price`、`quantity`、`commission`、`time` 等） |
| `GET` | `/api/stream` | 无 | `text/event-stream` (SSE) | 实时推送行情 `tick` 与价格历史曲线（连接成功首帧为 `{"type":"connected"}`） |
| `POST` | `/api/command` | `{"text": "/status"}`（Header: `Authorization: Bearer <DASHBOARD_ADMIN_TOKEN>`，最大 `64KB`） | `{"reply": "..."}` | Web 面板命令入口，鉴权通过后转发给 `feishuCommands.handleMessage` 异步执行并返回结果（未配置 Token 时仅允许回环 IP 访问） |
| `POST` | `/feishu/callback` | 飞书事件订阅 JSON（校验 `FEISHU_VERIFICATION_TOKEN`，最大 `64KB`） | `application/json` | 接收飞书 `url_verification` 握手及 `im.message.receive_v1` 消息指令，并通过 `FEISHU_WEBHOOK_URL` 异步推送回复 |

### 支持的控制命令（`/api/command` 与飞书共用）

- `/status`：查看账户余额、当日已实现盈亏、胜率、当前策略、熔断状态与持仓概览
- `/positions`：查看当前所有持仓明细
- `/close <SYMBOL>`：触发真实平仓（撤销止盈止损保护单并发送 `reduceOnly` 市价平仓单；`DRY_RUN=true` 时执行模拟平仓）
- `/pause`：暂停新开仓信号（允许平仓信号继续执行）
- `/resume`：恢复新开仓信号
- `/strategy [name]`：查询当前及可用策略（`emaCrossover`、`rsiEma`、`rsiEmaV2`、`breakout24h4h`、`breakout24h`）
- `/help`：输出命令列表

---

## 3. 内部 `eventBus` 事件契约（模块解耦接口）

全局单例定义于 `src/eventBus.js`：

| 事件名 | 发送方（Publisher） | 监听方（Subscriber） | 载荷关键字段 |
|---|---|---|---|
| `ticker` | `market/websocket.js` | `logger/dashboard.js`、`logger/webDashboard.js` | `{ symbol, price, change, volume }` |
| `markPrice` | `market/websocket.js` | `execution/positionTracker.js`、`logger/webDashboard.js` | `{ symbol, markPrice, indexPrice, fundingRate }` |
| `kline` | `market/websocket.js` (`streams.processChartTicks`) | `strategy/engine.js` | `{ symbol, interval, open, high, low, close, volume, closeTime, isFinal, warmup }` |
| `accountUpdate` | `market/websocket.js` (`userFutureData`) | `execution/positionTracker.js` | 币安 `ACCOUNT_UPDATE` 原始或解析结构 |
| `orderUpdate` | `market/websocket.js` (`userFutureData`) | `execution/positionTracker.js` | 币安 `ORDER_TRADE_UPDATE` 原始或解析结构 |
| `strategySignal` | `strategy/emaCrossover.js`、`strategy/rsiEma.js`、`strategy/breakout24h4h.js` | `risk/manager.js`、`logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, direction: 'LONG'\|'SHORT'\|'CLOSE', price, reason, atr? }` |
| `riskApproved` | `risk/manager.js` | `execution/orderExecutor.js` | `{ signal, action: 'OPEN'\|'CLOSE', symbol, side, quantity, leverage, stopLossPrice, takeProfitPrice }` |
| `riskRejected` | `risk/manager.js` | `logger/webDashboard.js`、`logger/notifier.js` | `{ signal, reason }` |
| `positionOpened` | `execution/orderExecutor.js` | `logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, side, quantity, entryPrice, sl, tp }` |
| `slippageRejected` | `execution/orderExecutor.js` | 监控 / 测试订阅方 | `{ symbol, side, referencePrice, limitPrice }` |
| `wsReconnected` | `market/websocket.js` | `execution/positionTracker.js` | `{ attempts, timestamp }` |
| `reconcileAlert` | `execution/positionTracker.js` | `logger/notifier.js` | `{ type: 'missing_sl_repaired'\|'missing_sl_failed'\|'ghost_position_removed', symbol, ... }` |
| `positionClosed` | `execution/orderExecutor.js`、`execution/positionTracker.js` | `risk/circuitBreaker.js`、`logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, pnl, pnlPct, entryPrice, exitPrice, reason }` |
| `circuitBreakerTripped` | `risk/circuitBreaker.js` | `logger/notifier.js` | `{ reason, count, durationMinutes }` |
| `dailyLimitReached` | `risk/manager.js` | `logger/notifier.js` | `{ loss, cap }` |
| `tradingPaused` / `tradingResumed` | `logger/feishuCommands.js` | `risk/manager.js` | 无 |

---

## 4. 外部交易所与告警集成接口

- **币安 REST（通过 `node-binance-api`）**：
  - 启动 K 线历史预热：`futuresCandles(symbol, interval, { limit })`（支持 `WARMUP_CANDLES` 默认 250 根）
  - 账户、持仓与挂单同步：`futuresTime()`、`futuresAccount()`、`futuresPositionRisk()`、`futuresOpenOrders()`、`futuresExchangeInfo()`
  - 杠杆与逐仓配置：`futuresLeverage(symbol, leverage)`、`futuresMarginType(symbol, 'ISOLATED')`
  - 开平仓与保护单：`futuresMarketBuy`、`futuresMarketSell`、`futuresOrder`（`STOP_MARKET` / `TAKE_PROFIT_MARKET`，带 `reduceOnly: true`、`workingType: 'MARK_PRICE'`）、`futuresCancel`
- **币安 WebSocket（通过 `node-binance-api`）**：
  - 公共行情流：`futuresMiniTickerStream`、`futuresMarkPriceStream`、`futuresChart`
  - 私有用户流：`userFutureData`（需配置 `BINANCE_API_KEY` 与 `BINANCE_SECRET_KEY`）
- **飞书告警出站接口**：
  - 向 `FEISHU_WEBHOOK_URL` 发送 `POST` JSON（`msg_type: "text"`）
- **Telegram Bot 告警出站接口**：
  - 向 `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage` 发送 `POST` JSON（包含 `chat_id: TELEGRAM_CHAT_ID`，支持 Markdown 渲染）

---

## 5. 策略与风控新增配置字典

| 配置项 | 默认值 | 可选值 / 范围 | 说明 |
|---|---|---|---|
| `STRATEGY` | `emaCrossover` | `emaCrossover`、`rsiEma`、`rsiEmaV2`、`breakout24h4h`、`breakout24h` | 实盘执行策略选择 |
| `STOP_LOSS_MODE` | `pct` | `pct`、`atr` | 止损模式（固定百分比 或 波动率动态 ATR） |
| `STOP_LOSS_ATR_MULTIPLIER` | `2.0` | `0.1` ~ `20.0` | ATR 止损乘数（止损价 = 入场价 ± ATR × 乘数） |
| `TAKE_PROFIT_ATR_MULTIPLIER` | `4.0` | `0.1` ~ `50.0` | ATR 止盈乘数（止盈价 = 入场价 ± ATR × 乘数） |
| `WARMUP_CANDLES` | `250` | `0` ~ `1000` | 启动时通过 REST 拉取并预热的历史 K 线数量 |
| `TELEGRAM_BOT_TOKEN` | 空 | 字符串 | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 空 | 字符串 | Telegram 接收群组或频道 Chat ID |

### 容器化一键部署与管理
- `docker compose up -d`：以 `node:22-alpine` 启动后台容器，自动挂载 `./data` 与 `./logs`，具备 `/api/state` 自动健康检查。
- `docker compose logs -f`：查看实时日志（含日志轮转支持）。

### 样本外校验工具
- `npm run research:holdout-check`（执行 `scripts/check-holdout-readiness.js`）：一键巡检本地市场数据是否包含 2026 样本外数据，并输出解封执行指南。

