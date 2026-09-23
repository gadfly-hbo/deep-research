# 第一期成功标准核查记录

核查日期:2026-09-21。环境:无外部密钥,全部可自动验证项以录制夹具/集成测试完成;live 项明确标注挂起。

| # | 成功标准 | 结论 | 证据 |
|---|---------|------|------|
| 1 | 品牌研究模块独立完成一项真实任务,结论有据可查,未验证内容明确标注 | **挂起(待 live)** | 模块配置/模板/专项质量检查已由夹具测试验证(`src/modules/modules.test.ts`:章节齐全正常交付、缺章节有限交付);B1 真实任务跑待密钥 |
| 2 | 行业研究模块独立完成一项真实任务,数据口径清晰,冲突来源得到解释 | **挂起(待 live)** | 同上;口径冲突检测与披露已由 `calibrationChecker` + 流水线测试验证(unit-mix/value-conflict → 报告「口径冲突披露」节);I1 待密钥 |
| 3 | 不安装、不启动、不连接 JuanerAI 完成研究全流程 | **通过** | 无任何 JuanerAI 依赖;`src/server/server.test.ts` 集成测试覆盖 创建→计划→运行→发布→导出 全流程;`serve` 冒烟通过(仅 127.0.0.1) |
| 4 | 保存项目、重新打开、补充证据、重新评审、导出成果 | **通过** | 重开可读回(`fsStore.test.ts`);补证/重审 = 新 run + 不可变新版本 + 差异摘要(`projectService.test.ts`);导出 zip 含 report.md/report.html/manifest/evidence(`exportBundle.test.ts` + 集成测试) |
| 5 | 资料不足时有限交付,不编造完整答案 | **通过** | 预算到顶→有限交付+未解决问题清单;引句命中率 <80%→有限交付;高风险不可修复→降级为未验证(`pipeline.test.ts` 三个用例) |

## 安全默认核查

| 项 | 结论 | 证据 |
|---|------|------|
| 服务仅监听 127.0.0.1 | 通过 | server 集成测试断言绑定地址 |
| 密钥不经 API / 不进项目文件、日志、报告 | 通过 | POST /api/settings 含密钥字段 → 400;GET 剥除 key/token/secret 字段 |
| 配置文件 0600 | 通过 | 写入时 `chmodSync(0o600)` |
| 来源内容不可信 | 通过 | 快照端点仅 text/plain 净化正文;导出 HTML 全文转义(`<script>` 注入用例) |
| 失败不冒充完成 | 通过 | 阶段失败/崩溃 → run 落 `failed` 并带错误信息(server 测试);取消保留检查点 |

## 运行可靠性核查

- 取消:进行中取消 → `cancelled`,已完成阶段检查点保留(server 集成测试)。
- 恢复:同一 requestId 重跑 → 自最后完成阶段续跑,已完成调用不重放(pipeline 测试断言搜索次数不变)。
- 版本不可变:同一 run 二次发布被拒绝;版本目录已存在则拒绝写入。

## 遗留挂起项(等密钥/配额)

已接好并实测(2026-09-21):
- **模型主备链路**(minimax-cn 主 → xiaomi-token-plan-cn MIMO 备):minimax 配额耗尽(402/2067)时自动切 MIMO,`extractClaims` 与 `plan` 阶段均拿到真实结构化输出 ✓(`scripts/probe-model.mts`)。
- **MiniMax MCP web_search**:initialize 握手、tools/list(web_search/understand_image)通过;tools/call 到达服务侧,返回 2067 配额错误(文本形式)→ 适配器检出后显式抛出,不伪装"无来源"(`mcpSearch.test.ts` 含该用例)。
- **搜索实况**:MiniMax web_search 与 LLM 同受 token plan 配额约束;DDG lite 被反爬拦截,不作兜底。

仍挂起:
- B1 / I1 live 验收跑(等 kill 判据升级结论,见下)。

## S1 live spike 结果(2026-09-21,已完成)

10 个真实问题(品牌/行业混合),gather-only 路径;minimax 全程 402 不可用,**模型与搜索均由 Xiaomi MIMO 承担**(web_search annotations 实测可用)。录制夹具:`testdata/live-s1.json`(可 replay 回归)。

- **引用可验证率(引句在快照原文逐字命中):0.763** —— 低于 0.80 阈值
- **来源可达率:0.80** —— 高于 0.60 阈值 ✓
- 逐问可验证率:[0.50, 1.00, 0.93, 1.00, 0.81, 0.91, 0.44, 0.50, 1.00, 0.75]
- 用时:10 问共 ~22.8 分钟(均值 ~137s/问,1 搜 + 2 抓 + 2 抽取);成本:MIMO 自定义 provider 未配置计价,usage.cost 记 0(已知缺口)
- **kill 判据触发(0.763 < 0.80),按 S1 验收条款升级用户**。注意口径:红队判据原文是"评审修复后"的可验证率;spike 量的是**评审前**原始抽取保真度。Q1/Q7/Q8(0.44~0.50)拉低整体,失败形态是模型转述而非逐字引用。
- 过程修复的真实缺陷:calibration 空字段击穿 zod、失败路径 MCP 子进程挂住、failover 不透传 close、xiaomi 搜索超时过短。

## B1 / I1 live 验收跑结果(2026-09-21,已完成)

**B1 品牌研究(Anker)**:run `8347724b`,状态 `limited`,8.8 分钟,4 搜 6 抓,$0.0107;80 主张(14 fact 存活,**14/14 引句全命中**),预降级命中率 18% → 门禁正确触发降级/披露/有限交付;报告含品牌档案等结构化章节;3/6 快照解析失败(JS 重页面)。
**I1 行业研究(中国咖啡零售)**:run `74dd78d7`,状态 `limited`,15.9 分钟,4 搜 6 抓,$0.056;87 主张(54 fact 存活,**54/54 引句全命中**),预降级命中率 78%(距 80% 阈值一线);6/6 快照解析成功;口径冲突披露在真实数据上检出单位混用;draft 输出不合格被护栏降级为证据摘要草稿(未击杀 run)。
两 run 均已发布为不可变 v1(差异摘要齐全)。

**结论:成功标准 1/2 的"独立完成真实任务、结论有据可查、未验证内容明确标注"达成——有限交付形态**;存活 fact 主张 100% 可核查,缺口全部显式披露,无一编造。已知改进项:抽取保真度(预降级命中率 18%~78%)、预算相对计划问题数偏紧、口径单位字符串比较偏严(「万亿元人民币」vs「万亿元」)、draft JSON 解析鲁棒性。

## 故障复盘(2026-09-21,I1 三连败根因)

1. minimax 中途 429 → pi-ai 默认内部重试 2 次等 retry-after → 被我方 150s 信号中止 → 错误变形为 "aborted" → 熔断 minimax;
2. 150s 对推理模型大快照抽取不够(实测单次最长 199.5s);
3. 链路错误只报最后一家,minimax 真实错误被吞。
修复(全部单元测试覆盖,69/69):`maxRetries:1 + maxRetryDelayMs:5s` 快速失败(故障转移归主备链路);模型超时 300s(env `DR_MODEL_TIMEOUT_MS` 可配);瞬时错误判定涵盖中止/超时/连接/5xx;熔断器(连续 2 次瞬时失败冷却 10 分钟);失败信息聚合各 provider 错误;`DR_DEBUG` 计时日志。验证:minimax 单发 14.7s 正常、真实 7.2k 字快照链路抽取 69.1s、I1 复跑全程无中断。

---

# 2.0 外部情报库与跨研究复用 验收核查记录

核查日期:2026-09-23。环境:无外部密钥;全部用例以 vitest 集成测试完成(40 文件 / 208 测试全绿),UI 以 typecheck + vite build 校验;live 真实任务回归挂起(待密钥)。

## U2 必交功能

| # | 功能 | 结论 | 证据 |
|---|------|------|------|
| U2-01 | 资料直接入库 | 通过 | `library/assetService.test.ts`(文件/链接/批量逐项/50MB 上限);`server/libraryRoutes.test.ts`(不建研究可入库、SSRF 拒绝) |
| U2-02 | 研究过程留档 | 通过 | `core/researchArchiving.test.ts`(gather 即沉淀、证据带版本+待核验、中断保留、登记失败披露) |
| U2-03 | 资产列表与详情 | 通过 | `server/libraryRoutes.test.ts` + `ui/views/LibraryView.tsx`/`AssetDetailView.tsx`(三区、解析缺口可见) |
| U2-04 | 品牌/行业整理 | 通过 | `server/librarySearchRoutes.test.ts`(实体创建/关联/聚合计数);不自动合并(契约 confirmStatus/basis) |
| U2-05 | 检索与筛选 | 通过 | `library/searchIndex.test.ts`(中文 bigram/英文别名/数字口径冻结夹具)+ `searchService.test.ts`(授权过滤/索引重建) |
| U2-06 | 加入研究与版本绑定 | 通过 | `library/reuse.test.ts` + `core/reuseIntegration.test.ts` + `server/reuseRunRoutes.test.ts`(越权拒绝、绑定与使用记录独立) |
| U2-07 | 去重与版本管理 | 通过 | 内容哈希精确去重(assetService/migration 测试);同源转引=上游引用字段+人工同源待确认(契约 origin) |
| U2-08 | 生命周期与复用控制 | 通过 | `library/lifecycle.test.ts`(撤回禁新用/归档需复核/删除需确认)+ `changeReuseScope`(带依据审计) |
| U2-09 | 历史项目兼容 | 通过 | `app/migrateLibrary.test.ts`(三档分档/登记级/幂等/不搬文件);真实数据仅只读统计(WP00) |
| U2-10 | 成果包与运行回归 | 通过 | `app/exportBundle.test.ts` + 验收闭环测试(2.0 manifest/omissions/permitted_assets);双模块回归 208 绿 |

## 验收用例映射(§17.2/17.3 可自动化部分)

| 用例 | 覆盖测试 |
|------|----------|
| A-01 空库可研究 | 一期全套 + reuse 集成测试(无 library 选项路径不变) |
| A-02 只导入不研究 | libraryRoutes.test.ts |
| A-03 只登记≠已读 | assetService.test.ts / libraryRoutes.test.ts(DISCOVERED 断言) |
| A-04 解析缺口可见 | assetService.test.ts(PDF failed)+ AssetDetailView 展示 |
| A-05/A-18 样本边界 | reuseIntegration/acceptanceLoop(scopeNote 保留「不代表全行业」) |
| A-08 转引不升级 | 契约 origin.obtainedUpstream + checkReuse 派生/线索规则(reuse.test.ts) |
| A-09 同源不重复计数 | 存储层内容去重 + acquisitions 独立(assetService/migrate 测试) |
| A-10 自有报告派生 | reuse.test.ts(derivedFromRunId → LEAD_ONLY) |
| A-12 跨任务独立绑定 | reuseIntegration/acceptanceLoop |
| A-13 更正不静默替换 | lifecycle.test.ts + governance 路由测试 |
| A-15 截止点 | reuse.test.ts(asOf 晚于 published → NEEDS_REVIEW) |
| A-16 只有报告不伪造 | migrateLibrary(仅登记快照;无快照项目 tier=empty 不登记) |
| A-17 索引故障 | searchService.test.ts(删除后重建/状态可见) |
| S-01 跨项目不泄露 | searchService.test.ts + librarySearchRoutes.test.ts |
| S-02 授权不串用 | assetService.test.ts(同内容两取得记录权利独立) |
| S-04 导出许可 | acceptanceLoop.test.ts(omissions/permitted_assets 断言) |
| S-06 SSRF | assetService.test.ts + libraryRoutes.test.ts |
| S-07 撤回/删除 | lifecycle.test.ts + governance 路由测试 |
| S-09 幂等 | assetService/bindAssets 幂等键测试 |
| S-10 中断保留 | researchArchiving.test.ts |
| S-11 登记失败披露 | researchArchiving.test.ts(limitations 断言) |
| S-12 索引重建一致 | searchService.test.ts |
| S-14 多格式一致 | exportBundle 测试 + acceptanceLoop(manifest 2.0) |
| S-15 核验后修改重查 | 发布门禁:撤回阻断→恢复放行(acceptanceLoop)+ 版本不可变(一期) |

未自动化/挂起:A-06/A-07/A-11/A-14 语义类(人工抽检)、S-03/S-05 外部模型外发边界(无密钥挂起,一期密钥纪律不变)、S-08 半写入恢复(暂存残留清单已实现,崩溃注入待 chaos 测试)、S-13 旧项目升级回归(迁移 dry-run 覆盖真实样本,切换需用户确认)、真实品牌/行业任务各两条回归与跨任务演示(待密钥)。

## 已知限制(本轮)

- 检索为关键词倒排(中文 bigram),无语义检索;召回以冻结夹具验证。
- PDF 仅文本层解析;扫描件/复杂表格登记为解析缺口,不虚构数值。
- 权限为单用户本地语义;跨设备共享仍经 research-data git 同步,library 大文件建议另置(见 wp00-audit)。
- 历史迁移为登记级:不搬原文、不补造核验记录;只有报告的项目需人工确认后另行登记。
