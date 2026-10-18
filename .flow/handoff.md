# E1 交接卡:嵌入式外部研究能力库(2026-10-18)

> 前序:提案 `docs/embedded-research-capability-proposal.md`@`4499762`(§8 按推荐)+ 用户批准 → dev-flow E1(commit `a75a247`)。

## 本批交付

- **核心加法(三触点)**:`RunOptions.onGatherProgress`——gather 每问收束切片回调(questions/claimQuestions/claims/evidence/snapshots/limitations/unresolved;纯被动,resume/清扫零影响)。
- **能力库** `src/capability/`:`createResearchCapability({adapters, dataDir, library?, projectId?, maxConcurrentJobs=2})` → `{submit, status, result, cancel}`;每 job 一个内部 run(plan=questions、stopAfter gather);`assembleFindings` 单一装配两路共用(checkpoint.claimQuestions 主路径;取消=快照+verifyCitations 现算);终态同步落 job.json(跨重启可读);幂等含 failed 不重跑;FIFO 并发上限;档位×问数联动(low≤2/medium≤4/high≤6,显式 budget 免);目录硬隔离(capability-jobs 永不落 projects 路径,server 清扫/列表不触及);取消=cancelled 独立终态+已完成问 claims 级保留。
- **情报库开关**:library+projectId 注入即沉淀(采证时刻;取消时已抓已入库);module 中性防回归断言。

## 验证状态

- 454/454(74 文件,441 既有+13 新)+ typecheck + build;两拍一致;评审 PASS(0 blocking)。
- 无真实 Provider 用例(提案出界;合成驱动覆盖行为面)。

## 遗留更新(2026-10-18 F 批清尾)

1. ~~F1 自愈清扫~~ **已清**(commit 见下):装配时扫描 jobRoot,submitted/running 孤儿标 failed(「进程中断,可换幂等键重新提交」);终态不动;装配约定=同 dataDir 单活跃实例(文档化)。
2. ~~F2 前置段加固~~ **已清**:runJob 前置段入 try,catch 内落盘二次守护(不再有 unhandled rejection 路径);validate 增 tier 枚举白名单(submit 期报错)。~~F3 幂等窗口~~ 顺手文档化(jsdoc:窗口=进程生命周期)。
3. ~~F4~~ **已清**:路径校验段匹配大小写不敏感 + dataDir 已存在时 realpathSync 解析符号链接(测试:Projects 大写/alias→projects 均拒绝,普通目录不受影响)。~~F5~~ **已清**:verified 细分为五值联合(quote-hit/mismatch/snapshot-missing/unverified/no-evidence,缺失比 mismatch 严重单独口径);展示 quote/source 取首条命中证据,与聚合判定对齐(findings.test.ts 3 用例钉死)。
4. 仅存:测试夹具第 4 份出现时抽 src/capability/testing.ts;F5 的 FindingClaim.verified 已顺带改为字面量联合(T-2 一并清)。

## 对 JuanerAI 侧的输入(阶段 1 交接时用)

- 库入口:`src/capability/researchCapability.ts`(Port 签名/取消时延披露/幂等窗口见文件头 jsdoc)。
- 装配:adapters 由宿主构造(piRuntimeModel(configs,{authorize,dataDir}) + live 搜索/抓取/解析);dataDir 必须独立于任何 projects 路径。
- 身份锚点:本批 commit `a75a247`;固定交付物料(T4)另批。
- 上游提案勘误待记:libraryReuse 字段为空开关(绑定机制未建);asOf 未承接(PRD 收敛)。

## 下一批前置

- 工作区仅剩 research-data 运行数据;无代码 WIP。
- 阶段 1(接入说明文档落 docs/)待用户指示;阶段 2(JuanerAI 仓接线)归宿主工程 agent。
