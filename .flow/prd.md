# PRD: 深度研究工作台 2.1 — 追问扩展（P0-1）+ 执行中干预（P0-2）

> spec source: .flow/proposal.md（决策 D1-D9）· 红队: .flow/red-team.md · 代码摸底: 2026-10-02（runResearch.ts 918 行 / server.ts 749 行 / UI ~2666 行）
> 无项目 issue tracker，按 dev-flow 回退写入本文件。

## Problem Statement

用户完成一次深度研究（10-20 分钟、8 搜/12 抓预算）后想追问或补充方向，唯一手段是发起新 run：旧 run 已核实的证据、快照、主张全部作废重来，同样的钱和时间再花一遍，报告也无法表达"这次研究建立在上次之上"。研究进行中用户发现方向偏了、某问题不重要了、或手头正好有一条关键信源，唯一手段是整跑取消再从头来——干预粒度是"全有或全无"。

## Solution

1. **增量追问 run（P0-1）**：在已完成 run 上发起"追问"，旧 run 的证据/主张/快照作为固定引用带入（不重采、不重抓已有 URL），只为新问题采证；报告按合并证据重装配并标注增量来源；发布走既有门禁，版本差异摘要表达增量。
2. **执行中干预（P0-2）**：运行中可提交四类指令——跳过问题 / 新增问题 / 方向附注 / 补充信源——指令入队并在采证问题间隙被消费；干预历史如实记录在 run 记录中；取消语义不变。

## User Stories

1. As a 研究者, I want 在一个已完成 run 的记录或报告页点「追问」, so that 不必新建项目或从头重跑就能延续这条研究线。
2. As a 研究者, I want 发起追问时看到"将延续什么"的摘要（原 run 的已答问题数、证据数、快照数、数据截止时点）, so that 我确信增量研究建立在已核实的工作之上。
3. As a 研究者, I want 输入追问问题并得到只含新问题的可编辑计划预览, so that 延续"计划先行、人工确认"的产品原则。
4. As a 研究者, I want 增量 run 自动跳过已有快照的 URL 不再重抓, so that 预算只花在缺口上。
5. As a 研究者, I want 增量报告明确标注哪些章节/主张来自原有研究、哪些是本次新增, so that 读者知道证据的时间边界。
6. As a 研究者, I want 增量 run 发布为项目的新不可变版本且差异摘要说明"增量自 run X", so that 版本链可追溯。
7. As a 研究者, I want 研究进行中随时提交"跳过当前/某个问题", so that 不再为不关心的问题烧预算。
8. As a 研究者, I want 研究进行中补充新问题, so that 看到中间结果后能补方向（预算自动按剩余问题重新均分）。
9. As a 研究者, I want 研究进行中贴一个 URL 或一段文本作为补充信源, so that 手头的关键材料直接进入采证（走既有外发权限检查）。
10. As a 研究者, I want 研究进行中留一句"方向附注"（如"重点看国内市场"）, so that 剩余问题的搜索与抽取向新方向倾斜。
11. As a 研究者, I want 提交指令后立即看到"已入队，将在当前问题完成后生效"及当前问题名与已用时, so that 对干预生效时机有诚实预期（不打断进行中的调用）。
12. As a 研究者, I want run 记录如实展示干预历史（何时提交、何时消费、效果如何）, so that 报告的"研究过程可审计"不被破坏。
13. As a 研究者, I want 指令在服务重启/恢复后仍保留待消费状态, so that 取消恢复的 run 不会丢掉我已提交的指令。
14. As a 研究者, I want 增量 run 的证据引用固定的快照/版本内容, so that 旧证据不因原文更新而静默漂移（版本绑定原则延伸到增量场景）。
15. As a 研究者, I want 追问允许把数据截止刷新到今天, so that "最近怎样了"类追问能采到新数据；旧证据如实标注采录时点而不是重新安检。
16. As a 研究者, I want 增量 run 同样受发布门禁与有限交付约束, so that 增量不会成为绕过核查的后门。
17. As a 研究者, I want 恢复一个取消的 run 时真的从检查点续跑而不是静默全量重跑, so that"恢复"承诺可信。

## Implementation Decisions

### P0-1 增量追问 run

- **入口与流程**：GatherView 已完成 run 记录条目 + DraftView 草稿页提供「追问」；流程 = 选择基准 run → 输入追问问题 → 系统生成增量计划预览（**只含新问题**，可编辑；复用 plan-preview 接口传入基准上下文）→ 确认后执行。基准 run 须为本项目内已完成（published/limited）的 run；进行中 run 不可作基准（并发不变式）。
- **契约扩展**（zod，全部向后兼容可选字段）：
  - `ResearchRequest.incrementalOf?: { runId; requestId }`；
  - `ResultBundle.derivedFromRunId?: string` 与 `reuseSummary?: { reusedSnapshots; reusedEvidence; reusedClaims; newQuestions }`；
  - 问题状态枚举增加 `skipped`（P0-2 用）；`ResearchRun.interventions?: Intervention[]`（P0-2 用）。
- **复用通道（v1）**：项目内 run→run 延续 = **固定快照引用**（项目级 snapshots.json 的 snapshot id）+ 证据/主张按原 id 引用；有情报库 versionId 的证据优先绑版本。不新建存储，不强制旧证据补登记情报库身份（现存数据 versionId 命中为 0，如实以快照为准）。跨项目复用仍只走 U2-06 情报库选择器——两条通道、同一版本绑定原则。
- **URL 去重**：增量采证的候选命中若 URL 已存在于基准 run 证据快照 → 直接引用旧快照，不 fetch、不重抽（这是预算节省主机制；同时规避 snapshots.json 同 URL 覆盖导致的旧证据引文漂移）。
- **as_of 语义**：发起时默认"数据截止今天"（新采证据按当前时点），旧证据不重新做时间口径安检，但报告限制披露中标注"延续证据采录于 X 时点"；用户可选沿用原截止点。
- **报告与发布**：草稿按合并证据重装配（新问题章节 + 原有章节），新增主张标注 `增量`；发布走既有 7 项检查与门禁，版本差异摘要注明"增量自 run X，新问 N / 复用快照 M"。
- **取消/恢复**：增量 run 取消后可恢复，行为与普通 run 一致（见检查点决策）。

### P0-2 执行中干预

- **API**：`POST /api/projects/:id/runs/instruct`，体 `{ requestId, instruction }`；instruction 为带判别字段的 zod 联合：`skip-question{questionId?}`（缺省=当前问题）、`add-questions{questions: string[]}`、`refine-direction{note: string}`、`add-source{url? , text?, title?}`。返回入队回执。对非 running 的 run 返回 409。
- **指令通道与持久化**：server 侧在现有 per-run `controllers` Map 旁建 per-run 指令队列（内存 + `runs/<runId>/pending-instructions.json` 落盘）；编排器在 gather 每问循环头消费（与 `cancelled()` 同位轮询）；消费结果追加进 run 记录的 `interventions[]`（at/type/payload/consumedAt/effect）。服务重启清扫逻辑不变（running → failed），pending 文件供审计与失败披露。
- **指令语义**（gap 内消费，不打断进行中调用）：
  - skip-question：目标问题状态置 `skipped`（已 answered 的无效，回执说明）；gather 目标过滤跳过；skipped 问题在报告中如实列为未研究。
  - add-questions：追加 `status: open` 的新问题；每问抓取配额按新的剩余问题数自动重算（沿用现有均分公式）。
  - refine-direction：附注文本注入剩余 open 问题的搜索 query 构造与抽取提示（只影响后续，不回溯）。
  - add-source：URL 走既有抓取→快照→抽取路径，纯文本走附件注入路径；两者都过 S-03 外发门禁；抽取的主张挂到"用户新增"这个隐式问题上（或最相关 open 问题）。
- **UI**：GatherView activeRun 卡新增「干预」区（四类快捷操作 + 当前问题名/已用时展示）；提交后按钮态为"已入队，待当前问题完成"；`GET /api/projects/:id` 的 run 数据带 interventions 供轮询展示。轮询机制不变（不加 SSE/WS）。
- **取消不变**：cancel 优先于一切指令；取消后 pending 未消费指令保留在文件中供审计，恢复 run 时继续有效。

### 生命周期修复（新增 scope，见 diff gate）

- **resume 静默重跑修复**：`/runs/resume` 当前先预落新 running run.json，`findRunByRequestId` 按目录序取第一条，可能先命中新记录导致 `resuming=false` 全量重跑。修复为：恢复判定先于预落（或 find 明确优先含 checkpoints 的原记录）。此修复是 P0-1/P0-2 生命周期可信的前提，含锁测试。

### 明确不改变

- 检查点仍为阶段级（gather 完成才落整段）——升级为问题级不在本次 scope，作为 known limitation 记录（采证中途取消后恢复会重跑 gather 剩余部分，快照已即时落盘不重复抓取成本之外的网络成本仍在）。
- 阶段顺序、发布门禁、有限交付、不可变版本、预算 capped 语义、S-03/六维状态/as_of 治理全部不变；增量与干预不得绕过任何门禁。

## Testing Decisions

- 好测试只测外部可观察行为：编排器输入（请求/指令/适配器回放夹具）→ 输出（run 记录、bundle、检查点、落盘文件），不断言内部调用次数。
- 既有先例照抄：`runResearch.test.ts` 的回放适配器模式、`reuseIntegration.test.ts` 的绑定注入、`server.test.ts` 的 http 句柄级测试。
- 新增覆盖：增量 run 上下文带入与 URL 去重（同 URL 不二次 fetch）、旧证据引文在增量报告核查中的命中、增量发布差异摘要、指令四类语义（含"已 answered 不可 skip"、"预算重算"）、指令落盘与恢复续消费、resume 修复的回归锁、门禁对增量 run 照常生效（反例：复用证据引用缺失时降级披露而非击杀）。
- 基线 219/219 必须保持绿；UI 层维持现状（无 UI 测试，人工验收）。

## Out of Scope

- P1/P2 全部（意图澄清轮、研究轨迹流侧栏、来源范围勾选、深度档位、引用漏斗、报告图表）
- 跨项目增量、多 run 合并基准、以进行中 run 为基准
- 执行中修改报告框架、执行中撤回指令、SSE/WebSocket 实时推送
- 检查点粒度升级为问题级、旧 run 证据批量补登记情报库身份
- 定时/自动研究（D4 永久排除）

## GRILL 自答决策（2026-10-02，追加；用户已确认 PRD diff 含 A5 放宽方案）

| # | 开放点 | 决策 | 理由 |
|---|---|---|---|
| G1 | 增量 run 预算 | 独立预算，默认沿用交互预算（8 搜/12 抓），可 per-run 覆盖；URL 去重使实际网络消耗更低 | 与普通 run 一致，不引入第二套预算语义 |
| G2 | 追问问题数上限 | 单次 ≤6 个新问题（add-questions 指令同界） | 均分公式下保证每问至少有效抓取配额 |
| G3 | **增量 run 的框架确认** | 增量流程同样走双确认：增量计划预览 + **增量框架预览**（基于原 outline + 新问题生成插入位置，可编辑）后才执行 | 用户既有决策「计划+报告框架都要确认才执行」延伸到增量场景；PRD 初稿遗漏，此处补齐 |
| G4 | run 记录暴露当前问题 | `ResearchRun.progress?: { currentQuestionId?, currentQuestionText?, answered, open, skipped, total }`，每问 persistRun 时更新 | UI 干预区的"当前问题"展示与 skip 缺省目标都依赖它；现契约无 questions 暴露 |
| G5 | add-source 抓取失败 | 记 limitation + intervention `effect: failed`，不中断 run | 与"失败不击杀 run"原则一致 |
| G6 | 指令入队约束 | add-questions ≤6/条、refine-direction ≤500 字、add-source 一次一条、队列深度 ≤20（超出 409） | 防滥用与队列积压；上限值可后续按实测调整 |
| G7 | 增量 run 在记录列表的标识 | `ResearchRun.derivedFromRunId?` + UI 徽标「增量」 | run 列表/发布链可视化 |
| G8 | pending-instructions.json 与双机 git 同步 | 无需特殊处理（runs/ 目录本就随 research-data 同步） | 天然一致 |
| G9 | interventions 落盘时机 | 指令消费时随 persistRun 写入 run 记录 | 与"阶段实时落盘"一致 |
| G10 | 增量预览 API | 扩展现有 plan-preview / outline-preview 接口，请求体加 `incrementalOf` 参数，不新增端点 | 复用现有确认流 UI 与测试 |
| G11 | 链式增量（增量 run 再被追问） | 允许：基准为项目内任意已完成 run（含增量 run）；reuseSummary 如实累计汇报 | 机制天然递归，无需特判 |
| G12 | refine-direction 多次提交 | 追加（按时间序全部注入剩余问题上下文），不覆盖 | 保留干预历史语义 |
| G13 | 基准 run 为 limited（有限交付） | 继承基准 limitations 到新报告限制披露（"基准研究的限制沿用"），不重新触发基准的门禁 | 基准门禁结论是不可变历史；增量 run 只对新装配负责 |

无 escalation：以上均为留白填补或对既有决策（双确认、失败不击杀、实时落盘）的贯彻，无与 proposal.md 冲突项。

## Further Notes

- 数据现状依据：6 项目、仅 p-muardyef 有 2 个有效 run（问题精确重叠 0/8、快照共享 1/23）——印证红队「复用率」担忧，故 P0-1 的省钱主机制定在 URL 去重与"不重答已答问题"，而非乐观的"大部分证据可复用"。
- 备用链 MIMO 单次抽取实测最长 199.5s：干预指令的典型等待 = 当前问题剩余时长（分钟级），UI 必须如实呈现而非暗示即时生效。
- 情报库在真实数据中为空（2.0 交付仅测试覆盖）——P0-1 不依赖其运行时状态，但 v1 复用通道与 U2-06 通道的关系已在实现决策中显式定义，避免双轨漂移。
