# 提案:P2-3b 会话底座 —— SessionRuntime 装配 + 持久账本(租约接管)+ 项目会话

> 来源:docs/PLAN-AGENTIZATION.md P2-3b 行(P2-3 拆批时用户裁决收窄)。前置:P2-1/2(piRuntime uncapped+计量)、P2-4(plain runAgent 已实证可用,会话仅 P2-5 需要)。
> 规格:AGENT-RUNTIME.md P4/P5 + NATIVE-SESSION-CANDIDATE.md + RELEASE-v0.4.md;P2-3 v1 红队 KA3-KA5(.flow/archive/2026-10-15-p2-3-confirm-gates/red-team-v1-killed-p23.md)为设计输入。

## 背景与现状事实

- P2-4 落地后:全部模型流量走 plain createRuntime(无会话、无状态);budget 用内存 store(P2-1 决策:名义账本,Map 只增不减靠 10 万次重建清理);审计 workspace 级 jsonl;steer/followUp/压缩均不可用(需 SessionRuntime)。
- P2-5(追问会话化)是会话的第一消费者:followUp 替代增量新 run、同会话上下文连续、steer 落地。
- runtime 0.4.3 会话合同(已核):createSessionRuntime 必需 budgets(持久)+storage(专属目录/policyVersion/authorize/acquireWriter 跨进程独占)+bindOperation(accept 前持久确认,幂等)+reconcile(每次推进核账,unknown/denied 阻断);会话路径=全历史+单 busy(extract/stage/逐问 agent 必须维持无状态——P2-3 v1 KA1 裁决不变)。
- P2-3 v1 红队三前置(本批必答):
  - **KA3 持久账本租约接管**:claim 后进程死→同 taskId 永久 TASK_BUSY(resume 复用同 callKey 首当其冲);BudgetStore 无租约过期协议——需 owner 进程纪元(pid+启动时点),接管保留 usage 只清 owner;CONFIGURATION_CHANGED(重启后候选链变化)需 resume 豁免或披露;条目增长需上限。
  - **KA4 CLI/serve 同机 writer 冲突**:cli.ts 独立进程跑 runOnProject 与 serve 共用 research-data,两进程抢 acquireWriter 硬错——需 fail-closed 可读文案而非裸异常;bindOperation 落 audit.jsonl 每次推进扫尾 O(file)——绑定独立小文件。
  - **KA5 会话 JSONL gitignore + 披露**:会话文件最坏几十 MB/run,进 git 双机翻倍+rebase 必撞;gitignore 后"崩溃恢复"收窄为**原机 serve 重启恢复**,跨机不续会话(披露)。

## 本批内容

### 1 持久 FileBudgetStore(独立可测模块 `src/server/fileBudgetStore.ts`)

- 实现 BudgetStore(claimUncapped 原子):文件=dataDir/model-budget.json;写=临时文件+rename 原子;**租约 owner 记 `{pid, bootId}`**(bootId=进程启动时间戳);claim 遇已有 owner 且 owner 进程已死(pid 不存在或 bootId 不匹配)→**接管**:保留该 task 累计 usage,清 owner,新 owner 写入(标准 P4"未知保留"——usage 不清零,只解锁准入);owner 存活→TASK_BUSY 如常。
- 条目上限 10 万(FIFO 剪最老已释放条目,与内存版重建阈值一致);崩溃窗口:写一半的临时文件不参与(rename 原子),重开以旧文件为准(最多丢最后一条 write-off,披露)。
- **CONFIGURATION_CHANGED resume 披露**:同 taskId 重启后候选链变化(如 env key 变)仍拒绝(合同),错误文案升级为可读(指明哪个字段变化+如何处理);不豁免(标准:同任务改配置必须拒绝)。
- piRuntime 的 createMemoryBudgetStore 替换为本实现(单例随 channelCache;调用计数重建改为重建 store 实例但**文件保留**——usage 历史跨重建持续,P2-6 动态预算的计量基础)。

### 2 SessionRuntime 装配(`src/server/sessionRuntime.ts` 新模块,唯一 import createSessionRuntime 处)

- **storage**:目录=dataDir/projects/<id>/session/(项目=会话,惰性创建——首个需要会话的操作时;policyVersion="p2-3b");authorize=项目内读写全放行(本机单用户),delete 拒绝(保留策略);acquireWriter=runtime 原生跨进程锁(fail-closed)。
- **bindOperation**:绑定落 `dataDir/projects/<id>/session/bindings.json`(独立小文件,KA4;追加+按 operationId 去重,幂等)。
- **reconcile**:核账源=run 记录(fsStore)+预算账本(§1)+绑定文件;返回 ready/unknown/denied——unknown(无 run 记录的 operation)阻断并披露。
- **budgets**:§1 的 FileBudgetStore(同实例)。
- **消费者暂无**(P2-5 接入 followUp/steer)——本批交付装配+冒烟(创建会话/写一条 run 文本/重启核账),**不让任何生产流量走会话**(P2-3 v1 KA1 约束:全历史+单 busy)。

### 3 CLI/serve 冲突 UX + 披露

- cli.ts runOnProject 入口与 serve 的会话锁冲突时(本批会话无生产流量,实际冲突面=P2-5 起;本批先落**文件锁预检**:serve 启动与 CLI run 启动各写 dataDir/.server-lock(pid);检测到对方存活→可读错误(指明对方 pid 与处理方式)而非裸异常。锁文件 gitignore。
- 披露三处(PLAN/handoff/启动脚本注释):会话目录 gitignore(跨机不续会话,崩溃恢复=原机重启恢复);model-budget.json 本机文件(gitignore);绑定文件随项目走 git(小,无冲突面)。

### 4 验证

- FileBudgetStore 单测:原子写/租约接管(伪造死 owner)/owner 存活拒绝/上限 FIFO/usage 跨实例持续;崩溃注入(留半写临时文件)重开可读。
- sessionRuntime 装配冒烟:临时目录创建会话→runText(会话内一次)→重启 serve 同目录→inspect 历史+reconcile ready;(不接生产)。
- 全仓 npm test+typecheck;真实 Provider 会话一次(冒烟)。

## 明确不在本批

P2-5 全部(followUp/steer/压缩/调查流跨机);生产流量迁移到会话;跨机会话;P2-6 动态预算(本批只备计量基础)。

## 开放问题(红队/GRILL)

1. FileBudgetStore 的并发:同进程多 channel(测试)与多 serve 实例(测试)同 dataDir——文件锁或进程内互斥表?
2. 接管判定"进程已死":pid 复用风险(pid+bootId 足够?bootId 怎么取——process 启动时间从 /proc 不跨平台,macOS 用 sysctl?或简单 pid 存在性检查+启动时点文件戳)。
3. 会话 storage.authorize 全放行是否需收紧(delete 拒绝已提,read/write/list 呢——本机单用户+目录隔离,推荐全放行+文档)。
4. model-budget.json 放 dataDir 根还是 projects/ 旁(当前审计在 dataDir 根——一致性)。
