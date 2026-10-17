# J1 Tasks:JuanerAI 接入就绪装配级最小调整

> 来源:`.flow/prd.md`(含 GRILL 决议 G1-1~G1-6)。无 issue tracker,降级本文件。切片自批(auto 模式),依赖:T1 → T2、T3。

- [x] 1. T1 authorize 透传 + dataDir/auditPath 派生 + channelCache 键派生化(plain 通道)
- [x] 2. T2 sessionRuntime 装配透传(authorize/dataDir)+ 会话冒烟

> 勾选证据 T2:hostAssembly.test.ts 5/5 绿(session blocked + 审计落 dataDir);全量 431/431 绿 + typecheck 干净(2026-10-17 08:52);sessionRuntime 复用 resolveAuditPath 零分叉。
- [x] 3. T3 宿主消费者进程内闭环(runResearch 正例 + 拒绝 rejects + HTTP 复用记录)

> 勾选证据 T3:hostAssembly.test.ts 7/7 绿(闭环正例 published/limited 非 failed+审计/账本落 dataDir;恒拒经 runResearch rejects 含 AUTHORITY_REQUIRED);落地即绿——T1/T2 已就位,闭环零新增生产代码,与评估"可直接接线"结论一致;全量 433/433 绿 + typecheck 干净(2026-10-17 08:54)。

---

## 1. T1 authorize 透传 + 派生 + 键派生化(plain 通道)

### What to build

宿主式消费者可经装配选项向 plain 模型通道注入 SDK 级授权策略与显式数据目录:`AuthorizeHook` 导出别名(`RuntimeOptions["authorize"]`);`PiRuntimeOptions` 增可选 `authorize` 与 `dataDir`;auditPath 单一派生规则(auditPath 显式优先 → join(dataDir,"model-audit.jsonl") → defaultDataDir()),预算账本目录维持 = dirname(auditPath);channelCache 键按分支派生(生产分支:configs 固定字段序 + auditPath 哨兵 + authorize 缺省常量 id,不解析 defaultDataDir 进键;candidates 分支:逐候选 ModelConfig 固定字段序 + transport 引用 id + 派生 auditPath + authorize 引用 id);头注释列全四 kind(model/tool/publish/control)并写明 channel 级语义、引用稳定约束、"拒 publish 与拒 model 在 runText 观察等价"。缺省 authorize = 模块级无条件放行常量(禁止 kind 过滤)。

### Acceptance criteria

> 细项由本任务末尾的勾选证据块统一覆盖(评审 finding 4 处置):逐项对应关系——两通道负例=用例1;缺省放行=用例2;缓存区分=用例3;优先级=用例4;实现守卫=代码走查(缺省 authorize 无 kind 判断,评审确认);既有零改动=全量绿。

- [x] 恒拒 authorize:runStage rejects 且文案含 `AUTHORITY_REQUIRED`;runAgent resolves `{status:"blocked", reason:"AUTHORITY_REQUIRED"}`(provider 级断言)
- [x] 缺省(不传 authorize):模型调用照常放行、结果 succeeded(KA3 断言)
- [x] 缓存区分:同 configs 两次装配、不同 dataDir / 不同 authorize → 审计各自落位、策略各自生效,互不串道(KA1 判据)
- [x] auditPath 优先级:`{dataDir:X, auditPath:Y}` → 审计落 Y、账本落 dirname(Y);仅 dataDir → 两者落 X
- [x] 实现守卫:缺省 authorize 无任何 kind 判断;键派生两分支无 defaultDataDir() 解析进键
- [x] 既有测试零改动全绿

### Blocked by

None - can start immediately

> 勾选证据 T1:hostAssembly.test.ts 4/4 绿(npx vitest run src/adapters/hostAssembly.test.ts);全量 430/430 绿(69 文件,2026-10-17 08:51)。

---

## 2. T2 sessionRuntime 装配透传 + 会话冒烟

### What to build

`ProjectSessionRuntimeOptions` 增可选 `authorize`(复用 `AuthorizeHook`)与 `dataDir`,auditPath 派生复用 T1 单一函数(零分叉),authorize 透传 createSessionRuntime;缺省语义不变(全放行 + storage.authorize 现状不动)。

### Acceptance criteria

> 细项由勾选证据块统一覆盖(评审 finding 4 处置)。

- [x] 冒烟:`createProjectSessionRuntime({projectDir, candidates, dataDir: tmp, authorize: 恒拒})` → 会话 run 得 blocked(实测 SDK 形态即 blocked,无需修订)+ 审计 jsonl 落 `tmp/model-audit.jsonl`
- [x] 派生函数复用:sessionRuntime 无第二份 auditPath 派生实现(KA4)
- [x] 既有测试零改动全绿

### Blocked by

- T1(AuthorizeHook 别名与派生函数)

---

## 3. T3 宿主消费者进程内闭环

### What to build

以宿主消费者视角完成进程内装配闭环:注入放行 authorize + 显式 dataDir + 剧本化候选链,经 `runResearch` 唯一执行入口完成一次研究闭环(终态非 failed),审计与预算账本落位 dataDir;恒拒 provider 经 `runResearch` 直跑 rejects 且文案含 `AUTHORITY_REQUIRED`(进程内消费形态,G1-5);HTTP 消费形态复用 `server.test.ts` 既有 loopback 全流程,记录复用理由不重建。

### Acceptance criteria

> 细项由勾选证据块统一覆盖(评审 finding 4 处置)。

- [x] 正例:装配(候选链+放行 authorize+dataDir)→ runResearch 完成 → run 终态非 failed;`dataDir/model-audit.jsonl` 与 `dataDir/model-budget.json`(账本文件名以 fileBudgetStore 实测为准)存在
- [x] 负例:恒拒 provider 经 runResearch → rejects 且文案含 AUTHORITY_REQUIRED
- [x] 测试缝仅复用既有:candidates 注入 + 剧本 transport(piRuntime.test.ts 模式)+ runResearch 入口(replay/fakes 先例);零新生产缝
- [x] HTTP 复用理由落注释(引用 server.test.ts 既有覆盖)
- [x] 既有测试零改动全绿

### Blocked by

- T1(装配选项)
