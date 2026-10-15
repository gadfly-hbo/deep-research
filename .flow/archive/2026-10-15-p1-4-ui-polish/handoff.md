# P1-4 交接卡(PlanView 下沉 + formalReady 服务端标记)

## 本批交付

- **切片 A**(42a9f5d):GET `/api/projects/:id` 的 `meta.versions[].formalGenerated` 响应时计算(existsSync 产物文件,不持久化,零迁移);UI 删除逐版本拉整个 formal.json 的探测 effect,formalReady 改由轮询数据派生(只增不减)。列表端点不带该字段。
- **切片 B**(18af90a):`ui/state/planWizard.tsx` 承接计划/框架预览请求编排(入参拼装逐字保留);PlanView 516→472 行,视图内 post/fetch 清零。
- **REVIEW F1 修复**(93cad97):POST formal→true 端到端断言补齐。
- 推送 `cf846d0..19dba8a`(6 commits:归档 P1-3 + 3 代码 + 数据迁移 + 流程工件)。

## 验证状态

- `npm test` 56 文件 344 全绿 + typecheck 0 错误(SHIP 前 fail-closed 重跑过)。
- 浏览器冒烟:真实数据发布页 v2=已生成(HTML/PDF/PPTX)/v1=生成按钮 ✅;向导三步全通(真实 ui-dist + 假适配器 + 真实项目数据副本)。
- **真实用例补验(SHIP 后,用户指路)**:本机 `~/.pi/agent/auth.json` 即含 `xiaomi-token-plan-cn` 密钥(与 minimax 同源)——注入双密钥起真实服务后:curl plan-preview 200/7.6s/6 条真实问题/cost 0.0004;浏览器真实 UI 点「生成研究计划」→ busy 文案实时呈现 → 第二步渲染 9 条真实问题。**真实 LLM + 真实 UI 组合已补齐**,早前"降级披露"作废。附带发现:`scripts/with-minimax-env.sh` 只从 `~/.zcode/v2/config.json` 取 xiaomi 密钥,未覆盖 pi auth.json 来源(本机因此启动即缺密钥)——建议后续小修该脚本。
- **数据迁移披露**:冒烟服务首启真实 research-data 触发 6 项目 P0-2 设计内快照迁移(已提交 9166b34;另一台机器拉取后不会再重复迁移)。

## 遗留(记录不行动,来源 review-findings.md)

1. **F2**:projectDetail.tsx 派生 effect 每轮轮询执行一次(versionsKey dep 冗余 + merge 总返回新对象)——开销有界、无正确性问题;后续批次可做 deps 收敛 + bail-out。
2. **F3**:PlanView 472 行 vs PRD <420 估算(R1-4 复用选择器 ~90 行留驻),已备案。
3. P1-3 handoff 的遗留项继续有效:resume 不传 runId、zod 失败→500、runResearch.ts 为下批候选。

## 下一批前置

- 工作区干净(handoff.md 本机件,随下批归档)。
- ui-dist 需重建才能吃到本批 UI 改动(`npm run build`;启动脚本有 build-head 自动重建,无需手工)。
