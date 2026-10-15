# Red-Team: P1-3 拆分 server.ts 路由域 + 抽 RunRegistry(纯重构)

> 评审对象:`.flow/proposal.md`(P1-3 提案,2026-10-14 重构审查产物)
> 评审日期:2026-10-15;评审方式:提案逐条声明 vs `src/server/server.ts`(971 行)、`src/server/` 全部 5 个 HTTP 测试套件、`src/stores/fsStore.ts`、`src/app/projectService.ts`、`package.json` 只读对账。

## Top Kill-Assumptions(ranked)

### KA1 — "launch/resume 两段几乎逐行相同"为伪,去重前提不成立,且测试未钉住两段的差异字段

- **Claim**(提案建议 3):原 `:357-379` 与 `:496-516` 两段 `runOnProject(...).catch(落 failed).finally(清 controllers)` "几乎逐行相同",应消除重复。
- **Steelman**:两段骨架确实同构——都是 `void runOnProject(dir, request, deps.makeAdapters(), {...}).catch(...).finally(() => controllers.delete(...))`,抽公共启动函数是合理方向。
- **攻击**:实际代码(`src/server/server.ts:358-380` vs `:497-517`)的差异是语义性的,不是装饰性的:
  1. launch 传 `runId`(新 randomUUID)和 `drainFor(runId, dir)`;resume 不传 `runId`(由编排器沿用原 runId 恢复,`src/app/projectService.ts:74-83` 的 `RunOptions.runId` 可选),并传 `drainFor(prior.id, dir)`。
  2. **catch 体完全不同**:launch 落一条全新 failed 记录——`stage` 硬编码 `"gather"`、`checkpoints: []`、`usage` 全归零(`:368-376`);resume 先 `findRunByRequestId` 查当前记录、存在则**展开合并**、只改 status/error(`:506-513`)。一个覆盖归零,一个保留现场。
  3. 这个差异**没有测试钉住**:唯一的失败路径测试(`server.test.ts:181-203`)只断言 `status==="failed"` 和 error 文案,不断言 stage/usage/checkpoints。去重时无论统一成哪种形状,`npm test` 全绿,但 `GET /api/projects/:id` 返回的 run 记录字段变了——直接违反提案自己的约束"响应体逐位不变",且恰好落在"失败不冒充完成"这条产品哲学最敏感的路径上。
- **Fails if**:实施者按提案字面相信"几乎逐行相同",把两种失败形状归一并以为纯重构无行为差。
- **Evidence to get this week**:已在此——上文两段代码对照即证据,无需新数据。
- **Kill criterion**:若 PRD 不补差异表征、仍把该去重描述为"逐行相同的机械提取",则此项应降级为"只做骨架提取、catch 体各自保留参数化",或显式记录为有意行为变更。
- **Cheapest test**:重构前加 2 条表征断言:launch 失败后 run 记录的 `stage/usage/checkpoints` 字段值、resume 失败后保留原记录字段。约 30 分钟,永久钉住。

### KA2 — "server.test.ts 原样通过 = 行为不变的核心证据"对安全网的描述双重失真:既有套件被漏算,未钉面比提案暗示的大得多

- **Claim**(提案约束 1 / 建议 1):"`server.test.ts` 602 行已经这么用了";"`server.test.ts`(14 个测试)原样通过是行为不变的核心证据"。
- **Steelman**:HTTP 即测试接口的思路是对的;全流程 e2e 确实覆盖项目域主链路。
- **攻击**:事实层——`server.test.ts` 实为 **638 行、15 个测试**;且 `src/server/` 下还有提案**完全没提**的 4 个 HTTP 套件(均 `startServer` 起真服务):`libraryRoutes.test.ts`(5 测试)、`libraryGovernanceRoutes.test.ts`(7)、`librarySearchRoutes.test.ts`(4)、`reuseRunRoutes.test.ts`(1)。安全网实际是 32 个 HTTP 测试,情报库域大部分有覆盖——**提案把自己的证据基础说窄了**,而"验证"节只写"server.test.ts 全套",照字面执行会漏跑 17 个测试。
  更实质的是:即使 5 个套件全跑,以下被拆动路由的 HTTP 行为**零钉住**:
  - `POST /versions/:v/formal` 与 `GET /versions/:v/formal/{html,pptx,json}` 的全部 HTTP 面(content-type、content-disposition 的 inline/attachment 分支、两套 404);formal 只有 service 级测试(`projectService.test.ts:141`),不钉 HTTP 形状。
  - 静态文件服务(`:941-959`):扩展名→content-type 映射、`..` 回退、SPA fallback,无任何测试。
  - 兜底 `404 未找到: {method} {path}`(`:961`);非法项目 id 抛错→500(`:147-150`,先于子路由匹配);畸形 JSON body→500(`:201`,在任何路由匹配**之前**解析——换成"先匹配后解析 body"的匹配器会把 500 变 404)。
  - 错误路径:cancel 404、resume 404/409、rerun 404、instruct 队列满 409(上限 20,`:457`)、zod 校验失败→500。
  - `GET /api/projects` 列表顺序(readdirSync 序,未排序)。
- **Fails if**:重构改动上述任一未钉行为而 32 个测试仍全绿——对 if 链重排/匹配器替换来说,这是**最可能**出事的通道(如 body 解析时机、fall-through 顺序)。
- **Evidence to get this week**:已在此——路由×测试覆盖矩阵(上文清单)。
- **Kill criterion**:PRD 若仍以"测试全绿 = 逐位不变"为唯一验收门且不补表征测试,本提案的"纯重构"承诺对该约 1/3 的表面积不可验证。
- **Cheapest test**:补 5 条表征测试(formal 三格式头+404、静态文件 content-type 与 `..` 回退、catch-all 404 文案、畸形 JSON→500、非法项目 id→500),约 1-2 小时,全在现有测试模式内。

### KA3 — RunRegistry 的隐藏耦合:双键空间 + 内存/落盘双写不变量,提案只字未提

- **Claim**(提案建议 2):`controllers` Map + `instructionQueues` + `getQueue/drainFor` + pending-instructions 落盘(原 `:124-145`,行号核实准确)可抽为 RunRegistry。
- **Steelman**:这四样确实是同生共死的有状态组,四处使用点(launch/resume/cancel/instruct)的说法核实属实。
- **攻击**,提案没说的三件事:
  1. **双键空间**:`controllers` 按 **requestId** 键(`:327`、`:434`、`:491`),`instructionQueues` 按 **run.id** 键(`:456`、`:493`、`:364/502`)。instruct 路由先 `findRunByRequestId` 再按键入队。RunRegistry 若统一键空间或抽错键,cancel/instruct 即静默失配。
  2. **双写不变量**:instruct 同时推内存队列和 `store().savePendingInstructions`(`:466-467`);drain 同时 `splice` 内存和覆写磁盘(`:142-143`);resume 从磁盘读回灌内存(`:493-496`)。内存与磁盘的一致性是跨三个使用点维持的——RunRegistry 必须**同时拥有两侧写入**,否则不变量被模块边界切开。提案开放问题里问了"谁持有落盘时机",说明作者隐约意识到,但建议 2 的措辞把落盘列为 Registry 内部细节,与 instruct 路由经 `store()` 落盘的现状不符。
  3. **跨域共享面**:拆四文件后,`library` 实例被 projectsRuns(bindAssets `:335`、publish `:523`)、versions(export `:585`)、library 全域三方需要;`deps.makeAdapters` 被 projectsRuns、versions、library(fetch `:837`)三方需要;`parsePdf`、`projectDir`、`resolveIncrementalBase`、`configPath` 各有归属。提案对"共享闭包状态如何在模块间传递"完全沉默——不是做不了(ctx 对象注入即可),而是 PRD 阶段才发现注入面有 7+ 个依赖时,"极小匹配器十几行"的体量叙事会一并膨胀。
- **Fails if**:Registry 只抽 Map 不抽落盘、或键空间归一、或 routes 文件间经 server.ts 中转共享实例引入新生命周期。
- **Evidence to get this week**:已在此——`:124-145`、`:327/434/456/466/491/493` 的键与写入点对照。
- **Kill criterion**:若 PRD 的 RunRegistry 接口签名不同时拥有(a) 内存队列、(b) `savePendingInstructions` 写入侧、(c) 双键空间的显式文档,打回。
- **Cheapest test**:先写 RunRegistry 接口类型签名 + 让现有 2.1 两个 e2e(`server.test.ts:455`、`:511`,它们恰好钉住入队→落盘→drain→取消→恢复消费全链)对着接口跑通,再动路由文件。

### KA4 — "统一路由级错误处理"与"状态码逐位不变"存在未化解的张力

- **Claim**(提案建议 4):错误处理不一致(library 有 try/catch,projects 靠外层 500),拆分时统一。
- **Steelman**:不一致属实(`:757/773/788/836/868` 局部 catch→400 vs 其余靠 `:190-192` 外层 500),统一有价值。
- **攻击**:当前 400/500 分布是**偶然的、逐路由的**:library 治理路由业务错误→400;项目域 zod 校验失败→500;非法项目 id→500;畸形 JSON→500;migrate 缺 confirm→400(路由内显式)。"统一"若被实施者理解为**规范化**(如 zod 统一 400、域内统一 try/catch 兜底 400),每处都是状态码变更,直接违反约束 1;若理解为**机械保留现状映射**,那"统一"仅剩"把外层 catch 挪进匹配器"这一个行为中性动作,建议 4 的实际内容近乎为空。提案把两个互相挤占的目标并置而没有给出裁决规则。
- **Fails if**:PRD/GRILL 不把"统一"定义为"保留现状的逐路由错误→状态码映射表"。
- **Evidence to get this week**:已在此——路由级错误→状态码现状清单(KA2 已列)。
- **Kill criterion**:PRD 无逐路由错误映射表,打回。
- **Cheapest test**:随 KA2 的表征测试一并锁定,零额外机制。

### KA5(次要,证据可信度)— "已核实"证据块多处漂移,削弱其余数字的可信度

实测:整文件 **971** 行(提案 969);`server.test.ts` **638 行/15 测试**(提案 602/14);情报库按 method-path 计 **16 条**(提案 14,按路径并合计 12-13);launch/resume 实际行号 `:358-380`/`:497-517`(提案 `:357-379`/`:496-516`);`handle()` 实为 195-962。单项都小,模式一致:证据块在撰写时点未复核。另外"圈复杂度 233、全仓库第二热点"来自 codebase-memory 图谱,本环境无法独立复算(P0-1 红队对同类数字做过相同标注),不据此攻击也不背书。建议 PRD 阶段重跑一遍计数再引用。

## What's Well-Reasoned

- **四域读法与结构判断属实**:`handle()` 确为约 765 行单 if 链,四域划分(项目/runs、情报库、settings、静态文件+启动清扫/指令队列)与代码实际分布吻合;`:124-145` 行号精确。
- **不引框架正确**:`package.json` 无任何 web 框架依赖,测试直接 `fetch` 打真实 HTTP;为这个体量引框架才是真风险。匹配器本身十几行并非不可能(当前无方法级顺序冲突,真正的复杂性在 fall-through/500 怪癖,已列入 KA2)。
- **RunRegistry 识别为承重状态正确**,且现有 2.1 两个 e2e 测试对队列/落盘/恢复链路的钉住是真材实料——这是全提案最坚实的部分。
- **约束范围克制且与事实吻合**:不动 contracts/adapters 合理;`startServer` 签名约束匹配唯一生产调用点 `src/cli.ts:271`;情报库 14 条路由的 try/catch 不一致观察属实。
- **把匹配器形状、Registry 边界、静态文件归属留作 PRD/GRILL 开放问题**,是提案级文档的正确颗粒度——KA1-KA4 都是 PRD 阶段可廉价化解的,不是提案级死罪。
- 值得说明:安全网实际比提案声称的**更宽**(32 个 HTTP 测试而非 14 个),方向上是好消息。

## What I Couldn't Assess

- 圈复杂度 233 / "第二热点"(图谱数据,不可复算,见 KA5)。
- P1-3 相对其他 P1 项的优先级排序(无 roadmap 上下文)。
- 拆分后各文件的真实可读性收益(属实施后判断)。

## Verdict: go 附前置条件

没有任何一条 kill-assumption 的 kill criterion 已被满足——代码现状与提案方向兼容,测试基础真实存在。但以下四条应在 PRD 阶段作为准入门,全部廉价(合计约半天):

1. **KA1**:为 launch/resume 两种失败形状各补表征断言,或 PRD 显式选定保留形状并记为有意行为变更;提案建议 3 的"几乎逐行相同"措辞须更正为"骨架同构、catch 语义不同"。
2. **KA2**:验证节改为"`npm test` 全量(5 个 HTTP 套件,32 测试)原样通过",并补 formal/静态文件/catch-all 404/畸形 JSON→500/非法 id→500 的表征测试。
3. **KA3**:PRD 必须给出 RunRegistry 接口签名,显式拥有内存队列+落盘双写两侧,并文档化 requestId/run.id 双键空间;同时列出 7 个共享依赖的注入方式(建议单 ctx 对象)。
4. **KA4**:错误→状态码逐路由映射表进 PRD,"统一"定义为机械保留现状映射,而非规范化。
