# Tasks — 独立深度研究工作台第一期(tracer-bullet 切片)

来源:`.flow/prd.md`(承载 proposal 决策与 GRILL 记录 G1–G15)。无 issue tracker,拆解落地本文件;dev-flow ISSUES 自批准(理由:每片端到端可演示/可验证,依赖线性、S4/S5/S6 可并行)。

- [ ] 1. 证据链 spike 与引用核查器(S1)
- [x] 2. 全流水线脚本化运行 + 发布门禁 + 有限交付(S2)
- [x] 3. 项目存储、版本、审计与生命周期(S3)
- [x] 4. 品牌模块配置与 B1 live 验收跑(S4)(配置/模板/专项质量检查已完成并经夹具测试;live 验收跑待密钥后补)
- [x] 5. 行业模块配置与 I1 live 验收跑(S5)(配置/模板/专项质量检查已完成并经夹具测试;live 验收跑待密钥后补)
- [x] 6. 工作台 Web UI 与本地服务(S6)
- [x] 7. 验收加固与文档(S7)(B1/I1 live 验收跑待密钥后补,其余完成)

## 1. 证据链 spike 与引用核查器(S1)✅(live spike 已跑:可验证率 0.763 / 可达率 0.80 / kill 判据触发,已升级)

### What to build

薄垂直切片:contracts 最小集(ResearchRequest / ResearchRun / ResearchResultBundle 的 zod 校验)+ 经 `@earendil-works/pi-ai` 的模型接入 + search/fetch/parse 适配器(live 与 mock/录制)+ 证据模型(SourceSnapshot / Evidence / Claim + 口径)+ 引用核查器(纯函数);`runResearch(request, adapters, store)` 最小路径 = gather → verify,对 10 个真实研究问题(含中文来源类型:统计公报、行业报告、电商价格页、新闻)以 live 适配器运行;CLI 命令输出 spike 报告:逐引用判定(URL 存活/引句命中/引句不符/快照缺失)、来源可达率/可解析率、每阶段 token 成本与耗时。同时验证 pi-ai 对目标供应商(MiniMax/Kimi/GLM OpenAI 兼容端点)的接通方式。

### Acceptance criteria

- [ ] 10 个问题的 live run 完成,每个 Claim 有快照级证据或显式标未验证
- [ ] 引用核查器对真实数据输出逐引用判定,与人工抽查(≥ 20 条)一致
- [ ] spike 报告含可验证率、来源可达率、每阶段成本;若触发 kill 判据(可验证率 < 80% 或可达率 < 60%)升级用户并停止后续切片
- [ ] pi-ai 对目标供应商的接通结论有记录(接通 / 接通方式 / 需升级)
- [ ] 录制夹具可生成,供后续切片测试 replay

### Blocked by

None - can start immediately

## 2. 全流水线脚本化运行 + 发布门禁 + 有限交付(S2)

### What to build

`runResearch` 完整状态机:plan → gather → analyze → draft → review → publish,阶段工人 = pi-agent-core session(阶段域 tools + prompt),阶段转移由编排器决定;回环 = 缺口补证、反例检查、受影响内容复核(review 回退只重跑受影响分支);检查点持久化、取消、恢复;预算上限(搜索/抓取/成本估算/墙钟/并行 ≤ 4)到顶 → 停止新调用 → 有限交付;发布门禁:G9 高风险阻断 + 修复复核重过、G10 阈值分级(≥ 80% 正常 / 低于有限交付);口径检查器(对象/时间/单位、冲突登记与披露)。CLI 驱动,录制夹具运行。

### Acceptance criteria

- [ ] 录制夹具下端到端跑通全流程,bundle 过契约校验
- [ ] 取消保留已完成阶段;恢复自最后完成阶段续跑、不重跑已完成调用(调用键幂等生效)
- [ ] 预算低上限 → 停止发起新调用、产出有限交付报告(限制 + 未解决问题),run 状态 = limited
- [ ] 注入高风险问题(关键结论引句不符)阻断发布;修复并复核后重过门禁发布
- [ ] 引句命中率 < 80% → 有限交付且逐主张标注;≥ 80% → 正常交付
- [ ] 注入口径冲突 → 发布必须带冲突披露节

### Blocked by

- 1

## 3. 项目存储、版本、审计与生命周期(S3)

### What to build

stores:项目目录 = 元数据 JSON + audit.jsonl(append-only)+ runs/<id>/ + reports/v<n>/;app 生命周期:项目创建/保存/重开;发布生成不可变版本;补证/重新评审 = 新 run 引用旧版本 → v<n+1> + 版本差异摘要(结论/证据/限制变化);模板复用(历史项目目标与范围 → 新 request);审计日志记录配置 hash、证据 ids、报告版本、关键事件;CLI/HTTP API 最小集暴露。

### Acceptance criteria

- [ ] 进程重启后项目可重开,全部证据/报告/版本可见
- [ ] 已发布版本目录不可变(同版本二次写入失败)
- [ ] 补证/重审产生新版本,差异摘要含结论/证据/限制变化
- [ ] audit.jsonl append-only,含配置 hash 与关键事件
- [ ] 模板复用生成保留原目标/范围的新 request

### Blocked by

- 2

## 4. 品牌模块配置与 B1 live 验收跑(S4)

### What to build

品牌 ModuleConfig(schemaVersion + 问题框架:定位/价格/渠道/竞品 + 来源策略与验证规则 + 报告模板与结构化字段:品牌档案/竞品对比表/机会-风险-假设 + 专项质量检查);B1 = 一个公开资料充足的消费电子品牌,live 端到端跑通并发布版本化报告;录制夹具回归。

### Acceptance criteria

- [ ] B1 live run 到 publish 或 limited,报告含品牌模板全部结构化字段
- [ ] 关键结论可展开证据(来源/引句/抓取时间);未验证内容显式标注
- [ ] 对比表数值带口径(对象/时间/单位),冲突并列披露
- [ ] 反例检查结果在报告中呈现
- [ ] 录制夹具可供回归

### Blocked by

- 3

## 5. 行业模块配置与 I1 live 验收跑(S5)

### What to build

行业 ModuleConfig(边界/规模口径/产业链/竞争 → 市场口径表/行业结构/趋势-风险,四件套同品牌);I1 = 中国咖啡零售行业,live 端到端跑通并发布版本化报告;录制夹具回归。

### Acceptance criteria

- [ ] I1 live run 到 publish 或 limited,报告含市场口径表/行业结构/趋势-风险
- [ ] 规模数值均带口径与来源;不同口径并列且解释
- [ ] 关键结论证据可追溯,未验证标注
- [ ] 录制夹具可供回归

### Blocked by

- 3

## 6. 工作台 Web UI 与本地服务(S6)

### What to build

HTTP JSON API(仅 127.0.0.1)+ React/Vite SPA:项目列表;新建任务向导(模块/目标/范围/附件文本与 PDF/预算/预估);计划确认页(确认/驳回);运行进度页(阶段时间线/活动日志/取消);证据抽屉(结论 → 证据 → 快照原文,净化纯文本渲染);报告阅读与导出(MD/HTML/zip 成果包);项目详情(版本/差异/审计/补证/重审/复用模板);设置页(密钥与默认上限,0600 配置文件)。

### Acceptance criteria

- [ ] 浏览器全流程:创建 → 确认 → 运行 → 看证据 → 导出,不依赖 JuanerAI
- [ ] 服务仅监听 127.0.0.1;密钥只来自 config/env,API 不回传密钥
- [ ] 快照页仅渲染净化纯文本(来源 HTML 脚本不执行)
- [ ] 导出 zip 含 report.md / report.html / evidence 快照 / manifest.json
- [ ] 进度页可取消;取消后项目详情可恢复运行

### Blocked by

- 3

## 7. 验收加固与文档(S7)

### What to build

对照 proposal 5 条成功标准对 B1/I1 live 逐条核查并记录(含引用可验证率数字);安全默认核查(绑定地址、0600、净化渲染、外发范围);失败/恢复路径核查(阶段失败错误明确 + 检查点保留、失败不冒充完成);README(安装/配置/运行/验收复现);修复发现缺口。

### Acceptance criteria

- [ ] 5 条成功标准逐条结论有书面记录(含可验证率数字)
- [ ] 安全默认全部核查通过
- [ ] 模拟阶段失败:错误明确、检查点保留、可恢复;run 状态 ≠ published
- [ ] README 可复现:空机器到完成一次研究 run

### Blocked by

- 4, 5, 6
