# P2-4 任务切片(采证 agent 化)

来源:`.flow/prd.md`(红队 C1-C5 + GRILL R1-9 全并入;UI 契约已批准)。切片自批准(auto):依赖链机械导出。

- [x] 1. T1(0a17de2) — 证据:piRuntime 4 新测(工具循环/并发零互撞 C5 前半/抛错 TOOL_FAILED 红侧/截断)+fsStore investigation 测;共享 scripted 假件落地;偏离:runAgent 可选(attachments/resumeV1 存活夹具约束,T3 复核维持)
- [x] 2. T2(9320a44) — 证据:gatherAgent.test 6 条红→绿(C4 对拍/配额=1 error-as-value/私网拒绝/e2e 事件序列/verdict 兜底/regather 清理钉);golden 重录;gatherBudget 公平性原样过;18 份夹具接共享假件(实测超 R1-8 清单 3 份)
- [x] 3. T3(6fce5fd) — 证据:investigation 端点 4 新测+replay agent 2 新测(全链再生/缺口暴露);录制=工具调用脚本驱动真 executor;偏离:录制形状在 ModelProvider 层非 transport 层(抽象层无模型回合原文,回放验收满足)
- [x] 4. T4(643b3af) — 证据:377 全绿+build 过;coder 假件浏览器冒烟(8 事件实时)+主代理真实完成态回看(11 事件:分组头/判定/搜索卡/用量条);负例 4 项自查过;偏离:信封含 questions 清单/事件含 title(UI 契约 S2/S3 服务)/空态以快照前缀近似/运行中徽为 verdict 近似(终态自愈)
- [x] 5. T5 — 证据:C5 全落(T1 并发测+gatherAgent 后验 parse);真实双供应商两轮:首轮暴露「agent 只凭搜索摘要判充分」→任务卡补证据规则(2f52926+金样本重录 6fccfce);二轮 req-p24b:33 事件/3 抓取/2 快照/质量回环(q1 首轮不充分→补证已答)/agent 4-7 轮 7-13 工具调用/单问 fetch 占比小样本记录;真实 UI 完成态回看转录

---

## 1. T1 接口与基建层

## What to build
ModelProvider 扩 runAgent(R1-2 签名);piRuntime Channel 增 runAgentRaw(透传完整 RunResult,status/text/reason/usage;三分映射 agent 版:text=succeeded value;其余含 reason);ResearchStore 增 appendInvestigation/readInvestigation(fsStore runs/<id>/investigation.jsonl 续写 max seq;memory 对等);live.ts FETCH_TIMEOUT 30s→20s;`src/adapters/testing.ts` 共享 scripted-agent 假件(供 10 测试文件替各自 model 分支)。

## Acceptance criteria
- [ ] typecheck 过;piRuntime 单测:runAgentRaw 合成 transport 下工具循环跑通(假工具计数)、并发两路异 taskId 零互撞(C5 前半)
- [ ] store 单测:append/read 增量、seq 跨实例续写

## Blocked by
None

---

## 2. T2 编排器 gather agent 化

## What to build
runResearch gather 循环重写:逐问串行(R1-1 taskId 含 r${round});工具三件 executor 闭包(web_search:计数+配额 error-as-value;fetch_page:assertPublicUrl(url+finalUrl)→livePage(20s)→snapshotFrom 逐字段→investigation 事件(qid)→摘录 ≤6KB;read_snapshot:分页+频率上限);单问软顶=fetchQuota 改造(BudgetTracker 保留公平性);capped=executor 直置+问边界复核;计数节流 persistRun;任务卡六段(R1-5 ≤2KB);终局 parseJsonLoose 后验 {sufficient,note};RunResult failed→问 unanswered+limitation;问前 canSearch 预检保留;instruct drain 时点(问启动前);extract 批量后置(R1-4 callKey)+多问归属展开(R1-7 非 agent 路径不落 investigation);q.status 合成(sufficient&&claims>0→answered 等)。

## Acceptance criteria
- [ ] 共享假件 e2e:agent 轮次→快照落盘→extract→analyze 全链绿
- [ ] C4 对拍:同 URL 双问各自 attach 主张键展开;regather 前旧证据清理复现
- [ ] 配额=1 夹具:executor 错误值→模型收束 sufficient:false,run 不死(先红:抛错版杀整问)

## Blocked by
T1

---

## 3. T3 调查流 API + 夹具换代

## What to build
GET /runs/:runId/investigation?since= 端点(≤500 增量);recording/replay 增 "agent" 形状(R1-3:有序回合脚本驱动真循环+真 executor);golden 重录(合成 transport 脚本);15 文件三档处置(R1-8 清单:重写 runResearch/golden/gatherBudget;接共享假件 ×10;存活 ×5 各自加用例)。

## Acceptance criteria
- [ ] record→replay 全链再生(快照/investigation/extract)
- [ ] 全仓测试绿(基线换代后总数记录)

## Blocked by
T2

---

## 4. T4 UI 调查流视图

## What to build
GatherView 主区时间线(R1-7/S1-S5+负例;since 增量轮询追加;状态徽+note;空态两分;用量条保留);projectDetail 接 investigation 拉取;ui types 扩。

## Acceptance criteria
- [ ] typecheck+build 过;UI 契约负例自查清单
- [ ] 假件 server 浏览器冒烟:时间线实时追加

## Blocked by
T3

---

## 5. T5 C5 补全 + 真实冒烟

## What to build
C5 后半(agent 终局后验 parse 全路径含失败兜底——若 T1/T2 已含则回归);真实双供应商:全自主调查一问到底,每问 fetch/turn 计数(KA5 判据:单问 fetch ≤50% 全局、输入 ≤80% 窗口),证据链抽查(快照/引句);UI 真实冒烟。

## Acceptance criteria
- [ ] 计数判据达标记录;证据链抽查通过
- [ ] UI 浏览器真实流截图式文字转录证据

## Blocked by
T4
