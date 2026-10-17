# 非阻断收尾 任务切片

来源:`.flow/prd.md`(红队必改+GRILL R1 八决议并入;UI 契约已批准)。

- [x] 1. T1 — N3 判别测试(时点 9/9、批末 12/12 绿;mutation 删 gatherDomain fetch-room 守卫→N3 单红 ✓;error 字面 fetch-quota-exhausted 钉全局分支)
- [x] 2. T2 — F7 原地改写(三问 capped=true;mutation filter 改全量 unanswered→F7 单红 ✓——调查次数断言判别成立)
- [x] 3. T3 — F8 plan 直调断言(正:含键+slice 0-3;负:不含键;mutation 删 runResearch 注入行→F8 单红 ✓)
- [x] 4. T4 — 文案四处落盘(label/toast/note 逐字=契约 T1/T2/T3;stages.ts 注释同步;grep 全仓无条件「自动重开」承诺零残留)
- [x] 5. T5 — 检查+变异同临界区(outcome 判别返回保两条 409 语义;注释含 KA1 红线全文;budgetRoutes 测试绿)
- [x] 6. T6 — 两点去重+两回归 12/12 绿;mutation:gap 去重拿掉→gap-dup 单红 ✓/seen-set 拿掉→review-dup 单红 ✓;B1/B1R locked 保持绿

依赖:六项互相独立(零依赖);按序执行。切片自批准:auto 模式,粒度=每项一 PRD 条目、各带独立验证面,memo:证据红绿+mutation 记录在勾选行(R1-8)。

## 1. T1 N3 判别测试

R1-2 构造:maxFetches=1;q1 fetch 一次+SUFFICIENT;q2 启动 pollInstructions 加注仅 addSearches;q2 首 fetch 命中全局分支(fetch-quota-exhausted)。断言 limited+error 字面+budget 回显。放置:budgetTopup.test.ts。

## 2. T2 F7 原地改写

R1-3:改写「insufficient 成因不因加注重开」用例为三问构造;调查次数断言必须(scriptedRunAgent 重放语义)。

## 3. T3 F8 plan 直调断言

R1-4:budgetTopup.test.ts 新 describe;正(含键)+负(不含键)双 run。

## 4. T4 D2 文案三处

契约 `.flow/ui-contract.md` T1/T2/T3 逐字;stages.ts:12 注释同步(D2 实现面)。

## 5. T5 r3-3 锁内检查

R1-7 形态;注释红线:「检查与变异同临界区(一致性);runOnProject 全程不持锁,终态写与账本注销在锁外——搬移只缩小窗口不归零;残窗由 budgetOf 注销后 409 兜底,变异对象无害」。

## 6. T6 r4-2 两点去重

R1-5/R1-6:gap=map/filter 后内联 Set;review=issue 循环内 seen-set(保留 10+loopsUsed);回归两条。
