# Red-Team:P2-4 采证 agent 化(plain runAgent 逐问全自主)

**Verdict:Go(条件式)**——C1-C5 入 PRD 后放行;C1/C2 无解则回炉。两条核心机理经 dist 逐行实证为真:plain runAgent 有工具循环无会话(index.js:439,pi-adapter.js:176-183);并发隔离成立(每 run 独立 MemorySessionRepo pi-adapter.js:186,272;busy 只在会话后端;lease 按 taskId)。无 kill 级证伪。

## Top Kill-Assumptions(全部转准入条件)

1. **KA1 executor 抛错杀整问**:配额尽/墙钟超时抛错→TOOL_FAILED 终止整问,模型无法收敛 sufficient:false;工具超时(30s)==livePage 抓取超时(30s)竞速→单次慢抓=整问报废(现状慢站仅跳过);工具结果>1MiB 硬失败。**修法(C1)**:executor error-as-value(返回 {error:"budget-exhausted"} 让模型自然收尾);executor 内部抓取超时压到 20s;编排器据自身 tracker 置 capped。
2. **KA2 maxParallel 问级并发摧毁 instruct 语义**:现状是问内抓取分块并发、问题串行;问级并发下 currentQuestion 单指针失义、skip 命中在飞问题被覆写静默丢失、UI"跳过当前问题"指向不明。**修法(C2,推荐)**:逐问串行 agent + toolExecution:'parallel'(问内工具并发);maxParallel 退役为兼容字段,提案表述改写。
3. **KA3 共享快照跨问归属**:同 URL 两问各抓→snap:${url} 全局唯一,主张键按 qid 展开;"批量 extract 归属单一 qid"会丢另一问同源主张;regather 前 ev:${qid}: 清理须复现;extract 计量点迁移。**修法(C4)**:investigation 事件记 qid→fetch 映射,attach 按"抓取过它的每个问"展开;golden 对拍(双问同 URL+regather)。
4. **KA4 SSRF 面**:gather 现状零 URL 边界(assertPublicUrl 只挂 library 路径);agent 形态 URL 由模型选择可被注入引导,authorize 全放行→内网/metadata 可达且进证据链。**修法(C3)**:fetch_page executor 硬性接入 assertPublicUrl(url)+assertPublicUrl(finalUrl)(复用 assetService:81 现成实现)。
5. **KA5 单问失控**:plain runAgent 无 maxTurns(终局唯一=模型不再调工具)、compaction 默认关、uncapped 无累计墙钟;mimo 128k 窗口反复读取→溢出整问死;现状 fetchQuota 按问均分保证 analyze/review 补证轮有预算——只剩全局配额则首问吃光。**修法**:executor 侧单问软顶(error-as-value)+read_snapshot 分页/频率上限+摘录 ≤4-8KB/页(按最紧窗口 mimo 128k 设计);fetchQuota 按问公平性保留改造。

## 裁决

- **steer 偏离:批准**(steer 硬依赖 P2-3b 四项前置;P2-3 v1 KA2 先例适用;plain 形态无废弃工作,调查流数据/事件侧车全部延续)。
- 开放问题:② runAgent **无 validator 挂点**(AgentRequest 无 validate;convert 恒等)——"宿主验收"=编排器拿到 RunResult.value 后 parseJsonLoose,失败按 sufficient:false+limitation 兜底;③ seq 即游标够用,事件必须带 qid,executor 追加 try/catch 吞错(否则追加失败=TOOL_FAILED);④ 三层截断(摘录/分页频率/单问累计软顶),按 mimo 128k 设计;⑤ 实测 15 个测试文件触及 gather(~3.5k 行),比提案大五成;fetchQuota 若保留公平性可改造存活;golden 重录用合成 transport 脚本;⑥ UI 无原型不可评,UI-GATE 必停,"跳过当前问题"去留与 KA2 同源。

## 准入条件(入 PRD)

- **C1** 停止语义(error-as-value + 超时层次重整 + capped)
- **C2** 并发形态二选一(推荐逐问串行+toolExecution:'parallel')
- **C3** fetch_page 硬性 assertPublicUrl(直接+finalUrl)
- **C4** 证据归属规则 + golden 对拍通过
- **C5** 新增并发 runAgent 零互撞测试 + agent 终局后验 parse 测试

## What's Well-Reasoned
plain runAgent 机理全属实(诚实标注 P2-1(b) 只测 runText,runAgent+工具全仓零测试,C5 补);extract 维持无状态正确;调查流数据形状合理(配额封顶→数百事件/run,百 KB 级,侧车无耦合);夹具可录制(INTEGRATION 明示无副作用夹具工具路径)。

## 无法评估
真实模型自判 sufficient 质量与轮数分布(冒烟判据);调查流 UI 共存布局(原型未出);P2-3b 延后工期;审计增长倍率(轮转已有)。
