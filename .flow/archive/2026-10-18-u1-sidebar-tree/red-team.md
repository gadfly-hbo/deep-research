# Red-Team:侧边栏三级树(类型→项目→任务)+ 项目/任务自定义名称(批次 U1)

> 评审身份:全新上下文只读子代理(2026-10-18),按 strategy-red-team 技能执行;对象 = `.flow/proposal.md`。已完整读取提案与 Sidebar/ProjectsView/PlanView/state 层/contracts/projectService/fsStore/projectsRuns/server/cli/PublishView 等源码核实,提案行号引用全部准确。

## Steelman
- API 严格加法有硬支撑:`saveMeta` patch-merge(fsStore.ts:250-253)不洗 name;`GET /api/projects` 直通 meta() 零成本透出;CLI 结构化入参天然兼容。
- 启动清扫按 status 判断 + spread 落 failed(server.ts:99-103),新字段原样保留;恢复/rerun/followup/incremental 全按 runId/requestId 定位,不依赖名称语义——「名称只是展示层」定位正确。
- 版本子树移除不损失可达性:PublishView 版本卡片自足(PublishView.tsx:120-190)。
- UI 缓存刷新链路通:create 后 reload(projects.tsx:47);detail 2.5s 轮询在 updatedAt 变化时同步侧栏(projectDetail.tsx:127-131)。

## Top Kill-Assumptions(影响×可能性×测试廉价度排序)

### K1 任务进树的数据来源——提案未覆盖(范围定义缺口)
侧栏列表来自 `GET /api/projects` 只返回 meta()(projectsRuns.ts:210-218),不含 runs;「最近运行」区可行仅因读当前项目 detail 轮询(Sidebar.tsx:136)。任务挂全树只有三路:(a) 扩列表端点附 runs;(b) 前端 N+1 拉各项目 detail 轮询;(c) 只展示当前项目任务(树退化两级)。开放问题 4 只谈数量排序,没谈数据来源与刷新。**Kill 判据:PRD 不在三选一中明确选择并写代价 → kill 回 PRD。**

### K2 任务名称读写路径——readRun 的 zod strip 会静默吞 name
UI 渲染的是 ResearchRun(Sidebar/GatherView/PublishView 只有 run.requestId 可用)。路径甲(冗余进 run.json):须同时改 ResearchRunSchema + launchRun 落 running 记录带 name(projectsRuns.ts:161-168);陷阱:readRun 用 ResearchRunSchema.safeParse(fsStore.ts:274-279),zod 默认 strip 未知键——漏改 schema 则 name 静默剥掉,全绿但 UI 永显 requestId(仓内有 costEstimate 被strip前科)。路径乙(join request 文件):launchRun 先落 running、saveRequest 在 runOnProject 内才写,启动瞬间有 join 不上窗口。**Kill 判据:PRD 未钉死「name 存哪、从哪读、schema 与写入点同步改」即开工 → kill;须附往返单测。**

### K3 存量项目改名——「自定义」对旧项目可能是空话
用户痛点指向已存在项目;提案无任何重命名端点/入口,新名称只对新建生效。saveMeta patch-merge 天然支持改名,成本极低;「不批量迁移历史数据」与「不给单条改名入口」是两回事。**需用户输入:「存量项目要能改名吗」。Kill 判据:用户要、提案不给(且未显式同意分批)→ kill 或扩界。**

### K4 rerun/followup 名称继承——已被代码机制默认裁决一半,不是真开放问题
rerun 是 spread 复制(projectsRuns.ts:314-320)→ name 自动继承、无后缀;followup 构造全新对象(374-382)→ 100% 回退 requestId。什么都不做 =「rerun 同名复制、followup 无名」,与树内靠名称区分冲突。**Kill 判据:做树内任务展示则 rerun/followup 命名必须在 PRD 裁决,不允许开放。**

### K5 树内「+任务」入口 × 单 active-run 守卫——禁用态无数据支撑
ProjectMeta 不含 run 状态;现侧栏按钮仅当前项目可用 detail.activeRun 禁用(Sidebar.tsx:88)。跨项目入口要么提交时吃 409(体验回退),要么扩列表端点(绑回 K1)。归档项目上任务入口语义未定义。**Kill 判据:树内新建入口进本批而无禁用态数据方案 → 砍入口不砍提案。**

## What I Couldn't Assess
433/typecheck 未运行验证;DESIGN.md 未读;截图不可读——「名称可自定义」是否隐含事后改名无法判断(K3 需问用户);类型常驻对空数据启动页影响未深入。

## Verdict: **GO(带两个 PRD 级阻塞项)**
K1:PRD 明确树内任务数据来源三选一;K2:PRD 钉死 name 存储/读回路径并附往返单测;K3:问用户存量改名。K4/K5 把已定事实写进 PRD 关闭伪开放问题。四件事完成前不写一行 UI 代码。
