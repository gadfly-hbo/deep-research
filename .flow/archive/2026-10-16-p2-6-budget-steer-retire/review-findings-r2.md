# P2-6 复审 findings(独立子代理 agent-96,2026-10-16;第 2 轮)

## Verdict:FAIL(1 项阻断 = 新控制流正确性缺陷,已有真实冒烟实证)

- VERIFY 重跑:npm test && npm run typecheck exit 0,68 test files / 420 tests 全绿,双 tsconfig 干净,墙钟 ~9s。与记录证据一致,无 verify 失配。
- 六项声称审计结论:声明 1/2/4/5/6 全部核实成立(细节见下);声明 3(F3)评估窗与锁定行为成立,但发现一处新引入的正确性缺陷与两处规格卫生缺口。

## 阻断级发现

**B1. F3/R1-4 重开收集与 gap-gather 目标重叠 → 同批问题双重调查 + 主张清除(真实冒烟已踩中)**
- 归属:implementation(正确性缺陷)。blocking。
- 证据:src/core/gatherDomain.ts:286 `reopened.push(...scanTopupReopen(ctx))` 会把所有 unanswered+quota-starved 问题收入 reopened,包括本轮 targets 里正在调查的问题;src/core/gatherDomain.ts:573 循环末 `gather(ctx, round+1, reopened)` 不过滤其当前状态,且 src/core/gatherDomain.ts:296-301 每次调查前清除该问旧主张/证据。触发面:src/core/runResearch.ts:765-770 的缺口补证 `gather(gatherCtx, 1, gapQuestions)` 直接传 unanswered 问题作 targets(对比 src/core/runResearch.ts:895-897 的 review regather 会先置 open,不会误收)。
- 真实实证:run 4e8fb9d8(p-mvanh963-8rpn27)investigation.jsonl 中 q3/q4/q5 连续两整轮被调查(seq 16-35,07:37–07:41,均「调查充分」;紧接 seq 36-51,07:41:59–07:46:04 再来一整轮),第二轮开始即清除第一轮主张,且第二轮恰逢全局抓取配额耗尽(out/smoke-p2-6b.log 07:43:34/07:45:50)→ 把第一轮已答结果重做回更差状态,成本翻倍。
- Recheck:递归前把 reopened 过滤掉本轮已调查/已非 unanswered 的问题(或 gap 路径先置 open 同 review 先例),补一条「gap targets ∩ starved 集合」回归测试断言每问只调查一次。

## 非阻断(判断项/气味,按严重度)

**N1. 采证后(analyze/draft 窗口)加注仍不重开问题,但对外文案无条件承诺「自动重开」**
- 归属:spec(承诺面)。non-blocking(handoff 已作已知降级 #5 披露;且 src/quality/publishGate.ts:163-168 使未答问题强制终态 limited,不会假 published)。
- 证据:src/server/routes/projectsRuns.ts:495 200 note 与 ui/views/GatherView.tsx:244/311 toast/标签无窗口限定;src/core/runResearch.ts:690 的重开扫描在 gather 落盘后即执行,analyze/draft 期间到达的加注只命中 src/core/runResearch.ts:823,856 的 resetCappedIfToppedUp(仅恢复 polish/review 回环,不重开)。src/core/budgetTopup.test.ts:320 反而锁定了「q2 未重开」。F3 原始 recheck 的「发布门评估前」扫描对全链路(非 stopAfter)的 evaluatePublishGate(src/core/runResearch.ts:939)并不在其前。
- Recheck:把 note/UI 文案限定为「gather 窗口内自动重开」,或在 runResearch.ts:937 前补同款 scanTopupReopen+补采。

**N2. F3 复位条件收紧(要求 wasToppedUp + 全量程余量)未按流程纪律勘误入账**
- 归属:spec/PRD(工件卫生)。non-blocking(语义方向正确:PRD D1/R1-4 字面 `capped && canSearch()` 会击穿 v1-resume locked 行为,收紧是必要裁决)。
- 证据:src/core/gatherDomain.ts:241-254 代码注释自记「REVIEW F3 收紧两处」,但 .flow/prd.md:14 原文、.flow/tasks.md、docs/AGENTIZATION-RETRO.md 偏差台账 8 条均无对应勘误/条目(对比 F5 的锁内勘误已入台账 #8)。
- Recheck:PRD D1 复位条件句勘误为「真实加注+搜索/墙钟/抓取均有余量」,或台账补第 9 条。

**N3. wasToppedUp 基线比对本身无假阴/假阳**(审计结论,非缺陷)
- src/core/runResearch.ts:120-128 基线快照先于 registerBudget(:130),加注是唯一预算变异源且只增(src/server/routes/projectsRuns.ts:477-484 原地 +=),故不存在基线被提前吃掉或非加注抬升的路径;v1 恢复/换档重启=新基线=不复位 ✓。唯一残留:fetch-room 守卫(gatherDomain.ts:251)无独立测试区分——gatherAgent「配额=1」用例无加注,budgetTopup 三用例均有 fetch 余量,删掉该守卫全绿仍绿。non-blocking 测试缺口;recheck:补「fetch 触顶 + 仅 addSearches 加注 → 仍 limited」用例。

**N4. 上轮 F7–F10 遗留仍开**(上轮已定非阻断,handoff 已列;本轮复核状态):
- F7 budgetTopup.test.ts:89-113 insufficient 负例仍未构造 capped=true,重开 filter 若误写全量仍绿——空转未修。
- F8 plan 输入 sessionDigests(runResearch.ts:460)仍无直接断言。
- F9 R1-6 字段×来源×传递方式表仍未落 PRD(commit message 有清单);R1-7「命令+输出原样」RETRO 只附命令(docs/AGENTIZATION-RETRO.md:46),数字已复核为真(runResearch 987 / gatherDomain 574 / prod LOC 10679 全部核对一致)。
- F10 PRD D1 状态码已勘误 409/400 ✓(.flow/prd.md:13),但偏差台账 #5 的「用户确认留痕」出处仍未补(docs/AGENTIZATION-RETRO.md:25,red-team 裁决 3 明文以此为条件)。

**N5. 工件细节**:handoff/RETRO 均指向 .flow/review-findings.md,实际文件为 .flow/review-findings-r1.md(指误);proposal §4/D4「主函数 <400 行」未达(987 行),质量回环/门域拆分作遗留披露(docs/AGENTIZATION-RETRO.md:54)——目标随「gather 域先行」决策延后,已披露,可接受。gap-gather 补采后 gather 检查点不再刷新(run 4e8fb9d8 唯一 gather 检查点为 07:36 的旧态),补采只活在 investigation.jsonl 侧车——旧有持久化形状,顺带提示。

Standards 轴(smell,均判断项):ui/views/GatherView.tsx:250 `msg.includes("→ 400:")` 对 errMsg 格式的字符串耦合(Primitive Obsession);src/core/runResearch.ts:823,856 同款 {state,tracker,budget,run,wasToppedUp} 字面量重复(Duplicated Code,轻)。契约 C1「点『加注』展开」的折叠态未实现(表单在 running 卡常显)、409 toast 用服务端文案而非「运行已结束」字面——均为文案/交互细差,原型只画展开态,不升格。

## 六项声称核验记录(摘要)

1. T4 纪律 ✓:c313486 仅 gatherDomain.ts+runResearch.ts 零测试触碰;37dae1b..HEAD -- '*.test.ts' 4 文件纯追加(164+/4+/116+/31+);rg 'ctx\.budget-exhausted' src 零命中,"budget-exhausted" 已还原于 gatherDomain.ts:335,399;全仓字符串漂移扫描仅此一处(其余为计数假阳性)。
2. T5 冒烟三证据 ✓(run 4e8fb9d8):(a) ins:2bc0090a detail:"问内即时注入";(b) investigation.jsonl seq 10 note「命中 10 · 方向调整:优先看中国市场头部连锁的数据口径」(工具返回值 prepend);(c) gather 检查点 quota-starved×3(q3-q5)+ budget-topup-gather 200(stage:"gather")+ budget-topup-reopen 200 后 q3/q4/q5 补采事件再现(seq 16-51)。run d8b1913e:终态 limited ✓、starved×3 ✓、加注 200 ✓、18 次搜索缺口回环 ✓、refine 全走问间隙路径(6 条 方向附注已注入剩余问题的搜索)与披露一致。注意:4e8fb9d8 的重开补采实际由 gap-gather 问开始评估点驱动(重开加注落在 stage:"analyze"),且即 B1 双重补采现场。
3. F3 评估窗 ✓ 部分:3 条新测试(budgetTopup.test.ts:166-321)逐一可区分(末问中/采证后/analyze 窗);v1-resume locked(resumeV1.test.ts:71-87,缺 wasToppedUp 守卫会丢失「预算上限到达」断言)与 fetch 触顶 limited(gatherAgent.test.ts:150-151)均不被破坏;但见 B1/N2/N3。
4. F5 锁内 ✓:projectsRuns.ts:477-484 变异在 withProjectLock 内;无嵌套持锁(startPipeline fire-and-forget、readSessionDigests/bindAssets 无锁回调),无死锁面;409/400/200 形状与 note 原文未变,budgetRoutes.test.ts 覆盖。
5. F6 UI ✓:内联错误「增量须为正整数」+invalid 高亮+「确认加注」+busy 禁用+非法拒提交(topupFieldInvalid 拦 1.5/NaN/负数;0/空键忽略);hooks 全部先于 if (!p.detail) 早退(GatherView.tsx:183-196);与 .flow/ui/p2-6-budget-topup.html 三态对齐。
6. with-minimax-env.sh ✓:仅增 zcode 缺失时回退 ~/.pi/agent/auth.json 的读取分支,密钥只进环境变量不打印、无密钥值入 diff;冒烟驱动所需,handoff:33 已披露,范围合理。

总体 recheck:src/core/gatherDomain.ts 重开递归过滤掉本轮已调查目标(gap 路径每问只采一次,补回归测试)→ B1 清零后,叠加 N1 文案/窗口对齐(或 N2 勘误入账)可复审转 PASS。
