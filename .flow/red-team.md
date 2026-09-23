# Red-Team: 深度研究工作台 2.0 — 外部情报库与跨研究复用（增量升级）

红队对象：`.flow/proposal.md`（用户提供的目标方案全文）。校准性事实：2 分钟仓库浏览（非 WP00 正式核查）——`src/contracts.ts` 已有 `SourceSnapshot`/`Evidence`/`Claim`/`ResearchResultBundle` 的 zod schema；`research-data/projects/` 下 6 个真实项目，各含 `requests/runs/reports`；`package.json` 有 test/typecheck/build 门禁。

### Top Kill-Assumptions (ranked)

1. **Claim：** v1 的"研究核心"可增量扩展——来源/证据对象已存在且可复用，2.0 不需要重建采证流水线。
   - **Steelman：** contracts.ts 已有 SourceSnapshot/Evidence/Claim/ResearchResultBundle 的 zod schema；一期 seam 确认 `runResearch` 是唯一执行入口，适配器边界清晰。
   - **Fails if：** SourceSnapshot/Evidence 只在运行内存中短暂存在、不落盘，或落盘粒度不足（只有报告 markdown + 摘要 JSON），则"来源版本 + 证据定位"要重写 pipeline 持久化层，每个 stage 都动，"增量"名存实亡。
   - **Evidence to get this week：** WP00 只读核查——`research-data/projects/*/runs/` 实际落盘了什么、contracts schema 字段粒度、fsStore 写路径。
   - **Kill criterion：** 若现有运行产物中没有可机读的来源快照 + 证据定位，且补齐需改动 >50% 的 pipeline stage → 收缩本轮到 U2-01/02/03/05（入库+留档+列表+检索），版本绑定与复用降级为后续，升级方案范围需用户重批。
   - **Cheapest test：** WP00 半天只读盘点（方案本身已列为第一工作包）。

2. **Claim：** 跨研究复用价值闭环会真实发生（资料先积累 → 研究可复用 → 新证据再沉淀）。
   - **Steelman：** 用户已确认方向（附录 B2）；同一用户的品牌/行业研究对象有交集；方案只要求"人工选择复用"，不赌自动推荐。
   - **Fails if：** 真实研究任务对象/口径高度一次性，旧材料几乎过不了 check_reuse 的适用性检查，情报库沦为只写不读的归档。
   - **Evidence to get this week：** 盘点现有 6 个项目的来源 URL/标题重叠度；用冻结数据模拟"第二次研究检索第一次的资产"。
   - **Kill criterion：** 历史项目间来源重叠为零且主题互不相关 → 复用价值未被证明。但方向是 proposal 已确认决策，kill 的含义是降级自动化预期、保留最小闭环，不是取消。
   - **Cheapest test：** WP00 一个统计脚本。

3. **Claim：** 权限/复用范围可在服务端多阶段强制执行而不泄露（S-01…S-04）。
   - **Steelman：** v1 是 127.0.0.1 本地 server + SPA，读写经 server 路由，理论上存在收口点。
   - **Fails if：** 模型上下文组装 / 导出路径没有统一 choke point，权限检查只能补丁式散点加装，必然漏（搜索计数、摘要、日志、错误消息都可能泄露受限内容）。
   - **Evidence to get this week：** WP00 核查 server 路由清单与 runResearch 上下文组装入口数量。
   - **Kill criterion：** 若不存在单一收口点 → 诚实降级：权限标志落库，只在"外发（外部模型/导出）"路径强制，库内检索可见性本轮不承诺，写入已知限制。不允许假装已强制。
   - **Cheapest test：** 读 `src/server/` 与 `src/core/runResearch.ts` 的组装入口。

4. **Claim：** 历史项目能按三类路径兼容迁移且不伪造底稿。
   - **Steelman：** 方案禁止回填虚构来源，"只有报告"仅登记为派生成果——原则正确。
   - **Fails if：** 现有项目大多只有报告而无原文快照 → 迁移后绝大多数资产是"底稿缺失"级，复用价值几乎完全面向未来；若预期"旧研究立刻可复用"，期望落空。
   - **Evidence to get this week：** WP00 统计各项目 runs/ 内原文快照文件留存率。
   - **Kill criterion：** 原文留存率极低 → 迁移收缩为登记级（registry-only），明示复用价值前瞻化。这是期望校准，不是取消理由。
   - **Cheapest test：** 一个 find/统计脚本。

5. **Claim：** U2-01~U2-10 + 33 个验收用例（A-01…A-18、S-01…S-15）能在一个 dev-flow 预算（60 轮 / 12h）内诚实交付。
   - **Steelman：** 一期一个 flow 交付了 57 测试 + server + UI；2.0 是增量。
   - **Fails if：** 权限+版本+去重+迁移+三个新页面（列表/详情/选择器）的诚实实现超预算，被迫在质量门禁上放水。
   - **Evidence to get this week：** ISSUES 拆解时的真实切片估算与依赖图。
   - **Kill criterion：** 拆解估算超预算 → 拆 U2-A（入库+留档+版本绑定+检索复用闭环）与 U2-B（迁移+高级治理），本轮先交 U2-A，向用户明示。
   - **Cheapest test：** ISSUES 阶段切片计数。

### What's Well-Reasoned

- 不伪造、不越权、版本冻结、转引不升级为已读原文——经得起攻击的正确原则；方案 1.1 自我声明未核查现状，没有过度宣称。
- 报告 = 派生成果、不作为自身证明；同源不算独立证据——直击 AI 研究产品最常见的自我强化失败模式。
- WP00 先核查再动手、迁移先备份预演——顺序正确；红队四个最贵假设恰好都被 WP00 廉价覆盖。
- 优先级排序（不伪造不越权 > 引用版本可靠 > 闭环可用 > 体验 > 自动化）与第 19 章风险表一致。

### What I Couldn't Assess

- 现有代码真实状态（WP00 的职责；本报告只做了 2 分钟校准性浏览）。
- 真实数据量、模型供应商行为、性能门槛（方案附录 A 已列为冻结参数）。
- 用户对"本轮必须交付 vs 可降级"的容忍度——若 WP00/ISSUES 暴露范围超限，需用户定夺。

**Verdict: go。** 没有任何 kill criterion 已被满足；最该先测的四件事就是方案自己规定的 WP00。
