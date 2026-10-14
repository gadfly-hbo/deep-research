# Tasks:P0-1 分解 runResearch(内部接缝抽取)

> 源:`.flow/prd.md`(含 GRILL 决议 R1.1-R1.9、R2.1-R2.3)。无 issue tracker,落盘本文件。
> 切片口径:验证网(T1/T2)先行,其后每片=一个抽取物 + 单测 + 编排器接线 + 全量回归绿。
> 依赖:T1/T2 阻塞一切重构;T3 阻塞 T4-T9;其余按序。每片完成即本地 commit(R2.2)。

## 检查清单

- [x] 1. 金样本测试:record/replay 双层(callKey 有序序列 + saveRun 序列) — 证据:npm test 286/286 绿(基线 283+新增 3);金样本 testdata/golden/{g1-clean-pipeline,g2-repair-loop,g3-intervention}.json;G1 saveRun 序列逐位命中人工推导期望值
- [x] 2. v1 checkpoint 恢复夹具测试(键集合白名单 + capped→limited 锁定) — 证据:npm test 288/288 绿(+2);夹具 testdata/v1-checkpoints.json(11 键白名单、capped=true);生成器 scripts/gen-v1-checkpoints.mts
- [x] 3. 迁移 runState.ts(RunState / emptyState / safeParse) — 证据:typecheck 双 tsconfig 绿;npm test 288/288 绿(金样本 diff 空);runResearch.ts 导出集合不变(5 个)
- [x] 4. 抽取 #5 addLimitation → limitations.ts — 证据:typecheck 绿;npm test 290/290 绿(+2 单测;金样本 diff 空);6 处守卫站点替换,:730/:745/:1027 等无条件 push 逐位保留;safeParse 同步统一
- [x] 5. 抽取 #1 发布门禁 → quality/publishGate.ts — 证据:typecheck 绿;npm test 300/300 绿(+10 publishGate 单测,limitationsToAppend 有序 toEqual);金样本 diff 空;编排器写回=机械赋值;早退路径零 diff;runResearch.ts 1222→1035 行
- [x] 6. 抽取 #3 快照构造 → snapshotFrom.ts — 证据:typecheck 绿;npm test 302/302 绿(+2 snapshotFrom 单测,含 now 注入);5 处构造全部改走 snapshotFrom(tier 缺省两处逐位保留);金样本 diff 空
- [ ] 7. 抽取 #6 预算判定 → budgetTracker.ts
- [ ] 8. 抽取 #2 采证装配 → attachExtraction.ts(两函数)
- [ ] 9. 抽取 #4 阶段样板 → runStageSafe.ts(仅 analyze+draft 子集)

---

## 1. 金样本测试:record/replay 双层

### What to build

建立行为不变的可证伪基线:recordingAdapters 包 fake 适配器跑完整 `runResearch`,把 `[{kind, key}]` 有序适配器调用序列与 saveRun `{stage,status}` 序列固化为金样本;replayAdapters 回放同一金样本再跑一遍,断言两侧 run.status / bundle claims id 序 / verdicts / limitations 有序数组 / reportMd 一致(时间戳字段归一化)。三份金样本(R1.1):G1 干净全流程(单问题两来源、带 calibration 的 claims)、G2 修复回环(analyze gap 补采 + review regather + rephrase)、G3 干预最小集(add-source 文本 + add-questions)。金样本 JSON 落 `testdata/golden/`。

### Acceptance criteria

- [ ] 三份金样本入库,`[{kind,key}]` 有序序列 `toEqual` 全等
- [ ] record 与 replay 两轮产物(归一化后)一致;replay 缺 key 抛错路径不被触发
- [ ] saveRun `{stage,status}` 有序序列断言:G1 = gather → gather×每问 → analyze → draft → draft(polish) → review → publish
- [ ] 末次 progress 计数四元组(answered/open/skipped/total)入断言
- [ ] `npm test` 全绿(基线 283 + 新增)

### Blocked by

None - can start immediately

---

## 2. v1 checkpoint 恢复夹具测试

### What to build

锁定 RunState 序列化形状与恢复语义(R1.2):用当前代码合成 capped 场景(budget.maxFetches=1 跑完 gather 后取消),手工冻结 plan+gather 两条 checkpoint 为 `testdata/v1-checkpoints.json`,配套 cancelled run 对象内嵌测试;memory store 种入后以同 request.id 重跑(fake 给干净输出)。

### Acceptance criteria

- [ ] 恢复后 `run.status === "limited"`(capped 不反转为 published)
- [ ] 恢复轮 0 次 search 调用(gather checkpoint 命中跳过)
- [ ] gather checkpoint data 键集合与 RunState 11 键白名单 `Object.keys().sort()` 逐一 `toEqual`
- [ ] 夹具 `capped: true`;`npm test` 全绿

### Blocked by

None - can start immediately

---

## 3. 迁移 runState.ts

### What to build

把 `RunState` 类型、`emptyState`、`safeParse` 从 runResearch.ts 移到 `src/core/runState.ts` 并 export(供编排器与后续 helper 共享);runResearch.ts 改 import,导出集合保持五个不变(R1.8)。

### Acceptance criteria

- [ ] runResearch.ts 导出集合 = {runResearch, resolveBudget, DEFAULT_BUDGET, RunOptions, RunResult} 不变
- [ ] T1 金样本 diff 为空;T2 键集合断言仍绿
- [ ] `npm test` + `npm run typecheck` 全绿

### Blocked by

1, 2

---

## 4. 抽取 #5 addLimitation → limitations.ts

### What to build

`src/core/limitations.ts` 提供 `addLimitation(list, note)`(去重 push);只替换 runResearch.ts 中带 `if (!includes)` 守卫的站点;4 处有意无条件 push(复用资产披露、disclose 指令等)保持原样(R1.4 边界、红队次要失败模式)。

### Acceptance criteria

- [ ] 带守卫站点全部改走 addLimitation;无条件 push 逐位保留
- [ ] limitations.ts 单测:去重/保序/原样返回
- [ ] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3

---

## 5. 抽取 #1 发布门禁 → quality/publishGate.ts

### What to build

把 `runResearch.ts:1040-1196` 的发布门禁抽为纯函数 `evaluatePublishGate(input): output`(签名按 R1.3:含 moduleCheck 门内化、reportMd 门内完整组装、incremental 计数纯化、不深拷贝、编排器 5 行机械写回)。`stopAfter:"gather"` 早退路径逐位保留不碰。

### Acceptance criteria

- [ ] publishGate.test.ts 按 citationVerifier.test.ts 风格断言完整输出快照,limitationsToAppend 有序 `toEqual`(禁 includes);覆盖降级/蕴涵/数值/多源/单源/仅C级/置信度/moduleCheck 分支
- [ ] 编排器写回 = claims/limitations/unresolved/status 机械赋值
- [ ] 早退路径 reportMd 组装零 diff
- [ ] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3

---

## 6. 抽取 #3 快照构造 → snapshotFrom.ts

### What to build

`snapshotFrom({id,url,title,bodyText,parseStatus,contentType,tier?,now?})` 集中 5 处 SourceSnapshot 字面量(gather/指令URL/user-text/附件/复用);id/title/tier 推导留调用点;fetchedAt 进函数,`now?` 注入点缺省取当前时(R1.5)。

### Acceptance criteria

- [x] 5 处构造全部改走 snapshotFrom,tier 缺省语义(tier 为 undefined 的两处)逐位保留
- [x] snapshotFrom 单测(含 now 注入)
- [x] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3

---

## 7. 抽取 #6 预算判定 → budgetTracker.ts

### What to build

`BudgetTracker` 无所有权判定器(R1.6):`overBudget()/canSearch()/fetchQuota(remaining)/fetchRoom(perQuestion,fetchedForQ)/shouldCapOnTake(takeLen)` 逐位复刻现判定点;usage 读访问器 + `now` 注入;计数器写与 `state.capped=true` 写留编排器原位;`{...state}` checkpoint 形状零 diff。

### Acceptance criteria

- [ ] budgetTracker 单测:假钟 + 伪造 usage 序列,五方法边界值(恰满/差一/超一;fetchQuota 的 Math.max(1,…) 下钳;shouldCapOnTake 的 >=)
- [ ] T2 键集合断言仍绿(capped 未挪位)
- [ ] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3

---

## 8. 抽取 #2 采证装配 → attachExtraction.ts(两函数)

### What to build

按 R1.4(kill criterion 已触发,7 分歧维度):`attachGatherExtraction`(findIndex 替换语义)+ `attachExtraction(state, snapshot, extracted, scope)`,scope 判别联合 `{kind:"question",qid,infix:""|"ins"} | {kind:"attachments"} | {kind:"reuse",bindingId,versionId,revisions,scopeNote}`。cost 累加、搜索前清旧、saveSnapshot/ingest 均留调用点;id 前缀逐位保留。

### Acceptance criteria

- [ ] 四条路径(gather/指令/附件/复用)全部改走两函数;gather snapshot 替换语义与 reuse scopeNote/revision/去重逐位保留
- [ ] 两函数单测:id 形状、替换/push/去重、claimQuestions 值、scopeNote/revision
- [ ] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3

---

## 9. 抽取 #4 阶段样板 → runStageSafe.ts(仅 analyze+draft 子集)

### What to build

按 R1.7(kill criterion 已触发,差异 ≥7 维):helper 仅覆盖 analyze+draft 真同构子集,配置项 `{stage, callKey, parseSpec:{schema,coerce?,fallback,limitation}, apply}`;plan/polish/rephrase 保持内联;五段对照表落 runStageSafe.ts 头注释作评审 checklist。

### Acceptance criteria

- [ ] analyze/draft 两段改走 runStageSafe;plan/polish/rephrase 逐位内联保留(尤其 polish 的 persistRun("draft"))
- [ ] runStageSafe 单测(含 safeParse 失败降级路径)
- [ ] saveRun stage 序列金样断言仍绿(persistRun 时机零漂移)
- [ ] 金样本 diff 为空;`npm test` + `npm run typecheck` 全绿

### Blocked by

3
