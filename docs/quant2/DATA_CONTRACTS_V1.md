# Quant 2.0 统一接口契约 v1

冻结日期：2026-10-10（Asia/Shanghai）。本文件是待适配的接口规范，**不是已实现的 Provider 或运行接口**。职责见 [架构冻结](ARCHITECTURE_FREEZE.md)，验收见 [分阶段门槛](ACCEPTANCE_GATES_V1.md)。

## 1. 调用边界

| 接口 | 输入 | 输出 | 唯一生产者 |
| --- | --- | --- | --- |
| `Spider.read(request)` | 合约、周期、已冻结的数据范围/来源 | `MarketWindow` | Spider |
| `Jev.assess(window)` | 已验证且只包含决策时点之前数据的窗口 | `MarketAssessment` | Jev |
| `Grok.draft(assessment, policyRef, paperStateRef)` | 关联行情、结构化判断、只读规则/虚拟账户引用 | `PaperDraft` | Grok Bot |
| `Risk.evaluate(draft, evidence, paperState)` | 完整上游证据、当前虚拟账户及代码风控策略 | `RiskDecision` | 独立风控层 |
| `Risk.evaluateProtection(position, executionInput, policyRef)` | 当前虚拟仓位、真实来源执行输入、既有代码保护规则 | `RiskDecision`（CODE_PROTECTION） | 独立风控层 |
| `Paper.submit(draft, permit, executionInput)` | 未修改的草案、可信批准、真实来源模拟成交输入 | `PaperReceipt` | Paper Engine |
| `Grok.coordinate(task)` | 有界的模拟任务描述 | `TaskReceipt` | Grok Bot；只协调任务 |

以上是概念接口签名，不注册 HTTP 路由或云端服务。消费者只接受相应生产者的输出；声明 `producer=RISK` 本身不构成权限证明。

## 2. 公共封装与身份

以下字段必填，所有对象拒绝未声明字段；可空字段也必须显式传 `null`。版本不支持、字段缺失、重复 JSON 键或类型错误均拒绝，禁止静默修正。本轮冻结字段及语义；A1 在实现前须把这些规则逐项固化为完整机器 schema 和跨字段 validator，包括规则引用对象的嵌套类型/长度边界，不把本 Markdown 声称为已可执行的验证器。

| 字段 | 类型/含义 |
| --- | --- |
| `schema_version` | 固定 `quant2.v1`；破坏兼容的修改使用新版本 |
| `kind` | 六种消息类型之一：上述 `MarketWindow` 至 `TaskReceipt` |
| `message_id` | 对内容生成的稳定 ID；不得从模型自由文本取得 |
| `producer` | `SPIDER / JEV / GROK_BOT / RISK / PAPER_ENGINE`；由可信入口绑定 |
| `run_id` | 同一逻辑模拟流程的稳定 ID；重试/重启不另建账户 |
| `correlation_id` | 贯穿行情、判断、草案、风控、虚拟成交的关联 ID |
| `logical_time_ms` | UTC epoch 毫秒安全整数；回放由确定性的模拟时钟提供 |
| `recorded_at_ms` | 实际审计写入时间；不能代替交易所时间或回放时钟 |
| `context` | `lane`、`clock_mode`、`manifest_sha256`、`policy_bundle_sha256`、`live_trading=false`、`real_orders=0` |
| `payload_sha256` | 对规范化 `payload` 的 SHA256，小写 64 位十六进制 |
| `payload` | 按下列类型声明的对象 |

`lane=ARCHIVE_REPLAY / PUBLIC_FORWARD_PAPER / TEST_ONLY`，三者数据、账户和审计目录独立。本轮只设计 `ARCHIVE_REPLAY` 的首条完整流程；另外两类是隔离标记，不代表获准启动。`clock_mode=EXCHANGE_TIME_REPLAY / VERIFIED_RECEIPT_CLOCK / TEST_CLOCK`，必须与 lane 对应。

内容规范化固定为：对象键按 Unicode 码点排序、数组保留顺序、UTF-8、无 BOM、无额外空白、JSON 数值采用 Node 的有限数值序列化；拒绝 `undefined`、NaN、Infinity 和重复键。身份材料包含 `schema_version/kind/run_id/correlation_id/logical_time_ms/context/payload_sha256`，不含 `recorded_at_ms`；其 SHA256 为 `message_id`。实际存档原始字节另存 `artifact_sha256`，不与内容身份混用。重放允许审计时间不同，要求逻辑内容身份一致。

所有 payload 内的稳定 ID 都在排除自身 ID 字段后求内容身份（幂等键另按固定上游引用生成）。`decision_record_sha256/journal_hash/audit_record_sha256` 指向独立、已提交的上游或日志记录，不指向包含该字段的自身完整对象；不允许循环依赖。ID/引用为非空受限 ASCII 字符串，SHA 为小写 64 位十六进制，reason_codes/flags 为去重代码数组；所有时间为非负安全整数或明确允许的 null。版本/策略/模型身份必须可核验，不能以任意字符串代替绑定证据。

生产者身份必须由受控依赖注入/可信日志通道绑定；未来跨进程使用经验证的工作者身份及消息完整性机制。普通 JSON、模型输出和云端回调均不能自行铸造风控批准。

## 3. Spider → MarketWindow

| payload 字段 | 必填类型/约束 |
| --- | --- |
| `snapshot_id` | 稳定行情窗口 ID；按合约、周期、范围和 candle/source 内容生成，排除本字段自身 |
| `instrument` | `{venue, market, symbol, base_asset, quote_asset, settlement_asset, contract_type, instrument_metadata_sha256}` |
| `timeframe` | `{name, duration_ms}`；v1 可表达 `1m/15m/1h/4h`，不表示所有周期已实现 |
| `range` | `{start_ms, end_ms, as_of_ms}`；UTC 左闭右开；`start < end <= as_of` |
| `candles` | 按 `open_time_ms` 严格递增的数组；元素定义见下 |
| `source` | `{source_id, source_kind, manifest_sha256, raw_artifact_sha256s, checksum_status, transformation_version}` |
| `quality` | `{status, flags, expected_bars, actual_bars, missing_bars, duplicate_bars, invalid_bars, out_of_order_bars, complete, clock_status}` |

合约身份：首条正式历史模拟使用 `venue=BINANCE`、`market=USD_M_FUTURES`、`contract_type=PERPETUAL`、`quote_asset=settlement_asset=USDT`；symbol 与 base_asset 必须对应官方归档路径及已绑定合约元数据。不同交易所、现货、币本位或不同结算资产必须使用不同身份；禁止把 `BTC/USD` 改名为 `BTCUSDT` 来取得等价性。

周期映射固定为 `1m=60000 / 15m=900000 / 1h=3600000 / 4h=14400000` 毫秒；name 与 duration 不一致则拒绝。range 起止必须 UTC 周期对齐，区间长度整除 duration。

每根 candle 必填：`open_time_ms`、`close_time_ms`、`exchange_event_time_ms`、`received_at_ms`、`open/high/low/close/volume`、`closed`、`source_artifact_sha256s`。`close_time_ms` 是区间右边界（排他），保留源文件实际 close timestamp 的转换说明；不是声称该时点收到消息。OHLC 是有限正数，volume 是有限非负数，`low <= min(open,close) <= max(open,close) <= high`；`close_time_ms-open_time_ms=duration_ms`，UTC 边界对齐。正式可判断 candle 必须 closed=true，且 `start_ms <= open_time_ms < close_time_ms <= end_ms <= as_of_ms`，全部区间时间为安全整数。volume 固定为基础资产数量，其他量不能冒充此字段。

`exchange_event_time_ms` 是实际消息的交易所事件时间，历史归档没有该字段则为 `null`；`received_at_ms` 是原始接收日志时间，没有则为 `null`。不能用 K 线结束时间、文件下载时间或“事件时间+估计延迟”填补它们。历史回放仅按交易所区间时间排序，不能宣称还原历史可见性/网络延迟；前瞻 lane 缺少已验证事件时间或接收时钟则无效。

`quality.status=VALID / DEGRADED / INVALID / UNKNOWN`；`clock_status=VERIFIED / EXCHANGE_TIME_ONLY / INVALID / UNKNOWN`。计数为非负安全整数，无法测得时为 null（并使质量不可为 VALID），不能把未知当 0。`expected_bars=(end_ms-start_ms)/duration_ms`，`actual_bars=candles.length`；VALID 必须 expected=actual>0、complete=true，missing/duplicate/invalid/out_of_order 均为 0。官方归档必须 `checksum_status=VERIFIED`，绑定原始 ZIP 和 `.CHECKSUM` 身份。15m→4h 必须来自 16 根完整 UTC 对齐 candle，保留 lineage，不插值、不补价。非完整窗口保留质量失败证据，不能输出 `closed=true` 的假完整 K 线。`INVALID/UNKNOWN` 可使用空 candles 描述失败，必须有 flags。

Spider 只判断数据结构/来源/时钟质量，不生成方向、概率、交易信号、仓位或风控批准。质量门失败即停止 Jev 正常模型判断；Jev 可生成只引用失败输入的 SAFETY_FALLBACK/UNKNOWN 记录，供 Grok 关联 NO_TRADE 审计，不进行概率推断。

## 4. Jev → MarketAssessment

| payload 字段 | 必填类型/约束 |
| --- | --- |
| `assessment_id` | 稳定判断 ID；由绑定输入、模型身份、结果生成，排除本字段自身 |
| `input_snapshot_id / input_payload_sha256` | 精确引用 Spider 输出，不能只引用 symbol |
| `instrument / timeframe / as_of_ms` | 与被引用窗口完全一致 |
| `direction` | `UP / DOWN / SIDEWAYS / UNKNOWN`；是行情分类，不能是 LONG/SHORT/CLOSE |
| `target` | `{definition_id, definition_sha256, horizon_ms}`；固定分类目标、价格口径、SIDEWAYS 定义及预测时距 |
| `probability` | `{kind, values, calibration_status, calibration_artifact_sha256}`，见下 |
| `uncertainty` | `{status, method, value, evidence_sha256}`；`status=KNOWN / UNKNOWN`，未知 value/evidence 为 null |
| `data_validity` | `{status, reason_codes, checked_snapshot_sha256}`；`status=VALID / DEGRADED / INVALID / UNKNOWN` |
| `model` | `{provider_id, model_id, model_version, adapter_version, artifact_sha256, request_input_sha256, response_artifact_sha256, origin}` |

`target` 的具体统计定义来自将来绑定的 Jev Provider 版本，不在本轮新建或调优预测模型。定义未绑定则 `direction=UNKNOWN`、probability 不可用；不能把当前行情描述与未来方向预测混为一个目标。

`probability.kind=PREDICTIVE / UNAVAILABLE`。PREDICTIVE 时 `values={up,down,sideways}`，三值有限且在 [0,1] 内，总和与 1 的差不超过 `1e-8`；direction 是唯一最大概率对应类，最大值并列则 UNKNOWN。UNAVAILABLE 时 values=null、direction=UNKNOWN。拒绝超界值、数字字符串、自动归一化和任意单热点替代。

`calibration_status=VALIDATED / NOT_VALIDATED / UNKNOWN`。VALIDATED 必须有可核验且绑定同一模型与目标的校准 artifact；其他状态 artifact=null。未经校准的预测向量必须保留 NOT_VALIDATED，不能用作已验证胜率/盈利依据。旧 DeepSeek `confidence` 即使提示词称其为 probability，也缺少方向分布、目标与校准证据，**不得复制为这里的 probability**。

uncertainty 的 method 定义 value 的量纲及范围；方法未绑定则 UNKNOWN/null，不能用 `1-confidence` 假造不确定性。模型失败不等于行情下跌或高风险市场判断。`origin=PROVIDER_RESPONSE / RECORDED_PROVIDER_REPLAY / SAFETY_FALLBACK / TEST_FIXTURE`；重放保留真实模型版本和响应 SHA，fixture 永远 TEST_ONLY。

Jev 的 data_validity 只能维持或降低 Spider 的有效性，不能把 INVALID/DEGRADED 升级为 VALID。模型/版本/输入无法绑定、超时、schema 错误或缺数据均输出可审计的 UNKNOWN/无可用概率，不生成虚拟订单。模型字段必须保留实际服务返回/既有版本证据，未知版本不得静默替换默认模型。

## 5. Grok Bot → PaperDraft

| payload 字段 | 必填类型/约束 |
| --- | --- |
| `draft_id / idempotency_key` | 内容身份及持久幂等键；同一判断+策略规则+账户代次的重试复用同一键 |
| `assessment_id / assessment_payload_sha256` | 必须引用一个真实存在、不可修改的 Jev 判断 |
| `snapshot_id / snapshot_payload_sha256` | 与该判断输入一致 |
| `instrument` | 与判断合约身份一致 |
| `mode / status` | 固定 `paper / DRAFT`；没有 APPROVED 状态 |
| `action` | `OPEN_LONG / OPEN_SHORT / REDUCE / CLOSE / NO_TRADE`；枚举可表达不代表规则允许 |
| `position_ref` | 已有虚拟仓位的 ID/hash，OPEN 或 NO_TRADE 为 null |
| `intent` | `{sizing_policy_id, protection_policy_id, execution_policy_id, policy_sha256, strategy_evidence_ref}`；均为代码规则引用，不含模型自定金额/杠杆/止损数值 |
| `valid_until_ms` | 由已绑定规则生成的逻辑期限；不是 LLM 指定 |
| `explanation` | `{reason_codes, summary, evidence_refs}`；summary 最长 500 字符，不作为执行输入 |
| `audit_refs` | `{task_id, request_artifact_sha256, response_artifact_sha256, decision_record_sha256}`；未发生模型调用的 request/response 明确为 null |

Grok Bot 消费 Jev 结果并依照已有代码规则构造草案；不能改写行情、补造概率或独立重新判断方向。方向 UP 不自动等于 OPEN_LONG，DOWN 不自动等于开空。新契约覆盖更多 action 仅为接口表达；冻结 V4 仍是原来的 long-only，SHORT/CLOSE 的旧接口含义不能偷换成新开空。

策略证据只读引用原冻结候选 SHA/既有信号；不能改冻结策略来适应 Jev。若旧规则没有合法的判断→草案映射，返回 `NO_TRADE / POLICY_MAPPING_UNBOUND`，不能增加策略或概率阈值。未知/无效 Jev、不可用概率、不确定性方法未绑定、过期判断或引用冲突，均为 NO_TRADE。非 VALIDATED 概率最多进入明确登记的工程模拟，不能释放原有研究或盈利门槛。

NO_TRADE 仍保留判断引用和解释，进入审计终态而不调用 `Paper.submit`。REDUCE/CLOSE 必须 reduce-only 语义并匹配已有仓位；代码风控拥有保护性退出，模型/云任务不得延迟既有保护。

`position_ref` 非空时固定为 `{paper_account_id, position_id, position_sha256, account_revision}`，前三项为 ID/内容 SHA，revision 为非负安全整数。其他证据引用统一为 `{record_id, artifact_sha256}`，引用位置由可信 artifact registry 解析，不接受模型提供任意文件路径或 URL。

## 6. 独立风控 → RiskDecision；Paper Engine → PaperReceipt

RiskDecision 必填：`risk_decision_id`、`origin=DRAFT/CODE_PROTECTION`、`draft_id/draft_payload_sha256`、`assessment_id`、`snapshot_id`、`protection_event_ref`、`paper_account_id/account_state_sha256`、`policy_id/policy_sha256`、`result=APPROVE/DENY`、`reason_codes`、`checked_at_ms`、`expires_at_ms`、`permit`。DENY 时 permit=null。DRAFT 时保护事件为 null；CODE_PROTECTION 时 draft_id/draft_payload_sha256 为 null，assessment_id 引用原开仓判断，只作审计，不受原模型判断有效期门约束。

APPROVE 的 permit 必填：`permit_id`、`origin`、`idempotency_key`、`draft_sha256`、`assessment_id`、`snapshot_id`、`protection_event_ref`、`run_id`、`account_state_sha256/account_revision`、`risk_epoch`、`issuer_identity`、`instrument`、`action`、`reduce_only`、`resolved_order`、`execution_input_ref`、`not_before_ms/expires_at_ms`、`mode=paper/live_trading=false/real_orders=0`。CODE_PROTECTION 的 draft_sha256=null，必须绑定非空保护事件及当前仓位；该路径只可 reduce/close，不新增暴露。批准的完整性与生产者权限必须由可信通道验证，不能只检查 `allowed=true`。

`resolved_order` 固定字段为 `{notional, quantity, leverage, stop_loss_pct, take_profit_pct, max_holding_ms, position_id}`：开仓金额/数量有限且>0，杠杆正整数，position_id=null；减仓/平仓 quantity 有限且>0且不超过当前仓位，position_id 必须匹配。保护百分数/期限仅在已绑定旧 profile 使用时按原规则验证，不适用字段为 null；例如原冻结 V4 的 EMA 退出由原 protection policy 引用绑定，不能为补字段加 SL/TP 或持仓期限。所有金额/数量/保护由既有代码策略计算并受现有限制，不能新增数值规则或从模型取值。REDUCE/CLOSE 必须 reduce_only=true。

`execution_input_ref` 固定为 `{source_manifest_sha256, execution_policy_sha256, eligible_range}`（range 为 start_ms/end_ms）。它只绑定已经登记的来源和执行资格，不提前装入未来下一 bar 的价格。实际成交 bar/quote 只能在模拟时钟推进至既有执行规则规定时点后进入 Paper 和最终风控；真实成交输入的 hash 到 PaperReceipt 才记录，不回流 Jev/Grok 的决策窗口。

模型等待/云任务排队后独立风控必须再次验证质量、有效期、冻结来源、账户状态、去重和停止开关。Paper 首先查询持久幂等账及不可变 request_fingerprint（绑定 draft/permit/执行意图）：同键异内容拒绝 DUPLICATE_CONFLICT；已完成且内容完全相同的重投直接返回原回执，即使 permit 已过期或账户后来变化，也不重新执行。尚未执行的新请求才检查 permit/hash/账户 revision/risk epoch/有效期和成交输入；任何变化拒绝并要求风控重新评估，不能就地修改草案或重用旧批准。

permit 消费与幂等订单预留必须在同一持久事务/WAL 中登记；重启使未消费旧 permit 失效，未决 intent 进入恢复阻断。每次成交的经济 delta、订单状态、幂等结果及 `receipt_core` 也必须原子提交并 fsync 后才 ACK；恢复只应用一次已提交账务，不重新撮合或重扣费用。receipt_core 不含自身 journal sequence/hash 和最终 receipt_id，提交后从已落盘行的 sequence/hash 派生最终 PaperReceipt，避免循环哈希；重启从同一行重建相同逻辑回执。实际审计 recorded_at 可以不同。

代码保护由 `Risk.evaluateProtection` 根据当前仓位/真实来源执行输入/原保护规则发行许可，不通过 Jev/Grok 重新判断，不因模型失效无限延迟。它仍验证时钟/行情/账户 revision/风险 epoch/停止开关/对账/日志；沿用既有安全语义，不放宽行情与持久性门。保护事件证据包括 position_ref、触发规则 ID/hash、触发输入 hash 和时点，输出只减暴露。

PaperReceipt 必填：`receipt_id`、`origin`、`draft_id/assessment_id/risk_decision_id/permit_id`、`protection_event_ref`、`paper_account_id`、`idempotency_key`、`order_id`（`paper-` 前缀或 null）、`status=REJECTED/QUEUED/FILLED/PARTIALLY_FILLED/CANCELLED/NO_FILL`、`reason_codes`、`execution_policy_sha256`、`execution_input_sha256`、`fills`、`account_before_sha256/account_after_sha256`、`journal_sequence/journal_hash`、`cost_model_ref`、`pnl_complete`、`mode=paper/live_trading=false/real_orders=0`。CODE_PROTECTION 时 draft_id=null，原开仓 assessment 和非空保护事件仍保留。

fills 元素为 `{fill_id, logical_time_ms, instrument, action, quantity, price, commission, slippage_cost, funding_cashflow}`；未知 funding 为 null，并设置 pnl_complete=false。成交价格/费用由选定的既有模拟器及其未变成本模型计算；不能从解释文本取得。报价撮合需要已绑定真实 bid/ask/depth；K 线回放只使用已有 bar 模拟规则，不能把 OHLC 当真实盘口。

Paper Engine 没有采集、Provider、云调度或真实订单 transport。其保护性状态转移遵循代码风控规则，不做新的方向判断。损坏日志/未决 intent/无法对账进入 RECOVERY_REQUIRED，不能新建空账户伪装恢复。失败证据也必须持久化，审计写入失败则停止新虚拟订单。

## 7. 云端任务契约（只定义，未部署）

任务输入必填：`task_id/idempotency_key/run_id/correlation_id`、`task_type`、`input_artifact_refs`（只读 URI/hash）、`contract_version`、`policy_bundle_sha256`、`source_commit/source_worktree_manifest_sha256`、`deadline_ms/max_attempts`、`execution_mode=paper/live_trading=false/real_orders=0`。

允许 task_type：`REPLAY_PAPER_FLOW / VERIFY_ARTIFACTS / READ_STATUS / CANCEL_PAPER_TASK`。不接收任意 shell、URL、代码或真实交易命令；模型调用/重试必须服从既有配额及持久预留，不能由云任务绕过。云工作者的角色权限仍分离，云端只读 artifact 访问范围须在执行前固定，禁止访问 holdout、私有交易接口和 exchange credentials。

TaskReceipt payload 必填：`task_id`、`state=PLANNED/QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED`、`attempt`、`worker_identity`、`input_hashes/output_hashes`、`checkpoint_ref`、`reason_codes`、`audit_record_sha256`。重试使用原逻辑 ID；不重置模拟账户、模型预算或去重账。CANCEL 终止该任务的新草案/订单排队，记录已发生的虚拟状态，不能删除日志。任务取消本身不新增代码保护禁令，也不能覆盖账户已有 kill/manual stop；保护是否执行完全遵循所选原代码 profile 的停止、恢复、行情与持久化安全门。

未知云供应商、认证、权限或实际交付证据均记为 UNBOUND/NOT_RUN；这份契约不声称云协调已集成。
