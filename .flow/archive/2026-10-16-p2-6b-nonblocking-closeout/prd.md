# P2-6 非阻断收尾 PRD

> 规格源:`.flow/proposal.md`(用户批准的第 2 档清单)+ 红队 Go 附必改(KA1 勘误)+两护栏(KA2/KA3/KA4)。无 issue tracker。

## Problem Statement

P2-6 收官四轮 REVIEW 留下一批非阻断遗留:两处测试保护网缺失(守卫删掉测试照样绿)、一处对外承诺与行为不一致(加注重开文案)、一处零断言生效面、一处锁内一致性残窗、一处模型输出重复 id 的双调查面。单看都不阻塞,但都是已知薄点——不清则下次改动悄悄回归。

## Solution

单批清完六项:两条判别测试(红绿+mutation 自检)、一条 plan 直调断言、三处字符串文案窗口限定(UI-GATE 批准措辞)、budget 端点状态检查入锁(一致性,非"消残窗")、gap/review-regather 目标按 id 去重。

## User Stories

1. 作为研究者,我在采证中加注后看到的承诺文案与实际重开时机一致,所以不会误以为采证结束后加注还能重开问题。
2. 作为维护者,我删掉 fetch-room 守卫或改错重开 filter 时测试立刻红,所以防护语义有保护网。
3. 作为维护者,我在 plan 阶段输入里加/删 sessionDigests 键时有直接断言报警,所以 followup 首跑的纪要注入生效面不被无声破坏。
4. 作为维护者,模型输出重复 questionId 时每问只调查一次,所以不浪费双倍模型成本也不误清主张。
5. 作为维护者,budget 端点"查得 run 运行中→变异"在同一临界区,所以检查与变异不再跨锁交错。

## Implementation Decisions

- **D1(N3 判别测试)**:构造 fetch 全局触顶(`fetchRoom` 走全局上限分支,非本问上限)+ 仅 addSearches 加注 → 断言 run 终态仍 limited(不复位)。放 budgetTopup.test.ts。**mutation 自检:临时删 fetch-room 守卫必须红**。
- **D2(N1 文案)**:三处字符串窗口限定——GatherView 表单 label、成功 toast、budget 端点 200 note。措辞覆盖**全部三个重开评估点**(问开始/循环末/发布门评估前——最后一点在 gather 收束后、analyze 前),不得写成"仅采证阶段内";与两条 locked 测试(budgetTopup「采证后加注…发布门评估前重开补采」「analyze 窗 q2 不重开」)逐点核对。内部注释(stages.ts 同句)顺带同步。**措辞经 UI-GATE 用户批准**。
- **D3(F7 补强)**:构造序 q1 用尽最后一次搜索但收束 insufficient → q2 被标 starved → q3 启动时加注;断言 capped=true 场景下 q1(insufficient)不被重开。**mutation 自检:重开 filter 改全量 unanswered 必须红**。
- **D4(F8 断言)**:构造无 options.plan + sessionDigests 非空的首跑分支(plan LLM 直调),捕获 plan 输入断言含 sessionDigests 键(prior art:polishPass 的 runStage 捕获)。
- **D5(r3-3 锁内)**:budget 端点 running 状态检查移入 withProjectLock 临界区,与变异原子相邻;注释同步。**红队 KA1 勘误(钉死):runOnProject 全程不持锁,终态落盘/账本注销在该锁之外——移锁只缩小窗口不归零;残窗由 budgetOf 注销后返回 409 兜底,变异对象无害。禁止在代码/注释/文档中出现"消残窗"效应声称。**
- **D6(r4-2 去重)**:analyze gapQuestions 与 review regather 两调用点对模型输出的重复 questionId 各自按 id 去重(在调用点去重,不改 gather targets 语义面);各补"重复 id→每问只调查一次"回归;B1/B1R locked 回归保持绿。**mutation 自检:去重拿掉必须红**。
- **KA5 取弃面对账**:r1-r4 全部非阻断项对照——进本批:N1/N3/F7/F8/r3-3/r4-2;明确不做:会话迁移(独立程序)、域拆分(按需)、r3-1(已修)/r3-2(已修)/r3-4 轮次硬编码(存量,记录)、N5 gap checkpoint 不刷新(旧有持久化形状)、r4-3 placeholder 漂移(语义一致,接受)、F9/F10(已归档周期工件不回改)、pass B 注记(纯记录)。

## Testing Decisions

- 只测外部行为(run 终态/问题状态/输入捕获),不测实现细节;seam 复用 budgetTopup.test.ts 的 runResearch+fakes+planOf 模式与 polishPass 的 runStage 捕获,**零新 seam**。
- 每条新用例红绿验证+mutation 自检(删守卫/改 filter/拿掉去重→转红)——本批"补保护网"主张的唯一自证方式。
- 既有 422 测试+typecheck 全程保持绿。

## Out of Scope

管线模型调用迁会话(独立程序);质量回环域/门域拆分(按需);r3-4 轮次硬编码、N5、r4-3(记录接受);行为改动(发布门前补重开扫描——proposal 钉死不做)。

## Further Notes

红队 KA5 提示:若 UI-GATE 措辞两轮不批,item 2(D2)拆出单走,其余五项先行(任务切片按此解耦)。

---

## GRILL 第 1 轮决议(author-blind 子代理 agent-102,8 包全部采纳)

1. **R1-1 N1 措辞=边界标记版(A)**:统一以「发布门评估前」为单一时间边界;label 枚举三评估点(采证中每问开始/采证轮末/发布门评估前),toast/note 用「将在发布门评估前的评估点自动重开,其后加注只恢复润色/评审回环」句式;stages.ts:12 注释同步。措辞经 UI-GATE 用户批准;与两条 locked 测试逐点核对过。
2. **R1-2 N3 构造=两问命中全局分支**:maxFetches=1;q1 fetch 一次(shouldCapOnTake 置 capped)+SUFFICIENT;q2 启动时 pollInstructions 加注仅 addSearches;q2 首 fetch 命中全局分支(fetch-quota-exhausted)。断言 limited+error 字面(区别于 question-quota-exhausted)+maxSearches 回显。单问构造不可行(fetchQuota 地板 1,本问检查先于全局)——子代理推导验证。
3. **R1-3 F7 原地改写+调查次数断言(必须)**:scriptedRunAgent 每调用重放脚本(testing.ts:75-85),纯状态断言在 mutation 下仍绿;三问构造(q1 insufficient→q2 starved→q3 启动加注),断言 q1 状态+q1 调查次数===1+searches===3+published。
4. **R1-4 F8 落 budgetTopup.test.ts+负向断言**:不传 plan+sessionDigests 注入,runStage 捕获断言 plan 输入含键(slice(0,3));同测试补无纪要 run 断言不含键。plan 回退 scope 种子链路已核可达。
5. **R1-5 gap 去重=调用点内联 Set(约 3 行)**:map/filter 链后按 q.id;回归仿 B1(analyze gaps 重复 q2 两次→调查次数===1),无需加注。
6. **R1-6 review regather=issue 循环内 seen-set**:保留每 issue 即时修结构与 10+loopsUsed 轮次;回归=review 首轮两个同 targetQuestionId 的 high regather issue→q2 调查次数===1(severity/kind/detail 必填已核 schema)。
7. **R1-7 r3-3=listRuns+running 检查整体入锁**:置于 budgetOf 前,zod 400 留锁外;接受「非 running+非法 body」组合从 409 翻 400(既有测试无该组合钉序,UX 两路径不受影响),注释记一笔;注释红线按 KA1(禁「消残窗」字样)。
8. **R1-8 mutation 留痕=tasks.md 勾选行**:每测试项记录 mutation 命令与观察到的红,不新增脚本/日志文件。

## GRILL 第 2 轮(主代理)

R1 后逐项复查(放置/构造/去重形态/锁搬移/留痕)已全部钉死,唯一余项=N1 措辞批准属 UI-GATE 例行停点,非开放问题 → **收敛(2 轮)**。UI 面=加注表单三处字符串变更(用户可见)→ UI-GATE(轻量:契约+原型,复用 p2-6-budget-topup 形态)。
