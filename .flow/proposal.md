# Proposal: JuanerAI 接入就绪装配级最小调整(批次 J1)

> 规格源:2026-10-16/17《deep-research 接入 JuanerAI 只读差距评估报告》v0.2/v0.3(会话内交付)+ 用户 2026-10-17 授权("授权。调用/dev-flow开发流程来完成")。基线 main @ `e3341c1`(= origin/main)。

## 来源与授权范围

评估结论:现有能力可直接用于后续 JuanerAI Adapter 接线,无"必须立即实施"的插件侧改动;报告列出两项条件性插件侧最小调整与一项拟验证。用户已授权实施该最小调整,经 dev-flow 完成。

**授权含**:下述 A1/A2/A3。
**授权不含**(明确出界):live Provider 真实验证(另行授权);SDK 升级/0.5.0 立项(另行);JuanerAI 侧 Adapter/装配(归宿主仓);README 同步口径修正等可后置项;任何宿主仓文件改动。

## 已确认决策

1. **A1 SDK authorize 装配透传**:`PiRuntimeOptions`(`src/adapters/piRuntime.ts`)与 `ProjectSessionRuntimeOptions`(`src/server/sessionRuntime.ts`)增加可选 `authorize` 注入,透传至 pi-agent-runtime `createRuntime`/`createSessionRuntime`。缺省保持现状(允许全部,任务级预授权语义不变——评估报告已确认其符合标准 P3,独立形态无阻塞)。
2. **A2 显式 dataDir 装配参数**:同一装配选项增加可选 `dataDir`,显式定位 `model-audit.jsonl` 与预算账本目录(现仅能经 auditPath 间接控制);缺省保持 `defaultDataDir()`(env `DEEP_RESEARCH_DATA_DIR`/cwd)行为不变。
3. **A3 合成宿主消费者验证**:新增测试证明第三方消费者可**进程内装配**调用真实业务实现(`piRuntimeModel` 注入候选链/authorize/dataDir + `runResearch` 闭环),含负例(authorize 拒绝路径、dataDir 落位);loopback HTTP 消费形态复用既有 `src/server/server.test.ts` 集成覆盖(记录复用理由,不重复建)。

## 约束

- **只做加法**:现有入口(CLI `run/project/spike`、`serve`、UI、launcher)行为零变化;缺省路径与现状等价。
- A1/A2 是**通用装配选项,不是 JuanerAI 专属接缝**——README:73"本轮不建专属接缝"决策维持;本仓不建宿主 Adapter、不做输入/成果映射。
- 不动 vendored SDK 0.4.3(`vendor/pi-agent-runtime-0.4.3.tgz` 哈希锁定)、不升级、不改业务核心/质量门禁/存储格式/情报库。
- 不调用真实 Provider、不读凭据;验证仅合成 transport/replay 夹具。
- 既有 426 测试 + typecheck 全程保持绿。

## 拒绝的替代方案

- 重写为库单进程调用或统一 HTTP-only(评估结论:两种消费形态已存在,无需改写)。
- 在本仓建设 JuanerAI 专属 Adapter/任务映射(归宿主仓薄 Adapter)。
- 升级 pi-agent-runtime 0.5.0(上游无版本说明;受控升级另立项)。
- 顺带修 README:15/21 同步口径漂移、`--datadir` 与 config.json/审计位置既有不一致等可后置项(本批仅记录,不动)。

## 开放问题(交 PRD/GRILL 细化)

- `authorize` 的精确签名与类型对齐(以 node_modules 内 pi-agent-runtime 0.4.3 实际导出为准)。
- A2 是否同批覆盖 `sessionRuntime` 的 auditPath 缺省(倾向:覆盖,同一装配语义)。
- A3 负例选择范围(authorize 拒绝在 runText/runAgent 两通道的映射行为断言;audit/账本落位断言)。
- 测试缝选择(候选:`piRuntimeModel` 显式 candidates 注入 + 临时目录,复用 P2-1 冒烟先例)。

## 验收口径

- 全部既有测试 + 新增测试绿,typecheck 干净。
- 新装配选项缺省时与现状行为等价(既有测试不改动即绿为证)。
- 新增测试以合成方式证明:宿主式消费者可注入授权策略(拒绝生效)、显式数据目录(审计/账本落位),并完成一次进程内研究闭环。
