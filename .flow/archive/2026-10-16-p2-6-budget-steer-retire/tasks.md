# P2-6 任务切片(程序收官批)

来源:`.flow/prd.md`(红队 4 必改+GRILL R1-9 全并入;UI 已批准)。

- [x] 1. T1(d0bcaba) — 417 绿(+6:重开 e2e limited→published/insufficient 不重开/问内注入混装断言/键空间/filtered take/端点 200-400-409);红→绿 3/3
- [x] 2. T2(d0bcaba 同提交) — 三步消费(interventions/directionNotes/note prepend);query 事件 note 顺带披露(偏离记录)
- [x] 3. T3(4872142) — F4 plan 输入 sessionDigests 键;F6 直接断言(R1-9 授权 3 行);F10 勘误;F11 锁内搬移含降级保留
- [x] 4. T4(c313486) — gatherDomain.ts 拆分/GatherContext 单对象/runResearch 1378→987;**断言级零改动成立**(T4 diff --test.ts 空),但行为曾被 F1 字面量污染(`budget-exhausted`→`ctx.budget-exhausted`)——REVIEW 抓出后还原,漂移全仓扫描仅此一处
- [x] 5. T5 — 真实冒烟两跑集齐三证据(run 4e8fb9d8:问内即时注入 detail+「方向调整:」note+采证中 stage=gather 加注 200+quota-starved 落盘+加注重开补采 q3-q5;run d8b1913e 同链复证终态 limited);指标采集;docs/AGENTIZATION-RETRO.md 六批对表+偏差台账 8 条+指标+遗留;REVIEW 三轮(r1 FAIL 6 阻断全修复:F1-F6;r2 FAIL B1→递归按 open 过滤+回归红绿;r3 FAIL B1R→按 id 去重+双加注回归红绿;N2 复位条件收紧勘误入账)


---

## 1. T1 加注

R1-1~R1-4/R1-8 全按决议:RunOptions.registerBudget→registry 键空间 C;POST /runs/:runId/budget(409/400/zod 三键);问入口 capped 复位评估+quota-starved 重开+尾递归;GatherView 行内 fld。

## 2. T2 问内注入

R1-5:RunOptions.takeRefinement→Intervention|null;web_search executor 三步(interventions push/directionNotes push/note prepend);崩溃重复注入披露。

## 3. T3 遗留

R1-9:F4 plan 输入增 sessionDigests 键(直调 runStage);F6 gatherAgent.test 补 toContain 断言;F10 ui-contract 勘误;F11 followup readSessionDigests 锁内搬移。

## 4. T4 拆分

R1-6 GatherContext ~27 绑定清单;gather 域先行(src/core/gatherDomain.ts);**零断言改动**(除 import 路径)。

## 5. T5 冒烟+收官

真实:起 run→采证中加注→quota-starved 重开→问内改道;指标采集(R1-7 口径);docs/AGENTIZATION-RETRO.md(六批对表+偏差台账≥4+指标+遗留)。

**冒烟证据(REVIEW F2 补做,两跑)**:
- run `4e8fb9d8`(项目 p-mvanh963-8rpn27,5 问/maxSearches=4):`run.json` interventions 含 `detail:"问内即时注入"`(refine-direction);`investigation.jsonl` 一条 query note 含「方向调整:优先看中国市场头部连锁的数据口径」(工具返回值 prepend);driver 日志 `budget-topup-gather` 200 且 `stage:"gather"`(extendWallMs 采证中加注);gather 检查点 `quota-starved`×3(q3-q5)落盘;`budget-topup-reopen` 200(addSearches)后 q3/q4/q5 逐问补采事件再现。
- run `d8b1913e`(项目 p-mvan3qry-pz7te7,4 问/maxSearches=2):同链复证(检查点 `quota-starved`×3、加注 200、缺口回环补采 18 次搜索),终态 limited(refine 全走问间隙路径——v2 的 stall 同步法即为此补)。
- 驱动日志:`out/smoke-p2-6.log`、`out/smoke-p2-6b.log`(时序原样);run 记录在 research-data 项目目录持久留证。
- 引用注记(REVIEW r4):run 4e8fb9d8 的 q3-q5 双轮调查(pass B)是 B1 修复前行为,勿引作现行为证据——行为保证以 `budgetTopup.test.ts` 的 B1/B1R 回归为准;三证据链主张以 pass A(单轮补采)即证。
