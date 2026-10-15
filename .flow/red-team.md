# Red-Team:P1-4 UI 顺手项 —— "PlanView 请求编排下沉 + formalReady 探测改服务端标记"

> 评审模式:**降级内联**(红队子代理 403 配额中断,主代理按 strategy-red-team 方法内联执行;对抗性弱于规格要求,DONE 披露)。
> 提案断言已逐条对照代码核验(仓库只读探查,未改代码)。

**Verdict:go(附前置条件)。** 两项建议方向均成立、证据属实;但 KA1 指出"标记放哪"存在一个数据迁移陷阱,KA3 指出本批 UI 无测试保障,须以 UI-GATE 原型 + 手工冒烟补验证。

---

## Top Kill-Assumptions(ranked)

### KA1 "服务端在 bundle/meta 里带 formalGenerated 标记" —— 持久化方案对存量数据是错的

- **Claim:** 提案开放问题允许把标记持久化进 `VersionEntry`(fsStore.ts:17 现无此字段)。
- **Fails if:** 生成 formal 时才写标记,则**功能上线前已生成 formal 的存量版本**字段缺失 → UI 显示"未生成"但产物在盘上(`projectService.ts:220` 写 `formal/formal.json`),用户会重复生成;更糟的是探测被删后无人兜底。
- **Evidence to get this week(已完成核实):** `generateFormal` 只写产物文件不写 meta;`VersionEntry` 形状如上;GET `/api/projects/:id` 直接透传 `s.meta()`(P1-3 后经 routes/projectsRuns.ts)。
- **Kill criterion:** 若 PRD 选择"持久化字段"且不附带存量回填/对账,kill 该实现方案。
- **Cheapest test:** **响应时计算,不持久化**——GET 详情序列化 versions 时对每版本 `existsSync(join(dir,"reports",`v${v}`,"formal","formal.json"))` 填 `formalGenerated`。零迁移、永不失真(产物文件即事实源),每 2.5s 轮询每版本一次 stat,成本可忽略(现状是每版本**整个 formal.json body** 的 fetch,严格更省)。PRD 必须钉死此方案。

### KA2 "探测可以删" —— genFormal 的乐观置位与探测的分工要先理清

- **Claim:** 删除 projectDetail.tsx:129-146 的探测后 formalReady 仍正确。
- **Fails if:** 忽略了探测与 `genFormal`(:160-171,POST 成功后乐观 `setFormalReady[v]=true`)共同维持不变量:探测覆盖"页面加载时已生成的版本",乐观置位覆盖"刚生成的版本"。删探测后,前者必须由轮询 detail 携带的 `formalGenerated` 接管——即 UI 从 `detail.meta.versions` 派生 formalReady(merge 语义保持只增不减,与现状乐观置位一致)。若只删探测不接派生,旧版本在页面加载时永远显示"未生成"。
- **Kill criterion:** 实现若不同步派生逻辑,kill。
- **Cheapest test:** 手工:预置一个已生成 formal 的版本 → 刷新页面 → PublishView/DraftView 应显示已生成(现探测路径行为不变)。

### KA3 "UI 顺手项低风险" —— ui/ 零测试,行为回归只能靠人

- **Claim:** 两项都是挪代码,`npm test` + typecheck 绿即可交付。
- **Fails if:** vitest include 为 `src/**/*.test.ts`——**ui/ 目录没有任何测试**;PlanView 的增量追问向导(参数预填 :70-78、previewPlan/previewOutline 的 busy/toast 时序 :88-127)是纯手工可回归面。typecheck 对状态时序、竞态、条件渲染零覆盖。
- **Kill criterion:** 若本批不产出 UI-GATE 原型(既有像素布局的状态快照)且不做两条手工冒烟(计划预览全流程、formal 生成→已生成标记),kill "已验证"声明。
- **Cheapest test:** UI-GATE 阶段产出 `.flow/ui/` 静态 HTML 原型钉住向导与 formalReady 两处 UI 形状;SHIP 前手工冒烟两条流(本地起 server + 真实 fake 适配器不可行,用 `npm run dev` 链路或最小 curl 验证 API 字段 + 浏览器点检)。

### KA4 "PlanView 下沉与 projectDetail 模式对齐" —— projectDetail 本身 333 行,对齐目标并不干净

- **Claim:** 下沉到 ui/state/ 即与既有模式对齐。
- **Fails if:** 把 previewPlan/previewOutline 塞进 projectDetail hook 会让它再长 60+ 行(它已含轮询/探测/startRun/genFormal/cancel 等十余职责)——与"顺手整理"的意图相反。正确形态是**新建 `ui/state/planWizard.tsx`**(或等价小 hook)持有向导请求编排与 busy 状态,PlanView 只剩表单/渲染/按钮绑定;projectDetail 不动。
- **Kill criterion:** 若 PRD 选择并入 projectDetail,kill 该方案(违反最小变更原则)。
- **Cheapest test:** 下沉后 PlanView.tsx 行数应显著下降(516 → 目标 <420),`grep fetch/post` 在 views/PlanView.tsx 应仅剩零星或零命中;previewPlan/previewOutline 的入参拼装(module/goal/scope/incrementalOf/baseRun)逐字保留。

---

## What's Well-Reasoned

- 两处浪费的证据链完整:探测每版本拉**整个 formal.json body**(而非 HEAD/标记)仅取 `res?.ok`(:131-146);PlanView 516 行实测属实,previewPlan/previewOutline 内联属实。
- "服务端带标记替代探测"方向正确且是网络行为的净减;提案把它明示为授权的 API 增量变化,边界诚实。
- 不动 contracts.ts/adapters 深接缝的约束与前两批一致,正确。

## What I Couldn't Assess

- 浏览器端实际轮询负载(未实测网络面板);formal.json 典型体积(依赖真实 bundle 内容)。两者只影响收益大小,不影响 go/no-go。
