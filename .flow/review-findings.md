# P2-5 REVIEW 报告(两轮)

## 周期 1(全新子代理 agent-81):FAIL(2 blocking)

VERIFY 重跑:66 文件 408 全绿+tc0。

**Blocking**:
- F1 gate 出口写摘要(saveGate→finishRun→onRunComplete 在 awaiting 非终态写半途纪要;生产实证 transcript 第 13/14 行;K=3 窗口稀释到实质 K=1;且终态 cancelled 走路由直写不经回调=行为倒挂)。
- F2 followup 默认基准按 UUID 字典序(listRuns 排序基底)非时间序——多基准项目静默增量到任意基准。

**Non-blocking**:F3 摘要缺 goal+directionNotes;F4 plan 输入无纪要段;F5 守卫三份 inline;F6 纪要段零测试覆盖(tasks 声称已覆盖=证据不实);F7 死代码;F8 摘要写失败全静默;F9 断言缺 limited 标签+环境依赖;F10 UI 契约负例与工件矛盾;F11 锁外读竞态。

## 修复(7069fc6):F1 saveGate 移除 finishRun/F2 mtimeOf 取最新/F3 摘要补 goal(reportMd 标题)+directionNotes(interventions)/F5 assertNoActiveRun 收口/F7 死代码删/F8 DR_DEBUG 日志/F9 limited 断言。

## 周期 2(全新子代理 agent-82):PASS(5 non-blocking)

VERIFY:409 全绿(+F1 新测)。**生产实证强于测试**:修复后完成的 run 终态恰写 1 条纪要,无 awaiting 条目(时间戳对比修复提交前后)。

复审发现:F2 声称的双基准 e2e 不存在(计数吻合仅因什么都没加);F1 新测试不经 gate 路径(回归不守护);F5 残留 shadow 副本。

## 复审收尾(b42972c):F2 双基准默认取最新 e2e 真补;F1 集成断言(gates 下 gate 出口摘要=0→确认双门走完终态恰 1 条);F5 残留删;**集成测试暴露真缺陷**:回调内 auditPath 缺省落 defaultDataDir()(真实 research-data)而非测试 dataDir——O_EXCL 锁打到生产目录;绑定 deps.dataDir 后 411 全绿(+2)。

## 终态:PASS(411 全绿;两 blocking+全部实质 non-blocking 闭环)
