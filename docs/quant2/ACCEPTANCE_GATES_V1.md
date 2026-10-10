# Quant 2.0 分阶段验收 v1

冻结日期：2026-10-10（Asia/Shanghai）。先登记门槛，再进行后续实现和模拟。本轮交付架构/契约/审计，不执行新的回放、模型请求、云任务或运行服务。原 [研究门槛](../VALIDATION_PROTOCOL.md) 继续有效。

## 当前状态与阶段顺序

`A0 文档冻结 → A1 最小适配 → A2 一条完整离线模拟 → STOP`。

A0 是本轮范围；A1/A2 是后续工作清单，不构成本轮无限开发授权。A2 通过后先交付证据与结论，再决定是否扩展合约、研究功能、前瞻观察或云部署。任何阶段失败/不完整都保留原证据，不能降门槛、换数据窗、改冻结策略或成本模型来取得通过。

| 阶段 | 固定验收条件 | 当前状态 | 失败后的停止条件 |
| --- | --- | --- | --- |
| A0：审计及规范冻结 | 四个集成点有文件证据；职责无交叉；所有必需字段及失败语义明确；源代码/旧报告保持；测试基线与欠债公开；本地 Git 提交可追踪 | 本轮完成文档与静态审计；不释放运行 readiness | 存在未经证实的 Provider/云集成声明或不可审查边界则修正文档 |
| A1：最小接口适配 | 只新增边界适配；输入/输出严格验证；角色权限及风险批准来源受控；不改变冻结策略/成本/风控数值；必要节点测试及原全量测试比较完成 | NOT_STARTED | 不支持的旧接口应明确拒绝；不得用全面重写或模型替换解围 |
| A2：单合约、单流程、固定输入模拟 | 完整 lineage；可重复的 Jev 响应/版本；Grok 草案；独立批准及否决；至少一笔合法虚拟开仓和既有规则退出；重放/重启无重复成交；账户对账一致；私有请求与真实订单均零 | NOT_RUN / PROVIDER_AND_MAPPING_UNBOUND | 任一必要输入或合法交易路径缺失即 INCOMPLETE；只走 NO_TRADE 不能宣称完整交易闭环 |

A0 的“完成”只确认规范与审计交付。当前真实行情质量/官方连接/时钟/历史全量测试欠债没有因此通过。

## A1：接口和角色隔离检查

| 检查 | 必须观察到的结果 |
| --- | --- |
| 合约身份与数据质量 | BTCUSDT 等合约匹配官方来源；Kraken spot、别的结算资产或变更 symbol 不能通过正式合约 lane |
| 时间与完整性 | 未完成/缺失/重复/逆序/错误 OHLC/未来数据拒绝；16×15m 完整 UTC 4h 窗口保留 lineage；不插值 |
| Jev 输出 | 方向与订单动作分开；概率分布与目标/版本绑定；旧 confidence 不能伪装成预测概率；缺版本、超时或 schema 错误触发 UNKNOWN/NO_TRADE |
| Grok 输出 | 每个草案绑定真实判断 ID/hash；无自定资金/杠杆/止损；无重新计算方向或修改上游数据；NO_TRADE 有审计无订单 |
| 独立风控 | 风控单独拥有批准来源、规则和最终否决；伪造 producer/allowed/permit 或批准后换草案均拒绝 |
| 虚拟执行隔离 | Paper Engine 不接真实 SDK/账号/订单 transport，不导入 legacy live 入口；测试用真实端点调用 spy 必须为 0 |
| 安全标志 | 任一输入/环境/任务宣称 live、testnet execution 或 real_orders>0 均在选取 transport/凭证前拒绝；不能只显示 false/0 |
| 持久性 | 单账户 writer/lease、幂等键、写前日志/回执、重启恢复；日志损坏或未决意图停止下单；失败保留，不重置计数 |
| 云协调边界 | 仅已声明模拟任务及 artifact；无任意命令/私有接口；排队后重新校验；云端未配置时如实 NOT_RUN |

契约验证覆盖缺字段、未知字段/版本、重复键、数字字符串、概率和不为 1、引用冲突、越界路径、错误消息生产者。权限验证必须测试可信入口；JSON 字段检查不能替代权限隔离。只添加与边界风险有关的必要测试，不重复验证冻结策略。

## A2：运行前必须绑定的最小清单

在任何模拟结果计算前建立独立 `run-manifest` 并提交；禁止填入占位 SHA 后声称冻结：

1. 一个 Binance USD-M PERPETUAL 合约；明确开发期内起止日期（最晚 2025-12-31）、周期、UTC 决策时点、必要 warmup、期末未平仓处理。优先复用已有 checksum 证据的官方归档；本轮不挑选或重跑行情。
2. 原始 ZIP/`.CHECKSUM`、规范化数据、transform、合约元数据的真实 SHA；先检查 allowlist 日期/路径，再打开文件，拒绝包含 2026 的混合文件。数据缺失则停止，不能扩大日期、换资产或生成价格来追求成交。
3. Jev Provider 的实际身份、输入投影、模型/adapter 版本、固定 target/uncertainty 定义、响应 artifact/hash；若重复调用模型不确定，使用同一次真实 Provider 响应的不可变录制重放。录制只验证工程可复现性，不证明预测质量。
4. Grok 使用的已有代码规则映射、策略证据、风控 profile、Paper Engine 路径、成本模型和账户初始状态/hash。冻结 V4 参考 SHA 为 `2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8`；不能把 Jev 无法提供概率的情况用 V4 动作假造替代。
5. 一个确定性模拟时钟、逻辑 run_id、seed（仅适用时）、artifact 目录、去重账、重试上限和 deadline。云部署不是 A2 前置；本地模拟云队列仅验证任务协议，真实云状态仍 NOT_RUN。
6. 模拟器必须匹配输入：K 线使用既有 bar 成交规则；没有真实 quote/depth 就不能使用报价撮合器。沿用对应执行路径的既有延迟/费率/滑点/资金费处理，不在不同引擎之间拼接会计。

Provider、规则映射、真实来源或合法订单路径未绑定时，状态为 `INCOMPLETE_NOT_RUN`，不得凭 fixture 宣称 A2 已通过。目标分类、策略规则及模型参数的新增研究不在这个实现阶段授权内。

## A2：一次运行的固定检查点

| 检查点 | 证据与通过条件 |
| --- | --- |
| 1. Spider | 输入路径/范围合规，官方 checksum 验证；合同身份、周期、OHLCV/时间、quality 和 window SHA 可复核 |
| 2. Jev | 每个判断只引用截止 as_of 的窗口；模型请求输入/响应身份可追踪；没有未来 candle、未来标签或账户/交易凭证 |
| 3. Grok | 草案绑定 assessment/snapshot；解释引用真实证据；无重新判断或自定风险数值 |
| 4. Risk | 合法草案获可信批准；独立否决用例输出 DENY；数量/保护由原代码计算，approve 不释放 live 权限 |
| 5. Paper | 按已登记执行时序产生虚拟订单和回执、已有规则退出；不以生成信号时已知 close 伪装同刻可成交价格；真实/私有请求=0 |
| 6. 审计与对账 | snapshot→assessment→draft→risk→receipt 全链 ID/hash；订单、成交、现金、权益、费用、滑点与资金费单计数一致；未知费用/资金费保持 null/incomplete |
| 7. 重放与恢复 | 两个隔离验证沙盒从同一不可变初始账户快照开始，以相同 manifest、录制响应和模拟时钟重放，逻辑输出/订单序列/账户 hash 相同；原账户内的幂等键重复及重启恢复不新增 fill、不重置预算 |

必须有 **至少一个合法完整虚拟订单周期** 和 **至少一个独立否决周期**。若预登记窗口无合格信号，允许证明 NO_TRADE 链路，但 A2 保持 `INCOMPLETE_NO_ELIGIBLE_DRAFT`；不强制模型做多/做空，不伪造价格/概率，不改窗口或阈值去促成成交。代码保护性退出走独立 CODE_PROTECTION 风控路径；原开仓 assessment 只作审计，不受模型有效期/可用性门，仍检查当前输入/账户/停止与日志并发行 reduce-only permit。完整重放沙盒不覆盖原正式 journal，也不作为重置已运行账户的授权。

必需否决场景：无效/不完整行情、Jev 超时/不可用概率、错判断 ID/hash、草案过期、模型等待期间行情/账户变化、伪造或过期未消费 permit、同幂等键异内容冲突、停止开关、日志损坏/持久化失败、启用 live 或真实订单要求。全部输出失败原因，未经批准的新增订单为 0，账户损益不被人为重置。

恢复必须覆盖成交 WAL fsync 前/后故障、terminal receipt 从原行派生恢复、已完成订单在 permit 过期后完全一致重投仍返回旧回执，以及云任务取消与账户 kill 的不同结果。故障注入只作用于隔离验证沙盒，不杀停或重启既有运行账户。

执行输入因果检查根据所选旧引擎冻结时序逐项验证；不能把历史 exchange-time 回放通过解释成 receipt-time/live-ready。测试响应或非市场故障注入只覆盖失败分支，标注 TEST_ONLY，不能替代正式行情或真实 Provider 正向证据。

## 测试欠债与停止标准

本轮基线 `npm test`：1124 tests，1111 pass，13 fail，0 skip/cancel，退出码 1。失败名与最近项目状态记载的历史债务组一致；不称全量通过。原测试仍包含历史 acquisition/holdout-validator 检查，本轮未解锁或执行 holdout 策略，不改变既有测试范围。

| 历史失败名称 | 债务类别 |
| --- | --- |
| BNB official data normalization: loads, sorted, contains 2026 | 缺旧行情输入 |
| SOL official data normalization: loads, sorted, contains 2026 | 缺旧行情输入 |
| checksum validation: every downloaded official zip matches its .CHECKSUM | 缺旧归档输入 |
| listing-date handling: first 4h candle is after the first 15m, first year is partial | 缺旧行情输入 |
| 4h aggregation reuses the V4 resampler (16x15m) on external data | 缺旧行情输入 |
| warmup: first trade occurs only after EMA/breakout warmup | 缺旧行情输入 |
| external assets are isolated (independent accounts) | 缺旧行情输入 |
| 2026 holdout guard blocks strategy execution on 2026 data | 缺旧行情输入 |
| 2026 kline data can be read by data validator | 缺旧行情输入 |
| funding CSV SHAs in manifest match actual files | 既有 funding SHA 不匹配 |
| 2026 kline data has no missing bars | 缺旧行情输入 |
| 2026 kline data has no duplicates | 缺旧行情输入 |
| manifest SHA256 matches actual CSV file | 既有 funding SHA 不匹配 |

后续必要专项检查必须通过，全量结果必须公开并按失败身份比较，新增失败=0、跳过/取消=0。历史债务不自动豁免或变绿：可单独确认工程模拟完成，但仓库全量 PASS、研究门槛和当前行情 readiness 仍分别报告。不得为此下载/打开 holdout 或改预期 hash。

验收产物写入新的 `reports/quant2/<唯一run-id>/`，禁止覆盖旧报告；至少包括 run-manifest、源/模型/策略/规则身份、链路日志、否决原因、虚拟订单/成交/账户对账、重复与恢复证明、测试结果，以及结论 `PASS / FAIL / INCOMPLETE` 和限制。本轮未创建这些模拟结果；A2 状态必须保持 NOT_RUN。

安全不变量贯穿所有阶段：`LIVE_TRADING=false`、`REAL_ORDERS=0`。A2 完成即停止功能扩展，不自动启动更多研究、云任务或前瞻观察。
