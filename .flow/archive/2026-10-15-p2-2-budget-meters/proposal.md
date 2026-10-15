# 提案:P2-2 预算与审计正式化 + costEstimate 硬删

> 来源:docs/PLAN-AGENTIZATION.md P2-2 行(用户四决策之④:成本估算去掉,不用估算)+ P2-1 handoff 遗留清单。前置 P2-1(9f97393)已完成:piRuntime 唯一接点、uncapped 五键 limits、workspace 级 model-audit.jsonl、costEstimate 恒 0。
> 规格:~/Dev/Projects/pi-agent-runtime/docs/AGENT-RUNTIME.md(P4 累计策略显式选择/P5 审计口径)。

## 背景(现状事实)

- **预算现状**:budget tier(low/medium/high)只管**产品侧** search/fetch 配额与 maxParallel(runResearch 内联计数);模型侧 P2-1 起为 uncapped+单次保护(300s/32k),无累计上限。P2-1 决策④已废成本估算(costEstimate 恒 0,字段仍在契约)。
- **计量现状**:ResearchRun.usage = {searches, fetches, costEstimate, wallMs};模型调用次数/token 在 runtime Usage 里可得但未进 run 记录。
- **审计现状**:model-audit.jsonl(workspace 级、gitignore、无轮转、无 fsync);memory BudgetStore Map 按子 taskId 只增不减(每调用一条,数百 B);channelCache 多实例可能性。
- **P2-1 遗留**:UI 状态栏等 5 处成本显示点;存量 run 记录含 costEstimate 字段(数据兼容)。

## 本批内容

### 1 costEstimate 整体移除(决策④)

- contracts.ts 的 usage 形状:删 costEstimate,**新增 modelCalls/outputTokens 计量字段**(token/次数保留,决策④原文);zod schema 对存量数据的 costEstimate 字段宽容(strip 而非拒)。
- runResearch 计量改接:extract/stage 调用后从 piRuntime 返回的 usage 累计(piRuntime 的 ModelProvider 返回值需带 usage——接口变更点)。
- UI 清理:状态栏/详情/预算提示等 5 处成本显示点改为"模型调用 N 次 · 输出 M tokens"或移除;文案随计量语义更新。
- 数据兼容:存量 run/bundle 记录不迁移(zod strip 即可读),报告理由汇总中的成本口径措辞清理。

### 2 预算策略显式化(不新增累计上限——与决策①"放开过多限制"一致)

- **推荐方案 A(本提案采纳)**:模型侧维持 **uncapped + 单次保护**(P2-1 形态)作为**显式声明的宿主策略**(标准 P4"宿主明确选择");tier→Limits 的"正式映射"落为:**每档位显式声明单次保护参数**(超时/输出上限不变)并写入文档与 config 注释,不引入累计 modelCalls/token/墙钟上限。理由:①用户"放开过多限制";②累计上限会引入 BUDGET_EXHAUSTED 新失败模式(行为变化);③动态加注属 P2-6。
- 产品侧 search/fetch 配额(tier 既有语义)不动。
- **方案 B(被否,记录)**:tier → 有限 Limits(modelCalls/outputTokens/wallTime 按档位)——引入新失败模式与 UI 文案面,与①相悖;若红队/GRILL 认为必须有硬顶,升级用户裁决。

### 3 计量与账本卫生

- piRuntime:ModelProvider 返回值增加 usage(modelCalls/outputTokens);channelCache 清理(同 configs 复用已做,补:跨 run 的 budget store Map 条目在 run 结束后清理或上限剪枝——简单 Set 上限 + FIFO 剪枝,防 server 长跑线性增长)。
- memory 账本不升级为持久账本(本机单用户 + uncapped 名义额度,持久化属过度工程;P2-4 采agent化时随任务粒度重构一并评估)——书面记录该裁决。

### 4 审计口径

- model-audit.jsonl 保留策略:**按大小轮转**(超过 ~50MB 改名 .1 保留一代,继续写新文件;两文件合计上限 ~100MB)——零依赖、防无界。
- 项目级 audit.jsonl 不引入模型事件(taskId 前缀 `dr:${callKey}` 已可关联,聚合查询留 P2-4 调查流视图时按需)。

## 约束

- HTTP API 形状:usage 字段变化(删 costEstimate/加 modelCalls/outputTokens)为**既定契约变更**(④授权),UI 与 server 同批同步;其余路由行为不变。
- 不动:tier 的 search/fetch 语义、piRuntime 三分映射/真值表/单次保护参数、审计事件形状(version 1.0)。
- 测试口径:npm test + typecheck 全绿;受影响测试(runResearch/server/ui 相关断言)同步更新。

## 开放问题(红队/GRILL)

1. usage 契约变更的兼容边界:zod strip 存量 costEstimate 后,报告 reason 汇总/导出 bundle 里历史 costEstimate 数据是否需清理或原样保留展示?
2. modelCalls/outputTokens 计量的颗粒度:run 级累计(推荐)vs 按阶段分桶;UI 状态栏展示格式。
3. 轮转的并发安全(append 中途改名)与 fsync(是否补 F_OK 检查级 durability,或维持无 fsync 披露)。
4. budget store Map 剪枝的实现位置(piRuntime 内 vs 忽略——量级评估:单 run 15-40 调用 × 千 run 级 = 数万条 × 数百 B ≈ 数十 MB?server 长跑风险量化)。
