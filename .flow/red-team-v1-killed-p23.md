# Red-Team:P2-3 会话底座(提案 v1)

**Verdict:Kill(按当前文本)。** 一条承载性假设被 dist 代码直接证伪(runText 走会话语义不变),且结构性破坏 gather 并发;确认门偏离判断被证实(且证据更硬)。拆批+收窄"走会话"后可 Go。

## Top Kill-Assumptions

### KA1(致命)"runText 走会话,语义不变"——语义大变+并发撞死
- dist/index.js:17:带 sessionId 的 runText 进会话路径,与无状态路径二选一,无"挂账本但无状态"模式。
- dist/pi-adapter.js:374-409:会话路径每次调用 lane.accept(prompt)+drive,transport 收**整个 lane transcript**(全历史累积);无状态路径 prompt-only。
- 后果:(a) 上下文爆炸——extract 单条 ≤1MiB × 60 fetch + stage 大输入,累积超 mimo 128k 逼近 1M 窗口,且 input 计量按全历史计;compaction 未启用(默认关)。(b) **并发撞死**——createSessionBackend 单 busy 标志(pi-adapter.js:484-486)覆盖全部 session 操作;gather 4 路并发 extract 第 2 路起 TASK_BUSY→三分映射 throw→整 run 失败;跨项目/预览端点同样互撞。(c) stage 隔离输入被历史污染,golden/replay 口径全变。
- Cheapest test(30 分钟):fake transport + createSessionRuntime,同 sessionId 串行两发断言第二次含第一次 prompt;并发两发断言 TASK_BUSY。

### KA2 批次规模:层 1+层 2 一批超载,且两层无依赖
- 层 2 确认门=产品级 durable gate,对 SessionRuntime **零依赖**;层 2 所需崩溃恢复增量极小(awaiting-confirmation 不被启动清扫误杀,server.ts:74-84 只清 running)。改动面几无交集(projectsRuns.ts:315-328/runResearch.ts:389-418 vs piRuntime.ts 全通道)。
- **建议拆:2a=确认门翻转+清扫增量(先行,无 runtime 依赖);2b=会话底座(收窄)。**

### KA3 持久账本崩溃窗口:claim 后进程死→同 taskId 永久 TASK_BUSY,resume 首当其冲
- BudgetStore/lease 无租约接管/过期协议(types.d.ts:212-233);resume 复用同 request.id→同 callKey→同 taskId(runResearch.ts:89,349-351),崩溃后 resume→TASK_BUSY→blocked→throw——恢复路径最易被崩溃杀死。
- 次级:重启后候选链因缺 env key 变短→CONFIGURATION_CHANGED(budget.js:14-15);全文件重写无上限(10 万 taskId 级)。
- 必须补:租约 owner 进程纪元(pid+boot)接管(保留 usage 只清 owner);追加日志+压缩;resume 场景 CONFIGURATION_CHANGED 豁免/披露。

### KA4 acquireWriter:CLI 直跑与 serve 并存是同机现实场景
- cli.ts 独立进程跑 runOnProject 与 serve 共用 research-data;两进程抢 writer 硬错,不需要"双机"。
- 附:reconcile 每推进读回绑定(types.d.ts:486-495 宿主自查)——扫 50MB 审计尾每调用一次 O(file);建议绑定独立小文件 per session,审计只留事件。

### KA5 会话 JSONL × dataSync:gitignore 则"崩溃恢复"收窄为同机重启恢复
- 进 git:最坏几十 MB/run 双机翻倍+rebase 高频冲突;gitignore:跨机不续会话。可接受但承诺文案要按"原机 serve 重启恢复"写。

## 偏离升级点裁决:批准偏离(证据更硬)
- dist/index.js:167-170:非 agent 模式传 checkpoint 三件套→INVALID_REQUEST(runText 无暂停,证实);
- pi-adapter.js:667-672:**会话路径连 runAgent 也拒绝 checkpoint 三件套**;
- pi-adapter.js:781/787/796:shouldYield 只在 afterToolCall 求值,零工具单轮停——**无工具 runAgent 产生不了 waiting/BUSINESS_WAIT**;
- control.steer/nextRun:无活跃 run 时只允许 snapshot/cancelQueued(pi-adapter.js:534-536)——数小时后确认的场景无入口。
→ 产品级 durable gate 成立;P2-4 runAgent 化时自然接管成立。

## 开放问题裁决建议
1. gate 机制:产品级 durable gate,升级用户(四条实证)。
2. 账本作用域:**项目级**(workspace 级单文件 dataSync 必然冲突)。
3. taskId:**维持子 taskId**(收敛到 runId=单 lease→并发全撞);聚合按 keyBase 前缀;前提先解决 KA3 接管。
4. 会话 JSONL:**gitignore+披露跨机不续会话**。
5. UI:UI-GATE 必停,原型先行(确认页可编辑问题清单是新增交互面)。
6. 旧 run:**惰性建会话,不迁移**。

## What's Well-Reasoned
偏离分析方向与结论完全正确;目录选择与 fsStore/PROJECT_ID 体系一致;不在本批清单边界好;bindOperation 时序成立(bind 先于 accept,pi-adapter.js:374);恢复语义与 SDK reconcile 合同一致。

## 无法评估
Pi JSONL 尾事务修复细节;compaction 能否救"全调用走会话"(唯一救生索,须 probe);确认页 UI 形态;会话文件真实增速。

## operator 行动
1. 先跑 KA1 30 分钟 vitest(决定层 1 第 4 项重写还是删除);
2. 拆 2a(gate 翻转,无 runtime 依赖)/2b(会话底座,"走会话"降为"仅 P2-4/5 需要的调用点走会话、extract/stage 维持无状态"或以 compaction probe 为前提);
3. 2b PRD 必补:租约接管协议、绑定独立存储、CLI/serve 冲突 UX。
