# Minimal Trading Research V1

## 本轮边界

- 分支：`feature/minimal-trading-v1`；起点：`8cb2dc4`。
- 最初工作区为无提交、无文件的 Git 目录；从指定仓库拉取 `origin/master` 后建立分支。
- 不改 `src/research/`、Funding、Holdout、历史报告、现有策略参数或 `src/risk/`。
- 复用冻结的 `breakout24h4h.computeSignal()` 和原有 `risk/manager.init()` 公共入口。
- 新增单页 Dashboard 和五个 GET API；没有真实下单 API/按钮。

## 明天运行

要求 Node.js 24（本次验收 24.15.0）。在仓库根目录运行：

```powershell
npm ci
npm start
```

打开 http://127.0.0.1:3000 。API 和 Dashboard 由同一个本地进程提供，不需要另启 UI 编译器。
`npm run start:dry` 等价于显式选择 Dry-run。`PORT` 可以更换本地端口。
按 Ctrl+C 结束；重新运行会从初始模拟权益 10,000 USDT 开始。无账户文件持久化。
当前 V1 只读取进程环境变量，不加载旧 `.env` 中的策略或杠杆配置。

默认是**官方 2025 年 1 月 BTC/ETH 4h 行情回放，非实时行情**：

1. 使用随仓库保存的小型官方 ZIP、原始 CSV、CHECKSUM 和 manifest；启动时验证 CSV SHA256。
2. 前 60 根完成 K 线预热，随后按时间顺序处理两个资产，直到首次 ETH 模拟成交。
3. 启动后每 3 秒推进一根 4h K 线，继续到月末；不会循环重置账户。
4. 回放结束后没有新消息，15 秒后 `Market: STALE`，系统健康不再是 READY。
5. 数据只来自 2025-01，不读取任何已有 Holdout 文件。本次是链路演示，**不是新策略验证或收益报告**。

## 已演示链路

官方 ETH 2025-01-23 23:59:59.999 UTC 完成 K 线：

```text
close 3337.88 > previous24hHigh 3296.99
→ breakout24h4h LONG
→ sentiment status=unavailable, score=null
→ sentiment ALLOW（不改变原始 signal）
→ 原 Risk Manager APPROVE，quantity=0.748
→ QUEUED
→ 下一根 2025-01-24 00:00:00 UTC 开盘模拟成交
→ fill=3338.537574，fee=0.9988904421408001 USDT
→ Dashboard Recent Signals: DRY_RUN_FILLED
```

完整 JSON 见 `demo-evidence.json`。之前多个 ETH LONG 因 BTC 已持仓被原风控拒绝，Dashboard 也保留这些 REJECTED 记录。
主卡显示最近 ETH 决策，带决策时间；行情价格继续更新。HOLD 更新内部策略状态，不挤掉 Recent Signals 中的动作信号。

## 五个 API

| Method | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/status` | mode、market/status/lastMessageAt、strategy、risk、sentiment、health、liveExecution |
| GET | `/api/market/:symbol` | symbol、price、最近最多 60 根完成 K 线、行情时间、来源 |
| GET | `/api/sentiment/:symbol` | 统一舆情 Contract，含 status；不可用时 score/label/confidence 为 null |
| GET | `/api/signals` | 最近最多 100 个动作信号，含 technicalSignal、sentimentDecision、riskDecision、execution |
| GET | `/api/dashboard` | 首页所需的 status、market、strategyState、sentiment、metrics、positions、recentSignals |

symbol 仅 BTCUSDT / ETHUSDT。未知 symbol=400、未知路径=404、非 GET=405。
UI 只请求 `/api/dashboard`；CSP 限制 connect-src 为本地同源。

## Sentiment

`collector → analyzer → aggregator → service`。collector 支持可注入新闻 provider 或本地新闻 JSON 导出；默认没有新闻源，诚实返回 unavailable。

要使用自己的真实新闻导出，设置 `$env:V1_NEWS_FILE='C:\path\news.json'`，文件为数组，每项字段：
`symbol`（BTCUSDT/ETHUSDT）、`title`、`url`（HTTPS）、`publishedAt`（ISO 时间）。
按 URL 去重，只读取相对决策时间过去 24 小时的对应资产文章；未来新闻不参与回放。
不要用当日新闻解释 2025 年价格。未配置或读取失败都不会产生虚构中性分数。

分析器为小型中英文标题词典，confidence 是词典覆盖率和样本数量的启发式，**不是统计校准的概率**。
只有 LONG 且 score <= -0.6、confidence >= 0.6 时 BLOCK；CLOSE 不受舆情阻止。
positive / unavailable 都必须继续过风控，不能自行生成交易信号。

## Execution 和健康状态

- `DryRunAdapter` 不包含网络调用，维护模拟权益、仓位、待成交订单、每日盈亏和回撤。
- 下一根开盘成交，BASE 手续费 0.0004、滑点 0.0002；初始权益 10,000，单仓位、1x、25% 配置、单笔名义价值上限 2,500。
- 待成交 OPEN 会预占风控仓位名额。行情 STALE/DISCONNECTED 时不得执行新技术订单。
- `LiveAdapter` 无可用执行实现；模式白名单没有 live；`BINANCE_TESTNET=false` 会拒绝启动。
- 原 `config.js` 也阻止 Live，原 `orderExecutor.js` 的非模拟 SDK 路径在初始化及执行两个位置硬禁用。
- `ReliableSocket` 支持连接超时、指数退避、重连、消息时效、lastMessageAt 和结构化错误；只有 socket open 不算市场健康。
- `UserDataLifecycle` 单独管理 listenKey 创建、续租、失效、重建和关闭，不与公共市场 socket 混用；测试验证生命周期。
- API 不输出凭证；网络日志不输出 URL query、签名或 listenKey。

## Testnet 运行与限制

```powershell
npm run start:testnet
```

需要账户查询时仅设置 `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_SECRET_KEY`，不读取普通 Binance 凭证。
REST 和 WebSocket 主机在 adapter 内固定，环境变量不能切换主机。账户 REST 对账与用户流独立于市场流。
订单接口仅允许 `/fapi/v1/order/test`，返回 `VALIDATED_ONLY`，不伪装成成交，也不创建模拟仓位。
V1 尚未实现可信的 Testnet 当日损失账本，RiskBridge 因 dailyPnl=null **拒绝 LONG**；没有凭证时账户也不可用。
本轮完整可演示路径是 Dry-run，Testnet 不是已验证的撮合交易路径。

官方接口依据：[Testnet 主机说明](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)、[用户数据流租约](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/user-data-streams)。

## 验收记录（2026-09-15）

| 项目 | 结果 |
| --- | --- |
| Baseline `npm test` | 197 tests / 184 pass / 13 fail，详见 baseline-tests.log |
| 最终 `npm test` | 212 tests / 199 pass / 13 fail，退出码 1；失败项目与 baseline 相同 |
| `npm run test:v1` | 新增 15/15 通过，包括真实冻结策略 + 原风控 + 官方回放成交集成测试 |
| Build | 原项目没有 build script；V1 是 Node.js + 静态页面，无编译步骤 |
| Server / Dashboard | 启动成功，浏览器已打开单页并看到 ETH LONG / ALLOW / APPROVE / DRY_RUN_FILLED |
| 浏览器 console | 验收时 warning/error 0 条 |
| API | 五个路由实际请求均 200；shape 和错误状态另有自动测试 |
| Testnet 实网 | 公共 REST 请求 8 秒超时，市场 DISCONNECTED、账户 unavailable；未发送鉴权订单 |
| 核心保护 | `git diff origin/master -- src/research src/risk` 为空 |

Baseline 失败属于：缺少外部资产历史 CSV/原始归档、缺少 Holdout 行情文件、已有 Funding 文件 SHA256 不匹配。
没有下载缺失的研究数据、改原测试、改 Funding 清单或重新运行研究报告。
`npm ci` 还报告原依赖树 2 项漏洞（1 moderate / 1 high）；本轮未升级 SDK 或扩大修复范围。

## 已知问题与后续优先项

- 本轮模拟账户内存保存，重启清空；不是完整成交撮合/清算引擎。退出依据冻结策略的 CLOSE；风控算出的 SL/TP 目前不作为独立模拟触发单执行。
- 回放权益不含 Funding，不代表历史回测结果或策略预期收益。
- 默认无新闻源；词典模型仅为最小可用筛选器，需真实样本审阅后再评估有效性。
- Testnet 实网不通、账户及成交尚未完成实网验收；缺失日损账本时明确拒绝开仓。
- 原 Risk Manager 是单例，因此 V1 每进程只运行一条 pipeline；本轮不重构它。

明天最重要的三件事：
1. 接入一个可追溯的真实新闻源，并验证时间对齐、去重和 bearish 样本。
2. 打通 Testnet 网络、账户对账和当日损失账本，再验收测试网执行；继续保持 Live 硬禁用。
3. 为 Dry-run 加入会话恢复和保护性退出的最小闭环，复用现有风控，不扩展页面和策略。
