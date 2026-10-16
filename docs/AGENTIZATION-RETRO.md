# Agent 化程序收官总结(2026-10-15 ~ 16)

> 起点:2026-10-14 用户产品层规划"agent 自主规划,放开过多限制"+四决策(①全自主②先 P2-1/P2-2③调查流视图④成本退役)。终点:六批全部交付。

## 六批逐批对表

| 批次 | 交付 | 验证 | 关键决策 |
|---|---|---|---|
| **P2-1 接缝合规** | vendor pi-agent-runtime-0.4.3(哈希锁定);piRuntime.ts 全仓唯一 Pi 接入点;runText 三分映射;@earendil-works 零直接 import | 343 全绿+真实双链冒烟(M3 18s/ECONNREFUSED 切 mimo 15.5s) | v1 红队 kill(runWorker 硬 JSON.parse/同 taskId 撞死/有限 Limits 无超时)→v2 修正;成本恒 0(用户确认) |
| **P2-2 预算放开** | RunUsage costEstimate→modelCalls/outputTokens(zod default);uncapped 显式化(P4 声明);UI 6 处改模型计量;审计轮转 | 349 全绿+REVIEW 两轮(复审抓"缩进声称未修") | 用户裁决"干脆放开预算"(方案 A);find-last 防编辑覆盖 |
| **P2-3 确认门翻转** | run 内 durable 双门(计划/框架)替代向导两张皮;服务端 active-run 守卫;gate 三端点 CAS | 362 全绿+真实门流(真实 8 问→编辑 8→2→outline 门→gather)+守卫 409 真实生效+重启 durable(pid 可分辨) | 用户裁决"产品级 durable gate"(SDK checkpoint 经 dist 实证不可用:runText 无暂停/会话 runAgent 也拒 checkpoint/无工具无 BUSINESS_WAIT);KA2 事实勘误(单 active-run 非服务端不变量→守卫) |
| **P2-4 采证 agent 化** | gather 逐问 plain-Runtime.runAgent 全自主调查(三工具 web_search/fetch_page/read_snapshot);error-as-value 不杀问;assertPublicUrl SSRF 防线;调查流时间线 UI | 377 全绿+真实双供应商冒烟(发现并修复"摘要判充分"产品缺陷:任务卡补证据规则;33 事件/质量回环生效) | steer 偏离获批(硬依赖 P2-3b 会话底座);C1-C5 准入(executor error-as-value/串行+问内并发/assertPublicUrl/证据归属 qid→sid/并发零互撞) |
| **P2-3b 会话底座** | FileBudgetStore 持久账本(租约接管协议:owner={runId,pid,bootId},判死清 owner 保 usage);锁共享件(O_EXCL+同进程 holder);SessionRuntime 装配(自研 acquireWriter/bindings/reconcile);零生产流量走会话 | 404 全绿+SDK 算术逐行等价比对+真实 research-data 零污染 | 红队 3 强制修订:acquireWriter 方向搞反(须自研)/store 路径级单例永不重建/CONFIG_CHANGED 出路+命名空间隔离;KA5 校准(idle 会话拒 followUp→P2-5 设计前提) |
| **P2-5 追问会话化** | 会话=研究记忆(update 零模型直写摘要+首次真实 session run 全链验证);followup 端点(基准 mtime 取最新);任务卡【既往研究纪要】段;UI 延续研究徽章 | 411 全绿+两轮 REVIEW(FAIL→PASS)+真实冒烟(惰性建会话/transcript 初始化纪要/双门/采证) | 红队 R1-R4:摘要投递 update 而非 run(prompt)(消 O(N²)+故障面)/compaction 死配置删除/字段权威分层(bundle 权威+tail 叙事)/验证句改一次真实 run() |
| **P2-6 动态预算+问内改道+退役** | 运行中加注(同对象变异+capped 复位+quota-starved 重开);问内 refine 即时注入(filtered take+三步消费);P2-5 遗留四项;编排器拆分(gatherDomain 574 行,runResearch 1378→987,零断言纪律) | 420 全绿(含 F3 评估窗 3 测试,红绿验证)+REVIEW 三轮(r1 FAIL 6 阻断→全修复;r2 FAIL B1 双轮调查→修复;r3 FAIL B1R 重复入列→去重)+真实冒烟两跑集齐三证据(run 4e8fb9d8:问内即时注入 detail+「方向调整:」工具返回值 note+采证中 stage=gather 加注 200+quota-starved 落盘+加注重开补采 q3-q5;run d8b1913e:同链复证,终态 limited) | KA1 裁决 a(capped 复位+重开,与用户"放开"哲学一致);steer 语义化(instruct 问内即时注入,非 SDK steer 字面);REVIEW F1-F6 见下"REVIEW 修复记录" |

## 偏差台账(已批准偏离,按发生批序)

| # | 批次 | 偏离 | 依据 |
|---|---|---|---|
| 1 | P2-2 | costEstimate 恒 0(用户决策④执行) | 用户"成本估算去掉" |
| 2 | P2-3 | SDK checkpoint → 产品级 durable gate | dist 实证(runText 无暂停/会话 runAgent 拒 checkpoint/无工具无 BUSINESS_WAIT) |
| 3 | P2-4 | steer 字面延后(需会话底座) | P2-3 v1 KA2 先例(底座+形态合批=风险叠加) |
| 4 | P2-5 | steer 再延后(物理不可实现) | 无模型调用走会话则 control.steer live 目标不存在 |
| 5 | P2-6 | steer 语义化落地(instruct 问内即时注入替代 SDK steer) | 三轮校准+最小落地满足用户可感知意图 |
| 6 | P2-3b | 会话 JSONL gitignore(跨机不续会话) | KA5(体积与 rebase 冲突) |
| 7 | P2-3b | compaction 不启用(死配置) | update 路径无 harness run,压缩永不触发 |
| 8 | P2-6 | per-project 锁外→锁内勘误(PRD 原写"锁外"与 proposal"锁内"矛盾,REVIEW F5 抓出;实现改为 withProjectLock 临界区内变异,对齐 proposal) | 规格层级 proposal>PRD;锁内无死锁(临界区仅内存变异) |
| 9 | P2-6 | R1-4 复位条件收紧勘误(`capped && canSearch()` → 真实加注 wasToppedUp+全量程余量;重开递归只补采 open) | 存量 3 测试红灯实证(v1 恢复/fetch 触顶被误复位);REVIEW F3/N2+B1 裁决 |

## REVIEW 修复记录(P2-6 收官轮,独立子代理 FAIL→修复→复审)

REVIEW 判 FAIL,6 阻断+4 非阻断;阻断全修:

- **F1 字面量污染**:T4 机械重命名把 `"budget-exhausted"` 改成 `"ctx.budget-exhausted"`(模型可见 wire 值变更)——还原两处;全仓字面量漂移扫描确认 T4 仅此一处;T4"零断言纪律"成立但"行为逐位等价"表述更正为"断言级零改动,行为曾被 F1 污染后修复"。
- **F2 冒烟证据不实**(撤回重做):原 RETRO 冒烟句声称"问内改道 effect=applied"实为问间隙路径,且"采证中加注→quota-starved 重开"链从未发生。已补真实两跑(run 4e8fb9d8 集齐三证据;run d8b1913e 同链复证)。
- **F3 加注评估窗缺口**:评估点仅在问开始处,末问中/采证后加注承诺落空——补 gather 循环末+发布门评估前同款复位重开扫描(`scanTopupReopen`),polish/review 门补 `resetCappedIfToppedUp`;3 条新测试红绿验证(含测试脚本 match 误配导致的假绿修正)。
- **F4 收官交付缺口**:PLAN 六批全勾+handoff 程序终结卡补齐。
- **F5 规格冲突**:见偏差台账 #8。
- **F6 UI 契约未命中**:内联错误态(非正整数不提交)+「确认加注」文案+提交中禁用,与原型三态对齐。

非阻断(F7 负例测试空转/F8 F4 断言面/F9 工件形态/F10 台账确认出处与 PRD 状态码勘误)记录于 `.flow/review-findings.md`,按判断项处理不阻断。

## 指标基线(收官 commit 采集)

- **测试**:422 全绿 / 68 文件(P2-1 基线 343 → +79;P2-6 终版含 F3 评估窗 3 测试+B1/B1R 回归,均红绿验证)
- **代码**:`runResearch.ts` 1378→**987 行**(拆出 gatherDomain.ts 586 行;GatherContext 28 绑定=27+F3 wasToppedUp);prod LOC 10691(排除测试,`git ls-files|grep -v test|xargs wc -l`)
- **接点合规**:`rg "@earendil-works" src/ scripts/ ui/` **零命中**(P2-1 目标,全程维持)
- **冒烟覆盖**:真实 LLM 门流/守卫/重启 durable/采证 agent 化/摘要判充分修复/追问会话/问内即时注入(工具返回值 note「方向调整:」)/采证中 stage=gather 加注 200/quota-starved 落盘→加注重开补采/加注 409 负例(budgetRoutes 单测覆盖,非冒烟——REVIEW r3 归类勘误)

## 遗留(下程序输入)

1. **管线模型调用迁入会话**(架构重写,steer SDK 字面落地的前提——独立程序)
2. P2-5 F4 plan 纪要段生效面仅 followup 首跑;F6 纪要段 e2e 间接覆盖;F10 契约勘误已落;F11 已修
3. 质量回环域/门域拆分(留待按需)
4. 任务迁移实现(CONFIG_CHANGED 出路第三条——旧 taskId 封存→新 taskId 起账)
5. 跨机会话/compaction(远期)
