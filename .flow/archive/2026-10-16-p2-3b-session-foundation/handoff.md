# P2-3b 交接卡(会话底座)

## 本批交付

- **FileBudgetStore**(持久预算账本):路径级进程单例永不重建、租约接管协议(owner={runId,pid,bootId},判死清 owner 保 usage 含未结算预留)、CONFIGURATION_CHANGED 两级文案+两条出路、10 万 FIFO、O_EXCL 跨进程收口(单点在 store 打开处,自动罩住 serve/CLI/脚本三方)。
- **锁共享件**(lockfile.ts):O_EXCL+pid 判死接管+同进程 holder 登记(修复 release 异常自锁死);ps lstart 判活细则(含糊判活方向)。
- **SessionRuntime 装配**(sessionRuntime.ts,唯一 import 处):工厂 `createProjectSessionRuntime({projectDir,candidates?,auditPath?})`;acquireWriter=锁;bindings.json 唯一核账源(幂等+冲突 reject);reconcile 四态;**零生产流量走会话**(P2-5 接入)。
- piRuntime:内存 store→FileBudgetStore(dirname(auditPath) 推导);REBUILD 只重建 runtime 对象。
- gitignore 三处:session/、model-budget.json、.model-budget-lock(dataSync 收编不了)。
- 推送 `b25300a..d8d33b4`(6 commits)。

## 运行态披露(两条,持续有效)

1. **会话跨机不续**:session/ 目录已 gitignore——A 机起的会话 B 机无文件;崩溃恢复=**原机 serve 重启恢复**(陈锁接管+reconcile 核账)。
2. **预算账本本机文件**:model-budget.json gitignore;双机各自记账,usage 历史不跨机。

## 验证状态

- 404 测试全绿(+25:锁 5/账本 13/接线 1/会话 5/同步 1);REVIEW 全新子代理 PASS 0 blocking(SDK budget.js 算术逐行等价比对;测试零污染逐调用点核实)。
- 4 non-blocking:F1 CONFIG detail 无生产读取面(SDK 只透 reason——P2-5 宿主边界透出);F2 sess: 前缀仅约定(P2-5 全带);F3 本卡即闭;F4 测试格式挤行。

## 遗留(P2-5 输入)

1. **P2-5 追问会话化**(下一批):followUp 产品语义(**红队校准:idle 会话拒绝 followUp,追问=同会话新 prompt operation 或活跃期 steer**——P2-5 PRD 须按此设计);steer;压缩;调查流跨机;真实 Provider 会话链路(本批合成覆盖装配面);宿主透出 fault.detail;sess: 前缀机制化。
2. 任务迁移实现(旧 taskId 封存→新 taskId,CONFIG_CHANGED 出路的第三条——P2-6)。
3. 账本写放大实测(每次调用 3 次全文件重写,长跑 MB 级——量级记录)。
