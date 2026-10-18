# Red-Team: E1 嵌入式研究能力库(全新子代理,2026-10-18)——Verdict: go(附 3 硬条件)

## Steelman
spike 先例背书 questions→plan→gather→verdicts 路径;预算尽→limited 代码完整(gatherDomain.ts:287-294,runResearch.ts:691/726-742);T2 采证即沉淀为真(gatherDomain.ts:443/212、runResearch.ts:591/328-330);免门直跑成立;排队不计 wallMs 天然(started 在 runResearch 内部)。

## Top Kill-Assumptions
1.【已证伪】取消后 claims 级 findings:mid-gather 取消 → gather checkpoint 不落盘(690 提前 return 跳过 691)、cancelRun 返回 bundle:null(303-310)、claims 只活在内存 state 与 checkpoint——物理不可重建,回调也只收到 bundle:null。**硬条件:要么加法式核心改动(RunOptions 回调或 cancel 前补落 checkpoint——后者会破坏 resume 语义),要么改写合同(cancelled 独立终态+来源级降级)。proposal "取消→limited" 自相矛盾,PRD 必裁。**
2. job 目录隔离:server 启动清扫不过 PROJECT_ID 正则(server.ts:91-106),列表路由过正则——job 目录落共享 */projects 下会被误杀/混列表。**硬条件:capability 根永不在任何 */projects 下 + 目录名不匹配 ^p-[a-z0-9-]+$。**
3. 归组主路径:bundle/Claim/Evidence 均无 qid;可靠路径是 gather checkpoint 的 claimQuestions(runState.ts:15 随 state 落盘)+ 问题状态;调查事件路径只覆盖 fetch 来源,漏附件/复用。**硬条件:装配以 checkpoint.claimQuestions 为主,事件路径仅取消降级。**
4. low 档×6 问≈每问 2 fetch → 大面积 unanswered(算术必然)。PRD 裁:档位×问数联动校验(low≤2/medium≤4/high≤6)或接受写入合同。
5. 共享适配器实例并发 + 取消延迟(信号只在问/阶段边界生效,单次 runAgent 可达 200s+):并发测试守护;Port 文档披露取消时延上界。

## 次要(须进 PRD)
module 缺省 industry 今天零副作用(两 config 的 preferredDomains 均空,补防回归断言);FsProjectStore.create 合成 goal/scope(goal 进调查任务卡,空话轻微劣化采证——合成要有信息量);request 必须过 ResearchRequestSchema.parse;**幂等键不得进 request.id**(prior cancelled 触发 resume 语义,调查事件混写)——幂等留 job 层;上游 §2 的 libraryReuse 是空开关(bindingsForRun(runId) 无人建绑定恒空),上游文档应删注。

## What I Couldn't Assess
SDK 内部并发通道安全;searchFailover 可变状态并发;JuanerAI 侧三接点;job 留存/清扫长期策略。
