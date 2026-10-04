# 任务拆解:报告丰满度三重改进

- [x] 1. 证据素材包纯函数 `buildQuestionEvidencePacks` + 单测
- [x] 2. draft 丰满版 prompt + evidencePacks 注入 draft/rephrase 输入
- [x] 3. polish 润色 pass(StageName/prompt/编排/选项/兜底)+ 集成测试

## 1. 证据素材包纯函数

## Parent
.flow/prd.md D2

## What to build
core 层纯函数 `buildQuestionEvidencePacks(questions, claims, snapshots, budget)`,按问题分组产出引句上下文窗口素材包:从 claim.id 解析来源快照 URL 与问题 id,在快照 bodyText 中定位 claim.quote 并截取前后窗口,同快照去重合并,三级预算封顶(单快照/单问题/总量),quote 未命中退化为快照开头截断段并标注。新建 `src/core/evidencePacks.test.ts` 覆盖:窗口截取、去重合并、三级封顶、未命中退化、id 解析。

## Acceptance criteria
- [x] 给定合成 questions/claims/snapshots,产出按 questionId 分组的 notes(url/title/excerpt)
- [x] 同快照多窗口重叠时合并为一个 excerpt
- [x] 单快照/单问题/总量三级封顶生效,超限按引用次数优先保留
- [x] quote 在 bodyText 中未命中时退化为开头截断段且带"未逐字命中"标注
- [x] vitest 全绿

## Blocked by
None - can start immediately

## 2. draft 丰满版 prompt + evidencePacks 注入

## Parent
.flow/prd.md D1 + D2

## What to build
重写 `STAGE_PROMPTS.draft`(执行摘要/每节 ≥300 字+数据矩阵表格/启示与建议章/口径与局限披露/反编造条款最高优先级/输出前自检,输出契约 JSON {"reportMd"} 不变);编排器 draft 段与 review 回环 rephrase 路径的 runStage 输入增 `evidencePacks`(调用任务 1 纯函数现算);liveDraft 测试风格扩展解析回归用例。

## Acceptance criteria
- [x] draft prompt 含执行摘要、每节深度、表格矩阵、建议章、披露章、反编造、自检七要素
- [x] draft/rephrase 的 stage 输入含 evidencePacks 字段, replay 录制文件无该字段时按空数组兼容
- [x] 输出契约与解析路径不变(报告仍 JSON reportMd)
- [x] vitest 全绿

## Blocked by
- 任务 1

## 3. polish 润色 pass

## Parent
.flow/prd.md D3 + D4

## What to build
`StageNameSchema` 增 `"polish"`,`PolishOutputSchema={reportMd}`,`STAGE_PROMPTS.polish`(只丰富表达与结构,严禁新增无证据事实/数字);编排器在 draft 后、review 前插入 polish 段(checkpoint `${keyBase}:polish:0`,safeParse 兜底=沿用 draft 原文并记 limitation);`ResearchRequest` 增 `polish?: boolean` 默认 true,`polish:false` 跳过;增量追问路径同注入素材包;replay 集成测试断言 polish 被调用/输入含素材包/关闭时跳过。

## Acceptance criteria
- [x] polish 阶段在 draft 与 review 之间执行,产物作为 review 的草稿输入
- [x] polish 解析失败降级为 draft 原文 + limitations 记录
- [x] polish:false 时整段跳过且 checkpoint 语义正确(恢复不重跑)
- [x] polish 成本计入 usage,受预算熔断约束
- [x] vitest 全绿

## Blocked by
- 任务 2
