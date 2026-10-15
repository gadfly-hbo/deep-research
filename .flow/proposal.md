# 提案 v2:P2-1 Pi 接缝合规 —— 全部模型调用改经 pi-agent-runtime(形态不变)

> v1 红队 kill(报告 .flow/red-team.md,2026-10-15 已归档于本文件末尾链接的流程记录);本 v2 按其修正清单重写,用户已确认两点知会:①放弃熔断(KA5);②costEstimate 本批恒 0(P2-2 硬删)。
> 规格:~/Dev/Projects/pi-agent-runtime/docs/AGENT-RUNTIME.md + docs/INTEGRATION.md;程序源 docs/PLAN-AGENTIZATION.md(用户 4 决策)。
> 本批不含:P2-2 预算正式映射/审计富化/成本字段硬删;P2-3+ 会话化;其他一切行为变化。

## 背景(红队已核实)

- 接点 1 违规两处:`src/adapters/live.ts` 与 `scripts/backfill-titles.mts` 直接 import @earendil-works。
- `pi-agent-runtime` 0.4.3 = **本地固定候选+哈希锁定**(tgz SHA-256 与目录名一致、dist 与 repo HEAD 逐字节相同;RELEASE-v0.4.3.md 自述未经 Git 发布——采用此准确措辞);SDK 0.86.1 精确系列由 runtime 锁定;engines node ≥24.21.0(本机满足,产品 package.json 顺手补 engines)。
- 兄弟产品消费模式 `file:vendor/pi-agent-runtime-<ver>.tgz` + 自有 lockfile integrity 固定,核实成立。

## 本批内容

### 1 Vendor 与依赖

`vendor/pi-agent-runtime-0.4.3.tgz`(自 runtime 仓 artifacts/releases/0.4.3/ 复制,SHA-256 记入 vendor/README);package.json 删 `@earendil-works/*` 直接依赖、加 `"pi-agent-runtime": "file:vendor/pi-agent-runtime-0.4.3.tgz"`、补 `engines.node >=24.21.0`;npm install 重建 lockfile(传递依赖 pi 两包 0.86.1 由 tgz 锁定)。

### 2 新 Adapter `src/adapters/piRuntime.ts`(全项目唯一 import pi-agent-runtime 处)

以 `createRuntime` + **runText**(红队 KA1 裁决:runWorker 硬 JSON.parse 无法复现鲁棒解析)重实现 ModelProvider:

- **8 个调用点映射**(extractClaims + 7 runStage):prompt=现有 STAGE_PROMPTS + 输入 JSON(不用 system 参数,xiaomi 怪癖保护红队已核实成立);validate 收**原始文本**,原样复用 parseClaims/parseJsonLoose/draftFromText——解析失败时沿用现状编排器降级链路(runStageSafe 的 fallback/coerce),不变成 run 失败。
- **ModelConfig 真值表**(红队 KA4 核实,直接钉入):

| 候选 | provider/modelId | protocol | endpoint | contextWindow | maxOutputTokens | reasoning |
|---|---|---|---|---|---|---|
| 主 | minimax-cn / MiniMax-M3 | anthropic-messages | https://api.minimaxi.com/anthropic | 1_048_576 | 32_768 | true(仅声明,不启用 thinking) |
| 备 | xiaomi-token-plan-cn / mimo-v2.6-flash | openai-completions | https://token-plan-cn.xiaomimimo.com/v1 | 128_000 | 16_384 | — |

  config.json 自定义路径(baseUrl+api)沿用现有判断生成 ModelConfig;transport 一律 `createPiTransport`(显式 apiKey;**无 key 候选创建时即抛 → adapter 跳过该候选**,reports-factory transportFor 样板)。
- **Limits(KA3 裁决)**:每候选 `cumulative:'unlimited'` + `modelTimeoutMs:300_000` + `modelRecovery:{extraAttempts:1}`——与现状等价(现状无累计额度,仅单次 300s;单次超时经 modelRecovery 切下一候选,正是现行 minimax 挂起→xiaomi 接管机制)。configuration 签名锁定:同 taskId 全部调用 limits 逐字节一致。
- **taskId 粒度(KA2 裁决,方案 b)**:每调用派生子 taskId `dr:${runId}:${callKey}`(callKey 沿用现有约定)——不撞 TASK_BUSY,保住 gather 4 路并发;审计/账本按前缀聚合;P2-2 正式设计任务账本。
- **五必要输入**:authorize=宿主预授权(model 类只读变换放行;publish 类拒绝);audit=AuditSink 追加 workspace 级 `research-data/model-audit.jsonl`(append 失败上抛=审计 fail-closed;兄弟先例同款);budgets=createMemoryBudgetStore(实现 claimUncapped);onEvent=旁路观察(DR_DEBUG 调试用)。
- **usage 映射**:Usage.outputTokens/modelCalls 可得;**costEstimate 本批恒 0**(用户已确认,本批唯一特许可观测变化;P2-2 硬删字段+UI 清理)。错误文案降级为类别级(failureCategory),依赖原文案的正则分类(modelFailover)随之退役。

### 3 退役与清理

- live.ts 删全部 @earendil-works import(STAGE_PROMPTS/解析器迁 piRuntime.ts 或纯逻辑模块,liveDraft.test 改路径);ModelCircuitBreaker/withChain/isTransientProviderError 退役(modelFailover.ts + modelFailover.test.ts 删);**熔断放弃已获用户确认**(故障期每调用一次失败延迟,挂起型 300s 兜底)。
- scripts/backfill-titles.mts 改经 piRuntime(piRuntime 额外暴露 runText 通用方法供自由文本用途)。
- 完成后:src/ 与 scripts/ 除 piRuntime.ts 外零 @earendil-works import(rg 验证入验收)。

### 4 验证

- **合成 transport 离线单测**(pi-agent-runtime/testing 或手写 ModelTransport):(a) 围栏 JSON plan/裸 Markdown draft → runText+解析器正常(钉 KA1);(b) 并发 8 调用同前缀 taskId → 零 TASK_BUSY(钉 KA2);(c) transport 永不 resolve + modelTimeoutMs → 切备用成功(钉 KA3);(d) 无 key 候选跳过;(e) validate 拒绝路径走编排器降级;(f) 审计事件落盘形状。
- 既有测试:344 − modelFailover.test(删) − liveDraft 路径调整 + 新增;npm test + typecheck 全绿;rg 接点 1 验证。
- **真实 Provider 冒烟**(本机双密钥):plan-preview 一发(MiniMax-M3 主链)+ 断主 key 模拟切备用(xiaomi 链一发),对照现状输出形状。

## 约束

- 除 costEstimate 恒 0 外零可观测变化(阶段 IO 形状、usage 字段名、错误可读性类别化已披露)。
- 不引框架;不动 contracts.ts 对外形状;recording/replay 夹具格式不动(零 pi 依赖已核实)。

## 开放问题(v2 红队/GRILL 再挖)

1. runText 的 validate 返回值形状与现状 adapter 契约(StageOutput/ExtractedClaim[])的贴合度;draft/polish 的 coerceDraftOutput 降级链在 runText 语义下的等价性细节。
2. `research-data/model-audit.jsonl` 的并发 append(4 路并发抽取)是否需要串行化队列(runtime 对单 run 的 AuditSink.append 串行排队——但我们是多 run 并发子 taskId)。
3. DR_MODEL_TIMEOUT_MS 环境变量覆盖(modelTimeoutMs 是否沿用其值)。
