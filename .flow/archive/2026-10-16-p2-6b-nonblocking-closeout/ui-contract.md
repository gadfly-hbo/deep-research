# P2-6b 加注文案窗口限定 UI-GATE 契约(轻量)

> 产出模式:同 p2-6-budget-topup 轻量形态(契约+单页原型)。UI 面 = GatherView「运行中加注」行内表单的**三处用户可见字符串**(表单 label / 成功 toast / budget 端点 200 `note`)——按 PRD GRILL R1-1「边界标记版(A)」窗口限定重开承诺。无新表面、无新交互、无行为变更。措辞经本 GATE 用户批准(PRD D2 钉的批准点)。

## Surfaces

| # | 表面 | 变更 vs 冻结 |
|---|---|---|
| S1 | GatherView 运行卡「运行中加注」行内表单区(`ui/views/GatherView.tsx:312-346`)+ budget 端点 200 `note`(`src/server/routes/projectsRuns.ts:493`) | **仅三处字符串**换为 R1-1 措辞:① 表单 label(现 `GatherView.tsx:313`);② 成功 toast(现 `GatherView.tsx:242`);③ 200 `note`(现 `projectsRuns.ts:493`)。其余全部冻结:行内三个数字 input(placeholder「+搜索次数」「+抓取次数」「+墙钟(分钟)」)、「确认加注」按钮(`btn-sm`)、内联错误「增量须为正整数」、busy/全空禁用、running 态可见(awaiting/终态不渲染)——均沿用现状,零改动。 |

## Click paths(全部既有路径,仅 C1 成功分支的 toast 文本更新)

- C1 提交成功:填增量(至少一键>0)→「确认加注」→ POST `/api/projects/:id/runs/:runId/budget` → 200 → toast 新文本(见 Terminology T2)。
- C2 本地校验失败:非正整数 → 内联错误「增量须为正整数」,不提交 — **不变**。
- C3 服务端 400(增量不合法)→ 内联错误「增量须为正整数」 — **不变**。
- C4 服务端 409(无运行中 run / 账本未注册)→ toast 错误原文 — **不变**。

## Affordances

**不变**:三个数字 input + 确认按钮;禁用条件 = busy 或全空/全零;键盘/焦点与现状同;无弹层、无新页面。

## Terminology(逐字钉死;旧 → 新)

PRD GRILL R1-1(`.flow/prd.md:49`)原文:「统一以『发布门评估前』为单一时间边界;label 枚举三评估点(采证中每问开始/采证轮末/发布门评估前),toast/note 用『将在发布门评估前的评估点自动重开,其后加注只恢复润色/评审回环』句式」。

- **T1 表单 label**
  - 旧:「运行中加注(只增不减;加注后配额饿死的问题将自动重开,恢复/重启后加注不延续)」
  - 新:**「运行中加注(只增不减;配额饿死的问题将在采证中每问开始、采证轮末、发布门评估前的评估点自动重开,其后加注只恢复润色/评审回环;恢复/重启后加注不延续)」**
  - 中段=R1-1 三评估点枚举嵌入 toast 句式;首尾两子句(只增不减 / 恢复重启不延续)是既有事实陈述,不在本次变更面,原样保留。
- **T2 成功 toast**
  - 旧:「已加注,配额饿死的问题将自动重开」
  - 新:**「已加注,配额饿死的问题将在发布门评估前的评估点自动重开,其后加注只恢复润色/评审回环」**
- **T3 budget 端点 200 `note`**
  - 旧:「已加注,配额饿死的问题将自动重开;恢复/重启后加注不延续」
  - 新:**「已加注,配额饿死的问题将在发布门评估前的评估点自动重开,其后加注只恢复润色/评审回环;恢复/重启后加注不延续」**

沿用冻结术语:「加注」「确认加注」「配额饿死」;不自称 steer/预算调整。`src/core/stages.ts:12` 同句内部注释同步是 D2 的实现面顺带项,**非 UI 范围**,不在本契约钉字。

## Negative cases

- 无新状态、无新交互、无新表面——本 flow 只换三处字符串。
- awaiting/终态卡片不渲染加注入口 — 不变。
- 文案不得窄化为「仅采证阶段内」类表述(PRD D2 明令,发布门评估前一点在 gather 收束后、analyze 前);不得保留任何无条件重开承诺。
- 弹层/新页面/上限值展示/前端校验/运行中降档入口 — 沿用 p2-6 契约负例,均不做。

## Trace links

- T1/T2/T3 ↔ PRD D2(N1 文案窗口限定)+ GRILL R1-1(边界标记版 A);批准点 = PRD D2「措辞经 UI-GATE 用户批准」。
- 「发布门评估前的评估点自动重开」↔ locked 测试 `budgetTopup.test.ts:224`(采证后加注→发布门评估前重开补采,即 `runResearch.ts:689` 的发布门前评估窗)。
- 「其后加注只恢复润色/评审回环」↔ locked 测试 `budgetTopup.test.ts:275`(analyze 窗加注→q2 不重开,复位只恢复回环)。
- S1 冻结面 ↔ proposal.md N1(「改 GatherView 两处字符串+budget 端点 200 note 为窗口限定表述,措辞进 UI-GATE 用户批准」)。

## Visual artifact

`.flow/ui/p2-6b-copy-windowing.html`——单页静态,链接真实 `../../ui/styles.css`(同归档 p2-6-budget-topup.html 的引用方式;其 gate 骨架样式中未定义的 `--line-strong` 换为真实 token `--border-strong`)。内容:S1 四态——正常态(新 label T1)、内联错误态(错误文案不变)、禁用态(全空)、成功 toast(T2;T3 作 API 字段附注原样展示,非新增 UI 态)。运行卡用量/进度数值为合成数据,页内披露。

## 结论

PASS——待用户批准措辞(R1-1 钉的批准点)。recheck:Terminology T1/T2/T3 三条新字符串与原型及后续实现逐字一致,四态无一处引入新交互或新状态。
