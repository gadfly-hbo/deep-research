# P2-6 REVIEW findings（独立子代理 agent-91，2026-10-16）

## 审查结论:P2-6(37dae1b..HEAD + 流程工件)

## Verdict:**FAIL**

- **VERIFY 重跑**:`npm test` = 68 test files / 417 tests 全绿,exit 0;`npm run typecheck` exit 0。与记录证据(68/417/exit 0)**一致**,无 verify 失配。
- **T4 结构性声称**:`git show c313486 --stat` 仅 `gatherDomain.ts` + `runResearch.ts`,`*.test.ts` 零触碰;`37dae1b..HEAD -- '*.test.ts'` 全为新增行为测试(budgetTopup/budgetRoutes 新文件、runRegistry/gatherAgent 纯追加)。**断言级纪律成立,但"行为逐位等价"不成立**(见 F1)。指标口径复核全对:runResearch 965 行、gatherDomain 550 行、prod LOC 10629。

---

## 阻断级发现(按严重度)

**F1. T4 纯移动被破坏 + 纪律证据声称不实 — `budget-exhausted` 被机械重命名污染**
- 证据:`src/core/gatherDomain.ts:313`、`src/core/gatherDomain.ts:377` 返回 `error: "ctx.budget-exhausted"`;`git show d0bcaba:src/core/runResearch.ts:555,619` 与 `37dae1b` 基线均为 `"budget-exhausted"` —— 污染引入于 `c313486`(T4)。`ctx.` 前缀重写把字符串字面量里的 `budget` 一并替换,是 T4 声称"防住一处正则误伤"之外的第二处漏网。
- 影响:工具返回值的 error code(模型可见的 wire 值)发生行为变更;T4 的"纯移动/行为逐位等价"声称(`c313486` commit message、`tasks.md:8`"零断言纪律验证过")与事实不符——正属"证据声称不实"狩猎面(全局 AGENTS.md"绝不编造完成状态")。
- 归属:**implementation**(缺陷)+ **task**(证据声称)。**blocking**(正确性变更+纪律违背)。
- Recheck:`rg 'ctx\.budget-exhausted' src` 零命中、两处还原为 `"budget-exhausted"`,并复核 `c313486` 移动再无其它字面量漂移。

**F2. T5 真实冒烟证据链不存在,RETRO 冒烟句与实据不符**
- 证据:`tasks.md:5-8` 勾选清单只有 T1–T4,无 T5 勾选证据行;`tasks.md:31` 要求真实冒烟"起 run→采证中加注→quota-starved 重开→问内改道";`docs/AGENTIZATION-RETRO.md:15,34` 却写"真实冒烟(问内改道 effect=applied;加注 409 语义正确)"。实据核查:唯一 P2-6 冒烟项目 `research-data/projects/p-mvajkzaa-4ulsib` 的 run `0d0cfa8f` 中,intervention 的 `detail` 是 `"方向附注已注入剩余问题的搜索"`(**问间隙路径**),不是 T2 的 `"问内即时注入"`;全 `research-data` 对 `问内即时注入`、`quota-starved`、`方向调整` **零命中**(采证中加注→重开链从未发生);audit 无加注痕迹,run 终态 `limited`。"加注 409 语义正确"只是负例,不等于 T5 场景。
- 归属:**verify**(证据声称)+ **task**(T5 未勾)。**blocking**(证据不实)。
- Recheck:补一份真实 run 记录同时含 `detail:"问内即时注入"` 的 intervention、`unansweredReason:"quota-starved"`→重开、采证中 POST budget 时序;或撤回该冒烟声称、补做后勾 T5。

**F3. 加注后"自动重开/capped 复位"的评估窗缺口 — 尾问中或采证后加注承诺落空**
- 证据:评估点仅在 gather 每问开始处(`src/core/gatherDomain.ts:255`);`runResearch.ts:804`/`runResearch.ts:835` 的 polish/review 以 `!state.capped` 为门。若加注在**最后一问 runAgent 进行中**或**gather 之后**(analyze/draft 窗口,run 仍 running,加注入口仍可见)到达:不再有问开始点 → `capped` 不复位、quota-starved 不重开、polish/review 回环不恢复;而 200 响应与 UI 文案仍承诺"配额饿死的问题将自动重开"(`projectsRuns.ts:488`、`GatherView.tsx:300`)。PRD D1 明文"capped 复位…下一门阶段恢复 polish/review 回环;…gather 循环末扫描重开"(`.flow/prd.md:14`)只在 R1-4 的问开始评估点上被部分满足。
- 归属:**spec**(PRD D1 交付语义)。**blocking**(spec 轴部分未命中 + 对外承诺不实)。
- Recheck:在 gather 循环结束处/发布门评估前补一次同款复位+重开扫描,并补一条"末问中加注"测试。

**F4. 程序收官交付缺口:handoff 程序终结卡缺失 + PLAN"六批全勾"只勾五**
- 证据:`.flow/proposal.md:36` 要求"docs/PLAN-AGENTIZATION.md 六批全勾+程序级总结;handoff 程序终结卡"。实际:`docs/PLAN-AGENTIZATION.md` P2-6 行无 ✅(仅 P2-1~P2-5 勾);`.flow/handoff.md` 仍是 **P2-5 交接卡**(遗留清单还把 P2-6 列为"下一批")。
- 归属:**spec**(proposal §4 收官交付)。**blocking**(交付物缺失;程序级总结本体 RETRO 已有,合格)。
- Recheck:P2-6 行补 ✅,handoff 换为程序终结卡(交付/指标/遗留与 RETRO 对齐)。

**F5. spec 源冲突:proposal「per-project 锁内更新」vs PRD/实现锁外,且未入偏差台账**
- 证据:`.flow/proposal.md:17`"per-project **锁内**更新 BudgetTracker 上限";`.flow/prd.md:13` 反向定为"per-project **锁外**(TOCTOU 落空无害)";实现即锁外(`src/server/routes/projectsRuns.ts:452-492` 无 `withProjectLock`)。审查契约:proposal 为根规格、PRD"可详化不可矛盾";该矛盾未记入 RETRO 偏差台账(`docs/AGENTIZATION-RETRO.md:19-27`)。
- 归属:**spec**(proposal↔PRD 矛盾未裁决)。**blocking**(按层级 proposal 优先;功能上 JS 单线程下变异原子、危害低)。
- Recheck:要么变异包进 `withProjectLock`,要么把"锁外+TOCTOU 无害"作为已批准偏离补进偏差台账并勘误 proposal。

**F6. UI 契约 S1 与实现/原型不一致(内联错误态整个缺失)**
- 证据:契约 `C1`"400:input 内联错误"、"input 非正整数内联错误不提交"、按钮「确认加注」(`.flow/ui-contract.md:13,18`);原型专列「内联错误(非正整数,不提交)」与「确认加注」禁用态(`.flow/ui/p2-6-budget-topup.html:45-57`)。实现:`GatherView.tsx:227-243,326-328` 全部错误走 `toast(errMsg(e))`,无内联错误;按钮文案「加注」非「确认加注」;无 busy 禁用(连点可双提交);`Number("1.5")>0` 会提交小数触发服务端 400 再 toast(违反"不提交")。"非 running 不出现入口"负例合格(`activeRun` 仅 running/awaiting,awaiting 走独立卡)。
- 归属:**spec**(ui-contract/原型为本批冻结 UI 规格)。**blocking**(spec 轴字面未命中;注意 R1-8"不前端校验"指不校验上限,与"非正整数内联错误"不冲突)。
- Recheck:实现补内联错误态+「确认加注」文案+提交中禁用,与原型三态对齐。

## 非阻断(判断项/气味)

**F7. 负例测试空转**:`src/core/budgetTopup.test.ts:86-111`"insufficient 成因不因加注重开"中预算从未耗尽(`capped` 恒 false),重开扫描(`gatherDomain.ts:255`)根本不执行——若 filter 误写成"全部 unanswered 重开",此测仍绿。归属:**implementation**;recheck:构造 capped=true 场景(一问 quota-starved+一问 insufficient 后加注)再断言。

**F8. F4 零直接断言**:Testing Decisions 要求"F4/F6 断言"(`.flow/prd.md:36`),实际仅 F6 落断言(`src/core/gatherAgent.test.ts:118`);plan 输入 `sessionDigests` 键(`runResearch.ts:449`)无任何测试捕获(其经 `modelText.ts:121` `JSON.stringify(input)` 入 prompt,生效面本身成立)。归属:**task**;recheck:补 plan 直调捕获断言或在 tasks 注明 F6-only 裁决。

**F9. R1-6/R1-7 工件形态缺口**:R1-6 要求"字段×来源×传递方式表(PRD 落表)"(`.flow/prd.md:51`)——PRD 无表(清单只在 commit message);R1-7 要求"命令+输出原样进 RETRO"——RETRO 只有数字(数字我已逐一复核正确)。另 GatherContext 实为 16 数据字段+4 状态+7 回调=27(commit 写 17),`syncProgress` 未挂 ctx(等价,因 gather 不调它)。归属:**spec** 工件形态;recheck:补表/补命令原文或记录豁免。

**F10. 偏差台账 #5"已批准"缺确认记录;PRD 内部 404/403 与 409/400 矛盾**:`.flow/proposal.md:24` 明文"升级用户确认",冻结工件内未见确认记录,台账却标"已批准"(`docs/AGENTIZATION-RETRO.md:25`);`.flow/prd.md:13`(404/403)被 R1-2(409/400,`.flow/prd.md:47`)推翻——实现取后者正确,属文档内部未勘误。归属:**spec/verify**;recheck:补确认出处或改台账措辞,D1 状态码句勘误为 409/400。

---

**总体 recheck**:`rg 'ctx\.budget-exhausted' src` 归零 + 补齐一条真实 run 证据(问内注入 detail + quota-starved 重开 + 采证中加注)+ 末问/采证后加注重开测试 + handoff 终结卡/P2-6 勾 + 锁内-锁外裁决落账 + UI 内联错误态对齐原型 —— 六项全绿后可复审转 PASS。
