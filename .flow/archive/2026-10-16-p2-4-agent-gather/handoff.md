# P2-4 交接卡(采证 agent 化)

## 本批交付

- **gather 逐问 runAgent 全自主调查**(决策①):每问一次 plain-Runtime agent(web_search/fetch_page/read_snapshot 三工具,4-7 轮 7-13 次工具调用自主调查),agent 自判 sufficient 收束;无逐问抓取护栏(单问软顶按问均分保住补证轮预算)。
- **executor 治理三件套**:error-as-value(配额尽/墙钟/私网/超时全不杀问,模型自然收束有限交付);assertPublicUrl 双查(SSRF 防线);逐问串行+问内工具并发(instruct 语义零漂移)。
- **证据链保持**:每次 fetch 落 SourceSnapshot、extract 无状态后置、共享快照按 qid→sid 对抓取过它的每个问展开;真实冒烟发现并修复**「agent 只凭搜索摘要判充分」产品缺陷**(任务卡补证据规则:sufficient 前提=已抓取阅读 ≥2 独立来源)。
- **调查流视图**(决策③):investigation.jsonl 事件侧车+增量端点+UI 时间线(问题分组头/三型事件卡/agent 判定摘要/实时追加)。
- 推送 `b32a1ab..b25300a`(9 commits)。

## 验证状态

- 379 测试全绿(+19);REVIEW 全新子代理 PASS,S1/S3 上调 blocking 修复(read 盲区/seq 竞态互斥链)。
- 真实双供应商双轮冒烟:首轮缺陷现场保留+修复+金样本重录;二轮 33 事件/质量回环生效(q1 不充分→补证已答)/617s 完整交付;真实 UI 完成态回看转录。

## 遗留(下批输入)

1. **P2-5 追问会话化**(下一批):followUp 替代增量新 run、上下文压缩连续、steer 落地(需 P2-3b 会话底座四项前置设计——见 .flow/archive/2026-10-15-p2-3-confirm-gates/red-team-v1-killed-p23.md KA3-5)。
2. S6:add-source 指令路径 URL 无 assertPublicUrl(范围外遗留,低风险)。
3. S4:KA5 单问 fetch ≤50% 判据小样本未证(需 ≥4 问冒烟)。
4. maxParallel 字段保留无消费者(文档已披露);read_snapshot 与快照面板 sid 联动留 P2-5。

## 下一批前置

- 工作区干净;ui-dist 已含调查流。
- 真实研究数据含 4 个冒烟项目(可归档);模型审计/情报库增量已随批提交。
