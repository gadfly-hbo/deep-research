# DESIGN.md — 独立深度研究工作台

本项目视觉基线:**Xanthil 桌面工作台风格**(暖灰 + 青),源自
`~/JuanerAI/docs/planning/2026-09-18/clickable-ui-contract-v1.1/dist/professional/`(professional 变体:全屏、无模拟标题栏)。
按全局规则,本文件优先于 `~/.zcode/design/DESIGN.md`(Prism);二者冲突时以本文件为准。

## 色彩 token(实现于 `ui/styles.css` :root)

| 用途 | 值 |
|---|---|
| 背景 / 表面 / 表面2 | `#f7f6f3` / `#ffffff` / `#f0efec` |
| 边框 / 强边框 | `#e2e0db` / `#cfcdc6` |
| 文本 / 次 / 弱 | `#1f1e1b` / `#5b5952` / `#8a877e` |
| 主色(accent)/ 深 / 浅底 | `#0f766e` / `#0b5c55` / `#e6f4f2` |
| 成功 / 警示 / 失败 / 排队 | `#166534` / `#92400e` / `#b91c1c` / `#6d5bd0`(各配 -soft 浅底与 -line 描边) |

圆角 `10px`(卡)/ `6px`(控件);字体系统栈(`-apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", …`),等宽 `SF Mono/ui-monospace`;正文 13px。

## 布局

- 全屏三栏:左 248px 侧栏(项目树/最近运行/边界声明)+ 中央主工作区 + 右 300px Inspector;底部状态栏。
- 中央顶部粘性 stagebar:六阶段(计划→采证→分析→草稿→评审→发布),done/active/locked 三态;路由 `/project/:id/:stage?` 同步。
- 中央视图内容限宽 860px 居中;报告纸张限宽 760px。
- 1420px 以下收窄侧栏/Inspector;1100px 以下隐藏 Inspector;900px 以下纵向堆叠。

## 组件约定(自定义控件,不引入组件库)

- 按钮 `.btn / .btn-primary / .btn-ghost / .btn-danger / .btn-sm`;表单 `.fld > .fld-label + input/textarea/select`。
- 状态一律「圆点 + 文字」或带描边 chip:`.chip-ok/-run/-wait/-fail/-insuf/-agg/-local/-fork`(状态绝不只用颜色)。
- 卡片 `.card > .card-h`;行式列表 `.filelist > .file`;表格 `.tbl`;空状态 `.empty`(虚线框)。
- 警示:`.trust-banner`(青,边界声明)/ `.warn-card`(琥珀,有限交付,`<details>` 折叠)/ `.err-card`(红,失败)。
- 主张卡 `.hypo`(编号 + 结论 + 状态 + 证据 `.evi-link`);证据引句 `.quote-block`;快照原文 `.snap-text`(等宽)。
- 命令面板 ⌘K、Toast 底部胶囊、Inspector 四页签(上下文/主张与证据/运行记录/信源与核查)。

## 原则

- 证据可核查:结论逐条绑定原文快照;有限交付必须披露限制,不编造完整答案。
- 打印仅输出报告正文(`@media print` 隐藏全部外壳)。
- 状态可见:运行中用不确定进度条 + 状态栏用量(搜索/抓取/成本)。
