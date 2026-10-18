# E1 评审(全新子代理,2026-10-18)——Verdict: PASS(0 blocking)

> VERIFY 亲跑 exit 0(454/454+typecheck+build),与勾选证据一致;G1-1~G1-6/D1-D10 逐条落实;核心纯加法(两文件 5 hunk),既有测试零改动,测试测外部行为。

## Non-blocking(记录不动)
- F1 自愈清扫缺失:提案"崩溃后 running→failed 进程内自愈"未实现且未记录降 scope——崩溃后 status 永 running/result 永 null。下批首选:init 扫描 jobRoot 把 running 改 failed。
- F2 runJob 前置段在 try 外(persist/open/parse 抛错→卡 running+unhandled rejection 可崩进程);或 validate 补 tier 枚举白名单。下批顺手收敛。
- F3 幂等窗口未文档化(in-memory,重启后同键新开 job)——jsdoc 补一句"窗口=进程生命周期"。
- F4 D2 路径校验大小写/symlink 边界(macOS 大小写不敏感 FS 可绕段比较;cap- 命名仍兜底)。
- F5 verified 聚合口径:quote-mismatch/snapshot-missing 统一折 mismatch;quote/source 取首条证据 vs verified 聚合全部证据,展示与判定可能错位。

## Standards(轻微)
- T-1 三测试文件 fakes/waitTerminal 近重复(第 4 份出现时抽 src/capability/testing.ts)。
- T-2 FindingClaim.verified: string 可用字面量联合。

## 备注
提案 §2 的 status(+usage)/asOf 未实现——usage 随 result 返回(D7),asOf 未被 PRD 承接(PRD 收敛所致,非静默丢弃)。
