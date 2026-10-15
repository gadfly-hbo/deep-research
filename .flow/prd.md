# P2-4 PRD:采证 agent 化 —— gather 逐问 runAgent 全自主调查 + 调查流视图

> 规格源:`.flow/proposal.md` + 红队 Go 条件式(C1–C5+裁决,全部并入)+ 用户决策①③;steer 偏离已获红队批准(随 P2-3b/P2-5)。无 issue tracker。

## Problem Statement

gather 是编排器硬编码的逐问循环(模型只是转换函数);用户决策①要求全自主调查(模型自选搜索/抓取/读取、自判充分),决策③要求调查流视图;快照证据链与既有质量回环(analyze/review 补证)不得回退。

## Solution

gather 逐问改为 **plain Runtime.runAgent**(无状态、无会话):每问一次 agent 调查(web_search/fetch_page/read_snapshot 三工具,宿主 executor 复用既有 adapter 并落证据),agent 自判 sufficient 收束;extract 维持无状态 runText 批量后置;调查事件侧车落盘驱动 UI 调查流视图。**逐问串行 + 问内工具并发**(C2 推荐);steer/instruct 队列语义保留。

## User Stories

1. 作为用户,我要模型对每个问题自主决定搜什么、抓哪些、何时够用(无逐问抓取护栏),研究质量靠模型判断而非机械配额(①)。
2. 作为用户,我要采证页看到调查时间线(搜索词/页面/读取/判定)实时流(③)。
3. 作为用户,我要跳过问题/加问题/改方向指令照常生效,关键结论仍逐条绑定原文快照。
4. 作为维护者,我要单问失控有软顶、内外网边界有防护、补证轮有预算,全自主不等于裸奔。

## Implementation Decisions

### D1 工具与授权(C1/C3/C5)

- `web_search`(external):executor=adapters.search;usage.searches 计数;**配额尽→返回错误值** `{"error":"search-quota-exhausted","note":"全局搜索配额已用尽,请基于已有材料收束"}`(不抛错,模型可收敛)。
- `fetch_page`(external):executor=**assertPublicUrl(url) + assertPublicUrl(finalUrl) 硬性前置**(复用 library/assetService 现成实现,含重定向复查)→ livePage(内部超时 20s<toolTimeoutMs 30s 消竞速)→ parse → **落 SourceSnapshot(逐字段=snapshotFrom 现状)+ investigation 事件(qid 映射)** → 返回正文摘录(≤6KB/页,按 mimo 128k 最紧窗口设计);fetches 计数;配额尽同 error-as-value;**单问软顶**:fetch_page 每问上限=fetchQuota 剩余均分(BudgetTracker 改造保留,KA5 公平性——保证 analyze/review 补证轮有预算),触顶→错误值提示收束。
- `read_snapshot`(read):按 sid 读已抓正文,分页(offset/limit≤6KB)+每问频率上限(如 8 次);超限→错误值。
- 三工具 resourceUnits=1;parameters=JSON schema(zod 形状手写);授权:任务级预授权(本 run 采证用途放行,fetch_page 的 URL 边界即授权实质)。
- investigation 追加 try/catch 吞错(侧车失败不杀问)。

### D2 agent 形态与停止语义(C1/C2)

- **逐问串行**:for question → drain 指令(现状时点)→ runAgent(prompt=调查任务卡:问题+目标/范围+已答摘要+基准上下文+预算余量提示,tools 三件,toolExecution:'parallel',taskId=`dr:${keyBase}:gather-agent:${q.id}`);**maxParallel 退役为兼容字段**(UI/配置不动含义变更为文档披露)。
- **输出**:runAgent 返回文本 → 编排器 `parseJsonLoose` 后验 `{sufficient:boolean,note:string}`(红队裁决:无 validator 挂点);解析失败→sufficient=false+limitation;**RunResult failed/blocked→该问 unanswered+limitation(整 run 不死)**。
- **capped 语义**:executor 错误值含 budget-exhausted 类→编排器置 state.capped(现状有限交付语义);墙钟在 executor 检查(error-as-value)。
- 指令语义零漂移:skip 在问启动前生效(串行回归现状);refine-direction 影响下一问任务卡;add-questions 追加队列尾。

### D3 证据链与质量回环(C4)

- investigation 事件记 `qid→sid` 映射;问收束后对**该问抓取过的新增快照**批量 extractClaims(无状态 runText,子 taskId 沿用);attach 按"抓取过它的每个问"展开(共享快照双问各自 attach,主张键 `cl:{qid}:{sid}:{ci}` 现状形状)。
- regather/补证轮启动前复现 `ev:${qid}:` 旧证据清理(现状语义);extract 计量挂 model wrapper(现状,P2-2)不迁。
- q.status 判定:sufficient && claims>0→answered;claims>0→partially;else unanswered(现状判定链的 agent 形态合成)。

### D4 调查流数据与 API

- `runs/<runId>/investigation.jsonl`:事件 `{seq,qid,kind:query|fetch|read|verdict,at,summary[,sid,url,query,sufficient,note]}`;verdict=问收束事件;seq 单调。
- GET `/api/projects/:id/runs/:runId/investigation?since=<seq>` 增量(≤500 条/响应);不进 checkpoint(侧车)。

### D5 UI 调查流视图(③,UI-GATE 必停)

- GatherView 演化:问题分组头(状态徽)+主区时间线卡片流(query 卡/页面卡(域名+标题+sid)/读取卡/verdict 徽);running 态轮询 since 增量追加;完成态全量回看;保留用量条/取消/instruct 表单(现状);"跳过当前问题"按钮语义=串行下现状(无需改);空态=尚无调查事件。

### D6 夹具与测试换代

- 旧 gather 夹具退役(实测 15 文件~3.5k 行触及,逐文件处置:纯 gather 循环断言重写为 agent 形态合成夹具;gatherBudget/fetchQuota 改造存活);golden 重录(合成 transport 脚本化 toolCall 轮次+无副作用工具,INTEGRATION 认可路径);recording adapter 增 runAgent 录制形状。
- C5 必测:两路并发 runAgent(异子 taskId,合成工具)零互撞;agent 终局文本后验 parse 全路径(含失败兜底);executor error-as-value→模型收束(配额=1 夹具);慢抓取 20s 截断不杀问;assertPublicUrl 私网拒绝;共享快照双问 attach 展开(C4 对拍)。

## Testing Decisions

合成 transport+合成工具离线 e2e(全链:agent 轮次→快照落盘→批量 extract→analyze);C5 六项;既有 362 基线中 gather 相关测试换代后全绿;真实双供应商冒烟(全自主调查一问到底+**每问 fetch/turn 计数**[KA5 判据:单问 fetch ≤50% 全局、输入 ≤80% 窗口]+证据链抽查);UI 浏览器冒烟(调查流实时)。

## Out of Scope

P2-3b 会话底座与 steer;P2-5 followUp;分析/草稿阶段 agent 化;工具白名单外执行环境;thinking 启用。

---

## PRD diff gate 记录(auto)

相对 proposal:全部为 C1-C5/裁决/勘误并入,无 change/drop——
1. 勘误:"maxParallel 并发沿用"表述改写(现状是问内抓取并发)→逐问串行+toolExecution:'parallel'(C2 推荐);validator 挂点不存在→后验 parse(裁决②)。
2. 并入:C1 error-as-value+超时层次、C3 assertPublicUrl、C4 归属规则+对拍、C5 两测试、单问软顶与 fetchQuota 公平性保留(KA5)、15 文件退役面、摘录/分页/频率三层截断。
3. steer 偏离:红队批准(规划字面偏离已获独立背书,随批记录)。

---

## GRILL 第 1 轮决议(author-blind 子代理,9 包全部采纳)

1. **R1-1 taskId 含轮次(答错修正)**:`dr:${keyBase}:gather-agent:r${round}:${q.id}`;硬约束:工具定义(含 description)轮次不变,预算余量只进 prompt(不进 configuration 摘要,防 CONFIGURATION_CHANGED/账本叠加/录制键碰撞)。
2. **R1-2 调用接点**:ModelProvider 扩 `runAgent(input:{prompt,taskId,toolExecution}, tools, callKey): Promise<{status,text|null,reason?,usage}>`;工具对象在 gather 循环内逐问构造(executor 闭包捕获 store/tracker/qid/state/writer);piRuntime Channel 增 runAgentRaw;P2-2 wrapper 同步包 agent 累加。
3. **R1-3 录制粒度(阻塞级)**:RecordedKind 增 "agent",response=有序模型回合脚本(各轮 tool-call 回复+终局文本);回放构造 createReplay transport 驱动真 Pi 循环+**真实 executor 照常执行**(其内部打 replayAdapters)——快照/investigation/extract 全链再生。
4. **R1-4 callKey**:executor 闭包每问单调计数器 `${keyBase}:gather:r${round}:a:${q.id}:search|fetch|parse:${n}`(parse 同 fetch n);批量 extract `${keyBase}:gather:r${round}:extract:${q.id}:${i}`。
5. **R1-5 任务卡**:固定六段(问题+directionNotes/goal+scope/已答问题文本 ≤8 条折叠/基准快照 URL 清单兼"勿重抓"/预算余量静态快照+"以工具返回为准"/终局输出契约 JSON);≤2KB 常量级;不用 claims(未过 review)。
6. **R1-6 executor 运行时语义**:capped 由 executor 闭包直接置 state(编排器问边界复核);searches/fetches 计数即时写 run.usage+每事件节流 persistRun(与 investigation 同步活);live.ts FETCH_TIMEOUT 30s→20s 显式改动+toolTimeoutMs 30s 余量声明(20s 抓取+≤8s 解析);问前 canSearch 预检保留(零漂移)。
7. **R1-7 非 agent 路径不落 investigation**(附件/复用/add-source 各有展示);D5 空态区分"准备采证材料中"与"尚无调查事件"。
8. **R1-8 测试三档清单**:重写=runResearch/golden(重录)/gatherBudget(打软顶);接共享 scripted-agent 假件(src/adapters/testing.ts 单点)=pipeline/acceptanceLoop/researchArchiving/reuseIntegration/planCheckpointLastWins/confirmationGates/server/characterization/gateRoutes(**11 份复制 fakeAdapters 顺手收敛**);存活=contracts/fsStore/attachExtraction/attachments/resumeV1/replay/piRuntime(各自新增用例)。
9. **R1-9 store 接口**:ResearchStore 增 appendInvestigation/readInvestigation(runId,sinceSeq,limit);fsStore 落 runs/<runId>/investigation.jsonl(仿 pending 先例);memory store 对等;writer 续写最大 seq(跨 resume 单调);端点 projectsRuns regex 仿 gate。

## GRILL 第 2 轮(主代理)

R1 后无新实质开放问题 → **收敛(2 轮)**。UI 新交互面(调查流视图)→ UI-GATE。
