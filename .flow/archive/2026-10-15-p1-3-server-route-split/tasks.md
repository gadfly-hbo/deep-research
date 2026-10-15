# P1-3 任务切片(server.ts 路由域拆分 + RunRegistry)

来源:`.flow/prd.md`(GRILL 2 轮已收敛)。纯重构,HTTP 行为逐位不变。每个切片完成后 `npm test` 必须全绿。
切片自批准(auto 模式)理由:切片顺序由 PRD 的准入门(T0 表征测试先行)与依赖关系机械导出,无自由裁量。

- [x] 1. T0 表征测试先行(12 条,钉住未覆盖 HTTP 行为) — 证据:`npx vitest run src/server/characterization.test.ts` 12/12 通过(连跑 3 次稳定);全仓 `npm test` 55 文件 335 测试全绿;typecheck 通过。注:全仓基线实为 323(grep 口径 322 漏计,vitest 实测为准)
- [x] 2. T1 RunRegistry 抽取(纯内存类 + 单测,server.ts 内部换用,不搬路由) — 证据:`npx vitest run` 56 文件 343 测试全绿(含表征 12 + Registry 单测 8);typecheck 通过。裁决记录:instruct 用 pendingCount 入队前预检(逐位保留现状,D3 括注的"enqueue 返回值判 409"会让第 21 条先入队再拒);Registry 增 snapshot() 防御性拷贝读方法(R2-7 双写落盘的最小必要扩展)
- [x] 3. T2 projectsRuns 域拆出(含 launch/resume 骨架合并、drainAndPersist) — 证据:`npx vitest run` 56 文件 343 全绿;typecheck 通过;server.ts 971→573 行。裁决记录:(a) acquire 位置微移至 runOnProject 紧邻处——仅 bindAssets/落盘抛错的库 I/O 故障角落可观测(原代码泄漏已注册 controller),正常路径零差异,D4 骨架定义即此裁决;(b) resolveIncrementalBase 按 R2-5 为 projectsRuns 模块级函数,不进 ctx(覆盖 D2 该条目)
- [x] 4. T3 versions 域拆出(versions 子树 + snapshots) — 证据:`npx vitest run` 56 文件 343 全绿;typecheck 通过;提交 1c192e9。注:子代理配额中断后由主代理完成(versions.ts 主体为子代理半成品,主代理核验逐位一致后接线);server.ts 573→475 行
- [x] 5. T4 library 域拆出(15 块 + migrate) — 证据:`npx vitest run` 56 文件 343 全绿;typecheck 通过;提交 28f6a0e;server.ts 475→189 行。注:子代理配额中断,主代理执行;library 三个既有套件(5+7+4)+ reuseRunRoutes 全绿
- [x] 6. T5 settings 域 + routes/http.ts + 壳层收尾(stripKeys/KEYISH 归位) — 证据:`npm test` 56 文件 343 全绿;typecheck 通过;提交 9016b0e;server.ts 189→147 行(全程 971→147,达标 <200)。Ctx 自 projectsRuns.ts 迁入 http.ts,四域 import 单向

---

## 1. T0 表征测试先行

## What to build

新文件 `src/server/characterization.test.ts`,12 条 HTTP 级表征测试,复用 `startServer({ dataDir, makeAdapters: () => fakeAdapters() })` + 真实 fetch 模式(同 server.test.ts)。**针对当前单文件 server.ts 写,全部必须通过**(钉现状,不是钉期望)。

清单(PRD Testing 节 T1–T12):launch 失败全新 failed 记录字段白名单;resume 失败展开合并白名单;formal 端点形状(200/404/content-disposition);静态文件(ui-dist 夹具,beforeAll 自建、index.html 不覆盖已有、唯一样本名);catch-all 404 文案;畸形 JSON→500;非法 id `bad!!`→500 + 非法 id 未匹配子路径→500;cancel 404;resume 404/409;rerun 404;instruct 队列满 409(直写 running 记录 + 21 次 instruct);resume 后 bindings usages 不增长。

## Acceptance criteria

- [ ] 12 条测试全部针对重构前 server.ts 通过
- [ ] `npm test` 全仓绿(实测基线 323 + 12 = 335)
- [ ] 断言到字段级(白名单),无弱断言

## Blocked by

None - can start immediately

---

## 2. T1 RunRegistry 抽取

## What to build

`src/server/runRegistry.ts`:纯内存、无 I/O 的 RunRegistry 类,按 PRD D3 接口(acquire/release/cancel 按 requestId,cancel 键原样透传 unknown;enqueue/pendingCount/drain/restoreFromDisk 按 run.id,restoreFromDisk 含 InterventionSchema.safeParse 过滤)。server.ts 内部的两个裸 Map 换用 Registry,**不搬任何路由**;drainFor/getQueue 改为薄包装,双写编排位置不变。

配套 `src/server/runRegistry.test.ts` 单测:双键空间隔离、restoreFromDisk 过滤(合法入/非法弃)、drain 清空、cancel 原样键。

## Acceptance criteria

- [ ] server.ts 不再直接持有 controllers/instructionQueues 裸 Map
- [ ] Registry 单测覆盖上述四组语义
- [ ] `npm test` 全绿(334 + Registry 单测)

## Blocked by

T0

---

## 3. T2 projectsRuns 域拆出

## What to build

`src/server/routes/projectsRuns.ts`:17 个匹配块(附录 A 第 1–12 项中除 versions/snapshots 外的项目域路由)。含:`resolveIncrementalBase`/`IncrementalRefSchema` 迁入;launch/resume 参数化骨架(catch 策略参数化,D4 差异机械保留,resume 不传 runId);`drainAndPersist` helper(空队列跳过落盘,R2-2);instruct 双写顺序保留(R2-7)。**先验 id 再分发**(D1 怪癖);`/versions/*`、`/snapshots` 子路径暂仍由 server.ts 处理(T3 再迁)——projectsRuns 对这些 rest 返回 false。

## Acceptance criteria

- [ ] server.ts 不再含项目域路由代码
- [ ] 非法 id + 未匹配子路径仍 500(表征测试 T7 守护)
- [ ] `npm test` 全绿

## Blocked by

T1

---

## 4. T3 versions 域拆出

## What to build

`src/server/routes/versions.ts`:`handleVersionRoutes(ctx, res, { id, dir, rest, url, method })` 子 handler(R2-1),承接附录 A 第 13–17 项(versions 子树 4 端点 + snapshots)。projectsRuns 在验 id 后委托。`/snapshots` 单文件读(sid 哈希→文件名、原始 sid 永不拼路径、只回 bodyText)逐字符保留。

## Acceptance criteria

- [ ] server.ts 不再含 versions/snapshots 代码
- [ ] formal/snapshots 表征测试(T3 条)与既有套件全绿

## Blocked by

T2

---

## 5. T4 library 域拆出

## What to build

`src/server/routes/library.ts`:15 个情报库匹配块 + `/api/migrate`(附录 A 第 18–33 项)。5 处局部 try/catch→400 **原样机械搬迁**(diff gate 注记 8);regex 匹配顺序逐位保留。

## Acceptance criteria

- [ ] server.ts 不再含情报库路由代码
- [ ] library 三个既有套件(5+7+4)与 reuseRunRoutes 全绿

## Blocked by

T3

---

## 6. T5 settings 域 + http.ts + 壳层收尾

## What to build

`src/server/routes/settings.ts`(GET/POST /api/settings,stripKeys/KEYISH 迁入,合并语义/模型链首/chmod 0600 保留);`src/server/routes/http.ts`(json/PROJECT_ID/Ctx,import 单向);server.ts 收尾为:启动装配 + body 预解析 + 按序调用四域 handler + 静态文件 + catch-all。`DEFAULT_BUDGET` import 维持原样。

## Acceptance criteria

- [ ] server.ts 仅剩壳层(目标 < 200 行)
- [ ] `npm test && npm run typecheck` 全绿
- [ ] 附录 A 全部 37 项行为逐条可追溯

## Blocked by

T4
