# 端口与接口梳理（Ports & Interfaces Reference）

## 1. 端口配置（务必记住）

| 服务 / 用途 | 默认端口 / 地址 | 环境变量 | 所在源码 |
|---|---|---|---|
| **本地 Web 监控面板 & HTTP/飞书回调服务** | **`3000`** (`http://localhost:3000`) | `WEB_PORT=3000` | `src/config.js`、`src/logger/webDashboard.js` |
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
| `GET` | `/api/state` | 无 | `application/json` | 获取快照状态：`prices`、`positions`、`balance`、`pnl`、`trades`、`wins`、`signals`、`breakers`、`priceHistory` |
| `GET` | `/api/stream` | 无 | `text/event-stream` (SSE) | 实时推送行情 `tick` 与价格历史曲线（连接成功首帧为 `{"type":"connected"}`） |
| `POST` | `/api/command` | `{"text": "/status"}` | `{"reply": "..."}` | Web 面板命令入口，转发给 `feishuCommands.handleMessage` 异步执行并返回结果 |
| `POST` | `/feishu/callback` | 飞书事件订阅 JSON | `application/json` | 接收飞书 `url_verification` 握手及 `im.message.receive_v1` 消息指令，并通过 `FEISHU_WEBHOOK_URL` 异步推送回复 |

### 支持的控制命令（`/api/command` 与飞书共用）

- `/status`：查看账户余额、当日已实现盈亏、胜率、当前策略、熔断状态与持仓概览
- `/positions`：查看当前所有持仓明细
- `/close <SYMBOL>`：触发真实平仓（撤销止盈止损保护单并发送 `reduceOnly` 市价平仓单；`DRY_RUN=true` 时执行模拟平仓）
- `/pause`：暂停新开仓信号（允许平仓信号继续执行）
- `/resume`：恢复新开仓信号
- `/strategy [name]`：查询当前及可用策略（`emaCrossover`、`rsiEma`）
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
| `strategySignal` | `strategy/emaCrossover.js`、`strategy/rsiEma.js` | `risk/manager.js`、`logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, direction: 'LONG'\|'SHORT'\|'CLOSE', price, reason }` |
| `riskApproved` | `risk/manager.js` | `execution/orderExecutor.js` | `{ signal, action: 'OPEN'\|'CLOSE', symbol, side, quantity, leverage, stopLossPrice, takeProfitPrice }` |
| `riskRejected` | `risk/manager.js` | `logger/webDashboard.js`、`logger/notifier.js` | `{ signal, reason }` |
| `positionOpened` | `execution/orderExecutor.js` | `logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, side, quantity, entryPrice, sl, tp }` |
| `positionClosed` | `execution/orderExecutor.js`、`execution/positionTracker.js` | `risk/circuitBreaker.js`、`logger/webDashboard.js`、`logger/notifier.js` | `{ symbol, pnl, pnlPct, entryPrice, exitPrice, reason }` |
| `circuitBreakerTripped` | `risk/circuitBreaker.js` | `logger/notifier.js` | `{ reason, count, durationMinutes }` |
| `dailyLimitReached` | `risk/manager.js` | `logger/notifier.js` | `{ loss, cap }` |
| `tradingPaused` / `tradingResumed` | `logger/feishuCommands.js` | `risk/manager.js` | 无 |

---

## 4. 外部交易所与告警集成接口

- **币安 REST（通过 `node-binance-api`）**：
  - 账户与合约元数据：`futuresAccount()`、`futuresPositionRisk()`、`futuresExchangeInfo()`
  - 杠杆与逐仓配置：`futuresLeverage(symbol, leverage)`、`futuresMarginType(symbol, 'ISOLATED')`
  - 开平仓与保护单：`futuresMarketBuy`、`futuresMarketSell`、`futuresOrder`（`STOP_MARKET` / `TAKE_PROFIT_MARKET`，带 `reduceOnly: true`、`workingType: 'MARK_PRICE'`）、`futuresCancel`
- **币安 WebSocket（通过 `node-binance-api`）**：
  - 公共行情流：`futuresMiniTickerStream`、`futuresMarkPriceStream`、`futuresChart`
  - 私有用户流：`userFutureData`（需配置 `BINANCE_API_KEY` 与 `BINANCE_SECRET_KEY`）
- **飞书告警出站接口**：
  - 向 `FEISHU_WEBHOOK_URL` 发送 `POST` JSON（`msg_type: "text"`）
