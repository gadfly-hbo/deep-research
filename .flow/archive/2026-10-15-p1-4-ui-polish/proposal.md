# 提案:P1-4 UI 顺手项 —— PlanView 请求编排下沉 + formalReady 探测改服务端标记

> 来源:2026-10-14 重构审查(基于 codebase-memory 图谱 + 六个核心文件通读),用户以 `/dev-flow P1-4` 选定本提案为范围。
> 同一审查中的 P0-1(runResearch 分解)、P0-2(快照存储)、P1-3(server.ts 拆分)均已完成,不在本次范围,不得顺手做。

## 两项内容(原文照录自审查建议)

### 1. PlanView 请求编排下沉 state 层

- `ui/views/PlanView.tsx`(516 行)里 `previewPlan`/outline 预览的请求编排内联在视图里,可下沉到 `ui/state/`,视图只剩渲染——与 `projectDetail.tsx` 既有模式对齐。

### 2. formalReady 探测改为服务端标记

- `ui/state/projectDetail.tsx:131-146` 的 formalReady 探测在版本集合每次变化时对每个版本发一次 fetch,可由服务端在 bundle/meta 里带一个 `formalGenerated` 标记替代探测。

## 约束(承自审查与既有批次)

- 审查原文口径:这两项是"UI 顺手项",属重构/整理性质;item 2 明确选择了"服务端带标记"方案(新增只读字段属增量 API 变化,提案已授权)。
- 不动 `src/contracts.ts` 与 `src/adapters/types.ts` 两个已验证的深接缝。
- 用户可见行为:PlanView 的交互与展示不变(只挪代码);formal 探测的网络行为变化(省掉探测 fetch)是 item 2 的目的本身,UI 呈现结果不变。
- 测试口径:`npm test`(vitest)+ `npm run typecheck`(含 ui/tsconfig)全绿。

## 开放问题(留给红队/GRILL)

- `formalGenerated` 放 bundle 响应还是项目详情 meta?(原文说"bundle/meta 里",二选一)
- 探测端点(/versions/:v/formal/:fmt 的 404 探测)是否保留(兼容期)或直接删?
- PlanView 下沉后 state 文件形状(新文件还是并入既有 projectDetail state)?
- ui/ 目录当前无测试,两项改动如何验证(typecheck + 手工? 或补最小测试)?
