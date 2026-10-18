# U1 Tasks:侧边栏层级迭代——类型→项目→任务

> 来源:`.flow/prd.md`(D1-D7 + G1-1~G1-7)+ `.flow/ui-contract.md`(S1-S10/CP1-15/N1-N12,用户已批准)。无 issue tracker,降级本文件。依赖:T1→T2→T3。

- [x] 1. T1 数据层:名称字段落盘/读回/编排器透传

> 勾选证据 T1:runNaming.test.ts 3/3 绿(往返 strip 钉死/新鲜路径透传/恢复 spread);全量 436/436(70 文件)。gates 路径覆盖口径勘误(评审 S-8①):T2 仅覆盖 awaiting 状态下改名落盘读回;**gate confirm CAS spread 后 name 存活未走端点验证**——结构上由 `{...current}` spread + schema 含 name 保障,列为后续批补测项。
- [x] 2. T2 API 层:创建/改名/自动后缀/列表 runs 摘要

> 勾选证据 T2:namingRoutes.test.ts 5/5 绿(创建/校验/双 PATCH 改名含 409/后缀含无名回退/摘要形状与 mtime 倒序);全量 441/441(71 文件)+ typecheck 干净。
- [x] 3. T3 UI 层:表单名称输入 + 三级树侧边栏 + 轮询/守卫/改名交互

> 勾选证据 T3:typecheck + vite build 干净(772ms/764ms);全量 441/441 绿。契约走查(代码级,非浏览器实测):CP-1~15 逐条对码落实——CP-1/12 模块预选(修复挂载态 deps)/CP-4 →←键盘/CP-5/6 守卫禁用 title/CP-7 409 兜底(修正匹配串为服务器实际文案「进行中或待确认」)+boost/CP-8 任务行 div role=button(修复嵌套 button 非法 HTML)+aria-current/CP-9-11 内联改名(空=清除/超长 400 阻断/Esc·blur 取消)/CP-13 归档无子树/CP-15 骨架+档位轮询;N1-N12 无违例(退役串侧栏零残留;页面级「新建研究运行」串在本批契约范围外,记录 handoff)。

---

## 1. T1 数据层:名称字段落盘/读回/编排器透传

### What to build

`ResearchRequest`/`ResearchRun` 增可选 `name`(共用 zod:trim 1-60,可缺省);`ProjectMeta`(src+ui types)增 `name?`;`runResearch` 新鲜构造 run 对象透传 `request.name`(G1-1 生死点);`launchRun` 预落 running 记录带 `name`(D2)。名称纯展示字段,不参与执行/恢复/门语义。

### Acceptance criteria

- [ ] 往返单测:`saveRun({...run, name})` → `listRuns()` 读回 name 存活(钉死 readRun zod strip 陷阱,K2)
- [ ] 编排器新鲜路径(带 plan 无 gates,同 rerun/免门路径)run 记录落盘含 name(G1-1)
- [ ] gates 路径(confirm CAS spread)name 存活
- [ ] 既有测试零改动全绿

### Blocked by

None - can start immediately

---

## 2. T2 API 层:创建/改名/自动后缀/列表 runs 摘要

### What to build

`POST /api/projects` 接受可选 name(路由层校验 trim,空=不设置,>60→400);`PATCH /api/projects/:id {name|null}` 项目改名(saveMeta+audit "renamed";null/空=清除);`PATCH :id/runs/:rid/name {name|null}` 任务改名(终态+awaiting 可改,running→409「运行进行中,处理后方可改名」;`saveRun` 增可选 audit 事件参数,改名传 "run-renamed";响返更新后摘要);rerun 显式后缀「·重跑」、followup「·追问」(G1-6,无名回退 requestId 前 8 位);`GET /api/projects` 每项目附 `runs` 轻量摘要 `{id,requestId,name?,status,stage,updatedAt=mtimeMs}` mtime 倒序(D1/G1-2)。

### Acceptance criteria

- [ ] 创建带 name / >60 400 / 空串=未命名
- [ ] 项目改名:设置/清除(null)/回退字段;audit 记 renamed
- [ ] 任务改名:终态 OK、awaiting OK、running 409 同文案;audit 记 run-renamed;响应为更新后 run
- [ ] rerun/followup 落盘 name 含后缀(无名原型回退 req 前 8 位)
- [ ] 列表 runs 摘要:形状(轻载,无 checkpoints/bundle)、mtime 倒序、覆盖存量项目
- [ ] 既有测试零改动全绿

### Blocked by

- T1(schema/字段)

---

## 3. T3 UI 层:表单名称输入 + 三级树侧边栏 + 交互

### What to build

按 UI 契约全量落地:ProjectsView 创建表单「项目名称」+ `?module=` 预选;PlanView 发起表单「任务名称」(数据流 WizardForm→StartRunParams→request body);Sidebar 重构——类型常驻节头+「＋」+空态(S3)、项目行(caret 任务子树/悬停「＋任务」守卫禁用/「⋯」重命名)(S4)、任务子树(状态点+name??requestId 等宽回退+状态词,mtime 倒序,⋯重命名 running 禁用)(S5)、归档区无子树保留重命名(S6)、内联改名控件 S9(Enter 保存/Esc/blur 取消/留空清除/n/60 计数/>60 内联 400)、toast S8(409 两类/成功)、首载骨架 S10、顶部按钮「＋新建任务」判据统一 D1(diff6)、移除版本子树与最近运行区(D7);`ui/state/projects.tsx` 列表类型扩展+档位轮询(30s↔2.5s,409 后 reload+提频)(G1-3);`api.ts` PATCH 助手;styles.css 新增 sb-actions/sb-menu/sb-rename/骨架样式(取 DESIGN.md token)。键盘/焦点/aria 循契约 §3。

### Acceptance criteria

- [ ] typecheck + vite build 干净;契约 CP-1~CP-15 逐条自查走查(记录于勾选证据)
- [ ] N1-N12 负向自查(无版本子树回归/归档无子树/running 禁改/守卫禁用同源)
- [ ] 退役串零残留(「新建研究运行」「最近运行」节头等,§4 退役清单)
- [ ] 既有测试零改动全绿(UI 无既有测试,typecheck/build 即门)

### Blocked by

- T2(端点与摘要)
