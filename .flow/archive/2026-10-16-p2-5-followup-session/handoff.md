# P2-5 交接卡(追问会话化)

## 本批交付

- **会话=研究记忆**:run 完成时零模型直写摘要(update);首次惰性建会话+一次真实 session run()(全链验证);摘要含状态/目标/口径注记/要点计数(800B 硬顶)。
- **followup 端点**:`POST /runs/followup`(基准按 mtime 取最新/显式 baseRunId/增量校验/守卫三处收口 assertNoActiveRun/免 plan 起跑+sessionDigests 注入)。
- **任务卡【既往研究纪要】段**:K≤3 条 tail 摘要,bundle 权威+tail 叙事分层("以基准数据为准"写进模板)。
- **UI**:追问通道换 followup 端点;确认卡"延续研究·第 N 次追问"徽章。
- 推送 `d8d33b4..6b4676a`(8 commits)。

## 验证状态

- 411 测试全绿(+7:摘要模板/update 零模型+首次恰 1 次/tail K/候选降级/followup e2e 404-409-200-双门-完成/F1 集成 gate 出口摘要=0→终态恰 1/F2 双基准 mtime)。
- REVIEW 两轮(agent-81 FAIL→agent-82 PASS):F1 gate 出口半途纪要(生产实证)/F2 UUID 字典序,均修复;**集成测试暴露真缺陷**:回调 auditPath 缺省落 defaultDataDir()(生产目录)——绑定 deps.dataDir。
- 真实冒烟:基准 run 完成→会话惰性建+首次真实 run(transcript 14 行含初始化纪要)→followup 双门确认→gather 采证(derivedFromRunId)。

## 遗留(P2-6 输入)

1. **P2-6 动态预算+退役**(最后一批):运行中加注/改道;steer 通道(前提=管线模型调用迁入会话);任务迁移(旧 taskId 封存→新 taskId);旧编排器退役(runResearch 缩为装配层);全链真实验证。
2. F4:plan 阶段输入无纪要段(仅采证任务卡);F6:纪要段进任务卡零直接测试覆盖(经 e2e 间接);F10:UI 契约负例矛盾(count=0 显示"首次"vs"不显");F11:锁外读竞态(质量注记)。
3. 非阻塞:compaction 死配置(不启用,设计钉);运行态披露两条持续(会话跨机不续/预算账本本机)。

## 下一批前置

- 工作区干净;ui-dist 已含徽章。
- research-data 含冒烟项目(p-mvaekd3h 储能电池产业链,可归档)。
