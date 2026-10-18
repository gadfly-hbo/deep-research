# U1 交接卡:侧边栏层级迭代——类型→项目(自定义名称)→任务(2026-10-18)

> 前序:用户 UI-GATE 确认(2026-10-18,契约按推荐全采纳)。规格:.flow/{proposal,prd,ui-contract}.md;评审:review-findings{,-r1}.md(R1 FAIL→修复→R2 PASS)。

## 本批交付

- **三级树侧边栏**:类型(品牌/行业研究,常驻+空态+节头「＋」深链 `?module=`)→ 项目(name??goal 截断,悬停「＋任务」守卫禁用)→ 任务(name??requestId 等宽回退,状态点+状态词,mtime 倒序);版本子树与「最近运行」区移除(发布页 ?v= 不动)。
- **命名链路**:`DisplayNameSchema`(trim 1-60)进 ResearchRequest/ResearchRun/ProjectMeta;编排器新鲜构造透传(G1-1,runNaming.test 三测);launch 预落/失败记录带名;rerun「·重跑」/followup「·追问」自动后缀(无名回退 requestId 前 8 位)。
- **改名**:项目 PATCH `:id {name|null}`;任务 PATCH `:id/runs/:rid/name`(终态+awaiting 可改,running 409「运行进行中,处理后方可改名」;audit run-renamed);空=清除回退。
- **树数据流(D1/G1-2/G1-3)**:GET /api/projects 附轻量 runs 摘要(id/requestId/name/status/stage/updatedAt=mtime);ProjectsProvider 档位轮询 30s↔2.5s(hasActive 自举)+409 boostAndReload。
- **表单**:创建项目「项目名称(可选)」+模块预选;发起任务「任务名称(可选)」(followup 不显示,服务端自动命名)。

## 验证状态

- 441/441(71 文件,433 既有+8 新:runNaming 3+namingRoutes 5)+ typecheck + vite build 干净;两拍一致。
- 评审 R1 FAIL(1 blocking:非当前行菜单定位锚)→ 修复(sb-row 常态锚)→ R2 PASS;non-blocking 记录不动。

## 遗留与后续批候选(评审记录)

1. **S-2(建议下批首选)**:当前项目任务行全部 aria-current/高亮——应仅聚焦 run 一行(running 优先否则 mtime 第一)。
2. 测试补强(S-8):gate confirm CAS 后 name 存活端点断言;audit renamed/run-renamed 断言;followup 无名回退断言。
3. 交互细节:S-3 右键菜单通道;S-5 Esc 焦点还原;S-6 禁用形态改菜单项;S-7 boost 在 hasActive=false 时的独立提频;R2-1 展开态菜单落点收紧。
4. 术语统一:「新建研究运行」页面级残留 6 处(Palette/PublishView/PlanView×3/GatherView)与侧栏「新建任务」不一致——后续批统一。
5. 死代码清理批:T-1 归档/非归档 sb-actions 合并;T-3(.sb-run 规则/RowMenu disabled 分支/BOOST_MS);R2-2(.sb-item position 冗余)。
6. INFO 备案:S-9 awaiting 改名与 confirm CAS 竞态窗口(PRD 未要求锁);S-10 项目改名使行浮顶(updatedAt 语义)。

## 下一批前置

- 工作区仅剩 research-data 运行数据(用户既有);无代码 WIP。
- UI 契约与原型留档:.flow/ui-contract.md + .flow/ui/u1-sidebar-tree.html(下批按惯例归档);浏览器实测走查留用户复查判据(契约 §9)。
