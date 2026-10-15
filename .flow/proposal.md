# 提案 v2:P2-3 确认门翻转 —— run 内 durable 确认门替代浏览器向导两张皮

> v1(会话底座+确认门合批)被红队 kill(.flow/red-team.md):拆批与确认门机制偏离已获用户确认(2026-10-15),规划已更新(febefea)。本 v2 只含确认门翻转;会话底座归 P2-3b。

## 背景与现状事实

- **两张皮现状**:计划/框架经浏览器向导预览(plan-preview/outline-preview 端点,各一发真实 LLM)→ 用户确认 → POST /runs **必须带已确认的 plan**(outline 可选作为 request.outline)→ run 启动即全速。确认动作发生在 run 之外,无 durable 状态;"启动即可见"靠预落 running 记录。
- **编排器已有**:durable checkpoints 落盘(runResearch saveCp)、cancel/resume 机制(resume=cancelled 后重跑)、instruct 队列;启动清扫只清 running(server 启动)。
- **outline 现状**:不是流水线阶段——STAGE_PROMPTS 有 outline(仅预览端点用),draft 消费 request.outline(可选)。
- 契约:ResearchRun.status 枚举 ["running","cancelled","failed","published","limited"];POST /runs body.request + body.plan(必需)。

## 本批内容

### 1 流水线内嵌两道确认门

- **plan 门**:POST /runs **不再要求 plan**——run 启动 → plan 阶段(runStageSafe plan)产出问题清单 → **durable 暂停**:run.status 新增 `awaiting-confirmation`,gate payload(问题清单+goal/scope 摘要)随 checkpoint 落盘,编排器返回;→ 用户确认(可编辑问题)→ confirm 后继续 gather。
- **outline 门**:确认计划后流水线新增 **outline 阶段**(runStageSafe outline,输入=已确认问题)→ 同机制 `awaiting-confirmation` → 用户确认框架(可编辑标题/章节)→ 确认后进 gather;draft 改用已确认 outline(替代 request.outline 输入)。
- **gate 实现(用户裁决:产品级 durable gate)**:编排器状态机扩展——`awaiting-confirmation` + gate checkpoint(stage="plan"/"outline",payload=产出物);confirm API 带用户编辑后的 payload 写回 state 再续跑。语义对齐 BUSINESS_WAIT:暂停=durable(进程重启仍待确认)、恢复=核账后续跑、放弃=cancelled(既有)。
- **取消/清扫**:awaiting-confirmation 可 cancel(→cancelled,既有语义);启动清扫**只清 running 不动 awaiting-confirmation**(重启后确认页仍可确认续跑——复用 resume 骨架:从 gate checkpoint 恢复 state 续跑)。

### 2 API 变更(契约变更,规划授权)

- POST /runs:plan 改可选(带=旧行为跳过 plan 门,兼容增量追问场景——wizard 追问入口仍可用?见开放问题 2);响应含 runId+gate 提示。
- 新增:`GET /api/projects/:id/runs/:runId/gate`(读待确认 payload)、`POST .../gate/confirm`(body=编辑后 payload)与 `POST .../gate/cancel`(语义=cancel,复用既有?)。
- **预览端点退役**:plan-preview/outline-preview 从 UI 流程移除;端点保留 or 删除见开放问题 3。

### 3 UI 变更(新交互面 → UI-GATE 必停)

- 计划页向导(`?new=1` 三步)改为 **run 确认流**:发起新研究(表单:目标/范围/预算/追问基准/附件/复用资产——即现第一步)→ 立即起 run → 计划页显示"待确认"卡片(问题清单可编辑)→ 确认→框架确认卡片(标题/章节可编辑)→ 确认→采证。向导的 planWizard 预览编排(plan-preview/outline-preview 调用)退役,表单状态与起跑逻辑保留复用。
- 追问入口(?followup)同新流;rerun 不变(带原问题清单跳过 plan 门)。

### 4 兼容

- 旧 run 记录(无 gate)不受影响;带 plan 启动的旧路径保留(增量追问 wizard 若保留);running 状态机其余转移不变;instruct/cancel/resume 语义不变(awaiting-confirmation 下 instruct 无消费点→409 现状语义)。

## 明确不在本批

P2-3b 会话底座全部;P2-4 采证 agent 化/steer;P2-5 followUp;人审门(发布)现状不动。

## 开放问题(红队/GRILL)

1. gate 状态机细节:awaiting-confirmation 是否计入 wallMs 预算(倾向:暂停不计,墙钟从 gather 起算或预算不含等待——BudgetTracker startedAt 语义);resume 自 gate 恢复与自 cancelled 恢复的路径统一。
2. 增量追问场景:wizard 增量预览(incrementalOf 基准问答)是否保留 plan-preview 通道,还是追问也走 run 内门(plan 阶段输入含基准,产出后确认)?
3. 预览端点处置:直接删除(减面,但 characterization/既有测试与 P1-3 附录 A 条目联动)vs 保留弃用。
4. confirm 的 payload 校验:问题清单编辑后数量/空串约束;outline 编辑的结构校验(zod 复用)。
5. 并发约束:同项目同时只允许一个未决 gate?(现状同项目仅一 active run,沿用)。
6. UI 确认页的空态/失败态(gate 读取 404、确认冲突 409)。
