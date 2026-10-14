# PRD:P0-1 分解 runResearch —— 内部接缝抽取(行为不变)

> 提案源:`.flow/proposal.md`(2026-10-14);红队:`.flow/red-team.md`(verdict: go,附动工前置条件)。
> 无 issue tracker(docs/agents/issue-tracker.md 不存在),落盘本文件。

## Problem Statement

维护者视角:`runResearch` 是一个约 1090 行的单函数体(文件 1222 行,图谱圈复杂度 320),采证、干预指令、预算判定、阶段样板、发布门禁全部挤在共享可变闭包(`state`/`run`/`currentQuestion`/`directionNotes` 等)里。后果:改任何一处都要在全函数上下文里推理;发布门禁这类纯计算无法脱离整条流水线单独测试;新人定位逻辑靠全文搜索。

## Solution

保留唯一执行入口 `runResearch(request, adapters, store, options)` 这个深外接缝不动,在实现内部建接缝:把发布门禁抽成纯函数、把重复 4-5 次的采证装配/快照构造/阶段样板收敛成内部 helper、把预算判定集中到 BudgetTracker、给 limitations 去重一个显式 helper。**先补验证网再动工**(红队前置条件):当前 `npm test` 没有任何测试用 recording/replay 适配器跑 `runResearch`,fake 适配器不读 callKey——重构前先用金样本测试把"行为不变"变成可证伪的断言。

## User Stories

1. 作为维护者,我想单独单测发布门禁的判定输出(降级、置信度、limitations 有序数组),不必驱动整条流水线,以便快速迭代质量规则。
2. 作为维护者,我想修改降级/多源/信源分级规则时只动一个文件,而不是在编排器里找 156 行内联逻辑。
3. 作为维护者,我想新增一种采证来源时只调用一个采证装配函数,而不是复制第四份 claim+evidence 组装块。
4. 作为维护者,我想用金样本测试证明重构前后适配器调用序列(callKey)、run 落盘序列(persistRun 时机)、bundle 内容逐位一致。
5. 作为维护者,我想旧版本落盘的 checkpoint(v1 形状)恢复行为被测试锁住,RunState 字段调整不会静默反转 `limited`→`published`。
6. 作为维护者,我想预算判定(搜索/抓取/成本/墙钟/逐问题配额)集中一处,调阈值只改一个模块。
7. 作为维护者,我想 limitations 的"去重 push"与"有意重复 push"语义显式区分,不被全局 helper 误统一。
8. 作为评审者,我想六项抽取按序分任务推进、每步有独立验证证据,失败可归因到单项。

## Implementation Decisions

- **0. 验证基线先行(红队前置条件,先于一切重构)**:
  - 金样本测试:recordingAdapters 包 fake 模型/搜索/抓取跑完整 runResearch 全流程,断言适配器调用 kind+callKey 的有序序列(金样本 JSON 入库提交);同时断言 saveRun 调用的 stage 序列(persistRun 时机,锁住 UI 进度粒度)。
  - v1 checkpoint 恢复夹具:固化一份当前形状的 checkpoints.json(模拟旧版落盘),断言恢复后 run 语义等价(尤其 `capped`→`limited` 不反转)。
- **1. 发布门禁 → `src/quality/publishGate.ts` 纯函数**(与既有检查器同层同风格):输入为 state 的只读快照 + moduleConfig;输出变更后的 claims(含 kind/confidence 突变)、verdicts、新增 limitations(有序)、unresolved、reasons 与报告段落素材。编排器负责把输出写回 state,突变顺序保持现状:mergeCrossSourceClaims → 降级 → 置信度 → unresolved。**边界:`stopAfter:"gather"` 早退路径的报告组装(现 `:816-829`)不在本次范围,逐位保留。**
- **2. 采证装配 → `attachExtraction`**:统一 gather/指令补充/附件/复用绑定四条路径。必须保留的真实语义分歧:gather 的 snapshot 是 findIndex 替换更新(重采刷新 title/fetchedAt),其余 push-only;reuse 的 claim scopeNote、evidence revision/versionId 直连绑定、claim 级去重;gather 在搜索前清该问题旧主张证据。id 前缀方案(`:ci`/`:ins${ci}`/`attachments:`/`reuse:`)逐位保留(进 bundle 与披露文案)。**kill criterion(红队):统一函数若需 >3 个策略开关,拆为两个(gather 用 / 其余共用),不追求单一收敛。**
- **3. 快照构造 → `snapshotFrom`**:共 5 处(红队更正:含 `:605` user-text 路径,proposal 漏计)。保留各处 tier/title 回退语义(网页标题优先于搜索 title;附件视为 A 级一手来源;复用按 docType 分 B/C;user-text 无 tier)。
- **4. 阶段样板 → `runStageSafe`(附 kill criterion)**:动工前先列五段对照表(persistRun 时机/plan 段无 persistRun、polish 刻意 persistRun("draft")/saveCp 的 stage+data 形状/fallback/coercion/限制文案)。helper 须逐位复现;**若需 >4 个配置项,降级为只抽真同构子集或放弃本项**(红队 kill criterion;这是"行为不变"硬约束的直接推论)。
- **5. `addLimitation()` 只用于带去重守卫的站点**:约 4 处无条件 push(复用资产逐条披露、disclose 指令原文)是有意重复,**保持不变**。
- **6. 预算判定 → `BudgetTracker`**:集中 searches/fetches/cost/wall 判定与逐问题配额计算;**`capped` 字段留在 RunState,`{...state}` checkpoint 序列化形状零 diff**(对 v1 夹具);helper 只包判定,不挪字段。
- **抽取顺序(红队建议,失败可归因):#5 → #1 → #3 → #6 → #2 → #4**,每项独立验证后推进。
- **不导出新增公共 API**:内部接缝留在 `src/core/`(helper 可同文件置顶或新文件),`publishGate` 例外(落 `src/quality/`,与被它聚合的五个检查器同层)。
- **不宣称行数目标**:"收敛到 400-500 行"仅作参考,不是验收标准;验收=金样本 diff 为空 + 新纯函数单测就位 + 既有测试全绿。

## Testing Decisions

- 好测试=只断言外部可观察行为:适配器调用序列、saveRun/saveCheckpoint 序列与数据形状、bundle 关键字段、纯函数的完整输出(含 limitations **有序**数组,禁用 `includes` 弱断言)。
- 被测模块:新增 `src/quality/publishGate.ts` 及抽出的内部 helper(各配纯函数单测);`runResearch` 整体经金样本测试回归;既有 `runResearch.test.ts`/`pipeline.test.ts` 等全部原样通过。
- Prior art:`src/quality/citationVerifier.test.ts`(纯函数快照断言)、`src/core/pipeline.test.ts:150-185`(恢复测试)、`src/adapters/replay.test.ts`(夹具回放)。

## Out of Scope

P0-2(快照存储写放大/轮询负载)、P1-3(server.ts 路由拆分)、P1-4(UI)、`src/contracts.ts`、`src/adapters/types.ts`、模块配置与质量判定规则、任何行为变更(含 limitations 文案、披露顺序、run 状态机时机)。

## Further Notes

- 红线:callKey 是 recording/replay 的唯一查找键(`src/adapters/recording.ts:8`);checkpoint 是 `research-data/` 下的存量真实数据,按字段名恢复。
- `polish` 阶段刻意 `persistRun("draft")`(润色是草稿子环节,run.stage 从不为 polish),任何样板收敛不得"修正"这一点。

## PRD diff gate(vs proposal.md,auto 模式记录)

以下为本 PRD 相对 proposal.md 的全部增改点(无删除用户决策项;均系红队证据驱动的护栏与勘误,且服从 proposal 硬约束 2「行为不变」):

1. **[新增]** 验证基线三测试(金样本 callKey/saveRun 序列、v1 checkpoint 恢复夹具)——红队前置条件,把 proposal 硬约束 2 从声明变成可证伪断言。
2. **[新增]** 六项抽取顺序 #5→#1→#3→#6→#2→#4 与逐项独立验证——红队建议,降低归因难度。
3. **[勘误]** 快照构造为 5 处(proposal 写 4 处,漏 `:605` user-text);`addLimitation` 不适用 4 处有意无条件 push(proposal "约 10 处"为不完全统计)——红队代码核实。
4. **[护栏]** #4 runStageSafe 附 kill criterion(>4 配置项则降级/放弃)、#2 attachExtraction 附 kill criterion(>3 策略开关则拆两个)——红队设定,是 proposal 硬约束 2 的执行机制,不改变六项承诺范围:能逐位复现则全做。
5. **[澄清]** "收敛到 400-500 行"降为参考指标,移出验收标准——红队指出其无验证口径。

---

## GRILL 决议

### 第 1 轮(盲审,explore 子代理;9 packages,全部按推荐采纳)

- **R1.1 金样本形状**:三份金样本落 `testdata/golden/`——G1 干净全流程(固定 request.id/runId)、G2 修复回环(gap 补采 `gather:r1` + review regather `gather:r10` + rephrase `draft:fix0`)、G3 干预最小集(add-source 文本 + add-questions)。双层断言:(a) recordingAdapters 包 fake 录制 `[{kind,key}]` 有序序列与金样本 `toEqual` 全等;(b) replayAdapters 回放同一金样本,断言 run.status、bundle claims id 序、verdicts、limitations **有序数组**、reportMd 与录制轮一致,比较前归一化 fetchedAt/wallMs/completedAt。saveRun 序列断言 `{stage,status}` 有序 + 末次 progress 计数四元组;干净全流程期望 stage 序列:gather → gather×每问 → analyze → draft → draft(polish 段刻意) → review → publish。附件与 library 复用不进金样本(既有 attachments/reuseIntegration 测试已覆盖)。fake 保真度:parser 返回可命中/不命中引句的 bodyText,extractClaims 返回带 calibration 的 claims,驱动 verifyCitations 两态与跨源合并。
- **R1.2 v1 checkpoint 夹具**:不拷真实存量数据(228K 真实网页正文,臃肿且有第三方内容);用当前代码合成 capped 场景(budget.maxFetches=1 跑完 gather 后取消),手工冻结 plan+gather 两条 checkpoint 为 `testdata/v1-checkpoints.json`,配套 cancelled run 对象内嵌测试。断言三点:(a) 恢复后 `run.status==="limited"`(capped 不反转);(b) 恢复轮 0 次 search 调用;(c) gather checkpoint data 键集合与当前 RunState 11 键白名单逐一相等(`Object.keys().sort()` 对手写常量 `toEqual`)——把字段静默 drift 变成红灯。
- **R1.3 publishGate 签名**:落 `src/quality/publishGate.ts`。输入 `{claims, evidence, snapshots, questions, claimQuestions, draftMd, capped, counterexampleChecked, limitations, goal, moduleConfig, incremental?{baseRunId,reusedSnapshots,reusedEvidence,reusedClaims}}`;输出 `{claims, verdicts, limitationsToAppend(有序), unresolved, reasons, reportMd, status}`。moduleCheck 进门内(reasons 单产地);reportMd 门内拼完整成品,`incrementalNote`/`claimMark` 闭包纯化为 incremental 计数与 claimQuestions 查表;不深拷贝(注释声明调用方不得复用输入 claims;单测内 structuredClone 夹具);`stopAfter:"gather"` 早退路径不碰。编排器写回=5 行机械赋值,bundle 组装留编排器(依赖 request.outline 与 incrementalBundleFields)。
- **R1.4 attachExtraction → 触发 kill criterion,拆两个**:核实分歧维度 7 个(snapshot 替换 vs push×3 形态、claim id 方案、claim 替换/push/去重、scopeNote、versionId/revision 来源、claimQuestions 值、ingest 与否),远超 >3 阈值。拆为 `attachGatherExtraction`(gather 专用:findIndex 替换语义)+ `attachExtraction(state, snapshot, extracted, scope)`,scope 为判别联合 `{kind:"question",qid,infix:""|"ins"} | {kind:"attachments"} | {kind:"reuse",bindingId,versionId,revisions,scopeNote}`(1 个开关)。cost 累加留调用点(不耦合计费与装配);gather 搜索前清旧 claims(:334-339)留循环原位(语义是补采重置);saveSnapshot/ingest 不进函数(复用路径不 ingest 是真实分歧)。
- **R1.5 snapshotFrom**:只做字面量集中——`snapshotFrom({id,url,title,bodyText,parseStatus,contentType,tier?,now?})`;id/title/tier 推导留调用点(tierOfSource 依赖 moduleConfig、docType 判定依赖 source,非"构造"本身);`fetchedAt` 五处同一表达式进函数,`now?: string` 注入点供单测确定化(缺省取当前时,行为不变)。
- **R1.6 BudgetTracker**:无所有权判定器——不持计数器、不持 capped;`usage` 以读访问器注入(`() => run.usage`),`now: () => number = Date.now` 可注入假钟;方法 `overBudget()/canSearch()/fetchQuota(remaining)/fetchRoom(perQuestion,fetchedForQ)/shouldCapOnTake(takeLen)` 逐位复刻现判定点;`state.capped=true` 写留编排器原点位。单测伪造 usage 序列+假钟打边界值(恰满/差一/超一,尤其 fetchQuota 的 Math.max(1,…) 下钳与 shouldCapOnTake 的 >=)。
- **R1.7 runStageSafe → 触发 kill criterion,只抽 analyze+draft 子集**:五段对照表(行号全核实)显示差异 ≥7 维(plan 无 persistRun;polish 刻意 persistRun("draft")+四重门控;rephrase 无 cancelled/persistRun/overBudget/saveCp 任何一件),超 >4 阈值。helper 4 个配置项 `{stage, callKey, parseSpec:{schema,coerce?,fallback,limitation}, apply}`;plan/polish/rephrase 保持内联(其"异常"是行为语义载体)。五段对照表落 runStageSafe.ts 头注释作评审 checklist。
- **R1.8 文件布局(全部新文件,同目录配测试)**:`src/core/runState.ts`(RunState+emptyState+safeParse,三者被编排器与各 helper 共享)、`src/core/limitations.ts`、`src/quality/publishGate.ts`、`src/core/snapshotFrom.ts`、`src/core/budgetTracker.ts`、`src/core/attachExtraction.ts`、`src/core/runStageSafe.ts`,各配 `*.test.ts`。runResearch.ts 改为 import,**导出集合保持五个不变,新文件可 export 但不得从 runResearch.ts re-export**("同文件置顶"选项与硬约束 1/4 冲突,删除)。
- **R1.9 gather 内部不再分解 + 验收口径钉死**:gather 循环骨架(取消/指令消费/状态机/finally 清场)是编排语义本体,#2/#6 已吃掉其中可抽部分,不再进一步分解(proposal 待决问题 3 结案)。验收四条:(a) `npm test` 全绿(含金样本 diff 空、record/replay 一致、v1 恢复、新纯函数单测);(b) `npm run typecheck` 全绿(含 ui tsconfig,防新文件类型错误漏网);(c) 无 lint 门槛(工具链不存在,不新增);(d) 逐项独立验证=每项抽取后重跑 (a)+(b)。基线:283 用例全绿(2026-10-14 子代理实测)。

### 第 2 轮(主会话自审;3 packages,全部按推荐采纳)

- **R2.1 取消/早退传播纪律**:闭包内 `if (cancelled()) return cancelRun()` 共 8 处;抽出的 helper 一律**不感知取消**——helper 返回结果,`cancelled()` 检查与 `cancelRun()` 早退只留在 runResearch 编排器原点位(gather 循环体保持内联,天然满足)。单测不构造取消场景给纯函数。
- **R2.2 提交节奏**:每个任务(Tn)完成即本地 commit(不 push),归因到单项(红队缓解);SHIP 阶段一次性 push(review_base 为流程前 HEAD,diff 口径不受影响)。
- **R2.3 任务完成证据口径**:勾选任务必须附证据行——该任务 `npm test`/`npm run typecheck` 的输出摘要(用例数/exit code);金样本类任务附金样本文件路径。

第 2 轮后无新增开放问题,GRILL 收敛(2/2 轮)。
