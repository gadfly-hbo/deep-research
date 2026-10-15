# Red-Team:P2-2 预算与审计正式化 + costEstimate 硬删

> 评审模式:**降级内联**(红队子代理 403 配额,主代理执行;对抗性弱于规格,DONE 披露)。
> **Verdict:go(附一个必须的用户裁决:方案 A vs B)**——其余全部勘误级。

## Top Kill-Assumptions

### KA1 "budget tier → Limits 正式映射"与决策①"放开过多限制"存在字面冲突,方案选择不可自批

- **Claim**:程序规划 P2-2 行(用户批准)写"budget tier → Limits 正式映射";提案推荐方案 A(uncapped 显式化,不新增累计上限),把"映射"降级为"文档化声明"。
- **Fails if**:用户本意是有限 Limits(每档位 modelCalls/token/墙钟硬顶)——方案 A 就是对既定规划的静默 change/drop(规则 5 禁止);反之方案 B 引入 BUDGET_EXHAUSTED 新失败模式与①相悖。
- **Kill criterion**:不由红队裁决——**升级用户单点确认**(推荐 A:①的字面+"动态预算在 P2-6"的分工;B 的硬顶价值在 P2-6 加注场景一并做)。
- **Cheapest test**:无(价值裁决,非事实争议)。

### KA2 costEstimate 消费面比提案的"5 处 UI"大——实测全清单

- **Claim**:提案说"UI 5 处显示点"。
- **Fails if**:漏改任何一处即半成品。实测全清单(rg 全仓):
  - **契约/写入**:contracts.ts:185(schema);projectsRuns.ts:152/173(两条零值记录);runResearch.ts:102/345/389(累计+=,待改为新计量);cli.ts:146/203
  - **UI(6 处)**:StatusBar.tsx:39、GatherView.tsx:99/122、Inspector.tsx:208、PublishView.tsx:84、state/types.ts:53
  - **测试(9 文件)**:contracts.test ×2、fsStore.test、characterization.test ×2、server.test ×2、runResearch.test:108(closeTo 0.02)、polishPass.test:76(≥0.06——**这两条断言成本累计,须改断言新计量**)、resumeV1.test
  - **文档**:WHITEPAPER.md:78、PRODUCT-OVERVIEW.md:51/58/144(历史案例成本数字 :264/265 是历史记录,保留原文加注即可)
  - **replay.ts:22/26**:ModelResponse.cost 字段(夹具格式)
- **Kill criterion**:PRD 必须挂此全清单为验收基线;漏一处即 FAIL。
- **Cheapest test**:改完后 `rg costEstimate src/ ui/` 应只剩 zod strip 注释(或零命中)+ 历史文档注记。

### KA3 ModelProvider 返回值加 usage 牵动 recording/replay 夹具格式

- **Claim**:"piRuntime 返回值需带 usage——接口变更点"一句带过。
- **Fails if**:ModelProvider 契约改 `{output, cost}` → `{output, usage}`,recording.ts(包装 live 记录)与 replay.ts(夹具查找,含 `cost: number` 字段定义)连带;testdata/v1-bundle-sample.json 若含模型响应条目亦连带;**夹具格式是 P1-3 明示不动的**——本批必须动它,属既定契约变更的必然后果,须在 PRD 显式声明。
- **Kill criterion**:PRD 不写夹具格式变更即 FAIL。
- **Cheapest test**:改后 `npx vitest run src/adapters/replay.test.ts` 绿。

### KA4 zod 对存量 costEstimate 字段的行为——"strip 而非拒"需要真配置才成立

- **Claim**:提案说"zod schema 对存量宽容(strip)"。
- **Fails if**:contracts 的对象 schema 若非默认 strip(zod 默认 strip unknown keys ✓,但需确认无 .strict());**嵌套 strip 只在 parse 时发生**——fsStore 读旧记录 parse 后内存对象已无 costEstimate,但**磁盘旧文件不动**(提案已定不迁移,OK);反向风险:UI types.ts 与 server 端新记录写 modelCalls/outputTokens,**旧客户端读新记录**不存在(单机同批升级),无兼容问题。
- **Kill criterion**:删字段后用存量 research-data 真数据跑一次详情端点(server 起真数据)读旧 run 不炸。
- **Cheapest test**:真数据 curl(冒烟步骤)。

### KA5 Map 剪枝与 lease 语义:剪 owner-less 条目安全,量级可量化

- **Claim**:"简单 Set 上限 + FIFO 剪枝"。
- **证据**:budget.js:67 `release` 只 `delete state.owner`,条目留 Map(usage 历史);子 taskId 唯一不复用 → 释放后条目永不再 claim,**剪枝无语义损失**;量级:单 run 15-40 调用 × 条目 ~200B,千 run ≈ 3-8MB——**量级无害,剪枝可降级为可选**。但 channelCache/budget store 都在 piRuntime 模块级单例,server 长跑数月才到 MB 级。
- **修正**:PRD 把剪枝降为"上限保护(如 10 万条 FIFO,超限剪最老已释放条目)"或直接书面接受+文档,不做过早工程。**推荐:上限保护 20 行内**。

### KA6 审计轮转的并发安全与阈值

- **appendFile 进行中 rename**:appendFile 打开的是旧 inode,继续写到被改名文件直到本次结束——单进程内 sink 的 append 是 await 串行调用(runtime 单 run 排队 + 我们的调用方多数串行),实际竞窗极小;**但多路并发 run(P2-1 (b) 测试)下两个 append 同时进行时 rename 可能撕裂**。修正:轮转判定放 append 前,且用"写前检查大小"策略(rename 后立即新开写,竞窗内最多丢 1-2 行审计行,可接受并披露)。
- 50MB 阈值:P2-1 实测 4 事件×~400B/调用,千 run ≈ 25-65MB——阈值合理;保留一代(.1)总上限 ~100MB。

## 开放问题裁决建议

1. **历史数据展示**:磁盘旧记录的 costEstimate 在 zod strip 后不再出现于 API/UI——**原样消失,无迁移**(推荐,④的彻底执行);PRODUCT-OVERVIEW 历史案例数字是文档叙事,加一行"成本口径已于 P2-2 退役"注记,不改历史数字。
2. **计量颗粒度**:run 级累计(modelCalls/outputTokens 两个整数),不分桶——状态栏格式"模型 N 次 · 输出 M tok",替换原成本位;GatherView 指标卡同步。
3. **fsync**:维持无 fsync(披露已有);轮转补"写前检查"即可。
4. **Map 剪枝**:上限保护 10 万条 FIFO(仅剪已释放),20 行内;不做定时器。

## What's Well-Reasoned

- 方案 A 的技术论证(uncapped=现状等价、B 引入新失败模式、动态预算属 P2-6)成立;审计轮转做而不过度(两代上限);项目级 audit.jsonl 不引入模型事件的克制正确(taskId 前缀已可关联)。
- "不动 tier 的 search/fetch 语义、不动三分映射/真值表/单次保护"边界清晰。

## What I Couldn't Assess

- 方案 A/B 的用户真实意图(KA1,升级);polishPass 等测试改动后的断言强度(实现期看)。
