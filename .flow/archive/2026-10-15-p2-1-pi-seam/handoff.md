# P2-1 交接卡(Pi 接缝合规)

## 本批交付

- **vendor**:`pi-agent-runtime-0.4.3.tgz` 入仓(SHA-256 锁定);pi 两包 0.86.1 转传递依赖;engines node≥24.21.0。
- **piRuntime.ts** 成为全项目唯一 Pi 接入点:`rg @earendil-works` 全仓零命中(接点 1 达成)。runText 三分映射(succeeded→解析/INVALID_OUTPUT→降级桶/其余→抛)、真值表+自定义+拒绝三分 ModelConfig、uncapped 五键 limits(单次超时经 modelRecovery 切备用)、子 taskId `dr:${callKey}` 账本、审计→research-data/model-audit.jsonl(已 gitignore)、1MiB 字节护栏、DR_DEBUG 双行制、runFreeText 通用口。
- **退役**:ModelCircuitBreaker(用户决策)、pi-ai 内建查找、runAgentLoop 直调;isTransientProviderError 迁 searchFailover(搜索链沿用)。
- 推送 `19dba8a..9f97393`(5 commits + 归档 aa56bd9 已随上批)。

## 验证状态

- `npm test` 57 文件 349 全绿(342+7 合成 transport)+ typecheck 0;SHIP 前 fail-closed 重跑过。
- 真实双链冒烟:MiniMax-M3 正常链 18.0s/8 问;ECONNREFUSED 切换链 15.5s 切 mimo/10 问;审计落盘实证。
- **降级披露**:REVIEW 为内联(子代理 403);红队 v2 与 GRILL R1 均为新上下文子代理,非降级。

## 行为差异(已披露 5+1 条,PRD D4)

costEstimate 恒 0(P2-2 硬删);单次抖动换模型(2 次尝试制);熔断退役(挂起 300s 兜底);错误文案类别化;draft/polish 截断→降级披露(原为残文入报告);候选链/密钥变更需重启进程。

## 遗留(下批 P2-2 输入)

1. **P2-2 预算与审计正式化**:budget tier→Limits 映射、持久账本(memory store Map 线性累积)、costEstimate 硬删(UI 5 处显示点)、审计保留/轮转口径。
2. channelCache 多实例清理( configs 变体场景,无害)。
3. model-audit.jsonl 跨机口径(当前本机)。

## 下一批前置

- 工作区干净;双机 node≥24.21.0(engines 警告级)。
- research-data/model-audit.jsonl 为本机文件(gitignore),不随 dataSync。
