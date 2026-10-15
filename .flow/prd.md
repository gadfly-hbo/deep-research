# P1-3 PRD:server.ts 路由域拆分 + RunRegistry 抽取(纯重构)

> 规格来源:`.flow/proposal.md`(最高优先)。红队前置条件:`.flow/red-team.md` KA1–KA4 为准入门,已全部并入本 PRD。
> 无项目 issue tracker(docs/agents/issue-tracker.md 不存在),按 dev-flow 回退规则落盘到本文件。
> GRILL 第 1 轮(author-blind 子代理)9 个问题包全部采纳,已并入 D2/D3/D4/D5/Testing/附录 A 与 diff gate 记录。

## Problem Statement

`src/server/server.ts` 已膨胀到 971 行、33 个路由匹配块,混杂四类互不相关的关注面:项目/运行生命周期、版本与产物、情报库治理、设置与静态文件。同时,运行态(AbortController、干预指令队列)以两个裸 `Map` 散落在闭包里,键空间不一致(controllers 按 requestId、instructionQueues 按 run.id),内存与落盘双写不变量(instruct 双写、drain 后落盘、resume 回灌)没有任何接口封装,后续改动极易破坏这些隐式约定。

## Solution

纯重构,HTTP 行为逐位不变:

1. 把 33 个路由匹配块按域拆到 `src/server/routes/` 下四个路由模块,server.ts 只留启动装配与极小匹配器。
2. 把运行态抽出为 `RunRegistry` 类(纯内存、无 I/O),封装双键空间;落盘编排由 projectsRuns 域内 helper 完成。
3. launch 与 resume 的**同构骨架**合并为参数化函数;两者的 catch 语义差异与 options 不对称(见 D4)机械保留,不规范化。
4. 重构前先补 12 条表征测试钉住当前未覆盖的 HTTP 行为,作为回归安全网。

## User Stories

1. 作为维护者,我要路由按域分文件,以便定位某条路由时不用在 971 行里翻找。
2. 作为维护者,我要运行态有明确接口(RunRegistry),以便修改干预指令逻辑时不破坏双写不变量。
3. 作为维护者,我要 launch/resume 的公共骨架只写一份,以便新增启动类端点时复用。
4. 作为维护者,我要重构前后 `npm test` 全绿且 HTTP 行为逐位不变,以便放心合并。
5. 作为维护者,我要未覆盖的 HTTP 行为(formal 端点形状、静态文件、catch-all、畸形 JSON、非法项目 id、launch/resume 失败形状、projectsRuns 域 4xx 早退守卫)有表征测试,以便重构有安全网。
6. 作为代码审查者,我要逐路由错误映射有冻结清单(附录 A),以便 REVIEW 逐条比对。

## Implementation Decisions

### D1 文件布局

- `src/server/server.ts` — 只保留:ServerDeps/RunningServer 类型、启动装配(library openOrCreate + recoverStaging、启动清扫 running→failed)、`createServer` 外层 catch→500、body 预解析(畸形 JSON→500 必须在路由匹配**之前**)、极小匹配器(按序调用各域 handler)、静态文件服务、catch-all 404。
- `src/server/runRegistry.ts` — 新增 RunRegistry(见 D3)。
- `src/server/routes/http.ts` — `json()` 响应助手、`PROJECT_ID` 正则、`Ctx` 类型。无反向依赖,保证 import 单向(routes/* → http.ts,server.ts → routes/*),避免模块环/TDZ。
- `src/server/routes/projectsRuns.ts` — GET/POST `/api/projects`;`/api/projects/:id` 子树:GET 详情、plan-preview、outline-preview、runs(launch)、runs/rerun、runs/cancel、runs/instruct、runs/resume、publish、archive。launch/resume 参数化骨架与 `drainAndPersist` helper 也住这里。
- `src/server/routes/versions.ts` — `/versions/:v` 子树(formal POST、bundle GET、formal/:fmt GET、export GET)与 `/snapshots` GET。注意:版本子树在现状代码中位于 `/api/projects/:id` 块**内部**,搬迁时保持同样的前置条件(projectDir 校验先于版本匹配)。
- `src/server/routes/library.ts` — 15 条情报库路由 + `/api/migrate`(合计 16 个 method×path 组合)。
- `src/server/routes/settings.ts` — GET/POST `/api/settings`。

各域 handler 签名统一为 `(ctx, req, res, url, body) => Promise<boolean>`:返回 true 表示已处理,false 表示落到下一个域;server.ts 按现状路由优先级顺序依次调用,最后接静态文件与 catch-all。**匹配顺序逐位保留现状**(版本子树在 `/api/projects/:id` 块内、library 各 regex 的先后等),因为先匹配先返回是现状行为的一部分。

**关键怪癖(R1-Q2,必须保留)**:现状对**任何** `/api/projects/:id/*` 先调 `projectDir(id)` 再做子路由匹配——非法 id(不合 `PROJECT_ID` 正则但不含点段,如 `bad!!`)撞上**不存在的子路径**也是 500 而非 404。拆分后 projectsRuns 域必须在匹配到 `/api/projects/:id*` 前缀时先验 id 再分发;未知子路径不能抢在 id 校验前 return false。(注:字面 `..` 与 `%2E%2E` 会被 URL 解析归一化而到不了 projectMatch,落到 catch-all 404——这是现状,不动。)

### D2 共享依赖注入(单一 ctx 对象,启动级单例;R1-Q3 修订)

红队 KA3 指出的共享依赖收敛为一个**启动级单例** ctx 对象,各域 handler 只接收 ctx 不再各自闭包捕获:

- `dataDir`、`makeAdapters`(ServerDeps 原样)
- `library`(启动时 openOrCreate + recoverStaging 的产物)
- `parsePdf`
- `projectDir(id)`(非法 id 抛错→外层 500,行为保留)
- `storeFor(id)`(= `FsProjectStore.open(projectDir(id))`;现状的 `store()` 是请求级闭包,放不进启动单例——各域需要 store 时调 `storeFor(id)`,语义与现状"每调新开实例"逐字相同)
- `resolveIncrementalBase`
- `configPath`、`DEFAULT_BUDGET`、`KEYISH`、`stripKeys`(settings 域)
- `registry: RunRegistry`

### D3 RunRegistry 接口(R1-Q4 修订:纯内存、无 I/O)

封装现状两个裸 Map,**双键空间文档化**(KA3 硬性要求):

```ts
class RunRegistry {
  // 键空间 A:controllers 按 requestId(launch/resume 用 request.id ?? "" 作键;
  // cancel 按 body.requestId 原样查)
  acquire(requestId: string): AbortController        // set
  release(requestId: string): void                   // delete(finally)
  // cancel 查找键原样透传 body.requestId(含 undefined 的情形),
  // 404 文案插值 `${body.requestId}` 逐字保留(缺字段时文案含字面 "undefined")
  cancel(requestId: unknown): boolean                // get + abort;无则 false(路由据此 404)

  // 键空间 B:instructionQueues 按 run.id(非 requestId)
  enqueue(runId: string, record: Intervention): number  // push,返回队列长度(路由据此判 20 上限/409)
  pendingCount(runId: string): number
  drain(runId: string): Intervention[]               // 取空内存队列(drainFor 的内存侧)
  restoreFromDisk(runId: string, items: unknown[]): number  // resume 回灌,含 InterventionSchema.safeParse 过滤(现状 :493-496)
}
```

**Registry 纯内存、无 I/O**(R1-Q4 裁决,取方案 a):落盘走 `FsProjectStore.savePendingInstructions`,是 per-project 实例,启动级单例 Registry 无从知道项目目录。双写编排由 projectsRuns 域内 helper 完成:

- `drainAndPersist(dir, runId)` — 复刻现状 drainFor 语义:内存 drain → `savePendingInstructions(runId, 空队列)` 落盘(现状 :142-143),返回 drain 结果作为 `pollInstructions`。
- instruct 路由:enqueue 后由**同一路由块**调 `savePendingInstructions`(现状 :466-467 的双写,仍在同一处代码,只是 Registry 管内存侧)。
- resume 回灌:`readPendingInstructions(prior.id)` → `registry.restoreFromDisk(...)`(现状 :493-496)。

### D4 launch/resume 参数化骨架(KA1 更正 + R1-Q5 修订)

红队已证伪"几乎逐行相同":两者**骨架同构、catch 语义不同**。合并的仅限骨架(acquire controller → `void runOnProject(...)` → catch(策略) → finally release);**options 对象由各调用点自行构造**,catch 策略作为参数传入:

- launch 失败:落一条**全新** failed 记录(id=runId、requestId=request.id ?? runId、stage="gather"、checkpoints=[]、usage 全零、error=message)。
- resume 失败:读当前 run 记录,**展开合并**原记录只改 status="failed" + error;记录不存在则什么都不写。

**options 不对称是保留行为(R1-Q5,不修)**:launch 传 `runId`,resume 不传——`runResearch` 的复用资产注入门禁为 `if (options.library && options.runId)`,resume 路径该门禁为假,绑定资产注入与 usage 记录整体跳过(且 ingestToLibrary 的 acquisition 记录 `runId: undefined`)。这是 HTTP 可观测行为(resume 后 `/api/library/bindings?runId=` 的 usages 不增长),骨架合并时任何人不得"顺手"统一。

差异必须被表征测试钉住(见 Testing T1/T2/T12)。

### D5 错误→状态码映射(KA4,机械保留,非规范化;R1-Q1/Q8 修订)

"统一错误处理"在本批次的交付物 = **本映射表 + 附录 A 逐路由清单(文档化)+ 单一外层 500 兜底**;library 域的 5 处局部 try/catch 随路由**原样机械搬迁**,不做结构归一(任何结构归一都触碰状态码逐位不变约束 KA4)。兜底规则:**除下表与附录 A 已列明的行为外,其余一切未捕获异常 → 外层 catch → 500**。

| 场景 | 现状 | 保留 |
|---|---|---|
| 畸形 JSON body(路由匹配前解析) | 500 | ✓ |
| 非法项目 id(projectDir 抛错,先于子路由匹配) | 500(外层 catch) | ✓ |
| 合法 id 但项目不存在(FsProjectStore.open 抛"项目不存在") | 500(外层 catch) | ✓ |
| ResearchRequestSchema / zod `.parse` 失败(launch、rerun、PATCH asset 的 SourceSchema、plan/outline-preview 的 PlanOutputSchema/OutlineOutputSchema) | 500(外层 catch) | ✓ |
| incrementalOf 校验失败(作用于 plan-preview、outline-preview、launch、rerun 四个端点) | 400(缺 runId/requestId)/ 404(基准不属于本项目)/ 409(基准未完成)/ 404(成果包缺失),文案各异 | ✓ |
| publish 失败(无成果包/已发布/发布阻断/版本目录已存在) | 500(外层 catch) | ✓ |
| GET settings 遇损坏 config.json(JSON.parse 抛) | 500(外层 catch) | ✓ |
| 指令 zod `.safeParse` 失败(instruct) | 400 + issues | ✓ |
| cancel 无运行中 run | 404(缺 requestId 字段时文案含字面 `undefined`) | ✓ |
| instruct 无运行中 run / 队列满(20) | 409 / 409 | ✓ |
| resume 请求不存在 / 无已取消运行 | 404 / 409 | ✓ |
| rerun 原请求不存在 / 仍在运行 | 404 / 409 | ✓ |
| 版本不存在 | 404 | ✓ |
| formal 产物未生成 | 404(带提示文案) | ✓ |
| 快照不存在 | 404 | ✓ |
| library lifecycle/scope/corrections/fetch/delete 域内 try/catch | 400 | ✓ |
| PATCH/GET asset 不存在 | 404 | ✓ |
| library content 无权限 / 不可得 | 403 / 404 | ✓ |
| migrate 未 confirm | 400 | ✓ |
| settings 写入密钥字段 | 400 | ✓ |
| GET /api/projects 列表序 | readdirSync 序(不排序) | ✓ |
| entities/settings 的方法级 fall-through(仅处理 GET/POST,其余方法) | 落 catch-all 404 | ✓ |
| 静态文件:`..` 归一化后落 catch-all、存在的资源按扩展名 content-type(html/js/css/svg/map,其余 octet-stream)、未知非 api 路径 SPA 回退 index.html | 现状 | ✓ |
| catch-all | 404 `未找到: {method} {path}` | ✓ |

计数口径(GRILL 勘误):按 method×path 计全表共 35 条;PRD 标题口径"33"按 server.ts 的 if 块计(17 项目域块 + 15 情报库块 + 1 settings 块;entities 与 settings 各为一个块内两方法)。REVIEW 以附录 A 为准,不纠结口径数字。

### D6 不做的事

不改任何路由的 URL、方法、请求/响应形状、状态码、文案;不动 contracts/adapters;不引框架(Express/Fastify);不改 `startServer` 的对外签名(ServerDeps in,RunningServer out);不动 ui/ 任何文件;不修 resume 不传 runId 导致的 bindings usages 不增长(保留行为,见 D4)。

## Testing Decisions

好测试的标准:只测 HTTP 外部行为(状态码、body 形状、content-type、关键落盘记录字段),不测内部模块边界;表征测试钉**现状**,即使现状看起来可议(如 zod 失败→500),重构批次不改行为。

**先行表征测试(T0 任务,重构前落地,共 12 条,KA1+KA2+R1-Q6/Q7/Q9 准入):**

1. **T1** launch 后 runOnProject 立即失败 → 新 failed 记录,字段白名单断言:`stage="gather"`、`checkpoints=[]`、usage 全零(searches/fetches/costEstimate/wallMs=0)、`error` 含消息、`status="failed"`。(KA1)
2. **T2** resume 后 runOnProject 失败 → 原 run 记录字段白名单断言:`status="failed"`、`error` 新增、`id`/`requestId` 不变、`checkpoints` 沿用、`usage` 不归零。(KA1+R1-Q6;注意失败瞬间盘上记录的 stage/progress 相对取消前已合法变化,断言只用白名单,不做"逐字段等于取消前"的全等断言)
3. **T3** formal 端点形状:POST `/versions/:v/formal` 200;GET formal/:fmt 未生成时 404 及文案;json 为 inline、html/pptx 为 attachment。(KA2)
4. **T4** 静态文件:存在的资源 content-type 正确;未知非 api 路径 SPA 回退 index.html。(KA2+R1-Q9:**beforeAll 自建夹具**——`mkdirSync("ui-dist")` + 写 index.html 与若干扩展名样本文件;ui-dist 已 gitignore,不污染工作树,保证干净检出/CI 上同绿)
5. **T5** catch-all:任意未匹配 `/api/*` → 404 且 body 为 `未找到: {method} {path}`。(KA2)
6. **T6** 畸形 JSON body → 500。(KA2)
7. **T7** 非法项目 id → 500:用 `/api/projects/bad!!/runs`(R1-Q2 勘误:字面 `../evil` 与 `%2E%2E` 被 URL 归一化落到 catch-all 404,**不是** 500);另断言非法 id + 未匹配子路径(`GET /api/projects/bad!!/whatever`)→ 500 而非 404,钉住"id 校验先于子路由分发"的实现约束。
8. **T8** cancel 无运行中 run → 404(R1-Q7)。
9. **T9** resume 请求不存在 → 404;resume 无已取消运行 → 409(R1-Q7;两条断言)。
10. **T10** rerun 原请求不存在 → 404(R1-Q7)。
11. **T11** instruct 队列满:直写一条 running 记录 + 连续 instruct 21 次,第 21 次 → 409(上限 20),无需真跑流水线(R1-Q7)。
12. **T12** resume 后 `/api/library/bindings?runId=` 的 usages 不增长(resume 不传 runId 的保留行为,R1-Q5)。

**回归安全网(现状已存在,必须全程绿):** server.test.ts 15 + libraryRoutes 5 + libraryGovernanceRoutes 7 + librarySearchRoutes 4 + reuseRunRoutes 1 = 32 条 HTTP 测试;全仓 vitest 基线 **322 条**(R1-Q9 勘误:按 `^\s*(it|test)\(` 对 src/**/*.test.ts 实测,无 it.each;以 `npm test` 实际输出为最终准)与 `npm run typecheck`。

**RunRegistry 单测:** 双键空间(acquire/cancel 按 requestId、enqueue/drain 按 runId)、restoreFromDisk 的 safeParse 过滤(合法入队、非法丢弃)、drain 清空语义、cancel 原样键透传。Registry 纯内存无 I/O,单测无需文件系统。

**Prior art:** 现有 5 个 server 测试套件全部是"起真实 startServer + fetch"的 HTTP 级测试,新表征测试沿用同一模式。

## Out of Scope

- 任何 HTTP 行为变更(状态码规范化、文案修改、列表排序等一律不做)。
- contracts、adapters、core、modules、ui/ 的任何改动。
- 引入 Web 框架或路由库。
- server.ts 之外的性能优化。
- 真实 LLM 端到端用例(本批次为纯重构,安全网=表征测试 + 既有 32 条 HTTP 测试;launch/resume 的 runOnProject 在测试中注入失败桩——被测对象是 HTTP 层行为,不是被 mock 掉的核心业务)。

## Further Notes

- server.ts 实测 971 行(提案原文数字以本 PRD 为准,红队 KA5 勘误)。
- P0-2 的 `/snapshots` 单文件读(sid 哈希→文件名,原始 sid 永不拼路径)是安全敏感行为,versions 域搬迁时逐字符保留。

---

## 附录 A:逐路由清单(R1-Q1,REVIEW 冻结比对基线)

按 server.ts 现状 if 块顺序,method × path × 错误行为:

**server.ts 壳层(留在原地):**
0. body 预解析:POST/PATCH/PUT 畸形 JSON → 500

**projectsRuns 域(17 块):**
1. GET `/api/projects` → 200 `{projects}`,readdirSync 序,过滤 PROJECT_ID + project.json 存在
2. POST `/api/projects` → 200 `{dir, id}`
3. GET `/api/projects/:id` → 200 `{meta, runs, snapshots(剥离 bodyText)}`;非法 id→500;项目不存在→500
4. POST `:id/plan-preview` → 200 `{plan, cost[, base]}`;incrementalOf 四态 400/404/409/404;PlanOutputSchema.parse 失败→500
5. POST `:id/outline-preview` → 200 `{outline, cost[, base]}`;incrementalOf 四态同上;OutlineOutputSchema.parse 失败→500
6. POST `:id/runs` → 200 `{started, requestId, reuse}`;incrementalOf 四态;ResearchRequestSchema.parse→500;启动失败落全新 failed 记录(T1)
7. POST `:id/runs/rerun` → 200 同上;原请求不存在→404;运行中→409;budgetTier 非法→500(zod);incrementalOf 四态
8. POST `:id/runs/cancel` → 200 `{cancelled:true}`;无运行中 run→404(文案含原始 requestId 插值)
9. POST `:id/runs/instruct` → 200 `{queued, instructionId, pending, note}`;无运行中 run→409;指令非法→400+issues;队列满(20)→409
10. POST `:id/runs/resume` → 200 `{resumed, requestId, runId}`;请求不存在→404;无已取消运行→409;失败展开合并原记录(T2)
11. POST `:id/publish` → 200;publish 失败(无成果包/已发布/阻断/版本目录存在)→500
12. POST `:id/archive` → 200 `{status}`(archived !== false)
13. POST `:id/versions/:v/formal` → 200;版本不存在→404
14. GET `:id/versions/:v/bundle` → 200;版本不存在→404
15. GET `:id/versions/:v/formal/(html|pptx|json)` → 200 附件流;未生成→404 带文案;json=inline,其余 attachment
16. GET `:id/versions/:v/export` → 200 zip;版本不存在→404
17. GET `:id/snapshots?sid=` → 200 text/plain(仅 bodyText);不存在→404

**library 域(15 块 + migrate):**
18. POST `/api/library/assets` → 200 `{results}`(items 数组或单体;file 类 contentBase64 解码)
19. GET `/api/library/assets` → 200 `{assets}`(每 source 最新版本 + 最宽松 reuseScope)
20. GET `/api/library/bindings?runId=` → 200 `{bindings, usages}`
21. GET `/api/library/search` → 200 `{...outcome, results+applicability}`
22. GET `/api/library/check` → 200 check 结果
23. GET `/api/library/entities` → 200 `{entities+assetCount}`
24. POST `/api/library/entities` → 200 `{entityId}`(其余方法 fall-through→catch-all 404)
25. POST `/api/library/assets/:id/lifecycle` → 200;域内 catch→400
26. POST `/api/library/assets/:id/scope` → 200;域内 catch→400
27. POST `/api/library/assets/:id/corrections` → 200 `{version}`;域内 catch→400
28. POST `/api/migrate` → 200 report;!dryRun 且 !confirm→400
29. PATCH `/api/library/assets/:id` → 200 `{source}`;不存在→404;SourceSchema.parse→500(白名单 title/publisher/docType/tags/entityIds)
30. POST `/api/library/assets/fetch` → 200;域内 catch→400
31. GET `/api/library/assets/:id` → 200 `{source, versions, acquisitions}`;不存在→404
32. DELETE `/api/library/assets/:id` → 200;域内 catch→400(preview/confirm/force 双通道 query+body)
33. GET `/api/library/content/:id` → 200 text/plain;带 projectId 且无授权→403;原文不可得→404

**settings 域(1 块两方法):**
34. GET `/api/settings` → 200 `{config: stripKeys(raw), budgetDefaults}`;损坏 config.json→500
35. POST `/api/settings` → 200 `{saved:true}`;含密钥字段→400;合并语义(模型链首替换);chmod 0600(其余方法 fall-through→catch-all 404)

**壳层收尾(留在 server.ts):**
36. GET 非 `/api/` 静态文件:存在且非 `..` → 200 按扩展名 content-type;否则回退 index.html;index.html 也不存在则落到 37
37. catch-all → 404 `未找到: {method} {path}`

---

## PRD diff gate 记录(auto 模式)

相对 `.flow/proposal.md` 的差异:

1. 新增:提案说"launch/resume 去重",红队 KA1 证伪其"几乎逐行相同"前提 → PRD 更正为"骨架同构、catch 语义不同",去重范围限于骨架,catch 策略参数化保留差异(D4)。这是对提案**前提的勘误**,不改变提案"去重"的决策本身。
2. 新增:错误映射"统一"定义为机械保留现状(KA4),排除任何规范化解读。
3. 新增:RunRegistry 双键空间文档化 + 纯内存无 I/O + 域内 drainAndPersist helper(KA3 + R1-Q4)。
4. 新增:12 条表征测试清单(KA1/KA2 + R1-Q5/Q6/Q7/Q9)。
5. 新增:路由文件布局具体化为 4 个域文件 + runRegistry.ts + routes/http.ts(proposal 只说"四域拆分",此处为同义细化 + R1-Q3 的 http.ts)。
6. 新增:ctx 单对象注入清单,启动级单例 + storeFor(id)(KA3 + R1-Q3)。
7. 勘误:server.ts 行数以实测 971 为准(KA5);全仓测试基线 322 条(R1-Q9)。
8. **change 注记(R1-Q8)**:提案决策 4"统一路由级错误处理"的形态(提案开放问题之一)裁决为 = D5 映射表 + 附录 A 清单(文档化)+ 单一外层 500 兜底;library 域 5 处局部 try/catch **原样机械搬迁**,不做结构归一。理由:任何结构归一都触碰提案最高约束"HTTP 行为逐位不变"(KA4);此为回答提案自己留下的开放问题,非推翻提案决策。
9. 新增:resume 不传 runId(bindings usages 不增长)为显式保留行为(R1-Q5),列入 D6 不修清单。

结论:第 8 项为对提案开放问题的裁决并明示记录;其余全部为新增细化/勘误,无 change/drop 提案已决事项。auto 模式自批准,继续 → GRILL 第 2 轮。

---

## GRILL 第 2 轮决议(主代理自审,已全部解决并采纳)

1. **R2-1 versions 域交接形状**:projectsRuns handler 负责 `/api/projects/:id*` 前缀匹配并**先调 projectDir(id) 验 id**(保留 D1 怪癖),再对 `rest` 以 `/versions/` 或 `/snapshots` 开头的子路径委托 versions 域子 handler `handleVersionRoutes(ctx, res, { id, dir, rest, url, method }): Promise<boolean>`;其余子路径由 projectsRuns 自处理。snapshots 属产物读取,归 versions 域。
2. **R2-2 drainAndPersist 空队列跳过落盘**:复刻 drainFor 现状语义——内存队列空或不存在 → 直接返回 `[]` **不落盘**;非空 → splice 取空 → `savePendingInstructions(runId, [])` → 返回取出项。避免每次 poll 都写文件。D3 描述以此为准。
3. **R2-3 表征测试落点**:新文件 `src/server/characterization.test.ts`,复用 server.test.ts 的 `startServer({ dataDir, makeAdapters: () => fakeAdapters() })` + 真实 fetch 模式;12 条集中一处,便于 REVIEW 核对。
4. **R2-4 T4 夹具细节**:beforeAll 中 `mkdirSync("ui-dist", {recursive:true})`;index.html 仅在不存在时写入(不覆盖本机真实构建产物);样本文件用唯一名(`__char-fixture.js/.svg`);不清理(gitignored)。断言用 200 + content-type,不断言文件内容全文。
5. **R2-5 壳层归属明细**:`readBody` 留 server.ts(body 预解析在路由前);`stripKeys`/`KEYISH` 仅 settings 用 → 移入 settings.ts;`resolveIncrementalBase`/`IncrementalRefSchema` 仅 projectsRuns 用 → 移入 projectsRuns.ts;`DEFAULT_BUDGET` 为既有 import 维持原样;`json`/`PROJECT_ID`/`Ctx` 住 routes/http.ts。
6. **R2-6 T11 触发方式**:instruct 只查 `findRunByRequestId` 的 running 状态,不查 controllers——直接 `FsProjectStore` 写一条 running 记录即可确定性触发,连续 21 次 instruct,第 21 次断言 409。
7. **R2-7 instruct 双写顺序保留**:先 enqueue(内存 push)后 `savePendingInstructions` 落盘,与现状 :466-467 逐字一致。

第 2 轮未再发现新的实质开放问题(全部为可从代码直接裁决的实现细节),无提案冲突、无可逆性升级项 → **GRILL 收敛,共 2 轮**。本流程无用户可见 UI 范围(纯后端重构) → UI-GATE skipped → ISSUES。
