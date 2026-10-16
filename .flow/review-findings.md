# P2-6 复审 findings(独立子代理 agent-99,2026-10-16;第 4 轮=收官)

## Verdict:PASS

npm test && npm run typecheck 亲跑复核:68 文件 / 422 测试全绿,双 tsconfig 干净,wall ~9.2s——与记录的 VERIFY 证据逐字一致。四轮修复(F1-F6、B1、B1R)全部在代码中核实成立,locked 行为无回归,未发现新的 correctness bug 或 spec-axis miss。

## 修复核验(逐项对码)

- F1 字面量污染:src/core/gatherDomain.ts:335、:399 的 "budget-exhausted" 已还原;全文件 error: 字面量无 ctx. 前缀残留。✓
- F3 加注评估窗:三窗+双门在位(问开始 gatherDomain.ts:286/循环末 :571/发布门评估前 runResearch.ts:690-695/polish·review 门 :823/:856);wasToppedUp 基线快照先于 registerBudget;复位三条件=真实加注+搜索/墙钟(canSearch)+抓取余量,与 PRD D1 勘误及 RETRO 台账 #9 一致。✓
- B1/B1R 重开递归守卫:gatherDomain.ts:573-584 递归前保留 status==="open"(B1)并按 q.id 去重(B1R);push 点仅两处(:286/:571)、递归仅一处,无旁路;两条回归测试均有真实判别力(推导确认);终止性成立(cancelled 提前 return 不递归)。✓
- F5 锁内变异:projectsRuns.ts budget 路由变异在 withProjectLock 临界区内;409/400 形状符合 R1-2;budgetRoutes.test.ts 200 回显累计/400×3/409×2、runRegistry.test.ts 键空间 C+filtered take 覆盖。✓
- F6 UI:GatherView.tsx:311-346 行内 fld、「确认加注」、busy 禁用、400→内联错误、成功 toast 与契约逐字一致;终态/awaiting 无加注入口,契约负例成立。✓
- F2 真实冒烟:两跑证据在盘核实(run 4e8fb9d8 三证据链+d8b1913e 同链复证)。✓
- F4/locked/T4:handoff 程序终结卡、PLAN 六批全勾、resumeV1/fetch 触顶 locked 行为不回归、c313486 零测试文件。✓
- 红队 4 必改映射(KA1-KA5)全部落地。✓

## 发现(全部非阻断)

1. [证据解读] 冒烟 trace 的 pass B(q3-q5 双轮)是 B1 修复前构建的行为,勿引作现行为证据;行为保证以 budgetTopup.test.ts B1/B1R 回归为准;三证据链主张以 pass A 即证。recheck:引用行为保证时以回归测试为准。
2. [存量,diff 外] runResearch.ts:765-767/:891-899 对模型输出重复 questionId 无去重(基线 37dae1b 即存在,本 flow 未改动,非回归)。recheck:后续统一去重套同一 id-dedupe。
3. [文档措辞] 加注 input placeholder 三方措辞漂移(契约「增量」/原型「+20」/实现「+搜索次数」),语义一致。recheck:统一一处或接受漂移。

## 结论

两轴均过:Spec 轴(proposal 四片/PRD D1-D4/GRILL R1-1~R1-9/ui-contract S1-C1/tasks T1-T5)全数落地且证据在盘;Standards 轴无文档化标准违反。三轮阻断修复经代码走查+测试判别力推导+真实工件三面核实,无虚假修复。

总 recheck criterion:在 37dae1b..工作树上 npm test && npm run typecheck 保持 68/422 全绿,且 gatherDomain.ts 递归前 open 过滤+id 去重两守卫与 budgetTopup.test.ts 两条 REVIEW 回归仍在,即本裁决持续有效。
