# P2-3b PRD:会话底座 —— 持久账本(租约接管)+ SessionRuntime 装配 + 冲突收口

> 规格源:`.flow/proposal.md` + 红队 Go 附 3 强制修订+2 设计钉+4 裁决(全部并入)。无 issue tracker。

## Problem Statement

P2-5(追问会话化)需要 SessionRuntime,其合同硬前置为持久 BudgetStore+storage/acquireWriter+bindOperation+reconcile;现状内存账本重启即丢、无会话、CLI/serve/脚本三方即将并发写共享账本文件。

## Solution

交付三件:持久 FileBudgetStore(租约接管协议,替换内存版);SessionRuntime 装配模块(含自研 acquireWriter 与绑定文件,冒烟验证不接生产流量);并发冲突收口(O_EXCL 锁+gitignore 三处)。

## Implementation Decisions

### D1 FileBudgetStore(`src/server/fileBudgetStore.ts`)

- **位置**:dataDir 根 `model-budget.json`;**路径级进程单例**(模块级 Map<absPath,store>,进程内单 async 互斥串行全部 lease 变更;**永不重建实例**——piRuntime 的 REBUILD_AFTER_CALLS 只重建 runtime 对象,store 与文件跨重建持续);测试各自独立 tmp dataDir。
- **文件格式**:`{version:1, tasks:{[taskId]:{configuration,limits,usage,owner?}}}`;写=同目录 tmp+rename 原子;读=启动懒加载+每写前以内存为准(单互斥下无竞态);10 万条 FIFO(剪最老已释放)。
- **租约接管**:owner=`{pid,bootId,acquiredAt}`;bootId=`Date.now()-process.uptime()*1000`;接管判定=process.kill(pid,0) 不存在 **或** 存在但 `ps -o lstart=` 与记录启动时刻差>2s(含糊判活:判不准按活,TASK_BUSY 可忍;误判死=双写者不可忍);接管保留 usage(含未结算预留,合 AGENT-RUNTIME.md:71)只清 owner。
- **合同完整面**:同时实现 `claim`(有限)与 `claimUncapped`;validateLimits 照抄(policy.js);uncapped lease 带 reserveModelUpTo(**返回值必须恰等入参**)与 settleModelUsage;snapshot 维持 reservedOutputTokens≤outputTokens 且非负;release 加 activeMs 清 owner。
- **CONFIGURATION_CHANGED**(KA3):拒绝如常(标准),错误文案指明变化字段与两条出路(回滚配置 resume/新 run 续作);文档记录宿主侧任务迁移路径(旧 taskId 封存→新 taskId,实现留 P2-6);**plain/session taskId 命名空间隔离**:session 侧用 `sess:` 前缀(plain 维持 `dr:`)。
- **冲突收口**(KA4):store 打开处即做**跨进程预检**——O_EXCL 创建 `<dataDir>/.model-budget-lock`(内容 pid+bootId;已存在→判死接管/判活→可读错误"另一进程(pid)正在使用本数据目录的预算账本;确认其退出后重试或删除陈锁文件");该收口自动罩住 serve/CLI/脚本三方。gitignore 三处落 research-data/.gitignore:`session/`、`model-budget.json`、`.model-budget-lock`。

### D2 SessionRuntime 装配(`src/server/sessionRuntime.ts`)

- createSessionRuntime 必需输入:storage={directory:绝对路径 `<dataDir>/projects/<id>/session/`,cwd:绝对,cwd=process.cwd(),policyVersion:"p2-3b",authorize:create/list/read/run/fork/update 放行+delete 拒绝,acquireWriter=**自研 O_EXCL 会话锁**(同 D1 机制,锁文件 session/.writer-lock;判死接管)};budgets=D1 单例;bindOperation=追加写 `session/bindings.json`({operationId,taskId,purpose,at}[],按 operationId 去重幂等;**挪进 session/ 随目录 gitignore**——不入 git);reconcile=核 bindings+run 记录,**unknown 只对入参 open[] 条目生效**(设计钉:首跑 open=[] 全 ready)。
- **消费边界**:本批零生产流量走会话;导出装配工厂供 P2-5;冒烟按 §4。
- 会话目录惰性创建(首个操作时);**binds/session 全 gitignore(KA5 裁决:跨机不续会话,崩溃恢复=原机 serve 重启恢复——三处披露:PLAN/handoff/启动脚本注释)**。

### D3 piRuntime 接线

- createMemoryBudgetStore → FileBudgetStore(单例注入;channelCache 值加 store 实例);REBUILD 逻辑改为仅置 runtime=null(store 不动);DR_DEBUG 日志带账本路径。
- 真值表/三分映射/limits/审计零改动。

## Testing Decisions

FileBudgetStore 单测:原子写回读/双实例同文件并发 claim-reserve-settle 断言零丢更新(路径单例下应串行)/接管(伪造死 owner pid+过期 bootId→接管保留 usage)/owner 存活拒绝/判活含糊(ps 容差)/CONFIG_CHANGED 文案含字段+出路/snapshot 不变式/10 万 FIFO/崩溃注入(残 tmp 文件重开可读)。锁:并发双 O_EXCL 恰一胜/陈锁接管。
sessionRuntime 冒烟(合成 transport):create→runText(会话新 prompt op 两次,断言 transcript 累积)→**对 idle 会话调 control.followUp 断言 INVALID_REQUEST**(KA5 钉死认知)→关进程重开同目录→inspect 历史+reconcile ready(陈锁接管路径)。
全仓 npm test+typecheck;真实 Provider 会话一次(可选,合成已覆盖装配面);**dataSync 冒烟**:起 run 后跑 dataSync,断言 git status 无 session/锁/账本三类新文件(KA4)。

## Out of Scope

P2-5 全部(followUp 产品语义/steer/压缩/调查流跨机);生产流量迁移会话;跨机会话;P2-6 动态预算与任务迁移实现;写放大优化的实测阈值(记录量级即可)。

---

## PRD diff gate(auto)

相对 proposal:全部为红队强制修订/设计钉/裁决并入,无 change/drop——
1. 勘误:acquireWriter 从"runtime 原生"改自研 O_EXCL(KA1);store 实例从"随 channelCache/可重建"改路径级单例永不重建(KA2);冲突面从"P2-5 起"改"本批起"且收口点改 store 打开处(KA4);bindings.json 从"随项目走 git"改 session/ 内忽略(KA4 反悔)。
2. 并入:CONFIG_CHANGED 出路+命名空间隔离(KA3);followUp 校准与 idle 钉死测试(KA5);reconcile open[] 语义/claim 双实现等设计钉;ps lstart 接管判定。

---

## GRILL 第 1 轮决议(author-blind 子代理,9 包全部采纳)

1. **R1-1 冒烟 API 修正(答错)**:会话内跑 `sessionRuntime.run({sessionId, taskId, prompt, limits, tools: []})` 两次(operation=prompt 缺省),transcript 断言走 `history(sessionId)`;runText 不进会话(无 sessionId 走无状态 drive)。
2. **R1-2 lease 合同矩阵(补全)**:owner=`{runId,pid,bootId,acquiredAt}`(assertOwner 比 runId,接管只在 claim 时);方法矩阵——capped:snapshot(不验 owner)/reserveModel/reserveModelUpTo(min 剩余,可 BUDGET_EXHAUSTED)/settleModel/reserveTool/release;uncapped:同面+settleModelUsage、reserveModelUpTo **恰等入参**、reserveModel() 抛 INVALID_REQUEST;全方法(除 snapshot)assertOwner;uncapped 条目 usage 落盘必含 inputTokens/reservedOutputTokens;claim 时序=validateLimits→CONFIG_CHANGED→接管判定(替换 TASK_BUSY 分支)→wallTime。
3. **R1-3 CONFIG_CHANGED 文案降级(答错)**:configuration 是 sha256 摘要拿不到原像——limits(结构化入参)落盘旧值逐字段点名;其余报"任务配置指纹变化(候选链/工具/模型/会话策略任一)";出路文案不变。
4. **R1-4 同进程陈锁语义**:锁实现加进程内 holder 登记(Map<lockPath,token>)——O_EXCL 失败且锁内 pid==self&&bootId==self&&本进程登记空→陈锁接管(修复 release 异常自锁死);冒烟伪造死 owner 锁(spawn 短命子进程取 pid 等退出);惰性创建=acquireWriter/store 打开处先 mkdir -p;接管=unlink 后重试 O_EXCL(竞态恰一胜)。
5. **R1-5 store 路径推导**:storeDataDir=dirname(opts.auditPath ?? join(defaultDataDir(),"model-audit.jsonl"))——与审计同源;cacheKey 已含 auditPath;凡触账本测试必须显式传 auditPath;披露 --datadir 不改账本/审计位置(与 config.json 一致)。
6. **R1-6 工厂签名**:`createProjectSessionRuntime({projectDir, candidates?, auditPath?})`;storage.directory=join(projectDir,"session")(随项目目录自洽 --project 任意路径);RuntimeOptions.authorize=async()=>true(文档一句);audit 复用 makeAuditSink;limits 复用 buildLimits;cwd=process.cwd() 补一句(仅喂 JSONL repo,P2-5 接工具换工作区)。
7. **R1-7 bindings 读写语义(缺口)**:同 operationId 不同 taskId/purpose/sessionId/branch→reject(SDK 包 STATE_FAILED);一致→幂等;reconcile **唯一核账源=bindings.json**(删"run 记录"——join 键不存在):open[] 每条要求 operationId 匹配且 taskId/sessionId/branch 一致,缺失→unknown,不一致→denied。
8. **R1-8 ps lstart 细则**:输出 trim 后 new Date() 解析,NaN/异常/ps 失败**一律判活**;|lstart−bootId|>2000ms 才判死;pid==self&&bootId 匹配自身短路判活(免 spawn)。
9. **R1-9 dataSync 冒烟口径**:tmp git 仓+tmp research-data(三处 gitignore 在内)→auditPath=tmp 跑模型调用+session 冒烟→dataSync(tmpRoot)→断言 `git status --porcelain -- research-data` **为空**且三类文件磁盘存在 untracked(非磁盘断言)。

## GRILL 第 2 轮(主代理)

R1 后无新实质开放问题 → **收敛(2 轮)**。纯基建批无用户可见 UI → UI-GATE skipped → ISSUES。
