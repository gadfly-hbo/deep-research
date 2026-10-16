# P2-5 UI-GATE 契约(轻量)

> 产出模式:降级内联(配额)。UI 面 = 追问入口改调 followup 端点 + 确认页"延续研究"徽章——零新表面,两处既有表面的小改。

## Surfaces

| # | 表面 | 变更 |
|---|---|---|
| S1 | 运行记录「追问」按钮(GatherView 等) | 交互不变(?followup 路由);表单提交路径改 POST /runs/followup(带 baseRunId) |
| S2 | 计划确认卡片(P2-3 S2) | 增"延续研究"徽章(N=项目追问次数,derivedFromRunId 计数);基准摘要行已有(门 GET incremental),无新元素 |

## Click paths

- C1 追问:追问按钮→计划页表单(预填)→提交→followup 端点→双确认门(S2 含徽章+基准摘要)→采证——用户流与现状完全一致,仅数据通道换。
- 失败态:followup 404(基准不存在)/409(active/守卫)沿用既有错误呈现(toast+轮询收敛)。

## Negative cases

- 无追问历史项目不显徽章;追问次数为 0 不显;非增量 run 不显。
- 不得出现新页面/弹窗/配置项。

## Trace links

S1↔PRD D2/R1-7;S2↔D4。

## Visual artifact

`.flow/ui/p2-5-followup-badge.html`(单页静态,真实 styles.css):S2 徽章两形态(首次追问/第 N 次)+S1 按钮现状(不变面)。数据合成披露。

## 结论

PASS——待批准。recheck:每分区对应上表两行。
