# P2-3b 任务切片(会话底座)

来源:`.flow/prd.md`(红队 3 强制修订+2 设计钉+GRILL R1-9 全并入)。切片自批准(auto):依赖链机械导出;纯基建批。

- [x] 1. T1(9af63b4) — 证据:13 条红队清单单测全绿(原子写/双实例零丢/死 owner 接管保 usage/存活拒/含糊判活/CONFIG 两级文案/snapshot 不变式/FIFO/残 tmp/锁双开);SDK 兼容:runText 经新 store succeeded+账目落盘+跨 run 累计
- [x] 2. T2(b0401d7) — 证据:5 条单测 5 连跑零抖动(双开恰一胜/死 owner 接管/同进程陈锁/存活拒绝/判活细则);偏离:bootId 容差 2s(严格相等自锁误判,实测抓到)
- [x] 3. T3(72bf993) — 证据:REBUILD 只置 runtime=null(store 持续);runText 经新 store 计量落盘用例绿;379 基线全绿零行为差异
- [x] 4. T4(4337f45) — 证据:5 条(冒烟 run×2 history 累积/idle followUp INVALID_REQUEST/陈锁接管重开 inspect+续跑/bindings 幂等+冲突/reconcile 四态);偏离:candidates 缺省显式报错(P2-5 接入);CONFIG 文案挂 detail 属性(RunResult 只透 reason)
- [x] 5. T5(fd2055d) — 证据:dataSync 冒烟(git status 口径)绿;rg 唯一 import 处;真实 research-data 零污染;404 全绿+tc0;真实 Provider 会话未跑(可选项,合成覆盖装配面,P2-5 接生产时补)

---

## 1. T1 FileBudgetStore

## What to build
`src/server/fileBudgetStore.ts`:R1-2 lease 方法矩阵(capped+uncapped 全面)/R1-5 路径级进程单例(Map<absPath>)/R1-4 O_EXCL 跨进程收口(锁在 store 打开处,mkdir -p 惰性)/R1-8 判活细则/CONFIG_CHANGED 文案(R1-3 两级)/10 万 FIFO/崩溃注入可读。research-data/.gitignore 三处。

## Acceptance criteria
- [ ] 红队单测清单全绿:原子写/双实例并发零丢更新/死 owner 接管保留 usage/存活拒绝/含糊判活/CONFIG 文案含字段+出路/snapshot 不变式/FIFO/残 tmp 重开/锁双开恰一胜
- [ ] SDK 合同兼容:与 piRuntime 假 transport 跑一条 runText 全链不 STATE_FAILED

## Blocked by
None(T2 与 T1 同文件系统机制,可同实现者并行)

---

## 2. T2 锁共享件

## What to build
O_EXCL lockfile+pid 判死接管+同进程 holder 登记(R1-4),独立小模块供 T1 store 锁/T4 acquireWriter 复用;ps lstart 解析(R1-8:trim/new Date/失败判活/self 短路)。

## Acceptance criteria
- [ ] 单测:双开恰一胜/陈锁接管(spawn 短命进程)/同进程自锁死修复/release 异常后可再入

## Blocked by
None

---

## 3. T3 piRuntime 接线

## What to build
createMemoryBudgetStore→FileBudgetStore(R1-5 推导式;cacheKey 含 auditPath;测试传 auditPath 即隔离);REBUILD 只置 runtime=null(store 持续);DR_DEBUG 带账本路径。

## Acceptance criteria
- [ ] 全仓 379 基线绿(store swap 无行为差异);并发/超时/降级桶 piRuntime 测试原样过

## Blocked by
T1

---

## 4. T4 SessionRuntime 装配

## What to build
`src/server/sessionRuntime.ts`(唯一 import createSessionRuntime 处):R1-6 工厂 `createProjectSessionRuntime({projectDir,candidates?,auditPath?})`;storage.directory=join(projectDir,"session");acquireWriter=T2 锁;bindOperation/reconcile 按 R1-7(bindings.json 唯一核账源,冲突 reject);authorize 放行+delete 拒绝;audit 复用 makeAuditSink。

## Acceptance criteria
- [ ] 冒烟(合成 transport):create→run(prompt op ×2,history 断言累积)→idle followUp INVALID_REQUEST→陈锁接管重开→inspect+reconcile ready
- [ ] bindings 冲突 reject 幂等两条单测

## Blocked by
T1+T2

---

## 5. T5 冒烟套件+验收

## What to build
dataSync 冒烟(R1-9 口径:git status 断言);真实 Provider 会话一次(可选);全仓 npm test+typecheck;`rg` 验收(唯一 import 处/gitignore 三处)。

## Acceptance criteria
- [ ] dataSync 后 git status --porcelain -- research-data 为空,三类文件磁盘 untracked
- [ ] 全仓绿;真实会话(若跑)记录
