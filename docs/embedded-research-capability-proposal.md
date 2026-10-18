# 嵌入式外部研究能力方案(数据分析流程可调用)· 提案 v0.1

日期:2026-10-18。状态:**提案待批**(未实施)。
定位:为"数据分析报告需要外部信息研究"的场景,提供一个可植入普通数据分析流程的**深度研究能力**。与插件接入路线(**不变,照常推进**,见 `docs/juanerai-integration-kickoff-prompt.md`)并行,同一业务核心、两种装配——第三次适用"共用业务实现,分别装配交付"。

## 0. 问题画像

- **触发**:分析任务进行中(取数/分析/撰写阶段)发现结论需要外部事实支撑——市场规模、行业背景、竞品动态、公开口径。
- **输入**:一组**结构化研究问题**(分析侧已明确要什么,不需要再规划)+ 预算档位。
- **输出**:**带证据的结构化研究发现**(findings)——每问一组主张,主张带逐字引句、来源(URL/标题/信源分级/抓取时间)、核查判定、口径;可直接被分析报告**引用**。不是一份独立报告文档(报告由分析流程自己写)。
- **形态**:分钟级**异步作业**(9~16 分钟级,不可同步阻塞分析流);分析流程提交→拿 jobId→轮询/回执。
- **质量语义**:沿用本仓不变式——执行完成 ≠ 证据充分;证据不足/预算到顶 → **有限交付**(answered/partial/unanswered 如实标注 + limitations),主张 100% 可回溯快照原文。

## 1. 形态选择(三案,推荐 A)

| 方案 | 说明 | 判定 |
|---|---|---|
| **A. 同核轻装库(推荐)** | deep-research 仓新增能力门面(facade),**纯库交付**(固定依赖,进程内调用),分析服务装配后直接调 Port | 符合接入标准 §2"纯函数/库"行:不强制 HTTP/进程/UI/账本;零新增部署;J1 的 authorize/dataDir 装配选项即为此准备 |
| B. 复用插件实例 Gateway | 分析服务调已接入的插件(随包进程/HTTP) | 不推荐:耦合插件实例生命周期;插件带着工作台/项目/版本/门的重量;两套消费者抢同一实例 |
| C. 独立研究微服务 | 又一个常驻服务 | 过重:单机单用户场景,运维面不值 |

## 2. 能力 Port(对外唯一接口)

```ts
// 库形态:分析服务 composition root 装配
createResearchCapability({
  model, search,                    // 或经 piRuntimeModel(configs, { authorize, dataDir })
  dataDir,                          // 审计/账本/快照落位(宿主用户空间;J1 选项)
  authorize?,                        // 分析任务的授权策略(channel 级四 kind)
  library?,                          // 可选:情报库沉淀/复用(见 §5)
  maxConcurrentJobs = 2,
}) → {
  submit(req):  { jobId }                       // 幂等键去重;提交即返回
  status(jobId): JobStatus                       // submitted|running|completed|limited|failed|cancelled (+usage)
  result(jobId): ExternalResearchResult | null   // 终态可取;含 findings/limitations/usage
  cancel(jobId): void                            // 保留已完成问题的部分结果(limited 语义)
}

ExternalResearchRequest = {
  idempotencyKey?, asOf?,
  questions: [{ id, question, scopeNote? }],     // 1~6 问;questions 即 plan(见 §3 决策点)
  budget: { tier?: "low"|"medium"|"high" } | explicit Budget,
  libraryReuse?: bool,
}

ExternalResearchResult = {
  jobId, status, limitations[], unresolved[],
  findings: [{
    questionId, answer: "answered"|"partial"|"unanswered",
    claims: [{ statement, kind: fact|inference|unverified, quote,
               source: { url, title, tier, fetchedAt },
               calibration?, verified: quote-hit|mismatch|... }],
  }],
  usage: { searches, fetches, modelCalls, outputTokens, wallMs },
}
```

**状态机(job 级,能力对外唯一暴露的状态)**:`submitted → running → completed | limited | failed | cancelled`。cancelled/预算尽 → limited,已完成问题的 findings 照常可取(与插件形态"取消保留已完成阶段"同语义)。

## 3. 内部结构:复用什么、跳过什么、新做什么

**复用(零改动或薄适配,全部为本仓既有资产)**:
- adapters 层:搜索(主备链)/抓取(SSRF 守护)/解析/模型通道(pi-agent-runtime,J1 authorize/dataDir);
- gather 域(P2-4 采证 Agent:web_search/fetch_page/read_snapshot 三工具 + 预算闸门 + 调查事件);
- 证据抽取(逐字引句+口径)、引用核查(quote-hit)、口径检查、BudgetTracker;
- replay/录制测试基建(`spike --record/--replay` 即本路径的先例——questions→gather→verdicts 已经跑通过)。

**跳过(嵌入式不需要,不做减法改造,只是不走)**:
- 确认门(**无头**:questions 即 plan,免 plan 阶段——语义同 `POST /runs` 带 body.plan 直跑);
- draft/polish/review/publish(分析流程自己写报告)、不可变版本、项目/任务管理、formal 报告、UI。

**新做(本方案的实施面)**:
1. **job 管理器**:提交/幂等键/并发上限/状态查询/取消;job 记录落 dataDir(崩溃后 running→failed,可重交;跨进程恢复首版不做,记为已知限制);
2. **问题级编排**:每 job 一个内部 run(options.plan=questions,stopAfter=gather)——共享预算与快照去重;
3. **findings 装配器**:run 的 claims/verdicts/snapshots → 按问题归组的事实结构(每问 answer 判定 = 有存活 fact 主张→answered,仅 inference→partial,无→unanswered);
4. **轻量综合(可选,默认关)**:每问一段 LLM 摘要(仅重组既有主张,严禁新增事实——同 formal 阶段约束);v1 不开,分析侧自己综合。

## 4. 植入分析流程(JuanerAI 侧,三个接点按需选装)

1. **Analysis Plan 步骤类型**(确定性管线):分析计划器把需要外部信息的问题标为 `external_research` 步骤 → 步骤执行器调 Port(submit→等终态)→ findings 作为**可引用分析材料**挂到分析任务(与内部数据资产同级,进 Analysis IR)。
2. **分析 Agent 工具**(自主模式):`external_research(questions, tier)` 薄工具——executor 包 Port,提交即返回 jobId(不阻塞轮询);配套 **skill=使用手册**:何时值得开研究(而不是两次 web_search)、问题怎么写质量高、`limited/unanswered` 怎么在分析里如实呈现。状态机留在库内,工具是薄的(本仓 P2-4 工具模式反向复用)。
3. **报告编辑 UI 动作**(人工):编辑器内"对此结论做外部研究"。

**引用合同(三种接点共用)**:findings.claims 携带完整溯源 → 报告装配渲染引注(来源+引句+信源分级;unverified 显式标注);limitations/unanswered 进报告"限制"节——分析报告不得把未核实主张当已核实呈现。

## 5. 数据、权限与成本

- **凭据/授权**:分析服务按其任务合同注入(env + authorize 钩子);模型主备链沿用;
- **预算**:每 job 独立预算,计入该分析任务成本口径;usage 随 result 返回供分析流程记账;
- **数据**:快照/审计/账本落宿主指定 dataDir(与插件实例数据根分离);不并分析库、不共享会话/账本(标准 §2/§4);
- **情报库沉淀(可选开关,建议默认开)**:研究发现入情报库 → 后续分析任务经授权检查+版本绑定复用,不重复抓取——这是嵌入式形态对分析业务的复利点。

## 6. 验证(实施时定案,此处列口径)

合成:replay 夹具驱动 job 全生命周期(提交/幂等/取消/预算尽→limited 部分发现/坏输入 400);集成:合成分析消费者(findings→引注渲染);live 另行授权。既有 433+ 测试零回归。

## 7. 实施切分(获批后)

- T1 库本体:Port+job 管理器+findings 装配+测试(本仓);
- T2 情报库沉淀/复用开关(本仓,可选);
- T3 JuanerAI 侧接线:Port 装配+计划步骤+工具+skill(宿主仓,另任务);
- T4 固定交付:source-identity/差异表(标准 §6),与插件物料分别记录身份。

## 8. 待用户决策

| # | 决策点 | 推荐 |
|---|---|---|
| 1 | 交付形态 | **A 纯库**(进程内);若分析服务与库依赖树冲突再议 B |
| 2 | plan 阶段 | **questions 即 plan,不跑 plan LLM**(分析侧已结构化) |
| 3 | 每问 LLM 综合 | **v1 不做**(只交 claims+证据;综合归分析流程) |
| 4 | 情报库沉淀 | **默认开**(授权检查/版本绑定已有,复利) |
| 5 | JuanerAI 侧三接点优先级 | 先 **计划步骤**(确定性、可控),工具次之,UI 动作最后 |
