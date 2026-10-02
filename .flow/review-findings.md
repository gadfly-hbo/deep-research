# Review Findings — 2.1 增量升级（cycle 1, 2026-10-02）

裁决：**FAIL（REQUEST_CHANGES）** · 审查范围 git diff 041856f -- src/ ui/（19 文件 +1337/-71）· VERIFY 复跑属实（exit 0, 238/238, build OK）

## Blockers（本轮修复）

1. **skip-question 指向后续 open 问题时失效**（runResearch.ts gather 循环无 skipped 检查，:407 无条件覆盖状态；复现：skip(q3) 后 q3 照常搜索且 interventions 谎报 applied）→ 修：循环头跳过 skipped；补行为测试。
2. **增量 URL 去重缺"直接引用旧快照"**（全命中时新问题颗粒无收且无披露；复现实证）→ 修（最小）：全命中问题在 unresolved 披露"答案可能存在于延续信源"；完整挂接待后续迭代（涉及多问题-证据关联模型）。
3. **POST /runs 不校验 incrementalOf 基准**（进行中 run 可作基准启动，得到全量研究但 derivedFromRunId 语义污染）→ 修：start 端点复用 resolveIncrementalBase 校验。

## 顺带修复（低成本 correctness/诚实性）

4. "延续证据采录于…"limitation 无去重（resume N 次重复 N 条）。
5. add-source 快照 id `snap:${url}` 未唯一化，会覆盖项目级快照同 id 旧内容（与 URL 去重的初衷相悖）。
6. server.test "进行中基准被拒" if(stillRunning) 弱断言（可能静默跳过）。
7. stripKeys 两语句挤行（编辑事故）；incrementalNote() 同表达式调用两次。

## Non-blocking（记录不动，后续迭代候选）

- refine-direction 未注入抽取提示（PRD:57 措辞 vs 实现只有搜索 query）。
- as_of "沿用原截止点"选项未实现（UI 固定文案）。
- instruct 对非 gather 阶段回执语义（UI 已挡，API 回执不诚实）。
- plan-preview 超 6 问静默截断无披露；基准 outline 缺失降级无披露字段。
- resume 坏指令静默丢弃无审计；drainFor 与 instruct 写文件的交错窗口。
- **S-03 澄清（UNVERIFIED 项）**：add-source 为用户主动提交材料，语义等同附件路径（attachments 亦不经 S-03——S-03 约束的是情报库复用资产的外发）；PRD"过 S-03 外发门禁"措辞按此解释，实现不改。

## 覆盖确认
审查员复跑了 VERIFY 命令并与记录比对一致；两个独立复现实验（skip 后续问题、增量全命中）；WHITEPAPER §5.4 S-03 定义比对。未覆盖：UI 视觉走查（待用户人工验收）、真机双端同步下 pending 文件行为。

---

# Review Findings — cycle 2（2026-10-02 复审）

裁决：**FAIL**。5/7 修复确认；2 个残余 blocker（均 tsx 实跑复现）：
1. 全命中披露写 state.unresolved，被 publish 主路径（runResearch.ts:1063 questions.filter 重写）冲掉；快捷路径测试绕开了重写。→ 修：披露改推 state.limitations（两路径均存活）。
2. review regather（runResearch.ts:935）无条件 q.status="open"，可复活用户 skipped 问题，干预史与事实相反。→ 修：加 skipped 守卫。
建议项：重复 skip 的 unresolved 无去重；server 测试标题"不触发模型调用"与断言不符；add-source 跨 run URL 复用边界（留后续）。

---

# Review Findings — cycle 3（2026-10-02 终审）

裁决：**PASS（APPROVE）**。两项 cycle-2 修复核验属实（limitations 主路径只追加不重写、regather 守卫+主路径行为测试、发布门禁数据流不受新 limitation 影响）；门禁复跑 exit 0 / 241/241 / build OK。
Non-blocking 建议（记录）：全命中披露补主路径断言（当前靠结构保证）；regather 拦截时可补评审关切披露。
