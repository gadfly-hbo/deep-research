# P2-4 UI-GATE 契约(调查流视图)

> 产出模式:降级内联(主代理产出)。UI 面 = GatherView 从"问题进度"演化为"调查时间线"(决策③),新增 investigation 数据呈现;其余表面不变。

## Surfaces

| # | 表面 | 变更 |
|---|---|---|
| S1 | 采证页主区(新) | 问题分组头(状态徽+verdict 摘要)+**时间线卡片流**(query/fetch/read/verdict 卡,按 seq);running 增量追加,完成态全量回看 |
| S2 | 问题分组头 | 问题文本+状态徽(answered/partially/unanswered/skipped/进行中)+agent note(终局摘要,hover/折叠) |
| S3 | 时间线卡片三型 | query 卡(搜索词)、fetch 卡(域名+页面标题+sid,失败含错误)、read 卡(sid+偏移);verdict=分组头内徽非卡片 |
| S4 | 用量条/取消/instruct 表单 | 保留现状(实时经节流 persistRun 活) |
| S5 | 空态 | "准备采证材料中(附件/复用注入)"(首问前)vs"尚无调查事件"(agent 未动) |

## Click paths

- C1 发起研究→确认双门(P2-3)→采证页:首问 agent 启动→时间线逐事件追加(2.5s 轮询 since 增量)→问收束(分组头变状态徽+note)→下一问;全部完成→分析阶段(现状跳转)。
- C2 追问/增量:基准快照在任务卡内"勿重抓"——时间线只含新抓取。
- C3 instruct:表单提交(现状交互)→skip 下一问生效/add 追加/refine 影响下一问任务卡;进行中问题的"跳过"按钮=串行语义现状(作用于当前问启动前…实际为下一未启动问,文案沿用现状)。
- 失败态:单问 agent failed→分组头"未答"徽+limitation 披露(报告限制章);investigation 端点 404(无事件)→空态;增量窗口溢出(>500)→自动 since 重拉全量。

## Affordances

卡片流为只读时间线(无点击展开 v1——sid 可与右侧快照面板联动留 P2-5);键盘/焦点沿页面滚动。

## Terminology

新文案:"调查记录"(主区标题)、"已答/部分回答/未答/已跳过"(沿用状态徽)、verdict note 原文展示;不引入"思考/推理"类字样。

## Negative cases

- 时间线不得混入非 agent 事件(附件/复用注入不出现);
- awaiting-confirmation(P2-3)不进时间线;
- 不出现逐问抓取计数护栏类 UI(配额只在全局用量条);
- 模型内部轮次(assistant 文本/工具参数原文)不展示——只展示工具语义事件。

## Trace links

S1/S3 ↔ PRD D4(事件形状/增量);S2 ↔ D3(q.status 合成);S4 ↔ R1-6(节流 persistRun);S5 ↔ R1-7;C3 ↔ D2(指令语义零漂移)。

## Visual artifact

- 单页静态 HTML,`<link>` 真实 `../../ui/styles.css`;文件 `.flow/ui/p2-4-investigation-stream.html`。
- 覆盖:S1 running 态(两问:一进行中一已收束)、S2 各状态徽、S3 三卡型+失败 fetch、S4 用量条共存、S5 两空态、C1 完成回看。
- 数据保真:合成(事件字段=PRD D4 契约);披露:数值合成。

## 结论

PASS(契约与原型 1:1)——待用户批准。recheck:每分区对应上表。
