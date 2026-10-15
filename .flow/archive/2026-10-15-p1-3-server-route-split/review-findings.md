# P1-3 REVIEW 报告

> 评审模式:**降级内联**(评审子代理两次 403 配额中断,按流程回退主代理内联执行 code-review;与实现者同上下文,对抗性弱于规格要求,已在 history 记录、DONE 披露)。
> 固定点:52a23a9(baseline_dirty=[],无用户预存改动)。范围:`git diff 52a23a9..HEAD` = 6 commits、9 文件、+1662/−854,全部位于 src/server/(8 个源/测试文件)+ 无其他目录。

## Standards 轴

- 代码风格与仓库一致:中文注释、现有命名/模块约定;typecheck 0 错误。
- 逐行搬迁核验:原 server.ts 589 条代码行中 74 条未逐字出现,逐条归因全部为 PRD 批准的机械替换(store()→ctx.storeFor(id) 17=17、deps.X→ctx.X、裸 Map→Registry 方法、import 路径、http.ts 迁移),25 项期望等价行脚本核验全部在场;未发现任何抄写漂移(参数顺序/文案标点/条件边界)。
- judgement call(non-blocking):各域 handler 的 `body: any`——沿袭原 server.ts 隐式 any 风格,非本次引入;`drainAndPersist`/settings 域 `handleSettingsRoutes` 保留 url 参数统一签名——纯形状一致性的代价,非投机抽象。

## Spec 轴

逐项比对 `.flow/prd.md`(D1–D6、附录 A、GRILL R1/R2 决议):

- **附录 A 37 项行为**:经 12 条表征测试(全绿)+ 32 条既有 HTTP 套件 + 代码走查三方覆盖;抽样核验 D1 怪癖(id 校验先于子路由,projectsRuns.ts:216–217)、D3 双键空间与双写(cancel 原样透传 :360、pendingCount 预检 :380、enqueue→snapshot :390–391、restoreFromDisk :415、drainAndPersist 空跳过 :86–88)、D4 不对称(launch 传 runId :160;resume 不传 :420–425,T12 钉住)、D5 机械保留(library 5 处 try/catch→400 原样、regex 顺序逐位)。
- **无缺失/部分实现**:T0–T5 全部完成且勾选附真实证据(重跑 verify 与记录一致:56 文件 343 测试全绿 + typecheck exit 0)。
- **无 scope creep**:diff 未触碰 contracts/adapters/core/modules/ui;server.ts 对外签名(ServerDeps/RunningServer/startServer)未变;测试套件未改动既有文件(characterization.test.ts 为纯新增)。
- **测试作为证据**:12 条表征断言到字段/文案级(白名单、逐字文案、content-disposition、pending 序列 1..20、T12 基线等值),无弱断言/同义反复。

### Non-blocking findings(记录,不行动)

1. **[implementation,judgement] T2 acquire 位置微移**:原代码在 bindAssets 前注册 controller,新骨架移至 runOnProject 紧邻处——仅 library I/O 中途故障的角落可观测(原行为泄漏一个已注册 controller,使后续 cancel 返回 200 而非 404);正常路径零差异。已在 tasks.md T2 裁决记录,D4 骨架定义即此形态。recheck:表征/回归测试无一覆盖该故障角落,属未钉面而非回归。
2. **[test,PRD-sanctioned] T4 夹具残留**:characterization T4 在仓库根 ui-dist/ 写入 2 个夹具文件且不清理——R2-4 明文批准(gitignored)。recheck:`git status` 不受影响即合规。
3. **[test,judgement] T2 checkpoints 钉的是 []→[]**:全链路从未写该字段,现状即空数组;若未来管线开始填值,该测试会红——这是有意的现状钉住,非缺陷。
4. **[task-record] T0 证据中"55 文件 335"与终态"56 文件 343"**:T0 时点数字准确(runRegistry.test.ts 于 T1 加入),无虚报。

## 裁决:PASS

无 blocking finding(spec 轴零未命中、零正确性 bug、零文档化标准违反);4 条 non-blocking 全部为已记录的判断性决策。recheck 判据:重跑 `npm test && npm run typecheck` 全绿(本评审已重跑,与 VERIFY 记录一致)。
