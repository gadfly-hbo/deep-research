# Red-Team:P2-3b 会话底座

**Verdict:Go(附 3 项强制修订 + 2 项设计钉)。** 拆批收窄成立,无 v1 级承载性证伪;两处必须修:KA1(锁是宿主代码非 runtime 原生)、KA2(store 实例生命周期自相矛盾)。

## Top Kill-Assumptions

1. **KA1 acquireWriter 方向搞反**:它是宿主必须实现的回调(types.d.ts:356-359;SDK 无锁实现助手),且每次会话操作含只读 inspect 都持 writer(pi-adapter.js:441-490,原生 open 修尾事务)——**自研 O_EXCL lockfile+pid 判死接管**(与 .server-lock 同机制复用),冒烟"重启后 inspect"第一步就打在陈锁接管上。必修。
2. **KA2 FileBudgetStore 实例生命周期矛盾**:"随 channelCache 单例"=多链/测试开出多实例写同一文件互相整文件覆盖;"重建 store 实例"=并发 in-flight lease 下旧实例 settle/新实例盘上重读→丢账。**唯一正确形态:按文件绝对路径进程级单例、进程内单 async 互斥串行全部 lease 变更、永不重建 store**(REBUILD_AFTER_CALLS 只重建 runtime 对象;10 万 FIFO 同时约束内存与文件,重建机制不再必要)。写放大:每次调用 3 次全文件 tmp+rename(index.js:255/313/401),长跑 MB 级文件×3——验证里量一次(仿 measure-snapshot-writes 先例)。
3. **KA3 CONFIGURATION_CHANGED 从"重启即丢"变"永久记忆"**:resume 最常见诱因(crash→换链→resume)从此永久 blocked。不豁免(标准依据)但必须:文案指明变化字段+出路(新 run 或回滚配置);宿主侧"任务迁移"出路(旧 taskId 封存→新 taskId 起账)至少文档;**plain/session taskId 命名空间必须隔离**(configurationId 摘要不同,index.js:17/218,同 taskId 混走两路径必撞)。
4. **KA4 冲突面从本批开始+预检竞窗**:swap-in 后 serve/CLI project run/backfill/probe 三方即刻并发写同一 model-budget.json(cli.ts:231,backfill-titles.mts:10 经 defaultDataDir);check-then-write 双启竞窗失效——**O_EXCL('wx') 原子创建+pid 判死接管**;插入点=**FileBudgetStore 打开处单一收口**(自动罩住脚本,而非 cli/server 入口)。gitignore 三处(dataSync 是 git add -- research-data 会收编一切):session/ 目录、model-budget.json、.server-lock——bindings.json 反悔不入 git,挪 session/ 随目录忽略(双机 append 冲突无意义)。
5. **KA5 校准**:SDK 对 idle 会话拒绝 followUp(pi-adapter.js:533-536)——追问机制=同会话新 prompt operation 或活跃期 steer;本批冒烟第二次操作按"同会话新 prompt op"设计,顺手对 idle 会话调 followUp 钉 INVALID_REQUEST;P2-5 措辞届时改。

## 开放问题裁决
1. 并发:路径级进程单例+async 互斥;跨进程=O_EXCL 预检 fail-closed+残余竞窗披露;测试独立 tmp dataDir。
2. 接管判定:process.kill(pid,0) 判存在(macOS 无 /proc);bootId=Date.now()-uptime*1000;ps -o lstart 对比±2s 容差;**含糊判活**(误判活=暂时 TASK_BUSY 可忍,误判死=双写者毁账)。
3. authorize:create/list/read/run/fork/update 放行+delete 拒绝,文档一句;cwd/directory 必须绝对路径(硬校验 pi-adapter.js:460-463)。
4. model-budget.json:dataDir 根(与 model-audit 同级);gitignore 落 research-data/.gitignore 三处一起。

## 设计钉(PRD 必补)
- reconcile 的 unknown 阻断只作用入参 open[](首跑 open=[] 先于 operationId 生成,一律 unknown=自杀死锁,pi-adapter.js:339/363)。
- bindings.json SDK 零读零校验,形状纯自定。
- BudgetStore 必须同时实现 claim+claimUncapped;uncapped lease 带 reserveModelUpTo(返回恰等入参)+settleModelUsage;snapshot 维持 reservedOutputTokens≤outputTokens 且非负(index.js:62-79 每步验);接管保留 usage 含未结算预留符合口径(AGENT-RUNTIME.md:71);claim 照抄 validateLimits(policy.js:4-16)。

## 拆分建议
不可再小:FileBudgetStore+锁+gitignore 是 session 硬前置且 swap-in 影响全部流量。可挪:装配+冒烟(建议保留——acquireWriter 自研/reconcile 先于 bind 且 open=[] 时序/JSONL 尾修复三意外当下暴露最便宜);容量紧张砍"真实 Provider 会话一次"为可选。

## Well-Reasoned
拆批收窄完整;"接管保留 usage 只清 owner"逐字段合 SDK 合同(budget.js:43-67);tmp+rename 崩溃窗口分析正确;四开放问题全问在实处。
