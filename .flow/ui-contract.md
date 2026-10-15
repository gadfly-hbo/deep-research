# P2-3 UI-GATE 契约(确认门翻转)

> 产出模式:降级内联(子代理配额不可靠,主代理产出;披露)。本批 UI 面 = 计划页从"预览向导"翻转为"run 确认流"(新交互面)+ 全局状态呈现扩展。

## Surfaces

| # | 表面 | 位置 | 变更 |
|---|---|---|---|
| S1 | 研究发起表单 | PlanView(原向导第一步) | 保留(目标/范围/预算/追问基准/附件/复用资产);提交=免 plan 起跑;二三步预览 UI 退役 |
| S2 | **计划确认卡片(新)** | PlanView awaiting 分支 | 待确认状态徽 + 可编辑问题清单(增删/改文字,≥1 条非空)+ 基准摘要(增量追问时)+「确认计划,开始框架」/「放弃」|
| S3 | **框架确认卡片(新)** | PlanView awaiting 分支(kind=outline) | 可编辑标题/副标题/章节(标题/目的/要点,≥1 章节标题非空)+「确认框架,开始研究」/「返回计划」(回上一道门?否——返回=仅重编辑,门不回退,PRD 简化:仅放弃) |
| S4 | 全局状态呈现 | STATUS/STATUS_DOT/GatherView/Inspector/Sidebar/StatusBar 五处 | 新状态"待确认/wait 琥珀";awaiting run 不再渲染为"进行中零进度" |
| S5 | 项目根路由 | StageRoute | awaiting 时项目根重定向 /plan |

## Click paths

- C1 新研究:计划页表单→「开始研究」→ run 起(pending)→ S2 出现(轮询)→ 编辑问题→「确认计划」→ S3(框架生成中 busy→卡片)→ 编辑→「确认框架,开始研究」→ 跳采证(gather 正常呈现)。
- C2 追问:?followup 预填表单(基准锁定)→ 同 C1,S2 含基准摘要(incremental.summary)。
- C3 放弃:S2/S3「放弃」→ run=cancelled(既有语义)→ 回表单。
- C4 中断恢复:确认页关闭浏览器→重开(或 serve 重启)→ S2/S3 仍在(durable)→ 确认继续。
- 失败态:gate GET 404(门已处理/不存在)→ 回退运行列表+文案;confirm 409(并发已处理)→ 轮询收敛到最新状态;zod 400(编辑后空问题/空章节标题)→ 表单内联错误不提交。

## Affordances

问题/章节编辑沿用向导既有控件(fld/input/textarea);按钮禁用条件:确认计划=问题 ≥1 且非空;确认框架=标题+每章节标题非空;busy 期间全禁用。

## Terminology

新文案仅:"待确认"(状态)、「确认计划,开始框架」「确认框架,开始研究」「放弃」;沿用:问题 N/章节 N/基准摘要既有措辞。

## Negative cases

- 向导预览 UI(生成计划/生成报告框架按钮)不得残留;plan-preview/outline-preview 无 UI 调用。
- awaiting 不得呈现为"进行中/零进度"(GatherView 等五处按 status 分支)。
- 门不得回退(确认计划后无"返回上一道门";仅放弃)。
- awaiting 下 instruct 入口隐藏(409 语义,不给假入口)。

## Trace links

S2/S3 ↔ PRD D1/D3(门/confirm);S4/S5 ↔ D4/R1-7;C4 ↔ D1 durable;失败态 ↔ D3 端点语义。

## Visual artifact

- 格式:单页静态 HTML,`<link>` 复用仓库真实 `../../ui/styles.css`;无 JS。
- 文件:`.flow/ui/p2-3-confirm-gates.html`
- 覆盖:S2(含增量基准摘要变体)、S3、C1 busy 框架生成中、C3 放弃前、失败态 404/409/400、S4 状态徽新值、S1 表单(保留面)。
- 数据保真:合成(字段形状=PRD gate GET 契约);披露:数值合成。

## 结论

PASS(契约与原型 1:1;无 PRD 外发明)——待用户批准。recheck:每分区对应上表,无多余。
