# P1(P2-1)PRD:Pi 接缝合规 —— 全部模型调用改经 pi-agent-runtime(形态不变)

> 规格源:`.flow/proposal.md`(v2)+ `.flow/red-team.md`(v2 红队 Go 附 6 强制修正,全部并入)+ `docs/PLAN-AGENTIZATION.md`。用户已确认:放弃熔断;costEstimate 本批恒 0。
> 无 issue tracker,按回退规则落盘本文件。

## Problem Statement

接入标准接点 1 要求产品业务代码零直接 Pi import,只允许经共享包 Adapter。现状 `src/adapters/live.ts` 与 `scripts/backfill-titles.mts` 直接 import `@earendil-works/*`(pi-agent-core/pi-ai),自建主备链/熔断/解析绕行,游离于标准的授权、账本、审计护栏之外。

## Solution

vendor `pi-agent-runtime-0.4.3.tgz`(本地固定候选+哈希锁定),新建全项目唯一 Adapter `src/adapters/piRuntime.ts`,以 `createRuntime` + **runText** 重实现 ModelProvider 的 8 个调用点(extractClaims + 7 runStage);主备链交 runtime fallbacks + modelRecovery;对上层 pipeline/服务器/UI 除 costEstimate 恒 0 外零可观测变化。

## User Stories

1. 作为维护者,我要 Pi 调用只经一处 Adapter,以便升级 SDK/换供应商只改一个文件。
2. 作为维护者,我要每次模型调用进授权/账本/审计护栏,以便符合接入标准并为 P2-2+ 打底。
3. 作为用户,我要研究报告的产出与现在完全一致(解析降级、主备切换、超时语义),以便无感升级。
4. 作为维护者,我要既有 344 级别测试全绿与真实 Provider 冒烟,以便放心合并。

## Implementation Decisions

### D1 Vendor 与依赖

- `vendor/pi-agent-runtime-0.4.3.tgz`(SHA-256 `475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70` 记入 vendor/README)。
- package.json:删 `@earendil-works/*`;加 `"pi-agent-runtime": "file:vendor/pi-agent-runtime-0.4.3.tgz"`;补 `engines.node: ">=24.21.0"`;npm install 重建 lockfile(传递依赖 pi 两包 0.86.1 由 tgz 锁)。

### D2 piRuntime Adapter(`src/adapters/piRuntime.ts`)

- **runText 映射 8 调用点**:prompt=现有 STAGE_PROMPTS+输入 JSON(不用 system 参数);**validate 槽位省略**;taskId=`dr:${callKey}`(callKey 现有约定,已内嵌 keyBase)。
- **RunResult→契约三分映射表(红队强制)**:
  1. `succeeded` → 对 value(原始文本)跑对应全函数解析器(parseClaims/parseJsonLoose/draftFromText)返回 `{output, cost:0}`;
  2. `failed` 且 `reason==='INVALID_OUTPUT'`(含 stop'length' 截断)→ `{output:{}, cost:0}`,由编排器现有降级链兜底(schema 拒→fallback+limitation,与现状 parse 失败逐帧一致);
  3. 其余 `failed`(MODEL_FAILED/DEADLINE_EXCEEDED/STATE_FAILED/AUDIT_FAILED)与 `blocked` → throw(等价现状 withChain 终态)。
- **ModelConfig 真值表**:主 minimax-cn/MiniMax-M3 = anthropic-messages + `https://api.minimaxi.com/anthropic` + ctx 1_048_576 + maxOutputTokens 32_768 + reasoning true(仅声明);备 xiaomi mimo-v2.6-flash = openai-completions + `https://token-plan-cn.xiaomimimo.com/v1` + ctx 128_000 + 16_384(pi-ai 无内建,全显式)。config.json 自定义路径沿用现有判断。无 key 候选**跳过**(transportFor 样板)。
- **limits 恰好五键**(policy.js 校验):`cumulative:'unlimited'`、`maxOutputTokens:32_768`(备用自动 min)、`modelTimeoutMs:Number(env.DR_MODEL_TIMEOUT_MS ?? 300_000)`、`toolTimeoutMs:30_000`、`controlTimeoutMs:30_000`;`modelRecovery:{extraAttempts:1}`;native retry 关。limits 由单一 builder 生成,进程内逐字节一致。
- **五必要输入**:authorize=model 与 **publish 均放行**(红队强制:成功路径强制 publish 授权,拒绝即全灭;结果仅进程内返回无外发;本批无 tool/external);audit=AuditSink 追加 `research-data/model-audit.jsonl`(单行 JSON<4KB、O_APPEND 本地盘并发安全、无 fsync 断电可丢尾——本批名义审计可接受;**research-data/.gitignore 加 `model-audit.jsonl`** 防双机同步冲突);budgets=createMemoryBudgetStore;onEvent=DR_DEBUG 旁路。
- **1MiB 护栏(红队 Top-1)**:adapter 拼 extract prompt 前按 ~1MiB 预算对 bodyText 留头截断(丢尾部保 run;存量实测最大 541KB 零超限,保险性质)。
- **usage 映射**:costEstimate 恒 0(用户既定;P2-2 硬删);modelCalls/outputTokens 进 DR_DEBUG 观察不进契约。

### D3 退役与清理

- live.ts 删全部 @earendil-works import(STAGE_PROMPTS/三解析器迁出供 piRuntime 与 liveDraft.test 复用);**modelFailover.ts 拆分而非整删**——isTransientProviderError 迁 searchFailover.ts(搜索主备仍用),其 3 个测试用例随迁,仅删 ModelCircuitBreaker 与其 2 个用例。
- scripts/backfill-titles.mts 与 6 个 scripts/probe-*.mts 改经 piRuntime(piRuntime 暴露 runText 通用方法);typecheck/rg 抓不到的坏引用清零。
- 验收:`rg -l "@earendil-works" src/ scripts/ ui/` 仅 piRuntime.ts(且其只 import pi-agent-runtime)。

### D4 行为差异披露清单(除 costEstimate 恒 0 外的既定差异)

1. 单次瞬时抖动直接换模型(旧:原地重试 1 次再换;共 4 次尝试→2 次)——标准 P4 接法。
2. 熔断放弃(用户确认):故障期每调用一次失败延迟,挂起型 300s 兜底。
3. 错误文案类别化(failureCategory),供应商原文不再透出。
4. memory store Map 按调用线性累积(server 长跑,每条数百 B;P2-2 解决)。

## Testing Decisions

- **合成 transport 离线单测**(新文件,≥6 条):(a) 围栏 JSON plan/裸 Markdown draft → 解析正常;(b) 并发 8 调用同前缀 taskId → 零 TASK_BUSY;(c) transport **监听 signal 于 abort 时 reject**(与 fetch 一致)→ modelTimeoutMs 到期 → modelRecovery 切备用成功(钉 KA3;永不 settle 的 transport 不切备用是错误写法);(d) 无 key 候选跳过;(e) **截断(INVALID_OUTPUT)→ adapter 返回 {output:{}} → 编排器 fallback+limitation 落 run**;(f) 审计事件落盘形状。
- 既有套件:344 − 2(熔断用例)全绿;liveDraft.test 3 用例改 import 路径后绿;npm test + typecheck + rg 接点 1 验收。
- **真实 Provider 冒烟**(本机双密钥):正常链 plan-preview 一发(MiniMax-M3);切换链主候选 endpoint→`http://127.0.0.1:9` → ECONNREFUSED → 秒级切 mimo 成功(红队裁定的可行设计;401/拔 key 均演示不了切换)。
- runResearch 全链 replay 夹具(fake adapters)不受影响——piRuntime 只替换 live 通道。

## Out of Scope

P2-2(预算正式映射/审计富化/costEstimate 硬删+UI 清理);P2-3+ 会话化;thinking 启用;跨机审计口径;模型输出质量评估。

## Further Notes

- 0.4.3 措辞:本地固定候选+哈希锁定(未经 Git 发布,内容已核验与 repo HEAD 逐字节一致)。
- v1 kill 报告存 `.flow/red-team-v1-killed.md`。

---

## PRD diff gate 记录(auto)

相对 proposal v2:全部为红队强制修正/开放问题裁决的并入,无 change/drop 已决事项——

1. 勘误:authorize"publish 拒绝"→"放行"(红队证明拒绝=每次调用 blocked 全灭,直接违反提案自身"零可观测变化"硬约束;属规格错误修复)。
2. 并入:limits 五键完整表、三分映射表+validate 省略、taskId 简化 `dr:${callKey}`、审计 .gitignore、1MiB 护栏、冒烟改 ECONNREFUSED、modelFailover 拆分、probe 脚本处置、测试(c)(e) 改写、行为差异披露 4 条。
3. 裁决:开放问题 1/2/3 按红队建议(见 D2)。

---

## GRILL 第 1 轮决议(author-blind 子代理,9 包全部采纳)

1. **R1-1 模块形状**:新建纯逻辑模块 `src/adapters/modelText.ts`(STAGE_PROMPTS+EXTRACTION_SYSTEM_PROMPT+parseClaims/parseJsonLoose/draftFromText+prompt 拼装);piRuntime.ts import 它;liveDraft.test 改指 modelText;LiveModelConfig/密钥表/resolveApiKey 随工厂迁 piRuntime.ts(cli 与 probes 改 import);live.ts 剩 httpSearch/livePage/liveParser/cleanPageTitle;ModelProvider 接口不动(cost 字段保留恒 0)。
2. **R1-2 ModelConfig 通用映射(PRD 答错修正)**:三分规则——(a) 真值表两候选精确匹配;(b) baseUrl+api 自定义路径→ctx 128_000/maxOutputTokens 8_192/endpoint=baseUrl/protocol=api(沿用现状默认);(c) 其余内建 provider/modelId 本批显式拒绝(报错指明改 config.json 提供 baseUrl+api 或用真值表;probe 的 M2.7 随改 M3)。零可用候选→抛与现状同形"缺少模型密钥"错。
3. **R1-3 runtime 实例**:进程级惰性单例(首次构造 ModelProvider 时创建;config/env 变更需重启——与现状模块级 MODEL_TIMEOUT_MS 语义一致);D4.4 披露相应改写(单例下 memory store Map 跨请求累积,披露成立)。
4. **R1-4 三分映射补全(PRD 答错修正)**:extract 的 INVALID_OUTPUT→`{claims:[], cost:0}`(空 claims→unanswered,编排器已覆盖);**D4 增第 5 条披露**:draft/polish 截断(>32k)从"残文静默入报告"变为"fallback+limitation 披露"(方向更优但非一致)。其余 stage 走查等价性成立(plan safeParse 种子兜底;preview 裸 parse 同形;formal try/catch 兜底;analyze/review/fix coerce({})→{}→schema 拒→fallback)。
5. **R1-5 DR_DEBUG 双行制**:adapter 自计时 `[model] <callKey> Ns ok claims=N|text=N|degraded`(provider 经 onEvent 按 taskId 关联);onEvent 失败事件 `[model] provider/model attempt failed <reason>/<failureCategory>`;接受乱序丢失。
6. **R1-6 1MiB 口径**:prompt 拼完后 `Buffer.byteLength` 度量;extract 预算=1_048_576−8KB 开销,超出对 bodyText 按字节留头截断;stage 输入不截断(有界推理:claims×quote≤80 字封顶);存量实测最大 553,727B 零触发,纯保险。
7. **R1-7 脚本形状**:piRuntime 暴露 `runFreeText({prompt, callKey}): Promise<{text}>`(复用单例与 limits;backfill 45s→300s 差异备注);6 probes 改 import+M2.7→M3;probe-multiround cost 累计恒 0 加注释"成本观测已退役";固定 callKey 单进程顺序无 TASK_BUSY。
8. **R1-8 依赖验收**:vendor tgz+package.json+lockfile 同一提交;干净克隆 `npm ci` 成功入验收(传递包需网络/缓存,如实注);engines 警告级,双机 node≥24.21 写批次说明;ui/vite 无影响已核实。
9. **R1-9 审计增长**:本批接受无界(单 run 25-65KB 估算入 PRD),P2-2 定保留/轮转;research-data/.gitignore 为新建文件,含 `model-audit.jsonl`。

## GRILL 第 2 轮决议(主代理自审)

无新开放问题(vendor README 内容、测试文件落位 src/adapters/piRuntime.test.ts、env 覆盖路径命中 R1-2(c) 拒绝规则等均为实现期细节)。**GRILL 收敛(2 轮)**。本批无用户可见 UI 范围 → UI-GATE skipped → ISSUES。
