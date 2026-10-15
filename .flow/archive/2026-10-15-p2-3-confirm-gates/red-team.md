# Red-Team:P2-3 v2 确认门翻转

**Verdict:Go(有条件)。** 机制可行性证据链全部验证通过(与 v1 本质区别):(a) 启动清扫只清 running,awaiting 跨重启存活 ✓;(b) 两门点 state 可从 checkpoint 完整重建(plan 门=PlanOutput 极小;outline 门=questions+outline)✓;(c) 编排器中途回返已是支持形态(stopAfter gather 早返回)✓;(d) resume 骨架与门恢复同构 ✓;(e) 复用绑定按 runId 键控与 plan 产出时机正交,confirm 沿用原 runId 即无错位 ✓;(f) awaiting 下 instruct 409 自然成立 ✓;(g) UI status 消费全有 ?? 兜底 ✓。

## Top Kill-Assumptions(PRD 必含,缺即改后重审)

1. **KA1 confirm 复用 resume 骨架的两个陷阱**:runResearch.ts:91 恢复判定硬编码 cancelled——不改则 awaiting 下 confirm 起新 runId,复用绑定孤立+checkpoint 孤立+plan 重跑(编辑被丢);saveCheckpoint append-only 但恢复循环 :416-417 find(**first**) plan checkpoint——confirm 只写回 checkpoint 不传 options.plan 时,编辑版被原版静默覆盖。**修法:恢复判定扩 cancelled|awaiting-confirmation;confirm 显式传 options.plan(resume 同款)+ :416 改 find-last 双保险。**
2. **KA2 "单 active run 沿用"不成立(事实勘误)**:现状互斥纯客户端(PlanView/GatherView disabled;activeRun 只认 running);POST /runs 与 rerun 无服务端守卫;awaiting 解锁按钮后双管线并发互踩 checkpoints。**修法:服务端守卫——同项目存在 running 或 awaiting-confirmation 时 POST /runs / rerun → 409。**
3. **KA3 gate/cancel 不能复用 /runs/cancel**(门点 return 时 finally 已 release 控制器,必 404);confirm×cancel 无 CAS(均只读前置检查,registry.acquire 是 set 覆盖不能当互斥量)。**修法:gate 三端点 store 直写 + status≠awaiting→409 条件写 + 进程内 per-run 互斥。**
4. **KA4 门开关**:runResearch 无条件默认停门会打死 CLI(headless 无人确认)与几十个直调测试。**修法:options.gates 启用位,server 传、CLI/测试不传=旧行为。**
5. **KA5(条件)追问走 run 内门时 plan/outline 输入须带 incremental 上下文**(现仅预览端点有:projectsRuns.ts:261-269/299-307;runStage 输入 unknown 直接序列化,加字段零适配)。

## 开放问题裁决

1. wallMs:**门=落盘返回+confirm 重启管线(返回式门,硬约束)**——BudgetTracker startedAt 每次 runResearch 入口重置,暂停天然不计,零新工程。
2. 追问:**走 run 内门**+KA5 增量输入扩展(保留预览通道与端点退役自相矛盾)。
3. 预览端点:**删除**(保留=绕过 durable 确认的旁路 LLM 通道)。勘误:预览测试在 server.test.ts:87,387-439+文档两处+planWizard,非 characterization。
4. payload 校验:zod 全复用(PlanOutputSchema/ReportOutlineSchema),safeParse 失败 400。
5. 并发:KA2 服务端守卫+KA3 CAS。
6. UI:gate GET 404→回退列表+文案;confirm 409→既有 2.5s 轮询收敛;编辑本地 state 提交失败保留。

## 无法评估
确认页 UI 形态(原型未出);问题 id 重排对证据清理键影响(门在 gather 前无旧证据,风险限同 run 反复确认);outline 编辑后 bullets×reportTemplate 组合(需真实冒烟)。
