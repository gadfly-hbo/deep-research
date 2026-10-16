# 提案:P2-6 动态预算 + steer 通道 + 旧编排器退役 —— Agent 化程序收官批

> 来源:docs/PLAN-AGENTIZATION.md P2-6 行(程序最后一批)。前置:P2-1~5+3b 全部就绪(接缝合规/预算放开/确认门/采证 agent 化/会话底座/追问会话化)。
> 用户四决策贯穿:①全自主(已落地 P2-4)②预算放开(P2-2 uncapped)③调查流视图(P2-4)④成本退役(P2-2)。

## 背景与现状事实

- **预算现状**:budget tier(low/medium/high)锁死在启动时(search/fetch 配额+墙钟);uncapped 显式化(P2-2);rerun 换档=全新 run(P2-3 前);运行中不可加注/改道。
- **steer 现状**:instruct 队列 3 类指令(skip/add/refine)在问间隙消费(P2-4 保留);steer 需管线模型调用走会话(P2-4 plain runAgent + P2-5 仅摘要/初始化走会话——**管线采证 agent 仍在 plain 通道**);SDK control.steer 需活跃绑定任务。
- **编排器现状**:runResearch ~1400 行(P2-4 已 agent 化 gather);编排器负责 plan/outline/analyze/draft/polish/review/publish 阶段调度+确认门+指令消费+预算 tracker——"退役"≠删除,是"缩为装配层"(阶段仍为 runText 无状态,P2-3 v1 红队裁决维持)。
- **P2-5 遗留**:F4 plan 输入无纪要段;F6 纪要段零直接测试;F10 UI 契约负例矛盾;F11 锁外读竞态;任务迁移(CONFIG_CHANGED 出路第三条)。

## 本批内容(推荐分四片)

### 1 运行中动态预算

- **加注端点** `POST /runs/:runId/budget`:body={addSearches?,addFetches?,extendWallMs?};per-project 锁内更新 BudgetTracker 上限(**Budget 接口扩为可变**——tracker 现持 budget 引用,需改为可更新引用或 bump 消息通道);累计额仍不封顶(用户①"放开"语义:加注只增不减)。
- **UI**:GatherView 用量条旁「加注」按钮(弹层输入增量,确认后 POST);墙钟延长同理。
- rerun 换档维持现状(不做运行中降档——加注只增)。

### 2 steer 通道(P2-4 红队/P2-5 红队两轮校准后的最小落地)

- **不做** SDK control.steer(前提=管线模型调用迁入会话——P2-3 v1 KA1 实证全历史+单 busy 撞死逐问并发,迁移=架构重写)。**做**:instruct 队列的 refine-direction 指令从"下一问生效"升级为"当前调查中的 agent 下一轮工具调用注入"——工具 web_search 的 executor 检查新指令队列(refine-direction 在问内即时生效,skip/add 仍问间隙)。
- **决策**:这是 instruct 语义增强,非 SDK steer 字面;规划"steer 替代 instruct 队列"按此前三轮红队校准理解为"干预通道升级"——本批问内即时改道替代问间隙改道。**升级用户确认**(第三次偏离规划字面)。

### 3 P2-5 遗留收尾

- F4:plan 阶段输入增纪要段(复用 sessionDigests,编排器 plan runStageSafe 输入注入);
- F10:UI 契约负例勘误(count=0 显示"首次追问",实现为正确面);
- F11:followup 的 readSessionDigests 移入 withProjectLock(竞态关闭);
- 任务迁移文档:CONFIG_CHANGED 出路第三条(旧 taskId 封存→新 taskId 起账)写入 handoff/文档(实现留后续,非本批代码)。

### 4 编排器"缩为装配层"+程序收官

- runResearch 拆出纯调度骨架(阶段序列+门+指令消费点)与领域逻辑(gather agent 工具构造/证据归属/质量回环)——**结构整理非行为变更**;目标:主函数 <400 行,gather 域独立文件。
- **程序收官**:docs/PLAN-AGENTIZATION.md 六批全勾+程序级总结(交付清单/指标/遗留);handoff 程序终结卡。

## 明确不在本批

管线模型调用迁入会话(架构重写,steer 字面落地的前提——留独立程序);SDK control.steer/followUp;跨机会话;compaction;成本恢复。

## 开放问题(红队/GRILL)

1. Budget 可变接口的实现(tracker 引用更新 vs bump 消息);运行中加注的竞态窗(executor 正在 error-as-value 时加注到达)。
2. 问内 refine-direction 注入的实现面(executor 检查 vs prompt 轮次注入);与现有 pollInstructions 通道的关系。
3. steer 偏离升级(第三次偏离规划字面,须用户确认)。
4. 编排器拆分的边界(gather 域/质量回环域/确认门域/装配层)——纯移动还是有行为风险?
5. F6 纪要段测试(补直接断言 or 接受 e2e 间接覆盖)。
