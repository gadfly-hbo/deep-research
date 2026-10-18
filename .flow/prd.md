# E1 PRD:嵌入式外部研究能力库(T1 库本体 + T2 情报库开关)

> 规格源:`.flow/proposal.md` + `docs/embedded-research-capability-proposal.md`(§8 按推荐);红队 `.flow/red-team.md`(go 附 3 硬条件)。无 issue tracker,降级本文件。基线 main @ `4499762`。

## Problem Statement

分析报告需要外部信息(市场/行业/竞品/公开口径)时,分析流程要能按需调用深度研究:提交一组结构化研究问题,分钟级异步取回**带证据的可引用发现**(每问一组主张,逐字引句+来源分级+核查判定),有限交付如实披露。插件形态(完整工作台)不适用此场景——需要纯库形态:同一研究核心,无 UI/项目/版本/确认门。

## Solution

本仓新增 `src/capability/`:`createResearchCapability({adapters, dataDir, library?, projectId?, maxConcurrentJobs=2})` → `{submit, status, result, cancel}`。每 job 一个内部 run(options.plan=questions,stopAfter:"gather");findings 装配以 gather checkpoint 的 claimQuestions 为归组主路径;取消经加法式核心回调(RunOptions.onGatherProgress)保留 claims 级部分结果;job 记录落 `<dataDir>/capability-jobs/`(与用户 projects 硬隔离);情报库注入即沉淀(既有采证即沉淀路径)。

## User Stories

1. 作为分析流程开发者,我想提交问题清单拿 jobId、轮询取结果,所以分析管线不被分钟级研究阻塞。
2. 作为分析流程开发者,我想每个主张带引句/来源/分级/核查判定,所以报告能直接渲染引注、未核实内容显式标注。
3. 作为分析流程开发者,我想预算尽/取消时拿到已完成问题的部分发现(而非全损),所以长任务中途止损仍有产出。
4. 作为分析流程开发者,我想用幂等键防重复提交,所以重试不会烧双倍预算。
5. 作为分析流程开发者,我想凭据/授权/数据目录在装配处注入,所以研究 job 计入分析任务的授权与成本口径。
6. 作为维护者,我想核心只做加法改动、441+ 测试零回归,所以插件/独立版不受影响。
7. 作为后续分析任务,我想研究发现沉淀进情报库后可授权复用,所以同类问题不重复抓取。

## Implementation Decisions

- **D1(红队#1,取消合同——加法式核心回调)**:`RunOptions` 增可选 `onGatherProgress?: (snapshot: GatherProgressSnapshot) => void`,`gatherDomain` 每问收束点调用;snapshot = `{questions(含状态), claimQuestions, claims, evidence, snapshots}`(state 的可序列化切片,浅拷贝)。纯被动回调(不落 checkpoint、不进 run 记录)→ resume/清扫零影响。capability 持有最新 snapshot;**cancelled 独立终态**(修正上游/提案"取消→limited"矛盾):result 返回已完成问题的 claims 级 findings + limitation「已取消:已完成 X/N 问」;预算尽走既有 limited(run 正常收束,bundle 齐备)。**否决"cancel 前补落 gather checkpoint"变体(会破坏 resume 语义)与"来源级降级"变体(提案合同承诺 claims 级)。**
- **D2(红队#2,目录硬隔离)**:job 根 = `join(dataDir, "capability-jobs")`,job 目录 = `cap-<ts36>-<rand>`(不匹配 `^p-[a-z0-9-]+$`);装配时校验:解析后的 job 根不得为任何 `*/projects` 路径(违规抛错);测试钉死 server 启动清扫与项目列表均不触及。
- **D3(红队#3,归组主路径)**:findings 装配以 gather checkpoint `data.claimQuestions`(claimId→qid)+ `data.questions[].status` 为主键路径;claim 详情(bundle.claims+evidence+snapshots)拼装;answer 判定:answered→"answered"/partially→"partial"/其余→"unanswered";无 qid 映射的 claims(附件/复用前缀)进 `sharedClaims`(result 级,不硬挂问题);verified 按其 evidences 的 verdicts 聚合(全 quote-hit→verified,否则如实)。调查事件路径仅作 D1 取消终态的兜底补充(快照来源清单),不作主归组。
- **D4(红队#4,档位×问数联动)**:submit 校验 questions 1~6 且 `low≤2 / medium≤4 / high≤6`(显式 budget 不限问数,由调用方自担);违规抛错(jobId 不产生)。
- **D5(红队#5,并发与取消时延)**:v1 共享单 adapters 实例(piRuntime channel 本为进程级单例;审计 O_APPEND 并发追加既有先例);并发测试守护,出问题后批改每 job 装配。**取消时延在 Port jsdoc 明示**:信号在问/阶段边界生效,单次模型调用最长 ~300s(DR_MODEL_TIMEOUT_MS),期间 status 保持 running——不承诺即时终态。
- **D6(module 中性)**:缺省 module="industry";补防回归断言:brand/industry 两 config 的 `preferredDomains` 均为空(未来谁加域偏好,此断言红=中性承诺破裂,需重审 capability 缺省)。
- **D7(job 内部请求构造)**:goal = `外部研究(${N} 问):${首问截断}`(进调查任务卡,保信息量);scope.summary = "嵌入式外部研究(数据分析任务)";必过 `ResearchRequestSchema.parse`(attachments default 生效);**request.id = `cap:${jobId}`(唯一,幂等键绝不入 request.id——红队 resume 陷阱)**;budget:tier 或显式(显式透传,不裁剪)。
- **D8(幂等与排队)**:job 层 in-memory `Map<idempotencyKey, jobId>`(进程生命周期有效,文档明示窗口);并发超限→submitted 排队(FIFO),排队不计入 run usage(started 在 runResearch 内取);cancel 对排队中 job 立即 cancelled。
- **D9(上游勘误)**:Port 不暴露 `libraryReuse`(红队证实为空开关——绑定无人建立);上游提案文档此字段标"待绑定机制后启"注记(本批不改上游文档正文,handoff 记录)。
- **D10(T2 沉淀)**:`opts.library?: LibraryStore + opts.projectId?: string` 透传 runResearch options——注入即沉淀(采证时刻 ingest,取消时已抓快照已入库);不注入零影响。job 目录即项目目录(FsProjectStore.create 合成 module/goal/scope),沉淀归属 projectId。

## Testing Decisions

- 只测外部行为(Port 返回/job 记录/落盘),不窥 internals;缝:replay/scripted adapters + Adapters 注入(budgetTopup fakes 先例)+ FsProjectStore/FsLibraryStore 临时目录(fsStore/library 测试先例)。
- 用例:①happy 2 问→completed,findings 按 claimQuestions 归组、claims 带引句/来源/verified、usage 返回;②预算尽→limited+部分 findings+unanswered 如实;③mid-run 取消→cancelled+已完成问 claims 级 findings(D1 回调)+取消 limitation;④幂等键→同 jobId;⑤maxConcurrentJobs=2,3 job→第 3 排队后起步;⑥坏输入(0 问/7 问/low×3 问)拒绝;⑦目录隔离(cap- 前缀+非 projects 路径+server 清扫/列表不触及);⑧module 中性回归断言;⑨T2:注入 library→job 后 acquisitions/sources 有沉淀;取消后已抓快照已入库;不注入→无沉淀无错。
- 既有 441+ 测试零改动;核心改动仅 RunOptions+gatherDomain 回调两处加法。

## Out of Scope

JuanerAI 侧装配/计划步骤/工具/skill;npm 发布/物料机制;跨进程 job 恢复;每问 LLM 综合;HTTP/UI;每问独立 run;libraryReuse 绑定机制。

## Further Notes

兼容/回滚:纯新增目录+两处加法;回滚=revert;job 目录独立无数据迁移。风险:取消时延(D5 已披露);排队 job 的背压(分析侧自控提交频率,v1 不做限流承诺)。

---

## PRD Diff Gate(auto 自批附录,纯加法)

1. D1 修正上游"取消→limited"矛盾为"cancelled 独立终态+claims 级部分结果(加法回调)"——**这是对提案决策的修正**,依据=红队代码级证伪+提案自身"或仅加法"留口;不改提案其余任何决策,记 history 备查(不升级:提案文本自含矛盾,修正方向与提案合同承诺一致)。
2. D3 装配主路径从提案的"调查事件 sid→qid"改为 checkpoint.claimQuestions(红队#3:事件路径漏附件/复用;提案该处是实现细节非决策层)。
3. D4/D5/D6/D7/D8/D9 为红队条件的落点(加法)。

---

## GRILL 第 1 轮决议(author-blind 子代理 6 包全采纳,主代理逐包核实)

1. **G1-1(包1)快照补全 + 取消路径现算核查**:onGatherProgress 快照增 `limitations/unresolved`(runState.ts:17-18);cancelled 路径以快照 claims/evidence/snapshots 现算 `verifyCitations`(纯函数,与 bundle.verdicts 同源同函数)——两路核查口径天然一致。"核心改动"表述修正:**仅加法、三触点**(RunOptions / GatherContext+调用点 / 装配 wiring)。Port jsdoc 披露:取消信号后**在途问题仍完整跑完**(含其 extract 模型调用,有界)。
2. **G1-2(包2)单一装配纯函数**:`assembleFindings({questions, claimQuestions, claims, evidence, snapshots, verdicts, limitations, unresolved})` 纯函数一条路径;completed/limited(bundle+gather checkpoint)与 cancelled(内存快照+现算 verdicts)各挂薄适配——answer 判定/verified 聚合/sharedClaims 只写一遍。
3. **G1-3(包3)终态结果持久化**:runResearch 返回 cancelled 后,capability **同步装配 findings+limitation 写入 job 记录**(一次小 JSON 写);`result()` 一律以 job 记录为源——**跨进程重启可读**(completed/limited 同样在终态把装配结果落 job.json;bundle 仍是权威原件)。否决逐问落盘全量快照(唯一真实的"过大过频"场景)与内存丢失两案。
4. **G1-4(包4)重试语义封闭**:v1 无内部重试;**同 idempotencyKey 一律返回既有 jobId(含 failed),不重跑**;重试=换新键→新 jobId→新 request.id(唯一性封闭);Port jsdoc 写明。杜绝同 jobId 二次 runResearch 的双记录双计量。
5. **G1-5(包5)library×projectId 成对约束**:注入 library 则 projectId 必填,装配期校验违规抛错——防无主 acquisition 静默扩大外发授权面(runResearch.ts:629-635 放行条件)。
6. **G1-6(包6)输入校验三钉**:①显式 budget 存在即免档位×问数联动(仅 tier-only 强制 low≤2/medium≤4/high≤6);②scopeNote 拼进问题文本进调查任务卡(不静默丢弃);③qid 非空唯一,违规抛错(调用方 id 即 findings.questionId 主键,防 claimQuestions 互串)。

自答核查附带关闭的提案开放问题:sid→多 qid 归属不存在(claimId 构造内嵌单一 qid,attachExtraction.ts:32;共享快照按问展开独立主张);sharedClaims v1 恒空(attachments default [];复用绑定无建立方)——装配仍保留该桶作防御。

## GRILL 第 2 轮(主代理自查,收敛)

复查:job.json 形状(终态含装配结果+usage)、status/result 读写源(job.json+内存)、排队 FIFO 与 cancel 即时终态、pump 信号量、assembleFindings 输入在两路的字段可得性(gather checkpoint data vs 快照)、verifyCitations 签名对齐。无新 PRD 级开放问题 → **GRILL 收敛(2 轮)**;本批纯库无用户可见 UI → UI-GATE 跳过。
