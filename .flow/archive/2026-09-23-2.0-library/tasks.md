# dev-flow 2.0 任务拆解 — 外部情报库与跨研究复用

> 规格源：`.flow/proposal.md` > `.flow/prd.md`（含 GRILL 自答 G1-G13 与代码事实 F1-F7）。
> 自批准理由：dev-flow 规则——拆解只排序与细化 PRD，不引入冲突；冲突必升级。本拆解遵循 proposal §16 WP00-WP06 顺序与"契约版本先行"。
> 熔断：若 IMPLEMENT 进度显示超预算（60 轮/12h），S6 迁移部分降级为后续批次（U2-B），需用户批准。

## 顶层清单

- [x] 0. WP00 只读基线核查
- [x] 1. 资产契约扩展 + workspace 级 LibraryStore
- [x] 2. 直接入库（register_asset + 列表/导入 UI）
- [ ] 3. 检索筛选与资产详情（search_assets + 可重建索引）
- [x] 4. 研究沉淀（gather 留档 + analyze 证据登记）
- [x] 5. 复用闭环（check_reuse + bind_assets + 复用选择器）
- [x] 6. 生命周期治理 + 历史迁移（登记级）
- [x] 7. 成果包增量 + 发布门禁扩展 + 端到端验收

---

## 0. WP00 只读基线核查

## What to build

对现有代码与数据做只读盘点，产出 `.flow/wp00-audit.md`：①实际架构/接口/存储/解析/来源与证据字段现状；②已实现/可复用/需增强/缺失四分类清单；③U2-01…U2-10 与实际改动点映射；④历史项目原文留存统计与迁移预演方案（含备份与回滚）；⑤需冻结的参数清单（导入上限、检索方案、性能门槛）。不改任何源码与数据。

## Acceptance criteria

- [ ] wp00-audit.md 含四分类清单与 U2 映射表
- [ ] 历史 6 项目的 snapshots/bundle 留存统计（量化）
- [ ] 迁移预演方案 + 数据保护与回滚计划
- [ ] 红队假设①③④有明确结论（落盘粒度/收口点/留存率）

## Blocked by

None - can start immediately

---

## 1. 资产契约扩展 + workspace 级 LibraryStore

## What to build

在 contracts 上增量扩展 2.0 对象：Source/SourceVersion（SHA-256、更正关系）/AcquisitionRecord（授权上下文）/Entity/AssetBinding（精确版本+用途+as_of+检查结果）/UsageRecord/ReviewRecord；六维状态枚举与六类时间字段（proposal §8.3/§9.1）。新建 workspace 级 FsLibraryStore（research-data/library/，与 projects/ 平级）：sources/versions/acquisitions 读写、library 级 audit.jsonl、暂存→完成两阶段提交（半写入恢复）。Evidence/Claim 沿用现有 schema 并补 revision/口径字段（向后兼容：旧数据可解析）。

## Acceptance criteria

- [ ] 契约测试：新对象 schema 校验 + 旧 bundle/snapshot JSON 仍可解析（向后兼容测试）
- [ ] LibraryStore 端到端：写 Source+Version+Acquisition 可读回；幂等键重试不产生重复登记
- [ ] 半写入恢复：暂存残留不进入可用清单
- [ ] 审计流记录写操作

## Blocked by

- 0（WP00 确认契约兼容策略）

---

## 2. 直接入库（register_asset + 列表/导入 UI）

## What to build

文件导入与链接登记：register_asset 服务（文件→暂存→SHA-256→精确去重→元数据候选→登记；链接→登记入口状态，不假装已读正文）；逐项状态（成功/重复/待确认/失败）；server 路由 POST /api/library/assets + GET 列表；UI 侧栏新增"情报库"入口 + 中央列表页（标题/类型/对象/时期/取得状态/可复用性/处理状态）+ 导入动作。默认 PROJECT_ONLY。上限：单文件 50MB、批量 20 项（WP02 实测冻结）。URL 导入服务端边界：禁本机/私网、重定向检查。

## Acceptance criteria

- [ ] 不创建研究即可导入文件并入列表（U2-01/A-02）
- [ ] 只登记链接时状态=DISCOVERED/SNIPPET_ONLY，不显示已读全文（A-03）
- [ ] 精确重复导入被识别为重复项（U2-07 部分/A-09 基础）
- [ ] 批量导入逐项状态可见，无"全部完成"掩盖
- [ ] 本机/私网 URL 被拒（S-06）

## Blocked by

- 1

---

## 3. 检索筛选与资产详情（search_assets + 可重建索引）

## What to build

可重建关键词倒排索引（中文 bigram + 英文 token，索引文件独立、状态可见、可删除重建）；search_assets：标题/发布者/别名/类型/时期/正文检索 + 筛选（品牌/行业、地区、类型、日期、取得状态、复用范围）；权限过滤在服务端（PROJECT_ONLY 资产不被其他项目搜到：列表/计数/片段均不泄露）；命中片段+来源版本+限制展示；资产详情三区（原文与定位/元数据与版本/证据与使用记录）；空库与索引故障明确区分。品牌/行业档案轻量聚合页（Entity 关联资料聚合）。

## Acceptance criteria

- [ ] 冻结中文夹具召回实测通过（中文品牌/正文/英文别名/数字口径）（U2-05）
- [ ] S-01：跨项目搜索五路不泄露（列表/计数/片段/原文/上下文）
- [ ] 索引删除后可重建且状态可见；索引故障时列表访问仍可用（A-17/S-12）
- [ ] 详情页三区展示，原文缺失可见（U2-03）

## Blocked by

- 2

---

## 4. 研究沉淀（gather 留档 + analyze 证据登记）

## What to build

runResearch 接入点：gather 阶段读取成功即调 ingest_research_source（登记 Source/SourceVersion/AcquisitionRecord，默认 PROJECT_ONLY，幂等去重）；analyze 阶段 record_evidence（绑定原文定位/口径/revision）；完成或中断的运行保留已有效取得的材料；共享登记失败明示"项目已保存、共享登记待处理"，关键证据无法持久化则阻断发布。空库研究不受影响（A-01 回归）。

## Acceptance criteria

- [ ] replay 跑研究后，库中出现对应 PROJECT_ONLY 资产与取得记录（U2-02/流程 C）
- [ ] 中断运行保留已留档材料，不记为已发布（S-10）
- [ ] 登记失败状态真实可见，不假装已沉淀（S-11）
- [ ] A-01 回归：空库品牌/行业研究照常

## Blocked by

- 1（契约）；建议 2 之后做以便复用入库路径

---

## 5. 复用闭环（check_reuse + bind_assets + 复用选择器）

## What to build

check_reuse：授权→对象/范围/时间/取得完整性/证据支持/来源独立性顺序检查，输出 ELIGIBLE/LEAD_ONLY/NEEDS_REVIEW/NOT_APPLICABLE/FORBIDDEN；bind_assets：固定版本快照（来源版本+证据修订+请求范围+配置+权限检查记录），不静默覆盖；研究 plan 阶段"选择已有情报"选择器（搜索/筛选/四组分类/确认前可移除或标仅线索）；上下文组装解析授权引用为实际片段（含截断说明与位置）；UsageRecord 记录。端到端：第一次品牌研究沉淀 → 第二次行业研究检索选择绑定 → bundle 含绑定与使用记录。

## Acceptance criteria

- [ ] A-12：同一来源版本被两个运行共用，独立绑定与使用记录
- [ ] A-18：品牌材料在行业研究保留样本边界提示（LEAD_ONLY/NEEDS_REVIEW 分类正确）
- [ ] 版本绑定固定到精确版本，不随"最新"漂移（A-13 前半）
- [ ] 权限不足材料不进入模型上下文（S-03 上下文路径）
- [ ] 端到端闭环用例通过（proposal §0.3 完成定义）

## Blocked by

- 3、4

---

## 6. 生命周期治理 + 历史迁移（登记级）

## What to build

归档/撤回/删除：撤回禁止新使用+旧引用提示+受影响清单；删除前展示被引用项目与可保留范围、确认后执行并清理索引缓存；更正版本关系（新版本可见，旧研究仍绑定旧版并提示更正）；历史迁移脚本：备份→预演（dry-run 报告）→登记级迁移（现有 snapshots/bundle 登记为 Source/Version/Acquisition，原路径保留，不搬文件）→三档处理（完整/部分/只有报告）→兼容回归。不伪造底稿：只有报告的项目登记为历史派生成果并标缺失。

## Acceptance criteria

- [ ] A-13：更正版本入库后旧报告仍绑定旧版本并显示更正提示
- [ ] A-14：新时期财报为新资料对象，不覆盖旧身份
- [ ] A-16：只有报告的历史项目收录为派生成果，无伪造原文/页码
- [ ] S-07：撤回后禁止新绑定，旧引用显示状态
- [ ] 迁移预演报告 + 备份恢复实测；旧项目引用不失效（S-13）

## Blocked by

- 1；建议 5 之后（撤回影响绑定语义）

---

## 7. 成果包增量 + 发布门禁扩展 + 端到端验收

## What to build

export_result_bundle 增量：asset_bindings.jsonl/source_versions.jsonl/manifest.json（schema 版本、资产版本清单、删减缺失原因、文件哈希）；未含原文时明示"引用可追溯但接收方未必能访问"；禁止导出未授权原文/密钥/本地路径。发布门禁扩展：引用闭合+版本固定+口径+权限+受限事实检查。受控验收集：A-01…A-18、S-01…S-15 可自动化部分全部转测试；双模块回归；验收报告（docs/ACCEPTANCE.md 增补 2.0 章）。

## Acceptance criteria

- [ ] S-14：MD/HTML/包内主张、数值、来源版本一致
- [ ] S-04：未授权原文不导出且缺失说明准确
- [ ] 发布门禁阻断虚构引用/越权资料/版本漂移（受控注入测试）
- [ ] 双模块（品牌/行业）回归通过，取消/恢复/导出无退化
- [ ] 验收报告含已知限制与解析边界

## Blocked by

- 5、6
