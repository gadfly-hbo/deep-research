# 非阻断收尾交接卡(P2-6b,2026-10-16)

> 前序:程序终结卡见 `.flow/archive/2026-10-16-p2-6-budget-steer-retire/handoff.md`(六批全景/指标/遗留)。

## 本批交付

- N3/F7/F8 判别测试补网(4 新用例+1 改写;五组 mutation 自检全部单红:删 fetch-room 守卫/重开 filter 改全量/删 plan 注入行/两处目标去重拿掉)。
- N1 加注承诺文案窗口限定:三处用户可见字符串+stages 注释,按「发布门评估前」单一时间边界(UI 契约 T1/T2/T3 逐字,用户批准);旧无条件承诺零残留。
- r3-3:budget 端点 run 反查+running 检查+变异同 withProjectLock 临界区(一致性;窗口缩小不归零,budgetOf 注销 409 兜底;409/400 组合翻转按 PRD R1-7 接受)。
- r4-2:analyze gaps 与 review regather 目标按 id 去重(模型输出重复 questionId 不再双轮调查)。

## 验证状态

- 426 全绿 / 68 文件 + typecheck 干净(VERIFY=SHIP 两拍重跑一致);REVIEW(agent-104)PASS,3 非阻断(下条)。

## 遗留与部署注意

1. **构建产物旧文案**:本机 ui-dist/ 与 dist/ 仍含旧承诺串(gitignored、不在仓库)——下次启动由 BUILD_HEAD 机制自动重建;若手动部署,先 `npm run build`。
2. 独立程序级(程序终结卡遗留不变):管线模型调用迁会话(steer SDK 字面前提);质量回环域/门域拆分(按需)。
3. 记录接受项:r3-4 轮次硬编码、N5 gap checkpoint 不刷新、r4-3 placeholder 漂移(语义一致)、归档原型的 --line-strong 未定义 token(不回改)。

## 下一批前置

- 工作区干净,main=origin/main(3a44d66)。
- 无进行中依赖;`.flow/archive/2026-10-16-p2-6-budget-steer-retire/` 为上批周期工件。
