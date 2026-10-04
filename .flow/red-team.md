# Red-Team: 报告丰满度三重改进(draft 硬要求 + writer 素材 + 润色 pass)

## Top Kill-Assumptions(ranked)

### K1. 丰满度硬指标不会诱发编造(冲击最大)

- **Claim:** 可以在不放松"只写有证据内容"约束的前提下,用每节篇幅下限、表格化数据矩阵等硬指标把报告写丰满。
- **Fails if:** 模型为了满足"每节最低篇幅/必须出表格"的硬指标,在证据不足的节里编造数据填充——丰满度提升以可信度下降为代价。这是本提案与项目核心定位(可信度工程)正面冲突的地方。MiniMax M3 在强格式约束+长输出下倾向"填满"而非"披露不足"。
- **Evidence to get this week:** 试点跑一个真实 run,对比改动前后报告:统计 unverified 主张数、review 阶段 citation 类 issue 数、发布门禁拦截数。
- **Kill criterion:** 改动后单 run 中"无证据支撑的实质性断言"数量 > 改动前基线,或发布门禁新增拦截率显著上升且源自 draft 编造。
- **Cheapest test:** 只改 draft prompt(改进 1)跑一个试点 run,人工审读丰满节是否均有证据回溯。

### K2. 诊断本身正确:prompt/素材/环节三层是主因,而非模型写作能力

- **Claim:** 不丰满的主因在工程三层(要求薄、素材薄、无润色),而非 MiniMax M3 的写作能力上限。
- **Fails if:** 三层都补完后报告仍明显薄于 Kimi/Gemini——那瓶颈在模型,继续调 prompt 是边际浪费,应转而考虑换写作模型(被项目约束禁止,则此方向整体收益封顶)。
- **Evidence to get this week:** 改进 1+2 落地后同一研究目标试点,报告字数/结构密度对比 flow-center 同类报告。
- **Kill criterion:** 三层改进落地后丰满度(节均字数、表格数、证据回溯密度)提升 <30%。
- **Cheapest test:** 改进 1(零素材改动)单点试点,若篇幅即显著增长,说明要求层是主因,诊断成立。

### K3. 快照正文进 writer 上下文,成本与时延可控

- **Claim:** 把快照正文切块喂给 draft 不会使单 run 成本翻倍或撑爆 300s 超时。
- **Fails if:** 快照正文总量远超预期(一个 run 几十张快照×全文),输入 token 暴涨,成本显著上升;长输入下 JSON-only 输出合规率下降(draft 要求整份报告包在 JSON 里,输出本来就长,输入再加长,超时/截断风险叠加)。p-muaman1a 的实例正是 draft 失败兜底成证据清单。
- **Evidence to get this week:** 统计现有 run 的快照正文字数分布(读 research-data 下 snapshots.json),估算每问题切块预算下的输入增量。
- **Kill criterion:** 输入增量 >3× 或试点 run draft 阶段超时/解析失败率高于现状。
- **Cheapest test:** 先量数据再设计切块策略,不做拍脑袋预算。

### K4. 润色 pass 的收益大于其成本

- **Claim:** 新增一轮扩写/润色 pass 带来的丰满度收益值得其 LLM 成本与时间。
- **Fails if:** 改进 1+2 之后 draft 已足够丰满,润色 pass 成为纯增量成本;或润色 pass 引入事实漂移(改写时数字/口径被改动),反而伤害可信度。
- **Evidence to get this week:** 改进 1+2 试点后评估是否还需要 pass 3;若做,定义其输入=草稿+快照+评审意见,输出仍受发布门禁约束。
- **Kill criterion:** 润色前后丰满度指标变化 <10%,或发布门禁在润色后新增拦截(漂移证据)。
- **Cheapest test:** pass 3 设计为可选开关(默认关或按深度档位),先不默认开启。

## What's Well-Reasoned

- **对照证据扎实**:flow-center write 节点 8 条硬指标与 326 行模板是已验证有效的"丰满度配方",deep-research draft 一句话 prompt 的差距是明确可指的,改进 1 的方向不需怀疑。
- **素材层诊断有结构性依据**:writer 只见蒸馏摘要不见原文,这是架构性事实(runResearch.ts draft 段输入清单可查),Kimi/Gemini 写手通读原文的模式支持这一层改进的必要性。
- **"formal 不新增事实"边界划得对**:润色放在草稿阶段、formal 仍只重组,与既有两阶段原则(草稿→确认→正式)不冲突。
- **明确不做清单**(不引入 DAG、不换模型)防止了范围蔓延。

## What I Couldn't Assess

- 现有 run 的快照正文总量与切块预算的合理值——需要读 research-data 实测(留给 ISSUES 前完成)。
- MiniMax M3 在长输入+长 JSON 输出下的实际超时率——只能靠试点实测。
- 用户可接受的单 run 成本增幅上限未定义——PRD 需给一个默认(如成本增幅 ≤50%)供确认。
