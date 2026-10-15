# 提案:P2-4 采证 agent 化 —— gather 改 runAgent 自主调查 + 调查流视图

> 来源:docs/PLAN-AGENTIZATION.md P2-4 行(用户决策①全自主/③调查流视图)。前置:P2-1/2(piRuntime 通道+计量)、P2-3(确认门)。
> 规格:AGENT-RUNTIME.md P1(自主决策)+ INTEGRATION(五输入/工具合同);P2-3 v1 红队报告(.flow/archive/2026-10-15-p2-3-confirm-gates/red-team-v1-killed-p23.md)对"走会话"的约束。

## 背景与现状事实

- gather 现状:编排器硬编码逐问循环(search→按配额 fetch→parse→extract,maxParallel=4 并发),模型只是被调用的转换函数;干预=3 类指令问题间隙消费。
- runtime 事实(P2-1/3 红队已核):**plain createRuntime 的 runAgent 支持工具循环**(无会话、无 steer);**steer 需 SessionRuntime.control**;会话路径=全历史+单 busy(P2-3 v1 KA1,extract/stage 必须维持无状态);Plain Runtime 并发多 runAgent 无互撞(子 taskId,P2-1 (b) 测试同机理)。
- 预算现状:tier 管 search/fetch/墙钟+maxParallel(产品侧);模型侧 uncapped。

## 与规划的偏离(须升级)

规划 P2-4 行含"**steer 替代 instruct 队列**"——steer 需会话底座(P2-3b,已拆批后置且带四项前置设计)。**推荐**:本批用 **plain runAgent**(无状态逐问 agent),instruct 队列语义保留(问题边界消费),"steer 替代 instruct"随 P2-3b+P2-5 会话化落地——理由:P2-3 v1 红队 KA2 刚论证过"底座+翻转合批=风险叠加",agent 化+调查流 UI 已是本程序最重批,再吞底座必超载。此为规划字面偏离,升级用户。

## 本批内容(推荐)

### 1 gather 逐问 agent 化(全自主,决策①)

- **每问题一次 runAgent**(maxParallel 并发沿用——基础设施并发非限制):prompt=调查任务卡(问题+目标/范围+已答问题摘要+基准上下文);工具三件(宿主注册,executor 复用既有 adapter):
  - `web_search`(effect:external):入参 query;预授权策略=本 run 采证用途自动放行(任务级授权边界,无逐调用确认)。
  - `fetch_page`(external):入参 url;executor=livePage 抓取+**落 SourceSnapshot(证据链不变)**+返回正文摘录(截断防上下文爆炸)。
  - `read_snapshot`(read):读已抓快照正文(分页/截断)。
- **输出 validator**(runAgent 宿主验收):JSON `{ sufficient: boolean, note: string }`——agent 自判"够用"即收(P2-2 计量照旧);sufficient=false 且预算未尽→编排器记 limitation 继续(问题标 unanswered,现状语义)。
- **extract 维持无状态 runText**(P2-3 v1 红队裁决):agent 调查完成后,编排器对**新增快照**批量 extractClaims(claim/quote 证据链与质量管线逐字不动)。
- **停止标准**(决策①:无逐问抓取护栏):agent 自判 sufficient;tier 全局 search/fetch 配额与墙钟照旧(任务级治理);用户 cancel 既有。
- **instruct 队列保留**:agent 启动前 drain(skip/add/refine 语义现状);预算计数在工具 executor 内累计(usage.searches/fetches 契约不变)。

### 2 调查流数据与 UI(决策③)

- **调查事件落盘**:工具 executor 逐事件追加 run 目录 `investigation.jsonl`(kind=query/fetch/read/verdict + 摘要字段);编排器 verdict 也入。轮询端点:GET `/runs/:runId/investigation`(增量,按 seq)。
- **UI 调查流视图**(GatherView 演化,过 UI-GATE):问题进度条弱化为分组头,主区=时间线卡片流(搜索词/页面标题+域名/读取/充分性判定徽),running 态实时追加、完成态可回看;保留用量条/取消/干预入口(现状 instruct 表单)。

### 3 验证

- 合成 transport+合成工具离线 e2e(决定性);replay 夹具**新增 agent 形态夹具**(旧 gather 夹具随架构退役,golden 重录);真实 LLM+真实搜索双供应商冒烟(全自主调查一问到底,证据链抽查);UI 浏览器冒烟。

## 明确不在本批

P2-3b 会话底座(steer/followUp/压缩随 P2-5);followUp 追问;工具白名单以外的执行环境;分析/草稿阶段 agent 化。

## 开放问题(红队/GRILL)

1. steer 偏离升级(如上)。
2. agent 输出 validator 形状与"agent 中途耗尽预算"的 RunResult 语义(budget 停止≠模型失败)。
3. investigation.jsonl 体积(长 run 上限/轮询增量窗口);与 checkpoints 的关系。
4. fetch_page 摘录截断策略(防 agent 上下文爆炸;与 1MiB 护栏关系)。
5. 旧 gather 循环代码的退役边界(gatherBudget/fetchQuota 等测试处置);replay/golden 夹具换代。
6. 调查流视图与既有 GatherView 六阶段/instruct 表单的共存布局(UI-GATE 原型)。
