# 提案:报告丰满度三重改进(draft 要求 / writer 素材 / 润色环节)

> 来源:2026-10-04 用户诊断"deep-research 输出报告丰满程度不如 flow-center 商圈研究、Kimi、Gemini",确认三条改进打包实施。

## 问题诊断(已核实,证据见对话)

deep-research 报告不丰满不是"没用 LLM 润色"单一原因,而是三层都薄:

1. **写作要求薄**:draft prompt(STAGE_PROMPTS.draft, src/adapters/live.ts)只有一句"逐节按 outline.sections 撰写、只陈述有证据支持的内容",无长度要求、无每节深度下限、无表格/执行摘要/建议章等结构强制、无自检清单。对照 flow-center 商圈 write 节点有 8 条硬指标(三段式不得省略、≥3 画像×7 维表格禁止段落替代、策略必须可量化、每章证据密度、13 行表每行≥30 字、格式自检清单)+ 326 行 report-template.md 注入。另 outline 阶段每节仅 2-4 条 bullets,写作计划本身薄;模块 reportTemplate 只有 sections 标题列表,无逐节内容指导。
2. **写作素材薄**:draft 阶段输入仅 `{goal, scope, findings, claims, reportTemplate, outline}`(runResearch.ts draft 段),findings 是每问题一句话 summary,claims 是 ≤80 字引句的主张;**快照正文从不进 writer 上下文**。Kimi/Gemini 写手通读原文成文,deep-research 写手只能从二手摘要扩写,丰满度天花板低。
3. **成文机会只有一次**:draft 是唯一产出正文的环节;review 回环只允许 regather/rephrase/disclose,rephrase 输入仍是同样的蒸馏摘要;formal 阶段 prompt 明确"只允许重组草稿已有内容,严禁新增任何事实"。无扩写/润色 pass。draft 解析失败时 safeParse 兜底为"证据清单摘要"(实例:research-data/projects/p-muaman1a-ypfqtl/reports/v1/report.md 开头明写"草稿生成失败")。

## 三条改进(用户已拍板 1+2+3 全做)

### 改进 1:draft prompt 丰满度硬要求
对齐 flow-center 做法,draft 阶段 prompt 增加:每节最低篇幅/深度要求、表格化数据矩阵、执行摘要、结尾建议章、输出前自检要求。不改"只陈述有证据支持的内容、推断须标注"的克制基调(可信度是本项目核心卖点,丰满度不能靠编造换)。

### 改进 2:writer 输入 diet 升级
把采证快照正文(切块/截断)随 findings/claims 一并喂给 draft 阶段,让写手看到原始素材而非只有蒸馏摘要。需设计:快照选择(按 claim 关联/按问题分组)、切块与截断策略、上下文预算控制。

### 改进 3:增加扩写/润色 pass
定稿前有丰富正文的机会;同时考虑放宽 rephrase 修复路径的输入(与改进 2 的素材打通)。注意与现有"formal 只重组不新增事实"原则的边界:润色/扩写必须仍受证据约束,不得引入无证据的新事实(即"表达方式丰富"而非"内容无中生有")。

## 硬约束(来自项目既定原则,不可被本流程推翻)

- **可信度工程优先**:只陈述有证据支持的内容、推断须标注、宁可披露不可编造——这是 WHITEPAPER/PLAN-COMPARE 记录的核心定位,丰满度提升不得以放松证据约束为代价。
- **真实性核查四步**(引用核查/语义蕴涵/数值复算/多源交叉)与 ABC 信源分级是发布门禁,任何润色 pass 的产出仍须过同一门禁。
- **编排器唯一入口**:改动落在 runResearch.ts 六阶段状态机与 adapters 边界内,不引入新编排架构。
- **模型链路不变**:MiniMax 主 + MIMO 备、pi SDK 进程内接入,不换模型不换供应商。
- **草稿/正式两阶段原则不变**:流水线产出=草稿,确认后才生成正式报告(pptx/html/pdf)。

## 开放问题(留给 GRILL)

- 快照正文的切块/截断预算(每问题多少 token、总量封顶)
- 扩写/润色 pass 放在 review 回环内还是 draft 之后新增 stage(StageName 是否扩枚举,涉及 contracts)
- draft prompt 硬指标的具体尺度(每节字数下限的合理值)
- 润色 pass 的输入是否含快照正文、其产出如何再过发布门禁

## 不做

- 不引入 flow-center 式声明式 DAG 工作流(架构路线不变)
- 不换写作模型、不接新供应商
- 不放宽"formal 不新增事实"(改进 3 的润色发生在 formal 之前的草稿阶段)
