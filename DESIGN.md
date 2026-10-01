# DESIGN.md — 独立深度研究工作台

本项目视觉基线:**JuanerAI Xanthil 橘accent 桌面工作台**(全局规范 `~/.zcode/design/DESIGN.md` · 2026-09-28 契约版,2026-09-29 起生效;权威链 `~/JuanerAI/docs/planning/2026-09-28/xanthil-case-assistant-ui-contract-v1.0.md` + 同名 clickable 原型 dist)。
取代旧「暖灰 + 青(teal accent)」基线(2026-09-18/09-23 版)。按全局规则,本文件优先于全局规范;本文件与 09-28 契约保持一致,仅追加本产品的适配决策(见下)。

## 色彩 token(实现于 `ui/styles.css` :root)

- 暖灰三级表面:页面底 `#eceae5` / 壳 `#f7f6f3` / 卡片 `#ffffff` / 侧栏·次级 `#f4f3ef` / 卡内分区 `#f7f6f2`;边框 `#e5e2dc` / 强 `#d8d3cb`;文本 `#1d2027` / `#6f7480` / `#8a8076`。
- 橘 accent `#e8643a`(strong `#bf4927` / soft `#fff1e8` / line `#e8c1b4`)只用于:主按钮、当前阶段、选中态、焦点环、证据引用 chip、边界徽。藏青 navy `#263442`(soft `#edf3f5` / ink `#496271`)为次级强调(toast、上下文图标),不做主操作。
- 语义色成对(深字 + `-soft` 底 + `-line` 描边):ok `#176247` / warn `#855211` / fail `#952f2f` / queue `#6d5bd0`(小字用加深 `queue-ink #5b48c0`);状态点 `dot-amber/green/gray/red` 四色。
- 圆角 14px(卡)/ 8px(控件)/ pill;字体 Inter 优先系统栈,等宽 SF Mono;正文 13px,报告正文行高 1.85;数字一律 `tabular-nums`。
- 两级阴影:平面卡片轻阴影 `0 3px 12px rgba(40,36,30,.04)`;浮层(⌘K 面板、草案卡)重阴影 `0 18px 48px rgba(35,35,30,.12)`;焦点环 3px `rgba(232,100,58,.28)` + 2px offset。

## 布局

- 顶部 `topbar` 64px:JuanerAI 品牌区(logo 裁切块 36px + 品牌名/slogan「持续做出更好的决策」+ 分隔竖线 + 产品名)+ 右端边界徽。品牌图 `ui/assets/juanerai-logo-slogan.png`,SHA-256 `61bdb1196e9f1bbaef64c973c4108d12294246de6e941fa00821a2769e3e0e21`(契约冻结值,不得替换)。
- 全屏三栏:左 248px 侧栏(⌘K 搜索 / 项目树 / 最近运行 / 设置 + 底部边界声明)+ 中央主工作区 + 右 300px Inspector;底部状态栏常驻(服务位置 / 项目 / 阶段 / 运行状态 / 用量 / 边界声明)。
- 中央顶部粘性 stagebar:六阶段(计划→采证→分析→草稿→评审→发布),done=ok 实心编号圆点 / active=accent 描边胶囊 / locked=灰;与路由 `/project/:id/:stage?` 同步,可点可回退。
- 中央视图内容限宽 860px 居中;报告纸张限宽 760px。
- ≤1250px 收窄侧栏/Inspector;≤1100px 隐藏 Inspector(⌘I 可开);≤900px 纵向堆叠。

## 组件约定(自定义控件,不引入组件库)

- 按钮 `.btn / -primary / -ghost / -danger / -sm`;表单 `.fld > .fld-label + 控件`(label 在上,不用 placeholder 代替标签)。
- 状态绝不只用颜色:chip(`.chip-ok/-run/-wait/-fail/-insuf/-agg/-local/-fork`)+ 状态点 `.dot-*` 均带文字双通道;卡片级状态结论用 `.state-badge`(amber 待审 / green 已采纳 / red 未通过);同一状态全站只用一个词。
- **待采纳草案卡 `.draft-card`**(草稿阶段):eyebrow「PENDING DRAFT · 待人审」+ 标题 + 来源运行行(主张/证据/快照计数)+ 右上 state-badge;动作区次级(打印)在左、主操作(人审通过,生成正式报告)在右;正式版生成后切 adopted 绿色变体(✓ 图标 + 「正式版已生成 · vN」)。草稿无正式效力,人审不可绕过。
- 警示三件套:`.trust-banner`(accent,边界承诺)/ `.warn-card`(琥珀,有限交付,`<details>` 折叠)/ `.err-card`(红,失败并说明未发生什么、如何恢复)。
- 主张卡 `.hypo`(编号 + 结论 + 状态 + 证据 `.evi-link` accent chip,点击回溯);证据引句 `.quote-block`;快照原文 `.snap-text`(等宽)。
- 命令面板 ⌘K(浮层重阴影)、Toast 底部 navy 胶囊(约 3 秒自动消失)、Inspector 四页签(上下文/主张与证据/运行记录/信源与核查)。

## 本产品适配决策(与契约的差异,均如实披露)

- topbar 操作区不放通知铃与 avatar:本产品为单机单用户工具,无通知与账户体系,不设假入口;仅保留边界徽。
- 边界徽文案「本机服务 · 127.0.0.1」:服务仅在本机运行、不连接 JuanerAI;采证与模型调用经「设置」中配置的外部 API 发起(hover title 完整说明,外发内容在运行记录可核查)。不使用「不联网」类不实文案。

## 原则

- 证据可核查:结论逐条绑定原文快照;有限交付必须披露限制,不编造完整答案(fail closed)。
- 打印仅输出报告正文(`@media print` 隐藏全部外壳与草案卡)。
- 状态可见:运行中用不确定进度条 + 状态栏用量(搜索/抓取/成本);取消与恢复入口带后果说明。
