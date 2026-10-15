# P2-3 任务切片(确认门翻转)

来源:`.flow/prd.md`(红队 Go 有条件 + GRILL R1-9 全并入;UI 契约已批准)。切片自批准(auto):红队必含项决定顺序,核心状态机先于 UI。

- [x] 1. T0 — 证据:planCheckpointLastWins.test 先红(find-first 取 v1)后绿(find-last);恢复判定扩 cancelled|awaiting|running+gates(CAS 流必需,偏离记录);contracts 枚举提前到本片(类型依赖);提交 4f01ddb
- [x] 2. T1 — 证据:confirmationGates.test ×3(门流 e2e 编辑版生效/无 gates 旧行为/增量+6 问截断);偏离:R1-4 outline 条件实为 gates.outline && !request.outline(字面 !options.plan 会杀死 outline 门——plan confirm 必传 options.plan 与 outline 阶段执行时序冲突,红队 R1-3 优先);提交 5a1529a
- [x] 3. T2 — 证据:gateRoutes.test ×4(GET 契约/守卫 409×2/并发恰一胜/outline 编辑版 cancel→resume 存活)+runRegistry.test ×2(锁);POST /runs 免 plan+gates;提交 0c4d4c7;360 全绿+tc0;server.test 阶段失败用例改带 plan 启动(免 plan 先落门到不了 gather,语义保留)
- [x] 4. T3 — 证据:c23b3d2(预览两块删除+server.test 两段重写门流+文档端点表)+a1667c9(planWizard 退役/PlanView 确认卡片/STATUS 五处/StageRoute 重定向);360 全绿+build 过;coder 浏览器 fake 冒烟全流走通+UI 契约负例 5 项自查全过;偏离 2 项(STATUS tone insuf=琥珀与原型一致而非字面 wait;文档端点表顺带更新,PRD D3 消费面含)
- [ ] 5. T4 恢复链路钉子+真实冒烟

---

## 1. T0 陷阱钉死测试 + 恢复判定扩展

## What to build
测试先行:saveCp("plan",v1)+saveCp("plan",v2-edited) 无 options.plan 恢复 → 断言 state.questions=v2(现状 find-first 取 v1,先红);runResearch.ts:416-417 改 find-last(绿);:91 恢复判定扩 `cancelled | awaiting-confirmation`。

## Acceptance criteria
- [ ] 新测试先红后绿;既有 350 全绿(cancelled 恢复行为不变)

## Blocked by
None

---

## 2. T1 编排器门

## What to build
RunOptions 增 `gates?: { plan: true; outline: true }`;plan 阶段产出后 gates.plan → saveCp("plan", 产出)+persistRun(status="awaiting-confirmation", gate={kind:"plan"},stage 保持 "plan")+return;confirm 后续跑(resuming 分支)→ outline 阶段执行条件 `gates.outline && !options.plan && !request.outline`(输入=已确认问题+增量上下文[R1-5:answeredQuestions/baseOutline 照 resolveIncrementalBase 形状])→ 同门 kind="outline";增量 6 问上限 slice(0,6);两门均为返回式(落盘返回,confirm 重启管线);run.gate 在 resuming 复位时由 confirm 端点 CAS 清理。

## Acceptance criteria
- [ ] gates 流 e2e(fake):起→plan 门→confirm(编辑)→outline 门→confirm→gather;编辑版生效
- [ ] CLI/测试无 gates 旧行为不变

## Blocked by
T0

---

## 3. T2 契约与 API

## What to build
contracts:status 枚举+`awaiting-confirmation`;`gate?: { kind: "plan"|"outline" }`;gate GET 响应 zod(R1-5 形状)。routes/projectsRuns:POST /runs plan 可选+body 无 plan 时传 gates;服务端守卫(同项目 running|awaiting → 409,POST /runs+rerun);gate 三端点(GET/confirm/cancel):RunRegistry 增 per-run gateLocks+per-project 锁;confirm=zod 校验(PlanOutputSchema/OutlineOutputSchema 复用)→锁内 CAS(status≠awaiting→409,清 gate 字段)→锁外 startPipeline(复用 resume 骨架:listRuns 反查 runId、pending 指令回灌、plan 门传 options.plan、outline 门注入 {...request, outline: payload});GET=payload+context+incremental(重跑 resolveIncrementalBase)。

## Acceptance criteria
- [ ] 端点测试:200/404/400/409、confirm×cancel 并发恰一胜、守卫 409
- [ ] outline 确认→cancel→resume→draft 用编辑版(R1-2 钉子)

## Blocked by
T1

---

## 4. T3 预览退役+UI

## What to build
删除 plan-preview/outline-preview 路由块(projectsRuns.ts:241-313)与 server.test 两段重写为门流(75-92/387-453,:589 注释);planWizard.tsx 退役;PlanView:表单保留+免 plan 起跑(startRun 签名 plan/outline 可选)→awaiting 分支渲染 S2/S3 确认卡片(gate GET+confirm/cancel;zod 前端约束;404 回退/409 轮询收敛);STATUS/STATUS_DOT 补"待确认/wait";五处展示点按 status 分支(GatherView/Inspector/Sidebar/StatusBar/PlanView banner);StageRoute awaiting 重定向 /plan。

## Acceptance criteria
- [ ] UI 契约负例:向导按钮零残留、awaiting 无"进行中零进度"假象、无 instruct 假入口
- [ ] npm test+typecheck+build 全绿

## Blocked by
T2

---

## 5. T4 恢复钉子+真实冒烟

## What to build
server.test 三钉子:awaiting 跨重启可确认(close→startServer 同 dataDir);gate/cancel 后 pending 指令 resume 回灌;outline 编辑版 cancel→resume 存活(若 T2 已含则此处回归)。真实冒烟:真实 LLM 起 run→awaiting→确认(编辑一问)→框架门→确认→gather 进行;serve 重启后 awaiting 仍在。

## Acceptance criteria
- [ ] 三钉子绿;真实冒烟双段证据(门流+重启 durable)

## Blocked by
T3
