# P2-3 交接卡(确认门翻转)

## 本批交付

- **两道 run 内 durable 确认门**替代浏览器向导两张皮(用户裁决:产品级 durable gate,SDK checkpoint 经红队 dist 实证不可用):POST /runs 免 plan 起跑→plan 阶段产出→`awaiting-confirmation` 落盘返回→UI 确认卡片(可编辑问题)→confirm 重启管线→outline 阶段(新入流水线,增量上下文进输入)→第二道门→确认框架→gather。
- **服务端单 active-run 守卫**(running|awaiting → 409,消纯客户端互斥)、gate 三端点 CAS+per-run/per-project 锁、find-last 修复(确认页编辑被原版静默覆盖的定时炸弹,红队 KA1)。
- **预览端点与向导退役**:plan-preview/outline-preview 删除(server.test 重写门流)、planWizard 退役、PlanView 翻转确认流、"待确认"状态全 UI 五处呈现。
- 推送 `2e5a36e..b32a1ab`(9 commits:拆批裁决+T0-T4 六实现+F2/F4 修复+工件+数据)。

## 验证状态

- 362 测试全绿(+12:钉子/门流 e2e/端点/并发/守卫/锁)+tc0+build;REVIEW 全新子代理 PASS(有条件→已闭环):find-last 先红经**旧代码树重放实证**。
- 真实 LLM 冒烟三段:门流全通(真实 8 问→编辑 8→2 确认→outline 门→gather);守卫 409 真实生效;**重启 durable 可分辨证据**(pid 63707 kill -9→pid 63944 confirm 200→running)。
- 流程披露:v1 红队 kill(会话底座合批,KA:runText 走会话=全历史+单 busy 并发撞死)→拆批;实现偏离 6 项均有据(tasks.md)。

## 遗留(下批输入)

1. **P2-3b 会话底座**(红队 v1 报告 .flow/red-team-v1-killed-p23.md KA3-5):持久账本租约接管协议、绑定独立小文件、CLI/serve 同机 writer 冲突 UX、会话 JSONL gitignore;"走会话"仅 P2-4/5 需要的调用点。
2. **P2-4 采证 agent 化**(下一批,采红队建议 2a 已完成→现可直接做):gather 改 runAgent+工具、steer 替代 instruct、全自主(用户决策①)、UI 调查流视图(决策③)。
3. non-blocking 记录:gate GET 无锁瞬读(ms 自愈)、awaitingNextGate 跨导航 banner 误标(自愈)、守卫闭包 15 行重复。
4. 冒烟数据:research-data 有两个冒烟项目(可归档)。

## 下一批前置

- 工作区干净;ui-dist 已含确认流(build-head 自动重建亦覆盖)。
- awaiting-confirmation 状态的既有 run:无(冒烟 run 均 cancelled/failed 收尾)。
