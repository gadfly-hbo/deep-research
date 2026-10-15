# P1-3 交接卡(server.ts 路由域拆分 + RunRegistry)

## 本批交付

- 971 行 server.ts → 147 行壳层 + routes/{projectsRuns,versions,library,settings,http}.ts + runRegistry.ts;HTTP 行为逐位不变(附录 A 37 项冻结于 .flow/prd.md,REVIEW 逐项核验 PASS)。
- 安全网:characterization.test.ts 12 条(钉 launch/resume 失败形状、formal 形状、静态文件、catch-all、畸形 JSON、非法 id 先于子路由、cancel/resume/rerun/instruct 守卫、resume 不注入复用资产)+ runRegistry.test.ts 8 条。
- 全仓 343 测试绿、typecheck 绿。提交 b174014..cf846d0 已推 origin/main(含 P0-2 归档提交 52a23a9 一并推送)。

## 遗留与后续建议(非缺陷,均为有意保留的现状)

1. **resume 不传 runId**(D4/R1-Q5):恢复路径跳过复用资产注入与 usage 记录——产品层若认为恢复应继续注入,需新提案改行为(现被 T12 钉住)。
2. **`ResearchRun.checkpoints` 全链路从未写值**(恒 `[]`)——T2 表征钉的是 `[]→[]`;将来若管线开始填检查点,表征测试需同步更新。
3. **zod `.parse` 失败→500**(D5 机械保留):plan/outline-preview、launch、rerun、PATCH asset 的输入校验失败回 500 而非 400——规范化属行为变更,须另立批次。
4. **T2 acquire 位置微移的故障角落**:bindAssets/落盘抛错时不再泄漏已注册 controller(原行为 cancel 会 200);该角落无测试覆盖,属未钉面。
5. **下一批重构候选**(P2 建议,源 proposal P1 未尽项):core/runResearch.ts 编排器仍 ~600+ 行;quality/ 目录职责可再分;docs/ 设计文档与拆分后结构同步。

## 下一批前置条件

- 工作区干净;`.flow/state.json` 本机态(gitignored)。
- 表征测试 12 条是后续任何 server 行为变更的基线——改行为先改表征测试(并说明为何)。
- ui-dist/ 下的 `__char-fixture.js/.svg` 为 T4 测试夹具(gitignored,勿手工清理后报测试红)。

## 流程备注

- T3/T4/T5 与 REVIEW 因子代理 5 小时配额(403)由主代理执行/内联评审,已在 history 与 DONE 披露;恢复子代理配额后无需补做。
