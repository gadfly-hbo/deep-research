# U1 评审 R2(修复复评,全新子代理,2026-10-18)——Verdict: PASS

> R1 见 review-findings-r1.md(FAIL:1 blocking S-1 菜单定位锚)。本轮核验 S-1 修复与纪律维持。

## S-1 修复核验——完整闭合
- 主列表项目行 li 无条件 `sb-row` 锚(Sidebar.tsx:185);归档共用 projectRow 同锚;任务行 sb-task-row(styles.css:220);
- CSS `.sb-row{position:relative}`(styles.css:248-249,含 REVIEW 注释);`.sb-current` 全仓零残留(T-2 命名解耦达成);
- 定位链闭合:.sb-menu(absolute,z-30)父即定位 li;sidebar overflow-y:auto 下底部行菜单可滚动到达;
- CP-11/CP-13 全路径可用;未引入新问题(relative 无偏移、typecheck/build 绿、单 menu state 单浮层)。

## S-8① 勘误核验——如实(tasks.md 措辞与 namingRoutes.test.ts:98-121 代码事实一致;结构保证真实存在:confirm spread + schema 含 name)

## 一轮 non-blocking 纪律——维持(逐项复核原状:S-2~S-8/T-1/T-3/T-4/S-9~11 无一被静默改动)

## 正面清单抽查——未变(G1-1 全落盘点三测/G1-5 409 逐字/G1-6 override 互证/D1 轻载倒序/G1-4 共用 schema/D6 守卫同源/D7 移除与退役串零残留)

## 本轮新 findings(均非阻断)
- R2-1 · 低:展开态项目行菜单落点在任务子树之下而非行头下(契约未限定精确落点;后续收紧改锚 .sb-item)
- R2-2 · INFO:.sb-item{position:relative} 成冗余规则(并入 T-3 死代码批清理)
- S-11 计数口径备注 · INFO:页面级残留 6 处(含 1 处文案引用)vs R1 记 5 处——粒度差,实质不变

## 复查判据
Sidebar.tsx:129/185 两类 li 锚与 styles.css:220/249 共存、.sb-current 零残留、三路径菜单均落行内;441/441+typecheck+build 保持绿。
