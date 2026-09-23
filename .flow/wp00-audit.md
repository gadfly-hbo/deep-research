# U2-WP00 只读基线核查报告

> 日期：2026-09-23 · 性质：只读盘点（未修改任何源码与数据）· 依据：proposal §20 交接说明要求的先行核查
> 核查基线：git HEAD `5cee876`（Xanthil 三栏重构后）；测试基线实测 **115/115 绿**（25 文件，vitest 3.2s）

## 1. 现状架构清单（实测）

| 层 | 现状 | 证据 |
|---|---|---|
| 契约 | `src/contracts.ts`：SourceSnapshot(id/url/title/fetchedAt/bodyText/parseStatus/contentType/tier A-B-C)、Evidence(id/snapshotId/quote/locator)、Claim(id/statement/kind/evidenceIds/calibration/confidence)、CitationVerdict(quote/entailment/numeric/tier 四步核查)、Budget、ReportOutline、ResearchRequest(module: brand/industry)、ResearchRun(六阶段/五状态)、ResearchResultBundle(内嵌 claims+evidence+snapshots+limitations+verdicts) | contracts.ts:9-128 |
| 执行核心 | `runResearch` 唯一入口，六阶段 plan→gather→analyze→draft→review→publish + checkpoints 恢复 + 预算 | core/runResearch.ts:108 |
| 适配器 | Search/PageFetcher/DocParser/ModelProvider 四接口；live 实现含 linkedom(HTML)+unpdf(PDF 文本)；录制/回放夹具 | adapters/types.ts, live.ts:5-6 |
| 质量门禁 | citationVerifier + entailment + numericVerifier + multiSource + sourceTier(ABC) + calibrationChecker + unitNormalize + truthGate + moduleCheck | quality/ 9 文件 |
| 业务模块 | brand/industry ModuleConfig + registry | modules/ |
| 存储 | FsProjectStore（项目级）：project.json / snapshots.json（dict，`snap:<url>` 键）/ audit.jsonl / requests/ / runs/<id>/{run,bundle,checkpoints}.json / reports/v<n>/{report.md,bundle.json,formal/}；ResearchStore 接口仅 6 方法、全部项目级 | stores/fsStore.ts:42-154, types.ts |
| 服务 | server.ts 单文件 if-chain 路由（/api/projects、runs、cancel/resume、publish、archive、versions、bundle、export、snapshots、settings）——**全部 /api/* 经单一 handler** | server/server.ts:87-393 |
| 导出 | zip：report.md/report.html/evidence//manifest.json（fflate） | app/exportBundle.ts:62-106 |
| UI | 无组件库自绘；shell(AppShell/Sidebar/StageBar/StatusBar/Palette/ProjectShell) + 六阶段 views + Inspector + state/api.ts；项目 DESIGN.md = Xanthil 三栏（优先于全局规范） | ui/ |
| 运行 | `npm test`=vitest 115 绿；`npm run build`=tsc+vite；`npm run research`=CLI；数据目录 research-data/ 随 git 同步（data-sync 自动 commit/pull/push）；密钥只走环境变量 | README.md |

## 2. 红队假设结论（ASSESS 阶段提出）

| # | 假设 | 结论 | 证据 |
|---|---|---|---|
| ① | v1 证据对象可增量复用 | **成立**：快照与证据真实落盘且可机读。缺口：Evidence 无 revision/口径字段；无 AcquisitionRecord（授权上下文）；SourceSnapshot 无内容哈希/published_at/更正关系——均为增量加字段，不需重写流水线 | F1/F2 |
| ② | 复用价值闭环真实 | **成立且被量化**：6 项目中 Anker×2、森马×2 同主体重复研究，但 74 个来源 URL **跨项目重叠为 0**——同一主体被两次研究、来源完全重新取得，"重复查找"成本真实存在。注意：复用价值发生在**主体/实体层**而非 URL 精确匹配层，U2-04 实体聚合是关键设计点 | 留存统计 |
| ③ | 权限服务端收口点 | **成立**：server.ts 单 handler + runResearch 单入口，六处权限检查点（搜索/预览/原文/绑定/上下文/导出）可落地 | F4 |
| ④ | 历史原文留存率 | **好于预期**：4/6 项目完整底稿（快照+bundle），1/6 部分（6 快照无 run/bundle），1/6 空壳；**0 个"只有报告"**；解析成功率 64/74≈86% | 留存统计 |

## 3. 历史项目留存统计（量化）

| 项目 | 模块 | 主题 | 快照(解析成功) | runs | bundles | evidence | claims | 报告版本 | 迁移档 |
|---|---|---|---|---|---|---|---|---|---|
| p-mual4wan-jdclgg | brand | Anker | 18(13) | 3 | 1 | 80 | 80 | v1 | 完整 |
| p-muaman1a-ypfqtl | industry | 咖啡零售 | 14(13) | 3 | 1 | 87 | 87 | v1 | 完整 |
| p-muar8132-3du5db | industry | 户外运动 | 14(12) | 1 | 1 | 142 | 142 | v1 | 完整 |
| p-muardyef-boi583 | brand | 森马 | 22(20) | 2 | 2 | 199 | 199 | v1,v2 | 完整 |
| p-muaqc9ys-q2xk1x | brand | 森马 | 6(6) | 0 | 0 | 0 | 0 | 无 | 部分（仅快照） |
| p-mual1oor-mc3x90 | brand | Anker | 0 | 0 | 0 | 0 | 0 | 无 | 空壳 |

合计：74 快照（64 解析成功）、508 evidence、508 claims。

## 4. U2-01…U2-10 四分类映射

| U2 | 功能 | 分类 | 现状差距 |
|---|---|---|---|
| U2-01 直接入库 | **缺失** | 仅有项目内附件入口（attachments）；无独立入库、无链接登记 |
| U2-02 研究留档 | **需增强** | 快照/bundle 已落盘；缺 AcquisitionRecord、取得与解析分离记录、共享登记路径 |
| U2-03 资产列表/详情 | **缺失** | 无跨项目视图；项目内 snapshots 路由可查单项目 |
| U2-04 实体整理 | **缺失** | 无 Entity 对象；红队②证明实体层聚合是复用关键 |
| U2-05 检索筛选 | **缺失** | 无任何索引/检索基础设施 |
| U2-06 复用绑定 | **缺失** | 无 AssetBinding/UsageRecord；无跨项目读取 |
| U2-07 去重版本 | **需增强** | snapshots.json 以 URL 为键天然项目内去重；无内容哈希、无跨项目去重、无版本关系 |
| U2-08 生命周期 | **缺失** | 仅项目级 archive；无复用范围/撤回 |
| U2-09 历史兼容 | **可复用需适配** | 6 项目全部可登记级迁移；无"只有报告"档实例，但路径须实现并测试 |
| U2-10 成果包/回归 | **需增强** | zip+manifest 已有；缺 claims/sources/source_versions/asset_bindings jsonl、许可过滤、缺失说明 |

**可直接复用（不改）**：runResearch 入口与 checkpoints、四适配器接口与回放夹具、quality 四步核查门禁、ModuleConfig 双模块、fsStore 项目级读写模式、audit.jsonl 模式、server 单 handler 结构、Xanthil 三栏 UI 体系、data-sync 同步机制。

## 5. 迁移预演方案（WP05 执行，本核查只做设计）

**三档路径**（proposal §13.2）：完整底稿（4 项目）→ 登记 snapshots 为 Source+SourceVersion（SHA-256 重算正文哈希、acquired_at=fetchedAt、复用范围默认 PROJECT_ONLY）+ bundle 证据登记 Evidence（保留原 id 映射）；部分（1 项目）→ 只登记快照，记录"无运行/无证据"缺失；空壳（1 项目）→ 不登记资产，项目保持原样。

**步骤**：备份（复制 research-data/ 全量到 research-data-backup-<ts>/）→ dry-run 报告（扫描输出登记清单，不写库）→ 样本登记（1 个项目）→ 引用与权限验证 → 全量 → 新旧兼容回归 → 用户确认。不搬文件、不改旧 JSON、旧引用 id 保留映射表。

**回滚**：情报库功能开关（settings 级）；回滚=关闭入口，library/ 数据保留；不删除升级后数据。

## 6. 冻结参数提议（附录 A 对照，WP01/02 冻结）

| 参数 | 提议值 | 依据 |
|---|---|---|
| 导入格式 | TXT/MD/JSON/网页 URL/PDF（文本型） | 现有 linkedom+unpdf 解析基线 |
| 单文件上限 / 批量上限 | 50MB / 20 项 | 本地桌面场景；WP02 实测复核 |
| 默认复用范围 | 用户导入默认 PROJECT_ONLY，显式选择可升 WORKSPACE_REUSABLE；研究沉淀按规则自动候选 | PRD A3，用户已确认 diff |
| 哈希 | SHA-256 | 标准 |
| 检索 | 自建可重建倒排（中文 bigram+英文 token），JSON 持久化 | 无现有索引；不引入新依赖 |
| 性能门槛 | 库内搜索 <500ms（千级资产，M 系 Mac）；入库单文件 <5s（10MB 内） | 本地单用户；WP06 实测校准 |

## 7. 风险与边界确认

- data-sync 会 auto-commit research-data/——library/ 入库后随 git 同步，大文件原文需评估体积（50MB 上限与 git 同步冲突：**提议原文 >10MB 进 gitignore 的 library/files/，元数据与索引随 git**；WP02 冻结）。
- server.ts 为单文件 if-chain，新增约 8 条路由会进一步膨胀——**WP03 时按现有风格内部拆分 handler 函数，不换框架**。
- 快照 bodyText 存在项目 snapshots.json 与 bundle 内嵌两处冗余——契约扩展时以 snapshots.json 为主记录，bundle 保持兼容读取，不反向改写旧 bundle。
- 密钥边界不变：library 任何路径不接收密钥；外部模型外发检查沿用 env-only 模式。

**WP00 结论：增量升级可行，红队四个可测假设全部通过；无重建必要性证据。按 tasks.md S1-S7 推进。**
