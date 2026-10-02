# 深度研究竞品调研与借鉴清单

> 版本：v1.0 · 编制：2026-10-02 · 性质：外部产品调研 + 本工作台对照分析
> 调研对象：Gemini Deep Research / Kimi（月之暗面）/ OpenAI Deep Research / Perplexity / Grok DeepSearch / Manus / 秘塔深度研究
> 用途：作为 2.x 增量升级（dev-flow）的输入；编制时点为 2026-10，各产品功能处于快速演进期，落地前建议复核官方文档

---

## 目录

1. [背景与结论](#1-背景与结论)
2. [机制速览对比](#2-机制速览对比)
3. [各产品详细拆解](#3-各产品详细拆解)
4. [与本工作台对照](#4-与本工作台对照)
5. [借鉴清单（按优先级）](#5-借鉴清单按优先级)
6. [明确不采纳项](#6-明确不采纳项)
7. [主要来源](#7-主要来源)

---

## 1. 背景与结论

对 2025 年发布至 2026-10 的主流"深度研究（Deep Research）"产品做机制与交互调研，对照本工作台现状，回答"哪些该学、哪些已领先、哪些不学"。

**总结论：**

- 共性骨架（计划先行 → 多步搜索循环 → 带引用报告 → 异步任务化）本工作台基本具备，且"计划 + 报告框架双确认"比各家多一道人工门；
- 本工作台在**真实性核查**（多源交叉 / 语义蕴涵 / 数值复算 / ABC 分级）、**有限交付与限制披露**、**不可变版本发布**、**检查点续跑**上领先全部被调研产品；
- 真正值得借鉴的集中在 6 个点（见 §5），最大缺口是 **P0「追问扩展而非重跑」** 与 **P0「执行中干预」**；
- Perplexity 式"定时循环研究 / 自动监控推送"与 WHITEPAPER 2.0「明确不做」清单冲突，不采纳。

---

## 2. 机制速览对比

| | 计划门 | 循环规模 | 过程透明 | 执行中可干预性 | 产出形态 |
|---|---|---|---|---|---|
| **Gemini** | 研究计划可编辑后执行（API `collaborative_planning` 多轮细化） | 标准档 ~80 次搜索 / ~25 万输入 token；Max 档 ≤160 次搜索、$3-7/次、任务上限 60 分钟 | 思考面板（thought/text/image 三类流式增量）+ 实时 URL 侧栏 | 可离开、完成后多渠道通知；中途不可改方向 | Canvas 报告 + 导出 Google Docs + Audio Overview；MCP 数据源（FactSet/S&P/PitchBook） |
| **Kimi** | **两段门**：意图澄清轮（带初步搜索）→ 结构化研究计划 | 平均 23 步推理、200+ URL、70+ 查询、10-25 分钟；K2 Thinking 后 200-300 次工具调用 | 检索词 / 推理步骤 / 访问 URL 三个流实时可见 | 前置（澄清/排除/限定信源）+ 后置（追问/导出）可控；**执行中基本不可干预** | 双产物：可溯源 Markdown（引用点击跳转并高亮原文）+ 自动生成 ~1500 行代码的交互 HTML；六种导出格式 |
| **OpenAI** | 可能先提澄清问题 + 用户可审阅可编辑的研究计划 | 5-30 分钟、综合数百来源；API `max_tool_calls` 控深 | activity feed 分层展示浏览/阅读/推理 | **2026-02 起支持实时跟踪 + 中断 + 追加指令/新信源修正方向 + 限定可信站点** | 句级内联引用 + 嵌入网页图片与 Python 图表；超额自动降级轻量版续跑 |
| **Perplexity** | 先生成研究计划再迭代执行 | 数十次搜索、阅读上百来源、多数 2-4 分钟 | 每步搜索动作实时可见 | Tasks 异步队列、可离开、可并行多任务 | 报告 + 独立 Sources 页 + 转 Page 分享；定时循环研究任务 |
| **本工作台** | **计划 + 报告框架双确认**（比各家多一道） | 默认 8 搜 / 12 抓，六阶段顺序推进 + 检查点 | 六阶段步骤条 + 用量指标卡 + 2.5s 轮询 | 可随时取消 + 检查点续跑；**执行中不可改** | 草稿 → 确认 → 正式 HTML/PDF/PPTX + ZIP 证据包；不可变版本 + 差异摘要 |

---

## 3. 各产品详细拆解

### 3.1 Gemini Deep Research

**流程与模型演进。** 2024-12-11 随 Gemini Advanced 上线（1.5 Pro，1M token 上下文），首创"生成研究计划 → 用户修改/批准 → 自主执行"形态。此后：2.0 Flash Thinking 实验版（2025-01）→ Gemini 2.5 Pro 实验（2025-03/04）→ Gemini 3（2025-11-18，全阶段加持）→ **Deep Research Max（2026-04-21，Gemini 3.1 Pro 驱动，经 API 公开预览）**。当前官网口径"从规划到报告全程由 Gemini 3 加持"。

- 来源：[2024-12 发布公告](https://blog.google/products-and-platforms/products/gemini/google-gemini-deep-research) / [官方产品页](https://gemini.google/overview/deep-research) / [帮助文档](https://support.google.com/gemini/answer/15719111) / [Deep Research Max 公告](https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research) / [Gemini API 文档](https://ai.google.dev/gemini-api/docs/deep-research)

**机制要点。**

- Agent 循环官方描述为"搜索 → 阅读 → 基于所学发起新搜索 → 重复"；API 形式化为"规划 → 搜索 → 阅读 → 重复 → 输出"。
- 计划是 API 一等参数：`collaborative_planning=true` 时多轮细化计划，置 `false` 才开始执行——"计划门"即该参数的翻转点。
- 规模（API 预览口径）：标准档约 80 次搜索、~25 万输入 token（50-70% 命中缓存）、~6 万输出；Max 档最多 160 次搜索、~90 万输入、$3-7/次；异步后台任务，上限 60 分钟，多数 20 分钟内完成。
- 工程：多步规划在"全面性 vs 计算时间"间权衡；异步任务管理器做错误恢复（单步失败不从头重来）；研究期间可关机，完成后通知；1M token 上下文 + RAG 记住整个会话。

**透明度与交互。**

- 研究中：思考面板 + "Researching N websites…" 实时增长来源列表；API 以流式 `step.delta` 事件输出（thought / text / image 三种增量，图表以 base64 图像流出）。
- 完成后：报告在 Canvas 面板打开；Ultra 用户可含图表/示意图/交互模拟器（启用 Workspace 私有来源时不出图）。
- **Sources 按钮**：可勾选 Google Search（默认开）/ Gmail / Drive / NotebookLM 笔记本，甚至关掉全网只查私有数据——来源范围是显式用户选择。

**产出与生态。**

- 多章节结构化报告；API 输出带引用 Markdown，报告结构靠提示词控制（无结构化 schema）。
- Canvas 的 Share & export：分享 / 导出 Docs / 复制内容（无直接 PDF）。
- 追问走 `previous_interaction_id` 复用研究上下文，**不重跑**。
- 衍生：Audio Overview（播客音频）、交互式内容/测验；NotebookLM 2025-11 起内置 Deep Research；2026-01 起 Gemini "My Stuff" Documents 集中管理历次报告。

**第三方评测要点。**

- Section AI 实测：可用性 5/5 但产出质量 2.5/5（ChatGPT 4/5、4.5/5）——内容停留在"一次 Google 搜索就能拿到"的表层。([来源](https://www.sectionai.com/blog/chatgpt-vs-gemini-deep-research))
- Tom's Guide（2026-02）：多章节报告 + 按优先级排列来源 + 能权衡冲突证据；但引用并非总可靠。([来源](https://www.tomsguide.com/ai/people-are-sleeping-on-geminis-deep-research-feature-heres-why-its-actually-a-game-changer))
- Newscatcher 七工具横评：全网覆盖最广、API 最便宜、计划可编辑；**但 2026 年 URL 审计中"损坏/编造链接最多**，报告质量上限由检索层决定"。([来源](https://www.newscatcherapi.com/blog-posts/best-deep-research-tools))

### 3.2 Kimi（月之暗面）

**产品线演进。** Kimi 探索版（2024-10，10 倍搜索量、一次精读 500+ 页面）→ **Kimi Researcher（2025-06-20 官宣，端到端 agentic RL 训练的自主 agent）** → K2 / K2 Thinking（2025-11，单会话 200-300 次工具调用不跑偏）→ 2026 现状：kimi.com/deep-research 独立入口，"输入主题（可传文件）→ 澄清问题 → 生成结构化研究计划 → 自主执行数十次定向搜索（开放网络 + 专业数据库/实时金融数据）→ 多格式交付"。模型线：K2.5（2026-01）→ K2.6（2026-04）→ **K3（2026-07-16 发布、07-27 开放权重，2.8T MoE / 104B 激活 / 1M 上下文 / 原生多模态）**。
- 来源：[Kimi Researcher 官宣](https://x.com/Kimi_Moonshot/status/1936105761358368944) / [官方技术报告页](https://moonshotai.github.io/Kimi-Researcher) / [帮助中心](https://www.kimi.com/help/deep-research/deep-research-overview) / [功能页](https://www.kimi.ai/features/deep-research)

**机制要点（Kimi Researcher 技术报告）。**

- 官方数据：平均每任务 **23 步推理、探索 200+ URL、70+ 搜索查询**；上下文管理使 rollout 可延展到 **50+ 轮迭代**（无上下文管理约 10 轮）。产品口径换算：平均规划 74 个关键词、找到 206 个网址、**只保留质量前 3.2%** 内容，全程 10-25 分钟。
- 训练：端到端 agentic RL（REINFORCE 为主、严格 on-policy），奖励只有格式奖励 + 正确性奖励，gamma 衰减偏好更短轨迹；训练数据自动大规模合成；全异步 rollout + turn 级部分 rollout。
- 工具仅三个：并行实时内部搜索、文本浏览器、代码执行；经 MCP 有状态会话通信。
- 涌现行为：对简单问题也额外搜索交叉验证、迭代假设修正解决信源冲突、**中英双语混合搜索**提升覆盖。

**两段式前置门（对本工作台最有参考价值）。**

1. **意图澄清轮**：先反问明确方向（用户可确认/细化，或一键"做个全面的研究"跳过）——实测显示该步已带初步搜索，用背景补充澄清问题；Kimi 靠这步避免了竞品"把研究对象搞错"的事故（横评中 ChatGPT/Gemini 把 YU7 错改成 SU7，Kimi 正确）。
2. **结构化研究计划**：展示后再进入自主执行。用户可控点集中在**前置**（澄清、排除方向、指定时间/地域/信源类型如 PubMed/arXiv）与**后置**（追问、导出），执行中段基本不可干预，官方甚至建议"避免主动终止"。

**产出与生态。**

- **双产物分离**：①深度研究报告（Markdown，万字级、平均 26 个可溯源信源，引用内嵌正文、点击跳转并**高亮原文位置**）；②可视化报告（HTML，文字报告完成后自动编写 ~1500 行代码生成交互网页：卡片/表格/思维导图/横向对比，可生成公开分享链接、可复制源码）。
- 导出：2025 为 PDF/Word，2026 扩展为 HTML/Word/PPT/Excel/PDF/Markdown 六种。
- 追问：同一会话多轮，**"扩展而非从零开始"**，保留上下文。
- 兜底：工具调用失败导致任务失败时额度自动返还（单次约耗 5-10% 月度额度）。
- 2026 动态：Kimi Work 桌面端 agent（项目=本地文件夹、Agent 集群多 agent 并行、**目标模式三要素：预期结果+验收检查+约束条件**、权限三档）；金融行业方案接入 Wind/东财/标普。
- 横评结论（[腾讯云实测](https://cloud.tencent.com/developer/article/2652153)、[53AI](https://www.53ai.com/news/OpenSourceLLM/2025070496385.html)）：中文信源深处理与冷门检索占优、可视化交付为三家中唯一默认自动生成；写作偏学术、层级过深。分工共识：中文深处理 Kimi / 英文机制阐述 OpenAI / 检索广度速度 Gemini。

### 3.3 OpenAI Deep Research

**机制。** 2025-02-02 上线（Pro 首发），底层为针对网页浏览与 Python 工具优化、端到端 RL 训练的 **o3 变体**（非手工编排工作流）；单任务 5-30 分钟、综合数百在线来源；API 以 `max_tool_calls` 为成本/时延主杠杆。2025-07-17 并入 ChatGPT agent（可视化浏览器 + 深度研究统一入口）。API 侧 `o3-deep-research` 走 Responses API，须挂至少一个数据源（web search / file search 向量库 / 远程 MCP），输出 `web_search_call` 等事件流与带句级 annotation（url + start/end 索引）的报告；该端点 2026-07-23 下线，由 `gpt-5.6-sol` 接替。
- 来源：[Introducing deep research](https://openai.com/index/introducing-deep-research) / [API Guide](https://developers.openai.com/api/docs/guides/deep-research) / [Help Center](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt)

**交互与产出。**

- 研究前：可能先提**澄清问题**，并生成**用户可审阅、可编辑的研究计划**。
- 研究中：activity feed 实时展示浏览、阅读与推理步骤摘要 + 已用来源；可离开，完成推送通知。
- **2026-02-10 更新（对本工作台最有参考价值）**：深度研究可连接任意 MCP 服务器/应用、可把网络搜索**限定在可信站点列表**、可**实时跟踪进度并中断**，中途用追加指令或新信源修正方向。
- 报告：句级内联引用、嵌入网页图片与 Python 生成图表；可上传文件/表格作为研究对象；支持导出与同对话追问。
- 用量：免费 5 次/月，Plus 25 次/月，Pro 250 次/月，**超额自动降级 o4-mini 轻量版续跑（不占额度）**。

### 3.4 Perplexity Deep Research

- 2025-02-14 上线：先生成研究计划，再迭代"搜索 → 阅读 → 推理 → 细化查询"，由 agentic reasoning model **自主评估信息是否充分**、充分即停止；官方口径"数十次搜索、阅读上百个来源"，多数任务 2-4 分钟。具备搜索 + 编码双能力，可运行代码分析数据。([官方博客](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research))
- 交互：执行中实时展示每步搜索；报告带编号内联引用（选中文本高亮对应信源）+ 独立 Sources 页；可导出 PDF 或转 Perplexity Page 分享。
- **Tasks 异步队列**：提交即任务对象，可离开、可并行、完成通知、统一面板管理；2026-02 Perplexity Computer 进一步把深度研究做成可并行长任务（数十实例并行、单任务数千步），产出报告/幻灯片/仪表盘。([Perplexity Computer](https://www.perplexity.ai/hub/blog/introducing-perplexity-computer) / [Deep Research in Computer](https://www.perplexity.ai/hub/blog/deep-research-now-in-computer))
- **定时任务**：每日/每周循环研究，有值得注意的增量时才推送通知并存档。([帮助中心](https://www.perplexity.ai/help-center/en/articles/11521526-perplexity-tasks))

### 3.5 其他三家简述

- **Grok DeepSearch（xAI）**：2025-02 随 Grok 3 推出，agent 式研究 + **同时抓取开放网页与 X 平台实时数据**（最大差异点）；DeeperSearch 为加深变体。([xAI](https://x.ai/news/grok-4-1-fast))
- **Manus**：研究被泛化为云端虚拟电脑里的通用任务执行（浏览器+终端），交付物导向，"Manus's Computer" 实时可视；模型无关可路由多家。([评测](https://www.layer3labs.io/guides/manus-ai-review))
- **秘塔深度研究（Metaso）**：国内首个免费开放；多并行子任务 + 动态"问题链"多线追搜，单次数百网页（实测 ~540 信源 / 32 万 token），万字报告 + 一键可视化；积分制计深浅。([新浪实测](https://finance.sina.com.cn/cj/2025-07-15/doc-inffpfvy7317596.shtml))

### 3.6 开源复现参考

- **通义 Tongyi DeepResearch-30B-A3B**（2025-09-16）：首个宣称与 OpenAI DeepResearch 持平的全开源 web agent（HLE 32.9 / BrowseComp 43.4）；方法论 Agentic CPT → SFT → on-policy RL，任务全合成；**IterResearch：每轮把发现沉淀为证据笔记、重建精简工作区，防长程上下文污染**。([官方博客](https://tongyi-agent.github.io/blog/introducing-tongyi-deep-research) / [GitHub](https://github.com/Alibaba-NLP/DeepResearch))
- HuggingFace open deep research：开放搜索 agent + 开放权重模型复现。([HF Blog](https://huggingface.co/blog/open-deep-research))
- 对本工作台的启示：编排层与模型解耦（本工作台已做到适配器边界）+ **长研究中"证据台账/精简工作区"式的上下文管理**值得在采证→分析→草稿的长链条上持续贯彻。

---

## 4. 与本工作台对照

### 4.1 已领先、无需跟进的点

| 能力 | 本工作台 | 最接近的竞品实现 | 差距判断 |
|---|---|---|---|
| 真实性核查 | 多源交叉 / 语义蕴涵 / 数值复算 / ABC 信源分级，快照高亮抽屉 | Kimi 引用点击跳转并高亮原文；无蕴涵级核查 | **领先**；Gemini 2026 审计"坏链/编造链接最多"恰是本工作台已解决的问题 |
| 交付诚实性 | 命中率 <80% 有限交付 + 限制披露置顶，未核查主张降级保留 | 无一家有等价机制 | **领先** |
| 版本治理 | 不可变版本 + 差异摘要 + 研究绑定来源版本 | 无 | **领先** |
| 中断恢复 | 可取消 + 检查点续跑，已完成调用不重放 | Gemini API 有错误恢复；消费端无 | **领先（消费端对比）** |
| 计划门 | 计划 + 报告框架双确认 | 各家仅计划单确认 | **多一道门，保留** |

### 4.2 主要缺口

1. 任何追问都要新开 run 重花预算与时长，无"基于既有研究的增量扩展"；
2. 执行中只能整跑取消，无法追加指令 / 补充信源 / 修正方向；
3. 发起前无意图澄清轮（计划预览承担一半职责，但目标歧义没有便宜的反问点）；
4. 过程呈现是阶段级步骤条，无"正在研究第 N 个网站 / 当前检索词"级轨迹流（`audit.jsonl` 已有数据，纯呈现层缺口）；
5. 来源范围不可显式勾选（全网 / 情报库 / 混合），2.0 情报库复用缺一个发起侧入口；
6. 预算是裸参数而非档位，无预算耗尽自动降档续跑；
7. 运行指标只有用量与命中率，无"搜索→抓取→采纳→核查"漏斗；
8. 正式报告无数据图表（HTML/PPTX 为模板精排）。

---

## 5. 借鉴清单（按优先级）

> 每条标注机制出处；落地方式须贴合现有架构（编排器唯一入口、检查点、zod 契约、适配器边界）。

### P0

> **状态（2026-10-02）：P0 两条已落地**（dev-flow 2.1，commit 待 SHIP 后回填）——P0-1 增量追问 run（双确认增量流程 / 基准证据注入 / 同 URL 不重抓 / reuseSummary 与发布差异注记 / formal 增量元信息条）；P0-2 执行中干预（instruct API / pending 指令落盘跨取消恢复 / gather 问题间隙消费四类指令 / 干预历史落 run 记录）。

1. **追问扩展而非重跑**（Gemini `previous_interaction_id` / Kimi "扩展而非从零开始"）
   同一项目内允许基于已完成 run 的证据、快照、主张发起增量研究：新问题只采缺失证据，已有证据按版本绑定复用。本工作台的证据库、来源版本绑定是天然基础，竞品里只有本工作台的数据形态能完整做到"复用即免重采"。
2. **执行中干预**（OpenAI 2026-02：中断 + 追加指令/信源修正方向）
   采证逐问推进的架构在问题间隙天然有注入点：运行中允许提交"跳过当前问题 / 新增问题 / 修正方向 / 补充信源"指令，编排器在问题边界消费指令队列；取消仍是兜底。

### P1

3. **意图澄清轮**（Kimi 两段门前半段）
   新建 run 时先做一次"反问 + 可一键跳过"的意图澄清（可带一轮快速搜索供背景），再进计划预览；保留"直接全面研究"默认路径，不新增强制门槛。
4. **研究轨迹流产品化**（Kimi 三流 / Gemini URL 侧栏）
   把 `audit.jsonl` 投影为运行页实时侧栏：当前检索词、正在抓取的 URL、已完成问题数。数据已落盘，纯前端 + 只读 API 工作。
5. **来源范围勾选**（Gemini Sources 按钮）
   发起 run 时显式选择：仅全网 / 情报库优先+全网补 / 仅情报库。与 2.0 外部情报库闭环咬合，同时是范围与预算控制。

### P2

6. **深度档位 + 预算耗尽降档续跑**（Gemini 标准/Max / OpenAI `max_tool_calls` + 超额降级轻量版）
   把预算参数产品化为"快速 / 标准 / 深研"三档预设；预算到顶时优先降档续跑而非停在 capped（保持现有 capped 如实记录原则）。
7. **引用漏斗指标化**（Kimi "206 网址取前 3.2%、平均 26 信源"）
   运行指标卡增加"搜索 → 抓取 → 采纳 → 核查通过"漏斗，与命中率并排展示。
8. **正式报告内联数据图表**（OpenAI Python 图表 / Gemini 原生图表 / Kimi 自动写交互 HTML）
   对数值密集节自动生成图表嵌入 HTML/PPTX 正式报告；仅在用户要求或检测到数值密集时生成，控制成本。

---

## 6. 明确不采纳项

| 项 | 出处 | 不采纳理由 |
|---|---|---|
| 定时循环研究 / 自动监控推送 | Perplexity Scheduled Tasks | 与 WHITEPAPER 2.0 §1.5「明确不做：自动竞争监控推送」冲突 |
| 音频播客类衍生产物（Audio Overview） | Gemini / NotebookLM | 与工作台定位（可追溯研究资产）无关，边际价值低 |
| 公开分享链接托管 | Kimi / Perplexity Page | 单机单用户产品，无公网托管面 |
| 多租户/并行实例集群 | Perplexity Computer / Kimi Work Agent 集群 | 与「单机单用户」架构基线冲突 |

---

## 7. 主要来源

**Gemini**：[官方产品页](https://gemini.google/overview/deep-research) · [帮助文档](https://support.google.com/gemini/answer/15719111) · [2024-12 发布公告](https://blog.google/products-and-platforms/products/gemini/google-gemini-deep-research) · [Deep Research Max 公告 2026-04](https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research) · [Gemini API 文档](https://ai.google.dev/gemini-api/docs/deep-research) · [Section 实测](https://www.sectionai.com/blog/chatgpt-vs-gemini-deep-research) · [Tom's Guide](https://www.tomsguide.com/ai/people-are-sleeping-on-geminis-deep-research-feature-heres-why-its-actually-a-game-changer) · [Newscatcher 横评](https://www.newscatcherapi.com/blog-posts/best-deep-research-tools)

**Kimi**：[Kimi Researcher 官宣](https://x.com/Kimi_Moonshot/status/1936105761358368944) · [技术报告页](https://moonshotai.github.io/Kimi-Researcher) · [帮助中心](https://www.kimi.com/help/deep-research/deep-research-overview) · [功能页](https://www.kimi.ai/features/deep-research) · [腾讯云实测](https://cloud.tencent.com/developer/article/2652153) · [53AI 横评](https://www.53ai.com/news/OpenSourceLLM/2025070496385.html) · [Kimi Work 指南](https://www.kimi.com/academy/kimi-work-getting-started)

**OpenAI**：[Introducing deep research](https://openai.com/index/introducing-deep-research) · [Deep Research API Guide](https://developers.openai.com/api/docs/guides/deep-research) · [Help Center](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) · [ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent)

**Perplexity**：[官方发布博客](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) · [Perplexity Computer](https://www.perplexity.ai/hub/blog/introducing-perplexity-computer) · [Tasks 帮助](https://www.perplexity.ai/help-center/en/articles/11521526-perplexity-tasks)

**开源**：[Tongyi DeepResearch](https://github.com/Alibaba-NLP/DeepResearch) · [HF open deep research](https://huggingface.co/blog/open-deep-research)

**信息可信度说明**：各产品限额/定价数字多为第三方或社区口径（Google、Perplexity 官方不公布静态值，动态调整）；Kimi「K2 系列 API 2026-05 下线」来自平台文档摘要，使用前建议到 platform.kimi.com 复核。本工作台对照基于 main @ 041856f 的代码现状。
