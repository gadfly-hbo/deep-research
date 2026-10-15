# P2-2 PRD:预算放开 + 计量进 usage + costEstimate 硬删 + 审计轮转

> 规格源:`.flow/proposal.md` + 用户裁决(2026-10-15"干脆放开预算"= 方案 A)+ 红队 KA1–KA6(降级内联,全部并入)。无 issue tracker,落盘本文件。

## Problem Statement

P2-1 后模型侧为 uncapped+单次保护但未显式声明;costEstimate 恒 0 却仍占契约/UI/测试;模型调用计量(modelCalls/outputTokens)在 runtime 可得但未进 run 记录;model-audit.jsonl 无轮转;budget store Map 无界。

## Solution

预算干脆放开(用户裁决):模型侧 uncapped+单次保护**显式声明**为宿主策略,零累计上限工程;计量进 usage 并替换成本显示;costEstimate 全消费面硬删;审计轮转两代上限。

## User Stories

1. 作为用户,我要预算放开无累计上限,以便研究不被静态档位掐断(单次 300s/32k 保护保留防挂死)。
2. 作为用户,我要状态栏显示真实用量(模型次数/输出 token),以便替代已退役的成本数字。
3. 作为维护者,我要 costEstimate 零残留,以便契约/测试/UI/文档口径一致。
4. 作为维护者,我要审计文件与账本 Map 有界,以便 server 长跑不膨胀。

## Implementation Decisions

### D1 预算策略显式声明(用户裁决:方案 A)

- piRuntime 内 uncapped+单次保护(300s/32k)注释升级为**宿主策略声明**(引标准 P4 与用户裁决);不做 tier→有限 Limits 的任何映射。
- search/fetch 产品侧配额(tier 既有语义)**本批不动**——动态预算/放开属 P2-6,不静默扩 scope。

### D2 计量进 usage(契约变更,④授权)

- `RunUsage` zod:`{ searches, fetches, costEstimate, wallMs }` → `{ searches, fetches, modelCalls, outputTokens, wallMs }`(modelCalls/outputTokens 均 int 非负;zod 默认 strip 存量 costEstimate 字段,旧记录可读,无迁移)。
- **ModelProvider 返回值**:`{ output, cost }` → `{ output, usage: { modelCalls: number; outputTokens: number } }`:
  - piRuntime:runTextRaw 返回值携带 result.usage(modelCalls 1/次,outputTokens 按 Usage)。
  - recording.ts 记录新形状;replay.ts 夹具 `cost: number` 字段改 `usage: { modelCalls, outputTokens }`(testdata 夹具同步);**夹具格式变更在本批被④授权**(P1-3"不动夹具"约束就此突破,显式记录)。
- runResearch 累计:`run.usage.modelCalls += usage.modelCalls; run.usage.outputTokens += usage.outputTokens`(替换原 costEstimate +=);server 两条零值记录(projectsRuns.ts:152/173)与 characterization 断言同步。
- fake adapters(各测试)返回 usage:{modelCalls:1, outputTokens:0} 或类似确定性值。

### D3 costEstimate 全消费面清理(红队 KA2 冻结清单,验收基线)

契约 schema / projectsRuns ×2 / runResearch ×3 / cli ×2 / UI 6 处(StatusBar:39、GatherView:99/122、Inspector:208、PublishView:84、types:53)/ 测试 9 文件(contracts.test ×2、fsStore.test、characterization ×2、server.test ×2、runResearch.test:108 改断言 modelCalls、polishPass.test:76 改断言 outputTokens 累计、resumeV1.test)/ WHITEPAPER.md:78 与 PRODUCT-OVERVIEW.md:51/58/144 口径更新(历史案例数字 :264/265 保留原文,文首加"成本口径已于 P2-2 退役"注记)/ replay 夹具 cost 字段。
验收:`rg costEstimate src/ ui/` 零命中(或仅历史注释放注释);docs 仅历史注记。

### D4 UI 用量显示(6 处文本替换,无表面增删)

- 状态栏/详情/指标卡/运行行:`成本≈X.XXX` → `模型 N 次 · 输出 M tok`(与 搜索/抓取 并列,格式与现有一致);types.ts usage 形状同步。无新组件、无布局变化。

### D5 账本与缓存卫生

- budget store Map:**上限保护 10 万条 FIFO,仅剪已释放(owner 为空)条目**(红队 KA5:释放后条目永不再 claim,剪枝无语义损失;量级实测千 run 仅 3-8MB,保护为防数月长跑)。
- channelCache:维持(单 configs 单实例),注释补"configs 变体场景由 P2-4 账本重构一并清理"。

### D6 审计轮转(红队 KA6)

- 写前检查:`append` 前若文件 > 50MB → rename 为 `.1`(覆盖旧 `.1`,总上限 ~100MB)再写。竞窗(并发 append 中 rename)最多丢 1-2 行审计行——披露接受;无 fsync(披露保留)。

## Testing Decisions

- 单测:piRuntime usage 透传(合成 transport);runResearch 累计(fake adapters 返回确定性 usage,断言 run.usage.modelCalls/outputTokens);replay 夹具新形状回放绿;zod 存量兼容(带 costEstimate 的旧对象 parse 后字段被 strip、新字段缺省 0)。
- 表征/服务端测试按 KA2 清单同步(零值记录、断言更新)。
- 全仓 `npm test && npm run typecheck`;UI 改动后 `npm run build` 过(vite 构建含 ui)。
- **真实数据冒烟**:起 serve 读 research-data 存量项目详情(旧 costEstimate 记录)→ 200 且 usage 无 costEstimate 字段(KA4 钉死 strip 行为);一发真实 plan-preview → 新 run 记录 usage.modelCalls ≥1。

## Out of Scope

P2-3+ 会话化;search/fetch 配额放开或动态预算(P2-6);持久账本(P2-4 评估);模型事件入项目级 audit.jsonl;polishPass 等测试的断言重设计超出计量替换所需。

## Further Notes

- 用户裁决原文:"能不能干脆一点,放开预算"(方案 A,零累计上限)。
- 方案 B(静态硬顶)被否,记录于 PLAN-AGENTIZATION.md。

---

## PRD diff gate 记录(auto)

相对 proposal:全部为红队勘误/裁决并入或新增细化,无 change/drop 已决事项——
1. 用户裁决 KA1:方案 A 确认(否决 B)——**这是用户对提案自身开放问题的裁决,非自批**。
2. 勘误:消费面 5 处→实测全清单(D3);ModelProvider 变更牵动夹具格式(D2,显式声明);Map 剪枝降级为上限保护(D5);轮转改写前检查+竞窗披露(D6)。
3. 新增:D4 UI 文本替换细节、D2 zod strip 验证、真实数据冒烟步骤。

---

## GRILL 第 1 轮决议(降级内联:子代理 403 配额,主代理自审,history 记录)

1. **R1-1 zod 缺省(勘误)**:旧记录无 modelCalls/outputTokens,必填会拒——两字段 `z.number().int().nonnegative().default(0)`(strip 旧 costEstimate + 缺省新字段,旧数据可读)。
2. **R1-2 累计挂点(勘误)**:实测 5 处 extractClaims + 5 处 runStage 调用点(非 PRD 所写 3 处)——**runResearch 入口 wrap model provider**(5 行 wrapper 自动累计到 run.usage),10 个调用点零改动。
3. **R1-3 夹具**:replay.test 内联夹具与 recording 写盘形状随 ModelProvider 变更同步;testdata/v1-bundle-sample.json 无模型响应条目(实测无涉)。
4. **R1-4 usage 断言**:备用切换每 attempt 计 1 modelCall;outputTokens 含保守预留——测试先实测合成 transport 的确定返回再钉精确值。
5. **R1-5 Map 上界(勘误:剪枝不可行)**:createMemoryBudgetStore 内部 Map 不可达(budget.js 闭包)——改为**调用计数 ≥100_000 时置空 runtime 单例下次重建**(子 taskId 唯一,重建无语义损失,5 行实现)。
6. **R1-6 轮转**:append 前 stat 检查 >50MB → rename `.1`(覆盖);自定义 auditPath 同规则。
7. **R1-7 UI 格式**:`模型 {modelCalls} 次 · 输出 {outputTokens} tok`(原始数字,不缩写);GatherView 指标卡同。

## GRILL 第 2 轮(主代理)

无新开放问题(polishPass 断言重设计细节、replay 夹具实例形状为实现期确认)→ **收敛(2 轮)**。本批有用户可见 UI 范围(6 处文本替换)→ UI-GATE。
