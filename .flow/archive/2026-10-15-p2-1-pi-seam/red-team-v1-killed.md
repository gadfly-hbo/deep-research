# Red-Team:P2-1 全部模型调用改经 pi-agent-runtime(提案 v1)

**Verdict:Kill(按当前书面形态)。** 两个承重假设被代码证据直接证伪,另三个未裁决参数任意取值即翻车。修正路径全部存在且以天计——修正清单满足后可重提为 go。方向(接点 1 合规、vendored tgz、唯一 Adapter、fallback 替代 withChain、344 测试零影响面)全部核实成立。

## Top Kill-Assumptions

### KA1 runWorker 硬 `JSON.parse` 无法复现鲁棒解析 → 7 阶段+extract 应全改 runText
- 证据:runtime `runWorker` 的 convert 是 `text => validate(JSON.parse(text))`(dist/index.js:432),不去围栏不截取;解析失败 → INVALID_OUTPUT(:375-380)且**不触发备用**(:287)。对照现状 parseJsonLoose(去围栏+截 JSON 块,live.ts:120-141)、draftFromText(裸 Markdown 直接当报告,live.ts:189-200,注释明言"模型常不守 JSON 包装")。
- 修正:全部改 **runText**(validate 收原始文本,原样复用三个解析器;标准明示文本任务可用 runText)。

### KA2 同 taskId 并发 extractClaims 撞 TASK_BUSY
- 证据:gather 以 maxParallel=4 Promise.all 并发抽取(runResearch.ts:317-340);memory store 同 taskId 只许一个 lease,第二个 → TASK_BUSY → blocked(dist/budget.js:16-17,index.js:89-91)。
- 修正二选一:(a) adapter 内按 taskId 串行(4 路并发降串行,gather 墙钟显著变长,需用户知情);(b) **每调用派生子 taskId(`runId:callKey`)+ 审计前缀聚合**(推荐——本批额度本就名义化,P2-2 正式设计账本)。

### KA3 有限 Limits 无单次模型超时;host abort → CANCELLED 不切备用
- 证据:单次超时只在 **uncapped** 策略(modelTimeoutMs,policy.js:7-11,index.js:265-266),超时经 modelRecovery 切下一候选(:286-297);有限 limits 只有累计墙钟;现状 300s 超时切备用是 minimax 挂起时 xiaomi 接管的现行机制(modelFailover.ts:7,live.ts:260/304)。
- 修正:本批 Limits 用 **`cumulative:'unlimited'` + modelTimeoutMs:300_000 + modelRecovery:{extraAttempts:1}**——这才是与现状真正等价的形态(现状本无累计额度,只有单次 300s)。"宽裕有限 Limits"反而引入不存在的累计天花板。

### KA4 maxOutputTokens 缺席;带备用链时缺省即 INVALID_REQUEST
- 证据:带 fallbacks 时每候选必须显式 maxOutputTokens ≤ contextWindow(types.d.ts:15-16,index.js:203-205);截断=stop'length'=INVALID_OUTPUT 无 fallback。兄弟产品已踩坑 8192 打满(reports-factory model.ts:71),取 minimax 32768/mimo 16384。
- 真值表(已核实,pi-ai 内建数据+兄弟实测互证):minimax-cn/MiniMax-M3 = anthropic-messages + `https://api.minimaxi.com/anthropic`,contextWindow 1_048_576,reasoning true,**maxOutputTokens 32_768**;xiaomi mimo-v2.6-flash = openai-completions + `https://token-plan-cn.xiaomimimo.com/v1`,contextWindow 128_000,**16_384**(pi-ai 0.86.1 内建无 v2.6-flash,必须全显式)。

### KA5 熔断在同账本下不可复刻
- 证据:现状熔断是跨调用状态;runtime fallbacks 每次从候选 0 重新开始;adapter 按熔断裁剪候选链 → configuration 签名变 → CONFIGURATION_CHANGED → blocked。
- 修正:**书面接受放弃熔断**,代价(故障期每调用一次失败延迟;快失败可忍,挂起型由 KA3 的 300s 单次超时兜底)写进批次说明交用户知情。

## 次级发现(全部进提案 v2)

- 缺密钥:现状缺 key 抛错→切备用;createPiTransport 创建时即抛 → adapter 须跳过无 key 候选(reports-factory transportFor 返回 null 是现成样板)。
- 错误文案降级为类别级(failureCategory 经 onEvent 可观察);configuration 签名锁定(limits 逐字节一致,不得按阶段变);memory store 同进程取消恢复累计墙钟(本批名义化低危,P2-2 持久化解决)。
- 0.4.3 措辞应为"本地固定候选+哈希锁定"(RELEASE-v0.4.3.md 自述未经 Git 发布;tgz 哈希/内容已核验一致)。
- backfill-titles 需要自由文本 → piRuntime 需暴露 runText 类方法。
- liveDraft.test 改 import 路径;modelFailover.test 随退役删除;"344 全绿"表述改为 344−删+增;建议顺手补 engines node>=24.21.0。
- 空 system 不上线的 xiaomi 保护已核实成立;createPiTransport 无别的坑(maxRetries:0、显式 key、无环境发现)。

## 开放问题裁决(红队建议)

1. AuditSink → workspace 级 `research-data/model-audit.jsonl`(兄弟先例同款;项目级富化留 P2-2)。
2. costEstimate → 本批恒 0(用户决策④既定,P2-2 硬删字段+UI 清理),作为本批唯一特许可观测变化。
3. 熔断 → 接受放弃(知情)。
4. ModelConfig 真值表如上,直接钉入。
5. "runWorker 覆盖 7 阶段"应改写为"runText 覆盖"。
