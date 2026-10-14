# 提案:P0-2 快照存储与轮询负载(当前最大的性能债)

> 来源:2026-10-14 重构审查(基于 codebase-memory 图谱 + 核心文件通读),用户以 `/dev-flow P0-2` 选定本提案为范围。
> 同一审查的 P0-1(runResearch 内部分解)已于 2026-10-15 完成并归档;P1-3(server.ts 拆分)、P1-4(UI)不在本次范围,不得顺手做。

## 背景证据(已核实)

两个叠加的问题,证据链完整:

1. **写放大**:`src/stores/fsStore.ts:109-113` 的 `saveSnapshot` 每次把整个 `snapshots.json` 全量读入→追加→整文件重写,而快照含整页 `bodyText`(`src/contracts.ts:16`)。一次 run 最多 60+ 次抓取,等于把全部已采正文反复重写 60 遍,O(n²) 字节写入。
2. **读放大**:`GET /api/projects/:id`(`src/server/server.ts:236`)返回 `listSnapshots()` 全量含正文,而 UI 以 2.5s 固定轮询(`ui/state/projectDetail.tsx:125`)。实测 UI 代码 0 处引用 `bodyText`(正文按需走 `/snapshots?sid=`),这些字节纯属白传,payload 随研究规模线性膨胀。

## 建议(提案级决策)

1. 快照改为一文件一快照(与 `runs/` 目录同构)。
2. 列表型端点剥离 `bodyText`,只在 `?sid=` 详情端点返回。
3. 轮询节奏可顺带与 run 状态联动(无 running run 时退避到 15s)——但这是行为变化,可与前两者解耦,**默认不做,除非实现中发现解耦成本高于收益**。

## 约束

- 全程不动 `src/contracts.ts` 与 `src/adapters/types.ts` 这两个已验证的深接缝。
- 存储格式变更必须考虑 `research-data/` 存量数据:已有项目的 `snapshots.json` 要么迁移、要么兼容读取——具体策略待 PRD/GRILL 定。
- HTTP API 形状变更影响 UI 调用点,需同步改 `ui/` 消费端(列表端点不再带 bodyText 后,UI 不得有任何地方依赖它——审查已实测 0 处引用,改动应是纯减负)。

## 验证

- 本项目测试口径:`npm test`(vitest)+ `npm run typecheck`。
- 量化验证:用 `research-data/` 真实项目数据对比拆分前后 `GET /api/projects/:id` 的响应体积。
- fsStore 的读写路径改动需补与现有 store 测试同风格的单测(参照 `src/stores/fsStore.test.ts`)。

## 开放问题(留给 PRD/GRILL)

- 一文件一快照的目录布局与文件名规则(id 含 URL 特殊字符如何转义)。
- 存量 `snapshots.json` 的迁移策略:启动时自动迁移 / 读取时双格式兼容 / 提供一次性迁移脚本。
- `listSnapshots()` 接口签名变化对 fsStore 以外调用方的影响面(server、cli、replay 路径)。
- 轮询退避是否纳入本次(提案默认不做)。
