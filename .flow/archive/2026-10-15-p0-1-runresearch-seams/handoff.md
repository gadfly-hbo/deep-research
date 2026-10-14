# handoff — P0-1 runResearch 内部接缝分解(2026-10-15 完成)

## 本批次交付

- runResearch.ts 1222 → 969 行,抽出 7 个内部接缝:`runState.ts`(RunState/emptyState/safeParse)、`limitations.ts`(addLimitation)、`snapshotFrom.ts`、`budgetTracker.ts`、`attachExtraction.ts`(attachGatherExtraction + attachExtraction 两函数)、`runStageSafe.ts`(仅 analyze+draft)、`quality/publishGate.ts`。
- 验证基线:金样本 record/replay(`golden.test.ts` + `testdata/golden/g1..g3`)、v1 checkpoint 恢复夹具(`resumeV1.test.ts` + `testdata/v1-checkpoints.json`,生成器 `scripts/gen-v1-checkpoints.mts`)。
- 提交 49e6294..4a6e152 已推 origin/main;verify:`npm test && npm run typecheck` 315/315 绿、双 tsconfig 绿。

## 开放项(下一批次入口)

- **P0-2**:快照存储/轮询负载(本次未做)。
- **P1-3**:server.ts 拆分;**P1-4**:UI 侧重构(均未做)。
- **N1(non-blocking)**:resumeV1.test.ts 键白名单是单向锁(fixture↔常量),建议补 `expect(Object.keys(emptyState()).sort()).toEqual([...RUNSTATE_KEYS].sort())` 形成双向锁。
- **N2(non-blocking)**:runStageSafe 的 spec 字面量使编排器净增 10 行;若 analyze/draft 配置继续膨胀再评估。

## 下一批次前置条件

- 改 RunState 字段前必须先读 `src/core/resumeV1.test.ts` 的键白名单与 `testdata/v1-checkpoints.json`(checkpoint 按字段名恢复,存量 run 兼容是硬约束)。
- 金样本重生成:`UPDATE_GOLDEN=1 npx vitest run src/core/golden.test.ts`(仅在有意变更行为时)。
- gather 循环骨架、stopAfter:"gather" 早退路径、polish 的 `persistRun("draft")` 均为刻意保留形态,勿"顺手修正"。
