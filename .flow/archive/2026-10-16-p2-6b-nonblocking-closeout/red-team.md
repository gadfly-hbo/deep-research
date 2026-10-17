# Red-Team: P2-6 非阻断收尾(agent-101,2026-10-16)

结论:六项事实前提逐条对码核实,五项成立、一项(item 5)的效应声称不成立。批次该做,但 item 5 表述必须先改。

## Top Kill-Assumptions (ranked)

**KA1(第 5 项/r3-3)「移锁内即可消除残窗」**
- Steelman:检查(projectsRuns.ts:456-460)在锁外、变异(:477-484)在锁内,移进同一临界区让"查得→变异"原子相邻,方向没错。
- Fails if:run 收束不持这把锁——终态落盘在 runResearch 内、unregisterBudget 在 startPipeline.finally(projectsRuns.ts:117-120),runOnProject=saveRequest+runResearch(src/app/projectService.ts:74-83)全程无 withProjectLock(若有,加注端点会与整条流水线死锁——冒烟已证明不会);且临界区内 listRuns() 是 await 磁盘读,照样让出事件循环。真正兜底是 budgetOf→null→409,危害本就是"变异对象无害"。**移锁只缩小窗口,不归零;"消残窗"是虚假效应声称。**
- Impact×Likelihood:中×高——本程序 REVIEW 轴有"证据声称不实"直接 FAIL 前科(r1 F1/F2);这句话写进了「决策与理由(钉死)」段。
- Kill criterion:批次坚持"消残窗"字面不改 → 该项 kill 或降级为纯注释披露。
- Cheapest test:改一句话:「检查与变异同临界区(一致性/注释勘误);终态写与注销不持锁,窗口由 budgetOf 注销兜底、不归零」。

**KA2(第 2 项/N1)「窗口限定表述=诚实面且零行为风险」**
- Steelman:选文案而非补重开扫描论证扎实(新主张进不了已写草稿、publishGate 对未答问题强制 limited、budgetTopup.test.ts:320 已 locked"analyze 窗 q2 不重开")。裁决认可。
- Fails if:真实重开面不是一个"gather 窗口"能装下:评估点三处——gatherDomain.ts:286(问开始)/:571(循环末)/runResearch.ts:689-695(gather 落盘后、analyze 前的发布门评估窗,locked 测试 budgetTopup.test.ts:224-273 钉死)。若措辞写成"仅采证阶段内加注可重开",是用新 underpromise 替换旧 overpromise。另 grep 自动重开 有第四处:src/core/stages.ts:12 注释("两处字符串+note"的枚举会被按 grep 对账)。
- Kill criterion:新措辞与任一评估点/locked 测试矛盾,或 UI gate 两轮用尽。
- Cheapest test:措辞草案跑 grep -rn 自动重开 src ui 并对照 runResearch.ts:686-695。

**KA3(第 1/3 项)「补了用例,守卫/filter 就有保护网」**
- 前提逐文件核实为真:N3 守卫(gatherDomain.ts:251)确无保护网(budgetTopup 全用例 maxFetches:60/:67/:204/:254/:305/:362/:411,budgetRoutes 用 80,fetch 触顶用例 gatherAgent.test.ts:124-153 无加注故 wasToppedUp 在 :249 先短路,resumeV1 无加注);F7 用例(:89-113)确空转。
- Fails if:新用例构造错位——item 1 必须触到全局抓取配额(gatherDomain.ts:405)而非先被本问上限挡住(:401);item 3 必须让 capped 真为 true(可行构造序:q1 用掉最后一次搜索但收束 insufficient→q2 问开始标 starved→q3 启动时加注,断言 q1 不被重开)。
- Kill criterion:mutation 自检不红——临时删 gatherDomain.ts:251/把 :261-263 filter 改全量 unanswered,新用例必须转红。
- Cheapest test:每条新用例提交前跑一次 mutation(实施方必须做)。

**KA4(第 6 项/r4-2)「复用 B1R id-dedupe 模式」**
- 缺口属实:runResearch.ts:765-767 的 map+find 对重复 gap id 产出同对象两次;:891-897 两个 high issue 同 targetQuestionId 两次置 open+regather;B1R 去重在重开路径内部(gatherDomain.ts:577-584),盖不到传入 targets。
- Fails if:修错层——在 gather 入口统一去重会改变 targets 语义面,可能碰红 B1/B1R locked 回归(budgetTopup.test.ts:323-433);或只修 gap 点漏 review 点。
- Kill criterion:两调用点各自补"重复 id→每问只调查一次"回归,B1/B1R locked 保持绿。

**KA5(批次级)「单一批次交付」**
- Fails if:item 2 的 UI-GATE 用户批准卡住,五项代码陪等措辞;或复审要求取弃面与四轮 findings 逐项对账——r3-1(冒烟 409 归类)/r3-2(handoff 计数)/r3-4(轮次硬编码)/N5(gap checkpoint 不刷新)/r4-3(placeholder 漂移)未进六项也未进「不做」点名。
- Kill criterion:用户两轮不批措辞 → item 2 拆出单走,其余五项先行。
- Cheapest test:r1-r4 全部非阻断项列 checklist 对照 proposal 六项+「不做」段,补一行枚举。

## What's Well-Reasoned

- N1 选文案不选补扫描:论证链完整(草稿陈旧+publishGate 强制 limited+locked 测试背书),与 handoff 已知降级 #5 披露一致;六项里唯一行为面决策,选对。
- 六项事实前提五项对码属实(N3 守卫裸奔/F7 空转/F8 零断言——全 src 测试仅 gatherAgent.test.ts:95 出现 sessionDigests 且那是 F6 任务卡断言/r4-2 两点无去重/r3-3 检查确在锁外)。行号与归档 findings 逐条对得上。
- 批次纪律成立:不改架构、不加依赖、每项独立可验证。
- 第 4 项实现前提(plan 直调断言须构造"无 options.plan+sessionDigests 非空"首跑分支,runResearch.ts:442-460;budgetTopup 现有用例全走 planOf 路径,模板不能直接抄)。

## What I Couldn't Assess

- UI-GATE 最终措辞(开放问题);「用户批准第 2 档」讨论原文(按 proposal 声称采信);mutation 验证未实际执行(只读);ui-dist 重建对文案变更的影响面未查。

## 裁决:GO(附一条必改+两条护栏)

- 必改(KA1,改前不算 go):第 5 项「消…残窗」降级为「检查与变异同临界区(一致性+注释勘误);残窗由 budgetOf 注销兜底、不归零」——runOnProject 不持锁是代码事实。
- 护栏 1(KA2):措辞定稿须通过三个评估点+两条 locked 测试逐点核对;"gather 窗口内"四个字装不下 runResearch.ts:689-695。
- 护栏 2(KA3/KA4):四条新用例(N3、F7、F8、r4-2×2)提交前各自 mutation 自检(删守卫/改 filter/去重拿掉→必须转红)。
