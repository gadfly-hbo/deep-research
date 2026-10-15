# P2-2 任务切片(预算放开+计量+costEstimate 退役)

来源:`.flow/prd.md`(用户裁决 A + 红队 KA1-6 + GRILL R1-7)。实现中切片 A/B/C 融合为两个连贯提交(契约计量一体变更 + 存量兼容修复),自批准:auto,机械耦合不可分。

- [x] 1. 契约+适配器+核心计量+UI+审计卫生(bd04af3) — 证据:349 测试全绿(重录金样本 3 条);typecheck+build 过;`rg costEstimate src/ ui/` 仅 2 处历史注释;runResearch wrapper 统一累计(修复过一次自递归事故,测试当场抓住);budgetTracker 成本死分支删;UI 6 处改模型用量;轮转+重建计数入 piRuntime
- [x] 2. 存量兼容修复(2ca13b2) — 证据:冒烟实测存量详情原样透传(readJson 不过 schema)→ readRun helper 统一 run 读路径;复验:全部旧记录无 costEstimate、有 modelCalls(default 0)
- [x] 3. 真实冒烟 — 证据:存量项目详情 ✅;真实 plan-preview 200/4.1s/10 问 + `usage:{modelCalls:1,outputTokens:291}` ✅
