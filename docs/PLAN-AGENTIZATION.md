# deep-research Agent 化改造规划(2026-10-15 定稿)

> 规格依据:`~/Dev/Projects/pi-agent-runtime/docs/AGENT-RUNTIME.md`(接入标准 v0.3)+ 本文件。
> 用户已拍板的四项决策(原文):①采证**全自主**(放开过多限制);②**先 P2-1/P2-2**;③采证 agent 化后 UI **演化为"调查流"视图**;④**成本估算去掉,不用估算**。
> 执行节奏:每批一次 dev-flow,本文件是跨批规格源;批次提案钉在各批 `.flow/proposal.md`。

## 目标形态

一个研究项目 = 一个持久会话(SessionRuntime);六阶段从编排器硬编码传送带变为会话中带业务确认门的 purpose 切换;采证从固定轮次抓取变为模型自主调工具的调查;追问从"增量新 run"变为同会话 followUp。

## 不可丢的产品原则(继承)

人审不可绕过;计划/框架确认门;证据可核查(快照绑定、逐字引句);有限交付披露(fail-closed);发布不可变版本。

## 分批路线与决策落点

| 批次 | 内容 | 决策落点 |
|---|---|---|
| **P2-1 接缝合规** | vendor `pi-agent-runtime-0.4.3.tgz`;全项目唯一 Pi Adapter;7 阶段 + extractClaims 改 runWorker(zod validator 复用);主备链交 runtime fallbacks;最小必要 authorize/audit/budget 输入(行为等价) | 无(合规批,形态不变) |
| **P2-2 预算与审计** | budget tier → Limits 正式映射;AuditSink 富化(模型/工具调用元数据入项目审计);**costEstimate 整体移除**(④:契约字段、UI 状态栏用量显示、reasons 汇总中的成本口径一并清理,token/次数计量保留) | ④ |
| **P2-3 会话底座** | SessionRuntime;项目=会话;checkpoint 确认门(BUSINESS_WAIT)替代"向导在浏览器、run 在后台"两张皮;崩溃恢复+恢复前核账 | |
| **P2-4 采证 agent 化** | gather 改 runAgent + web_search/fetch_page/parse_doc 工具(external 效果走预授权策略);steer 替代 instruct 队列;快照证据链保持;**无逐问题抓取护栏——全自主,治理只靠任务级预算与用户停止**(①);UI 同批演化为**调查流视图**(③,过 UI-GATE) | ①③ |
| **P2-5 追问会话化** | followUp 替代增量新 run;上下文压缩连续;UI 追问入口改接 | |
| **P2-6 动态预算 + 退役** | 运行中加注/改道;旧编排器退役(runResearch 缩为装配层);全链真实验证 | |

## 版本与合规基线

- 消费方式:`file:vendor/pi-agent-runtime-0.4.3.tgz` 入仓(照抄 decision-platform/reports-factory 模式),自有 lockfile 固定安装树。
- runtime 0.4.3 = 最新有文档已验证发布(RELEASE-v0.4.3.md);0.5.0.tgz 无 release 说明不用;SDK 0.86.1 精确系列由 runtime 锁定。
- 接点 1:改造完成后 `src/` 与 `scripts/` 零直接 `@earendil-works` import(唯一例外:piRuntime Adapter 文件只 import `pi-agent-runtime`)。

## 开放问题(到批再裁决)

- P2-1:AuditSink 落 workspace 级 `model-audit.jsonl` 还是项目 audit.jsonl(makeAdapters 无项目上下文,需接缝设计)。
- P2-2:costEstimate 移除是硬删字段还是保留恒 0(倾向硬删+一次性数据迁移说明)。
- P2-4:全自主采证的停止标准(模型自判"够用"→ 提交分析;用户 steer/abort;预算墙钟)与调查流视图的 UI 契约。
