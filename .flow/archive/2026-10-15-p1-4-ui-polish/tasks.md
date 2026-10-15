# P1-4 任务切片(PlanView 下沉 + formalReady 服务端标记)

来源:`.flow/prd.md`(红队 KA1–KA4、GRILL R1-1~R1-4 已并入);UI 契约已获用户批准。
切片自批准(auto)理由:两条垂直切片直接对应提案两项,依赖单向(切片 1 是切片 2 的前置无关项,可并行但按序执行)。

- [x] 1. 切片 A:formalGenerated 端到端(服务端响应时计算 + UI 派生替换探测) — 证据:TDD 红(新测试 ENOENT 前断言 [false,false] 先行验证)→ 绿:`npx vitest run src/server/server.test.ts` 16/16;全仓 `npm test` 56 文件 344 全绿(343+1);typecheck(src+ui)通过;提交 42a9f5d。存量手写产物 true、列表端点无该字段(负例)均已断言
- [x] 2. 切片 B:planWizard hook 下沉(请求编排移出 PlanView,行为不变) — 证据:`npm run typecheck` 通过;`npm test` 56 文件 344 全绿;提交 18af90a。**偏差记录**:PlanView 516→472 行,未达 PRD D3 的 <420 估计值——剩余行数含 R1-4 明确不动的复用资产选择器(~90 行),编排已全部下沉(视图内 post(/fetch( 计数为 0);<420 为编写 PRD 时的估算,未计入选择器留驻,以 R1-4(最小变更)为准

---

## 1. 切片 A:formalGenerated 端到端

## What to build

服务端 GET `/api/projects/:id` 的 `meta.versions` 每项**响应时**追加 `formalGenerated: boolean`(existsSync `reports/v${v}/formal/formal.json`,D1/KA1:不持久化、零迁移);`ui/state/types.ts` 的 `VersionEntry` 镜像该字段;`ui/state/projectDetail.tsx` 删除 :129-146 探测 effect,formalReady 改为从轮询 detail 派生(只增不减,D2/KA2),genFormal 乐观置位保留。列表端点与 archive 端点不带该字段(R1-2)。

## Acceptance criteria

- [ ] server.test.ts 新 describe:双版本仅一生成 formal → GET 详情断言两版本 formalGenerated true/false;手写存量产物文件(未经 POST)同样断言 true(钉响应时计算语义)
- [ ] projectDetail.tsx 探测 effect 删除,formalReady 派生 merge 只增不减
- [ ] `npm test && npm run typecheck` 全绿(343 + 新增)
- [ ] 负例:GET /api/projects 列表响应不含 formalGenerated

## Blocked by

None - can start immediately

---

## 2. 切片 B:planWizard hook 下沉

## What to build

新建 `ui/state/planWizard.tsx`(KA4/R1-1):`usePlanWizard` 持有 `busy/plan/baseSummary/outline` 与 `previewPlan(form, baseRun)/previewOutline(form, plan, baseRun)`(入参拼装逐字保留,module/goal/scope/incrementalOf),内部沿用 `ui/state/api.ts` 的 post 与 toast;PlanView 只剩表单/渲染/按钮绑定,`wizard/form/selected/baseRun` 留视图(R1-1),复用资产选择器不动(R1-4)。

## Acceptance criteria

- [ ] PlanView.tsx 行数显著下降(516 → 目标 <420),文件内 `post(`/`fetch(` 直接调用清零
- [ ] previewPlan/previewOutline 入参拼装与现状逐字一致(diff 核对)
- [ ] `npm run typecheck` 绿;UI 契约负例:向导无任何文案/步骤/禁用时序变化

## Blocked by

None(与切片 A 独立;按序执行)
