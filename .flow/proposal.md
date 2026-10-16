# 提案:P2-5 追问会话化 —— followUp 替代增量新 run + 同会话上下文连续

> 来源:docs/PLAN-AGENTIZATION.md P2-5 行 + 用户四决策(产品层规划定稿)。前置全部就绪:P2-3b 会话底座(SessionRuntime 装配/持久账本/锁)、P2-3 确认门、P2-4 采证 agent 化。
> **红队校准前提**(P2-3b/P2-3 两轮红队实证):SDK 对 idle 会话拒绝 control.followUp(pi-adapter.js:533-536)——追问的实际机制=**同会话新 prompt operation**(`run({sessionId, prompt})` 追加 transcript)或活跃期 steer。规划原文"followUp 替代增量新 run"按此理解为实现语义,非 SDK control.followUp 字面。

## 背景与现状事实

- 追问现状:`?followup` 入口→预填表单→**全新 run**(增量基准 incrementalOf 机制):重读基准 bundle、固定快照引用、只为新问题采证(P0-2 前)、plan/outline 预览在 P2-3 已退役(run 内确认门)。
- P2-3b 底座就绪:createProjectSessionRuntime(工厂/锁/bindings/reconcile)、持久账本、`sess:` 前缀约定(未机制化)、真实 Provider 会话链路未跑(合成覆盖装配面)。
- P2-4 采证:逐问 plain runAgent;调查流事件侧车;单 active-run 守卫(POST /runs/rerun 同项目 running|awaiting→409)。
- 会话语义约束(P2-3 v1 KA1 实证):会话路径=**全历史累积**+单 busy——这正是追问想要的(上下文连续),但同会话并发多 run 互撞(逐问 agent 不能迁会话,P2-4 形态维持)。

## 本批内容(推荐)

### 1 追问 = 同会话新 run(产品语义重定义)

- **新端点 `POST /api/projects/:id/runs/followup`**:body={prompt(追问目标/范围), baseRunId?};服务端:
  - 定位基准:项目最新已完成 run(published/limited)或显式 baseRunId;
  - **首次追问**:经 createProjectSessionRuntime 建/开会话→`run({sessionId, taskId:"sess:"+newRunId, prompt:追问任务卡, tools:[]})` 起一条新管线?**不**——追问仍走产品编排器 runResearch(增量基准/双确认门/agent 采证全复用),**会话承载的是"研究对话上下文"**:首次创建会话时,将基准 run 的摘要+问题+结论作为首条 prompt 写入 transcript(operation=prompt,tools=[],limits=uncapped);后续追问各追加一条 summary prompt。
  - **决策:会话=研究项目的持久"研究记忆"**,每条 run 完成时追加摘要 operation;追问起 run 时编排器从会话 tail 拉最近 K 条摘要并入任务卡上下文(替代 incrementalOf 的 bundle 重读路径之一部分)。
- **incrementalOf 机制保留**(证据链与快照引用固定是产品原则);followup 端点等价于现在的"?followup 入口+确认门流"的 API 化:服务端构造 `{goal:追问目标, incrementalOf:{runId, requestId}}` 的 request→走 P2-3 免 plan 启动(双确认门)→P2-4 采证。**用户可见差异**:追问不再"全新研究零上下文",任务卡/调查代理能读到会话内既往研究摘要(已答问题/口径/结论要点)。
- **UI**:侧栏/详情页「追问」入口改调 followup 端点(或维持 ?followup 路由同效);计划确认页显示"延续研究 N 次追问"徽章。

### 2 steer 活跃期干预(P2-4 instruct 队列的会话化升级)

- 活跃 run(gather agent 逐问串行间隙)经 sessionRuntime.control({kind:"steer",text})注入方向指令——**映射到现有 instruct 队列的 refine-direction**(消费时点不变);skip/add-questions 维持 API 现状。
- 底线:steer 不改 SDK 语义,只把"instruct 队列"的注入路径从 POST /runs/instruct 扩一条会话 control 通道(P2-5 内二选一落地,推荐:维持 instruct 端点为主,control 通道留 P2-6 动态预算时再评估——避免本批面过大)。

### 3 压缩与上下文管理

- 会话 harness.compaction 显式启用(reserveTokens 4096/keepRecentTokens 8192):transcript 超限时 SDK 原生摘要压缩;追问任务卡只拉 tail 摘要(不整历史)。
- 3b 遗留补齐:`sess:` 前缀机制化(followup taskId 构造收口);真实 Provider 会话链路跑通(首次生产流量);宿主透出 fault.detail(CONFIG_CHANGED 文案)。

### 4 验证

- 合成 transport:会话双 op(摘要+追问)transcript/压缩触发/追问 run 任务卡含会话 tail 摘要;followup 端点 e2e(免 plan→双门→agent 采证,增量基准生效);旧 ?followup 路由回归。
- 真实 Provider:完整追问 run(真实验证会话+摘要+追问三段);UI 浏览器冒烟(追问入口→确认页徽章)。

## 明确不在本批

P2-6 动态预算/任务迁移/旧编排器退役;跨机会话;investigation 跨 run 聚合视图(时间线仍 per-run);活跃期 control.steer 通道(推荐延后,见 §2)。

## 开放问题(红队/GRILL)

1. 会话摘要的生成:run 完成时谁来写摘要 operation(编排器直接拼模板文本 vs 额外一次模型调用——成本考虑推荐模板拼接:目标+问题清单+口径注记+结论要点计数)。
2. 追问任务卡拉会话 tail 的 K 值与预算(摘要素材进 P2-4 任务卡的哪一段)。
3. followup 与既有增量机制的关系叙述:incrementalOf 仍必填吗(快照引用)还是会话摘要可替代其一部分。
4. steer 延后的裁决(规划字面含 steer,推荐延后=偏离须升级)。
5. 旧项目无会话:惰性创建(首次 followup/run 完成时)兼容面。
