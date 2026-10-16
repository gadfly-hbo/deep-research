# P2-5 PRD:追问会话化 —— 会话=研究记忆(update 投递)+ followup 端点

> 规格源:`.flow/proposal.md` + 红队 Go 附 4 强制修订 R1-R4(全部并入)。无 issue tracker。

## Problem Statement

追问现状=全新 run 零研究记忆(incrementalOf 只注入结构化基准,无叙事连续);P2-3b 会话底座零流量待接;steer/fault.detail/sess: 前缀遗留未闭。

## Solution

会话=项目的持久**研究记忆**:run 完成时零模型直写摘要(update);追问(followup 端点)仍走产品编排器(增量基准+双确认门+agent 采证全复用),任务卡新增【既往研究纪要】段(会话 tail K=3,叙事补充);首次 followup 保留一次真实 session run()(全链验证)。

## Implementation Decisions

### D1 会话研究记忆(R1/R2)

- **投递**:run 完成时 `sessionRuntime.update(sessionId,{kind:"message",role:"user",text:摘要模板})`——零模型/零账本/零 operationId;摘要模板=目标+问题清单(答/未答计数)+口径注记(directionNotes)+结论要点计数+交付状态,**硬顶 800B**;写失败不阻塞 run 完成(DR_DEBUG 记录,披露)。
- **挂钩位置**:`runOnProject` 接缝(projectService.ts)——CLI 与 serve 共用;RunOptions 增可选回调 `onRunComplete?(summary)` 由 routes/CLI 注入(编排器零会话依赖)。
- **权威分层(R2)**:证据/快照/已答问题=bundle(incrementalOf 链路,权威);会话 tail=追问原话/口径注记叙事;任务卡模板写明"纪要与基准统计不一致时以基准为准"。
- **任务卡【既往研究纪要】段**:置于【已答问题】后;K=3 条(每条 800B,合计 ~1k token 量级);followup 发起时 history() 读一次(**勿进问间隙轮询**);会话缺失→降级零纪要段不阻塞;plan 阶段输入复用同段。

### D2 followup 端点(routes/projectsRuns.ts)

- `POST /runs/followup` body={prompt, baseRunId?}:定位基准(最新已完成 run 或显式);**守卫单一收口**(提取共享函数,POST /runs/rerun/followup 三处共用,per-project 锁内);resolveIncrementalBase 同款校验;构造 `{goal:prompt, incrementalOf:{runId,requestId}}` 走 P2-3 免 plan 起跑(双确认门保留——P2-3 已裁决,非本批重开)。
- **首次 followup**:会话惰性 create + **一次真实 session run()**(首条 prompt=基准摘要任务卡,tools:[],taskId=`sess:first:<runId>`)——验证 claim/bind/reconcile/drive 全链;其后 update 追加。**旧项目不回填历史**(incrementalOf 已注入,回填=制造双源)。
- `sess:` 前缀机制化:followup/摘要的会话 taskId 构造收口到 sessionRuntime.ts 单一函数。
- fault.detail 透出:宿主 throw 路径自带(piRuntime blocked 分支只透 reason——本批在编排器/路由的错误组装处拼入 detail 若在)。

### D3 删除与登记

- **compaction 不启用**(R3:死配置——update 路径无 harness run 压缩永不触发;harness 配置进任务身份,P2-6 改参数会引爆存量 CONFIGURATION_CHANGED)。会话 harness 配置钉跨批不变(policyVersion 不动);P2-6 若需改=新会话。
- **steer 偏离登记**(红队立场:支持延后但理由升级):PLAN-AGENTIZATION P2-5 行登记"steer 物理不可实现(无模型调用走会话则 live 目标不存在),挪 P2-6,前提=管线模型调用迁入会话"。

### D4 UI(小面,过 UI-GATE)

- 侧栏/详情「追问」入口→followup 端点;计划确认页显示"延续研究"徽章(N=listRuns 计数——会话条目惰性建后从 0 起,展示语义=N 为本项目追问次数)。

## Testing Decisions

- 合成:计数 transport 下 run×2+update×2 断言模型调用=2、history=4、update 零账本新增(KA1 钉);摘要模板 800B 硬顶;followup e2e(守卫含 followup 端点、并发 POST /runs+followup 同项目恰一 200);旧项目惰性建+降级;任务卡纪要段(K=3+权威分层文案);真实 session run 一次(首条 prompt 走真链路,验收顺手记录回复质量与耗时)。
- 全仓 npm test+typecheck;UI 浏览器冒烟(追问入口→确认页徽章)。

## Out of Scope

P2-6 全部(动态预算/任务迁移/steer 通道/管线迁会话/编排器退役);跨机会话;investigation 跨 run 聚合;compaction(死配置,不启用)。

---

## PRD diff gate(auto)

相对 proposal:全部为红队强制修订/裁决并入——
1. 勘误:摘要投递 run(prompt)→update()(R1,消 O(N²) 与故障面);compaction 启用→删除(R3,死配置);"压缩后 tail 不可读"担忧不成立(history 全 entries);真实 Provider 验收句改一次 run()+e2e(R4)。
2. 并入:权威分层规则(R2);守卫单一收口(KA5);steer 偏离登记与理由升级;摘要挂钩 runOnProject 接纱;sess: 收口;fault.detail 透出点。

---

## GRILL 第 1 轮决议(降级内联:子代理 429 配额,主代理自审,history 已记录;代码证据自查)

1. **R1-1 update() 签名钉死**:`update(sessionId, {kind:"message", branch:"main", message:{role:"user", text:摘要}}, signal?)`(types.d.ts:541/588-605);ModelMessage 必填仅 role+text;连续 user 消息 history 消费无害(P2-3b 冒烟已有先例)。
2. **R1-2 摘要挂钩形状**:RunOptions 增 `onRunComplete?(result: RunResult, dir: string): Promise<void>`——编排器末尾(persistRun 终态后)调用;routes/CLI 注入实现(构造摘要模板+sessionRuntime update);摘要数据源=RunResult(run+bundle)——**cancelled/failed 也写**(模板如实记状态,一行式;失败/取消无 bundle 则只记状态+目标);写失败 catch 不阻塞(DR_DEBUG)。
3. **R1-3 followup 起跑路径**:routes 构造 request{goal:prompt, incrementalOf:{runId,requestId}} → **复用 POST /runs 的免 plan 启动代码**(gates 传递),差异仅 goal 来源与基准定位;【既往研究纪要】段注入:编排器 RunOptions 增 `sessionDigests?: string[]`(K=3),任务卡模板读——编排器仍零会话依赖(routes 在起跑前 history() 拉一次传入)。
4. **R1-4 生产候选链解析**:serve/CLI 共用 `resolveSessionCandidates(config)`(sessionRuntime.ts 导出):config.model 链经 resolveModelConfig+transportFor(piRuntime 已有导出)映射 candidates;缺 key 候选跳过;零可用→followup 降级零纪要(不建会话)。
5. **R1-5 守卫收口**:提取 `assertNoActiveRun(ctx, id)`(per-project 锁内 listRuns 检查 running|awaiting→409);POST /runs、rerun、followup 三处调用(rerun 保留同请求 404 先行,followup 保留基准校验先行)。
6. **R1-6 首次真实 run()**:prompt=首条基准摘要任务卡(同摘要模板);合成测试计数断言(模型恰 1 次);真实冒烟记录耗时/回复质量。
7. **R1-7 UI 链**:「追问」按钮(navigate ?followup=runId)维持现状——PlanView 表单提交改调 POST /runs/followup(带 baseRunId);确认页徽章 N=项目 listRuns 中 derivedFromRunId 非空计数(ui/state 现有 detail.runs 可算,零新端点)。
8. **R1-8 摘要模板字段**:目标/口径注记(directionNotes join)/问题计数(answered/partially/unanswered/skipped)/结论要点计数(bundle.claims top N 标题截断)/交付状态(published/limited/cancelled/failed)+一句式状态行;硬顶 800B(超限截断 claims 列表)。

## GRILL 第 2 轮(主代理)

R1 后无新实质开放问题 → **收敛(1 轮有效内联+复核)**。UI 小面(追问入口改调+徽章)→ UI-GATE(轻量,复用既有表面)。
