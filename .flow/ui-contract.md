# P2-6 UI-GATE 契约(轻量)

> 产出模式:降级内联(配额不可靠)。UI 面 = GatherView 加注行内表单(唯一新交互);无新表面。

## Surfaces

| # | 表面 | 变更 |
|---|---|---|
| S1 | GatherView 运行卡干预表单区 | 增「加注」行内 fld:三个数字 input(搜索/抓取/分钟)+确认按钮;running 态可见,awaiting/终态隐藏 |

## Click paths

- C1 加注:运行中干预表单旁点「加注」展开行内三 input → 填增量(至少一键>0)→「确认加注」→ POST budget → 200:toast"已加注,配额饿死的问题将自动重开";409:toast 运行已结束;400:input 内联错误。
- 失败态:网络错误 toast;input 非正整数内联错误不提交。

## Affordances

三个数字 input(placeholder"增量")+确认按钮;禁用条件=busy 或全空/全零;键盘/焦点与干预表单同。

## Terminology

「加注」「确认加注」「已加注,配额饿死的问题将自动重开」;不自称 steer/预算调整。

## Negative cases

- 弹层/新页面(违反 P2-5 契约负例);awaiting/终态出现加注入口;上限值展示/前端校验;运行中降档入口。

## Trace links

S1↔PRD D1/R1-2/R1-8。

## Visual artifact

`.flow/ui/p2-6-budget-topup.html`(单页静态,真实 styles.css):S1 展开态/禁用态/内联错误/成功 toast。数据合成披露。

## 结论

PASS——待批准。recheck:每分区对应 S1 一行。
