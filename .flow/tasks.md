# 2.1 增量升级切片（P0-1 追问扩展 + P0-2 执行中干预）

> 来源：.flow/prd.md（含 GRILL G1-G13）· 拆解自批准（gated 流程规则），依赖关系见各节

- [x] 1. 修复 resume 静默重跑脆弱点（生命周期地基）
- [x] 2. 契约扩展 + run 进度暴露（incrementalOf / derivedFromRunId / reuseSummary / skipped / interventions / progress）
- [x] 3. 增量预览 API（计划 + 框架双确认的增量版）
- [x] 4. 增量 run 编排（上下文带入 / URL 去重 / 复用明细）
- [x] 5. 增量报告装配与发布差异摘要
- [x] 6. 指令端到端（instruct API → 队列落盘 → gather 消费四类语义 → interventions 记录）
- [x] 7. UI：追问流程 + 干预区 + 增量标识（tsc/build 通过;视觉走查待用户人工验收）
- [ ] 8. 验收与文档同步

---

## 1. 修复 resume 静默重跑脆弱点

### What to build
`/runs/resume` 当前先预落一条新 running run.json，而 `findRunByRequestId` 按目录序取第一条匹配请求的 run——可能先命中新记录使 `resuming=false`，检查点被跳过，恢复静默变成全量重跑。修复为恢复判定先于预落（或 find 优先含检查点的原记录），并保证恢复沿用原 runId。

### Acceptance criteria
- [ ] 取消一个已完成 ≥1 阶段（有检查点）的 run 后 resume，断言：沿原 runId、completedStages 生效、适配器调用不包含已完成阶段的重复调用
- [ ] 回归锁：resume 后 run 记录只有一条 running（新预落记录不再参与 resuming 判定歧义）
- [ ] 既有 resume 行为（无检查点时全量重跑）不受影响

### Blocked by
None - can start immediately

## 2. 契约扩展 + run 进度暴露

### What to build
zod 契约向后兼容扩展：`ResearchRequest.incrementalOf?`；`ResearchRun.derivedFromRunId? / interventions? / progress?`；`ResultBundle.derivedFromRunId? / reuseSummary?`；问题状态枚举加 `skipped`；Intervention 结构（at/type/payload/consumedAt/effect）。编排器 persistRun 时更新 progress（当前问题与计数）。真实 v1 fixture 向后兼容。

### Acceptance criteria
- [ ] 新字段全部 optional，旧 run.json / bundle.json / request 解析通过（真实 v1 fixture 回归）
- [ ] progress 在采证每问推进时如实更新（answered/open/skipped/total + currentQuestion）
- [ ] intervention zod 联合校验：非法类型/超限 payload 被拒

### Blocked by
None（与切片 1 无依赖，顺序执行）

## 3. 增量预览 API（计划 + 框架双确认的增量版）

### What to build
现有 plan-preview / outline-preview 接口请求体增加 `incrementalOf: { runId, requestId }`：计划预览返回**只含新问题**的问题清单（≤6，可编辑）；框架预览基于基准 outline + 新问题生成增量框架（标注新章节插入位置，可编辑）。基准必须是本项目内已完成（published/limited）的 run，否则 4xx。同时返回"将延续什么"摘要（基准已答问题数/证据数/快照数/采录时点）。

### Acceptance criteria
- [ ] 带 incrementalOf 的计划预览不含基准已答问题，新问题数 ≤6
- [ ] 框架预览标注增量章节；基准 outline 缺失时如实降级（全量框架 + 披露）
- [ ] 跨项目 runId / 进行中 run 作基准被拒（403/409）
- [ ] 无 incrementalOf 的调用行为与现状逐字节一致

### Blocked by
2

## 4. 增量 run 编排（上下文带入 / URL 去重 / 复用明细）

### What to build
runResearch 支持 `incrementalOf`：初始化时读基准 bundle，将其 evidence/claims 按原 id 注入 state、快照按项目级 snapshot id 引用；采证只针对新问题；候选命中 URL 已在基准证据快照中 → 直接引用旧快照不 fetch 不重抽；产出 `reuseSummary`（复用快照/证据/主张计数 + 新问题数）；预算独立（默认交互预算）；as_of 默认刷新今天、基准证据不重检但入限制披露（G13 继承基准 limitations）。

### Acceptance criteria
- [ ] 增量 run 不重答基准已答问题；URL 去重生效（同 URL 零二次 fetch，回放适配器断言）
- [ ] 基准证据/主张原样可用（id 不变、引文核查照常对基准快照命中）
- [ ] reuseSummary 计数与实际注入一致；capped 语义照常
- [ ] 基准 bundle/快照缺失时：如实降级（无复用 + 披露），不击杀 run

### Blocked by
2

## 5. 增量报告装配与发布差异摘要

### What to build
增量草稿按合并证据装配：基准章节 + 新问题章节，新增主张标注增量来源；发布走既有 7 项检查与门禁（≥80% 命中率 / 有限交付不变）；版本差异摘要注明"增量自 run X：新问 N / 复用快照 M / 新增主张 K"；发布为项目新不可变版本。

### Acceptance criteria
- [ ] 增量草稿含增量标注与基准采录时点披露
- [ ] 复用证据引文核查失败时按既有规则降级（unverified 留存），门禁不被绕过
- [ ] 差异摘要正确表达增量来源；正式报告（HTML/PPTX）渲染增量元信息

### Blocked by
4

## 6. 指令端到端（instruct API → 队列落盘 → gather 消费 → interventions 记录）

### What to build
一条 tracer bullet 打通干预闭环：`POST /api/projects/:id/runs/instruct`（skip-question / add-questions≤6 / refine-direction≤500 字 / add-source 一次一条，队列深度 ≤20）→ per-run 队列（内存 + `runs/<runId>/pending-instructions.json` 落盘）→ 编排器在 gather 每问循环头消费（与 cancelled() 同位，不打断进行中调用）：skip 置 `skipped`（已 answered 无效并记 effect）、add 追加 open 问题且每问配额按新剩余数重算、refine 注入剩余 open 问题的搜索 query 与抽取提示（不回溯）、add-source 走既有抓取/附件注入路径并过 S-03 外发门禁（失败记 limitation + effect failed 不中断）→ 每条消费记 `interventions[]` 随 persistRun 落盘。非 running run 提交返回 409；cancel 优先于一切指令，取消后未消费指令保留 pending 文件；恢复 run 时 pending 继续有效。

### Acceptance criteria
- [ ] 四类指令语义各有行为级测试（含"已 answered 不可 skip"、"配额重算"、"不回溯"、"失败不中断"）
- [ ] zod 精确校验合法/非法 payload（409/400 语义正确）；队列深度超限 409
- [ ] 指令落盘可在进程重启后读回；恢复 run 时 pending 指令继续被消费
- [ ] 指令消费不打断进行中的问题；干预历史在 run 记录完整可查
- [ ] 无指令时编排行为与现状一致（回归）

### Blocked by
2（消费点代码在切片 4 的 gather 循环上，实现顺序接在 4 后）

## 7. UI：追问流程 + 干预区 + 增量标识

### What to build
GatherView 已完成 run 记录与 DraftView 提供「追问」入口：选基准 → 输入问题（≤6）→ 增量计划预览（可编辑）→ 增量框架预览（可编辑）→ 执行；展示"将延续什么"摘要。activeRun 卡新增「干预」区：四类快捷操作 + 当前问题名/已用时（读 progress）+ 入队回执态"待当前问题完成生效"。run 列表加「增量」徽标（derivedFromRunId）。遵循 DESIGN.md（Xanthil 橘accent）。

### Acceptance criteria
- [ ] 追问全流程可走通（双确认齐全），发起后与普通 run 进度呈现一致
- [ ] 干预提交后立即回执 + 当前问题可见；interventions 历史在 run 详情可见
- [ ] 人工验收：UI 截图/走查记录

### Blocked by
3, 4, 5, 6

## 8. 验收与文档同步

### What to build
全量测试 + typecheck + build；PRODUCT-OVERVIEW / WHITEPAPER 增量小节（2.1：追问扩展与执行中干预）；docs/DEEP-RESEARCH-SURVEY.md 借鉴清单标注 P0 已落地。

### Acceptance criteria
- [ ] 219 + 新增测试全绿，typecheck/build 干净
- [ ] 文档同步且与实现一致（无超前承诺）
- [ ] survey 文档 P0 状态更新

### Blocked by
1-7
