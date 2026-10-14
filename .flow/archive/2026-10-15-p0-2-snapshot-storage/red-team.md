# Red-Team: P0-2 快照存储与轮询负载(一文件一快照 + 列表端点剥离 bodyText)

> 评审日期:2026-10-15。评审方式:提案逐条事实核查(对照仓库源码与 research-data 存量数据实测)+ 载荷假设攻击。
> 提案原文:`.flow/proposal.md`。

## 事实核查(提案的证据声明逐条验证)

| 提案声明 | 核查结果 |
|---|---|
| `saveSnapshot` 全量读→追加→整文件重写(fsStore.ts:109-113) | ✅ 属实,`readJson`/`writeFileSync` 整文件往返 |
| 快照含整页 bodyText(contracts.ts:16) | ✅ 属实,`bodyText: z.string()` 必填 |
| 一次 run 最多 60+ 次抓取 | ✅ `DEFAULT_BUDGET.maxFetches=60`(runResearch.ts:46),附件/干预/复用快照另有不入该预算的 saveSnapshot,"60+" 准确 |
| `GET /api/projects/:id` 全量返回快照(server.ts:236) | ✅ 属实 |
| UI 2.5s 固定轮询(projectDetail.tsx:125) | ✅ 属实,且无 running 状态/页面可见性联动,无条件轮询 |
| UI 代码 0 处引用 bodyText | ✅ 属实;且比提案说的更彻底——`ui/state/types.ts:57` 的 `Snapshot` 类型根本没声明 bodyText,剥离后 **UI 零改动即可过 typecheck** |
| 正文按需走 `/snapshots?sid=` | ✅ server.ts:610-621 + projectDetail.tsx:283 |
| `src/stores/fsStore.test.ts` 存在可参照 | ✅(其中 :60 断言 listSnapshots 全字段 toEqual,属本次必改测试) |
| `npm test`(vitest)+ `npm run typecheck` | ✅ package.json:10,9(typecheck 含 ui/ 子工程) |
| research-data 存量数据可用于量化对比 | ✅ 6 个项目有 snapshots.json,92K–1.4M,快照 6–72 个/项目,合计 146 个 |

提案的事实基础全部站得住,无虚构证据。以下攻击针对**提案没说到**的载荷假设。

## Top Kill-Assumptions(ranked:影响 × 可能性 × 验证成本)

### KA1 存量兼容的调用面被提案低估——有一个绕过 store 的直读方,且迁移尚未跑过

- **Claim:** 提案称格式变更的影响面是"`listSnapshots()` 签名对 server、cli、replay 路径",迁移策略"待 PRD/GRILL 定"。
- **Fails if:** PRD 选择"迁移后删除/停用 snapshots.json"而漏掉 `src/app/migrateLibrary.ts:56-59`——它**绕过 FsProjectStore 直接 `readFileSync("snapshots.json")`**,把历史项目快照登记进情报库。本评审实测 `research-data/library/migration-map.json` **不存在**,即该迁移从未真正执行过,6 个存量项目的迁移仍是待办。格式变更后此路径 `existsSync` 落空 → 快照数静默归零 → 项目被错分档为 "report-only"/"empty" 并写入错误的登记记录(不报错、不炸,静默错)。另外 `docs/WHITEPAPER.md:208`、`docs/PLAN-COMPARE.md:69`、`docs/PRODUCT-OVERVIEW.md:203` 与 `.flow/archive/2026-09-23-2.0-library/wp00-audit.md:83` 都把 snapshots.json 文档化为项目存储布局乃至"主记录",不在提案的同步清单里。双格式并存期还必须定义权威源优先级(新目录与旧文件同时存在时谁赢),否则 lazy-migration 后旧文件残留即产生双源漂移。
- **Evidence to get this week:** 本评审已完成——全仓 `snapshots.json` 直读方只有 2 个:`fsStore.ts` 与 `migrateLibrary.ts`(`scripts/backfill-titles.mts` 只碰 library,已排除;golden 测试走 memory store,不碰磁盘格式)。PRD 只需把 migrateLibrary 纳入同一改动范围,并写明双源优先级规则(建议:新格式目录存在即权威,旧文件迁移后改名 `.bak` 而非删除)。
- **Kill criterion:** 若 PRD 阶段再发现第三个无法纳入本周期改动范围的直读方(如外部脚本/其他产品直接读 `research-data/projects/*/snapshots.json`),存储格式变更降级为"仅做端点剥离"或整体延期。当前未触发。
- **Cheapest test:** 已完成的一次全仓 grep(成本 5 分钟);PRD 把它落成"格式直读方清单"检查项即可。

### KA2 列表顺序是隐式契约,一文件一快照会静默打乱它

- **Claim(提案未声明、但 UI 依赖它成立):** `listSnapshots()` 返回顺序 = 采集时间序。
- **Fails if:** 现状下顺序来自 JSON 字典的插入序;UI 两处把它当时间序用——`ui/views/GatherView.tsx:260` `snapshots.slice(-12).reverse()`("最近 12 个快照")与 `ui/inspector/Inspector.tsx:266` `snapshots.slice().reverse()`。一文件一快照后,若实现按文件名(哈希/编码后乱序)或目录序返回,"最近快照"展示静默错乱:无类型错误,现有测试也不必然拦得住(fsStore.test.ts:60 只断言单条 toEqual)。同 id 覆盖写时旧行为是"位置不变、内容更新",若改用 mtime 排序会把它顶到最前——又一个行为分歧点。
- **Evidence to get this week:** 本评审已实测:6 个存量项目全部 146 个快照的 `fetchedAt` **无一重复**,且 contracts 要求 `fetchedAt` 非空——按 fetchedAt 排序可 1:1 复现旧顺序,退路存在。PRD 只需把它写成显式规则(排序键 + 同 id 覆盖时的位置语义)。
- **Kill criterion:** 无延期形态;这是 PRD 必填项——排序规则缺席则不进入实现。
- **Cheapest test:** 一个新单测:乱序文件名写入 3 个快照 + 1 次同 id 覆盖,断言 `listSnapshots()` 顺序与旧字典行为逐位一致(照 fsStore.test.ts 风格,半小时)。

### KA3 sid→文件名映射是注入面,不只是"目录布局细节"

- **Claim:** 提案把"id 含 URL 特殊字符如何转义"列为布局类开放问题。
- **Fails if:** 快照 id 实测形如 `snap:https://…`(含 `/`、`?`、`%`)、`snap:attachment:<路径>`(含 `/`)、`snap:user-text:<id>`、`snap:lib:<versionId>`(runResearch.ts:323/494/504/560/636)。若 `/snapshots?sid=` 的实现从"list+find"改成"按 sid 拼路径读单文件",任何未严格编码的拼接都是路径穿越——`sid=../../project.json` 读本机任意文件。服务虽只绑 127.0.0.1,但触发面就是本机 UI 的一次 fetch,门槛极低。
- **Evidence to get this week:** 无需再取证,id 形状已确认。PRD 必须指定编码方案(建议:文件名 = sha256(id) 前 16 位 hex,id 全文留在文件内,查找走"编码→精确文件名",原始 sid 永不拼路径)。
- **Kill criterion:** 无 kill 形态;这是实现准入条件——PRD 写不出编码与拒绝规则就不开工。
- **Cheapest test:** 一个单测:`GET /snapshots?sid=../../project.json` 与双重编码变体必须 404/400(随 fsStore 新测试一起写,零额外基建)。

### KA4 验证方案只覆盖了头条 claim 的一半

- **Claim:** 提案验证节称"用真实数据对比拆分前后 `GET /api/projects/:id` 响应体积"。
- **Fails if:** 该测量只验证改动②(剥 bodyText)的收益;改动①(一文件一快照,提案自己定位为"最大性能债"的写放大 O(n²))**没有任何量化验证**——响应体积与存储格式无关,格式改了体积一个字节不变。且"前后对比"的基线必须在动手前采集,否则"前"的数字无从谈起;基线今天就能算:六个项目的详情响应体积 ≈ snapshots.json 大小(92K–1.4M),剥离后体积可离线估算,连服务器都不用起。
- **Evidence to get this week:** 动手前对 6 个存量项目记录基线(curl 详情端点计字节,或离线 `JSON.stringify({meta,runs,snapshots})` 长度 vs 剥离 bodyText 后长度),写进 PRD。
- **Kill criterion:** 若进入实现时基线未记录,P0-2 的"量化验证"即降级为不可证——届时成功指标必须改写为"单测与 typecheck 绿",不得事后补造对比数字。
- **Cheapest test:** 写侧收益:照 `src/core/golden.test.ts` 的既有模式——`replayAdapters(golden.calls)` 回放 `testdata/golden/` 夹具,store 换成指向临时目录的 FsProjectStore,对写盘字节计数(在 `writeJson` 包一层或 du 前后差),改造前后各跑一次同一 fixture 对比。沿用现有测试基建、零 API key,约 1 小时。**注意**:CLI 的 `--replay` 路径固定用 `createMemoryStore()`(cli.ts:194)且不读 golden 夹具形状,测不到 fsStore 写盘,不能直接用——这是本评审对常见直觉方案的事先排除。

## What's Well-Reasoned(明确站得住的部分)

- **事实基础零虚构**:9 条证据声明全部复核属实(见核查表),行号、预算值、轮询间隔、UI 零引用均精确。
- **影响面比提案自认的更小,方向安全**:`ResearchStore` 接口(stores/types.ts:11-20)**本就不含 `listSnapshots`**——核心流水线从不列快照,改动面收敛于 FsProjectStore 自身 + server 两个端点 + cli 一处(仅取 length)+ 两个测试文件。提案开放问题里的"replay 路径"实为虚惊:replay 是 adapter 层录制回放,不触 store。UI 侧连类型都不用改(types.ts:57 未声明 bodyText),提案约束里"需同步改 ui/ 消费端"实际会收敛为"回归验证 UI 无依赖"。
- **约束选择正确**:不动 contracts.ts 可行——剥离是 server 序列化层的事,`SourceSnapshot` 契约不变;增量复用按 `evidence.snapshotId` 引用项目级快照,只要 id 不变,复用链不受影响。
- **可选项③的默认是对的**:轮询退避是行为变化(最长 15s 才感知 run 完成),默认不做、与前两者解耦,判断成熟。
- **时机选择合理**:存量仅 6 个项目、UI 零依赖,现在是该改动历史上成本最低的窗口;"顺手做"禁令(P1-3/P1-4 排除)范围纪律清晰。

## What I Couldn't Assess

- **"当前最大的性能债"的相对排序**:提案未给出与其他候选债(如 server.ts 单文件、轮询时 runs 全量重读、启动清扫全项目遍历)的量化对比。绝对量级上,1.4MB/2.5s 在 loopback 的当下痛感有限——这是"增长曲线"判断而非"当下痛点";PRD 的成功指标应对齐体积/字节数,不应承诺用户可感知的提速。
- **一文件一快照 vs 更轻替代方案**:提案未论证为何不选 append-only jsonl + 启动物化索引、或仅给 saveSnapshot 加合并写。一文件一快照与 runs/ 同构、同时顺手修了 `/snapshots?sid=` 的全量读,方向本评审认可,但取舍记录缺失,GRILL 阶段应补一句。
- **多标签页/多项目并发轮询的叠加负载**:单用户本机场景大概率无害,未实测。

## Verdict: **go 附前置条件**

无 kill-assumption 的 kill criterion 已被满足:提案全部事实声明经独立复核属实,改动在自述约束内可行。进入 PRD/GRILL 前必须落定(按优先级):

1. **(KA1)** 影响面清单纳入 `src/app/migrateLibrary.ts:56`(绕过 store 的直读方;迁移从未执行、仍是活路径),写明双格式并存期的权威源优先级;docs 三处存储布局描述列入同步更新范围。
2. **(KA2)** PRD 显式规定 `listSnapshots()` 排序规则(建议 fetchedAt 升序 + 同 id 覆盖位置语义),配 KA2 单测。
3. **(KA3)** PRD 指定 sid/id→文件名编码方案(建议哈希文件名 + 精确匹配,原始 sid 永不拼路径),配路径穿越 404 单测。
4. **(KA4)** 动手前采集六个存量项目的响应体积基线写进 PRD;写放大用 golden-fixture + FsProjectStore 小 harness 补字节数对比(约 1 小时),否则"最大性能债"的验证不可证。
