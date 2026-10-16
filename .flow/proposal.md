# P2-6 非阻断收尾(讨论稿 → proposal)

> 来源:P2-6 收官四轮 REVIEW 的非阻断遗留(第 2 档),用户在「这个需要做吗?」讨论后以 `/dev-flow 非阻断收尾` 批准本批范围。第 1/3 档(纯注记、会话迁移独立程序)明确不做。

## 目标

一次小批量清完 P2-6 REVIEW 非阻断项中的低成本高价值项,补齐保护网与承诺一致性。

## 范围(六项,全部来自已归档的 review findings)

1. **N3 判别测试**:fetch 触顶 + 仅 addSearches 加注 → 仍 limited。当前 `resetCappedIfToppedUp` 的 fetch-room 守卫(`gatherDomain.ts`)删掉后全测试仍绿——守卫无保护网。
2. **N1 承诺文案对齐**:「配额饿死的问题将自动重开」为无条件承诺,实际重开只在 gather 窗口;采证后(analyze/draft 窗口)到达的加注只恢复 polish/review 回环。改 GatherView 两处字符串(表单 label+成功 toast)与 budget 端点 200 `note` 为窗口限定表述。**措辞进 UI-GATE 用户批准**(术语变更:P2-6 契约钉过原句)。
3. **F7 负例补强**:「insufficient 成因不因加注重开」用例当前 capped 恒 false,重开 filter 若误写成"全部 unanswered 重开"仍绿——构造 capped=true 场景(一问 quota-starved+一问 insufficient 后加注)。
4. **F8 直接断言**:plan 阶段输入 `sessionDigests` 键(`runResearch.ts` plan 直调)无直接测试捕获——补 plan 直调捕获断言。
5. **r3-3 锁内检查**:budget 端点 running 状态检查移入 `withProjectLock` 临界区(检查与变异同锁,消"检查通过后 run 收束仍返 200"残窗;注释同步勘误)。
6. **r4-2 存量去重**:analyze gapQuestions 与 review regather 目标对模型输出中的重复 questionId 无去重(基线存量,非回归)——复用 B1R 的 id-dedupe 模式。

## 决策与理由(钉死,后续阶段不再议)

- **N1 选文案限定,不选"发布门评估前补重开扫描"**:draft 之后重开补采产生的新主张进不了已写草稿(报告陈旧),且 publishGate 对未答问题强制 limited;文案对齐是诚实面且零行为风险。
- **不做**(明确出范围):管线模型调用迁会话(独立程序,SDK steer 字面前提);质量回环域/门域拆分(按需);pass B 引用注记(纯记录,无工作量);F9/F10 工件形态与台账出处措辞(已归档周期工件,不再回改)。
- 每项独立可验证,单一批次交付;不改架构、不加依赖。

## 开放问题

- N1 的具体文案措辞(UI-GATE 批准点)。
