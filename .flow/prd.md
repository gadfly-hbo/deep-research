# P2-6 PRD:动态预算 + 问内改道 + 编排器退役(Agent 化程序收官)

> 规格源:`.flow/proposal.md` + 红队 Go 附 4 必改(全部并入)。无 issue tracker。

## Solution

四片:(1) 运行中加注(同对象变异+capped 复位+配额饿死问题重开——KA1 裁决 a,用户"放开"哲学);(2) 问内 refine-direction 即时注入(filtered take+工具返回值 note);(3) P2-5 遗留四项;(4) 编排器拆分(gather 域先行,零断言改动纪律)+程序收官文档(偏差台账)。

## Implementation Decisions

### D1 运行中动态预算(KA1 裁决 a/KA2)

- **端点** `POST /runs/:runId/budget`:body={addSearches?,addFetches?,extendWallMs?}(只增不减);仅 running 可加注(409 非 running/400 非法增量,R1-2 裁决);**同 Budget 对象原地变异**(budget.maxSearches += n 等,禁引用替换——KA2);per-project 锁内(账本查得+变异同 withProjectLock 临界区;REVIEW F5 勘误:本行原写"锁外",与 proposal D1"锁内"矛盾,实现已对齐 proposal)。
- **capped 复位**:加注后若 tracker.overBudget()=false 且 canSearch()=true → state.capped=false(下一门阶段恢复 polish/review 回环);**配额饿死问题重开**:问题标 unanswered 时记成因(quota-starved vs insufficient);加注后 quota-starved 的问题重标 open(gather 循环末扫描重开)。**勘误(REVIEW F3/N2)**:复位条件收紧为「真实加注(运行起始预算基线比对 wasToppedUp)且搜索/墙钟/抓取全量程均有余量」——R1-4 字面 `capped && canSearch()` 会击穿 v1 恢复与 fetch 触顶的 locked limited 语义(存量 3 测试红灯实证);重开递归只补采仍为 open 的(**REVIEW B1**:gap targets∩starved 不双轮调查、不清除已产主张)。
- **UI**:GatherView 用量条旁「加注」按钮(弹层输入增量/确认);文案含"加注后配额饿死的问题将自动重开"。
- 竞态窗:executor error-as-value 已发→当前问收尾下一问受益(可接受);墙钟延长同理(startedAt 不变上限延长)。

### D2 问内 refine-direction 即时注入(KA3)

- RunRegistry 增 `takeRefinement(): string | null`(filtered take:仅 refine-direction 类型,peek+按谓词 splice,~10 行);web_search executor 调用前检查——有则消费(refine note prepend 到工具返回值:返回 `{hits, note:"方向调整:<refine>"}`);**drain() 不动**(问间隙全量消费 skip/add/refine 残余=共存分层)。
- 同一条 refine 既即时注入又留 directionNotes(下一问任务卡):期望语义。降级面:模型正在收束不调 web_search→refine 落空退化为下一问(现状)。
- R1-1 不变式:taskId/工具定义零改动;refine 只进工具返回值/prompt(不进 configuration)。

### D3 P2-5 遗留收尾

- F4:plan 阶段输入增纪要段(sessionDigests 复用,编排器 plan runStageSafe 输入注入);F6:gatherAgent.test 补 `toContain("【既往研究纪要】")` 直接断言(3 行);F10:ui-contract 勘误(count=0 显示"首次"=实现正确面);F11:followup readSessionDigests 移入 withProjectLock。

### D4 编排器拆分(KA4 纪律)+ 程序收官

- **gather 域先行**:`src/core/gatherDomain.ts`(gather 函数+applyInstruction+investigationCard+工具构造+证据归属);GatherContext 单对象传引用({state,run,budget,tracker,directionNotes,activeGatherTargets,fetchedByQ,snapshotsBySid,store,ctx 依赖});**硬约束:拆分 commit 零断言改动(除 import);任何测试需改=拆 commit 逐条解释**。
- 质量回环域+门域后行(同纪律);装配层=runResearch 主函数(目标 <400 行,阶段序列+门+指令消费点)。
- **程序收官文档**(docs/AGENTIZATION-RETRO.md):六批逐批对表(交付/验证/关键决策)+偏差台账(≥4 条已批准偏离)+指标基线(测试/LOC/runResearch 行数前后)+遗留清单。

## Testing Decisions

加注 e2e(中途 POST budget→下一问受益+capped 复位+quota-starved 重开);问内注入(混装队列 executor 断言 refine 消费 skip/add 仍在);F4/F6 断言;拆分前后 411 全绿零断言差;真实冒烟(加注一问到底+问内改道)。

## Out of Scope

管线模型调用迁会话(架构重写);SDK control.steer/followUp 字面;跨机会话;compaction;运行中降档;成本恢复。

---

## GRILL 第 1 轮决议(author-blind 子代理,9 包全部采纳)

1. **R1-1 加注通道**:RunOptions 增 `registerBudget?: (b: Budget) => void`;编排器入口调用;registry 新键空间 C(runId→Budget);startPipeline finally 注销;**接受 resume/gate-confirm 重启丢已加注额度**(新账,P2-3 已定 startedAt 重置,PRD/UI 文案写明)。
2. **R1-2 端点形状**:projectsRuns instruct 后;regex 仿 gate;非 running→**409**(instruct 同语义面);非法增量→**400**(zod);zod `{addSearches?,addFetches?,extendWallMs?}` 各 int positive optional+refine 至少一键;maxParallel 不可加注;无上限封顶。
3. **R1-3 quota-starved 形状**:PlanQuestion 增可选字段 `unansweredReason?: "quota-starved" | "insufficient"`(:483 写 quota-starved;:721/:726 写 insufficient);重开时清字段;枚举不动。
4. **R1-4 重开控制流**:评估点=gather for **每问开始处**(`!tracker.canSearch()` 前):`if(state.capped && tracker.canSearch()){capped=false;重开扫描}`;重开=quota-starved 问题重标 open+清 reason;循环末若 reopened>0 尾递归 `await gather(round+1, reopened)`;墙钟延长但搜索配额尽→不重开不复位(现语义)。
5. **R1-5 takeRefinement**:RunOptions 增 `takeRefinement?: () => Intervention | null`(routes 闭包绑 registry+runId);executor 拿到后三步:①push run.interventions(effect="applied"/detail="问内即时注入")②push directionNotes③prepend note 到工具返回值;**接受崩溃 resume 时 refine 二次入队**(方向附注重复注入无害,记已知降级);parallel 下 peek+splice 同步原子无竞态。
6. **R1-6 GatherContext 完整清单(~27 绑定)**:三个 let(currentQuestion/activeGatherTargets/addQuestionCounter)转 ctx 字段赋值点原位搬移;持久化/事件回调(persistRun/persistUsageThrottled/appendInvestigationSafe/syncProgress/ingestToLibrary)**留装配层以函数字段挂 ctx**(质量回环/门域后行同用);pollInstructions 经 ctx;完整清单=字段×来源×传递方式表(PRD 落表,零断言纪律前提)。
7. **R1-7 收官指标口径**:测试数/文件数=vitest 末行原文;runResearch 行数=wc -l;LOC=`git ls-files 'src/*.ts' | grep -v '\.test\.ts$' | xargs wc -l | tail -1`(排除测试);全部在收官 commit 采集,命令+输出原样进 RETRO 文档。
8. **R1-8 UI 加注落位**:**行内 fld**(三个数字 input+确认按钮,复用干预表单样式)替代弹层(零新交互范式,不违 P2-5 契约负例);UI 只展示当前用量+输入增量,不展示上限不前端校验;需补 P2-6 ui-contract 行。
9. **R1-9 D3 细节**:F4=plan 直调 runStage 输入增 sessionDigests 键(不经 runStageSafe;生效面=followup 首跑);F10=纯文档勘误(负例改"count=0 显示首次");F11=锁内搬移整段含 try/catch 降级保留。

## GRILL 第 2 轮(主代理)

R1 后无新实质开放问题 → **收敛(2 轮)**。UI 小面(加注行内 fld+问内改道无 UI 面)→ UI-GATE(轻量)。
