# Red-Team:P2-5 追问会话化

**Verdict:Go 附 4 强制修订(R1-R4)。** "追问不进会话内跑管线,会话只承载记忆"是对"全历史+单 busy"约束的正确退让;但摘要投递载体选错是最贵设计错误,幸而最便宜修。

## Top Kill-Assumptions

### KA1 摘要投递:run(prompt)=每条 1 次模型调用+O(N²) 输入+新故障面;update() 是零模型直写
- dist 证实:run 必经模型(pi-adapter.js:412 lane.prompt→transport);每次 claim/reserve/audit/settle(index.js:236-320);第 N 条摘要输入≈前 N−1 条之和;任一次 MODEL_FAILED 摘要不落 transcript。
- **update(sessionId,{kind:'message'})** 是零模型直写(pi-adapter.js:583-603):无 taskId/limits/operationId、不走账本/审计、branch 无 in-flight 即可写、authorize('update') 已放行、立即进 history()(:621-627)。
- **修法(R1)**:摘要投递一律 update();保留**一次**真实 session run()(首条 prompt,验证 claim/bind/reconcile/drive 全链)。

### KA2 双记忆源无权威裁决:incrementalOf(bundle) vs 会话 tail 同字段各说一遍
- 摘要是 run 产物有损投影;任务卡已有【已答问题】fold(runResearch.ts:431),再叠会话纪要段模型无裁决规则。
- **修法(R2)**:字段级重叠表+权威源规则——证据/快照/已答问题=bundle(权威);会话 tail=叙事补充(追问原话/口径注记);冲突裁决("与基准统计不一致时以基准为准")写进任务卡模板。增量 6 问上限复查。

### KA3 compaction 启用=死配置+任务配置身份陷阱
- 自动压缩只在 harness run 期间评估(compaction.js:147 contextTokens>contextWindow−reserve);摘要走 update() 则会话内无 harness run,**压缩永不触发**;harness 设置进任务配置身份(index.js:17-18/213-218)——P2-6 改参数→存量 sess: taskId 全体 CONFIGURATION_CHANGED 永久 block。
- "压缩后 tail 不可读"**不成立**(history 返回全 entries,压缩只改后续 run 上下文起点不删条目)。
- **修法(R3)**:删 compaction 启用(死配置);harness 配置钉跨批不变或明写"改参数=新会话"。

### KA4 真实 Provider 验收句与设计矛盾
- KA1 按 update() 后 run()/control()/compact 零生产流量,"三段真实验证"不成立。
- **修法(R4)**:验证清单改——保留一次真实 session run()(首条 prompt 走 run,一次性成本换全链真实验证);其余 update/followup 走端到端;遗留显式登记。

### KA5 followup 端点=守卫第三份复制品
- 守卫已复制两份(projectsRuns.ts:260-269/312-320);followup 是第三份,TOCTOU 漂移面。
- **修法**:守卫单一收口(共享函数或内部委托)+resolveIncrementalBase 同款校验。

## 开放问题裁决
1. 摘要生成:模板拼接+**update() 投递**(KA1);update 无 operationId 不进 bindings(无模型调用,合理);history() 只在 followup 发起时读一次,勿进问间隙轮询。
2. K=3、每条摘要模板硬顶 ~800B,任务卡新增【既往研究纪要】段置于【已答问题】后;plan 阶段输入复用同段。
3. incrementalOf **必填保留不替代**(R2 权威分层)。
4. steer 延后:**支持但升级理由并登记**——物理不可实现(无模型调用走会话则 steer 的 live 目标不存在);连续第二次延后,须在规划文档登记偏离挪 P2-6+写明 P2-6 前提=管线模型调用迁入会话。fault.detail 透出:宿主 throw 路径自带(piRuntime blocked 分支只透 reason)。
5. 旧项目:首次 followup 时 create+update 写首条基准摘要,**不回填历史**(回填=制造双源);会话缺失降级零纪要段不阻塞。摘要写挂钩放 **runOnProject 接缝**(CLI 与 serve 共用;只挂 routes 层则 CLI run 不进记忆)。

## 无法评估
生产候选链解析方案(serve 侧 config+env→candidates 注入);首条 prompt run() 的模型回复质量;UI 徽章 N 来源(会话条数 vs listRuns 计数——惰性建后 N 从 0 起跳的展示语义)。
