# 给 JuanerAI 工程师 Agent：启动 deep-research（独立深度研究工作台）固定模块接入

> 本文为转交 JuanerAI 宿主侧（Mac mini 工程师 Agent）的接入启动 Prompt，随插件仓 `docs/` 发布留档。**本文自包含**：接收方无需访问插件仓即可启动对齐与 Adapter 设计；插件源/固定物料在接线阶段由用户按 §2.3 提供并记录身份。

日期：2026-10-17。任务：按本仓已发布的插件接入标准，将 deep-research 作为固定随包模块接入 JuanerAI。插件侧只读评估（v0.4，规范包 `6756546a` 已核验）已完成且结论为「插件侧必须项为零」；装配级准备（J1 批次：授权钩子/数据目录透传）已随插件仓 `3a3f8c3` 落地。本任务是你侧（宿主侧）的对齐→接线→验证→固定交付。按本仓工程执行政策与既有 OpenSpec 流程推进，不因本 Prompt 增加新审批 Gate。

## 1. 插件定位（本任务的产品语境）

**deep-research 在 JuanerAI 价值链的位置：分析之前的研究执行层。**

- **职责**：围绕研究问题自动完成 规划→采证（搜索/抓取/快照留存）→主张抽取→分析→草稿→评审→发布，产出**证据可追溯**的研究成果包（report.md/html、claims/evidence/snapshots jsonl、manifest；正式报告可再产 html/pptx），并沉淀外部情报库（来源/版本/证据/授权复用）供跨研究复用。核心原则：执行完成 ≠ 证据充分——资料不足或预算到顶时产出「有限交付」并披露限制，不编造完整答案。
- **与 Report Studio（reports-factory）、decision-platform 的分工——互补不重叠**：deep-research 是**研究执行层**（看清问题，产证据链研究报告）；Report Studio 是**报告呈现层**（把分析/研究成果制成 PPT 等交付物）；decision-platform 是**决策执行层**（分析结论→行动→反馈闭环）。链路上 deep-research 的成果文件（报告/成果包）可作为 Report Studio 的输入材料、其结论可进 decision-platform。三者随包并存，各自独立进程/数据/版本，不合并 UI、数据库或 SDK 账本。
- **代表集成用户故事（建议首次接线的闭环）**：JuanerAI 侧发起一项品牌/行业研究 → 宿主经 Adapter 提交研究请求 → run 完成（`published` 或 `limited`，limitations 透传披露）→ 发布不可变版本 → 导出成果包 zip 交宿主稳定副本 →（可选）报告文件流转 Report Studio 呈现。

## 2. 必读材料与身份指纹

### 2.1 宿主侧标准（你所在仓库，直接可读）

本仓 `docs/engineering/plugin-integration/README.md`（PR #93，提交 `6756546a1423162b16a552b24b83bdaa1e834e50`）及 `standard.md`；按需 `acceptance-checklist.md` 与 `report-studio-reference-adapter.md`（后者是 Report Studio 专属实现导览，按其「复用粒度」表只取模式，不照搬文件）。

### 2.2 插件侧基线要点（内嵌，源自插件仓落档，无需访问插件仓）

| 物料 | 身份 |
|---|---|
| 插件业务源候选提交 | `3a3f8c3a910460423a8b7a2638655a100a2aa8e6`（J1：authorize/dataDir 装配透传 + channelCache 键派生化 + 宿主装配测试 7 用例）；**采用时以实际提供物料为准并记录**，不追随 main |
| 固定 SDK | `vendor/pi-agent-runtime-0.4.3.tgz`，108,617 bytes，SHA256 `475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70`（依赖声明 `file:vendor/…`，无浮动版本） |
| 依赖锁 | `package-lock.json` 落档 SHA256 `299edd520bcfd90342ed96be095325acc7619b90c696b012241f4edbe107ef31`（**采用时重算当时的值**） |
| 合成消费者先例 | 插件仓 `src/adapters/hostAssembly.test.ts`（进程内装配闭环正例 + 恒拒负例 + 缓存区分 + 落位断言；J1 交付，433/433 测试 + typecheck 记录） |

运行依赖：Node ≥ 24.21.0（vendored SDK engines）；第三方通知清单见插件 `package.json` dependencies（@mozilla/readability、fflate、linkedom、pi-agent-runtime、pptxgenjs、react、react-dom、react-router-dom、unpdf、zod）。

### 2.3 插件源获取（本任务不预置）

**无需 clone 插件仓。** 接线/打包阶段需要的插件源码或固定物料（精确提交 `3a3f8c3…` 的快照/tar、依赖与通知）由用户在届时另行提供并记录身份；本任务先完成对齐与 Adapter 设计，不被此阻塞。若你的接线需要先跑通插件实例验证接缝，向用户申请获准的运行材料，不自取。

## 3. 插件接入面速览（已经插件侧评估核实，免重复盘点）

- **入口三形态**：库入口 `runResearch(request, adapters, store, options)`（唯一执行入口，全依赖注入，契约 zod：`ResearchRequest/ResearchRun/ResearchResultBundle`）；CLI（`npm run research -- serve|run|project|spike|data-sync`）；HTTP 服务（仅绑 127.0.0.1，`--port`/`--datadir` 显式）。
- **最小任务闭环 API**：`POST /api/projects` → `POST :id/runs`（body 带 `plan` 即**免确认门直跑**——无头消费用这条；不带 plan 走 durable 双确认门 `GET/POST :id/runs/:rid/gate[/confirm|/cancel]`，人审计划/框架）→ 轮询 `GET :id`（runs[].status）→ 运行中控制 `runs/cancel`、`runs/instruct`（skip/add-questions/refine-direction/add-source）、`runs/:rid/budget`（加注）→ `POST :id/publish` → 成果 `GET :id/versions/:v/bundle|/export`（zip）；正式报告 `POST :id/versions/:v/formal` 后 `GET /formal/html|pptx`；证据原文读回 `GET :id/snapshots?sid=`（净化纯文本）。
- **run 终态六种**：`published` / **`limited`（有限交付——证据/预算受限的如实交付+披露，不是失败，宿主须透传 limitations 而非当错误处理）** / `failed` / `cancelled` / `awaiting-confirmation` / `running`。
- **装配级能力（J1，专为宿主准备）**：`piRuntimeModel(configs, { authorize, dataDir, candidates })` 与 `createProjectSessionRuntime` 同款选项——`authorize` 为 SDK 级授权钩子（channel 级，四 kind：model/tool/publish/control；**「拒 publish」与「拒 model」在 runText 通道观察等价**，同抛 `AUTHORITY_REQUIRED`；runAgent 通道返回 blocked 并被编排器降级为该问未答+limitation，不杀 run）；`dataDir` 显式定位审计 `model-audit.jsonl` 与预算账本 `model-budget.json`（优先级：显式 auditPath > dataDir > 插件缺省）。
- **数据根**：HTTP 形态 `--datadir` 或 env `DEEP_RESEARCH_DATA_DIR`；进程内形态 `dataDir` 选项。**随包实例必须用宿主自管数据根（宿主用户空间），不复用插件仓 research-data——仓内 git 双机同步是独立版行为**；账本/锁/会话为运行态，须落可写用户空间。
- **前端**：ui/ SPA 由 serve 从进程 cwd 下 `ui-dist/` 托管；宿主首期可**仅 API 无 UI**（长任务进度经 runs/`runs/:rid/investigation` 轮询自建呈现）。
- **密钥**：仅环境变量（`MINIMAX_CN_API_KEY` 主 MiniMax-M3 / `XIAOMI_TOKEN_PLAN_CN_API_KEY` 备 mimo，完整映射见插件 `src/adapters/piRuntime.ts:37-50`）；`config.json`（0600、密钥禁入）提供模型/搜索主备链；密钥不经 API 写入（settings 路由剥除/拒绝 key 类字段）。
- **LLM 链**：插件自带 vendored SDK 0.4.3（指纹见 §2.2），uncapped 累计 + 单次保护 + 持久预算账本 + 审计轮转齐备——**不与宿主 SDK 统一版本/Session/账本**（标准 §2/§4 允许；宿主自固定版本与插件 vendored 并存）。
- **幂等/生命周期**：取消保留已完成阶段检查点；同 requestId 恢复自最后完成阶段不重放；进程中断后启动清扫 running→failed（可自检查点重跑）；发布版本不可变（同 run 二次发布拒绝）；单 active-run 守卫（409）；情报库绑定幂等键；发布门禁（引用核查/来源撤回/越权绑定阻断）。
- **失败形态差异（Adapter 状态映射必读）**：进程内直消费无顶层 catch——模型级拒绝（AUTHORITY_REQUIRED）以 promise reject 上抛；HTTP 形态则由路由层落 `failed` run 记录。两种形态的失败呈现不同，分别映射。
- **成本画像**：默认预算 80 搜索/60 抓取/90 分钟墙钟（`DEFAULT_BUDGET`），`budgetTier` low/medium/high 可选；token-plan 供应商边际成本记 0；运行中可加注；run 级用量（modelCalls/outputTokens）随 run 记录可读回。

## 4. 待你正式确认的合同决策（插件侧已给推荐默认）

| 决策 | 推荐默认（依据） | 需你确认的内容 |
|---|---|---|
| 承载形态 | **子进程 + loopback HTTP**（`serve --port --datadir` 显式、不依赖 cwd；与参考 Adapter 同构；研究是长任务/重预算，隔离进程更稳） | 进程归属/启停/就绪超时/端口分配；或进程内装配（J1 合成消费者先例） |
| 确认门形态 | 首期 **body.plan 免门直跑**（宿主组装 plan = scope.queries 映射） | 或映射 gate 三端点到宿主交互（人审研究计划/报告框架） |
| UI 呈现 | 首期**仅 API**（进度自建呈现） | 或反代整屏（需随包携带 ui-dist 静态构建产物） |
| 密钥提供 | **宿主 env 注入**（插件 env 优先） | 与宿主密钥保管策略对齐 |

另有一项产品决策：会话研究记忆（`sessionDigests`/追问 `runs/followup`）首期是否启用——建议**不启用**（候选链不注入即自动降级零纪要），追问能力后续按需开。

## 5. 工作要求

- 按标准 §5 五步推进；「盘点」插件侧已完成（v0.4 评估 + J1，要点见 §2.2/§3），你的盘点对象是**宿主侧**（装配点、任务/成果映射、访问边界、打包工具链）。
- **接线产物是薄 Adapter/Profile**：进程管理 + 就绪探针（`GET /api/projects` 可用性即就绪信号）+ **owner token/回环/origin 守卫（参考 Report Studio `local-access` 模式；插件 API 无鉴权是单机单用户假设，宿主暴露面必须自建）** + 任务↔项目/run 映射 + 成果读回稳定副本（交付读回用 `versions/:v/export`，字节稳定，适合 receipt/副本模式）。**不重写插件业务、不复制两份业务逻辑**。
- 数据隔离：宿主实例使用自己的数据根（宿主用户空间）；插件项目存储/情报库/账本独立，不并宿主库。
- 验证：从 `acceptance-checklist.md` 选适用项（建议 C01 固定身份、C02 双交付、C03 生命周期（若子进程）、C04 同版输入与越权拒绝、C05 合成凭据/路径、C06 发布幂等、C07 取消/迟到/保存失败、C08 产物回读、C09 恢复/持久、C10 SDK 合成 codec + authorize 钩子、C11 业务正确性用合成消费者）；先确定性合成接缝，真实 Provider/live 按授权执行。研究插件的业务质量验收以研究产物为准，不套 PPT/Keynote 呈现口径。
- 固定交付与记录：首次采用即建立 source-identity（精确提交 + vendor tgz SHA + lockfile SHA——**lockfile 采用时重算**，§2.2 值仅为落档时点）；若带 UI 随包需静态构建 ui-dist（`BUILD_HEAD` 自动重建是独立版启动机制，随包应以固定构建产物入包）；采用、安装/运行、发布、接受分别记录，不互相代替。

## 6. 边界与红线

- 业务实现与中立修复在插件原仓维护；宿主侧如需插件改动，走原仓任务，不在宿主副本改业务（当前宿主副本修改与回流状态：**尚未发生**）。
- 不能证明新物料保留已验业务修复或数据兼容时，**阻止该次新升级、保留旧验收包**；活动/UNKNOWN 任务不热换；程序回滚不等于数据可逆。
- 不统一插件间 SDK 版本、Session、存储或物理账本；不为假想需求要求插件加 owner-token/鉴权 hook（插件侧评估已裁定：宿主 Adapter 层解决，除非你的合同正式要求并回流原仓）。
- `limited` 是有限交付不是失败；两种消费形态的失败映射差异（§3）分别处理，不得混用。

## 7. 交回

按标准 §5/§6 记入既有 OpenSpec/验证章节：已读取材料与身份、四项决策 + 一项产品决策的确认结果、Adapter 接点清单、验证证据（区分「已有记录证明」与「本轮执行」）、source-identity 与升级基线差异表、未执行/UNKNOWN 清单。区分「已读取/已采用/经证据验证符合」，不以静态对照宣称运行验证通过。
