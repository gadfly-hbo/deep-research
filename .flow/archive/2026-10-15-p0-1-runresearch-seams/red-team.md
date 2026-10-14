# Red-Team:P0-1 分解 runResearch —— "外部接口不变、六项内部抽取、replay 夹具守行为不变"

**Verdict:go(附动工前置条件)。** 没有任何 kill criterion 已被满足——重构方向本身成立;但提案的核心验证声明("replay 夹具测试原样通过是核心证据")经代码核实**当前为假**,必须先把验证基线补齐再动工。若作者坚持"现有 `npm test` 已足够、不补金样本测试",本 verdict 升级为 kill。

---

## Top Kill-Assumptions(ranked by 影响 × 可能性 × 测试成本)

**1. "replay 夹具测试能守住行为不变" —— 该测试在 `npm test` 中不存在,callKey 无人守卫**

- **Claim:** 提案硬约束 2 称"replay 夹具测试原样通过是核心证据"(`.flow/proposal.md:27`)。
- **Fails if:** 经核实,`npm test`(vitest)中**没有任何测试**用 recording/replay 适配器跑 `runResearch`。`src/adapters/replay.test.ts` 只测 lookup 原语本身;`src/core/pipeline.test.ts:21-43` 与 `src/core/runResearch.test.ts:15-22` 的 fake 适配器签名是 `async (q) => …`、`async (stage, _input, _key) => …` —— **根本不读 callKey**。recording/replay 以 callKey 为唯一查找键(`src/adapters/recording.ts:8`、`src/adapters/replay.ts:39-44`),replay 路径只活在 CLI(`src/cli.ts:101,169`)。结论:六项抽取全部触碰 gather/stage 调用点,任何 callKey 漂移(如 `:gather:r${round}:search:`、`:draft:fix${loopsUsed}`)都会让 `npm test` 全绿、而所有录制夹具静默失效。
- **Evidence to get this week:** 已完成核实(上文行号)。补一个 recording round-trip 金样本:recordingAdapters 包 fake 跑一次全流程,把 callKey 有序序列落盘提交。
- **Kill criterion:** 若作者拒绝把 callKey 金样本测试加入"验证"节(即坚持现状测试足够),kill 本提案的当前验证方案,重构不得动工。
- **Cheapest test:** 约 50 行新测试 + 一个 JSON 金样本文件,半天内;重构前后 diff 该金样本即得行为不变的硬证据。

**2. "五段同骨架"(#4 runStageSafe)与代码事实不符,是最可能引入行为漂移的抽取**

- **Claim:** 提案称 plan/analyze/draft/polish/rephrase "五段同骨架(cancelled → persistRun → overBudget? → runStage → cost += → safeParse → saveCp)"(`proposal.md:20`)。
- **Fails if:** 逐段核对:plan 段(`runResearch.ts:455-481`)**没有 persistRun**;polish 段刻意 `persistRun("draft")` 而非 `"polish"`(`:928`,与 `:190` 注释"润色是草稿的子环节"呼应——run.stage 从不为 polish);rephrase 段(`:1003-1024`)在 review 循环内,**无** cancelled/persistRun/overBudget/saveCp 任何一件;五段的 safeParse coercion 不同(draft/polish/rephrase 过 `coerceDraftOutput`)、fallback 不同(polish/rephrase 引用 `state.draftMd!`)、checkpoint data 形状不同(plan 存 `PlanOutput`、draft/polish 存 `{reportMd}`、review 存 `{...review, loopsUsed}`,恢复路径 `:180-194` 按此分流且 polish 覆盖 draft)。要逐位复现,helper 需要 ≥5 个旋钮;任何一次 persistRun 时机/saveCp data 漂移都会改变 run 状态机可见行为或恢复语义。
- **Evidence to get this week:** 已核实。动工前把五段的(persistRun 时机, saveCp stage+data, fallback, coercion, 限制文案)列成对照表,作为评审 checklist。
- **Kill criterion:** 若 helper 参数化后仍需 >4 个配置项才能逐位复现五段现状,砍掉 #4 或降级为只抽 analyze+draft 两段真同构子集——收益为负不硬做。
- **Cheapest test:** 现有 `pipeline.test.ts` 恢复测试(`:150-185`)+ polish 行为测试能接住一半;补一个断言 `savedRuns` 序列(persistRun 次数与 stage 序列)的测试,直接锁死时机。

**3. checkpoint 落盘兼容 vs RunState 重组 —— 存量真实数据,无测试守**

- **Claim:** 硬约束 2 要求"checkpoint 数据形状"不变;待决问题 4 又提出"移动 RunState 定义"(`proposal.md:40`)。
- **Fails if:** gather checkpoint 是 `{...state}` 全量 spread(`:802`),恢复是 `Object.assign(state, cp.data)`(`:184`)——按字段名隐式耦合。checkpoints 以 JSON 落盘在 `research-data/projects/*/runs/*/checkpoints.json`(`src/stores/fsStore.ts:115-125`),是**真实存量用户数据**。若 #6 BudgetTracker 把 `capped` 挪出 RunState、或任何字段重命名,旧 run 恢复时静默丢字段:预算到顶(capped=true)的 run 恢复后按 uncapped 走完 publish,`limited` 变 `published` —— 质量门禁语义反转,且无任何报错。现有恢复测试的 checkpoint 全部同版本生成,不接这个面。
- **Evidence to get this week:** 把当前一份真实 checkpoints.json 固化为 v1 夹具,加"从 v1 checkpoint 恢复"测试。
- **Kill criterion:** 若 #6 的实现导致 `{...state}` 序列化形状与 v1 夹具 diff 非空(字段增删移),该抽取方案 kill,改为 BudgetTracker 只包判定逻辑、`capped` 留在 RunState。
- **Cheapest test:** 一个夹具文件 + 一个 resume 测试;与 #1 的金样本同批做。

**4. attachExtraction(#2)四处并非同构,"收敛为一个函数"必然做取舍,取舍即行为**

- **Claim:** "extractClaims 结果 → 入 state 出现 4 次,仅 id 前缀/scopeNote/去重细节略异"(`proposal.md:18`)。
- **Fails if:** "略异"低估了分歧:gather 路径 snapshot 是 **findIndex 替换更新**(`:398-400`,重采时刷新 title/fetchedAt),其余三处是 push-only(`:527,668,758`);reuse 路径独有 claim 级 `scopeNote`、evidence `revision: binding.evidenceRevisions[...]`、`versionId: binding.versionId`(不走 snapshotVersionMap)、以及 `if (claims.some) return` 去重(`:765-788`);gather 路径在搜索**之前**清旧主张证据(`:334-339`,0 命中时旧主张被清、问题落 unanswered)。id 前缀(`:ci` / `:ins${ci}` / `attachments` / `reuse:bindingId`)进入 bundle、报告和降级披露文案(`:1116-1120` join claim.id)。统一后若 gather 重采不再替换 snapshot,或 reuse 丢 scopeNote,bundle 内容即变——而现有测试对 snapshots 多为长度/存在性断言,未必接得住。
- **Evidence to get this week:** 为四条路径各写一个锁定 id 形状、snapshot 替换/push 语义、scopeNote/revision 的单测(这本来就是硬约束 4 要求的)。
- **Kill criterion:** 统一函数若需要 >3 个策略开关(dedup 策略 × snapshot 写入策略 × id 方案),砍为两个函数(gather 用 / 指令与复用共用),不追求单一收敛。
- **Cheapest test:** 现有 `runResearch.test.ts` 增量复用用例(`:130-169`)已锁定部分;补 snapshot 替换语义断言即可。

**5. publishGate(#1)"约 156 行纯计算"掩盖了就地突变与顺序依赖**

- **Claim:** `:1040-1196` 是"纯计算",可整体变纯函数(`proposal.md:17`)。
- **Fails if:** 该段就地把 `claim.kind`/`confidence` 改写到 `state.claims` 对象上(`:1079-1133`)、push `state.limitations`、重写 `state.unresolved`(`:1135-1137`)、交织 reportMd 组装(依赖 `incrementalNote`/`claimMark` 闭包与 `moduleConfig`)。突变**顺序**敏感:先 `mergeCrossSourceClaims` 替换数组、再降级、再置信度、再 unresolved——错位一步,limitations 顺序与报告文案变。而测试对 limitations 几乎全是 `some(l => l.includes(...))` 弱断言,顺序/重复漂移照样全绿。
- **Evidence to get this week:** 无新证据需求;但新纯函数单测(硬约束 4)必须断言**完整输出快照**(含 limitations 有序数组),而非示例性 includes。
- **Kill criterion:** 无独立 kill;#1 是六项里收益最高、风险最可控的,真正的风险是它**顺手统一** `stopAfter:"gather"` 早退路径的第二份 reportMd 组装(`:816-829`,语义不同)——若 diff 显示动了这段,该 PR 打回。
- **Cheapest test:** 对 publishGate 输出(claims/kind/confidence/limitations/reasons/reportMd 段落)做全量快照,重构前录基线。

---

## 次要失败模式(未进 Top 5,但动工前要知道)

- **#5 前提不实:** "约 10 处 `if (!includes) push`"——`:730`、`:745`、`:1027`、`:1116-1120` 是**无条件 push**(有意:多个复用资产各自披露、disclose 指令原文入列)。`addLimitation` 若全局替换会去重改文案;只能用于带守卫的站点。
- **#3 证据计数错误:** SourceSnapshot 字面量构造是 **5 处**而非 4 处——漏了 `:605`(user-text)。行号清单未经机器核对,其余计数(#2 的 4 处、`runResearch` ≈1090 行、publish gate 行区间)抽查均属实。
- **六项一次全做的调试成本:** #2/#4/#6 同时重写 gather 循环体、#5 横穿全部;金样本变红时无法归因到哪一项。缓解近乎免费:六个独立 commit/PR,按 #5→#1→#3→#6→#2→#4 顺序,各自全绿再合。
- **"收敛到 400-500 行"是虚荣指标**,无验证口径,不应写进成功标准;成功标准应是金样本 diff 为空 + 新纯函数单测就位。

## What's Well-Reasoned

- 不动外接缝(`Adapters` 四接口、`runResearch` 签名)的判断正确且被代码证实:`src/adapters/types.ts:57-62` 的接缝确实是刻意设计的深接缝,callKey 注入点设计(而非隐式 mock)使得金样本测试可行。
- #1 publishGate 方向正确:`verifyCitations`/`checkEntailment`/`checkNumericConsistency`/`checkMultiSource`/`checkCalibration` 全是现成纯函数(`:19-25` import 可见),聚合逻辑抽纯函数与 `citationVerifier.test.ts` 同构完全可行,是六项中收益/风险比最高的。
- "新逻辑补纯函数单测、被搬走逻辑靠回归"的分工(硬约束 4)是正确的测试经济学——前提是回归网真的存在(见 kill-assumption 1)。
- 明确把 P0-2/P1-3/P1-4 划出范围、拒绝顺手做,纪律性表述清晰。

## What I Couldn't Assess

- 图谱给的圈复杂度 320 / transitive_loop_depth 7 / gather 圈复杂度 58 无法独立复算(未跑 codebase-memory),不据此攻击也不据此背书。
- "预期编排器收敛到约 400-500 行"无可核对口径,视为愿景陈述。
- live 适配器侧(`src/adapters/live.ts`、searchFailover)是否有依赖 run 中间态落盘时机的轮询消费者(server.ts 轮询 progress),本次未通读;#4 若改变 persistRun 频率,UI 进度刷新粒度会变——属于行为差异的灰色地带,建议把"persistRun 次数与 stage 序列"也纳入金样本断言。

---

## Top Kill-Assumptions(一句话清单)

1. `npm test` 里没有任何 replay 夹具跑 `runResearch`,fake 适配器不读 callKey——"replay 夹具守行为不变"目前无人值守,callKey 漂移会全绿静默漏过。
2. runStageSafe 的"五段同骨架"与代码不符(plan 无 persistRun、polish 刻意 persistRun("draft")、rephrase 无任何样板),统一 helper 是六项中最可能偷改行为的。
3. gather checkpoint 是 `{...state}` 按字段名恢复且落盘为存量真实数据,RunState 字段一旦被 #6 挪走/重命名,旧 run 恢复后 `capped` 静默丢失、`limited` 反转成 `published`。
4. attachExtraction 四处调用点的 snapshot 替换/push、scopeNote/revision、去重策略是真实语义分歧而非"略异",单函数收敛的每个取舍都是行为变更。
5. publishGate 并非纯计算(就地突变 claims/limitations/unresolved + 报告组装),若顺手统一 `stopAfter:"gather"` 的第二份 reportMd 组装,行为必变。
