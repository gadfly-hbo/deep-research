# Agent 化程序终结卡(六批收官,2026-10-15 ~ 16)

> 本卡替代各批交接卡,是程序的最终交接面;细节以 `docs/AGENTIZATION-RETRO.md`(六批对表+偏差台账+指标)与 `.flow/prd.md`(P2-6 决议)为准。

## 程序交付(六批全勾,见 docs/PLAN-AGENTIZATION.md)

- **P2-1 接缝合规**:vendor pi-agent-runtime-0.4.3(哈希锁定);`src/adapters/piRuntime.ts` 全仓唯一 Pi 接入点;runText 三分映射;`@earendil-works` 零直接 import(全程维持)。
- **P2-2 预算放开**:RunUsage `costEstimate`→`modelCalls/outputTokens`;uncapped 显式化;UI 模型计量。
- **P2-3 确认门翻转**:run 内 durable 双门(plan/outline `awaiting-confirmation`)+gate GET/confirm/cancel 三端点 CAS;单 active-run 守卫;预览端点退役。
- **P2-4 采证 agent 化**:gather 逐问 plain-Runtime.runAgent + 三工具(web_search/fetch_page/read_snapshot),executor error-as-value;调查流时间线 UI。
- **P2-3b 会话底座**:FileBudgetStore(租约接管协议)、锁共享件(O_EXCL+判死)、SessionRuntime 装配。
- **P2-5 追问会话化**:会话=研究记忆(零模型直写摘要);`POST /runs/followup`;任务卡【既往研究纪要】段。
- **P2-6 动态预算+问内改道+退役**:运行中加注(registerBudget 同对象变异/budget 端点/加注评估点复位+quota-starved 重开);问内 refine 即时注入(filtered take+三步消费);P2-5 遗留四项;gather 域拆分(runResearch 1378→987 行)。

## 验证状态

- **测试**:422 全绿 / 68 文件 + typecheck 双 tsconfig 干净(VERIFY 命令 `npm test && npm run typecheck`)。
- **REVIEW**:P2-6 收官轮独立子代理判 FAIL(6 阻断:F1 字面量污染/F2 冒烟证据不实/F3 加注评估窗/F4 收官交付/F5 锁内-锁外冲突/F6 UI 内联错误态)→ 全修复 → 复审;历史两轮 FAIL→PASS(P2-5)。
- **真实冒烟**:两跑集齐 T5 三证据链(问内即时注入 detail+「方向调整:」工具返回值 note;采证中 stage=gather 加注 200;quota-starved 落盘→加注重开补采)——run `4e8fb9d8`(全链)与 run `d8b1913e`(同链复证);驱动时序日志 `out/smoke-p2-6*.log`。

## 遗留(下程序输入,按优先级)

1. **管线模型调用迁入会话**(架构重写)——steer SDK 字面落地的前提;独立程序,本程序钉为 Out of Scope。
2. **质量回环域/门域拆分**(同 R1-6 纪律,按需启动)。
3. **P2-6 REVIEW 非阻断项**(F7-F10,记录于 `.flow/review-findings.md`):F7 负例测试空转(insufficient 用例未构造 capped=true 场景)/F8 plan 的 sessionDigests 键无直接断言/F9 R1-6 字段表与 R1-7 命令原文工件形态缺口/F10 偏差台账 #5 确认出处措辞+PRD 状态码勘误(PRD D1 已修 409/400,台账出处待补)。
4. **运行态披露持续**:会话跨机不续(会话 JSONL gitignore);预算账本本机;加注不延续到恢复/重启(设计钉)。
5. **已知降级**:崩溃 resume 时 refine 二次入队(方向附注重复注入无害);采证后(analyze/draft 窗口)加注只恢复 polish/review 回环,问题重开只在 gather 窗口(循环末/发布门评估前)。

## 下一批前置

- 工作区随本卡交付干净;`docs/PLAN-AGENTIZATION.md` 六批全勾。
- research-data 含两批冒烟项目(p-mvanh963 三证据链、p-mvan3qry 复证、p-mvajkzaa P2-5 期)——可归档。
- 服务启动:`scripts/with-minimax-env.sh npm run research -- serve --port 4173`(2026-10-16 已修 xiaomi 密钥源:zcode 配置缺失时回退 `~/.pi/agent/auth.json`)。
