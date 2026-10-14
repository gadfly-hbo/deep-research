# 提案:P0-1 分解 runResearch —— 外部接口不变,只建内部接缝(纯重构)

> 来源:2026-10-14 重构审查(基于 codebase-memory 图谱:圈复杂度/扇入/边界 + 六个核心文件通读),
> 用户以 `/dev-flow P0-1` 选定本提案为范围。同一审查中的 P0-2(快照存储/轮询负载)、P1-3(server.ts 拆分)、
> P1-4(UI)均不在本次范围,不得顺手做。

## 背景证据(已核实)

- `src/core/runResearch.ts` 共 1222 行,`runResearch` 单函数体约 1090 行(130→1222),图谱圈复杂度 320、transitive_loop_depth 7,为全仓库最大热点。
- `state`/`run`/`currentQuestion`/`directionNotes`/`activeGatherTargets`/`snapshotVersionMap`/`addQuestionCounter` 全是共享可变闭包,函数内部没有任何可独立测试的接缝——想测发布门禁或采证配额,只能整条流水线跑 replay 夹具。
- 外接缝本身是深的、刻意设计(README:「缝合点:runResearch(request, adapters, store) 唯一执行入口」),`src/adapters/types.ts` 4 个小接口 + 3 个真实适配器(live/recording/replay),**两者都不动**。

## 六项抽取(本次全部实施)

| # | 抽取物 | 现状证据 | 目标 |
|---|--------|---------|------|
| 1 | 发布门禁 → `src/quality/publishGate.ts` 纯函数 | `runResearch.ts:1040-1196` 约 156 行纯计算(verdicts 蕴涵/数值复算、降级、多源交叉、信源分级、置信度聚合、reasons),与既有 quality 检查器同构 | 成为与 `citationVerifier.test.ts` 同风格的纯函数单测对象 |
| 2 | 采证装配统一 → `attachExtraction` | "extractClaims 结果 → claim+evidence 入 state"出现 4 次:`:401`(gather)、`:521`(attachExtracted)、`:669`(附件)、`:765`(复用绑定),仅 id 前缀/scopeNote/去重细节略异;attachExtracted 已抽出却只服务指令路径 | 收敛为一个函数 |
| 3 | 快照构造统一 → `snapshotFrom` | SourceSnapshot 字面量构造 4 处:`:373`、`:594`、`:655`、`:748` | 一个构造器 |
| 4 | 阶段执行样板收敛 → `runStageSafe` | plan/analyze/draft/polish + review 内 rephrase 五段同骨架(cancelled → persistRun → overBudget? → runStage → cost += → safeParse → saveCp):`:460`、`:857`、`:899`、`:932`、`:1003` | 一个 helper |
| 5 | `addLimitation()` | `if (!state.limitations.includes(x)) push(x)` 约 10 处 | 一行 helper |
| 6 | 预算追踪 → `BudgetTracker` | searches/fetches/wall/cost 检查内联散布 6 处(`:197`、`:328`、`:356`、`:361`、`:367` 等),gather 圈复杂度 58 | 配额判定集中一处 |

## 硬约束(不得违反)

1. **外部接口不变**:`runResearch(request, adapters, store, options)` 签名与语义、导出集合(`runResearch`/`resolveBudget`/`DEFAULT_BUDGET`/`RunOptions`/`RunResult`)不变。
2. **行为不变(纯重构)**:适配器调用序列与 callKey 生成(如 `${keyBase}:gather:r${round}:search:${q.id}`)、checkpoint 数据形状、run 状态机、bundle/限制/披露文案语义全部等价。replay 夹具测试原样通过是核心证据。
3. **不动** `src/contracts.ts`、`src/adapters/types.ts`,不改模块配置、质量判定规则。
4. 每个抽出的内部接缝补与 `citationVerifier.test.ts` 同风格的纯函数单测(新逻辑可测;被搬走的逻辑靠现有回放测试保回归)。

## 验证

`npm test`(vitest,replay 夹具)+ `npm run typecheck` 全绿;预期编排器收敛到约 400-500 行纯顺序逻辑。

## 待决问题(留给红队/GRILL)

- publishGate 落 `src/quality/`(与其他检查器同层)还是 `src/core/`(与编排器同层)?
- attachExtraction / BudgetTracker / runStageSafe 的参数形状与放置文件(新文件 vs 留在 runResearch.ts 顶部)。
- gather 内部(loop、per-question 配额、并行窗口)是否也抽,还是只做六项的最小集合?
- 检查点恢复路径(checkpoint data shape 引用 RunState 字段)在移动 RunState 定义时如何保持兼容。
