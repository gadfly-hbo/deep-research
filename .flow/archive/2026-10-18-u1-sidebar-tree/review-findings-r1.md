# U1 评审 R1(全新子代理,2026-10-18)——Verdict: FAIL(1 blocking)

## Blocking
- S-1 项目行菜单浮层错位:li 仅 isCurrent 挂 .sb-current{position:relative},非当前/归档行菜单相对初始包含块定位落视口外(CP-11 破损)。修复:li 常态 .sb-row 锚 + 视觉态解耦(连带 T-2 命名)。

## Non-blocking(记录不动)
S-2 当前项目任务行全亮 aria-current(应仅聚焦 run 一行)·中
S-3 右键菜单通道缺失(契约 §3 二通道)·低
S-4 CP-7 toast 用服务器原句而非契约 §4 原句(可追认)·低
S-5 Esc 后焦点未返还原行·低
S-6 CP-10 禁用落在⋯入口而非菜单项(形态偏差)·低
S-7 boost 提频在 hasActive=false 时静默失效(半死码)·低
S-8 证据精度三处:①gates CAS 未端点验证(已勘误 tasks.md)②audit run-renamed/renamed 未断言 ③followup 无名回退未测·低
S-9 awaiting 改名与 gate confirm CAS 无互斥(已知窗口,PRD 未要求锁)·INFO
S-10 项目改名刷 updatedAt→行浮顶(契约观察项,自然发生)·INFO
S-11 「新建研究运行」残留 5 处页面级(契约范围外,handoff 统一)·INFO
T-1 归档/非归档 sb-actions 近重复·低;T-3 死代码(.sb-run/RowMenu disabled/BOOST_MS)·INFO;T-4 querySelectorAll 焦点环·INFO

## 正面清单(核实落实)
G1-1 全落盘点(launchRun 预落/失败/resume回调/gate CAS/cancel/新鲜构造/恢复 spread)三测钉死;G1-5 409 文案逐字一致;G1-6 rerun/followup override 与无名回退互证;D1 摘要轻载+mtime 倒序;G1-4 trim1-60 共用 schema、清除语义;D6 守卫同源;D7 版本子树/最近运行移除且 ?v= 不动;CP-1~15 除上述偏差外逐条对码;退役串侧栏零残留;409 boost 匹配串精确;无超范围改动;VERIFY 复跑一致(441/441+typecheck+build)。
