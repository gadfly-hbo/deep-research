# 深度研究工作台 2.0 全景白皮书

> 版本：2.0 · 编制：2026-09-23 · 提交：`0a6b9f4`
> 产品：独立深度研究工作台 / Deep Research Workbench
> 文档性质：产品方案 + 技术运维 + 用户操作的全景手册

---

## 目录

1. [产品定位与价值](#1-产品定位与价值)
2. [功能全景](#2-功能全景)
3. [产品架构](#3-产品架构)
4. [数据架构与对象模型](#4-数据架构与对象模型)
5. [状态治理与权限模型](#5-状态治理与权限模型)
6. [用户操作手册](#6-用户操作手册)
7. [技术运维手册](#7-技术运维手册)
8. [升级路径：从 v1.0 到 v2.0](#8-升级路径从-v10-到-v20)
9. [验收与质量](#9-验收与质量)
10. [风险与取舍](#10-风险与取舍)

---

## 1. 产品定位与价值

### 1.1 产品定义

**深度研究工作台 2.0 是一个可以独立使用的品牌与行业研究工具，同时具备外部情报积累、证据管理和跨研究复用能力。**

它既可以从问题出发完成研究，也可以从资料出发建立积累；不是只保存报告的网盘，也不是把检索结果直接当成经营决策的自动系统。

### 1.2 两个一级模块

| 模块 | 职责 |
|---|---|
| **深度研究模块** | 品牌研究 + 行业研究（共用核心）：计划 → 采证分析 → 评审补证 → 发布报告 |
| **外部情报库模块** | 直接入库 / 整理 / 检索预览 / 选择复用 / 生命周期治理 |

二者共用底稿（来源、版本、证据、主张、计算），不通过"导出报告→重新解析→再入库"的方式互通。

### 1.3 最小价值闭环

```
资料先积累 → 研究可复用 → 新证据再沉淀
```

- **第一次**品牌研究留下可追溯的资料与证据
- **第二次**行业研究找到这些资产、判断适用性并选择复用，按新问题补充缺失或需要更新的证据
- 两次研究分别绑定实际采用的来源版本，任何已发布关键结论都可以检查其依据与限制

### 1.4 关键产品判断

| 判断 | 要求 |
|---|---|
| 一个独立产品 | 在现有工作台增加模块，不另建情报产品 |
| 增量升级 | 保留品牌/行业研究的计划、采证、评审、预算和交付链路 |
| 情报不必先变成报告 | 文件与链接可直接登记入库 |
| 报告不是唯一资产 | 来源、原文版本、证据、主张、计算与报告分别保存 |
| 入库不等于已验证 | 保存状态、取得状态、证据核验、结论支持、复用权限分别表达 |
| 历史可追溯 | 研究绑定当时实际使用的资料版本，不随"最新版本"静默漂移 |

### 1.5 明确不做

全网采集与反爬、登录态/付费资料绕过、社交全量采集、问卷访谈平台、独立消费者研究模块、自动竞争监控推送、全自动推荐、企业知识图谱/四库、多租户权限计费、复杂分布式调度、JuanerAI 专属集成、经营动作执行。

---

## 2. 功能全景

### 2.1 深度研究模块（保留并接入）

| 能力 | 说明 |
|---|---|
| 品牌研究 | 问题配置 → 计划 → 采证 → 分析 → 评审 → 发布 |
| 行业研究 | 共用核心，差异在问题框架、来源策略、报告模板、专项质量检查 |
| 预算与取消 | 搜索/抓取/成本/墙钟上限，到顶有限交付；取消保留已完成阶段检查点 |
| 恢复 | 同一请求 ID 重跑自最后完成阶段续跑，已完成调用不重放 |
| 发布门禁 | 引用核查 + 口径检查 + 反例检查 + 版本绑定 + 权限；高风险阻断 |
| 成果包 | Markdown/HTML 报告 + 结构化成果包（v1 基础 + v2 增量） |

### 2.2 外部情报库模块（2.0 新增）

| 功能编号 | 功能 | 说明 |
|---|---|---|
| U2-01 | 资料直接入库 | 文件导入（TXT/MD/JSON/CSV/文本 PDF）+ 链接登记；不必先创建研究 |
| U2-02 | 研究过程留档 | 采证读取成功即保存来源/版本/取得记录，失败/中断任务也保留有效材料 |
| U2-03 | 资产列表与详情 | 标题/类型/时期/取得状态/可复用性；三栏详情（原文/元数据/取得记录） |
| U2-04 | 品牌/行业整理 | 轻量实体聚合（品牌/集团/行业），不按名称相似自动合并 |
| U2-05 | 检索与筛选 | 中文 bigram + 英文 token 倒排索引；按类型/取得状态/复用范围筛选 |
| U2-06 | 加入研究与版本绑定 | 选择器搜索→适用性四组分类→服务端权限检查→固定版本绑定 |
| U2-07 | 去重与版本管理 | 精确内容去重（SHA-256）+ 同源转引标记 + 更正版本关系 |
| U2-08 | 生命周期与复用控制 | ACTIVE/ARCHIVED/WITHDRAWN；撤回禁止新使用；删除需确认+影响预览 |
| U2-09 | 历史项目兼容 | 完整底稿/部分底稿/只有报告三档迁移，不伪造不破坏 |
| U2-10 | 成果包与回归 | v2 manifest 增量（版本化引用/复用清单/限制说明）；双模块回归 |

### 2.3 共享能力

| 能力 | 说明 |
|---|---|
| 引用核查 | 逐条引句必须在原文快照中逐字命中 |
| 口径检查 | 数值主张必须带口径（对象/时间/单位），冲突披露 |
| 语义蕴涵 | strong/weak/fail/na 四档 |
| 数值复算 | ok/mismatch/na 三档 |
| 信源分级 | A（官方/权威一手）/ B（行业报告/专业平台）/ C（社媒/自媒体） |
| 多源交叉 | 同原始出处的转载不算相互独立佐证 |

---

## 3. 产品架构

### 3.1 分层职责

```
┌─────────────────────────────────────────────────────────────┐
│                    统一工作台（SPA）                          │
│   研究项目 / 外部情报库 / 品牌与行业档案 / 成果 / 设置        │
├─────────────────────┬───────────────────────────────────────┤
│   深度研究模块        │   外部情报库模块                      │
│   计划→采证→分析→     │   入库→整理→检索预览→                │
│   评审→发布           │   来源版本详情→选择复用                │
├─────────────────────┴───────────────────────────────────────┤
│          共享资产与证据服务（增量扩展）                        │
│   Source / Version / Evidence / Claim / Calculation          │
│   AssetBinding / Usage / Review / Entity                     │
│   项目绑定 / 去重 / 权限 / 时间口径 / 审计                    │
├─────────────────────────────────────────────────────────────┤
│          沿用工具与运行适配                                    │
│   模型(pi SDK) / 搜索 / 网页 / 文档 / 受控计算               │
│   预算 / 取消 / 恢复 / 检查点                                 │
├─────────────────────────────────────────────────────────────┤
│          本地存储（沿用并扩展）                                │
│   元数据 JSON / 内容寻址文件 / 可重建索引                      │
│   暂存两阶段提交 / 审计流 / 研究数据 git 同步                  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构

```
deep-research/
├── src/
│   ├── adapters/       工具适配层:模型(pi SDK)/搜索/抓取/解析;录制/replay 夹具
│   ├── app/            项目生命周期:创建/运行/发布/导出/迁移
│   ├── core/           通用研究核心:plan→gather→analyze→draft→review→publish
│   ├── library/        外部情报库:契约/存储/入库/检索/复用/治理/生命周期
│   ├── modules/        研究模块配置:品牌/行业(问题框架/来源策略/报告模板)
│   ├── quality/        引用核查器/口径检查器/模块质量检查(纯函数门禁)
│   ├── server/         本机 HTTP 服务(仅 127.0.0.1)
│   └── stores/         本地项目存储
├── ui/                 工作台 SPA(React + Vite, Xanthil 三栏设计)
├── research-data/      研究数据(寄居仓库内,双机 git 同步)
│   ├── config.json     运行配置(0600)
│   ├── library/        情报库(workspace 级)
│   └── projects/       研究项目(项目级)
├── testdata/           冻结夹具
└── docs/               文档
```

### 3.3 两条数据流

**研究沉淀流：** 研究采证 → 保存实际取得的材料与取得记录 → 提取定位证据 → 形成主张/计算 → 评审和发布 → 符合权限的资产进入可复用范围。

**资料复用流：** 直接导入或历史积累 → 检索与预览 → 用户选择 → 适用性及权限检查 → 固定版本绑定 → 进入新研究的采证与评审上下文。

---

## 4. 数据架构与对象模型

### 4.1 逻辑对象

| 对象 | 作用 | 关键字段 |
|---|---|---|
| `Source` | 一份可识别的资料及其逻辑身份 | source_id、标题、发布主体、类型、URL、关联实体、生命周期 |
| `SourceVersion` | 该资料实际取得的内容版本 | version_id、source_id、内容哈希、内容引用、发布时间、更正关系、取得状态、解析状态 |
| `AcquisitionRecord` | 一次取得/导入及授权上下文 | acquisition_id、version_id、项目、取得时间、方式、复用范围、权利 |
| `Evidence` | 精确定位的内容或数值 | evidence_id、revision、version_id、摘录、口径、提取核验 |
| `Claim` | 对研究问题提出的主张 | claim_id、revision、类型、文本、支持/反对证据、适用范围 |
| `Calculation` | 可复算的计算 | calculation_id、输入证据版本、公式、参数、输出 |
| `Entity` | 品牌/集团/行业等轻量对象 | entity_id、类型、名称、别名、确认状态及依据 |
| `AssetBinding` | 某运行选择了哪个资产版本 | binding_id、run_id、version_id、用途、适用性、截止点 |
| `UsageRecord` | 资产实际被使用的记录 | run_id、binding_id、步骤、内容版本、报告引用位置 |
| `ReviewRecord` | 某对象在某范围下的核验 | 对象和版本、范围、检查类型、结果、责任主体 |
| `ResearchResultBundle` | 同一研究成果的交付集合 | 请求/运行/成果版本、报告、引用、证据、限制、文件清单 |

### 4.2 存储物理结构

```
research-data/
├── config.json                     运行配置(密钥 0600)
├── library/                        情报库(workspace 级)
│   ├── sources.json                Source 字典(snap:<url> / s-<id> 键)
│   ├── versions.json               SourceVersion 字典
│   ├── acquisitions.json           AcquisitionRecord 字典
│   ├── entities.json               Entity 字典
│   ├── bindings.json               AssetBinding 字典
│   ├── usages.json                 UsageRecord 字典
│   ├── reviews.json                ReviewRecord 字典
│   ├── index.json                  可重建倒排索引(中文 bigram+英文 token)
│   ├── files/<sha256>              内容寻址文件(正文存储)
│   ├── staging/<uuid>              暂存位(提交前残留可恢复)
│   ├── audit.jsonl                 审计流(append-only)
│   └── migration-map.json          历史迁移映射表(幂等)
└── projects/
    └── p-<id>/
        ├── project.json            项目元数据
        ├── snapshots.json          来源快照字典
        ├── audit.jsonl             项目审计流
        ├── requests/req-<id>.json  研究请求
        ├── runs/<run-id>/
        │   ├── run.json            运行状态
        │   ├── bundle.json         成果包
        │   └── checkpoints.json    检查点
        └── reports/v<n>/
            ├── report.md           Markdown 报告
            ├── bundle.json         发布版本成果包(不可变)
            └── formal/             正式报告(HTML/PPTX/JSON)
```

### 4.3 时间语义（必须区分）

| 时间 | 含义 |
|---|---|
| `data_period` | 被描述的数据所属期间 |
| `published_at` | 来源标示或可核查的发布时间，未知可为空 |
| `available_at` | 材料在外部最早可用时点，仅在有依据时记录 |
| `acquired_at` | 系统实际取得材料的时间 |
| `recorded_at` | 记录写入系统的时间 |
| `reviewed_at` | 核验实际发生的时间 |
| `as_of` | 研究允许采用信息的截止点 |

### 4.4 版本绑定原则

运行开始或明确增补输入时，生成绑定快照，至少固定来源版本、证据修订、请求范围、研究配置与权限检查记录。报告中的引用指向固定版本，不指向"最新"别名。原文相同但解析器生成了不同片段时，保留提取版本，防止证据定位漂移。

---

## 5. 状态治理与权限模型

### 5.1 六维状态分离

不用一个"已入库"状态表示全部质量：

| 维度 | 取值 | 说明 |
|---|---|---|
| 取得状态 | DISCOVERED / SNIPPET_ONLY / READ_PARTIAL / READ_FULL / UNAVAILABLE | 真正拿到多少内容 |
| 提取核验 | UNCHECKED / VERIFIED_AGAINST_SOURCE / EXTRACTION_ISSUE | 摘录/数值是否与原文一致 |
| 主张支持 | SUPPORTED / PARTIALLY_SUPPORTED / CONTRADICTED / UNRESOLVED | 只针对指定问题与证据 |
| 复用范围 | PROJECT_ONLY / WORKSPACE_REUSABLE / RESTRICTED | 允许在哪些范围使用 |
| 生命周期 | ACTIVE / ARCHIVED / WITHDRAWN | 归档不删除，撤回禁止新使用 |
| 任务适用性 | ELIGIBLE / LEAD_ONLY / NEEDS_REVIEW / NOT_APPLICABLE / FORBIDDEN | 在某研究内计算 |

### 5.2 权限检查顺序

1. 访问与使用授权（项目归属 + 复用范围）
2. 生命周期（WITHDRAWN → FORBIDDEN，ARCHIVED → NEEDS_REVIEW）
3. 取得完整性（DISCOVERED → LEAD_ONLY，READ_PARTIAL + 解析缺口 → NEEDS_REVIEW）
4. 派生关系（自有报告 → LEAD_ONLY）
5. 转引链（上游未取得 → NEEDS_REVIEW）
6. 时间口径（发布时间晚于 as_of → NEEDS_REVIEW）
7. 资料类型边界（consumer-profile → 服务端样本边界提示）

### 5.3 权限边界

| 能力 | 最小粒度 |
|---|---|
| 本地留存 | 取得记录级 |
| 项目内查看 | 取得记录 + 项目归属 |
| 跨项目复用 | 取得记录显式升档（需依据） |
| 向外部模型发送 | 取得记录级（独立于复用范围） |
| 随成果导出全文 | 取得记录级（独立于复用范围） |
| 随成果导出摘录 | 取得记录级 |

用户上传不是自动全授权；未知的全文导出或外发权利默认不放行。

### 5.4 外发门禁（S-03）

研究运行的模型上下文组装路径严格检查 `rights.sendToExternalModel`：

- 仅当取得记录属于当前运行项目、属主直录、或已显式升档到 WORKSPACE_REUSABLE 时放行
- 不允许受限项目借用其他项目取得记录上的外发许可
- 未授权时：正文不进入模型上下文，运行继续但 limitations 披露阻断原因

---

## 6. 用户操作手册

### 6.1 启动工作台

**Mac：** 双击仓库根目录下的「启动深度研究.command」。

该脚本自动：
1. 安装依赖（首次运行）
2. 构建 UI（首次运行）
3. 拉取双端研究数据（`data-sync`）
4. 启动本机服务 `http://127.0.0.1:4173`
5. 打开浏览器
6. 退出时回推研究数据

**手动：** `scripts/with-minimax-env.sh npm run research -- serve`，打开 `http://127.0.0.1:4173`。

### 6.2 侧栏导航

```
┌───────────────────┐
│  🟢  深           │  品牌标志
│      独立深度研究  │
│      品牌 × 行业   │
├───────────────────┤
│  ⌕ 搜索项目与命令  │  ⌘K 命令面板
│  ＋ 新建项目/运行   │
├───────────────────┤
│  ▣ 外部情报库      │  ← 2.0 新增入口
├───────────────────┤
│  品牌研究          │  项目树(展开列版本)
│    · 森马          │
│    · Anker         │
│  行业研究          │
│    · 咖啡零售      │
│    · 户外运动      │
├───────────────────┤
│  已归档 (1)        │
├───────────────────┤
│  最近运行 (3)      │  当前项目运行记录
├───────────────────┤
│  ● 本机服务 · ...  │
│  ⚙ 设置           │
│  执行完成 ≠ 证据充分│
└───────────────────┘
```

### 6.3 流程 A：不研究，先收集资料

1. 点击侧栏「外部情报库」
2. **导入文件：** 选择本地文件（TXT/MD/JSON/CSV/文本 PDF，单文件 ≤50MB，可多选，单批 ≤20 项）
3. **登记链接：** 输入公开 URL + 可选标题，点击「登记」
4. 系统逐项显示：成功 / 重复 / 待确认 / 失败
5. 在列表中查看资产：标题、类型、时期、取得状态、解析状态、复用范围、入库时间
6. 点击资产行进入详情三栏页：
   - **左：** 原文/快照及定位（可切换版本）
   - **中：** 元数据、口径、来源关系与版本表
   - **右：** 取得记录、权限、使用记录、治理动作

**链接登记 ≠ 已读正文。** 链接状态为「仅登记」，详情页明确展示「尚未取得正文」。

### 6.4 流程 B：新研究选择已有情报

1. 进入研究项目 → 点击「＋ 新建研究运行」
2. 第一步：输入研究目标与范围，点击「生成研究计划」
3. 第二步：在研究计划下方的「选择已有情报」区域搜索关键词
   - 搜索结果带 **适用性标签**（证据候选 / 仅作线索 / 需复核 / 权限不允许）
   - 检查说明（如"样本仅限某平台关注者"）自动展示
4. 点击「加入」→ 选中的资产出现在已选列表中
   - 可编辑「选择理由/用途」
   - 可切换「证据候选 ↔ 仅作线索」
   - 可移除
5. 第三步：确认报告框架
6. 点击「开始研究」
   - 服务端对每个选择进行权限与适用性检查
   - 越权项被拒绝并回报（toast 显示）
   - 合格项的版本被固定绑定
7. 研究运行中，绑定资产的正文经外发门禁后进入模型上下文
   - 未授权外发的资产只记录线索，不注入
8. 采证阶段的「本运行复用的情报」卡片展示绑定与使用记录

### 6.5 流程 C：研究中发现资料并沉淀

研究读取成功后自动沉淀到情报库：
- 来源/版本/取得记录即时入库
- 证据自动绑定来源版本与待核验状态
- 失败/中断的任务保留已有效取得的材料
- 共享登记失败时运行继续但 limitations 披露「共享登记待处理」

### 6.6 流程 D：更新、纠错与历史回看

- **更正版：** 资产详情页 → 治理动作 → 输入更正后正文 → 提交。旧研究绑定不变，更正提示自动展示。
- **归档/撤回：** 详情页 → 治理动作。归档不删除；撤回禁止新使用。
- **删除：** 需确认，先展示受影响引用清单。
- **授权跨项目复用：** 详情页 → 治理动作 → 输入授权依据 → 确认。

### 6.7 发布与成果包

1. 进入研究项目的「发布」阶段
2. 选择可发布的运行 → 点击「发布为版本」
3. 发布门禁检查：引用闭合、版本固定、来源未撤回、提取无致命问题、无越权绑定
4. 阻断时明确报告原因；通过后生成不可变版本
5. 成果页展示：
   - 版本与差异摘要
   - **本版本实际使用的资产版本**（引用固定到版本，不随情报库更正漂移）
   - 正式报告生成（HTML/PPTX）
   - 导出成果包（ZIP）

**v2 成果包内容：**
```
research-result/<version>/
  report.md / report.html
  manifest.json               schema 2.0：含资产版本清单、删减/缺失原因
  claims.jsonl / evidence.jsonl / source_versions.jsonl
  asset_bindings.jsonl        本运行绑定清单
  review_summary.json         核验结果汇总
  limitations.md              限制与缺口
  permitted_assets/           仅含被许可转交的材料或片段
  evidence/                   一期兼容：snapshot-*.txt + index.json
```

### 6.8 设置

- **研究配置：** 模型链、搜索链、预算默认值（密钥只走环境变量，不通过 API 写入）
- **情报库默认：** 默认复用范围（PROJECT_ONLY）、资料留存与外发策略

### 6.9 常见问题

| 问题 | 原因与处理 |
|---|---|
| 情报库为空能否研究？ | 可以。空库不阻断研究，正常采证。 |
| 入库 ≠ 已核验？ | 是的。入库仅表示材料按声明范围保存。质量、真实性、适用性需独立检查。 |
| 旧报告会自动改数？ | 不会。更正产生新版本，旧研究保持原绑定并提示更正。 |
| 搜索无命中？ | 不等于资料不存在。可继续外部采证或调整关键词。索引故障时可按列表访问。 |
| 同一内容两个项目？ | 内容去重但授权不合并。每个取得记录独立。 |
| 研究中断？ | 已提交底稿保留，后续派发停止。不会假装已发布。 |

---

## 7. 技术运维手册

### 7.1 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React + Vite + TypeScript，自绘组件（Xanthil 暖灰青三栏），无组件库 |
| 后端 | Node.js 单进程 HTTP 服务（仅 127.0.0.1），TypeScript |
| 存储 | 本地文件系统（JSON 字典 + 内容寻址文件 + 审计 JSONL + 可重建索引） |
| Agent | pi SDK 进程内接入（`@earendil-works/pi-ai` + `pi-agent-core`） |
| 解析 | linkedom（HTML）+ unpdf（PDF 文本）+ @mozilla/readability |
| 导出 | fflate（ZIP）+ pptxgenjs（PPTX）|
| 契约 | zod schema 校验（contracts.ts + library/contracts.ts） |
| 测试 | vitest（40 文件 / 219 测试），录制夹具回放 |

### 7.2 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `MINIMAX_API_KEY` | MiniMax 模型 API 密钥 | live 模式必需 |
| `XIAOMI_API_KEY` | Xiaomi 模型 API 密钥 | 备选模型 |
| `DEEP_RESEARCH_DATA_DIR` | 研究数据目录覆盖（默认 `research-data/`） | 可选 |
| `DR_MODEL_TIMEOUT_MS` | 模型调用超时（默认 300s） | 可选 |
| `DR_DEBUG` | 调试日志 | 可选 |

**密钥注入方式：** `scripts/with-minimax-env.sh <cmd>`（从 `~/.pi/agent/auth.json` 和 `~/.zcode/v2/config.json` 取凭据，静默 export）。密钥只走环境变量，不进配置文件/日志/报告/测试。

### 7.3 npm 命令

| 命令 | 用途 |
|---|---|
| `npm test` | 单元/集成测试（vitest，适配器为录制夹具，无需密钥） |
| `npm run typecheck` | TypeScript 类型检查（src + ui） |
| `npm run build` | tsc + vite 构建 SPA 到 ui-dist/ |
| `npm run research -- serve` | 启动本机 HTTP 服务 |
| `npm run research -- data-sync` | 研究数据双机 git 同步 |
| `npm run research -- project create --request input.json` | CLI 创建项目 |
| `npm run research -- project run --project <dir> --request req.json` | CLI 运行研究 |
| `npm run research -- project publish --project <dir> --run <runId>` | CLI 发布版本 |

### 7.4 API 路由一览

#### 研究项目

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/projects` | 列出所有项目 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 项目详情（元数据/运行/快照） |
| POST | `/api/projects/:id/plan-preview` | 预览研究计划 |
| POST | `/api/projects/:id/outline-preview` | 预览报告框架 |
| POST | `/api/projects/:id/runs` | 发起研究运行（支持 `selectedAssets`） |
| POST | `/api/projects/:id/runs/cancel` | 取消运行 |
| POST | `/api/projects/:id/runs/resume` | 恢复运行 |
| POST | `/api/projects/:id/publish` | 发布版本（2.0 扩展门禁检查） |
| POST | `/api/projects/:id/archive` | 归档/恢复项目 |
| POST | `/api/projects/:id/versions/:v/formal` | 生成正式报告 |
| GET | `/api/projects/:id/versions/:v/bundle` | 获取成果包 JSON |
| GET | `/api/projects/:id/versions/:v/export` | 导出 ZIP（2.0 schema） |
| GET | `/api/projects/:id/snapshots?sid=` | 获取快照纯文本 |

#### 外部情报库（2.0 新增）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/library/assets` | 入库（文件/链接/批量） |
| GET | `/api/library/assets` | 资产列表 |
| GET | `/api/library/assets/:sourceId` | 资产详情（来源/版本/取得记录） |
| PATCH | `/api/library/assets/:sourceId` | 更正元数据（白名单字段） |
| DELETE | `/api/library/assets/:sourceId` | 删除资产（需 confirm + force） |
| POST | `/api/library/assets/:sourceId/lifecycle` | 生命周期变更（ACTIVE/ARCHIVED/WITHDRAWN） |
| POST | `/api/library/assets/:sourceId/scope` | 复用范围变更（需依据） |
| POST | `/api/library/assets/:sourceId/corrections` | 更正版本（产生新版本） |
| POST | `/api/library/assets/fetch` | 对已登记链接执行正文取得 |
| GET | `/api/library/assets/:sourceId/content` | 原文纯文本（带项目上下文权限过滤） |
| GET | `/api/library/search?q=…` | 检索（带项目上下文+适用性四组） |
| GET | `/api/library/check?sourceId=…&versionId=…&projectId=…` | 适用性与权限检查 |
| GET | `/api/library/bindings?runId=…` | 某运行的绑定与使用记录 |
| GET/POST | `/api/library/entities` | 实体列表/创建 |
| POST | `/api/migrate` | 历史迁移（dryRun / confirm） |

#### 设置

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/settings` | 获取配置（密钥字段已过滤） |
| POST | `/api/settings` | 合并更新配置（密钥字段拒绝） |

### 7.5 安全边界

| 边界 | 实施 |
|---|---|
| 服务仅 127.0.0.1 | `server.listen(port, "127.0.0.1")` |
| 密钥不入 API | POST /settings 含密钥字段 → 400；GET 剥除 key/token/secret |
| 配置文件 0600 | `chmodSync(configPath, 0o600)` |
| 来源内容不可信 | 快照端点仅 text/plain 净化正文；HTML 全文转义 |
| SSRF 防护 | 禁本机/私网（含 IPv4+IPv6+整型/十六进制映射）、重定向复查、50MB 体积上限 |
| 外发门禁 | `rights.sendToExternalModel` 按取得记录上下文过滤 |
| 文档不执行 | 宏/脚本/嵌入内容不执行；HTML 预览按不可信内容渲染 |

### 7.6 数据同步

研究数据寄居仓库内 `research-data/`，双机通过 git 同步：

```
Mac mini: research-data/  ←git pull/push→  MacBook: research-data/
```

`npm run research -- data-sync` 自动执行：提交本机变更 → `pull --rebase --autostash` → 推送。冲突时保留本机数据并提示人工处理。

**大文件注意：** 内容寻址文件在 `research-data/library/files/`，建议单文件 ≤10MB 以内随 git 同步；超大文件建议用 `DEEP_RESEARCH_DATA_DIR` 覆盖到仓库外目录。

### 7.7 索引管理

情报库索引（`research-data/library/index.json`）可重建：
- 自动重建：来源/版本变更后检索时自动触发
- 手动重建：删除 `index.json` 后下次检索自动重建
- 索引损坏不视为原文丢失：可按列表直接访问已保存资料

### 7.8 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 服务启动失败 | 端口占用 / 依赖未装 | 换端口 / `npm install` |
| 测试红 | node_modules 过期 | `npm install` 后重跑 |
| 搜索无命中 | 索引为空或损坏 | 删除 `library/index.json`，下次检索自动重建 |
| 大文件入库失败 | 超过 50MB 上限 | 分割文件或调整上限（需改代码常量） |
| 发布被拒 | 引用不闭合 / 来源已撤回 / 越权绑定 | 按门禁提示修复 |
| 迁移后数据不完整 | 原始项目无快照 | 正常：只有报告的项目为 report-only 档 |
| 双机同步冲突 | 两端同时修改 | 保留本机数据，手动 merge |

---

## 8. 升级路径：从 v1.0 到 v2.0

### 8.1 v1.0 → v2.0 变化对照

| 主题 | v1.0 | v2.0 |
|---|---|---|
| 研究资产范围 | 以单个研究项目为中心 | 增加工作台内可检索、可授权复用的资产目录 |
| 跨项目复用 | 后续事项 | 搜索、筛选、人工选择、适用性检查与绑定 |
| 资料入口 | 研究时取得 | 增加不依赖研究任务的直接入库入口 |
| 证据治理 | 项目内追溯 | 扩展到来源去重、共享索引、跨项目引用与版本冻结 |
| 成果包 | report + manifest | 增加 jsonl、许可转交、删减缺失说明 |
| 迁移 | 无 | 三档历史兼容（完整/部分/仅报告） |

### 8.2 向后兼容

- 一期 `SourceSnapshot`/`Evidence`/`Claim`/`ResearchResultBundle` schema 保留，2.0 扩展字段全部可选（旧数据可解析）
- 一期 `ResearchStore` 接口不变，`runResearch` 无 `library` 选项时行为完全不变（空库可研究）
- 一期导出包结构保留（report.md/html + evidence/ + manifest.json），2.0 增量追加
- UI 三栏布局不变，情报库为新增一级入口
- 品牌/行业研究模块不变，共用核心不变

### 8.3 历史迁移

**三档处理（proposal §13.2）：**

| 档 | 条件 | 处理 |
|---|---|---|
| 完整底稿 | 有运行成果包 + 快照 | 登记 Source/Version/Acquisition，引用原路径不搬文件 |
| 部分底稿 | 仅快照无运行 | 只登记快照，记录"无运行/无证据"缺失 |
| 仅报告 | 仅有最终报告 | 登记为历史派生成果，标底稿缺失，不伪造核验 |

**迁移步骤：**
1. `POST /api/migrate {dryRun: true}` → 出预演报告
2. 备份 `research-data/`
3. `POST /api/migrate {dryRun: false, confirm: true}` → 应用
4. 检查情报库列表
5. 重复执行幂等（映射表去重）

**回滚：** 关闭情报库入口（功能开关），library/ 数据保留不删除。

---

## 9. 验收与质量

### 9.1 验收基线

- **测试：** 40 文件 / 219 测试全绿
- **类型检查：** src + ui typecheck 净
- **构建：** tsc + vite build OK
- **端到端闭环：** "品牌沉淀 → 授权 → 行业复用 → 版本各自固定 → 新证据再沉淀"通过
- **双模块回归：** 品牌/行业研究能力未退化
- **三轮双轴审查：** Standards + Spec 两轴，blocking 已全部修复

### 9.2 验收用例覆盖

| 用例 | 覆盖 |
|---|---|
| A-01 空库可研究 | 一期全套 + 集成测试 |
| A-02 只导入不研究 | server/libraryRoutes + UI |
| A-03 只登记≠已读 | assetService(DISCOVERED 断言) |
| A-04 解析缺口可见 | assetService(PDF failed) + UI |
| A-05/A-18 样本边界 | reuseIntegration(scopeNote 保留) |
| A-08 转引不升级 | reuse(NEEDS_REVIEW) |
| A-10 自有报告派生 | reuse(derivedFromRunId→LEAD_ONLY) |
| A-12 跨任务独立绑定 | reuseIntegration/acceptanceLoop |
| A-13 更正不静默替换 | lifecycle + governance 路由 |
| A-15 截止点 | reuse(asOf 晚于 published→NEEDS_REVIEW) |
| A-16 只有报告不伪造 | migrateLibrary(report-only 档) |
| S-01 跨项目不泄露 | searchService + 路由 + content 403 |
| S-02 授权不串用 | reuseIntegration(跨项目外发阻断) |
| S-03 外发门禁 | runResearch(blocked-external) |
| S-04 导出许可 | acceptanceLoop(omissions) |
| S-06 SSRF | assetService(IPv4/v6/整型/重定向/体积) |
| S-07 撤回/删除 | lifecycle + governance 路由 |
| S-09 幂等 | assetService/bindAssets(幂等键) |
| S-10 中断保留 | researchArchiving |
| S-11 登记失败披露 | researchArchiving(limitations) |
| S-14 多格式一致 | exportBundle + acceptanceLoop |

### 9.3 挂起项（待密钥/后续）

| 项 | 原因 |
|---|---|
| 真实品牌/行业任务各两条回归 | 需 live 模型密钥 |
| 跨任务演示（品牌→行业复用） | 需 live 运行 |
| S-03/S-05 外部模型实链路验证 | 需密钥 |
| S-08 崩溃注入混沌测试 | 后续 chaos 测试 |
| 语义检索 / 自动推荐 | 后续增强 |
| 定时监测 / 多工作台协作 | 后续增强 |

---

## 10. 风险与取舍

| 风险 | 表现 | 本轮取舍 |
|---|---|---|
| 范围扩张 | 情报库被演变为全网商业数据库 | 明确资料入口与人工选择复用 |
| 旧实现底稿不足 | 有报告但无可追溯证据 | 先核查、分级登记，不伪造历史 |
| 研究与情报双份保存 | 报告、资料、结论失配 | 共用资产服务与稳定引用 |
| 资料越积越旧 | 新研究复用不适用的历史内容 | 任务级时间/口径检查 |
| 历史结论自我强化 | AI 引用 AI 报告形成循环 | 派生标记、上游引用、同源识别 |
| 权限混用 | 共用文件造成跨项目泄露 | 取得授权与内容分离，多阶段校验 |
| 去重误合并 | 同名品牌/不同财报期混淆 | 精确匹配自动；关系推断需依据 |
| 无法复验仍标完整 | 包只带 ID 或过期链接 | 明示缺失，禁止虚称完整 |

**优先级：不伪造与不越权 → 引用和版本可靠 → 两模块闭环可用 → 查找和复用体验 → 高级检索与自动化。**

---

## 附录 A：默认参数

| 参数 | 默认值 |
|---|---|
| 单文件上限 | 50MB |
| 单批上限 | 20 项 |
| 默认复用范围 | PROJECT_ONLY |
| 内容哈希 | SHA-256 |
| 检索方案 | 中文 bigram + 英文 token 倒排（可重建） |
| 性能参考 | 库内搜索 <500ms（千级资产，M 系 Mac） |
| 模型超时 | 300s（可 `DR_MODEL_TIMEOUT_MS` 覆盖） |
| 抓取超时 | 30s |
| 最大并行 | 4 |
| 最大搜索 | 8（交互） / 20（CLI） |
| 最大抓取 | 12（交互） / 30（CLI） |

## 附录 B：依赖清单（核心）

| 依赖 | 用途 |
|---|---|
| `@earendil-works/pi-ai` + `pi-agent-core` | Agent 运行时（进程内接入） |
| `react` / `react-dom` / `react-router-dom` | 前端框架 |
| `zod` | Schema 校验（contracts + library contracts） |
| `linkedom` | HTML 解析 |
| `unpdf` | PDF 文本提取 |
| `@mozilla/readability` | 网页正文提取 |
| `fflate` | ZIP 压缩（成果包导出） |
| `pptxgenjs` | PPTX 生成（正式报告） |
| `vitest` | 测试框架 |
| `vite` | 前端构建 |
| `tsx` | CLI TypeScript 运行 |

---

> **深度研究工作台 2.0：一个工作台、两个一级模块、一套共享资产与证据底座。**
> **让资料能够先于研究积累，让研究能够复用真实依据，让新增证据持续沉淀。**
