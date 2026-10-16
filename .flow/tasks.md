# P2-5 任务切片(追问会话化)

来源:`.flow/prd.md`(红队 R1-R4+GRILL R1-8 全并入;UI 已批准)。切片自批准(auto);子代理配额受限,主代理内联实施。

- [x] 1. T1(a407e0b) — RunOptions.onRunComplete(finishRun 三出口统一)+sessionDigests(【既往研究纪要】段含权威分层句);tc+core 99 绿
- [x] 2. T2(a407e0b) — buildRunDigest 四态 800B/writeSessionDigest(惰性+首次真实 run)/resolveSessionCandidates(降级 null)/readSessionDigests(tail K)/sessionTaskId
- [x] 3. T3(2ce7cb1) — POST /runs/followup(基准定位/增量校验/免 plan 起跑+sessionDigests);Ctx 增 onRunComplete/sessionRuntime;serve+CLI project run 候选链注入;守卫 inline 复用 withProjectLock
- [x] 4. T4(925d54b) — startRun 增量分支走 followup 端点;PlanGateCard followupCount prop+延续研究徽章;build 过
- [x] 5. T5(53d912e) — 408 全绿(+4:摘要模板四态/update 零模型+首次恰 1 次 run/tail K/候选降级/followup e2e 404-409-200-双门-完成);真实冒烟:基准 run 完成→会话惰性建+**首次真实 session run 全链**(bindings sess:first:a42cf3aa+transcript 14 行含初始化纪要)→followup 200→双门确认→gather(derivedFromRunId)→review 补采轮运行中

---

## 1. T1 编排器挂钩

RunOptions 增 `onRunComplete?(result, dir)`(编排器终态 persistRun 后调用,catch 不阻塞)+ `sessionDigests?: string[]`(任务卡【既往研究纪要】段,K≤3,置于【已答问题】后;含"以基准为准"裁决句)。

## 2. T2 会话记忆模块(sessionRuntime.ts 扩展)

- `buildRunDigest(result): string`(R1-8 模板,800B 硬顶)
- `writeSessionDigest({projectDir,candidates,auditPath}, result)`:会话惰性(缺失 create+**首次真实 run()** 一条);update 追加;写失败 catch
- `resolveSessionCandidates(config)`:config.model 链→resolveModelConfig+transportFor(piRuntime 导出);零可用→null(降级零纪要)
- `readSessionDigests(projectDir, K=3)`:history() tail 读
- `sessionTaskId(...)` 收口 sess: 前缀

## 3. T3 followup 端点

- routes: `assertNoActiveRun(ctx,id)` 共享守卫(三处调用);POST /runs/followup(基准定位/校验→request 构造→免 plan 起跑复用+sessionDigests 注入);serve makeAdapters 注入 onRunComplete(候选链解析);fault.detail 透出点。

## 4. T4 UI + CLI

- PlanView 表单提交:有基准时 POST /runs/followup(baseRunId);确认卡徽章(N=derivedFromRunId 计数);CLI project run 注入 onRunComplete。

## 5. T5 测试+冒烟

- 单测:摘要模板/守卫三处/followup e2e(免 plan→双门→纪要段进任务卡)/旧项目惰性/降级零纪要/首次真实 run 计数(合成恰 1 次模型)
- 全仓绿;真实冒烟:完整追问 run + 会话摘要落盘 + 追问任务卡含纪要
