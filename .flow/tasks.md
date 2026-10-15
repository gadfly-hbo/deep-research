# P2-1 任务切片(Pi 接缝合规)

来源:`.flow/prd.md`(v2 红队 6 修正 + GRILL 9 决议并入)。切片自批准(auto):依赖链机械导出,无自由裁量。

- [x] 1. T1 vendor 与依赖 — 证据:npm install 重建 lockfile;node_modules pi-agent-runtime@0.4.3 + 传递 pi 两包 0.86.1 就位;npm test 344 绿(未动代码);干净克隆 npm ci 成功;提交 58074fc
- [x] 2. T2 modelText 迁出 — 证据:typecheck 过;344 全绿(liveDraft 3 用例改指 modelText);提交 cb39975
- [x] 3. T3 piRuntime Adapter — 证据:rg @earendil-works 全仓零命中(含 piRuntime——只 import pi-agent-runtime);cli/backfill/6 probes 改经新通道(M2.7→M3);typecheck+344 绿
- [x] 4. T4 modelFailover 拆分 — 证据:isTransientProviderError+3 用例迁 searchFailover,熔断器+2 用例删;344−2=342 绿;提交 7682f38(T3+T4 同提交)
- [x] 5. T5 合成 transport 测试 — 证据:7 条新测试(围栏/裸文、并发零 TASK_BUSY、挂起超时切备用、截断降级桶、审计形状、缺密钥/真值表外拒绝)全绿;全仓 57 文件 349 绿;npm ci 干净安装过;提交 775253c
- [x] 6. T6 真实冒烟 — 证据:正常链 MiniMax-M3 18.0s 8 问(DR_DEBUG ok 行 provider 关联正确);切换链主候选 127.0.0.1:9 → failed MODEL_FAILED/network → 15.5s 切 mimo 10 问;审计 jsonl 落盘(version 1.0/taskId dr: 前缀)且被 gitignore

---

## 1. T1 vendor 与依赖

## What to build

复制 runtime 仓 artifacts/releases/0.4.3/ 下 tgz 到 `vendor/`(vendor/README 记 SHA-256 与来源);package.json 删 `@earendil-works/*` 两依赖、加 file:vendor 引用、补 engines;`npm install` 重建 lockfile;新建 `research-data/.gitignore`(含 `model-audit.jsonl`);干净克隆模拟验收(删 node_modules+`npm ci` 或 `npm ci` 直跑)。

## Acceptance criteria

- [ ] `npm ci` 干净安装成功;node_modules/pi-agent-runtime@0.4.3 + 传递 pi 两包 0.86.1 就位
- [ ] tgz/package.json/lockfile 同一提交;`npm test` 仍全绿(尚未动代码)

## Blocked by

None

---

## 2. T2 modelText.ts 纯逻辑迁出

## What to build

新建 `src/adapters/modelText.ts`:STAGE_PROMPTS、EXTRACTION_SYSTEM_PROMPT、parseClaims、parseJsonLoose、draftFromText、extract prompt 拼装(R1-1);live.ts 删除这些与 pi 相关代码(剩 httpSearch/livePage/liveParser/cleanPageTitle 及其依赖);liveDraft.test.ts 改 import modelText。**不动 pi import**(T3 才删)——本步纯移动+改引用。

## Acceptance criteria

- [ ] liveDraft.test 3 用例经 modelText 路径全绿;liveParser.test 不动仍绿
- [ ] `npm test && npm run typecheck` 全绿

## Blocked by

T1

---

## 3. T3 piRuntime.ts Adapter

## What to build

`src/adapters/piRuntime.ts`(唯一 import pi-agent-runtime):createRuntime 进程级惰性单例(R1-3);ModelConfig 三分映射(R1-2:真值表两候选/自定义 baseUrl+api/其余显式拒绝;无 key 候选跳过);limits 五键 builder(R1:unlimited+32768+DR_MODEL_TIMEOUT_MS??300_000+30_000+30_000)+modelRecovery:1;runText 承载 8 调用点(validate 省略;三分映射表:INVALID_OUTPUT→{output:{}}/{claims:[],cost:0},其余 failed/blocked→throw);1MiB 字节护栏(R1-6);AuditSink→research-data/model-audit.jsonl(单行 JSON);authorize model+publish 放行;DR_DEBUG 双行制(R1-5);`runFreeText` 通用方法(R1-7)。live.ts 删全部 @earendil-works import 与 piAiModel/LiveModelConfig/ENV_KEY/resolveApiKey/streamFnFor/withChain;cli.ts 与 scripts(backfill+6 probes,M2.7→M3)改 import piRuntime。

## Acceptance criteria

- [ ] `rg -l "@earendil-works" src/ scripts/ ui/` 仅 piRuntime.ts;piRuntime 只 import pi-agent-runtime
- [ ] `npm test && npm run typecheck` 全绿(fake/recording/replay 不受影响)
- [ ] typecheck 对 scripts/ 不覆盖(已知),rg 验收补位

## Blocked by

T2

---

## 4. T4 modelFailover 拆分

## What to build

isTransientProviderError 迁 `src/adapters/searchFailover.ts`(搜索主备仍用),modelFailover.test 的 3 个 isTransient 用例随迁;删 ModelCircuitBreaker 与其 2 个用例、modelFailover.ts 文件。

## Acceptance criteria

- [ ] searchFailover 相关测试(mcpSearch/xiaomiSearch/searchFailover 链)全绿
- [ ] 全仓测试账 = 344 − 2 + (T5 新增)

## Blocked by

T3(同一提交窗口内可并)

---

## 5. T5 合成 transport 测试 + 全仓验收

## What to build

`src/adapters/piRuntime.test.ts`(手写合成 ModelTransport):(a) 围栏 JSON plan/裸 Markdown draft 解析正常;(b) 并发 8 调用同前缀 taskId 零 TASK_BUSY;(c) transport 监听 signal 于 abort reject → modelTimeoutMs 到期 → 切备用成功;(d) 无 key 候选跳过;(e) 截断 INVALID_OUTPUT → {output:{}} → runStageSafe fallback+limitation 落 run(走查 draft 场景);(f) 审计事件落盘形状(临时目录)。加干净克隆 `npm ci` 验收(R1-8)。

## Acceptance criteria

- [ ] ≥6 条新测试全绿;全套件绿;rg 接点 1 验收过
- [ ] `npm ci` 干净安装验证记录

## Blocked by

T3+T4

---

## 6. T6 真实 Provider 冒烟

## What to build

本机双密钥:(1) 正常链——起 serve,plan-preview 一发(MiniMax-M3),对照输出形状;(2) 切换链——临时 config 主候选 endpoint 指 `http://127.0.0.1:9` → ECONNREFUSED → 秒级切 mimo 成功;(3) DR_DEBUG 双行日志可读。冒烟后还原 config,记录证据。

## Acceptance criteria

- [ ] 两链各有真实输出与计时;日志含 ok 行与 failed 切换行
- [ ] 冒烟产生的 model-audit.jsonl 行形状正确且被 gitignore

## Blocked by

T5
