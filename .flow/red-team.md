# Red-Team: J1 批次——`authorize` 透传(A1)+ 显式 `dataDir`(A2)+ 合成宿主消费者验证(A3)的装配级最小调整

> 评审身份:全新上下文只读子代理(2026-10-17),按 strategy-red-team 技能执行;对象 = `.flow/proposal.md`。核实方式:已只读验证提案的全部可查事实(源码、SDK 类型与运行时行为、测试基线、vendor 哈希、git 基线)。以下按 影响×可能性×测试廉价度 排序。

---

## Top Kill-Assumptions(排序)

### KA1|A1/A2 的有效性依赖:`channelCache` 单例键能区分新注入维度 —— **当前不能**

- **Claim**(隐含承载假设):给 `PiRuntimeOptions` 加 `authorize`/`dataDir` 并透传,宿主注入即生效。
- **Steelman**:提案其余部分确实成立——生产调用点(`src/cli.ts:116/184/286` 的 `piRuntimeModel(config.model)`、`src/server/server.ts:80/82` 显式传 auditPath)全部不传新选项,"只做加法、缺省等价"在调用点层面零改动;SDK `RuntimeOptions.authorize` 为必填且 `Authorization` 类型确从 `"pi-agent-runtime"` 可导入(`node_modules/pi-agent-runtime/dist/index.d.ts:3` 的 `export type * from './types.ts'`,types.d.ts:163-206),开放问题 1 其实已有肯定答案。
- **Fails if**:实现不先派生有效输入再入缓存键。现状 `src/adapters/piRuntime.ts:185` 的键 = `{configs, auditPath ?? null, candidates.length}`——**不含 `authorize`、不含 `dataDir`、甚至不含 candidates 身份(只有长度)**。后果三连:
  1. 同 configs + 不同 `dataDir` 的两次装配 → 同键 → 第二个消费者静默复用第一个 channel → 审计/账本落错目录(A2 要建立的信任锚被自己击穿);
  2. 同 configs + 不同 `authorize` 策略 → 先到者通吃,后注入的策略被**静默丢弃**——这是授权旁路,不是功能缺陷;
  3. 一个传 `authorize`、一个不传的两次装配 → 键相同 → 顺序决定是否生效。
  今日无恙只因所有 authorize 恒为 `() => true`(piRuntime.ts:216、sessionRuntime.ts:68),A1/A2 恰好把这个潜伏弱键变成可观测缺陷。而 JuanerAI 的预期形态正是"单进程内多次装配"(A3 测试本身就要在一个进程里装配多个消费者),是该缓存的最坏用例。
- **Evidence to get this week**:纯读代码即可(本评审已完成);PRD 阶段确认实现方案是否包含"键派生化"。
- **Kill criterion**:PRD/实现若既不把缓存键改为派生输入(有效 auditPath + authorize 引用 + candidates 身份),也不在类型/文档层显式声明"同键装配共享 channel、authorize 为 channel 级非任务级"约束 → **kill A1/A2 作为"授权注入接口"交付**(降级为仅记录,批次缩小)。
- **Cheapest test**:同一测试文件内两次 `piRuntimeModel(同configs, {candidates:[…], dataDir: tmp1/tmp2})` + 各自断言审计落位与 authorize 策略生效;此测试同时是 A3 应含的正例。

### KA2|A3 负例假设:"authorize 拒绝"有一条统一可观测路径 —— **两通道分裂且 runText 侧是 throw**

- **Claim**:负例测试能证明"宿主可注入授权策略(拒绝生效)"。
- **Steelman**:SDK 行为链清晰且已核实:`authorize` 返回 false → `RuntimeFault('AUTHORITY_REQUIRED')`(`dist/index.js:128-137`)→ RunResult 映射为 `status:'blocked'`(index.js:90 的 reason 白名单);提案开放问题 3 已正确预判"runText/runAgent 两通道映射行为"需要断言,说明作者知道有缝。
- **Fails if**:测试只断言一条通道。实际分裂:`runAgentRaw` 把 blocked 透传为 `{status:'blocked'}`,编排器按 "failed/blocked→该问 unanswered+limitation,整 run 不死" 降级(`src/core/gatherDomain.ts:517`);而 `runTextRaw` 对 blocked **直接 throw** `模型调用失败(AUTHORITY_REQUIRED)`(`src/adapters/piRuntime.ts:262`),该 throw 进入 `runStageSafe.spec.call()` 无 try 包裹(`src/core/runStageSafe.ts:49`)后向编排器传播——宿主若按 runAgent 的"优雅降级"心智模型接 runText,会在第一次真实拒绝时遭遇未预期异常路径。
- **Evidence to get this week**:PRD 阶段写出两通道各一句断言预期;或先写一个 5 分钟合成测试跑出实际行为。
- **Kill criterion**:PRD 无法给出两通道拒绝语义各一句可断言的描述(runText→throw 且错误文案含 AUTHORITY_REQUIRED;runAgent→blocked→unanswered+limitation)→ **A3 不得开工**(A1/A2 可先行,不受此限)。
- **Cheapest test**:合成 transport 下,`authorize: () => false` 分别驱动一次 `runStage` 与一次 `runAgent`,断言前者 rejects/后者返回 blocked。

### KA3|"缺省等价,既有测试不改动即绿为证" —— **该证据形式对此改动是空证明**

- **Claim**:新增选项缺省时与现状等价,由 426 测试全绿佐证。
- **Steelman**:测试数属实(全仓 `\bit\(` 恰 426);基线属实(`e3341c1` = HEAD = origin/main,工作区仅 `.flow/` 文档变更);缺省改法 `authorize: opts.authorize ?? (async () => true)` 在代码层面显然等价。
- **Fails if**:实现者受 `sessionRuntime.ts:76` 的 `storage.authorize` 风格诱惑,把缺省从"无条件放行"改成按 kind 过滤——既有 426 测试**没有任何一条传 authorize 或断言全放行**(选项尚不存在),将全绿通过而缺省语义已变;A3 若也漏掉缺省正例,则双盲。
- **Evidence to get this week**:PRD 验收口径中补一条"缺省 authorize 语义 = 无条件 true"的显式断言。
- **Kill criterion**:实现 diff 中缺省 authorize 含任何 `action.kind` 判断且 PRD 无此决策记录 → 返工(不杀整批,属实现期守卫)。
- **Cheapest test**:不传 authorize 的 channel 跑一次 runText,断言 model/publish 双放行、结果 succeeded。

### KA4|A2 的优先级与 sessionRuntime 缺省覆盖 —— **歧义真实但价廉**

- **Claim**:`dataDir` 显式定位审计+账本;"倾向覆盖 sessionRuntime 的 auditPath 缺省"。
- **Steelman**:现状核实为真——账本目录确为 `dirname(auditPath)`(piRuntime.ts:192、sessionRuntime.ts:70),"仅能经 auditPath 间接控制"准确;server.ts:80 显式传 auditPath,故改缺省不影响生产路径。
- **Fails if**:`dataDir` 与 `auditPath` 同时给出时优先级未定义(实现者各写各的),或 sessionRuntime 缺省改为 `join(dataDir ?? defaultDataDir(), …)` 时与 piRuntime 侧规则不一致——两处装配语义分叉,正是 A2 声称要统一的装配语义。
- **Evidence to get this week**:PRD 一行决策:"auditPath 显式值优先,dataDir 仅影响缺省派生;两文件同一派生函数"。
- **Kill criterion**:实现后两文件的 auditPath 派生逻辑出现两份不一致代码 → 返工(价廉,不杀批)。
- **Cheapest test**:`{dataDir: X, auditPath: Y}` 断言审计落 Y、账本落 dirname(Y);仅 `{dataDir: X}` 断言两者均落 X。

---

## What's Well-Reasoned(未制造怀疑的部分)

- **进程内闭环可行性——核实为真**:`runResearch(request, adapters, store, opts)` 的 `adapters.model` 可注入(`src/core/runResearch.ts` 签名),且 `src/app/dataSync.test.ts:84-101` 已存在"进程内消费者经 `piRuntimeModel`+candidates+auditPath 装配"的先例;`piRuntime.test.ts` 提供逐 stage 剧本化 transport 的完整模式;`server.test.ts` 确以 `startServer`+fake adapters 覆盖 loopback HTTP 形态——"复用不重建"的记录理由成立。
- **出界范围划分干净**:不动 vendored SDK 属实(vendor/README.md 载明 SHA-256 `475480217d…bfa70`,本次实算 shasum 逐字节吻合;package-lock 经 file: + integrity 双钉)。
- **开放问题清单质量高**:三问中两问(类型对齐、两通道映射)恰好落在真实缝隙上——这说明差距评估并非走过场,KA2 只是要求把"预判"落成"结论"。

## What I Couldn't Assess

- 评估报告 v0.2/v0.3 原文(会话内交付,不在仓库)——"符合标准 P3""无阻塞"等上游结论的原始依据无法核对,只能核实其落到本仓的代码事实。
- JuanerAI 宿主侧的真实授权粒度意图(进程级单一策略 vs 按任务差异化)——这是 KA1 是"实现细节坑"还是"设计层缺口"的裁决输入,本仓不可见;若宿主要任务级策略,A1 的装配级注入+channel 单例形态需要重新设计,而非本批能兜住。
- vitest 隔离模型下新测试文件的 `channelCache` 隔离边界(worker/fork 粒度)——不影响 KA1 结论方向,只影响缺陷显形的时机。

---

## Verdict: **GO**(附武装好的 kill 判据)

无 kill 判据当前已满足:提案全部可核实的事实性前提(可注入性、SDK 类型存在与拒绝路径、测试基线 426、git 基线、vendor 锁定、生产调用点零改动)均核实为真,失败模式全部是"开工时必须补的约束"而非"前提为假"。

但 GO 附两个门内条件(进 PRD):
1. **KA1 必须成为验收项**:缓存键派生化(或显式的 channel 级语义声明 + 类型层防误用),否则 A1 交付的是一个会被静默旁路的假授权接口——届时触发 kill,批次缩为 A2+A3。
2. **KA2 在 PRD 阶段闭合**:写出两通道拒绝语义断言,否则 A3 暂缓、A1/A2 先行。

下一步动作(按序):PRD 补 KA1 键派生方案 + KA2 两句语义断言 + KA3 一行优先级决策 + KA3' 缺省全放行断言 → 然后开工。这四项合计不超过一页纸,是本批最便宜的保险。
