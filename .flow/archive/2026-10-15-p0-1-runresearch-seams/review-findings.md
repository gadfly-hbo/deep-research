# 代码评审：P0-1 分解 runResearch(49e6294..0d3bf96,9 提交)

**Verdict: PASS**(0 blocking;2 non-blocking;1 信息性记录)

双轴结论:Standards 轴无文档化标准违反(仓库无 lint 工具链,以 PRD/既有惯例为准);Spec 轴九条任务验收项逐项命中,proposal 四条硬约束全部成立,逐位行为守恒抽查(T5 写回、T7 六处判定、T8 四条装配路径、T9 两段样板)未发现语义漂移。

## 独立验证(本轮重跑,非引用既有记录)

- `npm test`:exit 0,**54 文件 315/315 绿**(与 VERIFY 记录的 315/315 一致;墙钟实测约 3.9s vs 记录 8.3s,环境差异,计数与退出码两项实质证据完全吻合)。
- `npm run typecheck`:exit 0,双 tsconfig(`tsconfig.json` + `ui/tsconfig.json`)均无输出。
- 测试数证据链闭合:基线 283 + 3(golden)+ 2(resumeV1)+ 2(limitations)+ 10(publishGate)+ 2(snapshotFrom)+ 5(budgetTracker)+ 4(attachExtraction)+ 4(runStageSafe)= 315,与各任务勾选证据行逐一相符。

## 核心不变量核验

- `src/core/runResearch.ts:44-81` 导出集合恰好 `{DEFAULT_BUDGET, resolveBudget, RunOptions, RunResult, runResearch}`,无 `export {}` re-export;六个新文件仅被 runResearch.ts 与彼此 import,未从 runResearch.ts 再导出。
- `src/core/resumeV1.test.ts:19-31` 11 键白名单与 `testdata/v1-checkpoints.json` gather checkpoint 实际键集合相等(独立解析 fixture 复核),`capped:true`、恢复后 `limited`、恢复轮 0 次 search 三断言就位。
- 金样本 `src/core/golden.test.ts` 对三份入库 fixture 做 callKey 有序 `toEqual` + record/replay 产物全等(status/claims id 序/kind:confidence 序/verdicts/limitations 有序/unresolved/reportMd/saveRun 序列),G1 saveRun 序列人工推导值含 polish 段刻意 `draft`。
- 越界扫描:diff 未触碰 `src/contracts.ts`、`src/adapters/types.ts`、`src/modules/*`、既有质量检查器;`.gitignore` +1 行是 T2 fixture 入库所必需的放行,在范围内。

## 逐位保留抽查(对 base 49e6294 逐 hunk 比对)

- **T7 BudgetTracker**:`canSearch()` 否定式 ≡ 旧 `searches >= max || overBudget()`;`fetchQuota` 的 `Math.max(1, Math.floor(...))` 下钳、`shouldCapOnTake` 的 `>=`、`overBudget` 的 `>` 语义逐位保留(`budgetTracker.ts:17-45`);`state.capped=true` 与计数器写全部留在编排器原位。
- **T8 attachExtraction**:gather 路径 findIndex 替换语义、id 前缀四种方案(`:ci`/`:ins${ci}`/`attachments:`/`reuse:`)、reuse 的 claimId 去重跳过、scopeNote 双挂、`revisions[evidenceId] ?? 1` 直连绑定均逐位对应;cost 累加、快照 push 语义、saveSnapshot/ingest 留调用点,符合 R1.4 拆分边界。
- **T5 publishGate**:写回确为机械赋值(`runResearch.ts:943-948`);limitations 合并序(旧=orig+五条披露+对 orig+披露去重后的 reasons;新=allLimitations 同构构造)等价;incrementalNote 模板与 base `:464-468` 逐字一致;`stopAfter:"gather"` 早退路径(`runResearch.ts:673-674`)零 diff;QUESTION_STATUS_LABEL 移除安全(base 中仅门禁一处使用)。
- **T9 runStageSafe**:仅 analyze(:727)+ draft(:773)两处调用;plan(:379-400)/polish(:805-831,保留 `persistRun("draft")`)/rephrase(:881)逐位内联;helper 内顺序 call→onCost→safeParse→apply 与旧内联一致,不感知取消(R2.1 ✓)。
- **T4 addLimitation**:base 7 处带守卫站点(含 safeParse 内 1 处)全部改走 helper;4 处有意无条件 push(base :162/:730/:745/:1027 → 现 :113/:617/:632/:906)逐位保留。

## Findings

### Non-blocking

**N1. checkpoint 键白名单锁是单向的(spec 部分命中)** — `src/core/resumeV1.test.ts:63-69`
现状:测试比较的是**冻结 fixture** 的键集合与手写常量 `RUNSTATE_KEYS`,而非当前代码的 `emptyState()` 键集合。恢复路径为 `Object.assign(state, cp.data)`(`runResearch.ts:135`),因此若今天给 RunState 增/删/重命名字段,fixture 不变、断言不红——与 `resumeV1.test.ts:18` 注释"任何人增删/重命名字段,此断言必红"及 R1.2(c)"把字段静默 drift 变成红灯"的承诺存在方向性缺口;反向(旧 fixture → 新代码,capped→limited 语义)已被测试 2 锁牢。归属:implementation 对 task T2 验收项第 3 条的字面实现达标、意图实现偏弱。blocking 分类:non-blocking(字面验收命中,且 T2 证据行与实际测试一致)。
Recheck:在 resumeV1.test.ts 增加 `expect(Object.keys(emptyState()).sort()).toEqual([...RUNSTATE_KEYS].sort())` 可补齐双向锁。

**N2. T9 抽取使编排器净增 10 行(959→969)** — `src/core/runResearch.ts:727-800`
runStageSafe 的 spec 对象字面量比原内联更冗长,"集中样板"未带来行数收敛。PRD 已将行数降为参考指标(非验收),且 saveRun 序列金样断言证明 persistRun 时机零漂移,故仅为判断性气味(轻微 Middle Man 观感,换取统一骨架与可测性,属 spec 认可的取舍)。归属:spec(PRD 决策 4/R1.7 已授权此形态)。
Recheck:无需动作;若未来 draft/analyze 配置项继续膨胀,再评估是否值得。

### 信息性(非 finding)

**I1. VERIFY 墙钟 8.3s vs 实测约 3.9s**:退出码与 315/315 计数两项实质证据完全一致,墙钟为环境相关指标,不构成证据造假。Reuse 路径 scopeNote 由"键恒在、值或 undefined"改为条件 spread,在 JSON 序列化与 vitest toEqual 下观测等价,金样本全绿佐证。

## 假证据 / 负向用例 / 范围外改动专项

- 未发现"声称完成但无证据":九条勾选任务的证据行(测试计数、文件路径、行数变化)全部可复核且与现状一致;中间计数无法逐 commit 重放,但各文件 `it()` 计数与增量算术闭合(见上)。
- 负向用例覆盖充分:budgetTracker 恰满/差一/超一/下钳/>=、attachExtraction reuse 去重、runStageSafe safeParse 失败降级、publishGate 10 分支(含既有 limitations 去重、capped 抑制反例原因)、resumeV1 capped 锁定。
- 无范围外改动:`.flow/*` 为规格工件自身演进;`scripts/gen-v1-checkpoints.mts` 是 T2 规格内生成器;dist/ 未入 diff。
