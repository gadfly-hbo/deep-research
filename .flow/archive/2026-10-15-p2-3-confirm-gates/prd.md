# P2-3 PRD:确认门翻转 —— run 内 durable 双门替代向导两张皮

> 规格源:`.flow/proposal.md`(v2)+ 红队 Go 有条件(KA1–KA5+勘误,全部并入)+ 用户两项裁决(拆批/产品级 gate)。无 issue tracker。

## Problem Statement

计划/框架确认发生在 run 之外(浏览器向导预览两发 LLM→确认→POST /runs 带全程 plan)——无 durable 确认状态、重启即断、确认编辑与 run 载荷两张皮;预览通道是绕过确认的旁路。

## Solution

POST /runs 免 plan 启动→流水线 plan 阶段产出→**返回式 durable 门**(run.status=`awaiting-confirmation`,gate checkpoint 落盘,编排器返回)→UI 确认页(可编辑)→confirm 重启管线续跑→outline 阶段→第二道门→gather。预览端点与向导退役。

## User Stories

1. 作为用户,我发起研究后立即看到 run 与待确认计划(可编辑问题),确认后自动继续——不再有"预览→再启动"两张皮。
2. 作为用户,我关掉页面/服务重启后再回来,确认页仍在(durable),确认即可继续。
3. 作为用户,追问研究同样走确认门,且新问题不与基准已答问题重复(增量上下文进 plan 输入)。
4. 作为维护者,我要同项目互斥与服务端守卫,确认/取消并发安全。

## Implementation Decisions

### D1 门开关与编排器(KA4)

- `RunOptions` 增 `gates?: { plan: true; outline: true }`(server 传;CLI/测试缺省=旧行为直跑,零涟漪)。
- runResearch:plan 阶段产出后若 gates.plan→saveCp("plan",产出)+persistRun(status="awaiting-confirmation",gate={kind:"plan"})+return;outline 阶段(gates 下新增,plan 门确认后执行)同机制 kind="outline"。
- **恢复判定扩展(KA1)**:runResearch.ts:91 `prior.status === "cancelled"` → `cancelled | awaiting-confirmation`;**plan checkpoint 恢复 :416 改 find-last**(append-only 下取最新,双保险)。
- **返回式门硬约束**:门=落盘返回,confirm 重启管线——BudgetTracker startedAt 每入口重置,暂停不计 wallMs(裁决 1)。

### D2 状态机与契约

- ResearchRun.status 枚举增 `"awaiting-confirmation"`(zod+UI types;UI 消费面有 ?? 兜底已验证);run 增可选 `gate?: { kind: "plan" | "outline" }` 字段。
- 增量追问(KA5):gates 下 plan/outline 的 runStage 输入带 `incremental`(answeredQuestions/newQuestionBudget/note;baseOutline——照 resolveIncrementalBase 读基准 checkpoints,零适配直接序列化)。

### D3 API(routes/projectsRuns.ts)

- POST /runs:plan 可选(gates 下不带);**服务端单 active-run 守卫(KA2)**:同项目存在 running **或 awaiting-confirmation** → 409(POST /runs 与 /runs/rerun 同守卫)。
- 新增 gate 三端点(**KA3:store 直写+status 条件写 409+进程内 per-run 互斥;不复用 /runs/cancel——门点控制器已 release**):
  - `GET /runs/:runId/gate` → awaiting 时回 gate payload(问题/框架清单+上下文摘要);非 awaiting → 404。
  - `POST /runs/:runId/gate/confirm` body=编辑后 payload(**zod 复用**:PlanOutputSchema/ReportOutlineSchema,safeParse 失败 400)→ 落确认 checkpoint(**显式传 options.plan(resume 同款)——不依赖 find-first**)+ 状态置回 running + 起管线续跑(原 runId,resume 骨架)。
  - `POST /runs/:runId/gate/cancel` → 状态 cancelled(既有语义,可再 resume)。
- **预览端点删除**:plan-preview/outline-preview 移除(裁决 3:保留=旁路);消费面同步——server.test.ts 预览用例重写为门流、WHITEPAPER/PRODUCT-OVERVIEW 两处文档、planWizard 退役。

### D4 UI(新交互面,UI-GATE 必停)

- PlanView:向导三步(预览/确认框架)退役;保留第一步表单(目标/范围/预算/追问基准/附件/复用资产)→ 起跑(POST /runs 免 plan)→ 计划页变**确认视图**:待确认卡片(问题清单可编辑,zod 前端约束沿用)+确认/放弃;确认后框架确认卡片(标题/章节可编辑)→ 确认→跳采证。planWizard.tsx 的 previewPlan/previewOutline 编排退役,表单状态保留。
- 状态轮询:awaiting-confirmation 由既有 2.5s 轮询自然呈现(activeRun 判定扩含 awaiting);gate GET 404→回退列表文案;confirm 409→轮询收敛(裁决 6)。
- 追问入口(?followup)同新流。

### D5 兼容

带 plan 启动(旧路径/CLI/测试)=旧行为跳过 plan 门;outline 门仅 gates 下存在(request.outline 输入路径保留给旧调用);旧 run 记录零迁移;instruct 在 awaiting 409(现状语义自然成立);启动清扫不动 awaiting。

## Testing Decisions

- **KA1 陷阱钉死测试先行**:saveCp("plan",v1)+saveCp("plan",v2) 无 options.plan 恢复 → 断言取 v2(find-last;先红后绿)。
- 编排器:gates 下 plan 产出→awaiting+checkpoint;confirm(编辑 payload)→续跑且 state.questions=编辑版(关键回归);outline 门同;追问 incremental 进 plan 输入(fake model 断言入参)。
- server:守卫 409(awaiting 下二次 POST /runs/rerun);gate 三端点(200/404/400/409)+confirm×cancel 并发恰一胜;预览端点删除后路由 404。
- CLI/旧路径回归:无 gates 直跑全绿(既有 350 基线)。
- 真实冒烟:真实 LLM 起 run→awaiting→确认(编辑一问)→续跑至 gather;重启 serve 后 awaiting 仍在可确认。

## Out of Scope

P2-3b 会话底座;P2-4/5;人审门;双机并发;wallMs 跨段累计披露(维持 resume 语义)。

---

## PRD diff gate 记录(auto)

相对 proposal v2:全部为红队必含项/裁决/勘误并入,无 change/drop——
1. 必含:恢复判定扩展+find-last(D1)、服务端守卫(D3)、gate CAS+互斥(D3)、options.gates 门开关(D1)、增量输入扩展(D2)。
2. 勘误:单 active run 非服务端不变量(KA2)→升守卫;预览测试归属 server.test 非 characterization(测试清单修正)。
3. 裁决 1-6 全按红队建议(返回式门/追问走门/端点删/zod 复用/守卫/轮询收敛)。

---

## GRILL 第 1 轮决议(author-blind 子代理,9 包全部采纳)

1. **R1-1 stage 取值(硬伤修正)**:两道门落盘时 `run.stage` 保持 `"plan"`(枚举不动,UI STAGES/StageRoute 零涟漪);门身份由 `gate.kind` 表达。
2. **R1-2 outline 编辑传递**:routes 层注入 `{...request, outline: 编辑后 payload}` 传入管线——runOnProject 入口 saveRequest 自动持久化,resume 天然带回;outline gate checkpoint 照写(GET/审计),**恢复权威源=request 文件**。钉测试:outline 确认→cancel→resume→draft 用编辑版。
3. **R1-3 confirm 前奏四细则**:listRuns 反查 runId;confirm 回灌 pending 指令(resume 同构);CAS 写 running 时同步清 `run.gate`;临界区=锁内条件写、锁外起管线;confirm 复用 startPipeline 而非 launchRun(不重绑/不预落/不新 runId)。
4. **R1-4 组合矩阵**:outline 阶段执行条件 = `gates.outline && !options.plan && !request.outline`;server 仅当 POST /runs body 无 plan 时传 gates;rerun 列为不传 gates 的旧路径。
5. **R1-5 gate GET 契约**:`{ kind, payload: PlanOutput|ReportOutline, context: {goal,scope,module}, incremental?: {summary} }`;incremental 摘要按 request.incrementalOf 重跑 resolveIncrementalBase(**该函数保留**)生成(替代旧预览 base 字段)。
6. **R1-6 互斥落位**:RunRegistry 增 gateLocks(per-run)+ per-project 锁(POST /runs/rerun 守卫+launch 同锁,消 TOCTOU);随 server 实例创建,测试天然隔离。
7. **R1-7 UI 机械点**:确认视图=PlanView 内分支;awaiting 时项目根重定向 /plan;STATUS/STATUS_DOT 补"待确认/wait";activeRun 扩展后按 status 分支的展示点清单五处(GatherView/Inspector/Sidebar/StatusBar/PlanView banner);startRun 签名改 plan/outline 可选。
8. **R1-8 删除机械清单**:projectsRuns.ts:241-313 两块 ~73 行;resolveIncrementalBase 保留;planWizard 整文件退役(baseSummary 挪 gate GET);server.test 两段重写(75-92 全流程内嵌预览、387-453 增量基准含 base 断言→gate GET incremental);:589 注释顺手改;characterization T1-T12 核验无需重写;增量 6 问上限在编排器 plan 产出后同款 slice(0,6) 截断。
9. **R1-9 三条恢复链路钉子**:outline 编辑版 cancel→resume 存活;gate/cancel 后 pending 指令 resume 回灌;awaiting 跨 server 重启可确认(close→startServer 同 dataDir 先例 server.test.ts:456-458)。

## GRILL 第 2 轮(主代理)

R1 后无新实质开放问题(实现顺序/组件细节为实现期)→ **收敛(2 轮)**。本批新交互面(确认页)→ UI-GATE。
