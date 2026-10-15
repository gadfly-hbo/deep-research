# P2-2 交接卡(预算放开 + 计量 + costEstimate 退役)

## 本批交付

- **预算放开**(用户裁决"干脆放开",方案 A):模型侧 uncapped+单次保护(300s/32k)显式声明为宿主策略(piRuntime buildLimits 注释,引标准 P4);budgetTracker 成本死分支删除;tier 的 search/fetch/墙钟语义不动,动态预算归 P2-6。
- **计量进 usage**:`RunUsage` 契约 `costEstimate` → `modelCalls/outputTokens`(zod default(0));ModelProvider 返回 usage;runResearch wrapper 统一累计(10 调用点零改动);预览端点 cost→usage。
- **costEstimate 全量退役**:KA2 冻结清单全落实——契约/CLI/UI 6 处/26 个测试文件/文档 3 处/replay 夹具/金样本重录;`rg costEstimate src/ ui/` 仅历史注释。
- **存量兼容**:fsStore readRun 统一 run 读路径过 schema(冒烟实测原样透传缺陷后修复)——旧记录 costEstimate strip、新字段兜底 0。
- **审计卫生**:model-audit.jsonl 轮转两代上限(50MB×2);runtime 调用计数 10 万次重建(含 lastProviderByTask 清理)。
- 推送 `9f97393..2e5a36e`(6 commits:归档 P2-1 + 2 实现 + 2 评审收尾 + 工件)。

## 验证状态

- `npm test` 57 文件 **350** 全绿 + typecheck 0(SHIP 前 fail-closed 重跑过);build 过。
- REVIEW 两轮均全新子代理(agent-33/37):R1 PASS+7 non-blocking → CONVERGE 上调 4 blocking 修复(6e59987)→ 复审 PASS(缩进项 fixup 03886a2)。
- 真实冒烟:存量项目详情旧记录全部无 costEstimate/有 modelCalls;真实 plan-preview `usage:{modelCalls:1,outputTokens:291}`。
- 本批红队与 GRILL R1 为降级内联(403 配额);REVIEW 两轮非降级。

## 遗留(下批输入)

1. **P2-3 会话底座**(下一批):SessionRuntime、项目=会话、checkpoint 确认门、崩溃恢复——规格源 docs/PLAN-AGENTIZATION.md。
2. 预览端点 usage 字段无 UI 消费(纯披露 API 面);per-stage 计量分桶未做(run 级累计)。
3. 审计无 fsync(断电丢尾)与轮转竞窗(≤2 行)——披露接受。

## 下一批前置

- 工作区干净;ui-dist 已含本批 UI(启动脚本 build-head 自动重建亦会覆盖)。
- research-data/model-audit.jsonl 本机文件(gitignore),长跑超过 50MB 自动轮转。
