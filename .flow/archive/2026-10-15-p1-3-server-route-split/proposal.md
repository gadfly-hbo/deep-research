# 提案:P1-3 拆分 server.ts 的路由域 + 抽 RunRegistry(纯重构)

> 来源:2026-10-14 重构审查,用户以 `/dev-flow P1-3` 选定本提案为范围。
> P0-1(runResearch 内部分解)、P0-2(快照存储/轮询负载)均已完成并归档;P1-4(UI 顺手项)不在本次范围。

## 背景证据(已核实)

`handle()`(`src/server/server.ts:195-960`,审查时点行号)是一条 765 行的 if 链,混装四个域:项目/runs 路由、情报库 14 条路由、settings 读写、静态文件服务,外加启动清扫和指令队列。server.ts 整文件 969 行、图谱圈复杂度 233,为全仓库第二热点。

## 建议(提案级决策)

1. **按域拆文件**:`routes/projectsRuns.ts`、`routes/versions.ts`、`routes/library.ts`、`routes/settings.ts` + 一个极小的匹配器(十几行足够,**不引框架**——HTTP 本身就是测试接口,`server.test.ts` 602 行已经这么用了)。
2. **抽 `RunRegistry` 内部接缝**:`controllers` Map + `instructionQueues` + `getQueue/drainFor` + pending-instructions 落盘(原 `:124-145`)是有状态的真实行为,删除测试通过(拆掉后这些逻辑会在 launch/resume/cancel/instruct 四处复现)。
3. **消除 launch/resume 重复**:原 `:357-379` 与 `:496-516` 两段 `runOnProject(...).catch(落 failed).finally(清 controllers)` 几乎逐行相同,且都绕过已有的 `store()` 闭包另开 `FsProjectStore.open(dir)`。
4. **统一路由级错误处理**:目前不一致(library 路由有 try/catch,projects 路由靠外层 500),拆分时统一。

## 约束

- 纯重构:HTTP API 形状、状态码、响应体逐位不变;`server.test.ts`(14 个测试)原样通过是行为不变的核心证据。
- 不动 `src/contracts.ts` 与 `src/adapters/types.ts`。
- `startServer` 的对外签名与启动行为(绑定 127.0.0.1、启动清扫、library 暂存协调)不变。
- P1-4(UI)、暂不动清单(LibraryStore 宽接口、魔数收紧、searchIndex 线性扫描)不在范围。

## 验证

- `npm test`(vitest,server.test.ts 全套)+ `npm run typecheck`。
- 拆分后各路由域文件可独立阅读;RunRegistry 配同风格单测(参照既有 store 测试)。

## 开放问题(留给 PRD/GRILL)

- 路由匹配器的最小形状(逐域前缀分发 vs 微型 path matcher)。
- RunRegistry 的接口边界(谁持有 pending-instructions 落盘时机)。
- 静态文件服务与启动清扫留在 server.ts 还是独立文件。
- 错误处理统一的具体形态(域内 try/catch vs 匹配器统一兜底)。
