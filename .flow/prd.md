# J1 PRD:JuanerAI 接入就绪装配级最小调整

> 规格源:`.flow/proposal.md`(权威);红队 `.flow/red-team.md`(GO,附 KA1-KA4 门内条件);无 issue tracker,降级写本文件(历史周期同款)。基线 main @ `e3341c1`。

## Problem Statement

接入差距评估(v0.2/v0.3)结论:deep-research 可直接供 JuanerAI 经 Adapter 接线(进程内装配或 loopback HTTP),无必须插件侧改动;但两项装配级能力目前只能靠 env/cwd 隐式满足——未来宿主无法在装配处注入自己的 SDK 级授权策略,也无法显式指定数据目录定位审计与预算账本。用户已授权实施该最小调整:让第三方消费者可以在进程内装配点显式提供授权策略与数据目录,并用合成测试证明这条装配通路真实可用。

## Solution

在既有装配选项(`PiRuntimeOptions` / `ProjectSessionRuntimeOptions`)上增加两个可选字段并正确透传:通用授权注入 `authorize`(缺省保持现状全放行)与显式数据目录 `dataDir`(缺省保持 `defaultDataDir()`)。同步修复被新维度暴露的 channel 单例缓存弱键问题(红队 KA1:现键不含 authorize/dataDir/candidates 身份,注入会被静默丢弃或串道)。新增合成宿主消费者测试:进程内装配 → 真实业务实现闭环 + 授权拒绝/目录落位/缺省等价/缓存区分正负例。现有 CLI/serve/UI/launcher 行为零变化。

## User Stories

1. 作为 JuanerAI 装配开发者,我想在进程内装配点传入自己的 `authorize` 策略,所以宿主可以对模型/发布动作执行自己的授权判定,而不必修改插件业务代码。
2. 作为 JuanerAI 装配开发者,我想在装配点显传 `dataDir`,所以模型审计与预算账本落在宿主指定的数据目录,不依赖 `DEEP_RESEARCH_DATA_DIR` 环境变量或进程 cwd。
3. 作为 JuanerAI 装配开发者,我想在同一个进程里为不同消费者装配不同策略/目录且互不串道,所以多装配场景下授权与审计各自正确。
4. 作为插件维护者,我想让不传新选项的装配与现状完全等价,所以现有 426 测试与全部生产入口(CLI/serve/UI/launcher)零回归。
5. 作为插件维护者,我想让 channel 级语义显式化(authorize 为 channel 级策略:同引用共享、异引用各起 channel),所以后续装配者不会误以为可以按调用随意换策略。
6. 作为插件维护者,我想让 `sessionRuntime` 装配与 plain 通道共用同一 auditPath 派生规则,所以两处装配语义不分叉。
7. 作为独立用户,我不想安装、启动或连接 JuanerAI 也能继续完成研究全流程(本批不改变这一点)。
8. 作为后续 Adapter 评审者,我想有合成测试证明"宿主式消费者注入策略→拒绝生效/放行闭环→产物落位"整条链路,所以接入评估的"可直接接线"结论有可回归的证据。

## Implementation Decisions

- **D1(KA1,缓存键派生化——本批验收项)**:`channelCache` 键从"configs+auditPath+candidates.length"改为**派生有效输入**:有效 auditPath(派生规则见 D3)+ authorize 引用恒等(缺省 = 模块级共享的全放行常量)+ 候选链身份(ModelConfig 可序列化字段 + transport 引用恒等)。函数引用恒等经 WeakMap 计数器派生稳定 id。生产路径(不传 opts)派生键与现状语义等价 → 进程级单例保持。channel 级语义写进 piRuntime 头注释:authorize 为 channel 级非任务级;宿主应保持策略函数引用稳定,频繁新建闭包会增殖 channel(文档约束,不加容量上限)。
- **D2(A1,authorize 透传)**:`PiRuntimeOptions` 增 `authorize?: Authorization`(类型自 `pi-agent-runtime` 导入,红队已核实存在);`createRuntime` 收到 `opts.authorize ?? allowAll`。`ProjectSessionRuntimeOptions` 同型增字段并透传 `createSessionRuntime`。**缺省 = 无条件放行常量,禁止任何按 kind 过滤**(KA3 守卫;不模仿 storage.authorize 风格)。storage 级 authorize(现 `action.kind !== "delete"`)不在本批范围。
- **D3(KA4/A2,dataDir 与派生优先级)**:新增单一派生函数(放 piRuntime.ts,sessionRuntime 复用,先例:buildLimits/makeAuditSink):`auditPath 显式值优先;否则 join(dataDir, "model-audit.jsonl");否则 join(defaultDataDir(), "model-audit.jsonl")`。预算账本目录继续 = `dirname(auditPath)`(现状不变)。`dataDir` 仅影响缺省派生,不覆盖显式 auditPath。两文件零分叉。
- **D4(KA2,两通道拒绝语义——本批验收项)**:authorize 拒绝(SDK `AUTHORITY_REQUIRED`)在两通道的可观测行为:**runText 通道(`runStage`/`extractClaims`)→ 抛错,文案含 `模型调用失败(AUTHORITY_REQUIRED)`,经编排器既有失败路径落 run failed;runAgent 通道 → resolve `{status:"blocked", reason:"AUTHORITY_REQUIRED"}`,编排器按既有降级(该问 unanswered+limitation,不杀 run)**。A3 负例按此两句断言;若实现期实测与 SDK 白名单映射不符,以实测为准修订断言并记录(history 留痕),不改业务降级逻辑。
- **D5(通用装配选项定位)**:A1/A2 是通用装配能力,不是 JuanerAI 专属接缝;本仓仍不建宿主 Adapter/任务映射(README:73 决策不变)。
- **模块面**:仅 `src/adapters/piRuntime.ts`、`src/server/sessionRuntime.ts` 与新增测试文件;不改 cli/server/routes/core/library。

## Testing Decisions

- 只测外部行为(装配结果/落盘位置/通道返回),不测内部计数器细节。好测试 = 换掉内部实现仍应绿。
- **缝(复用既有,零新缝)**:`piRuntimeModel(configs, { candidates, ... })` 显式候选注入(dataSync.test.ts:84-101 先例)+ 剧本化 transport(piRuntime.test.ts 模式)+ `runResearch(request, adapters, store)` 唯一执行入口(replay 模式)。auto 模式:缝自批,记录于 state.context.seams。
- **A3 测试内容**(一个新测试文件承载,进程内装配视角):
  1. 正例闭环:注入放行 authorize + 显式 dataDir + 候选链 → `runResearch` 完成 → 审计 jsonl 与预算账本文件均落在 dataDir;run 终态非 failed。
  2. 两通道拒绝负例:authorize 恒拒 → runStage rejects(文案含 AUTHORITY_REQUIRED);runAgent resolves blocked(同 reason)。
  3. 缺省等价:不传 authorize → 模型调用照常放行、结果 succeeded(KA3 断言)。
  4. 缓存区分(KA1 判据测试):同 configs 两次装配、不同 dataDir/不同 authorize → 各自审计落位、各自策略生效,互不复用。
  5. auditPath 优先级:`{dataDir:X, auditPath:Y}` → 审计落 Y、账本落 dirname(Y)。
- **HTTP 形态复用不重建**:`src/server/server.test.ts` 既有"创建→计划→运行→发布→导出"loopback 集成覆盖即 HTTP 消费形态证据;本批 server 生产路径不传新选项,由既有测试守护等价性。
- 既有 426 测试 + typecheck 全程保持绿(不改动既有断言)。
- **真实 Provider 用例**:本批改动为装配级,合成 transport 即覆盖其行为面;live Provider 验证不在授权范围(提案出界),记 degraded coverage。

## Out of Scope

- 提案载明的全部出界项:live Provider 真实验证、SDK 升级/0.5.0、JuanerAI 侧 Adapter、README 口径修正、`--datadir` 与 config.json/审计位置既有不一致。
- channelCache 容量上限/LRU(D1 以文档约束替代)。
- storage 级 authorize、按任务级(非 channel 级)授权粒度——若宿主确需任务级,另立提案(红队 What I Couldn't Assess 第 2 条)。
- 任何 UI 变更(本批无用户可见 UI → UI-GATE 跳过)。

## Further Notes

- 红队 GO 附两个门内条件(KA1 键派生化、KA2 两通道语义)均已吸收为 D1/D4 验收项;KA3/KA4 为实现期守卫(D2 缺省常量、D3 单一派生函数)。
- 兼容/回滚:全部字段可选、缺省路径等价;回滚 = revert 本批 commit,无数据/格式迁移。
- 历史数据无迁移;固定包(vendored tgz)不动。

---

## PRD Diff Gate(auto 模式自批附录)

相对 `.flow/proposal.md` 的增量(纯加法,无改动作何提案决策):

1. **新增 D1 缓存键派生化**(红队 KA1 门内条件):提案 A1/A2 未提及 channelCache;不补则 A1 交付即被静默旁路。属"A1/A2 成立的必要实现细节",非范围变更。
2. **新增 D3 派生优先级决策**(红队 KA4):提案开放问题 2 的闭合,方向与提案倾向一致("同批覆盖")。
3. **新增 D4 两通道拒绝语义**(红队 KA2 门内条件):提案开放问题 3 的闭合,断言语句落在装配层。
4. **新增测试断言集**(含缺省全放行断言,红队 KA3):提案 A3 的具体化。
5. 明确"channel 级语义 + 引用稳定约束"为文档约定(不加容量上限)。

---

## GRILL 第 1 轮决议(author-blind 子代理 6 包全部采纳,主代理逐包核实)

1. **G1-1(包1)authorize 类型 = 导出别名**:`export type AuthorizeHook = RuntimeOptions["authorize"]`(即 `(action: Authorization, signal: AbortSignal) => Promise<boolean>`,types.d.ts:206 实核)。PiRuntimeOptions 与 ProjectSessionRuntimeOptions 均用该别名;别名定义在 piRuntime.ts,sessionRuntime.ts 复用(先例:buildLimits/makeAuditSink)。原 D2 的 `authorize?: Authorization` 系笔误,以本决议为准。
2. **G1-2(包2)缓存键按分支构成 + 固定字段序**:
   - 生产分支(无 opts.candidates):`{configs 固定字段序序列化, auditPath: 显式值或 null 哨兵, authorizeId: 缺省共享常量 id}`——**不把 defaultDataDir() 解析进键**(非记忆化、读 env/cwd,进程内变化会导致 channel 分叉,违背缺省等价);**(评审 finding 2 消歧:两分支统一 `auditPath ?? join(dataDir,"model-audit.jsonl") ?? null`——dataDir 派生值同入键,防生产分支+dataDir 串道;缺省装配键构成不变)**;
   - candidates 分支:`{每候选 = ModelConfig 固定字段序序列化 + transport 引用 id, auditPath: 显式 auditPath 或 join(dataDir,"model-audit.jsonl") 派生值或 null 哨兵, authorizeId: WeakMap 计数器引用 id}`;
   - ModelConfig/configs 序列化统一固定字段序,消除键序假阴性。现状键的 `candidates.length` 弱键一并消除。
3. **G1-3(包3)验收口径如实改写**:"缺省等价"的证据 = ①既有 426 测试不改即绿(生产行为面)+ ②键派生分支构成与现状同构的实现审查(缺省分支键 = configs+null+缺省常量,纯函数可走查)+ ③A3 缓存区分测试的外部行为守护。不为"进程级单例保持"这一外部不可观察主张伪造测试(路径级 budget 单例使 channel 数不可从文件系统区分)。
4. **G1-4(包4)新测试文件 = `src/adapters/hostAssembly.test.ts`,内含 sessionRuntime 冒烟**:一条用例覆盖两新字段透传——`createProjectSessionRuntime({projectDir, candidates, dataDir: tmp, authorize: 恒拒})` → 会话 run 得 blocked(types.d.ts:335 实核 status 含 blocked;若 SDK 会话形态实测不同,以实测修订断言并留痕)+ 审计 jsonl 落 `tmp/model-audit.jsonl`(照 dataSync.test.ts:98-105 模式)。
5. **G1-5(包5)D4 措辞修订 + 补进程内 rejects 断言**:runText 拒绝"经编排器既有失败路径落 run failed"修正为——**server 消费形态**经路由失败回调落 failed 记录(projectsRuns.ts onFailure);**进程内直消费形态**(CLI/宿主同款)为 runResearch promise reject、无顶层 catch(runResearch.ts 实核)。A3 负例增一条:恒拒 provider 经 `runResearch` 直跑 → rejects 且文案含 AUTHORITY_REQUIRED;runAgent blocked 分支维持 provider 级断言(编排器降级属既有行为,gatherDomain 既有测试覆盖,不重证)。
6. **G1-6(包6)头注释列全四 kind + 披露观察等价**:piRuntime.ts 头注释 authorize 口径从"model/publish"扩为 **model/tool/publish/control**(types.d.ts:167-180 四 kind 联合实核),并写明"拒 publish 与拒 model 在 runText 通道观察等价(同一异常文案)";channel 级语义 + 策略引用稳定约束同处。不加选择性策略用例(恒拒已覆盖 authorize→SDK→通道整条通路;选择性分支属宿主策略域)。

## GRILL 第 2 轮(主代理自查,收敛)

逐项复查 G1-1~G1-6 的落地缺口:别名归属与复用面、WeakMap id 的模块级归属、`runFreeText(configs, prompt, opts)` 第三参自动获得新选项(无需改动,核实签名)、server.ts 生产装配不传新选项(零改动,核实 server.ts:80-82)、README 不动(装配选项文档以 piRuntime.ts 头注释承载,README 属可后置)。未发现新的 PRD 级开放问题 → **GRILL 收敛(2 轮)**。
