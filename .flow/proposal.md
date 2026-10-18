# Proposal: 嵌入式外部研究能力库(批次 E1)——T1 库本体 + T2 情报库开关

> 规格源:`docs/embedded-research-capability-proposal.md`(提案 v0.1,commit `4499762`)+ 用户 2026-10-18 批准("按推荐"启动 T1/T2,§8 五决策点全按推荐)。基线 main @ `4499762`。与插件接入路线(kickoff prompt)并行,互不改动的对方范围。

## 已确认决策(提案 §8 按推荐,约束级)

1. **交付形态 = A 纯库**:本仓新增能力门面(`src/capability/`),进程内调用;不做独立服务/第二插件/HTTP;交付物料机制(T4)后定,本批只做库本体。
2. **questions 即 plan**:不跑 plan LLM,免门直跑语义(内部 run 的 options.plan = questions)。
3. **v1 不做每问 LLM 综合**:findings 只交 claims+证据,综合归分析流程。
4. **情报库沉淀默认开**(T2):capability 接受可选 LibraryStore 注入,经 runResearch 既有 library/projectId 沉淀路径;无库注入=不沉淀(降级,不报错)。
5. JuanerAI 侧三接点(计划步骤/工具/UI)是宿主侧任务,本批不出界。

## 范围(T1/T2)

**T1 库本体**:
- `createResearchCapability(opts)` → `{ submit, status, result, cancel }`(提案 §2 Port 签名);
- job 管理器:提交/幂等键去重/并发上限(缺省 2,排队)/状态查询/取消(AbortSignal 传入 runResearch);
- 每 job 一个内部 run:runResearch(request, adapters, store, { plan: questions, stopAfter: "gather", signal }),共享预算与快照去重;
- findings 装配:按问题归组(经调查事件 sid→qid 归属),每问 answer 判定(answered/partial/unanswered,取自 gather checkpoint 问题状态),claims 带溯源(statement/kind/quote/source{url,title,tier,fetchedAt}/calibration/verified);
- job 记录落 dataDir(capability 专属目录,不混用户 projects);崩溃后 running→failed(下次进程内自愈清扫,跨进程恢复 v1 不做,已知限制);
- 状态机:submitted→running→completed|limited|failed|cancelled;预算尽/取消→limited(已完成问题 findings 照常可取)。

**T2 情报库开关**:
- opts.library?: LibraryStore + opts.projectId? → 透传 runResearch options.library/projectId(既有沉淀路径);默认行为:注入即沉淀;不注入零影响。

## 约束

- 复用不改核心:runResearch/gather/adapters/质量核查零改动(或仅加法);既有 441+ 测试零回归;
- module 映射:ResearchRequest.module 必填 → capability 缺省 "industry"(中性;module 专属的模板/检查在 stopAfter gather 路径不生效,记录);
- 预算:提案 §2(tier 或显式);usage 随 result 返回;
- 凭据/授权/审计:装配归调用方(adapters 经 piRuntimeModel(configs,{authorize,dataDir}) 注入;库不自行读 env);
- 测试:replay/合成驱动 job 全生命周期 + 负例(坏输入/幂等/取消/预算尽→limited);不调真实 Provider。

## 出界

JuanerAI 侧装配/步骤/工具/skill;npm 发布;跨进程 job 恢复;每问 LLM 综合;HTTP/UI;每问独立 run 的预算再分配。

## 开放问题(交 PRD/GRILL)

- 取消/预算尽时 findings 的部分结果装配口径(bundle 缺失时从 checkpoint 能取到什么);
- sid→多 qid 归属时 claim 归属(全部挂/首挂);无归属 claim(如情报库复用快照)的呈现;
- job 并发排队的等待语义(submitted 排队计时不入 wallMs?);
- result 的终态后留存期/重复读取;幂等键的 job 复用窗口。
