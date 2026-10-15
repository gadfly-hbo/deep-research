# P1-4 PRD:PlanView 请求编排下沉 + formalReady 探测改服务端标记

> 规格来源:`.flow/proposal.md`(最高优先);红队前置条件:`.flow/red-team.md` KA1–KA4 已全部并入。
> 无项目 issue tracker,按 dev-flow 回退规则落盘本文件。

## Problem Statement

两处已核实的 UI 层浪费/混乱:(1) `ui/views/PlanView.tsx`(516 行)把 plan-preview/outline-preview 的请求编排(参数拼装、busy/toast 时序、增量基准装配)内联在视图里,视图与请求逻辑耦合;(2) `ui/state/projectDetail.tsx:129-146` 的 formalReady 探测在版本集合每次变化时对每个版本发一次 fetch——拉取的是**整个 formal.json body** 却只用 `res.ok` 一个比特,且该探测与 `genFormal` 的乐观置位共同维持不变量,直接删除会让存量已生成版本在页面加载时显示"未生成"。

## Solution

1. 服务端 GET `/api/projects/:id` 的 `meta.versions` 每项**响应时计算**追加 `formalGenerated: boolean`(existsSync 探测产物文件,KA1 方案:不持久化、零迁移、产物文件即事实源);`ui/state/types.ts` 的 `VersionEntry` 镜像该字段。
2. UI 删除 :129-146 的探测 effect,formalReady 改为从轮询到的 `detail.meta.versions` 派生(merge 语义只增不减,与 genFormal 乐观置位共存,KA2);genFormal 的乐观置位保留。
3. 新建 `ui/state/planWizard.tsx`(KA4:独立小 hook,**不并入** projectDetail)持有 previewPlan/previewOutline 请求编排与 busy 状态;PlanView 只剩表单/渲染/按钮绑定。请求入参拼装(module/goal/scope/incrementalOf/baseRun)逐字保留。

## User Stories

1. 作为用户,我要打开项目页时正确看到各版本正式报告是否已生成(含存量版本),以便不重复生成。
2. 作为用户,我要计划预览/框架预览/增量追问向导的行为与现在完全一致,以便无感升级。
3. 作为维护者,我要 PlanView 只管渲染,以便改向导逻辑时不碰视图。
4. 作为维护者,我要 formalReady 不再靠逐版本探测 fetch,以便轮询负载不随版本数线性膨胀。

## Implementation Decisions

- **D1 formalGenerated 响应时计算(红队 KA1 裁决)**:在 `routes/projectsRuns.ts` 的 GET 详情处,序列化 meta 前对每个 version 计算 `existsSync(join(dir,"reports",v${v},"formal","formal.json"))` 并填入 `formalGenerated`。**不落盘、不进 fsStore 的 VersionEntry 持久化形状**(存量版本零迁移;产物文件即唯一事实源)。每 2.5s 轮询每版本一次 stat,严格省于现状整 body fetch。
- **D2 UI formalReady 派生(红队 KA2)**:删除探测 effect;`formalReady` 由 detail 轮询数据派生——`detail.meta.versions.reduce((m,v)=>({...m,[v.version]: m[v.version]||v.formalGenerated}), prev)` 只增不减;`genFormal` 成功后的乐观置位保留(生成→立即见,不等下一轮询)。
- **D3 planWizard hook(红队 KA4)**:新文件 `ui/state/planWizard.tsx`,导出如 `usePlanWizard({projectId, module, meta})` 的 hook,持有 `busy/plan/baseSummary/outline` 状态与 `previewPlan(form)/previewOutline(form,plan)` 动作(内部沿用 `ui/state/api.ts` 的 `post` 与 `toast`);projectDetail.tsx 不动;PlanView.tsx 目标 <420 行,`fetch/post` 直接调用清零。
- **D4 兼容**:服务端 `POST /versions/:v/formal` 与 formal 下载端点形状不变(无破坏);探测端点(GET formal/:fmt)保留——它是下载/查看功能的正式用途,只是 UI 不再用它探测。

## Testing Decisions

- 服务端:`server.test.ts` 风格 HTTP 测试——发布两个版本、仅对一个 POST formal 后,GET `/api/projects/:id` 断言 `meta.versions` 的 `formalGenerated` 分别为 true/false;对**预置产物文件但未走 POST 的存量形状**(手写 reports/v1/formal/formal.json)断言 true(钉住响应时计算语义)。
- UI:ui/ 无测试基础设施(红队 KA3),本批不新引测试框架;验证 = typecheck(含 ui/tsconfig)+ UI-GATE 静态原型钉形状 + SHIP 前两条手工冒烟(计划预览全流程;formal 生成→刷新→已生成标记)。
- 全程 `npm test`(vitest,src/)+ `npm run typecheck` 绿;P1-3 的 355 条(343+本批新增)不得回退。

## Out of Scope

- 任何 wizard 交互/文案/视觉变化;formal 下载链路改动;projectDetail.tsx 其他职责;轮询节奏调整(P0-2 遗留的退避建议);ui 测试框架引入。

## Further Notes

- 红队 KA3 明示本批"已验证"声明依赖 UI-GATE 原型 + 手工冒烟,二者缺失时 DONE 只能标"部分验证"。

---

## PRD diff gate 记录(auto 模式)

相对 proposal.md:全部为**开放问题的裁决与新增细化**,无 change/drop 已决事项——

1. proposal 开放问题"标记放 bundle 还是 meta" → 裁决:meta.versions 响应时计算(D1);"bundle 里带"选项被否(探测的是 meta 轮询链路,放 bundle 仍需逐版本 fetch,不省)。
2. 开放问题"探测端点是否保留" → 保留(D4,它是下载正式用途)。
3. 开放问题"state 文件形状" → 新建 planWizard.tsx,不并入 projectDetail(D3,红队 KA4)。
4. 开放问题"如何验证" → 服务端 HTTP 测试 + UI-GATE 原型 + 手工冒烟两件套(KA3)。
5. 新增:formalReady 派生语义只增不减(D2)、存量版本零迁移(D1)。

---

## GRILL 第 1 轮决议(降级内联:子代理 403 配额,主代理自审,history 已记录)

1. **R1-1 状态归属边界**:planWizard hook 持有 `busy/plan/baseSummary/outline`(请求编排产物);`wizard 开关/form/selected 复用资产/baseRun` 留在视图(它们是向导 UI 状态与 startRun 入参,非请求编排;实测 PlanView :23-34 共 10 个 useState,下沉其中 4 个)。`previewPlan(form, baseRun)/previewOutline(form, plan, baseRun)` 以参数收视图值,返回结果同时由 hook 持有并回传——视图按钮绑定 `void hw.previewPlan(form, baseRun)`。
2. **R1-2 formalGenerated 只进详情端点**:GET `/api/projects`(列表)与 `/archive` 均不计算(列表 UI 不展示 formal 状态,避免每列表页 N×M 次 stat);仅 GET `/api/projects/:id` 计算。
3. **R1-3 服务端测试落点**:`server.test.ts` 新增一个 describe(复用其既有 startServer+fetch 模式与夹具),不新建文件。
4. **R1-4 reuse 资产选择器不动**:PlanView 的 reuseQuery/reuseHits/selected(:29-31)属资产选择 UI,不在"previewPlan/previewOutline 编排下沉"范围内,原样留在视图(最小变更)。

第 2 轮(主代理):提案 4 个开放问题已全部裁决,红队 KA1–KA4 已并入 PRD,无新开放问题 → **GRILL 收敛(实际 1 轮有效 + 复核轮)**。本批次有用户可见 UI 范围 → UI-GATE。
