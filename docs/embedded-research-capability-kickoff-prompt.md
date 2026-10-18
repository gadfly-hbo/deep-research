# 给 JuanerAI 工程师 Agent:启动 deep-research 嵌入式外部研究能力(数据分析流程)接入

> 本文为转交 JuanerAI 宿主侧(Mac mini 工程师 Agent)的接入启动 Prompt,随插件仓 `docs/` 发布留档。**本文自包含**:接收方无需访问本仓即可启动对齐与接线设计;库源码/固定物料在接线阶段由用户按 §2.3 提供并记录身份。

日期:2026-10-18。任务:按本仓已发布的插件接入标准,把 deep-research 的**嵌入式外部研究能力库**接入 JuanerAI 的数据分析流程(分析报告需要外部信息研究时按需调用)。上游提案与本批实现、评审均已完成(插件侧必须项为零);本任务是你侧(宿主侧)的对齐→接线→验证。按本仓工程执行政策与既有 OpenSpec 流程推进,不因本 Prompt 增加新审批 Gate。

**与插件接入路线的关系**:并行且互不依赖。插件(`docs/juanerai-integration-kickoff-prompt.md`)是完整研究工作台的随包固定模块;本能力是**纯库**——同一业务核心的轻装门面,无 UI/项目/版本/确认门,服务分析流程的"外部信息研究"环节。两者数据根必须分离,不共享实例。

## 1. 能力定位(本任务的产品语境)

**嵌入式外部研究在 JuanerAI 价值链的位置:分析任务的中途外部信息补给。**

- **职责**:分析流程(计划/取数/撰写)中发现结论需要外部事实(市场规模/行业背景/竞品动态/公开口径)时,提交一组**结构化研究问题**,异步取回**带证据的结构化研究发现**(findings)——每问一组主张,主张带逐字引句、来源(URL/标题/信源分级/抓取时间)、核查判定;分析报告直接引用。**不产出报告文档**(报告由分析流程自己写)。
- **语义不变式**:执行完成 ≠ 证据充分——证据不足/预算到顶 → `limited`(answered/partial/unanswered 如实标注+limitations);取消保留已完成问题的发现;全部主张可回溯快照原文。
- **代表集成用户故事**:分析任务计划含外部问题 → 计划步骤触发研究 job → 分钟级异步取回 findings → 报告撰写时以引注形式消费(来源+引句+分级,unverified 显式标注)。

## 2. 必读材料与身份指纹

### 2.1 宿主侧标准(你所在仓库,直接可读)

本仓 `docs/engineering/plugin-integration/README.md`(PR #93,提交 `6756546a1423162b16a552b24b83bdaa1e834e50`)及 `standard.md`;按需 `acceptance-checklist.md` 与 `report-studio-reference-adapter.md`(按其「复用粒度」表只取模式)。本能力形态对应 standard.md §2「纯函数/库」行:固定依赖、按业务 Port 调用,不强制 HTTP/进程/UI/账本。

### 2.2 库侧基线要点(内嵌,源自库仓落档,无需访问本仓)

| 物料 | 身份 |
|---|---|
| 库源候选提交 | `abba278d3002381ec1ad0b32d24a5d938388e055`(E1 批次+评审遗留 F1-F5 全清;**采用时以实际提供物料为准并记录**,不追随 main) |
| 固定 SDK | `vendor/pi-agent-runtime-0.4.3.tgz`,108,617 bytes,SHA256 `475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70`(`file:vendor/…` 声明,无浮动版本) |
| 依赖锁 | `package-lock.json` 落档 SHA256 `299edd520bcfd90342ed96be095325acc7619b90c696b012241f4edbe107ef31`(**采用时重算当时的值**) |
| 验证记录 | 460/460 测试(75 文件)+ typecheck + build;评审两轮 PASS(0 blocking);无真实 Provider 用例(合成驱动) |

运行依赖:Node ≥ 24.21.0;第三方通知同插件仓 `package.json` dependencies。上游提案勘误(已确认):`libraryReuse` 为空开关(绑定机制未建,Port 不暴露);`asOf` 未承接(v1 无此参数)。

### 2.3 库源获取(本任务不预置)

**无需 clone 本仓启动。** Port 签名/语义/装配约定已在 §3 内嵌完整;接线/打包阶段需要的库源码或固定物料(精确提交 `abba278…` 的快照/tar)由用户届时另行提供并记录身份。若需先跑通接缝验证,向用户申请获准的运行材料,不自取。

## 3. 库接入面速览(已实现并经测试,免重复盘点)

**Port(唯一入口,`createResearchCapability`)**:

```ts
const research = createResearchCapability({
  adapters,                    // 宿主装配:piRuntimeModel(configs, { authorize, dataDir }) + 搜索/抓取/解析适配
  dataDir,                     // 研究作业数据根——必须独立于任何 projects 路径(装配期校验,大小写不敏感+符号链接解析)
  library?, projectId?,        // 可选:注入即沉淀情报库(采证时刻;注入 library 则 projectId 必填)
  maxConcurrentJobs = 2,
});
// → { submit, status, result, cancel }
```

- **submit**:`{ questions: [{id, question, scopeNote?}](1~6 问,qid 非空唯一), tier?: low|medium|high, budget?, idempotencyKey? }` → `{jobId}`(提交即返回)。校验:low≤2/medium≤4/high≤6 问(显式 budget 免联动);tier 枚举白名单。
- **status**:`submitted|running|completed|limited|cancelled|failed`(+时间戳/排队位)。
- **result**(终态):`{ findings: [{questionId, question, answer: answered|partial|unanswered, claims: [{statement, kind, quote, source{url,title,tier,fetchedAt}, calibration?, verified}]}], sharedClaims, limitations, unresolved, usage }`。**verified 五值**:`quote-hit`(全部证据引句逐字命中)/`mismatch`/`snapshot-missing`(快照缺失,比 mismatch 严重)/`unverified`/`no-evidence`;展示 quote/source 与聚合判定同源。
- **cancel**:信号在**问/阶段边界**生效——单次模型调用最长 ~300s 内 status 保持 running(库头 jsdoc 已披露);在途问题仍完整跑完并保留其发现;排队中作业即时终态。
- **幂等**:同 idempotencyKey 一律返回既有 jobId(含 failed 不重跑);重试=换新键;**窗口=进程生命周期**(重启后同键新开 job)。
- **持久化**:终态结果同步落 `<dataDir>/capability-jobs/cap-<id>/job.json`,`result()` 跨进程重启可读;装配时自愈清扫上次进程遗留的 submitted/running 孤儿(标 failed「进程中断」)。
- **装配约定**:同一 dataDir 单活跃实例;job 目录绝不落任何 projects 路径(与插件实例/用户项目硬隔离,server 清扫与项目列表均不触及——已测试钉死);凭据/授权/审计归宿主装配(adapters 注入即定)。

## 4. 植入分析流程(三个接点,按需选装)

1. **Analysis Plan 步骤类型**(建议首接线):分析计划器把需要外部信息的问题标为 `external_research` 步骤 → 步骤执行器调 Port(submit→等终态)→ findings 作为**可引用分析材料**挂进 Analysis IR(与内部数据资产同级)。
2. **分析 Agent 工具**:`external_research(questions, tier)` 薄工具(executor 包 Port,提交即返回 jobId,不阻塞轮询);配套 **skill=使用手册**:何时值得开研究(vs 直接 web_search)、问题怎么写质量高、`limited/unanswered` 怎么如实呈现。状态机留在库内,工具是薄的。
3. **报告编辑 UI 动作**:编辑器内"对此结论做外部研究"(最后做)。

**引用合同(三接点共用)**:findings.claims 全量溯源 → 报告装配渲染引注(来源+引句+信源分级;verified≠quote-hit 的显式标注);limitations/unanswered 进报告限制节——分析报告不得把未核实主张当已核实呈现。

## 5. 待你正式确认的合同决策(库侧已给推荐默认)

| 决策 | 推荐默认 | 需你确认的内容 |
|---|---|---|
| 首接线接点 | **计划步骤**(确定性管线,风险最低;工具/UI 后续) | 接点顺序与 Analysis IR 材料挂载形状 |
| findings 消费形态 | 作为**可引用材料**进 IR(引注渲染),非独立文档 | 引注渲染格式(引句+来源+分级) |
| 库装配位置 | 分析服务 composition root(进程内,固定依赖);dataDir 独立于插件实例与 projects | dataRoot 归属与命名 |
| 预算归属 | 每 job 独立预算(档位),计入该分析任务成本口径;usage 随 result 返回供记账 | 档位默认值与成本口径映射 |
| 凭据/授权 | 宿主 env + `authorize` 钩子注入(与插件实例策略可不同) | 密钥保管与授权策略对齐 |

## 6. 工作要求

- 按标准 §5 五步推进;「盘点」库侧已完成(§2.2/§3),你的盘点对象是**宿主侧**(分析管线装配点、Analysis IR 材料机制、打包工具链)。
- **接线产物是薄 Adapter/Profile**:Port 装配 + 步骤执行器/工具 executor + findings→IR 材料映射 + 引注渲染。**不重写库业务、不复制研究逻辑、不给库加 UI/HTTP**。
- 数据隔离:库 dataDir 独立(装配期校验会拒绝 projects 路径);研究账本/审计与插件实例、分析库互不合并;情报库沉淀可选启用(注入即沉淀,授权检查/版本绑定复用插件仓既有机制)。
- 验证:从 `acceptance-checklist.md` 选适用项(建议 C01 固定身份、C02 双交付(库形态)、C04 同版输入、C05 合成凭据/路径、C06 幂等(idempotencyKey)、C07 状态/取消(注意取消时延披露)、C08 产物回读(findings/引注)、C10 SDK 合成 codec、C11 业务正确性=合成消费者);先确定性合成接缝,真实 Provider/live 按授权执行。库侧 460 测试可作复用证据(身份 `abba278`)。
- 固定交付:首次采用建 source-identity(精确提交+依赖 SHA——lockfile 采用时重算);采用/安装/运行/接受分别记录,不互相代替。

## 7. 边界与红线

- 库业务与中立修复在本仓(deep-research 原仓)维护;宿主侧如需库改动,走原仓任务回流,不在宿主副本改业务(当前宿主副本修改与回流状态:**尚未发生**)。
- 不统一 SDK 版本(库带 vendored 0.4.3,宿主自固定版本并存,标准 §2 允许);不合并库与插件实例的会话/存储/账本。
- `limited` 是有限交付不是失败;取消有时延(问边界生效);幂等窗口=进程生命周期——三处语义按 §3 原样透传,不改写。
- 不能证明新物料保留已验修复或数据兼容时,阻止该次新升级、保留旧验收包;活动/UNKNOWN 任务不热换。

## 8. 交回

按标准 §5/§6 记入既有 OpenSpec/验证章节:已读取材料与身份、五项决策确认结果、Adapter 接点清单、验证证据(区分「已有记录证明」与「本轮执行」)、source-identity 与升级基线差异表、未执行/UNKNOWN 清单。区分「已读取/已采用/经证据验证符合」,不以静态对照宣称运行验证通过。
