# J1 交接卡:JuanerAI 接入就绪装配级最小调整(2026-10-17)

> 前序:接入差距只读评估 v0.3(会话内交付,2026-10-16/17)→ 用户授权最小调整 → dev-flow J1 批次。commit `3a3f8c3`(main,已推 origin)。

## 本批交付

- **A1 authorize 装配透传**:`AuthorizeHook` 别名(piRuntime.ts 导出,`RuntimeOptions["authorize"]` 同签名);`PiRuntimeOptions`/`ProjectSessionRuntimeOptions` 增可选 `authorize`,透传 `createRuntime`/`createSessionRuntime`;缺省=无条件放行(零 kind 过滤,KA3 守卫)。
- **A2 显式 dataDir**:两装配接口增可选 `dataDir`;auditPath 单一派生 `resolveAuditPath`(auditPath > dataDir > defaultDataDir,两文件零分叉);账本目录恒 = dirname(auditPath)。
- **KA1 缓存键派生化**:channelCache 键含 configs/候选链身份(稳定序列化+transport 引用 id)+ 派生 auditPath(显式输入)+ authorize 引用 id;缺省分支不解析 defaultDataDir() 进键,进程级单例保持。
- **A3 宿主装配测试**:`src/adapters/hostAssembly.test.ts` 7 用例——两通道拒绝语义(runStage rejects AUTHORITY_REQUIRED / runAgent blocked)、缺省放行、缓存区分、auditPath 优先级、session 冒烟(blocked+落位)、进程内 runResearch 闭环(正例+恒拒 rejects)。HTTP 形态复用 server.test.ts 既有覆盖。

## 验证状态

- 433/433 绿(69 文件;426 既有+7 新)+ typecheck 干净;VERIFY=SHIP 两拍重跑一致。
- REVIEW(全新子代理)PASS:0 blocking / 6 non-blocking(见 review-findings.md);f2/f4 纯文档已闭合,f1/f3/f5/f6 记录不动。
- **degraded coverage**:无真实 Provider 用例(live 未授权、出界;本批装配级改动由合成 transport 覆盖行为面)。

## 遗留与后续批候选

1. **f1(下批首选)**:缓存区分测试补两组单维对照(同 dataDir 仅 authorize 异 / 同 authorize 仅 dataDir 异),守护单维回归。
2. 可选小项:f3 缺省 allowAll 提模块级常量;f5 测试 env 还原式清理;f6 stableKey 码点序。
3. 文档:README 装配选项一段(JuanerAI Adapter 实际落地时随接缝文档补,本批以 piRuntime.ts 头注释承载)。
4. 上游背景遗留(评估 v0.3,均待用户决策):正式 JuanerAI 接入合同与消费形态、pi-agent-runtime 0.5.0 立项评估、live Provider 新形态复验、随包固定快照登记格式。

## 下一批前置

- 工作区仅剩 research-data 运行数据(用户既有变更,待 data-sync 或手动 git-commit-push);无代码 WIP。
- 装配级能力已就绪:宿主可经 `piRuntimeModel(configs, {authorize, dataDir, candidates})` 或 `createProjectSessionRuntime({...同款})` 注入策略与数据目录;channel 级语义与"拒 publish 与拒 model 在 runText 观察等价"见 piRuntime.ts 头注释。
