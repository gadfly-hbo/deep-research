# E1 Tasks:嵌入式外部研究能力库

> 来源:`.flow/prd.md`(D1-D10 + G1-1~G1-6)。无 issue tracker,降级本文件。依赖:T1→T2→T3。

- [x] 1. T1 核心加法:onGatherProgress 回调(三触点)

> 勾选证据 T1:gatherProgress.test.ts 2/2 绿(两问两次触发/claimQuestions 归组闭合/切片防串改/不传回调零影响);全量 443/443。红阶段以最终断言形态落地(选项字段 runtime 忽略即红,未单独跑红,如实记录)。
- [x] 2. T2 能力库本体:Port/job 管理器/装配/持久化

> 勾选证据 T2:researchCapability.test.ts 7/7 绿(happy 归组+溯源/scopeNote 并入/limited 部分/取消保留 claims+排队取消/幂等含 failed/并发排队/目录隔离+server 不触及+跨重启/装配校验);450/450+typecheck。
- [x] 3. T3 情报库沉淀开关 + 防回归断言

> 勾选证据 T3:librarySwitch.test.ts 4/4 绿(沉淀入库/取消时已抓已入库/无库零影响/module 中性断言);454/454+typecheck+build。

---

## 1. T1 核心加法:onGatherProgress 回调

### What to build

`RunOptions` 增可选 `onGatherProgress?: (snapshot: GatherProgressSnapshot) => void`;`GatherContext` 增函数字段;`runResearch` 装配 wiring;`gatherDomain` 每问收束点(q.status 合成后、persistRun 处)调用,快照 = state 可序列化浅切片 `{questions, claimQuestions, claims, evidence, snapshots, limitations, unresolved}`。纯被动:不落 checkpoint、不进 run 记录,resume/清扫零影响。

### Acceptance criteria

- [ ] 回调每问触发一次,末次快照含全部已完成问的 claimQuestions/claims(evidence/snapshots 引用共享不深拷)
- [ ] 快照含 limitations/unresolved(G1-1);skipped/starved/通道不支持路径不触发(无害)
- [ ] 不传回调 → 行为与现状逐位一致(既有测试零改动全绿)

### Blocked by

None - can start immediately

---

## 2. T2 能力库本体

### What to build

`src/capability/researchCapability.ts`(Port/job 管理器)+ `src/capability/findings.ts`(assembleFindings 纯函数,单一装配路径两路适配)。submit 校验(questions 1-6、qid 非空唯一、tier×问数联动仅 tier-only、scopeNote 并入问题文本、幂等键→既有 jobId 含 failed 不重跑);job 目录 `cap-<ts36>-<rand>` 于 `<dataDir>/capability-jobs/`(装配期校验非 */projects 路径);FIFO 排队+maxConcurrentJobs 信号量;每 job 一个内部 run(plan=questions、stopAfter gather、signal、request.id=`cap:${jobId}`、goal 合成有信息量);终态处理:published→completed / limited→limited(bundle+gather checkpoint 装配)/ cancelled→cancelled(最新快照+verifyCitations 现算装配)/ failed→failed;**装配结果+usage 同步落 job.json,result() 以 job 记录为源(跨重启可读)**;cancel:排队中即时终态、运行中 abort(jsdoc 披露问边界生效与在途问题完整跑完)。

### Acceptance criteria

- [ ] happy 2 问→completed:findings 按 claimQuestions 归组、claims 带引句/来源(tier/fetchedAt)/verified、usage 返回
- [ ] 预算尽→limited+部分 findings+unanswered 如实;取消→cancelled+已完成问 claims 级 findings+取消 limitation(含 0 问完成边界)
- [ ] 幂等键同 jobId(含 failed);重试换键新 job
- [ ] maxConcurrentJobs=2 三 job→第三排队后起步;排队 cancel 即时终态
- [ ] 坏输入(0 问/7 问/low×3 问/重复 qid)拒绝且不产生 jobId;显式 budget 免联动
- [ ] 目录隔离:cap- 前缀、capability-jobs 与 projects 兄弟、server 启动清扫与 GET /api/projects 均不触及(测试钉死)
- [ ] result() 跨"重启"(新 capability 实例同 dataDir)可读终态结果
- [ ] 既有测试零改动全绿

### Blocked by

- T1(onGatherProgress)

---

## 3. T3 情报库沉淀开关 + 防回归断言

### What to build

opts.library?: LibraryStore + opts.projectId?: string 透传 runResearch(注入即沉淀,采证时刻;取消时已抓快照已入库);**注入 library 必须 projectId(装配期校验)**;不注入零影响。module 中性防回归断言:brand/industry 两 config 的 preferredDomains 均空。

### Acceptance criteria

- [ ] 注入 library+projectId:job 完成后 acquisitions/sources 有沉淀;取消后已抓快照已入库
- [ ] library 无 projectId → 装配抛错;无 library → 无沉淀无错
- [ ] 两 module config preferredDomains 空(断言进测试,未来加域偏好即红)
- [ ] 既有测试零改动全绿

### Blocked by

- T2
