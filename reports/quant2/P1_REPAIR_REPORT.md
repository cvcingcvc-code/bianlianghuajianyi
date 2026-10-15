# P1：bianlianghuajianyi 运行问题修复与历史阻塞记录

日期：2026-10-15（Asia/Shanghai）。范围仅研究、回测和虚拟资金 Paper 工程验证；无实盘、杠杆或策略调整。本报告描述当前工作树及留存测试结果，不代表云端环境已发布、真实模型可用或生产就绪。

## 接管基线和本次结果

- 仓库：`cvcingcvc-code/bianlianghuajianyi`；接管 HEAD：`b9039770594499cb598fcf7b07e0e2cad34d6a35`。
- 工作分支：`codex/offline-usability-bianliang-20261015`。远端只读核对 `git ls-remote origin HEAD refs/heads/master` 返回同一基线 SHA；未回退已有提交。
- Node `v24.19.0`，npm `11.9.0`；工作目录 `/workspace/bianlianghuajianyi`。
- 本轮基线：197 项，182 通过、15 失败、0 跳过；修复后：199 项，186 通过、13 失败、0 跳过。
- 两个旧 parity 失败已修复，并增加两个严格回归用例；现有其余 13 项失败集合保持相同，没有新增失败。独立 parity 验证 6/6 通过。
- 历史全套数据验收仍为 **BLOCKED**；其失败不以离线冒烟通过为由忽略。此前全项目 49 项失败、1 项跳过的原始记录未覆盖，本次仓库留存的 15 项基线也完整保留。

## 修复的问题、原因和边界

问题：`tests/parity.test.js` 的旧 RSI 参考实现仍要求不可同时满足的 `rsi < 60 && rsi > 65`，但已存在的提交 `d8bdbf06118c872d4c3048141e3e176898224371` 明确将生产逻辑改成上一根 RSI >=60、当前 RSI <60 的回落退出，并将既有 golden master 固定到 `LONG@109 / CLOSE@126`。两项 parity 断言仍将生产逻辑与改动前的 `CLOSE@130` 参考比较，因而与仓库已记录的行为合同冲突。

修改文件：`tests/parity.test.js`。保留旧 `oldRsiSignal` 原样，增加独立参考适配函数，只应用 `d8bdbf0` 已有的退出修正。独立参考仍自己计算指标，不调用生产 `computeSignal`；逐根动作仍使用完整数组的 `assert.deepEqual`，没有改成容差比较、仅检查类型或跳过异常。

新增严格检查：旧参考必须是 `LONG@109 / CLOSE@130`，当前合同参考必须是 `LONG@109 / CLOSE@126`，且差异只能在第 126、130 根。阈值用例明确锁定 previous RSI=60、59、null，当前 RSI=60、50，空仓及 warmup 条件；现有 golden master 的断言和值未修改。

策略、指标设置、交易参数、成本模型、研究 gate、留出锁、依赖及 lockfile 均未修改。文档和日志归档属于交付证据。此次收尾复用已完成测试，不重复运行可能访问历史输入的全套测试；未恢复、下载、解锁或分析 2026 留出输入。

## 验证命令和前后结果

以下命令的工作目录均为 `/workspace/bianlianghuajianyi`，日志由本轮此前已完成的实际执行保存；收尾阶段将其按原字节复制到本仓库证据目录。

| 命令 | 修改前 | 修改后 | 证据 |
| --- | --- | --- | --- |
| `npm test` | 197 tests / 182 pass / 15 fail / 0 skip | 199 tests / 186 pass / 13 fail / 0 skip | `evidence/p1-bianliang/baseline-20261015.log`、`full-after-20261015.log` |
| `node --test tests/parity.test.js` | 两项失败已在全套基线中保留 | 6 tests / 6 pass / 0 fail / 0 skip | `evidence/p1-bianliang/parity-after-20261015.log` |
| `git diff --check` | — | 通过 | 提交前实际执行，无空白错误 |

`evidence/p1-bianliang/SHA256SUMS` 固定三份完整日志的 SHA256。日志保存了每项测试名、失败堆栈、实际/预期哈希和 runner 计数；数据身份无法确认时不更新预期哈希。

## 剩余 13 项失败逐项分类

以下路径和行号来自 `full-after-20261015.log`。缺失输入的测试在读取阶段失败，不代表其后续数据正确性断言已经验证；保留这些断言。

| # | 测试位置和名称 | 分类、实际原因 | 状态及解除条件 |
| --- | --- | --- | --- |
| 1 | `tests/externalValidationV1.test.js:26` — BNB official data normalization: loads, sorted, contains 2026 | 历史市场数据缺失；`data/market/BNBUSDT-15m.csv` 不存在 | BLOCKED：官方来源及身份校验；涉及 2026 的部分须另行授权，不能用开发期数据冒充完整数据 |
| 2 | `tests/externalValidationV1.test.js:34` — SOL official data normalization: loads, sorted, contains 2026 | 历史市场数据缺失；`data/market/SOLUSDT-15m.csv` 不存在 | BLOCKED：同上 |
| 3 | `tests/externalValidationV1.test.js:42` — checksum validation: every downloaded official zip matches its .CHECKSUM | 历史市场数据缺失；`data/market/raw/BNBUSDT` 不存在，缺少原始 ZIP 与 CHECKSUM | BLOCKED：获取官方归档并按官方 CHECKSUM 验证；不能跳过校验 |
| 4 | `tests/externalValidationV1.test.js:59` — listing-date handling: first 4h candle is after the first 15m, first year is partial | 历史市场数据缺失；读取 BNB CSV 失败 | BLOCKED：经过来源和身份校验的外部资产输入 |
| 5 | `tests/externalValidationV1.test.js:72` — 4h aggregation reuses the V4 resampler (16x15m) on external data | 历史市场数据缺失；读取 BNB CSV 失败 | BLOCKED：同上；不得改聚合断言 |
| 6 | `tests/externalValidationV1.test.js:90` — warmup: first trade occurs only after EMA/breakout warmup | 历史市场数据缺失；读取 BNB CSV 失败 | BLOCKED：同上；不得缩短 warmup |
| 7 | `tests/externalValidationV1.test.js:102` — external assets are isolated (independent accounts) | 历史市场数据缺失；读取 BNB CSV 失败，后续 SOL 输入也未验收 | BLOCKED：真实 BNB/SOL 输入及独立账户验收 |
| 8 | `tests/externalValidationV1.test.js:118` — 2026 holdout guard blocks strategy execution on 2026 data | 历史市场数据缺失；内存 guard 断言先执行，随后读取 BNB CSV 失败 | BLOCKED：保留留出锁；不以单独 guard 通过宣称完整数据用例通过 |
| 9 | `tests/holdoutDataAcquisition.test.js:17` — 2026 kline data can be read by data validator | 历史市场数据缺失；`data/market/BTCUSDT-15m.csv` 不存在 | BLOCKED：本任务不解锁或恢复 2026 输入 |
| 10 | `tests/holdoutDataAcquisition.test.js:116` — funding CSV SHAs in manifest match actual files | 文件或哈希不一致；BTCUSDT funding 实际 SHA 与 manifest 不同 | BLOCKED：单独查清原始数据身份及 manifest 来源，不能改黄金哈希或盲目恢复历史版本 |
| 11 | `tests/holdoutDataAcquisition.test.js:153` — 2026 kline data has no missing bars | 历史市场数据缺失；BTC CSV `ENOENT` | BLOCKED：保留完整性验收和 2026 禁止访问约束 |
| 12 | `tests/holdoutDataAcquisition.test.js:173` — 2026 kline data has no duplicates | 历史市场数据缺失；BTC CSV `ENOENT` | BLOCKED：同上 |
| 13 | `tests/realFundingAcquisition.test.js:74` — manifest SHA256 matches actual CSV file | 文件或哈希不一致；与 #10 相同 BTC funding 身份冲突的另一处 gate | BLOCKED：同 #10，不以两个失败误报两个独立数据损坏事件 |

归类总数：历史数据或官方归档缺失 11；文件/哈希不一致 2；修复的旧断言冲突 2；本仓库当前失败中未观察到 Windows/Linux、外部网络或新的功能缺陷类失败。此分类以实际失败点为限，不为未执行到的后续断言担保。

两处哈希断言均记录：实际 `8d1321d99c01d9d351e1ab45aeb9ac5ee2abd5679ee0ed1eb3a3b42dc65ef7ec`，预期 `674683b67d80a3d2336dab330e27617a0d31c32324a45661b9d02ceb59fd7d98`。当前 `git status --porcelain=v1 -- data` 无输出，说明它不是本次未提交数据修改造成；这不能证明历史数据本身已正确。`bbc44c9` 仅作为后续来源调查的历史提交线索，本报告没有经过可复查证据确认可安全恢复的 CSV，因此不声称历史身份已解决。

## 安全与下一步验收

- 提交范围只含严格测试修正、状态文档、此报告和三份日志及其校验清单；提交前对这些文本执行密钥形态和当前敏感环境变量值的内存扫描，不输出变量值。
- 不使用 `npm start`、`start:dry` 或 `start:reset-breaker`；这些旧入口不属于本次批准的研究工作流。使用环境既有离线研究入口，真实订单保持禁用。
- 本仓库职责维持研究、回测和数据校验；Phase 8A 工作台复用与 Paper 集成在 `quant-trading-2` 完成，不在本仓库重复构建。
- 下一步先明确开发期官方数据可取得性和 funding 来源，再决定单独的数据修复任务。任何包含 2026 的恢复或验收继续受留出锁约束，本任务不会为通过率扩大范围。
- 修复提交 SHA 在后续 `docs/PROJECT_STATUS.md` 收据中记录，避免把未知或自引用 SHA 写入本提交；独立分支按普通 push 同步，不覆盖 master，不强推。
