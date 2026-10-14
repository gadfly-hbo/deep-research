# PRD: 报告丰满度三重改进(draft 硬要求 + writer 素材 + 润色 pass)

> 提案源:`.flow/proposal.md`(2026-10-04);红队:`.flow/red-team.md`(verdict: go)。
> 无 issue tracker(docs/agents/issue-tracker.md 不存在),落盘本文件。

## Problem Statement

用户视角:工作台产出的研究报告在丰满度上明显不如 flow-center 商圈研究工作流、Kimi 与 Gemini 的深研报告——章节单薄、缺少数据矩阵表格、没有执行摘要与建议章,个别 run 甚至只剩"证据清单摘要"(draft 失败兜底)。报告的"敢用"已经做到,但"能直接读"还差一档。

## Solution

在不放松可信度约束(只写有证据的内容、推断须标注、宁可披露不可编造)的前提下,从三层补齐:

1. **写作要求层**:draft 阶段 prompt 从一句话升级为带硬指标的写作规约(每节深度下限、表格化数据矩阵、执行摘要、结尾建议章、反编造条款、输出前自检),对齐 flow-center 商圈 write 节点已验证的做法。
2. **写作素材层**:draft/rephrase 的 writer 输入从"蒸馏摘要(findings+短引句)"升级为"摘要 + 按问题组织的证据素材包"——每个主张从其来源快照正文中提取引句上下文窗口,让写手看到原始素材的关键语境。
3. **成文环节层**:draft 之后、review 之前新增一次 polish(润色/扩写)LLM 调用:只丰富表达与结构,严禁新增无证据的事实与数字;review 的 rephrase 修复路径与 draft 吃同一素材包。

## User Stories

1. As a 研究用户, I want 每份报告开头有执行摘要(3-5 条决策者视角结论), so that 我不用通读全文就能拿到要点。
2. As a 研究用户, I want 数值密集的章节以表格矩阵呈现而非段落罗列, so that 口径对比一目了然。
3. As a 研究用户, I want 报告末尾有基于证据的启示与建议章, so that 研究结论能落到行动。
4. As a 研究用户, I want 每个章节有实质深度(而非三两句话), so that 报告读起来像研究报告而不是摘要合集。
5. As a 研究用户, I want 写手的论述能回溯到原始来源的语境, so that 转述不失真、细节更足。
6. As a 研究用户, I want 报告经一轮润色后文字连贯、结构完整, so that 接近 Kimi/Gemini 深研报告的阅读体验。
7. As a 研究用户, I want 以上全部提升不以编造为代价(每条论断可回溯证据), so that 我仍然敢把报告用于决策。
8. As a 研究用户, I want 证据不足的章节如实说明而非硬凑篇幅, so that 丰满度要求不会诱导注水。
9. As a 运维者(用户自己), I want 素材注入与润色 pass 的成本增量受预算封顶保护, so that 单 run 成本不失控。
10. As a 维护者, I want 素材包构建是纯函数、可单测, so that 切块/截断/预算逻辑可回归。
11. As a 维护者, I want 润色 pass 可由 run 选项关闭, so that 成本敏感场景可降级。
12. As a 维护者, I want 录制/回放适配器能覆盖新阶段, so that 无 LLM 的测试链路不失效。
13. As a 维护者, I want draft 失败的兜底路径仍然可用(证据清单摘要), so that 新 prompt 更复杂后单点故障不致空手。

## Implementation Decisions

### D1. draft prompt 重写(live.ts `STAGE_PROMPTS.draft`)

新 prompt 要点(全部保留并强化原有克制条款):

- 报告结构强制:`# 标题` → `## 执行摘要`(3-5 条要点)→ 逐节正文 → `## 启示与建议`(基于证据,推断须标注) → `## 口径与局限披露`(已有 limitations 机制对接)。
- 每节深度:每节 ≥300 中文字且至少包含一个数据矩阵表格(当该节有关联数值主张时;无数值主张的节以结构化要点替代并说明原因)。
- 数值必须带来源标记(沿用现有标注体系),推断须标注;**证据不足的节如实说明"现有证据不足以展开",禁止为凑篇幅编造**——反编造条款与深度要求同列,优先级最高。
- 输出前自检清单(口径声明/摘要/每节表格或说明/建议章/披露章齐全)。
- 输出契约不变:仍是 JSON `{"reportMd": string}`(解析与回放链路不动)。

### D2. 证据素材包(新增纯函数 `buildQuestionEvidencePacks`)

- 位置:core 层(编排器侧,非适配器),输入 `(questions, claims, snapshots, budget)`,输出按问题分组的素材包数组。
- 构造规则:claim.id 内嵌来源快照 URL(`cl:{qid}:snap:{url}:{n}` 形态),据此定位快照;在 `bodyText` 中找 claim.quote,截取**引句上下文窗口**(前后各 N 字,默认 ±400,可调);同一快照去重合并(重叠窗口取并集);按问题聚合。
- 预算控制:单快照截断上限(默认 4000 字)、单问题上限(默认 8000 字)、总量上限(默认 40000 字);超限时按主张引用次数优先保留。实测快照正文总量 33k–157k 字/run,全量注入不可行,选择性注入是硬约束。
- 无 quote 命中(quote-mismatch 类主张)退化为该快照开头截断段,仍标注"未逐字命中"。
- 产出物形态:每问题 `{questionId, question, notes: [{snapshotUrl, title, excerpt}]}`,随 draft/rephrase/polish 的 runStage 输入传入(新字段名 `evidencePacks`)。录制/回放适配器对该字段透明序列化,无需改动其语义。

### D3. polish 润色 pass(新增 StageName `"polish"`)

- `StageNameSchema` 增 `"polish"`,对应 `PolishOutputSchema = { reportMd }`;`STAGE_PROMPTS.polish` 明确:只允许重组、扩写表达、补全结构(摘要/表格/建议章),**严禁新增无输入证据支撑的事实与数字**;每个保留论断的标注体系不变。
- 编排位置(与 GRILL 已决 #1 同步):流程为 draft → polish → review;polish 只在 draft 完成且未 capped 时执行一次,checkpoint key `${keyBase}:polish:0`,输出作为 review 的草稿输入;review 回环中的 rephrase 修复吃素材包但不二次润色。
- 检查点语义:polish 是独立 checkpoint,取消/恢复与既有阶段同规则;`safeParse` 兜底=沿用 draft 原文(而非证据摘要)。
- 成本控制:polish 的 usage 计入 `run.usage.costEstimate`,受既有预算熔断约束;run 选项 `polish: false` 可关(默认开)。
- 增量追问(incremental)与 rephrase 路径同样注入素材包,保证修复后质量不回退。

### D4. 兜底与兼容

- draft 解析失败的既有兜底(证据清单摘要)保留;polish 解析失败降级为 draft 原文并在 limitations 记录"润色未完成"。
- `ResearchRequest`/contracts 增可选字段 `polish?: boolean`(默认 true),旧数据无该字段按 true 处理。
- 现有 replay 录制文件不含 evidencePacks 时按空数组处理(向后兼容)。

### D5. 横切不变式

- 发布门禁(引用核查/语义蕴涵/数值复算/多源交叉/信源分级)顺序与强度不变;polish 产出与其他草稿走同一门禁。
- 编排器唯一入口、六阶段状态机命名(plan/gather/analyze/draft/review/publish)不变;polish 是 draft 的子环节,不新增 run.stage。
- 模型链路、搜索链路、模块 registry、formal"只重组不新增事实"原则均不变。

## Testing Decisions

- **好测试的标准**:只测外部行为(给定快照+主张+预算 → 素材包的选取/截断/封顶;给定 LLM 文本 → 解析产物;回放链路 → 阶段输入包含素材包),不测内部实现细节。
- **测试模块**:
  - `buildQuestionEvidencePacks` 纯函数:新建 `src/core/evidencePacks.test.ts`(先例:`src/contracts.test.ts`、`src/modules/modules.test.ts` 的纯单测风格);覆盖:窗口截取、快照去重合并、三级预算封顶、quote 未命中退化、claim→快照 URL 解析。
  - draft/polish prompt 与解析:`src/adapters/liveDraft.test.ts` 已测 draftFromText/parseJsonLoose 路径,扩展 polish 解析用例;prompt 文本变更以快照断言防回归(若项目现有风格无 prompt 快照断言,则以行为断言替代:解析、字段存在性)。
  - 编排器级:replay 适配器驱动 `runResearch` 的集成测试(先例:`src/adapters/replay.test.ts`),断言 polish 阶段被调用、evidencePacks 出现在 draft 输入、polish:false 时跳过。
- **接缝**:最高缝=core 纯函数单测(素材包)+ replay 集成(编排);不新造 LLM 打桩以外的接缝。

## Out of Scope

- 不换写作模型、不接新供应商(模型链路是项目硬约束)。
- 不引入 flow-center 式声明式 DAG 工作流(架构路线不变)。
- 不改 outline 阶段的问题/要点规划逻辑(每节 2-4 bullets 的写作计划本次不动;若试点后仍薄再立单项)。
- 不做正式报告(pptx/html/pdf)侧的模板增强(草稿丰满后 formal 自然受益,不单独改)。
- 不定义"丰满度指标"的产品化度量卡(红队 K1/K2 的验证以试点人工比对进行,不进本期代码)。
- 中文报告以外的多语言输出。

## Further Notes

- **红队 K1(硬指标诱发编造)对策已内建于 D1/D3**:反编造条款列最高优先级 + 发布门禁不变 + 试点验收时人工比对 unverified 主张数。若试点发现编造率上升,回滚方向是降低篇幅下限、保留表格与结构要求。
- **红队 K3 素材成本**:实测快照总量 33k–157k 字/run;D2 三级预算(4k/8k/40k 字)注入增量约 ≤4 万字/run,成本增幅默认目标 ≤50%,PRD diff 门请用户确认该阈值与预算默认值。
- **红队 K4 润色收益**:polish 默认开但可关(D3),试点后若收益 <10% 可在后续版本降级为默认关。
- 试点验收(流程外、交付后由用户执行):同一研究目标跑改动前后两 run,对比节均字数、表格数、unverified 主张数;预期节均字数提升 ≥30% 且无编造回潮。

---

## GRILL 已决问题(2026-04 自问自答,记录留痕)

1. **polish 与 review 回环顺序**:draft → polish → review(回环内 rephrase 不再二次润色)。理由:rephrase 是局部修复,二次润色使回环成本翻倍;修复输入已含素材包,质量不回退。
2. **rephrase 修复路径的 stage 名**:继续用 `draft`(丰满版 prompt 即修复规格),输入加 evidencePacks,checkpoint key 沿用 `draft:fix{n}` 先例;不新增 redraft 阶段。
3. **evidencePacks 不喂 analyze/review**:analyze 只产出每问题一句 summary,review 检查论断一致性,给长素材成本大于收益;二者输入维持现状。
4. **素材包构建时机**:纯函数零缓存——每次 draft/rephrase/polish 调用前从当前 state 重建(regather 后快照集已变,缓存有失效风险;重建成本可忽略)。
5. **40k 字素材的上下文风险**:输入约 4–6 万 token,若试点出现超时/截断,IMPLEMENT 期降总量上限(先 40k→24k),不阻塞本期。
