# U1 PRD:侧边栏层级迭代——类型 → 项目(自定义名称)→ 任务(自定义名称)

> 规格源:`.flow/proposal.md`(用户 2026-10-18 文字规格);红队 `.flow/red-team.md`(GO,附 K1-K5)。无 issue tracker,降级本文件。基线 main @ `1ac4b98`。

## Problem Statement

用户反馈侧边栏层级逻辑错误:现为「类型节头(仅非空)→ 项目行(goal 文本)→ 版本子树 + 当前项目最近运行区(requestId)」。正确逻辑应为:**类型(品牌/行业研究)→ 类型下可创建项目 → 项目下可创建任务(不用版本)**,且项目名称与任务名称可自定义。核心诉求:导航树按「类型-项目-任务」三级组织,名称人话化,版本不占导航层。

## Solution

侧边栏改为三级树:类型一级节点常驻(品牌研究/行业研究,含空态,节点上提供「+」创建该类型项目);项目为二级(显示自定义名称,存量回退 goal 截断,支持改名);任务(run)为三级(显示自定义名称,存量/未命名回退 requestId,支持改名),按时间倒序。移除版本子树与「最近运行」区(发布页版本入口自足保留)。API 加法:项目创建/改名带 `name`;`ResearchRequest`/`ResearchRun` 增可选 `name`(schema 与写入点同步,往返单测钉死 strip 陷阱);列表端点附带轻量 runs 摘要供全树渲染与新建任务禁用态;rerun/followup 自动命名后缀。

## User Stories

1. 作为研究者,我想在侧边栏按「品牌/行业研究」两类浏览全部项目,所以不用依赖记忆或搜索定位。
2. 作为研究者,我想创建项目时给它起名(如「安克品牌研究」),所以侧边栏显示人话而不是一长句研究目标。
3. 作为研究者,我想在每个项目下直接看到它的历次任务(运行)及各自状态点,所以不用点进项目才知道跑了什么。
4. 作为研究者,我想发起任务时给它起名(如「Q4 渠道摸底」),所以多次运行可区分,而不是 req-xxxx 乱码。
5. 作为研究者,我想给存量项目/任务改名,所以旧数据也能进入新层级语义(推荐项,UI-GATE 确认)。
6. 作为研究者,我想在类型节点和项目行上直接「+」新建,所以创建路径贴合树形心智。
7. 作为研究者,我想任务运行中时树内状态点/禁用态如实反映(单 active-run 守卫),所以不会发起后被 409 弹回。
8. 作为维护者,我想名称只是展示层不改 run 执行/恢复/门禁语义,所以既有 433 测试不动即绿。

## Implementation Decisions

- **D1(K1,树数据来源)= 扩列表端点附 runs 摘要**:`GET /api/projects` 响应每项目附 `runs: Array<{id, requestId, name?, status, stage, createdAt}>`(轻量摘要,无 checkpoints/bundle/usage 细节;P0-2 轻载惯例不破——每条 ~百字节)。前端树由该端点单次请求渲染;存在 running/awaiting 任务时列表轮询提频(如 2.5s,复用 detail 轮询节奏),否则低频(30s)或手动。否决 (b) N+1 轮询(流量×M)与 (c) 仅当前项目(树退化,不满足用户规格)。
- **D2(K2,名称数据流)= 路径甲(name 冗余进 run 记录)**:`ResearchRequestSchema` 与 `ResearchRunSchema` 均增可选 `name`(zod string,trim 1-60,可空);`launchRun` 落 running 记录时带 `request.name`(projectsRuns.ts:161-168 写入点);展示处处 `run.name ?? run.requestId`。**往返单测为验收项**:构造含 name 的 run.json 经 `listRuns()` 读回断言 name 存活(钉死 readRun zod strip 陷阱,fsStore.ts:274-279)。否决路径乙(join 启动窗口 + 每处渲染都要 join)。
- **D3(项目名称)**:`POST /api/projects` 增可选 `name`;`createProject` 写入 ProjectMeta(zod/UI types 同步);`ProjectMeta` 已是 patch-merge,新增 `PATCH /api/projects/:id {name?}` 改名端点(saveMeta + audit("renamed"));侧边栏/项目列表显示 `name ?? goal 截断`。
- **D4(任务改名,推荐采纳-K3)**:`PATCH /api/projects/:id/runs/:rid/name {name}` → saveRun 增量更新该 run 记录的 name(append 语义不变——saveRun 已被恢复/门/加注场景复用);UI 入口在树内任务行(右键/悬停菜单)与运行页。**该两项改名能力为推荐默认,随 UI-GATE 一并请用户确认**;若用户裁定后置,本批仅留创建时命名+回退显示,端点撤出。
- **D5(K4,rerun/followup 命名)= 自动后缀**:rerun 继承 `original.name` 并追加「·重跑」(多次重跑为同名后缀,树内仍可由时间/状态区分);followup 命名为「{基准 name 或 requestId 前 8 位}·追问」。不加输入框(发起路径零改动)。
- **D6(K5,树内新建入口与守卫)**:类型节点「+」→ 新建项目表单(预选该类型);项目行悬停「+」→ 该项目新建任务(导航 `/project/:id/plan?new=1` 现路径);**禁用态依据 D1 列表 runs 摘要**(该项目存在 running/awaiting 即禁用并 title 提示,与现有 409 守卫文案一致);归档项目不显示任务入口。
- **D7(侧边栏信息架构)**:类型常驻两节(空态显示「暂无项目,+ 新建」);移除版本子树;移除「最近运行」区(任务已进树;当前活动 run 的阶段/门提示保留在 StageBar/StatusBar 既有位置,侧栏底部「执行完成≠证据充分」note 不动);任务行点击语义维持现状(导航到该项目 gather 视图聚焦该 run——现状即"running 优先否则最新",本批不为历史 run 建独立路由,hover title 标注「查看该项目当前调查流」)。

## Testing Decisions

- 只测外部行为:API 层(创建带 name/改名/列表附带 runs 摘要/rerun·followup 后缀)走 server 集成测试先例;name 往返(zod strip 陷阱)单测;UI 以 typecheck + vite build 校验(仓内惯例,无 UI 单测框架)。
- 缝:auto 模式自批:①`startServer` + fetch 的 server 集成缝(server.test.ts 先例);②`FsProjectStore.listRuns/create/saveMeta` 存储缝(fsStore/server 测试先例);③`runResearch` 不动(名称不过编排器——launchRun 落盘层面处理,rerun/followup 在路由层)。
- 既有 433 测试零改动;新增测试预计:项目名(创建/改名/回退)、run 名(落盘往返/rerun 后缀/followup 命名/改名/回退)、列表 runs 摘要(形状+轻载)、(可选)空类型列表。

## Out of Scope

版本管理改造、per-run 独立路由/历史调查流切换、多选/拖拽/树搜索、「最近运行」区复活、侧边栏外页面改版、批量重命名/迁移脚本、project.json 之外的数据模型变更、CLI 名称参数(CLI 保持现状,后续按需)。

## Further Notes

- 红队 K1/K2 已闭合为 D1/D2(含验收级往返单测);K4/K5 伪开放问题已按代码事实裁决为 D5/D6;K3(存量改名)推荐采纳为 D3/D4 改名能力,**连同 UI 契约一起在 UI-GATE 请用户确认**。
- 兼容/回滚:全部可选字段+加法端点;回滚=revert,无数据迁移;存量无 name 走回退显示,不触发任何写。

---

## PRD Diff Gate(auto 模式自批附录)

相对 proposal.md 的增量(纯加法,无改动作何提案决策):
1. 新增 D1 树数据来源决策(红队 K1 门内条件:提案未覆盖,必须补)。
2. 新增 D2 名称数据流+往返单测(红队 K2 门内条件)。
3. 新增 D3/D4 改名端点(红队 K3:提案遗漏非排除;采纳为推荐默认,UI-GATE 确认——若用户否决则缩减,不改提案既有决策)。
4. 新增 D5 rerun/followup 自动后缀(红队 K4:关闭伪开放问题)。
5. 新增 D6 禁用态数据方案(红队 K5)。
6. 新增 D7 侧边栏信息架构细则(类型常驻/移除版本子树与最近运行区/任务行点击语义维持)——开放问题 1/2/4 的推荐落点,交 UI-GATE。

---

## GRILL 第 1 轮决议(author-blind 子代理 7 包全部采纳,主代理逐包核实)

1. **G1-1(P1,阻断级)name 透传进编排器新鲜构造**:`runResearch` 新鲜启动路径(`runResearch.ts:136-152`,rerun 与带 plan 免门直跑均走此路)从零构造 run 对象并在 ≤2s 节流落盘(`:250-254/266-270`)——launchRun 预落的 name 会被覆写。**修正:编排器 run 对象构造处一行透传 `request.name`**(request 本就入参,schema 加字段即在);PRD 缝③口径改为「name 经 request 透传,编排器仅构造时带上展示字段,不参与执行语义」。验收测试补:rerun 落盘含后缀名、带 plan 免门路径 name 存活。
2. **G1-2(P2)runs 摘要时间字段 = `updatedAt`(mtimeMs)**:`ResearchRun` 无 createdAt 且 requestId 时间前缀无 schema 保障;摘要端点层用 `statSync(run.json).mtimeMs`(followup `mtimeOf` 先例 `projectsRuns.ts:353-359`),零迁移覆盖存量;排序=mtime 倒序,仅摘要端点层做(不动 `listRuns` 字典序与 detail 聚焦语义)。已知次要行为:改名使任务浮顶一次(P5 限终态后,终态 run 无其他写盘,可接受并记录)。
3. **G1-3(P3)轮询档位裁定**:30s 常驻低频 + 任一项目存在 running/awaiting 时提至 2.5s(判据=上次响应的 runs 摘要,自举),恢复回落;动态 interval(ref 档位变更重建)。树内「+」409 兜底后:toast + 立即 `projects.reload()` 并临时提频。归 ProjectsProvider。
4. **G1-4(P4)项目 name 校验与清除语义**:与 run name 同规(trim 1-60,共用 zod 定义);`name: string | null`——null/空串=清除回退 goal 显示,超长 400;校验放路由层新 schema,不下沉 store(CLI 直调不受影响)。
5. **G1-5(P5)任务改名限终态 + awaiting-confirmation;running 409**:running 改名会被编排器内存旧值覆写(G1-1 同因),故 D4 状态约束=终态(published/limited/failed/cancelled)与 awaiting 可改(awaiting 的 confirm CAS 为 spread current,`projectsRuns.ts:611`,name 存活),running 返回 409(文案循守卫先例)。`saveRun` 增可选 audit 事件参数(默认 `"run-finished"` 逐位不变,改名传 `"run-renamed"`)。PATCH 响应返回更新后 run 摘要。
6. **G1-6(P6)rerun/followup 显式命名(点破 spread 陷阱)**:rerun 的 `{...original}` 会原样带出原名不加后缀——路由层显式 override:`original.name ? original.name + "·重跑" : requestId前8位 + "·重跑"`;followup 同构(`基准 name 或 requestId 前 8 位 + "·追问"`)。无名原型回退口径统一,零特判。
7. **G1-7(P7)入口与归档区裁定**:侧栏顶部条件按钮**保留**(双入口;`?new=1` 深链被三处依赖,零成本);归档折叠区**不展开任务子树、无「+」**,行点击仍进项目(caret 随版本子树一并消失);类型「+」预选模块走 query param(`?new=1&module=industry`,ProjectsView 默认 brand 处接参)。

## GRILL 第 2 轮(主代理自查,收敛)

逐项复查:G1-1 写入点唯一性与 awaiting CAS 链、G1-2 mtime 与改名浮顶的边界、G1-3 提频自举循环风险(档位切换不触发请求风暴——变更档位仅重建 interval)、G1-4/5 校验与 409 文案先例、G1-6 两路由 override 位置、G1-7 深链三处依赖核实。未发现新的 PRD 级开放问题;名称输入框位置/菜单形态/树视觉细节属 UI 契约范畴 → **GRILL 收敛(2 轮)**。
