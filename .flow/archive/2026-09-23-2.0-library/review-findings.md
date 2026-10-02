# REVIEW 双轴审查记录（fixed point = 5cee876）

日期：2026-09-23。Standards 与 Spec 两轴并行子代理审查，未合并排序。

## Standards 轴

硬违规：
1. `testdata/v1-bundle-sample.json` 被 `.gitignore`（`testdata/*.json`）忽略 → 新克隆 `npm test` 必红。【blocking，已修：gitignore 豁免】
2. `AssetDetailView` 用不存在的 `.pre-box` 类 + 12.5px 内联字号，偏离 DESIGN.md（快照原文应 `.snap-text`、正文 13px）。【blocking，已修】
3. README 架构/导出包/CLI 未同步 library 模块与 2.0 成果包。【blocking（文档标准），已修】

判断项（记录不行动）：ingest 登记逻辑三处相似（runResearch/migrate/assetService）；Gather/Publish 绑定列表 JSX 与接口重复；reuseScope 取档逻辑两处；入口未用 zod parse（server 强转）；searchService/migrateLibrary 依赖具体类仅为 dir；`allowed()` 死参数；migrate ID 拼接晦涩；`FETCH_LABEL` 无意义别名；server.ts 路由链继续变长；AssetDetailView 未用 api helper。

## Spec 轴

缺失/部分（blocking，已修）：
1. S-03：模型上下文组装不查 `rights.sendToExternalModel`（死字段）→ runResearch 注入处加门禁，未授权不调外部模型并披露。
2. §5.2/§11.4：check_reuse 无路由、选择器无四组分类、rejected 不回报、PlanView 搜索不传 projectId（S-01 泄露面）→ 加 check 路由、搜索结果带适用性、PlanView 传 projectId 并分组展示、启动回报 rejected。
3. change_reuse_scope 无路由/UI → 加路由 + 详情页动作（带依据）。
4. U2-09 第三档（只有报告→派生成果登记）与 derivedFromRunId 写入路径缺失 → migrateLibrary 增加 report-only 档登记。
5. A-08：origin.obtainedUpstream 死字段 → checkReuse 转引未取上游 → NEEDS_REVIEW。
6. 批量 20 上限未强制；链接无 URL 去重；UI 无幂等键 → 均已补。

实现错误（blocking，已修）：
1. reuse.ts 对无 projectId 的取得记录全放行，违反 G6/S-02 且与检索过滤矛盾 → 收紧为「同项目或 WORKSPACE_REUSABLE」；fetchAssetContent 继承登记上下文的 projectId/rights。
2. 内容去重返回他人 acquisitionId 且不新建取得记录（§8.1/S-02）→ 去重时按上下文新建自己的取得记录。
3. 更正版本无取得记录导致检索消失 + 索引签名不含版本（indexState 谎报）→ 检索权限回落到同源任一版本；索引签名含版本数与最新时间。
4. S-06 重定向/体积未查 → FetchedPage.finalUrl + 取得后复核 + 50MB 体积上限。
5. A-05/A-18 样本边界仅测试手工注入 → checkReuse 对 consumer-profile 服务端生成样本边界提示。

非 blocking：content 路由为属主本地读取（单用户语义，ACCEPTANCE 已声明）；tasks.md 勾选与 ACCEPTANCE 表述已对齐。

---

## REVIEW cycle2（修复后复核）与 cycle2 修复

Standards 轴：第一轮三项硬违规确认已修；无新硬违规。新 smell（判断项，记录）：server /runs 与 /runs/resume 启动块重复；reuseScope 取档逻辑 server/searchService 两处；assetService 空操作分支（已删）；APPLICABILITY 双表（已派生化？保留记录）；AssetDetailView 裸 fetch（保留记录）。

Spec 轴 blocking（cycle2，已修）：
1. SSRF IPv6 绕过：`[::1]`/`[::ffff:127.0.0.1]`/十六进制映射形式未被拒 → assertPublicUrl 增加括号剥离、IPv6 回环/ULA/链路本地/映射(点分+十六进制)判定；测试含 `[::ffff:7f00:1]`。
2. S-03 门禁跨项目串用：rights 判定未限定取得记录上下文 → 限定为本运行项目/属主直录/已显式升档 WORKSPACE_REUSABLE 的取得记录；新增 S-02 串用测试。
3. 选择器四组缺「选择理由/实际版本/标记仅作线索」→ PlanView 已选列表展示 versionId、purpose 可编辑、证据候选↔仅作线索切换。
4. migrateLibrary 头注释陈旧 → 已更新为三档说明。

回归：219 测试绿、typecheck 净、build OK。
